/**
 * The joint window, the split, and what the data can carry.
 *
 * THE ONE FACT THIS FILE EXISTS TO STATE
 * Asking for five years of history does not give you five years of study. A
 * joint study needs every series to cover the SAME bars, so the window is the
 * intersection — and the intersection is set by whichever series the archive
 * is thinnest on. Ask for five years of BTC against the dollar index and get
 * two and a half, because that is how much dollar index there is.
 *
 * Every tool that quietly returns the intersection without saying so produces
 * a result about a different period than the one that was asked for, and the
 * operator finds out when two studies with the same settings disagree. So the
 * shortfall is a value here, not a log line, and the subject step shows it
 * next to the control that caused it.
 *
 * WHAT A REGIME SERIES DOES NOT DO
 * It does not constrain the window. A regime proxy slices the result rather
 * than predicting it (see `spec.ts`), so a row it cannot classify is an
 * UNCLASSIFIED row, not a dropped one. Letting it cut the window would throw
 * away observations of the subject to gain a label nobody asked for.
 */

import type { Range } from "../store/segments";
import type { SeriesRole } from "./spec";

/** 365.2425 days. The same average `data/history.ts` uses, for the same reason. */
export const YEAR_MS = 31_556_952_000;
const MONTH_MS = YEAR_MS / 12;

export interface SeriesSpan {
  readonly symbol: string;
  readonly label: string;
  readonly role: SeriesRole;
  readonly bars: number;
  /** Timestamp of the oldest and newest bar held. Both 0 when nothing is. */
  readonly first: number;
  readonly last: number;
  /** Ranges inside the held span with nothing in them. */
  readonly gaps: readonly Range[];
  /**
   * Session-aware coverage of its own span, 0..1, or null when it could not be
   * measured. Null and 0 are different answers and the table shows them
   * differently: one is "no bars", the other is "not checked".
   */
  readonly coverage: number | null;
}

export interface WindowLimit {
  readonly symbol: string;
  readonly label: string;
  /** The oldest bar this series has — the reason the window starts there. */
  readonly first: number;
  readonly bars: number;
}

export interface JointWindow {
  readonly requestedFrom: number;
  readonly requestedTo: number;
  readonly from: number;
  readonly to: number;
  /** Span actually available to every column, in ms. Zero when there is none. */
  readonly spanMs: number;
  /** Which series cut the window short, newest-first-bar first. */
  readonly limitedBy: readonly WindowLimit[];
  /**
   * The sentence to put in front of the operator, or null when they got what
   * they asked for. Written for them, not for a log.
   */
  readonly shortfall: string | null;
  /** Why no window exists at all, or null. */
  readonly refusal: string | null;
}

