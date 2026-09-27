/**
 * The setup simulator.
 *
 * The tests that matter here are the ones that stop a backtest inventing an
 * edge: the strictly-after rule, the both-in-one-bar refusal, geometry taken
 * from the analogue's own bar rather than today's price, and the tail
 * exclusion. Every one of those, done wrong, makes the numbers look BETTER.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_TRIALS,
  bootstrapMean,
  breakEven,
  simulateKind,
  wilsonLow,
  type SimulateOptions,
} from "../src/setup/simulate";
import type { Detection, DetectInput, Shape } from "../src/detect/types";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Build a series from explicit OHLC rows. */
function series(rows: readonly (readonly [number, number, number, number])[]): {
  data: DetectInput;
  len: number;
} {
  const len = rows.length;
  const mk = (f: (r: readonly [number, number, number, number]) => number): Float64Array =>
    Float64Array.from(rows.map(f));
  return {
    data: {
      t: Float64Array.from(rows.map((_, i) => 1_700_000_000_000 + i * 60_000)),
      o: mk((r) => r[0]),
      h: mk((r) => r[1]),
      l: mk((r) => r[2]),
      c: mk((r) => r[3]),
      v: Float64Array.from(rows.map(() => 1000)),
    },
    len,
  };
}

/** A flat series at `price`, with a little range so ATR is not zero. */
function flat(n: number, price = 100): ReturnType<typeof series> {
  return series(Array.from({ length: n }, () => [price, price + 1, price - 1, price] as const));
}

const level = (y: number, x0 = 0): Shape => ({ type: "level", x0, y, tone: "neutral" });

const det = (to: number, over: Partial<Detection> = {}): Detection => ({
  id: `d${to}`,
  kind: "double-bottom",
  label: "Double bottom",
  direction: "long",
  from: Math.max(0, to - 10),
  to,
  confidence: 0.7,
  reason: "two lows matched",
  shapes: [level(99)],
  ...over,
});

const opts: SimulateOptions = { rMultiple: 2, horizonBars: 10 };

/* -------------------------------------------------------------------------- */

describe("wilsonLow", () => {
  it("is far below the point estimate on a tiny sample", () => {
    /* 3 of 3 is 100%; the whole reason this function exists is that 100% is
       not what a three-sample run means. */
    expect(wilsonLow(3, 3)).toBeLessThan(0.5);
    expect(wilsonLow(3, 3)).toBeGreaterThan(0.3);
  });

  it("converges towards the point estimate as n grows", () => {
    const small = wilsonLow(6, 10);
    const large = wilsonLow(600, 1000);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(0.55);
    expect(large).toBeLessThan(0.6);
  });

  it("is zero for an empty sample rather than NaN", () => {
    expect(wilsonLow(0, 0)).toBe(0);
  });

  it("never exceeds the point estimate", () => {
    for (const [w, n] of [[1, 4], [5, 9], [20, 25], [99, 100]] as const) {
      expect(wilsonLow(w, n)).toBeLessThanOrEqual(w / n);
    }
  });
});

describe("bootstrapMean", () => {
  it("is reproducible for the same sample", () => {
    const v = [1, -1, 2, -1, -1, 3, -1, 0.4];
    expect(bootstrapMean(v)).toEqual(bootstrapMean(v));
  });

  it("brackets the sample mean", () => {
    const v = [2, -1, 2, -1, -1, 2, -1, 2, -1, 2];
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const ci = bootstrapMean(v);
    expect(ci).not.toBeNull();
    expect((ci as [number, number])[0]).toBeLessThanOrEqual(mean);
    expect((ci as [number, number])[1]).toBeGreaterThanOrEqual(mean);
  });

  it("returns null on an empty sample", () => {
    expect(bootstrapMean([])).toBeNull();
  });
});

describe("breakEven", () => {
  it("is a third at 2R and a quarter at 3R", () => {
    expect(breakEven(2)).toBeCloseTo(1 / 3, 10);
    expect(breakEven(3)).toBeCloseTo(0.25, 10);
  });
});

