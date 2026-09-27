/**
 * What can honestly be forecast, and what cannot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REFUSAL, FIRST, BECAUSE IT IS THE POINT OF THE FILE
 *
 * There is no next-candle direction call here and there will not be one. One
 * bar ahead is where the signal-to-noise ratio is at its worst: the horizon is
 * as short as it can be, the noise is undiminished, and every honest study of
 * it lands within a point or two of a coin flip. A terminal that prints
 * "next candle: UP 71%" is not more powerful than one that does not — it is
 * converting its own noise into your position size, which is the single most
 * expensive thing a tool like this can do to somebody.
 *
 * `data/intel.ts` already carries the defensible version of a directional
 * model: a walk-forward classifier over a 24-bar horizon that reports its
 * measured out-of-sample accuracy and Brier score, and says 53% when it is
 * 53%. Nothing here competes with it or dresses it up.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS GENUINELY FORECASTABLE
 *
 * **Volatility.** It clusters — the most robust regularity in market data, and
 * one that survives every market, timeframe and decade it has been tested on.
 * Big ranges follow big ranges. That is a real, exploitable statement about
 * the future and it says NOTHING about direction, which is precisely why it
 * can be said honestly.
 *
 * So this forecasts the next bar's RANGE, as an interval with a stated
 * confidence, and then — this is the part that matters — it checks its own
 * work. `calibration` replays every forecast the model would have made over
 * the loaded history and reports how often the interval actually contained the
 * outcome. An 80% interval that contains 63% of outcomes is a broken model,
 * and the only way anybody finds that out is if the tool says so.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EWMA AND NOT GARCH
 *
 * GARCH(1,1) is the better model and it needs a fitting routine — that belongs
 * in `server/`, next to the scikit-learn already there, and would make this
 * feature depend on an optional local process. EWMA with a fixed decay is the
 * special case of GARCH with no mean reversion, it is what RiskMetrics used
 * for exactly this purpose, it needs no fitting, and the calibration check
 * below will report honestly if it is not good enough.
 *
 * A model whose errors are measured and shown is worth more than a better
 * model whose errors are not.
 */

import type { BarView } from "../chart/series";

/**
 * EWMA decay.
 *
 * 0.94 is the RiskMetrics daily figure and is used here for every timeframe,
 * deliberately: a decay tuned per timeframe on this user's own history would
 * be a parameter fitted to the sample the forecast is then scored on. The
 * calibration report says whether it is good enough, which is a better answer
 * than a fitted constant nobody can check.
 */
export const EWMA_LAMBDA = 0.94;

/** Bars needed before any of this means anything. */
export const MIN_BARS = 120;

export interface RangeForecast {
  /** Expected absolute move over the next bar, in price. */
  readonly expected: number;
  /** Interval bounds on the next CLOSE, at `confidence`. */
  readonly low: number;
  readonly high: number;
  /** Nominal confidence, 0..1. */
  readonly confidence: number;
  /** Forecast volatility as a share of price. */
  readonly sigma: number;
  /** Where this sigma sits against its own trailing history, 0..1. */
  readonly percentile: number;
  /** Bars the estimate was built from. */
  readonly n: number;
}

/**
 * EWMA volatility of log returns, as a share of price.
 *
 * Seeded with the sample standard deviation of the first window rather than
 * with the first squared return: a single-observation seed takes hundreds of
 * bars to wash out, and every forecast in between is measuring the seed.
 */
export function ewmaSigma(bars: readonly BarView[], lambda = EWMA_LAMBDA): number {
  const n = bars.length;
  if (n < 30) return NaN;

  const r: number[] = [];
  for (let i = 1; i < n; i++) {
    const p0 = (bars[i - 1] as BarView).c;
    const p1 = (bars[i] as BarView).c;
    if (p0 > 0 && p1 > 0) r.push(Math.log(p1 / p0));
  }
  if (r.length < 30) return NaN;

  const seedWindow = Math.min(30, r.length);
  let mean = 0;
  for (let i = 0; i < seedWindow; i++) mean += r[i] as number;
  mean /= seedWindow;
  let variance = 0;
  for (let i = 0; i < seedWindow; i++) {
    const d = (r[i] as number) - mean;
    variance += d * d;
  }
  variance /= seedWindow;

  for (let i = seedWindow; i < r.length; i++) {
    const x = r[i] as number;
    variance = lambda * variance + (1 - lambda) * x * x;
  }
  return Math.sqrt(variance);
}

