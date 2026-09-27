/**
 * The quant desk — the terminal's front end to `server/quant`.
 *
 * WHY EVERY PANEL HAS A BUTTON AND NOTHING RUNS ON ITS OWN
 * These models take between two seconds and a minute. A desk that fitted a
 * GARCH model every time you changed symbol would spend its life computing
 * answers to questions nobody asked, and the one you did ask would be queued
 * behind them. So each panel runs when you press its button, and says when it
 * last ran.
 *
 * WHY A REFUSAL IS RENDERED AS PROMINENTLY AS A RESULT
 * Because it usually IS the result. "There is no learnable pattern here at this
 * horizon" is the most common honest answer the classifier gives, and the
 * whole point of building it was to be able to hear that. A panel that showed
 * refusals in small grey text at the bottom would be a panel designed to be
 * ignored when it disagrees with you.
 *
 * WHY THE SERVICE BEING OFFLINE LOOKS DIFFERENT FROM A REFUSAL
 * One means "the answer is no", the other means "nobody was asked". They are
 * different facts and the desk never lets them share a rendering — the same
 * distinction `honest()` enforces on the live bar and `macroLine` enforces on
 * the decision desk.
 */

import { h } from "./dom";
import { pkWhy } from "./panelkit";
import { computed, signal } from "../core/signal";
import {
  quant,
  quantHealth,
  quantLine,
  quantSlot,
  type CausalResult,
  type ClassifyResult,
  type EdgeResult,
  type KellyResult,
  type QuantHealth,
  type QuantResult,
  type SeasonalityResult,
  type StructureResult,
  type VolatilityResult,
} from "../data/quant";
import type { BarView } from "../chart/series";
import { driversFor } from "../data/drivers";
import type { CrossAssetResult, ScriptResult } from "../data/quant";
import { buildPanel, panelPayload, panelRefusal } from "../data/panel";
import type { RunDraft } from "../learn/run";

export interface QuantDeskOptions {
  readonly symbol: () => string;
  readonly timeframe: () => string;
  readonly bars: () => readonly BarView[];
  /**
   * Closed trades, already shaped for the causal endpoint. Null when the
   * journal has none — the desk then says so rather than calling and being
   * refused, because a round trip to be told what we already know is noise.
   */
  readonly trades: () => readonly Record<string, unknown>[];
  /** Realised R of every closed trade, in the order taken. Order matters. */
  readonly returns: () => readonly number[];
  /**
   * Bars held for one of this instrument's declared drivers, or an empty
   * array when that series has not been loaded.
   *
   * Empty rather than null, and the panel reports how many drivers are absent
   * rather than quietly fitting on the ones that happen to be there — a model
   * trained on two of five columns is not the model the panel says it is.
   */
  readonly driverBars: (symbol: string) => readonly BarView[];
  /**
   * Fetch the declared drivers for the current instrument.
   *
   * On request, never on a timer — five extra series per symbol change is how
   * a terminal earns a rate-limit ban on the user's behalf. The panel awaits
   * this as the first step of its own run, so loading is one click rather
   * than a separate chore.
   */
  readonly ensureDrivers: () => Promise<void>;
  /**
   * Keep a finished fit, so it can be compared with the same fit next month.
   *
   * This service holds no state by design — see its own header — which left
   * every result it produced un-comparable with every other. Handing the
   * summary to the Learning desk is what turns a fit into a series, and
   * "does it still say what it said last time" is the only question about a
   * model that a fresh score cannot answer.
   *
   * Optional so the desk still builds in a test with no store attached.
   */
  readonly keep?: (draft: RunDraft) => void;
}

const pct = (v: number | undefined | null, dp = 1): string =>
  v === undefined || v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
const num = (v: number | undefined | null, dp = 3): string =>
  v === undefined || v === null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

