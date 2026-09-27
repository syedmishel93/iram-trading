/**
 * The strategy lab: one run, three verdicts, no way to see only the flattering one.
 *
 * WHY THIS FILE EXISTS AT ALL
 * Every retail platform ships a strategy tester that answers one question —
 * "what would this have made?" — and none of them answer the question that
 * decides whether the first answer means anything: "given how many variants I
 * tried, how likely is it that the winner is just the luckiest?"
 *
 * That second question has a published answer (PBO via CSCV; see validate.ts),
 * it is cheap to compute, and leaving it out is what turns a backtest into a
 * sales pitch. So the lab does not offer validation as an extra tab you can
 * skip. A study ALWAYS sweeps a grid, ALWAYS walks forward, ALWAYS computes
 * PBO, and always returns a headline that leads with what survived rather than
 * with the return.
 *
 * THE HEADLINE IS THE PRODUCT
 * `Study.headline` is deliberately computed here and not in the UI, so it
 * cannot be quietly dropped by a redesign. A curve with no headline is not a
 * result, it is a decoration.
 *
 * A NOTE ON SAMPLE SIZE, LEARNED THE HARD WAY
 * On real BTC data this engine once reported walk-forward "233% of in-sample
 * expectancy retained" while PBO said 89% — a flat contradiction. The
 * walk-forward number rested on 22 out-of-sample trades. Twenty-two trades
 * cannot support any conclusion, so the sample gate below outranks a good
 * degradation figure rather than averaging with it.
 */

import type { BarView } from "../chart/series";
import { runBacktest, ZERO_COSTS, type BacktestOptions, type BacktestResult } from "./engine";
import { computeMetrics, type Metrics } from "./metrics";
import { promote, type Promotion } from "./promote";
import { byRegime, type RegimeSlice } from "./regime";
import {
  compileSpec,
  parseOperand,
  validateSpec,
  COLUMNS,
  type ColumnId,
  type Condition,
  type ConditionGroup,
  type RuleSpec,
} from "./rules";
import {
  confluenceStrategy,
  emaTrend,
  rsiReversion,
  type DocumentedStrategy,
  type RuleDoc,
} from "./strategies";
import {
  defaultScore,
  equityToReturns,
  pbo,
  walkForward,
  type PboResult,
  type WalkForwardResult,
} from "./validate";

export type Family = "ema" | "rsi" | "confluence";

/**
 * WHAT a study studied.
 *
 * Replaced the bare `family: Family` field in v60, when the lab stopped being
 * able to study only the three hand-written families. A study has always had
 * to say what it was about; the question was only whether the answer could be
 * a `RuleSpec`, and a three-value union said no by construction.
 *
 * The spec TRAVELS WITH THE STUDY rather than being referenced by id. A study
 * of `ema-9-21-cross` is a study of the rule as it was WHEN IT RAN, and the
 * whole point of `rules.ts` is that a spec is editable at runtime — an id
 * would name whatever the rule happens to be by the time anyone reads the
 * result back.
 */
export type StudySubject =
  | { readonly kind: "family"; readonly id: Family }
  | { readonly kind: "spec"; readonly id: string; readonly spec: RuleSpec };

/** One line naming the subject, for a label or a log. */
export function subjectLabel(subject: StudySubject): string {
  if (subject.kind === "family") {
    return FAMILIES.find((f) => f.id === subject.id)?.label ?? subject.id;
  }
  return subject.spec.name;
}

export const FAMILIES: readonly { id: Family; label: string; blurb: string }[] = [
  {
    id: "ema",
    label: "EMA trend",
    blurb: "The plainest trend system, included as the baseline everything else has to beat",
  },
  {
    id: "rsi",
    label: "RSI reversion",
    blurb: "Counter-trend entries filtered by the 200 EMA",
  },
  {
    id: "confluence",
    label: "Confluence engine",
    blurb: "The terminal's own glass-box score, tested like any other rule",
  },
];

/**
 * The parameter sweep for a family.
 *
 * Kept deliberately modest. A larger grid does not find a better strategy, it
 * finds a luckier one — and PBO will say so, which is the point, but there is
 * no reason to spend the compute proving it every run.
 */
