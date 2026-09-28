/**
 * A FORECAST CANDLE — and the refusal that has to survive it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT `analysis/forecast.ts` SAYS, AND WHY IT IS RIGHT
 *
 * That file opens by refusing this outright: "There is no next-candle direction
 * call here and there will not be one… A terminal that prints 'next candle: UP
 * 71%' is not more powerful than one that does not — it is converting its own
 * noise into your position size, which is the single most expensive thing a tool
 * like this can do to somebody."
 *
 * The owner asked for a drawn candle anyway, with patterns and trend, so they
 * can SEE a prediction and find out whether it was right. That last clause is
 * what makes an honest version possible: the danger in the refusal is an
 * unscored confident number, not a drawn and measured one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SO THE DIRECTION IS EARNED, NEVER ASSUMED
 *
 * 1. A pattern's edge is MEASURED ON THIS SERIES — every past occurrence, the
 *    next bar's return, a mean and a standard error. Not a textbook claim about
 *    what a bullish harami "means".
 * 2. Measuring several patterns and drawing the best one IS A SEARCH, and the
 *    best of N looks good under pure noise. It is charged for with the same
 *    `expectedMaxNormal` the strategy search uses.
 * 3. When nothing clears that bar — which is the common case — the candle is
 *    drawn with NO DIRECTION: open equals close, and it says why.
 *
 * The body is the only part that is ever a claim. The high and low come from the
 * volatility model, which `forecast.ts` argues is genuinely forecastable and
 * which already checks its own calibration.
 */

import { describe, expect, it } from "vitest";
import {
  PATTERNS,
  matchPatterns,
  patternEdge,
  bestEdge,
  forecastCandle,
  scoreCandle,
  MIN_OCCURRENCES,
  type PatternName,
} from "../src/analysis/nextcandle";
import type { BarView } from "../src/chart/series";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

const bar = (o: number, h: number, l: number, c: number, i = 0): BarView => ({
  t: T0 + i * MIN,
  o,
  h,
  l,
  c,
  v: 100,
});

/** Deterministic noise, so a failing run is reproducible. */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A random walk with no pattern edge in it whatsoever. */
function noiseBars(n: number, seed = 5): BarView[] {
  const r = rnd(seed);
  const out: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + (r() - 0.5) * 0.02);
    const c = px;
    out.push(bar(o, Math.max(o, c) * (1 + r() * 0.003), Math.min(o, c) * (1 - r() * 0.003), c, i));
  }
  return out;
}

describe("the patterns themselves", () => {
  it("EVERY PATTERN IS CAUSAL — it reads only the bar it fires on and those before", () => {
    /* The whole forecast rests on this. A matcher that peeked one bar forward
       would produce a beautiful measured edge and a useless forecast. Checked by
       truncation: a pattern that fires at bar i on a long series must fire at
       bar i on a series that ends at i. */
    const bars = noiseBars(400, 11);
    for (const name of PATTERNS) {
      for (const i of [120, 200, 310]) {
        const onFull = matchPatterns(bars, i).includes(name);
        const onShort = matchPatterns(bars.slice(0, i + 1), i).includes(name);
        expect(onShort, `${name} @${i} changed when later bars were removed`).toBe(onFull);
      }
    }
  });

  it("finds a bullish engulfing where one plainly is", () => {
    const bars = [bar(100, 100.5, 98.5, 99, 0), bar(98.8, 101.5, 98.6, 101, 1)];
    expect(matchPatterns(bars, 1)).toContain("bullish-engulfing");
  });

  it("finds a bullish harami, and does not confuse it with engulfing", () => {
    /* The owner named this one. It is the mirror of engulfing: a LARGE down bar
       followed by a small up bar contained inside it. */
    const bars = [bar(102, 102.2, 98, 98.2, 0), bar(99, 100.4, 98.9, 100.2, 1)];
    const got = matchPatterns(bars, 1);
    expect(got).toContain("bullish-harami");
    expect(got).not.toContain("bullish-engulfing");
  });

  it("finds a hammer by its lower wick, not by its colour", () => {
    const bars = [bar(100, 100.2, 99.8, 100, 0), bar(100, 100.3, 97, 100.1, 1)];
    expect(matchPatterns(bars, 1)).toContain("hammer");
  });

  it("fires nothing on a featureless bar", () => {
    const bars = [bar(100, 100.4, 99.6, 100.05, 0), bar(100.05, 100.4, 99.7, 100.1, 1)];
    expect(matchPatterns(bars, 1)).toEqual([]);
  });

  it("needs a previous bar, and says nothing at the start of a series", () => {
    expect(matchPatterns([bar(100, 101, 99, 100.5, 0)], 0)).toEqual([]);
  });
});

