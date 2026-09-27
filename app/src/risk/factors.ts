/**
 * A MULTI-FACTOR RISK MODEL.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS TO `portfolio.ts`, AND WHY IT IS A SEPARATE FILE
 *
 * `factorExposures` there is a ONE-factor model against a nominated symbol,
 * BTCUSDT by default, and its own header is honest about what that is: "not a
 * market factor in any academic sense but IS the thing that moves everything
 * else". For a crypto-only book that is the right model and this one is
 * overkill. For a book holding gold, EURUSD and crypto it says almost nothing —
 * regressing XAUUSD on BTCUSDT measures noise — and a `Scenario` carrying a
 * single `factorMove` cannot express "rates up 250bp while equities fall 20%
 * and the dollar rallies 8%", which is what 2022 was.
 *
 * The factor series were already in the archive and held deeper than anything
 * traded: DXY to 1971, SPX to 1928, US10Y to 1962, VIX to 1990. They were
 * reachable from the rule engine's COLUMNS and from nothing on the risk desk.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR WAYS THIS LIES IF IT IS WRITTEN CARELESSLY
 *
 * 1. **A YIELD IS NOT A PRICE.** `alignSeries` in `portfolio.ts` takes a log
 *    return of every column, and for US10Y going 4.00 to 4.20 that is
 *    `log(4.2/4.0)` = 0.0488 — which reads as a 4.9% move and is a different
 *    quantity from the +20 BASIS POINTS that actually happened. Every
 *    sensitivity to rates is per bp. A yield can also print zero or negative,
 *    where a log ratio is undefined rather than merely wrong. Same class as the
 *    lots-versus-units defect this project already records: a unit that defaults
 *    is a wrong answer with no symptom, so every factor DECLARES its transform.
 *
 * 2. **COLLINEAR FACTORS PRODUCE CONFIDENT NONSENSE.** US10Y and US02Y move
 *    together; SPX and NDX more so. Regress on both and one effect is split
 *    between two coefficients almost arbitrarily — the betas swing between
 *    samples while R² barely moves, so the fit looks fine and the attribution is
 *    fiction. `varianceInflation` measures it and the model REFUSES the beta
 *    rather than printing it.
 *
 * 3. **A DECOMPOSITION THAT DOES NOT SUM IS NOT A DECOMPOSITION.** The factor
 *    parts plus the idiosyncratic part must account for the whole of portfolio
 *    variance, or a reader finding the gap cannot tell a category from a bug.
 *
 * 4. **NO FORWARD FILL.** Crypto trades weekends and the S&P does not. Carrying
 *    Friday's index forward invents two zero returns a week, which drags every
 *    covariance toward zero AND inflates the sample the intervals are computed
 *    from — wrong twice, in the same direction, towards a book that looks calmer
 *    than it is. The intersection is used and its size is reported.
 */

import type { ClosesSeries } from "../data/correlation";
import type { Exposure } from "./portfolio";

/* ---------------------------------------------------------------- units --- */

/**
 * How a factor's level becomes a move.
 *
 * `price` — a log return, the right thing for an index or an exchange rate.
 * `yield` — a CHANGE IN BASIS POINTS. A rate is already a percentage; the ratio
 *           of two rates is not a return and has no useful interpretation.
 */
export type FactorKind = "price" | "yield";

export interface FactorDef {
  readonly id: string;
  /** The archive symbol this reads. */
  readonly symbol: string;
  readonly label: string;
  readonly kind: FactorKind;
  /** Named on screen beside every number derived from it. */
  readonly unit: string;
  /** What a positive move MEANS, in the operator's words. */
  readonly up?: string;
}

/**
 * The default factor set.
 *
 * CHOSEN TO BE READABLE AND AS INDEPENDENT AS THE WORLD ALLOWS, not to be
 * complete. NDX is deliberately absent even though the archive holds it: it
 * correlates with SPX far too closely to carry its own coefficient, and adding
 * it would split one equity effect across two columns. US02Y is absent for the
 * same reason against US10Y. Both are still available to name explicitly, and
 * `varianceInflation` will say what it thinks of the choice.
 */
