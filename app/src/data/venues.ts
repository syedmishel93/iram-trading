/**
 * Extra venues: Coinbase, Bybit and OKX.
 *
 * WHY MORE SOURCES IS NOT JUST MORE SOURCES
 * Until now a crypto chart came from Binance or it came from nowhere. That is
 * one venue's opinion, one venue's outage, and one venue's rate limit standing
 * between you and a price. Three things change with a real failover chain:
 *
 * 1. A 418 stops being fatal. The governor parks Binance for the duration of a
 *    ban — correctly, because probing extends it — and until now that meant no
 *    chart for hours. Now the registry moves on.
 * 2. USD becomes available. Binance quotes USDT, which is a token with its own
 *    credit risk and its own basis. Coinbase quotes actual dollars. Those are
 *    different prices and the difference is occasionally the whole story.
 * 3. Depth outside one book. A wick that exists on one venue and nowhere else
 *    is a liquidation cascade in a thin book, not a market event. You cannot
 *    tell the difference from inside a single feed.
 *
 * THE HARD PART IS THE SYMBOL, NOT THE REQUEST
 * Every venue spells the same instrument differently — BTCUSDT, BTC-USD,
 * BTC-USDT — and quotes it against a different asset. `splitPair` does that
 * once, and each source maps from the split rather than from a table of
 * hand-written special cases that would be wrong the day a new pair listed.
 *
 * EVERY REQUEST GOES THROUGH THE GOVERNOR, and every new host gets its own
 * policy in core/kernel.ts. A source added without a budget is a source that
 * eventually earns a ban on a host nobody was watching.
 */

import { governor } from "./net";
import type { BarView } from "../chart/series";
import type { DataSource, LoadOptions } from "./sources";

/** Quote assets, longest first so USDT is matched before USD. */
const QUOTES = [
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "USD",
  "EUR",
  "GBP",
  "BTC",
  "ETH",
  "BNB",
  "DAI",
];

/**
 * Quotes that make a pair a CRYPTO pair.
 *
 * Deliberately excludes bare "USD": EURUSD, XAUUSD and GBPUSD all end in it and
 * none of them is crypto. This lives here, next to `splitPair`, because the two
 * were previously separate lists in separate files and a symbol classified one
 * way by one and another way by the other is how a forex request ends up at a
 * crypto exchange. It is re-exported from sources.ts so existing callers are
 * unaffected.
 */
const CRYPTO_QUOTES = ["USDT", "USDC", "BUSD", "BTC", "ETH", "FDUSD"];

/** Heuristic, but a declared one: crypto pairs end in a known quote asset. */
export function looksCrypto(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return CRYPTO_QUOTES.some((q) => s.endsWith(q) && s.length > q.length);
}

export interface Pair {
  readonly base: string;
  readonly quote: string;
}

/**
 * Split a concatenated symbol into base and quote.
 *
 * Longest-first matching matters: "BTCUSDT" ends with both "USDT" and "USD",
 * and choosing the shorter leaves a base of "BTCT".
 */
export function splitPair(symbol: string): Pair | null {
  const s = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  for (const q of QUOTES) {
    if (s.length > q.length && s.endsWith(q)) {
      return { base: s.slice(0, s.length - q.length), quote: q };
    }
  }
  return null;
}

/**
 * Map a quote asset to the one a venue actually lists.
 *
 * Coinbase has no USDT book for most assets but does have USD. Treating a
 * stablecoin quote as USD is an APPROXIMATION and it is declared as one: the
 * source's `quality` stays "live" because the price is real, but the returned
 * series is a different instrument from the USDT book, and the basis between
 * them is exactly the thing that is worth looking at rather than papering over.
 */
function coinbaseQuote(quote: string): string {
  if (quote === "USDT" || quote === "USDC" || quote === "BUSD" || quote === "FDUSD" || quote === "TUSD") {
    return "USD";
  }
  return quote;
}

const toNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** A bar is only usable if every field parsed and the OHLC is coherent. */
function usable(b: BarView): boolean {
  return (
    Number.isFinite(b.t) &&
    Number.isFinite(b.o) &&
    Number.isFinite(b.h) &&
    Number.isFinite(b.l) &&
    Number.isFinite(b.c) &&
    b.h >= b.l &&
    b.o > 0 &&
    b.c > 0
  );
}

/* --------------------------------------------------------------- Coinbase -- */

/** Coinbase takes a granularity in SECONDS, and only these six. */
const COINBASE_GRANULARITY: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

