/**
 * Harmonic patterns — five pivots and a table of ratios.
 *
 * WHY THIS IS IN THE REPOSITORY AT ALL, STATED PLAINLY
 * There is no mechanism here. A Gartley is the assertion that a retracement of
 * 0.618 followed by an extension of 1.27 and a completion at 0.786 of the
 * first leg means something, and nobody has ever offered a reason why those
 * numbers rather than neighbouring ones. It is the most numerological thing
 * this terminal detects.
 *
 * It is here because it is CHEAP and FALSIFIABLE. `pivots.ts` already produces
 * the confirmed alternating swings; the whole detector is four ratio tests
 * over the last five of them. And `setup/simulate.ts` will hold it to exactly
 * the same standard as break-of-structure: how did this actually do, here, on
 * this instrument. A pattern with no mechanism and a positive record is worth
 * more than a pattern with a beautiful story and a flat one.
 *
 * The expectation, stated in advance so it cannot be revised afterwards, is
 * that these come back at break-even like everything else. If they do, the
 * detector stays off by default and the record is the reason.
 *
 * THE COMPLETION IS THE EVENT
 * A harmonic is published when the D pivot CONFIRMS — not when price enters
 * the D zone, and certainly not as a projection of where D might land. A
 * projected D is a forecast, and a forecast published as a detection would
 * contaminate every record it touched.
 */

import { atr } from "../chart/indicators";
import { alternate, findPivots, swingFloor, type Pivot } from "./pivots";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";

export interface HarmonicOptions {
  /** Fractional slack on every ratio test. */
  tolerance?: number;
  /** Patterns returned, newest first. */
  maxResults?: number;
  /** Bars of history to search. */
  lookback?: number;
}

const DEFAULTS = { tolerance: 0.12, maxResults: 3, lookback: 500 };

/** A ratio band, inclusive. `[x, x]` with tolerance is a point target. */
type Band = readonly [number, number];

interface Template {
  readonly name: string;
  /** AB as a share of XA. */
  readonly ab: Band;
  /** BC as a share of AB. */
  readonly bc: Band;
  /** CD as a share of BC. */
  readonly cd: Band;
  /** AD as a share of XA — the completion, and the one that names the shape. */
  readonly ad: Band;
}

/**
 * The four that are actually distinguishable.
 *
 * Shark, cypher and the rest sit inside these bands once tolerance is applied,
 * so publishing them would be publishing the same detection under several
 * names and splitting one record into four unmeasurable ones.
 */
export const TEMPLATES: readonly Template[] = [
  { name: "Gartley", ab: [0.618, 0.618], bc: [0.382, 0.886], cd: [1.13, 1.618], ad: [0.786, 0.786] },
  { name: "Bat", ab: [0.382, 0.5], bc: [0.382, 0.886], cd: [1.618, 2.618], ad: [0.886, 0.886] },
  { name: "Butterfly", ab: [0.786, 0.786], bc: [0.382, 0.886], cd: [1.618, 2.24], ad: [1.27, 1.618] },
  { name: "Crab", ab: [0.382, 0.618], bc: [0.382, 0.886], cd: [2.24, 3.618], ad: [1.618, 1.618] },
];

/** Is `v` inside the band, once `tol` slack is allowed either side? */
export function within(v: number, band: Band, tol: number): boolean {
  const [lo, hi] = band;
  return v >= lo * (1 - tol) && v <= hi * (1 + tol);
}

/** How centred `v` is in the band — 1 at the middle, 0 at the slack edge. */
function fit(v: number, band: Band, tol: number): number {
  const [lo, hi] = band;
  const min = lo * (1 - tol);
  const max = hi * (1 + tol);
  if (max <= min) return 0;
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  return clamp01(1 - Math.abs(v - mid) / half);
}

