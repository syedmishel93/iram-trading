import { describe, expect, it } from "vitest";
import { detectionToSeeds, shapeToSeed, timeMapper } from "../src/draw/fromdetection";
import type { Detection, Shape } from "../src/detect/types";

/** Ten hourly bars starting at a round time. */
const H = 3_600_000;
const T0 = 1_700_000_000_000;
const times = Float64Array.from({ length: 10 }, (_, i) => T0 + i * H);
const at = timeMapper(times);

describe("timeMapper", () => {
  it("maps whole indices to their bar times", () => {
    expect(at(0)).toBe(T0);
    expect(at(9)).toBe(T0 + 9 * H);
  });

  it("interpolates a fractional index", () => {
    expect(at(2.5)).toBe(T0 + 2.5 * H);
  });

  it("EXTRAPOLATES past the live edge rather than clamping", () => {
    /* A zone extended to the right edge has an x1 beyond the last bar.
       Clamping would collapse it onto the final candle — a rectangle with no
       width, drawn on top of price, which reads as a bug rather than as a
       zone. */
    expect(at(12)).toBe(T0 + 12 * H);
    expect(at(-2)).toBe(T0 - 2 * H);
  });

  it("uses mean spacing, so one short final bar does not set the scale", () => {
    const ragged = Float64Array.from([0, H, 2 * H, 2 * H + 60_000]);
    const m = timeMapper(ragged);
    /* Mean span is (2h1m)/3 ≈ 40.3 min, not the 1-minute final gap. */
    expect(m(4) - m(3)).toBeGreaterThan(30 * 60_000);
  });

  it("survives an empty and a single-bar series", () => {
    expect(timeMapper(new Float64Array(0))(5)).toBe(0);
    expect(timeMapper(Float64Array.from([T0]))(5)).toBe(T0);
  });
});

describe("shapeToSeed", () => {
  it("turns a level into a horizontal line at that price", () => {
    const s: Shape = { type: "level", x0: 3, y: 100.5, tone: "accent", label: "flip" };
    const seed = shapeToSeed(s, at);
    expect(seed).toEqual({
      kind: "hline",
      anchors: [{ t: T0 + 3 * H, p: 100.5 }],
      tone: "accent",
      text: "flip",
    });
  });

  it("turns a box into a rectangle across both corners", () => {
    const s: Shape = { type: "box", x0: 1, x1: 4, y0: 90, y1: 95, tone: "bull" };
    const seed = shapeToSeed(s, at);
    expect(seed?.kind).toBe("rect");
    expect(seed?.anchors).toEqual([
      { t: T0 + H, p: 90 },
      { t: T0 + 4 * H, p: 95 },
    ]);
  });

  it("carries an extended box's extension through", () => {
    const s: Shape = { type: "box", x0: 1, x1: 12, y0: 90, y1: 95, tone: "bull", extend: true };
    expect(shapeToSeed(s, at)?.extendRight).toBe(true);
  });

  it("makes an extending line a RAY and a bounded one a trend line", () => {
    const base = { type: "line" as const, x0: 1, y0: 90, x1: 5, y1: 95, tone: "bear" as const };
    expect(shapeToSeed(base, at)?.kind).toBe("trendline");
    expect(shapeToSeed({ ...base, extend: true }, at)?.kind).toBe("ray");
  });

  it("turns a marker into a note carrying its text", () => {
    const s: Shape = { type: "marker", x: 2, y: 88, tone: "bull", text: "BOS", above: false };
    const seed = shapeToSeed(s, at);
    expect(seed?.kind).toBe("text");
    expect(seed?.text).toBe("BOS");
  });

  it("omits text entirely when the shape has no label", () => {
    /* Not an empty string: `exactOptionalPropertyTypes` aside, a drawing with
       `text: ""` renders an empty label box on the chart. */
    const seed = shapeToSeed({ type: "level", x0: 1, y: 10, tone: "neutral" }, at);
    expect(seed && "text" in seed).toBe(false);
  });
});

describe("detectionToSeeds", () => {
  const det = (shapes: Shape[]): Detection => ({
    id: "d1",
    kind: "bos",
    label: "Break of structure",
    direction: "long",
    from: 1,
    to: 5,
    confidence: 0.7,
    reason: "closed through the last swing high",
    shapes,
  });

  it("drops the marker when the detection has real geometry too", () => {
    /* A BOS draws a line AND a "BOS" glyph. Pinning both leaves a text note
       floating beside a line that already says the same thing. */
    const seeds = detectionToSeeds(
      det([
        { type: "line", x0: 1, y0: 90, x1: 5, y1: 90, tone: "bull", label: "BOS" },
        { type: "marker", x: 5, y: 90, tone: "bull", text: "BOS", above: true },
      ]),
      at,
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.kind).toBe("trendline");
  });

  it("KEEPS markers when they are all there is", () => {
    /* Dropping them would turn a pin into silently doing nothing. */
    const seeds = detectionToSeeds(
      det([{ type: "marker", x: 5, y: 90, tone: "bull", text: "BOS", above: true }]),
      at,
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.kind).toBe("text");
  });

  it("converts every geometric shape in a multi-part detection", () => {
    const seeds = detectionToSeeds(
      det([
        { type: "box", x0: 1, x1: 3, y0: 90, y1: 92, tone: "bull" },
        { type: "level", x0: 3, y: 92, tone: "accent" },
      ]),
      at,
    );
    expect(seeds.map((s) => s.kind)).toEqual(["rect", "hline"]);
  });

  it("returns nothing for a detection with no shapes, rather than throwing", () => {
    expect(detectionToSeeds(det([]), at)).toEqual([]);
  });
});
