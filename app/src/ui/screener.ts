/**
 * Screener view.
 *
 * Ranks the universe by conviction and — the part that matters — lets you open
 * any row and read the exact reasoning that produced its score. A ranking you
 * cannot interrogate is a tip, not analysis.
 */

import { signal, computed, effect, renderEffect, type Signal } from "../core/signal";
import {
  applyFilters,
  applySort,
  filterRow,
  selectRow,
  sortableHeader,
  toTSV,
  type Column,
  type SortKey,
} from "./table";
import {
  configMatches,
  createViewStore,
  isEmptyConfig,
  type SavedView,
  type ViewConfig,
} from "./savedviews";
import type { KV } from "../store/kv";
import { correlation, type CorrelationPair, type CorrelationRead } from "../data/context";
import { SUB_WINDOWS, utcDay } from "../data/correlation";
import { h, clear } from "./dom";
import { scanUniverse, rankRows, type ScanRow, type ScanProgress } from "../scan/scanner";
import { binanceScanDeps } from "../data/binance";
import { intervalMs } from "../data/history";
import type { Direction } from "../scan/confluence";
import {
  compareOpportunities,
  newSince,
  opportunityKey,
  type Opportunity,
} from "../scan/opportunity";
import { DEFAULT_RULES } from "../setup/rules";
import {
  ruleText,
  WITHIN_CHOICES,
  type NewSetup,
  type NotifyRule,
  type WatchPrefs,
  type WatchState,
} from "../scan/watch";
import type { NotifyPermission } from "../alert/notify";

/** Who asked for a scan. A watched scan is not the operator's to cancel by leaving the desk. */
export type ScanSource = "manual" | "watch";

/** What one completed scan found, for the watcher to decide what to announce. */
export interface ScanOutcome {
  readonly timeframe: string;
  /** The first scan of a timeframe: nothing to be new relative to, so nothing is. */
  readonly baseline: boolean;
  /** Setups not in the previous scan of this timeframe (`newSince`). */
  readonly fresh: readonly NewSetup[];
  readonly error: string | null;
}

/**
 * The watcher, as the desk sees it.
 *
 * OWNED BY THE SHELL, not by this desk: the desk is built lazily and its point
 * is to tell you about setups while you are on the chart, so the loop has to
 * outlive every desk switch. The desk only draws its state and forwards clicks.
 */
export interface ScreenerWatch {
  readonly state: () => WatchState;
  readonly prefs: () => WatchPrefs;
  setOn(on: boolean): void;
  setRule(rule: NotifyRule): void;
  readonly desktop: () => NotifyPermission;
  requestDesktop(): void;
}

export interface ScreenerHandle {
  el: HTMLElement;
  /**
   * Cancel an OPERATOR's scan in flight; called when the view is left.
   *
   * A watched scan is deliberately untouched: the operator asked to be told
   * about setups while looking at something else, and cancelling on the first
   * desk switch would make that request mean nothing.
   */
  cancel(): void;
  /** Run a scan and report what was new. Null when it was superseded or skipped. */
  scan(source: ScanSource): Promise<ScanOutcome | null>;
  /** Abort a watched scan in flight, if one is. */
  abortWatch(): void;
  /**
   * The last scan's rows.
   *
   * Exposed so the Decision desk can build a correlation matrix from series
   * that have ALREADY been fetched. `scanUniverse` deliberately retains the
   * trimmed closes for cross-symbol work; before this they were retained and
   * then thrown away, which meant correlation would have cost a second pass
   * over the whole universe to compute something already in memory.
   */
  rows: Signal<ScanRow[]>;
}

const TOP_CHOICES = [25, 50, 100, 200] as const;

/**
 * Bars fetched per symbol.
 *
 * 1000 rather than the 400 the direction read needs, because the setup replay
 * scores every earlier instance of the pattern and 400 bars rarely holds the
 * twelve it takes to say anything. Binance weights a klines request by LIMIT
 * BAND, and 1-1000 is one band, so the extra history costs no request weight.
 */
const SCAN_BARS = 1000;

/** The row's opportunity, when the setup pipeline produced one. */
export function opportunityOf(row: ScanRow): Opportunity | null {
  return row.opportunity?.ok ? row.opportunity.opportunity : null;
}

/**
 * Rows with a live setup first, in the engine's own order; then everything
 * else in the conviction order `rankRows` already gives. A row without a setup
 * is still shown - the direction read is information - it just cannot outrank
 * a row that has a plan.
 */
export function rankByOpportunity(rows: readonly ScanRow[]): ScanRow[] {
  const withSetup = rows.filter((r) => opportunityOf(r) !== null);
  const without = rows.filter((r) => opportunityOf(r) === null);
  withSetup.sort((a, b) => compareOpportunities(opportunityOf(a) as Opportunity, opportunityOf(b) as Opportunity));
  return [...withSetup, ...without];
}

