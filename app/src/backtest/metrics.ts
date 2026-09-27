/**
 * Performance metrics.
 *
 * Every number here is easy to compute and easy to misread, so each one is
 * paired with the caveat that makes it honest. A metric without its caveat is
 * how a curve-fit strategy gets deployed.
 */

import type { Trade } from "./engine";

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Gross wins / gross losses. Below 1 the strategy loses money. */
  profitFactor: number;
  /** Mean R per trade — the number that actually decides the outcome. */
  expectancyR: number;
  totalReturn: number;
  maxDrawdown: number;
  /** Annualised return / annualised stdev of bar returns. */
  sharpe: number;
  /**
   * Mean R over the standard deviation of R — a PER-TRADE Sharpe.
   *
   * A SEPARATE FIELD FROM `sharpe` ON PURPOSE. `study/stats.ts`
   * `deflatedSharpe` is defined on a per-observation Sharpe and takes a TRADE
   * count as its `observations`; `sharpe` above is annualised. CLAUDE.md
   * records what mixing them costs — an annualised 4.93 over 77 trades
   * deflated with a per-trade standard error and printed as though the search
   * had been paid for, three incompatible quantities in one expression and
   * every one of them a plausible number. The correction's input is computed
   * here so no caller has to convert between units it cannot see.
   *
   * NaN when every trade returned the same R: the spread is zero and the ratio
   * is undefined. Infinity would deflate to Infinity and print as a
   * spectacular edge on a rule that won the same amount three times.
   */
  perTradeSharpe: number;
  /** Total return divided by max drawdown. */
  recoveryFactor: number;
  avgWinR: number;
  avgLossR: number;
  /** Longest run of losers — what actually decides whether it is sittable. */
  maxConsecutiveLosses: number;
  /** Bars held, averaged. */
  avgBarsHeld: number;
  /**
   * Annualised mean bar return / annualised DOWNSIDE deviation (target 0).
   *
   * Sharpe punishes a strategy for its winners as much as for its losers;
   * Sortino only counts the bars that lost. It shares every assumption Sharpe
   * makes about independence, and it is 0 — not Infinity — when no bar lost,
   * because a ratio over nothing is undefined, not excellent.
   */
  sortino: number;
  /**
   * Compound annual growth rate over the curve's own span.
   *
   * Only as good as `barsPerYear`: the caller should MEASURE it from the bars'
   * timestamps (`barsPerYearFromSpan`), because the 24/7 default applied to a
   * market that closes overstates the span. 0 when the curve covers under a
   * quarter of a year — compounding two weeks up to a year is extrapolation.
   */
  cagr: number;
  /** CAGR / max drawdown. 0 when CAGR was refused or there was no drawdown. */
  calmar: number;
  /**
   * Root-mean-square drawdown, as a FRACTION (Martin's original is in percent
   * points: multiply by 100 to compare with published figures). Unlike max
   * drawdown it charges for how long and how often the curve sat below its
   * peak, not only for the single worst trough.
   */
  ulcerIndex: number;
  /**
   * Longest run of consecutive bars below a prior peak. A drawdown still open
   * at the end is counted to the last bar, so this is a FLOOR: recovery, if it
   * comes, is later than the data shows.
   */
  maxTimeUnderWaterBars: number;
  /**
   * Fraction of bars with a position open, entry and exit bars inclusive.
   * 0 when the trades' indices do not fit the equity curve — which happens when
   * a caller passes a per-TRADE curve (regime slices) rather than a per-bar one.
   */
  exposure: number;
}

export const EMPTY_METRICS: Metrics = {
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  profitFactor: 0,
  expectancyR: 0,
  totalReturn: 0,
  maxDrawdown: 0,
  sharpe: 0,
  perTradeSharpe: 0,
  recoveryFactor: 0,
  avgWinR: 0,
  avgLossR: 0,
  maxConsecutiveLosses: 0,
  avgBarsHeld: 0,
  sortino: 0,
  cagr: 0,
  calmar: 0,
  ulcerIndex: 0,
  maxTimeUnderWaterBars: 0,
  exposure: 0,
};

/**
 * Mean R over the standard deviation of R.
 *
 * POPULATION standard deviation, not the sample one: these are all the trades
 * the rule took, not a sample drawn from them, and the n-1 correction would be
 * answering a question nobody asked. The difference is a few percent at 20
 * trades and nothing at 200, but the two are not the same quantity and the
 * multiplicity hurdle is computed against this one.
 */
export function perTradeSharpe(trades: readonly Trade[]): number {
  const n = trades.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const t of trades) sum += t.rMultiple;
  const mean = sum / n;
  let sq = 0;
  for (const t of trades) sq += (t.rMultiple - mean) ** 2;
  const sd = Math.sqrt(sq / n);
  /* NaN rather than Infinity. A rule whose every trade returned the same R has
     no measurable spread, and a ratio of a finite mean to zero is not a very
     large Sharpe — it is an undefined one, and the difference matters the
     moment it reaches `deflatedSharpe`. */
  return sd > 0 ? mean / sd : Number.NaN;
}

