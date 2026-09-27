/**
 * The watchlist rail: the operator's list beside the chart, one click to switch.
 *
 * SAME LIST, SAME SNAPSHOT AS THE WATCHLIST DESK
 * The symbols come in as a signal - in the shell that is `createWatchlist().list`,
 * the one persisted list - so the rail cannot drift from the desk the way a
 * second copy would. Prices come from the same loader the desk uses,
 * `loadBinanceUniverse`: one request for every 24h ticker at once, so every row
 * is on the same clock and a ten-symbol list costs one call, not ten.
 *
 * WHAT IS ON A ROW, EXACTLY
 * Last price and 24h change as Binance reported them at the snapshot time (in
 * the header's tooltip). A snapshot, not a stream. The sparkline is the last 24
 * CLOSED hourly bars from `loadBinanceBars`, whose cache holds a response until
 * the forming bar closes - so the line can trail the price by up to an hour and
 * its tooltip says so. It is never extended with the snapshot price: that would
 * join two sources into one line with nothing on screen marking the seam.
 *
 * REFUSALS
 * - loading: no snapshot yet, the row says so rather than showing a dash.
 * - failed: no snapshot and the last attempt failed; the reason is the tooltip.
 * - no quote: the snapshot loaded and has no such symbol (a stock, an index,
 *   a delisted pair). Binance cannot price it, and the row says that.
 * - a failed REFRESH keeps the previous snapshot on screen, marked stale, with
 *   the age and the reason in the tooltip.
 * - no sparkline data: the space stays empty. A line is never synthesised.
 *
 * DISPOSAL
 * `h()` binds reactive props with un-owned render effects, which nothing can
 * dispose. The rail therefore builds static nodes and updates them from ONE
 * render effect it owns, so `destroy()` really does stop everything.
 */

import { h } from "./dom";
import { money, signed } from "./watchlist";
import { effect, renderEffect, signal, untrack, type ReadSignal } from "../core/signal";
import { loadBinanceBars, loadBinanceUniverse } from "../data/binance";
import { RateLimited, type UniverseEntry } from "../scan/scanner";

// ------------------------------------------------------------------ types ---

export interface WatchSetup {
  /** One line, already worded: "Long · armed", "No setup". */
  readonly label: string;
  readonly direction: "long" | "short";
  /** Whether this setup is live now; only live ones are counted in the header. */
  readonly live: boolean;
}

export interface WatchRailOptions {
  /** The persisted list. In the shell: `createWatchlist(...).list`. */
  readonly symbols: ReadSignal<readonly string[]>;
  /** The chart's current symbol. */
  readonly active: ReadSignal<string>;
  /** Switch the chart. */
  onPick(sym: string): void;
  /** Setup state per symbol. A symbol missing from the map shows no setup line. */
  readonly setups?: ReadSignal<ReadonlyMap<string, WatchSetup>>;
  /** 24h ticker snapshot for every symbol. Default: `loadBinanceUniverse`. */
  readonly loadQuotes?: (signal: AbortSignal) => Promise<readonly UniverseEntry[]>;
  /** Recent closes, oldest first. Default: last 24 hourly closes from `loadBinanceBars`. */
  readonly loadCloses?: (sym: string, signal: AbortSignal) => Promise<readonly number[]>;
  /** Snapshot cadence. Default 15s; paused while the tab is hidden. */
  readonly refreshMs?: number;
}

/** The desk has no cadence of its own (load once, then a button), so this is set here. */
export const RAIL_REFRESH_MS = 15_000;
/** At most this many kline requests in flight at once. */
export const SPARK_CONCURRENCY = 2;
/** A sparkline older than this is re-asked for on the next snapshot (the cache absorbs most of it). */
const SPARK_MAX_AGE_MS = 5 * 60_000;
const SPARK_W = 48;
const SPARK_H = 18;

export interface QuoteSnapshot {
  readonly rows: ReadonlyMap<string, UniverseEntry> | null;
  readonly at: number;
  readonly loading: boolean;
  /** Operator-facing reason the LAST attempt failed, or "". */
  readonly error: string;
}

export type RowQuote =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "quote"; readonly entry: UniverseEntry; readonly stale: string };

// ---------------------------------------------------------- pure helpers ---

/**
 * SVG path for a sparkline through `closes`, scaled into w x h with `pad` kept
 * clear top and bottom. "" when there are fewer than two finite points: no line
 * is better than an invented one. A flat series draws a flat line at mid height.
 */
export function sparkPath(closes: readonly number[], w = SPARK_W, ht = SPARK_H, pad = 1): string {
  const pts = closes.filter((c) => Number.isFinite(c));
  if (pts.length < 2) return "";
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo;
  const step = w / (pts.length - 1);
  const inner = ht - 2 * pad;
  const r = (n: number): string => String(Math.round(n * 10) / 10);
  return pts
    .map((c, i) => {
      const y = span === 0 ? ht / 2 : pad + ((hi - c) / span) * inner;
      return `${i === 0 ? "M" : "L"}${r(i * step)} ${r(y)}`;
    })
    .join(" ");
}

