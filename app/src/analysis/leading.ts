/**
 * LEADING INDICATORS — and an honest account of what "leading" can mean.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE UNCOMFORTABLE PART, FIRST
 *
 * Almost everything sold as a leading indicator is not one. RSI, MACD,
 * stochastics, moving-average crosses and every oscillator on every platform
 * are ARITHMETIC ON PAST PRICE. Rearranging closes cannot produce information
 * that was not in the closes. Calling the result leading is a marketing claim,
 * and a terminal that repeats it is lying to its user in the most expensive way
 * available — by making them feel early.
 *
 * There are, however, three things that genuinely carry information about what
 * has not happened yet, and this module is organised around them rather than
 * around a list of oscillators:
 *
 *   COILED — a CONSTRAINT on the future. Volatility that has compressed must
 *            expand; a range that has narrowed for seven bars cannot narrow
 *            forever. This is leading about TIMING and says nothing whatever
 *            about direction. Every tool that draws an arrow out of a squeeze
 *            is inventing the half of the signal that does not exist.
 *
 *   COMMITTED — POSITIONING. Funding rates, open interest and taker imbalance
 *            are not price; they are what other people have already staked. A
 *            crowded side is a supply of forced buyers or sellers, and forced
 *            flow is the most reliably predictable flow there is. This is
 *            leading about DIRECTION, and it points AGAINST the crowd.
 *
 *   THINNING — participation withdrawing from a move that is still going. Not
 *            "the oscillator diverged" as a chart pattern, but the measurable
 *            version: each new extreme achieved on less volume, less range and
 *            less follow-through than the last. This is leading about
 *            DURABILITY — it says the current push is running out of fuel, not
 *            that it reverses tomorrow.
 *
 * Everything else in this file is a lagging confirmation and is labelled as
 * one. Nothing is promoted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE COMBINING RULE, WHICH IS THE POINT OF THE MODULE
 *
 * The components answer DIFFERENT QUESTIONS, so they are never averaged. A
 * compression reading and a funding reading do not disagree when one is bullish
 * and the other is silent — they are not on the same axis at all. Averaging
 * them produces a number that means nothing, which is precisely what a
 * "composite indicator" on every other platform is.
 *
 * Instead each component declares what it CAN speak to:
 *
 *   says: "when"      → contributes to `timing`, never to `direction`
 *   says: "which way" → contributes to `direction`, never to `timing`
 *   says: "how much"  → scales `conviction`, contributes to neither
 *
 * The result carries all three separately, and the headline is a SENTENCE that
 * puts them together — "a move is close, and positioning says up" — rather than
 * a single score that has quietly averaged a clock with a compass.
 */

import type { ScanBars } from "../scan/confluence";
import { rsi, atr, bollinger } from "../chart/indicators";

/** What a component is entitled to speak about. Enforced by the combiner. */
export type Speaks = "when" | "which way" | "how much";

export type Family = "coiled" | "committed" | "thinning" | "lagging";

export interface LeadingComponent {
  readonly id: string;
  readonly label: string;
  readonly family: Family;
  readonly speaks: Speaks;
  /**
   * 0..1 for "when" and "how much"; −1..+1 for "which way".
   *
   * Null when the component could not be computed. Null is not zero: zero is a
   * reading of "no signal", null is "no reading", and a composite that treats
   * them alike overstates its own coverage.
   */
  readonly value: number | null;
  /** Plain language, shown verbatim. Says what was measured, not what to do. */
  readonly reason: string;
  /** Why this cannot be trusted further than it is. Rendered beside the value. */
  readonly limit: string;
}

/* ------------------------------------------------------------- helpers --- */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp11 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * Where a value sits in its own recent history, 0..1.
 *
 * A percentile rather than an absolute threshold, because "narrow" means
 * nothing across instruments: a 0.4% daily range is dead for a small-cap alt
 * and a violent day for a major FX pair. Ranking against the instrument's own
 * past is the only comparison that transfers.
 *
 * TIES COUNT AS HALF, and that is not a refinement. Counting only strictly
 * smaller values put a series whose bandwidth never changes at percentile ZERO
 * — the tightest reading available — when the truth is that it is exactly
 * typical. A test on a constant-range series caught it. The failure is not
 * hypothetical: a stablecoin pair, a halted instrument, or any feed padding
 * with repeated closes produces exactly that data, and the module would have
 * reported maximum compression on a market that was doing nothing at all.
 *
 * The mid-rank convention below is the standard fix and gives 0.5 for a fully
 * tied window, which is the honest answer.
 */
