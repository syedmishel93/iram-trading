/**
 * The fourteen things a study can do to its bars, and the dispatch that picks
 * one.
 *
 * SPLIT OUT OF `run.ts`, which was 1,096 lines holding two jobs: deciding what
 * to run and in what order, and actually running each thing. This file is the
 * second job. The first stayed behind.
 *
 * ALMOST NOTHING HERE COMPUTES ANYTHING. The sweep is `backtest/lab.ts`, the
 * walk-forward and the CSCV are `backtest/validate.ts`, the regime labels are
 * `backtest/regime.ts`, the volatility model and the calibrated classifier are
 * the quant service, the join is `data/panel.ts`. Every one of those already
 * worked and every one of them was on a different desk, asked a different
 * question, against a different set of bars. These functions aim them at ONE
 * window and return one shape.
 *
 * A REFUSAL IS A RESULT. Every step returns `ok`, `refused` or `offline`, and
 * all three are recorded and shown. A study where nine steps ran and two
 * refused is a study with eleven findings, two of which are about the archive.
 *
 * WHY THE SPLIT IS SAFE, WHICH IT WAS NOT BEFORE v57. The sweep steps hand
 * their winner to the excursion and Monte-Carlo steps. That used to travel
 * through a module-level `let`, and moving it across a file boundary would
 * have turned a contained hack into a mutable global shared by two modules.
 * It is now `StepInput.carry`, scoped to one run, so this is a pure move.
 */

import type { BarView } from "../chart/series";
import type { Range } from "../store/segments";
import { panelPayload, panelRefusal, type Panel } from "../data/panel";
import { buildMatrix, type ClosesSeries } from "../data/correlation";
import { quant, type QuantResult } from "../data/quant";
import { REGIME_LABEL, type Regime } from "../backtest/regime";
import { runStudy, type Family, type Study as LabStudy } from "../backtest/lab";
import { monteCarlo } from "../backtest/montecarlo";
import { readExcursions } from "../backtest/excursion";
import { DEFAULT_COSTS, ZERO_COSTS, type Costs } from "../backtest/engine";
import { spreadFraction, type BrokerSpec } from "../data/brokercosts";
import {
  costsOf,
  foldsOf,
  type CostModel,
  type SeriesRole,
  type StudySpec } from "./spec";
import {
  type JointWindow,
  type Split } from "./window";
import { MAX_LAG } from "./methods";
import {
  baseRates,
  columnSeries,
  lagProfile,
  leadLagSentence,
  subjectSeries,
  type LagProfile,
  type ResultRow } from "./findings";
import { twoSidedP } from "./stats";

export interface LoadedSeries {
  readonly symbol: string;
  readonly label: string;
  readonly role: SeriesRole;
  readonly bars: readonly BarView[];
  readonly gaps: readonly Range[];
  readonly coverage: number | null;
  readonly source: string;
}

/**
 * A step that pits a model against a baseline, and how that came out.
 *
 * STRUCTURED, NOT READ BACK OUT OF THE ROWS. The steered Research flow says
 * "which model won" in a sentence, and the only other way to get that is to
 * find the row labelled "Winner" and parse its text — which silently stops
 * working the day a label is reworded. The step that ran the contest is the
 * one owner of who won it.
 */
export interface Contest {
  /** What won, in the service's or the lab's own name for it. */
  readonly winner: string;
  /** What it had to beat. */
  readonly baseline: string;
  /** Whether the winner beat the baseline. Null when the step cannot say. */
  readonly beat: boolean | null;
  /** The margin, with its unit — never a bare number. */
  readonly by: string;
}

export type Outcome =
  | {
      readonly state: "ok";
      readonly ms: number;
      readonly headline: string;
      readonly rows: readonly ResultRow[];
      readonly caveats: readonly string[];
      readonly profiles: readonly LagProfile[];
      /** Raw p-values this step produced, each with what it is about. */
      readonly pValues: readonly { readonly label: string; readonly p: number }[];
      /** Present only on steps that compare a model with a baseline. */
      readonly contest?: Contest;
    }
  /** It ran and declined to answer. The reason is about the data. */
  | { readonly state: "refused"; readonly reason: string }
  /** It could not run at all. The reason is about the machine. */
  | { readonly state: "offline"; readonly reason: string };

