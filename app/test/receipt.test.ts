/**
 * THE DATA RECEIPT — `backtest/receipt.ts`.
 *
 * `docs/PLAN-v63-mcp.md` names it: "so any saved strategy can be re-derived from
 * the exact data that produced it". A number written down without the data
 * behind it cannot be checked six months later, and this desk produces numbers
 * people act on.
 *
 * THE TEST THAT MATTERS IS `it records what ARRIVED, not what was asked for`.
 * The Playbook once printed "1,598 bars" from the PLAN beside a trade count
 * computed on the 999 that actually came — both honest alone, and together a
 * claim about a different question. A receipt that recorded the request would
 * bake that mistake into the permanent record.
 */

import { describe, expect, it } from "vitest";
import { buildReceipt, receiptFilename, receiptText, type ReceiptInput } from "../src/backtest/receipt";
import { EMPTY_METRICS } from "../src/backtest/metrics";
import { DEFAULT_COSTS } from "../src/backtest/engine";

const NOW = Date.UTC(2026, 8, 25, 12, 30, 15);

const input = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  ruleId: "ema-9-21-cross",
  ruleName: "EMA 9/21 cross",
  spec: { id: "ema-9-21-cross", long: [] },
  combinedWith: null,
  symbol: "BTCUSDT",
  timeframe: "1h",
  askedFromYear: 2022,
  askedToYear: 2026,
  askedBars: 41_489,
  bars: 40_803,
  firstBarTime: Date.UTC(2022, 0, 23),
  lastBarTime: Date.UTC(2026, 8, 25),
  source: "binance",
  shortfall: "",
  costs: DEFAULT_COSTS,
  spreadMeasured: false,
  balance: 500,
  riskPct: 1,
  metrics: { ...EMPTY_METRICS, trades: 1825, expectancyR: -0.114 },
  /* WHAT THE RUN PAID, which is not the same fact as the rate it was charged at.
     A five-night swing on 1,825 trades is where the carry the engine used to
     charge as zero actually lands. */
  friction: {
    spreadPct: 0.4,
    slippagePaid: 0.18,
    commissionPct: 1.46,
    carryPct: 0.91,
    totalPct: 2.77,
    perTradePct: 0.00152,
    share: 0.31,
    nights: 9_125,
    why: "Costs came to 277.000% across 1,825 trades.",
  },
  settle: { ambiguous: 140, measured: 118, assumed: 22, share: 118 / 140, why: "" },
  holdout: null,
  across: null,
  headToHead: null,
  ...over,
});

describe("it records the data the result was measured on", () => {
  it("RECORDS WHAT ARRIVED, NOT WHAT WAS ASKED FOR", () => {
    const r = buildReceipt(input(), NOW);
    expect(r.data.bars).toBe(40_803);
    // The request is kept BESIDE it, so the gap is visible rather than hidden.
    expect(r.data.asked.bars).toBe(41_489);
    expect(r.data.asked.fromYear).toBe(2022);
  });

  it("states coverage as a share of what was asked for", () => {
    const r = buildReceipt(input(), NOW);
    expect(r.data.coverage).toBeCloseTo(40_803 / 41_489, 4);
  });

  it("does not report more than full coverage", () => {
    // A vendor returning more bars than the window needed is not 140% covered.
    const r = buildReceipt(input({ bars: 60_000, askedBars: 41_489 }), NOW);
    expect(r.data.coverage).toBe(1);
  });

  it("a zero request reports no coverage rather than NaN", () => {
    const r = buildReceipt(input({ askedBars: 0, bars: 0 }), NOW);
    expect(r.data.coverage).toBe(0);
    expect(Number.isNaN(r.data.coverage)).toBe(false);
  });

  it("keeps the loader's own caveat about a window it could not fill", () => {
    const why = "1,000 bars arrived of the 15,186 this window needs";
    expect(buildReceipt(input({ shortfall: why }), NOW).data.shortfall).toBe(why);
  });

  it("names the vendor and the real span", () => {
    const r = buildReceipt(input(), NOW);
    expect(r.data.source).toBe("binance");
    expect(r.data.from).toBe("2022-01-23T00:00:00.000Z");
    expect(r.data.to).toBe("2026-09-25T00:00:00.000Z");
  });

  it("an unset time is empty rather than 1970", () => {
    const r = buildReceipt(input({ firstBarTime: 0 }), NOW);
    expect(r.data.from).toBe("");
  });
});

