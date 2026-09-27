/**
 * The settings themselves.
 *
 * Every definition here reads and writes state that ALREADY EXISTS somewhere in
 * the terminal. Nothing in this file owns a value. That is deliberate and it is
 * the lesson of the equity defect: the moment a settings screen keeps its own
 * copy of a number, it becomes the seventh place preferences live rather than
 * the first place they all live.
 *
 * The `keywords` on each entry carry the OLD address — "appearance popover",
 * "Data desk", "Tools > Alerts" — because for the first month after a move,
 * what people search for is where the thing used to be.
 */

import type { SectionDef, SettingDef } from "./schema";
import type { AccountStore } from "../core/account";
import type { Signal } from "../core/signal";
import { RULE_LIMITS, rulesAreDefault, type GateRules } from "../setup/rules";
import { EXIT_LIMITS, exitRulesAreDefault, type ExitRules } from "../setup/exit";
import {
  PARAMS,
  clampParam,
  isDefault,
  paramDefs,
  sanitiseParams,
  tunedCount,
  type Params as IndicatorParams,
} from "../chart/params";
import { STUDIES } from "../chart/studies";
import { PANES } from "../chart/panes";
import { driverSummary, driversFor, familyOf } from "../data/drivers";
import {
  DEFAULT_BACKEND,
  backendConfig,
  configureBackend,
  gatewayBase,
  isConsolidated,
  resetBackend,
  streamThroughBackend,
} from "../data/backend";
import { appearance, knob, type KnobId } from "../ui/appearance";
import {
  CUSTOM,
  LAYOUT_PRESETS,
  findPreset,
  matchPreset,
  presetSummary,
  type LayoutState,
} from "./presets";

/** One venue, as Settings needs to show it. */
export interface SourceRow {
  readonly id: string;
  readonly label: string;
  readonly covers: string;
  readonly quality: string;
  /** Position in the failover order, one-based. Not the raw priority field. */
  readonly priority: number;
  readonly enabled: boolean;
  /** True while the circuit breaker has it parked — a failure, not a choice. */
  readonly parked: boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "account",
    label: "Account & risk",
    group: "Trading",
    blurb:
      "The numbers every position size starts from. Set here once; the Risk desk, the Calculator and the pre-flight checklist all read these same values. Nothing here leaves this machine, and nothing here places an order.",
  },
  {
    id: "chart",
    label: "Chart defaults",
    group: "Trading",
    blurb: "What a fresh window opens on, before you touch anything.",
  },
  {
    id: "chartlook",
    label: "Chart appearance",
    group: "Trading",
    blurb:
      "What the chart looks like, as opposed to what it opens on. Colours here follow the theme until you override them, and clearing an override hands it back — so switching theme still recolours a chart you have not deliberately painted.",
  },
  {
    id: "indicators",
    label: "Indicator settings",
    group: "Trading",
    blurb:
      "Every period and multiple the chart's indicators run on. The published default is shown beside each one and is one click away, so a tuned chart can always be put back and can never be mistaken for a standard one.",
  },
  {
    id: "drivers",
    label: "Cross-asset drivers",
    group: "Data",
    blurb:
      "What each instrument is measured against, and why. These are the series a model is allowed to consider — declared, small, and every one of them with a stated mechanism. Whether any of them actually matters is measured on your data, never assumed here.",
  },
  {
    id: "alerts",
    label: "Alerts & notifications",
    group: "Trading",
    blurb: "How the terminal interrupts you, and how loudly.",
  },
  {
    id: "rules",
    label: "Trading rules",
    group: "Trading",
    blurb:
      "The gates the Setup card checks before it will show you an entry. These are the numbers it means when it says \"your limit\" — until you set them here it was quoting defaults you had never been shown. Any one of them failing stands you down; that part is not configurable, because a checklist you can negotiate with is not a checklist.",
  },
  {
    id: "exits",
    label: "Exit management",
    group: "Trading",
    blurb:
      "What the card says about a position you are already in. Nothing here moves a stop or closes anything — it reports what each rule would say and why, and shows the two trailing methods side by side rather than picking one, because which is better is a measured question and the answer belongs to your journal rather than to a default chosen for you.",
  },
  {
    id: "backend",
    label: "Backend",
    group: "Data",
    blurb:
      "Where the Python backend is. One address serves bars, the store and the model service; `server/gateway` puts all three on one port. The three services can still be pointed at separately for a split setup, and anything left blank falls back to the address above it.",
  },
  {
    id: "sources",
    label: "Data sources",
    group: "Data",
    blurb:
      "Which venues may serve this terminal, in the order they are tried. Switching one off is a standing decision and is remembered; a source the circuit breaker has parked is a temporary failure and comes back on its own. The two are shown separately because they mean different things.",
  },
  {
    id: "data",
    label: "Data & storage",
    group: "Data",
    blurb:
      "Where prices come from and what is kept. A source that is degraded is labelled degraded — the terminal never fills a gap with a guess.",
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "Terminal",
    blurb:
      "Theme, accent, and the shape of the frame around the chart. Everything here applies immediately, is remembered, and starts on the arrangement the terminal shipped with — so nothing changes until you change it.",
  },
  {
    id: "keyboard",
    label: "Keyboard",
    group: "Terminal",
    blurb: "Every command, and the keys that run it.",
  },
  {
    id: "privacy",
    label: "Privacy & safety",
    group: "System",
    blurb:
      "What this terminal will and will not do. These are properties of how it is built, not preferences — which is why most of this section has no switches.",
  },
  {
    id: "about",
    label: "About & diagnostics",
    group: "System",
    blurb: "Version, storage, and whether anything is wrong.",
  },
];

