/**
 * THE COMMAND BAR — one row that answers "what am I looking at?".
 *
 * v45 had two horizontal navigations: an application row up here and a desk
 * tab strip below the chart controls. Two of them is a question the user has
 * to answer every time ("which of these do I use?"), and worse, it put the
 * desk switcher BELOW the controls belonging to the selected desk — so the
 * chart controls read as belonging to the application row above them.
 *
 * Merged, the reading order matches the containment: this row picks WHAT you
 * are looking at, the row below holds the controls FOR THAT, and the second
 * row disappears entirely on desks it does not apply to instead of sitting
 * there offering a symbol box that changes nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A GOOD SECTION TO HAVE ON ITS OWN
 *
 * It is a single `h(...)` expression that produces ONE element and reads no
 * state of its own — every value in it is either foundation or one of five
 * things built elsewhere in the shell. Nothing else in the file calls into it.
 * A section whose entire contract is "give me these five, get a `<div>`" is
 * one that can be read, and changed, without the six thousand lines around it.
 *
 * WHY THE FIVE SIBLINGS ARE TYPED BY DERIVATION AND NOT BY HAND
 *
 * `palette` is `ReturnType<typeof createPaletteSection>["palette"]`, not a
 * hand-written `{ toggle(q: string): void }`. Twice now a hand-written stub of
 * a dependency has type-checked at the call site and then disagreed with the
 * real thing — a `studies` signature that was actually a computed record, a
 * fundamentals store narrowed to `{ find() }`. A derived type cannot drift,
 * because there is only one definition and this is a reference to it.
 */

import { createDeskBar } from "../deskbar";
import { clear, h } from "../dom";
import { renderEffect, signal } from "../../core/signal";
import { DEFAULT_THEME, appearanceOf, nextAppearance } from "../systemtheme";
import { icon } from "../icons";
import { VIEWS, WORKSPACE_LEAD } from "./views";
import { createToolsButton } from "./toolsmenu";
import { createStatusStrip } from "./statusstrip";
import { createViewButton } from "./viewmenu";
import type { createBrokerModel } from "../model/broker";
import type { createSettings } from "../../settings/ui";
import type { createPaletteSection } from "./palette";
import type { Signal } from "../../core/signal";
import type { LazyDesk, ShellContext } from "./context";

export interface CommandBarDeps {
  /** The IRAM menu button and its dropdown, built by the chrome section. */
  readonly appMenu: HTMLElement;
  /** Opens the analyst with an optional pre-filled question. */
  readonly askAgent: (question?: string) => void;
  /**
   * The right dock's open state.
   *
   * A `Signal`, not a setter pair: the button calls `.update(v => !v)`, which
   * is one atomic read-modify-write. Handing it `dockOpen()` and a setter
   * separately is how a toggle comes to disagree with what it toggles.
   */
  readonly dockToggle: Signal<boolean>;
  /** The settings desk, built on first open. */
  readonly settings: LazyDesk<ReturnType<typeof createSettings>>;
  /** The palette, for the omnibox button. Derived from its own section. */
  readonly palette: ReturnType<typeof createPaletteSection>["palette"];
  /** The broker link, for the status strip's risk and MT5 readings. */
  readonly broker: ReturnType<typeof createBrokerModel>;
  /** Opens the chart with the inspector on one card — for "All tools". */
  readonly revealCard: (id: string) => void;
}

