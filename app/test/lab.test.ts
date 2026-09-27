import { describe, it, expect } from "vitest";
import { runStudy, judge, familyGrid, MIN_OOS_TRADES, type ConfigRow } from "../src/backtest/lab";
import { EMPTY_METRICS, type Metrics } from "../src/backtest/metrics";
import type { PboResult, WalkForwardResult } from "../src/backtest/validate";
import type { BarView } from "../src/chart/series";
import { openCoverage, openSpanMs } from "../src/data/sessions";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** A deterministic series with real swings — a ramp gives no crossovers at all. */
function series(n: number): BarView[] {
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    // Two incommensurate cycles plus drift: trends and reversions both occur,
    // and nothing about it is random, so the suite cannot flake.
    p += Math.sin(i / 17) * 0.8 + Math.sin(i / 61) * 1.6 + 0.005;
    const o = p;
    const c = p + Math.sin(i / 7) * 0.3;
    out.push({
      t: T0 + i * HOUR,
      o,
      h: Math.max(o, c) + 0.4,
      l: Math.min(o, c) - 0.4,
      c,
      v: 1000 + (i % 13) * 25,
    });
  }
  return out;
}

const metrics = (over: Partial<Metrics>): Metrics => ({ ...EMPTY_METRICS, ...over });

const walkOf = (over: Partial<WalkForwardResult>): WalkForwardResult => ({
  folds: [],
  aggregate: EMPTY_METRICS,
  degradation: 1,
  warnings: [],
  verdict: "",
  ...over,
});

const pboOf = (over: Partial<PboResult>): PboResult => ({
  pbo: 0,
  logits: [],
  splits: 16,
  oosPositiveRate: 1,
  interpretation: "",
  ...over,
});

const row = (over: Partial<ConfigRow> = {}): ConfigRow => ({
  id: "x",
  label: "X",
  params: {},
  metrics: metrics({ trades: 100, expectancyR: 0.2 }),
  score: 1,
  refused: null,
  ...over,
});

describe("the gate", () => {
  it("calls a coin-flip selection what it is, however good the curve looks", () => {
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 400, expectancyR: 1 }) }),
      pboOf({ pbo: 0.89 }),
      row(),
      null,
    );
    expect(h.standing).toBe("no-edge");
    expect(h.verdict).toBe("No demonstrated edge");
    expect(h.why).toContain("89%");
  });

  it("refuses to conclude anything from a small out-of-sample count", () => {
    // The real case this was written for: walk-forward once reported "233%
    // retained" on 22 OOS trades while PBO said 89%. Twenty-two trades cannot
    // support either claim, so sample size outranks a flattering degradation.
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 22 }), degradation: 2.33 }),
      pboOf({ pbo: 0.1 }),
      row(),
      null,
    );
    expect(h.standing).toBe("unproven");
    expect(h.why).toContain("22 out-of-sample trades");
  });

  it("puts sample size BELOW the no-edge finding, not above it", () => {
    // Both objections apply; the stronger one must win, or a tiny sample would
    // mask a PBO that already proved the process has no skill.
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 5 }) }),
      pboOf({ pbo: 0.7 }),
      row(),
      null,
    );
    expect(h.standing).toBe("no-edge");
  });

  it("calls a middling PBO fragile rather than fine", () => {
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 200 }), degradation: 0.9 }),
      pboOf({ pbo: 0.35 }),
      row(),
      null,
    );
    expect(h.standing).toBe("fragile");
  });

  it("flags an edge that survives out of sample but not out of costs", () => {
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 200, expectancyR: -0.01 }), degradation: 0.8 }),
      pboOf({ pbo: 0.1 }),
      row(),
      metrics({ trades: 200, expectancyR: 0.3 }),
    );
    expect(h.standing).toBe("survived");
    expect(h.why).toContain("costs switched off");
  });

  it("never promises more than evidence", () => {
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 200 }), degradation: 0.9 }),
      pboOf({ pbo: 0.05 }),
      row(),
      null,
    );
    expect(h.standing).toBe("survived");
    expect(h.why).toMatch(/evidence, not/);
  });

  it("reports a refusal as a refusal, not as a zero result", () => {
    const h = judge([], walkOf({}), pboOf({}), row({ refused: "coverage 0.40 below 0.98" }), null);
    expect(h.standing).toBe("refused");
    expect(h.why).toContain("coverage");
  });

  it("ignores PBO when there were too few splits to compute it", () => {
    const h = judge(
      [row()],
      walkOf({ aggregate: metrics({ trades: 200 }), degradation: 0.9 }),
      pboOf({ pbo: 0.9, splits: 0 }),
      row(),
      null,
    );
    expect(h.standing).not.toBe("no-edge");
  });
});

