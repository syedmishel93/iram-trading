/**
 * Derived flow metrics — the reads a chart cannot show you.
 *
 * Four things live here, all of them public exchange arithmetic rather than a
 * vendor's proprietary product, and all of them absent from every charting
 * platform this terminal is measured against:
 *
 *   BASIS          how far the perpetual trades from spot, and what that costs
 *                  annualised. The cleanest single measure of leverage demand.
 *   OI/PRICE STATE the four-way read that says WHO is doing the buying —
 *                  new longs, short covering, new shorts, or long liquidation.
 *   DIVERGENCE     funding and price disagreeing, which is what a crowded
 *                  position looks like just before it is not crowded any more.
 *   CLUSTERS       liquidation prints grouped into price shelves, so the
 *                  levels where leverage actually died become levels on the
 *                  chart rather than a scrolling tape you cannot read.
 *
 * Every function is pure, takes what it needs and returns the reasoning with
 * the number. Nothing is synthesised: too little data returns null, and the
 * caller says so rather than showing a confident zero.
 */

import type { FundingPoint, OpenInterestPoint } from "./derivs";
import type { Liquidation } from "./stream";
import type { Shape } from "../detect/types";

const pctStr = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;

// ------------------------------------------------------------------ basis --

export interface Basis {
  /** Perp minus spot, as a fraction of spot. */
  fraction: number;
  /** The same, in basis points. */
  bp: number;
  /**
   * Annualised carry implied by the basis, in percent.
   *
   * A perpetual has no expiry, so this is not a true term structure — it is
   * what the current gap would cost over a year if it never closed. Stated as
   * "implied", never as a yield you can actually harvest.
   */
  annualisedPct: number;
  direction: "long" | "short" | "neutral";
  reason: string;
}

/**
 * Spot-perp basis.
 *
 * `daysToConverge` is the horizon the annualisation assumes. One day is the
 * conventional choice for perpetuals because funding resets three times a day;
 * it makes the number comparable across venues rather than physically true.
 */
export function basis(spot: number, perp: number, daysToConverge = 1): Basis | null {
  if (!(spot > 0) || !(perp > 0) || !Number.isFinite(spot) || !Number.isFinite(perp)) return null;
  const fraction = perp / spot - 1;
  const bp = fraction * 10_000;
  const annualisedPct = (fraction * 365 * 100) / Math.max(daysToConverge, 1e-9);

  // Below a couple of basis points this is exchange microstructure, not
  // positioning. Calling it a signal would be reading noise out loud.
  if (Math.abs(bp) < 2) {
    return {
      fraction,
      bp,
      annualisedPct,
      direction: "neutral",
      reason: `Perp is ${bp.toFixed(1)}bp from spot — inside the noise band, no leverage story here`,
    };
  }

  const rich = fraction > 0;
  return {
    fraction,
    bp,
    annualisedPct,
    // A rich perp means leverage is paying up to be long: crowded, so it leans
    // against. The failure mode is that crowded can stay crowded for months.
    direction: rich ? "short" : "long",
    reason: rich
      ? `Perp trades ${bp.toFixed(1)}bp ABOVE spot (${annualisedPct.toFixed(1)}% annualised) — leverage is paying to be long, which is crowding, not confirmation`
      : `Perp trades ${Math.abs(bp).toFixed(1)}bp BELOW spot (${annualisedPct.toFixed(1)}% annualised) — leverage is paying to be short`,
  };
}

// ------------------------------------------------------- OI / price state --

export type FlowState =
  | "new-longs"
  | "short-covering"
  | "new-shorts"
  | "long-liquidation"
  | "quiet";

export interface OiRead {
  state: FlowState;
  oiChangePct: number;
  priceChangePct: number;
  direction: "long" | "short" | "neutral";
  label: string;
  reason: string;
}

/**
 * The four-way read on who is doing the buying.
 *
 * Open interest is the count of contracts outstanding. Combined with the price
 * direction it distinguishes new money from money leaving — a distinction the
 * price alone cannot make, and the single most useful thing derivatives data
 * offers a chart reader.
 *
 * `quietPct` is the band inside which a move is not a move. Without it a 0.02%
 * drift is solemnly classified as "new shorts".
 */
