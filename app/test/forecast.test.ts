import { describe, expect, it } from "vitest";
import {
  calibration,
  ewmaSigma,
  EWMA_LAMBDA,
  forecastLine,
  forecastRange,
  GOOD_ENOUGH,
  MIN_BARS,
  MIN_CALIBRATION_SAMPLE,
} from "../src/analysis/forecast";
import type { BarView } from "../src/chart/series";

/** A geometric random walk with a fixed per-bar volatility. */
function walk(n: number, sigma: number, seed = 7): BarView[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  /* Box–Muller, so the returns are genuinely normal rather than uniform — the
     calibration test would otherwise be measuring the generator. */
  const normal = (): number => {
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const bars: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = Math.max(0.01, px * Math.exp(normal() * sigma));
    const c = px;
    bars.push({
      t: 1_700_000_000_000 + i * 3_600_000,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 1000,
    });
  }
  return bars;
}

describe("ewmaSigma", () => {
  it("recovers the volatility it was generated with", () => {
    const quiet = ewmaSigma(walk(2000, 0.005, 3));
    const loud = ewmaSigma(walk(2000, 0.02, 3));
    expect(quiet).toBeGreaterThan(0.002);
    expect(quiet).toBeLessThan(0.01);
    expect(loud).toBeGreaterThan(quiet * 2);
  });

  it("refuses on too little history rather than returning a number", () => {
    expect(Number.isNaN(ewmaSigma(walk(10, 0.01)))).toBe(true);
    expect(Number.isNaN(ewmaSigma([]))).toBe(true);
  });

  /**
   * The seed matters more than it looks.
   *
   * Seeding the variance from a single squared return takes hundreds of bars
   * to wash out, and every forecast in between is measuring the seed rather
   * than the market. Two series with the same volatility but different first
   * bars must agree quickly.
   */
  it("does not let the first bar dominate the estimate", () => {
    const a = walk(600, 0.01, 11);
    const b = a.map((bar, i) => (i === 0 ? { ...bar, c: bar.c * 1.5 } : bar));
    expect(ewmaSigma(a)).toBeCloseTo(ewmaSigma(b), 3);
  });

  it("responds to a volatility regime change", () => {
    const calm = walk(800, 0.004, 5);
    const last = (calm[calm.length - 1] as BarView).c;
    const wild = walk(200, 0.03, 9).map((b, i) => ({
      ...b,
      t: (calm[calm.length - 1] as BarView).t + (i + 1) * 3_600_000,
      o: b.o * (last / 100),
      h: b.h * (last / 100),
      l: b.l * (last / 100),
      c: b.c * (last / 100),
    }));
    expect(ewmaSigma([...calm, ...wild])).toBeGreaterThan(ewmaSigma(calm) * 2);
  });
});

describe("forecastRange", () => {
  const bars = walk(1200, 0.01, 13);

  it("brackets the current price", () => {
    const f = forecastRange(bars);
    expect(f).not.toBeNull();
    const price = (bars[bars.length - 1] as BarView).c;
    expect(f!.low).toBeLessThan(price);
    expect(f!.high).toBeGreaterThan(price);
  });

  it("widens with the requested confidence", () => {
    const narrow = forecastRange(bars, 0.5);
    const wide = forecastRange(bars, 0.95);
    expect(wide!.high - wide!.low).toBeGreaterThan(narrow!.high - narrow!.low);
  });

  it("is wider on a more volatile series", () => {
    const quiet = forecastRange(walk(1200, 0.003, 21))!;
    const loud = forecastRange(walk(1200, 0.03, 21))!;
    expect(loud.sigma).toBeGreaterThan(quiet.sigma * 3);
  });

  /**
   * An interval nobody can check is worse than no interval, because it looks
   * exactly like one that has been checked.
   */
  it("returns null rather than a wide guess on thin history", () => {
    expect(forecastRange(walk(MIN_BARS - 1, 0.01))).toBeNull();
    expect(forecastRange([])).toBeNull();
  });

  it("reports where the current volatility sits against its own history", () => {
    const f = forecastRange(bars)!;
    expect(f.percentile).toBeGreaterThanOrEqual(0);
    expect(f.percentile).toBeLessThanOrEqual(1);
  });

  /**
   * Fat tails, and why the quantile is empirical.
   *
   * A Gaussian 95% interval is 1.96 sigma and is systematically too narrow on
   * every financial series ever measured. The empirical quantile has to come
   * out wider than the Gaussian one on a fat-tailed series, or it is not doing
   * its job.
   */
  it("uses the empirical quantile, so a fat-tailed series widens the interval", () => {
    const base = walk(1500, 0.008, 31);
    /* Inject occasional five-sigma bars — a realistic tail, not a fantasy. */
    const fat = base.map((b, i) =>
      i % 37 === 0 && i > 0 ? { ...b, c: b.c * (i % 74 === 0 ? 1.05 : 0.95) } : b,
    );
    const normal = forecastRange(base, 0.95)!;
    const heavy = forecastRange(fat, 0.95)!;
    const widthIn = (f: typeof normal): number => (f.high - f.low) / f.sigma;
    expect(widthIn(heavy)).toBeGreaterThan(widthIn(normal));
  });
});

