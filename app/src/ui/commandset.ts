/**
 * Everything the terminal can do, declared once.
 *
 * This file is the single source for the command palette, the menu bar and the
 * keyboard — and that is the whole reason it exists. In v40 the tab strip, the
 * topbar buttons and a `switch` on `e.key` each held their own idea of what the
 * app could do, so adding a capability meant editing three places and forgetting
 * one. Here a capability is one `Command` object; where it SHOWS UP is a
 * separate, tiny declaration below it.
 *
 * A note on the keyboard map. Single letters are bound bare, because this is a
 * terminal and you are not typing prose into it — but every one of them is
 * inert while focus is in a text field, which the keymap enforces rather than
 * each binding remembering to. The sequences ("g c" for go-to-chart) are there
 * so navigation does not have to compete with the modified chords the browser
 * and the OS have already claimed.
 */

import type { Command, CommandRegistry } from "../core/commands";
import type { Keymap } from "../core/keys";
import type { MenuBarEntry, MenuItem } from "./menu";
import type { Signal } from "../core/signal";

export interface CommandDeps {
  /** Opens the Settings surface. */
  openSettings(): void;
  readonly commands: CommandRegistry;
  readonly keymap: Keymap;

  /* --- view state */
  readonly view: Signal<string>;
  readonly theme: Signal<string>;
  readonly themes: readonly string[];
  readonly density: Signal<string>;
  readonly densities: readonly string[];
  readonly dockOpen: Signal<boolean>;
  /**
   * Open the dock and scroll the Setup card into view.
   *
   * Its own command because "where is the sniper entry card" was a real
   * question with a bad answer: it is the first panel in a dock that is shut
   * about half the time, and the only way back was a toolbar icon with no
   * label. A named, searchable command is the shortest honest route to a
   * feature that otherwise exists only if you already know where it is.
   */
  revealSetup(): void;
  /** The volume band: on/off, and its height in pixels. */
  readonly volumeOn: Signal<boolean>;
  /** Grid lines behind price. */
  readonly gridOn: Signal<boolean>;
  /** Logarithmic price scale. */
  readonly logScale: Signal<boolean>;
  /** The session-overlap wash behind price. */
  readonly sessionBands: Signal<boolean>;
  /** The news strip above the live bar. Off by default; see ui/newsbar.ts. */
  readonly newsOn: Signal<boolean>;
  /** The watchlist rail beside the chart (ui/watchrail.ts). */
  readonly railOn: Signal<boolean>;
  resetVolumeHeight(): void;
  readonly focus: Signal<"off" | "on" | "full">;

  /* --- chart state */
  readonly symbol: Signal<string>;
  readonly timeframe: Signal<string>;
  readonly timeframes: readonly string[];
  readonly chartKind: Signal<string>;
  readonly chartKinds: readonly string[];
  readonly mas: Signal<string[]>;
  readonly maSet: readonly { id: string; period: number }[];
  readonly detectors: Signal<string[]>;
  readonly detectorSet: readonly { id: string; label: string }[];
  readonly htf: Signal<string[]>;
  /**
   * Read as a function, not a snapshot: the ladder of useful higher timeframes
   * depends on the CURRENT timeframe (there is no 4h above a 1d chart), and a
   * captured array would offer stale choices after the first switch.
   */
  htfChoices(): readonly string[];

  /* --- alerts */
  readonly alertSound: Signal<boolean>;
  readonly alertDesktop: Signal<boolean>;

  /* --- workspace */
  readonly workspacePresets: readonly { id: string; label: string; panes: number }[];
  applyWorkspacePreset(id: string): void;
  splitActivePane(dir: "row" | "col"): void;
  closeActivePane(): void;
  canCloseActivePane(): boolean;
  cycleActivePaneLink(): void;
  activePaneLink(): string;

