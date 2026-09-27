/**
 * Is a card actually on screen — and tell me when it comes back.
 *
 * WHY NOT `isConnected`. Every inspector card is BUILT once and kept, so a
 * card removed from the column, or in a closed inspector, is still connected
 * to the document — hidden by an attribute or a `display: none` ancestor. The
 * first version of each v59.2 card polled on `isConnected` and so kept asking
 * its service every 30s while nobody could see the answer; the Watchlist card
 * fetched Binance's full ticker list from behind a closed panel. MEASURED in
 * the browser: removed cards reported `hidden: true` with fresh data in them.
 *
 * `getClientRects().length > 0` is false for anything not rendered — its own
 * `hidden`, any `display: none` ancestor — and true otherwise, including when
 * scrolled out of view, which is what "on the column" means here.
 *
 * A HIDDEN TAB IS NOT OFF SCREEN for the local services: this terminal sits in
 * a background tab while the operator works in MT5, and an alert list that
 * went stale there would be wrong exactly when it is next looked at. Callers
 * that hit a THIRD-PARTY API (Binance) add the visibility check themselves.
 */

export function isShown(el: Element): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/**
 * Call `fn` each time `el` goes from not rendered to rendered — a card added
 * back, the inspector reopened — so it never shows an answer from the last
 * time it was visible. No-op where ResizeObserver is missing (jsdom).
 *
 * A ResizeObserver, not an IntersectionObserver: `display: none` → shown is a
 * box change from 0×0, which RO reports; IO would also fire on every scroll
 * of the column, which is not "came back".
 */
export function onShown(el: Element, fn: () => void): void {
  if (typeof ResizeObserver === "undefined") return;
  let was = isShown(el);
  new ResizeObserver(() => {
    const now = isShown(el);
    if (now && !was) fn();
    was = now;
  }).observe(el);
}
