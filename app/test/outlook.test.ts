import { describe, expect, it } from "vitest";
import { ewmaSigma, EWMA_LAMBDA } from "../src/analysis/forecast";
import {
  coneSteps,
  MIN_OUTLOOK_BARS,
  outlookCalibration,
  outlookCone,
  sigmaSeries,
  simulateOutlook,
  simulatePaths,
  touchOdds,
  type SimulatedPaths,
} from "../src/analysis/outlook";
import type { BarView } from "../src/chart/series";

/** A geometric Gaussian random walk with a fixed per-bar volatility (as in forecast.test.ts). */
function walk(n: number, sigma: number, seed = 7): BarView[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const normal = (): number => {
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const bars: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * Math.exp(normal() * sigma);
    bars.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h: Math.max(o, px), l: Math.min(o, px), c: px, v: 1 });
  }
  return bars;
}

/** Every number reachable in a result, so "never NaN/Infinity" can be asserted wholesale. */
function numbers(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number") out.push(x);
  else if (x !== null && typeof x === "object" && !(x instanceof Float64Array))
    for (const v of Object.values(x)) numbers(v, out);
  return out;
}

describe("sigmaSeries", () => {
  /* The one-pass series is what licenses not calling ewmaSigma n times, so it
     must agree with ewmaSigma on every prefix — an independent code path. */
  it("equals ewmaSigma(bars.slice(0, i)) at every i", () => {
    const bars = walk(400, 0.01, 3);
    const sig = sigmaSeries(bars, EWMA_LAMBDA);
    for (let i = 31; i <= bars.length; i++) {
      const ref = ewmaSigma(bars.slice(0, i));
      expect(Math.abs((sig[i] as number) - ref) / ref).toBeLessThan(1e-12);
    }
    expect(Number.isNaN(sig[30] as number)).toBe(true);
  });
});

describe("simulatePaths / coneSteps", () => {
  /* Pool of identical residuals: every path is the same deterministic line, so
     all five quantiles collapse to last·exp(h·z·sigma).
     h=1:  100·e^(0.5·0.02·1)  = 100·e^0.01 = 101.00501670841679
     h=24: 100·e^(0.5·0.02·24) = 100·e^0.24 = 127.12491503214047 */
  it("collapses to a hand-computed price when every residual is equal", () => {
    const paths = simulatePaths(100, 0.02, [0.5, 0.5, 0.5], 24, 50, 1);
    const steps = coneSteps(paths);
    expect(steps).toHaveLength(24);
    const one = steps[0]!;
    const last = steps[23]!;
    expect(one.h).toBe(1);
    for (const q of [one.p5, one.p25, one.p50, one.p75, one.p95]) expect(q).toBeCloseTo(101.00501670841679, 9);
    expect(last.h).toBe(24);
    for (const q of [last.p5, last.p25, last.p50, last.p75, last.p95]) expect(q).toBeCloseTo(127.12491503214047, 9);
  });

  /* Type-7 quantiles on 5 paths whose single step is 1..5 (sorted, m=5):
     p5 → pos 0.2 → 1.2; p25 → pos 1 → 2; p50 → 3; p75 → 4; p95 → pos 3.8 → 4.8. */
  it("uses linear-interpolated quantiles a spreadsheet reproduces", () => {
    const paths: SimulatedPaths = { last: 3, draws: 5, horizon: 1, closes: Float64Array.from([5, 1, 4, 2, 3]) };
    const [s] = coneSteps(paths);
    expect(s!.p5).toBeCloseTo(1.2, 12);
    expect(s!.p25).toBe(2);
    expect(s!.p50).toBe(3);
    expect(s!.p75).toBe(4);
    expect(s!.p95).toBeCloseTo(4.8, 12);
  });
});

