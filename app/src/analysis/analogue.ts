/**
 * THE NEXT CANDLE, FROM WHAT HAPPENED LAST TIME THE CHART LOOKED LIKE THIS.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, WHEN `nextcandle.ts` ALREADY DRAWS A CANDLE
 *
 * It draws one whose body is a flat line on every bar. Its direction may only
 * come from a named candle pattern whose measured edge clears a best-of-six
 * t-hurdle, and MEASURED on this operator's own BTCUSDT none does at 1m, 15m or
 * 1h. So the control spent its whole life drawing a box and a dash, and the
 * owner — correctly — said that is not a forecast of a candle.
 *
 * A pattern match is a RARE, DISCRETE event that throws away almost everything
 * the bar says: how far it has run, where it sits in its range, whether
 * volatility is expanding. This module keeps all of it. The current bar becomes
 * a short scale-free feature vector; the nearest past bars ON THIS SERIES are
 * found; and the forecast is the median of what actually followed them.
 *
 * Empirical, not textbook. It fires on EVERY bar. And it can be scored.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT WAS MEASURED TO DO, BEFORE ANY OF IT WAS DRAWN
 *
 * On the operator's own archive, walk-forward over 1,500 bars per timeframe:
 *
 *   next-bar RANGE, median absolute error   analogue   flat ATR(14)
 *     BTCUSDT 1h                              0.236        0.363   z +4.75
 *     BTCUSDT 1m                              0.443        0.497   tie
 *
 *   next-bar DIRECTION                      analogue   majority class
 *     BTCUSDT 1h                               53.1%          51.2%   z +1.45
 *     BTCUSDT 15m                              49.9%          50.7%   z −0.62
 *     BTCUSDT 1m                               53.7%          51.6%   z +1.58
 *
 * So: THE SHAPE OF THE CANDLE IS FORECASTABLE AND ITS DIRECTION IS NOT. At 1h
 * the conditional range beats flat ATR by 35%, which is the thing `forecast.ts`
 * already argues is genuinely predictable, arriving conditioned on the setup
 * rather than as one number for every bar. The direction clears nothing.
 *
 * That split is the whole design. The height and the wicks are drawn as a
 * forecast. The body is drawn because the owner asked to see one and to find
 * out whether it was right — and `replayAnalogue` puts its running hit rate
 * beside the no-information rate on screen, so the answer is never hidden. A
 * drawn and graded direction is the one honest form of this; an ungraded
 * confident one is what `forecast.ts` refuses and it is still refused.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TRAPS, AND WHERE EACH IS HELD
 *
 * · NO PRICE LEVEL IN THE FEATURES, EVER. A distance handed `close` learns the
 *   YEAR — 2021 and 2024 are separable by price alone on BTCUSDT — and then
 *   every neighbour of today's bar is simply a bar from this month. Every
 *   feature below is a ratio or an ATR multiple. CLAUDE.md records the same
 *   rule for `backtest/features.ts` and the same reasoning.
 * · A CANDIDATE MUST NOT OVERLAP THE QUERY. Bars three apart share seven of
 *   their ten features, so the nearest neighbours of bar q would be q−1, q−2,
 *   q−3 and the "forecast" would be yesterday's return wearing a statistic's
 *   clothes. `PURGE` opens a gap wider than the longest feature lookback.
 * · THE METRIC MUST NOT BE SET BY THE FUTURE. Feature spreads are computed from
 *   the candidate pool alone, never from the whole series, or the replay would
 *   be scoring a model that had seen its own test set — quietly, through a
 *   scaling constant, which is the hardest version to notice.
 * · THE POOL IS CAPPED AND THE CAP IS STATED. Unbounded, a query costs all of
 *   history and offers a 2022 analogue for a market that no longer exists.
 */

import type { BarView } from "../chart/series";
import { atr as atrOf, ema as emaOf } from "../chart/indicators";

/* ------------------------------------------------------------ parameters -- */

/** Bars of warm-up before any feature vector can be built. */
export const WARMUP = 60;

