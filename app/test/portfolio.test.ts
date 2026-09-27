import { describe, it, expect } from "vitest";
import {
  alignSeries,
  exposures,
  bookPnl,
  tailRisk,
  contributions,
  effectiveContributors,
  diversification,
  factorExposures,
  stress,
  liquidity,
  analysePortfolio,
  MIN_HISTORY,
  WEAK_FIT,
  SCENARIOS,
  type Scenario,
} from "../src/risk/portfolio";
import type { Position } from "../src/risk/sizing";
import type { ClosesSeries } from "../src/data/correlation";

/* A deterministic pseudo-random walk. Seeded so a failure is reproducible —
   a risk test that fails one run in twenty teaches nobody anything. */
function walk(seed: number, n: number, drift = 0, vol = 0.02): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const u = s / 0xffffffff;
    out.push(drift + (u - 0.5) * 2 * vol);
  }
  return out;
}

function series(symbol: string, rets: readonly number[], t0 = 0, step = 86_400_000): ClosesSeries {
  let px = 100;
  const closes = [{ t: t0, c: px }];
  rets.forEach((r, i) => {
    px = px * Math.exp(r);
    closes.push({ t: t0 + (i + 1) * step, c: px });
  });
  return { symbol, closes };
}

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: "AAA",
  direction: "long",
  qty: 1,
  entry: 100,
  stop: 90,
  ...over,
});

describe("alignSeries", () => {
  it("joins on shared timestamps and drops bars that are not in every series", () => {
    const a: ClosesSeries = { symbol: "A", closes: [{ t: 1, c: 10 }, { t: 2, c: 11 }, { t: 3, c: 12 }] };
    const b: ClosesSeries = { symbol: "B", closes: [{ t: 1, c: 20 }, { t: 3, c: 22 }] };
    const m = alignSeries([a, b]);
    /* t=2 exists only in A, so the join keeps t=1 and t=3 — one return row. */
    expect(m.times).toEqual([3]);
    expect(m.rows).toHaveLength(1);
    expect(m.symbols).toEqual(["A", "B"]);
  });

  it("does not manufacture a return across a gap in the other series", () => {
    /* If it differenced before joining, A would contribute log(12/11) here.
       Joining first means A's return spans t=1..t=3 like B's does. */
    const a: ClosesSeries = { symbol: "A", closes: [{ t: 1, c: 10 }, { t: 2, c: 11 }, { t: 3, c: 12 }] };
    const b: ClosesSeries = { symbol: "B", closes: [{ t: 1, c: 20 }, { t: 3, c: 22 }] };
    const m = alignSeries([a, b]);
    expect(m.rows[0]?.[0]).toBeCloseTo(Math.log(12 / 10), 12);
  });

  it("ignores non-positive and non-finite closes rather than producing NaN rows", () => {
    const a: ClosesSeries = { symbol: "A", closes: [{ t: 1, c: 10 }, { t: 2, c: 0 }, { t: 3, c: 12 }] };
    const b: ClosesSeries = { symbol: "B", closes: [{ t: 1, c: 20 }, { t: 2, c: 21 }, { t: 3, c: 22 }] };
    const m = alignSeries([a, b]);
    expect(m.rows.every((r) => r.every((x) => Number.isFinite(x)))).toBe(true);
  });

  it("returns an empty matrix for no series at all", () => {
    expect(alignSeries([])).toEqual({ symbols: [], times: [], rows: [] });
  });
});

describe("exposures", () => {
  it("signs a short negative", () => {
    const e = exposures([pos({ direction: "short", qty: 2, entry: 50 })]);
    expect(e[0]?.signedNotional).toBe(-100);
  });

  it("nets a symbol held both ways to zero rather than showing two risky lines", () => {
    const e = exposures([
      pos({ symbol: "X", direction: "long", qty: 1, entry: 100 }),
      pos({ symbol: "X", direction: "short", qty: 1, entry: 100 }),
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]?.signedNotional).toBe(0);
  });

  it("applies contract size", () => {
    const e = exposures([pos({ qty: 2, entry: 10, contractSize: 5 })]);
    expect(e[0]?.signedNotional).toBe(100);
  });
});