/**
 * How a measured pair becomes a drawn row.
 *
 * PURE, AND EXPORTED, SO IT CAN BE CHECKED BY LOOKING AT THE RESULT rather
 * than by mounting a desk - the same reason `viz/render.ts` keeps `edgeStyle`
 * beside its tests.
 *
 * FOUR CHANNELS, FOUR FACTS, NEVER CROSSED. This follows `edgeStyle` exactly:
 * LENGTH is magnitude, COLOUR is direction, DASH and ALPHA are confidence, and
 * the spread column is the confidence figure itself. An inverse pair is not a
 * weak pair - gold against the dollar is one of the steadiest relationships on
 * the board - so -0.9 draws as long a bar as +0.9 and only the colour differs.
 * A strong pair that reversed stays long and goes dashed, because it is still
 * strong and no longer settled.
 *
 * THREE STATES, WHERE `edgeStyle` HAS TWO. `stable` is false both for a pair
 * that moved and for one whose overlap was too short to slice, and those are
 * different facts: one is a measured reversal, the other is a question nobody
 * could ask. This repository files "could not ask" apart from "nothing there"
 * everywhere else, and a row is no different.
 */
export interface CorrRowStyle {
  /** Direction. Colour only. */
  readonly sign: "pos" | "neg";
  /** |r| as a CSS width. Magnitude only. */
  readonly width: string;
  /** Confidence. Dash and alpha only. */
  readonly settled: "yes" | "no" | "unknown";
  /** The instability figure, or an em dash where it could not be measured. */
  readonly spread: string;
  /** One sentence naming the window, for the row's title. */
  readonly why: string;
}

export function corrRowStyle(p: CorrelationPair): CorrRowStyle {
  const known = Number.isFinite(p.instability);
  const settled: CorrRowStyle["settled"] = known ? (p.stable ? "yes" : "no") : "unknown";
  /* THE WINDOW TRAVELS WITH THE FIGURE IN EVERY STATE. A coefficient with no
     window is a point estimate presented as a property of the pair. */
  const window = `${p.samples} overlapping bars`;
  const moved = known ? p.instability.toFixed(2) : "";

  const why =
    settled === "yes"
      ? `Held its window: r moved ${moved} across the ${SUB_WINDOWS} slices of ${window}.`
      : settled === "no"
        ? `Not settled: r moved ${moved} across the ${SUB_WINDOWS} slices of ${window}. The figure beside it is an average of relationships that differed.`
        : `Whether this held is unknown \u2014 ${window} is too short to re-measure in slices.`;

  return {
    sign: p.r >= 0 ? "pos" : "neg",
    width: `${(Math.abs(p.r) * 100).toFixed(0)}%`,
    settled,
    /* An em dash, never 0: 0 would read as "re-measured, and it never moved". */
    spread: known ? p.instability.toFixed(2) : "\u2014",
    why,
  };
}

