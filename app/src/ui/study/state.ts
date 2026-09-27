/**
 * The Analyse desk's model: one study, its bars, its plan and its report.
 *
 * No DOM. The four step views read from here and call back into it, which is
 * what lets the Subject step show the joint window that the Method step's
 * availability rules depend on without either of them knowing about the other.
 *
 * WHY LOADING IS A SEPARATE ACT FROM RUNNING
 * The coverage table, the joint window and the parameter budget are all
 * statements about bars that are in the archive, and none of them can be shown
 * before the bars are fetched. Fetching five years of six series on every
 * keystroke is not an option, and inventing the numbers until the real ones
 * arrive is the one thing this product does not do.
 *
 * So the table starts as "not checked" — an honest third state, distinct from
 * "no bars" — and `check()` is a button. Running implies checking, so nobody
 * has to know the distinction to use the desk; it exists so that the screen is
 * never showing a number nothing measured.
 */

import { computed, signal, type ReadSignal } from "../../core/signal";
import { brokerCosts, type BrokerSpec } from "../../data/brokercosts";
import type { ShellContext } from "../shell/context";
import type { DataHandle } from "../data";
import type { HistoryService } from "../../data/history";
import { intervalMs } from "../../data/history";
import { openCoverage } from "../../data/sessions";
import { quantHealth, type QuantHealth } from "../../data/quant";
import type { BarView } from "../../chart/series";
import type { Range } from "../../store/segments";
import {
  featureColumns,
  newStudy,
  panelRoleOf,
  relatedContext,
  roleForDriver,
  specProblems,
  MAX_FOLDS,
  MIN_FOLDS,
  type ContextSeries,
  type CostModel,
  type SeriesRole,
  type StudySpec,
} from "../../study/spec";
import { proposeRelated, relatedRows } from "../../study/related";
import { DEFAULT_QUESTION, methodsFor, questionOf, QUESTIONS, type QuestionId } from "../../study/question";
import {
  jointWindow,
  parameterBudget,
  splitWindow,
  YEAR_MS,
  type SeriesSpan,
} from "../../study/window";
import type { MethodContext } from "../../study/methods";
import { buildPlan } from "../../study/plan";
import { runStudySpec, spanOf, requestedRange, type LoadedSeries, type StudyReport } from "../../study/run";
import {
  createStudyStore,
  runsOnDay,
  summarise,
  type RunSummary,
  type StudyRecord,
} from "../../study/store";
import {
  DEFAULT_SCHEDULE,
  guardCheck,
  nextRunAt,
  type Schedule,
} from "../../study/schedule";
import { effect, onCleanup } from "../../core/signal";

export type StepId = "subject" | "method" | "automate" | "report";

export const STEPS: readonly { readonly id: StepId; readonly label: string; readonly blurb: string }[] = [
  { id: "subject", label: "Subject", blurb: "What is being studied, against what, over how much history" },
  { id: "method", label: "Method", blurb: "What gets done with those bars, and what each one costs" },
  { id: "automate", label: "Run it", blurb: "Once, or on a schedule, with guards" },
  { id: "report", label: "Finding", blurb: "What held, what did not, and what it does not establish" },
];

/** One series' fetch outcome, including the state that means "nobody asked". */
export interface SeriesLoad {
  readonly symbol: string;
  readonly label: string;
  readonly role: SeriesRole;
  readonly state: "unchecked" | "loading" | "ok" | "short" | "failed";
  readonly bars: number;
  readonly first: number;
  readonly last: number;
  readonly gaps: readonly Range[];
  readonly coverage: number | null;
  readonly note: string;
}

/**
 * The ceiling on bars fetched per series.
 *
 * Sixty thousand is about seven years of hourly bars. Above it the fetch is
 * minutes long and every model in the catalogue is being fitted on regimes
 * that no longer exist — the argument `data/quant.ts` makes for its own 5,000
 * limit, at the scale the local engines work at. When the cap binds, the
 * window says so rather than quietly returning less than was asked for.
 */
