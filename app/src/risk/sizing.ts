/**
 * Position sizing and portfolio risk.
 *
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE
 * This is ARITHMETIC over numbers you supply. You state your equity, your risk
 * per trade, your entry and your stop; it tells you what quantity those four
 * numbers imply and what you will actually lose if the stop trades.
 *
 * It does not choose your risk percentage, does not tell you whether to take a
 * trade, and cannot place one. Those are the three things a position-size tool
 * is most often quietly asked to do, and all three are yours. What it CAN do is
 * make the consequences of your own numbers impossible to misread — which is
 * the part people get wrong, not the multiplication.
 *
 * THE FOUR THINGS ORDINARY SIZE CALCULATORS GET WRONG
 *
 * 1. THEY REPORT THE RISK YOU ASKED FOR, NOT THE RISK YOU GET. Exchange
 *    quantity steps mean the size you can actually submit is not the size the
 *    formula produced. Round 0.0187 BTC down to 0.018 and your 1% trade is a
 *    0.963% trade; round it up and it is a 1.07% trade. Every number below is
 *    the POST-ROUNDING truth, and the requested figure is shown beside it so
 *    the difference is visible rather than absorbed.
 *
 * 2. THEY DIVIDE BY ZERO AND CALL IT INFINITY. A stop at the entry price is not
 *    a very good trade with a very large size; it is not a trade. The tightest
 *    stop a size calculator will accept is the single most dangerous input in
 *    the whole tool, and this one refuses rather than returning a number that
 *    would liquidate an account.
 *
 * 3. THEY IGNORE THE NOTIONAL. A stop 0.05% away turns 1% of equity into a
 *    2000% notional position, which no venue will fill and no account should
 *    hold. The exposure cap binds, and when it binds it SAYS so — the resulting
 *    risk is then smaller than requested, which you need to know.
 *
 * 4. THEY QUOTE RISK BEFORE COSTS. The stop is not where you exit; the stop
 *    plus the spread, the commission and the slippage is. Fees are optional
 *    input here, but when given they are applied, and when not given that
 *    omission is stated in `assumptions` rather than passed off as zero.
 */

/** Venue constraints for one instrument. All optional; absent means unconstrained. */
export interface Instrument {
  readonly symbol: string;
  /** Quantity increment. 0.001 for BTCUSDT spot, 1 for most equities. */
  readonly qtyStep?: number;
  /** Smallest tradeable quantity. */
  readonly minQty?: number;
  /** Smallest notional the venue accepts, in quote currency. */
  readonly minNotional?: number;
  /** Units per contract. 1 for spot; 100_000 for a standard FX lot. */
  readonly contractSize?: number;
}

export interface SizeInput {
  /** Account equity, in the quote currency. */
  readonly equity: number;
  /** Percent of equity to risk if the stop trades. 1 means one percent. */
  readonly riskPct: number;
  readonly entry: number;
  readonly stop: number;
  readonly instrument?: Instrument;
  /**
   * Ceiling on position notional as a percent of equity.
   *
   * This is the leverage guard, and it is what stops a very tight stop from
   * producing a position the account cannot hold. Default 100 — spot, no
   * leverage. Raise it deliberately.
   */
  readonly maxNotionalPct?: number;
  /** Round-trip costs as a percent of notional: spread + commission + slippage. */
  readonly feesPct?: number;
}

export interface SizeResult {
  readonly ok: boolean;
  /** Present only when ok is false. A sentence, not a code. */
  readonly reason?: string;
  readonly direction: "long" | "short";
  /** Submittable quantity, after venue rounding. */
  readonly qty: number;
  /** Quantity before rounding, for comparison. */
  readonly rawQty: number;
  readonly notional: number;
  readonly notionalPctOfEquity: number;
  /** Currency lost if the stop trades, at the ROUNDED quantity. */
  readonly riskAmount: number;
  /** That loss as a percent of equity. Compare against what you asked for. */
  readonly riskPct: number;
  /** What you asked for, so the gap after rounding is visible. */
  readonly requestedRiskPct: number;
  readonly riskPerUnit: number;
  readonly stopDistancePct: number;
  /** Cost of entering and leaving, when feesPct was supplied. */
  readonly feeAmount: number;
  /** Move from entry needed just to cover costs. */
  readonly breakEvenPct: number;
  /** Things that are true and that you should notice. */
  readonly warnings: readonly string[];
  /** What this calculation could not know. Never silently assumed away. */
  readonly assumptions: readonly string[];
}