/** Bars inside [from, to], inclusive. */
export function clipBars(bars: readonly BarView[], from: number, to: number): BarView[] {
  return bars.filter((b) => b.t >= from && b.t <= to);
}

/**
 * A monotonic-ish clock for step timings.
 *
 * `performance.now()` where it exists, `Date.now()` otherwise — the timings
 * feed `recordTiming`, which turns a declared guess into a measured estimate,
 * and a clock that jumps backwards over an NTP correction would poison that
 * average for sixteen runs.
 */
export const clock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const r3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "—");

const ok = (
  ms: number,
  headline: string,
  rows: readonly ResultRow[],
  caveats: readonly string[] = [],
  profiles: readonly LagProfile[] = [],
  pValues: readonly { label: string; p: number }[] = [],
  contest?: Contest,
): Outcome => ({ state: "ok", ms, headline, rows, caveats, profiles, pValues, ...(contest === undefined ? {} : { contest }) });

/**
 * Translate a service result into an outcome without losing which kind of
 * failure it was.
 *
 * `refused` and `offline` are not interchangeable and the desk shows them
 * differently: one means the data could not support the answer, the other
 * means the service is not running. Collapsing them into "failed" is how an
 * operator spends an afternoon on a data problem that was a stopped process.
 */
function fromQuant<T>(r: QuantResult<T>, render: (v: T, ms: number) => Outcome): Outcome {
  if (r.state === "ok") return render(r.value, r.ms);
  return r.state === "refused"
    ? { state: "refused", reason: r.reason }
    : { state: "offline", reason: r.reason };
}

interface StepInput {
  readonly spec: StudySpec;
  readonly panel: Panel;
  readonly rows: number;
  readonly subjectBars: readonly BarView[];
  readonly trainBars: readonly BarView[];
  /** The broker's contract specs, when any have been synced. Absent is normal. */
  readonly brokerSpecs?: Readonly<Record<string, BrokerSpec>>;
  readonly featureSeries: readonly LoadedSeries[];
  readonly rowRegimes: readonly (Regime | null)[];
  readonly split: Split;
  readonly win: JointWindow;
  /**
   * Where a sweep leaves its winner for the steps that read one.
   *
   * MUTABLE AND PER-RUN, on purpose. The first version was a module-level
   * `let`, which worked only because one `runStudySpec` call holds the thread
   * from start to finish — two studies running at once would have had the
   * second one's excursions measured against the first one's trades, with
   * nothing on screen to suggest it. A carrier scoped to the run cannot do
   * that however the caller schedules it.
   *
   * `runOne` still returns only an Outcome. Threading a `LabStudy | null`
   * through fourteen signatures to serve three of them is the alternative
   * this avoids.
   */
  readonly carry: { best: LabStudy | null };
  readonly tests: number;
  readonly hypotheses: number;
}

