/**
 * Auto-detect, moved to where it belongs.
 *
 * WHY IT MOVED
 * The detector toggles lived in the right-hand dock, four panels down, while
 * the drawing tools lived in the chart toolbar. Those two sets of controls do
 * the same job — they put marks on the chart — and splitting them meant
 * reaching across the screen to answer one question, and never seeing the
 * detectors at all if the dock happened to be shut. This is the same controls
 * in the toolbar, one button away from the pen.
 *
 * WHAT IT GAINED IN THE MOVE
 *  - **Per-detector counts.** "Order blocks" and "Order blocks · 4" are
 *    different pieces of information, and only the second one tells you whether
 *    switching it off will change what you are looking at.
 *  - **All / None.** Six clicks to clear the chart was six clicks.
 *  - **Higher-timeframe projection**, which was already beside the toggles in
 *    the dock and is the same question — which structure do I want to see.
 *  - **Pin as drawings.** The one genuinely new thing: a detection is
 *    recomputed on every load and cannot be edited or kept. Pinning converts it
 *    into ordinary drawings that are yours — see `draw/fromdetection.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * No "sensitivity" slider. The detectors derive confidence from measurable
 * properties, and a slider over the top of that would let you dial up the
 * number of structures found until the chart agreed with you — which is
 * exactly the failure the confidence figure exists to prevent.
 */

import { h } from "./dom";
import type { Signal } from "../core/signal";

export interface DetectorInfo {
  readonly id: string;
  readonly label: string;
  readonly blurb?: string;
  /** Group heading. Optional so callers that only need toggles stay simple. */
  readonly family?: string;
  readonly familyLabel?: string;
}

/**
 * Group the toggles under their family headings, in first-seen order.
 *
 * At thirteen detectors a flat grid was scannable. At twenty-nine it is a wall
 * of similar-length buttons in which nothing is findable, and the operator's
 * question is never "where is the toggle called X" — it is "what do I have for
 * liquidity". The families answer that question and the flat grid did not.
 *
 * A detector with no family is put under one heading at the end rather than
 * being dropped or silently promoted to its own group.
 */
export function groupByFamily(
  set: readonly DetectorInfo[],
): { key: string; label: string; items: DetectorInfo[] }[] {
  const out: { key: string; label: string; items: DetectorInfo[] }[] = [];
  for (const d of set) {
    const key = d.family ?? "other";
    const label = d.familyLabel ?? (d.family ? d.family : "Other");
    let group = out.find((g) => g.key === key);
    if (!group) {
      group = { key, label, items: [] };
      out.push(group);
    }
    group.items.push(d);
  }
  return out;
}

/**
 * How many of each structure to draw.
 *
 * A multiplier over the per-kind caps rather than a flat number, because the
 * sensible number of fair-value gaps and the sensible number of head-and-
 * shoulders patterns are not the same number and never were.
 */
export const DENSITIES = [
  { id: "focused", label: "Focused", factor: 0.5, hint: "About half as many — only the most recent of each kind." },
  { id: "normal", label: "Normal", factor: 1, hint: "The default caps." },
  { id: "everything", label: "All", factor: 6, hint: "Everything found. Expect a crowded chart on a long window." },
] as const;

export type DensityId = (typeof DENSITIES)[number]["id"];

export function densityFactor(id: string): number {
  return DENSITIES.find((d) => d.id === id)?.factor ?? 1;
}

export const DIRECTIONS = [
  { id: "both", label: "Both" },
  { id: "long", label: "Long" },
  { id: "short", label: "Short" },
] as const;

/**
 * Confidence steps offered by the filter.
 *
 * A short list of named stops rather than a continuous slider. Confidence here
 * is derived from measurable properties, so 0.62 and 0.64 do not differ in any
 * way a person could act on, and a slider invites exactly the fiddling that
 * ends with a threshold chosen because it made the chart agree with you.
 */
export const CONFIDENCE_STEPS = [
  { value: 0, label: "All" },
  { value: 0.4, label: "0.4+" },
  { value: 0.6, label: "0.6+" },
  { value: 0.8, label: "0.8+" },
] as const;

