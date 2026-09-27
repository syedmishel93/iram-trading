/**
 * What's likely next — a price RANGE over the next H bars, not a call.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 * `forecast.ts` forecasts one bar. This stretches the same idea to horizons
 * 1..H by FILTERED HISTORICAL SIMULATION:
 *
 *   1. Every past 1-bar log return is divided by the EWMA volatility that was
 *      known BEFORE it (sigma at bar i uses returns up to i-1). What is left —
 *      the standardised residual — is the SHAPE of this instrument's moves
 *      with the volatility level taken out: its fat tails, its skew, its
 *      average drift.
 *   2. N paths of H steps are drawn from those residuals, with replacement,
 *      each rescaled by TODAY's sigma and compounded from the last close.
 *   3. The quantiles of the simulated closes at each horizon are the cone.
 *
 * Nothing here is fitted. The only parameters are the RiskMetrics decay
 * (reused from `forecast.ts`, for the reason given there), the horizon, the
 * number of draws and the seed — all reported in the result.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 *
 * `pUp` is the share of simulated paths that end above the last close. It is a
 * BASE RATE from the instrument's own history — mostly the average drift of
 * the residual pool, compounded — and not a directional forecast. On a
 * driftless series it sits near 0.5 and says so. It must never be printed as
 * "likely up".
 *
 * And the model's own confidence is checked, not asserted:
 * `outlookCalibration` replays the 90% band at horizon H over past origins
 * and reports how often the realised close actually landed inside it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RESULTS ARE A DISCRIMINATED UNION ON `ok`
 *
 *   { ok: true, ... }              — every number finite, with its working
 *   { ok: false, refused: string } — a sentence addressed to the operator
 *                                    saying why nothing is being claimed
 *
 * No result ever carries NaN or Infinity: a figure that cannot be computed
 * becomes a refusal instead.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEASURED COST (node 26, esbuild bundle, this machine, median of 20 runs
 * after 5 warm-ups, three separate invocations):
 *
 *   simulateOutlook,    1000 bars, 2000 draws, H=24 ... 4.5-5.4 ms
 *   simulateOutlook,    5000 bars, 2000 draws, H=24 ... 4.8-4.9 ms
 *   outlookCalibration, 1000 bars,  500 draws, H=24 ... 4.2-4.8 ms (29 trials)
 *   outlookCalibration, 5000 bars,  500 draws, H=24 ... 30-34 ms (195 trials)
 *
 * So the 2000-draw default stays: it is about a fifth of the ~25ms main-thread
 * budget. Calibration on long histories is NOT a per-frame call — run it once
 * per symbol/timeframe load, or on an idle callback.
 *
 * The volatility series is ONE recursive pass (see `sigmaSeries`), not `ewmaSigma` re-run on every prefix, which would be
 * O(n^2) — 1000 bars would cost ~0.5M logs before a single path was drawn.
 */

import type { BarView } from "../chart/series";
import { ewmaSigma, EWMA_LAMBDA, MIN_BARS as SIGMA_WARMUP } from "./forecast";
import { rng, seedFrom } from "../backtest/resample";

/* ─────────────────────────────────────────────────────────────── constants */

/** Bars needed before a multi-bar outlook is attempted at all. */
export const MIN_OUTLOOK_BARS = 300;

/**
 * Standardised residuals needed in the pool.
 *
 * 300 bars less the 120-bar volatility warm-up leaves 180; a series that has
 * lost more than 30 of those to zero-volatility stretches has too few distinct
 * moves to describe a tail with.
 */
export const MIN_RESIDUALS = 150;

export const DEFAULT_HORIZON = 24;
export const DEFAULT_DRAWS = 2_000;
/** Draws per origin in calibration — 500 is enough for a p5/p95 and keeps a
 *  1000-bar replay near 5ms and a 5000-bar one near 32ms (measured, see the
 *  file header). */
export const CALIBRATION_DRAWS = 500;
/** Most recent residuals the pool is drawn from, as in `forecast.ts`: the
 *  shape of returns is not stable over years. */
export const DEFAULT_HISTORY = 1_500;
/** Past checks before the calibration figure is itself worth reading. */
export const MIN_CALIBRATION_TRIALS = 30;
/** The band that calibration scores. */
export const CALIBRATION_NOMINAL = 0.9;

