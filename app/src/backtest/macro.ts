/**
 * PUTTING A MACRO SERIES ON A TRADED SERIES' BARS, WITHOUT LOOK-AHEAD.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT THREE LINES IN A LOOP
 *
 * The measured case for conditioning is strong: across 22 markets and 334
 * graded arms the shipped rules had a median per-trade Sharpe of −0.109, and
 * when the archive went from 42 days to 5 years the best arm FELL from +0.374
 * to +0.070 against a hurdle of +0.102. The rules do not have an edge on their
 * own. The only question left worth asking is whether they have one in a
 * particular STATE — and a state means a second series.
 *
 * Every way of joining two series is wrong in a way that flatters the result,
 * so the join is the whole risk:
 *
 *  1. **THE BAR STAMP IS NOT THE BAR'S CLOSE.** yfinance stamps a daily bar at
 *     the START of the day. Reading DXY's 2026-09-25 bar on a BTC bar at
 *     2026-09-25 10:00 uses a close that has not happened yet. That is
 *     look-ahead, it is invisible, and it makes any conditioned rule look
 *     excellent and be untradeable. `closeTimeOf` is why this file takes an
 *     interval and not just timestamps.
 *
 *  2. **A CHANGE MUST BE COMPUTED ON THE MACRO SERIES' OWN BARS.** CLAUDE.md
 *     records the trap: `dxy.diff(5)` over forward-filled rows measures five
 *     ROWS spanning three trading days, so "DXY fell over five days" means
 *     something different depending on the weekday. Compute the change where
 *     the bars are real, then carry the RESULT across. Carrying a level forward
 *     is honest — it is the last value anybody knew. Computing a return across
 *     filled rows is not.
 *
 *  3. **BEFORE THE FIRST MACRO BAR THERE IS NO VALUE, AND THAT IS NOT ZERO.**
 *     A zero DXY change reads as "flat", which is a claim. NaN reads as "not
 *     known", which is the truth, and every formatter here already renders it
 *     as an em dash.
 *
 *  4. **A THIN OVERLAP CANNOT SUPPORT A CONDITION.** If the macro series covers
 *     forty of five thousand bars, a rule conditioned on it was tested on
 *     forty. `coverage` is returned so a caller can refuse rather than report a
 *     number computed on almost nothing.
 */

/** One bar of the series being conditioned ON. `t` is the bar's START. */
export interface MacroBar {
  readonly t: number;
  readonly c: number;
}

export interface MacroAlignment {
  /** Per traded bar: the macro close last KNOWN at that moment, or NaN. */
  readonly level: Float64Array;
  /** Per traded bar: how many traded bars had a known macro value. */
  readonly known: number;
  /** `known / tradedTimes.length`. A caller refuses on a thin one. */
  readonly coverage: number;
  /** Set when the alignment cannot support a condition, with the reason. */
  readonly thin: string | null;
}

/** Below this share of bars, a conditioned result describes the overlap, not the rule. */
export const MIN_COVERAGE = 0.8;

/**
 * When a bar stamped at `t` is actually KNOWN.
 *
 * A bar covers `[t, t + interval)` and its close is only knowable at the end of
 * that window. This is the single line that separates a conditioned backtest
 * from a look-ahead one.
 */
export function closeTimeOf(t: number, intervalMs: number): number {
  return t + intervalMs;
}

/**
 * The macro level last known at each traded bar.
 *
 * `macro` must be ascending by `t`. Both series are walked once together, so
 * this is linear rather than a binary search per bar — a 44,000-bar study over
 * a 25,000-bar daily series runs it 44,000 times.
 */
export function alignMacro(
  tradedTimes: ArrayLike<number>,
  macro: readonly MacroBar[],
  macroIntervalMs: number,
): MacroAlignment {
  const n = tradedTimes.length;
  const level = new Float64Array(n).fill(NaN);
  if (n === 0) {
    return { level, known: 0, coverage: 0, thin: "there are no bars to align onto" };
  }
  if (macro.length === 0) {
    return { level, known: 0, coverage: 0, thin: "no bars were held for the context series" };
  }

  let j = -1;          // index of the newest macro bar already KNOWN
  let known = 0;
  for (let i = 0; i < n; i += 1) {
    const now = tradedTimes[i] as number;
    /* Advance while the NEXT macro bar has already closed. Strictly `<=`,
       because a bar that closes exactly at this instant is knowable now. */
    while (
      j + 1 < macro.length &&
      closeTimeOf((macro[j + 1] as MacroBar).t, macroIntervalMs) <= now
    ) {
      j += 1;
    }
    if (j >= 0) {
      const c = (macro[j] as MacroBar).c;
      if (Number.isFinite(c)) {
        level[i] = c;
        known += 1;
      }
    }
  }

  const coverage = known / n;
  const thin =
    coverage < MIN_COVERAGE
      ? `the context series covers only ${Math.round(coverage * 100)}% of these bars, ` +
        `so a rule conditioned on it would be tested on that much`
      : null;
  return { level, known, coverage, thin };
}

