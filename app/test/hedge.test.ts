import { describe, it, expect } from "vitest";
import { sizeHedge, residualRiskFraction, MIN_HEDGE_FIT } from "../src/risk/hedge";
import { MIN_HISTORY } from "../src/risk/portfolio";
import type { Position } from "../src/risk/sizing";
import type { ClosesSeries } from "../src/data/correlation";

/** Deterministic normal-ish noise. Seeded so a failure reproduces. */
function noise(seed: number, n: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const a = s / 4294967296;
    s = (s * 1664525 + 1013904223) >>> 0;
    const b = s / 4294967296;
    out.push(Math.sqrt(-2 * Math.log(a + 1e-12)) * Math.cos(2 * Math.PI * b));
  }
  return out;
}

/** Build a closes series from a return stream. */
function seriesFrom(symbol: string, rets: readonly number[]): ClosesSeries {
  let px = 100;
  const closes = [{ t: 0, c: px }];
  for (let i = 0; i < rets.length; i++) {
    px *= 1 + (rets[i] as number);
    closes.push({ t: (i + 1) * 3_600_000, c: px });
  }
  return { symbol, closes };
}

const N = 400;

/** A factor and a leg with a known beta and a known amount of idiosyncratic noise. */
function pair(beta: number, idioScale: number, seed = 5) {
  const f = noise(seed, N).map((x) => x * 0.01);
  const e = noise(seed + 977, N).map((x) => x * 0.01 * idioScale);
  const y = f.map((x, i) => beta * x + (e[i] as number));
  return { factor: seriesFrom("HEDGE", f), leg: seriesFrom("LEG", y) };
}

const pos = (symbol: string, qty: number, entry: number, direction: "long" | "short" = "long"): Position => ({
  symbol,
  qty,
  entry,
  direction,
});

describe("refusals", () => {
  it("refuses with no positions", () => {
    const r = sizeHedge({ positions: [], instrument: "HEDGE", series: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("No open positions");
  });

  it("refuses when the hedge instrument has no stored bars", () => {
    const { leg } = pair(1, 0.2);
    const r = sizeHedge({ positions: [pos("LEG", 1, 100)], instrument: "HEDGE", series: [leg] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("No stored bars for HEDGE");
  });

  it("refuses on too little shared history rather than fitting a beta to it", () => {
    const f = noise(1, 10).map((x) => x * 0.01);
    const r = sizeHedge({
      positions: [pos("LEG", 1, 100)],
      instrument: "HEDGE",
      series: [seriesFrom("HEDGE", f), seriesFrom("LEG", f)],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(MIN_HISTORY));
  });
});

describe("sizing", () => {
  it("sizes the hedge opposite to the exposure, scaled by beta", () => {
    /* beta 1.5, very little idiosyncratic noise -> a high R² and a clean size. */
    const { factor, leg } = pair(1.5, 0.05);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100)], // +1000 notional
      instrument: "HEDGE",
      series: [factor, leg],
    });
    expect(r.ok).toBe(true);
    const l = r.legs[0]!;
    expect(l.refusal).toBeNull();
    expect(l.beta).toBeCloseTo(1.5, 1);
    expect(l.notional).toBeCloseTo(1000, 6);
    /* Opposite sign, and |hedge| = beta x |notional|. */
    expect(l.hedgeNotional).toBeLessThan(0);
    expect(l.hedgeNotional).toBeCloseTo(-l.beta * 1000, 6);
  });

  it("flips the hedge sign for a short", () => {
    const { factor, leg } = pair(1.5, 0.05);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100, "short")],
      instrument: "HEDGE",
      series: [factor, leg],
    });
    const l = r.legs[0]!;
    expect(l.notional).toBeLessThan(0);
    expect(l.hedgeNotional).toBeGreaterThan(0);
  });

  it("reports variance removed as the R², not as something better", () => {
    const { factor, leg } = pair(1, 1); // half the variance is idiosyncratic
    const r = sizeHedge({ positions: [pos("LEG", 10, 100)], instrument: "HEDGE", series: [factor, leg] });
    const l = r.legs[0]!;
    expect(l.varianceRemoved).toBeCloseTo(l.r2, 12);
    expect(l.r2).toBeGreaterThan(0.3);
    expect(l.r2).toBeLessThan(0.7);
  });

  it("excludes the hedge instrument from the legs it hedges", () => {
    /* Hedging a position with itself is beta 1, R² 1 — arithmetically true and
       just "close the position". It must not appear as a hedge leg. */
    const { factor, leg } = pair(1.2, 0.1);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100), pos("HEDGE", 5, 100)],
      instrument: "HEDGE",
      series: [factor, leg],
    });
    expect(r.legs.map((l) => l.symbol)).toEqual(["LEG"]);
  });

  it("nets a symbol held long and short before sizing anything", () => {
    const { factor, leg } = pair(1.2, 0.1);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100), pos("LEG", 10, 100, "short")],
      instrument: "HEDGE",
      series: [factor, leg],
    });
    /* Net exposure is zero, so there is nothing to hedge at all. */
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("No open positions");
  });
});

