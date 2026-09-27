/**
 * THE AUTONOMOUS SEARCH'S HURDLE — `backtest/headless.ts readCosts`.
 *
 * `headless.ts` runs the 85-rule autonomous search with nobody watching, and it
 * hardcoded `DEFAULT_COSTS`: a flat 2bp spread on every instrument. A COST MODEL
 * IS A HURDLE, so that silently discards rules that would have cleared the real
 * spread — measured against this operator's broker the assumption is 4.8x the
 * true figure on gold, and overcharging a SEARCH is not the safe direction.
 *
 * WHAT CHANGED IS NOT THE NUMBER.
 *
 * The default is exactly what it always was. A figure that moves under the
 * operator because a service answered is worse than a disagreement they can see,
 * and the machine's promotions must not change with no press behind them. What
 * changed is that the job MAY carry a cost model and the result STATES which one
 * it used — the caller decides, and nothing decides for them.
 *
 * THE TEST THAT MATTERS IS `all three terms or none`. Taking the spread from a
 * job and leaving commission and slippage at their defaults would produce a
 * third model that is neither what was asked for nor what was assumed, and a
 * result charged with it could not be reproduced from either.
 */

import { describe, expect, it } from "vitest";
import { readCosts } from "../src/backtest/headless";
import { DEFAULT_COSTS } from "../src/backtest/engine";

const REAL = { spread: 0.000042, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 };

describe("the default has not moved", () => {
  it("no cost model means exactly what it always charged", () => {
    expect(readCosts(undefined)).toEqual(DEFAULT_COSTS);
    expect(readCosts(null)).toEqual(DEFAULT_COSTS);
    expect(readCosts({})).toEqual(DEFAULT_COSTS);
  });

  it("a job that says nothing about costs is byte-for-byte what it was", () => {
    // The autonomous loop sends no `costs` field today. This is the assertion
    // that its behaviour is unchanged by this feature existing.
    expect(readCosts({ horizon: 100, balance: 500 })).toEqual(DEFAULT_COSTS);
  });
});

describe("a caller may charge something else, and all of it or none", () => {
  it("takes a complete model", () => {
    expect(readCosts(REAL)).toEqual(REAL);
  });

  it("ALL THREE TERMS OR NONE — a partial model is refused entirely", () => {
    // Taking the spread and leaving the other two would be a third cost model,
    // neither asked for nor assumed, and a result charged with it could not be
    // reproduced from either.
    expect(readCosts({ spread: 0.000042 })).toEqual(DEFAULT_COSTS);
    expect(readCosts({ spread: 0.000042, commission: 0.0004 })).toEqual(DEFAULT_COSTS);
    expect(readCosts({ commission: 0.0004, slippage: 0.0001 })).toEqual(DEFAULT_COSTS);
  });

  it("zero is a legitimate term — costs off is a real question", () => {
    // "Does an edge exist at all before frictions" is what ZERO_COSTS is for,
    // so a zero must not be read as absent.
    const free = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };
    expect(readCosts(free)).toEqual(free);
  });

  it("refuses a negative, a NaN, an Infinity or a string", () => {
    for (const bad of [
      { ...REAL, spread: -0.001 },
      { ...REAL, commission: NaN },
      { ...REAL, slippage: Infinity },
      { ...REAL, spread: "0.0002" },
      { ...REAL, spread: null },
    ]) {
      expect(readCosts(bad)).toEqual(DEFAULT_COSTS);
    }
  });

  it("a refusal is the DEFAULT, never a throw", () => {
    // The autonomous loop must not stop searching because a caller sent a bad
    // field. It charges the assumption and the result says so.
    expect(() => readCosts("nonsense")).not.toThrow();
    expect(readCosts("nonsense")).toEqual(DEFAULT_COSTS);
    expect(readCosts(42)).toEqual(DEFAULT_COSTS);
    expect(readCosts([])).toEqual(DEFAULT_COSTS);
  });

  it("ignores extra fields rather than refusing over them", () => {
    // A caller sending a richer object is not an error; only the three terms
    // this engine charges are read.
    expect(readCosts({ ...REAL, swapPerNight: -8466, note: "measured" })).toEqual(REAL);
  });
});
