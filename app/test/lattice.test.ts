/**
 * The probability lattice.
 *
 * The property that decides whether this is an instrument or a screensaver:
 * **the histogram must be the run's histogram.** A bean machine that samples
 * from a fitted curve will always look like the curve it was given, so the tests
 * below check that every ball is a real trade, that the bins add up to the trade
 * count, and that nothing is smoothed or invented along the way.
 */

import { describe, expect, it } from "vitest";
import {
  binOf,
  BIN_EDGES,
  buildLattice,
  EMPTY_LATTICE,
  latticeNote,
  pathFor,
} from "../src/backtest/lattice";
import { rng } from "../src/backtest/resample";
import type { Trade } from "../src/backtest/engine";

const trade = (rMultiple: number): Trade => ({
  direction: "long",
  entryIndex: 0,
  entryTime: 0,
  entryPrice: 100,
  exitIndex: 1,
  exitTime: 1,
  exitPrice: 100,
  exitReason: rMultiple <= -0.95 ? "stop" : "target",
  rMultiple,
  returnPct: rMultiple * 0.01,
  reason: "test",
  maeR: 0,
  mfeR: 0,
});

const run = (rs: number[]): Trade[] => rs.map(trade);

describe("binOf", () => {
  it("gives the stop its own bin", () => {
    // "The stop was hit" is one outcome, not a bucket, and usually the single
    // most common thing on the board.
    expect(binOf(-1)).toBe(binOf(-1.0));
    expect(binOf(-1)).not.toBe(binOf(-0.9));
    expect(binOf(-1)).not.toBe(binOf(-1.2));
  });

  it("puts every finite R somewhere", () => {
    for (const r of [-99, -3, -1.5, -1, -0.4, 0, 0.2, 1, 2.5, 9, 400]) {
      const b = binOf(r);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BIN_EDGES.length - 1);
    }
  });

  it("is monotone — a bigger R never lands further left", () => {
    let last = -1;
    for (let r = -5; r <= 5; r += 0.05) {
      const b = binOf(r);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
  });

  it("splits winners from losers at exactly zero", () => {
    const l = buildLattice(run([-0.01, 0, 0.01]));
    expect(l.bins[binOf(-0.01)]?.winning).toBe(false);
    expect(l.bins[binOf(0)]?.winning).toBe(true);
  });
});

describe("buildLattice", () => {
  it("has nothing to say about no trades", () => {
    expect(buildLattice([])).toEqual(EMPTY_LATTICE);
  });

  /** THE ONE THAT MATTERS. */
  it("bins add up to the trade count — nothing invented, nothing dropped", () => {
    const rs = [-1, -1, -1, -0.4, 0.6, 2, 2, 3.5, -1, 1.2];
    const l = buildLattice(run(rs));
    expect(l.bins.reduce((a, b) => a + b.count, 0)).toBe(rs.length);
    expect(l.trades).toBe(rs.length);
    expect(l.order).toHaveLength(rs.length);
    expect(l.lands).toHaveLength(rs.length);
  });

  it("drops the run's own outcomes, not a sample from a curve", () => {
    const rs = [-1, 2.5, -1, 0.3];
    const l = buildLattice(run(rs));
    // Same multiset, whatever the order.
    expect([...l.order].sort((a, b) => a - b)).toEqual([...rs].sort((a, b) => a - b));
  });

  it("lands every ball in the bin its own R belongs to", () => {
    const l = buildLattice(run([-2, -1, 0.5, 4]));
    l.order.forEach((r, i) => expect(l.lands[i]).toBe(binOf(r)));
  });

  it("shuffles the drop order so the board does not fill as a time series", () => {
    const rs = Array.from({ length: 60 }, (_, i) => i / 10 - 3);
    const l = buildLattice(run(rs));
    expect(l.order).not.toEqual(rs);
  });

  it("is reproducible — the same run animates the same way twice", () => {
    const rs = [-1, 2, -1, 0.5, 3, -0.2];
    expect(buildLattice(run(rs)).order).toEqual(buildLattice(run(rs)).order);
  });

  it("reports expectancy as the plain mean of R", () => {
    const l = buildLattice(run([-1, -1, 4]));
    expect(l.expectancyR).toBeCloseTo(2 / 3, 10);
  });

  it("counts wins by money made, not by bin", () => {
    // `returnPct > 0` is the engine's definition; a 0R trade made nothing.
    const l = buildLattice(run([-1, 0, 1]));
    expect(l.wins).toBe(1);
  });

  it("reports the tallest bin so a renderer needs no second pass", () => {
    const l = buildLattice(run([-1, -1, -1, 2]));
    expect(l.peak).toBe(3);
  });

  it("survives a non-finite R rather than corrupting the axis", () => {
    // A zero-width stop can produce one; `engine.ts` reports 0 R for it, but a
    // lattice that trusted the number would blow the bin search.
    const l = buildLattice([trade(Number.NaN), trade(1)]);
    expect(l.bins.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(Number.isFinite(l.expectancyR)).toBe(true);
  });
});

describe("pathFor", () => {
  const next = rng(7);

  it("always arrives in the bin it was given", () => {
    for (let bin = 0; bin < BIN_EDGES.length - 1; bin++) {
      const path = pathFor(bin, 12, BIN_EDGES.length - 1, next);
      expect(path[path.length - 1], `bin ${bin}`).toBe(bin);
    }
  });

  it("starts at the top centre", () => {
    const bins = BIN_EDGES.length - 1;
    expect(pathFor(0, 12, bins, next)[0]).toBeCloseTo((bins - 1) / 2, 10);
  });

  it("gives one position per row, plus the start", () => {
    expect(pathFor(3, 10, BIN_EDGES.length - 1, next)).toHaveLength(11);
  });

  it("never leaves the board", () => {
    const bins = BIN_EDGES.length - 1;
    for (let bin = 0; bin < bins; bin++) {
      for (const x of pathFor(bin, 14, bins, next)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(bins - 1);
      }
    }
  });

  it("takes different routes to the same bin", () => {
    // Otherwise every ball headed for the stop falls down an identical line.
    const a = pathFor(2, 14, BIN_EDGES.length - 1, rng(1)).join(",");
    const b = pathFor(2, 14, BIN_EDGES.length - 1, rng(2)).join(",");
    expect(a).not.toBe(b);
  });
});

describe("latticeNote", () => {
  it("refuses to read a board with too few balls", () => {
    expect(latticeNote(buildLattice(run([1, -1, 2])))).toMatch(/too few/i);
  });

  it("says which way the board leans, and that it still loses", () => {
    const rs = [...Array(60).fill(-1), ...Array(40).fill(2)];
    const note = latticeNote(buildLattice(run(rs)));
    expect(note).toMatch(/tilted right/i);
    expect(note).toMatch(/60% of balls still land on the losing side/);
    expect(note).toMatch(/not winning, just leaning/);
  });

  it("names a losing edge as leaning LEFT rather than softening it", () => {
    const rs = [...Array(80).fill(-1), ...Array(20).fill(1)];
    expect(latticeNote(buildLattice(run(rs)))).toMatch(/tilted LEFT/);
  });

  it("has nothing to say about an empty board", () => {
    expect(latticeNote(EMPTY_LATTICE)).toMatch(/nothing to drop/i);
  });
});
