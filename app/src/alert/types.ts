/**
 * Alert types.
 *
 * THE IDEA THAT MAKES THIS DIFFERENT FROM A PRICE ALERT
 * A static price alert is a number you typed once. It knows nothing about the
 * chart, so it goes stale the moment the market moves and you forget you set
 * it. An alert here can instead be ANCHORED TO A DETECTED STRUCTURE — a
 * trendline, an order block, a fair-value gap, a level — and it re-resolves
 * against a fresh detection run on every bar. The trendline re-fits; the alert
 * moves with it.
 *
 * WHY ANCHORS ARE KEYED ON TIME, NOT BAR INDEX
 * Bar indices shift. Load 200 more bars of history and every index in the array
 * changes meaning, so an anchor stored as "the structure starting at bar 412"
 * silently retargets to a different structure. Times do not move. An anchor
 * therefore records the START TIME of the structure it watches, and resolution
 * is a search for a structure of the same kind starting at that time.
 *
 * WHAT HAPPENS WHEN THE STRUCTURE IS GONE
 * Structures get invalidated: a fair-value gap fills, an order block is
 * mitigated, a trendline stops fitting. The alert does not silently stop
 * working — it becomes ORPHANED and says so. An alert that quietly never fires
 * again is worse than no alert, because you are still counting on it.
 */

import type { DetectionKind } from "../detect/types";

export type AlertCondition =
  /** Close crosses from at-or-below to above. */
  | "cross-above"
  /** Close crosses from at-or-above to below. */
  | "cross-below"
  /** Either direction. */
  | "cross-any"
  /** Close moves from outside a band to inside it. */
  | "enter"
  /** Close moves from inside a band to outside it. */
  | "exit"
  /**
   * The bar's range reached the anchor.
   *
   * The only condition that consults a wick, and therefore the only one that
   * can fire on evidence a close never confirmed. Labelled everywhere it is
   * offered, because "price touched it" and "price closed through it" are
   * different claims and traders conflate them constantly.
   */
  | "touch";

export const CONDITIONS: readonly { id: AlertCondition; label: string; blurb: string }[] = [
  { id: "cross-above", label: "Closes above", blurb: "A close crosses the anchor from below" },
  { id: "cross-below", label: "Closes below", blurb: "A close crosses the anchor from above" },
  { id: "cross-any", label: "Closes through", blurb: "A close crosses in either direction" },
  { id: "enter", label: "Enters zone", blurb: "A close moves into the band from outside it" },
  { id: "exit", label: "Leaves zone", blurb: "A close moves out of the band" },
  { id: "touch", label: "Wick touches", blurb: "The bar's range reached it — not confirmed by a close" },
];

/** Which price a band-shaped structure is watched at. */
export type AnchorEdge = "top" | "bottom" | "mid" | "band";

export type AlertAnchor =
  | { kind: "price"; price: number }
  | {
      kind: "detection";
      detKind: DetectionKind;
      /** Bar TIME at which the structure starts. Stable across reloads; indices are not. */
      fromTime: number;
      /** Human label captured at creation, so an orphaned alert can still say what it watched. */
      label: string;
      edge: AnchorEdge;
    };

export interface AlertSpec {
  id: string;
  symbol: string;
  timeframe: string;
  anchor: AlertAnchor;
  condition: AlertCondition;
  /** Stop after the first fire. The default: most alerts are one-shot by intent. */
  once: boolean;
  /**
   * Bars that must pass after a fire before it can fire again.
   *
   * Hysteresis already prevents a stationary price from re-firing (the
   * condition must reset first). This is the second guard, for a price
   * oscillating across the anchor: without it, chop on the line produces a
   * dozen notifications in an hour and you mute the whole system.
   */
  cooldownBars: number;
  enabled: boolean;
  createdAt: number;
  note: string;
  /**
   * Set when the anchor is a HIGHER-timeframe structure, e.g. "4h".
   *
   * The anchor itself carries no timeframe: a 4h order block and a 1h one are
   * both `detKind: "order-block"`. Without this the headless daemon would run
   * the detector on the chart timeframe, find nothing at that start time, and
   * report a perfectly good alert as orphaned forever.
   */
  timeframeAnchor?: string;
}

export interface AlertFire {
  alertId: string;
  /** Index within the evaluated array. Only meaningful alongside the same bars. */
  index: number;
  /** Bar open time — the stable identity of the firing bar. */
  time: number;
  /** The close (or wick, for `touch`) that satisfied the condition. */
  price: number;
  /** Where the anchor sat on that bar. For a trendline this differs every bar. */
  anchorPrice: number;
  /** Plain language, shown verbatim. Same contract as every other number here. */
  reason: string;
}

export type AlertStatus = "armed" | "orphaned" | "done" | "off";

export interface AlertRuntime {
  spec: AlertSpec;
  status: AlertStatus;
  /** Why it is orphaned, when it is. */
  statusNote: string;
  fires: AlertFire[];
  /** Where the anchor sits right now, for display. Null when unresolved. */
  currentAnchor: number | null;
}