export async function runOne(id: string, s: StepInput): Promise<Outcome> {
  switch (id) {
    case "leadlag":
      return leadLagStep(s);
    case "corrmatrix":
      return corrStep(s);
    case "stationarity":
      return fromQuant(await quant.structure(s.trainBars), (v, ms) =>
        ok(
          ms,
          v.note,
          [
            { label: "Call", value: v.call },
            { label: "ADF", value: `p ${r3(v.adf.p_value)}`, note: "Null: there is a unit root — the series wanders." },
            { label: "KPSS", value: `p ${r3(v.kpss.p_value)}`, note: "Null: the series is stationary. The two nulls are opposites on purpose." },
            { label: "Variance ratio", value: v.vr_note },
          ],
          [v.basis],
          [],
          [
            { label: "ADF unit root", p: v.adf.p_value },
            { label: "KPSS stationarity", p: v.kpss.p_value },
          ],
        ),
      );
    case "crossasset":
      return crossAssetStep(s);
    case "regimes":
      return regimeStep(s);
    case "garch":
      return fromQuant(await quant.volatility(s.trainBars, s.spec.horizon), (v, ms) => {
        const lev = v.leverage;
        return ok(
          ms,
          v.verdict,
          [
            { label: "Winner", value: v.winner },
            { label: "Baseline", value: `${v.baseline.name} · QLIKE ${r3(v.baseline.qlike)}` },
            {
              label: "Margin over baseline",
              value: v.margin_pct === undefined ? "—" : `${v.margin_pct.toFixed(1)}%`,
              ...(v.margin_pct !== undefined && v.margin_pct > 0
                ? { tone: "pos" as const }
                : {}) },
            ...(lev === undefined
              ? []
              : [
                  {
                    label: "Leverage effect",
                    value: `γ ${r3(lev.gamma)} · p ${r3(lev.p_value)}`,
                    note: lev.note },
                ]),
          ],
          [v.basis],
          [],
          lev === undefined ? [] : [{ label: "Volatility asymmetry", p: lev.p_value }],
          {
            winner: v.winner,
            baseline: v.baseline.name,
            beat: v.margin_pct === undefined ? null : v.winner !== v.baseline.name && v.margin_pct > 0,
            by: v.margin_pct === undefined ? "no margin reported" : `${v.margin_pct.toFixed(1)}% on QLIKE, out of sample`,
          },
        );
      });
    case "seasonality":
      return fromQuant(await quant.seasonality(s.trainBars), (v, ms) =>
        ok(
          ms,
          v.verdict,
          [
            { label: "Strength", value: v.strength },
            { label: "Explained variance", value: pct(v.explained_variance) },
            ...(v.busiest_hour_utc === undefined
              ? []
              : [{ label: "Busiest hour", value: `${String(v.busiest_hour_utc).padStart(2, "0")}:00 UTC`, ...(v.intraday_note !== undefined ? { note: v.intraday_note } : {}) }]),
            ...(v.busiest_day === undefined
              ? []
              : [{ label: "Busiest day", value: v.busiest_day, ...(v.weekly_note !== undefined ? { note: v.weekly_note } : {}) }]),
          ],
          [v.basis],
        ),
      );
    case "baserates":
      return baseRateStep(s);
    case "classifier":
      return classifierStep(s);
    case "edge":
      return edgeStep(s);
    case "sweep-ema":
      return sweepStep(s, "ema");
    case "sweep-rsi":
      return sweepStep(s, "rsi");
    case "sweep-confluence":
      return sweepStep(s, "confluence");
    case "excursion":
      return excursionStep(s);
    case "montecarlo":
      return monteCarloStep(s);
    default:
      return {
        state: "refused",
        reason: `No runner is registered for "${id}". It is in the catalogue and nothing executes it — that is a defect, not a data problem.` };
  }
}

/* ── local steps ───────────────────────────────────────────────────────── */

function leadLagStep(s: StepInput): Outcome {
  const t0 = clock();
  const refusal = panelRefusal(s.panel, 200);
  if (refusal !== null) return { state: "refused", reason: refusal };

  const subject = subjectSeries(s.panel.rows);
  const profiles: LagProfile[] = [];
  s.panel.columns.forEach((col, i) => {
    /* Only DRIVER columns. A peer correlating with the subject at lag 0 is
       the definition of a peer and is not a finding; running it here would
       add ninety-seven hypotheses per peer to the correction for nothing. */
    const series = s.featureSeries.find((f) => f.symbol === col.symbol);
    if (series === undefined || series.role !== "driver") return;
    profiles.push(lagProfile(col.symbol, col.label, columnSeries(s.panel.rows, i), subject, MAX_LAG));
  });

  if (profiles.length === 0) {
    return {
      state: "refused",
      reason:
        "No column in this study is marked Driver, so there is nothing that is allowed to lead. Change a series' role on the Subject step." };
  }

  const subjectLabel = s.spec.symbol;
  const sentences = profiles
    .map((p) => leadLagSentence(p, subjectLabel))
    .filter((x): x is string => x !== null);

  const rows: ResultRow[] = profiles.map((p) => {
    const top = p.clears[0];
    if (top === undefined) {
      return {
        label: p.label,
        value: "nothing clears the band",
        note: `Largest was ${r2(p.best?.r ?? NaN)} at lag ${p.best?.lag ?? 0}; the noise band is ±${r2(p.band)}.` };
    }
    return {
      label: p.label,
      value: `${top.r >= 0 ? "+" : ""}${top.r.toFixed(2)} at lag ${top.lag}`,
      note: `${top.lag > 0 ? "It moves first." : top.lag < 0 ? `${subjectLabel} moves first.` : "Same bar — not a lead."} Band ±${r2(p.band)} on ${top.n.toLocaleString()} pairs.`,
      ...(top.lag > 0 ? { tone: "pos" as const } : {}) };
  });

  return ok(
    clock() - t0,
    sentences[0] ??
      `Nothing led ${subjectLabel} by more than the noise band over this window. That is a result, and a common one.`,
    rows,
    [
      `Each profile is ${2 * MAX_LAG + 1} lags, so ${profiles.length} driver${profiles.length === 1 ? "" : "s"} is ${s.tests.toLocaleString()} tests. The band is where a single test would sit; the correction at the bottom is what accounts for having run all of them.`,
    ],
    profiles,
    profiles.map((p) => ({ label: `${p.label} lead`, p: p.bestP })),
  );
}

