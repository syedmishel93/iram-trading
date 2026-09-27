/**
 * Interval algebra for the bar archive.
 *
 * THE PROBLEM THIS SOLVES, AND WHY IT IS THE MOST IMPORTANT FILE IN THE STORE
 *
 * A cache that answers "here are 4,000 bars" without saying WHICH bars it is
 * missing is worse than no cache at all. A backtest handed a series with a
 * silent three-week hole in it does not crash — it produces a number, and that
 * number is wrong in a way nobody can see. The same is true of an ML training
 * set: a model trained across an invisible gap learns the discontinuity as if
 * it were a market move.
 *
 * So the archive never returns bars alone. It returns bars AND the gaps, and
 * the caller decides whether to fetch them, refuse to run, or proceed knowingly.
 * "I have no data here" and "the market was closed here" are also different
 * facts, and only the caller knows which matters.
 *
 * Everything here is pure integer-range arithmetic on [from, to] INCLUSIVE
 * millisecond bounds, so it is exhaustively testable without a database.
 */

export interface Range {
  /** Inclusive start, epoch ms. */
  from: number;
  /** Inclusive end, epoch ms. */
  to: number;
}

const byFrom = (a: Range, b: Range): number => a.from - b.from;

/**
 * Normalise a set of ranges: sorted, with overlapping or touching ranges merged.
 *
 * `tolerance` is what makes two ranges "touching". For a bar archive it should
 * be one bar interval: segments ending at 09:00 and starting at 10:00 on an
 * hourly series are CONTIGUOUS, not separated by a gap, and treating them as
 * separate would manufacture a hole that does not exist.
 */
export function normalise(ranges: readonly Range[], tolerance = 0): Range[] {
  const valid = ranges.filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to >= r.from);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort(byFrom);
  const out: Range[] = [{ ...(sorted[0] as Range) }];

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i] as Range;
    const last = out[out.length - 1] as Range;
    if (r.from <= last.to + tolerance) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Total covered milliseconds. Assumes `ranges` is already normalised. */
export function span(ranges: readonly Range[]): number {
  let total = 0;
  for (const r of ranges) total += r.to - r.from;
  return total;
}

/** The part of `want` that `have` does not cover. */
export function missing(want: Range, have: readonly Range[], tolerance = 0): Range[] {
  if (want.to < want.from) return [];
  const covered = normalise(have, tolerance);
  const gaps: Range[] = [];
  let cursor = want.from;

  for (const r of covered) {
    if (r.to < cursor) continue;
    if (r.from > want.to) break;
    if (r.from > cursor) {
      gaps.push({ from: cursor, to: Math.min(r.from - 1, want.to) });
    }
    cursor = Math.max(cursor, r.to + 1);
    if (cursor > want.to) break;
  }

  if (cursor <= want.to) gaps.push({ from: cursor, to: want.to });
  return gaps.filter((g) => g.to >= g.from);
}

/** The part of `want` that `have` DOES cover. */
export function intersect(want: Range, have: readonly Range[], tolerance = 0): Range[] {
  const covered = normalise(have, tolerance);
  const out: Range[] = [];
  for (const r of covered) {
    const from = Math.max(r.from, want.from);
    const to = Math.min(r.to, want.to);
    if (to >= from) out.push({ from, to });
  }
  return out;
}

/**
 * What share of `want` is covered, 0..1.
 *
 * Reported so a caller can refuse to backtest on a series that is only 60%
 * present, rather than discovering it from a strange equity curve.
 */
export function coverageRatio(want: Range, have: readonly Range[], tolerance = 0): number {
  const total = want.to - want.from;
  if (total <= 0) return have.length > 0 ? 1 : 0;
  return Math.min(1, span(intersect(want, have, tolerance)) / total);
}

/**
 * Split a range into chunks of at most `size` ms.
 *
 * Vendors cap how many bars one request may return, so a two-year backfill has
 * to become a queue of bounded requests. Emitted oldest-first: a partial
 * backfill that is interrupted should leave a contiguous archive with a hole at
 * the RECENT end, which the live feed then closes on its own.
 */
export function chunk(range: Range, size: number): Range[] {
  if (size <= 0 || range.to < range.from) return [];
  const out: Range[] = [];
  for (let from = range.from; from <= range.to; from += size) {
    out.push({ from, to: Math.min(from + size - 1, range.to) });
  }
  return out;
}

/**
 * Gaps that are real absences rather than closed markets.
 *
 * A gap shorter than `minBars` intervals is almost always a vendor hiccup or a
 * weekend, not missing history worth a request. Backfilling every two-bar hole
 * across a decade of FX data is thousands of requests for nothing.
 */
export function significantGaps(
  gaps: readonly Range[],
  intervalMs: number,
  minBars = 2,
): Range[] {
  if (intervalMs <= 0) return [...gaps];
  const floor = intervalMs * minBars;
  return gaps.filter((g) => g.to - g.from >= floor);
}
