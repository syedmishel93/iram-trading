/**
 * Volume profile — where the thing actually traded, rather than what its
 * closes averaged to.
 *
 * WHY IT IS THE ONE INDICATOR WORTH ADDING
 * Every oscillator in `indicators.ts` is arithmetic on past close, and
 * rearranging closes cannot produce information that was not in the closes. A
 * volume profile uses a different axis entirely: it asks how much business was
 * done at each PRICE, ignoring when. The levels it produces — the point of
 * control, the edges of the value area — are levels no moving average can
 * give you, because they are not derived from the price path at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE APPROXIMATION, STATED UP FRONT
 *
 * A true volume profile is built from trades: every fill, at its own price.
 * This is built from BARS, and a bar reports one volume figure for a whole
 * high-low range with no record of where inside that range the business
 * happened. So each bar's volume is spread UNIFORMLY across the prices it
 * touched, in proportion to how much of each bin the bar's range covers.
 *
 * That assumption is wrong in a knowable direction: real volume clusters near
 * the open and the close of a bar rather than spreading evenly through the
 * wicks, so a bar-built profile understates the extremes slightly and
 * oversmooths. It is close enough for the question people actually ask of a
 * profile — where is the heavy shelf, where is the thin air — and it is not
 * close enough to trade a single tick off, which is why `PROFILE_BASIS` exists
 * and the UI prints it. A profile that does not say what it was built from is
 * indistinguishable on screen from one built on real prints, and the two
 * deserve different amounts of trust.
 *
 * The honest alternative — refusing to draw one at all without tick data — was
 * considered and rejected. The shelf is real at this resolution; only its edge
 * is fuzzy.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT SEEDED FROM `v` ALONE
 * FX feeds report no volume, or report tick count dressed as volume. A profile
 * over an all-zero volume column would be a flat block with a point of control
 * wherever the loop happened to break ties — a confident, meaningless line
 * across the chart. `volumeProfile` returns `null` for that case rather than a
 * shape, and the caller says why.
 */

import type { BarView } from "./series";

/** What the profile was computed from, so the UI can never overstate it. */
export const PROFILE_BASIS =
  "built from bar ranges, not trade prints — each bar's volume spread evenly across its high-low";

export interface ProfileBin {
  /** Price at the bottom of the bin. */
  readonly low: number;
  /** Price at the top of the bin. */
  readonly high: number;
  /** Volume attributed to this price band. */
  readonly volume: number;
}

export interface VolumeProfile {
  readonly bins: readonly ProfileBin[];
  /** Point of control — the price band that traded the most. */
  readonly poc: number;
  /** Value area high and low: the band containing `valueAreaPct` of volume. */
  readonly vah: number;
  readonly val: number;
  readonly total: number;
  /** Bin height in price. Useful for drawing and for judging resolution. */
  readonly binSize: number;
  /** Volume in the busiest bin, so a renderer can scale bars without a scan. */
  readonly peak: number;
}

/** The conventional value area. 70% is the convention; it is not a law. */
export const VALUE_AREA_PCT = 0.7;

/**
 * Default bin count.
 *
 * Chosen against the chart, not from theory: below about 40 the point of
 * control lands on a band wide enough to contain two distinct shelves, and
 * above about 150 the profile is mostly single-bar spikes and reads as noise.
 * 80 is comfortably inside both edges at every timeframe this terminal loads.
 */
export const DEFAULT_BINS = 80;

/**
 * Build a profile over `bars`.
 *
 * Returns null when there is nothing honest to build: no bars, no price range,
 * or no volume anywhere in the window.
 */
