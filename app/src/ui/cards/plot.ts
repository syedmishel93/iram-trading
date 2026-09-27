/**
 * The arithmetic behind the small charts. Pure, because a chart that lies is invisible.
 *
 * WHY THIS IS A MODULE AND NOT THREE BLOCKS OF INLINE SVG
 *
 * A wrong number in a table is something a reader can catch. A wrong SCALE in a
 * chart looks exactly like the truth — the shape is plausible, the axis is
 * unlabelled, and nothing is red. CLAUDE.md records the same lesson about the
 * coverage ribbon: a segment at the wrong percentage is a lie about when you
 * hold data that no eye can check, so the arithmetic became a pure function
 * with its traps pinned by tests. These are those functions.
 *
 * THE TRAP THAT MATTERS MOST HERE: A SHARED DOMAIN.
 *
 * Overlaying twenty-five equity curves is only honest if every one is drawn
 * against the SAME axes. Scaled to its own range, a rule that went from $500 to
 * $505 draws the identical line to one that went to $900, and the picture whose
 * entire purpose is "is the winner separated from the field" answers yes every
 * time. `sharedDomain` computes one box for all of them and `pathFor` refuses
 * to draw against anything else.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Domain {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** False when there was nothing to measure; nothing should be drawn. */
  readonly ok: boolean;
}

export const EMPTY_DOMAIN: Domain = { x0: 0, x1: 1, y0: 0, y1: 1, ok: false };

/**
 * One box around every series, so lines drawn in it are comparable.
 *
 * A FLAT AXIS IS PADDED, NOT DIVIDED BY. Twenty-five curves that all end where
 * they started have zero height, and `(v - y0) / 0` is NaN — which CSS and SVG
 * both drop silently, so the chart renders as nothing at all and reads as
 * broken rather than as flat. The padding is symmetric, so a flat line lands in
 * the middle where it belongs.
 */
export function sharedDomain(series: readonly (readonly Point[])[]): Domain {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let seen = 0;

  for (const s of series) {
    for (const p of s) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      seen += 1;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (seen === 0) return EMPTY_DOMAIN;

  if (x1 === x0) {
    x0 -= 0.5;
    x1 += 0.5;
  }
  if (y1 === y0) {
    const pad = Math.max(Math.abs(y0) * 0.01, 0.5);
    y0 -= pad;
    y1 += pad;
  }
  return { x0, x1, y0, y1, ok: true };
}

/**
 * An SVG path for one series inside a domain, in a `0 0 w h` viewBox.
 *
 * Y IS FLIPPED HERE AND NOWHERE ELSE. SVG counts downward; equity goes up. A
 * second place that flipped it would produce a chart that is upside down only
 * sometimes, which is harder to notice than one that always is.
 *
 * Returns "" when there is nothing to draw, and a caller must REMOVE the
 * attribute rather than set it empty: an empty `d` is a parse error in some
 * engines and nothing in the rest.
 */
export function pathFor(points: readonly Point[], d: Domain, w: number, h: number): string {
  if (!d.ok || points.length < 2) return "";
  const sx = w / (d.x1 - d.x0);
  const sy = h / (d.y1 - d.y0);
  let out = "";
  let n = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const x = (p.x - d.x0) * sx;
    const y = h - (p.y - d.y0) * sy;
    out += `${n === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    n += 1;
  }
  return n < 2 ? "" : out;
}

/** Where a value sits in the domain's Y, as a fraction from the bottom. */
export function yFraction(v: number, d: Domain): number {
  if (!d.ok || !Number.isFinite(v)) return 0;
  return (v - d.y0) / (d.y1 - d.y0);
}

/** Where a value sits in the domain's X, as a fraction from the left. */
export function xFraction(v: number, d: Domain): number {
  if (!d.ok || !Number.isFinite(v)) return 0;
  return (v - d.x0) / (d.x1 - d.x0);
}

/**
 * How far below its running peak the curve was, at every point.
 *
 * NEVER POSITIVE, and that is the property worth pinning: a drawdown series
 * that can go above zero has computed the peak wrong, and the chart would show
 * an account making money during a fall. The running peak only ever rises.
 *
 * Expressed as a NEGATIVE FRACTION of the peak rather than in money, because
 * the question a drawdown chart answers — could I have sat through this — does
 * not depend on the size of the account.
 */
export function underwater(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  let peak = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.y)) continue;
    if (p.y > peak) peak = p.y;
    /* A peak at or below zero cannot be divided by. An account that started at
       nothing has no drawdown to express as a share of anything. */
    out.push({ x: p.x, y: peak > 0 ? -(peak - p.y) / peak : 0 });
  }
  return out;
}

/**
 * The longest run of consecutive points at or below a threshold.
 *
 * Used for "how long was it under water", in POINTS rather than in time,
 * because the caller knows the bar spacing and this does not. Returning a
 * duration here would mean guessing it.
 */
export function longestRun(points: readonly Point[], atOrBelow: number): number {
  let best = 0;
  let run = 0;
  for (const p of points) {
    if (p.y <= atOrBelow) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}