export const FACTORS: readonly FactorDef[] = [
  {
    id: "equity",
    symbol: "SPX",
    label: "Equities",
    kind: "price",
    unit: "log return",
    up: "risk assets bid",
  },
  {
    id: "dollar",
    symbol: "DXY",
    label: "US dollar",
    kind: "price",
    unit: "log return",
    up: "the dollar stronger against everything",
  },
  {
    id: "rates",
    symbol: "US10Y",
    label: "US 10-year yield",
    kind: "yield",
    unit: "basis points",
    up: "long rates higher — a discount-rate shock",
  },
  {
    id: "vol",
    symbol: "VIX",
    label: "Equity volatility",
    kind: "price",
    unit: "log change",
    up: "fear bid; usually the mirror of equities, but not always",
  },
  {
    id: "crypto",
    symbol: "BTCUSDT",
    label: "Crypto beta",
    kind: "price",
    unit: "log return",
    up: "crypto risk appetite",
  },
];

export function factorById(id: string): FactorDef | null {
  return FACTORS.find((f) => f.id === id) ?? null;
}

/**
 * Levels to moves, one factor's worth.
 *
 * Returns `n - 1` values. NaN survives rather than being dropped, because the
 * caller aligns on shared timestamps and a hole here has to stay a hole there.
 */
export function transformSeries(levels: readonly number[], kind: FactorKind): number[] {
  const out: number[] = [];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1] as number;
    const b = levels[i] as number;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      out.push(Number.NaN);
      continue;
    }
    if (kind === "yield") {
      /* BASIS POINTS. A yield quoted as 4.20 is 4.20 PER CENT, so one point of
         it is 100bp. Subtraction, never a ratio — see the header. */
      out.push((b - a) * 100);
    } else {
      out.push(a > 0 && b > 0 ? Math.log(b / a) : Number.NaN);
    }
  }
  return out;
}

/* ----------------------------------------------------------- sampling ---- */

/**
 * Last close of each UTC day.
 *
 * WHY THIS IS NEEDED RATHER THAN OBVIOUS. The archive read the Risk desk uses
 * picks, per symbol, WHICHEVER STORED SERIES HOLDS THE MOST BARS — which is the
 * right rule for a covariance over one asset class and gives BTCUSDT at one
 * minute (400,132 bars) beside SPX at one day (24,801). Joining those on shared
 * timestamps happens to work, because the minute series contains the midnight
 * marks, but it works by accident: change the daily stamp to a market close and
 * the intersection silently collapses to nothing.
 *
 * A factor model is a DAILY model — equity indices and yields have no meaningful
 * intraday print in this archive — so the sampling is stated here instead of
 * being inherited from whatever happened to be stored.
 *
 * THE LAST CLOSE, NOT THE FIRST OR A MEAN: it is the only one of the three that
 * is a price the market actually printed at a moment, and a mean of a day is a
 * number nobody could have traded.
 */
export function toDailyCloses(series: ClosesSeries): ClosesSeries {
  const DAY = 86_400_000;
  const last = new Map<number, { t: number; c: number }>();
  for (const p of series.closes) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.c)) continue;
    const day = Math.floor(p.t / DAY);
    const held = last.get(day);
    if (held === undefined || p.t >= held.t) last.set(day, { t: p.t, c: p.c });
  }
  const closes = [...last.entries()]
    .sort((a, b) => a[0] - b[0])
    /* KEYED TO THE DAY, not to the bar's own timestamp. Two series whose last
       bar of the day falls at different minutes would otherwise never share a
       timestamp, which is the whole failure this function exists to prevent. */
    .map(([day, v]) => ({ t: day * DAY, c: v.c }));
  return { symbol: series.symbol, closes };
}

