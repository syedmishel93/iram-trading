/**
 * Multi-timeframe detection — higher-timeframe structure on a lower-timeframe chart.
 *
 * THE ONLY HARD PART IS NOT THE AGGREGATION
 * Building 4h bars from 1h bars is arithmetic. The part that goes wrong, in
 * almost every implementation of this feature, is WHEN a higher-timeframe
 * structure becomes knowable.
 *
 * A 4h break of structure that completes on the 4h bar covering 12:00–16:00 is
 * not knowable at 12:00. It is not knowable at 15:00 either. It is knowable at
 * 16:00, when that bar closes — and drawing it back at 12:00, which is where
 * the aggregated bar "starts", silently backdates every higher-timeframe signal
 * by up to one full higher-timeframe bar. On a 1h chart with 4h structure that
 * is a three-hour head start the live market never gave you, and it is enough
 * to turn a losing backtest into a winning one.
 *
 * So every projected detection's `to` — the bar at which it became knowable —
 * maps to the LOWER-timeframe bar that CLOSED the higher-timeframe bar. The
 * geometry may be drawn from the aggregated bar's start; the confirmation may
 * not.
 *
 * BOUNDARIES ARE ALIGNED TO THE CLOCK, NOT TO THE ARRAY
 * Grouping "every 4 bars from wherever the array happens to begin" produces 4h
 * candles running 13:00–17:00 on one load and 12:00–16:00 on the next, so the
 * structure moves when you scroll. Buckets are floor(t / htfMs) — the same
 * boundaries every exchange and every other chart uses.
 *
 * INCOMPLETE BUCKETS ARE DROPPED
 * The newest higher-timeframe bar is nearly always still forming, and its
 * "close" is just the current price. Feeding it to a detector that confirms on
 * close is the same mistake the single-timeframe path already refuses to make.
 */

import { runDetectors, type DetectorId } from "./index";
import type { Detection, DetectInput, Shape } from "./types";

