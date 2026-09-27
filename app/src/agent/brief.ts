/**
 * Standing briefs: the analyst watching for something and saying so unprompted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 *
 * The analyst answers when asked and forgets. That makes it a very good
 * reference and a poor colleague: the thing a trader actually wants is not
 * "describe this chart" but "tell me when the 4-hour sweep completes", and
 * nothing in the terminal could hold a question open across bars.
 *
 * A brief is that question, written down, evaluated on bar close.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT SPENDS THE OPERATOR'S MONEY, SO IT IS BUILT LIKE IT
 *
 * Every check is a request to whatever endpoint the operator configured, with
 * their key, on a timer they are not watching. That is the one thing in this
 * codebase that can run up a bill while nobody is looking, and the design
 * follows from it:
 *
 *   - ARMED EXPLICITLY, never by default. A brief that exists is not a brief
 *     that runs.
 *   - ONE CHECK PER BAR CLOSE, with a floor underneath it. A 1-minute chart
 *     would otherwise be 1,440 requests a day per brief; `MIN_INTERVAL_MS`
 *     makes the fastest chart no more expensive than a 5-minute one.
 *   - IT COUNTS. `checks` is on the record and rendered, because a cost the
 *     operator cannot see is one they cannot decide about.
 *   - FIRING DISARMS IT. A brief that has fired stops spending until it is
 *     re-armed by hand. Nothing here retriggers on its own.
 *   - THE TAB BEING HIDDEN DOES NOT MATTER, but a stopped feed does: a brief
 *     is evaluated against bars, so no new bar means no new check.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE OFFLINE ANALYST CANNOT DO THIS, AND SAYS SO
 *
 * `offlineProvider` is a template over tool results with no language model
 * behind it. Handed "tell me when momentum gives out" it would run its usual
 * tools and compose its usual paragraph, and something would have to decide
 * from that whether the brief had fired. Whatever decided would be inventing
 * an answer to a question nobody could parse.
 *
 * So arming is refused unless the selected provider can actually read the
 * brief, and the refusal names the provider rather than failing quietly. A
 * watcher that silently never fires is worse than one that will not start:
 * the operator believes something is being watched.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A FIRING IS AND IS NOT
 *
 * It is a notification with a sentence and a timestamp. It is NOT a trade, a
 * plan, or an instruction, and it does not touch the gates, the score or the
 * setup card. The terminal's existing refusal stands: nothing here auto-
 * executes, and a model noticing something is the beginning of a decision
 * rather than the end of one.
 */

import { signal, type ReadSignal, type Signal } from "../core/signal";

/**
 * The floor between checks, whatever the timeframe.
 *
 * Five minutes. A 1-minute chart closes 1,440 bars a day and a brief that
 * honoured every one of them would be 1,440 paid requests per brief per day —
 * enough to matter, and for a question whose answer almost never changes
 * inside five minutes.
 */
export const MIN_INTERVAL_MS = 5 * 60_000;

/** Longest a brief runs before it needs re-arming. Nothing watches for ever. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Providers that cannot read a brief. See the header. */
export const SIGHTLESS_PROVIDERS = new Set(["offline", "local"]);

export type BriefState = "idle" | "armed" | "fired" | "expired";

export interface Brief {
  readonly id: string;
  /** What to watch for, in the operator's own words. */
  readonly text: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly createdAt: number;
  readonly state: BriefState;
  /** When it was last evaluated. Null before the first check. */
  readonly checkedAt: number | null;
  /** How many paid checks this brief has cost. Rendered, never hidden. */
  readonly checks: number;
  /** When it fired, and what it said. */
  readonly firedAt: number | null;
  readonly firedWhy: string;
  /** The last answer, fired or not, so a brief that never fires is auditable. */
  readonly lastAnswer: string;
}

export interface BriefCheck {
  readonly fired: boolean;
  readonly why: string;
}

/**
 * The instruction the model is evaluated against.
 *
 * Deliberately narrow. The analyst's ordinary system prompt invites analysis,
 * and analysis is exactly what must not happen here — the only useful output
 * is a decision about one condition. A model that starts explaining the market
 * has stopped answering the question.
 */
