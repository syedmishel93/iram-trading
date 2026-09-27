/**
 * Flow desk — derivatives positioning and live liquidations.
 *
 * The data an on-chain/derivatives dashboard shows, pulled straight from the
 * exchange rather than scraped from a third party's rendering of it. See the
 * header of `data/derivs.ts` for why that is the design and not a compromise.
 */

import { signal, effect, renderEffect, type Signal } from "../core/signal";
import { h, clear } from "./dom";
import {
  loadFunding,
  loadOpenInterest,
  loadLongShort,
  loadTakerFlow,
  readDerivatives,
  fmtUsd,
  type DerivRead,
  type FundingPoint,
  type OpenInterestPoint,
  loadSpotPerp,
  type SpotPerp,
} from "../data/derivs";
import {
  basis,
  oiState,
  fundingDivergence,
  liquidationClusters,
  fmtCompact,
} from "../data/flowmetrics";
import {
  createStream,
  parseLiquidation,
  liquidatedSide,
  LIQUIDATION_STREAM,
  type Liquidation,
  type StreamStatus,
} from "../data/stream";

export interface FlowHandle {
  el: HTMLElement;
  /** Called when the desk becomes visible. Loads if the data is stale. */
  activate(): void;
  cancel(): void;
}

/** Liquidations below this notional are noise on a global feed. */
const MIN_LIQ_USD = 10_000;
const MAX_ROWS = 60;

