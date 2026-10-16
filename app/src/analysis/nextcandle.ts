/**
 * The next candle, drawn — with the direction earned rather than assumed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS A NAMED DEVIATION FROM `forecast.ts`, WHICH REFUSES EXACTLY THIS
 *
 * That file opens: "There is no next-candle direction call here and there will
 * not be one… A terminal that prints 'next candle: UP 71%' is not more powerful
 * than one that does not — it is converting its own noise into your position
 * size, which is the single most expensive thing a tool like this can do to
 * somebody." Every word of that is right and none of it is walked back here.
 *
 * What changes is the request. The owner asked to SEE a predicted candle and
 * then find out whether it was right — and the danger the refusal names is an
 * unscored confident number, not a drawn and measured one. A forecast that is
 * visible, charged for, and graded against what actually happened is the one
 * form of this that makes somebody better calibrated instead of worse.
 *
 * So the deviation is narrow and these four things hold it in place:
 *
 * 1. **THE EDGE IS MEASURED ON THIS SERIES.** Every past occurrence of the
 *    pattern, the next bar's return, a mean and a standard error. Never a
 *    textbook claim about what a bullish harami "means" — those claims are the
 *    reason this feature is usually dishonest.
 *
 * 2. **PICKING THE BEST PATTERN IS A SEARCH, AND IT IS CHARGED FOR.** Six
 *    patterns tried and the best one drawn is a best-of-six, which looks good on
 *    pure noise. `expectedMaxNormal` — the same function the strategy search
 *    pays — sets the t it has to clear.
 *
 * 3. **NO DIRECTION IS THE DEFAULT, and on most bars it is the answer.** Open
 *    equals close, the body collapses to a line, and the panel says why. A body
 *    drawn on nothing is precisely what `forecast.ts` refuses.
 *
 * 4. **ONLY THE BODY IS EVER A CLAIM.** The high and low come from the
 *    volatility model, which that file argues is genuinely forecastable and
 *    which already replays itself to check its own calibration.
 *
 * And it is SCORED: `scoreCandle` grades the band and the direction separately,
 * because they are different claims from different models and pooling them lets
 * a well-behaved band hide a useless direction.
 */

import type { BarView } from "../chart/series";
import type { RangeForecast } from "./forecast";
import type { AnalogueForecast } from "./analogue";
import { expectedMaxNormal } from "../study/stats";

/* ------------------------------------------------------------ patterns --- */

export const PATTERNS = [
  "bullish-engulfing",
  "bearish-engulfing",
  "bullish-harami",
  "bearish-harami",
  "hammer",
  "shooting-star",
] as const;

export type PatternName = (typeof PATTERNS)[number];

const body = (b: BarView): number => Math.abs(b.c - b.o);
const range = (b: BarView): number => b.h - b.l;
const up = (b: BarView): boolean => b.c > b.o;
const down = (b: BarView): boolean => b.c < b.o;

/**
 * Which patterns fire ON bar `i`.
 *
 * CAUSAL BY CONSTRUCTION: it reads `i` and `i - 1` and nothing after. That is
 * not a detail — a matcher that peeked one bar forward would produce a
 * beautiful measured edge and a forecast that could never be traded, and the
 * test truncates the series at `i` to prove it.
 *
 * The thresholds are deliberately loose. A tight definition finds fewer
 * occurrences, and fewer occurrences is a wider confidence interval, which the
 * charge in `bestEdge` then refuses — so being strict here would quietly turn
 * every pattern into "not enough data" rather than into an honest answer.
 */
