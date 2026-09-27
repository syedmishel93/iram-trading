/**
 * The Smart Money desk.
 *
 * Everything the structural detectors found on the series you are looking at,
 * as a readable list rather than as marks on a chart. The chart shows you WHERE;
 * this shows you WHAT, WHEN it became knowable, and WHY the detector thinks so.
 *
 * NOTHING NEW IS COMPUTED HERE
 * Every row comes from the same detectors the chart overlays use — break of
 * structure, fair value gaps, order blocks, double tops, head and shoulders,
 * trendlines, divergence. A desk that ran its own slightly different version of
 * "order block" would eventually disagree with the chart beside it, and the
 * user would have no way to tell which one was lying.
 *
 * ON THE NAME
 * "Smart money" is the industry's term for this family of patterns and it is
 * what people search for, so it is the name on the tab. It is worth being clear
 * that the phrase describes a STYLE OF ANALYSIS, not a counterparty: nothing
 * here observes institutional order flow, and no detector in this build has any
 * information about who traded. What they have is bars. An order block is the
 * last opposing candle before a displacement — that is a shape in the price,
 * and calling it a footprint of a bank is a story told about a shape.
 *
 * EVERY ROW CARRIES THE BAR IT COMPLETED ON
 * A pattern is only tradeable from the bar at which it became knowable, and
 * every detector in this build confirms on close for that reason. The "seen"
 * column is that bar, so a pattern that completed forty bars ago is visibly not
 * news.
 */

import { h } from "./dom";
import { pkWhy } from "./panelkit";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import type { BarView } from "../chart/series";
import { DETECTORS, runDetectors, toDetectInput, type DetectorId } from "../detect";
import { detectHigher, higherTimeframes } from "../detect/mtf";
import type { Detection } from "../detect/types";

export interface SmartMoneyOptions {
  readonly symbol: Signal<string>;
  readonly timeframe: Signal<string>;
  readonly bars: () => readonly BarView[];
  /** Jump the chart to a bar index. */
  readonly reveal?: (from: number, to: number) => void;
}

type SortKey = "recent" | "confidence";

const DIRECTION_LABEL: Record<Detection["direction"], string> = {
  long: "bullish",
  short: "bearish",
  neutral: "neutral",
};

