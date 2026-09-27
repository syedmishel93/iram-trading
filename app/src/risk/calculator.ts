/**
 * The trade calculator — lots, pips, margin, costs, and what you actually keep.
 *
 * This is the broker-style calculator: you give it an account, an instrument, a
 * trade and a cost model, and it tells you the lot size your own risk rule
 * implies, the margin the position will tie up, and the profit and loss AFTER
 * the costs of getting in and out. It is arithmetic. It does not decide whether
 * to take the trade and it cannot place one.
 *
 * It is a port of the calculator from the previous terminal, with the currency
 * handling rebuilt — see `instruments.ts` for why. Two figures changed
 * materially and both were wrong in the direction of confidence:
 *
 *   PIP VALUE was a hardcoded constant per instrument, correct only at the
 *   exchange rate of the day it was typed. It is now derived. On USD/JPY the
 *   old constant was 42% high, which made the recommended lot 30% small.
 *
 *   MARGIN was `entry × lots × contractSize / leverage` for every instrument,
 *   which is only right when the quote currency is the dollar. On USD/JPY it
 *   returned the notional in yen and labelled it dollars — $156,300 of margin
 *   required for a position that ties up $1,000. That figure feeds "can you
 *   open this at all", so it did not merely misreport; it would have told you a
 *   perfectly ordinary trade was impossible.
 *
 * WHAT IT REFUSES TO DO
 * There is no branch here that substitutes a plausible number for one it does
 * not have. When pip value needs a rate that has not been supplied, every
 * figure downstream of it is NaN and `blocked` says which rate is missing. A
 * calculator that guesses is worse than one that stops, because the guess is
 * indistinguishable from the answer.
 */

import {
  pipValue,
  quoteToUsd,
  needsCrossRate,
  type InstrumentSpec,
  type PipBasis,
} from "./instruments";

export interface CalcInput {
  readonly spec: InstrumentSpec;
  /** Account balance, in USD. Drives the risk amount. */
  readonly balance: number;
  /** Account equity, in USD. Drives free margin and margin level. */
  readonly equity: number;
  /** Account leverage, as the denominator: 100 means 1:100. */
  readonly leverage: number;
  /** Percent of BALANCE to risk if the stop trades. 1 means one percent. */
  readonly riskPct: number;
  readonly direction: "buy" | "sell";
  readonly entry: number;
  readonly stop: number;
  /** Optional. Without it there is no reward figure, and it says so. */
  readonly takeProfit?: number;
  /** The size you intend to trade, for comparison against the recommendation. */
  readonly lots: number;
  /** Rate for `CROSS_RATE_SYMBOL[spec.quote]`, needed only by the crosses. */
  readonly crossRate?: number;
  readonly costs: CostModel;
}

/**
 * What the round trip costs.
 *
 * Every field defaults to zero and every field that IS zero is reported as an
 * assumption rather than silently treated as free. "Costs: $0.00" and "costs
 * not supplied" look identical in a results panel and mean opposite things.
 */
export interface CostModel {
  /** Spread in pips, paid once on entry. */
  readonly spreadPips: number;
  /** Commission per lot per side, in USD. Charged twice. */
  readonly commissionPerLot: number;
  /** Swap per lot per night, in USD. Signed: negative is a credit to you. */
  readonly swapPerNight: number;
  readonly nights: number;
  /** Expected slippage in pips, paid once. */
  readonly slippagePips: number;
}

export const NO_COSTS: CostModel = {
  spreadPips: 0,
  commissionPerLot: 0,
  swapPerNight: 0,
  nights: 0,
  slippagePips: 0,
};

/** Margin level above this is comfortable; below `MARGIN_CALL` is not. */
export const MARGIN_SAFE = 200;
export const MARGIN_CALL = 100;

export interface CalcResult {
  readonly ok: boolean;
  /**
   * Why no numbers. Present only when `ok` is false.
   *
   * A sentence naming the missing or contradictory input, never a code — the
   * person reading it is trying to fix an input, not debug the calculator.
   */
  readonly blocked?: string;

  /** USD per pip per lot, with the derivation that produced it. */
  readonly pipValue: number;
  readonly pipBasis: PipBasis;

  readonly stopPips: number;
  readonly targetPips: number;
  /** Gross reward-to-risk, before costs. NaN when there is no target. */
  readonly rr: number;

  /** Balance × riskPct, in USD. */
  readonly riskAmount: number;
  /** The lot size `riskAmount` implies at this stop distance. */
  readonly recommendedLots: number;
  /** True when the lots you asked for risk no more than your rule allows. */
  readonly withinRisk: boolean;
  /** What your chosen lots actually risk, in USD and as a percent of balance. */
  readonly actualRisk: number;
  readonly actualRiskPct: number;

