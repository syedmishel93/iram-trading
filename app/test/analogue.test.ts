/**
 * THE ANALOGUE FORECAST, AND THE FOUR WAYS IT COULD LIE.
 *
 * `analysis/analogue.ts` draws the next candle from what followed the most
 * similar past bars. Every failure mode it has is silent — a leak produces a
 * SUPERB replay and a useless forecast, and nothing is red — so each one is
 * pinned here rather than argued in a comment.
 *
 *   1. A feature that reads forward.        → truncation test
 *   2. A price level in the feature set.    → rescale invariance test
 *   3. A neighbour that overlaps the query. → pool boundary test
 *   4. Accuracy reported as skill.          → no-information rate test
 *
 * The one that matters most is (1): a matrix that peeks one bar ahead is
 * undetectable from the output and would make every number in this file look
 * better.
 */

import { describe, expect, it } from "vitest";
import {
  FEATURE_COUNT,
  MIN_POOL,
  PURGE,
  WARMUP,
  analogueForecast,
  buildFeatures,
  replayAnalogue,
} from "../src/analysis/analogue";
import type { BarView } from "../src/chart/series";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

/** Deterministic noise, so a failing run is reproducible. */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function walk(n: number, seed = 5, drift = 0): BarView[] {
  const r = rnd(seed);
  const out: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + drift + (r() - 0.5) * 0.02);
    const c = px;
    out.push({
      t: T0 + i * MIN,
      o,
      h: Math.max(o, c) * (1 + r() * 0.004),
      l: Math.min(o, c) * (1 - r() * 0.004),
      c,
      v: 100 + r() * 50,
    });
  }
  return out;
}

describe("the feature matrix", () => {
  it("IS CAUSAL — a row is identical when every later bar is removed", () => {
    /* The defect this whole file exists to make impossible. A feature that read
       one bar forward would produce a beautiful replay and a forecast that
       could never be traded, and nothing in the output would say so. */
    const bars = walk(900, 11);
    const full = buildFeatures(bars);
    for (const i of [300, 500, 800]) {
      const short = buildFeatures(bars.slice(0, i + 1));
      const a = full.rows[i];
      const b = short.rows[i];
      expect(b, `row ${i} vanished when later bars were removed`).not.toBeNull();
      const ra = a as readonly number[];
      const rb = b as readonly number[];
      /* THE WHOLE ROW, NOT THE FIRST `FEATURE_COUNT` OF IT. The first version of
         this test looped to FEATURE_COUNT, so a leaked ELEVENTH feature was
         never looked at and the test passed with a forward-reading column
         injected. Proved by injecting one. Compare the length too, or the check
         silently narrows to whatever the constant happens to say. */
      expect(rb.length, `row ${i} changed width`).toBe(ra.length);
      expect(ra.length).toBe(FEATURE_COUNT);
      for (let d = 0; d < ra.length; d++) {
        expect(
          rb[d],
          `feature ${d} at bar ${i} changed when later bars were removed`,
        ).toBeCloseTo(ra[d] as number, 10);
      }
    }
  });

  it("CARRIES NO PRICE LEVEL — every feature survives rescaling the whole series", () => {
    /* A distance handed `close` learns the YEAR: on BTCUSDT 2021 and 2024 are
       separable by price alone, so every neighbour of today's bar would simply
       be a bar from this month. Multiplying the series by a constant must
       change nothing, which is only true if no level got in. */
    const bars = walk(400, 3);
    const scaled = bars.map((b) => ({ ...b, o: b.o * 3.7, h: b.h * 3.7, l: b.l * 3.7, c: b.c * 3.7 }));
    const a = buildFeatures(bars);
    const b = buildFeatures(scaled);
    for (const i of [150, 250, 390]) {
      const ra = a.rows[i] as readonly number[];
      const rb = b.rows[i] as readonly number[];
      expect(rb.length).toBe(ra.length);
      for (let d = 0; d < ra.length; d++) {
        expect((rb[d] as number), `feature ${d} moved when the price scale changed`).toBeCloseTo(
          ra[d] as number,
          8,
        );
      }
    }
  });

  it("KEEPS ITS FLAT MIRROR AND ITS PREFIX SUMS IN STEP WITH `rows`", () => {
    /* `flat`, `ok`, `sum`, `sumSq` and `count` are the SAME FACT as `rows`,
       duplicated on purpose because the distance loop runs pool x features
       times per query and the spread has to come out in O(1). A deliberate
       second copy needs a test, or the two drift and the forecast quietly
       becomes a distance over stale numbers. Measured 8.5x for the duplication,
       so it earns its keep — and this is the rent. */
    const bars = walk(700, 37);
    const f = buildFeatures(bars);
    let present = 0;
    for (let i = 0; i < bars.length; i++) {
      const row = f.rows[i];
      expect(f.ok[i] === 1, `ok[${i}] disagreed with rows[${i}]`).toBe(row != null);
      if (row == null) continue;
      present++;
      for (let d = 0; d < FEATURE_COUNT; d++) {
        expect(f.flat[i * FEATURE_COUNT + d], `flat[${i}][${d}] drifted`).toBe(row[d]);
      }
    }
    expect(present, "no rows were built, so nothing was compared").toBeGreaterThan(100);
    expect(f.count[bars.length]).toBe(present);

    /* The prefix sums must reproduce a range total computed the long way. */
    const a = 200;
    const b = 600;
    for (let d = 0; d < FEATURE_COUNT; d++) {
      let direct = 0;
      for (let i = a; i < b; i++) {
        const row = f.rows[i];
        if (row != null) direct += row[d] as number;
      }
      const viaPrefix =
        (f.sum[b * FEATURE_COUNT + d] as number) - (f.sum[a * FEATURE_COUNT + d] as number);
      expect(viaPrefix, `prefix sum for feature ${d} disagreed with the direct total`).toBeCloseTo(
        direct,
        6,
      );
    }
  });

  it("refuses a row it cannot build rather than filling it with zeros", () => {
    const bars = walk(120, 7);
    for (let i = 0; i < WARMUP; i++) {
      expect(buildFeatures(bars).rows[i], `bar ${i} built a row inside the warm-up`).toBeNull();
    }
  });
});

