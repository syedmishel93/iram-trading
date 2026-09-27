/**
 * THE FEATURE MATRIX — what a router is allowed to know, and in what units.
 *
 * WHAT THESE TESTS PIN
 *
 *  1. NO LOOK-AHEAD, PROVED RATHER THAN ASSERTED. Every column is built over
 *     the whole series and then read at index `i`, which is only safe because
 *     the indicators are causal. The proof is to compute the matrix over a
 *     PREFIX and over the full series and require the shared rows to be
 *     identical. A column that peeked would differ, and nothing else in the
 *     stack — not `tsc`, not the backtest, not the router's own forward-only
 *     folds — would notice.
 *
 *  2. NO PRICE LEVEL. The same setup at $30,000 and at $60,000 must produce the
 *     same row. A model handed the level learns the year: 2021 and 2024 are
 *     separable by price alone on BTCUSDT, both were strong, and the model
 *     would score well out of sample until it met a price it had never seen.
 *
 *  3. A ROW WITH A HOLE IS NOT A ROW. Warm-up and gaps return null rather than
 *     a zero-filled row, because a zero is an observation and "unknown" is not.
 *
 *  4. VOLUME IS OMITTED, NOT DEFAULTED. A feed reporting no volume loses the
 *     column and says so — the lots-versus-units defect in a new place.
 */

import { describe, expect, it } from "vitest";
import { buildFeatures, FEATURE_WARMUP } from "../src/backtest/features";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/**
 * A series with real structure in it — a trend, a wobble and varying ranges.
 *
 * A flat or purely random series makes several columns constant, and a
 * constant column cannot show a difference that a look-ahead test is looking
 * for. `scale` multiplies every price and leaves the SHAPE alone, which is
 * exactly what the scale-free claim is about.
 */
function series(n: number, scale = 1, volume = 1000): BarView[] {
  const out: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    px += Math.sin(i / 7) * 0.9 + Math.cos(i / 23) * 1.4 + 0.05;
    const o = px;
    const c = px + Math.sin(i / 3) * 0.6;
    const h = Math.max(o, c) + 0.4 + Math.abs(Math.cos(i / 11)) * 0.5;
    const l = Math.min(o, c) - 0.4 - Math.abs(Math.sin(i / 13)) * 0.5;
    out.push({
      t: i * HOUR,
      o: o * scale,
      h: h * scale,
      l: l * scale,
      c: c * scale,
      /* volume 0 means the feed reports NONE, so the jitter must not
         reintroduce it — the fixture was wrong here first. */
      v: volume === 0 ? 0 : volume + (i % 17) * 10,
    });
  }
  return out;
}

describe("the feature matrix cannot see the future", () => {
  it("gives the same row at i whether the series ends at i or 200 bars later", () => {
    const full = series(600);
    const prefixLen = 400;
    const prefix = full.slice(0, prefixLen);

    const mFull = buildFeatures(full);
    const mPrefix = buildFeatures(prefix);

    let compared = 0;
    for (let i = FEATURE_WARMUP; i < prefixLen; i += 1) {
      const a = mPrefix.featuresAt(i);
      const b = mFull.featuresAt(i);
      expect(a === null).toBe(b === null);
      if (a === null || b === null) continue;
      compared += 1;
      for (const k of mFull.names) {
        // Not toBeCloseTo: these are the SAME arithmetic on the same inputs.
        // A tolerance here would hide a column that drifts with the future.
        expect(`${k}@${i}=${a[k]}`).toBe(`${k}@${i}=${b[k]}`);
      }
    }
    // AN AUDIT THAT PARSES NOTHING REPORTS SUCCESS. If the loop compared no
    // rows the assertions above never ran and this test proves nothing.
    expect(compared).toBeGreaterThan(100);
  });
});

