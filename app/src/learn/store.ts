/**
 * Where what the terminal learns is kept, and what it deliberately will not do.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REFUSAL, FIRST, BECAUSE IT IS THE DESIGN
 *
 * Nothing in this module feeds back. No score is adjusted from an outcome, no
 * gate threshold moves because a claim failed, no weight in `core/decision.ts`
 * is touched by anything stored here. The store measures the terminal and
 * stops.
 *
 * That is not an unfinished feature. A closed loop here would be the fastest
 * possible route to the failure this repository has already measured once: the
 * shipped strategy set has a PBO of 89%, meaning the best-looking candidate
 * out of sample is worse than the median about nine times in ten. Feeding
 * outcomes back into the weights that produced them, on a few dozen samples,
 * on one operator's instruments, is that same mechanism with a shorter loop
 * and no out-of-sample split to catch it. It would produce a terminal that
 * agreed with its own recent history and called the agreement learning.
 *
 * So the loop stays open, and the human closes it. The desk reports what the
 * terminal claimed and what happened; changing the rules in response is a
 * decision, made in Settings, by somebody who can be held to it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVICTION SPARES PENDING CLAIMS
 *
 * Same rule as the journal's open trades, for a sharper reason. Claims resolve
 * on a delay — that is what they are — so the newest ones are always the
 * unresolved ones. An eviction that ran over the whole list by age would drop
 * the oldest, which is right, but a cap hit during a burst of recording would
 * drop claims that were still waiting to be marked. Every claim evicted while
 * pending is a claim the terminal made and then quietly lost the record of,
 * and losing exactly the ones that would have counted against it is the one
 * bias this store must not have.
 */

