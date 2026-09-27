/**
 * WHAT A RUN IS CHARGED — `backtest/realcosts.ts`.
 *
 * `DEFAULT_COSTS` charges a flat 2bp spread on every instrument. MEASURED
 * against this operator's broker that is 4.7x the real spread on XAUUSD, 3.8x on
 * EURUSD and 2.8x on BTCUSD — and because costs set the hurdle a rule has to
 * clear, overcharging is not the safe direction. It DISCARDS rules that would
 * have cleared the real spread, silently.
 *
 * THE TEST THAT MATTERS IS `it never switches on its own`. CLAUDE.md is explicit
 * that a figure which moves under the operator because a service answered is
 * worse than a disagreement they can see, so the measured spread is offered and
 * never adopted by default.
 *
 * And `partial`: only the SPREAD is measured. A cost model that quietly replaced
 * one term and kept two would be a third thing, neither measured nor assumed.
 */

import { describe, expect, it } from "vitest";
import { resolveCosts } from "../src/backtest/realcosts";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import type { BrokerSpec } from "../src/data/brokercosts";

/** BTCUSD as this operator's broker actually reports it. */
const BTCUSD: BrokerSpec = {
  symbol: "BTCUSD",
  digits: 2,
  point: 0.01,
  spread_points: 600,
  contract_size: 1,
  tick_size: 0.01,
  tick_value: 0.01,
  stops_level: 0,
  swap_long: -8466.6,
  swap_short: -5554.2,
} as BrokerSpec;

const PRICE = 84_000;

describe("the assumption stands unless the operator asks", () => {
  it("never switches on its own", () => {
    // The whole point. A hurdle that changed because a service answered is a
    // result that moved for a reason nobody chose.
    const r = resolveCosts(BTCUSD, PRICE, false);
    expect(r.measured).toBe(false);
    expect(r.costs.spread).toBe(DEFAULT_COSTS.spread);
  });

  it("but SAYS the assumption is wrong, and by how much", () => {
    // Known-and-not-used is its own state: the operator is running a hurdle
    // they can now see is wrong in a direction.
    const r = resolveCosts(BTCUSD, PRICE, false);
    expect(r.measuredSpread).not.toBeNull();
    expect(r.why).toMatch(/your broker's spread/i);
    expect(r.why).toMatch(/\dx/);
  });

  it("charges the measured spread when asked", () => {
    const r = resolveCosts(BTCUSD, PRICE, true);
    expect(r.measured).toBe(true);
    expect(r.costs.spread).toBeLessThan(DEFAULT_COSTS.spread);
    expect(r.label).toMatch(/measured spread/);
  });

  it("the measured spread matches the broker's own numbers", () => {
    // 600 points x 0.01 = $6.00 on an $84,000 price = 0.71bp, which is the
    // figure CLAUDE.md records measuring for this instrument.
    const r = resolveCosts(BTCUSD, PRICE, true);
    expect(r.measuredSpread! * 10000).toBeCloseTo(0.71, 1);
  });
});

describe("it refuses to guess the terms it cannot measure", () => {
  it("keeps commission and slippage assumed, and says so", () => {
    const r = resolveCosts(BTCUSD, PRICE, true);
    expect(r.costs.commission).toBe(DEFAULT_COSTS.commission);
    expect(r.costs.slippage).toBe(DEFAULT_COSTS.slippage);
    expect(r.partial).toBe(true);
    expect(r.why).toMatch(/commission and slippage/i);
  });

  it("falls back with a reason when no spec has been synced", () => {
    const r = resolveCosts(null, PRICE, true);
    expect(r.measured).toBe(false);
    expect(r.costs).toEqual(DEFAULT_COSTS);
    expect(r.why).toMatch(/broker sync/i);
  });

  it("falls back when the spec gives no usable spread", () => {
    const broken = { ...BTCUSD, spread_points: 0 } as BrokerSpec;
    const r = resolveCosts(broken, PRICE, true);
    expect(r.measured).toBe(false);
    expect(r.why).toMatch(/does not give a usable spread/i);
  });

  it("always carries a label, so the status strip can never go blank", () => {
    for (const [spec, use] of [
      [BTCUSD, true],
      [BTCUSD, false],
      [null, true],
    ] as const) {
      expect(resolveCosts(spec, PRICE, use).label.length).toBeGreaterThan(0);
    }
  });
});