export function detectHarmonics(
  data: DetectInput,
  opts: HarmonicOptions = {},
  len = data.c.length,
): Detection[] {
  const tol = opts.tolerance ?? DEFAULTS.tolerance;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  if (len < 60) return [];

  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len),
  ).filter((p) => p.confirmedAt <= len - 1 && p.index >= len - lookback);

  if (pivots.length < 5) return [];

  const a14 = atr(data.h, data.l, data.c, 14, len);
  const out: Detection[] = [];

  /* Every consecutive run of five alternating pivots. Consecutive matters: a
     five-pivot pattern with a swing skipped in the middle is a different
     shape that happens to share four points. */
  for (let i = 0; i + 4 < pivots.length; i++) {
    const X = pivots[i] as Pivot;
    const A = pivots[i + 1] as Pivot;
    const B = pivots[i + 2] as Pivot;
    const C = pivots[i + 3] as Pivot;
    const D = pivots[i + 4] as Pivot;

    const xa = A.price - X.price;
    const ab = B.price - A.price;
    const bc = C.price - B.price;
    const cd = D.price - C.price;
    const ad = D.price - A.price;
    if (xa === 0 || ab === 0 || bc === 0) continue;

    /* Alternation must hold in SIGN, not just in pivot kind: a legal
       high/low/high/low/high run can still trace a staircase rather than a
       zig-zag if two consecutive legs move the same way. */
    if (Math.sign(ab) === Math.sign(xa)) continue;
    if (Math.sign(bc) === Math.sign(ab)) continue;
    if (Math.sign(cd) === Math.sign(bc)) continue;

    const rAB = Math.abs(ab / xa);
    const rBC = Math.abs(bc / ab);
    const rCD = Math.abs(cd / bc);
    const rAD = Math.abs(ad / xa);

    for (const t of TEMPLATES) {
      if (!within(rAB, t.ab, tol)) continue;
      if (!within(rBC, t.bc, tol)) continue;
      if (!within(rCD, t.cd, tol)) continue;
      if (!within(rAD, t.ad, tol)) continue;

      /* Bullish when D is a low: the completion is a buy point. */
      const bullish = D.kind === "low";
      const quality =
        (fit(rAB, t.ab, tol) + fit(rBC, t.bc, tol) + fit(rCD, t.cd, tol) + fit(rAD, t.ad, tol)) / 4;
      const unit = (a14[D.index] as number) || 1;
      const legAtr = Math.abs(xa) / unit;

      const shapes: Shape[] = [
        { type: "line", x0: X.index, y0: X.price, x1: A.index, y1: A.price, tone: "neutral" },
        { type: "line", x0: A.index, y0: A.price, x1: B.index, y1: B.price, tone: "neutral" },
        { type: "line", x0: B.index, y0: B.price, x1: C.index, y1: C.price, tone: "neutral" },
        {
          type: "line",
          x0: C.index,
          y0: C.price,
          x1: D.index,
          y1: D.price,
          tone: bullish ? "bull" : "bear",
          label: t.name,
        },
        {
          type: "marker",
          x: D.index,
          y: D.price,
          tone: bullish ? "bull" : "bear",
          text: "D",
          above: !bullish,
        },
      ];

      out.push({
        id: `harmonic-${t.name}-${D.index}`,
        kind: "harmonic",
        label: `${bullish ? "Bullish" : "Bearish"} ${t.name}`,
        direction: bullish ? "long" : "short",
        from: X.index,
        /* The pivot's own confirmation bar, not its index. D is not knowable
           until its right-hand bars have closed, and dating the pattern at the
           extreme would let the simulator enter before it existed. */
        to: D.confirmedAt,
        confidence: clamp01(0.25 + 0.4 * quality + 0.15 * clamp01(legAtr / 10)),
        reason:
          `Five confirmed swings matching ${t.name} within ${(tol * 100).toFixed(0)}%: ` +
          `AB/XA ${rAB.toFixed(3)}, BC/AB ${rBC.toFixed(3)}, CD/BC ${rCD.toFixed(3)}, ` +
          `AD/XA ${rAD.toFixed(3)}. D completes at ${px(D.price)}. ` +
          `These ratios have no mechanism behind them — the record is the only argument for trading it.`,
        shapes,
      });
      break;
    }
  }

  out.sort((x, y) => y.to - x.to);
  return out.slice(0, maxResults).sort((x, y) => x.to - y.to);
}
