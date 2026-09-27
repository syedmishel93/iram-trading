import { describe, it, expect, beforeEach } from "vitest";
import { Viewport } from "../src/chart/viewport";
import { Series } from "../src/chart/series";

function series(n: number): Series {
  const s = new Series(n);
  for (let i = 0; i < n; i++) s.push(i * 3_600_000, 100 + i, 102 + i, 98 + i, 101 + i, 1);
  return s;
}

describe("Viewport geometry", () => {
  let vp: Viewport;

  beforeEach(() => {
    vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    vp.offset = 0;
    vp.priceMin = 0;
    vp.priceMax = 100;
  });

  it("maps index to x and back consistently", () => {
    expect(vp.xOf(0)).toBe(0);
    expect(vp.xOf(10)).toBe(100);
    expect(vp.indexAtX(100)).toBe(10);
  });

  it("maps price to y inverted (high price = low y)", () => {
    expect(vp.yOf(100)).toBe(0);
    expect(vp.yOf(0)).toBe(600);
    expect(vp.yOf(50)).toBe(300);
    expect(vp.priceAtY(300)).toBe(50);
  });

  it("only reports the bars actually on screen", () => {
    const { from, to } = vp.visibleRange(1000);
    // 1000px / 10px per bar = 100 visible, plus one bar of padding each side.
    expect(from).toBe(0);
    expect(to).toBeLessThanOrEqual(102);
    expect(to).toBeGreaterThanOrEqual(100);
  });
});

describe("Viewport.zoomAt", () => {
  let vp: Viewport;

  beforeEach(() => {
    vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    vp.offset = 0;
  });

  it("keeps the bar under the cursor pinned while zooming", () => {
    // The anchor property. Without it the chart drifts out from under the
    // pointer, which is the most common feel complaint about home-grown charts.
    const anchorX = 400;
    const before = vp.indexAtX(anchorX);
    vp.zoomAt(anchorX, 1.5, 5000);
    const after = vp.indexAtX(anchorX);
    expect(after).toBeCloseTo(before, 6);
  });

  it("holds the anchor across repeated zooms in both directions", () => {
    const anchorX = 250;
    const before = vp.indexAtX(anchorX);
    for (let i = 0; i < 8; i++) vp.zoomAt(anchorX, 1.12, 5000);
    for (let i = 0; i < 8; i++) vp.zoomAt(anchorX, 1 / 1.12, 5000);
    expect(vp.indexAtX(anchorX)).toBeCloseTo(before, 6);
  });

  it("clamps bar width to the allowed range", () => {
    for (let i = 0; i < 200; i++) vp.zoomAt(500, 2, 5000);
    expect(vp.barWidth).toBeLessThanOrEqual(Viewport.MAX_BAR_WIDTH);

    for (let i = 0; i < 400; i++) vp.zoomAt(500, 0.5, 5000);
    expect(vp.barWidth).toBeGreaterThanOrEqual(Viewport.MIN_BAR_WIDTH);
  });

  it("detaches live-follow, because zooming is a manual act", () => {
    vp.followLive = true;
    vp.zoomAt(500, 1.2, 5000);
    expect(vp.followLive).toBe(false);
  });
});

describe("Viewport.fitPrice", () => {
  it("brackets the visible highs and lows with headroom", () => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    vp.offset = 0;

    const s = series(200);
    vp.fitPrice(s);

    const { from, to } = vp.visibleRange(s.length);
    const { min, max } = s.extent(from, to);
    expect(vp.priceMin).toBeLessThan(min);
    expect(vp.priceMax).toBeGreaterThan(max);
  });

  it("does nothing once the user has taken manual control", () => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.autoScale = false;
    vp.priceMin = 1;
    vp.priceMax = 2;
    vp.fitPrice(series(100));
    expect(vp.priceMin).toBe(1);
    expect(vp.priceMax).toBe(2);
  });

  it("survives a dead-flat series without collapsing the axis", () => {
    // A halted market or a constant synthetic series has zero span; a naive
    // implementation divides by it and every yOf() becomes NaN.
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;

    const flat = new Series(64);
    for (let i = 0; i < 50; i++) flat.push(i * 60_000, 50, 50, 50, 50, 1);

    vp.fitPrice(flat);
    expect(vp.priceMax).toBeGreaterThan(vp.priceMin);
    expect(Number.isFinite(vp.yOf(50))).toBe(true);
  });
});

describe("Viewport.clampOffset", () => {
  it("allows overscroll past the newest bar for projections", () => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    vp.offset = 99_999;
    vp.clampOffset(500);
    // Right edge may pass the last bar, but not by more than the allowance.
    expect(vp.offset).toBeGreaterThan(500 - vp.barsVisible);
    expect(vp.offset).toBeLessThan(500);
  });

  it("stops the chart being dragged entirely off screen to the left", () => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    vp.offset = -99_999;
    vp.clampOffset(500);
    expect(vp.offset).toBe(-vp.barsVisible * 0.5);
  });
});

