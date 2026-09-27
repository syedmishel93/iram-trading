/**
 * Holding the view still while history is prepended.
 *
 * THE BUG THIS PREVENTS IS THE WHOLE FEATURE.
 * `Viewport.offset` is an INDEX. Backfill pushes older bars onto the front of
 * the series, so every index shifts by however many arrived. Leave the offset
 * alone and the chart lurches right by exactly the amount of history it just
 * gained — at the precise moment the operator reached left for more of it.
 * Scroll-back that jumps is worse than scroll-back that stops.
 */

import { describe, expect, it } from "vitest";
import { anchorShift, indexOfTime, needsOlderBars } from "../src/chart/anchor";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** `n` hourly timestamps ending at `T0`. Prepending moves the start back. */
const times = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => T0 - (n - 1 - i) * HOUR);

const at = (offset: number, prev: number[], next: number[], opts: Partial<{ followLive: boolean; replaced: boolean }> = {}) =>
  anchorShift({
    prevTimes: prev,
    prevLength: prev.length,
    nextTimes: next,
    nextLength: next.length,
    offset,
    followLive: opts.followLive ?? false,
    replaced: opts.replaced ?? false,
  });

describe("indexOfTime", () => {
  const t = times(1000);

  it("finds an exact bar", () => {
    expect(indexOfTime(t, t.length, t[437] as number)).toBe(437);
    expect(indexOfTime(t, t.length, t[0] as number)).toBe(0);
    expect(indexOfTime(t, t.length, t[999] as number)).toBe(999);
  });

  it("returns the next bar when the exact time is missing", () => {
    // A gap — a halted market, a vendor hole. The bar after is the honest
    // answer; the bar before would silently move the view backwards.
    expect(indexOfTime(t, t.length, (t[500] as number) - HOUR / 2)).toBe(500);
  });

  it("returns -1 past the end", () => {
    expect(indexOfTime(t, t.length, T0 + HOUR)).toBe(-1);
  });

  it("returns 0 for a time before the series", () => {
    expect(indexOfTime(t, t.length, T0 - 5000 * HOUR)).toBe(0);
  });

  it("handles an empty series", () => {
    expect(indexOfTime([], 0, T0)).toBe(-1);
  });
});

describe("anchorShift", () => {
  it("shifts by exactly the number of bars prepended", () => {
    const prev = times(800);
    const next = times(1200); // 400 older bars at the front
    expect(at(100, prev, next)).toBe(400);
  });

  it("keeps the same timestamp under the left edge", () => {
    const prev = times(800);
    const next = times(1200);
    const anchorT = prev[100] as number;
    const shift = at(100, prev, next);
    expect(next[100 + shift]).toBe(anchorT);
  });

  it("does not move when bars are only appended", () => {
    // A live tick lands at the END; every earlier index is unchanged.
    const prev = times(800);
    const next = [...prev, T0 + HOUR];
    expect(at(300, prev, next)).toBe(0);
  });

  it("does nothing for a different instrument", () => {
    // A different key is a different question. Carrying a scroll position over
    // would open every symbol wherever the last one was left.
    expect(at(100, times(800), times(1200), { replaced: true })).toBe(0);
  });

  it("does nothing while following live", () => {
    // scrollToLive owns the offset there; shifting too would double-count.
    expect(at(100, times(800), times(1200), { followLive: true })).toBe(0);
  });

  it("holds the view when overscrolled past the newest bar", () => {
    // Offset beyond the end is a real state — the empty space traders draw
    // projections into. A prepend still has to hold it still.
    const prev = times(800);
    const next = times(1200);
    expect(at(795, prev, next)).toBe(400);
  });

  it("holds the view when overscrolled before the first bar", () => {
    const prev = times(800);
    const next = times(1200);
    expect(at(-30, prev, next)).toBe(400);
  });

  it("leaves the view alone when the anchor bar no longer exists", () => {
    // Retention swept it, or the source changed. Guessing from a bar that is
    // gone is worse than standing still and letting the clamp settle it.
    const prev = times(800);
    const next = times(200); // only recent bars survive
    expect(at(0, prev, next)).toBe(0);
  });

  it("copes with an empty series on either side", () => {
    expect(at(100, [], times(800))).toBe(0);
    expect(at(100, times(800), [])).toBe(0);
  });
});

describe("needsOlderBars", () => {
  it("asks once the view is within the lead", () => {
    expect(needsOlderBars(0, 40)).toBe(true);
    expect(needsOlderBars(40, 40)).toBe(true);
  });

  it("stays quiet further in", () => {
    // Otherwise idly reading old bars pulls the whole archive.
    expect(needsOlderBars(41, 40)).toBe(false);
    expect(needsOlderBars(500, 40)).toBe(false);
  });
});
