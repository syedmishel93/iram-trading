/**
 * The broker: your actual account, your actual positions, your actual fills.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE DATA LAYER
 * Every risk figure this terminal produces has, until now, been computed from
 * numbers somebody typed in. `ui/risk.ts` says so out loud — "No positions
 * recorded. Add the ones you are actually in." — and `core/account.ts` holds an
 * equity that defaults to 10,000 because nothing ever told it otherwise.
 *
 * So portfolio heat, the correlation clustering that warns you two positions
 * are one bet, the Briefing's "where you stand", and every lot size the
 * calculator returns have been answers about a hypothetical account. They were
 * correct for their inputs and the inputs were a guess.
 *
 * `server/mt5_bridge.py` has been able to answer all three questions for a
 * long time — `/mt5/account`, `/mt5/positions`, `/mt5/deals` — and nothing in
 * the frontend has ever called them. This is that call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR OUTCOMES, AND THEY ARE NOT THE SAME SENTENCE
 *
 * The single most common state on most machines is NOT "connected". MT5 is
 * Windows-only, the package may not be installed, the terminal may be shut, and
 * the account may be logged out — four different situations with four different
 * things to do about them, and a product that collapses them into "no data"
 * sends people to look at the wrong thing.
 *
 *   ok           — the broker answered. These are your real numbers.
 *   unavailable  — the bridge cannot run here at all (wrong OS, no package).
 *                  Nothing you do in this terminal will fix it.
 *   disconnected — the bridge is fine; MT5 is not running or not logged in.
 *                  Start MT5 and it works.
 *   offline      — the gateway itself did not answer. `python run.py`.
 *
 * NOTHING HERE EVER SYNTHESISES A POSITION. An empty list means the broker said
 * you hold nothing. A refusal means the broker was not asked or did not answer,
 * and the caller must not read that as "flat" — the difference between "you
 * have no risk on" and "I could not find out whether you have risk on" is the
 * whole reason this union has four arms.
 */

import { proxyBase } from "./backend";

export type BrokerResult<T> =
  | { readonly state: "ok"; readonly value: T }
  /** The bridge cannot run on this host. Not fixable from here. */
  | { readonly state: "unavailable"; readonly reason: string }
  /** The bridge runs; the terminal is not connected or not logged in. */
  | { readonly state: "disconnected"; readonly reason: string }
  /** The gateway did not answer at all. */
  | { readonly state: "offline"; readonly reason: string };

/**
 * A broker call's ceiling.
 *
 * Short on purpose, and much shorter than the quant service's three minutes.
 * Every call here is a local IPC hop to a terminal on the same machine; if it
 * has not answered in eight seconds the terminal is wedged, and a spinner that
 * sits there for three minutes is how an operator concludes the product is
 * broken rather than that MT5 is.
 */
export const BROKER_TIMEOUT_MS = 8_000;

export interface BrokerClock {
  readonly offset_ms: number;
  readonly offset_s: number | null;
  readonly label: string;
  readonly measured: boolean;
  readonly note: string;
  readonly measured_at_ms: number | null;
  readonly explain: string;
}

export interface BrokerHealth {
  readonly available: boolean;
  readonly reason: string;
  readonly connected: boolean;
  readonly last_err: string | null;
  readonly platform: string;
  readonly clock: BrokerClock;
}

export interface BrokerAccount {
  readonly login: number;
  readonly currency: string;
  readonly balance: number;
  readonly equity: number;
  readonly margin: number;
  readonly margin_free: number;
  readonly leverage: number;
  readonly server: string;
}

/** One open position, exactly as the broker reports it. */
export interface BrokerPosition {
  readonly ticket: number;
  readonly symbol: string;
  /** MT5's own encoding: 0 = BUY, 1 = SELL. Translated by `directionOf`. */
  readonly type: number;
  readonly volume: number;
  readonly price_open: number;
  /** Zero means NO STOP, not "a stop at zero". See `hasStop`. */
  readonly sl: number;
  readonly tp: number;
  readonly profit: number;
  readonly swap: number;
  readonly time_ms: number;
}

/** One closed fill. `entry` 0 = in, 1 = out, 2 = in-and-out. */
export interface BrokerDeal {
  readonly ticket: number;
  readonly order: number;
  readonly position_id: number;
  readonly time_ms: number;
  readonly type: number;
  readonly entry: number;
  readonly symbol: string;
  readonly volume: number;
  readonly price: number;
  readonly commission: number;
  readonly swap: number;
  readonly profit: number;
  readonly comment: string;
}

/** The instrument's real cost profile — what makes a backtest honest. */
export interface BrokerSymbol {
  readonly symbol: string;
  readonly digits: number;
  readonly point: number;
  readonly spread_points: number;
  readonly spread_price: number;
  readonly contract_size: number;
  readonly tick_value: number;
  readonly tick_size: number;
  readonly volume_min: number;
  readonly volume_step: number;
  readonly stops_level: number;
  readonly swap_long: number;
  readonly swap_short: number;
}

