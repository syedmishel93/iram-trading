/**
 * Time-axis label placement, in the chart renderer.
 *
 * Its own file, matching `heikin`, `logscale` and `utchour`: one chart concern
 * per file, each testing the pure rule the renderer calls rather than the canvas
 * it paints on.
 */

import { describe, expect, it } from "vitest";
import { axisLabelFits, axisTimeLabel, clampTagCenter } from "../src/chart/engine";

/**
 * A tick label is drawn whole or not at all.
 *
 * Both rules existed only as inline arithmetic and both were absent from shipped
 * builds, producing the same symptom: a fragment of text on the axis — a bare
 * "PM", or "ug 31, 03:00 PM" where "Aug 31, 03:00 PM" was meant. Half a label
 * looks like a broken renderer, and half a DATE looks like a value.
 */
describe("axisLabelFits — a tick label is drawn whole or not at all", () => {
  const LEFT = 100;
  const RIGHT = 500;

  it("draws a label that clears both edges", () => {
    expect(axisLabelFits(300, 40, LEFT, RIGHT)).toBe(true);
  });

  it("skips one that would hang off the left", () => {
    // Centre 110, half-width 20 => starts at 90, which is outside.
    expect(axisLabelFits(110, 40, LEFT, RIGHT)).toBe(false);
  });

  it("skips one that would run into the price gutter", () => {
    expect(axisLabelFits(490, 40, LEFT, RIGHT)).toBe(false);
  });

  it("accepts a label that exactly touches an edge", () => {
    expect(axisLabelFits(120, 40, LEFT, RIGHT)).toBe(true);
    expect(axisLabelFits(480, 40, LEFT, RIGHT)).toBe(true);
  });

  it("keeps a gap from the previous label", () => {
    // Previous ended at 200. A label starting at 203 is inside the 6px gap.
    expect(axisLabelFits(223, 40, LEFT, RIGHT, 200)).toBe(false);
    // Starting at 210 clears it.
    expect(axisLabelFits(230, 40, LEFT, RIGHT, 200)).toBe(true);
  });

  it("has no previous label to clear on the first tick", () => {
    expect(axisLabelFits(130, 40, LEFT, RIGHT, -Infinity)).toBe(true);
  });

  it("never draws a label wider than the plot", () => {
    expect(axisLabelFits(300, 500, LEFT, RIGHT)).toBe(false);
  });

  /** The property that matters: nothing drawn ever leaves the plot. */
  it("admits no placement that crosses a boundary, over many widths", () => {
    for (let cx = 80; cx <= 520; cx += 3) {
      for (const w of [12, 40, 64, 90]) {
        if (axisLabelFits(cx, w, LEFT, RIGHT)) {
          expect(cx - w / 2).toBeGreaterThanOrEqual(LEFT);
          expect(cx + w / 2).toBeLessThanOrEqual(RIGHT);
        }
      }
    }
  });
});

describe("clampTagCenter — the crosshair readout is moved, not dropped", () => {
  const LEFT = 100;
  const RIGHT = 500;

  it("leaves a tag that already fits exactly where the cursor is", () => {
    expect(clampTagCenter(300, 80, LEFT, RIGHT)).toBe(300);
  });

  it("pushes a tag off the left edge back into the plot", () => {
    // This is the "ug 31, 03:00 PM" bug: cursor at 105, tag 80 wide.
    expect(clampTagCenter(105, 80, LEFT, RIGHT)).toBe(140);
  });

  it("pushes a tag off the right edge back into the plot", () => {
    expect(clampTagCenter(495, 80, LEFT, RIGHT)).toBe(460);
  });

  it("centres a tag too wide to fit, so it clips evenly", () => {
    // Dropping one whole end would hide either the date or the time.
    expect(clampTagCenter(120, 600, LEFT, RIGHT)).toBe(300);
    expect(clampTagCenter(480, 600, LEFT, RIGHT)).toBe(300);
  });

  it("always keeps the tag inside the plot when it can", () => {
    for (let cx = -200; cx <= 800; cx += 7) {
      for (const w of [20, 80, 160, 399]) {
        const c = clampTagCenter(cx, w, LEFT, RIGHT);
        expect(c - w / 2).toBeGreaterThanOrEqual(LEFT - 1e-9);
        expect(c + w / 2).toBeLessThanOrEqual(RIGHT + 1e-9);
      }
    }
  });

  it("moves the tag as little as possible", () => {
    // A cursor well inside must not be nudged at all.
    for (const cx of [200, 250, 300, 350, 400]) {
      expect(clampTagCenter(cx, 60, LEFT, RIGHT)).toBe(cx);
    }
  });
});

