/**
 * Persistent bar archive.
 *
 * WHAT THIS UNLOCKS
 * Backtests longer than one API response, forward tests that survive a reload,
 * ML training sets, instant boot, and working offline. None of that is possible
 * while the only copy of history lives in a variable.
 *
 * TWO RULES IT ENFORCES, BOTH INHERITED FROM THE HONESTY CONTRACT
 *
 * 1. **Never return a series without its gaps.** `read()` hands back bars AND
 *    the ranges it does not have. A backtest over a series with an invisible
 *    hole does not crash; it produces a confident wrong number.
 *
 * 2. **Provenance is stored per segment and never mixed silently.** A segment
 *    records which source produced it and whether that source was live,
 *    delayed, or DEMO. A model trained on generated candles blended into real
 *    ones is worse than a model with no data, because it looks trained. `read()`
 *    reports every quality present in the range it returns, and a caller asking
 *    for real data can refuse anything else.
 *
 * Storage layout: contiguous runs of bars ("segments") held as typed arrays.
 * IndexedDB structured-clones Float64Array natively, so a segment is one record
 * and one round trip — not one record per bar, which is what makes naive
 * IndexedDB bar caches unusably slow at 100k rows.
 */

import type { BarView } from "../chart/series";
import { normalise, missing, coverageRatio, type Range } from "./segments";

/**
 * Qualities a stored segment may carry.
 *
 * `demo` is retained here and ONLY here. Nothing in the app can produce it any
 * more — the generator was deleted in v43.1 — but this is a persisted enum, and
 * an archive written by an earlier build may still contain demo segments. The
 * reader has to keep understanding the value so the retention sweep can find
 * those segments and remove them. It is a legacy value on the way out, not a
 * mode.
 */
export type DataQuality = "live" | "delayed" | "demo" | "unknown";

export interface SeriesKey {
  source: string;
  symbol: string;
  timeframe: string;
}

export interface SegmentMeta {
  source: string;
  quality: DataQuality;
  fetchedAt: number;
}

export interface StoredSegment extends SegmentMeta {
  key: string;
  from: number;
  to: number;
  count: number;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export interface ReadResult {
  bars: BarView[];
  /** Ranges inside the request that the archive does not hold. */
  gaps: Range[];
  /** 0..1 share of the requested window actually covered. */
  coverage: number;
  /** Every quality present in the returned bars. */
  qualities: DataQuality[];
  /** True when any returned bar came from generated data. */
  containsDemo: boolean;
}

export interface SeriesInventory {
  key: string;
  source: string;
  symbol: string;
  timeframe: string;
  segments: number;
  bars: number;
  approxBytes: number;
  oldest: number;
  newest: number;
  qualities: DataQuality[];
  /** Newest `fetchedAt` across the segments — when this series was last touched. */
  lastFetched: number;
}

export interface ArchiveStats {
  series: number;
  segments: number;
  bars: number;
  /** Approximate, from bar count — IndexedDB does not report per-record size. */
  approxBytes: number;
  oldest: number | null;
  newest: number | null;
}

const DB_NAME = "iram-archive";
const DB_VERSION = 1;
const STORE = "segments";

/** Above this a segment is split, so no single record dominates a read. */
const MAX_SEGMENT_BARS = 5000;

export function seriesKey(k: SeriesKey): string {
  return `${k.source}|${k.symbol}|${k.timeframe}`;
}

/**
 * The inverse. Retention and the storage desk work from stored keys, and
 * re-deriving the parts by splitting at every call site is how one of them ends
 * up handling a symbol containing a separator differently from the others.
 */
export function parseSeriesKey(key: string): SeriesKey {
  const [source = "", symbol = "", timeframe = ""] = key.split("|");
  return { source, symbol, timeframe };
}

// --------------------------------------------------------------- backend ---

/**
 * The persistence primitives, abstracted.
 *
 * Segment merging and gap arithmetic are where the bugs are, and they are
 * testable without a database — so the backend is injected and the tests run
 * against an in-memory one rather than pulling in an IndexedDB shim.
 */
export interface StoreBackend {
  all(key: string): Promise<StoredSegment[]>;
  put(segments: StoredSegment[]): Promise<void>;
  remove(ids: Array<[string, number]>): Promise<void>;
  keys(): Promise<string[]>;
  clear(key?: string): Promise<void>;
}

export function memoryBackend(): StoreBackend {
  const rows = new Map<string, StoredSegment[]>();
  return {
    async all(key) {
      return [...(rows.get(key) ?? [])].sort((a, b) => a.from - b.from);
    },
    async put(segments) {
      for (const seg of segments) {
        const list = rows.get(seg.key) ?? [];
        const idx = list.findIndex((s) => s.from === seg.from);
        if (idx >= 0) list[idx] = seg;
        else list.push(seg);
        rows.set(seg.key, list);
      }
    },
    async remove(ids) {
      for (const [key, from] of ids) {
        const list = rows.get(key);
        if (!list) continue;
        rows.set(
          key,
          list.filter((s) => s.from !== from),
        );
      }
    },
    async keys() {
      return [...rows.keys()];
    },
    async clear(key) {
      if (key === undefined) rows.clear();
      else rows.delete(key);
    },
  };
}

export function indexedDbBackend(dbName = DB_NAME): StoreBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // Composite key: one record per (series, segment start).
          const os = db.createObjectStore(STORE, { keyPath: ["key", "from"] });
          os.createIndex("key", "key", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    });
    return dbPromise;
  };

  const tx = async <T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });
  };

  return {
    async all(key) {
      const rows = await tx<StoredSegment[]>("readonly", (os) =>
        os.index("key").getAll(IDBKeyRange.only(key)) as IDBRequest<StoredSegment[]>,
      );
      return rows.sort((a, b) => a.from - b.from);
    },

    async put(segments) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        const os = t.objectStore(STORE);
        for (const seg of segments) os.put(seg);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error("indexedDB write failed"));
      });
    },

    async remove(ids) {
      if (ids.length === 0) return;
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        const os = t.objectStore(STORE);
        for (const [key, from] of ids) os.delete([key, from]);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error("indexedDB delete failed"));
      });
    },

    async keys() {
      const rows = await tx<StoredSegment[]>("readonly", (os) => os.getAll() as IDBRequest<StoredSegment[]>);
      return [...new Set(rows.map((r) => r.key))];
    },

    async clear(key) {
      if (key === undefined) {
        await tx<undefined>("readwrite", (os) => os.clear() as IDBRequest<undefined>);
        return;
      }
      const rows = await this.all(key);
      await this.remove(rows.map((r) => [r.key, r.from] as [string, number]));
    },
  };
}

