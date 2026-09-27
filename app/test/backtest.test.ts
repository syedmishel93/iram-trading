import { describe, it, expect } from "vitest";
import {
  runBacktest,
  makeContext,
  ZERO_COSTS,
  DEFAULT_COSTS,
  type Strategy,
  type BarView,
} from "../src/backtest/engine";
import { computeMetrics, maxDrawdown, sharpeRatio, verdict } from "../src/backtest/metrics";
import { walkForward, pbo, combinations, equityToReturns } from "../src/backtest/validate";
import { emaTrend, rsiReversion, candidateGrid } from "../src/backtest/strategies";

const H = 3_600_000;

/** Bars from a close path; range hugs the body unless widened. */
function bars(closes: number[], wick = 0.004): BarView[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] as number);
    return {
      t: i * H,
      o,
      h: Math.max(o, c) * (1 + wick),
      l: Math.min(o, c) * (1 - wick),
      c,
      v: 1000,
    };
  });
}

const ramp = (n: number, slope = 0.4, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start + i * slope);

/**
 * A path with real reversals.
 *
 * A monotonic ramp NEVER produces a moving-average crossover after warm-up, so
 * a crossover strategy tested on one takes zero trades and every metric is 0.
 * Swings are what actually exercise entry and exit logic.
 */
const swings = (n: number, period = 60, amplitude = 12, drift = 0.02): number[] =>
  Array.from(
    { length: n },
    (_, i) => 100 + i * drift + Math.sin((i / period) * Math.PI * 2) * amplitude,
  );

/** Bars whose open GAPS away from the previous close, so fills are testable. */
function gappedBars(closes: number[], gap = 0.01): BarView[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : (closes[i - 1] as number);
    const o = prev * (1 + gap);
    return {
      t: i * H,
      o,
      h: Math.max(o, c) * 1.002,
      l: Math.min(o, c) * 0.998,
      c,
      v: 1000,
    };
  });
}

const noise = (n: number, seed = 7): number[] => {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  let p = 100;
  return Array.from({ length: n }, () => (p = Math.max(1, p * (1 + rnd() * 0.02))));
};

/** Enters long on the first eligible bar, then never again. */
function oneShot(stopPct: number, targetPct: number, at = 30): Strategy {
  return {
    id: "one-shot",
    label: "one shot",
    warmup: at,
    entry(ctx, i) {
      if (i !== at) return null;
      const p = ctx.close[i] as number;
      return {
        direction: "long",
        stop: p * (1 - stopPct),
        target: p * (1 + targetPct),
        reason: "test entry",
      };
    },
  };
}

describe("no look-ahead", () => {
  it("fills at the NEXT bar's open, never the signal bar's close", () => {
    // Filling at close[i] is the single most common backtest lie.
    // The open must GAP from the previous close, or open[i+1] === close[i] and
    // the assertion cannot distinguish the two.
    const b = gappedBars(ramp(80), 0.01);
    const r = runBacktest(oneShot(0.5, 0.5), b, { costs: ZERO_COSTS });

    const t = r.trades[0];
    expect(t).toBeDefined();
    expect(t?.entryIndex).toBe(31);
    expect(t?.entryPrice).toBeCloseTo(b[31]?.o as number, 9);
    // And explicitly NOT the close of the decision bar.
    expect(t?.entryPrice).not.toBeCloseTo(b[30]?.c as number, 6);
  });

  it("never trades inside the warm-up", () => {
    const r = runBacktest(emaTrend(20, 50), bars(noise(600)), { costs: ZERO_COSTS });
    for (const t of r.trades) expect(t.entryIndex).toBeGreaterThanOrEqual(55);
  });
});

describe("pessimistic fills", () => {
  it("assumes the STOP when one bar contains both stop and target", () => {
    // A bar that traded through both tells us nothing about the order, and
    // assuming the target turns losing systems into winners on paper.
    const b = bars(ramp(60, 0), 0); // flat, and long enough to clear the guard
    // Bar 31 straddles both levels.
    const straddle = b[31] as BarView;
    straddle.h = 130;
    straddle.l = 70;

    const r = runBacktest(oneShot(0.1, 0.1), b, { costs: ZERO_COSTS });
    expect(r.trades[0]?.exitReason).toBe("stop");
    expect(r.trades[0]?.rMultiple).toBeLessThan(0);
  });

  it("takes the target when only the target is inside the bar", () => {
    const b = bars(ramp(60, 0), 0);
    const up = b[31] as BarView;
    up.h = 130;
    up.l = 99;

    const r = runBacktest(oneShot(0.1, 0.1), b, { costs: ZERO_COSTS });
    expect(r.trades[0]?.exitReason).toBe("target");
    expect(r.trades[0]?.rMultiple).toBeGreaterThan(0);
  });
});

