/**
 * THE CHECK THAT KNOWS THE RULE WAS FOUND BY A SEARCH.
 *
 * MEASURED BEFORE THIS EXISTED. `setup/gates.ts` imported exactly two things
 * from outside its own concerns — `Prior` and `MIN_FOR_RATE` — and had no
 * reference to `trials`, to `deflatedSharpe`, or to the best-of-N hurdle
 * anywhere in 855 lines. So the autonomous card could propose a live trade from
 * a rule that won a 550-arm search, and every check it showed was about the
 * market: the spread, the stop, the clock, the calendar. Nothing asked the one
 * question the search itself answers — whether this rule beat what searching
 * that wide would have turned up on no edge at all.
 *
 * The Simulation desk computes that hurdle and puts it on screen. The thing that
 * decides whether to trade never consulted it. A statistic shown on one desk and
 * absent from the decision is a statistic nobody acts on.
 *
 * THE TEST THAT MATTERS IS `a rule that did not clear its own hurdle BLOCKS`.
 * It is the only one that proves the arithmetic changes the verdict rather than
 * adding a row to a card.
 *
 * THE SECOND IS `a hand-drawn setup gets no search check at all`. A manual setup
 * was not found by a search, so it has no multiplicity to pay for, and a row
 * reading "not found by a search" on every manual trade is the kind of noise
 * that teaches an operator to skim the list.
 *
 * AND THE THIRD IS THAT THE HURDLE IS NOT AN INPUT. `deflatedSharpe` in
 * `study/stats.ts` is the one owner of that arithmetic, and it is defined on a
 * PER-TRADE Sharpe — this repository has already recorded an annualised figure
 * put through it deflating 4.93 by 0.85 and printing as though the search had
 * been paid for. Handing this gate a pre-computed `deflated` would let a caller
 * supply the conclusion, so it is handed the three raw facts and does the
 * division itself.
 */

import { describe, expect, it } from "vitest";
import { evaluateGates, type GateInputs } from "../src/setup/gates";
import { deflatedSharpe } from "../src/study/stats";

/** Everything else passing, so only the search check can move the verdict. */
const CLEAN: GateInputs = {
  record: null,
  dataAgeMs: 1_000,
  dataStaleAfterMs: 60_000,
  dataTransport: "socket",
  clockOffsetMs: 0,
  clockMatters: false,
  minutesToEvent: null,
  eventName: null,
  embargoMinutes: 15,
  spread: 0.1,
  spreadKind: "dealing",
  stopDistance: 10,
  spreadBudgetPct: 10,
  topOfBookQty: null,
  plannedQty: null,
  openHeatPct: 0.5,
  thisTradeRiskPct: 0.5,
  maxHeatPct: 5,
  realisedTodayPct: 0,
  dailyLossLimitPct: 3,
  coverage: 0.999,
  coverageCeiling: 1,
  coverageFloor: 0.98,
  sourcesFailed: [],
  stopAtrMultiple: 1.5,
  saneAtrBand: [0.5, 4],
};

const find = (i: GateInputs) => evaluateGates(i).find((g) => g.id === "search");

describe("a setup that was not found by a search", () => {
  it("GETS NO SEARCH CHECK AT ALL", () => {
    // A hand-drawn setup has no multiplicity to pay for. A permanently passing
    // row saying so is noise on a card whose whole value is that every row on it
    // is worth reading.
    expect(find(CLEAN)).toBeUndefined();
    expect(find({ ...CLEAN, search: null })).toBeUndefined();
  });

  it("does not change how many checks the other gates report", () => {
    const without = evaluateGates(CLEAN);
    expect(without.some((g) => g.id === "search")).toBe(false);
    expect(without.length).toBeGreaterThan(5);
  });
});

