/**
 * "Watch for new setups": re-scan the universe once per closed bar, and say
 * which of the setups that appeared are worth interrupting the operator for.
 *
 * WHY THIS IS A SEPARATE, CLOCK-INJECTED MODULE
 * Everything that decides WHEN a scan runs and WHETHER a result notifies is
 * here, with no timers, no DOM and no signals of its own. The shell supplies a
 * clock (`setTimeout`, `document.hidden`); the tests supply a fake one and step
 * it through hours of bar closes in microseconds. A scheduler that can only be
 * checked by waiting an hour is a scheduler nobody checks.
 *
 * THE FOUR PROMISES IT KEEPS
 *  - At most ONE scan per closed bar of the timeframe. Each scan is recorded
 *    against the close it covers, and a close already covered is never scanned
 *    again — not by a hide/return, not by a restart, not by a slow scan.
 *  - A scan starts `delayMs` AFTER the close, not on it. The vendor needs a
 *    moment to publish the closed candle; scanning on the boundary reads the
 *    bar before it.
 *  - Nothing runs while the tab is hidden. On return it scans once, and only if
 *    a bar closed meanwhile — three missed closes are one catch-up scan, because
 *    only the latest one describes the market now.
 *  - A timeframe it cannot put on a clock is REFUSED with a reason, never
 *    approximated with an hourly guess.
 *
 * WHAT IT DOES NOT DO
 * Rate limiting and backoff belong to `scanUniverse`, which parks every worker
 * on a 429. This file only guarantees the scans are spaced a bar apart, which is
 * the strongest rate limit available: fifty requests an hour on 1h.
 */

import { compareOpportunities, type Opportunity } from "./opportunity";

/** How long after a bar closes before the scan: the vendor's publication lag. */
export const WATCH_DELAY_MS = 20_000;

const MINUTE = 60_000;
const DAY = 86_400_000;
/** 1970-01-01 was a Thursday; Binance weeks open Monday 00:00 UTC. */
const MONDAY_OFFSET = 4 * DAY;

type Clock =
  | { readonly kind: "fixed"; readonly span: number; readonly offset: number }
  | { readonly kind: "months"; readonly n: number };

function clockOf(timeframe: string): Clock | null {
  const m = /^(\d+)(m|h|d|w|M)$/.exec(timeframe);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  switch (m[2]) {
    case "m":
      return { kind: "fixed", span: n * MINUTE, offset: 0 };
    case "h":
      return { kind: "fixed", span: n * 60 * MINUTE, offset: 0 };
    case "d":
      return { kind: "fixed", span: n * DAY, offset: 0 };
    case "w":
      return { kind: "fixed", span: n * 7 * DAY, offset: MONDAY_OFFSET };
    default:
      /* Calendar months. An average-month span would drift by days. */
      return { kind: "months", n };
  }
}

function monthStart(index: number): number {
  return Date.UTC(1970 + Math.floor(index / 12), ((index % 12) + 12) % 12, 1);
}