export function createSmartMoney(opts: SmartMoneyOptions) {
  /** Which detectors to list. All of them by default — this is the desk for it. */
  const enabled = signal<DetectorId[]>(DETECTORS.map((d) => d.id));
  const sort = signal<SortKey>("recent");
  const minConfidence = signal(0);

  const detections = computed<Detection[]>(() => {
    const list = opts.bars();
    if (list.length < 30) return [];
    const input = toDetectInput(list);
    return runDetectors(input, enabled(), list.length);
  });

  const shown = computed<Detection[]>(() => {
    const min = minConfidence();
    const rows = detections().filter((d) => d.confidence >= min);
    return sort() === "recent"
      ? [...rows].sort((a, b) => b.to - a.to)
      : [...rows].sort((a, b) => b.confidence - a.confidence);
  });

  /**
   * The same detectors run on higher timeframes, for context.
   *
   * Separate from the list above and labelled as such: a break of structure on
   * the 4h and one on the 5m are not comparable events, and interleaving them
   * in one list by recency would put the 5m noise on top of the thing that
   * actually matters.
   */
  const higher = computed(() => {
    const list = opts.bars();
    if (list.length < 60) return [];
    const tfs = higherTimeframes(opts.timeframe());
    const on = enabled();
    if (tfs.length === 0 || on.length === 0) return [];
    const input = toDetectInput(list);
    /* One call per higher timeframe: `detectHigher` aggregates to a single
       label, and it returns detections already in this chart's index space. */
    return tfs.flatMap((tf) => detectHigher(input, tf, on));
  });

  const list = (cls: string, rows: () => HTMLElement[]) =>
    h("div", {
      class: cls,
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const r of rows()) el.appendChild(r);
        }),
    });

  const barsAgo = (to: number): string => {
    const n = opts.bars().length;
    const ago = Math.max(0, n - 1 - to);
    return ago === 0 ? "this bar" : `${ago} bars ago`;
  };

  const detectionRow = (d: Detection): HTMLElement =>
    h(
      "div",
      {
        class: "sm-row",
        "data-dir": d.direction,
        ...(opts.reveal ? { role: "button", tabindex: "0" } : {}),
        ...(opts.reveal ? { onclick: () => opts.reveal?.(d.from, d.to) } : {}),
      },
      h("span", { class: "sm-kind", text: d.label }),
      h("span", { class: "sm-dir", text: DIRECTION_LABEL[d.direction] }),
      h("span", { class: "sm-conf num", text: d.confidence.toFixed(2) }),
      h("span", { class: "sm-when num", text: barsAgo(d.to) }),
      h("span", { class: "sm-why", text: d.reason }),
    );

  const toggles = h(
    "div",
    { class: "sm-toggles" },
    ...DETECTORS.map((meta) =>
      h("button", {
        class: "sm-toggle",
        type: "button",
        text: meta.label,
        title: meta.blurb,
        "data-on": () => String(enabled().includes(meta.id)),
        onclick: () => {
          const on = enabled();
          enabled.set(on.includes(meta.id) ? on.filter((x) => x !== meta.id) : [...on, meta.id]);
        },
      }),
    ),
  );

  /* Lifted from the root call so the layout below can place them. */
  const smControls = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "What to look for" }),
    toggles,
    h(
      "div",
      { class: "sm-controls" },
      h(
        "label",
        { class: "sm-ctl" },
        h("span", { text: "Sort" }),
        h(
          "select",
          {
            class: "field-input",
            value: () => sort(),
            onchange: (e: Event) => sort.set((e.target as HTMLSelectElement).value as SortKey),
          },
          h("option", { value: "recent", text: "Most recent first" }),
          h("option", { value: "confidence", text: "Highest confidence first" }),
        ),
      ),
      h(
        "label",
        { class: "sm-ctl" },
        h("span", { text: () => `Minimum confidence ${minConfidence().toFixed(2)}` }),
        h("input", {
          type: "range",
          min: "0",
          max: "0.95",
          step: "0.05",
          value: () => String(minConfidence()),
          oninput: (e: Event) => minConfidence.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
      ),
    ),
    pkWhy(
      "Confidence is derived from measurable properties of the pattern — how clean the break was, how well the swings line up — never from a guess about intent.",
      "How confidence is measured",
    ),
  );

  const smList = h(
    "section",
    { class: "dd-panel" },
    h("h3", {
      class: "pf-sub",
      text: () => `On the ${opts.timeframe()} — ${shown().length} found`,
    }),
    list("sm-rows", () => shown().map(detectionRow)),
    h("p", {
      class: "sm-empty",
      "data-on": () => String(shown().length === 0),
      text: () =>
        opts.bars().length < 30
          ? "Not enough bars loaded to run the detectors."
          : enabled().length === 0
            ? "No detectors selected."
            : "Nothing found on this series at this confidence. That is a result, not a gap.",
    }),
  );

  const smHigher = h(
    "section",
    { class: "dd-panel", "data-on": () => String(higher().length > 0) },
    h("h3", { class: "pf-sub", text: "Higher timeframes" }),
    pkWhy(
      "Kept in its own list rather than merged by recency: a break of structure on the 4h and one on the 5m are not comparable events, and sorting them together buries the one that matters.",
      "Why these are listed separately",
    ),
    list("sm-rows", () =>
      higher().map((hd) =>
        h(
          "div",
          { class: "sm-row", "data-dir": hd.direction },
          h("span", { class: "sm-kind", text: `${hd.timeframe} · ${hd.label}` }),
          h("span", { class: "sm-dir", text: DIRECTION_LABEL[hd.direction] }),
          h("span", { class: "sm-conf num", text: hd.confidence.toFixed(2) }),
          h("span", { class: "sm-when num", text: barsAgo(hd.to) }),
          h("span", { class: "sm-why", text: hd.reason }),
        ),
      ),
    ),
  );

  const smTail = h(
    "section",
    { class: "dd-panel sm-note" },
    pkWhy(
      '"Smart money" names a style of analysis, not a counterparty. Nothing in this build observes institutional order flow, and no detector here has any information about WHO traded — only about what the bars did. An order block is the last opposing candle before a displacement: that is a shape in the price, and any account of whose order made it is a story told about a shape.',
      "What this can't tell you",
    ),
  );

  const el = h(
    "div",
    { class: "dd sm-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Smart money" }),
      h("p", {
        class: "view-sub",
        text: "Structure, gaps, order blocks and reversals found on this series — the same detectors the chart draws, listed with the bar each one completed on.",
      }),
    ),
    /*
     * PRIMARY  the lists. MEASURED at 7,623px and 23,696px tall, and a
     *          detection row carries a bar index, a time and a reason —
     *          it wants every pixel of the width.
     * RAIL     what to look for. It DECIDES what the lists contain, and
     *          in the old single column it scrolled away after the first
     *          screen, so changing a filter meant scrolling twenty
     *          thousand pixels back to reach it. The rail is sticky.
     */
    h(
      "div",
      { class: "dd-layout" },
      h("div", { class: "dd-primary" }, smList, smHigher, smTail),
      h("div", { class: "dd-rail" }, smControls),
    ),
  );

  return { el, detections, shown };
}
