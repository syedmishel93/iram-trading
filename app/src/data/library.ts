/**
 * WHAT THE TERMINAL KEEPS CURRENT, AND HOW MUCH ROOM IT MAY USE.
 *
 * MEASURED before this existed, across the whole product: **one series** —
 * binance BTCUSDT 1h, 5,803 bars, 272 KB — held in one browser profile, with a
 * background top-up job that shipped switched OFF and only ever refreshed
 * series somebody had already added by hand. So the answer to "what can I
 * backtest on" was "whatever you happened to look at", and the cross-asset
 * questions could not be asked at all because nothing else was stored.
 *
 * This is the list that fixes that: a fixed macro spine, plus whatever is on
 * the watchlist, enrolled automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE LIST, TWO READERS
 *
 * The browser keeps its own archive and the server keeps the durable one
 * (`server/svc/bars.py`), and BOTH have to top up the same series or the two
 * halves drift into holding different history for the same instrument. So the
 * enrolment is computed here, once, and pushed to the server — rather than
 * being declared in two places that are free to disagree. The server's
 * `bars_loop` reads it back out of `bars_enrolled`; until something wrote that
 * key the loop ran hourly and did nothing, which is exactly the kind of
 * component that looks alive in a health check and produces nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPINE IS EIGHT SERIES AND EVERY ONE EARNS ITS PLACE
 *
 * Four are tradeable and four explain them. A yield and an index are NOT
 * instruments you can hold — see `contextOnly` in `risk/instruments.ts` — they
 * are here so a study can name them as drivers and so a regime can be read.
 */

import { isContextOnly } from "../risk/instruments";

/** One series to keep current: a venue, an instrument and a bar size. */
export interface Enrolled {
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** False for a yield or an index — never sized, never searched. */
  readonly tradeable: boolean;
}

/**
 * The markets that explain each other.
 *
 * Crypto and gold are what gets traded here; the dollar, the cost of money and
 * the appetite for risk are what move them. Kept deliberately short: every
 * series added is bandwidth and disk spent hourly, forever, and a spine nobody
 * reads is just a download.
 */
/**
 * `read: true` means CONTEXT — a series the machine reads to describe the
 * world, never one it proposes a trade in.
 *
 * The split was a COMMENT ("Traded." / "Read.") and nothing could act on it, so
 * the autonomous sweep studied US10Y and VIX as trading subjects. Two costs,
 * both measured: a top-six result was `williams-reversal on VIX`, which nobody
 * can act on, and every untradeable arm WIDENS the search — the best-of-N
 * hurdle is `sqrt(2 ln N)/sqrt(n)`, so arms spent on an index you cannot buy
 * raise the bar every tradeable rule has to clear.
 *
 * Context series still matter, and more than before: they are the CONDITIONS a
 * rule is filtered by. A field lets them be one and not the other.
 */
export const MACRO_SPINE: readonly { symbol: string; source: string; read?: boolean }[] = [
  /* Traded. */
  { symbol: "BTCUSDT", source: "binance" },
  { symbol: "ETHUSDT", source: "binance" },
  { symbol: "XAUUSD", source: "yfinance" },
  { symbol: "EURUSD", source: "yfinance" },
  /* Read, never traded. */
  { symbol: "DXY", source: "yfinance", read: true },
  { symbol: "US10Y", source: "yfinance", read: true },
  { symbol: "SPX", source: "yfinance", read: true },
  { symbol: "VIX", source: "yfinance", read: true },
];

/** The context half of the spine, by symbol. Mirrored by `CONTEXT_SYMBOLS` in `server/svc/auto.py`. */
export const CONTEXT_SYMBOLS: readonly string[] = MACRO_SPINE.filter((m) => m.read).map((m) => m.symbol);

/**
 * The bar sizes kept for every enrolled series.
 *
 * 1h is what a sweep studies (5,000 bars ~ seven months, which is what five
 * walk-forward folds need). 1d is the only series long enough to cross more
 * than one regime, and `store/retention.ts` already keeps it forever at
 * "17 KB/year" — the cheapest useful data in the product.
 *
 * NOT 1m here: it is worth having (it settles whether a stop or a target was
 * hit first inside a bar) but it is a bulk download measured in hundreds of
 * megabytes, so it belongs to the deliberate library fill rather than to an
 * hourly top-up.
 */
export const ENROLLED_TIMEFRAMES: readonly string[] = ["1h", "1d"];

/**
 * Every series the terminal keeps current: the spine, plus the watchlist.
 *
 * Adding a symbol to the watchlist enrols it, which is the behaviour an
 * operator would assume anyway — a market you are watching is one you will
 * want history for. Duplicates collapse on `source|symbol|timeframe`.
 */
export function enrolledSeries(
  watchlist: readonly string[],
  spine: readonly { symbol: string; source: string }[] = MACRO_SPINE,
): Enrolled[] {
  const out = new Map<string, Enrolled>();
  const add = (symbol: string, source: string): void => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    for (const timeframe of ENROLLED_TIMEFRAMES) {
      out.set(`${source}|${sym}|${timeframe}`, {
        source,
        symbol: sym,
        timeframe,
        tradeable: !isContextOnly(sym),
      });
    }
  };
  for (const s of spine) add(s.symbol, s.source);
  /* A watchlist symbol with no declared venue is crypto by convention — the
     watchlist is a crypto list in practice, and `binance` is the source the
     registry tries first for anything ending USDT. */
  for (const sym of watchlist) add(sym, sym.trim().toUpperCase().endsWith("USDT") ? "binance" : "yfinance");
  return [...out.values()];
}

/** The wire form the server's `bars_enrolled` config key holds. */
export function enrolmentLine(rows: readonly Enrolled[]): string {
  return rows.map((r) => `${r.source}|${r.symbol}|${r.timeframe}`).join(",");
}

/**
 * HOW MUCH DISK THE LIBRARY MAY USE.
 *
 * A number the operator sets, not a constant. The owner's words: "20 gb is not
 * a must or a fixed rule ... its a personal computer". So the default is
 * deliberately modest — bars for the whole spine are under a gigabyte, and
 * anything beyond that is a choice somebody makes on purpose — and whatever is
 * used is always reported beside it. A budget that cannot be seen is a budget
 * nobody can consent to.
 */
export const DEFAULT_BUDGET_GB = 5;

export const BUDGET_SLOT = {
  key: "library.budget-gb",
  version: 1,
  fallback: (): number => DEFAULT_BUDGET_GB,
  validate: (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 500 ? v : null,
};
