/**
 * Signals the SERVER fired: `GET /svc/sig/fired`, served by `server/svc/signals.py`.
 *
 * `sig_loop` evaluates the armed strategies with the browser closed and writes
 * one row per fire. The route answers `{ok: true, fired: [...]}`, newest first,
 * capped at 200 by the server.
 *
 * THE TABLE (server/db/schema.py):
 *   sig_fired(sym TEXT, tf TEXT, strategy TEXT, bar_t REAL, fired_at REAL,
 *             dir TEXT, entry REAL, stop REAL, t1 REAL, t2 REAL, q REAL,
 *             record TEXT, PRIMARY KEY(sym, tf, strategy, bar_t))
 *
 * UNITS, because two time columns in one row use two different ones:
 *   fired_at — Unix SECONDS (`time.time()` in `sig_loop`).
 *   bar_t    — MILLISECONDS: the worker's `bars[lastIdx].t`, which `yf_bars`
 *              builds as `ts.timestamp() * 1000`.
 * `dir` is the worker's own word, "LONG" or "SHORT".
 * `record` is a JSON STRING of the strategy's measured history at fire time;
 * it is carried as text and not parsed here — nothing on screen reads it yet.
 *
 * `offline` is its own answer, never an empty list: "nothing fired" and "could
 * not ask" are different facts.
 */

import { serviceBase } from "./backend";

export interface FiredSignal {
  readonly sym: string;
  readonly tf: string;
  readonly strategy: string;
  /** The bar the signal fired on, Unix MILLISECONDS. */
  readonly bar_t: number;
  /** When the server recorded it, Unix SECONDS. */
  readonly fired_at: number;
  readonly dir: "LONG" | "SHORT";
  readonly entry: number | null;
  readonly stop: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  /** Quality 0..100, or null when the row has none. */
  readonly q: number | null;
  /** The measured record at fire time, as the JSON text the server stored. */
  readonly record: string;
}

export type SigFiredResult =
  | { readonly state: "ok"; readonly value: readonly FiredSignal[] }
  | { readonly state: "offline"; readonly reason: string };

export const SIGFIRED_TIMEOUT_MS = 6_000;
/** Rows asked for. The drawer shows today's; twenty covers a busy day. */
export const SIGFIRED_N = 20;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (finite(v) ? v : null);

/**
 * Rows from the route's `fired` array, keeping only well-formed ones.
 *
 * Pure. A row with no symbol, strategy, direction or finite fire time is
 * DROPPED rather than repaired: those are the four things a line on screen
 * states, and a guessed one is a signal that never fired.
 */
export function parseSigFired(body: unknown): FiredSignal[] {
  if (!body || typeof body !== "object") return [];
  const list = (body as Record<string, unknown>)["fired"];
  if (!Array.isArray(list)) return [];
  const out: FiredSignal[] = [];
  for (const raw of list as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const { sym, tf, strategy, fired_at, bar_t } = r;
    const dir = typeof r["dir"] === "string" ? r["dir"].toUpperCase() : "";
    if (typeof sym !== "string" || sym.trim() === "") continue;
    if (typeof strategy !== "string" || strategy.trim() === "") continue;
    if (dir !== "LONG" && dir !== "SHORT") continue;
    if (!finite(fired_at)) continue;
    out.push({
      sym,
      tf: typeof tf === "string" ? tf : "",
      strategy,
      bar_t: finite(bar_t) ? bar_t : NaN,
      fired_at,
      dir,
      entry: numOrNull(r["entry"]),
      stop: numOrNull(r["stop"]),
      t1: numOrNull(r["t1"]),
      t2: numOrNull(r["t2"]),
      q: numOrNull(r["q"]),
      record: typeof r["record"] === "string" ? r["record"] : "",
    });
  }
  return out;
}

export function sigFiredUrl(n = SIGFIRED_N): string {
  return `${serviceBase()}/svc/sig/fired?n=${Math.max(1, Math.min(200, Math.round(n)))}`;
}

/** The newest `n` fired signals the server holds. */
export async function loadSigFired(n = SIGFIRED_N): Promise<SigFiredResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGFIRED_TIMEOUT_MS);
  try {
    const res = await fetch(sigFiredUrl(n), { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null; // an HTML error page: refused below
    }
    const ok = !!body && typeof body === "object" && (body as Record<string, unknown>)["ok"] === true;
    if (res.status >= 400 || !ok) {
      return { state: "offline", reason: `The signal service answered HTTP ${res.status} instead of a list.` };
    }
    return { state: "ok", value: parseSigFired(body) };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      state: "offline",
      reason: aborted
        ? `No answer within ${Math.round(SIGFIRED_TIMEOUT_MS / 1000)}s.`
        : `The signal service is not answering at ${serviceBase()}. Start it with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}