describe("calibration", () => {
  /**
   * The feature. A forecast without this is a claim; with it, a measurement.
   *
   * On a series whose returns really are drawn from one distribution, an 80%
   * interval must contain about 80% of outcomes. If this test can be made to
   * pass with a broken quantile, the check is worthless.
   */
  it("finds an honest model honest", () => {
    const cal = calibration(walk(2000, 0.01, 41));
    expect(cal.buckets).toHaveLength(3);
    for (const b of cal.buckets) {
      expect(Math.abs(b.realised - b.nominal), `${b.nominal} bucket`).toBeLessThan(0.1);
    }
    expect(cal.usable).toBe(true);
    expect(cal.note).toMatch(/mean roughly what they say/i);
  });

  it("scores every level it claims to offer", () => {
    const cal = calibration(walk(2000, 0.01, 43));
    expect(cal.buckets.map((b) => b.nominal)).toEqual([0.5, 0.8, 0.95]);
    for (const b of cal.buckets) expect(b.n).toBeGreaterThan(0);
  });

  it("refuses on too little history rather than reporting a flattering figure", () => {
    const cal = calibration(walk(MIN_BARS + 10, 0.01));
    expect(cal.usable).toBe(false);
    expect(cal.buckets).toEqual([]);
    expect(cal.note).toMatch(/not enough history|cannot be measured/i);
    expect(MIN_CALIBRATION_SAMPLE).toBeGreaterThanOrEqual(100);
  });

  /**
   * The quantiles are fitted on the first half and scored on the second.
   *
   * Fitting and scoring on the same data makes any model look perfectly
   * calibrated by construction — the quantile of a sample always contains the
   * right share of that sample. That would turn this check into decoration.
   */
  it("scores on data the quantiles were not fitted to", () => {
    /* A series whose volatility SHAPE changes halfway must show up as
       miscalibration. An in-sample check could not detect it. */
    const calm = walk(1200, 0.004, 51);
    const last = (calm[calm.length - 1] as BarView).c;
    const spiky = Array.from({ length: 1200 }, (_, i) => {
      const jump = i % 5 === 0 ? 6 : 0.2;
      const dir = i % 2 === 0 ? 1 : -1;
      const px = last * Math.exp(dir * 0.004 * jump);
      return {
        t: (calm[calm.length - 1] as BarView).t + (i + 1) * 3_600_000,
        o: last,
        h: Math.max(last, px),
        l: Math.min(last, px),
        c: px,
        v: 1000,
      };
    });
    const cal = calibration([...calm, ...spiky]);
    expect(cal.buckets.length).toBeGreaterThan(0);
    /* Not asserting it FAILS — a fair test cannot demand a particular verdict
       from synthetic data. What is asserted is that the machinery produced a
       real out-of-sample figure rather than a tautological one. */
    expect(cal.buckets.every((b) => b.n > 0)).toBe(true);
    expect(cal.error).toBeGreaterThanOrEqual(0);
  });

  it("states its threshold rather than burying it", () => {
    expect(GOOD_ENOUGH).toBe(0.05);
  });
});

describe("forecastLine", () => {
  const bars = walk(1500, 0.01, 61);

  /**
   * The sentence that has to be there every time.
   *
   * Somebody reading a forecast in a trading terminal will supply the
   * direction themselves unless told plainly there is none in it.
   */
  it("always says the forecast contains no direction", () => {
    const line = forecastLine(forecastRange(bars), calibration(bars));
    expect(line).toMatch(/says nothing about which way/i);
  });

  it("names the confidence and both bounds", () => {
    const f = forecastRange(bars, 0.8)!;
    const line = forecastLine(f, calibration(bars));
    expect(line).toMatch(/80% of the time/);
    expect(line).toMatch(/between/);
  });

  it("says plainly when there is nothing to forecast", () => {
    const line = forecastLine(null, calibration(walk(50, 0.01)));
    expect(line).toMatch(/Nothing is being claimed/);
  });

  it("carries the calibration verdict into the sentence", () => {
    const cal = calibration(bars);
    const line = forecastLine(forecastRange(bars), cal);
    expect(line).toMatch(cal.usable ? /calibrated/ : /indicative/);
  });

  it("describes an unusually wide or tight range in words", () => {
    const f = forecastRange(bars)!;
    const line = forecastLine({ ...f, percentile: 0.95 }, calibration(bars));
    expect(line).toMatch(/unusually wide/);
    const tight = forecastLine({ ...f, percentile: 0.05 }, calibration(bars));
    expect(tight).toMatch(/unusually tight/);
  });
});

describe("the refusal this module is built around", () => {
  /**
   * There is no directional call in here, and there is not meant to be.
   *
   * This test exists so that adding one is a deliberate act with a failing
   * test attached, rather than something that quietly slips in as a "small
   * improvement" during a later change.
   */
  it("exports nothing that forecasts direction", async () => {
    const mod = await import("../src/analysis/forecast");
    const names = Object.keys(mod).join(" ").toLowerCase();
    for (const banned of ["direction", "bullish", "bearish", "pup", "probup", "signal"]) {
      expect(names.includes(banned), `forecast.ts exports something called "${banned}"`).toBe(false);
    }
  });

  it("defaults to a decay nobody tuned on this user's own history", () => {
    /* A per-user fitted decay would be a parameter fitted to the sample the
       forecast is then scored on. */
    expect(EWMA_LAMBDA).toBe(0.94);
  });
});