export function percentileOfLast(series: ArrayLike<number>, lookback: number): number {
  const n = series.length;
  if (n < 2) return NaN;
  const last = series[n - 1] as number;
  if (!Number.isFinite(last)) return NaN;

  let below = 0;
  let equal = 0;
  let counted = 0;
  const from = Math.max(0, n - lookback - 1);
  for (let i = from; i < n - 1; i++) {
    const v = series[i] as number;
    if (!Number.isFinite(v)) continue;
    counted++;
    if (v < last) below++;
    else if (v === last) equal++;
  }
  return counted === 0 ? NaN : (below + equal / 2) / counted;
}

/**
 * A percentage as an English ordinal: 43rd, not "43th".
 *
 * Found on screen, not in a test. It is a small thing and it is the kind of
 * small thing that makes a reader wonder what else was not checked — a panel
 * that cannot spell a rank is not obviously a panel that computed one.
 *
 * The 11/12/13 exception is the part every home-made version gets wrong.
 */
export function ordinal(value: number): string {
  const n = Math.round(value);
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** Median. Used wherever a mean would be dragged by one liquidation candle. */
export function median(xs: readonly number[]): number {
  const clean = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (clean.length === 0) return NaN;
  const mid = clean.length >> 1;
  return clean.length % 2 === 1
    ? (clean[mid] as number)
    : ((clean[mid - 1] as number) + (clean[mid] as number)) / 2;
}

/* --------------------------------------------------------------- coiled --- */

/** Lookback for every percentile below. ~4 months of daily, ~5 days of 5m. */
export const RANK_LOOKBACK = 120;

/** At or below this percentile, the instrument is quiet by its own standards. */
export const COMPRESSED = 0.15;

/**
 * Bollinger bandwidth percentile — the squeeze, measured rather than eyeballed.
 *
 * Bandwidth is (upper − lower) / middle, so it is scale-free and comparable
 * across time for one instrument. Ranking it against the same instrument's last
 * 120 bars turns "the bands look tight" into a number that can be tested.
 *
 * WHAT THIS CANNOT DO, and the reason `speaks` is "when": a squeeze resolves in
 * whichever direction it resolves. Studies of the pattern find no directional
 * edge at all — the edge, such as it is, is entirely in the expansion of range.
 * Anyone who has watched a squeeze break one way, stop out, and break the other
 * has met this fact personally.
 *
 * TWO PROPERTIES OF A RELATIVE MEASURE, both found by tests rather than
 * reasoned about in advance, and both of which a reader has to know:
 *
 *   1. A percentile threshold fires on a FIXED FRACTION of history by
 *      construction. The tightest 15% of a series is 15% of it however violent
 *      the series is, so a low reading here never means the market is quiet in
 *      absolute terms — only that it is quiet compared with its own last 120
 *      bars. A strategy built on this cannot be made selective by the squeeze
 *      condition alone; something else has to do that work.
 *
 *   2. A contraction that OUTLASTS the ranking window disappears. Eighty quiet
 *      bars inside a 120-bar window still rank as quiet; a hundred and fifty do
 *      not, because by then the window is made of the quiet itself and the
 *      reading returns to the middle. A months-long coil is therefore invisible
 *      to this reading on a short timeframe, and the fix is a longer `lookback`
 *      or a higher timeframe, which is why both are parameters.
 */
export function compression(bars: ScanBars, lookback = RANK_LOOKBACK): LeadingComponent {
  const base = {
    id: "compression",
    label: "Volatility compression",
    family: "coiled" as const,
    speaks: "when" as const,
    limit: "A squeeze says a move is coming, never which way. Trading the first break of one is how the range takes both sides.",
  };
  const n = bars.c.length;
  if (n < lookback + 25) {
    return { ...base, value: null, reason: `Only ${n} bars — ${lookback + 25} are needed to rank the bandwidth against its own history.` };
  }

  const bb = bollinger(bars.c, 20, 2, n);
  const width = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = bb.middle[i] as number;
    width[i] = Number.isFinite(m) && m !== 0 ? ((bb.upper[i] as number) - (bb.lower[i] as number)) / m : NaN;
  }

  const pct = percentileOfLast(width, lookback);
  if (!Number.isFinite(pct)) {
    return { ...base, value: null, reason: "Bandwidth could not be ranked — the window has no usable variance." };
  }

  /* Tightness, not rank: a reading of 0.02 should score near 1. */
  const tight = clamp01(1 - pct / COMPRESSED);
  return {
    ...base,
    value: tight,
    reason:
      pct <= COMPRESSED
        ? `Bandwidth is in the tightest ${(pct * 100).toFixed(0)}% of the last ${lookback} bars. Ranges this narrow do not persist.`
        : `Bandwidth sits at the ${ordinal(pct * 100)} percentile of the last ${lookback} bars — unremarkable. Nothing is coiled.`,
  };
}