/**
 * Bars between the query and the newest candidate.
 *
 * The longest feature lookback is the 20-bar range position, so a candidate
 * inside that window shares most of its description with the query by
 * construction. Ten is a compromise: it clears the 10-bar return outright and
 * most of the range window, without throwing away the recent regime entirely.
 */
export const PURGE = 10;

/** Neighbours averaged. */
export const NEIGHBOURS = 40;

/** How far back neighbours may be drawn from. */
export const POOL = 3000;

/** Fewer candidates than this and no forecast is offered. */
export const MIN_POOL = 200;

export const FEATURE_NAMES = [
  "body / ATR",
  "upper wick / range",
  "lower wick / range",
  "range / ATR",
  "1-bar move / ATR",
  "3-bar move / ATR",
  "10-bar move / ATR",
  "position in 20-bar range",
  "ATR(14) / ATR(50)",
  "distance from EMA20 / ATR",
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

/* -------------------------------------------------------------- features -- */

export interface FeatureSet {
  /** One vector per bar, or null where it cannot be built. */
  readonly rows: readonly (readonly number[] | null)[];
  readonly atr14: Float64Array;
  /**
   * The same rows, FLAT: bar `i`'s feature `d` is at `i * FEATURE_COUNT + d`.
   *
   * Identical numbers to `rows`, which stays because it is what the tests read
   * and what makes a row's absence expressible. This exists because the inner
   * distance loop runs pool x features times per query and chasing a pointer
   * per row cost more than the arithmetic did.
   */
  readonly flat: Float64Array;
  /** 1 where `rows[i]` is present. */
  readonly ok: Uint8Array;
  /**
   * Running sums over present rows, for the pool's mean and spread in O(1).
   *
   * `sum[i * FEATURE_COUNT + d]` is the total of feature `d` over every present
   * row BELOW `i`; `sumSq` the same for the squares; `count[i]` how many rows
   * that was. A pool is a contiguous range, so its mean and standard deviation
   * are two subtractions — the SAME arithmetic as summing the range directly,
   * which is why this is a speed-up and not a second model.
   */
  readonly sum: Float64Array;
  readonly sumSq: Float64Array;
  readonly count: Int32Array;
}

/**
 * The feature matrix for a series, built once.
 *
 * EVERY ROW IS CAUSAL: row `i` reads bars `i` and earlier and nothing after.
 * The test proves it by truncation rather than by reading the code — a matrix
 * that peeked one bar forward would produce a superb replay and a useless
 * forecast, and that is the failure this whole module has to be safe from.
 */
export function buildFeatures(bars: readonly BarView[]): FeatureSet {
  const n = bars.length;
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i] as BarView;
    high[i] = b.h;
    low[i] = b.l;
    close[i] = b.c;
  }
  const atr14 = atrOf(high, low, close, 14, n);
  const atr50 = atrOf(high, low, close, 50, n);
  const ema20 = emaOf(close, 20, n);

  const rows: (readonly number[] | null)[] = new Array<readonly number[] | null>(n).fill(null);
  for (let i = WARMUP; i < n; i++) {
    const cur = bars[i] as BarView;
    const a = atr14[i] as number;
    if (!(a > 0)) continue;
    const rng = cur.h - cur.l;
    if (!(rng > 0)) continue;

    let hi20 = -Infinity;
    let lo20 = Infinity;
    for (let j = i - 19; j <= i; j++) {
      const b = bars[j] as BarView;
      if (b.h > hi20) hi20 = b.h;
      if (b.l < lo20) lo20 = b.l;
    }
    const span = hi20 - lo20;
    const a50 = atr50[i] as number;
    const e20 = ema20[i] as number;

    const row = [
      (cur.c - cur.o) / a,
      (cur.h - Math.max(cur.o, cur.c)) / rng,
      (Math.min(cur.o, cur.c) - cur.l) / rng,
      rng / a,
      (cur.c - (bars[i - 1] as BarView).c) / a,
      (cur.c - (bars[i - 3] as BarView).c) / a,
      (cur.c - (bars[i - 10] as BarView).c) / a,
      span > 0 ? (cur.c - lo20) / span : 0.5,
      a50 > 0 ? a / a50 : 1,
      Number.isFinite(e20) ? (cur.c - e20) / a : 0,
    ];
    /* A NaN in one dimension poisons every distance it appears in, and a
       distance of NaN sorts unpredictably rather than last. Refuse the row. */
    if (row.every((x) => Number.isFinite(x) && Math.abs(x) < 1e9)) rows[i] = row;
  }

  /* The flat mirror and the prefix sums, in one pass. `sum[0..]` is exclusive:
     entry `i` covers rows strictly below `i`, so a pool [a, b) is
     `sum[b] - sum[a]` with no off-by-one to get wrong in two places. */
  const flat = new Float64Array(n * FEATURE_COUNT);
  const ok = new Uint8Array(n);
  const sum = new Float64Array((n + 1) * FEATURE_COUNT);
  const sumSq = new Float64Array((n + 1) * FEATURE_COUNT);
  const count = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const row = rows[i] ?? null;
    const base = i * FEATURE_COUNT;
    const to = (i + 1) * FEATURE_COUNT;
    count[i + 1] = (count[i] as number) + (row === null ? 0 : 1);
    for (let d = 0; d < FEATURE_COUNT; d++) {
      /* A MISSING ROW CONTRIBUTES ZERO TO THE SUMS AND NOTHING TO THE COUNT,
         so the pool mean stays the mean of the rows that exist. Writing it into
         `flat` too would make an absent bar look like a bar at the origin — the
         `ok` mask is what keeps it out of every distance. */
      const x = row === null ? 0 : (row[d] as number);
      if (row !== null) flat[base + d] = x;
      sum[to + d] = (sum[base + d] as number) + x;
      sumSq[to + d] = (sumSq[base + d] as number) + x * x;
    }
    if (row !== null) ok[i] = 1;
  }

  return { rows, atr14, flat, ok, sum, sumSq, count };
}

