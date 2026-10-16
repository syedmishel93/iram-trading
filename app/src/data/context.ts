/**
 * Market context — seasonality, correlation, and the economic calendar.
 *
 * Three things that are not on the chart and change how the chart should be
 * read. All three are cheap; none of them is offered by a charting platform in
 * a form you can audit.
 *
 * THE RULE THAT GOVERNS ALL OF IT
 * Every one of these is a statistic over a small sample, and a small sample
 * will happily show a large effect that is not there. So every bucket carries
 * its OWN sample count, and anything thin is reported as thin rather than
 * quietly averaged in with the rest. "Tuesdays are +0.8%" from nine Tuesdays is
 * not a finding, and this module will not let it look like one.
 */

import { fetchJson } from "./net";
import type { BarView } from "../chart/series";
import { serviceBase } from "./backend";
import { correlate, MIN_OVERLAP, SUB_WINDOWS, type ClosesSeries } from "./correlation";


// ------------------------------------------------------------ seasonality --

export type SeasonMode = "hour" | "weekday" | "month";

export interface SeasonBucket {
  /** 0-23, 0-6 (Sunday first), or 0-11. */
  key: number;
  label: string;
  /** Mean bar return inside this bucket, as a fraction. */
  meanReturn: number;
  /** Share of bars in this bucket that closed up. */
  upRate: number;
  samples: number;
  /**
   * True when there is enough here to be worth reading.
   *
   * Below this the bucket is still shown — hiding it would misrepresent the
   * coverage — but it is marked, and the caller greys it out.
   */
  sufficient: boolean;
}

export interface SeasonRead {
  mode: SeasonMode;
  buckets: SeasonBucket[];
  totalSamples: number;
  /** One line the caller can show verbatim. */
  note: string;
}

/** Below this a bucket's mean is dominated by whichever few bars landed in it. */
export const MIN_BUCKET_SAMPLES = 20;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function bucketCount(mode: SeasonMode): number {
  return mode === "hour" ? 24 : mode === "weekday" ? 7 : 12;
}

function bucketOf(mode: SeasonMode, t: number): number {
  const d = new Date(t);
  // UTC throughout: a session pattern that shifts with the reader's timezone is
  // not a pattern, it is a rendering artefact.
  return mode === "hour" ? d.getUTCHours() : mode === "weekday" ? d.getUTCDay() : d.getUTCMonth();
}

function labelOf(mode: SeasonMode, key: number): string {
  if (mode === "hour") return `${String(key).padStart(2, "0")}:00`;
  if (mode === "weekday") return WEEKDAYS[key] ?? String(key);
  return MONTHS[key] ?? String(key);
}

/**
 * Average bar return by time bucket.
 *
 * Uses the bar's OWN return (close over previous close), not close-over-open,
 * because the gap between bars is part of what happened in that hour and
 * dropping it flatters any session that habitually gaps.
 */
export function seasonality(bars: readonly BarView[], mode: SeasonMode): SeasonRead {
  const n = bucketCount(mode);
  const sum = new Float64Array(n);
  const ups = new Float64Array(n);
  const count = new Float64Array(n);

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1] as BarView;
    const cur = bars[i] as BarView;
    if (!(prev.c > 0)) continue;
    const r = cur.c / prev.c - 1;
    if (!Number.isFinite(r)) continue;
    const k = bucketOf(mode, cur.t);
    sum[k] = (sum[k] as number) + r;
    if (r > 0) ups[k] = (ups[k] as number) + 1;
    count[k] = (count[k] as number) + 1;
  }

  const buckets: SeasonBucket[] = [];
  let total = 0;
  for (let k = 0; k < n; k++) {
    const c = count[k] as number;
    total += c;
    buckets.push({
      key: k,
      label: labelOf(mode, k),
      meanReturn: c > 0 ? (sum[k] as number) / c : 0,
      upRate: c > 0 ? (ups[k] as number) / c : 0,
      samples: c,
      sufficient: c >= MIN_BUCKET_SAMPLES,
    });
  }

  const thin = buckets.filter((b) => b.samples > 0 && !b.sufficient).length;
  const note =
    total === 0
      ? "No bars to measure."
      : thin > 0
        ? `${total} bars. ${thin} bucket${thin === 1 ? "" : "s"} below ${MIN_BUCKET_SAMPLES} samples and greyed out — a mean from a handful of bars will show an effect whether or not one exists.`
        : `${total} bars, every bucket above ${MIN_BUCKET_SAMPLES} samples. Still a description of one period, not a law.`;

  return { mode, buckets, totalSamples: total, note };
}