function corrStep(s: StepInput): Outcome {
  const t0 = clock();
  const series: ClosesSeries[] = [
    { symbol: s.spec.symbol, closes: s.subjectBars.map((b) => ({ t: b.t, c: b.c })) },
    ...s.featureSeries.map((f) => ({
      symbol: f.symbol,
      closes: clipBars(f.bars, s.win.from, s.win.to).map((b) => ({ t: b.t, c: b.c })) })),
  ];
  const m = buildMatrix(series);
  if (m.pairs.length === 0) {
    return { state: "refused", reason: "There is only one series with bars in it, so there are no pairs to correlate." };
  }
  const rows: ResultRow[] = m.pairs.slice(0, 10).map((p) => ({
    label: `${p.a} · ${p.b}`,
    value: Number.isFinite(p.r) ? r2(p.r) : "—",
    note: `${p.overlap.toLocaleString()} overlapping bars`,
    ...(Math.abs(p.r) >= 0.8 ? { tone: "attn" as const } : {}),
    ...(Number.isFinite(p.r) ? {} : { withheld: "The overlap was too short to mean anything." }) }));
  const caveats = [m.note];
  if (m.clustered.length > 0) {
    caveats.push(
      `${m.clustered.length} pair${m.clustered.length === 1 ? " is" : "s are"} correlated above 0.8. Those are one series wearing two names, and every count of "how many series agreed" in this study is overstated by that much.`,
    );
  }
  return ok(
    clock() - t0,
    m.clustered.length > 0
      ? `${m.clustered.length} of the series you added are the same bet as another one.`
      : "No pair in this study is close enough to be double-counting.",
    rows,
    caveats,
  );
}

function regimeStep(s: StepInput): Outcome {
  const t0 = clock();
  const counts = new Map<string, number>();
  for (const r of s.rowRegimes) counts.set(r ?? "unclassified", (counts.get(r ?? "unclassified") ?? 0) + 1);
  const total = s.rowRegimes.length;
  if (total === 0) return { state: "refused", reason: "No rows to classify." };

  const rows: ResultRow[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({
      label: key === "unclassified" ? "Unclassified" : (REGIME_LABEL[key as Regime] ?? key),
      value: `${pct(n / total)} · ${n.toLocaleString()} bars`,
      ...(n / total < 0.1 ? { tone: "attn" as const } : {}) }));

  const thin = rows.filter((r) => r.tone === "attn").length;
  return ok(
    clock() - t0,
    thin > 0
      ? `This window is not a balanced sample of conditions — ${thin} of ${rows.length} covers under a tenth of it.`
      : "All three conditions are represented in this window.",
    rows,
    thin > 0
      ? [
          "A result that holds across this window holds across the conditions this window happened to contain. That is not the same as holding in general, and the thin slices are where it is least tested.",
        ]
      : [],
  );
}