export function oiState(
  openInterest: readonly OpenInterestPoint[],
  priceChangePct: number,
  lookback = 24,
  quietPct = 0.15,
): OiRead | null {
  if (openInterest.length < 2) return null;
  const last = openInterest[openInterest.length - 1] as OpenInterestPoint;
  const refIdx = Math.max(0, openInterest.length - 1 - lookback);
  const ref = openInterest[refIdx] as OpenInterestPoint;
  if (!(ref.amount > 0)) return null;

  const oiChangePct = (last.amount / ref.amount - 1) * 100;

  const oiUp = oiChangePct > quietPct;
  const oiDown = oiChangePct < -quietPct;
  const pxUp = priceChangePct > quietPct;
  const pxDown = priceChangePct < -quietPct;

  const base = { oiChangePct, priceChangePct };

  if (pxUp && oiUp) {
    return {
      ...base,
      state: "new-longs",
      direction: "long",
      label: "New longs",
      reason: `Price ${pctStr(priceChangePct)} with open interest ${pctStr(oiChangePct)} — new money is being put on, not old positions closing. Confirmation, until it becomes the fuel for a squeeze.`,
    };
  }
  if (pxUp && oiDown) {
    return {
      ...base,
      state: "short-covering",
      direction: "neutral",
      label: "Short covering",
      reason: `Price ${pctStr(priceChangePct)} while open interest ${pctStr(oiChangePct)} — the rally is shorts closing, not buyers arriving. That flow runs out on its own.`,
    };
  }
  if (pxDown && oiUp) {
    return {
      ...base,
      state: "new-shorts",
      direction: "short",
      label: "New shorts",
      reason: `Price ${pctStr(priceChangePct)} with open interest ${pctStr(oiChangePct)} — shorts are being opened into the decline rather than longs being closed.`,
    };
  }
  if (pxDown && oiDown) {
    return {
      ...base,
      state: "long-liquidation",
      direction: "neutral",
      label: "Long liquidation",
      reason: `Price ${pctStr(priceChangePct)} with open interest ${pctStr(oiChangePct)} — longs are being forced out. Exhaustive rather than directional: it ends when there is nothing left to force.`,
    };
  }
  return {
    ...base,
    state: "quiet",
    direction: "neutral",
    label: "Quiet",
    reason: `Price ${pctStr(priceChangePct)} and open interest ${pctStr(oiChangePct)} are both inside the ${quietPct}% band — nothing is being decided here.`,
  };
}

// ------------------------------------------------------------ divergence --

export interface Divergence {
  present: boolean;
  fundingChange: number;
  priceChangePct: number;
  direction: "long" | "short" | "neutral";
  reason: string;
}

/**
 * Funding and price pulling in opposite directions.
 *
 * Longs paying MORE to hold while price falls is the definition of a position
 * getting more crowded and less right at the same time. It is not a timing
 * tool — it can persist for weeks — but it is the state that precedes the
 * unwind, and nothing on a price chart shows it.
 */
export function fundingDivergence(
  funding: readonly FundingPoint[],
  priceChangePct: number,
  lookback = 12,
): Divergence | null {
  if (funding.length < 3) return null;
  const last = funding[funding.length - 1] as FundingPoint;
  const ref = funding[Math.max(0, funding.length - 1 - lookback)] as FundingPoint;
  const fundingChange = last.rate - ref.rate;

  // Both sides need to be doing something. A flat pair is not a divergence,
  // it is two numbers that happen to have opposite signs at the third decimal.
  const meaningful = Math.abs(fundingChange) > 0.00002 && Math.abs(priceChangePct) > 0.3;
  if (!meaningful) {
    return {
      present: false,
      fundingChange,
      priceChangePct,
      direction: "neutral",
      reason: "Funding and price are both close to flat — nothing is diverging.",
    };
  }

  const risingFundingFallingPrice = fundingChange > 0 && priceChangePct < 0;
  const fallingFundingRisingPrice = fundingChange < 0 && priceChangePct > 0;

  if (risingFundingFallingPrice) {
    return {
      present: true,
      fundingChange,
      priceChangePct,
      direction: "short",
      reason: `Longs are paying MORE (${(fundingChange * 100).toFixed(4)}% per interval) while price fell ${pctStr(priceChangePct)} — the long side is getting more crowded and less right at the same time.`,
    };
  }
  if (fallingFundingRisingPrice) {
    return {
      present: true,
      fundingChange,
      priceChangePct,
      direction: "long",
      reason: `Shorts are paying more while price rose ${pctStr(priceChangePct)} — the short side is being squeezed rather than the rally being crowded.`,
    };
  }

  return {
    present: false,
    fundingChange,
    priceChangePct,
    direction: "neutral",
    reason: `Funding and price are moving together (${pctStr(priceChangePct)} price, ${(fundingChange * 100).toFixed(4)}% funding) — agreement, not divergence.`,
  };
}

// -------------------------------------------------------------- clusters --

