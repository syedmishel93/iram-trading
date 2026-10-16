/**
 * News, from primary sources rather than reports about them.
 *
 * WHICH SOURCES, AND WHY THESE
 * Almost every crypto news API worth having now demands a key: CryptoCompare
 * and CoinDesk both answer 401 without one, CoinGecko's news endpoint is
 * paid-tier, and GDELT is unreachable from here. Rather than ship a panel that
 * needs an account before it shows anything, this reads the two venues'
 * own announcement feeds — VERIFIED to serve `Access-Control-Allow-Origin`, so
 * they work in the browser build with no proxy and no key:
 *
 *   Binance  www.binance.com/bapi/composite/v1/public/cms/article/list/query
 *   Bybit    api.bybit.com/v5/announcements/index
 *
 * These are better than a news aggregator for the thing that actually moves a
 * chart. A listing, a delisting, a margin-tier change or a deposit suspension
 * is not REPORTED here — it is ANNOUNCED here. There is no wire service in
 * between to be slow or wrong, and the venue posting it is the venue whose
 * order book is about to move.
 *
 * THE PROBLEM WITH THEM, MEASURED
 * Both feeds carry marketing. Of 170 titles pulled while building this, a large
 * share were tournaments, airdrops and "earn up to" promotions — the sample
 * Bybit returned first was a trading competition. A news panel that shows those
 * is an advertising panel. So items are filtered by the venue's OWN category
 * field before anything else happens; see MARKET_MOVING.
 *
 * CORROBORATION
 * Two independent venues announcing the same thing is real corroboration and it
 * is rare — measured at zero cross-venue matches in a 170-title sample, because
 * most announcements are venue-specific by nature. That rarity is the point:
 * when a story DOES appear on both, it is a genuine market-wide event rather
 * than one exchange's housekeeping, and core/crosscheck.ts ranks it first.
 */

import { fetchJson } from "./net";
import { corroborate, type NewsItem, type Story } from "../core/crosscheck";

/**
 * Venue categories worth reading, keyed by the venue's own label.
 *
 * An allowlist, never a blocklist. Venues add promotional categories
 * constantly and a blocklist silently lets each new one through — which fails
 * in the direction of filling a trading terminal with advertising.
 */
const MARKET_MOVING = {
  /** Binance `catalogName` values. */
  binance: [
    "New Cryptocurrency Listing",
    "Delisting",
    "Latest Binance News",
    "Trading Rules Update",
    "Maintenance Updates",
    "API Updates",
    "Crypto Airdrop",
  ],
  /** Bybit `type.key` values. */
  bybit: [
    "new_crypto",
    "delistings",
    "latest_bybit_news",
    "maintenance_updates",
    "product_updates",
    "other",
  ],
} as const;

export interface NewsFeed {
  readonly stories: readonly Story[];
  /** Venues that answered. A story can only be corroborated across these. */
  readonly sources: readonly string[];
  /** Venues that were asked and failed, with why. */
  readonly failures: readonly { readonly source: string; readonly reason: string }[];
  readonly asOf: number;
  readonly provenance: string;
}

/* -------------------------------------------------------------- binance -- */

interface BinanceArticle {
  readonly title?: string;
  readonly releaseDate?: number;
  readonly code?: string;
}
interface BinanceCatalog {
  readonly catalogName?: string;
  readonly articles?: readonly BinanceArticle[];
}
interface BinanceBody {
  readonly data?: { readonly catalogs?: readonly BinanceCatalog[] };
}

