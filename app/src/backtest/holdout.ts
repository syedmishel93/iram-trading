/**
 * DID IT STILL WORK RECENTLY? — splitting one run into an earlier and a held-back
 * window.
 *
 * WHY THE PLAYBOOK NEEDED THIS
 *
 * The desk's own result panel says it: "One rule set on one symbol over one
 * window, with costs applied. That is a description of the past, not evidence of
 * an edge" — and then sends you to another desk. Honest, and it leaves the most
 * useful question on the table, because the operator has already CHOSEN this rule
 * set, usually after seeing how it did. That is selection, and a number computed
 * over the same window the choice was made on cannot argue with it.
 *
 * Holding back the most recent slice is the cheapest instrument that can: the
 * rule was not picked for what it did there, so agreement between the two
 * windows is worth something and disagreement is worth more.
 *
 * ONE RUN, PARTITIONED — NOT TWO RUNS.
 *
 * The obvious build is to run the engine twice on two slices of bars, and it is
 * wrong twice over. Every indicator needs lead-in, so the second run would begin
 * blind and its first trades would be computed from a shorter history than the
 * same bars got in the full run — the two windows would then differ for a reason
 * that has nothing to do with the market. And a rule holding a position across
 * the boundary would be entered in one run and never exited in the other.
 *
 * So the engine runs ONCE over everything and its trades are partitioned by
 * ENTRY TIME. Every trade is priced exactly as the full run priced it, and each
 * belongs to the window it was opened in.
 *
 * IT REFUSES ON A THIN SIDE, AND THAT IS THE POINT.
 *
 * Six trades in the held-back window cannot disagree with anything. Reporting a
 * win rate over them would be the "0 of 0 running" mistake with a denominator:
 * a figure that looks like a measurement and is noise. `enough` is false and
 * `why` says which side is short, rather than printing two percentages for the
 * eye to compare.
 */

import { computeMetrics, EMPTY_METRICS, type Metrics } from "./metrics";
import type { Trade } from "./engine";

/**
 * Trades needed on EACH side before the two windows are compared.
 *
 * Thirty, matching `excursion.ts` rather than inventing a second floor: it is
 * the number this codebase already treats as "enough to say something about a
 * distribution of trades", and two floors for one idea drift.
 */
export const MIN_PER_SIDE = 30;

/** How much of the run is held back, as a share. */
export const DEFAULT_HOLDOUT = 0.3;

export interface HoldoutSplit {
  /** Epoch ms where the run was cut. */
  readonly at: number;
  /** Share held back, as given. */
  readonly share: number;
  readonly earlier: Metrics;
  readonly recent: Metrics;
  readonly earlierTrades: number;
  readonly recentTrades: number;
  /** Both sides cleared `MIN_PER_SIDE`, so the comparison means something. */
  readonly enough: boolean;
  /**
   * Whether the held-back window agrees with the earlier one.
   *
   * NULL when it cannot be said — which is most of the time on a short run, and
   * is a different fact from "they disagree".
   */
  readonly agrees: boolean | null;
  /** Addressed to the operator. Never empty. */
  readonly why: string;
}

const EMPTY = (at: number, share: number, why: string, e = 0, r = 0): HoldoutSplit => ({
  at,
  share,
  earlier: { ...EMPTY_METRICS },
  recent: { ...EMPTY_METRICS },
  earlierTrades: e,
  recentTrades: r,
  enough: false,
  agrees: null,
  why,
});

/**
 * Split a completed run at a time boundary and measure both halves.
 *
 * `bars` is needed only for its timestamps: the boundary is a TIME, so that the
 * held-back share means the same thing whether the rule traded twice a day or
 * twice a year. Splitting on trade COUNT instead would hold back "the last 30%
 * of trades", which is a different and much less useful question — a rule that
 * stopped trading entirely would then have no recent window at all, when that is
 * exactly the finding worth surfacing.
 */
export function splitRun(
  trades: readonly Trade[],
  equity: ArrayLike<number>,
  barTimes: readonly number[],
  share: number = DEFAULT_HOLDOUT,
  barsPerYear = 8760,
): HoldoutSplit {
  if (!(share > 0) || !(share < 1)) {
    return EMPTY(0, share, "the held-back share has to be between 0 and 1");
  }
  if (barTimes.length < 2) {
    return EMPTY(0, share, "there are not enough bars to split");
  }

  const first = barTimes[0] ?? 0;
  const last = barTimes[barTimes.length - 1] ?? 0;
  if (!(last > first)) {
    return EMPTY(0, share, "the bars do not span any time");
  }
  const at = last - (last - first) * share;

  const earlierT = trades.filter((t) => t.entryTime < at);
  const recentT = trades.filter((t) => t.entryTime >= at);

  /* The equity curve is cut at the same place, so each window's drawdown is
     peak-to-trough WITHIN it rather than inherited from the other half. */
  let cut = barTimes.findIndex((t) => t >= at);
  if (cut < 0) cut = barTimes.length;
  const eq = Array.from(equity as ArrayLike<number>);
  const earlierEq = eq.slice(0, Math.max(1, cut));
  const recentEq = eq.slice(Math.max(0, cut - 1));

  if (earlierT.length < MIN_PER_SIDE || recentT.length < MIN_PER_SIDE) {
    const which =
      earlierT.length < MIN_PER_SIDE && recentT.length < MIN_PER_SIDE
        ? `only ${earlierT.length} and ${recentT.length} trades`
        : earlierT.length < MIN_PER_SIDE
          ? `only ${earlierT.length} trades before the split`
          : `only ${recentT.length} trades in the held-back window`;
    return EMPTY(
      at,
      share,
      `Not enough to compare: ${which}, and ${MIN_PER_SIDE} a side is the floor. ` +
        "Two percentages over a handful of trades look like a measurement and are noise.",
      earlierT.length,
      recentT.length,
    );
  }

  const earlier = computeMetrics(earlierT, earlierEq, barsPerYear);
  const recent = computeMetrics(recentT, recentEq, barsPerYear);

  /*
   * AGREEMENT IS ABOUT THE SIGN, NOT THE SIZE.
   *
   * Expectancy in R is the comparable quantity across windows of different
   * lengths — a total return is mostly a statement about how long the window
   * was. Asking whether both are positive is a coarse question and it is the one
   * that matters: a rule that made money early and loses it recently is the
   * finding this whole split exists to surface, and a rule whose expectancy
   * merely halved is still a rule that works.
   */
  const e = earlier.expectancyR;
  const r = recent.expectancyR;
  const agrees = Number.isFinite(e) && Number.isFinite(r) ? e > 0 === r > 0 : null;

  const why =
    agrees === null
      ? "One of the two windows has no measurable expectancy, so they cannot be compared."
      : agrees
        ? `Both windows point the same way: ${e.toFixed(2)}R earlier, ${r.toFixed(2)}R in the ` +
          `held-back ${Math.round(share * 100)}%. That is not proof, and it is what failure ` +
          "would have looked different from."
        : `They disagree: ${e.toFixed(2)}R earlier against ${r.toFixed(2)}R in the held-back ` +
          `${Math.round(share * 100)}%. The rule was chosen on a window that includes the first ` +
          "number and not the second, which is the case this split exists to catch.";

  return {
    at,
    share,
    earlier,
    recent,
    earlierTrades: earlierT.length,
    recentTrades: recentT.length,
    enough: true,
    agrees,
    why,
  };
}
