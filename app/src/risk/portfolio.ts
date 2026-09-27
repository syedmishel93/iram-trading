/**
 * PORTFOLIO RISK — what the book is actually exposed to, as opposed to what the
 * position list says it is.
 *
 * WHY THIS EXISTS SEPARATELY FROM sizing.ts
 * `portfolioHeat` answers "if every stop is hit, what do I lose?" That is the
 * right question for ONE trade and the wrong one for a book, because it adds
 * the losses up as though the positions were independent. They are not. Three
 * long crypto positions are one bet wearing three names, and on the day it goes
 * wrong all three stops are hit by the same candle.
 *
 * Everything below therefore works on the book's own RETURN HISTORY rather than
 * on its stop distances. That is the only way to see correlation, and it is
 * what separates a position sizer from a risk system.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR RULES, AND THEY ARE WHY THE NUMBERS CAN BE TRUSTED
 *
 * 1. NOTHING IS EXTRAPOLATED. Every figure here is a statistic of bars that
 *    were actually fetched and stored. There is no parametric fallback: if the
 *    history is too short, the function refuses and says how short it was. A
 *    normal-distribution VaR computed from 12 observations is not a smaller
 *    version of the real answer, it is a different and much more confident
 *    number than the data supports, and financial history is a graveyard of
 *    people who shipped one.
 *
 * 2. THE DECOMPOSITION ADDS UP. Component risk is computed as expected
 *    shortfall conditional on the portfolio's own worst days, which is the one
 *    decomposition that sums EXACTLY to the portfolio figure. Marginal-VaR
 *    approximations do not, and a "contributions" table whose column does not
 *    equal its own total is a table that will be quietly disbelieved.
 *
 * 3. A BETA WITHOUT ITS R² IS A LIE. Every exposure here carries how much of
 *    the asset's movement the factor actually explained. A beta of 1.4 at
 *    R² = 0.08 means the asset does whatever it likes, and reporting only the
 *    1.4 invites someone to hedge against a relationship that is not there.
 *
 * 4. VaR IS A QUANTILE OF THE PAST, NOT A MAXIMUM. Losses exceed it by
 *    definition — on 5% of days at the 95% level. That is what the expected
 *    shortfall beside it is for, and it is why both are always returned
 *    together and never one alone.
 */

import type { Position } from "./sizing";
import type { ClosesSeries } from "../data/correlation";

/* ------------------------------------------------------------------ join --- */

/**
 * The minimum history any figure here will be computed from.
 *
 * 60 aligned observations. Not a round number picked for looking careful: the
 * 95% VaR is the 5th percentile, so 60 bars put exactly three observations in
 * the tail that defines it. Below that the "5% worst day" is one or two
 * candles, and the answer is a report on those candles rather than on the book.
 * Even at 60 it is thin, which is why `sample` is returned with every result
 * and rendered next to it.
 */
export const MIN_HISTORY = 60;

/** Tail levels offered. More than two is false precision on this sample size. */
export const VAR_LEVELS = [0.95, 0.99] as const;
export type VarLevel = (typeof VAR_LEVELS)[number];

export interface AlignedMatrix {
  /** Symbols, in column order. */
  readonly symbols: readonly string[];
  /** Timestamps of each row, ascending. One shorter than the closes joined. */
  readonly times: readonly number[];
  /** `rows[i][j]` is symbol j's log return over row i. */
  readonly rows: readonly (readonly number[])[];
}

/**
 * Join N series on the timestamps they ALL share, then difference.
 *
 * Differencing after the join rather than before is the whole point: a gap in
 * one symbol would otherwise manufacture a return spanning it in every other
 * symbol, and those fabricated returns land in exactly the volatile stretches
 * where a feed drops bars — so the error concentrates in the tail the risk
 * figures are read from.
 *
 * The intersection is used rather than a union with fill-forward. Carrying a
 * stale price forward invents a zero return, and a book full of invented zeros
 * looks calmer than it is.
 */
