/**
 * What is weak about a backtest, read off the result itself.
 *
 * The Strategy desk's "AI critique" card. It is labelled AI because it is the
 * terminal speaking rather than the operator — but there is no language model
 * in it and no opinion: every finding is one measured number compared with one
 * named threshold, and a finding that cannot be measured is reported as "not
 * checked", never folded into a pass. The mock-up's critique was three fixed
 * sentences, one of them a PBO figure from a different study; this is the
 * replacement, and it can only say what the result says.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not deflate a Sharpe ratio for the number of versions tried. The
 * lesson from the Analyse desk (CLAUDE.md, "a correction in the wrong units")
 * is that a deflation fed an annualised Sharpe and a trade count prints a
 * plausible, wrong number. It COUNTS the versions and says the count, which is
 * a fact, rather than converting it into a haircut, which would be a model.
 *
 * A clean result produces no findings. It still lists every check it ran, so
 * "nothing weak found" is a statement about named checks, not a verdict.
 */

import type { Trade } from "./engine";
import type { Metrics } from "./metrics";
import type { MonteCarloResult } from "./montecarlo";
import { MIN_OOS_TRADES, MIN_RETENTION } from "./promote";
import { MIN_REGIME_TRADES, REGIME_LABEL, type RegimeSlice } from "./regime";
import type { WalkForwardResult } from "./validate";

/** Fewer trades than this over the whole history and nothing is readable. The gate's own out-of-sample floor, applied to the whole sample. */
export const MIN_SAMPLE_TRADES = MIN_OOS_TRADES;
/** Every cost is multiplied by this for the stress run. */
export const COST_STRESS = 2;
/** The best this share of trades (at least one) is removed for the concentration check. */
export const TOP_TRADE_SHARE = 0.05;
/** Return over worst drawdown below this and the ride cost more than it paid. */
export const MIN_RECOVERY = 1;
/** More than this share of trades in one kind of market and the others are barely tested. */
export const MAX_REGIME_SHARE = 0.8;
/** Share of simulated orderings reaching the ruin drawdown that counts as a finding. The lab's Monte Carlo chip uses the same 5%. */
export const MAX_RUIN = 0.05;
/** This many versions tried on the same bars and selection itself becomes the result. */
export const MANY_VERSIONS = 3;

export interface CritiqueInput {
  readonly trades: readonly Trade[];
  /** In sample, after costs. */
  readonly metrics: Metrics;
  /** The same rule at `COST_STRESS` times the costs; null when that run was not made. */
  readonly stressed: Metrics | null;
  readonly walk: WalkForwardResult;
  readonly regimes: readonly RegimeSlice[];
  /** Only once the operator has run the simulation. */
  readonly mc?: MonteCarloResult | null;
  /** Distinct rule versions backtested on this market and timeframe, this one included. */
  readonly versionsTried: number;
}

export interface CritiqueCheck {
  readonly id:
    | "sample"
    | "edge"
    | "in-sample-only"
    | "oos-sample"
    | "retention"
    | "costs"
    | "concentration"
    | "drawdown"
    | "regime-share"
    | "regime-loss"
    | "ruin"
    | "versions";
  /** Plain name of the check. */
  readonly label: string;
  /** True passed, false is a finding, null could not be checked. */
  readonly passed: boolean | null;
  /** The measured number, in the unit `threshold` is in; null when not measured. */
  readonly value: number | null;
  readonly threshold: number;
  /** One short line: the number and its limit. */
  readonly text: string;
  /** The reasoning, for "Why?". */
  readonly why: string;
}

export interface Critique {
  readonly checks: readonly CritiqueCheck[];
  /** The failed checks, in the order they matter. */
  readonly findings: readonly CritiqueCheck[];
  readonly headline: string;
}

