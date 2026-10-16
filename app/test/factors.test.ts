/**
 * A MULTI-FACTOR RISK MODEL, and the four ways one lies.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `risk/portfolio.ts` already carried `factorExposures`, and it is a ONE-factor
 * model against a nominated symbol — BTCUSDT by default, honestly documented as
 * "not a market factor in any academic sense but IS the thing that moves
 * everything else". That is true for a crypto-only book and says almost nothing
 * about a book holding gold and EURUSD: regressing XAUUSD on BTCUSDT measures
 * noise. And a `Scenario` there carries a single `factorMove`, so "rates up
 * 250bp while equities fall 20% and the dollar rallies 8%" — which is what 2022
 * was — cannot be expressed at all.
 *
 * The factor series were already in the archive, held deeper than anything
 * else: DXY to 1971, SPX to 1928, US10Y to 1962, VIX to 1990. They were reachable
 * from the rule engine and not from the risk desk.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR WAYS A FACTOR MODEL LIES, all pinned below
 *
 * 1. **A YIELD IS NOT A PRICE.** `alignSeries` takes a log return of every
 *    column. For US10Y going 4.00 to 4.20 that is `log(4.2/4.0)` = 0.0488, which
 *    reads as a 4.9% move and is nothing of the sort: the move is **+20 basis
 *    points**, and every sensitivity to it is per bp. A yield can also print
 *    zero or negative, where a log ratio is undefined. Same class as the lots
 *    defect this project already records.
 *
 * 2. **COLLINEAR FACTORS PRODUCE CONFIDENT NONSENSE.** US10Y and US02Y move
 *    together, SPX and NDX more so. Regressing on both splits one effect between
 *    two coefficients almost arbitrarily, and the betas swing wildly between
 *    samples while R² barely moves — so the fit looks fine and the attribution
 *    is fiction. The model reports variance inflation and REFUSES the beta
 *    rather than printing it.
 *
 * 3. **A DECOMPOSITION THAT DOES NOT SUM IS NOT A DECOMPOSITION.** Factor
 *    contributions plus idiosyncratic must account for the whole of portfolio
 *    variance, or the reader cannot tell a category from a bug — the same gap
 *    `mishel_claims.py` records closing for its own buckets.
 *
 * 4. **NO FORWARD FILL.** Crypto trades weekends and SPX does not. Carrying
 *    Friday's index forward invents two zero returns a week, which drags every
 *    correlation toward zero AND inflates the sample that the confidence
 *    intervals are computed from. The intersection is used and its size is
 *    reported.
 */

import { describe, expect, it } from "vitest";
import {
  FACTORS,
  factorById,
  transformSeries,
  alignFactors,
  regress,
  varianceInflation,
  factorModel,
  portfolioFactorRisk,
  MIN_FACTOR_SAMPLE,
  MAX_VIF,
  toDailyCloses,
} from "../src/risk/factors";
import type { ClosesSeries } from "../src/data/correlation";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** A series from an explicit list of closes, one per day. */
const series = (symbol: string, closes: readonly number[], startDay = 0): ClosesSeries => ({
  symbol,
  closes: closes.map((c, i) => ({ t: T0 + (i + startDay) * DAY, c })),
});

/** Deterministic normal-ish noise. */
function noise(n: number, seed = 1): number[] {
  let s = seed >>> 0;
  const r = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // Sum of twelve uniforms minus six: mean 0, variance 1, and reproducible.
  return Array.from({ length: n }, () => {
    let acc = 0;
    for (let k = 0; k < 12; k++) acc += r();
    return acc - 6;
  });
}

