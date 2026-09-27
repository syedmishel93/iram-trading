/**
 * Drawings — the model.
 *
 * THE DECISION THAT EVERYTHING ELSE FOLLOWS FROM: ANCHORS ARE TIMES, NOT INDICES.
 *
 * A bar index is a position in whatever array happens to be loaded right now.
 * Backfill four hundred bars of history and every index shifts by four hundred;
 * switch timeframe and they mean nothing at all. A tool that stores index 512
 * will quietly slide every trendline you own down the chart the first time the
 * archive fills a gap, and it will look like the chart moved rather than like
 * the drawing broke.
 *
 * So an anchor is `{ t, p }` — a wall-clock millisecond and a price. Both are
 * facts about the market rather than about the current viewport, so a drawing
 * survives a reload, a backfill, a timeframe change and a different data source.
 * Converting to the bar-index space the renderer wants happens at PAINT time,
 * through `indexAtTime`, and is never stored.
 *
 * WHY THE GEOMETRY IS PURE
 * Hit-testing, dragging and level maths take a projector — two functions that
 * turn a time and a price into pixels — rather than reaching for a canvas. That
 * makes every one of them testable without a DOM, which matters more here than
 * almost anywhere else: "the handle is two pixels off" is the kind of bug that
 * is agony to find by clicking and trivial to find with an assertion.
 */

import type { Shape, Tone } from "../detect/types";

/** A point in market space: wall-clock ms, and a price. */
export interface Anchor {
  readonly t: number;
  readonly p: number;
}

export type DrawKind =
  | "trendline"
  | "ray"
  | "hline"
  | "vline"
  | "rect"
  | "fib"
  | "measure"
  | "text"
  /* v46 additions. Every one of these composes from the SAME four renderer
     primitives the originals use — box, line, level, marker — so none of them
     opened a second painting path, and all of them pan, zoom and re-theme with
     everything else for free. */
  | "channel"
  | "fibext"
  | "pitchfork"
  | "arrow"
  | "position";

