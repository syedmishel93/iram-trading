/**
 * The Settings surface.
 *
 * ONE screen, twelve sections, everything that was previously homeless. It
 * renders itself from `schema.ts`, so adding a setting is adding a definition
 * and never a layout change — which is what stops this becoming the next place
 * options get scattered.
 *
 * WHY AN OVERLAY AND NOT A DESK
 * Every desk is a view of the MARKET. Settings is a view of the terminal.
 * Putting it on the desk bar would say the opposite, and would cost a slot on a
 * row that `deskbar.ts` already measured as full at 1200px. It opens over
 * whatever you were doing and gives it back when you close.
 *
 * WHY SEARCH IS THE FIRST CONTROL
 * Twelve sections is more than anyone will browse. The one question a settings
 * screen is asked is "where is that option", and the honest answer is a field
 * you type it into — so the field is focused on open and every setting carries
 * the words someone might reach for, including what the thing used to be called.
 */

import { h, clear } from "./../ui/dom";
import { openOverlay, type OverlayHandle } from "./../ui/overlay";
import { renderEffect, signal } from "../core/signal";
import {
  groupSections,
  searchSettings,
  type SectionDef,
  type SettingDef,
} from "./schema";

export interface SettingsOptions {
  readonly sections: readonly SectionDef[];
  readonly settings: readonly SettingDef[];
  /** Shown in the footer. */
  readonly footerNote?: () => string;
}

export interface SettingsSurface {
  open(query?: string): OverlayHandle;
  isOpen(): boolean;
  close(): void;
}

