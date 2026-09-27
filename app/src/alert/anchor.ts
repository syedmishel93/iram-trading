/**
 * Resolving an alert anchor against a live detection set.
 *
 * An anchor is a promise that some price can be computed for any bar. For a
 * static price that is trivial. For a structure it means: find the detection
 * this alert was attached to, read its geometry, and evaluate that geometry at
 * a bar index — including EXTRAPOLATING a trendline past its last touch, which
 * is the entire reason a trendline alert is worth having.
 *
 * THE LOOK-AHEAD RULE LIVES HERE
 * Every detection carries `to`: the bar at which it became knowable. An alert
 * anchored to it may only be evaluated on bars AFTER that. Evaluating at or
 * before `to` would test a structure against the very bars that revealed it —
 * the classic way a backtest invents an edge that never existed. `validFrom`
 * is that boundary, and the evaluator refuses to look behind it.
 */

import type { Detection, DetectInput, Shape } from "../detect/types";
import type { AlertAnchor, AnchorEdge } from "./types";

/** A price band at one bar. `lo === hi` for a line or level. */
export interface Band {
  lo: number;
  hi: number;
}

export interface ResolvedAnchor {
  /** The band at bar `i`, or null when the geometry does not reach that bar. */
  at(i: number): Band | null;
  /** First bar index this anchor may legitimately be evaluated on. */
  validFrom: number;
  /** True when the anchor is a band with real width, rather than a line. */
  isBand: boolean;
  /** What it is watching, for the reason string. */
  label: string;
}

/** The shape an alert can be anchored to, preferring geometry over decoration. */
function primaryShape(shapes: readonly Shape[]): Shape | null {
  for (const s of shapes) if (s.type === "line") return s;
  for (const s of shapes) if (s.type === "box") return s;
  for (const s of shapes) if (s.type === "level") return s;
  return null;
}

function pick(band: Band, edge: AnchorEdge): Band {
  switch (edge) {
    case "top":
      return { lo: band.hi, hi: band.hi };
    case "bottom":
      return { lo: band.lo, hi: band.lo };
    case "mid": {
      const m = (band.lo + band.hi) / 2;
      return { lo: m, hi: m };
    }
    case "band":
      return band;
  }
}

/** Geometry of one shape at bar `i`, before the edge is chosen. */
function shapeAt(shape: Shape, i: number): Band | null {
  switch (shape.type) {
    case "level":
      return i >= shape.x0 ? { lo: shape.y, hi: shape.y } : null;

    case "line": {
      if (i < shape.x0) return null;
      const span = shape.x1 - shape.x0;
      // A degenerate line has no slope to project; treat it as a level rather
      // than dividing by zero and producing Infinity for every future bar.
      if (span === 0) return { lo: shape.y0, hi: shape.y0 };
      // Extrapolation past x1 is deliberate and is the point: a trendline alert
      // that stopped at the last touch would only ever fire in the past.
      const y = shape.y0 + ((shape.y1 - shape.y0) * (i - shape.x0)) / span;
      return { lo: y, hi: y };
    }

    case "box": {
      if (i < shape.x0) return null;
      // A box that does not extend stops being a live zone past its right edge.
      if (!shape.extend && i > shape.x1) return null;
      const lo = Math.min(shape.y0, shape.y1);
      const hi = Math.max(shape.y0, shape.y1);
      return { lo, hi };
    }

    case "marker":
      return null;
  }
}

/**
 * Find the detection an anchor refers to.
 *
 * Matched on kind plus the START TIME of the structure, so the match survives
 * history being prepended, the array being re-sliced, or the detector being
 * re-run with a different lookback.
 */
export function findAnchorDetection(
  anchor: Extract<AlertAnchor, { kind: "detection" }>,
  data: DetectInput,
  detections: readonly Detection[],
): Detection | null {
  for (const d of detections) {
    if (d.kind !== anchor.detKind) continue;
    const t = data.t[d.from];
    if (t === undefined) continue;
    if (t === anchor.fromTime) return d;
  }
  return null;
}

/** The time an anchor should record for a detection. */
export function anchorTimeOf(data: DetectInput, det: Detection): number {
  return data.t[det.from] ?? 0;
}

export type ResolveResult =
  | { ok: true; anchor: ResolvedAnchor }
  | { ok: false; reason: string };

export function resolveAnchor(
  anchor: AlertAnchor,
  data: DetectInput,
  detections: readonly Detection[],
): ResolveResult {
  if (anchor.kind === "price") {
    const band: Band = { lo: anchor.price, hi: anchor.price };
    return {
      ok: true,
      anchor: {
        at: () => band,
        // A typed price is knowable from bar zero; nothing about it was learned
        // from the chart, so there is no hindsight to guard against.
        validFrom: 0,
        isBand: false,
        label: `price ${anchor.price}`,
      },
    };
  }

  const det = findAnchorDetection(anchor, data, detections);
  if (!det) {
    return {
      ok: false,
      reason: `${anchor.label} is no longer detected — invalidated, mitigated, or scrolled out of range`,
    };
  }

  const shape = primaryShape(det.shapes);
  if (!shape) {
    return { ok: false, reason: `${det.label} has no geometry an alert can watch` };
  }

  const raw = shapeAt(shape, det.to);
  const isBand = anchor.edge === "band" && raw !== null && raw.lo !== raw.hi;

  return {
    ok: true,
    anchor: {
      at: (i) => {
        const b = shapeAt(shape, i);
        return b === null ? null : pick(b, anchor.edge);
      },
      // The bar the structure completed on. Everything at or before it is
      // hindsight as far as this alert is concerned.
      validFrom: det.to + 1,
      isBand,
      label: det.label,
    },
  };
}