/* -------------------------------------------------------------- forecast -- */

export interface AnalogueForecast {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Neighbours the medians were taken over. */
  readonly n: number;
  /**
   * Share of neighbours that moved the same way as the median, 0.5..1.
   *
   * NOT a probability that the call is right. It is how much the evidence
   * agrees with itself, which is a different and weaker thing, and it is
   * labelled as such wherever it is shown.
   */
  readonly agree: number;
  /** Median next-bar close move, in ATR units. The body, before scaling. */
  readonly moveAtr: number;
  readonly why: string;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * The forecast for the bar AFTER `at`, from the bars most like `at`.
 *
 * Returns null rather than a thin answer. A median over six neighbours is a
 * number with no standard error worth quoting, and this codebase refuses rather
 * than approximating everywhere else.
 */
export function analogueForecast(
  bars: readonly BarView[],
  feat: FeatureSet,
  at: number,
): AnalogueForecast | null {
  const q = feat.rows[at];
  if (q === undefined || q === null) return null;
  const cur = bars[at];
  if (cur === undefined) return null;
  const aq = feat.atr14[at] as number;
  if (!(aq > 0)) return null;

  /* THE CANDIDATE POOL. Strictly before `at - PURGE`, and `j + 1` must exist
     and must itself be at or before `at` — the outcome bar has to be one that
     has already happened. */
  const newest = at - PURGE;
  const oldest = Math.max(WARMUP, newest - POOL);
  if (newest <= oldest) return null;
  /* `j + 1 <= at` holds for every j below `newest`, because `newest` is already
     PURGE bars below `at` — so the pool is exactly the present rows in the
     range and its size is one subtraction. */
  const poolN = (feat.count[newest] as number) - (feat.count[oldest] as number);
  if (poolN < MIN_POOL) return null;

  /* FEATURE SPREADS FROM THE POOL ONLY, in O(1) from the prefix sums. The same
     sums over the same rows as the loop this replaced — see `speedup` in the
     header of `buildFeatures`. */
  const sd = new Float64Array(FEATURE_COUNT);
  const mean = new Float64Array(FEATURE_COUNT);
  const aOff = oldest * FEATURE_COUNT;
  const bOff = newest * FEATURE_COUNT;
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const m = ((feat.sum[bOff + d] as number) - (feat.sum[aOff + d] as number)) / poolN;
    const m2 = ((feat.sumSq[bOff + d] as number) - (feat.sumSq[aOff + d] as number)) / poolN;
    mean[d] = m;
    /* Floating error can make this a hair below zero on a constant feature. */
    const v = Math.sqrt(Math.max(0, m2 - m * m));
    /* A CONSTANT FEATURE DIVIDES BY ZERO AND TAKES EVERY DISTANCE WITH IT.
       Scaling it by 1 makes it contribute nothing, which is what a feature
       with no variation should contribute. */
    sd[d] = v > 1e-12 ? v : 1;
  }