/** Bars in the narrow-range test. 7 is the conventional NR7. */
export const NR_WINDOW = 7;

/**
 * Narrow range: is the latest bar the smallest of the last N?
 *
 * A cruder and much faster signal than bandwidth, and it catches a different
 * thing — a single inside day at the end of a wide stretch, which bandwidth
 * smooths away. Both are kept because they disagree usefully.
 */
export function narrowRange(bars: ScanBars, window = NR_WINDOW): LeadingComponent {
  const base = {
    id: "narrowRange",
    label: `Narrowest of ${window}`,
    family: "coiled" as const,
    speaks: "when" as const,
    limit: "One bar. It is a hint about the next few, not about the week.",
  };
  const n = bars.c.length;
  if (n < window + 1) return { ...base, value: null, reason: `Only ${n} bars — ${window + 1} are needed.` };

  const ranges: number[] = [];
  for (let i = n - window; i < n; i++) ranges.push((bars.h[i] as number) - (bars.l[i] as number));
  const last = ranges[ranges.length - 1] as number;
  if (!Number.isFinite(last)) return { ...base, value: null, reason: "The last bar has no usable range." };

  const smaller = ranges.slice(0, -1).filter((r) => r <= last).length;
  const isNarrowest = smaller === 0;
  const med = median(ranges.slice(0, -1));
  const ratio = med > 0 ? last / med : NaN;

  return {
    ...base,
    value: isNarrowest ? 1 : Number.isFinite(ratio) ? clamp01(1 - ratio) : 0,
    reason: isNarrowest
      ? `The last bar is the narrowest of ${window}, at ${(ratio * 100).toFixed(0)}% of the median range.`
      : `The last bar is ${(ratio * 100).toFixed(0)}% of the median of the last ${window}. Not a contraction.`,
  };
}

/**
 * Realised-volatility term structure: short window against long.
 *
 * Below 1 the market has gone quiet RELATIVE TO ITSELF, which is a different
 * statement from "volatility is low" and a more useful one — it is the rate of
 * change that mean-reverts, not the level.
 */
export function volTermStructure(bars: ScanBars, short = 10, long = 50): LeadingComponent {
  const base = {
    id: "volTerm",
    label: "Volatility term structure",
    family: "coiled" as const,
    speaks: "when" as const,
    limit: "Mean reversion in volatility is one of the few robust regularities in markets, but it says nothing about the timing beyond 'not indefinitely'.",
  };
  const n = bars.c.length;
  if (n < long + 2) return { ...base, value: null, reason: `Only ${n} bars — ${long + 2} are needed.` };

  const a = atr(bars.h, bars.l, bars.c, short, n);
  const b = atr(bars.h, bars.l, bars.c, long, n);
  const av = a[n - 1] as number;
  const bv = b[n - 1] as number;
  if (!Number.isFinite(av) || !Number.isFinite(bv) || bv <= 0) {
    return { ...base, value: null, reason: "Average true range is not computable over this window." };
  }

  const ratio = av / bv;
  return {
    ...base,
    value: clamp01(1 - ratio),
    reason:
      ratio < 0.8
        ? `Short-window range is ${(ratio * 100).toFixed(0)}% of the long-window one. The market has gone quiet relative to its own recent behaviour.`
        : ratio > 1.2
          ? `Short-window range is ${(ratio * 100).toFixed(0)}% of the long. Already expanded — the move may be the one in progress.`
          : `Short and long ranges are within ${Math.abs(ratio - 1) * 100 < 1 ? "a percent" : `${(Math.abs(ratio - 1) * 100).toFixed(0)}%`} of each other. Neither coiled nor extended.`,
  };
}

