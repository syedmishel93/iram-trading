/**
 * THE CHART ARITHMETIC — because a wrong scale looks exactly like the truth.
 *
 * A wrong number in a table is something a reader catches. A wrong SCALE in a
 * chart is plausible, unlabelled and not red. CLAUDE.md records the same
 * lesson about the coverage ribbon, so the same answer applies: the arithmetic
 * is a pure function and its traps are pinned here.
 *
 * WHAT THESE PIN
 *
 *  1. ONE DOMAIN FOR EVERY SERIES. Overlaying twenty-five equity curves is
 *     only honest if they share axes. Scaled to its own range, a rule that
 *     made $5 draws the same line as one that made $400, and the chart whose
 *     whole purpose is "is the winner separated from the field" says yes every
 *     time.
 *  2. A FLAT AXIS IS PADDED, NEVER DIVIDED BY. NaN in a path is dropped
 *     silently by the browser and draws as nothing, which reads as broken
 *     rather than as flat.
 *  3. A DRAWDOWN IS NEVER POSITIVE. One that can go above zero has computed
 *     its running peak wrong, and the chart would show an account making money
 *     during a fall.
 *  4. Y IS FLIPPED EXACTLY ONCE. SVG counts downward and equity goes up.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_DOMAIN,
  longestRun,
  pathFor,
  sharedDomain,
  underwater,
  xFraction,
  yFraction,
  type Point,
} from "../src/ui/cards/plot";

const line = (ys: number[]): Point[] => ys.map((y, x) => ({ x, y }));

describe("one domain for every series", () => {
  it("spans the widest extent of all of them, not each one's own", () => {
    const small = line([500, 502, 505]);
    const big = line([500, 700, 900]);
    const d = sharedDomain([small, big]);
    expect(d.ok).toBe(true);
    expect(d.y0).toBe(500);
    expect(d.y1).toBe(900);

    // THE POINT OF THE WHOLE THING: in a shared domain the small curve stays
    // small. Scaled to itself it would reach the top of the box and claim the
    // same result as the one that nearly doubled.
    const h = 100;
    const smallTop = Math.min(...small.map((p) => h - yFraction(p.y, d) * h));
    const bigTop = Math.min(...big.map((p) => h - yFraction(p.y, d) * h));
    expect(smallTop).toBeGreaterThan(bigTop + 50);
  });

  it("ignores non-finite points rather than poisoning the whole box", () => {
    const d = sharedDomain([[{ x: 0, y: 1 }, { x: 1, y: NaN }, { x: 2, y: 3 }]]);
    expect(d.ok).toBe(true);
    expect(d.y0).toBe(1);
    expect(d.y1).toBe(3);
  });

  it("refuses when there is nothing measurable in any series", () => {
    expect(sharedDomain([])).toEqual(EMPTY_DOMAIN);
    expect(sharedDomain([[]])).toEqual(EMPTY_DOMAIN);
    expect(sharedDomain([[{ x: NaN, y: NaN }]])).toEqual(EMPTY_DOMAIN);
    expect(sharedDomain([]).ok).toBe(false);
  });

  it("pads a flat axis instead of dividing by zero", () => {
    const flat = sharedDomain([line([500, 500, 500])]);
    expect(flat.y1).toBeGreaterThan(flat.y0);
    // And the resulting path is real, not a string of NaN.
    const d = pathFor(line([500, 500, 500]), flat, 100, 30);
    expect(d).not.toContain("NaN");
    expect(d.length).toBeGreaterThan(0);
  });

  it("pads a single-point x axis too", () => {
    const one = sharedDomain([[{ x: 7, y: 1 }, { x: 7, y: 2 }]]);
    expect(one.x1).toBeGreaterThan(one.x0);
  });
});

describe("the path", () => {
  it("flips y exactly once: a rising series goes UP the screen", () => {
    const pts = line([0, 10]);
    const d = sharedDomain([pts]);
    const path = pathFor(pts, d, 100, 30);
    // "M0.00,30.00L100.00,0.00" — first point at the bottom, last at the top.
    const ys = [...path.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[0]).toBeGreaterThan(ys[ys.length - 1] as number);
    expect(ys[0]).toBeCloseTo(30, 6);
    expect(ys[ys.length - 1]).toBeCloseTo(0, 6);
  });

  it("returns an empty string rather than a one-point path", () => {
    const d = sharedDomain([line([1, 2])]);
    expect(pathFor([{ x: 0, y: 1 }], d, 100, 30)).toBe("");
    expect(pathFor([], d, 100, 30)).toBe("");
  });

  it("draws nothing against a refused domain", () => {
    expect(pathFor(line([1, 2, 3]), EMPTY_DOMAIN, 100, 30)).toBe("");
  });

  it("never emits NaN, whatever is in the series", () => {
    const pts: Point[] = [{ x: 0, y: 1 }, { x: 1, y: NaN }, { x: 2, y: 3 }];
    const d = sharedDomain([pts]);
    const path = pathFor(pts, d, 100, 30);
    expect(path).not.toContain("NaN");
    expect(path).not.toContain("Infinity");
  });

  it("places fractions at the ends of the box", () => {
    const d = sharedDomain([line([10, 20])]);
    expect(yFraction(10, d)).toBeCloseTo(0, 9);
    expect(yFraction(20, d)).toBeCloseTo(1, 9);
    expect(xFraction(0, d)).toBeCloseTo(0, 9);
    expect(xFraction(1, d)).toBeCloseTo(1, 9);
    expect(yFraction(5, EMPTY_DOMAIN)).toBe(0);
  });
});

describe("under water", () => {
  it("is never positive, and the running peak only rises", () => {
    const uw = underwater(line([100, 120, 90, 110, 130, 125]));
    for (const p of uw) expect(p.y).toBeLessThanOrEqual(0);
    // Peaks: 100,120,120,120,130,130 -> drawdowns 0, 0, -.25, -1/12, 0, -5/130
    expect(uw[0]?.y).toBeCloseTo(0, 9);
    expect(uw[1]?.y).toBeCloseTo(0, 9);
    expect(uw[2]?.y).toBeCloseTo(-0.25, 9);
    expect(uw[3]?.y).toBeCloseTo(-10 / 120, 9);
    expect(uw[4]?.y).toBeCloseTo(0, 9);
    expect(uw[5]?.y).toBeCloseTo(-5 / 130, 9);
  });

  it("is a fraction, so two account sizes give the same picture", () => {
    const small = underwater(line([100, 80, 100]));
    const large = underwater(line([100000, 80000, 100000]));
    expect(large.map((p) => p.y)).toEqual(small.map((p) => p.y));
  });

  it("does not divide by a peak of zero", () => {
    const uw = underwater(line([0, 0, 0]));
    for (const p of uw) expect(Number.isFinite(p.y)).toBe(true);
  });

  it("drops non-finite points rather than carrying them into the peak", () => {
    const uw = underwater([{ x: 0, y: 100 }, { x: 1, y: NaN }, { x: 2, y: 50 }]);
    expect(uw).toHaveLength(2);
    expect(uw[1]?.y).toBeCloseTo(-0.5, 9);
  });
});

describe("the longest run under water", () => {
  it("counts the longest stretch, not the total", () => {
    // Two spells of 2 and one of 3.
    const pts = line([0, -1, -1, 0, -1, -1, -1, 0, -1]);
    expect(longestRun(pts, -0.0001)).toBe(3);
  });

  it("is zero when the curve never goes under", () => {
    expect(longestRun(line([0, 0, 0]), -0.0001)).toBe(0);
  });

  it("counts a run that reaches the end of the series", () => {
    expect(longestRun(line([0, -1, -1, -1]), -0.0001)).toBe(3);
  });
});
