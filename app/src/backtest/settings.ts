/**
 * HOW A BACKTEST WAS CONFIGURED — one owner, so it can be shown and changed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The engine's knobs live in five places. `BacktestOptions` holds nine,
 * `StudyOptions` extends it, `promote.ts` keeps the promotion gate as three
 * module constants, `DEFAULT_COSTS` is a fourth, and the walk-forward window
 * shape is passed argument-by-argument at each call site. CLAUDE.md already
 * records what that costs: eight places charged `DEFAULT_COSTS`, four of them
 * deciding something, and the count had to be replaced by a LIST because it
 * was wrong every time it was quoted.
 *
 * The consequence on screen was that nothing could offer those knobs to the
 * operator, because there was no object to offer. A control surface needs a
 * value to bind to.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not change the engine's signatures. `toBacktestOptions` PRODUCES the
 * existing option types, so this is a reversible addition rather than a
 * rewrite of nine call sites — and `runsettings.test.ts` opens by asserting
 * that the standard settings project onto exactly what the engine already
 * does. A settings refactor that quietly re-prices every backtest would move
 * every verdict on the board for a reason nobody chose.
 *
 * It also holds no defaults of its own where another module owns them. The
 * promotion gate's three thresholds are IMPORTED from `promote.ts`; the costs
 * are `DEFAULT_COSTS`. Three hand-written copies of one value have caused
 * three defects in this repository, and the rule that came out of it is to
 * derive rather than restate.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FLATTERY IS A FIRST-CLASS FIELD
 *
 * Several of these knobs make results look better rather than truer: entering
 * at the signal bar's close is a price that did not exist yet, charging no
 * costs manufactures edges that were never tradeable, and switching off the
 * search charge lowers the bar every survivor had to clear. They are all
 * offered, because the fastest way to learn what a check protects you from is
 * to turn it off and watch every number improve.
 *
 * `flatteryIn` is what keeps that honest: it reads a configuration and returns
 * the ways it flatters, in the operator's words. A result carrying a non-empty
 * list is a result that has to say so wherever it is shown.
 */

import { DEFAULT_COSTS, type BacktestOptions, type Costs } from "./engine";
import { MAX_PBO, MIN_OOS_TRADES, MIN_RETENTION, type PromotionBar } from "./promote";

/* ----------------------------------------------------------- the shape -- */

/**
 * Where a trade is assumed to fill.
 *
 * `signal-close` is the defect this product fixed once already: the signal bar
 * closed at that price, so trading it is trading information you did not have.
 * Kept because seeing the inflation is worth more than hiding the option.
 */
export type EntryAt = "next-open" | "signal-close";

/**
 * Which cost model to charge.
 *
 *   standard  the published assumption, `DEFAULT_COSTS`
 *   measured  your broker's real figures, falling back to the assumption for
 *             anything it was not told — and saying which it used
 *   none      nothing at all. Flattery, and named as such
 *   worst     double the assumption. NOT the safe direction: overcharging
 *             discards rules that would have cleared the real spread
 */
export type CostModel = "standard" | "measured" | "none" | "worst";

export interface RunSettings {
  readonly fills: {
    readonly entry: EntryAt;
    /** Extra adverse fill as a fraction of price, on entry and on exit. */
    readonly slippage: number;
    /**
     * Settle stop-versus-target from minute bars where they cover the bar.
     *
     * Off keeps the pessimistic assumption everywhere, which understates edge
     * rather than inventing it — so turning it off is not flattery.
     */
    readonly settleFromMinutes: boolean;
  };
  readonly costs: {
    readonly model: CostModel;
    /** Only read when the model is `measured`. Anything absent stays assumed. */
    readonly override?: Partial<Costs>;
  };
  readonly bar: {
    /** Fewest out-of-sample trades before a result is allowed to mean anything. */
    readonly minTrades: number;
    /** Overfitting-probability ceiling. */
    readonly maxPbo: number;
    /** How much of the in-sample edge must survive out of sample. */
    readonly minRetention: number;
    /**
     * Charge the winner for the width of the search.
     *
     * The best of N tries beats the market on luck alone, so the hurdle rises
     * with the field. Off, every number improves and means less.
     */
    readonly chargeForSearch: boolean;
  };
  readonly risk: {
    /** Fraction of equity risked per trade. */
    readonly perTrade: number;
  };
  readonly data: {
    /** Below this archive coverage the run is refused outright. */
    readonly minCoverage: number;
    readonly allowDemo: boolean;
  };
  readonly windows: {
    readonly count: number;
    readonly trainBars: number;
    readonly testBars: number;
    /** Bars dropped between training and testing, so the split cannot leak. */
    readonly purgeBars: number;
  };
}

/* --------------------------------------------------------- the standard -- */

/**
 * EXACTLY WHAT THE ENGINE DOES TODAY. Every number is the engine's own
 * fallback or another module's constant, never a figure chosen here.
 */
