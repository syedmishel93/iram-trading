/**
 * Swing pivots — the foundation every structural detector stands on.
 *
 * A pivot high is a bar whose high exceeds the `left` bars before it and the
 * `right` bars after it. The asymmetry matters and is the single most important
 * thing about this file:
 *
 *   A PIVOT IS NOT CONFIRMED UNTIL `right` BARS HAVE CLOSED AFTER IT.
 *
 * Detectors that ignore this "discover" a swing high on the live bar, draw a
 * structure break from it, and then silently un-draw it two bars later. Worse,
 * a backtest built on unconfirmed pivots is reading the future: at bar i it
 * uses information from bars i+1..i+right that had not happened yet. That is
 * the most common way a chart-pattern backtest produces impossible returns.
 *
 * So every pivot carries `confirmedAt`, and anything consuming pivots for a
 * historical decision must compare against that, not against `index`.
 */

import { nthLargest } from "./calibrate";

export type PivotKind = "high" | "low";

export interface Pivot {
  kind: PivotKind;
  /** Bar index of the extreme itself. */
  index: number;
  price: number;
  /** Bar index at which this pivot became knowable: `index + right`. */
  confirmedAt: number;
  /** How far price travelled away from the pivot, as a share of price. */
  prominence: number;
}

export interface PivotOptions {
  /** Bars that must be lower/higher before the pivot. */
  left?: number;
  /** Bars that must be lower/higher after it — also the confirmation lag. */
  right?: number;
  /** Drop pivots whose prominence is below this share of price (0.002 = 0.2%). */
  minProminence?: number;
}

/**
 * Find confirmed swing pivots.
 *
 * `len` defaults to the full series. Pass a smaller `len` to evaluate the
 * series as it stood at an earlier bar — which is how a backtest asks "what
 * was knowable then?" without the detector cheating.
 */