  /* --- drawing */
  readonly drawKinds: readonly { id: string; label: string; hint: string }[];
  armDrawTool(id: string | null): void;
  armedDrawTool(): string | null;
  magnet(): boolean;
  toggleMagnet(): void;
  undoDrawing(): void;
  canUndoDrawing(): boolean;
  redoDrawing(): void;
  canRedoDrawing(): boolean;
  deleteDrawing(): void;
  hasDrawingSelected(): boolean;
  clearDrawings(): void;
  drawingCount(): number;

  /* --- actions */
  goLive(): void;
  reload(): void;
  toggleReplay(): void;
  replayActive(): boolean;
  replayStep(n: number): void;
  openPalette(initial?: string): void;
  openShortcuts(): void;
  openNotifications(): void;
  exportVault(withHistory: boolean): void;
  resetNetwork(): void;
  askAgent(question?: string): void;
  copyChartSummary(): void;
  exportChartPng(): void;
  fullscreen(): void;
  readonly viewList: readonly { id: string; label: string }[];
}

const cap = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

/**
 * Build and register every command.
 *
 * Returns the disposer, so a future multi-window build can tear one window's
 * commands down without touching another's.
 */
export function registerCommands(d: CommandDeps): () => void {
  const list: Command[] = [];

  /* ------------------------------------------------------------ navigate */

  for (const v of d.viewList) {
    list.push({
      id: `view.${v.id}`,
      title: `Go to ${v.label}`,
      menuTitle: v.label,
      group: "Go",
      keywords: `open show ${v.id} desk panel tab`,
      checked: () => d.view() === v.id,
      run: () => d.view.set(v.id),
    });
  }

  /* ---------------------------------------------------------------- file */

  list.push(
    {
      id: "file.exportSettings",
      title: "Export settings vault",
      group: "File",
      keywords: "backup save download portable",
      detail: () => "credentials withheld",
      run: () => d.exportVault(false),
    },
    {
      id: "file.exportAll",
      title: "Export settings and history",
      group: "File",
      keywords: "backup save download bars archive",
      run: () => d.exportVault(true),
    },
    {
      id: "file.data",
      title: "Open the Data desk",
      group: "File",
      keywords: "storage retention sync supabase import backup",
      run: () => d.view.set("data"),
    },
  );

  /* -------------------------------------------------------------- market */

  list.push({
    id: "market.symbol",
    title: "Change symbol",
    group: "Market",
    keywords: "instrument ticker pair search",
    detail: () => d.symbol(),
    /* The palette's default mode already searches symbols, so this command
       just re-opens it there rather than growing a second search UI. */
    run: () => d.openPalette(""),
  });

  for (const tf of d.timeframes) {
    list.push({
      id: `market.tf.${tf}`,
      title: `Timeframe ${tf}`,
      menuTitle: tf,
      group: "Market",
      keywords: `interval period ${tf}`,
      checked: () => d.timeframe() === tf,
      run: () => d.timeframe.set(tf),
    });
  }

  /* --------------------------------------------------------------- chart */

  for (const kind of d.chartKinds) {
    list.push({
      id: `chart.kind.${kind}`,
      title: `Chart style: ${cap(kind)}`,
      menuTitle: cap(kind),
      group: "Chart",
      keywords: "candles bars line area style render",
      checked: () => d.chartKind() === kind,
      run: () => d.chartKind.set(kind),
    });
  }

  for (const ma of d.maSet) {
    list.push({
      id: `chart.${ma.id}`,
      title: `Toggle EMA ${ma.period}`,
      group: "Chart",
      keywords: "moving average trend overlay ema",
      checked: () => d.mas().includes(ma.id),
      run: () =>
        d.mas.update((cur) =>
          cur.includes(ma.id) ? cur.filter((x) => x !== ma.id) : [...cur, ma.id],
        ),
    });
  }

  list.push(
    {
      id: "chart.goLive",
      title: "Jump to the live edge",
      group: "Chart",
      keywords: "scroll right newest now latest",
      run: () => d.goLive(),
    },
    {
      id: "chart.reload",
      title: "Reload history",
      group: "Chart",
      keywords: "refetch refresh redownload",
      run: () => d.reload(),
    },
    {
      id: "chart.exportPng",
      title: "Export the chart as an image",
      group: "Chart",
      keywords: "png screenshot picture save share journal",
      detail: () => "symbol and time burned in",
      run: () => d.exportChartPng(),
    },
    {
      id: "chart.copySummary",
      title: "Copy chart summary to clipboard",
      group: "Chart",
      keywords: "share paste export text readout",
      run: () => d.copyChartSummary(),
    },
  );

  /* --------------------------------------------------------------- study */

  for (const det of d.detectorSet) {
    list.push({
      id: `study.${det.id}`,
      title: `Detector: ${det.label}`,
      menuTitle: det.label,
      group: "Study",
      keywords: "structure detect overlay pattern",
      checked: () => d.detectors().includes(det.id),
      run: () =>
        d.detectors.update((cur) =>
          cur.includes(det.id) ? cur.filter((x) => x !== det.id) : [...cur, det.id],
        ),
    });
  }

  /**
   * Every timeframe that is a valid projection for SOME chart timeframe gets a
   * command, gated on whether it is valid for the CURRENT one.
   *
   * Registering only today's ladder would freeze these to whatever timeframe
   * happened to be loaded at boot: switch from 1h to 15m and "Project 1d
   * structure" would still be missing, because commands are registered once and
   * the loop had already run. `when` is re-read on every palette keystroke and
   * every menu open, so the offered set follows the chart.
   */
  const ALL_HTF = ["5m", "15m", "1h", "4h", "1d", "1w"];
  for (const tf of ALL_HTF) {
    list.push({
      id: `study.htf.${tf}`,
      title: `Project ${tf} structure`,
      group: "Study",
      keywords: "higher timeframe mtf multi confluence",
      when: () => d.htfChoices().includes(tf),
      checked: () => d.htf().includes(tf),
      run: () =>
        d.htf.update((cur) => (cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf])),
    });
  }

  /* -------------------------------------------------------------- replay */

  list.push(
    {
      id: "replay.toggle",
      title: "Replay mode",
      group: "Replay",
      keywords: "step history bar by bar backtest practice",
      detail: () => "nothing downstream can see past the cursor",
      checked: () => d.replayActive(),
      run: () => d.toggleReplay(),
    },
    {
      id: "replay.forward",
      title: "Replay: forward one bar",
      group: "Replay",
      when: () => d.replayActive(),
      run: () => d.replayStep(1),
    },
    {
      id: "replay.back",
      title: "Replay: back one bar",
      group: "Replay",
      when: () => d.replayActive(),
      run: () => d.replayStep(-1),
    },
  );

  /* ----------------------------------------------------------- workspace */

  for (const p of d.workspacePresets) {
    list.push({
      id: `ws.preset.${p.id}`,
      title: `Layout: ${p.label}`,
      group: "Workspace",
      keywords: "layout split grid tile multi chart panes",
      detail: () => `${p.panes} pane${p.panes === 1 ? "" : "s"}`,
      run: () => d.applyWorkspacePreset(p.id),
    });
  }

  list.push(
    {
      id: "ws.splitRight",
      title: "Split pane right",
      group: "Workspace",
      keywords: "divide vertical new chart pane",
      run: () => d.splitActivePane("row"),
    },
    {
      id: "ws.splitDown",
      title: "Split pane down",
      group: "Workspace",
      keywords: "divide horizontal new chart pane",
      run: () => d.splitActivePane("col"),
    },
    {
      id: "ws.close",
      title: "Close pane",
      group: "Workspace",
      keywords: "remove delete pane",
      /* One pane is the floor. A command that silently does nothing is worse
         than one that is visibly unavailable. */
      when: () => d.canCloseActivePane(),
      danger: true,
      run: () => d.closeActivePane(),
    },
    {
      id: "ws.link",
      title: "Cycle this pane's link channel",
      group: "Workspace",
      keywords: "colour color group follow sync symbol",
      detail: () => d.activePaneLink(),
      run: () => d.cycleActivePaneLink(),
    },
  );

  /* ------------------------------------------------------------- drawing */

  for (const k of d.drawKinds) {
    list.push({
      id: `draw.${k.id}`,
      title: `Draw: ${k.label}`,
      menuTitle: k.label,
      group: "Draw",
      keywords: `drawing tool annotate ${k.id} ${k.hint}`,
      detail: () => k.hint,
      checked: () => d.armedDrawTool() === k.id,
      /* Arming an already-armed tool disarms it, so the same keystroke is both
         "start drawing" and "stop drawing". */
      run: () => d.armDrawTool(d.armedDrawTool() === k.id ? null : k.id),
    });
  }

  list.push(
    {
      id: "draw.select",
      title: "Select and move drawings",
      group: "Draw",
      keywords: "cursor pointer arrow escape tool off",
      checked: () => d.armedDrawTool() === null,
      run: () => d.armDrawTool(null),
    },
    {
      id: "draw.magnet",
      title: "Magnet to open, high, low and close",
      group: "Draw",
      keywords: "snap ohlc precise align",
      detail: () => (d.magnet() ? "on" : "off"),
      checked: () => d.magnet(),
      run: () => d.toggleMagnet(),
    },
    {
      id: "draw.undo",
      title: "Undo drawing change",
      group: "Draw",
      keywords: "revert back mistake",
      when: () => d.canUndoDrawing(),
      run: () => d.undoDrawing(),
    },
    {
      id: "draw.redo",
      title: "Redo drawing change",
      group: "Draw",
      keywords: "forward again",
      when: () => d.canRedoDrawing(),
      run: () => d.redoDrawing(),
    },
    {
      id: "draw.delete",
      title: "Delete the selected drawing",
      group: "Draw",
      keywords: "remove erase",
      when: () => d.hasDrawingSelected(),
      run: () => d.deleteDrawing(),
    },
    {
      id: "draw.clear",
      title: "Clear every drawing on this chart",
      group: "Draw",
      keywords: "erase all remove wipe",
      detail: () => `${d.drawingCount()} on this chart`,
      when: () => d.drawingCount() > 0,
      danger: true,
      run: () => d.clearDrawings(),
    },
  );

  /* --------------------------------------------------------------- agent */

  list.push(
    {
      id: "agent.open",
      title: "Ask the analyst",
      group: "Analyst",
      keywords: "ai agent chat assistant question llm",
      run: () => d.askAgent(),
    },
    {
      id: "agent.brief",
      title: "Brief me on this chart",
      group: "Analyst",
      keywords: "ai summary analysis overview read",
      detail: () => "runs the grounded tool sweep",
      run: () => d.askAgent("Brief me on what is on screen."),
    },
  );

  /* ----------------------------------------------------------- appearance */

  for (const t of d.themes) {
    list.push({
      id: `ui.theme.${t}`,
      title: `Theme: ${cap(t)}`,
      menuTitle: cap(t),
      group: "Appearance",
      keywords: "colour color scheme dark light palette",
      checked: () => d.theme() === t,
      run: () => d.theme.set(t),
    });
  }

  for (const den of d.densities) {
    list.push({
      id: `ui.density.${den}`,
      title: `Density: ${cap(den)}`,
      menuTitle: cap(den),
      group: "Appearance",
      keywords: "size scale type zoom compact comfortable",
      checked: () => d.density() === den,
      run: () => d.density.set(den),
    });
  }

  list.push(
    {
      id: "view.news",
      title: "News bar",
      group: "View",
      keywords: "news rss headlines feed ticker wire press releases",
      detail: () =>
        d.newsOn()
          ? "a strip above the live bar, one headline at a time"
          : "off — reads RSS and Atom feeds through the local service",
      checked: () => d.newsOn(),
      run: () => d.newsOn.update((v) => !v),
    },
    {
      id: "view.watchRail",
      title: "Watchlist rail",
      group: "View",
      keywords: "watchlist rail sidebar symbols list quick switch left panel",
      detail: () =>
        d.railOn()
          ? "your list beside the chart: price, 24h change and each symbol's setup"
          : "off — the Watchlist desk still has the full list",
      checked: () => d.railOn(),
      run: () => d.railOn.update((v) => !v),
    },
    {
      id: "chart.volume",
      title: "Volume pane",
      group: "Chart",
      keywords: "volume histogram bottom pane hide show bars turnover",
      checked: () => d.volumeOn(),
      run: () => d.volumeOn.update((v) => !v),
    },
    {
      id: "chart.logScale",
      title: "Logarithmic price scale",
      group: "Chart",
      keywords: "log logarithmic linear scale axis percent ratio",
      /* It had a two-letter button on the price gutter and nothing else — no
         command, no keyboard route, and nothing in any menu. On a multi-year
         range it is the difference between a readable chart and a wall. */
      detail: () =>
        d.logScale()
          ? "equal percentage moves are equal distances"
          : "linear — equal price moves are equal distances",
      checked: () => d.logScale(),
      run: () => d.logScale.update((v) => !v),
    },
    {
      id: "chart.grid",
      title: "Grid",
      group: "Chart",
      keywords: "grid lines gridlines background rule guides ruler mesh",
      detail: () =>
        d.gridOn()
          ? "price levels and time ticks, behind everything"
          : "off — nothing behind price but the session wash",
      checked: () => d.gridOn(),
      run: () => d.gridOn.update((v) => !v),
    },
    {
      id: "chart.sessions",
      title: "Session overlap shading",
      group: "Chart",
      keywords: "session sessions london tokyo new york sydney overlap liquidity shading wash background",
      /* Named for what it marks. It used to shade every open session, which on a
         24-hour market is every bar; what it shades now is the hours when two
         centres are open at once. */
      detail: () =>
        d.sessionBands()
          ? "the hours two centres are open at once — London/New York, Tokyo/London"
          : "off — a plain background",
      checked: () => d.sessionBands(),
      run: () => d.sessionBands.update((v) => !v),
    },
    {
      id: "chart.volumeReset",
      title: "Reset the volume pane height",
      group: "Chart",
      keywords: "volume pane height size default restore",
      run: () => d.resetVolumeHeight(),
    },
    {
      id: "ui.setup",
      title: "Show the Setup card",
      group: "Appearance",
      keywords: "sniper entry stop size gates plan trade verdict inspector",
      run: () => d.revealSetup(),
    },
    {
      id: "ui.dock",
      title: "Toggle the inspector dock",
      group: "Appearance",
      keywords: "right panel sidebar hide show",
      checked: () => d.dockOpen(),
      run: () => d.dockOpen.update((v) => !v),
    },
    {
      id: "ui.focus",
      title: "Focus mode",
      group: "Appearance",
      keywords: "hide chrome distraction fullscreen chart only",
      detail: () => (d.focus() === "off" ? "off" : d.focus() === "on" ? "chrome hidden" : "everything hidden"),
      checked: () => d.focus() !== "off",
      run: () => d.focus.update((f) => (f === "off" ? "on" : f === "on" ? "full" : "off")),
    },
    {
      id: "ui.fullscreen",
      title: "Full screen",
      group: "Appearance",
      keywords: "maximise window f11",
      run: () => d.fullscreen(),
    },
  );

  /* --------------------------------------------------------------- alerts */

  list.push(
    {
      id: "alerts.sound",
      title: "Alert sound",
      group: "Alerts",
      keywords: "audio beep notify mute",
      checked: () => d.alertSound(),
      run: () => d.alertSound.update((v) => !v),
    },
    {
      id: "alerts.desktop",
      title: "Desktop notifications",
      group: "Alerts",
      keywords: "system notify os toast permission",
      checked: () => d.alertDesktop(),
      run: () => d.alertDesktop.update((v) => !v),
    },
  );

  /* ----------------------------------------------------------------- help */

  list.push(
    {
      id: "app.settings",
      title: "Settings",
      group: "Help",
      keywords: "preferences options configure theme density account equity alerts storage privacy about",
      run: () => d.openSettings(),
    },
    {
      id: "help.shortcuts",
      title: "Keyboard shortcuts",
      group: "Help",
      keywords: "keys bindings cheatsheet hotkeys",
      run: () => d.openShortcuts(),
    },
    /* These two carry the ids the KEYBOARD binds, deliberately. A binding whose
       id names no command falls back to showing its raw id in the shortcut
       sheet — which is how "palette.open" ended up on screen looking like a
       label somebody had written. */
    {
      id: "palette.open",
      title: "Open the command palette",
      group: "Help",
      keywords: "search everything symbol command find",
      run: () => d.openPalette(""),
    },
    {
      id: "palette.commands",
      title: "Search commands",
      group: "Help",
      keywords: "palette run action",
      run: () => d.openPalette(">"),
    },
    {
      id: "help.notifications",
      title: "Notification log",
      group: "Help",
      keywords: "history alerts missed bell",
      run: () => d.openNotifications(),
    },
    {
      id: "net.reset",
      title: "Reset the request governor and cache",
      group: "Help",
      keywords: "network rate limit clear stuck 429 unblock",
      detail: () => "clears budgets, bans and cached responses",
      danger: true,
      run: () => d.resetNetwork(),
    },
  );

  return d.commands.register(...list);
}