describe("the cost model is part of the result", () => {
  it("records ALL FOUR terms, the carry included", () => {
    // Version 1 recorded three, because the engine charged three. A receipt that
    // omits a cost gives a reader no way to tell whether it was zero or unasked.
    const r = buildReceipt(input(), NOW);
    expect(r.costs.spread).toBe(DEFAULT_COSTS.spread);
    expect(r.costs.commission).toBe(DEFAULT_COSTS.commission);
    expect(r.costs.slippage).toBe(DEFAULT_COSTS.slippage);
    expect(r.costs.carryPerNight).toBe(DEFAULT_COSTS.carryPerNight);
  });

  it("RECORDS WHAT WAS PAID AS WELL AS WHAT WAS CHARGED", () => {
    /* Two different facts. With a volatility multiple in play the rate in the
       cost model is not what any fill paid, and this repository has already paid
       for printing a request beside a result: the Playbook reported "1,598 bars"
       from the plan next to a trade count computed on the 999 that arrived. */
    const r = buildReceipt(input(), NOW);
    expect(r.costs.paid.carryPct).toBe(0.91);
    expect(r.costs.paid.nights).toBe(9_125);
    expect(r.costs.paid.slippagePaid).toBe(0.18);
    expect(r.costs.paid.shareOfMove).toBe(0.31);
  });

  it("states a flat slippage as null rather than as a multiple of zero", () => {
    // A multiple of zero would mean "scaled, and the scaling came to nothing".
    expect(buildReceipt(input(), NOW).costs.slippageAtrMult).toBeNull();
    const scaled = buildReceipt(
      input({ costs: { ...DEFAULT_COSTS, slippageAtrMult: 0.25 } }),
      NOW,
    );
    expect(scaled.costs.slippageAtrMult).toBe(0.25);
  });

  it("records how many doubtful exits were settled rather than guessed", () => {
    // "84% of the doubtful exits were measured" and "every one was assumed" are
    // different claims about one equity curve.
    const r = buildReceipt(input(), NOW);
    expect(r.resolved.ambiguousExits).toBe(140);
    expect(r.resolved.measuredExits).toBe(118);
    expect(r.resolved.share).toBeCloseTo(118 / 140, 12);
  });

  it("a run with nothing in doubt reports an UNKNOWN share, not a perfect one", () => {
    // Reporting 1 would credit a run for resolving exits it never had to.
    const r = buildReceipt(
      input({ settle: { ambiguous: 0, measured: 0, assumed: 0, share: NaN, why: "" } }),
      NOW,
    );
    expect(Number.isNaN(r.resolved.share)).toBe(true);
  });

  it("says whether the spread was MEASURED or ASSUMED", () => {
    // Two runs of one rule under different spreads are different findings, so
    // "0.12R" is not reproducible without this.
    expect(buildReceipt(input(), NOW).costs.spreadKind).toBe("assumed");
    expect(buildReceipt(input({ spreadMeasured: true }), NOW).costs.spreadKind).toBe("measured");
  });
});

describe("nothing is invented to fill a field", () => {
  it("a section that did not run is null, not zero", () => {
    // `holdout: 0` would read as "compared, and found nothing".
    const r = buildReceipt(input(), NOW);
    expect(r.holdout).toBeNull();
    expect(r.across).toBeNull();
    expect(r.headToHead).toBeNull();
  });

  it("carries the rule as it ran, so it can be re-derived", () => {
    const spec = { id: "x", long: [{ a: 1 }] };
    const r = buildReceipt(input({ spec, combinedWith: "Spring" }), NOW);
    expect(r.rule.spec).toEqual(spec);
    expect(r.rule.combinedWith).toBe("Spring");
  });
});

describe("it is readable by a person as well as a program", () => {
  it("round-trips through JSON unchanged", () => {
    const r = buildReceipt(input(), NOW);
    expect(JSON.parse(receiptText(r))).toEqual(r);
  });

  it("is indented, because a receipt nobody opens is not a receipt", () => {
    expect(receiptText(buildReceipt(input(), NOW))).toContain("\n  ");
  });

  it("the filename sorts, names the series, and is safe on a filesystem", () => {
    const name = receiptFilename(buildReceipt(input(), NOW));
    expect(name).toMatch(/^iram-BTCUSDT-1h-EMA-9-21-cross-2026-09-25T12-30-15\.json$/);
    expect(name).not.toMatch(/[:/\\?*"<>|]/);
  });

  it("a rule name full of punctuation still makes a legal filename", () => {
    const name = receiptFilename(buildReceipt(input({ ruleName: 'A/B "test": 50%' }), NOW));
    expect(name).not.toMatch(/[:/\\?*"<>|]/);
    expect(name.endsWith(".json")).toBe(true);
  });

  it("carries its own kind and version, so a reader can tell what it is", () => {
    const r = buildReceipt(input(), NOW);
    expect(r.kind).toBe("iram-backtest-receipt");
    expect(r.version).toBe(2);
    /* VERSION 2 EXISTS FOR THE CARRY. A version 1 receipt recorded three cost
       terms because the engine charged three, so every swing result written
       before this was measured against a hurdle with no financing in it and the
       receipt gave a reader no way to tell. The number has to move when the
       meaning does, or a reader cannot know which they are holding. */
    expect(r.at).toBe("2026-09-25T12:30:15.000Z");
  });
});