  /* THE BEST `NEIGHBOURS`, KEPT BY INSERTION RATHER THAN BY SORTING THE POOL.
     Sorting allocated 3,000 objects per query to read the first 40 of them.
     Same 40, and ties break the same way — by the lower index, because a tie
     never displaces an entry already held. */
  const bestD = new Float64Array(NEIGHBOURS).fill(Infinity);
  const bestJ = new Int32Array(NEIGHBOURS).fill(-1);
  let held = 0;
  const flat = feat.flat;
  const okRow = feat.ok;
  for (let j = oldest; j < newest; j++) {
    if (okRow[j] !== 1) continue;
    const off = j * FEATURE_COUNT;
    let s = 0;
    for (let d = 0; d < FEATURE_COUNT; d++) {
      const x = ((flat[off + d] as number) - (q[d] as number)) / (sd[d] as number);
      s += x * x;
      /* Give up on a candidate that is already worse than the worst held. */
      if (held === NEIGHBOURS && s >= (bestD[NEIGHBOURS - 1] as number)) break;
    }
    if (held === NEIGHBOURS && s >= (bestD[NEIGHBOURS - 1] as number)) continue;
    let p = held < NEIGHBOURS ? held++ : NEIGHBOURS - 1;
    while (p > 0 && (bestD[p - 1] as number) > s) {
      bestD[p] = bestD[p - 1] as number;
      bestJ[p] = bestJ[p - 1] as number;
      p--;
    }
    bestD[p] = s;
    bestJ[p] = j;
  }

  const dClose: number[] = [];
  const dHigh: number[] = [];
  const dLow: number[] = [];
  for (let k = 0; k < held; k++) {
    const j = bestJ[k] as number;
    const aj = feat.atr14[j] as number;
    const base = bars[j] as BarView;
    const nxt = bars[j + 1];
    if (!(aj > 0) || nxt === undefined) continue;
    /* EVERY OUTCOME IS EXPRESSED IN THAT ANALOGUE'S OWN ATR, then replayed at
       today's. A 2023 bar that moved $40 and a 2026 bar that moved $400 are the
       same event if both were one ATR, and pooling them in dollars would make
       the forecast a statement about which years are in the archive. */
    dClose.push((nxt.c - base.c) / aj);
    dHigh.push((nxt.h - base.c) / aj);
    dLow.push((nxt.l - base.c) / aj);
  }
  if (dClose.length < 10) return null;

  const mc = median(dClose);
  const agree = dClose.filter((x) => x > 0 === mc > 0).length / dClose.length;

  const open = cur.c;
  const close = open + mc * aq;
  /* THE WICKS MUST CONTAIN THE BODY. The three medians are taken
     independently, so nothing makes the median high exceed the median close —
     rarely it does not, and a candle whose high is below its close is not a
     rendering glitch, it is a drawing that says something impossible. */
  const high = Math.max(open + median(dHigh) * aq, open, close);
  const low = Math.min(open + median(dLow) * aq, open, close);

  return {
    open,
    high,
    low,
    close,
    n: dClose.length,
    agree,
    moveAtr: mc,
    why:
      `the ${dClose.length} bars most like this one, out of ${poolN} looked at; ` +
      `${(agree * 100).toFixed(0)}% of them moved the same way`,
  };
}