describe("a yield is not a price", () => {
  it("TRANSFORMS A YIELD AS A CHANGE IN BASIS POINTS, never a log ratio", () => {
    /* 4.00 -> 4.20 is +20bp. `log(4.2/4.0)` is 0.0488, which reads as a 4.9%
       move and is a different quantity entirely. */
    const out = transformSeries([4.0, 4.2], "yield");
    expect(out[0]).toBeCloseTo(20, 6);
  });

  it("survives a zero or negative yield, where a log ratio cannot", () => {
    const out = transformSeries([0.0, -0.1], "yield");
    expect(Number.isFinite(out[0] as number)).toBe(true);
    expect(out[0]).toBeCloseTo(-10, 6);
  });

  it("transforms a price as a log return", () => {
    const out = transformSeries([100, 110], "price");
    expect(out[0]).toBeCloseTo(Math.log(1.1), 10);
  });

  it("EVERY DECLARED FACTOR NAMES ITS UNIT, so none can default", () => {
    /* A unit that defaults is a wrong answer with no symptom. */
    expect(FACTORS.length).toBeGreaterThan(3);
    for (const f of FACTORS) {
      expect(f.kind, f.id).toMatch(/^(price|yield)$/);
      expect(f.unit.length, f.id + " has no stated unit").toBeGreaterThan(0);
      expect(factorById(f.id)?.symbol, f.id).toBe(f.symbol);
    }
  });
});

describe("daily sampling", () => {
  it("TAKES THE LAST CLOSE OF EACH UTC DAY", () => {
    const intraday: ClosesSeries = {
      symbol: "A",
      closes: [
        { t: T0 + 1 * 3_600_000, c: 10 },
        { t: T0 + 20 * 3_600_000, c: 12 },
        { t: T0 + DAY + 5 * 3_600_000, c: 13 },
      ],
    };
    const out = toDailyCloses(intraday);
    expect(out.closes).toHaveLength(2);
    expect(out.closes[0]?.c).toBe(12);
    expect(out.closes[1]?.c).toBe(13);
  });

  it("KEYS TO THE DAY, so two series sampled at different minutes still meet", () => {
    /* The failure this exists to prevent: a 1-minute series whose last bar is
       23:59 and a daily series stamped 00:00 share no timestamp at all, and the
       intersection silently becomes empty. */
    const a = toDailyCloses({ symbol: "A", closes: [{ t: T0 + DAY - 60_000, c: 10 }] });
    const b = toDailyCloses({ symbol: "B", closes: [{ t: T0 + 3_600_000, c: 20 }] });
    expect(a.closes[0]?.t).toBe(b.closes[0]?.t);
  });

  it("already-daily data passes through unchanged in length", () => {
    const daily = series("A", [1, 2, 3, 4, 5]);
    expect(toDailyCloses(daily).closes).toHaveLength(5);
  });
});

describe("alignment", () => {
  it("INTERSECTS RATHER THAN FILLING FORWARD, and says how much survived", () => {
    /* One series missing every other day. A fill would invent zero returns on
       the days it was carried, which read as a calm market. */
    const dense = series("A", Array.from({ length: 100 }, (_, i) => 100 + i));
    const sparse: ClosesSeries = {
      symbol: "B",
      closes: dense.closes.filter((_, i) => i % 2 === 0).map((p) => ({ t: p.t, c: 50 })),
    };
    const m = alignFactors([dense, sparse], [
      { id: "a", symbol: "A", label: "A", kind: "price", unit: "log return" },
      { id: "b", symbol: "B", label: "B", kind: "price", unit: "log return" },
    ]);
    expect(m.rows.length).toBeLessThan(55);
    expect(m.dropped.notShared).toBeGreaterThan(40);
  });

  it("reports the window it actually used", () => {
    const a = series("A", Array.from({ length: 80 }, (_, i) => 100 + i));
    const m = alignFactors([a], [{ id: "a", symbol: "A", label: "A", kind: "price", unit: "log return" }]);
    expect(m.from).toBeLessThan(m.to);
    expect(m.rows).toHaveLength(79);
  });
});

