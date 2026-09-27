/**
 * Market structure: BOS, CHoCH, and horizontal levels.
 *
 * BOS  (break of structure)  — price closes beyond the prior swing IN the
 *                              direction the market was already going.
 *                              Continuation.
 * CHoCH (change of character) — price closes beyond the prior swing AGAINST
 *                              the prevailing direction. The first warning
 *                              that the trend may be over.
 *
 * The distinction is entirely about the trend state at the moment of the break,
 * which is why this is a single stateful pass rather than two independent
 * detectors. Labelling every break a "BOS" — a common shortcut — throws away the
 * only information that made the concept worth having.
 *
 * Breaks are confirmed on CLOSE, not on wick. A wick through a level that the
 * bar closes back inside is precisely the liquidity sweep these levels exist to
 * describe; treating it as a break inverts the meaning.
 */

import { findPivots, alternate, type Pivot } from "./pivots";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";
import { saturate } from "./calibrate";
import { atr } from "../chart/indicators";

export interface StructureOptions {
  left?: number;
  right?: number;
  minProminence?: number;
  /** Cap how far a level is drawn forward, in bars. */
  maxExtend?: number;
}

export function detectStructure(
  data: DetectInput,
  opts: StructureOptions = {},
  len = data.c.length,
): Detection[] {
  const pivots = alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 3,
        right: opts.right ?? 3,
        minProminence: opts.minProminence ?? 0.001,
      },
      len,
    ),
  );
  if (pivots.length < 3) return [];

  /* ATR at each bar, so a break's decisiveness is measured against how far this
     instrument normally travels rather than against a share of its price. */
  const unit = atr(data.h, data.l, data.c, 14, len);

  const out: Detection[] = [];
  /** null until the first break establishes a direction. */
  let trend: "up" | "down" | null = null;

  // Walk bars forward, tracking the most recent CONFIRMED pivot of each kind.
  let lastHigh: Pivot | null = null;
  let lastLow: Pivot | null = null;
  let pivotCursor = 0;
  /** Levels already broken, so one swing does not fire on every later bar. */
  const brokenHighs = new Set<number>();
  const brokenLows = new Set<number>();

  for (let i = 0; i < len; i++) {
    // Admit pivots only once their right-hand bars have closed.
    while (pivotCursor < pivots.length && (pivots[pivotCursor] as Pivot).confirmedAt <= i) {
      const p = pivots[pivotCursor] as Pivot;
      if (p.kind === "high") lastHigh = p;
      else lastLow = p;
      pivotCursor++;
    }

    const close = data.c[i] as number;

    if (lastHigh && !brokenHighs.has(lastHigh.index) && close > lastHigh.price) {
      const isContinuation = trend === "up";
      const kind = trend === null || isContinuation ? "bos" : "choch";
      out.push(
        breakDetection({
          kind,
          direction: "long",
          pivot: lastHigh,
          breakIndex: i,
          close,
          len,
          maxExtend: opts.maxExtend ?? 60,
          wasTrend: trend,
          atr: unit[i] as number,
        }),
      );
      brokenHighs.add(lastHigh.index);
      trend = "up";
    }

    if (lastLow && !brokenLows.has(lastLow.index) && close < lastLow.price) {
      const isContinuation = trend === "down";
      const kind = trend === null || isContinuation ? "bos" : "choch";
      out.push(
        breakDetection({
          kind,
          direction: "short",
          pivot: lastLow,
          breakIndex: i,
          close,
          len,
          maxExtend: opts.maxExtend ?? 60,
          wasTrend: trend,
          atr: unit[i] as number,
        }),
      );
      brokenLows.add(lastLow.index);
      trend = "down";
    }
  }

  return out;
}

function breakDetection(args: {
  kind: "bos" | "choch";
  direction: "long" | "short";
  pivot: Pivot;
  breakIndex: number;
  close: number;
  len: number;
  maxExtend: number;
  wasTrend: "up" | "down" | null;
  /** Local ATR at the break, so every confidence term is scale-free. */
  atr: number;
}): Detection {
  const { kind, direction, pivot, breakIndex, close, wasTrend } = args;
  const bullish = direction === "long";

  /* Confidence from measurable properties only: how decisively price cleared
     the level, and how significant the swing was in the first place — both
     measured in ATR, and both saturating.

     Was `overshoot * 25 + pivot.prominence * 8` on shares of price. Two
     problems: a break that cleared by 2.6% of price scored the same on gold as
     on a memecoin while meaning something completely different, and the sum was
     unbounded so a large break reported 1.00. See the block at the foot of
     detect/calibrate.ts. */
  const overshootPrice = Math.abs(close - pivot.price);
  const overshootAtr = args.atr > 0 ? overshootPrice / args.atr : 0;
  const prominenceAtr = args.atr > 0 ? (pivot.prominence * pivot.price) / args.atr : 0;
  const overshoot = overshootPrice / (pivot.price || 1);
  const confidence = clamp01(
    0.3 + 0.35 * saturate(overshootAtr, 1) + 0.25 * saturate(prominenceAtr, 3),
  );

  const label = kind === "bos" ? "Break of structure" : "Change of character";
  const reason =
    kind === "bos"
      ? `close ${px(close)} broke the prior swing ${bullish ? "high" : "low"} ${px(pivot.price)} ` +
        `(bar ${pivot.index}) ${wasTrend === null ? "establishing" : "continuing"} the ${bullish ? "up" : "down"} leg — ` +
        `cleared by ${(overshoot * 100).toFixed(2)}%`
      : `close ${px(close)} broke the prior swing ${bullish ? "high" : "low"} ${px(pivot.price)} ` +
        `AGAINST the prevailing ${wasTrend === "up" ? "up" : "down"} trend — first sign that leg is over`;

  const shapes: Shape[] = [
    {
      type: "line",
      x0: pivot.index,
      y0: pivot.price,
      x1: breakIndex,
      y1: pivot.price,
      tone: bullish ? "bull" : "bear",
      dashed: true,
      label: kind === "bos" ? "BOS" : "CHoCH",
    },
    {
      type: "marker",
      x: breakIndex,
      y: close,
      tone: bullish ? "bull" : "bear",
      text: kind === "bos" ? "BOS" : "CHoCH",
      above: bullish,
    },
  ];

  return {
    id: `${kind}-${direction}-${pivot.index}-${breakIndex}`,
    kind,
    label,
    direction,
    from: pivot.index,
    to: breakIndex,
    confidence,
    reason,
    shapes,
  };
}

