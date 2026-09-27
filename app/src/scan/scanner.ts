/**
 * Universe scan orchestration.
 *
 * WHERE THE TIME ACTUALLY GOES
 * Confluence over 400 bars is roughly 50k operations — the whole universe costs
 * tens of milliseconds. The bottleneck is the NETWORK: one klines request per
 * symbol, against a vendor that rate-limits. So this file is about request
 * concurrency, cancellation and honest partial failure, not about compute. A
 * worker pool here would be theatre; when the compute grows to justify one, the
 * scan function is already pure and moves across a postMessage boundary
 * unchanged.
 *
 * THREE THINGS IT REFUSES TO DO
 *  - Silently drop a symbol that failed. A screener showing 47 rows when you
 *    asked for 50, with no explanation, is lying about its coverage.
 *  - Keep writing results after the scan was superseded. Switching timeframe
 *    mid-scan used to be how stale rows from the old timeframe leaked into the
 *    new table.
 *  - Hammer the vendor. Concurrency is capped, and a 429 backs the whole scan
 *    off rather than retrying instantly per-symbol.
 */

import { confluence, toScanBars, type ConfluenceResult } from "./confluence";
import { findOpportunity, type OpportunityContext, type OpportunityRead } from "./opportunity";
import type { BarView } from "../chart/series";

export interface UniverseEntry {
  symbol: string;
  /** Quote-asset volume over the last 24h — the liquidity ranking. */
  quoteVolume: number;
  changePct: number;
  lastPrice: number;
}

export interface ScanRow {
  symbol: string;
  lastPrice: number;
  changePct: number;
  quoteVolume: number;
  result: ConfluenceResult | null;
  /**
   * Closes kept for cross-symbol work, trimmed to (time, close).
   *
   * The scan already fetched these bars; keeping the two fields correlation
   * needs costs nothing and saves a second pass over the whole universe. Full
   * `BarView` objects are NOT retained — fifty symbols of them is memory held
   * for nothing.
   */
  closes: { t: number; c: number }[] | null;
  /** Set when this symbol could not be scanned. Never silently omitted. */
  error: string | null;
  /**
   * The Setup card's answer for this symbol, or null when the scan was not
   * asked for one. A refusal is a value here, not a missing field: "no setup,
   * and here is why" is information the table shows.
   */
  opportunity?: OpportunityRead | null;
}

/**
 * Keep only what a cross-symbol comparison needs.
 *
 * The tail, because correlation over the whole scan window would be dominated
 * by whatever regime the oldest bars were in, and 200 is already well past the
 * point where the coefficient stabilises.
 */
function trim(list: readonly BarView[]): { t: number; c: number }[] {
  return list.slice(-200).map((b) => ({ t: b.t, c: b.c }));
}

export interface ScanProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order, so a table does not
 * reshuffle as slow symbols land. `signal` aborts promptly: remaining items are
 * never started.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: { signal?: AbortSignal; onSettled?: (index: number, result: R) => void } = {},
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      const result = await worker(items[index] as T, index);
      if (opts.signal?.aborted) return;
      out[index] = result;
      opts.onSettled?.(index, result);
    }
  };

  await Promise.all(Array.from({ length: width }, run));
  return out;
}

/** Thrown so the scanner can distinguish a rate-limit from an ordinary failure. */
export class RateLimited extends Error {
  constructor(public retryAfterMs: number) {
    super(`rate limited, retry in ${retryAfterMs}ms`);
    this.name = "RateLimited";
  }
}

