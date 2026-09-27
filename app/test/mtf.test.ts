import { describe, it, expect } from "vitest";
import { aggregate, detectHigher, higherTimeframes, projectX, tfMs } from "../src/detect/mtf";
import { toDetectInput } from "../src/detect";
import type { DetectInput } from "../src/detect/types";

const HOUR = 3_600_000;
/** A clock-aligned start: 00:00 UTC, so bucket boundaries are obvious. */
const T0 = Date.parse("2026-01-01T00:00:00Z");

function hourly(n: number, t0 = T0, price = (i: number) => 100 + i): DetectInput {
  return toDetectInput(
    Array.from({ length: n }, (_, i) => {
      const p = price(i);
      return { t: t0 + i * HOUR, o: p, h: p + 2, l: p - 2, c: p + 0.5, v: 10 + i };
    }),
  );
}

describe("aggregation", () => {
  it("builds OHLCV correctly from the constituent bars", () => {
    const d = hourly(8);
    const a = aggregate(d, 4 * HOUR);
    expect(a.bars.c.length).toBe(2);
    // First 4h bar covers hours 0..3.
    expect(a.bars.o[0]).toBe(100);
    expect(a.bars.h[0]).toBe(105); // max of (100..103) + 2
    expect(a.bars.l[0]).toBe(98); // min of (100..103) - 2
    expect(a.bars.c[0]).toBe(103.5); // close of hour 3
    expect(a.bars.v[0]).toBe(10 + 11 + 12 + 13);
  });

  it("aligns buckets to the clock and drops the partial one at the start", () => {
    // History beginning at 13:00 puts three hours into the 12:00 bucket. Its
    // open, high and low would describe a 4h candle that never existed, so it
    // is dropped rather than aggregated — and the buckets that remain sit on
    // the same boundaries every other chart uses, so structure does not move
    // when more history loads.
    const d = hourly(8, Date.parse("2026-01-01T13:00:00Z"));
    const a = aggregate(d, 4 * HOUR);
    expect(new Date(a.bars.t[0] as number).toISOString()).toBe("2026-01-01T16:00:00.000Z");
    expect(a.bars.t.length).toBe(1);
  });

  it("drops the newest bucket while it is still forming", () => {
    // 6 hourly bars = one complete 4h bar plus two hours of the next.
    const d = hourly(6);
    const a = aggregate(d, 4 * HOUR);
    expect(a.bars.c.length).toBe(1);
  });

  it("keeps the newest bucket once it is provably complete", () => {
    const d = hourly(8);
    const a = aggregate(d, 4 * HOUR);
    expect(a.bars.c.length).toBe(2);
    expect(a.closeIndex[1]).toBe(7);
  });

  it("records where each bucket opened and closed in lower-timeframe terms", () => {
    const a = aggregate(hourly(12), 4 * HOUR);
    expect(a.openIndex).toEqual([0, 4, 8]);
    expect(a.closeIndex).toEqual([3, 7, 11]);
  });

  it("respects the closed-bar count it is given", () => {
    // The forming lower-timeframe bar must not reach the higher timeframe
    // either — the mistake just moves up a level otherwise.
    const d = hourly(9);
    expect(aggregate(d, 4 * HOUR, 9).bars.c.length).toBe(2);
    expect(aggregate(d, 4 * HOUR, 4).bars.c.length).toBe(1);
  });

  it("returns nothing for an empty or nonsensical request", () => {
    expect(aggregate(hourly(10), 0).bars.c.length).toBe(0);
    expect(aggregate(hourly(0), HOUR).bars.c.length).toBe(0);
  });
});

describe("projection into lower-timeframe index space", () => {
  const a = aggregate(hourly(12), 4 * HOUR);

  it("maps a whole bucket to where it opened", () => {
    expect(projectX(0, a)).toBe(0);
    expect(projectX(1, a)).toBe(4);
    expect(projectX(2, a)).toBe(8);
  });

  it("interpolates a fractional coordinate across the bucket", () => {
    // Half way through the second 4h bar is two hourly bars in.
    expect(projectX(1.5, a)).toBe(6);
  });

  it("does not clamp a projection past the last bucket", () => {
    // A trendline that stopped at its last touch would only ever fire in the
    // past; the slope has to keep going.
    expect(projectX(2.5, a)).toBeGreaterThan(8);
  });
});