/**
 * Horizontal support/resistance from clustered pivots.
 *
 * A level matters because price turned there MORE THAN ONCE. A single pivot is
 * a swing, not a level, so clusters of one are dropped — that is the whole
 * filter, and without it every swing becomes a line and the chart is unreadable.
 */
export function detectLevels(
  data: DetectInput,
  opts: { tolerance?: number; minTouches?: number; maxLevels?: number } & StructureOptions = {},
  len = data.c.length,
): Detection[] {
  const tolerance = opts.tolerance ?? 0.0035;
  const minTouches = opts.minTouches ?? 2;
  const maxLevels = opts.maxLevels ?? 6;

  const pivots = findPivots(
    data.h,
    data.l,
    { left: opts.left ?? 3, right: opts.right ?? 3, minProminence: opts.minProminence ?? 0.002 },
    len,
  );
  if (pivots.length === 0) return [];

  // Greedy clustering by price proximity. Pivots are sorted by price so a
  // cluster is a contiguous run, which keeps this O(n log n) rather than O(n^2).
  const byPrice = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [];

  for (const p of byPrice) {
    if (current.length === 0) {
      current = [p];
      continue;
    }
    const anchor = current[0] as Pivot;
    if (Math.abs(p.price - anchor.price) / anchor.price <= tolerance) current.push(p);
    else {
      clusters.push(current);
      current = [p];
    }
  }
  if (current.length) clusters.push(current);

  const scored = clusters
    .filter((c) => c.length >= minTouches)
    .map((c) => {
      const price = c.reduce((sum, p) => sum + p.price, 0) / c.length;
      const lastTouch = Math.max(...c.map((p) => p.index));
      const firstTouch = Math.min(...c.map((p) => p.index));
      const highs = c.filter((p) => p.kind === "high").length;
      const lows = c.length - highs;
      /* More touches and more recent touches both matter; recency is scaled by
         how far back the level sits relative to the visible history.

         Was `0.25 + (c.length - 1) * 0.15 + recency * 0.3`, which saturates at
         four touches. Measured live, EVERY level on both XAUUSD and ETHUSDT
         reported exactly 1.00 — and because the list below sorts by this value
         before slicing to `maxLevels`, it was choosing arbitrarily among ties.
         Half the touch credit at three touches, and it can never reach 1. */
      const recency = len > 0 ? lastTouch / len : 0;
      const confidence = clamp01(
        0.25 + 0.4 * saturate(c.length - minTouches, 3) + 0.25 * recency,
      );
      return { price, lastTouch, firstTouch, touches: c.length, highs, lows, confidence };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxLevels);

  return scored.map((s) => {
    // A level touched from both sides has flipped role at least once, which is
    // more informative than a one-sided level and worth saying out loud.
    const both = s.highs > 0 && s.lows > 0;
    const role = both ? "flipped support/resistance" : s.highs > 0 ? "resistance" : "support";
    return {
      id: `level-${s.price.toFixed(6)}`,
      kind: "level",
      label: role,
      direction: "neutral",
      from: s.firstTouch,
      to: s.lastTouch,
      confidence: s.confidence,
      reason:
        `${s.touches} swings within ${(tolerance * 100).toFixed(2)}% of ${px(s.price)} ` +
        `(${s.highs} high${s.highs === 1 ? "" : "s"}, ${s.lows} low${s.lows === 1 ? "" : "s"})` +
        (both ? " — price has traded through and re-tested it from the other side" : ""),
      shapes: [
        {
          type: "level",
          x0: s.firstTouch,
          y: s.price,
          tone: "accent",
          dashed: true,
          /**
           * The CHART tag is short; the sentence lives on the detection.
           *
           * `label` above is "flipped support/resistance", which is the right
           * thing for the Smart money desk to read out. Painting that same
           * 27-character phrase onto the chart once per level stacked six
           * identical prefixes down the left edge, over the candles, and the
           * only part that differed — the price — was pushed to the end of each
           * line where the eye reaches it last.
           *
           * A tag on a chart is a HANDLE, not a description: enough to tell one
           * line from another. The price leads because that is what differs.
           */
          label: `${px(s.price)}  ${both ? "flip" : s.highs > 0 ? "res" : "sup"}`,
        },
      ],
    };
  });
}
