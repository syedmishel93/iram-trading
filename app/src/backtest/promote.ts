/**
 * The promotion gate — which strategies are allowed on the desk.
 *
 * WHY THIS IS WORTH MORE THAN TWENTY MORE STRATEGIES
 * The lab already computes everything needed to tell a real edge from a lucky
 * one: `walkForward` gives out-of-sample metrics per fold, and `pbo` gives the
 * probability that the in-sample winner underperforms the median out of
 * sample. What has never existed is a RULE that consumes them. So the desk
 * lists every spec equally, sorted by whatever the last run reported, and the
 * best-looking number on the screen is — by construction — the most overfit
 * one.
 *
 * PBO on the shipped set measures 89%. That figure is not a curiosity; it is
 * the statement that picking the top performer is wrong about nine times in
 * ten. Adding specs to a set with PBO that high does not find an edge. It is
 * the mechanism that produces the number, because every additional candidate
 * is another draw in a lottery over the same noise.
 *
 * The gate is the answer to that, and it is deliberately hard to pass.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT CHECKS, AND WHY EACH TEST IS THERE
 *
 *  1. ENOUGH TRADES OUT OF SAMPLE. Under `MIN_OOS_TRADES` nothing that follows
 *     means anything; a 3-trade fold with a 2.4R expectancy is three numbers.
 *  2. POSITIVE OUT-OF-SAMPLE EXPECTANCY. Not in-sample. In-sample expectancy
 *     is what the selection maximised, so requiring it to be positive tests
 *     nothing at all.
 *  3. THE EDGE SURVIVED THE TRANSITION. `degradation` is out-of-sample
 *     expectancy over in-sample; below `MIN_RETENTION` the strategy is mostly
 *     a description of its training slice.
 *  4. IT WORKED IN MORE THAN ONE FOLD. One good fold out of five is a period,
 *     not a strategy. Majority, because a rule that only worked in 2023 will
 *     tell you so here rather than in a live drawdown.
 *  5. PBO BELOW THE CEILING, when a PBO figure is available — the check on the
 *     SELECTION rather than on the strategy.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not rank. A gate that also ordered the survivors would immediately
 * become the thing people optimise against, which is how the 89% happened in
 * the first place. It returns pass or fail with every reason spelled out, and
 * the ordering of what survives is left to the person reading it.
 *
 * And it never promotes on in-sample numbers, at any threshold, for any
 * reason. That is the one rule the whole file is.
 */

import type { Metrics } from "./metrics";
import type { PboResult } from "./validate";
import type { WalkForwardResult } from "./validate";

/** Below this the out-of-sample sample is too small to read. */
export const MIN_OOS_TRADES = 30;

/**
 * Share of in-sample expectancy that must survive out of sample.
 *
 * 0.4 is low ON PURPOSE. Real edges degrade — selection, costs and regime all
 * take a bite — and demanding 0.8 would reject strategies that work. The
 * number is a floor against total collapse, not a standard of excellence.
 */
export const MIN_RETENTION = 0.4;

/** Above this, the selection is not distinguishable from picking at random. */
export const MAX_PBO = 0.5;

export interface PromotionCheck {
  readonly id: string;
  readonly passed: boolean;
  /** Stated in full whether it passed or failed. The reasons are the output. */
  readonly text: string;
}

export interface Promotion {
  readonly promoted: boolean;
  readonly checks: readonly PromotionCheck[];
  /** One line, for a desk row. */
  readonly summary: string;
  /** Out-of-sample metrics, so a caller never has to reach for in-sample ones. */
  readonly outOfSample: Metrics;
}

const pctOf = (v: number): string => `${(v * 100).toFixed(0)}%`;
const r = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

/**
 * Judge one walk-forward result.
 *
 * `pbo` is optional because it is a property of a SET of candidates rather
 * than of one strategy: it answers "was the selection meaningful", which does
 * not arise when nothing was selected. Absent, that check is reported as not
 * applicable rather than silently passed — a check nobody ran is not a check
 * that passed, and folding it into a pass is how a gate becomes decoration.
 */