function baseRateStep(s: StepInput): Outcome {
  const t0 = clock();
  const table = baseRates(s.panel.rows, s.rowRegimes, s.spec.horizon);
  if (table.pooled.withheld !== null) {
    return { state: "refused", reason: table.pooled.withheld };
  }
  const rows: ResultRow[] = [table.pooled, ...table.cells].map((c) =>
    c.withheld !== null
      ? { label: c.label, value: "—", withheld: c.withheld }
      : {
          label: c.label,
          value: `${pct(c.up)} up · ${c.meanBp >= 0 ? "+" : ""}${c.meanBp.toFixed(0)}bp mean`,
          note: `${c.n.toLocaleString()} observations` },
  );

  const best = table.cells.filter((c) => c.withheld === null).sort((a, b) => b.up - a.up)[0];
  return ok(
    clock() - t0,
    best === undefined
      ? `Over ${s.spec.horizon} bars the subject rose ${pct(table.pooled.up)} of the time. No condition had enough observations to say whether that differs by condition.`
      : `Over ${s.spec.horizon} bars the subject rose ${pct(table.pooled.up)} of the time overall, and ${pct(best.up)} of the time in ${best.label.toLowerCase()}.`,
    rows,
    table.caveats,
  );
}

/**
 * What a study's rule tests are charged.
 *
 * `measured` reads the SPREAD from the broker's contract spec for this symbol,
 * keeping commission and slippage at the engine's assumption — a broker's
 * commission is per-lot and account-specific and slippage belongs to the venue,
 * so reading either off an instrument would be a third model that is neither
 * measured nor assumed.
 *
 * IT FALLS BACK TO `standard` RATHER THAN GUESSING. No spec synced, a spec that
 * gives no usable spread, or no price to make a spread-in-points into a
 * fraction, and the assumption stands. A study charged a made-up spread would be
 * worse than one charged the assumption, because the result would look the same
 * either way — and the assumption is the HARSHER end, so the fallback cannot
 * manufacture an edge.
 */
export function studyCosts(
  model: CostModel,
  symbol: string,
  bars: readonly BarView[],
  specs: Readonly<Record<string, BrokerSpec>> | undefined,
): Costs {
  if (model === "none") return ZERO_COSTS;
  if (model !== "measured" || specs === undefined) return DEFAULT_COSTS;

  /* Filed under BOTH the canonical name and the broker's suffixed one, because
     a broker quotes `XAUUSD.s` and the terminal says `XAUUSD` — the pair that
     cost a release when sizing could find neither. */
  const want = symbol.toUpperCase();
  const spec =
    specs[want] ??
    specs[`${want}.S`] ??
    Object.entries(specs).find(([k]) => k.toUpperCase().split(".")[0] === want)?.[1];
  if (spec === undefined) return DEFAULT_COSTS;

  const last = bars[bars.length - 1];
  const price = last?.c;
  if (price === undefined || !(price > 0)) return DEFAULT_COSTS;

  const spread = spreadFraction(spec, price);
  if (spread === null || !(spread > 0)) return DEFAULT_COSTS;
  return { ...DEFAULT_COSTS, spread };
}

