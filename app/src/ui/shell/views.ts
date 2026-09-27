import type { ChartKind } from "../../chart/engine";

/**
 * The desks, the ladders and the palettes the shell offers.
 *
 * Lifted out of `shell.ts` unchanged. `mountShell` was a single 7,476-line
 * function and the file around it had become the place anything shell-shaped
 * landed; these had no dependency on that closure at all, which is what made
 * them safe to move first and is the test for whatever moves next.
 */

/** The accent choices (tokens.css, "ACCENT, chosen independently"). */
export const ACCENTS = ["theme", "brass", "ice", "violet"] as const;
export type AccentName = (typeof ACCENTS)[number];

export const THEMES = ["iram", "ink", "daylight", "classic", "institutional", "binance", "tradingview"] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * The timeframe ladder.
 *
 * `3m`, `1w` and `1M` were missing. The first two cost nothing — every venue
 * the terminal talks to serves them and `intervalMs` already handled them —
 * but `1M` needed two fixes before it could be offered at all: `intervalMs`
 * returned ONE HOUR for it (`endsWith("m")` is case-sensitive, so a monthly
 * bar fell through every branch to the default), which drives the archive's
 * contiguity test; and the countdown added a fixed span to the bar's open,
 * which a calendar month is not. See `nextCloseAt` in ui/countdown.ts.
 */
export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const;

/**
 * Display density.
 *
 * One number scales the whole type ramp (`--ui-scale` in tokens.css). A 27"
 * desk monitor and a 13" laptop are not the same instrument, and the alternative
 * — everyone using the browser's page zoom — also scales the chart canvas, which
 * is the one thing that must stay at device resolution.
 */
