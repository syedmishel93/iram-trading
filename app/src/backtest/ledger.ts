/**
 * Every setup that occurred — not every trade that was taken.
 *
 * WHY THIS IS NOT THE TRADE LOG, WHICH IS THE WHOLE POINT
 *
 * The obvious training set for "will this setup win?" is the history of trades
 * the system took. It is the wrong one. A backtest SKIPS a signal while a
 * position is already open, and skips whatever a filter rejected — so the trade
 * log is a SELECTED sample. You never observe what the skipped setups would
 * have done, and a model fitted to it learns the selection rule rather than the
 * market. It will look excellent in backtest for exactly that reason.
 *
 * The ledger records a candidate at EVERY bar the entry condition was true,
 * open position or not, filter or not, with the outcome it would have had. That
 * is the sample a router can honestly be trained and scored on.
 *
 * FOUR THINGS IT HAS TO GET RIGHT
 *
 * 1. **The outcome is resolved strictly AFTER the signal bar.** A decision made
 *    on bar `i` acts at `i+1`'s open, exactly as `engine.ts` rule 1 says; a
 *    resolver that reads bar `i` finds the target on the bar the decision was
 *    made and reports the most common backtest lie one level down.
 *
 * 2. **A timeout is not a loss.** A setup that reaches neither level inside the
 *    horizon is its own class. Folding it into "stop" teaches the model that
 *    "nothing happened" looks like "I was wrong" — the second is the only one
 *    worth learning to avoid, and the first is most of a quiet market.
 *
 * 3. **The label carries its basis.** Read off the minutes, or assumed by the
 *    pessimistic rule. A router should be able to train on the resolved labels
 *    alone, and it cannot if the two are indistinguishable.
 *
 * 4. **It prices the way the engine prices.** Same fill model, same costs. A
 *    ledger priced differently trains the router on a game the engine does not
 *    play, and the disagreement surfaces as a live strategy underperforming its
 *    own backtest with no visible cause.
 */

import type { BarView } from "../chart/series";
import { modelledFill, fillable, DEFAULT_COSTS, type Costs, type Direction } from "./engine";
import { settleBar } from "./intrabar";

/** One entry condition being true at one bar. */
export interface Signal {
  /** Index into the bar series. The decision is made on this bar's close. */
  readonly index: number;
  readonly direction: Direction;
  readonly stop: number;
  readonly target: number;
  readonly reason: string;
  /**
   * What was true at the moment of the signal.
   *
   * Supplied by the caller rather than computed here, because the columns a
   * rule reads are the rule's business — and because anything this file
   * computed from the bar series would have to prove it did not look ahead.
   * The caller already proved that by producing the signal.
   */
  readonly features: Readonly<Record<string, number>>;
}

export type Outcome = "target" | "stop" | "timeout";

export interface Candidate {
  readonly index: number;
  readonly time: number;
  readonly direction: Direction;
  readonly entryPrice: number;
  readonly stop: number;
  readonly target: number;
  readonly features: Readonly<Record<string, number>>;
  readonly outcome: Outcome;
  /** Whether the ORDER of stop and target was measured or assumed. */
  readonly basis: "measured" | "assumed";
  readonly barsHeld: number;
  /** Net of costs, in units of the entry-to-stop distance. */
  readonly rMultiple: number;
  readonly reason: string;
}

export interface LedgerOptions {
  /** Bars after entry within which the setup must resolve, or it is a timeout. */
  readonly horizon: number;
  readonly costs?: Costs;
  /**
   * Minute bars covering the same span, for settling a bar that holds both
   * levels. Without them the pessimistic rule stands and every such label is
   * marked `assumed`.
   */
  readonly minutes?: { readonly barMs: number; readonly bars: readonly BarView[] };
}

export interface Ledger {
  readonly candidates: readonly Candidate[];
  /** Signals that could not be resolved, and were dropped rather than guessed. */
  readonly skipped: number;
  /** 0..1 — the share of labels whose order was actually measured. */
  readonly measuredShare: number;
  /** Why signals were skipped, when any were. */
  readonly why: string;
}