// ----------------------------------------------------------------- store ---

function toSegment(key: string, bars: readonly BarView[], meta: SegmentMeta): StoredSegment {
  const n = bars.length;
  const seg: StoredSegment = {
    key,
    from: (bars[0] as BarView).t,
    to: (bars[n - 1] as BarView).t,
    count: n,
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
    ...meta,
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i] as BarView;
    seg.t[i] = b.t;
    seg.o[i] = b.o;
    seg.h[i] = b.h;
    seg.l[i] = b.l;
    seg.c[i] = b.c;
    seg.v[i] = b.v;
  }
  return seg;
}

function segmentBars(seg: StoredSegment): BarView[] {
  const out: BarView[] = new Array(seg.count);
  for (let i = 0; i < seg.count; i++) {
    out[i] = {
      t: seg.t[i] as number,
      o: seg.o[i] as number,
      h: seg.h[i] as number,
      l: seg.l[i] as number,
      c: seg.c[i] as number,
      v: seg.v[i] as number,
    };
  }
  return out;
}

/**
 * Median gap between consecutive bars.
 *
 * Median, not mean, so one weekend does not redefine the interval of an
 * otherwise hourly series.
 */
/**
 * ASCENDING AND UNIQUE — the contract every consumer of a series assumes.
 *
 * It was assumed in four places and guaranteed in none. `archive.write`
 * de-duplicates within one batch (a feed republishing the forming bar), but
 * `archive.read` concatenated overlapping segments and merely SORTED, and
 * `history.load` hands the vendor's response straight back whenever it is
 * longer than the archive's holding — so a vendor publishing the same instant
 * twice reached the caller untouched.
 *
 * MEASURED, and it broke the feature silently rather than loudly: a 5,000-bar
 * study window came back with `bars[4999].t === bars[4998].t`, `headless.ts`
 * threw on its ascending-and-unique check, and an autonomous sweep reported
 * "85 could not be studied on this history" — a number with no cause, for a
 * market whose data was fine apart from one repeated row.
 *
 * THE LAST BAR FOR AN INSTANT WINS. A republished bar is a correction of the
 * one before it: the forming bar's close changes every tick, and the newest
 * copy is the one the venue is standing behind.
 */
export function ascendingUnique(bars: readonly BarView[]): BarView[] {
  const out: BarView[] = [];
  for (const b of bars) {
    const last = out[out.length - 1];
    if (last && b.t === last.t) out[out.length - 1] = b;
    else if (last && b.t < last.t) continue; /* Unsorted input: see `read`. */
    else out.push(b);
  }
  return out;
}