export function alignSeries(series: readonly ClosesSeries[]): AlignedMatrix {
  if (series.length === 0) return { symbols: [], times: [], rows: [] };

  const maps = series.map((s) => {
    const m = new Map<number, number>();
    for (const p of s.closes) {
      if (Number.isFinite(p.t) && Number.isFinite(p.c) && p.c > 0) m.set(p.t, p.c);
    }
    return m;
  });

  const first = maps[0];
  if (!first) return { symbols: [], times: [], rows: [] };

  const shared: number[] = [];
  for (const t of first.keys()) {
    if (maps.every((m) => m.has(t))) shared.push(t);
  }
  shared.sort((a, b) => a - b);

  const times: number[] = [];
  const rows: number[][] = [];
  for (let i = 1; i < shared.length; i++) {
    const t0 = shared[i - 1] as number;
    const t1 = shared[i] as number;
    const row = maps.map((m) => Math.log((m.get(t1) as number) / (m.get(t0) as number)));
    if (row.some((r) => !Number.isFinite(r))) continue;
    times.push(t1);
    rows.push(row);
  }

  return { symbols: series.map((s) => s.symbol), times, rows };
}

/* ------------------------------------------------------------ book P&L --- */

export interface Exposure {
  readonly symbol: string;
  /** Signed money at risk to a 1% move: negative for a short. */
  readonly signedNotional: number;
}

/**
 * Signed notional per symbol, netting a symbol held on both sides.
 *
 * Netting matters and is not a nicety: a long and a short of equal size in the
 * same instrument have no market exposure, and a risk report that showed two
 * separate risky lines there would send someone hedging a position that is
 * already flat.
 */
export function exposures(positions: readonly Position[]): Exposure[] {
  const net = new Map<string, number>();
  for (const p of positions) {
    const mult = Number.isFinite(p.contractSize) && (p.contractSize ?? 0) > 0 ? (p.contractSize as number) : 1;
    const notional = p.qty * p.entry * mult;
    if (!Number.isFinite(notional)) continue;
    const signed = p.direction === "long" ? notional : -notional;
    net.set(p.symbol, (net.get(p.symbol) ?? 0) + signed);
  }
  return [...net.entries()].map(([symbol, signedNotional]) => ({ symbol, signedNotional }));
}

/**
 * Replay the book over its own history: what would it have made or lost each
 * bar, at TODAY's position sizes?
 *
 * This is the standard historical-simulation construction. It deliberately
 * holds the sizes fixed and varies only the returns: the question is "what does
 * the book I hold now do in the market I have seen", not "what did I make",
 * which is history and is answered by the trade log instead.
 */
export function bookPnl(matrix: AlignedMatrix, exp: readonly Exposure[]): number[] {
  const weight = matrix.symbols.map((s) => exp.find((e) => e.symbol === s)?.signedNotional ?? 0);
  return matrix.rows.map((row) => {
    let sum = 0;
    for (let j = 0; j < row.length; j++) sum += (row[j] as number) * (weight[j] as number);
    return sum;
  });
}

/** Per-symbol P&L for the same rows, used by the contribution decomposition. */
export function symbolPnl(matrix: AlignedMatrix, exp: readonly Exposure[]): number[][] {
  const weight = matrix.symbols.map((s) => exp.find((e) => e.symbol === s)?.signedNotional ?? 0);
  return matrix.rows.map((row) => row.map((r, j) => r * (weight[j] as number)));
}

/* ---------------------------------------------------------------- VaR --- */

export interface TailRisk {
  readonly level: VarLevel;
  /** Loss, as a POSITIVE number, exceeded on (1 − level) of observed bars. */
  readonly var: number;
  /** Average loss on the bars that exceeded it. Always ≥ var. */
  readonly cvar: number;
  /** The single worst observed bar. The tail has no upper bound above this. */
  readonly worst: number;
  /** Observations the figures were computed from. */
  readonly sample: number;
  /** Row indices of the tail, so contributions can condition on the same days. */
  readonly tailRows: readonly number[];
}

/**
 * Historical VaR and expected shortfall.
 *
 * The quantile uses the LOWER of the two straddling observations rather than
 * interpolating. Interpolation invents a loss that never happened and always
 * does so in the optimistic direction; on a 60-bar sample that bias is larger
 * than the precision it buys.
 */