/* ------------------------------------------------------------ alignment --- */

export interface FactorMatrix {
  /** Factor ids, in column order. */
  readonly ids: readonly string[];
  /** `rows[i][j]` is factor j's move over row i, in that factor's own unit. */
  readonly rows: readonly (readonly number[])[];
  readonly times: readonly number[];
  readonly from: number;
  readonly to: number;
  readonly dropped: {
    /** Timestamps one or more series did not have. */
    readonly notShared: number;
    /** Rows thrown out because a move could not be computed. */
    readonly unreadable: number;
  };
}

const EMPTY: FactorMatrix = {
  ids: [],
  rows: [],
  times: [],
  from: 0,
  to: 0,
  dropped: { notShared: 0, unreadable: 0 },
};

/**
 * Join the factor series on the timestamps they ALL share, then transform.
 *
 * The intersection is taken BEFORE differencing, for the reason `alignSeries`
 * gives and which is worth repeating: differencing first would manufacture a
 * move spanning a gap, and gaps cluster in exactly the volatile stretches the
 * tail numbers are read from.
 */
export function alignFactors(
  series: readonly ClosesSeries[],
  defs: readonly FactorDef[],
): FactorMatrix {
  if (series.length === 0 || defs.length === 0) return EMPTY;

  const maps = defs.map((d) => {
    const s = series.find((x) => x.symbol === d.symbol);
    const m = new Map<number, number>();
    for (const p of s?.closes ?? []) {
      if (Number.isFinite(p.t) && Number.isFinite(p.c)) m.set(p.t, p.c);
    }
    return m;
  });
  if (maps.some((m) => m.size === 0)) return { ...EMPTY, ids: defs.map((d) => d.id) };

  const first = maps[0] as Map<number, number>;
  const shared: number[] = [];
  let notShared = 0;
  for (const t of first.keys()) {
    if (maps.every((m) => m.has(t))) shared.push(t);
    else notShared += 1;
  }
  /* Timestamps the OTHER series had and the first did not are dropped too, and
     they are counted: a reported intersection that only counts one side's
     losses understates how much was thrown away. */
  for (let j = 1; j < maps.length; j++) {
    for (const t of (maps[j] as Map<number, number>).keys()) {
      if (!first.has(t)) notShared += 1;
    }
  }
  shared.sort((a, b) => a - b);

  const times: number[] = [];
  const rows: number[][] = [];
  let unreadable = 0;
  for (let i = 1; i < shared.length; i++) {
    const t0 = shared[i - 1] as number;
    const t1 = shared[i] as number;
    const row = defs.map((d, j) => {
      const m = maps[j] as Map<number, number>;
      return transformSeries([m.get(t0) as number, m.get(t1) as number], d.kind)[0] as number;
    });
    if (row.some((v) => !Number.isFinite(v))) {
      unreadable += 1;
      continue;
    }
    times.push(t1);
    rows.push(row);
  }

  return {
    ids: defs.map((d) => d.id),
    rows,
    times,
    from: times[0] ?? 0,
    to: times[times.length - 1] ?? 0,
    dropped: { notShared, unreadable },
  };
}

/* ------------------------------------------------------------ the solver -- */

export interface Regression {
  readonly ok: boolean;
  /** One per column of X, in the same order. Empty when `ok` is false. */
  readonly betas: readonly number[];
  readonly intercept: number;
  readonly r2: number;
  /** Standard deviation of what the factors did NOT explain, per row. */
  readonly residVol: number;
  /** Standard error of each beta, same order. */
  readonly stdErrs: readonly number[];
  /**
   * beta / stdErr. How many standard errors the coefficient sits from zero.
   *
   * IT MATTERS MOST WHERE THE UNIT IS SMALL. A beta against a BASIS-POINT factor
   * is around 1e-4, and a 250bp scenario multiplies it by 250 — so a coefficient
   * that is pure estimation noise becomes a large, confident-looking P&L leg.
   * MEASURED while writing the scenario tests: an asset constructed with NO rates
   * exposure produced +14,408 on a book of 10,000 from a fitted rates beta that
   * was not distinguishable from zero.
   */
  readonly tStats: readonly number[];
  readonly sample: number;
  readonly why: string | null;
}

