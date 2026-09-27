/**
 * Viewport: the mapping between bar index / price and screen pixels.
 *
 * Kept deliberately separate from the renderer so scrolling, zooming and
 * autoscaling are pure arithmetic that can be unit-tested without a canvas —
 * the class of bug that is otherwise only reproducible by dragging a mouse.
 */

import type { Series } from "./series";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** How price maps to pixels. */
export type PriceScale = "linear" | "log";

/**
 * Smallest price a log axis will take the logarithm of.
 *
 * Not zero: `Math.log(0)` is `-Infinity`, which propagates into every y on the
 * chart. A price this small is below the tick of anything traded anywhere.
 */
const LOG_FLOOR = 1e-9;

export class Viewport {
  /** Fractional index at the left edge. Fractional so panning is sub-bar smooth. */
  offset = 0;
  /** Pixels per bar. */
  barWidth = 8;

  /** Price range currently mapped to the plot height. */
  priceMin = 0;
  priceMax = 1;

  /**
   * How price maps to pixels.
   *
   * WHY THIS IS NOT COSMETIC
   * On a linear axis every pixel is worth the same number of dollars, so a
   * $2,000 move at $8,000 and a $2,000 move at $80,000 are drawn the same
   * height — one is a 25% move and the other is 2.5%. Over any long range that
   * is not a stylistic preference, it is a chart that misreports what happened:
   * a year of Bitcoin on a linear axis flattens the first eight months into a
   * line at the floor and shows only the last leg as having any shape at all.
   *
   * On a log axis equal PERCENTAGE moves get equal height, which is what a
   * trend line, a channel and a retracement all silently assume about the
   * surface they are drawn on.
   *
   * The window is still stored in PRICE units, not log units, so autoscale,
   * pan, zoom, drawings and every caller of `priceMin`/`priceMax` keep working
   * unchanged. Only the mapping through `yOf`/`priceAtY` knows.
   */
  scale: PriceScale = "linear";

  /** True while the price axis follows the data. Any manual drag clears it. */
  autoScale = true;
  /** True while the right edge follows the newest bar. */
  followLive = true;

  width = 0;
  height = 0;
  dpr = 1;

  insets: Insets = { top: 8, right: 64, bottom: 76, left: 0 };

  static readonly MIN_BAR_WIDTH = 0.5;
  static readonly MAX_BAR_WIDTH = 64;

  /**
   * How much of the plot must be showing actual bars for the view to count as
   * valid. Below this the operator is looking at an empty rectangle, and every
   * gesture they make on it — zoom especially — appears to do nothing.
   */
  static readonly MIN_VISIBLE_FRACTION = 0.1;

  /** How far the price axis may be scaled in one gesture step. */
  static readonly MIN_PRICE_SPAN_RATIO = 1e-6;

  /** Plot rectangle in CSS pixels. */
  get plotLeft(): number {
    return this.insets.left;
  }
  get plotTop(): number {
    return this.insets.top;
  }
  get plotWidth(): number {
    return Math.max(0, this.width - this.insets.left - this.insets.right);
  }
  get plotHeight(): number {
    return Math.max(0, this.height - this.insets.top - this.insets.bottom);
  }

  /** How many bars fit across the plot. */
  get barsVisible(): number {
    return this.plotWidth / this.barWidth;
  }

  /** First and last bar index touching the plot, clamped and padded by one. */
  visibleRange(len: number): { from: number; to: number } {
    const from = Math.max(0, Math.floor(this.offset) - 1);
    const to = Math.min(len, Math.ceil(this.offset + this.barsVisible) + 1);
    return { from, to: Math.max(from, to) };
  }

  xOf(index: number): number {
    return this.plotLeft + (index - this.offset) * this.barWidth;
  }

  /** Centre of a bar's candle body. */
  xCenterOf(index: number): number {
    return this.xOf(index) + this.barWidth / 2;
  }

  indexAtX(x: number): number {
    return (x - this.plotLeft) / this.barWidth + this.offset;
  }

