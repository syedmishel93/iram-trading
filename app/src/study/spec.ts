/**
 * A study: what the operator asked, before anything has been measured.
 *
 * WHAT THIS IS FOR
 * The terminal already holds every engine a question like "does the dollar
 * lead bitcoin, and only in some conditions" needs — `data/panel.ts` joins the
 * series without leaking, `backtest/validate.ts` walks it forward,
 * `backtest/regime.ts` slices it, the quant service fits the models. What it
 * has never had is the QUESTION as an object: the thing you name, save, re-run
 * next week and compare against what it said last time.
 *
 * That object is this. It holds only choices — no bars, no results, no
 * timestamps from a feed. Everything downstream is derived from it plus the
 * archive, which is what makes a study reproducible: the same spec against the
 * same archive gives the same report, and when it does not, the archive
 * changed and the report says so.
 *
 * WHY THE ROLE OF EACH SERIES IS PART OF THE SPEC
 * `data/drivers.ts` already distinguishes `lead` from `context` and explains
 * why: lagging a contemporaneous correlation into a model is how it becomes a
 * "forecast". That distinction is right and too coarse for a study the
 * operator assembles by hand, because four different jobs collapse into
 * "context":
 *
 *   DRIVER   — may be used as a predictor. Enters the feature matrix.
 *   PEER     — moves for the same reasons the subject does. Enters the matrix
 *              but is NOT independent evidence; two peers agreeing is one
 *              market agreeing with itself (`backtest/universe.ts` makes the
 *              same argument about ETH in BTC's bloc).
 *   REGIME   — describes the conditions rather than the move. Does NOT enter
 *              the matrix; it SLICES the result. A volatility index used as a
 *              feature teaches a model that volatility is high when it is
 *              high.
 *   CONTROL  — is in the study to be beaten. If the finding is no stronger
 *              than the control column, the finding is noise wearing a name.
 *
 * Each of those has a different consequence downstream, which is the test of
 * whether a distinction is real or decorative. `panelRoleOf` and
 * `sliceSeries` are where the consequences land.
 */

import { familyOf } from "../data/drivers";
import { proposeRelated, type RelatedPick } from "./related";
import type { QuestionId } from "./question";

export type SeriesRole = "driver" | "peer" | "regime" | "control";

export const SERIES_ROLES: readonly SeriesRole[] = ["driver", "peer", "regime", "control"];

export interface RoleMeta {
  readonly label: string;
  /** What choosing this role DOES, in the operator's terms. */
  readonly blurb: string;
  /**
   * Where this series goes in the feature matrix, or null when it does not go
   * in one at all. `null` is the whole point of the regime role.
   */
  readonly panelRole: "lead" | "context" | null;
  /** Whether two of these count as two independent markets. */
  readonly independent: boolean;
}

export const ROLE_META: Readonly<Record<SeriesRole, RoleMeta>> = {
  driver: {
    label: "Driver",
    blurb: "May be used as a predictor. Enters the feature matrix, lagged, and is never read from the future.",
    panelRole: "lead",
    independent: true,
  },
  peer: {
    label: "Peer",
    blurb: "Moves for the same reasons the subject does. Adds observations, but two peers agreeing is one market agreeing with itself.",
    panelRole: "context",
    independent: false,
  },
  regime: {
    label: "Regime proxy",
    blurb: "Describes the conditions, not the move. Slices the result instead of entering the model — a feature that says volatility is high when it is high teaches nothing.",
    panelRole: null,
    independent: false,
  },
  control: {
    label: "Control",
    blurb: "In the study to be beaten. A finding no stronger than its control is noise with a name on it.",
    panelRole: "context",
    independent: true,
  },
};

/** Where a series sits in the panel, or null when it is not a column at all. */
export function panelRoleOf(role: SeriesRole): "lead" | "context" | null {
  return ROLE_META[role].panelRole;
}

export interface ContextSeries {
  readonly symbol: string;
  readonly label: string;
  readonly role: SeriesRole;
  /**
   * The mechanism, in one sentence: why this could move that.
   *
   * Carried through from `drivers.ts`, which makes the same demand and gives
   * the same reason — if you cannot state the channel, the column does not
   * belong in the study. A hand-added series with no stated mechanism is
   * allowed, and `specProblems` says so as a caution rather than refusing it.
   */
  readonly why: string;
}

/**
 * The history depths offered, in years.
 *
 * Not a free number field. The choice that matters is an order of magnitude —
 * one year against five — and a free field invites `4.5` and then a question
 * about why the joint window moved by three bars. `"max"` means whatever the
 * archive and the vendors will give, which is the only honest name for it.
 */