/**
 * Quantile of the empirical distribution of standardised returns.
 *
 * NOT a normal quantile, and that is the whole reason this function exists.
 * Returns have fat tails: a Gaussian 95% interval is systematically too narrow
 * on every financial series ever measured, so a model that used 1.96 sigma
 * would report 95% and deliver about 90% — and would look fine on a chart. The
 * empirical quantile takes the fatness from the data itself.
 */
function empiricalQuantile(standardised: readonly number[], p: number): number {
  if (standardised.length === 0) return NaN;
  const s = [...standardised].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[idx] as number;
}

/** Standardised returns: each log return divided by the volatility known BEFORE it. */
function standardisedReturns(bars: readonly BarView[], lambda: number): number[] {
  const out: number[] = [];
  for (let i = MIN_BARS; i < bars.length; i++) {
    /* Volatility from bars STRICTLY BEFORE i. Using a sigma that included bar
       i would standardise each return by a number that already knew it, and
       the intervals would look flawless and mean nothing. */
    const sigma = ewmaSigma(bars.slice(0, i), lambda);
    if (!Number.isFinite(sigma) || sigma <= 0) continue;
    const p0 = (bars[i - 1] as BarView).c;
    const p1 = (bars[i] as BarView).c;
    if (p0 <= 0 || p1 <= 0) continue;
    out.push(Math.log(p1 / p0) / sigma);
  }
  return out;
}

/**
 * Forecast the next bar's range.
 *
 * Returns null rather than a wide guess when there is not enough history: an
 * interval nobody can check is worse than no interval, because it looks
 * exactly like one that has been checked.
 */
export function forecastRange(
  bars: readonly BarView[],
  confidence = 0.8,
  lambda = EWMA_LAMBDA,
): RangeForecast | null {
  const n = bars.length;
  if (n < MIN_BARS) return null;

  const sigma = ewmaSigma(bars, lambda);
  if (!Number.isFinite(sigma) || sigma <= 0) return null;

  const price = (bars[n - 1] as BarView).c;
  if (!(price > 0)) return null;

  /* Standardised over a bounded tail rather than the whole series: the shape
     of the return distribution is not stable over years, and the recent shape
     is the one the next bar is drawn from. */
  const std = standardisedReturns(bars.slice(-Math.min(n, 1500)), lambda);
  if (std.length < 60) return null;

  const alpha = (1 - confidence) / 2;
  const qLo = empiricalQuantile(std, alpha);
  const qHi = empiricalQuantile(std, 1 - alpha);
  if (!Number.isFinite(qLo) || !Number.isFinite(qHi)) return null;

  /* Percentile of the current sigma against its own trailing history, so the
     UI can say "quiet" or "violent" without inventing a threshold. */
  const window = Math.min(250, n - MIN_BARS);
  let below = 0;
  let seen = 0;
  for (let i = n - window; i < n; i++) {
    const s2 = ewmaSigma(bars.slice(0, i), lambda);
    if (!Number.isFinite(s2)) continue;
    seen++;
    if (s2 < sigma) below++;
  }

  return {
    expected: price * sigma,
    low: price * Math.exp(qLo * sigma),
    high: price * Math.exp(qHi * sigma),
    confidence,
    sigma,
    percentile: seen === 0 ? 0.5 : below / seen,
    n,
  };
}

/* ────────────────────────────────────────────────────────────── calibration */

export interface CalibrationBucket {
  /** Nominal confidence this bucket was forecast at. */
  readonly nominal: number;
  /** Share of outcomes that actually fell inside. */
  readonly realised: number;
  readonly n: number;
}

export interface Calibration {
  readonly buckets: readonly CalibrationBucket[];
  /**
   * Mean absolute gap between nominal and realised, 0..1.
   *
   * The single number that says whether the model can be believed. Under
   * `GOOD_ENOUGH` the intervals mean roughly what they say.
   */
  readonly error: number;
  readonly usable: boolean;
  readonly note: string;
}