export function createScreener(opts: {
  timeframe: Signal<string>;
  onPick: (symbol: string) => void;
  /** Saved views live here. */
  kv: KV;
  /**
   * What a multi-row selection can be sent to.
   *
   * Supplied by the shell rather than reached for: the useful verbs concern the
   * watchlist and the alert book, and a screener has no business knowing about
   * either. Optional so the desk still works without them.
   */
  onAddToWatchlist?: (symbols: readonly string[]) => void;
  /**
   * The operator's stop band, in ATR - the SAME rules the Setup card uses, so
   * a row and the card agree on a symbol. Defaults to the shipped rules.
   */
  stopRules?: () => { readonly minStopAtr: number; readonly maxStopAtr: number };
  /** "Watch for new setups". Optional so the desk still works without it. */
  watch?: ScreenerWatch;
}): ScreenerHandle {
  const watch = opts.watch;
  const rows = signal<ScanRow[]>([]);
  const scanning = signal(false);
  const progress = signal<ScanProgress>({ done: 0, total: 0, failed: 0 });
  const error = signal<string | null>(null);
  const expanded = signal<string | null>(null);
  const top = signal<number>(50);
  const scannedAt = signal<number>(0);
  /** Only rows carrying a live setup. */
  const setupsOnly = signal(false);
  /** Symbols whose setup was not in the previous scan of this timeframe. */
  const fresh = signal<ReadonlySet<string>>(new Set<string>());
  /**
   * The previous scan's setups, per timeframe. In memory only: "new since the
   * last scan" is a statement about this sitting, and a key persisted across a
   * restart would flag a day-old setup as new.
   */
  const lastSeen = new Map<string, Map<string, string>>();

  /**
   * Computed from the scan rows, so it can never be stale relative to them.
   *
   * Only the top rows: correlating fifty symbols produces 1,225 pairs, and a
   * list nobody can read is the same as no list.
   */
  const corr = computed<CorrelationRead | null>(() => {
    const list = rows().filter((r) => r.closes && r.closes.length > 30);
    if (list.length < 2) return null;
    const map = new Map<string, { t: number; c: number }[]>();
    for (const r of list.slice(0, 12)) map.set(r.symbol, r.closes as { t: number; c: number }[]);
    /* An exact timestamp join is right for this scan and only this scan: every
       series comes from ONE venue at ONE bar size, and at an intraday size two
       bars really can fall on the same UTC day, where bucketing would silently
       drop the earlier one. At a daily size that cannot happen, and the day key
       is what lets the same block survive a series arriving from a second
       vendor that stamps its daily bar at the session open. */
    const daily = intervalMs(opts.timeframe()) >= 86_400_000;
    return correlation(map, daily ? { bucket: utcDay } : {});
  });

  let controller: AbortController | null = null;
  let running: ScanSource | null = null;

  async function run(source: ScanSource = "manual"): Promise<ScanOutcome | null> {
    /* A watched scan never supersedes the operator's own: that scan will set
       the table and the markers, and the watcher waits for the next bar. */
    if (source === "watch" && running === "manual") return null;
    // A new scan supersedes the old one. Without this, results from the previous
    // timeframe land in the new table.
    controller?.abort();
    const ctl = new AbortController();
    controller = ctl;
    running = source;

    scanning.set(true);
    error.set(null);
    progress.set({ done: 0, total: 0, failed: 0 });
    /* A watched scan keeps the old table up until the new one lands: it runs
       once a bar, and blanking the desk under someone reading it every hour
       would be the watcher getting in the way. */
    if (source === "manual") rows.set([]);

    try {
      const out = await scanUniverse(binanceScanDeps, {
        interval: opts.timeframe(),
        top: top(),
        bars: SCAN_BARS,
        concurrency: 6,
        quote: "USDT",
        signal: ctl.signal,
        onProgress: (p) => progress.set(p),
        opportunity: {
          intervalMs: intervalMs(opts.timeframe()),
          ...(opts.stopRules?.() ?? {
            minStopAtr: DEFAULT_RULES.minStopAtr,
            maxStopAtr: DEFAULT_RULES.maxStopAtr,
          }),
          now: Date.now(),
        },
      });
      if (ctl.signal.aborted) return null;
      const ranked = rankByOpportunity(rankRows(out));
      const current = new Map<string, Opportunity>();
      for (const r of ranked) {
        const o = opportunityOf(r);
        if (o) current.set(r.symbol, o);
      }
      const tf = opts.timeframe();
      const prev = lastSeen.get(tf);
      /* The first scan of a timeframe has nothing to be new relative to, and
         flagging every row would make the marker mean nothing. */
      const isNew = prev ? newSince(prev, current) : new Set<string>();
      fresh.set(isNew);
      lastSeen.set(tf, new Map([...current].map(([sym, o]) => [sym, opportunityKey(o)])));
      rows.set(ranked);
      scannedAt.set(Date.now());
      return {
        timeframe: tf,
        baseline: prev === undefined,
        fresh: [...current].filter(([sym]) => isNew.has(sym)).map(([symbol, opportunity]) => ({ symbol, opportunity })),
        error: null,
      };
    } catch (err) {
      if (ctl.signal.aborted) return null;
      // Honest failure: say what broke, show nothing rather than a stale table.
      const msg = err instanceof Error ? err.message : String(err);
      error.set(msg);
      rows.set([]);
      return { timeframe: opts.timeframe(), baseline: false, fresh: [], error: msg };
    } finally {
      if (controller === ctl) {
        scanning.set(false);
        controller = null;
        running = null;
      }
    }
  }

  // ---- table ---------------------------------------------------------------

  const tbody = h("div", { class: "scr-body" });

  /**
   * Sorting and filtering.
   *
   * Before this the desk rendered rows in whatever order the scan happened to
   * finish — measured: there was no column-sort machinery anywhere in `src/ui`.
   * The row RENDERER below is untouched; only the order and the membership of
   * the list change, which is why this is a few lines rather than a rewrite.
   */
  const COLUMNS: Column<ScanRow>[] = [
    { id: "symbol", label: "Symbol", value: (r) => r.symbol, filter: "text" },
    { id: "price", label: "Price", value: (r) => r.lastPrice, filter: "number", align: "right" },
    { id: "change", label: "24h", value: (r) => r.changePct, filter: "number", align: "right" },
    { id: "volume", label: "Volume", value: (r) => r.quoteVolume, filter: "number", align: "right" },
    {
      id: "bias",
      label: "Bias",
      /* The scan's own word, so filtering "long" does what it reads like. */
      value: (r) => (r.result && !r.result.insufficient ? r.result.bias : null),
      filter: "text",
    },
    {
      id: "score",
      label: "Conf.",
      value: (r) => (r.result && !r.result.insufficient ? r.result.confidence : null),
      filter: "number",
      align: "right",
    },
    {
      id: "setup",
      label: "Setup",
      value: (r) => {
        const o = opportunityOf(r);
        return o ? `${o.direction} ${o.label}` : null;
      },
      filter: "text",
    },
    /* Stop distance as a share of price, NOT reward-to-risk. The first draft
       showed R here and every row read 1.0R, because the plan builder always
       puts target 1 at one R: a column that cannot vary tells you nothing.
       How far the stop is, by contrast, differs by symbol and decides size. */
    {
      id: "risk",
      label: "Risk",
      value: (r) => {
        const o = opportunityOf(r);
        return o ? o.riskPct * 100 : null;
      },
      filter: "number",
      align: "right",
    },
    {
      id: "edge",
      label: "Edge",
      value: (r) => opportunityOf(r)?.edge ?? null,
      filter: "number",
      align: "right",
    },
    {
      id: "age",
      label: "Age",
      value: (r) => opportunityOf(r)?.barsAgo ?? null,
      filter: "number",
      align: "right",
    },
    { id: "open", label: "", value: () => null, filter: "none" },
  ];

  const sort = signal<readonly SortKey[]>([]);
  const filters = signal<Record<string, string>>({});

  /** What the table actually shows, after filtering then ordering. */
  const shown = computed(() => {
    const base = setupsOnly() ? rows().filter((r) => opportunityOf(r) !== null) : rows();
    const filtered = applyFilters(base, COLUMNS, filters());
    return { rows: applySort(filtered.rows, COLUMNS, sort()), removed: filtered.removed, active: filtered.active };
  });

  /**
   * Selection.
   *
   * Keyed by SYMBOL rather than by index: the list is re-sorted and re-filtered
   * constantly, and an index-keyed selection would follow the position instead
   * of the row — you would sort the table and find three different symbols
   * selected.
   */
  const selected = signal<ReadonlySet<string>>(new Set<string>());
  const anchor = signal<string | null>(null);

  /* A row that is filtered out is no longer selectable, so the bulk bar must
     not offer to act on it. Derived rather than pruned on every filter change:
     re-widening the filter brings the selection back, which is what someone
     narrowing and re-widening a search expects. */
  const liveSelection = computed(() => {
    const visible = new Set(shown().rows.map((r) => r.symbol));
    return shown().rows.filter((r) => selected().has(r.symbol) && visible.has(r.symbol));
  });

  const clickRow = (symbol: string, e: MouseEvent): void => {
    const keys = shown().rows.map((r) => r.symbol);
    const next = selectRow(keys, selected(), anchor(), symbol, {
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
    });
    selected.set(next.selected);
    anchor.set(next.anchor);
  };

  const views = createViewStore(opts.kv, "screener.views");
  const activeView = signal<string | null>(null);

  const liveConfig = (): ViewConfig => ({ sort: sort(), filters: filters() });

  const applyView = (v: SavedView): void => {
    sort.set([...v.sort]);
    filters.set({ ...v.filters });
    activeView.set(v.id);
  };

  const biasChip = (bias: Direction, score: number): HTMLElement =>
    h("span", {
      class: "scr-bias",
      "data-bias": bias,
      text: bias === "neutral" ? "—" : `${bias.toUpperCase()} ${score >= 0 ? "+" : ""}${score.toFixed(2)}`,
    });

  /** A confidence bar: the number and its visual weight in one control. */
  const meter = (value: number, label: string): HTMLElement =>
    h(
      "span",
      { class: "scr-meter", title: label },
      h("span", { class: "scr-meter-fill", style: `width:${Math.round(value * 100)}%` }),
      h("span", { class: "scr-meter-text", text: value.toFixed(2) }),
    );

  /** The plan, the replay, and why - or why there is no plan. */
  const planBlock = (row: ScanRow): HTMLElement | null => {
    const read = row.opportunity;
    if (!read) return null;
    if (!read.ok) {
      return h(
        "div",
        { class: "scr-plan", "data-state": "none" },
        h("span", { class: "scr-plan-title", text: "No setup" }),
        h("p", { class: "scr-why", text: read.reason }),
      );
    }
    const o = read.opportunity;
    const hist = o.history;
    const cell = (label: string, value: string, tone?: string): HTMLElement =>
      h(
        "div",
        { class: "scr-plan-cell", ...(tone ? { "data-tone": tone } : {}) },
        h("span", { class: "scr-plan-k", text: label }),
        h("span", { class: "scr-plan-v num", text: value }),
      );
    return h(
      "div",
      { class: "scr-plan", "data-dir": o.direction },
      h(
        "div",
        { class: "scr-plan-head" },
        h("span", { class: "scr-plan-title", text: `${o.direction === "long" ? "Long" : "Short"}: ${o.label}` }),
        h("span", {
          class: "scr-plan-meta",
          text: `Score ${(o.score * 100).toFixed(0)} on ${(o.grounded * 100).toFixed(0)}% of the evidence, confirmed ${ageText(o.barsAgo)}`,
        }),
      ),
      h(
        "div",
        { class: "scr-plan-grid" },
        cell("Entry zone", `${fmtPrice(o.entryLow)} to ${fmtPrice(o.entryHigh)}`),
        cell("Stop", fmtPrice(o.stop), "neg"),
        cell("Target 1", fmtPrice(o.target1), "pos"),
        cell("Target 2", fmtPrice(o.target2), "pos"),
        cell("Reward to risk", `${o.rMultiple.toFixed(2)}R`),
        cell("One R", `${(o.riskPct * 100).toFixed(2)}% of price`),
      ),
      h("p", {
        class: "scr-why",
        text:
          `Stop set by ${o.stopFrom === "structure" ? "the setup's own invalidation level" : "volatility (ATR)"}. ` +
          (hist.enough
            ? `${hist.note} Edge ${fmtEdge(o.edge)} over break-even at ${o.rMultiple.toFixed(2)}R, measured on the pessimistic hit rate.`
            : `${hist.note} Too few past instances on these bars to state an edge.`) +
          (hist.adverse ? " History is against this pattern here: the whole expectancy interval is below zero." : ""),
      }),
      h("p", { class: "scr-plan-reason", text: o.reason }),
    );
  };

  const detail = (row: ScanRow): HTMLElement => {
    const res = row.result;
    const plan = planBlock(row);
    if (!res) {
      return h("div", { class: "scr-detail" }, h("p", { class: "scr-why", text: row.error ?? "no data" }));
    }
    if (res.insufficient) {
      return h("div", { class: "scr-detail" }, h("p", { class: "scr-why", text: res.insufficient }));
    }
    return h(
      "div",
      { class: "scr-detail" },
      plan ?? document.createComment(""),
      h(
        "div",
        { class: "scr-why-head" },
        h("span", { text: `agreement ${(res.agreement * 100).toFixed(0)}%` }),
        h("span", { text: `confidence ${(res.confidence * 100).toFixed(0)}%` }),
      ),
      ...res.signals.map((s) =>
        h(
          "div",
          { class: "scr-signal", "data-dir": s.direction },
          h("span", { class: "scr-signal-name", text: s.name }),
          h("span", { class: "scr-signal-reason", text: s.reason }),
          h("span", {
            class: "scr-signal-w",
            text: s.weight === 0 ? "context" : `w${s.weight} · ${s.strength.toFixed(2)}`,
          }),
        ),
      ),
    );
  };

  /** Four cells: setup, risk, edge, age. A row without a setup says why on hover. */
  const setupCells = (row: ScanRow): HTMLElement[] => {
    const o = opportunityOf(row);
    if (!o) {
      const why = row.opportunity && !row.opportunity.ok ? row.opportunity.reason : "";
      return [
        h("span", { class: "scr-na scr-setup", text: row.opportunity ? "no setup" : "", title: why }),
        h("span", { class: "scr-cell num scr-na", text: "" }),
        h("span", { class: "scr-cell num scr-na", text: "" }),
        h("span", { class: "scr-cell num scr-na", text: "" }),
      ];
    }
    const edgeTone = o.history.adverse ? "adverse" : o.edge === null ? "thin" : o.edge > 0 ? "pos" : "neg";
    return [
      h(
        "span",
        { class: "scr-setup", title: o.reason },
        h("span", { class: "scr-setup-dir", "data-dir": o.direction, text: o.direction === "long" ? "Long" : "Short" }),
        h("span", { class: "scr-setup-kind", text: o.label }),
        fresh().has(row.symbol)
          ? h("span", { class: "scr-new", text: "new", title: "Not in the previous scan of this timeframe" })
          : document.createComment(""),
      ),
      h("span", {
        class: "scr-cell num",
        text: `${(o.riskPct * 100).toFixed(2)}%`,
        title: `Stop ${fmtPrice(o.stop)}, set by ${o.stopFrom === "structure" ? "the setup's invalidation" : "volatility"}`,
      }),
      h("span", {
        class: "scr-cell num scr-edge",
        "data-tone": edgeTone,
        text: o.history.adverse ? "adverse" : o.edge === null ? `n=${o.history.n}` : fmtEdge(o.edge),
        title: o.history.note,
      }),
      h("span", { class: "scr-cell num", text: o.barsAgo === 0 ? "now" : `${o.barsAgo}b` }),
    ];
  };

  const rowEl = (row: ScanRow): HTMLElement => {
    const res = row.result;
    const open = (): void => expanded.update((cur) => (cur === row.symbol ? null : row.symbol));

    return h(
      "div",
      { class: "scr-row-wrap" },
      h(
        "div",
        {
          class: "scr-row",
          "data-open": () => String(expanded() === row.symbol),
          "data-selected": () => String(selected().has(row.symbol)),
          /* On the ROW, not the symbol button: the button opens the reasoning
             pane, and hijacking it for selection would cost the desk its
             cheapest interaction. */
          onclick: (e: Event) => {
            const ev = e as MouseEvent;
            if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey)) return;
            ev.preventDefault();
            clickRow(row.symbol, ev);
          },
        },
        h("button", { class: "scr-sym", text: row.symbol, onclick: open, title: "Show reasoning" }),
        h("span", { class: "scr-cell num", text: fmtPrice(row.lastPrice) }),
        h("span", {
          class: "scr-cell num",
          "data-dir": row.changePct >= 0 ? "up" : "down",
          text: `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%`,
        }),
        h("span", { class: "scr-cell num", text: fmtVol(row.quoteVolume) }),
        h(
          "span",
          { class: "scr-cell" },
          res && !res.insufficient
            ? biasChip(res.bias, res.score)
            : h("span", { class: "scr-na", text: row.error ? "error" : "no read" }),
        ),
        h(
          "span",
          { class: "scr-cell" },
          res && !res.insufficient ? meter(res.confidence, "confidence") : h("span", { text: "" }),
        ),
        ...setupCells(row),
        h("button", {
          class: "scr-open",
          text: "Chart",
          onclick: () => opts.onPick(row.symbol),
          title: `Load ${row.symbol} on the chart`,
        }),
      ),
      () => (expanded() === row.symbol ? detail(row) : document.createComment("")),
    );
  };

  /*
   * CLEAR THEN REBUILD IS THE WORST VERSION OF THIS SHAPE.
   *
   * The table was emptied FIRST and refilled from a fragment appended at the
   * end, so a single row whose render threw left the table cleared and nothing
   * put back — every row lost to one, silently, because a reaction swallows
   * what it throws. `trackrecord.ts` lost three whole tables to that exact
   * shape and it took `window.__signalErrors` to find.
   *
   * Building the fragment BEFORE clearing costs one extra frame's worth of
   * nodes and means a throw leaves the previous table standing, which is the
   * honest failure: stale beats empty when the alternative is silent.
   */
  renderEffect(() => {
    const list = shown().rows;
    if (list.length === 0) {
      clear(tbody);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(rowEl(r));
    clear(tbody);
    tbody.appendChild(frag);
  });

  // ---- shell ---------------------------------------------------------------

  const el = h(
    "section",
    { class: "screener" },

    h(
      "header",
      { class: "scr-head" },
      h("h2", { class: "scr-title", text: "Opportunity finder" }),
      h("span", {
        class: "scr-sub",
        text: () => `top ${top()} USDT pairs by 24h volume · ${opts.timeframe()}`,
      }),
      h("div", { style: "flex:1" }),

      watch
        ? h("span", {
            class: "scr-watch-state",
            "data-phase": () => watch.state().phase,
            text: () => watchLine(watch.state()),
            title: () => watch.state().reason,
          })
        : null,
      watch
        ? h("button", {
            class: "seg-btn scr-watch-btn",
            type: "button",
            text: "Watch for new setups",
            title: "Re-scan once per closed bar of this timeframe and notify when a new setup appears",
            "aria-pressed": () => String(watch.prefs().on),
            onclick: () => watch.setOn(!watch.prefs().on),
          })
        : null,

      h("button", {
        class: "seg-btn scr-only",
        type: "button",
        text: "Setups only",
        title: "Hide rows where the setup engine found nothing to trade",
        "aria-pressed": () => String(setupsOnly()),
        onclick: () => setupsOnly.update((v) => !v),
      }),

      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Universe size" },
        ...TOP_CHOICES.map((n) =>
          h("button", {
            class: "seg-btn",
            text: String(n),
            "aria-pressed": () => String(top() === n),
            onclick: () => top.set(n),
          }),
        ),
      ),

      h("button", {
        class: "ghost-btn",
        text: () => (scanning() ? "Cancel" : "Scan"),
        onclick: () => {
          if (scanning()) {
            controller?.abort();
            scanning.set(false);
          } else {
            void run("manual");
          }
        },
      }),
    ),

    /* The rule, stated where it is set. Shown only while watching: a rule for a
       loop that is off is a setting nobody needs to read. */
    watch
      ? h(
          "div",
          { class: "scr-watch", "data-show": () => String(watch.prefs().on) },
          h("span", { class: "scr-watch-rule", text: () => ruleText(watch.prefs()) }),
          h(
            "div",
            { class: "seg", role: "group", "aria-label": "Confirmed within" },
            ...WITHIN_CHOICES.map((n) =>
              h("button", {
                class: "seg-btn",
                type: "button",
                text: `${n} bar${n === 1 ? "" : "s"}`,
                title: `Notify only for setups confirmed within the last ${n} closed bar${n === 1 ? "" : "s"}`,
                "aria-pressed": () => String(watch.prefs().withinBars === n),
                onclick: () => watch.setRule({ withinBars: n, requireEdge: watch.prefs().requireEdge }),
              }),
            ),
          ),
          h("button", {
            class: "seg-btn",
            type: "button",
            text: "Measured edge only",
            title: "Also require the replay to show an edge above break-even; thin histories are excluded",
            "aria-pressed": () => String(watch.prefs().requireEdge),
            onclick: () =>
              watch.setRule({ withinBars: watch.prefs().withinBars, requireEdge: !watch.prefs().requireEdge }),
          }),
          h("button", {
            class: "ghost-btn",
            type: "button",
            text: "Allow desktop notifications",
            title: "Ask the browser once. Nothing asks for this automatically.",
            "data-show": () => String(watch.desktop() === "default"),
            onclick: () => watch.requestDesktop(),
          }),
          h("span", {
            class: "scr-watch-note",
            "data-show": () => String(watch.desktop() === "denied"),
            text: "Desktop notifications are blocked in this browser's site settings.",
          }),
        )
      : null,

    h("div", {
      class: "scr-status",
      "data-show": () => String(scanning() || error() !== null || rows().length > 0),
      text: () => {
        if (error()) return `Scan failed: ${error()}`;
        if (scanning()) {
          const p = progress();
          return p.total === 0
            ? "Loading universe…"
            : `Scanning ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ""}`;
        }
        const failed = rows().filter((r) => r.error).length;
        const at = scannedAt();
        if (at === 0) return "";
        const view = shown();
        /* A filter must never hide rows silently: the count says how many of
           how many, and how many filters are doing it. */
        const scope =
          view.active > 0
            ? `${view.rows.length} of ${rows().length} symbols · ${view.active} filter${view.active === 1 ? "" : "s"}`
            : `${rows().length} symbols`;
        const setups = rows().filter((r) => opportunityOf(r) !== null).length;
        const news = fresh().size;
        return `${scope} · ${setups} with a setup${news ? ` · ${news} new since last scan` : ""} · ${failed} could not be scanned · ${new Date(at).toLocaleTimeString()}`;
      },
    }),

    h(
      "div",
      { class: "scr-table" },
      /**
       * Saved views.
       *
       * A view is a QUESTION, not an answer — sort keys and filters, never
       * rows — so opening one re-asks it of whatever data is current. The dot
       * marks an arrangement that has drifted from the view it came from.
       */
      h("div", {
        class: "scr-views",
        ref: (el: HTMLElement) =>
          renderEffect(() => {
            clear(el);
            for (const v of views.views()) {
              el.appendChild(
                h(
                  "span",
                  {
                    class: "scr-view",
                    "data-on": () => String(activeView() === v.id),
                  },
                  h("button", {
                    class: "scr-view-name",
                    type: "button",
                    text: () =>
                      activeView() === v.id && !configMatches(v, liveConfig())
                        ? `${v.name} •`
                        : v.name,
                    title: `Sort and filters saved as "${v.name}"`,
                    onclick: () => applyView(v),
                  }),
                  h("button", {
                    class: "scr-view-x",
                    type: "button",
                    text: "✕",
                    title: `Forget "${v.name}"`,
                    onclick: () => {
                      views.remove(v.id);
                      if (activeView() === v.id) activeView.set(null);
                    },
                  }),
                ),
              );
            }
            el.appendChild(
              h("button", {
                class: "scr-view-add",
                type: "button",
                text: "+ Save this view",
                title: "Name the current sort and filters",
                /* Disabled rather than hidden when there is nothing to save:
                   a control that vanishes is a control you cannot learn. */
                disabled: () => isEmptyConfig(liveConfig()),
                onclick: () => {
                  const name = prompt("Name this view", "");
                  if (name === null || name.trim() === "") return;
                  activeView.set(views.save(name, liveConfig()));
                },
              }),
            );
          }),
      }),

      sortableHeader({
        columns: COLUMNS,
        sort: () => sort(),
        onSort: (next) => sort.set(next),
        rowClass: "scr-row scr-header",
        cellClass: "scr-hcell",
      }),
      filterRow({
        columns: COLUMNS,
        filters: () => filters(),
        onFilter: (id, raw) => filters.update((f) => ({ ...f, [id]: raw })),
        rowClass: "scr-row scr-filters",
      }),
      tbody,
    ),

    /**
     * The bulk bar.
     *
     * Appears only with a selection, and carries only verbs that make sense for
     * every row in it. It reports the count out loud because a selection that
     * has silently lost rows to a filter is a selection you would act on
     * wrongly.
     */
    h(
      "div",
      { class: "scr-bulk", "data-on": () => String(liveSelection().length > 0) },
      h("span", {
        class: "scr-bulk-count",
        text: () => `${liveSelection().length} selected`,
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: "Add to watchlist",
        "data-show": () => String(opts.onAddToWatchlist !== undefined),
        onclick: () => {
          opts.onAddToWatchlist?.(liveSelection().map((r) => r.symbol));
          selected.set(new Set());
        },
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: "Copy as TSV",
        title: "Paste straight into a spreadsheet",
        onclick: () => {
          void navigator.clipboard?.writeText(toTSV(liveSelection(), COLUMNS));
        },
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: "Clear",
        onclick: () => {
          selected.set(new Set());
          anchor.set(null);
        },
      }),
      h("span", {
        class: "scr-bulk-hint",
        text: "Ctrl-click to add a row · Shift-click for a range",
      }),
    ),

    /**
     * Correlation across whatever the scan just loaded.
     *
     * No extra requests: the scan already fetched these bars and kept the two
     * fields this needs. The point is diversification — a screener that lists
     * five setups is listing ONE setup if those five move together, and nothing
     * on a price chart tells you that.
     */
    h(
      "section",
      { class: "scr-why", "data-show": () => String(corr() !== null) },
      h(
        "div",
        { class: "scr-why-head" },
        h("span", { class: "label", text: "Correlation" }),
        h("span", { class: "flow-sub", text: () => corr()?.note ?? "" }),
      ),
      h("div", {
        class: "corr-list",
        ref: (el: HTMLDivElement) => {
          renderEffect(() => {
            const c = corr();
            clear(el);
            if (!c) return;
            if (c.pairs.length === 0) {
              el.appendChild(
                h("p", { class: "scr-na", text: "Not enough scanned symbols to compare." }),
              );
              return;
            }
            /* The spread column is a number nobody has met before, so it is
               named. A header row costs 18px and is the difference between a
               figure that changes a decision and one that gets ignored. */
            el.appendChild(
              h(
                "div",
                { class: "corr-row corr-head" },
                h("span", { text: "Pair" }),
                h("span", { text: "" }),
                h("span", { class: "num", text: "r" }),
                h("span", {
                  class: "num",
                  text: "spread",
                  title: `How far r moved across ${SUB_WINDOWS} slices of its own window. A wide spread means the pair reversed inside the window, so the single figure is an average of relationships that differed.`,
                }),
              ),
            );
            for (const p of c.pairs.slice(0, 12)) {
              const st = corrRowStyle(p);
              el.appendChild(
                h(
                  "div",
                  {
                    class: "corr-row",
                    "data-sign": st.sign,
                    "data-settled": st.settled,
                    title: st.why,
                  },
                  h("span", { class: "corr-pair", text: `${p.a} · ${p.b}` }),
                  h("span", { class: "corr-bar", style: `--w:${st.width}` }),
                  h("span", { class: "corr-val num", text: p.r.toFixed(2) }),
                  h("span", { class: "corr-spread num", text: st.spread }),
                ),
              );
            }
          });
        },
      }),
    ),

    h("p", {
      class: "scr-empty",
      "data-show": () => String(!scanning() && rows().length === 0 && !error()),
      text: "Press Scan to look for setups across the universe. Every symbol runs the same engine as the chart's Setup card: a plan with entry, stop and targets where there is one, and how that pattern has resolved on the symbol's own history. Click a symbol for the full plan and the reasoning.",
    }),

    h("p", {
      class: "scr-disclaimer",
      text: "Decision support only. Nothing here is a recommendation, and nothing here places an order.",
    }),
  );

  // A timeframe change invalidates the table: those scores were computed on
  // different bars. Clearing is more honest than leaving stale rows labelled
  // with the new timeframe.
  effect(() => {
    opts.timeframe();
    controller?.abort();
    rows.set([]);
    scannedAt.set(0);
  });

  return {
    el,
    rows,
    cancel() {
      if (running !== "manual") return;
      controller?.abort();
      controller = null;
      running = null;
      scanning.set(false);
    },
    scan: (source) => run(source),
    abortWatch() {
      if (running !== "watch") return;
      controller?.abort();
      controller = null;
      running = null;
      scanning.set(false);
    },
  };
}

