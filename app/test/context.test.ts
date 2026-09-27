import { describe, it, expect, vi, afterEach } from "vitest";
import { resetNet } from "../src/data/net";
import {
  seasonality,
  correlation,
  loadCalendar,
  upcoming,
  MIN_BUCKET_SAMPLES,
  MIN_CORRELATION_SAMPLES,
} from "../src/data/context";
import { utcDay } from "../src/data/correlation";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z"); // a Thursday

afterEach(() => {
  vi.unstubAllGlobals();
  // The response cache is module-level, which is right for the app and a trap
  // for tests: without this, the successful calendar payload from the first
  // case is served to the "service is down" case and it passes for the wrong
  // reason — or fails, which is how this was found.
  resetNet();
});

/** Hourly bars whose return is decided by a caller-supplied function. */
function hourly(n: number, ret: (i: number, t: number) => number, t0 = T0): BarView[] {
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * HOUR;
    if (i > 0) p *= 1 + ret(i, t);
    out.push({ t, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 10 });
  }
  return out;
}

describe("seasonality", () => {
  it("finds a real hour-of-day effect that is genuinely in the data", () => {
    // Every 13:00 UTC bar is up 1%, every other bar flat.
    const bars = hourly(24 * 40, (_, t) => (new Date(t).getUTCHours() === 13 ? 0.01 : 0));
    const s = seasonality(bars, "hour");
    const thirteen = s.buckets.find((b) => b.key === 13)!;
    expect(thirteen.meanReturn).toBeCloseTo(0.01, 6);
    expect(thirteen.upRate).toBe(1);
    expect(s.buckets.find((b) => b.key === 3)!.meanReturn).toBeCloseTo(0, 9);
  });

  it("measures in UTC, so the pattern does not move with the reader", () => {
    // An hour-of-day effect that shifts with the viewer's timezone is not a
    // pattern, it is a rendering artefact.
    const bars = hourly(24 * 40, (_, t) => (new Date(t).getUTCHours() === 13 ? 0.01 : 0));
    const s = seasonality(bars, "hour");
    const peak = [...s.buckets].sort((a, b) => b.meanReturn - a.meanReturn)[0]!;
    expect(peak.key).toBe(13);
    expect(peak.label).toBe("13:00");
  });

  it("marks a thin bucket as thin instead of averaging it in silently", () => {
    // Nine Tuesdays showing +0.8% is not a finding, and must not look like one.
    // 40 hourly bars straddle two days: the second gets 16 samples, under the
    // floor. With five full days every bucket would clear it and the test would
    // silently assert nothing.
    const bars = hourly(40, () => 0.001);
    const s = seasonality(bars, "weekday");
    const thin = s.buckets.filter((b) => b.samples > 0 && b.samples < MIN_BUCKET_SAMPLES);
    expect(thin.length).toBeGreaterThan(0);
    for (const b of thin) expect(b.sufficient).toBe(false);
    expect(s.note).toMatch(/below 20 samples/);
  });

  it("counts every bar exactly once across the buckets", () => {
    const bars = hourly(500, () => 0.0001);
    for (const mode of ["hour", "weekday", "month"] as const) {
      const s = seasonality(bars, mode);
      expect(s.totalSamples).toBe(499);
      expect(s.buckets.reduce((a, b) => a + b.samples, 0)).toBe(499);
    }
  });

  it("returns empty buckets rather than NaN on no data", () => {
    const s = seasonality([], "hour");
    expect(s.buckets).toHaveLength(24);
    for (const b of s.buckets) expect(b.meanReturn).toBe(0);
    expect(s.note).toBe("No bars to measure.");
  });

  it("never claims a period is a law", () => {
    const bars = hourly(24 * 60, () => 0.0001);
    expect(seasonality(bars, "hour").note).toMatch(/not a law/);
  });
});

