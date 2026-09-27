/**
 * The response cache.
 *
 * THE INSIGHT THE TTL IS BUILT ON
 * A closed candle is IMMUTABLE. Once 14:00-15:00 has ended, that bar's OHLCV
 * will never legitimately change again — and yet the terminal re-downloaded the
 * last 800 of them every time you touched the timeframe buttons. Only ONE bar
 * in a series is volatile: the one still forming.
 *
 * So the TTL is not a number somebody guessed. It is computed from the bar
 * interval and the wall clock: a response is fresh until the bar that was
 * forming when it was fetched has closed. On a 1d chart that is hours. On a 1m
 * chart it is under a minute. Both are correct, and neither is a magic constant
 * that will be wrong for some timeframe.
 *
 * STALE-WHILE-REVALIDATE, WITH THE HONESTY CONTRACT ATTACHED
 * A stale entry is served instantly and refreshed behind you — but the entry
 * says it is stale and how old it is, so the freshness badge can tell the truth
 * rather than the cache quietly making a 40-second-old price look live. A cache
 * that lies about age is worse than no cache, because you act on the number.
 *
 * WHAT IT IS NOT
 * Not a bar archive. The archive (`barstore.ts`) is the durable, gap-aware,
 * provenance-carrying record of history and it survives reloads. This is a
 * short-lived memory cache in front of the NETWORK, and it holds whatever a
 * request returned. They solve different problems and merging them would give
 * you an archive you cannot trust or a cache that cannot expire.
 */

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms the value was produced. */
  storedAt: number;
  /** Epoch ms after which it is stale. */
  freshUntil: number;
  bytes: number;
  hits: number;
  lastUsed: number;
}

export interface CacheRead<T> {
  value: T;
  /** True when the value came from cache rather than the loader. */
  cached: boolean;
  /** True when it was served past its freshness window. */
  stale: boolean;
  /** How old the value is, in ms. 0 for a fresh fetch. */
  ageMs: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  staleServed: number;
  evictions: number;
  /** Requests that joined an in-flight load instead of starting one. */
  coalesced: number;
  hitRate: number;
}

export interface CacheOptions {
  /** Byte budget. Default 24MB — big enough for a day's browsing, small enough
   *  to stay well clear of anything that would make the tab get killed. */
  maxBytes?: number;
  now?: () => number;
}

export interface LoadOptions {
  /** Milliseconds this value stays fresh. */
  ttlMs: number;
  /**
   * Serve a stale value immediately and refresh in the background.
   *
   * Off by default: it is right for a dashboard panel and wrong for anything a
   * decision is made on, and the caller is the only one who knows which it is.
   */
  swr?: boolean;
  /** Approximate size, for the budget. Estimated when omitted. */
  bytes?: number;
  signal?: AbortSignal;
  /** Bypass the cached value but still store the result. */
  refresh?: boolean;
}

/**
 * Rough in-memory size.
 *
 * Deliberately approximate — the alternative is serialising every value just to
 * measure it, which costs more than the eviction it informs. It only has to be
 * proportional enough to rank entries and keep the budget in the right order of
 * magnitude.
 */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "string") return value.length * 2 + 16;
  if (ArrayBuffer.isView(value)) return value.byteLength + 32;
  if (Array.isArray(value)) {
    if (value.length === 0) return 32;
    // Sample rather than walk: a 40,000-bar array measured element by element
    // costs more than the memory it is accounting for.
    const sample = Math.min(value.length, 20);
    let acc = 0;
    for (let i = 0; i < sample; i++) acc += estimateBytes(value[i]);
    return 32 + Math.round((acc / sample) * value.length);
  }
  if (typeof value === "object") {
    let acc = 32;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc += k.length * 2 + estimateBytes(v);
    }
    return acc;
  }
  return 32;
}

/**
 * How long a bar response stays fresh.
 *
 * Until the forming bar closes, plus a second of slack for a vendor that
 * publishes a moment late. Never longer than the interval, and never less than
 * 750ms — below that the cache would spend more on bookkeeping than it saves,
 * and a 1m chart does not need four refreshes a second.
 */
export function barTtlMs(intervalMs: number, now: number): number {
  if (!(intervalMs > 0)) return 5_000;
  const elapsedInBar = now % intervalMs;
  const untilClose = intervalMs - elapsedInBar + 1_000;
  return Math.max(750, Math.min(intervalMs, untilClose));
}

export interface Cache {
  /** Get-or-load, with coalescing. */
  load<T>(key: string, loader: () => Promise<T>, opts: LoadOptions): Promise<CacheRead<T>>;
  /** Read without loading. */
  peek<T>(key: string): CacheRead<T> | null;
  put<T>(key: string, value: T, ttlMs: number, bytes?: number): void;
  invalidate(keyOrPrefix: string, prefix?: boolean): number;
  clear(): void;
  stats(): CacheStats;
  keys(): string[];
}

