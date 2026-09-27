/**
 * Classical formations and divergence.
 *
 * Every formation here is CONFIRMED, never anticipated. A double top is not a
 * double top until price closes below the neckline; before that it is two highs
 * and a hope. Drawing unconfirmed formations is how a chart ends up covered in
 * patterns that never completed, and how a backtest ends up trading shapes that
 * only existed in hindsight.
 *
 * Each detector reports the bar at which the pattern became knowable (`to`), so
 * a consumer can replay history without reading the future.
 */

import { findPivots, alternate, noiseShare, swingFloor, type Pivot } from "./pivots";
import { rsi } from "../chart/indicators";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";
import { saturate } from "./calibrate";

/**
 * How far clear of its neighbours a swing must stand, in multiples of the
 * series' own typical bar range.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NO LONGER A SHARE OF PRICE, AND WHAT THE OLD ONE COST
 *
 * It was `0.004` — four tenths of a percent of price, the same on every
 * instrument. A constant share of price is not a constant amount of market.
 * Measured on 810 bars of each, same timeframe, near-identical total range
 * (BTCUSDT 1.94%, XAUUSD 2.19%):
 *
 *     minProminence 0.004     BTCUSDT 1m   9 pivots  → 2 trendlines, 1 double
 *                             XAUUSD 1m    0 pivots  → nothing, on any load
 *
 * Every detector in this file stands on those pivots, so on gold the trendline,
 * double-top and head-and-shoulders detectors returned an empty array for ever
 * — silently, with no error, no warning and no count beside their name in the
 * panel. From the operator's side that is indistinguishable from a broken
 * feature, and it was reported as one.
 *
 * FOUR, and it was calibrated rather than picked. Pivot counts at the same
 * multiple, measured on both instruments:
 *
 *              ×3    ×4    ×5    ×6    ×8      old 0.004
 *     XAUUSD   87    55    25    15     6          0
 *     BTCUSDT  75    40    27    20     4          9
 *
 * Four gives 40–55 usable swings on both, where the fixed threshold gave 55
 * fewer on one instrument than the other for no reason connected to the market.
 * A swing that stands four typical bar ranges clear of its neighbourhood is a
 * swing on anything.
 *
 * NOT applied to `structure.ts`, which uses its own smaller constants and does
 * NOT exhibit this: it returns 36 detections on gold against 38 on Bitcoin.
 * A threshold that is already producing comparable results across instruments
 * is not the one to change while fixing this.
 */
export const SWING_NOISE_MULTIPLE = 4;

/** Used only when the series is too short or too flat to measure. */
export const PROMINENCE_FALLBACK = 0.004;

/**
 * WHY THE TWO CONSTANTS ABOVE ARE NO LONGER WHAT THESE DETECTORS USE.
 *
 * They are kept because they are still the honest description of the FIRST
 * bug — a share of price that meant one thing on Bitcoin and another on gold —
 * and because tests pin them. But a multiple of the mean bar range is still a
 * magnitude, and 4 was measured on one-minute bars. On XAUUSD 1h the same
 * multiple leaves 7 confirmed pivots, and every detector in this file that
 * needs more than three of them returns nothing: head & shoulders 0, doubles
 * 0, divergence 0, trendlines 1. Measured on the live series, not inferred.
 *
 * `swingFloor` picks the threshold by rank instead — the strongest
 * len/8 swings — so the pivot supply is the same on any instrument at any
 * timeframe. See detect/calibrate.ts.
 */
/* ────────────────────────────────────────────────────────────────────────────
 * THE SAME DISEASE IN THE PATTERN GEOMETRY, AND IT CUTS BOTH WAYS
 *
 * Once the pivots came back, the pattern tests themselves turned out to be
 * written in shares of price too, and this is where it gets visible: the same
 * constant is impossibly strict at one timeframe and completely vacuous at
 * another. Measured on XAUUSD, mean bar range as a share of price in brackets:
 *
 *   detectDoubles, neckline depth >= 1%
 *     1m  (0.038%)   asks for a 26-bar-range retracement   ->  0 doubles, ever
 *     4h  (0.825%)   asks for 1.2 bar ranges               -> 32 doubles
 *
 *   detectHeadShoulders, shoulders equal within 3.5%
 *     1m             92 bar ranges — the test always passes, so "the shoulders
 *                    match" was not being checked at all
 *
 * Neither number is defensible on its own; what makes them wrong is that they
 * are lengths, and the only length a chart supplies is its own bar range. Two
 * prices closer together than one bar's range are the same price — no chart
 * can say otherwise — and a retracement smaller than a few bar ranges is not a
 * leg. Stated that way the tests mean the same thing on every timeframe, which
 * is the whole point.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Two levels within one bar's range are the same level. */