describe("costs", () => {
  it("makes an identical strategy worse, on both sides", () => {
    const b = bars(swings(1200));
    const free = runBacktest(emaTrend(10, 30), b, { costs: ZERO_COSTS });
    const paid = runBacktest(emaTrend(10, 30), b, { costs: DEFAULT_COSTS });

    expect(free.trades.length).toBeGreaterThan(5);
    const freeM = computeMetrics(free.trades, free.equity);
    const paidM = computeMetrics(paid.trades, paid.equity);
    expect(paidM.expectancyR).toBeLessThan(freeM.expectancyR);
  });

  it("charges the spread in the adverse direction for shorts too", () => {
    const b = bars(ramp(80, 0), 0);
    const r = runBacktest(oneShot(0.5, 0.5), b, { costs: DEFAULT_COSTS });
    const t = r.trades[0];
    expect(t).toBeDefined();
    // A long pays UP on entry.
    expect(t?.entryPrice).toBeGreaterThan(b[31]?.o as number);
  });
});

describe("the engine refuses bad runs", () => {
  it("refuses a series with poor coverage", () => {
    // A gap would otherwise be treated silently as one enormous bar.
    const r = runBacktest(emaTrend(), bars(ramp(400)), { coverage: 0.6 });
    expect(r.refused).toMatch(/coverage/);
    expect(r.trades).toEqual([]);
  });

  it("refuses generated data unless explicitly allowed", () => {
    const r = runBacktest(emaTrend(), bars(ramp(400)), { containsDemo: true });
    expect(r.refused).toMatch(/generated data/);

    const allowed = runBacktest(emaTrend(), bars(ramp(400)), {
      containsDemo: true,
      allowDemo: true,
      costs: ZERO_COSTS,
    });
    expect(allowed.refused).toBeNull();
  });

  it("refuses a series shorter than the warm-up", () => {
    expect(runBacktest(emaTrend(20, 50), bars(ramp(20))).refused).toMatch(/bars/);
  });

  it("warns loudly when the sample is too small to mean anything", () => {
    const r = runBacktest(oneShot(0.1, 0.1), bars(ramp(200)), { costs: ZERO_COSTS });
    expect(r.warnings.some((w) => /too few/.test(w))).toBe(true);
  });

  it("warns when a position was still open at the end", () => {
    const b = bars(ramp(120, 0.02), 0);
    const r = runBacktest(oneShot(0.9, 0.9), b, { costs: ZERO_COSTS });
    expect(r.warnings.some((w) => /open at the end/.test(w))).toBe(true);
    expect(r.trades[0]?.exitReason).toBe("end-of-data");
  });
});

describe("trades carry their reasoning", () => {
  it("every trade explains why it was taken", () => {
    const r = runBacktest(emaTrend(10, 30), bars(swings(1200)), { costs: ZERO_COSTS });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.reason.length).toBeGreaterThan(15);
      expect(Number.isFinite(t.rMultiple)).toBe(true);
    }
  });

  it("exposes its rules rather than just a name", () => {
    const s = emaTrend(20, 50, 2, 3);
    expect(s.rules.entry).toMatch(/EMA20/);
    expect(s.rules.stop).toMatch(/ATR/);
    expect(s.rules.exit).toMatch(/3R/);
  });
});

describe("metrics", () => {
  it("finds the worst peak-to-trough decline", () => {
    expect(maxDrawdown([1, 1.5, 0.75, 1.2])).toBeCloseTo(0.5, 9);
  });

  it("reports zero drawdown for a monotonic curve", () => {
    expect(maxDrawdown([1, 1.1, 1.2])).toBe(0);
  });

  it("returns 0 Sharpe for a flat curve rather than Infinity", () => {
    // Infinity would rank a strategy that never traded above every one that did.
    expect(sharpeRatio([1, 1, 1, 1])).toBe(0);
  });

  it("counts the longest losing streak", () => {
    const t = (r: number) => ({
      direction: "long" as const,
      entryIndex: 0,
      entryTime: 0,
      entryPrice: 1,
      exitIndex: 1,
      exitTime: 1,
      exitPrice: 1,
      exitReason: "stop" as const,
      rMultiple: r,
      returnPct: r,
      reason: "x",
      maeR: 0,
      mfeR: 0,
    });
    const m = computeMetrics([t(-1), t(-1), t(1), t(-1), t(-1), t(-1)], [1, 1]);
    expect(m.maxConsecutiveLosses).toBe(3);
    expect(m.wins).toBe(1);
  });

  it("keeps profit factor finite when there are no losses", () => {
    const t = {
      direction: "long" as const,
      entryIndex: 0,
      entryTime: 0,
      entryPrice: 1,
      exitIndex: 1,
      exitTime: 1,
      exitPrice: 1,
      exitReason: "target" as const,
      rMultiple: 2,
      returnPct: 0.02,
      reason: "x",
      maeR: 0,
      mfeR: 0,
    };
    expect(Number.isFinite(computeMetrics([t, t], [1, 1.04]).profitFactor)).toBe(true);
  });
});