export function createSettings(opts: SettingsOptions): SettingsSurface {
  let handle: OverlayHandle | null = null;

  const active = signal<string>(opts.sections[0]?.id ?? "");
  const query = signal<string>("");

  /**
   * The live preview: a miniature of the chrome, built from role tokens only.
   *
   * NOTHING HERE IS REACTIVE, AND THAT IS THE POINT. Every value it shows is
   * a custom property — `--r-card`, `--shell-gap`, `--w-dock`, `--h-status`,
   * `--candle-up`, `--chart-wick`, `--accent` — so when a setting re-points
   * one on :root the browser restyles this the same frame it restyles the
   * terminal underneath. A version that read signals and re-rendered would be
   * a SECOND description of the chrome, free to drift from the first; this
   * one cannot be wrong without the real thing being wrong in the same way.
   *
   * The metric tokens are divided down, because a miniature is a miniature —
   * the DIVISOR is stated once here and the proportions are the real ones.
   */
  const previewCard = (def: SettingDef): HTMLElement =>
    h(
      "div",
      { class: "set-preview", role: "img", "aria-label": () => def.read() },
      h(
        "div",
        { class: "sp-shell" },
        h(
          "div",
          { class: "sp-cmd" },
          h("span", { class: "sp-mark" }),
          h("span", { class: "sp-pill", text: "Chart" }),
          h("span", { class: "sp-tab", text: "Find" }),
          h("span", { class: "sp-tab", text: "Decide" }),
        ),
        h(
          "div",
          { class: "sp-body" },
          h(
            "div",
            { class: "sp-main" },
            h(
              "div",
              { class: "sp-head" },
              h("span", { class: "sp-sym", text: "BTCUSDT" }),
              h("span", { class: "sp-price", text: "64,182" }),
              h("span", { class: "sp-chg", text: "+1.4%" }),
            ),
            h(
              "div",
              { class: "sp-plot" },
              h(
                "span",
                { class: "sp-candle", "data-dir": "up" },
                h("i", { class: "sp-wick" }),
                h("i", { class: "sp-cbody" }),
              ),
              h(
                "span",
                { class: "sp-candle", "data-dir": "down" },
                h("i", { class: "sp-wick" }),
                h("i", { class: "sp-cbody" }),
              ),
            ),
          ),
          h(
            "div",
            { class: "sp-dock" },
            h("span", { class: "sp-line" }),
            h("span", { class: "sp-line", "data-short": "true" }),
            h("span", { class: "sp-btn", text: "Review" }),
          ),
        ),
        h("div", { class: "sp-status" }),
      ),
    ) as HTMLElement;

  const control = (def: SettingDef): HTMLElement => {
    const disabledReason = def.unavailable?.() ?? null;

    if (def.control.kind === "preview") return previewCard(def);

    if (def.control.kind === "note") {
      return h("p", {
        class: "set-note",
        "data-tone": def.control.tone ?? "info",
        text: () => def.read(),
      }) as HTMLElement;
    }

    if (def.control.kind === "action") {
      const label = def.control.button;
      return h("button", {
        class: "set-action",
        type: "button",
        text: label,
        disabled: disabledReason !== null,
        title: disabledReason ?? "",
        onclick: () => def.write?.(""),
      }) as HTMLElement;
    }

    if (def.control.kind === "toggle") {
      return h("button", {
        class: "set-toggle",
        type: "button",
        role: "switch",
        "aria-checked": () => def.read(),
        "data-on": () => def.read(),
        disabled: disabledReason !== null,
        title: disabledReason ?? "",
        "aria-label": def.label,
        onclick: () => def.write?.(def.read() === "true" ? "false" : "true"),
      }) as HTMLElement;
    }

    if (def.control.kind === "colour") {
      const swatchOnly = def.control.swatchOnly === true;
      /* The swatch and the hex field are two views of one value, so each writes
         through `def.write` and both re-read from `def.read` — neither holds
         state of its own. `input` on the swatch rather than `change`, because a
         colour picker is a live preview and committing only on close would make
         it feel broken. */
      return h(
        "label",
        { class: "set-colour" },
        h("input", {
          class: "set-swatch",
          type: "color",
          "aria-label": def.label,
          disabled: disabledReason !== null,
          title: disabledReason ?? "",
          value: () => def.read(),
          oninput: (e: Event) => def.write?.((e.target as HTMLInputElement).value),
        }),
        ...(swatchOnly
          ? []
          : [
              h("input", {
                class: "set-hex",
                type: "text",
                spellcheck: "false",
                "aria-label": `${def.label} hex value`,
                disabled: disabledReason !== null,
                value: () => def.read(),
                onchange: (e: Event) => def.write?.((e.target as HTMLInputElement).value),
              }),
            ]),
      ) as HTMLElement;
    }

    if (def.control.kind === "select") {
      const options = def.control.options;
      /**
       * THE OPTIONS ARE ATTACHED BEFORE THE VALUE IS BOUND, AND THAT ORDER IS
       * THE WHOLE FIX.
       *
       * `h` applies props first and children second, so a `value: () => …`
       * prop on a `<select>` assigned `.value` while the element still had no
       * `<option>` to match — a write the DOM discards without a word, leaving
       * the control showing its FIRST entry.
       *
       * MEASURED in the running terminal: every select on this screen read
       * the head of its own list — Density said "compact" on a terminal whose
       * :root carried `data-density="standard"`, Theme said "iram" because
       * iram is first, and an accent of "violet" read as "theme". The state
       * was right and the screen was wrong, which on a preferences screen
       * means the control misreports the terminal until somebody touches it —
       * and then "changing" it to what it already said does nothing, because
       * `onchange` never fires. Same class as the `setAttribute("value")` trap
       * recorded at the top of `ui/dom.ts`, one layer along.
       */
      const select = h("select", {
        class: "set-select",
        "aria-label": def.label,
        disabled: disabledReason !== null,
        onchange: (e: Event) => def.write?.((e.target as HTMLSelectElement).value),
      }) as HTMLSelectElement;
      for (const o of options) select.appendChild(h("option", { value: o.value, text: o.label }));
      renderEffect(() => {
        const value = def.read();
        if (select.value !== value) select.value = value;
      });
      return select;
    }

    const numeric = def.control.kind === "number";
    return h(
      "label",
      { class: "set-input" },
      h("input", {
        type: numeric ? "number" : "text",
        spellcheck: "false",
        "aria-label": def.label,
        disabled: disabledReason !== null,
        ...(numeric && def.control.kind === "number"
          ? {
              ...(def.control.min !== undefined ? { min: String(def.control.min) } : {}),
              ...(def.control.max !== undefined ? { max: String(def.control.max) } : {}),
              step: String(def.control.step ?? "any"),
            }
          : {}),
        ...(def.control.kind === "text" && def.control.placeholder
          ? { placeholder: def.control.placeholder }
          : {}),
        value: () => def.read(),
        /* `change`, not `input`: a half-typed number is not a value anyone
           wants committed, and equity re-sizes every open position. */
        onchange: (e: Event) => def.write?.((e.target as HTMLInputElement).value),
      }),
      ...(numeric && def.control.kind === "number" && def.control.unit
        ? [h("span", { class: "set-unit", text: def.control.unit })]
        : []),
    ) as HTMLElement;
  };

  const row = (def: SettingDef): HTMLElement => {
    const reason = def.unavailable?.() ?? null;
    const isNote = def.control.kind === "note";
    /* A preview has no label column to align against either, so it spans the
       row — but it is not a statement, and giving it `data-note` would have
       styled it as one. Two attributes, two meanings. */
    const spans = isNote || def.control.kind === "preview";
    return h(
      "div",
      {
        class: "set-row",
        "data-note": String(isNote),
        "data-span": String(spans),
        "data-off": String(reason !== null),
      },
      h(
        "div",
        { class: "set-label" },
        h("div", { class: "set-name", text: def.label }),
        ...(def.hint ? [h("div", { class: "set-hint", text: def.hint })] : []),
        /* Unavailable is EXPLAINED, never merely greyed. A control you cannot
           use and cannot find out why is one you assume is broken. */
        ...(reason ? [h("div", { class: "set-why", text: reason })] : []),
      ),
      h("div", { class: "set-control" }, control(def)),
    ) as HTMLElement;
  };

  const nav = h("nav", { class: "set-nav", "aria-label": "Settings sections" }) as HTMLElement;
  const main = h("main", { class: "set-main" }) as HTMLElement;

  const search = h("input", {
    class: "set-search",
    type: "search",
    placeholder: "Search settings…",
    spellcheck: "false",
    "aria-label": "Search settings",
    value: () => query(),
    oninput: (e: Event) => query.set((e.target as HTMLInputElement).value),
  }) as HTMLInputElement;

  const panel = h(
    "div",
    { class: "settings", role: "dialog", "aria-label": "Settings" },
    h(
      "header",
      { class: "set-head" },
      h("h2", { class: "set-title", text: "Settings" }),
      h("span", { class: "set-key", text: "Ctrl ," }),
      search,
      h("button", {
        class: "set-close",
        type: "button",
        text: "✕",
        "aria-label": "Close settings",
        onclick: () => handle?.close(),
      }),
    ),
    h("div", { class: "set-body" }, nav, main),
    h(
      "footer",
      { class: "set-foot" },
      h("span", { class: "set-foot-note", text: () => opts.footerNote?.() ?? "" }),
    ),
  ) as HTMLElement;

  // ------------------------------------------------------------- render ---

  renderEffect(() => {
    clear(nav);
    const searching = query().trim() !== "";
    for (const group of groupSections(opts.sections, opts.settings)) {
      nav.appendChild(h("div", { class: "set-group", text: group.group }));
      for (const entry of group.sections) {
        nav.appendChild(
          h("button", {
            class: "set-navitem",
            type: "button",
            text: entry.section.label,
            "data-on": String(!searching && active() === entry.section.id),
            onclick: () => {
              query.set("");
              active.set(entry.section.id);
            },
          }),
        );
      }
    }
  });

  renderEffect(() => {
    clear(main);
    const q = query().trim();

    if (q !== "") {
      const hits = searchSettings(opts.settings, opts.sections, q);
      const byId = new Map(opts.sections.map((s) => [s.id, s]));
      main.appendChild(
        h("div", {
          class: "set-sectionhead",
          text: hits.length === 0 ? `Nothing matches “${q}”` : `${hits.length} setting${hits.length === 1 ? "" : "s"} match “${q}”`,
        }),
      );
      if (hits.length === 0) {
        main.appendChild(
          h("p", {
            class: "set-empty",
            text: "Try the name you knew it by before — settings carry their old names as well.",
          }),
        );
        return;
      }
      for (const hit of hits) {
        const r = row(hit.setting);
        /* Where it lives, so a search result also teaches the map. */
        r.prepend(
          h("span", {
            class: "set-crumb",
            text: byId.get(hit.setting.section)?.label ?? hit.setting.section,
          }),
        );
        main.appendChild(r);
      }
      return;
    }

    const section = opts.sections.find((s) => s.id === active());
    if (!section) return;
    main.appendChild(h("h3", { class: "set-sectiontitle", text: section.label }));
    if (section.blurb) main.appendChild(h("p", { class: "set-blurb", text: section.blurb }));
    for (const def of opts.settings.filter((s) => s.section === section.id)) {
      main.appendChild(row(def));
    }
  });

  return {
    open(initial) {
      if (handle?.isOpen()) return handle;
      query.set(initial ?? "");
      handle = openOverlay(panel, {
        placement: "center",
        scrim: true,
        closeOnOutside: true,
        className: "settings-overlay",
        onClose: () => {
          handle = null;
        },
      });
      /* Focus the field, not the first control: the question this screen is
         asked is "where is that option". */
      queueMicrotask(() => search.focus());
      return handle;
    },
    isOpen: () => handle?.isOpen() ?? false,
    close: () => handle?.close(),
  };
}
