/**
 * The multi-pane workspace: the layout tree, pane linking, and the desk showing it.
 *
 * ZERO SIBLING DEPENDENCIES — the point worth recording. Measured, this section
 * reads exactly five things from outside itself: `state`, `commands`, `keymap`,
 * `feed` and `kv`. All five are foundation, and two of them (`commands`, `keymap`)
 * only became foundation because this measurement showed how many sections want
 * them. So this borrows nothing from a sibling at all.
 *
 * A section with no siblings can be read on its own, which is the objective of
 * the whole exercise. The 140 lines below are unchanged; only the address is.
 *
 * THE RETURN TYPE IS INFERRED, ON PURPOSE. The first draft hand-wrote it and got
 * it wrong — `studies` in the risk section turned out to be a computed indicator
 * read, not the `string[]` it was declared as. An inferred type cannot disagree
 * with the code it describes.
 */

import { effect, signal, type Signal } from "../../core/signal";
import { LINK_GROUPS, applyLink, closePane, findPane, paneCount, panes as listPanes, preset, sanitizeLayout, setRatio, splitPane, type LayoutNode, type LinkGroup, updatePane } from "../../core/workspace";
import { seriesKey } from "../../store/barstore";
import { openContextMenu } from "../menu";
import { createWorkspace } from "../workspace";
import { TIMEFRAMES } from "./views";
import type { ShellContext } from "./context";

export function createWorkspaceSection(ctx: ShellContext) {
  const { state, commands, keymap, feed, kv } = ctx;


  /**
   * The multi-pane workspace.
   *
   * ADDITIVE, and deliberately so. The single Chart view above is untouched:
   * replay, the legend, the desks and the alert engine all still run off its
   * one feed. The workspace is a SECOND view whose panes each own their feed
   * and their canvas, sharing one archive and one request governor.
   *
   * That boundary is the honest one to draw today. Routing replay and every
   * desk through "whichever pane has focus" is a real refactor of the shell's
   * data flow, and doing it badly would put a look-ahead firewall and an alert
   * engine at risk to add a second chart. So: four live charts that link to
   * each other, and the desks keep reading the chart you were already reading.
   */
  /** Named layouts, with their pane counts for the palette's detail column. */
  const WORKSPACE_PRESETS = [
    { id: "single", label: "Single", panes: 1 },
    { id: "duo", label: "Two side by side", panes: 2 },
    { id: "duo-stacked", label: "Two stacked", panes: 2 },
    { id: "triple", label: "One tall, two stacked", panes: 3 },
    { id: "quad", label: "Four up", panes: 4 },
    { id: "focus-trio", label: "One large, three below", panes: 4 },
  ] as const;

  const LAYOUT_SLOT = {
    key: "workspace.layout",
    version: 1,
    fallback: (): unknown => null,
    validate: (v: unknown): unknown => v,
  };

  const storedLayout = sanitizeLayout(kv.read(LAYOUT_SLOT).value);
  const layout = signal<LayoutNode>(
    storedLayout ??
      preset("triple", { symbol: state.symbol.peek(), timeframe: state.timeframe.peek() }),
  );
  const activePaneId = signal<string>((listPanes(layout.peek())[0] as { id: string }).id);

  effect(() => void kv.write(LAYOUT_SLOT, layout()));

  /* An active id that no longer names a pane leaves the pane controls driving
     nothing, so closing the focused pane re-points focus rather than orphaning
     it. */
  effect(() => {
    const list = listPanes(layout());
    if (list.some((pp) => pp.id === activePaneId.peek())) return;
    const first = list[0];
    if (first) activePaneId.set(first.id);
  });

  const setLayout = (next: LayoutNode): void => layout.set(next);

  const cyclePaneLink = (id: string): void => {
    const pane = findPane(layout.peek(), id);
    if (!pane) return;
    const at = LINK_GROUPS.indexOf(pane.link);
    const next = LINK_GROUPS[(at + 1) % LINK_GROUPS.length] as LinkGroup;
    setLayout(updatePane(layout.peek(), id, { link: next }));
  };

  const workspace = createWorkspace({
    layout,
    activePaneId,
    archive: feed.archive,
    theme: state.theme as unknown as Signal<string>,
    chartKind: state.chartKind,
    mas: state.mas,
    detectors: state.detectors,
    htf: state.htf,
    onSetRatio: (path, ratio) => setLayout(setRatio(layout.peek(), path, ratio)),
    onClosePane: (id) => setLayout(closePane(layout.peek(), id)),
    onSplitPane: (id, dir) => setLayout(splitPane(layout.peek(), id, dir)),
    onCyclePaneLink: cyclePaneLink,
    timeframes: TIMEFRAMES,
    /* Straight to `updatePane`, NOT through `applyLink`: this control exists
       precisely to move one pane and leave its neighbours alone. */
    onSetPaneTimeframe: (id, timeframe) =>
      setLayout(updatePane(layout.peek(), id, { timeframe })),
    onPaneContextMenu: (id, at) => {
      const pane = findPane(layout.peek(), id);
      openContextMenu(
        [
          { kind: "header", label: pane ? `${pane.symbol} · ${pane.timeframe}` : "Pane" },
          { label: "Split right", run: () => setLayout(splitPane(layout.peek(), id, "row")) },
          { label: "Split down", run: () => setLayout(splitPane(layout.peek(), id, "col")) },
          { kind: "separator" },
          {
            label: "Link channel",
            items: LINK_GROUPS.map((g) => ({
              label: g === "none" ? "Unlinked" : g,
              checked: pane?.link === g,
              run: () => setLayout(updatePane(layout.peek(), id, { link: g })),
            })),
          },
          {
            label: "Timeframe",
            items: TIMEFRAMES.map((tf) => ({
              label: tf,
              checked: pane?.timeframe === tf,
              /* Through applyLink, so every pane on the same channel follows —
                 the same path the pane header takes. */
              run: () => setLayout(applyLink(layout.peek(), id, { timeframe: tf })),
            })),
          },
          { kind: "separator" },
          {
            label: "Send this symbol to the Chart desk",
            run: () => {
              if (pane) state.symbol.set(pane.symbol);
              state.view.set("chart");
            },
          },
          {
            label: "Close pane",
            danger: true,
            /* One pane is the floor: closePane refuses, and a menu item that
               silently does nothing is worse than one that is greyed out. */
            disabled: paneCount(layout.peek()) <= 1,
            run: () => setLayout(closePane(layout.peek(), id)),
          },
        ],
        at,
        { commands, keymap },
      );
    },
  });

  /** Series on screen in the workspace, so retention cannot sweep them. */
  const workspaceSeries = (): string[] => {
    const out: string[] = [];
    for (const pane of listPanes(layout.peek())) {
      for (const source of ["binance", "proxy", "mt5", "coinbase", "bybit", "okx"]) {
        out.push(seriesKey({ source, symbol: pane.symbol, timeframe: pane.timeframe }));
      }
    }
    return out;
  };

  return { WORKSPACE_PRESETS, layout, setLayout, activePaneId, cyclePaneLink, workspace, workspaceSeries };
}
