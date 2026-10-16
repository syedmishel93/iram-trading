/**
 * History service — the archive and the source registry, joined.
 *
 * This is what turns a cache into a research asset. It answers one question:
 * "give me N bars of SYMBOL/TF", and it answers it from disk when it can, from
 * the network when it must, persisting everything it learns with provenance so
 * the next answer is cheaper and a backtest has something to run on.
 *
 * WHAT IT REFUSES TO DO
 *
 *  - **Serve stale data as current.** A cache hit is only taken when the newest
 *    stored bar is recent enough to still be the newest bar. Otherwise it goes
 *    to the network, however much it holds.
 *  - **Hide what it is missing.** The result carries the gaps and the coverage
 *    ratio, so a backtest can refuse to run on a series that is 60% present
 *    rather than discovering it from a strange equity curve.
 *  - **Blend demo data into real history.** Generated bars are written under a
 *    `demo` source key, so they can never merge with a real series. A model
 *    trained on synthetic candles mixed into real ones is worse than one with
 *    no data, because it looks trained.
 */

import type { BarView } from "../chart/series";
import { ascendingUnique } from "../store/barstore";
import { fetchServerBars, putServerBars } from "./serverbars";
import type { BarArchive, DataQuality, SeriesKey } from "../store/barstore";
import type { Range } from "../store/segments";
import { significantGaps } from "../store/segments";
import type { Attempt, Registry } from "./sources";

export interface HistoryResult {
  bars: BarView[];
  /** Source id that served the network portion, or "archive" for a pure hit. */
  source: string;
  quality: DataQuality;
  fromCache: boolean;
  /** Ranges inside the requested window still missing after this call. */
  gaps: Range[];
  coverage: number;
  containsDemo: boolean;
  attempts: Attempt[];
}

export interface HistoryOptions {
  limit?: number;
  /** Force a network fetch even when the cache looks fresh. */
  refresh?: boolean;
  signal?: AbortSignal;
}

/**
 * Average length of a calendar month, in ms. 365.2425 / 12 days.
 *
 * A month is NOT a fixed span — February is 2,419,200,000ms and July is
 * 2,678,400,000, an 11% difference. This average is only ever used for cache
 * TTLs and for the contiguity tolerance in the archive, both of which compare
 * with slack. Anything that needs the ACTUAL next boundary — the bar countdown
 * — must use `nextCloseAt` in ui/countdown.ts, which walks the calendar.
 */
export const AVG_MONTH_MS = 2_629_746_000;

export function intervalMs(timeframe: string): number {
  const n = parseInt(timeframe, 10);
  if (!Number.isFinite(n) || n <= 0) return 3_600_000;
  /**
   * MONTHS ARE CHECKED FIRST, AND CASE-SENSITIVELY.
   *
   * `"1M"` used to fall through every branch and return 3,600,000 — one hour
   * for a monthly bar. `endsWith("m")` is case-sensitive, so the minute branch
   * never caught it and neither did any other. That number drives the cache
   * TTL and the archive's contiguity test, so monthly bars would have been
   * stored as a series of one-hour gaps.
   */
  if (timeframe.endsWith("M")) return n * AVG_MONTH_MS;
  if (timeframe.endsWith("m")) return n * 60_000;
  if (timeframe.endsWith("h")) return n * 3_600_000;
  if (timeframe.endsWith("d")) return n * 86_400_000;
  if (timeframe.endsWith("w")) return n * 604_800_000;
  return 3_600_000;
}

export interface HistoryService {
  load(symbol: string, timeframe: string, opts?: HistoryOptions): Promise<HistoryResult>;
  /** Persist live bars as they arrive. */
  record(
    symbol: string,
    timeframe: string,
    source: string,
    quality: DataQuality,
    bars: readonly BarView[],
  ): Promise<void>;
  /**
   * Fill missing history backwards from what is held, for backtesting.
   * Returns how many bars were added.
   */
  backfill(
    symbol: string,
    timeframe: string,
    targetBars: number,
    opts?: { signal?: AbortSignal; onProgress?: (added: number, target: number) => void },
  ): Promise<number>;
}

/**
 * The durable archive, as a dependency rather than a reach for the global
 * `fetch`.
 *
 * INJECTED because a hidden network call makes a test lie. `history.test.ts`
 * models "no network and no archive" by failing every SOURCE, while stubbing
 * `fetch` to answer — so a service that called `fetch` directly reported bars
 * in the one scenario that is supposed to return none. The dependency is named
 * here, defaulted to the real reader, and a test that means "everything is
 * down" can say so.
 */
export interface ServerArchive {
  read(src: string, symbol: string, timeframe: string, limit: number): Promise<readonly BarView[]>;
  write(src: string, symbol: string, timeframe: string, bars: readonly BarView[], closedBefore?: number): void;
}