/**
 * The bug this suite existed to prevent and did not catch, because it lives
 * between two valid states rather than inside either one: a viewport that is
 * correct for the series it was built against, and a series that has been
 * replaced underneath it.
 */
describe("surviving a series that gets replaced", () => {
  const wide = (): Viewport => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    vp.barWidth = 10;
    return vp;
  };

  it("re-anchors when the new series is shorter than the old offset", () => {
    /* MEASURED, LIVE. XAUUSD 1m (801 bars) → 1h (537 bars) with the view at
       offset 640: visibleRange came back {from: 639, to: 639} — an empty span,
       no candles drawn, and fitPrice returning early so the price axis kept the
       1-minute chart's numbers. The gestures all still "worked". */
    const vp = wide();
    vp.offset = 640;
    vp.followLive = false;
    expect(vp.showsData(537)).toBe(false);

    expect(vp.revalidate(537)).toBe(true);
    expect(vp.showsData(537)).toBe(true);
    const { from, to } = vp.visibleRange(537);
    expect(to).toBeGreaterThan(from);
  });

  it("re-enables autoscaling when it rescues a view, so the axis cannot stay stale", () => {
    /* The blank plot and the wrong axis are ONE bug with two symptoms: an empty
       visible range means fitPrice has nothing to fit, so whatever prices were
       on the axis stay there. Fixing the offset without this leaves gold priced
       in the last instrument's units. */
    const vp = wide();
    vp.offset = 5_000;
    vp.autoScale = false;
    vp.priceMin = 76_750;
    vp.priceMax = 82_750;
    vp.revalidate(537);
    expect(vp.autoScale).toBe(true);
  });

  it("leaves a legitimately scrolled-back view exactly where it is", () => {
    /* The whole point of not re-anchoring on every data change: an operator
       reading three weeks of history must not be thrown to the live edge
       because a bar arrived. */
    const vp = wide();
    vp.offset = 120;
    vp.followLive = false;
    vp.autoScale = false;
    expect(vp.revalidate(800)).toBe(false);
    expect(vp.offset).toBe(120);
    expect(vp.autoScale).toBe(false);
  });

  it("treats the deliberate overscroll at both ends as a valid view", () => {
    /* clampOffset allows the chart to be pushed past the newest bar so there is
       room to draw projections into. If revalidate disagreed with clampOffset
       about what is legal, the two would fight every frame. */
    const vp = wide();
    vp.offset = -vp.barsVisible * 0.5;
    expect(vp.showsData(800)).toBe(true);
    vp.offset = 800 - vp.barsVisible * 0.34;
    expect(vp.showsData(800)).toBe(true);
  });
});

describe("scaling the price axis", () => {
  const vp0 = (): Viewport => {
    const vp = new Viewport();
    vp.resize(1000, 600, 1);
    vp.insets = { top: 0, right: 40, bottom: 0, left: 0 };
    vp.priceMin = 100;
    vp.priceMax = 200;
    return vp;
  };

  it("keeps the price under the anchor fixed", () => {
    const vp = vp0();
    const y = 150;
    const at = vp.priceAtY(y);
    vp.scalePriceAt(y, 2);
    expect(vp.priceAtY(y)).toBeCloseTo(at, 6);
    expect(vp.priceMax - vp.priceMin).toBeCloseTo(50, 6);
  });

  it("detaches autoscaling, because a scale you chose must not be overwritten", () => {
    const vp = vp0();
    expect(vp.autoScale).toBe(true);
    vp.scalePriceAt(300, 1.2);
    expect(vp.autoScale).toBe(false);
  });

  it("refuses to collapse the axis to nothing", () => {
    const vp = vp0();
    for (let i = 0; i < 500; i++) vp.scalePriceAt(300, 4);
    expect(vp.priceMax - vp.priceMin).toBeGreaterThan(0);
    expect(Number.isFinite(vp.priceMin)).toBe(true);
  });

  it("knows the price gutter from the plot", () => {
    const vp = vp0();
    expect(vp.onPriceAxis(500)).toBe(false);
    expect(vp.onPriceAxis(980)).toBe(true);
  });

  it("shifts without resizing", () => {
    const vp = vp0();
    const span = vp.priceMax - vp.priceMin;
    vp.shiftPrice(60);
    expect(vp.priceMax - vp.priceMin).toBeCloseTo(span, 6);
    expect(vp.priceMin).toBeGreaterThan(100);
  });
});
