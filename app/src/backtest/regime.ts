/**
 * Regime conditioning — turning "51% overall" into an instruction.
 *
 * WHY IT IS WORTH MORE THAN ANOTHER STRATEGY
 * A single expectancy figure averages a strategy over every market condition
 * it met, and most strategies are not one thing. A trend rule that makes
 * +0.6R while price trends and loses −0.3R while it chops does not have a
 * +0.15R edge; it has a trend edge and a chop problem, and those have opposite
 * fixes. The averaged number hides which one you have.
 *
 * "58% in trend, 44% in chop" is an instruction. "51% overall" is a number.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE REGIME IS COMPUTED HERE AND NOT ASKED OF THE PYTHON SERVICE
 *
 * `mishel_hmm.py` fits a Gaussian mixture over (return, volatility) and labels
 * each bar, and `data/intel.ts` can already reach it. It is the better model
 * and it is the wrong dependency for this: the service is OPTIONAL, and a
 * backtest whose results change depending on whether a local process happens
 * to be running is a backtest nobody can reproduce or compare against a run
 * from yesterday.
 *
 * So this is a deliberately simple, deterministic, in-browser classifier over
 * measurements the terminal already computes — ADX for whether there is a
 * trend, and realised volatility percentile for whether it is violent. It is
 * labelled as what it is. When the service IS running, its richer labels
 * belong on the Decision desk, not silently inside a backtest.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE LOOK-AHEAD RULE
 *
 * The volatility percentile is computed over a TRAILING window only. Ranking a
 * bar's volatility against the whole series — including bars after it — is a
 * subtle and very common leak: it makes "this was a quiet period" a judgement
 * informed by what happened next, and every strategy conditioned on it looks
 * better than it is.
 */

import { adx, atr } from "../chart/indicators";
import type { BarView } from "../chart/series";
import type { Trade } from "./engine";
import { computeMetrics, EMPTY_METRICS, type Metrics } from "./metrics";

export type Regime = "trend" | "chop" | "volatile";

export const REGIME_LABEL: Readonly<Record<Regime, string>> = {
  trend: "Trending",
  chop: "Chopping",
  volatile: "Violent",
};

export const REGIME_BLURB: Readonly<Record<Regime, string>> = {
  trend: "ADX above 25 — a directional move was underway.",
  chop: "ADX at or below 25 and volatility unremarkable — the sideways default.",
  volatile: "Realised range in the top fifth of its trailing year, whatever ADX said.",
};

/** ADX above this is conventionally a trend. It is a convention, not a law. */
export const TREND_ADX = 25;

/** Trailing window for the volatility ranking. */
export const VOL_LOOKBACK = 250;

/** Above this percentile of trailing volatility, the regime is "violent". */
export const VOLATILE_PCTILE = 0.8;

/**
 * Label every bar.
 *
 * "Violent" WINS over "trending", and that ordering is the interesting choice:
 * a strong ADX during a volatility spike is usually one enormous candle rather
 * than a trend anybody could have ridden, and filing those bars under "trend"
 * is what makes a trend strategy look better than it traded.
 */
export function classifyRegimes(bars: readonly BarView[]): Regime[] {
  const n = bars.length;
  const out: Regime[] = new Array<Regime>(n).fill("chop");
  if (n < 30) return out;

  const high = Float64Array.from(bars, (b) => b.h);
  const low = Float64Array.from(bars, (b) => b.l);
  const close = Float64Array.from(bars, (b) => b.c);

  const a = adx(high, low, close, 14, n).adx;
  const vol = atr(high, low, close, 14, n);

  for (let i = 0; i < n; i++) {
    const v = vol[i] as number;
    const c = close[i] as number;
    if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0) continue;
    const normalised = v / c;

    /* TRAILING only. Ranking against the whole series would let a bar's label
       depend on bars after it — the leak this file's header warns about. */
    const from = Math.max(0, i - VOL_LOOKBACK);
    let below = 0;
    let seen = 0;
    for (let j = from; j < i; j++) {
      const vj = vol[j] as number;
      const cj = close[j] as number;
      if (!Number.isFinite(vj) || !Number.isFinite(cj) || cj <= 0) continue;
      seen++;
      if (vj / cj < normalised) below++;
    }
    const pctile = seen < 30 ? 0 : below / seen;

    if (pctile >= VOLATILE_PCTILE) {
      out[i] = "volatile";
      continue;
    }
    const adxNow = a[i] as number;
    out[i] = Number.isFinite(adxNow) && adxNow > TREND_ADX ? "trend" : "chop";
  }
  return out;
}

