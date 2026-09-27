/**
 * Converging and parallel boundaries — wedges, triangles, channels, flags.
 *
 * `formations.ts` fits ONE line to one set of pivots. Every shape here is two
 * lines fitted at once and then classified by what their slopes do relative to
 * each other, which is the whole difference between "there is a trendline" and
 * "price is running out of room".
 *
 * THE CLASSIFICATION IS THE DETECTOR
 * Fit an upper line to the recent swing highs and a lower line to the recent
 * swing lows over the same window, then read the pair:
 *
 *   converging, both rising      rising wedge      (breaks down, usually)
 *   converging, both falling     falling wedge     (breaks up, usually)
 *   converging, upper falling    symmetrical triangle
 *   flat top, rising bottom      ascending triangle
 *   falling top, flat bottom     descending triangle
 *   parallel                     channel
 *   parallel, against a shove    flag
 *
 * "usually" is doing no work here. Which way each of these actually breaks on
 * THIS instrument is what `setup/simulate.ts` measures, and the labels above
 * are folklore until it says otherwise. Nothing in this file assumes a
 * direction: the direction of a published break is the direction price
 * actually closed, and a formation that has not broken is `neutral`.
 *
 * TWO DETECTIONS PER FORMATION, ON PURPOSE
 * The same split `ranges.ts` makes between `range` and `expansion`. While the
 * boundaries hold, the formation is STATE: it is drawn, it is neutral, and it
 * carries no record because there is nothing to replay. The bar that closes
 * through a boundary is an EVENT: it has a side, a `to` that is the bar it
 * became knowable on, and it is what the simulator gets to judge.
 */

import { atr } from "../chart/indicators";
import { findPivots, swingFloor, type Pivot } from "./pivots";
import { clamp01, px, type Detection, type DetectInput, type Shape, type Tone } from "./types";

export interface WedgeOptions {
  /** Bars of history to search for formations. */
  lookback?: number;
  /** Minimum pivots on each boundary. Two points is a line, not a boundary. */
  minTouches?: number;
  /** Fractional tolerance for calling a pivot a touch. */
  tolerance?: number;
  /** Shortest formation worth naming, in bars. */
  minBars?: number;
  /** Longest, in bars. Beyond this it is a range, and `ranges.ts` owns that. */
  maxBars?: number;
  /** Total detections returned. */
  maxResults?: number;
  /**
   * ATR of travel across the formation below which a boundary counts as FLAT.
   */
  flatAtr?: number;
  /**
   * ATR by which the two boundaries' travel must differ before they count as
   * converging rather than parallel.
   *
   * Separate from `flatAtr` because they are different questions. "Is this one
   * line horizontal" and "are these two lines closing on each other" happened
   * to share a constant in the first version, and a shared constant is a
   * coincidence waiting to be tuned in the wrong direction.
   */
  convergeAtr?: number;
}

const DEFAULTS = {
  lookback: 400,
  minTouches: 3,
  tolerance: 0.006,
  minBars: 15,
  maxBars: 160,
  maxResults: 4,
  flatAtr: 1.5,
  convergeAtr: 1.5,
};

/** A boundary: a line through pivots, kept with the pivots that made it. */
interface Boundary {
  /** Price at bar `x`. */
  at(x: number): number;
  slope: number;
  first: Pivot;
  last: Pivot;
  touches: number;
}

/**
 * Best-fitting line through `set`, by touch count then by span.
 *
 * The same exhaustive pair search `detectTrendlines` uses, capped the same way
 * and for the same reason: it is cubic in pivot count and the cap is what
 * keeps it inside a bar-close budget.
 */
function fitBoundary(
  set: readonly Pivot[],
  minTouches: number,
  tolerance: number,
): Boundary | null {
  if (set.length < minTouches) return null;

  let best: Boundary | null = null;
  let bestCount = minTouches - 1;
  let bestSpan = 0;

  for (let i = 0; i < set.length - 1; i++) {
    const a = set[i] as Pivot;
    if (set.length - i <= bestCount) break;
    for (let j = i + 1; j < set.length; j++) {
      const b = set[j] as Pivot;
      const span = b.index - a.index;
      if (span < 5) continue;
      const slope = (b.price - a.price) / span;

      let count = 0;
      let firstIdx = -1;
      let lastIdx = -1;
      for (let k = 0; k < set.length; k++) {
        const p = set[k] as Pivot;
        const expected = a.price + slope * (p.index - a.index);
        if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) {
          count++;
          if (firstIdx < 0) firstIdx = k;
          lastIdx = k;
        }
      }
      if (count < minTouches) continue;

      const first = set[firstIdx] as Pivot;
      const last = set[lastIdx] as Pivot;
      const touchSpan = last.index - first.index;
      /* Touch count first, then span. Two candidate lines with the same number
         of touches are not equally good: the one anchored over more bars has
         had more chances to be wrong and survived them. */
      if (count > bestCount || (count === bestCount && touchSpan > bestSpan)) {
        bestCount = count;
        bestSpan = touchSpan;
        best = {
          at: (x: number) => a.price + slope * (x - a.index),
          slope,
          first,
          last,
          touches: count,
        };
      }
    }
  }

  return best;
}

