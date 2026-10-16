/**
 * The dealing spread on a crypto venue: the actual top of the actual book.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES, AND HOW BADLY IT WAS BROKEN
 *
 * The Setup card's spread gate asks one question — is the cost of entering
 * small enough, relative to the stop, to be worth paying? On every crypto pair
 * it was answered with the CROSS-VENUE BASIS from data/spread.ts: the gap
 * between what Binance, Coinbase, Kraken and OKX print for the same asset.
 *
 * That is not the dealing cost. It is not an approximation of the dealing cost.
 * On BTCUSDT, measured on this machine:
 *
 *     cross-venue basis fed to the gate    0.059%   ≈ $45 on a $77,000 price
 *     actual Binance bid-ask                        $0.01
 *
 * Four and a half THOUSAND times the real number. Against a 134-point stop the
 * gate reported "spread is 26% of the stop distance, your budget is 15%" and
 * refused the trade. The true figure was 0.007%. Every crypto setup on a tight
 * stop was being stood down by a cost nobody was paying.
 *
 * data/brokerquote.ts already made this exact argument — "feeding a cross-venue
 * basis into a cost-of-entry gate overstates the cost on a calm day and
 * understates it during the exact dislocations where entering is dangerous" —
 * and then fixed it only for MT5, because the MT5 bridge was the only source of
 * a real bid-ask at the time. Crypto kept the proxy. This is the other half.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT TOP OF BOOK DOES AND DOES NOT TELL YOU
 *
 * `bookTicker` gives the best bid and the best ask AND THE SIZE RESTING AT
 * EACH. That last part is not a detail: the quoted spread is the cost of a
 * trade that FITS inside those sizes. A larger order walks the book and pays
 * more, and how much more is not knowable from this endpoint.
 *
 * So the quote carries the depth out with it, and the card is given the means
 * to say "your size does not fit in the top of book" instead of quoting a cost
 * that only applies to somebody smaller. A dealing spread reported without the
 * depth it holds at is the same category of mistake as the cross-venue basis it
 * replaces: a real number answering a different question.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO
 *
 * Estimate. No typical spread, no last-known value carried forward, no fallback
 * for a symbol the venue does not list. A refusal sends the gate back to saying
 * it cannot check, which is the correct outcome — see the identical refusal in
 * brokerquote.ts and the reason it is there.
 */

import { fetchJson } from "./net";
import type { BrokerQuoteResult } from "./brokerquote";

const API = "https://api.binance.com";

/**
 * A tick older than this is not the spread you would pay now.
 *
 * The same 30 seconds brokerquote.ts uses, and for the same reason: spreads
 * widen in seconds, and sizing against a historical one is how a stop that
 * looked affordable turns out not to be. Kept as its own constant rather than
 * imported so neither module can silently change the other's contract.
 */
export const MAX_BOOK_AGE_MS = 30_000;

/**
 * Above this share of the price, a "spread" is a broken read, not a wide book.
 *
 * A top-of-book spread of more than 5% on a listed pair means one side of the
 * book is empty or the payload is malformed. Passing it through would fail the
 * gate for the right-looking reason and the wrong actual one — and a gate that
 * refuses because the data is broken must say the data is broken.
 */
export const ABSURD_SPREAD_PCT = 5;

export interface BookDepth {
  /** Units of the base asset resting at the best bid and the best ask. */
  readonly bidQty: number;
  readonly askQty: number;
}

/** Everything `shapeBook` needs from the venue, still unparsed. */
export interface BookTickerBody {
  readonly symbol?: unknown;
  readonly bidPrice?: unknown;
  readonly bidQty?: unknown;
  readonly askPrice?: unknown;
  readonly askQty?: unknown;
}

export type BookQuote = BrokerQuoteResult & { readonly depth?: BookDepth };

/** Decimal places actually used by the venue's own strings, capped at 8. */
export function decimalsOf(...values: readonly string[]): number {
  let most = 0;
  for (const v of values) {
    const dot = v.indexOf(".");
    if (dot < 0) continue;
    /* Trailing zeros are padding, not precision: Binance sends "77145.36000000"
       for a two-decimal price, and taking the string length literally would
       format every crypto price to eight places. */
    let end = v.length;
    while (end > dot + 1 && v.charAt(end - 1) === "0") end -= 1;
    const frac = end - dot - 1;
    if (frac > most) most = frac;
  }
  return Math.min(8, most);
}

/**
 * Turn the venue's payload into a quote, or refuse.
 *
 * Pure and exported so every refusal below is testable without a network — the
 * branches here are the ones that decide whether a gate gets to run at all,
 * which makes them the ones most worth pinning down.
 *
 * `now` is passed rather than read, because the endpoint does not stamp its
 * response: `asOf` is the moment WE received it, and calling it anything else
 * would be inventing a precision the venue did not provide.
 */
export function shapeBook(body: BookTickerBody, symbol: string, now: number): BookQuote {
  const bid = Number(body.bidPrice);
  const ask = Number(body.askPrice);
  const bidQty = Number(body.bidQty);
  const askQty = Number(body.askQty);

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return { ok: false, reason: `${symbol}: the venue returned a book with no usable bid or ask.` };
  }

  /* An inverted book is a broken quote, never a negative cost. Letting it
     through would produce a spread gate that PASSES more easily the more
     broken the feed is — the same refusal, and the same reason, as
     shapeQuote() in brokerquote.ts. */
  if (ask < bid) {
    return {
      ok: false,
      reason: `${symbol}: the venue returned a crossed book (ask ${ask} below bid ${bid}).`,
    };
  }

  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  const spreadPct = (spread / mid) * 100;

  if (spreadPct > ABSURD_SPREAD_PCT) {
    return {
      ok: false,
      reason: `${symbol}: top of book is ${spreadPct.toFixed(2)}% wide. That is a broken or empty book, not a spread — nothing is being checked against it.`,
    };
  }

  /* Decimals INFERRED from the quote rather than requested from exchangeInfo.
     The alternative is a second request per symbol for a number used only to
     format a string, and the quote already carries the venue's own precision
     in the text it sent. */
  const digits = decimalsOf(String(body.bidPrice ?? ""), String(body.askPrice ?? ""));

  const usableDepth =
    Number.isFinite(bidQty) && Number.isFinite(askQty) && bidQty > 0 && askQty > 0;

  return {
    ok: true,
    symbol: typeof body.symbol === "string" && body.symbol.length > 0 ? body.symbol : symbol,
    bid,
    ask,
    spread,
    spreadPct,
    digits,
    asOf: now,
    ...(usableDepth ? { depth: { bidQty, askQty } } : {}),
  };
}

/**
 * The live top of book for one pair.
 *
 * Weight 2 on the venue's budget for a single symbol — the cheapest question
 * you can ask that has a real answer. Cached for two seconds because several
 * panels want the same quote in the same second, and the cache is what stops
 * that being several requests.
 */
export async function loadBookTicker(
  symbol: string,
  now: () => number = Date.now,
  base = API,
): Promise<BookQuote> {
  const sym = symbol.toUpperCase();
  const url = new URL(`${base}/api/v3/ticker/bookTicker`);
  url.searchParams.set("symbol", sym);

  let body: BookTickerBody;
  try {
    body = await fetchJson<BookTickerBody>(url.toString(), {
      /* Background: the cost of entering must never outrank the chart the
         operator is waiting for. */
      priority: "background",
      ttlMs: 2_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `The venue did not answer for ${sym}: ${err.message}`
          : `The venue did not answer for ${sym}.`,
    };
  }

  return shapeBook(body, sym, now());
}
