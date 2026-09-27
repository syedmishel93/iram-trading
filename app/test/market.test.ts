import { describe, it, expect } from "vitest";
import { readSpread, median, WIDE_SPREAD_PCT, type VenueQuote } from "../src/data/spread";
import {
  pearson,
  alignedReturns,
  correlate,
  buildMatrix,
  heatUnderstatement,
  MIN_OVERLAP,
  HIGH_CORRELATION,
  type ClosesSeries,
} from "../src/data/correlation";

const q = (venue: string, price: number): VenueQuote => ({ venue, price, asOf: 1_000 });

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("ignores non-finite values", () => {
    expect(median([1, NaN, 3])).toBe(2);
  });

  it("returns NaN for nothing", () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("readSpread", () => {
  it("needs at least two books", () => {
    expect(readSpread([]).ok).toBe(false);
    const one = readSpread([q("Binance", 100)]);
    expect(one.ok).toBe(false);
    expect(one.reason).toMatch(/at least two books/);
  });

  it("computes the widest gap against the median", () => {
    const r = readSpread([q("Binance", 100), q("Coinbase", 101), q("OKX", 100.5)]);
    expect(r.ok).toBe(true);
    expect(r.reference).toBe(100.5);
    expect(r.spreadPct).toBeCloseTo((1 / 100.5) * 100, 6);
    expect(r.high).toBe("Coinbase");
    expect(r.low).toBe("Binance");
  });

  // Median, not mean: one lagging venue must not drag the reference.
  it("is not dragged by a single stale outlier", () => {
    const r = readSpread([q("A", 100), q("B", 100.1), q("C", 100.2), q("D", 60)]);
    expect(r.reference).toBeCloseTo(100.05, 6);
  });

  it("drops venues that returned nothing usable", () => {
    const r = readSpread([q("A", 100), q("B", NaN), q("C", 0), q("D", 101)]);
    expect(r.quotes.map((x) => x.venue)).toEqual(["A", "D"]);
  });

  it("stays silent on a normal basis", () => {
    expect(readSpread([q("A", 100), q("B", 100.05)]).note).toBe("");
  });

  // A spread is not an arbitrage, and the note must not read like one.
  it("describes a wide spread without suggesting a trade", () => {
    const r = readSpread([q("A", 100), q("B", 100 * (1 + WIDE_SPREAD_PCT / 100) + 0.01)]);
    expect(r.note).toMatch(/wide for a cross-venue basis/i);
    expect(r.note).toMatch(/NOT free money/);
    expect(r.note).not.toMatch(/\bbuy\b|\bsell\b|arbitrage opportunity/i);
  });
});

describe("pearson", () => {
  it("is 1 for identical series and −1 for mirrored", () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
  });

  it("is near zero for an orthogonal pair", () => {
    expect(Math.abs(pearson([1, -1, 1, -1], [1, 1, -1, -1]))).toBeLessThan(1e-9);
  });

  // Reporting 0 would read as "uncorrelated", which is a claim.
  it("returns NaN when a series has no variance", () => {
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
  });

  it("returns NaN for fewer than two points", () => {
    expect(Number.isNaN(pearson([1], [1]))).toBe(true);
  });
});

describe("alignedReturns", () => {
  const series = (symbol: string, points: [number, number][]): ClosesSeries => ({
    symbol,
    closes: points.map(([t, c]) => ({ t, c })),
  });

  /**
   * Correlating by array position silently pairs Tuesday with Wednesday and
   * produces a confident, meaningless number. This is the whole reason the join
   * is on timestamp.
   */
  it("joins on timestamp, not on array position", () => {
    const a = series("A", [[1, 100], [2, 110], [3, 120]]);
    // B is missing t=2 entirely.
    const b = series("B", [[1, 50], [3, 60]]);
    const { ra, rb } = alignedReturns(a, b);
    expect(ra.length).toBe(1);
    expect(rb.length).toBe(1);
    // The surviving pair is t=1 -> t=3 in BOTH, not a's 1->2 against b's 1->3.
    expect(ra[0]).toBeCloseTo(Math.log(120 / 100), 9);
    expect(rb[0]).toBeCloseTo(Math.log(60 / 50), 9);
  });

  it("sorts before differencing, so unordered input still works", () => {
    const a = series("A", [[3, 120], [1, 100], [2, 110]]);
    const b = series("B", [[2, 55], [1, 50], [3, 60]]);
    const { ra } = alignedReturns(a, b);
    expect(ra.length).toBe(2);
    expect(ra[0]).toBeCloseTo(Math.log(110 / 100), 9);
  });

  it("drops non-positive and non-finite closes", () => {
    const a = series("A", [[1, 100], [2, 0], [3, 120]]);
    const b = series("B", [[1, 50], [2, 55], [3, 60]]);
    expect(alignedReturns(a, b).ra.length).toBe(1);
  });

  it("returns nothing when the series do not overlap at all", () => {
    const a = series("A", [[1, 100], [2, 110]]);
    const b = series("B", [[9, 50], [10, 55]]);
    expect(alignedReturns(a, b).ra.length).toBe(0);
  });
});