export function matchPatterns(bars: readonly BarView[], i: number): PatternName[] {
  const cur = bars[i];
  const prev = bars[i - 1];
  if (cur === undefined || prev === undefined) return [];

  const out: PatternName[] = [];
  const r = range(cur);
  if (!(r > 0)) return out;

  const bCur = body(cur);
  const bPrev = body(prev);

  /* ENGULFING: this body covers the previous one, opposite colour. */
  if (down(prev) && up(cur) && cur.c >= prev.o && cur.o <= prev.c && bCur > bPrev) {
    out.push("bullish-engulfing");
  }
  if (up(prev) && down(cur) && cur.c <= prev.o && cur.o >= prev.c && bCur > bPrev) {
    out.push("bearish-engulfing");
  }

  /* HARAMI: the mirror — a small body CONTAINED inside a large opposite one.
     The owner named this pattern; it is the reason the containment test is
     written as the strict inverse of engulfing rather than as a near-miss. */
  const containedIn = (small: BarView, large: BarView): boolean => {
    const hi = Math.max(large.o, large.c);
    const lo = Math.min(large.o, large.c);
    return Math.max(small.o, small.c) <= hi && Math.min(small.o, small.c) >= lo;
  };
  if (down(prev) && up(cur) && bPrev > bCur * 1.5 && containedIn(cur, prev)) {
    out.push("bullish-harami");
  }
  if (up(prev) && down(cur) && bPrev > bCur * 1.5 && containedIn(cur, prev)) {
    out.push("bearish-harami");
  }

  /* HAMMER / SHOOTING STAR: a long wick on one side, a small body at the other
     end. Read from the WICK, never from the colour — a hammer is a hammer
     whether it closed green or red, and gating on colour is how this pattern
     comes to have half the occurrences it should. */
  const upper = cur.h - Math.max(cur.o, cur.c);
  const lower = Math.min(cur.o, cur.c) - cur.l;
  if (lower >= r * 0.55 && bCur <= r * 0.35 && upper <= r * 0.2) out.push("hammer");
  if (upper >= r * 0.55 && bCur <= r * 0.35 && lower <= r * 0.2) out.push("shooting-star");

  return out;
}

/* ---------------------------------------------------------------- edge --- */

/** Fewer occurrences than this and no mean is quoted. */
export const MIN_OCCURRENCES = 25;

export interface Edge {
  readonly pattern: PatternName;
  /** Occurrences that had a following bar to measure. */
  readonly n: number;
  /** Mean log return of the bar AFTER the pattern. */
  readonly mean: number;
  readonly stdErr: number;
  /** mean / stdErr. How many standard errors from zero. */
  readonly t: number;
  /** Set by `bestEdge`, which knows how wide the search was. */
  readonly usable: boolean;
  readonly why: string;
}

/**
 * What happened on the bar after this pattern, every time it has appeared here.
 *
 * `usable` is left FALSE here on purpose. Whether a t of 2.3 is worth anything
 * depends on how many patterns were tried to find it, and this function does not
 * know — `bestEdge` does, and it is the only place that may say yes.
 */
export function patternEdge(bars: readonly BarView[], pattern: PatternName): Edge {
  const rets: number[] = [];
  /* Stops at `length - 1`: the last bar has no following bar, and counting it
     would be measuring an outcome that has not happened. */
  for (let i = 1; i < bars.length - 1; i++) {
    if (!matchPatterns(bars, i).includes(pattern)) continue;
    const a = bars[i] as BarView;
    const b = bars[i + 1] as BarView;
    if (a.c > 0 && b.c > 0) rets.push(Math.log(b.c / a.c));
  }

  const n = rets.length;
  if (n < 2) {
    return {
      pattern,
      n,
      mean: Number.NaN,
      stdErr: Number.NaN,
      t: Number.NaN,
      usable: false,
      why: `${pattern} has appeared ${n} time${n === 1 ? "" : "s"} here — nothing to measure`,
    };
  }

  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const varr = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  const stdErr = Math.sqrt(varr / n);
  const t = stdErr > 0 ? mean / stdErr : Number.NaN;

  return {
    pattern,
    n,
    mean,
    stdErr,
    t,
    usable: false,
    why:
      n < MIN_OCCURRENCES
        ? `${pattern}: ${n} occurrences, below the ${MIN_OCCURRENCES} needed to quote a mean`
        : `${pattern}: ${n} occurrences, next bar averaged ${(mean * 100).toFixed(2)}% ` +
          `(${t >= 0 ? "+" : "−"}${Math.abs(t).toFixed(1)} standard errors from zero)`,
  };
}

export interface BestEdge {
  readonly edge: Edge | null;
  /** The |t| a pattern had to clear, given how many were tried. */
  readonly hurdle: number;
  readonly tried: number;
  readonly why: string;
}