describe("tailRisk", () => {
  it("refuses below the history floor rather than returning a confident small number", () => {
    expect(tailRisk(walk(1, MIN_HISTORY - 1), 0.95)).toBeNull();
  });

  it("reports losses as positive numbers", () => {
    const pnl = Array.from({ length: 100 }, (_, i) => -i);
    const t = tailRisk(pnl, 0.95);
    expect(t).not.toBeNull();
    expect(t?.var).toBeGreaterThan(0);
    expect(t?.worst).toBe(99);
  });

  it("expected shortfall is never smaller than VaR", () => {
    const t = tailRisk(walk(7, 500, 0, 0.05), 0.95);
    expect(t).not.toBeNull();
    expect((t as { cvar: number }).cvar).toBeGreaterThanOrEqual((t as { var: number }).var);
  });

  it("clamps to zero when even the tail was profitable, instead of a negative loss", () => {
    const t = tailRisk(Array.from({ length: 100 }, () => 5), 0.95);
    expect(t?.var).toBe(0);
    expect(t?.cvar).toBe(0);
  });

  it("takes the observed quantile rather than interpolating between two bars", () => {
    /* 100 observations, 5% tail = 5 rows: −100..−96. The cut is the 5th worst. */
    const pnl = Array.from({ length: 100 }, (_, i) => -(100 - i));
    const t = tailRisk(pnl, 0.95);
    expect(t?.var).toBe(96);
    expect(t?.tailRows).toHaveLength(5);
  });
});

describe("contributions", () => {
  it("sum exactly to the portfolio expected shortfall", () => {
    const s = [series("A", walk(11, 200)), series("B", walk(22, 200)), series("C", walk(33, 200))];
    const m = alignSeries(s);
    const exp = exposures([
      pos({ symbol: "A", qty: 10, entry: 100 }),
      pos({ symbol: "B", qty: 5, entry: 100 }),
      pos({ symbol: "C", direction: "short", qty: 3, entry: 100 }),
    ]);
    const t = tailRisk(bookPnl(m, exp), 0.95);
    expect(t).not.toBeNull();
    const c = contributions(m, exp, t as NonNullable<typeof t>);
    const total = c.reduce((sum, x) => sum + x.cvarShare, 0);
    /* Exact to floating point: this is linearity of expectation, not an
       approximation, and the moment it stops holding the decomposition is
       lying about where the risk sits. */
    expect(total).toBeCloseTo((t as { cvar: number }).cvar, 9);
  });

  it("marks a position that profited on the worst days as a negative contribution", () => {
    /* B is exactly A inverted, so a long A / long B book has one leg making
       money on every bar the other loses. */
    const ra = walk(5, 200);
    const rb = ra.map((r) => -r);
    const m = alignSeries([series("A", ra), series("B", rb)]);
    const exp = exposures([
      pos({ symbol: "A", qty: 20, entry: 100 }),
      pos({ symbol: "B", qty: 5, entry: 100 }),
    ]);
    const t = tailRisk(bookPnl(m, exp), 0.95) as NonNullable<ReturnType<typeof tailRisk>>;
    const c = contributions(m, exp, t);
    const b = c.find((x) => x.symbol === "B");
    expect(b?.cvarShare).toBeLessThan(0);
  });

  it("returns nothing when the tail has no rows", () => {
    const m = alignSeries([series("A", walk(1, 100))]);
    const exp = exposures([pos({ symbol: "A" })]);
    expect(contributions(m, exp, { level: 0.95, var: 0, cvar: 0, worst: 0, sample: 0, tailRows: [] })).toEqual([]);
  });
});

describe("effectiveContributors", () => {
  const c = (symbol: string, cvarShare: number) => ({ symbol, cvarShare, fraction: 0, signedNotional: 0 });

  it("equals the count when contributions are equal", () => {
    expect(effectiveContributors([c("A", 10), c("B", 10), c("C", 10), c("D", 10)])).toBeCloseTo(4, 9);
  });

  it("collapses towards one when a single name carries the risk", () => {
    expect(effectiveContributors([c("A", 97), c("B", 1), c("C", 1), c("D", 1)])).toBeLessThan(1.1);
  });

  it("excludes hedges rather than letting a negative square inflate the count", () => {
    const withHedge = effectiveContributors([c("A", 10), c("B", 10), c("H", -8)]);
    const without = effectiveContributors([c("A", 10), c("B", 10)]);
    expect(withHedge).toBeCloseTo(without, 9);
  });

  it("is zero when nothing contributes risk", () => {
    expect(effectiveContributors([])).toBe(0);
    expect(effectiveContributors([c("A", -5)])).toBe(0);
  });

  /* The property that forced this function to be renamed. It is a measure of
     CONCENTRATION, and concentration is blind to correlation: four positions
     in one instrument wearing four names each contribute a quarter. */
  it("does NOT fall when the positions are perfectly correlated", () => {
    expect(effectiveContributors([c("A", 10), c("B", 10), c("C", 10), c("D", 10)])).toBeCloseTo(4, 9);
  });
});