  /**
   * Price into the space the axis is linear in.
   *
   * Log is only defined above zero, and a window whose floor has been panned to
   * or below zero is reachable — so the guard is not defensive programming, it
   * is the difference between a log chart and `NaN` for every y on screen. A
   * non-positive window silently draws linear, because a blank chart is a worse
   * answer to "you panned too far down" than a correct linear one.
   */
  private toSpace(price: number): number {
    return this.scale === "log" && this.priceMin > 0 ? Math.log(Math.max(price, LOG_FLOOR)) : price;
  }

  private fromSpace(v: number): number {
    return this.scale === "log" && this.priceMin > 0 ? Math.exp(v) : v;
  }

  yOf(price: number): number {
    const lo = this.toSpace(this.priceMin);
    const span = this.toSpace(this.priceMax) - lo || 1;
    return this.plotTop + (1 - (this.toSpace(price) - lo) / span) * this.plotHeight;
  }

  priceAtY(y: number): number {
    const lo = this.toSpace(this.priceMin);
    const span = this.toSpace(this.priceMax) - lo || 1;
    return this.fromSpace(lo + (1 - (y - this.plotTop) / this.plotHeight) * span);
  }

  /**
   * Fit the price axis to what is on screen, with headroom.
   *
   * The padding is proportional, not fixed pixels, so the candles never touch
   * the top and bottom edges at any zoom level.
   */
  fitPrice(series: Series, padding = 0.08): void {
    if (!this.autoScale) return;
    const { from, to } = this.visibleRange(series.length);
    if (to <= from) return;
    const { min, max } = series.extent(from, to);
    const span = max - min;
    // A dead-flat series (a synthetic constant, or a halted market) would give a
    // zero span and divide-by-zero the whole axis. Give it an arbitrary but
    // stable window around the value instead.
    if (this.scale === "log" && min > 0) {
      /* Pad by a proportion of the LOG span. Padding a log axis in price units
         gives a fat gap under the low and a sliver over the high, because the
         same number of dollars is a different distance at each end. */
      const lo = Math.log(min);
      const hi = Math.log(max);
      const logSpan = hi - lo;
      const logPad = logSpan === 0 ? 0.01 : logSpan * padding;
      this.priceMin = Math.exp(lo - logPad);
      this.priceMax = Math.exp(hi + logPad);
      return;
    }
    const pad = span === 0 ? Math.abs(max) * 0.01 || 1 : span * padding;
    this.priceMin = min - pad;
    this.priceMax = max + pad;
  }

  /**
   * Is the current view actually looking at data?
   *
   * Separate from `visibleRange` because "some bars are on screen" and "enough
   * bars are on screen to be a chart" are different questions, and only the
   * second one is worth re-anchoring for.
   */
  showsData(len: number): boolean {
    if (len === 0) return false;
    const { from, to } = this.visibleRange(len);
    const shown = Math.max(0, Math.min(to, len) - Math.max(0, from));
    return shown >= Math.min(len, this.barsVisible * Viewport.MIN_VISIBLE_FRACTION);
  }

  /**
   * Make the view valid for a series that has just been REPLACED.
   *
   * THIS IS THE BUG THAT READS AS "I CANNOT ZOOM".
   * The viewport survives a symbol or timeframe change by design — the chart
   * must not jump every time a bar arrives. But `offset` is an index into the
   * OLD series, and nothing ever checked it against the new one. Switch from a
   * series of 801 bars to one of 537 while the view is anywhere past bar 537
   * and `visibleRange` returns an empty span: no candles are drawn, and
   * `fitPrice` returns early on `to <= from` so the price axis keeps the
   * PREVIOUS instrument's numbers. Measured, live: XAUUSD 1h rendering an
   * empty plot against an axis inherited from the chart before it.
   *
   * Every gesture still worked — `barWidth` changed on each wheel notch, the
   * offset tracked the pointer — and none of it drew anything, because there
   * was nothing in range to draw. From the operator's chair that is a chart
   * that has stopped responding, which is exactly how it was reported.
   *
   * Returns true when it had to intervene, so the caller can tell a normal
   * append from a rescue.
   */
  revalidate(len: number): boolean {
    if (len === 0) return false;

    let fixed = false;
    if (!Number.isFinite(this.offset)) {
      this.offset = 0;
      fixed = true;
    }
    if (!this.showsData(len)) {
      /* Re-anchor to the newest bar rather than clamping to the nearest legal
         offset: after a timeframe change the operator is asking about NOW, and
         a silent landing at "the last place that happens to be in range" is a
         position nobody chose. */
      this.scrollToLive(len);
      this.clampOffset(len);
      this.autoScale = true;
      fixed = true;
    } else {
      this.clampOffset(len);
    }

    /* A price range that does not overlap the visible bars is the same failure
       on the other axis, and it can happen on its own: pan the axis away, then
       switch instruments, and `autoScale` is off with a window around a price
       this series never trades at. */
    const { from, to } = this.visibleRange(len);
    if (!this.autoScale && to > from) {
      const span = this.priceMax - this.priceMin;
      if (!(span > 0)) {
        this.autoScale = true;
        fixed = true;
      }
    }
    return fixed;
  }

