/**
 * Is this rule's entry TRUE on the latest closed bar?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT EVALUATE A CONDITION. THE ENGINE DOES.
 *
 * The conditions, the indicator columns, the warm-up and the risk arithmetic
 * already exist once, in `rules.ts` `compileSpec`, and a second implementation
 * of "is RSI below 30" would be a second answer to the question the backtest
 * just answered — the day they disagree you find out on a live trade and cannot
 * tell which one lied. So this calls the compiled strategy's own `entry()` at
 * one index, with the engine's own `makeContext`, and reports what it said.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAST CLOSED BAR, NOT THE LAST BAR
 *
 * `closedCount` is the shell's own count (`closedBarCount`). The bar at that
 * index is still forming: its close is the last trade and changes every tick,
 * so a rule judged on it fires and un-fires. The index read here is
 * `closedCount - 1`, which is the same bar the alert engine judges on and the
 * same one `sig_loop` scans.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WARM-UP IS A REFUSAL, NOT A "NO"
 *
 * `compileSpec` gives every rule the longest lookback it needs. Below it the
 * indicators are still converging, and `entry()` would answer honestly for
 * values that are not yet the values — so "not enough bars to ask" is reported
 * as its own kind. A card that printed "not firing" there would be stating a
 * measurement it never made.
 */

import { makeContext, type EntrySignal, type StrategyContext } from "./engine";
import { compileSpec, type RuleSpec } from "./rules";
import type { BarView } from "../chart/series";

export type Firing =
  | {
      readonly kind: "fires";
      readonly signal: EntrySignal;
      /** Index of the bar it fired on, and that bar's time. */
      readonly index: number;
      readonly at: number;
    }
  | { readonly kind: "quiet"; readonly index: number; readonly at: number }
  | { readonly kind: "cannot"; readonly why: string };

/** One context for a whole pass, so N rules share one set of indicator columns. */
export function contextFor(bars: readonly BarView[]): StrategyContext {
  return makeContext(bars);
}

/**
 * Ask one rule whether it would enter on the newest closed bar.
 *
 * `ctx` MUST have been built from `bars` (`contextFor`) — the engine's own
 * reference check exists for the same reason, and indexing a context built
 * from a different array is how a reading comes from the wrong series.
 */
export function firesOnLastClosed(spec: RuleSpec, ctx: StrategyContext, closedCount: number): Firing {
  const n = Math.min(Math.floor(closedCount), ctx.close.length);
  const i = n - 1;
  if (i < 0) {
    return { kind: "cannot", why: "No bar has closed yet on this chart, so there is nothing to judge." };
  }

  const strategy = compileSpec(spec);
  if (i < strategy.warmup) {
    return {
      kind: "cannot",
      why:
        `This rule needs ${strategy.warmup} bars of warm-up before its indicators mean anything, and there are ` +
        `${n} closed. Load more history for this market.`,
    };
  }

  const signal = strategy.entry(ctx, i);
  const at = ctx.time[i] as number;
  return signal === null ? { kind: "quiet", index: i, at } : { kind: "fires", signal, index: i, at };
}