export interface Drawing {
  readonly id: string;
  readonly kind: DrawKind;
  /** 1 anchor for hline/vline/text; 2 for everything else. */
  readonly anchors: readonly Anchor[];
  readonly symbol: string;
  /** Empty string means "show on every timeframe of this symbol". */
  readonly timeframe: string;
  readonly tone: Tone;
  readonly text?: string;
  readonly locked?: boolean;
  readonly extendRight?: boolean;
  readonly extendLeft?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** How many anchors each kind needs before it is a complete drawing. */
export const ANCHOR_COUNT: Readonly<Record<DrawKind, number>> = {
  trendline: 2,
  ray: 2,
  hline: 1,
  vline: 1,
  rect: 2,
  fib: 2,
  measure: 2,
  text: 1,
  channel: 3,
  fibext: 3,
  pitchfork: 3,
  arrow: 2,
  position: 3,
};

export const DRAW_KINDS: readonly { id: DrawKind; label: string; hint: string }[] = [
  { id: "trendline", label: "Trend line", hint: "Two points. Ends where you put it." },
  { id: "ray", label: "Ray", hint: "Two points, extended forward for ever." },
  { id: "hline", label: "Horizontal", hint: "One price, across the whole chart." },
  { id: "vline", label: "Vertical", hint: "One time, top to bottom." },
  { id: "rect", label: "Rectangle", hint: "A zone: two corners." },
  { id: "channel", label: "Parallel channel", hint: "Two points for the slope, a third for the width." },
  { id: "pitchfork", label: "Pitchfork", hint: "A pivot and two swings. Median line plus its tines." },
  { id: "fib", label: "Fib retracement", hint: "Where a move might pull back to." },
  { id: "fibext", label: "Fib extension", hint: "Three points. Where a move might reach BEYOND the swing." },
  { id: "position", label: "Position", hint: "Entry, stop, target. Draws the risk and the reward to scale." },
  { id: "measure", label: "Measure", hint: "Distance, percent and bars between two points." },
  { id: "arrow", label: "Arrow", hint: "A pointer, for marking one thing on a chart you are sending to someone." },
  { id: "text", label: "Note", hint: "A label pinned to a bar." },
];

/**
 * Fibonacci retracement levels.
 *
 * 0.5 is in the list and is NOT a Fibonacci ratio — it is a half, included
 * because it is universally drawn and excluding it would be pedantry that made
 * the tool less useful. It is labelled like the others and claims nothing.
 */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/**
 * Fibonacci EXTENSION levels — where a move might reach past the swing that
 * produced it, rather than how far back into it price might pull.
 *
 * A different list from the retracement one because it answers a different
 * question and the overlap is coincidental. 1.272 and 2.618 are here and are
 * not Fibonacci ratios either (they are √1.618 and 1.618²); they are drawn by
 * everyone, they are labelled honestly, and they claim nothing.
 */
export const FIB_EXT_LEVELS: readonly number[] = [0, 0.618, 1, 1.272, 1.618, 2.618];

let counter = 0;
export function newDrawingId(): string {
  counter += 1;
  return `d${counter.toString(36)}`;
}

/** For tests: make ids reproducible. */
export function resetDrawingIds(to = 0): void {
  counter = to;
}

export interface CreateOptions {
  readonly symbol: string;
  readonly timeframe: string;
  readonly tone?: Tone;
  readonly text?: string;
  readonly now?: number;
  readonly extendRight?: boolean;
}

export function createDrawing(
  kind: DrawKind,
  anchors: readonly Anchor[],
  opts: CreateOptions,
): Drawing {
  const at = opts.now ?? Date.now();
  return {
    id: newDrawingId(),
    kind,
    anchors: anchors.slice(0, ANCHOR_COUNT[kind]),
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    tone: opts.tone ?? "neutral",
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    /* A ray is a ray because it extends; storing that as a flag rather than as
       a kind keeps one line-drawing path instead of two that drift apart. */
    extendRight: opts.extendRight ?? kind === "ray",
    createdAt: at,
    updatedAt: at,
  };
}

/* --------------------------------------------------------------- editing -- */

export function moveAnchor(d: Drawing, index: number, to: Anchor, now = Date.now()): Drawing {
  if (index < 0 || index >= d.anchors.length) return d;
  if (d.locked === true) return d;
  const anchors = d.anchors.slice();
  anchors[index] = to;
  return { ...d, anchors, updatedAt: now };
}

/** Translate the whole drawing by a time and price delta. */
export function moveDrawing(d: Drawing, dt: number, dp: number, now = Date.now()): Drawing {
  if (d.locked === true) return d;
  if (dt === 0 && dp === 0) return d;
  return {
    ...d,
    anchors: d.anchors.map((a) => ({ t: a.t + dt, p: a.p + dp })),
    updatedAt: now,
  };
}

/* -------------------------------------------------------------- geometry -- */

/**
 * Times are `ArrayLike`, not `readonly number[]`.
 *
 * The chart stores bar times in a `Float64Array`. Requiring a plain array here
 * would mean copying eight hundred doubles on every hit test — that is, on
 * every pointer move over the chart — to satisfy a type. `ArrayLike` accepts
 * both and the functions only ever index and read `.length`.
 */

/** Market space to pixels. Supplied by the chart at hit-test time. */
export interface Projector {
  x(t: number): number;
  y(p: number): number;
}

export type Hit =
  | { readonly kind: "anchor"; readonly index: number }
  | { readonly kind: "body" }
  | null;

/** Grab radius for an anchor handle, and the click tolerance for a line. */
export const ANCHOR_RADIUS = 7;
export const LINE_TOLERANCE = 6;

/** Perpendicular distance from a point to a finite segment, in pixels. */
export function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  /* A degenerate segment is a point; without this guard the projection divides
     by zero and every zero-length drawing swallows every click on the chart. */
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/**
 * What, if anything, is under the cursor.
 *
 * Anchors are tested BEFORE the body, always. They overlap the line they belong
 * to, and a user reaching for a handle who gets a whole-drawing drag instead
 * will move the thing they were trying to adjust.
 */
export function hitTest(
  d: Drawing,
  px: number,
  py: number,
  proj: Projector,
  bounds: { readonly width: number; readonly height: number },
): Hit {
  const pts = d.anchors.map((a) => ({ x: proj.x(a.t), y: proj.y(a.p) }));

  /**
   * Handles, except where a handle would be a lie.
   *
   * A horizontal line spans the whole chart, so its anchor's TIME carries no
   * meaning; a vertical line's anchor PRICE likewise. Offering a drag handle at
   * one arbitrary point along either would invite the user to adjust a
   * coordinate that does not exist. For those two the whole line is the handle,
   * and dragging the body moves the one coordinate that is real.
   */
  const hasHandles = d.kind !== "hline" && d.kind !== "vline";

  if (d.locked !== true && hasHandles) {
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i] as { x: number; y: number };
      if (Math.hypot(px - pt.x, py - pt.y) <= ANCHOR_RADIUS) return { kind: "anchor", index: i };
    }
  }

  const a = pts[0];
  if (!a) return null;
  const b = pts[1];

  switch (d.kind) {
    case "hline":
      return Math.abs(py - a.y) <= LINE_TOLERANCE ? { kind: "body" } : null;

    case "vline":
      return Math.abs(px - a.x) <= LINE_TOLERANCE ? { kind: "body" } : null;

    case "text":
      /* A generous box around the label rather than the glyphs themselves:
         measuring text would need a canvas, and this is close enough that
         nobody notices while keeping the module DOM-free. */
      return px >= a.x - 6 && px <= a.x + 120 && Math.abs(py - a.y) <= 12
        ? { kind: "body" }
        : null;

    /**
     * A pitchfork is grabbed by its MEDIAN line, not by its tines.
     *
     * The tines are parallels that can run the width of the chart, and making
     * all three clickable would leave a fork covering a third of the plot area
     * intercepting every press meant for the candles behind it.
     */
    case "pitchfork": {
      const c = pts[2];
      if (!b || !c) return null;
      const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      return distanceToSegment(px, py, a.x, a.y, mid.x, mid.y) <= LINE_TOLERANCE
        ? { kind: "body" }
        : null;
    }

    /* Both rails are live: a channel is dragged as often by its lower edge as
       by the one that defined it. */
    case "channel": {
      const c = pts[2];
      if (!b || !c) return null;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const near =
        distanceToSegment(px, py, a.x, a.y, b.x, b.y) <= LINE_TOLERANCE ||
        distanceToSegment(px, py, c.x, c.y, c.x + dx, c.y + dy) <= LINE_TOLERANCE;
      return near ? { kind: "body" } : null;
    }

    /* The two legs that were drawn. The projected levels are output, not
       structure, and grabbing one would move a line the user never placed. */
    case "fibext": {
      const c = pts[2];
      if (!b || !c) return null;
      const near =
        distanceToSegment(px, py, a.x, a.y, b.x, b.y) <= LINE_TOLERANCE ||
        distanceToSegment(px, py, b.x, b.y, c.x, c.y) <= LINE_TOLERANCE;
      return near ? { kind: "body" } : null;
    }

    /* The whole block, both boxes. It is a solid object on screen and behaves
       like one. */
    case "position": {
      const c = pts[2];
      if (!b || !c) return null;
      const xs = [a.x, b.x, c.x];
      const ys = [a.y, b.y, c.y];
      const inside =
        px >= Math.min(...xs) - LINE_TOLERANCE &&
        px <= Math.max(...xs) + LINE_TOLERANCE &&
        py >= Math.min(...ys) - LINE_TOLERANCE &&
        py <= Math.max(...ys) + LINE_TOLERANCE;
      return inside ? { kind: "body" } : null;
    }

    case "arrow":
    case "trendline":
    case "ray":
    case "measure": {
      if (!b) return null;
      let x1 = b.x;
      let y1 = b.y;
      if (d.extendRight === true && b.x !== a.x) {
        /* Extend to the right edge along the same gradient, so a ray is
           clickable over its whole visible length rather than only between the
           two points that defined it. */
        const slope = (b.y - a.y) / (b.x - a.x);
        const far = b.x > a.x ? bounds.width : 0;
        y1 = a.y + slope * (far - a.x);
        x1 = far;
      }
      return distanceToSegment(px, py, a.x, a.y, x1, y1) <= LINE_TOLERANCE
        ? { kind: "body" }
        : null;
    }

    case "rect":
    case "fib": {
      if (!b) return null;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y, b.y);
      const inside =
        px >= left - LINE_TOLERANCE &&
        px <= right + LINE_TOLERANCE &&
        py >= top - LINE_TOLERANCE &&
        py <= bottom + LINE_TOLERANCE;
      return inside ? { kind: "body" } : null;
    }
  }
}

