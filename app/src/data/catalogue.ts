/**
 * The symbol catalogue — everything you can actually type.
 *
 * The palette shipped with a hard-coded list of thirteen symbols, which is the
 * failure mode of every built-in picker: it is exactly as good as whoever wrote
 * it guessed, and the instrument you want is the one they forgot. Meanwhile the
 * screener was already fetching the whole live Binance universe — several
 * thousand pairs with their 24-hour volume — and throwing it away afterwards.
 *
 * This holds on to it.
 *
 * WHY IT IS RANKED BY VOLUME AND NOT ALPHABETICALLY
 * Type "BT" and you should get BTCUSDT, not BTCDOWNUSDT. A fuzzy match over
 * four thousand symbols returns dozens of technically-correct rows, and the
 * only ordering that puts the one you meant near the top is liquidity —
 * which the universe payload already carries.
 *
 * WHY IT IS CACHED FOR A DAY
 * The universe call costs weight 40, the single most expensive request the
 * terminal makes. Listings change on the order of days, not minutes, so a
 * fresh fetch per session is generous. The cached copy is used immediately at
 * boot and refreshed in the background if stale, which means the palette is
 * never waiting on the network to answer a keystroke.
 */

import { rank, type Ranked } from "../core/fuzzy";
import { signal, type Signal } from "../core/signal";
import { loadBinanceUniverse } from "./binance";
import { INSTRUMENTS, type AssetClass } from "../risk/instruments";
import type { KV } from "../store/kv";

export interface SymbolEntry {
  readonly symbol: string;
  /** Quote-asset volume over 24h, AS REPORTED. See `quoteTier` for why that
      number cannot be compared across quote currencies. */
  readonly volume: number;
  readonly source: string;
  /** 0 is best. Ranking key; see `quoteTier`. */
  readonly tier: number;
  /**
   * What kind of instrument this is.
   *
   * The tabs used to group by QUOTE CURRENCY — USDT, USDC, BTC, ETH, Other —
   * which is a fact about crypto pairs and a category error for everything
   * else. EURUSD landed under no tab anyone would look in, and USDJPY matched
   * no quote suffix at all and fell into "Other" beside a few thousand
   * altcoins. Five forex instruments were reachable and none was findable,
   * which is exactly what "I cannot see the forex pairs" describes.
   *
   * Class is the split a person actually thinks in, and `risk/instruments.ts`
   * has carried it for the whole instrument table since long before the picker
   * asked.
   */
  readonly cls: AssetClass;
  /** "Gold", "Apple", "Nikkei 225" — searchable, so you need not know the ticker. */
  readonly name?: string;
}

/**
 * How comparable a pair's reported volume is.
 *
 * MEASURED, and it broke the palette: ranking purely by `quoteVolume` put
 * USDTIDRT, BTCBIDR and ETHBIDR at the top of the whole exchange, because that
 * figure is denominated in the QUOTE asset and one rupiah is about 1/16,000 of
 * a dollar. The number was not wrong; comparing it across currencies was.
 *
 * Without a live FX table there is no honest way to convert them, so instead of
 * inventing rates the ranking sorts by quote tier first and volume within the
 * tier. Dollar-quoted pairs are what a terminal like this is used to trade,
 * major-crypto quotes come next, and everything else is reachable by typing it
 * in full but does not get to crowd out BTCUSDT.
 */
const TIER_1 = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USD"];
const TIER_2 = ["BTC", "ETH", "BNB", "EUR"];

export function quoteTier(symbol: string): number {
  for (const q of TIER_1) if (symbol.length > q.length && symbol.endsWith(q)) return 0;
  for (const q of TIER_2) if (symbol.length > q.length && symbol.endsWith(q)) return 1;
  return 2;
}

/**
 * What a pair is quoted IN, for grouping a few thousand of them into tabs.
 *
 * Longest suffix first, which is the whole subtlety: `ETHBTC` ends in "BTC" and
 * `BTCUSDT` ends in "USDT", but `BTCUSDT` also ends in "T" and — less
 * obviously — `USDCUSDT` would answer "USDC" under any rule that tested the
 * shorter suffixes first. Sorting by length makes the answer independent of the
 * order the lists happen to be written in.
 *
 * Returns null for anything that matches nothing, which is honest: FX symbols
 * from the MT5 bridge like `XAUUSD` and `EURUSD` are real instruments this
 * terminal quotes and they belong under "Other", not under an invented group.
 */
const QUOTE_ASSETS = [...TIER_1, ...TIER_2].sort((a, b) => b.length - a.length);

export function quoteAsset(symbol: string): string | null {
  for (const q of QUOTE_ASSETS) {
    if (symbol.length > q.length && symbol.endsWith(q)) return q;
  }
  return null;
}

