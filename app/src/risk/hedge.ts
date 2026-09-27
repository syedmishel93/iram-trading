/**
 * Hedge sizing, and the part hedge calculators leave out.
 *
 * THE ARITHMETIC IS TRIVIAL. THE CAVEAT IS THE PRODUCT.
 * A minimum-variance hedge is one regression: the amount of the hedge
 * instrument that cancels the most variance of the book is
 *
 *     hedgeNotional = −beta × bookNotional
 *
 * Every hedge calculator computes that. What almost none of them show is that
 * the regression's R² is exactly the fraction of variance the hedge can remove,
 * so the risk you are LEFT with is
 *
 *     residual variance = (1 − R²) × original variance
 *
 * A hedge against something with an R² of 0.30 removes thirty per cent of the
 * variance and leaves seventy. Sized by beta alone it looks like a hedge, it is
 * reported as a hedge, and it is mostly still the original position — now with
 * two sets of costs and two things that can gap.
 *
 * So every result here carries `varianceRemoved` beside the size, and a hedge
 * whose fit is too weak to act on is REFUSED rather than sized. The refusal is
 * the useful output: it says "this instrument will not hedge that one", which
 * is a real answer.
 *
 * WHAT THIS IS NOT
 * It is not a hedging recommendation, it does not know your tax or margin
 * treatment, and — like everything else in this terminal — it cannot place the
 * offsetting trade. Beta is measured on the history you have archived, over a
 * window that is stated; it is not a promise about tomorrow, and correlations
 * move most in exactly the conditions that make people want a hedge.
 */

import {
  alignSeries,
  exposures,
  factorExposures,
  MIN_HISTORY,
  WEAK_FIT,
  type AlignedMatrix,
  type Exposure,
} from "./portfolio";
import type { Position } from "./sizing";
import type { ClosesSeries } from "../data/correlation";

/** Below this R² a hedge is refused rather than sized. Same bar as a beta. */
export const MIN_HEDGE_FIT = WEAK_FIT;

export interface HedgeLeg {
  readonly symbol: string;
  /** Signed notional of the position being hedged. */
  readonly notional: number;
  /** OLS slope of this leg against the hedge instrument. */
  readonly beta: number;
  readonly r2: number;
  readonly sample: number;
  /**
   * Signed notional of the hedge instrument that minimises variance.
   *
   * Opposite sign to the exposure it offsets. NaN when the fit is too weak,
   * because a number here would be acted on.
   */
  readonly hedgeNotional: number;
  /** Fraction of this leg's variance the hedge can remove. Equals R². */
  readonly varianceRemoved: number;
  /** Set when this leg should not be hedged with this instrument. */
  readonly refusal: string | null;
}

export interface HedgeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly instrument: string;
  readonly legs: readonly HedgeLeg[];
  /** Net hedge notional across every leg that could be sized. */
  readonly totalHedge: number;
  /** Gross notional of the legs that WERE hedgeable. */
  readonly hedgedNotional: number;
  /** Gross notional the hedge could not address. */
  readonly unhedgedNotional: number;
  /**
   * Variance-weighted share of the book's variance this hedge removes.
   *
   * Weighted by each leg's squared notional, because variance scales with the
   * square of the position — averaging R² across legs unweighted would let a
   * tiny well-fitting leg flatter a large badly-fitting one.
   */
  readonly bookVarianceRemoved: number;
  /** Bars shared by every series involved. */
  readonly sample: number;
  /** Symbols with no stored history, named rather than dropped. */
  readonly missing: readonly string[];
  readonly asOf: number;
}

const EMPTY = (instrument: string, reason: string): HedgeResult => ({
  ok: false,
  reason,
  instrument,
  legs: [],
  totalHedge: 0,
  hedgedNotional: 0,
  unhedgedNotional: 0,
  bookVarianceRemoved: NaN,
  sample: 0,
  missing: [],
  asOf: Date.now(),
});

export interface HedgeInput {
  readonly positions: readonly Position[];
  /** The instrument you would hedge WITH. */
  readonly instrument: string;
  readonly series: readonly ClosesSeries[];
}

/**
 * Size a hedge for each leg of the book against one instrument.
 *
 * The hedge instrument itself is excluded from the legs: hedging a position
 * with itself is a beta of exactly 1 against an R² of exactly 1, which is
 * arithmetically true and is just "close the position".
 */