/**
 * A stop closer to entry than this fraction of price is treated as an input
 * error rather than a very tight stop.
 *
 * One basis point. Below that, rounding on the venue's own tick size dominates
 * the stop distance entirely, so the computed size is noise amplified by
 * leverage — not a position.
 */
export const MIN_STOP_FRACTION = 0.0001;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Round DOWN to a step. Down, always: rounding up increases risk silently. */
export function roundToStep(qty: number, step: number | undefined): number {
  if (!isNum(step) || step <= 0) return qty;
  return Math.floor(qty / step + 1e-9) * step;
}

/** Decimal places implied by a step, for display without float dust. */
export function stepDecimals(step: number | undefined): number {
  if (!isNum(step) || step <= 0) return 8;
  const s = step.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return Math.min(8, s.length - dot - 1);
}

export function sizePosition(input: SizeInput): SizeResult {
  const { equity, riskPct, entry, stop } = input;
  const instrument = input.instrument;
  const maxNotionalPct = isNum(input.maxNotionalPct) ? input.maxNotionalPct : 100;
  const feesPct = isNum(input.feesPct) ? input.feesPct : 0;

  const direction: "long" | "short" = stop < entry ? "long" : "short";

  const fail = (reason: string): SizeResult => ({
    ok: false,
    reason,
    direction,
    qty: 0,
    rawQty: 0,
    notional: 0,
    notionalPctOfEquity: 0,
    riskAmount: 0,
    riskPct: 0,
    requestedRiskPct: isNum(riskPct) ? riskPct : 0,
    riskPerUnit: 0,
    stopDistancePct: 0,
    feeAmount: 0,
    breakEvenPct: 0,
    warnings: [],
    assumptions: [],
  });

  if (!isNum(equity) || equity <= 0) return fail("Equity must be a positive number.");
  if (!isNum(riskPct) || riskPct <= 0) return fail("Risk per trade must be greater than zero.");
  if (!isNum(entry) || entry <= 0) return fail("Entry price must be a positive number.");
  if (!isNum(stop) || stop <= 0) return fail("Stop price must be a positive number.");

  if (entry === stop) {
    return fail(
      "The stop is at the entry. There is no distance to risk against, so no size exists — this is not a very large position, it is not a position.",
    );
  }

  const riskPerUnitRaw = Math.abs(entry - stop);
  const stopDistancePct = (riskPerUnitRaw / entry) * 100;

  if (riskPerUnitRaw / entry < MIN_STOP_FRACTION) {
    return fail(
      `The stop is ${stopDistancePct.toFixed(4)}% from entry — inside one basis point. At that distance the venue's own tick rounding is larger than the stop, so any size computed from it is noise multiplied by leverage.`,
    );
  }

  const contractSize = isNum(instrument?.contractSize) && instrument.contractSize > 0 ? instrument.contractSize : 1;

  /* Risk and notional are per CONTRACT, not per unit of price, so an FX lot or a
     futures multiplier lands in the arithmetic rather than in the user's head. */
  const riskPerUnit = riskPerUnitRaw * contractSize;
  const pricePerUnit = entry * contractSize;

  const riskBudget = equity * (riskPct / 100);
  const rawQty = riskBudget / riskPerUnit;

  const warnings: string[] = [];
  const assumptions: string[] = [];

  /* --- the exposure cap ------------------------------------------------- */
  const maxNotional = equity * (maxNotionalPct / 100);
  let cappedQty = rawQty;
  let capBound = false;
  if (rawQty * pricePerUnit > maxNotional) {
    cappedQty = maxNotional / pricePerUnit;
    capBound = true;
  }

  /* --- venue rounding ---------------------------------------------------- */
  const qty = roundToStep(cappedQty, instrument?.qtyStep);

  if (qty <= 0) {
    return fail(
      instrument?.qtyStep
        ? `That risk budget buys less than one quantity step (${instrument.qtyStep}). The smallest position this venue accepts would risk more than you have allowed.`
        : "The computed quantity rounds to zero.",
    );
  }

  if (isNum(instrument?.minQty) && qty < instrument.minQty) {
    return fail(
      `Computed quantity ${qty} is below the venue minimum of ${instrument.minQty}. Taking the minimum would exceed your stated risk.`,
    );
  }

  const notional = qty * pricePerUnit;

  if (isNum(instrument?.minNotional) && notional < instrument.minNotional) {
    return fail(
      `Position notional ${notional.toFixed(2)} is below the venue minimum of ${instrument.minNotional}.`,
    );
  }

  const riskAmount = qty * riskPerUnit;
  const actualRiskPct = (riskAmount / equity) * 100;
  const feeAmount = notional * (feesPct / 100);
  const breakEvenPct = feesPct;

  /* --- what you should notice -------------------------------------------- */

  if (capBound) {
    warnings.push(
      `The ${maxNotionalPct}% exposure cap bound before your risk budget did. Risk is ${actualRiskPct.toFixed(3)}%, not the ${riskPct}% you asked for — the stop is too far away to risk that much without holding a larger position than the cap allows.`,
    );
  }

  /* Rounding moves risk in whichever direction the step happens to fall, and
     the gap is worth stating whenever it is more than a rounding whisper. */
  const drift = Math.abs(actualRiskPct - riskPct);
  if (!capBound && drift > riskPct * 0.02) {
    warnings.push(
      `Venue quantity rounding moved the real risk to ${actualRiskPct.toFixed(3)}% from the ${riskPct}% requested — a ${((actualRiskPct / riskPct - 1) * 100).toFixed(1)}% difference. This is the number you are actually trading.`,
    );
  }

  if (feesPct > 0 && feeAmount > riskAmount * 0.1) {
    warnings.push(
      `Round-trip costs of ${feeAmount.toFixed(2)} are ${((feeAmount / riskAmount) * 100).toFixed(0)}% of the amount at risk. Price must move ${breakEvenPct.toFixed(3)}% in your favour before this trade is flat.`,
    );
  }

  if (stopDistancePct < 0.1) {
    warnings.push(
      `The stop is ${stopDistancePct.toFixed(3)}% away. Normal spread and slippage on most venues is a meaningful fraction of that, so the effective stop is wider than the one you set.`,
    );
  }

  const leverage = notional / equity;
  if (leverage > 1.0001) {
    warnings.push(
      `This position is ${leverage.toFixed(2)}x equity. That is leverage, and a gap through your stop can cost more than the amount shown at risk.`,
    );
  }

  /* --- what this could not know ------------------------------------------ */

  if (feesPct === 0) {
    assumptions.push(
      "Costs were not supplied, so spread, commission and slippage are excluded. The real loss at the stop will be larger than the figure shown.",
    );
  }
  assumptions.push(
    "The stop is assumed to fill at its price. A gap, a halt or a thin book can fill it worse, and the loss is then larger than this number.",
  );
  if (!instrument?.qtyStep) {
    assumptions.push("No venue quantity step was supplied, so the raw quantity is shown unrounded.");
  }

  return {
    ok: true,
    direction,
    qty,
    rawQty,
    notional,
    notionalPctOfEquity: (notional / equity) * 100,
    riskAmount,
    riskPct: actualRiskPct,
    requestedRiskPct: riskPct,
    riskPerUnit,
    stopDistancePct,
    feeAmount,
    breakEvenPct,
    warnings,
    assumptions,
  };
}