function sweepStep(s: StepInput, family: Family): Outcome {
  const t0 = clock();
  /* TRAINING BARS ONLY. The sweep chooses a configuration, and a configuration
     chosen having seen the validation segment is a configuration that has been
     fitted to it. `runStudy` does its own purged walk-forward inside these
     bars; the outer split is what keeps validate and holdout clean. */
  /* The operator's How-strict choices, and ONLY here: rounds and costs mean
     something to a rule that trades, and nothing to a correlation. */
  const study = runStudy(family, s.trainBars, {
    folds: foldsOf(s.spec),
    costs: studyCosts(costsOf(s.spec), s.spec.symbol, s.trainBars, s.brokerSpecs),
  });
  if (study.best === null || study.headline.standing === "refused") {
    return { state: "refused", reason: study.headline.why };
  }
  /* The BEST sweep across the families that ran, not the last one — three rule
     families are three separate searches and the deflation is about the best
     result of all of them. Compared on the walk-forward Sharpe, which is the
     out-of-sample figure; ranking on the in-sample one would pick whichever
     family overfits hardest. */
  const prev = s.carry.best;
  if (prev === null || study.walk.aggregate.sharpe > prev.walk.aggregate.sharpe) {
    s.carry.best = study;
  }
  const m = study.walk.aggregate;
  const rows: ResultRow[] = [
    { label: "Standing", value: study.headline.verdict, ...(study.headline.standing === "survived" ? { tone: "pos" as const } : study.headline.standing === "no-edge" ? { tone: "neg" as const } : { tone: "attn" as const }) },
    { label: "Best configuration", value: study.best.label },
    { label: "Out-of-sample trades", value: m.trades.toLocaleString(), note: "Folds, walked forward, purged." },
    { label: "Out-of-sample Sharpe", value: r2(m.sharpe), note: "Before the correction at the bottom of this report." },
    { label: "Expectancy", value: `${m.expectancyR >= 0 ? "+" : ""}${r2(m.expectancyR)}R` },
    { label: "Overfitting probability", value: r2(study.overfit.pbo), note: study.overfit.interpretation, ...(study.overfit.pbo > 0.5 ? { tone: "neg" as const } : {}) },
    ...(study.grossMetrics === null
      ? []
      : [{ label: "Same rule, no costs", value: `${r2(study.grossMetrics.sharpe)} Sharpe`, note: "Distinguishes no edge from an edge the frictions eat." }]),
  ];
  return ok(clock() - t0, study.headline.why, rows, study.warnings, [], [], {
    winner: study.best.label,
    baseline: "not trading",
    beat: study.headline.standing === "survived",
    by: `${r2(m.sharpe)} Sharpe over ${m.trades.toLocaleString()} out-of-sample trades, ${costsOf(s.spec) === "none" ? "with costs off" : "after costs"}`,
  });
}

function excursionStep(s: StepInput): Outcome {
  const t0 = clock();
  const trades = s.carry.best?.bestRun?.trades ?? [];
  if (trades.length === 0) {
    return { state: "refused", reason: "The rule that won the sweep produced no trades, so there are no excursions to measure." };
  }
  const read = readExcursions(trades);
  if (read.refused !== null) return { state: "refused", reason: read.refused };
  const rows: ResultRow[] = [
    { label: "Winners went against you", value: `${r2(read.winnerMaeP50)}R median`, note: `90th percentile ${r2(read.winnerMaeP90)}R — a stop inside that would have taken you out of trades that went on to win.` },
    { label: "Losers were once up", value: `${r2(read.loserMfeP50)}R median`, note: `${pct(read.losersOnceUp1R)} of losers were at least 1R in profit before they lost.` },
    ...(read.captureP50 === null
      ? []
      : [{ label: "Kept of the best move", value: pct(read.captureP50), note: `Excludes the ${read.targetWinners} winners that exited at their target — their capture is 100% by construction.` }]),
  ];
  return ok(clock() - t0, `Winners went ${r2(read.winnerMaeP50)}R against you before they worked.`, rows);
}

function monteCarloStep(s: StepInput): Outcome {
  const t0 = clock();
  const trades = s.carry.best?.bestRun?.trades ?? [];
  const rMultiples = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  if (rMultiples.length === 0) {
    return { state: "refused", reason: "The rule that won the sweep produced no trades to reshuffle." };
  }
  const mc = monteCarlo(rMultiples, 0.01);
  if (mc.refused !== null) return { state: "refused", reason: mc.refused };
  const rows: ResultRow[] = [
    { label: "Drawdown, median path", value: pct(mc.maxDrawdown.p50) },
    { label: "Drawdown, bad path", value: pct(mc.maxDrawdown.p95), note: "95th percentile. This is the one to size against, not the median.", tone: "attn" },
    { label: "Longest losing run", value: `${Math.round(mc.losingStreak.p95)} trades`, note: "95th percentile — what you should expect to sit through." },
    { label: "Chance of a 30% drawdown", value: pct(mc.ruinProbability), ...(mc.ruinProbability > 0.1 ? { tone: "neg" as const } : {}) },
  ];
  return ok(
    clock() - t0,
    `Reordered ${mc.draws.toLocaleString()} ways, the same edge produced a ${pct(mc.maxDrawdown.p95)} drawdown one time in twenty.`,
    rows,
    [`At 1% risk per trade over ${mc.trades} trades, ${mc.mode === "bootstrap" ? "resampled with replacement" : "reshuffled"}. Every path has the same edge in it — the spread is what ORDER alone does.`],
  );
}

