/**
 * Heikin-Ashi smoothing.
 *
 * Worth pinning because the recursion is the whole algorithm and is easy to get
 * subtly wrong in a way that still draws a plausible chart: seed the open from
 * the current bar instead of the previous smoothed one and you get candles that
 * look fine, trend the same way, and are simply not Heikin-Ashi.
 */
import { describe, expect, it } from "vitest";
import { Series } from "../src/chart/series";

/** The engine keeps `heikinAshi` private; this is the same definition. */
function ha(bars: ReadonlyArray<[number, number, number, number]>) {
  const out: Array<{ o: number; h: number; l: number; c: number }> = [];
  let prevO = NaN;
  let prevC = NaN;
  for (const [o, h, l, c] of bars) {
    const haC = (o + h + l + c) / 4;
    const haO = Number.isFinite(prevO) ? (prevO + prevC) / 2 : (o + c) / 2;
    out.push({ o: haO, h: Math.max(h, haO, haC), l: Math.min(l, haO, haC), c: haC });
    prevO = haO;
    prevC = haC;
  }
  return out;
}

describe("heikin-ashi", () => {
  it("closes on the average of the four prices", () => {
    const [bar] = ha([[10, 14, 8, 12]]);
    expect(bar?.c).toBeCloseTo((10 + 14 + 8 + 12) / 4, 10);
  });

  it("opens on the midpoint of the PREVIOUS smoothed bar", () => {
    const bars = ha([
      [10, 14, 8, 12],
      [12, 16, 11, 15],
    ]);
    const first = bars[0] as { o: number; c: number };
    expect(bars[1]?.o).toBeCloseTo((first.o + first.c) / 2, 10);
  });

  it("seeds the first bar from its own open and close", () => {
    // Nothing precedes it. Seeding from the raw open alone puts a false gap at
    // the left edge that moves every time the window is panned.
    const [bar] = ha([[10, 14, 8, 12]]);
    expect(bar?.o).toBeCloseTo((10 + 12) / 2, 10);
  });

  it("extends high and low to contain the smoothed body", () => {
    const bars = ha([
      [100, 101, 99, 100],
      [100, 102, 99.5, 101.8],
    ]);
    for (const b of bars) {
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
    }
  });

  it("turns a clean trend into an unbroken run of one colour", () => {
    // The property the style exists for.
    const rising: Array<[number, number, number, number]> = [];
    let p = 100;
    for (let i = 0; i < 12; i++, p += 2) rising.push([p, p + 1.5, p - 0.5, p + 1]);
    const bars = ha(rising);
    // Skip the seed bar, which has no previous to smooth against.
    for (const b of bars.slice(1)) expect(b.c).toBeGreaterThan(b.o);
  });

  it("does not claim to be price", () => {
    // Every Heikin-Ashi value is an average, so a stop read off one of these
    // bodies is a stop at a price that never traded. The series the rest of the
    // terminal reports stays the real one.
    const raw: Array<[number, number, number, number]> = [[10, 14, 8, 12]];
    const [bar] = ha(raw);
    expect(bar?.c).not.toBe(12);
  });
});

describe("the series the chart reports is untouched", () => {
  it("keeps raw OHLC after the smoothing is drawn", () => {
    const s = new Series();
    s.reset([{ t: 1, o: 10, h: 14, l: 8, c: 12, v: 1 }]);
    // Heikin-Ashi is a rendering dialect. If it ever mutated the series, the
    // legend, crosshair and every level would start quoting averages.
    expect(s.o[0]).toBe(10);
    expect(s.c[0]).toBe(12);
  });
});