/* --------------------------------------------------- time <-> bar index -- */

/**
 * Fractional bar index for a wall-clock time.
 *
 * Binary search over the loaded bar times, interpolating between them, and
 * EXTRAPOLATING past the last bar at the measured spacing. The extrapolation is
 * the point: a ray drawn today has to be able to reach into next week, and a
 * function that clamped at the newest bar would flatten every projection
 * against the right edge of the chart.
 */
export function indexAtTime(times: ArrayLike<number>, t: number): number {
  const n = times.length;
  if (n === 0) return 0;
  const first = times[0] as number;
  const last = times[n - 1] as number;

  if (n === 1) return 0;

  const spacing = (last - first) / (n - 1);

  if (t <= first) return spacing > 0 ? (t - first) / spacing : 0;
  if (t >= last) return spacing > 0 ? n - 1 + (t - last) / spacing : n - 1;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const a = times[lo] as number;
  const b = times[hi] as number;
  /* Duplicate timestamps would divide by zero. They should not occur, but a
     merged feed is exactly the place they would. */
  return b === a ? lo : lo + (t - a) / (b - a);
}

/** Wall-clock time at a fractional bar index. The inverse, for pointer input. */
export function timeAtIndex(times: ArrayLike<number>, index: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return times[0] as number;
  const first = times[0] as number;
  const last = times[n - 1] as number;
  const spacing = (last - first) / (n - 1);

  if (index <= 0) return first + index * spacing;
  if (index >= n - 1) return last + (index - (n - 1)) * spacing;

  const lo = Math.floor(index);
  const frac = index - lo;
  const a = times[lo] as number;
  const b = times[lo + 1] as number;
  return a + (b - a) * frac;
}