export function tailRisk(pnl: readonly number[], level: VarLevel): TailRisk | null {
  const clean = pnl.filter((x) => Number.isFinite(x));
  if (clean.length < MIN_HISTORY) return null;

  const order = clean.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const tailCount = Math.max(1, Math.floor(clean.length * (1 - level)));

  const tail = order.slice(0, tailCount);
  const cut = order[tailCount - 1];
  if (!cut) return null;

  const meanTail = tail.reduce((s, x) => s + x.v, 0) / tail.length;
  const worstEntry = order[0];

  return {
    level,
    /* Reported as a positive loss. A "VaR of −4,200" reads as a gain to half
       the people who see it, and the sign convention is not worth the risk. */
    var: Math.max(0, -cut.v),
    cvar: Math.max(0, -meanTail),
    worst: Math.max(0, -(worstEntry?.v ?? 0)),
    sample: clean.length,
    tailRows: tail.map((x) => x.i),
  };
}

export interface Contribution {
  readonly symbol: string;
  /** Money this symbol lost, on average, across the portfolio's worst bars. */
  readonly cvarShare: number;
  /** Its share of the total, 0..1. Negative when the symbol HEDGED the book. */
  readonly fraction: number;
  readonly signedNotional: number;
}

/**
 * Who is actually carrying the risk.
 *
 * Component expected shortfall: average each symbol's P&L over the SAME bars
 * that made the portfolio's tail. Because expectation is linear, these sum
 * exactly to the portfolio CVaR — no residual, no plug, no "other" row.
 *
 * A NEGATIVE contribution is real and is the most valuable output here: it
 * marks a position that made money on the days the book was bleeding. That is
 * a hedge, and it is invisible to any risk measure that sums absolute
 * exposures — which is every risk measure a retail platform ships.
 */
export function contributions(
  matrix: AlignedMatrix,
  exp: readonly Exposure[],
  tail: TailRisk,
): Contribution[] {
  const per = symbolPnl(matrix, exp);
  const rows = tail.tailRows;
  if (rows.length === 0) return [];

  const out: Contribution[] = matrix.symbols.map((symbol, j) => {
    let sum = 0;
    for (const i of rows) sum += (per[i]?.[j] as number) ?? 0;
    const mean = sum / rows.length;
    return {
      symbol,
      cvarShare: -mean,
      fraction: tail.cvar > 0 ? -mean / tail.cvar : 0,
      signedNotional: exp.find((e) => e.symbol === symbol)?.signedNotional ?? 0,
    };
  });

  return out.sort((a, b) => b.cvarShare - a.cvarShare);
}

/**
 * How concentrated the risk is — NOT how many independent bets there are.
 *
 * The inverse Herfindahl index of the risk contributions. It answers "is one
 * name carrying this book?", and it is worth having for exactly that.
 *
 * IT IS NOT A DIVERSIFICATION MEASURE, and an earlier draft of this file
 * claimed it was. A test settled the argument: four positions in four
 * IDENTICAL series score 4 here, because each one contributes a quarter of
 * every bad day. Concentration of contribution and independence of bets are
 * different properties, and only the second survives a sector turning. That
 * one is `diversification` below.
 *
 * Hedges are excluded from the index rather than counted as negative weight — a
 * negative square would inflate the count and make a hedged book look less
 * concentrated than an unhedged one, which is backwards.
 */
export function effectiveContributors(contribs: readonly Contribution[]): number {
  const positive = contribs.filter((c) => c.cvarShare > 0);
  const total = positive.reduce((s, c) => s + c.cvarShare, 0);
  if (total <= 0 || positive.length === 0) return 0;
  let hhi = 0;
  for (const c of positive) {
    const w = c.cvarShare / total;
    hhi += w * w;
  }
  return hhi > 0 ? 1 / hhi : 0;
}

/**
 * Standard deviation of a series. Population form: these are observations of
 * what happened, not a sample drawn from a wider population of bars.
 */
function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / xs.length);
}

export interface Diversification {
  /**
   * Choueifaty diversification ratio: the volatility the positions WOULD have
   * had if they never moved together, over the volatility they actually had.
   * 1.0 means they are one bet. √n means they are n independent ones.
   */
  readonly ratio: number;
  /** ratio², the count that reads naturally: "these 6 act like 2.1 bets". */
  readonly effectiveBets: number;
  /**
   * Held positions that were actually in the matrix.
   *
   * Reported because `effectiveBets` is meaningless without it: a book of six
   * where five had no stored bars is a measurement of ONE, and quoting the
   * ratio against the position count would turn a data gap into a finding.
   */
  readonly measured: number;
  /** Book volatility per bar, in currency. */
  readonly sigma: number;
  /** Sum of each leg volatility taken alone, in currency. */
  readonly sumStandalone: number;
  readonly note: string;
}

