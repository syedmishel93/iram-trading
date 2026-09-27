/**
 * Automation: when a study re-runs, what happens to the answer, and what stops
 * it running forever.
 *
 * THE FEATURE THAT MATTERS IS NOT THE SCHEDULE
 * Re-running a backtest every morning is easy and nearly useless on its own —
 * it produces a number every day and nobody reads the ninth one. What makes it
 * worth automating is the comparison: the same study, the same window length,
 * the same methods, run again, and the headline number plotted against the
 * last nine. An edge that is quietly dying looks exactly like an edge right up
 * until it is plotted.
 *
 * So `readDecay` is the point of this file and the cadence is plumbing.
 *
 * AND WHY ARMING IS LOCKED
 * "Turn this into a live signal" is the only action here that can lose money,
 * and the holdout is the only evidence that the finding was not fitted. So it
 * is the one action gated on the holdout, and the gate is in the domain rather
 * than in a disabled button — a disabled button is a suggestion.
 */

import type { StudyReport } from "./run";

export type Cadence = "once" | "bar" | "daily" | "weekly" | "trigger";

export const CADENCES: readonly { readonly id: Cadence; readonly label: string; readonly blurb: string }[] = [
  { id: "once", label: "Once", blurb: "Run it now and leave it. The report is kept either way." },
  { id: "bar", label: "Every bar close", blurb: "The most responsive and the most expensive. On an hourly study that is twenty-four runs a day." },
  { id: "daily", label: "Daily", blurb: "One run at the same time each day. Enough to see decay, cheap enough to leave on." },
  { id: "weekly", label: "Weekly", blurb: "For studies whose window is measured in years, where a day changes nothing." },
  { id: "trigger", label: "When something fires", blurb: "On an alert or a regime change, so the re-run answers a question you just had." },
];

export type ActionId = "notify" | "file" | "rerank" | "stale" | "arm";

export const ACTIONS: readonly {
  readonly id: ActionId;
  readonly label: string;
  readonly blurb: string;
  /** Locked actions cannot be switched on until `armable` allows it. */
  readonly locked: boolean;
}[] = [
  { id: "notify", label: "Tell me, with the number that changed", blurb: "A notification carrying the old figure and the new one. A notification that only says a study finished is one you turn off in a week.", locked: false },
  { id: "file", label: "File it in the Library", blurb: "Keep the report beside the others, so a finding has a history rather than a latest value.", locked: false },
  { id: "rerank", label: "Re-rank my watchlist", blurb: "Let what this study measures change the order of the list you look at first.", locked: false },
  { id: "stale", label: "Mark it stale if it decays", blurb: "When the headline falls below the floor below, flag the study instead of carrying on quietly.", locked: false },
  { id: "arm", label: "Arm it as a live signal", blurb: "Turn the finding into alerts on live bars.", locked: true },
];

export interface Guards {
  /** Ceiling on runs per day, whatever the cadence asks for. */
  readonly maxPerDay: number;
  /** Consecutive failures after which the schedule disarms itself. */
  readonly stopAfterFailures: number;
  /**
   * The headline value below which the study is called stale.
   *
   * In the units of whatever the study's strength measure is, which is why
   * `RunSummary` carries the name of that measure beside the number — a floor
   * compared against a different measure is worse than no floor.
   */
  readonly decayFloor: number;
}

export const DEFAULT_GUARDS: Guards = { maxPerDay: 4, stopAfterFailures: 3, decayFloor: 0.55 };

export interface Schedule {
  readonly cadence: Cadence;
  readonly enabled: boolean;
  readonly actions: readonly ActionId[];
  readonly guards: Guards;
}

export const DEFAULT_SCHEDULE: Schedule = {
  cadence: "once",
  enabled: false,
  actions: ["notify", "file"],
  guards: DEFAULT_GUARDS,
};

const DAY_MS = 86_400_000;

/**
 * When this schedule wants to run next, or null when it does not.
 *
 * `bar` needs the timeframe's interval, which the caller has and this file
 * deliberately does not — `intervalMs` lives in `data/history.ts` and
 * importing it here would put the study's automation downstream of the feed
 * for one multiplication.
 */
export function nextRunAt(
  s: Schedule,
  lastRunAt: number | null,
  intervalMs: number,
): number | null {
  if (!s.enabled) return null;
  switch (s.cadence) {
    case "once":
      return lastRunAt === null ? 0 : null;
    case "trigger":
      return null;
    case "bar":
      return (lastRunAt ?? 0) + Math.max(60_000, intervalMs);
    case "daily":
      return (lastRunAt ?? 0) + DAY_MS;
    case "weekly":
      return (lastRunAt ?? 0) + 7 * DAY_MS;
  }
}

