/**
 * The Strategy desk's small canvases: equity, underwater, simulated drawdowns
 * and trade excursions.
 *
 * Moved out of `ui/strategy.ts` unchanged when the desk became the "built
 * together" flow, because the flow draws the SAME curve and the SAME drawdown
 * histogram as the family lab below it. Two copies of a painter are two
 * captions that can drift apart; one module is one.
 */

import type { BarView } from "../../chart/series";
import type { ExcursionRead } from "../../backtest/excursion";
import {
  binIndex,
  DASH_REFERENCE,
  DASH_THRESHOLD,
  emptyNote,
  extent,
  histogram,
  hRule,
  indexAtX,
  label,
  LABEL_PX,
  linear,
  nearestPoint,
  vRule,
  type MiniFrame,
  type Pad,
  type Probe,
} from "../minichart";

/** A bar's timestamp as a UTC minute, for a readout. Stated as UTC, never local. */
export const utcMinute = (t: number): string => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * "bar 812 of 5000" and "2025-03-04 13:00 UTC" — the date only when the curve is
 * known to be one point per studied bar. A remote study whose curve length
 * disagrees with the bars held here gets the index alone rather than a date
 * that might belong to a different bar.
 */
export function barLines(i: number, n: number, bars: readonly BarView[] | null): string[] {
  const at = `bar ${i + 1} of ${n}`;
  const b = bars && bars.length === n ? bars[i] : undefined;
  return b ? [at, utcMinute(b.t)] : [at];
}

/**
 * Equity sparkline.
 *
 * Deliberately small and unlabelled on the y axis. A big curve with a big
 * number on it is the single most persuasive and least informative object in
 * this whole desk, and sizing it like a headline would undo the point of the
 * headline. The value is there for whoever points at it, one bar at a time.
 */
export function paintEquity(f: MiniFrame, equity: ArrayLike<number>, bars: readonly BarView[] | null): Probe | null {
  const n = equity.length;
  if (n < 2) {
    emptyNote(f, "no equity curve — no trades were taken");
    return null;
  }
  const { lo, hi } = extent(equity, 1);
  const x = linear(0, n - 1, f.x0, f.x1);
  const y = linear(lo, hi, f.y1, f.y0);
  const { ctx, theme } = f;

  // The break-even line, so a curve that ends below 1.0 cannot look like a win.
  hRule(f, y(1), { color: theme.border, dash: DASH_REFERENCE });

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i);
    const py = y(equity[i] as number);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  return (px) => {
    const i = indexAtX(px, n, f.x0, f.x1);
    const v = equity[i] as number;
    if (!Number.isFinite(v)) return null;
    return {
      x: x(i),
      y: y(v),
      mark: "cross",
      color: theme.accent,
      lines: [`${v.toFixed(3)}× capital`, ...barLines(i, n, bars)],
    };
  };
}

/**
 * The underwater curve: drawdown below the running peak, hanging from the top.
 *
 * Under the equity sparkline because the sparkline hides exactly this. A curve
 * that ends high still spent most of its life below a previous peak, and time
 * under water is what an operator actually sits through.
 */
export function paintUnderwater(f: MiniFrame, dd: ArrayLike<number>, bars: readonly BarView[] | null): Probe | null {
  const n = dd.length;
  if (n < 2) return null;
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, dd[i] as number);
  if (worst <= 0) {
    emptyNote(f, "never below a prior peak");
    return null;
  }
  const { ctx, theme } = f;
  const x = linear(0, n - 1, f.x0, f.x1);
  const y = linear(0, worst, f.y0, f.y1);
  ctx.beginPath();
  ctx.moveTo(f.x0, y(0));
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(dd[i] as number));
  ctx.lineTo(f.x1, y(0));
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = theme.neg;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.neg;
  ctx.lineWidth = 1;
  ctx.stroke();
  label(f, `−${(worst * 100).toFixed(1)}%`, f.x0, f.y1 - 1);

  return (px) => {
    const i = indexAtX(px, n, f.x0, f.x1);
    const v = dd[i] as number;
    return {
      x: x(i),
      y: y(v),
      mark: "cross",
      color: theme.neg,
      lines: [v > 0 ? `−${(v * 100).toFixed(2)}% below peak` : "at a peak", ...barLines(i, n, bars)],
    };
  };
}

/** Room for one label row under a plot. */
export const PAD_LABELLED: Pad = { l: 4, r: 4, t: 4, b: 15 };

/**
 * Histogram of simulated max drawdowns, with the backtest's own drawdown and
 * the ruin threshold marked. Bars in the accent, the ruin line in the loss
 * colour — the colour marks the THRESHOLD's meaning, not the tallest bar.
 */