export const LEVEL_MATCH_NOISE = 1;
/** Shoulders may differ by more than that: they are peers, not a level. */
export const SHOULDER_MATCH_NOISE = 2.5;
/** A retracement shallower than this is inside the swing, not between two. */
export const NECKLINE_DEPTH_NOISE = 3;
/** How near a pivot must pass a trendline to count as touching it. */
export const TOUCH_NOISE = 0.75;

/**
 * The series' own bar range as a share of price — the unit every geometric
 * tolerance in this file is now expressed in.
 *
 * Falls back to the old constants' scale when the series is too short or too
 * flat to measure, so a degenerate input keeps the previous behaviour rather
 * than collapsing every tolerance to zero and rejecting everything.
 */
function unit(data: DetectInput, len: number, fallback: number): number {
  const noise = noiseShare(data.h, data.l, data.c, len);
  return noise > 0 ? noise : fallback;
}

const pivotFloor = (data: DetectInput, opts: FormationOptions, len: number): number =>
  opts.minProminence ??
  swingFloor(data.h, data.l, data.c, len, {
    left: opts.left ?? 4,
    right: opts.right ?? 4,
  });

export interface FormationOptions {
  left?: number;
  right?: number;
  minProminence?: number;
  /** How close two shoulders/peaks must be, as a share of price. */
  tolerance?: number;
}

function pivotsOf(data: DetectInput, opts: FormationOptions, len: number): Pivot[] {
  return alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 4,
        right: opts.right ?? 4,
        minProminence: pivotFloor(data, opts, len),
      },
      len,
    ),
  );
}

/**
 * Double top / double bottom.
 *
 * Two extremes at a similar price with a meaningful retracement between them,
 * confirmed by a close through the intervening neckline.
 */
export function detectDoubles(
  data: DetectInput,
  opts: FormationOptions = {},
  len = data.c.length,
): Detection[] {
  const noise = unit(data, len, 0.001);
  const tolerance = opts.tolerance ?? noise * LEVEL_MATCH_NOISE;
  const minDepth = noise * NECKLINE_DEPTH_NOISE;
  const pivots = pivotsOf(data, opts, len);
  const out: Detection[] = [];

  for (let i = 0; i + 2 < pivots.length; i++) {
    const a = pivots[i] as Pivot;
    const mid = pivots[i + 1] as Pivot;
    const b = pivots[i + 2] as Pivot;
    if (a.kind !== b.kind || mid.kind === a.kind) continue;

    const diff = Math.abs(a.price - b.price) / ((a.price + b.price) / 2);
    if (diff > tolerance) continue;

    const top = a.kind === "high";
    const neckline = mid.price;
    const depth = Math.abs(((a.price + b.price) / 2 - neckline) / neckline);
    // A "double top" whose middle trough is two bars deep is two bars of noise.
    if (depth < minDepth) continue;

    // Confirmation: the first close beyond the neckline AFTER the second peak
    // is confirmed. Nothing is reported before that bar.
    let confirmAt = -1;
    for (let j = b.confirmedAt; j < len; j++) {
      const c = data.c[j] as number;
      if (top ? c < neckline : c > neckline) {
        confirmAt = j;
        break;
      }
    }
    if (confirmAt < 0) continue;

    // Tighter peaks and a deeper neckline both make the formation cleaner.
    const confidence = clamp01(
      0.35 + (1 - diff / tolerance) * 0.3 + Math.min(depth / (minDepth * 6), 1) * 0.25,
    );

    const shapes: Shape[] = [
      {
        type: "line",
        x0: a.index,
        y0: a.price,
        x1: b.index,
        y1: b.price,
        tone: top ? "bear" : "bull",
        label: top ? "Double top" : "Double bottom",
      },
      {
        type: "line",
        x0: a.index,
        y0: neckline,
        x1: confirmAt,
        y1: neckline,
        tone: "neutral",
        dashed: true,
        label: "neckline",
      },
      {
        type: "marker",
        x: confirmAt,
        y: data.c[confirmAt] as number,
        tone: top ? "bear" : "bull",
        text: top ? "2T" : "2B",
        above: !top,
      },
    ];

    out.push({
      id: `${top ? "double-top" : "double-bottom"}-${a.index}-${b.index}`,
      kind: top ? "double-top" : "double-bottom",
      label: top ? "Double top" : "Double bottom",
      direction: top ? "short" : "long",
      from: a.index,
      to: confirmAt,
      confidence,
      reason:
        `two ${top ? "highs" : "lows"} at ${px(a.price)} and ${px(b.price)} ` +
        `(${(diff * 100).toFixed(2)}% apart), neckline ${px(neckline)} ${(depth * 100).toFixed(1)}% away; ` +
        `confirmed by the close through it at bar ${confirmAt}`,
      shapes,
    });
  }

  return out;
}