/**
 * What a tick label says.
 *
 * MEASURED: at 800 hourly bars on a full-width chart the tick stride is 48 bars
 * — two days — and every label was a bare clock time. The axis read
 * "07:00 AM, 02:00 AM, 09:00 PM, 04:00 PM" with nothing saying each step had
 * crossed two midnights, so it appeared to run backwards.
 */
describe("axisTimeLabel — a label says which day when the day changes", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  /** Local noon, so a date change is never an artefact of the test's timezone. */
  const noon = (y: number, m: number, d: number, h = 12): number =>
    new Date(y, m - 1, d, h, 0, 0, 0).getTime();

  it("gives the first label a date — there is nothing before it to anchor to", () => {
    const out = axisTimeLabel(noon(2026, 9, 8), null, HOUR);
    expect(out).toMatch(/\d/);
    expect(out).not.toMatch(/:/);
  });

  it("gives a time when the tick is the same day as the last one drawn", () => {
    const a = noon(2026, 9, 8, 9);
    const b = noon(2026, 9, 8, 15);
    expect(axisTimeLabel(b, a, HOUR)).toMatch(/:/);
  });

  it("gives a date when the tick crosses into a new day", () => {
    const a = noon(2026, 9, 8, 22);
    const b = noon(2026, 9, 9, 4);
    expect(axisTimeLabel(b, a, HOUR)).not.toMatch(/:/);
  });

  it("labels EVERY tick with a date at a two-day stride — the measured case", () => {
    // This is the exact configuration that produced the unreadable axis.
    let prev: number | null = null;
    const labels: string[] = [];
    for (let k = 0; k < 6; k++) {
      const t = noon(2026, 9, 1) + k * 2 * DAY;
      labels.push(axisTimeLabel(t, prev, HOUR));
      prev = t;
    }
    // Not one of them is a bare clock time.
    for (const l of labels) expect(l).not.toMatch(/:/);
    // And they are all distinct, so the axis reads as advancing.
    expect(new Set(labels).size).toBe(labels.length);
  });

  /*
   * THE YEAR. The archive holds 1h bars back to 2022 and daily back to 2021,
   * so an intraday chart scrolled back a year read "Sep 24" — the same string
   * it shows for today, with nothing on screen able to tell them apart. The
   * day rule one level up: name the year when the label crosses into one.
   */
  it("names the year when a label crosses into a new one", () => {
    const dec = noon(2025, 12, 31, 22);
    const jan = noon(2026, 1, 1, 4);
    expect(axisTimeLabel(jan, dec, HOUR)).toMatch(/2026/);
  });

  it("gives the first label its year, having nothing before it to anchor to", () => {
    expect(axisTimeLabel(noon(2024, 9, 24), null, HOUR)).toMatch(/2024/);
  });

  it("does not repeat the year on every day inside one year", () => {
    const a = noon(2026, 9, 8, 22);
    const b = noon(2026, 9, 9, 4);
    const out = axisTimeLabel(b, a, HOUR);
    expect(out).not.toMatch(/:/);
    expect(out).not.toMatch(/2026/);
  });

  it("names the year on a daily stride too, when it changes", () => {
    const dec = noon(2025, 12, 30);
    const jan = noon(2026, 1, 2);
    expect(axisTimeLabel(jan, dec, DAY)).toMatch(/2026/);
    expect(axisTimeLabel(noon(2026, 1, 9), jan, DAY)).not.toMatch(/2026/);
  });

  it("mixes dates and times at a six-hour stride", () => {
    let prev: number | null = null;
    const labels: string[] = [];
    for (let k = 0; k < 8; k++) {
      const t = noon(2026, 9, 8, 0) + k * 6 * HOUR;
      labels.push(axisTimeLabel(t, prev, HOUR));
      prev = t;
    }
    const dates = labels.filter((l) => !l.includes(":"));
    const times = labels.filter((l) => l.includes(":"));
    // One date per day boundary crossed, times in between.
    expect(dates.length).toBe(2);
    expect(times.length).toBe(6);
  });

  it("always uses a date on a daily-or-longer series", () => {
    const a = noon(2026, 9, 8);
    const b = noon(2026, 9, 9);
    expect(axisTimeLabel(b, a, DAY)).not.toMatch(/:/);
    expect(axisTimeLabel(b, a, 7 * DAY)).not.toMatch(/:/);
  });

  it("treats a zero or unknown spacing as daily rather than intraday", () => {
    // `spacingMs` returns 0 for a series too short to measure. A bare clock time
    // on an unknown scale is the ambiguity this whole function removes.
    expect(axisTimeLabel(noon(2026, 9, 8), null, 0)).not.toMatch(/:/);
  });
});
