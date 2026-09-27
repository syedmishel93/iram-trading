/**
 * What the ORDER of the trades was worth, and what the ENTRIES were worth.
 *
 * A backtest reports one path: these trades, in this order. Two questions that
 * path cannot answer on its own —
 *
 *  1. **Monte Carlo reshuffle.** Had the same trades arrived in a different
 *     order (or had a different sample of trades like them arrived), how deep
 *     could the drawdown have gone? The observed max drawdown is ONE draw from
 *     that distribution, and usually a flattering one, because the configuration
 *     that won the sweep is the one whose losers happened not to cluster.
 *
 *  2. **Random-entry ("monkey") test.** Would entering at random, with the same
 *     holding times and the same direction on the same bars, have done as well?
 *     If so the entry rule is contributing nothing, however good the curve
 *     looks; the market's drift over those holding times did the work.
 *
 * Both are deterministic for a given seed and derive their default seed from
 * the data (see `resample.ts`, "DETERMINISM IS NOT OPTIONAL"). Both refuse
 * under `MIN_MC_TRADES`, the same floor `verdict()` applies — a distribution
 * resampled from twelve numbers is a restatement of twelve numbers.
 */

import type { Costs, Trade } from "./engine";
import type { BarView } from "../chart/series";
import { rng, seedFrom } from "./resample";

/** The trade floor for both tests. Matches `verdict()`'s "not a sample". */
export const MIN_MC_TRADES = 30;

/**
 * Default replicate count.
 *
 * MEASURED (vitest under node, this machine, 3 reps, 2,000 draws):
 *
 *   trades   bootstrap   shuffle   random-entry
 *       60     4–8 ms     3–19 ms      5–11 ms
 *      200    11–13 ms   10–11 ms     16–23 ms
 *    1,000    53–62 ms   46–56 ms     78–97 ms
 *
 * Linear in draws × trades. Together at 200 trades they already fill a ~30 ms
 * frame, so the desk runs each in its OWN frame and caps the work with
 * `drawsFor` below rather than chunking a single test across frames.
 */
export const MC_DRAWS = 2_000;

/** draws × trades a single frame can afford: ~12–20 ms by the table above. */
export const DRAW_BUDGET = 400_000;
/** Below this, percentiles at p5/p95 rest on ~25 draws per tail — too few. */
export const MIN_DRAWS = 500;

/**
 * Draws for a given trade count under `DRAW_BUDGET`, never under `MIN_DRAWS`.
 * 200 trades gets the full 2,000; 1,000 trades gets 500 (~15 ms / ~20 ms). The
 * count actually drawn is returned in every result, so the desk can show it.
 */
export function drawsFor(trades: number): number {
  if (trades <= 0) return MC_DRAWS;
  return Math.max(MIN_DRAWS, Math.min(MC_DRAWS, Math.floor(DRAW_BUDGET / trades)));
}

/** The drawdown the ruin probability is quoted against unless told otherwise. */
export const DEFAULT_RUIN = 0.3;

export interface Spread {
  readonly p5: number;
  readonly p50: number;
  readonly p95: number;
}

const NO_SPREAD: Spread = { p5: 0, p50: 0, p95: 0 };

/**
 * Nearest-rank percentile of an ASCENDING array: the smallest value with at
 * least `q` of the sample at or below it. Chosen over interpolation because it
 * always returns a value that was actually drawn.
 */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[k] as number;
}

const spreadOf = (sorted: ArrayLike<number>): Spread => ({
  p5: percentile(sorted, 0.05),
  p50: percentile(sorted, 0.5),
  p95: percentile(sorted, 0.95),
});

/**
 * - `shuffle`: every path is a permutation of the observed trades. The final
 *   return is then IDENTICAL on every path (compounding commutes) — only the
 *   path, i.e. drawdown and streaks, is being tested.
 * - `bootstrap`: every path draws the same number of trades WITH replacement.
 *   The final return varies too. It assumes trades are independent draws from
 *   one distribution, which a trend rule's clustered losers are not; the
 *   shuffle keeps the exact outcome set and makes a weaker claim.
 */
export type McMode = "shuffle" | "bootstrap";

export interface MonteCarloOptions {
  draws?: number;
  seed?: number;
  mode?: McMode;
  /** Drawdown, as a fraction, counted as ruin. Default 0.3. */
  ruinDrawdown?: number;
}

export interface MonteCarloResult {
  /** Why nothing was drawn, or null. */
  readonly refused: string | null;
  readonly mode: McMode;
  readonly trades: number;
  readonly draws: number;
  readonly seed: number;
  readonly riskPerTrade: number;
  readonly ruinDrawdown: number;
  /** Max drawdown per path, as a positive fraction. */
  readonly maxDrawdown: Spread;
  /** Final equity − 1 per path. */
  readonly finalReturn: Spread;
  /** Longest run of losing (R ≤ 0) trades per path. */
  readonly losingStreak: Spread;
  /** Share of paths whose drawdown reached `ruinDrawdown`. */
  readonly ruinProbability: number;
  /** Every path's max drawdown, ascending — the histogram's input. */
  readonly drawdowns: Float64Array;
}