/**
 * A p-value a person can read.
 *
 * The leverage panel printed `p = 6.5e-1`. That is 0.65 — a result so far from
 * significant that the panel's own sentence beside it says "no measurable
 * asymmetry" — and it was rendered in the notation reserved for numbers too
 * small to write out. Scientific notation on a p-value between 0.001 and 1 is
 * pure friction: the reader has to decode an exponent to discover the number
 * was ordinary all along, and the ones who decode it wrongly read 6.5e-1 as
 * very small and conclude the opposite of what the panel said.
 *
 * So: plain decimals across the range anyone argues about, and `< 0.001` below
 * it, because at that point the exact value carries no more information than
 * the threshold does.
 */
const pval = (v: number | undefined | null): string => {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  if (v < 0.001) return "< 0.001";
  return v.toFixed(3);
};

/**
 * The frame every panel shares: a title, a run button, a status line, a body.
 *
 * Factored out because the alternative — eight panels each rendering their own
 * status handling — is eight chances for one of them to swallow a refusal.
 */
function panel<T>(opts: {
  title: string;
  blurb: string;
  slot: ReturnType<typeof quantSlot<T>>;
  canRun: () => { ok: true } | { ok: false; why: string };
  run: () => void;
  body: (value: T) => HTMLElement;
}): HTMLElement {
  const gate = () => opts.canRun();

  return h(
    "section",
    { class: "qd-panel" },
    h(
      "div",
      { class: "qd-head" },
      h(
        "div",
        { class: "qd-head-text" },
        h("h3", { class: "qd-title", text: opts.title }),
        pkWhy(opts.blurb),
      ),
      h("button", {
        class: "qd-run",
        type: "button",
        text: () => (opts.slot.busy() ? "Running…" : "Run"),
        disabled: () => opts.slot.busy() || !gate().ok,
        title: () => {
          const g = gate();
          return g.ok ? `Run ${opts.title}` : g.why;
        },
        onclick: () => opts.run(),
      }),
    ),

    h("p", {
      class: "qd-status",
      "data-state": () => {
        const g = gate();
        if (!g.ok) return "blocked";
        if (opts.slot.busy()) return "busy";
        const r = opts.slot.result();
        return r === null ? "idle" : r.state;
      },
      text: () => {
        const g = gate();
        if (!g.ok && !opts.slot.busy()) return g.why;
        return quantLine(opts.slot.result(), opts.slot.busy());
      },
    }),

    /* A reactive child must resolve to ONE node, so an empty state is an
       empty wrapper rather than an empty array. */
    h("div", { class: "qd-body" }, () => {
      const r = opts.slot.result();
      return r === null || r.state !== "ok" ? h("div", { class: "qd-empty" }) : opts.body(r.value);
    }),

  ) as HTMLElement;
}

/** A labelled figure. */
const stat = (label: string, value: string, tone?: string): HTMLElement =>
  h(
    "div",
    { class: "qd-stat", ...(tone ? { "data-tone": tone } : {}) },
    h("span", { class: "qd-stat-label", text: label }),
    h("span", { class: "qd-stat-value num", text: value }),
  ) as HTMLElement;

/** The sentence a model leads with. Always rendered, never truncated. */
const verdict = (text: string): HTMLElement =>
  h("p", { class: "qd-verdict", text }) as HTMLElement;

const caveat = (text: string): HTMLElement =>
  h("p", { class: "qd-caveat", text }) as HTMLElement;

