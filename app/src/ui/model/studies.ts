import { atr, rsi } from "../../chart/indicators";
import type { BarView } from "../../chart/series";

/**
 * RSI and ATR, STAMPED WITH THE SERIES THEY CAME FROM.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY A READING HAS TO CARRY ITS OWN PROVENANCE HERE
 *
 * `setupView` depends on `bars` twice: directly, and through this. That is a
 * diamond, and effects in core/signal.ts flush on a microtask in queue order
 * rather than in topological order — so when `bars` changes there is a window
 * in which `setupView` has already re-run with the NEW series while this
 * computed still holds the reading from the OLD one.
 *
 * Measured on XAUUSD switching 1m → 1h: the Setup card built its plan from
 * the hourly bars and the minute ATR of 2.04, placed a 1.00× "volatility"
 * stop 2.04 points away on a chart whose ATR was 19.10, then reported it as
 * 0.11× ATR and stood the trade down for being inside the noise. Every
 * number was internally consistent and the plan was about two different
 * charts. This is the same class of straddle `feed.loadedSymbol` was added
 * for, one layer further in, and it survives the guards there because both
 * of those signals had already caught up.
 *
 * The stamp is THE ARRAY ITSELF, by reference, and the first version of it
 * was not. That one recorded the bar count and the first and last
 * timestamps — which distinguishes two TIMEFRAMES perfectly and two
 * INSTRUMENTS not at all: BTCUSDT 1m and XAUUSD 1m loaded in the same minute
 * have the same length and the same timestamps on every bar. The stamp
 * matched, the guard passed, and a plan went out with gold's price and
 * Bitcoin's ATR of 26.71 — caught only by logging every run of this
 * function. A stamp that records WHEN but never WHAT cannot answer "is this
 * the same series".
 *
 * Identity is exact, costs nothing, and cannot alias. The reference is to an
 * array the caller is already holding, so it keeps nothing alive.
 */
export function readStudies(series: readonly BarView[]) {
  const stamp = { from: series, n: series.length };
  if (series.length < 30) return { rsi: NaN, atr: NaN, atrPct: NaN, stamp };
  const close = Float64Array.from(series, (b) => b.c);
  const high = Float64Array.from(series, (b) => b.h);
  const low = Float64Array.from(series, (b) => b.l);
  const n = series.length - 1;
  const a = atr(high, low, close, 14)[n] as number;
  const last = close[n] as number;
  return {
    rsi: rsi(close, 14)[n] as number,
    atr: a,
    atrPct: last ? (a / last) * 100 : NaN,
    stamp,
  };
}

/**
 * The one definition of what `studies` holds. Everything that takes it —
 * the Setup card, the Risk section, the expert's terminal access — derives its
 * parameter from this, so none of them can narrow it by hand and drift.
 */
export type Studies = ReturnType<typeof readStudies>;
