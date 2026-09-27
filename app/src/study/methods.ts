/**
 * The method catalogue: what can be done with the bars, and what each costs.
 *
 * WHY A CATALOGUE AND NOT A SET OF BUTTONS ON SIX DESKS
 * Every method here already exists in this codebase and is already reachable —
 * the sweep is on the Strategy desk, GARCH is on Quant, the regime split is
 * inside the lab, the correlation matrix is in the risk desk. What none of
 * them can do is be pointed at a set of series and a window the operator
 * chose, run together, and be corrected for the fact that they were all tried.
 *
 * Running eleven tests and reporting the best one is not eleven pieces of
 * evidence; it is one piece of evidence and ten chances. A catalogue makes the
 * count visible, which is the only thing that makes the correction possible.
 *
 * EVERY CARD CARRIES ITS OWN REFUSAL
 * `availability` returns the reason, in the operator's words, naming the
 * library or the missing column. A greyed card that does not say why is a
 * fault report addressed to nobody.
 */

import type { QuantHealth } from "../data/quant";

export type MethodGroup = "relationship" | "regime" | "probability" | "strategy";

export const GROUP_LABEL: Readonly<Record<MethodGroup, string>> = {
  relationship: "Relationships",
  regime: "Regime",
  probability: "Probability",
  strategy: "Strategy",
};

export const GROUP_BLURB: Readonly<Record<MethodGroup, string>> = {
  relationship: "Does anything you added move before, with, or against the subject.",
  regime: "What condition the market was in, and whether that changes the answer.",
  probability: "What happens next, as odds with an error bar rather than a direction.",
  strategy: "Rules, swept and walked forward, with the overfitting measured rather than hoped away.",
};

export interface Method {
  readonly id: string;
  readonly group: MethodGroup;
  readonly label: string;
  /** What it answers, in one sentence. */
  readonly blurb: string;
  /** What it produces that you can act on, or decline to act on. */
  readonly produces: string;
  /**
   * How many distinct hypotheses this method tests.
   *
   * A function of the shape of the study, not a constant: lead–lag at 97 lags
   * against four drivers is 388 tests, and the correction has to know that.
   * This is the number, summed across methods, that decides how harsh the
   * correction is — see `plan.ts`.
   */
  tests(ctx: MethodContext): number;
  /** Back-end library that must be present, or null for a local computation. */
  readonly library: string | null;
  /** Feature columns it needs. */
  readonly needsColumns: number;
  /** Driver-role columns specifically — a lead-lag needs something that leads. */
  readonly needsDrivers: number;
  /** Aligned rows below which it declines rather than answering thinly. */
  readonly minRows: number;
  /** Method ids whose output this one consumes. */
  readonly reads: readonly string[];
  /**
   * A first guess at what it costs, in milliseconds per thousand aligned rows.
   *
   * DECLARED, NOT MEASURED. The plan prefers a real timing from the last run
   * of this method on this machine whenever one exists, and says which of the
   * two it is using. A guess presented as a measurement is the thing this
   * codebase spends most of its comments arguing against, so it is not
   * presented as one.
   */
  readonly guessMsPerKRow: number;
  readonly guessFixedMs: number;
}

export interface MethodContext {
  /**
   * Whether any bars have been fetched for this study yet.
   *
   * `rows: 0` is ambiguous on its own and the ambiguity reached the screen:
   * every card read "the joint window holds 0" before anything had been
   * fetched, which states that a window was computed and found empty. Nothing
   * had been measured. Zero is a measurement; "not checked" is not.
   */
  readonly checked: boolean;
  readonly rows: number;
  readonly featureColumns: number;
  readonly driverColumns: number;
  readonly sliceSeries: number;
  /**
   * The service's own report of what it has, or null when it has not answered.
   * Null is "unknown", not "missing", and the two produce different sentences.
   */
  readonly health: QuantHealth | null;
}

/**
 * How many lags a cross-correlation searches, each way.
 *
 * Forty-eight. At an hourly bar that is two days in each direction, which
 * covers every lead worth calling a lead — anything slower is a regime, not a
 * lag. It is also 97 hypotheses per driver, and that is the real cost of
 * setting it higher: the correction gets harsher for every one of them.
 */
export const MAX_LAG = 48;

