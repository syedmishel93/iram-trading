/**
 * Watchlist — the operator's list, as a small card in the inspector.
 *
 * ONE LIST
 * The symbols are the watchlist desk's own persisted list, passed in as a
 * signal (in the shell: `watchlist().list`) — the same signal the left rail
 * reads. This card never keeps a copy, so it cannot disagree with the desk.
 *
 * PRICES
 * The same 24h Binance snapshot the rail and the desk read: one request for
 * every ticker, worded by the rail's own `rowQuote` / `changeText` / `money`,
 * so a row here and a row in the rail cannot say different things about one
 * price. Pass `quotes` to share a snapshot someone else already owns; without
 * it the card keeps its own, refreshed on the rail's cadence, and only while
 * the card is on screen and the tab is visible.
 *
 * REFUSALS
 * - A quote not yet loaded is "—", never 0.
 * - A symbol Binance cannot price is "—" with the reason in the tooltip.
 * - A failed refresh keeps the last snapshot and says so under the list.
 *
 * The title ("Watchlist") belongs to the dock's card head, not here.
 */

import { renderEffect, signal, type ReadSignal } from "../../core/signal";
import { loadBinanceUniverse } from "../../data/binance";
import type { UniverseEntry } from "../../scan/scanner";
import { clear, h } from "../dom";
import { money } from "../watchlist";
import { RAIL_REFRESH_MS, changeText, quoteFailure, rowQuote, type QuoteSnapshot } from "../watchrail";
import { isShown, onShown } from "./shown";

/** Rows shown before the card points at the desk for the rest. */
export const WATCH_CARD_ROWS = 8;

export interface WatchCardDeps {
  /** The chart's current symbol. */
  readonly current: () => string;
  readonly onSelect: (sym: string) => void;
  readonly onOpenDesk: () => void;
  /** The persisted list. In the shell: `watchlist().list`. */
  readonly symbols: ReadSignal<readonly string[]>;
  /** A snapshot owned elsewhere. When given, the card fetches nothing itself. */
  readonly quotes?: ReadSignal<QuoteSnapshot>;
  /** 24h tickers for every symbol. Default: `loadBinanceUniverse`, as the rail. */
  readonly loadQuotes?: (signal: AbortSignal) => Promise<readonly UniverseEntry[]>;
  /** Default: the rail's cadence, `RAIL_REFRESH_MS`. */
  readonly refreshMs?: number;
}

/** What a row prints for its price and change. "—" for anything not a quote. */
export function watchRowText(
  sym: string,
  snap: QuoteSnapshot,
  now: number,
): { px: string; chg: string; tone: "pos" | "neg" | "flat" | ""; note: string } {
  const q = rowQuote(sym, snap, now);
  if (q.kind === "quote") {
    const c = changeText(q.entry.changePct);
    return { px: money(q.entry.lastPrice), chg: c.text, tone: c.tone, note: q.stale };
  }
  return {
    px: "—",
    chg: "—",
    tone: "",
    note: q.kind === "loading" ? "Price not loaded yet." : q.reason,
  };
}

export function createWatchCard(deps: WatchCardDeps): HTMLElement {
  const own = signal<QuoteSnapshot>({ rows: null, at: 0, loading: false, error: "" });
  const snap: ReadSignal<QuoteSnapshot> = deps.quotes ?? own;

  const body = h("div", { class: "wc-body" });
  const el = h("div", { class: "wc-card" }, body);

  if (!deps.quotes) {
    const load = deps.loadQuotes ?? ((sig: AbortSignal) => loadBinanceUniverse(sig));
    const every = deps.refreshMs ?? RAIL_REFRESH_MS;
    const abort = new AbortController();
    const refresh = async (): Promise<void> => {
      if (own.peek().loading) return;
      own.set({ ...own.peek(), loading: true });
      try {
        const rows = await load(abort.signal);
        own.set({ rows: new Map(rows.map((r) => [r.symbol, r])), at: Date.now(), loading: false, error: "" });
      } catch (err) {
        console.warn("[watchcard] quote snapshot failed", err);
        own.set({ ...own.peek(), loading: false, error: quoteFailure(err) });
      }
    };
    /* Drawn (`./shown.ts`) AND the tab visible: this one calls Binance, a
       third party with a request weight, so a background tab does not ask. */
    const onScreen = (): boolean =>
      isShown(el) && (typeof document === "undefined" || document.visibilityState !== "hidden");
    onShown(el, () => void refresh());
    setInterval(() => {
      if (onScreen()) void refresh();
    }, every);
    void refresh();
  }

  let lastKey = "";
  renderEffect(() => {
    const syms = [...new Set(deps.symbols())];
    const cur = deps.current();
    const sn = snap();
    const now = Date.now();
    const shown = syms.slice(0, WATCH_CARD_ROWS);
    const rows = shown.map((sym) => ({ sym, ...watchRowText(sym, sn, now) }));
    const key = JSON.stringify([cur, syms.length, sn.error, sn.at, rows]);
    if (key === lastKey) return;
    lastKey = key;
    clear(body);

    if (syms.length === 0) {
      el.dataset["state"] = "empty";
      body.appendChild(h("p", { class: "wc-empty", text: "No symbols on your watchlist yet." }));
      body.appendChild(
        h("button", { class: "ghost-btn wc-open", type: "button", text: "Open the watchlist", onclick: () => deps.onOpenDesk() }),
      );
      return;
    }
    el.dataset["state"] = "list";

    body.appendChild(
      h(
        "div",
        { class: "wc-list" },
        ...rows.map((r) =>
          h(
            "button",
            {
              class: "wc-row",
              type: "button",
              "data-symbol": r.sym,
              "data-active": String(r.sym === cur),
              "data-tone": r.tone,
              ...(r.sym === cur ? { "aria-current": "true" } : {}),
              title: r.note === "" ? `Open ${r.sym} on the chart` : `Open ${r.sym} on the chart\n${r.note}`,
              onclick: () => deps.onSelect(r.sym),
            },
            h("span", { class: "wc-sym", text: r.sym }),
            h("span", { class: "wc-px num", text: r.px }),
            h("span", { class: "wc-chg num", text: r.chg }),
          ),
        ),
      ),
    );

    if (sn.rows !== null && sn.error !== "") {
      body.appendChild(h("p", { class: "wc-warn", text: `Last refresh failed; showing an older snapshot. ${sn.error}` }));
    } else if (sn.rows === null && sn.error !== "") {
      body.appendChild(h("p", { class: "wc-warn", text: sn.error }));
    }

    const foot = h("div", { class: "wc-foot" });
    foot.appendChild(
      h("span", {
        class: "wc-asof",
        text: sn.at > 0 ? `24h change · Binance, ${new Date(sn.at).toLocaleTimeString()}` : "24h change · Binance",
      }),
    );
    if (syms.length > shown.length) {
      foot.appendChild(
        h("button", {
          class: "wc-more",
          type: "button",
          text: `All ${syms.length}`,
          title: `${syms.length - shown.length} more on the Watchlist desk`,
          onclick: () => deps.onOpenDesk(),
        }),
      );
    }
    body.appendChild(foot);
  });

  return el;
}