export interface DetectPanelOptions {
  readonly detectors: Signal<string[]>;
  readonly detectorSet: readonly DetectorInfo[];
  /**
   * The set a fresh install starts with. Offered as a third button beside
   * All/None because at twenty-nine detectors "All" stopped being a way back
   * from a mess and became a different mess. Omit it and the button is not
   * rendered; there is no invented fallback set.
   */
  readonly defaultDetectors?: readonly string[];
  readonly htf: Signal<string[]>;
  /** Lowest confidence worth drawing, 0..1. */
  readonly minConfidence: Signal<number>;
  /** How many of each kind to draw. */
  readonly density: Signal<string>;
  /** Draw only one side's structures, or both. */
  readonly direction: Signal<string>;
  /** Structures hidden by the filters above, so the panel can own up to it. */
  filtered(): number;
  /** Remove every drawing previously pinned from a detection. */
  onClearPinned(): void;
  /** How many such drawings exist on this chart right now. */
  pinnedCount(): number;
  /** Timeframes above the current one. Empty on the highest. */
  htfChoices(): readonly string[];
  /** How many structures each detector found in the loaded range. */
  counts(): ReadonlyMap<string, number>;
  /** Found in total, and how many of those are actually drawn. */
  found(): number;
  drawn(): number;
  /** Copy every drawn structure onto the chart as editable drawings. */
  onPin(): void;
}

/**
 * Which detectors to turn on when someone asks for "all".
 *
 * Every one of them, and that is a real choice rather than a default: the
 * alternative — a curated "sensible" subset — would be this file quietly having
 * an opinion about which structures matter, in a control labelled All.
 */
export function allDetectorIds(set: readonly DetectorInfo[]): string[] {
  return set.map((d) => d.id);
}

/**
 * What the All button should warn about.
 *
 * At thirteen detectors, All was a reasonable thing to press. At twenty-nine
 * it puts every overlay in the terminal on one price axis at once, which is
 * not a chart. The button still does exactly what it says — this only makes
 * the tooltip tell the truth about the result.
 */
export function allWarning(count: number): string {
  return count > 16
    ? `Turns on all ${count}. That is more overlays than one price axis can carry — useful for finding out what exists, not for reading.`
    : `Turns on all ${count}.`;
}

/**
 * The count line under the toggles. Exported because the wording is the point.
 *
 * `filtered` is reported separately from the drawing cap, because they are
 * different reasons for a structure not being on screen and only one of them
 * is something the user chose. "17 hidden by your filters" is actionable;
 * folding it into the cap's number is not.
 */
export function detectSummary(
  enabled: number,
  found: number,
  drawn: number,
  filtered = 0,
): string {
  if (enabled === 0) return "No detectors on — nothing is being looked for.";
  if (found === 0) return "Nothing detected in the loaded range.";

  const tail = filtered > 0 ? ` ${filtered} hidden by your filters.` : "";
  if (drawn >= found - filtered) {
    return `${found - filtered} structure${found - filtered === 1 ? "" : "s"} drawn.${tail}`;
  }
  /* The gap is named, not hidden. A chart showing 6 of 31 structures while the
     panel says "31 found" is a chart you will misread. */
  return `${found} found · ${drawn} drawn — most recent of each type.${tail}`;
}

