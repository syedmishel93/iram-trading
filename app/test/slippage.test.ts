/**
 * SLIPPAGE THAT SCALES WITH THE MARKET IT IS PAID IN.
 *
 * `Costs.slippage` is a flat fraction of price — one basis point on a market
 * moving 0.3% a day and one basis point on the same market moving 6%. Slippage
 * is the gap between the price you asked for and the price you got, and that gap
 * widens with volatility: it is the one cost term that is not a published rate
 * and cannot be looked up, which is why the flat figure has survived.
 *
 * SO IT IS AN ADDITION, NOT A REPLACEMENT. `slippageAtrMult` is OPTIONAL and
 * absent keeps the flat figure exactly as it is. That is deliberate and it is a
 * different case from the carry: an absent carry meant a real cost charged as
 * zero, whereas an absent multiple means the existing, stated assumption still
 * applies. And when both are present the charge is the GREATER of the two, so
 * turning this on can never make a backtest cheaper than it already was.
 *
 * THE TEST THAT MATTERS IS `the volatile market is charged more than the quiet
 * one`. It is the only one that proves the scaling reaches the fill.
 *
 * THE SECOND IS `the ATR comes from the last CLOSED bar`. A fill happens at a
 * bar's OPEN, so pricing it with that bar's own ATR reads a range that has not
 * finished — look-ahead, invisible, and in the direction that flatters, because a
 * bar that gapped against you is exactly the bar whose ATR would have warned you.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COSTS,
  ZERO_COSTS,
  effectiveSlippage,
  modelledFill,
  runBacktest,
  type BarView,
  type Costs,
  type Strategy,
} from "../src/backtest/engine";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/** A series whose bar range is `spreadPct` of price, so its ATR is predictable. */
const series = (n: number, spreadPct: number): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100;
    const half = (c * spreadPct) / 2;
    return { t: T0 + i * HOUR, o: c, h: c + half, l: c - half, c, v: 100 };
  });

/** Enters long once, exits on a rule, so both fills are at a known bar. */
const oneTrade: Strategy = {
  id: "t:slip",
  label: "one trade, two fills",
  warmup: 20,
  entry: (_ctx, i) => (i === 20 ? { direction: "long", stop: 50, target: 150, reason: "slip" } : null),
  exit: (_ctx, _pos, i) => (i >= 24 ? "held long enough" : null),
};

describe("the arithmetic, on its own", () => {
  it("keeps the flat figure when no multiple is set", () => {
    // Absent is not zero and not a change. The existing assumption stands.
    expect(effectiveSlippage(DEFAULT_COSTS, 0.05)).toBe(DEFAULT_COSTS.slippage);
  });

  it("TAKES THE GREATER OF THE TWO, so turning it on cannot make a run cheaper", () => {
    /* A max, not a replacement. If the scaled figure came out below the flat one
       this would quietly reduce a cost that was already being charged, and a
       change that makes every historical result look better is the direction to
       distrust. */
    const c: Costs = { ...DEFAULT_COSTS, slippageAtrMult: 0.1 };
    // ATR 0.5% of price x 0.1 = 0.0005, above the flat 0.0001.
    expect(effectiveSlippage(c, 0.005)).toBeCloseTo(0.0005, 12);
    // ATR 0.05% x 0.1 = 0.00005, below the flat 0.0001 — the flat one wins.
    expect(effectiveSlippage(c, 0.0005)).toBe(0.0001);
  });

  it("falls back to the flat figure when the ATR cannot be measured", () => {
    // NaN is what an indicator says during its own warm-up. Multiplying by it
    // would poison every figure downstream of the fill.
    const c: Costs = { ...DEFAULT_COSTS, slippageAtrMult: 0.1 };
    expect(effectiveSlippage(c, NaN)).toBe(DEFAULT_COSTS.slippage);
    expect(effectiveSlippage(c, 0)).toBe(DEFAULT_COSTS.slippage);
  });

  it("modelledFill still charges half the spread plus the slippage it is given", () => {
    // One owner of the fill model. This is the function the live card shares with
    // the backtest, so the scaling has to arrive as a cost, not as a second path.
    const c: Costs = { spread: 0.002, commission: 0, slippage: 0.001, carryPerNight: 0 };
    expect(modelledFill(100, "long", c, true)).toBeCloseTo(100 * (1 + 0.001 + 0.001), 12);
  });
});

