/**
 * Zone detectors: fair value gaps and order blocks.
 *
 * Both describe an area price left behind in a hurry and may return to. The
 * shared discipline here is MITIGATION: a zone that price has already traded
 * back through has done its job and must stop being drawn as if it were still
 * live. A chart carrying every gap ever created is noise, and worse, it implies
 * a level is untested when it was filled fifty bars ago.
 */

import { clamp01, px, type Detection, type DetectInput } from "./types";
import { noiseShare } from "./pivots";
import { bodyShares, gapShares, quantile, saturate } from "./calibrate";
import { atr } from "../chart/indicators";

export interface ZoneOptions {
  /** Ignore gaps smaller than this share of price. */
  minSize?: number;
  /** Drop zones already traded through. */
  hideMitigated?: boolean;
  maxZones?: number;
}

/**
 * Fair value gap: a three-bar imbalance where bar 1 and bar 3 do not overlap,
 * leaving a band of prices that bar 2 traded through without trading in.
 *
 * Bullish FVG: low[i] > high[i-2]  — a gap ABOVE the earlier bar.
 * Bearish FVG: high[i] < low[i-2]  — a gap BELOW it.
 */
/**
 * Thresholds, in multiples of the series' own typical bar range.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THEY WERE SHARES OF PRICE, AND THAT IS WHY THESE DETECTORS WERE DEAD.
 *
 * `displacement` was `0.012` — a single candle closing 1.2% from its open. It
 * is a plausible-looking number and it describes no market on a minute chart.
 * Measured: the typical bar range is 0.038% of price on XAUUSD 1m and 0.055%
 * on BTCUSDT 1m, so that threshold asked for a bar **32×** and **22×** normal
 * respectively. Order blocks returned zero on both instruments, on every load,
 * and so did breaker blocks — `detectBreakers` is built entirely on top of
 * them, so one unreachable constant silently disabled two detectors.
 *
 * `minSize` for fair value gaps had the milder version of the same problem:
 * 0.1% of price is 2.6 bar-ranges of gold and 1.8 of Bitcoin, so the same
 * setting meant two different things depending on what you were looking at.
 *
 * The multiples below are calibrated on live series rather than chosen: see
 * `SWING_NOISE_MULTIPLE` in detect/formations.ts for the same fix and the
 * pivot-count table that set its value.
 */

/** A displacement candle: this many times a normal bar's range, open to close. */
export const DISPLACEMENT_NOISE_MULTIPLE = 3;
/** Used only when the series is too short or too flat to measure. */
export const DISPLACEMENT_FALLBACK = 0.012;

/** A fair value gap worth drawing: this many times a normal bar's range. */
export const FVG_NOISE_MULTIPLE = 1.5;
export const FVG_FALLBACK = 0.001;

/* ────────────────────────────────────────────────────────────────────────────
 * AND WHY THE MULTIPLES ABOVE ARE NOW ONLY THE FLOOR
 *
 * Calibrating against the mean bar range fixed the instrument problem and left
 * the timeframe one. Measured on 537 hourly bars of XAUUSD, where the mean bar
 * range is 0.438% of price:
 *
 *   x3 displacement threshold      1.313%
 *   largest body in the sample     1.699%
 *   99th percentile of bodies      0.931%
 *
 * The threshold sat ABOVE the 99th percentile of the very distribution it was
 * filtering. Order blocks: 0. Breaker blocks, which are built on them: 0. At a
 * quantile of the same distribution the count is 7-8, which is what an hourly
 * gold chart should have.
 *
 * So both thresholds are now stated as "in the top N% of what this series
 * actually did", with the noise multiple retained as a floor beneath the
 * quantile. The rank places the cut; the floor stops a flat series handing its
 * largest wiggle to the detector as a displacement.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A displacement candle is one in the top decile of bodies for this series.
 *
 * Chosen from the count it produces, not from the round number: p90 gives 8
 * order blocks over 537 hourly bars and 6 over 800 minute bars, which is the
 * density at which they mark something and do not paper the chart.
 */
export const DISPLACEMENT_QUANTILE = 0.9;

