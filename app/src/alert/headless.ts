/**
 * The alert engine, without a browser.
 *
 * ONE SOURCE OF TRUTH, NOT TWO
 * The obvious way to get browser-closed alerts is to re-implement the rules in
 * Python next to the data server. That gives two engines, and the day they
 * disagree you find out on a live trade and cannot tell which one lied. The
 * v35 signal worker rejected exactly that trade-off for the same reason, and
 * this follows it: the daemon runs THIS code, compiled from the same TypeScript
 * the terminal ships, so a change to a detector or to the hysteresis rule
 * changes both at once or neither.
 *
 * NOTHING DOM, NOTHING TIMED, NOTHING STORED
 * This module is a pure function of (bars, alert book) → fires. No fetch, no
 * localStorage, no clock. The daemon supplies the bars and owns the schedule;
 * the browser supplies them from its feed. Both get identical answers because
 * neither is allowed to bring anything of its own.
 */

import { runDetectors, toDetectInput, DETECTOR_FOR_KIND, type DetectorId } from "../detect";
import type { Detection } from "../detect/types";
import { detectHigher, tfMs } from "../detect/mtf";
import { resolveAnchor } from "./anchor";
import { evaluateAlert } from "./engine";
import type { AlertFire, AlertSpec } from "./types";

export interface HeadlessBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface HeadlessResult {
  fires: AlertFire[];
  /** Alerts whose anchor could not be found, with the reason. Never silent. */
  orphaned: { id: string; reason: string }[];
  /** How many closed bars were judged. */
  closedBars: number;
  /** Detectors that had to run to evaluate this book. */
  detectors: DetectorId[];
}

/**
 * Which detectors this book needs, including for higher-timeframe anchors.
 *
 * A `4h:` prefix on the anchor's detection id means the structure was found on
 * an aggregated series; the underlying detector is the same one either way.
 */
function neededFor(specs: readonly AlertSpec[]): { detectors: DetectorId[]; higher: string[] } {
  const detectors = new Set<DetectorId>();
  const higher = new Set<string>();
  for (const s of specs) {
    if (!s.enabled) continue;
    if (s.anchor.kind !== "detection") continue;
    detectors.add(DETECTOR_FOR_KIND[s.anchor.detKind]);
    // Higher-timeframe anchors are recorded with the timeframe in the label the
    // desk generated; the timeframe itself is carried on the spec.
    if (s.timeframeAnchor) higher.add(s.timeframeAnchor);
  }
  return { detectors: [...detectors], higher: [...higher] };
}

/**
 * Evaluate a book of alerts against a series.
 *
 * `bars` must be ascending and must include the forming bar if there is one —
 * it is excluded here, in exactly the way the terminal excludes it, so the
 * daemon cannot accidentally judge a bar that has not closed.
 */
export function evaluateBook(
  bars: readonly HeadlessBar[],
  specs: readonly AlertSpec[],
  opts: { includesFormingBar?: boolean } = {},
): HeadlessResult {
  const closedBars = Math.max(0, bars.length - (opts.includesFormingBar === false ? 0 : 1));
  const empty: HeadlessResult = { fires: [], orphaned: [], closedBars, detectors: [] };
  if (closedBars < 30 || specs.length === 0) return empty;

  const { detectors, higher } = neededFor(specs);
  const data = toDetectInput(bars.slice(0, closedBars));

  const detections: Detection[] = detectors.length > 0 ? runDetectors(data, detectors) : [];
  for (const tf of higher) {
    if (tfMs(tf) > 0) detections.push(...detectHigher(data, tf, detectors));
  }

  const fires: AlertFire[] = [];
  const orphaned: HeadlessResult["orphaned"] = [];

  for (const spec of specs) {
    if (!spec.enabled) continue;
    const res = resolveAnchor(spec.anchor, data, detections);
    if (!res.ok) {
      orphaned.push({ id: spec.id, reason: res.reason });
      continue;
    }
    fires.push(...evaluateAlert(spec, data, res.anchor, { closedCount: closedBars }));
  }

  return { fires, orphaned, closedBars, detectors };
}

/**
 * The fires that are new relative to what has already been reported.
 *
 * De-duplication is by (alert, bar time) exactly as in the browser store, so
 * re-walking the whole history every poll — which is required, because
 * hysteresis is path-dependent — produces one notification per event rather
 * than one per poll.
 */
export function freshFires(
  fires: readonly AlertFire[],
  seen: Record<string, number[]>,
): { fresh: AlertFire[]; seen: Record<string, number[]> } {
  const next: Record<string, number[]> = { ...seen };
  const fresh: AlertFire[] = [];
  for (const f of fires) {
    const bucket = next[f.alertId] ?? [];
    if (bucket.includes(f.time)) continue;
    // Bounded: an alert with no `once` on a long series would otherwise grow
    // this list forever in a process that never restarts.
    next[f.alertId] = [...bucket, f.time].slice(-500);
    fresh.push(f);
  }
  return { fresh, seen: next };
}

/**
 * Everything the daemon needs, in one JSON document.
 *
 * Exported by the terminal and read by the daemon, so the book does not have to
 * be maintained in two places. Version-stamped because a daemon reading a newer
 * format must refuse rather than guess.
 */
export interface AlertBookFile {
  version: 40;
  exportedAt: number;
  alerts: AlertSpec[];
}

export function makeBookFile(alerts: readonly AlertSpec[], now: number): AlertBookFile {
  return { version: 40, exportedAt: now, alerts: [...alerts] };
}

export function readBookFile(raw: unknown): { ok: true; alerts: AlertSpec[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
  const doc = raw as Partial<AlertBookFile>;
  if (doc.version !== 40) {
    return { ok: false, error: `alert book version ${String(doc.version)} — this build reads version 40` };
  }
  if (!Array.isArray(doc.alerts)) return { ok: false, error: "no alerts array" };
  const alerts = doc.alerts.filter(
    (a): a is AlertSpec =>
      !!a && typeof a === "object" && typeof a.id === "string" && !!a.anchor && !!a.condition,
  );
  return { ok: true, alerts };
}