  /**
   * Scale the price axis about a pixel anchor, keeping the price under the
   * cursor fixed. The mirror of `zoomAt` for the vertical axis.
   *
   * There was no vertical zoom at all before this. A drag detached the axis and
   * SHIFTED it, so the only thing the operator could do to the price scale was
   * move it somewhere they could not get back from without knowing that
   * double-click resets. "Cannot zoom vertically" was literally true.
   */
  scalePriceAt(y: number, factor: number): void {
    const anchor = this.priceAtY(y);
    if (!Number.isFinite(anchor)) return;

    /* Zoom happens in the space the axis is linear in. Scaling the price window
       directly on a log axis moves the anchor out from under the cursor,
       because the pixel distance to it is not proportional to the price
       distance — the axis would slide while you zoomed. */
    const lo = this.toSpace(this.priceMin);
    const hi = this.toSpace(this.priceMax);
    const a = this.toSpace(anchor);
    const span = hi - lo;
    if (!(span > 0)) return;

    const next = span / factor;
    if (this.scale === "linear" && !(next > Math.abs(anchor) * Viewport.MIN_PRICE_SPAN_RATIO)) return;
    if (this.scale === "log" && !(next > 1e-6)) return;

    const share = (hi - a) / span;
    this.autoScale = false;
    this.priceMax = this.fromSpace(a + next * share);
    this.priceMin = this.fromSpace(a + next * share - next);
  }

  /** Move the price window without changing its height. */
  shiftPrice(dyPixels: number): void {
    if (this.plotHeight <= 0) return;
    const lo = this.toSpace(this.priceMin);
    const hi = this.toSpace(this.priceMax);
    const span = hi - lo;
    if (!(span > 0)) return;
    /* A drag of N pixels must move the window by N pixels' worth of axis,
       which on a log axis is a constant RATIO rather than a constant amount. */
    const shift = (dyPixels / this.plotHeight) * span;
    this.autoScale = false;
    this.priceMin = this.fromSpace(lo + shift);
    this.priceMax = this.fromSpace(hi + shift);
  }

  /** Is this pixel column inside the price gutter rather than the plot? */
  onPriceAxis(x: number): boolean {
    return x > this.plotLeft + this.plotWidth;
  }

  /** Scroll so the newest bar sits just inside the right edge. */
  scrollToLive(len: number): void {
    const rightGap = Math.min(12, this.barsVisible * 0.12);
    this.offset = len - this.barsVisible + rightGap;
  }

  /**
   * Zoom about a pixel anchor, keeping the bar under the cursor fixed.
   * Without the anchor correction, wheel-zoom drifts the chart out from under
   * the pointer, which is the single most common feel complaint about
   * home-grown charts.
   */
  zoomAt(x: number, factor: number, len: number): void {
    const anchorIndex = this.indexAtX(x);
    const next = clamp(this.barWidth * factor, Viewport.MIN_BAR_WIDTH, Viewport.MAX_BAR_WIDTH);
    if (next === this.barWidth) return;
    this.barWidth = next;
    this.offset = anchorIndex - (x - this.plotLeft) / this.barWidth;
    this.followLive = false;
    this.clampOffset(len);
  }

