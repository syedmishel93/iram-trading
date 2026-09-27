/**
 * Layout presets: one named arrangement of preferences that already exist.
 *
 * A preset OWNS NOTHING. It is a list of values and the names of the signals
 * they are written to, and every one of those signals is the same one the
 * individual control in Settings writes. That is the whole design constraint:
 * a preset that kept its own copy of "the inspector is 360 wide" would be the
 * second owner of that fact, and the first time somebody dragged the splitter
 * the preset would be describing a terminal that no longer existed.
 *
 * WHICH IS ALSO WHY THE CURRENT PRESET IS DERIVED, NEVER STORED.
 * `matchPreset` reads the live values back and answers with the preset they
 * match, or "custom". There is no `layoutPreset` preference, because a stored
 * one would say "Trader" about a layout somebody had since changed by hand —
 * a label that lies is worse than no label.
 *
 * `null` in `LayoutState` means "this build does not expose that signal", and
 * it is compared against nothing rather than assumed. See `DefDeps` in
 * defs.ts: the watchlist rail, the news strip and the inspector's open state
 * are owned by `ui/shell.ts`, and a preset must say what it could not reach
 * rather than report success over a preference it never wrote.
 */

/** What a preset writes. Every field is an existing preference. */
export interface LayoutValues {
  /** `--ui-scale` and the gutter — the shell's density signal. */
  readonly density: string;
  /** The inspector's width: `--w-dock` via `data-dock-size`. */
  readonly dock: string;
  /** The gutter between cards: `--shell-gap` via `data-gutter`. */
  readonly gutter: string;
  /** The live bar's height: `--h-status` via `data-livebar`. */
  readonly liveBar: string;
  readonly watchRail: boolean;
  readonly newsBar: boolean;
  readonly dockOpen: boolean;
}

/** The same shape, read back — with `null` for anything unreadable here. */
export interface LayoutState {
  readonly density: string;
  readonly dock: string;
  readonly gutter: string;
  readonly liveBar: string;
  readonly watchRail: boolean | null;
  readonly newsBar: boolean | null;
  readonly dockOpen: boolean | null;
}

export interface LayoutPreset {
  readonly id: string;
  readonly label: string;
  /** One sentence: who it is for. */
  readonly blurb: string;
  readonly values: LayoutValues;
}

/**
 * Three, and no more.
 *
 * ANALYST IS TODAY'S TERMINAL, EXACTLY. Every value in it is the shipped
 * default — standard density, a 360px inspector, the gutter left to density,
 * a 30px live bar, the rail and the news strip on. So a fresh install reads
 * as "Analyst" rather than as "Custom", and choosing it is a way back rather
 * than a change of look.
 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: "focus",
    label: "Focus",
    blurb: "Chart-led. The rail and the news strip go, the inspector narrows, everything tightens.",
    values: {
      density: "compact",
      dock: "narrow",
      gutter: "tight",
      liveBar: "standard",
      watchRail: false,
      newsBar: false,
      dockOpen: true,
    },
  },
  {
    id: "analyst",
    label: "Analyst",
    blurb: "The terminal as it ships: rail on, inspector at 360, news on.",
    values: {
      density: "standard",
      dock: "standard",
      gutter: "standard",
      liveBar: "standard",
      watchRail: true,
      newsBar: true,
      dockOpen: true,
    },
  },
  {
    id: "trader",
    label: "Trader",
    blurb: "Room to read: a wide inspector, a taller live bar, comfortable spacing.",
    values: {
      density: "comfortable",
      dock: "wide",
      gutter: "standard",
      liveBar: "tall",
      watchRail: true,
      newsBar: true,
      dockOpen: true,
    },
  },
];

/** The id used when the live layout is not any of them. Never written. */
export const CUSTOM = "custom";

export function findPreset(id: string): LayoutPreset | null {
  return LAYOUT_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Which preset the current layout IS.
 *
 * A field the build cannot read (`null`) is skipped rather than treated as a
 * mismatch: reporting "custom" for ever because one signal is not wired would
 * make the readout useless in exactly the build that needs it most.
 */
export function matchPreset(state: LayoutState): string {
  for (const preset of LAYOUT_PRESETS) {
    const v = preset.values;
    if (state.density !== v.density) continue;
    if (state.dock !== v.dock) continue;
    if (state.gutter !== v.gutter) continue;
    if (state.liveBar !== v.liveBar) continue;
    if (state.watchRail !== null && state.watchRail !== v.watchRail) continue;
    if (state.newsBar !== null && state.newsBar !== v.newsBar) continue;
    if (state.dockOpen !== null && state.dockOpen !== v.dockOpen) continue;
    return preset.id;
  }
  return CUSTOM;
}

const ON_OFF = (b: boolean): string => (b ? "on" : "off");

/**
 * What choosing it will overwrite, in the operator's words.
 *
 * Spelled out rather than summarised as "layout settings": a control that
 * silently rewrites seven preferences somebody may have spent an evening on
 * has to say which seven BEFORE it is used, not in a toast afterwards.
 */
export function presetSummary(preset: LayoutPreset): string {
  const v = preset.values;
  return (
    `${preset.label} sets density to ${v.density}, the inspector to ${v.dock}` +
    `${v.dockOpen ? " and open" : " and closed"}, the gutter to ${v.gutter}, ` +
    `the live bar to ${v.liveBar}, the watchlist rail ${ON_OFF(v.watchRail)} ` +
    `and the news strip ${ON_OFF(v.newsBar)}.`
  );
}
