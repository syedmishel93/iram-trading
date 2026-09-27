/**
 * Transparent strategies.
 *
 * Each one states its rules in the object itself, so the tester shows the
 * strategy rather than a name and a curve. These exist to put the terminal's
 * OWN machinery on trial — the indicators, the confluence engine, the structure
 * detector — rather than to be good strategies. If the confluence engine has no
 * edge, the honest outcome is a validation run that says so.
 *
 * Every entry sets its stop from ATR, so risk is comparable across symbols and
 * volatility regimes, and the R-multiples from different runs mean the same
 * thing.
 */

import { ema, rsi, atr, bollinger, adx } from "../chart/indicators";
import { confluence } from "../scan/confluence";
import { ordinal } from "../analysis/leading";
import type { ScanBars } from "../scan/confluence";
import type { EntrySignal, Strategy, StrategyContext } from "./engine";

export interface RuleDoc {
  entry: string;
  exit: string;
  stop: string;
}

export interface DocumentedStrategy extends Strategy {
  rules: RuleDoc;
  params: Record<string, number>;
}

/** Indicator columns are computed once per run and cached against the context. */
const cache = new WeakMap<StrategyContext, Map<string, Float64Array>>();

function cached(ctx: StrategyContext, key: string, build: () => Float64Array): Float64Array {
  let table = cache.get(ctx);
  if (!table) {
    table = new Map();
    cache.set(ctx, table);
  }
  const hit = table.get(key);
  if (hit) return hit;
  const built = build();
  table.set(key, built);
  return built;
}

const scanBars = (ctx: StrategyContext): ScanBars => ({
  t: ctx.time,
  o: ctx.open,
  h: ctx.high,
  l: ctx.low,
  c: ctx.close,
  v: ctx.volume,
});

/**
 * EMA trend-following with an ATR stop.
 *
 * The plainest possible trend system, included as a BASELINE. Anything more
 * elaborate has to beat this, and a surprising amount of complexity does not.
 */
export function emaTrend(fast = 20, slow = 50, atrMult = 2, rr = 2): DocumentedStrategy {
  return {
    id: `ema-${fast}-${slow}-${atrMult}x${rr}`,
    label: `EMA ${fast}/${slow} trend`,
    warmup: Math.max(slow, 14) + 5,
    params: { fast, slow, atrMult, rr },
    rules: {
      entry: `EMA${fast} crosses above EMA${slow} for longs, below for shorts`,
      stop: `${atrMult} x ATR(14) from entry`,
      exit: `fixed target at ${rr}R, or the stop`,
    },

    entry(ctx, i) {
      const f = cached(ctx, `ema${fast}`, () => ema(ctx.close, fast));
      const s = cached(ctx, `ema${slow}`, () => ema(ctx.close, slow));
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));

      const fNow = f[i] as number;
      const sNow = s[i] as number;
      const fPrev = f[i - 1] as number;
      const sPrev = s[i - 1] as number;
      const atrNow = a[i] as number;
      if (![fNow, sNow, fPrev, sPrev, atrNow].every(Number.isFinite) || atrNow <= 0) return null;

      const crossedUp = fPrev <= sPrev && fNow > sNow;
      const crossedDown = fPrev >= sPrev && fNow < sNow;
      if (!crossedUp && !crossedDown) return null;

      const price = ctx.close[i] as number;
      const risk = atrNow * atrMult;
      const direction = crossedUp ? "long" : "short";

      return {
        direction,
        stop: crossedUp ? price - risk : price + risk,
        target: crossedUp ? price + risk * rr : price - risk * rr,
        reason:
          `EMA${fast} crossed ${crossedUp ? "above" : "below"} EMA${slow} ` +
          `(${fNow.toFixed(2)} vs ${sNow.toFixed(2)}); stop ${atrMult}x ATR = ${risk.toFixed(2)}`,
      } satisfies EntrySignal;
    },
  };
}

/**
 * Mean reversion on RSI extremes, with a trend filter.
 *
 * Included because it fails differently from trend-following: it wins often and
 * loses big, so a high win rate here proves nothing on its own — which is
 * exactly the kind of result the metrics module is built to caveat.
 */