// ------------------------------------------------------------ correlation --

export interface CorrelationPair {
  a: string;
  b: string;
  /** Pearson correlation of log returns, -1..1. NaN when it could not be measured. */
  r: number;
  /** Bars present in BOTH series. Per pair, never one figure for the scan. */
  samples: number;
  /**
   * How far `r` moved across `SUB_WINDOWS` slices of this pair's overlap.
   *
   * THE FIGURE THAT STOPS A REVERSAL READING AS AN ABSENCE. A pair that was
   * +0.9 for the first half of the window and -0.9 for the second averages to
   * about nothing, and nothing renders as "these two are unrelated" - the
   * opposite of the truth, and indistinguishable from it by `r` alone.
   *
   * NaN when the overlap was too short to slice, which is a different fact
   * from a small spread and is rendered differently.
   */
  instability: number;
  /** False when the answer moved about, OR when it could not be checked. */
  stable: boolean;
}

export interface CorrelationRead {
  symbols: string[];
  /**
   * Row-major matrix aligned to `symbols`; the diagonal is 1 and a cell that
   * could not be measured is NaN rather than 0 - 0 would be a claim.
   */
  matrix: number[][];
  /** Measured pairs, most correlated first by absolute value. */
  pairs: CorrelationPair[];
  /**
   * Pairs nothing could be said about: too few overlapping bars, or a series
   * that never moved. Reported rather than dropped - a pair that silently
   * vanishes is indistinguishable from one that was measured and found weak.
   */
  unjudged: CorrelationPair[];
  /**
   * The SMALLEST overlap among the measured pairs. A floor, not an average:
   * the join is pairwise, so one number for the scan can only honestly be the
   * worst of them.
   */
  samples: number;
  note: string;
}

/**
 * Below this the coefficient is noise regardless of what it says.
 *
 * IMPORTED, NOT COPIED. `data/correlation.ts` owns the measurement and this
 * is the same floor under a name the screener's callers already use; two
 * literals would drift and neither side would be able to see it.
 */
export const MIN_CORRELATION_SAMPLES = MIN_OVERLAP;

/** The only two fields correlation needs. Keeps callers from retaining full bars. */
export interface ClosePoint {
  t: number;
  c: number;
}

export interface CorrelationOptions {
  /**
   * Points kept from the tail of EACH series before the join.
   *
   * It used to trim the joined grid, which is the same thing when every series
   * comes from one scan and a different thing when one of them reaches further
   * back. Each pair reports the overlap it actually got, so the window is a
   * budget rather than a claim.
   */
  readonly window?: number;
  /**
   * How a timestamp becomes a join key. Exact by default.
   *
   * Pass `utcDay` from `data/correlation` for DAILY bars from different
   * vendors: yfinance stamps a daily bar at midnight and a broker at its
   * session open, so an exact join between them reports zero overlap for two
   * series covering the same days. Leave it off for intraday bars from one
   * feed, where two bars really can fall on one day and the later would
   * silently replace the earlier.
   */
  readonly bucket?: (t: number) => number;
}

/**
 * Pairwise correlation of log returns, with the stability of each answer.
 *
 * THE MEASUREMENT IS NOT HERE. `data/correlation.ts` has owned it since the
 * Risk desk needed to know which of its positions were one bet, and it already
 * carries the two things this block was missing: the overlap re-measured in
 * slices, so a pair that REVERSED cannot come back looking uncorrelated, and a
 * join key, so two vendors that stamp a daily bar differently can still be
 * compared. Writing either of them again here would have been a second owner
 * of one fact, which is the defect this repository records most often.
 *
 * What is still here is the part that is about a SCAN rather than a pair: which
 * symbols go in, the matrix, and the sentence above the table.
 *
 * The join is PAIRWISE, where this used to intersect the timestamps present in
 * every series at once. One symbol with a gap no longer shortens the window of
 * every pair that does not involve it, and `samples` moves onto the pair, where
 * it describes something.
 */