export const STANDARD: RunSettings = {
  fills: {
    entry: "next-open",
    slippage: DEFAULT_COSTS.slippage,
    settleFromMinutes: true,
  },
  costs: { model: "standard" },
  bar: {
    minTrades: MIN_OOS_TRADES,
    maxPbo: MAX_PBO,
    minRetention: MIN_RETENTION,
    chargeForSearch: true,
  },
  /* `engine.ts`: `opts.riskPerTrade ?? 0.01`. */
  risk: { perTrade: 0.01 },
  /* `engine.ts`: `opts.minCoverage ?? 0.98`. */
  data: { minCoverage: 0.98, allowDemo: false },
  /* Six windows of nine months fitted and three scored, with a five-bar purge
     — the shape `validate.ts` is called with across the product today. */
  windows: { count: 6, trainBars: 6480, testBars: 2160, purgeBars: 5 },
};

/* ------------------------------------------------------------- presets -- */

export interface Preset {
  readonly id: string;
  readonly name: string;
  /** What it is for, in one line. */
  readonly note: string;
  /** DERIVED from the settings, never declared. See `flatteryIn`. */
  readonly honest: boolean;
  readonly settings: RunSettings;
}

const preset = (id: string, name: string, note: string, settings: RunSettings): Preset => ({
  id,
  name,
  note,
  /* A preset cannot claim to be honest while setting something that flatters:
     the flag is read off the settings every time this list is built. */
  honest: flatteryIn(settings).length === 0,
  settings,
});

export const PRESETS: readonly Preset[] = [
  preset("standard", "Standard", "What the engine has always done. The one to compare against.", STANDARD),
  preset("quick", "Quick look", "One window, no search charge. For a first glance, not a verdict.", {
    ...STANDARD,
    bar: { ...STANDARD.bar, chargeForSearch: false, minTrades: 10 },
    windows: { ...STANDARD.windows, count: 1 },
  }),
  preset("strict", "Strict", "Enough trades to argue with, and most windows must hold.", {
    ...STANDARD,
    bar: { ...STANDARD.bar, minTrades: 120, maxPbo: 0.35, minRetention: 0.5 },
  }),
  preset("paranoid", "Paranoid", "Worst-case costs, and almost nothing gets through.", {
    ...STANDARD,
    costs: { model: "worst" },
    bar: { ...STANDARD.bar, minTrades: 200, maxPbo: 0.25, minRetention: 0.6 },
    windows: { ...STANDARD.windows, count: 8 },
  }),
  preset("mine", "My broker", "The standard checks, charged what you are actually charged.", {
    ...STANDARD,
    costs: { model: "measured" },
  }),
  preset("lie", "Show me the lie", "Every protection off, so you can see what they were protecting you from.", {
    ...STANDARD,
    fills: { ...STANDARD.fills, entry: "signal-close" },
    costs: { model: "none" },
    bar: { ...STANDARD.bar, chargeForSearch: false, minTrades: 1, maxPbo: 1, minRetention: 0 },
  }),
];

/** The preset with this id, or nothing. Never a guess at the nearest one. */
export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/* ------------------------------------------------- what it admits to -- */

/**
 * The ways this configuration flatters, in the operator's words.
 *
 * Empty means the result stands on its own. Anything in it has to appear
 * wherever the result does: a figure produced with the costs switched off is
 * not a worse version of a real figure, it is a different quantity.
 */
export function flatteryIn(s: RunSettings): readonly string[] {
  const out: string[] = [];
  if (s.fills.entry === "signal-close") {
    out.push("Trades fill at the close of the bar that signalled them — a price that did not exist yet. This is look-ahead.");
  }
  if (s.costs.model === "none") {
    out.push("No spread, commission or financing is charged, so edges that were never tradeable survive.");
  }
  if (!s.bar.chargeForSearch) {
    out.push("The winner is not charged for the width of the search, so the best of many tries looks like skill.");
  }
  return out;
}

/* ---------------------------------------------- onto the engine's types -- */

/** Double the assumption. Offered, and never the safe direction. */
const WORST: Costs = {
  spread: DEFAULT_COSTS.spread * 2,
  commission: DEFAULT_COSTS.commission * 2,
  slippage: DEFAULT_COSTS.slippage * 2,
  carryPerNight: DEFAULT_COSTS.carryPerNight * 2,
};

const FREE: Costs = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };

/**
 * The costs this configuration charges, given what the broker actually said.
 *
 * `measured` WITH NOTHING MEASURED FALLS BACK AND IS STILL HONEST. The rule
 * this repository states is that the measured figure must not silently replace
 * the assumption — a number that moves under the operator because a service
 * answered is worse than a disagreement they can see. So a missing field keeps
 * the assumption rather than a zero, which would be the most flattering
 * possible reading of "we could not ask".
 */
