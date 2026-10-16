/**
 * Cross-venue pricing: the same instrument, priced by four books.
 *
 * WHY THIS IS WORTH A REQUEST
 * A single feed cannot tell you whether what you are looking at is the market
 * or the venue. Three things only become visible with more than one book:
 *
 *  - A WICK THAT EXISTS IN ONE PLACE is a thin-book liquidation, not a move.
 *    From inside one feed it is indistinguishable from a real event, and it is
 *    the single most common thing people trade by mistake.
 *  - STABLECOIN DRIFT. Binance quotes USDT and Coinbase quotes dollars. When
 *    those diverge, the "price" you are watching has moved for a reason that
 *    has nothing to do with the asset.
 *  - A VENUE FALLING BEHIND. One book quoting a stale price while the others
 *    move is a venue problem, and it is the one moment a chart from that venue
 *    is actively misleading.
 *
 * WHAT IT DOES NOT CLAIM
 * A spread is not an arbitrage. By the time it is on your screen it has fees,
 * withdrawal times and transfer risk in front of it, and the panel says so
 * rather than displaying a percentage that looks like free money. Its job is to
 * tell you the number is unusual, not what to do about it.
 */

import { governor } from "./net";
import { splitPair, looksCrypto } from "./venues";

export interface VenueQuote {
  readonly venue: string;
  readonly price: number;
  /** When the venue reported it. 0 when the venue does not say. */
  readonly asOf: number;
}

export interface SpreadRead {
  readonly ok: boolean;
  readonly reason?: string;
  readonly quotes: readonly VenueQuote[];
  /** Median of the venues that answered — more robust than a mean of four. */
  readonly reference: number;
  /** Widest gap between any two venues, as a percent of the reference. */
  readonly spreadPct: number;
  /** The two venues at the extremes, for the caption. */
  readonly high: string;
  readonly low: string;
  /** Set when the spread is wider than a venue difference should be. */
  readonly note: string;
}

/**
 * Above this, the gap is worth a sentence.
 *
 * 0.25% is several times a normal cross-venue basis on a liquid pair and is
 * comfortably inside the round-trip cost of acting on it, which is exactly why
 * the note describes rather than suggests.
 */
export const WIDE_SPREAD_PCT = 0.25;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

/** Median, not mean: one stale venue should not drag the reference. */
export function median(values: readonly number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Compute the read from whatever answered. Pure, so it is testable alone. */
export function readSpread(quotes: readonly VenueQuote[]): SpreadRead {
  const usable = quotes.filter((q) => Number.isFinite(q.price) && q.price > 0);

  if (usable.length < 2) {
    return {
      ok: false,
      reason:
        usable.length === 0
          ? "No venue answered."
          : `Only ${usable[0]?.venue} answered. A spread needs at least two books.`,
      quotes: usable,
      reference: usable[0]?.price ?? NaN,
      spreadPct: 0,
      high: "",
      low: "",
      note: "",
    };
  }

  const reference = median(usable.map((q) => q.price));
  const sorted = usable.slice().sort((a, b) => a.price - b.price);
  const low = sorted[0] as VenueQuote;
  const high = sorted[sorted.length - 1] as VenueQuote;
  const spreadPct = reference > 0 ? ((high.price - low.price) / reference) * 100 : 0;

  const note =
    spreadPct >= WIDE_SPREAD_PCT
      ? `${high.venue} is ${spreadPct.toFixed(3)}% above ${low.venue}. That is wide for a cross-venue basis — usually a thin book, a stablecoin drifting, or one venue lagging. It is NOT free money: fees, withdrawal time and transfer risk all sit in front of it.`
      : "";

  return {
    ok: true,
    quotes: usable,
    reference,
    spreadPct,
    high: high.venue,
    low: low.venue,
    note,
  };
}

interface VenueTicker {
  readonly venue: string;
  fetch(symbol: string, signal?: AbortSignal): Promise<VenueQuote>;
}

const TICKERS: readonly VenueTicker[] = [
  {
    venue: "Binance",
    async fetch(symbol, signal) {
      const pair = splitPair(symbol);
      const url = new URL("https://api.binance.com/api/v3/ticker/price");
      url.searchParams.set("symbol", pair ? `${pair.base}${pair.quote}` : symbol);
      const res = await governor.request({
        url: url.toString(),
        priority: "background",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      return { venue: "Binance", price: num(j["price"]), asOf: Date.now() };
    },
  },
  {
    venue: "Coinbase",
    async fetch(symbol, signal) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("unrecognised pair");
      /* Coinbase quotes dollars, not USDT — which is the interesting half of
         this comparison rather than an inconvenience to normalise away. */
      const quote = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD"].includes(pair.quote) ? "USD" : pair.quote;
      const res = await governor.request({
        url: `https://api.exchange.coinbase.com/products/${pair.base}-${quote}/ticker`,
        priority: "background",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`coinbase ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      return { venue: "Coinbase", price: num(j["price"]), asOf: Date.parse(String(j["time"] ?? "")) || Date.now() };
    },
  },
  {
    venue: "Bybit",
    async fetch(symbol, signal) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("unrecognised pair");
      const url = new URL("https://api.bybit.com/v5/market/tickers");
      url.searchParams.set("category", "spot");
      url.searchParams.set("symbol", `${pair.base}${pair.quote}`);
      const res = await governor.request({
        url: url.toString(),
        priority: "background",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`bybit ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      if (Number(j["retCode"]) !== 0) throw new Error(String(j["retMsg"] ?? "declined"));
      const list = (j["result"] as Record<string, unknown> | undefined)?.["list"];
      const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
      if (!first) throw new Error("no ticker");
      return { venue: "Bybit", price: num(first["lastPrice"]), asOf: Date.now() };
    },
  },
  {
    venue: "OKX",
    async fetch(symbol, signal) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("unrecognised pair");
      const url = new URL("https://www.okx.com/api/v5/market/ticker");
      url.searchParams.set("instId", `${pair.base}-${pair.quote}`);
      const res = await governor.request({
        url: url.toString(),
        priority: "background",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`okx ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      if (String(j["code"] ?? "0") !== "0") throw new Error(String(j["msg"] ?? "declined"));
      const first = Array.isArray(j["data"]) ? (j["data"][0] as Record<string, unknown> | undefined) : undefined;
      if (!first) throw new Error("no ticker");
      return { venue: "OKX", price: num(first["last"]), asOf: num(first["ts"]) || Date.now() };
    },
  },
];

/**
 * Ask every venue at once and read whatever comes back.
 *
 * `allSettled`, not `all`: one venue being down is the normal case and must not
 * cost the comparison. Two answers is enough for a spread, and the read says
 * how many it had.
 */
export async function loadSpread(symbol: string, signal?: AbortSignal): Promise<SpreadRead> {
  if (!looksCrypto(symbol)) {
    return {
      ok: false,
      reason: `Cross-venue pricing covers crypto pairs. ${symbol} is quoted by one source here, so there is nothing to compare it against.`,
      quotes: [],
      reference: NaN,
      spreadPct: 0,
      high: "",
      low: "",
      note: "",
    };
  }

  const settled = await Promise.allSettled(TICKERS.map((t) => t.fetch(symbol, signal)));
  const quotes: VenueQuote[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && Number.isFinite(r.value.price)) quotes.push(r.value);
  }
  return readSpread(quotes);
}
