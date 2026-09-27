/**
 * The survey's statistics.
 *
 * A p-value is worth nothing on the author's assurance. The tests that matter
 * here are the CALIBRATION ones: feed the machinery data with no edge in it and
 * check that it says so at about the advertised rate, and feed it data with a
 * known edge and check that it finds it. Everything else — determinism,
 * monotonicity, the empty cases — is a guard on the plumbing.
 */

import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  blockBootstrap,
  blockLength,
  DRAWS,
  NO_BOOTSTRAP,
  rng,
  seedFrom,
} from "../src/backtest/resample";

/** A deterministic normal-ish draw, so the tests do not depend on Math.random. */
function gaussians(n: number, mean: number, sd: number, seed: number): number[] {
  const next = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box-Muller. One of the pair is discarded, which is wasteful and clear.
    const u = Math.max(next(), 1e-12);
    const v = next();
    out.push(mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

/**
 * The shape a real R-multiple series has: a spike at -1 and a thin right tail.
 * Used to check the bootstrap behaves on the actual distribution rather than on
 * a Gaussian it will never see.
 */
function rMultiples(n: number, winRate: number, winR: number, seed: number): number[] {
  const next = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(next() < winRate ? winR : -1);
  return out;
}

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = Array.from({ length: 8 }, rng(1234));
    const b = Array.from({ length: 8 }, rng(1234));
    expect(a).toEqual(b);
  });

  it("gives different streams for different seeds", () => {
    expect(Array.from({ length: 4 }, rng(1))).not.toEqual(Array.from({ length: 4 }, rng(2)));
  });

  it("stays inside [0, 1)", () => {
    const next = rng(99);
    for (let i = 0; i < 5_000; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("has a mean near a half over many draws", () => {
    const next = rng(7);
    let sum = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) sum += next();
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it("survives a zero seed rather than degenerating", () => {
    const draws = Array.from({ length: 6 }, rng(0));
    expect(new Set(draws).size).toBe(6);
  });
});

describe("seedFrom", () => {
  it("is a function of the values, not of call order", () => {
    expect(seedFrom([1.5, -2.25, 3])).toBe(seedFrom([1.5, -2.25, 3]));
  });

  it("is order-sensitive — a reordered series is a different series", () => {
    expect(seedFrom([1, 2, 3])).not.toBe(seedFrom([3, 2, 1]));
  });

  it("separates values that differ only in the low bits", () => {
    expect(seedFrom([1.0000001])).not.toBe(seedFrom([1.0000002]));
  });
});

describe("blockLength", () => {
  it("is 1 for samples too small to block", () => {
    for (const n of [0, 1, 2, 3, 4]) expect(blockLength(n)).toBe(1);
  });

  it("grows about as the cube root", () => {
    expect(blockLength(64)).toBe(4);
    expect(blockLength(1000)).toBe(10);
  });

  it("never exceeds a quarter of the sample", () => {
    for (const n of [5, 8, 12, 20, 40, 100, 400]) {
      expect(blockLength(n)).toBeLessThanOrEqual(Math.floor(n / 4));
      expect(blockLength(n)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("blockBootstrap", () => {
  it("reports nothing for no observations", () => {
    expect(blockBootstrap([])).toEqual(NO_BOOTSTRAP);
    expect(blockBootstrap([[], []])).toEqual(NO_BOOTSTRAP);
  });

  it("refuses to infer from a single observation", () => {
    const r = blockBootstrap([[0.5]]);
    expect(r.mean).toBe(0.5);
    // A tight interval around a single point would be a lie about the sample.
    expect(r.p).toBe(1);
    expect(r.draws).toBe(0);
  });

  it("pools groups by trade count, matching the reported mean", () => {
    // 10 trades at +1, 30 at -1 => trade-weighted mean of -0.5, NOT the 0 an
    // equally-weighted-by-group average would give.
    const r = blockBootstrap([new Array(10).fill(1), new Array(30).fill(-1)]);
    expect(r.mean).toBeCloseTo(-0.5, 10);
  });

  it("is deterministic — the same input gives the same p", () => {
    const groups = [rMultiples(120, 0.45, 1.5, 11), rMultiples(90, 0.4, 2, 12)];
    const a = blockBootstrap(groups);
    const b = blockBootstrap(groups);
    expect(a).toEqual(b);
  });

  it("never reports p below 1/(draws+1)", () => {
    // An overwhelming edge. p must bottom out at the resolution of the draw
    // count rather than claiming an exact zero.
    const r = blockBootstrap([new Array(200).fill(1)]);
    expect(r.p).toBeCloseTo(1 / (DRAWS + 1), 10);
    expect(r.p).toBeGreaterThan(0);
  });

  it("finds a real edge in a realistic R distribution", () => {
    // 45% win rate at +2R => expectancy +0.35R. Real, and it should be found.
    const r = blockBootstrap([rMultiples(400, 0.45, 2, 2024)]);
    expect(r.mean).toBeGreaterThan(0.2);
    expect(r.p).toBeLessThan(0.05);
  });

  it("does not find an edge in a break-even rule", () => {
    // 1/3 win rate at +2R is exactly break-even before costs.
    const r = blockBootstrap([rMultiples(500, 1 / 3, 2, 555)]);
    expect(Math.abs(r.mean)).toBeLessThan(0.25);
    expect(r.p).toBeGreaterThan(0.1);
  });

  it("widens the interval when trades are serially correlated", () => {
    // Two series with the SAME values, one shuffled into runs. The blocked
    // series has the same mean and a wider sampling interval, which is the
    // whole reason blocks exist: runs of winners are less information than the
    // same number of independent winners.
    const n = 480;
    const iid = rMultiples(n, 0.5, 1, 4242);
    /* Sorting produces the same multiset — so the same mean, exactly — arranged
       as one long run of losers followed by one long run of winners. The most
       clustered arrangement the values admit. */
    const clusteredValues = [...iid].sort((a, b) => a - b);

    const flat = blockBootstrap([iid]);
    const clustered = blockBootstrap([clusteredValues]);
    expect(clustered.mean).toBeCloseTo(flat.mean, 12);
    expect(clustered.hi - clustered.lo).toBeGreaterThan(flat.hi - flat.lo);
  });

  /**
   * The prefix-sum optimisation, checked against the thing it replaced.
   *
   * `blockBootstrap` sums each block with two lookups into a prefix table over
   * the doubled series rather than by adding its elements. That is a factor-of-L
   * speedup (measured: the survey's bootstrap went from 1.13 s to 0.59 s) and it
   * is only sound if it computes the same thing. This reimplements the naive
   * version with the SAME generator and the same draw order, and requires
   * agreement to floating-point tolerance.
   */
  it("agrees with an element-wise implementation of the same resampling", () => {
    const groups = [rMultiples(300, 0.45, 2, 314), rMultiples(180, 0.4, 2.5, 159)];
    const draws = 300;

    const flat = groups.flat();
    const next = rng(seedFrom(flat));
    const total = flat.length;
    const naive: number[] = [];
    for (let b = 0; b < draws; b++) {
      let acc = 0;
      for (const g of groups) {
        const n = g.length;
        const L = Math.min(blockLength(n), n);
        let filled = 0;
        while (filled < n) {
          const start = Math.floor(next() * n);
          const take = Math.min(L, n - filled);
          for (let k = 0; k < take; k++) acc += g[(start + k) % n] as number;
          filled += take;
        }
      }
      naive.push(acc / total);
    }

    const observed = flat.reduce((a, v) => a + v, 0) / total;
    let atLeast = 0;
    for (const m of naive) if (m - observed >= observed) atLeast++;
    const expectedP = (atLeast + 1) / (draws + 1);

    const actual = blockBootstrap(groups, draws);
    expect(actual.mean).toBeCloseTo(observed, 12);
    expect(actual.p).toBeCloseTo(expectedP, 12);

    const sorted = [...naive].sort((a, b) => a - b);
    const pick = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] as number;
    /* `(1 - 0.9) / 2` is 0.04999999999999999, not 0.05, so `floor(tail * 300)` is
       14 where a hardcoded 0.05 gives 15 — a whole index apart. The module's own
       arithmetic is what this test must mirror; writing the round number here
       tests a different function and fails by exactly one observation, which is
       how this was found. The percentile granularity itself is immaterial to a
       bootstrap interval, so the module is left alone. */
    const tail = (1 - 0.9) / 2;
    expect(actual.lo).toBeCloseTo(pick(tail), 10);
    expect(actual.hi).toBeCloseTo(pick(1 - tail), 10);
  });

  it("reports the block length it used", () => {
    const r = blockBootstrap([rMultiples(1000, 0.5, 1, 8)]);
    expect(r.block).toBe(blockLength(1000));
  });

  it("brackets the mean with its percentile interval", () => {
    const r = blockBootstrap([gaussians(300, 0.3, 1, 77)]);
    expect(r.lo).toBeLessThanOrEqual(r.mean);
    expect(r.hi).toBeGreaterThanOrEqual(r.mean);
  });

  /**
   * THE CALIBRATION TESTS — the only ones that show the p-value means anything.
   *
   * Independent samples drawn from a distribution with a TRUE mean of zero. A
   * correctly calibrated one-sided test at alpha rejects about alpha of them.
   * Over-rejection would be the "inflated effective sample" failure the module
   * header describes; a test that never rejected would be useless.
   *
   * Measured over 300 runs when this was written: 5.7% at alpha 0.05, 10.7% at
   * 0.10 and 20.7% at 0.20. The bounds below are wide enough that 150 runs of
   * binomial noise cannot trip them and tight enough to catch a test that is
   * wrong by a factor of two.
   */
  it.each([
    [0.05, 0.14],
    [0.1, 0.22],
    [0.2, 0.34],
  ])("is calibrated under a true null at alpha %s", (alpha, ceiling) => {
    let rejected = 0;
    const runs = 150;
    for (let s = 0; s < runs; s++) {
      if (blockBootstrap([gaussians(200, 0, 1, 90_000 + s * 613)], 600).p < alpha) rejected++;
    }
    expect(rejected / runs).toBeLessThan(ceiling);
    // Not vacuous in the other direction either: a test that rejects nothing
    // at 20% has no power and would report "no edge" on any data at all.
    if (alpha === 0.2) expect(rejected / runs).toBeGreaterThan(0.05);
  });

  /**
   * The same check on the distribution R-multiples actually have — a spike at
   * -1 and a thin tail — rather than on a Gaussian the module will never see.
   * A 1/3 win rate at +2R is exactly break-even, so every rejection is false.
   */
  it("stays calibrated on a break-even R distribution", () => {
    let rejected = 0;
    const runs = 150;
    for (let s = 0; s < runs; s++) {
      if (blockBootstrap([rMultiples(300, 1 / 3, 2, 700_000 + s * 977)], 600).p < 0.1) rejected++;
    }
    expect(rejected / runs).toBeLessThan(0.22);
  });

  it("finds a true positive most of the time", () => {
    let found = 0;
    const runs = 40;
    for (let s = 0; s < runs; s++) {
      if (blockBootstrap([gaussians(300, 0.25, 1, 31_000 + s * 91)], 600).p < 0.1) found++;
    }
    expect(found).toBeGreaterThan(runs * 0.6);
  });
});

describe("benjaminiHochberg", () => {
  it("handles an empty set", () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it("leaves a single p-value alone", () => {
    expect(benjaminiHochberg([0.03])[0]).toBeCloseTo(0.03, 10);
  });

  it("returns q in the input order, not sorted order", () => {
    const q = benjaminiHochberg([0.5, 0.001, 0.2]);
    // The smallest p is at index 1, so the smallest q must be too.
    expect(q[1]).toBeLessThan(q[0] as number);
    expect(q[1]).toBeLessThan(q[2] as number);
  });

  it("is monotone in p", () => {
    const ps = [0.001, 0.008, 0.02, 0.04, 0.2, 0.6, 0.9];
    const q = benjaminiHochberg(ps);
    for (let i = 1; i < q.length; i++) {
      expect(q[i]).toBeGreaterThanOrEqual(q[i - 1] as number);
    }
  });

  it("raises every q at or above its p", () => {
    const ps = [0.01, 0.02, 0.03, 0.04, 0.05];
    const q = benjaminiHochberg(ps);
    ps.forEach((p, i) => expect(q[i]).toBeGreaterThanOrEqual(p - 1e-12));
  });

  it("never exceeds 1", () => {
    const q = benjaminiHochberg([0.9, 0.95, 0.99, 1]);
    for (const v of q) expect(v).toBeLessThanOrEqual(1);
  });

  it("matches the textbook worked example", () => {
    // Benjamini & Hochberg (1995), the 15-hypothesis example.
    const ps = [
      0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262,
      0.5719, 0.6528, 0.759, 1.0,
    ];
    const q = benjaminiHochberg(ps);
    // p=0.0001 at rank 1 of 15 => q = 0.0015.
    expect(q[0]).toBeCloseTo(0.0015, 6);
    // p=0.0095 at rank 4 => 0.0095*15/4 = 0.035625.
    expect(q[3]).toBeCloseTo(0.035625, 6);
    // The last is capped at 1.
    expect(q[14]).toBe(1);
  });

  it("kills the false positives a naive threshold would report", () => {
    // 78 tests, all null, one of which happens to land at p = 0.01. Uncorrected
    // it looks significant; corrected it is exactly what 78 null tests produce.
    const ps = [0.01, ...Array.from({ length: 77 }, (_, i) => 0.02 + (i / 77) * 0.98)];
    const q = benjaminiHochberg(ps);
    expect(ps[0]).toBeLessThan(0.05);
    expect(q[0]).toBeGreaterThan(0.1);
  });
});