export function rsiReversion(period = 14, low = 30, high = 70, atrMult = 2, rr = 1.5): DocumentedStrategy {
  return {
    id: `rsi-${period}-${low}-${high}-${atrMult}x${rr}`,
    label: `RSI(${period}) reversion`,
    warmup: Math.max(period, 200) + 5,
    params: { period, low, high, atrMult, rr },
    rules: {
      entry: `RSI crosses back up through ${low} above EMA200, or down through ${high} below it`,
      stop: `${atrMult} x ATR(14)`,
      exit: `target at ${rr}R, or the stop`,
    },

    entry(ctx, i) {
      const r = cached(ctx, `rsi${period}`, () => rsi(ctx.close, period));
      const trend = cached(ctx, "ema200", () => ema(ctx.close, 200));
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));

      const rNow = r[i] as number;
      const rPrev = r[i - 1] as number;
      const t200 = trend[i] as number;
      const atrNow = a[i] as number;
      if (![rNow, rPrev, t200, atrNow].every(Number.isFinite) || atrNow <= 0) return null;

      const price = ctx.close[i] as number;
      const risk = atrNow * atrMult;
      // The trend filter is the whole point: buying oversold in a downtrend is
      // how mean reversion produces a lovely equity curve and then one loss
      // that erases it.
      const longSetup = rPrev <= low && rNow > low && price > t200;
      const shortSetup = rPrev >= high && rNow < high && price < t200;
      if (!longSetup && !shortSetup) return null;

      return {
        direction: longSetup ? "long" : "short",
        stop: longSetup ? price - risk : price + risk,
        target: longSetup ? price + risk * rr : price - risk * rr,
        reason:
          `RSI ${rPrev.toFixed(1)} → ${rNow.toFixed(1)} crossed ${longSetup ? `up through ${low}` : `down through ${high}`} ` +
          `with price ${longSetup ? "above" : "below"} EMA200 ${t200.toFixed(2)}`,
      } satisfies EntrySignal;
    },
  };
}

/**
 * The confluence engine, on trial.
 *
 * This is the one that matters: it takes a position when the terminal's own
 * glass-box score is decisive, and its validation result is a direct statement
 * about whether that score predicts anything.
 *
 * Recomputing confluence at every bar over a growing window is O(n^2) and would
 * be intolerable, so it is evaluated on a `stride` — which is honest as long as
 * it is stated: the strategy simply does not look every bar.
 */
export function confluenceStrategy(
  minScore = 0.35,
  minConfidence = 0.4,
  atrMult = 2,
  rr = 2,
  stride = 4,
): DocumentedStrategy {
  return {
    id: `confluence-${minScore}-${minConfidence}-${atrMult}x${rr}`,
    label: `Confluence ≥ ${minScore}`,
    warmup: 215,
    params: { minScore, minConfidence, atrMult, rr, stride },
    rules: {
      entry: `glass-box confluence score beyond ±${minScore} with confidence ≥ ${minConfidence}`,
      stop: `${atrMult} x ATR(14)`,
      exit: `target at ${rr}R, or the stop`,
    },

    entry(ctx, i) {
      // Only look every `stride` bars — stated in `rules`, not hidden.
      if (i % stride !== 0) return null;

      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));
      const atrNow = a[i] as number;
      if (!Number.isFinite(atrNow) || atrNow <= 0) return null;

      // Only bars 0..i. Passing the whole array would let the engine read the
      // future through the very module the test is meant to evaluate.
      const window = i + 1;
      const src = scanBars(ctx);
      const view: ScanBars = {
        t: src.t.subarray(0, window),
        o: src.o.subarray(0, window),
        h: src.h.subarray(0, window),
        l: src.l.subarray(0, window),
        c: src.c.subarray(0, window),
        v: src.v.subarray(0, window),
      };

      const read = confluence(view);
      if (read.insufficient) return null;
      if (Math.abs(read.score) < minScore || read.confidence < minConfidence) return null;

      const price = ctx.close[i] as number;
      const risk = atrNow * atrMult;
      const long = read.score > 0;
      const top = read.signals
        .filter((s) => s.weight > 0 && s.direction !== "neutral")
        .slice(0, 2)
        .map((s) => s.reason)
        .join("; ");

      return {
        direction: long ? "long" : "short",
        stop: long ? price - risk : price + risk,
        target: long ? price + risk * rr : price - risk * rr,
        reason: `confluence ${read.score.toFixed(2)} (confidence ${read.confidence.toFixed(2)}) — ${top}`,
      } satisfies EntrySignal;
    },
  };
}

