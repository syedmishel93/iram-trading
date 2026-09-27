/**
 * The Strategy desk's critique: every finding from the REAL result types.
 *
 * Fixtures are `Trade`s, `Metrics` from `computeMetrics`, `WalkForwardResult`
 * and `RegimeSlice` shaped exactly as the engine returns them, and
 * `MonteCarloResult` from the real `monteCarlo`. One test at the end runs the
 * real engine through `runDraft` and hands its result straight to `critique`,
 * so the input type is proved to be what the engine produces rather than what
 * this file assumes.
 *
 * Each finding is asserted to name its NUMBER and its THRESHOLD as literals
 * written here — never a value read back from the code under test.
 */

import { describe, expect, it } from "vitest";
import type { Trade } from "../src/backtest/engine";
import { computeMetrics, type Metrics } from "../src/backtest/metrics";
import type { WalkForwardFold, WalkForwardResult } from "../src/backtest/validate";
import type { Regime, RegimeSlice } from "../src/backtest/regime";
import { monteCarlo } from "../src/backtest/montecarlo";
import {
  COST_STRESS,
  critique,
  MANY_VERSIONS,
  MAX_REGIME_SHARE,
  MAX_RUIN,
  MIN_RECOVERY,
  MIN_SAMPLE_TRADES,
  TOP_TRADE_SHARE,
  type CritiqueInput,
} from "../src/backtest/critique";
import { runDraft, stressCosts } from "../src/backtest/draftrun";
import type { BarView } from "../src/chart/series";
import type { RuleSpec } from "../src/backtest/rules";

const T0 = Date.UTC(2025, 0, 1);
const HOUR = 3_600_000;

function trade(i: number, r: number): Trade {
  return {
    direction: "long",
    entryIndex: i * 10,
    entryTime: T0 + i * 10 * HOUR,
    entryPrice: 100,
    exitIndex: i * 10 + 5,
    exitTime: T0 + (i * 10 + 5) * HOUR,
    exitPrice: 100 * (1 + r * 0.01),
    exitReason: r > 0 ? "target" : "stop",
    rMultiple: r,
    returnPct: r * 0.01,
    reason: "fixture",
    maeR: 0.5,
    mfeR: Math.max(0, r),
  };
}

const tradesOf = (rs: readonly number[]): Trade[] => rs.map((r, i) => trade(i, r));

/** Per-trade compounding at 1% risk — the engine's own arithmetic, one point per trade. */
function equityOf(trades: readonly Trade[], risk = 0.01): Float64Array {
  const eq = new Float64Array(trades.length + 1);
  eq[0] = 1;
  trades.forEach((t, i) => {
    eq[i + 1] = (eq[i] as number) * (1 + t.rMultiple * risk);
  });
  return eq;
}

const metricsOf = (trades: readonly Trade[]): Metrics => computeMetrics(trades, equityOf(trades));

/** A clean, repeating +1.2R, +1.2R, -1R book: positive, spread, no outliers. */
const CLEAN_RS = Array.from({ length: 60 }, (_, i) => (i % 3 === 2 ? -1 : 1.2));

function fold(index: number, isR: number, oosR: readonly number[]): WalkForwardFold {
  const oos = tradesOf(oosR);
  return {
    index,
    trainFrom: index * 100,
    trainTo: index * 100 + 70,
    testFrom: index * 100 + 70,
    testTo: index * 100 + 100,
    chosen: "fixture",
    inSample: { ...metricsOf(tradesOf([isR, isR])), expectancyR: isR },
    outOfSample: metricsOf(oos),
  };
}

function walkOf(folds: WalkForwardFold[], degradation: number): WalkForwardResult {
  const pooled = folds.flatMap((f) => tradesOf(Array.from({ length: f.outOfSample.trades }, (_, i) => (i % 3 === 2 ? -1 : 1.2))));
  return { folds, aggregate: metricsOf(pooled), degradation, warnings: [], verdict: "fixture" };
}

const CLEAN_WALK = walkOf(
  [0, 1, 2].map((i) => fold(i, 0.5, Array.from({ length: 15 }, (_, k) => (k % 3 === 2 ? -1 : 1.2)))),
  0.8,
);

