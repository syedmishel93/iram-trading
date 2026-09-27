/**
 * Volatility state, and the one discontinuity a bar series can contain.
 *
 * SQUEEZE
 * `chart/indicators.ts` has had `squeeze()` since v50 — Bollinger bands inside
 * Keltner channels, the standard compression test — and nothing has ever acted
 * on it. It is a Float64Array of 0/1, so the state is trivially available and
 * the only thing that needed writing is the honest reading of it:
 *
 *   The squeeze being ON is not a signal. It is a description of the last
 *   twenty bars. The bar the squeeze RELEASES on is the event, and even that
 *   only carries a side because price picked one, not because the indicator
 *   predicted it.
 *
 * So the two are separate detections with separate records: `squeeze` while it
 * holds is neutral state, and the release is directional. If it turns out that
 * releases here resolve against their own break direction, the record will say
 * so, which is the entire reason for splitting them.
 *
 * GAPS
 * A gap is the one thing in a bar series that is not a continuous path: price
 * was never offered between the previous close and this open. On a 24-hour
 * crypto perp they are rare and mean a liquidation cascade; on an index or a
 * single stock they are the weekend, and the weekend is a different animal.
 *
 * Every gap here carries whether it has been FILLED, because "gaps get filled"
 * is the most-repeated claim in this part of the field and it is measurable.
 * The detector does not assert it — it publishes the gap with its fill state
 * and lets `setup/simulate.ts` count.
 *
 * WHY GAPS ARE NOT FVGs
 * A fair value gap is a three-bar imbalance where the middle bar's move left
 * an untraded window BETWEEN two bars' wicks. This is a two-bar discontinuity
 * where trading stopped entirely. `zones.ts` owns the first; the second is a
 * different event with a different cause and deserves its own record.
 */

import { atr, squeeze } from "../chart/indicators";
import { clamp01, px, type Detection, type DetectInput } from "./types";

export interface SqueezeOptions {
  /** Bollinger/Keltner period. */
  period?: number;
  bbMult?: number;
  kcMult?: number;
  /** Releases returned, newest first. */
  maxReleases?: number;
  /** Bars of history to scan for releases. */
  lookback?: number;
  /** A release must have been compressed for at least this many bars. */
  minSqueezeBars?: number;
}

const SQ_DEFAULTS = {
  period: 20,
  bbMult: 2,
  kcMult: 1.5,
  maxReleases: 4,
  lookback: 500,
  minSqueezeBars: 5,
};

export function detectSqueeze(
  data: DetectInput,
  opts: SqueezeOptions = {},
  len = data.c.length,
): Detection[] {
  const period = opts.period ?? SQ_DEFAULTS.period;
  const maxReleases = opts.maxReleases ?? SQ_DEFAULTS.maxReleases;
  const lookback = opts.lookback ?? SQ_DEFAULTS.lookback;
  const minBars = opts.minSqueezeBars ?? SQ_DEFAULTS.minSqueezeBars;

  if (len < period * 3) return [];

  const sq = squeeze(
    data.h,
    data.l,
    data.c,
    period,
    opts.bbMult ?? SQ_DEFAULTS.bbMult,
    opts.kcMult ?? SQ_DEFAULTS.kcMult,
    len,
  );
  const a = atr(data.h, data.l, data.c, 14, len);

  const out: Detection[] = [];
  const releases: Detection[] = [];

  const from = Math.max(period, len - lookback);
  let runStart = -1;

  for (let i = from; i < len; i++) {
    const on = sq[i] === 1;
    const prevOn = sq[i - 1] === 1;

    if (on && !prevOn) runStart = i;

    if (!on && prevOn && runStart >= 0) {
      const bars = i - runStart;
      if (bars >= minBars) {
        /* Direction is the bar that broke the compression, full stop. The
           indicator says "the range stopped being small"; it says nothing
           about which way, and neither does this. */
        const o = data.o[i] as number;
        const c = data.c[i] as number;
        const up = c > o;
        const move = Math.abs(c - o) / ((a[i] as number) || 1);
        releases.push({
          id: `squeeze-release-${i}`,
          kind: "squeeze",
          label: `Squeeze release ${up ? "up" : "down"}`,
          direction: up ? "long" : "short",
          from: runStart,
          to: i,
          confidence: clamp01(0.35 + 0.25 * clamp01(bars / (period * 2)) + 0.3 * clamp01(move / 2)),
          reason:
            `Bollinger bands sat inside the Keltner channel for ${bars} bars, then this bar closed ` +
            `${up ? "up" : "down"} ${move.toFixed(1)} ATR and the compression ended. The side is the ` +
            `one price took — the squeeze itself predicts nothing about direction.`,
          shapes: [
            {
              type: "box",
              x0: runStart,
              x1: i,
              y0: minLow(data, runStart, i),
              y1: maxHigh(data, runStart, i),
              tone: "neutral",
              dashed: true,
              label: `${bars}-bar squeeze`,
            },
            {
              type: "marker",
              x: i,
              y: up ? (data.l[i] as number) : (data.h[i] as number),
              tone: up ? "bull" : "bear",
              text: "release",
              above: up,
            },
          ],
        });
      }
      runStart = -1;
    }
  }

  /* The live squeeze, if one is running: state, so it is drawn and given no
     side. Reported separately from the releases above so that a compression
     that has not resolved never enters a directional record. */
  if (sq[len - 1] === 1 && runStart >= 0 && len - 1 - runStart >= minBars) {
    const bars = len - 1 - runStart;
    out.push({
      id: `squeeze-live-${runStart}`,
      kind: "squeeze",
      label: "In a squeeze",
      direction: "neutral",
      from: runStart,
      to: len - 1,
      confidence: clamp01(0.3 + 0.4 * clamp01(bars / (period * 2))),
      reason:
        `${bars} bars with the Bollinger bands inside the Keltner channel and still compressed. ` +
        `This is a description of what has happened, not a forecast: it says the range is small, ` +
        `not which way it opens up.`,
      shapes: [
        {
          type: "box",
          x0: runStart,
          x1: len - 1,
          y0: minLow(data, runStart, len - 1),
          y1: maxHigh(data, runStart, len - 1),
          tone: "accent",
          dashed: true,
          extend: true,
          label: `${bars}-bar squeeze`,
        },
      ],
    });
  }

  releases.sort((x, y) => y.to - x.to);
  out.push(...releases.slice(0, maxReleases));
  out.sort((x, y) => x.to - y.to);
  return out;
}

