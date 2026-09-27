/**
 * DOES IT WORK ANYWHERE ELSE? — one rule set across several markets.
 *
 * A CONTROL THAT TAKES ONE OF SOMETHING PER PRESS IS A FORM, NOT A TOOL. The
 * Playbook tested one rule on one market, and one market cannot tell you whether
 * an edge is real or a property of that market's last few years. Running the
 * same rule across everything the archive holds is the cheapest answer, and it
 * is a different question from the held-back window: that one asks "did it still
 * work recently", this one asks "is it about the market or about THIS market".
 *
 * THIS IS A GENERALISATION CHECK, NOT A MARKET PICKER — AND THE DIFFERENCE IS
 * THE WHOLE DESIGN.
 *
 * The obvious build sorts the markets by expectancy and puts the winner at the
 * top. That turns six honest measurements into a SEARCH: the best of six is the
 * best of six whatever the rule is, and this project already records what that
 * costs — a sorted table always has a big number at the top, "including on data
 * with no edge in it", and a search must be charged for on the screen that shows
 * its winner.
 *
 * So nothing here ranks. It COUNTS: how many markets it worked on, how many it
 * lost on, how many could not answer, and it names each group. A rule that made
 * money on five of six is a finding. A rule that made money on one of six is a
 * finding about that one market, and `one-market` says so in the word this
 * project already uses for it.
 *
 * A MARKET THAT COULD NOT ANSWER IS NOT A MARKET THAT SAID NO.
 *
 * "Anything that tolerates a partial failure has to name what it lost everywhere
 * it reports a total." A series with no history, or with too few trades to mean
 * anything, is counted apart and listed by name — folding it into the failures
 * would make a rule look worse than the evidence says, and dropping it silently
 * would make the denominator a lie.
 */

/** One market's answer. `refused` covers both "no data" and "too few trades". */
export interface MarketRun {
  readonly symbol: string;
  readonly timeframe: string;
  readonly trades: number;
  /** Mean R per trade. NaN when it could not be computed. */
  readonly expectancyR: number;
  readonly winRate: number;
  readonly refused: boolean;
  /** Why this market could not answer. Empty when it did. */
  readonly why: string;
}

export type AcrossVerdict = "consistent" | "mixed" | "one-market" | "thin" | "none";

export interface AcrossSummary {
  readonly tried: number;
  /** Markets that produced a usable answer. */
  readonly answered: number;
  readonly positive: number;
  readonly negative: number;
  /** Named, never just counted. */
  readonly worked: readonly string[];
  readonly failed: readonly string[];
  readonly couldNot: readonly string[];
  readonly verdict: AcrossVerdict;
  /** Addressed to the operator. Never empty. */
  readonly why: string;
  /** Mean expectancy across the markets that ANSWERED. NaN when none did. */
  readonly meanExpectancyR: number;
}

/**
 * Trades a market needs before its answer is counted.
 *
 * Thirty, the same floor `holdout.ts` and `excursion.ts` use. A market with four
 * trades has an expectancy, and reporting it beside one with four hundred would
 * let noise vote.
 */
export const MIN_TRADES_PER_MARKET = 30;

const list = (xs: readonly string[], max = 4): string =>
  xs.length <= max
    ? xs.join(", ")
    : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;

export function summariseAcross(runs: readonly MarketRun[]): AcrossSummary {
  const tried = runs.length;

  const couldNotRuns = runs.filter(
    (r) => r.refused || r.trades < MIN_TRADES_PER_MARKET || !Number.isFinite(r.expectancyR),
  );
  const answeredRuns = runs.filter((r) => !couldNotRuns.includes(r));

  const workedRuns = answeredRuns.filter((r) => r.expectancyR > 0);
  const failedRuns = answeredRuns.filter((r) => r.expectancyR <= 0);

  const worked = workedRuns.map((r) => r.symbol);
  const failed = failedRuns.map((r) => r.symbol);
  const couldNot = couldNotRuns.map((r) => r.symbol);

  const answered = answeredRuns.length;
  const meanExpectancyR =
    answered > 0 ? answeredRuns.reduce((a, r) => a + r.expectancyR, 0) / answered : NaN;

  const base = {
    tried,
    answered,
    positive: worked.length,
    negative: failed.length,
    worked,
    failed,
    couldNot,
    meanExpectancyR,
  };

  if (tried === 0) {
    return { ...base, verdict: "none", why: "No markets were selected." };
  }
  if (answered === 0) {
    return {
      ...base,
      verdict: "thin",
      why:
        `None of the ${tried} markets could answer — each had no history or fewer than ` +
        `${MIN_TRADES_PER_MARKET} trades. ${couldNot.length > 0 ? `Skipped: ${list(couldNot)}.` : ""}`,
    };
  }
  if (answered === 1) {
    /* ONE ANSWER IS NOT A COMPARISON. Saying "it worked on 1 of 1" would be a
       percentage over a sample of one, which is the shape of a measurement and
       is not one. */
    return {
      ...base,
      verdict: "one-market",
      why:
        `Only ${answeredRuns[0]?.symbol} could answer, so this says nothing about whether the ` +
        `rule generalises. ${couldNot.length > 0 ? `The other ${couldNot.length} had no history or too few trades: ${list(couldNot)}.` : ""}`,
    };
  }

  const share = worked.length / answered;
  const skipped =
    couldNot.length > 0
      ? ` ${couldNot.length} could not answer and are not counted either way: ${list(couldNot)}.`
      : "";

  if (worked.length === answered) {
    return {
      ...base,
      verdict: "consistent",
      why: `Positive on all ${answered} markets that could answer: ${list(worked)}.${skipped}`,
    };
  }
  if (worked.length === 1) {
    return {
      ...base,
      verdict: "one-market",
      why:
        `Positive on ${worked[0]} alone, and negative on the other ${failed.length}: ${list(failed)}. ` +
        `That is a finding about ${worked[0]}, not about the rule.${skipped}`,
    };
  }
  if (worked.length === 0) {
    return {
      ...base,
      verdict: "mixed",
      why: `Negative on all ${answered} markets that could answer: ${list(failed)}.${skipped}`,
    };
  }
  return {
    ...base,
    verdict: share >= 0.5 ? "consistent" : "mixed",
    why:
      `Positive on ${worked.length} of ${answered}: ${list(worked)}. Negative on ` +
      `${list(failed)}.${skipped}`,
  };
}