describe("correlate and buildMatrix", () => {
  const walk = (symbol: string, n: number, f: (i: number) => number): ClosesSeries => ({
    symbol,
    closes: Array.from({ length: n }, (_, i) => ({ t: i * 1000, c: f(i) })),
  });

  it("reports the overlap alongside the coefficient", () => {
    const a = walk("A", 60, (i) => 100 + i);
    const b = walk("B", 60, (i) => 200 + i * 2);
    const c = correlate(a, b);
    expect(c.overlap).toBe(59);
    expect(c.r).toBeCloseTo(1, 6);
  });

  // With 30 points an r of 0.35 is indistinguishable from zero.
  it("refuses to judge a short overlap", () => {
    const a = walk("A", 10, (i) => 100 + i);
    const b = walk("B", 10, (i) => 200 + i);
    const c = correlate(a, b);
    expect(c.overlap).toBeLessThan(MIN_OVERLAP);
    expect(Number.isNaN(c.r)).toBe(true);
  });

  it("builds every unordered pair once", () => {
    const m = buildMatrix([
      walk("A", 60, (i) => 100 + i),
      walk("B", 60, (i) => 100 + i * 1.5),
      walk("C", 60, (i) => 100 + Math.sin(i) * 5),
    ]);
    expect(m.pairs.length + m.unjudged.length).toBe(3);
    expect(m.symbols).toEqual(["A", "B", "C"]);
  });

  it("ranks by absolute correlation, so a strong inverse is not buried", () => {
    const m = buildMatrix([
      walk("A", 60, (i) => 100 + i),
      walk("DOWN", 60, (i) => 1000 - i),
      walk("NOISE", 60, (i) => 100 + Math.sin(i * 7.3) * 3),
    ]);
    expect(Math.abs(m.pairs[0]?.r ?? 0)).toBeGreaterThan(Math.abs(m.pairs[m.pairs.length - 1]?.r ?? 1));
  });

  // The point of the whole module.
  it("names a cluster and says heat will understate it", () => {
    const m = buildMatrix([
      walk("A", 60, (i) => 100 + i),
      walk("B", 60, (i) => 300 + i * 3),
    ]);
    expect(m.clustered.length).toBe(1);
    expect(m.note).toMatch(/one bet with several tickets/i);
    expect(m.note).toMatch(/understate/i);
  });

  it("says so when nothing is clustered", () => {
    const m = buildMatrix([
      walk("A", 80, (i) => 100 + Math.sin(i) * 5),
      walk("B", 80, (i) => 100 + Math.cos(i * 3.1) * 5),
    ]);
    expect(m.clustered.length).toBe(0);
    expect(m.note).toMatch(/separate positions are separate risk/i);
  });

  it("reports unjudged pairs rather than hiding them", () => {
    const m = buildMatrix([walk("A", 10, (i) => 100 + i), walk("B", 10, (i) => 200 + i)]);
    expect(m.unjudged.length).toBe(1);
    expect(m.note).toMatch(/could not be judged/i);
  });

  it("handles fewer than two series", () => {
    expect(buildMatrix([]).note).toMatch(/at least two/i);
    expect(buildMatrix([walk("A", 60, (i) => i + 1)]).pairs.length).toBe(0);
  });
});

describe("heatUnderstatement", () => {
  it("is 1 for a single position", () => {
    expect(heatUnderstatement([], 1)).toBe(1);
  });

  it("is 1 when correlations are unknown", () => {
    expect(heatUnderstatement([{ a: "A", b: "B", r: NaN, overlap: 5 }], 3)).toBe(1);
  });

  // Five perfectly correlated positions are one position five times over.
  it("approaches sqrt(n) for a perfectly correlated book", () => {
    const pairs = [{ a: "A", b: "B", r: 1, overlap: 100 }];
    expect(heatUnderstatement(pairs, 5)).toBeCloseTo(Math.sqrt(5), 6);
  });

  it("is 1 for a genuinely uncorrelated book", () => {
    expect(heatUnderstatement([{ a: "A", b: "B", r: 0, overlap: 100 }], 5)).toBeCloseTo(1, 9);
  });

  it("is below 1 when the book genuinely hedges itself", () => {
    expect(heatUnderstatement([{ a: "A", b: "B", r: -0.5, overlap: 100 }], 2)).toBeLessThan(1);
  });

  it("never returns a non-finite ratio, however hostile the input", () => {
    for (const r of [-1, -0.999, 0, 0.999, 1]) {
      const v = heatUnderstatement([{ a: "A", b: "B", r, overlap: 100 }], 4);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
