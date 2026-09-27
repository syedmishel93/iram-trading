import { describe, it, expect } from "vitest";
import { sma, ema, rsi, atr, trueRange, macd, bollinger, vwap, stochastic, adx } from "../src/chart/indicators";

const f = (xs: number[]): Float64Array => Float64Array.from(xs);

/** Every indicator must obey this, so it is asserted for all of them. */
function assertContract(out: Float64Array, len: number, warmup: number): void {
  expect(out.length).toBe(len);
  for (let i = 0; i < warmup; i++) expect(Number.isNaN(out[i] as number)).toBe(true);
  expect(Number.isNaN(out[len - 1] as number)).toBe(false);
}

describe("sma", () => {
  /*
   * A RUNNING SUM IS POISONED FOREVER BY ONE NaN, and every indicator in this
   * file begins with NaN.
   *
   * `sum += NaN` makes the accumulator NaN, and subtracting the value that
   * leaves the window does not clear it — NaN - x is NaN. So a mean of an
   * INDICATOR was NaN for the whole series, for any series, silently. Found by
   * `backtest/features.ts` asking for the mean of ATR(14) as a volatility
   * baseline and getting no rows at all: every feature row was dropped and
   * nothing said why, because "could not compute" and "warm-up" look the same
   * from outside.
   *
   * Nothing in the product hit it before — `bollinger` is the only internal
   * caller and it averages CLOSE, which is clean — but `script/sandbox.ts`
   * hands `sma` to user scripts, where averaging an indicator is the obvious
   * thing to do.
   */
  it("recovers after a NaN leaves the window instead of failing forever", () => {
    const out = sma(f([NaN, NaN, 3, 4, 5, 6, 7]), 3);
    // While the window still holds a NaN the answer really is unknown.
    expect(Number.isNaN(out[2] as number)).toBe(true);
    expect(Number.isNaN(out[3] as number)).toBe(true);
    // The moment it clears, a real mean — not NaN for the rest of time.
    expect(out[4]).toBe(4);
    expect(out[5]).toBe(5);
    expect(out[6]).toBe(6);
  });

  it("averages the trailing window and warms up with NaN", () => {
    const out = sma(f([1, 2, 3, 4, 5]), 3);
    assertContract(out, 5, 2);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
  });

  it("returns all-NaN when there is not enough data", () => {
    const out = sma(f([1, 2]), 5);
    expect(out.length).toBe(2);
    expect([...out].every(Number.isNaN)).toBe(true);
  });
});

describe("ema", () => {
  it("seeds from the SMA of the first period, not from a single price", () => {
    // Seeding off one value makes long EMAs visibly wrong for hundreds of bars.
    const out = ema(f([1, 2, 3, 4, 5, 6]), 3);
    expect(out[2]).toBe(2); // (1+2+3)/3
    const k = 2 / 4;
    expect(out[3]).toBeCloseTo(4 * k + 2 * (1 - k), 10);
  });

  it("converges to a constant input", () => {
    const flat = f(new Array(200).fill(42));
    const out = ema(flat, 20);
    expect(out[199]).toBeCloseTo(42, 9);
  });

  it("responds faster than an SMA of the same period", () => {
    const step = f([...new Array(50).fill(10), ...new Array(20).fill(20)]);
    const e = ema(step, 20);
    const s = sma(step, 20);
    expect(e[55] as number).toBeGreaterThan(s[55] as number);
  });
});

