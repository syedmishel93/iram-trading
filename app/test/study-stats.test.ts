/**
 * The statistics the report rests on, and the two findings computed locally.
 *
 * THE SIGN CONVENTION IS THE MOST IMPORTANT THING TESTED HERE. A lag profile
 * with the sign inverted still produces a chart, still has a biggest bar, and
 * reports that bitcoin leads the dollar rather than the other way round. There
 * is no type that catches it and no symptom on screen.
 */

import { describe, expect, it } from "vitest";
import {
  bartlettBand,
  deflatedSharpe,
  expectedMaxNormal,
  normCdf,
  pearsonAt,
  probit,
  twoSidedP,
} from "../src/study/stats";
import { baseRates, lagProfile, leadLagSentence, MIN_CELL } from "../src/study/findings";
import type { PanelRow } from "../src/data/panel";
import type { Regime } from "../src/backtest/regime";

describe("normCdf and probit", () => {
  it("agrees with the values everybody knows", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959_964)).toBeCloseTo(0.975, 5);
    expect(normCdf(-1.959_964)).toBeCloseTo(0.025, 5);
    expect(normCdf(2.326_348)).toBeCloseTo(0.99, 5);
  });

  it("inverts itself", () => {
    expect(probit(0.975)).toBeCloseTo(1.959_964, 4);
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(probit(0.025)).toBeCloseTo(-1.959_964, 4);
  });

  it("turns a z into the two-sided p everybody quotes", () => {
    expect(twoSidedP(1.959_964)).toBeCloseTo(0.05, 4);
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
  });
});

describe("bartlettBand", () => {
  it("is 1.96 over the root of the sample size", () => {
    /* 10,000 pairs: 1.96 / 100. */
    expect(bartlettBand(10_000)).toBeCloseTo(0.0196, 6);
    expect(bartlettBand(400)).toBeCloseTo(0.098, 6);
  });

  it("refuses to draw a band on nothing", () => {
    expect(bartlettBand(1)).toBe(Infinity);
    expect(bartlettBand(0)).toBe(Infinity);
  });
});

describe("expectedMaxNormal", () => {
  it("is zero for a single try", () => {
    expect(expectedMaxNormal(1)).toBe(0);
  });

  it("puts the best of four hundred tries about three sigma above zero", () => {
    /* Textbook territory: the expected maximum of 400 standard normals sits a
       little under three. If this ever reads near zero, the deflation has
       stopped happening and every headline in the product is overstated. */
    const e = expectedMaxNormal(400);
    expect(e).toBeGreaterThan(2.7);
    expect(e).toBeLessThan(3.3);
  });

  it("grows with the number of tries", () => {
    expect(expectedMaxNormal(1_000)).toBeGreaterThan(expectedMaxNormal(100));
    expect(expectedMaxNormal(100)).toBeGreaterThan(expectedMaxNormal(10));
  });
});