/* ── service steps ─────────────────────────────────────────────────────── */

async function classifierStep(s: StepInput): Promise<Outcome> {
  return fromQuant(await quant.classify(s.trainBars, s.spec.horizon), (v, ms) => {
    const best = v.models[v.best];
    const rows: ResultRow[] = [
      { label: "Base rate", value: pct(v.base_rate), note: "What guessing the majority would score. Any model below this is worse than a coin that knows the coin." },
      { label: "Best model", value: v.best },
      {
        label: "AUC",
        value: r3(best?.auc ?? NaN),
        ...(best?.auc_floor === undefined ? {} : { note: `Floor from the folds: ${r3(best.auc_floor)}` }) },
      { label: "Brier", value: r3(best?.brier ?? NaN), note: "Lower is better. Measures whether a 60% happens 60% of the time, which accuracy does not." },
      { label: "Skill over the base rate", value: best?.skill === undefined ? "—" : pct(best.skill), ...(best?.beats_coin === true ? { tone: "pos" as const } : { tone: "neg" as const }) },
    ];
    return ok(ms, v.verdict, rows, [v.caveat, v.basis], [], [], {
      winner: v.best,
      baseline: "the base rate",
      beat: best?.beats_coin ?? null,
      by: best?.skill === undefined ? "no skill figure reported" : `${pct(best.skill)} skill on Brier, out of sample`,
    });
  });
}

async function edgeStep(s: StepInput): Promise<Outcome> {
  const closes = s.trainBars.map((b) => b.c);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a !== undefined && b !== undefined && a > 0) returns.push(Math.log(b / a));
  }
  return fromQuant(await quant.edge(returns), (v, ms) =>
    ok(
      ms,
      v.verdict,
      [
        { label: "Mean return per bar", value: `${(v.mean * 10_000).toFixed(2)}bp` },
        { label: "t", value: r2(v.t_stat), note: `Naive standard error ${r3(v.se_naive)}, HAC ${r3(v.se_hac)}${v.inflation === null ? "" : ` — serial correlation inflates it by ${v.inflation.toFixed(2)}×`}.` },
        { label: "p", value: r3(v.p_value), ...(v.significant ? { tone: "pos" as const } : {}) },
        { label: "Independence", value: v.independence.independent ? "holds" : "fails", note: v.independence.note },
      ],
      [v.caveat, v.basis],
      [],
      [{ label: "Mean return differs from zero", p: v.p_value }],
    ),
  );
}

async function crossAssetStep(s: StepInput): Promise<Outcome> {
  const refusal = panelRefusal(s.panel, 500);
  if (refusal !== null) return { state: "refused", reason: refusal };
  const payload = panelPayload(s.panel);
  return fromQuant(await quant.crossAsset(payload), (v, ms) =>
    ok(
      ms,
      v.verdict,
      [
        { label: "Subject alone", value: `AUC ${r3(v.baseline.auc)}`, note: `± ${r3(v.baseline.se)}` },
        { label: "With the drivers", value: `AUC ${r3(v.full.auc)}`, note: `± ${r3(v.full.se)}` },
        { label: "What the drivers added", value: `${v.delta_auc >= 0 ? "+" : ""}${r3(v.delta_auc)}`, note: `${r2(v.delta_sigmas)} standard errors.`, ...(v.adds_information ? { tone: "pos" as const } : { tone: "neg" as const }) },
        ...v.contributions.slice(0, 4).map((c) => ({ label: c.column, value: `${c.coef >= 0 ? "+" : ""}${r3(c.coef)}`, note: "Coefficient, not an effect. It is what the fit leaned on, not what causes anything." })),
      ],
      v.notes,
      [],
      [{ label: "Drivers add information", p: twoSidedP(v.delta_sigmas) }],
      {
        winner: v.adds_information ? "the subject with the related assets" : "the subject on its own",
        baseline: "the subject on its own",
        beat: v.adds_information,
        by: `${v.delta_auc >= 0 ? "+" : ""}${r3(v.delta_auc)} AUC, ${r2(v.delta_sigmas)} standard errors`,
      },
    ),
  );
}
