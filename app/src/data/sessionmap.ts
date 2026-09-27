/**
 * Trading sessions, and when this instrument actually moves.
 *
 * TWO THINGS, AND THEY ARE NOT THE SAME THING
 *
 * 1. The session WINDOWS — Sydney, Tokyo, London, New York — which are
 *    calendar facts. They are the same for everybody and nothing measures them.
 *
 * 2. The ACTIVITY GRID — how much this particular instrument has actually moved
 *    in each weekday-and-hour bucket. That is a measurement, of your own stored
 *    bars, and it is the part worth having.
 *
 * The terminal this was recovered from showed a "typical-activity profile" and
 * described it as such. A canned profile is a picture of a market in general,
 * which is not a market you can trade. What is here is BTCUSDT's own hours if
 * BTCUSDT is what you have archived, with the sample count in every cell and
 * the thin cells marked as thin rather than coloured in as though they were
 * evidence.
 *
 * WHY RANGE AND NOT RETURN
 * `context.ts` already buckets mean RETURN, which answers "does it tend to go
 * up in this hour" — a directional question, and one that needs far more data
 * than anyone has before it means anything. This module buckets the average
 * high-to-low RANGE as a fraction of price, which answers "does it MOVE in this
 * hour". That is the question a session map is actually for: it converges much
 * faster, it is what decides whether a stop is reachable, and unlike direction
 * it is genuinely persistent across weeks.
 *
 * EVERYTHING IS UTC INSIDE, CONVERTED ONLY AT THE EDGE
 * A session pattern that shifts with the reader's clock is not a pattern; it is
 * a rendering artefact. Bucketing happens in UTC. The desk converts labels to
 * local time for display and says which it is showing.
 */

import type { BarView } from "../chart/series";

export interface SessionWindow {
  readonly id: string;
  readonly name: string;
  /** Hour of the day, UTC, when the session opens. */
  readonly openUtc: number;
  /** Hour of the day, UTC, when it closes. May be less than open (wraps). */
  readonly closeUtc: number;
  /** The city whose business day this is. */
  readonly city: string;
}

/**
 * The four majors, at their conventional hours.
 *
 * These are the widely-used approximations, NOT exchange calendars: they do not
 * shift for daylight saving, and London in July is genuinely an hour off from
 * London in January. The error is one hour on two of the four for part of the
 * year, which is fine for "is the London session on" and is not fine for
 * anything settlement-related. Nothing here is settlement-related.
 */
export const SESSIONS: readonly SessionWindow[] = [
  { id: "sydney", name: "Sydney", city: "Sydney", openUtc: 21, closeUtc: 6 },
  { id: "tokyo", name: "Tokyo", city: "Tokyo", openUtc: 0, closeUtc: 9 },
  { id: "london", name: "London", city: "London", openUtc: 7, closeUtc: 16 },
  { id: "newyork", name: "New York", city: "New York", openUtc: 12, closeUtc: 21 },
];

/** True when `hourUtc` falls inside the window, handling the midnight wrap. */
export function sessionOpenAt(s: SessionWindow, hourUtc: number): boolean {
  const h = ((hourUtc % 24) + 24) % 24;
  return s.openUtc <= s.closeUtc ? h >= s.openUtc && h < s.closeUtc : h >= s.openUtc || h < s.closeUtc;
}

export interface SessionStatus {
  readonly session: SessionWindow;
  readonly open: boolean;
  /** Hours until it opens, or until it closes if it is open. */
  readonly hoursUntilChange: number;
}

export function sessionStatuses(now: number = Date.now()): SessionStatus[] {
  const hour = new Date(now).getUTCHours() + new Date(now).getUTCMinutes() / 60;
  return SESSIONS.map((session) => {
    const open = sessionOpenAt(session, Math.floor(hour));
    const boundary = open ? session.closeUtc : session.openUtc;
    let delta = boundary - hour;
    while (delta <= 0) delta += 24;
    return { session, open, hoursUntilChange: delta };
  });
}

/**
 * The London/New York overlap, named because it is the one people mean.
 *
 * Returned as a window rather than a boolean so the desk can draw it; it is the
 * intersection of the two, which is 12:00-16:00 UTC on the hours above.
 */
export const OVERLAP: SessionWindow = {
  id: "overlap",
  name: "London / New York overlap",
  city: "—",
  openUtc: 12,
  closeUtc: 16,
};

/* ------------------------------------------------------------- activity --- */

/** Below this a cell's mean is whichever few bars happened to land in it. */
export const MIN_CELL_SAMPLES = 8;

export interface ActivityCell {
  /** 0 = Sunday, matching `Date.getUTCDay`. */
  readonly weekday: number;
  /** 0-23, UTC. */
  readonly hour: number;
  /** Mean (high − low) / close for bars in this cell, as a fraction. */
  readonly meanRange: number;
  readonly samples: number;
  readonly sufficient: boolean;
  /**
   * Where this cell sits against every other SUFFICIENT cell, 0..1.
   *
   * Computed against sufficient cells only. Ranking a two-sample cell among
   * the rest is how a data gap becomes the brightest square on the map.
   */
  readonly rank: number;
}

