/**
 * A DATA RECEIPT — what a result was actually measured on.
 *
 * `docs/PLAN-v63-mcp.md` names this: "extend with source, coverage and
 * spread_kind, so any saved strategy can be re-derived from the exact data that
 * produced it". A number written down without the data behind it is a number
 * nobody can check six months later, and this desk produces numbers people act
 * on.
 *
 * IT RECORDS WHAT THE RUN USED, NOT WHAT IT ASKED FOR.
 *
 * That distinction is the whole point and this project has already paid for it:
 * the Playbook printed "1,598 bars" from the PLAN beside a trade count computed
 * on 999 that actually arrived — both honest alone, and together a claim about a
 * different question. So `bars`, `from`, `to` and `source` here come from the
 * loaded history, and `asked` keeps the request beside them so the gap is
 * visible rather than hidden.
 *
 * THE COST MODEL IS PART OF THE RESULT.
 *
 * A COST MODEL IS A HURDLE, so two runs of the same rule under different spreads
 * are different findings. The receipt states the three terms and whether the
 * spread was measured from the broker or assumed — otherwise "0.12R" is not
 * reproducible even with the same bars.
 *
 * NOTHING IS INVENTED TO FILL A FIELD. A section that did not run is absent
 * rather than zero: `holdout: null` says the split was never made, and a zero
 * there would read as "compared, and found nothing".
 */

import type { Costs, RunFriction, RunSettle } from "./engine";
import type { HoldoutSplit } from "./holdout";
import type { AcrossSummary } from "./across";
import type { HeadToHead } from "./headtohead";
import type { Metrics } from "./metrics";

export interface ReceiptInput {
  readonly ruleId: string;
  readonly ruleName: string;
  /** The rule as it ran, including any edits. Re-derivable from this alone. */
  readonly spec: unknown;
  /** The second rule set folded in as a filter, when there was one. */
  readonly combinedWith: string | null;

  readonly symbol: string;
  readonly timeframe: string;
  /** What the operator asked for. */
  readonly askedFromYear: number;
  readonly askedToYear: number;
  readonly askedBars: number;

  /** What actually arrived. */
  readonly bars: number;
  readonly firstBarTime: number;
  readonly lastBarTime: number;
  readonly source: string;
  /** The loader's own caveat, when the window could not be filled. */
  readonly shortfall: string;

  readonly costs: Costs;
  readonly spreadMeasured: boolean;
  /**
   * What the run ACTUALLY paid, from `BacktestResult.friction`.
   *
   * The three-term cost model above is what was ASKED FOR; this is what came out.
   * They are different facts once a volatility multiple is in play, and this
   * repository has already paid for confusing a request with a result — the
   * Playbook printed "1,598 bars" from the plan beside a trade count computed on
   * 999 that arrived.
   */
  readonly friction: RunFriction;
  /** How many doubtful exits the run settled rather than assumed. */
  readonly settle: RunSettle;

  readonly balance: number;
  readonly riskPct: number;

  readonly metrics: Metrics;
  readonly holdout: HoldoutSplit | null;
  readonly across: AcrossSummary | null;
  readonly headToHead: HeadToHead | null;
}