/** Mean miscalibration under this and the intervals mean what they say. */
export const GOOD_ENOUGH = 0.05;

/** Forecasts needed before calibration is itself measurable. */
export const MIN_CALIBRATION_SAMPLE = 100;

const LEVELS = [0.5, 0.8, 0.95] as const;

/**
 * Replay the model over its own history and report how often it was right.
 *
 * THIS IS THE FEATURE. A forecast without one of these is a claim; with one it
 * is a measurement. No retail platform ships it, and the reason is uncomfortable
 * rather than technical: for most published indicators the honest version of
 * this plot is flat.
 *
 * Walk-forward by construction — every interval is built from bars strictly
 * before the one it is scored against, which is what `standardisedReturns`
 * enforces and why it is slow enough to be worth doing once rather than per
 * frame.
 */
export function calibration(bars: readonly BarView[], lambda = EWMA_LAMBDA): Calibration {
  const n = bars.length;
  if (n < MIN_BARS + MIN_CALIBRATION_SAMPLE) {
    return {
      buckets: [],
      error: 1,
      usable: false,
      note: `${n} bars — under ${MIN_BARS + MIN_CALIBRATION_SAMPLE}, there is not enough history to check the model against itself.`,
    };
  }

  /* One pass, reusing the standardised returns: an interval at confidence c
     contains the outcome exactly when the standardised return falls between
     the two quantiles, so the whole replay is a comparison against the
     distribution's own tails. The quantiles are taken from the FIRST half and
     scored on the second, so no interval is checked against a distribution
     that already contains it. */
  const std = standardisedReturns(bars, lambda);
  if (std.length < MIN_CALIBRATION_SAMPLE) {
    return {
      buckets: [],
      error: 1,
      usable: false,
      note: `${std.length} usable forecasts — under ${MIN_CALIBRATION_SAMPLE}, calibration cannot be measured.`,
    };
  }

  const split = Math.floor(std.length / 2);
  const fit = std.slice(0, split);
  const score = std.slice(split);

  const buckets: CalibrationBucket[] = [];
  let totalError = 0;

  for (const nominal of LEVELS) {
    const alpha = (1 - nominal) / 2;
    const lo = empiricalQuantile(fit, alpha);
    const hi = empiricalQuantile(fit, 1 - alpha);
    let inside = 0;
    for (const x of score) if (x >= lo && x <= hi) inside++;
    const realised = score.length === 0 ? 0 : inside / score.length;
    buckets.push({ nominal, realised, n: score.length });
    totalError += Math.abs(realised - nominal);
  }

  const error = totalError / LEVELS.length;
  const usable = error <= GOOD_ENOUGH;

  return {
    buckets,
    error,
    usable,
    note: usable
      ? `Mean miscalibration ${(error * 100).toFixed(1)} points over ${score.length} out-of-sample forecasts — the intervals mean roughly what they say.`
      : `Mean miscalibration ${(error * 100).toFixed(1)} points over ${score.length} out-of-sample forecasts, above the ${(GOOD_ENOUGH * 100).toFixed(0)}-point threshold. Read the intervals as indicative only; this model is not calibrated on this series.`,
  };
}

/**
 * The sentence the UI prints beside the interval.
 *
 * Names what the number is and — every time, not as a footnote — what it is
 * not. Somebody reading a forecast in a trading terminal will supply the
 * direction themselves unless told plainly that there is none in it.
 */
export function forecastLine(f: RangeForecast | null, cal: Calibration): string {
  if (f === null) {
    return "Not enough history to forecast a range. Nothing is being claimed.";
  }
  const band =
    f.percentile >= 0.8 ? "unusually wide" : f.percentile <= 0.2 ? "unusually tight" : "typical";
  const px = (v: number): string => (v >= 1000 ? v.toFixed(2) : v.toFixed(5));

  return (
    `Next bar: ${(f.confidence * 100).toFixed(0)}% of the time this closes between ${px(f.low)} and ${px(f.high)} — ` +
    `a ${band} range for this instrument. This says nothing about which way. ` +
    (cal.usable
      ? `The interval is calibrated: ${cal.note.toLowerCase()}`
      : `Treat the width as indicative — ${cal.note.toLowerCase()}`)
  );
}