describe("a setup that came out of a search", () => {
  /* 550 arms is the real width of this product's conditioned field: 25 shipped
     rules against 6 macro states plus the library and the hybrids. */
  const TRIALS = 550;

  it("A RULE THAT DID NOT CLEAR ITS OWN HURDLE BLOCKS", () => {
    /* THE PROOF THAT THE ARITHMETIC REACHES THE DECISION. The measured case:
       across 5 years of 1h bars the best arm scored +0.070 of per-trade Sharpe
       against a hurdle of +0.102, and the card would have offered it. */
    const g = find({
      ...CLEAN,
      search: { trials: TRIALS, perTradeSharpe: 0.07, trades: 821 },
    });
    expect(g).toBeTruthy();
    expect(g!.status).toBe("block");
    expect(g!.text).toContain("550");
  });

  it("a rule that DID clear it passes, and says by how much", () => {
    // The gate must be passable, or it is a switch the operator learns to turn
    // off rather than a check they read.
    const g = find({
      ...CLEAN,
      search: { trials: TRIALS, perTradeSharpe: 0.6, trades: 821 },
    });
    expect(g).toBeTruthy();
    expect(g!.status).toBe("pass");
  });

  it("the SAME rule blocks once the field is wide enough", () => {
    // The whole point of the correction: a result is a claim about the search
    // that produced it, so widening the field can retire a winner without one
    // bar of data changing. Nothing else here moves between these two calls.
    const narrow = find({ ...CLEAN, search: { trials: 4, perTradeSharpe: 0.14, trades: 120 } });
    const wide = find({ ...CLEAN, search: { trials: 20_000, perTradeSharpe: 0.14, trades: 120 } });
    expect(narrow!.status).toBe("pass");
    expect(wide!.status).toBe("block");
  });

  it("uses `deflatedSharpe` rather than its own copy of the arithmetic", () => {
    // One owner. A second implementation of the hurdle is a second place for the
    // units to be wrong, and the units are what this correction is about.
    const expected = deflatedSharpe(0.07, TRIALS, 821);
    const g = find({
      ...CLEAN,
      search: { trials: TRIALS, perTradeSharpe: 0.07, trades: 821 },
    });
    expect(g!.why).toContain(expected.hurdle.toFixed(2));
  });

  it("a block names what would change it, and it is not this trade", () => {
    // `clears` is an instruction. Nothing about THIS setup can fix a hurdle
    // that belongs to the search, and saying "tighten the stop" would be a lie.
    const g = find({ ...CLEAN, search: { trials: TRIALS, perTradeSharpe: 0.07, trades: 821 } });
    expect(g!.clears).toBeTruthy();
    expect(g!.clears!.length).toBeGreaterThan(20);
  });

  it("refuses to judge a search it cannot count, rather than passing it", () => {
    // "Could not ask" is not "nothing to pay". A zero or missing trial count
    // would make the hurdle zero and every rule clear it.
    for (const bad of [
      { trials: 0, perTradeSharpe: 0.3, trades: 500 },
      { trials: NaN, perTradeSharpe: 0.3, trades: 500 },
      { trials: TRIALS, perTradeSharpe: NaN, trades: 500 },
      { trials: TRIALS, perTradeSharpe: 0.3, trades: 0 },
    ]) {
      const g = find({ ...CLEAN, search: bad });
      expect(g, JSON.stringify(bad)).toBeTruthy();
      expect(g!.status, JSON.stringify(bad)).toBe("unknown");
    }
  });

  it("states the trade count, because the hurdle falls as it rises", () => {
    // `sqrt(2 ln N) / sqrt(n)`: trades are the only lever that lowers the bar,
    // so a hurdle quoted without its sample is a number nobody can argue with.
    const g = find({ ...CLEAN, search: { trials: TRIALS, perTradeSharpe: 0.07, trades: 821 } });
    expect(g!.why).toContain("821");
  });
});

describe("what the verdict does with it", () => {
  it("a blocking search check blocks the whole verdict", () => {
    // A check that cannot refuse is decoration.
    const gates = evaluateGates({
      ...CLEAN,
      search: { trials: 550, perTradeSharpe: 0.07, trades: 821 },
    });
    expect(gates.filter((g) => g.status === "block").map((g) => g.id)).toContain("search");
  });
});
