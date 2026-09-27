/**
 * The pure parts of the small-chart kit: the scale, the extent, and the three
 * lookups that turn a pointer position into a value. Every expectation is a
 * literal worked by hand, never a value read back from the code under test.
 */
import { describe, expect, it } from "vitest";
import { binIndex, extent, histogram, indexAtX, linear, nearestPoint } from "../src/ui/minichart";

describe("linear", () => {
  it("maps the domain ends to the range ends and interpolates between", () => {
    const s = linear(0, 10, 100, 200);
    expect(s(0)).toBe(100);
    expect(s(10)).toBe(200);
    expect(s(2.5)).toBe(125);
  });
  it("inverts when the range is reversed (y grows downwards)", () => {
    const y = linear(1, 2, 90, 10);
    expect(y(1)).toBe(90);
    expect(y(2)).toBe(10);
    expect(y(1.5)).toBe(50);
  });
  it("maps a zero-width domain to the middle of the range instead of dividing by zero", () => {
    const s = linear(5, 5, 0, 40);
    expect(s(5)).toBe(20);
    expect(s(99)).toBe(20);
  });
});

describe("extent", () => {
  it("skips non-finite values", () => {
    expect(extent([1.2, Number.NaN, 0.8, Infinity, 1.5])).toEqual({ lo: 0.8, hi: 1.5 });
  });
  it("widens a flat series around the anchor", () => {
    const e = extent([1, 1, 1], 1);
    expect(e.lo).toBeCloseTo(0.99, 12);
    expect(e.hi).toBeCloseTo(1.01, 12);
  });
  it("includes the anchor when widening a flat series that does not contain it", () => {
    const e = extent([2, 2], 1);
    expect(e.lo).toBeCloseTo(0.99, 12);
    expect(e.hi).toBeCloseTo(2.01, 12);
  });
  it("returns anchor ± widen for an empty series", () => {
    expect(extent([], 0, 0.5)).toEqual({ lo: -0.5, hi: 0.5 });
  });
});

describe("indexAtX", () => {
  // 5 samples from x=0 to x=100: at 0, 25, 50, 75, 100.
  it("finds the nearest evenly spaced sample", () => {
    expect(indexAtX(0, 5, 0, 100)).toBe(0);
    expect(indexAtX(12, 5, 0, 100)).toBe(0);
    expect(indexAtX(13, 5, 0, 100)).toBe(1);
    expect(indexAtX(60, 5, 0, 100)).toBe(2);
    expect(indexAtX(100, 5, 0, 100)).toBe(4);
  });
  it("clamps outside the plot", () => {
    expect(indexAtX(-40, 5, 0, 100)).toBe(0);
    expect(indexAtX(180, 5, 0, 100)).toBe(4);
  });
  it("respects a padded plot origin", () => {
    // 3 samples from x=10 to x=30: at 10, 20, 30.
    expect(indexAtX(24, 3, 10, 30)).toBe(1);
    expect(indexAtX(26, 3, 10, 30)).toBe(2);
  });
  it("answers -1 for no samples and 0 for one", () => {
    expect(indexAtX(50, 0, 0, 100)).toBe(-1);
    expect(indexAtX(50, 1, 0, 100)).toBe(0);
  });
});

describe("binIndex / histogram", () => {
  it("files a value into equal bins over [0, top)", () => {
    // top 0.30 in 30 bins: each bin is 1 percentage point wide.
    expect(binIndex(0, 0.3, 30)).toBe(0);
    expect(binIndex(0.0149, 0.3, 30)).toBe(1);
    expect(binIndex(0.155, 0.3, 30)).toBe(15);
  });
  it("clamps the top edge and beyond into the last bin, negatives into the first", () => {
    expect(binIndex(0.3, 0.3, 30)).toBe(29);
    expect(binIndex(0.9, 0.3, 30)).toBe(29);
    expect(binIndex(-0.1, 0.3, 30)).toBe(0);
  });
  it("counts per bin", () => {
    // top 1, 4 bins: [0,.25) [.25,.5) [.5,.75) [.75,1]
    expect(histogram([0.1, 0.2, 0.3, 0.8, 0.99, 1], 1, 4)).toEqual([2, 1, 0, 3]);
  });
});

describe("nearestPoint", () => {
  const pts = [
    { x: 10, y: 10 },
    { x: 50, y: 50 },
    { x: 53, y: 54 },
  ];
  it("picks the closest point within reach", () => {
    // (52, 52): to (50,50) is sqrt 8, to (53,54) is sqrt 5.
    expect(nearestPoint(pts, 52, 52, 12)).toBe(2);
    expect(nearestPoint(pts, 12, 9, 12)).toBe(0);
  });
  it("answers -1 when nothing is within reach", () => {
    expect(nearestPoint(pts, 30, 30, 12)).toBe(-1);
  });
  it("counts a point exactly at the reach as inside", () => {
    // (10,10) to (10,22) is exactly 12.
    expect(nearestPoint(pts, 10, 22, 12)).toBe(0);
  });
  it("gives a tie to the earlier point", () => {
    const twin = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(nearestPoint(twin, 5, 0, 12)).toBe(0);
  });
});
