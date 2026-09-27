/**
 * Confidence, across every detector at once.
 *
 * WHY THIS FILE EXISTS
 * At the point it was written the suite held 2,779 passing tests and not one
 * of them looked at the MAGNITUDE of a confidence. So four detectors shipped
 * reporting 1.00 — certainty — and two of them reported it on every single
 * instance, on every instrument: `level` was 6 of 6 at exactly 1.00 on both
 * XAUUSD and ETHUSDT, and `trendline` was 2 of 2. A constant published as a
 * measurement.
 *
 * A second failure hid behind the first. `sqrt(size / 0.02)` and
 * `abs(move) / 0.05` are shares of PRICE, so the same structure scored higher
 * on a volatile instrument than a quiet one for no reason but the volatility:
 * fair value gaps averaged 0.46 on gold and 0.72 on Ethereum. The confidence
 * FILTER in the detect panel therefore meant something different on every
 * symbol, and a screener ranking by confidence was ranking by volatility.
 *
 * These tests are written against the whole registry rather than per detector,
 * because both failures were properties of the SET — no single detector's test
 * would have been the natural place to notice that four of them peg.
 */

import { describe, expect, it } from "vitest";
import { DETECTORS, runDetectors, type DetectorId } from "../src/detect/index";
import { saturate } from "../src/detect/calibrate";
import type { DetectInput } from "../src/detect/types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

/**
 * A deterministic series with real structure, at an arbitrary price scale.
 *
 * `scale` is the whole point: the same shape at 100 and at 100,000 must score
 * the same, and the same shape with twice the volatility must too. A seeded
 * xorshift keeps it reproducible without pulling in a dependency.
 */
function series(bars: number, base: number, volPct: number, seed = 12345): DetectInput {
  let x = seed >>> 0;
  const rnd = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };

  const t = new Float64Array(bars);
  const o = new Float64Array(bars);
  const h = new Float64Array(bars);
  const l = new Float64Array(bars);
  const c = new Float64Array(bars);
  const v = new Float64Array(bars);

  let price = base;
  for (let i = 0; i < bars; i++) {
    /* A slow sine gives genuine swings for the pivot-based detectors; the
       noise gives the rank-based thresholds a distribution to cut. */
    const drift = Math.sin(i / 17) * base * volPct * 3;
    const step = (rnd() - 0.5) * base * volPct * 2;
    const open = price;
    price = base + drift + step;
    t[i] = T0 + i * HOUR;
    o[i] = open;
    c[i] = price;
    h[i] = Math.max(open, price) + base * volPct * rnd();
    l[i] = Math.min(open, price) - base * volPct * rnd();
    v[i] = 1000 + rnd() * 4000;
  }
  return { t, o, h, l, c, v };
}

const ALL: DetectorId[] = DETECTORS.map((d) => d.id);

const confidences = (data: DetectInput) =>
  runDetectors(data, ALL).map((d) => ({ kind: d.kind, confidence: d.confidence }));

describe("saturate", () => {
  it("is zero at zero and one half at the half point", () => {
    expect(saturate(0, 3)).toBe(0);
    expect(saturate(3, 3)).toBe(0.5);
  });

  it("never reaches one, however extreme the input", () => {
    /* The property being bought. A weighted sum whose weights total less than
       1 then cannot produce certainty for any input at all. */
    expect(saturate(1e12, 3)).toBeLessThan(1);
    expect(saturate(Number.MAX_SAFE_INTEGER, 0.001)).toBeLessThan(1);
  });

  it("returns zero rather than NaN for degenerate inputs", () => {
    expect(saturate(-5, 3)).toBe(0);
    expect(saturate(5, 0)).toBe(0);
    expect(saturate(Number.NaN, 3)).toBe(0);
  });

  it("is monotone", () => {
    expect(saturate(1, 3)).toBeLessThan(saturate(2, 3));
    expect(saturate(2, 3)).toBeLessThan(saturate(10, 3));
  });
});

