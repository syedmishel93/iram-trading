/**
 * The DURABLE track record — every claim this machine made, and whether it held.
 *
 * WHY THIS IS NOT THE LEARN DESK'S OWN SCORECARD
 *
 * `learn/scorecard.ts` grades the claims THIS BROWSER holds. This reads the
 * server's ledger, which survives clearing site data, switching browser and
 * moving machine. MEASURED on the running build: the server holds 2,059
 * recorded claims and 420 decided, across 5 markets and 8 bar sizes, while the
 * desk's own scorecard on this profile showed almost nothing.
 *
 * They are not redundant and they are not interchangeable — the same
 * distinction the System desk already draws about bars: "a fast copy in this
 * browser, and a durable copy on the server that survives clearing it". The
 * desk shows both and says which is which, because a number that silently
 * changed meaning when you cleared your history would be worse than either.
 *
 * EVERY RATE CARRIES ITS INTERVAL
 *
 * The service returns `low` and `high` beside every `hitRate`, and this keeps
 * them. A hit rate without an interval is a claim nobody can check: 52% on 420
 * decisions and 52% on 12 are the same number about entirely different
 * evidence, and only one of them is worth acting on.
 */

import { svcUrl } from "./backend";

/**
 * One graded population: everything, or one market, or one bar size.
 *
 * EVERY FIGURE IS NULLABLE, BECAUSE THE SERVICE REFUSES RATHER THAN GUESSES.
 *
 * A population can have claims recorded and NONE of them decided yet — the
 * bars that would settle them have not closed. The service sends `null` for
 * every rate in that case, which is the honest answer and the one this product
 * asks for everywhere else.
 *
 * These were first hand-written as `number`, and `.toFixed()` on the null threw
 * inside `each`'s render loop — taking the entire table with it, silently,
 * because a reaction swallows what it throws. MEASURED on the live service: one
 * market and three bar sizes came back ungradeable, so five markets rendered as
 * none. That is CLAUDE.md's "never retype a dependency's shape", committed
 * against a service with no schema to import — which is the backlog item, and
 * the reason the nullability is spelled out here rather than assumed.
 */
export interface ClaimPopulation {
  readonly label: string;
  readonly decided: number;
  readonly hits: number;
  /** Null when nothing has been decided. NOT zero — zero means everything lost. */
  readonly hitRate: number | null;
  /** The interval around `hitRate`. Never dropped — see the header. */
  readonly low: number | null;
  readonly high: number | null;
  readonly expectancyR: number | null;
}

/**
 * A population the gate comparison reports, which carries what it could NOT
 * settle as well as what it could.
 *
 * `pending` is what has been said and not yet answered and `unknowable` is what
 * never can be. Both are kept because a lift computed over the decided half
 * only is a number about a subset, and CLAUDE.md's rule is that anything
 * tolerating a partial failure names what it lost everywhere it reports a total.
 *
 * `expired` is the THIRD of those and was missing from this type, from the
 * service, and from both screens that render a population — while the comment
 * above each of those screens promised to name what it could not settle.
 * MEASURED on the live table: 2,113 claims holding 31 `expired`, counted in
 * `total` and named nowhere, so the numbers on screen did not sum to their own
 * total. A claim that reached neither barrier inside its horizon is its own
 * class: A TIMEOUT IS NOT A LOSS, and it stays out of the rate — but it is now
 * said out loud, which is the half that was wrong.
 */
export interface GatePopulation extends ClaimPopulation {
  readonly total: number;
  readonly pending: number;
  readonly unknowable: number;
  readonly expired: number;
  readonly reportable: boolean;
  readonly text: string;
}

/** One confidence band: what it said, and what actually happened. */
export interface ClaimBand {
  readonly from: number;
  readonly to?: number;
  readonly n: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly meanConfidence: number;
  readonly low: number;
  readonly high: number;
}

export interface GateRecord {
  /** Percentage points the gates ADDED. Negative means they cost you. */
  readonly liftPoints: number;
  /** False when the two populations cannot be told apart on this much data. */
  readonly separated: boolean;
  /* These are POPULATIONS, not counts — the wire sends the full graded shape
     for each side, and typing them as numbers hid the two most useful facts on
     the card: how much of each side is still pending, and the interval around
     each rate. The lift is a difference of two rates, and a difference of two
     rates that are not shown is a figure nobody can check. */
  readonly taken: GatePopulation;
  readonly stoodDown: GatePopulation;
  readonly text: string;
}

export interface ClaimStats {
  readonly ok: boolean;
  readonly all: ClaimPopulation;
  readonly bySymbol: readonly ClaimPopulation[];
  readonly byTimeframe: readonly ClaimPopulation[];
  readonly bySetup: readonly ClaimPopulation[];
  readonly calibration: { readonly bands: readonly ClaimBand[]; readonly note?: string };
  readonly gates: GateRecord;
  /** The service's own words about what this sample cannot support. */
  readonly caveat: string;
  readonly recorded: number;
  readonly claims: number;
  readonly distinctDays: number;
  readonly from: number;
  readonly to: number;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

/** The whole record, as the server grades it. */
export async function claimStats(): Promise<Answer<ClaimStats>> {
  const url = svcUrl("/svc/claims/stats");
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    /* Addressed to the operator, who can start the service. */
    return { kind: "offline", why: `the ledger service is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `the ledger service answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as ClaimStats };
  } catch {
    return { kind: "offline", why: `the ledger service did not answer with a report on ${url}` };
  }
}
