/**
 * TWO RULE SETS ON THE SAME BARS — `backtest/headtohead.ts`.
 *
 * Side-by-side figures are the easiest place in a backtest panel to mislead: the
 * eye picks the bigger number and the bigger number is usually noise. 0.12R
 * beside 0.09R over forty trades each looks like a winner and is a coin landing
 * the same way twice.
 *
 * THE TEST THAT MATTERS IS `a small gap on noisy trades is a TIE`. Without it,
 * every other assertion here passes on a comparison that always names a winner —
 * which is the feature being wrong in the one way that costs money.
 */

import { describe, expect, it } from "vitest";
import { compareRules, MIN_PER_RULE, SE_THRESHOLD } from "../src/backtest/headtohead";
import type { Trade } from "../src/backtest/engine";

const trade = (r: number, i = 0): Trade =>
  ({
    direction: "long",
    entryIndex: i,
    entryTime: 1_700_000_000_000 + i * 3_600_000,
    entryPrice: 100,
    exitIndex: i + 1,
    exitTime: 1_700_000_000_000 + (i + 1) * 3_600_000,
    exitPrice: 100 + r,
    exitReason: r > 0 ? "target" : "stop",
    rMultiple: r,
    returnPct: r / 100,
    reason: "test",
  }) as Trade;

/** `n` trades whose R values alternate around `centre` with spread `spread`. */
const noisy = (n: number, centre: number, spread: number): Trade[] =>
  Array.from({ length: n }, (_, i) => trade(centre + (i % 2 === 0 ? spread : -spread), i));

describe("it refuses a comparison the samples cannot support", () => {
  it("names the side that is short", () => {
    const got = compareRules("EMA", noisy(10, 0.2, 1), "Spring", noisy(60, 0.1, 1));
    expect(got.verdict).toBe("thin");
    expect(got.why).toMatch(/EMA has only 10 trades/);
  });

  it("says so when both are short", () => {
    const got = compareRules("A", noisy(5, 0.2, 1), "B", noisy(6, 0.1, 1));
    expect(got.verdict).toBe("thin");
    expect(got.why).toMatch(/A has 5 trades and B has 6/);
  });

  it("a refusal carries no difference to misread", () => {
    const got = compareRules("A", noisy(5, 0.9, 1), "B", noisy(60, 0.1, 1));
    expect(Number.isNaN(got.difference)).toBe(true);
    expect(Number.isNaN(got.sigmas)).toBe(true);
    // The COUNTS still come through — they are what the operator acts on.
    expect(got.a.trades).toBe(5);
    expect(got.b.trades).toBe(60);
  });

  it("the floor is the stated one", () => {
    const justUnder = compareRules("A", noisy(MIN_PER_RULE - 1, 0.2, 1), "B", noisy(80, 0.1, 1));
    const justOver = compareRules("A", noisy(MIN_PER_RULE, 0.2, 1), "B", noisy(80, 0.1, 1));
    expect(justUnder.verdict).toBe("thin");
    expect(justOver.verdict).not.toBe("thin");
  });
});

describe("a gap inside the noise is a tie", () => {
  it("A SMALL GAP ON NOISY TRADES IS A TIE, not a winner", () => {
    // 0.12R against 0.09R with a spread of 1R either side: the gap is a
    // fraction of a standard error, and naming a winner here is the defect.
    const got = compareRules("EMA", noisy(60, 0.12, 1), "Spring", noisy(60, 0.09, 1));
    expect(got.verdict).toBe("tie");
    expect(got.sigmas).toBeLessThan(SE_THRESHOLD);
    expect(got.why).toMatch(/choosing the higher one is choosing noise/i);
  });

  it("states the gap and the standard errors, so the reader can judge", () => {
    const got = compareRules("A", noisy(60, 0.12, 1), "B", noisy(60, 0.09, 1));
    expect(got.why).toMatch(/standard errors/);
    expect(got.standardError).toBeGreaterThan(0);
    expect(Number.isFinite(got.difference)).toBe(true);
  });

  it("identical runs are a tie with a zero gap", () => {
    const got = compareRules("A", noisy(60, 0.1, 1), "B", noisy(60, 0.1, 1));
    expect(got.verdict).toBe("tie");
    expect(got.difference).toBeCloseTo(0);
  });

  it("INFINITY IS A BUG; NaN IS A REFUSAL — floating-point dust does not divide", () => {
    // THIS TEST FOUND A REAL ONE. The first guard was `se > 0`, and 0.1 is not
    // exactly representable in binary floating point — so forty IDENTICAL
    // trades have a standard deviation of 4.2e-17 rather than zero, the guard
    // passed, and the comparison reported 6e16 standard errors. It would have
    // printed a confident winner for a difference nobody measured. The guard is
    // now relative to the size of what is being measured, which is the only
    // form that survives a change of units.
    const flatA = Array.from({ length: 40 }, (_, i) => trade(0.5, i));
    const flatB = Array.from({ length: 40 }, (_, i) => trade(0.1, i));
    const got = compareRules("A", flatA, "B", flatB);
    expect(got.verdict).toBe("tie");
    expect(Number.isNaN(got.sigmas)).toBe(true);
    expect(got.why).toMatch(/no measurable spread/i);
  });
});

describe("a gap outside the noise is named, and bounded to this window", () => {
  /* A big separation: +0.9R against −0.9R, tight spread, plenty of trades. */
  const strong = () => compareRules("Good", noisy(80, 0.9, 0.2), "Bad", noisy(80, -0.9, 0.2));

  it("names the side that is ahead", () => {
    const got = strong();
    expect(got.verdict).toBe("a");
    expect(got.why).toMatch(/^Good is ahead/);
    expect(got.sigmas).toBeGreaterThan(SE_THRESHOLD);
  });

  it("works in the other direction too", () => {
    const got = compareRules("Bad", noisy(80, -0.9, 0.2), "Good", noisy(80, 0.9, 0.2));
    expect(got.verdict).toBe("b");
    expect(got.why).toMatch(/^Good is ahead/);
  });

  it("SAYS THE RESULT IS ABOUT THIS WINDOW", () => {
    // The comparison was made on the window being looked at, which is exactly
    // the caveat a side-by-side invites the reader to forget.
    expect(strong().why).toMatch(/ON THIS window/);
    expect(strong().why).toMatch(/not a claim that it holds on the next one/i);
  });

  it("the difference is A minus B, in that order", () => {
    const got = strong();
    expect(got.difference).toBeCloseTo(got.a.expectancyR - got.b.expectancyR);
    expect(got.difference).toBeGreaterThan(0);
  });

  it("reports each side's own figures untouched", () => {
    const got = strong();
    expect(got.a.trades).toBe(80);
    expect(got.b.trades).toBe(80);
    expect(got.a.expectancyR).toBeCloseTo(0.9);
    expect(got.b.expectancyR).toBeCloseTo(-0.9);
    expect(got.a.winRate).toBeCloseTo(1);
    expect(got.b.winRate).toBeCloseTo(0);
  });
});