/** The latest bar boundary at or before `t`, in UTC. Null when there is no clock. */
export function lastBarClose(timeframe: string, t: number): number | null {
  const c = clockOf(timeframe);
  if (!c) return null;
  if (c.kind === "fixed") return Math.floor((t - c.offset) / c.span) * c.span + c.offset;
  const d = new Date(t);
  const index = (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
  return monthStart(Math.floor(index / c.n) * c.n);
}

/** The first bar boundary strictly after `t`. */
export function nextBarClose(timeframe: string, t: number): number | null {
  const c = clockOf(timeframe);
  const last = lastBarClose(timeframe, t);
  if (!c || last === null) return null;
  if (c.kind === "fixed") return last + c.span;
  const d = new Date(last);
  return monthStart((d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth() + c.n);
}

/**
 * When the next scan is due, and which close it covers.
 *
 * A close counts as available only `delayMs` after it happens. If the latest
 * available close has not been scanned, the scan is due NOW; otherwise it is
 * due `delayMs` after the next close.
 */
export function nextScanAt(
  timeframe: string,
  now: number,
  delayMs: number,
  lastScanned: number | null,
): { at: number; close: number } | null {
  const available = lastBarClose(timeframe, now - delayMs);
  if (available === null) return null;
  if (lastScanned === null || available > lastScanned) return { at: now, close: available };
  const next = nextBarClose(timeframe, now - delayMs);
  if (next === null) return null;
  return { at: next + delayMs, close: next };
}

// ---- which setups notify -----------------------------------------------------

export interface NotifyRule {
  /** Confirmed on one of the last N closed bars: `barsAgo < withinBars`. */
  readonly withinBars: number;
  /** Also demand a measured edge above break-even (thin replays excluded). */
  readonly requireEdge: boolean;
}

export const DEFAULT_NOTIFY_RULE: NotifyRule = { withinBars: 3, requireEdge: false };

/** The windows the desk offers. */
export const WITHIN_CHOICES = [1, 3, 5] as const;

/**
 * Whether one new setup is worth an interruption.
 *
 * Historically ADVERSE is always excluded — the same refusal that sorts it to
 * the bottom of the table. A stale confirmation is excluded because a setup
 * confirmed ten bars ago is not news, whatever the previous scan said.
 */
export function qualifies(o: Opportunity, rule: NotifyRule): boolean {
  if (o.history.adverse) return false;
  if (o.barsAgo >= rule.withinBars) return false;
  if (rule.requireEdge && !(o.edge !== null && o.edge > 0)) return false;
  return true;
}

/** The rule, as one line the desk prints beside the toggle. */
export function ruleText(rule: NotifyRule): string {
  const confirmed =
    rule.withinBars === 1
      ? "confirmed on the last closed bar"
      : `confirmed within the last ${rule.withinBars} closed bars`;
  return rule.requireEdge
    ? `Notifies for new setups that are not historically adverse, were ${confirmed}, and have a measured edge above break-even.`
    : `Notifies for new setups that are not historically adverse and were ${confirmed}.`;
}

export interface NewSetup {
  readonly symbol: string;
  readonly opportunity: Opportunity;
}

/** The new setups that clear the rule, in the table's own order. */
export function notifiable(fresh: readonly NewSetup[], rule: NotifyRule): NewSetup[] {
  return fresh
    .filter((s) => qualifies(s.opportunity, rule))
    .sort((a, b) => compareOpportunities(a.opportunity, b.opportunity));
}

/** "3 new setups on 1h" / "SOLUSDT long · order block, …, +N more". */
export function toastText(timeframe: string, list: readonly NewSetup[], named = 3): { title: string; body: string } {
  const n = list.length;
  const parts = list
    .slice(0, named)
    .map((s) => `${s.symbol} ${s.opportunity.direction} · ${s.opportunity.label}`);
  if (n > named) parts.push(`+${n - named} more`);
  return { title: `${n} new setup${n === 1 ? "" : "s"} on ${timeframe}`, body: parts.join(", ") };
}

// ---- persisted preferences -----------------------------------------------------

export interface WatchPrefs extends NotifyRule {
  readonly on: boolean;
}

export const DEFAULT_WATCH_PREFS: WatchPrefs = { on: false, ...DEFAULT_NOTIFY_RULE };

/** Validator for the KV slot. Null means "not this shape"; the store falls back. */
export function parseWatchPrefs(v: unknown): WatchPrefs | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.on !== "boolean" || typeof r.requireEdge !== "boolean") return null;
  const w = r.withinBars;
  if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 50) return null;
  return { on: r.on, withinBars: w, requireEdge: r.requireEdge };
}

// ---- the loop -------------------------------------------------------------------

export interface WatchClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** `document.hidden`. */
  hidden(): boolean;
}