describe("running a study", () => {
  it("refuses rather than producing numbers that look real", () => {
    const s = runStudy("ema", series(120));
    expect(s.headline.standing).toBe("refused");
    expect(s.headline.why).toMatch(/not enough/);
    expect(s.configs).toHaveLength(0);
  });

  it("always produces a sweep, a walk-forward and a PBO together", () => {
    // The point of the lab: there is no path that yields a curve without the
    // two numbers that qualify it.
    const s = runStudy("ema", series(2400));
    expect(s.configs.length).toBe(familyGrid("ema").length);
    expect(s.overfit.splits).toBeGreaterThan(0);
    expect(s.walk).toBeDefined();
    expect(s.headline.verdict.length).toBeGreaterThan(0);
  });

  it("ranks the sweep best-first and reports that winner", () => {
    const s = runStudy("ema", series(2400));
    const scores = s.configs.map((c) => c.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] as number);
    }
    expect(s.best?.id).toBe(s.configs[0]?.id);
    expect(s.bestRun?.strategy).toBeDefined();
  });

  it("measures the same winner with costs off, so friction is separable", () => {
    const s = runStudy("ema", series(2400));
    if (s.best && !s.best.refused && s.best.metrics.trades > 0 && s.grossMetrics) {
      // Costs can only reduce a result; gross must be at least net.
      expect(s.grossMetrics.expectancyR).toBeGreaterThanOrEqual(s.best.metrics.expectancyR - 1e-9);
    }
  });

  it("is deterministic — the same bars give the same verdict", () => {
    const a = runStudy("rsi", series(2400));
    const b = runStudy("rsi", series(2400));
    expect(a.headline).toEqual(b.headline);
    expect(a.configs.map((c) => c.score)).toEqual(b.configs.map((c) => c.score));
  });

  it("keeps refused configurations out of the PBO matrix", () => {
    // A refused run has an empty equity curve. Counting it would make the sweep
    // look more robust than it is, by adding a config that never loses.
    const s = runStudy("ema", series(2400), { coverage: 0.5, minCoverage: 0.98 });
    expect(s.configs.every((c) => c.refused !== null)).toBe(true);
    expect(s.overfit.splits).toBe(0);
    expect(s.headline.standing).toBe("refused");
  });
});

describe("session-aware coverage", () => {
  const FRI = Date.parse("2026-08-28T12:00:00Z");
  const MON = Date.parse("2026-08-31T12:00:00Z");

  it("does not count the weekend against a forex series", () => {
    // A naive ratio reports well under half here, and the backtester would
    // refuse to run on complete data.
    expect(openCoverage("EURUSD", { from: FRI, to: MON }, [])).toBe(1);
    expect(openSpanMs("EURUSD", FRI, MON) / (MON - FRI)).toBeLessThan(0.5);
  });

  it("still counts a hole that falls in trading hours", () => {
    const hole = {
      from: Date.parse("2026-08-31T00:00:00Z"),
      to: Date.parse("2026-08-31T06:00:00Z"),
    };
    const c = openCoverage("EURUSD", { from: FRI, to: MON }, [hole]);
    expect(c).toBeLessThan(1);
    expect(c).toBeGreaterThan(0.5);
  });

  it("counts every hour against crypto, which never closes", () => {
    expect(openSpanMs("BTCUSDT", FRI, MON)).toBe(MON - FRI);
  });

  /* AAPL is no longer an unknown class — `data/equityhours.ts` models the US
     exchange calendar, so its span is five and a half hours of Friday session
     and nothing at the weekend. The conservative fallback still applies to a
     venue nobody has modelled. */
  it("treats a genuinely unknown class conservatively — a hole looks bigger, not smaller", () => {
    expect(openSpanMs("GER40", FRI, MON)).toBe(MON - FRI);
  });

  it("counts only the session against a US equity", () => {
    const span = openSpanMs("AAPL", FRI, MON);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(MON - FRI);
  });

  it("reports zero for a window with no tradeable time at all", () => {
    const sat = Date.parse("2026-08-29T00:00:00Z");
    const sun = Date.parse("2026-08-29T12:00:00Z");
    expect(openCoverage("XAUUSD.s", { from: sat, to: sun }, [])).toBe(0);
  });
});

describe("the sample-size floor", () => {
  it("is a stated constant, not a magic number buried in a branch", () => {
    expect(MIN_OOS_TRADES).toBe(30);
  });
});
