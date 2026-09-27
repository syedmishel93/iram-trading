/**
 * What a sweep is about to do, said BEFORE it runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE DESK
 *
 * Two of the three questions an operator asks before pressing Run have exact
 * answers that are easy to get wrong by hand:
 *
 *   HOW MANY ARMS?     `buildField` already decides; this only counts what it
 *                      returned, so the number on screen and the number the
 *                      hurdle is charged for cannot come from two places.
 *   IS THERE ENOUGH
 *   HISTORY?           This has a REAL rule, in `validate.ts` `walkForward`:
 *                      a fold is refused when `floor(bars / folds)` is below
 *                      TWICE the candidate's warm-up. So the bars a rule needs
 *                      is `folds × 2 × warmup`, exactly, and the warm-up is
 *                      `compileSpec`'s own — never a guess about EMA 200.
 *
 * The third — "what will survive?" — has no answer before the run, and nothing
 * here pretends otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT REFUSES UNLESS THE WHOLE FIELD CAN BE VALIDATED
 *
 * MEASURED on the shipped library: warm-ups run 25, 26, 33, 40, 55 and 205
 * bars, so at five folds the cheapest rule needs 250 bars and the deepest
 * 2,050. A run on 300 bars would study all of them, validate fourteen and
 * report eleven as failures.
 *
 * That is not a partial result, it is a WRONG one — and it is wrong in the
 * direction that looks fine. `scoreSearch` charges the hurdle for every arm,
 * including the ones that produced nothing, so a survivor of a half-runnable
 * field is judged against a hurdle inflated by rules that never ran. The
 * honest answers are "load more history" or "search a smaller field", never
 * "run it anyway and read the survivors". So the check is all-or-nothing, and
 * it names the number the operator has to reach.
 */

import { compileSpec } from "./rules";
import type { Entrant } from "./autorun";

/** The fold count `backtest/lab.ts` studies with (`opts.folds ?? 5`). */
export const SWEEP_FOLDS = 5;

export interface FieldCount {
  readonly library: number;
  readonly hybrids: number;
  /** Library rules paired with a market state — see `backtest/conditioned.ts`. */
  readonly conditioned: number;
  /** Anything whose origin this does not recognise. Never folded into another
      bucket: a count that quietly absorbs a new kind stops adding up, and the
      first version did exactly that — `else library += 1` reported 175 library
      rules on a field holding 25 of them and 150 conditioned. */
  readonly other: number;
  /** Rules that will be studied. One rule is at least one arm of the search. */
  readonly arms: number;
}

export function countField(entrants: readonly Entrant[]): FieldCount {
  let library = 0;
  let hybrids = 0;
  let conditioned = 0;
  let other = 0;
  for (const e of entrants) {
    if (e.origin === "hybrid") hybrids += 1;
    else if (e.origin === "conditioned") conditioned += 1;
    else if (e.origin === "library") library += 1;
    else other += 1;
  }
  return { library, hybrids, conditioned, other, arms: entrants.length };
}

/**
 * Bars one rule needs before `walkForward` will produce a single fold.
 *
 * `walkForward` refuses when `floor(bars / folds) < warmup * 2`. Inverted, and
 * exact because `warmup * 2` is an integer: `bars >= folds * 2 * warmup`.
 */
export function barsNeeded(warmup: number, folds = SWEEP_FOLDS): number {
  return Math.max(1, Math.floor(folds)) * 2 * Math.max(1, Math.floor(warmup));
}

export interface HistoryCheck {
  /** Whether the sweep should run at all. */
  readonly ok: boolean;
  readonly bars: number;
  readonly folds: number;
  /** Bars the least demanding rule in the field needs. */
  readonly least: number;
  /** Bars the deepest rule in the field needs. */
  readonly most: number;
  /** Rules this history can walk forward. The sweep runs only when it is all of them. */
  readonly validatable: number;
  readonly total: number;
  /** What the operator is owed about it. "" when every rule can be validated. */
  readonly why: string;
}

/**
 * Whether this history can validate this field, and how much of it.
 *
 * Empty field and zero bars are their own refusals: "nothing to test" and
 * "nothing to test it on" are different facts, and reading either as the other
 * is how a sweep reports a clean pass over nothing.
 */
export function checkHistory(entrants: readonly Entrant[], bars: number, folds = SWEEP_FOLDS): HistoryCheck {
  const total = entrants.length;
  if (total === 0) {
    return {
      ok: false, bars, folds, least: 0, most: 0, validatable: 0, total: 0,
      why: "There are no rules to test. Every rule in the library has been excluded.",
    };
  }

  const warmups = entrants.map((e) => compileSpec(e.spec).warmup);
  const least = barsNeeded(Math.min(...warmups), folds);
  const most = barsNeeded(Math.max(...warmups), folds);
  const validatable = warmups.filter((w) => bars >= barsNeeded(w, folds)).length;
  const perFold = Math.floor(bars / Math.max(1, folds));

  if (validatable === total) return { ok: true, bars, folds, least, most, validatable, total, why: "" };

  const shortfall =
    `${bars.toLocaleString()} bars over ${folds} folds leaves ${perFold.toLocaleString()} a fold, and a rule cannot ` +
    `be walked forward until a fold is twice its warm-up. ` +
    (validatable === 0
      ? `Not one rule in this field clears that: the least demanding needs ${least.toLocaleString()} bars and the ` +
        `deepest ${most.toLocaleString()}.`
      : `Only ${validatable} of ${total} clear it; the rest need up to ${most.toLocaleString()} bars.`);

  return {
    ok: false, bars, folds, least, most, validatable, total,
    why:
      `${shortfall} Nothing was run. The hurdle a survivor has to clear is charged on the WHOLE field, so a sweep ` +
      `here would judge whatever survived against arms that never produced a result — which reads like a hard-won ` +
      `winner and is not one. ${most.toLocaleString()} bars is the floor for this field: raise the history above, or ` +
      `use a longer timeframe.`,
  };
}

/**
 * The sentence that has to be on screen before the operator presses Run.
 *
 * Says `arms` is a FLOOR, because it is: `scoreSearch` charges for every
 * configuration each study tried (`Study.configs.length`), and a spec study
 * tries at least one.
 */
export function hurdleSentence(arms: number): string {
  return (
    `All ${arms.toLocaleString()} are tested at once, so each is one arm of one search. The best of many arms looks ` +
    `good on its own — so the more arms, the more edge a strategy has to show before it counts as anything but the ` +
    `luckiest of the batch. The hurdle is charged on every configuration tried, which is at least ${arms.toLocaleString()}.`
  );
}
