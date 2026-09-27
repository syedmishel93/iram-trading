/**
 * The deeper analytics: risk-adjusted metrics, Monte Carlo reshuffles and the
 * random-entry ("monkey") test.
 *
 * Every expected value below is worked by hand from the input in the comment
 * beside it, never taken from the code under test — an expectation computed by
 * the function it checks cannot fail.
 */

import { describe, expect, it } from "vitest";
import {
  barsPerYearFromSpan,
  computeMetrics,
  drawdownCurve,
  EMPTY_METRICS,
  exposure,
  maxTimeUnderWater,
  sortinoRatio,
  cagr,
  ulcerIndex,
} from "../src/backtest/metrics";
import {
  drawsFor,
  MIN_MC_TRADES,
  monteCarlo,
  percentile,
  randomEntryTest,
} from "../src/backtest/montecarlo";
import type { Trade } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

const trade = (entryIndex: number, exitIndex: number, rMultiple = 1, returnPct = 0.01): Trade => ({
  direction: "long",
  entryIndex,
  entryTime: entryIndex,
  entryPrice: 1,
  exitIndex,
  exitTime: exitIndex,
  exitPrice: 1,
  exitReason: "rule",
  rMultiple,
  returnPct,
  reason: "test",
  maeR: 0,
  mfeR: 0,
});

describe("drawdown curve and ulcer index", () => {
  /* Peaks 1,1,1,1,1,1.2,1.2 → drawdowns 0, .1, .05, .01, 0, 0, 1/12. */
  const eq = [1, 0.9, 0.95, 0.99, 1.0, 1.2, 1.1];

  it("reports the fall below the running peak at every bar", () => {
    const dd = Array.from(drawdownCurve(eq));
    const want = [0, 0.1, 0.05, 0.01, 0, 0, 0.0833333];
    expect(dd).toHaveLength(7);
    want.forEach((w, i) => expect(dd[i]).toBeCloseTo(w, 6));
  });

  it("is the root-mean-square drawdown", () => {
    /* (0.01 + 0.0025 + 0.0001 + 0.0069444) / 7 = 0.00279206; sqrt = 0.052840 */
    expect(ulcerIndex(eq)).toBeCloseTo(0.05284, 5);
  });

  it("is zero for a curve that never falls, and for an empty one", () => {
    expect(ulcerIndex([1, 1.1, 1.2])).toBe(0);
    expect(ulcerIndex([])).toBe(0);
  });

  it("counts the longest stretch spent below a prior peak", () => {
    /* Bars 1,2,3 are under 1.0 (bar 4 recovers to exactly the peak, which is
       not under water); bar 6 is under 1.2 for one bar. */
    expect(maxTimeUnderWater(eq)).toBe(3);
    expect(maxTimeUnderWater([1, 1.1, 1.2])).toBe(0);
  });

  it("counts a drawdown still open at the end", () => {
    expect(maxTimeUnderWater([1, 0.9, 0.9, 0.9, 0.9])).toBe(4);
  });
});

describe("sortino", () => {
  it("divides the mean by downside deviation only", () => {
    /* returns +0.1, -0.1, +0.1 → mean 0.033333; downside sqrt(0.01 / 3) =
       0.057735; ratio 0.57735 at one bar per year. */
    expect(sortinoRatio([1, 1.1, 0.99, 1.089], 1)).toBeCloseTo(0.57735, 4);
  });

  it("refuses to report Infinity when there is no losing bar", () => {
    expect(sortinoRatio([1, 1.1, 1.21], 1)).toBe(0);
    expect(sortinoRatio([1], 1)).toBe(0);
  });
});

