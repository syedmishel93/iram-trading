/**
 * Thresholds chosen by rank.
 *
 * The property under test is not "this detector finds N things" — that is a
 * fixture fact. It is that the SAME series, rescaled so its bars are an order
 * of magnitude larger relative to price, yields the same answer. That is what
 * a timeframe change does, and it is what every magnitude threshold in this
 * codebase has failed at least once.
 */

import { describe, expect, it } from "vitest";
import { bodyShares, gapShares, nthLargest, quantile } from "../src/detect/calibrate";
import { SWING_TARGET_PER_BARS, findPivots, noiseShare, swingFloor } from "../src/detect/pivots";
import { detectDoubles, detectHeadShoulders, detectTrendlines } from "../src/detect/formations";
import { detectFVG, detectOrderBlocks } from "../src/detect/zones";
import type { DetectInput } from "../src/detect/types";

/**
 * A price series with impulses and consolidations, at a chosen volatility.
 *
 * `step` is the per-bar move as a share of price, which is exactly the quantity
 * that changes when you switch timeframe. Deterministic — a seeded LCG, not
 * Math.random, so a failure is reproducible.
 */
function walk(n: number, step: number, seed = 7): DetectInput {
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const t = new Float64Array(n);
  let s = seed;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  let price = 1000;
  for (let i = 0; i < n; i++) {
    // Alternating drift regimes so the series has legs to find pivots in.
    const drift = (Math.sin(i / 13) + Math.sin(i / 5.7)) * step * 0.5;
    const open = price;
    price = price * (1 + drift + rnd() * step);
    const hi = Math.max(open, price) * (1 + Math.abs(rnd()) * step * 0.4);
    const lo = Math.min(open, price) * (1 - Math.abs(rnd()) * step * 0.4);
    o[i] = open;
    c[i] = price;
    h[i] = hi;
    l[i] = lo;
    v[i] = 1000 + Math.abs(rnd()) * 500;
    t[i] = i * 60_000;
  }
  return { o, h, l, c, v, t };
}

describe("quantile", () => {
  it("interpolates between samples", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it("does not reorder the caller's array", () => {
    const xs = [3, 1, 2];
    quantile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("survives an empty sample rather than returning NaN", () => {
    /* A threshold of NaN compares false against everything, so a detector fed
       one silently accepts every candidate. Zero at least fails loudly in the
       count. */
    expect(quantile([], 0.5)).toBe(0);
    expect(nthLargest([], 5)).toBe(0);
  });
});

describe("nthLargest", () => {
  it("counts down from the largest, one-based", () => {
    expect(nthLargest([5, 1, 4, 2, 3], 1)).toBe(5);
    expect(nthLargest([5, 1, 4, 2, 3], 3)).toBe(3);
  });

  it("returns zero when the rank cannot be filled, keeping every sample", () => {
    expect(nthLargest([5, 1], 9)).toBe(0);
  });
});

describe("gapShares", () => {
  it("counts only bars that actually left a gap", () => {
    /* Counting the overlapping bars as zeroes would drag every quantile toward
       zero in proportion to how ORDERLY the series is, which is backwards. */
    const n = 40;
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      h[i] = 105;
      l[i] = 95;
      c[i] = 100;
    }
    expect(gapShares(h, l, c, n)).toEqual([]);
    l[10] = 110;
    h[10] = 120;
    c[10] = 115;
    /* Two, not one: bar 10 gaps up away from bar 8, and bar 12 gaps down away
       from bar 10. A three-bar gap is a property of a WINDOW, so one displaced
       bar puts two windows out of overlap. */
    expect(gapShares(h, l, c, n).length).toBe(2);
  });

  it("skips bars with no usable price", () => {
    const n = 10;
    const z = new Float64Array(n);
    expect(gapShares(z, z, z, n)).toEqual([]);
    expect(bodyShares(z, z, n)).toEqual([]);
  });
});

describe("a swing floor that survives a change of timeframe", () => {
  const QUIET = walk(800, 0.0004);
  const LOUD = walk(800, 0.02);

  it("the two fixtures really are an order of magnitude apart", () => {
    const q = noiseShare(QUIET.h, QUIET.l, QUIET.c);
    const w = noiseShare(LOUD.h, LOUD.l, LOUD.c);
    expect(w / q).toBeGreaterThan(20);
  });

  it("delivers the same pivot supply to both", () => {
    /* THE REGRESSION. A fixed multiple of the mean bar range gave XAUUSD 55
       confirmed pivots on the minute and 7 on the hour — same instrument, same
       day. Seven alternating pivots cannot form a head and shoulders, so four
       detectors returned an empty array and were reported as broken. */
    const count = (d: DetectInput): number =>
      findPivots(
        d.h,
        d.l,
        { left: 4, right: 4, minProminence: swingFloor(d.h, d.l, d.c, d.c.length, { left: 4, right: 4 }) },
        d.c.length,
      ).length;
    const target = 800 / SWING_TARGET_PER_BARS;
    const quiet = count(QUIET);
    const loud = count(LOUD);
    /* The band is wide on purpose. The claim is that the supply does not
       COLLAPSE when volatility changes — the old failure was 55 to 7 — not
       that a synthetic series hits a target exactly. */
    for (const n of [quiet, loud]) {
      expect(n).toBeGreaterThan(target * 0.5);
      expect(n).toBeLessThan(target * 1.5);
    }
    expect(Math.max(quiet, loud) / Math.min(quiet, loud)).toBeLessThan(1.5);
  });

  it("keeps every pivot-based detector alive at both volatilities", () => {
    /* Not an assertion about how many patterns exist in a synthetic series —
       only that none of these returns the empty array that got them reported
       as broken. */
    for (const d of [QUIET, LOUD]) {
      expect(detectHeadShoulders(d).length).toBeGreaterThan(0);
      expect(detectDoubles(d).length).toBeGreaterThan(0);
      expect(detectTrendlines(d).length).toBeGreaterThan(0);
    }
  });

  it("keeps the zone detectors alive at both volatilities", () => {
    /* `displacement: 0.012` asked for a body above the 99th percentile of the
       hourly distribution, so order blocks were zero — and breaker blocks with
       them, since they are built on order blocks. */
    for (const d of [QUIET, LOUD]) {
      expect(detectOrderBlocks(d, { maxZones: 50 }).length).toBeGreaterThan(0);
      expect(detectFVG(d, { maxZones: 50 }).length).toBeGreaterThan(0);
    }
  });

  it("still refuses a series with nothing in it", () => {
    /* The rank says where the cut falls. The noise floor decides whether
       anything is worth cutting — without it, a halted market hands its
       largest tick to every detector as structure. */
    const n = 300;
    const flat = new Float64Array(n).fill(100);
    expect(swingFloor(flat, flat, flat, n)).toBe(0);
    expect(
      findPivots(flat, flat, { left: 4, right: 4, minProminence: swingFloor(flat, flat, flat, n) }, n),
    ).toEqual([]);
  });
});