/* ---------------------------------------------------------- measurement -- */

export interface Measurement {
  readonly priceDelta: number;
  readonly pricePct: number;
  readonly bars: number;
  readonly durationMs: number;
  readonly direction: "up" | "down" | "flat";
}

export function measure(d: Drawing, times: ArrayLike<number>): Measurement | null {
  const a = d.anchors[0];
  const b = d.anchors[1];
  if (!a || !b) return null;
  const priceDelta = b.p - a.p;
  return {
    priceDelta,
    pricePct: a.p === 0 ? NaN : (priceDelta / a.p) * 100,
    bars: Math.round(indexAtTime(times, b.t) - indexAtTime(times, a.t)),
    durationMs: b.t - a.t,
    direction: priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "flat",
  };
}

/* ------------------------------------------------------------- rendering -- */

/**
 * Convert to the renderer's data-space shapes.
 *
 * The chart already knows how to draw boxes, lines, levels and markers glued to
 * bar indices — the detectors have used that path since v40. Drawings reuse it
 * rather than opening a second painting route, so a user trendline and a
 * detected trendline are pixel-identical and pan, zoom and re-theme together.
 */
export function toShapes(d: Drawing, times: ArrayLike<number>): Shape[] {
  const idx = (t: number): number => indexAtTime(times, t);
  const a = d.anchors[0];
  if (!a) return [];
  const b = d.anchors[1];

  switch (d.kind) {
    case "hline":
      return [
        {
          type: "level",
          x0: 0,
          y: a.p,
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
          dashed: false,
        },
      ];

    case "vline":
      /* No native vertical primitive, so it is a zero-width box spanning the
         visible price range. The renderer clips it to the plot. */
      return [
        {
          type: "line",
          x0: idx(a.t),
          y0: Number.MIN_SAFE_INTEGER,
          x1: idx(a.t),
          y1: Number.MAX_SAFE_INTEGER,
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
        },
      ];

    case "text":
      return [
        {
          type: "marker",
          x: idx(a.t),
          y: a.p,
          tone: d.tone,
          text: d.text ?? "",
          above: true,
        },
      ];

    case "trendline":
    case "ray":
      if (!b) return [];
      return [
        {
          type: "line",
          x0: idx(a.t),
          y0: a.p,
          x1: idx(b.t),
          y1: b.p,
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
          ...(d.extendRight === true ? { extend: true } : {}),
        },
      ];

    /* An arrow is a trend line that says which end it means. The head is a
       marker rather than a drawn triangle: the renderer already places, sizes
       and collision-avoids markers, and a hand-rolled triangle would have to
       repeat all of that to look right at every zoom. */
    case "arrow": {
      if (!b) return [];
      return [
        {
          type: "line",
          x0: idx(a.t),
          y0: a.p,
          x1: idx(b.t),
          y1: b.p,
          tone: d.tone,
        },
        {
          type: "marker",
          x: idx(b.t),
          y: b.p,
          tone: d.tone,
          text: d.text ?? "\u25B6",
          above: b.p >= a.p,
        },
      ];
    }

    case "rect":
      if (!b) return [];
      return [
        {
          type: "box",
          x0: Math.min(idx(a.t), idx(b.t)),
          x1: Math.max(idx(a.t), idx(b.t)),
          y0: Math.min(a.p, b.p),
          y1: Math.max(a.p, b.p),
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
          ...(d.extendRight === true ? { extend: true } : {}),
        },
      ];

    case "measure": {
      if (!b) return [];
      const m = measure(d, times);
      const label = m
        ? `${m.priceDelta >= 0 ? "+" : ""}${m.pricePct.toFixed(2)}% · ${Math.abs(m.bars)} bars`
        : "";
      return [
        {
          type: "box",
          x0: Math.min(idx(a.t), idx(b.t)),
          x1: Math.max(idx(a.t), idx(b.t)),
          y0: Math.min(a.p, b.p),
          y1: Math.max(a.p, b.p),
          tone: d.tone,
          label,
          dashed: true,
        },
      ];
    }

    /**
     * A parallel channel: the line that was drawn, and the same slope through
     * the third point.
     *
     * The parallel is computed in PRICE-TIME space, not in pixels. That is not
     * a detail — a channel offset by a pixel distance would change its price
     * width every time the vertical scale changed, so it would stop touching
     * the highs it was drawn against the moment you zoomed.
     */
    case "channel": {
      const c = d.anchors[2];
      if (!b || !c) return [];
      const dt = b.t - a.t;
      const slope = dt === 0 ? 0 : (b.p - a.p) / dt;
      const at = (t: number): number => c.p + slope * (t - c.t);
      return [
        {
          type: "line",
          x0: idx(a.t),
          y0: a.p,
          x1: idx(b.t),
          y1: b.p,
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
          ...(d.extendRight === true ? { extend: true } : {}),
        },
        {
          type: "line",
          x0: idx(a.t),
          y0: at(a.t),
          x1: idx(b.t),
          y1: at(b.t),
          tone: d.tone,
          ...(d.extendRight === true ? { extend: true } : {}),
        },
      ];
    }

    /**
     * Andrews pitchfork: a median line from the pivot through the midpoint of
     * the two swings, with a tine parallel to it through each swing.
     *
     * All three extend, because the entire use of the tool is where price meets
     * them in the FUTURE. A pitchfork that stops at the last of its three
     * anchors is a decoration.
     */
    case "pitchfork": {
      const c = d.anchors[2];
      if (!b || !c) return [];
      const mid = { t: (b.t + c.t) / 2, p: (b.p + c.p) / 2 };
      const dt = mid.t - a.t;
      const slope = dt === 0 ? 0 : (mid.p - a.p) / dt;
      const tine = (from: Anchor): Shape => ({
        type: "line",
        x0: idx(from.t),
        y0: from.p,
        x1: idx(mid.t),
        y1: from.p + slope * (mid.t - from.t),
        tone: d.tone,
        dashed: true,
        extend: true,
      });
      return [
        {
          type: "line",
          x0: idx(a.t),
          y0: a.p,
          x1: idx(mid.t),
          y1: mid.p,
          tone: d.tone,
          ...(d.text ? { label: d.text } : {}),
          extend: true,
        },
        tine(b),
        tine(c),
      ];
    }

    /**
     * Fibonacci extension: project the A-to-B leg forward from C.
     *
     * The projection is of the SIGNED move, so an extension drawn on a
     * downswing reads downward. Measuring the absolute size of B minus A and
     * always projecting upward is the standard bug in home-made versions, and
     * it produces targets above price in a market that is falling.
     */
    case "fibext": {
      const c = d.anchors[2];
      if (!b || !c) return [];
      const leg = b.p - a.p;
      const x0 = idx(c.t);
      const legs: Shape[] = [
        { type: "line", x0: idx(a.t), y0: a.p, x1: idx(b.t), y1: b.p, tone: d.tone, dashed: true },
        { type: "line", x0: idx(b.t), y0: b.p, x1: idx(c.t), y1: c.p, tone: d.tone, dashed: true },
      ];
      return [
        ...legs,
        ...FIB_EXT_LEVELS.map((level) => ({
          type: "level" as const,
          x0,
          y: c.p + leg * level,
          tone: d.tone,
          label: `${(level * 100).toFixed(1)}%`,
          dashed: level !== 1,
        })),
      ];
    }

    /**
     * The position tool: entry, stop, target, drawn to scale.
     *
     * This is the one drawing in the set that says something arithmetic rather
     * than geometric, and the label is the reason it exists — the two boxes
     * make the reward-to-risk visible as AREA, which is the form in which a bad
     * trade is obvious at a glance and a ratio in a text field is not.
     *
     * It reports the ratio and NOTHING else. It does not size the position,
     * does not know the account, and cannot place anything. The Risk desk owns
     * sizing and asks for equity before it will answer; keeping that boundary
     * means this tool can never imply a position was taken.
     */
    case "position": {
      const stop = d.anchors[1];
      const target = d.anchors[2];
      if (!stop || !target) return [];
      const x0 = idx(a.t);
      const x1 = Math.max(idx(stop.t), idx(target.t));
      const risk = Math.abs(a.p - stop.p);
      const reward = Math.abs(target.p - a.p);
      const rr = risk > 0 ? reward / risk : NaN;
      return [
        {
          type: "box",
          x0,
          x1,
          y0: Math.min(a.p, stop.p),
          y1: Math.max(a.p, stop.p),
          tone: "bear",
          label: `Risk ${risk > 0 ? risk.toPrecision(4) : "0"}`,
        },
        {
          type: "box",
          x0,
          x1,
          y0: Math.min(a.p, target.p),
          y1: Math.max(a.p, target.p),
          tone: "bull",
          label: Number.isFinite(rr) ? `Reward ${reward.toPrecision(4)} \u00B7 ${rr.toFixed(2)}R` : "Reward",
        },
        {
          type: "level",
          x0,
          y: a.p,
          tone: d.tone,
          label: d.text ?? "Entry",
          dashed: false,
        },
      ];
    }

    case "fib": {
      if (!b) return [];
      const x0 = Math.min(idx(a.t), idx(b.t));
      const hi = Math.max(a.p, b.p);
      const lo = Math.min(a.p, b.p);
      const span = hi - lo;
      /* Levels run from the SECOND anchor back toward the first, which is what
         makes a retracement drawn low-to-high read 0 at the high. */
      const fromHigh = b.p >= a.p;
      return FIB_LEVELS.map((level) => {
        const price = fromHigh ? hi - span * level : lo + span * level;
        return {
          type: "level" as const,
          x0,
          y: price,
          tone: d.tone,
          label: `${(level * 100).toFixed(1)}%`,
          dashed: level !== 0 && level !== 1,
        };
      });
    }
  }
}