export interface WatchState {
  readonly on: boolean;
  /** waiting: a timer is set for `nextAt`. paused: tab hidden. refused: no bar clock. */
  readonly phase: "off" | "waiting" | "scanning" | "paused" | "refused";
  readonly nextAt: number | null;
  /** Why it is refused, or the last scan's failure. Empty when there is nothing to say. */
  readonly reason: string;
}

export const WATCH_OFF: WatchState = { on: false, phase: "off", nextAt: null, reason: "" };

export interface WatchLoopDeps {
  readonly clock: WatchClock;
  readonly delayMs: number;
  /** Read at every scheduling decision, so a timeframe change needs only `retime`. */
  timeframe(): string;
  /** Run one scan. A rejection is recorded as the reason; the loop carries on. */
  scan(): Promise<void>;
  /** Abort the scan in flight, if any. */
  abort(): void;
  onState(s: WatchState): void;
}

export function createWatchLoop(deps: WatchLoopDeps) {
  const { clock } = deps;
  let on = false;
  let busy = false;
  let timer: unknown = null;
  /** Bumped by `stop`, so a scan that outlives its loop cannot reschedule it. */
  let generation = 0;
  let failure = "";
  let current: WatchState = WATCH_OFF;
  /** The close each timeframe was last scanned for. */
  const scanned = new Map<string, number>();

  const emit = (s: WatchState): void => {
    current = s;
    deps.onState(s);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (notBefore = 0): void => {
    clearTimer();
    if (!on) return;
    /* The scan's completion reschedules; a second timer now would double it. */
    if (busy) return emit({ on, phase: "scanning", nextAt: null, reason: failure });
    if (clock.hidden()) return emit({ on, phase: "paused", nextAt: null, reason: failure });
    const tf = deps.timeframe();
    const now = clock.now();
    const plan = nextScanAt(tf, now, deps.delayMs, scanned.get(tf) ?? null);
    if (!plan) {
      return emit({ on, phase: "refused", nextAt: null, reason: `"${tf}" has no bar clock to align a scan to.` });
    }
    const at = Math.max(plan.at, notBefore);
    timer = clock.setTimer(fire, at - now);
    emit({ on, phase: "waiting", nextAt: at, reason: failure });
  };

  const fire = (): void => {
    timer = null;
    if (!on || busy) return;
    const tf = deps.timeframe();
    const now = clock.now();
    const plan = nextScanAt(tf, now, deps.delayMs, scanned.get(tf) ?? null);
    /* Hidden, unclocked, or a timer that woke early: let `schedule` decide. */
    if (clock.hidden() || !plan || plan.at > now) return schedule();

    /* Recorded BEFORE the scan: a failed or aborted scan still used this bar's
       turn, or a flaky vendor would be retried every tick of the timer. */
    scanned.set(tf, plan.close);
    busy = true;
    const mine = generation;
    emit({ on, phase: "scanning", nextAt: null, reason: failure });
    void (async () => {
      let outcome = "";
      try {
        await deps.scan();
      } catch (err) {
        outcome = `Last scan failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (mine !== generation) return;
      busy = false;
      failure = outcome;
      schedule();
    })();
  };

  return {
    /** `immediate` scans now if this bar is unscanned; otherwise waits the delay first. */
    start(opts: { immediate: boolean }): void {
      on = true;
      schedule(opts.immediate ? 0 : clock.now() + deps.delayMs);
    },
    stop(): void {
      on = false;
      generation++;
      busy = false;
      failure = "";
      clearTimer();
      deps.abort();
      emit(WATCH_OFF);
    },
    /** The timeframe changed: re-plan on its clock, no sooner than the delay. */
    retime(): void {
      if (on) schedule(clock.now() + deps.delayMs);
    },
    /** Call on `visibilitychange`. */
    visibility(): void {
      if (on) schedule();
    },
    state: (): WatchState => current,
  };
}

export type WatchLoop = ReturnType<typeof createWatchLoop>;