/**
 * A parameter grid, for walk-forward and PBO.
 *
 * Deliberately modest. A grid of 500 variants guarantees one of them fits the
 * noise perfectly, and PBO exists precisely to expose that — but the honest
 * move is not to create the problem in the first place.
 */
/* ═══════════════════════════════════════════════════════════════════════════
   v46 — three systems that trade the terminal's OWN new machinery.

   The point of these is not that they are good. It is that the claims made
   elsewhere in this codebase become FALSIFIABLE: analysis/leading.ts asserts
   that volatility compression is leading about timing, and that positioning is
   leading about direction. A strategy is how that assertion gets tested
   against costs, on out-of-sample data, with the overfitting machinery in
   validate.ts watching. If a squeeze has no edge, the honest outcome is a
   walk-forward run that says so, and the module comment gets rewritten.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Rolling percentile rank of a series against its own trailing window.
 *
 * Computed ONCE per run and cached, so the strategy stays O(n·window) instead
 * of re-ranking inside the per-bar callback. Ties count as half, matching
 * analysis/leading.ts — the two must agree or the backtest is testing a
 * different rule from the one the desk displays.
 */
export function rollingPercentile(src: Float64Array, window: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = window; i < n; i++) {
    const v = src[i] as number;
    if (!Number.isFinite(v)) continue;
    let below = 0;
    let equal = 0;
    let counted = 0;
    for (let j = i - window; j < i; j++) {
      const u = src[j] as number;
      if (!Number.isFinite(u)) continue;
      counted++;
      if (u < v) below++;
      else if (u === v) equal++;
    }
    out[i] = counted === 0 ? NaN : (below + equal / 2) / counted;
  }
  return out;
}

function bandwidth(ctx: StrategyContext, period: number): Float64Array {
  const bb = bollinger(ctx.close, period, 2);
  const n = ctx.close.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const m = bb.middle[i] as number;
    if (Number.isFinite(m) && m !== 0) out[i] = ((bb.upper[i] as number) - (bb.lower[i] as number)) / m;
  }
  return out;
}

/**
 * Squeeze breakout — the test of the "coiled" family.
 *
 * Wait for Bollinger bandwidth to sit in the tightest `pctile` of its own
 * recent history, then take the FIRST close outside the band, in whichever
 * direction that break happens to go.
 *
 * TAKING THE BREAK RATHER THAN PREDICTING IT is the whole design. leading.ts
 * says a squeeze carries information about timing and none about direction, so
 * a strategy that guessed the direction of a squeeze would be testing a claim
 * this codebase does not make. This one lets the market supply the direction
 * and only supplies the timing itself.
 *
 * The known failure mode is the false break, and it is not hidden: the stop is
 * placed on the opposite side of the band, so a break that immediately reverses
 * is a fast, cheap loss rather than a slow expensive one. Whether that trade-off
 * pays is exactly what the walk-forward run is for.
 *
 * THE SQUEEZE CONDITION DOES NOT MAKE THIS SELECTIVE, and a test proved it: on
 * a permanently wide market this still found entries, because the tightest 20%
 * of a series is 20% of it whatever the series is doing. Every bit of the
 * selectivity comes from the second requirement — a close outside the band. If
 * the walk-forward result is poor, that is the clause to attack, not `pctile`.
 *
 * It also cannot see a contraction longer than `rank` bars, for the same
 * reason: by then the ranking window is made of the contraction. Both
 * parameters exist so that can be moved rather than argued about.
 */
