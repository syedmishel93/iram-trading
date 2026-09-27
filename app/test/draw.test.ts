import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createDrawing,
  moveAnchor,
  moveDrawing,
  hitTest,
  distanceToSegment,
  indexAtTime,
  timeAtIndex,
  measure,
  toShapes,
  magnetPrice,
  sanitizeDrawing,
  visibleOn,
  resetDrawingIds,
  ANCHOR_COUNT,
  FIB_LEVELS,
  ANCHOR_RADIUS,
  type Drawing,
  type Projector,
} from "../src/draw/model";
import { createDrawingStore, UNDO_DEPTH } from "../src/draw/store";
import { createKV, memoryRawStore } from "../src/store/kv";

beforeEach(() => resetDrawingIds());

const opts = { symbol: "BTCUSDT", timeframe: "1h", now: 1000 };

/** Bars an hour apart starting at t=0. */
const TIMES = Array.from({ length: 10 }, (_, i) => i * 3_600_000);

describe("createDrawing", () => {
  it("keeps only as many anchors as the kind needs", () => {
    const d = createDrawing("hline", [{ t: 0, p: 100 }, { t: 1, p: 200 }], opts);
    expect(d.anchors.length).toBe(1);
  });

  it("stamps created and updated together", () => {
    const d = createDrawing("trendline", [{ t: 0, p: 1 }, { t: 1, p: 2 }], opts);
    expect(d.createdAt).toBe(1000);
    expect(d.updatedAt).toBe(1000);
  });

  // A ray is a trendline that extends; one line path, not two.
  it("marks a ray as extending by default and a trendline as not", () => {
    expect(createDrawing("ray", [{ t: 0, p: 1 }, { t: 1, p: 2 }], opts).extendRight).toBe(true);
    expect(createDrawing("trendline", [{ t: 0, p: 1 }, { t: 1, p: 2 }], opts).extendRight).toBe(false);
  });

  it("gives every drawing a unique id", () => {
    const ids = new Set([
      createDrawing("hline", [{ t: 0, p: 1 }], opts).id,
      createDrawing("hline", [{ t: 0, p: 1 }], opts).id,
      createDrawing("hline", [{ t: 0, p: 1 }], opts).id,
    ]);
    expect(ids.size).toBe(3);
  });

  it("declares an anchor count for every kind it offers", () => {
    for (const [kind, n] of Object.entries(ANCHOR_COUNT)) {
      expect(n, kind).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("editing", () => {
  const line = () => createDrawing("trendline", [{ t: 0, p: 100 }, { t: 3_600_000, p: 110 }], opts);

  it("moves one anchor and leaves the other", () => {
    const next = moveAnchor(line(), 1, { t: 7_200_000, p: 120 }, 2000);
    expect(next.anchors[0]).toEqual({ t: 0, p: 100 });
    expect(next.anchors[1]).toEqual({ t: 7_200_000, p: 120 });
    expect(next.updatedAt).toBe(2000);
  });

  it("ignores an out-of-range anchor index", () => {
    const d = line();
    expect(moveAnchor(d, 5, { t: 0, p: 0 })).toBe(d);
    expect(moveAnchor(d, -1, { t: 0, p: 0 })).toBe(d);
  });

  it("translates every anchor together", () => {
    const next = moveDrawing(line(), 3_600_000, 5, 2000);
    expect(next.anchors[0]).toEqual({ t: 3_600_000, p: 105 });
    expect(next.anchors[1]).toEqual({ t: 7_200_000, p: 115 });
  });

  it("returns the same object for a zero move", () => {
    const d = line();
    expect(moveDrawing(d, 0, 0)).toBe(d);
  });

  it("refuses to edit a locked drawing", () => {
    const locked: Drawing = { ...line(), locked: true };
    expect(moveAnchor(locked, 0, { t: 9, p: 9 })).toBe(locked);
    expect(moveDrawing(locked, 100, 100)).toBe(locked);
  });
});

describe("distanceToSegment", () => {
  it("measures perpendicular distance to the middle", () => {
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBeCloseTo(5, 9);
  });

  it("clamps past the ends rather than measuring to the infinite line", () => {
    expect(distanceToSegment(-5, 0, 0, 0, 10, 0)).toBeCloseTo(5, 9);
    expect(distanceToSegment(20, 0, 0, 0, 10, 0)).toBeCloseTo(10, 9);
  });

  it("returns zero on the segment", () => {
    expect(distanceToSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 9);
  });

  // Without the guard this divides by zero and every zero-length drawing
  // swallows every click on the chart.
  it("treats a degenerate segment as a point", () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 9);
  });
});

describe("hitTest", () => {
  /* 1px per ms of time, 1px per unit of price inverted — simple and exact. */
  const proj: Projector = { x: (t) => t, y: (p) => 500 - p };
  const bounds = { width: 800, height: 500 };

  const line = createDrawing("trendline", [{ t: 100, p: 100 }, { t: 300, p: 200 }], opts);

  it("finds the body of a line", () => {
    expect(hitTest(line, 200, 350, proj, bounds)).toEqual({ kind: "body" });
  });

  it("misses when far from the line", () => {
    expect(hitTest(line, 200, 100, proj, bounds)).toBeNull();
  });

  // Anchors overlap the line they belong to. Reaching for a handle and getting
  // a whole-drawing drag moves the thing you were trying to adjust.
  it("prefers an anchor over the body when both are under the cursor", () => {
    expect(hitTest(line, 100, 400, proj, bounds)).toEqual({ kind: "anchor", index: 0 });
    expect(hitTest(line, 300, 300, proj, bounds)).toEqual({ kind: "anchor", index: 1 });
  });

  it("does not offer anchors on a locked drawing", () => {
    const locked: Drawing = { ...line, locked: true };
    expect(hitTest(locked, 100, 400, proj, bounds)).toEqual({ kind: "body" });
  });

  it("respects the anchor radius", () => {
    expect(hitTest(line, 100 + ANCHOR_RADIUS - 1, 400, proj, bounds)?.kind).toBe("anchor");
    expect(hitTest(line, 100 + ANCHOR_RADIUS + 40, 400, proj, bounds)?.kind).not.toBe("anchor");
  });

  it("hits a horizontal line anywhere along its price", () => {
    const h = createDrawing("hline", [{ t: 0, p: 250 }], opts);
    expect(hitTest(h, 5, 250, proj, bounds)).toEqual({ kind: "body" });
    expect(hitTest(h, 780, 250, proj, bounds)).toEqual({ kind: "body" });
    expect(hitTest(h, 400, 100, proj, bounds)).toBeNull();
  });

  // A horizontal line's anchor TIME is meaningless and a vertical line's anchor
  // PRICE is: a handle there would invite adjusting a coordinate that does not
  // exist, so for both the whole line is the handle.
  it("offers no anchor handle on a horizontal or vertical line", () => {
    const h = createDrawing("hline", [{ t: 0, p: 250 }], opts);
    expect(hitTest(h, 0, 250, proj, bounds)).toEqual({ kind: "body" });
    const v = createDrawing("vline", [{ t: 200, p: 300 }], opts);
    expect(hitTest(v, 200, 200, proj, bounds)).toEqual({ kind: "body" });
  });

  it("hits a vertical line anywhere along its time", () => {
    const v = createDrawing("vline", [{ t: 200, p: 0 }], opts);
    expect(hitTest(v, 200, 10, proj, bounds)).toEqual({ kind: "body" });
    expect(hitTest(v, 200, 480, proj, bounds)).toEqual({ kind: "body" });
    expect(hitTest(v, 400, 250, proj, bounds)).toBeNull();
  });

  it("hits inside a rectangle", () => {
    const r = createDrawing("rect", [{ t: 100, p: 100 }, { t: 300, p: 200 }], opts);
    expect(hitTest(r, 200, 350, proj, bounds)).toEqual({ kind: "body" });
    expect(hitTest(r, 500, 350, proj, bounds)).toBeNull();
  });

  // A ray must be clickable over its whole visible length, not only between the
  // two points that defined it.
  it("hits a ray beyond its second anchor", () => {
    const ray = createDrawing("ray", [{ t: 100, p: 100 }, { t: 200, p: 100 }], opts);
    expect(hitTest(ray, 700, 400, proj, bounds)).toEqual({ kind: "body" });
  });

  it("does not hit a plain trendline beyond its second anchor", () => {
    expect(hitTest(line, 700, 100, proj, bounds)).toBeNull();
  });
});

describe("indexAtTime / timeAtIndex", () => {
  it("maps bar times to their own indices", () => {
    expect(indexAtTime(TIMES, TIMES[0] as number)).toBeCloseTo(0, 9);
    expect(indexAtTime(TIMES, TIMES[5] as number)).toBeCloseTo(5, 9);
    expect(indexAtTime(TIMES, TIMES[9] as number)).toBeCloseTo(9, 9);
  });

  it("interpolates between bars", () => {
    expect(indexAtTime(TIMES, 1_800_000)).toBeCloseTo(0.5, 9);
    expect(indexAtTime(TIMES, 5_400_000)).toBeCloseTo(1.5, 9);
  });

  // The whole reason a ray can reach into next week.
  it("extrapolates past the last bar rather than clamping", () => {
    expect(indexAtTime(TIMES, (TIMES[9] as number) + 3_600_000)).toBeCloseTo(10, 9);
    expect(indexAtTime(TIMES, (TIMES[9] as number) + 36_000_000)).toBeCloseTo(19, 9);
  });

  it("extrapolates before the first bar", () => {
    expect(indexAtTime(TIMES, -3_600_000)).toBeCloseTo(-1, 9);
  });

  it("survives an empty or single-bar series", () => {
    expect(indexAtTime([], 12345)).toBe(0);
    expect(indexAtTime([500], 999)).toBe(0);
  });

  it("round-trips through timeAtIndex", () => {
    for (const t of [0, 1_800_000, 5_400_000, 32_400_000, -7_200_000, 50_000_000]) {
      expect(timeAtIndex(TIMES, indexAtTime(TIMES, t))).toBeCloseTo(t, 3);
    }
  });

  it("timeAtIndex extrapolates in both directions", () => {
    expect(timeAtIndex(TIMES, 10)).toBeCloseTo(36_000_000, 3);
    expect(timeAtIndex(TIMES, -1)).toBeCloseTo(-3_600_000, 3);
  });

  /**
   * REGRESSION. `Series` pre-allocates its Float64Arrays, so `series.t.length`
   * is the CAPACITY, not the bar count. Passing the raw array made this read
   * thousands of trailing zeros as timestamps, spacing went negative, and every
   * drawing's second anchor was stored as `t: 0` and rendered off screen. The
   * caller must bound it; these pin both halves of that.
   */
  it("works on a Float64Array subarray view", () => {
    const backing = new Float64Array(64);
    backing.set(TIMES);
    const view = backing.subarray(0, TIMES.length);
    expect(indexAtTime(view, TIMES[5] as number)).toBeCloseTo(5, 9);
    expect(timeAtIndex(view, 5)).toBeCloseTo(TIMES[5] as number, 3);
  });

  it("is demonstrably wrong when handed trailing zeros, which is why callers bound it", () => {
    const backing = new Float64Array(64);
    backing.set(TIMES);
    // The unbounded array: 10 real times followed by 54 zeros.
    expect(indexAtTime(backing, TIMES[5] as number)).not.toBeCloseTo(5, 3);
  });

  // A merged feed is exactly where duplicate stamps would appear.
  it("does not divide by zero on duplicate timestamps", () => {
    const dup = [0, 1000, 1000, 2000];
    expect(() => indexAtTime(dup, 1000)).not.toThrow();
    expect(Number.isFinite(indexAtTime(dup, 1000))).toBe(true);
  });
});

describe("measure", () => {
  it("reports delta, percent, bars and direction", () => {
    const d = createDrawing("measure", [{ t: 0, p: 100 }, { t: 3 * 3_600_000, p: 110 }], opts);
    const m = measure(d, TIMES);
    expect(m?.priceDelta).toBeCloseTo(10, 9);
    expect(m?.pricePct).toBeCloseTo(10, 9);
    expect(m?.bars).toBe(3);
    expect(m?.direction).toBe("up");
  });

  it("reports a fall as down", () => {
    const d = createDrawing("measure", [{ t: 0, p: 110 }, { t: 3_600_000, p: 100 }], opts);
    expect(measure(d, TIMES)?.direction).toBe("down");
  });

  it("returns null without two anchors", () => {
    expect(measure(createDrawing("hline", [{ t: 0, p: 1 }], opts), TIMES)).toBeNull();
  });
});

describe("toShapes", () => {
  it("renders a horizontal line as a level", () => {
    const s = toShapes(createDrawing("hline", [{ t: 0, p: 105 }], opts), TIMES);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ type: "level", y: 105 });
  });

  it("renders a trendline in bar-index space", () => {
    const d = createDrawing("trendline", [{ t: 0, p: 100 }, { t: 2 * 3_600_000, p: 110 }], opts);
    const s = toShapes(d, TIMES);
    expect(s[0]).toMatchObject({ type: "line", x0: 0, y0: 100, x1: 2, y1: 110 });
  });

  it("marks a ray as extending", () => {
    const d = createDrawing("ray", [{ t: 0, p: 100 }, { t: 3_600_000, p: 110 }], opts);
    expect(s0(toShapes(d, TIMES))).toMatchObject({ extend: true });
  });

  it("normalises rectangle corners regardless of drag direction", () => {
    const a = createDrawing("rect", [{ t: 2 * 3_600_000, p: 120 }, { t: 0, p: 100 }], opts);
    expect(s0(toShapes(a, TIMES))).toMatchObject({ type: "box", x0: 0, x1: 2, y0: 100, y1: 120 });
  });

  it("emits one level per Fibonacci ratio", () => {
    const d = createDrawing("fib", [{ t: 0, p: 100 }, { t: 3_600_000, p: 200 }], opts);
    const s = toShapes(d, TIMES);
    expect(s.length).toBe(FIB_LEVELS.length);
    expect(s.every((x) => x.type === "level")).toBe(true);
  });

  // Drawn low-to-high, 0% must sit at the high — that is what a retracement is.
  it("puts 0% at the second anchor when drawn upward", () => {
    const d = createDrawing("fib", [{ t: 0, p: 100 }, { t: 3_600_000, p: 200 }], opts);
    const levels = toShapes(d, TIMES) as { y: number; label: string }[];
    const zero = levels.find((l) => l.label === "0.0%");
    const hundred = levels.find((l) => l.label === "100.0%");
    expect(zero?.y).toBeCloseTo(200, 9);
    expect(hundred?.y).toBeCloseTo(100, 9);
  });

  it("puts 0% at the low when drawn downward", () => {
    const d = createDrawing("fib", [{ t: 0, p: 200 }, { t: 3_600_000, p: 100 }], opts);
    const levels = toShapes(d, TIMES) as { y: number; label: string }[];
    expect(levels.find((l) => l.label === "0.0%")?.y).toBeCloseTo(100, 9);
  });

  it("labels a measure box with percent and bars", () => {
    const d = createDrawing("measure", [{ t: 0, p: 100 }, { t: 2 * 3_600_000, p: 110 }], opts);
    expect((s0(toShapes(d, TIMES)) as { label: string }).label).toMatch(/10\.00% · 2 bars/);
  });

  it("renders a note as a marker carrying its text", () => {
    const d = createDrawing("text", [{ t: 0, p: 100 }], { ...opts, text: "watch this" });
    expect(s0(toShapes(d, TIMES))).toMatchObject({ type: "marker", text: "watch this" });
  });

  it("returns nothing for an incomplete two-point drawing", () => {
    const broken = { ...createDrawing("trendline", [{ t: 0, p: 1 }, { t: 1, p: 2 }], opts), anchors: [{ t: 0, p: 1 }] };
    expect(toShapes(broken as Drawing, TIMES)).toEqual([]);
  });
});

const s0 = (shapes: unknown[]): unknown => shapes[0];

describe("magnetPrice", () => {
  const bars = [{ t: 0, o: 100, h: 110, l: 90, c: 105 }];

  it("snaps to the nearest OHLC inside tolerance", () => {
    expect(magnetPrice(bars, 0, 109, 3)).toBe(110);
    expect(magnetPrice(bars, 0, 91, 3)).toBe(90);
    expect(magnetPrice(bars, 0, 104, 3)).toBe(105);
  });

  // A magnet that always fires cannot draw anything that is not on a bar.
  it("leaves the price alone when nothing is close", () => {
    expect(magnetPrice(bars, 0, 100.001 + 50, 1)).toBe(150.001);
  });

  it("does nothing without a bar or a tolerance", () => {
    expect(magnetPrice(bars, 99, 109, 3)).toBe(109);
    expect(magnetPrice(bars, 0, 109, 0)).toBe(109);
  });

  it("rounds the index to pick a bar", () => {
    expect(magnetPrice(bars, 0.4, 109, 3)).toBe(110);
  });
});

describe("sanitizeDrawing", () => {
  const good = createDrawing("trendline", [{ t: 0, p: 100 }, { t: 1, p: 110 }], opts);

  it("accepts a well-formed drawing", () => {
    expect(sanitizeDrawing(JSON.parse(JSON.stringify(good)))).toMatchObject({ kind: "trendline" });
  });

  it("rejects an unknown kind", () => {
    expect(sanitizeDrawing({ ...good, kind: "gann-fan" })).toBeNull();
  });

  // A trendline with one anchor renders as a line to the origin, which looks
  // like a bug in the chart rather than a broken drawing.
  it("rejects too few anchors rather than half-rendering", () => {
    expect(sanitizeDrawing({ ...good, anchors: [{ t: 0, p: 1 }] })).toBeNull();
  });

  it("rejects non-finite anchor values", () => {
    expect(sanitizeDrawing({ ...good, anchors: [{ t: NaN, p: 1 }, { t: 1, p: 2 }] })).toBeNull();
    expect(sanitizeDrawing({ ...good, anchors: [{ t: 0, p: Infinity }, { t: 1, p: 2 }] })).toBeNull();
  });

  it("replaces an unknown tone rather than dropping the drawing", () => {
    expect(sanitizeDrawing({ ...good, tone: "chartreuse" })).toMatchObject({ tone: "neutral" });
  });

  it("rejects non-objects", () => {
    expect(sanitizeDrawing(null)).toBeNull();
    expect(sanitizeDrawing("trendline")).toBeNull();
    expect(sanitizeDrawing({ kind: "trendline" })).toBeNull();
  });
});

describe("visibleOn", () => {
  const list = [
    createDrawing("hline", [{ t: 0, p: 1 }], { symbol: "BTCUSDT", timeframe: "1h" }),
    createDrawing("hline", [{ t: 0, p: 2 }], { symbol: "BTCUSDT", timeframe: "" }),
    createDrawing("hline", [{ t: 0, p: 3 }], { symbol: "ETHUSDT", timeframe: "1h" }),
  ];

  it("matches the symbol and timeframe", () => {
    expect(visibleOn(list, "BTCUSDT", "1h").length).toBe(2);
  });

  // An empty timeframe means "every timeframe of this symbol".
  it("shows an all-timeframe drawing on another timeframe", () => {
    const out = visibleOn(list, "BTCUSDT", "4h");
    expect(out.length).toBe(1);
    expect(out[0]?.anchors[0]?.p).toBe(2);
  });

  it("never leaks another symbol's drawings", () => {
    expect(visibleOn(list, "SOLUSDT", "1h")).toEqual([]);
  });
});

describe("createDrawingStore", () => {
  const build = () => createDrawingStore(createKV(memoryRawStore()));
  const mk = (p: number) => createDrawing("hline", [{ t: 0, p }], opts);

  it("starts empty and adds", () => {
    const s = build();
    expect(s.all().length).toBe(0);
    s.add(mk(100));
    expect(s.all().length).toBe(1);
  });

  it("removes by id and ignores an unknown one", () => {
    const s = build();
    const d = mk(100);
    s.add(d);
    s.remove("nope");
    expect(s.all().length).toBe(1);
    s.remove(d.id);
    expect(s.all().length).toBe(0);
  });

  it("updates in place", () => {
    const s = build();
    const d = mk(100);
    s.add(d);
    s.update(d.id, moveAnchor(d, 0, { t: 0, p: 200 }));
    expect(s.all()[0]?.anchors[0]?.p).toBe(200);
  });

  it("bumps the revision on every change", () => {
    const s = build();
    const before = s.revision();
    s.add(mk(1));
    expect(s.revision()).toBe(before + 1);
  });

  it("clears one chart without touching another", () => {
    const s = build();
    s.add(createDrawing("hline", [{ t: 0, p: 1 }], { symbol: "BTCUSDT", timeframe: "1h" }));
    s.add(createDrawing("hline", [{ t: 0, p: 2 }], { symbol: "ETHUSDT", timeframe: "1h" }));
    s.clearChart("BTCUSDT", "1h");
    expect(s.all().length).toBe(1);
    expect(s.all()[0]?.symbol).toBe("ETHUSDT");
  });

  it("undoes and redoes", () => {
    const s = build();
    s.add(mk(100));
    s.add(mk(200));
    expect(s.all().length).toBe(2);
    expect(s.undo()).toBe(true);
    expect(s.all().length).toBe(1);
    expect(s.redo()).toBe(true);
    expect(s.all().length).toBe(2);
  });

  it("reports whether it can undo or redo", () => {
    const s = build();
    expect(s.canUndo()).toBe(false);
    expect(s.undo()).toBe(false);
    s.add(mk(1));
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
    s.undo();
    expect(s.canRedo()).toBe(true);
  });

  // The future you could have had is not the future you are in.
  it("discards the redo branch after a new edit", () => {
    const s = build();
    s.add(mk(1));
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.add(mk(2));
    expect(s.canRedo()).toBe(false);
  });

  // One drag emits an edit per frame; pushed naively that buries the stack.
  it("collapses a batched interaction into one undo step", () => {
    const s = build();
    const d = mk(100);
    s.add(d);
    s.begin();
    let cur = d;
    for (let i = 0; i < 30; i++) {
      cur = moveAnchor(cur, 0, { t: 0, p: 100 + i });
      s.update(cur.id, cur);
    }
    s.commit();
    expect(s.all()[0]?.anchors[0]?.p).toBe(129);
    s.undo();
    expect(s.all()[0]?.anchors[0]?.p).toBe(100);
  });

  it("bounds the undo stack", () => {
    const s = build();
    for (let i = 0; i < UNDO_DEPTH + 25; i++) s.add(mk(i));
    let undone = 0;
    while (s.undo()) undone++;
    expect(undone).toBeLessThanOrEqual(UNDO_DEPTH);
  });

  it("persists across a reload of the same store", () => {
    const kv = createKV(memoryRawStore());
    const a = createDrawingStore(kv);
    a.add(mk(123));
    const b = createDrawingStore(kv);
    expect(b.all().length).toBe(1);
    expect(b.all()[0]?.anchors[0]?.p).toBe(123);
  });

  it("drops a corrupt entry without losing the rest of the book", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const kv = createKV(memoryRawStore());
      const a = createDrawingStore(kv);
      a.add(mk(1));
      a.add(mk(2));
      // Corrupt one entry the way a bad sync or a hand-edited vault would.
      const raw = kv.rawEnvelope("drawings.book") as { value: unknown[] };
      (raw.value as Record<string, unknown>[])[0]!["kind"] = "gann-fan";
      kv.write({ key: "drawings.book", version: 1, fallback: () => [], validate: (v) => v as unknown[] }, raw.value);

      const b = createDrawingStore(kv);
      expect(b.all().length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