describe("multivariate regression", () => {
  it("RECOVERS KNOWN BETAS on data built from them", () => {
    /* The only honest way to test a solver: construct y from known
       coefficients and require them back. */
    const n = 400;
    const f1 = noise(n, 3);
    const f2 = noise(n, 9);
    const eps = noise(n, 21).map((e) => e * 0.1);
    const y = f1.map((v, i) => 0.7 * v - 0.4 * (f2[i] as number) + (eps[i] as number));
    const got = regress(y, [f1, f2]);
    expect(got.betas[0]).toBeCloseTo(0.7, 1);
    expect(got.betas[1]).toBeCloseTo(-0.4, 1);
    expect(got.r2).toBeGreaterThan(0.9);
  });

  it("reports a residual volatility that is the SCALE of what it missed", () => {
    const n = 400;
    const f1 = noise(n, 3);
    const y = f1.map((v, i) => 1.0 * v + (noise(n, 7)[i] as number) * 0.5);
    const got = regress(y, [f1]);
    expect(got.residVol).toBeGreaterThan(0.3);
    expect(got.residVol).toBeLessThan(0.8);
  });

  it("REFUSES rather than inverting a singular system", () => {
    /* Two identical factors: there is no unique answer, and a solver that
       returns one is choosing arbitrarily between infinitely many. */
    const n = 200;
    const f = noise(n, 5);
    const got = regress(f.map((v) => v * 2), [f, f.slice()]);
    expect(got.ok).toBe(false);
    expect(got.why ?? "").toMatch(/singular|collinear|cannot/i);
  });
});

describe("collinearity is refused, not averaged over", () => {
  it("FLAGS A FACTOR THAT IS NEARLY A COMBINATION OF THE OTHERS", () => {
    const n = 300;
    const f1 = noise(n, 3);
    const f2 = noise(n, 11);
    // f3 is f1 plus a whisker: the classic 10y/2y pair.
    const f3 = f1.map((v, i) => v + 0.02 * (noise(n, 31)[i] as number));
    const v = varianceInflation([f1, f2, f3]);
    expect(v[1], "the independent factor should be fine").toBeLessThan(MAX_VIF);
    expect(Math.max(v[0] as number, v[2] as number)).toBeGreaterThan(MAX_VIF);
  });

  it("THE MODEL WITHHOLDS THE UNSTABLE BETA, not just the VIF number", () => {
    /* MY FIRST VERSION OF THIS FILE TESTED `varianceInflation` ALONE. Deleting
       the refusal inside `factorModel` — the line that turns a high VIF into a
       withheld coefficient — left all nineteen tests green. Measuring the
       problem is not the same as acting on it, and the test has to pin the
       action or the action can be deleted. */
    const n = 300;
    const f1 = noise(n, 3);
    const f2 = noise(n, 11);
    const f3 = f1.map((v, i) => v + 0.02 * (noise(n, 31)[i] as number));
    const factors = { ids: ["a", "b", "c"], rows: f1.map((v, i) => [v, f2[i] as number, f3[i] as number]) };
    const y = f1.map((v, i) => v + 0.5 * (f2[i] as number) + (noise(n, 77)[i] as number) * 0.2);

    const m = factorModel("TEST", y, factors);
    expect(m.unstable.length, "the collinear pair was not detected").toBeGreaterThan(0);
    for (const id of m.unstable) {
      expect(Number.isNaN(m.betas[id] as number), id + " printed a beta it cannot support").toBe(true);
    }
    expect(m.caveat ?? "").toMatch(/too closely|collinear|own coefficient/i);
    expect(Number.isNaN(m.betas["b"] as number), "the independent factor must survive").toBe(false);
  });

  it("an independent set has a VIF near one", () => {
    const v = varianceInflation([noise(300, 3), noise(300, 9), noise(300, 15)]);
    for (const x of v) expect(x).toBeLessThan(2);
  });
});

