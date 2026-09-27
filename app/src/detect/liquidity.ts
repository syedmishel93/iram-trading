/**
 * Liquidity — the pools, the raids on them, and the blocks that failed.
 *
 * WHY THESE THREE AND NOT A LONGER LIST
 * The eight detectors that came before find STRUCTURE: where price turned,
 * where it gapped, where it left a block behind. None of them finds the thing
 * that most often causes the turn — a run at an obvious level, followed by a
 * refusal to hold beyond it.
 *
 * That matters more than another pattern would, because a sweep is the only
 * one of these that comes with its own invalidation already attached. A double
 * top tells you a level held; it does not tell you where you are wrong. A
 * sweep does: one tick beyond the extreme that was just rejected. Every other
 * entry in this terminal has to derive a stop from ATR or from the nearest
 * swing, and this one has the stop built into the pattern.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT KEEPS THIS HONEST
 *
 * A sweep is only a sweep after the CLOSE comes back. Wick beyond the level,
 * close back inside — both, on bars that have finished. An implementation that
 * fires on the wick alone is reading a bar that is still forming, and it will
 * print a sweep on every live candle that pokes a high and then un-print it
 * seconds later. Worse, a backtest built on that is reading the future.
 *
 * `detect/pivots.ts` makes the same point at length about confirmation lag,
 * and everything here obeys it: pools are built from CONFIRMED pivots only,
 * and a raid is dated to the bar that closed back inside, never to the bar
 * that made the extreme.
 * ──────────────────────────────────────────────────────────────────────────── */

import { findPivots, type Pivot } from "./pivots";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";
import { saturate } from "./calibrate";

export interface LiquidityOptions {
  /** Pivot lookback either side. Passed through to `findPivots`. */
  swing?: number;
  /**
   * How close two pivots must be to count as "equal", as a share of price.
   *
   * Not zero, and not a fixed number of ticks. Two highs a hundredth of a
   * percent apart are the same level to everyone watching, and the stops sit
   * above both. A tick-exact test would find almost nothing.
   */
  equalTolerance?: number;
  /** Ignore pools older than this many bars. */
  lookback?: number;
  maxResults?: number;
  /** Minimum wick beyond the level, as a share of price, for a raid to count. */
  minPenetration?: number;
}

const DEFAULTS = {
  swing: 3,
  equalTolerance: 0.0008,
  lookback: 400,
  maxResults: 6,
  minPenetration: 0.0002,
};

export interface LiquidityPool {
  readonly kind: "high" | "low";
  readonly price: number;
  /** Pivots that formed the pool, oldest first. */
  readonly at: readonly number[];
  /** When the last of them was knowable. */
  readonly confirmedAt: number;
}

/**
 * Equal highs and equal lows — the pools a raid runs at.
 *
 * WHY THEY ARE WORTH DRAWING ON THEIR OWN
 * Two highs at the same price are where stops accumulate, and that is a fact
 * about order flow rather than about shape. `detectLevels` already clusters
 * swings into support and resistance, but it clusters ALL of them and reports
 * a zone; this reports the specific case of two-or-more touches at effectively
 * one price, which is the case that behaves differently.
 *
 * A pool is REMOVED once price has closed decisively through it: the stops are
 * gone, and a level that has already been cleared is not liquidity any more.
 */