/**
 * Head and shoulders (and the inverse).
 *
 * Five alternating pivots where the middle extreme exceeds both neighbours and
 * the two shoulders sit at a similar level. Confirmed on a close through the
 * neckline drawn between the two intervening pivots.
 */
export function detectHeadShoulders(
  data: DetectInput,
  opts: FormationOptions = {},
  len = data.c.length,
): Detection[] {
  const noise = unit(data, len, 0.0014);
  const tolerance = opts.tolerance ?? noise * SHOULDER_MATCH_NOISE;
  const pivots = pivotsOf(data, opts, len);
  const out: Detection[] = [];

  for (let i = 0; i + 4 < pivots.length; i++) {
    const ls = pivots[i] as Pivot;
    const t1 = pivots[i + 1] as Pivot;
    const head = pivots[i + 2] as Pivot;
    const t2 = pivots[i + 3] as Pivot;
    const rs = pivots[i + 4] as Pivot;

    if (ls.kind !== head.kind || head.kind !== rs.kind) continue;
    if (t1.kind === head.kind || t2.kind === head.kind) continue;

    const topPattern = head.kind === "high";
    // The head must genuinely exceed both shoulders.
    const headDominates = topPattern
      ? head.price > ls.price && head.price > rs.price
      : head.price < ls.price && head.price < rs.price;
    if (!headDominates) continue;

    const shoulderDiff = Math.abs(ls.price - rs.price) / ((ls.price + rs.price) / 2);
    if (shoulderDiff > tolerance) continue;

    // Neckline through the two intervening pivots, extrapolated forward.
    const slope = (t2.price - t1.price) / (t2.index - t1.index || 1);
    const necklineAt = (x: number): number => t1.price + slope * (x - t1.index);

    let confirmAt = -1;
    for (let j = rs.confirmedAt; j < len; j++) {
      const c = data.c[j] as number;
      const nl = necklineAt(j);
      if (topPattern ? c < nl : c > nl) {
        confirmAt = j;
        break;
      }
    }
    if (confirmAt < 0) continue;

    const headSize =
      Math.abs(head.price - (t1.price + t2.price) / 2) / ((t1.price + t2.price) / 2 || 1);
    const confidence = clamp01(
      0.35 + (1 - shoulderDiff / tolerance) * 0.3 + Math.min(headSize / (noise * 8), 1) * 0.25,
    );

    out.push({
      id: `hs-${ls.index}-${rs.index}`,
      kind: "head-shoulders",
      label: topPattern ? "Head and shoulders" : "Inverse head and shoulders",
      direction: topPattern ? "short" : "long",
      from: ls.index,
      to: confirmAt,
      confidence,
      reason:
        `shoulders ${px(ls.price)} / ${px(rs.price)} (${(shoulderDiff * 100).toFixed(2)}% apart) ` +
        `around a ${topPattern ? "higher" : "lower"} head ${px(head.price)}; ` +
        `neckline broken on the close at bar ${confirmAt}`,
      shapes: [
        {
          type: "line",
          x0: ls.index,
          y0: ls.price,
          x1: head.index,
          y1: head.price,
          tone: topPattern ? "bear" : "bull",
        },
        {
          type: "line",
          x0: head.index,
          y0: head.price,
          x1: rs.index,
          y1: rs.price,
          tone: topPattern ? "bear" : "bull",
          label: topPattern ? "H&S" : "Inv H&S",
        },
        {
          type: "line",
          x0: t1.index,
          y0: t1.price,
          x1: confirmAt,
          y1: necklineAt(confirmAt),
          tone: "neutral",
          dashed: true,
          label: "neckline",
        },
        {
          type: "marker",
          x: confirmAt,
          y: data.c[confirmAt] as number,
          tone: topPattern ? "bear" : "bull",
          text: "H&S",
          above: !topPattern,
        },
      ],
    });
  }

  return out;
}