/* ------------------------------------------------------------ committed --- */

export interface PositioningInput {
  /** Perp funding rate for the current interval, as a fraction. */
  readonly funding: number | null;
  /** The same rate ranked against its own recent history, 0..1. */
  readonly fundingPercentile: number | null;
  /** Open interest now and one lookback ago, same units. */
  readonly oiNow: number | null;
  readonly oiThen: number | null;
  /** Price now and at the same lookback, so OI can be read against it. */
  readonly priceNow: number | null;
  readonly priceThen: number | null;
}

/** Beyond this percentile, one side is paying materially to stay in. */
export const CROWDED = 0.85;

/**
 * Funding as a crowding measure.
 *
 * Funding is what longs pay shorts (or the reverse) to hold a perpetual at par
 * with spot. Persistently positive funding is not "bullish sentiment" — it is a
 * running cost being paid by one side, and a side paying to stay in is a side
 * that can be made to leave.
 *
 * The lean is therefore AGAINST the crowd, and this is the one place in the
 * terminal where a contrarian sign is applied deliberately rather than as a
 * style. It is also why the percentile matters more than the level: funding of
 * 0.01% is the default on most venues and means nothing at all.
 */
export function fundingCrowding(p: PositioningInput): LeadingComponent {
  const base = {
    id: "fundingCrowd",
    label: "Funding crowding",
    family: "committed" as const,
    speaks: "which way" as const,
    limit: "Crowded can stay crowded for weeks. This says who is exposed to a squeeze, never when it comes.",
  };
  if (p.funding === null || p.fundingPercentile === null || !Number.isFinite(p.funding)) {
    return { ...base, value: null, reason: "No funding history for this instrument — it may be spot-only, or the venue did not answer." };
  }

  const pct = p.fundingPercentile;
  const extreme = Math.max(0, (Math.abs(pct - 0.5) - (CROWDED - 0.5)) / (1 - CROWDED));
  if (extreme <= 0) {
    return {
      ...base,
      value: 0,
      reason: `Funding sits at the ${ordinal(pct * 100)} percentile of its own history. Neither side is paying up.`,
    };
  }

  const crowdedLong = pct > 0.5;
  return {
    ...base,
    value: clamp11(crowdedLong ? -extreme : extreme),
    reason: crowdedLong
      ? `Longs are paying ${(p.funding * 100).toFixed(4)}% per interval, the ${ordinal(pct * 100)} percentile of this instrument's own history. That side is carrying a cost and is the one that gets flushed.`
      : `Shorts are paying ${(Math.abs(p.funding) * 100).toFixed(4)}% per interval, the ${ordinal((1 - pct) * 100)} percentile from the bottom. The squeeze risk is upward.`,
  };
}

/**
 * Open interest against price — the four-way read.
 *
 * OI up with price up is new money committing (a trend with fuel). OI up with
 * price down is new shorts. OI DOWN with price up is short covering, which is a
 * rally with no new buyers behind it and is the most misread condition on any
 * chart. OI down with price down is longs capitulating.
 *
 * Only two of the four carry a directional lean, and the other two are returned
 * with a lean of zero and a sentence rather than a fabricated one.
 */