export function findPools(
  data: DetectInput,
  opts: LiquidityOptions = {},
  len = data.c.length,
): LiquidityPool[] {
  const swing = opts.swing ?? DEFAULTS.swing;
  const tol = opts.equalTolerance ?? DEFAULTS.equalTolerance;
  const lookback = opts.lookback ?? DEFAULTS.lookback;

  /**
   * RAW pivots, not `alternate`d ones — and this is a real distinction, not a
   * shortcut.
   *
   * `alternate` collapses a run of same-kind pivots to the most extreme one,
   * which is exactly right for structure logic: the lower high inside a run of
   * highs is not a swing, it is noise within one leg. It is exactly WRONG here.
   * Two highs at the same price are a pool BECAUSE there are two of them, and
   * the function whose job is to discard all but the highest would throw the
   * pool away before it could be found. Measured: with `alternate` in place,
   * every equal-high pair collapsed to one pivot and this detector reported
   * nothing at all on a fixture built to contain one.
   *
   * The same argument applies to sweeps below. A prior low that was never the
   * deepest still has stops resting under it, and can still be raided.
   */
  const pivots = findPivots(data.h, data.l, { left: swing, right: swing }, len);
  const from = Math.max(0, len - lookback);

  const pools: LiquidityPool[] = [];
  for (const kind of ["high", "low"] as const) {
    const of = pivots.filter((p) => p.kind === kind && p.index >= from);
    const used = new Set<number>();

    for (let i = 0; i < of.length; i++) {
      if (used.has(i)) continue;
      const seed = of[i] as Pivot;
      const group: Pivot[] = [seed];
      for (let j = i + 1; j < of.length; j++) {
        if (used.has(j)) continue;
        const other = of[j] as Pivot;
        if (Math.abs(other.price - seed.price) / seed.price <= tol) {
          group.push(other);
          used.add(j);
        }
      }
      if (group.length < 2) continue;
      used.add(i);

      /* The pool sits at the EXTREME of the touches, not their mean. Stops are
         placed beyond the highest high, and an average would put the level
         inside the range where nothing is resting. */
      const price =
        kind === "high"
          ? Math.max(...group.map((p) => p.price))
          : Math.min(...group.map((p) => p.price));

      /* Already cleared: a close decisively through the pool means the stops
         behind it are gone and it is no longer liquidity. */
      const last = Math.max(...group.map((p) => p.confirmedAt));
      let cleared = false;
      for (let b = last + 1; b < len; b++) {
        const c = data.c[b] as number;
        if (kind === "high" ? c > price * (1 + tol) : c < price * (1 - tol)) {
          cleared = true;
          break;
        }
      }
      if (cleared) continue;

      pools.push({
        kind,
        price,
        at: group.map((p) => p.index).sort((a, b) => a - b),
        confirmedAt: last,
      });
    }
  }
  return pools.sort((a, b) => a.confirmedAt - b.confirmedAt);
}

/**
 * Equal highs and lows, as detections.
 *
 * Confidence is the number of touches and how tightly they agree — both
 * measurable, neither a guess. Three touches within a hundredth of a percent
 * is a more obvious pool than two touches within eight hundredths, and the
 * figure says so.
 */
export function detectPools(
  data: DetectInput,
  opts: LiquidityOptions = {},
  len = data.c.length,
): Detection[] {
  const tol = opts.equalTolerance ?? DEFAULTS.equalTolerance;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  const pools = findPools(data, opts, len);

  const out = pools.map((pool): Detection => {
    const first = pool.at[0] as number;
    const lastTouch = pool.at[pool.at.length - 1] as number;
    const spread =
      pool.at.length < 2
        ? 0
        : Math.abs(
            (pool.kind === "high"
              ? Math.min(...pool.at.map((i) => data.h[i] as number))
              : Math.max(...pool.at.map((i) => data.l[i] as number))) - pool.price,
          ) / pool.price;

    const tightness = clamp01(1 - spread / Math.max(tol, 1e-9));
    /* Was `clamp01((pool.at.length - 2) / 2)` with weights summing to exactly
       1.00, so a tight four-touch pool reported certainty. Saturating, and the
       weights now stop short of 1 — see detect/calibrate.ts. */
    const touches = saturate(pool.at.length - 2, 2);
    const confidence = clamp01(0.4 + 0.25 * tightness + 0.3 * touches);

    const shapes: Shape[] = [
      {
        type: "level",
        x0: first,
        y: pool.price,
        tone: "accent",
        dashed: true,
        label: pool.kind === "high" ? "EQH" : "EQL",
      },
    ];

    return {
      id: `pool-${pool.kind}-${first}-${lastTouch}`,
      kind: pool.kind === "high" ? "equal-highs" : "equal-lows",
      label: pool.kind === "high" ? "Equal highs" : "Equal lows",
      /* Neutral, and deliberately. A pool of stops above the market is not a
         short signal — it is a magnet, and price reaching it is the ordinary
         outcome. Which way it resolves is what `detectSweeps` answers. */
      direction: "neutral",
      from: first,
      to: lastTouch,
      confidence,
      reason: `${pool.at.length} touches within ${(spread * 100).toFixed(3)}% at ${px(pool.price)} — resting orders sit ${pool.kind === "high" ? "above" : "below"}`,
      shapes,
    };
  });

  return out.slice(-maxResults);
}

/**
 * The raid: price takes a pool out and closes back inside.
 *
 * WHAT MAKES IT A DETECTION RATHER THAN A COINCIDENCE
 * Three things, all measured on closed bars:
 *
 *  1. The wick goes BEYOND the pool by at least `minPenetration`. A high that
 *     stops a tick short of the level swept nothing.
 *  2. The CLOSE comes back inside. This is the whole pattern — it is the
 *     difference between a raid and a breakout, and it is why the detection is
 *     dated to the closing bar rather than to the extreme.
 *  3. It happens within a few bars. Price grinding above a level for twenty
 *     bars and eventually slipping back is not a raid on anything; it is a
 *     failed breakout, and `detectRanges` has a better name for it.
 */