/**
 * MT5's integer direction, as a word.
 *
 * Exported and used everywhere rather than compared inline, because `type === 0`
 * appearing in four files is four chances for somebody to guess that 0 is sell.
 */
export function directionOf(p: BrokerPosition): "long" | "short" {
  return p.type === 0 ? "long" : "short";
}

/**
 * Whether this position has a stop at all.
 *
 * MT5 reports "no stop" as the NUMBER ZERO, not as null. Any code that treats
 * `sl` as a price without this check computes a stop distance of the entire
 * entry price and reports a position risking the whole account — or, worse,
 * passes `sl > 0` nowhere and silently reports it as protected. The risk desk
 * already distinguishes protected from unprotected; this is what feeds it.
 */
export function hasStop(p: BrokerPosition): boolean {
  return Number.isFinite(p.sl) && p.sl > 0;
}

export function brokerUrl(path: string): string {
  return `${proxyBase()}${path}`;
}

interface ErrorBody {
  readonly error?: string;
}

/**
 * Decide which of the four outcomes an error body describes.
 *
 * The bridge returns `{"error": "..."}` with a 502 or 503 and the sentence is
 * the only thing that distinguishes "this host can never do this" from "turn
 * MT5 on". Matching on it is fragile and is done HERE, once, rather than at
 * five call sites — and it falls back to `disconnected`, which is the arm that
 * tells the operator to do something rather than the arm that tells them to
 * give up.
 */
function classify(message: string): BrokerResult<never> {
  const m = message.toLowerCase();
  if (m.includes("windows-only") || m.includes("not importable") || m.includes("unavailable")) {
    return { state: "unavailable", reason: message };
  }
  return { state: "disconnected", reason: message };
}

async function get<T>(path: string): Promise<BrokerResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
  try {
    const res = await fetch(brokerUrl(path), { signal: controller.signal });
    const body = (await res.json()) as T & ErrorBody;
    if (!res.ok || typeof body.error === "string") {
      return classify(body.error ?? `The broker bridge answered HTTP ${res.status}.`);
    }
    return { state: "ok", value: body as T };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      state: "offline",
      reason: aborted
        ? `The broker bridge did not answer within ${Math.round(BROKER_TIMEOUT_MS / 1000)}s. MT5 may be busy or wedged.`
        : `The terminal's own backend is not answering at ${proxyBase()}. Start it with: python run.py`,
    };
  } finally {
    /* Without this the abort still fires eight seconds after a call that already
       succeeded — harmless per controller, and one live timer per request. */
    clearTimeout(timer);
  }
}

/**
 * Whether the broker can be asked anything, and why not.
 *
 * NEVER FAILS. `/mt5/health` is the one route that answers 200 with
 * `available: false` rather than erroring, precisely so the UI can show the
 * real reason instead of a generic failure — so this maps a successful
 * response with `available: false` onto the same union everything else uses.
 */
export async function brokerHealth(): Promise<BrokerResult<BrokerHealth>> {
  const r = await get<BrokerHealth>("/mt5/health");
  if (r.state !== "ok") return r;
  if (!r.value.available) return { state: "unavailable", reason: r.value.reason };
  return r;
}

export async function brokerAccount(): Promise<BrokerResult<BrokerAccount>> {
  return get<BrokerAccount>("/mt5/account");
}

export async function brokerPositions(): Promise<BrokerResult<readonly BrokerPosition[]>> {
  const r = await get<{ positions: readonly BrokerPosition[] }>("/mt5/positions");
  return r.state === "ok" ? { state: "ok", value: r.value.positions ?? [] } : r;
}

/** Closed fills. 90 days by default, which is what the route defaults to. */
export async function brokerDeals(days = 90): Promise<BrokerResult<readonly BrokerDeal[]>> {
  const r = await get<{ deals: readonly BrokerDeal[] }>(`/mt5/deals?days=${Math.max(1, Math.round(days))}`);
  return r.state === "ok" ? { state: "ok", value: r.value.deals ?? [] } : r;
}

export async function brokerSymbol(symbol: string): Promise<BrokerResult<BrokerSymbol>> {
  return get<BrokerSymbol>(`/mt5/symbol?symbol=${encodeURIComponent(symbol)}`);
}

/**
 * One line for the operator, in their terms, for any outcome.
 *
 * The four arms produce four different INSTRUCTIONS, which is the point of
 * having four arms: one says fix your machine, one says start MT5, one says
 * start the terminal, and one is not an error at all.
 */
export function brokerLine(r: BrokerResult<unknown> | null): string {
  if (r === null) return "The broker has not been asked yet.";
  switch (r.state) {
    case "ok":
      return "Connected. These are your account's own numbers.";
    case "unavailable":
      return `Not available on this machine: ${r.reason} Everything below is what you entered by hand.`;
    case "disconnected":
      return `MT5 is not answering: ${r.reason} Start the terminal and log in, and these figures become live.`;
    case "offline":
      return r.reason;
  }
}