export const BRIEF_PROMPT = [
  "You are watching one condition on behalf of a trader who is not looking at the screen.",
  "Use the tools to check the CURRENT state. State nothing you did not fetch.",
  "Then answer with exactly one line, in one of these two forms and nothing else:",
  "  FIRED: <one sentence saying what happened, with the numbers you fetched>",
  "  WAITING: <one sentence saying what is still true instead>",
  "Answer FIRED only if the condition is satisfied RIGHT NOW by what the tools returned.",
  "If a tool failed or the data was missing, answer WAITING and say which.",
  "Never answer FIRED because the condition looks close, or likely, or is forming.",
].join("\n");

/**
 * Read the model's verdict.
 *
 * Anything that is not an unambiguous FIRED is a WAITING. That asymmetry is
 * deliberate: a missed firing costs an opportunity, and a false one wakes
 * somebody at three in the morning for a condition that did not happen. The
 * second is far more expensive to the trust the whole feature runs on.
 */
export function parseVerdict(text: string): BriefCheck {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const m = /^\s*(FIRED|WAITING)\s*:\s*(.*)$/i.exec(line);
  if (m === null) {
    return { fired: false, why: line.slice(0, 300) || "The analyst gave no readable answer." };
  }
  return { fired: m[1]?.toUpperCase() === "FIRED", why: (m[2] ?? "").trim().slice(0, 300) };
}

/**
 * Whether a brief may be armed, and why not.
 *
 * TWO CHECKS, because one was not enough and the second is the one that
 * actually bit. The id catches the deterministic analysts, which have no model
 * to read a brief with. `ready` catches the case that looks fine and is not: a
 * provider selected but unconfigured, where the terminal's resilient wrapper
 * quietly answers from the offline analyst instead. Measured live — the chosen
 * provider was "openai", `canArm` cleared it on the id alone, and the brief
 * would have been judged by a template with no key behind it.
 *
 * `ready` is the provider's own `ready()` result, so the reason shown is the
 * provider's own words rather than a second guess at what is missing.
 */