export const MAX_STUDY_BARS = 60_000;

/**
 * How often the desk looks for a study that is due.
 *
 * A minute. The finest cadence offered is "every bar close", whose floor is
 * also a minute, so nothing can be more than one tick late. Checking more
 * often would spend wake-ups to discover nothing, and checking less often
 * would make a 1m study's schedule a lie.
 */
export const SCHEDULER_TICK_MS = 60_000;

export interface StudyDeskDeps {
  /** The archive-backed history. A study needs depth, not the screen. */
  readonly history: HistoryService;
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  /**
   * The Data desk, for Research's "Data library" tab. OPTIONAL: without it the
   * tab opens the Data view instead of mounting the desk in place. Typed from
   * the desk's own handle, never restated.
   */
  readonly library?: Pick<DataHandle, "el" | "activate">;
}

/**
 * A new study as the steered flow starts it: the AI's related assets are
 * already in the context (`newStudy` does that), and the AI's checks for the
 * default question are already selected — visible and switchable, rather than
 * an empty method list the operator has to know how to fill.
 */
export function steeredStudy(id: string, symbol: string, timeframe: string, at: number): StudySpec {
  const s = newStudy(id, symbol, timeframe, at);
  return { ...s, question: DEFAULT_QUESTION, methods: methodsFor(DEFAULT_QUESTION, s.context.length > 0) };
}

/**
 * Only the two members of the shell context this model uses — the store and
 * the toaster — so a test can build one without a shell. Derived with `Pick`,
 * not retyped, so it cannot drift from the real context.
 */
export type StudyStateContext = Pick<ShellContext, "kv" | "toaster">;