/** The higher timeframes offered for a given chart timeframe. */
const LADDER: Readonly<Record<string, readonly string[]>> = {
  "1m": ["5m", "15m", "1h"],
  "3m": ["15m", "1h", "4h"],
  "5m": ["15m", "1h", "4h"],
  "15m": ["1h", "4h", "1d"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w"],
  /**
   * `1w` and `1M` deliberately have no higher timeframe, and `1M` is never
   * OFFERED as one.
   *
   * Aggregation here buckets by `floor(t / htfMs)`, which is only correct when
   * the higher timeframe is a fixed multiple of a millisecond. Calendar months
   * are not — they run 28 to 31 days — so a monthly bucket built that way
   * would slide a little further off the real month boundary every quarter and
   * confirm structure against bars that never existed. A monthly chart is
   * still fully usable; it just has nothing above it to confirm against, which
   * is the honest answer rather than a wrong one.
   */
  "1w": [],
  "1M": [],
};

export function higherTimeframes(timeframe: string): readonly string[] {
  return LADDER[timeframe] ?? [];
}

/**
 * Milliseconds in a timeframe, or 0 when it cannot be bucketed uniformly.
 *
 * Returns 0 for `"M"` ON PURPOSE, and checks it first so it cannot fall
 * through to the minute branch. Zero is read everywhere here as "do not
 * aggregate", which is the correct behaviour for a calendar month; the same
 * fallthrough in `intervalMs` silently returned one hour instead.
 */
export function tfMs(timeframe: string): number {
  const n = parseInt(timeframe, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (timeframe.endsWith("M")) return 0;
  if (timeframe.endsWith("m")) return n * 60_000;
  if (timeframe.endsWith("h")) return n * 3_600_000;
  if (timeframe.endsWith("d")) return n * 86_400_000;
  if (timeframe.endsWith("w")) return n * 604_800_000;
  return 0;
}

export interface Aggregated {
  bars: DetectInput;
  /** LTF index of the first bar in each aggregated bar. */
  openIndex: number[];
  /**
   * LTF index of the LAST bar in each aggregated bar.
   *
   * The confirmation clock. Everything the higher timeframe learns on bar `k`
   * is learned at `closeIndex[k]` in lower-timeframe terms, never earlier.
   */
  closeIndex: number[];
}

const EMPTY: Aggregated = {
  bars: {
    t: new Float64Array(0),
    o: new Float64Array(0),
    h: new Float64Array(0),
    l: new Float64Array(0),
    c: new Float64Array(0),
    v: new Float64Array(0),
  },
  openIndex: [],
  closeIndex: [],
};

/**
 * The lower timeframe's own bar interval, inferred from the data.
 *
 * The smallest positive gap, not the mean: a series with weekend holes has a
 * mean far larger than its true step, and a step guessed too large would call
 * every bucket complete.
 */
function ltfStep(data: DetectInput, n: number): number {
  let step = Infinity;
  for (let i = 1; i < n; i++) {
    const d = (data.t[i] as number) - (data.t[i - 1] as number);
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 0;
}

/**
 * Aggregate `data` into buckets of `htfMs`, clock-aligned.
 *
 * `len` is the number of CLOSED lower-timeframe bars to consider; anything
 * beyond it is still forming and is not evidence of anything.
 */
export function aggregate(data: DetectInput, htfMs: number, len = data.c.length): Aggregated {
  const n = Math.min(len, data.c.length);
  if (htfMs <= 0 || n === 0) return EMPTY;

  const t: number[] = [];
  const o: number[] = [];
  const hi: number[] = [];
  const lo: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  const openIndex: number[] = [];
  const closeIndex: number[] = [];

  let bucket = NaN;
  for (let i = 0; i < n; i++) {
    const time = data.t[i] as number;
    const b = Math.floor(time / htfMs) * htfMs;

    if (b !== bucket) {
      bucket = b;
      t.push(b);
      o.push(data.o[i] as number);
      hi.push(data.h[i] as number);
      lo.push(data.l[i] as number);
      c.push(data.c[i] as number);
      v.push(data.v[i] as number);
      openIndex.push(i);
      closeIndex.push(i);
      continue;
    }

    const k = t.length - 1;
    hi[k] = Math.max(hi[k] as number, data.h[i] as number);
    lo[k] = Math.min(lo[k] as number, data.l[i] as number);
    c[k] = data.c[i] as number;
    v[k] = (v[k] as number) + (data.v[i] as number);
    closeIndex[k] = i;
  }

  /**
   * Trim buckets that are not whole, at BOTH ends.
   *
   * The newest is the obvious one: it is nearly always still filling, and its
   * close is just the current price — the forming-bar problem, one timeframe up.
   *
   * The oldest matters too and is easier to miss. History that begins at 13:00
   * puts three hours into the 12:00 bucket, whose "open" is then 13:00's open
   * rather than the 4h open, and whose high and low are missing an hour. Every
   * detector reading that first bar reads a candle that never existed.
   *
   * Completeness is judged against the inferred lower-timeframe step: a bucket
   * is whole when its last bar's own interval reaches the bucket's end.
   */
  const step = ltfStep(data, n);
  const dropAt = (k: number): void => {
    t.splice(k, 1);
    o.splice(k, 1);
    hi.splice(k, 1);
    lo.splice(k, 1);
    c.splice(k, 1);
    v.splice(k, 1);
    openIndex.splice(k, 1);
    closeIndex.splice(k, 1);
  };

  const lastK = t.length - 1;
  if (lastK >= 0) {
    const open = t[lastK] as number;
    const lastBarTime = data.t[closeIndex[lastK] as number] as number;
    if (lastBarTime + step < open + htfMs) dropAt(lastK);
  }
  if (t.length > 0) {
    const open = t[0] as number;
    const firstBarTime = data.t[openIndex[0] as number] as number;
    if (firstBarTime > open) dropAt(0);
  }

  return {
    bars: {
      t: Float64Array.from(t),
      o: Float64Array.from(o),
      h: Float64Array.from(hi),
      l: Float64Array.from(lo),
      c: Float64Array.from(c),
      v: Float64Array.from(v),
    },
    openIndex,
    closeIndex,
  };
}

/**
 * Map a higher-timeframe x coordinate into lower-timeframe index space.
 *
 * Fractional inputs are interpolated across the bar's span, so a shape anchored
 * mid-bar lands mid-bar rather than snapping to an edge and shearing the slope
 * of a projected trendline.
 */
export function projectX(x: number, agg: Aggregated): number {
  const last = agg.openIndex.length - 1;
  if (last < 0) return 0;
  const i = Math.max(0, Math.min(last, Math.floor(x)));
  const open = agg.openIndex[i] as number;
  const close = agg.closeIndex[i] as number;
  const frac = x - i;
  if (frac <= 0) return open;
  // Past the last aggregated bar, keep the slope going at the bar's own width
  // rather than clamping — a projected line must reach the live edge.
  const width = close - open + 1;
  return open + frac * width;
}

function projectShape(shape: Shape, agg: Aggregated): Shape {
  switch (shape.type) {
    case "box":
      return { ...shape, x0: projectX(shape.x0, agg), x1: projectX(shape.x1, agg) };
    case "line":
      return { ...shape, x0: projectX(shape.x0, agg), x1: projectX(shape.x1, agg) };
    case "level":
      return { ...shape, x0: projectX(shape.x0, agg) };
    case "marker":
      return { ...shape, x: projectX(shape.x, agg) };
  }
}

export interface MtfDetection extends Detection {
  /** The timeframe this was found on, e.g. "4h". */
  timeframe: string;
}

/**
 * Run detectors on a higher timeframe and project the results down.
 *
 * The returned detections are in LOWER-timeframe index space and can be drawn,
 * listed, or anchored to by an alert exactly like a native one.
 */
export function detectHigher(
  data: DetectInput,
  htfLabel: string,
  enabled: readonly DetectorId[],
  len = data.c.length,
): MtfDetection[] {
  const htfMs = tfMs(htfLabel);
  if (htfMs <= 0 || enabled.length === 0) return [];

  const agg = aggregate(data, htfMs, len);
  // Detectors need swings to work with; below this there is nothing to find and
  // whatever they did report would be an artefact of the short window.
  if (agg.bars.c.length < 30) return [];

  const found = runDetectors(agg.bars, enabled, agg.bars.c.length);

  return found.map((d) => ({
    ...d,
    id: `${htfLabel}:${d.id}`,
    timeframe: htfLabel,
    // The label carries the timeframe because a 4h break of structure and a 1h
    // one are different claims, and a list that shows both without saying which
    // is which is worse than showing neither.
    label: `${htfLabel.toUpperCase()} · ${d.label}`,
    from: (agg.openIndex[Math.min(d.from, agg.openIndex.length - 1)] as number) ?? 0,
    // THE LOOK-AHEAD GUARANTEE. Knowable when the higher-timeframe bar CLOSED.
    to: (agg.closeIndex[Math.min(d.to, agg.closeIndex.length - 1)] as number) ?? 0,
    reason: `${d.reason} (on the ${htfLabel} timeframe)`,
    shapes: d.shapes.map((sh) => projectShape(sh, agg)),
  }));
}