export function createCache(opts: CacheOptions = {}): Cache {
  const maxBytes = opts.maxBytes ?? 24 * 1024 * 1024;
  const now = opts.now ?? Date.now;

  // Insertion order is LRU order: a `get` deletes and re-sets, so the oldest
  // key is always first. This is why it is a Map and not a plain object.
  const entries = new Map<string, CacheEntry<unknown>>();
  const inflight = new Map<string, Promise<unknown>>();

  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let staleServed = 0;
  let evictions = 0;
  let coalesced = 0;

  const drop = (key: string): void => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.bytes;
    entries.delete(key);
  };

  const evictTo = (target: number): void => {
    for (const key of entries.keys()) {
      if (bytes <= target) break;
      drop(key);
      evictions++;
    }
  };

  const store = <T>(key: string, value: T, ttlMs: number, size: number): void => {
    drop(key);
    const t = now();
    const entry: CacheEntry<T> = {
      value,
      storedAt: t,
      freshUntil: t + Math.max(0, ttlMs),
      bytes: size,
      hits: 0,
      lastUsed: t,
    };
    entries.set(key, entry as CacheEntry<unknown>);
    bytes += size;
    // A single value larger than the whole budget would evict everything
    // including itself; cap it instead of thrashing.
    if (size > maxBytes) {
      drop(key);
      return;
    }
    if (bytes > maxBytes) evictTo(Math.floor(maxBytes * 0.8));
  };

  const touch = <T>(key: string): CacheEntry<T> | null => {
    const e = entries.get(key) as CacheEntry<T> | undefined;
    if (!e) return null;
    e.hits++;
    e.lastUsed = now();
    // Re-insert to move to the MRU end.
    entries.delete(key);
    entries.set(key, e as CacheEntry<unknown>);
    return e;
  };

  return {
    async load<T>(
      key: string,
      loader: () => Promise<T>,
      options: LoadOptions,
    ): Promise<CacheRead<T>> {
      const t = now();
      const entry = options.refresh ? null : touch<T>(key);

      if (entry && t < entry.freshUntil) {
        hits++;
        return { value: entry.value, cached: true, stale: false, ageMs: t - entry.storedAt };
      }

      if (entry && options.swr) {
        // Serve the stale value NOW and refresh behind it. The caller is told
        // it is stale and how old, so nothing downstream can present it as
        // current.
        hits++;
        staleServed++;
        if (!inflight.has(key)) {
          const p = loader()
            .then((value) => {
              store(key, value, options.ttlMs, options.bytes ?? estimateBytes(value));
              return value as unknown;
            })
            .catch(() => {
              // A failed background refresh leaves the stale value in place.
              // Dropping it would turn a slow vendor into an empty panel.
              return undefined;
            })
            .finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        return { value: entry.value, cached: true, stale: true, ageMs: t - entry.storedAt };
      }

      const pending = inflight.get(key);
      if (pending && !options.refresh) {
        coalesced++;
        return { value: (await pending) as T, cached: false, stale: false, ageMs: 0 };
      }

      misses++;
      const p = loader()
        .then((value) => {
          store(key, value, options.ttlMs, options.bytes ?? estimateBytes(value));
          return value as unknown;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return { value: (await p) as T, cached: false, stale: false, ageMs: 0 };
    },

    peek<T>(key: string) {
      const e = touch<T>(key);
      if (!e) return null;
      const t = now();
      return { value: e.value, cached: true, stale: t >= e.freshUntil, ageMs: t - e.storedAt };
    },

    put<T>(key: string, value: T, ttlMs: number, size?: number) {
      store(key, value, ttlMs, size ?? estimateBytes(value));
    },

    invalidate(keyOrPrefix, prefix = false) {
      if (!prefix) {
        const had = entries.has(keyOrPrefix);
        drop(keyOrPrefix);
        return had ? 1 : 0;
      }
      let n = 0;
      for (const k of [...entries.keys()]) {
        if (k.startsWith(keyOrPrefix)) {
          drop(k);
          n++;
        }
      }
      return n;
    },

    clear() {
      entries.clear();
      bytes = 0;
    },

    stats() {
      const total = hits + misses;
      return {
        entries: entries.size,
        bytes,
        maxBytes,
        hits,
        misses,
        staleServed,
        evictions,
        coalesced,
        hitRate: total === 0 ? 0 : hits / total,
      };
    },

    keys: () => [...entries.keys()],
  };
}

/** Stable cache key. Query order must not create two entries for one request. */
export function requestKey(url: string): string {
  try {
    const u = new URL(url, "http://localhost");
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${u.host}${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return url;
  }
}
