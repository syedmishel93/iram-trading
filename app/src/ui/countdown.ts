/**
 * Time until the current bar closes.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 * It was ten lines inline in `shell.ts`, untested, and wrong in four ways:
 *
 *   1. `${Math.floor(s / 60)}:${s % 60}` has no hours branch, so a 4H bar
 *      counted down from "239:59" and a daily bar from "1439:59". Nobody reads
 *      a four-digit minute field as time.
 *   2. It blanked to "—" whenever `left > span`, which is exactly what happens
 *      when the LOCAL CLOCK IS BEHIND the feed. A Windows box drifting three
 *      minutes off NTP made the 1m countdown permanently blank — not wrong,
 *      not late, just gone, with nothing on screen to say why.
 *   3. It blanked on `left < 0` too, so a stalled feed and a closed market and
 *      an unsupported timeframe all rendered as the same dash. Three different
 *      facts, one glyph.
 *   4. It read the span from a hard-coded `TF_MS` table keyed on the timeframe
 *      LABEL. The label is a request, not a promise: providers round, aggregate
 *      and backfill, and `sessionrange.ts` and `Series.spacingMs` had already
 *      learnt to measure instead. This one still trusted the label.
 *
 * THE RULE THIS MODULE KEEPS
 * A countdown that cannot count says WHICH of its reasons applies. "closed",
 * "due" and "late" are three separate facts and the bar has room for the word.
 * That is the same contract `honest()` enforces on every other live field: a
 * named gap, never a dash that could be read as a zero.
 */

import type { BarView } from "../chart/series";
import type { MarketState } from "../data/sessions";

export type CountdownKind =
  /** Counting down normally. */
  | "counting"
  /**
   * The newest bar is stamped further into the future than clock drift explains.
   * The feed's clock and ours disagree, and the countdown cannot be trusted.
   */
  | "ahead"
  /** The bar's close time has passed and the next bar has not arrived yet. */
  | "due"
  /** More than a whole bar overdue while the market is open — the feed stopped. */
  | "late"
  /** Overdue because the venue is shut. Not a fault. */
  | "closed"
  /** No bars, or a span we could not measure. */
  | "unknown";

export interface Countdown {
  readonly kind: CountdownKind;
  readonly text: string;
  /** Milliseconds remaining. Negative when overdue, NaN when unknown. */
  readonly msLeft: number;
}

/**
 * Nominal spans, used only as a SANITY BOUND on the measured one.
 *
 * Not as the source of truth: see reason 4 above. A timeframe missing from
 * this table is not an error — the span is measured, and an unknown label
 * simply skips the bound.
 */
export const NOMINAL_SPAN_MS: Readonly<Record<string, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "3d": 259_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  /* An AVERAGE month — 365.2425/12 days. Only ever used to sanity-check the
     measured spacing; the actual boundary comes from `nextCloseAt`. */
  "1M": 2_629_746_000,
};

/**
 * When the bar that opened at `open` actually closes.
 *
 * FOR EVERY TIMEFRAME BUT ONE this is `open + span`, because minutes, hours,
 * days and weeks are all fixed multiples of a millisecond. A CALENDAR MONTH IS
 * NOT: February is 2,419,200,000ms and July is 2,678,400,000 — an 11% spread —
 * so a monthly countdown built by adding a constant is wrong by up to three
 * days, every month, and wrong in a different direction depending on which
 * month you are in.
 *
 * Walks UTC because that is what the venues stamp klines in. A monthly bar
 * opens at 00:00 UTC on the 1st, so its close is 00:00 UTC on the 1st of the
 * next month, whatever length this one turned out to be.
 */
export function nextCloseAt(open: number, timeframe: string, span: number): number {
  if (!timeframe.endsWith("M")) return open + span;
  const n = parseInt(timeframe, 10);
  const months = Number.isFinite(n) && n > 0 ? n : 1;
  const d = new Date(open);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  );
}

/** Gaps sampled to measure the span. */
const SPAN_SAMPLE = 32;

/**
 * Measured spacing between bars — the median of the last `sample` gaps.
 *
 * The median, not the mean and not the last gap: one weekend, one holiday or
 * one vendor backfill would drag a mean anywhere, and the LAST gap is the one
 * gap guaranteed to be wrong on a live feed, because the newest bar is still
 * forming. This mirrors `Series.spacingMs`, which operates on the packed
 * columns; the live bar only ever holds a `BarView[]`.
 */
export function measuredSpan(bars: readonly BarView[], sample = SPAN_SAMPLE): number {
  if (bars.length < 2) return 0;
  const count = Math.min(sample, bars.length - 1);
  const gaps: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = bars.length - 1 - i;
    const gap = (bars[idx] as BarView).t - (bars[idx - 1] as BarView).t;
    /* A non-positive gap means duplicate or out-of-order timestamps. Skip it
       rather than let it vote: it is a feed defect, not a shorter bar. */
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] as number;
}