describe("measuring a pattern's edge on THIS series", () => {
  it("RECOVERS AN EDGE THAT IS REALLY THERE", () => {
    /* Built so that every bullish engulfing is followed by a rise. If the
       measurement cannot find a planted edge it cannot be trusted to deny one. */
    const bars = noiseBars(600, 3);
    for (let i = 2; i < bars.length - 1; i += 17) {
      const prev = bars[i - 1] as BarView;
      bars[i] = bar(prev.c * 0.995, prev.c * 1.02, prev.c * 0.99, prev.c * 1.015, i);
      const nx = bars[i + 1] as BarView;
      bars[i + 1] = bar(nx.o, nx.o * 1.03, nx.o * 0.999, nx.o * 1.025, i + 1);
    }
    const e = patternEdge(bars, "bullish-engulfing");
    expect(e.n).toBeGreaterThan(MIN_OCCURRENCES);
    expect(e.mean, "a planted upward edge came back negative").toBeGreaterThan(0);
    expect(Math.abs(e.t)).toBeGreaterThan(2);
  });

  it("FINDS NO EDGE IN PURE NOISE — the case that matters most", () => {
    const bars = noiseBars(900, 77);
    const usable = PATTERNS.map((p) => patternEdge(bars, p)).filter((e) => e.usable);
    expect(usable.map((e) => e.pattern), "an edge was invented out of a random walk").toEqual([]);
  });

  it("REFUSES A THIN SAMPLE rather than quoting a mean of four", () => {
    const bars = noiseBars(60, 9);
    for (const p of PATTERNS) {
      const e = patternEdge(bars, p);
      if (e.n < MIN_OCCURRENCES) {
        expect(e.usable, `${p} reported usable on ${e.n} occurrences`).toBe(false);
        expect(e.why).toMatch(/\d/);
      }
    }
  });

  it("reports the sample and the error beside every mean", () => {
    const bars = noiseBars(500, 21);
    const e = patternEdge(bars, "inside-bar");
    expect(e.n).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(e.stdErr) || e.n < 2).toBe(true);
    expect(e.why.length).toBeGreaterThan(20);
  });
});

describe("picking the best pattern is a SEARCH and is charged for", () => {
  it("RAISES THE BAR WITH THE NUMBER OF PATTERNS TRIED", () => {
    /* The best of six looks better than one by luck alone. `expectedMaxNormal`
       is the same charge the strategy search pays. */
    const bars = noiseBars(800, 31);
    const strict = bestEdge(bars, PATTERNS);
    const single = bestEdge(bars, [PATTERNS[0] as PatternName]);
    expect(strict.hurdle, "a wider search must cost more").toBeGreaterThan(single.hurdle);
  });

  it("returns nothing usable on a random walk, however many patterns are tried", () => {
    const best = bestEdge(noiseBars(900, 101), PATTERNS);
    expect(best.edge).toBeNull();
    expect(best.why).toMatch(/none|no pattern|nothing/i);
  });
});

describe("the forecast candle", () => {
  const range = { low: 99, high: 101, expected: 1, confidence: 0.8, sigma: 0.01, percentile: 0.5, n: 300 };

  it("OPENS AT THE LAST CLOSE, and says that is an assumption", () => {
    const bars = noiseBars(200, 4);
    const last = bars[bars.length - 1] as BarView;
    const f = forecastCandle(bars, range, null);
    expect(f.open).toBeCloseTo(last.c, 8);
    expect(f.why).toMatch(/open|gap/i);
  });

  it("HAS NO DIRECTION WHEN NOTHING WAS MEASURED — open equals close", () => {
    /* The common case, and the one the whole design turns on. A body drawn on no
       evidence is the thing `forecast.ts` refuses. */
    const f = forecastCandle(noiseBars(200, 6), range, null);
    expect(f.close).toBe(f.open);
    expect(f.basis).toBe("none");
  });

  it("takes a direction only from a measured edge, and names the pattern", () => {
    const f = forecastCandle(noiseBars(200, 6), range, {
      pattern: "bullish-engulfing",
      n: 80,
      mean: 0.004,
      stdErr: 0.001,
      t: 4,
      usable: true,
      why: "measured",
    });
    expect(f.close).toBeGreaterThan(f.open);
    expect(f.basis).toBe("pattern");
    expect(f.why).toContain("bullish-engulfing");
  });

  it("KEEPS THE BODY INSIDE THE BAND, so the drawing cannot contradict itself", () => {
    /* A close above the forecast high would be a candle that escapes its own
       interval — visibly incoherent, and an invitation to trust the body over
       the band that was actually calibrated. */
    const f = forecastCandle(noiseBars(200, 8), range, {
      pattern: "hammer",
      n: 90,
      mean: 5,
      stdErr: 0.1,
      t: 50,
      usable: true,
      why: "measured",
    });
    expect(f.close).toBeLessThanOrEqual(f.high);
    expect(f.close).toBeGreaterThanOrEqual(f.low);
  });

  it("refuses on too little history rather than drawing something", () => {
    expect(forecastCandle([bar(100, 101, 99, 100, 0)], range, null)).toMatchObject({ basis: "none" });
  });
});

describe("scoring it afterwards", () => {
  const f = { open: 100, high: 102, low: 98, close: 100.5, basis: "pattern" as const, why: "", pattern: "hammer" };

  it("SCORES THE BAND AND THE DIRECTION SEPARATELY", () => {
    /* They are different claims. The band comes from a calibrated volatility
       model; the body is the only part that is a directional call, and pooling
       them would let a well-behaved band hide a useless direction. */
    const s = scoreCandle(f, bar(100, 101, 99.5, 100.9, 1));
    expect(s.inBand).toBe(true);
    expect(s.directionRight).toBe(true);
  });

  it("marks a close outside the band as a miss even when the direction was right", () => {
    const s = scoreCandle(f, bar(100, 110, 99, 109, 1));
    expect(s.inBand).toBe(false);
    expect(s.directionRight).toBe(true);
  });

  it("SCORES NO DIRECTION AS NEITHER RIGHT NOR WRONG", () => {
    /* A forecast that declined to call the direction must not be counted as a
       win when price happens to rise, nor as a loss when it falls. Folding it in
       either way would make the hit rate a statement about the market rather
       than about the model. */
    const flat = { ...f, close: 100, basis: "none" as const };
    expect(scoreCandle(flat, bar(100, 101, 99, 100.8, 1)).directionRight).toBeNull();
    expect(scoreCandle(flat, bar(100, 101, 99, 99.2, 1)).directionRight).toBeNull();
  });

  it("treats an exactly unchanged close as no direction rather than a win", () => {
    const s = scoreCandle(f, bar(100, 101, 99, 100, 1));
    expect(s.directionRight).toBe(false);
  });
});
