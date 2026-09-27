/**
 * Single-bar and few-bar patterns — and the gate that makes them worth having.
 *
 * WHY THIS FILE ALMOST DID NOT GET WRITTEN
 * An engulfing candle in open air is not information. On any liquid series a
 * bar closing beyond the previous bar's body happens often enough that a
 * detector publishing all of them puts a mark on every third bar and tells you
 * nothing you could not see. Drawn, that is a chart you cannot read.
 *
 * So this detector does not publish a candle. It publishes a candle AT A
 * PLACE. Every pattern here must occur within a tolerance of something the
 * terminal already believes matters — a clustered S/R level, or a confirmed
 * swing extreme — and the reason string names which one.
 *
 * The gate is also what makes the RECORD readable. `setup/simulate.ts` will
 * measure "engulfing" as a kind; an ungated sample would measure the base rate
 * of the instrument and report it as the pattern's edge.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Doji and marubozu. A doji is the absence of a body, which is `inside-bar`
 * with extra steps, and a marubozu is a displacement candle — `zones.ts`
 * already ranks those and uses them for something. Neither would carry its own
 * record.
 */

import { atr } from "../chart/indicators";
import { bodyShares, quantile } from "./calibrate";
import { alternate, findPivots, swingFloor } from "./pivots";
import { detectLevels } from "./structure";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";

export interface CandleOptions {
  /**
   * How close to a level or swing the bar must be, in ATR. Measured from the
   * bar's own extreme rather than its close: a pin bar's whole point is that
   * the WICK reached the level and the close did not.
   */
  gateAtr?: number;
  /** Bars of history to scan. */
  lookback?: number;
  /** Per kind, newest first. */
  maxPerKind?: number;
  /**
   * A body must be at least this quantile of the window's bodies to count as
   * an engulfing. Rank, not magnitude — see `detect/calibrate.ts`.
   */
  bodyQuantile?: number;
  /** A pin bar's wick must be at least this multiple of its body. */
  wickRatio?: number;
}

const DEFAULTS = {
  gateAtr: 0.5,
  lookback: 600,
  maxPerKind: 6,
  bodyQuantile: 0.6,
  wickRatio: 2,
};

export type CandleKind = "engulfing" | "pin-bar" | "inside-bar" | "star";

/** A place the terminal already believes matters, with the reason it does. */
export interface Anchor {
  price: number;
  what: string;
}

/**
 * The anchors a candle can be gated against.
 *
 * Levels come from `detectLevels` rather than being recomputed, so a candle
 * says "at the level" about the same level the chart is drawing. Swings come
 * from confirmed pivots only — an unconfirmed pivot would let a bar be gated
 * against an extreme that its own future created.
 */
export function anchorsAt(data: DetectInput, len: number): Anchor[] {
  const out: Anchor[] = [];

  for (const lv of detectLevels(data, {}, len)) {
    const shape = lv.shapes.find((s) => s.type === "level");
    if (shape && shape.type === "level") out.push({ price: shape.y, what: "a clustered level" });
  }

  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len),
  );
  for (const p of pivots) {
    out.push({
      price: p.price,
      what: p.kind === "high" ? "a prior swing high" : "a prior swing low",
    });
  }

  return out;
}

/** The nearest anchor to `price`, or null when nothing is within `tol`. */
export function nearestAnchor(
  anchors: readonly Anchor[],
  price: number,
  tol: number,
): Anchor | null {
  let best: Anchor | null = null;
  let bestGap = Infinity;
  for (const a of anchors) {
    const gap = Math.abs(a.price - price);
    if (gap <= tol && gap < bestGap) {
      best = a;
      bestGap = gap;
    }
  }
  return best;
}