export interface ActivityGrid {
  readonly cells: readonly ActivityCell[];
  readonly totalSamples: number;
  /** Bar spacing in ms, measured. Below an hour the grid is meaningful. */
  readonly spacingMs: number;
  /** True when bars are coarser than an hour, so the grid cannot be filled. */
  readonly tooCoarse: boolean;
  readonly sufficientCells: number;
  /** One line the desk can print verbatim. */
  readonly note: string;
}

const EMPTY_GRID = (note: string, spacingMs: number, tooCoarse: boolean): ActivityGrid => ({
  cells: [],
  totalSamples: 0,
  spacingMs,
  tooCoarse,
  sufficientCells: 0,
  note,
});

/**
 * Mean range by weekday and hour, measured from the bars supplied.
 *
 * Returns an empty grid rather than a sparse one when the timeframe cannot
 * populate it: on daily bars every bar lands in one hour bucket, so a 7×24 grid
 * would be a 7×1 grid with 23 empty columns that LOOK like quiet hours. That is
 * a data-shape artefact rendered as a market fact, and it is the specific
 * failure this guard exists for.
 */
export function activityGrid(bars: readonly BarView[]): ActivityGrid {
  if (bars.length < 2) return EMPTY_GRID("No bars stored for this symbol and timeframe.", 0, false);

  /**
   * MEDIAN gap between consecutive bars, not `(last - first) / (n - 1)`.
   *
   * The endpoint formula is the mean gap, and a single outlier destroys it: one
   * bar arriving a month after the rest — an archive with a hole in it, an
   * exchange outage, a symbol that stopped trading and resumed — inflates the
   * mean far past an hour, and the grid then refuses itself as "too coarse" on
   * a series that is almost entirely hourly. The median does not care about the
   * gap, which is the whole reason to use it here.
   */
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const g = (bars[i] as BarView).t - (bars[i - 1] as BarView).t;
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return EMPTY_GRID("Bars carry no usable timestamps.", 0, false);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const spacingMs = Math.max(
    1,
    Math.round(
      gaps.length % 2 === 1 ? (gaps[mid] as number) : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2,
    ),
  );
  if (spacingMs > 3_600_000) {
    return EMPTY_GRID(
      "Bars are coarser than an hour, so an hour-of-day grid cannot be filled from them. Open this symbol on a 1h or faster timeframe and the map fills in.",
      spacingMs,
      true,
    );
  }

  const sum = new Float64Array(7 * 24);
  const count = new Float64Array(7 * 24);

  for (const b of bars) {
    if (!Number.isFinite(b.h) || !Number.isFinite(b.l) || !Number.isFinite(b.c) || b.c <= 0) continue;
    const range = (b.h - b.l) / b.c;
    if (!Number.isFinite(range) || range < 0) continue;
    const d = new Date(b.t);
    const idx = d.getUTCDay() * 24 + d.getUTCHours();
    sum[idx] = (sum[idx] as number) + range;
    count[idx] = (count[idx] as number) + 1;
  }

  const means: number[] = [];
  const raw: { weekday: number; hour: number; meanRange: number; samples: number; sufficient: boolean }[] = [];
  let total = 0;

  for (let w = 0; w < 7; w++) {
    for (let hh = 0; hh < 24; hh++) {
      const idx = w * 24 + hh;
      const n = count[idx] as number;
      total += n;
      const mean = n > 0 ? (sum[idx] as number) / n : NaN;
      const sufficient = n >= MIN_CELL_SAMPLES;
      raw.push({ weekday: w, hour: hh, meanRange: mean, samples: n, sufficient });
      if (sufficient) means.push(mean);
    }
  }

  means.sort((a, b) => a - b);
  const rankOf = (v: number): number => {
    if (means.length === 0 || !Number.isFinite(v)) return NaN;
    /* Mid-rank for ties: a grid where every hour is identical must read as
       uniformly typical, not as uniformly quietest. */
    let below = 0;
    let equal = 0;
    for (const m of means) {
      if (m < v) below++;
      else if (m === v) equal++;
    }
    return (below + equal / 2) / means.length;
  };

  const cells: ActivityCell[] = raw.map((c) => ({
    ...c,
    rank: c.sufficient ? rankOf(c.meanRange) : NaN,
  }));

  const sufficientCells = cells.filter((c) => c.sufficient).length;
  const note =
    sufficientCells === 0
      ? `${total} bars stored, but no weekday-and-hour cell has reached ${MIN_CELL_SAMPLES} yet. Nothing here is worth reading.`
      : `${total} bars, ${sufficientCells} of 168 cells with at least ${MIN_CELL_SAMPLES} samples. Cells below that are drawn empty rather than coloured.`;

  return { cells, totalSamples: total, spacingMs, tooCoarse: false, sufficientCells, note };
}

/** The busiest sufficient cells, most active first. */
export function busiest(grid: ActivityGrid, limit = 5): ActivityCell[] {
  return grid.cells
    .filter((c) => c.sufficient)
    .sort((a, b) => b.meanRange - a.meanRange)
    .slice(0, limit);
}

export const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Offset in whole hours between UTC and the reader's clock, e.g. +5.5 → 5.5. */
export function localOffsetHours(now: number = Date.now()): number {
  return -new Date(now).getTimezoneOffset() / 60;
}