describe("cagr and calmar", () => {
  it("annualises the compounded return over the curve's span", () => {
    /* 4 periods at 4 per year = exactly one year, ending at 1.21. */
    expect(cagr([1, 1.1, 0.99, 1.1, 1.21], 4)).toBeCloseTo(0.21, 10);
    /* The same curve over two years: sqrt(1.21) - 1 = 0.1. */
    expect(cagr([1, 1.1, 0.99, 1.1, 1.21], 2)).toBeCloseTo(0.1, 10);
  });

  it("refuses to annualise under a quarter of a year", () => {
    /* 4 periods at 100 per year is 0.04 years. Compounding 21% in two weeks up
       to a year reports an absurd number with a straight face. */
    expect(cagr([1, 1.1, 0.99, 1.1, 1.21], 100)).toBe(0);
    expect(cagr([1, 1.21], 0)).toBe(0);
  });

  it("reports a wiped-out account as -100%", () => {
    expect(cagr([1, 0.5, 0, 0, 0], 4)).toBe(-1);
  });

  it("puts cagr over max drawdown in calmar", () => {
    /* cagr 0.21, max drawdown 0.1 → 2.1 */
    const m = computeMetrics([trade(1, 2), trade(3, 4)], [1, 1.1, 0.99, 1.1, 1.21], 4);
    expect(m.cagr).toBeCloseTo(0.21, 10);
    expect(m.calmar).toBeCloseTo(2.1, 8);
  });

  it("reports calmar as zero, not Infinity, when there was no drawdown", () => {
    const m = computeMetrics([trade(1, 2)], [1, 1.1, 1.21, 1.3, 1.4], 4);
    expect(m.calmar).toBe(0);
  });
});

describe("exposure", () => {
  it("is the fraction of bars a position was held, entry and exit bar inclusive", () => {
    /* bars 2,3,4 and bar 6 → 4 of 10 */
    expect(exposure([trade(2, 4), trade(6, 6)], 10)).toBeCloseTo(0.4, 12);
  });

  it("does not double-count overlapping trades", () => {
    expect(exposure([trade(0, 4), trade(2, 6)], 10)).toBeCloseTo(0.7, 12);
  });

  it("refuses when trade indices do not fit a per-bar curve", () => {
    /* regime.ts hands computeMetrics a per-TRADE curve; the indices then point
       past its end and any fraction computed from them would be invented. */
    expect(exposure([trade(2, 40)], 10)).toBe(0);
  });
});

describe("computeMetrics carries the new fields", () => {
  it("fills every new field on an empty run with zeros", () => {
    const m = computeMetrics([], []);
    expect(m).toEqual(EMPTY_METRICS);
    expect(m.sortino).toBe(0);
    expect(m.ulcerIndex).toBe(0);
    expect(m.maxTimeUnderWaterBars).toBe(0);
    expect(m.exposure).toBe(0);
  });

  /*
   * INFINITY IS A BUG; NaN IS A REFUSAL. This asserted that no field was
   * non-finite, on a ONE-TRADE run — and one trade has no measurable spread, so
   * `perTradeSharpe` is genuinely undefined there. The contract worth keeping
   * is the one it was really protecting: no field may be Infinity, which is a
   * division that ran away and carried on. A field that cannot be computed says
   * NaN, which every formatter in this product already renders as an em dash,
   * and which `deflatedSharpe` must be handed rather than a zero that would
   * read as "measured, and no edge".
   */
  it("never reports an infinity, on any field", () => {
    const m = computeMetrics([trade(0, 1)], [1, 1, 1], 8760);
    for (const [k, v] of Object.entries(m)) {
      expect(Math.abs(v) === Infinity, `${k} ran away to Infinity`).toBe(false);
    }
  });

  it("reports NaN only where the quantity is genuinely undefined", () => {
    // One trade: a mean exists, a spread does not.
    const one = computeMetrics([trade(0, 1)], [1, 1, 1], 8760);
    expect(Number.isNaN(one.perTradeSharpe)).toBe(true);
    for (const [k, v] of Object.entries(one)) {
      if (k === "perTradeSharpe") continue;
      expect(Number.isFinite(v), k).toBe(true);
    }

    // Two trades whose R DIFFERS: every field is measurable again. `trade`
    // defaults rMultiple to 1, so two default trades still have no spread —
    // which is the whole point and was worth getting wrong once.
    const two = computeMetrics([trade(0, 1, 1), trade(1, 2, -0.5)], [1, 1.1, 1.2, 1.3], 8760);
    for (const [k, v] of Object.entries(two)) expect(Number.isFinite(v), k).toBe(true);
  });
});

