/**
 * One rule set, put through every check the terminal owns.
 *
 * WHY THIS FILE EXISTS
 * The Playbook desk runs a rule over history and prints in-sample metrics. The
 * Strategy lab runs FAMILIES through walk-forward, Monte Carlo, the
 * random-entry test and excursions. Nothing ran a single hand-written rule set
 * through the second list — and that is exactly what the analyst needs when it
 * is asked to "build a strategy": a rule it invented is the rule most in need of
 * out-of-sample evidence, because it was chosen by something that had just read
 * the chart.
 *
 * Every number comes from an existing module, called the way its own desk calls
 * it: `computeMetrics` with bars-per-year measured from timestamps, `walkForward`
 * + `promote` for the gate, `monteCarlo` / `randomEntryTest` sized by
 * `drawsFor`, `readExcursions` for MAE/MFE. Nothing here computes a statistic
 * of its own.
 *
 * THE PBO CHECK, AND WHY IT FAILS HERE
 * `promote` treats a missing PBO as a failed check — "a check nobody ran is not
 * a check that passed". A single rule set has no selection to measure, so the
 * check cannot be run and the gate cannot promote it. That is reported as it
 * is, not waived: the rule WAS selected, by whoever wrote it, and every rule
 * set tried in the same conversation is another draw from the same bars.
 */

import type { BarView } from "../chart/series";
import { DEFAULT_COSTS, runBacktest, type Costs, type Trade } from "./engine";
import { barsPerYearFromSpan, computeMetrics, MIN_CAGR_YEARS, verdict, type Metrics } from "./metrics";
import { walkForward } from "./validate";
import { promote } from "./promote";
import { DEFAULT_RUIN, drawsFor, monteCarlo, randomEntryTest } from "./montecarlo";
import { readExcursions } from "./excursion";
import { compileSpec, groupText, type RuleSpec } from "./rules";

/** Fraction of equity risked per trade — the engine's own default, stated. */
export const SPEC_TEST_RISK = 0.01;
/** Walk-forward folds at most — `walkForward`'s default, stated. */
export const SPEC_TEST_FOLDS = 5;
/** `walkForward`'s train share; the test slice is the rest. */
const TRAIN_RATIO = 0.7;

/**
 * Folds, as many as the warm-up allows, up to five.
 *
 * MEASURED: an EMA-200 rule on 3,000 BTCUSDT 1h bars at five folds left each
 * test slice 180 bars against a 215-bar floor (warm-up + 10), so `walkForward`
 * skipped every fold and the gate reported "0 of 0 folds" — a walk-forward
 * that never ran, presented as one that failed. Fewer, longer folds give every
 * slice room for its warm-up.
 */
export function foldsFor(bars: number, warmup: number): number {
  const window = Math.ceil((warmup + 10) / (1 - TRAIN_RATIO));
  return Math.max(2, Math.min(SPEC_TEST_FOLDS, Math.floor(bars / window)));
}

const r4 = (v: number): number => (Number.isFinite(v) ? Number(v.toFixed(4)) : 0);

/** The metrics a reader needs, rounded, with units in the names. */
export function metricsView(m: Metrics, annualised: boolean): Record<string, number | string> {
  return {
    trades: m.trades,
    wins: m.wins,
    losses: m.losses,
    win_rate: r4(m.winRate),
    profit_factor: r4(m.profitFactor),
    expectancy_r: r4(m.expectancyR),
    avg_win_r: r4(m.avgWinR),
    avg_loss_r: r4(m.avgLossR),
    total_return_fraction: r4(m.totalReturn),
    max_drawdown_fraction: r4(m.maxDrawdown),
    max_consecutive_losses: m.maxConsecutiveLosses,
    avg_bars_held: r4(m.avgBarsHeld),
    exposure_fraction: r4(m.exposure),
    sharpe: r4(m.sharpe),
    sortino: r4(m.sortino),
    ...(annualised
      ? { cagr_fraction: r4(m.cagr), calmar: r4(m.calmar) }
      : { cagr_fraction: "refused", calmar: "refused" }),
    ulcer_index_fraction: r4(m.ulcerIndex),
    max_bars_under_water: m.maxTimeUnderWaterBars,
  };
}

