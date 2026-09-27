/**
 * Running a study: the engines, aimed.
 *
 * WHAT IS NEW HERE AND WHAT IS NOT
 * Almost nothing in this file computes anything. The sweep is
 * `backtest/lab.ts`, the walk-forward and the CSCV are `backtest/validate.ts`,
 * the regime labels are `backtest/regime.ts`, the volatility model and the
 * calibrated classifier are the quant service, the join is `data/panel.ts`.
 * Every one of those already worked and every one of them was on a different
 * desk, asked a different question, against a different set of bars.
 *
 * What is new is three things, and they are the reason the study exists:
 *
 *   ONE WINDOW. Every step here runs on the same aligned rows, chosen once by
 *   `jointWindow`. Two desks reporting different numbers for the same symbol
 *   because one fetched 800 bars and the other 5,000 is not a disagreement
 *   worth having.
 *
 *   ONE COUNT. Every step declares how many hypotheses it tested, they are
 *   summed, and the total deflates the headline. A terminal that spreads these
 *   across six desks cannot do this, because no desk knows what the others
 *   tried.
 *
 *   ONE SEALED SEGMENT. The holdout is cut before anything looks at anything
 *   and is not touched by this function at all. `openHoldout` is a separate,
 *   deliberate act — see the bottom of this file.
 *
 * A REFUSAL IS A RESULT
 * Every step returns `ok`, `refused` or `offline`, and all three are recorded
 * and shown. A study where nine steps ran and two refused is a study with
 * eleven findings, two of which are about the archive.
 */

import type { BarView } from "../chart/series";
import type { BrokerSpec } from "../data/brokercosts";
import { buildPanel, type Panel } from "../data/panel";
import { type QuantHealth } from "../data/quant";
import { classifyRegimes, type Regime } from "../backtest/regime";
import { benjaminiHochberg, FDR } from "../backtest/resample";
import { runStudy, type Family, type Study as LabStudy } from "../backtest/lab";
import {
  panelRoleOf,
  type StudySpec
} from "./spec";
import {
  jointWindow,
  parameterBudget,
  splitWindow,
  YEAR_MS,
  type JointWindow,
  type ParameterBudget,
  type SeriesSpan,
  type Split
} from "./window";
import { type MethodContext, type MethodGroup } from "./methods";
import { buildPlan, recordTiming, type Plan, type PlanStep, type Timings } from "./plan";
import { deflatedSharpe, meanOf, stdevOf, type DeflatedSharpe } from "./stats";

export interface StepResult {
  readonly methodId: string;
  readonly label: string;
  readonly group: MethodGroup;
  readonly tests: number;
  readonly outcome: Outcome;
}

export interface CorrectionOutcome {
  readonly hypotheses: number;
  readonly claims: readonly {
    readonly label: string;
    readonly p: number;
    /** Benjamini–Hochberg adjusted. Read directly as a false-discovery rate. */
    readonly q: number;
    readonly survives: boolean;
  }[];
  readonly survivors: number;
  readonly sharpe: DeflatedSharpe | null;
  /** What the deflated figure IS, in units. Never shown without it. */
  readonly sharpeBasis: string;
  /** Why no figure could be deflated, or null. */
  readonly sharpeRefusal: string | null;
  readonly rulesBefore: number;
  readonly rulesAfter: number;
  readonly pbo: number | null;
  readonly text: string;
}

export interface StudyReport {
  readonly specId: string;
  readonly name: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly at: number;
  readonly ms: number;
  readonly window: JointWindow;
  readonly split: Split;
  readonly budget: ParameterBudget;
  readonly rows: number;
  readonly panelWarnings: readonly string[];
  readonly steps: readonly StepResult[];
  readonly hypotheses: number;
  readonly correction: CorrectionOutcome;
  readonly headline: string;
  /** The box at the bottom. Derived from what actually happened, never fixed. */
  readonly limits: readonly string[];
  /** Why the whole run produced nothing, or null. */
  readonly refusal: string | null;
  readonly timings: Timings;
  /** Whether the sealed segment has been opened for this report. */
  readonly holdout: "sealed" | "opened";
}

export interface RunOptions {
  /**
   * The broker's contract specs, when any have been synced.
   *
   * Only `costs: "measured"` reads them, and only for the SPREAD. Optional
   * because an account that has never synced has none, and a study must run
   * without one.
   */
  readonly brokerSpecs?: Readonly<Record<string, BrokerSpec>>;
  readonly spec: StudySpec;
  readonly subject: LoadedSeries;
  readonly context: readonly LoadedSeries[];
  readonly health: QuantHealth | null;
  readonly timings?: Timings;
  readonly now?: number;
  readonly signal?: AbortSignal;
  onStep?(step: PlanStep, phase: "start" | "done"): void;
  /**
   * Hand the thread back between steps.
   *
   * A sweep over twenty thousand bars is CPU-bound and synchronous; without a
   * yield the tab stops answering for the length of the run and the progress
   * the desk is carefully rendering is never painted. Injectable so tests do
   * not spend a timer per step.
   */
  yieldTo?(): Promise<void>;
}