export function openInterestRead(p: PositioningInput): LeadingComponent {
  const base = {
    id: "oiRead",
    label: "Open interest vs price",
    family: "committed" as const,
    speaks: "which way" as const,
    limit: "Open interest is a count of contracts, not of conviction. It cannot tell a hedge from a bet.",
  };
  const { oiNow, oiThen, priceNow, priceThen } = p;
  if (
    oiNow === null || oiThen === null || priceNow === null || priceThen === null ||
    !Number.isFinite(oiNow) || !Number.isFinite(oiThen) || oiThen <= 0 || priceThen <= 0
  ) {
    return { ...base, value: null, reason: "No open-interest history for this instrument over the window." };
  }

  const dOi = (oiNow - oiThen) / oiThen;
  const dPx = (priceNow - priceThen) / priceThen;
  const strength = clamp01(Math.abs(dOi) / 0.1);

  if (Math.abs(dOi) < 0.01 || Math.abs(dPx) < 0.002) {
    return { ...base, value: 0, reason: `Open interest moved ${(dOi * 100).toFixed(1)}% against a ${(dPx * 100).toFixed(1)}% price move. Neither is enough to read.` };
  }

  if (dOi > 0 && dPx > 0) {
    return { ...base, value: clamp11(strength * 0.6), reason: `Open interest up ${(dOi * 100).toFixed(1)}% while price rose ${(dPx * 100).toFixed(1)}%. New money is committing to the move rather than chasing it with borrowed size.` };
  }
  if (dOi > 0 && dPx < 0) {
    return { ...base, value: clamp11(-strength * 0.6), reason: `Open interest up ${(dOi * 100).toFixed(1)}% while price fell ${(dPx * 100).toFixed(1)}%. New shorts are being added, not longs closing.` };
  }
  if (dOi < 0 && dPx > 0) {
    return { ...base, value: 0, reason: `Open interest fell ${(Math.abs(dOi) * 100).toFixed(1)}% while price rose ${(dPx * 100).toFixed(1)}%. This is short covering: the rally is positions closing, not new buyers arriving, and it stops when they are done. No lean either way.` };
  }
  return { ...base, value: 0, reason: `Open interest fell ${(Math.abs(dOi) * 100).toFixed(1)}% with price down ${(Math.abs(dPx) * 100).toFixed(1)}%. Longs are capitulating — the flush is happening now rather than ahead. No lean either way.` };
}

/* ------------------------------------------------------------- thinning --- */

/**
 * Volume behind the push.
 *
 * Compares the volume of the bars making the current extreme against the
 * instrument's own recent median. A new high on half the usual volume is a high
 * nobody turned up for.
 *
 * `speaks: "how much"` — this scales conviction in whatever direction the other
 * components find. On its own it has no sign: thin volume into a high and thin
 * volume into a low are the same statement about participation.
 */
export function participation(bars: ScanBars, window = 5, lookback = RANK_LOOKBACK): LeadingComponent {
  const base = {
    id: "participation",
    label: "Participation",
    family: "thinning" as const,
    speaks: "how much" as const,
    limit: "Volume is venue-specific. On a fragmented instrument this measures one venue's share, not the market's interest.",
  };
  const n = bars.v.length;
  if (n < lookback + window) return { ...base, value: null, reason: `Only ${n} bars — ${lookback + window} are needed.` };

  const recent: number[] = [];
  for (let i = n - window; i < n; i++) recent.push(bars.v[i] as number);
  const past: number[] = [];
  for (let i = n - lookback - window; i < n - window; i++) past.push(bars.v[i] as number);

  const now = median(recent);
  const base_ = median(past);
  if (!Number.isFinite(now) || !Number.isFinite(base_) || base_ <= 0) {
    return { ...base, value: null, reason: "This feed reports no volume, so participation cannot be measured." };
  }

  const ratio = now / base_;
  return {
    ...base,
    /* 1 means full conviction, 0 means the move is unattended. Ratio 1.0 → 0.5,
       so a normal-volume move neither adds nor removes conviction. */
    value: clamp01(ratio / 2),
    reason:
      ratio < 0.7
        ? `The last ${window} bars traded ${(ratio * 100).toFixed(0)}% of the median volume of the previous ${lookback}. Whatever is moving price, it is moving it thinly.`
        : ratio > 1.5
          ? `The last ${window} bars traded ${(ratio * 100).toFixed(0)}% of the recent median. This move has attendance.`
          : `Volume is ${(ratio * 100).toFixed(0)}% of the recent median — ordinary.`,
  };
}

/**
 * Momentum divergence, measured rather than drawn.
 *
 * Finds the two most recent swing extremes in price and compares them with RSI
 * at the same bars. Price making a higher high while RSI makes a lower high is
 * the textbook bearish divergence.
 *
 * IT IS INCLUDED AS `thinning`, NOT AS A REVERSAL SIGNAL. Divergence tells you
 * the second push was weaker than the first. Trends produce divergences the
 * whole way up and the pattern is famous for being right eventually and ruinous
 * meanwhile. The lean is deliberately small.
 */
