/**
 * The studies panel — the other half of the chart toolbar's job.
 *
 * WHY IT LOOKS LIKE THE DETECT PANEL
 * Because it is the same question asked about a different thing. Auto-detect
 * puts SHAPES on the chart from pattern rules; studies put LINES on it from
 * arithmetic. Splitting them into two idioms would mean learning the control
 * twice, so this deliberately mirrors `detectpanel.ts`: grouped toggles, All
 * and None, a count line that owns up to what is not being drawn.
 *
 * WHAT IT ADDS THAT THE DETECT PANEL HAS NO EQUIVALENT OF
 * An ANCHOR. Most studies are a pure function of the loaded bars, and two of
 * them are not — anchored VWAP hangs from a bar you choose, and that choice is
 * the whole indicator. A panel that offered "Anchored VWAP" as a plain toggle
 * would be offering session VWAP with extra steps.
 *
 * PERIOD BOXES, WHICH THIS PANEL USED TO REFUSE
 * It said a panel full of spinners "invites tuning the indicator until the
 * chart agrees with you". The concern was right and the conclusion was not: a
 * 14-period RSI on a 3-minute chart and on a weekly are not the same
 * instrument, and `indicators.ts` has always taken the period as an argument.
 * Refusing to expose it was a missing feature, not a safeguard.
 *
 * The safeguard is kept in the form that actually works. Every parameter knows
 * its published default, a tuned indicator is marked as tuned in the panel AND
 * in its own pane label, the count of tuned indicators is on the face of the
 * panel, and reset is one click. What the old note feared was not somebody
 * changing a period — it was somebody changing it and then forgetting. So the
 * change is allowed and the forgetting is made impossible. See chart/params.ts.
 */

import { h } from "./dom";
import { FAMILY_LABEL, STUDIES, type StudyMeta } from "../chart/studies";
import { PANES, PANE_FAMILY_LABEL, paneSummary, type PaneMeta } from "../chart/panes";
import { signal, type Signal } from "../core/signal";
import {
  clampParam,
  hasParams,
  isDefault,
  paramDefs,
  sanitiseParams,
  tunedCount,
  type Params,
} from "../chart/params";

export interface ProfileSummary {
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly basis: string;
}

export interface StudyPanelOptions {
  readonly studies: Signal<string[]>;
  /**
   * Sub-panes stacked BELOW the chart, from `chart/panes.ts`.
   *
   * Separate from `studies` and not merged into it, because the two are not
   * the same object: a study shares the price axis and a pane brings its own.
   * One list with a hidden flag would make "why is RSI not on my chart" a
   * question about which half of the list it landed in.
   */
  readonly panes: Signal<string[]>;
  /** Pane ids the chart had no room for. Named in the note rather than left
      to look like a broken indicator. */
  panesDropped(): readonly string[];
  /**
   * Per-indicator settings, shared by the studies and the panes.
   *
   * The SAME signal the chart renders from — not a copy — so a period changed
   * here is a period the next repaint uses. Only tuned indicators are present;
   * an absent id means "published defaults", which is why resetting is a
   * delete rather than a write.
   */
  readonly params: Signal<Record<string, Params>>;
  /** Bar the anchored studies hang from, as a timestamp. Null when unset. */
  readonly anchor: Signal<number | null>;
  /** Time of the newest loaded bar, for "anchor here". Null when no bars. */
  newestBarTime(): number | null;
  /** Time of the most recent swing the detectors found, if any. */
  swingTime(): number | null;
  /** Rendered anchor, e.g. "12 Mar 14:00". Empty when unset. */
  anchorLabel(): string;
  /** Point of control and value area, or null when the window has no volume. */
  profile(): ProfileSummary | null;
  /** Format a price the way the chart's axis does. */
  price(v: number): string;
}

/** Studies that do nothing useful without an anchor. */
export const ANCHORED_STUDIES: readonly string[] = ["avwap"];