describe("rsi", () => {
  it("is 100 for an unbroken advance", () => {
    const up = f(Array.from({ length: 60 }, (_, i) => 100 + i));
    const out = rsi(up, 14);
    expect(out[59]).toBeCloseTo(100, 6);
  });

  it("is 0 for an unbroken decline", () => {
    const down = f(Array.from({ length: 60 }, (_, i) => 200 - i));
    const out = rsi(down, 14);
    expect(out[59]).toBeCloseTo(0, 6);
  });

  it("never emits Infinity when a window has no losses", () => {
    // avgLoss of 0 divides by zero in the naive formula, putting Infinity into
    // a column a strategy will happily compare against.
    const out = rsi(f(Array.from({ length: 40 }, (_, i) => 10 + i)), 14);
    for (const v of out) expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
  });

  it("is 50 for a flat series, not 100", () => {
    // No gains AND no losses is not the same as no losses. Reporting 100 here
    // tells every consumer the tape is maximally bullish while it has not
    // moved at all.
    expect(rsi(f(new Array(60).fill(42)), 14)[59]).toBe(50);
  });

  it("stays within 0..100", () => {
    const noisy = f(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 3) * 12 + (i % 7)));
    for (const v of rsi(noisy, 14)) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("trueRange / atr", () => {
  it("uses high-low for the first bar, having no previous close", () => {
    const tr = trueRange(f([10, 11]), f([8, 9]), f([9, 10]));
    expect(tr[0]).toBe(2);
  });

  it("accounts for gaps beyond the bar's own range", () => {
    // Bar 1 gaps far above bar 0's close: the true range is the gap, not h-l.
    const tr = trueRange(f([10, 30]), f([8, 28]), f([9, 29]));
    expect(tr[1]).toBe(Math.abs(30 - 9));
  });

  it("is positive and warms up correctly", () => {
    const n = 60;
    const high = f(Array.from({ length: n }, (_, i) => 100 + i + 1));
    const low = f(Array.from({ length: n }, (_, i) => 100 + i - 1));
    const close = f(Array.from({ length: n }, (_, i) => 100 + i));
    const out = atr(high, low, close, 14);
    assertContract(out, n, 13);
    expect(out[n - 1] as number).toBeGreaterThan(0);
  });
});

describe("macd", () => {
  it("keeps all three lines the length of the input", () => {
    const n = 200;
    const close = f(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 8) * 5));
    const { macd: line, signal, histogram } = macd(close);
    expect(line.length).toBe(n);
    expect(signal.length).toBe(n);
    expect(histogram.length).toBe(n);
  });

  it("does not let warm-up NaNs poison the signal line", () => {
    // The signal EMA must start at the first REAL macd value. Starting at index
    // 0 propagates NaN through every later value.
    const close = f(Array.from({ length: 200 }, (_, i) => 100 + i * 0.1));
    const { signal } = macd(close);
    expect(Number.isNaN(signal[199] as number)).toBe(false);
  });

  it("histogram equals macd minus signal wherever both exist", () => {
    const close = f(Array.from({ length: 200 }, (_, i) => 100 + Math.cos(i / 5) * 3));
    const { macd: line, signal, histogram } = macd(close);
    for (let i = 0; i < close.length; i++) {
      const m = line[i] as number;
      const s = signal[i] as number;
      if (!Number.isNaN(m) && !Number.isNaN(s)) {
        expect(histogram[i] as number).toBeCloseTo(m - s, 10);
      }
    }
  });
});

describe("bollinger", () => {
  it("collapses onto the mean for a flat series", () => {
    const flat = f(new Array(60).fill(50));
    const { upper, middle, lower } = bollinger(flat, 20, 2);
    expect(middle[59]).toBeCloseTo(50, 9);
    expect(upper[59]).toBeCloseTo(50, 9);
    expect(lower[59]).toBeCloseTo(50, 9);
  });

  it("keeps upper >= middle >= lower everywhere", () => {
    const noisy = f(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 4) * 9));
    const { upper, middle, lower } = bollinger(noisy, 20, 2);
    for (let i = 19; i < 300; i++) {
      expect(upper[i] as number).toBeGreaterThanOrEqual(middle[i] as number);
      expect(middle[i] as number).toBeGreaterThanOrEqual(lower[i] as number);
    }
  });

  it("stays precise when the mean dwarfs the deviation", () => {
    // The rolling sum-of-squares shortcut loses catastrophic precision here and
    // can even go negative under the square root.
    const close = f(Array.from({ length: 60 }, (_, i) => 100_000 + (i % 2 ? 25 : -25)));
    const { upper, lower } = bollinger(close, 20, 2);
    expect(Number.isFinite(upper[59] as number)).toBe(true);
    expect((upper[59] as number) - (lower[59] as number)).toBeCloseTo(100, 4);
  });
});

