/**
 * Strategies the terminal found by itself, and what is known about them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE SHELF AND NOT THE PLAYBOOK
 *
 * The Playbook holds rules a person wrote or adopted. These are rules a SEARCH
 * produced — surviving out-of-sample testing, a PBO check and the best-of-N
 * hurdle (`search.ts`), which is a far better position than most published
 * backtests and still not the same thing as evidence that it works HERE, NEXT
 * WEEK. Everything on this shelf therefore starts `unproven` and says so, and
 * moving one into the Playbook — where it can influence a recommendation — is
 * the operator's decision, never the search's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STORED, AND WHY IT IS ALL OF IT
 *
 * A saved strategy without its provenance is a number with no way back to what
 * produced it: the symbol, the timeframe, the window, the bar count, the COSTS
 * it was tested with and — the one nobody keeps — how many arms the search had
 * when it found this one. Six months later "+0.42R a trade" means nothing
 * without those, and the temptation to re-read it as a promise is enormous.
 *
 * The store keeps no equity curve and no trade list. `study/store.ts` made the
 * same choice for the same reason: a summary is small and honest, a stored
 * curve goes stale against its own bars and invites re-reading as fact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RETIREMENT RULE
 *
 * Forward results are the only evidence here that was not selected on. When
 * enough of them exist, they are compared with the backtest's own expectancy
 * USING THE BACKTEST'S OWN SPREAD — a strategy that made 0.4R a trade with a
 * standard deviation of 1.2R has not "stopped working" because ten forward
 * trades averaged 0.1R. `forwardVerdict` says `too-few` until the sample can
 * carry the question, which is most of the time.
 */

import type { RuleSpec } from "./rules";
import type { Costs } from "./engine";
import type { Slot } from "../store/kv";

export type DiscoveredStatus = "unproven" | "promoted" | "retired";

export interface ForwardRecord {
  /** Trades observed AFTER the strategy was saved. Never backfilled. */
  readonly trades: number;
  /** Mean R per forward trade. */
  readonly expectancy: number;
  /** When forward tracking started. */
  readonly from: number;
}

export interface Discovered {
  readonly spec: RuleSpec;
  readonly origin: "library" | "hybrid" | "family" | "conditioned";
  readonly foundAt: number;
  /** What it was found on. A result is about an instrument, not in general. */
  readonly symbol: string;
  readonly timeframe: string;
  readonly bars: number;
  /** Arms the search had when this won. The hurdle it cleared depends on it. */
  readonly trials: number;
  /** Out-of-sample, from the walk-forward folds. */
  readonly trades: number;
  readonly expectancy: number;
  /** Per-trade, out-of-sample. Never the annualised equity figure. */
  readonly sharpe: number;
  /** What was left after the best-of-N hurdle, and the hurdle itself. */
  readonly deflated: number;
  readonly hurdle: number;
  readonly costs: Costs;
  readonly status: DiscoveredStatus;
  /** Set when a server-side watch was armed for it. */
  readonly armedAt?: number;
  readonly forward?: ForwardRecord;
  readonly retiredWhy?: string;
}

/** Forward trades below this cannot answer whether it still works. */
export const MIN_FORWARD_TRADES = 20;

/**
 * How far below the backtest a forward run may drift before it is retired.
 *
 * Two standard errors of the FORWARD mean, computed with the backtest's own
 * per-trade spread. Not a fixed percentage: a strategy with a wide spread
 * needs far more forward trades before any gap means anything, and a fixed
 * "down 50%" rule retires exactly those first.
 */
export const RETIRE_Z = 2;

export const DISCOVERED_MAX = 60;

/** Per-trade standard deviation implied by the stored figures. */
export function spreadOf(d: Discovered): number {
  if (!Number.isFinite(d.sharpe) || d.sharpe === 0) return 0;
  return Math.abs(d.expectancy / d.sharpe);
}

export type ForwardVerdict =
  | { readonly kind: "too-few"; readonly why: string }
  | { readonly kind: "holding"; readonly why: string }
  | { readonly kind: "below"; readonly why: string };

/**
 * Do the forward trades disagree with the backtest?
 *
 * Deliberately one-sided: a strategy doing BETTER forward is not evidence of
 * anything that needs acting on, and treating it as such is how a shelf fills
 * up with whatever is currently lucky.
 */