/** Direction of a sparkline, first finite close to last. */
export function sparkTone(closes: readonly number[]): "pos" | "neg" | "flat" {
  const pts = closes.filter((c) => Number.isFinite(c));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined || pts.length < 2 || last === first) return "flat";
  return last > first ? "pos" : "neg";
}

/** 24h change as text and the direction that colours it. */
export function changeText(pct: number): { text: string; tone: "pos" | "neg" | "flat" | "" } {
  if (!Number.isFinite(pct)) return { text: "—", tone: "" };
  return { text: signed(pct), tone: pct > 0 ? "pos" : pct < 0 ? "neg" : "flat" };
}

/** How many listed symbols have a live setup. Symbols off the list do not count. */
export function liveSetupCount(
  symbols: readonly string[],
  setups: ReadonlyMap<string, WatchSetup> | undefined,
): number {
  if (!setups) return 0;
  let n = 0;
  for (const s of new Set(symbols)) if (setups.get(s)?.live === true) n++;
  return n;
}

/** A load failure, worded for the operator. The raw text goes to the console. */
export function quoteFailure(err: unknown): string {
  if (err instanceof RateLimited) return "Binance is rate-limiting this terminal; the rail will retry.";
  if (err instanceof TypeError) return "Binance could not be reached from here.";
  return "Binance did not return a usable price snapshot.";
}

/** What one row can honestly say about its price. */
export function rowQuote(sym: string, snap: QuoteSnapshot, now: number): RowQuote {
  if (snap.rows === null) {
    if (snap.error !== "") return { kind: "failed", reason: snap.error };
    return { kind: "loading" };
  }
  const entry = snap.rows.get(sym);
  if (!entry) return { kind: "none", reason: `Binance has no 24h ticker for ${sym}, so the rail cannot price it.` };
  const stale =
    snap.error === ""
      ? ""
      : `${snap.error} Showing the snapshot from ${Math.max(0, Math.round((now - snap.at) / 1000))}s ago.`;
  return { kind: "quote", entry, stale };
}

// -------------------------------------------------------------- component ---

const SVG_NS = "http://www.w3.org/2000/svg";

interface Spark {
  readonly closes: readonly number[];
  readonly at: number;
}

interface Row {
  readonly el: HTMLButtonElement;
  readonly setup: HTMLSpanElement;
  readonly spark: HTMLSpanElement;
  readonly svg: SVGSVGElement;
  readonly path: SVGPathElement;
  readonly px: HTMLSpanElement;
  readonly chg: HTMLSpanElement;
}

const defaultCloses = async (sym: string, sig: AbortSignal): Promise<readonly number[]> =>
  (await loadBinanceBars(sym, "1h", 24, sig)).map((b) => b.c);