describe("the per-asset model", () => {
  const n = 300;
  const fSpx = noise(n, 3);
  const fDxy = noise(n, 9);
  const factors = { ids: ["spx", "dxy"], rows: fSpx.map((v, i) => [v, fDxy[i] as number]) };

  it("names the sample and every beta it fitted", () => {
    const y = fSpx.map((v, i) => 1.2 * v - 0.5 * (fDxy[i] as number) + (noise(n, 44)[i] as number) * 0.2);
    const m = factorModel("TEST", y, factors);
    expect(m.sample).toBe(n);
    expect(m.betas["spx"]).toBeCloseTo(1.2, 1);
    expect(m.betas["dxy"]).toBeCloseTo(-0.5, 1);
    expect(m.caveat).toBeNull();
  });

  it("REFUSES A THIN SAMPLE rather than fitting it", () => {
    const short = { ids: ["spx"], rows: fSpx.slice(0, 10).map((v) => [v]) };
    const m = factorModel("TEST", fSpx.slice(0, 10), short);
    expect(m.caveat, "a ten-point fit must say so").toBeTruthy();
    expect(m.sample).toBeLessThan(MIN_FACTOR_SAMPLE);
  });

  it("says when the factors explain almost nothing", () => {
    /* An asset the factor set does not describe is the COMMON case, and a beta
       printed without that warning is the most misleading number here. */
    const y = noise(n, 99);
    const m = factorModel("TEST", y, factors);
    expect(m.r2).toBeLessThan(0.2);
    expect(m.caveat ?? "").toMatch(/explain|little|weak|idiosyncratic/i);
  });
});

describe("portfolio decomposition", () => {
  const n = 300;
  const fA = noise(n, 3);
  const fB = noise(n, 9);
  const factors = { ids: ["a", "b"], rows: fA.map((v, i) => [v, fB[i] as number]) };

  const book = (): Parameters<typeof portfolioFactorRisk>[0] => [
    { symbol: "X", signedNotional: 10_000 },
    { symbol: "Y", signedNotional: -4_000 },
  ];

  const models = (): ReturnType<typeof factorModel>[] => [
    factorModel("X", fA.map((v, i) => 1.0 * v + 0.3 * (fB[i] as number) + (noise(n, 5)[i] as number) * 0.2), factors),
    factorModel("Y", fA.map((v, i) => 0.4 * v - 0.8 * (fB[i] as number) + (noise(n, 8)[i] as number) * 0.2), factors),
  ];

  it("THE PARTS SUM TO THE WHOLE, or a reader cannot tell a class from a bug", () => {
    const r = portfolioFactorRisk(book(), models(), factors);
    const parts = r.byFactor.reduce((s, f) => s + f.variance, 0) + r.idiosyncraticVariance;
    expect(parts).toBeCloseTo(r.totalVariance, 6);
  });

  it("reports each factor's SHARE, and the shares sum to one", () => {
    const r = portfolioFactorRisk(book(), models(), factors);
    const shares = r.byFactor.reduce((s, f) => s + f.share, 0) + r.idiosyncraticShare;
    expect(shares).toBeCloseTo(1, 6);
  });

  it("A HEDGED BOOK CARRIES LESS FACTOR RISK THAN AN UNHEDGED ONE", () => {
    /* The property the whole panel exists to show. Both legs load positively on
       factor A; shorting the second must reduce the A exposure. */
    const long = portfolioFactorRisk(
      [{ symbol: "X", signedNotional: 10_000 }, { symbol: "Y", signedNotional: 4_000 }],
      models(),
      factors,
    );
    const hedged = portfolioFactorRisk(book(), models(), factors);
    const a = (r: typeof long): number =>
      Math.abs(r.byFactor.find((f) => f.id === "a")?.exposure ?? 0);
    expect(a(hedged)).toBeLessThan(a(long));
  });

  it("names a position it could not model instead of treating it as flat", () => {
    /* Silently scoring an unmodelled position as zero risk is the most
       flattering possible error. */
    const r = portfolioFactorRisk(
      [...book(), { symbol: "GHOST", signedNotional: 50_000 }],
      models(),
      factors,
    );
    expect(r.unmodelled).toContain("GHOST");
  });

  it("refuses a total when a material share of the book is unmodelled", () => {
    const r = portfolioFactorRisk(
      [{ symbol: "GHOST", signedNotional: 90_000 }, { symbol: "X", signedNotional: 1_000 }],
      models(),
      factors,
    );
    expect(r.caveat ?? "").toMatch(/unmodelled|not modelled|cannot/i);
  });
});