/* ------------------------------------------------------------ R multiples -- */

export interface RewardResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** Reward divided by risk. 2 means the target is twice the stop distance. */
  readonly r: number;
  /**
   * Win rate at which this R is break-even, BEFORE costs.
   *
   * The single most useful number on the panel: an R of 2 needs 33.3% to break
   * even, and knowing that is what stops "3:1 risk-reward" being treated as a
   * synonym for "good trade". It says nothing about whether you will hit it.
   */
  readonly breakEvenWinRate: number;
}

export function rewardToRisk(entry: number, stop: number, target: number): RewardResult {
  if (![entry, stop, target].every(isNum)) {
    return { ok: false, reason: "Entry, stop and target must all be numbers.", r: 0, breakEvenWinRate: 0 };
  }
  const risk = Math.abs(entry - stop);
  if (risk === 0) {
    return { ok: false, reason: "The stop is at the entry; there is no risk to divide by.", r: 0, breakEvenWinRate: 0 };
  }
  const long = stop < entry;
  const reward = long ? target - entry : entry - target;
  if (reward <= 0) {
    return {
      ok: false,
      reason: long
        ? "The target is at or below the entry on a long. That is not a target."
        : "The target is at or above the entry on a short. That is not a target.",
      r: 0,
      breakEvenWinRate: 0,
    };
  }
  const r = reward / risk;
  return { ok: true, r, breakEvenWinRate: (1 / (1 + r)) * 100 };
}

