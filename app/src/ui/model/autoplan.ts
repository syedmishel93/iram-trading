/**
 * A TRADEABLE PLAN FROM A RULE THE TERMINAL FOUND BY ITSELF.
 *
 * Autonomous mode used to show three cells — entry, stop, target — where the
 * Manual card shows a direction, an entry, a stop, targets, a size, the cash at
 * risk and eight checks. The owner's question was the obvious one: why is the
 * autonomous half worse, and why must I open another desk to act on it. This is
 * the missing middle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT REUSES, AND THE ONE THING IT DELIBERATELY DOES NOT
 *
 * `sizePosition` and `gatesFor`/`verdict` are taken whole: neither knows or
 * cares that the idea came from a search rather than from a detector, and a
 * second implementation of "how many lots" or "is there news in fourteen
 * minutes" would be two answers to one question on one screen.
 *
 * `setup/plan.ts` `buildPlan` is NOT used, and that is the important decision
 * in this file. It takes the FURTHER of the supplied stop and `atr x
 * minAtrMultiple`, discards the supplied stop entirely above `maxAtrMultiple`,
 * and hardcodes targets at 1R and 2R. A rule tested with `target: {rr: 3}` would
 * be quoted at 1R, and a rule whose edge lives on a tight stop would be shown
 * with a wider one — underneath that rule's own out-of-sample expectancy. The
 * levels here come from the rule, through the same compiled closure the
 * backtest scored; only the sizing, the checks and the verdict are shared.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ENTRY PRICE IS THE NEXT BAR'S OPEN, NOT THE SIGNAL BAR'S CLOSE
 *
 * `runBacktest` holds a signal as `pending` and fills it at the NEXT bar's open
 * through `modelledFill` — half the spread plus slippage, against you. The card
 * was printing the signal bar's close, a price the engine never paid, directly
 * above the figures that engine earned. Because a rule fires on the last CLOSED
 * bar, the bar that would fill it is the one forming now and its open is
 * already known, so this is exact rather than an estimate.
 *
 * Two consequences the card has to state rather than hide:
 *
 *   DRIFT.        The fill is the open of a bar that may be minutes old. If
 *                 price has run 0.8R away from it, this is no longer the trade
 *                 the backtest took, and the operator needs the number to
 *                 decide that for themselves.
 *   UNFILLABLE.   The engine DROPS a signal whose stop lands on the wrong side
 *                 of the filled entry (`fillable`). Offering it here would be
 *                 proposing a trade the backtest refused to test, so it is a
 *                 refusal with the reason, not a plan.
 */

import { fillable, modelledFill } from "../../backtest/engine";
import { gatesFor, verdict } from "../../setup/gates";
import { fmtPx } from "../shell/format";
import { groupText } from "../../backtest/rules";
import { sizePosition } from "../../risk/sizing";
import type { Account } from "../../core/account";
import type { BarView } from "../../chart/series";
import type { Discovered } from "../../backtest/discovered";
import type { EntrySignal } from "../../backtest/engine";
import type { Gate, GateEnvironment } from "../../setup/gates";
import type { SizeResult } from "../../risk/sizing";
import type { Verdict } from "../../setup/gates";

export interface AutoPlanInput {
  readonly row: Discovered;
  /** The signal the compiled rule produced on the last closed bar. */
  readonly signal: EntrySignal;
  /** Index of the bar the signal was computed on. */
  readonly index: number;
  readonly bars: readonly BarView[];
  readonly account: Account;
  /** Live ATR, for the stop check. NaN when it cannot be measured. */
  readonly atr: number;
  /**
   * The market's readings, from the Setup model — one owner, see
   * `GateEnvironment`. Null when that model cannot answer for this instrument,
   * in which case the checks are reported as unmeasured rather than as passed.
   */
  readonly env: GateEnvironment | null;
}

export interface AutoPlanOk {
  readonly ok: true;
  readonly direction: EntrySignal["direction"];
  /**
   * The modelled fill, or null when the bar that fills it has not opened yet.
   * Null is not zero: without it there is no size and no R, and the card says
   * so rather than quoting the close as though it were a fill.
   */
  readonly entry: number | null;
  /** Where the entry came from, in words. Always present. */
  readonly entryNote: string;
  readonly stop: number;
  /** Null when the rule exits on its own conditions instead of a price. */
  readonly target: number | null;
  /** The exit conditions in words, when there is no target. */
  readonly exitRule: string | null;
  /** Entry to stop, in price. NaN when there is no entry yet. */
  readonly r: number;
  /** Target distance in R, when there is a target. */
  readonly rr: number | null;
  /** How far the last price has moved from the modelled fill, in R. */
  readonly drift: number | null;
  readonly size: SizeResult | null;
  readonly gates: readonly Gate[];
  readonly checked: boolean;
  readonly verdict: Verdict;
  /** Mean R its out-of-sample trades produced, for a rule with no target. */
  readonly provenR: number;
}

export interface AutoPlanNo {
  readonly ok: false;
  readonly refusal: string;
}

export type AutoPlan = AutoPlanOk | AutoPlanNo;

/** The exit conditions of a rule, in the same words the entry reason uses. */
export function exitWords(input: AutoPlanInput): string | null {
  const { spec } = input.row;
  const group = input.signal.direction === "long" ? spec.exitLong : spec.exitShort;
  if (!group || group.length === 0) return null;
  return groupText(group);
}