describe("deflatedSharpe", () => {
  /* Sharpe 1.84 over 120 out-of-sample trades, best of 480 tries.
     se = sqrt((1 + 1.84²/2) / 120) = sqrt(2.6928 / 120) = 0.1498. */
  const d = deflatedSharpe(1.84, 480, 120);

  it("uses the standard error of a Sharpe, not of a normal draw", () => {
    expect(d.standardError).toBeCloseTo(0.1498, 4);
  });

  it("charges a hurdle for having been the best of many", () => {
    expect(d.hurdle).toBeGreaterThan(0.3);
    expect(d.deflated).toBeCloseTo(1.84 - d.hurdle, 10);
    expect(d.deflated).toBeLessThan(d.observed);
  });

  it("charges nothing for a single try", () => {
    const one = deflatedSharpe(1.84, 1, 120);
    expect(one.hurdle).toBe(0);
    expect(one.deflated).toBe(1.84);
  });

  it("hurts a small sample more than a large one", () => {
    const thin = deflatedSharpe(1.84, 480, 40);
    const thick = deflatedSharpe(1.84, 480, 4_000);
    expect(thin.deflated).toBeLessThan(thick.deflated);
  });

  it("says in the working that the tries are not independent", () => {
    expect(d.working).toContain("not");
    expect(d.working).toContain("480");
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

/** A deterministic wobble, so the profile is reproducible without a seed API. */
function wave(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(Math.sin(i * 0.7) + 0.4 * Math.sin(i * 2.3) + 0.2 * Math.cos(i * 5.1));
  }
  return out;
}

describe("pearsonAt", () => {
  it("reads y LATER than x at a positive lag", () => {
    const x = wave(500);
    /* subject[i] = driver[i - 3]: the driver moved three bars earlier. */
    const y = x.map((_, i) => x[i - 3] ?? 0);
    expect(pearsonAt(x, y, 3).r).toBeCloseTo(1, 6);
    expect(Math.abs(pearsonAt(x, y, -3).r)).toBeLessThan(0.9);
  });

  it("shortens the sample at the edges rather than wrapping", () => {
    const x = wave(100);
    expect(pearsonAt(x, x, 0).n).toBe(100);
    expect(pearsonAt(x, x, 10).n).toBe(90);
    expect(pearsonAt(x, x, -10).n).toBe(90);
  });
});

describe("lagProfile", () => {
  const driver = wave(2_000);
  const subject = driver.map((_, i) => driver[i - 7] ?? 0);
  const p = lagProfile("DXY", "Dollar index", driver, subject, 48);

  it("finds the lead at the lag it was planted at, on the driver's side", () => {
    expect(p.best?.lag).toBe(7);
  });

  it("reports the direction as a sentence rather than a signed number", () => {
    const s = leadLagSentence(p, "BTCUSDT");
    expect(s).toContain("Dollar index leads BTCUSDT by 7 bars");
  });

  it("sets the band from the SHORTEST overlap on the profile", () => {
    /* 2,000 rows, ±48 lags: the extreme lags rest on 1,952 pairs, so the band
       is 1.96 / sqrt(1952) = 0.04436 — wider than 1.96 / sqrt(2000). */
    expect(p.band).toBeCloseTo(0.044_36, 4);
  });

  it("says nothing cleared the band when nothing did", () => {
    const a = wave(600);
    const b = a.map((_, i) => Math.cos(i * 1.37) + 0.9 * Math.sin(i * 3.11));
    const flat = lagProfile("X", "X", a, b, 4);
    if (flat.clears.length === 0) {
      expect(leadLagSentence(flat, "BTCUSDT")).toBeNull();
    } else {
      /* Deterministic series can share a harmonic; the contract being tested
         is only that a cleared profile produces a sentence and an uncleared
         one produces null. */
      expect(leadLagSentence(flat, "BTCUSDT")).not.toBeNull();
    }
  });
});

describe("baseRates", () => {
  function rows(n: number, y: (i: number) => number): PanelRow[] {
    return Array.from({ length: n }, (_, i) => ({
      t: i * 3_600_000,
      r: 0,
      x: [],
      y: y(i),
      carried: false,
    }));
  }

  it("withholds a cell below the floor instead of reporting it", () => {
    const n = MIN_CELL - 2;
    const table = baseRates(rows(n + 100, (i) => (i % 2 === 0 ? 0.01 : -0.01)), [
      ...Array.from({ length: n }, () => "volatile" as Regime),
      ...Array.from({ length: 100 }, () => "trend" as Regime),
    ], 24);
    const thin = table.cells.find((c) => c.key === "volatile");
    expect(thin?.n).toBe(n);
    expect(thin?.withheld).toContain(`below the ${MIN_CELL}`);
    expect(Number.isNaN(thin?.up ?? 0)).toBe(true);
  });

  it("reports a cell at or above the floor", () => {
    const table = baseRates(rows(200, (i) => (i % 4 === 0 ? -0.02 : 0.01)), Array.from({ length: 200 }, () => "trend" as Regime), 24);
    const trend = table.cells.find((c) => c.key === "trend");
    expect(trend?.withheld).toBeNull();
    /* Three of every four rows are positive. */
    expect(trend?.up).toBeCloseTo(0.75, 6);
  });

  it("puts unlabelled rows in their own cell rather than the pooled figure twice", () => {
    const table = baseRates(rows(120, () => 0.01), [
      ...Array.from({ length: 60 }, () => "trend" as Regime),
      ...Array.from({ length: 60 }, () => null),
    ], 24);
    expect(table.pooled.n).toBe(120);
    const sum = table.cells.reduce((a, c) => a + c.n, 0);
    expect(sum).toBe(120);
    expect(table.cells.some((c) => c.key === "unclassified")).toBe(true);
  });

  it("skips rows whose label has not resolved", () => {
    const table = baseRates(rows(100, (i) => (i < 90 ? 0.01 : NaN)), Array.from({ length: 100 }, () => "trend" as Regime), 24);
    expect(table.pooled.n).toBe(90);
  });
});