/* ------------------------------------------------------- portfolio heat --- */

export interface Position {
  readonly symbol: string;
  readonly direction: "long" | "short";
  readonly qty: number;
  readonly entry: number;
  /** Null when the position has no stop — which is the point of tracking it. */
  readonly stop: number | null;
  readonly contractSize?: number;
}

export interface HeatResult {
  /** Sum of open risk as a percent of equity. */
  readonly heatPct: number;
  readonly openRisk: number;
  readonly grossNotional: number;
  readonly netNotional: number;
  /** Positions carrying no stop — their loss is unbounded, so heat understates. */
  readonly unprotected: readonly string[];
  /** True when equity was usable, so `heatPct` is a real number. */
  readonly measured: boolean;
  /** Positions whose stop is already past entry in your favour. No downside. */
  readonly secured: readonly string[];
  /** Risk contributed per symbol, largest first. */
  readonly bySymbol: readonly { symbol: string; risk: number; pctOfEquity: number }[];
  readonly warnings: readonly string[];
}

export function portfolioHeat(
  positions: readonly Position[],
  equity: number,
): HeatResult {
  const warnings: string[] = [];
  const unprotected: string[] = [];
  const risks = new Map<string, number>();

  let openRisk = 0;
  let grossNotional = 0;
  let netNotional = 0;

  const secured: string[] = [];

  for (const p of positions) {
    const mult = isNum(p.contractSize) && p.contractSize > 0 ? p.contractSize : 1;
    const notional = p.qty * p.entry * mult;
    grossNotional += Math.abs(notional);
    netNotional += p.direction === "long" ? notional : -notional;

    if (p.stop === null || !isNum(p.stop)) {
      unprotected.push(p.symbol);
      continue;
    }
    /**
     * RISK IS DIRECTIONAL. It used to be `Math.abs(entry - stop)`, which
     * ignores which side you are on — so a long whose trailing stop has moved
     * ABOVE entry reported the locked-in profit as open risk, and so did a
     * short whose stop had come down below entry. Heat then counted risk-free
     * positions as risk and refused trades you were entitled to take.
     *
     * Clamped at zero rather than allowed negative: a position that cannot
     * lose contributes nothing to heat, but it must not SUBTRACT from the heat
     * of the positions that can.
     */
    const perUnit = p.direction === "long" ? p.entry - p.stop : p.stop - p.entry;
    if (perUnit <= 0) {
      secured.push(p.symbol);
      continue;
    }
    const risk = perUnit * p.qty * mult;
    openRisk += risk;
    risks.set(p.symbol, (risks.get(p.symbol) ?? 0) + risk);
  }

  const equityKnown = isNum(equity) && equity > 0;
  const safeEquity = equityKnown ? equity : NaN;
  const heatPct = (openRisk / safeEquity) * 100;

  /**
   * AN UNMEASURED HEAT MUST SAY SO.
   *
   * Without equity this returns NaN, and every comparison against NaN is
   * false — so a caller checking `heatPct > limit` sails straight through. The
   * figure being unusable has to be visible in the result, not inferred from
   * a quiet NaN.
   */
  if (!equityKnown) {
    warnings.push(
      "Account equity is not set, so heat cannot be expressed as a percentage. The currency figure is real; the percentage is not a number, and any limit checked against it will not bind.",
    );
  }

  if (secured.length > 0) {
    warnings.push(
      `${secured.length} position${secured.length === 1 ? "'s stop is" : "s' stops are"} already past entry in your favour (${secured.join(", ")}). They carry no downside to the stop and are excluded from heat.`,
    );
  }

  if (unprotected.length > 0) {
    warnings.push(
      `${unprotected.length} position${unprotected.length === 1 ? " has" : "s have"} no stop (${unprotected.join(", ")}). Their loss is unbounded, so the heat figure is a FLOOR, not the total.`,
    );
  }

  const bySymbol = [...risks.entries()]
    .map(([symbol, risk]) => ({ symbol, risk, pctOfEquity: (risk / safeEquity) * 100 }))
    .sort((a, b) => b.risk - a.risk);

  const top = bySymbol[0];
  if (top && openRisk > 0 && top.risk / openRisk > 0.6 && bySymbol.length > 1) {
    warnings.push(
      `${top.symbol} carries ${((top.risk / openRisk) * 100).toFixed(0)}% of your open risk. The book is less diversified than the position count suggests.`,
    );
  }

  return {
    heatPct,
    openRisk,
    grossNotional,
    netNotional,
    unprotected,
    measured: equityKnown,
    secured,
    bySymbol,
    warnings,
  };
}