export interface LiquidationCluster {
  /** Volume-weighted centre of the shelf. */
  price: number;
  low: number;
  high: number;
  /** Total notional liquidated inside the shelf. */
  value: number;
  count: number;
  /** Which side was forced out: longs are liquidated by a SELL order. */
  side: "long" | "short" | "both";
  /** Share of the largest cluster's notional, 0..1 — for opacity and ranking. */
  weight: number;
}

/**
 * Group liquidation prints into price shelves.
 *
 * A scrolling tape of individual liquidations is unreadable and, worse,
 * unactionable: what matters is not that someone was liquidated at 78,412 but
 * that eleven million dollars died between 78,300 and 78,500. Bucketing by a
 * PERCENTAGE of price rather than a fixed amount keeps the same code correct
 * for a $4 asset and a $78,000 one.
 *
 * Only clusters holding a real share of the total are returned; a single small
 * print is a print, not a level, and drawing it as one would fill the chart
 * with lines that mean nothing.
 */
export function liquidationClusters(
  liquidations: readonly Liquidation[],
  opts: { bucketPct?: number; minShare?: number; max?: number } = {},
): LiquidationCluster[] {
  const bucketPct = opts.bucketPct ?? 0.0025;
  const minShare = opts.minShare ?? 0.05;
  const max = opts.max ?? 8;
  if (liquidations.length === 0) return [];

  const usable = liquidations.filter((l) => l.price > 0 && l.value > 0);
  if (usable.length === 0) return [];

  /**
   * One bucket width for the whole set, taken from the median price.
   *
   * It must NOT be derived from each print's own price: `price / (price * pct)`
   * is the constant `1 / pct`, so every print lands in the same bucket and the
   * whole book collapses into a single meaningless shelf. Using a shared
   * reference keeps the buckets uniform, and taking the median rather than the
   * mean stops one far-away print from stretching every bucket.
   */
  const sortedPrices = usable.map((l) => l.price).sort((a, b) => a - b);
  const mid = sortedPrices.length >> 1;
  const reference =
    sortedPrices.length % 2 === 1
      ? (sortedPrices[mid] as number)
      : ((sortedPrices[mid - 1] as number) + (sortedPrices[mid] as number)) / 2;
  const size = reference * bucketPct;
  if (!(size > 0)) return [];

  const buckets = new Map<number, { value: number; count: number; pv: number; longs: number; shorts: number; lo: number; hi: number }>();
  let total = 0;

  for (const l of usable) {
    const key = Math.round(l.price / size);
    let b = buckets.get(key);
    if (!b) {
      b = { value: 0, count: 0, pv: 0, longs: 0, shorts: 0, lo: l.price, hi: l.price };
      buckets.set(key, b);
    }
    b.value += l.value;
    b.count += 1;
    b.pv += l.price * l.value;
    b.lo = Math.min(b.lo, l.price);
    b.hi = Math.max(b.hi, l.price);
    // A SELL order liquidates a LONG. This is the thing everyone gets
    // backwards; `stream.ts` documents it at the parse site too.
    if (l.side === "sell") b.longs += l.value;
    else b.shorts += l.value;
    total += l.value;
  }

  if (total <= 0) return [];

  const out: LiquidationCluster[] = [];
  let biggest = 0;
  for (const b of buckets.values()) biggest = Math.max(biggest, b.value);

  for (const b of buckets.values()) {
    if (b.value / total < minShare) continue;
    const dominance = b.longs / (b.longs + b.shorts || 1);
    out.push({
      price: b.pv / b.value,
      low: b.lo,
      high: b.hi,
      value: b.value,
      count: b.count,
      side: dominance > 0.65 ? "long" : dominance < 0.35 ? "short" : "both",
      weight: biggest > 0 ? b.value / biggest : 0,
    });
  }

  out.sort((a, b) => b.value - a.value);
  return out.slice(0, max);
}

/**
 * Clusters as drawable levels, in DATA space.
 *
 * `x0` is supplied by the caller because a cluster has no bar index of its own
 * — it is a price shelf, valid from wherever the caller wants it drawn to the
 * live edge.
 */
export function clusterShapes(clusters: readonly LiquidationCluster[], x0: number): Shape[] {
  return clusters.map((c) => ({
    type: "level" as const,
    x0,
    y: c.price,
    // Longs dying is a bearish event at that price and a support shelf below
    // it; the tone names what happened, not what will.
    tone: c.side === "long" ? "bear" : c.side === "short" ? "bull" : "neutral",
    label: `${c.side === "both" ? "liq" : `${c.side} liq`} ${fmtCompact(c.value)}`,
    dashed: true,
  }));
}

export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
