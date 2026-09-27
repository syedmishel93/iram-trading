/**
 * Number, label and icon formatting for the shell's own chrome.
 *
 * Lifted out of `shell.ts` unchanged. `mountShell` was a single 7,476-line
 * function and the file around it had become the place anything shell-shaped
 * landed; these had no dependency on that closure at all, which is what made
 * them safe to move first and is the test for whatever moves next.
 */

import type { CursorState } from "../../chart/engine";
import type { BarView } from "../../chart/series";
import type { FeedQuality } from "../../data/feed";
import type { DrawKind } from "../../draw/model";
import type { IconName } from "../icons";

export function qualityLabel(q: FeedQuality): string {
  switch (q) {
    case "live":
      return "LIVE";
    case "delayed":
      return "DELAYED";
    case "stale":
      return "STALE";
    case "closed":
      return "CLOSED";
    default:
      return "OFFLINE";
  }
}

export function cursorField(
  c: CursorState | null,
  bars: readonly BarView[],
  key: "open" | "high" | "low" | "close" | "volume",
): string {
  if (!c || !c.inside || c.index < 0 || c.index >= bars.length) return "—";
  const bar = bars[c.index];
  if (!bar) return "—";
  const map = { open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v } as const;
  return fmt(map[key]);
}


export function num1(v: number): string {
  return Number.isNaN(v) ? "—" : v.toFixed(1);
}

export function num2(v: number): string {
  return Number.isNaN(v) ? "—" : v.toFixed(2);
}

export function fmtOrDash(v: number): string {
  return Number.isNaN(v) ? "—" : fmt(v);
}

/**
 * Format `v` with the precision the INSTRUMENT deserves, not the one `v` does.
 *
 * `fmt` picks decimals from the magnitude of the number it is given, which is
 * right for a price and wrong for a difference between two. A 33-point move on
 * Bitcoin came out as "33.0600" — four decimals of noise on an instrument
 * quoted to two, sitting in the most-read figure on the chart — because 33 is
 * small even though the price it moved is not. Precision belongs to the scale
 * being measured, so the reference price supplies it.
 */
export function fmtLike(v: number, reference: number): string {
  const abs = Math.abs(reference);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmt(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Icon per drawing kind, kept beside the shell rather than in the pure model. */
export const DRAW_ICON: Record<DrawKind, IconName> = {
  trendline: "trendline",
  ray: "ray",
  hline: "hline",
  vline: "vline",
  rect: "rect",
  fib: "fib",
  fibext: "fibext",
  measure: "measure",
  text: "note",
  channel: "channel",
  pitchfork: "pitchfork",
  position: "position",
  arrow: "arrow",
};

/** 1.2B, 43.1M, 900K. For volume columns where the magnitude is the message. */
export function abbreviate(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}


export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A number at exactly `dp` decimals in the reader's locale, or an em dash
    when there is no number. Lifted from `mountShell` in v59. */
export function num(v: number, dp = 2): string {
  return Number.isFinite(v)
    ? v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";
}

/** A price at a precision that suits its magnitude: 2 decimals from 1,000
    up, 4 from 1, 6 below — so gold, EURUSD and a small-cap all read right. */
export function fmtPx(v: number): string {
  return num(v, Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 4 : 6);
}