export function canArm(
  providerId: string,
  ready: { ok: boolean; reason?: string } = { ok: true },
): { ok: boolean; reason: string } {
  if (SIGHTLESS_PROVIDERS.has(providerId)) {
    return {
      ok: false,
      reason:
        "The offline and local analysts have no language model behind them, so they cannot judge a brief written in your own words. Choose an OpenAI-compatible or Anthropic provider to arm this.",
    };
  }
  if (!ready.ok) {
    return {
      ok: false,
      reason: `${providerId} is not configured (${ready.reason ?? "missing settings"}), so a brief would be answered by the offline analyst, which cannot judge one.`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * Whether this brief is due a check.
 *
 * Separated out and exported because it is the whole cost model, and a cost
 * model buried in a scheduler is one nobody audits.
 */
export function isDue(b: Brief, now: number, lastBarCloseAt: number): boolean {
  if (b.state !== "armed") return false;
  if (now - b.createdAt > MAX_AGE_MS) return false;
  if (b.checkedAt === null) return true;
  /* Both conditions, not either: a new bar must have closed AND the floor must
     have passed. On a 1-minute chart the floor is what binds; on a daily chart
     the bar close is. */
  if (now - b.checkedAt < MIN_INTERVAL_MS) return false;
  return lastBarCloseAt > b.checkedAt;
}

export interface BriefStoreOptions {
  readonly now?: () => number;
  readonly makeId?: () => string;
}

export interface BriefStore {
  readonly briefs: Signal<readonly Brief[]>;
  add(text: string, symbol: string, timeframe: string): Brief | null;
  arm(id: string): void;
  disarm(id: string): void;
  remove(id: string): void;
  /** Record the outcome of one check. */
  record(id: string, check: BriefCheck): void;
  expireOld(): void;
}

export function createBriefStore(opts: BriefStoreOptions = {}): BriefStore {
  const now = opts.now ?? Date.now;
  let seq = 0;
  const makeId = opts.makeId ?? (() => `brief-${now().toString(36)}-${seq++}`);
  const briefs = signal<readonly Brief[]>([]);

  const update = (id: string, f: (b: Brief) => Brief): void => {
    briefs.set(briefs().map((b) => (b.id === id ? f(b) : b)));
  };

  return {
    briefs,

    add(text, symbol, timeframe) {
      const clean = text.trim();
      /* An empty brief would be evaluated against nothing and answer WAITING
         for ever, at full price. */
      if (clean.length < 4) return null;
      const b: Brief = {
        id: makeId(),
        text: clean.slice(0, 500),
        symbol,
        timeframe,
        createdAt: now(),
        /* NOT armed. Creating a brief and starting to spend on it are two
           decisions and the operator makes both. */
        state: "idle",
        checkedAt: null,
        checks: 0,
        firedAt: null,
        firedWhy: "",
        lastAnswer: "",
      };
      briefs.set([...briefs(), b]);
      return b;
    },

    arm(id) {
      update(id, (b) => ({ ...b, state: "armed", firedAt: null, firedWhy: "" }));
    },
    disarm(id) {
      update(id, (b) => ({ ...b, state: "idle" }));
    },
    remove(id) {
      briefs.set(briefs().filter((b) => b.id !== id));
    },

    record(id, check) {
      update(id, (b) => ({
        ...b,
        checkedAt: now(),
        checks: b.checks + 1,
        lastAnswer: check.why,
        /* Firing DISARMS. Nothing here retriggers on its own — the operator
           has been told, and the brief stops spending until they decide it
           should watch again. */
        ...(check.fired
          ? { state: "fired" as const, firedAt: now(), firedWhy: check.why }
          : {}),
      }));
    },

    expireOld() {
      const t = now();
      briefs.set(
        briefs().map((b) =>
          b.state === "armed" && t - b.createdAt > MAX_AGE_MS ? { ...b, state: "expired" } : b,
        ),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* the watcher                                                                */
/* -------------------------------------------------------------------------- */

export interface WatcherOptions {
  readonly store: BriefStore;
  /**
   * Empty when briefs may run; otherwise the reason they may not.
   *
   * A STRING, not a provider. It took a provider once, and the host passed the
   * resilient wrapper whose id is its own — so `canArm` saw a name that was
   * neither "offline" nor "local", cleared the default offline analyst, and
   * the watcher would have handed a free-text brief to a template. The desk
   * and the watcher now ask the same single question, and the host answers it
   * once.
   */
  readonly blocked: () => string;
  /**
   * Runs one evaluation and returns the model's final text.
   *
   * Injected rather than built here so the watcher is testable without a
   * network, and so the whole tool loop — step caps, cancellation, the image
   * turn — is the SAME code the conversation uses rather than a second
   * implementation that could drift.
   */
  readonly evaluate: (brief: Brief, prompt: string) => Promise<string>;
  /** Epoch ms of the most recent CLOSED bar for the brief's chart. */
  readonly lastBarCloseAt: (symbol: string, timeframe: string) => number;
  readonly onFire: (brief: Brief, why: string) => void;
  readonly now?: () => number;
}

export interface WatcherHandle {
  readonly busy: ReadSignal<boolean>;
  /** Check everything that is due. Resolves when the pass is over. */
  tick(): Promise<void>;
  stop(): void;
}

export function createBriefWatcher(opts: WatcherOptions): WatcherHandle {
  const now = opts.now ?? Date.now;
  const busy = signal(false);
  let stopped = false;
  let running: Promise<void> | null = null;

  const pass = async (): Promise<void> => {
    if (stopped) return;
    opts.store.expireOld();

    if (opts.blocked()) return;

    const due = opts.store
      .briefs()
      .filter((b) => isDue(b, now(), opts.lastBarCloseAt(b.symbol, b.timeframe)));
    if (due.length === 0) return;

    busy.set(true);
    try {
      /* One at a time, deliberately. Briefs share a rate limit and a bill, and
         a burst of parallel requests is the shape most likely to trip a
         vendor's limiter — which would fail the checks rather than speed them
         up. */
      for (const b of due) {
        if (stopped) return;
        let text: string;
        try {
          text = await opts.evaluate(b, BRIEF_PROMPT);
        } catch (err) {
          /* A failed check is recorded as a WAITING with the reason, not
             skipped. A brief that silently stops being checked is one the
             operator still believes is watching. */
          opts.store.record(b.id, {
            fired: false,
            why: `Could not check: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
          });
          continue;
        }
        const verdict = parseVerdict(text);
        opts.store.record(b.id, verdict);
        if (verdict.fired) opts.onFire(b, verdict.why);
      }
    } finally {
      if (!stopped) busy.set(false);
    }
  };

  return {
    busy,
    tick() {
      /* Join an in-flight pass. Bar closes and the interval timer can land
         together, and two overlapping passes would double-charge every due
         brief. */
      if (running !== null) return running;
      running = pass().finally(() => {
        running = null;
      });
      return running;
    },
    stop() {
      stopped = true;
    },
  };
}