const refusedMc = (
  why: string,
  trades: number,
  mode: McMode,
  risk: number,
  ruin: number,
): MonteCarloResult => ({
  refused: why,
  mode,
  trades,
  draws: 0,
  seed: 0,
  riskPerTrade: risk,
  ruinDrawdown: ruin,
  maxDrawdown: NO_SPREAD,
  finalReturn: NO_SPREAD,
  losingStreak: NO_SPREAD,
  ruinProbability: 0,
  drawdowns: new Float64Array(0),
});

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Resample the trade sequence and report the spread of outcomes.
 *
 * Each trade moves equity by `× (1 + R × risk)` — exactly the compounding
 * `engine.ts` applies (`capital *= 1 + net × risk / riskPerUnit`, and
 * `R = net / riskPerUnit`). A step that would take equity through zero stops at
 * zero: the account is gone and later trades cannot be placed.
 */
export function monteCarlo(
  rMultiples: readonly number[],
  riskPerTrade: number,
  opts: MonteCarloOptions = {},
): MonteCarloResult {
  const mode = opts.mode ?? "bootstrap";
  const ruin = opts.ruinDrawdown ?? DEFAULT_RUIN;
  const n = rMultiples.length;

  if (n < MIN_MC_TRADES) {
    return refusedMc(
      `${plural(n, "trade")}; ${MIN_MC_TRADES} needed before reordering them describes anything`,
      n,
      mode,
      riskPerTrade,
      ruin,
    );
  }
  if (!(riskPerTrade > 0) || riskPerTrade > 1) {
    return refusedMc("risk per trade must be a fraction between 0 and 1", n, mode, riskPerTrade, ruin);
  }
  if (rMultiples.some((r) => !Number.isFinite(r))) {
    return refusedMc("a trade outcome is not a finite number; refusing rather than dropping it", n, mode, riskPerTrade, ruin);
  }

  const draws = Math.max(1, Math.floor(opts.draws ?? MC_DRAWS));
  const seed = opts.seed ?? (seedFrom(rMultiples) ^ 0x5bd1e995);
  const next = rng(seed);

  const dds = new Float64Array(draws);
  const finals = new Float64Array(draws);
  const streaks = new Float64Array(draws);
  const order = rMultiples.slice();
  let ruined = 0;

  for (let d = 0; d < draws; d++) {
    if (mode === "shuffle") {
      // Fisher-Yates over the running permutation; each draw is uniform.
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = order[i] as number;
        order[i] = order[j] as number;
        order[j] = tmp;
      }
    }
    let eq = 1;
    let peak = 1;
    let worst = 0;
    let run = 0;
    let longest = 0;
    for (let i = 0; i < n; i++) {
      const r = mode === "shuffle" ? (order[i] as number) : (rMultiples[Math.floor(next() * n)] as number);
      eq = Math.max(0, eq * (1 + r * riskPerTrade));
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > worst) worst = dd;
      if (r <= 0) {
        run++;
        if (run > longest) longest = run;
      } else run = 0;
    }
    dds[d] = worst;
    finals[d] = eq - 1;
    streaks[d] = longest;
    if (worst >= ruin) ruined++;
  }

  dds.sort();
  finals.sort();
  streaks.sort();

  return {
    refused: null,
    mode,
    trades: n,
    draws,
    seed,
    riskPerTrade,
    ruinDrawdown: ruin,
    maxDrawdown: spreadOf(dds),
    finalReturn: spreadOf(finals),
    losingStreak: spreadOf(streaks),
    ruinProbability: ruined / draws,
    drawdowns: dds,
  };
}

// ─────────────────────────────────────────────────────── random entries ───

export interface RandomEntryOptions {
  draws?: number;
  seed?: number;
}

export interface RandomEntryResult {
  readonly refused: string | null;
  readonly trades: number;
  readonly draws: number;
  readonly seed: number;
  /** The strategy's mean net return per trade (`Trade.returnPct`). */
  readonly observedMean: number;
  /** Mean of the null's per-draw means. */
  readonly nullMean: number;
  readonly nullP5: number;
  readonly nullP95: number;
  /** Share of random draws whose mean matched or beat the strategy's. */
  readonly beatenShare: number;
  /** One-sided p-value, (hits + 1) / (draws + 1). */
  readonly p: number;
}

const refusedRe = (why: string, trades: number): RandomEntryResult => ({
  refused: why,
  trades,
  draws: 0,
  seed: 0,
  observedMean: 0,
  nullMean: 0,
  nullP5: 0,
  nullP95: 0,
  beatenShare: 0,
  p: 1,
});