const FAILED = (sample: number, why: string): Regression => ({
  ok: false,
  betas: [],
  intercept: Number.NaN,
  r2: Number.NaN,
  residVol: Number.NaN,
  stdErrs: [],
  tStats: [],
  sample,
  why,
});

/**
 * Ordinary least squares of `y` on the columns of `X`, with an intercept.
 *
 * Solved through the normal equations by Gaussian elimination with partial
 * pivoting. That is not the most numerically careful route — a QR would be —
 * and it is the right one here because the refusal matters more than the last
 * digit: a system this ill-conditioned is one whose coefficients nobody should
 * read, so DETECTING that is the job and `MAX_VIF` is where it is reported.
 */
export function regress(y: readonly number[], X: readonly (readonly number[])[]): Regression {
  const n = y.length;
  const k = X.length;
  if (k === 0) return FAILED(n, "no factors were supplied");
  if (X.some((c) => c.length !== n)) return FAILED(n, "a factor column is a different length from the asset");
  if (n <= k + 1) return FAILED(n, `${n} observations cannot fit ${k} factors`);

  /* Centre everything, so the intercept falls out and the normal equations are
     in covariances rather than raw sums — better conditioned, and the intercept
     is recovered at the end from the means. */
  const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const my = mean(y);
  const mx = X.map(mean);
  const yc = y.map((v) => v - my);
  const xc = X.map((col, j) => col.map((v) => v - (mx[j] as number)));

  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < k; i++) {
    const rowI = (xc[i] as number[]);
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      const colJ = (xc[j] as number[]);
      let s = 0;
      for (let t = 0; t < n; t++) s += (rowI[t] as number) * (colJ[t] as number);
      row.push(s);
    }
    A.push(row);
    let s = 0;
    for (let t = 0; t < n; t++) s += (rowI[t] as number) * (yc[t] as number);
    b.push(s);
  }

  const beta = solve(A, b);
  if (beta === null) {
    return FAILED(n, "the factor set is singular or collinear — no unique answer exists");
  }

  let ssr = 0;
  let sst = 0;
  for (let t = 0; t < n; t++) {
    let fit = 0;
    for (let j = 0; j < k; j++) fit += (beta[j] as number) * ((xc[j] as number[])[t] as number);
    const e = (yc[t] as number) - fit;
    ssr += e * e;
    sst += (yc[t] as number) * (yc[t] as number);
  }
  const dof = Math.max(1, n - k - 1);
  let intercept = my;
  for (let j = 0; j < k; j++) intercept -= (beta[j] as number) * (mx[j] as number);

  /* STANDARD ERRORS, from the diagonal of (X'X)^-1. Solved column by column
     rather than by forming the inverse: k is at most a handful here, and reusing
     the same elimination keeps one implementation of the arithmetic. */
  const residVol = Math.sqrt(ssr / dof);
  const stdErrs: number[] = [];
  const tStats: number[] = [];
  for (let j = 0; j < k; j++) {
    const e = Array.from({ length: k }, (_, i) => (i === j ? 1 : 0));
    const z = solve(A, e);
    const v = z === null ? Number.NaN : (z[j] as number);
    const se = v >= 0 ? residVol * Math.sqrt(v) : Number.NaN;
    stdErrs.push(se);
    tStats.push(se > 0 ? (beta[j] as number) / se : Number.NaN);
  }

  return {
    ok: true,
    betas: beta,
    intercept,
    r2: sst > 0 ? Math.max(0, 1 - ssr / sst) : Number.NaN,
    residVol,
    stdErrs,
    tStats,
    sample: n,
    why: null,
  };
}