export function detectCandles(
  data: DetectInput,
  opts: CandleOptions = {},
  len = data.c.length,
): Detection[] {
  const gateAtr = opts.gateAtr ?? DEFAULTS.gateAtr;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS.maxPerKind;
  const bodyQ = opts.bodyQuantile ?? DEFAULTS.bodyQuantile;
  const wickRatio = opts.wickRatio ?? DEFAULTS.wickRatio;

  if (len < 30) return [];

  const a = atr(data.h, data.l, data.c, 14, len);
  const bodyCut = quantile(bodyShares(data.o, data.c, len), bodyQ);

  /* One anchor pass over the whole window rather than one per candidate.
     Recomputing levels and pivots inside the loop is quadratic and was the
     difference between a detector that runs on bar close and one that stalls
     the tab. Both sources are confirmation-aware by construction, so this is a
     performance shortcut and not a peek at the future: `findPivots` will not
     return a pivot whose right-hand bars have not closed, and `detectLevels`
     is evaluated at `len` exactly as every other detector is. */
  const anchors = anchorsAt(data, len);

  const from = Math.max(3, len - lookback);
  const found: Detection[] = [];

  for (let i = from; i < len; i++) {
    const o = data.o[i] as number;
    const h = data.h[i] as number;
    const l = data.l[i] as number;
    const c = data.c[i] as number;
    const tol = (a[i] as number) * gateAtr;
    if (!Number.isFinite(tol) || tol <= 0) continue;

    const range = h - l;
    if (range <= 0) continue;
    const body = Math.abs(c - o);
    const bodyTop = Math.max(o, c);
    const bodyBottom = Math.min(o, c);
    const up = c > o;

    const po = data.o[i - 1] as number;
    const pc = data.c[i - 1] as number;
    const ph = data.h[i - 1] as number;
    const pl = data.l[i - 1] as number;
    const prevRange = ph - pl;
    const prevBody = Math.abs(pc - po);
    const prevUp = pc > po;

    // ---- engulfing: this body covers the last one, and it is a real body ----
    const covers = bodyTop >= Math.max(po, pc) && bodyBottom <= Math.min(po, pc);
    const shareOfOpen = o > 0 ? body / o : 0;
    if (covers && body > prevBody && shareOfOpen >= bodyCut && up !== prevUp) {
      const anchor = nearestAnchor(anchors, up ? l : h, tol);
      if (anchor) {
        found.push(
          mark(
            "engulfing",
            i,
            up ? "long" : "short",
            up ? "Bullish engulfing" : "Bearish engulfing",
            `The body covers the previous bar's entirely and closes ${up ? "above" : "below"} it, at ` +
              `${anchor.what} (${px(anchor.price)}). Body is ${(body / (prevBody || body)).toFixed(1)}x ` +
              `the bar it engulfed.`,
            clamp01(
              0.45 + 0.3 * clamp01(body / range) + 0.2 * clamp01(body / (prevBody || body) - 1),
            ),
            { h, l, up },
          ),
        );
      }
    }

    // ---- pin bar: one long wick, small body, rejecting a level ----
    const upperWick = h - bodyTop;
    const lowerWick = bodyBottom - l;
    const hammer = lowerWick >= body * wickRatio && lowerWick > upperWick * 2;
    const shooter = upperWick >= body * wickRatio && upperWick > lowerWick * 2;
    if (hammer || shooter) {
      const tip = hammer ? l : h;
      const wick = hammer ? lowerWick : upperWick;
      const anchor = nearestAnchor(anchors, tip, tol);
      if (anchor && wick / range >= 0.5) {
        found.push(
          mark(
            "pin-bar",
            i,
            hammer ? "long" : "short",
            hammer ? "Hammer" : "Shooting star",
            `A wick ${((wick / range) * 100).toFixed(0)}% of the bar's range reached ` +
              `${anchor.what} at ${px(anchor.price)} and the close came back off it.`,
            clamp01(0.4 + 0.35 * clamp01(wick / range) + 0.25 * clamp01(1 - body / range)),
            { h, l, up: hammer },
          ),
        );
      }
    }

    // ---- inside bar: contraction, only where it means something ----
    if (prevRange > 0 && h <= ph && l >= pl && range / prevRange <= 0.7) {
      const anchor = nearestAnchor(anchors, c, tol);
      if (anchor) {
        found.push(
          mark(
            "inside-bar",
            i,
            "neutral",
            "Inside bar",
            `The whole bar sits inside the previous one at ${((range / prevRange) * 100).toFixed(0)}% ` +
              `of its range, while price is at ${anchor.what} (${px(anchor.price)}). ` +
              `This marks the coil, not a side — direction is unresolved.`,
            clamp01(0.35 + 0.4 * clamp01(1 - range / prevRange)),
            { h: ph, l: pl, up: true },
          ),
        );
      }
    }

    // ---- morning / evening star: drive, stall, reclaim ----
    if (i >= 2) {
      const o2 = data.o[i - 2] as number;
      const c2 = data.c[i - 2] as number;
      const body2 = Math.abs(c2 - o2);
      const midpoint = (o2 + c2) / 2;
      const smallMiddle = prevBody <= body2 * 0.5;
      const morning = c2 < o2 && smallMiddle && up && c > midpoint;
      const evening = c2 > o2 && smallMiddle && !up && c < midpoint;
      if ((morning || evening) && o2 > 0 && body2 / o2 >= bodyCut) {
        const tip = morning ? Math.min(pl, l) : Math.max(ph, h);
        const anchor = nearestAnchor(anchors, tip, tol);
        if (anchor) {
          found.push(
            mark(
              "star",
              i,
              morning ? "long" : "short",
              morning ? "Morning star" : "Evening star",
              `Three bars: a ${morning ? "down" : "up"} body, a stall no more than half its size, ` +
                `then a close back past its midpoint (${px(midpoint)}) — turning at ${anchor.what} ` +
                `(${px(anchor.price)}).`,
              clamp01(
                0.45 + 0.3 * clamp01(body / body2) + 0.25 * clamp01(1 - prevBody / body2),
              ),
              {
                h: Math.max(h, ph, data.h[i - 2] as number),
                l: Math.min(l, pl, data.l[i - 2] as number),
                up: morning,
              },
            ),
          );
        }
      }
    }
  }

  return capPerKind(found, maxPerKind);
}

