/**
 * CHARGING WHAT YOUR BROKER CHARGES, instead of a flat assumption.
 *
 * `DEFAULT_COSTS` is a flat 2bp spread on every instrument, and CLAUDE.md
 * records what that is worth against this operator's own broker:
 *
 *     XAUUSD   0.42 bp real   2.00 bp assumed   4.7x
 *     EURUSD   0.53 bp real   2.00 bp assumed   3.8x
 *     BTCUSD   0.71 bp real   2.00 bp assumed   2.8x
 *
 * A COST MODEL IS A HURDLE, SO AN ASSUMED COST IS AN ASSUMED CONCLUSION.
 * Overcharging is not the safe direction: it DISCARDS rules that would have
 * cleared the real spread, silently, and nothing on screen says why. The
 * Calculator desk has shown this comparison since v62; the Playbook went on
 * charging the assumption with no way to say otherwise.
 *
 * IT REPORTS, IT DOES NOT SILENTLY REPLACE.
 *
 * The measured figure never becomes the default. CLAUDE.md is explicit that a
 * number which moves under the operator because a service answered is worse
 * than a disagreement they can see — so this returns both, says which is in
 * force, and the desk asks before switching.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * Commission and slippage are NOT derived from the spec. A broker's commission
 * is per-lot and account-specific, and slippage is a property of the venue and
 * the order size rather than of the instrument. Only the SPREAD is measured, the
 * other two keep their assumed values, and `partial` says so — a cost model that
 * quietly replaced one term and kept two would be a third thing that is neither
 * measured nor assumed.
 */

import { DEFAULT_COSTS } from "./engine";
import type { Costs } from "./engine";
import { spreadFraction, type BrokerSpec } from "../data/brokercosts";

export interface ResolvedCosts {
  readonly costs: Costs;
  /** True when the spread came from the broker rather than the assumption. */
  readonly measured: boolean;
  /** Only the spread is ever measured; commission and slippage stay assumed. */
  readonly partial: boolean;
  /** The assumed spread, kept so the two can be shown together. */
  readonly assumedSpread: number;
  /** The measured spread, or null when the broker has not been asked. */
  readonly measuredSpread: number | null;
  /** One line for the status strip. Never empty. */
  readonly label: string;
  /** Why the measured figure could not be used, when it could not. */
  readonly why: string;
}

const bp = (fraction: number): string => `${(fraction * 10000).toFixed(2)}bp`;

/**
 * Decide what a run should be charged.
 *
 * `spec` is the broker's contract spec for the symbol, or null when none has
 * been synced. `price` is needed because a spread in POINTS is only a fraction
 * once you know what it is a fraction of — the units trap this project has paid
 * for more than once.
 */
export function resolveCosts(
  spec: BrokerSpec | null,
  price: number,
  useMeasured: boolean,
): ResolvedCosts {
  const assumed = DEFAULT_COSTS.spread;
  const base: ResolvedCosts = {
    costs: DEFAULT_COSTS,
    measured: false,
    partial: false,
    assumedSpread: assumed,
    measuredSpread: null,
    label: `costs on (${bp(assumed)} assumed spread)`,
    why: "",
  };

  if (spec === null) {
    return {
      ...base,
      why: "No contract spec for this symbol yet — run a broker sync to measure its spread.",
    };
  }
  const measured = spreadFraction(spec, price);
  if (measured === null || !(measured > 0)) {
    return {
      ...base,
      why: "The broker's spec for this symbol does not give a usable spread, so the assumption stands.",
    };
  }

  if (!useMeasured) {
    /* KNOWN AND NOT USED IS ITS OWN STATE, and worth saying: the operator is
       running a hurdle they can now see is wrong in a direction. */
    return {
      ...base,
      measuredSpread: measured,
      why:
        `Your broker's spread is ${bp(measured)}; this run charges the assumed ${bp(assumed)} ` +
        `(${(assumed / measured).toFixed(1)}x). Switch to measured to charge what you actually pay.`,
    };
  }

  return {
    costs: { ...DEFAULT_COSTS, spread: measured },
    measured: true,
    partial: true,
    assumedSpread: assumed,
    measuredSpread: measured,
    label: `costs on (${bp(measured)} measured spread)`,
    why:
      `Spread measured from your broker's spec (${bp(measured)} against the assumed ${bp(assumed)}). ` +
      "Commission and slippage are still the assumed figures — a broker's commission is per-lot and " +
      "account-specific, and slippage belongs to the venue and the order size, so neither is read from " +
      "the instrument.",
  };
}
