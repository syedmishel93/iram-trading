/**
 * Ask a strategy the same question at every bar, and write down every answer.
 *
 * `runBacktest` asks `entry()` only where it could act: not during warm-up, and
 * never while a position is open. That is right for a backtest and wrong for a
 * training set, for the reason `ledger.ts` states at length — the trades a
 * backtest took are a SELECTED sample, and a model fitted to them learns the
 * selection rule. This walks every bar, open position or not, so the ledger
 * sees the setups that were skipped as well as the ones that were traded.
 *
 * IT DOES NOT SECOND-GUESS THE STRATEGY. The signal, its direction, its stop
 * and its target all come from `entry()` itself, unchanged — the same call
 * `runBacktest` makes, on a context built the same way. A collector that
 * recomputed any of them would be a second implementation of the rule, and the
 * first disagreement would surface as a router trained on trades the engine
 * never takes.
 */

import type { BarView } from "../chart/series";
import { makeContext, type Strategy } from "./engine";
import { buildFeatures, FEATURE_WARMUP, type FeatureMatrix } from "./features";
import type { Signal } from "./ledger";

export interface Collected {
  readonly signals: readonly Signal[];
  /** The feature matrix used, so a caller can report what it could not compute. */
  readonly matrix: FeatureMatrix;
  /** Bars where the strategy fired but no feature row could be built. */
  readonly unfeatured: number;
  /** Bars the strategy was asked about at all. */
  readonly asked: number;
}

/**
 * Every bar where `strategy` would have entered, with what was true there.
 *
 * A signal whose features could not be computed is DROPPED rather than filled,
 * and counted — a zero-filled row is a fabricated observation, and the rows it
 * would appear on are the warm-up and the gaps, which is where a model has
 * least to learn and most to be misled by.
 */
export function collectSignals(strategy: Strategy, bars: readonly BarView[]): Collected {
  const matrix = buildFeatures(bars);
  const signals: Signal[] = [];
  let unfeatured = 0;
  let asked = 0;

  if (bars.length === 0) return { signals, matrix, unfeatured, asked };

  const ctx = makeContext(bars);
  /* Both warm-ups bind: the strategy's, so its own indicators have converged,
     and the feature set's, so the row describing the signal is real. */
  const start = Math.max(strategy.warmup, FEATURE_WARMUP);

  for (let i = start; i < bars.length; i += 1) {
    asked += 1;
    const sig = strategy.entry(ctx, i);
    if (sig === null) continue;
    /* A strategy with no target has an exit RULE instead, which the ledger
       cannot resolve — it settles stop against target and nothing else. Such a
       signal is not a labelled observation and is not one here. */
    if (sig.target === undefined || !Number.isFinite(sig.target)) continue;

    const features = matrix.featuresAt(i);
    if (features === null) {
      unfeatured += 1;
      continue;
    }

    signals.push({
      index: i,
      direction: sig.direction,
      stop: sig.stop,
      target: sig.target,
      reason: sig.reason,
      features,
    });
  }

  return { signals, matrix, unfeatured, asked };
}
