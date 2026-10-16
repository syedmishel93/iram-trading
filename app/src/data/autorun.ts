/**
 * Client for the autonomous loop — `server/svc/auto.py`, behind the gateway.
 *
 * THE SHAPES ARE THE SERVER'S AND ARE NOT RE-DERIVED HERE.
 * A study result carries the engine's own `metrics` and `account`, computed by
 * the same TypeScript the browser runs, compiled into `lab-engine.mjs`. Naming
 * those fields again in a hand-written interface is a second definition free to
 * drift — so the two that ARE the engine's are imported from it.
 *
 * FOUR OUTCOMES, NOT THREE.
 * Beside `ok` / `refused` / `offline`, this loop has a fourth state the desk
 * has to show and nothing else here has: NOT READY. Node missing, the engine
 * unbuilt, or nothing in the archive worth studying are all things the operator
 * can fix, and all of them are the loop working correctly. Rendering them as a
 * failure is how a capability becomes something people switch off.
 */

import { svcUrl } from "./backend";
import type { Metrics } from "../backtest/metrics";
import type { AccountRun } from "../backtest/account";
import type { RouterReport } from "./router";

export interface AutoSample {
  readonly found: number;
  readonly resolved: number;
  readonly baseRate: number;
  readonly measuredShare: number;
  readonly unfeatured: number;
  readonly asked: number;
  readonly skipped: number;
  readonly why: string;
  readonly omitted: readonly string[];
}

export interface AutoRule {
  readonly id: string;
  readonly name: string;
  readonly style: string;
  readonly sample: AutoSample;
  readonly metrics: Metrics;
  readonly account: AccountRun;
  readonly ms: number;
}

export interface AutoRefusal {
  readonly id: string;
  readonly name: string;
  readonly why: string;
}

export interface AutoResult {
  readonly sym: string;
  readonly tf: string;
  readonly src: string;
  readonly bars: number;
  readonly from: number;
  readonly to: number;
  readonly rules: readonly AutoRule[];
  readonly refused: readonly AutoRefusal[];
  readonly pooled: number;
  readonly router: RouterReport | { readonly ok: false; readonly why: string };
  readonly balance: number;
  readonly riskPct: number;
  readonly horizon: number;
  /** When this was measured, seconds since the epoch. */
  readonly at: number;
  /** A hash of the question it answers: the library, the horizon, the account. */
  readonly q: string;
}

export interface AutoSubject {
  readonly sym: string;
  readonly tf: string;
  readonly src: string;
  readonly bars: number;
}

export interface AutoReadiness {
  readonly ok: boolean;
  readonly why: string;
  readonly node: boolean;
  readonly engine_built: boolean;
  readonly subjects: readonly AutoSubject[];
  readonly minBars: number;
}

export interface AutoState {
  readonly running: boolean;
  readonly started: number;
  readonly finished: number;
  readonly pass_no: number;
  readonly subject: string;
  readonly studied: number;
  readonly rules_run: number;
  readonly rules_refused: number;
  readonly last_error: string;
}

export interface AutoStatus {
  readonly ready: AutoReadiness;
  readonly state: AutoState;
  readonly stored: number;
  readonly passEveryS: number;
  readonly horizon: number;
  readonly balance: number;
  readonly riskPct: number;
  readonly maxSubjects: number;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

async function ask<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  const url = svcUrl(path);
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    /* Addressed to the operator: they can start the service, and they can do
       nothing at all with a TypeError. */
    return { kind: "offline", why: `the terminal's own service is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `the service answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    /* An HTML body here means something else is on this address — the shape
       that once had the news bar reporting a service that was up. */
    return { kind: "offline", why: `the service did not answer with a report on ${url}` };
  }
}

export const autoStatus = (): Promise<Answer<AutoStatus>> => ask<AutoStatus>("/svc/auto/state");

export const autoResults = (): Promise<Answer<{ results: AutoResult[]; q: string }>> =>
  ask<{ results: AutoResult[]; q: string }>("/svc/auto/results");

/**
 * Ask for a pass now.
 *
 * The server starts it and answers at once: a pass is minutes of CPU, and
 * holding the request open would time out in the browser and leave the operator
 * unable to tell a slow pass from a dead one. Progress is read from the state.
 */
export const autoRunNow = (): Promise<Answer<{ ok: boolean; why?: string }>> =>
  ask<{ ok: boolean; why?: string }>("/svc/auto/run", { method: "POST" });