export const METHODS: readonly Method[] = [
  /* ── Relationships ──────────────────────────────────────────────────── */
  {
    id: "leadlag",
    group: "relationship",
    label: "Lead and lag",
    blurb: "Cross-correlation of each driver against the subject at every lag, with the band below which a bar is indistinguishable from noise.",
    produces: "Which series moved first, by how many bars, and whether the lead is larger than the noise band.",
    tests: (c) => (2 * MAX_LAG + 1) * Math.max(0, c.driverColumns),
    library: null,
    needsColumns: 1,
    needsDrivers: 1,
    minRows: 400,
    reads: [],
    guessMsPerKRow: 4,
    guessFixedMs: 5,
  },
  {
    id: "corrmatrix",
    group: "relationship",
    label: "Correlation matrix",
    blurb: "Every pair in the study, on aligned returns over the joint window, with the overlap each figure rests on.",
    produces: "Which of the series you added are actually the same series, and how much of the study's evidence is therefore double-counted.",
    tests: (c) => {
      const n = c.featureColumns + 1;
      return (n * (n - 1)) / 2;
    },
    library: null,
    needsColumns: 1,
    needsDrivers: 0,
    minRows: 60,
    reads: [],
    guessMsPerKRow: 2,
    guessFixedMs: 2,
  },
  {
    id: "stationarity",
    group: "relationship",
    label: "Stationarity",
    blurb: "ADF and KPSS on the subject's series — whether a level-based relationship is even allowed to be fitted.",
    produces: "Whether the series mean-reverts, wanders, or cannot be told apart from a random walk over this window.",
    tests: () => 2,
    library: "statsmodels",
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 250,
    reads: [],
    guessMsPerKRow: 6,
    guessFixedMs: 120,
  },
  {
    id: "crossasset",
    group: "relationship",
    label: "Cross-asset panel",
    blurb: "Fit the subject's forward return on the drivers, purged and walked forward, against a baseline of its own return alone.",
    produces: "Whether the drivers add anything over what the subject's own history already said.",
    tests: () => 1,
    library: "sklearn",
    needsColumns: 2,
    needsDrivers: 1,
    minRows: 500,
    reads: [],
    guessMsPerKRow: 30,
    guessFixedMs: 400,
  },

  /* ── Regime ─────────────────────────────────────────────────────────── */
  {
    id: "regimes",
    group: "regime",
    label: "Market condition",
    blurb: "Label every bar trend, chop or volatile from ADX and the volatility percentile, and count how much of the window each one covers.",
    produces: "The slices every other result in this study is reported in — and a warning when one of them is too thin to report at all.",
    tests: () => 3,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 300,
    reads: [],
    guessMsPerKRow: 8,
    guessFixedMs: 5,
  },
  {
    id: "garch",
    group: "regime",
    label: "Volatility model",
    blurb: "GARCH and GJR against a plain EWMA, scored out of sample on QLIKE — does modelling the asymmetry buy anything here.",
    produces: "A forward volatility estimate, and whether it beats the baseline by enough to be worth the parameters.",
    tests: () => 3,
    library: "arch",
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 500,
    reads: [],
    guessMsPerKRow: 60,
    guessFixedMs: 800,
  },
  {
    id: "seasonality",
    group: "regime",
    label: "Session and weekday",
    blurb: "Whether the hour of the day or the day of the week carries any of the move, after the trend is removed.",
    produces: "The windows in which the subject actually moves — and the ones where a strategy is paying costs for nothing.",
    tests: () => 2,
    library: "prophet",
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 1000,
    reads: [],
    guessMsPerKRow: 40,
    guessFixedMs: 1500,
  },

  /* ── Probability ────────────────────────────────────────────────────── */
  {
    id: "baserates",
    group: "probability",
    label: "Conditional base rates",
    blurb: "What the subject did over the next horizon, counted separately in each market condition, with the sample size beside every figure.",
    produces: "The odds you are actually facing, before any model — and the cells where there is not enough history to say.",
    tests: (c) => 3 * Math.max(1, c.sliceSeries + 1),
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 400,
    reads: ["regimes"],
    guessMsPerKRow: 3,
    guessFixedMs: 3,
  },
  {
    id: "classifier",
    group: "probability",
    label: "Calibrated classifier",
    blurb: "A probability that the next move clears a volatility-scaled barrier, calibrated and scored on Brier rather than accuracy.",
    produces: "A number between 0 and 1 that means what it says — a 60% that happens 60% of the time.",
    tests: () => 1,
    library: "sklearn",
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: [],
    guessMsPerKRow: 45,
    guessFixedMs: 600,
  },
  {
    id: "edge",
    group: "probability",
    label: "Edge significance",
    blurb: "Whether the mean return over this window is distinguishable from zero once the serial correlation is accounted for.",
    produces: "The answer to whether there was anything here at all, which is the question every other number assumes.",
    tests: () => 1,
    library: "statsmodels",
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 300,
    reads: [],
    guessMsPerKRow: 5,
    guessFixedMs: 150,
  },

  /* ── Strategy ───────────────────────────────────────────────────────── */
  {
    id: "sweep-ema",
    group: "strategy",
    label: "Trend rules",
    blurb: "Twelve EMA crossover configurations, swept, walked forward on purged folds, with the overfitting probability measured by CSCV.",
    produces: "Whether the plainest trend rule survives out of sample here — the baseline anything cleverer has to beat.",
    tests: () => 12,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: [],
    guessMsPerKRow: 90,
    guessFixedMs: 40,
  },
  {
    id: "sweep-rsi",
    group: "strategy",
    label: "Reversion rules",
    blurb: "Twelve RSI reversion configurations filtered by the 200 EMA, on the same purged walk-forward.",
    produces: "Whether mean reversion pays here, or whether it is trend in a different coat.",
    tests: () => 12,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: [],
    guessMsPerKRow: 90,
    guessFixedMs: 40,
  },
  {
    id: "sweep-confluence",
    group: "strategy",
    label: "Confluence engine",
    blurb: "The terminal's own structure score, tested exactly like any third-party rule — nine configurations, same folds, same correction.",
    produces: "Whether the thing the terminal tells you every day holds up when it is measured the way a stranger's rule would be.",
    tests: () => 9,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: [],
    guessMsPerKRow: 120,
    guessFixedMs: 40,
  },
  {
    id: "excursion",
    group: "strategy",
    label: "Stop and target placement",
    blurb: "How far the winning rule's trades went against you before they worked, and how much was left on the table.",
    produces: "Where a stop would have survived and where it would have been taken out of a trade that went on to win.",
    tests: () => 2,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: ["sweep-ema", "sweep-rsi", "sweep-confluence"],
    guessMsPerKRow: 2,
    guessFixedMs: 5,
  },
  {
    id: "montecarlo",
    group: "strategy",
    label: "Trade-order risk",
    blurb: "Reshuffle the winning rule's trades thousands of times: the same edge in a different order, and what the worst runs look like.",
    produces: "The drawdown you should plan for rather than the one that happened to occur, and the odds of ruin at your size.",
    tests: () => 1,
    library: null,
    needsColumns: 0,
    needsDrivers: 0,
    minRows: 800,
    reads: ["sweep-ema", "sweep-rsi", "sweep-confluence"],
    guessMsPerKRow: 1,
    guessFixedMs: 300,
  },
];