describe("simulateOutlook", () => {
  const bars = walk(1000, 0.01, 13);

  it("is deterministic by seed, and the default seed comes from the data", () => {
    const a = simulateOutlook(bars, { seed: 42 });
    const b = simulateOutlook(bars, { seed: 42 });
    const c = simulateOutlook(bars, { seed: 43 });
    if (!a.ok || !b.ok || !c.ok) throw new Error("refused");
    expect(Array.from(a.paths.closes)).toEqual(Array.from(b.paths.closes));
    expect(Array.from(a.paths.closes)).not.toEqual(Array.from(c.paths.closes));
    const d1 = outlookCone(bars);
    const d2 = outlookCone(bars);
    if (!d1.ok || !d2.ok) throw new Error("refused");
    expect(d1.seed).toBe(d2.seed);
    expect(d1.steps).toEqual(d2.steps);
  });

  it("orders quantiles at every horizon and widens the band with horizon", () => {
    const o = outlookCone(bars, { seed: 5 });
    if (!o.ok) throw new Error(o.refused);
    expect(o.steps).toHaveLength(24);
    expect(o.draws).toBe(2000);
    expect(o.horizon).toBe(24);
    expect(o.n).toBe(1000 - 120);
    for (const s of o.steps) {
      expect(s.p5).toBeLessThanOrEqual(s.p25);
      expect(s.p25).toBeLessThanOrEqual(s.p50);
      expect(s.p50).toBeLessThanOrEqual(s.p75);
      expect(s.p75).toBeLessThanOrEqual(s.p95);
    }
    /* Widening is asserted on well-separated horizons, not bar to bar: between
       h=23 and h=24 the true width grows by ~2% (sqrt(24/23)) while the
       Monte-Carlo error of a p5/p95 from 2000 paths is ~3%, so adjacent steps
       can cross by chance. For iid draws the width grows as sqrt(h), so
       w(24)/w(1) should be near sqrt(24) = 4.90; 4.2–5.6 allows the sampling
       error of both quantiles plus the mild skew exp() adds at the top. */
    const w = (h: number): number => o.steps[h - 1]!.p95 - o.steps[h - 1]!.p5;
    expect(w(4)).toBeGreaterThan(w(1));
    expect(w(9)).toBeGreaterThan(w(4));
    expect(w(16)).toBeGreaterThan(w(9));
    expect(w(24)).toBeGreaterThan(w(16));
    expect(w(24) / w(1)).toBeGreaterThan(4.2);
    expect(w(24) / w(1)).toBeLessThan(5.6);
    expect(o.sigmaNow).toBe(ewmaSigma(bars));
    expect(o.pUp).toBe(o.up / o.draws);
    expect(o.basis).toBe("modelled");
    expect(o.assumptions.join(" ")).toContain("not a directional forecast");
    expect(numbers(o).every(Number.isFinite)).toBe(true);
  });

  it("runs touch odds on the same paths as the cone", () => {
    const o = simulateOutlook(bars, { seed: 9 });
    if (!o.ok) throw new Error(o.refused);
    const last = o.cone.last;
    const t = o.touch({ direction: "long", entry: last, stop: last * 0.97, target1: last * 1.03 });
    expect(t).toEqual(touchOdds(o.paths, { direction: "long", entry: last, stop: last * 0.97, target1: last * 1.03 }));
  });

  it("refuses under 300 bars, on flat prices and on a bad close", () => {
    const short = simulateOutlook(walk(MIN_OUTLOOK_BARS - 1, 0.01));
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.refused).toContain("299 bars");
    expect(simulateOutlook(walk(MIN_OUTLOOK_BARS, 0.01)).ok).toBe(true);

    const flat = walk(400, 0.01).map((b) => ({ ...b, c: 50 }));
    expect(simulateOutlook(flat).ok).toBe(false);

    const holed = walk(400, 0.01).map((b, i) => (i === 200 ? { ...b, c: 0 } : b));
    const h = simulateOutlook(holed);
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.refused).toContain("Bar 200");

    expect(simulateOutlook(bars, { horizon: 0 }).ok).toBe(false);
    expect(simulateOutlook(bars, { draws: 2.5 }).ok).toBe(false);
  });
});