export function correlation(
  series: ReadonlyMap<string, readonly ClosePoint[]>,
  opts: CorrelationOptions = {},
): CorrelationRead {
  const symbols = [...series.keys()];
  if (symbols.length < 2) {
    return {
      symbols,
      matrix: [],
      pairs: [],
      unjudged: [],
      samples: 0,
      note: "Correlation needs at least two symbols.",
    };
  }

  const window = opts.window ?? 200;
  const trimmed = symbols.map<ClosesSeries>((symbol) => ({
    symbol,
    closes: (series.get(symbol) ?? []).slice(-window - 1),
  }));

  /* NaN, not 0, for a cell nothing could be measured for: 0 reads as "these
     move independently", which is a finding, and no finding was made. */
  const matrix: number[][] = symbols.map(() => new Array<number>(symbols.length).fill(NaN));
  const all: CorrelationPair[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    matrix[i]![i] = 1;
    for (let j = i + 1; j < trimmed.length; j++) {
      const m = correlate(trimmed[i] as ClosesSeries, trimmed[j] as ClosesSeries, {
        ...(opts.bucket ? { bucket: opts.bucket } : {}),
        /* This block SHOWS a thin figure under a note that names the window,
           where the cross-asset web refuses one outright. Both are honest and
           they are different surfaces; see `CorrelateOptions.floor`. */
        floor: 2,
      });
      matrix[i]![j] = m.r;
      matrix[j]![i] = m.r;
      all.push({
        a: symbols[i] as string,
        b: symbols[j] as string,
        r: m.r,
        samples: m.overlap,
        instability: m.instability,
        stable: m.stable,
      });
    }
  }

  const pairs = all.filter((p) => Number.isFinite(p.r));
  const unjudged = all.filter((p) => !Number.isFinite(p.r));
  pairs.sort((p, q) => Math.abs(q.r) - Math.abs(p.r));

  const samples = pairs.length > 0 ? Math.min(...pairs.map((p) => p.samples)) : 0;

  let note =
    samples < MIN_CORRELATION_SAMPLES
      ? `Only ${samples} overlapping bars \u2014 below ${MIN_CORRELATION_SAMPLES} the coefficient is noise, whatever it says.`
      : `${samples} overlapping bars at the thinnest pair. Spread is how far the figure moved across ${SUB_WINDOWS} slices of its own window: a wide one means the pair reversed inside the window and the single number is an average of two different relationships. Correlation is not causation and it changes fastest in exactly the conditions where you were relying on it.`;

  /* A pair that vanishes silently is indistinguishable from one measured and
     found weak, so the ones nothing could be said about are counted. */
  if (unjudged.length > 0) {
    note += ` ${unjudged.length} pair${unjudged.length === 1 ? "" : "s"} could not be measured \u2014 too few overlapping bars, or a series that never moved \u2014 and ${unjudged.length === 1 ? "is" : "are"} not listed.`;
  }

  return { symbols, matrix, pairs, unjudged, samples, note };
}

// --------------------------------------------------------------- calendar --

export interface CalendarEvent {
  /** As published, e.g. "2026-08-31T12:30:00-04:00". */
  time: string;
  title: string;
}

export type CalendarResult =
  | { ok: true; events: CalendarEvent[]; collectedAt: number }
  | { ok: false; error: string };

/**
 * High-impact USD events from the feature store.
 *
 * The service already collects these hourly from the ForexFactory weekly
 * mirror; nothing new is fetched here and no new vendor is introduced. Half the
 * macro moves on the chart happen ON these releases, and a terminal that does
 * not know they are coming will read the resulting spike as structure.
 */
export async function loadCalendar(
  base = serviceBase(),
  signal?: AbortSignal,
): Promise<CalendarResult> {
  try {
    // The service collects this hourly, so anything shorter than an hour of
    // cache re-fetches a payload that cannot have changed. `swr` keeps the
    // panel instant across desk switches.
    const rows = await fetchJson<{ source: string; k: string; v: string; t: number }[]>(
      `${base}/svc/data/snapshot`,
      {
        priority: "background",
        ttlMs: 15 * 60_000,
        swr: true,
        ...(signal ? { signal } : {}),
      },
    );
    const row = rows.find((r) => r.source === "calendar" && r.k === "high_usd");
    if (!row) {
      return {
        ok: false,
        error: "the feature store has no calendar entry yet — it is collected hourly",
      };
    }
    const parsed = JSON.parse(row.v) as { t?: string; n?: string }[];
    return {
      ok: true,
      collectedAt: row.t * 1000,
      events: parsed
        .filter((e) => e && typeof e.n === "string")
        .map((e) => ({ time: String(e.t ?? ""), title: String(e.n) })),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return {
        ok: false,
        error: `the analysis service is not running at ${base} — start everything with "python run.py"`,
      };
    }
    return { ok: false, error: msg };
  }
}

/** Events still ahead of `now`, soonest first. */
export function upcoming(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  return events
    .map((e) => ({ e, at: Date.parse(e.time) }))
    .filter((x) => Number.isFinite(x.at) && x.at >= now)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.e);
}
