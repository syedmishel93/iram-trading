/**
 * The chart header ("Fusion" topbar): the pure parts, and the one DOM helper
 * that turns a pill into a menu trigger.
 *
 * WHY THE ROW STOPPED BEING A BUTTON FARM
 * It carried nine timeframes, six chart styles, three moving averages and six
 * tool buttons side by side — twenty-four controls of equal weight, most of
 * them touched once a week. The header now leads with what you are looking at
 * (symbol and last price) and folds the rarely-used choices behind three menus
 * built on `openMenu`, the SAME primitive the app menu and the desk bar use.
 * Every menu row is a registered command where one exists, so the check state,
 * accelerator and handler come from the registry and cannot drift from the
 * palette's copy of them.
 *
 * NOTHING HERE IS FABRICATED. The change chip is the change over the last
 * `CHANGE_LOOKBACK` bars of the series on screen, captioned with the span
 * those bars actually cover — not a "24h change" the terminal does not
 * compute for the chart's instrument. Too few bars is a dash, not a guess.
 */

import type { BarView } from "../../chart/series";
import { h } from "../dom";
import { openMenu, type MenuContext, type MenuItem } from "../menu";
import type { OverlayHandle } from "../overlay";

/**
 * The timeframes that stay on the face of the row.
 *
 * Five, in ladder order: the intraday-to-daily band a discretionary trader
 * moves through on every instrument. The ends of the ladder (1m, 3m, 1w, 1M)
 * are one click further away in "More", and the More button names the
 * timeframe when it is one of those, so the row always says what is showing.
 */
export const PINNED_TIMEFRAMES: readonly string[] = ["5m", "15m", "1h", "4h", "1d"];

export interface TimeframeSplit<T extends string> {
  readonly visible: readonly T[];
  readonly more: readonly T[];
  /** The current timeframe when it lives in "More"; null when it is visible. */
  readonly moreCurrent: T | null;
}

/** Split the ladder into the pinned face and the More menu, preserving order. */
export function splitTimeframes<T extends string>(
  all: readonly T[],
  pinned: readonly string[],
  current: string,
): TimeframeSplit<T> {
  const visible = all.filter((tf) => pinned.includes(tf));
  const more = all.filter((tf) => !pinned.includes(tf));
  const moreCurrent = more.find((tf) => tf === current) ?? null;
  return { visible, more, moreCurrent };
}

/** Bars the headline's change and range look back over. */
export const CHANGE_LOOKBACK = 24;

export interface BarChange {
  /** Percent change from the close `lookback` bars ago to the last close. */
  readonly pct: number;
  readonly from: number;
  readonly to: number;
  readonly lookback: number;
}

/**
 * Change from the close `lookback` bars before the last one.
 *
 * Refuses (null) with fewer than `lookback + 1` bars or a non-positive
 * reference: a change over "however many bars there happen to be" would be a
 * different number under the same caption.
 */
export function barChange(
  bars: readonly Pick<BarView, "c">[],
  lookback: number = CHANGE_LOOKBACK,
): BarChange | null {
  const n = bars.length;
  if (lookback < 1 || n < lookback + 1) return null;
  const to = (bars[n - 1] as Pick<BarView, "c">).c;
  const from = (bars[n - 1 - lookback] as Pick<BarView, "c">).c;
  if (!Number.isFinite(to) || !Number.isFinite(from) || from <= 0) return null;
  return { pct: ((to - from) / from) * 100, from, to, lookback };
}

/** High and low of the last `lookback` bars, or null with fewer. */
export function barRange(
  bars: readonly Pick<BarView, "h" | "l">[],
  lookback: number = CHANGE_LOOKBACK,
): { readonly high: number; readonly low: number } | null {
  const n = bars.length;
  if (lookback < 1 || n < lookback) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = n - lookback; i < n; i++) {
    const b = bars[i] as Pick<BarView, "h" | "l">;
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
  }
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}

/**
 * "+0.10%", "-2.35%", "0.00%".
 *
 * A value that ROUNDS to zero prints unsigned: "-0.00%" is a direction the
 * figure does not have.
 */