/**
 * Ties are resolved AGAINST the strategy. A null that equals the observed mean
 * to within float noise has matched it; counting it as a loss for the null
 * would credit the strategy with rounding error.
 */
const TIE = 1e-12;

/**
 * The monkey test: does the strategy beat random entries with the same
 * holding times?
 *
 * ASSUMPTIONS, each of which is a choice:
 *
 *  - **Measured in net return per trade, not R.** A random entry has no stop,
 *    so it has no R. `Trade.returnPct` is the strategy's net return; the null
 *    is charged the same costs through the same fill model as `engine.ts`
 *    (half the spread plus slippage on each fill, commission on both sides).
 *  - **Same holding time, same direction.** Each null trade copies one real
 *    trade's `exitIndex − entryIndex` and its long/short side. Keeping the
 *    direction is what stops a long-only rule on a rising market being
 *    credited with the drift: random longs earn the drift too.
 *  - **Entry at a bar's open, exit at the close of the bar `hold` later.** The
 *    strategy's exits fill at stop or target prices inside the bar; the null's
 *    at the close. So stop/target placement counts as part of the strategy's
 *    skill — which it is.
 *  - **Entries uniform over the bars the strategy could trade**: from its
 *    first entry (the end of its warm-up) to the last bar that leaves room for
 *    the hold. Null trades may overlap each other; the mean does not care.
 *  - **Trades are treated as independent.** Like every per-trade statistic
 *    here, clustered outcomes make the null narrower than it should be, so a
 *    borderline p-value is weaker than it reads.
 */
export function randomEntryTest(
  bars: readonly BarView[],
  trades: readonly Trade[],
  costs: Costs,
  opts: RandomEntryOptions = {},
): RandomEntryResult {
  const n = trades.length;
  if (n < MIN_MC_TRADES) {
    return refusedRe(`${plural(n, "trade")}; ${MIN_MC_TRADES} needed before a random-entry comparison means anything`, n);
  }

  let first = Infinity;
  const holds = new Int32Array(n);
  const longs = new Uint8Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = trades[i] as Trade;
    const hold = t.exitIndex - t.entryIndex;
    if (!(hold >= 0) || !Number.isFinite(t.returnPct)) {
      return refusedRe("a trade has no measurable holding time or return", n);
    }
    holds[i] = hold;
    longs[i] = t.direction === "long" ? 1 : 0;
    if (t.entryIndex < first) first = t.entryIndex;
    sum += t.returnPct;
  }
  const start = Math.max(0, first);
  let longest = 0;
  for (let i = 0; i < n; i++) longest = Math.max(longest, holds[i] as number);
  const room = bars.length - longest - start;
  if (room < 2) {
    return refusedRe(
      `a holding time of ${longest} bars does not fit in the ${bars.length} bars available from the first entry`,
      n,
    );
  }
  for (const b of bars) {
    if (!(b.o > 0) || !(b.c > 0)) return refusedRe("the bars contain a non-positive price", n);
  }

  const observed = sum / n;
  const half = costs.spread / 2 + costs.slippage;
  const fees = costs.commission * 2;
  const draws = Math.max(1, Math.floor(opts.draws ?? MC_DRAWS));
  const seed = opts.seed ?? (seedFrom(trades.map((t) => t.returnPct)) ^ 0x27d4eb2d);
  const next = rng(seed);

  const means = new Float64Array(draws);
  let hits = 0;
  for (let d = 0; d < draws; d++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const hold = holds[i] as number;
      // Uniform over [start, bars.length - 1 - hold]; `room` guarantees ≥ 1 slot.
      const span = bars.length - hold - start;
      const e = start + Math.floor(next() * span);
      const open = (bars[e] as BarView).o;
      const close = (bars[e + hold] as BarView).c;
      let gross: number;
      if (longs[i] === 1) {
        const inPx = open * (1 + half);
        gross = (close * (1 - half) - inPx) / inPx;
      } else {
        const inPx = open * (1 - half);
        gross = (inPx - close * (1 + half)) / inPx;
      }
      acc += gross - fees;
    }
    const m = acc / n;
    means[d] = m;
    if (m >= observed - TIE) hits++;
  }

  let total = 0;
  for (let d = 0; d < draws; d++) total += means[d] as number;
  means.sort();

  return {
    refused: null,
    trades: n,
    draws,
    seed,
    observedMean: observed,
    nullMean: total / draws,
    nullP5: percentile(means, 0.05),
    nullP95: percentile(means, 0.95),
    beatenShare: hits / draws,
    /* Davison & Hinkley's +1, as in resample.ts: never a p of exactly zero from
       a finite number of draws. */
    p: (hits + 1) / (draws + 1),
  };
}