describe("diversification", () => {
  const legs = (syms: readonly string[], rets: readonly (readonly number[])[]) =>
    alignSeries(syms.map((sym, i) => series(sym, rets[i] as number[])));

  it("reports one effective bet for identical instruments, whatever the count", () => {
    const r = walk(101, 300);
    const syms = ["A", "B", "C", "D"];
    const m = legs(syms, syms.map(() => r));
    const exp = exposures(syms.map((s) => pos({ symbol: s, qty: 10, entry: 100 })));
    const d = diversification(m, exp);
    expect(d.effectiveBets).toBeCloseTo(1, 6);
    expect(d.note).toContain("moving as roughly one");
  });

  it("approaches the position count when the legs are unrelated", () => {
    const syms = ["A", "B", "C", "D"];
    const m = legs(syms, [walk(1, 4000), walk(2, 4000), walk(3, 4000), walk(4, 4000)]);
    const exp = exposures(syms.map((s) => pos({ symbol: s, qty: 10, entry: 100 })));
    const d = diversification(m, exp);
    /* Four independent equal legs give ratio √4 = 2, so bets = 4. Sampling
       noise on 4000 bars keeps it inside a tenth. */
    expect(d.effectiveBets).toBeGreaterThan(3.6);
    expect(d.effectiveBets).toBeLessThan(4.4);
  });

  it("distrusts a book whose legs cancelled, rather than calling it well hedged", () => {
    const r = walk(55, 300);
    const m = legs(["A", "B"], [r, r.map((x) => -x)]);
    const exp = exposures([
      pos({ symbol: "A", qty: 10, entry: 100 }),
      pos({ symbol: "B", qty: 10, entry: 100 }),
    ]);
    const d = diversification(m, exp);
    expect(d.effectiveBets).toBeGreaterThan(exp.length * 1.5);
    expect(d.note).toContain("first thing to break");
  });

  it("says nothing moved rather than dividing by zero", () => {
    const flat = new Array(200).fill(0) as number[];
    const m = legs(["A", "B"], [flat, flat]);
    const exp = exposures([pos({ symbol: "A" }), pos({ symbol: "B" })]);
    expect(diversification(m, exp).note).toContain("Nothing in the book moved");
  });
});

describe("factorExposures", () => {
  it("gives the factor a beta of exactly one against itself", () => {
    const m = alignSeries([series("BTC", walk(3, 200)), series("ALT", walk(4, 200))]);
    const f = factorExposures(m, "BTC").find((x) => x.symbol === "BTC");
    expect(f?.beta).toBeCloseTo(1, 12);
    expect(f?.r2).toBeCloseTo(1, 12);
    /* And no caveat, because "BTC does not explain BTC" would be absurd. */
    expect(f?.caveat).toBeNull();
  });

  it("recovers a known beta from a constructed series", () => {
    const rf = walk(9, 300, 0, 0.03);
    const ra = rf.map((r) => 1.5 * r);
    const m = alignSeries([series("F", rf), series("A", ra)]);
    const a = factorExposures(m, "F").find((x) => x.symbol === "A");
    expect(a?.beta).toBeCloseTo(1.5, 6);
    expect(a?.r2).toBeCloseTo(1, 6);
  });

  it("flags a beta the factor barely explains, and names the number", () => {
    const rf = walk(9, 300, 0, 0.03);
    const ra = walk(77, 300, 0, 0.03); /* independent */
    const m = alignSeries([series("F", rf), series("A", ra)]);
    const a = factorExposures(m, "F").find((x) => x.symbol === "A");
    expect(a?.r2).toBeLessThan(WEAK_FIT);
    expect(a?.caveat).toContain("do not hedge on it");
  });

  it("refuses rather than fitting when the shared history is too short", () => {
    const n = MIN_HISTORY - 5;
    const m = alignSeries([series("F", walk(1, n)), series("A", walk(2, n))]);
    const a = factorExposures(m, "F").find((x) => x.symbol === "A");
    expect(Number.isNaN(a?.beta as number)).toBe(true);
    expect(a?.caveat).toContain(String(MIN_HISTORY));
  });

  it("says so when the factor never moved, instead of dividing by zero", () => {
    const flat = new Array(200).fill(0) as number[];
    const m = alignSeries([series("F", flat), series("A", walk(2, 200))]);
    const a = factorExposures(m, "F").find((x) => x.symbol === "A");
    expect(a?.caveat).toContain("did not move");
  });

  it("returns nothing when the factor is not in the matrix at all", () => {
    const m = alignSeries([series("A", walk(1, 200))]);
    expect(factorExposures(m, "NOPE")).toEqual([]);
  });
});