/** Gaussian elimination with partial pivoting. `null` when singular. */
function solve(A: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const k = b.length;
  const m = A.map((row, i) => [...row, b[i] as number]);

  /* The pivot floor is RELATIVE to the matrix's own scale. An absolute epsilon
     would call a well-conditioned system of tiny covariances singular — and
     these are covariances of daily log returns, so every entry is around 1e-4. */
  let scale = 0;
  for (const row of m) for (let j = 0; j < k; j++) scale = Math.max(scale, Math.abs(row[j] as number));
  if (!(scale > 0)) return null;
  const floor = scale * 1e-12;

  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) {
      if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[piv] as number[])[c] as number)) piv = r;
    }
    if (Math.abs((m[piv] as number[])[c] as number) < floor) return null;
    const tmp = m[c] as number[];
    m[c] = m[piv] as number[];
    m[piv] = tmp;

    const pr = m[c] as number[];
    const pv = pr[c] as number;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const rr = m[r] as number[];
      const f = (rr[c] as number) / pv;
      if (f === 0) continue;
      for (let j = c; j <= k; j++) rr[j] = (rr[j] as number) - f * (pr[j] as number);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const row = m[i] as number[];
    const v = (row[k] as number) / (row[i] as number);
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/* ------------------------------------------------------- collinearity ----- */

/**
 * Above this, a coefficient is not worth reading.
 *
 * 5 corresponds to R² of 0.8 between one factor and the rest — at which point
 * four fifths of that column is already in the others and the split between them
 * is close to arbitrary. The conventional thresholds are 5 and 10; the stricter
 * one is taken because the consequence here is a number somebody sizes a hedge
 * from.
 */
export const MAX_VIF = 5;

/**
 * Variance inflation factor per column: `1 / (1 - R²)` of that column regressed
 * on all the others.
 *
 * This is the measurement that turns "these factors look related" into a
 * refusal with a number attached. A singular pair returns Infinity rather than
 * throwing, because Infinity is the honest answer and every comparison against
 * `MAX_VIF` then does the right thing.
 */
export function varianceInflation(X: readonly (readonly number[])[]): number[] {
  return X.map((col, j) => {
    const others = X.filter((_, i) => i !== j);
    if (others.length === 0) return 1;
    const r = regress(col, others);
    if (!r.ok) return Number.POSITIVE_INFINITY;
    const r2 = Number.isFinite(r.r2) ? Math.min(0.999999, Math.max(0, r.r2)) : 0;
    return 1 / (1 - r2);
  });
}

/* --------------------------------------------------------- per-asset ------ */

/** Below this many shared observations, a multi-factor fit is not reported. */
export const MIN_FACTOR_SAMPLE = 60;

/** Below this R², the factor set is not describing this asset. */
export const WEAK_R2 = 0.2;

/** |t| below this and the beta is not distinguishable from zero. */
export const MIN_T = 2;

export interface AssetFactorModel {
  readonly symbol: string;
  /** Beta per factor id. NaN where the fit was refused. */
  readonly betas: Readonly<Record<string, number>>;
  readonly r2: number;
  /** Per-row standard deviation of what the factors did not explain. */
  readonly idioVol: number;
  readonly sample: number;
  /** Factor ids whose coefficient is not worth reading, and why. */
  readonly unstable: readonly string[];
  /**
   * Factor ids whose beta is not distinguishable from zero at |t| >= 2.
   *
   * NOT ZEROED, REPORTED. Silently setting an insignificant beta to zero is its
   * own distortion — the estimate IS the best guess — but a scenario leg resting
   * on one is a number the reader has to be able to discount, and on a
   * basis-point factor that leg can dominate the total.
   */
  readonly insignificant: readonly string[];
  /** A sentence, not a flag: the reason differs and the reason is the point. */
  readonly caveat: string | null;
}

