/**
 * The pipeline: chosen methods put in an order, counted, and costed.
 *
 * THE COUNT IS THE POINT
 * Eleven methods over four drivers is not eleven tests. Lead–lag alone is
 * ninety-seven lags against each driver, and every one of those is a chance to
 * find a bar that clears the noise band. At 5% significance, four hundred
 * tests produce about twenty "significant" results on data with nothing in it
 * whatsoever.
 *
 * That is not a reason to run fewer tests. It is a reason to know how many
 * were run, which is the one number a terminal that scatters these across six
 * desks can never produce. `hypotheses` is that number, and it is what makes
 * the last step of every plan possible.
 *
 * WHICH IS WHY THE LAST STEP CANNOT BE REMOVED
 * A search this wide without a correction produces a headline number that is
 * not wrong so much as meaningless — it is the maximum of several hundred
 * draws, reported as though it were one. The correction is part of the method,
 * not an option beside it, so it is not in the catalogue and there is no
 * control that turns it off.
 */

import { FDR } from "../backtest/resample";
import {
  availability,
  METHOD_BY_ID,
  METHODS,
  type Availability,
  type Method,
  type MethodContext,
} from "./methods";

/**
 * What a method actually cost, last time it ran on this machine.
 *
 * Kept per method and updated after every run. The plan prefers this over the
 * catalogue's declared guess and SAYS which one it used, because a terminal
 * that shows "estimated 2m 14s" has made a claim, and a claim sourced from a
 * number somebody typed into a constant is a different thing from one sourced
 * from the last time this exact machine did this exact work.
 */
export interface Timing {
  readonly msPerKRow: number;
  readonly fixedMs: number;
  /** How many runs the figures are averaged over. */
  readonly runs: number;
}

export type Timings = Readonly<Record<string, Timing>>;

export interface PlanStep {
  /** 1-based, as shown. */
  readonly n: number;
  readonly method: Method;
  /** Ids this step consumes that are actually in this plan. */
  readonly reads: readonly string[];
  readonly tests: number;
  readonly estimateMs: number;
  readonly estimateFrom: "measured" | "guess";
  readonly availability: Availability;
}

export interface Correction {
  readonly hypotheses: number;
  /** How many results would clear 5% on data with nothing in it. */
  readonly expectedByChance: number;
  readonly fdr: number;
  readonly text: string;
}

export interface Plan {
  /** Steps that will run, in order. */
  readonly steps: readonly PlanStep[];
  /** Steps chosen that cannot run, each with its reason. */
  readonly blocked: readonly PlanStep[];
  readonly hypotheses: number;
  readonly estimateMs: number;
  /** True when at least one step's estimate came from a real previous run. */
  readonly anyMeasured: boolean;
  readonly correction: Correction;
  /** Why nothing can run at all, or null. */
  readonly refusal: string | null;
}

/** "2m 14s", "38s", "under a second". Never "134000ms". */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "under a second";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function estimateFor(
  m: Method,
  rows: number,
  timings: Timings,
): { ms: number; from: "measured" | "guess" } {
  const seen = timings[m.id];
  const kRows = Math.max(0, rows) / 1000;
  if (seen !== undefined && seen.runs > 0) {
    return { ms: seen.fixedMs + seen.msPerKRow * kRows, from: "measured" };
  }
  return { ms: m.guessFixedMs + m.guessMsPerKRow * kRows, from: "guess" };
}

/**
 * Order the chosen methods so nothing runs before what it reads.
 *
 * Declaration order in the catalogue is the tiebreak, and it is not arbitrary:
 * the catalogue is written in the order the questions are worth asking, from
 * "is anything related to anything" to "would a rule have made money". A
 * topological sort on top of that moves only what has to move.
 */
function order(ids: readonly string[]): Method[] {
  const chosen = new Set(ids);
  const out: Method[] = [];
  const placed = new Set<string>();
  /* Bounded rather than recursive: the catalogue is a dozen entries with a
     one-level dependency, and a cycle introduced by a future edit should stop
     the loop rather than the tab. */
  for (let pass = 0; pass < METHODS.length + 1 && placed.size < chosen.size; pass += 1) {
    for (const m of METHODS) {
      if (!chosen.has(m.id) || placed.has(m.id)) continue;
      const waiting = m.reads.some((r) => chosen.has(r) && !placed.has(r));
      if (waiting) continue;
      out.push(m);
      placed.add(m.id);
    }
  }
  /* Anything left is in a cycle. Appended rather than dropped, so a mistake in
     the catalogue shows up as a step in the wrong place and not as a method
     that silently stopped being offered. */
  for (const m of METHODS) if (chosen.has(m.id) && !placed.has(m.id)) out.push(m);
  return out;
}

/**
 * `reads` is a list of alternatives, not a list of requirements.
 *
 * The excursion read wants A sweep — any of the three. Written as an OR
 * because that is what it means, and an AND here would make the excursion
 * available only to someone who selected all three rule families, which is a
 * rule nobody would guess from the card.
 */
function unmetRead(m: Method, chosen: ReadonlySet<string>): string | null {
  if (m.reads.length === 0) return null;
  if (m.reads.some((r) => chosen.has(r))) return null;
  const names = m.reads
    .map((r) => METHOD_BY_ID.get(r)?.label ?? r)
    .join(", or ");
  return `Reads the output of another step. Add ${names} and this can run.`;
}