export const METHOD_BY_ID: ReadonlyMap<string, Method> = new Map(METHODS.map((m) => [m.id, m]));

export function methodsInGroup(group: MethodGroup): readonly Method[] {
  return METHODS.filter((m) => m.group === group);
}

export type Availability =
  | { readonly state: "ready" }
  | { readonly state: "blocked"; readonly reason: string; readonly fixable: boolean };

/**
 * Whether this method can run against this study, and what to do if not.
 *
 * `fixable` separates "add a driver and it works" from "install a 200MB
 * library and restart the service". Both are refusals; only one of them is
 * something the operator can act on in the next ten seconds, and a list that
 * sorts them together makes the actionable ones invisible.
 */
export function availability(m: Method, ctx: MethodContext): Availability {
  if (m.library !== null) {
    if (ctx.health === null) {
      return {
        state: "blocked",
        reason: `Needs ${m.library}, and the quant service has not answered, so whether it is there is unknown. Start the terminal with python run.py.`,
        fixable: false,
      };
    }
    const missingWhy = ctx.health.missing[m.library];
    if (missingWhy !== undefined) {
      return {
        state: "blocked",
        reason: `${m.library} is not installed on the service. Without it, ${missingWhy} is unavailable.`,
        fixable: false,
      };
    }
    if (ctx.health.present[m.library] === undefined) {
      return {
        state: "blocked",
        reason: `The service did not report ${m.library} either way, so this cannot be counted on.`,
        fixable: false,
      };
    }
  }

  if (ctx.driverColumns < m.needsDrivers) {
    return {
      state: "blocked",
      reason: `Needs ${m.needsDrivers} series marked Driver; this study has ${ctx.driverColumns}. A series only counts if you told it it may predict.`,
      fixable: true,
    };
  }

  if (ctx.featureColumns < m.needsColumns) {
    return {
      state: "blocked",
      reason: `Needs ${m.needsColumns} feature column${m.needsColumns === 1 ? "" : "s"}; this study has ${ctx.featureColumns}. Regime proxies do not count — they slice the result rather than entering it.`,
      fixable: true,
    };
  }

  if (!ctx.checked) {
    return {
      state: "blocked",
      reason: `Needs ${m.minRows.toLocaleString()} aligned rows and no bars have been fetched yet, so nothing is known about how many there are. Check the window on the Subject step.`,
      fixable: true,
    };
  }

  if (ctx.rows < m.minRows) {
    return {
      state: "blocked",
      reason: `Needs ${m.minRows.toLocaleString()} aligned rows; the joint window holds ${ctx.rows.toLocaleString()}. Lengthen the history, or drop whichever series is cutting the window short.`,
      fixable: true,
    };
  }

  return { state: "ready" };
}