/* ------------------------------------------------------------- magnetism -- */

export interface Bar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/**
 * Snap a price to the nearest OHLC of the bar under the cursor.
 *
 * Only when the candidate is within `tolerance` of one — a magnet that always
 * fires cannot be used to draw anything that is not on a bar, which is half of
 * what people draw. Returns the input unchanged when nothing is close.
 */
export function magnetPrice(
  bars: readonly Bar[],
  index: number,
  price: number,
  tolerancePrice: number,
): number {
  const i = Math.round(index);
  const bar = bars[i];
  if (!bar || !(tolerancePrice > 0)) return price;

  let best = price;
  let bestDist = tolerancePrice;
  for (const candidate of [bar.o, bar.h, bar.l, bar.c]) {
    const dist = Math.abs(candidate - price);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/* ------------------------------------------------------------ validation -- */

const TONES: readonly string[] = ["bull", "bear", "neutral", "accent", "warn"];

function isAnchor(v: unknown): v is Anchor {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a["t"] === "number" &&
    Number.isFinite(a["t"]) &&
    typeof a["p"] === "number" &&
    Number.isFinite(a["p"])
  );
}

/**
 * Validate a drawing loaded from storage, sync or a vault file.
 *
 * Returns null for anything that cannot be repaired. A drawing is small and
 * individually replaceable, so unlike a workspace layout there is nothing to be
 * gained by salvaging a broken one — and a trendline with one anchor would
 * render as a line to the origin, which looks like a bug in the chart.
 */
export function sanitizeDrawing(value: unknown): Drawing | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const kind = v["kind"];
  if (typeof kind !== "string" || !(kind in ANCHOR_COUNT)) return null;
  const k = kind as DrawKind;

  const rawAnchors = v["anchors"];
  if (!Array.isArray(rawAnchors)) return null;
  const anchors = rawAnchors.filter(isAnchor);
  if (anchors.length < ANCHOR_COUNT[k]) return null;

  const tone = typeof v["tone"] === "string" && TONES.includes(v["tone"]) ? (v["tone"] as Tone) : "neutral";
  const at = typeof v["createdAt"] === "number" ? v["createdAt"] : 0;

  return {
    id: typeof v["id"] === "string" && v["id"].length > 0 ? v["id"] : newDrawingId(),
    kind: k,
    anchors: anchors.slice(0, ANCHOR_COUNT[k]),
    symbol: typeof v["symbol"] === "string" ? v["symbol"] : "",
    timeframe: typeof v["timeframe"] === "string" ? v["timeframe"] : "",
    tone,
    ...(typeof v["text"] === "string" ? { text: v["text"] } : {}),
    ...(v["locked"] === true ? { locked: true } : {}),
    ...(v["extendRight"] === true ? { extendRight: true } : {}),
    ...(v["extendLeft"] === true ? { extendLeft: true } : {}),
    createdAt: at,
    updatedAt: typeof v["updatedAt"] === "number" ? v["updatedAt"] : at,
  };
}

/** Which drawings apply to a chart. An empty timeframe means every timeframe. */
export function visibleOn(
  drawings: readonly Drawing[],
  symbol: string,
  timeframe: string,
): Drawing[] {
  return drawings.filter(
    (d) => d.symbol === symbol && (d.timeframe === "" || d.timeframe === timeframe),
  );
}