export function detectSweeps(
  data: DetectInput,
  opts: LiquidityOptions & { reclaimWithin?: number } = {},
  len = data.c.length,
): Detection[] {
  const minPen = opts.minPenetration ?? DEFAULTS.minPenetration;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  const reclaimWithin = opts.reclaimWithin ?? 3;
  const tol = opts.equalTolerance ?? DEFAULTS.equalTolerance;
  const swing = opts.swing ?? DEFAULTS.swing;
  const lookback = opts.lookback ?? DEFAULTS.lookback;

  /* Every confirmed pivot is a candidate level, not only the equal-high pools:
     a single obvious swing high has stops above it too, and requiring two
     touches would miss most real raids. Raw rather than alternated, for the
     reason set out in `findPools`. */
  const pivots = findPivots(data.h, data.l, { left: swing, right: swing }, len);
  const from = Math.max(0, len - lookback);

  const out: Detection[] = [];

  for (const pivot of pivots) {
    if (pivot.index < from) continue;

    for (let i = pivot.confirmedAt + 1; i < len; i++) {
      const high = data.h[i] as number;
      const low = data.l[i] as number;
      const close = data.c[i] as number;
      if (!Number.isFinite(close)) continue;

      const isHigh = pivot.kind === "high";
      const penetrated = isHigh
        ? (high - pivot.price) / pivot.price
        : (pivot.price - low) / pivot.price;
      if (penetrated < minPen) continue;

      /* Beyond on the wick. Now: did the close come back, on this bar or
         within the next few? A close that stays beyond is a breakout, and the
         loop stops looking at this pivot entirely — the level is gone. */
      let reclaimAt = -1;
      for (let j = i; j < Math.min(len, i + 1 + reclaimWithin); j++) {
        const cj = data.c[j] as number;
        if (isHigh ? cj < pivot.price : cj > pivot.price) {
          reclaimAt = j;
          break;
        }
      }
      if (reclaimAt < 0) break; // held beyond — a break, not a raid

      /* Depth of the raid and speed of the rejection are both measurable and
         both matter: a deep wick reclaimed on its own bar is the cleanest
         version of this pattern, and a shallow one reclaimed three bars later
         is the weakest. */
      const depth = saturate(penetrated, tol * 4);
      const speed = clamp01(1 - (reclaimAt - i) / (reclaimWithin + 1));
      /* 0.4 + 0.3 + 0.3 was exactly 1.00, and a deep wick reclaimed on its own
         bar hits both maxima — the single most common shape this detector
         finds. It was reporting certainty on its own best case. */
      const confidence = clamp01(0.35 + 0.3 * depth + 0.3 * speed);

      const extreme = isHigh ? high : low;
      const shapes: Shape[] = [
        {
          type: "level",
          x0: pivot.index,
          y: pivot.price,
          tone: isHigh ? "bear" : "bull",
          dashed: true,
          label: "swept",
        },
        {
          type: "box",
          x0: i - 0.4,
          x1: reclaimAt + 0.4,
          y0: Math.min(pivot.price, extreme),
          y1: Math.max(pivot.price, extreme),
          tone: isHigh ? "bear" : "bull",
        },
        {
          type: "marker",
          x: i,
          y: extreme,
          tone: isHigh ? "bear" : "bull",
          text: isHigh ? "SSL" : "BSL",
          above: isHigh,
        },
      ];

      out.push({
        id: `sweep-${pivot.kind}-${pivot.index}-${i}`,
        kind: "liquidity-sweep",
        label: isHigh ? "Sell-side sweep" : "Buy-side sweep",
        /* A raid on highs is a SHORT read and a raid on lows is a LONG one —
           the side that got taken out is the side that is now trapped. */
        direction: isHigh ? "short" : "long",
        from: pivot.index,
        to: reclaimAt,
        confidence,
        reason: `wick ${(penetrated * 100).toFixed(2)}% through ${px(pivot.price)}, closed back inside ${reclaimAt === i ? "on the same bar" : `after ${reclaimAt - i} bar${reclaimAt - i === 1 ? "" : "s"}`} — invalid beyond ${px(extreme)}`,
        shapes,
      });
      break; // one raid per pivot; the level is spent
    }
  }

  return out.slice(-maxResults);
}