export interface DefDeps {
  readonly account: AccountStore;
  readonly theme: Signal<string>;
  readonly themes: readonly string[];
  readonly density: Signal<string>;
  readonly densities: readonly string[];
  /** The brand colour over any theme (v55). "theme" = the theme's own. */
  readonly accent: Signal<string>;
  readonly accents: readonly string[];
  /**
   * THE THREE LAYOUT SIGNALS THE SHELL OWNS, and why they are optional.
   *
   * A layout preset writes the watchlist rail, the news strip and whether the
   * inspector is open — three signals that live inside `mountShell` and are
   * not reachable from here until it passes them in. Optional rather than
   * required so that a build which has not wired them yet still COMPILES and
   * still applies the rest, and `presets.ts` reads a missing one as `null`
   * and says so rather than reporting a preference it never wrote. The
   * remaining appearance preferences need no wiring at all: they are tokens,
   * owned by `ui/appearance.ts`.
   */
  readonly watchRail?: Signal<boolean>;
  readonly newsBar?: Signal<boolean>;
  readonly dockOpen?: Signal<boolean>;
  readonly defaultTimeframe: Signal<string>;
  readonly timeframes: readonly string[];
  readonly chartKind: Signal<string>;
  readonly chartKinds: readonly string[];
  readonly volumeOn: Signal<boolean>;
  readonly sessionBands: Signal<boolean>;
  readonly gridOn: Signal<boolean>;
  /** Candle colour overrides. Empty string = follow the theme. */
  readonly candleUp: Signal<string>;
  readonly candleDown: Signal<string>;
  /** The colour the chart is actually painting with, override or theme. */
  effectiveCandle(which: "up" | "down"): string;
  readonly evidenceAuto: Signal<boolean>;
  readonly volumeHeight: () => number;
  setVolumeHeight(px: number): void;
  readonly alertSound: Signal<boolean>;
  readonly alertDesktop: Signal<boolean>;
  /** Storage durability, from `store/durability.ts`. */
  readonly durability: { state: string; note: string; remedy: string | null };
  readonly storageBytes: () => number;
  readonly feedNote: () => string;
  readonly version: string;
  /** The gate thresholds, and how to change one. */
  readonly rules: () => GateRules;
  setRule(patch: Partial<GateRules>): void;
  resetRules(): void;
  readonly exitRules: () => ExitRules;
  setExitRule(patch: Partial<ExitRules>): void;
  resetExitRules(): void;
  /** Every venue, with whatever is currently true of it. */
  readonly sources: () => readonly SourceRow[];
  setSourceEnabled(id: string, on: boolean): void;
  /** Live, so a toggle reflects what it just did. */
  sourceEnabled(id: string): boolean;
  /** Per-indicator settings — the same signal the chart renders from. */
  readonly studyParams: Signal<Record<string, IndicatorParams>>;
  /** The instrument the driver section describes. */
  readonly symbol: () => string;
  openKeyboardSheet(): void;
  openNotificationLog(): void;
  exportVault(): void;
  resetGovernor(): void;
}

const bool = (s: Signal<boolean>) => ({
  read: () => String(s()),
  write: (v: string) => s.set(v === "true"),
});

const num = (read: () => number, write: (n: number) => void) => ({
  read: () => String(read()),
  write: (v: string) => {
    const n = Number(v);
    /* A non-number is not a value. Refusing keeps the previous one, and the
       control re-renders showing it, so nothing is silently zeroed. */
    if (Number.isFinite(n)) write(n);
  },
});

const pick = (s: Signal<string>) => ({
  read: () => s(),
  write: (v: string) => s.set(v),
});

/** "1st", "2nd" — used to say where a source sits in the failover order. */
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

const options = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));

/**
 * One `number` setting per indicator parameter, generated from the registry.
 *
 * WHY GENERATED AND NOT HAND-WRITTEN
 * Thirty parameters across fifteen indicators, and the registry already knows
 * every label, range, step and published default. Writing them out by hand
 * would be thirty chances to disagree with `chart/params.ts` about what an
 * RSI's maximum period is, and the disagreement would only surface as a
 * control that refuses a value the chart accepts.
 *
 * The hint always carries the published default, so the answer to "what was
 * this before I changed it" is on screen rather than in a git history.
 */
function indicatorDefs(d: DefDeps): SettingDef[] {
  const labelOf = (id: string): string =>
    STUDIES.find((x) => x.id === id)?.label ?? PANES.find((x) => x.id === id)?.label ?? id;

  const out: SettingDef[] = [];
  for (const id of Object.keys(PARAMS)) {
    for (const def of paramDefs(id)) {
      out.push({
        id: `indicators.${id}.${def.id}`,
        section: "indicators",
        label: `${labelOf(id)} · ${def.label}`,
        hint: `${def.hint ? `${def.hint} ` : ""}Published default ${def.def}.`,
        control: { kind: "number", min: def.min, max: def.max, step: def.step },
        keywords: [id, def.id, labelOf(id), "indicator", "period", "length"],
        read: () => String(sanitiseParams(id, d.studyParams()[id])[def.id] ?? def.def),
        write: (v: string) => {
          const next = { ...sanitiseParams(id, d.studyParams()[id]), [def.id]: clampParam(def, v) };
          d.studyParams.update((all) => {
            const copy = { ...all };
            /* Default settings are stored as ABSENT, not as a map of defaults.
               It keeps the preferences blob small and makes "is anything
               tuned" a question about the map's keys. */
            if (isDefault(id, next)) delete copy[id];
            else copy[id] = next;
            return copy;
          });
        },
      });
    }
  }

  out.push({
    id: "indicators.reset",
    section: "indicators",
    label: "Put every indicator back on its published definition",
    hint: "Clears all tuning at once. The chart repaints immediately.",
    control: { kind: "action", button: "Reset all" },
    read: () => {
      const n = tunedCount(d.studyParams());
      return n === 0 ? "Everything is on its published settings." : `${n} indicator${n === 1 ? " is" : "s are"} tuned.`;
    },
    write: () => d.studyParams.set({}),
    unavailable: () => (tunedCount(d.studyParams()) === 0 ? "Nothing is tuned." : null),
  });

  return out;
}

/**
 * The driver map, as statements rather than switches.
 *
 * Deliberately read-only. These are not preferences — a driver is in the map
 * because there is a stated mechanism by which it could move the instrument,
 * and letting somebody add "because it looked correlated" is precisely how a
 * panel of six honest columns becomes twenty and the walk-forward stops
 * meaning anything. The section exists so the map is INSPECTABLE, which is
 * what you need when a model says a driver mattered.
 */
function driverDefs(d: DefDeps): SettingDef[] {
  const out: SettingDef[] = [
    {
      id: "drivers.current",
      section: "drivers",
      label: "This instrument",
      control: { kind: "note", tone: "info" },
      keywords: ["driver", "macro", "correlation", "universe"],
      read: () => driverSummary(d.symbol()),
    },
  ];

  const fam = familyOf(d.symbol());
  if (fam === null) {
    out.push({
      id: "drivers.none",
      section: "drivers",
      label: "No family declared",
      control: { kind: "note", tone: "warn" },
      read: () =>
        `${d.symbol()} does not match any declared family, so no drivers are offered for it. That is a refusal to guess, not a gap — handing it the wrong four columns would train a model and report a number for it.`,
    });
    return out;
  }

  for (const drv of driversFor(d.symbol())) {
    out.push({
      id: `drivers.${drv.symbol}`,
      section: "drivers",
      label: `${drv.label} (${drv.symbol})`,
      control: { kind: "note", tone: "info" },
      keywords: [drv.symbol, drv.label, fam],
      read: () =>
        `${drv.role === "lead" ? "Treated as possibly leading. " : "Regime context, not a signal. "}${drv.why}`,
    });
  }
  return out;
}

