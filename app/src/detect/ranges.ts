/**
 * Ranges, expansions, and the blocks that flipped.
 *
 * WHY A RANGE DETECTOR IS THE MOST USEFUL THING IN THIS FILE
 * Most of a chart is a range. Every other detector in this directory finds
 * structure that implies a direction — a break, a gap, a block, a formation —
 * which means the terminal is at its most talkative exactly when there is
 * least to say, and silent about the condition it is in most of the time.
 *
 * A named range does two jobs nothing else here does. It tells you the
 * structural signals inside it are worth less, and it gives the expansion out
 * of it a level to be measured against. "Price broke the 12-bar range it had
 * been in" is a sentence; "price closed above an EMA" is not.
 *
 * WHY THE BREAKER IS HERE AND NOT IN `zones.ts`
 * A breaker is not a zone found from bar geometry. It is an ORDER BLOCK PLUS
 * WHAT HAPPENED TO IT — a block that price traded through and then came back
 * to from the other side. That is a question about history, and `zones.ts`
 * deliberately knows nothing about history: `detectOrderBlocks` finds the
 * block and stops. Tracking the failure belongs in its own pass.
 */

import { detectOrderBlocks } from "./zones";
import { atr } from "../chart/indicators";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";

export interface RangeOptions {
  /** Shortest run of bars that counts as a range. */
  minBars?: number;
  /**
   * How tight the range must be, in ATR.
   *
   * Measured against volatility rather than against a percentage, because 1%
   * is a coiled spring on EURUSD and a quiet hour on a small-cap token. Three
   * ATR of total height over ten bars is genuinely sideways at any of them.
   */
  maxHeightAtr?: number;
  lookback?: number;
  maxResults?: number;
}

const DEFAULTS = { minBars: 10, maxHeightAtr: 3, lookback: 400, maxResults: 4 };

/**
 * Sideways stretches, and the bar that leaves them.
 *
 * THE GREEDY SCAN, AND WHY IT SCANS BACKWARDS
 * Ranges are grown from the RIGHT: start at each candidate end bar and extend
 * left while the enclosing box stays inside the height budget. Growing from
 * the left instead finds the same stretches but dates them to their start,
 * and a range reported as "began 90 bars ago" is far less useful than the same
 * range reported as "you are in this now, and here are its edges".
 *
 * Overlapping ranges are collapsed to the longest, because two boxes drawn
 * over the same sideways patch is one piece of information rendered twice.
 */
export function detectRanges(
  data: DetectInput,
  opts: RangeOptions = {},
  len = data.c.length,
): Detection[] {
  const minBars = opts.minBars ?? DEFAULTS.minBars;
  const maxHeightAtr = opts.maxHeightAtr ?? DEFAULTS.maxHeightAtr;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  if (len < minBars + 20) return [];

  const a = atr(data.h, data.l, data.c, 14, len);
  const from = Math.max(20, len - lookback);

  interface Found {
    start: number;
    end: number;
    hi: number;
    lo: number;
    heightAtr: number;
  }
  const found: Found[] = [];

  for (let end = len - 1; end >= from + minBars; end--) {
    const budget = (a[end] as number) * maxHeightAtr;
    if (!Number.isFinite(budget) || budget <= 0) continue;

    let hi = -Infinity;
    let lo = Infinity;
    let start = end;
    for (let i = end; i >= from; i--) {
      const h = data.h[i] as number;
      const l = data.l[i] as number;
      const nextHi = Math.max(hi, h);
      const nextLo = Math.min(lo, l);
      if (nextHi - nextLo > budget) break;
      hi = nextHi;
      lo = nextLo;
      start = i;
    }

    if (end - start + 1 < minBars) continue;
    found.push({ start, end, hi, lo, heightAtr: (hi - lo) / (a[end] as number) });
    /* Skip past what was just claimed. Without this every bar inside one
       sideways stretch reports its own slightly shorter version of it. */
    end = start;
  }

  const out = found.map((r): Detection => {
    /* Did anything leave? A close beyond the box AFTER it ended is the
       expansion, and it is the actionable half of the detection. */
    let breakAt = -1;
    let breakUp = false;
    for (let i = r.end + 1; i < len; i++) {
      const c = data.c[i] as number;
      if (c > r.hi) {
        breakAt = i;
        breakUp = true;
        break;
      }
      if (c < r.lo) {
        breakAt = i;
        breakUp = false;
        break;
      }
    }

    const bars = r.end - r.start + 1;
    /* Longer and tighter is a more meaningful range, and both are measured. */
    const length = clamp01((bars - minBars) / (minBars * 3));
    const tightness = clamp01(1 - r.heightAtr / maxHeightAtr);
    const confidence = clamp01(0.4 + 0.3 * length + 0.3 * tightness);

    const shapes: Shape[] = [
      {
        type: "box",
        x0: r.start - 0.5,
        x1: (breakAt < 0 ? len - 1 : breakAt) + 0.5,
        y0: r.lo,
        y1: r.hi,
        tone: "neutral",
        dashed: true,
        label: `${bars} bars`,
      },
    ];
    if (breakAt >= 0) {
      shapes.push({
        type: "marker",
        x: breakAt,
        y: breakUp ? r.hi : r.lo,
        tone: breakUp ? "bull" : "bear",
        text: "EXP",
        above: breakUp,
      });
    }

    return {
      id: `range-${r.start}-${r.end}`,
      kind: breakAt >= 0 ? "expansion" : "range",
      label: breakAt >= 0 ? "Range expansion" : "Range",
      /* An unbroken range has no direction, and saying otherwise would be the
         single most common way this detector could mislead. */
      direction: breakAt < 0 ? "neutral" : breakUp ? "long" : "short",
      from: r.start,
      to: breakAt < 0 ? r.end : breakAt,
      confidence,
      reason:
        breakAt < 0
          ? `${bars} bars between ${px(r.lo)} and ${px(r.hi)} — ${r.heightAtr.toFixed(1)} ATR tall, still inside`
          : `${bars}-bar range between ${px(r.lo)} and ${px(r.hi)}, closed ${breakUp ? "above" : "below"} it`,
      shapes,
    };
  });

  return out.slice(0, maxResults);
}

