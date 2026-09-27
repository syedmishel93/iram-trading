/**
 * The detector scorecard.
 *
 * Named `scorecard-kinds` because `learn/scorecard.ts` already owns the other
 * one, and the two answer opposite questions: that one is the terminal's own
 * claims, out of sample; this one is a replay over the same bars the
 * candidates were found on. Confusing them would be the worst mistake a reader
 * of this desk could make, which is why the headline says which it is every
 * single time.
 *
 * The tests below are mostly about the ranking refusing to rank, and about
 * that headline.
 */

import { describe, expect, it } from "vitest";
import { headlineFor, scorecard, toRow } from "../src/setup/scorecard";
import { MIN_TRIALS, breakEven, type Simulation } from "../src/setup/simulate";
import { rowNote, rowTone, kindLabel } from "../src/ui/kindtable";

const sim = (over: Partial<Simulation> = {}): Simulation =>
  ({
    kind: "spring",
    direction: "long",
    trials: [],
    n: 40,
    wins: 24,
    losses: 16,
    expiries: 0,
    unknowable: 0,
    hitRate: 0.6,
    hitLow: 0.45,
    expectancy: 0.1,
    expectancyLow: -0.1,
    expectancyHigh: 0.3,
    medianBars: 6,
    enough: true,
    adverse: false,
    note: "",
    ...over,
  }) as Simulation;

describe("toRow", () => {
  it("computes edge as the lower bound against break-even", () => {
    /* Not the point estimate. A kind with four wins from six has a wonderful
       hit rate and no evidence; the interval is what says so. */
    const row = toRow(sim({ hitRate: 0.6, hitLow: 0.45 }), 1);
    expect(row.breakEven).toBeCloseTo(0.5);
    expect(row.edge).toBeCloseTo(-0.05);
  });

  it("reflects the reward-to-risk, so a tighter target needs a higher rate", () => {
    const atOne = toRow(sim({ hitLow: 0.45 }), 1);
    const atTwo = toRow(sim({ hitLow: 0.45 }), 2);
    /* 45% clears break-even at 2:1 (33%) and fails at 1:1 (50%). Same sample,
       different trade. */
    expect(atOne.edge).toBeLessThan(0);
    expect(atTwo.edge).toBeGreaterThan(0);
  });

  it("carries no edge when there is no lower bound to compare", () => {
    expect(toRow(sim({ n: 0, hitLow: null }), 1).edge).toBeNull();
  });
});

describe("scorecard", () => {
  it("drops kinds with no completed instance rather than showing zero rows", () => {
    /* "No record" and "a record of nothing" read identically in a table and
       mean opposite things. */
    const card = scorecard([sim(), sim({ kind: "gap", n: 0, wins: 0, hitLow: null })], 1, 5000);
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0]?.kind).toBe("spring");
  });

  it("never ranks a kind that is too thin to characterise", () => {
    /* The failure this exists to stop: an uncharacterisable kind can have the
       best-looking edge in the table, and including it would put it at the
       top — which is the entire mistake. */
    const thin = sim({ kind: "harmonic", n: 3, wins: 3, hitRate: 1, hitLow: 0.9, enough: false });
    const card = scorecard([sim(), thin], 1, 5000);
    expect(card.ranked.map((r) => r.kind)).not.toContain("harmonic");
    /* Still present in the table, though — see the note in kindtable.ts. */
    expect(card.rows.map((r) => r.kind)).toContain("harmonic");
  });

  it("ranks by edge, best first", () => {
    const good = sim({ kind: "retest", hitLow: 0.62 });
    const bad = sim({ kind: "engulfing", hitLow: 0.3 });
    const card = scorecard([bad, good], 1, 5000);
    expect(card.ranked[0]?.kind).toBe("retest");
    expect(card.clearing).toBe(1);
  });

  it("does not call a rounding error a clearance", () => {
    /**
     * The first live run: `choch long`, 87 trials, lower bound 50.03% against a
     * break-even of 50%. The table printed "+0pp" beside the words "clears on
     * the lower bound" — a verdict contradicting the number next to it.
     *
     * `MIN_EDGE` is borrowed from setup/recommend.ts, which had already made
     * exactly this argument for exactly this reason.
     */
    const hair = sim({ kind: "choch", n: 87, hitRate: 0.61, hitLow: 0.5003 });
    const card = scorecard([hair], 1, 5999);
    expect(card.clearing).toBe(0);
    expect(card.rows[0]?.edge).toBeGreaterThan(0);
    expect(card.rows[0]?.clears).toBe(false);
    /* Still ranked — it is measurable, it just does not clear. */
    expect(card.ranked).toHaveLength(1);
  });

  it("counts clearing kinds on the lower bound, not the hit rate", () => {
    /* 60% looks like it clears a 50% bar. Its lower bound is 45% and does not,
       and the lower bound is what the count uses. */
    const card = scorecard([sim({ hitRate: 0.6, hitLow: 0.45 })], 1, 5000);
    expect(card.measured).toBe(1);
    expect(card.clearing).toBe(0);
  });
});