function slice(regime: Regime, rs: readonly number[], exposure: number): RegimeSlice {
  return { regime, metrics: metricsOf(tradesOf(rs)), exposure };
}

const CLEAN_REGIMES: RegimeSlice[] = [
  slice("trend", CLEAN_RS.slice(0, 20), 0.4),
  slice("chop", CLEAN_RS.slice(20, 40), 0.4),
  slice("volatile", CLEAN_RS.slice(40, 60), 0.2),
];

function clean(over: Partial<CritiqueInput> = {}): CritiqueInput {
  const trades = tradesOf(CLEAN_RS);
  const m = metricsOf(trades);
  return {
    trades,
    metrics: m,
    stressed: { ...m, expectancyR: m.expectancyR * 0.6 },
    walk: CLEAN_WALK,
    regimes: CLEAN_REGIMES,
    mc: monteCarlo(CLEAN_RS, 0.01, { draws: 500, seed: 7 }),
    versionsTried: 1,
    ...over,
  };
}

const find = (input: CritiqueInput, id: string) => critique(input).checks.find((c) => c.id === id);
const finding = (input: CritiqueInput, id: string) => critique(input).findings.find((c) => c.id === id);

describe("critique — a clean result", () => {
  it("finds nothing, and still lists every check it ran", () => {
    const c = critique(clean());
    expect(c.findings).toEqual([]);
    expect(c.headline).toMatch(/^Nothing weak found in \d+ checks\. That is not proof it works/);
    // Every named check was made; none was folded into a silent pass.
    expect(c.checks.map((k) => k.id)).toEqual([
      "sample",
      "edge",
      "in-sample-only",
      "oos-sample",
      "retention",
      "costs",
      "concentration",
      "drawdown",
      "regime-share",
      "regime-loss",
      "ruin",
      "versions",
    ]);
    expect(c.checks.every((k) => k.passed === true)).toBe(true);
  });

  it("the thresholds are the named ones", () => {
    expect(MIN_SAMPLE_TRADES).toBe(30);
    expect(COST_STRESS).toBe(2);
    expect(TOP_TRADE_SHARE).toBe(0.05);
    expect(MIN_RECOVERY).toBe(1);
    expect(MAX_REGIME_SHARE).toBe(0.8);
    expect(MAX_RUIN).toBe(0.05);
    expect(MANY_VERSIONS).toBe(3);
  });
});

