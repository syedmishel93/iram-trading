/**
 * Validation — walk-forward and the probability of backtest overfitting.
 *
 * WHY THIS MATTERS MORE THAN THE BACKTEST ITSELF
 * Any backtest can be made to look good. Try enough parameter combinations and
 * one of them will fit the noise beautifully; that is arithmetic, not skill.
 * The question a backtest cannot answer about itself is: "given how many
 * variants I tried, how likely is it that the winner is just the luckiest?"
 *
 * Two independent checks answer it:
 *
 * **Walk-forward** — choose parameters on one slice, measure on the NEXT slice,
 * repeat. The gap between in-sample and out-of-sample performance is the
 * measure of how much of the edge was curve-fitting.
 *
 * **PBO via CSCV** (Bailey, Borwein, López de Prado & Zhu) — split the period
 * into S blocks, take every way of splitting them into equal train/test halves,
 * and ask how often the best-in-sample configuration lands BELOW the median
 * out-of-sample. If that happens half the time, your selection process has no
 * skill whatsoever, and the winner was the luckiest rather than the best.
 *
 * A PBO near 0.5 means the whole exercise was noise. It is the single most
 * useful number here, and the one people leave out.
 */

import type { BarView } from "../chart/series";
import { runBacktest, type BacktestOptions, type Strategy, type Trade } from "./engine";
import { computeMetrics, type Metrics } from "./metrics";

// ------------------------------------------------------------ walk-forward --

export interface WalkForwardFold {
  index: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  /** Configuration selected on the training slice. */
  chosen: string | null;
  inSample: Metrics;
  outOfSample: Metrics;
  /**
   * The out-of-sample trades this fold produced.
   *
   * Kept, not just counted (v60): every PER-TRADE statistic downstream needs
   * them, and reconstructing a spread from `outOfSample`'s win/loss averages
   * understates it — which would flatter every strategy that reached a
   * multiplicity correction. The aggregate below is computed from exactly
   * these, pooled.
   */
  trades: Trade[];
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** Metrics over every out-of-sample trade, pooled. */
  aggregate: Metrics;
  /**
   * Out-of-sample expectancy divided by in-sample expectancy.
   * Near 1 = the edge held. Near 0 or negative = it was curve-fitting.
   */
  degradation: number;
  warnings: string[];
  verdict: string;
}

export interface WalkForwardOptions extends BacktestOptions {
  folds?: number;
  /** Share of each window used for training. */
  trainRatio?: number;
  /** Score used to pick the in-sample winner. */
  score?: (m: Metrics) => number;
}

/** Default selection score: expectancy, but only once there is a real sample. */
export const defaultScore = (m: Metrics): number =>
  m.trades < 10 ? -Infinity : m.expectancyR * Math.min(1, m.trades / 30);

/**
 * Rolling walk-forward across `candidates`.
 *
 * Each fold trains on its own slice and tests on the slice immediately after
 * it. Nothing from the test slice reaches the selection, which is the entire
 * point — a fold that peeked would just reproduce the in-sample result.
 */
