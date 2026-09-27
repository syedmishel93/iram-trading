/**
 * The v54 detector families.
 *
 * These tests are weighted toward the REFUSALS rather than the finds. Every
 * detector here is easy to make fire — that is the problem with the whole
 * category — so what needs guarding is the set of conditions under which it
 * must stay silent: a candle with nothing under it, a profile with no volume,
 * a killzone on a daily chart, a harmonic whose D pivot has not confirmed.
 *
 * The other recurring theme is that nothing in this build is allowed to claim
 * a direction it did not observe. A squeeze, a triangle and an opening range
 * are all `neutral` until price picks a side, and several tests below exist
 * purely to hold that line.
 */

import { describe, expect, it } from "vitest";
import { detectCandles, nearestAnchor, type Anchor } from "../src/detect/candles";
import { classify, detectWedges } from "../src/detect/wedges";
import { detectProfile, detectVolumeClimax } from "../src/detect/volume";
import { detectGaps, detectSqueeze } from "../src/detect/volatility";
import {
  detectAnchoredVwap,
  detectFibs,
  detectPivotPoints,
  detectPriorLevels,
  detectRoundNumbers,
  roundStep,
} from "../src/detect/anchors";
import { detectFailedBreaks, detectMitigation, detectSprings } from "../src/detect/failure";
import { detectKillzones, detectOpeningRange, inWindow } from "../src/detect/timewindow";
import { TEMPLATES, detectHarmonics, within } from "../src/detect/harmonic";
import { band, detectConfluence, independentKinds, priceOf } from "../src/detect/confluence";
import type { Detection, DetectInput } from "../src/detect/types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday, 00:00 UTC

type Row = [number, number, number, number] | [number, number, number, number, number];

function input(rows: readonly Row[], startMs = T0, stepMs = HOUR): DetectInput {
  const n = rows.length;
  const mk = () => new Float64Array(n);
  const t = mk();
  const o = mk();
  const h = mk();
  const l = mk();
  const c = mk();
  const v = mk();
  rows.forEach((r, i) => {
    t[i] = startMs + i * stepMs;
    o[i] = r[0];
    h[i] = r[1];
    l[i] = r[2];
    c[i] = r[3];
    v[i] = r[4] ?? 100;
  });
  return { t, o, h, l, c, v };
}

const flat = (n: number, price: number, vol = 100): Row[] =>
  Array.from({ length: n }, () => [price, price + 0.5, price - 0.5, price, vol]);

/** A zig-zag with real swings, so pivot-dependent detectors have something. */
function zigzag(legs: number, amplitude: number, barsPerLeg: number, base = 100): Row[] {
  const rows: Row[] = [];
  let price = base;
  for (let leg = 0; leg < legs; leg++) {
    const up = leg % 2 === 0;
    for (let i = 0; i < barsPerLeg; i++) {
      const next = price + ((up ? 1 : -1) * amplitude) / barsPerLeg;
      rows.push([price, Math.max(price, next) + 0.2, Math.min(price, next) - 0.2, next, 100]);
      price = next;
    }
  }
  return rows;
}

/* ───────────────────────────────────────────────────────────── candles ── */

describe("candle patterns", () => {
  it("publishes nothing when the pattern has no level under it", () => {
    /* The whole reason the file exists. A textbook bullish engulfing in the
       middle of a featureless drift is not information, and the detector must
       not report it just because the shape is right. */
    const rows: Row[] = [
      ...flat(60, 100),
      [100, 100.2, 99.5, 99.6],
      [99.6, 101.5, 99.5, 101.4], // engulfs, and there is nothing here
    ];
    const found = detectCandles(input(rows));
    expect(found.filter((d) => d.kind === "engulfing")).toHaveLength(0);
  });

  it("refuses a series too short to have anchors", () => {
    expect(detectCandles(input(flat(20, 100)))).toEqual([]);
  });

  it("never claims a side for an inside bar", () => {
    /* An inside bar is a contraction. Which way it opens up is not in the
       bar, and a detector that guessed would be fabricating the only part
       that matters. */
    const rows: Row[] = [...zigzag(8, 12, 9), ...flat(4, 100)];
    for (const d of detectCandles(input(rows))) {
      if (d.kind === "inside-bar") expect(d.direction).toBe("neutral");
    }
  });

  it("dates every pattern at the bar it became knowable", () => {
    /* `to` is what `setup/simulate.ts` enters after. A star spans three bars
       and must still be dated at the third, never at the first. */
    const rows: Row[] = [...zigzag(10, 14, 8), ...flat(6, 100)];
    for (const d of detectCandles(input(rows))) {
      expect(d.to).toBeGreaterThanOrEqual(d.from);
      expect(d.to).toBeLessThan(rows.length);
    }
  });
});