/**
 * The keyboard map.
 *
 * Deliberately conservative with modified chords: Mod+W, Mod+T, Mod+N and
 * friends belong to the browser and taking them produces a terminal that
 * closes the tab when you meant to close a pane.
 */
export function bindKeys(d: CommandDeps): () => void {
  const km = d.keymap;
  const run = (id: string) => () => d.commands.run(id);
  const offs: (() => void)[] = [];

  const bind = (keys: string, id: string, opts?: { allowInInput?: boolean }): void => {
    offs.push(km.bind(keys, id, run(id), opts ?? {}));
  };

  /* The palette must open from anywhere, including from inside a text field —
     it is the escape hatch, and an escape hatch you cannot reach is not one.
     Hence `allowInInput`, which almost nothing else gets. */
  bind("Mod+k", "palette.open", { allowInInput: true });
  bind("Mod+Shift+p", "palette.commands", { allowInInput: true });

  bind("?", "help.shortcuts");
  bind("Mod+,", "app.settings");
  bind("f", "ui.focus");
  bind("b", "ui.dock");
  /* The v5 design's key for the side panel. A second binding, not a
     replacement: B is in muscle memory and in every help screen. */
  bind("]", "ui.dock");
  bind("v", "chart.volume");
  bind("l", "chart.goLive");
  bind("r", "chart.reload");
  bind("Shift+r", "replay.toggle");
  bind("a", "agent.open");
  bind("Shift+b", "agent.brief");
  bind("Shift+n", "help.notifications");

  /* Replay stepping. Bare arrows are left to the chart's own panning. */
  bind("Shift+arrowright", "replay.forward");
  bind("Shift+arrowleft", "replay.back");

  /* Drawing. Mod+Z is the one chord everyone expects, and it must work while
     the pointer is anywhere on the chart. */
  bind("Mod+z", "draw.undo");
  bind("Mod+Shift+z", "draw.redo");
  bind("delete", "draw.delete");
  bind("backspace", "draw.delete");
  bind("m", "draw.magnet");
  bind("t", "draw.trendline");
  bind("h", "draw.hline");
  bind("Shift+f", "draw.fib");

  /* Panes. Mod+Alt keeps clear of the browser's own Mod+digit and Mod+W. */
  bind("Mod+Alt+arrowright", "ws.splitRight");
  bind("Mod+Alt+arrowdown", "ws.splitDown");
  bind("Mod+Alt+w", "ws.close");
  bind("Mod+Alt+l", "ws.link");

  /* Go-to sequences. "g" then a letter — no modifier to collide with. */
  const gotos: readonly [string, string][] = [
    ["g c", "view.chart"],
    ["g s", "view.signals"],
    ["g t", "view.strategy"],
    ["g r", "view.risk"],
    ["g k", "view.screener"],
    ["g f", "view.flow"],
    ["g d", "view.data"],
    ["g a", "view.agent"],
    ["g w", "view.workspace"],
  ];
  for (const [keys, id] of gotos) bind(keys, id);

  /* Timeframes on the number row: the one place a bare digit is unambiguous. */
  d.timeframes.forEach((tf, i) => {
    if (i < 9) bind(String(i + 1), `market.tf.${tf}`);
  });

  return () => {
    for (const off of offs) off();
  };
}