/**
 * How many independent bets the book is really making.
 *
 * This is the number the position count pretends to be. Sum each leg volatility
 * as though it stood alone, divide by the volatility the book actually
 * exhibited, and square it: four positions in four identical instruments give
 * 1.0, four in genuinely unrelated ones give 4.0, and everything real sits in
 * between.
 *
 * It is measured from the SAME aligned history as everything else, so it costs
 * nothing extra and cannot disagree with the VaR beside it.
 *
 * The one number to distrust here is a very large one. A book whose legs almost
 * cancel has a tiny denominator, and the ratio explodes — that is arithmetically
 * correct and practically a warning, because a near-perfect hedge measured on
 * past bars is the thing most likely to come apart on the day you need it. The
 * note says so rather than the caller having to know.
 *
 * IT COUNTS ONLY THE LEGS IT COULD MEASURE, and that correction came from
 * running it: a two-position book where one symbol had no stored bars reported
 * "2 positions moving as roughly one". That reads as a finding about
 * correlation and was nothing of the sort — the second position had not been
 * looked at. One leg cannot be correlated with anything, so the honest output
 * is a count of one and a note saying which legs it is about.
 */
export function diversification(matrix: AlignedMatrix, exp: readonly Exposure[]): Diversification {
  const per = symbolPnl(matrix, exp);
  const cols = matrix.symbols.length;

  /* Legs that are BOTH held and present in the matrix. A symbol in the matrix
     with no position (the factor, usually) contributes nothing and must not be
     counted as a bet; a held symbol absent from the matrix was never measured
     and must not be counted either. */
  const measured = matrix.symbols.filter(
    (sym) => (exp.find((e) => e.symbol === sym)?.signedNotional ?? 0) !== 0,
  ).length;

  let sumStandalone = 0;
  for (let j = 0; j < cols; j++) {
    sumStandalone += stdev(per.map((row) => (row[j] as number) ?? 0));
  }
  const sigma = stdev(bookPnl(matrix, exp));

  if (sumStandalone === 0) {
    return { ratio: 0, effectiveBets: 0, measured, sigma, sumStandalone, note: "Nothing in the book moved over the shared history." };
  }
  if (sigma === 0) {
    return {
      ratio: Infinity,
      effectiveBets: Infinity,
      measured,
      sigma,
      sumStandalone,
      note: "The legs cancelled exactly over this history. Treat that as a measurement artefact, not a hedge you can rely on.",
    };
  }

  const ratio = sumStandalone / sigma;
  const bets = ratio * ratio;
  return {
    ratio,
    effectiveBets: bets,
    measured,
    sigma,
    sumStandalone,
    note:
      measured < 2
        ? measured === 1
          ? "Only one position had stored history, so there is nothing here to be correlated with."
          : "No position in the book had stored history."
        : bets > measured * 1.5
          ? "The legs largely offset each other over this history. That is worth knowing and worth doubting: offsetting relationships are the first thing to break in a liquidation."
          : bets < 1.5
            ? `${measured} measured positions, moving as roughly one. The position count is not diversification here.`
            : "",
  };
}

/* -------------------------------------------------------------- factor --- */

export interface FactorExposure {
  readonly symbol: string;
  /** OLS slope against the factor. */
  readonly beta: number;
  /** 0..1. How much of this symbol's variance the factor explained. */
  readonly r2: number;
  /** Annualisation-free: the residual standard deviation, per bar. */
  readonly idioVol: number;
  readonly sample: number;
  /**
   * Set when the beta should not be acted on. It is a sentence, not a flag,
   * because the reason differs and the reason is what the reader needs.
   */
  readonly caveat: string | null;
}

/** Below this R², a beta describes almost none of what the asset did. */
export const WEAK_FIT = 0.2;

/**
 * Regress each symbol on a factor series, by simple OLS through the means.
 *
 * The factor is whatever column of the same matrix you nominate — for crypto
 * that is normally BTC, which is not a "market factor" in any academic sense
 * but IS the thing that moves everything else, and naming it honestly beats
 * dressing it up as one.
 */
