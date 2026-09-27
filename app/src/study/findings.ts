/**
 * The two findings the study computes itself, and the shapes every finding
 * arrives in.
 *
 * Everything else in the catalogue delegates: the sweeps to `backtest/lab.ts`,
 * the volatility model to the quant service, the regime split to
 * `backtest/regime.ts`. These two are here because nothing in the codebase did
 * them — a lag profile with a noise band, and a base-rate table that refuses
 * the cells it cannot fill.
 */

import type { PanelRow } from "../data/panel";
import type { Regime } from "../backtest/regime";
import { REGIME_LABEL } from "../backtest/regime";
import { bartlettBand, pearsonAt, twoSidedP } from "./stats";

/** One line of a result card. */
export interface ResultRow {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly tone?: "pos" | "neg" | "attn";
  /**
   * Set when the cell has a value the study declines to report, and why.
   * `value` then reads "—" and this is what is shown instead.
   */
  readonly withheld?: string;
}

export interface LagPoint {
  readonly lag: number;
  readonly r: number;
  /** Pairs the figure rests on. Falls at the edges of the profile. */
  readonly n: number;
}

export interface LagProfile {
  readonly symbol: string;
  readonly label: string;
  readonly points: readonly LagPoint[];
  /** ±this is indistinguishable from noise at 95%. */
  readonly band: number;
  /** The largest absolute correlation on the profile, or null. */
  readonly best: LagPoint | null;
  /** Every point outside the band, strongest first. */
  readonly clears: readonly LagPoint[];
  /** Two-sided p for `best`, or 1 when there is none. */
  readonly bestP: number;
}

/**
 * Cross-correlate one driver against the subject at every lag.
 *
 * SIGN CONVENTION, STATED ONCE
 * `driver` and `subject` are return series on the same rows. A point at lag
 * `L > 0` correlates the driver at row `i` with the subject at row `i + L` —
 * so a large positive-lag bar means THE DRIVER MOVED FIRST. Negative lags are
 * the subject leading the driver. The report never prints the raw sign for the
 * reader to interpret; it prints the sentence.
 */
export function lagProfile(
  symbol: string,
  label: string,
  driver: readonly number[],
  subject: readonly number[],
  maxLag: number,
): LagProfile {
  const points: LagPoint[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const { r, n } = pearsonAt(driver, subject, lag);
    if (Number.isFinite(r)) points.push({ lag, r, n });
  }
  const usable = points.filter((p) => p.n > 2);
  const best =
    usable.length === 0
      ? null
      : usable.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
  /* The band is set by the SHORTEST overlap on the profile, not the longest.
     Using the centre's n would draw a band narrower than the one the extreme
     lags are actually being judged against, and the extremes are where a
     spurious bar is most likely to appear. */
  const minN = usable.length === 0 ? 0 : usable.reduce((a, b) => Math.min(a, b.n), Infinity);
  const band = bartlettBand(minN);
  const clears = usable
    .filter((p) => Math.abs(p.r) > band)
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return {
    symbol,
    label,
    points,
    band,
    best,
    clears,
    bestP: best === null ? 1 : twoSidedP(best.r * Math.sqrt(Math.max(1, best.n))),
  };
}

/** The columns of a panel row, as one series per column. */
export function columnSeries(rows: readonly PanelRow[], column: number): number[] {
  return rows.map((r) => r.x[column] ?? NaN);
}

export function subjectSeries(rows: readonly PanelRow[]): number[] {
  return rows.map((r) => r.r);
}

/**
 * One sentence about a profile, in the direction the operator reads in.
 *
 * Returns null when nothing cleared the band, and the caller prints that as a
 * finding rather than as an absence — "nothing led anything" over two years of
 * hourly bars is a result, and a common one.
 */
export function leadLagSentence(p: LagProfile, subjectLabel: string): string | null {
  const top = p.clears[0];
  if (top === undefined || p.best === null) return null;
  const bars = Math.abs(top.lag);
  const dir = top.r >= 0 ? "in the same direction as" : "in the opposite direction to";
  if (top.lag === 0) {
    return `${p.label} moves with ${subjectLabel} on the same bar, ${dir === "in the same direction as" ? "together" : "inversely"} (${top.r.toFixed(2)}). Same-bar movement is not a lead and cannot be traded on.`;
  }
  return top.lag > 0
    ? `${p.label} leads ${subjectLabel} by ${bars} bar${bars === 1 ? "" : "s"} at ${top.r.toFixed(2)}, ${dir} the subject.`
    : `${subjectLabel} leads ${p.label} by ${bars} bar${bars === 1 ? "" : "s"} at ${top.r.toFixed(2)}. That is the subject predicting the driver, which is not what this study was set up to find.`;
}