export function costsFor(s: RunSettings, measured?: Partial<Costs>): Costs {
  if (s.costs.model === "none") return FREE;
  if (s.costs.model === "worst") return WORST;
  if (s.costs.model === "standard") return { ...DEFAULT_COSTS };
  const said = { ...s.costs.override, ...measured };
  return {
    spread: said.spread ?? DEFAULT_COSTS.spread,
    commission: said.commission ?? DEFAULT_COSTS.commission,
    slippage: said.slippage ?? DEFAULT_COSTS.slippage,
    carryPerNight: said.carryPerNight ?? DEFAULT_COSTS.carryPerNight,
  };
}

/**
 * This configuration as the promotion gate's bar.
 *
 * The gate keeps its three published thresholds and `STANDARD` copies them, so
 * `barOf(STANDARD)` IS `STANDARD_BAR` — asserted, because a projection that
 * quietly differed from the gate's own default would re-decide every strategy
 * on the shelf for a reason nobody chose.
 *
 * `chargeForSearch` is deliberately NOT here. It belongs to the best-of-N
 * hurdle in `study/stats.ts`, which is a different question from the promotion
 * gate: one asks whether the winner beat what luck would have scored over the
 * field, the other whether this strategy held up out of sample at all. Folding
 * them into one object would invite a caller to switch off the wrong one.
 */
export function barOf(s: RunSettings): PromotionBar {
  return { minTrades: s.bar.minTrades, maxPbo: s.bar.maxPbo, minRetention: s.bar.minRetention };
}

/**
 * This configuration as the engine's own options.
 *
 * Only the fields the engine reads. `macro`, `minutes` and `barIntervalMs` are
 * supplied per run by the caller that loaded the bars — settings cannot know
 * them, and inventing an empty value for them would turn "nothing was loaded"
 * into "nothing exists".
 */
export function toBacktestOptions(s: RunSettings, measured?: Partial<Costs>): BacktestOptions {
  return {
    costs: costsFor(s, measured),
    riskPerTrade: s.risk.perTrade,
    minCoverage: s.data.minCoverage,
    allowDemo: s.data.allowDemo,
  };
}

/* ------------------------------------------------------- what changed -- */

export interface SettingChange {
  /** Which group it sits in, so a diff can be read beside the controls. */
  readonly group: keyof RunSettings;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Every field, flat, with the words a person reads.
 *
 * ONE LIST, so `changesFrom` cannot miss a group. A diff that silently skips a
 * knob is how a result ends up described by settings it was not run with —
 * which defeats the only reason to record settings at all.
 */
const FIELDS: ReadonlyArray<{
  group: keyof RunSettings;
  label: string;
  read: (s: RunSettings) => string;
}> = [
  { group: "fills", label: "Enter at", read: (s) => (s.fills.entry === "next-open" ? "next bar's open" : "signal's close") },
  { group: "fills", label: "Slippage", read: (s) => `${(s.fills.slippage * 10000).toFixed(2)} bp` },
  { group: "fills", label: "Settle from minutes", read: (s) => (s.fills.settleFromMinutes ? "yes" : "no") },
  { group: "costs", label: "Costs", read: (s) => s.costs.model },
  { group: "bar", label: "Fewest trades to judge", read: (s) => String(s.bar.minTrades) },
  { group: "bar", label: "Overfit risk ceiling", read: (s) => `${Math.round(s.bar.maxPbo * 100)}%` },
  { group: "bar", label: "Edge that must survive", read: (s) => `${Math.round(s.bar.minRetention * 100)}%` },
  { group: "bar", label: "Charge for the search", read: (s) => (s.bar.chargeForSearch ? "yes" : "no") },
  { group: "risk", label: "Risk each trade", read: (s) => `${(s.risk.perTrade * 100).toFixed(2)}%` },
  { group: "data", label: "Least coverage accepted", read: (s) => `${Math.round(s.data.minCoverage * 100)}%` },
  { group: "data", label: "Allow generated bars", read: (s) => (s.data.allowDemo ? "yes" : "no") },
  { group: "windows", label: "Windows", read: (s) => String(s.windows.count) },
  { group: "windows", label: "Fit on", read: (s) => `${s.windows.trainBars} bars` },
  { group: "windows", label: "Score on", read: (s) => `${s.windows.testBars} bars` },
  { group: "windows", label: "Gap between", read: (s) => `${s.windows.purgeBars} bars` },
];

/** What is different about `s`, compared with `base`. Empty when nothing is. */
export function changesFrom(base: RunSettings, s: RunSettings): readonly SettingChange[] {
  const out: SettingChange[] = [];
  for (const f of FIELDS) {
    const from = f.read(base);
    const to = f.read(s);
    if (from !== to) out.push({ group: f.group, label: f.label, from, to });
  }
  return out;
}

/** Every field and its value, for a result's receipt. */
export function describeSettings(s: RunSettings): ReadonlyArray<{ label: string; value: string }> {
  return FIELDS.map((f) => ({ label: f.label, value: f.read(s) }));
}