/**
 * The strongest pattern among those that fire, charged for the search.
 *
 * THE BEST OF SIX LOOKS BETTER THAN ONE BY LUCK ALONE. `expectedMaxNormal(k)` is
 * how far above zero the best of k standard normals sits when nothing is there —
 * the same charge `deflatedSharpe` applies to the strategy search, and the same
 * reason. Using a flat |t| >= 2 here would license one false pattern in roughly
 * every twenty draws, forever, on a control that repaints every bar.
 *
 * TWO STANDARD ERRORS PLUS THE CHARGE, not the larger of the two. My first
 * version was `max(2, expectedMaxNormal(k))` and the charge was FICTIONAL:
 * `expectedMaxNormal(6)` is about 1.3, so the floor swallowed it and six
 * patterns cost exactly what one did. The test that caught it asked only that a
 * wider search cost more, and it did not.
 *
 * Added instead: a single hypothesis still has to clear two standard errors, and
 * the best of k gets `expectedMaxNormal(k)` of that for free, so it must clear
 * that much again. Conservative, and it rises with k, which is the whole point.
 */
export function bestEdge(
  bars: readonly BarView[],
  patterns: readonly PatternName[] = PATTERNS,
): BestEdge {
  const hurdle = 2 + expectedMaxNormal(Math.max(1, patterns.length));
  const measured = patterns.map((p) => patternEdge(bars, p));

  let best: Edge | null = null;
  for (const e of measured) {
    if (e.n < MIN_OCCURRENCES || !Number.isFinite(e.t)) continue;
    if (Math.abs(e.t) < hurdle) continue;
    if (best === null || Math.abs(e.t) > Math.abs(best.t)) best = e;
  }

  if (best === null) {
    return {
      edge: null,
      hurdle,
      tried: patterns.length,
      why:
        `none of the ${patterns.length} patterns has a measurable edge on this market — ` +
        `the best would need ${hurdle.toFixed(1)} standard errors to beat a search this wide`,
    };
  }
  return {
    edge: { ...best, usable: true },
    hurdle,
    tried: patterns.length,
    why: best.why,
  };
}

/* ------------------------------------------------------------ the candle -- */

/**
 * Where the drawn body came from.
 *
 * `pattern` outranks `analogue` because it is the STRONGER claim: a named
 * pattern whose measured edge cleared a best-of-six hurdle is a hypothesis that
 * was stated and then paid for, where the analogue is a median over neighbours
 * with no such charge. It is also the rarer one — MEASURED on this operator's
 * own market, no pattern clears at 1m, 15m or 1h, so in practice the analogue
 * is what draws and the pattern path is the exception that outranks it when it
 * finally fires.
 */
export type ForecastBasis = "pattern" | "analogue" | "none";

export interface CandleForecast {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly basis: ForecastBasis;
  /** The pattern the body came from, when there is one. */
  readonly pattern: string | null;
  /**
   * Share of analogues that agreed with the body's direction, 0.5..1, or NaN
   * when the body did not come from analogues.
   *
   * NOT a probability that the call is right, and it must never be printed as
   * one. It is how much the evidence agrees with ITSELF — `replayAnalogue` is
   * the only thing here that measures whether the call was ever correct.
   */
  readonly agree: number;
  readonly why: string;
}

/**
 * Assemble the drawn candle.
 *
 * THE OPEN IS AN ASSUMPTION AND IS NAMED AS ONE. On a continuous feed the next
 * bar opens at the last close; across a weekend or a session break it does not,
 * and on those series the whole candle shifts with the gap. Saying so costs a
 * clause and stops the drawing being read as more certain than it is.
 *
 * THE BODY IS CLAMPED INTO THE BAND. A close outside the forecast high or low
 * would be a candle escaping its own interval — visibly incoherent, and an
 * invitation to believe the body over the one part that has been calibrated.
 */