/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Observations below which a cell is not reported.
 *
 * Forty, the same floor `backtest/survey.ts` uses for a market total, and for
 * the same reason: below it the standard error on a hit rate is wider than any
 * difference worth acting on, so a number there invites a decision the data
 * cannot support. The cell shows its count and why it is empty rather than
 * showing a figure with a warning next to it, because a figure with a warning
 * next to it gets read as a figure.
 */
export const MIN_CELL = 40;

export interface BaseRateCell {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  /** Share of rows whose forward return was positive, or NaN when withheld. */
  readonly up: number;
  /** Mean forward return over the horizon, in basis points. */
  readonly meanBp: number;
  readonly medianBp: number;
  readonly withheld: string | null;
}

export interface BaseRateTable {
  readonly cells: readonly BaseRateCell[];
  readonly pooled: BaseRateCell;
  readonly horizon: number;
  readonly caveats: readonly string[];
}

const bp = (logReturn: number): number => (Math.exp(logReturn) - 1) * 10_000;

function cellOf(key: string, label: string, ys: readonly number[]): BaseRateCell {
  const finite = ys.filter((y) => Number.isFinite(y));
  const n = finite.length;
  if (n < MIN_CELL) {
    return {
      key,
      label,
      n,
      up: NaN,
      meanBp: NaN,
      medianBp: NaN,
      withheld: `${n} observation${n === 1 ? "" : "s"} — below the ${MIN_CELL} this table reports on. The rate is not being hidden; it is not measurable from this many.`,
    };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  const median =
    sorted.length % 2 === 1 ? (hi ?? NaN) : lo !== undefined && hi !== undefined ? (lo + hi) / 2 : NaN;
  return {
    key,
    label,
    n,
    up: finite.filter((y) => y > 0).length / n,
    meanBp: bp(finite.reduce((a, b) => a + b, 0) / n),
    medianBp: bp(median),
    withheld: null,
  };
}

/**
 * What the subject did over the next `horizon` bars, in each market condition.
 *
 * `regimes` is indexed to match `rows`. Rows with no regime label go into an
 * "unclassified" cell rather than being dropped or folded into the pooled
 * figure twice — the pooled row is computed from every row exactly once, and
 * the cells sum to it.
 */
export function baseRates(
  rows: readonly PanelRow[],
  regimes: readonly (Regime | null)[],
  horizon: number,
): BaseRateTable {
  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined || !Number.isFinite(row.y)) continue;
    all.push(row.y);
    const key = regimes[i] ?? "unclassified";
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [row.y]);
    else list.push(row.y);
  }

  const order: readonly string[] = ["trend", "chop", "volatile", "unclassified"];
  const cells = order
    .filter((k) => buckets.has(k))
    .map((k) =>
      cellOf(
        k,
        k === "unclassified" ? "Unclassified" : (REGIME_LABEL[k as Regime] ?? k),
        buckets.get(k) ?? [],
      ),
    );

  const caveats: string[] = [];
  const withheldCount = cells.filter((c) => c.withheld !== null).length;
  if (withheldCount > 0) {
    caveats.push(
      `${withheldCount} of ${cells.length} conditions had too few observations to report. A study is not a complete picture of a market just because it covered the whole window — it covered the conditions the window happened to contain.`,
    );
  }
  const unclassified = cells.find((c) => c.key === "unclassified");
  if (unclassified !== undefined && unclassified.n > all.length * 0.1) {
    caveats.push(
      `${Math.round((unclassified.n / Math.max(1, all.length)) * 100)}% of rows could not be given a condition — usually the warm-up the ADX and volatility percentile need before they mean anything.`,
    );
  }

  return {
    cells,
    pooled: cellOf("pooled", "All conditions", all),
    horizon,
    caveats,
  };
}
