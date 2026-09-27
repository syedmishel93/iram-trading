/**
 * Thresholds chosen by RANK, not by magnitude.
 *
 * WHY THIS FILE EXISTS, AND WHY THE PREVIOUS FIX WAS ONLY HALF OF ONE
 *
 * The detectors' thresholds started as constant shares of price — 0.004 for a
 * swing, 0.012 for a displacement candle. A constant share of price is not a
 * constant amount of market, so gold got zero detections where Bitcoin got
 * nine, and `detect/pivots.ts` says so at length.
 *
 * The fix was to express each threshold as a multiple of the series' own mean
 * bar range: `SWING_NOISE_MULTIPLE = 4`, `DISPLACEMENT_NOISE_MULTIPLE = 3`.
 * That made them transfer across INSTRUMENTS, which was the reported bug, and
 * it was calibrated on one-minute bars from two symbols. It does not transfer
 * across TIMEFRAMES, and here is the measurement that says so — same
 * instrument, same detectors, only the timeframe changed:
 *
 *                       XAUUSD 1m          XAUUSD 1h
 *   mean bar range      0.038% of price    0.438% of price
 *   x4 swing floor      0.15%              1.75%
 *   confirmed pivots    55                  7
 *   head & shoulders    6                   0
 *   double top/bottom   -                   0
 *   divergence          5                   0
 *
 * At x2 the same 1h series yields 67 pivots, 6 head-and-shoulders, 31 doubles
 * and 4 divergences. Nothing about the market changed between those two rows;
 * the number 4 simply happened to be right for one-minute bars. Order blocks
 * were worse: x3 on the hourly asks for a body of 1.31% when the LARGEST body
 * in 537 bars is 1.70% and the 99th percentile is 0.93% — the threshold sat
 * above the 99th percentile of the distribution it was filtering, so it
 * returned nothing, and took breaker blocks with it.
 *
 * A multiple of a mean is still a magnitude, and every magnitude needs to be
 * recalibrated for every timeframe by hand. A RANK does not: "the strongest
 * fifty swings", "a body in the top decile", "a gap in the top quarter of gaps
 * this series actually left" mean the same thing on gold, on Bitcoin, on the
 * minute and on the day, because they are defined against the series' own
 * distribution rather than against a number somebody chose.
 *
 * What this deliberately does NOT do is guarantee detections. If a series has
 * no swings worth the name, the rank is taken over a distribution that is
 * uniformly small and the noise floor below still rejects it. The rank sets
 * WHERE the cut falls; the floor decides whether anything survives it.
 */

/**
 * The `q`-quantile of a sample, by linear interpolation.
 *
 * Sorts a copy: callers pass arrays they still need, and a threshold helper
 * that reorders its input is a bug waiting for a caller who reuses the buffer.
 */
export function quantile(values: readonly number[], q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0] as number;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  if (lo === hi) return a;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/**
 * The value at rank `k` counting down from the largest, 1-based.
 *
 * `nthLargest(xs, 50)` is "the 50th strongest", which is how a target count is
 * stated. Returns 0 when fewer than `k` samples exist — the caller then has
 * every sample it is going to get and should keep them all.
 */
export function nthLargest(values: readonly number[], k: number): number {
  if (k <= 0 || values.length < k) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[k - 1] as number;
}

/** A body's size as a share of its open, for every bar in the window. */
export function bodyShares(
  open: Float64Array,
  close: Float64Array,
  len = close.length,
  window = 400,
): number[] {
  const to = Math.min(len, close.length);
  const from = Math.max(0, to - window);
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const o = open[i] as number;
    if (!(o > 0)) continue;
    const share = Math.abs((close[i] as number) - o) / o;
    if (Number.isFinite(share)) out.push(share);
  }
  return out;
}

/**
 * The three-bar gaps this series actually left, as shares of price.
 *
 * Only the gaps: bars that overlap their neighbour two back contribute nothing,
 * and including them as zeroes would drag every quantile toward zero in
 * proportion to how ORDERLY the series is — the opposite of what a threshold
 * for "a gap worth marking" should do.
 */
export function gapShares(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  len = close.length,
  window = 400,
): number[] {
  const to = Math.min(len, close.length);
  const from = Math.max(2, to - window);
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const px = close[i] as number;
    if (!(px > 0)) continue;
    const up = (low[i] as number) - (high[i - 2] as number);
    const down = (low[i - 2] as number) - (high[i] as number);
    const gap = Math.max(up, down);
    if (gap > 0) out.push(gap / px);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CONFIDENCE, AND THE HALF OF THE v49 FIX THAT WAS NEVER DONE
 *
 * Everything above made a detector's THRESHOLDS transfer across instruments
 * and timeframes. Nothing was ever done about its CONFIDENCE, and the two are
 * the same bug wearing different clothes. Measured on live 1h bars, same
 * detectors, only the instrument changed:
 *
 *                        XAUUSD          ETHUSDT
 *   fair value gaps      mean 0.46       mean 0.72
 *   order blocks         mean 0.45       mean 0.67
 *   S/R levels           1.00 (6 of 6)   1.00 (6 of 6)
 *   trendlines           1.00 (2 of 2)   1.00 (2 of 2)
 *
 * The first two rows are `sqrt(size / 0.02)` and `abs(move) / 0.05` — shares
 * of PRICE, exactly the constants this file exists to argue against. Gold is
 * quieter than Ethereum, so gold's structures were reported as less certain
 * for no reason but the instrument's volatility. The confidence FILTER
 * ("0.6+") therefore meant something different on every symbol, and a screener
 * ranking candidates by confidence was ranking them by volatility.
 *
 * The last two rows are worse: `0.25 + (touches - 1) * 0.15 + recency * 0.3`
 * and `0.3 + (touches - 2) * 0.2` are unbounded, so four touches already
 * saturates them. Every level and every trendline on both instruments reported
 * exactly 1.00 — a constant, carrying no information, published as certainty.
 * And `detectLevels` SORTS by that value before slicing to `maxLevels`, so it
 * was choosing arbitrarily among ties.
 *
 * Two rules follow, and `saturate` exists to make both easy:
 *
 *   1. Every input to a confidence is measured in ATR, or is already
 *      dimensionless (a count, a ratio, a share of a range).
 *   2. No term is unbounded. A linear term inside a `clamp01` is a bug that
 *      does not look like one, because the clamp makes it appear handled.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Diminishing returns on a positive quantity: 0 at 0, 0.5 at `half`, and
 * approaching 1 without ever reaching it.
 *
 * Asymptotic rather than clamped, so a weighted sum whose weights total less
 * than 1 can never produce certainty however extreme its inputs. That is the
 * property being bought: nothing in this directory is entitled to report 1.00.
 *
 * `half` is where the curve crosses the middle, which makes it the one number
 * a reader has to judge — "half the credit at three touches" is a claim
 * somebody can disagree with, unlike a coefficient of 0.15.
 */
export function saturate(value: number, half: number): number {
  if (!(value > 0) || !(half > 0)) return 0;
  /* Bounded explicitly, because the mathematics and the arithmetic disagree at
     the extremes: `x / (x + k)` with x around 9e15 and k = 0.001 rounds to
     exactly 1.0 in a double. The asymptote is the whole contract, so it is
     enforced rather than assumed — this helper's own test caught it. */
  return Math.min(value / (value + half), CEILING);
}

/**
 * The most any single saturating term may contribute, as a fraction of itself.
 *
 * Far enough below 1 to survive being multiplied by a weight and summed, and
 * close enough that no reader will ever see the difference.
 */
const CEILING = 1 - 1e-9;