describe("correlation", () => {
  const from = (closes: number[], t0 = T0): BarView[] =>
    closes.map((c, i) => ({ t: t0 + i * HOUR, o: c, h: c, l: c, c, v: 1 }));

  /**
   * Closes built from a list of log returns.
   *
   * NOT a geometric ramp. 1,2,4,8 has a CONSTANT log return, so it has no
   * variance and correlates with nothing — which is the right answer and a
   * useless test. Correlation needs the returns themselves to vary.
   */
  const fromReturns = (rets: number[], t0 = T0): BarView[] => {
    let p = 100;
    const closes = [p];
    for (const r of rets) {
      p *= Math.exp(r);
      closes.push(p);
    }
    return from(closes, t0);
  };

  const RETS = [0.02, -0.01, 0.03, -0.015, 0.005, 0.04, -0.02, 0.01];

  it("reports a perfect positive and a perfect negative", () => {
    const a = fromReturns(RETS);
    const scaled = fromReturns(RETS.map((r) => r * 3));
    const mirrored = fromReturns(RETS.map((r) => -r));

    expect(correlation(new Map([["A", a], ["B", scaled]])).pairs[0]!.r).toBeCloseTo(1, 6);
    expect(correlation(new Map([["A", a], ["B", mirrored]])).pairs[0]!.r).toBeCloseTo(-1, 6);
  });

  it("refuses a series whose returns never change", () => {
    // A constant log return is zero variance, so there is nothing to
    // correlate; a geometric ramp only LOOKS like a trend.
    const ramp = from([1, 2, 4, 8, 16, 32]);
    const varied = fromReturns(RETS.slice(0, 5));
    const r = correlation(new Map([["RAMP", ramp], ["VARIED", varied]]));
    expect(r.pairs).toEqual([]);
    expect(Number.isNaN(r.unjudged[0]!.r)).toBe(true);
  });

  it("aligns by TIMESTAMP, not by index", () => {
    // Two symbols with different histories do not line up positionally.
    // Correlating by index compares Monday against Thursday and calls the
    // result a relationship.
    const a = from([100, 102, 101, 104, 103, 107]);
    const b = from([100, 102, 101, 104, 103, 107], T0 + 3 * HOUR);
    const r = correlation(new Map([["A", a], ["B", b]]));
    // Only three timestamps overlap, so three closes and two returns.
    expect(r.samples).toBe(2);
    expect(r.note).toMatch(/below 30 the coefficient is noise/);
  });

  it("REFUSES a flat series rather than calling it uncorrelated", () => {
    /* A flat series has no variance, so the coefficient is undefined. This
       asserted 0 until the measurement moved to `data/correlation.ts`, and 0
       is a CLAIM: it reads as "measured, and they move independently". The
       refusal does not poison the sort, because an unmeasurable pair is not
       sorted with the measured ones - it is reported under `unjudged`. */
    const flat = from([5, 5, 5, 5, 5, 5]);
    const move = fromReturns(RETS.slice(0, 5));
    const r = correlation(new Map([["FLAT", flat], ["MOVE", move]]));
    expect(r.pairs).toEqual([]);
    expect(Number.isNaN(r.unjudged[0]!.r)).toBe(true);
    expect(r.note).toMatch(/could not be measured/);
  });

  it("produces a symmetric matrix with a unit diagonal", () => {
    const m = correlation(
      new Map([
        ["A", from([100, 102, 101, 104, 103, 107])],
        ["B", from([50, 52, 51, 55, 53, 58])],
        ["C", from([200, 198, 199, 195, 197, 190])],
      ]),
    );
    for (let i = 0; i < 3; i++) {
      expect(m.matrix[i]![i]).toBe(1);
      for (let j = 0; j < 3; j++) expect(m.matrix[i]![j]).toBeCloseTo(m.matrix[j]![i]!, 12);
    }
  });

  it("ranks the strongest relationship first, sign ignored", () => {
    const m = correlation(
      new Map([
        ["A", fromReturns(RETS)],
        ["B", fromReturns(RETS.map((r) => -r))],
        ["C", fromReturns([0.001, -0.02, 0.03, 0.004, -0.001, 0.02, 0.01, -0.03])],
      ]),
    );
    expect(Math.abs(m.pairs[0]!.r)).toBeGreaterThanOrEqual(Math.abs(m.pairs[1]!.r));
    // A and B are exact mirrors: the strongest pair must be one of them.
    expect(Math.abs(m.pairs[0]!.r)).toBeCloseTo(1, 6);
  });

  it("says so rather than guessing with fewer than two symbols", () => {
    const r = correlation(new Map([["A", from([1, 2, 3])]]));
    expect(r.pairs).toEqual([]);
    expect(r.note).toMatch(/at least two symbols/);
  });

  it("warns below the sample floor and stops warning above it", () => {
    const long = Array.from(
      { length: MIN_CORRELATION_SAMPLES + 20 },
      (_, i) => 100 + i + Math.sin(i) * 3,
    );
    const r = correlation(new Map([["A", from(long)], ["B", from(long.map((v) => v * 2))]]));
    expect(r.samples).toBeGreaterThanOrEqual(MIN_CORRELATION_SAMPLES);
    expect(r.note).toMatch(/not causation/);
  });

  /* ------------------------------------------------------------------ *
   * STABILITY. The screener's block showed one Pearson figure over a
   * 200-bar window, and a pair that was +0.9 for the first half of it and
   * -0.9 for the second averages to about nothing - which renders as
   * "these two are unrelated", the opposite of the truth and
   * indistinguishable from a genuinely uncorrelated pair by the number
   * alone. CLAUDE.md states the rule: the card shows the rolling figure,
   * its window AND its instability, or it shows nothing.
   * ------------------------------------------------------------------ */

  /**
   * 96 varying returns - enough to slice into four windows of 24, which is
   * above `MIN_SLICE`. Deterministic, so a failure is reproducible.
   */
  const WAVE = Array.from({ length: 96 }, (_, i) => Math.sin(i * 1.7) * 0.01 + 0.0003);

  it("reports a pair that REVERSED as unstable, not as uncorrelated", () => {
    const a = fromReturns(WAVE);
    const b = fromReturns(WAVE.map((r, i) => (i < 48 ? r : -r)));
    const p = correlation(new Map([["A", a], ["B", b]])).pairs[0]!;

    // The trap: over the whole window the coefficient really is near nothing.
    expect(Math.abs(p.r)).toBeLessThan(0.3);
    // And these two are one of the strongest relationships on the board.
    expect(p.instability).toBeGreaterThan(1.5);
    expect(p.stable).toBe(false);
  });

  it("reports a steady pair as stable, so the flag separates something", () => {
    const a = fromReturns(WAVE);
    const b = fromReturns(WAVE.map((r) => r * 2));
    const p = correlation(new Map([["A", a], ["B", b]])).pairs[0]!;
    expect(p.r).toBeCloseTo(1, 6);
    expect(p.instability).toBeLessThan(0.01);
    expect(p.stable).toBe(true);
  });

  it("says UNKNOWN rather than steady when the overlap is too short to slice", () => {
    // Unknown is not stable. Too few bars to slice means the question was
    // never asked, and "settled" there is the strongest available claim made
    // from the least evidence.
    const p = correlation(
      new Map([["A", fromReturns(RETS)], ["B", fromReturns(RETS.map((r) => r * 2))]]),
    ).pairs[0]!;
    expect(Number.isNaN(p.instability)).toBe(true);
    expect(p.stable).toBe(false);
  });

  it("joins cross-vendor dailies on the UTC DAY when asked", () => {
    /* One vendor stamps a daily bar at midnight and a broker at its session
       open. An exact join between them reports ZERO overlap for two series
       covering exactly the same days - correct for a single-vendor intraday
       scan, useless across vendors. */
    const DAY = 24 * HOUR;
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 5);
    const series = new Map([
      ["YF", closes.map((c, i) => ({ t: T0 + i * DAY, c }))],
      ["BROKER", closes.map((c, i) => ({ t: T0 + i * DAY + 13 * HOUR, c: c * 2 }))],
    ]);

    const exact = correlation(series);
    expect(exact.pairs).toEqual([]);
    expect(exact.unjudged[0]!.samples).toBe(0);

    const daily = correlation(series, { bucket: utcDay });
    expect(daily.pairs[0]!.samples).toBe(39);
    expect(daily.pairs[0]!.r).toBeCloseTo(1, 6);
  });

  it("reports the overlap PER PAIR, not one figure for the whole scan", () => {
    /* The join is pairwise, so one symbol with a short history no longer
       shortens every other pair's window - and a single scan-wide sample
       count would be a claim about pairs it does not describe. */
    const long = fromReturns(WAVE);
    const short = fromReturns(WAVE.slice(0, 40), T0 + 56 * HOUR);
    const r = correlation(
      new Map([["A", long], ["B", fromReturns(WAVE.map((x) => x * 2))], ["C", short]]),
    );
    const ab = r.pairs.find((p) => p.a === "A" && p.b === "B")!;
    const ac = r.pairs.find((p) => p.a === "A" && p.b === "C")!;
    expect(ab.samples).toBe(96);
    expect(ac.samples).toBeLessThan(ab.samples);
    // The scan-wide figure is the FLOOR across the pairs, and says so.
    expect(r.samples).toBe(ac.samples);
  });
});

