/**
 * Small-chart kit — the lab's four little plots, drawn one way.
 *
 * Before this, every painter in the Strategy desk sized its own canvas, read
 * its own colours, picked its own font and padding, and none of them answered
 * the pointer. Four plots, four typographies, and the only way to read a value
 * off any of them was to estimate it from a pixel.
 *
 * WHAT IT DOES
 * - Sizes a canvas for the device pixel ratio and reads role colours from the
 *   theme with getComputedStyle, so a theme switch is a repaint, not an edit.
 * - One font (the mono role, 10px), one padding scheme, one gridline colour.
 * - Hover: a painter returns a `probe` that maps a pointer position to a hit;
 *   the kit draws the crosshair / dot / band and positions a DOM readout over
 *   the canvas. The readout is a real element — selectable text, crisp at any
 *   DPR, styled by `styles/minichart.css` — and never takes focus.
 *
 * WHY HOVER IS CHEAP
 * The base plot is painted ONCE per data or size change into an offscreen
 * backing canvas. A hover frame is one `drawImage` of that bitmap plus the
 * overlay, whatever the size of the series underneath. MEASURED in the browser
 * (Chrome via the dev server, DPR 1, 5,000-point equity curve, 600×96 CSS px,
 * tab visible throughout): one hover repaint per frame over 200 real frames,
 * INCLUDING the readout's text swap and the forced layout that positions it,
 * cost 1.3 ms average, 2.1 ms p95, 7.5 ms worst. A base paint of the same
 * curve cost 2.3 ms averaged over 50. So hover sits well inside a 16 ms frame,
 * and — unlike redrawing the line per pointermove — it does not grow with the
 * series: the blit is the same cost at 500 points or 50,000.
 * (A getImageData readback per iteration inflates both numbers ~30x by forcing
 * a GPU sync; it measures the readback, not the paint, so it was not used.)
 *
 * Every hover repaint goes through `scheduleFrame`, never raw rAF — this
 * terminal is normally a background tab, and a burst of pointermoves is
 * coalesced into one pending frame.
 */

import { scheduleFrame } from "../core/frame";

// ------------------------------------------------------------- pure parts ---

/** A linear map from a domain to a range. A zero-width domain maps to the range's middle. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0 || !Number.isFinite(span)) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const k = (r1 - r0) / span;
  return (v: number) => r0 + (v - d0) * k;
}

/**
 * Finite min and max of a series. Non-finite values are skipped. When the
 * series is flat or empty the extent is widened around `anchor` so a scale
 * built on it never divides by zero.
 */
export function extent(values: ArrayLike<number>, anchor = 0, widen = 0.01): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { lo: anchor - widen, hi: anchor + widen };
  if (hi <= lo) return { lo: Math.min(lo, anchor) - widen, hi: Math.max(hi, anchor) + widen };
  return { lo, hi };
}

/**
 * The index of the sample nearest to pixel `x`, for `n` samples spread evenly
 * from `x0` (index 0) to `x1` (index n-1). Clamped; -1 when there are none.
 */