/**
 * The change over `lookback` of the MACRO SERIES' OWN bars, as a fraction.
 *
 * Computed here, on the macro bars, and only then aligned — never as a diff
 * over carried-forward values. That is the difference between "DXY fell 1% over
 * five trading days" and "DXY fell 1% over five rows, some of which were a
 * weekend repeating Friday's close".
 */
export function macroChange(macro: readonly MacroBar[], lookback: number): MacroBar[] {
  const back = Math.max(1, Math.floor(lookback));
  const out: MacroBar[] = [];
  for (let i = 0; i < macro.length; i += 1) {
    const here = macro[i] as MacroBar;
    const prev = macro[i - back];
    if (prev === undefined || !Number.isFinite(prev.c) || prev.c === 0 || !Number.isFinite(here.c)) {
      out.push({ t: here.t, c: NaN });
      continue;
    }
    out.push({ t: here.t, c: (here.c - prev.c) / prev.c });
  }
  return out;
}

/**
 * A ratio of two stored series, at read time.
 *
 * DERIVED, NEVER STORED. A ratio of two series is not a third series, only a
 * second place for it to disagree with the two it came from. Both sides are
 * aligned to the same traded bars first, so the ratio is of values known at the
 * same moment rather than of whatever each series last printed.
 */
export function ratioOf(a: MacroAlignment, b: MacroAlignment): Float64Array {
  const n = Math.min(a.level.length, b.level.length);
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    const x = a.level[i] as number;
    const y = b.level[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y) && y !== 0) out[i] = x / y;
  }
  return out;
}


/* ─────────────────────────────────────────────────────────────────────────
   BUILDING THE COLUMNS A RULE READS
   ───────────────────────────────────────────────────────────────────────── */

/** Daily context bars keyed by the symbol the archive stores them under. */
export type ContextSeries = Readonly<Record<string, readonly MacroBar[]>>;

/** What a build could NOT supply, and why. A caller shows this; it never guesses. */
export interface MacroBuild {
  readonly columns: Readonly<Record<string, Float64Array>>;
  /** One line per column that is missing or too thin, addressed to the operator. */
  readonly missing: readonly string[];
}

/** How far back a "5-day change" looks, in the CONTEXT series' own bars. */
export const CHANGE_LOOKBACK = 5;

/** The daily context bar size. Everything in the spine is stored at 1d. */
export const CONTEXT_INTERVAL_MS = 86_400_000;

/**
 * Align every context series this vocabulary knows onto `tradedTimes`.
 *
 * A symbol the caller did not supply is REPORTED, not defaulted. A rule
 * conditioned on a series nobody loaded reads NaN, so it cannot fire — and the
 * operator is told which series to download rather than being shown a rule
 * that silently never triggers.
 */
export function buildMacroColumns(
  tradedTimes: ArrayLike<number>,
  series: ContextSeries,
): MacroBuild {
  const columns: Record<string, Float64Array> = {};
  const missing: string[] = [];
  const n = tradedTimes.length;
  const blank = (): Float64Array => new Float64Array(n).fill(NaN);

  const levels: Record<string, MacroAlignment> = {};

  const put = (col: string, symbol: string, change: boolean): void => {
    const bars = series[symbol];
    if (!bars || bars.length === 0) {
      columns[col] = blank();
      missing.push(`${symbol} is not in the archive, so ${col} cannot be read`);
      return;
    }
    /* THE CHANGE IS COMPUTED FIRST, on this series' own bars, and only then
       aligned. Aligning first and differencing after would measure five ROWS
       of a carried-forward level — three trading days across a weekend. */
    const source = change ? macroChange(bars, CHANGE_LOOKBACK) : bars;
    const a = alignMacro(tradedTimes, source, CONTEXT_INTERVAL_MS);
    if (!change) levels[symbol] = a;
    columns[col] = a.level;
    if (a.thin) missing.push(`${col}: ${a.thin}`);
  };

  put("dxy", "DXY", false);
  put("dxy_chg5", "DXY", true);
  put("us10y", "US10Y", false);
  put("us10y_chg5", "US10Y", true);
  put("us02y", "US02Y", false);
  put("vix", "VIX", false);
  put("vix_chg5", "VIX", true);
  put("spx", "SPX", false);
  put("spx_chg5", "SPX", true);
  put("usdjpy", "USDJPY", false);

  /* DERIVED AT READ TIME, never stored. Both sides are aligned to the same
     traded bars first, so this divides values known at the same moment rather
     than whatever each series last printed. */
  const alignSide = (symbol: string): MacroAlignment | null => {
    const bars = series[symbol];
    if (!bars || bars.length === 0) return null;
    return levels[symbol] ?? alignMacro(tradedTimes, bars, CONTEXT_INTERVAL_MS);
  };
  const copper = alignSide("COPPER");
  const gold = alignSide("XAUUSD");
  if (copper && gold) {
    columns["copper_gold"] = ratioOf(copper, gold);
  } else {
    columns["copper_gold"] = blank();
    missing.push("copper_gold needs both COPPER and XAUUSD in the archive");
  }

  return { columns, missing };
}