describe("bars per year from the series' own span", () => {
  it("measures rather than assumes", () => {
    /* 25 hourly bars span one day: 24 periods per day × 365.25 = 8766. */
    expect(barsPerYearFromSpan(25, 0, 86_400_000)).toBeCloseTo(8766, 6);
  });

  it("refuses a span it cannot measure", () => {
    expect(barsPerYearFromSpan(1, 0, 0)).toBe(0);
    expect(barsPerYearFromSpan(10, 5, 5)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────── Monte Carlo ───

describe("percentile", () => {
  it("is nearest-rank", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 0.05)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(10);
    expect(percentile(xs, 0.95)).toBe(19);
  });
});

describe("drawsFor", () => {
  it("keeps the full count on a typical study and caps a huge one", () => {
    expect(drawsFor(200)).toBe(2000); // 400,000 / 200
    expect(drawsFor(400)).toBe(1000);
    expect(drawsFor(1000)).toBe(500); // 400 by budget, floored at 500
    expect(drawsFor(0)).toBe(2000);
  });
});

describe("monteCarlo", () => {
  const mixed = [...Array<number>(20).fill(2), ...Array<number>(20).fill(-1)];

  it("refuses under the trade floor, and says why", () => {
    const r = monteCarlo(Array<number>(MIN_MC_TRADES - 1).fill(1), 0.01);
    expect(r.refused).toMatch(/29 trades/);
    expect(r.draws).toBe(0);
  });

  it("refuses a risk fraction that is not a fraction", () => {
    expect(monteCarlo(mixed, 0).refused).toMatch(/risk/);
    expect(monteCarlo(mixed, 1.5).refused).toMatch(/risk/);
  });

  it("refuses non-finite trade outcomes rather than dropping them", () => {
    const bad = [...mixed];
    bad[3] = Number.NaN;
    expect(monteCarlo(bad, 0.01).refused).toMatch(/finite/);
  });

  it("compounds a uniform run exactly", () => {
    /* 40 trades of +1R at 1% risk: 1.01^40 − 1 = 0.48886, no drawdown, no loser. */
    const r = monteCarlo(Array<number>(40).fill(1), 0.01, { draws: 50 });
    expect(r.refused).toBeNull();
    expect(r.finalReturn.p5).toBeCloseTo(0.4888637, 6);
    expect(r.finalReturn.p95).toBeCloseTo(0.4888637, 6);
    expect(r.maxDrawdown.p95).toBe(0);
    expect(r.losingStreak.p95).toBe(0);
    expect(r.ruinProbability).toBe(0);
  });

  it("leaves the final return unchanged under a pure reshuffle", () => {
    /* Compounding commutes: 1.02^20 × 0.99^20 − 1 = 0.215367 in every order.
       Only the PATH — drawdown and streaks — can differ. */
    const r = monteCarlo(mixed, 0.01, { mode: "shuffle", draws: 200 });
    expect(r.finalReturn.p5).toBeCloseTo(0.2153667, 6);
    expect(r.finalReturn.p95).toBeCloseTo(0.2153667, 6);
    expect(r.losingStreak.p5).toBeGreaterThanOrEqual(1);
    expect(r.losingStreak.p95).toBeLessThanOrEqual(20);
  });

  it("reports a certain ruin as certain", () => {
    /* 30 losers at 50% risk: equity 0.5^30, drawdown 1 − 9.3e-10. */
    const r = monteCarlo(Array<number>(30).fill(-1), 0.5, { draws: 20, ruinDrawdown: 0.3 });
    expect(r.ruinProbability).toBe(1);
    expect(r.maxDrawdown.p50).toBeCloseTo(0.99999999907, 9);
    expect(r.losingStreak.p50).toBe(30);
  });

  it("orders its percentiles", () => {
    const r = monteCarlo(mixed, 0.02, { draws: 500 });
    for (const d of [r.maxDrawdown, r.finalReturn, r.losingStreak]) {
      expect(d.p5).toBeLessThanOrEqual(d.p50);
      expect(d.p50).toBeLessThanOrEqual(d.p95);
    }
    expect(r.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(r.ruinProbability).toBeLessThanOrEqual(1);
  });

  it("is deterministic for a seed and moves with a different one", () => {
    const a = monteCarlo(mixed, 0.02, { draws: 300, seed: 7 });
    const b = monteCarlo(mixed, 0.02, { draws: 300, seed: 7 });
    const c = monteCarlo(mixed, 0.02, { draws: 300, seed: 8 });
    expect(Array.from(a.drawdowns)).toEqual(Array.from(b.drawdowns));
    expect(Array.from(a.drawdowns)).not.toEqual(Array.from(c.drawdowns));
  });

  it("derives its default seed from the data, so a rerun matches", () => {
    const a = monteCarlo(mixed, 0.02, { draws: 100 });
    const b = monteCarlo([...mixed], 0.02, { draws: 100 });
    expect(a.seed).toBe(b.seed);
    expect(a.maxDrawdown).toEqual(b.maxDrawdown);
  });

  it("returns the drawdown sample sorted, for the histogram", () => {
    const r = monteCarlo(mixed, 0.02, { draws: 200 });
    const d = Array.from(r.drawdowns);
    expect(d).toHaveLength(200);
    expect([...d].sort((x, y) => x - y)).toEqual(d);
  });
});

// ───────────────────────────────────────────────────── random-entry test ───

const flatBar = (t: number, o: number, c: number): BarView => ({
  t,
  o,
  h: Math.max(o, c),
  l: Math.min(o, c),
  c,
  v: 1,
});

/** Open of each bar equals the previous close, so a hold is a pure price ratio. */
function barsFrom(closes: readonly number[]): BarView[] {
  return closes.map((c, i) => flatBar(i, i === 0 ? c : (closes[i - 1] as number), c));
}

const longTrade = (bars: readonly BarView[], e: number, x: number): Trade => {
  const entry = (bars[e] as BarView).o;
  const exit = (bars[x] as BarView).c;
  return { ...trade(e, x, 1, exit / entry - 1), entryPrice: entry, exitPrice: exit };
};

describe("randomEntryTest", () => {
  const zero = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };

  it("refuses under the trade floor", () => {
    const bars = barsFrom(Array.from({ length: 100 }, (_, i) => 100 + i));
    const r = randomEntryTest(bars, [longTrade(bars, 1, 3)], zero);
    expect(r.refused).toMatch(/1 trade/);
  });

  it("refuses when a holding time does not fit the bars", () => {
    const bars = barsFrom(Array.from({ length: 50 }, (_, i) => 100 + i));
    const ts = Array.from({ length: 30 }, () => ({ ...trade(0, 49), exitIndex: 80 }));
    expect(randomEntryTest(bars, ts, zero).refused).toMatch(/holding/);
  });

  it("finds hindsight-perfect entries far better than chance", () => {
    /* A zigzag: 10 bars up 1 each, 10 bars down 1 each. Every trade buys the
       trough and sells the next peak — the null with the same 9-bar holds and
       random starts averages near zero. */
    const closes: number[] = [];
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < 10; i++) closes.push(100 + i);
      for (let i = 0; i < 10; i++) closes.push(110 - i);
    }
    const bars = barsFrom(closes);
    const ts: Trade[] = [];
    for (let k = 1; k < 38; k++) ts.push(longTrade(bars, k * 20 + 1, k * 20 + 9));
    const r = randomEntryTest(bars, ts, zero, { draws: 400 });
    expect(r.refused).toBeNull();
    expect(r.observedMean).toBeGreaterThan(0.07);
    expect(r.beatenShare).toBe(0);
    /* (0 + 1) / (400 + 1) */
    expect(r.p).toBeCloseTo(1 / 401, 12);
  });

  it("does not credit a long-only strategy with the market's drift", () => {
    /* Every 5-bar hold on this ramp earns the same. Random entries with the
       same holds and the same direction earn it too, so the strategy has no
       edge over them at all — ties count against the strategy. */
    const closes = Array.from({ length: 400 }, (_, i) => 100 * 2 ** (i / 100));
    const bars = barsFrom(closes);
    const ts: Trade[] = [];
    for (let k = 0; k < 40; k++) ts.push(longTrade(bars, 10 + k * 9, 10 + k * 9 + 5));
    const r = randomEntryTest(bars, ts, zero, { draws: 300 });
    expect(r.observedMean).toBeGreaterThan(0);
    expect(r.beatenShare).toBe(1);
    expect(r.p).toBe(1);
  });

  it("is deterministic for a seed", () => {
    const closes = Array.from({ length: 600 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i * 0.01);
    const bars = barsFrom(closes);
    const ts: Trade[] = [];
    for (let k = 0; k < 40; k++) ts.push(longTrade(bars, 5 + k * 13, 5 + k * 13 + 4));
    const a = randomEntryTest(bars, ts, zero, { draws: 200, seed: 3 });
    const b = randomEntryTest(bars, ts, zero, { draws: 200, seed: 3 });
    expect(a).toEqual(b);
    expect(a.nullP5).toBeLessThanOrEqual(a.nullP95);
  });
});

/**
 * THE PER-TRADE SHARPE, AND WHY IT IS A SEPARATE FIELD FROM `sharpe`.
 *
 * `sharpe` here is ANNUALISED — the bar-return Sharpe times sqrt(barsPerYear).
 * `deflatedSharpe` in `study/stats.ts` is defined on a PER-OBSERVATION Sharpe
 * and its `observations` argument is a TRADE count. CLAUDE.md records exactly
 * what happens when the two are mixed: an annualised 4.93 over 77 trades was
 * deflated with the standard error of a per-trade figure and printed as though
 * the search had been paid for. Three incompatible quantities in one
 * expression, every one of them a plausible number.
 *
 * So the quantity the correction wants is computed here, named for what it is,
 * and never derived from `sharpe` by a caller doing arithmetic on units it
 * cannot see.
 */
describe("perTradeSharpe", () => {
  const tr = (r: number, i = 0): Trade => ({
    direction: "long",
    entryIndex: i,
    entryTime: i * 3_600_000,
    entryPrice: 100,
    exitIndex: i + 1,
    exitTime: (i + 1) * 3_600_000,
    exitPrice: 100 + r,
    exitReason: r > 0 ? "target" : "stop",
    rMultiple: r,
    returnPct: r / 100,
    reason: "test",
    maeR: 0,
    mfeR: 0,
  });
  const eq = (n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => 1 + i * 0.01);

  it("is mean R over the standard deviation of R", () => {
    // +1, -1, +1, -1: mean 0, so the ratio is 0 whatever the spread is.
    expect(computeMetrics([tr(1, 0), tr(-1, 1), tr(1, 2), tr(-1, 3)], eq(4)).perTradeSharpe).toBeCloseTo(0, 9);
    // +2, +1, +2, +1: mean 1.5, population sd 0.5, so 3.
    expect(computeMetrics([tr(2, 0), tr(1, 1), tr(2, 2), tr(1, 3)], eq(4)).perTradeSharpe).toBeCloseTo(3, 6);
  });

  it("is NOT the annualised figure", () => {
    const m = computeMetrics([tr(2, 0), tr(1, 1), tr(2, 2), tr(1, 3)], eq(4));
    // The whole reason the field exists: a caller reaching for `sharpe` and
    // handing it a trade count is the units defect CLAUDE.md records.
    expect(Math.abs(m.perTradeSharpe - m.sharpe)).toBeGreaterThan(0.5);
  });

  it("refuses rather than dividing by a zero spread", () => {
    // Every trade identical: the standard deviation is zero and the ratio is
    // undefined. Infinity here deflates to Infinity and prints as a
    // spectacular edge on a rule that won the same amount three times.
    const same = computeMetrics([tr(1, 0), tr(1, 1), tr(1, 2)], eq(3));
    expect(Number.isFinite(same.perTradeSharpe)).toBe(false);
  });

  it("is zero on no trades, like every other field here", () => {
    expect(computeMetrics([], eq(2)).perTradeSharpe).toBe(0);
    expect(EMPTY_METRICS.perTradeSharpe).toBe(0);
  });

  it("is scale-free in R, so two markets can be compared", () => {
    const a = computeMetrics([tr(2, 0), tr(1, 1), tr(2, 2), tr(1, 3)], eq(4));
    const b = computeMetrics([tr(4, 0), tr(2, 1), tr(4, 2), tr(2, 3)], eq(4));
    // Doubling every R doubles the mean AND the spread, so the ratio holds.
    expect(b.perTradeSharpe).toBeCloseTo(a.perTradeSharpe, 9);
  });
});