export function createFlow(opts: { symbol: Signal<string> }): FlowHandle {
  const read = signal<DerivRead>({ signals: [], insufficient: null });
  const loading = signal(false);
  const error = signal<string | null>(null);
  const fundingHist = signal<FundingPoint[]>([]);
  const oiHist = signal<OpenInterestPoint[]>([]);
  const liquidations = signal<Liquidation[]>([]);
  const liqStatus = signal<StreamStatus>("idle");
  const onlySymbol = signal(true);
  const spotPerp = signal<SpotPerp | null>(null);

  /**
   * Whether this instrument has a listed perpetual at all.
   *
   * THE BUG THIS EXISTS TO FIX. Every empty state on this desk was written for
   * a symbol that HAS a perp and simply has not printed yet. On XAUUSD — a
   * broker CFD with no perpetual listed anywhere — the desk read:
   *
   *   XAUUSD · perpetual futures                    (it is not one)
   *   no XAUUSD shelf has formed yet                (none ever will)
   *   no XAUUSD liquidations yet — the tape is
   *   live and quiet                                (it is live and irrelevant)
   *
   * Three sentences telling the operator to keep waiting for data that cannot
   * arrive. "Nothing yet" and "not applicable" are different answers and the
   * desk was giving the first for both.
   *
   * Derived from what the venue actually returned rather than from a symbol
   * pattern: a hard-coded list of which tickers have perps would be wrong the
   * week a new one lists. Null while the first fetch is still in flight, so the
   * copy can say "checking" instead of guessing either way.
   */
  const hasPerp = (): boolean | null => {
    if (loading()) return null;
    if (spotPerp() !== null) return true;
    /* `insufficient` is the venue's own answer to "is there anything here",
       and it is set only after a completed fetch. */
    return read().insufficient === null ? null : false;
  };
  const priceChange = signal(0);

  let controller: AbortController | null = null;
  /**
   * The symbol whose data is currently loaded, or null when nothing is.
   *
   * The desk is built once at mount but is not visible then, and the shell
   * cancels every hidden view — so an eager load at construction is aborted a
   * microtask later and never retried. Loading is therefore driven by
   * `activate()`, and this field is what makes it idempotent.
   */
  let loadedFor: string | null = null;

  async function load(): Promise<void> {
    controller?.abort();
    const ctl = new AbortController();
    controller = ctl;

    loading.set(true);
    error.set(null);
    const symbol = opts.symbol();
    loadedFor = symbol;

    try {
      // Four independent requests: one slow endpoint should not delay the rest,
      // and one FAILING endpoint must not blank the other three.
      const [funding, openInterest, longShort, takerFlow, quote] = await Promise.all([
        loadFunding(symbol, 60, ctl.signal).catch(() => []),
        loadOpenInterest(symbol, "1h", 60, ctl.signal).catch(() => []),
        loadLongShort(symbol, "1h", 60, ctl.signal).catch(() => []),
        loadTakerFlow(symbol, "1h", 60, ctl.signal).catch(() => []),
        loadSpotPerp(symbol, ctl.signal).catch(() => null),
      ]);
      if (ctl.signal.aborted) return;

      const firstOi = openInterest[0];
      const lastOi = openInterest[openInterest.length - 1];
      const priceChangePct =
        firstOi && lastOi && firstOi.value > 0
          ? ((lastOi.value - firstOi.value) / firstOi.value) * 100
          : 0;

      fundingHist.set(funding);
      oiHist.set(openInterest);
      spotPerp.set(quote);
      priceChange.set(priceChangePct);
      read.set(readDerivatives({ funding, openInterest, longShort, takerFlow, priceChangePct }));
    } catch (err) {
      if (ctl.signal.aborted) return;
      loadedFor = null;
      error.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (controller === ctl) {
        loading.set(false);
        controller = null;
      }
    }
  }

  // --- live liquidation tape ------------------------------------------------
  const liqStream = createStream<Liquidation>(
    {
      onData: (liq) => {
        if (liq.value < MIN_LIQ_USD) return;
        liquidations.update((list) => [liq, ...list].slice(0, MAX_ROWS));
      },
    },
    {
      parse: parseLiquidation,
      // Liquidations are EVENTS, not a tick. A calm market produces none for
      // minutes at a time — verified live: 52 seconds of silence across every
      // market on a healthy socket. A watchdog here would reconnect over and
      // over on a feed that is working perfectly.
      silenceMs: 0,
    },
  );

  effect(() => {
    liqStatus.set(liqStream.status());
  });

  // --- rendering ------------------------------------------------------------

  const signalList = h("div", { class: "flow-signals" });

  renderEffect(() => {
    const r = read();
    clear(signalList);
    if (r.insufficient) {
      signalList.appendChild(h("p", { class: "flow-empty-note", text: r.insufficient }));
      return;
    }
    for (const s of r.signals) {
      signalList.appendChild(
        h(
          "div",
          { class: "flow-card", "data-dir": s.direction },
          h(
            "div",
            { class: "flow-card-head" },
            h("span", { class: "flow-card-name", text: s.name }),
            h("span", { class: "flow-card-value num", text: s.value }),
          ),
          h("p", { class: "flow-card-reason", text: s.reason }),
        ),
      );
    }
  });

  /**
   * The derived reads: basis, who-is-buying, and funding-vs-price.
   *
   * These are the numbers no charting platform shows, and each is only useful
   * with its reasoning attached — "OI +4%" is a fact, "the rally is shorts
   * closing, and that flow runs out on its own" is a read.
   */
  const derivedList = h("div", { class: "flow-signals" });

  renderEffect(() => {
    const quote = spotPerp();
    const oi = oiHist();
    const fund = fundingHist();
    const change = priceChange();
    clear(derivedList);

    const cards: { name: string; value: string; dir: string; reason: string }[] = [];

    const b = quote ? basis(quote.spot, quote.mark) : null;
    if (b) {
      cards.push({
        name: "Spot–perp basis",
        value: `${b.bp >= 0 ? "+" : ""}${b.bp.toFixed(1)}bp`,
        dir: b.direction,
        reason: b.reason,
      });
    }

    const o = oiState(oi, change);
    if (o) {
      cards.push({
        name: o.label,
        value: `OI ${o.oiChangePct >= 0 ? "+" : ""}${o.oiChangePct.toFixed(2)}%`,
        dir: o.direction,
        reason: o.reason,
      });
    }

    const d = fundingDivergence(fund, change);
    if (d && d.present) {
      cards.push({
        name: "Funding divergence",
        value: `${(d.fundingChange * 100).toFixed(4)}%`,
        dir: d.direction,
        reason: d.reason,
      });
    }

    if (cards.length === 0) {
      derivedList.appendChild(
        h("p", {
          class: "flow-empty-note",
          text: quote
            ? "not enough history yet to derive a positioning read"
            : hasPerp() === false
              ? `${opts.symbol()} has no listed perpetual, so there is no basis, open interest or funding to read. Nothing here is missing.`
              : "no spot/perp quote for this symbol — basis and the open-interest read need a listed perpetual",
        }),
      );
      return;
    }

    for (const c of cards) {
      derivedList.appendChild(
        h(
          "div",
          { class: "flow-card", "data-dir": c.dir },
          h(
            "div",
            { class: "flow-card-head" },
            h("span", { class: "flow-card-name", text: c.name }),
            h("span", { class: "flow-card-value num", text: c.value }),
          ),
          h("p", { class: "flow-card-reason", text: c.reason }),
        ),
      );
    }
  });

  /**
   * Liquidation shelves.
   *
   * A scrolling tape tells you someone was liquidated. It does not tell you
   * that eleven million dollars died in a forty-dollar band — which is the
   * only part that becomes a level you can trade against.
   */
  const clusterList = h("div", { class: "liq-clusters" });

  renderEffect(() => {
    const sym = opts.symbol();
    const rows = liquidations().filter((l) => l.symbol === sym);
    const clusters = liquidationClusters(rows);
    clear(clusterList);

    if (clusters.length === 0) {
      clusterList.appendChild(
        h("p", {
          class: "flow-empty-note",
          text:
            hasPerp() === false
              ? `${sym} has no listed perpetual, so there are no liquidations to cluster. This is not a wait.`
              : `no ${sym} shelf has formed yet — clusters need several prints in one price band`,
        }),
      );
      return;
    }

    for (const c of clusters) {
      clusterList.appendChild(
        h(
          "div",
          { class: "liq-cluster", "data-side": c.side },
          h("div", {
            class: "liq-cluster-bar",
            style: `width:${(c.weight * 100).toFixed(1)}%`,
          }),
          h("span", { class: "liq-cluster-px num", text: c.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) }),
          h("span", {
            class: "liq-cluster-side",
            text: c.side === "both" ? "mixed" : `${c.side}s`,
          }),
          h("span", { class: "liq-cluster-val num", text: fmtCompact(c.value) }),
          h("span", { class: "liq-cluster-n num", text: `${c.count}` }),
        ),
      );
    }
  });

  const liqList = h("div", { class: "liq-body" });

  renderEffect(() => {
    const rows = liquidations();
    const sym = opts.symbol();
    const filtered = onlySymbol() ? rows.filter((l) => l.symbol === sym) : rows;
    clear(liqList);

    if (filtered.length === 0) {
      liqList.appendChild(
        h("p", {
          class: "flow-empty-note",
          text:
            onlySymbol() && hasPerp() === false
              ? `${sym} has no listed perpetual. The tape is live and carrying other symbols — turn off "this symbol" to see them.`
              : liqStatus() === "open"
                ? onlySymbol()
                  ? `no ${sym} liquidations over ${fmtUsd(MIN_LIQ_USD)} yet — the tape is live and quiet`
                  : `no liquidations over ${fmtUsd(MIN_LIQ_USD)} yet — the tape is live and quiet`
                : "connecting to the liquidation feed…",
        }),
      );
      return;
    }

    for (const l of filtered) {
      // Label the POSITION that was wiped out, not the order side — the
      // exchange reports a forced SELL when a LONG is closed.
      const wiped = liquidatedSide(l.side);
      liqList.appendChild(
        h(
          "div",
          { class: "liq-row", "data-side": wiped },
          h("span", { class: "liq-time num", text: new Date(l.time).toLocaleTimeString() }),
          h("span", { class: "liq-sym", text: l.symbol }),
          h("span", { class: "liq-side", text: `${wiped} liquidated` }),
          h("span", { class: "liq-px num", text: l.price.toLocaleString() }),
          h("span", { class: "liq-val num", text: fmtUsd(l.value) }),
        ),
      );
    }
  });

  const el = h(
    "section",
    { class: "flow" },

    h(
      "header",
      { class: "flow-head" },
      h("h2", { class: "flow-title", text: "Flow" }),
      h("span", {
        class: "flow-sub",
        /* Describes what is being LOOKED FOR, not what the symbol is. */
        text: () => {
          const perp = hasPerp();
          if (perp === false) return `${opts.symbol()} · no perpetual listed`;
          return `${opts.symbol()} · perpetual futures`;
        },
      }),
      h("div", { style: "flex:1" }),
      h("span", {
        class: "flow-status",
        text: () => (loading() ? "loading…" : error() ? `failed: ${error()}` : ""),
      }),
      h("button", { class: "ghost-btn", text: "Refresh", onclick: () => void load() }),
    ),

    h("p", {
      class: "flow-source",
      text: "Live from the exchange's public futures endpoints — no API key, no third-party scraping.",
    }),

    signalList,

    h(
      "section",
      { class: "liq" },
      h(
        "header",
        { class: "liq-head" },
        h("span", { class: "label", text: "Positioning" }),
        h("span", { class: "flow-sub", text: "derived — basis, open interest, funding" }),
      ),
      derivedList,
    ),

    h(
      "section",
      { class: "liq" },
      h(
        "header",
        { class: "liq-head" },
        h("span", { class: "label", text: "Liquidation shelves" }),
        h("span", { class: "flow-sub", text: () => `${opts.symbol()} · from the live tape` }),
      ),
      clusterList,
    ),

    h(
      "section",
      { class: "liq" },
      h(
        "header",
        { class: "liq-head" },
        h("span", { class: "label", text: "Liquidations" }),
        h("span", {
          class: "liq-dot",
          "data-stream": () => liqStatus(),
          title: () => `feed ${liqStatus()}`,
        }),
        h("span", { class: "flow-sub", text: () => `over ${fmtUsd(MIN_LIQ_USD)}` }),
        h("div", { style: "flex:1" }),
        h("button", {
          class: "seg-btn",
          text: () => (onlySymbol() ? "this symbol" : "all markets"),
          "aria-pressed": () => String(onlySymbol()),
          onclick: () => onlySymbol.update((v) => !v),
        }),
      ),
      liqList,
    ),

    h("p", {
      class: "flow-disclaimer",
      text: "Decision support only. Positioning data describes what the crowd has done, not what price will do next.",
    }),
  );

  // A symbol change invalidates the loaded data. It does NOT trigger a fetch:
  // re-requesting four endpoints for a desk nobody is looking at wastes rate
  // limit the chart needs. The next activate() picks it up.
  effect(() => {
    const symbol = opts.symbol();
    if (loadedFor !== null && loadedFor !== symbol) {
      loadedFor = null;
      read.set({ signals: [], insufficient: null });
    }
  });

  // The liquidation tape is all-market and runs continuously, so the history is
  // already there when the desk is opened rather than starting from empty.
  liqStream.connect(LIQUIDATION_STREAM);

  return {
    el,

    activate() {
      if (loadedFor === opts.symbol() || loading.peek()) return;
      void load();
    },

    cancel() {
      controller?.abort();
      controller = null;
      loading.set(false);
    },
  };
}
