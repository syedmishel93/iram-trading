/**
 * The four pieces of statistics the report cannot be honest without.
 *
 * Each one exists because a number shown without it is misleading rather than
 * merely incomplete:
 *
 *   BARTLETT BAND — a cross-correlation of 0.21 at lag 7 means nothing until
 *   you know what 0.21 looks like on noise of the same length. Without the
 *   band, every lag profile has a biggest bar and every biggest bar looks like
 *   a finding.
 *
 *   BENJAMINI–HOCHBERG — lives in `backtest/resample.ts` already and is used
 *   from there. Named here because it is the second half of the same job.
 *
 *   EXPECTED MAXIMUM — the best of four hundred tries is not a typical try.
 *   On pure noise the best of 400 standard normals averages about 2.9 standard
 *   errors above zero, and reporting it as though one test had been run turns
 *   nothing into a three-sigma result.
 *
 *   DEFLATED SHARPE — the expected maximum, applied to the number the strategy
 *   step produces, using the standard error of a Sharpe ratio rather than of a
 *   normal draw.
 *
 * ACCURACY, STATED
 * `normCdf` is Abramowitz & Stegun 7.1.26 — about 1.5e-7 absolute. `probit` is
 * Acklam's rational approximation — about 1.15e-9 relative. Both are far
 * tighter than the assumptions they serve, which are "returns are roughly
 * normal" and "the tries were roughly independent". Neither of those is true,
 * and saying so is the honest part.
 */

/** Euler–Mascheroni, for the expected-maximum approximation. */
const GAMMA = 0.577_215_664_901_532_9;

/**
 * Standard normal CDF. Abramowitz & Stegun 7.1.26 on the error function.
 */
export function normCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.327_591_1 * x);
  const y =
    1 -
    ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736) * t +
      0.254_829_592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Two-sided p-value for a z statistic. */
export function twoSidedP(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(1, 2 * (1 - normCdf(Math.abs(z))));
}

const A = [-3.969_683_028_665_376e1, 2.209_460_984_245_205e2, -2.759_285_104_469_687e2, 1.383_577_518_672_690e2, -3.066_479_806_614_716e1, 2.506_628_277_459_239];
const B = [-5.447_609_879_822_406e1, 1.615_858_368_580_409e2, -1.556_989_798_598_866e2, 6.680_131_188_771_972e1, -1.328_068_155_288_572e1];
const C = [-7.784_894_002_430_293e-3, -3.223_964_580_411_365e-1, -2.400_758_277_161_838, -2.549_732_539_343_734, 4.374_664_141_464_968, 2.938_163_982_698_783];
const D = [7.784_695_709_041_462e-3, 3.224_671_290_700_398e-1, 2.445_134_137_142_996, 3.754_408_661_907_416];

/** Inverse standard normal CDF. Acklam's rational approximation. */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const at = (arr: readonly number[], i: number): number => arr[i] ?? 0;
  const plow = 0.024_25;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((at(C, 0) * q + at(C, 1)) * q + at(C, 2)) * q + at(C, 3)) * q + at(C, 4)) * q + at(C, 5)
    ) / ((((at(D, 0) * q + at(D, 1)) * q + at(D, 2)) * q + at(D, 3)) * q + 1);
  }
  if (p > phigh) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((at(A, 0) * r + at(A, 1)) * r + at(A, 2)) * r + at(A, 3)) * r + at(A, 4)) * r + at(A, 5)) * q) /
    (((((at(B, 0) * r + at(B, 1)) * r + at(B, 2)) * r + at(B, 3)) * r + at(B, 4)) * r + 1)
  );
}

/**
 * The band inside which a cross-correlation is indistinguishable from noise.
 *
 * Bartlett's large-sample standard error for a sample cross-correlation is
 * 1/sqrt(n), so the two-sided 95% band is 1.96/sqrt(n). It assumes both series
 * are white noise, which returns very nearly are and prices emphatically are
 * not — which is why the panel this is applied to is built from RETURNS, in
 * `data/panel.ts`, and why applying it to a price series would produce a band
 * far too narrow to mean anything.
 */
export function bartlettBand(n: number, z = 1.96): number {
  if (!Number.isFinite(n) || n <= 1) return Infinity;
  return z / Math.sqrt(n);
}

/**
 * The average largest of `k` independent standard normal draws.
 *
 * Bailey & López de Prado's approximation, which blends the (1 - 1/k) and
 * (1 - 1/(k e)) quantiles with the Euler–Mascheroni constant. At k = 1 it is
 * 0 by construction; at k = 400 it is about 2.9, which is the sentence the
 * report needs: the best of four hundred tries sits three standard errors
 * above zero when nothing is there.
 *
 * INDEPENDENCE IS ASSUMED AND IS NOT TRUE. Ninety-seven lags of the same two
 * series are heavily correlated tests, so the effective k is smaller than the
 * count and this correction is therefore CONSERVATIVE — it deflates more than
 * strictly necessary. Erring that way is deliberate; the other direction is
 * how a backtest gets published.
 */