describe("no detector reports certainty", () => {
  it("keeps every confidence strictly below 1 on a normal series", () => {
    /* Four detectors failed this when it was written: level, trendline, bos
       and order-block. Two of them failed it on every instance. */
    const found = confidences(series(700, 2400, 0.004));
    expect(found.length).toBeGreaterThan(20);
    for (const d of found) {
      expect(d.confidence, `${d.kind} reported ${d.confidence}`).toBeLessThan(1);
    }
  });

  it("keeps every confidence below 1 on a violently volatile series too", () => {
    /* The direction the old formulas failed in: bigger moves, higher scores,
       no ceiling. Ten times the volatility must not produce certainty. */
    const found = confidences(series(700, 2400, 0.04));
    for (const d of found) {
      expect(d.confidence, `${d.kind} reported ${d.confidence}`).toBeLessThan(1);
    }
  });

  it("keeps every confidence inside [0, 1]", () => {
    for (const vol of [0.001, 0.004, 0.02]) {
      for (const d of confidences(series(600, 1200, vol))) {
        expect(d.confidence).toBeGreaterThanOrEqual(0);
        expect(d.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("confidence carries information", () => {
  /**
   * A detector whose confidence is the same for every instance is publishing a
   * constant. That is worse than a bad number, because `detectLevels` SORTS by
   * it before slicing to `maxLevels` — a constant means it was choosing
   * arbitrarily among ties while appearing to rank.
   */
  it("does not report one identical value for every instance of a kind", () => {
    const found = confidences(series(800, 2400, 0.005));
    const byKind = new Map<string, Set<number>>();
    for (const d of found) {
      const set = byKind.get(d.kind) ?? new Set<number>();
      set.add(Math.round(d.confidence * 1000));
      byKind.set(d.kind, set);
    }
    for (const [kind, values] of byKind) {
      const n = found.filter((d) => d.kind === kind).length;
      /* Only meaningful with several instances: one detection trivially has
         one value, and some kinds legitimately publish a fixed weight for a
         level that has no measurable gradation. Four or more identical values
         out of four or more instances is the failure mode. */
      if (n < 4) continue;
      expect(values.size, `${kind}: ${n} instances, ${values.size} distinct confidences`)
        .toBeGreaterThan(1);
    }
  });
});

describe("confidence transfers across instruments", () => {
  /**
   * The measured failure: at 1h, fair value gaps averaged 0.46 on XAUUSD and
   * 0.72 on ETHUSDT, because the formula was a share of price and Ethereum
   * moves more. Same structures, different scores, so "0.6+" in the detect
   * panel meant a different thing on every symbol.
   *
   * The test builds ONE shape at two price scales and two volatilities. Price
   * scale must not matter at all. Volatility must not matter either, once
   * every input is measured in ATR — which is the claim being made.
   */
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const meanByKind = (data: DetectInput): Map<string, number> => {
    const out = new Map<string, number[]>();
    for (const d of confidences(data)) {
      const list = out.get(d.kind) ?? [];
      list.push(d.confidence);
      out.set(d.kind, list);
    }
    return new Map([...out].map(([k, v]) => [k, mean(v)]));
  };

  it("scores the same shape the same at any price scale", () => {
    /* Gold at 2,400 and a token at 0.000024 are both on this watchlist. */
    const cheap = meanByKind(series(700, 0.000024, 0.005));
    const dear = meanByKind(series(700, 2400, 0.005));
    let compared = 0;
    for (const [kind, a] of dear) {
      const b = cheap.get(kind);
      if (b === undefined) continue;
      compared++;
      expect(Math.abs(a - b), `${kind}: ${a} vs ${b}`).toBeLessThan(0.1);
    }
    expect(compared).toBeGreaterThan(5);
  });

  it("scores the same shape the same at four times the volatility", () => {
    /* The one that actually bit. Every input is now in ATR, so a series that
       simply moves more does not become a series the terminal is more sure
       about. The tolerance is loose because the two series are not identical
       — they are the same generator at different amplitudes — but the old
       formulas differed by 0.26 on real data, far outside it. */
    const quiet = meanByKind(series(700, 2400, 0.003));
    const wild = meanByKind(series(700, 2400, 0.012));
    for (const kind of ["fvg", "order-block", "bos", "level"]) {
      const a = quiet.get(kind);
      const b = wild.get(kind);
      if (a === undefined || b === undefined) continue;
      expect(Math.abs(a - b), `${kind}: quiet ${a} vs wild ${b}`).toBeLessThan(0.15);
    }
  });
});
