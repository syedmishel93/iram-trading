/**
 * The AI read of the chart: five numbered steps, each one line, each built
 * from something the terminal already MEASURED — never a sentence that could
 * have been written without looking at the chart (v59.2, the v5 design).
 *
 *   1 Trend      EMA 20 / 50 / 200 stacking, from the closes
 *   2 Structure  the latest break of structure or change of character
 *   3 Pullback   the nearest UNUSED gap or order block on the pullback side,
 *                taken from `keyLevels` so this card and "Key levels" cannot
 *                disagree about where it is
 *   4 Momentum   a divergence in the last 40 bars against the trend, else RSI
 *   5 Marked     what the detectors put on the chart, counted by kind
 *
 * REFUSALS. Each step says what it could not check rather than guessing: too
 * few bars for an average is named with the count it needs; no trend means
 * no pullback side, and the step says so instead of picking one.
 *
 * Tone follows STANDING — whether the step supports the trend read — never
 * the size of a number.
 */

import type { Detection } from "../detect/types";
import type { KeyLevelsResult } from "./keylevels";

export type ReadTone = "pos" | "attn" | "mute";

export interface ReadStep {
  readonly key: "trend" | "structure" | "pullback" | "momentum" | "marked";
  readonly title: string;
  readonly text: string;
  readonly tone: ReadTone;
}

export interface ChartReadInput {
  /** Closes, oldest first — the bars the detections were run on. */
  readonly closes: readonly number[];
  readonly detections: readonly Detection[];
  readonly levels: KeyLevelsResult;
  /** RSI(14) now, or null / NaN when there are too few bars. */
  readonly rsi: number | null;
  readonly fmtPx: (v: number) => string;
}

/** A divergence older than this many bars is not "now". */
export const DIVERGENCE_WINDOW = 40;

/** Exponential moving average of the whole series; null when too short. */
export function emaLast(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += closes[i] as number;
  e /= period;
  for (let i = period; i < closes.length; i++) e = (closes[i] as number) * k + e * (1 - k);
  return e;
}

export type TrendRead = { readonly dir: "up" | "down" | "mixed"; readonly text: string; readonly tone: ReadTone } | { readonly dir: "unknown"; readonly text: string; readonly tone: ReadTone };

export function trendRead(closes: readonly number[]): TrendRead {
  const e20 = emaLast(closes, 20);
  const e50 = emaLast(closes, 50);
  if (e20 === null || e50 === null) {
    return { dir: "unknown", text: `can't tell yet — the 50-bar average needs 50 bars and there are ${closes.length}.`, tone: "mute" };
  }
  const e200 = emaLast(closes, 200);
  if (e200 === null) {
    const dir = e20 > e50 ? "up" : e20 < e50 ? "down" : "mixed";
    return {
      dir,
      text: `${dir === "up" ? "up — the 20 average is over the 50" : dir === "down" ? "down — the 20 average is under the 50" : "flat — the 20 and 50 averages are level"} (the 200 needs 200 bars; there are ${closes.length}).`,
      tone: dir === "mixed" ? "attn" : "pos",
    };
  }
  if (e20 > e50 && e50 > e200) return { dir: "up", text: "up — EMA 20 over 50 over 200.", tone: "pos" };
  if (e20 < e50 && e50 < e200) return { dir: "down", text: "down — EMA 20 under 50 under 200.", tone: "pos" };
  return { dir: "mixed", text: "mixed — the 20, 50 and 200 averages are not stacked.", tone: "attn" };
}

/** The price a detection is drawn at: its first level or line. */
function levelOf(d: Detection): number | null {
  for (const s of d.shapes) {
    if (s.type === "level") return s.y;
    if (s.type === "line") return s.y1;
  }
  return null;
}

const PATTERNS = new Set(["double-top", "double-bottom", "head-shoulders", "wedge", "triangle", "channel", "flag"]);
const LEVELISH = new Set(["level", "equal-highs", "equal-lows", "poc", "value-area", "lvn"]);

