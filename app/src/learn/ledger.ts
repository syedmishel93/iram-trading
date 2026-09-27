/**
 * Mirroring claims into the durable ledger.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A MIRROR AND NOT A MOVE
 *
 * The claims stay in the browser. Everything that reads them — the Learning
 * desk, the setup card's record factor, `sweep()` resolving them from bars —
 * keeps reading the local copy, so the terminal works identically with the
 * service stopped, on a plane, on a machine that has never run Python. That is
 * not a fallback; it is the normal case, and a decision aid that stops being
 * able to describe its own record because a service is down would be worse than
 * one that never had a record.
 *
 * What the mirror adds is durability. `store/kv.ts` is localStorage: about five
 * megabytes shared with the drawing store, a five-thousand-entry cap, and — per
 * `store/durability.ts`, which exists because this actually happens — capable
 * of accepting a write and dropping it on teardown. Bars survive that; they
 * re-fetch for free. A claim made in March, before the outcome was known, does
 * not re-fetch from anywhere at any price, and it is always the NEWEST write
 * that fails when a quota is hit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BEST EFFORT, AND IT SAYS WHICH
 *
 * The service is usually not running. So every failure here is silent to the
 * workflow and visible in `state()`: a mirror that raised a toast every thirty
 * seconds because Python was not started would train the operator to ignore
 * toasts, and a mirror that failed with no trace at all would let somebody
 * believe they had a backup they did not have. The state is the honest middle.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LOCALHOST ONLY, BY CONSTRUCTION
 *
 * The default target is the operator's own machine — the same service already
 * answering regime and forecast. `looksLocal` refuses anything else unless it
 * is passed explicitly, because a claims ledger is a record of somebody's
 * trading decisions and it must not become the kind of thing that quietly
 * starts pointing at a host they did not choose.
 */

import { signal, type ReadSignal } from "../core/signal";
import type { Claim } from "./claim";
import { serviceBase } from "../data/backend";

export const DEFAULT_LEDGER_URL = (): string => serviceBase();

/** Most claims in one request. The service refuses more than 5,000. */
export const MAX_BATCH = 2000;

export type LedgerState = "idle" | "pushing" | "ok" | "unreachable" | "refused";

export interface LedgerStatus {
  readonly state: LedgerState;
  /** Claims accepted by the service in the last successful push. */
  readonly written: number;
  /** When that push completed. Null before the first one. */
  readonly at: number | null;
  /** Plain sentence, safe to render. Never blames the operator for a stopped service. */
  readonly note: string;
}

export interface LedgerOptions {
  readonly url?: string;
  readonly claims: ReadSignal<readonly Claim[]>;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface LedgerHandle {
  readonly status: ReadSignal<LedgerStatus>;
  /** Push everything not yet acknowledged. Resolves when the attempt is over. */
  push(): Promise<void>;
  stop(): void;
}

/**
 * Whether a URL is this machine.
 *
 * Hostname only. `http://127.0.0.1.evil.com` contains "127.0.0.1" and is not
 * local, which is the whole reason this is a parsed comparison rather than a
 * substring test.
 */
export function looksLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** The wire shape. Field names match what `mishel_claims.sanitise` reads. */
export function toWire(c: Claim, setupKind: string | null = null): Record<string, unknown> {
  return {
    id: c.id,
    at: c.at,
    symbol: c.symbol,
    timeframe: c.timeframe,
    side: c.side,
    verdict: c.verdict,
    setupKind,
    gatesFailed: c.gatesFailed,
    score: c.score,
    coverage: c.coverage,
    confidence: c.confidence,
    probability: c.probability,
    entry: c.entry,
    stop: c.stop,
    target: c.target,
    expiresAt: c.expiresAt,
    outcome: c.outcome,
    resolvedAt: c.resolvedAt,
    resolvedPrice: c.resolvedPrice,
    heldMs: c.heldMs,
  };
}

/**
 * What still needs sending.
 *
 * Keyed by id AND outcome, not by id alone. A claim is written once when it is
 * made and again when it resolves, and those are the two states the ledger
 * cares about; tracking only the id would mean every resolution went unsent,
 * leaving the durable copy a pile of permanently pending claims — which is the
 * one shape that looks like a track record and contains none.
 */
export function pendingFor(claims: readonly Claim[], acked: ReadonlySet<string>): Claim[] {
  return claims.filter((c) => !acked.has(`${c.id}:${c.outcome}`));
}

export function createLedger(opts: LedgerOptions): LedgerHandle {
  const url = opts.url ?? DEFAULT_LEDGER_URL();
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;

  const status = signal<LedgerStatus>({
    state: "idle",
    written: 0,
    at: null,
    note: "Not yet mirrored to the durable ledger.",
  });

  /* Acknowledged in memory only. A restart re-pushes, which is free: the
     service upserts by id and the resolved-never-unresolves guard means a
     repeat is a no-op rather than a corruption. Persisting this set would add a
     way for the two sides to disagree about what had been stored. */
  const acked = new Set<string>();
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (stopped) return;
    if (!looksLocal(url) && opts.url === undefined) {
      status.set({
        state: "refused",
        written: 0,
        at: now(),
        note: "The ledger target is not this machine, so nothing was sent.",
      });
      return;
    }

    const batch = pendingFor(opts.claims(), acked).slice(0, MAX_BATCH);
    if (batch.length === 0) return;

    status.set({ ...status(), state: "pushing" });
    try {
      const res = await doFetch(`${url}/svc/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claims: batch.map((c) => toWire(c)) }),
      });
      if (!res.ok) {
        status.set({
          state: "refused",
          written: 0,
          at: now(),
          note: `The ledger service answered ${res.status}. Claims are still held in this browser.`,
        });
        return;
      }
      const body = (await res.json()) as { ok?: boolean; written?: number };
      if (body.ok === false) {
        status.set({
          state: "refused",
          written: 0,
          at: now(),
          note: "The ledger service refused the batch. Claims are still held in this browser.",
        });
        return;
      }
      for (const c of batch) acked.add(`${c.id}:${c.outcome}`);
      status.set({
        state: "ok",
        written: body.written ?? batch.length,
        at: now(),
        /* Says what is stored, not "success". The count is the fact. */
        note: `${batch.length} claim${batch.length === 1 ? "" : "s"} mirrored to the durable ledger.`,
      });
    } catch {
      /* Not running is the NORMAL case, and the sentence says so without
         implying the operator has done something wrong. */
      status.set({
        state: "unreachable",
        written: 0,
        at: now(),
        note: "No ledger service on this machine — claims are held in this browser only, where storage is capped and not guaranteed.",
      });
    }
  };

  return {
    status,
    push() {
      /* Join an in-flight push rather than starting a second. Two overlapping
         batches would both contain the unacknowledged claims and the second
         would be entirely redundant. */
      if (inFlight !== null) return inFlight;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    stop() {
      stopped = true;
    },
  };
}
