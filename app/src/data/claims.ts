/**
 * The claims ledger, read back.
 *
 * `/svc/claims/stats` had a client and `/svc/claims` did not — the store had a
 * reader for its summary and none for its rows, which is the shape this project
 * records as "a store with a writer and no reader": 759 recorded calls that
 * nothing on screen could point at individually.
 *
 * NOTHING IS INVENTED TO FILL A FIELD. A row whose `at` or `entry` cannot be
 * read is dropped HERE, once, rather than reaching the chart as a mark at NaN —
 * which canvas drops silently, so an unreadable call and a call that was never
 * made would look identical.
 */

import { svcUrl } from "./backend";
import type { Claim } from "../chart/claims";

export type ClaimsAnswer =
  | { readonly kind: "ok"; readonly claims: readonly Claim[] }
  | { readonly kind: "offline"; readonly why: string };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** One row, read defensively: this service answers honestly with nulls. */
function readClaim(raw: unknown): Claim | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const at = num(o["at"]);
  const entry = num(o["entry"]);
  if (!Number.isFinite(at) || !Number.isFinite(entry)) return null;
  const side = str(o["side"]) === "short" ? "short" : "long";
  return {
    id: str(o["id"], `${at}`),
    at,
    symbol: str(o["symbol"]).toUpperCase(),
    timeframe: str(o["timeframe"]),
    side,
    verdict: str(o["verdict"], "take"),
    outcome: str(o["outcome"], "pending"),
    entry,
    stop: num(o["stop"]),
    target: num(o["target"]),
    r_realised: numOrNull(o["r_realised"]),
    resolved_at: numOrNull(o["resolved_at"]),
    resolved_price: numOrNull(o["resolved_price"]),
  };
}

/**
 * Recent claims, newest first as the service returns them.
 *
 * `limit` is generous because the chart filters by market and by the bars in
 * view: asking for fewer would silently show a shorter record on a symbol the
 * operator trades less often.
 */
export async function recentClaims(
  limit = 600,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimsAnswer> {
  const url = svcUrl(`/svc/claims?limit=${Math.max(1, Math.floor(limit))}`);
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    /* Addressed to the operator, who can start the service. */
    return { kind: "offline", why: "the claims ledger is not answering on this address" };
  }
  if (!res.ok) return { kind: "offline", why: `the claims ledger answered ${res.status}` };
  try {
    const body = (await res.json()) as { claims?: unknown };
    const rows = Array.isArray(body.claims) ? body.claims : [];
    const claims = rows.map(readClaim).filter((c): c is Claim => c !== null);
    return { kind: "ok", claims };
  } catch {
    return { kind: "offline", why: "the claims ledger did not answer with a list" };
  }
}