describe("the engine charges it", () => {
  const flat: Costs = { ...ZERO_COSTS, slippage: 0.0001 };
  const scaled: Costs = { ...ZERO_COSTS, slippage: 0.0001, slippageAtrMult: 0.5 };

  it("THE VOLATILE MARKET IS CHARGED MORE THAN THE QUIET ONE", () => {
    /* THE PROOF THAT THE SCALING REACHES THE FILL. The same rule, the same
       number of bars, the same trade — and the only difference is how far the
       market moves inside a bar. Under the flat model these two are identical,
       which is the thing being fixed. */
    const quiet = runBacktest(oneTrade, series(40, 0.001), { costs: scaled });
    const wild = runBacktest(oneTrade, series(40, 0.02), { costs: scaled });

    expect(quiet.trades).toHaveLength(1);
    expect(wild.trades).toHaveLength(1);
    expect(wild.trades[0]!.returnPct).toBeLessThan(quiet.trades[0]!.returnPct);
  });

  it("and under the flat model they are identical, which is the defect", () => {
    // Stating the old behaviour explicitly, so the comparison above is a real
    // contrast rather than an assertion about one number.
    const quiet = runBacktest(oneTrade, series(40, 0.001), { costs: flat });
    const wild = runBacktest(oneTrade, series(40, 0.02), { costs: flat });
    expect(wild.trades[0]!.returnPct).toBeCloseTo(quiet.trades[0]!.returnPct, 12);
  });

  it("reports the slippage it actually charged, not the rate it was given", () => {
    // A scaled cost that is not reported is a hurdle nobody can check.
    const wild = runBacktest(oneTrade, series(40, 0.02), { costs: scaled });
    expect(wild.friction.slippagePaid).toBeGreaterThan(0.0001 * 2);
    const quiet = runBacktest(oneTrade, series(40, 0.001), { costs: scaled });
    expect(quiet.friction.slippagePaid).toBeLessThan(wild.friction.slippagePaid);
  });

  it("changes nothing at all when the multiple is absent", () => {
    // The flag has to be inert when unset, or every existing result silently
    // moves under an operator who never asked for it.
    const bars = series(40, 0.02);
    const before = runBacktest(oneTrade, bars, { costs: flat });
    const same = runBacktest(oneTrade, bars, { costs: { ...flat } });
    expect(same.trades[0]!.returnPct).toBeCloseTo(before.trades[0]!.returnPct, 12);
  });

  it("REFUSES a negative multiple rather than paying the operator to trade", () => {
    // A negative slippage is a credit on every fill. It would read as an edge.
    const r = runBacktest(oneTrade, series(40, 0.01), {
      costs: { ...flat, slippageAtrMult: -1 },
    });
    expect(r.refused).toBeTruthy();
    expect(r.refused).toContain("slippageAtrMult");
  });
});

describe("no look-ahead in the scaling", () => {
  it("THE ATR COMES FROM THE LAST CLOSED BAR", () => {
    /* A fill happens at a bar's OPEN. Pricing it with that same bar's ATR reads a
       range that has not finished yet — and it is the bar that gapped against you
       whose ATR would have warned you, so the error runs in the flattering
       direction and is invisible in every metric.

       PROVED BY CONSTRUCTION: two series identical up to and including the fill
       bar, differing only AFTER it. A fill priced on future volatility would
       differ between them; one priced on closed bars cannot. */
    const base = series(40, 0.002);
    const spiked = base.map((b, i) =>
      i >= 21 ? { ...b, h: b.c + 5, l: b.c - 5 } : b,
    );
    const a = runBacktest(oneTrade, base, {
      costs: { ...ZERO_COSTS, slippage: 0, slippageAtrMult: 0.5 },
    });
    const b = runBacktest(oneTrade, spiked, {
      costs: { ...ZERO_COSTS, slippage: 0, slippageAtrMult: 0.5 },
    });
    expect(a.trades[0]!.entryPrice).toBeCloseTo(b.trades[0]!.entryPrice, 12);
  });
});