/**
 * THE VERDICT WHEN NOTHING WAS CHECKED, WHICH IS NOT "GO".
 *
 * `verdict()` reads a gate list: none blocking and none unknown means every
 * check passed. Handed an EMPTY list it therefore returns `go` with 0 of 0 —
 * the shape of the defect CLAUDE.md records for `/svc/health`, where a status
 * strip read "0 of 0 running" and painted it green because the loops had not
 * reported yet. "Nothing failed" and "nothing was asked" are different facts,
 * and on a card that proposes a trade the difference is the whole point.
 */
function UNCHECKED(strategy: string): Verdict {
  return {
    kind: "unknown",
    headline: "CAN'T CHECK YET",
    readLine: "The terminal has not finished reading this market, so none of the checks has been run.",
    blocking: [],
    unknown: [],
    passed: 0,
    total: 0,
    watchLevel: null,
    conflictNote: null,
    strategy,
  };
}

/**
 * The plan, or the reason there is not one.
 *
 * Every refusal names what is missing, because "no plan" and "could not work
 * one out" ask the operator for different things — the rule that
 * `backtest/search.ts` applies to a sweep's refusals, applied to one rule.
 */
export function autoPlan(input: AutoPlanInput): AutoPlan {
  const { row, signal, index, bars, account, atr, env } = input;
  const direction = signal.direction;

  /* The bar that fills this. It is the one FORMING, one past the signal. */
  const filler = bars[index + 1];
  const entry = filler ? modelledFill(filler.o, direction, row.costs, true) : null;

  if (entry !== null && !fillable(entry, signal.stop, direction)) {
    const side = direction === "long" ? "below" : "above";
    return {
      ok: false,
      refusal:
        `The bar that would fill this opened at ${fmtPx(filler?.o ?? 0)}, past the rule's own stop, so the stop is ` +
        `no longer ` +
        `${side} the entry. The backtest drops a signal like this rather than booking it, and this card will not ` +
        `offer what the test refused to measure.`,
    };
  }

  const r = entry === null ? Number.NaN : Math.abs(entry - signal.stop);
  if (entry !== null && !(r > 0)) {
    return { ok: false, refusal: "The rule's stop is the entry price, so the trade has no risk to size against." };
  }

  const target = signal.target ?? null;
  const rr = target !== null && r > 0 ? Math.abs(target - entry!) / r : null;

  const last = bars[bars.length - 1];
  const drift = entry !== null && last && r > 0 ? (last.c - entry) / r : null;

  const size =
    entry !== null && r > 0
      ? sizePosition({ equity: account.equity, riskPct: account.riskPct, entry, stop: signal.stop })
      : null;

  const entryNote =
    entry === null
      ? "The bar that fills this has not opened yet, so there is no fill price to quote."
      : `The test fills at the open of the bar forming now, plus the spread and slippage it was charged.`;

  /*
   * The checks. `env` null means the Setup model could not answer for this
   * instrument — its guards are about the loaded series matching what is on
   * screen — so the honest report is that nothing was checked, not that
   * everything passed. `verdict` turns an empty gate list into "can't check".
   */
  const gates =
    env === null
      ? []
      : gatesFor(
          env,
          {
            plannedQty: size?.ok && Number.isFinite(size.qty) ? size.qty : null,
            stopDistance: Number.isFinite(r) ? r : 0,
            thisTradeRiskPct: size?.ok ? size.riskPct : account.riskPct,
            stopAtrMultiple: Number.isFinite(r) && atr > 0 ? r / atr : 0,
          },
          /*
           * NO PRIOR. The record check wants a `Prior` — a standing resolved
           * from the terminal's own claims, with a Wilson interval behind it —
           * and a rule's `ForwardRecord` is a different measurement: trade
           * count and mean R since it was saved. Converting one into the other
           * would be asserting a standing the record cannot carry, so the check
           * reports unknown and the forward figures are printed beside the
           * proposal instead, where they say what they actually are.
           */
          null,
          /*
           * THE SEARCH THAT FOUND IT, WHICH THIS CARD IS THE ONLY PLACE THAT
           * KNOWS. Every rule reaching this card won a sweep, and `Discovered`
           * has recorded how wide it was since the shelf existed — `trials`
           * counts the arms including the refused ones, and `sharpe` is
           * documented as per-trade and out-of-sample, which is the unit the
           * correction is defined on. Until this line the checks were all about
           * the market and none of them knew the rule had been picked out of
           * hundreds; the Simulation desk computed that hurdle and showed it
           * while the card proposing the trade never asked.
           */
          { trials: row.trials, perTradeSharpe: row.sharpe, trades: row.trades },
        );

  return {
    ok: true,
    direction,
    entry,
    entryNote,
    stop: signal.stop,
    target,
    exitRule: target === null ? exitWords(input) : null,
    r,
    rr,
    drift,
    size,
    gates,
    checked: env !== null,
    verdict: env === null ? UNCHECKED(row.spec.name) : verdict(gates, {
      direction,
      /* The rule's own edge after the search was paid for, as a percentage —
         not a detector score, which this path has no equivalent of. */
      score: Math.max(0, Math.min(100, row.deflated * 100)),
      coverage: env?.coverage ?? 0,
      /* NO ENTRY ZONE. A detector's plan has a band price can be inside or
         outside, and `verdict` reports `armed` when it is outside. A rule fills
         at the next open or not at all, so there is no band, and inventing one
         would put a state on screen that means nothing here. */
      trigger: null,
      strategy: row.spec.name,
        }),
    provenR: row.expectancy,
  };
}