/**
 * Fit one asset's returns to the factor matrix.
 *
 * EVERY REFUSAL PATH IS NAMED. A thin sample, a singular factor set, a fit that
 * explains nothing — all three are ordinary, and a beta printed without the
 * reason beside it is the most misleading number on the desk.
 */
export function factorModel(
  symbol: string,
  assetMoves: readonly number[],
  factors: { readonly ids: readonly string[]; readonly rows: readonly (readonly number[])[] },
): AssetFactorModel {
  const n = Math.min(assetMoves.length, factors.rows.length);
  const ids = factors.ids;
  const blank: Record<string, number> = {};
  for (const id of ids) blank[id] = Number.NaN;

  if (n < MIN_FACTOR_SAMPLE) {
    return {
      symbol,
      betas: blank,
      r2: Number.NaN,
      idioVol: Number.NaN,
      sample: n,
      unstable: [],
      insignificant: [],
      caveat: `only ${n} shared observations — ${MIN_FACTOR_SAMPLE} is the floor for a multi-factor fit`,
    };
  }

  const cols: number[][] = ids.map((_, j) =>
    factors.rows.slice(0, n).map((r) => (r[j] as number) ?? Number.NaN),
  );
  const y = assetMoves.slice(0, n);

  const r = regress(y, cols);
  if (!r.ok) {
    return {
      symbol,
      betas: blank,
      r2: Number.NaN,
      idioVol: Number.NaN,
      sample: n,
      unstable: [...ids],
      insignificant: [],
      caveat: r.why,
    };
  }

  const vifs = varianceInflation(cols);
  const unstable = ids.filter((_, j) => (vifs[j] as number) > MAX_VIF);
  const insignificant = ids.filter(
    (_, j) => !(Math.abs(r.tStats[j] as number) >= MIN_T),
  );

  const betas: Record<string, number> = {};
  ids.forEach((id, j) => {
    betas[id] = unstable.includes(id) ? Number.NaN : (r.betas[j] as number);
  });

  let caveat: string | null = null;
  if (unstable.length > 0) {
    caveat =
      `${unstable.join(", ")} move too closely with the rest of the set to carry ` +
      `their own coefficient, so those betas are not reported`;
  } else if (insignificant.length === ids.length) {
    caveat = `none of these factors moves ${symbol} by more than the noise in the estimate`;
  } else if (r.r2 < WEAK_R2) {
    caveat =
      `these factors explain ${(r.r2 * 100).toFixed(0)}% of what ${symbol} did — ` +
      `almost all of its risk is idiosyncratic, and the betas describe very little`;
  }

  return { symbol, betas, r2: r.r2, idioVol: r.residVol, sample: n, unstable, insignificant, caveat };
}

/* ------------------------------------------------------ portfolio level --- */

export interface FactorContribution {
  readonly id: string;
  /** Money moved by a one-unit move in this factor. Signed. */
  readonly exposure: number;
  /** This factor's part of portfolio variance, in money². */
  readonly variance: number;
  /** 0..1 of total variance. */
  readonly share: number;
}

export interface PortfolioFactorRisk {
  readonly byFactor: readonly FactorContribution[];
  readonly idiosyncraticVariance: number;
  readonly idiosyncraticShare: number;
  readonly totalVariance: number;
  /** Money standard deviation per bar. */
  readonly vol: number;
  /** Symbols in the book with no model. Never scored as flat. */
  readonly unmodelled: readonly string[];
  readonly caveat: string | null;
}

/** Above this share of gross notional unmodelled, no total is offered. */
export const MAX_UNMODELLED = 0.2;

