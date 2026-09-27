/**
 * The Live panel — the inspector's only surface that says what CHANGED.
 *
 * Every other panel in the dock answers a standing question and repaints its
 * answer in place. This one is a log: newest first, one line each, with the
 * measurement behind it one click away. `analysis/live.ts` decides what goes in
 * it; this decides how it reads.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SEVERITY IS NOT DIRECTION, AND IT IS NOT COLOURED LIKE ONE
 *
 *   act    the attention role   (--attn)
 *   watch  muted text           (--text-muted)
 *   info   faint text           (--text-faint)
 *
 * NEVER the candle colours. A change of character confirmed downward is
 * exactly as worth reading as one confirmed upward, and a red row would say
 * the opposite — the same argument `--verdict-*` makes about the gates, and
 * the same order `--text-faint < --text-muted < --text` the inspector's shut
 * rows were once got wrong by not checking.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A ROW SHOWS ITS NUMBERS RATHER THAN SCROLLING THE CHART TO ITS BAR
 *
 * The obvious click target is "take me to that candle", and it is not cheap:
 * `ChartEngine` exposes `goLive()` and nothing else that moves the viewport —
 * the offset lives behind a private `Viewport`, and reaching in would mean a
 * new public API on the renderer plus the index arithmetic to centre a bar
 * that may have been backfilled underneath. That is an engine change, not a
 * panel one. So a row expands instead, onto the reason and the numbers, which
 * is the thing a log is actually read for: not "where was that" but "what was
 * the measurement".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO CLOCK, NO ANIMATION
 *
 * The time on a row is the ABSOLUTE time it fired, not "4m ago". A relative
 * age needs something to re-render it, and a readout whose freshness depends
 * on a second observer is the inspector's "1.2 screens of scroll" again — it
 * was wrong by a factor of 2.8 for exactly that reason. The absolute time is
 * right for ever with no observer at all.
 *
 * And nothing here animates. A row arriving is met dozens of times a session,
 * which is the frequency rule's own test for whether motion belongs.
 */

import { h } from "./dom";
import type { ReadSignal } from "../core/signal";
import { pkEmpty, pkWhy } from "./panelkit";
import type { LiveEvent, LiveEventKind, LiveValue } from "../analysis/live";

/**
 * A short, self-standing name for each kind.
 *
 * Self-standing because this is what the status bar gets, where there is room
 * for about twenty characters and no room for a sentence. "Structure" would
 * not do — it has to say what happened, not what it is about.
 */
export const KIND_LABEL: Readonly<Record<LiveEventKind, string>> = {
  "structure-break": "structure broke",
  "setup-appeared": "setup appeared",
  "setup-expired": "setup expired",
  "setup-flipped": "setup flipped",
  "gates-cleared": "gates clear",
  "gates-blocked": "stood down",
  "entry-zone": "in the zone",
  "stop-approach": "at the stop",
  "target-approach": "at target 1",
  "volatility-shift": "volatility shifted",
  "outlier-bar": "outlier bar",
  "volume-spike": "volume spike",
  "regime-change": "regime changed",
  "session-open": "venue opened",
  "session-close": "venue closed",
  "feed-degraded": "feed degraded",
  "feed-recovered": "feed recovered",
};

/**
 * One of an event's numbers, rendered.
 *
 * The engine publishes numbers as NUMBERS with a unit beside them, so this is
 * the one place that decides how each unit reads and a test can assert the
 * event's value without asserting a `toFixed`. `price` is the terminal's own
 * price formatter, passed in rather than reimplemented: one instrument is
 * quoted at 4,336.56 and another at 1.08423, and a fixed decimal count is
 * wrong on one of them whichever you pick.
 */
export function valueText(v: LiveValue, price: (n: number) => string): string {
  if (!Number.isFinite(v.value)) return "—";
  switch (v.unit) {
    case "price":
      return price(v.value);
    case "percent":
      return `${v.value.toFixed(2)}%`;
    case "multiple":
      return `${v.value.toFixed(1)}x`;
    case "sigma":
      return `${v.value.toFixed(1)} sigma`;
    case "r":
      return `${v.value.toFixed(2)}R`;
    case "percentile":
      return `${Math.round(v.value * 100)}th`;
    case "seconds":
      return v.value >= 120 ? `${(v.value / 60).toFixed(1)}m` : `${Math.round(v.value)}s`;
    case "count":
      return Math.round(v.value).toLocaleString();
    /* Significant figures, not decimals. One instrument trades 10.21716 of
       itself in a minute and another trades 4,120,000, and no fixed decimal
       count serves both — the same argument `pkNum` makes about a lot size. */
    case "quantity":
      return v.value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  }
}

/**
 * The status bar's one line.
 *
 * Deliberately just the kind. The live bar drops whatever does not fit and
 * this field competes with the price, the heat and the spread; a clause of the
 * event's sentence would be the first thing cut, and a half-cut sentence is
 * worse than a label. The whole sentence is the field's tooltip and the panel
 * is two keystrokes away.
 */
export function latestLine(e: LiveEvent | null): string {
  return e === null ? "" : KIND_LABEL[e.kind];
}

