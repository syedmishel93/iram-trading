/**
 * Indicators over columnar series.
 *
 * CONTRACT
 * Every function returns a Float64Array the SAME LENGTH as its input, with NaN
 * in the warm-up region. Equal length means an indicator value is always at the
 * same index as its bar — no offset arithmetic at the call site, which is where
 * off-by-one indicator bugs actually come from. NaN rather than 0 means "no
 * value yet" is distinguishable from "the value is zero"; a renderer skips NaN,
 * and a strategy that reads one gets NaN out rather than a plausible lie.
 *
 * All of these are single-pass and allocate exactly one output array. They run
 * across the whole series on every data change, so an O(n·window) implementation
 * would show up immediately at 800+ bars with several indicators on.
 */

const NaNArray = (n: number): Float64Array => new Float64Array(n).fill(NaN);

/** Simple moving average. Rolling sum — O(n) regardless of period. */
export function sma(src: Float64Array | readonly number[], period: number, len = src.length): Float64Array {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  /*
   * A RUNNING SUM CANNOT SURVIVE A NaN, so the holes are counted separately.
   *
   * `sum += NaN` makes the accumulator NaN and nothing later clears it —
   * NaN - x is NaN — so a mean of anything with a warm-up was NaN for the
   * WHOLE series. Every indicator in this file begins with NaN, which made
   * `sma` unusable on any of their outputs: it returned an array of NaN and
   * looked exactly like a series too short to average.
   *
   * So non-finite values are held out of the sum and counted, and the window
   * answers NaN only while it actually contains one. That is the same contract
   * every other indicator here keeps: unknown during warm-up, real afterwards.
   */
  let sum = 0;
  let holes = 0;
  for (let i = 0; i < len; i++) {
    const v = src[i] as number;
    if (Number.isFinite(v)) sum += v;
    else holes += 1;

    if (i >= period) {
      const gone = src[i - period] as number;
      if (Number.isFinite(gone)) sum -= gone;
      else holes -= 1;
    }
    if (i >= period - 1 && holes === 0) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Seeded with the SMA of the first `period` values rather than with the first
 * value alone. Seeding from a single price makes the first few hundred bars of
 * a long EMA visibly wrong, and a backtest that trades those bars is measuring
 * the seeding artefact rather than the strategy.
 */
export function ema(src: Float64Array | readonly number[], period: number, len = src.length): Float64Array {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  const k = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i++) seed += src[i] as number;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < len; i++) {
    prev = (src[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (the 1/period variant used by RSI, ATR and ADX). */
function wilder(src: Float64Array, period: number, len: number): Float64Array {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i] as number;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < len; i++) {
    prev = (prev * (period - 1) + (src[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index, Wilder-smoothed. */
export function rsi(close: Float64Array, period = 14, len = close.length): Float64Array {
  const out = NaNArray(len);
  if (len < period + 1) return out;

  const gain = new Float64Array(len);
  const loss = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const d = (close[i] as number) - (close[i - 1] as number);
    gain[i] = d > 0 ? d : 0;
    loss[i] = d < 0 ? -d : 0;
  }

  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period; i++) {
    avgG += gain[i] as number;
    avgL += loss[i] as number;
  }
  avgG /= period;
  avgL /= period;
  out[period] = rsiFrom(avgG, avgL);

  for (let i = period + 1; i < len; i++) {
    avgG = (avgG * (period - 1) + (gain[i] as number)) / period;
    avgL = (avgL * (period - 1) + (loss[i] as number)) / period;
    out[i] = rsiFrom(avgG, avgL);
  }
  return out;
}

/**
 * RSI from average gain and loss.
 *
 * Two zero cases, and they are NOT the same:
 *  - no losses, some gains  -> RS is infinite, RSI is 100 by definition.
 *  - no losses AND no gains -> the market did not move. RSI is undefined; 50 is
 *    the honest answer. Returning 100 here (the naive `avgL === 0 ? 100` test)
 *    reports maximum bullish momentum for a flat tape, which then propagates
 *    into every consumer as a strong long signal that nothing justifies.
 */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** True range per bar. `tr[0]` is high-low, as there is no previous close. */
export function trueRange(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  len = close.length,
): Float64Array {
  const out = new Float64Array(len);
  if (len === 0) return out;
  out[0] = (high[0] as number) - (low[0] as number);
  for (let i = 1; i < len; i++) {
    const h = high[i] as number;
    const l = low[i] as number;
    const pc = close[i - 1] as number;
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/** Average True Range. */
export function atr(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 14,
  len = close.length,
): Float64Array {
  return wilder(trueRange(high, low, close, len), period, len);
}

export interface MacdResult {
  macd: Float64Array;
  signal: Float64Array;
  histogram: Float64Array;
}

/** MACD. The signal line is an EMA of the MACD line, warm-up included. */
export function macd(
  close: Float64Array,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
  len = close.length,
): MacdResult {
  const fastEma = ema(close, fast, len);
  const slowEma = ema(close, slow, len);

  const macdLine = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const f = fastEma[i] as number;
    const s = slowEma[i] as number;
    if (!Number.isNaN(f) && !Number.isNaN(s)) macdLine[i] = f - s;
  }

  // The signal EMA must start at the first REAL macd value, not at index 0,
  // or the leading NaNs poison every subsequent value.
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal = NaNArray(len);
  if (firstValid >= 0) {
    const tail = macdLine.subarray(firstValid);
    const sig = ema(tail, signalPeriod, tail.length);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i] as number;
  }

  const histogram = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const m = macdLine[i] as number;
    const s = signal[i] as number;
    if (!Number.isNaN(m) && !Number.isNaN(s)) histogram[i] = m - s;
  }

  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  middle: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

/**
 * Bollinger Bands.
 *
 * Uses a two-pass variance per window rather than the rolling sum-of-squares
 * shortcut: the shortcut loses catastrophic precision on price series where the
 * mean is large relative to the deviation (a $100k BTC print with $50 of
 * spread), and can even go negative under the square root.
 */
export function bollinger(
  close: Float64Array,
  period = 20,
  mult = 2,
  len = close.length,
): BollingerResult {
  const middle = sma(close, period, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);

  for (let i = period - 1; i < len; i++) {
    const mean = middle[i] as number;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = (close[j] as number) - mean;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}

/**
 * Volume-weighted average price, reset on each session boundary.
 *
 * VWAP without a reset is meaningless past the first day — it converges to a
 * flat line. `sessionMs` defaults to one day; pass 0 for a cumulative anchored
 * VWAP from the first bar.
 */
export function vwap(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array,
  time: Float64Array,
  sessionMs = 86_400_000,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  let pv = 0;
  let vol = 0;
  let session = -1;

  for (let i = 0; i < len; i++) {
    const t = time[i] as number;
    const s = sessionMs > 0 ? Math.floor(t / sessionMs) : 0;
    if (s !== session) {
      session = s;
      pv = 0;
      vol = 0;
    }
    const typical = ((high[i] as number) + (low[i] as number) + (close[i] as number)) / 3;
    const v = volume[i] as number;
    pv += typical * v;
    vol += v;
    // A zero-volume bar (a synthetic gap, or an FX feed with no volume at all)
    // must not divide by zero and emit Infinity into the column.
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

export interface StochResult {
  k: Float64Array;
  d: Float64Array;
}

/** Stochastic oscillator. */
export function stochastic(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 14,
  smoothK = 3,
  smoothD = 3,
  len = close.length,
): StochResult {
  const raw = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j] as number;
      const l = low[j] as number;
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const span = hh - ll;
    // A flat window has no range to normalise against. 50 (mid) is the honest
    // answer; 0 or 100 would read as an extreme that is not there.
    raw[i] = span === 0 ? 50 : (((close[i] as number) - ll) / span) * 100;
  }
  const k = smoothK > 1 ? smaSkippingNaN(raw, smoothK, len) : raw;
  const d = smaSkippingNaN(k, smoothD, len);
  return { k, d };
}

/** SMA that treats leading NaNs as "not started yet" rather than poison. */
function smaSkippingNaN(src: Float64Array, period: number, len: number): Float64Array {
  const out = NaNArray(len);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    const v = src[i] as number;
    if (!Number.isNaN(v)) {
      sum += v;
      count++;
    }
    if (i >= period) {
      const drop = src[i - period] as number;
      if (!Number.isNaN(drop)) {
        sum -= drop;
        count--;
      }
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/** Average Directional Index, with the +DI / -DI it is derived from. */
export function adx(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 14,
  len = close.length,
): { adx: Float64Array; plusDI: Float64Array; minusDI: Float64Array } {
  const plusDM = new Float64Array(len);
  const minusDM = new Float64Array(len);

  for (let i = 1; i < len; i++) {
    const up = (high[i] as number) - (high[i - 1] as number);
    const down = (low[i - 1] as number) - (low[i] as number);
    // Only the LARGER of the two directional moves counts, and only if it is
    // positive — otherwise the bar is inside the previous one and directionless.
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const tr = wilder(trueRange(high, low, close, len), period, len);
  const pdm = wilder(plusDM, period, len);
  const mdm = wilder(minusDM, period, len);

  const plusDI = NaNArray(len);
  const minusDI = NaNArray(len);
  const dx = NaNArray(len);

  for (let i = 0; i < len; i++) {
    const t = tr[i] as number;
    if (Number.isNaN(t) || t === 0) continue;
    const p = ((pdm[i] as number) / t) * 100;
    const m = ((mdm[i] as number) / t) * 100;
    plusDI[i] = p;
    minusDI[i] = m;
    const sum = p + m;
    dx[i] = sum === 0 ? 0 : (Math.abs(p - m) / sum) * 100;
  }

  const firstValid = dx.findIndex((v) => !Number.isNaN(v));
  const out = NaNArray(len);
  if (firstValid >= 0) {
    const tail = dx.subarray(firstValid);
    const smoothed = wilder(tail, period, tail.length);
    for (let i = 0; i < smoothed.length; i++) out[firstValid + i] = smoothed[i] as number;
  }

  return { adx: out, plusDI, minusDI };
}

/* ---------------------------------------------------------------------------
   THE FIVE THE RULE ENGINE NEEDS.

   These exist because the declarative strategy specs recovered from the
   previous terminal reference them by name, and a rule that names an indicator
   this build cannot compute is a rule that silently never fires. Each one is
   the standard formulation; where a common variant exists, the choice is stated
   rather than left for someone to reverse-engineer from the output.
   ------------------------------------------------------------------------ */

/**
 * Rate of change, as a PERCENT.
 *
 * Percent rather than ratio or absolute difference, because the rule specs
 * compare it against zero and against small integers. An absolute ROC on
 * BTCUSD and on EURUSD are four orders of magnitude apart, so a threshold that
 * means anything on one is meaningless on the other.
 */
export function roc(close: Float64Array, period = 12, len = close.length): Float64Array {
  const out = NaNArray(len);
  for (let i = period; i < len; i++) {
    const then = close[i - period] as number;
    if (then === 0 || !Number.isFinite(then)) continue;
    out[i] = (((close[i] as number) - then) / then) * 100;
  }
  return out;
}

/**
 * Williams %R. Ranges from -100 (at the low of the window) to 0 (at the high).
 *
 * The sign convention matters and is the usual place this goes wrong: -80 is
 * OVERSOLD and -20 is OVERBOUGHT, which is the opposite way round from every
 * other oscillator in this file. The rule specs are written against that
 * convention.
 */
export function williamsR(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 14,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j] as number;
      const l = low[j] as number;
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const range = hh - ll;
    /* A flat window has no position within itself. Zero would read as "at the
       high", which is a directional claim the data does not support. */
    if (range <= 0) continue;
    out[i] = ((hh - (close[i] as number)) / range) * -100;
  }
  return out;
}

/**
 * Commodity Channel Index, Lambert's original with the 0.015 constant.
 *
 * The deviation term is MEAN absolute deviation, not standard deviation. Using
 * the standard deviation is a common substitution and it changes the scale, so
 * the conventional +/-100 thresholds stop meaning what they are supposed to.
 */
export function cci(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 20,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  const tp = NaNArray(len);
  for (let i = 0; i < len; i++) {
    tp[i] = ((high[i] as number) + (low[i] as number) + (close[i] as number)) / 3;
  }
  for (let i = period - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j] as number;
    const mean = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs((tp[j] as number) - mean);
    const mad = dev / period;
    if (mad <= 0) continue;
    out[i] = ((tp[i] as number) - mean) / (0.015 * mad);
  }
  return out;
}

/**
 * Money Flow Index — RSI weighted by volume.
 *
 * Requires real volume. On a series where volume is absent or constant this
 * degenerates towards RSI, which is worth knowing before reading a divergence
 * into it: a "volume-weighted" reading on unweighted data is just the
 * unweighted reading wearing a better name.
 */
export function mfi(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array,
  period = 14,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  const tp = NaNArray(len);
  for (let i = 0; i < len; i++) {
    tp[i] = ((high[i] as number) + (low[i] as number) + (close[i] as number)) / 3;
  }
  for (let i = period; i < len; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const now = tp[j] as number;
      const prev = tp[j - 1] as number;
      const flow = now * (volume[j] as number);
      if (!Number.isFinite(flow)) continue;
      if (now > prev) pos += flow;
      else if (now < prev) neg += flow;
    }
    /* All flow on one side is a real reading, not a division error: 100 with no
       negative flow, 0 with no positive flow. */
    if (pos + neg <= 0) continue;
    out[i] = (pos / (pos + neg)) * 100;
  }
  return out;
}

/**
 * Supertrend direction: +1 when the trend band is below price, -1 when above.
 *
 * Only the DIRECTION is returned, because that is all the rule specs use and
 * the band itself is not drawn anywhere. The stateful part — a band that only
 * ever tightens until it flips — is the whole indicator; computing the raw
 * bands without that ratchet gives a line that whipsaws on every bar.
 */
export function supertrendDirection(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 10,
  mult = 3,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  const a = atr(high, low, close, period, len);

  let upper = NaN;
  let lower = NaN;
  let dir = 1;

  for (let i = 0; i < len; i++) {
    const atrNow = a[i] as number;
    if (!Number.isFinite(atrNow)) continue;
    const mid = ((high[i] as number) + (low[i] as number)) / 2;
    let up = mid + mult * atrNow;
    let low_ = mid - mult * atrNow;
    const prevClose = i > 0 ? (close[i - 1] as number) : (close[i] as number);

    /* The ratchet: a band may only move in the direction that tightens it,
       until price closes through it and the trend flips. */
    if (Number.isFinite(upper) && !(up < upper || prevClose > upper)) up = upper;
    if (Number.isFinite(lower) && !(low_ > lower || prevClose < lower)) low_ = lower;

    const c = close[i] as number;
    if (Number.isFinite(upper) && Number.isFinite(lower)) {
      if (dir === 1 && c < lower) dir = -1;
      else if (dir === -1 && c > up) dir = 1;
    }

    upper = up;
    lower = low_;
    out[i] = dir;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * v49 additions.
 *
 * WHAT WAS CHOSEN AND WHAT WAS REFUSED
 * The fifteen indicators above are, with two exceptions, arithmetic on past
 * close — RSI, MACD, Stochastic, CCI and Williams %R are five rearrangements
 * of the same numbers, and `analysis/leading.ts` says so in its own header. A
 * sixth rearrangement would add a line to the chart and no information to the
 * decision.
 *
 * So everything below either uses data the oscillators never touch (the RANGE,
 * for Keltner and Donchian and Chandelier; VOLUME, for anchored VWAP; a SECOND
 * INSTRUMENT, for relative strength) or is a complete published system whose
 * absence was conspicuous (Ichimoku).
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BandResult {
  middle: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

/**
 * Keltner Channels — an EMA with ATR bands.
 *
 * WHY BOTH THESE AND BOLLINGER
 * They measure different things and the DIFFERENCE is the signal. Bollinger
 * bands are standard deviations of close; Keltner bands are average true
 * range. When close has gone quiet but the bars are still travelling — a
 * grinding drift with long wicks — Bollinger contracts and Keltner does not.
 * `squeeze` below is exactly that comparison, and it is the only reason to
 * carry two band systems rather than one.
 */
export function keltner(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 20,
  mult = 2,
  atrPeriod = 10,
  len = close.length,
): BandResult {
  const middle = ema(close, period, len);
  const a = atr(high, low, close, atrPeriod, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const m = middle[i] as number;
    const r = a[i] as number;
    if (!Number.isFinite(m) || !Number.isFinite(r)) continue;
    upper[i] = m + mult * r;
    lower[i] = m - mult * r;
  }
  return { middle, upper, lower };
}

/**
 * The squeeze: 1 while Bollinger sits INSIDE Keltner, 0 otherwise, NaN in the
 * warm-up.
 *
 * WHAT IT IS ALLOWED TO CLAIM
 * A constraint on TIMING and nothing whatever about direction. Volatility that
 * has compressed must eventually expand; which way it expands is not in this
 * number and cannot be derived from it. Every tool that draws an arrow out of a
 * squeeze is inventing the half of the signal that does not exist — see the
 * `coiled` family in `analysis/leading.ts`, which makes the same point at
 * length and for the same reason.
 */
export function squeeze(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 20,
  bbMult = 2,
  kcMult = 1.5,
  len = close.length,
): Float64Array {
  const bb = bollinger(close, period, bbMult, len);
  const kc = keltner(high, low, close, period, kcMult, period, len);
  const out = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const bu = bb.upper[i] as number;
    const bl = bb.lower[i] as number;
    const ku = kc.upper[i] as number;
    const kl = kc.lower[i] as number;
    if (!Number.isFinite(bu) || !Number.isFinite(ku)) continue;
    out[i] = bu < ku && bl > kl ? 1 : 0;
  }
  return out;
}

/**
 * Donchian channel — the highest high and lowest low of the last `period` bars.
 *
 * The middle line is the MIDPOINT of the two, not an average of close: this is
 * a range indicator throughout, and mixing a close-based centre into it would
 * make the middle cross the bands under conditions where the range did not.
 *
 * Deliberately EXCLUDES the current bar when `excludeCurrent` is set, which is
 * how a breakout system must read it — a channel that includes the bar you are
 * testing can never be broken, because the bar is its own high.
 */
export function donchian(
  high: Float64Array,
  low: Float64Array,
  period = 20,
  excludeCurrent = false,
  len = high.length,
): BandResult {
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  const middle = NaNArray(len);
  const shift = excludeCurrent ? 1 : 0;

  for (let i = period - 1 + shift; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1 - shift; j <= i - shift; j++) {
      const h = high[j] as number;
      const l = low[j] as number;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    upper[i] = hi;
    lower[i] = lo;
    middle[i] = (hi + lo) / 2;
  }
  return { middle, upper, lower };
}

export interface IchimokuResult {
  /** Tenkan-sen, the 9-period midpoint. */
  conversion: Float64Array;
  /** Kijun-sen, the 26-period midpoint. */
  base: Float64Array;
  /** Senkou span A, PROJECTED forward — see the note on displacement. */
  spanA: Float64Array;
  /** Senkou span B, projected forward. */
  spanB: Float64Array;
  /** Chikou span, the close displaced backwards. */
  lagging: Float64Array;
  /** How many bars the cloud is pushed forward. */
  displacement: number;
}

/**
 * Ichimoku Kinko Hyo.
 *
 * WHY THE DISPLACEMENT IS HANDLED THE WAY IT IS
 * Two of the five lines are DISPLACED — the cloud is drawn 26 bars into the
 * future and the lagging span 26 bars into the past. Every array here obeys the
 * module contract of being the same length as the series, which means the
 * forward half of the cloud has nowhere to live: the bars it belongs on do not
 * exist yet.
 *
 * The honest choice is to shift what fits and drop what does not, rather than
 * to silently draw the cloud on the wrong bars — which is what an
 * implementation that skips the shift does, and it is a genuinely dangerous bug
 * because the result looks completely plausible. `spanA` and `spanB` are
 * therefore shifted forward WITHIN the array, so the last `displacement` bars
 * carry the projection and the first `displacement` bars are NaN. The part of
 * the cloud that extends past the live edge is not returned at all; a renderer
 * that wants it must extend the axis itself.
 */
export function ichimoku(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  conversionPeriod = 9,
  basePeriod = 26,
  spanBPeriod = 52,
  displacement = 26,
  len = close.length,
): IchimokuResult {
  const midpoint = (period: number): Float64Array => {
    const out = NaNArray(len);
    for (let i = period - 1; i < len; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        const h = high[j] as number;
        const l = low[j] as number;
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };

  const conversion = midpoint(conversionPeriod);
  const base = midpoint(basePeriod);
  const spanBRaw = midpoint(spanBPeriod);

  const spanARaw = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const c = conversion[i] as number;
    const b = base[i] as number;
    if (Number.isFinite(c) && Number.isFinite(b)) spanARaw[i] = (c + b) / 2;
  }

  const shiftForward = (src: Float64Array): Float64Array => {
    const out = NaNArray(len);
    for (let i = displacement; i < len; i++) out[i] = src[i - displacement] as number;
    return out;
  };

  const lagging = NaNArray(len);
  for (let i = 0; i + displacement < len; i++) lagging[i] = close[i + displacement] as number;

  return {
    conversion,
    base,
    spanA: shiftForward(spanARaw),
    spanB: shiftForward(spanBRaw),
    lagging,
    displacement,
  };
}

/**
 * Chandelier exit — a trailing stop hung from the highest high, in ATR.
 *
 * This is the one indicator here that answers a question the terminal could not
 * previously answer at all: `setup/plan.ts` places a stop at entry and nothing
 * moves it afterwards. Returned as a level per bar for BOTH sides, so the Setup
 * card can show what a trail would have done next to what the fixed stop did.
 *
 * The RATCHET is the indicator. A long exit may only rise; letting it fall when
 * the lookback high rolls off gives a trailing stop that loosens, which is the
 * one thing a trailing stop must never do.
 */
export function chandelier(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period = 22,
  mult = 3,
  len = close.length,
): { long: Float64Array; short: Float64Array } {
  const a = atr(high, low, close, period, len);
  const long = NaNArray(len);
  const short = NaNArray(len);
  let longStop = -Infinity;
  let shortStop = Infinity;

  for (let i = period - 1; i < len; i++) {
    const r = a[i] as number;
    if (!Number.isFinite(r)) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j] as number;
      const l = low[j] as number;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    const rawLong = hi - mult * r;
    const rawShort = lo + mult * r;

    /* Reset the ratchet when price closes through the stop: the trade that was
       being trailed is over, and carrying its level forward would anchor the
       next one to a trend that has ended. */
    const c = close[i] as number;
    if (c < longStop) longStop = -Infinity;
    if (c > shortStop) shortStop = Infinity;

    longStop = Math.max(longStop, rawLong);
    shortStop = Math.min(shortStop, rawShort);
    long[i] = longStop;
    short[i] = shortStop;
  }
  return { long, short };
}

/**
 * VWAP anchored to one bar, rather than reset on a calendar boundary.
 *
 * WHY THIS AND NOT THE SESSION VWAP ABOVE
 * Session VWAP answers "what is the average price paid today", which is a
 * question about the clock. Anchored VWAP answers "what is the average price
 * paid by everyone who bought since THAT event" — a swing low, a gap, an
 * earnings bar — which is a question about a position. The second one is the
 * tool; the first is the default that ships everywhere.
 *
 * Bars before the anchor are NaN, not zero: they are outside the measurement,
 * and drawing them at zero would slope a line up from the bottom of the chart.
 */
export function anchoredVwap(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array,
  anchorIndex: number,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  const start = Math.max(0, Math.min(anchorIndex, len - 1));
  let pv = 0;
  let vol = 0;
  for (let i = start; i < len; i++) {
    const typical = ((high[i] as number) + (low[i] as number) + (close[i] as number)) / 3;
    const v = volume[i] as number;
    const vv = Number.isFinite(v) ? v : 0;
    pv += typical * vv;
    vol += vv;
    /* An FX feed reports no volume at all. Falling back to the typical price
       makes this a plain average rather than dividing by zero, and the caller
       labels it as such. */
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

/**
 * Relative strength of one series against another — the ratio, rebased to 100.
 *
 * WHY IT IS A RATIO AND NOT A CORRELATION
 * Correlation says whether two things move together. This says which one is
 * WINNING, which is a different and more actionable question: an altcoin can be
 * 0.9 correlated to BTC and still be bleeding against it every week, and the
 * ratio is the only line that shows you that.
 *
 * `base` must already be joined to the same bars — see `alignedReturns` in
 * `data/correlation.ts` for why joining on timestamp rather than array position
 * is not optional. Anything unjoinable comes in as NaN and stays NaN.
 */
export function relativeStrength(
  close: Float64Array,
  base: Float64Array,
  len = close.length,
): Float64Array {
  const out = NaNArray(len);
  let anchor = NaN;
  for (let i = 0; i < len; i++) {
    const c = close[i] as number;
    const b = base[i] as number;
    if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0) continue;
    const ratio = c / b;
    if (!Number.isFinite(anchor)) anchor = ratio;
    out[i] = (ratio / anchor) * 100;
  }
  return out;
}
