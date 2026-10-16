/**
 * Server-side price alerts: `/svc/alerts`, served by `server/svc/alerts.py`.
 *
 * The rules live in the service's `alerts` table and are checked by
 * `alert_loop` on the SERVER every `MISHEL_ALERT_SEC` (30s by default), so they
 * fire with the terminal closed. The frontend never evaluates them; it only
 * lists, adds and removes rules.
 *
 * THE TABLE (server/db/schema.py):
 *   alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, sym TEXT, op TEXT,
 *          price REAL, note TEXT, created REAL, fired REAL)
 * Seven columns and no others. `created` and `fired` are Unix SECONDS
 * (`time.time()`), not milliseconds. `fired` is NULL until the loop sees the
 * quote cross, then the second it did — once, never re-armed.
 *
 * WHAT THE SERVER QUOTES. The loop reads the price from yfinance, which may be
 * ~15 minutes delayed and is not the chart's feed; a symbol yfinance cannot
 * quote is SKIPPED, never guessed, so such an alert simply never fires.
 *
 * `offline` is its own answer, never an empty list: "no alerts" and "could not
 * ask" are different facts.
 */

import { serviceBase } from "./backend";

export type AlertOp = "above" | "below";

export interface PriceAlert {
  readonly id: number;
  /** Upper-cased by the server on insert. */
  readonly sym: string;
  readonly op: AlertOp;
  readonly price: number;
  /** Empty string when the row has none (the column is nullable). */
  readonly note: string;
  /** Unix SECONDS. */
  readonly created: number;
  /** Unix SECONDS the alert fired, or null while it is still waiting. */
  readonly fired: number | null;
}

export type AlertsResult =
  | { readonly state: "ok"; readonly value: readonly PriceAlert[] }
  | { readonly state: "offline"; readonly reason: string };

export type AlertWrite = { ok: true } | { ok: false; reason: string };

export const ALERTS_TIMEOUT_MS = 6_000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Rows from `GET /svc/alerts`, keeping only the well-formed ones.
 *
 * Pure. A row is dropped rather than repaired when anything the card would
 * print or act on is missing: an id to delete by, a symbol, a direction, a
 * finite price, a creation time. A `fired` that is neither null nor a finite
 * number is malformed too — reading it as "pending" would re-arm, on screen,
 * an alert the server may already have fired.
 */
export function parseAlerts(body: unknown): PriceAlert[] {
  if (!Array.isArray(body)) return [];
  const out: PriceAlert[] = [];
  for (const raw of body as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const { id, sym, op, price, note, created } = r;
    const fired = r["fired"] ?? null;
    if (!finite(id) || !Number.isInteger(id)) continue;
    if (typeof sym !== "string" || sym.trim() === "") continue;
    if (op !== "above" && op !== "below") continue;
    if (!finite(price)) continue;
    if (!finite(created)) continue;
    if (fired !== null && !finite(fired)) continue;
    out.push({ id, sym, op, price, note: typeof note === "string" ? note : "", created, fired });
  }
  return out;
}

/**
 * The direction a target implies: above if it is above the current price,
 * below otherwise. With no current price there is nothing to compare against,
 * so it answers "above" — the card only uses this as a default the operator
 * can change.
 */
export function suggestOp(target: number, current: number | null): AlertOp {
  if (current === null || !Number.isFinite(current) || !Number.isFinite(target)) return "above";
  return target > current ? "above" : "below";
}

/** A target the server can store: a finite, positive number. */
export function validPrice(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

async function send(path: string, init?: RequestInit): Promise<{ ok: true; status: number; body: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}${path}`, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null; // an HTML error page: the status decides below
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? `No answer within ${Math.round(ALERTS_TIMEOUT_MS / 1000)}s.`
        : `The alert service is not answering at ${serviceBase()}. Start it with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Every alert the server holds (its newest 100), pending and fired. */
export async function loadAlerts(): Promise<AlertsResult> {
  const r = await send("/svc/alerts");
  if (!r.ok) return { state: "offline", reason: r.reason };
  if (r.status >= 400 || !Array.isArray(r.body)) {
    return { state: "offline", reason: `The alert service answered HTTP ${r.status} instead of a list.` };
  }
  return { state: "ok", value: parseAlerts(r.body) };
}

function writeResult(r: Awaited<ReturnType<typeof send>>): AlertWrite {
  if (!r.ok) return { ok: false, reason: r.reason };
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as { ok?: unknown; err?: unknown };
  if (r.status >= 400 || b.ok !== true) {
    return { ok: false, reason: typeof b.err === "string" ? `The server refused it (${b.err}).` : `The server answered HTTP ${r.status}.` };
  }
  return { ok: true };
}

/** Store a new rule. Refuses locally, without a request, what the server would choke on. */
export async function addAlert(a: { sym: string; op: AlertOp; price: number; note?: string }): Promise<AlertWrite> {
  const sym = a.sym.trim();
  if (sym === "") return { ok: false, reason: "No symbol." };
  if (!validPrice(a.price)) return { ok: false, reason: "Enter a price above zero." };
  const r = await send("/svc/alerts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sym, op: a.op, price: a.price, ...(a.note === undefined ? {} : { note: a.note }) }),
  });
  return writeResult(r);
}

/** Remove a rule, pending or fired. */
export async function deleteAlert(id: number): Promise<AlertWrite> {
  if (!Number.isInteger(id)) return { ok: false, reason: "Not an alert id." };
  return writeResult(await send(`/svc/alerts/${id}`, { method: "DELETE" }));
}