export function forwardVerdict(d: Discovered, forward: ForwardRecord): ForwardVerdict {
  if (forward.trades < MIN_FORWARD_TRADES) {
    return {
      kind: "too-few",
      why: `${forward.trades} forward trade${forward.trades === 1 ? "" : "s"} — ${MIN_FORWARD_TRADES} is the floor before forward results can disagree with a backtest.`,
    };
  }
  const sd = spreadOf(d);
  if (sd === 0) {
    return { kind: "too-few", why: "The backtest recorded no spread, so there is nothing to compare a forward mean against." };
  }
  const se = sd / Math.sqrt(forward.trades);
  const floor = d.expectancy - RETIRE_Z * se;
  if (forward.expectancy >= floor) {
    return {
      kind: "holding",
      why: `Forward ${forward.expectancy.toFixed(2)}R a trade over ${forward.trades}, against ${d.expectancy.toFixed(2)}R in the backtest. Anything above ${floor.toFixed(2)}R is inside the noise of a sample this size.`,
    };
  }
  return {
    kind: "below",
    why: `Forward ${forward.expectancy.toFixed(2)}R a trade over ${forward.trades} is below ${floor.toFixed(2)}R — two standard errors under the backtest's ${d.expectancy.toFixed(2)}R, using the backtest's own spread of ${sd.toFixed(2)}R.`,
  };
}

/** Apply the retirement rule. Returns the row unchanged when it holds. */
export function applyForward(d: Discovered, forward: ForwardRecord): Discovered {
  const v = forwardVerdict(d, forward);
  if (v.kind === "below") return { ...d, forward, status: "retired", retiredWhy: v.why };
  return { ...d, forward };
}

/** One row per strategy per instrument: the same rule elsewhere is a new row. */
export function keyOf(d: Pick<Discovered, "spec" | "symbol" | "timeframe">): string {
  return `${d.spec.id}|${d.symbol}|${d.timeframe}`;
}

/**
 * Add or replace a row, newest first, capped.
 *
 * A re-run of the same strategy on the same chart REPLACES its row — the newer
 * measurement is the better one — but keeps the original `foundAt`, because
 * when the terminal first found it is part of its history and re-running
 * should not make an old discovery look new.
 *
 * The cap drops retired rows first, then the weakest by what survived the
 * hurdle. A promoted row is never dropped: it is in use.
 */
export function addDiscovered(list: readonly Discovered[], row: Discovered, max = DISCOVERED_MAX): Discovered[] {
  const key = keyOf(row);
  const previous = list.find((d) => keyOf(d) === key);
  const merged: Discovered = previous
    ? { ...row, foundAt: previous.foundAt, ...(previous.status === "promoted" ? { status: "promoted" as const } : {}) }
    : row;
  const rest = list.filter((d) => keyOf(d) !== key);
  const next = [merged, ...rest];
  if (next.length <= max) return next;

  const rank = (d: Discovered): number => (d.status === "promoted" ? 2 : d.status === "unproven" ? 1 : 0);
  const dropOrder = [...next].sort((a, b) => rank(a) - rank(b) || a.deflated - b.deflated);
  const drop = new Set(dropOrder.slice(0, next.length - max));
  return next.filter((d) => !drop.has(d));
}

export function promoteDiscovered(list: readonly Discovered[], key: string): Discovered[] {
  return list.map((d) => (keyOf(d) === key ? { ...d, status: "promoted" as const } : d));
}

export function retireDiscovered(list: readonly Discovered[], key: string, why: string): Discovered[] {
  return list.map((d) => (keyOf(d) === key ? { ...d, status: "retired" as const, retiredWhy: why } : d));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isDiscovered(v: unknown): v is Discovered {
  if (!isObj(v) || !isObj(v["spec"]) || typeof (v["spec"] as Record<string, unknown>)["id"] !== "string") return false;
  return (
    typeof v["symbol"] === "string" &&
    typeof v["timeframe"] === "string" &&
    num(v["foundAt"]) &&
    num(v["trials"]) &&
    num(v["trades"]) &&
    num(v["expectancy"]) &&
    num(v["sharpe"]) &&
    num(v["deflated"]) &&
    (v["status"] === "unproven" || v["status"] === "promoted" || v["status"] === "retired")
  );
}

/**
 * `discovered.v1` — its own slot.
 *
 * Not a field on the Playbook's slot: these rows have a different lifetime, a
 * different shape and a different owner (the search wrote them), and a
 * corrupt search result must never quarantine the operator's own playbook.
 */
export const DISCOVERED_SLOT: Slot<readonly Discovered[]> = {
  key: "discovered.v1",
  version: 1,
  fallback: () => [],
  validate: (v) => (Array.isArray(v) ? v.filter(isDiscovered) : null),
};