export function momentumDivergence(bars: ScanBars, swing = 5, period = 14): LeadingComponent {
  const base = {
    id: "divergence",
    label: "Momentum divergence",
    family: "thinning" as const,
    speaks: "which way" as const,
    limit: "Trends diverge repeatedly before they turn. This is a statement about the last two pushes, not a reversal call.",
  };
  const n = bars.c.length;
  if (n < period + swing * 6) return { ...base, value: null, reason: `Only ${n} bars — ${period + swing * 6} are needed to find two swings.` };

  const r = rsi(bars.c, period, n);

  /* Swing extremes: a bar higher (or lower) than `swing` bars either side.
     Scanning backwards means the two found are the two most recent. */
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = n - 1 - swing; i >= swing && (highs.length < 2 || lows.length < 2); i--) {
    let isHigh = true;
    let isLow = true;
    const h = bars.h[i] as number;
    const l = bars.l[i] as number;
    for (let k = 1; k <= swing; k++) {
      if ((bars.h[i - k] as number) >= h || (bars.h[i + k] as number) >= h) isHigh = false;
      if ((bars.l[i - k] as number) <= l || (bars.l[i + k] as number) <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh && highs.length < 2) highs.push(i);
    if (isLow && lows.length < 2) lows.push(i);
  }

  const [h1, h0] = highs; /* h1 is the most recent */
  const [l1, l0] = lows;

  if (h1 !== undefined && h0 !== undefined) {
    const pxUp = (bars.h[h1] as number) > (bars.h[h0] as number);
    const rsiDown = (r[h1] as number) < (r[h0] as number);
    if (pxUp && rsiDown && Number.isFinite(r[h1]) && Number.isFinite(r[h0])) {
      const gap = ((r[h0] as number) - (r[h1] as number)) / 100;
      return {
        ...base,
        value: clamp11(-clamp01(gap * 4) * 0.6),
        reason: `Price made a higher high while RSI fell from ${(r[h0] as number).toFixed(0)} to ${(r[h1] as number).toFixed(0)}. The second push had less behind it than the first.`,
      };
    }
  }
  if (l1 !== undefined && l0 !== undefined) {
    const pxDown = (bars.l[l1] as number) < (bars.l[l0] as number);
    const rsiUp = (r[l1] as number) > (r[l0] as number);
    if (pxDown && rsiUp && Number.isFinite(r[l1]) && Number.isFinite(r[l0])) {
      const gap = ((r[l1] as number) - (r[l0] as number)) / 100;
      return {
        ...base,
        value: clamp11(clamp01(gap * 4) * 0.6),
        reason: `Price made a lower low while RSI rose from ${(r[l0] as number).toFixed(0)} to ${(r[l1] as number).toFixed(0)}. Selling into the second low was weaker.`,
      };
    }
  }

  return { ...base, value: 0, reason: "The last two swings confirmed each other. No divergence to report." };
}

/**
 * Follow-through: does a push extend on the next bar, or get sold?
 *
 * Measures where each of the last N bars closed within its own range. A run of
 * closes near the high is buying that persisted to the bell; a run of long
 * upper wicks is buying that was met. This is the closest an OHLC feed gets to
 * order flow, and the comment below is the point of the whole function.
 *
 * IT IS A PROXY AND IS LABELLED ONE EVERYWHERE IT APPEARS. Real delta needs
 * trade-by-trade data with an aggressor flag. Close-within-range correlates
 * with it and is not it, and any tool presenting this as "cumulative delta"
 * without saying so is selling a reconstruction as a measurement.
 */
export function followThrough(bars: ScanBars, window = 10): LeadingComponent {
  const base = {
    id: "followThrough",
    label: "Follow-through (proxy)",
    family: "thinning" as const,
    speaks: "which way" as const,
    limit: "Derived from where bars closed in their range, NOT from trade data. It correlates with aggressor flow; it is not a measurement of it.",
  };
  const n = bars.c.length;
  if (n < window) return { ...base, value: null, reason: `Only ${n} bars — ${window} are needed.` };

  let sum = 0;
  let counted = 0;
  for (let i = n - window; i < n; i++) {
    const h = bars.h[i] as number;
    const l = bars.l[i] as number;
    const c = bars.c[i] as number;
    const range = h - l;
    if (!Number.isFinite(range) || range <= 0) continue;
    /* −1 at the low, +1 at the high. */
    sum += ((c - l) / range) * 2 - 1;
    counted++;
  }
  if (counted === 0) return { ...base, value: null, reason: "Every bar in the window had no range." };

  const mean = sum / counted;
  return {
    ...base,
    value: clamp11(mean),
    reason:
      Math.abs(mean) < 0.15
        ? `Closes sat mid-range across the last ${counted} bars. Neither side finished in control.`
        : mean > 0
          ? `Bars closed in the upper ${(((mean + 1) / 2) * 100).toFixed(0)}% of their range on average over ${counted} bars. Buying held into each close.`
          : `Bars closed in the lower ${(((1 - mean) / 2) * 100).toFixed(0)}% of their range on average over ${counted} bars. Selling held into each close.`,
  };
}