export function inferInterval(bars: readonly BarView[]): number {
  if (bars.length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    gaps.push((bars[i] as BarView).t - (bars[i - 1] as BarView).t);
  }
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] ?? 0;
}

/**
 * Split bars into CONTIGUOUS runs.
 *
 * A stored segment claims to hold everything between its `from` and `to`, so a
 * segment must never span a hole. Chunking purely by bar count let one segment
 * straddle a three-week absence and report it as covered — the exact silent gap
 * the archive exists to prevent. Contiguity decides the boundaries; the size cap
 * only subdivides within a run.
 */
export function contiguousRuns(bars: readonly BarView[], intervalMs: number): BarView[][] {
  if (bars.length === 0) return [];
  if (intervalMs <= 0) return [[...bars]];

  // 1.5x absorbs vendor jitter without swallowing a genuinely missing bar.
  const limit = intervalMs * 1.5;
  const runs: BarView[][] = [];
  let current: BarView[] = [bars[0] as BarView];

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as BarView;
    const prev = bars[i - 1] as BarView;
    if (b.t - prev.t > limit) {
      runs.push(current);
      current = [b];
    } else {
      current.push(b);
    }
  }
  runs.push(current);
  return runs;
}

export interface BarArchive {
  /**
   * Persist bars. `intervalMs` defines contiguity; inferred when omitted.
   */
  write(
    key: SeriesKey,
    bars: readonly BarView[],
    meta: SegmentMeta,
    intervalMs?: number,
  ): Promise<void>;
  read(key: SeriesKey, window: Range, intervalMs: number): Promise<ReadResult>;
  /**
   * Ranges held for a series.
   *
   * `intervalMs` matters: without it, two segments ending 19:00 and resuming
   * 20:00 on an hourly series look like a gap when they are contiguous, and a
   * caller then chases a hole that does not exist. `read()` has always applied
   * this tolerance; `coverage()` reported phantom fragmentation without it.
   */
  coverage(key: SeriesKey, intervalMs?: number): Promise<Range[]>;
  stats(): Promise<ArchiveStats>;
  /**
   * Per-series detail — what is actually stored, series by series.
   *
   * `stats()` answers "how big is the archive", which is the question you ask
   * once. This answers "what is in it and what can go", which is the question
   * retention and the storage desk ask every time.
   */
  inventory(): Promise<SeriesInventory[]>;
  /**
   * Drop bars older than `before` from one series. Returns bars removed.
   *
   * Whole segments outside the cut are deleted; the segment straddling it is
   * rewritten. Deleting the straddler wholesale would silently discard up to
   * 5,000 bars the policy said to keep, and the archive would report full
   * coverage of a range it had just thrown away.
   */
  prune(key: SeriesKey, before: number): Promise<number>;
  clear(key?: SeriesKey): Promise<void>;
}

