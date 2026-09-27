/**
 * The spread you are actually paying, from the broker you are actually filled by.
 *
 * WHAT WAS MISSING, AND WHY IT MATTERED
 * The Setup card's spread gate asks one question: is the cost of getting in
 * small enough relative to the stop to be worth paying? On every non-crypto
 * instrument it answered "No spread reading for this instrument, so the cost of
 * entering cannot be checked against the stop" — an honest refusal, and an
 * unnecessary one. `mt5_bridge.tick()` has been returning a live bid, ask and
 * spread the whole time, straight from the terminal that fills the orders, and
 * nothing in the app had ever called it.
 *
 * THE DISTINCTION THIS FILE EXISTS TO KEEP
 * `data/spread.ts` measures something DIFFERENT and must not be confused with
 * this. That module compares one instrument's price ACROSS VENUES: it answers
 * "is this quote odd", and a wide reading there means the venues disagree. This
 * module measures the BID-ASK at one venue: it answers "what does a round trip
 * cost me", and a wide reading here means the trade is more expensive than the
 * plan assumed.
 *
 * Both are worth having and they are not substitutes. Feeding a cross-venue
 * basis into a cost-of-entry gate — which is what happened by default, because
 * it was the only number available — overstates the cost on a calm day and
 * understates it during the exact dislocations where entering is dangerous.
 *
 * WHAT IT WILL NOT DO
 * Estimate. There is no fallback spread, no "typical for this instrument", no
 * last-known value carried forward. If the bridge does not answer, this returns
 * a refusal and the gate goes back to saying it cannot check — because a guessed
 * dealing cost is the input to a position size, and a position size computed
 * from a guess is the kind of number that costs money quietly.
 */

import { fetchJson } from "./net";
import { proxyBase } from "./backend";

export interface BrokerQuote {
  readonly ok: true;
  /** The broker's own name for it — `XAUUSD.s`, not necessarily what you typed. */
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  /** Ask minus bid, in price. The round-trip cost of crossing, once. */
  readonly spread: number;
  /** As a share of price, in percent. Comparable across instruments. */
  readonly spreadPct: number;
  readonly digits: number;
  /** When the tick was stamped, in real UTC — the bridge has already
   *  subtracted the broker's server-clock offset. See server/mt5_bridge.py. */
  readonly asOf: number;
}

export interface BrokerQuoteRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type BrokerQuoteResult = BrokerQuote | BrokerQuoteRefusal;

/**
 * A tick older than this is not the spread you would pay now.
 *
 * Spreads widen in seconds — around a release, at the session roll, on any
 * thin book. A thirty-second-old spread is a historical fact, not a quote, and
 * sizing against one is how a stop that looked affordable turns out not to be.
 */
export const MAX_QUOTE_AGE_MS = 30_000;

export async function loadBrokerQuote(
  symbol: string,
  base = proxyBase(),
  now: () => number = Date.now,
): Promise<BrokerQuoteResult> {
  const url = new URL("/mt5/tick", base);
  url.searchParams.set("symbol", symbol.toUpperCase());

  let body: Record<string, unknown>;
  try {
    body = await fetchJson<Record<string, unknown>>(url.toString(), {
      /* Background: this must never outrank the chart the user is waiting for. */
      priority: "background",
      /* A short TTL, not none. Several panels want the same quote in the same
         second, and the cache is what stops that being several requests. */
      ttlMs: 2_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `The MT5 bridge did not answer: ${err.message}`
          : "The MT5 bridge did not answer.",
    };
  }

  if (typeof body["error"] === "string") {
    return { ok: false, reason: String(body["error"]) };
  }

  return shapeQuote(body, now());
}

/**
 * Turn the bridge's payload into a quote, or refuse.
 *
 * Split out and pure so every refusal below is testable without a broker —
 * these are the branches that decide whether a gate gets to run at all.
 */
export function shapeQuote(body: Record<string, unknown>, now: number): BrokerQuoteResult {
  const bid = Number(body["bid"]);
  const ask = Number(body["ask"]);
  const asOf = Number(body["t_ms"]);

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return { ok: false, reason: "The bridge returned a tick with no usable bid or ask." };
  }

  /* An inverted book is a broken quote, never a negative cost. Passing it
     through would produce a spread gate that PASSES more easily the more
     broken the feed is. */
  if (ask < bid) {
    return {
      ok: false,
      reason: `The bridge returned ask ${ask} below bid ${bid}. That is a broken quote, not a free trade.`,
    };
  }

  if (Number.isFinite(asOf) && asOf > 0 && now - asOf > MAX_QUOTE_AGE_MS) {
    return {
      ok: false,
      reason: `The last tick is ${Math.round((now - asOf) / 1000)}s old. Spreads move in seconds, so this is a historical fact rather than the cost of entering now.`,
    };
  }

  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  return {
    ok: true,
    symbol: String(body["symbol"] ?? ""),
    bid,
    ask,
    spread,
    spreadPct: mid > 0 ? (spread / mid) * 100 : NaN,
    digits: Number.isFinite(Number(body["digits"])) ? Number(body["digits"]) : 2,
    asOf: Number.isFinite(asOf) ? asOf : now,
  };
}

/** `0.18 (0.004%)` — the cost, and how it compares across instruments. */
export function quoteWords(q: BrokerQuote): string {
  const dp = Math.max(0, Math.min(8, q.digits));
  return `${q.spread.toFixed(dp)} (${q.spreadPct.toFixed(3)}%)`;
}