const MAX_HORIZON = 500;
const MAX_DRAWS = 100_000;

/* ─────────────────────────────────────────────────────────────────── types */

/** Why nothing is being claimed. Addressed to the operator. */
export interface Refused {
  readonly ok: false;
  readonly refused: string;
}

export interface OutlookOptions {
  /** Bars ahead, 1..500. Default 24. */
  readonly horizon?: number | undefined;
  /** Simulated paths, 1..100000. Default 2000 (500 in calibration). */
  readonly draws?: number | undefined;
  /** PRNG seed. Default is derived from the data, so the same bars give the
   *  same cone in every run and every engine. */
  readonly seed?: number | undefined;
  /** EWMA decay. Default `EWMA_LAMBDA` (0.94). */
  readonly lambda?: number | undefined;
  /** Most recent residuals drawn from. Default 1500. */
  readonly history?: number | undefined;
}

/** Price quantiles of the simulated closes, `h` bars ahead. */
export interface ConeStep {
  readonly h: number;
  readonly p5: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}

export interface OutlookCone {
  readonly ok: true;
  /** The close every path starts from. */
  readonly last: number;
  /** One entry per horizon 1..H, in order. */
  readonly steps: readonly ConeStep[];
  /**
   * Share of paths ending above `last` at H. A BASE RATE from this
   * instrument's own history, not a directional forecast.
   */
  readonly pUp: number;
  /** Paths ending above `last` at H — the numerator of `pUp`. */
  readonly up: number;
  /** Today's EWMA volatility of 1-bar log returns, as a share of price. */
  readonly sigmaNow: number;
  /** Standardised residuals in the pool the paths were drawn from. */
  readonly n: number;
  readonly draws: number;
  readonly horizon: number;
  readonly seed: number;
  readonly lambda: number;
  /** Always "modelled": nothing in the cone is an observed outcome. */
  readonly basis: "modelled";
  readonly assumptions: readonly string[];
}

/**
 * Simulated closes, path-major: path d's close at step h (1-based) is
 * `closes[d * horizon + (h - 1)]`.
 */
export interface SimulatedPaths {
  readonly last: number;
  readonly draws: number;
  readonly horizon: number;
  readonly closes: Float64Array;
}

export interface TradePlan {
  readonly direction: "long" | "short";
  readonly entry: number;
  readonly stop: number;
  readonly target1: number;
  readonly target2?: number | undefined;
}

export interface TouchOdds {
  readonly ok: true;
  /** Share of paths touching target 1 before the stop, within H bars. */
  readonly target1First: number;
  /** Share of paths touching the stop before target 1. */
  readonly stopFirst: number;
  /** Share touching neither. The three shares sum to 1. */
  readonly neither: number;
  /** Share touching target 2 before the stop; null when no target 2. */
  readonly target2First: number | null;
  /** The raw counts behind every share, out of `draws`. */
  readonly counts: {
    readonly target1: number;
    readonly stop: number;
    readonly neither: number;
    readonly target2: number | null;
  };
  readonly draws: number;
  readonly horizon: number;
  readonly basis: "modelled";
  readonly assumptions: readonly string[];
}

export interface Outlook {
  readonly ok: true;
  readonly cone: OutlookCone;
  readonly paths: SimulatedPaths;
  /** Touch odds on THE SAME paths the cone was read from. */
  touch(plan: TradePlan): TouchOdds | Refused;
}

export interface OutlookCalibration {
  readonly ok: true;
  /** Share of past checks where the realised close landed inside p5–p95. */
  readonly coverage: number;
  readonly inside: number;
  readonly trials: number;
  /** What the band claims: 0.90. */
  readonly nominal: number;
  /** trials >= MIN_CALIBRATION_TRIALS. */
  readonly usable: boolean;
  readonly horizon: number;
  readonly draws: number;
  /** Bars between origins. Equal to the horizon, so no two checks share an
   *  outcome window and each trial is a separate piece of evidence. */
  readonly stride: number;
  readonly basis: "measured";
  readonly note: string;
}

