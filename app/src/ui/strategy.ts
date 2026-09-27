/**
 * Strategy desk.
 *
 * TWO THINGS, TOP TO BOTTOM (v59.2, the "built together" design)
 * 1. The flow — describe an idea, the analyst drafts rules, you edit them,
 *    backtest on stored bars, simulate, read the critique, decide. It lives in
 *    `ui/strategy/flow.ts`; this file builds it and hands it the settings.
 * 2. The family lab — below, behind a disclosure: the sweep, walk-forward and
 *    overfitting probability over a whole FAMILY of parameterisations. Nothing
 *    was removed from it; it moved down because the flow is where a strategy
 *    starts and the sweep is where a family is stress-tested.
 * Costs, risk and history depth are ONE set of signals, read by both, so the
 * two testers cannot disagree about what a trade costs.
 *
 * THE LAB, as it always was:
 * The layout enforces the thing the lab is for. The FIRST card is the verdict;
 * the equity curve sits underneath it and is explicitly captioned as arithmetic
 * rather than evidence. Every other tester on the market puts the curve first
 * and the caveats in a footnote, which is exactly how a fitted result gets
 * traded.
 *
 * There is no "run without validation" path. Sweep, walk-forward and PBO run
 * together or not at all — see `backtest/lab.ts` for why that is not
 * negotiable.
 */

import { signal, computed, renderEffect, type ReadSignal, type Signal } from "../core/signal";
import { h, clear } from "./dom";
import { scheduleFrame } from "../core/frame";
import type { BarView } from "../chart/series";
import { runStudy, FAMILIES, type ConfigRow, type Family, type Study } from "../backtest/lab";
import { runStudyRemote } from "../data/lab";
import { createLattice } from "./lattice";
import type { HistoryService } from "../data/history";
import { DEFAULT_COSTS, type Costs } from "../backtest/engine";
import type { KV } from "../store/kv";
import type { AgentSession } from "../agent/session";
import {
  barsPerYearFromSpan,
  computeMetrics,
  drawdownCurve,
  maxDrawdown,
  MIN_CAGR_YEARS,
  type Metrics,
} from "../backtest/metrics";
import {
  DEFAULT_RUIN,
  drawsFor,
  monteCarlo,
  randomEntryTest,
  type MonteCarloResult,
  type RandomEntryResult,
} from "../backtest/montecarlo";
import { MIN_REGIME_TRADES, REGIME_BLURB, REGIME_LABEL, regimeLine } from "../backtest/regime";
import { readExcursions, type ExcursionRead } from "../backtest/excursion";
import { pkWhy } from "./panelkit";
import { createMiniChart } from "./minichart";
import {
  PAD_LABELLED,
  PAD_SCATTER,
  paintDrawdownHistogram,
  paintEquity,
  paintExcursions,
  paintUnderwater,
} from "./strategy/paint";
import { loadStudyBars } from "./strategy/load";
import { createStrategyFlow } from "./strategy/flow";
import { createAutonomous } from "./strategy/autonomous";
import type { ShelfStore } from "../backtest/shelfstore";
import type { SweepDriver } from "./model/sweepdriver";

export interface StrategyDeskOptions {
  symbol: Signal<string>;
  timeframe: Signal<string>;
  /** The chart's window — used only to say what is on screen, never to study. */
  bars: ReadSignal<readonly BarView[]>;
  /**
   * The lab's own history, deeper than the chart's.
   *
   * The chart loads 800 bars because that is what fits on screen. The EMA
   * family alone needs 820 before a sweep means anything, so a lab bolted onto
   * the chart's window would refuse every single run — and a tester that always
   * refuses is one whose refusals stop being read. The desk therefore fetches
   * its own window through the archive, and backfills when it comes up short.
   */
  history: HistoryService;
  /**
   * OPTIONAL. Where the flow keeps its draft, conversation, backtest library
   * and decisions. Absent: they last until reload, and the desk says so.
   */
  kv?: KV;
  /**
   * OPTIONAL. The analyst session that turns words into rules. Absent: the
   * conversation box says no analyst is connected and nothing is drafted.
   */
  session?: AgentSession;
  /**
   * OPTIONAL. The shelf the Autonomous mode saves survivors to, and that the
   * recommendation card reads. ONE store, passed in rather than created here:
   * two readers of `DISCOVERED_SLOT` would each hold a snapshot, and promoting
   * a strategy on this desk would leave the card calling it unproven.
   * Absent: the search still runs and reports, and says nothing was saved.
   */
  shelf?: ShelfStore;
  /**
   * OPTIONAL. The one search, shared with the inspector's recommendation card
   * so a sweep started in either place is the same run — see
   * `ui/model/sweepdriver.ts`. Absent: this desk builds a private one and the
   * card can only offer to bring you here, as before v60.2.
   */
  sweep?: SweepDriver;
  /**
   * OPTIONAL. The history depth both this desk's controls and the shared
   * driver read. Passed in so the number the operator sets in the Backtest card
   * is the number an automatic search uses; a second signal would make the
   * control silently describe a different run.
   */
  sweepDepth?: Signal<number>;
}

/**
 * Which half of the desk is on screen. Manual is everything that existed
 * before; Autonomous is the search. In memory only: a mode is a place you are,
 * not a preference, and a saved one would put the operator somewhere they did
 * not choose on the next boot.
 */
export type StrategyMode = "manual" | "autonomous";

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const r3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "—");