export function coinbaseSource(): DataSource {
  return {
    id: "coinbase",
    label: "Coinbase",
    /* After Binance (0) and your own broker (1). Binance is deeper on most
       pairs and its cache is already warm; Coinbase is the failover and the
       USD reference. */
    priority: 2,
    quality: "live",
    covers: "crypto spot, quoted in USD",

    /* Crypto only. `splitPair` alone would accept EURUSD — a real pair, and
       one Coinbase has no book for. */
    supports: looksCrypto,

    async loadBars(symbol, timeframe, opts: LoadOptions) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("coinbase: unrecognised pair");
      const granularity = COINBASE_GRANULARITY[timeframe];
      /* 4h and 1w have no Coinbase granularity. Saying so beats returning a
         6h series under a 4h label, which nothing downstream could detect. */
      if (granularity === undefined) {
        throw new Error(`coinbase: no ${timeframe} granularity (it offers 1m, 5m, 15m, 1h, 6h, 1d)`);
      }

      const product = `${pair.base}-${coinbaseQuote(pair.quote)}`;
      const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
      url.searchParams.set("granularity", String(granularity));

      const res = await governor.request({
        url: url.toString(),
        priority: "normal",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 429) throw new Error("rate limited");
      if (res.status === 404) throw new Error(`coinbase: no ${product} book`);
      if (!res.ok) throw new Error(`coinbase ${res.status}`);

      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error("coinbase: unexpected payload");

      /* [time, low, high, open, close, volume], time in SECONDS, NEWEST FIRST.
         Both of those differ from every other venue here and both would pass
         silently: a seconds timestamp lands in 1970 and a reversed series
         renders as a mirror image of the market. */
      const bars = raw
        .map((row) => {
          const k = row as [number, number, number, number, number, number];
          return {
            t: toNum(k[0]) * 1000,
            o: toNum(k[3]),
            h: toNum(k[2]),
            l: toNum(k[1]),
            c: toNum(k[4]),
            v: toNum(k[5]),
          };
        })
        .filter(usable)
        .sort((a, b) => a.t - b.t);

      const limit = opts.limit ?? 800;
      return bars.slice(-limit);
    },
  };
}

/* ------------------------------------------------------------------ Bybit -- */

/** Bybit intervals: minutes as digits, then D / W / M. */
const BYBIT_INTERVAL: Record<string, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
  "1w": "W",
};

export function bybitSource(): DataSource {
  return {
    id: "bybit",
    label: "Bybit",
    priority: 3,
    quality: "live",
    covers: "crypto spot",

    supports: looksCrypto,

    async loadBars(symbol, timeframe, opts: LoadOptions) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("bybit: unrecognised pair");
      const interval = BYBIT_INTERVAL[timeframe];
      if (interval === undefined) throw new Error(`bybit: no ${timeframe} interval`);

      const url = new URL("https://api.bybit.com/v5/market/kline");
      url.searchParams.set("category", "spot");
      url.searchParams.set("symbol", `${pair.base}${pair.quote}`);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", String(Math.min(opts.limit ?? 800, 1000)));

      const res = await governor.request({
        url: url.toString(),
        priority: "normal",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 429) throw new Error("rate limited");
      if (!res.ok) throw new Error(`bybit ${res.status}`);

      const json = (await res.json()) as Record<string, unknown>;
      /* Bybit answers 200 with an error CODE in the body. Trusting the HTTP
         status would turn "symbol not found" into an empty chart with no
         explanation anywhere. */
      if (toNum(json["retCode"]) !== 0) {
        throw new Error(`bybit: ${String(json["retMsg"] ?? "declined")}`);
      }
      const result = json["result"] as Record<string, unknown> | undefined;
      const list = result?.["list"];
      if (!Array.isArray(list)) throw new Error("bybit: unexpected payload");

      /* [start, open, high, low, close, volume, turnover] as STRINGS,
         newest first. */
      return list
        .map((row) => {
          const k = row as string[];
          return {
            t: toNum(k[0]),
            o: toNum(k[1]),
            h: toNum(k[2]),
            l: toNum(k[3]),
            c: toNum(k[4]),
            v: toNum(k[5]),
          };
        })
        .filter(usable)
        .sort((a, b) => a.t - b.t);
    },
  };
}

/* -------------------------------------------------------------------- OKX -- */

const OKX_BAR: Record<string, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "2h": "2H",
  "4h": "4H",
  "6h": "6H",
  "12h": "12H",
  "1d": "1D",
  "1w": "1W",
};

export function okxSource(): DataSource {
  return {
    id: "okx",
    label: "OKX",
    priority: 4,
    quality: "live",
    covers: "crypto spot",

    supports: looksCrypto,

    async loadBars(symbol, timeframe, opts: LoadOptions) {
      const pair = splitPair(symbol);
      if (!pair) throw new Error("okx: unrecognised pair");
      const bar = OKX_BAR[timeframe];
      if (bar === undefined) throw new Error(`okx: no ${timeframe} bar`);

      const url = new URL("https://www.okx.com/api/v5/market/candles");
      url.searchParams.set("instId", `${pair.base}-${pair.quote}`);
      url.searchParams.set("bar", bar);
      url.searchParams.set("limit", String(Math.min(opts.limit ?? 300, 300)));

      const res = await governor.request({
        url: url.toString(),
        priority: "normal",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 429) throw new Error("rate limited");
      if (!res.ok) throw new Error(`okx ${res.status}`);

      const json = (await res.json()) as Record<string, unknown>;
      if (String(json["code"] ?? "0") !== "0") {
        throw new Error(`okx: ${String(json["msg"] ?? "declined")}`);
      }
      const data = json["data"];
      if (!Array.isArray(data)) throw new Error("okx: unexpected payload");

      /* [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] as strings, newest
         first. `confirm` is "1" for a CLOSED bar — the forming one is dropped,
         because a partial candle presented as closed is what the detectors
         explicitly refuse to reason about. */
      return data
        .map((row) => {
          const k = row as string[];
          return {
            t: toNum(k[0]),
            o: toNum(k[1]),
            h: toNum(k[2]),
            l: toNum(k[3]),
            c: toNum(k[4]),
            v: toNum(k[5]),
            confirmed: k[8] !== "0",
          };
        })
        .filter((b) => b.confirmed && usable(b))
        .map(({ confirmed: _confirmed, ...bar2 }) => bar2)
        .sort((a, b) => a.t - b.t);
    },
  };
}