const defaultYield = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });


export function spanOf(s: LoadedSeries): SeriesSpan {
  const first = s.bars[0];
  const last = s.bars[s.bars.length - 1];
  return {
    symbol: s.symbol,
    label: s.label,
    role: s.role,
    bars: s.bars.length,
    first: first?.t ?? 0,
    last: last?.t ?? 0,
    gaps: s.gaps,
    coverage: s.coverage
  };
}

/** The window the spec asked for, in wall-clock terms. */
export function requestedRange(spec: StudySpec, now: number): { from: number; to: number } {
  if (spec.years === "max") return { from: 0, to: now };
  return { from: now - spec.years * YEAR_MS, to: now };
}

/**
 * Trades below which the selected rule's Sharpe is not deflated at all.
 *
 * Thirty, the same floor `backtest/lab.ts` uses for an out-of-sample verdict
 * and `montecarlo.ts` for a reshuffle, for the same reason: below it the
 * standard error on the estimate is wider than the correction, so the
 * corrected figure carries no more information than the raw one and reads as
 * though it does.
 */
export const MIN_DEFLATION_TRADES = 30;

/* What moved to `steps.ts`, re-exported so no caller had to change.
   `LoadedSeries` and `Outcome` are part of this module's published surface —
   `ui/study/state.ts` and the report view both import them from here — and a
   split that forces every consumer to learn a new path is a split that gets
   reverted. */
import { clipBars, clock, runOne, type LoadedSeries, type Outcome } from "./steps";
export type { LoadedSeries, Outcome } from "./steps";
export { clipBars } from "./steps";

/* ── the run ───────────────────────────────────────────────────────────── */