export function chartRead(input: ChartReadInput): ReadStep[] {
  const { closes, detections, levels, rsi, fmtPx } = input;
  const last = closes.length - 1;
  const steps: ReadStep[] = [];

  // 1 — trend
  const trend = trendRead(closes);
  steps.push({ key: "trend", title: "Trend", text: trend.text, tone: trend.tone });

  // 2 — structure: the most recent BOS / CHoCH by the bar it completed on
  let bos: Detection | null = null;
  for (const d of detections) if ((d.kind === "bos" || d.kind === "choch") && (bos === null || d.to > bos.to)) bos = d;
  if (bos === null) {
    steps.push({ key: "structure", title: "Structure", text: "no break of structure in view.", tone: "mute" });
  } else {
    const at = levelOf(bos);
    const ago = Math.max(0, last - bos.to);
    const verb = bos.direction === "long" ? "broke above" : bos.direction === "short" ? "broke below" : "broke";
    const what = bos.kind === "choch" ? "change of character" : "break of structure";
    const agrees = (bos.direction === "long" && trend.dir === "up") || (bos.direction === "short" && trend.dir === "down");
    steps.push({
      key: "structure",
      title: "Structure",
      text: `${what}: price ${verb}${at === null ? "" : ` ${fmtPx(at)}`} ${ago === 0 ? "on the last bar" : `${ago} bar${ago === 1 ? "" : "s"} ago`}.`,
      tone: agrees ? "pos" : "attn",
    });
  }

  // 3 — pullback area, on the side a pullback would travel
  if (trend.dir !== "up" && trend.dir !== "down") {
    steps.push({ key: "pullback", title: "Pullback area", text: "no clear trend, so no pullback side to look on.", tone: "mute" });
  } else if (levels.state !== "ok") {
    steps.push({ key: "pullback", title: "Pullback area", text: levels.reason, tone: "mute" });
  } else {
    const side = trend.dir === "up" ? levels.below : levels.above;
    const zone = side.find((l) => l.used !== "used" && l.kinds.some((k) => /gap|order block|breaker/.test(k)));
    steps.push(
      zone
        ? {
            key: "pullback",
            title: "Pullback area",
            text: `${zone.kinds[0] ?? "a zone"} at ${fmtPx(zone.low)}–${fmtPx(zone.high)}, ${zone.distancePct.toFixed(1)}% away — the first place ${trend.dir === "up" ? "buyers" : "sellers"} may return.`,
            tone: "pos",
          }
        : {
            key: "pullback",
            title: "Pullback area",
            text: `no unused gap or order block ${trend.dir === "up" ? "below" : "above"} — no clean pullback area.`,
            tone: "attn",
          },
    );
  }

  // 4 — momentum
  let div: Detection | null = null;
  for (const d of detections) if (d.kind === "divergence" && last - d.to <= DIVERGENCE_WINDOW && (div === null || d.to > div.to)) div = d;
  const against =
    div !== null && ((trend.dir === "up" && div.direction === "short") || (trend.dir === "down" && div.direction === "long"));
  if (div !== null) {
    steps.push({
      key: "momentum",
      title: "Momentum",
      text: against
        ? `a divergence ${last - div.to} bars ago runs against the trend — the push is tiring.`
        : `a divergence ${last - div.to} bars ago points ${div.direction === "long" ? "up" : div.direction === "short" ? "down" : "nowhere clear"}.`,
      tone: against ? "attn" : "pos",
    });
  } else if (rsi === null || !Number.isFinite(rsi)) {
    steps.push({ key: "momentum", title: "Momentum", text: "RSI needs 15 bars; no divergence in view.", tone: "mute" });
  } else {
    const r = Math.round(rsi);
    const stretched = rsi >= 70 || rsi <= 30;
    steps.push({
      key: "momentum",
      title: "Momentum",
      text: stretched
        ? `RSI ${r} — ${rsi >= 70 ? "stretched up" : "washed out"}; no divergence yet.`
        : `RSI ${r}, no divergence in the last ${DIVERGENCE_WINDOW} bars — nothing tiring.`,
      tone: stretched ? "attn" : "pos",
    });
  }

  // 5 — what is marked
  let lv = 0;
  let pat = 0;
  let gaps = 0;
  for (const d of detections) {
    if (LEVELISH.has(d.kind)) lv++;
    else if (PATTERNS.has(d.kind)) pat++;
    else if (d.kind === "fvg") gaps++;
  }
  steps.push({
    key: "marked",
    title: "Marked",
    text:
      detections.length === 0
        ? "the detectors found nothing on this chart."
        : `${lv} level${lv === 1 ? "" : "s"}, ${pat} pattern${pat === 1 ? "" : "s"} and ${gaps} gap${gaps === 1 ? "" : "s"} among ${detections.length} marks.`,
    tone: "mute",
  });
  return steps;
}