/* ────────────────────────────────────────────────────────────── assumptions */

const CONE_ASSUMPTIONS = (n: number): string[] => [
  "Volatility is held at today's level for the whole horizon.",
  "Past moves are drawn independently, so trends and volatility clustering beyond today are not carried forward.",
  `The size and shape of moves — fat tails, skew and the average drift — come from this instrument's own last ${n} bars, not from a bell curve.`,
  "Prices are simulated at bar closes only; gaps, spreads and intrabar extremes are not.",
  "The share of paths ending higher is a base rate from this instrument's own history, not a directional forecast.",
];

const TOUCH_ASSUMPTIONS: readonly string[] = [
  "Touches are checked on simulated closes only. Intrabar highs and lows are not simulated, so touches of both the target and the stop are understated and 'neither' is overstated.",
  "The trade is measured from the last close, as if open now; a pending entry at a different price is not modelled.",
  "Slippage, spread and gaps through a level are not modelled.",
];

/* ──────────────────────────────────────────────────────────────── internals */

const refuse = (refused: string): Refused => ({ ok: false, refused });

const isInt = (x: number, lo: number, hi: number): boolean =>
  Number.isInteger(x) && x >= lo && x <= hi;

/**
 * `sig[i]` = the EWMA sigma known at bar i — built from returns up to i-1,
 * i.e. `ewmaSigma(bars.slice(0, i))` — for i in [31, n]; NaN below.
 *
 * One pass instead of n calls. The seed is taken from `ewmaSigma` itself (on
 * exactly 30 returns it performs no recursion step and returns the seed), and
 * the recursion is the one-line RiskMetrics update. Equality with
 * `ewmaSigma(bars.slice(0, i))` is asserted in the tests at every i, which is
 * what licenses not calling it n times.
 *
 * Requires every close positive and finite — `ewmaSigma` silently SKIPS bad
 * returns, which would shift its indexing against this one; the callers refuse
 * such series instead.
 */
export function sigmaSeries(bars: readonly BarView[], lambda: number): Float64Array {
  const n = bars.length;
  const sig = new Float64Array(n + 1).fill(NaN);
  if (n < 31) return sig;
  let variance = ewmaSigma(bars.slice(0, 31), lambda) ** 2;
  sig[31] = Math.sqrt(variance);
  for (let i = 31; i < n; i++) {
    const r = Math.log((bars[i] as BarView).c / (bars[i - 1] as BarView).c);
    variance = lambda * variance + (1 - lambda) * r * r;
    sig[i + 1] = Math.sqrt(variance);
  }
  return sig;
}

/**
 * z[i] = r_i / sig[i] for i >= the 120-bar warm-up, NaN where sigma is not
 * usable (a perfectly flat stretch). r_i is the return INTO bar i, sig[i] was
 * known before it: no lookahead.
 */
function residualSeries(bars: readonly BarView[], sig: Float64Array): Float64Array {
  const n = bars.length;
  const z = new Float64Array(n).fill(NaN);
  for (let i = SIGMA_WARMUP; i < n; i++) {
    const s = sig[i] as number;
    if (!(s > 0) || !Number.isFinite(s)) continue;
    z[i] = Math.log((bars[i] as BarView).c / (bars[i - 1] as BarView).c) / s;
  }
  return z;
}

/** Finite residuals with index in [from, to], oldest first. */
function pool(z: Float64Array, from: number, to: number): Float64Array {
  const out: number[] = [];
  for (let i = Math.max(0, from); i <= to; i++) {
    const v = z[i] as number;
    if (Number.isFinite(v)) out.push(v);
  }
  return Float64Array.from(out);
}

function badClose(bars: readonly BarView[]): number {
  for (let i = 0; i < bars.length; i++) {
    const c = (bars[i] as BarView).c;
    if (!(c > 0) || !Number.isFinite(c)) return i;
  }
  return -1;
}

/**
 * Quantile of an ASCENDING array, linear interpolation between order
 * statistics (Hyndman–Fan type 7, the spreadsheet default): position
 * p·(m−1). Chosen because it is the one a reader checking by hand in a
 * spreadsheet will reproduce.
 */
