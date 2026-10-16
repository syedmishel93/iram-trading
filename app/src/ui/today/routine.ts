/**
 * THE THING YOU DO BEFORE YOU TRADE, IN ORDER.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Every piece of a pre-market routine is already in this terminal — what is
 * scheduled today, how much of the daily loss limit is left, whether the data
 * is current, what is on the list, whether a plan was written, whether an
 * alert can actually reach you, whether yesterday was reviewed. What is
 * missing is the ORDER. Seven answers spread across six desks is not a
 * routine; it is six places to remember to look, and the one you forget is the
 * one that mattered.
 *
 * So this is one list, in the sequence a person actually works, and it
 * computes nothing of its own. Every step is handed its answer and reports it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * "COULD NOT ASK" IS ITS OWN STATE, AND THAT IS MOST OF THE DESIGN
 *
 * The easy version has two states, done and not done, and renders an
 * unanswerable step as one or the other. Both are lies, and this repository
 * records the cost of each: a status strip painted "0 of 0 running" green
 * because a loop that had never ticked reported nothing, and a risk desk
 * reporting a flat book because an unknown unit defaulted to one.
 *
 * `unknown` therefore never counts as done and never counts as a failure. It
 * carries why it could not be answered, and the summary says how many steps
 * are in it — because "five of seven, two I could not check" is a different
 * morning from "five of seven".
 *
 * AND AN EMPTY ROUTINE IS NOT A FINISHED ONE. `summarise` refuses to
 * congratulate a list it could not read, the same way `verdict()` had to stop
 * concluding "go" from no gates at all.
 */

/** Where a step stands. `unknown` is a real answer, never a default. */
export type StepState = "done" | "todo" | "blocked" | "unknown";

export interface RoutineStep {
  readonly id: string;
  /** What you are doing, in the words you would use. */
  readonly label: string;
  readonly state: StepState;
  /**
   * One short line: the fact, with its number.
   *
   * The reasoning goes behind "Why?" in the card, never here — the house rule
   * is that shortening MOVES detail rather than deleting it.
   */
  readonly says: string;
  /** The desk that answers this, so the step is one click from being done. */
  readonly desk: string;
}

/**
 * What the routine needs to know, all of it optional.
 *
 * EVERY FIELD CAN BE ABSENT, because every one of them comes from something
 * that can fail to answer: a service that is down, a store that is empty, a
 * desk that has not been opened yet. An absent field becomes `unknown` with a
 * reason, never a zero — rendering an unreachable service as 0 is the most
 * alarming possible way to say "fine", and rendering it as done is the most
 * dangerous.
 */
export interface RoutineInput {
  /** Age of the newest bar, in minutes. */
  readonly dataAgeMin?: number;
  /** How stale is too stale for the timeframe being traded. */
  readonly dataStaleAfterMin?: number;
  /** Scheduled economic events in the session ahead. */
  readonly eventsToday?: number;
  /** High-impact ones among them. */
  readonly eventsHigh?: number;
  /** The governor's own verdict. `null` means it was asked and refused. */
  readonly canTrade?: boolean | null;
  /** Share of the daily loss limit already used, 0 to 1. */
  readonly dayLossUsed?: number;
  readonly watchCount?: number;
  /**
   * Whether a scan has run at all, when WHEN it ran is not known.
   *
   * Separate from `scannedAgoMin` on purpose. The Today desk knows a scan
   * happened and does not keep its time, and the two obvious bodges are both
   * lies: passing 0 claims it was scanned this minute, and leaving it out
   * claims it was never scanned. A boolean says the true, weaker thing.
   */
  readonly scanned?: boolean;
  /** Minutes since the watchlist was last scanned, where that is known. */
  readonly scannedAgoMin?: number;
  /** Whether a plan was written for today. */
  readonly planWritten?: boolean;
  readonly alertsArmed?: number;
  /** Whether a notification can actually reach the operator. */
  readonly alertsCanReach?: boolean;
  /** Whether the previous session was reviewed in the journal. */
  readonly reviewedYesterday?: boolean;
}

const step = (
  id: string,
  label: string,
  desk: string,
  state: StepState,
  says: string,
): RoutineStep => ({ id, label, state, says, desk });

/** The sentence an unanswerable step carries. Never a number. */
const CANNOT = (what: string): string => `Could not check — ${what}.`;

/**
 * The routine, in the order a person works it.
 *
 * The sequence is not arbitrary and is not alphabetical: it runs from what you
 * cannot change (the data, what is scheduled) through what you decide (the
 * list, the plan) to what has to be true before any of it matters (that the
 * governor will let you trade, and that an alert can reach you). Reviewing
 * yesterday sits last because it is the one step that is about the past.
 */