/**
 * Decompose the book's variance into the factors and what is left.
 *
 * THE PARTS SUM TO THE WHOLE, and that is enforced rather than hoped for: the
 * factor block is `wᵀ B Σ Bᵀ w` and the idiosyncratic block is the weighted sum
 * of squared residual vols, which together ARE the model's total variance by
 * construction. Attributing a factor's share by its own diagonal term alone
 * would not sum, because factors covary — so each factor's share is its FULL
 * row of the factor covariance, which does sum, and that is the standard
 * attribution rather than a convenient one.
 *
 * An unmodelled position is NAMED and never scored as flat: silently treating a
 * position nobody could fit as riskless is the most flattering error available
 * here.
 */
export function portfolioFactorRisk(
  book: readonly Exposure[],
  models: readonly AssetFactorModel[],
  factors: { readonly ids: readonly string[]; readonly rows: readonly (readonly number[])[] },
): PortfolioFactorRisk {
  const ids = factors.ids;
  const byId = new Map(models.map((m) => [m.symbol, m]));

  const unmodelled: string[] = [];
  let gross = 0;
  let unmodelledNotional = 0;
  for (const e of book) {
    gross += Math.abs(e.signedNotional);
    const m = byId.get(e.symbol);
    const usable = m !== undefined && ids.every((id) => Number.isFinite(m.betas[id]));
    if (!usable) {
      unmodelled.push(e.symbol);
      unmodelledNotional += Math.abs(e.signedNotional);
    }
  }

  /* Money exposure to each factor: sum over positions of notional x beta. */
  const exposure = ids.map((id) => {
    let s = 0;
    for (const e of book) {
      const m = byId.get(e.symbol);
      const b = m?.betas[id];
      if (m === undefined || b === undefined || !Number.isFinite(b)) continue;
      s += e.signedNotional * b;
    }
    return s;
  });

  /* Factor covariance from the matrix itself — the same rows the betas were fit
     on, so the decomposition is internally consistent. */
  const n = factors.rows.length;
  const cov: number[][] = ids.map(() => ids.map(() => 0));
  if (n > 1) {
    const means = ids.map((_, j) => factors.rows.reduce((s, r) => s + ((r[j] as number) ?? 0), 0) / n);
    for (let a = 0; a < ids.length; a++) {
      for (let b = 0; b < ids.length; b++) {
        let s = 0;
        for (const r of factors.rows) {
          s += (((r[a] as number) ?? 0) - (means[a] as number)) * (((r[b] as number) ?? 0) - (means[b] as number));
        }
        (cov[a] as number[])[b] = s / (n - 1);
      }
    }
  }

  let factorVariance = 0;
  const rowTerm = ids.map((_, a) => {
    let s = 0;
    for (let b = 0; b < ids.length; b++) {
      s += (exposure[a] as number) * ((cov[a] as number[])[b] as number) * (exposure[b] as number);
    }
    factorVariance += s;
    return s;
  });

  let idio = 0;
  for (const e of book) {
    const m = byId.get(e.symbol);
    if (m === undefined || !Number.isFinite(m.idioVol)) continue;
    if (unmodelled.includes(e.symbol)) continue;
    const money = e.signedNotional * m.idioVol;
    idio += money * money;
  }

  const total = factorVariance + idio;
  const share = (v: number): number => (total > 0 ? v / total : Number.NaN);

  const unmodelledShare = gross > 0 ? unmodelledNotional / gross : 0;
  const caveat =
    unmodelledShare > MAX_UNMODELLED
      ? `${(unmodelledShare * 100).toFixed(0)}% of the book is unmodelled (${unmodelled.join(", ")}), ` +
        `so this total describes only part of it`
      : unmodelled.length > 0
        ? `${unmodelled.join(", ")} could not be modelled and is excluded, not counted as flat`
        : null;

  return {
    byFactor: ids.map((id, a) => ({
      id,
      exposure: exposure[a] as number,
      variance: rowTerm[a] as number,
      share: share(rowTerm[a] as number),
    })),
    idiosyncraticVariance: idio,
    idiosyncraticShare: share(idio),
    totalVariance: total,
    vol: total > 0 ? Math.sqrt(total) : 0,
    unmodelled,
    caveat,
  };
}
