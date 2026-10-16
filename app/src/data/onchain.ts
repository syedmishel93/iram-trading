/**
 * The on-chain whale service: which wallets are watched, and what they moved.
 *
 * The server side is `server/svc/onchain.py`. What its tables actually hold,
 * read from the Python rather than guessed from a sample:
 *
 *   onchain_watch(id, wallet UNIQUE, chain DEFAULT 'ethereum',
 *                 min_usd DEFAULT 10000, enabled DEFAULT 1)
 *     `wallet` is stored lower-cased. `min_usd` is in US DOLLARS and is the
 *     threshold for `whale_loop`'s Telegram alert (token amount x Blockscout's
 *     exchange rate). It does NOT filter the event list below.
 *     `GET /svc/onchain/watch` returns every row, including switched-off ones
 *     (`enabled = 0`), so the caller has to read `enabled`.
 *
 *   wallet_events(wallet, chain, hash UNIQUE, t, token, sym, direction, amount)
 *     Written by `smart_copy_loop` for EVERY ERC-20 transfer of an enabled
 *     watched wallet — no size filter. So this is "recent transfers", not
 *     "recent large transfers".
 *     `amount` is in TOKEN UNITS (raw value / 10^decimals), never dollars; no
 *       USD value is stored for an event at all.
 *     `t` is epoch SECONDS (float) — Blockscout's ISO timestamp, or the time
 *       the loop saw it when Blockscout gave none.
 *     `direction` is "BUY" when the token arrived IN the wallet and "SELL" when
 *       it left. It is the direction of a transfer, not proof of a trade.
 *     `token` is the token CONTRACT address (lower-cased); `sym` its symbol,
 *       "?" when Blockscout had none.
 *
 * UNWATCH. Two routes exist and they differ:
 *   POST   /svc/onchain/unwatch {wallet}  sets enabled=0 AND clears the DB-wide
 *                                          alert flag in `db_wallets`.
 *   DELETE /svc/onchain/watch/<wallet>    deletes the row, and leaves the
 *                                          `db_wallets` alert on — so
 *                                          `db_alert_loop` could keep messaging
 *                                          you about a wallet you "removed".
 * This client uses the POST: "stop telling me about this wallet" is what the
 * operator means, and only the POST does all of it. It also carries the wallet
 * in a JSON body, so nothing needs URL-encoding.
 */

import { serviceBase } from "./backend";

/** The chains `BLOCKSCOUT_SVC` knows. The server accepts any string, and its
 *  loops silently skip a chain it has no explorer for — so offering anything
 *  else here would be a watch that never fires. */
export const ONCHAIN_CHAINS = ["ethereum", "base", "optimism", "polygon", "arbitrum", "gnosis"] as const;
export type OnchainChain = (typeof ONCHAIN_CHAINS)[number];

/** The server's default when `min_usd` is absent (`schema.py` and `add_watch`). */
export const DEFAULT_MIN_USD = 10_000;

export const ONCHAIN_TIMEOUT_MS = 10_000;

export interface WatchedWallet {
  readonly id: number;
  /** As stored: lower-cased. NOT guaranteed to be a valid address — see `isAddress`. */
  readonly wallet: string;
  /** Null when the row has none; the server's loops then use ethereum. */
  readonly chain: string | null;
  /** US dollars. The size a transfer must reach for a Telegram whale alert. */
  readonly minUsd: number;
  /** False after an unwatch. The row is kept, with its threshold. */
  readonly enabled: boolean;
}

export interface WalletEvent {
  readonly wallet: string;
  readonly chain: string | null;
  /** Epoch SECONDS. */
  readonly t: number;
  /** Token contract address. */
  readonly token: string;
  readonly sym: string;
  /** BUY = the token came IN to the wallet; SELL = it went out. */
  readonly direction: "BUY" | "SELL";
  /** TOKEN UNITS, not dollars. */
  readonly amount: number;
}

export type OnchainResult =
  | {
      readonly state: "ok";
      readonly value: {
        readonly wallets: readonly WatchedWallet[];
        readonly events: readonly WalletEvent[];
        /** Rows the server sent that could not be read, and were dropped. */
        readonly skipped: number;
      };
    }
  | { readonly state: "offline"; readonly reason: string };

export type ActionResult = { ok: true } | { ok: false; reason: string };

/* ---------------------------------------------------------------- pure -- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Rows from `GET /svc/onchain/watch`. A row without a wallet or a usable
 *  threshold is dropped rather than filled in. */
export function parseWallets(body: unknown): WatchedWallet[] {
  if (!Array.isArray(body)) return [];
  const out: WatchedWallet[] = [];
  for (const r of body as unknown[]) {
    if (!isObj(r)) continue;
    const { id, wallet, chain, min_usd, enabled } = r;
    if (typeof wallet !== "string" || wallet === "") continue;
    if (!finite(min_usd) || !finite(id)) continue;
    if (enabled !== 0 && enabled !== 1 && typeof enabled !== "boolean") continue;
    out.push({ id, wallet, chain: strOrNull(chain), minUsd: min_usd, enabled: enabled === 1 || enabled === true });
  }
  return out;
}

