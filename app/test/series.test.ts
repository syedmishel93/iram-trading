import { describe, it, expect } from "vitest";
import { Series } from "../src/chart/series";

const H = 3_600_000;

function build(n: number, startT = 1_700_000_000_000): Series {
  const s = new Series(8); // start below n so growth is exercised
  for (let i = 0; i < n; i++) {
    const base = 100 + i;
    s.push(startT + i * H, base, base + 2, base - 2, base + 1, 10 + i);
  }
  return s;
}

describe("Series storage", () => {
  it("appends and grows capacity without losing data", () => {
    const s = build(100);
    expect(s.length).toBe(100);
    expect(s.capacity).toBeGreaterThanOrEqual(100);
    expect(s.at(0)?.o).toBe(100);
    expect(s.at(99)?.o).toBe(199);
  });

  it("UPDATES the last bar in place when the timestamp repeats", () => {
    // The forming-bar invariant. A live feed republishes the current bar many
    // times a second; if that appended, the series would grow without bound and
    // the chart would show hundreds of duplicate candles at the right edge.
    const s = build(10);
    const t = s.t[9] as number;
    const lenBefore = s.length;

    s.push(t, 1, 2, 0.5, 1.5, 999);

    expect(s.length).toBe(lenBefore);
    expect(s.at(9)).toEqual({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 999 });
  });

  it("rejects out-of-order bars rather than interleaving them", () => {
    const s = build(10);
    const before = s.length;
    s.push((s.t[9] as number) - H, 1, 1, 1, 1, 1);
    expect(s.length).toBe(before);
  });

  it("bumps revision on every mutation so renderers can cache", () => {
    const s = build(3);
    const r = s.revision;
    s.push((s.t[2] as number) + H, 1, 1, 1, 1, 1);
    expect(s.revision).toBeGreaterThan(r);
  });
});

describe("Series.extent", () => {
  it("returns the low/high envelope over a window only", () => {
    const s = build(50);
    const { min, max } = s.extent(10, 20);
    // bars 10..19 -> base 110..119, low = base-2, high = base+2
    expect(min).toBe(108);
    expect(max).toBe(121);
  });

  it("clamps a window that runs past the ends", () => {
    const s = build(5);
    const e = s.extent(-10, 999);
    expect(e.min).toBe(98);
    expect(e.max).toBe(106);
  });

  it("returns a usable range for an empty window instead of Infinity", () => {
    // A degenerate extent must not poison the price scale with Infinity, which
    // would make every subsequent yOf() return NaN and blank the chart.
    const s = build(5);
    expect(s.extent(3, 3)).toEqual({ min: 0, max: 1 });
  });
});

describe("Series.indexAtTime", () => {
  it("finds the last bar at or before a time", () => {
    const s = build(20);
    const t5 = s.t[5] as number;
    expect(s.indexAtTime(t5)).toBe(5);
    expect(s.indexAtTime(t5 + H / 2)).toBe(5);
    expect(s.indexAtTime(t5 - 1)).toBe(4);
  });

  it("returns -1 before the first bar", () => {
    const s = build(20);
    expect(s.indexAtTime((s.t[0] as number) - 1)).toBe(-1);
  });
});

describe("Series.spacingMs", () => {
  it("measures the median gap, not the nominal timeframe", () => {
    const s = build(40);
    expect(s.spacingMs()).toBe(H);
  });

  it("is not skewed by a single weekend-sized gap", () => {
    // The reason the median is used rather than the mean: one 3-day market
    // closure would otherwise inflate the measured spacing and make a healthy
    // feed look stale.
    const s = build(40);
    s.push((s.t[39] as number) + 72 * H, 1, 1, 1, 1, 1);
    expect(s.spacingMs()).toBe(H);
  });

  it("reports 0 when there is nothing to measure", () => {
    expect(new Series().spacingMs()).toBe(0);
  });
});
