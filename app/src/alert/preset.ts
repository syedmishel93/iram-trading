/**
 * One-click alerts from a detected structure.
 *
 * The two-click version — open a form, re-find the structure in a dropdown,
 * pick a condition — is the version nobody uses during a fast move. So every
 * structure the detectors can anchor to has a DEFAULT condition, chosen to be
 * the thing a trader actually watches that structure for:
 *
 *   a support trendline   -> tell me when a close breaks it
 *   an unmitigated zone   -> tell me when price comes back into it
 *   a broken level        -> tell me when price crosses it either way
 *
 * The preset is a starting point, never a lock-in: the form can build any
 * combination, and the preset is just the one that is right most of the time.
 */

import type { Detection } from "../detect/types";
import type { AlertAnchor, AlertCondition, AnchorEdge } from "./types";

/** Structures with geometry an alert can follow. */
export const ANCHORABLE_KINDS: ReadonlySet<string> = new Set([
  "trendline",
  "level",
  "fvg",
  "order-block",
  "bos",
  "choch",
]);

export function canAnchor(det: Detection): boolean {
  return ANCHORABLE_KINDS.has(det.kind) && det.shapes.some((s) => s.type !== "marker");
}

/** Zone-shaped structures are watched as a band; lines as a single price. */
export function isBandKind(kind: string): boolean {
  return kind === "fvg" || kind === "order-block";
}

export interface Preset {
  condition: AlertCondition;
  edge: AnchorEdge;
  /** What the alert will do, in one line, for the button's tooltip. */
  blurb: string;
}

export function presetFor(det: Detection): Preset {
  if (isBandKind(det.kind)) {
    return {
      condition: "enter",
      edge: "band",
      // An unmitigated zone is watched for the RETURN to it, not for a break:
      // the trade is taken when price comes back, which is the whole premise.
      blurb: "Fires when a close re-enters the zone",
    };
  }

  if (det.kind === "trendline") {
    // A rising (support) line matters when it BREAKS; a falling (resistance)
    // line matters when it is reclaimed. Alerting the other way round would be
    // technically valid and practically useless.
    const condition: AlertCondition = det.direction === "short" ? "cross-above" : "cross-below";
    return {
      condition,
      edge: "mid",
      blurb:
        condition === "cross-below"
          ? "Fires when a close breaks the line"
          : "Fires when a close reclaims the line",
    };
  }

  return {
    condition: "cross-any",
    edge: "mid",
    blurb: "Fires when a close crosses the level either way",
  };
}

/**
 * The higher timeframe a detection came from, if any.
 *
 * Projected detections are given ids prefixed with their timeframe (`4h:...`);
 * native ones contain no colon. Recording it on the spec is what lets a
 * headless run reproduce the same structure — without it the daemon looks for a
 * 4h order block among 1h detections and reports the alert as orphaned.
 */
export function anchorTimeframe(det: Detection): string | null {
  const colon = det.id.indexOf(":");
  return colon > 0 ? det.id.slice(0, colon) : null;
}

export function anchorFor(det: Detection, fromTime: number): AlertAnchor {
  const p = presetFor(det);
  return {
    kind: "detection",
    detKind: det.kind,
    fromTime,
    label: det.label,
    edge: p.edge,
  };
}