describe("critique — each finding, with its number and its limit", () => {
  it("sample size: 12 trades against 30", () => {
    const trades = tradesOf(CLEAN_RS.slice(0, 12));
    const f = finding(clean({ trades, metrics: metricsOf(trades) }), "sample");
    expect(f?.value).toBe(12);
    expect(f?.threshold).toBe(30);
    expect(f?.text).toBe("Only 12 trades — under 30, too few to tell skill from luck.");
  });

  it("no edge after costs", () => {
    const rs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : -1.2));
    const trades = tradesOf(rs);
    const f = finding(clean({ trades, metrics: metricsOf(trades) }), "edge");
    expect(f?.text).toBe("It loses money after costs: −0.10R a trade.");
    expect(f?.threshold).toBe(0);
  });

  it("in sample only: the walk-forward's own reason is carried behind Why", () => {
    const walk: WalkForwardResult = {
      folds: [],
      aggregate: computeMetrics([], []),
      degradation: 0,
      warnings: [],
      verdict: "window too short for 5 folds",
    };
    const c = critique(clean({ walk }));
    const f = c.findings.find((k) => k.id === "in-sample-only");
    expect(f?.text).toBe("Tested in sample only — the walk-forward could not run.");
    expect(f?.why).toContain("window too short for 5 folds");
    // Nothing is claimed about unseen data when none was tested.
    expect(c.checks.some((k) => k.id === "oos-sample" || k.id === "retention")).toBe(false);
  });

  it("thin unseen-data sample: 9 against 30", () => {
    const walk = walkOf([0, 1, 2].map((i) => fold(i, 0.5, [1.2, 1.2, -1])), 0.8);
    const f = finding(clean({ walk }), "oos-sample");
    expect(f?.value).toBe(9);
    expect(f?.text).toBe("Only 9 trades on unseen data — under 30.");
  });

  it("edge not kept: 20% against the 40% floor", () => {
    const walk = { ...CLEAN_WALK, degradation: 0.2 };
    const f = finding(clean({ walk }), "retention");
    expect(f?.value).toBe(0.2);
    expect(f?.threshold).toBe(0.4);
    expect(f?.text).toContain("Kept 20% of its edge on unseen data — under the 40% floor");
  });

  it("cost sensitivity: loses at 2x costs", () => {
    const base = clean();
    const stressed = { ...base.metrics, expectancyR: -0.05 };
    const f = finding(clean({ stressed }), "costs");
    expect(f?.value).toBe(-0.05);
    expect(f?.text).toMatch(/^At 2× your costs it stops making money: \+0\.\d\dR → −0\.05R\.$/);
  });

  it("cost sensitivity is NOT CHECKED, not passed, when the stress run was not made", () => {
    const c = critique(clean({ stressed: null }));
    const k = c.checks.find((x) => x.id === "costs");
    expect(k?.passed).toBeNull();
    expect(c.findings.some((x) => x.id === "costs")).toBe(false);
  });

  it("concentration: the best 2 of 40 carry it", () => {
    // 38 × -0.1R and 2 × +5R: total +6.2R, without the best two −3.8R.
    const rs = [...Array.from({ length: 38 }, () => -0.1), 5, 5];
    const trades = tradesOf(rs);
    const f = finding(clean({ trades, metrics: metricsOf(trades) }), "concentration");
    expect(f?.value).toBeCloseTo(-3.8, 9);
    expect(f?.text).toBe("Without its best 2 trades of 40 it loses money (−3.80R in total) — the result rests on outliers.");
    expect(f?.why).toContain("+10.00R of the +6.20R total");
  });

  it("drawdown bigger than the return", () => {
    // Ten losers first, then enough winners to finish just above water.
    const rs = [...Array.from({ length: 10 }, () => -1), ...Array.from({ length: 25 }, () => 0.45)];
    const trades = tradesOf(rs);
    const m = metricsOf(trades);
    expect(m.totalReturn).toBeGreaterThan(0);
    expect(m.totalReturn).toBeLessThan(m.maxDrawdown);
    const f = finding(clean({ trades, metrics: m }), "drawdown");
    expect(f?.threshold).toBe(1);
    expect(f?.text).toMatch(/^Its worst drawdown \(−9\.\d%\) was bigger than its whole return \(\+\d\.\d%\)\.$/);
  });

  it("drawdown is not judged against a LOSS — that is the edge finding, once", () => {
    const rs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : -1.2));
    const trades = tradesOf(rs);
    const c = critique(clean({ trades, metrics: metricsOf(trades) }));
    const dd = c.checks.find((k) => k.id === "drawdown");
    expect(dd?.passed).toBeNull();
    expect(dd?.text).toBe("Not checked — it made no money to set against the drop.");
    expect(c.findings.map((f) => f.id)).toContain("edge");
  });

  it("regime concentration: 50 of 60 trades in trend is over 80%", () => {
    const regimes = [
      slice("trend", CLEAN_RS.slice(0, 50), 0.5),
      slice("chop", CLEAN_RS.slice(50, 55), 0.3),
      slice("volatile", CLEAN_RS.slice(55, 60), 0.2),
    ];
    const f = finding(clean({ regimes }), "regime-share");
    expect(f?.value).toBeCloseTo(50 / 60, 9);
    expect(f?.text).toBe("83% of its trades came in one kind of market (trending) — barely tested in the others.");
  });

  it("regime loss: a condition with 20 losing trades is named", () => {
    const regimes = [
      slice("trend", CLEAN_RS.slice(0, 20), 0.4),
      slice("chop", Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.5 : -1)), 0.4),
      slice("volatile", CLEAN_RS.slice(40, 60), 0.2),
    ];
    const f = finding(clean({ regimes }), "regime-loss");
    expect(f?.text).toBe("It lost money in chopping: −0.25R over 20 trades.");
  });

  it("a thin regime is not judged", () => {
    const regimes = [
      slice("trend", CLEAN_RS.slice(0, 50), 0.5),
      slice("chop", [-1, -1, -1], 0.3),
      slice("volatile", CLEAN_RS.slice(0, 7), 0.2),
    ];
    expect(finding(clean({ regimes }), "regime-loss")).toBeUndefined();
  });

  it("ruin: the real Monte Carlo at 10% risk on a coin-flip book", () => {
    const rs = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1.1 : -1));
    const mc = monteCarlo(rs, 0.1, { draws: 500, seed: 3 });
    expect(mc.refused).toBeNull();
    expect(mc.ruinProbability).toBeGreaterThanOrEqual(0.05);
    const f = finding(clean({ mc }), "ruin");
    expect(f?.threshold).toBe(0.05);
    expect(f?.text).toMatch(/of 500 simulated orderings fell 30% or more — over 5%\.$/);
  });

  it("ruin is not checked until the simulation has run", () => {
    const k = find(clean({ mc: null }), "ruin");
    expect(k?.passed).toBeNull();
    expect(k?.text).toBe("Not checked — run the simulation.");
  });

  it("versions: 4 against 3", () => {
    const f = finding(clean({ versionsTried: 4 }), "versions");
    expect(f?.value).toBe(4);
    expect(f?.text).toBe("4 versions tested on these bars — the best of several always looks better than it will trade.");
  });

  it("the headline counts the findings", () => {
    const c = critique(clean({ versionsTried: 5, walk: { ...CLEAN_WALK, degradation: 0.1 } }));
    expect(c.findings.map((f) => f.id)).toEqual(["retention", "versions"]);
    expect(c.headline).toMatch(/^2 weaknesses found in \d+ checks\.$/);
  });
});

