/**
 * "All tools" — every function the terminal has, grouped by what it is for.
 *
 * The workspaces are the way through a trade; this is the index. It exists
 * because the backend runs far more than the tabs show — whale watch, the
 * risk governor, the claims ledger, eleven background loops — and a
 * capability with no address is one the operator never learns about.
 *
 * A tool whose SERVICE runs but whose screen is not built yet is listed and
 * disabled, with the reason, rather than left out: leaving it out hides that
 * it exists, and linking it to something else would be a menu that lies.
 */

import { openMenu, type MenuItem } from "../menu";
import { h } from "../dom";
import { icon } from "../icons";
import type { ShellContext } from "./context";
import type { createSettings } from "../../settings/ui";
import type { LazyDesk } from "./context";
import { VIEWS } from "./views";

/**
 * A tool: a desk to open, an inspector CARD to open (v59.2 — the chart and
 * the inspector, scrolled to that card), a setting, or a service with no
 * screen yet.
 */
export type Tool =
  | { readonly label: string; readonly view: string; readonly note?: string }
  | { readonly label: string; readonly card: string; readonly note?: string }
  | { readonly label: string; readonly settings: true; readonly note?: string }
  | { readonly label: string; readonly pending: string };

/**
 * ONE TAXONOMY, ONE OWNER.
 *
 * This list used to name its own five groups — Markets, Flow and on-chain,
 * Trading, Research and ML, Review and system — while `VIEWS` named five
 * different ones for the same desks. MEASURED before this change:
 * **0 of 24 view-backed desks were filed in the same group by both.** Signals
 * was under Strategy on the desk bar and under Trading here; Workspace was
 * under Chart there and Review and system here; Sessions was Chart and
 * Markets. The labels drifted too — "Data" on the bar, "Data library" here.
 *
 * So a desk lived in one place if you reached for the desk bar and another if
 * you reached for this menu, and nothing could tell you which. That is not a
 * menu that needs better names, it is two answers to one question.
 *
 * `VIEWS` owns the group and the label; this file owns only the short note
 * that belongs in a MENU, because the desk bar's `hint` is a tooltip sentence
 * and a menu row wants four words. The menu is now a projection of `VIEWS`
 * plus the tools that are not desks at all.
 */

/** The menu-length note for a desk. Absent is fine: the label stands alone. */
/** Exported so a test can assert every desk has one — see `menurow.test.ts`. */
export const MENU_NOTES: Readonly<Record<string, string>> = {
  watchlist: "your list, and the heatmap",
  screener: "scan for setups",
  briefing: "where you stand, and what changed",
  chart: "price, structure and drawings",
  sessions: "what is open, and when this moves",
  flow: "liquidations, open interest, funding",
  smart: "structure, gaps, order blocks",
  decision: "every source, weighed",
  risk: "sizing, the book, exposure",
  calculator: "lots, pips, margin",
  paper: "practice fills on the live feed",
  agent: "ask about what is on screen",
  workspace: "layouts, panes, linked symbols",
  study: "measure one thing against another",
  quant: "volatility, causality, forecasts",
  knowledge: "what replaying history measured",
  survey: "which style suits which market",
  connections: "what moves with what",
  data: "series you hold, and download",
  strategy: "sweep, walk-forward, overfitting",
  playbook: "rule sets you can read and test",
  simulation: "what it studied by itself, in money",
  signals: "armed rules, and what fired",
  journal: "what you did, and your fills",
  learn: "claimed, happened, kept",
  system: "stored history, downloads, background jobs",
};

/**
 * The tools that are NOT desks, filed into the SAME groups the desk bar uses.
 *
 * An inspector card opens the chart and scrolls to it, so it belongs beside
 * the chart; a capability whose service runs but whose screen is not built is
 * listed and disabled WITH the reason, because leaving it out hides that it
 * exists and linking it elsewhere would be a menu that lies.
 */
const EXTRAS: Readonly<Record<string, readonly Tool[]>> = {
  Today: [],
  Chart: [
    { label: "Chart read", card: "read", note: "what the AI sees on screen" },
    { label: "Key levels", card: "levels", note: "the lines that matter" },
    { label: "Can I trade now?", card: "gov", note: "the risk governor's answer" },
    { label: "Price alerts", card: "alerts", note: "watched on the server" },
    { label: "Whale watch", card: "whale", note: "large on-chain flows" },
    { label: "Smart-money wallets", card: "dbwallets", note: "the scored list, and who alerts" },
    { label: "New token pairs", card: "newpairs", note: "what the scanner saw listed" },
  ],
  Research: [],
  Strategy: [],
  Review: [{ label: "Settings", settings: true, note: "appearance, trading rules, connections" }],
};

/** The desk-bar groups, in the desk bar's own order, deduplicated. */
const GROUPS: readonly string[] = [...new Set(VIEWS.map((v) => v.group))];

export const TOOL_GROUPS: readonly { readonly group: string; readonly tools: readonly Tool[] }[] =
  GROUPS.map((group) => ({
    group,
    tools: [
      ...VIEWS.filter((v) => v.group === group).map((v): Tool => {
        const note = MENU_NOTES[v.id];
        return note === undefined ? { label: v.label, view: v.id } : { label: v.label, view: v.id, note };
      }),
      ...(EXTRAS[group] ?? []),
    ],
  }));

export interface ToolsMenuDeps {
  readonly settings: LazyDesk<ReturnType<typeof createSettings>>;
  /** Opens the chart with the inspector on one card. Read at click time. */
  readonly revealCard: (id: string) => void;
}

export function createToolsButton(ctx: ShellContext, d: ToolsMenuDeps): HTMLElement {
  const { state, commands, keymap } = ctx;
  let open: { close: () => void } | null = null;
  const items = (): MenuItem[] =>
    TOOL_GROUPS.map(({ group, tools }) => ({
      label: group,
      items: tools.map((t): MenuItem => {
        /*
         * THE HINT SAYS WHERE IT GOES, on every row.
         *
         * Only inspector cards carried one before, so two thirds of a
         * twenty-eight item menu gave no clue whether a click would change the
         * desk, open a panel over the chart, or launch a dialog. Three
         * different outcomes behind one uniform row is a menu you learn by
         * trial.
         */
        if ("view" in t) {
          return {
            id: `view.${t.view}`,
            label: t.label,
            note: t.note ?? "desk",
            checked: state.view() === t.view,
            run: () => state.view.set(t.view),
          };
        }
        if ("card" in t) {
          return { label: t.label, note: t.note ?? "inspector", run: () => d.revealCard(t.card) };
        }
        if ("settings" in t) {
          return { id: "app.settings", label: t.label, note: t.note ?? "settings", run: () => d.settings().open() };
        }
        return { label: t.label, note: "no screen yet", disabled: true };
      }),
    }));
  const btn = h(
    "button",
    {
      class: "tools-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Every tool in the terminal, grouped",
      onclick: (e: Event) => {
        e.preventDefault();
        if (open) {
          open.close();
          open = null;
          return;
        }
        open = openMenu(items(), { anchor: btn, placement: "bottom-start", ctx: { commands, keymap }, onClose: () => { open = null; btn.setAttribute("aria-expanded", "false"); } });
        btn.setAttribute("aria-expanded", "true");
      },
    },
    h("span", { text: "All tools" }),
    icon("chevronDown", { size: 11 }),
  ) as HTMLButtonElement;
  return btn;
}