function minLow(data: DetectInput, from: number, to: number): number {
  let v = Infinity;
  for (let i = from; i <= to; i++) v = Math.min(v, data.l[i] as number);
  return v;
}

function maxHigh(data: DetectInput, from: number, to: number): number {
  let v = -Infinity;
  for (let i = from; i <= to; i++) v = Math.max(v, data.h[i] as number);
  return v;
}

export interface GapOptions {
  /** A gap must be at least this multiple of ATR to be worth marking. */
  minAtr?: number;
  /** Bars of history to scan. */
  lookback?: number;
  /** Gaps returned, newest first. */
  maxResults?: number;
}

const GAP_DEFAULTS = { minAtr: 0.5, lookback: 500, maxResults: 6 };

export function detectGaps(
  data: DetectInput,
  opts: GapOptions = {},
  len = data.c.length,
): Detection[] {
  const minAtr = opts.minAtr ?? GAP_DEFAULTS.minAtr;
  const lookback = opts.lookback ?? GAP_DEFAULTS.lookback;
  const maxResults = opts.maxResults ?? GAP_DEFAULTS.maxResults;
  if (len < 30) return [];

  const a = atr(data.h, data.l, data.c, 14, len);
  const found: Detection[] = [];

  for (let i = Math.max(1, len - lookback); i < len; i++) {
    const prevHigh = data.h[i - 1] as number;
    const prevLow = data.l[i - 1] as number;
    const lo = data.l[i] as number;
    const hi = data.h[i] as number;
    const unit = a[i] as number;
    if (!Number.isFinite(unit) || unit <= 0) continue;

    const up = lo > prevHigh;
    const down = hi < prevLow;
    if (!up && !down) continue;

    const edgeNear = up ? prevHigh : prevLow;
    const edgeFar = up ? lo : hi;
    const size = Math.abs(edgeFar - edgeNear);
    if (size < unit * minAtr) continue;

    /* Filled means price traded back to the near edge — the previous bar's
       extreme — not merely into the window. A gap partially entered is still
       an open gap, and treating it as filled would flatter the fill rate. */
    let filledAt = -1;
    for (let j = i + 1; j < len; j++) {
      const jl = data.l[j] as number;
      const jh = data.h[j] as number;
      if (up ? jl <= edgeNear : jh >= edgeNear) {
        filledAt = j;
        break;
      }
    }

    found.push({
      id: `gap-${i}`,
      kind: "gap",
      /* The side is the direction the gap OPENED, which is the only fact here.
         "Gaps get filled" would make this short on an up gap; that is the
         claim under test, not an input to it. */
      label: `Gap ${up ? "up" : "down"}`,
      direction: up ? "long" : "short",
      from: i - 1,
      to: i,
      confidence: clamp01(0.35 + 0.35 * clamp01(size / (unit * 3))),
      reason:
        `Price was never offered between ${px(Math.min(edgeNear, edgeFar))} and ` +
        `${px(Math.max(edgeNear, edgeFar))} — a ${(size / unit).toFixed(1)} ATR discontinuity. ` +
        (filledAt >= 0
          ? `Filled ${filledAt - i} bars later.`
          : `Still open ${len - 1 - i} bars later.`),
      shapes: [
        {
          type: "box",
          x0: i - 0.5,
          x1: filledAt >= 0 ? filledAt : len - 1,
          y0: Math.min(edgeNear, edgeFar),
          y1: Math.max(edgeNear, edgeFar),
          tone: up ? "bull" : "bear",
          dashed: filledAt >= 0,
          extend: filledAt < 0,
          label: filledAt >= 0 ? "gap (filled)" : "gap",
        },
      ],
    });
  }

  found.sort((x, y) => y.to - x.to);
  return found.slice(0, maxResults).sort((x, y) => x.to - y.to);
}