describe("critique over the REAL engine's result", () => {
  /* Test-only bars: a deterministic trending sine. Never product data. */
  function bars(n: number): BarView[] {
    const out: BarView[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      const o = p;
      p = 100 + i * 0.02 + Math.sin(i / 9) * 3 + Math.sin(i / 2.3) * 0.6;
      out.push({ t: T0 + i * HOUR, o, h: Math.max(o, p) + 0.3, l: Math.min(o, p) - 0.3, c: p, v: 1000 });
    }
    return out;
  }
  const SPEC: RuleSpec = {
    id: "t",
    name: "RSI turn",
    style: "custom",
    long: [["rsi", "crossabove", "35"]],
    exitLong: [["rsi", ">", "60"]],
    stop: { type: "atr", mult: 2 },
    target: { type: "rr", value: 2 },
  };
  const COSTS = { spread: 0.0002, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 };

  it("runDraft's result is a CritiqueInput, and the cost check reads the stress run", () => {
    const run = runDraft(SPEC, bars(3000), { costs: COSTS, riskPerTrade: 0.01, coverage: 1, containsDemo: false });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.trades.length).toBeGreaterThan(0);
    const c = critique({ ...run, versionsTried: 1 });
    const cost = c.checks.find((k) => k.id === "costs");
    if (run.metrics.expectancyR > 0) expect(cost?.value).toBe(run.stressed?.expectancyR);
    else expect(cost?.passed).toBeNull();
    // Every check states a finite threshold.
    expect(c.checks.every((k) => Number.isFinite(k.threshold))).toBe(true);
  });

  it("the stress run doubles every cost", () => {
    // EVERY term, carry included. A stress that left financing alone would be
    // gentlest on the rules whose cost is mostly financing.
    expect(stressCosts(COSTS)).toEqual({
      spread: 0.0004,
      commission: 0.0008,
      slippage: 0.0002,
      carryPerNight: 0.0002,
    });
  });

  it("refuses an incomplete rule set, and a window shorter than the warm-up", () => {
    const noEntry = runDraft({ ...SPEC, long: [] }, bars(3000), { costs: COSTS, riskPerTrade: 0.01 });
    expect(noEntry).toEqual({ ok: false, refused: expect.stringContaining("never trades") });
    const short = runDraft(SPEC, bars(20), { costs: COSTS, riskPerTrade: 0.01 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.refused).toContain("20 bars available");
  });

  it("refuses generated bars, as the engine does", () => {
    const run = runDraft(SPEC, bars(3000), { costs: COSTS, riskPerTrade: 0.01, containsDemo: true });
    expect(run.ok).toBe(false);
  });
});