export interface GuardVerdict {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * Whether this schedule may run right now.
 *
 * `runsToday` and `failures` come from the record rather than being counted
 * here, so the same verdict can be shown on the desk before the run and
 * enforced by the scheduler at run time from one function.
 */
export function guardCheck(
  s: Schedule,
  runsToday: number,
  consecutiveFailures: number,
): GuardVerdict {
  if (!s.enabled) return { allowed: false, reason: "This schedule is off." };
  if (consecutiveFailures >= s.guards.stopAfterFailures) {
    return {
      allowed: false,
      reason: `Disarmed after ${consecutiveFailures} runs in a row that produced nothing. Something upstream is broken — a dead vendor, a stopped service — and repeating it hourly will not fix it.`,
    };
  }
  if (runsToday >= s.guards.maxPerDay) {
    return {
      allowed: false,
      reason: `${runsToday} runs today, which is the ceiling. Raise it in Guards if this study genuinely changes that often.`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Whether a report may be turned into a live signal.
 *
 * Three gates, and each one has taken money off somebody:
 *   the holdout has never been opened, so nothing here is out of sample;
 *   nothing survived the correction, so the best figure is the best of many;
 *   the study refused outright.
 */
export function armable(report: StudyReport | null): GuardVerdict {
  if (report === null) {
    return { allowed: false, reason: "This study has never produced a report." };
  }
  if (report.refusal !== null) {
    return { allowed: false, reason: report.refusal };
  }
  if (report.holdout === "sealed") {
    return {
      allowed: false,
      reason:
        "The holdout has never been opened, so nothing in this report has been tested on bars the search could not see. Open it once — and understand that opening it spends it.",
    };
  }
  if (report.correction.survivors === 0) {
    return {
      allowed: false,
      reason: `Nothing in this study survives the correction for having tested ${report.correction.hypotheses.toLocaleString()} hypotheses. Arming it would be arming the best of ${report.correction.hypotheses.toLocaleString()} coin flips.`,
    };
  }
  return { allowed: true, reason: null };
}

/* ─────────────────────────────────────────────────────────────────────────── */

export interface StrengthPoint {
  readonly at: number;
  readonly value: number;
  /** What this number IS. Two different measures cannot be plotted together. */
  readonly measure: string;
}

export interface DecayRead {
  readonly runs: number;
  readonly first: number;
  readonly latest: number;
  /** Change in the measure per run. Negative is decay. */
  readonly slope: number;
  readonly decaying: boolean;
  readonly belowFloor: boolean;
  readonly refusal: string | null;
  readonly text: string;
}

const NO_DECAY = (refusal: string): DecayRead => ({
  runs: 0,
  first: NaN,
  latest: NaN,
  slope: NaN,
  decaying: false,
  belowFloor: false,
  refusal,
  text: refusal,
});

/** Runs below which a trend through the points is not worth drawing. */
export const MIN_DECAY_RUNS = 4;

/**
 * Is this study's finding getting weaker.
 *
 * Ordinary least squares through the strength values against run index. Blunt
 * on purpose — four to sixteen points is not enough for anything cleverer, and
 * the question being asked is "is this going down", not "by how much exactly".
 *
 * REFUSES WHEN THE MEASURE CHANGED. A run that reported a deflated Sharpe and
 * a later one that reported one minus an adjusted p-value are two different
 * numbers on one axis, and a line through them means nothing at all. Changing
 * the methods changes the measure, which is precisely when an operator most
 * wants to believe the line.
 */
export function readDecay(points: readonly StrengthPoint[], floor: number): DecayRead {
  const usable = points.filter((p) => Number.isFinite(p.value));
  if (usable.length < MIN_DECAY_RUNS) {
    return NO_DECAY(
      `${usable.length} run${usable.length === 1 ? "" : "s"} with a comparable figure. ${MIN_DECAY_RUNS} is the floor before a trend through them says anything.`,
    );
  }
  const measures = new Set(usable.map((p) => p.measure));
  if (measures.size > 1) {
    return NO_DECAY(
      `These runs did not all report the same measure (${[...measures].join(", ")}). A line through two different quantities is not a trend. Re-run the study with one set of methods to start a comparable history.`,
    );
  }

  const n = usable.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  usable.forEach((p, i) => {
    sx += i;
    sy += p.value;
    sxy += i * p.value;
    sxx += i * i;
  });
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const first = usable[0]?.value ?? NaN;
  const latest = usable[n - 1]?.value ?? NaN;
  const belowFloor = latest < floor;
  const decaying = slope < 0 && latest < first;
  const measure = [...measures][0] ?? "the measure";

  return {
    runs: n,
    first,
    latest,
    slope,
    decaying,
    belowFloor,
    refusal: null,
    text: decaying
      ? `${measure} has fallen from ${first.toFixed(2)} to ${latest.toFixed(2)} over ${n} runs, about ${Math.abs(slope).toFixed(3)} per run.${belowFloor ? ` That is below the ${floor.toFixed(2)} floor.` : ""} A finding that is fading is not a finding that was wrong — it is one whose conditions have changed, and the study will not tell you which.`
      : `${measure} is ${latest.toFixed(2)} against ${first.toFixed(2)} ${n} runs ago. Not falling.${belowFloor ? ` It is, however, below the ${floor.toFixed(2)} floor and was when it started.` : ""}`,
  };
}
