/**
 * The server-side risk governor, and the notifications that outlive the tab.
 *
 * WHY THIS EXISTS AT ALL
 *
 * `/svc/risk/state`, `/svc/risk/check`, `/svc/risk/size`, `/svc/notify` and
 * `/svc/telegram` have been built, working and reachable for releases with
 * ZERO callers in `app/src`. CLAUDE.md names that backlog as "the largest
 * single source of 'the product has functions I cannot use', and it is a wiring
 * problem, not a missing-feature one". This is the wire.
 *
 * WHY THE SERVER'S VERDICT AND NOT THE BROWSER'S
 *
 * The browser already computes portfolio heat from the positions it can see.
 * The governor reads the ACCOUNT — equity from the MT5 bridge, realised R since
 * the day boundary, consecutive losses, cooldown — and none of that survives a
 * closed tab. They answer different questions and the desk shows both rather
 * than picking one, because a disagreement between them is information: it
 * means the browser is looking at a stale or partial book.
 *
 * A BLOCK IS NOT AN INSTRUCTION
 *
 * `mishel_risk.evaluate` says it plainly: a BLOCK means the ticket will not be
 * built, not that the trade is forbidden. The operator can still place it by
 * hand. Nothing here should read as the product refusing permission, because
 * it is not the product's money.
 */

import { svcUrl } from "./backend";

export type Verdict = "allow" | "warn" | "block";

export interface RiskReason {
  readonly rule: string;
  readonly level: Verdict;
  readonly msg: string;
}

export interface RiskPosition {
  readonly symbol?: string;
  readonly side?: string;
  readonly R?: number;
  readonly volume?: number;
}

export interface RiskState {
  readonly equity: number;
  /** Where the equity came from, so a cached figure is never read as live. */
  readonly equity_source: string;
  readonly open_positions: readonly RiskPosition[];
  /** Positions with NO STOP. Not counted as 0R — an unbounded loss is not small. */
  readonly unprotected: readonly RiskPosition[];
  readonly open_R: number;
  readonly realized_R_today: number;
  readonly graded_today: number;
  readonly consecutive_losses: number;
  readonly last_loss_ms: number | null;
  readonly now_ms: number;
  readonly concentration: { readonly R: number; readonly currency: string | null };
  /** Set when the bridge could not be read: everything above is then UNKNOWN. */
  readonly error?: string;
}

export interface RiskVerdict {
  readonly verdict: Verdict;
  readonly reasons: readonly RiskReason[];
}

export interface RiskConfig {
  readonly max_risk_per_trade_pct: number;
  readonly max_daily_loss_R: number;
  readonly max_open_risk_R: number;
  readonly max_trades_per_day: number;
  readonly consecutive_loss_limit: number;
  readonly cooldown_minutes: number;
  readonly max_concentration_R: number;
  readonly block_when_unprotected: boolean;
  readonly day_reset_hour_utc: number;
}

export interface SizeResult {
  readonly ok: boolean;
  readonly lots?: number;
  readonly equity?: number;
  /** The working: contract size, stop distance, the money actually at risk. */
  readonly detail?: Readonly<Record<string, number>> | null;
  /** A sentence when the answer needs one — e.g. below the broker's minimum. */
  readonly note?: string | null;
  readonly spec_source?: string | null;
  readonly err?: string;
  readonly have_spec?: boolean;
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
    /* Addressed to the operator, who can start the service. A TypeError is
       addressed to nobody. */
    return { kind: "offline", why: `the risk service is not answering on ${url}` };
  }
  if (!res.ok && res.status >= 500) {
    return { kind: "offline", why: `the risk service answered ${res.status} on ${url}` };
  }
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    /* An HTML body means something else is on this address — the shape that
       once had the news bar reporting a service that was up. */
    return { kind: "offline", why: `the risk service did not answer with a report on ${url}` };
  }
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The account as it stands: equity, open risk, the day so far. */
export const riskState = (): Promise<Answer<{ ok: boolean; state: RiskState; config: RiskConfig }>> =>
  ask("/svc/risk/state");

/**
 * The gate, asked BEFORE a ticket is built.
 *
 * Omitting the proposal grades the account as it stands, which is what a desk
 * wants on open — "where do I stand" rather than "may I do this".
 */
export const riskCheck = (
  proposal: { symbol?: string; side?: string; risk_R?: number; risk_pct?: number } = {},
): Promise<Answer<{ ok: boolean; state: RiskState; verdict: RiskVerdict }>> =>
  ask("/svc/risk/check", json(proposal));

/**
 * Lots from the BROKER'S REAL CONTRACT SPEC, never a guess.
 *
 * The route's own comment records why that matters: the shipped ticket divided
 * every FX-ish symbol by 100,000 including XAUUSD, whose contract is 100 oz —
 * sizing gold a thousand times too small.
 */
export const riskSize = (req: {
  symbol: string;
  risk_pct: number;
  entry: number;
  stop: number;
  equity?: number;
}): Promise<Answer<SizeResult>> => ask("/svc/risk/size", json(req));

export const riskConfig = (): Promise<Answer<{ ok: boolean; config: RiskConfig; defaults: RiskConfig }>> =>
  ask("/svc/risk/config");

export const setRiskConfig = (patch: Partial<RiskConfig>): Promise<Answer<{ ok: boolean; config: RiskConfig }>> =>
  ask("/svc/risk/config", json(patch));

/* ----------------------------------------------------- notifications ------ */

/**
 * Store the Telegram credentials ON THE SERVER and send a confirmation.
 *
 * THE BROWSER NEVER HOLDS THE TOKEN. The route's own comment says so, and it is
 * the reason this is a server route rather than a fetch to Telegram from the
 * tab: a token in browser storage is a token in every backup of that profile.
 * Nothing here logs the value, and the field that collects it is a password
 * input for the same reason.
 */
export const setTelegram = (token: string, chat: string): Promise<Answer<{ ok: boolean }>> =>
  ask("/svc/telegram", json({ token, chat }));

/** Send one message through the server's stored credentials. */
export const notify = (text: string): Promise<Answer<{ ok: boolean; via: string }>> =>
  ask("/svc/notify", json({ text }));