export async function runStudySpec(opts: RunOptions): Promise<StudyReport> {
  const started = clock();
  const now = opts.now ?? Date.now();
  const spec = opts.spec;
  const yieldTo = opts.yieldTo ?? defaultYield;

  const requested = requestedRange(spec, now);
  const featureSeries = opts.context.filter((c) => panelRoleOf(c.role) !== null);
  const regimeSeries = opts.context.filter((c) => c.role === "regime");

  const win = jointWindow(
    spanOf(opts.subject),
    featureSeries.map(spanOf),
    requested.from,
    requested.to,
  );

  const empty = (refusal: string, window = win): StudyReport => ({
    specId: spec.id,
    name: spec.name,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    at: now,
    ms: clock() - started,
    window,
    split: splitWindow(0, spec.horizon),
    budget: parameterBudget(0, spec.horizon),
    rows: 0,
    panelWarnings: [],
    steps: [],
    hypotheses: 0,
    correction: {
      hypotheses: 0,
      claims: [],
      survivors: 0,
      sharpe: null,
      sharpeBasis: "",
      sharpeRefusal: null,
      rulesBefore: 0,
      rulesAfter: 0,
      pbo: null,
      text: "Nothing ran, so there is nothing to correct."
    },
    headline: "This study could not be run.",
    limits: [],
    refusal,
    timings: opts.timings ?? {},
    holdout: "sealed"
  });

  if (win.refusal !== null) return empty(win.refusal);

  const subjectBars = clipBars(opts.subject.bars, win.from, win.to);
  const panel: Panel = buildPanel({
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    target: subjectBars,
    drivers: featureSeries.map((c) => ({
      symbol: c.symbol,
      label: c.label,
      role: panelRoleOf(c.role) ?? "context",
      bars: clipBars(c.bars, win.from, win.to)
    })),
    horizon: spec.horizon
  });

  const rows = panel.rows.length;
  const split = splitWindow(rows, spec.horizon);
  const budget = parameterBudget(split.train.bars, spec.horizon);

  const ctx: MethodContext = {
    /* True by construction: the runner is past the fetch, past the joint
       window and past the panel build. Anything blocked from here on is
       blocked by a measurement, not by an absence of one. */
    checked: true,
    rows,
    featureColumns: featureSeries.length,
    driverColumns: opts.context.filter((c) => c.role === "driver").length,
    sliceSeries: regimeSeries.length,
    health: opts.health
  };
  const plan: Plan = buildPlan(spec.methods, ctx, opts.timings ?? {});

  if (plan.refusal !== null) return empty(plan.refusal);

  /* The regime label per row, keyed by timestamp.
     BY TIMESTAMP AND NOT BY INDEX. `buildPanel` drops a row whose driver was
     stale beyond tolerance, so row `i` is not bar `i + 1` and an index join
     here would silently label every row after the first gap with a condition
     belonging to a different bar. */
  const regimeAt = new Map<number, Regime>();
  if (subjectBars.length > 0) {
    const labels = classifyRegimes(subjectBars);
    for (let i = 0; i < subjectBars.length; i += 1) {
      const bar = subjectBars[i];
      const label = labels[i];
      if (bar !== undefined && label !== undefined) regimeAt.set(bar.t, label);
    }
  }
  const rowRegimes: (Regime | null)[] = panel.rows.map((r) => regimeAt.get(r.t) ?? null);

  /* Training-only bars, for anything that fits. The holdout is not in here and
     never enters this function. */
  const trainBars = subjectBars.slice(0, Math.max(0, split.train.to + 1));

  const steps: StepResult[] = [];
  let timings = opts.timings ?? {};
  /* The best sweep seen, for the steps that read one and for the deflation. */
  const carry: { best: LabStudy | null } = { best: null };

  for (const step of plan.steps) {
    if (opts.signal?.aborted === true) break;
    opts.onStep?.(step, "start");
    await yieldTo();

    const t0 = clock();
    let outcome: Outcome;
    try {
      outcome = await runOne(step.method.id, {
        spec,
        panel,
        rows,
        subjectBars,
        trainBars,
        featureSeries,
        rowRegimes,
        split,
        win,
        carry,
        /* THE BROKER'S SPECS, so `costs: "measured"` has something to measure.
           Without this the option falls back to the assumption every time and
           the control is a button that does nothing — the defect this session
           has now caught three times before shipping. Absent is normal: an
           account that has never synced has no specs, and the fallback says so
           by charging the assumption. */
        ...(opts.brokerSpecs !== undefined ? { brokerSpecs: opts.brokerSpecs } : {}),
        tests: step.tests,
        hypotheses: plan.hypotheses
      });
    } catch (err) {
      outcome = {
        state: "offline",
        reason: `This step stopped with an error: ${String(err).slice(0, 160)}. The rest of the study continued.`
      };
    }
    const ms = clock() - t0;
    if (outcome.state === "ok") timings = recordTiming(timings, step.method.id, rows, ms);

    steps.push({
      methodId: step.method.id,
      label: step.method.label,
      group: step.method.group,
      tests: step.tests,
      outcome
    });
    opts.onStep?.(step, "done");
  }

  const correction = correct(steps, plan.hypotheses, carry.best, split);

  return {
    specId: spec.id,
    name: spec.name,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    at: now,
    ms: clock() - started,
    window: win,
    split,
    budget,
    rows,
    panelWarnings: panel.warnings,
    steps,
    hypotheses: plan.hypotheses,
    correction,
    headline: headlineOf(steps, correction, spec),
    limits: limitsOf(spec, win, panel, steps, opts.context),
    refusal: null,
    timings,
    holdout: "sealed"
  };
}

/* ── the correction ────────────────────────────────────────────────────── */

