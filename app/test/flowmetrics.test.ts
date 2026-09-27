import { describe, it, expect } from "vitest";
import {
  basis,
  oiState,
  fundingDivergence,
  liquidationClusters,
  clusterShapes,
  fmtCompact,
} from "../src/data/flowmetrics";
import type { FundingPoint, OpenInterestPoint } from "../src/data/derivs";
import type { Liquidation } from "../src/data/stream";

const T0 = Date.parse("2026-01-01T00:00:00Z");

describe("spot-perp basis", () => {
  it("reads a rich perp as crowding, not as confirmation", () => {
    const b = basis(100, 100.5);
    expect(b).not.toBeNull();
    expect(b!.bp).toBeCloseTo(50, 6);
    expect(b!.direction).toBe("short");
    expect(b!.reason).toMatch(/crowding, not confirmation/);
  });

  it("reads a cheap perp as leverage paying to be short", () => {
    const b = basis(100, 99.5)!;
    expect(b.direction).toBe("long");
    expect(b.bp).toBeCloseTo(-50, 6);
  });

  it("refuses to call microstructure a signal", () => {
    // A basis of a fraction of a basis point is the tick size, not positioning.
    const b = basis(100, 100.005)!;
    expect(b.direction).toBe("neutral");
    expect(b.reason).toMatch(/noise band/);
  });

  it("returns null rather than a number when an input is unusable", () => {
    expect(basis(0, 100)).toBeNull();
    expect(basis(100, 0)).toBeNull();
    expect(basis(NaN, 100)).toBeNull();
  });

  it("annualises consistently with the stated horizon", () => {
    const oneDay = basis(100, 101, 1)!;
    const twoDays = basis(100, 101, 2)!;
    expect(oneDay.annualisedPct).toBeCloseTo(2 * twoDays.annualisedPct, 6);
  });
});

describe("the open-interest read", () => {
  const oi = (amounts: number[]): OpenInterestPoint[] =>
    amounts.map((a, i) => ({ time: T0 + i * 3_600_000, amount: a, value: a * 100 }));

  it("separates new longs from short covering on the same rising price", () => {
    // The distinction a price chart cannot make, and the reason this exists.
    expect(oiState(oi([100, 110]), 2, 24)!.state).toBe("new-longs");
    expect(oiState(oi([100, 90]), 2, 24)!.state).toBe("short-covering");
  });

  it("separates new shorts from long liquidation on the same falling price", () => {
    expect(oiState(oi([100, 110]), -2, 24)!.state).toBe("new-shorts");
    expect(oiState(oi([100, 90]), -2, 24)!.state).toBe("long-liquidation");
  });

  it("calls a drift quiet rather than classifying noise", () => {
    const r = oiState(oi([100, 100.05]), 0.02, 24)!;
    expect(r.state).toBe("quiet");
    expect(r.reason).toMatch(/nothing is being decided/);
  });

  it("only leans directional where new money is actually arriving", () => {
    // Covering and liquidation are exhaustive flows: they end on their own, so
    // they are not a direction to trade.
    expect(oiState(oi([100, 90]), 2, 24)!.direction).toBe("neutral");
    expect(oiState(oi([100, 90]), -2, 24)!.direction).toBe("neutral");
    expect(oiState(oi([100, 110]), 2, 24)!.direction).toBe("long");
    expect(oiState(oi([100, 110]), -2, 24)!.direction).toBe("short");
  });

  it("says nothing when there is nothing to compare", () => {
    expect(oiState([], 1)).toBeNull();
    expect(oiState(oi([100]), 1)).toBeNull();
    expect(oiState(oi([0, 100]), 1, 24)).toBeNull();
  });

  it("measures against the lookback, not against the whole series", () => {
    const series = oi([100, 100, 100, 100, 200]);
    // Over 2 bars OI doubled; over 24 it also doubled, but the reference index
    // must clamp rather than run off the front of the array.
    expect(oiState(series, 1, 2)!.oiChangePct).toBeCloseTo(100, 6);
    expect(oiState(series, 1, 99)!.oiChangePct).toBeCloseTo(100, 6);
  });
});

describe("funding divergence", () => {
  const fund = (rates: number[]): FundingPoint[] =>
    rates.map((r, i) => ({ time: T0 + i * 28_800_000, rate: r, markPrice: 100 }));

  it("names the state where a position gets more crowded and less right", () => {
    const d = fundingDivergence(fund([0.0001, 0.0002, 0.0004]), -3, 2)!;
    expect(d.present).toBe(true);
    expect(d.direction).toBe("short");
    expect(d.reason).toMatch(/more crowded and less right/);
  });

  it("names the squeeze on the other side", () => {
    const d = fundingDivergence(fund([0.0004, 0.0002, -0.0001]), 3, 2)!;
    expect(d.present).toBe(true);
    expect(d.direction).toBe("long");
    expect(d.reason).toMatch(/squeezed/);
  });

  it("does not call agreement a divergence", () => {
    const d = fundingDivergence(fund([0.0001, 0.0002, 0.0004]), 3, 2)!;
    expect(d.present).toBe(false);
    expect(d.reason).toMatch(/moving together/);
  });

  it("refuses to read two nearly-flat series as opposition", () => {
    // Opposite signs in the fifth decimal is not a market event.
    const d = fundingDivergence(fund([0.0001, 0.0001, 0.000101]), -0.05, 2)!;
    expect(d.present).toBe(false);
    expect(d.reason).toMatch(/close to flat/);
  });

  it("says nothing on too short a series", () => {
    expect(fundingDivergence(fund([0.0001]), 5)).toBeNull();
  });
});