describe("the forecast", () => {
  it("IS CAUSAL — unchanged when every bar after the query is removed", () => {
    const bars = walk(900, 13);
    const at = 700;
    const full = analogueForecast(bars, buildFeatures(bars), at);
    const short = bars.slice(0, at + 1);
    const cut = analogueForecast(short, buildFeatures(short), at);
    expect(full).not.toBeNull();
    expect(cut).not.toBeNull();
    expect((cut as { close: number }).close).toBeCloseTo((full as { close: number }).close, 8);
    expect((cut as { high: number }).high).toBeCloseTo((full as { high: number }).high, 8);
  });

  it("NEEDS A POOL CLEAR OF THE PURGE WINDOW, and refuses one bar short of it", () => {
    /* Candidates run [WARMUP, at − PURGE), so the first bar that can be
       forecast is WARMUP + PURGE + MIN_POOL. One below it must refuse — a
       forecast built on a pool that quietly shrank is the version of this that
       nobody would ever notice. */
    const need = WARMUP + PURGE + MIN_POOL;
    const bars = walk(need + 40, 17);
    expect(analogueForecast(bars, buildFeatures(bars), need - 1)).toBeNull();
    expect(analogueForecast(bars, buildFeatures(bars), need)).not.toBeNull();
  });

  it("OPENS AT THE LAST CLOSE and keeps the wicks outside the body", () => {
    /* A candle whose high sits below its close is not a rendering glitch, it is
       a drawing that says something impossible. The three medians are taken
       independently and nothing else makes them agree. */
    const bars = walk(700, 23);
    for (const at of [400, 550, 698]) {
      const f = analogueForecast(bars, buildFeatures(bars), at);
      if (f === null) continue;
      expect(f.open).toBeCloseTo((bars[at] as BarView).c, 10);
      expect(f.high).toBeGreaterThanOrEqual(Math.max(f.open, f.close));
      expect(f.low).toBeLessThanOrEqual(Math.min(f.open, f.close));
    }
  });

  it("reports how many neighbours it used and how much they agreed", () => {
    const bars = walk(800, 29);
    const f = analogueForecast(bars, buildFeatures(bars), 700);
    expect(f).not.toBeNull();
    const g = f as { n: number; agree: number; why: string };
    expect(g.n).toBeGreaterThan(10);
    expect(g.agree).toBeGreaterThanOrEqual(0.5);
    expect(g.agree).toBeLessThanOrEqual(1);
    expect(g.why).toMatch(/\d/);
  });

  it("refuses on a series too short to have analogues", () => {
    const bars = walk(150, 31);
    expect(analogueForecast(bars, buildFeatures(bars), 140)).toBeNull();
  });

  it("FINDS A PLANTED RELATIONSHIP — an unusually wide bar is followed by a rise", () => {
    /* If it cannot recover an edge that is really there it cannot be trusted to
       deny one, which is what it spends its life doing. */
    const bars = walk(1200, 41);
    for (let i = WARMUP; i < bars.length - 1; i += 13) {
      const prev = bars[i - 1] as BarView;
      /* A distinctive, scale-free signature: a very wide down bar. */
      bars[i] = { t: T0 + i * MIN, o: prev.c, h: prev.c * 1.004, l: prev.c * 0.94, c: prev.c * 0.95, v: 100 };
      const base = bars[i] as BarView;
      bars[i + 1] = {
        t: T0 + (i + 1) * MIN,
        o: base.c,
        h: base.c * 1.05,
        l: base.c * 0.999,
        c: base.c * 1.04,
        v: 100,
      };
    }
    /* Query a bar carrying that same signature. */
    const at = 1196 - ((1196 - WARMUP) % 13);
    const f = analogueForecast(bars, buildFeatures(bars), at);
    expect(f).not.toBeNull();
    const g = f as { close: number; open: number; agree: number };
    expect(g.close, "a planted upward move came back as a fall").toBeGreaterThan(g.open);
    expect(g.agree).toBeGreaterThan(0.7);
  });
});