export function createQuantDesk(opts: QuantDeskOptions): HTMLElement {
  const health = signal<QuantResult<QuantHealth> | null>(null);
  const checking = signal(false);

  const check = (): void => {
    if (checking()) return;
    checking.set(true);
    void quantHealth()
      .then((r) => health.set(r))
      .finally(() => checking.set(false));
  };
  /* One check at construction. The desk is only built when the view is opened,
     so this is not a call on every symbol change. */
  check();

  const online = computed(() => health()?.state === "ok");

  const enoughBars = (n: number) => (): { ok: true } | { ok: false; why: string } => {
    if (!online()) return { ok: false, why: "The quant service is not running." };
    const have = opts.bars().length;
    return have >= n
      ? { ok: true }
      : { ok: false, why: `${have} bars loaded; this needs at least ${n}.` };
  };

  const enoughTrades = (n: number) => (): { ok: true } | { ok: false; why: string } => {
    if (!online()) return { ok: false, why: "The quant service is not running." };
    const have = opts.returns().length;
    return have >= n
      ? { ok: true }
      : { ok: false, why: `${have} closed trades; this needs at least ${n}.` };
  };

  /**
   * Shape a finished fit for the Learning desk.
   *
   * ONLY WHAT IS COMPARABLE IS KEPT. The headline score, the shape of the data
   * it came from, and the service's own sentence — a few hundred bytes. Not
   * the model: these refit in seconds from bars already in memory, and a
   * serialised booster in localStorage would be a megabyte of weights nothing
   * in this application can load. Storing a model you cannot run is a museum.
   */
  const barSpan = (bars: readonly BarView[]): { fromBar: number | null; toBar: number | null } => ({
    fromBar: bars.length > 0 ? (bars[0] as BarView).t : null,
    toBar: bars.length > 0 ? (bars[bars.length - 1] as BarView).t : null,
  });

  const keepClassify = (v: ClassifyResult, bars: readonly BarView[]): void => {
    const best = v.models[v.best];
    opts.keep?.({
      kind: "classify",
      symbol: opts.symbol(),
      timeframe: opts.timeframe(),
      bars: v.n_bars,
      ...barSpan(bars),
      metric: typeof best?.auc === "number" ? best.auc : null,
      metricName: "AUC",
      /* `beats_coin` is computed against a sample-size-aware floor on the
         service. Undefined means the question was not answered rather than
         answered no, and the two must not collapse — see `ModelRun`. */
      beatsChance: typeof best?.beats_coin === "boolean" ? best.beats_coin : null,
      verdict: v.verdict,
      best: v.best,
      drivers: (v.importance ?? []).map((i) => ({ name: i.feature, weight: i.weight })),
    });
  };

  const keepVolatility = (v: VolatilityResult, bars: readonly BarView[]): void => {
    const win = v.models[v.winner];
    opts.keep?.({
      kind: "volatility",
      symbol: opts.symbol(),
      timeframe: opts.timeframe(),
      bars: bars.length,
      ...barSpan(bars),
      /* QLIKE: LOWER is better, unlike every other metric on this desk. Kept
         under its own name so the drift line reads it in its own direction and
         nothing downstream mistakes a fall for a deterioration. */
      metric: typeof win?.qlike === "number" ? win.qlike : null,
      metricName: "QLIKE",
      beatsChance: null,
      verdict: v.verdict,
      best: v.winner,
    });
  };

  // ---- slots -------------------------------------------------------------
  const vol = quantSlot<VolatilityResult>();
  const struct = quantSlot<StructureResult>();
  const cls = quantSlot<ClassifyResult>();
  const season = quantSlot<SeasonalityResult>();
  const edge = quantSlot<EdgeResult>();
  const kelly = quantSlot<KellyResult>();
  const cause = quantSlot<CausalResult>();
  const cross = quantSlot<CrossAssetResult>();
  const scriptSlot = quantSlot<ScriptResult>();
  /* Persisted nowhere on purpose for now: a half-written indicator restored on
     boot and silently drawn is worse than retyping it. */
  const code = signal<string>(
    [
      "# numpy as np, pandas as pd, and t/open/high/low/close/volume are in scope.",
      "# Every series must be the same length as the bars, NaN in the warm-up.",
      "import pandas as pd",
      "",
      "out['sma20'] = pd.Series(close).rolling(20).mean().to_numpy()",
      "",
    ].join("\n"),

  );

  return h(
    "div",
    { class: "qd" },

    // ---- service state, first, because everything depends on it ----------
    h(
      "section",
      { class: "qd-service", "data-online": () => String(online()) },
      h(
        "div",
        { class: "qd-service-row" },
        h("span", { class: "qd-service-dot" }),
        h("span", {
          class: "qd-service-text",
          text: () => {
            const hh = health();
            if (checking()) return "Checking the quant service…";
            if (hh === null) return "Quant service state unknown.";
            if (hh.state !== "ok") return hh.reason;
            const n = Object.keys(hh.value.present).length;
            const miss = Object.keys(hh.value.missing).length;
            return miss === 0
              ? `Quant service up on Python ${hh.value.python}, all ${n} libraries present.`
              : `Quant service up, ${n} libraries present, ${miss} missing.`;
          },
        }),
        h("button", {
          class: "qd-recheck",
          type: "button",
          text: "Re-check",
          disabled: () => checking(),
          onclick: () => check(),
        }),
      ),
      /* A missing library is named together with the capability it removes, so
         it reads as "seasonality is unavailable" rather than as an unexplained
         failure when a panel is pressed. */
      h("div", {}, () => {
        const hh = health();
        const entries = hh?.state === "ok" ? Object.entries(hh.value.missing) : [];
        return h(
          "div",
          { class: "qd-missing" },
          ...entries.map(([lib, gates]) =>
            h(
              "p",
              { class: "qd-missing-row" },
              h("code", { text: lib }),
              h("span", { text: ` missing — no ${gates}.` }),
            ),
          ),
        );
      }),
    ),

    /* ---- cross-asset drivers ---------------------------------------------
     *
     * First, because it is the one panel here that asks whether there is any
     * information OUTSIDE the chart. Everything else on this desk interrogates
     * the instrument's own history, and the instrument's own history is what
     * the confluence score already fits — at a PBO of 89%.
     */
    panel<CrossAssetResult>({
      title: "Do the drivers tell you anything",
      blurb:
        "Fits two models on identical purged walk-forward folds: one on this instrument's own return, one on its return plus its declared drivers. Reports the difference, against the standard error of the difference.",
      slot: cross,
      canRun: (): { ok: true } | { ok: false; why: string } => {
        if (!online()) return { ok: false, why: "The quant service is not running." };
        const ds = driversFor(opts.symbol());
        if (ds.length === 0) {
          return { ok: false, why: `No driver set is declared for ${opts.symbol()}, so there is nothing to test it against.` };
        }
        const bars = opts.bars().length;
        return bars >= 500
          ? { ok: true }
          : { ok: false, why: `${bars} bars loaded; a purged walk-forward needs about 500 to have enough folds.` };
      },
      run: () =>
        cross.run(async () => {
          /* Load first. The drivers are fetched on request, so the run button
             is where the request belongs. */
          await opts.ensureDrivers();
          const p = buildPanel({
            symbol: opts.symbol(),
            timeframe: opts.timeframe(),
            target: opts.bars(),
            drivers: driversFor(opts.symbol())
              .map((d) => ({ symbol: d.symbol, label: d.label, role: d.role, bars: opts.driverBars(d.symbol) }))
              .filter((d) => d.bars.length > 0),
          });

          /**
           * DIAGNOSE HERE, NOT AT THE FAR END.
           *
           * The service can only see the arrays it is sent. When every row has
           * been dropped it receives two empty lists and reports "the panel is
           * malformed" — a bug report about the code — where the true finding
           * was that the driver data did not load. Both sentences were on this
           * screen; only one of them was true. See panelRefusal in
           * data/panel.ts for the whole measurement.
           */
          const why = panelRefusal(p);
          if (why !== null) throw new Error(why);

          return quant.crossAsset(panelPayload(p));
        }),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            /* The two AUCs side by side, because the SECOND one alone is
               meaningless — an autocorrelated series beats a coin on its own
               return, and reading that as "the drivers work" is the mistake
               this panel exists to prevent. */
            stat("Own return only", num(v.baseline.auc), "mute"),
            stat("With drivers", num(v.full.auc), v.adds_information ? "pos" : "mute"),
            stat("Difference", `${v.delta_auc >= 0 ? "+" : ""}${num(v.delta_auc, 4)}`),
            stat("In standard errors", num(v.delta_sigmas, 1), v.adds_information ? "pos" : "mute"),
            stat("Rows scored", String(v.rows_scored)),
            stat("Folds", String(v.folds)),
          ),
          h(
            "div",
            { class: "qd-stats" },
            ...v.contributions
              .slice(0, 5)
              .map((c: { column: string; coef: number }) =>
                stat(c.column === "self" ? "own return" : c.column, num(c.coef, 3)),
              ),
          ),
          /* HOW MANY COLUMNS IT ACTUALLY GOT. A fit on three of five declared
             drivers is not the model the panel's title implies, and a result
             that does not say so invites reading it as the full test. */
          ...(v.drivers.length < driversFor(opts.symbol()).length
            ? [
                caveat(
                  `Fitted on ${v.drivers.length} of ${driversFor(opts.symbol()).length} declared drivers — ${driversFor(
                    opts.symbol(),
                  )
                    .filter((d) => !v.drivers.includes(d.symbol))
                    .map((d) => d.symbol)
                    .join(", ")} did not load. This is a narrower test than the full driver set.`,
                ),
              ]
            : []),
          ...v.notes.map((n: string) => caveat(n)),
        ) as HTMLElement,
    }),


    // ---- volatility ------------------------------------------------------
    panel<VolatilityResult>({
      title: "Volatility model",
      blurb:
        "Fits GARCH and GJR-GARCH and races both against the EWMA the terminal already uses. Reports whichever actually forecast better out of sample.",
      slot: vol,
      canRun: enoughBars(300),
      run: () =>
        vol.run(async () => {
          const bars = opts.bars();
          const r = await quant.volatility(bars, 4);
          if (r.state === "ok") keepVolatility(r.value, bars);
          return r;
        }),
      body: (v) => {
        const g = v.models["gjr"] ?? {};
        const gg = v.models["garch"] ?? {};
        return h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            stat("Winner", v.winner.toUpperCase(), v.winner === "ewma" ? "mute" : "pos"),
            stat("Next-bar σ", pct(g.sigma_next_bar ?? gg.sigma_next_bar, 2)),
            stat("Annualised", pct(g.annual_vol ?? gg.annual_vol, 0)),
            stat("Persistence", num(g.persistence ?? gg.persistence)),
            stat("Returns fitted", String(v.n_returns)),
          ),
          ...(v.leverage
            ? [
                h(
                  "p",
                  { class: "qd-note", "data-on": String(v.leverage.asymmetric) },
                  h("strong", { text: v.leverage.asymmetric ? "Asymmetric. " : "Symmetric. " }),
                  h("span", { text: v.leverage.note }),
                  h("span", {
                    class: "qd-fine",
                    text: ` γ = ${num(v.leverage.gamma)}, p = ${pval(v.leverage.p_value)}`,
                  }),
                ),
              ]
            : []),
          pkWhy(v.basis),
        ) as HTMLElement;
      },
    }),

    // ---- market structure ------------------------------------------------
    panel<StructureResult>({
      title: "Trend or mean reversion",
      blurb:
        "ADF and KPSS run together, because they test opposite nulls and either alone is routinely misread. Plus variance ratios across four horizons.",
      slot: struct,
      canRun: enoughBars(150),
      run: () => struct.run(() => quant.structure(opts.bars())),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.note),
          h(
            "div",
            { class: "qd-stats" },
            stat("Call", v.call),
            stat("ADF p", pval(v.adf.p_value)),
            stat("KPSS p", pval(v.kpss.p_value)),
            ...Object.entries(v.variance_ratio).map(([q, r]) => stat(`VR ${q}`, num(r, 2))),
          ),
          h("p", { class: "qd-note", text: v.vr_note }),
          pkWhy(v.basis),
        ) as HTMLElement,
    }),

    // ---- classifier ------------------------------------------------------
    panel<ClassifyResult>({
      title: "Does this chart predict anything",
      blurb:
        "Triple-barrier labels, purged walk-forward folds, five model families. Reports calibration before accuracy, and refuses an AUC inside its own noise.",
      slot: cls,
      canRun: enoughBars(400),
      run: () =>
        cls.run(async () => {
          const bars = opts.bars();
          const r = await quant.classify(bars, 24, 1.5);
          if (r.state === "ok") keepClassify(r.value, bars);
          return r;
        }),
      body: (v) => {
        const rows = Object.entries(v.models).filter(([, m]) => m.ok);
        return h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            stat("Labelled bars", String(v.n_labelled)),
            stat("Base rate", pct(v.base_rate, 0)),
            stat("Folds", String(v.folds)),
            stat("Barrier", `${v.barrier_atr} ATR / ${v.horizon} bars`),
          ),
          h(
            "table",
            { class: "qd-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { text: "Model" }),
                h("th", { class: "num", text: "AUC" }),
                h("th", { class: "num", text: "Floor" }),
                h("th", { class: "num", text: "Brier skill" }),
                h("th", { class: "num", text: "Miscal." }),
              ),
            ),
            h(
              "tbody",
              {},
              ...rows.map(([name, m]) =>
                h(
                  "tr",
                  { "data-best": String(name === v.best), "data-real": String(!!m.beats_coin) },
                  h("td", { text: name }),
                  h("td", { class: "num", text: num(m.auc) }),
                  h("td", { class: "num", text: num(m.auc_floor) }),
                  h("td", { class: "num", text: pct(m.skill, 1) }),
                  h("td", { class: "num", text: pct(m.mean_miscalibration, 1) }),
                ),
              ),
            ),
          ),
          ...(v.agreement
            ? [h("p", { class: "qd-note", text: v.agreement.note })]
            : []),
          ...(v.importance && v.importance.length > 0
            ? [
                h(
                  "p",
                  { class: "qd-note" },
                  h("strong", { text: "Leans on: " }),
                  h("span", {
                    text: v.importance
                      .slice(0, 4)
                      .map((i) => `${i.feature} (${pct(i.weight, 0)})`)
                      .join(", "),
                  }),
                ),
              ]
            : []),
          pkWhy(v.caveat, "What this can't tell you"),
        ) as HTMLElement;
      },
    }),

    // ---- seasonality -----------------------------------------------------
    panel<SeasonalityResult>({
      title: "When this instrument moves",
      blurb:
        "Prophet, fitted to absolute returns rather than price, separating the session and day-of-week clock from the trend.",
      slot: season,
      canRun: enoughBars(400),
      run: () => season.run(() => quant.seasonality(opts.bars())),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            ...(v.busiest_hour_utc !== undefined
              ? [
                  stat("Busiest hour", `${String(v.busiest_hour_utc).padStart(2, "0")}:00 UTC`),
                  stat("Quietest hour", `${String(v.quietest_hour_utc).padStart(2, "0")}:00 UTC`),
                ]
              : []),
            ...(v.busiest_day ? [stat("Busiest day", v.busiest_day)] : []),
            ...(v.quietest_day ? [stat("Quietest day", v.quietest_day)] : []),
            stat("Explained", pct(v.explained_variance, 1)),
          ),
          ...(v.hour_of_day
            ? [
                h(
                  "div",
                  { class: "qd-hours" },
                  ...v.hour_of_day.map((x) => {
                    const all = v.hour_of_day as readonly { hour: number; effect: number }[];
                    const lo = Math.min(...all.map((a) => a.effect));
                    const hi = Math.max(...all.map((a) => a.effect));
                    const frac = hi > lo ? (x.effect - lo) / (hi - lo) : 0.5;
                    return h(
                      "span",
                      {
                        class: "qd-hour",
                        title: `${String(x.hour).padStart(2, "0")}:00 UTC`,
                        style: `--f:${frac.toFixed(3)}`,
                      },
                      h("i", {}),
                      h("em", { text: x.hour % 6 === 0 ? String(x.hour) : "" }),
                    );
                  }),
                ),
              ]
            : []),
          ...(v.intraday_note ? [h("p", { class: "qd-note", text: v.intraday_note })] : []),
          pkWhy(v.basis),
        ) as HTMLElement,
    }),

    // ---- edge significance ----------------------------------------------
    panel<EdgeResult>({
      title: "Is your edge real",
      blurb:
        "Newey-West standard errors on your own closed trades, because consecutive trades from the same trend are not independent draws and the naive t-test knows nothing about that.",
      slot: edge,
      canRun: enoughTrades(20),
      run: () => edge.run(() => quant.edge(opts.returns())),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            stat("Trades", String(v.n_trades)),
            stat("Mean R", num(v.mean, 3), v.mean > 0 ? "pos" : "neg"),
            stat("t (HAC)", num(v.t_stat, 2)),
            stat("p", pval(v.p_value), v.significant ? "pos" : "mute"),
            stat("SE inflation", v.inflation === null ? "—" : `${v.inflation.toFixed(2)}×`),
          ),
          h("p", { class: "qd-note", text: v.independence.note }),
          pkWhy(v.caveat, "What this can't tell you"),
        ) as HTMLElement,
    }),

    // ---- kelly -----------------------------------------------------------
    panel<KellyResult>({
      title: "How much to risk",
      blurb:
        "Growth-optimal size from your own record, and the fraction of it that stays inside a 20% drawdown. Reports full Kelly so you can see why nobody trades it.",
      slot: kelly,
      canRun: enoughTrades(20),
      run: () => kelly.run(() => quant.kelly(opts.returns(), 0.2)),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            stat("Full Kelly", pct(v.full_kelly, 1), "mute"),
            stat("Its drawdown", pct(v.full_kelly_drawdown, 0), "neg"),
            stat("Recommended", pct(v.recommended, 2), "pos"),
            stat(
              "As Kelly fraction",
              v.recommended_as_kelly_fraction === null
                ? "—"
                : `${v.recommended_as_kelly_fraction.toFixed(2)}×`,
            ),
            stat("Its drawdown", pct(v.recommended_drawdown, 0)),
          ),
          pkWhy(v.caveat, "What this can't tell you"),
        ) as HTMLElement,
    }),

    // ---- causal ----------------------------------------------------------
    panel<CausalResult>({
      title: "Does following your plan actually help",
      blurb:
        "The raw difference between on-plan and off-plan trades is mostly the conditions each was taken in. This adjusts for them, then tries three ways to break its own answer.",
      slot: cause,
      canRun: () => {
        if (!online()) return { ok: false as const, why: "The quant service is not running." };
        const n = opts.trades().length;
        return n >= 20
          ? { ok: true as const }
          : {
              ok: false as const,
              why: `${n} closed trades with a recorded regime and adherence; this needs at least 20.`,
            };
      },
      run: () => cause.run(() => quant.causal(opts.trades())),
      body: (v) =>
        h(
          "div",
          {},
          verdict(v.verdict),
          h(
            "div",
            { class: "qd-stats" },
            stat("On-plan / off", `${v.n_treated} / ${v.n_control}`),
            stat("Raw difference", num(v.naive.difference, 3), "mute"),
            stat(
              "Adjusted",
              num(v.dowhy.adjusted_effect ?? v.econml.ate, 3),
              (v.dowhy.adjusted_effect ?? v.econml.ate ?? 0) > 0 ? "pos" : "neg",
            ),
            stat(
              "95% interval",
              v.econml.ci_low === undefined
                ? "—"
                : `${num(v.econml.ci_low, 2)} … ${num(v.econml.ci_high, 2)}`,
            ),
          ),
          h(
            "div",
            { class: "qd-refutes" },
            ...Object.entries(v.dowhy.refutations ?? {}).map(([name, r]) =>
              h(
                "span",
                { class: "qd-refute", "data-passed": String(r.passed === true) },
                h("span", { text: name.replace(/_/g, " ") }),
                h("span", { class: "qd-refute-mark", text: r.passed ? "✓" : r.error ? "?" : "✕" }),
              ),
            ),
          ),
          pkWhy(v.assumption, "What this assumes"),
        ) as HTMLElement,
    }),
    /* ---- custom indicators ------------------------------------------------
     *
     * The safety notice is ON the control, not in a document. Running this is
     * a decision about who may execute arbitrary Python on this machine, and
     * that decision has to be visible where it is made.
     */
    h(
      "section",
      /* Full width: this one holds a code editor and the sentence about who
         may execute Python on this machine. Neither survives being squeezed
         into a column beside a stat grid. */
      { class: "qd-panel qd-wide" },
      h(
        "div",
        { class: "qd-head" },
        h(
          "div",
          { class: "qd-head-text" },
          h("h3", { class: "qd-title", text: "Custom indicator (Python)" }),
          h("p", {
            class: "qd-blurb",
            text: "Runs against numpy and pandas in the quant service, on the bars this chart has loaded. Assign each series into `out`; every one must be the same length as the bars, with NaN in the warm-up.",
          }),
        ),
        h("button", {
          class: "qd-run",
          type: "button",
          text: () => (scriptSlot.busy() ? "Running…" : "Run"),
          disabled: () => !online() || scriptSlot.busy(),
          onclick: () => scriptSlot.run(() => quant.script(opts.bars(), code())),
        }),
      ),
      h("textarea", {
        class: "qd-code num",
        spellcheck: "false",
        rows: "10",
        value: () => code(),
        "aria-label": "Indicator source",
        oninput: (e: Event) => code.set((e.target as HTMLTextAreaElement).value),
      }),
      /* Stated at the point of use rather than in a README. The import
         restrictions in the service are a guard against habit, not a boundary
         — a determined escape gets everything this process has. */
      h("p", {
        class: "qd-caveat",
        text: "This executes unrestricted Python in the quant service's own process. It is off unless the service was started with IRAM_QUANT_SCRIPTS=1. Never run a script you have not read — a snippet from anywhere else has the same access to this machine that the service does.",
      }),
      h("div", { class: "qd-status" }, () => {
        if (scriptSlot.busy()) return h("span", { text: "Running…" });
        const r = scriptSlot.result();
        if (r === null) return h("span", { text: "" });
        if (r.state === "refused") return h("span", { class: "qd-refused", text: r.reason });
        if (r.state === "offline") return h("span", { class: "qd-refused", text: r.reason });
        return h("span", {
          text: `${r.value.series.length} series over ${r.value.bars} bars.`,
        });
      }),
      h("div", { class: "qd-body" }, () => {
        const r = scriptSlot.result();
        if (r === null || r.state !== "ok") return h("div", { class: "qd-empty" });
        return h(
          "div",
          {},
          h(
            "div",
            { class: "qd-stats" },
            ...r.value.series.map((sr) =>
              stat(sr.name, `${num(sr.min, 2)} … ${num(sr.max, 2)}`, sr.finite === 0 ? "mute" : undefined),
            ),
          ),
          ...(r.value.stdout.trim() === ""
            ? []
            : [h("pre", { class: "qd-stdout", text: r.value.stdout })]),
          ...r.value.notes.map((n: string) => caveat(n)),
        ) as HTMLElement;
      }),
    ),

  ) as HTMLElement;
}

/**
 * The line the desk badge shows.
 *
 * Exported so a caller can render the service state without constructing the
 * whole desk — the same reason `studySummary` and `macroLine` are exported.
 */
export function quantBadge(h_: QuantResult<QuantHealth> | null): string {
  if (h_ === null) return "unknown";
  if (h_.state !== "ok") return "offline";
  return Object.keys(h_.value.missing).length === 0 ? "ready" : "partial";
}
