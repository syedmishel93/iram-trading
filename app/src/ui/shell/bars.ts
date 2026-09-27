/**
 * Locating a bar by timestamp — the two resolutions, kept apart.
 *
 * Lifted out of `shell.ts` unchanged. `mountShell` was a single 7,476-line
 * function and the file around it had become the place anything shell-shaped
 * landed; these had no dependency on that closure at all, which is what made
 * them safe to move first and is the test for whatever moves next.
 */

/** Moving averages offered on the chart. Colours are semantic roles. */
/**
 * First bar at or after `t`, or null when `t` is outside the loaded window.
 *
 * ANCHOR semantics, and the null is the point. Clamping to bar 0 would
 * silently re-anchor an anchored VWAP to the left edge of whatever happened to
 * load, which looks exactly like a working anchor and is a different
 * measurement entirely. For a POSITION, whose bar must always resolve, use
 * `openedBarIndex` below — the two needs are genuinely different and sharing
 * one function got the exit panel wrong.
 */
export function indexAtOrAfter(bars: readonly { readonly t: number }[], t: number): number | null {
  if (bars.length === 0) return null;
  if (t > (bars[bars.length - 1] as { t: number }).t) return null;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid] as { t: number }).t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Which loaded bar a POSITION was opened on. Always resolves.
 *
 * MEASURED, after the exit panel silently never appeared. A trade recorded
 * just now carries `openedAt = Date.now()`, which on an hourly chart is after
 * the newest bar's timestamp — so `indexAtOrAfter` correctly returned null for
 * an anchor and the Setup card concluded there was no position to manage. The
 * position was real; only the lookup was wrong.
 *
 * Both ends clamp, and both clamps are the honest answer here rather than a
 * shortcut. After the last bar means NOW, which is the live edge. Before the
 * first means the trade is older than the window you happen to have scrolled
 * to — the position still exists, and refusing to manage it because of a
 * viewport is worse than a slightly understated holding time. Understated is
 * also the safe direction: it makes the time stop fire later, never sooner.
 */
export function openedBarIndex(bars: readonly { readonly t: number }[], t: number): number | null {
  if (bars.length === 0) return null;
  const last = bars.length - 1;
  if (t >= (bars[last] as { t: number }).t) return last;
  const found = indexAtOrAfter(bars, t);
  return found ?? 0;
}
