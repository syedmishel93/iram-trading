/**
 * NEW TOKEN LISTINGS, and the wallets the service scores.
 *
 * Both had a menu row reading "no screen yet", correctly greyed out. This is
 * the screen.
 *
 * WHY THE PAIRS TABLE IS WORTH SHOWING AT ALL
 *
 * The scanner that fills it had never written a row in its life. It called
 * `log_event()` from inside its own write transaction, which asks for a lock
 * the same thread already holds; that raised "database is locked" after the
 * busy timeout, and the raise ROLLED BACK the dedup insert the loop existed to
 * make. 2,069 failures, an empty table, and a fresh tick age throughout. Fixed
 * in v62.14 — 36 rows within the hour.
 *
 * WHAT THIS LIST IS, AND FIRMLY IS NOT
 *
 * DexScreener's newest token profiles. It is a feed of things that have just
 * been LISTED, which is not a feed of things worth buying — most new tokens go
 * to zero, and the service's own Telegram message says so. So the card carries
 * that sentence rather than ranking, scoring or sorting by anything that would
 * imply a recommendation, and there is no price, no change and no volume here
 * because the service stores none. A column the data cannot fill is a column
 * that invites a guess.
 */

import { svcUrl } from "./backend";

export interface NewPair {
  readonly chain: string;
  readonly address: string;
  /** Seconds, as the service stores it. */
  readonly t: number;
}

export interface NewPairs {
  readonly ok: boolean;
  readonly pairs: readonly NewPair[];
  /** Every row the table holds, not just the page shown. */
  readonly total: number;
  readonly shown: number;
}

/** One scored wallet from the smart-money list. */
export interface DbWallet {
  readonly wallet: string;
  readonly chain: string;
  readonly tier: string;
  readonly score: number;
  readonly nick: string | null;
  readonly alert: number | null;
}

export interface DbWallets {
  readonly ok: boolean;
  readonly wallets: readonly DbWallet[];
  readonly total: number;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

async function ask<T>(path: string): Promise<Answer<T>> {
  const url = svcUrl(path);
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    /* Addressed to the operator, who can start the service. */
    return { kind: "offline", why: `the on-chain service is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `the on-chain service answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    return { kind: "offline", why: `the on-chain service did not answer with a report on ${url}` };
  }
}

export function loadNewPairs(limit = 40): Promise<Answer<NewPairs>> {
  return ask<NewPairs>(`/svc/onchain/pairs?limit=${Math.max(1, Math.min(200, limit))}`);
}

export function loadDbWallets(): Promise<Answer<DbWallets>> {
  return ask<DbWallets>("/svc/onchain/dbwallets");
}

/**
 * A block explorer for this chain, or null.
 *
 * NULL RATHER THAN A GUESS. An explorer URL built from a pattern for a chain
 * nobody mapped sends the operator to a 404 that looks like the token does not
 * exist — a worse answer than no link, because it reads as information.
 */
export function explorerUrl(chain: string, address: string): string | null {
  const c = (chain || "").toLowerCase();
  const base: Record<string, string> = {
    solana: "https://solscan.io/token/",
    ethereum: "https://etherscan.io/token/",
    base: "https://basescan.org/token/",
    arbitrum: "https://arbiscan.io/token/",
    optimism: "https://optimistic.etherscan.io/token/",
    polygon: "https://polygonscan.com/token/",
    bsc: "https://bscscan.com/token/",
  };
  const b = base[c];
  return b && address ? b + encodeURIComponent(address) : null;
}