export const HISTORY_YEARS = [1, 2, 3, 5, 10] as const;
export type HistoryYears = (typeof HISTORY_YEARS)[number] | "max";

export function yearsLabel(y: HistoryYears): string {
  return y === "max" ? "Max" : `${y}y`;
}

export interface StudySpec {
  readonly id: string;
  readonly name: string;
  /** The instrument the question is ABOUT. Never a column. */
  readonly symbol: string;
  readonly timeframe: string;
  readonly context: readonly ContextSeries[];
  readonly years: HistoryYears;
  /**
   * How far ahead the question looks, in bars.
   *
   * This is the single most consequential number in the spec and the easiest
   * to set without thinking about. It decides what the label MEANS, how many
   * independent observations the training window really holds (overlapping
   * labels are not independent — see `study/window.ts`), and therefore how
   * many free parameters the data can carry.
   */
  readonly horizon: number;
  /** Method ids, in no particular order — `study/plan.ts` orders them. */
  readonly methods: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * The steered flow's question. Optional because every study saved before it
   * existed has none, and those must still open; `questionOf` defaults it.
   */
  readonly question?: QuestionId;
  /** Walk-forward rounds for the rule tests. Read through `foldsOf`. */
  readonly folds?: number;
  /** Trading costs for the rule tests. Read through `costsOf`. */
  readonly costs?: CostModel;
}

export const DEFAULT_HORIZON = 24;

/**
 * The cost model a study's rule tests are run with.
 *
 * `standard` is `backtest/engine.ts`'s DEFAULT_COSTS — 2bp spread, 0.04%
 * commission a side, 1bp slippage — and it is NOT your broker's schedule.
 * `none` exists to separate "no edge" from "an edge the costs eat".
 *
 * `measured` charges the SPREAD your broker's contract spec reports, keeping
 * commission and slippage at the engine's assumption. Measured against this
 * account the standard spread is 4.8x the real one on gold, and because costs
 * set the hurdle a rule must clear, overcharging DISCARDS rules that would have
 * cleared what you actually pay — silently, with nothing on screen saying why.
 *
 * ONLY THE SPREAD, and the name says so rather than implying a full schedule: a
 * broker's commission is per-lot and account-specific and slippage belongs to
 * the venue and the order size, so reading either off an instrument spec would
 * be a third cost model that is neither measured nor assumed. `standard`
 * remains the DEFAULT, because a hurdle that moved because a service answered
 * is a result that changed for a reason nobody chose.
 */
export type CostModel = "standard" | "none" | "measured";

export const DEFAULT_FOLDS = 5;
export const MIN_FOLDS = 3;
export const MAX_FOLDS = 12;

/**
 * Rounds, validated at the point of use.
 *
 * `isSpec` in the store validates only the fields every study has, so a stored
 * `folds` is whatever was written. Clamping here means a corrupted value makes
 * a study run with a sane number of rounds rather than with `NaN` of them.
 */
export function foldsOf(spec: Pick<StudySpec, "folds">): number {
  const f = spec.folds;
  if (typeof f !== "number" || !Number.isFinite(f)) return DEFAULT_FOLDS;
  return Math.max(MIN_FOLDS, Math.min(MAX_FOLDS, Math.round(f)));
}

export function costsOf(spec: Pick<StudySpec, "costs">): CostModel {
  if (spec.costs === "none") return "none";
  if (spec.costs === "measured") return "measured";
  /* ANYTHING ELSE IS STANDARD, including a corrupted stored value. `isSpec` in
     the store validates only the fields every study has, so this is the last
     place a bad one can be caught — and the safe landing is the assumption,
     never the cheaper hurdle. */
  return "standard";
}

/**
 * The related assets a study of `symbol` starts with, as context series.
 *
 * From `study/related.ts`, which builds on `driversFor` and keeps only what
 * the terminal can load — see its header for the measurement that made that
 * necessary. The role translation is `roleForDriver`, unchanged.
 */
export function relatedContext(symbol: string, picks: readonly RelatedPick[] = proposeRelated(symbol).picks): ContextSeries[] {
  return picks.map((p) => ({
    symbol: p.symbol,
    label: p.label,
    role: roleForDriver(symbol, p.symbol, p.driverRole),
    why: p.why,
  }));
}

/**
 * Seed a study from an instrument.
 *
 * The context is the AI's related-asset proposal: `driversFor`'s declared
 * relationships, translated to loadable tickers, with anything nothing can
 * serve left out (`study/related.ts`). It still returns nothing for an
 * unrecognised symbol rather than guessing a driver set. An empty context is
 * a legitimate study (the instrument on its own history) and `specProblems`
 * says what that costs rather than blocking it.
 */
