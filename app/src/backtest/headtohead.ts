/**
 * TWO RULE SETS ON THE SAME BARS — and whether the difference is real.
 *
 * Putting two rules side by side is the most natural thing a backtest panel can
 * offer and the easiest place to mislead, because the eye picks the bigger
 * number and the bigger number is usually noise. A rule at 0.12R beside one at
 * 0.09R over forty trades each looks like a winner and is a coin landing the
 * same way twice.
 *
 * THE COMPARISON IS THE DIFFERENCE AND ITS STANDARD ERROR, NOT TWO FIGURES.
 *
 * Expectancy in R is a MEAN over trades, so the difference between two means has
 * a standard error that both sample sizes and both spreads feed into:
 *
 *     SE = sqrt( sd_a^2 / n_a  +  sd_b^2 / n_b )
 *
 * If the gap is smaller than about two of those, the data cannot tell them
 * apart, and saying so is the entire value of the feature. This project already
 * records the same discipline in `deflatedSharpe` — a search must be charged for
 * on the screen that shows its winner — and picking the better of two rules on
 * the window you are looking at IS a search over two arms.
 *
 * WHY IT DOES NOT TEST THE MEANS AGAINST ZERO
 *
 * "A beats zero and B does not" is a different and weaker claim than "A beats
 * B", and reporting the first as the second is how two mediocre rules become a
 * ranking. The verdict here is only ever about the PAIR.
 *
 * THE UNITS ARE PER-TRADE THROUGHOUT. `metrics.sharpe` is annualised and mixing
 * the two turned an in-sample 4.93 into a fiction once already, which is why the
 * inputs here are trade lists rather than a Metrics object: there is nothing to
 * convert and therefore nothing to convert wrongly.
 */

import type { Trade } from "./engine";

/** Trades each side needs before a comparison is attempted. */
export const MIN_PER_RULE = 30;

/** How many standard errors the gap must clear to be called a difference. */
export const SE_THRESHOLD = 2;

export interface Side {
  readonly label: string;
  readonly trades: number;
  /** Mean R per trade. NaN when it could not be computed. */
  readonly expectancyR: number;
  readonly winRate: number;
}

export type H2HVerdict = "a" | "b" | "tie" | "thin";

export interface HeadToHead {
  readonly a: Side;
  readonly b: Side;
  /** a.expectancyR − b.expectancyR. NaN when either side could not answer. */
  readonly difference: number;
  /** Standard error of that difference. NaN when it could not be computed. */
  readonly standardError: number;
  /** How many standard errors the gap is. NaN when unavailable. */
  readonly sigmas: number;
  readonly verdict: H2HVerdict;
  /** Addressed to the operator. Never empty. */
  readonly why: string;
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation. NaN below two points, where spread is undefined. */
const sd = (xs: readonly number[]): number => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
};

const side = (label: string, trades: readonly Trade[]): Side => {
  const rs = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  return {
    label,
    trades: trades.length,
    expectancyR: rs.length > 0 ? mean(rs) : NaN,
    winRate: trades.length > 0 ? trades.filter((t) => t.rMultiple > 0).length / trades.length : NaN,
  };
};

export function compareRules(
  aLabel: string,
  aTrades: readonly Trade[],
  bLabel: string,
  bTrades: readonly Trade[],
): HeadToHead {
  const a = side(aLabel, aTrades);
  const b = side(bLabel, bTrades);

  const thin = (): HeadToHead => {
    const which =
      a.trades < MIN_PER_RULE && b.trades < MIN_PER_RULE
        ? `${a.label} has ${a.trades} trades and ${b.label} has ${b.trades}`
        : a.trades < MIN_PER_RULE
          ? `${a.label} has only ${a.trades} trades`
          : `${b.label} has only ${b.trades} trades`;
    return {
      a,
      b,
      difference: NaN,
      standardError: NaN,
      sigmas: NaN,
      verdict: "thin",
      why:
        `Not enough to compare: ${which}, and ${MIN_PER_RULE} each is the floor. ` +
        "Two expectancies over a handful of trades differ by chance alone.",
    };
  };

  if (a.trades < MIN_PER_RULE || b.trades < MIN_PER_RULE) return thin();

  const ra = aTrades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  const rb = bTrades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  const sa = sd(ra);
  const sb = sd(rb);
  if (!Number.isFinite(sa) || !Number.isFinite(sb) || !Number.isFinite(a.expectancyR) || !Number.isFinite(b.expectancyR)) {
    return thin();
  }

  const se = Math.sqrt((sa * sa) / ra.length + (sb * sb) / rb.length);
  const difference = a.expectancyR - b.expectancyR;

  /*
   * A STANDARD ERROR THIS SMALL IS FLOATING-POINT DUST, NOT A MEASUREMENT.
   *
   * `se > 0` was the first guard and it is wrong, which a test caught: 0.1 is
   * not exactly representable in binary floating point, so FORTY IDENTICAL
   * TRADES have a standard deviation of 4.2e-17 rather than zero. The guard
   * passed, and the comparison reported **6e16 standard errors** — it would have
   * printed "ahead by 0.400R (59999937404835248.0 standard errors)" with total
   * confidence, for a difference nobody measured.
   *
   * An absolute epsilon would be wrong too: R multiples are order 1 here and
   * could be order 0.001 elsewhere. The test is RELATIVE to the size of the
   * thing being measured, which is the only form that survives a change of
   * units. INFINITY IS A BUG; NaN IS A REFUSAL, and so is 6e16.
   */
  const scale = Math.max(Math.abs(a.expectancyR), Math.abs(b.expectancyR), Math.abs(difference));
  const measurable = se > Math.max(scale, 1) * 1e-9;
  const sigmas = measurable ? Math.abs(difference) / se : NaN;

  if (!Number.isFinite(sigmas)) {
    return {
      a,
      b,
      difference,
      standardError: se,
      sigmas: NaN,
      verdict: "tie",
      why:
        "The two runs have no measurable spread between their trades, so the gap " +
        "cannot be told from noise. That normally means fixture data rather than a market.",
    };
  }

  if (sigmas < SE_THRESHOLD) {
    return {
      a,
      b,
      difference,
      standardError: se,
      sigmas,
      verdict: "tie",
      why:
        `Too close to call: ${a.label} ${a.expectancyR.toFixed(3)}R against ${b.label} ` +
        `${b.expectancyR.toFixed(3)}R is a gap of ${Math.abs(difference).toFixed(3)}R, which is ` +
        `${sigmas.toFixed(1)} standard errors. Under ${SE_THRESHOLD} the data cannot separate ` +
        "them, and choosing the higher one is choosing noise.",
    };
  }

  const winner = difference > 0 ? a : b;
  const loser = difference > 0 ? b : a;
  return {
    a,
    b,
    difference,
    standardError: se,
    sigmas,
    verdict: difference > 0 ? "a" : "b",
    why:
      `${winner.label} is ahead by ${Math.abs(difference).toFixed(3)}R per trade ` +
      `(${sigmas.toFixed(1)} standard errors) over ${loser.label}. That is a real gap ON THIS ` +
      "window — it is not a claim that it holds on the next one, and this window is the one " +
      "the comparison was made on.",
  };
}