/** "Watching · next scan 14:00:20", in local time, or why it is not counting down. */
export function watchLine(s: WatchState): string {
  switch (s.phase) {
    case "off":
      return "";
    case "scanning":
      return "Watching · scanning now";
    case "paused":
      return "Watching · paused while this tab is hidden";
    case "refused":
      return `Not watching · ${s.reason}`;
    case "waiting": {
      /* A daily or weekly close is often not today, and a bare "02:00:20" would
         read as tonight. The day is named whenever it is not today. */
      const when = s.nextAt === null ? null : new Date(s.nextAt);
      const day =
        when === null || when.toDateString() === new Date().toDateString()
          ? ""
          : `${when.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} `;
      const at =
        when === null
          ? ""
          : ` · next scan ${day}${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      return `Watching${at}${s.reason ? " · last scan failed" : ""}`;
    }
  }
}

function fmtPrice(v: number): string {
  const dp = v >= 1000 ? 2 : v >= 1 ? 4 : 8;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtEdge(v: number | null): string {
  if (v === null) return "n/a";
  return `${v >= 0 ? "+" : "-"}${Math.abs(v * 100).toFixed(1)} pts`;
}

function ageText(bars: number): string {
  if (bars === 0) return "on the last closed bar";
  return `${bars} bar${bars === 1 ? "" : "s"} ago`;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}