export function buildRoutine(i: RoutineInput): readonly RoutineStep[] {
  const out: RoutineStep[] = [];

  /* 1. Is what I am looking at current? */
  if (i.dataAgeMin === undefined) {
    out.push(step("data", "Check the data is current", "system", "unknown", CANNOT("no feed answered")));
  } else {
    const limit = i.dataStaleAfterMin ?? 15;
    const fresh = i.dataAgeMin <= limit;
    out.push(
      step(
        "data",
        "Check the data is current",
        "system",
        fresh ? "done" : "blocked",
        fresh
          ? `Newest bar ${Math.round(i.dataAgeMin)}m old.`
          : `Newest bar ${Math.round(i.dataAgeMin)}m old, past the ${limit}m you allow.`,
      ),
    );
  }

  /* 2. What is scheduled that could move it? */
  if (i.eventsToday === undefined) {
    out.push(step("events", "See what is scheduled", "briefing", "unknown", CANNOT("the calendar did not answer")));
  } else {
    const high = i.eventsHigh ?? 0;
    out.push(
      step(
        "events",
        "See what is scheduled",
        "briefing",
        "done",
        i.eventsToday === 0
          ? "Nothing scheduled today."
          : `${i.eventsToday} scheduled${high > 0 ? `, ${high} high impact` : ""}.`,
      ),
    );
  }

  /* 3. What am I watching, and has anything looked at it today? */
  if (i.watchCount === undefined) {
    out.push(step("list", "Scan the list", "screener", "unknown", CANNOT("the watchlist could not be read")));
  } else if (i.watchCount === 0) {
    out.push(step("list", "Scan the list", "watchlist", "todo", "Nothing on your list yet."));
  } else if (i.scannedAgoMin === undefined) {
    /* A scan with no time on it is still a scan. Reporting it as "not scanned
       yet" would send the operator to redo work they have already done. */
    out.push(
      i.scanned === true
        ? step("list", "Scan the list", "screener", "done", `${i.watchCount} scanned.`)
        : step("list", "Scan the list", "screener", "todo", `${i.watchCount} on the list, not scanned yet.`),
    );
  } else {
    const recent = i.scannedAgoMin <= 240;
    out.push(
      step(
        "list",
        "Scan the list",
        "screener",
        recent ? "done" : "todo",
        recent
          ? `${i.watchCount} scanned ${Math.round(i.scannedAgoMin)}m ago.`
          : `Last scan ${Math.round(i.scannedAgoMin / 60)}h ago.`,
      ),
    );
  }

  /* 4. Did I write down what I intend to do? */
  if (i.planWritten === undefined) {
    out.push(step("plan", "Write the plan", "briefing", "unknown", CANNOT("the plan could not be read")));
  } else {
    out.push(
      step(
        "plan",
        "Write the plan",
        "briefing",
        i.planWritten ? "done" : "todo",
        i.planWritten ? "Written for today." : "Nothing written for today.",
      ),
    );
  }

  /* 5. Will the governor let me? This is the one that can stop the day. */
  if (i.canTrade === undefined || i.canTrade === null) {
    out.push(step("limits", "Check your limits", "risk", "unknown", CANNOT("the risk service did not answer")));
  } else if (!i.canTrade) {
    out.push(step("limits", "Check your limits", "risk", "blocked", usedLine(i.dayLossUsed, true)));
  } else {
    out.push(step("limits", "Check your limits", "risk", "done", usedLine(i.dayLossUsed, false)));
  }

  /* 6. If it fires while I am not looking, do I hear about it? */
  if (i.alertsArmed === undefined) {
    out.push(step("alerts", "Arm the alerts", "signals", "unknown", CANNOT("the alert book could not be read")));
  } else if (i.alertsArmed === 0) {
    out.push(step("alerts", "Arm the alerts", "signals", "todo", "Nothing armed."));
  } else if (i.alertsCanReach === false) {
    /* ARMED AND UNREACHABLE IS WORSE THAN NOT ARMED, because it looks done.
       This product shipped three loops firing into a channel with no caller. */
    out.push(
      step("alerts", "Arm the alerts", "signals", "blocked", `${i.alertsArmed} armed, but nothing can reach you.`),
    );
  } else {
    out.push(step("alerts", "Arm the alerts", "signals", "done", `${i.alertsArmed} armed.`));
  }

  /* 7. The one step about the past. */
  if (i.reviewedYesterday === undefined) {
    out.push(step("review", "Review the last session", "journal", "unknown", CANNOT("the journal could not be read")));
  } else {
    out.push(
      step(
        "review",
        "Review the last session",
        "journal",
        i.reviewedYesterday ? "done" : "todo",
        i.reviewedYesterday ? "Reviewed." : "Last session not reviewed.",
      ),
    );
  }

  return out;
}

/** The daily-loss line, which is the number worth reading on this step. */
function usedLine(used: number | undefined, stopped: boolean): string {
  if (used === undefined) return stopped ? "Stopped for the day." : "Inside your limits.";
  const pct = Math.round(Math.min(1, Math.max(0, used)) * 100);
  return stopped ? `Stopped — ${pct}% of the daily loss limit used.` : `${pct}% of the daily loss limit used.`;
}

export interface RoutineSummary {
  readonly done: number;
  readonly total: number;
  readonly blocked: number;
  readonly unknown: number;
  /** True only when every step was ANSWERED and none is outstanding. */
  readonly ready: boolean;
  readonly says: string;
}

/**
 * One line about the morning.
 *
 * IT WILL NOT CONGRATULATE A LIST IT COULD NOT READ. `ready` requires every
 * step to have been answered, because "7 of 7" computed over seven unknowns is
 * the same sentence as a real one — which is how a strip came to paint "0 of 0
 * running" green, and how `verdict()` came to conclude "go" from no gates at
 * all. An empty routine is not a finished routine.
 */
export function summarise(steps: readonly RoutineStep[]): RoutineSummary {
  const done = steps.filter((s) => s.state === "done").length;
  const blocked = steps.filter((s) => s.state === "blocked").length;
  const unknown = steps.filter((s) => s.state === "unknown").length;
  const total = steps.length;

  if (total === 0) {
    return { done: 0, total: 0, blocked: 0, unknown: 0, ready: false, says: "Nothing to check yet." };
  }

  const ready = done === total;
  const tail = unknown > 0 ? `, ${unknown} could not be checked` : "";

  return {
    done,
    total,
    blocked,
    unknown,
    ready,
    says: blocked > 0
      ? `${blocked} thing${blocked === 1 ? "" : "s"} stopping you${tail}.`
      : ready
        ? "Ready."
        : `${done} of ${total} done${tail}.`,
  };
}