/** Peak-to-trough decline of an equity curve, as a positive fraction. */
export function maxDrawdown(equity: ArrayLike<number>): number {
  let peak = -Infinity;
  let worst = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i] as number;
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Sharpe from per-bar equity changes, annualised by `barsPerYear`.
 *
 * Reported because it is expected, but it assumes returns are normal and
 * independent, and trading returns are neither. A high Sharpe on 40 trades is
 * a statement about 40 numbers, not about the future.
 */
export function sharpeRatio(equity: ArrayLike<number>, barsPerYear = 8760): number {
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1] as number;
    const cur = equity[i] as number;
    if (prev > 0 && Number.isFinite(cur)) rets.push(cur / prev - 1);
  }
  if (rets.length < 2) return 0;

  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let variance = 0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance /= rets.length - 1;
  const sd = Math.sqrt(variance);
  // A perfectly flat curve has zero volatility; the ratio is undefined, and
  // returning Infinity would rank a strategy that never traded above every
  // strategy that did.
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(barsPerYear);
}

/** Per-bar simple returns, skipping any step that cannot be measured. */
function barReturns(equity: ArrayLike<number>): number[] {
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1] as number;
    const cur = equity[i] as number;
    if (prev > 0 && Number.isFinite(cur)) rets.push(cur / prev - 1);
  }
  return rets;
}

/**
 * Sortino ratio: mean bar return over downside deviation, annualised.
 *
 * Downside deviation is sqrt(sum(min(r, 0)^2) / N) over ALL N returns — the
 * standard target semideviation, not the stdev of the losing subset, which
 * would ignore how rarely the losses happen.
 */
export function sortinoRatio(equity: ArrayLike<number>, barsPerYear = 8760): number {
  const rets = barReturns(equity);
  if (rets.length < 2 || !(barsPerYear > 0)) return 0;
  let sum = 0;
  let down = 0;
  for (const r of rets) {
    sum += r;
    if (r < 0) down += r * r;
  }
  const semi = Math.sqrt(down / rets.length);
  if (semi === 0) return 0;
  return (sum / rets.length / semi) * Math.sqrt(barsPerYear);
}

/** Below this many years, CAGR is refused rather than extrapolated. */
export const MIN_CAGR_YEARS = 0.25;

/**
 * Compound annual growth rate. The curve is in multiples of starting capital,
 * so the growth is `last / first` over `(length - 1) / barsPerYear` years.
 * A curve that reached zero is -100%, which is a measurement, not a refusal.
 */
export function cagr(equity: ArrayLike<number>, barsPerYear: number): number {
  const n = equity.length;
  if (n < 2 || !(barsPerYear > 0)) return 0;
  const first = equity[0] as number;
  const last = equity[n - 1] as number;
  if (!(first > 0) || !Number.isFinite(last)) return 0;
  const years = (n - 1) / barsPerYear;
  if (years < MIN_CAGR_YEARS) return 0;
  if (last <= 0) return -1;
  return (last / first) ** (1 / years) - 1;
}

/**
 * The drawdown at every point, as a positive fraction of the running peak.
 *
 * A non-finite point repeats the previous drawdown rather than resetting to 0:
 * a hole in the curve is not a recovery.
 */
export function drawdownCurve(equity: ArrayLike<number>): Float64Array {
  const out = new Float64Array(equity.length);
  let peak = -Infinity;
  let prev = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i] as number;
    if (Number.isFinite(v)) {
      if (v > peak) peak = v;
      prev = peak > 0 ? (peak - v) / peak : 0;
    }
    out[i] = prev;
  }
  return out;
}

/** Ulcer index as a fraction: sqrt(mean(drawdown^2)). 0 on an empty curve. */
export function ulcerIndex(equity: ArrayLike<number>): number {
  const dd = drawdownCurve(equity);
  if (dd.length === 0) return 0;
  let sq = 0;
  for (let i = 0; i < dd.length; i++) sq += (dd[i] as number) ** 2;
  return Math.sqrt(sq / dd.length);
}

/** Longest run of consecutive points strictly below a prior peak. */
export function maxTimeUnderWater(equity: ArrayLike<number>): number {
  let peak = -Infinity;
  let run = 0;
  let worst = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i] as number;
    if (!Number.isFinite(v)) continue;
    if (v >= peak) {
      peak = v;
      run = 0;
    } else {
      run++;
      if (run > worst) worst = run;
    }
  }
  return worst;
}