  panBy(dxPixels: number, len: number): void {
    this.offset -= dxPixels / this.barWidth;
    this.followLive = false;
    this.clampOffset(len);
  }

  /**
   * Keep at least a few bars on screen at both ends.
   *
   * Overscroll past the newest bar is deliberately allowed (up to a third of a
   * screen) because traders use that empty space to draw projections into.
   */
  clampOffset(len: number): void {
    const minOffset = -this.barsVisible * 0.5;
    const maxOffset = len - this.barsVisible * 0.34;
    this.offset = clamp(this.offset, minOffset, Math.max(minOffset, maxOffset));
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}


/**
 * The prices to label and rule on the axis.
 *
 * PURE, AND OUTSIDE THE ENGINE, BECAUSE THIS IS WHERE IT BROKE.
 * The log branch first shipped generating only 1, 2 and 5 times powers of ten.
 * For a Bitcoin window of 65,000-80,000 that is the EMPTY SET, and the result
 * was a log chart that drew perfectly with a completely blank price axis — a
 * defect that reads as a rendering fault and is nothing of the kind. Buried in
 * a private method on a canvas class it was reachable only by looking at a
 * screenshot; here it is nine lines of test.
 *
 * TWO SOURCES OF CANDIDATES, THINNED BY PIXELS.
 * Decade multiples carry a window that spans decades and place the low end,
 * where linear steps would leave nothing at all. Linear nice-steps carry a
 * narrow window, where decade multiples produce nothing at all. Union them and
 * let SCREEN DISTANCE decide what survives, because once the axis is non-linear
 * that is the only measure of crowding that means anything.
 */
export function priceTicksFor(vp: Viewport, minPx = 44): number[] {
  const span = vp.priceMax - vp.priceMin;
  if (!(span > 0) || !Number.isFinite(span)) return [];

  const target = Math.max(2, Math.floor(vp.plotHeight / 48));
  const linStep = niceStep(span / target);

  if (vp.scale !== "log" || vp.priceMin <= 0) {
    const out: number[] = [];
    if (!(linStep > 0)) return out;
    for (let p = Math.ceil(vp.priceMin / linStep) * linStep; p <= vp.priceMax; p += linStep) {
      out.push(Number(p.toPrecision(12)));
    }
    return out;
  }

  const seen = new Set<number>();
  const candidates: number[] = [];
  const add = (raw: number): void => {
    // Rounded before the set test: float addition drifts, and 78999.999999999985
    // is both a different key and an unreadable label.
    const v = Number(raw.toPrecision(12));
    if (v >= vp.priceMin && v <= vp.priceMax && !seen.has(v)) {
      seen.add(v);
      candidates.push(v);
    }
  };

  for (let d = Math.floor(Math.log10(vp.priceMin)); d <= Math.ceil(Math.log10(vp.priceMax)); d++) {
    const mag = Math.pow(10, d);
    for (const m of [1, 2, 5]) add(m * mag);
  }
  if (linStep > 0) {
    for (let v = Math.ceil(vp.priceMin / linStep) * linStep; v <= vp.priceMax; v += linStep) add(v);
  }

  candidates.sort((a, b) => a - b);

  const out: number[] = [];
  let lastY = -Infinity;
  /* Top-down, so a crowded cluster keeps its highest member and the surviving
     gaps land consistently rather than depending on where the loop started.
     
     The comparison is `y - lastY`, and getting that backwards is what the
     regression test pins: iterating from the highest PRICE means descending the
     screen, so y INCREASES each step. Written the other way round the gap is
     always negative, nothing after the first candidate ever clears the
     threshold, and the axis renders exactly one label. */
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = candidates[i] as number;
    const y = vp.yOf(v);
    if (y - lastY >= minPx || out.length === 0) {
      out.push(v);
      lastY = y;
    }
  }
  return out.reverse();
}

/** 1, 2, 2.5 or 5 times a power of ten — the steps people read without effort. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
}
