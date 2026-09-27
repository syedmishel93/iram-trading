/**
 * Keeping the view still when the series grows at the front.
 *
 * WHY THIS IS ITS OWN MODULE
 * `Viewport.offset` is an INDEX into the bar array, not a time. Auto-backfill
 * pushes older bars onto the FRONT, so every index shifts by however many
 * arrived — and an offset left untouched now points at completely different
 * bars. The chart lurches right by exactly the amount of history it just
 * gained, at the precise moment the operator reached left for more of it.
 * Scroll-back that jumps is worse than scroll-back that stops.
 *
 * The fix is one subtraction. Getting it wrong is invisible in code review and
 * obvious on screen, which is the shape of defect that belongs in a test — and
 * `ChartEngine` cannot be constructed in one, because jsdom has no 2D canvas
 * context. So the decision lives here, pure, and the engine calls it.
 */

/**
 * Index of the bar at `t`, or the nearest one after it. -1 when `t` is past the
 * end of the series.
 *
 * Binary search rather than a scan: this runs on every `setSeries`, which on a
 * live chart is every closed bar, and a scan would be over everything the
 * archive has ever backfilled.
 */
export function indexOfTime(times: ArrayLike<number>, length: number, t: number): number {
  let lo = 0;
  let hi = length - 1;
  if (hi < 0) return -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = times[mid] as number;
    if (v === t) return mid;
    if (v < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo < length ? lo : -1;
}

export interface AnchorInput {
  /** Timestamps of the series being replaced, ascending. */
  readonly prevTimes: ArrayLike<number>;
  readonly prevLength: number;
  /** Timestamps of the series arriving, ascending. */
  readonly nextTimes: ArrayLike<number>;
  readonly nextLength: number;
  /** The viewport's current offset, in bars from the start. */
  readonly offset: number;
  /** True when the chart is pinned to the newest bar. */
  readonly followLive: boolean;
  /** True when this is a different instrument or timeframe. */
  readonly replaced: boolean;
}

/**
 * How far to move `offset` so the same bar stays under the left edge.
 *
 * Zero in three cases, and each is deliberate rather than a fallback:
 *
 *  - `replaced` — a different instrument is a different question. The caller
 *    re-anchors to the newest bar instead; carrying a scroll position across
 *    would open every symbol at whatever position the last one was left in.
 *  - `followLive` — the offset is about to be recomputed from the end of the
 *    series anyway, and shifting it as well would double-count the prepend.
 *  - the anchor bar is gone — a retention sweep or a source change can drop it.
 *    Guessing a new position from a bar that no longer exists is worse than
 *    leaving the view where it is and letting the clamp sort it out.
 */
export function anchorShift(input: AnchorInput): number {
  if (input.replaced || input.followLive) return 0;
  if (input.prevLength === 0 || input.nextLength === 0) return 0;

  const index = Math.floor(input.offset);
  /* Clamped, not rejected: the offset is legitimately negative when the
     operator has overscrolled past the newest bar, and legitimately past the
     end while looking at the projection space to the right. Both are views a
     prepend still has to hold still. */
  const clamped = index < 0 ? 0 : index > input.prevLength - 1 ? input.prevLength - 1 : index;
  const anchorT = input.prevTimes[clamped] as number;
  if (!Number.isFinite(anchorT)) return 0;

  const now = indexOfTime(input.nextTimes, input.nextLength, anchorT);
  if (now < 0) return 0;
  return now - clamped;
}

/**
 * Is the view close enough to the start of the series to want older bars?
 *
 * `edgeBars` is a lead, not a trigger point: the fetch should be in flight
 * before the operator arrives at the wall, or the wall is what they see.
 */
export function needsOlderBars(firstVisibleIndex: number, edgeBars: number): boolean {
  return firstVisibleIndex <= edgeBars;
}