export function newStudy(
  id: string,
  symbol: string,
  timeframe: string,
  now: number,
): StudySpec {
  return {
    id,
    name: `${symbol} ${timeframe}`,
    symbol,
    timeframe,
    context: relatedContext(symbol),
    years: 3,
    horizon: DEFAULT_HORIZON,
    methods: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Translate `drivers.ts`'s two roles into the study's four.
 *
 * `lead` is unambiguous — it is the role that exists to say "this may be used
 * as a predictor" — so it becomes `driver`. `context` splits on FAMILY, and
 * that split is the honest one: a series in the subject's own family moves for
 * the same reasons it does and is a peer, and one outside it is describing the
 * weather rather than the subject and is a regime proxy. Nothing here is a
 * control, because `drivers.ts` has no concept of one; a control is always a
 * deliberate choice by the operator.
 */
export function roleForDriver(
  subject: string,
  series: string,
  driverRole: "lead" | "context",
): SeriesRole {
  if (driverRole === "lead") return "driver";
  const subjectFamily = familyOf(subject);
  const seriesFamily = familyOf(series);
  if (subjectFamily !== null && subjectFamily === seriesFamily) return "peer";
  return "regime";
}

export interface SpecProblem {
  readonly field: "symbol" | "context" | "horizon" | "methods" | "years";
  /** `blocking` stops the run. `caution` is stated and the run proceeds. */
  readonly severity: "blocking" | "caution";
  readonly text: string;
}

/**
 * How many feature columns this spec will actually produce.
 *
 * Regime series are excluded, because they are not columns. Getting this wrong
 * in either direction breaks the parameter budget, which is the number the
 * whole subject step is arranged around.
 */
export function featureColumns(spec: StudySpec): number {
  return spec.context.filter((c) => panelRoleOf(c.role) !== null).length;
}

/** Series used to slice the result rather than to predict it. */
export function sliceSeries(spec: StudySpec): readonly ContextSeries[] {
  return spec.context.filter((c) => c.role === "regime");
}

/** How many genuinely independent sources of evidence the context holds. */
export function independentSeries(spec: StudySpec): number {
  return spec.context.filter((c) => ROLE_META[c.role].independent).length;
}

/**
 * Everything wrong with the spec, before a single bar is fetched.
 *
 * Checked HERE rather than at run time for the reason `panelRefusal` gives:
 * a study that fails three minutes into a fetch, with a message written for
 * whoever wrote the code, has spent the operator's time to tell them something
 * that was knowable before it started.
 */
export function specProblems(spec: StudySpec): readonly SpecProblem[] {
  const out: SpecProblem[] = [];
  const subject = spec.symbol.trim().toUpperCase();

  if (subject === "") {
    out.push({ field: "symbol", severity: "blocking", text: "No instrument chosen." });
  }

  const seen = new Set<string>();
  for (const c of spec.context) {
    const s = c.symbol.trim().toUpperCase();
    if (s === subject) {
      out.push({
        field: "context",
        severity: "blocking",
        text: `${c.symbol} is the subject of this study. A column that is the target predicts the target perfectly and means nothing by it.`,
      });
    }
    if (seen.has(s)) {
      out.push({
        field: "context",
        severity: "blocking",
        text: `${c.symbol} is in the study twice. A duplicated column is counted twice by every score that counts columns.`,
      });
    }
    seen.add(s);
    if (c.why.trim() === "") {
      out.push({
        field: "context",
        severity: "caution",
        text: `No mechanism is stated for ${c.symbol}. It will still be measured, but a column nobody can explain is a column that will be explained after the fact by whatever it correlates with.`,
      });
    }
  }

  if (!Number.isFinite(spec.horizon) || spec.horizon < 1) {
    out.push({
      field: "horizon",
      severity: "blocking",
      text: "The horizon must be at least one bar — there is no question about zero bars ahead.",
    });
  }

  if (spec.methods.length === 0) {
    out.push({
      field: "methods",
      severity: "blocking",
      text: "No method chosen. The data has been assembled but nothing has been asked of it.",
    });
  }

  const independents = independentSeries(spec);
  if (spec.context.length > 0 && independents === 0) {
    out.push({
      field: "context",
      severity: "caution",
      text: "Every series added either moves with the subject or only describes conditions. Nothing here can independently confirm a finding about the subject.",
    });
  }

  const cols = featureColumns(spec);
  if (cols > 8) {
    out.push({
      field: "context",
      severity: "caution",
      text: `${cols} feature columns. Each one is a chance for the search to find something, and the correction that keeps that honest gets harsher with every column — see the parameter budget on the right.`,
    });
  }

  return out;
}

export function blocking(problems: readonly SpecProblem[]): readonly SpecProblem[] {
  return problems.filter((p) => p.severity === "blocking");
}