describe("stress", () => {
  const scen: Scenario = { id: "t", label: "t", factorMove: -0.5, note: "" };

  it("loses money on a long book in a down scenario", () => {
    const betas = [{ symbol: "A", beta: 1, r2: 0.9, idioVol: 0.01, sample: 200, caveat: null }];
    const r = stress(scen, [{ symbol: "A", signedNotional: 10_000 }], betas, 100_000);
    expect(r.pnl).toBeCloseTo(-5000, 9);
    expect(r.pctOfEquity).toBeCloseTo(-5, 9);
  });

  it("makes money on a short book in the same scenario", () => {
    const betas = [{ symbol: "A", beta: 1, r2: 0.9, idioVol: 0.01, sample: 200, caveat: null }];
    const r = stress(scen, [{ symbol: "A", signedNotional: -10_000 }], betas, 100_000);
    expect(r.pnl).toBeCloseTo(5000, 9);
  });

  it("names the symbols whose beta was not fit, and leaves them out of the total", () => {
    const r = stress(scen, [{ symbol: "A", signedNotional: 10_000 }], [], 100_000);
    expect(r.unreliable).toEqual(["A"]);
    expect(r.pnl).toBe(0);
  });

  it("names a symbol whose beta was fit but barely explains anything", () => {
    const betas = [{ symbol: "A", beta: 2, r2: 0.05, idioVol: 0.01, sample: 200, caveat: "weak" }];
    const r = stress(scen, [{ symbol: "A", signedNotional: 10_000 }], betas, 100_000);
    expect(r.unreliable).toEqual(["A"]);
    /* Still counted — excluding it would understate, and understating risk is
       the failure mode this whole module exists to avoid. */
    expect(r.pnl).toBeCloseTo(-10_000, 9);
  });

  it("ships an upside scenario, because a short book fails upward", () => {
    expect(SCENARIOS.some((s) => s.factorMove > 0)).toBe(true);
  });

  it("every shipped scenario states what it was", () => {
    for (const s of SCENARIOS) expect(s.note.length).toBeGreaterThan(20);
  });
});

describe("liquidity", () => {
  it("reports unknown rather than fast when there is no volume history", () => {
    const [r] = liquidity([{ symbol: "A", signedNotional: 1000 }], new Map());
    expect(r?.days).toBe(Infinity);
    expect(r?.note).toContain("unknown rather than fast");
  });

  it("scales days-to-exit with the participation cap", () => {
    const adv = new Map([["A", 1_000_000]]);
    const [tight] = liquidity([{ symbol: "A", signedNotional: 1_000_000 }], adv, 0.1);
    const [loose] = liquidity([{ symbol: "A", signedNotional: 1_000_000 }], adv, 0.5);
    expect(tight?.days).toBeCloseTo(10, 9);
    expect(loose?.days).toBeCloseTo(2, 9);
  });

  it("uses absolute notional, so a short is as hard to exit as a long", () => {
    const adv = new Map([["A", 1000]]);
    const [s] = liquidity([{ symbol: "A", signedNotional: -1000 }], adv, 0.2);
    expect(s?.days).toBeCloseTo(5, 9);
  });
});