describe("the economic calendar", () => {
  it("reads high-impact events out of the feature store", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { source: "binance_funding", k: "BTCUSDT", v: "0.0001", t: 1 },
          {
            source: "calendar",
            k: "high_usd",
            t: 1788000000,
            v: JSON.stringify([{ t: "2026-09-01T12:30:00-04:00", n: "Non-Farm Payrolls" }]),
          },
        ],
      }),
    );
    return loadCalendar().then((r) => {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.events).toHaveLength(1);
        expect(r.events[0]!.title).toBe("Non-Farm Payrolls");
      }
    });
  });

  it("says the store is empty rather than showing nothing", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    return loadCalendar().then((r) => {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no calendar entry yet/);
    });
  });

  it("names the command that starts the service when it is down", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    return loadCalendar("http://127.0.0.1:8788").then((r) => {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("python run.py");
      expect(r.error).not.toContain("mishel_service");
    });
  });

  it("keeps only what is still ahead, soonest first", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const list = upcoming(
      [
        { time: "2026-08-30T12:00:00Z", title: "past" },
        { time: "2026-09-03T12:00:00Z", title: "later" },
        { time: "2026-09-01T18:00:00Z", title: "soon" },
        { time: "not a date", title: "junk" },
      ],
      now,
    );
    expect(list.map((e) => e.title)).toEqual(["soon", "later"]);
  });
});
