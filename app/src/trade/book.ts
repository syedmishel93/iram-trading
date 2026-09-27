/**
 * The book: what you are actually in, from whichever source knows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES IS THE ONE `core/account.ts` ALREADY DOCUMENTS
 *
 * Two places holding the same fact is how this codebase produced a lot size
 * 2.4x too large. Connecting a broker creates exactly that situation again, and
 * worse: the hand-entered book and the broker's book will disagree, constantly,
 * for ordinary reasons — a position closed on the phone, a row typed in and
 * forgotten, a second account somewhere else.
 *
 * So there is ONE owner and it is decided per-row, out loud:
 *
 *   broker     — the broker reports it right now. It owns this row completely.
 *   manual     — hand-entered, and nothing contradicts it. Counted.
 *   unmatched  — hand-entered, the broker IS connected, and it does not report
 *                this position. NOT counted, and listed with what to do.
 *
 * The third state is the whole point. Silently keeping an unmatched row
 * overstates your risk; silently deleting it loses a position you might really
 * hold at another venue. Neither is acceptable, so it is shown and the operator
 * decides — `external: true` on the manual row means "yes, this is real and
 * elsewhere", and it becomes `manual` and counts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOTS ARE NOT UNITS, AND GETTING THAT WRONG IS A 100,000x ERROR
 *
 * `portfolioHeat` computes `risk = (entry - stop) * qty * contractSize`, with
 * `contractSize` defaulting to 1 when absent. MT5 reports `volume` in LOTS. One
 * lot of EURUSD is 100,000 units, so a 20-pip stop on one lot is a $200 risk
 * and, with the multiplier defaulted, would be computed as $0.002.
 *
 * That is not a rounding error. It is a risk desk reporting a flat book while
 * the account is fully loaded — the same class as the v47 pip-value defect, and
 * the reason `core/account.ts` exists.
 *
 * So a broker row WITHOUT a known contract size is `unsized`: it is shown, it is
 * not counted, and the book carries a refusal saying heat is a floor rather than
 * a total. A manual row is never unsized — the operator typed the quantity in
 * whatever unit they meant, and `Position.contractSize` is theirs to set.
 */

import type { BrokerPosition, BrokerResult } from "../data/broker";
import { directionOf, hasStop } from "../data/broker";
import type { Position } from "../risk/sizing";

/** A hand-entered row, as the risk desk has always stored them. */
export interface ManualPosition extends Position {
  /**
   * Set by the operator to mean "this is real and it is not at this broker".
   *
   * Without it, a hand-entered row the broker does not report is `unmatched`
   * and does not count. With it, the operator has taken responsibility for the
   * row and it counts like any other.
   */
  readonly external?: boolean;
}

export type EntryKind = "broker" | "manual" | "unmatched";

export interface BookEntry {
  /** Stable across refreshes: the broker ticket, or the manual row's index. */
  readonly id: string;
  readonly kind: EntryKind;
  readonly position: Position;
  /** Open P&L as the broker reports it. Null when nobody knows — never zero. */
  readonly profit: number | null;
  readonly swap: number | null;
  readonly openedAt: number | null;
  /** Why this row cannot be sized, or null. An unsized row never counts. */
  readonly unsized: string | null;
}

export interface Book {
  readonly entries: readonly BookEntry[];
  /** Exactly the rows `portfolioHeat` should be given. Nothing else. */
  readonly counted: readonly Position[];
  /** Where the counted rows came from. */
  readonly source: "broker" | "manual";
  readonly connected: boolean;
  /**
   * Why the heat computed from `counted` understates the truth, or null.
   *
   * Separate from `notes`: this one means a number on screen is WRONG-LOW, and
   * the desk has to say so beside the number rather than in a list below it.
   */
  readonly refusal: string | null;
  readonly notes: readonly string[];
}

/**
 * MT5 reports "no stop" as the number zero.
 *
 * Not as null, not as absent. `hasStop` is the single place that knows it, and
 * a zero arriving here as a price would make `portfolioHeat` compute a stop
 * distance of the entire entry price — a position "risking" its whole notional,
 * reported with total confidence.
 */
function stopOf(p: BrokerPosition): number | null {
  return hasStop(p) ? p.sl : null;
}

function brokerEntry(p: BrokerPosition, contractSize: number | undefined): BookEntry {
  const sized = typeof contractSize === "number" && Number.isFinite(contractSize) && contractSize > 0;
  return {
    id: `mt5:${p.ticket}`,
    kind: "broker",
    position: {
      symbol: p.symbol,
      direction: directionOf(p),
      qty: p.volume,
      entry: p.price_open,
      stop: stopOf(p),
      ...(sized ? { contractSize } : {}),
    },
    profit: Number.isFinite(p.profit) ? p.profit : null,
    swap: Number.isFinite(p.swap) ? p.swap : null,
    openedAt: Number.isFinite(p.time_ms) && p.time_ms > 0 ? p.time_ms : null,
    unsized: sized
      ? null
      : `${p.symbol} is reported in lots and its contract size is not known, so the risk on ${p.volume} lot${p.volume === 1 ? "" : "s"} cannot be converted into money. Counting it as ${p.volume} units would understate it by the contract size — for a standard FX lot, by 100,000 times.`,
  };
}

