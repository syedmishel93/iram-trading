/**
 * ONE RULE ACROSS SEVERAL MARKETS — `backtest/across.ts`.
 *
 * The Playbook tested one rule on one market, and one market cannot say whether
 * an edge is real or a property of that market's last few years.
 *
 * THE TESTS THAT MATTER ARE THE ONES ABOUT NOT RANKING. The obvious build sorts
 * by expectancy and puts the winner on top, which turns six honest measurements
 * into a search — and this project already records that a sorted table always
 * has a big number at the top, "including on data with no edge in it". So the
 * summary COUNTS and NAMES; it never picks. `it does not report a best market`
 * is the guard on that.
 *
 * And `one-market`: positive on one of six is a finding about that one market,
 * not about the rule, and it has to be said in those words rather than left as
 * "17% of markets".
 */

import { describe, expect, it } from "vitest";
import { summariseAcross, MIN_TRADES_PER_MARKET, type MarketRun } from "../src/backtest/across";

const run = (symbol: string, expectancyR: number, trades = 100): MarketRun => ({
  symbol,
  timeframe: "1h",
  trades,
  expectancyR,
  winRate: 0.5,
  refused: false,
  why: "",
});

const cannot = (symbol: string, why = "no history"): MarketRun => ({
  symbol,
  timeframe: "1h",
  trades: 0,
  expectancyR: NaN,
  winRate: NaN,
  refused: true,
  why,
});

describe("it counts and names, and never picks a winner", () => {
  it("does not report a best market", () => {
    const s = summariseAcross([run("BTCUSDT", 0.9), run("XAUUSD", 0.1), run("EURUSD", 0.05)]);
    // Nothing in the summary singles out the highest. A `best` field is exactly
    // the search this must not become.
    expect(Object.keys(s)).not.toContain("best");
    expect(s.why).not.toMatch(/best/i);
    expect(s.positive).toBe(3);
  });

  it("names every market in the group it belongs to", () => {
    const s = summariseAcross([run("BTCUSDT", 0.4), run("XAUUSD", -0.2), cannot("SOLUSDT")]);
    expect(s.worked).toEqual(["BTCUSDT"]);
    expect(s.failed).toEqual(["XAUUSD"]);
    expect(s.couldNot).toEqual(["SOLUSDT"]);
  });

  it("reports consistency when every market that answered agrees", () => {
    const s = summariseAcross([run("A", 0.3), run("B", 0.2), run("C", 0.4)]);
    expect(s.verdict).toBe("consistent");
    expect(s.why).toMatch(/all 3/);
  });

  it("CALLS ONE WINNER OUT OF MANY WHAT IT IS", () => {
    const s = summariseAcross([run("BTCUSDT", 0.6), run("A", -0.1), run("B", -0.2), run("C", -0.3)]);
    expect(s.verdict).toBe("one-market");
    expect(s.why).toMatch(/finding about BTCUSDT, not about the rule/i);
  });

  it("says so when it lost everywhere", () => {
    const s = summariseAcross([run("A", -0.3), run("B", -0.1)]);
    expect(s.verdict).toBe("mixed");
    expect(s.why).toMatch(/negative on all 2/i);
  });

  it("is mixed when fewer than half worked", () => {
    const s = summariseAcross([run("A", 0.3), run("B", 0.2), run("C", -0.1), run("D", -0.2), run("E", -0.4)]);
    expect(s.verdict).toBe("mixed");
    expect(s.positive).toBe(2);
    expect(s.negative).toBe(3);
  });
});

describe("a market that could not answer is not a market that said no", () => {
  it("counts thin markets apart rather than as failures", () => {
    const s = summariseAcross([run("A", 0.3), run("B", 0.2), cannot("C"), cannot("D")]);
    expect(s.answered).toBe(2);
    expect(s.negative).toBe(0);
    expect(s.couldNot).toEqual(["C", "D"]);
    // The denominator is what ANSWERED, and the skipped are named anyway.
    expect(s.why).toMatch(/could not answer and are not counted either way/i);
  });

  it("treats too few trades as unable to answer, not as a result", () => {
    const thin = run("C", 0.9, MIN_TRADES_PER_MARKET - 1);
    const s = summariseAcross([run("A", 0.1), run("B", 0.1), thin]);
    expect(s.couldNot).toEqual(["C"]);
    expect(s.positive).toBe(2);
  });

  it("treats a NaN expectancy as unable to answer", () => {
    const s = summariseAcross([run("A", 0.1), run("B", 0.2), run("C", NaN)]);
    expect(s.couldNot).toEqual(["C"]);
  });

  it("refuses outright when nothing could answer", () => {
    const s = summariseAcross([cannot("A"), cannot("B")]);
    expect(s.verdict).toBe("thin");
    expect(s.answered).toBe(0);
    expect(Number.isNaN(s.meanExpectancyR)).toBe(true);
  });

  it("ONE ANSWER IS NOT A COMPARISON", () => {
    // "It worked on 1 of 1" is a percentage over a sample of one: the shape of
    // a measurement without being one.
    const s = summariseAcross([run("BTCUSDT", 0.5), cannot("A"), cannot("B")]);
    expect(s.verdict).toBe("one-market");
    expect(s.why).toMatch(/says nothing about whether the rule generalises/i);
  });

  it("nothing selected is its own state", () => {
    const s = summariseAcross([]);
    expect(s.verdict).toBe("none");
    expect(s.tried).toBe(0);
  });
});

describe("the mean is over what answered", () => {
  it("excludes the markets that could not answer", () => {
    const s = summariseAcross([run("A", 0.2), run("B", 0.4), cannot("C")]);
    expect(s.meanExpectancyR).toBeCloseTo(0.3);
  });
});