export function formatSignedPct(pct: number, dp = 2): string {
  if (!Number.isFinite(pct)) return "—";
  const rounded = Number(pct.toFixed(dp));
  if (rounded === 0) return `${(0).toFixed(dp)}%`;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(dp)}%`;
}

/** Direction as printed: flat whenever the printed figure is zero. */
export function changeDirection(pct: number, dp = 2): "up" | "down" | "flat" {
  if (!Number.isFinite(pct)) return "flat";
  const rounded = Number(pct.toFixed(dp));
  return rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
}

/**
 * The span `n` bars of `timeframe` cover, for the chip's caption.
 *
 * 24 × 1h is "24h", 24 × 15m is "6h", 24 × 4h is "4d". A calendar month is
 * not a fixed span, so 1M reads "24mo"; an unparseable label falls back to
 * "24 bars", which is always true.
 */
export function spanCaption(timeframe: string, n: number): string {
  const m = /^(\d+)([mhdwM])$/.exec(timeframe);
  if (!m) return `${n} bars`;
  const k = Number(m[1]) * n;
  const unit = m[2] as string;
  if (unit === "M") return `${k}mo`;
  if (unit === "w") return `${k}w`;
  const minutes = unit === "m" ? k : unit === "h" ? k * 60 : k * 1440;
  /* Days from two upward: "24h" is how a trader says one day of hourly bars. */
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * The last price, formatted by the status bar's rule: two decimals at or
 * above 1,000, five below. "—" when there is no bar.
 */
export function formatLastPrice(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const dp = v >= 1000 ? 2 : 5;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** What the Indicators pill counts: every overlay and pane switched on. */
export function indicatorCount(
  mas: readonly string[],
  studies: readonly string[],
  panes: readonly string[],
): number {
  return mas.length + studies.length + panes.length;
}

/**
 * Only one trigger can have its menu open at a time; this remembers which,
 * and whether the press now landing is ON that trigger.
 *
 * The overlay closes itself on a capture-phase pointerdown before the
 * trigger's own handler runs, so without this a press on an open pill would
 * close the menu and then immediately reopen it. The listener is registered
 * before the first menu opens, so it runs ahead of the overlay's.
 */
let openTrigger: HTMLElement | null = null;
let pressedOpenTrigger: HTMLElement | null = null;
let watching = false;

function watchPresses(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Node | null;
      pressedOpenTrigger = openTrigger && t && openTrigger.contains(t) ? openTrigger : null;
    },
    true,
  );
}

export interface MenuTriggerOptions {
  readonly items: () => readonly MenuItem[];
  readonly ctx: MenuContext;
  readonly placement?: "bottom-start" | "bottom-end";
}

/**
 * Make `button` open a menu: press, Enter, Space or ArrowDown opens it; a
 * second press, Escape or an outside press closes it (the last two are the
 * overlay's own). Items are resolved at open time, so ticks are never stale.
 */
export function asMenuTrigger<B extends HTMLElement>(button: B, opts: MenuTriggerOptions): B {
  watchPresses();
  let handle: OverlayHandle | null = null;

  const open = (): void => {
    button.setAttribute("aria-expanded", "true");
    openTrigger = button;
    handle = openMenu(opts.items(), {
      anchor: button,
      placement: opts.placement ?? "bottom-start",
      ctx: opts.ctx,
      onClose: () => {
        button.setAttribute("aria-expanded", "false");
        if (openTrigger === button) openTrigger = null;
        handle = null;
      },
    });
  };

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    /* pointerdown for the reason the app menu gives: the overlay dismisses on
       pointerdown, so a click handler would run after the press had closed it. */
    e.preventDefault();
    if (pressedOpenTrigger === button) {
      pressedOpenTrigger = null;
      return;
    }
    if (handle?.isOpen()) handle.close();
    else open();
  });
  button.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (handle?.isOpen()) handle.close();
    else open();
  });
  return button;
}

/** A pill's trailing caret, shared so all three menus read the same way. */
export const caret = (): HTMLElement =>
  h("span", { class: "tb-caret", text: "▾", "aria-hidden": "true" });
