/**
 * The Watchlist and Market Heatmap desk.
 *
 * Both halves are drawn from ONE request — the exchange's 24-hour ticker
 * snapshot for every symbol at once — which is why they live on the same desk.
 * Fetching a watchlist row-by-row would be a request per symbol for data that
 * arrives in a single response, and it would put every row on a slightly
 * different clock.
 *
 * WHAT THE NUMBERS ARE, EXACTLY
 * Last price and 24-hour change, as the venue reported them at the moment shown
 * in the footer. They are a SNAPSHOT, not a stream: the desk does not pretend
 * to tick, and the as-of time is on screen so a stale panel looks stale rather
 * than looking calm. Nothing here is interpolated between refreshes.
 *
 * WHY THE HEATMAP ONLY SHOWS DOLLAR-QUOTED PAIRS BY DEFAULT
 * `catalogue.ts` records the measurement: ranking by reported quote volume put
 * USDTIDRT and BTCBIDR at the top of the entire exchange, because that figure
 * is denominated in the quote asset and one rupiah is about 1/16,000 of a
 * dollar. The number was not wrong; comparing it across currencies was. Without
 * a live FX table there is no honest conversion, so the heatmap ranks within
 * one quote currency and says which one.
 */

import { h } from "./dom";
import { symbolField, symbolOptions } from "./cards/symbolfield";
import { pkWhy } from "./panelkit";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import { loadBinanceUniverse } from "../data/binance";
import type { UniverseEntry } from "../scan/scanner";

export interface WatchlistOptions {
  readonly symbol: Signal<string>;
  readonly kv: KV;
  /** Switch the chart to a symbol. */
  readonly open: (symbol: string) => void;
  /**
   * Attach a right-click menu to the rows, once the panel exists.
   *
   * A callback rather than a menu definition: the useful actions on a row are
   * about alerts, panes and the screener, and this module has no business
   * knowing any of them. It supplies the rows; the shell supplies the verbs.
   */
  readonly onRowsReady?: (rowHost: HTMLElement) => void;
}

/** How many tiles the heatmap draws, ranked by volume within the quote. */
const HEAT_TILES = 60;

/** Quote currencies the heatmap can rank inside. */
const QUOTES = ["USDT", "USDC", "BTC", "ETH"] as const;

const DEFAULT_LIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

interface Saved {
  list: string[];
  quote: string;
}

/**
 * The symbols on the watchlist, for readers outside this desk.
 *
 * The library enrols what you watch — a market you are watching is one you will
 * want history for — and that needs the list without constructing the desk,
 * which is lazy and may never be opened. A function rather than an exported
 * SLOT so this file keeps owning the shape; a second reader of the raw slot
 * would be a second definition of what a watchlist is.
 */
export function watchedSymbols(kv: { read(slot: typeof SLOT): { value: Saved } }): string[] {
  return [...kv.read(SLOT).value.list];
}

const SLOT = {
  key: "watchlist.v1",
  version: 1,
  fallback: (): Saved => ({ list: [...DEFAULT_LIST], quote: "USDT" }),
  validate: (v: unknown): Saved | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const list = Array.isArray(o["list"]) ? o["list"].filter((x): x is string => typeof x === "string") : null;
    if (!list) return null;
    const quote = typeof o["quote"] === "string" ? o["quote"] : "USDT";
    return { list, quote };
  },
};

export const money = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  /* Crypto spans eight orders of magnitude. A fixed precision either shows
     SHIB as 0.00 or BTC as 68420.00000000; significant digits fit both. */
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const signed = (n: number): string => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—");

const compactVol = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