export const liveServerArchive: ServerArchive = {
  read: async (src, symbol, timeframe, limit) =>
    (await fetchServerBars(src, symbol, timeframe, limit)).bars,
  write: (src, symbol, timeframe, bars, closedBefore) => {
    void putServerBars(src, symbol, timeframe, bars, {
      ...(closedBefore === undefined ? {} : { closedBefore }),
    });
  },
};

/**
 * A durable archive that holds nothing and is never written to.
 *
 * THE DEFAULT, and it is inert ON PURPOSE. The live one talks to `/svc/bars`
 * over the global `fetch`, and MEASURED: a vitest run with the gateway up wrote
 * test fixtures straight into the operator's database — series called `net`,
 * `a`, `alive` and `px`, dated 2027, sitting beside the real BTCUSDT history.
 * That is the defect CLAUDE.md already records under "Four test files wrote to
 * the operator's live `server/mishel.db`", arriving through a new door.
 *
 * So reaching the real archive is something a caller OPTS IN to, once, in
 * `data/feed.ts` where the application is assembled. A test that does not ask
 * for it cannot touch it, no matter what `fetch` happens to be.
 */
const NO_SERVER: ServerArchive = {
  read: async () => [],
  write: () => {},
};

export function createHistory(
  registry: Registry,
  archive: BarArchive,
  now: () => number = Date.now,
  server: ServerArchive = NO_SERVER,
): HistoryService {
  /**
   * A cache hit is only valid if the newest stored bar could still BE the
   * newest bar. Two intervals of slack absorbs a vendor publishing late
   * without ever letting yesterday's close masquerade as today's.
   */
  const isFresh = (bars: readonly BarView[], step: number): boolean => {
    if (bars.length === 0) return false;
    const newest = (bars[bars.length - 1] as BarView).t;
    return now() - newest <= step * 2;
  };

  /** Which source key to read/write for a symbol, preferring the archive it filled. */
  const keyFor = (source: string, symbol: string, timeframe: string): SeriesKey => ({
    source,
    symbol,
    timeframe,
  });

  /**
   * WHEN THIS SERIES WAS LAST PUSHED TO THE DURABLE COPY.
   *
   * MEASURED the first time the mirror was wired: the server stayed EMPTY.
   * The write-through sat on the fetch path, and a chart whose local archive
   * is already warm never fetches — so the half that is supposed to survive a
   * cleared browser would only ever hold what happened to be downloaded after
   * the feature shipped, and an existing operator's whole history would never
   * reach it.
   *
   * A cache HIT therefore mirrors too, but not on every pan: that would POST
   * eight hundred bars each time the chart moved. Once per series per
   * `MIRROR_EVERY_MS`, in memory, best-effort, never awaited.
   */
  const mirrored = new Map<string, number>();
  const MIRROR_EVERY_MS = 5 * 60_000;
  const mirrorIfStale = (src: string, sym: string, tf: string, bars: readonly BarView[]): void => {
    if (bars.length === 0) return;
    const k = `${src}|${sym}|${tf}`;
    const at = mirrored.get(k) ?? 0;
    if (now() - at < MIRROR_EVERY_MS) return;
    mirrored.set(k, now());
    const newest = bars[bars.length - 1];
    server.write(src, sym, tf, bars, newest?.t);
  };

  return {
    async load(symbol, timeframe, opts = {}) {
      const step = intervalMs(timeframe);
      const limit = opts.limit ?? 800;
      const window: Range = { from: now() - limit * step, to: now() };

      // Try each source's archive in priority order, so a cached Binance series
      // is preferred over a cached proxy one exactly as the live path would.
      if (!opts.refresh) {
        for (const src of registry.candidates(symbol)) {
          const cached = await archive.read(keyFor(src.id, symbol, timeframe), window, step);
          if (cached.bars.length > 0 && isFresh(cached.bars, step)) {
            mirrorIfStale(src.id, symbol, timeframe, cached.bars);
            return {
              bars: cached.bars,
              source: src.id,
              quality: src.quality,
              fromCache: true,
              gaps: significantGaps(cached.gaps, step, 2),
              coverage: cached.coverage,
              containsDemo: cached.containsDemo,
              attempts: [{ source: "archive", ok: true, note: `${cached.bars.length} cached bars`, ms: 0 }],
            };
          }
        }
      }

      const resolved = await registry.resolve(symbol, timeframe, {
        limit,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (resolved.bars.length === 0 || !resolved.source) {
        // Every source failed. Fall back to whatever is archived and say so —
        // stale-but-labelled beats an empty chart, and the freshness contract
        // will mark it.
        for (const src of registry.candidates(symbol)) {
          const cached = await archive.read(keyFor(src.id, symbol, timeframe), window, step);
          if (cached.bars.length > 0) {
            return {
              bars: cached.bars,
              source: src.id,
              quality: src.quality,
              fromCache: true,
              gaps: significantGaps(cached.gaps, step, 2),
              coverage: cached.coverage,
              containsDemo: cached.containsDemo,
              attempts: resolved.attempts,
            };
          }
        }
        /*
         * THE DURABLE ARCHIVE, LAST. Every vendor failed and this browser holds
         * nothing — which is the ordinary state of a fresh profile, a cleared
         * one, or a machine that has never run this before. The server's copy
         * is the only reason that is recoverable rather than an empty chart.
         *
         * Last rather than first on purpose: it is a mirror over HTTP, and
         * reading it ahead of a working local archive would put a request in
         * front of every pan.
         */
        for (const src of registry.candidates(symbol)) {
          const remote = { bars: await server.read(src.id, symbol, timeframe, limit) };
          if (remote.bars.length > 0) {
            return {
              bars: [...remote.bars],
              source: src.id,
              quality: src.quality,
              fromCache: true,
              gaps: [],
              coverage: 1,
              containsDemo: false,
              attempts: [
                ...resolved.attempts,
                { source: "server archive", ok: true, note: `${remote.bars.length} stored bars`, ms: 0 },
              ],
            };
          }
        }

        return {
          bars: [],
          source: "none",
          quality: "unknown",
          fromCache: false,
          gaps: [window],
          coverage: 0,
          containsDemo: false,
          attempts: resolved.attempts,
        };
      }

      const key = keyFor(resolved.source.id, symbol, timeframe);
      await archive.write(
        key,
        resolved.bars,
        { source: resolved.source.id, quality: resolved.quality, fetchedAt: now() },
        step,
      );

      /*
       * AND TO THE DURABLE COPY. Not awaited: this is a mirror, the local
       * archive above is the working copy, and a chart must not wait on a
       * backup store — nor fail when the gateway is not running, which is the
       * ordinary case for anyone who opened the built page directly.
       *
       * `closedBefore` is the newest bar's own timestamp, so the server drops
       * it: the last bar a vendor returns is the FORMING one, and its close
       * changes every tick.
       */
      mirrorIfStale(resolved.source.id, symbol, timeframe, resolved.bars);

      // Read back through the archive rather than returning the network result
      // directly: the archive may hold MORE than this response (earlier
      // backfills), and going through it is what makes the returned gap list
      // and coverage true of the whole holding.
      const merged = await archive.read(key, window, step);
      return {
        /* `ascendingUnique` because the second branch is the VENDOR's response
           verbatim, and a vendor that publishes the same instant twice has
           handed every consumer a series that breaks its own contract. */
        bars: ascendingUnique(
          merged.bars.length >= resolved.bars.length ? merged.bars : resolved.bars,
        ),
        source: resolved.source.id,
        quality: resolved.quality,
        fromCache: false,
        gaps: significantGaps(merged.gaps, step, 2),
        coverage: merged.coverage,
        containsDemo: merged.containsDemo,
        attempts: resolved.attempts,
      };
    },

    async record(symbol, timeframe, source, quality, bars) {
      if (bars.length === 0) return;
      await archive.write(
        keyFor(source, symbol, timeframe),
        bars,
        { source, quality, fetchedAt: now() },
        intervalMs(timeframe),
      );
    },

    /**
     * Walk backwards from the oldest bar held, one vendor-sized page at a time,
     * until the archive holds `targetBars`.
     *
     * Oldest-first within each page and strictly backwards overall, so an
     * interrupted backfill leaves a CONTIGUOUS archive with its hole at the far
     * end — never a series riddled with holes that later reads must chase.
     */
    async backfill(symbol, timeframe, targetBars, opts = {}) {
      const step = intervalMs(timeframe);
      const src = registry.candidates(symbol)[0];
      if (!src) return 0;

      const key = keyFor(src.id, symbol, timeframe);
      let added = 0;
      let guard = 0;

      for (;;) {
        if (opts.signal?.aborted) break;
        // A vendor page is ~1000 bars; 40 pages is 40k bars, far past any
        // sensible target and a hard stop against an endless loop.
        if (++guard > 40) break;

        const held = await archive.coverage(key, step);
        const oldest = held.length > 0 ? (held[0] as Range).from : now();
        const stored = await archive.read(key, { from: oldest, to: now() }, step);
        if (stored.bars.length >= targetBars) break;

        const pageEnd = oldest - 1;
        const pageStart = pageEnd - 1000 * step;

        const page = await src.loadBars(symbol, timeframe, {
          from: pageStart,
          to: pageEnd,
          limit: 1000,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });

        // The vendor has no more history. Stop rather than looping on empty
        // pages until the guard trips.
        if (page.length === 0) break;

        await archive.write(
          key,
          page,
          { source: src.id, quality: src.quality, fetchedAt: now() },
          step,
        );
        added += page.length;
        opts.onProgress?.(added, targetBars);
      }

      return added;
    },
  };
}