describe("the weak-fit refusal, which is the point of the module", () => {
  it("refuses to size a hedge on a leg the instrument barely explains", () => {
    /* beta near zero, almost all idiosyncratic: R² well under the bar. */
    const { factor, leg } = pair(0.05, 6);
    const r = sizeHedge({ positions: [pos("LEG", 10, 100)], instrument: "HEDGE", series: [factor, leg] });
    const l = r.legs[0]!;
    expect(l.r2).toBeLessThan(MIN_HEDGE_FIT);
    expect(Number.isNaN(l.hedgeNotional)).toBe(true);
    expect(l.refusal).toContain("explains only");
    expect(l.refusal).toContain("second position");
  });

  it("counts a refused leg as unhedged, not as absent", () => {
    const weak = pair(0.05, 6, 5);
    const strong = pair(1.4, 0.05, 31);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100), pos("OTHER", 20, 100)],
      instrument: "HEDGE",
      series: [
        weak.factor,
        weak.leg,
        { symbol: "OTHER", closes: strong.leg.closes },
      ],
    });
    /* OTHER was generated against a different factor stream, so its fit to
       HEDGE is poor too — what matters here is that both legs are accounted
       for in one bucket or the other and none silently vanish. */
    const total = r.hedgedNotional + r.unhedgedNotional;
    const gross = r.legs.reduce((s, l) => s + Math.abs(l.notional), 0);
    expect(total).toBeCloseTo(gross, 6);
  });

  it("weights book variance removed by squared notional, not by leg count", () => {
    /* A tiny well-fitting leg must not speak for a large badly-fitting one. */
    const good = pair(1.5, 0.05, 7);
    const bad = pair(0.02, 8, 101);
    const r = sizeHedge({
      positions: [
        pos("LEG", 1, 1), // 1 notional, fits well
        pos("BAD", 1000, 100), // 100_000 notional, fits badly
      ],
      instrument: "HEDGE",
      series: [good.factor, good.leg, { symbol: "BAD", closes: bad.leg.closes }],
    });
    expect(r.ok).toBe(true);
    /* Dominated by the large bad leg, so far below the good leg's own R². */
    expect(r.bookVarianceRemoved).toBeLessThan(0.2);
  });

  it("names symbols with no stored history instead of dropping them", () => {
    const { factor, leg } = pair(1.2, 0.1);
    const r = sizeHedge({
      positions: [pos("LEG", 10, 100), pos("GHOST", 5, 100)],
      instrument: "HEDGE",
      series: [factor, leg],
    });
    expect(r.missing).toContain("GHOST");
    const ghost = r.legs.find((l) => l.symbol === "GHOST");
    expect(ghost?.refusal).toContain("No stored bars");
    expect(Number.isNaN(ghost?.hedgeNotional as number)).toBe(true);
  });
});

describe("residual risk", () => {
  it("is the square root of the unexplained variance, not the unexplained variance", () => {
    /* An R² of 0.75 removes 75% of the VARIANCE and 50% of the VOLATILITY.
       Quoting the first as though it were the second is the standard
       overstatement of what a hedge achieved. */
    expect(residualRiskFraction(0.75)).toBeCloseTo(0.5, 10);
    expect(residualRiskFraction(0.75)).not.toBeCloseTo(0.25, 3);
  });

  it("is 0 for a perfect fit and 1 for none", () => {
    expect(residualRiskFraction(1)).toBe(0);
    expect(residualRiskFraction(0)).toBe(1);
  });

  it("clamps rather than returning NaN for an out-of-range R²", () => {
    expect(residualRiskFraction(1.2)).toBe(0);
    expect(residualRiskFraction(-0.3)).toBe(1);
    expect(Number.isNaN(residualRiskFraction(NaN))).toBe(true);
  });
});