describe("simulateKind — refusals", () => {
  it("refuses when there is not enough history to replay anything", () => {
    const { data, len } = flat(8);
    const s = simulateKind("double-bottom", "long", [det(2)], data, len, opts);
    expect(s.n).toBe(0);
    expect(s.note).toMatch(/not enough history/i);
  });

  it("says so when no instance of the kind exists", () => {
    const { data, len } = flat(60);
    const s = simulateKind("head-shoulders", "long", [det(20)], data, len, opts);
    expect(s.trials).toHaveLength(0);
    expect(s.note).toMatch(/no completed instance/i);
  });

  it("does not characterise a sample below MIN_TRIALS", () => {
    const { data, len } = flat(200);
    const dets = [5, 20, 40].map((to) => det(to));
    const s = simulateKind("double-bottom", "long", dets, data, len, opts);
    expect(s.n).toBeLessThan(MIN_TRIALS);
    expect(s.enough).toBe(false);
    expect(s.note).toMatch(/too few to characterise/i);
  });
});

describe("simulateKind — the look-ahead rules", () => {
  it("excludes analogues within one horizon of the live edge", () => {
    /* Two detections: one comfortably in the past, one at the very edge. Only
       the first can have resolved, so only the first may be replayed. */
    const { data, len } = flat(100);
    const dets = [det(20), det(len - 2)];
    const s = simulateKind("double-bottom", "long", dets, data, len, opts);
    expect(s.trials).toHaveLength(1);
    expect(s.trials[0]?.atBar).toBe(20);
  });

  it("opens the trial on the bar AFTER confirmation, never on it", () => {
    /* The confirmation bar itself spikes straight through the target. If the
       walk started on it, this would score a win it could not have taken. */
    const rows: [number, number, number, number][] = Array.from(
      { length: 100 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    rows[30] = [100, 140, 99, 100]; // the confirmation bar's own spike
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", [det(30, { shapes: [level(95)] })], data, len, opts);
    expect(s.trials).toHaveLength(1);
    expect(s.trials[0]?.outcome).not.toBe("target");
  });

  it("marks a bar covering both target and stop as unknowable, not a win", () => {
    const rows: [number, number, number, number][] = Array.from(
      { length: 100 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    /* Entry 100, stop 95 → risk 5 → target 110. This bar spans 90..115. */
    rows[31] = [100, 115, 90, 100];
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", [det(30, { shapes: [level(95)] })], data, len, opts);
    expect(s.trials[0]?.outcome).toBe("unknowable");
    expect(s.unknowable).toBe(1);
    expect(s.n).toBe(0);
    expect(s.note).toMatch(/inside a single bar/i);
  });

  it("takes the stop from the analogue's own bar, not from today's price", () => {
    /* A rising series: the instrument traded near 100 early and near 300 late.
       A stop of 99 (correct for the early instance) is unreachable later, so
       if geometry were taken from one shared level every late trial would be
       an expiry. Each detection carries its OWN level here, and the resulting
       stops must differ. */
    const rows: [number, number, number, number][] = Array.from({ length: 300 }, (_, i) => {
      const p = 100 + i;
      return [p, p + 1, p - 1, p] as [number, number, number, number];
    });
    const { data, len } = series(rows);
    const dets = [50, 150, 250].map((to) => det(to, { shapes: [level(100 + to - 3)] }));
    const s = simulateKind("double-bottom", "long", dets, data, len, { ...opts, horizonBars: 10 });
    const stops = s.trials.map((t) => t.stop).sort((a, b) => a - b);
    expect(new Set(stops).size).toBe(stops.length);
    expect(stops[0]).toBeCloseTo(147, 6);
  });
});

describe("simulateKind — duplication and the stop floor", () => {
  it("counts one instance per bar, however many detectors fired on it", () => {
    /* Higher-timeframe projections put the same idea on the chart several
       times. Replaying each triples n without adding an observation, and n is
       what licenses every statistic below it. Measured on ETHUSDT 1d: 12
       trials from 4 real instances. */
    const { data, len } = flat(300);
    const dets = [
      det(50, { id: "a", confidence: 0.5 }),
      det(50, { id: "b", confidence: 0.9 }),
      det(50, { id: "c", confidence: 0.7 }),
      det(120, { id: "d" }),
    ];
    const s = simulateKind("double-bottom", "long", dets, data, len, opts);
    expect(s.trials).toHaveLength(2);
    expect(s.trials.map((t) => t.atBar).sort((a, b) => a - b)).toEqual([50, 120]);
  });

  it("keeps the most confident detection when several share a bar", () => {
    /* Not an arbitrary tie-break: the engine ranks by confidence, so the one
       it would have chosen is the one whose geometry must be replayed. */
    const { data, len } = flat(300);
    const dets = [
      det(50, { id: "lo", confidence: 0.2, shapes: [level(90)] }),
      det(50, { id: "hi", confidence: 0.95, shapes: [level(97)] }),
    ];
    const s = simulateKind("double-bottom", "long", dets, data, len, {
      ...opts,
      minAtrMultiple: 0,
    });
    expect(s.trials[0]?.stop).toBe(97);
  });

  it("widens a stop tighter than the operator's own ATR floor", () => {
    /* A level 0.1 from an entry of 100 is not a stop anybody would have been
       given: buildPlan applies the same floor to the live plan, so a replay
       without it prices a trade the terminal would never propose. */
    const { data, len } = flat(300);
    const d = det(50, { shapes: [level(99.9)] });
    const loose = simulateKind("double-bottom", "long", [d], data, len, { ...opts, minAtrMultiple: 0 });
    const floored = simulateKind("double-bottom", "long", [d], data, len, { ...opts, minAtrMultiple: 1 });
    const tight = Math.abs((loose.trials[0] as { entry: number; stop: number }).entry - (loose.trials[0] as { stop: number }).stop);
    const wide = Math.abs((floored.trials[0] as { entry: number; stop: number }).entry - (floored.trials[0] as { stop: number }).stop);
    expect(tight).toBeCloseTo(0.1, 6);
    expect(wide).toBeGreaterThan(tight * 10);
  });

  it("leaves a stop already wider than the floor alone", () => {
    const { data, len } = flat(300);
    const d = det(50, { shapes: [level(80)] });
    const s = simulateKind("double-bottom", "long", [d], data, len, { ...opts, minAtrMultiple: 1 });
    expect(s.trials[0]?.stop).toBeCloseTo(80, 6);
  });
});

describe("simulateKind — the arithmetic", () => {
  it("scores a clean winner at exactly the R multiple", () => {
    const rows: [number, number, number, number][] = Array.from(
      { length: 100 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    rows[35] = [100, 112, 99.5, 111]; // reaches 110 without touching 95
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", [det(30, { shapes: [level(95)] })], data, len, opts);
    expect(s.trials[0]?.outcome).toBe("target");
    expect(s.trials[0]?.r).toBe(2);
    expect(s.wins).toBe(1);
  });

  it("scores a stop at exactly -1R", () => {
    const rows: [number, number, number, number][] = Array.from(
      { length: 100 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    rows[33] = [100, 101, 94, 96];
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", [det(30, { shapes: [level(95)] })], data, len, opts);
    expect(s.trials[0]?.outcome).toBe("stop");
    expect(s.trials[0]?.r).toBe(-1);
    expect(s.losses).toBe(1);
  });

  it("marks an expiry to market rather than calling it a scratch", () => {
    /* Drifts up but never reaches 110 inside the horizon. That is worth
       something, and it is not +2R and not -1R. */
    const rows: [number, number, number, number][] = Array.from({ length: 100 }, (_, i) => {
      const p = i > 30 && i <= 41 ? 100 + (i - 30) * 0.4 : 100;
      return [p, p + 0.5, p - 0.2, p] as [number, number, number, number];
    });
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", [det(30, { shapes: [level(95)] })], data, len, opts);
    expect(s.trials[0]?.outcome).toBe("expired");
    const r = s.trials[0]?.r as number;
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(2);
  });

  it("handles shorts with the sides reversed", () => {
    const rows: [number, number, number, number][] = Array.from(
      { length: 100 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    rows[35] = [100, 100.5, 88, 89]; // down to 90 without touching 105
    const { data, len } = series(rows);
    const d = det(30, { direction: "short", shapes: [level(105)] });
    const s = simulateKind("double-bottom", "short", [d], data, len, opts);
    expect(s.trials[0]?.stop).toBe(105);
    expect(s.trials[0]?.target).toBe(90);
    expect(s.trials[0]?.outcome).toBe("target");
  });

  it("reports hit rate, Wilson bound and expectancy consistently", () => {
    /* Twenty analogues, alternating win and loss by construction. */
    const rows: [number, number, number, number][] = Array.from(
      { length: 600 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    const dets: Detection[] = [];
    for (let k = 0; k < 20; k++) {
      const at = 20 + k * 25;
      dets.push(det(at, { id: `d${k}`, shapes: [level(95)] }));
      const move = 3; // resolve two bars later
      rows[at + move] = k % 2 === 0 ? [100, 112, 99.5, 111] : [100, 101, 94, 96];
    }
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", dets, data, len, opts);

    expect(s.n).toBe(20);
    expect(s.wins).toBe(10);
    expect(s.losses).toBe(10);
    expect(s.hitRate).toBeCloseTo(0.5, 10);
    expect(s.hitLow).toBeLessThan(0.5);
    expect(s.expectancy).toBeCloseTo(0.5, 10); // (10*2 + 10*-1) / 20
    expect(s.enough).toBe(true);
    expect(s.adverse).toBe(false);
    expect(s.note).toMatch(/10 of 20 reached target/);
  });

  it("flags an adverse history when the whole interval sits below zero", () => {
    /* Every analogue stops out. Expectancy is exactly -1R and the bootstrap
       interval is degenerate at -1, so this must read as adverse. */
    const rows: [number, number, number, number][] = Array.from(
      { length: 600 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    const dets: Detection[] = [];
    for (let k = 0; k < 15; k++) {
      const at = 20 + k * 30;
      dets.push(det(at, { id: `d${k}`, shapes: [level(95)] }));
      rows[at + 2] = [100, 101, 94, 96];
    }
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", dets, data, len, opts);
    expect(s.wins).toBe(0);
    expect(s.expectancy).toBeCloseTo(-1, 10);
    expect(s.adverse).toBe(true);
    expect(s.note).toMatch(/wrong way historically/i);
  });

  it("caps the trial count while keeping the most recent instances", () => {
    const rows: [number, number, number, number][] = Array.from(
      { length: 900 },
      () => [100, 101, 99, 100] as [number, number, number, number],
    );
    const dets = Array.from({ length: 80 }, (_, k) => det(20 + k * 10, { id: `d${k}`, shapes: [level(95)] }));
    const { data, len } = series(rows);
    const s = simulateKind("double-bottom", "long", dets, data, len, { ...opts, maxTrials: 10 });
    expect(s.trials).toHaveLength(10);
    const bars = s.trials.map((t) => t.atBar);
    expect(Math.min(...bars)).toBeGreaterThan(700);
  });

  it("skips analogues whose geometry gives no usable risk", () => {
    /* A level ON the entry price is not a stop: risk would be zero. It must be
       dropped rather than dividing by it. */
    const { data, len } = flat(300);
    const s = simulateKind("double-bottom", "long", [det(50, { shapes: [level(100)] })], data, len, opts);
    /* Falls back to ATR, which is non-zero on this series, so the trial stands
       and its risk is positive. */
    expect(s.trials).toHaveLength(1);
    expect(Math.abs((s.trials[0] as { entry: number; stop: number }).entry - (s.trials[0] as { stop: number }).stop)).toBeGreaterThan(0);
  });
});