export type SpecTest =
  | { readonly ok: false; readonly refused: string; readonly rules: Readonly<Record<string, string>> }
  | {
      readonly ok: true;
      readonly rules: Readonly<Record<string, string>>;
      readonly data: {
        readonly symbol: string;
        readonly timeframe: string;
        readonly source: string;
        readonly bars: number;
        readonly from: string;
        readonly to: string;
        readonly bars_per_year: number;
      };
      readonly costs: Readonly<Record<string, number | string>>;
      readonly in_sample: {
        readonly basis: string;
        readonly metrics: Record<string, number | string>;
        readonly verdict: string;
        readonly rating: string;
        readonly warnings: readonly string[];
      };
      readonly walk_forward: {
        readonly basis: string;
        readonly folds: readonly { index: number; oos_trades: number; oos_expectancy_r: number; is_expectancy_r: number }[];
        readonly out_of_sample: Record<string, number | string>;
        readonly retention: number;
        readonly verdict: string;
        readonly warnings: readonly string[];
      };
      readonly gate: {
        readonly promoted: boolean;
        readonly summary: string;
        readonly checks: readonly { id: string; passed: boolean; text: string }[];
        readonly note: string;
      };
      readonly monte_carlo: Record<string, unknown>;
      readonly random_entry: Record<string, unknown>;
      readonly excursion: Record<string, unknown>;
      readonly selection_warning: string;
    };

function renderRules(spec: RuleSpec): Record<string, string> {
  const s = compileSpec(spec);
  return {
    name: spec.name,
    entry: s.rules.entry,
    stop: s.rules.stop,
    exit: s.rules.exit,
    ...(spec.exitShort ? { exit_short: `exit rule: ${groupText(spec.exitShort)}` } : {}),
    warmup_bars: String(s.warmup),
    ...(spec.note ? { note: spec.note } : {}),
  };
}

const iso = (t: number | undefined): string => (t === undefined ? "" : new Date(t).toISOString());