export function squeezeBreakout(period = 20, rank = 120, pctile = 0.15, atrMult = 1.5, rr = 2): DocumentedStrategy {
  return {
    id: `squeeze-${period}-${rank}-${pctile}-${atrMult}x${rr}`,
    label: `Squeeze break (${period}, p${Math.round(pctile * 100)})`,
    warmup: rank + period + 5,
    params: { period, rank, pctile, atrMult, rr },
    rules: {
      entry: `Bollinger bandwidth in the tightest ${Math.round(pctile * 100)}% of the last ${rank} bars, then a close outside the band`,
      stop: `${atrMult} x ATR(14), never tighter than the far side of the band`,
      exit: `fixed target at ${rr}R, or the stop`,
    },

    entry(ctx, i) {
      const bw = cached(ctx, `bw${period}`, () => bandwidth(ctx, period));
      const pct = cached(ctx, `bwp${period}-${rank}`, () => rollingPercentile(bw, rank));
      const bb = cached(ctx, `bbU${period}`, () => bollinger(ctx.close, period, 2).upper);
      const bl = cached(ctx, `bbL${period}`, () => bollinger(ctx.close, period, 2).lower);
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));

      /* The squeeze condition is read at the PREVIOUS bar and the break at this
         one. Reading both at i would enter on a bar whose own range is what
         widened the band, which is a look-ahead wearing a disguise. */
      const wasCoiled = (pct[i - 1] as number) <= pctile;
      if (!wasCoiled) return null;

      const price = ctx.close[i] as number;
      const upper = bb[i] as number;
      const lower = bl[i] as number;
      const atrNow = a[i] as number;
      if (![price, upper, lower, atrNow].every(Number.isFinite) || atrNow <= 0) return null;

      const up = price > upper;
      const down = price < lower;
      if (!up && !down) return null;

      /* The far band, or the ATR stop, whichever is further away. A stop inside
         the range that just broke is a stop the range will take. */
      const risk = Math.max(atrMult * atrNow, up ? price - lower : upper - price);
      if (!(risk > 0)) return null;

      return {
        direction: up ? "long" : "short",
        stop: up ? price - risk : price + risk,
        target: up ? price + risk * rr : price - risk * rr,
        reason:
          `Bandwidth was at the ${ordinal(((pct[i - 1] as number) || 0) * 100)} percentile of ${rank} bars, ` +
          `then closed ${up ? "above the upper" : "below the lower"} band at ${price.toFixed(2)}`,
      } satisfies EntrySignal;
    },
  };
}

/**
 * Donchian channel breakout — the oldest published trend system there is.
 *
 * Included as a SECOND baseline beside the EMA cross, because the two fail in
 * different places: an EMA cross is late to a fast move and whipsaws in a
 * range, while a channel break is on time and whipsaws in a range differently.
 * A result that beats one and not the other is a result about the entry timing,
 * which is worth knowing and is invisible with a single baseline.
 *
 * The channel is measured over bars 0..i−1. Including bar i would compare the
 * bar to a high it had just set, and nothing would ever break out.
 */
export function donchianBreakout(entryLen = 20, exitLen = 10, atrMult = 2): DocumentedStrategy {
  return {
    id: `donchian-${entryLen}-${exitLen}-${atrMult}`,
    label: `Donchian ${entryLen}/${exitLen}`,
    warmup: Math.max(entryLen, exitLen, 14) + 5,
    params: { entryLen, exitLen, atrMult },
    rules: {
      entry: `close above the highest high of the previous ${entryLen} bars, or below the lowest low`,
      stop: `${atrMult} x ATR(14) from entry`,
      exit: `close back through the ${exitLen}-bar channel in the opposite direction`,
    },

    entry(ctx, i) {
      if (i < entryLen + 1) return null;
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - entryLen; j < i; j++) {
        const h = ctx.high[j] as number;
        const l = ctx.low[j] as number;
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      const price = ctx.close[i] as number;
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));
      const atrNow = a[i] as number;
      if (!Number.isFinite(price) || !Number.isFinite(atrNow) || atrNow <= 0) return null;
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;

      const up = price > hi;
      const down = price < lo;
      if (!up && !down) return null;

      const risk = atrMult * atrNow;
      return {
        direction: up ? "long" : "short",
        stop: up ? price - risk : price + risk,
        reason: up
          ? `Closed ${price.toFixed(2)} above the ${entryLen}-bar high of ${hi.toFixed(2)}`
          : `Closed ${price.toFixed(2)} below the ${entryLen}-bar low of ${lo.toFixed(2)}`,
      } satisfies EntrySignal;
    },

    /* No fixed target. A trend system that caps its winners at 2R throws away
       the fat tail that is the entire reason to follow trends, and the metrics
       would then flatter the win rate while destroying expectancy. */
    exit(ctx, position, i) {
      if (i < exitLen + 1) return null;
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - exitLen; j < i; j++) {
        const h = ctx.high[j] as number;
        const l = ctx.low[j] as number;
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      const price = ctx.close[i] as number;
      if (position.direction === "long" && price < lo) return `closed below the ${exitLen}-bar low`;
      if (position.direction === "short" && price > hi) return `closed above the ${exitLen}-bar high`;
      return null;
    },
  };
}