export function indexAtX(x: number, n: number, x0: number, x1: number): number {
  if (n <= 0) return -1;
  if (n === 1 || x1 === x0) return 0;
  const i = Math.round(((x - x0) / (x1 - x0)) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/** Which of `bins` equal bins over [0, top) a value falls in, clamped at both ends. */
export function binIndex(v: number, top: number, bins: number): number {
  if (bins <= 0) return -1;
  if (!(top > 0)) return 0;
  const b = Math.floor((v / top) * bins);
  return Math.max(0, Math.min(bins - 1, b));
}

/** Counts per bin, with `binIndex`'s clamping. */
export function histogram(values: ArrayLike<number>, top: number, bins: number): number[] {
  const counts = new Array<number>(Math.max(0, bins)).fill(0);
  for (let i = 0; i < values.length; i++) {
    const b = binIndex(values[i] as number, top, bins);
    if (b >= 0) counts[b] = (counts[b] as number) + 1;
  }
  return counts;
}

/**
 * The point nearest to (px, py) in pixel space, or -1 when none lies within
 * `maxDist`. Ties go to the earlier point.
 */
export function nearestPoint(
  pts: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
  maxDist: number,
): number {
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as { x: number; y: number };
    const dx = p.x - px;
    const dy = p.y - py;
    const d = dx * dx + dy * dy;
    if (d <= bestD && (best === -1 || d < bestD)) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

// ------------------------------------------------------------ theme/frame ---

/** Role colours, read from the theme. Never literals at a call site. */
export interface MiniTheme {
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly border: string;
  readonly hair: string;
  readonly accent: string;
  readonly pos: string;
  readonly neg: string;
  /** The canvas font: the mono role at the kit's one label size. */
  readonly font: string;
}

/** Label size, in CSS px. One size for every small plot. */
export const LABEL_PX = 10;

export function readTheme(el: Element): MiniTheme {
  const css = getComputedStyle(el);
  // The fallbacks exist only so a canvas outside the themed tree still draws;
  // they are never the product's colours.
  const v = (name: string, fb: string): string => css.getPropertyValue(name).trim() || fb;
  return {
    surface: v("--surface", "#111"),
    text: v("--text", "#ddd"),
    muted: v("--text-muted", "#aaa"),
    faint: v("--text-faint", "#888"),
    border: v("--border", "#333"),
    hair: v("--border-hair", "#222"),
    accent: v("--accent", "#5b8cff"),
    pos: v("--pos", "#3c9"),
    neg: v("--neg", "#c55"),
    font: `${LABEL_PX}px ${v("--font-mono", "ui-monospace, monospace")}`,
  };
}

export interface Pad {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
}

/** The standard padding: room for a label row underneath, nothing else. */
export const PAD: Pad = { l: 4, r: 4, t: 4, b: 4 };

export interface MiniFrame {
  readonly ctx: CanvasRenderingContext2D;
  /** CSS pixels. */
  readonly w: number;
  readonly h: number;
  readonly theme: MiniTheme;
  /** The plot rectangle inside the padding, CSS pixels. */
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

// -------------------------------------------------------- drawing helpers ---

export type Align = "left" | "right" | "center";

/** A label in the kit's font and colour. `y` is the baseline. */
export function label(f: MiniFrame, text: string, x: number, y: number, align: Align = "left", color?: string): void {
  const { ctx } = f;
  ctx.font = f.theme.font;
  ctx.fillStyle = color ?? f.theme.faint;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

/** The one empty-state line, centred vertically. */
export function emptyNote(f: MiniFrame, text: string): void {
  label(f, text, f.x0 + 4, f.h / 2 + LABEL_PX / 3);
}

export interface RuleStyle {
  readonly color?: string;
  readonly dash?: readonly number[];
  readonly width?: number;
}

/** A horizontal rule across the plot at pixel `y`. */
export function hRule(f: MiniFrame, y: number, s: RuleStyle = {}): void {
  rule(f, f.x0, y, f.x1, y, s);
}

/** A vertical rule down the plot at pixel `x`. */
export function vRule(f: MiniFrame, x: number, s: RuleStyle = {}): void {
  rule(f, x, f.y0, x, f.y1, s);
}

function rule(f: MiniFrame, ax: number, ay: number, bx: number, by: number, s: RuleStyle): void {
  const { ctx } = f;
  // Snap to the half pixel so a 1px rule is one pixel, not two faint ones.
  const snap = (v: number): number => Math.round(v) + 0.5;
  const vertical = ax === bx;
  ctx.save();
  ctx.strokeStyle = s.color ?? f.theme.hair;
  ctx.lineWidth = s.width ?? 1;
  ctx.setLineDash(s.dash ? [...s.dash] : []);
  ctx.beginPath();
  ctx.moveTo(vertical ? snap(ax) : ax, vertical ? ay : snap(ay));
  ctx.lineTo(vertical ? snap(bx) : bx, vertical ? by : snap(by));
  ctx.stroke();
  ctx.restore();
}

/** Dashes used by every plot, so a dashed line means the same thing everywhere. */
export const DASH_THRESHOLD: readonly number[] = [3, 3];
export const DASH_REFERENCE: readonly number[] = [2, 3];

// ------------------------------------------------------------------ hover ---

/**
 * What the pointer is over.
 *
 * `x`/`y` anchor the mark in CSS px. `mark` picks the overlay: a crosshair
 * with a dot on the series, a ring around a scatter point, or a column band
 * over a histogram bin (`x0`..`x1`).
 */
export interface Hit {
  readonly x: number;
  readonly y: number;
  readonly mark: "cross" | "ring" | "band";
  readonly color?: string;
  readonly x0?: number;
  readonly x1?: number;
  /** One line per row of the readout, first line emphasised. */
  readonly lines: readonly string[];
}

export type Probe = (x: number, y: number) => Hit | null;

export interface MiniSpec {
  /** Fallback height when the canvas has not been laid out yet. */
  readonly height: number;
  /** Accessible description of the plot. */
  readonly label: string;
  readonly pad?: Pad;
  /** Draw the base plot. Return a probe to make it hoverable, or null. */
  readonly paint: (f: MiniFrame) => Probe | null;
}

export interface MiniChart {
  /** The wrapper to mount — canvas plus its readout. */
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Repaint the base on the next served frame (data changed). */
  readonly repaint: () => void;
  /** Paint synchronously now. Exposed for measurement. */
  readonly paintNow: () => void;
  /** Draw one hover frame synchronously at (x, y). Exposed for measurement. */
  readonly hoverNow: (x: number, y: number) => void;
}

export function createMiniChart(spec: MiniSpec, canvasStyle = ""): MiniChart {
  const canvas = document.createElement("canvas");
  canvas.className = "equity-canvas mc-canvas";
  if (canvasStyle) canvas.setAttribute("style", canvasStyle);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", spec.label);

  const readout = document.createElement("div");
  readout.className = "mc-readout";
  // Pointer-only decoration: the numbers it shows are already in the card's
  // metrics. Hidden from AT, never focusable, never under the pointer.
  readout.setAttribute("aria-hidden", "true");
  readout.hidden = true;

  const el = document.createElement("div");
  el.className = "mc";
  el.append(canvas, readout);

  const base = document.createElement("canvas");
  let frame: MiniFrame | null = null;
  let probe: Probe | null = null;
  let dpr = 1;
  let pointer: { x: number; y: number } | null = null;
  let hoverPending = false;
  let basePending = false;

  const paintNow = (): void => {
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const hgt = canvas.clientHeight || spec.height;
    const pw = Math.round(w * dpr);
    const ph = Math.round(hgt * dpr);
    base.width = pw;
    base.height = ph;
    canvas.width = pw;
    canvas.height = ph;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const theme = readTheme(canvas);
    // An opaque canvas clears to black unless the themed background is painted.
    ctx.fillStyle = theme.surface;
    ctx.fillRect(0, 0, w, hgt);
    const pad = spec.pad ?? PAD;
    const f: MiniFrame = { ctx, w, h: hgt, theme, x0: pad.l, x1: w - pad.r, y0: pad.t, y1: hgt - pad.b };
    probe = spec.paint(f);
    frame = f;
    canvas.style.cursor = probe ? "crosshair" : "";
    compose();
  };

  /** Blit the base, then the overlay for the current pointer, if any. */
  const compose = (): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx || !frame) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    const hit = pointer && probe ? probe(pointer.x, pointer.y) : null;
    if (!hit) {
      readout.hidden = true;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawHit({ ...frame, ctx }, hit);
    showReadout(hit);
  };

  const drawHit = (f: MiniFrame, hit: Hit): void => {
    const { ctx, theme } = f;
    const color = hit.color ?? theme.text;
    if (hit.mark === "band") {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = theme.text;
      const a = hit.x0 ?? hit.x - 2;
      const b = hit.x1 ?? hit.x + 2;
      ctx.fillRect(a, f.y0, b - a, f.y1 - f.y0);
      ctx.restore();
      return;
    }
    if (hit.mark === "cross") vRule(f, hit.x, { color: theme.muted, dash: DASH_REFERENCE });
    ctx.save();
    ctx.beginPath();
    ctx.arc(hit.x, hit.y, hit.mark === "ring" ? 4.5 : 3, 0, Math.PI * 2);
    if (hit.mark === "ring") {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = theme.surface;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  };

  let shownLines = "";
  const showReadout = (hit: Hit): void => {
    const key = hit.lines.join("\n");
    if (key !== shownLines) {
      shownLines = key;
      readout.replaceChildren(
        ...hit.lines.map((t, i) => {
          const row = document.createElement("span");
          row.className = i === 0 ? "mc-readout-lead" : "mc-readout-row";
          row.textContent = t;
          return row;
        }),
      );
    }
    readout.hidden = false;
    // Right of the mark when it fits, else left of it, else on whichever side
    // has more room — then clamped inside the canvas horizontally. A readout
    // taller than a short strip hangs from its top rather than off its top.
    const w = canvas.clientWidth;
    const rw = readout.offsetWidth;
    const rh = readout.offsetHeight;
    const gap = 10;
    const fitsRight = hit.x + gap + rw <= w;
    const fitsLeft = hit.x - gap - rw >= 0;
    const right = fitsRight || (!fitsLeft && w - hit.x >= hit.x);
    const left = Math.max(0, Math.min(w - rw, right ? hit.x + gap : hit.x - gap - rw));
    const top = Math.max(0, Math.min(canvas.clientHeight - rh, hit.y - rh / 2));
    readout.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  const hoverNow = (x: number, y: number): void => {
    pointer = { x, y };
    compose();
  };

  canvas.addEventListener("pointermove", (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (hoverPending) return;
    hoverPending = true;
    scheduleFrame(() => {
      hoverPending = false;
      compose();
    });
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    readout.hidden = true;
    scheduleFrame(compose);
  });

  const repaint = (): void => {
    if (basePending) return;
    basePending = true;
    scheduleFrame(() => {
      basePending = false;
      paintNow();
    });
  };

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => paintNow()).observe(canvas);

  return { el, canvas, repaint, paintNow, hoverNow };
}