describe("scoring it — accuracy is not skill", () => {
  it("FINDS NO SKILL IN A RANDOM WALK, which is the case that matters", () => {
    const bars = walk(900, 71);
    const s = replayAnalogue(bars, buildFeatures(bars), 250);
    expect(s).not.toBeNull();
    expect((s as { skill: boolean }).skill, "skill was claimed on a random walk").toBe(false);
  });

  it("COMPARES AGAINST THE MAJORITY CLASS, not against 50%", () => {
    /* On a series that rises 7 bars in 10, calling "up" every time scores 70%.
       A hit rate quoted against a coin would report that as excellent. */
    const bars = walk(900, 83, 0.004);
    const s = replayAnalogue(bars, buildFeatures(bars), 250);
    expect(s).not.toBeNull();
    const g = s as { noInfoRate: number; hitRate: number; skill: boolean; z: number };
    expect(g.noInfoRate).toBeGreaterThan(0.5);
    /* Whatever the hit rate is, skill has to be measured against that rate. */
    expect(g.skill).toBe(g.z > 1.96);
    if (g.hitRate <= g.noInfoRate) expect(g.skill).toBe(false);
  });

  it("BENCHMARKS THE RANGE AGAINST FLAT ATR, because a tie means it IS ATR", () => {
    /* This codebase has already shipped one readout that turned out to be ATR
       printed twice. The benchmark is part of the result, not a footnote. */
    const bars = walk(900, 91);
    const s = replayAnalogue(bars, buildFeatures(bars), 250);
    const g = s as { rangeErr: number; atrErr: number };
    expect(Number.isFinite(g.rangeErr)).toBe(true);
    expect(Number.isFinite(g.atrErr)).toBe(true);
  });

  it("refuses to score a window it cannot fill", () => {
    expect(replayAnalogue(walk(100, 97), buildFeatures(walk(100, 97)), 250)).toBeNull();
  });
});