/**
 * The fallback list.
 *
 * Not a "common symbols" list — a floor. It is what the palette offers before
 * the first fetch lands and if the venue is unreachable, and it deliberately
 * spans crypto, metals and majors so the terminal is usable offline rather than
 * usable-for-crypto offline.
 */
export const SEED_SYMBOLS: readonly string[] = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "XAUUSD",
  "XAGUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
];

/**
 * The tabs, and why they are classes rather than quote currencies.
 *
 * `perp` is deliberately folded into Crypto rather than given a tab of its own:
 * a perpetual is the same asset with a funding leg, and someone looking for
 * BTC wants both listed together. The Risk desk still tells them apart, which
 * is where the difference actually costs money.
 */
export const CLASS_TABS: readonly { id: string; label: string; match: readonly AssetClass[] }[] = [
  { id: "crypto", label: "Crypto", match: ["crypto", "perp"] },
  { id: "forex", label: "Forex", match: ["forex"] },
  { id: "metal", label: "Metals", match: ["metal"] },
  { id: "index", label: "Indices", match: ["index"] },
  { id: "stock", label: "Stocks", match: ["stock"] },
];

const TAB_FOR_CLASS = new Map<AssetClass, string>();
for (const t of CLASS_TABS) for (const c of t.match) TAB_FOR_CLASS.set(c, t.id);

/** Which tab an entry belongs under, or null when no tab claims it. */
export function classTab(cls: AssetClass): string | null {
  return TAB_FOR_CLASS.get(cls) ?? null;
}

/**
 * Every non-Binance instrument the terminal knows how to price.
 *
 * The table in `risk/instruments.ts` has always carried these — 43 forex pairs,
 * metals, indices and equities, each with its pip size and contract size —
 * and the catalogue has never read it. They are given volume 0 because none is
 * known, and tier 0 because within their own class tab they should sort by the
 * curated order of the table rather than behind a few thousand crypto pairs.
 *
 * Crypto entries in that table are SKIPPED: they are USD-settled aliases of
 * pairs the venue already lists (BTCUSD vs BTCUSDT), and adding them would put
 * a second, volume-0 BTC row above the real one on the Crypto tab.
 */
export function instrumentEntries(): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  for (const inst of INSTRUMENTS) {
    if (inst.cls === "crypto" || inst.cls === "perp") continue;
    out.push({
      symbol: inst.symbol,
      volume: 0,
      source: "instruments",
      tier: 0,
      cls: inst.cls,
      name: inst.name,
    });
  }
  return out;
}

/** Listings move on the order of days. A day is generous and still costs one call. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCatalogue {
  readonly at: number;
  readonly entries: readonly SymbolEntry[];
}

export const CATALOGUE_SLOT = {
  key: "catalogue.symbols",
  /* v3: entries gained `cls` and `name`. Discarded rather than migrated, the
     same as v1 -> v2: one cheap refetch, and a cache without classes would
     render every tab empty, which looks exactly like the bug being fixed. */
  version: 3,
  fallback: (): CachedCatalogue => ({ at: 0, entries: [] }),
  validate: (v: unknown): CachedCatalogue | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o["at"] !== "number" || !Array.isArray(o["entries"])) return null;
    const entries: SymbolEntry[] = [];
    for (const raw of o["entries"]) {
      const e = raw as Record<string, unknown>;
      if (typeof e["symbol"] !== "string" || e["symbol"].length === 0) continue;
      if (typeof e["cls"] !== "string") continue;
      entries.push({
        symbol: e["symbol"],
        volume: typeof e["volume"] === "number" ? e["volume"] : 0,
        source: typeof e["source"] === "string" ? e["source"] : "binance",
        tier: typeof e["tier"] === "number" ? e["tier"] : quoteTier(e["symbol"]),
        /* No default. A row without a class came from a build that did not
           have classes, and guessing one is how an FX pair ends up filed under
           Crypto. Dropping the row costs one refetch. */
        cls: e["cls"] as AssetClass,
        ...(typeof e["name"] === "string" ? { name: e["name"] } : {}),
      });
    }
    return { at: o["at"], entries };
  },
};

export interface Catalogue {
  /** Volume-ranked, best first. Seeded until the first fetch lands. */
  readonly symbols: Signal<readonly SymbolEntry[]>;
  /** True once a real fetch has populated it. */
  readonly live: Signal<boolean>;
  readonly loading: Signal<boolean>;
  /** Where the current list came from. Shown in the palette footer. */
  readonly note: Signal<string>;
  /** Load if stale. Safe to call repeatedly; only one fetch is ever in flight. */
  ensure(): void;
  /** Ignore the cache and refetch. */
  refresh(): void;
}

const INSTRUMENT_SYMBOLS = new Set(INSTRUMENTS.map((i) => i.symbol));

