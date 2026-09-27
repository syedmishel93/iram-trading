/**
 * INTRABAR RESOLUTION — which came first, the stop or the target.
 *
 * `engine.ts` rule 2 says it plainly: "When a bar contains both your stop and
 * your target, assume the STOP. A daily bar that traded through both tells you
 * nothing about the order." That assumption is correct and it is PESSIMISTIC —
 * it turns some winners into losers, so it understates edge rather than
 * inventing it, which is the right way round to be wrong.
 *
 * It is still an assumption, and it is the largest single source of error left
 * in the engine. With minute bars inside the parent bar, the order is not a
 * guess any more.
 *
 * WHAT THESE TESTS PIN, and why each one is a way of being wrong:
 *
 *  1. The order is read from the minutes, both directions.
 *  2. A minute that contains BOTH is still ambiguous. A minute is a bar; the
 *     same argument applies one level down, so it falls back and SAYS SO.
 *  3. The result always states whether it was MEASURED or ASSUMED. A resolved
 *     exit and a guessed one must never be indistinguishable downstream —
 *     this file's rule that any computed figure says whether it is measured or
 *     modelled is the whole reason the flag exists.
 *  4. MINUTES THAT DO NOT COVER THE PARENT BAR CANNOT SETTLE IT. If the first
 *     touch happened in a minute nobody has, walking the minutes you do have
 *     finds the SECOND touch and reports it with total confidence. Partial
 *     coverage is not coverage — the same defect as a study whose dead vendors
 *     vanished from its reported window.
 */

import { describe, expect, it } from "vitest";
import { settleBar } from "../src/backtest/intrabar";
import type { BarView } from "../src/chart/series";

const MIN = 60_000;

/** A minute bar. `t` is its open time. */
const m = (i: number, l: number, h: number): BarView => ({
  t: i * MIN,
  o: (l + h) / 2,
  h,
  l,
  c: (l + h) / 2,
  v: 1,
});

/**
 * The parent bar's span. THREE minutes, matched to the three-minute fixtures
 * below — the first draft of this file used a ten-minute span with three
 * minutes of data and four tests failed on the coverage guard, which is the
 * guard working: three minutes cannot settle a ten-minute bar, and claiming
 * they can is the exact failure the guard exists to stop.
 */
const SPAN = { from: 0, to: 3 * MIN };

describe("settleBar — reading the order off the minutes", () => {
  it("reports the stop when the stop is touched first, long", () => {
    const minutes = [m(0, 99, 101), m(1, 94, 100), m(2, 99, 106)];
    const r = settleBar(minutes, SPAN, { stop: 95, target: 105, direction: "long" });
    expect(r.hit).toBe("stop");
    expect(r.basis).toBe("measured");
  });

  it("reports the target when the target is touched first, long", () => {
    const minutes = [m(0, 99, 101), m(1, 99, 106), m(2, 94, 100)];
    const r = settleBar(minutes, SPAN, { stop: 95, target: 105, direction: "long" });
    expect(r.hit).toBe("target");
    expect(r.basis).toBe("measured");
  });

  it("reverses both comparisons for a short", () => {
    /* Short: the stop is ABOVE and the target BELOW. The same minutes that
       stopped a long out must take a short to its target. */
    const minutes = [m(0, 99, 101), m(1, 94, 100), m(2, 99, 106)];
    const r = settleBar(minutes, SPAN, { stop: 105, target: 95, direction: "short" });
    expect(r.hit).toBe("target");
    expect(r.basis).toBe("measured");
  });

  it("reports neither when the minutes touch neither level", () => {
    const minutes = [m(0, 99, 101), m(1, 98, 102), m(2, 99, 101)];
    const r = settleBar(minutes, SPAN, { stop: 95, target: 105, direction: "long" });
    expect(r.hit).toBe("neither");
    expect(r.basis).toBe("measured");
  });
});

describe("settleBar — when it refuses to claim it measured anything", () => {
  it("falls back to the stop when ONE MINUTE holds both, and says it assumed", () => {
    /* A minute is a bar. The argument that a daily bar through both tells you
       nothing applies unchanged one level down, so the pessimistic rule stands
       and the basis records that it did. */
    const minutes = [m(0, 99, 101), m(1, 94, 106)];
    const r = settleBar(minutes, { from: 0, to: 2 * MIN }, { stop: 95, target: 105, direction: "long" });
    expect(r.hit).toBe("stop");
    expect(r.basis).toBe("assumed");
  });

  it("assumes the stop when there are no minutes at all", () => {
    const r = settleBar([], SPAN, { stop: 95, target: 105, direction: "long" });
    expect(r.hit).toBe("stop");
    expect(r.basis).toBe("assumed");
    expect(r.minutes).toBe(0);
  });

  it("REFUSES to call it measured when the minutes do not cover the bar", () => {
    /* The stop is touched in minute 1, which is missing. Walking what is left
       finds the TARGET in minute 7 and would report a winner — the exact
       opposite of the truth, stated with total confidence. */
    const minutes = [m(0, 99, 101), m(7, 99, 106), m(8, 99, 101), m(9, 99, 101)];
    const r = settleBar(minutes, { from: 0, to: 10 * MIN }, { stop: 95, target: 105, direction: "long" });
    expect(r.basis).toBe("assumed");
    expect(r.hit).toBe("stop");
  });

  it("accepts coverage with a gap smaller than one minute", () => {
    /* Ten contiguous minutes with the last one ending exactly at `to`. Nothing
       is missing, so this must not be refused by an off-by-one. */
    const minutes = Array.from({ length: 10 }, (_, i) => m(i, 99, 101));
    const r = settleBar(minutes, { from: 0, to: 10 * MIN }, { stop: 95, target: 105, direction: "long" });
    expect(r.basis).toBe("measured");
    expect(r.hit).toBe("neither");
  });

  it("counts the minutes it actually used, so a caller can audit the claim", () => {
    const minutes = Array.from({ length: 10 }, (_, i) => m(i, 99, 101));
    expect(settleBar(minutes, { from: 0, to: 10 * MIN }, { stop: 95, target: 105, direction: "long" }).minutes).toBe(10);
  });
});

describe("settleBar — the levels themselves", () => {
  it("treats touching the level exactly as a hit, both sides", () => {
    /* A stop at 95 with a low of exactly 95 IS filled. Requiring a strict
       break understates stops and overstates the system. */
    const exact = [m(0, 95, 101)];
    expect(settleBar(exact, { from: 0, to: MIN }, { stop: 95, target: 105, direction: "long" }).hit).toBe("stop");
    const exactT = [m(0, 99, 105)];
    expect(settleBar(exactT, { from: 0, to: MIN }, { stop: 95, target: 105, direction: "long" }).hit).toBe("target");
  });

  it("refuses a stop on the wrong side of the target rather than guessing", () => {
    /* A long whose stop is above its target is not a trade, it is a bug in the
       caller. Answering it at all would hide that. */
    const minutes = [m(0, 90, 110)];
    const r = settleBar(minutes, { from: 0, to: MIN }, { stop: 105, target: 95, direction: "long" });
    expect(r.hit).toBe("neither");
    expect(r.basis).toBe("assumed");
    expect(r.why).toMatch(/stop/i);
  });
});