  readonly notional: number;
  readonly margin: number;
  readonly freeMargin: number;
  /** Equity / margin × 100. Infinity when no margin is required. */
  readonly marginLevel: number;
  readonly canOpen: boolean;

  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly costBreakdown: CostBreakdown;
  readonly netProfit: number;
  readonly netLoss: number;
  /** Reward-to-risk after costs. This is the one that decides anything. */
  readonly netRr: number;
  /** Pips of favourable movement needed just to cover costs. */
  readonly breakEvenPips: number;
  /** Costs as a percent of the gross win. NaN without a target. */
  readonly costShareOfWin: number;

  /** R-multiple ladder from the entry: 1R, 2R, 3R. */
  readonly rLevels: readonly { readonly r: number; readonly price: number }[];

  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
}

export interface CostBreakdown {
  readonly spread: number;
  readonly commission: number;
  readonly swap: number;
  readonly slippage: number;
  readonly total: number;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const BLOCKED = (reason: string): CalcResult => ({
  ok: false,
  blocked: reason,
  pipValue: NaN,
  pipBasis: { kind: "unknown", rateSymbol: "" },
  stopPips: NaN,
  targetPips: NaN,
  rr: NaN,
  riskAmount: NaN,
  recommendedLots: NaN,
  withinRisk: false,
  actualRisk: NaN,
  actualRiskPct: NaN,
  notional: NaN,
  margin: NaN,
  freeMargin: NaN,
  marginLevel: NaN,
  canOpen: false,
  grossProfit: NaN,
  grossLoss: NaN,
  costBreakdown: { spread: NaN, commission: NaN, swap: NaN, slippage: NaN, total: NaN },
  netProfit: NaN,
  netLoss: NaN,
  netRr: NaN,
  breakEvenPips: NaN,
  costShareOfWin: NaN,
  rLevels: [],
  warnings: [],
  assumptions: [],
});

export function calculate(input: CalcInput): CalcResult {
  const { spec, entry, stop, direction } = input;

  if (!num(entry) || entry <= 0) return BLOCKED("Enter a price for the entry.");
  if (!num(stop) || stop <= 0) return BLOCKED("Enter a price for the stop.");
  if (entry === stop) {
    return BLOCKED("The stop is at the entry. That is not a tight trade; it is not a trade.");
  }

  /* The direction is stated, not inferred, but a stop on the wrong side of the
     entry means one of the two is a typo. Silently re-deriving the direction
     from the stop would "fix" it and hide the typo — which is how people end up
     sized for a long they entered short. */
  const stopBelow = stop < entry;
  if ((direction === "buy") !== stopBelow) {
    return BLOCKED(
      direction === "buy"
        ? "A buy needs its stop below the entry. Check the direction or the stop."
        : "A sell needs its stop above the entry. Check the direction or the stop.",
    );
  }

  const conv = quoteToUsd(spec, entry, input.crossRate);
  if (!num(conv.value)) {
    const sym = conv.basis.kind === "unknown" ? conv.basis.rateSymbol : "";
    return BLOCKED(
      `${spec.name} settles in ${spec.quote}, so a pip is not a dollar. ` +
        `Supply the ${sym} rate and every figure below fills in.`,
    );
  }

  const pv = pipValue(spec, entry, input.crossRate);
  const pipUsd = pv.value;

  const stopPips = Math.abs(entry - stop) / spec.pip;
  const hasTarget = num(input.takeProfit) && input.takeProfit > 0;
  const targetPips = hasTarget ? Math.abs((input.takeProfit as number) - entry) / spec.pip : NaN;
  const rr = hasTarget && stopPips > 0 ? targetPips / stopPips : NaN;

  const balance = num(input.balance) ? input.balance : 0;
  const equity = num(input.equity) ? input.equity : balance;
  const leverage = num(input.leverage) && input.leverage > 0 ? input.leverage : 1;
  const riskPct = num(input.riskPct) ? input.riskPct : 0;
  const lots = num(input.lots) && input.lots > 0 ? input.lots : 0;

  const riskAmount = (balance * riskPct) / 100;
  const perPipAtOneLot = pipUsd;
  const recommendedLots = stopPips > 0 && perPipAtOneLot > 0 ? riskAmount / (stopPips * perPipAtOneLot) : NaN;

  const perPip = pipUsd * lots;
  const grossLoss = lots * stopPips * pipUsd;
  const grossProfit = hasTarget ? lots * targetPips * pipUsd : NaN;

  /* Notional and margin, through the same conversion as pip value. */
  const notional = lots * spec.contractSize * entry * conv.value;
  const margin = notional / leverage;
  const freeMargin = equity - margin;
  const marginLevel = margin > 0 ? (equity / margin) * 100 : Infinity;
  const canOpen = margin <= equity;

  const c = input.costs;
  const spread = c.spreadPips * perPip;
  const commission = c.commissionPerLot * lots * 2;
  const swap = c.swapPerNight * c.nights * lots;
  const slippage = c.slippagePips * perPip;
  const total = spread + commission + swap + slippage;
  const costBreakdown: CostBreakdown = { spread, commission, swap, slippage, total };

  const netProfit = hasTarget ? grossProfit - total : NaN;
  const netLoss = grossLoss + total;
  const netRr = hasTarget && netLoss > 0 ? netProfit / netLoss : NaN;
  const breakEvenPips = perPip > 0 ? total / perPip : NaN;
  const costShareOfWin = hasTarget && grossProfit > 0 ? (total / grossProfit) * 100 : NaN;

  const actualRisk = grossLoss;
  const actualRiskPct = balance > 0 ? (actualRisk / balance) * 100 : NaN;
  /* Compared against the RULE, not against the recommendation, and with a
     tolerance because a lot step will rarely land exactly on it. */
  const withinRisk = !(actualRiskPct > riskPct * 1.05);

  const stopDistance = Math.abs(entry - stop);
  const sign = direction === "buy" ? 1 : -1;
  const rLevels = [1, 2, 3].map((r) => ({ r, price: entry + sign * r * stopDistance }));

  const warnings: string[] = [];
  const assumptions: string[] = [];

  if (lots === 0) {
    warnings.push("Lot size is zero, so every money figure below is zero. Enter the size you mean to trade.");
  }
  if (!withinRisk) {
    warnings.push(
      `This size risks ${actualRiskPct.toFixed(2)}% of the balance, over the ${riskPct}% rule. ` +
        `${recommendedLots.toFixed(3)} lots is the size that rule allows.`,
    );
  }
  if (!canOpen) {
    warnings.push(
      `Margin required (${margin.toFixed(2)}) is more than the equity (${equity.toFixed(2)}). ` +
        "This position cannot be opened at this leverage.",
    );
  } else if (marginLevel < MARGIN_CALL) {
    warnings.push(`Margin level ${marginLevel.toFixed(0)}% is below 100%. Most brokers stop you out here.`);
  } else if (marginLevel < MARGIN_SAFE) {
    warnings.push(`Margin level ${marginLevel.toFixed(0)}% leaves little room for the position to move against you.`);
  }
  if (spec.maxLeverage !== undefined && leverage > spec.maxLeverage) {
    warnings.push(`${spec.name} caps leverage at 1:${spec.maxLeverage}; you have entered 1:${leverage}.`);
  }
  if (hasTarget && num(netRr) && netRr < 1 && rr >= 1) {
    warnings.push(
      `Costs turn a ${rr.toFixed(2)} reward-to-risk into ${netRr.toFixed(2)}. ` +
        "Before costs this trade wins more than it loses; after them it does not.",
    );
  }

  if (!hasTarget) {
    assumptions.push("No target given, so there is no reward figure — only what the stop costs.");
  }
  if (total === 0) {
    assumptions.push("Costs are all zero. That is not free trading, it is an unfilled cost model.");
  }
  if (c.spreadPips === 0) assumptions.push("Spread not supplied.");
  if (c.commissionPerLot === 0) assumptions.push("Commission not supplied.");
  if (c.nights > 0 && c.swapPerNight === 0) {
    assumptions.push(`Holding ${c.nights} night(s) with swap set to zero.`);
  }
  if (pv.basis.kind === "base-usd") {
    assumptions.push(
      `Pip value derived from the entry price you typed, because ${spec.symbol} quotes ` +
        `${spec.quote} per USD. It moves with the price.`,
    );
  }
  if (pv.basis.kind === "cross") {
    assumptions.push(
      `Pip value converted at ${pv.basis.rateSymbol} = ${pv.basis.rate}. ` +
        "Every USD figure below moves with that rate.",
    );
  }
  if (needsCrossRate(spec) && pv.basis.kind === "cross") {
    assumptions.push("That rate is one you supplied; nothing here fetched or checked it.");
  }

  return {
    ok: true,
    pipValue: pipUsd,
    pipBasis: pv.basis,
    stopPips,
    targetPips,
    rr,
    riskAmount,
    recommendedLots,
    withinRisk,
    actualRisk,
    actualRiskPct,
    notional,
    margin,
    freeMargin,
    marginLevel,
    canOpen,
    grossProfit,
    grossLoss,
    costBreakdown,
    netProfit,
    netLoss,
    netRr,
    breakEvenPips,
    costShareOfWin,
    rLevels,
    warnings,
    assumptions,
  };
}