/**
 * Trendlines through three or more pivots.
 *
 * Two points define a line; three make it a trendline. The third touch is the
 * entire difference between a line that describes the market and a line drawn
 * through any two points that happen to exist.
 */
export function detectTrendlines(
  data: DetectInput,
  opts: FormationOptions & { minTouches?: number; maxLines?: number; maxPivots?: number } = {},
  len = data.c.length,
): Detection[] {
  const minTouches = opts.minTouches ?? 3;
  const maxLines = opts.maxLines ?? 4;
  const maxPivots = opts.maxPivots ?? 40;
  const tolerance = opts.tolerance ?? unit(data, len, 0.006) * TOUCH_NOISE;
  const pivots = findPivots(
    data.h,
    data.l,
    {
      left: opts.left ?? 4,
      right: opts.right ?? 4,
      minProminence: pivotFloor(data, opts, len),
    },
    len,
  );

  const out: Detection[] = [];

  for (const kind of ["high", "low"] as const) {
    // Only the most recent pivots are candidates. Searching every pair is
    // cubic in pivot count, and a trendline anchored 700 bars back that nobody
    // is trading off is not worth the cost — this was 6.9ms of a 7.3ms
    // detection budget, i.e. 95% of it, for the least-used detector.
    const allOfKind = pivots.filter((p) => p.kind === kind);
    const set = allOfKind.slice(-maxPivots);
    if (set.length < minTouches) continue;

    let best: { a: Pivot; b: Pivot; touches: Pivot[] } | null = null;
    let bestCount = minTouches - 1;

    for (let i = 0; i < set.length - 1; i++) {
      const a = set[i] as Pivot;
      // Even a perfect line can only touch the pivots at or after `i`, so once
      // that cannot beat the incumbent there is nothing left to find.
      if (set.length - i <= bestCount) break;

      for (let j = i + 1; j < set.length; j++) {
        const b = set[j] as Pivot;
        const span = b.index - a.index;
        if (span < 5) continue;
        const slope = (b.price - a.price) / span;

        // Counting loop rather than filter(): the inner body runs O(p^3) times
        // and allocating a closure plus an array there dominated the cost.
        let count = 0;
        for (let k = 0; k < set.length; k++) {
          const p = set[k] as Pivot;
          const expected = a.price + slope * (p.index - a.index);
          if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) count++;
        }

        if (count > bestCount) {
          bestCount = count;
          const touches: Pivot[] = [];
          for (let k = 0; k < set.length; k++) {
            const p = set[k] as Pivot;
            const expected = a.price + slope * (p.index - a.index);
            if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) touches.push(p);
          }
          best = { a, b, touches };
        }
      }
    }

    if (!best) continue;

    const first = best.touches[0] as Pivot;
    const last = best.touches[best.touches.length - 1] as Pivot;
    const slope = (last.price - first.price) / (last.index - first.index || 1);
    const rising = slope > 0;
    /* Was `0.3 + (touches - 2) * 0.2`, unbounded, so five touches reported
       1.00 — and measured live, EVERY trendline on both XAUUSD and ETHUSDT did
       exactly that. A fifth touch is worth less than a third, and no number of
       them is worth certainty. */
    const confidence = clamp01(0.3 + 0.45 * saturate(best.touches.length - minTouches, 2));

    out.push({
      id: `trendline-${kind}-${first.index}-${last.index}`,
      kind: "trendline",
      label: kind === "low" ? (rising ? "Rising support" : "Falling support") : rising ? "Rising resistance" : "Falling resistance",
      direction: rising ? "long" : "short",
      from: first.index,
      to: last.index,
      confidence,
      reason:
        `${best.touches.length} swing ${kind === "high" ? "highs" : "lows"} within ` +
        `${(tolerance * 100).toFixed(2)}% of one line from ${px(first.price)} (bar ${first.index}) ` +
        `to ${px(last.price)} (bar ${last.index})`,
      shapes: [
        {
          type: "line",
          x0: first.index,
          y0: first.price,
          x1: last.index,
          y1: last.price,
          tone: kind === "low" ? "bull" : "bear",
          extend: true,
          label: `${best.touches.length} touches`,
        },
      ],
    });
  }

  return out.slice(0, maxLines);
}

