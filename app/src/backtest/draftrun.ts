/**
 * One drafted rule set, backtested for the Strategy desk's "built together" flow.
 *
 * WHY NOT `runSpecTest`
 * `spectest.ts` answers the ANALYST: it flattens every result into rounded
 * JSON a model can read, at fixed default costs. The desk needs the typed
 * objects — the trades for the simulation, the `Metrics` and the
 * `WalkForwardResult` for the critique — at the operator's OWN costs, with the
 * archive's coverage passed through so the engine can refuse a holed window.
 * So this calls the same modules the same way (`compileSpec`, `runBacktest`,
 * `computeMetrics` with bars-per-year measured from timestamps, `walkForward`
 * sized by `foldsFor`, `promote`, `byRegime`) and keeps what they return.
 * Nothing here computes a statistic of its own.
 *
 * THE ONE EXTRA RUN
 * The same rule at `COST_STRESS` times every cost. It is what lets the
 * critique say "at double your costs it stops making money" as a measurement
 * rather than a warning — see `critique.ts`.
 */

import type { BarView } from "../chart/series";
import { runBacktest, type BacktestResult, type Costs, type Trade } from "./engine";
import { barsPerYearFromSpan, computeMetrics, type Metrics } from "./metrics";
import { walkForward, type WalkForwardResult } from "./validate";
import { promote, type Promotion } from "./promote";
import { byRegime, type RegimeSlice } from "./regime";
import { compileSpec, validateSpec, type RuleSpec } from "./rules";
import { foldsFor } from "./spectest";
import { COST_STRESS } from "./critique";

export interface DraftRunOptions {
  readonly costs: Costs;
  /** Fraction of equity risked per trade. */
  readonly riskPerTrade: number;
  /** Open-hours coverage of the window, 0..1 — the engine refuses below its floor. */
  readonly coverage?: number;
  readonly containsDemo?: boolean;
}

export type DraftRun =
  | { readonly ok: false; readonly refused: string }
  | {
      readonly ok: true;
      readonly spec: RuleSpec;
      readonly bars: number;
      readonly from: number;
      readonly to: number;
      readonly barsPerYear: number;
      readonly warmup: number;
      readonly costs: Costs;
      readonly riskPerTrade: number;
      /** The whole history, in sample. */
      readonly full: BacktestResult;
      readonly trades: readonly Trade[];
      readonly metrics: Metrics;
      /** The same rule with every cost multiplied by `COST_STRESS`; null if that run was refused. */
      readonly stressed: Metrics | null;
      /**
       * Always the real object. When the window is too short for any fold its
       * `folds` is EMPTY and `verdict` says why — reported, never faked.
       */
      readonly walk: WalkForwardResult;
      /** Null when no fold ran: a gate over nothing is not a gate. */
      readonly promotion: Promotion | null;
      readonly regimes: readonly RegimeSlice[];
    };

export function stressCosts(c: Costs, k: number = COST_STRESS): Costs {
  /* EVERY TERM, INCLUDING THE CARRY. A stress test that left financing alone
     would understate exactly the rules that hold longest — the ones whose carry
     is most of their cost — so the stress would be gentlest where the real
     uncertainty is largest. */
  return {
    spread: c.spread * k,
    commission: c.commission * k,
    slippage: c.slippage * k,
    carryPerNight: c.carryPerNight * k,
  };
}

export function runDraft(spec: RuleSpec, bars: readonly BarView[], opts: DraftRunOptions): DraftRun {
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    return { ok: false, refused: `The rules are not complete: ${problems.map((p) => p.message).join(" ")}` };
  }
  const strategy = compileSpec(spec);
  if (bars.length < strategy.warmup + 30) {
    return {
      ok: false,
      refused: `${bars.length} bars available; these rules need ${strategy.warmup} before their first decision. Nothing was run — a result on a series shorter than the warm-up is not a result.`,
    };
  }

  const base = {
    costs: opts.costs,
    riskPerTrade: opts.riskPerTrade,
    ...(opts.coverage !== undefined ? { coverage: opts.coverage } : {}),
    ...(opts.containsDemo !== undefined ? { containsDemo: opts.containsDemo } : {}),
  };
  const full = runBacktest(strategy, bars, base);
  if (full.refused) return { ok: false, refused: full.refused };

  const first = (bars[0] as BarView).t;
  const last = (bars[bars.length - 1] as BarView).t;
  const bpy = barsPerYearFromSpan(bars.length, first, last);
  const metrics = computeMetrics(full.trades, full.equity, bpy > 0 ? bpy : undefined);

  const hard = runBacktest(strategy, bars, { ...base, costs: stressCosts(opts.costs) });
  const stressed = hard.refused ? null : computeMetrics(hard.trades, hard.equity, bpy > 0 ? bpy : undefined);

  const walk = walkForward([strategy], bars, { ...base, folds: foldsFor(bars.length, strategy.warmup) });

  return {
    ok: true,
    spec,
    bars: bars.length,
    from: first,
    to: last,
    barsPerYear: bpy,
    warmup: strategy.warmup,
    costs: opts.costs,
    riskPerTrade: opts.riskPerTrade,
    full,
    trades: full.trades,
    metrics,
    stressed,
    walk,
    promotion: walk.folds.length > 0 ? promote(walk) : null,
    regimes: byRegime(full.trades, bars),
  };
}