function quantileSorted(s: Float64Array, p: number): number {
  const m = s.length;
  const pos = p * (m - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(m - 1, lo + 1);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

interface Resolved {
  readonly ok: true;
  readonly horizon: number;
  readonly draws: number;
  readonly lambda: number;
  readonly history: number;
}

function resolve(opts: OutlookOptions, drawsDefault: number): Resolved | Refused {
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const draws = opts.draws ?? drawsDefault;
  const lambda = opts.lambda ?? EWMA_LAMBDA;
  const history = opts.history ?? DEFAULT_HISTORY;
  if (!isInt(horizon, 1, MAX_HORIZON))
    return refuse(`A horizon of ${horizon} bars is outside 1–${MAX_HORIZON}.`);
  if (!isInt(draws, 1, MAX_DRAWS))
    return refuse(`${draws} simulated paths is outside 1–${MAX_DRAWS}.`);
  if (!(lambda > 0 && lambda < 1))
    return refuse(`A volatility decay of ${lambda} is outside (0, 1).`);
  if (!isInt(history, MIN_RESIDUALS, 1_000_000))
    return refuse(`A history window of ${history} bars is under the ${MIN_RESIDUALS} the tails need.`);
  return { ok: true, horizon, draws, lambda, history };
}

/* ─────────────────────────────────────────────────────────────── simulation */

/**
 * The simulation kernel, exposed so it can be checked by hand.
 *
 * Each path starts at `last`; each step draws one residual uniformly with
 * replacement from `residuals`, multiplies it by `sigma` and adds it to the
 * log price. With a pool of identical residuals z, every path is identical
 * and the close at step h is exactly `last · exp(h·z·sigma)`.
 */
export function simulatePaths(
  last: number,
  sigma: number,
  residuals: ArrayLike<number>,
  horizon: number,
  draws: number,
  seed: number,
): SimulatedPaths {
  const m = residuals.length;
  const closes = new Float64Array(draws * horizon);
  const next = rng(seed);
  const logLast = Math.log(last);
  for (let d = 0; d < draws; d++) {
    let lp = logLast;
    const base = d * horizon;
    for (let h = 0; h < horizon; h++) {
      /* Math.min guards the (theoretically impossible) u === 1. */
      const k = Math.min(m - 1, Math.floor(next() * m));
      lp += (residuals[k] as number) * sigma;
      closes[base + h] = Math.exp(lp);
    }
  }
  return { last, draws, horizon, closes };
}

/** Per-horizon quantiles of a path set. */
export function coneSteps(paths: SimulatedPaths): ConeStep[] {
  const { draws, horizon, closes } = paths;
  const col = new Float64Array(draws);
  const steps: ConeStep[] = [];
  for (let h = 0; h < horizon; h++) {
    for (let d = 0; d < draws; d++) col[d] = closes[d * horizon + h] as number;
    col.sort();
    steps.push({
      h: h + 1,
      p5: quantileSorted(col, 0.05),
      p25: quantileSorted(col, 0.25),
      p50: quantileSorted(col, 0.5),
      p75: quantileSorted(col, 0.75),
      p95: quantileSorted(col, 0.95),
    });
  }
  return steps;
}

/**
 * Simulate the outlook once and return the cone AND a touch-odds function on
 * the same paths, so the range and the odds the UI prints beside it can never
 * come from two different simulations.
 */
export function simulateOutlook(
  bars: readonly BarView[],
  opts: OutlookOptions = {},
): Outlook | Refused {
  const r = resolve(opts, DEFAULT_DRAWS);
  if (!r.ok) return r;
  const { horizon, draws, lambda, history } = r;

  const nBars = bars.length;
  if (nBars < MIN_OUTLOOK_BARS)
    return refuse(
      `${nBars} bars loaded — a ${horizon}-bar outlook needs at least ${MIN_OUTLOOK_BARS}, so nothing is being claimed.`,
    );
  const bad = badClose(bars);
  if (bad >= 0)
    return refuse(`Bar ${bad} has no usable close, so past moves cannot be measured across it.`);

  const sigmaNow = ewmaSigma(bars, lambda);
  if (!Number.isFinite(sigmaNow) || sigmaNow <= 0)
    return refuse("Price has not moved over the recent history, so there is no volatility to project.");

  const sig = sigmaSeries(bars, lambda);
  const z = residualSeries(bars, sig);
  const res = pool(z, nBars - history, nBars - 1);
  if (res.length < MIN_RESIDUALS)
    return refuse(
      `Only ${res.length} past moves could be measured against their volatility — under ${MIN_RESIDUALS}, too few to describe the tails.`,
    );

  const last = (bars[nBars - 1] as BarView).c;
  const seed = opts.seed ?? defaultSeed(bars);
  const paths = simulatePaths(last, sigmaNow, res, horizon, draws, seed);
  const steps = coneSteps(paths);

  let up = 0;
  for (let d = 0; d < draws; d++) if ((paths.closes[d * horizon + horizon - 1] as number) > last) up++;

  for (const s of steps)
    if (![s.p5, s.p25, s.p50, s.p75, s.p95].every(Number.isFinite))
      return refuse("The simulated range overflowed — volatility is too extreme to project this far.");

  const cone: OutlookCone = {
    ok: true,
    last,
    steps,
    pUp: up / draws,
    up,
    sigmaNow,
    n: res.length,
    draws,
    horizon,
    seed,
    lambda,
    basis: "modelled",
    assumptions: CONE_ASSUMPTIONS(res.length),
  };
  return { ok: true, cone, paths, touch: (plan) => touchOdds(paths, plan) };
}

/** The cone alone. */
export function outlookCone(
  bars: readonly BarView[],
  opts: OutlookOptions = {},
): OutlookCone | Refused {
  const o = simulateOutlook(bars, opts);
  return o.ok ? o.cone : o;
}

/** A seed that is a function of the data, like `resample.ts`'s: the same
 *  bars give the same cone regardless of what was computed before. */
function defaultSeed(bars: readonly BarView[]): number {
  const tail = bars.slice(-64).map((b) => b.c);
  return seedFrom([bars.length, ...tail]);
}

/* ───────────────────────────────────────────────────────────── touch odds */

function checkPlan(plan: TradePlan, last: number): string | null {
  const { direction, entry, stop, target1, target2 } = plan;
  const levels = [entry, stop, target1, ...(target2 === undefined ? [] : [target2])];
  if (!levels.every((v) => Number.isFinite(v) && v > 0))
    return "The plan has a missing or non-positive level.";
  const long = direction === "long";
  const above = (a: number, b: number): boolean => (long ? a > b : a < b);
  const side = long ? "below" : "above";
  const far = long ? "above" : "below";
  if (!above(entry, stop)) return `A ${direction} stop must be ${side} the entry.`;
  if (!above(target1, entry)) return `A ${direction} target must be ${far} the entry.`;
  if (target2 !== undefined && !above(target2, target1))
    return `Target 2 must be beyond target 1 for a ${direction}.`;
  if (!above(last, stop)) return "The last close is already through the stop.";
  if (!above(target1, last)) return "The last close is already through target 1.";
  return null;
}

/**
 * Share of paths that touch target 1 before the stop, the stop before target
 * 1, or neither, within the horizon — plus target 2 before the stop.
 *
 * A step whose close is at or beyond a level counts as a touch. A close cannot
 * be beyond both the stop and a target at once, so there are no ties.
 */
export function touchOdds(paths: SimulatedPaths, plan: TradePlan): TouchOdds | Refused {
  const why = checkPlan(plan, paths.last);
  if (why !== null) return refuse(why);
  const { draws, horizon, closes } = paths;
  if (draws < 1 || horizon < 1) return refuse("There are no simulated paths to count.");

  const long = plan.direction === "long";
  const hit = (c: number, level: number): boolean => (long ? c >= level : c <= level);
  const stopped = (c: number): boolean => (long ? c <= plan.stop : c >= plan.stop);
  const t2 = plan.target2;

  let nT1 = 0;
  let nStop = 0;
  let nT2 = 0;
  for (let d = 0; d < draws; d++) {
    let first: "t1" | "stop" | null = null;
    for (let h = 0; h < horizon; h++) {
      const c = closes[d * horizon + h] as number;
      if (stopped(c)) {
        if (first === null) first = "stop";
        break;
      }
      if (first === null && hit(c, plan.target1)) first = "t1";
      if (t2 !== undefined && hit(c, t2)) {
        nT2++;
        break;
      }
      if (first !== null && t2 === undefined) break;
    }
    if (first === "t1") nT1++;
    else if (first === "stop") nStop++;
  }
  const nNeither = draws - nT1 - nStop;
  return {
    ok: true,
    target1First: nT1 / draws,
    stopFirst: nStop / draws,
    neither: nNeither / draws,
    target2First: t2 === undefined ? null : nT2 / draws,
    counts: { target1: nT1, stop: nStop, neither: nNeither, target2: t2 === undefined ? null : nT2 },
    draws,
    horizon,
    basis: "modelled",
    assumptions: TOUCH_ASSUMPTIONS,
  };
}

/* ────────────────────────────────────────────────────────────── calibration */

/**
 * Out-of-sample check of the 90% band (p5–p95) at horizon H.
 *
 * Origins are every H bars from the first point with `MIN_OUTLOOK_BARS` of
 * history, so outcome windows never overlap and each trial is independent
 * evidence rather than a near-copy of its neighbour. At each origin the band
 * is built from bars up to and including the origin only — the volatility
 * series is causal, so one pass over the whole history gives, at bar o,
 * exactly the sigma a live run at o would have seen — and scored against the
 * close H bars later.
 *
 * Uses `CALIBRATION_DRAWS` (500) per origin by default; see the file header
 * for the measured cost.
 */
export function outlookCalibration(
  bars: readonly BarView[],
  opts: OutlookOptions = {},
): OutlookCalibration | Refused {
  const r = resolve(opts, CALIBRATION_DRAWS);
  if (!r.ok) return r;
  const { horizon, draws, lambda, history } = r;

  const nBars = bars.length;
  const firstOrigin = MIN_OUTLOOK_BARS - 1;
  if (nBars < MIN_OUTLOOK_BARS + horizon)
    return refuse(
      `${nBars} bars loaded — checking a ${horizon}-bar band needs at least ${MIN_OUTLOOK_BARS + horizon}.`,
    );
  const bad = badClose(bars);
  if (bad >= 0)
    return refuse(`Bar ${bad} has no usable close, so the band cannot be replayed across it.`);

  const sig = sigmaSeries(bars, lambda);
  const z = residualSeries(bars, sig);
  const seed = opts.seed ?? defaultSeed(bars);
  const next = rng(seed);

  let trials = 0;
  let inside = 0;
  const finals = new Float64Array(draws);
  for (let o = firstOrigin; o + horizon < nBars; o += horizon) {
    const s = sig[o + 1] as number;
    if (!(s > 0) || !Number.isFinite(s)) continue;
    const res = pool(z, o + 1 - history, o);
    const m = res.length;
    if (m < MIN_RESIDUALS) continue;
    for (let d = 0; d < draws; d++) {
      let sum = 0;
      for (let h = 0; h < horizon; h++) sum += res[Math.min(m - 1, Math.floor(next() * m))] as number;
      finals[d] = sum * s;
    }
    finals.sort();
    const origin = (bars[o] as BarView).c;
    const lo = origin * Math.exp(quantileSorted(finals, 0.05));
    const hi = origin * Math.exp(quantileSorted(finals, 0.95));
    const realised = (bars[o + horizon] as BarView).c;
    trials++;
    if (realised >= lo && realised <= hi) inside++;
  }

  if (trials === 0)
    return refuse("No past point had enough history and movement to check the band against.");

  const coverage = inside / trials;
  const usable = trials >= MIN_CALIBRATION_TRIALS;
  const pct = Math.round(coverage * 100);
  return {
    ok: true,
    coverage,
    inside,
    trials,
    nominal: CALIBRATION_NOMINAL,
    usable,
    horizon,
    draws,
    stride: horizon,
    basis: "measured",
    note: usable
      ? `The 90% band held ${pct}% of the time over ${trials} past checks, ${horizon} bars ahead.`
      : `The 90% band held ${inside} of ${trials} past checks — under ${MIN_CALIBRATION_TRIALS}, too few to say whether it is calibrated.`,
  };
}
