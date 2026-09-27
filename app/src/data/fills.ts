/**
 * Your real fills: closed MT5 trades, reconciled against the plans you wrote.
 *
 * The server already does the work — `server/mishel_recon.py` groups deals into
 * round trips (volume-weighted, partial fills handled), matches each one to a
 * journal plan, and grades it: slippage, R, exit reason, whether the plan was
 * followed. `/svc/mt5/sync` pulls the deals from the running terminal and
 * `/svc/recon` serves the result. Nothing in the frontend called either until
 * this file.
 *
 * READ-ONLY, AND NEVER A JOURNAL ENTRY BY ITSELF. A journal entry has a stop;
 * a fill does not carry the stop you intended. Turning fills into entries
 * would mean inventing one, which is fabricated data. So fills are shown
 * beside the journal, matched to its plans where the server found a match,
 * and labelled "no plan" where it did not.
 *
 * FOUR OUTCOMES, same reasoning as `data/broker.ts`: nothing imported yet is
 * not the same as the service being down, and each says what to do.
 */

import { serviceBase } from "./backend";

/** A round trip, as `deals_to_trades` builds it. Money is the account currency. */
export interface FillTrade {
  readonly position_id: number;
  readonly symbol: string;
  readonly side: "long" | "short";
  readonly volume: number;
  readonly entry_price: number;
  readonly exit_price: number;
  readonly open_ms: number;
  readonly close_ms: number;
  readonly hold_ms: number;
  readonly commission: number;
  readonly swap: number;
  readonly gross_profit: number;
  readonly net_profit: number;
  readonly partial_fills: boolean;
  readonly comment: string;
}

/** The same trade graded against its plan. R fields are null when ungradable. */
export interface FillRecon {
  readonly position_id: number;
  readonly planned: boolean;
  readonly slippage_R: number | null;
  readonly net_R: number | null;
  readonly gross_R: number | null;
  readonly exit_reason: "stop" | "t1" | "t2" | "beyond_stop" | "discretionary" | null;
  readonly followed_plan: boolean | null;
  readonly notes: readonly string[];
}

export interface FillStats {
  readonly trades: number;
  readonly graded: number;
  readonly unplanned: number;
  readonly net_profit: number;
  readonly total_costs: number;
  readonly plan_adherence_pct: number | null;
  readonly beyond_stop_count: number;
  readonly findings: readonly string[];
}

/** One row for the screen: the trade and its grade, joined by position. */
export interface Fill {
  readonly trade: FillTrade;
  /** Null only if the server returned a trade with no grade — reported, not guessed. */
  readonly recon: FillRecon | null;
}

export type FillsResult =
  | { readonly state: "ok"; readonly fills: readonly Fill[]; readonly stats: FillStats; readonly days: number }
  /** The service answered: there are no imported fills yet. */
  | { readonly state: "empty"; readonly reason: string }
  /** The service answered with an error. */
  | { readonly state: "failed"; readonly reason: string }
  /** The service did not answer at all. */
  | { readonly state: "offline"; readonly reason: string };

export type SyncResult =
  | { readonly state: "ok"; readonly stored: number; readonly symbols: readonly string[] }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "offline"; readonly reason: string };

/** Pulling 90 days of deals and a spec per symbol from MT5 can take a while. */
export const FILLS_TIMEOUT_MS = 30_000;

/**
 * Join trades to their grades by `position_id`, newest close first.
 *
 * By id, not by index: the server happens to return them in the same order
 * today, and an index join is exactly the kind of pairing that goes wrong
 * silently the day it stops doing so.
 */
export function joinFills(trades: readonly FillTrade[], recons: readonly FillRecon[]): Fill[] {
  const byId = new Map(recons.map((r) => [r.position_id, r]));
  return trades
    .map((trade) => ({ trade, recon: byId.get(trade.position_id) ?? null }))
    .sort((a, b) => b.trade.close_ms - a.trade.close_ms);
}

/** "2h 15m", "3d 4h", "45s" — how long the position was held. */
export function holdText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How the trade ended, in words. Null reason means it was not graded. */
export function exitText(r: FillRecon | null): string {
  if (r === null || !r.planned) return "no plan";
  switch (r.exit_reason) {
    case "stop":
      return "hit stop";
    case "t1":
      return "hit target 1";
    case "t2":
      return "hit target 2";
    case "beyond_stop":
      return "past the stop";
    case "discretionary":
      return "closed by hand";
    default:
      return "not graded";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<
  { ok: true; status: number; body: T } | { ok: false; reason: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILLS_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}${path}`, { ...init, signal: controller.signal });
    return { ok: true, status: res.status, body: (await res.json()) as T };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? `No answer within ${Math.round(FILLS_TIMEOUT_MS / 1000)}s — MT5 may be busy.`
        : `The terminal's backend is not answering at ${serviceBase()}. Start it with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ReconBody {
  readonly ok?: boolean;
  readonly empty?: boolean;
  readonly msg?: string;
  readonly err?: string;
  readonly days?: number;
  readonly trades?: readonly FillTrade[];
  readonly recons?: readonly FillRecon[];
  readonly stats?: FillStats;
}

/** Your closed trades over the last `days`, graded. Reads what was imported; asks MT5 nothing. */
export async function loadFills(days = 90): Promise<FillsResult> {
  const r = await call<ReconBody>(`/svc/recon?days=${Math.max(1, Math.round(days))}`);
  if (!r.ok) return { state: "offline", reason: r.reason };
  const b = r.body;
  if (r.status >= 400 || b.ok === false) {
    return { state: "failed", reason: b.err ?? `The service answered HTTP ${r.status}.` };
  }
  if (b.empty || !b.stats) {
    return { state: "empty", reason: "No trades imported yet. Click Sync from MT5 with the terminal running and logged in." };
  }
  return { state: "ok", fills: joinFills(b.trades ?? [], b.recons ?? []), stats: b.stats, days: b.days ?? days };
}

interface SyncBody {
  readonly ok?: boolean;
  readonly stored?: number;
  readonly symbols?: readonly string[];
  readonly err?: string;
}

/** Pull deals and contract specs from the running MT5 terminal into the store. */
export async function syncFills(days = 90): Promise<SyncResult> {
  const r = await call<SyncBody>("/svc/mt5/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days: Math.max(1, Math.round(days)) }),
  });
  if (!r.ok) return { state: "offline", reason: r.reason };
  if (r.status >= 400 || r.body.ok === false) {
    return { state: "failed", reason: r.body.err ?? `MT5 did not answer (HTTP ${r.status}). Is the terminal running and logged in?` };
  }
  return { state: "ok", stored: r.body.stored ?? 0, symbols: r.body.symbols ?? [] };
}