/**
 * Whether one method can run, given the study AND what else is selected.
 *
 * EXPORTED, AND THAT IS THE POINT. The catalogue needs this answer for every
 * method whether or not it has been chosen — an operator scanning the cards is
 * deciding WHAT to choose, and a card that only reveals it cannot run after
 * being clicked has told them nothing at the moment they needed it.
 *
 * MEASURED: reading the verdicts out of the plan instead meant every card on
 * the screen rendered unblocked, because the plan contains only the methods
 * already selected. Fifteen cards, none of them showing a requirement, on a
 * study whose only Driver had loaded no bars at all.
 *
 * `buildPlan` calls this same function, so the card and the pipeline cannot
 * disagree about why something is unavailable.
 */
export function stepAvailability(
  m: Method,
  ctx: MethodContext,
  chosen: ReadonlySet<string>,
): Availability {
  const unmet = unmetRead(m, chosen);
  if (unmet !== null) return { state: "blocked", reason: unmet, fixable: true };
  return availability(m, ctx);
}


export function buildPlan(
  methodIds: readonly string[],
  ctx: MethodContext,
  timings: Timings = {},
): Plan {
  const chosen = new Set(methodIds.filter((id) => METHOD_BY_ID.has(id)));
  const ordered = order([...chosen]);

  const steps: PlanStep[] = [];
  const blocked: PlanStep[] = [];
  let n = 0;
  let estimateMs = 0;
  let hypotheses = 0;
  let anyMeasured = false;

  for (const m of ordered) {
    const avail = stepAvailability(m, ctx, chosen);
    const tests = Math.max(0, Math.round(m.tests(ctx)));
    const est = estimateFor(m, ctx.rows, timings);
    const reads = m.reads.filter((r) => chosen.has(r));

    if (avail.state === "blocked") {
      blocked.push({
        n: 0,
        method: m,
        reads,
        tests,
        estimateMs: est.ms,
        estimateFrom: est.from,
        availability: avail,
      });
      continue;
    }

    n += 1;
    estimateMs += est.ms;
    hypotheses += tests;
    if (est.from === "measured") anyMeasured = true;
    steps.push({ n, method: m, reads, tests, estimateMs: est.ms, estimateFrom: est.from, availability: avail });
  }

  return {
    steps,
    blocked,
    hypotheses,
    estimateMs,
    anyMeasured,
    correction: correctionFor(hypotheses),
    refusal:
      steps.length === 0
        ? chosen.size === 0
          ? "No method is selected, so there is nothing to run."
          : "Every method selected is blocked. The reasons are beside each one — most of them are a series or a window away from working."
        : null,
  };
}

/** Results expected to clear plain 5% significance on data with no signal. */
export const NOMINAL_ALPHA = 0.05;

export function correctionFor(hypotheses: number): Correction {
  const expected = hypotheses * NOMINAL_ALPHA;
  return {
    hypotheses,
    expectedByChance: expected,
    fdr: FDR,
    text:
      hypotheses === 0
        ? "Nothing is being tested, so there is nothing to correct."
        : `${hypotheses.toLocaleString()} hypotheses will be tested. On data with nothing in it whatsoever, about ` +
          `${expected < 1 ? expected.toFixed(1) : Math.round(expected).toLocaleString()} of them would clear plain 5% significance by luck alone. ` +
          `Every p-value in this study is therefore put through Benjamini–Hochberg at a ${Math.round(FDR * 100)}% false-discovery rate, and the ` +
          `best strategy result is reported deflated for having been the best of ${hypotheses.toLocaleString()} tries — beside the raw figure, not instead of it.`,
  };
}

/**
 * Fold a completed run's real cost back into the timings.
 *
 * A running mean rather than a replacement: one cold run on a machine that was
 * also building a bundle should not become the estimate for every run after
 * it. Capped at sixteen so the figure still follows a machine that got faster,
 * which a true lifetime mean would take a hundred runs to notice.
 */
export const TIMING_WINDOW = 16;

export function recordTiming(
  timings: Timings,
  methodId: string,
  rows: number,
  ms: number,
): Timings {
  const kRows = Math.max(0, rows) / 1000;
  if (!Number.isFinite(ms) || ms < 0) return timings;
  const prev = timings[methodId];
  /* The split between fixed and per-row cost cannot be recovered from a single
     observation, so the fixed part is kept from the catalogue's guess and the
     whole of the remainder is attributed to the rows. Crude, and it converges
     on the right total for the size of study actually being run, which is the
     figure the operator is shown. */
  const method = METHOD_BY_ID.get(methodId);
  const fixedMs = prev?.fixedMs ?? method?.guessFixedMs ?? 0;
  const perK = kRows > 0 ? Math.max(0, ms - fixedMs) / kRows : (prev?.msPerKRow ?? 0);
  const runs = Math.min(TIMING_WINDOW, (prev?.runs ?? 0) + 1);
  const weight = 1 / runs;
  return {
    ...timings,
    [methodId]: {
      fixedMs,
      msPerKRow: prev === undefined ? perK : prev.msPerKRow * (1 - weight) + perK * weight,
      runs,
    },
  };
}