export function walkForward(
  candidates: readonly Strategy[],
  bars: readonly BarView[],
  opts: WalkForwardOptions = {},
): WalkForwardResult {
  const foldCount = Math.max(2, opts.folds ?? 5);
  const trainRatio = Math.min(0.9, Math.max(0.1, opts.trainRatio ?? 0.7));
  const score = opts.score ?? defaultScore;
  const warnings: string[] = [];

  if (candidates.length === 0) {
    return {
      folds: [],
      aggregate: computeMetrics([], []),
      degradation: 0,
      warnings: ["no candidate strategies"],
      verdict: "nothing to validate",
    };
  }

  const windowSize = Math.floor(bars.length / foldCount);
  const maxWarmup = Math.max(...candidates.map((c) => c.warmup));

  if (windowSize < maxWarmup * 2) {
    return {
      folds: [],
      aggregate: computeMetrics([], []),
      degradation: 0,
      warnings: [
        `${bars.length} bars over ${foldCount} folds leaves ${windowSize} per fold, ` +
          `below twice the ${maxWarmup}-bar warm-up — there is not enough history to validate on`,
      ],
      verdict: "insufficient history",
    };
  }

  const folds: WalkForwardFold[] = [];
  const oosTrades: Trade[] = [];
  let isExpectancySum = 0;
  let oosExpectancySum = 0;
  let scored = 0;

  for (let f = 0; f < foldCount; f++) {
    const from = f * windowSize;
    const to = f === foldCount - 1 ? bars.length : (f + 1) * windowSize;
    const splitAt = from + Math.floor((to - from) * trainRatio);

    const train = bars.slice(from, splitAt);
    const test = bars.slice(splitAt, to);
    if (train.length < maxWarmup + 10 || test.length < maxWarmup + 10) continue;

    // --- select on train ONLY
    let best: { strategy: Strategy; metrics: Metrics; score: number } | null = null;
    for (const candidate of candidates) {
      const run = runBacktest(candidate, train, opts);
      if (run.refused) continue;
      const m = computeMetrics(run.trades, run.equity);
      const s = score(m);
      if (!best || s > best.score) best = { strategy: candidate, metrics: m, score: s };
    }

    if (!best || !Number.isFinite(best.score)) {
      folds.push({
        index: f,
        trainFrom: from,
        trainTo: splitAt,
        testFrom: splitAt,
        testTo: to,
        chosen: null,
        inSample: computeMetrics([], []),
        outOfSample: computeMetrics([], []),
        trades: [],
      });
      continue;
    }

    // --- measure that ONE choice on the untouched test slice
    const oos = runBacktest(best.strategy, test, opts);
    const oosMetrics = computeMetrics(oos.trades, oos.equity);
    oosTrades.push(...oos.trades);

    isExpectancySum += best.metrics.expectancyR;
    oosExpectancySum += oosMetrics.expectancyR;
    scored++;

    folds.push({
      index: f,
      trainFrom: from,
      trainTo: splitAt,
      testFrom: splitAt,
      testTo: to,
      chosen: best.strategy.id,
      inSample: best.metrics,
      outOfSample: oosMetrics,
      trades: oos.trades,
    });
  }

  const aggregate = computeMetrics(oosTrades, syntheticEquity(oosTrades, opts.riskPerTrade ?? 0.01));
  const isAvg = scored > 0 ? isExpectancySum / scored : 0;
  const oosAvg = scored > 0 ? oosExpectancySum / scored : 0;
  const degradation = isAvg !== 0 ? oosAvg / isAvg : 0;

  if (oosTrades.length < 30) {
    warnings.push(
      `${oosTrades.length} out-of-sample trades across all folds — too few to conclude anything`,
    );
  }

  let verdict: string;
  if (scored === 0) verdict = "no fold produced a usable selection";
  else if (oosAvg <= 0)
    verdict =
      `out-of-sample expectancy is ${oosAvg.toFixed(3)}R against ${isAvg.toFixed(3)}R in-sample — ` +
      `the edge did not survive selection and is very likely curve-fitting`;
  else if (degradation < 0.4)
    verdict =
      `out-of-sample kept only ${(degradation * 100).toFixed(0)}% of in-sample expectancy — ` +
      `most of the apparent edge was fitted to the training slice`;
  else
    verdict =
      `out-of-sample kept ${(degradation * 100).toFixed(0)}% of in-sample expectancy ` +
      `(${oosAvg.toFixed(3)}R vs ${isAvg.toFixed(3)}R) across ${scored} folds`;

  return { folds, aggregate, degradation, warnings, verdict };
}

/** Equity reconstructed from pooled trades, for drawdown on the OOS set. */
function syntheticEquity(trades: readonly Trade[], risk: number): Float64Array {
  const out = new Float64Array(trades.length + 1);
  let capital = 1;
  out[0] = 1;
  trades.forEach((t, i) => {
    const riskPerUnit = Math.abs(t.entryPrice - t.exitPrice) > 0 ? Math.abs(t.rMultiple) : 0;
    void riskPerUnit;
    capital *= 1 + t.rMultiple * risk;
    out[i + 1] = capital;
  });
  return out;
}

// ---------------------------------------------------------------- PBO/CSCV --

export interface PboResult {
  /** Probability the in-sample winner is below the out-of-sample median. */
  pbo: number;
  /** One logit per split; negative means the winner underperformed. */
  logits: number[];
  splits: number;
  /** How often the chosen config was OOS-positive at all. */
  oosPositiveRate: number;
  interpretation: string;
}

