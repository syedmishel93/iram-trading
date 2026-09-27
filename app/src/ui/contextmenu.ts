/**
 * Right-click, everywhere.
 *
 * THE MEASUREMENT
 * Across twenty-seven UI modules this application had exactly ONE
 * `oncontextmenu` handler, on a workspace pane. Right-clicking the chart, a
 * watchlist row, a drawing, a detected zone or an alert did nothing at all.
 *
 * That single fact explains most of why a fifteen-desk terminal feels like
 * navigation rather than work: every action you can take on a thing lived
 * somewhere that was not that thing — a menu at the top of the window, or a
 * desk you had to switch to and back from. You went to the tool; the tool never
 * came to you.
 *
 * WHY THE MENUS ARE GENERATED, NOT LISTED
 * Items are `MenuItem`s, so `{ id: "draw.magnet" }` pulls its title, its
 * accelerator, its enabled state and its tick from the command registry. A
 * hand-written context menu is wrong within two releases — it says "Undo
 * (Ctrl+Z)" long after the binding moved — and a menu you cannot trust is worse
 * than no menu, because you read it, it lies, and you stop opening it.
 *
 * WHAT IT REFUSES TO DO
 * It never suppresses the browser's own menu unless it actually has something
 * to show. A resolver returning `null` means "not my target", and the native
 * menu opens as usual — which is what you want over a text selection, a link,
 * or an input you are trying to paste into.
 */

import { openMenu, type MenuContext, type MenuItem } from "./menu";
import type { OverlayHandle } from "./overlay";

export interface ContextMenuOptions<T> {
  /** Where to listen. Usually a desk root or the chart host. */
  readonly host: HTMLElement;
  /**
   * What was right-clicked, or null to let the browser's own menu through.
   * Receives the raw event so a canvas can convert coordinates itself.
   */
  resolve(event: MouseEvent): T | null;
  /** The menu for that subject. An empty list also falls through to the browser. */
  items(subject: T, event: MouseEvent): MenuItem[];
  readonly ctx: MenuContext;
}

/**
 * Attach a right-click menu. Returns a disposer.
 *
 * One open menu at a time per host: a second right-click closes the first
 * rather than stacking, which is what every native menu does and what stops a
 * fast hand leaving three menus on screen.
 */
export function attachContextMenu<T>(opts: ContextMenuOptions<T>): () => void {
  let open: OverlayHandle | null = null;

  const onContextMenu = (event: Event): void => {
    const e = event as MouseEvent;

    /* A modifier means "I want the browser's menu" — the standard escape hatch
       for inspecting an element or using the platform's own actions. */
    if (e.shiftKey) return;

    const subject = opts.resolve(e);
    if (subject === null) return;

    const items = opts.items(subject, e);
    if (items.length === 0) return;

    e.preventDefault();
    open?.close();
    open = openMenu(items, {
      anchor: { x: e.clientX, y: e.clientY },
      placement: "bottom-start",
      ctx: opts.ctx,
      onClose: () => {
        open = null;
      },
    });
  };

  opts.host.addEventListener("contextmenu", onContextMenu);
  return () => {
    opts.host.removeEventListener("contextmenu", onContextMenu);
    open?.close();
    open = null;
  };
}

/**
 * Find the row a click landed in.
 *
 * Rows are the common case for a table-shaped desk, and every one of them would
 * otherwise write the same `closest()` walk with a slightly different guard.
 * Returns null when the click was outside any row, or on the header.
 */
export function rowSubject(
  event: MouseEvent,
  selector: string,
  attribute = "data-symbol",
): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const row = target.closest(selector);
  if (!row) return null;
  const value = row.getAttribute(attribute);
  return value !== null && value !== "" ? value : null;
}

/** A price and a bar index, for a click on the chart. */
export interface ChartPoint {
  readonly price: number;
  readonly index: number;
  /** Local coordinates within the host, for anything that needs them. */
  readonly x: number;
  readonly y: number;
}

/**
 * Turn a right-click on the chart into a price.
 *
 * `viewport` is passed rather than reached for, so this stays testable and the
 * caller keeps control of which chart it means when there are four panes.
 * Returns null outside the plot area — the axes and the toolbar are not prices.
 */
export function chartPoint(
  event: MouseEvent,
  host: HTMLElement,
  viewport: {
    priceAtY(y: number): number;
    indexAtX(x: number): number;
    plotLeft: number;
    plotTop: number;
    plotWidth: number;
    plotHeight: number;
  } | null,
): ChartPoint | null {
  if (!viewport) return null;
  const rect = host.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const inside =
    x >= viewport.plotLeft &&
    x <= viewport.plotLeft + viewport.plotWidth &&
    y >= viewport.plotTop &&
    y <= viewport.plotTop + viewport.plotHeight;
  if (!inside) return null;

  const price = viewport.priceAtY(y);
  if (!Number.isFinite(price)) return null;

  return { price, index: Math.floor(viewport.indexAtX(x)), x, y };
}