/**
 * The span to count against: measured, bounded by the label when we have one.
 *
 * The bound catches the case the median cannot: a chart holding only backfilled
 * daily bars on a "1m" request would measure 86,400,000 and count down from
 * 23:59:59 with total confidence. When the measurement and the label disagree
 * by more than 25% we do not silently pick one — we return the NOMINAL, because
 * the label is what the user asked for and the discrepancy means the history is
 * not what they asked for either.
 */
export function spanFor(bars: readonly BarView[], timeframe: string): number {
  const nominal = NOMINAL_SPAN_MS[timeframe];
  const measured = measuredSpan(bars);
  if (measured <= 0) return nominal ?? 0;
  if (nominal === undefined) return measured;
  const ratio = measured / nominal;
  return ratio > 0.75 && ratio < 1.25 ? measured : nominal;
}

/**
 * How far the local clock is BEHIND the feed, in milliseconds.
 *
 * A bar stamped `t` cannot exist before real time `t`, so seeing it while the
 * local clock still reads earlier than `t` proves the clock is slow by at least
 * the difference. That is a floor, not an estimate, and a floor is enough: it
 * is the only part of the skew that breaks the countdown.
 *
 * Never negative. A local clock running FAST is indistinguishable from a feed
 * that is simply a little behind, and guessing between them would blank a
 * working countdown to fix a fault that may not exist.
 */
export function clockSkew(lastBarOpen: number, now: number): number {
  return Math.max(0, lastBarOpen - now);
}

/**
 * The most skew this will silently absorb, for a given bar span.
 *
 * WHY THERE HAS TO BE A CEILING, AND WHAT IT COST NOT TO HAVE ONE
 * `clockSkew` corrects for NTP drift, which is seconds, and for a feed that
 * publishes a bar a moment before its nominal open, which is also seconds. It
 * was written for those and it is right for those.
 *
 * With no ceiling it also silently "corrects" a feed whose timestamps are on a
 * DIFFERENT CLOCK ENTIRELY. MT5 stamps bars on the broker's server clock, which
 * on the machine this was found on runs three hours ahead of UTC. Feed the
 * result through the correction and `left` comes out as exactly `span`, every
 * second, for ever: a 1m chart showing `NEXT 1:00` that never moved, on a live
 * feed, with nothing anywhere saying why. Three hours of wrong timestamps
 * rendered as a plausible-looking number.
 *
 * So: drift is absorbed, a different clock is REPORTED. The line between them
 * is a couple of minutes — more drift than any synced machine has — and never
 * more than one bar, because a whole bar of skew on a 1m chart is not drift
 * either.
 */
export function skewTolerance(span: number): number {
  return Math.min(span, 120_000);
}

/** Coarse "how far ahead" for the mis-stamped case. */
function aheadness(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `ahead ${Math.max(1, mins)}m`;
  const hrs = ms / 3_600_000;
  return hrs < 24 ? `ahead ${Number(hrs.toFixed(hrs < 10 ? 1 : 0))}h` : `ahead ${Math.round(hrs / 24)}d`;
}

/** `H:MM:SS` when there is an hour to show, `M:SS` when there is not. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Coarse "how late" for the stalled case — seconds are noise at this point. */
function lateness(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `late ${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `late ${hrs}h` : `late ${Math.floor(hrs / 24)}d`;
}

export interface CountdownInput {
  readonly bars: readonly BarView[];
  readonly timeframe: string;
  readonly now: number;
  /**
   * Whether the venue is open. `"unknown"` is treated as open — an instrument
   * whose calendar we do not have is not evidence that it is shut, and calling
   * a live feed "closed" is the worse of the two errors.
   */
  readonly market: MarketState;
}

export function countdown(input: CountdownInput): Countdown {
  const { bars, timeframe, now, market } = input;
  const last = bars.length > 0 ? (bars[bars.length - 1] as BarView) : null;
  const span = spanFor(bars, timeframe);

  if (last === null || !Number.isFinite(span) || span <= 0) {
    return { kind: "unknown", text: "—", msLeft: NaN };
  }

  const close = nextCloseAt(last.t, timeframe, span);

  /* Before correcting for skew, check the skew is the kind worth correcting.
     See `skewTolerance` — this branch is the three-hour bug. */
  const skew = clockSkew(last.t, now);
  if (skew > skewTolerance(span)) {
    return { kind: "ahead", text: aheadness(skew), msLeft: NaN };
  }

  const left = close - (now + skew);

  if (left >= 0) {
    return { kind: "counting", text: formatSpan(left), msLeft: left };
  }

  /* Overdue. Which of the three reasons is it?
     Order matters: a bar still counting down on a Friday afternoon is counting
     down correctly, so the market check only applies once the bar is late. */
  const overdue = -left;
  if (market === "closed") return { kind: "closed", text: "closed", msLeft: left };
  if (overdue <= span) return { kind: "due", text: "due", msLeft: left };
  return { kind: "late", text: lateness(overdue), msLeft: left };
}

/** Tone for the live bar. Only a stopped feed is worth colouring. */
export function countdownTone(k: CountdownKind): "warn" | "mute" | undefined {
  if (k === "late" || k === "ahead") return "warn";
  if (k === "closed" || k === "unknown") return "mute";
  return undefined;
}
