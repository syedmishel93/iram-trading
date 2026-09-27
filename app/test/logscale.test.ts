/**
 * The logarithmic price axis.
 *
 * WHY THE TICKS GET AS MUCH ATTENTION AS THE MAPPING
 * The mapping is four lines and either works or is obviously broken. The ticks
 * are where this actually failed: the first version generated only 1/2/5 times
 * powers of ten, which for a Bitcoin window of 65,000-80,000 is the empty set —
 * a log chart that rendered perfectly with a completely blank price axis. It
 * looked like a rendering fault rather than a tick-selection one, which is
 * exactly why it belongs in a test rather than in someone's memory.
 */

import { describe, expect, it } from "vitest";
import { Viewport, priceTicksFor } from "../src/chart/viewport";

/** A viewport sized like a real chart, with a price window set by hand. */
function vp(min: number, max: number, scale: "linear" | "log" = "linear"): Viewport {
  const v = new Viewport();
  v.resize(1000, 600, 1);
  v.scale = scale;
  v.autoScale = false;
  v.priceMin = min;
  v.priceMax = max;
  return v;
}

describe("the log mapping", () => {
  it("gives equal height to equal percentage moves", () => {
    const v = vp(100, 10_000, "log");
    // Two doublings. On a log axis they must occupy the same number of pixels;
    // on a linear one the second would be sixteen times taller.
    const first = v.yOf(100) - v.yOf(200);
    const second = v.yOf(1000) - v.yOf(2000);
    expect(first).toBeCloseTo(second, 6);
  });

  it("gives equal height to equal dollar moves when linear", () => {
    const v = vp(100, 10_000, "linear");
    expect(v.yOf(100) - v.yOf(200)).toBeCloseTo(v.yOf(9000) - v.yOf(9100), 6);
  });

  it("round-trips price through pixels and back", () => {
    const v = vp(65_000, 80_000, "log");
    for (const p of [65_000, 70_000, 78_432.19, 80_000]) {
      expect(v.priceAtY(v.yOf(p))).toBeCloseTo(p, 4);
    }
  });

  it("puts the window edges at the plot edges", () => {
    const v = vp(1, 1000, "log");
    expect(v.yOf(1000)).toBeCloseTo(v.plotTop, 6);
    expect(v.yOf(1)).toBeCloseTo(v.plotTop + v.plotHeight, 6);
  });

  it("falls back to linear rather than NaN when the window reaches zero", () => {
    // Reachable by panning the axis down. log(0) is -Infinity and would take
    // every y on the chart with it.
    const v = vp(0, 100, "log");
    expect(Number.isFinite(v.yOf(50))).toBe(true);
    expect(Number.isFinite(v.yOf(0))).toBe(true);
  });
});

describe("zoom and pan stay anchored on a log axis", () => {
  it("keeps the price under the cursor fixed while zooming", () => {
    const v = vp(100, 10_000, "log");
    const y = 200;
    const before = v.priceAtY(y);
    v.scalePriceAt(y, 1.5);
    // The whole contract of zoom-at-cursor. Scaling the price window directly
    // instead of the log window slides the axis out from under the pointer.
    expect(v.priceAtY(y)).toBeCloseTo(before, 4);
  });

  it("moves the window by the dragged distance, not by a price amount", () => {
    const v = vp(100, 10_000, "log");
    const priceAtMiddle = v.priceAtY(v.plotTop + v.plotHeight / 2);
    v.shiftPrice(60);
    // Dragging down 60px must bring what was 60px above into the middle.
    const after = v.priceAtY(v.plotTop + v.plotHeight / 2);
    expect(after).toBeGreaterThan(priceAtMiddle);
    expect(v.priceMin).toBeGreaterThan(0);
  });

  it("keeps the window positive under repeated panning", () => {
    const v = vp(100, 10_000, "log");
    for (let i = 0; i < 50; i++) v.shiftPrice(-40);
    // exp() of anything is positive, so a log axis cannot be panned through
    // zero the way a linear one can.
    expect(v.priceMin).toBeGreaterThan(0);
    expect(Number.isFinite(v.yOf(v.priceMin))).toBe(true);
  });
});

describe("fitPrice pads in the space the axis is linear in", () => {
  it("leaves symmetric headroom on a log axis", () => {
    const v = new Viewport();
    v.resize(1000, 600, 1);
    v.scale = "log";
    v.autoScale = true;
    v.priceMin = 1;
    v.priceMax = 2;
    // Padded in price units, the gap under the low would be far larger than the
    // gap over the high, because the same number of dollars is a different
    // distance at each end of a log axis.
    const min = 1000;
    const max = 100_000;
    const series = {
      length: 2,
      extent: () => ({ min, max }),
    } as unknown as Parameters<Viewport["fitPrice"]>[0];
    v.fitPrice(series, 0.1);
    const lowPad = Math.log(min) - Math.log(v.priceMin);
    const highPad = Math.log(v.priceMax) - Math.log(max);
    expect(lowPad).toBeCloseTo(highPad, 6);
  });
});

describe("axis ticks", () => {
  const ticks = (min: number, max: number, scale: "linear" | "log") =>
    priceTicksFor(vp(min, max, scale));

  it("never leaves a log axis blank", () => {
    // THE REGRESSION. 65,000-80,000 contains no 1/2/5 times a power of ten, and
    // the first version therefore drew no labels at all.
    const t = ticks(65_000, 80_000, "log");
    expect(t.length).toBeGreaterThan(2);
    for (const v of t) {
      expect(v).toBeGreaterThanOrEqual(65_000);
      expect(v).toBeLessThanOrEqual(80_000);
    }
  });

  it("labels the low end of a window spanning decades", () => {
    // The failure the decade multiples exist to prevent: linear steps across
    // 1,000-100,000 all land in the top decade and the bottom half is bare.
    const t = ticks(1_000, 100_000, "log");
    expect(t.some((v) => v < 10_000)).toBe(true);
    expect(t.some((v) => v > 50_000)).toBe(true);
  });

  it("keeps every label at least a readable distance apart", () => {
    const v = vp(1_000, 100_000, "log");
    const ys = priceTicksFor(v).map((p) => v.yOf(p));
    for (let i = 1; i < ys.length; i++) {
      expect(Math.abs((ys[i - 1] as number) - (ys[i] as number))).toBeGreaterThanOrEqual(43);
    }
  });

  it("returns round numbers, not whatever divides the range", () => {
    // 41,283.6 is a correct tick and an unreadable one.
    for (const v of ticks(65_000, 80_000, "log")) {
      expect(Number.isInteger(v / 100)).toBe(true);
    }
  });

  it("is ascending, on both scales", () => {
    for (const scale of ["linear", "log"] as const) {
      const t = ticks(100, 10_000, scale);
      expect(t).toEqual([...t].sort((a, b) => a - b));
    }
  });

  it("still produces a linear axis unchanged", () => {
    const t = ticks(78_000, 80_000, "linear");
    expect(t.length).toBeGreaterThan(2);
    const gaps = t.slice(1).map((v, i) => v - (t[i] as number));
    // Linear ticks are evenly spaced in PRICE; log ones are not.
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0] as number, 6);
  });

  it("returns nothing for a degenerate window rather than looping forever", () => {
    expect(priceTicksFor(vp(100, 100, "log"))).toEqual([]);
    expect(priceTicksFor(vp(100, 100, "linear"))).toEqual([]);
  });
});
