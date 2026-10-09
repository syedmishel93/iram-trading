/**
 * Fundamentals — the numbers a chart cannot show you.
 *
 * A candle tells you what price did. It cannot tell you that the float is 6% of
 * the eventual supply, that a fifth of the market cap unlocks over eighteen
 * months, or that the entire capitalisation is smaller than one day of another
 * asset's volume. Those are the facts that decide whether a chart pattern is
 * worth anything, and none of them are in the OHLCV.
 *
 * WHAT IS HERE AND WHY THESE FIGURES
 * Not a wall of statistics. Six things that change a decision:
 *
 *  - MARKET CAP AND RANK. Scale. A pattern on a $40bn asset and the identical
 *    pattern on a $4m asset are not the same trade.
 *  - FLOAT: circulating over max supply. The single most under-read number in
 *    crypto. A token with 6% of its supply issued is a token whose chart is
 *    made of a fraction of what will eventually exist.
 *  - DILUTION: fully-diluted valuation over market cap. The multiple the price
 *    must survive if everything unissued arrives. FDV/MC of 15 means the
 *    remaining supply is fourteen times what is trading today.
 *  - TURNOVER: 24h volume over market cap. Whether anyone is actually there.
 *  - DRAWDOWN FROM ALL-TIME HIGH, with the date. Context a 90-day chart hides.
 *  - CHANGE OVER 24h, 7d AND 30d, so the timeframe you are on is placed inside
 *    the ones you are not.
 *
 * WHERE IT COMES FROM, AND WHAT THAT IS WORTH
 * CoinGecko's public API — free, no key. It is an AGGREGATOR: the prices are
 * volume-weighted across venues and, critically, CIRCULATING SUPPLY IS
 * SELF-REPORTED BY PROJECTS and is the least reliable field in the payload.
 * Every derived figure below inherits that, and the panel says so rather than
 * presenting a computed float as if it were measured. A number whose provenance
 * you cannot see is a number you should not size against.
 *
 * ONE REQUEST, CACHED FOR AN HOUR. The markets endpoint returns 250 assets with
 * every field above in a single call, so a whole session costs one request.
 * Fundamentals move on the timescale of a funding round, not a candle.
 */

import { signal, type Signal } from "../core/signal";
import { governor } from "./net";
import { splitPair } from "./venues";
import type { KV } from "../store/kv";

export interface Fundamentals {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly rank: number;
  readonly price: number;
  readonly marketCap: number;
  readonly fullyDiluted: number;
  readonly volume24h: number;
  readonly circulating: number;
  readonly total: number;
  /** Null when the asset has no cap — which is itself the answer. */
  readonly maxSupply: number | null;
  readonly ath: number;
  readonly athDate: string;
  readonly athChangePct: number;
  readonly change24h: number;
  readonly change7d: number;
  readonly change30d: number;
  readonly updatedAt: string;
}

/** Assets fetched. 250 is the endpoint's page limit and covers what is traded. */
const PAGE_SIZE = 250;

/** Fundamentals move on the timescale of a funding round, not a candle. */
export const FUNDAMENTALS_TTL_MS = 60 * 60 * 1000;

export const FUNDAMENTALS_SLOT = {
  key: "fundamentals.markets",
  version: 1,
  fallback: (): { at: number; rows: Fundamentals[] } => ({ at: 0, rows: [] }),
  validate: (v: unknown): { at: number; rows: Fundamentals[] } | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o["at"] !== "number" || !Array.isArray(o["rows"])) return null;
    return { at: o["at"], rows: o["rows"] as Fundamentals[] };
  },
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Null, not zero. An uncapped supply is a fact; zero would be a lie. */
const nullableNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface DerivedFundamentals {
  /** Circulating / max supply, 0..1. Null when there is no max. */
  readonly float: number | null;
  /** FDV / market cap. 1 means everything is already issued. */
  readonly dilution: number | null;
  /** 24h volume / market cap. */
  readonly turnover: number;
  /** How far below the all-time high, as a positive percent. */
  readonly belowAth: number;
  /** Plain-language notes, each one earned by a number above. */
  readonly notes: readonly string[];
}

/**
 * The figures worth deriving, and the sentences they earn.
 *
 * Each note fires on a threshold that is defensible rather than tuned: a float
 * under a fifth, a dilution multiple over three, a turnover under 1%. They
 * describe the number; they do not tell you what to do about it.
 */