/**
 * The line under the toggles.
 *
 * Reports the two reasons a study can be enabled and invisible, separately,
 * because only one of them is something the operator can fix: an anchored
 * study with no anchor is waiting on a click, and a volume study on a
 * volumeless feed is waiting on a different data source.
 */
export function studySummary(
  enabled: readonly string[],
  hasAnchor: boolean,
  hasVolume: boolean,
): string {
  if (enabled.length === 0) return "No studies on the chart.";

  const waiting: string[] = [];
  if (!hasAnchor && enabled.some((id) => ANCHORED_STUDIES.includes(id))) {
    waiting.push("anchored VWAP has no anchor — pick a bar below");
  }
  if (!hasVolume && enabled.some((id) => id === "vwap" || id === "profile")) {
    waiting.push("this feed reports no volume, so the volume studies are blank");
  }

  const n = `${enabled.length} stud${enabled.length === 1 ? "y" : "ies"} on the chart.`;
  return waiting.length === 0 ? n : `${n} ${waiting.join("; ")}.`;
}

export function createStudyPanel(opts: StudyPanelOptions): HTMLElement {
  /**
   * Which indicator's settings are open. One at a time, by id.
   *
   * Local rather than persisted: which spinner you last had open is not a
   * preference, and restoring an open editor on boot would have the panel
   * come up in a state nobody asked for.
   */
  const editing = signal<string | null>(null);

  const labelOf = (id: string): string =>
    STUDIES.find((x) => x.id === id)?.label ?? PANES.find((x) => x.id === id)?.label ?? id;

  /** Always complete and legal — see `sanitiseParams`. */
  const paramsOf = (id: string): Params => sanitiseParams(id, opts.params()[id]);

  const writeParam = (id: string, key: string, raw: string): void => {
    const def = paramDefs(id).find((d) => d.id === key);
    if (def === undefined) return;
    const next = { ...paramsOf(id), [key]: clampParam(def, Number(raw)) };
    opts.params.update((all) => {
      const out = { ...all };
      /* A set of values that is entirely default is stored as ABSENT, not as a
         map of defaults. It keeps the preferences blob small and makes "is
         anything tuned" a question about the map's keys rather than a
         comparison of every number in it. */
      if (isDefault(id, next)) delete out[id];
      else out[id] = next;
      return out;
    });
  };

  const resetParams = (id: string): void =>
    opts.params.update((all) => {
      const out = { ...all };
      delete out[id];
      return out;
    });

  /** The gear beside a toggle. Absent for indicators with nothing to tune. */
  const gear = (id: string): HTMLElement[] =>
    hasParams(id)
      ? [
          h("button", {
            class: "study-gear",
            type: "button",
            title: `Settings for ${labelOf(id)}`,
            "aria-label": `Settings for ${labelOf(id)}`,
            "aria-expanded": () => String(editing() === id),
            /* Lit when this indicator is NOT on its published settings, so the
               tuning is visible without opening anything. */
            "data-tuned": () => String(!isDefault(id, opts.params()[id])),
            onclick: () => editing.update((cur) => (cur === id ? null : id)),
            text: "⚙",
          }),
        ]
      : [];

  /**
   * The settings for whichever indicator is open, when it belongs to `ids`.
   *
   * Rendered inside the family group that owns it rather than once at the
   * bottom of the popover, so the controls appear next to the thing they
   * belong to instead of two sections away.
   */
  const editor = (ids: readonly string[]): HTMLElement =>
    h("div", { class: "study-params" }, () => {
      const id = editing();
      if (id === null || !ids.includes(id)) return h("div", { class: "study-params-off" });
      const cur = paramsOf(id);
      const defs = paramDefs(id);
      const standard = isDefault(id, cur);
      return h(
        "div",
        { class: "study-params-body" },
        h(
          "div",
          { class: "detect-row" },
          h("span", { class: "detect-title", text: labelOf(id) }),
          h("button", {
            class: "detect-mini",
            type: "button",
            text: "Reset",
            title: "Back to the published definition",
            disabled: standard,
            onclick: () => resetParams(id),
          }),
          h("button", {
            class: "detect-mini",
            type: "button",
            text: "Done",
            onclick: () => editing.set(null),
          }),
        ),
        ...defs.map((d) =>
          h(
            "label",
            { class: "study-param", title: d.hint ?? "" },
            h("span", { class: "study-param-label", text: d.label }),
            h("input", {
              class: "study-param-input num",
              type: "number",
              min: String(d.min),
              max: String(d.max),
              step: String(d.step),
              value: String(cur[d.id] ?? d.def),
              "data-tuned": String((cur[d.id] ?? d.def) !== d.def),
              /* `onchange`, not `oninput`: a period is retyped digit by digit,
                 and recomputing the indicator on every keystroke would run it
                 for "1", "14" and "142" on the way to 142. */
              onchange: (e: Event) =>
                writeParam(id, d.id, (e.target as HTMLInputElement).value),
            }),
          ),
        ),
        h("p", {
          class: "detect-fine",
          text: standard
            ? "Published settings."
            : `Tuned. The published definition is ${defs.map((d) => d.def).join(", ")}.`,
        }),
      );
    }) as HTMLElement;

  const isOn = (id: string): boolean => opts.studies().includes(id);

  const toggle = (id: string): void =>
    opts.studies.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );

  const families = ["trend", "range", "volume", "exit"] as const;

  const group = (family: StudyMeta["family"]): HTMLElement =>
    h(
      "div",
      { class: "study-group" },
      h("p", { class: "detect-seg-label", text: FAMILY_LABEL[family] }),
      h(
        "div",
        { class: "detect-grid" },
        ...STUDIES.filter((st) => st.family === family).map((st) =>
          h(
            "div",
            { class: "study-item" },
            h(
              "button",
              {
                class: "det-toggle",
                type: "button",
                title: st.blurb,
                "aria-pressed": () => String(isOn(st.id)),
                onclick: () => toggle(st.id),
              },
              h("span", { class: "det-toggle-label", text: st.label }),
            ),
            ...gear(st.id),
          ),
        ),
      ),
      editor(STUDIES.filter((st) => st.family === family).map((st) => st.id)),
    );

  const paneOn = (id: string): boolean => opts.panes().includes(id);

  const togglePane = (id: string): void =>
    opts.panes.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );

  const paneFamilies = ["momentum", "trend", "volatility", "volume"] as const;

  const paneGroup = (family: PaneMeta["family"]): HTMLElement =>
    h(
      "div",
      { class: "study-group" },
      h("p", { class: "detect-seg-label", text: PANE_FAMILY_LABEL[family] }),
      h(
        "div",
        { class: "detect-grid" },
        ...PANES.filter((pn) => pn.family === family).map((pn) =>
          h(
            "div",
            { class: "study-item" },
            h(
              "button",
              {
                class: "det-toggle",
                type: "button",
                title: pn.blurb,
                "aria-pressed": () => String(paneOn(pn.id)),
                onclick: () => togglePane(pn.id),
              },
              h("span", { class: "det-toggle-label", text: pn.label }),
            ),
            ...gear(pn.id),
          ),
        ),
      ),
      editor(PANES.filter((pn) => pn.family === family).map((pn) => pn.id)),
    );

  return h(
    "div",
    { class: "detect-pop study-pop" },

    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Studies" }),
      /**
       * How many indicators are off their published settings, on the face of
       * the panel. This is the whole of what the old no-spinners rule was
       * protecting: not that you cannot tune, but that you cannot tune and
       * forget. Hidden when nothing is tuned, so it is a signal rather than
       * furniture.
       */
      h("button", {
        class: "detect-mini study-tuned",
        type: "button",
        hidden: () => tunedCount(opts.params()) === 0,
        text: () => `${tunedCount(opts.params())} tuned`,
        title: "Put every indicator back on its published definition",
        onclick: () => {
          opts.params.set({});
          editing.set(null);
        },
      }),
      h("button", {
        class: "detect-mini",
        type: "button",
        text: "None",
        onclick: () => opts.studies.set([]),
      }),
    ),

    ...families.map(group),

    h("div", {
      class: "detect-note",
      text: () =>
        studySummary(opts.studies(), opts.anchor() !== null, opts.profile() !== null),
    }),

    h("div", { class: "detect-sep" }),

    /**
     * The pane stack.
     *
     * In the same popover as the studies because the operator's question is
     * one question — "what else do I want to see?" — and splitting it across
     * two toolbar buttons would make them hunt for RSI in the wrong one. What
     * separates the two lists is stated in the heading rather than assumed.
     */
    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Below the chart" }),
      h("button", {
        class: "detect-mini",
        type: "button",
        text: "None",
        onclick: () => opts.panes.set([]),
      }),
    ),

    ...paneFamilies.map(paneGroup),

    h("div", {
      class: "detect-note",
      text: () => paneSummary(opts.panes(), opts.profile() !== null, opts.panesDropped()),
    }),

    h("div", { class: "detect-sep" }),

    /**
     * The anchor.
     *
     * Two offered origins and no free-form bar picker, deliberately. "The last
     * swing" and "the newest bar" are the two anchors that answer a question —
     * what has everyone paid since the structure turned, and what has everyone
     * paid since now. A click-any-bar picker mostly produces anchors chosen
     * because the resulting line looked persuasive.
     */
    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "VWAP anchor" }),
    ),
    h("p", {
      class: "detect-fine",
      text: () => {
        const label = opts.anchorLabel();
        return label === "" ? "Not anchored — anchored VWAP draws nothing." : `Anchored at ${label}.`;
      },
    }),
    h(
      "div",
      { class: "detect-grid" },
      h("button", {
        class: "det-toggle",
        type: "button",
        text: "Last swing",
        title: "Hang the anchored VWAP from the most recent swing the detectors found",
        disabled: () => opts.swingTime() === null,
        onclick: () => {
          const t = opts.swingTime();
          if (t !== null) opts.anchor.set(t);
        },
      }),
      h("button", {
        class: "det-toggle",
        type: "button",
        text: "Newest bar",
        disabled: () => opts.newestBarTime() === null,
        onclick: () => {
          const t = opts.newestBarTime();
          if (t !== null) opts.anchor.set(t);
        },
      }),
      h("button", {
        class: "det-toggle",
        type: "button",
        text: "Clear",
        disabled: () => opts.anchor() === null,
        onclick: () => opts.anchor.set(null),
      }),
    ),

    h("div", { class: "detect-sep" }),

    /**
     * The profile readout.
     *
     * The three numbers are printed as well as drawn because a level you can
     * read is a level you can put in an order ticket, and a line on a chart is
     * not. The basis line under them is not optional: a profile built from bar
     * ranges and one built from trade prints look identical on screen and
     * deserve different amounts of trust.
     */
    h(
      "div",
      { class: "detect-row" },
      h("span", { class: "detect-title", text: "Volume profile" }),
    ),
    h("div", { class: "study-profile" }, () => {
      const p = opts.profile();
      if (p === null) {
        return h("p", {
          class: "detect-fine",
          text: "No volume in the loaded range — nothing to build a profile from.",
        });
      }
      const row = (label: string, v: number): HTMLElement =>
        h(
          "div",
          { class: "study-prof-row" },
          h("span", { class: "study-prof-label", text: label }),
          h("span", { class: "study-prof-val num", text: opts.price(v) }),
        );
      return h(
        "div",
        {},
        row("Value area high", p.vah),
        row("Point of control", p.poc),
        row("Value area low", p.val),
        h("p", { class: "detect-fine", text: p.basis }),
      );
    }),
  ) as HTMLElement;
}
