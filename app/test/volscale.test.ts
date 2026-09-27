/**
 * THE VOLUME BAND'S ARITHMETIC — `chart/volscale.ts`.
 *
 * The band scaled linearly against the visible MAXIMUM, and volume is
 * heavy-tailed, so one spike flattened the rest. MEASURED on BTCUSDT 1h in the
 * 42px the band actually has: the median bar drew at 4.5–6.1px, 11–15% of the
 * pane, with up to 23% of bars under three pixels.
 *
 * THE TEST THAT MATTERS IS `a lone spike does not flatten the rest`. That is
 * the defect, stated as arithmetic, and it is the one a future "let's just
 * scale to max, it's simpler" would break.
 *
 * THE SECOND IS `height stays proportional below the clip`. It is why this is a
 * percentile anchor and not a log: under log, a bar that traded ten times the
 * median draws 1.3x the median's height, so a volume climax — the one event
 * anybody reads this strip for — renders as an ordinary bar. That is a wrong
 * SCALE, which is plausible, unlabelled and not red, and this project already
 * records the class. A test that only asked "is the median readable" would
 * have passed log and shipped it.
 */

import { describe, expect, it } from "vitest";
import {
  formatRelative,
  relativeVolume,
  REFERENCE_PERCENTILE,
  volumeScale,
} from "../src/chart/volscale";

const ZONE = 42;
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

describe("the defect, as arithmetic", () => {
  it("a lone spike does not flatten the rest", () => {
    // 99 ordinary bars and one that traded 100x. Under `v / max` every
    // ordinary bar draws 0.42px. Here they keep a readable height.
    const v = [...flat(99, 100), 10_000];
    const s = volumeScale(v, 0, v.length, ZONE);
    expect(s.heightOf(100)).toBeGreaterThan(ZONE * 0.25);
    // …and the spike is still drawn at full height and COUNTED as clipped, so
    // the caller can mark it rather than quietly understating it.
    expect(s.heightOf(10_000)).toBe(ZONE);
    expect(s.clipped).toBe(1);
  });

  it("on a realistic heavy tail the median is readable", () => {
    // A log-normal-ish window: most bars near the median, a few multiples.
    const v = [
      ...flat(200, 100), ...flat(40, 250), ...flat(30, 400),
      ...flat(20, 900), ...flat(8, 2_000), ...flat(2, 12_000),
    ];
    const s = volumeScale(v, 0, v.length, ZONE);
    const medianPx = s.heightOf(s.median);
    expect(medianPx).toBeGreaterThan(3);
    expect(medianPx / ZONE).toBeGreaterThan(0.15);
  });

  it("HEIGHT STAYS PROPORTIONAL BELOW THE CLIP — this is why it is not a log", () => {
    const v = [...flat(90, 100), ...flat(10, 400)];
    const s = volumeScale(v, 0, v.length, ZONE);
    // Twice the volume is twice the bar. Under log1p it would be ~1.1x, and a
    // reader could no longer tell a climax from an ordinary bar.
    expect(s.heightOf(200) / s.heightOf(100)).toBeCloseTo(2, 5);
    expect(s.heightOf(300) / s.heightOf(100)).toBeCloseTo(3, 5);
  });
});

describe("it refuses rather than dividing", () => {
  it("an empty window draws nothing and says so", () => {
    const s = volumeScale([], 0, 0, ZONE);
    expect(s.empty).toBe(true);
    expect(s.heightOf(100)).toBe(0);
  });

  it("a window of all zeros is empty, not a division", () => {
    const s = volumeScale(flat(50, 0), 0, 50, ZONE);
    expect(s.empty).toBe(true);
    expect(Number.isFinite(s.heightOf(0))).toBe(true);
  });

  it("a zero-height band cannot divide", () => {
    const s = volumeScale(flat(50, 100), 0, 50, 0);
    expect(s.empty).toBe(true);
    expect(s.heightOf(100)).toBe(0);
  });

  it("a FLAT window does not clip half its bars", () => {
    // Every bar identical: the 95th percentile IS the median, and anchoring
    // there would clip half the window. The reference lifts instead, so the
    // bars draw short — the honest picture of a market trading evenly.
    const s = volumeScale(flat(100, 100), 0, 100, ZONE);
    expect(s.clipped).toBe(0);
    expect(s.heightOf(100)).toBeLessThan(ZONE);
    expect(s.heightOf(100)).toBeGreaterThan(0);
  });

  it("a volume it cannot read is skipped, never treated as zero", () => {
    const v = [100, NaN, 200, Infinity, -5, 300];
    const s = volumeScale(v, 0, v.length, ZONE);
    expect(s.empty).toBe(false);
    for (const bad of [NaN, Infinity, -5, 0]) expect(s.heightOf(bad)).toBe(0);
  });

  it("no bar ever draws taller than the band or shorter than nothing", () => {
    const v = [...flat(50, 100), 1e9];
    const s = volumeScale(v, 0, v.length, ZONE);
    for (const x of [0, 1, 100, 1e6, 1e12]) {
      const h = s.heightOf(x);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(ZONE);
      expect(Number.isFinite(h)).toBe(true);
    }
  });
});

describe("it reads only the visible window", () => {
  it("a spike outside the range does not change the scale inside it", () => {
    // The band is drawn per visible range; a bar off screen must not set the
    // reference, or panning would resize every bar for no visible reason.
    const v = [1e6, ...flat(100, 100), 1e6];
    const inner = volumeScale(v, 1, 101, ZONE);
    expect(inner.clipped).toBe(0);
    expect(inner.median).toBe(100);
  });

  it("a range beyond the data is clamped rather than read out of bounds", () => {
    const v = flat(10, 100);
    const s = volumeScale(v, -5, 999, ZONE);
    expect(s.empty).toBe(false);
    expect(s.median).toBe(100);
  });
});

describe("relative volume is the figure a trader acts on", () => {
  it("reports the ratio to the window's median", () => {
    expect(relativeVolume(320, 100)).toBeCloseTo(3.2, 5);
    expect(relativeVolume(40, 100)).toBeCloseTo(0.4, 5);
  });

  it("a ratio with no denominator is an unanswered question, not a zero", () => {
    expect(relativeVolume(100, 0)).toBeNull();
    expect(relativeVolume(100, NaN)).toBeNull();
    expect(relativeVolume(NaN, 100)).toBeNull();
    expect(relativeVolume(0, 100)).toBeNull();
  });

  it("formats to a precision that is not invented", () => {
    expect(formatRelative(3.24)).toBe("3.2×");
    expect(formatRelative(0.42)).toBe("0.4×");
    // Past ten, a decimal is noise.
    expect(formatRelative(12.7)).toBe("13×");
    expect(formatRelative(null)).toBe("");
  });
});

describe("the reference is where it says it is", () => {
  it("clips about the share the percentile promises", () => {
    const v = Array.from({ length: 1000 }, (_, i) => i + 1);
    const s = volumeScale(v, 0, v.length, ZONE);
    const share = s.clipped / v.length;
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(1 - REFERENCE_PERCENTILE + 0.02);
  });
});