export function createWatchRail(opts: WatchRailOptions): { el: HTMLElement; destroy(): void } {
  const loadQuotes = opts.loadQuotes ?? ((sig: AbortSignal) => loadBinanceUniverse(sig));
  const loadCloses = opts.loadCloses ?? defaultCloses;
  const refreshMs = opts.refreshMs ?? RAIL_REFRESH_MS;

  const snap = signal<QuoteSnapshot>({ rows: null, at: 0, loading: false, error: "" });
  const sparks = signal<ReadonlyMap<string, Spark>>(new Map());
  const abort = new AbortController();
  let destroyed = false;

  // -------------------------------------------------------------- quotes ---

  const refresh = async (): Promise<void> => {
    if (destroyed || snap.peek().loading) return;
    snap.set({ ...snap.peek(), loading: true });
    try {
      const rows = await loadQuotes(abort.signal);
      if (destroyed) return;
      snap.set({ rows: new Map(rows.map((r) => [r.symbol, r])), at: Date.now(), loading: false, error: "" });
    } catch (err) {
      if (destroyed) return;
      console.warn("[watchrail] quote snapshot failed", err);
      snap.set({ ...snap.peek(), loading: false, error: quoteFailure(err) });
    }
  };

  const visible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";
  const timer = setInterval(() => {
    if (visible()) void refresh();
  }, refreshMs);
  const onVisibility = (): void => {
    if (visible() && Date.now() - snap.peek().at >= refreshMs) void refresh();
  };
  document.addEventListener("visibilitychange", onVisibility);
  void refresh();

  // ---------------------------------------------------------- sparklines ---

  const queue: string[] = [];
  const inFlight = new Set<string>();

  const pump = (): void => {
    while (!destroyed && inFlight.size < SPARK_CONCURRENCY && queue.length > 0) {
      const sym = queue.shift() as string;
      inFlight.add(sym);
      loadCloses(sym, abort.signal)
        .then((closes) => {
          if (destroyed) return;
          const next = new Map(sparks.peek());
          next.set(sym, { closes, at: Date.now() });
          sparks.set(next);
        })
        .catch((err: unknown) => {
          /* No line is the honest outcome; the row's space stays empty. */
          if (!destroyed) console.warn(`[watchrail] closes for ${sym} failed`, err);
        })
        .finally(() => {
          inFlight.delete(sym);
          pump();
        });
    }
  };

  /* Lazy: only symbols the snapshot can price (a stock would only 400), only
     when missing or old, and re-evaluated whenever the list or snapshot moves. */
  const stopSparkEffect = effect(() => {
    const syms = opts.symbols();
    const rows = snap().rows;
    if (rows === null) return;
    const have = untrack(() => sparks());
    const now = Date.now();
    for (const sym of new Set(syms)) {
      if (!rows.has(sym) || inFlight.has(sym) || queue.includes(sym)) continue;
      const s = have.get(sym);
      if (s && now - s.at < SPARK_MAX_AGE_MS) continue;
      queue.push(sym);
    }
    pump();
  });

  // ----------------------------------------------------------------- DOM ---

  const count = h("span", { class: "wr-count" });
  const list = h("div", { class: "wr-list" });
  const empty = h("p", { class: "wr-empty", text: "Add symbols from Opportunities or with the palette." });
  const el = h(
    "section",
    { class: "watchrail", "aria-label": "Watchlist" },
    h("header", { class: "wr-head" }, h("h2", { class: "wr-title", text: "Watchlist" }), count),
    list,
    empty,
  );

  const rows = new Map<string, Row>();

  const makeRow = (sym: string): Row => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    svg.appendChild(path);
    const setup = h("span", { class: "wr-setup" });
    const spark = h("span", { class: "wr-spark" }, svg);
    const px = h("span", { class: "wr-px" });
    const chg = h("span", { class: "wr-chg" });
    const rowEl = h(
      "button",
      {
        class: "wr-row",
        type: "button",
        "data-symbol": sym,
        onclick: () => opts.onPick(sym),
      },
      h("span", { class: "wr-id" }, h("span", { class: "wr-sym", text: sym }), setup),
      spark,
      h("span", { class: "wr-fig" }, px, chg),
    );
    return { el: rowEl, setup, spark, svg, path, px, chg };
  };

  const paintRow = (sym: string, r: Row, isActive: boolean, setup: WatchSetup | undefined, now: number): void => {
    r.el.dataset["active"] = String(isActive);
    if (isActive) r.el.setAttribute("aria-current", "true");
    else r.el.removeAttribute("aria-current");

    r.setup.textContent = setup ? setup.label : "";
    r.setup.dataset["dir"] = setup ? setup.direction : "";
    r.setup.dataset["live"] = String(setup?.live === true);

    const q = rowQuote(sym, snap(), now);
    let title = `Open ${sym} on the chart`;
    if (q.kind === "quote") {
      const c = changeText(q.entry.changePct);
      r.px.textContent = money(q.entry.lastPrice);
      r.chg.textContent = c.text;
      r.el.dataset["tone"] = c.tone;
      r.el.dataset["state"] = q.stale === "" ? "quote" : "stale";
      if (q.stale !== "") title += `\n${q.stale}`;
    } else {
      r.px.textContent = q.kind === "loading" ? "loading…" : q.kind === "failed" ? "failed" : "no quote";
      r.chg.textContent = "";
      r.el.dataset["tone"] = "";
      r.el.dataset["state"] = q.kind;
      if (q.kind !== "loading") title += `\n${q.reason}`;
    }

    const s = sparks().get(sym);
    const d = s ? sparkPath(s.closes) : "";
    if (d === "") {
      r.path.removeAttribute("d");
      r.spark.dataset["on"] = "false";
    } else {
      r.path.setAttribute("d", d);
      r.spark.dataset["on"] = "true";
      r.spark.dataset["tone"] = sparkTone(s?.closes ?? []);
      title += "\nLine: the last 24 closed hourly bars; it can trail the price by up to an hour.";
    }
    r.el.title = title;
  };

  const stopRender = renderEffect(() => {
    const syms = [...new Set(opts.symbols())];
    const act = opts.active();
    const setupMap = opts.setups?.();
    const now = Date.now();

    const live = liveSetupCount(syms, setupMap);
    count.textContent = opts.setups ? `${live} live` : "";
    count.title = opts.setups ? `${live} of ${syms.length} symbols have a live setup` : "";
    const sn = snap();
    el.dataset["loading"] = String(sn.loading);
    el.title = sn.at > 0 ? `Binance 24h snapshot, as of ${new Date(sn.at).toLocaleTimeString()}` : "";

    empty.hidden = syms.length > 0;
    list.hidden = syms.length === 0;

    for (const [sym, r] of rows) {
      if (!syms.includes(sym)) {
        r.el.remove();
        rows.delete(sym);
      }
    }
    syms.forEach((sym, i) => {
      let r = rows.get(sym);
      if (!r) {
        r = makeRow(sym);
        rows.set(sym, r);
      }
      paintRow(sym, r, sym === act, setupMap?.get(sym), now);
      /* Only move a row that is out of place: re-inserting a focused button
         blurs it, and the snapshot repaints every 15s under a keyboard user. */
      const at = list.children[i];
      if (at !== r.el) list.insertBefore(r.el, at ?? null);
    });
  });

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    abort.abort();
    queue.length = 0;
    stopSparkEffect();
    stopRender();
  };

  return { el, destroy };
}