/* ------------------------------------------------------------ composite --- */

export interface LeadingRead {
  /** 0..1 — how close a range expansion looks. NOT a direction. */
  readonly timing: number;
  /** −1..+1 from positioning and thinning only, or null when nothing spoke. */
  readonly direction: number | null;
  /** 0..1 — how much attendance the current move has. Scales, never signs. */
  readonly conviction: number;
  /** Share of components that returned a reading rather than null, 0..1. */
  readonly coverage: number;
  readonly components: readonly LeadingComponent[];
  /** The three numbers as one sentence. Never a score. */
  readonly headline: string;
}

/**
 * Combine, keeping the axes apart.
 *
 * The three outputs are computed from disjoint sets of components, selected by
 * what each one declared it `speaks` to. A "when" component cannot influence
 * direction even by accident, because it is never in that sum. That is the
 * whole safety property, and it is enforced by construction rather than by
 * remembering.
 */
export function combineLeading(components: readonly LeadingComponent[]): LeadingRead {
  const answered = components.filter((c) => c.value !== null);
  const coverage = components.length === 0 ? 0 : answered.length / components.length;

  const when = answered.filter((c) => c.speaks === "when");
  const way = answered.filter((c) => c.speaks === "which way");
  const much = answered.filter((c) => c.speaks === "how much");

  const timing = when.length === 0 ? 0 : when.reduce((s, c) => s + (c.value as number), 0) / when.length;
  const direction = way.length === 0 ? null : clamp11(way.reduce((s, c) => s + (c.value as number), 0) / way.length);
  const conviction = much.length === 0 ? 0.5 : much.reduce((s, c) => s + (c.value as number), 0) / much.length;

  const timingWords =
    timing > 0.6 ? "A range expansion looks close" : timing > 0.3 ? "The range is tightening" : "Nothing is coiled";

  const dirWords =
    direction === null
      ? "and nothing is speaking to direction"
      : Math.abs(direction) < 0.15
        ? "and positioning is balanced"
        : direction > 0
          ? `and what is committed leans up (${direction.toFixed(2)})`
          : `and what is committed leans down (${direction.toFixed(2)})`;

  const convWords =
    conviction < 0.35
      ? " Participation is thin, so treat the lean as provisional."
      : conviction > 0.7
        ? " Participation is heavy, which is the one thing here that argues the move is real."
        : "";

  const coverWords =
    coverage < 1
      ? ` ${answered.length} of ${components.length} inputs answered — the rest had no data, not a neutral reading.`
      : "";

  return {
    timing: clamp01(timing),
    direction,
    conviction: clamp01(conviction),
    coverage,
    components,
    headline: `${timingWords}, ${dirWords}.${convWords}${coverWords}`,
  };
}

/**
 * The full read for one instrument.
 *
 * Positioning is optional because it only exists for perpetuals. When it is
 * absent the components are still RETURNED with a null value rather than
 * omitted, so coverage falls and the headline says so — a spot instrument
 * genuinely has less information behind it, and hiding the gap would make the
 * two look equally well supported.
 */
export function readLeading(bars: ScanBars, positioning?: PositioningInput): LeadingRead {
  const p: PositioningInput = positioning ?? {
    funding: null,
    fundingPercentile: null,
    oiNow: null,
    oiThen: null,
    priceNow: null,
    priceThen: null,
  };
  return combineLeading([
    compression(bars),
    narrowRange(bars),
    volTermStructure(bars),
    fundingCrowding(p),
    openInterestRead(p),
    participation(bars),
    momentumDivergence(bars),
    followThrough(bars),
  ]);
}