export interface BreakerOptions {
  lookback?: number;
  maxResults?: number;
  /** How close price must return to the flipped block, as a share of price. */
  retestTolerance?: number;
}

/**
 * Breaker blocks — an order block that failed, and is now the other side.
 *
 * THE SEQUENCE, WHICH IS THE WHOLE DEFINITION
 *  1. An order block forms. `detectOrderBlocks` finds it; nothing here
 *     re-derives it, because two definitions of an order block on one screen
 *     is a bug report waiting to happen.
 *  2. Price closes THROUGH it. The block failed — whoever was defending it is
 *     now offside.
 *  3. Price comes BACK to it from the other side. That is the breaker: the
 *     same prices, now expected to reject in the opposite direction.
 *
 * Step 2 is what separates this from a mitigation. Both are drawn, and the
 * label says which, because they behave differently: a mitigation block is the
 * block being re-tested and holding, and a breaker is the block having failed
 * and flipped. Conflating them — which most tooling does — means one label
 * covering two opposite expectations.
 */
export function detectBreakers(
  data: DetectInput,
  opts: BreakerOptions = {},
  len = data.c.length,
): Detection[] {
  const maxResults = opts.maxResults ?? 4;
  const tol = opts.retestTolerance ?? 0.002;

  /* `hideMitigated: false` is essential: a mitigated block is exactly what
     this pass is looking for, and the default would filter every candidate
     out before it was examined. */
  const blocks = detectOrderBlocks(data, { hideMitigated: false, maxZones: 24 }, len);

  const out: Detection[] = [];

  for (const block of blocks) {
    const box = block.shapes.find((s) => s.type === "box");
    if (box === undefined || box.type !== "box") continue;
    const lo = Math.min(box.y0, box.y1);
    const hi = Math.max(box.y0, box.y1);
    const bullish = block.direction === "long";

    /* Step 2: a CLOSE through the far side. A wick through is a test, not a
       failure, and treating it as one would flip the block on every spike. */
    let brokeAt = -1;
    for (let i = block.to + 1; i < len; i++) {
      const c = data.c[i] as number;
      if (bullish ? c < lo : c > hi) {
        brokeAt = i;
        break;
      }
    }
    if (brokeAt < 0) continue;

    /* Step 3: a return to the zone from the other side. */
    let retestAt = -1;
    for (let i = brokeAt + 1; i < len; i++) {
      const h = data.h[i] as number;
      const l = data.l[i] as number;
      const band = hi * tol;
      if (l <= hi + band && h >= lo - band) {
        retestAt = i;
        break;
      }
    }

    const flipped: "long" | "short" = bullish ? "short" : "long";
    /* A retested breaker is a stronger read than one price has not returned
       to, and the number says so rather than both scoring the same. */
    const confidence = clamp01(block.confidence * (retestAt >= 0 ? 0.95 : 0.7));

    const shapes: Shape[] = [
      {
        type: "box",
        x0: block.from - 0.5,
        x1: len - 1,
        y0: lo,
        y1: hi,
        tone: flipped === "long" ? "bull" : "bear",
        extend: true,
        label: retestAt >= 0 ? "breaker · retested" : "breaker",
      },
      {
        type: "marker",
        x: brokeAt,
        y: bullish ? lo : hi,
        tone: flipped === "long" ? "bull" : "bear",
        text: "FLIP",
        above: !bullish,
      },
    ];

    out.push({
      id: `breaker-${block.from}-${brokeAt}`,
      kind: "breaker",
      label: "Breaker block",
      direction: flipped,
      from: block.from,
      to: retestAt >= 0 ? retestAt : brokeAt,
      confidence,
      reason: `${bullish ? "demand" : "supply"} block at ${px(lo)}–${px(hi)} failed on the close through it${retestAt >= 0 ? ", and price has come back to it from the other side" : " — not yet retested"}`,
      shapes,
    });
  }

  return out.slice(-maxResults);
}