export function findPivots(
  high: Float64Array,
  low: Float64Array,
  opts: PivotOptions = {},
  len = high.length,
): Pivot[] {
  const left = Math.max(1, opts.left ?? 3);
  const right = Math.max(1, opts.right ?? 3);
  const minProminence = opts.minProminence ?? 0;

  const out: Pivot[] = [];
  if (len < left + right + 1) return out;

  for (let i = left; i < len - right; i++) {
    const h = high[i] as number;
    const l = low[i] as number;

    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      // `>=` on the left and `>` on the right breaks ties toward the EARLIER
      // bar of a flat top, so a plateau yields one pivot rather than several.
      if (isHigh && (j < i ? (high[j] as number) >= h : (high[j] as number) > h)) isHigh = false;
      if (isLow && (j < i ? (low[j] as number) <= l : (low[j] as number) < l)) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      const p = prominence(high, low, i, left, right, len, "high");
      if (p >= minProminence) {
        out.push({ kind: "high", index: i, price: h, confirmedAt: i + right, prominence: p });
      }
    }
    if (isLow) {
      const p = prominence(high, low, i, left, right, len, "low");
      if (p >= minProminence) {
        out.push({ kind: "low", index: i, price: l, confirmedAt: i + right, prominence: p });
      }
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/** How far price retraced from the pivot within its window, as a share of price. */
function prominence(
  high: Float64Array,
  low: Float64Array,
  i: number,
  left: number,
  right: number,
  len: number,
  kind: PivotKind,
): number {
  const from = Math.max(0, i - left);
  const to = Math.min(len - 1, i + right);
  if (kind === "high") {
    const peak = high[i] as number;
    let deepest = peak;
    for (let j = from; j <= to; j++) {
      const v = low[j] as number;
      if (v < deepest) deepest = v;
    }
    return peak > 0 ? (peak - deepest) / peak : 0;
  }
  const trough = low[i] as number;
  let highest = trough;
  for (let j = from; j <= to; j++) {
    const v = high[j] as number;
    if (v > highest) highest = v;
  }
  return trough > 0 ? (highest - trough) / trough : 0;
}

/**
 * Alternate the pivot sequence high/low/high/low.
 *
 * Raw pivots can run high-high-high in a staircase. Structure logic needs a
 * strict alternation, so consecutive same-kind pivots collapse to the most
 * extreme one — the lower high in a run of highs is not a swing, it is noise
 * inside the same leg.
 */
export function alternate(pivots: readonly Pivot[]): Pivot[] {
  const out: Pivot[] = [];
  for (const p of pivots) {
    const last = out[out.length - 1];
    if (!last || last.kind !== p.kind) {
      out.push(p);
      continue;
    }
    const replace = p.kind === "high" ? p.price > last.price : p.price < last.price;
    if (replace) out[out.length - 1] = p;
  }
  return out;
}

/** The most recent confirmed pivot of each kind at or before `atIndex`. */
export function lastPivots(
  pivots: readonly Pivot[],
  atIndex: number,
): { high: Pivot | null; low: Pivot | null } {
  let high: Pivot | null = null;
  let low: Pivot | null = null;
  for (const p of pivots) {
    // `confirmedAt`, not `index`: a pivot whose right-hand bars have not closed
    // yet was not knowable at `atIndex`.
    if (p.confirmedAt > atIndex) break;
    if (p.kind === "high") high = p;
    else low = p;
  }
  return { high, low };
}

/* ────────────────────────────────────────────────────────────────────────────
 * A SWING THRESHOLD THAT MEANS THE SAME THING ON EVERY INSTRUMENT
 *
 * `minProminence` is a share of PRICE, and every caller passed a constant —
 * 0.004 for the formation detectors, 0.001–0.002 for structure. A constant
 * share of price is not a constant amount of market. Measured on 810 bars of
 * each, same timeframe, near-identical total range (1.94% and 2.19%):
 *
 *     minProminence 0.004     BTCUSDT 1m   9 pivots   → 2 trendlines, 1 double
 *                             XAUUSD 1m    0 pivots   → nothing, ever
 *
 * Six of the thirteen detectors stand on these pivots — trendlines, double
 * top/bottom, head & shoulders among them — so on gold they returned an empty
 * array on every load, silently, with no error and no explanation. From the
 * operator's side that is indistinguishable from a broken feature, and it was
 * reported as one.
 *
 * The fix is the argument this repository already makes in `plan.ts` about
 * `REDRAW_ATR`: "the threshold is in ATR so it means the same thing on gold
 * and on a memecoin". A swing is a move that stands clear of the noise, and
 * the noise is measured, not assumed.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Typical bar range as a share of price — the local unit of "noise".
 *
 * A mean of true ranges rather than a Wilder ATR: this is a scale factor for a
 * threshold, not a published indicator, and the smoothing constant would be
 * one more arbitrary number to defend. Sampled over the recent window because
 * a threshold for finding today's swings should be set by today's volatility.
 */
export function noiseShare(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  len = close.length,
  window = 200,
): number {
  const to = Math.min(len, close.length);
  const from = Math.max(1, to - window);
  if (to - from < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const prev = close[i - 1] as number;
    const tr = Math.max(
      (high[i] as number) - (low[i] as number),
      Math.abs((high[i] as number) - prev),
      Math.abs((low[i] as number) - prev),
    );
    const px = close[i] as number;
    if (px > 0 && Number.isFinite(tr)) {
      sum += tr / px;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * The prominence floor for a swing, in multiples of the series' own noise.
 *
 * Falls back to `fallback` when the series is too short or too degenerate to
 * measure — a zero floor would accept every one-bar wiggle as a swing, which
 * is the opposite failure and a noisier one.
 */
export function prominenceFloor(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  atrMultiple: number,
  fallback: number,
  len = close.length,
): number {
  const share = noiseShare(high, low, close, len);
  return share > 0 ? share * atrMultiple : fallback;
}

/* ────────────────────────────────────────────────────────────────────────────
 * AND THE SAME THRESHOLD, CHOSEN BY RANK
 *
 * `prominenceFloor` above made the swing threshold transfer across
 * instruments. It does not transfer across timeframes: the multiple that gives
 * 55 pivots on XAUUSD 1m gives 7 on XAUUSD 1h, and 7 alternating pivots cannot
 * form a head and shoulders, a double top or a divergence — which is exactly
 * which four detectors came back empty on the hourly chart.
 *
 * `swingFloor` asks for a COUNT instead. See detect/calibrate.ts for the
 * measurement and the argument.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One swing per this many bars is the target density.
 *
 * Eight, from the measurement: 537 hourly bars of gold gives 67 pivots, which
 * is the floor at which head-and-shoulders, doubles and divergence all come
 * back and none of them floods. Denser than about one in five and the
 * detectors start finding patterns inside single legs; sparser than about one
 * in twelve and the multi-pivot formations run out of pivots to work with.
 */
export const SWING_TARGET_PER_BARS = 8;

/**
 * A swing must clear at least this much of the local noise whatever its rank.
 *
 * The rank decides where the cut falls in the distribution; this decides
 * whether the distribution is worth cutting at all. Without it a series that
 * has genuinely gone flat — a halted market, a synthetic constant — hands its
 * strongest tick-sized wiggles to every detector as if they were structure.
 */
export const SWING_NOISE_FLOOR = 1;

/**
 * The prominence floor that yields roughly `len / targetPerBars` confirmed
 * pivots on THIS series.
 *
 * Costs one extra pivot pass. That pass is a linear scan over a Float64Array
 * with a bounded inner window, it runs when a bar closes rather than per
 * frame, and it is what makes every downstream threshold timeframe-agnostic.
 */
export function swingFloor(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  len = close.length,
  opts: { left?: number; right?: number; targetPerBars?: number } = {},
): number {
  const noise = noiseShare(high, low, close, len) * SWING_NOISE_FLOOR;
  const target = Math.max(4, Math.round(len / (opts.targetPerBars ?? SWING_TARGET_PER_BARS)));
  const raw = findPivots(
    high,
    low,
    { left: opts.left ?? 3, right: opts.right ?? 3, minProminence: noise },
    len,
  );
  /* Fewer candidates than we wanted: every one of them survives, and the noise
     floor is the only thing filtering. Returning a rank we cannot fill would
     round down to the weakest sample and reject nothing anyway — this just
     says so. */
  const rank = nthLargest(
    raw.map((p) => p.prominence),
    target,
  );
  return Math.max(noise, rank);
}