export function paintDrawdownHistogram(
  f: MiniFrame,
  sorted: ArrayLike<number>,
  observed: number,
  ruin: number,
): Probe | null {
  const n = sorted.length;
  if (n === 0) {
    emptyNote(f, "not simulated");
    return null;
  }
  const { ctx, theme } = f;
  const top = Math.max(sorted[n - 1] as number, observed, ruin) * 1.05 || 0.01;
  const bins = 30;
  const counts = histogram(sorted, top, bins);
  const peak = Math.max(...counts);
  const x = linear(0, top, f.x0, f.x1);
  const bw = (f.x1 - f.x0) / bins;
  const plotH = f.y1 - f.y0;
  ctx.fillStyle = theme.accent;
  for (let b = 0; b < bins; b++) {
    const bh = ((counts[b] as number) / peak) * plotH;
    if (bh > 0) ctx.fillRect(f.x0 + b * bw + 0.5, f.y1 - bh, Math.max(1, bw - 1), bh);
  }
  vRule(f, x(ruin), { color: theme.neg, dash: DASH_THRESHOLD });
  vRule(f, x(observed), { color: theme.text, width: 1.5 });
  label(f, "0%", f.x0, f.h - 3);
  label(f, `${(top * 100).toFixed(0)}%`, f.x1, f.h - 3, "right");

  return (px) => {
    if (px < f.x0 || px > f.x1) return null;
    const b = binIndex(((px - f.x0) / (f.x1 - f.x0)) * top, top, bins);
    const lo = (b / bins) * top;
    const hi = ((b + 1) / bins) * top;
    const c = counts[b] as number;
    const lines = [
      `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}% max drawdown`,
      `${c} of ${n} paths · ${((c / n) * 100).toFixed(1)}%`,
    ];
    if (observed >= lo && observed < hi) lines.push(`backtest's own: ${(observed * 100).toFixed(1)}%`);
    if (ruin >= lo && ruin < hi) lines.push(`ruin level: ${(ruin * 100).toFixed(0)}%`);
    return { x: f.x0 + (b + 0.5) * bw, y: f.y0, mark: "band", x0: f.x0 + b * bw, x1: f.x0 + (b + 1) * bw, lines };
  };
}

export const PAD_SCATTER: Pad = { l: 32, r: 6, t: 6, b: 15 };

/**
 * Every trade as one dot: how far it went against the entry (x, in R) and how
 * it ended (y, in R). Winners in the gain colour, losers in the loss colour.
 *
 * The dashed vertical is 1R — the stop, where losers pile up by construction.
 * The solid one is where 90% of WINNERS' heat ended: the gap between the two
 * lines is room the stop gives that winners did not use. Drawn in the accent
 * because it is a reading about the rule, not a market state.
 */
export function paintExcursions(f: MiniFrame, read: ExcursionRead | null): Probe | null {
  if (!read || read.refused !== null || read.points.length === 0) {
    emptyNote(f, read?.refused ? "not enough trades to plot" : "not run yet");
    return null;
  }
  const { ctx, theme } = f;
  const xMax = Math.max(1.2, ...read.points.map((q) => q.mae)) * 1.05;
  const rs = read.points.map((q) => q.r);
  const yMax = Math.max(1, ...rs) * 1.1;
  const yMin = Math.min(-1, ...rs) * 1.1;
  const x = linear(0, xMax, f.x0, f.x1);
  const y = linear(yMax, yMin, f.y0, f.y1);

  hRule(f, y(0), { color: theme.border });
  vRule(f, x(1), { color: theme.faint, dash: DASH_THRESHOLD });
  vRule(f, x(read.winnerMaeP90), { color: theme.accent });

  const px = read.points.map((q) => ({ x: x(q.mae), y: y(q.r) }));
  ctx.globalAlpha = 0.75;
  for (let i = 0; i < px.length; i++) {
    const q = read.points[i]!;
    const p = px[i]!;
    ctx.fillStyle = q.r > 0 ? theme.pos : theme.neg;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  label(f, "0", f.x0, f.h - 3);
  label(f, "1R against", x(1) + 3, f.h - 3);
  label(f, `${yMax.toFixed(1)}R`, f.x0 - 4, f.y0 + LABEL_PX - 2, "right");
  label(f, "0R", f.x0 - 4, y(0) + 3, "right");
  label(f, `${yMin.toFixed(1)}R`, f.x0 - 4, f.y1, "right");

  const sign = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(2)}R`;
  return (mx, my) => {
    const i = nearestPoint(px, mx, my, 12);
    if (i < 0) return null;
    const q = read.points[i]!;
    const p = px[i]!;
    return {
      x: p.x,
      y: p.y,
      mark: "ring",
      color: q.r > 0 ? theme.pos : theme.neg,
      lines: [
        `${sign(q.r)} final`,
        `${q.mae.toFixed(2)}R against · ${q.mfe.toFixed(2)}R best`,
        `trade ${i + 1} of ${px.length}`,
      ],
    };
  };
}
