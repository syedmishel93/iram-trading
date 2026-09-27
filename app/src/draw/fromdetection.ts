/**
 * Turn a detected structure into drawings you own.
 *
 * WHY THIS EXISTS
 * Detections and drawings looked identical on the chart and behaved nothing
 * alike. A detection is recomputed from the bars on every load: it moves when
 * the window moves, vanishes when you switch the detector off, and cannot be
 * dragged, extended, retoned or kept. A drawing is yours — it persists, it
 * survives a timeframe change, it can be nudged two ticks when you disagree
 * with where the algorithm put it.
 *
 * So the honest relationship between them is not "the same thing twice", it is
 * PIN: the detector proposes a level, and this converts that proposal into an
 * ordinary drawing that then has nothing to do with the detector any more.
 * Switch the detector off afterwards and your line stays. That is the whole
 * point — and it is also why this is a copy and not a live link. A drawing that
 * silently moved because a recompute changed its mind would be the worst of
 * both.
 *
 * COORDINATES
 * Detections speak in BAR INDICES, because that is what the detectors compute
 * over. Drawings speak in wall-clock milliseconds, because that is the only
 * thing that survives a timeframe change. `timeAt` bridges the two, and every
 * conversion goes through it — including the extrapolation past the live edge,
 * which real detections need: a fair-value gap extended to the right edge has
 * an x1 beyond the last bar.
 */

import type { Detection, Shape } from "../detect/types";
import type { Anchor, DrawKind } from "./model";
import type { Tone } from "../detect/types";

/** A drawing waiting for an id and timestamps — everything else is decided. */
export interface DrawingSeed {
  readonly kind: DrawKind;
  readonly anchors: readonly Anchor[];
  readonly tone: Tone;
  readonly text?: string;
  readonly extendRight?: boolean;
}

/**
 * Bar index to wall-clock time.
 *
 * Extrapolates in BOTH directions rather than clamping. Clamping would collapse
 * an extended zone onto the last bar, which is not "roughly right" — it is a
 * rectangle with no width, drawn on top of the live candle.
 */
export function timeMapper(times: ArrayLike<number>): (index: number) => number {
  const n = times.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => Number(times[0]);

  const first = Number(times[0]);
  const last = Number(times[n - 1]);
  /* Mean spacing rather than the final gap: one short bar at the end of a
     session would otherwise set the scale for every extrapolated point. */
  const span = (last - first) / (n - 1);

  return (index: number): number => {
    if (index <= 0) return first + index * span;
    if (index >= n - 1) return last + (index - (n - 1)) * span;
    const lo = Math.floor(index);
    const hi = lo + 1;
    const frac = index - lo;
    const a = Number(times[lo]);
    const b = Number(times[hi]);
    return a + (b - a) * frac;
  };
}

/**
 * One shape to one drawing.
 *
 * Returns null for shapes with no drawable equivalent rather than inventing
 * one. A `marker` is a glyph the renderer positions relative to a bar; the
 * nearest drawing is a text note, and that IS offered — but a shape type this
 * file has not been taught is skipped, because a wrong drawing pinned to a
 * chart is worse than a missing one.
 */
export function shapeToSeed(shape: Shape, timeAt: (i: number) => number): DrawingSeed | null {
  switch (shape.type) {
    case "level":
      return {
        kind: "hline",
        anchors: [{ t: timeAt(shape.x0), p: shape.y }],
        tone: shape.tone,
        ...(shape.label === undefined ? {} : { text: shape.label }),
      };

    case "box":
      return {
        kind: "rect",
        anchors: [
          { t: timeAt(shape.x0), p: shape.y0 },
          { t: timeAt(shape.x1), p: shape.y1 },
        ],
        tone: shape.tone,
        ...(shape.label === undefined ? {} : { text: shape.label }),
        ...(shape.extend ? { extendRight: true } : {}),
      };

    case "line":
      return {
        kind: shape.extend ? "ray" : "trendline",
        anchors: [
          { t: timeAt(shape.x0), p: shape.y0 },
          { t: timeAt(shape.x1), p: shape.y1 },
        ],
        tone: shape.tone,
        ...(shape.label === undefined ? {} : { text: shape.label }),
      };

    case "marker":
      return {
        kind: "text",
        anchors: [{ t: timeAt(shape.x), p: shape.y }],
        tone: shape.tone,
        text: shape.text,
      };

    default:
      return null;
  }
}

/**
 * Everything drawable in one detection.
 *
 * Markers are dropped when the detection has real geometry alongside them: a
 * break of structure produces a line AND a "BOS" marker, and pinning both
 * leaves a text note floating next to the line that already says so. When a
 * detection is markers ONLY, they are kept — dropping them would silently
 * convert a pin into nothing.
 */
export function detectionToSeeds(
  detection: Detection,
  timeAt: (i: number) => number,
): DrawingSeed[] {
  const geometry = detection.shapes.filter((s) => s.type !== "marker");
  const source = geometry.length > 0 ? geometry : detection.shapes;
  const seeds: DrawingSeed[] = [];
  for (const shape of source) {
    const seed = shapeToSeed(shape, timeAt);
    if (seed) seeds.push(seed);
  }
  return seeds;
}