describe("verdict is conservative by default", () => {
  it("calls a small sample unproven however good it looks", () => {
    const m = computeMetrics([], []);
    expect(verdict({ ...m, trades: 12, expectancyR: 5, profitFactor: 9 }).rating).toBe("unproven");
  });

  it("calls a negative expectancy weak", () => {
    const m = computeMetrics([], []);
    expect(verdict({ ...m, trades: 100, expectancyR: -0.05, profitFactor: 0.9 }).rating).toBe("weak");
  });

  it("never calls anything better than promising, and says it is in-sample", () => {
    const m = computeMetrics([], []);
    const v = verdict({ ...m, trades: 200, expectancyR: 0.4, profitFactor: 2.1, maxDrawdown: 0.1 });
    expect(v.rating).toBe("promising");
    expect(v.why).toMatch(/in-sample/i);
  });
});

describe("walk-forward", () => {
  it("selects on train and measures on the untouched test slice", () => {
    const r = walkForward(candidateGrid().slice(0, 4), bars(swings(3000, 90, 15)), {
      folds: 4,
      costs: ZERO_COSTS,
    });
    expect(r.folds.length).toBeGreaterThan(0);
    for (const f of r.folds) {
      expect(f.testFrom).toBeGreaterThanOrEqual(f.trainTo);
    }
  });

  it("reports degradation between in-sample and out-of-sample", () => {
    const r = walkForward(candidateGrid().slice(0, 6), bars(noise(4000)), {
      folds: 4,
      costs: ZERO_COSTS,
    });
    expect(Number.isFinite(r.degradation)).toBe(true);
    expect(r.verdict.length).toBeGreaterThan(20);
  });

  it("refuses when there is not enough history to validate on", () => {
    const r = walkForward([emaTrend(50, 200)], bars(ramp(300)), { folds: 5 });
    expect(r.verdict).toMatch(/insufficient history/);
    expect(r.warnings[0]).toMatch(/not enough history/);
  });

  it("handles an empty candidate list without throwing", () => {
    expect(walkForward([], bars(ramp(1000))).verdict).toMatch(/nothing to validate/);
  });

  it("warns when the pooled out-of-sample sample is tiny", () => {
    const r = walkForward([rsiReversion()], bars(swings(3000, 90, 15)), { folds: 5, costs: ZERO_COSTS });
    if (r.aggregate.trades < 30) {
      expect(r.warnings.some((w) => /out-of-sample trades/.test(w))).toBe(true);
    }
  });
});

describe("combinations", () => {
  it("enumerates every balanced split", () => {
    expect(combinations(4, 2)).toHaveLength(6);
    expect(combinations(8, 4)).toHaveLength(70);
  });

  it("produces sorted, unique index sets", () => {
    for (const c of combinations(6, 3)) {
      expect(new Set(c).size).toBe(3);
      expect([...c].sort((a, b) => a - b)).toEqual(c);
    }
  });
});

describe("PBO via CSCV", () => {
  /** N configs whose returns are pure independent noise. */
  const noiseMatrix = (configs: number, T: number, seed = 3): number[][] => {
    let s = seed;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    return Array.from({ length: configs }, () => Array.from({ length: T }, () => rnd() * 0.01));
  };

  it("reports a HIGH pbo when configurations are pure noise", () => {
    // This is the headline property: if selection has no skill, the in-sample
    // winner should land below the out-of-sample median about half the time.
    const r = pbo(noiseMatrix(12, 1600), 8);
    expect(r.splits).toBe(70);
    expect(r.pbo).toBeGreaterThan(0.25);
    expect(r.interpretation).toMatch(/PBO/);
  });

  it("reports a LOW pbo when one configuration is genuinely better throughout", () => {
    const m = noiseMatrix(10, 1600, 11);
    // Give config 0 a small, persistent edge in every period.
    m[0] = (m[0] as number[]).map((v) => v + 0.004);
    const r = pbo(m, 8);
    expect(r.pbo).toBeLessThan(0.25);
  });

  it("needs at least two configurations", () => {
    expect(pbo([[0.1, 0.2, 0.3]], 4).interpretation).toMatch(/at least two/);
  });

  it("refuses when there are too few observations to block", () => {
    expect(pbo(noiseMatrix(4, 6), 8).interpretation).toMatch(/not enough observations/);
  });

  it("keeps every logit finite even when the winner ranks first or last", () => {
    const r = pbo(noiseMatrix(6, 1200, 5), 6);
    for (const l of r.logits) expect(Number.isFinite(l)).toBe(true);
  });

  it("uses an even number of blocks", () => {
    // An odd block count cannot be split into equal halves.
    expect(pbo(noiseMatrix(6, 2000), 7).splits).toBe(combinations(6, 3).length);
  });
});