export function factorExposures(matrix: AlignedMatrix, factorSymbol: string): FactorExposure[] {
  const fj = matrix.symbols.indexOf(factorSymbol);
  if (fj < 0) return [];
  const n = matrix.rows.length;

  const f = matrix.rows.map((r) => (r[fj] as number) ?? 0);
  const mf = f.reduce((s, x) => s + x, 0) / (n || 1);

  return matrix.symbols.map((symbol, j) => {
    const y = matrix.rows.map((r) => (r[j] as number) ?? 0);
    const my = y.reduce((s, x) => s + x, 0) / (n || 1);

    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = (f[i] as number) - mf;
      const dy = (y[i] as number) - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }

    if (n < MIN_HISTORY || sxx === 0) {
      return {
        symbol,
        beta: NaN,
        r2: NaN,
        idioVol: NaN,
        sample: n,
        caveat:
          sxx === 0
            ? `${factorSymbol} did not move over the shared history, so there is nothing to regress against.`
            : `Only ${n} shared bars — ${MIN_HISTORY} are needed before a beta means anything.`,
      };
    }

    const beta = sxy / sxx;
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

    /* Residual variance uses n − 2 because two parameters (slope and intercept)
       were fitted. On 60 bars that is a 3% difference — small, but the version
       that divides by n is simply the wrong estimator. */
    let ssr = 0;
    for (let i = 0; i < n; i++) {
      const pred = my + beta * ((f[i] as number) - mf);
      const e = (y[i] as number) - pred;
      ssr += e * e;
    }
    const idioVol = n > 2 ? Math.sqrt(ssr / (n - 2)) : NaN;

    return {
      symbol,
      beta,
      r2,
      idioVol,
      sample: n,
      caveat:
        symbol === factorSymbol
          ? null
          : r2 < WEAK_FIT
            ? `${factorSymbol} explains only ${(r2 * 100).toFixed(0)}% of ${symbol}. The beta is real arithmetic on a relationship that is barely there — do not hedge on it.`
            : null,
    };
  });
}

/* -------------------------------------------------------------- stress --- */

export interface Scenario {
  readonly id: string;
  readonly label: string;
  /** The factor's move, as a fraction. −0.35 is a 35% fall. */
  readonly factorMove: number;
  /** What actually happened, so the number on screen has a provenance. */
  readonly note: string;
}

/**
 * Named historical shocks, as FACTOR MOVES rather than as per-asset moves.
 *
 * Every figure below is the peak-to-trough move in BTC over the window named,
 * and each is stated so it can be checked. They are used as inputs to a
 * measured beta, never as a claim about what any other asset did — most of
 * these assets did not exist for some of these events, and pretending otherwise
 * is the single most common lie in stress-testing tools.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: "covid",
    label: "COVID liquidation",
    factorMove: -0.5,
    note: "12–13 March 2020. Roughly a halving in two days as leverage unwound across every venue at once.",
  },
  {
    id: "luna",
    label: "Terra/LUNA collapse",
    factorMove: -0.3,
    note: "9–12 May 2022. A stablecoin failure that drained liquidity from everything quoted against it.",
  },
  {
    id: "ftx",
    label: "FTX insolvency",
    factorMove: -0.25,
    note: "8–9 November 2022. A venue failure, so the shock arrived with withdrawals halted.",
  },
  {
    id: "carry",
    label: "Yen carry unwind",
    factorMove: -0.2,
    note: "5 August 2024. A macro deleveraging that hit crypto as a liquidity asset, not as crypto.",
  },
  {
    id: "squeeze",
    label: "Upside squeeze",
    factorMove: 0.25,
    note: "Included because a short book fails upward, and a stress panel that only tests down is only testing half the book.",
  },
];

export interface StressResult {
  readonly scenario: Scenario;
  /** Estimated book P&L. Negative is a loss. */
  readonly pnl: number;
  /** As a percent of the equity supplied. */
  readonly pctOfEquity: number;
  /** Symbols whose beta was too weak to trust, so their term is a guess. */
  readonly unreliable: readonly string[];
}