describe("headlineFor", () => {
  it("says nothing was found when nothing was", () => {
    expect(headlineFor(0, 0, 0, 1, 5000, undefined)).toMatch(/nothing to replay/);
  });

  it("blames the sample, not the detectors, when nothing is characterisable", () => {
    /* A distinction worth the sentence: one says the market answered no, the
       other says nobody has asked yet. */
    const text = headlineFor(9, 0, 0, 1, 800, undefined);
    expect(text).toContain(String(MIN_TRIALS));
    expect(text).toMatch(/about the sample, not about the kinds/);
  });

  it("does not soften the expected result", () => {
    const text = headlineFor(12, 10, 0, 1, 6000, undefined);
    expect(text).toMatch(/None of them clears break-even/);
    expect(text).toMatch(/what you should expect/);
  });

  it("states the in-sample caveat whenever it reports a winner", () => {
    /* The caveat rides with the good news, not only with the bad. */
    const best = toRow(sim({ kind: "retest", hitLow: 0.66 }), 1);
    const text = headlineFor(12, 10, 1, 1, 6000, best);
    expect(text).toMatch(/same bars/);
    expect(text).toMatch(/prior/);
    expect(text).toContain("retest");
  });

  it("always names the break-even it is judging against", () => {
    for (const r of [1, 1.5, 2, 3]) {
      const text = headlineFor(12, 10, 0, r, 6000, undefined);
      expect(text).toContain(`${Math.round(breakEven(r) * 100)}%`);
    }
  });
});

describe("row presentation", () => {
  it("distinguishes not-enough from does-not-clear", () => {
    /* Four states, not three. Collapsing these two would report "no edge" for
       a kind nobody has measured. */
    expect(rowTone(toRow(sim({ n: 4, enough: false }), 1))).toBe("thin");
    expect(rowTone(toRow(sim({ hitLow: 0.4 }), 1))).toBe("flat");
    /* A hair over break-even reads flat, not green. */
    expect(rowTone(toRow(sim({ hitLow: 0.5003 }), 1))).toBe("flat");
    expect(rowTone(toRow(sim({ hitLow: 0.62 }), 1))).toBe("clears");
    expect(rowTone(toRow(sim({ hitLow: 0.62, adverse: true }), 1))).toBe("adverse");
  });

  it("puts adverse ahead of clears, because it is the stronger warning", () => {
    /* `adverse` means the whole 90% expectancy interval sits below zero. A
       kind that manages that while its hit-rate bound looks fine is exactly
       the row a reader must not see marked green. */
    const row = toRow(sim({ hitLow: 0.9, adverse: true }), 1);
    expect(rowTone(row)).toBe("adverse");
    expect(rowNote(row)).toMatch(/against it/);
  });

  it("tells a thin row how far it has to go", () => {
    expect(rowNote(toRow(sim({ n: 5, enough: false }), 1))).toBe(`5 of ${MIN_TRIALS} needed`);
  });

  it("reads kind ids as words", () => {
    expect(kindLabel("liquidity-sweep")).toBe("liquidity sweep");
    expect(kindLabel("bos")).toBe("bos");
  });
});