type Formation = "wedge" | "triangle" | "channel" | "flag";

interface Classified {
  kind: Formation;
  label: string;
  /** Which way folklore says it resolves — used only in the reason string. */
  lean: string;
}

/**
 * Name the pair of slopes.
 *
 * NORMALISED OVER THE FORMATION, NOT PER BAR — AND THE BUG THAT SAYS WHY
 * The first version divided each slope by ATR alone, giving a gradient in
 * "ATR per bar", and called anything under 0.25 of that flat. Measured on live
 * ETHUSDT 1h the two boundaries came back at -0.025 and -0.024 ATR per bar,
 * because a line that climbs a whole ATR every bar is very nearly vertical and
 * no trendline on any chart is remotely near it. So every boundary was flat,
 * every pair was parallel-and-flat, and the detector returned nothing on every
 * series while passing its whole unit suite — the fixtures used slopes of
 * order 1 with a scale of 1, which is self-consistent and physically absurd.
 *
 * The quantity that means something is how far a boundary MOVES ACROSS THE
 * FORMATION, in ATR: `slope * span / atr`. A quarter-ATR of travel over the
 * whole shape is genuinely flat; seven ATR is genuinely falling. Both slopes
 * are normalised over the SAME span — the formation's — because comparing two
 * gradients measured over different numbers of bars compares nothing.
 */
export function classify(
  upperSlope: number,
  lowerSlope: number,
  atrUnit: number,
  spanBars: number,
  flatCut: number,
  convergeCut = flatCut,
): Classified | null {
  if (!(atrUnit > 0) || !(spanBars > 0)) return null;
  const scale = atrUnit / spanBars;
  const up = upperSlope / scale;
  const lo = lowerSlope / scale;

  const upperFlat = Math.abs(up) < flatCut;
  const lowerFlat = Math.abs(lo) < flatCut;

  /* Parallel: the boundaries move together, so the height is not shrinking. */
  const spread = Math.abs(up - lo);
  if (spread < convergeCut) {
    if (upperFlat && lowerFlat) return null; // a flat box is a range; ranges.ts owns it
    const rising = up > 0;
    return {
      kind: "channel",
      label: rising ? "Rising channel" : "Falling channel",
      lean: "a channel resolves by leaving it, either side",
    };
  }

  /* Converging: the boundaries are closing on each other. */
  const converging = up < lo;
  if (!converging) return null; // diverging — a broadening formation, not handled

  if (upperFlat && lo > flatCut) {
    return { kind: "triangle", label: "Ascending triangle", lean: "folklore says up" };
  }
  if (lowerFlat && up < -flatCut) {
    return { kind: "triangle", label: "Descending triangle", lean: "folklore says down" };
  }
  if (up > flatCut && lo > flatCut) {
    return { kind: "wedge", label: "Rising wedge", lean: "folklore says down" };
  }
  if (up < -flatCut && lo < -flatCut) {
    return { kind: "wedge", label: "Falling wedge", lean: "folklore says up" };
  }
  return { kind: "triangle", label: "Symmetrical triangle", lean: "folklore says neither" };
}