describe("touchOdds", () => {
  /* Hand-built: last 100, horizon 3, four paths.
       p0: 101, 103, 104  long: T1 at step 2, T2 at step 3
       p1:  99,  97, 105  long: stop at step 2
       p2: 100.5, 99, 101 long: neither
       p3: 102,  97, 110  long: T1 at step 1, then stop — T2 never reached
     Long (stop 98, T1 102, T2 104): T1 2, stop 1, neither 1, T2 1.
     Short (stop 102, T1 98): p0 stop (103), p1 T1 (97), p2 neither, p3 stop (102). */
  const paths: SimulatedPaths = {
    last: 100,
    draws: 4,
    horizon: 3,
    closes: Float64Array.from([101, 103, 104, 99, 97, 105, 100.5, 99, 101, 102, 97, 110]),
  };

  it("counts a long plan by hand", () => {
    const t = touchOdds(paths, { direction: "long", entry: 100, stop: 98, target1: 102, target2: 104 });
    if (!t.ok) throw new Error(t.refused);
    expect(t.counts).toEqual({ target1: 2, stop: 1, neither: 1, target2: 1 });
    expect(t.target1First).toBe(0.5);
    expect(t.stopFirst).toBe(0.25);
    expect(t.neither).toBe(0.25);
    expect(t.target2First).toBe(0.25);
    expect(t.assumptions.join(" ")).toContain("understated");
  });

  it("counts a short plan by hand", () => {
    const t = touchOdds(paths, { direction: "short", entry: 100, stop: 102, target1: 98 });
    if (!t.ok) throw new Error(t.refused);
    expect(t.counts).toEqual({ target1: 1, stop: 2, neither: 1, target2: null });
    expect(t.target2First).toBeNull();
  });

  it("refuses a stop on the wrong side and levels already crossed", () => {
    expect(touchOdds(paths, { direction: "long", entry: 100, stop: 101, target1: 105 }).ok).toBe(false);
    expect(touchOdds(paths, { direction: "short", entry: 100, stop: 99, target1: 95 }).ok).toBe(false);
    expect(touchOdds(paths, { direction: "long", entry: 100, stop: 98, target1: 102, target2: 101 }).ok).toBe(false);
    expect(touchOdds(paths, { direction: "long", entry: 95, stop: 90, target1: 99 }).ok).toBe(false);
    expect(touchOdds(paths, { direction: "long", entry: 104, stop: 101, target1: 110 }).ok).toBe(false);
    expect(touchOdds(paths, { direction: "long", entry: 100, stop: NaN, target1: 102 }).ok).toBe(false);
  });
});

describe("outlookCalibration", () => {
  /* A Gaussian walk with constant vol is the model's best case, so the 90%
     band should hold close to 90%. Why 0.80–0.97 is the honest tolerance:
     3000 bars at stride 24 from bar 299 give 112 trials, and a binomial at
     p=0.9 over 112 has a standard deviation of sqrt(0.09/112) ≈ 0.028 — so
     ±2.5 sd alone is 0.83–0.97. On top of that the EWMA sigma is itself an
     estimate (λ=0.94 averages ~30 effective bars, ~12% relative error), and
     noise in the scale makes a band UNDER-cover on average, so the lower
     bound is given more room than the upper. The fixture is seeded, so the
     test is deterministic; the range says what any seed should satisfy. */
  it("holds near 0.90 on a constant-vol Gaussian walk", () => {
    const c = outlookCalibration(walk(3000, 0.01, 17));
    if (!c.ok) throw new Error(c.refused);
    expect(c.trials).toBe(112);
    expect(c.stride).toBe(24);
    expect(c.draws).toBe(500);
    expect(c.usable).toBe(true);
    expect(c.coverage).toBeGreaterThan(0.8);
    expect(c.coverage).toBeLessThan(0.97);
    expect(c.coverage).toBe(c.inside / c.trials);
    expect(c.note).toContain("112 past checks");
    expect(c.basis).toBe("measured");
  });

  it("says it is unusable under 30 trials, and refuses with no trial at all", () => {
    /* 1000 bars: origins 299, 323, ..., 971 (971 + 24 = 995 < 1000; 995 + 24 ≥ 1000) → 29 trials. */
    const c = outlookCalibration(walk(1000, 0.01, 17));
    if (!c.ok) throw new Error(c.refused);
    expect(c.trials).toBe(29);
    expect(c.usable).toBe(false);
    expect(c.note).toContain("too few");
    expect(outlookCalibration(walk(MIN_OUTLOOK_BARS + 23, 0.01)).ok).toBe(false);
  });
});