export function createArchive(backend: StoreBackend = indexedDbBackend()): BarArchive {
  return {
    /**
     * Persist bars, merging with whatever is already stored.
     *
     * Later writes win on overlap: a re-fetch of a range is a CORRECTION (a
     * vendor revising a bar, or a better source replacing a worse one), and
     * keeping the older copy would make the archive permanently wrong in a way
     * no amount of re-fetching could fix.
     */
    async write(key, bars, meta, intervalMs) {
      if (bars.length === 0) return;
      const k = seriesKey(key);

      // Ascending, de-duplicated by timestamp — a feed republishing the forming
      // bar must not create two rows for the same instant.
      const sorted = [...bars].sort((a, b) => a.t - b.t);
      const merged = new Map<number, BarView>();
      for (const b of sorted) {
        if (Number.isFinite(b.t) && Number.isFinite(b.c)) merged.set(b.t, b);
      }

      const existing = await backend.all(k);
      for (const seg of existing) {
        for (let i = 0; i < seg.count; i++) {
          const t = seg.t[i] as number;
          if (merged.has(t)) continue; // incoming wins
          merged.set(t, {
            t,
            o: seg.o[i] as number,
            h: seg.h[i] as number,
            l: seg.l[i] as number,
            c: seg.c[i] as number,
            v: seg.v[i] as number,
          });
        }
      }

      const all = [...merged.values()].sort((a, b) => a.t - b.t);
      const interval = intervalMs && intervalMs > 0 ? intervalMs : inferInterval(all);

      // Rewrite the series as bounded, CONTIGUOUS segments. Simpler and safer
      // than in-place splicing, and a series is a few hundred KB at most.
      const next: StoredSegment[] = [];
      for (const run of contiguousRuns(all, interval)) {
        for (let i = 0; i < run.length; i += MAX_SEGMENT_BARS) {
          next.push(toSegment(k, run.slice(i, i + MAX_SEGMENT_BARS), meta));
        }
      }

      await backend.remove(existing.map((s) => [s.key, s.from] as [string, number]));
      await backend.put(next);
    },

    async read(key, window, intervalMs) {
      const k = seriesKey(key);
      const segments = await backend.all(k);

      const bars: BarView[] = [];
      const qualities = new Set<DataQuality>();

      for (const seg of segments) {
        if (seg.to < window.from || seg.from > window.to) continue;
        for (const b of segmentBars(seg)) {
          if (b.t >= window.from && b.t <= window.to) {
            bars.push(b);
            qualities.add(seg.quality);
          }
        }
      }
      bars.sort((a, b) => a.t - b.t);
      /* Two segments can cover the same instant — a live recording and a
         backfill of the same hour is the ordinary case. Sorting puts the
         copies next to each other; it does not remove them. */
      const unique = ascendingUnique(bars);

      // Tolerance of one interval: segments ending at 09:00 and resuming at
      // 10:00 on an hourly series are contiguous, not a gap.
      const held = normalise(
        segments.map((s) => ({ from: s.from, to: s.to })),
        intervalMs,
      );

      return {
        bars: unique,
        gaps: missing(window, held, intervalMs),
        coverage: coverageRatio(window, held, intervalMs),
        qualities: [...qualities],
        containsDemo: qualities.has("demo"),
      };
    },

    async coverage(key, intervalMs = 0) {
      const segments = await backend.all(seriesKey(key));
      return normalise(
        segments.map((s) => ({ from: s.from, to: s.to })),
        intervalMs,
      );
    },

    async stats() {
      const keys = await backend.keys();
      let segments = 0;
      let bars = 0;
      let oldest: number | null = null;
      let newest: number | null = null;

      for (const k of keys) {
        for (const seg of await backend.all(k)) {
          segments++;
          bars += seg.count;
          if (oldest === null || seg.from < oldest) oldest = seg.from;
          if (newest === null || seg.to > newest) newest = seg.to;
        }
      }

      return {
        series: keys.length,
        segments,
        bars,
        // Six Float64 columns per bar.
        approxBytes: bars * 6 * 8,
        oldest,
        newest,
      };
    },

    async inventory() {
      const out: SeriesInventory[] = [];
      for (const k of await backend.keys()) {
        const segs = await backend.all(k);
        if (segs.length === 0) continue;
        const parts = parseSeriesKey(k);
        let bars = 0;
        let oldest = Infinity;
        let newest = -Infinity;
        let lastFetched = 0;
        const qualities = new Set<DataQuality>();
        for (const seg of segs) {
          bars += seg.count;
          if (seg.from < oldest) oldest = seg.from;
          if (seg.to > newest) newest = seg.to;
          if (seg.fetchedAt > lastFetched) lastFetched = seg.fetchedAt;
          qualities.add(seg.quality);
        }
        out.push({
          key: k,
          ...parts,
          segments: segs.length,
          bars,
          approxBytes: bars * 6 * 8,
          oldest,
          newest,
          qualities: [...qualities],
          lastFetched,
        });
      }
      out.sort((a, b) => b.approxBytes - a.approxBytes);
      return out;
    },

    async prune(key, before) {
      const k = seriesKey(key);
      const segs = await backend.all(k);
      const doomed: Array<[string, number]> = [];
      const rewritten: StoredSegment[] = [];
      let removed = 0;

      for (const seg of segs) {
        if (seg.to < before) {
          doomed.push([seg.key, seg.from]);
          removed += seg.count;
          continue;
        }
        if (seg.from >= before) continue;

        // Straddles the cut: keep the tail.
        const keep = segmentBars(seg).filter((b) => b.t >= before);
        removed += seg.count - keep.length;
        doomed.push([seg.key, seg.from]);
        if (keep.length > 0) {
          rewritten.push(
            toSegment(k, keep, {
              source: seg.source,
              quality: seg.quality,
              fetchedAt: seg.fetchedAt,
            }),
          );
        }
      }

      if (doomed.length > 0) await backend.remove(doomed);
      if (rewritten.length > 0) await backend.put(rewritten);
      return removed;
    },

    async clear(key) {
      await backend.clear(key ? seriesKey(key) : undefined);
    },
  };
}