/* ----------------------------------------------------------------- skill -- */

export interface AnalogueSkill {
  /** Bars the replay could forecast and grade. */
  readonly scored: number;
  readonly right: number;
  readonly hitRate: number;
  /**
   * The majority class over the same window — what calling one direction every
   * time would have scored.
   *
   * CLAUDE.md: "ACCURACY IS NOT SKILL." 53% on a window that was 53% up bars is
   * a report about the window. This is the number the hit rate has to beat, and
   * it is shown beside it rather than behind a flag.
   */
  readonly noInfoRate: number;
  /** Standard errors between the hit rate and the no-information rate. */
  readonly z: number;
  readonly skill: boolean;
  /** Median |actual range − forecast range|, in ATR. Lower is better. */
  readonly rangeErr: number;
  /** The same, for flat ATR(14) — the benchmark the forecast has to beat. */
  readonly atrErr: number;
  readonly why: string;
}

export const SKILL_Z = 1.96;

/**
 * Walk the recent past, forecasting each bar from only what preceded it.
 *
 * GENUINELY OUT OF SAMPLE, because the analogue search at bar k can only reach
 * candidates below k − PURGE and normalises from those alone. There is no fit
 * to leak: the "model" is the archive, and the archive is truncated.
 *
 * THE RANGE BENCHMARK IS PART OF THE RESULT, not a footnote. A forecast range
 * that loses to flat ATR is a more complicated way of drawing ATR, and this
 * codebase has already shipped one readout that turned out to be exactly that.
 */
export function replayAnalogue(
  bars: readonly BarView[],
  feat: FeatureSet,
  window = 250,
): AnalogueSkill | null {
  const n = bars.length;
  const first = Math.max(WARMUP + PURGE + MIN_POOL, n - 1 - window);
  if (first >= n - 1) return null;

  let scored = 0;
  let right = 0;
  let ups = 0;
  const rangeErrs: number[] = [];
  const atrErrs: number[] = [];

  for (let k = first; k < n - 1; k++) {
    const f = analogueForecast(bars, feat, k);
    if (f === null) continue;
    const here = bars[k] as BarView;
    const next = bars[k + 1] as BarView;
    const a = feat.atr14[k] as number;
    if (!(a > 0)) continue;

    scored++;
    const actualUp = next.c > here.c;
    if (actualUp) ups++;
    /* A FLAT BODY IS NOT A WIN AND NOT A LOSS. `scoreCandle` states the same
       rule: folding a declined call into either column makes the hit rate a
       statement about the market rather than about the model. */
    if (f.close !== f.open && f.close > f.open === actualUp) right++;

    const actualRange = next.h - next.l;
    rangeErrs.push(Math.abs(actualRange - (f.high - f.low)) / a);
    atrErrs.push(Math.abs(actualRange - a) / a);
  }

  if (scored < 30) return null;

  const upShare = ups / scored;
  const noInfoRate = Math.max(upShare, 1 - upShare);
  const hitRate = right / scored;
  const se = Math.sqrt((hitRate * (1 - hitRate)) / scored);
  const z = se > 0 ? (hitRate - noInfoRate) / se : Number.NaN;
  const rangeErr = median(rangeErrs);
  const atrErr = median(atrErrs);
  const skill = Number.isFinite(z) && z > SKILL_Z;

  return {
    scored,
    right,
    hitRate,
    noInfoRate,
    z,
    skill,
    rangeErr,
    atrErr,
    why: skill
      ? `direction right ${(hitRate * 100).toFixed(0)}% of the last ${scored} bars, ` +
        `against ${(noInfoRate * 100).toFixed(0)}% for always calling one way`
      : `direction right ${(hitRate * 100).toFixed(0)}% of the last ${scored} bars — ` +
        `always calling one way would have scored ${(noInfoRate * 100).toFixed(0)}%, ` +
        `so the arrow is not yet better than a coin here`,
  };
}