describe("liquidation clusters", () => {
  const liq = (price: number, value: number, side: "buy" | "sell"): Liquidation => ({
    time: T0,
    symbol: "BTCUSDT",
    side,
    price,
    quantity: value / price,
    value,
  });

  it("groups prints into shelves instead of listing them", () => {
    const rows = [
      liq(78_400, 4_000_000, "sell"),
      liq(78_420, 5_000_000, "sell"),
      liq(78_390, 2_000_000, "sell"),
      liq(71_000, 300_000, "buy"),
    ];
    const c = liquidationClusters(rows, { bucketPct: 0.005, minShare: 0.05 });
    expect(c.length).toBeGreaterThanOrEqual(1);
    const top = c[0]!;
    expect(top.value).toBe(11_000_000);
    expect(top.count).toBe(3);
    expect(top.price).toBeGreaterThan(78_380);
    expect(top.price).toBeLessThan(78_430);
  });

  it("attributes a SELL liquidation to a LONG being forced out", () => {
    // The thing everyone gets backwards: the exchange reports the side of the
    // liquidating ORDER, not the side of the position that died.
    const c = liquidationClusters([liq(100, 1_000_000, "sell")], { minShare: 0 });
    expect(c[0]!.side).toBe("long");
    const s = liquidationClusters([liq(100, 1_000_000, "buy")], { minShare: 0 });
    expect(s[0]!.side).toBe("short");
  });

  it("calls a mixed shelf both rather than picking a winner", () => {
    const c = liquidationClusters(
      [liq(100, 1_000_000, "sell"), liq(100.1, 1_000_000, "buy")],
      { minShare: 0 },
    );
    expect(c[0]!.side).toBe("both");
  });

  it("drops shelves too small to be a level", () => {
    // One small print is a print. Drawing it as a level fills the chart with
    // lines that mean nothing, which is worse than drawing none.
    const rows = [liq(100, 10_000_000, "sell"), liq(200, 1_000, "buy")];
    const c = liquidationClusters(rows, { minShare: 0.05 });
    expect(c).toHaveLength(1);
    expect(c[0]!.price).toBeCloseTo(100, 6);
  });

  it("buckets by percentage, so it is correct for a $4 asset and a $78,000 one", () => {
    const cheap = liquidationClusters(
      [liq(4.0, 1_000_000, "sell"), liq(4.005, 1_000_000, "sell")],
      { bucketPct: 0.005, minShare: 0 },
    );
    const dear = liquidationClusters(
      [liq(78_000, 1_000_000, "sell"), liq(78_100, 1_000_000, "sell")],
      { bucketPct: 0.005, minShare: 0 },
    );
    expect(cheap).toHaveLength(1);
    expect(dear).toHaveLength(1);
  });

  it("ranks by notional and caps the list", () => {
    const rows = Array.from({ length: 20 }, (_, i) => liq(100 + i * 10, (i + 1) * 1_000_000, "sell"));
    const c = liquidationClusters(rows, { bucketPct: 0.001, minShare: 0, max: 5 });
    expect(c).toHaveLength(5);
    for (let i = 1; i < c.length; i++) expect(c[i - 1]!.value).toBeGreaterThanOrEqual(c[i]!.value);
  });

  it("returns nothing rather than a zero shelf for unusable input", () => {
    expect(liquidationClusters([])).toEqual([]);
    expect(liquidationClusters([liq(0, 100, "sell")])).toEqual([]);
  });

  it("turns clusters into levels the chart can draw", () => {
    const c = liquidationClusters([liq(100, 5_000_000, "sell")], { minShare: 0 });
    const shapes = clusterShapes(c, 42);
    expect(shapes).toHaveLength(1);
    const s = shapes[0]!;
    expect(s.type).toBe("level");
    if (s.type === "level") {
      expect(s.x0).toBe(42);
      expect(s.y).toBeCloseTo(100, 6);
      expect(s.label).toContain("long liq");
      expect(s.label).toContain("$5.00M");
    }
  });
});

describe("compact money", () => {
  it("scales without lying about magnitude", () => {
    expect(fmtCompact(1_500_000_000)).toBe("$1.50B");
    expect(fmtCompact(2_340_000)).toBe("$2.34M");
    expect(fmtCompact(4_500)).toBe("$4.5K");
    expect(fmtCompact(42)).toBe("$42");
  });
});