import { signal, type ReadSignal, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import type { BarView } from "../chart/series";
import { buildClaim, sanitiseClaim, shouldRecord, type Claim, type ClaimDraft, type ClaimResult } from "./claim";
import { buildRun, sanitiseRun, type ModelRun, type RunDraft } from "./run";
import { sweep, type SweepReport } from "./resolve";

/**
 * Caps.
 *
 * Claims are ~350 bytes each; 4,000 is about 1.4MB against a ~5MB localStorage
 * budget shared with the journal, the drawings and the alert book. Runs are
 * larger and rarer.
 */
export const MAX_CLAIMS = 4000;
export const MAX_RUNS = 400;

const CLAIMS_SLOT = {
  key: "learn.claims",
  version: 1,
  fallback: (): Claim[] => [],
  validate: (v: unknown): Claim[] | null => {
    if (!Array.isArray(v)) return null;
    const out: Claim[] = [];
    for (const raw of v) {
      const c = sanitiseClaim(raw);
      if (c !== null) out.push(c);
    }
    return out;
  },
};

const RUNS_SLOT = {
  key: "learn.runs",
  version: 1,
  fallback: (): ModelRun[] => [],
  validate: (v: unknown): ModelRun[] | null => {
    if (!Array.isArray(v)) return null;
    const out: ModelRun[] = [];
    for (const raw of v) {
      const r = sanitiseRun(raw);
      if (r !== null) out.push(r);
    }
    return out;
  },
};

/** Whether the terminal writes its reads down at all. */
const ENABLED_SLOT = {
  key: "learn.enabled",
  version: 1,
  fallback: (): boolean => true,
  validate: (v: unknown): boolean | null => (typeof v === "boolean" ? v : null),
};

export interface LearnStore {
  readonly claims: Signal<readonly Claim[]>;
  readonly runs: Signal<readonly ModelRun[]>;
  /**
   * Off means nothing new is recorded. What is stored is kept and still shown.
   *
   * READ-ONLY ON PURPOSE — write it through `setEnabled`.
   *
   * The first version of this was a writable signal with a persistence
   * `effect` beside it, which is the idiom the rest of the terminal uses and
   * is wrong here for a reason a test caught: effects in this graph flush on a
   * MICROTASK, so `enabled.set(false)` returns with the flag flipped on screen
   * and nothing yet written to storage. Every real browser flush lands a tick
   * later and hides it — but the window is real, and a preference that is not
   * durable at the moment it is changed is not a preference.
   *
   * Making the write part of the setter also deletes the temporal-dead-zone
   * hazard that has bitten `shell.ts` four times: there is no effect left to
   * run early, throw, be swallowed by `createReaction`, and silently stop
   * saving with nothing on screen to say so.
   */
  readonly enabled: ReadSignal<boolean>;
  /** Flip recording, and write it through in the same call. */
  setEnabled(on: boolean): void;
  readonly lastError: Signal<string>;

  /**
   * Record a read, if it is worth recording.
   *
   * Returns the reason it was not, so a caller that wants to explain itself
   * can. Silent no-ops here would make "why is nothing being recorded" an
   * unanswerable question, and the desk asks it out loud.
   */
  record(draft: ClaimDraft, now?: number): ClaimResult | { ok: false; reason: string };

  /** Mark every pending claim that the supplied bars can settle. */
  resolvePending(barsFor: (symbol: string, timeframe: string) => readonly BarView[]): SweepReport;

  addRun(draft: RunDraft, now?: number): ModelRun;
  pinRun(id: string, pinned: boolean): void;
  noteRun(id: string, note: string): void;
  removeRun(id: string): void;

  /** Delete claims. Returns how many went. */
  forgetClaims(filter: (c: Claim) => boolean): number;
  forgetSymbol(symbol: string): number;
  /** Everything except pinned runs. The pin is the whole point of the pin. */
  forgetAll(): { claims: number; runs: number };

  /** The whole memory, for export. */
  snapshot(): { claims: readonly Claim[]; runs: readonly ModelRun[] };
  /** Merge an export back in, skipping ids already present. */
  merge(incoming: { claims?: readonly unknown[]; runs?: readonly unknown[] }): { claims: number; runs: number };
}

export function createLearnStore(kv: KV, now: () => number = Date.now): LearnStore {
  const claims = signal<readonly Claim[]>(kv.read(CLAIMS_SLOT).value);
  const runs = signal<readonly ModelRun[]>(kv.read(RUNS_SLOT).value);
  const enabled = signal<boolean>(kv.read(ENABLED_SLOT).value);
  const lastError = signal("");

  const persistClaims = (next: readonly Claim[]): void => {
    const trimmed = evictClaims(next);
    claims.set(trimmed);
    const res = kv.write(CLAIMS_SLOT, [...trimmed]);
    lastError.set(res.ok ? "" : `Track record not saved — ${res.error}`);
  };

  const persistRuns = (next: readonly ModelRun[]): void => {
    const trimmed = evictRuns(next);
    runs.set(trimmed);
    const res = kv.write(RUNS_SLOT, [...trimmed]);
    lastError.set(res.ok ? "" : `Model runs not saved — ${res.error}`);
  };

  return {
    claims,
    runs,
    enabled,
    lastError,

    setEnabled(on) {
      if (enabled.peek() === on) return;
      enabled.set(on);
      const res = kv.write(ENABLED_SLOT, on);
      if (!res.ok) lastError.set(`Recording switch not saved — ${res.error}`);
    },

    record(draft, at = now()) {
      if (!enabled.peek()) {
        return { ok: false, reason: "Recording is switched off, so this read was not written down." };
      }
      if (!shouldRecord(claims.peek(), draft, at)) {
        return {
          ok: false,
          reason: "Already have a claim on this instrument saying the same thing recently. One per half hour unless the read changes its mind.",
        };
      }
      const built = buildClaim(draft, at);
      if (!built.ok) return built;
      persistClaims([...claims.peek(), built.claim]);
      return built;
    },

    resolvePending(barsFor) {
      const report = sweep(claims.peek(), barsFor);
      if (report.resolved.length > 0) {
        const byId = new Map(report.resolved.map((c) => [c.id, c]));
        persistClaims(claims.peek().map((c) => byId.get(c.id) ?? c));
      }
      return report;
    },

    addRun(draft, at = now()) {
      const run = buildRun(draft, at);
      persistRuns([...runs.peek(), run]);
      return run;
    },

    pinRun(id, pinned) {
      persistRuns(runs.peek().map((r) => (r.id === id ? { ...r, pinned } : r)));
    },

    noteRun(id, note) {
      persistRuns(runs.peek().map((r) => (r.id === id ? { ...r, note } : r)));
    },

    removeRun(id) {
      persistRuns(runs.peek().filter((r) => r.id !== id));
    },

    forgetClaims(filter) {
      const before = claims.peek();
      const kept = before.filter((c) => !filter(c));
      const gone = before.length - kept.length;
      if (gone > 0) persistClaims(kept);
      return gone;
    },

    forgetSymbol(symbol) {
      const s = symbol.toUpperCase();
      const before = claims.peek();
      const kept = before.filter((c) => c.symbol !== s);
      const gone = before.length - kept.length;
      if (gone > 0) persistClaims(kept);
      const runsBefore = runs.peek();
      const runsKept = runsBefore.filter((r) => r.symbol !== s || r.pinned);
      if (runsKept.length !== runsBefore.length) persistRuns(runsKept);
      return gone;
    },

    forgetAll() {
      const c = claims.peek().length;
      const keptRuns = runs.peek().filter((r) => r.pinned);
      const r = runs.peek().length - keptRuns.length;
      persistClaims([]);
      persistRuns(keptRuns);
      return { claims: c, runs: r };
    },

    snapshot() {
      return { claims: claims.peek(), runs: runs.peek() };
    },

    merge(incoming) {
      const haveClaims = new Set(claims.peek().map((c) => c.id));
      const freshClaims = (incoming.claims ?? [])
        .map(sanitiseClaim)
        .filter((c): c is Claim => c !== null && !haveClaims.has(c.id));
      if (freshClaims.length > 0) persistClaims([...claims.peek(), ...freshClaims]);

      const haveRuns = new Set(runs.peek().map((r) => r.id));
      const freshRuns = (incoming.runs ?? [])
        .map(sanitiseRun)
        .filter((r): r is ModelRun => r !== null && !haveRuns.has(r.id));
      if (freshRuns.length > 0) persistRuns([...runs.peek(), ...freshRuns]);

      return { claims: freshClaims.length, runs: freshRuns.length };
    },
  };
}

/**
 * Drop the oldest RESOLVED claims until the list fits.
 *
 * Pending claims are exempt — see the header. If the cap is exceeded on
 * pending claims alone the list is kept whole and the cap is exceeded, because
 * dropping unresolved claims is how a track record silently improves.
 */
export function evictClaims(list: readonly Claim[]): readonly Claim[] {
  if (list.length <= MAX_CLAIMS) return list;
  const pending = list.filter((c) => c.outcome === "pending");
  const settled = list.filter((c) => c.outcome !== "pending").sort((a, b) => a.at - b.at);
  const room = Math.max(0, MAX_CLAIMS - pending.length);
  const kept = settled.slice(settled.length - room);
  return [...kept, ...pending].sort((a, b) => a.at - b.at);
}

/** Oldest unpinned runs go first; pinned runs are never evicted. */
export function evictRuns(list: readonly ModelRun[]): readonly ModelRun[] {
  if (list.length <= MAX_RUNS) return list;
  const pinned = list.filter((r) => r.pinned);
  const rest = list.filter((r) => !r.pinned).sort((a, b) => a.at - b.at);
  const room = Math.max(0, MAX_RUNS - pinned.length);
  const kept = rest.slice(rest.length - room);
  return [...kept, ...pinned].sort((a, b) => a.at - b.at);
}