export function derive(f: Fundamentals): DerivedFundamentals {
  const notes: string[] = [];

  const float = f.maxSupply !== null && f.maxSupply > 0 ? f.circulating / f.maxSupply : null;
  const dilution = f.marketCap > 0 && f.fullyDiluted > 0 ? f.fullyDiluted / f.marketCap : null;
  const turnover = f.marketCap > 0 ? f.volume24h / f.marketCap : 0;
  const belowAth = Math.max(0, -f.athChangePct);

  if (float !== null && float < 0.2) {
    notes.push(
      `Only ${(float * 100).toFixed(1)}% of the maximum supply is circulating. The chart is made of a small fraction of what will eventually exist.`,
    );
  }
  if (f.maxSupply === null) {
    notes.push(
      "No maximum supply. Issuance is uncapped, so a fully-diluted figure has no ceiling to be measured against.",
    );
  }
  if (dilution !== null && dilution > 3) {
    notes.push(
      `Fully-diluted valuation is ${dilution.toFixed(1)}× the market cap. The unissued supply is ${(dilution - 1).toFixed(1)}× everything trading today.`,
    );
  }
  if (turnover > 0 && turnover < 0.01) {
    notes.push(
      `24-hour volume is ${(turnover * 100).toFixed(2)}% of market cap. Thin: a position of any size is a large share of a day's trade.`,
    );
  }
  if (turnover > 1) {
    notes.push(
      `24-hour volume exceeds the entire market cap (${turnover.toFixed(1)}×). That is either a genuine event or wash trading, and this figure cannot tell you which.`,
    );
  }
  if (belowAth > 90) {
    notes.push(
      `${belowAth.toFixed(0)}% below its all-time high of ${f.ath.toLocaleString()} (${f.athDate.slice(0, 10)}). Recovering that high is a ${(100 / (100 - belowAth)).toFixed(1)}× move.`,
    );
  }

  return { float, dilution, turnover, belowAth, notes };
}

export interface FundamentalsService {
  readonly rows: Signal<readonly Fundamentals[]>;
  readonly loading: Signal<boolean>;
  readonly note: Signal<string>;
  /** Fetch if the cache is stale. One request in flight at a time, ever. */
  ensure(): void;
  refresh(): void;
  /** Look up by trading symbol, e.g. "BTCUSDT" or "ETHUSD". Null if unknown. */
  find(symbol: string): Fundamentals | null;
}

/**
 * Resolve a trading pair to a base asset ticker.
 *
 * `splitPair` already knows every quote asset the terminal understands, so this
 * reuses it rather than growing a second, subtly different list.
 */
export function baseOf(symbol: string): string {
  const pair = splitPair(symbol);
  if (pair) return pair.base;
  return symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export async function loadMarkets(signalObj?: AbortSignal): Promise<Fundamentals[]> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", "1");
  url.searchParams.set("price_change_percentage", "24h,7d,30d");

  const res = await governor.request({
    url: url.toString(),
    priority: "background",
    ...(signalObj ? { signal: signalObj } : {}),
  });
  if (res.status === 429) throw new Error("CoinGecko rate limit — it allows only a few calls a minute on the free tier");
  if (!res.ok) throw new Error(`coingecko ${res.status}`);

  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error("coingecko: unexpected payload");

  const out: Fundamentals[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown>;
    const symbol = str(r["symbol"]).toUpperCase();
    if (symbol.length === 0) continue;
    out.push({
      id: str(r["id"]),
      symbol,
      name: str(r["name"]),
      rank: num(r["market_cap_rank"]),
      price: num(r["current_price"]),
      marketCap: num(r["market_cap"]),
      fullyDiluted: num(r["fully_diluted_valuation"]),
      volume24h: num(r["total_volume"]),
      circulating: num(r["circulating_supply"]),
      total: num(r["total_supply"]),
      maxSupply: nullableNum(r["max_supply"]),
      ath: num(r["ath"]),
      athDate: str(r["ath_date"]),
      athChangePct: num(r["ath_change_percentage"]),
      change24h: num(r["price_change_percentage_24h_in_currency"]),
      change7d: num(r["price_change_percentage_7d_in_currency"]),
      change30d: num(r["price_change_percentage_30d_in_currency"]),
      updatedAt: str(r["last_updated"]),
    });
  }
  return out;
}

export function createFundamentals(kv: KV, load = loadMarkets): FundamentalsService {
  const cached = kv.read(FUNDAMENTALS_SLOT).value;
  const rows = signal<readonly Fundamentals[]>(cached.rows);
  const loading = signal(false);
  const note = signal(
    cached.rows.length > 0
      ? `${cached.rows.length} assets, cached`
      : "Not loaded yet.",
  );

  let inflight: Promise<void> | null = null;

  const fetchNow = (): Promise<void> => {
    if (inflight) return inflight;
    loading.set(true);
    inflight = load()
      .then((next) => {
        if (next.length === 0) {
          note.set("The aggregator returned no assets; keeping the previous list.");
          return;
        }
        rows.set(next);
        note.set(`${next.length} assets by market cap, from CoinGecko`);
        const res = kv.write(FUNDAMENTALS_SLOT, { at: Date.now(), rows: next });
        if (!res.ok) console.warn(`[iram] fundamentals not cached — ${res.error}`);
      })
      .catch((err: unknown) => {
        /* Losing fundamentals costs a panel, never the chart. */
        note.set(
          `Fundamentals unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        loading.set(false);
        inflight = null;
      });
    return inflight;
  };

  return {
    rows,
    loading,
    note,

    ensure() {
      if (cached.rows.length > 0 && Date.now() - cached.at < FUNDAMENTALS_TTL_MS) return;
      void fetchNow();
    },

    refresh() {
      void fetchNow();
    },

    find(symbol) {
      const base = baseOf(symbol);
      const list = rows.peek();
      /**
       * Ticker collisions are real and this resolves them by market cap, which
       * is the only signal available: several assets list as "UNI" and only one
       * is the one anybody means. Rank ascending puts it first because the rows
       * arrive market-cap ordered.
       */
      for (const row of list) {
        if (row.symbol === base) return row;
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------- formatting -- */

export function fmtCap(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function fmtSupply(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(2);
}