describe("vwap", () => {
  const mk = (n: number, sessionMs: number) => {
    const t = f(Array.from({ length: n }, (_, i) => i * 3_600_000));
    const price = f(Array.from({ length: n }, (_, i) => 100 + i));
    const vol = f(new Array(n).fill(10));
    return { t, price, vol, sessionMs };
  };

  it("resets on each session boundary", () => {
    const { t, price, vol } = mk(48, 86_400_000);
    const out = vwap(price, price, price, vol, t, 86_400_000);
    // Bar 24 starts a new day, so VWAP equals that bar's own typical price.
    expect(out[24]).toBeCloseTo(124, 9);
  });

  it("accumulates from the first bar when sessionMs is 0", () => {
    const { t, price, vol } = mk(10, 0);
    const out = vwap(price, price, price, vol, t, 0);
    const mean = (100 + 109) / 2;
    expect(out[9]).toBeCloseTo(mean, 9);
  });

  it("does not divide by zero on a volume-less feed", () => {
    // Many FX feeds carry no volume at all.
    const n = 20;
    const t = f(Array.from({ length: n }, (_, i) => i * 60_000));
    const p = f(Array.from({ length: n }, (_, i) => 1.1 + i * 0.001));
    const out = vwap(p, p, p, new Float64Array(n), t, 0);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("stochastic", () => {
  it("pins at 100 at the top of the range and 0 at the bottom", () => {
    // The range must be STATIONARY for this to mean anything. On a rising
    // series the window's lowest low sits 14 bars back, so a close at the
    // current bar's low is legitimately mid-range, not zero.
    const n = 60;
    const high = f(new Array(n).fill(110));
    const low = f(new Array(n).fill(90));

    expect(stochastic(high, low, f(new Array(n).fill(110)), 14, 1, 3).k[59]).toBe(100);
    expect(stochastic(high, low, f(new Array(n).fill(90)), 14, 1, 3).k[59]).toBe(0);
    expect(stochastic(high, low, f(new Array(n).fill(100)), 14, 1, 3).k[59]).toBe(50);
  });

  it("tracks where the close sits within a trending window", () => {
    // The same series that made the naive expectation above wrong: a close at
    // the bar's own low, in an uptrend, reads mid-range because the window's
    // low is 14 bars behind. Locking the real arithmetic in.
    const n = 60;
    const high = f(Array.from({ length: n }, (_, i) => 100 + i));
    const low = f(Array.from({ length: n }, (_, i) => 90 + i));
    const close = f(Array.from({ length: n }, (_, i) => 90 + i));

    const hh = 100 + 59;
    const ll = 90 + (59 - 13);
    const expected = ((close[59] as number) - ll) / (hh - ll) * 100;
    expect(stochastic(high, low, close, 14, 1, 3).k[59] as number).toBeCloseTo(expected, 9);
  });

  it("returns mid-range, not an extreme, for a flat window", () => {
    const flat = f(new Array(60).fill(10));
    const { k } = stochastic(flat, flat, flat, 14, 1, 3);
    expect(k[59]).toBe(50);
  });

  it("stays within 0..100", () => {
    const n = 200;
    const close = f(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 6) * 10));
    const high = f([...close].map((c) => c + 1));
    const low = f([...close].map((c) => c - 1));
    for (const v of stochastic(high, low, close).k) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("adx", () => {
  it("reads high on a clean trend and low on a chop", () => {
    const n = 200;
    const trendC = f(Array.from({ length: n }, (_, i) => 100 + i));
    const trend = adx(
      f([...trendC].map((c) => c + 1)),
      f([...trendC].map((c) => c - 1)),
      trendC,
      14,
    );

    const chopC = f(Array.from({ length: n }, (_, i) => 100 + (i % 2 ? 1 : -1)));
    const chop = adx(
      f([...chopC].map((c) => c + 1)),
      f([...chopC].map((c) => c - 1)),
      chopC,
      14,
    );

    expect(trend.adx[n - 1] as number).toBeGreaterThan(chop.adx[n - 1] as number);
  });

  it("puts +DI above -DI in an uptrend and the reverse in a downtrend", () => {
    const n = 120;
    const up = f(Array.from({ length: n }, (_, i) => 100 + i));
    const u = adx(f([...up].map((c) => c + 1)), f([...up].map((c) => c - 1)), up, 14);
    expect(u.plusDI[n - 1] as number).toBeGreaterThan(u.minusDI[n - 1] as number);

    const down = f(Array.from({ length: n }, (_, i) => 220 - i));
    const d = adx(f([...down].map((c) => c + 1)), f([...down].map((c) => c - 1)), down, 14);
    expect(d.minusDI[n - 1] as number).toBeGreaterThan(d.plusDI[n - 1] as number);
  });

  it("stays finite across a noisy series", () => {
    const n = 300;
    const c = f(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 8 + (i % 5)));
    const r = adx(f([...c].map((x) => x + 2)), f([...c].map((x) => x - 2)), c, 14);
    for (const v of r.adx) expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
  });
});