/**
 * Propagate a factor move through each symbol's measured beta.
 *
 * This is a FIRST-ORDER estimate and the limits are worth stating plainly:
 * betas measured in calm markets understate what happens in a crash, because
 * correlations converge to one exactly when it matters. So these numbers are
 * optimistic. They are still worth having — an optimistic estimate of a 50%
 * shock is a great deal more informative than no estimate — but nothing here
 * should be read as a floor.
 */
export function stress(
  scenario: Scenario,
  exp: readonly Exposure[],
  betas: readonly FactorExposure[],
  equity: number,
): StressResult {
  let pnl = 0;
  const unreliable: string[] = [];

  for (const e of exp) {
    const fit = betas.find((b) => b.symbol === e.symbol);
    if (!fit || !Number.isFinite(fit.beta)) {
      unreliable.push(e.symbol);
      continue;
    }
    if (Number.isFinite(fit.r2) && fit.r2 < WEAK_FIT && fit.caveat !== null) unreliable.push(e.symbol);
    pnl += e.signedNotional * fit.beta * scenario.factorMove;
  }

  return {
    scenario,
    pnl,
    pctOfEquity: equity > 0 ? (pnl / equity) * 100 : NaN,
    unreliable,
  };
}

/* ----------------------------------------------------------- liquidity --- */

export interface LiquidityRead {
  readonly symbol: string;
  readonly notional: number;
  /** Average daily traded value, same currency. */
  readonly adv: number;
  /** Days to exit at the participation rate, or Infinity when ADV is unknown. */
  readonly days: number;
  readonly note: string;
}

/**
 * The share of a venue's daily volume you can take before you are the market.
 *
 * 20% is the conventional institutional cap and it is already aggressive for a
 * single name. It is exposed as an argument because the honest answer is that
 * it depends on the venue and the hour.
 */
export const PARTICIPATION = 0.2;

export function liquidity(
  exp: readonly Exposure[],
  advBySymbol: ReadonlyMap<string, number>,
  participation = PARTICIPATION,
): LiquidityRead[] {
  return exp.map((e) => {
    const notional = Math.abs(e.signedNotional);
    const adv = advBySymbol.get(e.symbol) ?? NaN;
    if (!Number.isFinite(adv) || adv <= 0) {
      return {
        symbol: e.symbol,
        notional,
        adv: NaN,
        days: Infinity,
        note: "No volume history stored for this symbol, so time-to-exit is unknown rather than fast.",
      };
    }
    const days = notional / (adv * participation);
    return {
      symbol: e.symbol,
      notional,
      adv,
      days,
      note:
        days > 1
          ? `Exiting at ${(participation * 100).toFixed(0)}% of normal volume takes about ${days.toFixed(1)} days — and volume falls in the drawdowns that would make you want out.`
          : `Under a day at ${(participation * 100).toFixed(0)}% participation.`,
    };
  });
}

/* ------------------------------------------------------------- report --- */

export interface PortfolioRisk {
  readonly ok: boolean;
  /** Set when nothing could be computed. Always says WHY, never just "no data". */
  readonly blocked: string | null;
  readonly sample: number;
  readonly exposures: readonly Exposure[];
  readonly gross: number;
  readonly net: number;
  readonly tails: readonly TailRisk[];
  readonly contributions: readonly Contribution[];
  /** Concentration of contribution. High is not the same as diversified. */
  readonly effectiveContributors: number;
  /** Independence of bets, measured from covariance. THIS is diversification. */
  readonly diversification: Diversification;
  /** Held symbols with no stored history. Excluded from every figure above. */
  readonly missing: readonly string[];
  readonly factor: string;
  readonly betas: readonly FactorExposure[];
  readonly stress: readonly StressResult[];
  readonly liquidity: readonly LiquidityRead[];
  readonly warnings: readonly string[];
}

export interface PortfolioInput {
  readonly positions: readonly Position[];
  readonly equity: number;
  /** One per symbol held, plus the factor. Closes on a common bar grid. */
  readonly series: readonly ClosesSeries[];
  readonly factorSymbol: string;
  readonly advBySymbol?: ReadonlyMap<string, number>;
}