export function correct(
  steps: readonly StepResult[],
  hypotheses: number,
  bestLab: LabStudy | null,
  split: Split,
): CorrectionOutcome {
  const raw: { label: string; p: number }[] = [];
  for (const s of steps) {
    if (s.outcome.state !== "ok") continue;
    for (const p of s.outcome.pValues) {
      if (Number.isFinite(p.p)) raw.push({ label: `${s.label}: ${p.label}`, p: p.p });
    }
  }
  const qs = benjaminiHochberg(raw.map((r) => r.p));
  const claims = raw.map((r, i) => {
    const q = qs[i] ?? 1;
    return { label: r.label, p: r.p, q, survives: q <= FDR };
  });
  const survivors = claims.filter((c) => c.survives).length;

  /*
   * WHAT IS DEFLATED, AND WHY IT IS NOT THE NUMBER ON THE STRATEGY CARD.
   *
   * The engine's `sharpe` is ANNUALISED — `metrics.ts` multiplies the per-bar
   * ratio by sqrt(barsPerYear). The standard error this deflation uses,
   * sqrt((1 + S²/2) / n), is the standard error of a PER-OBSERVATION Sharpe.
   * Feeding one into the other mixes three incompatible quantities: a figure
   * scaled by sqrt(8760), a trade count, and a formula expecting neither.
   * MEASURED on a live BTCUSDT study: an annualised 4.93 over 77 trades was
   * deflated by 0.85 — a correction that looked like it had happened.
   *
   * So the quantity deflated here is the SELECTED RULE'S PER-TRADE SHARPE:
   * mean(R) / sd(R) over its own trades, with n equal to that trade count.
   * Every term is then in the same units, which is the only way the hurdle
   * means anything.
   *
   * IN-SAMPLE, DELIBERATELY. The deflated Sharpe ratio corrects a figure for
   * the number of configurations the search tried, and the search happened on
   * the training slice. Deflating the walk-forward figure instead would be
   * correcting the wrong number for the wrong reason — the walk-forward's own
   * protection against selection is the purged folds and the PBO beside it.
   */
  const rs = (bestLab?.bestRun?.trades ?? [])
    .map((t) => t.rMultiple)
    .filter((r) => Number.isFinite(r));
  const sd = stdevOf(rs);
  const perTrade = Number.isFinite(sd) && sd > 0 ? meanOf(rs) / sd : NaN;

  let sharpe: DeflatedSharpe | null = null;
  let sharpeRefusal: string | null = null;
  if (bestLab === null) {
    sharpeRefusal = null;
  } else if (rs.length < MIN_DEFLATION_TRADES) {
    sharpeRefusal = `The winning rule took ${rs.length} trades. Below ${MIN_DEFLATION_TRADES} the standard error on a Sharpe is wider than the correction being applied, so deflating it would produce a number with no content.`;
  } else if (!Number.isFinite(perTrade)) {
    sharpeRefusal = "The winning rule's trades have no spread in them, so a Sharpe cannot be formed at all.";
  } else {
    sharpe = deflatedSharpe(perTrade, Math.max(1, hypotheses), rs.length);
  }

  const rulesBefore = bestLab?.configs.length ?? 0;
  const rulesAfter = bestLab === null ? 0 : bestLab.configs.filter((c) => c.refused === null && c.metrics.trades > 0 && c.score > 0).length;

  const parts: string[] = [];
  if (claims.length === 0) {
    parts.push("No step in this study produced a p-value, so there is nothing for Benjamini–Hochberg to adjust.");
  } else {
    parts.push(
      `${claims.length} claim${claims.length === 1 ? "" : "s"} carried a p-value. After adjusting for the ${hypotheses.toLocaleString()} hypotheses this study tested, ${survivors} still ${survivors === 1 ? "clears" : "clear"} a ${Math.round(FDR * 100)}% false-discovery rate.`,
    );
  }
  if (sharpe !== null) {
    parts.push(
      `The best rule's per-trade Sharpe of ${sharpe.observed.toFixed(2)} becomes ${sharpe.deflated.toFixed(2)} once being the best of ${sharpe.tries.toLocaleString()} tries is priced in.`,
    );
  } else if (sharpeRefusal !== null) {
    parts.push(sharpeRefusal);
  }
  if (split.holdout.bars > 0) {
    parts.push(
      `The holdout — ${split.holdout.bars.toLocaleString()} bars at the end — has not been touched by any of this.`,
    );
  }

  return {
    hypotheses,
    claims,
    survivors,
    sharpe,
    sharpeBasis: "Per-trade Sharpe — mean R over the standard deviation of R, on the selected rule's own trades. Not the annualised figure on the strategy card.",
    sharpeRefusal,
    rulesBefore,
    rulesAfter,
    pbo: bestLab?.overfit.pbo ?? null,
    text: parts.join(" ")
  };
}

function headlineOf(
  steps: readonly StepResult[],
  correction: CorrectionOutcome,
  spec: StudySpec,
): string {
  const ran = steps.filter((s) => s.outcome.state === "ok");
  if (ran.length === 0) {
    return `Nothing in this study could be run against ${spec.symbol}. Every step's reason is beside it.`;
  }
  const surviving = correction.claims.filter((c) => c.survives);
  const top = surviving[0];
  if (top !== undefined) {
    const owner = ran.find((s) => top.label.startsWith(s.label));
    if (owner !== undefined && owner.outcome.state === "ok") return owner.outcome.headline;
  }
  /*
   * A NULL RESULT IS THE HEADLINE WHEN IT IS THE FINDING.
   *
   * Falling through to `ran[0]` put "All three conditions are represented in
   * this window" at the top of a report whose selected rule deflated to
   * BELOW ZERO — the strongest statement the study made, buried in a side
   * panel, under the blandest one. The order below is the order of how much
   * the sentence is worth knowing.
   */
  const s = correction.sharpe;
  if (s !== null && s.deflated <= 0) {
    return `The best of ${s.tries.toLocaleString()} rules tried is not distinguishable from the best of ${s.tries.toLocaleString()} coin flips.`;
  }
  if (correction.claims.length > 0) {
    return `Nothing in this study survives the correction for having tested ${correction.hypotheses.toLocaleString()} hypotheses. That is the finding.`;
  }
  if (s !== null) {
    return `The best rule of ${s.tries.toLocaleString()} tried keeps a per-trade Sharpe of ${s.deflated.toFixed(2)} after the search is priced in.`;
  }
  const first = ran[0];
  return first !== undefined && first.outcome.state === "ok"
    ? first.outcome.headline
    : `${ran.length} steps ran and none of them produced a testable claim.`;
}