/** "2 years 5 months", "11 months", "6 days". Never "2.41 years". */
export function spanLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "nothing";
  if (ms < MONTH_MS) {
    const days = Math.max(1, Math.round(ms / 86_400_000));
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const years = Math.floor(ms / YEAR_MS);
  const months = Math.round((ms - years * YEAR_MS) / MONTH_MS);
  /* Rounding twelve months up is the difference between "2 years 12 months"
     and "3 years", and only one of those is a thing anybody says. */
  const y = months === 12 ? years + 1 : years;
  const m = months === 12 ? 0 : months;
  const parts: string[] = [];
  if (y > 0) parts.push(`${y} year${y === 1 ? "" : "s"}`);
  if (m > 0) parts.push(`${m} month${m === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" ") : "under a month";
}

/**
 * Intersect the subject with its feature columns.
 *
 * `columns` is deliberately not "everything in the spec": pass only the series
 * that become panel columns. A regime proxy handed to this function would cut
 * the window for a slice label, which is exactly the trade this file refuses
 * to make.
 */
export function jointWindow(
  subject: SeriesSpan,
  columns: readonly SeriesSpan[],
  requestedFrom: number,
  requestedTo: number,
): JointWindow {
  const empty = [subject, ...columns].filter((s) => s.bars === 0);
  if (subject.bars === 0) {
    return {
      requestedFrom,
      requestedTo,
      from: 0,
      to: 0,
      spanMs: 0,
      limitedBy: [],
      shortfall: null,
      refusal: `No bars were loaded for ${subject.symbol}. There is nothing to study — this is a data problem, not a result.`,
    };
  }
  if (empty.length > 0) {
    const names = empty.map((s) => `${s.label} (${s.symbol})`).join(", ");
    return {
      requestedFrom,
      requestedTo,
      from: 0,
      to: 0,
      spanMs: 0,
      limitedBy: [],
      shortfall: null,
      refusal: `${names} loaded no bars at all, so there is no window every series covers. Remove ${empty.length === 1 ? "it" : "them"} or download the history first.`,
    };
  }

  let from = Math.max(requestedFrom, subject.first);
  let to = Math.min(requestedTo, subject.last);
  for (const c of columns) {
    from = Math.max(from, c.first);
    to = Math.min(to, c.last);
  }

  if (to <= from) {
    const newest = [subject, ...columns].reduce((a, b) => (a.first > b.first ? a : b));
    const oldestEnd = [subject, ...columns].reduce((a, b) => (a.last < b.last ? a : b));
    return {
      requestedFrom,
      requestedTo,
      from: 0,
      to: 0,
      spanMs: 0,
      limitedBy: [],
      shortfall: null,
      refusal:
        `These series do not overlap. ${newest.label} starts at ${new Date(newest.first).toISOString().slice(0, 10)} ` +
        `and ${oldestEnd.label} ends at ${new Date(oldestEnd.last).toISOString().slice(0, 10)}, so there is no period all of them cover.`,
    };
  }

  /* Who moved the start. Only series whose own first bar is newer than the
     requested start can have done it — the subject included, because "the
     archive only holds eighteen months of the thing you are studying" is the
     single most useful version of this sentence. */
  const limitedBy: WindowLimit[] = [subject, ...columns]
    .filter((s) => s.first > requestedFrom)
    .sort((a, b) => b.first - a.first)
    .map((s) => ({ symbol: s.symbol, label: s.label, first: s.first, bars: s.bars }));

  const requestedSpan = requestedTo - requestedFrom;
  const spanMs = to - from;
  /* A day of slack. Vendors publish the oldest bar of a five-year window a few
     hours either side of the boundary, and a shortfall notice that fires on
     four hours is a notice people learn to ignore. */
  const short = requestedSpan - spanMs > 86_400_000 && limitedBy.length > 0;

  return {
    requestedFrom,
    requestedTo,
    from,
    to,
    spanMs,
    limitedBy,
    shortfall: short ? shortfallText(requestedSpan, spanMs, limitedBy) : null,
    refusal: null,
  };
}

function shortfallText(
  requestedSpan: number,
  spanMs: number,
  limitedBy: readonly WindowLimit[],
): string {
  const culprit = limitedBy[0];
  const who =
    culprit === undefined
      ? "one of the series"
      : `${culprit.label} has only ${culprit.bars.toLocaleString()} bars in the archive`;
  const others =
    limitedBy.length > 1 ? ` (${limitedBy.length - 1} other series also start later than that.)` : "";
  return (
    `You asked for ${spanLabel(requestedSpan)}. The joint window is ${spanLabel(spanMs)}, because ${who} ` +
    `and a joint study can only use bars every series covers. Drop it to use the full window, or download more of it first.${others}`
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */

export interface Segment {
  readonly name: "train" | "validate" | "holdout";
  /** Inclusive start index into the aligned rows. */
  readonly from: number;
  /** Exclusive end index. */
  readonly to: number;
  readonly bars: number;
}

export interface Split {
  readonly total: number;
  readonly train: Segment;
  readonly validate: Segment;
  readonly holdout: Segment;
  /** Bars removed between each pair of segments, per boundary. */
  readonly embargo: number;
  /** Total bars thrown away to keep the segments from touching. */
  readonly discarded: number;
  readonly refusal: string | null;
}

export interface SplitShares {
  readonly train: number;
  readonly validate: number;
  readonly holdout: number;
}

export const DEFAULT_SHARES: SplitShares = { train: 0.6, validate: 0.2, holdout: 0.2 };

/**
 * How many bars sit between two segments, and why there have to be any.
 *
 * TWO separate leaks, one number each:
 *
 *   PURGE — a label at the last training bar looks `horizon` bars ahead, and
 *   those bars are in validate. Train on it and the model has seen validate.
 *
 *   EMBARGO — the first validation bars are serially correlated with the last
 *   training ones, so a model that memorised the end of training scores well
 *   on the start of validation without having learned anything.
 *
 * Both are `horizon` bars wide, so the gap is twice it. Derived rather than
 * configured, because a fixed "48 bars" is right at a 24-bar horizon and
 * silently wrong at a 200-bar one.
 */
export function embargoFor(horizon: number): number {
  return Math.max(1, Math.round(horizon)) * 2;
}

/**
 * Cut the aligned rows into train, validate and holdout.
 *
 * In TIME order, never shuffled. The point of the holdout is that it is the
 * future relative to everything else, and a random split destroys exactly that
 * while producing better-looking numbers — which is why it is tempting.
 */
export function splitWindow(
  total: number,
  horizon: number,
  shares: SplitShares = DEFAULT_SHARES,
): Split {
  const embargo = embargoFor(horizon);
  const discarded = embargo * 2;
  const usable = total - discarded;

  const blank = (name: Segment["name"]): Segment => ({ name, from: 0, to: 0, bars: 0 });

  if (!Number.isFinite(total) || usable <= 0) {
    return {
      total,
      train: blank("train"),
      validate: blank("validate"),
      holdout: blank("holdout"),
      embargo,
      discarded,
      refusal:
        `${Math.max(0, total).toLocaleString()} aligned rows cannot be split at a ${horizon}-bar horizon: ` +
        `${discarded} of them have to be discarded at the two boundaries to stop the label of one segment reaching into the next, ` +
        `and that leaves nothing behind.`,
    };
  }

  const sum = shares.train + shares.validate + shares.holdout;
  const trainBars = Math.floor((usable * shares.train) / sum);
  const validateBars = Math.floor((usable * shares.validate) / sum);
  const holdoutBars = usable - trainBars - validateBars;

  const train: Segment = { name: "train", from: 0, to: trainBars, bars: trainBars };
  const vFrom = trainBars + embargo;
  const validate: Segment = {
    name: "validate",
    from: vFrom,
    to: vFrom + validateBars,
    bars: validateBars,
  };
  const hFrom = validate.to + embargo;
  const holdout: Segment = {
    name: "holdout",
    from: hFrom,
    to: hFrom + holdoutBars,
    bars: holdoutBars,
  };

  const thin = [train, validate, holdout].filter((s) => s.bars < horizon * 10);
  const refusal =
    thin.length > 0
      ? `${thin.map((s) => s.name).join(" and ")} would hold fewer than ten non-overlapping observations at a ${horizon}-bar horizon. ` +
        `A score from that is not distinguishable from chance. Shorten the horizon, lengthen the history, or drop the series that is cutting the window.`
      : null;

  return { total, train, validate, holdout, embargo, discarded, refusal };
}

/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The number of rows per free parameter this budget assumes.
 *
 * Twenty. It is a convention, not a theorem, and it is stated here as a named
 * assumption rather than buried in an expression because the budget it
 * produces is the number the whole subject step is arranged around. Anyone who
 * prefers ten or fifty can read this line and halve or double the answer in
 * their head, which is the most a heuristic can honestly offer.
 */
export const ROWS_PER_PARAMETER = 20;

export interface ParameterBudget {
  readonly trainRows: number;
  readonly horizon: number;
  /** Non-overlapping observations — the only ones that are independent. */
  readonly effectiveN: number;
  readonly budget: number;
  /** Inputs, intermediates and the assumption, in one paragraph. */
  readonly working: string;
}

/**
 * How many free parameters the training window can carry.
 *
 * THE CORRECTION THAT MAKES THIS DIFFERENT FROM A ROW COUNT
 * At a 24-bar horizon, consecutive rows share 23 of the 24 bars their labels
 * are computed over. Twelve thousand such rows are not twelve thousand
 * observations; they are about five hundred, repeated. Dividing by the horizon
 * is the standard blunt correction for that, and it is blunt — it treats
 * overlap as total within the horizon and zero beyond it. It is still far
 * closer than the row count, which overstates the evidence by the horizon.
 */
export function parameterBudget(trainRows: number, horizon: number): ParameterBudget {
  const h = Math.max(1, Math.round(horizon));
  const rows = Math.max(0, Math.floor(trainRows));
  const effectiveN = Math.floor(rows / h);
  const budget = Math.floor(effectiveN / ROWS_PER_PARAMETER);
  return {
    trainRows: rows,
    horizon: h,
    effectiveN,
    budget,
    working:
      `${rows.toLocaleString()} training rows at a ${h}-bar horizon. Consecutive labels share ${h - 1} of their ${h} bars, ` +
      `so the independent observations number about ${rows.toLocaleString()} ÷ ${h} = ${effectiveN.toLocaleString()}. ` +
      `At the assumed ${ROWS_PER_PARAMETER} observations per free parameter that supports about ${budget}. ` +
      `The 20 is a convention, not a result — halve it if you want to be harsh, double it if you are willing to be wrong more often.`,
  };
}