export function analysePortfolio(input: PortfolioInput): PortfolioRisk {
  const exp = exposures(input.positions);
  const gross = exp.reduce((s, e) => s + Math.abs(e.signedNotional), 0);
  const net = exp.reduce((s, e) => s + e.signedNotional, 0);

  const empty = (blocked: string): PortfolioRisk => ({
    ok: false,
    blocked,
    sample: 0,
    exposures: exp,
    gross,
    net,
    tails: [],
    contributions: [],
    effectiveContributors: 0,
    diversification: { ratio: 0, effectiveBets: 0, measured: 0, sigma: 0, sumStandalone: 0, note: "" },
    missing: [],
    factor: input.factorSymbol,
    betas: [],
    stress: [],
    liquidity: [],
    warnings: [],
  });

  if (exp.length === 0) return empty("No open positions, so there is no book to analyse.");

  /* Only the symbols actually held, plus the factor. Feeding in extra series
     would shrink the shared-timestamp intersection for no benefit, and the
     intersection is the scarce resource here. */
  const held = new Set(exp.map((e) => e.symbol));
  const wanted = input.series.filter((s) => held.has(s.symbol) || s.symbol === input.factorSymbol);

  const missing = [...held].filter((sym) => !wanted.some((s) => s.symbol === sym));
  if (missing.length === exp.length) {
    return empty(
      `No stored history for ${missing.join(", ")}. Open each on the chart once and the bars are archived locally — nothing here is estimated from a symbol that has never been fetched.`,
    );
  }

  const matrix = alignSeries(wanted);
  if (matrix.rows.length < MIN_HISTORY) {
    return empty(
      `Only ${matrix.rows.length} bars are shared by every symbol in the book; ${MIN_HISTORY} are needed. The overlap is the binding constraint, not the longest series — one recently-added symbol shortens every figure here.`,
    );
  }

  const pnl = bookPnl(matrix, exp);
  const tails = VAR_LEVELS.map((l) => tailRisk(pnl, l)).filter((t): t is TailRisk => t !== null);
  const primary = tails[0];
  const contribs = primary ? contributions(matrix, exp, primary) : [];
  const betas = factorExposures(matrix, input.factorSymbol);
  const stressed = SCENARIOS.map((s) => stress(s, exp, betas, input.equity));
  const liq = liquidity(exp, input.advBySymbol ?? new Map());

  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(
      `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no stored bars and ${missing.length === 1 ? "is" : "are"} EXCLUDED from every figure below. The book is riskier than what is shown, by exactly that much.`,
    );
  }

  const concentration = effectiveContributors(contribs);
  const div = diversification(matrix, exp);
  /* Against `measured`, never against the position count. The version that
     compared with `exp.length` announced "2 positions behaving like 1.0
     independent ones" on a book where the second symbol had simply never been
     fetched — a data gap dressed up as a correlation finding. */
  if (Number.isFinite(div.effectiveBets) && div.measured >= 2 && div.effectiveBets < div.measured * 0.6) {
    warnings.push(
      `${div.measured} positions behaving like ${div.effectiveBets.toFixed(1)} independent ones. They move together, so the position count is not the diversification it looks like.`,
    );
  }
  const topContributor = contribs[0];
  if (topContributor && concentration > 0 && concentration < 1.5 && exp.length > 2) {
    warnings.push(
      `${topContributor.symbol} accounts for most of the loss on the book's worst days. Whatever the other positions are doing, this is the one that decides the outcome.`,
    );
  }

  const hedges = contribs.filter((c) => c.cvarShare < 0);
  if (hedges.length > 0) {
    warnings.push(
      `${hedges.map((h) => h.symbol).join(", ")} made money on the days the book lost most. That is a hedge, and cutting it to "reduce exposure" would raise the risk here, not lower it.`,
    );
  }

  if (primary && input.equity > 0 && primary.cvar / input.equity > 0.1) {
    warnings.push(
      `On its worst 5% of bars the book has averaged ${((primary.cvar / input.equity) * 100).toFixed(1)}% of equity. That is the AVERAGE bad day, not the worst one — the worst observed was ${((primary.worst / input.equity) * 100).toFixed(1)}%.`,
    );
  }

  return {
    ok: true,
    blocked: null,
    sample: matrix.rows.length,
    exposures: exp,
    gross,
    net,
    tails,
    contributions: contribs,
    effectiveContributors: concentration,
    diversification: div,
    missing,
    factor: input.factorSymbol,
    betas,
    stress: stressed,
    liquidity: liq,
    warnings,
  };
}