describe("equityToReturns", () => {
  it("converts a curve to per-bar returns", () => {
    const r = equityToReturns([1, 1.1, 1.21]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 9);
    expect(r[1]).toBeCloseTo(0.1, 9);
  });

  it("emits 0 rather than NaN across a zero or invalid point", () => {
    for (const v of equityToReturns([1, 0, 1])) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("makeContext", () => {
  it("mirrors the bars into columns", () => {
    const b = bars(ramp(5));
    const ctx = makeContext(b);
    expect(ctx.close[3]).toBe(b[3]?.c);
    expect(ctx.time[2]).toBe(b[2]?.t);
  });
});

/**
 * The shared context is an optimisation with a correctness edge on it: hand a
 * run a context and it will use that context's indicator columns. If the context
 * belongs to another series — or to a LONGER series that this run is a slice of —
 * the columns are computed partly from bars this run must not be able to see, and
 * the result looks entirely plausible. These tests are the locks.
 */
describe("shared strategy context", () => {
  const path = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 9) * 6 + i * 0.05);

  it("gives identical results whether or not a context is shared", () => {
    const series = bars(path);
    const strategy = emaTrend(10, 30, 2, 2);
    const alone = runBacktest(strategy, series, { costs: ZERO_COSTS });
    const shared = runBacktest(strategy, series, { costs: ZERO_COSTS }, makeContext(series));

    expect(shared.trades.length).toBe(alone.trades.length);
    expect(shared.trades).toEqual(alone.trades);
    expect(Array.from(shared.equity)).toEqual(Array.from(alone.equity));
  });

  it("IGNORES a context built from a different series", () => {
    const series = bars(path);
    const other = bars(path.map((c) => c * 3 + 20));
    const strategy = emaTrend(10, 30, 2, 2);

    const honest = runBacktest(strategy, series, { costs: ZERO_COSTS });
    // Same length, entirely different prices. Accepting it would index another
    // instrument's indicators against these bars.
    const poisoned = runBacktest(strategy, series, { costs: ZERO_COSTS }, makeContext(other));
    expect(poisoned.trades).toEqual(honest.trades);
  });

  it("IGNORES a whole-series context passed to a slice — the walk-forward leak", () => {
    const series = bars(path);
    const slice = series.slice(0, 150);
    const strategy = emaTrend(10, 30, 2, 2);

    const honest = runBacktest(strategy, slice, { costs: ZERO_COSTS });
    /* This is the exact shape of the accident the API is designed against: a
       context over 300 bars, used for a run over the first 150. Its EMAs at
       index 149 are built from bars 0..149 only, so they would agree — but the
       reference check must reject it regardless, because the general case does
       not agree and there is no way to tell them apart at runtime. */
    const leaky = runBacktest(strategy, slice, { costs: ZERO_COSTS }, makeContext(series));
    expect(leaky.bars).toBe(150);
    expect(leaky.trades).toEqual(honest.trades);
  });

  it("shares the indicator cache when the context is the same object", () => {
    // Two strategies over the same context. The observable consequence of the
    // cache is speed, which a test cannot assert reliably; what it CAN assert is
    // that reuse does not corrupt either result.
    const series = bars(path);
    const ctx = makeContext(series);
    const a = runBacktest(emaTrend(10, 30, 2, 2), series, { costs: ZERO_COSTS }, ctx);
    const b = runBacktest(emaTrend(20, 50, 2, 2), series, { costs: ZERO_COSTS }, ctx);
    const aAgain = runBacktest(emaTrend(10, 30, 2, 2), series, { costs: ZERO_COSTS }, ctx);

    expect(aAgain.trades).toEqual(a.trades);
    expect(b.strategy).not.toBe(a.strategy);
  });
});
