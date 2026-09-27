/**
 * Key levels — the nearest prices the detectors found, above and below.
 *
 * The ranking is `scan/keylevels.ts`; this card only lays it out: up to three
 * rows above the current price, a marker for the price itself, up to three
 * below, nearest first on both sides. Each row names its price, what it is in
 * plain words, how far away it is, and how many detections agree on it.
 *
 * WHAT IT REFUSES TO DO
 * - Call anything above or below a price it does not have (`no-price`).
 * - Fill the card from structures that are not places on the price axis. A
 *   chart with only breaks and candle patterns says so (`none`).
 * - Claim a level is fresh when the detector did not record it. "mitigated",
 *   "filled" and "taken" appear only where the detector wrote them down.
 *
 * REPAINTING
 * The price ticks many times a second. Rows are rebuilt only when what they
 * SAY changes, so a focused row keeps its focus, and the "Why?" block is built
 * once so it does not snap shut on every tick.
 *
 * The title ("Key levels") belongs to the dock's card head, not here.
 */

import { computed, renderEffect } from "../../core/signal";
import { clear, h } from "../dom";
import { pkEmpty, pkWhy } from "../panelkit";
import type { Detection } from "../../detect/types";
import { keyLevels, type KeyLevel, type KeyLevelsResult } from "../../scan/keylevels";

export interface LevelsCardDeps {
  /** The chart's detections. In the shell: `detections`. */
  readonly detections: () => readonly Detection[];
  /** Current price, or null before the first bar. */
  readonly price: () => number | null;
  readonly fmtPx: (v: number) => string;
  /** ATR(14) in price units, for the merge tolerance. Optional: without it the tolerance is 0.1% of price. */
  readonly atr?: () => number | null;
  /** A row was clicked. The integrator scrolls or flashes the chart there. */
  readonly onPick?: (price: number) => void;
}

/** Distance as the row prints it: one decimal, two under 0.1%. */
export function fmtDistance(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

/** The kinds as one short phrase: two names, then "+N". */
export function kindPhrase(kinds: readonly string[]): string {
  if (kinds.length <= 2) return kinds.join(" + ");
  return `${kinds.slice(0, 2).join(" + ")} +${kinds.length - 2}`;
}

/** One row's text, "84,920 · resistance · 0.4% · ×2". Exported because the wording is the point. */
export function levelLine(l: KeyLevel, fmtPx: (v: number) => string): string {
  const parts = [fmtPx(l.price), kindPhrase(l.kinds), fmtDistance(l.distancePct)];
  if (l.count > 1) parts.push(`×${l.count}`);
  return parts.join(" · ");
}

function levelTitle(l: KeyLevel, fmtPx: (v: number) => string): string {
  const where = l.low === l.high ? fmtPx(l.low) : `${fmtPx(l.low)} – ${fmtPx(l.high)}`;
  const agree =
    l.count === 1 ? "One detection puts a level here" : `${l.count} separate detections put a level here`;
  const used =
    l.used === "used"
      ? ` Already ${l.usedWord}.`
      : l.used === "fresh"
        ? " Not yet used by price, as recorded by the detector."
        : "";
  return `${where}. ${agree}: ${l.sources.map((s) => s.name).join(", ")}.${used}`;
}

export function createLevelsCard(deps: LevelsCardDeps): HTMLElement {
  /* The price travels WITH the result it was ranked against. A computed
     settles a microtask later than the signal it reads, so reading the price
     separately in the paint would print a new price beside old distances. */
  const snapshot = computed<{ readonly px: number | null; readonly r: KeyLevelsResult }>(() => {
    const px = deps.price();
    return { px, r: keyLevels(deps.detections(), px, { atr: deps.atr ? deps.atr() : null }) };
  });
  const result = (): KeyLevelsResult => snapshot().r;

  const body = h("div", { class: "lv-body" });
  const why = pkWhy(() => {
    const r = result();
    const tol = r.state === "ok" ? `${r.tolerance.text} ` : "";
    return (
      "Only the prices the chart's own detectors drew: support and resistance, order blocks, gaps, " +
      "session and prior-day highs and lows, volume and pivot levels. Breaks, candle patterns and other " +
      "events are left out because they are not a price. " +
      tol +
      "×N counts separate detections at that price. Confluence bands are left out of the count because " +
      "they are made of the other detections. \"mitigated\", \"filled\" and \"taken\" appear only where " +
      "the detector recorded it."
    );
  }, "Why?");

  const el = h("div", { class: "lv-card" }, body, why);

  const row = (l: KeyLevel): HTMLElement => {
    const text = levelLine(l, deps.fmtPx);
    const title = levelTitle(l, deps.fmtPx);
    const kids = [
      h("span", { class: "lv-px num", text: deps.fmtPx(l.price) }),
      h("span", { class: "lv-kind", text: kindPhrase(l.kinds) }),
      h("span", { class: "lv-dist num", text: fmtDistance(l.distancePct) }),
      h("span", { class: "lv-n num", text: l.count > 1 ? `×${l.count}` : "" }),
      ...(l.used === "used" ? [h("span", { class: "lv-used", text: l.usedWord })] : []),
    ];
    const attrs = {
      class: "lv-row",
      "data-side": l.side,
      "data-used": l.used,
      "aria-label": text,
      title,
    };
    const onPick = deps.onPick;
    if (onPick) {
      return h("button", { ...attrs, type: "button", onclick: () => onPick(l.price) }, ...kids);
    }
    return h("div", attrs, ...kids);
  };

  const side = (label: string, list: readonly KeyLevel[], none: string): HTMLElement =>
    h(
      "div",
      { class: "lv-side" },
      h("div", { class: "lv-side-head", text: label }),
      list.length === 0 ? h("p", { class: "lv-none", text: none }) : h("div", { class: "lv-list" }, ...list.map(row)),
    );

  let lastKey = "";
  renderEffect(() => {
    const { r, px } = snapshot();
    const key =
      r.state === "ok"
        ? JSON.stringify([
            px === null ? "" : deps.fmtPx(px),
            r.total,
            ...[...r.above, ...r.inside, ...r.below].map((l) => [l.side, levelLine(l, deps.fmtPx), l.used, l.usedWord]),
          ])
        : `${r.state}:${r.reason}`;
    if (key === lastKey) return;
    lastKey = key;
    el.dataset["state"] = r.state;
    clear(body);

    if (r.state === "no-price") {
      body.appendChild(pkEmpty("loading", r.reason));
      return;
    }
    if (r.state === "none") {
      body.appendChild(pkEmpty("empty", r.reason));
      return;
    }

    body.appendChild(side("Above", r.above, "Nothing found above the price."));
    body.appendChild(
      h(
        "div",
        { class: "lv-now", "aria-label": "Current price" },
        h("span", { class: "lv-now-line" }),
        h("span", { class: "lv-now-px num", text: px === null ? "—" : `${deps.fmtPx(px)} now` }),
        h("span", { class: "lv-now-line" }),
      ),
    );
    if (r.inside.length > 0) {
      body.appendChild(
        h(
          "p",
          { class: "lv-inside" },
          `Price is inside: ${r.inside.map((l) => `${kindPhrase(l.kinds)} ${deps.fmtPx(l.low)} – ${deps.fmtPx(l.high)}`).join("; ")}.`,
        ),
      );
    }
    body.appendChild(side("Below", r.below, "Nothing found below the price."));
    body.appendChild(
      h("p", {
        class: "lv-note",
        text: `From the ${r.total} structure${r.total === 1 ? "" : "s"} the detectors found on this chart.`,
      }),
    );
  });

  return el;
}