/* ----------------------------------------------------------- daily guard --- */

export interface GuardConfig {
  /** Stop trading for the day past this realised loss, as a percent of equity. */
  readonly dailyLossPct: number;
  /** Refuse a new position that would push total open heat past this. */
  readonly maxHeatPct: number;
  /** Refuse more than this many positions at once. */
  readonly maxPositions: number;
}

export const DEFAULT_GUARDS: GuardConfig = {
  dailyLossPct: 3,
  maxHeatPct: 6,
  maxPositions: 5,
};

export interface GuardInput {
  readonly equity: number;
  /** Realised profit and loss today. Negative is a loss. */
  readonly realisedToday: number;
  readonly openPositions: number;
  readonly currentHeatPct: number;
  /** Heat the position under consideration would add. Zero to just check state. */
  readonly proposedRiskPct?: number;
  readonly config?: GuardConfig;
}

export interface GuardResult {
  /** False when any gate is breached, AND when any gate could not be checked. */
  readonly pass: boolean;
  readonly breaches: readonly string[];
  readonly notes: readonly string[];
  readonly dailyLossPct: number;
  readonly heatAfterPct: number;
  /**
   * True only when every input was usable and every gate genuinely ran.
   *
   * Separate from `pass` because "your rules refused this" and "your rules
   * could not be applied" are different answers that a single boolean cannot
   * distinguish, and a surface that treats them the same is how an unchecked
   * guard reads as a clear one.
   */
  readonly measured: boolean;
}

/**
 * The guardrails, evaluated.
 *
 * These are limits YOU set, checked against numbers YOU report. Nothing here
 * observes a broker or blocks an order — it cannot, and pretending otherwise
 * would be the most dangerous thing in the file. It answers one question: given
 * what you have told it, does this proposal sit inside your own rules?
 */
