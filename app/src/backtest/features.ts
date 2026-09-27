/**
 * What was true at the moment of a signal — in a form a model can generalise.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: NO PRICE LEVEL, EVER.
 *
 * The obvious feature set is the indicator columns `rules.ts` already computes:
 * close, ema50, atr, macd. Every one of them is denominated in the
 * instrument's own units, and a tree fitted to them learns the LEVEL. On
 * BTCUSDT that is fatal in a way that looks like success — 2021 and 2024 are
 * separable by price alone, both were strong years, and a model handed `close`
 * will split on "above 60,000" and score beautifully out of sample right up to
 * the moment it meets a price it has never seen, where every split evaluates on
 * the wrong side and it has no opinion at all. It would also be untransferable:
 * a router trained on BTC could never say anything about XAUUSD, because 2,600
 * is below every threshold it holds.
 *
 * So every feature here is a RATIO or a BOUNDED OSCILLATOR. Distances are in
 * units of ATR rather than percent, because percent is itself regime-dependent
 * — 1% is a quiet day in crypto and a violent one in EURUSD, and a model given
 * percent learns the asset instead of the setup.
 *
 * CAUSALITY IS A PROPERTY OF THE INPUTS, NOT A PROMISE MADE HERE.
 * Every indicator used is backward-looking by construction, and `featuresAt(i)`
 * reads index `i` of arrays built over the whole series. That is only safe
 * because those arrays are causal — value `i` depends on 0..i and nothing else.
 * `features.test.ts` proves it the only way worth proving: it computes the
 * matrix over a prefix and over the full series and requires the shared indices
 * to be IDENTICAL. A feature that peeked would differ, and nothing else in the
 * stack would notice.
 *
 * VOLUME IS OMITTED, NOT DEFAULTED.
 * Many FX and CFD feeds report tick count as volume, or zero. A `volRatio` that
 * silently defaults to 1 on those is the units bug CLAUDE.md records: a wrong
 * answer with no symptom, in a column the model will happily split on. When the
 * series carries no usable volume the column is dropped and `omitted` says so.
 */

import type { BarView } from "../chart/series";
import { ema, sma, rsi, atr, adx, macd, bollinger, roc } from "../chart/indicators";

/**
 * Bars needed before a feature row means anything.
 *
 * EMA 200 binds, and the ATR baseline wants 100 of its own on top of ATR's 14.
 * Understating this hands the model rows whose indicators are still converging,
 * which is noise labelled as signal.
 */
export const FEATURE_WARMUP = 220;

export interface FeatureMatrix {
  /** Column names, in a stable order. */
  readonly names: readonly string[];
  /** The row at bar `i`, or null when any column is not finite there. */
  featuresAt(i: number): Readonly<Record<string, number>> | null;
  /** Columns that could not be computed for this series, and why. */
  readonly omitted: readonly string[];
}

const finite = (v: number | undefined): boolean => typeof v === "number" && Number.isFinite(v);

/**
 * Does this series carry volume worth reading?
 *
 * "Some bars have a number in them" is not enough — a feed that reports zero on
 * most bars and a tick count on a few produces a ratio that is mostly noise and
 * occasionally enormous. The test is that most bars are positive.
 */
function hasVolume(bars: readonly BarView[]): boolean {
  let positive = 0;
  for (const b of bars) if (b.v > 0) positive += 1;
  return positive > bars.length * 0.8;
}

export function buildFeatures(bars: readonly BarView[]): FeatureMatrix {
  const n = bars.length;
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const open = new Float64Array(n);
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const b = bars[i] as BarView;
    high[i] = b.h;
    low[i] = b.l;
    close[i] = b.c;
    open[i] = b.o;
    vol[i] = b.v;
  }

  const a14 = atr(high, low, close, 14, n);
  /* The ATR's own baseline, so "volatile" is relative to this market rather
     than to a constant nobody can choose for every instrument at once. */
  const aBase = sma(a14, 100, n);
  const e50 = ema(close, 50, n);
  const e200 = ema(close, 200, n);
  const r14 = rsi(close, 14, n);
  const adx14 = adx(high, low, close, 14, n).adx;
  const m = macd(close, 12, 26, 9, n);
  const bb = bollinger(close, 20, 2, n);
  const r12 = roc(close, 12, n);

  const useVolume = hasVolume(bars);
  const volAvg = useVolume ? sma(vol, 20, n) : null;

  const omitted: string[] = [];
  if (!useVolume) {
    omitted.push("volRatio — this series reports no usable volume, so participation is unknown");
  }

  const names = [
    "rsi14",
    "adx14",
    "atrPct",
    "atrRatio",
    "distEma50",
    "distEma200",
    "slopeEma50",
    "macdhAtr",
    "bbPos",
    "roc12",
    "barRange",
    "bodyShare",
    "hourUtc",
    "dayOfWeek",
    ...(useVolume ? ["volRatio"] : []),
  ];

  const featuresAt = (i: number): Readonly<Record<string, number>> | null => {
    const b = bars[i];
    if (b === undefined || i < FEATURE_WARMUP) return null;

    const c = close[i] as number;
    const a = a14[i] as number;
    if (!finite(c) || !(c > 0) || !finite(a) || !(a > 0)) return null;

    const ab = aBase[i] as number;
    const e50i = e50[i] as number;
    const e50prev = e50[i - 20] as number;
    const e200i = e200[i] as number;
    const bu = bb.upper[i] as number;
    const bl = bb.lower[i] as number;
    const band = bu - bl;
    const range = b.h - b.l;

    const row: Record<string, number> = {
      rsi14: r14[i] as number,
      adx14: adx14[i] as number,
      atrPct: (a / c) * 100,
      atrRatio: finite(ab) && ab > 0 ? a / ab : Number.NaN,
      distEma50: (c - e50i) / a,
      distEma200: (c - e200i) / a,
      slopeEma50: (e50i - e50prev) / a,
      macdhAtr: (m.histogram[i] as number) / a,
      bbPos: band > 0 ? (c - bl) / band : Number.NaN,
      roc12: r12[i] as number,
      barRange: range / a,
      /* A doji has zero range and an undefined body share. NaN drops the row
         rather than calling it a full body, which is what 0/0 -> 1 would. */
      bodyShare: range > 0 ? Math.abs(b.c - b.o) / range : Number.NaN,
      hourUtc: new Date(b.t).getUTCHours(),
      dayOfWeek: new Date(b.t).getUTCDay(),
    };

    if (volAvg !== null) {
      const va = volAvg[i] as number;
      row["volRatio"] = finite(va) && va > 0 ? b.v / va : Number.NaN;
    }

    /* A ROW WITH A HOLE IN IT IS NOT A ROW. Handing the model a zero where a
       value could not be computed teaches it that "unknown" looks like
       "average", and the rows it happens to on are the warm-up and the gaps —
       exactly the ones with the least to say. */
    for (const k of names) if (!finite(row[k])) return null;
    return row;
  };

  return { names, featuresAt, omitted };
}
