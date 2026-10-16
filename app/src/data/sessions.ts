/**
 * Market sessions — telling "the market is shut" apart from "the feed is broken".
 *
 * WHY THIS EXISTS
 * The freshness contract judges a feed by how old its newest bar is. That is
 * right on Tuesday and wrong on Sunday: forex closes for the weekend, so a
 * perfectly healthy broker feed reports a bar 44 hours old and gets labelled
 * DELAYED. Do that every weekend and the operator learns to ignore the warning
 * — which is precisely how a REAL staleness alarm gets missed on a Wednesday.
 *
 * So a closed market is its own state, and it is never called delayed or stale.
 *
 * The FX week is Sunday 22:00 UTC to Friday 22:00 UTC. That tracks the
 * Sydney open and the New York close, and it shifts an hour with US daylight
 * saving — the boundaries here are deliberately approximate, because being
 * exactly right about the edge of the session matters far less than not lying
 * about the difference between "shut" and "broken".
 */

import {
  easternOffsetHours,
  equityClosedNote,
  equityDay,
  equityVenue,
  isEquityOpen,
} from "./equityhours";

export type MarketState = "open" | "closed" | "unknown";

export type AssetClass = "crypto" | "forex" | "metal" | "equity" | "unknown";

const CRYPTO_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD"];
const FX_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
  "SEK", "NOK", "DKK", "PLN", "HUF", "CZK", "TRY", "ZAR",
  "MXN", "SGD", "HKD", "CNH",
]);
const METALS = new Set(["XAU", "XAG", "XPT", "XPD"]);
const INDEX_SYMBOLS = new Set([
  "NAS100", "US30", "SPX500", "US2000",
  "GER40", "UK100", "JPN225", "AUS200", "FRA40", "EU50", "HK50",
]);

/**
 * Classify a symbol well enough to know when it trades.
 *
 * Broker suffixes are stripped first: JustMarkets serves `EURUSD.s`, and a
 * classifier that does not expect that would call every FX pair unknown and
 * fall back to "always open".
 */
export function assetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  if (CRYPTO_QUOTES.some((q) => symbol.toUpperCase().endsWith(q))) return "crypto";
  if (s.length === 6) {
    const base = s.slice(0, 3);
    const quote = s.slice(3);
    if (METALS.has(base) && FX_CODES.has(quote)) return "metal";
    if (FX_CODES.has(base) && FX_CODES.has(quote)) return "forex";
    if (base === "BTC" || base === "ETH") return "crypto";
  }
  /* Index CFDs — NAS100, GER40, JPN225 — carry a digit and are six or seven
     characters, so the bare-ticker test below never saw them and every one was
     classified `unknown`. They trade on an exchange calendar like the shares
     that make them up. */
  if (INDEX_SYMBOLS.has(symbol.toUpperCase().replace(/[^A-Z0-9]/g, ""))) return "equity";
  if (/^[A-Z]{1,5}$/.test(symbol.toUpperCase())) return "equity";
  return "unknown";
}

/**
 * Is the FX/metals market open at `now`?
 *
 * Open from Sunday 22:00 UTC to Friday 22:00 UTC.
 */
export function isForexOpen(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 = Sunday
  const hour = d.getUTCHours();

  if (day === 6) return false; // all Saturday
  if (day === 0) return hour >= 22; // Sunday opens at 22:00
  if (day === 5) return hour < 22; // Friday closes at 22:00
  return true;
}

/**
 * The hour of the Eastern trading day that metals do not trade.
 *
 * CME's daily settlement break: 17:00–18:00 in New York, every weekday. It is
 * anchored to Eastern wall-clock rather than UTC, so it lands at 21:00 UTC in
 * summer and 22:00 UTC in winter — which is exactly why this uses
 * `easternOffsetHours` instead of a fixed UTC hour.
 */
export const METAL_BREAK_ET_HOUR = 17;

/**
 * Is the metals market open at `now`?
 *
 * MEASURED, and this was a real bug rather than a refinement.
 *
 * Metals were being judged by `isForexOpen`, which models a continuous week
 * from Sunday 22:00 to Friday 22:00 with no daily break. But the proxy serves
 * `XAUUSD` from `GC=F` — the COMEX future — and that contract halts for an hour
 * every weekday to settle. So a COMPLETE gold series was missing one hour in
 * every twenty-four of its "open" time and scored 96.2% coverage, which sits
 * just under the backtest engine's 98% floor.
 *
 * The visible consequence: the cross-market survey downloaded six thousand
 * perfectly good gold bars and then discarded them on every single run, leaving
 * a panel that was supposed to span four blocs measuring two. The data was
 * right and the calendar was wrong, and the calendar is what refused it.
 *
 * Counted over 2,000 real hourly bars: 1,045 missing hours, of which 864 were
 * the weekend (already discounted) and **89 were at exactly 21:00 UTC** — one
 * per trading day in the window. The remainder were holidays.
 *
 * ...AND THE US HOLIDAY CALENDAR, WHICH WAS THE LARGER HALF.
 *
 * Subtracting the daily break alone moved a real 4,000-bar gold series from
 * 91.3% to 95.2% — better, and still under the floor. Measuring where the
 * remaining 201 open-but-absent hours actually fell settled it: **169 of them
 * landed on days `equityDay` already names** — New Year's, MLK, Presidents',
 * Good Friday, Memorial, Juneteenth, Independence, Labor — and the leftover
 * five-hour fragments were those same holidays seen in UTC, since 00:00–05:00
 * UTC is the previous EASTERN evening.
 *
 * So metals keep the US holiday calendar, and it is evaluated on the Eastern
 * date rather than the UTC one: shifting the instant by the Eastern offset makes
 * `equityDay`'s UTC-based date read as the Eastern one, which is the whole
 * reason the holiday hours were previously split across two UTC days.
 *
 * `why === "weekend"` is deliberately ignored — `isForexOpen` already owns the
 * weekend in UTC terms, and metals reopen on Sunday evening Eastern, which
 * `equityDay` would call a weekend and close.
 *
 * Half-days are left OPEN. Metals do trade on them, merely shortened, and
 * over-discounting is the unsafe direction: it inflates coverage and hides real
 * holes, which is exactly what this floor exists to catch.
 */