/** Rows from `GET /svc/onchain/events`, newest first. A row missing its time,
 *  direction or amount is dropped — an event with a guessed time is worse than
 *  one not shown. */
export function parseEvents(body: unknown): WalletEvent[] {
  if (!Array.isArray(body)) return [];
  const out: WalletEvent[] = [];
  for (const r of body as unknown[]) {
    if (!isObj(r)) continue;
    const { wallet, chain, t, token, sym, direction, amount } = r;
    if (typeof wallet !== "string" || wallet === "") continue;
    if (!finite(t) || !finite(amount)) continue;
    if (direction !== "BUY" && direction !== "SELL") continue;
    out.push({
      wallet,
      chain: strOrNull(chain),
      t,
      token: typeof token === "string" ? token : "",
      sym: typeof sym === "string" && sym !== "" ? sym : "?",
      direction,
      amount,
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

/** An EVM address: 0x and exactly forty hex digits. */
export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** `0x12ab…9f3c`. Anything too short to shorten is returned whole. */
export function shortAddr(s: string): string {
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** "just now", "12 min ago", "5 h ago", "3 d ago". A time well in the future
 *  says so rather than pretending to be recent. */
export function ageText(tSec: number, nowMs: number): string {
  if (!Number.isFinite(tSec) || !Number.isFinite(nowMs)) return "—";
  const s = nowMs / 1000 - tSec;
  if (s < -120) return "time is in the future";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/* ----------------------------------------------------------------- I/O -- */

type Call = { ok: true; status: number; body: unknown } | { ok: false; reason: string };

async function call(path: string, init?: RequestInit): Promise<Call> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONCHAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}${path}`, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: `Something answered at ${serviceBase()}, but it is not the on-chain service.` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? `No answer within ${Math.round(ONCHAIN_TIMEOUT_MS / 1000)}s.`
        : `Nothing is answering at ${serviceBase()}. Start the terminal with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const serverErr = (body: unknown): string | null =>
  isObj(body) && typeof body["err"] === "string" && body["err"] !== "" ? body["err"] : null;

/** The watch list and the latest events, together. Either failing is offline:
 *  a watch list with no events beside it would read as "nothing happened". */
export async function loadOnchain(eventLimit = 8): Promise<OnchainResult> {
  const [w, e] = await Promise.all([
    call("/svc/onchain/watch"),
    call(`/svc/onchain/events?limit=${Math.max(1, Math.min(200, Math.round(eventLimit)))}`),
  ]);
  const wl = asList(w);
  if (typeof wl === "string") return { state: "offline", reason: wl };
  const el = asList(e);
  if (typeof el === "string") return { state: "offline", reason: el };
  const wallets = parseWallets(wl);
  const events = parseEvents(el);
  const skipped = wl.length - wallets.length + (el.length - events.length);
  return { state: "ok", value: { wallets, events, skipped } };
}

/** The list a call returned, or the reason it did not return one. */
function asList(r: Call): unknown[] | string {
  if (!r.ok) return r.reason;
  if (r.status >= 400 || !Array.isArray(r.body)) {
    return serverErr(r.body) ?? `The service answered HTTP ${r.status} without a list.`;
  }
  return r.body as unknown[];
}

async function act(path: string, payload: Record<string, unknown>): Promise<ActionResult> {
  const r = await call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.status >= 400 || (isObj(r.body) && r.body["ok"] === false)) {
    return { ok: false, reason: serverErr(r.body) ?? `The service refused it (HTTP ${r.status}).` };
  }
  return { ok: true };
}

/** Start (or resume) watching. Refuses a malformed address before asking —
 *  the server only checks for eight characters. */
export async function watchWallet(w: {
  readonly wallet: string;
  readonly chain: OnchainChain;
  readonly minUsd: number;
}): Promise<ActionResult> {
  const wallet = w.wallet.trim();
  if (!isAddress(wallet)) return { ok: false, reason: "That is not a wallet address: expected 0x and 40 hex digits." };
  if (!Number.isFinite(w.minUsd) || w.minUsd <= 0) return { ok: false, reason: "The minimum must be a dollar amount above zero." };
  return act("/svc/onchain/watch", { wallet: wallet.toLowerCase(), chain: w.chain, min_usd: w.minUsd });
}

/** Stop watching: switches the row off and clears the DB-wide alert. See the
 *  header for why this and not the DELETE route. */
export async function unwatchWallet(wallet: string): Promise<ActionResult> {
  return act("/svc/onchain/unwatch", { wallet: wallet.toLowerCase() });
}