export function buildLedger(
  bars: readonly BarView[],
  signals: readonly Signal[],
  opts: LedgerOptions,
): Ledger {
  const costs = opts.costs ?? DEFAULT_COSTS;
  const horizon = Math.max(1, Math.floor(opts.horizon));
  const candidates: Candidate[] = [];
  const reasons = new Set<string>();
  let skipped = 0;
  let measured = 0;

  for (const s of signals) {
    /* A stop on the wrong side of entry is not a trade. `fillable` is the
       engine's own test, so the ledger and the backtest agree on what counts. */
    const signalBar = bars[s.index];
    if (signalBar === undefined) {
      skipped += 1;
      reasons.add("a signal pointed at a bar outside the series");
      continue;
    }

    /* ENTRY IS THE NEXT BAR'S OPEN, through the engine's fill model — rule 1.
       There must BE a next bar, or there is nothing to resolve against. */
    const entryBar = bars[s.index + 1];
    if (entryBar === undefined) {
      skipped += 1;
      reasons.add("a signal had no bar after it to enter on");
      continue;
    }
    const entryPrice = modelledFill(entryBar.o, s.direction, costs, true);

    if (!fillable(entryPrice, s.stop, s.direction)) {
      skipped += 1;
      reasons.add(`a signal's stop was on the wrong side of its entry for a ${s.direction}`);
      continue;
    }

    const risk = Math.abs(entryPrice - s.stop);
    if (!(risk > 0)) {
      skipped += 1;
      reasons.add("a signal's stop was its entry, so risk was zero");
      continue;
    }

    /* Resolve forward, strictly after the entry bar's open. The entry bar
       itself CAN resolve the trade — you are in it from its open. */
    let outcome: Outcome = "timeout";
    let basis: "measured" | "assumed" = "measured";
    let barsHeld = horizon;
    let exitPrice = bars[Math.min(bars.length - 1, s.index + horizon)]?.c ?? entryPrice;

    for (let k = 0; k < horizon; k += 1) {
      const j = s.index + 1 + k;
      const b = bars[j];
      if (b === undefined) break;

      const hitStop = s.direction === "long" ? b.l <= s.stop : b.h >= s.stop;
      const hitTarget = s.direction === "long" ? b.h >= s.target : b.l <= s.target;
      if (!hitStop && !hitTarget) continue;

      if (hitStop && hitTarget) {
        /* The ambiguous bar. Minutes settle it if they cover it; otherwise the
           engine's pessimistic rule stands and the label says so. */
        const span = { from: b.t, to: b.t + (opts.minutes?.barMs ?? 0) };
        const settled = settleBar(opts.minutes?.bars ?? [], span, {
          stop: s.stop,
          target: s.target,
          direction: s.direction,
        });
        outcome = settled.hit === "target" ? "target" : "stop";
        basis = settled.basis;
      } else {
        outcome = hitStop ? "stop" : "target";
        basis = "measured";
      }
      barsHeld = k + 1;
      exitPrice = outcome === "target" ? s.target : s.stop;
      break;
    }

    if (outcome === "timeout") {
      const lastIndex = Math.min(bars.length - 1, s.index + horizon);
      exitPrice = bars[lastIndex]?.c ?? entryPrice;
      barsHeld = lastIndex - s.index;
      basis = "measured";
    }

    const exitFilled = modelledFill(exitPrice, s.direction, costs, false);
    const gross =
      s.direction === "long" ? exitFilled - entryPrice : entryPrice - exitFilled;
    /* Commission is charged per side on notional, as the engine does. */
    const fees = (entryPrice + exitFilled) * costs.commission;
    const rMultiple = (gross - fees) / risk;

    if (basis === "measured") measured += 1;
    candidates.push({
      index: s.index,
      time: signalBar.t,
      direction: s.direction,
      entryPrice,
      stop: s.stop,
      target: s.target,
      features: s.features,
      outcome,
      basis,
      barsHeld,
      rMultiple,
      reason: s.reason,
    });
  }

  return {
    candidates,
    skipped,
    measuredShare: candidates.length === 0 ? 0 : measured / candidates.length,
    why: [...reasons].join("; "),
  };
}

/**
 * The base rate a router has to beat.
 *
 * A classifier that predicts "target" for everything scores exactly this, and
 * a model that cannot beat it has learned nothing — which is the first thing to
 * check and the easiest to forget. Timeouts are excluded from the denominator
 * because they are neither a win nor a loss.
 */
export function baseRate(led: Ledger): { readonly rate: number; readonly decided: number } {
  let wins = 0;
  let decided = 0;
  for (const c of led.candidates) {
    if (c.outcome === "timeout") continue;
    decided += 1;
    if (c.outcome === "target") wins += 1;
  }
  return { rate: decided === 0 ? 0 : wins / decided, decided };
}