/**
 * Does a hand-entered row describe a position the broker is already reporting.
 *
 * SYMBOL AND DIRECTION ONLY, deliberately. Quantity and entry will not match —
 * a part-close, a scale-in, or an average price the operator rounded all move
 * them — and requiring them to match would leave a duplicate of every position
 * in the book, which is the exact failure this function exists to prevent.
 * Matching too loosely drops a row that should have been shown; matching too
 * tightly double-counts real risk. The looser error is the safer one, and it is
 * reported rather than silent.
 */
function matches(m: ManualPosition, ps: readonly BrokerPosition[]): boolean {
  const sym = m.symbol.trim().toUpperCase();
  return ps.some((p) => p.symbol.trim().toUpperCase() === sym && directionOf(p) === m.direction);
}

function manualEntry(m: ManualPosition, i: number, kind: EntryKind): BookEntry {
  return {
    id: `manual:${i}`,
    kind,
    position: m,
    /* Null, never zero. Nobody has told us what this position is worth right
       now, and a zero would render as "flat" beside rows where zero means
       flat. */
    profit: null,
    swap: null,
    openedAt: null,
    unsized: null,
  };
}

export interface ReconcileInput {
  /** The broker's answer, in whichever of its four states it arrived. */
  readonly broker: BrokerResult<readonly BrokerPosition[]>;
  readonly manual: readonly ManualPosition[];
  /** Symbol -> contract size, from `/mt5/symbol`. Missing is not zero. */
  readonly contracts: ReadonlyMap<string, number>;
}

/**
 * Build the one book every risk figure is computed from.
 *
 * Pure. The fetching, the caching and the retry all live in the desk; this
 * decides only what the truth is once the answers are in, which is what makes
 * it testable and what makes the rules above checkable.
 */
export function reconcile(input: ReconcileInput): Book {
  const { broker, manual, contracts } = input;
  const notes: string[] = [];

  if (broker.state !== "ok") {
    /* NOT CONNECTED: there is nothing to contradict the hand-entered rows, so
       every one of them counts. The desk says where the numbers came from;
       this function does not editorialise beyond that. */
    const entries = manual.map((m, i) => manualEntry(m, i, "manual"));
    return {
      entries,
      counted: entries.map((e) => e.position),
      source: "manual",
      connected: false,
      refusal: null,
      notes: [
        manual.length === 0
          ? "No positions are recorded and the broker is not connected, so this is not a statement that you are flat — it is a statement that nothing here knows."
          : `${manual.length} position${manual.length === 1 ? "" : "s"} entered by hand. Nothing is checking them against a broker.`,
      ],
    };
  }

  const ps = broker.value;
  const brokerEntries = ps.map((p) => brokerEntry(p, contracts.get(p.symbol)));

  const absorbed: ManualPosition[] = [];
  const kept: BookEntry[] = [];
  manual.forEach((m, i) => {
    if (matches(m, ps)) {
      absorbed.push(m);
      return;
    }
    kept.push(manualEntry(m, i, m.external === true ? "manual" : "unmatched"));
  });

  const entries = [...brokerEntries, ...kept];
  const counted = entries
    .filter((e) => e.kind !== "unmatched" && e.unsized === null)
    .map((e) => e.position);

  if (ps.length === 0) {
    notes.push("The broker reports no open positions. That is a real answer, not a missing one.");
  }
  if (absorbed.length > 0) {
    notes.push(
      `${absorbed.length} hand-entered row${absorbed.length === 1 ? "" : "s"} (${absorbed
        .map((m) => m.symbol)
        .join(", ")}) ${absorbed.length === 1 ? "matches a position" : "match positions"} the broker reports, so the broker's figures are used instead. Yours are not deleted; they are simply not the ones being counted.`,
    );
  }
  const unmatched = kept.filter((e) => e.kind === "unmatched");
  if (unmatched.length > 0) {
    notes.push(
      `${unmatched.length} hand-entered row${unmatched.length === 1 ? "" : "s"} (${unmatched
        .map((e) => e.position.symbol)
        .join(", ")}) ${unmatched.length === 1 ? "is" : "are"} not reported by the broker and ${unmatched.length === 1 ? "is" : "are"} NOT counted. Either it is closed, or it is at another venue — mark it external and it will count.`,
    );
  }

  const unsized = entries.filter((e) => e.unsized !== null);
  const refusal =
    unsized.length === 0
      ? null
      : `${unsized.length} position${unsized.length === 1 ? "" : "s"} (${unsized
          .map((e) => e.position.symbol)
          .join(", ")}) cannot be converted from lots into money, because the contract size for ${unsized.length === 1 ? "that instrument is" : "those instruments are"} not known. ${unsized.length === 1 ? "It is" : "They are"} excluded rather than counted at one unit per lot, which for standard FX would understate the risk by 100,000 times. Every risk figure below is therefore a FLOOR and not the total.`;

  return {
    entries,
    counted,
    source: "broker",
    connected: true,
    refusal,
    notes,
  };
}

/** Every distinct symbol the book needs a contract size for. */
export function symbolsNeedingContract(ps: readonly BrokerPosition[]): string[] {
  return [...new Set(ps.map((p) => p.symbol))].sort();
}