/**
 * The menu bar. Curated order, resolved late so state is never stale.
 *
 * SIX MENUS, NOT ELEVEN.
 * v45 shipped File, View, Chart, Study, Workspace, Draw, Replay, Analyst, Risk,
 * Alerts and Help. That is not a menu bar, it is a list of features with a box
 * drawn round each one, and it cost 540px of a row that also has to hold ten
 * desk tabs. Three of them were barely menus at all: "Risk" contained a single
 * command and a caption, "Replay" contained three, and "Analyst" contained two
 * plus a link to a desk already reachable from the desk switcher beside it.
 *
 * The rule applied here is that a menu is a NOUN THE USER ALREADY HAS — a file,
 * a view, a chart, a drawing — and anything that is really a feature name
 * belongs one level down, inside the noun it acts on. Replay, alerts and the
 * analyst are all things you DO to the chart or the session, so they live under
 * Tools; layouts and panes are ways of arranging what you see, so they live
 * under View beside the desks and the theme.
 *
 * Nothing was removed. Every command that had a menu row still has one, and all
 * of them remain in the palette regardless.
 */
export function menuEntries(d: CommandDeps): MenuBarEntry[] {
  const tfItems = (): MenuItem[] => d.timeframes.map((tf) => ({ id: `market.tf.${tf}` }));
  const themeItems = (): MenuItem[] => d.themes.map((t) => ({ id: `ui.theme.${t}` }));
  const densityItems = (): MenuItem[] => d.densities.map((den) => ({ id: `ui.density.${den}` }));

  return [
    {
      label: "File",
      /* Getting things OUT of the terminal, and nothing else. The Data desk
         used to head this menu; it is a desk, it is on the desk bar, and a menu
         whose first item duplicates a tab teaches people the menu is where
         duplicates live. */
      items: () => [
        { id: "file.exportSettings" },
        { id: "file.exportAll" },
        { kind: "separator" },
        { id: "chart.exportPng" },
        { id: "chart.copySummary" },
      ],
    },
    {
      label: "View",
      items: () => [
        /* The desks live on the desk bar, two centimetres to the right of this
           menu. They stay reachable here for discoverability and for keyboard
           users, but ONE row deep rather than eleven — eleven "Go to" items
           made this menu about navigation you can already see, and pushed the
           things that are only here to the bottom of a long scroll. */
        { label: "Desks", items: d.viewList.map((v) => ({ id: `view.${v.id}` })) },
        { kind: "separator" },
        {
          label: "Layout",
          items: [
            ...d.workspacePresets.map((p) => ({ id: `ws.preset.${p.id}` })),
            { kind: "separator" as const },
            { id: "ws.splitRight" },
            { id: "ws.splitDown" },
            { id: "ws.link" },
            { id: "ws.close" },
          ],
        },
        { kind: "separator" },
        { id: "ui.setup" },
        { id: "ui.dock" },
        { id: "ui.focus" },
        { id: "ui.fullscreen" },
        { kind: "separator" },
        { label: "Theme", items: themeItems() },
        { label: "Density", items: densityItems() },
      ],
    },
    {
      label: "Chart",
      items: () => [
        ...d.chartKinds.map((k) => ({ id: `chart.kind.${k}` })),
        { kind: "separator" },
        { label: "Timeframe", items: tfItems() },
        { label: "Moving averages", items: d.maSet.map((ma) => ({ id: `chart.${ma.id}` })) },
        /* The detectors used to sit under a top-level "Study" menu. They mark up
           THIS chart and nothing else, so this is where someone looks for them. */
        { label: "Detectors", items: d.detectorSet.map((det) => ({ id: `study.${det.id}` })) },
        { label: "Higher timeframes", items: d.htfChoices().map((tf) => ({ id: `study.htf.${tf}` })) },
        { kind: "separator" },
        { id: "chart.volume" },
        { id: "chart.volumeReset" },
        { id: "chart.grid" },
        { id: "chart.sessions" },
        { id: "chart.logScale" },
        { kind: "separator" },
        { id: "chart.goLive" },
        { id: "chart.reload" },
      ],
    },
    {
      label: "Draw",
      items: () => [
        { id: "draw.select" },
        { kind: "separator" },
        ...d.drawKinds.map((k) => ({ id: `draw.${k.id}` })),
        { kind: "separator" },
        { id: "draw.magnet" },
        { id: "draw.undo" },
        { id: "draw.redo" },
        { id: "draw.delete" },
        { id: "draw.clear" },
      ],
    },
    {
      label: "Tools",
      items: () => [
        {
          label: "Replay",
          items: [{ id: "replay.toggle" }, { kind: "separator" as const }, { id: "replay.back" }, { id: "replay.forward" }],
        },
        {
          label: "Alerts",
          items: [
            { id: "view.signals", label: "Open the Signals desk" },
            { kind: "separator" as const },
            { id: "alerts.sound" },
            { id: "alerts.desktop" },
            { kind: "separator" as const },
            { id: "help.notifications" },
          ],
        },
        {
          label: "Analyst",
          items: [
            { id: "agent.open" },
            { id: "agent.brief" },
            { kind: "separator" as const },
            { id: "view.agent", label: "Open the Analyst desk" },
          ],
        },
        { kind: "separator" },
        /* The Risk desk and its disclaimer both used to sit here. The desk is on
           the desk bar; the disclaimer belongs ON the desk, where it is, rather
           than in a menu that has to be opened before it can warn anybody. */
        { id: "net.reset" },
      ],
    },
    {
      label: "Help",
      items: () => [
        { id: "help.shortcuts" },
        { id: "palette.open" },
        { id: "palette.commands" },
      ],
    },
  ];
}

/**
 * The seven menus, folded into one.
 *
 * WHY
 * The command bar carried a brand, SEVEN text menus, five desk groups and five
 * icon buttons — seventeen targets on one 42px row, and `deskbar.ts` already
 * records that this row measured as full at 1200px. The menus were the least
 * earning thing on it: every command in them is in the palette as well, and two
 * of them duplicated controls sitting centimetres away (View ▸ Desks repeats the
 * desk bar; Chart ▸ Timeframe repeats the context bar).
 *
 * NOTHING IS REMOVED. Each former menu becomes a submenu of one button, in the
 * same order, with the same items — so browsing still works for anyone who does
 * not type, on one button instead of seven. That is roughly 250px back.
 *
 * The two genuine duplicates are the only omissions, and they are omissions
 * from THIS menu only: both destinations remain one click away on the bar they
 * were duplicating, and both remain in the palette.
 */
export function appMenuItems(d: CommandDeps): MenuItem[] {
  const nested = menuEntries(d).map((entry) => ({
    label: entry.label,
    items: entry.items(),
  }));

  return [
    ...nested,
    { kind: "separator" },
    /* Where every desktop application of the last thirty years has put it. */
    { id: "app.settings" },
    { id: "help.shortcuts" },
  ];
}