describe("analysePortfolio", () => {
  const book: Position[] = [
    pos({ symbol: "AAA", qty: 100, entry: 100 }),
    pos({ symbol: "BBB", qty: 50, entry: 100 }),
  ];

  it("blocks with a reason when there are no positions", () => {
    const r = analysePortfolio({ positions: [], equity: 10_000, series: [], factorSymbol: "BTC" });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("No open positions");
  });

  it("blocks and names the symbols when nothing has stored history", () => {
    const r = analysePortfolio({ positions: book, equity: 10_000, series: [], factorSymbol: "BTC" });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("AAA");
    expect(r.blocked).toContain("BBB");
  });

  it("blames the OVERLAP, not the longest series, when history is short", () => {
    const r = analysePortfolio({
      positions: book,
      equity: 10_000,
      series: [series("AAA", walk(1, 500)), series("BBB", walk(2, 20))],
      factorSymbol: "AAA",
    });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("shared by every symbol");
  });

  it("computes a full report and reports both tail levels", () => {
    const r = analysePortfolio({
      positions: book,
      equity: 100_000,
      series: [series("AAA", walk(1, 400)), series("BBB", walk(2, 400))],
      factorSymbol: "AAA",
    });
    expect(r.ok).toBe(true);
    expect(r.tails.map((t) => t.level)).toEqual([0.95, 0.99]);
    expect(r.sample).toBeGreaterThanOrEqual(MIN_HISTORY);
    expect(r.gross).toBeCloseTo(15_000, 9);
    expect(r.net).toBeCloseTo(15_000, 9);
  });

  it("warns that an excluded symbol makes the book riskier than shown", () => {
    const r = analysePortfolio({
      positions: [...book, pos({ symbol: "CCC", qty: 10, entry: 100 })],
      equity: 100_000,
      series: [series("AAA", walk(1, 400)), series("BBB", walk(2, 400))],
      factorSymbol: "AAA",
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("CCC");
    expect(r.warnings.join(" ")).toContain("riskier than what is shown");
  });

  it("warns when many positions behave like few independent ones", () => {
    /* Four names that are all the same series: four positions, one bet. */
    const rets = walk(42, 400);
    const syms = ["AAA", "BBB", "CCC", "DDD"];
    const r = analysePortfolio({
      positions: syms.map((s) => pos({ symbol: s, qty: 10, entry: 100 })),
      equity: 100_000,
      series: syms.map((s) => series(s, rets)),
      factorSymbol: "AAA",
    });
    /* Four names, one series: four risk CONTRIBUTORS, but one bet. Both
       numbers are correct and they answer different questions. */
    expect(r.effectiveContributors).toBeCloseTo(4, 6);
    expect(r.diversification.effectiveBets).toBeCloseTo(1, 6);
    expect(r.warnings.join(" ")).toContain("independent ones");
  });

  it("nets a flat symbol out of gross exposure", () => {
    const r = analysePortfolio({
      positions: [
        pos({ symbol: "AAA", direction: "long", qty: 10, entry: 100 }),
        pos({ symbol: "AAA", direction: "short", qty: 10, entry: 100 }),
      ],
      equity: 100_000,
      series: [series("AAA", walk(1, 400))],
      factorSymbol: "AAA",
    });
    expect(r.gross).toBe(0);
    expect(r.net).toBe(0);
  });
});

describe("a data gap must never read as a correlation finding", () => {
  /* The regression, found by running the panel rather than by reading it. A
     two-position book where the second symbol had no stored bars reported
     "2 positions behaving like 1.0 independent ones" — which is a claim about
     how they move, made about a leg that was never looked at. */
  const oneMeasured = () =>
    analysePortfolio({
      positions: [
        pos({ symbol: "AAA", qty: 10, entry: 100 }),
        pos({ symbol: "ZZZ", qty: 10, entry: 100 }),
      ],
      equity: 100_000,
      series: [series("AAA", walk(3, 400))],
      factorSymbol: "AAA",
    });

  it("counts only the legs it could measure", () => {
    expect(oneMeasured().diversification.measured).toBe(1);
  });

  it("says there was nothing to be correlated with, rather than reporting one bet", () => {
    expect(oneMeasured().diversification.note).toContain("nothing here to be correlated with");
  });

  it("does not warn about positions moving together when only one was measured", () => {
    expect(oneMeasured().warnings.join(" ")).not.toContain("independent ones");
  });

  it("still names the excluded symbol", () => {
    const r = oneMeasured();
    expect(r.missing).toEqual(["ZZZ"]);
    expect(r.warnings.join(" ")).toContain("ZZZ");
  });

  it("does warn once two legs really were measured and really do move together", () => {
    const rets = walk(9, 400);
    const r = analysePortfolio({
      positions: [pos({ symbol: "AAA", qty: 10, entry: 100 }), pos({ symbol: "BBB", qty: 10, entry: 100 })],
      equity: 100_000,
      series: [series("AAA", rets), series("BBB", rets)],
      factorSymbol: "AAA",
    });
    expect(r.diversification.measured).toBe(2);
    expect(r.warnings.join(" ")).toContain("independent ones");
  });

  /* The factor is in the matrix but is not a position, so it must not inflate
     the count of bets. */
  it("does not count the benchmark as a position", () => {
    const r = analysePortfolio({
      positions: [pos({ symbol: "AAA", qty: 10, entry: 100 })],
      equity: 100_000,
      series: [series("AAA", walk(1, 400)), series("BTCUSDT", walk(2, 400))],
      factorSymbol: "BTCUSDT",
    });
    expect(r.diversification.measured).toBe(1);
  });
});