export function isMetalOpen(now: number): boolean {
  if (!isForexOpen(now)) return false;
  const etHour = (new Date(now).getUTCHours() + easternOffsetHours(now) + 24) % 24;
  if (etHour === METAL_BREAK_ET_HOUR) return false;

  const day = equityDay(now + easternOffsetHours(now) * 3_600_000);
  return !(day.kind === "closed" && day.why !== "weekend");
}

/**
 * Market state for a symbol.
 *
 * Crypto never closes. Forex runs Sunday 22:00 to Friday 22:00 UTC. US-listed
 * equities and US index CFDs are now modelled properly by `equityhours.ts` —
 * regular session, computed holidays, and the three half-days.
 *
 * Non-US venues still return `unknown`, deliberately. Frankfurt and London
 * keep their own calendars, and applying New York's to them would be the same
 * confident wrong answer this function was written to refuse. An unknown state
 * leaves the freshness contract to judge on data age alone, which is safe.
 */
export function marketState(symbol: string, now: number = Date.now()): MarketState {
  switch (assetClass(symbol)) {
    case "crypto":
      return "open";
    case "forex":
      return isForexOpen(now) ? "open" : "closed";
    case "metal":
      /* Its own predicate, so the terminal does not claim gold is trading
         during the hour it is settling — and so the freshness contract does not
         raise a staleness alarm every weekday at 21:00 for a feed that is
         behaving perfectly. */
      return isMetalOpen(now) ? "open" : "closed";
    case "equity":
      return equityVenue(symbol) === "us" ? (isEquityOpen(now) ? "open" : "closed") : "unknown";
    default:
      return "unknown";
  }
}

/** Human-readable, for the status bar. */
export function sessionNote(symbol: string, now: number = Date.now()): string {
  const state = marketState(symbol, now);
  if (state !== "closed") return "";
  /* An equity closure has a reason worth naming. "closed — Thanksgiving" is a
     fact the operator can check; "closed" is a claim they have to trust. */
  if (assetClass(symbol) === "equity") return equityClosedNote(now);
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 6 || day === 0 || (day === 5 && d.getUTCHours() >= 22)) {
    return "market closed — weekend";
  }
  /* A named reason is a fact the operator can check; a bare "closed" is a claim
     they have to trust — the same argument `equityClosedNote` makes above. */
  if (assetClass(symbol) === "metal") return "market closed — daily settlement break";
  return "market closed";
}

/**
 * How much of a time span the market was actually open for.
 *
 * WHY A BACKTEST NEEDS THIS
 * Data coverage is measured as "bars I have / bars I should have", and the
 * denominator is wrong for anything that closes. A year of EURUSD hourly bars
 * is missing every weekend BY DEFINITION, so a naive coverage check reports
 * about 71% and the backtester refuses to run on perfectly complete data.
 *
 * Worse than the false refusal is what it teaches: a guard that fires on good
 * data gets the threshold lowered until it stops firing, and then it no longer
 * catches the real hole it was put there for.
 *
 * Sampled hourly, which is far finer than the gaps this is used to judge and
 * costs nothing at these spans. Crypto and unknown classes return the full
 * span — for `unknown` that is the conservative direction, since it makes a
 * hole look larger rather than smaller.
 */
export function openSpanMs(symbol: string, from: number, to: number): number {
  if (to <= from) return 0;
  const cls = assetClass(symbol);
  const usEquity = cls === "equity" && equityVenue(symbol) === "us";
  if (cls !== "forex" && cls !== "metal" && !usEquity) return to - from;

  /* Equities trade six and a half hours a day, five days a week — under 20% of
     the wall clock. Counting the closed 80% against coverage would make every
     complete equity series look like an 81% hole and the backtester would
     refuse to run on perfect data. The finer step matters here in a way it does
     not for forex: a 30-minute error either side of a 390-minute session is 15%
     of it, against 0.4% of a 120-hour forex week. */
  const STEP = usEquity ? 300_000 : 3_600_000;
  const open_ = usEquity ? isEquityOpen : cls === "metal" ? isMetalOpen : isForexOpen;
  let open = 0;
  for (let t = from; t < to; t += STEP) {
    const chunk = Math.min(STEP, to - t);
    // Judge the MIDPOINT of the chunk, so an interval straddling the open or
    // the close is counted whichever way it mostly falls rather than always
    // one way.
    if (open_(t + chunk / 2)) open += chunk;
  }
  return open;
}

/**
 * Coverage of a loaded window, ignoring time the venue was shut.
 *
 * Returns 1 when nothing is missing, and 0 when the window contains no
 * tradeable time at all (a weekend-only range), because a study over a shut
 * market has no data by definition rather than complete data.
 */
export function openCoverage(
  symbol: string,
  window: { from: number; to: number },
  gaps: readonly { from: number; to: number }[],
): number {
  const total = openSpanMs(symbol, window.from, window.to);
  if (total <= 0) return 0;
  let missing = 0;
  for (const g of gaps) {
    const from = Math.max(g.from, window.from);
    const to = Math.min(g.to, window.to);
    if (to > from) missing += openSpanMs(symbol, from, to);
  }
  return Math.max(0, Math.min(1, 1 - missing / total));
}