/**
 * Union the venue's crypto list with the instrument table.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE COPIES
 * MEASURED, after shipping it wrong. The first version merged the instrument
 * table inside `fetchNow` only. Everything looked right on a cold start and
 * every asset-class tab except Crypto was EMPTY on a warm one — because a
 * cached catalogue is returned without ever going near the fetch path, and the
 * cache holds what the venue listed, which is crypto.
 *
 * The underlying mistake was treating the instrument table as data to be
 * cached. It is not: it is compiled into the build, it cannot be stale, and it
 * costs nothing to rebuild. So it is unioned in at every point a list is
 * produced — cache, seed and fetch — and the cache stores only what was
 * actually fetched.
 */
const withInstruments = (crypto: readonly SymbolEntry[]): SymbolEntry[] => {
  const table = instrumentEntries();
  /* The instrument table WINS on a collision, and that is the second half of
     this bug rather than a detail. MEASURED: a cache written by an earlier
     build held EURUSD, GBPUSD, USDJPY, XAUUSD and XAGUSD with no class, which
     the reader defaulted to "crypto". Skipping them as duplicates left the
     three most-traded FX pairs in the world filed under Crypto and absent from
     the Forex tab — the exact failure this whole change exists to fix, one
     layer down. The table is compiled in and cannot be stale; the cache is a
     record of what one venue listed. Ground truth beats a record. */
  const overridden = new Set(table.map((e) => e.symbol));
  const out = crypto.filter((e) => !overridden.has(e.symbol));
  out.push(...table);
  return out;
};

const seedEntries = (): SymbolEntry[] => {
  /* The seed is CRYPTO only now. Everything else the seed used to carry —
     XAUUSD, EURUSD, GBPUSD, USDJPY, XAGUSD — comes from the instrument table
     instead, along with the other 120 the seed never mentioned. */
  const seeded = SEED_SYMBOLS.filter((s) => !INSTRUMENT_SYMBOLS.has(s)).map((symbol, i, all) => ({
    symbol,
    /* Descending so the seed keeps its curated order under a volume sort,
       without pretending to know a real volume for any of them. */
    volume: all.length - i,
    source: "seed",
    tier: 0,
    cls: "crypto" as AssetClass,
  }));
  return withInstruments(seeded);
};

export function createCatalogue(kv: KV, load = loadBinanceUniverse): Catalogue {
  const cached = kv.read(CATALOGUE_SLOT).value;
  const hasCache = cached.entries.length > 0;

  /* `withInstruments`, not the bare cache. See the note on that function: a
     warm cache used to produce a picker whose Forex, Metals, Indices and
     Stocks tabs were all empty. */
  const symbols = signal<readonly SymbolEntry[]>(
    hasCache ? withInstruments(cached.entries) : seedEntries(),
  );
  const live = signal(hasCache);
  const loading = signal(false);
  const note = signal(
    hasCache
      ? `${cached.entries.length.toLocaleString()} symbols, cached`
      : `${SEED_SYMBOLS.length} built-in symbols — the full list loads shortly`,
  );

  let inflight: Promise<void> | null = null;

  const fetchNow = (): Promise<void> => {
    /* One fetch, ever, at a time. Four panes opening the palette at once must
       not spend weight 40 four times. */
    if (inflight) return inflight;
    loading.set(true);
    inflight = load()
      .then((universe) => {
        const entries: SymbolEntry[] = universe
          .map((u) => ({
            symbol: u.symbol,
            volume: u.quoteVolume,
            source: "binance",
            tier: quoteTier(u.symbol),
            cls: "crypto" as AssetClass,
          }))
          /* Tier first, then volume within the tier. */
          .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : b.volume - a.volume));

        if (entries.length === 0) {
          note.set("The venue returned an empty symbol list; keeping the previous one.");
          return;
        }

        const merged = withInstruments(entries);
        symbols.set(merged);
        live.set(true);
        const nonCrypto = merged.length - entries.length;
        note.set(
          `${merged.length.toLocaleString()} instruments — ${entries.length.toLocaleString()} crypto by 24h volume, ${nonCrypto} forex, metals, indices and equities`,
        );
        /* Only the FETCHED half is cached. The instrument table is compiled in
           and is re-unioned on every read, so storing it would be caching a
           constant and would go stale the next time the table grew. */
        const res = kv.write(CATALOGUE_SLOT, { at: Date.now(), entries });
        if (!res.ok) console.warn(`[iram] symbol catalogue not cached — ${res.error}`);
      })
      .catch((err: unknown) => {
        /* A failed catalogue costs autocomplete, not the terminal. The seed is
           still there and anything typed in full still loads. */
        const msg = err instanceof Error ? err.message : String(err);
        note.set(`Symbol list unavailable (${msg}). Typing a full symbol still works.`);
      })
      .finally(() => {
        loading.set(false);
        inflight = null;
      });
    return inflight;
  };

  return {
    symbols,
    live,
    loading,
    note,

    ensure() {
      if (Date.now() - cached.at < CATALOGUE_TTL_MS && hasCache) return;
      void fetchNow();
    },

    refresh() {
      void fetchNow();
    },
  };
}