/**
 * A gap worth marking is in the top quarter of the gaps this series left.
 *
 * Deliberately gentler than the displacement cut. A fair value gap is already
 * a rare event — 111 of 537 hourly bars left one at all — so the quantile is
 * taken over the gaps that EXIST rather than over every bar, and a quarter of
 * a rare event is still selective. See `gapShares` for why the zeroes are
 * excluded rather than counted.
 */
export const FVG_QUANTILE = 0.75;

/** The displacement threshold for this series, as a share of price. */
function displacementFloor(data: DetectInput, len: number): number {
  const noise = noiseShare(data.h, data.l, data.c, len);
  const bodies = bodyShares(data.o, data.c, len);
  const rank = bodies.length >= 20 ? quantile(bodies, DISPLACEMENT_QUANTILE) : 0;
  const floor = noise > 0 ? noise : DISPLACEMENT_FALLBACK;
  return Math.max(rank, floor);
}

/** The fair-value-gap threshold for this series, as a share of price. */
function fvgFloor(data: DetectInput, len: number): number {
  const noise = noiseShare(data.h, data.l, data.c, len);
  const gaps = gapShares(data.h, data.l, data.c, len);
  const rank = gaps.length >= 12 ? quantile(gaps, FVG_QUANTILE) : 0;
  const floor = noise > 0 ? noise * 0.25 : FVG_FALLBACK;
  return Math.max(rank, floor);
}

export function detectFVG(
  data: DetectInput,
  opts: ZoneOptions = {},
  len = data.c.length,
): Detection[] {
  const minSize = opts.minSize ?? fvgFloor(data, len);
  const hideMitigated = opts.hideMitigated ?? true;
  const maxZones = opts.maxZones ?? 12;

  /* The local unit every confidence below is measured in. */
  const a = atr(data.h, data.l, data.c, 14, len);

  const out: Detection[] = [];

  for (let i = 2; i < len; i++) {
    const prevHigh = data.h[i - 2] as number;
    const prevLow = data.l[i - 2] as number;
    const curHigh = data.h[i] as number;
    const curLow = data.l[i] as number;
    const mid = data.c[i - 1] as number;
    if (!Number.isFinite(mid) || mid <= 0) continue;

    let bullish: boolean;
    let top: number;
    let bottom: number;

    if (curLow > prevHigh) {
      bullish = true;
      bottom = prevHigh;
      top = curLow;
    } else if (curHigh < prevLow) {
      bullish = false;
      bottom = curHigh;
      top = prevLow;
    } else {
      continue;
    }

    const size = (top - bottom) / mid;
    if (size < minSize) continue;

    // Mitigation: has any LATER bar traded back into the band? Checked with the
    // bar's full range, because a wick into the zone is a touch even if the
    // body never got there.
    let mitigatedAt = -1;
    for (let j = i + 1; j < len; j++) {
      const h = data.h[j] as number;
      const l = data.l[j] as number;
      if (l <= top && h >= bottom) {
        mitigatedAt = j;
        break;
      }
    }
    if (hideMitigated && mitigatedAt >= 0) continue;

    /* A bigger gap is more meaningful, and the relationship flattens out — a
       5% gap is not five times as significant as a 1% one.

       Was `sqrt(size / 0.02) * 0.35`, a share of PRICE, which is the exact
       mistake the header of this file describes for the thresholds. Measured
       live at 1h: gold's fair value gaps averaged 0.46 and Ethereum's 0.72,
       for no reason but that Ethereum moves more. Same gap in ATR now reads
       the same on both, and the term cannot reach 1. */
    const unit = a[i] as number;
    const gapAtr = unit > 0 ? (top - bottom) / unit : 0;
    const confidence = clamp01(0.3 + 0.45 * saturate(gapAtr, 0.75));

    out.push({
      id: `fvg-${bullish ? "b" : "s"}-${i}`,
      kind: "fvg",
      label: bullish ? "Bullish FVG" : "Bearish FVG",
      direction: bullish ? "long" : "short",
      from: i - 2,
      to: i,
      confidence,
      reason:
        `three-bar imbalance: bar ${i} ${bullish ? "low" : "high"} ${px(bullish ? curLow : curHigh)} ` +
        `did not overlap bar ${i - 2} ${bullish ? "high" : "low"} ${px(bullish ? prevHigh : prevLow)}, ` +
        `leaving ${px(bottom)}–${px(top)} (${(size * 100).toFixed(2)}% of price) untraded` +
        (mitigatedAt >= 0 ? ` — already mitigated at bar ${mitigatedAt}` : " — unmitigated"),
      shapes: [
        {
          type: "box",
          x0: i - 2,
          x1: i,
          y0: bottom,
          y1: top,
          tone: bullish ? "bull" : "bear",
          extend: mitigatedAt < 0,
          label: bullish ? "FVG" : "FVG",
        },
      ],
    });
  }

  // Keep the most recent: an unmitigated gap 400 bars back is real but is not
  // what anyone is trading off today.
  return out.slice(-maxZones);
}