export function checkGuards(input: GuardInput): GuardResult {
  const cfg = input.config ?? DEFAULT_GUARDS;
  const breaches: string[] = [];
  const notes: string[] = [];

  const equity = isNum(input.equity) && input.equity > 0 ? input.equity : NaN;
  const dailyLossPct = (Math.min(0, input.realisedToday) / equity) * 100;
  const proposed = isNum(input.proposedRiskPct) ? input.proposedRiskPct : 0;
  const heatAfterPct = input.currentHeatPct + proposed;

  /**
   * AN INPUT IT CANNOT READ IS A BREACH, NEVER A PASS.
   *
   * THE BUG THIS FIXES, WHICH WAS THE WORST ONE IN THE FILE. Every comparison
   * below is `>=` or `>` against a computed percentage, and every comparison
   * against NaN is FALSE. So with equity unset, or the day's realised P&L not
   * yet loaded, `dailyLossPct` and `heatAfterPct` both came out NaN, every
   * gate quietly evaluated to "not breached", and the function returned
   * `pass: true` with an EMPTY breach list — measured: down 900 on two open
   * positions, proposing a third, and the answer was "clear".
   *
   * That is a risk guard saying the most reassuring possible thing at exactly
   * the moment it knows nothing. A guard that cannot measure must refuse, and
   * must name what it could not read. Checked BEFORE the gates so that a
   * missing input can never be silently skipped by them.
   */
  if (!isNum(input.equity) || input.equity <= 0) {
    breaches.push(
      "Account equity is not set, so none of these limits can be checked. Set it in Settings ▸ Account & risk — until then this is not a pass, it is an unanswered question.",
    );
  }
  if (!isNum(input.realisedToday)) {
    breaches.push(
      "Today's realised profit and loss is not available, so the daily-loss stop cannot be checked. It has not passed; it has not been evaluated.",
    );
  }
  if (!isNum(input.currentHeatPct)) {
    breaches.push(
      "Current open heat is not a number, so the heat ceiling cannot be checked. Usually this means equity is unset upstream.",
    );
  }
  if (!isNum(input.openPositions)) {
    breaches.push("The open position count is not available, so the position limit cannot be checked.");
  }

  if (-dailyLossPct >= cfg.dailyLossPct) {
    breaches.push(
      `Down ${(-dailyLossPct).toFixed(2)}% today, at or past your ${cfg.dailyLossPct}% daily stop. Your own rule says the day is over.`,
    );
  } else if (-dailyLossPct >= cfg.dailyLossPct * 0.66) {
    notes.push(
      `Down ${(-dailyLossPct).toFixed(2)}% today — two thirds of the way to your ${cfg.dailyLossPct}% daily stop.`,
    );
  }

  if (heatAfterPct > cfg.maxHeatPct) {
    breaches.push(
      `Total open risk would reach ${heatAfterPct.toFixed(2)}%, past your ${cfg.maxHeatPct}% ceiling.`,
    );
  }

  if (proposed > 0 && input.openPositions + 1 > cfg.maxPositions) {
    breaches.push(
      `That would be position ${input.openPositions + 1}, past your limit of ${cfg.maxPositions}.`,
    );
  } else if (proposed === 0 && input.openPositions > cfg.maxPositions) {
    breaches.push(`${input.openPositions} positions open, past your limit of ${cfg.maxPositions}.`);
  }

  notes.push(
    "These are your own limits checked against your own reported numbers. Nothing here can see your broker or prevent an order.",
  );

  const measured =
    isNum(input.equity) &&
    input.equity > 0 &&
    isNum(input.realisedToday) &&
    isNum(input.currentHeatPct) &&
    isNum(input.openPositions);

  return { pass: breaches.length === 0, breaches, notes, dailyLossPct, heatAfterPct, measured };
}

/* ----------------------------------------------------- stop from measured -- */

export interface AtrStopResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly stop: number;
  readonly distancePct: number;
  readonly note: string;
}

/**
 * A stop placed a multiple of ATR from entry.
 *
 * ARITHMETIC, NOT A RECOMMENDATION. It answers "where is 1.5 ATR below this
 * entry", using the ATR the chart already measured. It does not claim that is
 * where your stop belongs — volatility is not structure, and a stop that
 * ignores the level it is protecting against is a stop placed by a formula.
 */
export function stopFromAtr(
  entry: number,
  atr: number,
  multiple: number,
  direction: "long" | "short",
): AtrStopResult {
  if (!isNum(entry) || entry <= 0) return { ok: false, reason: "Entry must be positive.", stop: 0, distancePct: 0, note: "" };
  if (!isNum(atr) || atr <= 0) return { ok: false, reason: "ATR is unavailable for this series.", stop: 0, distancePct: 0, note: "" };
  if (!isNum(multiple) || multiple <= 0) return { ok: false, reason: "The ATR multiple must be positive.", stop: 0, distancePct: 0, note: "" };

  const distance = atr * multiple;
  const stop = direction === "long" ? entry - distance : entry + distance;

  if (stop <= 0) {
    return { ok: false, reason: "That multiple puts the stop at or below zero.", stop: 0, distancePct: 0, note: "" };
  }

  return {
    ok: true,
    stop,
    distancePct: (distance / entry) * 100,
    note: `${multiple}x the measured ATR of ${atr.toPrecision(6)}. This is volatility arithmetic — it does not know what level your stop is meant to sit behind.`,
  };
}