export interface ScanDeps {
  /** All tradable symbols with 24h stats, in ONE request. */
  loadUniverse(signal?: AbortSignal): Promise<UniverseEntry[]>;
  /** History for one symbol. Throws `RateLimited` on a 429. */
  loadBars(symbol: string, interval: string, limit: number, signal?: AbortSignal): Promise<BarView[]>;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScanOptions {
  interval: string;
  /** How many symbols to scan deeply, ranked by 24h quote volume. */
  top: number;
  bars?: number;
  concurrency?: number;
  /** Only symbols whose name ends with this (e.g. "USDT"). */
  quote?: string;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  onRow?: (row: ScanRow, index: number) => void;
  /**
   * When set, every scanned symbol also runs the chart's setup pipeline. The
   * bias and conviction come from that symbol's own confluence read, so they
   * are not part of this object.
   */
  opportunity?: Omit<OpportunityContext, "bias" | "conviction">;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Scan the universe.
 *
 * Two passes on purpose: one cheap request gets 24h stats for EVERY symbol, and
 * only the top `top` by liquidity get a klines request each. Scanning the whole
 * exchange deeply would be hundreds of requests to rank symbols nobody can fill
 * a position in.
 */
export async function scanUniverse(deps: ScanDeps, opts: ScanOptions): Promise<ScanRow[]> {
  const {
    interval,
    top,
    bars = 400,
    concurrency = 6,
    quote = "USDT",
    signal,
    onProgress,
    onRow,
    opportunity,
  } = opts;
  const sleep = deps.sleep ?? defaultSleep;

  const universe = await deps.loadUniverse(signal);
  if (signal?.aborted) return [];

  const candidates = universe
    .filter((u) => (quote ? u.symbol.endsWith(quote) : true))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, top);

  let done = 0;
  let failed = 0;
  /** Set by a 429; every worker parks until it passes. */
  let backoffUntil = 0;

  const rows = await mapWithConcurrency<UniverseEntry, ScanRow>(
    candidates,
    concurrency,
    async (entry) => {
      const base: Omit<ScanRow, "result" | "error" | "closes"> = {
        symbol: entry.symbol,
        lastPrice: entry.lastPrice,
        changePct: entry.changePct,
        quoteVolume: entry.quoteVolume,
      };
      const read = (list: BarView[]): ScanRow => {
        const result = confluence(toScanBars(list));
        const row: ScanRow = { ...base, result, closes: trim(list), error: null };
        if (opportunity) {
          row.opportunity = findOpportunity(list, {
            ...opportunity,
            bias: result.insufficient ? null : result.bias,
            conviction: result.insufficient ? 0 : result.confidence,
          });
        }
        return row;
      };

      try {
        // A 429 is a statement about the whole client, not about one symbol.
        // Parking every worker is the difference between backing off and
        // retrying 6-wide into a vendor that just asked us to stop.
        const wait = backoffUntil - Date.now();
        if (wait > 0) await sleep(wait);

        const list = await deps.loadBars(entry.symbol, interval, bars, signal);
        return read(list);
      } catch (err) {
        if (err instanceof RateLimited) {
          backoffUntil = Math.max(backoffUntil, Date.now() + err.retryAfterMs);
          try {
            await sleep(err.retryAfterMs);
            const list = await deps.loadBars(entry.symbol, interval, bars, signal);
            return read(list);
          } catch (retryErr) {
            failed++;
            return { ...base, result: null, closes: null, error: message(retryErr) };
          }
        }
        failed++;
        // The row survives with its error. A screener that quietly returns 47
        // rows when you asked for 50 is lying about its coverage.
        return { ...base, result: null, closes: null, error: message(err) };
      } finally {
        done++;
        onProgress?.({ done, total: candidates.length, failed });
      }
    },
    {
      ...(signal ? { signal } : {}),
      onSettled: (index, row) => onRow?.(row, index),
    },
  );

  return signal?.aborted ? [] : rows;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Rank scanned rows.
 *
 * Sorted by conviction — |score| scaled by confidence — not by raw score. A
 * strong-looking read the engine does not trust must not outrank a moderate one
 * it does; that is the entire purpose of tracking confidence separately.
 * Un-scannable rows sort last rather than being hidden.
 */
export function rankRows(rows: readonly ScanRow[]): ScanRow[] {
  return [...rows].sort((a, b) => {
    if (!a.result && !b.result) return a.symbol.localeCompare(b.symbol);
    if (!a.result) return 1;
    if (!b.result) return -1;
    const convictionA = Math.abs(a.result.score) * a.result.confidence;
    const convictionB = Math.abs(b.result.score) * b.result.confidence;
    if (convictionB !== convictionA) return convictionB - convictionA;
    return b.quoteVolume - a.quoteVolume;
  });
}