/** All ways to choose `k` of `n` indices. */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (start: number): void => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Probability of backtest overfitting, via combinatorially symmetric CV.
 *
 * `matrix[c][t]` is configuration `c`'s return at time `t`. Time is split into
 * `blocks` contiguous chunks; every balanced train/test partition of those
 * blocks is evaluated. For each one: pick the configuration with the best
 * training performance, find its RANK out-of-sample, and take the logit of the
 * relative rank. PBO is the share of partitions where that logit is negative.
 *
 * 0.0 means the in-sample winner always held up. 0.5 means selection is a coin
 * flip — the "best" strategy was the luckiest, and the research process has no
 * predictive value at all.
 */
export function pbo(matrix: readonly (readonly number[])[], blocks = 8): PboResult {
  const configs = matrix.length;
  if (configs < 2) {
    return {
      pbo: 0,
      logits: [],
      splits: 0,
      oosPositiveRate: 0,
      interpretation: "PBO needs at least two configurations to compare",
    };
  }

  const T = matrix[0]?.length ?? 0;
  const S = blocks % 2 === 0 ? blocks : blocks - 1;
  if (T < S * 2 || S < 2) {
    return {
      pbo: 0,
      logits: [],
      splits: 0,
      oosPositiveRate: 0,
      interpretation: `not enough observations (${T}) to form ${S} blocks`,
    };
  }

  const size = Math.floor(T / S);
  const blockRanges: Array<[number, number]> = [];
  for (let i = 0; i < S; i++) {
    blockRanges.push([i * size, i === S - 1 ? T : (i + 1) * size]);
  }

  /** Sum of returns over the given blocks — monotone in mean, and cheap. */
  const perf = (config: number, chosen: readonly number[]): number => {
    const row = matrix[config] as readonly number[];
    let sum = 0;
    for (const b of chosen) {
      const [from, to] = blockRanges[b] as [number, number];
      for (let t = from; t < to; t++) sum += (row[t] as number) ?? 0;
    }
    return sum;
  };

  const logits: number[] = [];
  let oosPositive = 0;
  const all = [...Array(S).keys()];

  for (const train of combinations(S, S / 2)) {
    const trainSet = new Set(train);
    const test = all.filter((b) => !trainSet.has(b));

    // in-sample winner
    let bestConfig = 0;
    let bestPerf = -Infinity;
    for (let c = 0; c < configs; c++) {
      const p = perf(c, train);
      if (p > bestPerf) {
        bestPerf = p;
        bestConfig = c;
      }
    }

    // its out-of-sample rank among all configs
    const oos = Array.from({ length: configs }, (_, c) => perf(c, test));
    const chosenPerf = oos[bestConfig] as number;
    if (chosenPerf > 0) oosPositive++;

    let worseCount = 0;
    for (let c = 0; c < configs; c++) if ((oos[c] as number) < chosenPerf) worseCount++;

    // Relative rank in (0,1), nudged off the endpoints so the logit stays finite
    // when the winner ranks first or last.
    const omega = (worseCount + 0.5) / configs;
    logits.push(Math.log(omega / (1 - omega)));
  }

  const failures = logits.filter((l) => l <= 0).length;
  const value = logits.length > 0 ? failures / logits.length : 0;

  let interpretation: string;
  if (value >= 0.5) {
    interpretation =
      `PBO ${(value * 100).toFixed(0)}% — the best in-sample configuration lands below the ` +
      `out-of-sample median at least half the time. Selection here has no predictive value; ` +
      `the winner was the luckiest, not the best.`;
  } else if (value >= 0.25) {
    interpretation =
      `PBO ${(value * 100).toFixed(0)}% — selection carries real overfitting risk. Roughly one ` +
      `in ${Math.round(1 / value)} choices of "best" would have disappointed out-of-sample.`;
  } else {
    interpretation =
      `PBO ${(value * 100).toFixed(0)}% — the in-sample winner usually held up out-of-sample. ` +
      `This is evidence the selection process has some skill, not that the strategy will profit.`;
  }

  return {
    pbo: value,
    logits,
    splits: logits.length,
    oosPositiveRate: logits.length > 0 ? oosPositive / logits.length : 0,
    interpretation,
  };
}

/** Per-bar returns from an equity curve, for the PBO matrix. */
export function equityToReturns(equity: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1] as number;
    const cur = equity[i] as number;
    out.push(prev > 0 && Number.isFinite(cur) ? cur / prev - 1 : 0);
  }
  return out;
}