describe("the feature matrix carries no price level", () => {
  it("gives the same row for the same shape at a hundred times the price", () => {
    const cheap = buildFeatures(series(400, 1));
    const dear = buildFeatures(series(400, 100));

    let compared = 0;
    for (let i = FEATURE_WARMUP; i < 400; i += 10) {
      const a = cheap.featuresAt(i);
      const b = dear.featuresAt(i);
      if (a === null || b === null) continue;
      compared += 1;
      for (const k of cheap.names) {
        // Floating point, not arithmetic identity: the inputs really are
        // different numbers here, and only the ratios have to agree.
        expect(b[k] as number).toBeCloseTo(a[k] as number, 6);
      }
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("names no column that is a price", () => {
    const m = buildFeatures(series(300));
    for (const n of m.names) {
      expect(["open", "high", "low", "close", "ema50", "ema200", "atr", "vwap"]).not.toContain(n);
    }
  });
});

describe("a row with a hole in it is not a row", () => {
  it("refuses every bar inside warm-up", () => {
    const m = buildFeatures(series(400));
    for (let i = 0; i < FEATURE_WARMUP; i += 37) expect(m.featuresAt(i)).toBeNull();
    expect(m.featuresAt(FEATURE_WARMUP + 50)).not.toBeNull();
  });

  it("refuses a bar outside the series", () => {
    const m = buildFeatures(series(300));
    expect(m.featuresAt(5000)).toBeNull();
    expect(m.featuresAt(-1)).toBeNull();
  });

  it("refuses rather than filling when the series never moves", () => {
    // Zero range everywhere: ATR is zero, so every ATR-denominated column is
    // undefined. The honest answer is no rows, not rows of zeroes.
    const flat: BarView[] = Array.from({ length: 400 }, (_, i) => ({
      t: i * HOUR,
      o: 50,
      h: 50,
      l: 50,
      c: 50,
      v: 10,
    }));
    const m = buildFeatures(flat);
    expect(m.featuresAt(350)).toBeNull();
  });
});

describe("volume is omitted rather than defaulted", () => {
  it("drops volRatio and says so when the feed reports none", () => {
    const m = buildFeatures(series(400, 1, 0));
    expect(m.names).not.toContain("volRatio");
    expect(m.omitted.join(" ")).toContain("volRatio");
    // The rest of the matrix still works — losing one column is not losing all.
    expect(m.featuresAt(350)).not.toBeNull();
  });

  it("drops it when only a handful of bars carry any, which is worse than none", () => {
    // A feed reporting zero on most bars and a tick count on a few produces a
    // ratio that is mostly undefined and occasionally enormous. "Some bars have
    // a number in them" is not the same as "this series has volume".
    const sparse = series(400).map((b, i) => ({ ...b, v: i % 10 === 0 ? 900 : 0 }));
    const m = buildFeatures(sparse);
    expect(m.names).not.toContain("volRatio");
  });

  it("keeps volRatio when the feed reports volume", () => {
    const m = buildFeatures(series(400, 1, 1000));
    expect(m.names).toContain("volRatio");
    expect(m.omitted).toHaveLength(0);
    const row = m.featuresAt(350);
    expect(row).not.toBeNull();
    expect((row as Record<string, number>)["volRatio"]).toBeGreaterThan(0);
  });
});

describe("the columns are in the units they claim", () => {
  it("keeps bounded oscillators inside their bounds", () => {
    const m = buildFeatures(series(600));
    let seen = 0;
    for (let i = FEATURE_WARMUP; i < 600; i += 1) {
      const r = m.featuresAt(i);
      if (r === null) continue;
      seen += 1;
      expect(r["rsi14"] as number).toBeGreaterThanOrEqual(0);
      expect(r["rsi14"] as number).toBeLessThanOrEqual(100);
      expect(r["adx14"] as number).toBeGreaterThanOrEqual(0);
      expect(r["hourUtc"] as number).toBeGreaterThanOrEqual(0);
      expect(r["hourUtc"] as number).toBeLessThanOrEqual(23);
      expect(r["dayOfWeek"] as number).toBeGreaterThanOrEqual(0);
      expect(r["dayOfWeek"] as number).toBeLessThanOrEqual(6);
      expect(r["bodyShare"] as number).toBeGreaterThanOrEqual(0);
      expect(r["bodyShare"] as number).toBeLessThanOrEqual(1);
    }
    expect(seen).toBeGreaterThan(100);
  });
});