export const DENSITIES = ["compact", "standard", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

export const MA_SET = [
  { id: "ema20", period: 20, token: "--ma-fast" },
  { id: "ema50", period: 50, token: "--ma-mid" },
  { id: "ema200", period: 200, token: "--ma-slow" },
] as const;

/**
 * The desks, in the order they appear in the command bar.
 *
 * `chart` carries a `scoped` flag meaning "this desk is about the symbol and
 * timeframe in the context bar". Desks without it — the book, the archive, the
 * conversation — are not looking at one instrument, and showing them a symbol
 * box that does nothing is a control that lies about what it controls.
 */
/**
 * The desks, grouped into the five WORKSPACES of v59 — human and AI together.
 *
 * Each workspace is one kind of work, and each has its own balance between
 * what the terminal does and what the operator decides, stated in
 * `WORKSPACE_LEAD` and shown on the workspace's tab:
 *
 *   Today     — AI briefs · you plan      Briefing, Opportunities, Watchlist
 *   Chart     — AI-led                    the chart and every desk that reads it
 *   Research  — you steer · AI assists    Analyse, Quant, Knowledge, Conditions, Data
 *   Strategy  — built together            Strategy, Playbook, Signals
 *   Review    — AI finds · you judge      Journal (with MT5 fills), Learning
 *
 * Clicking a workspace goes to the desk last used in it (the first desk until
 * then) — see `ui/deskbar.ts`. Ids, icons, hints and `scoped` are unchanged,
 * so saved layouts, `view.*` commands and shortcuts keep working.
 */
export const VIEWS = [
  /* Today — AI briefs · you plan. */
  { id: "briefing", group: "Today", label: "Briefing", icon: "briefing", scoped: true, hint: "Where you stand, what changed, and what to look at" },
  { id: "screener", group: "Today", label: "Opportunities", icon: "screener", scoped: false, hint: "Scan the universe for setups with entry, stop, targets and a track record" },
  { id: "watchlist", group: "Today", label: "Watchlist", icon: "watchlist", scoped: false, hint: "Your list, and the market heatmap" },

  /* Chart — AI-led. */
  { id: "chart", group: "Chart", label: "Chart", icon: "chart", scoped: true, hint: "Price, structure and drawings" },
  { id: "decision", group: "Chart", label: "Decision", icon: "decision", scoped: true, hint: "Every source, weighed, with its coverage" },
  { id: "smart", group: "Chart", label: "Smart money", icon: "smart", scoped: true, hint: "Structure, gaps and order blocks, listed" },
  { id: "flow", group: "Chart", label: "Flow", icon: "flow", scoped: true, hint: "Liquidations, open interest and funding" },
  { id: "sessions", group: "Chart", label: "Sessions", icon: "sessions", scoped: true, hint: "What is open, and when this symbol moves" },
  { id: "risk", group: "Chart", label: "Risk", icon: "risk", scoped: false, hint: "Sizing, the book, portfolio risk and hedging" },
  { id: "calculator", group: "Chart", label: "Calculator", icon: "calculator", scoped: false, hint: "Lots, pips, margin and cost-adjusted P&L" },
  { id: "paper", group: "Chart", label: "Paper", icon: "paper", scoped: true, hint: "Practice fills against the live feed" },
  { id: "agent", group: "Chart", label: "Analyst", icon: "analyst", scoped: false, hint: "Ask about what is on screen" },
  { id: "workspace", group: "Chart", label: "Workspace", icon: "workspace", scoped: false, hint: "Layouts, panes and linked symbols" },

  /* Research — you steer · AI assists. */
  { id: "study", group: "Research", label: "Analyse", icon: "study", scoped: true, hint: "Pick an asset, pick what it is measured against, pick how much history, and measure it" },
  { id: "quant", group: "Research", label: "Quant", icon: "quant", scoped: true, hint: "GARCH, causal inference and calibrated probabilities" },
  { id: "knowledge", group: "Research", label: "Knowledge", icon: "learn", scoped: false, hint: "What replaying history has measured, sliced by the conditions it happened in" },
  { id: "survey", group: "Research", label: "Conditions", icon: "survey", scoped: false, hint: "Which style works in which market condition, across markets" },
  { id: "connections", group: "Research", label: "Connections", icon: "channel", scoped: false, hint: "Which markets move together, and whether that is still holding" },
  { id: "data", group: "Research", label: "Data", icon: "data", scoped: false, hint: "The local archive and what is in it" },

  /* Strategy — built together. */
  { id: "strategy", group: "Strategy", label: "Strategy", icon: "strategy", scoped: true, hint: "Sweep, walk-forward and overfitting" },
  { id: "playbook", group: "Strategy", label: "Playbook", icon: "playbook", scoped: true, hint: "Rule sets you can read, edit and test" },
  { id: "signals", group: "Strategy", label: "Signals", icon: "signals", scoped: true, hint: "Alerts and what has fired" },
  /* v62.6. Scoped: it opens on the market the chart is showing when it has
     studied one, which is a default and not a lock — you can pick any of
     them. `scoped: false` would hide the symbol box on a desk whose whole
     content is per-market. */
  { id: "simulation", group: "Strategy", label: "Simulation", icon: "strategy", scoped: true, hint: "What the terminal studied on its own, and what it would have done to a real balance" },

  /* Review — AI finds · you judge. */
  { id: "journal", group: "Review", label: "Journal", icon: "playbook", scoped: true, hint: "What you actually did, and what it measured" },
  { id: "learn", group: "Review", label: "Learning", icon: "learn", scoped: false, hint: "What it claimed, what happened, and what it keeps" },
  /* System belongs in Review, not Research: "what did this machine do" sits
     beside "what did I do" and "what did it learn". It lived inside Research
     ▸ Data for two releases, which is why nobody could find it. */
  { id: "system", group: "Review", label: "System", icon: "data", scoped: false, hint: "Stored history, downloads, the jobs that run with the terminal closed, and what an AI client may read" },
] as const;

/** Who leads in each workspace — shown under the name on its tab. */
export const WORKSPACE_LEAD: Readonly<Record<string, string>> = {
  Today: "AI briefs · you plan",
  Chart: "AI-led",
  Research: "you steer",
  Strategy: "together",
  Review: "AI finds · you judge",
};

/** Desks that the context bar (symbol, timeframe, chart style) applies to. */
export const SCOPED_VIEWS: ReadonlySet<string> = new Set(VIEWS.filter((v) => v.scoped).map((v) => v.id));


/**
 * The chart styles offered in the toolbar.
 *
 * The hints matter more than usual here. "Candles", "Bars", "Line" and "Area"
 * are self-describing; "Hollow" and "Heikin" are not, and one of them changes
 * what the numbers on screen MEAN. A style that silently replaces price with an
 * average needs to say so where it is chosen, not in a manual.
 */
export const CHART_STYLES: readonly {
  readonly id: ChartKind;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: "candles", label: "Candles", hint: "Body coloured by close against open." },
  {
    id: "hollow",
    label: "Hollow",
    hint:
      "Body outlined when the bar closed above its own open, filled when below — and coloured against the PREVIOUS close. Two facts per candle: whether the bar rose, and whether it rose from where the last one left off.",
  },
  {
    id: "heikin",
    label: "Heikin",
    hint:
      "Heikin-Ashi: each bar averaged with the one before it, so a trend reads as an unbroken run of one colour. Every value is an average — NOT a price anything traded at. The legend, crosshair and levels keep reporting the real series.",
  },
  { id: "bars", label: "Bars", hint: "OHLC bars: open left tick, close right tick." },
  { id: "line", label: "Line", hint: "Closes only." },
  { id: "area", label: "Area", hint: "Closes only, filled to the axis." },
];


/**
 * Timeframes on which a session band means anything.
 *
 * A bar must sit INSIDE one session for the tint to be true of it. At 4h a bar
 * still does (the windows are 9 hours); at 1d it spans all four at once, and
 * the band would be a statement about the open rather than about the bar.
 */
export const SESSION_TIMEFRAMES: ReadonlySet<string> = new Set(["1m", "3m", "5m", "15m", "1h", "4h"]);

/**
 * The wash a session band is painted in.
 *
 * Read from the live theme rather than hardcoded, so it follows the five
 * themes like everything else — and deliberately very low alpha: this sits
 * BEHIND price and its job is to be noticed only when looked for. A background
 * that competes with the candles has failed regardless of how informative it is.
 */
export function sessionWash(): string {
  const s = getComputedStyle(document.documentElement);
  const raw = s.getPropertyValue("--session-wash").trim();
  return raw || "rgba(255, 255, 255, 0.022)";
}