/**
 * The preview's description, for anyone who cannot see it.
 *
 * Read from the live values rather than written as a fixed sentence, so it
 * cannot describe an appearance the preview is no longer showing.
 */
function lookSummary(d: DefDeps): string {
  const look = appearance();
  const accent = d.accent() === "theme" ? "the theme's own accent" : `a ${d.accent()} accent`;
  return (
    `A miniature of the terminal: the ${d.theme()} theme with ${accent}, ` +
    `${d.density()} density, ${look.radius()} corners and a ` +
    `${look.gutter() === "standard" ? "density-led" : look.gutter()} gutter. ` +
    `It shows the command row, the chart card with an up and a down candle, ` +
    `the inspector and the live bar.`
  );
}

export function buildSettings(d: DefDeps): SettingDef[] {
  const a = d.account;
  /* The six token-only preferences. Owned by ui/appearance.ts, which is where
     the note about why they are not in `shell.prefs` lives. */
  const look = appearance();

  const knobOptions = (id: KnobId): Array<{ value: string; label: string }> =>
    knob(id).options.map((o) => ({ value: o.value, label: o.label }));

  /** What a preset compares itself against, and what it writes back. */
  const layoutNow = (): LayoutState => ({
    density: d.density(),
    dock: look.dock(),
    gutter: look.gutter(),
    liveBar: look.liveBar(),
    watchRail: d.watchRail ? d.watchRail() : null,
    newsBar: d.newsBar ? d.newsBar() : null,
    dockOpen: d.dockOpen ? d.dockOpen() : null,
  });

  /**
   * Apply a preset THROUGH THE SAME SIGNALS the individual controls write.
   *
   * Not a shortcut past them: density is `d.density`, the inspector's width
   * is the same `look.dock` the Inspector width select writes, and the rail
   * is the shell's own signal — the one the View menu toggles. So a preset
   * and a hand-set layout are the same seven facts, and persistence, the
   * chart's repaint and the rail's mount/destroy all happen exactly as they
   * do when the control is used directly.
   */
  const applyPreset = (id: string): void => {
    const preset = findPreset(id);
    /* "custom" is a READOUT, never a command: there is no layout it names. */
    if (!preset) return;
    const v = preset.values;
    d.density.set(v.density);
    look.dock.set(v.dock);
    look.gutter.set(v.gutter);
    look.liveBar.set(v.liveBar);
    d.watchRail?.set(v.watchRail);
    d.newsBar?.set(v.newsBar);
    d.dockOpen?.set(v.dockOpen);
  };

  /** Preferences a preset names that this build cannot reach. Never hidden. */
  const outOfReach = (): string[] => {
    const out: string[] = [];
    if (!d.watchRail) out.push("the watchlist rail");
    if (!d.newsBar) out.push("the news strip");
    if (!d.dockOpen) out.push("whether the inspector is open");
    return out;
  };

  return [
    // ------------------------------------------------------------ backend ---
    /**
     * ONE ADDRESS, AND THE OVERRIDES BELOW IT.
     *
     * Before this existed the backend's location was eleven string literals
     * across eleven modules, and moving it meant editing source. Worse, because
     * the desks addressed three different ports, a backend that was half up
     * looked like nine unrelated faults rather than one.
     *
     * The per-service overrides are not there for symmetry. The three services
     * still run standalone on :8787/:8788/:8789, and an operator running them
     * that way must not be broken by a default that assumes the gateway.
     */
    {
      id: "backend.base",
      section: "backend",
      label: "Backend address",
      hint: "The gateway — bars, store and model service on one port. Everything below falls back to this.",
      control: { kind: "text", placeholder: DEFAULT_BACKEND },
      keywords: ["proxy", "server", "8787", "8788", "8789", "gateway", "port", "host", "url"],
      read: () => backendConfig().base,
      write: (v) => {
        configureBackend({ base: v });
      },
    },
    {
      id: "backend.shape",
      section: "backend",
      label: "",
      hint: "",
      control: { kind: "note", tone: "info" },
      keywords: ["consolidated", "split", "services"],
      read: () =>
        isConsolidated()
          ? `All three services on ${gatewayBase()} — one process, one thing to be up or down.`
          : "Split across separate addresses. Clear the overrides below to use one gateway.",
    },
    {
      id: "backend.stream",
      section: "backend",
      label: "Live bars through the backend",
      hint:
        "One vendor connection for every pane watching a symbol instead of one each, and a push for sources that have no socket (yfinance, Twelve Data, Polygon) which can otherwise only be polled. Off by default because it makes the chart's liveness depend on the backend running — if the socket does not open, the feed falls back to the direct vendor path.",
      control: { kind: "toggle" },
      keywords: ["websocket", "socket", "stream", "live", "ws", "fan-out", "gateway"],
      read: () => String(streamThroughBackend()),
      write: (v) => {
        configureBackend({ stream: v === "true" });
      },
    },
    {
      id: "backend.proxy",
      section: "backend",
      label: "Bars and quotes override",
      hint: "Blank uses the address above. Set it only when the data proxy runs somewhere else.",
      control: { kind: "text", placeholder: "same as backend address" },
      keywords: ["ohlc", "quote", "mt5", "proxy", "8787"],
      read: () => backendConfig().proxy ?? "",
      write: (v) => {
        configureBackend({ proxy: v });
      },
    },
    {
      id: "backend.service",
      section: "backend",
      label: "Store override",
      hint: "Alerts, journal, sync and the risk governor. Blank uses the address above.",
      control: { kind: "text", placeholder: "same as backend address" },
      keywords: ["svc", "journal", "alerts", "sync", "sqlite", "8788"],
      read: () => backendConfig().service ?? "",
      write: (v) => {
        configureBackend({ service: v });
      },
    },
    {
      id: "backend.quant",
      section: "backend",
      label: "Model service override",
      hint: "GARCH, causal inference and calibrated probabilities. Blank uses the address above.",
      control: { kind: "text", placeholder: "same as backend address" },
      keywords: ["quant", "garch", "causal", "8789"],
      read: () => backendConfig().quant ?? "",
      write: (v) => {
        configureBackend({ quant: v });
      },
    },
    {
      id: "backend.reset",
      section: "backend",
      label: "Reset to default",
      hint: `Back to ${DEFAULT_BACKEND} with no overrides.`,
      control: { kind: "action", button: "Reset" },
      keywords: ["default", "localhost", "revert"],
      read: () => "",
      write: () => {
        resetBackend();
      },
    },

    // -------------------------------------------------------------- rules ---
    /**
     * Each of these is quoted back at you verbatim by the Setup card, which is
     * why the hints name the sentence they appear in. A threshold you meet in
     * a refusal for the first time is a threshold you will argue with.
     */
    {
      id: "rules.embargo",
      section: "rules",
      label: "News embargo",
      hint: 'Minutes either side of a high-impact event in which the card refuses a new trade. The gate reads "inside your N-minute embargo".',
      control: { kind: "number", min: RULE_LIMITS.embargoMinutes[0], max: RULE_LIMITS.embargoMinutes[1], step: 5, unit: "min" },
      keywords: ["calendar", "cpi", "fomc", "nfp", "event", "blackout", "setup card"],
      ...num(() => d.rules().embargoMinutes, (n) => d.setRule({ embargoMinutes: n })),
    },
    // -------------------------------------------------------------- exits ---
    /**
     * The half of a trade the terminal has never had an opinion about.
     *
     * `setup/plan.ts` places a stop at entry and nothing has ever moved it.
     * These are the rules the card reads a live position against — and every
     * one of them REPORTS, none of them acts.
     */
    {
      id: "exits.partial",
      section: "exits",
      label: "Partial at",
      hint: "R multiple at which the card says a partial is due. Zero switches it off — unlike the gate rules, zero here genuinely means \"no partial\" rather than a gate quietly disabled.",
      control: { kind: "number", min: EXIT_LIMITS.partialAtR[0], max: EXIT_LIMITS.partialAtR[1], step: 0.25, unit: "R" },
      keywords: ["scale out", "take profit", "target", "position"],
      ...num(() => d.exitRules().partialAtR, (n) => d.setExitRule({ partialAtR: n })),
    },
    {
      id: "exits.breakeven",
      section: "exits",
      label: "Break-even at",
      hint: "R multiple past which the card points out that a stop at entry makes the rest of the trade free.",
      control: { kind: "number", min: EXIT_LIMITS.breakEvenAtR[0], max: EXIT_LIMITS.breakEvenAtR[1], step: 0.25, unit: "R" },
      keywords: ["stop", "risk free", "position"],
      ...num(() => d.exitRules().breakEvenAtR, (n) => d.setExitRule({ breakEvenAtR: n })),
    },
    {
      id: "exits.trailAtr",
      section: "exits",
      label: "Trail distance",
      hint: "ATR multiple for the Chandelier trail. Under 1 ATR a trail sits inside the noise and is taken by the bar it was set on.",
      control: { kind: "number", min: EXIT_LIMITS.trailAtr[0], max: EXIT_LIMITS.trailAtr[1], step: 0.5, unit: "ATR" },
      keywords: ["chandelier", "trailing stop", "atr", "exit"],
      ...num(() => d.exitRules().trailAtr, (n) => d.setExitRule({ trailAtr: n })),
    },
    {
      id: "exits.trailBars",
      section: "exits",
      label: "Trail lookback",
      hint: "How many bars the trail hangs from, for both the ATR and the structural method.",
      control: { kind: "number", min: EXIT_LIMITS.trailBars[0], max: EXIT_LIMITS.trailBars[1], step: 1, unit: "bars" },
      keywords: ["chandelier", "swing", "structure", "exit"],
      ...num(() => d.exitRules().trailBars, (n) => d.setExitRule({ trailBars: n })),
    },
    {
      id: "exits.time",
      section: "exits",
      label: "Time stop",
      hint: "Bars after which a trade still inside 1R is called stale. A setup that has not worked by now is a different setup. Zero switches it off.",
      control: { kind: "number", min: EXIT_LIMITS.timeStopBars[0], max: EXIT_LIMITS.timeStopBars[1], step: 5, unit: "bars" },
      keywords: ["stale", "hold", "duration", "exit"],
      ...num(() => d.exitRules().timeStopBars, (n) => d.setExitRule({ timeStopBars: n })),
    },
    {
      id: "exits.reset",
      section: "exits",
      label: "Restore exit defaults",
      hint: "Puts every rule in this section back to what it shipped as.",
      control: { kind: "action", button: "Restore defaults" },
      keywords: ["reset", "default", "exit"],
      read: () => (exitRulesAreDefault(d.exitRules()) ? "unchanged" : "modified"),
      write: () => d.resetExitRules(),
    },

    {
      id: "rules.spread",
      section: "rules",
      label: "Spread budget",
      hint: "The most of your stop distance you are willing to give up in spread. Above this the cost of entering is a material part of the risk.",
      control: { kind: "number", min: RULE_LIMITS.spreadBudgetPct[0], max: RULE_LIMITS.spreadBudgetPct[1], step: 1, unit: "% of stop" },
      keywords: ["slippage", "cost", "execution", "setup card"],
      ...num(() => d.rules().spreadBudgetPct, (n) => d.setRule({ spreadBudgetPct: n })),
    },
    {
      id: "rules.heat",
      section: "rules",
      label: "Maximum open heat",
      hint: "Total risk across every open position plus the one being considered, as a share of equity.",
      control: { kind: "number", min: RULE_LIMITS.maxHeatPct[0], max: RULE_LIMITS.maxHeatPct[1], step: 0.5, unit: "% of equity" },
      keywords: ["portfolio", "exposure", "risk", "positions", "setup card"],
      ...num(() => d.rules().maxHeatPct, (n) => d.setRule({ maxHeatPct: n })),
    },
    {
      id: "rules.daily",
      section: "rules",
      label: "Daily loss limit",
      hint: "How far down on the day you will go before stopping. This is the one gate that does not clear until tomorrow.",
      control: { kind: "number", min: RULE_LIMITS.dailyLossLimitPct[0], max: RULE_LIMITS.dailyLossLimitPct[1], step: 0.5, unit: "% of equity" },
      keywords: ["drawdown", "stop trading", "tilt", "setup card"],
      ...num(() => d.rules().dailyLossLimitPct, (n) => d.setRule({ dailyLossLimitPct: n })),
    },
    {
      id: "rules.coverage",
      section: "rules",
      label: "Minimum source coverage",
      hint: "How much of the evidence has to have answered before a read counts. Below this the card stands you down rather than scoring a thin picture.",
      control: { kind: "number", min: RULE_LIMITS.coverageFloor[0], max: RULE_LIMITS.coverageFloor[1], step: 5, unit: "% answered" },
      keywords: ["evidence", "confluence", "decision", "sources", "setup card"],
      ...num(() => d.rules().coverageFloor, (n) => d.setRule({ coverageFloor: n })),
    },
    {
      id: "rules.stopMin",
      section: "rules",
      label: "Tightest sane stop",
      hint: "In ATR. Below this the stop is inside the instrument's ordinary noise and will be taken out by a move that means nothing.",
      control: { kind: "number", min: RULE_LIMITS.minStopAtr[0], max: RULE_LIMITS.minStopAtr[1], step: 0.1, unit: "× ATR" },
      keywords: ["atr", "volatility", "stop", "noise", "setup card"],
      ...num(() => d.rules().minStopAtr, (n) => d.setRule({ minStopAtr: n })),
    },
    {
      id: "rules.stopMax",
      section: "rules",
      label: "Widest sane stop",
      hint: "In ATR. Above this the position size that keeps your risk constant becomes too small to be worth taking.",
      control: { kind: "number", min: RULE_LIMITS.maxStopAtr[0], max: RULE_LIMITS.maxStopAtr[1], step: 0.5, unit: "× ATR" },
      keywords: ["atr", "volatility", "stop", "size", "setup card"],
      ...num(() => d.rules().maxStopAtr, (n) => d.setRule({ maxStopAtr: n })),
    },
    {
      id: "rules.reset",
      section: "rules",
      label: "Restore the defaults",
      hint: "Puts all seven back to the values the card shipped with.",
      control: { kind: "action", button: "Restore defaults" },
      keywords: ["default", "reset", "revert"],
      unavailable: () => (rulesAreDefault(d.rules()) ? "Already at the defaults." : null),
      read: () => "",
      write: () => d.resetRules(),
    },
    {
      id: "rules.note",
      section: "rules",
      label: "Any one failing stands you down",
      control: { kind: "note", tone: "info" },
      keywords: ["gate", "block", "override", "stand down"],
      read: () =>
        "There is deliberately no setting for “warn me but let me through”. A gate you can negotiate with stops being a gate on the day it matters, which is the day you most want to negotiate with it.",
    },

    // ------------------------------------------------------------ sources ---
    ...d.sources().map((src): SettingDef => ({
      id: `sources.${src.id}`,
      section: "sources",
      label: src.label,
      /* The hint carries what the row cannot: what it covers, how good the
         data is, and — separately from the user's own switch — whether the
         breaker has it parked right now. */
      hint: `${src.covers} · ${src.quality} · tried ${ordinal(src.priority)}${src.parked ? " · PARKED by the circuit breaker after repeated failures — it returns on its own" : ""}`,
      control: { kind: "toggle" },
      keywords: ["venue", "exchange", "feed", "provider", "failover", src.id],
      /* Read LIVE from the registry, not from the `src` row this def was built
         from. The row is a snapshot taken when the panel was constructed, so a
         switch that read from it flipped the source but left its own control
         showing the old state until Settings was closed and reopened. */
      read: () => String(d.sourceEnabled(src.id)),
      write: (v) => d.setSourceEnabled(src.id, v === "true"),
    })),
    {
      id: "sources.note",
      section: "sources",
      label: "Switching them all off leaves no chart",
      control: { kind: "note", tone: "warn" },
      keywords: ["failover", "order", "priority"],
      read: () =>
        "Sources are tried in the order above and the first one that answers wins, so a venue left on costs nothing until the ones before it fail. A symbol no enabled source covers will not load, and the reason is written into the attempt log rather than shown as an empty chart.",
    },

    // ------------------------------------------------------------ account ---
    {
      id: "account.currency",
      section: "account",
      label: "Account currency",
      hint: "Every money figure is shown in this. Conversions are labelled where the instrument quotes in something else.",
      control: { kind: "text", placeholder: "USD" },
      keywords: ["ccy", "denomination", "dollars"],
      read: () => a.account().currency,
      write: (v) => a.update({ currency: v }),
    },
    {
      id: "account.balance",
      section: "account",
      label: "Balance",
      hint: "Closed equity. Drives the daily-loss guard.",
      control: { kind: "number", min: 0 },
      keywords: ["calculator", "capital"],
      ...num(
        () => a.account().balance,
        (n) => a.update({ balance: n }),
      ),
    },
    {
      id: "account.equity",
      section: "account",
      label: "Equity",
      hint: "Balance plus open P&L. Drives free margin and EVERY lot size in the terminal.",
      control: { kind: "number", min: 0 },
      keywords: ["risk desk", "calculator", "capital", "size"],
      ...num(
        () => a.account().equity,
        (n) => a.update({ equity: n }),
      ),
    },
    {
      id: "account.leverage",
      section: "account",
      label: "Leverage",
      hint: "As your broker states it. Margin is computed per-instrument from the contract spec, never a flat multiplier.",
      control: { kind: "number", min: 1, step: 1 },
      keywords: ["margin", "gearing"],
      ...num(
        () => a.account().leverage,
        (n) => a.update({ leverage: n }),
      ),
    },
    {
      id: "account.riskPct",
      section: "account",
      label: "Risk per trade",
      hint: "Percent of equity. Yours to choose — nothing here suggests a number, and nothing enforces one.",
      control: { kind: "number", min: 0, step: 0.1, unit: "%" },
      keywords: ["r", "position size", "risk desk"],
      ...num(
        () => a.account().riskPct,
        (n) => a.update({ riskPct: n }),
      ),
    },
    {
      id: "account.oneSource",
      section: "account",
      label: "One source",
      control: { kind: "note", tone: "good" },
      keywords: ["duplicate", "drift", "calculator"],
      read: () =>
        "These five values used to be stored twice — once by the Risk desk and once by the Calculator — each with its own default. Changing one left the other sizing off a stale number with nothing on screen saying so. There is one copy now.",
    },

    // -------------------------------------------------------------- chart ---
    {
      id: "chart.timeframe",
      section: "chart",
      label: "Default timeframe",
      hint: "What a new window opens on.",
      control: { kind: "select", options: d.timeframes.map((t) => ({ value: t, label: t })) },
      keywords: ["interval", "period"],
      ...pick(d.defaultTimeframe),
    },
    {
      id: "chart.kind",
      section: "chart",
      label: "Default chart style",
      control: { kind: "select", options: options(d.chartKinds) },
      keywords: ["candles", "bars", "line", "area"],
      ...pick(d.chartKind),
    },
    {
      id: "chartlook.preview",
      section: "chartlook",
      label: "Preview",
      hint: "The same miniature as Appearance. The two candles in it carry the colours and the wick weight set below.",
      control: { kind: "preview" },
      keywords: ["preview", "sample", "candle", "look", "example"],
      read: () => lookSummary(d),
    },
    {
      id: "chart.sessions",
      section: "chartlook",
      label: "Session overlap shading",
      hint:
        "Shades the hours two trading centres are open at once — London into New York, Tokyo into London. The four session windows cover all 24 hours between them, so it marks the overlaps rather than the sessions. Intraday, and FX, metals and crypto only.",
      control: { kind: "toggle" },
      keywords: ["session", "tokyo", "london", "new york", "hours", "background", "shading", "overlap", "liquidity"],
      ...bool(d.sessionBands),
    },
    /**
     * OFF / LINES / DOTS, AND TWO OWNERS BEHIND ONE CONTROL.
     *
     * Whether there is a grid is `state.gridOn` in the shell — the signal the
     * chart engine has always read. What it is drawn AS is a token. This
     * writes both rather than keeping a third value of its own, which is why
     * switching the grid off from the chart toolbar leaves this control
     * reading "Off" with no disagreement to resolve.
     *
     * Dots mark the same price and time ticks the lines did, so a quieter
     * grid is still a grid you can read a level off.
     */
    {
      id: "chart.grid",
      section: "chartlook",
      label: "Grid",
      hint: "Horizontal rules at the price ticks and vertical ones at the time ticks, behind everything else. Dots mark the same intersections without the lines between them.",
      control: {
        kind: "select",
        options: [{ value: "off", label: "Off" }, ...knobOptions("grid")],
      },
      keywords: ["grid", "gridlines", "lines", "dots", "background", "guides", "rules", "mesh", "density"],
      read: () => (d.gridOn() ? look.grid() : "off"),
      write: (v) => {
        if (v === "off") {
          d.gridOn.set(false);
          return;
        }
        d.gridOn.set(true);
        look.grid.set(v);
      },
    },
    {
      id: "chart.candleUp",
      section: "chartlook",
      label: "Up candle",
      hint: "Bodies, wicks and the volume bars beneath them.",
      control: { kind: "colour" },
      keywords: ["candle", "colour", "color", "green", "bull", "rising", "up"],
      read: () => d.effectiveCandle("up"),
      write: (v) => d.candleUp.set(v),
    },
    {
      id: "chart.candleDown",
      section: "chartlook",
      label: "Down candle",
      control: { kind: "colour" },
      keywords: ["candle", "colour", "color", "red", "bear", "falling", "down"],
      read: () => d.effectiveCandle("down"),
      write: (v) => d.candleDown.set(v),
    },
    {
      id: "chart.candleReset",
      section: "chartlook",
      label: "Follow the theme again",
      hint:
        "Clears both overrides. Not a reset to green and red — it hands the colours back to whichever theme is selected, so they keep changing with it.",
      control: { kind: "action", button: "Clear overrides" },
      keywords: ["reset", "default", "theme", "candle", "colour", "color", "restore"],
      unavailable: () =>
        d.candleUp() === "" && d.candleDown() === "" ? "The candles already follow the theme." : null,
      read: () => "",
      write: () => {
        d.candleUp.set("");
        d.candleDown.set("");
      },
    },
    {
      id: "chart.wick",
      section: "chartlook",
      label: "Wick weight",
      hint: "One, one and a half, or two pixels. The body is untouched at every step — a heavier wick that also fattened the candle would be a different chart, not a heavier wick.",
      control: { kind: "select", options: knobOptions("wick") },
      keywords: ["wick", "shadow", "tail", "thickness", "weight", "line", "candle", "hairline"],
      ...pick(look.wick),
    },
    /**
     * FILLED VS HOLLOW IS ALREADY A CONTROL, AND IT IS NOT THIS ONE.
     *
     * The engine draws hollow candles as a chart KIND (`chart/engine.ts`,
     * "Candles, in three dialects"), because hollow is not a body style laid
     * over ordinary candles: it colours each bar against the PREVIOUS CLOSE
     * rather than against its own open. A second control here writing the
     * same signal would be the fourth thing in this terminal claiming to own
     * one fact. So this is a pointer, and it carries the words somebody would
     * have searched for.
     */
    {
      id: "chart.bodystyle",
      section: "chartlook",
      label: "Candle bodies",
      control: { kind: "note", tone: "info" },
      keywords: ["hollow", "filled", "body", "outline", "candle", "style", "heikin", "bars"],
      read: () =>
        "Filled or hollow is the chart STYLE, set in Chart defaults above or from the chart header's Chart-style menu. Hollow is not a coat of paint on ordinary candles — it colours each bar against the previous close instead of against its own open, which is two facts in one glyph — so it lives with the other styles rather than pretending to be a body setting.",
    },
    {
      id: "chart.volume",
      section: "chart",
      label: "Volume pane",
      hint: "The histogram under the price plot. Drag its top edge on the chart to resize it, or double-click that edge to reset.",
      control: { kind: "toggle" },
      keywords: ["histogram", "turnover", "bottom pane", "v"],
      ...bool(d.volumeOn),
    },
    {
      id: "chart.volumeHeight",
      section: "chart",
      label: "Volume pane height",
      hint: "In pixels. The chart clamps this against the window, so a value larger than the space available becomes the largest that fits.",
      control: { kind: "number", min: 24, max: 400, step: 4, unit: "px" },
      keywords: ["histogram", "size", "resize", "bottom pane"],
      unavailable: () => (d.volumeOn() ? null : "The volume pane is switched off."),
      ...num(d.volumeHeight, d.setVolumeHeight),
    },

    // ------------------------------------------------------------- alerts ---
    {
      id: "alerts.sound",
      section: "alerts",
      label: "Play a sound when an alert fires",
      control: { kind: "toggle" },
      keywords: ["tools", "audio", "beep", "chime"],
      ...bool(d.alertSound),
    },
    {
      id: "alerts.desktop",
      section: "alerts",
      label: "Desktop notifications",
      hint: "Requires permission from the browser. Denied permission is a browser setting, not one this terminal can override.",
      control: { kind: "toggle" },
      keywords: ["tools", "push", "system", "banner"],
      ...bool(d.alertDesktop),
    },
    {
      id: "alerts.log",
      section: "alerts",
      label: "Notification log",
      hint: "Everything that has fired this session, including what you dismissed.",
      control: { kind: "action", button: "Open the log" },
      keywords: ["history", "fired", "bell"],
      read: () => "",
      write: () => d.openNotificationLog(),
    },

    // --------------------------------------------------------------- data ---
    {
      id: "data.evidenceauto",
      section: "data",
      label: "Fetch the read's evidence automatically",
      /* The hint carries the measurement, because the default is on and a
         setting that costs requests has to justify itself where it is switched. */
      hint:
        "On a symbol change, load the regime model, the forecast, the derivatives block and the cross-venue spread without waiting for you to open their panels. Measured on a fresh chart with this off: 24% of the evidence answered, because most of it had never been asked. With it on: 56%. Deferred behind the chart, and the shared request budget still applies. Turn it off on a metered connection — the read will then say what it is actually standing on, which will be less.",
      control: { kind: "toggle" },
      keywords: ["coverage", "evidence", "regime", "forecast", "derivatives", "prefetch", "sources", "answered"],
      ...bool(d.evidenceAuto),
    },
    {
      id: "data.durability",
      section: "data",
      label: "Are settings being saved?",
      control: {
        kind: "note",
        tone:
          d.durability.state === "durable"
            ? "good"
            : d.durability.state === "unknown"
              ? "info"
              : "warn",
      },
      keywords: ["storage", "persist", "reset", "btcusdt", "forgets"],
      read: () => `${d.durability.note}${d.durability.remedy ? ` ${d.durability.remedy}` : ""}`,
    },
    {
      id: "data.feed",
      section: "data",
      label: "Current feed",
      control: { kind: "note" },
      keywords: ["source", "binance", "mt5", "proxy", "venue"],
      read: () => d.feedNote(),
    },
    {
      id: "data.size",
      section: "data",
      label: "Settings storage used",
      control: { kind: "note" },
      keywords: ["quota", "space", "bytes"],
      read: () => `${(d.storageBytes() / 1024).toFixed(1)} KB across this terminal's settings. Bar history is kept separately and is not counted here.`,
    },
    {
      id: "data.vault",
      section: "data",
      label: "Export a settings vault",
      hint: "One file: settings, alerts and layouts. Anything that looks like a credential is withheld and named, so the file is safe to send.",
      control: { kind: "action", button: "Export…" },
      keywords: ["backup", "data desk", "save", "transfer"],
      read: () => "",
      write: () => d.exportVault(),
    },
    {
      id: "data.governor",
      section: "data",
      label: "Reset the request governor",
      hint: "Clears rate-limit backoff and the response cache. Use after a venue has been rate-limiting you.",
      control: { kind: "action", button: "Reset" },
      keywords: ["429", "rate limit", "cache", "tools"],
      read: () => "",
      write: () => d.resetGovernor(),
    },

    // --------------------------------------------------------- appearance ---
    /**
     * THE PREVIEW LEADS THE SECTION.
     *
     * Every control below it re-points a token, and the one question each of
     * them is asked — "what will that do" — is answered by a picture and not
     * by a sentence. It is first rather than last because the alternative is
     * changing a setting, closing Settings to look, and opening it again.
     */
    {
      id: "appearance.preview",
      section: "appearance",
      label: "Preview",
      hint: "The terminal at these settings. It is drawn from the same tokens the real chrome reads, so it cannot show you something the terminal will not do.",
      control: { kind: "preview" },
      keywords: ["preview", "sample", "look", "example", "miniature"],
      read: () => lookSummary(d),
    },
    /**
     * LAYOUT PRESETS: ONE NAME FOR SEVEN DECISIONS.
     *
     * The current one is DERIVED from the live values rather than stored —
     * see presets.ts. There is no preset preference, so a preset can never
     * be a label describing a layout somebody has since changed by hand.
     */
    {
      id: "appearance.preset",
      section: "appearance",
      label: "Layout preset",
      hint:
        "Choosing one OVERWRITES all seven preferences it names, immediately and without asking. “Custom” is what the list says when your layout is not one of the three; choosing it changes nothing.",
      control: {
        kind: "select",
        options: [
          ...LAYOUT_PRESETS.map((p) => ({ value: p.id, label: p.label })),
          { value: CUSTOM, label: "Custom" },
        ],
      },
      keywords: ["preset", "layout", "focus", "analyst", "trader", "workspace", "arrangement", "default"],
      read: () => matchPreset(layoutNow()),
      write: (v) => applyPreset(v),
    },
    {
      id: "appearance.presetnote",
      section: "appearance",
      label: "What each preset writes",
      control: { kind: "note", tone: "info" },
      keywords: ["preset", "overwrite", "focus", "analyst", "trader"],
      read: () => {
        const missing = outOfReach();
        return (
          LAYOUT_PRESETS.map((p) => presetSummary(p)).join(" ") +
          (missing.length > 0
            ? ` This build cannot reach ${missing.join(", ")} from Settings, so a preset leaves ${missing.length === 1 ? "it" : "those"} exactly as ${missing.length === 1 ? "it is" : "they are"} — it does not pretend to have set ${missing.length === 1 ? "it" : "them"}.`
            : "")
        );
      },
    },
    {
      id: "appearance.theme",
      section: "appearance",
      label: "Theme",
      control: { kind: "select", options: options(d.themes) },
      keywords: ["dark", "light", "daylight", "colour", "color", "appearance popover"],
      ...pick(d.theme),
    },
    {
      id: "appearance.accent",
      section: "appearance",
      label: "Accent",
      hint: "The colour that marks where you are — the selected desk, the primary button, the entry zone. Never a market colour, so any accent works with any theme.",
      control: { kind: "select", options: options(d.accents) },
      keywords: ["accent", "brand", "colour", "color", "brass", "ice", "violet", "highlight"],
      ...pick(d.accent),
    },
    {
      id: "appearance.density",
      section: "appearance",
      label: "Density",
      hint: "Scales the whole terminal. Not browser zoom — page zoom would also scale the chart canvas, and every candle would soften.",
      control: { kind: "select", options: options(d.densities) },
      keywords: ["size", "compact", "comfortable", "scale", "zoom"],
      ...pick(d.density),
    },
    /**
     * THE TEXT-SIZE CONTROL THAT WAS ASKED FOR AND IS NOT HERE.
     *
     * `--ui-scale` is the whole of density: 0.92 / 1 / 1.09, feeding every
     * step of the type ramp. A second control writing the same token would be
     * two knobs on one number — you could set density to compact and text to
     * large and the terminal would have to pick one, or multiply them and
     * make both labels wrong. tokens.css says it in as many words: "it must
     * be ONE number, or half the app scales and the other half does not."
     * So this is a statement rather than a control, and it is in the section
     * where somebody will go looking for the control.
     */
    {
      id: "appearance.textsize",
      section: "appearance",
      label: "Text size",
      control: { kind: "note", tone: "info" },
      keywords: ["text", "font", "size", "bigger", "smaller", "scale", "zoom", "readable", "large"],
      read: () =>
        "Density above IS the text size — it scales the whole type ramp by one number. A separate text control would write the same token, so the two would disagree the first time they were set differently. If the terminal reads small, move density to comfortable; the chart canvas stays at device resolution either way, which browser zoom cannot promise.",
    },
    {
      id: "appearance.radius",
      section: "appearance",
      label: "Card corners",
      hint: "How rounded every card in the shell is — the chart, the inspector, the command row, the menus. Soft is what the terminal ships with.",
      control: { kind: "select", options: knobOptions("radius") },
      keywords: ["radius", "corners", "rounded", "square", "shape", "card"],
      ...pick(look.radius),
    },
    {
      id: "appearance.gutter",
      section: "appearance",
      label: "Gutter",
      hint: "The space between the cards. Standard leaves it to density (6, 10 or 12px), which is what it has always done; Tight and Airy overrule that and hold one width whatever the density.",
      control: { kind: "select", options: knobOptions("gutter") },
      keywords: ["gap", "spacing", "gutter", "padding", "air", "tight", "dense"],
      ...pick(look.gutter),
    },
    {
      id: "appearance.dock",
      section: "appearance",
      label: "Inspector width",
      hint: "288, 360 or 460 pixels. Dragging the inspector's edge still overrides this for the session — the splitter is the finer instrument and it wins.",
      control: { kind: "select", options: knobOptions("dock") },
      keywords: ["dock", "inspector", "panel", "right", "width", "narrow", "wide", "sidebar"],
      ...pick(look.dock),
    },
    {
      id: "appearance.livebar",
      section: "appearance",
      label: "Live bar height",
      hint: "26, 30 or 38 pixels. The news strip is declared to match it, so the two bands at the foot of the screen keep one rhythm rather than becoming a third height.",
      control: { kind: "select", options: knobOptions("livebar") },
      keywords: ["status", "live bar", "footer", "bottom", "height", "news", "strip", "prominent"],
      ...pick(look.liveBar),
    },
    /* The rail and the news strip are shell signals. They appear here only
       when the shell passes them in — a control wired to nothing is worse
       than an absent one, because it looks like it worked. */
    ...(d.watchRail
      ? [
          {
            id: "appearance.watchrail",
            section: "appearance",
            label: "Watchlist rail",
            hint: "The strip of symbols beside the chart. It is created when it is shown and destroyed when it is hidden, so switching it off stops its quote polling too.",
            control: { kind: "toggle" as const },
            keywords: ["rail", "watchlist", "symbols", "sidebar", "left", "sparkline"],
            ...bool(d.watchRail),
          },
        ]
      : []),
    ...(d.newsBar
      ? [
          {
            id: "appearance.newsbar",
            section: "appearance",
            label: "News strip",
            hint: "The headline row above the live bar.",
            control: { kind: "toggle" as const },
            keywords: ["news", "headlines", "rss", "ticker", "strip", "bar"],
            ...bool(d.newsBar),
          },
        ]
      : []),

    // ----------------------------------------------------------- keyboard ---
    {
      id: "keyboard.sheet",
      section: "keyboard",
      label: "Keyboard shortcuts",
      hint: "Generated from the live keymap, so it can never drift from what the keys actually do.",
      control: { kind: "action", button: "Show all shortcuts" },
      keywords: ["shortcuts", "keys", "bindings", "accelerators"],
      read: () => "",
      write: () => d.openKeyboardSheet(),
    },
    {
      id: "keyboard.rebind",
      section: "keyboard",
      label: "Rebinding",
      control: { kind: "note", tone: "info" },
      keywords: ["custom", "remap", "change keys"],
      read: () =>
        "Not built yet. The sheet above is read-only, so a trader whose muscle memory comes from another terminal has to relearn rather than remap. It is the next thing planned for this section.",
    },

    // ------------------------------------------------------------ privacy ---
    {
      id: "privacy.execution",
      section: "privacy",
      label: "This terminal cannot place a trade",
      control: { kind: "note", tone: "good" },
      keywords: ["order", "execute", "auto", "trade", "broker"],
      read: () =>
        "There is no order, position, wallet or credential tool anywhere in it — by construction, and pinned by a test that fails if one is ever added. It is decision support; you place trades yourself.",
    },
    {
      id: "privacy.credentials",
      section: "privacy",
      label: "Broker credentials are never touched",
      control: { kind: "note", tone: "good" },
      keywords: ["mt5", "password", "login", "keys", "secret"],
      read: () =>
        "The MT5 bridge reads bars and contract specs from a terminal you are already logged into. Nothing here asks for, stores or transmits a broker password.",
    },
    {
      id: "privacy.data",
      section: "privacy",
      label: "What leaves this machine",
      control: { kind: "note" },
      keywords: ["telemetry", "analytics", "tracking", "network", "privacy"],
      read: () =>
        "Price requests to the venues you enabled, and — only if you configure one — questions you send to an AI provider. There is no telemetry and no analytics of any kind.",
    },
    {
      id: "privacy.fabrication",
      section: "privacy",
      label: "Missing data is never filled in",
      control: { kind: "note", tone: "good" },
      keywords: ["fake", "synthetic", "gap", "honest", "estimate"],
      read: () =>
        "A source that does not cover an instrument leaves a named gap. The terminal will show you less rather than invent a number you might trade on.",
    },

    // -------------------------------------------------------------- about ---
    {
      id: "about.version",
      section: "about",
      label: "Version",
      control: { kind: "note" },
      keywords: ["build", "release"],
      read: () => d.version,
    },
    {
      id: "about.overfitting",
      section: "about",
      label: "A standing warning about the scores",
      control: { kind: "note", tone: "warn" },
      keywords: ["pbo", "overfit", "backtest", "confluence", "score"],
      read: () =>
        "PBO 89%: the best in-sample configuration lands below the median out of sample roughly nine times in ten. Treat the confluence score and the Decision desk as a prompt to look, never as a reason to trade, and do not automate anything off either.",
    },

    /* Generated from the registries rather than written out, so they cannot
       disagree with the code that actually runs the indicators. */
    ...indicatorDefs(d),
    ...driverDefs(d),
  ];
}