export function runSpecTest(
  spec: RuleSpec,
  bars: readonly BarView[],
  opts: {
    readonly containsDemo?: boolean;
    readonly symbol?: string;
    readonly timeframe?: string;
    readonly source?: string;
    /**
     * What to charge. Defaults to `DEFAULT_COSTS`, exactly as before.
     *
     * THIS FUNCTION DECIDES WHAT GETS PROMOTED, so the hurdle is the most
     * consequential input it takes — a flat 2bp spread is 4.8x this operator's
     * real cost on gold, and overcharging a promotion test rejects rules that
     * would have cleared the spread actually paid. It is NOT switched to a
     * measured figure here: a hurdle that moved because a service answered
     * would change what is promoted with no press behind it. The caller says,
     * and the result already states which model was charged.
     */
    readonly costs?: Costs;
  } = {},
): SpecTest {
  const strategy = compileSpec(spec);
  const rules = renderRules(spec);
  if (bars.length < strategy.warmup + 30) {
    return {
      ok: false,
      rules,
      refused: `${bars.length} bars available; this rule needs ${strategy.warmup} before its first decision. Nothing was run — a result on a series shorter than the warm-up is not a result.`,
    };
  }

  const costs = opts.costs ?? DEFAULT_COSTS;
  const base = {
    costs,
    riskPerTrade: SPEC_TEST_RISK,
    ...(opts.containsDemo !== undefined ? { containsDemo: opts.containsDemo } : {}),
  };
  const full = runBacktest(strategy, bars, base);
  if (full.refused) return { ok: false, rules, refused: full.refused };

  const first = bars[0] as BarView;
  const last = bars[bars.length - 1] as BarView;
  const bpy = barsPerYearFromSpan(bars.length, first.t, last.t);
  const years = bpy > 0 ? (bars.length - 1) / bpy : 0;
  const m = computeMetrics(full.trades, full.equity, bpy > 0 ? bpy : undefined);
  const v = verdict(m);

  const folds = foldsFor(bars.length, strategy.warmup);
  const wf = walkForward([strategy], bars, { ...base, folds, trainRatio: TRAIN_RATIO });
  const promotion = promote(wf);
  const nonPbo = promotion.checks.filter((c) => c.id !== "pbo");
  const allElse = nonPbo.every((c) => c.passed);

  const trades: readonly Trade[] = full.trades;
  const draws = drawsFor(trades.length);
  const mc = monteCarlo(
    trades.map((t) => t.rMultiple),
    SPEC_TEST_RISK,
    { draws, ruinDrawdown: DEFAULT_RUIN },
  );
  /* THE SAME MODEL THE RULE WAS CHARGED. A random-entry benchmark priced
     differently from the rule it is a benchmark FOR compares two games — the
     defect this project records as "a ledger must price the way the engine
     prices", arriving in the one place whose whole job is a fair comparison. */
  const re = randomEntryTest(bars, trades, costs, { draws });
  const ex = readExcursions(trades);

  return {
    ok: true,
    rules,
    data: {
      symbol: opts.symbol ?? "",
      timeframe: opts.timeframe ?? "",
      source: opts.source ?? "",
      bars: bars.length,
      from: iso(first.t),
      to: iso(last.t),
      bars_per_year: r4(bpy),
    },
    costs: {
      spread_fraction: costs.spread,
      commission_fraction_per_side: costs.commission,
      slippage_fraction: costs.slippage,
      risk_per_trade_fraction: SPEC_TEST_RISK,
    },
    in_sample: {
      basis: "measured on the whole history, IN-SAMPLE — the rule was written after seeing this chart",
      metrics: metricsView(m, years >= MIN_CAGR_YEARS),
      rating: v.rating,
      verdict: v.why,
      warnings: full.warnings,
    },
    walk_forward: {
      basis: `measured OUT-OF-SAMPLE: ${folds} rolling folds, 70% train / 30% test each, pooled test trades`,
      folds: wf.folds.map((f) => ({
        index: f.index,
        oos_trades: f.outOfSample.trades,
        oos_expectancy_r: r4(f.outOfSample.expectancyR),
        is_expectancy_r: r4(f.inSample.expectancyR),
      })),
      out_of_sample: metricsView(wf.aggregate, false),
      retention: r4(wf.degradation),
      verdict: wf.verdict,
      warnings: wf.warnings,
    },
    gate: {
      promoted: promotion.promoted,
      summary: promotion.summary,
      checks: promotion.checks.map((c) => ({ id: c.id, passed: c.passed, text: c.text })),
      note: allElse
        ? "Every check except PBO passed. PBO measures a selection across a set of candidates and cannot be run on one rule set, so the gate does not promote it — treat this as a candidate for the Strategy lab, not a finding."
        : "The out-of-sample gate failed on the checks above. Report it as failing.",
    },
    monte_carlo:
      mc.refused !== null
        ? { refused: mc.refused, basis: "modelled" }
        : {
            basis: "modelled: bootstrap resampling of the measured trade R-multiples, trades assumed independent",
            mode: mc.mode,
            draws: mc.draws,
            trades: mc.trades,
            risk_per_trade_fraction: mc.riskPerTrade,
            max_drawdown_fraction: { p5: r4(mc.maxDrawdown.p5), p50: r4(mc.maxDrawdown.p50), p95: r4(mc.maxDrawdown.p95) },
            final_return_fraction: { p5: r4(mc.finalReturn.p5), p50: r4(mc.finalReturn.p50), p95: r4(mc.finalReturn.p95) },
            losing_streak_trades: { p5: mc.losingStreak.p5, p50: mc.losingStreak.p50, p95: mc.losingStreak.p95 },
            ruin_drawdown_fraction: mc.ruinDrawdown,
            ruin_probability: r4(mc.ruinProbability),
          },
    random_entry:
      re.refused !== null
        ? { refused: re.refused }
        : {
            basis: "measured: random entries with the same holding times and directions, same costs",
            draws: re.draws,
            p_value: r4(re.p),
            beaten_share: r4(re.beatenShare),
            observed_mean_return_fraction: r4(re.observedMean),
            null_mean_return_fraction: r4(re.nullMean),
            null_p5: r4(re.nullP5),
            null_p95: r4(re.nullP95),
            note: "One-sided. Trades are treated as independent, so a borderline p-value is weaker than it reads.",
          },
    excursion:
      ex.refused !== null
        ? { refused: ex.refused }
        : {
            basis: "measured, in R, gross of costs",
            winners: ex.winners,
            losers: ex.losers,
            winner_mae_p50_r: r4(ex.winnerMaeP50),
            winner_mae_p90_r: r4(ex.winnerMaeP90),
            loser_mfe_p50_r: r4(ex.loserMfeP50),
            losers_once_up_1r_fraction: r4(ex.losersOnceUp1R),
            capture_p50: ex.captureP50 === null ? null : r4(ex.captureP50),
            target_winners: ex.targetWinners,
          },
    selection_warning:
      "Every rule set tried in this conversation was chosen after seeing these bars. Trying several and reporting the best is the selection the PBO check exists to measure — say how many were tried.",
  };
}