export function forecastCandle(
  bars: readonly BarView[],
  band: RangeForecast,
  edge: Edge | null,
  analogue: AnalogueForecast | null = null,
): CandleForecast {
  const last = bars[bars.length - 1];
  const open = last?.c ?? Number.NaN;
  /**
   * THE BAND IS RE-CENTRED ON THE OPEN, using its WIDTH rather than its bounds.
   *
   * `forecastRange` builds its interval around the last close, so in the product
   * the two already agree. They can disagree by a tick when the band was
   * computed a moment earlier — and my first version took `max(band.high, open)`,
   * which silently set `high = open` whenever the open sat above the band and
   * clamped every upward body to zero. A direction that vanishes because two
   * numbers were computed a moment apart is worse than no direction, because it
   * looks like the model declining to call it.
   *
   * It also matches what the canvas already documents: "the box is symmetric
   * about the last price by construction".
   */
  const half = Math.abs(band.high - band.low) / 2;
  const high = open + half;
  const low = open - half;

  const note =
    "Opens at the last close, which holds on a continuous feed and not across a " +
    "weekend or session gap.";

  if (!Number.isFinite(open) || bars.length < 2) {
    return {
      open,
      high,
      low,
      close: open,
      basis: "none",
      pattern: null,
      agree: Number.NaN,
      why: `Not enough history to forecast a candle. ${note}`,
    };
  }

  /**
   * THE WICKS COME FROM THE ANALOGUE WHERE THERE IS ONE, AND THAT IS THE
   * MEASURED PART OF THIS DRAWING.
   *
   * Walk-forward on this operator's own archive, median absolute error of the
   * next bar's RANGE: the analogue 0.236 ATR against flat ATR(14) at 0.363 on
   * BTCUSDT 1h — 35% better, on 1,500 bars, z +4.75. At 1m the two tie. So the
   * height and the wicks of this candle are a real forecast conditioned on the
   * setup, where the band around them is one width for every bar.
   *
   * With no analogue the wicks fall back to the band's own edges, which is a
   * wider and blunter statement and is drawn identically — the `basis` field is
   * what separates them, and every surface that shows this reads it.
   */
  const wickHigh = analogue === null ? high : analogue.high;
  const wickLow = analogue === null ? low : analogue.low;

  let close = open;
  let basis: ForecastBasis = "none";
  let pattern: string | null = null;
  let agree = Number.NaN;
  let why = `No directional call, and no analogues to take one from. ${note}`;

  if (edge !== null && edge.usable) {
    /* CLAMPED INTO THE BAND, NOT INTO THE WICKS. The band is the calibrated
       interval and is the right sanity bound; clamping into the analogue's
       median wicks would let a typical-sized bar veto a measured pattern. */
    close = Math.min(high, Math.max(low, open * Math.exp(edge.mean)));
    basis = "pattern";
    pattern = edge.pattern;
    why = `${edge.pattern}: ${edge.why}. ${note}`;
  } else if (analogue !== null) {
    close = Math.min(high, Math.max(low, analogue.close));
    basis = "analogue";
    agree = analogue.agree;
    why =
      `Drawn from ${analogue.why}. The SHAPE is a measured forecast; the ` +
      `DIRECTION is the median of those neighbours and is graded on screen ` +
      `against what always calling one way would have scored. ${note}`;
  }

  return {
    open,
    /* THE WICKS MUST CONTAIN THE BODY. A high below the close is not a
       rendering glitch, it is a drawing that says something impossible. */
    high: Math.max(wickHigh, open, close),
    low: Math.min(wickLow, open, close),
    close,
    basis,
    pattern,
    agree,
    why,
  };
}

/* ---------------------------------------------------------------- score -- */

export interface CandleScore {
  /** Did the actual close land inside the forecast band? */
  readonly inBand: boolean;
  /**
   * Was the body's direction right? `null` when no direction was called.
   *
   * NOT FOLDED INTO A WIN OR A LOSS. A forecast that declined to call the
   * direction must not be scored as correct because price happened to rise —
   * that would make the hit rate a statement about the market rather than about
   * the model, which is the same error as counting a pending claim as evidence.
   */
  readonly directionRight: boolean | null;
}

export function scoreCandle(f: CandleForecast, actual: BarView): CandleScore {
  const inBand = actual.c >= f.low && actual.c <= f.high;
  if (f.basis === "none" || f.close === f.open) return { inBand, directionRight: null };
  const predictedUp = f.close > f.open;
  const actualUp = actual.c > f.open;
  return { inBand, directionRight: predictedUp === actualUp };
}