export function createWatchlist(opts: WatchlistOptions) {
  const stored = opts.kv.read(SLOT).value;

  const list = signal<string[]>(stored.list);
  const quote = signal<string>(stored.quote);
  const universe = signal<readonly UniverseEntry[]>([]);
  const asOf = signal(0);
  const loading = signal(false);
  const error = signal("");
  const draft = signal("");

  const persist = (): void => {
    opts.kv.write(SLOT, { list: list(), quote: quote() });
  };

  const bySymbol = computed<ReadonlyMap<string, UniverseEntry>>(
    () => new Map(universe().map((u) => [u.symbol, u])),
  );

  const refresh = async (): Promise<void> => {
    if (loading()) return;
    loading.set(true);
    error.set("");
    try {
      const rows = await loadBinanceUniverse();
      universe.set(rows);
      asOf.set(Date.now());
    } catch (err) {
      /* The previous snapshot is KEPT and its as-of time keeps ageing on
         screen. Blanking the desk on a failed refresh throws away the last
         thing that was true; leaving it with a visibly old timestamp does not. */
      error.set(err instanceof Error ? err.message : String(err));
    } finally {
      loading.set(false);
    }
  };

  void refresh();

  const add = (raw: string): void => {
    const sym = raw.trim().toUpperCase();
    if (sym === "") return;
    if (list().includes(sym)) {
      error.set(`${sym} is already on the list.`);
      return;
    }
    list.set([...list(), sym]);
    draft.set("");
    error.set("");
    persist();
  };

  const remove = (sym: string): void => {
    list.set(list().filter((s) => s !== sym));
    persist();
  };

  const move = (sym: string, delta: number): void => {
    const cur = list();
    const i = cur.indexOf(sym);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.length) return;
    const next = [...cur];
    next[i] = cur[j] as string;
    next[j] = sym;
    list.set(next);
    persist();
  };

  const renderList = (cls: string, rows: () => HTMLElement[]) =>
    h("div", {
      class: cls,
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const r of rows()) el.appendChild(r);
        }),
    });

  // ---------------------------------------------------------- watchlist ---

  const watchRows = (): HTMLElement[] => {
    const map = bySymbol();
    const known = universe().length > 0;
    return list().map((sym) => {
      const u = map.get(sym);
      const missing = known && !u;
      return h(
        "div",
        {
          class: "wl-row",
          /* Read by the context menu, which resolves the row from the event
             target rather than binding a handler to every cell. */
          "data-symbol": sym,
          "data-current": String(sym === opts.symbol()),
          "data-tone": u ? (u.changePct >= 0 ? "pos" : "neg") : "",
        },
        h("button", {
          class: "wl-sym",
          type: "button",
          text: sym,
          title: "Open on the chart",
          onclick: () => opts.open(sym),
        }),
        h("span", { class: "wl-px num", text: u ? money(u.lastPrice) : missing ? "not listed" : "—" }),
        h("span", { class: "wl-chg num", text: u ? signed(u.changePct) : "—" }),
        h("span", { class: "wl-vol num", text: u ? compactVol(u.quoteVolume) : "—" }),
        h(
          "span",
          { class: "wl-tools" },
          h("button", { class: "ghost-btn tiny", type: "button", text: "↑", title: "Move up", onclick: () => move(sym, -1) }),
          h("button", { class: "ghost-btn tiny", type: "button", text: "↓", title: "Move down", onclick: () => move(sym, 1) }),
          h("button", { class: "ghost-btn tiny", type: "button", text: "✕", title: "Remove", onclick: () => remove(sym) }),
        ),
      );
    });
  };

  const watchPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Watchlist" }),
    h(
      "div",
      { class: "wl-add" },
      symbolField({
        value: () => draft(),
        options: () => symbolOptions([]),
        className: "field-input",
        placeholder: "Add a symbol, e.g. ADAUSDT",
        ariaLabel: "Add a symbol to the watchlist",
        /* Its own Add button reads `draft`, so the draft tracks the box. */
        onInput: (raw) => draft.set(raw),
        /* And the picker's commit — Enter or a row click — adds directly. */
        onChange: (sym) => {
          draft.set(sym);
          add(sym);
        },
      }),
      h("button", { class: "ghost-btn", type: "button", text: "Add", onclick: () => add(draft()) }),
    ),
    h(
      "div",
      { class: "wl-head" },
      h("span", { text: "Symbol" }),
      h("span", { class: "num", text: "Last" }),
      h("span", { class: "num", text: "24h" }),
      h("span", { class: "num", text: "Volume" }),
      h("span", { text: "" }),
    ),
    h("div", {
      class: "wl-rows",
      /* One listener on the container, not one per row: the rows are rebuilt
         on every tick, and per-row handlers would be re-attached every time. */
      ref: (el: HTMLElement) => {
        renderEffect(() => {
          el.textContent = "";
          for (const r of watchRows()) el.appendChild(r);
        });
        opts.onRowsReady?.(el);
      },
    }),
    h("p", {
      class: "wl-empty",
      "data-on": () => String(list().length === 0),
      text: "Nothing on the list. Add a symbol above.",
    }),
    pkWhy(
      "Volume is the 24-hour figure in the QUOTE asset, so it is only comparable between pairs quoted in the same thing.",
      "About the volume column",
    ),
  );

  // ------------------------------------------------------------ heatmap ---

  const heatRows = computed<readonly UniverseEntry[]>(() => {
    const q = quote();
    return universe()
      .filter((u) => u.symbol.endsWith(q) && Number.isFinite(u.changePct))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, HEAT_TILES);
  });

  /**
   * The change that saturates a tile.
   *
   * Taken from the data rather than fixed: on a quiet day a fixed ±10% scale
   * renders every tile the same near-grey and the map says nothing, and on a
   * violent day it clips everything to full colour and the map also says
   * nothing. The 90th percentile of the absolute moves keeps the extremes
   * visible without letting one outlier flatten the rest.
   */
  const scale = computed<number>(() => {
    const moves = heatRows().map((u) => Math.abs(u.changePct)).sort((a, b) => a - b);
    if (moves.length === 0) return 1;
    const p90 = moves[Math.min(moves.length - 1, Math.floor(moves.length * 0.9))] as number;
    return Math.max(0.5, p90);
  });

  const heatTiles = (): HTMLElement[] => {
    const s = scale();
    return heatRows().map((u) => {
      const mag = Math.min(1, Math.abs(u.changePct) / s);
      return h(
        "button",
        {
          class: "hm-tile",
          type: "button",
          "data-tone": u.changePct >= 0 ? "pos" : "neg",
          style: `--mag:${mag.toFixed(3)}`,
          title: `${u.symbol} — ${signed(u.changePct)} over 24h, volume ${compactVol(u.quoteVolume)} ${quote()}`,
          onclick: () => opts.open(u.symbol),
        },
        h("span", { class: "hm-sym", text: u.symbol.slice(0, u.symbol.length - quote().length) }),
        h("span", { class: "hm-chg num", text: signed(u.changePct) }),
      );
    });
  };

  const heatPanel = h(
    "section",
    { class: "dd-panel" },
    h(
      "div",
      { class: "hm-head" },
      h("h3", { class: "pf-sub", text: "Market heatmap" }),
      h(
        "select",
        {
          class: "field-input hm-quote",
          value: () => quote(),
          onchange: (e: Event) => {
            quote.set((e.target as HTMLSelectElement).value);
            persist();
          },
        },
        ...QUOTES.map((q) => h("option", { value: q, text: `vs ${q}` })),
      ),
    ),
    pkWhy(
      () =>
        `The ${HEAT_TILES} most-traded ${quote()} pairs by 24-hour volume. Colour is the 24-hour change, saturating at ${scale().toFixed(1)}% — the 90th percentile of today's moves, so the scale follows the day rather than a fixed number that is wrong on both quiet and violent ones.`,
      "How the colour is scaled",
    ),
    renderList("hm-grid", heatTiles),
    h("p", {
      class: "wl-empty",
      "data-on": () => String(heatRows().length === 0),
      text: () => (loading() ? "Loading the exchange snapshot…" : "No pairs for this quote in the snapshot."),
    }),
  );

  const el = h(
    "div",
    { class: "dd wl-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Watchlist" }),
      h("p", {
        class: "view-sub",
        text: "Your list and the wider market, both from one exchange snapshot. A snapshot, not a stream — the time it was taken is at the bottom.",
      }),
    ),
    h(
      "div",
      { class: "wl-bar" },
      h("button", {
        class: "ghost-btn",
        type: "button",
        disabled: () => loading(),
        text: () => (loading() ? "Refreshing…" : "Refresh"),
        onclick: () => void refresh(),
      }),
      h("span", {
        class: "wl-asof",
        text: () =>
          asOf() === 0
            ? "Never loaded."
            : `${universe().length} symbols, as of ${new Date(asOf()).toLocaleTimeString()}`,
      }),
      h("span", { class: "wl-error", "data-on": () => String(error() !== ""), text: () => error() }),
    ),
    watchPanel,
    heatPanel,
  );

  /**
   * Add several at once, from the screener's bulk bar.
   *
   * Silent on duplicates rather than raising the "already on the list" error
   * the single-add path uses: adding six rows of which two are already there is
   * a success, not four successes and two failures.
   */
  const addMany = (symbols: readonly string[]): number => {
    const have = new Set(list());
    const fresh = symbols
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== "" && !have.has(s));
    if (fresh.length === 0) return 0;
    list.set([...list(), ...fresh]);
    persist();
    return fresh.length;
  };

  return { el, list, refresh, addMany };
}