describe("the look-ahead guarantee", () => {
  /**
   * A series with a real 4h swing structure: a rise, a pullback, a break.
   * Built from hourly bars so the aggregation is doing genuine work.
   */
  function swinging(n: number): DetectInput {
    return toDetectInput(
      Array.from({ length: n }, (_, i) => {
        const p = 100 + Math.sin(i / 9) * 6 + Math.sin(i / 31) * 12 + i * 0.02;
        const c = p + Math.sin(i / 3) * 0.6;
        return {
          t: T0 + i * HOUR,
          o: p,
          h: Math.max(p, c) + 0.9,
          l: Math.min(p, c) - 0.9,
          c,
          v: 100,
        };
      }),
    );
  }

  it("never marks a 4h structure knowable before its 4h bar closed", () => {
    // THE bug this module exists to prevent. Mapping `to` to the bucket's OPEN
    // would backdate every higher-timeframe signal by up to three hours on a
    // 1h chart — enough to turn a losing backtest into a winning one.
    const d = swinging(600);
    const found = detectHigher(d, "4h", ["structure", "levels", "trendlines"], 600);
    expect(found.length).toBeGreaterThan(0);
    const agg = aggregate(d, 4 * HOUR, 600);
    for (const det of found) {
      // Every `to` must be the closing hour of some 4h bar.
      expect(agg.closeIndex).toContain(det.to);
      // ...and a closing hour is always the last of its bucket, so t mod 4 == 3
      // for a series that starts on the clock.
      expect(det.to % 4).toBe(3);
    }
  });

  it("cannot report a structure that needs bars beyond the closed count", () => {
    const d = swinging(600);
    const found = detectHigher(d, "4h", ["structure"], 400);
    for (const det of found) expect(det.to).toBeLessThan(400);
  });

  it("labels the timeframe, because a 4h break is a different claim to a 1h one", () => {
    const found = detectHigher(swinging(600), "4h", ["structure"], 600);
    expect(found.length).toBeGreaterThan(0);
    for (const det of found) {
      expect(det.label).toMatch(/^4H · /);
      expect(det.timeframe).toBe("4h");
      expect(det.reason).toContain("on the 4h timeframe");
      expect(det.id).toMatch(/^4h:/);
    }
  });

  it("projects geometry into lower-timeframe coordinates", () => {
    const found = detectHigher(swinging(600), "4h", ["levels"], 600);
    const withGeometry = found.filter((d) => d.shapes.length > 0);
    expect(withGeometry.length).toBeGreaterThan(0);
    for (const det of withGeometry) {
      for (const sh of det.shapes) {
        // Coordinates are hourly indices now, so they may exceed the number of
        // 4h bars, which is a quarter as many.
        if (sh.type === "box" || sh.type === "line") expect(sh.x1).toBeLessThanOrEqual(600);
      }
    }
  });

  it("finds nothing when there is not enough higher-timeframe history", () => {
    // 100 hourly bars is 25 4h bars — too few swings for any honest structure.
    expect(detectHigher(hourly(100), "4h", ["structure"], 100)).toEqual([]);
  });
});

describe("the timeframe ladder", () => {
  it("offers only higher timeframes, never lower ones", () => {
    for (const [base, higher] of Object.entries({
      "1h": higherTimeframes("1h"),
      "15m": higherTimeframes("15m"),
      "1d": higherTimeframes("1d"),
    })) {
      for (const h of higher) expect(tfMs(h)).toBeGreaterThan(tfMs(base));
    }
  });

  it("has nothing above the top of the ladder", () => {
    expect(higherTimeframes("1w")).toEqual([]);
  });

  it("parses the timeframes it offers", () => {
    expect(tfMs("4h")).toBe(4 * HOUR);
    expect(tfMs("15m")).toBe(900_000);
    expect(tfMs("1d")).toBe(86_400_000);
    expect(tfMs("nonsense")).toBe(0);
  });
});
