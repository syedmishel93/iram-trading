/**
 * What the background service is doing right now, for the status strip.
 *
 * `/svc/health` already reports it — pending server-side alerts, whether
 * Telegram is configured, and every background loop with its last tick — and
 * `/svc/sig/watch` lists the armed strategies. Nothing in the frontend asked
 * either question until the v59 status strip, so eleven loops ran with no
 * sign on screen that they existed.
 *
 * `offline` is its own answer, never zeros: "no alerts" and "could not ask"
 * are different facts, and the strip shows a dash for the second.
 */

import { serviceBase } from "./backend";

export interface ServiceStatus {
  /** Price alerts armed on the server — they fire with the terminal closed. */
  readonly pendingAlerts: number;
  /**
   * Strategies armed for bar-by-bar evaluation on the server, or `null` when
   * the watch list could not be read. Not zero: "none armed" and "could not
   * ask" are different facts, and the health call succeeding says nothing
   * about the second request.
   */
  readonly armedSignals: number | null;
  readonly telegram: boolean;
  /**
   * Loops that have TICKED AT LEAST ONCE. The service only learns a loop
   * exists when it ticks, so with the background switched off this is 0 —
   * and 0 of 0 must read as "nothing is running", never as "all running".
   */
  readonly loops: number;
  /** Loops whose last tick is older than the service's own staleness limit. */
  readonly staleLoops: readonly string[];
}

export type StatusResult =
  | { readonly state: "ok"; readonly value: ServiceStatus }
  | { readonly state: "offline"; readonly reason: string };

export const STATUS_TIMEOUT_MS = 6_000;

interface HealthBody {
  readonly pending_alerts?: unknown;
  readonly telegram?: unknown;
  readonly loops?: unknown;
  readonly stale_loops?: unknown;
}

/**
 * Read `/svc/health` and the watch list into one status.
 *
 * Pure, so the shapes the service can send — including a partial one from an
 * older build — are tested without a network. A field that is missing or the
 * wrong type reads as its empty value, because the strip labels a dash for
 * "offline" only; a running service with no alerts genuinely has zero.
 */
export function parseStatus(health: unknown, watch: unknown): ServiceStatus {
  const h = (health && typeof health === "object" ? health : {}) as HealthBody;
  const loops = h.loops && typeof h.loops === "object" ? Object.keys(h.loops).length : 0;
  const stale = Array.isArray(h.stale_loops) ? h.stale_loops.filter((x): x is string => typeof x === "string") : [];
  const w = (watch && typeof watch === "object" ? watch : {}) as { watch?: unknown };
  const armed = Array.isArray(w.watch)
    ? w.watch.filter((r) => r && typeof r === "object" && (r as { enabled?: unknown }).enabled !== 0).length
    : null;
  return {
    pendingAlerts: typeof h.pending_alerts === "number" && Number.isFinite(h.pending_alerts) ? h.pending_alerts : 0,
    armedSignals: armed,
    telegram: h.telegram === true,
    loops,
    staleLoops: stale,
  };
}

async function getJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadStatus(): Promise<StatusResult> {
  try {
    const [health, watch] = await Promise.all([getJson("/svc/health"), getJson("/svc/sig/watch").catch(() => null)]);
    return { state: "ok", value: parseStatus(health, watch) };
  } catch {
    return { state: "offline", reason: `The background service is not answering at ${serviceBase()}. Start it with: python run.py` };
  }
}