/**
 * Metrics for a SUBSET of trades.
 *
 * `computeMetrics` wants an equity curve, and the run's per-bar curve is the
 * wrong one here: it includes every trade, so slicing the trades and keeping
 * the whole curve would report the same drawdown for every regime.
 *
 * So the curve is rebuilt from the slice's own trades, in sequence. The
 * consequence is worth stating plainly rather than hiding: within a slice,
 * `maxDrawdown` and `sharpe` are measured over the TRADE sequence and not per
 * bar. They are comparable between slices, which is what this file is for, and
 * they are NOT comparable with the whole-run figures. Expectancy, win rate and
 * profit factor are unaffected — they never depended on the curve.
 */
function sliceMetrics(trades: readonly Trade[]): Metrics {
  if (trades.length === 0) return { ...EMPTY_METRICS };
  const equity: number[] = [1];
  let e = 1;
  for (const t of trades) {
    e *= 1 + t.returnPct;
    equity.push(e);
  }
  /* One "bar" per trade, so the annualisation factor is not a per-bar one.
     Passing the trade count keeps the ratio dimensionless and comparable
     across slices, which is the only use it is put to. */
  return computeMetrics(trades, equity, Math.max(1, trades.length));
}

export interface RegimeSlice {
  readonly regime: Regime;
  readonly metrics: Metrics;
  /** Share of the tested bars spent in this regime. */
  readonly exposure: number;
}

/**
 * Split a strategy's trades by the regime it was in WHEN IT ENTERED.
 *
 * Entry rather than exit, and that matters: the question being answered is
 * "should I take this setup in these conditions", which is a decision made at
 * entry with only the information available then. Attributing a trade to the
 * regime it exited in would be scoring the decision by an outcome it could not
 * have known.
 */
export function byRegime(
  trades: readonly Trade[],
  bars: readonly BarView[],
  regimes: readonly Regime[] = classifyRegimes(bars),
): RegimeSlice[] {
  const groups = new Map<Regime, Trade[]>();
  for (const t of trades) {
    const idx = t.entryIndex;
    const reg = regimes[Math.max(0, Math.min(idx, regimes.length - 1))] ?? "chop";
    const list = groups.get(reg);
    if (list === undefined) groups.set(reg, [t]);
    else list.push(t);
  }

  const counts = new Map<Regime, number>();
  for (const r of regimes) counts.set(r, (counts.get(r) ?? 0) + 1);

  const out: RegimeSlice[] = [];
  for (const regime of ["trend", "chop", "volatile"] as const) {
    const list = groups.get(regime) ?? [];
    out.push({
      regime,
      metrics: sliceMetrics(list),
      exposure: regimes.length === 0 ? 0 : (counts.get(regime) ?? 0) / regimes.length,
    });
  }
  return out;
}

/**
 * Fewer trades than this in a regime and the slice is not reported as a
 * finding.
 *
 * Same argument as the journal's sample floor: a 2.4R expectancy over four
 * trades is four numbers, and splitting a thin book three ways is the fastest
 * way to manufacture a spurious one.
 */
export const MIN_REGIME_TRADES = 15;

/**
 * The sentence a strategy row shows about conditions.
 *
 * States a difference only when both sides have a real sample AND the gap is
 * large enough to act on. Everything else says so, rather than reporting a
 * split that is noise wearing a label.
 */
export function regimeLine(slices: readonly RegimeSlice[]): string {
  const usable = slices.filter((s) => s.metrics.trades >= MIN_REGIME_TRADES);
  if (usable.length < 2) {
    const total = slices.reduce((a, s) => a + s.metrics.trades, 0);
    return total === 0
      ? "No trades to split by regime."
      : `Too few trades in any two regimes to compare — ${MIN_REGIME_TRADES} each is the floor.`;
  }

  const sorted = [...usable].sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR);
  const best = sorted[0] as RegimeSlice;
  const worst = sorted[sorted.length - 1] as RegimeSlice;
  const gap = best.metrics.expectancyR - worst.metrics.expectancyR;

  const num = (m: Metrics): string =>
    `${m.expectancyR >= 0 ? "+" : ""}${m.expectancyR.toFixed(2)}R over ${m.trades}`;

  /* Under a quarter of an R the split is not something anyone can trade on,
     and naming a "best regime" on that gap invites filtering a strategy down
     to the slice that happened to look good. */
  if (gap < 0.25) {
    return `Similar across regimes: ${usable.map((s) => `${REGIME_LABEL[s.regime].toLowerCase()} ${num(s.metrics)}`).join(", ")}.`;
  }

  return `${REGIME_LABEL[best.regime]}: ${num(best.metrics)}. ${REGIME_LABEL[worst.regime]}: ${num(worst.metrics)}. The gap is ${gap.toFixed(2)}R — this is two different strategies wearing one name.`;
}