/**
 * What this study does not establish.
 *
 * Derived from what actually happened, never a fixed paragraph. A boilerplate
 * disclaimer is read once and then never again; a line that says "22% of your
 * rows had no dollar reading on them" is about this study and gets read.
 */
export function limitsOf(
  spec: StudySpec,
  win: JointWindow,
  panel: Panel,
  steps: readonly StepResult[],
  context: readonly LoadedSeries[],
): string[] {
  const out: string[] = [];

  out.push(
    "Nothing here establishes causation. Every figure is an association measured over one window; a series that led another for two years can stop for reasons no correlation can see.",
  );

  if (win.shortfall !== null) {
    out.push(
      `The window is ${win.limitedBy[0]?.label ?? "shorter than requested"}-limited, not the one that was asked for. A different window is a different study and may not agree with this one.`,
    );
  }

  if (panel.coverage < 1 && panel.columns.length > 0) {
    out.push(
      `${Math.round((1 - panel.coverage) * 100)}% of driver cells were carried forward or absent rather than observed — mostly where the series you added keeps different hours from ${spec.symbol}.`,
    );
  }

  const refused = steps.filter((s) => s.outcome.state === "refused").length;
  const offline = steps.filter((s) => s.outcome.state === "offline").length;
  if (refused > 0) out.push(`${refused} step${refused === 1 ? "" : "s"} declined to answer on this data. Those questions are open, not answered in the negative.`);
  if (offline > 0) out.push(`${offline} step${offline === 1 ? "" : "s"} could not run because the service was unavailable. Those are missing, not negative.`);

  const gapped = context.filter((c) => c.gaps.length > 0);
  if (gapped.length > 0) {
    out.push(
      `${gapped.map((g) => g.label).join(", ")} ${gapped.length === 1 ? "has" : "have"} gaps inside the window. Rows in those gaps were dropped rather than filled, so the study is thinner in those periods than the bar count suggests.`,
    );
  }

  out.push(
    `A relationship at a ${spec.horizon}-bar horizon is not a strategy. It is a filter a strategy might use, and the costs of acting on it are not in any figure above unless a strategy step ran.`,
  );

  return out;
}

/* ── the sealed segment ────────────────────────────────────────────────── */

export interface HoldoutResult {
  readonly bars: number;
  readonly metrics: { readonly sharpe: number; readonly trades: number; readonly expectancyR: number } | null;
  readonly refusal: string | null;
  readonly note: string;
}

/**
 * Open the holdout. Once.
 *
 * Deliberately not part of `runStudySpec`, deliberately requires the caller to
 * say so, and deliberately returns a note saying that the segment is now
 * spent. A holdout looked at twice is a validation set with a grander name:
 * the second look is conditioned on the first, and whatever was changed in
 * between was changed because of what it showed.
 *
 * The desk does not offer this until a study has been re-run at least once
 * without changing the spec, which is the behavioural version of the same
 * rule.
 */
export function openHoldout(
  bars: readonly BarView[],
  split: Split,
  family: Family,
): HoldoutResult {
  const segment = bars.slice(split.holdout.from, split.holdout.to);
  if (segment.length < 200) {
    return {
      bars: segment.length,
      metrics: null,
      refusal: `The holdout holds ${segment.length} bars. Below about 200 the out-of-sample figure has a standard error wider than any difference worth acting on, so opening it would spend the segment for nothing.`,
      note: "The holdout is still sealed."
    };
  }
  const study = runStudy(family, segment);
  if (study.best === null) {
    return {
      bars: segment.length,
      metrics: null,
      refusal: study.headline.why,
      note: "The holdout has now been opened. Anything measured against it from here is in-sample."
    };
  }
  const m = study.walk.aggregate;
  return {
    bars: segment.length,
    metrics: { sharpe: m.sharpe, trades: m.trades, expectancyR: m.expectancyR },
    refusal: null,
    note: "The holdout has now been opened. Anything measured against it from here is in-sample, including a re-run of this same study."
  };
}
