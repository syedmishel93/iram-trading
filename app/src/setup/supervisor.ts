/**
 * The evidence supervisor — the thing that keeps the Setup card's inputs alive.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A MODULE, AND WHY "STAND DOWN" KEPT COMING BACK
 *
 * The Setup card refuses a trade when fewer than 60% of the evidence sources
 * answered. That rule is right and is not what this file changes. What this
 * file changes is that nothing was responsible for GETTING an answer.
 *
 * The first version asked every lane once, on symbol load. A lane that lost
 * that one attempt — the intelligence service still starting, a request that
 * timed out, a moment of no network — was then absent for the rest of the
 * session. Measured on XAUUSD: 71% coverage with the model lanes answering,
 * low thirties without them. The card said STAND DOWN and gave a reason that
 * was true and useless, because the operator had not done anything and could
 * not do anything about it.
 *
 * The second version retried three times, at 6s, 20s and 60s, and then stopped
 * for ever. That is better for a service which is merely slow to start, and no
 * help at all for the case the operator actually hits: a terminal left open
 * for hours, a lane that answered once and went stale, a service restarted at
 * lunchtime that nothing ever asked again. Three attempts inside the first
 * ninety seconds is a warm-up, not a supervisor.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES INSTEAD
 *
 * It never gives up, and it never hammers. A lane that is not answering is
 * re-asked on a backoff that widens to five minutes and then stays there, for
 * as long as the terminal is open. A lane that HAS answered is left alone
 * until its answer ages past the point where it still describes the chart.
 *
 * Three distinctions the old code did not make, each of which changes what the
 * operator should do about it:
 *
 *   ABSENT   this instrument cannot have this evidence — there are no Binance
 *            perpetuals on gold. Never asked, never retried, not a fault.
 *   FAILED   it was asked and it did not answer. Fixable: start the service.
 *   STALE    it answered, a while ago, about an older part of the series.
 *
 * The old code had one state for all three — `null` — so a missing service and
 * a missing market were reported with the same number and the same silence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not decide anything. It fetches, it counts attempts, and it reports.
 * The gate that refuses the trade stays in gates.ts, reading the same evidence
 * it always did. A supervisor that could relax the coverage floor because it
 * was having trouble reaching a service would be a supervisor that trades on
 * its own failures.
 *
 * It also does not invent an answer for a lane that will not answer. There is
 * no last-known-good, no carry-forward, no default. A source that is not
 * answering is reported as not answering.
 */

/** What a lane is doing right now. */
export type LaneState =
  /** Answered, recently enough to still be about this chart. */
  | "fresh"
  /** A request is in flight. */
  | "pending"
  /** Asked, did not answer. Will be asked again. */
  | "failed"
  /** Answered, but long enough ago that it describes an older series. */
  | "stale"
  /** Cannot answer for this instrument. Not a fault, and never retried. */
  | "absent";

export interface LaneSpec {
  readonly id: string;
  /** How the operator sees this source named elsewhere in the terminal. */
  readonly label: string;
  /**
   * Can this lane answer for what is on screen? Read fresh on every sweep: the
   * answer changes when the instrument does.
   */
  readonly applies: () => boolean;
  /** When this lane last produced an answer, or null if it never has. */
  readonly answeredAt: () => number | null;
  /**
   * Ask again. Should resolve rather than reject — a supervisor that can be
   * knocked over by one lane's rejection is the failure it exists to prevent.
   * Rejections are caught here anyway; this is a statement of intent.
   */
  readonly refresh: () => Promise<unknown>;
  /**
   * An answer older than this is stale.
   *
   * Most lanes here do age: a regime fitted twenty minutes ago was fitted on a
   * series that has since moved on.
   */
  readonly maxAgeMs?: number;
}

export interface LaneStatus {
  readonly id: string;
  readonly label: string;
  readonly state: LaneState;
  /** Consecutive failed attempts since this lane last answered. */
  readonly attempts: number;
  readonly answeredAt: number | null;
  /** When the next attempt is due, or null when none is scheduled. */
  readonly nextAttemptAt: number | null;
  /** The last thing that went wrong, verbatim. Empty when nothing has. */
  readonly lastError: string;
}

/**
 * How long to wait after each consecutive failure.
 *
 * Front-loaded because the overwhelming majority of first failures are a local
 * service that has not finished starting, and holding at five minutes because
 * the next most common cause is a service that is not running at all — which a
 * request every five minutes notices within five minutes of it coming back, at
 * a cost of twelve requests an hour.
 */
export const BACKOFF_MS: readonly number[] = [4_000, 12_000, 30_000, 60_000, 120_000, 300_000];

/** Default staleness for a lane that does not name its own. */
export const DEFAULT_MAX_AGE_MS = 15 * 60_000;

export interface SupervisorOptions {
  readonly lanes: readonly LaneSpec[];
  /** Injected so the whole thing can be driven by a fake clock in tests. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => number;
  readonly clearTimer?: (id: number) => void;
  /**
   * False while nobody is looking. A hidden tab is not reading the card, and a
   * terminal left open overnight should not spend the night retrying a service
   * that is switched off. Sweeps resume immediately on `poke`.
   */
  readonly visible?: () => boolean;
  readonly backoff?: readonly number[];
  /** Called whenever the reported status changes, so the UI can re-render. */
  readonly onChange?: (status: readonly LaneStatus[]) => void;
}