describe("nearestAnchor", () => {
  const anchors: Anchor[] = [
    { price: 100, what: "a clustered level" },
    { price: 103, what: "a prior swing high" },
  ];

  it("returns the closest inside tolerance", () => {
    expect(nearestAnchor(anchors, 102.6, 1)?.price).toBe(103);
  });

  it("returns nothing when everything is out of reach", () => {
    /* Not "the least bad" — nothing. A gate that always finds something is
       not a gate. */
    expect(nearestAnchor(anchors, 200, 1)).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────── wedges etc ── */

describe("classify", () => {
  const tol = 1.5;
  /**
   * Realistic geometry, and the reason it is spelled out.
   *
   * The first version of these tests passed slopes of order 1 against a scale
   * of 1 — a boundary climbing a whole ATR every single bar, which is very
   * nearly a vertical line and does not occur. Everything was internally
   * consistent and the detector returned nothing on every real series, because
   * live slopes are around 0.025 ATR per bar and the flat cut swallowed them
   * whole. So the helper below states the units: ATR, span in bars, and a
   * travel expressed in ATR ACROSS THE FORMATION, which is what the classifier
   * actually compares.
   */
  const ATR = 15;
  const SPAN = 200;
  /** A boundary that travels `atrTravel` ATR over the whole formation. */
  const slope = (atrTravel: number): number => (atrTravel * ATR) / SPAN;
  const call = (upperAtr: number, lowerAtr: number) =>
    classify(slope(upperAtr), slope(lowerAtr), ATR, SPAN, tol);

  it("names converging pairs by which boundary is moving", () => {
    expect(call(-5, 5)?.label).toBe("Symmetrical triangle");
    expect(call(0, 5)?.label).toBe("Ascending triangle");
    expect(call(-5, 0)?.label).toBe("Descending triangle");
    expect(call(4, 6)?.label).toBe("Rising wedge");
    expect(call(-6, -4)?.label).toBe("Falling wedge");
  });

  it("classifies the live geometry the first version could not", () => {
    /**
     * Measured on ETHUSDT 1h: boundaries at -0.3971 and -0.3713 price per bar,
     * ATR 15.72, formation span 297 bars. Over that COMMON span they travel
     * -7.50 and -7.01 ATR, so they are near-parallel and falling.
     *
     * The old per-bar normalisation made both of these -0.02 and called them
     * flat, which is why the detector returned nothing on every real series.
     *
     * Two mistakes are recorded here rather than one: the first draft of this
     * test expected "Falling wedge", from computing each boundary's travel
     * over its OWN fitted span (297 and 228 bars) instead of the formation's.
     * Two gradients measured over different numbers of bars cannot be
     * compared, which is exactly what `classify` now refuses to do.
     */
    expect(classify(-0.3971, -0.3713, 15.72, 297, tol)?.label).toBe("Falling channel");
  });

  it("calls near-equal slopes a channel", () => {
    expect(call(5, 5.1)?.kind).toBe("channel");
  });

  it("refuses a flat box, because ranges.ts owns that", () => {
    expect(call(0, 0)).toBeNull();
  });

  it("refuses a diverging pair rather than inventing a name for it", () => {
    /* A broadening formation is a real shape and this detector does not
       handle it. Returning null is the honest answer; picking the nearest
       label would put a wedge on the chart that is not one. */
    expect(call(5, -5)).toBeNull();
  });

  it("normalises by scale, so the same shape reads the same on any instrument", () => {
    const gold = classify(-0.4, 0.4, 15, 200, tol);
    const token = classify(-0.4e-6, 0.4e-6, 15e-6, 200, tol);
    expect(gold?.label).toBe(token?.label);
    expect(gold?.label).toBe("Symmetrical triangle");
  });

  it("refuses without a span, rather than dividing by zero", () => {
    expect(classify(-0.4, 0.4, 15, 0, tol)).toBeNull();
  });
});

describe("detectWedges", () => {
  it("gives an unbroken formation no direction", () => {
    const rows: Row[] = zigzag(10, 10, 6);
    for (const d of detectWedges(input(rows))) {
      if (!d.label.includes("break")) expect(d.direction).toBe("neutral");
    }
  });

  it("returns nothing on a series too short to hold one", () => {
    expect(detectWedges(input(flat(20, 100)))).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────── volume ── */

describe("volume profile detectors", () => {
  it("returns nothing at all when the feed carries no volume", () => {
    /* An FX feed through some brokers reports zero volume. A profile built
       from that is a flat block with an arbitrary point of control, and
       drawing one would be inventing a level. */
    const rows: Row[] = zigzag(24, 8, 9).map((r) => [r[0], r[1], r[2], r[3], 0]);
    expect(detectProfile(input(rows))).toEqual([]);
    expect(detectVolumeClimax(input(rows))).toEqual([]);
  });

  it("says in the reason string that it is built from bars, not trades", () => {
    const rows: Row[] = zigzag(30, 8, 8);
    const found = detectProfile(input(rows));
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) expect(d.reason).toMatch(/not trades/);
  });

  it("gives profile levels no direction", () => {
    /* A point of control is a place, not a trade. */
    for (const d of detectProfile(input(zigzag(30, 8, 8)))) {
      expect(d.direction).toBe("neutral");
    }
  });

  it("reports a climax with the side the bar closed, not as exhaustion", () => {
    const rows: Row[] = [
      ...flat(120, 100),
      [100, 108, 99.5, 107.5, 100_000], // huge volume, closes up
      ...flat(3, 107),
    ];
    const found = detectVolumeClimax(input(rows));
    expect(found).toHaveLength(1);
    expect(found[0]?.direction).toBe("long");
    expect(found[0]?.reason).toMatch(/not as exhaustion/);
  });
});

/* ─────────────────────────────────────────────────────── volatility ── */

describe("squeeze", () => {
  it("gives a live squeeze no side", () => {
    const rows: Row[] = flat(120, 100);
    for (const d of detectSqueeze(input(rows))) {
      if (d.label === "In a squeeze") expect(d.direction).toBe("neutral");
    }
  });

  it("returns nothing on a series shorter than three periods", () => {
    expect(detectSqueeze(input(flat(40, 100)))).toEqual([]);
  });
});

describe("gaps", () => {
  it("finds a discontinuity and reports it as still open", () => {
    const rows: Row[] = [...flat(60, 100), [110, 111, 109.5, 110.5], ...flat(5, 110)];
    const found = detectGaps(input(rows));
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("Gap up");
    expect(found[0]?.reason).toMatch(/Still open/);
  });

  it("counts a gap as filled only when price reaches the near edge", () => {
    /* Trading INTO the window is not a fill. Treating it as one would flatter
       the fill rate, which is the exact claim the record exists to test. */
    const rows: Row[] = [
      ...flat(60, 100),
      [110, 111, 109.5, 110.5], // gap from 100.5 to 109.5
      [110.5, 111, 105, 106], // reaches into the gap but not to 100.5
      ...flat(5, 106),
    ];
    expect(detectGaps(input(rows))[0]?.reason).toMatch(/Still open/);
  });

  it("does not report the gap direction as a fill prediction", () => {
    const rows: Row[] = [...flat(60, 100), [110, 111, 109.5, 110.5], ...flat(5, 110)];
    /* A gap up is reported long — the direction it OPENED. "Gaps get filled"
       would make it short, and that is the claim under test rather than an
       input to it. */
    expect(detectGaps(input(rows))[0]?.direction).toBe("long");
  });
});

/* ────────────────────────────────────────────────────────── anchors ── */

describe("roundStep", () => {
  it("picks a step that is at least the requested width", () => {
    expect(roundStep(3400, 5, 2)).toBe(10);
    expect(roundStep(0.000018, 0.0000004, 2)).toBeCloseTo(0.000001, 10);
  });

  it("scales with the instrument rather than assuming a decimal place", () => {
    /* The reason a fixed step cannot work: gold at 3,400 and a token at
       0.000018 are both on this terminal's watchlist. */
    expect(roundStep(3400, 40, 2)).toBeGreaterThan(roundStep(3400, 5, 2));
  });

  it("returns zero when there is no usable price or unit", () => {
    expect(roundStep(0, 1, 2)).toBe(0);
    expect(roundStep(100, 0, 2)).toBe(0);
  });
});

describe("standing levels", () => {
  it("gives every one of them a neutral direction", () => {
    /* A level does not happen; it is simply there. None of these will ever
       enter a directional record, and that is correct. */
    const rows: Row[] = zigzag(30, 9, 8);
    const data = input(rows);
    const all = [
      ...detectRoundNumbers(data),
      ...detectFibs(data),
      ...detectPivotPoints(data),
      ...detectPriorLevels(data),
      ...detectAnchoredVwap(data),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) expect(d.direction).toBe("neutral");
  });

  it("offers a round level's touch count as its only evidence", () => {
    const found = detectRoundNumbers(input(zigzag(30, 9, 8)));
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) expect(d.reason).toMatch(/only evidence offered/);
  });

  it("refuses anchored VWAP without volume rather than averaging price", () => {
    /* A plain average published under a VWAP label would be the single most
       misleading thing in the file. */
    const rows: Row[] = zigzag(30, 9, 8).map((r) => [r[0], r[1], r[2], r[3], 0]);
    expect(detectAnchoredVwap(input(rows))).toEqual([]);
  });

  it("needs two calendar days before it will name a prior one", () => {
    const oneDay = flat(12, 100);
    expect(detectPivotPoints(input(oneDay, T0, HOUR))).toEqual([]);
    expect(detectPriorLevels(input(oneDay, T0, HOUR))).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────── failures ── */

describe("springs and upthrusts", () => {
  it("needs a CLOSE back inside, not just a wick", () => {
    /* A deep wick that closes outside has not reclaimed anything. Counting it
       would turn every long tail into a signal. */
    const rows: Row[] = [
      ...Array.from({ length: 40 }, (_, i): Row => {
        const p = 100 + (i % 2 === 0 ? 0.6 : -0.6);
        return [p, p + 0.4, p - 0.4, p];
      }),
      [99.4, 99.5, 95, 95.2], // breaks well below and CLOSES there
      ...flat(6, 95),
    ];
    const found = detectSprings(input(rows));
    expect(found.filter((d) => d.kind === "spring")).toHaveLength(0);
  });

  it("returns nothing on a series with no range in it", () => {
    expect(detectSprings(input(zigzag(6, 40, 4)))).toEqual([]);
  });
});

describe("failed breaks and retests", () => {
  it("reports a failed break on the side of the reversal", () => {
    const found = detectFailedBreaks(input(zigzag(14, 12, 7)));
    for (const d of found) {
      if (d.kind !== "failed-break") continue;
      expect(d.reason).toMatch(/closed back through/);
      expect(["long", "short"]).toContain(d.direction);
    }
  });

  it("never reports the same break as both failed and retested", () => {
    /* They are complements over one population. A level that was lost was
       never retested successfully, and publishing both would double-count the
       instance in two records that are supposed to be compared. */
    const found = detectFailedBreaks(input(zigzag(20, 11, 6)));
    const bars = found.map((d) => `${d.from}:${d.to}`);
    expect(new Set(bars).size).toBe(bars.length);
  });
});

describe("mitigation", () => {
  it("returns nothing on a flat series with no displacement", () => {
    expect(detectMitigation(input(flat(80, 100)))).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────────── time ── */

describe("inWindow", () => {
  it("handles a window that wraps midnight", () => {
    expect(inWindow(23, 21, 2)).toBe(true);
    expect(inWindow(1, 21, 2)).toBe(true);
    expect(inWindow(5, 21, 2)).toBe(false);
  });

  it("is half-open, so adjacent windows do not both claim an hour", () => {
    expect(inWindow(9, 7, 9)).toBe(false);
    expect(inWindow(7, 7, 9)).toBe(true);
  });
});

describe("killzones", () => {
  it("refuses a timeframe where the window is one bar or less", () => {
    /* A killzone on a daily chart is a band drawn around one candle. */
    const daily = input(flat(200, 100), T0, 24 * HOUR);
    expect(detectKillzones(daily)).toEqual([]);
    expect(detectOpeningRange(daily)).toEqual([]);
  });

  it("states the measured share of travel rather than asserting the hour matters", () => {
    const rows: Row[] = zigzag(40, 6, 6);
    const found = detectKillzones(input(rows, T0, HOUR));
    for (const d of found) {
      expect(d.reason).toMatch(/of all price travel/);
      expect(d.direction).toBe("neutral");
    }
  });

  it("gives the opening range no side until price leaves it", () => {
    const rows: Row[] = zigzag(40, 6, 6);
    for (const d of detectOpeningRange(input(rows, T0, HOUR))) {
      if (d.label === "Opening range") expect(d.direction).toBe("neutral");
      else expect(["long", "short"]).toContain(d.direction);
    }
  });
});

/* ─────────────────────────────────────────────────────── harmonics ── */

describe("harmonic ratios", () => {
  it("accepts a ratio inside the band once tolerance is applied", () => {
    expect(within(0.618, [0.618, 0.618], 0.12)).toBe(true);
    expect(within(0.68, [0.618, 0.618], 0.12)).toBe(true);
    expect(within(0.9, [0.618, 0.618], 0.12)).toBe(false);
  });

  it("keeps the four templates distinguishable at the default tolerance", () => {
    /* Shark, cypher and the rest collapse into these bands once tolerance is
       applied. Publishing them would split one record into four
       unmeasurable ones. */
    expect(TEMPLATES).toHaveLength(4);
    const names = TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(4);
  });

  it("dates a pattern at its D pivot's CONFIRMATION bar", () => {
    /* Dating it at the extreme would let the simulator enter before the
       pattern was knowable, which is the single most common way a chart
       pattern backtest produces impossible returns. */
    const rows: Row[] = zigzag(30, 10, 5);
    for (const d of detectHarmonics(input(rows))) {
      expect(d.to).toBeGreaterThan(d.from);
    }
  });

  it("says out loud that the ratios have no mechanism", () => {
    const rows: Row[] = zigzag(40, 12, 5);
    for (const d of detectHarmonics(input(rows))) {
      expect(d.reason).toMatch(/no mechanism/);
    }
  });
});

/* ────────────────────────────────────────────────────── confluence ── */

const det = (over: Partial<Detection>): Detection => ({
  id: "x",
  kind: "level",
  label: "L",
  direction: "neutral",
  from: 0,
  to: 90,
  confidence: 0.5,
  reason: "",
  shapes: [{ type: "level", x0: 0, y: 100, tone: "neutral" }],
  ...over,
});

describe("priceOf", () => {
  it("prefers a level, then a box midpoint, then a line end", () => {
    expect(priceOf(det({}))).toBe(100);
    expect(
      priceOf(det({ shapes: [{ type: "box", x0: 0, x1: 1, y0: 90, y1: 110, tone: "neutral" }] })),
    ).toBe(100);
    expect(
      priceOf(det({ shapes: [{ type: "line", x0: 0, y0: 50, x1: 1, y1: 105, tone: "neutral" }] })),
    ).toBe(105);
  });

  it("returns null rather than zero when there is no positional shape", () => {
    expect(priceOf(det({ shapes: [] }))).toBeNull();
  });
});

describe("independentKinds", () => {
  const m = (kind: string, confidence = 0.5) =>
    ({ kind, label: kind, price: 100, direction: "neutral", confidence }) as never;

  it("counts a kind once however many instances it has", () => {
    /* Three stacked fair value gaps are one imbalance a three-bar rule
       reported three times, not three pieces of evidence. */
    expect(independentKinds([m("fvg"), m("fvg"), m("fvg")])).toHaveLength(1);
  });

  it("counts a definitionally linked pair once", () => {
    /* An order block and the fair value gap left by the displacement that
       made it are the same event described twice. */
    expect(independentKinds([m("order-block"), m("fvg")])).toHaveLength(1);
    expect(independentKinds([m("failed-break"), m("retest")])).toHaveLength(1);
  });

  it("keeps genuinely independent kinds", () => {
    expect(independentKinds([m("bos"), m("poc"), m("prior-level")])).toHaveLength(3);
  });
});

describe("band", () => {
  const m = (price: number) =>
    ({ kind: "level", label: "L", price, direction: "neutral", confidence: 0.5 }) as never;

  it("groups by proximity and leaves a distant member alone", () => {
    const groups = band([m(100), m(100.4), m(140)], 1);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
  });

  it("never lets a chain of near neighbours widen past the tolerance", () => {
    /**
     * The bug this replaced. Single-linkage over marks each 0.5 apart with a
     * tolerance of 1 walked the whole range: on live ETHUSDT with 29 detectors
     * on it produced ONE band 11 ATR wide labelled "30 sources, disagreeing".
     * A band that contains everything is not evidence that everything agrees.
     */
    const chain = [100, 100.5, 101, 101.5, 102, 102.5, 103].map(m);
    for (const group of band(chain, 1)) {
      const prices = group.map((g) => (g as unknown as { price: number }).price);
      expect(Math.max(...prices) - Math.min(...prices)).toBeLessThanOrEqual(1);
    }
  });
});

describe("detectConfluence", () => {
  const data = input(flat(200, 100));

  it("refuses to publish a band below the source floor", () => {
    const found = detectConfluence(data, [det({ kind: "bos" }), det({ kind: "poc" })]);
    expect(found).toEqual([]);
  });

  it("publishes a band once three independent kinds agree", () => {
    const found = detectConfluence(data, [
      det({ kind: "bos", direction: "long" }),
      det({ kind: "poc" }),
      det({ kind: "prior-level" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toMatch(/3 independent detectors/);
  });

  it("will not be fooled into a band by one kind repeated", () => {
    const found = detectConfluence(data, [
      det({ id: "a", kind: "fvg" }),
      det({ id: "b", kind: "fvg" }),
      det({ id: "c", kind: "fvg" }),
      det({ id: "d", kind: "fvg" }),
    ]);
    expect(found).toEqual([]);
  });

  it("names a disagreement instead of averaging it into a lean", () => {
    /* The most useful thing the operator can know about a price where a
       bullish block sits on a bearish trendline is that the two disagree. */
    const found = detectConfluence(data, [
      det({ kind: "order-block", direction: "long" }),
      det({ kind: "trendline", direction: "short" }),
      det({ kind: "poc" }),
    ]);
    expect(found[0]?.direction).toBe("neutral");
    expect(found[0]?.reason).toMatch(/do not agree on a side/);
  });

  it("ignores stale detections", () => {
    /* `freshBars` is passed rather than relied on: the default is 200 and the
       fixture is 200 bars long, so the first version of this test proved
       nothing and passed anyway. */
    const found = detectConfluence(
      data,
      [det({ kind: "bos", to: 1 }), det({ kind: "poc", to: 2 }), det({ kind: "prior-level", to: 3 })],
      { freshBars: 20 },
    );
    expect(found).toEqual([]);
  });

  it("never feeds itself", () => {
    const found = detectConfluence(data, [
      det({ kind: "confluence" }),
      det({ kind: "confluence", id: "b" }),
      det({ kind: "confluence", id: "c" }),
      det({ kind: "bos" }),
    ]);
    expect(found).toEqual([]);
  });

  it("offers no score anywhere a rule could be built on it", () => {
    /* The standing recommendation in this repository is that nothing be
       automated off a confluence score: the last one measured PBO at 89%. */
    const found = detectConfluence(data, [
      det({ kind: "bos", direction: "long" }),
      det({ kind: "poc" }),
      det({ kind: "prior-level" }),
    ]);
    expect(found[0]?.reason).toMatch(/no confluence score/);
    expect(found[0]?.confidence).toBeLessThan(0.8);
  });
});