export function promote(wf: WalkForwardResult, pbo?: PboResult): Promotion {
  const oos = wf.aggregate;
  const checks: PromotionCheck[] = [];

  const enough = oos.trades >= MIN_OOS_TRADES;
  checks.push({
    id: "sample",
    passed: enough,
    text: enough
      ? `${oos.trades} out-of-sample trades — enough to read.`
      : `${oos.trades} out-of-sample trades, under ${MIN_OOS_TRADES}. Nothing below this line means anything yet.`,
  });

  const positive = oos.expectancyR > 0;
  checks.push({
    id: "expectancy",
    passed: positive,
    text: positive
      ? `${r(oos.expectancyR)} expectancy out of sample.`
      : `${r(oos.expectancyR)} expectancy out of sample — it lost money on data it had not seen.`,
  });

  /* Retention is only meaningful when the in-sample edge was positive to
     begin with. A strategy that lost in sample and lost less out of sample has
     a flattering ratio and no edge. */
  const held = Number.isFinite(wf.degradation) && wf.degradation >= MIN_RETENTION && positive;
  checks.push({
    id: "retention",
    passed: held,
    text: Number.isFinite(wf.degradation)
      ? `${pctOf(wf.degradation)} of the in-sample edge survived out of sample${held ? "." : `, under the ${pctOf(MIN_RETENTION)} floor — most of it was a description of the training slice.`}`
      : "No usable in-sample edge to degrade from.",
  });

  const good = wf.folds.filter((f) => f.outOfSample.expectancyR > 0).length;
  const majority = wf.folds.length > 0 && good * 2 > wf.folds.length;
  checks.push({
    id: "folds",
    passed: majority,
    text: `${good} of ${wf.folds.length} folds were profitable out of sample${majority ? "." : " — one good period is not a strategy."}`,
  });

  if (pbo !== undefined) {
    const ok = pbo.pbo <= MAX_PBO;
    checks.push({
      id: "pbo",
      passed: ok,
      /* The check on the SELECTION, not on this strategy. A candidate can be
         individually sound and still be one the sweep had no ability to pick. */
      text: `PBO ${pctOf(pbo.pbo)}${ok ? " — the selection carries information." : ` — above ${pctOf(MAX_PBO)}, so choosing the best of this set is not distinguishable from choosing at random. That is a fact about the SET, not about this strategy.`}`,
    });
  } else {
    checks.push({
      id: "pbo",
      passed: false,
      text: "PBO not computed — a check nobody ran is not a check that passed.",
    });
  }

  const promoted = checks.every((c) => c.passed);
  const failed = checks.filter((c) => !c.passed).length;

  return {
    promoted,
    checks,
    outOfSample: oos,
    summary: promoted
      ? `Promoted — ${r(oos.expectancyR)} over ${oos.trades} out-of-sample trades, ${pctOf(wf.degradation)} of the edge retained.`
      : `Not promoted — ${failed} of ${checks.length} checks failed.`,
  };
}

/**
 * The line the desk shows above a list of results.
 *
 * Says how many survived, which is the number worth knowing, and refuses to
 * congratulate a set where nothing did. "0 of 25 promoted" is the most useful
 * thing a strategy desk can tell somebody, and it is the sentence every other
 * platform is built to avoid printing.
 */
export function promotionLine(results: readonly Promotion[]): string {
  if (results.length === 0) return "Nothing tested yet.";
  const n = results.filter((p) => p.promoted).length;
  if (n === 0) {
    return `0 of ${results.length} promoted. Nothing here cleared the out-of-sample gate — which is the ordinary result, and a great deal more useful than a ranked list of things that did not.`;
  }
  return `${n} of ${results.length} promoted on out-of-sample evidence. The rest are shown so you can see what failed and why, not as a shortlist.`;
}