export interface Receipt {
  readonly kind: "iram-backtest-receipt";
  readonly version: 2;
  /** When it was written, ISO 8601 UTC. */
  readonly at: string;
  readonly rule: {
    readonly id: string;
    readonly name: string;
    readonly combinedWith: string | null;
    readonly spec: unknown;
  };
  readonly data: {
    readonly symbol: string;
    readonly timeframe: string;
    readonly source: string;
    readonly bars: number;
    readonly from: string;
    readonly to: string;
    readonly asked: {
      readonly fromYear: number;
      readonly toYear: number;
      readonly bars: number;
    };
    /** Share of the bars asked for that arrived, 0..1. */
    readonly coverage: number;
    readonly shortfall: string;
  };
  readonly costs: {
    readonly spread: number;
    readonly commission: number;
    readonly slippage: number;
    /**
     * Overnight financing per night held.
     *
     * VERSION 2 EXISTS FOR THIS FIELD. A version 1 receipt did not record it
     * because the engine did not charge it, so every swing result written before
     * this was measured against a hurdle with no financing in it — and the
     * receipt gave a reader no way to tell. An old receipt is still readable and
     * its absence of a carry is a fact about the run, not a missing field.
     */
    readonly carryPerNight: number;
    /** Slippage as a multiple of ATR, when the run scaled it. Null when flat. */
    readonly slippageAtrMult: number | null;
    /** `measured` when the spread came from the broker's contract spec. */
    readonly spreadKind: "measured" | "assumed";
    /** What the run actually paid, which is not the rate once ATR scaling is on. */
    readonly paid: {
      readonly totalPct: number;
      readonly carryPct: number;
      readonly slippagePaid: number;
      readonly nights: number;
      /** Friction over the gross movement the trades captured. */
      readonly shareOfMove: number;
    };
  };
  /**
   * HOW MUCH OF THE RESULT WAS MEASURED RATHER THAN ASSUMED.
   *
   * A backtest whose doubtful exits were all guessed and one whose minutes
   * settled them are different claims about the same equity curve. Recorded here
   * so a result six months old can still be weighed.
   */
  readonly resolved: {
    readonly ambiguousExits: number;
    readonly measuredExits: number;
    /** NaN when nothing was in doubt — not 1, and not 0. */
    readonly share: number;
  };
  readonly account: { readonly balance: number; readonly riskPct: number };
  readonly result: Metrics;
  readonly holdout: HoldoutSplit | null;
  readonly across: AcrossSummary | null;
  readonly headToHead: HeadToHead | null;
}

const iso = (t: number): string =>
  Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : "";

export function buildReceipt(input: ReceiptInput, now: number = Date.now()): Receipt {
  /* COVERAGE IS WHAT ARRIVED OVER WHAT WAS ASKED FOR, clamped at 1: a vendor
     returning more than the window needed is not 140% covered. A zero request
     cannot divide, and reports 0 rather than NaN — a field nobody can read is
     worse here than one that says nothing arrived. */
  const coverage =
    input.askedBars > 0 ? Math.min(1, input.bars / input.askedBars) : 0;

  return {
    kind: "iram-backtest-receipt",
    version: 2,
    at: new Date(now).toISOString(),
    rule: {
      id: input.ruleId,
      name: input.ruleName,
      combinedWith: input.combinedWith,
      spec: input.spec,
    },
    data: {
      symbol: input.symbol,
      timeframe: input.timeframe,
      source: input.source,
      bars: input.bars,
      from: iso(input.firstBarTime),
      to: iso(input.lastBarTime),
      asked: {
        fromYear: input.askedFromYear,
        toYear: input.askedToYear,
        bars: input.askedBars,
      },
      coverage,
      shortfall: input.shortfall,
    },
    costs: {
      spread: input.costs.spread,
      commission: input.costs.commission,
      slippage: input.costs.slippage,
      carryPerNight: input.costs.carryPerNight,
      slippageAtrMult: input.costs.slippageAtrMult ?? null,
      spreadKind: input.spreadMeasured ? "measured" : "assumed",
      paid: {
        totalPct: input.friction.totalPct,
        carryPct: input.friction.carryPct,
        slippagePaid: input.friction.slippagePaid,
        nights: input.friction.nights,
        shareOfMove: input.friction.share,
      },
    },
    resolved: {
      ambiguousExits: input.settle.ambiguous,
      measuredExits: input.settle.measured,
      share: input.settle.share,
    },
    account: { balance: input.balance, riskPct: input.riskPct },
    result: input.metrics,
    holdout: input.holdout,
    across: input.across,
    headToHead: input.headToHead,
  };
}

/** A filename that sorts and does not collide. */
export function receiptFilename(r: Receipt): string {
  const stamp = r.at.replace(/[:.]/g, "-").slice(0, 19);
  const rule = r.rule.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `iram-${r.data.symbol}-${r.data.timeframe}-${rule}-${stamp}.json`;
}

/**
 * The receipt as text, for a file or the clipboard.
 *
 * Indented on purpose: this is read by a person as often as by a program, and a
 * single line of JSON is a receipt nobody opens.
 */
export const receiptText = (r: Receipt): string => JSON.stringify(r, null, 2);