const pct = (v: number, dp = 0): string => `${(v * 100).toFixed(dp)}%`;
const sR = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export function critique(input: CritiqueInput): Critique {
  const { metrics: m, trades } = input;
  const checks: CritiqueCheck[] = [];

  // ------------------------------------------------------------ sample ---
  const enough = m.trades >= MIN_SAMPLE_TRADES;
  checks.push({
    id: "sample",
    label: "Sample size",
    passed: enough,
    value: m.trades,
    threshold: MIN_SAMPLE_TRADES,
    text: enough
      ? `${m.trades} trades — at least ${MIN_SAMPLE_TRADES}.`
      : `Only ${plural(m.trades, "trade")} — under ${MIN_SAMPLE_TRADES}, too few to tell skill from luck.`,
    why: `Below ${MIN_SAMPLE_TRADES} trades a few lucky or unlucky fills decide every figure on this page. It is the same floor the out-of-sample check uses.`,
  });

  // -------------------------------------------------------------- edge ---
  const positive = m.expectancyR > 0;
  checks.push({
    id: "edge",
    label: "Makes money after costs",
    passed: m.trades === 0 ? null : positive,
    value: m.trades === 0 ? null : m.expectancyR,
    threshold: 0,
    text:
      m.trades === 0
        ? "No trades, so there is no result to judge."
        : positive
          ? `${sR(m.expectancyR)} a trade after costs.`
          : `It loses money after costs: ${sR(m.expectancyR)} a trade.`,
    why: "Expectancy is the average result per trade in units of risk (R), with your spread, commission and slippage charged. At or below zero there is nothing to protect.",
  });

  // ---------------------------------------------------- out of sample ---
  const wf = input.walk;
  const ran = wf.folds.length > 0;
  checks.push({
    id: "in-sample-only",
    label: "Tested on unseen data",
    passed: ran,
    value: wf.folds.length,
    threshold: 1,
    text: ran
      ? `Walk-forward ran over ${plural(wf.folds.length, "fold")}.`
      : "Tested in sample only — the walk-forward could not run.",
    why: ran
      ? "Each fold is measured on a slice the rules were not checked against first."
      : `The walk-forward said: ${wf.verdict}. Everything above is then a description of the same bars the rules were written against.`,
  });

  if (ran) {
    const oos = wf.aggregate;
    const oosEnough = oos.trades >= MIN_OOS_TRADES;
    checks.push({
      id: "oos-sample",
      label: "Unseen-data sample",
      passed: oosEnough,
      value: oos.trades,
      threshold: MIN_OOS_TRADES,
      text: oosEnough
        ? `${oos.trades} trades on unseen data.`
        : `Only ${plural(oos.trades, "trade")} on unseen data — under ${MIN_OOS_TRADES}.`,
      why: "The out-of-sample trades are the only ones the rules could not have been fitted to. Too few and the out-of-sample figure is as noisy as a coin.",
    });

    const measurable = Number.isFinite(wf.degradation) && m.expectancyR > 0;
    const kept = measurable && wf.degradation >= MIN_RETENTION && oos.expectancyR > 0;
    checks.push({
      id: "retention",
      label: "Edge kept on unseen data",
      passed: measurable ? kept : null,
      value: measurable ? wf.degradation : null,
      threshold: MIN_RETENTION,
      text: !measurable
        ? "No in-sample edge to compare with."
        : kept
          ? `Kept ${pct(wf.degradation)} of its edge on unseen data.`
          : `Kept ${pct(wf.degradation)} of its edge on unseen data — under the ${pct(MIN_RETENTION)} floor (${sR(oos.expectancyR)} a trade there).`,
      why: `Out-of-sample expectancy divided by in-sample. Real edges shrink; below ${pct(MIN_RETENTION)} most of the backtest was a description of the training slices.`,
    });
  }

  // ------------------------------------------------------------- costs ---
  const s = input.stressed;
  if (s === null || m.trades === 0 || !positive) {
    checks.push({
      id: "costs",
      label: `Survives ${COST_STRESS}× costs`,
      passed: null,
      value: s ? s.expectancyR : null,
      threshold: 0,
      text: s === null ? "Not checked — the stress run was not made." : "Not checked — there is no edge to stress.",
      why: `The rules are re-run with spread, commission and slippage all multiplied by ${COST_STRESS}. Without a positive result at your own costs there is nothing for that to test.`,
    });
  } else {
    const holds = s.expectancyR > 0;
    checks.push({
      id: "costs",
      label: `Survives ${COST_STRESS}× costs`,
      passed: holds,
      value: s.expectancyR,
      threshold: 0,
      text: holds
        ? `Still ${sR(s.expectancyR)} a trade at ${COST_STRESS}× your costs.`
        : `At ${COST_STRESS}× your costs it stops making money: ${sR(m.expectancyR)} → ${sR(s.expectancyR)}.`,
      why: `The same rules re-run with every cost multiplied by ${COST_STRESS}. Real fills are worse than modelled ones — wider spreads at news, slippage on stops — so an edge that vanishes at double the cost is an edge the broker keeps.`,
    });
  }

  // ----------------------------------------------------- concentration ---
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  if (trades.length > 0 && totalR > 0) {
    const k = Math.max(1, Math.ceil(trades.length * TOP_TRADE_SHARE));
    const best = trades.map((t) => t.rMultiple).sort((a, b) => b - a).slice(0, k);
    const topR = best.reduce((a, v) => a + v, 0);
    const rest = totalR - topR;
    const holds = rest > 0;
    checks.push({
      id: "concentration",
      label: "Not a few lucky trades",
      passed: holds,
      value: rest,
      threshold: 0,
      text: holds
        ? `Without its best ${plural(k, "trade")} it still makes ${sR(rest)} in total.`
        : `Without its best ${plural(k, "trade")} of ${trades.length} it loses money (${sR(rest)} in total) — the result rests on outliers.`,
      why: `The best ${pct(TOP_TRADE_SHARE)} of trades (at least one) are removed and the rest summed, in R. They made ${sR(topR)} of the ${sR(totalR)} total. An edge that lives in a handful of trades needs those trades to happen again.`,
    });
  } else {
    checks.push({
      id: "concentration",
      label: "Not a few lucky trades",
      passed: null,
      value: null,
      threshold: 0,
      text: "Not checked — there is no total profit to attribute.",
      why: `Measures whether the profit survives removing the best ${pct(TOP_TRADE_SHARE)} of trades. Without a profit there is nothing to remove.`,
    });
  }

  // ---------------------------------------------------------- drawdown ---
  /* Only a PROFIT can be compared with the drop it cost. A losing rule is
     already the "edge" finding; saying its drawdown beat its negative return
     would be the same fact twice, worded worse. */
  if (m.trades > 0 && m.maxDrawdown > 0 && m.totalReturn > 0) {
    const ratio = m.totalReturn / m.maxDrawdown;
    const holds = ratio >= MIN_RECOVERY;
    checks.push({
      id: "drawdown",
      label: "Return bigger than its worst drop",
      passed: holds,
      value: ratio,
      threshold: MIN_RECOVERY,
      text: holds
        ? `Returned ${ratio.toFixed(1)}× its worst drawdown.`
        : `Its worst drawdown (−${pct(m.maxDrawdown, 1)}) was bigger than its whole return (+${pct(m.totalReturn, 1)}).`,
      why: `Total return divided by the deepest peak-to-trough fall, both at the risk per trade you set. Below ${MIN_RECOVERY} the ride cost more than it paid, and most people stop a system in its worst drawdown.`,
    });
  } else {
    checks.push({
      id: "drawdown",
      label: "Return bigger than its worst drop",
      passed: null,
      value: null,
      threshold: MIN_RECOVERY,
      text:
        m.trades === 0
          ? "Not checked — no trades."
          : m.totalReturn <= 0
            ? "Not checked — it made no money to set against the drop."
            : "Never fell below a previous peak.",
      why: "Total return divided by the deepest peak-to-trough fall. Undefined without a profit or without a drawdown.",
    });
  }

  // ------------------------------------------------------------ regime ---
  const counted = input.regimes.reduce((a, r) => a + r.metrics.trades, 0);
  if (counted >= MIN_SAMPLE_TRADES) {
    const top = [...input.regimes].sort((a, b) => b.metrics.trades - a.metrics.trades)[0] as RegimeSlice;
    const share = top.metrics.trades / counted;
    const spread = share <= MAX_REGIME_SHARE;
    checks.push({
      id: "regime-share",
      label: "Tested across market conditions",
      passed: spread,
      value: share,
      threshold: MAX_REGIME_SHARE,
      text: spread
        ? `No one market condition holds more than ${pct(MAX_REGIME_SHARE)} of its trades.`
        : `${pct(share)} of its trades came in one kind of market (${REGIME_LABEL[top.regime].toLowerCase()}) — barely tested in the others.`,
      why: `Each trade is filed under the condition it was ENTERED in (trend, chop, volatile). Above ${pct(MAX_REGIME_SHARE)} in one, the result says little about the others.`,
    });

    if (positive) {
      const losing = input.regimes
        .filter((r) => r.metrics.trades >= MIN_REGIME_TRADES && r.metrics.expectancyR <= 0)
        .sort((a, b) => a.metrics.expectancyR - b.metrics.expectancyR)[0];
      checks.push({
        id: "regime-loss",
        label: "No condition where it loses",
        passed: losing === undefined,
        value: losing ? losing.metrics.expectancyR : null,
        threshold: 0,
        text: losing
          ? `It lost money in ${REGIME_LABEL[losing.regime].toLowerCase()}: ${sR(losing.metrics.expectancyR)} over ${losing.metrics.trades} trades.`
          : `No market condition with ${MIN_REGIME_TRADES}+ trades lost money.`,
        why: `Only conditions with at least ${MIN_REGIME_TRADES} trades are judged. A condition where it reliably loses is a filter waiting to be written — or a sign the overall figure averages two different behaviours.`,
      });
    }
  } else {
    checks.push({
      id: "regime-share",
      label: "Tested across market conditions",
      passed: null,
      value: null,
      threshold: MAX_REGIME_SHARE,
      text: `Not checked — under ${MIN_SAMPLE_TRADES} trades to split.`,
      why: "Splitting a thin sample three ways manufactures differences.",
    });
  }

  // -------------------------------------------------------------- ruin ---
  const mc = input.mc;
  if (mc && mc.refused === null) {
    const safe = mc.ruinProbability < MAX_RUIN;
    checks.push({
      id: "ruin",
      label: "Simulated risk of ruin",
      passed: safe,
      value: mc.ruinProbability,
      threshold: MAX_RUIN,
      text: safe
        ? `${pct(mc.ruinProbability, 1)} of ${mc.draws} simulated orderings fell ${pct(mc.ruinDrawdown)} — under ${pct(MAX_RUIN)}.`
        : `${pct(mc.ruinProbability, 1)} of ${mc.draws} simulated orderings fell ${pct(mc.ruinDrawdown)} or more — over ${pct(MAX_RUIN)}.`,
      why: `The backtest's own trades, redrawn in random order ${mc.draws} times at ${pct(mc.riskPerTrade, 1)} risk each. It assumes trades are independent, so clustered losers make the real risk higher than this.`,
    });
  } else {
    checks.push({
      id: "ruin",
      label: "Simulated risk of ruin",
      passed: null,
      value: null,
      threshold: MAX_RUIN,
      text: mc ? `Not simulated: ${mc.refused ?? ""}.` : "Not checked — run the simulation.",
      why: "The Monte Carlo reorders the backtest's trades to show the drawdowns the same edge could have produced.",
    });
  }

  // ---------------------------------------------------------- versions ---
  const few = input.versionsTried < MANY_VERSIONS;
  checks.push({
    id: "versions",
    label: "Few versions tried",
    passed: few,
    value: input.versionsTried,
    threshold: MANY_VERSIONS,
    text: few
      ? `${plural(input.versionsTried, "version")} tested on these bars.`
      : `${input.versionsTried} versions tested on these bars — the best of several always looks better than it will trade.`,
    why: `Every version you test on the same bars is another draw. Choosing the best of ${MANY_VERSIONS} or more is a selection, and the out-of-sample check is the only defence against it. No figure here is deflated for the count; the count is shown instead.`,
  });

  const findings = checks.filter((c) => c.passed === false);
  const ranChecks = checks.filter((c) => c.passed !== null).length;
  return {
    checks,
    findings,
    headline:
      findings.length === 0
        ? `Nothing weak found in ${plural(ranChecks, "check")}. That is not proof it works — only that it passed the checks below.`
        : `${findings.length} ${findings.length === 1 ? "weakness" : "weaknesses"} found in ${plural(ranChecks, "check")}.`,
  };
}