export function createDetectPanel(opts: DetectPanelOptions): HTMLElement {
  const isOn = (id: string): boolean => opts.detectors().includes(id);

  const toggle = (id: string): void =>
    opts.detectors.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );

  return h(
    "div",
    { class: "detect-pop" },

    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Auto-detect" }),
      h("button", {
        class: "detect-mini",
        type: "button",
        text: "All",
        title: () => allWarning(opts.detectorSet.length),
        onclick: () => opts.detectors.set(allDetectorIds(opts.detectorSet)),
      }),
      /* The way back. Without it the only route out of a 29-overlay chart is
         un-ticking twenty-two things one at a time, and in practice that means
         the operator lives with the mess. */
      ...(opts.defaultDetectors && opts.defaultDetectors.length > 0
        ? [
            h("button", {
              class: "detect-mini",
              type: "button",
              text: "Default",
              title: `Back to the ${opts.defaultDetectors.length} a fresh install starts with.`,
              onclick: () => opts.detectors.set([...(opts.defaultDetectors ?? [])]),
            }),
          ]
        : []),
      h("button", {
        class: "detect-mini",
        type: "button",
        text: "None",
        onclick: () => opts.detectors.set([]),
      }),
    ),

    ...groupByFamily(opts.detectorSet).flatMap((group) => [
      h("div", { class: "detect-family", text: group.label }),
      h(
        "div",
        { class: "detect-grid" },
        ...group.items.map((d) =>
          h(
            "button",
            {
              class: "det-toggle",
              type: "button",
              ...(d.blurb === undefined ? {} : { title: d.blurb }),
              "aria-pressed": () => String(isOn(d.id)),
              onclick: () => toggle(d.id),
            },
            h("span", { class: "det-toggle-label", text: d.label }),
            /* The count sits ON the toggle rather than in a legend: the question
               "will turning this off change anything" is asked at the moment of
               clicking it. */
            h("span", {
              class: "det-toggle-n",
              text: () => {
                const n = opts.counts().get(d.id) ?? 0;
                return isOn(d.id) && n > 0 ? String(n) : "";
              },
            }),
          ),
        ),
      ),
    ]),

    h("div", {
      class: "detect-note",
      text: () =>
        detectSummary(opts.detectors().length, opts.found(), opts.drawn(), opts.filtered()),
    }),

    h("div", { class: "detect-sep" }),

    /**
     * The filters.
     *
     * Every one of them narrows what is DRAWN from what was found. None of them
     * changes what the detectors look for or how confident they are — that
     * distinction is the whole reason there is no sensitivity control here, and
     * it is why the count line reports filtered structures separately instead
     * of quietly lowering the "found" number.
     */
    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Show" }),
    ),

    segmented(
      "Confidence",
      CONFIDENCE_STEPS.map((c) => ({ id: String(c.value), label: c.label })),
      () => String(opts.minConfidence()),
      (id) => opts.minConfidence.set(Number(id)),
      "Structures whose measured confidence is below this are found but not drawn.",
    ),

    segmented(
      "Direction",
      DIRECTIONS.map((x) => ({ id: x.id, label: x.label })),
      () => opts.direction(),
      (id) => opts.direction.set(id),
      "Draw only the structures pointing one way. Useful when you already have a bias — and worth switching back off, because a chart filtered to agree with you is the point at which this stops being evidence.",
    ),

    segmented(
      "Density",
      DENSITIES.map((x) => ({ id: x.id, label: x.label })),
      () => opts.density(),
      (id) => opts.density.set(id),
      "How many of each kind to draw before the oldest are left off.",
    ),

    h("div", { class: "detect-sep" }),

    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Higher timeframe" }),
    ),
    h(
      "div",
      { class: "detect-grid" },
      () => {
        const offered = opts.htfChoices();
        if (offered.length === 0) {
          return h("div", {
            class: "detect-note",
            text: "Nothing higher than this timeframe.",
          });
        }
        return h(
          "div",
          { class: "detect-grid" },
          ...offered.map((tf) =>
            h("button", {
              class: "det-toggle",
              type: "button",
              title: `Project ${tf} structure onto this chart, confirmed on the ${tf} close`,
              "aria-pressed": () => String(opts.htf().includes(tf)),
              onclick: () =>
                opts.htf.update((list) =>
                  list.includes(tf) ? list.filter((x) => x !== tf) : [...list, tf],
                ),
              text: tf.toUpperCase(),
            }),
          ),
        );
      },
    ),

    h("div", { class: "detect-sep" }),

    h("button", {
      class: "detect-pin",
      type: "button",
      text: "Pin drawn structures as drawings",
      title:
        "Copy what is on the chart into editable drawings you own. They stay when the detector is switched off, and the detector stops moving them.",
      disabled: () => opts.drawn() === 0,
      onclick: () => opts.onPin(),
    }),
    h("p", {
      class: "detect-fine",
      text: "A detection is recomputed every load and cannot be edited. A pinned copy is yours.",
    }),

    /* The counterpart to Pin. Without it, pinning twice leaves two overlapping
       copies of everything and the only way back is deleting them by hand. */
    h("button", {
      class: "detect-mini detect-clear",
      type: "button",
      text: () => {
        const n = opts.pinnedCount();
        return n === 0 ? "Nothing pinned on this chart" : `Remove ${n} pinned drawing${n === 1 ? "" : "s"}`;
      },
      title: "Deletes only drawings created by Pin, on this chart. Anything you drew yourself is left alone.",
      disabled: () => opts.pinnedCount() === 0,
      onclick: () => opts.onClearPinned(),
    }),
  ) as HTMLElement;
}

/**
 * A labelled row of mutually exclusive choices.
 *
 * Three of these in a row is why it is a helper: written out longhand they
 * drifted apart within a day of each other.
 */
function segmented(
  label: string,
  items: ReadonlyArray<{ id: string; label: string }>,
  current: () => string,
  choose: (id: string) => void,
  hint: string,
): HTMLElement {
  return h(
    "div",
    { class: "detect-seg-row", title: hint },
    h("span", { class: "detect-seg-label", text: label }),
    h(
      "div",
      { class: "detect-seg" },
      ...items.map((it) =>
        h("button", {
          class: "detect-seg-btn",
          type: "button",
          text: it.label,
          "aria-pressed": () => String(current() === it.id),
          "data-on": () => String(current() === it.id),
          onclick: () => choose(it.id),
        }),
      ),
    ),
  ) as HTMLElement;
}