/**
 * Search haystacks for one symbol.
 *
 * The bare symbol is the visible target. The second entry splits a pair into
 * its legs — "BTC USDT" — so typing "btc usd" finds BTCUSDT even though that
 * space does not appear in the symbol itself.
 */
export function symbolHaystacks(entry: SymbolEntry): string[] {
  const s = entry.symbol;
  /* The instrument's plain name, so "gold" finds XAUUSD and "apple" finds
     AAPL. Nobody remembers that the Nikkei is JPN225 on their broker. */
  const named = entry.name === undefined ? [] : [entry.name];
  for (const quote of ["USDT", "USDC", "USD", "BUSD", "BTC", "ETH", "EUR"]) {
    if (s.length > quote.length && s.endsWith(quote)) {
      return [s, `${s.slice(0, s.length - quote.length)} ${quote}`, ...named];
    }
  }
  return [s, ...named];
}

/**
 * Rank symbols for a query — liquidity-aware, unlike a bare fuzzy sort.
 *
 * THE BUG THIS EXISTS TO FIX, AND THE MEASUREMENT THAT FOUND IT
 * The header of this file claims: *"Type 'BT' and you should get BTCUSDT, not
 * BTCDOWNUSDT."* That claim was false in the shipped build. Measured against
 * the live Binance universe (3,645 listings), the top hit for each of the seven
 * most-traded assets was:
 *
 *     BT   -> BTCU        BTC  -> BTCU        ETH  -> ETHU
 *     SOL  -> SOLU        XRP  -> XRPU        DOGE -> DOGEU
 *     ADA  -> ADAU
 *
 * Not one of them was the pair the user meant, and BTCUSDT did not appear in
 * the top FOUR results for "BTC". Every one of those `…U` tickers is a real,
 * trading, near-zero-volume listing.
 *
 * The cause is not a bad catalogue — it is that `rank()` sorts by fuzzy score
 * alone, and `fuzzy.ts` charges `P_UNMATCHED` per unmatched target character
 * specifically so that SHORTER targets win. For "ETH" that is −1 against ETHU
 * and −4 against ETHUSDT, so the four-letter ghost beats the busiest pair on
 * the exchange by three points. Volume never entered the comparison: this file
 * sorts the pool by tier and volume, and the score sort then throws that order
 * away.
 *
 * WHY THE FIX IS NOT IN fuzzy.ts
 * Preferring short targets is CORRECT for commands — "Replay mode" should beat
 * "Replay: forward one bar" for "replay". The matcher is not wrong; using it
 * unmodified for instruments is. So the blend lives here, where the domain
 * knowledge (tier, volume) already is.
 *
 * THE ORDERING
 * Match quality decides the BAND; liquidity decides the order inside it.
 *
 *   band 0  exact          you typed the whole ticker, so you get it —
 *                          "ETHU" really does mean ETHU
 *   band 1  prefix         "ETH" -> every ETH… pair, best-quoted and busiest first
 *   band 2  everything else the fuzzy tail, e.g. "btc usd" or a mid-string hit
 *
 * Within a band: quote tier ascending, then 24h volume descending, then the
 * fuzzy score. That is what makes "BT" return BTCUSDT — as advertised.
 */
export function rankSymbols(
  pool: readonly SymbolEntry[],
  query: string,
  limit = 50,
): Ranked<SymbolEntry>[] {
  const q = query.trim().toUpperCase();
  /* No query: the pool is already tier-then-volume ordered, so the first N are
     the right N and a fuzzy pass would only shuffle them. */
  if (q.length === 0) {
    return pool.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  }

  const band = (s: string): number => (s === q ? 0 : s.startsWith(q) ? 1 : 2);

  /* Rank over the WHOLE pool, not a pre-sliced head: `rank`'s own limit would
     cut on fuzzy score, which is the very ordering being corrected here. A
     high-volume prefix hit must not be discarded before it can be promoted. */
  const matches = rank(pool, q, symbolHaystacks, pool.length);

  matches.sort((a, b) => {
    const ba = band(a.item.symbol);
    const bb = band(b.item.symbol);
    if (ba !== bb) return ba - bb;
    if (a.item.tier !== b.item.tier) return a.item.tier - b.item.tier;
    if (a.item.volume !== b.item.volume) return b.item.volume - a.item.volume;
    return b.score - a.score;
  });

  return matches.slice(0, limit);
}