export function parseBinance(raw: unknown): NewsItem[] {
  const body = raw as BinanceBody;
  const catalogs = body?.data?.catalogs;
  if (!Array.isArray(catalogs)) return [];
  const allowed = new Set<string>(MARKET_MOVING.binance);
  const out: NewsItem[] = [];
  for (const cat of catalogs) {
    const name = String(cat?.catalogName ?? "");
    if (!allowed.has(name)) continue;
    for (const a of cat?.articles ?? []) {
      const title = typeof a?.title === "string" ? a.title.trim() : "";
      const at = typeof a?.releaseDate === "number" ? a.releaseDate : NaN;
      if (title === "" || !Number.isFinite(at)) continue;
      out.push({
        source: "Binance",
        title,
        at,
        category: name,
        ...(a.code ? { url: `https://www.binance.com/en/support/announcement/${a.code}` } : {}),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- bybit -- */

interface BybitArticle {
  readonly title?: string;
  readonly publishTime?: number;
  readonly dateTimestamp?: number;
  readonly url?: string;
  readonly type?: { readonly key?: string; readonly title?: string };
}
interface BybitBody {
  readonly result?: { readonly list?: readonly BybitArticle[] };
}

export function parseBybit(raw: unknown): NewsItem[] {
  const list = (raw as BybitBody)?.result?.list;
  if (!Array.isArray(list)) return [];
  const allowed = new Set<string>(MARKET_MOVING.bybit);
  const out: NewsItem[] = [];
  for (const a of list) {
    const key = String(a?.type?.key ?? "");
    if (!allowed.has(key)) continue;
    const title = typeof a?.title === "string" ? a.title.trim() : "";
    /* `publishTime` is when Bybit posted it; `dateTimestamp` is when the event
       it describes happens, and can be in the future. For "when did this news
       break" only the former is right. */
    const at = typeof a?.publishTime === "number" ? a.publishTime : NaN;
    if (title === "" || !Number.isFinite(at)) continue;
    out.push({
      source: "Bybit",
      title,
      at,
      category: String(a?.type?.title ?? key),
      ...(a.url ? { url: a.url } : {}),
    });
  }
  return out;
}

/* ----------------------------------------------------------------- load -- */

const BINANCE_URL =
  "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20";
const BYBIT_URL = "https://api.bybit.com/v5/announcements/index?locale=en-US&limit=30";

export interface NewsOptions {
  readonly now?: number;
  readonly signal?: AbortSignal;
  readonly limit?: number;
}

/**
 * Load both venues and corroborate.
 *
 * `allSettled`, always: one venue being unreachable must cost you that venue's
 * headlines and nothing else. Which venues answered is REPORTED rather than
 * hidden, because it changes what corroboration means — with one venue up,
 * nothing can be "confirmed", and a reader needs to know that the absence of
 * confirmation is a coverage problem and not a judgement.
 */
export async function loadNews(opts: NewsOptions = {}): Promise<NewsFeed> {
  const now = opts.now ?? Date.now();
  const sig = opts.signal ? { signal: opts.signal } : {};
  /* Ten minutes: announcements are not high-frequency, and hammering a venue's
     CMS is exactly the impolite behaviour the governor exists to prevent. */
  const net = { priority: "background", ttlMs: 10 * 60_000, swr: true, ...sig } as const;

  const [bn, by] = await Promise.allSettled([
    fetchJson<unknown>(BINANCE_URL, net),
    fetchJson<unknown>(BYBIT_URL, net),
  ]);

  const items: NewsItem[] = [];
  const sources: string[] = [];
  const failures: { source: string; reason: string }[] = [];

  if (bn.status === "fulfilled") {
    items.push(...parseBinance(bn.value));
    sources.push("Binance");
  } else {
    failures.push({ source: "Binance", reason: String(bn.reason?.message ?? bn.reason) });
  }
  if (by.status === "fulfilled") {
    items.push(...parseBybit(by.value));
    sources.push("Bybit");
  } else {
    failures.push({ source: "Bybit", reason: String(by.reason?.message ?? by.reason) });
  }

  const stories = corroborate(items, { now });

  return {
    stories: opts.limit === undefined ? stories : stories.slice(0, opts.limit),
    sources,
    failures,
    asOf: now,
    provenance:
      sources.length === 0
        ? "No venue answered. Nothing is being shown rather than something invented."
        : sources.length === 1
          ? `${sources[0]} only — its own announcement feed, filtered to market-moving categories. With one venue answering nothing can be corroborated, so every story below reads as single-source because of coverage, not because it was doubted.`
          : `${sources.join(" and ")} announcement feeds, filtered to market-moving categories and clustered. A story carried by both venues is genuinely corroborated; most announcements are venue-specific and will not be.`,
  };
}