export function createStudyState(ctx: StudyStateContext, deps: StudyDeskDeps) {
  const store = createStudyStore(ctx.kv);
  const now = (): number => Date.now();

  const spec = signal<StudySpec>(
    steeredStudy(`s${String(now())}`, deps.symbol.peek() || "BTCUSDT", deps.timeframe.peek() || "1h", now()),
  );
  const schedule = signal<Schedule>(DEFAULT_SCHEDULE);
  const step = signal<StepId>("subject");
  const health = signal<QuantHealth | null>(null);
  const healthChecked = signal(false);
  const loads = signal<readonly SeriesLoad[]>([]);
  const loaded = signal<readonly LoadedSeries[]>([]);
  const report = signal<StudyReport | null>(null);
  const busy = signal(false);
  const progress = signal("");
  const saved = signal<readonly StudyRecord[]>(store.list());
  const lastRuns = signal<readonly RunSummary[]>([]);

  store.subscribe(() => saved.set(store.list()));

  void quantHealth().then((r) => {
    healthChecked.set(true);
    if (r.state === "ok") health.set(r.value);
  });

  /* ── derived ──────────────────────────────────────────────────────────── */

  const checked = computed(() => loads().some((l) => l.state !== "unchecked"));

  const spans = computed<readonly SeriesSpan[]>(() => loaded().map(spanOf));

  const subjectSpan = computed<SeriesSpan | null>(() => {
    const s = loaded().find((l) => l.symbol === spec().symbol);
    return s === undefined ? null : spanOf(s);
  });

  const window = computed(() => {
    const subject = subjectSpan();
    if (subject === null) return null;
    const cols = loaded()
      .filter((l) => l.symbol !== spec().symbol && panelRoleOf(l.role) !== null)
      .map(spanOf);
    const r = requestedRange(spec(), now());
    return jointWindow(subject, cols, r.from, r.to);
  });

  /**
   * Rows the study will have, ESTIMATED from the subject's bar count inside the
   * window rather than from a built panel.
   *
   * Labelled an estimate everywhere it is shown, because the panel drops rows
   * where a driver was stale beyond tolerance and this cannot know how many
   * that will be without doing the join. The real figure appears in the report.
   */
  const estimatedRows = computed(() => {
    const w = window();
    const subject = loaded().find((l) => l.symbol === spec().symbol);
    if (w === null || w.refusal !== null || subject === undefined) return 0;
    return subject.bars.filter((b: BarView) => b.t >= w.from && b.t <= w.to).length;
  });

  /**
   * Series the spec asks for that produced no bars.
   *
   * `fetchOne` returns null on a failure so that one dead vendor does not
   * abandon the other five, which is right — and it means `loaded` quietly
   * holds fewer series than the study was configured with. Without this, the
   * panel reports "3 years" over a window computed from whatever survived,
   * with no hint that a driver is missing from it. The table shows each row
   * red; the WINDOW has to say it too, because the window is the number
   * somebody writes down.
   */
  const absent = computed(() => {
    if (!checked()) return [];
    const got = new Set(loaded().map((l) => l.symbol));
    const s = spec();
    return [
      ...(got.has(s.symbol) ? [] : [{ symbol: s.symbol, role: "driver" as SeriesRole, subject: true }]),
      ...s.context.filter((c) => !got.has(c.symbol)).map((c) => ({ symbol: c.symbol, role: c.role, subject: false })),
    ];
  });

  const split = computed(() => splitWindow(estimatedRows(), spec().horizon));
  const budget = computed(() => parameterBudget(split().train.bars, spec().horizon));

  const methodCtx = computed<MethodContext>(() => {
    const s = spec();
    /* COUNTED FROM WHAT LOADED, once anything has been fetched.
       Counted from the spec, a driver that returned no bars still made
       lead-lag look available — the card was offered, the run reached the
       panel, and the refusal arrived three minutes later in the report. A
       column with no data is not a column. Before a fetch there is nothing
       measured to count, so the spec's own figures stand and the row count of
       zero is what blocks the cards. */
    if (!checked()) {
      return {
        checked: false,
        rows: 0,
        featureColumns: featureColumns(s),
        driverColumns: s.context.filter((c) => c.role === "driver").length,
        sliceSeries: s.context.filter((c) => c.role === "regime").length,
        health: health(),
      };
    }
    const live = loaded().filter((l) => l.symbol !== s.symbol && l.bars.length > 0);
    return {
      checked: true,
      rows: estimatedRows(),
      featureColumns: live.filter((l) => panelRoleOf(l.role) !== null).length,
      driverColumns: live.filter((l) => l.role === "driver").length,
      sliceSeries: live.filter((l) => l.role === "regime").length,
      health: health(),
    };
  });

  const plan = computed(() => buildPlan(spec().methods, methodCtx(), store.timings()));
  const problems = computed(() => specProblems(spec()));

  /* ── editing ──────────────────────────────────────────────────────────── */

  const patch = (over: Partial<StudySpec>): void => {
    spec.set({ ...spec.peek(), ...over, updatedAt: now() });
    /* Any change to WHAT is studied invalidates the bars and the report. Left
       to itself this is the defect that makes a terminal untrustworthy: a
       coverage table describing the previous symbol, under the current one's
       name. */
    if (
      over.symbol !== undefined ||
      over.timeframe !== undefined ||
      over.context !== undefined ||
      over.years !== undefined
    ) {
      loaded.set([]);
      loads.set(unchecked(spec.peek()));
      report.set(null);
    }
  };

  const unchecked = (s: StudySpec): SeriesLoad[] => [
    {
      symbol: s.symbol,
      label: s.symbol,
      role: "driver",
      state: "unchecked",
      bars: 0,
      first: 0,
      last: 0,
      gaps: [],
      coverage: null,
      note: "not checked",
    },
    ...s.context.map((c) => ({
      symbol: c.symbol,
      label: c.label,
      role: c.role,
      state: "unchecked" as const,
      bars: 0,
      first: 0,
      last: 0,
      gaps: [] as readonly Range[],
      coverage: null,
      note: "not checked",
    })),
  ];

  loads.set(unchecked(spec.peek()));

  const addSeries = (c: ContextSeries): void => {
    const s = spec.peek();
    if (s.context.some((x) => x.symbol.toUpperCase() === c.symbol.toUpperCase())) return;
    patch({ context: [...s.context, c] });
  };

  const removeSeries = (symbol: string): void => {
    patch({ context: spec.peek().context.filter((c) => c.symbol !== symbol) });
  };

  const setRole = (symbol: string, role: SeriesRole): void => {
    /* Through `patch`, so changing a role to or from "Regime proxy" clears the
       loaded bars — a regime proxy is not a panel column, so the joint window
       it produces is a different window. */
    patch({
      context: spec.peek().context.map((c) => (c.symbol === symbol ? { ...c, role } : c)),
    });
  };

  const toggleMethod = (id: string, on: boolean): void => {
    const s = spec.peek();
    const has = s.methods.includes(id);
    if (on === has) return;
    /* Not through `patch`: choosing a method does not change which bars the
       study is about, so the coverage table and the fetched series stay. */
    spec.set({
      ...s,
      methods: on ? [...s.methods, id] : s.methods.filter((m) => m !== id),
      updatedAt: now(),
    });
  };

  /* ── steering: the Research flow's you-choose / AI-chooses split ─────── */

  /** The AI's related-asset proposal for the current subject. */
  const related = computed(() => proposeRelated(spec().symbol));
  /** Proposals merged with what is in the study — see `relatedRows`. */
  const relatedList = computed(() => relatedRows(related(), spec().context));
  const question = computed(() => questionOf(spec().question));

  /**
   * Keep the relationship checks in step with whether anything is related.
   *
   * Only on a TRANSITION of "is anything switched on", so an operator who
   * switched a check off is not overruled every time they flip one asset.
   */
  const syncRelationMethods = (before: StudySpec, after: StudySpec): readonly string[] => {
    const had = before.context.length > 0;
    const has = after.context.length > 0;
    if (had === has) return after.methods;
    const q = questionOf(after.question);
    return has
      ? [...after.methods, ...q.withRelated.filter((m) => !after.methods.includes(m))]
      : after.methods.filter((m) => !q.withRelated.includes(m));
  };

  /** 1 · Your asset. A new subject gets the AI's related assets afresh. */
  const setAsset = (symbol: string): void => {
    const sym = symbol.trim().toUpperCase();
    const s = spec.peek();
    if (sym === "" || sym === s.symbol) return;
    const context = relatedContext(sym);
    patch({
      symbol: sym,
      name: `${sym} ${s.timeframe}`,
      context,
      methods: methodsFor(questionOf(s.question).id, context.length > 0),
    });
  };

  /** 2 · Your question. Choosing one is asking the AI to pick its checks again. */
  const setQuestion = (id: QuestionId): void => {
    if (!QUESTIONS.some((q) => q.id === id)) return;
    const s = spec.peek();
    spec.set({ ...s, question: id, methods: methodsFor(id, s.context.length > 0), updatedAt: now() });
    report.set(null);
  };

  /** 3 · Switch one related asset on or off. The context stays the one owner. */
  const setRelated = (symbol: string, on: boolean): void => {
    const before = spec.peek();
    const sym = symbol.toUpperCase();
    const inStudy = before.context.some((c) => c.symbol.toUpperCase() === sym);
    if (on === inStudy) return;
    if (on) {
      const pick = related.peek().picks.find((p) => p.symbol === sym);
      if (pick === undefined) return;
      const [c] = relatedContext(before.symbol, [pick]);
      if (c !== undefined) addSeries(c);
    } else {
      removeSeries(before.context.find((c) => c.symbol.toUpperCase() === sym)?.symbol ?? symbol);
    }
    const after = spec.peek();
    const methods = syncRelationMethods(before, after);
    if (methods !== after.methods) spec.set({ ...after, methods, updatedAt: now() });
  };

  /**
   * 3 · Add your own. Marked a Driver — the operator added it to be measured
   * as a possible predictor — with no stated mechanism, which `specProblems`
   * reports as a caution rather than hiding.
   */
  const addOwn = (symbol: string): void => {
    const sym = symbol.trim().toUpperCase();
    const before = spec.peek();
    if (sym === "" || sym === before.symbol) return;
    addSeries({ symbol: sym, label: sym, role: roleForDriver(before.symbol, sym, "lead"), why: "" });
    const after = spec.peek();
    const methods = syncRelationMethods(before, after);
    if (methods !== after.methods) spec.set({ ...after, methods, updatedAt: now() });
  };

  /** 4 · How strict. Not through `patch`: neither changes which bars are studied. */
  const setFolds = (n: number): void => {
    if (!Number.isFinite(n)) return;
    const folds = Math.max(MIN_FOLDS, Math.min(MAX_FOLDS, Math.round(n)));
    spec.set({ ...spec.peek(), folds, updatedAt: now() });
  };
  /*
   * THE BROKER'S SPECS, FOR `costs: "measured"`.
   *
   * Asked for ONCE and cached: a study runs rarely, and a fetch per run would
   * put a request behind a button the operator presses while watching. Absent
   * is normal — an account that has never synced has none — and `studyCosts`
   * then charges the assumption rather than guessing, which is the harsher end
   * and so cannot manufacture an edge.
   */
  const brokerSpecs = signal<Readonly<Record<string, BrokerSpec>> | undefined>(undefined);
  let askedForSpecs = false;
  const ensureSpecs = async (): Promise<Readonly<Record<string, BrokerSpec>> | undefined> => {
    if (askedForSpecs) return brokerSpecs();
    askedForSpecs = true;
    const got = await brokerCosts();
    if (got.kind === "ok") brokerSpecs.set(got.value.specs);
    return brokerSpecs();
  };

  const setCosts = (costs: CostModel): void => {
    spec.set({ ...spec.peek(), costs, updatedAt: now() });
  };

  /* ── loading ──────────────────────────────────────────────────────────── */

  function barsWanted(s: StudySpec): number {
    if (s.years === "max") return MAX_STUDY_BARS;
    const step = intervalMs(s.timeframe);
    return Math.min(MAX_STUDY_BARS, Math.ceil((s.years * YEAR_MS) / step));
  }

  const patchLoad = (symbol: string, over: Partial<SeriesLoad>): void => {
    loads.set(loads.peek().map((l) => (l.symbol === symbol ? { ...l, ...over } : l)));
  };

  /**
   * Fetch one series, backfilling when the archive is short.
   *
   * Returns null rather than throwing, exactly as the survey desk does: one
   * dead vendor must not abandon the other five series, and "US10Y did not
   * load" is a row in the table rather than an exception for the caller.
   */
  async function fetchOne(
    symbol: string,
    label: string,
    role: SeriesRole,
    tf: string,
    want: number,
  ): Promise<LoadedSeries | null> {
    patchLoad(symbol, { state: "loading", note: "fetching…" });
    try {
      let res = await deps.history.load(symbol, tf, { limit: want });
      if (res.bars.length < want) {
        patchLoad(symbol, { note: `have ${res.bars.length.toLocaleString()}, reaching back…`, bars: res.bars.length });
        try {
          await deps.history.backfill(symbol, tf, want, {
            onProgress: (added) => patchLoad(symbol, { note: `backfilled ${added.toLocaleString()}…` }),
          });
          res = await deps.history.load(symbol, tf, { limit: want });
        } catch {
          /* A vendor limit or a dead proxy. Study what is held and let the
             window say it is short — dropping the series instead is what makes
             a joint window silently wider than the data supports. */
        }
      }

      if (res.bars.length === 0) {
        patchLoad(symbol, { state: "failed", bars: 0, note: "no bars from any source", coverage: null });
        return null;
      }

      const first = res.bars[0];
      const last = res.bars[res.bars.length - 1];
      /* SESSION-AWARE coverage, as the lab and the survey both do it: a complete
         year of EURUSD hourly bars is "missing" every weekend on a wall-clock
         measure and scores about 71%. */
      const coverage =
        first !== undefined && last !== undefined && res.bars.length >= 2
          ? openCoverage(symbol, { from: first.t, to: last.t }, res.gaps)
          : null;

      patchLoad(symbol, {
        state: res.bars.length < want * 0.6 ? "short" : "ok",
        bars: res.bars.length,
        first: first?.t ?? 0,
        last: last?.t ?? 0,
        gaps: res.gaps,
        coverage,
        note: `${res.source}${res.containsDemo ? " · contains demo bars" : ""}`,
      });

      return {
        symbol,
        label,
        role,
        bars: res.bars,
        gaps: res.gaps,
        coverage,
        source: res.source,
      };
    } catch (err) {
      patchLoad(symbol, { state: "failed", bars: 0, note: String(err).slice(0, 80), coverage: null });
      return null;
    }
  }

  async function check(): Promise<readonly LoadedSeries[]> {
    if (busy.peek()) return loaded.peek();
    busy.set(true);
    const s = spec.peek();
    const want = barsWanted(s);
    loads.set(unchecked(s));
    progress.set(`fetching ${1 + s.context.length} series…`);
    try {
      const subject = await fetchOne(s.symbol, s.symbol, "driver", s.timeframe, want);
      const rest: LoadedSeries[] = [];
      for (const c of s.context) {
        const got = await fetchOne(c.symbol, c.label, c.role, s.timeframe, want);
        if (got !== null) rest.push(got);
      }
      const all = subject === null ? rest : [subject, ...rest];
      loaded.set(all);
      progress.set("");
      return all;
    } finally {
      busy.set(false);
    }
  }

  /* ── running ──────────────────────────────────────────────────────────── */

  /**
   * Fetch one spec's series without touching the desk's own table.
   *
   * The on-screen `loads` signal belongs to the study being edited. A
   * scheduled run of a DIFFERENT study that wrote into it would redraw the
   * operator's coverage table with somebody else's symbols while they were
   * reading it — the class of defect this file already guards against in
   * `patch`.
   */
  async function fetchFor(s: StudySpec): Promise<readonly LoadedSeries[]> {
    const want = barsWanted(s);
    const out: LoadedSeries[] = [];
    for (const want_ of [{ symbol: s.symbol, label: s.symbol, role: "driver" as SeriesRole }, ...s.context]) {
      try {
        const res = await deps.history.load(want_.symbol, s.timeframe, { limit: want });
        if (res.bars.length === 0) continue;
        const first = res.bars[0];
        const last = res.bars[res.bars.length - 1];
        out.push({
          symbol: want_.symbol,
          label: want_.label,
          role: want_.role,
          bars: res.bars,
          gaps: res.gaps,
          coverage:
            first !== undefined && last !== undefined && res.bars.length >= 2
              ? openCoverage(want_.symbol, { from: first.t, to: last.t }, res.gaps)
              : null,
          source: res.source,
        });
      } catch {
        /* One series short is a thinner study, not a failed one. The window
           and the report both name what is missing. */
      }
    }
    return out;
  }

  /**
   * Run a saved study in the background, without disturbing the one on screen.
   *
   * Returns whether it ran. The guard is re-checked HERE rather than trusted
   * from the caller, because the caller is a timer and the record may have
   * changed in another tab since it last looked.
   */
  async function runRecord(rec: StudyRecord): Promise<boolean> {
    const verdict = guardCheck(rec.schedule, runsOnDay(rec, now()), rec.failures);
    if (!verdict.allowed) return false;

    const series = await fetchFor(rec.spec);
    const subject = series.find((l) => l.symbol === rec.spec.symbol);
    const before = rec.runs[rec.runs.length - 1];

    if (subject === undefined) {
      /* Recorded as a refusal rather than dropped. A scheduled study that
         quietly does nothing for a week is worse than one that says the
         vendor stopped answering on Tuesday — and the failure counter is what
         eventually disarms it. */
      store.record(rec.spec.id, {
        at: now(),
        ms: 0,
        headline: `No bars for ${rec.spec.symbol}.`,
        rows: 0,
        hypotheses: 0,
        survivors: 0,
        strength: null,
        measure: "none",
        refusal: `No bars were loaded for ${rec.spec.symbol}, so the study could not run.`,
      });
      return true;
    }

    const specsForRun = await ensureSpecs();
    const out = await runStudySpec({
      spec: rec.spec,
      subject,
      context: series.filter((l) => l.symbol !== rec.spec.symbol),
      health: health.peek(),
      timings: store.timings(),
      now: now(),
      ...(specsForRun !== undefined ? { brokerSpecs: specsForRun } : {}),
    });
    store.setTimings(out.timings);
    store.record(rec.spec.id, summarise(out));

    /* If this is the study on screen, show its new report rather than leaving
       a stale one in front of the operator. */
    if (spec.peek().id === rec.spec.id) {
      report.set(out);
      lastRuns.set(store.get(rec.spec.id)?.runs ?? []);
    }

    if (rec.schedule.actions.includes("notify")) {
      /* WITH THE NUMBER THAT CHANGED. A notification that only says a study
         finished is one people switch off inside a week, which is the same as
         never having built the schedule. */
      const after = summarise(out);
      const moved =
        before?.strength != null && after.strength != null && before.measure === after.measure
          ? `${after.measure} ${before.strength.toFixed(2)} → ${after.strength.toFixed(2)}`
          : after.strength == null
            ? "no comparable figure this run"
            : `${after.measure} ${after.strength.toFixed(2)} — first comparable run`;
      ctx.toaster.push({
        title: rec.spec.name,
        body: `${moved}. ${out.headline}`,
        level: "info",
        key: `study-run-${rec.spec.id}`,
        action: { label: "Open", run: () => open(rec.spec.id) },
      });
    }
    return true;
  }

  /**
   * The tick that makes a schedule a schedule.
   *
   * WHAT THIS DELIBERATELY IS NOT: a background service. The effect has no
   * dependencies, so it starts the moment this desk is first BUILT and keeps
   * ticking for the rest of the session — including while the operator is on
   * another desk, which is correct (they asked for a schedule) and is not the
   * same as "while Analyse is on screen". The on-screen sentence says exactly
   * that; a schedule whose real scope differs from its description by one word
   * is a schedule nobody can plan around. It runs ONE study per tick.
   * Fetching several years of history for every saved study on a timer the
   * operator cannot see is a decision about their bandwidth and their CPU
   * that a desk has no business making on its own — the eleven server-side
   * loops in `gateway/background.py` are where that belongs, and they need a
   * backend runner this does not have yet.
   *
   * So the honest description, which is also what the desk says on screen:
   * scheduled studies re-run while you have Analyse open.
   */
  effect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped || busy.peek()) return;
      const due = store
        .list()
        .filter((r) => {
          const at = nextRunAt(r.schedule, r.runs[r.runs.length - 1]?.at ?? null, intervalMs(r.spec.timeframe));
          return at !== null && at <= now();
        })
        /* Oldest first, so a study that has been waiting longest is not
           starved by one whose cadence comes round more often. */
        .sort((a, b) => (a.runs[a.runs.length - 1]?.at ?? 0) - (b.runs[b.runs.length - 1]?.at ?? 0));
      const next = due[0];
      if (next === undefined) return;
      busy.set(true);
      try {
        await runRecord(next);
      } finally {
        busy.set(false);
      }
    };
    const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  async function run(): Promise<void> {
    if (busy.peek()) return;
    const series = loaded.peek().length === 0 ? await check() : loaded.peek();
    const s = spec.peek();
    const subject = series.find((l) => l.symbol === s.symbol);
    if (subject === undefined) {
      ctx.toaster.push({
        title: `No bars for ${s.symbol}`,
        body: "Nothing was loaded for the subject of this study, so there is nothing to run against. Check the series on the Subject step.",
        level: "warn",
        key: "study-no-subject",
      });
      return;
    }

    busy.set(true);
    step.set("report");
    try {
      const specsForRun = await ensureSpecs();
      const out = await runStudySpec({
        spec: s,
        subject,
        context: series.filter((l) => l.symbol !== s.symbol),
        health: health.peek(),
        timings: store.timings(),
        now: now(),
        ...(specsForRun !== undefined ? { brokerSpecs: specsForRun } : {}),
        onStep: (planStep, phase) => {
          if (phase === "start") progress.set(`${planStep.n}. ${planStep.method.label}…`);
        },
      });
      report.set(out);
      store.setTimings(out.timings);
      /* Saved only when the operator has saved the study. An unsaved study is a
         scratch question, and filling the Library with scratch questions is how
         a Library stops being read. */
      if (store.get(s.id) !== null) {
        store.record(s.id, summarise(out));
        const rec = store.get(s.id);
        lastRuns.set(rec?.runs ?? []);
      }
    } finally {
      busy.set(false);
      progress.set("");
    }
  }

  /* ── persistence ──────────────────────────────────────────────────────── */

  function save(): void {
    const s = spec.peek();
    const existing = store.get(s.id);
    const res = store.save({
      spec: s,
      schedule: schedule.peek(),
      runs: existing?.runs ?? [],
      failures: existing?.failures ?? 0,
      filed: existing?.filed ?? false,
    });
    ctx.toaster.push(
      res.ok
        ? { title: `Saved "${s.name}"`, level: "success", key: "study-save" }
        : {
            title: "The study could not be saved",
            body: res.error,
            level: "warn",
            key: "study-save",
          },
    );
    if (res.ok) lastRuns.set(existing?.runs ?? []);
  }

  function open(id: string): void {
    const rec = store.get(id);
    if (rec === null) return;
    spec.set(rec.spec);
    schedule.set(rec.schedule);
    lastRuns.set(rec.runs);
    loaded.set([]);
    loads.set(unchecked(rec.spec));
    report.set(null);
    step.set("subject");
  }

  function fresh(): void {
    const s = steeredStudy(
      `s${String(now())}`,
      deps.symbol.peek() || "BTCUSDT",
      deps.timeframe.peek() || "1h",
      now(),
    );
    spec.set(s);
    schedule.set(DEFAULT_SCHEDULE);
    lastRuns.set([]);
    loaded.set([]);
    loads.set(unchecked(s));
    report.set(null);
    step.set("subject");
  }

  function remove(id: string): void {
    store.remove(id);
    if (spec.peek().id === id) fresh();
  }

  return {
    spec,
    schedule,
    step,
    health,
    healthChecked,
    loads,
    loaded,
    report,
    busy,
    progress,
    saved,
    lastRuns,
    checked,
    absent,
    spans,
    window,
    estimatedRows,
    split,
    budget,
    methodCtx,
    plan,
    problems,
    store,
    patch,
    addSeries,
    removeSeries,
    setRole,
    toggleMethod,
    related,
    relatedList,
    question,
    setAsset,
    setQuestion,
    setRelated,
    addOwn,
    setFolds,
    setCosts,
    check,
    run,
    runRecord,
    save,
    open,
    fresh,
    remove,
  };
}

export type StudyState = ReturnType<typeof createStudyState>;