export function sizeHedge(input: HedgeInput): HedgeResult {
  const instrument = input.instrument.toUpperCase();
  const exp: Exposure[] = exposures(input.positions).filter((e) => e.signedNotional !== 0);
  if (exp.length === 0) return EMPTY(instrument, "No open positions to hedge.");

  const haveSeries = new Set(input.series.map((s) => s.symbol.toUpperCase()));
  if (!haveSeries.has(instrument)) {
    return EMPTY(
      instrument,
      `No stored bars for ${instrument}. Open it on the chart once and it is archived; nothing here is estimated from a symbol that has never been fetched.`,
    );
  }

  const missing = exp.map((e) => e.symbol.toUpperCase()).filter((s) => !haveSeries.has(s));

  const matrix: AlignedMatrix = alignSeries(input.series);
  if (matrix.rows.length < MIN_HISTORY) {
    return EMPTY(
      instrument,
      `Only ${matrix.rows.length} bars are shared by every symbol involved; ${MIN_HISTORY} are needed before a beta means anything.`,
    );
  }

  const fx = factorExposures(matrix, instrument);
  const bySymbol = new Map(fx.map((f) => [f.symbol, f]));

  const legs: HedgeLeg[] = exp
    .filter((e) => e.symbol.toUpperCase() !== instrument)
    .map((e) => {
      const sym = e.symbol.toUpperCase();
      const f = bySymbol.get(sym);
      if (!f) {
        return {
          symbol: sym,
          notional: e.signedNotional,
          beta: NaN,
          r2: NaN,
          sample: 0,
          hedgeNotional: NaN,
          varianceRemoved: NaN,
          refusal: "No stored bars for this symbol, so nothing can be regressed against the hedge.",
        };
      }
      if (f.r2 < MIN_HEDGE_FIT || !Number.isFinite(f.beta)) {
        return {
          symbol: sym,
          notional: e.signedNotional,
          beta: f.beta,
          r2: f.r2,
          sample: f.sample,
          hedgeNotional: NaN,
          varianceRemoved: f.r2,
          /* The refusal is the answer. Sizing this would produce a position
             that looks like a hedge and is mostly a second bet. */
          refusal:
            `${instrument} explains only ${(f.r2 * 100).toFixed(0)}% of what ${sym} does. ` +
            `A hedge on that fit would remove ${(f.r2 * 100).toFixed(0)}% of the risk and add a whole second position.`,
        };
      }
      return {
        symbol: sym,
        notional: e.signedNotional,
        beta: f.beta,
        r2: f.r2,
        sample: f.sample,
        hedgeNotional: -f.beta * e.signedNotional,
        varianceRemoved: f.r2,
        refusal: null,
      };
    });

  const sized = legs.filter((l) => l.refusal === null);
  const totalHedge = sized.reduce((s, l) => s + l.hedgeNotional, 0);
  const hedgedNotional = sized.reduce((s, l) => s + Math.abs(l.notional), 0);
  const unhedgedNotional = legs
    .filter((l) => l.refusal !== null)
    .reduce((s, l) => s + Math.abs(l.notional), 0);

  /* Weighted by squared notional: variance scales with the square of size, so
     an unweighted mean of R² lets a small well-fitting leg speak for a large
     badly-fitting one. Legs that were refused count with their R² — usually
     near zero — rather than being excluded, because they are still in the book. */
  let wsum = 0;
  let acc = 0;
  for (const l of legs) {
    const w = l.notional * l.notional;
    if (!Number.isFinite(w) || w === 0) continue;
    wsum += w;
    acc += w * (Number.isFinite(l.varianceRemoved) ? l.varianceRemoved : 0);
  }

  return {
    ok: true,
    instrument,
    legs,
    totalHedge,
    hedgedNotional,
    unhedgedNotional,
    bookVarianceRemoved: wsum > 0 ? acc / wsum : NaN,
    sample: matrix.rows.length,
    missing,
    asOf: Date.now(),
  };
}

/**
 * Residual risk left after a hedge, as a fraction of the original.
 *
 * `sqrt(1 - R²)`, not `1 - R²`: R² is a share of VARIANCE and risk is quoted in
 * standard deviation. Reporting the variance share as though it were the
 * volatility share is the single most common overstatement of what a hedge
 * achieved — an R² of 0.75 removes 75% of the variance but only 50% of the
 * volatility, and it is volatility that sets the size of a daily move.
 */
export function residualRiskFraction(r2: number): number {
  if (!Number.isFinite(r2)) return NaN;
  const clamped = Math.max(0, Math.min(1, r2));
  return Math.sqrt(1 - clamped);
}