export function volumeProfile(
  bars: readonly BarView[],
  bins = DEFAULT_BINS,
  valueAreaPct = VALUE_AREA_PCT,
): VolumeProfile | null {
  if (bars.length === 0 || bins < 2) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let anyVolume = 0;
  for (const b of bars) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
    if (Number.isFinite(b.v) && b.v > 0) anyVolume += b.v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  /* No volume anywhere: an FX feed, or a synthetic series. A profile here
     would be a flat block with an arbitrary point of control. */
  if (anyVolume <= 0) return null;

  const binSize = (hi - lo) / bins;
  const acc = new Float64Array(bins);

  for (const b of bars) {
    const v = Number.isFinite(b.v) ? b.v : 0;
    if (v <= 0) continue;

    /* A doji, or any bar whose whole range sits inside one bin, drops its
       volume in that single bin. Spreading it would divide by a zero range. */
    if (b.h - b.l <= 0) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((b.c - lo) / binSize)));
      acc[idx] = (acc[idx] as number) + v;
      continue;
    }

    const first = Math.min(bins - 1, Math.max(0, Math.floor((b.l - lo) / binSize)));
    const last = Math.min(bins - 1, Math.max(0, Math.floor((b.h - lo) / binSize)));
    const range = b.h - b.l;

    for (let i = first; i <= last; i++) {
      const binLow = lo + i * binSize;
      const binHigh = binLow + binSize;
      /* Proportional to the OVERLAP, not to the bin count. A bar covering half
         of one bin and all of the next must not put equal volume in both. */
      const overlap = Math.min(b.h, binHigh) - Math.max(b.l, binLow);
      if (overlap <= 0) continue;
      acc[i] = (acc[i] as number) + (v * overlap) / range;
    }
  }

  let pocIndex = 0;
  let peak = -1;
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const x = acc[i] as number;
    total += x;
    if (x > peak) {
      peak = x;
      pocIndex = i;
    }
  }
  if (total <= 0) return null;

  const { lowIndex, highIndex } = valueArea(acc, pocIndex, total * valueAreaPct);

  const out: ProfileBin[] = [];
  for (let i = 0; i < bins; i++) {
    out.push({ low: lo + i * binSize, high: lo + (i + 1) * binSize, volume: acc[i] as number });
  }

  return {
    bins: out,
    /* The MIDDLE of the winning bin, not its edge. A point of control drawn on
       a bin boundary looks like it belongs to whichever neighbour the eye
       happens to land on. */
    poc: lo + (pocIndex + 0.5) * binSize,
    val: lo + lowIndex * binSize,
    vah: lo + (highIndex + 1) * binSize,
    total,
    binSize,
    peak,
  };
}

/**
 * Grow outward from the point of control until `target` volume is enclosed.
 *
 * THE RULE THAT MATTERS: at each step the LARGER neighbour is taken, not the
 * next one on alternating sides. Alternating produces a value area centred on
 * the POC by construction, which throws away the thing the value area is for —
 * a profile whose business sits mostly above its point of control should
 * produce a value area that sits mostly above it too.
 */
function valueArea(
  acc: Float64Array,
  pocIndex: number,
  target: number,
): { lowIndex: number; highIndex: number } {
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let held = acc[pocIndex] as number;

  while (held < target && (lowIndex > 0 || highIndex < acc.length - 1)) {
    const below = lowIndex > 0 ? (acc[lowIndex - 1] as number) : -1;
    const above = highIndex < acc.length - 1 ? (acc[highIndex + 1] as number) : -1;
    if (below < 0 && above < 0) break;
    if (above >= below) {
      highIndex += 1;
      held += above;
    } else {
      lowIndex -= 1;
      held += below;
    }
  }
  return { lowIndex, highIndex };
}

/**
 * High- and low-volume nodes: the shelves and the thin air.
 *
 * A high-volume node is price that was fought over and tends to hold; a
 * low-volume node is price that was crossed quickly and tends to be crossed
 * quickly again. The two are the actionable part of a profile — the POC is one
 * level, and these are the structure around it.
 *
 * Defined against the profile's OWN distribution rather than a fixed volume
 * threshold, because the same absolute figure is a shelf on one instrument and
 * noise on another.
 */
export interface ProfileNode {
  readonly kind: "hvn" | "lvn";
  readonly price: number;
  readonly volume: number;
}

export function profileNodes(profile: VolumeProfile, sensitivity = 1): ProfileNode[] {
  const vols = profile.bins.map((b) => b.volume);
  const mean = profile.total / vols.length;
  let variance = 0;
  for (const v of vols) variance += (v - mean) * (v - mean);
  const sd = Math.sqrt(variance / vols.length);
  if (sd <= 0) return [];

  const hi = mean + sensitivity * sd;
  const lo = Math.max(0, mean - sensitivity * sd);

  const out: ProfileNode[] = [];
  for (let i = 1; i < vols.length - 1; i++) {
    const v = vols[i] as number;
    const prev = vols[i - 1] as number;
    const next = vols[i + 1] as number;
    const bin = profile.bins[i] as ProfileBin;
    const price = (bin.low + bin.high) / 2;
    /* Local extremum as well as a distribution outlier: without the local test
       every bin on the flank of one big shelf is reported as its own node. */
    if (v >= hi && v >= prev && v >= next) out.push({ kind: "hvn", price, volume: v });
    else if (v <= lo && v <= prev && v <= next) out.push({ kind: "lvn", price, volume: v });
  }
  return out;
}