export function expectedMaxNormal(k: number): number {
  if (!Number.isFinite(k) || k <= 1) return 0;
  return (1 - GAMMA) * probit(1 - 1 / k) + GAMMA * probit(1 - 1 / (k * Math.E));
}

export interface DeflatedSharpe {
  readonly observed: number;
  readonly tries: number;
  readonly observations: number;
  /** Standard error of the Sharpe estimate at this sample size. */
  readonly standardError: number;
  /** What the best of `tries` would have scored on no edge at all. */
  readonly hurdle: number;
  readonly deflated: number;
  readonly working: string;
}

/**
 * The Sharpe ratio, minus what being the best of `tries` is worth on its own.
 *
 * `observed` MUST BE A PER-OBSERVATION SHARPE — mean over standard deviation
 * of the same n returns that `observations` counts. An ANNUALISED Sharpe has
 * been multiplied by sqrt(periods per year) and does not belong here: the
 * hurdle would be computed against a standard error smaller by that same
 * factor, and the correction would appear to have happened while barely
 * moving the number. Measured on a live study, an annualised 4.93 over 77
 * trades came back deflated by 0.85.
 *
 * The standard error of a Sharpe estimate over n observations is
 * sqrt((1 + S²/2) / n) — wider for a higher Sharpe, because a higher Sharpe
 * means the variance estimate matters more. The hurdle is the expected maximum
 * of `tries` draws at that standard error, and the deflated figure is what is
 * left after clearing it.
 *
 * A deflated Sharpe at or below zero does not mean the strategy lost money. It
 * means its result is what the search would have produced from nothing, which
 * is a different and more useful statement than "it made 18%".
 */
export function deflatedSharpe(
  observed: number,
  tries: number,
  observations: number,
): DeflatedSharpe {
  const n = Math.max(1, Math.floor(observations));
  const se = Math.sqrt((1 + (observed * observed) / 2) / n);
  const hurdle = expectedMaxNormal(tries) * se;
  const deflated = observed - hurdle;
  return {
    observed,
    tries,
    observations: n,
    standardError: se,
    hurdle,
    deflated,
    working:
      `Sharpe ${observed.toFixed(2)} over ${n.toLocaleString()} observations has a standard error of ${se.toFixed(3)}. ` +
      `The best of ${tries.toLocaleString()} tries on no edge at all averages ${expectedMaxNormal(tries).toFixed(2)} standard errors above zero, ` +
      `which is ${hurdle.toFixed(2)} of Sharpe. What is left is ${deflated.toFixed(2)}. ` +
      `The tries are treated as independent and are not, so this deflates more than strictly necessary.`,
  };
}

/** Pearson correlation of two equal-length series. NaN-safe, pairwise. */
export function pearsonAt(
  x: readonly number[],
  y: readonly number[],
  lag: number,
): { r: number; n: number } {
  /* Positive lag means y is read `lag` rows LATER than x — that is, x moved
     first. Getting this sign backwards inverts the entire finding, which is
     why the report prints the direction as a sentence rather than as a number
     with a sign the reader has to interpret. */
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let n = 0;
  const from = Math.max(0, -lag);
  const to = Math.min(x.length, y.length - lag);
  for (let i = from; i < to; i += 1) {
    const a = x[i];
    const b = y[i + lag];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    sx += a;
    sy += b;
    sxx += a * a;
    syy += b * b;
    sxy += a * b;
    n += 1;
  }
  if (n < 3) return { r: NaN, n };
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  if (vx <= 0 || vy <= 0) return { r: NaN, n };
  return { r: cov / Math.sqrt(vx * vy), n };
}

/** Mean of the finite entries, or NaN when there are none. */
export function meanOf(xs: readonly number[]): number {
  let s = 0;
  let n = 0;
  for (const v of xs) {
    if (Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? NaN : s / n;
}

/** Sample standard deviation of the finite entries, or NaN. */
export function stdevOf(xs: readonly number[]): number {
  const m = meanOf(xs);
  if (!Number.isFinite(m)) return NaN;
  let s = 0;
  let n = 0;
  for (const v of xs) {
    if (Number.isFinite(v)) {
      s += (v - m) ** 2;
      n += 1;
    }
  }
  return n < 2 ? NaN : Math.sqrt(s / (n - 1));
}