function mark(
  kind: CandleKind,
  i: number,
  direction: "long" | "short" | "neutral",
  label: string,
  reason: string,
  confidence: number,
  box: { h: number; l: number; up: boolean },
): Detection {
  const tone = direction === "long" ? "bull" : direction === "short" ? "bear" : "neutral";
  const shapes: Shape[] = [
    { type: "box", x0: i - 0.45, x1: i + 0.45, y0: box.l, y1: box.h, tone, dashed: true },
    { type: "marker", x: i, y: box.up ? box.l : box.h, tone, text: label, above: !box.up },
  ];
  return {
    id: `${kind}-${i}`,
    kind,
    label,
    direction,
    /* `from` is the bar the pattern starts on; a star spans three. `to` is the
       bar at which it became knowable, which is always the last bar of the
       pattern — `simulate.ts` enters strictly after it. */
    from: kind === "star" ? i - 2 : kind === "pin-bar" ? i : i - 1,
    to: i,
    confidence,
    reason,
    shapes,
  };
}

/**
 * Newest `max` of each kind.
 *
 * Per kind rather than overall: a window thick with inside bars would
 * otherwise crowd out the single engulfing that is the reason to look.
 */
function capPerKind(found: readonly Detection[], max: number): Detection[] {
  const byKind = new Map<string, Detection[]>();
  for (const d of found) {
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }
  const out: Detection[] = [];
  for (const list of byKind.values()) {
    list.sort((x, y) => y.to - x.to);
    out.push(...list.slice(0, max));
  }
  out.sort((x, y) => x.to - y.to);
  return out;
}