/**
 * Order block: the last opposing candle before a displacement move.
 *
 * The idea is that the last down-close before a decisive rally is where the
 * buying that caused the rally was absorbed. Whether or not one believes the
 * narrative, the mechanical definition is precise and testable, which is what
 * matters here — it is detected by rule, not by eye.
 */
export function detectOrderBlocks(
  data: DetectInput,
  opts: ZoneOptions & { displacement?: number; lookback?: number } = {},
  len = data.c.length,
): Detection[] {
  const displacement = opts.displacement ?? displacementFloor(data, len);
  const hideMitigated = opts.hideMitigated ?? true;
  const maxZones = opts.maxZones ?? 8;
  const lookback = opts.lookback ?? 3;
  const ao = atr(data.h, data.l, data.c, 14, len);

  // Keyed by the BLOCK candle, not by the displacement bar. Consecutive
  // displacement bars often point back at the same block; without this, one
  // zone is detected twice, drawn twice, and listed twice with a colliding id.
  // The stronger displacement wins, because that is the one that defines it.
  const byBlock = new Map<number, Detection>();

  for (let i = 1; i < len; i++) {
    const open = data.o[i] as number;
    const close = data.c[i] as number;
    if (!Number.isFinite(open) || open <= 0) continue;

    const move = (close - open) / open;
    if (Math.abs(move) < displacement) continue;
    const bullish = move > 0;

    // Walk back for the last candle that closed AGAINST the displacement.
    let blockIndex = -1;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      const o = data.o[j] as number;
      const c = data.c[j] as number;
      if (bullish ? c < o : c > o) {
        blockIndex = j;
        break;
      }
    }
    if (blockIndex < 0) continue;

    const top = data.h[blockIndex] as number;
    const bottom = data.l[blockIndex] as number;

    let mitigatedAt = -1;
    for (let j = i + 1; j < len; j++) {
      const h = data.h[j] as number;
      const l = data.l[j] as number;
      if (l <= top && h >= bottom) {
        mitigatedAt = j;
        break;
      }
    }
    if (hideMitigated && mitigatedAt >= 0) continue;

    /* Displacement in ATR, saturating. Was `abs(move) / 0.05` — a share of
       price, unbounded, and pegged at 1.00 on any move past 5%. */
    const unitOb = ao[i] as number;
    const moveAtr = unitOb > 0 ? (Math.abs(move) * (data.c[i] as number)) / unitOb : 0;
    const confidence = clamp01(0.3 + 0.45 * saturate(moveAtr, 2));

    const existing = byBlock.get(blockIndex);
    if (existing && existing.confidence >= confidence) continue;

    byBlock.set(blockIndex, {
      id: `ob-${bullish ? "b" : "s"}-${blockIndex}`,
      kind: "order-block",
      label: bullish ? "Bullish order block" : "Bearish order block",
      direction: bullish ? "long" : "short",
      from: blockIndex,
      to: i,
      confidence,
      reason:
        `bar ${i} displaced ${(move * 100).toFixed(2)}%; bar ${blockIndex} was the last ` +
        `${bullish ? "down" : "up"} close before it, range ${px(bottom)}–${px(top)}` +
        (mitigatedAt >= 0 ? ` — mitigated at bar ${mitigatedAt}` : " — unmitigated"),
      shapes: [
        {
          type: "box",
          x0: blockIndex,
          x1: i,
          y0: bottom,
          y1: top,
          tone: bullish ? "bull" : "bear",
          extend: mitigatedAt < 0,
          dashed: true,
          label: "OB",
        },
      ],
    });
  }

  return [...byBlock.values()].sort((a, b) => a.to - b.to).slice(-maxZones);
}