/**
 * RSI divergence.
 *
 * Price makes a higher high while momentum makes a lower high (bearish), or
 * price makes a lower low while momentum makes a higher low (bullish).
 *
 * Only consecutive same-kind pivots are compared. Comparing a pivot against one
 * from three swings ago produces "divergences" between unrelated legs, which is
 * why divergence has a reputation for firing constantly.
 */
export function detectDivergence(
  data: DetectInput,
  opts: FormationOptions & { period?: number; maxAgeBars?: number } = {},
  len = data.c.length,
): Detection[] {
  const period = opts.period ?? 14;
  const maxAge = opts.maxAgeBars ?? 60;
  const values = rsi(data.c, period, len);
  const pivots = alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 4,
        right: opts.right ?? 4,
        minProminence: pivotFloor(data, opts, len),
      },
      len,
    ),
  );

  const out: Detection[] = [];

  for (const kind of ["high", "low"] as const) {
    const set = pivots.filter((p) => p.kind === kind);
    for (let i = 1; i < set.length; i++) {
      const prev = set[i - 1] as Pivot;
      const cur = set[i] as Pivot;
      if (cur.index - prev.index > maxAge) continue;

      const rPrev = values[prev.index];
      const rCur = values[cur.index];
      if (rPrev === undefined || rCur === undefined) continue;
      if (Number.isNaN(rPrev) || Number.isNaN(rCur)) continue;

      const bearish = kind === "high" && cur.price > prev.price && rCur < rPrev;
      const bullish = kind === "low" && cur.price < prev.price && rCur > rPrev;
      if (!bearish && !bullish) continue;

      const gap = Math.abs(rCur - rPrev);
      // A 1-point RSI difference is not a divergence, it is rounding.
      if (gap < 3) continue;

      /* The RSI gap is already dimensionless — RSI is bounded 0..100 — so the
         instrument-transfer problem does not apply here. The unbounded term
         does: `gap / 30` reaches 1.00 at a 21-point divergence, which is large
         but not rare. Half the credit at 12 points. */
      const confidence = clamp01(0.3 + 0.45 * saturate(gap, 12));

      out.push({
        id: `div-${kind}-${prev.index}-${cur.index}`,
        kind: "divergence",
        label: bearish ? "Bearish divergence" : "Bullish divergence",
        direction: bearish ? "short" : "long",
        from: prev.index,
        to: cur.confirmedAt,
        confidence,
        reason:
          `price made a ${bearish ? "higher high" : "lower low"} ` +
          `(${px(prev.price)} → ${px(cur.price)}) while RSI(${period}) made a ` +
          `${bearish ? "lower high" : "higher low"} (${rPrev.toFixed(1)} → ${rCur.toFixed(1)}) — ` +
          `momentum did not confirm the move`,
        shapes: [
          {
            type: "line",
            x0: prev.index,
            y0: prev.price,
            x1: cur.index,
            y1: cur.price,
            tone: bearish ? "bear" : "bull",
            dashed: true,
            label: bearish ? "Bear div" : "Bull div",
          },
        ],
      });
    }
  }

  return out;
}
