/**
 * "View" — text size, inspector width and layout, one click from the chart.
 *
 * NOTHING HERE IS A NEW SETTING. Text size is density (Settings ▸ Appearance
 * says why: density scales the whole type ramp), the inspector width is the
 * `dock` appearance knob, and the dock's visibility is the same `dockToggle`
 * the B key flips. The menu writes those exact signals, so it cannot disagree
 * with Settings — two controls for one value is how they drift apart.
 */

import { openMenu, type MenuItem } from "../menu";
import { h } from "../dom";
import { icon } from "../icons";
import { appearance } from "../appearance";
import type { Signal } from "../../core/signal";
import type { ShellContext } from "./context";
import type { Density } from "./views";

export interface ViewMenuDeps {
  /** The inspector dock's open state — the same signal the B key flips. */
  readonly dockToggle: Signal<boolean>;
}

/** The three layouts, as the values they set. Exported so they are tested. */
export const LAYOUTS = {
  focus: { label: "Chart focus", hint: "inspector closed", dock: false, width: null },
  balanced: { label: "Balanced", hint: "inspector open", dock: true, width: "standard" },
  analysis: { label: "Analysis", hint: "wide inspector", dock: true, width: "wide" },
} as const;

export function createViewButton(ctx: ShellContext, d: ViewMenuDeps): HTMLElement {
  const { state, commands, keymap } = ctx;
  const look = appearance();
  let open: { close: () => void } | null = null;

  const items = (): MenuItem[] => [
    {
      label: "Text size",
      items: ([["compact", "Small"], ["standard", "Medium"], ["comfortable", "Large"]] as const).map(([v, l]) => ({
        label: l,
        checked: state.density() === v,
        run: () => state.density.set(v as Density),
      })),
    },
    {
      label: "Inspector width",
      items: ([["narrow", "Narrow"], ["standard", "Standard"], ["wide", "Wide"]] as const).map(([v, l]) => ({
        label: l,
        checked: look.dock() === v,
        run: () => look.dock.set(v),
      })),
    },
    { kind: "separator" },
    { kind: "header", label: "Layout" },
    ...Object.values(LAYOUTS).map((L): MenuItem => ({
      label: L.label,
      hint: L.hint,
      run: () => {
        d.dockToggle.set(L.dock);
        if (L.width) look.dock.set(L.width);
      },
    })),
    { kind: "separator" },
    /* The real command ids, so the menu shows their keys (B, F). Below 1280px
       the bar's own dock and focus icons are hidden and these are the route. */
    { id: "ui.dock", label: "Inspector", checked: d.dockToggle(), run: () => d.dockToggle.update((v) => !v) },
    /* Moved here from the panel's own head in v59.2: a layout choice made
       once, not a control that needs a row of the panel. */
    {
      label: "Inspector shows",
      items: ([["column", "All cards"], ["stack", "One card at a time"]] as const).map(([v, l]) => ({
        label: l,
        checked: state.dockMode() === v,
        run: () => state.dockMode.set(v),
      })),
    },
    { id: "ui.focus", label: "Focus mode", run: () => state.focus.update((f) => (f === "off" ? "on" : f === "on" ? "full" : "off")) },
  ];

  const btn = h(
    "button",
    {
      class: "tools-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Text size, inspector width and layout",
      onclick: (e: Event) => {
        e.preventDefault();
        if (open) {
          open.close();
          open = null;
          return;
        }
        open = openMenu(items(), { anchor: btn, placement: "bottom-end", ctx: { commands, keymap }, onClose: () => { open = null; btn.setAttribute("aria-expanded", "false"); } });
        btn.setAttribute("aria-expanded", "true");
      },
    },
    h("span", { text: "View" }),
    icon("chevronDown", { size: 11 }),
  ) as HTMLButtonElement;
  return btn;
}