/**
 * Fraction of `bars` covered by at least one open trade.
 *
 * The engine enters at a bar's open and exits during a bar, so both ends are
 * bars the capital was committed on. Overlaps are counted once. Refuses (0)
 * when any trade's indices fall outside [0, bars): the curve is then not one
 * point per bar and a fraction of it would describe nothing.
 */
export function exposure(trades: readonly Trade[], bars: number): number {
  if (bars <= 0 || trades.length === 0) return 0;
  const held = new Uint8Array(bars);
  for (const t of trades) {
    if (t.entryIndex < 0 || t.exitIndex >= bars || t.exitIndex < t.entryIndex) return 0;
    held.fill(1, t.entryIndex, t.exitIndex + 1);
  }
  let n = 0;
  for (let i = 0; i < bars; i++) n += held[i] as number;
  return n / bars;
}

const YEAR_MS = 365.25 * 86_400_000;

/**
 * Bars per year MEASURED from the series: periods divided by the years the
 * timestamps span. Replaces the 24/7 constant for a market that closes — a
 * year of EURUSD hourly is about 6,200 bars, not 8,760. 0 when the span cannot
 * be measured, which makes every annualised figure refuse.
 */
export function barsPerYearFromSpan(count: number, firstMs: number, lastMs: number): number {
  const span = lastMs - firstMs;
  if (count < 2 || !Number.isFinite(span) || span <= 0) return 0;
  return (count - 1) / (span / YEAR_MS);
}

export function computeMetrics(
  trades: readonly Trade[],
  equity: ArrayLike<number>,
  barsPerYear = 8760,
): Metrics {
  if (trades.length === 0) return { ...EMPTY_METRICS };

  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumR = 0;
  let sumWinR = 0;
  let sumLossR = 0;
  let barsHeld = 0;
  let consecutive = 0;
  let worstStreak = 0;

  for (const t of trades) {
    sumR += t.rMultiple;
    barsHeld += t.exitIndex - t.entryIndex;

    if (t.returnPct > 0) {
      wins++;
      grossWin += t.returnPct;
      sumWinR += t.rMultiple;
      consecutive = 0;
    } else {
      grossLoss += Math.abs(t.returnPct);
      sumLossR += t.rMultiple;
      consecutive++;
      if (consecutive > worstStreak) worstStreak = consecutive;
    }
  }

  const losses = trades.length - wins;
  const last = equity.length > 0 ? (equity[equity.length - 1] as number) : 1;
  const dd = maxDrawdown(equity);
  const growth = cagr(equity, barsPerYear);

  return {
    trades: trades.length,
    wins,
    losses,
    winRate: wins / trades.length,
    // No losses at all makes the ratio infinite; report the gross win instead
    // so the number stays sortable and finite.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? grossWin : 0,
    expectancyR: sumR / trades.length,
    totalReturn: last - 1,
    maxDrawdown: dd,
    sharpe: sharpeRatio(equity, barsPerYear),
    perTradeSharpe: perTradeSharpe(trades),
    recoveryFactor: dd > 0 ? (last - 1) / dd : 0,
    avgWinR: wins > 0 ? sumWinR / wins : 0,
    avgLossR: losses > 0 ? sumLossR / losses : 0,
    maxConsecutiveLosses: worstStreak,
    avgBarsHeld: barsHeld / trades.length,
    sortino: sortinoRatio(equity, barsPerYear),
    cagr: growth,
    calmar: dd > 0 && growth !== 0 ? growth / dd : 0,
    ulcerIndex: ulcerIndex(equity),
    maxTimeUnderWaterBars: maxTimeUnderWater(equity),
    exposure: exposure(trades, equity.length),
  };
}

/**
 * A plain-language verdict.
 *
 * Deliberately conservative. The default answer is "this proves nothing", and a
 * result has to earn its way past that — because the overwhelming majority of
 * backtests do not.
 */
export function verdict(m: Metrics): { rating: "unproven" | "weak" | "promising"; why: string } {
  if (m.trades < 30) {
    return {
      rating: "unproven",
      why: `${m.trades} trades is not a sample. Anything here is noise, however good it looks.`,
    };
  }
  if (m.expectancyR <= 0) {
    return {
      rating: "weak",
      why: `expectancy is ${m.expectancyR.toFixed(3)}R per trade — the strategy loses money after costs.`,
    };
  }
  if (m.profitFactor < 1.2) {
    return {
      rating: "weak",
      why: `profit factor ${m.profitFactor.toFixed(2)} leaves no margin; a small change in costs or fills erases it.`,
    };
  }
  return {
    rating: "promising",
    why:
      `${m.trades} trades, expectancy ${m.expectancyR.toFixed(3)}R, profit factor ` +
      `${m.profitFactor.toFixed(2)}, max drawdown ${(m.maxDrawdown * 100).toFixed(1)}%. ` +
      `In-sample only — this says nothing until it survives out-of-sample.`,
  };
}