export function createStrategy(opts: StrategyDeskOptions) {
  const mode = signal<StrategyMode>("manual");
  const family = signal<Family>("ema");
  const depth = opts.sweepDepth ?? signal(5000);
  const backfilling = signal(false);
  const progress = signal<string>("");
  const loaded = signal<{ bars: number; source: string; coverage: number; demo: boolean } | null>(null);
  const spreadBp = signal(2);
  /* Financing per night held, in basis points. Declared here with the other
     three because a cost model with a term the operator cannot see is a hurdle
     they cannot argue with — and this one was charged as zero for the whole of
     this engine's life. */
  const carryBp = signal(1);
  const commissionBp = signal(4);
  const slippageBp = signal(1);
  const riskPct = signal(1);
  const study = signal<Study | null>(null);
  const running = signal(false);
  const ranFor = signal<string>("");
  /** Where the last study actually ran. Shown, never inferred. */
  const ranOn = signal<string>("");
  /**
   * The bars, costs and risk the last study ran on. The random-entry test needs
   * the SAME bars the trades' indices point into, and the annualised metrics
   * need their timestamps — neither is on the (possibly remote) Study object.
   */
  const studied = signal<{ bars: readonly BarView[]; costs: Costs; risk: number } | null>(null);
  const mc = signal<MonteCarloResult | null>(null);
  const monkey = signal<RandomEntryResult | null>(null);

  async function run(): Promise<void> {
    if (running.peek()) return;
    running.set(true);
    study.set(null);
    studied.set(null);
    loaded.set(null);
    progress.set("");

    const symbol = opts.symbol.peek();
    const tf = opts.timeframe.peek();

    /* The same loader the flow above uses — `ui/strategy/load.ts` — so a rule
       set and a family are always tested on bars fetched the same way. */
    const got = await loadStudyBars(opts.history, symbol, tf, depth.peek(), () => opts.bars.peek(), {
      progress: (text) => progress.set(text),
      backfilling: (on) => backfilling.set(on),
    });
    progress.set(got.note);
    const { bars, coverage, demo, source } = got;

    loaded.set({ bars: bars.length, source, coverage, demo });

    if (bars.length === 0) {
      running.set(false);
      return;
    }
    /**
     * Yield so the button repaints as "Running…" before the sweep blocks the
     * thread.
     *
     * Through `scheduleFrame`, NOT raw requestAnimationFrame. This terminal is
     * normally a background tab and rAF is not served in one — an await on a
     * bare rAF simply never resolves, and the button sticks on "Running…"
     * forever while the study is never run. That is not hypothetical: it is
     * what this code did until it was watched doing it.
     */
    await new Promise((r) => scheduleFrame(() => scheduleFrame(() => r(null))));

    const studyOpts = {
      costs: {
        spread: spreadBp.peek() / 10_000,
        commission: commissionBp.peek() / 10_000,
        slippage: slippageBp.peek() / 10_000,
        carryPerNight: carryBp.peek() / 10_000,
      },
      riskPerTrade: riskPct.peek() / 100,
      coverage,
      containsDemo: demo,
    };
    studied.set({ bars, costs: studyOpts.costs, risk: studyOpts.riskPerTrade });

    try {
      /* THE BACKEND FIRST, AND SILENTLY BACK TO HERE IF IT IS NOT THERE.
         The worker runs THIS repository's `runStudy`, compiled — so the result
         is the same object either way and there is no verdict to reconcile. The
         difference is only that the sweep does not happen on the thread drawing
         the chart. A refused connection on loopback costs under a millisecond,
         which is why this needs no setting to find and no probe to go stale. */
      progress.set("running on the backend…");
      const remote = await runStudyRemote(family.peek(), bars, studyOpts);

      if (remote.ok && remote.study) {
        study.set(remote.study);
        ranOn.set(`backend · ${remote.ms} ms`);
        progress.set("");
      } else {
        /* Local. The desk has always worked with no Python installed and that
           does not change; what changes is that the operator is told which of
           the two just happened, rather than being left to infer it from how
           long the tab froze. */
        progress.set("");
        ranOn.set(`this tab · ${remote.error || "no backend"}`);
        study.set(runStudy(family.peek(), bars, studyOpts));
      }
      ranFor.set(`${symbol} · ${tf} · ${bars.length} bars`);
    } finally {
      running.set(false);
    }
  }

  // -------------------------------------------------------------- setup ---

  const familySelect = h("select", {
    class: "field-input",
    onchange: (e: Event) => family.set((e.target as HTMLSelectElement).value as Family),
  }) as HTMLSelectElement;
  for (const f of FAMILIES) {
    familySelect.appendChild(h("option", { value: f.id, text: f.label, title: f.blurb }));
  }

  const setupCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Family sweep" }),
      h("span", { class: "chip", text: () => `${opts.symbol()} · ${opts.timeframe()}` }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h(
        "label",
        { class: "field" },
        h("span", { class: "field-label", text: "Family" }),
        familySelect,
        h("span", {
          class: "field-hint",
          text: () => FAMILIES.find((f) => f.id === family())?.blurb ?? "",
        }),
      ),
      /* Costs, risk and depth are set ONCE, in the Backtest card above, and
         read here — two sets of inputs for one cost would be two answers. */
      h("p", {
        class: "muted small",
        text: () =>
          `Uses the costs and history set in the Backtest card above: ${spreadBp()}bp spread, ${commissionBp()}bp commission a side, ${slippageBp()}bp slippage, ${carryBp()}bp a night held, ${riskPct()}% risk, ${depth()} bars.`,
      }),
      h(
        "div",
        { class: "alert-form-actions" },
        h("button", {
          class: "primary-btn",
          disabled: () => running(),
          text: () => (backfilling() ? "Fetching history…" : running() ? "Running…" : "Run study"),
          onclick: () => void run(),
        }),
      ),
      h("p", {
        class: "muted small",
        "data-show": () => String(progress() !== ""),
        text: () => progress(),
      }),
      // What was loaded is a result and stays on screen; how it is measured
      // is one disclosure below it.
      h("p", {
        class: "muted small",
        "data-show": () => String(loaded() !== null),
        text: () => {
          const l = loaded();
          if (!l) return "";
          const cov = `${(l.coverage * 100).toFixed(1)}% covered`;
          const demo = l.demo ? " · CONTAINS GENERATED BARS" : "";
          return `${l.bars} bars from ${l.source} · ${cov}${demo}.`;
        },
      }),
      pkWhy(
        "Sweeps the grid, walks forward over 5 folds and computes PBO across 8 blocks. There is no way to run one without the others. " +
          "The lab fetches its own history, deeper than the chart's — the chart loads what fits on screen, which is less than a sweep needs. " +
          "Coverage discounts hours the venue was shut, so a weekend is not counted as missing data. " +
          `Costs default to ${DEFAULT_COSTS.spread * 10_000}bp spread and ${DEFAULT_COSTS.commission * 10_000}bp commission. Set them to what YOUR broker charges — a strategy that only works at zero cost is reported as exactly that.`,
      ),
    ),
  );

  // ----------------------------------------------------------- headline ---

  const headlineCard = h(
    "section",
    { class: "panel verdict-card span-all", "data-standing": () => study()?.headline.standing ?? "none" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Verdict" }),
      h("span", { class: "chip", text: () => ranFor() }),
      /* Where it ran, next to what it ran on. Not a boast — the two paths are
         the same engine, so this exists so that "why was that instant" and
         "why did the tab freeze" both have an answer on screen. */
      h("span", {
        class: "chip",
        text: () => ranOn(),
        style: () => (ranOn() ? "" : "display:none"),
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", {
        class: "verdict-line",
        text: () => study()?.headline.verdict ?? "Not run yet",
      }),
      h("p", {
        class: "verdict-why",
        text: () =>
          study()?.headline.why ??
          "Run a study. The result leads with what survived out of sample, not with what the backtest made.",
      }),
    ),
  );

  // ------------------------------------------------------------- equity ---

  /** The bars the curve's indices point into, for a dated readout. */
  const studiedBars = (): readonly BarView[] | null => studied.peek()?.bars ?? null;

  // Every repaint goes through the kit's scheduler, so a curve still appears
  // when the tab is in the background; the kit also repaints on resize.
  const equityChart = createMiniChart({
    height: 96,
    label: "Equity curve of the best in-sample configuration, in multiples of starting capital",
    paint: (f) => paintEquity(f, study.peek()?.bestRun?.equity ?? new Float64Array(0), studiedBars()),
  });
  renderEffect(() => {
    study();
    studied();
    equityChart.repaint();
  });

  const underwater = computed(() => drawdownCurve(study()?.bestRun?.equity ?? []));
  const underwaterChart = createMiniChart(
    {
      height: 44,
      label: "Drawdown below the running peak, bar by bar",
      pad: { l: 4, r: 4, t: 1, b: 3 },
      paint: (f) => paintUnderwater(f, underwater.peek(), studiedBars()),
    },
    "height:44px",
  );
  renderEffect(() => {
    underwater();
    studied();
    underwaterChart.repaint();
  });

  /**
   * Bars per year MEASURED from the studied bars' timestamps.
   *
   * The lab's own metrics use the 24/7 default, which is right for crypto and
   * wrong for anything that closes; annualising an FX curve with 8,760 bars a
   * year overstates its span and understates its CAGR. 0 when it cannot be
   * measured, which makes every annualised figure below refuse.
   */
  const barsPerYear = computed(() => {
    const b = studied()?.bars ?? [];
    if (b.length < 2) return 0;
    return barsPerYearFromSpan(b.length, (b[0] as BarView).t, (b[b.length - 1] as BarView).t);
  });

  /**
   * The winner's metrics recomputed HERE, from its own trades and curve.
   *
   * Not read from `study.best.metrics`: a study that ran on the backend was
   * produced by whatever build the worker has, which may predate these fields,
   * and a missing field would print as "undefined". Recomputing is O(bars).
   */
  const deep = computed((): Metrics | null => {
    const run = study()?.bestRun;
    if (!run || run.trades.length === 0) return null;
    return computeMetrics(run.trades, run.equity, barsPerYear());
  });
  /** Years the curve spans, so an annualised figure can say why it refused. */
  const years = (): number => {
    const run = study()?.bestRun;
    const bpy = barsPerYear();
    return run && bpy > 0 ? (run.equity.length - 1) / bpy : 0;
  };
  const deepMetric = (read: (m: Metrics) => string): (() => string) => () => {
    const m = deep();
    return m ? read(m) : "—";
  };
  const annual = (read: (m: Metrics) => string): (() => string) => () => {
    const m = deep();
    if (!m) return "—";
    return years() < MIN_CAGR_YEARS ? "under ¼ yr" : read(m);
  };

  /**
   * The simulations run AFTER the study has painted, each in its own frame.
   *
   * Measured (see `MC_DRAWS` in montecarlo.ts): at 200 trades the bootstrap
   * takes ~12 ms and the random-entry test ~18 ms, together filling a frame,
   * and at 1,000 trades 55 ms and 85 ms. `drawsFor` caps draws × trades so each
   * frame stays near 15–20 ms, and the draw count is printed beside the result.
   * A stale callback (a newer study landed first) is dropped, not applied.
   */
  renderEffect(() => {
    const s = study();
    mc.set(null);
    monkey.set(null);
    const run = s?.bestRun;
    const ctx = studied.peek();
    if (!s || !run || run.trades.length === 0 || !ctx) return;
    const draws = drawsFor(run.trades.length);
    scheduleFrame(() => {
      if (study.peek() !== s) return;
      mc.set(monteCarlo(run.trades.map((t) => t.rMultiple), ctx.risk, { draws, ruinDrawdown: DEFAULT_RUIN }));
      scheduleFrame(() => {
        if (study.peek() !== s) return;
        monkey.set(randomEntryTest(ctx.bars, run.trades, ctx.costs, { draws }));
      });
    });
  });

  /**
   * A metric of the winning configuration.
   *
   * `best` is null on a REFUSED study even though the study itself exists, so
   * every read goes through optional chaining. Guarding on `study()` alone
   * threw inside a render effect and left the whole desk showing "Not run yet"
   * after a run that had in fact completed — a failure that looked exactly like
   * the run never happening.
   */
  const bestMetric = (read: (m: Metrics) => string): (() => string) => {
    return () => {
      const m = study()?.best?.metrics;
      return m ? read(m) : "—";
    };
  };

  const metricRow = (label: string, value: () => string, hint?: string): HTMLElement =>
    h(
      "div",
      { class: "metric" },
      h("span", { class: "metric-label", text: label, title: hint ?? "" }),
      h("span", { class: "metric-value num", text: value }),
    );

  const equityCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Best in sample" }),
      h("span", { class: "chip", text: () => study()?.best?.label ?? "—" }),
    ),
    h(
      "div",
      { class: "panel-body" },
      equityChart.el,
      underwaterChart.el,
      pkWhy("Arithmetic on real bars, in sample, for the configuration that won the sweep. It is a description of the past, not a claim about the future — the verdict above is the claim. The strip underneath is the same curve's drawdown below its running peak: the time spent there is what you would have sat through."),
      h(
        "div",
        { class: "metric-grid" },
        metricRow("Trades", bestMetric((m) => String(m.trades))),
        metricRow("Win rate", bestMetric((m) => pct(m.winRate))),
        metricRow("Expectancy", bestMetric((m) => `${r3(m.expectancyR)}R`)),
        metricRow("Profit factor", bestMetric((m) => r2(m.profitFactor))),
        metricRow("Total return", bestMetric((m) => pct(m.totalReturn))),
        metricRow("Max drawdown", bestMetric((m) => pct(m.maxDrawdown))),
        metricRow(
          "Worst losing run",
          bestMetric((m) => String(m.maxConsecutiveLosses)),
          "The number that actually decides whether a system is sittable",
        ),
        metricRow(
          "Gross expectancy",
          () => {
            const g = study()?.grossMetrics;
            return g ? `${r3(g.expectancyR)}R` : "—";
          },
          "The same configuration with every cost switched off",
        ),
        metricRow(
          "Sharpe",
          deepMetric((m) => r2(m.sharpe)),
          "Annualised with bars per year measured from the bars' own timestamps. Assumes independent, normal returns; trading returns are neither.",
        ),
        metricRow(
          "Sortino",
          deepMetric((m) => (m.sortino === 0 ? "—" : r2(m.sortino))),
          "Like Sharpe, but only losing bars count as risk. Blank when no bar lost — a ratio over nothing is undefined, not excellent.",
        ),
        metricRow(
          "CAGR",
          annual((m) => pct(m.cagr)),
          "Compound annual growth over the span actually tested. Refused under a quarter of a year: compounding weeks up to a year is extrapolation.",
        ),
        metricRow(
          "Calmar",
          annual((m) => (m.calmar === 0 ? "—" : r2(m.calmar))),
          "CAGR divided by max drawdown. Blank when there was no drawdown or no CAGR.",
        ),
        metricRow(
          "Ulcer index",
          deepMetric((m) => pct(m.ulcerIndex)),
          "Root-mean-square drawdown. Charges for how long and how often the curve sat below its peak, not only for the worst trough.",
        ),
        metricRow(
          "Longest under water",
          deepMetric((m) => {
            const bpy = barsPerYear();
            const days = bpy > 0 ? ` · ${((m.maxTimeUnderWaterBars / bpy) * 365.25).toFixed(0)}d` : "";
            return `${m.maxTimeUnderWaterBars} bars${days}`;
          }),
          "The longest stretch below a previous peak. A drawdown still open at the end is counted to the last bar, so this is a floor.",
        ),
        metricRow(
          "Exposure",
          deepMetric((m) => pct(m.exposure)),
          "Share of bars with a position open. Returns earned in less time carry less market risk — and less evidence.",
        ),
      ),
    ),
  );

  // -------------------------------------------------------- Monte Carlo ---

  /**
   * What the ORDER of the trades was worth.
   *
   * The backtest's drawdown is one path — usually a lucky one, because the
   * winner of a sweep is the configuration whose losers happened not to
   * cluster. Resampling the same trades shows the drawdown the same edge could
   * have produced, and the chance of reaching a drawdown most people stop at.
   */
  const observedDd = computed(() => maxDrawdown(study()?.bestRun?.equity ?? []));
  const mcChart = createMiniChart(
    {
      height: 80,
      label: "Histogram of simulated worst drawdowns, with the backtest's own and the ruin level marked",
      pad: PAD_LABELLED,
      paint: (f) => {
        const r = mc.peek();
        return paintDrawdownHistogram(f, r?.drawdowns ?? [], observedDd.peek(), r?.ruinDrawdown ?? DEFAULT_RUIN);
      },
    },
    "height:80px",
  );
  renderEffect(() => {
    mc();
    observedDd();
    mcChart.repaint();
  });

  const mcTable = h("div", { class: "sweep-table" });
  renderEffect(() => {
    const r = mc();
    const m = deep();
    clear(mcTable);
    if (!r || r.refused !== null || !m) {
      mcTable.appendChild(
        h("p", {
          class: "muted small",
          text: r?.refused
            ? `Not simulated: ${r.refused}.`
            : study()?.bestRun?.trades.length
              ? "Simulating…"
              : "Not run yet.",
        }),
      );
      return;
    }
    const row = (label: string, s: { p5: number; p50: number; p95: number }, own: number, f: (v: number) => string): HTMLElement =>
      h(
        "div",
        { class: "sweep-row" },
        h("span", { class: "sweep-name", text: label }),
        h("span", { class: "num", text: f(s.p5) }),
        h("span", { class: "num", text: f(s.p50) }),
        h("span", { class: "num", text: f(s.p95) }),
        h("span", { class: "num", text: f(own) }),
      );
    mcTable.appendChild(
      h(
        "div",
        { class: "sweep-row sweep-head" },
        h("span", { text: `${r.draws} paths` }),
        h("span", { text: "p5" }),
        h("span", { text: "p50" }),
        h("span", { text: "p95" }),
        h("span", { text: "Backtest" }),
      ),
    );
    /* The backtest column is from the per-bar curve; the simulation compounds
       per TRADE. They agree at trade exits and differ only by open-trade
       excursions, which the per-bar curve sees and the simulation cannot. */
    mcTable.appendChild(row("Max drawdown", r.maxDrawdown, m.maxDrawdown, pct));
    mcTable.appendChild(row("Final return", r.finalReturn, m.totalReturn, pct));
    mcTable.appendChild(row("Losing streak", r.losingStreak, m.maxConsecutiveLosses, (v) => String(v)));
  });

  const mcCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Risk of ruin · Monte Carlo" }),
      h("span", {
        class: "chip",
        "data-standing": () => {
          const r = mc();
          if (!r || r.refused !== null) return "none";
          return r.ruinProbability >= 0.05 ? "bad" : "good";
        },
        text: () => {
          const r = mc();
          if (!r || r.refused !== null) return "—";
          return `${pct(r.ruinProbability)} hit −${(r.ruinDrawdown * 100).toFixed(0)}%`;
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      mcChart.el,
      mcTable,
      h("p", {
        class: "small",
        text: () => {
          const r = mc();
          if (!r || r.refused !== null) return "";
          return (
            `Resampling these ${r.trades} trades ${r.draws} times at ${(r.riskPerTrade * 100).toFixed(1)}% risk per trade: ` +
            `in 95% of paths the worst drawdown stayed under ${pct(r.maxDrawdown.p95)}, against ${pct(observedDd())} in the backtest. ` +
            `${pct(r.ruinProbability)} of paths reached a ${(r.ruinDrawdown * 100).toFixed(0)}% drawdown.`
          );
        },
      }),
      pkWhy("Bars: simulated worst drawdowns. Solid line: the backtest's own. Dashed line: the ruin level. Trades are drawn with replacement, which assumes they are independent — a strategy whose losers cluster is riskier than this shows. The same trades, not new ones: an edge that is not there is not rescued by resampling it."),
    ),
  );

  // ------------------------------------------------- random-entry test ---

  /**
   * Whether the ENTRY rule did anything.
   *
   * The same number of trades, the same holding times and sides, entered at
   * random on the same bars and charged the same costs. If those do as well,
   * the curve came from the market's drift over those holding times, not from
   * the rule's timing.
   */
  const monkeyCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Entries vs random" }),
      h("span", {
        class: "chip",
        "data-standing": () => {
          const r = monkey();
          if (!r || r.refused !== null) return "none";
          return r.p < 0.05 ? "good" : "bad";
        },
        text: () => {
          const r = monkey();
          return r && r.refused === null ? `p = ${r.p.toFixed(3)}` : "—";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", {
        class: "verdict-why",
        text: () => {
          const r = monkey();
          if (!r) return study()?.bestRun?.trades.length ? "Simulating…" : "Not run yet.";
          if (r.refused !== null) return `Not tested: ${r.refused}.`;
          return `Random entries with the same holding times beat or matched this ${pct(r.beatenShare)} of the time.`;
        },
      }),
      h(
        "div",
        { class: "metric-grid" },
        metricRow("This rule, per trade", () => {
          const r = monkey();
          return r && r.refused === null ? `${(r.observedMean * 100).toFixed(3)}%` : "—";
        }, "Mean net return per trade, after costs"),
        metricRow("Random, per trade", () => {
          const r = monkey();
          return r && r.refused === null ? `${(r.nullMean * 100).toFixed(3)}%` : "—";
        }, "Mean of the random draws' mean net return"),
        metricRow("Random p5 – p95", () => {
          const r = monkey();
          return r && r.refused === null
            ? `${(r.nullP5 * 100).toFixed(3)} – ${(r.nullP95 * 100).toFixed(3)}%`
            : "—";
        }),
        metricRow("Draws", () => {
          const r = monkey();
          return r && r.refused === null ? String(r.draws) : "—";
        }),
      ),
      pkWhy("Measured in net return per trade, because a random entry has no stop and so no R. Each random trade copies one real trade's side and holding time, enters at a bar's open and exits at the close, with the same spread, slippage and commission. Keeping the side is what stops a long-only rule being credited with a rising market. The rule's stop and target fills are part of what is being tested. In sample: this is the configuration the sweep picked, so a small p here is necessary, not sufficient."),
    ),
  );

  // ----------------------------------------------------- MAE / MFE ---

  /**
   * Where the winning configuration's trades went while they were open.
   *
   * Computed from the trades already in memory — no second backtest — and
   * only from the best run, because excursions of the whole sweep would mix
   * rules with different stops into one cloud that describes none of them.
   */
  const excursion = computed((): ExcursionRead | null => {
    const run = study()?.bestRun;
    return run && run.trades.length > 0 ? readExcursions(run.trades) : null;
  });
  const excursionChart = createMiniChart(
    {
      height: 140,
      label: "Each trade's adverse excursion against its final result, in R",
      pad: PAD_SCATTER,
      paint: (f) => paintExcursions(f, excursion.peek()),
    },
    "height:140px",
  );
  renderEffect(() => {
    excursion();
    excursionChart.repaint();
  });

  const ex = (read: (e: ExcursionRead) => string): (() => string) => () => {
    const e = excursion();
    return e && e.refused === null ? read(e) : "—";
  };

  const excursionCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Trade excursions (MAE / MFE)" }),
      h("span", {
        class: "chip",
        text: () => {
          const e = excursion();
          return e && e.refused === null ? `${e.winners} won · ${e.losers} lost` : "—";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      excursionChart.el,
      h("p", {
        class: "verdict-why",
        text: () => {
          const e = excursion();
          if (!e) return study() ? "No trades to read." : "Not run yet.";
          if (e.refused !== null) return `Not read: ${e.refused}.`;
          const room =
            e.winnerMaeP90 < 0.7
              ? ` Nine winners in ten never went beyond ${r2(e.winnerMaeP90)}R against the entry, so the full 1R stop is room the winners did not use — a question for the walk-forward, not a licence to tighten.`
              : ` Winners routinely go ${r2(e.winnerMaeP90)}R against the entry before they work, so the stop sits where the good trades breathe.`;
          const giveBack =
            e.losersOnceUp1R >= 0.25
              ? ` ${pct(e.losersOnceUp1R)} of losers were a full R in profit first: the exit is giving trades back.`
              : "";
          const kept =
            e.captureP50 === null
              ? "Every winner took its target, so how much of the move they kept is fixed by the target, not measured."
              : `Winners that left before their target kept a median ${pct(e.captureP50)} of their best move.`;
          return `${kept}${room}${giveBack}`;
        },
      }),
      h(
        "div",
        { class: "metric-grid" },
        metricRow("Winners' heat, median", ex((e) => `${r2(e.winnerMaeP50)}R`), "How far a typical winner went against the entry before it paid"),
        metricRow("Winners' heat, 90th pct", ex((e) => `${r2(e.winnerMaeP90)}R`), "Nine winners in ten went no further against the entry than this"),
        metricRow("Losers' best, median", ex((e) => `${r2(e.loserMfeP50)}R`), "How far a typical loser was in profit before it lost"),
        metricRow("Losers once up 1R", ex((e) => pct(e.losersOnceUp1R)), "Losing trades that had been a full R in profit"),
        metricRow(
          "Capture, median",
          ex((e) => (e.captureP50 === null ? "all at target" : pct(e.captureP50))),
          "Realised R over best excursion, for winners that did NOT exit at their target — a target exit caps its own excursion, so its capture is 100% by construction",
        ),
        metricRow("Winners at target", ex((e) => `${e.targetWinners} of ${e.winners}`)),
      ),
      pkWhy("Each dot is a trade: across, how far it went against the entry in R; up, how it ended. Dashed line: the 1R stop. Solid line: where 90% of winners' heat ended. Measured from bar highs and lows, gross of costs, and the exit bar is read pessimistically — a stop-out never gets credit for a high that may have come after it. In sample, for the configuration the sweep picked."),
    ),
  );

  // ------------------------------------------------------- walk-forward ---

  const foldTable = h("div", { class: "fold-table" });
  renderEffect(() => {
    const s = study();
    clear(foldTable);
    if (!s || s.walk.folds.length === 0) {
      foldTable.appendChild(
        h("p", {
          class: "muted small",
          text: s ? s.walk.verdict : "Not run yet.",
        }),
      );
      return;
    }
    foldTable.appendChild(
      h(
        "div",
        { class: "fold-row fold-head" },
        h("span", { text: "Fold" }),
        h("span", { text: "Chosen on train" }),
        h("span", { text: "IS exp." }),
        h("span", { text: "OOS exp." }),
        h("span", { text: "OOS trades" }),
      ),
    );
    for (const f of s.walk.folds) {
      const held = f.outOfSample.expectancyR >= f.inSample.expectancyR * 0.5;
      foldTable.appendChild(
        h(
          "div",
          { class: "fold-row", "data-held": String(held) },
          h("span", { class: "num", text: String(f.index + 1) }),
          h("span", { class: "fold-name", text: f.chosen ?? "—" }),
          h("span", { class: "num", text: r3(f.inSample.expectancyR) }),
          h("span", { class: "num", text: r3(f.outOfSample.expectancyR) }),
          h("span", { class: "num", text: String(f.outOfSample.trades) }),
        ),
      );
    }
  });

  const walkCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Walk-forward" }),
      h("span", {
        class: "chip",
        // A refused or unrunnable study has no degradation figure. Printing
        // "0.0% retained" for it states a measurement that was never made.
        text: () => {
          const s2 = study();
          return s2 && s2.walk.folds.length > 0 ? `${pct(s2.walk.degradation)} retained` : "—";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      foldTable,
      pkWhy("Each fold picks its configuration on the training slice and is measured on the next slice, which the selection never saw. The gap between the two columns is the part of the backtest that was curve-fitting."),
      h("p", {
        class: "muted small",
        text: () => study()?.walk.verdict ?? "",
      }),
    ),
  );

  // ---------------------------------------------------- promotion gate ---

  /**
   * The card that decides whether any of this counts.
   *
   * Placed ABOVE the PBO card because it is the conclusion and PBO is one of
   * its inputs. The desk has always been able to compute every one of these
   * checks and has never had a rule that consumed them — so the best-looking
   * number on the screen was, by construction, the most overfit one.
   *
   * It refuses far more often than it passes, and that is the feature. "Not
   * promoted — 3 of 5 checks failed", with the three named, is more useful
   * than a ranked list of things that would not have survived.
   */
  const gateCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Out-of-sample gate" }),
      h("span", {
        class: "chip",
        "data-standing": () => {
          const s2 = study();
          return s2 === null ? "none" : s2.promotion.promoted ? "good" : "bad";
        },
        text: () => {
          const s2 = study();
          return s2 === null ? "—" : s2.promotion.promoted ? "Promoted" : "Not promoted";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("div", { class: "gate-checks" }, () => {
        const s2 = study();
        if (s2 === null) return h("p", { class: "muted small", text: "Not run yet." });
        return h(
          "div",
          {},
          ...s2.promotion.checks.map((c) =>
            h(
              "div",
              { class: "gate-check", "data-passed": String(c.passed) },
              h("span", { class: "gate-mark", text: c.passed ? "✓" : "✗" }),
              h("span", { class: "gate-text", text: c.text }),
            ),
          ),
        );
      }),
      pkWhy("Every check is measured out of sample. In-sample expectancy is what the selection maximised, so requiring it to be positive would test nothing at all — and a check that was never computed is reported as a failure rather than folded into a pass."),
    ),
  );

  // --------------------------------------------------------- by regime ---

  /**
   * The split that turns a number into an instruction.
   *
   * A single expectancy averages a strategy over every condition it met, and
   * most strategies are not one thing. Reported per regime, with the sample
   * floor enforced — a 2.4R expectancy over four trades is four numbers.
   */
  const regimeCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "By market condition" }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("div", { class: "regime-rows" }, () => {
        const s2 = study();
        if (s2 === null || s2.regimes.length === 0) {
          return h("p", { class: "muted small", text: "Not run yet." });
        }
        return h(
          "div",
          {},
          ...s2.regimes.map((sl) =>
            h(
              "div",
              { class: "regime-row" },
              h("span", { class: "regime-name", text: REGIME_LABEL[sl.regime], title: REGIME_BLURB[sl.regime] }),
              h("span", { class: "num regime-exp", text: `${(sl.exposure * 100).toFixed(0)}% of bars` }),
              h("span", { class: "num regime-n", text: `${sl.metrics.trades} trades` }),
              h("span", {
                class: "num regime-r",
                "data-usable": String(sl.metrics.trades >= MIN_REGIME_TRADES),
                text:
                  sl.metrics.trades >= MIN_REGIME_TRADES
                    ? `${sl.metrics.expectancyR >= 0 ? "+" : ""}${sl.metrics.expectancyR.toFixed(2)}R`
                    : "too few",
              }),
            ),
          ),
        );
      }),
      h("p", { class: "small", text: () => (study() === null ? "" : regimeLine(study()!.regimes)) }),
      pkWhy("A trade is filed under the regime it was ENTERED in, because that is the only information the decision had. Within a slice, drawdown and Sharpe are measured over the trade sequence rather than per bar — comparable between slices, not with the pooled figures above."),
    ),
  );

  // ---------------------------------------------------------------- PBO ---

  const pboCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Overfitting probability" }),
      h("span", {
        class: "chip",
        /**
         * "—", never "0%", when PBO could not be computed.
         *
         * Zero is the BEST possible PBO. Printing it for a study that was
         * refused says the opposite of the truth in the most reassuring
         * possible way — the exact failure mode this desk exists to prevent.
         */
        text: () => {
          const s2 = study();
          return s2 && s2.overfit.splits > 0 ? `${(s2.overfit.pbo * 100).toFixed(0)}%` : "—";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("div", {
        class: "pbo-bar",
        ref: (el: HTMLDivElement) => {
          const fill = h("div", { class: "pbo-fill" });
          const mark = h("div", { class: "pbo-mark", title: "0.5 — selection is a coin flip" });
          el.appendChild(fill);
          el.appendChild(mark);
          renderEffect(() => {
            const s2 = study();
            const computed = !!s2 && s2.overfit.splits > 0;
            const p = computed ? s2.overfit.pbo : 0;
            fill.style.width = computed ? `${Math.min(100, p * 100)}%` : "0";
            fill.setAttribute("data-level", !computed ? "none" : p >= 0.5 ? "bad" : p >= 0.3 ? "warn" : "good");
            el.setAttribute("data-computed", String(computed));
          });
        },
      }),
      h("p", {
        class: "muted small",
        text: () => study()?.overfit.interpretation ?? "Not run yet.",
      }),
      h(
        "div",
        { class: "metric-grid" },
        metricRow("Splits", () => String(study()?.overfit.splits ?? 0)),
        metricRow(
          "OOS positive",
          () => {
            const s2 = study();
            return s2 && s2.overfit.splits > 0 ? pct(s2.overfit.oosPositiveRate) : "—";
          },
          "How often the in-sample winner made money out of sample at all",
        ),
      ),
      pkWhy("PBO via combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado & Zhu). 0% means the in-sample winner always held up; 50% means selecting among these variants is a coin flip."),
    ),
  );

  // ------------------------------------------------------------- sweep ---

  const sweepTable = h("div", { class: "sweep-table" });
  renderEffect(() => {
    const s = study();
    clear(sweepTable);
    if (!s || s.configs.length === 0) {
      sweepTable.appendChild(h("p", { class: "muted small", text: "Not run yet." }));
      return;
    }
    sweepTable.appendChild(
      h(
        "div",
        { class: "sweep-row sweep-head" },
        h("span", { text: "Configuration" }),
        h("span", { text: "Trades" }),
        h("span", { text: "Exp. R" }),
        h("span", { text: "PF" }),
        h("span", { text: "MaxDD" }),
      ),
    );
    /**
     * Name each row by what actually distinguishes it.
     *
     * Three rows reading "EMA 20/50 trend" are three unreadable rows: the
     * family label is identical across reward-multiple variants, and a sweep
     * you cannot tell apart is a sweep you cannot learn anything from. Only
     * the parameters that VARY across this grid are appended, so the label
     * stays short when a family has one axis and grows only when it needs to.
     */
    const varying: string[] = [];
    const first = s.configs[0]?.params ?? {};
    for (const k of Object.keys(first)) {
      if (s.configs.some((c) => c.params[k] !== first[k])) varying.push(k);
    }
    const nameOf = (c: ConfigRow): string => {
      if (varying.length === 0) return c.label;
      return `${c.label} · ${varying.map((k) => `${k} ${c.params[k]}`).join(" ")}`;
    };

    for (const c of s.configs) {
      sweepTable.appendChild(
        h(
          "div",
          { class: "sweep-row", "data-best": String(c.id === s.best?.id) },
          h("span", { class: "sweep-name", text: nameOf(c), title: JSON.stringify(c.params) }),
          h("span", { class: "num", text: c.refused ? "—" : String(c.metrics.trades) }),
          h("span", { class: "num", text: c.refused ? "—" : r3(c.metrics.expectancyR) }),
          h("span", { class: "num", text: c.refused ? "—" : r2(c.metrics.profitFactor) }),
          h("span", { class: "num", text: c.refused ? "—" : pct(c.metrics.maxDrawdown) }),
        ),
      );
    }
  });

  const sweepCard = h(
    "section",
    { class: "panel span-all" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "The whole sweep" }),
      h("span", {
        class: "chip",
        text: () => `${study()?.configs.length ?? 0} configurations`,
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      sweepTable,
      pkWhy("Every variant tried, not just the winner. Seeing the losers is what makes the winner interpretable — if the whole column is positive the family works, and if only one row is, you found noise."),
    ),
  );

  // -------------------------------------------------------------- rules ---

  const rulesCard = h(
    "section",
    { class: "panel" },
    h("header", { class: "panel-head" }, h("h3", { class: "panel-title", text: "Rules" })),
    h(
      "div",
      { class: "panel-body" },
      h(
        "dl",
        { class: "kv" },
        h("dt", { text: "entry" }),
        h("dd", { text: () => study()?.rules?.entry ?? "—" }),
        h("dt", { text: "stop" }),
        h("dd", { text: () => study()?.rules?.stop ?? "—" }),
        h("dt", { text: "exit" }),
        h("dd", { text: () => study()?.rules?.exit ?? "—" }),
      ),
      pkWhy("The winner's rules in full. A rule you cannot read is a rule you cannot audit after a losing run."),
    ),
  );

  const warnList = h("div", { class: "warn-list" });
  renderEffect(() => {
    const s = study();
    clear(warnList);
    const ws = s?.warnings ?? [];
    if (ws.length === 0) return;
    for (const w of ws.slice(0, 8)) {
      warnList.appendChild(h("p", { class: "warn-item", text: w }));
    }
  });

  /**
   * The lattice, fed by the winning configuration's own trades.
   *
   * Directly under the equity curve on purpose. The curve is the most persuasive
   * and least informative object on this desk — it is captioned as arithmetic
   * rather than evidence for exactly that reason — and the lattice is the same
   * trades saying the thing the curve hides: a run that ended higher still lost
   * on most of its balls. Here that is the picture rather than a footnote.
   */
  const lattice = createLattice({
    trades: computed(() => study()?.bestRun?.trades ?? []),
    title: () => "Probability lattice — every trade, one ball",
  });

  /**
   * The flow, first. It shares the cost, risk and depth signals with the lab
   * and the lab's history loader, so there is one set of inputs and one way
   * of fetching bars on this desk.
   */
  const flow = createStrategyFlow({
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    settings: { spreadBp, commissionBp, slippageBp, carryBp, riskPct, depth },
    load: (hooks) => loadStudyBars(opts.history, opts.symbol.peek(), opts.timeframe.peek(), depth.peek(), () => opts.bars.peek(), hooks),
    ...(opts.kv ? { kv: opts.kv } : {}),
    ...(opts.session ? { session: opts.session } : {}),
  });

  /**
   * THE AUTONOMOUS MODE.
   *
   * Built beside the flow, not instead of it: Manual is everything this desk
   * has always been, untouched, and Autonomous is the terminal searching its
   * whole library at once. Both read the SAME costs, risk and depth signals and
   * the SAME history loader, so a rule tested by hand and a rule found by the
   * search were tested on the same bars at the same prices — which is the only
   * arrangement under which comparing them means anything.
   */
  const autonomous = createAutonomous({
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    settings: { spreadBp, commissionBp, slippageBp, carryBp, riskPct, depth },
    load: (hooks) => loadStudyBars(opts.history, opts.symbol.peek(), opts.timeframe.peek(), depth.peek(), () => opts.bars.peek(), hooks),
    ...(opts.shelf ? { shelf: opts.shelf } : {}),
    ...(opts.sweep ? { driver: opts.sweep } : {}),
    onOpenInManual: (spec) => {
      flow.loadSpec(spec);
      mode.set("manual");
    },
  });

  const modeBtn = (id: StrategyMode, label: string, title: string): HTMLElement =>
    h("button", {
      class: "seg-btn",
      type: "button",
      "data-mode": id,
      "aria-pressed": () => String(mode() === id),
      title,
      text: label,
      onclick: () => mode.set(id),
    });

  const el = h(
    "section",
    { class: "view view-strategy", "data-mode": () => mode() },
    h(
      "div",
      { class: "strat-modes" },
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Strategy mode" },
        modeBtn("manual", "Manual", "Describe an idea, edit the rules, backtest and decide — one strategy at a time"),
        modeBtn("autonomous", "Autonomous", "The terminal tests every rule it has, plus hybrids it composes, and keeps what survives the search"),
      ),
      h("span", {
        class: "muted small",
        text: () =>
          mode() === "manual"
            ? "You write a strategy with the AI and test it."
            : "The AI tests every strategy it has and tells you what the search cost. Nothing is armed and no order is placed.",
      }),
    ),
    h(
      "div",
      { class: "strat-mode-pane", "data-show": () => String(mode() === "manual") },
      flow.el,
      /* Everything the lab did, one click away. A <details> rather than a tab so
         it stays in the page's flow and its canvases size against real width. */
      h(
        "details",
        { class: "strat-lab" },
        h(
          "summary",
          { class: "strat-lab-sum" },
          h("span", { class: "strat-lab-title", text: "Family sweep — the full lab" }),
          h("span", {
            class: "muted small",
            text: "A sweep, a walk-forward and an overfitting probability over a whole family of settings, run together.",
          }),
        ),
        h("div", { class: "view-grid" }, setupCard, headlineCard, gateCard, equityCard, lattice.el, mcCard, monkeyCard, excursionCard, walkCard, regimeCard, pboCard, rulesCard, sweepCard),
        warnList,
      ),
    ),
    h("div", { class: "strat-mode-pane", "data-show": () => String(mode() === "autonomous") }, autonomous.el),
  );

  return { el, mode, autonomous, flow };
}