/**
 * Mean reversion, but only where mean reversion is supposed to work.
 *
 * The claim under test is one everybody repeats: "reversion works in ranges,
 * trend-following works in trends". It is stated constantly and tested almost
 * never. This gates an RSI reversion entry on ADX being BELOW a threshold —
 * that is, on there being no measurable trend — and takes the trade only then.
 *
 * If the claim is right, this should beat `rsiReversion` on the same data. If
 * it is not, the regime filter is costing trades for nothing, and that is a
 * genuinely useful thing to learn about every regime filter in this terminal.
 */
export function regimeGatedReversion(period = 14, low = 30, high = 70, adxMax = 20, atrMult = 2, rr = 1.5): DocumentedStrategy {
  return {
    id: `regrev-${period}-${low}-${adxMax}-${atrMult}x${rr}`,
    label: `Reversion in ranges (ADX<${adxMax})`,
    warmup: Math.max(period, 14 * 3) + 10,
    params: { period, low, high, adxMax, atrMult, rr },
    rules: {
      entry: `ADX(14) below ${adxMax}, then RSI(${period}) crosses back up through ${low} or down through ${high}`,
      stop: `${atrMult} x ATR(14) from entry`,
      exit: `fixed target at ${rr}R, or the stop`,
    },

    entry(ctx, i) {
      const r = cached(ctx, `rsi${period}`, () => rsi(ctx.close, period));
      const dx = cached(ctx, "adx14", () => adx(ctx.high, ctx.low, ctx.close, 14).adx);
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));

      const trend = dx[i] as number;
      if (!Number.isFinite(trend) || trend >= adxMax) return null;

      const now = r[i] as number;
      const prev = r[i - 1] as number;
      const atrNow = a[i] as number;
      if (![now, prev, atrNow].every(Number.isFinite) || atrNow <= 0) return null;

      const crossedUp = prev <= low && now > low;
      const crossedDown = prev >= high && now < high;
      if (!crossedUp && !crossedDown) return null;

      const price = ctx.close[i] as number;
      const risk = atrMult * atrNow;
      return {
        direction: crossedUp ? "long" : "short",
        stop: crossedUp ? price - risk : price + risk,
        target: crossedUp ? price + risk * rr : price - risk * rr,
        reason:
          `ADX ${trend.toFixed(1)} says no trend; RSI crossed ${crossedUp ? "up through" : "down through"} ` +
          `${crossedUp ? low : high} at ${now.toFixed(1)}`,
      } satisfies EntrySignal;
    },
  };
}

export function candidateGrid(): DocumentedStrategy[] {
  const out: DocumentedStrategy[] = [];
  for (const [fast, slow] of [
    [10, 30],
    [20, 50],
    [20, 100],
    [50, 200],
  ] as const) {
    for (const rr of [1.5, 2, 3]) out.push(emaTrend(fast, slow, 2, rr));
  }
  for (const low of [25, 30]) out.push(rsiReversion(14, low, 100 - low, 2, 1.5));
  for (const minScore of [0.3, 0.45]) out.push(confluenceStrategy(minScore, 0.4, 2, 2));

  /* The v46 systems, each with a small parameter spread. The spread is
     deliberately SMALL: every extra candidate in this grid inflates the
     probability of backtest overfitting that validate.ts then measures, and a
     grid wide enough to guarantee a winner is a grid that has guaranteed
     nothing else. */
  for (const rr of [1.5, 2.5]) out.push(squeezeBreakout(20, 120, 0.15, 1.5, rr));
  for (const [entryLen, exitLen] of [[20, 10], [55, 20]] as const) out.push(donchianBreakout(entryLen, exitLen, 2));
  for (const adxMax of [18, 25]) out.push(regimeGatedReversion(14, 30, 70, adxMax, 2, 1.5));
  return out;
}