export function familyGrid(family: Family): DocumentedStrategy[] {
  switch (family) {
    case "ema": {
      const out: DocumentedStrategy[] = [];
      for (const [fast, slow] of [
        [10, 30],
        [20, 50],
        [20, 100],
        [50, 200],
      ] as const) {
        for (const rr of [1.5, 2, 3]) out.push(emaTrend(fast, slow, 2, rr));
      }
      return out;
    }
    case "rsi": {
      const out: DocumentedStrategy[] = [];
      for (const low of [20, 25, 30, 35]) {
        for (const rr of [1.5, 2, 3]) out.push(rsiReversion(14, low, 100 - low, 2, rr));
      }
      return out;
    }
    case "confluence": {
      const out: DocumentedStrategy[] = [];
      for (const minScore of [0.25, 0.35, 0.45]) {
        for (const rr of [1.5, 2, 3]) out.push(confluenceStrategy(minScore, 0.4, 2, rr));
      }
      return out;
    }
  }
}

/* ------------------------------------------------------- the spec sweep --- */

/**
 * THE CAP, AND WHAT IT ACTUALLY REFUSES.
 *
 * Twelve, because twelve is the largest FAMILY grid (`ema`: four EMA pairs ×
 * three reward-to-risk values). A spec study and a family study have to be
 * comparable — the same walk-forward, the same CSCV, and PBO measured over a
 * selection of the same size, because PBO is only meaningful relative to how
 * many variants were tried.
 *
 * Each axis contributes three values, so the reachable grid sizes are 1, 3 and
 * 9. The cap therefore never trims VALUES; what it refuses is a THIRD AXIS —
 * 3 × 3 × 3 = 27, more than twice any family grid. A held axis is named in
 * `SpecGrid.held` and lands in `Study.warnings`, because a sweep that quietly
 * did not try something is a sweep that overstates what it ruled out.
 */
export const SPEC_GRID_CAP = 12;

/**
 * How a RATIO moves: three-quarters, as written, and half again.
 *
 * A stop of `2 × ATR` and a target of `2 × the risk` are both multiples, so
 * they vary multiplicatively. On the shipped specs this lands exactly on the
 * family grid's own reward-to-risk values — `2` becomes `1.5, 2, 3` — which is
 * not a coincidence worth hiding: the two sweeps are meant to be read side by
 * side.
 */
export const SPEC_RATIOS: readonly number[] = [0.75, 1, 1.5];

/**
 * How a bounded oscillator THRESHOLD moves: five points either way.
 *
 * Units, again — the rule that the deflated-Sharpe defect was about. `ADX > 25`
 * is a POINT on a 0-100 scale, not a multiple of anything, so scaling it by 1.5
 * would give `37.5` and scaling `RSI > 70` would give `105`: a condition that
 * can never be true, contributing a config that never trades and reads as a
 * variant. Five points gives `20, 25, 30` — the same shape as the family RSI
 * grid's `20, 25, 30, 35`.
 */
export const SPEC_THRESHOLD_STEP = 5;

/**
 * The only columns whose numeric operands are safe to nudge.
 *
 * A threshold can only be varied if the varied value is still a value the
 * column can take, and this vocabulary does not carry a column's range — so
 * the range is named here, for the six columns that HAVE a published fixed one,
 * and every other numeric operand is left exactly as written. `close > 100`,
 * `ROC > 0` and `MACD histogram > 0` are all outside this list on purpose:
 * the first is an instrument-specific price, and the other two are zero, which
 * has no neighbours that mean the same thing.
 */
const BOUNDED_COLUMNS: Partial<Record<ColumnId, readonly [number, number]>> = {
  rsi: [0, 100],
  stochk: [0, 100],
  stochd: [0, 100],
  mfi: [0, 100],
  adx: [0, 100],
  willr: [-100, 0],
};

/**
 * The band a stop or target has to be inside before the lab will invent
 * neighbours for it.
 *
 * Below the floor the stop is inside the spread on most instruments; above the
 * ceiling it is not a stop, it is a position size. A base value OUTSIDE its
 * band is one the author chose deliberately (or a mistake), and either way the
 * lab does not make up numbers around it — the axis is held and said so.
 */