/** The tooltip behind that line: what happened and what measured it. */
export function latestTitle(e: LiveEvent | null): string {
  return e === null ? "No events yet on this chart." : `${e.what} ${e.because}`;
}

/**
 * The line under the panel head.
 *
 * Derived from the argument and nothing else — no measurement, nothing that
 * can go stale. The count of `act` rows is the half worth having: it is the
 * only number here that tells you whether to read the list now.
 */
export function feedSummary(events: readonly LiveEvent[]): string {
  if (events.length === 0) return "Nothing yet";
  const act = events.filter((e) => e.severity === "act").length;
  const n = `${events.length} event${events.length === 1 ? "" : "s"}`;
  return act === 0 ? n : `${n} · ${act} need a decision`;
}

/** Wall-clock, the way the rest of the terminal prints one. */
function clockText(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export interface LiveFeedOptions {
  /** Newest first, as `LiveState.seen` already is. */
  readonly events: ReadSignal<readonly LiveEvent[]>;
  /** How many rows to draw. The engine keeps 200; the panel shows the top of it. */
  readonly limit: number;
  readonly onClear: () => void;
  /** The terminal's price formatter. */
  readonly price: (n: number) => string;
}

export function createLiveFeed(opts: LiveFeedOptions): HTMLElement {
  /**
   * Which rows are expanded, kept OUTSIDE the render.
   *
   * The list is rebuilt whole whenever `events` changes — the same choice
   * `pkRowsLive` makes, and for the same reason: a list that is half reactive
   * and half not is a list with two update paths. Event ids are stable, so
   * holding the open set out here means a new event arriving does not shut the
   * row somebody is reading.
   */
  const open = new Set<string>();

  const row = (e: LiveEvent): HTMLElement =>
    h(
      "li",
      { class: "lf-row", "data-sev": e.severity },
      h(
        "details",
        {
          class: "lf-item",
          ...(open.has(e.id) ? { open: "" } : {}),
          ontoggle: (ev: Event) => {
            const d = ev.currentTarget as HTMLDetailsElement;
            if (d.open) open.add(e.id);
            else open.delete(e.id);
          },
        },
        h(
          "summary",
          { class: "lf-line", title: `${KIND_LABEL[e.kind]} — ${e.symbol} ${e.timeframe}` },
          h("span", { class: "lf-dot", "aria-hidden": "true" }),
          h("span", { class: "lf-time num", text: clockText(e.time) }),
          h("span", { class: "lf-what", text: e.what }),
        ),
        h(
          "div",
          { class: "lf-detail" },
          h("p", { class: "lf-because", text: e.because }),
          ...(e.values.length === 0
            ? []
            : [
                h(
                  "div",
                  { class: "pk-kv" },
                  ...e.values.flatMap((v) => [
                    h("span", { class: "pk-k", text: v.label }),
                    h(
                      "span",
                      { class: "pk-v" },
                      h("span", { class: "pk-val num", text: valueText(v, opts.price) }),
                    ),
                  ]),
                ),
              ]),
          h("p", {
            class: "lf-where",
            text: `${e.symbol} ${e.timeframe}${e.barTime === null ? "" : ` · bar ${clockText(e.barTime)}`}`,
          }),
        ),
      ),
    ) as HTMLElement;

  return h(
    "div",
    { class: "livefeed" },
    h(
      "div",
      { class: "lf-head" },
      h("span", { class: "lf-count", text: () => feedSummary(opts.events()) }),
      h("button", {
        class: "lf-clear tool-btn",
        type: "button",
        title: "Clear the list. The engine keeps watching.",
        text: "Clear",
        onclick: () => opts.onClear(),
      }),
    ),
    h("div", { class: "lf-body" }, () => {
      const list = opts.events();
      if (list.length === 0) {
        /* "empty" and not "loading": the engine IS running and this is its real
           answer. A spinner here would promise something that may never come. */
        return pkEmpty(
          "empty",
          "Nothing new since this chart loaded. Events appear as bars close and as the plan, checks or feed change.",
        );
      }
      return h("ol", { class: "lf-list" }, ...list.slice(0, opts.limit).map(row)) as HTMLElement;
    }),
    pkWhy(
      "Every line is a transition, not a state: a condition that is true is not news, a condition that BECAME true is. " +
        "Each one carries the measurement that produced it and the threshold it was checked against — a structure break " +
        "against the detector's confidence floor, an outlier against the volatility measured on the bars before it, a " +
        "volatility shift against the same percentile the regime model uses. Nothing fires twice while its condition " +
        "holds, and nothing fires on the first look at a chart, because none of what is already true just happened. " +
        "Detectors and the regime run only when a bar closes; price against the plan, the gates and the feed are checked " +
        "on every tick.",
      "How these are produced",
    ),
  ) as HTMLElement;
}

/**
 * The newest event, or null.
 *
 * Trivial, and exported anyway: the panel and the status bar must read the
 * SAME list rather than each keeping its own idea of "latest", which is the
 * equity defect's lesson applied to a log — one fact, one owner. `seen` is
 * newest-first by contract, and this is the one place that relies on it.
 */
export function newest(events: readonly LiveEvent[]): LiveEvent | null {
  return events[0] ?? null;
}