/** Build the command bar. Returns the row; keeps nothing. */
export function createCommandBar(ctx: ShellContext, d: CommandBarDeps) {
  const { account, commands, keymap, state } = ctx;
  const { appMenu, askAgent, dockToggle, settings, palette, broker, revealCard } = d;

  /**
   * The dark theme to come back to.
   *
   * NOT PERSISTED, deliberately: the stored `theme` already IS the persisted
   * answer, and a second stored copy would be a second owner for one fact. This
   * only has to survive between two presses of one button in one session.
   */
  const lastDark = signal<string>(DEFAULT_THEME);

  /**
   * ONE bar. Brand, menus, desks, utilities.
   *
   * v45 had two: an application row here and a desk tab strip below the chart
   * controls. Two horizontal navigations is a question the user has to answer
   * every time ("which of these two do I use?"), and worse, it put the desk
   * switcher BELOW the controls that belong to the selected desk — so the chart
   * controls read as belonging to the application row above them.
   *
   * Merged, the reading order finally matches the containment: this row picks
   * WHAT YOU ARE LOOKING AT, the row below it holds the controls FOR THAT, and
   * the second row disappears entirely on desks it does not apply to instead of
   * sitting there offering a symbol box that changes nothing.
   *
   * The desk group spills into a "More" menu when the row is narrow — see
   * ui/deskbar.ts. Nothing is ever clipped and the selected desk never hides.
   */
  const commandbar = h(
    "div",
    { class: "commandbar" },
    appMenu,

    h("div", { class: "bar-rule", "aria-hidden": "true" }),

    createDeskBar({
      desks: VIEWS.map((v) => ({
        id: v.id,
        label: v.label,
        icon: v.icon,
        hint: v.hint,
        ...("group" in v ? { group: (v as { group: string }).group } : {}),
      })),
      current: () => state.view(),
      onSelect: (id) => state.view.set(id),
      ctx: { commands, keymap },
      commandFor: (id) => `view.${id}`,
      leads: WORKSPACE_LEAD,
    }),

    /**
     * Every tool, and the view. The workspaces are the path through a trade;
     * "All tools" is the index of everything the backend can do, including
     * the services with no screen yet. See `toolsmenu.ts`, `viewmenu.ts`.
     */
    createToolsButton(ctx, { settings, revealCard }),
    createViewButton(ctx, { dockToggle }),

    h("div", { class: "bar-spacer" }),

    /**
     * The palette, out of hiding.
     *
     * It was a 27px magnifier that advertised nothing, and it is the fastest
     * route to every command, symbol and structure in the terminal. A field
     * that shows its own shortcut is the difference between a feature power
     * users find and one they are told about.
     *
     * Still a BUTTON, not a real input: the palette owns its own focus and
     * result list in an overlay, and two competing text fields would be two
     * places to type the same query.
     */
    h(
      "button",
      {
        class: "omnibox",
        type: "button",
        "aria-label": "Search symbols, commands and structures",
        onclick: () => palette.toggle(""),
      },
      h("span", { class: "omnibox-icon", ref: (el: HTMLElement) => el.appendChild(icon("search")) }),
      h("span", { class: "omnibox-text", text: "Search symbols, commands…" }),
      h("span", {
        class: "omnibox-key",
        text: () => keymap.keysFor("palette.open") ?? "Ctrl K",
      }),
    ),

    /** What the terminal is doing when you are not looking - `statusstrip.ts`. */
    createStatusStrip(ctx, { broker, settings }),

    /**
     * The account chip.
     *
     * Equity and open risk were previously only visible on the Risk desk, which
     * meant the number every position size depends on was invisible from the
     * chart you size trades on. One source now, so this cannot disagree with
     * the desk — see `core/account.ts`.
     */
    h(
      "button",
      {
        class: "acct-chip",
        type: "button",
        title: () => {
          const src = account.source();
          return src.kind === "broker"
            ? `Live from MT5 account ${src.login} on ${src.server}, read ${Math.max(0, Math.round((Date.now() - src.at) / 1000))}s ago. Click for the Risk desk.`
            : "Equity and risk per trade, as you entered them — no broker is connected. Click for the Risk desk.";
        },
        onclick: () => state.view.set("risk"),
      },
      /**
       * WHERE THE NUMBER CAME FROM, ON THE NUMBER.
       *
       * `effective`, not `account`: this is the equity every lot size is
       * computed from, and when a broker is connected that is the broker's
       * figure rather than the one typed in. The two are indistinguishable on
       * screen unless the screen says which — and an equity of 11,482.60 that
       * might be live or might be six weeks old is not a number anyone can
       * size a trade on.
       *
       * The marker appears ONLY when it is live. A permanent "manual" badge on
       * a terminal nobody has connected a broker to is a badge that is always
       * there, which is a badge nobody reads.
       */
      h("span", {
        class: "acct-live",
        "data-on": () => (account.source().kind === "broker" ? "1" : "0"),
        text: "LIVE",
        "aria-hidden": "true",
      }),
      h("span", {
        class: "acct-equity num",
        text: () =>
          `${account.effective().equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      }),
      h("span", { class: "acct-ccy", text: () => account.effective().currency }),
      h("span", { class: "acct-risk num", text: () => `${account.effective().riskPct}%` }),
    ),
    h("button", {
      class: "icon-btn",
      title: "Ask the analyst (A)",
      "aria-label": "Ask the analyst",
      ref: (el: HTMLButtonElement) => el.appendChild(icon("analyst")),
      onclick: () => askAgent(),
    }),

    /**
     * Appearance, behind one button.
     *
     * These were two native <select>s sitting in the row, and between them they
     * took 200px — more than the brand and every icon button combined — to
     * expose two settings that are changed once and then left alone for months.
     * Worse, a select is a FORM control: two of them in a toolbar make the
     * application chrome read like a settings page.
     *
     * The options are unchanged and still live in View > Theme and
     * View > Density as well. Nothing became less reachable; 168px went back to
     * the desk switcher, which is used constantly.
     */
    /**
     * The gear opens SETTINGS now.
     *
     * It used to open a two-item menu of theme and density — the only two
     * preferences that had a home in the chrome, which is exactly why everyone
     * assumed there was nothing else to configure. Both are still there, in
     * Appearance, alongside the twenty-odd settings that previously had no
     * address at all.
     */
    /**
     * LIGHT / DARK / FOLLOW THE SYSTEM, in one press.
     *
     * THERE WAS NO SUCH CONTROL. The gear beside this one used to open a
     * two-item theme and density menu and was changed to open Settings — and
     * the icon stayed a SUN, a filled dot with eight rays, which is the
     * universal brightness glyph. So the one button that looked like a
     * light/dark toggle opened a settings dialog, and the theme itself was three
     * levels down behind an eight-option select. The owner reported exactly
     * that: "the light and dark mode toggle doesn't work."
     *
     * THREE STATES, because `auto` is the default for a fresh install and is
     * otherwise only reachable by opening Settings — a two-way toggle would
     * throw it away on the first press with no way back.
     *
     * IT REMEMBERS THE DARK THEME. Six of the seven are dark, so an operator on
     * `tradingview` who pressed this twice would be moved silently to `iram`.
     */
    h("button", {
      class: "icon-btn",
      title: () => {
        const a = appearanceOf(state.theme());
        const nxt = nextAppearance(state.theme(), lastDark.peek());
        return a === "auto"
          ? "Appearance: following your system — click for light"
          : a === "light"
            ? "Appearance: light — click for dark"
            : `Appearance: dark (${state.theme()}) — click to follow your system` +
              (nxt.appearance === "auto" ? "" : "");
      },
      "aria-label": () => `Appearance, currently ${appearanceOf(state.theme())}`,
      ref: (el: HTMLButtonElement) =>
        renderEffect(() => {
          /* The glyph IS the state. A single fixed icon would leave "which of
             the three am I on" answerable only from the tooltip. */
          clear(el);
          const a = appearanceOf(state.theme());
          el.appendChild(icon(a === "auto" ? "autoTheme" : a === "light" ? "sun" : "moon"));
        }),
      onclick: () => {
        const cur = state.theme();
        if (appearanceOf(cur) === "dark" && cur !== "auto") lastDark.set(cur);
        state.theme.set(nextAppearance(cur, lastDark.peek()) .theme as typeof cur);
      },
    }),

    h("button", {
      class: "icon-btn",
      title: () => `Settings (${keymap.keysFor("app.settings") ?? "Ctrl+,"})`,
      "aria-label": "Settings",
      ref: (el: HTMLButtonElement) => el.appendChild(icon("settings")),
      onclick: () => settings().open(),
    }),

    h("button", {
      class: "icon-btn bar-dock",
      title: "Toggle right dock (B)",
      "aria-label": "Toggle the inspector dock",
      ref: (el: HTMLButtonElement) => el.appendChild(icon("dock")),
      onclick: () => dockToggle.update((v) => !v),
    }),
    h("button", {
      class: "icon-btn bar-focus",
      title: "Focus mode (F)",
      "aria-label": "Focus mode",
      ref: (el: HTMLButtonElement) => el.appendChild(icon("focus")),
      onclick: () => state.focus.update((f) => (f === "off" ? "on" : f === "on" ? "full" : "off")),
    }),
  );

  /**
   * THE RAIL AND THE TAB STRIP ARE BOTH GONE.
   *
   * v45 removed the icon rail because it listed exactly the same ten
   * destinations as the tab strip below it. v46 finished the job: the tab strip
   * itself has moved INTO the command bar, so the shell now has one navigation
   * rather than two-and-a-half, and the chrome is one row shorter — 40px back
   * to the chart, on top of the 56px the rail gave up.
   */

  return { commandbar };
}