export interface SupervisorHandle {
  /**
   * Point the supervisor at an instrument. A different key resets every
   * attempt count and asks everything again — the previous instrument's
   * failures say nothing about this one.
   */
  readonly watch: (key: string) => void;
  /** Ask now for anything not fresh. Safe to call at any time. */
  readonly poke: () => void;
  readonly status: () => readonly LaneStatus[];
  /** True when every lane that CAN answer has, recently. */
  readonly settled: () => boolean;
  readonly stop: () => void;
}

interface LaneRuntime {
  attempts: number;
  inFlight: boolean;
  nextAttemptAt: number | null;
  lastError: string;
}

export function createSupervisor(opts: SupervisorOptions): SupervisorHandle {
  const now = opts.now ?? ((): number => Date.now());
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number): number => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id: number): void => clearTimeout(id));
  const visible = opts.visible ?? ((): boolean => true);
  const backoff = opts.backoff ?? BACKOFF_MS;

  const runtime = new Map<string, LaneRuntime>();
  let key = "";
  let timer: number | null = null;
  let stopped = false;
  let lastReport = "";

  const rt = (id: string): LaneRuntime => {
    let r = runtime.get(id);
    if (!r) {
      r = { attempts: 0, inFlight: false, nextAttemptAt: null, lastError: "" };
      runtime.set(id, r);
    }
    return r;
  };

  const stateOf = (lane: LaneSpec, t: number): LaneState => {
    if (!lane.applies()) return "absent";
    const r = rt(lane.id);
    if (r.inFlight) return "pending";
    const at = lane.answeredAt();
    if (at === null) return r.attempts > 0 ? "failed" : "pending";
    const maxAge = lane.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    return t - at > maxAge ? "stale" : "fresh";
  };

  const status = (): readonly LaneStatus[] => {
    const t = now();
    return opts.lanes.map((lane) => {
      const r = rt(lane.id);
      return {
        id: lane.id,
        label: lane.label,
        state: stateOf(lane, t),
        attempts: r.attempts,
        answeredAt: lane.answeredAt(),
        nextAttemptAt: r.nextAttemptAt,
        lastError: r.lastError,
      };
    });
  };

  const report = (): void => {
    if (!opts.onChange) return;
    const next = status();
    /* Only on a real change. This is called from the sweep, which runs on a
       timer; firing an identical status into a render effect every few seconds
       would repaint the card for nothing. */
    const stamp = next.map((s) => `${s.id}:${s.state}:${s.attempts}`).join("|");
    if (stamp === lastReport) return;
    lastReport = stamp;
    opts.onChange(next);
  };

  const settled = (): boolean => {
    const t = now();
    return opts.lanes.every((lane) => {
      const s = stateOf(lane, t);
      return s === "fresh" || s === "absent";
    });
  };

  const waitFor = (attempts: number): number => {
    const i = Math.min(Math.max(0, attempts), backoff.length - 1);
    return backoff[i] as number;
  };

  /**
   * Issue one request and settle EVERY lane it answers for.
   *
   * `group` is the set of lanes sharing this refresh — derivatives and
   * cross-venue both come out of `refreshDecision`. An earlier draft marked the
   * peers in flight and only ever cleared the first one, so a lane that shared
   * a request went pending and stayed pending for the life of the session:
   * exactly the silent permanent gap this module was written to remove,
   * reintroduced by the deduplication meant to be cheap.
   */
  const ask = (group: readonly LaneSpec[]): void => {
    const asKey = key;
    for (const lane of group) {
      const r = rt(lane.id);
      r.inFlight = true;
      r.nextAttemptAt = null;
    }
    const settle = (error: string): void => {
      /* The instrument moved on while this was in flight. Recording either an
         attempt or a success against the new instrument would be recording the
         wrong chart's outcome — the same class of mistake as a plan built from
         one series and checked against another. */
      if (stopped || asKey !== key) return;
      for (const lane of group) {
        const r = rt(lane.id);
        r.inFlight = false;
        if (error) {
          r.attempts++;
          r.lastError = error;
        } else if (lane.answeredAt() !== null) {
          r.attempts = 0;
          r.lastError = "";
        } else {
          /* Resolved without producing an answer: a service that returned a
             shape we could not use, or one lane of a shared request that had
             nothing for this instrument. A failure with no error text, and
             counting it is what keeps the backoff honest. */
          r.attempts++;
          r.lastError = r.lastError || "answered with nothing usable";
        }
      }
      /* SCHEDULE FIRST. `report` snapshots `nextAttemptAt`, and the card turns
         that into "retrying in 42s". Reporting before the next attempt has been
         scheduled hands the card a null and it can only say "still retrying" —
         true, and exactly the vagueness this whole module exists to remove. */
      schedule();
      report();
    };
    const first = group[0];
    if (!first) return;
    void Promise.resolve()
      .then(() => first.refresh())
      .then(
        () => settle(""),
        (e: unknown) => settle(e instanceof Error ? e.message : String(e)),
      );
  };

  /** Ask every lane that is due, then arm the timer for the next one. */
  const sweep = (): void => {
    if (stopped) return;
    timer = null;
    if (!visible()) {
      /* Not a give-up: `poke` on becoming visible runs the sweep immediately.
         Leaving the timer disarmed is what stops an overnight tab retrying a
         switched-off service four hundred times before anyone looks at it. */
      report();
      return;
    }

    const t = now();
    /**
     * Lanes may share one request — the crypto derivatives read and the
     * cross-venue read both come out of `refreshDecision`. Calling it once per
     * lane would multiply the outbound traffic and, on Binance, earn a rate
     * limit for asking the same question three times. Dedupe by the function
     * itself: two lanes with the same refresh are two views of one request.
     */
    const groups = new Map<LaneSpec["refresh"], LaneSpec[]>();
    for (const lane of opts.lanes) {
      /* Read `inFlight` rather than the reported state. A lane that has never
         been asked and a lane whose request is out both report "pending" —
         they look the same to the operator and are opposites here. Deciding
         from the report instead of the runtime is how the first draft of this
         file managed to never ask anything at all. */
      if (!lane.applies()) continue;
      const r = rt(lane.id);
      if (r.inFlight) continue;
      if (stateOf(lane, t) === "fresh") continue;
      if (r.nextAttemptAt !== null && r.nextAttemptAt > t) continue;
      const group = groups.get(lane.refresh);
      if (group) group.push(lane);
      else groups.set(lane.refresh, [lane]);
    }
    for (const group of groups.values()) ask(group);
    schedule();
    report();
  };

  /** Arm a single timer for the earliest lane that will next be due. */
  const schedule = (): void => {
    if (stopped) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const t = now();
    let soonest = Infinity;
    for (const lane of opts.lanes) {
      if (!lane.applies()) continue;
      const r = rt(lane.id);
      if (r.inFlight) continue;
      const s = stateOf(lane, t);
      if (s === "fresh") {
        /* Even a fresh lane has a next appointment: the moment it goes stale.
           Without this a terminal that reached full coverage would never look
           at its evidence again. */
        const at = lane.answeredAt();
        if (at === null) continue;
        soonest = Math.min(soonest, at + (lane.maxAgeMs ?? DEFAULT_MAX_AGE_MS) - t);
        continue;
      }
      if (r.nextAttemptAt === null) r.nextAttemptAt = t + waitFor(r.attempts);
      soonest = Math.min(soonest, r.nextAttemptAt - t);
    }
    if (!Number.isFinite(soonest)) return;
    /* NEVER ZERO. A lane sitting exactly on its staleness boundary reports
       fresh (`t - at > maxAge` is false at equality) and asks to be looked at
       in zero milliseconds — which re-runs this function at the same instant,
       which asks for zero again. One millisecond is enough to cross the
       boundary and turn the spin into progress. Found by a test suite that
       hung rather than failed. */
    timer = setTimer(sweep, Math.max(1, soonest));
  };

  const watch = (next: string): void => {
    if (next === key) return;
    key = next;
    runtime.clear();
    lastReport = "";
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    sweep();
  };

  const poke = (): void => {
    if (stopped) return;
    /* Clear the waits rather than merely running the sweep: a poke is the tab
       or the operator saying "conditions have changed", and honouring a
       backoff earned under the old conditions would ignore them. */
    for (const r of runtime.values()) r.nextAttemptAt = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    sweep();
  };

  return {
    watch,
    poke,
    status,
    settled,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * One line saying what is being waited for, or "" when nothing is.
 *
 * Lives here rather than in the card because it is the sentence that makes the
 * difference between "34% coverage" and "34% coverage BECAUSE the regime
 * service is not answering, and it will be asked again in a minute" — and that
 * sentence has to be true, which means building it from the same runtime state
 * the retries are driven by.
 */
export function supervisorLine(status: readonly LaneStatus[], now: number): string {
  /* `pending` counts too, but only once a lane has already failed at least
     once. Without it the line vanishes for the second or two each retry is in
     flight and comes back after — a message that blinks is read as a glitch,
     and the operator learns to disregard the one line on this card that tells
     them what to do. A lane pending on its very first attempt is not something
     to report: nothing has gone wrong yet. */
  const waiting = status.filter(
    (s) => s.state === "failed" || s.state === "stale" || (s.state === "pending" && s.attempts > 0),
  );
  if (waiting.length === 0) return "";
  const names = waiting.map((s) => s.label).join(", ");
  const asking = waiting.some((s) => s.state === "pending");
  const next = waiting
    .map((s) => s.nextAttemptAt)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  const when = asking
    ? "Asking again now"
    : next === undefined
      ? "Still retrying"
      : next - now <= 1_000
        ? "Retrying now"
        : `Retrying in ${Math.max(1, Math.round((next - now) / 1000))}s`;
  const noun = waiting.length === 1 ? "source is" : "sources are";
  return `${waiting.length} ${noun} not answering — ${names}. ${when}.`;
}