export function detectWedges(
  data: DetectInput,
  opts: WedgeOptions = {},
  len = data.c.length,
): Detection[] {
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  const minTouches = opts.minTouches ?? DEFAULTS.minTouches;
  const tolerance = opts.tolerance ?? DEFAULTS.tolerance;
  const minBars = opts.minBars ?? DEFAULTS.minBars;
  const maxBars = opts.maxBars ?? DEFAULTS.maxBars;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  const flatAtr = opts.flatAtr ?? DEFAULTS.flatAtr;
  const convergeAtr = opts.convergeAtr ?? DEFAULTS.convergeAtr;

  if (len < minBars + 10) return [];

  const floor = swingFloor(data.h, data.l, data.c, len);
  const all = findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len);
  const a = atr(data.h, data.l, data.c, 14, len);
  const scale = a[len - 1] as number;
  if (!Number.isFinite(scale) || scale <= 0) return [];

  const windowStart = Math.max(0, len - lookback);
  const highs = all.filter((p) => p.kind === "high" && p.index >= windowStart).slice(-24);
  const lows = all.filter((p) => p.kind === "low" && p.index >= windowStart).slice(-24);

  const upper = fitBoundary(highs, minTouches, tolerance);
  const lower = fitBoundary(lows, minTouches, tolerance);
  if (!upper || !lower) return [];

  const start = Math.max(
    Math.min(upper.first.index, lower.first.index),
    /* Never longer than `maxBars`: past that the two lines are describing the
       whole chart rather than a formation inside it. */
    len - 1 - maxBars,
  );
  const anchorEnd = Math.max(upper.last.confirmedAt, lower.last.confirmedAt);
  if (anchorEnd - start < minBars) return [];

  /* The boundaries must actually contain price at the anchor, or the "fit" is
     two unrelated lines that happen to converge somewhere off-screen. */
  if (upper.at(start) <= lower.at(start)) return [];

  const out: Detection[] = [];

  /* ---- the break, if there is one: strictly after the formation anchored ---- */
  let breakAt = -1;
  let breakUp = false;
  for (let i = anchorEnd + 1; i < len; i++) {
    const c = data.c[i] as number;
    const hi = upper.at(i);
    const lo = lower.at(i);
    if (c > hi) {
      breakAt = i;
      breakUp = true;
      break;
    }
    if (c < lo) {
      breakAt = i;
      breakUp = false;
      break;
    }
  }

  const endX = breakAt >= 0 ? breakAt : len - 1;

  /* Classified only now, because the span is what the slopes are normalised
     over and the span is not known until `endX` is. */
  const shape = classify(upper.slope, lower.slope, scale, endX - start, flatAtr, convergeAtr);
  if (!shape) return [];

  const height = upper.at(endX) - lower.at(endX);
  const startHeight = upper.at(start) - lower.at(start);
  const narrowing = startHeight > 0 ? clamp01(1 - height / startHeight) : 0;
  const touches = upper.touches + lower.touches;
  /* Saturating: the sixth touch on a boundary is worth much less than the
     third, and past about a dozen the line is describing the whole window
     rather than a formation inside it. */
  const touchLift = clamp01((touches - 2 * minTouches) / 8);

  /* A flag is a channel leaning against a shove. Checked here rather than in
     `classify` because it needs the bars BEFORE the formation, which slopes
     alone cannot see. */
  let kind: Formation = shape.kind;
  let label = shape.label;
  if (shape.kind === "channel") {
    const runFrom = Math.max(0, start - Math.round((endX - start) * 1.5));
    const shove = (data.c[start] as number) - (data.c[runFrom] as number);
    const poleAtr = Math.abs(shove) / scale;
    const against = poleAtr >= 3 && Math.sign(shove) !== Math.sign(upper.slope);
    if (against) {
      kind = "flag";
      label = shove > 0 ? "Bull flag" : "Bear flag";
    }
  }

  const tone: Tone = "accent";
  const lines: Shape[] = [
    {
      type: "line",
      x0: start,
      y0: upper.at(start),
      x1: endX,
      y1: upper.at(endX),
      tone: "bear",
      dashed: false,
    },
    {
      type: "line",
      x0: start,
      y0: lower.at(start),
      x1: endX,
      y1: lower.at(endX),
      tone: "bull",
      dashed: false,
    },
  ];

  const geometry =
    `${upper.touches} touches on the upper boundary and ${lower.touches} on the lower, over ` +
    `${endX - start} bars. Height went from ${px(startHeight)} to ${px(height)}` +
    (narrowing > 0.05 ? `, ${(narrowing * 100).toFixed(0)}% narrower` : "") + ".";

  /* ---- the formation itself: state, neutral, no record ---- */
  out.push({
    id: `${kind}-${start}-${endX}`,
    kind,
    label,
    direction: "neutral",
    from: start,
    to: anchorEnd,
    /* Capped well short of 1, and that is not cosmetic. The first version was
       `0.3 + 0.08 * (touches - 2 * minTouches)`, which on the first live series
       gave 0.08 x 15 = 1.2 and clamped to exactly 1.0 — the strongest claim
       this system can make, on every formation it found, because the term was
       unbounded. Extra touches genuinely help and they help less and less, so
       the term saturates. Nothing here earns certainty. */
    confidence: clamp01(0.25 + 0.2 * touchLift + 0.25 * narrowing),
    reason:
      `${geometry} Drawn while it holds and given no side — ${shape.lean}, and folklore is not ` +
      `evidence. The break below is what carries a record.`,
    shapes: lines,
  });

  /* ---- the break: an event, with the side price actually chose ---- */
  if (breakAt >= 0) {
    const level = breakUp ? upper.at(breakAt) : lower.at(breakAt);
    out.push({
      id: `${kind}-break-${breakAt}`,
      kind,
      label: `${label} break ${breakUp ? "up" : "down"}`,
      direction: breakUp ? "long" : "short",
      from: start,
      to: breakAt,
      confidence: clamp01(0.3 + 0.2 * touchLift + 0.2 * narrowing),
      reason:
        `Closed ${breakUp ? "above" : "below"} the ${breakUp ? "upper" : "lower"} boundary at ` +
        `${px(level)} after ${endX - start} bars inside it. ${geometry}`,
      shapes: [
        ...lines,
        {
          type: "marker",
          x: breakAt,
          y: breakUp ? (data.h[breakAt] as number) : (data.l[breakAt] as number),
          tone: breakUp ? "bull" : "bear",
          text: label,
          above: breakUp,
        },
        {
          type: "level",
          x0: start,
          y: level,
          tone,
          label: "boundary",
          dashed: true,
        },
      ],
    });
  }

  return out.slice(0, maxResults);
}