const AXIS_BANDS = {
  "stop.atr": [0.1, 10],
  "stop.pct": [0.05, 50],
  "target.rr": [0.1, 20],
  "target.pct": [0.05, 100],
} as const satisfies Record<string, readonly [number, number]>;

export interface SpecAxis {
  /** What varies, in plain words: `stop`, `target`, `RSI(14) threshold`. */
  readonly what: string;
  /** The values tried, in the order the grid walks them. */
  readonly values: readonly number[];
}

export interface SpecGrid {
  readonly strategies: readonly DocumentedStrategy[];
  readonly axes: readonly SpecAxis[];
  /**
   * Axes that EXIST and were not varied, each with the reason.
   *
   * Not decoration: these become warnings on the study, so "the sweep found
   * nothing better" is never read as "nothing better exists" when a whole
   * parameter was held fixed.
   */
  readonly held: readonly string[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Distinct, finite, in band, in the order given. */
function bandedValues(values: readonly number[], band: readonly [number, number]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (!Number.isFinite(v) || v < band[0] || v > band[1]) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Where a condition lives, so the same threshold can be moved in every group. */
const GROUPS = ["long", "short", "exitLong", "exitShort"] as const;
type GroupKey = (typeof GROUPS)[number];

const groupOf = (spec: RuleSpec, key: GroupKey): ConditionGroup | undefined =>
  key === "long" ? spec.long : key === "short" ? spec.short : key === "exitLong" ? spec.exitLong : spec.exitShort;

/**
 * Find the one threshold worth varying, or say why there is none.
 *
 * A column that appears with TWO different numbers is held, not guessed at.
 * `RSI < 30` in the long group and `RSI > 70` in the short group are one
 * symmetric pair to a reader and two unrelated numbers to this function;
 * moving one without the other would silently make the rule asymmetric, which
 * is a different strategy reported under the same name.
 */
function thresholdAxis(spec: RuleSpec): { column: ColumnId; value: number } | null {
  const seen = new Map<ColumnId, Set<number>>();
  const order: ColumnId[] = [];
  for (const key of GROUPS) {
    for (const cond of groupOf(spec, key) ?? []) {
      const [left, , right] = cond;
      if (!(left in BOUNDED_COLUMNS)) continue;
      const parsed = parseOperand(right);
      if (parsed === null || parsed.kind !== "number") continue;
      let values = seen.get(left);
      if (!values) {
        values = new Set();
        seen.set(left, values);
        order.push(left);
      }
      values.add(parsed.value);
    }
  }
  for (const column of order) {
    const values = seen.get(column);
    if (values && values.size === 1) {
      return { column, value: [...values][0] as number };
    }
  }
  return null;
}

/** Every column that appears with more than one threshold, for the held list. */
function ambiguousThresholds(spec: RuleSpec): string[] {
  const seen = new Map<ColumnId, Set<number>>();
  for (const key of GROUPS) {
    for (const cond of groupOf(spec, key) ?? []) {
      const [left, , right] = cond;
      if (!(left in BOUNDED_COLUMNS)) continue;
      const parsed = parseOperand(right);
      if (parsed === null || parsed.kind !== "number") continue;
      const values = seen.get(left) ?? new Set<number>();
      values.add(parsed.value);
      seen.set(left, values);
    }
  }
  const out: string[] = [];
  for (const [column, values] of seen) {
    if (values.size > 1) {
      out.push(
        `${COLUMNS[column]} appears with ${values.size} different thresholds (${[...values].join(", ")}), ` +
          `so none of them was varied — moving one without the others makes a different rule, and the lab ` +
          `does not guess how they are related.`,
      );
    }
  }
  return out;
}

const replaceThreshold = (
  group: ConditionGroup,
  column: ColumnId,
  from: number,
  to: number,
): ConditionGroup => {
  return group.map((cond): Condition => {
    const [left, op, right] = cond;
    if (left !== column) return cond;
    const parsed = parseOperand(right);
    return parsed !== null && parsed.kind === "number" && parsed.value === from
      ? [left, op, String(to)]
      : cond;
  });
};

interface Variant {
  readonly stop?: number;
  readonly target?: number;
  readonly threshold?: number;
}

/**
 * Derive the parameter sweep for one spec.
 *
 * Only what is SAFELY varyable: the stop multiple, the target, and at most one
 * bounded-oscillator threshold — in that priority order, admitted while the
 * product stays inside `SPEC_GRID_CAP`. Everything a spec contains that is not
 * one of those (which operator it uses, which columns it names, how many
 * conditions it ANDs) is the rule itself and is not a parameter.
 *
 * A spec with nothing varyable returns ONE strategy: the spec exactly as
 * written. That is a legitimate result — a single backtest — and `runSpecStudy`
 * says so rather than reporting it as a search.
 */
export function specGrid(spec: RuleSpec): SpecGrid {
  const axes: SpecAxis[] = [];
  const held: string[] = [...ambiguousThresholds(spec)];

  /* --- stop ------------------------------------------------------------- */
  const stopBase = spec.stop.type === "atr" ? spec.stop.mult : spec.stop.value;
  const stopBand = AXIS_BANDS[spec.stop.type === "atr" ? "stop.atr" : "stop.pct"];
  const stopValues =
    stopBase >= stopBand[0] && stopBase <= stopBand[1]
      ? bandedValues(SPEC_RATIOS.map((r) => round2(stopBase * r)), stopBand)
      : [];
  if (stopValues.length > 1) {
    axes.push({
      what: spec.stop.type === "atr" ? "stop (× ATR)" : "stop (%)",
      values: stopValues,
    });
  } else {
    held.push(
      `The stop (${stopBase}${spec.stop.type === "atr" ? " × ATR" : "%"}) was not varied: it is outside ` +
        `the ${stopBand[0]}-${stopBand[1]} band this lab will invent neighbours inside, so the only honest ` +
        `thing to test is the number as written.`,
    );
  }

  /* --- target ----------------------------------------------------------- */
  let targetValues: number[] = [];
  if (spec.target.type === "none") {
    held.push("There is no target to vary: this rule exits on its exit conditions and its stop only.");
  } else {
    const band = AXIS_BANDS[spec.target.type === "rr" ? "target.rr" : "target.pct"];
    const base = spec.target.value;
    targetValues =
      base >= band[0] && base <= band[1]
        ? bandedValues(SPEC_RATIOS.map((r) => round2(base * r)), band)
        : [];
    if (targetValues.length > 1) {
      axes.push({
        what: spec.target.type === "rr" ? "target (× risk)" : "target (%)",
        values: targetValues,
      });
    } else {
      targetValues = [];
      held.push(
        `The target (${base}${spec.target.type === "rr" ? "× risk" : "%"}) was not varied: it is outside ` +
          `the ${band[0]}-${band[1]} band this lab will invent neighbours inside.`,
      );
    }
  }

  /* --- one bounded threshold -------------------------------------------- */
  const threshold = thresholdAxis(spec);
  let thresholdValues: number[] = [];
  if (threshold) {
    const band = BOUNDED_COLUMNS[threshold.column] as readonly [number, number];
    const candidates = [
      threshold.value - SPEC_THRESHOLD_STEP,
      threshold.value,
      threshold.value + SPEC_THRESHOLD_STEP,
    ];
    const inside = candidates.filter((v) => v > band[0] && v < band[1]);
    const product = Math.max(1, stopValues.length) * Math.max(1, targetValues.length) * inside.length;
    if (inside.length < candidates.length) {
      held.push(
        `${COLUMNS[threshold.column]} at ${threshold.value} was not varied: ±${SPEC_THRESHOLD_STEP} points ` +
          `leaves the ${band[0]}-${band[1]} range the column can take, and a threshold outside its own ` +
          `range is a condition that can never fire rather than a variant.`,
      );
    } else if (product > SPEC_GRID_CAP) {
      held.push(
        `${COLUMNS[threshold.column]} at ${threshold.value} was held fixed: varying it as well would need ` +
          `${product} configurations and the cap is ${SPEC_GRID_CAP}, which is the size of the largest ` +
          `family grid. The stop and the target come first because they are the two parameters every ` +
          `rule has.`,
      );
    } else {
      thresholdValues = inside;
      axes.push({ what: `${COLUMNS[threshold.column]} threshold`, values: inside });
    }
  }

  /* --- the product ------------------------------------------------------ */
  const variants: Variant[] = [{}];
  const expand = (values: readonly number[], key: keyof Variant): void => {
    if (values.length === 0) return;
    const next: Variant[] = [];
    for (const base of variants) for (const v of values) next.push({ ...base, [key]: v });
    variants.length = 0;
    variants.push(...next);
  };
  expand(stopValues, "stop");
  expand(targetValues, "target");
  expand(thresholdValues, "threshold");

  const strategies = variants.map((variant) => {
    let varied: RuleSpec = spec;
    const tags: string[] = [];

    if (variant.stop !== undefined) {
      varied = {
        ...varied,
        stop:
          varied.stop.type === "atr"
            ? { type: "atr", mult: variant.stop }
            : { type: "pct", value: variant.stop },
      };
      tags.push(`stop ${variant.stop}`);
    }
    if (variant.target !== undefined && varied.target.type !== "none") {
      varied = { ...varied, target: { type: varied.target.type, value: variant.target } };
      tags.push(`target ${variant.target}`);
    }
    if (variant.threshold !== undefined && threshold) {
      varied = {
        ...varied,
        long: replaceThreshold(varied.long, threshold.column, threshold.value, variant.threshold),
        ...(varied.short
          ? { short: replaceThreshold(varied.short, threshold.column, threshold.value, variant.threshold) }
          : {}),
        ...(varied.exitLong
          ? { exitLong: replaceThreshold(varied.exitLong, threshold.column, threshold.value, variant.threshold) }
          : {}),
        ...(varied.exitShort
          ? { exitShort: replaceThreshold(varied.exitShort, threshold.column, threshold.value, variant.threshold) }
          : {}),
      };
      tags.push(`${threshold.column} ${variant.threshold}`);
    }

    /* A distinct id and label per variant, set BEFORE compiling: `compileSpec`
       reads `spec.id`/`spec.name`, and two configs sharing an id would collide
       in the `runs` map and report one config's curve under the other's row. */
    const suffix = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
    const compiled = compileSpec(
      tags.length === 0 ? spec : { ...varied, id: `${spec.id}@${tags.join("/")}`, name: `${spec.name}${suffix}` },
    );
    return variant.threshold === undefined
      ? compiled
      : { ...compiled, params: { ...compiled.params, threshold: variant.threshold } };
  });

  return { strategies, axes, held };
}

export interface ConfigRow {
  id: string;
  label: string;
  params: Record<string, number>;
  metrics: Metrics;
  /** In-sample selection score — the number the sweep would have ranked on. */
  score: number;
  refused: string | null;
}

export type Standing = "refused" | "no-edge" | "unproven" | "fragile" | "survived";

export interface Headline {
  standing: Standing;
  /** One sentence. Shown at the top, in the same weight as the return. */
  verdict: string;
  /** The supporting detail, in plain language. */
  why: string;
}

export interface Study {
  /**
   * WHAT was studied: one of the three hand-written families, or a `RuleSpec`.
   *
   * Widened from `family: Family` in v60. Nothing outside this module read the
   * old field — it was written, serialised through the worker and never looked
   * at — so the union replaced it rather than sitting beside it. Two fields
   * naming one thing is how the equity defect happened.
   */
  subject: StudySubject;
  bars: number;
  /**
   * Every configuration tried, ranked best-first by in-sample score.
   *
   * THIS LENGTH IS THE TRIAL COUNT, and it is the number a caller deflates by.
   * One row is pushed per grid entry, including the ones the engine refused, so
   * `configs.length` is exactly how many configurations were evaluated —
   * `trials.test` in `test/labspec.test.ts` pins that against the grid. On the
   * refusal path it is 0, which is also correct: nothing ran.
   *
   * The winner's cost-free re-run (`grossMetrics`) is NOT a trial. It is the
   * same configuration measured a second way, not another candidate the
   * selection could have picked, and counting it would inflate every deflation
   * that uses this number.
   */
  configs: ConfigRow[];
  best: ConfigRow | null;
  /** The winner's full run, for the equity curve and the trade list. */
  bestRun: BacktestResult | null;
  walk: WalkForwardResult;
  overfit: PboResult;
  headline: Headline;
  /**
   * The same winner with every cost switched off.
   *
   * Distinguishes "there is no edge" from "there is an edge and the frictions
   * eat it" — two situations with completely different responses, and the one
   * question a single backtest number can never answer.
   */
  grossMetrics: Metrics | null;
  /**
   * Whether this survives the out-of-sample gate, and every reason either way.
   *
   * Separate from `headline`, which grades the study; this decides whether the
   * result is allowed to be treated as a finding. The distinction matters
   * because a study can be interesting and still not be promotable, and the
   * desk has always shown the first without ever computing the second.
   */
  promotion: Promotion;
  /**
   * The winner's trades split by the market condition they were ENTERED in.
   *
   * Empty when no run produced trades. "58% in trend, 44% in chop" is an
   * instruction; the pooled figure that averages them is a number.
   */
  regimes: RegimeSlice[];
  warnings: string[];
  rules: RuleDoc | null;
}

export interface StudyOptions extends BacktestOptions {
  folds?: number;
  /** CSCV blocks. Must be even; more blocks means more splits and more time. */
  blocks?: number;
}

/** Out-of-sample trades below this cannot support any conclusion at all. */
export const MIN_OOS_TRADES = 30;

const emptyStudy = (subject: StudySubject, bars: number, why: string): Study => ({
  subject,
  bars,
  configs: [],
  best: null,
  bestRun: null,
  walk: { folds: [], aggregate: computeMetrics([], []), degradation: 0, warnings: [], verdict: why },
  overfit: { pbo: 0, logits: [], splits: 0, oosPositiveRate: 0, interpretation: why },
  headline: { standing: "refused", verdict: "Cannot be tested", why },
  grossMetrics: null,
  promotion: promote(
    { folds: [], aggregate: computeMetrics([], []), degradation: 0, warnings: [], verdict: why },
  ),
  regimes: [],
  warnings: [why],
  rules: null,
});

/**
 * Run the whole study over one of the three hand-written families.
 *
 * Synchronous and CPU-bound: a 12-config sweep over a few thousand bars is
 * tens of milliseconds per config, so the whole thing is well under a second —
 * except `confluence`, measured at 0.7s over 2,000 bars and 3.4s over 5,000,
 * which is what the caller's yield to the frame is actually for. See
 * `ui/strategy.ts`.
 *
 * The body is one line because the sweep itself is SHARED with `runSpecStudy`.
 * The only thing a family contributes is its grid.
 */
export function runStudy(family: Family, bars: readonly BarView[], opts: StudyOptions = {}): Study {
  return sweep({ kind: "family", id: family }, familyGrid(family), [], bars, opts);
}

/**
 * Run the whole study over a declarative `RuleSpec`.
 *
 * EVERYTHING the family path does, over a grid derived from the spec instead of
 * written out by hand: the same walk-forward, the same CSCV, the same
 * `computeMetrics`, the same headline, the same promotion gate, the same regime
 * slices, the same refusals. It shares `sweep` with the family path rather than
 * repeating it, which is the only arrangement under which the two cannot
 * quietly drift apart — and drift is the whole risk, because the two results
 * are meant to be read on the same screen against each other.
 *
 * One refusal the family path cannot have: a spec is data, so it can be
 * INVALID. `validateSpec` names the bad token, and refusing here beats
 * compiling a rule whose condition evaluates to NaN and never fires, which
 * looks exactly like a strategy with no signals.
 *
 * MEASURED (Node 22, 8 cores, synthetic deterministic bars — a BENCHMARK
 * input, not a result; best of three passes, because the first study in a
 * process pays most of a 2,000-bar study in V8 warm-up alone):
 *
 *   in-process, 9 configs      2,000 bars   5,000 bars
 *   ema-9-21-cross                 47 ms        81 ms
 *   donchian-breakout              55 ms        95 ms
 *   family "ema"     (12 configs)  20 ms        67 ms
 *   family "confluence" (9)       697 ms     3,383 ms
 *
 * A spec study is CHEAP next to `confluence` — roughly fifteen times cheaper
 * at 2,000 bars and forty at 5,000 — because a spec is a handful of column
 * lookups per bar and the confluence score is the whole detector stack. The
 * consequence for the sweep is in `server/gateway/lab.py`: a spec study is now
 * small enough that the per-study PROCESS is most of what it costs.
 */
export function runSpecStudy(spec: RuleSpec, bars: readonly BarView[], opts: StudyOptions = {}): Study {
  const subject: StudySubject = { kind: "spec", id: spec.id, spec };

  const problems = validateSpec(spec);
  if (problems.length > 0) {
    return emptyStudy(
      subject,
      bars.length,
      `This rule cannot be tested as written: ${problems.map((p) => `${p.where} — ${p.message}`).join(" ")}`,
    );
  }

  const grid = specGrid(spec);
  const warnings = [...grid.held];
  if (grid.strategies.length === 1) {
    /* One config is a BACKTEST, not a search, and the difference is the whole
       reason this file exists. PBO returns 0 with "needs at least two
       configurations to compare" — honest, and easy to read as "no overfitting
       risk" if nothing says otherwise. This says otherwise. */
    warnings.push(
      "Only one configuration was testable, so this is a single backtest and not a search: nothing was " +
        "selected, so there is no selection bias to measure and the overfitting probability below is not " +
        "evidence of robustness.",
    );
  }
  return sweep(subject, grid.strategies, warnings, bars, opts);
}

/** Dispatch on the subject. What a job from another process arrives as. */
export function runSubjectStudy(
  subject: StudySubject,
  bars: readonly BarView[],
  opts: StudyOptions = {},
): Study {
  return subject.kind === "family"
    ? runStudy(subject.id, bars, opts)
    : runSpecStudy(subject.spec, bars, opts);
}

/**
 * The one sweep. Both subjects go through this and neither has its own copy.
 *
 * `gridWarnings` is what the GRID wants to say before anything ran — which
 * parameter it refused to vary, and why. A family grid is written by hand and
 * has nothing to add; a spec grid usually does.
 */
function sweep(
  subject: StudySubject,
  grid: readonly DocumentedStrategy[],
  gridWarnings: readonly string[],
  bars: readonly BarView[],
  opts: StudyOptions,
): Study {
  const maxWarmup = Math.max(...grid.map((g) => g.warmup));

  // Refusing is a result. A study run on too little history would produce
  // numbers that look exactly like real ones, which is the dangerous case.
  if (bars.length < maxWarmup * 4) {
    const what = subject.kind === "family" ? "this family" : "this rule";
    return emptyStudy(
      subject,
      bars.length,
      `${bars.length} bars is not enough for ${what} — it needs at least ${maxWarmup * 4} ` +
        `(four times the ${maxWarmup}-bar warm-up) before a sweep means anything.`,
    );
  }

  const warnings: string[] = [...gridWarnings];
  const configs: ConfigRow[] = [];
  const matrix: number[][] = [];
  const runs = new Map<string, BacktestResult>();

  for (const strategy of grid) {
    const run = runBacktest(strategy, bars, opts);
    runs.set(strategy.id, run);
    const m = run.refused ? computeMetrics([], []) : computeMetrics(run.trades, run.equity);
    configs.push({
      id: strategy.id,
      label: strategy.label,
      params: strategy.params,
      metrics: m,
      score: run.refused ? -Infinity : defaultScore(m),
      refused: run.refused,
    });
    for (const w of run.warnings) if (!warnings.includes(w)) warnings.push(w);
    // A refused config contributes no row to the PBO matrix; including a flat
    // line would make the sweep look more robust than it is.
    if (!run.refused && run.equity.length > 1) matrix.push(equityToReturns(run.equity));
  }

  configs.sort((a, b) => b.score - a.score);
  const best = configs[0] ?? null;
  const bestRun = best ? (runs.get(best.id) ?? null) : null;
  const bestStrategy = best ? (grid.find((g) => g.id === best.id) ?? null) : null;

  const walk = walkForward(grid, bars, { ...opts, folds: opts.folds ?? 5 });
  const overfit = pbo(matrix, opts.blocks ?? 8);

  let grossMetrics: Metrics | null = null;
  if (bestStrategy) {
    const gross = runBacktest(bestStrategy, bars, { ...opts, costs: ZERO_COSTS });
    if (!gross.refused) grossMetrics = computeMetrics(gross.trades, gross.equity);
  }

  return {
    subject,
    bars: bars.length,
    configs,
    best,
    bestRun,
    walk,
    overfit,
    headline: judge(configs, walk, overfit, best, grossMetrics),
    grossMetrics,
    promotion: promote(walk, overfit),
    /* The WINNER's trades, split by entry regime. Not the walk-forward pool:
       those trades come from different configurations fold by fold, so
       splitting them by regime would mix several strategies together and
       report the result as one. */
    regimes: bestRun && bestRun.trades.length > 0 ? byRegime(bestRun.trades, bars) : [],
    warnings: [...warnings, ...walk.warnings],
    rules: bestStrategy?.rules ?? null,
  };
}

/**
 * The gate.
 *
 * Ordered so that the strongest objection wins. In particular the sample-size
 * check outranks a flattering degradation number, because a small sample can
 * produce any degradation figure you like and it will mean nothing.
 */
export function judge(
  configs: readonly ConfigRow[],
  walk: WalkForwardResult,
  overfit: PboResult,
  best: ConfigRow | null,
  gross: Metrics | null,
): Headline {
  if (!best || best.refused) {
    return {
      standing: "refused",
      verdict: "Cannot be tested",
      why: best?.refused ?? "no configuration produced a usable run",
    };
  }

  const oos = walk.aggregate.trades;

  if (overfit.splits >= 4 && overfit.pbo >= 0.5) {
    return {
      standing: "no-edge",
      verdict: "No demonstrated edge",
      why:
        `PBO is ${(overfit.pbo * 100).toFixed(0)}%: across ${overfit.splits} train/test splits, the ` +
        `configuration that won in-sample landed below the out-of-sample median more often than not. ` +
        `Selection among these ${configs.length} variants has no measurable skill, so the winner is ` +
        `the luckiest rather than the best. The equity curve below is real arithmetic on real bars ` +
        `and still tells you nothing about the future.`,
    };
  }

  if (oos < MIN_OOS_TRADES) {
    return {
      standing: "unproven",
      verdict: "Unproven — sample too small",
      why:
        `Walk-forward produced ${oos} out-of-sample trade${oos === 1 ? "" : "s"}. Below ` +
        `${MIN_OOS_TRADES} nothing can be concluded, however good the numbers look: a handful of ` +
        `trades will happily show a large edge or none at all purely by chance. Test on more history ` +
        `or a faster timeframe before reading anything into this.`,
    };
  }

  if (overfit.pbo >= 0.3) {
    return {
      standing: "fragile",
      verdict: "Fragile",
      why:
        `PBO is ${(overfit.pbo * 100).toFixed(0)}% — the in-sample winner fails out-of-sample in ` +
        `roughly one split in ${Math.max(2, Math.round(1 / Math.max(overfit.pbo, 0.01)))}. ` +
        `There may be something here, but the parameter choice is doing a lot of the work.`,
    };
  }

  if (walk.degradation < 0.3) {
    return {
      standing: "fragile",
      verdict: "Fragile — did not carry out of sample",
      why:
        `Out-of-sample expectancy is ${(walk.degradation * 100).toFixed(0)}% of in-sample across ` +
        `${walk.folds.length} folds and ${oos} trades. Most of what the backtest showed was fitted ` +
        `to the training slice.`,
    };
  }

  const costNote =
    gross && gross.expectancyR > 0 && walk.aggregate.expectancyR <= 0
      ? " Note that it is profitable only with costs switched off — the frictions are the whole result."
      : "";

  return {
    standing: "survived",
    verdict: "Survived out-of-sample",
    why:
      `${oos} out-of-sample trades across ${walk.folds.length} folds retained ` +
      `${(walk.degradation * 100).toFixed(0)}% of in-sample expectancy, with PBO ` +
      `${(overfit.pbo * 100).toFixed(0)}% over ${overfit.splits} splits. That is evidence, not ` +
      `proof — it is one symbol over one period, and the future is not obliged to resemble it.` +
      costNote,
  };
}
