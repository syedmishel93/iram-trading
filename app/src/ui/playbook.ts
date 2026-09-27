/**
 * The Playbook desk — the strategy library, and the editor for it.
 *
 * WHY THIS IS NOT PART OF THE STRATEGY DESK
 * They answer different questions. The Strategy desk runs a SWEEP: many
 * parameterisations of one family, walk-forward, and an overfitting probability
 * that qualifies the whole thing. This desk runs ONE rule set that you can read
 * and change, and shows you what it did. Putting the second inside the first
 * would bury an editor under a verdict about a study it was not part of.
 *
 * WHAT MAKES IT WORTH HAVING
 * Every rule is printed as a sentence before it is run, and the sentence is
 * generated from the same data the engine evaluates — not written alongside it.
 * A strategy whose description and behaviour can disagree is the normal state
 * of affairs in this corner of the industry, and it is the reason nobody trusts
 * a backtest they did not run themselves. Here they cannot disagree, because
 * there is only one of them.
 *
 * THE RESULT IS DELIBERATELY UNFLATTERING
 * Trades, win rate, profit factor, expectancy in R, max drawdown and the
 * longest losing streak — with costs on by default. The streak is there because
 * it is what actually decides whether a strategy is sittable, and it is the
 * number every strategy marketing page omits.
 */

import { h } from "./dom";
import { pkWhy } from "./panelkit";
import { heldSymbols, symbolField, symbolOptions, type SymbolOption } from "./cards/symbolfield";
import { calibrationCard, liveBuckets, skillSentence } from "./cards/calibration";
import { onShown } from "./cards/shown";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import type { BarView } from "../chart/series";
import type { BarArchive, SeriesInventory } from "../store/barstore";
import type { HistoryService } from "../data/history";
import { runBacktest, DEFAULT_COSTS, type Trade, type Costs, type RunFriction, type RunSettle } from "../backtest/engine";
import { computeMetrics, verdict, EMPTY_METRICS, type Metrics } from "../backtest/metrics";
import { splitRun, DEFAULT_HOLDOUT, type HoldoutSplit } from "../backtest/holdout";
import { summariseAcross, type MarketRun, type AcrossSummary } from "../backtest/across";
import { compareRules, type HeadToHead } from "../backtest/headtohead";
import { buildReceipt, receiptFilename, receiptText, type Receipt } from "../backtest/receipt";
import { resolveCosts, type ResolvedCosts } from "../backtest/realcosts";
import { brokerCosts, type BrokerSpec } from "../data/brokercosts";
import {
  COLUMNS,
  OPERATORS,
  compileSpec,
  validateSpec,
  groupText,
  stopText,
  targetText,
  type ColumnId,
  type Condition,
  type ConditionGroup,
  type OperatorId,
  type RuleSpec,
  type StopSpec,
  type TargetSpec,
} from "../backtest/rules";
import { planRun, planLine, loadForPlan, nearestTimeframe, type RunPlan } from "../backtest/runplan";
import { collectSignals } from "../backtest/collect";
import { buildLedger, baseRate, type Ledger } from "../backtest/ledger";
import { trainRouter, type RouterResult } from "../data/router";
import { composePair, type HybridSpec, type HybridRejected } from "../backtest/hybrid";
import { SPECS, STYLE_LABEL } from "../backtest/specs";

export interface PlaybookOptions {
  /** The chart's symbol — the DEFAULT for this desk's own picker, not a lock. */
  readonly symbol: Signal<string>;
  readonly timeframe: Signal<string>;
  readonly history: HistoryService;
  readonly kv: KV;
  /**
   * The bar archive, so a year range can be checked against what is actually
   * held BEFORE anything is fetched. Optional: without it the desk still runs,
   * it just cannot say that 2000 is five years before the data starts.
   */
  readonly archive?: BarArchive;
}

/**
 * THE RUN IS PLANNED, NOT CONSTANT.
 *
 * This was `const WANTED_BARS = 1500`, and the desk asked for that many
 * whatever it was testing, on whatever the chart happened to show. MEASURED on
 * the owner's screen: 992 bars arrived and a rule produced 73 trades — a
 * number describing the WINDOW rather than the strategy. `planRun` turns a
 * year range into a bar count against what the archive actually holds, and
 * says so when the two differ.
 */

/**
 * Bars a setup has to resolve in, before it is called a timeout.
 *
 * A CONSTANT, STATED ON SCREEN, rather than derived from the target — because
 * a horizon that moved with the rule would make two rules' base rates
 * incomparable, and the base rate is the number the router has to beat. On 1h
 * bars this is about four days.
 */
const LEDGER_HORIZON = 100;

/** Bar sizes a rule set can be tested on. */
const TFS = ["5m", "15m", "1h", "4h", "1d"] as const;

/** Before this, none of the venues here have anything. */
const FIRST_YEAR = 2017;

interface Saved {
  /** Specs you have written or edited, by id. Shipped specs are not stored. */
  custom: RuleSpec[];
  selected: string;
  /* What the desk was last testing. Every one optional, because a slot that
     cannot read an older save is a slot that silently loses the rule sets
     somebody wrote — the specs are the valuable part here, not the window. */
  symbol?: string;
  timeframe?: string;
  fromYear?: number;
  toYear?: number;
  balance?: number;
  riskPct?: number;
  /** The rule set used as a filter over the selected one. "" for none. */
  combine?: string;
}

const SLOT = {
  key: "playbook.v1",
  version: 1,
  fallback: (): Saved => ({ custom: [], selected: SPECS[0]?.id ?? "" }),
  /* v62.3 widened this shape. The validator below accepts a save without the
     new fields precisely so an existing Playbook keeps its custom rule sets;
     the window falls back to a default, which costs nothing. */
  validate: (v: unknown): Saved | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const custom = Array.isArray(o["custom"]) ? (o["custom"] as RuleSpec[]) : [];
    /* Anything that fails validation is dropped rather than loaded and left to
       fail at run time. A stored rule referencing an indicator a later build
       removed must not take the desk down on open. */
    const kept = custom.filter((s) => {
      try {
        return validateSpec(s).length === 0;
      } catch {
        return false;
      }
    });
    return { custom: kept, selected: typeof o["selected"] === "string" ? o["selected"] : SPECS[0]?.id ?? "" };
  },
};

const pct = (n: number, dp = 1): string => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : "—");
const fixed = (n: number, dp = 2): string => (Number.isFinite(n) ? n.toFixed(dp) : "—");

export function createPlaybook(opts: PlaybookOptions) {
  const stored = opts.kv.read(SLOT).value;

  const custom = signal<RuleSpec[]>(stored.custom);
  const selectedId = signal(stored.selected);
  /** The spec being edited. Null while showing a shipped spec unmodified. */
  const draft = signal<RuleSpec | null>(null);

  /* THE DESK'S OWN SUBJECT. The chart's symbol is the DEFAULT, not a lock:
     testing a rule set is a different activity from watching a market, and
     tying the two together is why this desk could only ever test what was
     already on screen. */
  const nowYear = new Date().getUTCFullYear();
  const symbol = signal(stored.symbol || opts.symbol());
  /* CONSTRAINED TO WHAT THE PICKER OFFERS. The chart's bar size is the
     default and the chart has sizes this desk does not — MEASURED live: the
     select displayed "5m" while the plan beneath it refused on "3m", because a
     `<select>` handed a value outside its options shows the first one and says
     nothing. A control that shows one size and runs another is worse than one
     that refuses. */
  const timeframe = signal(nearestTimeframe(stored.timeframe || opts.timeframe(), TFS));
  const fromYear = signal(stored.fromYear || Math.max(FIRST_YEAR, nowYear - 4));
  const toYear = signal(stored.toYear || nowYear);
  const balance = signal(stored.balance || 500);
  const riskPct = signal(stored.riskPct || 1);
  /** Every symbol the archive holds anything of, for the Market box. */
  const heldAll = signal<SymbolOption[]>([]);

  /** What the archive holds for the chosen series, once it has been read. */
  const holding = signal<{ oldest: number; newest: number; bars: number } | null>(null);
  /*
   * WHY `holding: null` IS NOT ENOUGH.
   *
   * It means both "asked, and there is none" and "nobody has asked yet", and
   * the plan renders the first for both — so the desk opened saying the
   * archive was empty against an archive holding a thousand bars, and only
   * told the truth once a control was touched. Same class as a health strip
   * reading "0 of 0 running" green because nothing had reported yet.
   */
  const holdingNote = signal("Checking what the archive holds\u2026");

  const plan = computed<RunPlan>(() =>
    planRun(
      {
        symbol: symbol(),
        timeframe: timeframe(),
        fromYear: fromYear(),
        toYear: toYear(),
        balance: balance(),
        riskPct: riskPct(),
      },
      holding(),
    ),
  );

  /*
   * FETCHING A SERIES THE ARCHIVE HAS NEVER SEEN.
   *
   * The owner's report, with a screenshot: "the archive holds no EURUSD 15m to
   * run on", and nothing on screen to do about it. Holding nothing was treated
   * as a dead end and it is not — `history.backfill` reaches for a series the
   * archive has never held, which is the same call `loadForPlan` already makes
   * for one it holds too little of. The refusal now carries `missing`, a typed
   * descriptor rather than a sentence, and this is the control it enables.
   *
   * `history.backfill`, NOT `startBulkDownload`. The bulk downloader fills the
   * SERVER's Parquet store while this desk plans against the archive the
   * browser reads, so wiring the obvious-looking one would have been a button
   * that downloads into a store the plan never consults, finishes green, and
   * leaves the same refusal on screen. Checked before building, not after.
   */
  const fetching = signal(false);
  const fetchAbort = signal<AbortController | null>(null);

  /*
   * THE HELD-BACK WINDOW, and what the run was charged.
   *
   * This desk's own result panel said it: "a description of the past, not
   * evidence of an edge", and then sent the operator to another desk. The rule
   * set has already been CHOSEN, usually after seeing how it did, so a number
   * over the window the choice was made on cannot argue with it. Holding back
   * the most recent slice is the cheapest instrument that can, and it runs on
   * the SAME pass — `backtest/holdout.ts` partitions the trades by entry time
   * rather than running the engine twice, because a second run would begin
   * blind of its indicators' lead-in.
   */
  const holdout = signal<HoldoutSplit | null>(null);
  const holdoutShare = signal(DEFAULT_HOLDOUT);

  /*
   * THE LAST RUN'S TRADES, KEPT SO THE SPLIT CAN MOVE WITHOUT RE-RUNNING.
   *
   * Changing where the line falls is arithmetic over trades that are already
   * priced; re-running the engine for it would charge the operator minutes to
   * answer a question the existing result already contains. Cleared with the
   * result, so a split can never describe a run that is no longer on screen.
   */
  const lastRun = signal<{
    readonly trades: readonly Trade[];
    readonly equity: ArrayLike<number>;
    readonly times: readonly number[];
  } | null>(null);

  /*
   * AND WHAT IT COST. `DEFAULT_COSTS` charges a flat 2bp spread; measured
   * against this operator's broker that is 4.7x the real XAUUSD spread. Costs
   * set the hurdle, so overcharging is not the safe direction — it discards
   * rules that would have cleared the real spread, silently.
   *
   * The measured figure is OFFERED and never adopted by default: a hurdle that
   * moved because a service answered is a result that changed for a reason
   * nobody chose.
   */
  /*
   * DOES IT WORK ANYWHERE ELSE?
   *
   * One market cannot say whether an edge is real or a property of that
   * market's last few years. A CONTROL THAT TAKES ONE OF SOMETHING PER PRESS IS
   * A FORM, NOT A TOOL — so the same rule can be put to everything the archive
   * holds, in one press.
   *
   * SEQUENTIALLY, never in parallel: `loadForPlan` reaches for history that is
   * short, and parallel backfills are how a free vendor tier starts refusing.
   * The queue line names the market in flight, because an unchanging
   * "Running…" is indistinguishable from a hang.
   *
   * IT COUNTS AND NAMES; IT NEVER RANKS. Sorting by expectancy would turn six
   * honest measurements into a search, and a sorted table always has a big
   * number at the top — including on data with no edge in it.
   */
  /* THE WHOLE INVENTORY, kept because the across-run plans each market against
     its OWN holding. Planning them all against the current series' history would
     ask every run the wrong question. */
  const inventory = signal<readonly SeriesInventory[]>([]);
  /*
   * TWO RULE SETS, SAME BARS.
   *
   * The easiest place in a backtest panel to mislead: the eye picks the bigger
   * number and the bigger number is usually noise. `headtohead.ts` reports the
   * DIFFERENCE and its standard error, so a gap the data cannot support is
   * called a tie rather than a winner.
   *
   * It runs on the bars the last run already loaded — the comparison is only
   * worth something if the only thing that changed is the rule.
   */
  /*
   * WHAT THE LAST RUN WAS MEASURED ON, kept so the receipt records the DATA and
   * not the request. The Playbook once printed "1,598 bars" from the plan beside
   * a trade count computed on the 999 that arrived; a receipt built from the
   * plan would bake that into the permanent record.
   */
  const ranOn = signal<{
    readonly bars: number;
    readonly first: number;
    readonly last: number;
    readonly source: string;
    readonly shortfall: string;
    readonly costs: Costs;
    readonly spreadMeasured: boolean;
    readonly askedBars: number;
  } | null>(null);
  const exportNote = signal("");

  const rivalId = signal("");
  const h2h = signal<HeadToHead | null>(null);
  const h2hBusy = signal(false);

  const acrossPicked = signal<readonly string[]>([]);
  const acrossRuns = signal<readonly MarketRun[]>([]);
  const acrossSummary = signal<AcrossSummary | null>(null);
  const acrossBusy = signal("");

  const specs = signal<Readonly<Record<string, BrokerSpec>>>({});
  const useMeasuredCosts = signal(false);
  const costNote = signal("");
  /* The price the last run ended on. A spread in POINTS is only a fraction once
     you know what it is a fraction of, so the comparison cannot be made before
     a run has established one. */
  const lastClose = signal(0);

  /** The broker's spec for the series being tested, or null. */
  const specFor = (sym?: string): BrokerSpec | null => {
    const table = specs();
    const want = (sym ?? symbol()).toUpperCase();
    /* FILED UNDER BOTH SPELLINGS by the server (`spec_keys`), because a broker
       quotes `XAUUSD.s` and the terminal says `XAUUSD`. Looked up by the
       canonical name first, then anything that suffixes it — the pair that cost
       a whole release when sizing could find neither. */
    const direct = table[want];
    if (direct) return direct;
    const key = Object.keys(table).find((k) => k.toUpperCase().split(".")[0] === want);
    return key ? (table[key] ?? null) : null;
  };

  /*
   * THE NOTE CARRIES THE SERIES IT IS ABOUT.
   *
   * MEASURED on screen: after fetching BTCUSDT 15m, typing EURUSD left
   * "36,000 bars stored" sitting under a refusal for EURUSD — a readout about
   * one series describing another, which is the same class as a desk opening on
   * BTCUSDT 1d under a hero that named neither. Clearing it at each of the seven
   * `readHolding()` call sites is the version that goes wrong the next time one
   * is added; tagging it means the note cannot outlive its subject.
   */
  const fetchNote = signal<{ readonly series: string; readonly text: string } | null>(null);
  const seriesKey = (): string => `${symbol()} ${timeframe()}`;
  const sayFetch = (text: string): void => fetchNote.set({ series: seriesKey(), text });
  const fetchLine = (): string => {
    const n = fetchNote();
    return n !== null && n.series === seriesKey() ? n.text : "";
  };

  /** What the archive holds for one symbol at the CURRENT bar size, or null. */
  const heldFor = (sym: string): { oldest: number; newest: number; bars: number } | null => {
    const rows = inventory().filter(
      (r) => r.symbol === sym && r.timeframe === timeframe(),
    );
    if (rows.length === 0) return null;
    return {
      oldest: Math.min(...rows.map((r) => r.oldest)),
      newest: Math.max(...rows.map((r) => r.newest)),
      bars: rows.reduce((acc, r) => acc + r.bars, 0),
    };
  };

  /* Read what the archive holds whenever the series changes, so the plan can
     warn BEFORE a run rather than after one. */
  const readHolding = (): void => {
    const arc = opts.archive;
    if (arc === undefined) {
      holdingNote.set("This build has no local archive, so nothing can be planned against what you hold.");
      return;
    }
    void arc
      .inventory()
      .then((inv: SeriesInventory[]) => {
        /* ONE READ ANSWERS BOTH QUESTIONS. This desk was already fetching the
           whole inventory to size one series and discarding the rest, while
           its Market box made you type a symbol from memory. */
        heldAll.set(heldSymbols(inv));
        inventory.set(inv);
        const rows = inv.filter((r) => r.symbol === symbol() && r.timeframe === timeframe());
        holdingNote.set("");
        if (rows.length === 0) {
          holding.set(null);
          return;
        }
        holding.set({
          oldest: Math.min(...rows.map((r) => r.oldest)),
          newest: Math.max(...rows.map((r) => r.newest)),
          bars: rows.reduce((acc, r) => acc + r.bars, 0),
        });
      })
      .catch((err: unknown) => {
        /* NOT A ZERO. An archive that cannot be read is not an archive with
           nothing in it, and rendering the second for the first is the most
           alarming possible way to say "I do not know". */
        holding.set(null);
        holdingNote.set(
          `The local archive could not be read, so what you hold is unknown: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  };

  /** The receipt for the run on screen, or null when there is nothing to record. */
  const currentReceipt = (): Receipt | null => {
    const ran = ranOn();
    const res = result();
    const spec = effective();
    const base = current();
    /* `current()` returns null, not undefined — tsc caught the assumption. */
    if (ran === null || res === null || spec === null || base === null || base === undefined) {
      return null;
    }
    return buildReceipt({
      ruleId: base.id,
      ruleName: base.name,
      spec,
      combinedWith: (() => {
        const c = combined();
        return c !== null && "spec" in c ? (combineId() || null) : null;
      })(),
      symbol: symbol(),
      timeframe: timeframe(),
      askedFromYear: fromYear(),
      askedToYear: toYear(),
      askedBars: ran.askedBars,
      bars: ran.bars,
      firstBarTime: ran.first,
      lastBarTime: ran.last,
      source: ran.source,
      shortfall: ran.shortfall,
      costs: ran.costs,
      spreadMeasured: ran.spreadMeasured,
      balance: balance(),
      riskPct: riskPct(),
      metrics: res.metrics,
      friction: res.friction,
      settle: res.settle,
      holdout: holdout(),
      across: acrossSummary(),
      headToHead: h2h(),
    });
  };

  /**
   * Save the receipt as a file the operator keeps.
   *
   * A Blob and an anchor, revoked immediately: an object URL left behind pins
   * the whole document in memory for the life of the page, and this one has a
   * job that lasts a single click.
   */
  const saveReceipt = (): void => {
    const r = currentReceipt();
    if (r === null) {
      exportNote.set("Run a backtest first — there is nothing to record yet.");
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([receiptText(r)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = receiptFilename(r);
      a.click();
      URL.revokeObjectURL(url);
      exportNote.set(`Saved ${receiptFilename(r)}.`);
    } catch (err: unknown) {
      exportNote.set(
        `That could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** The same thing to the clipboard, for pasting into a note or a message. */
  const copyReceipt = (): void => {
    const r = currentReceipt();
    if (r === null) {
      exportNote.set("Run a backtest first — there is nothing to record yet.");
      return;
    }
    void navigator.clipboard
      .writeText(receiptText(r))
      .then(() => exportNote.set("Copied. It carries the bars, the vendor and the costs it used."))
      /* A CLIPBOARD REFUSAL IS ORDINARY — a browser can deny it without the
         page being wrong — so it is reported rather than swallowed. */
      .catch(() => exportNote.set("The browser would not let this page use the clipboard. Use Save instead."));
  };

  /**
   * Run a second rule set on the bars the last run already used.
   *
   * SAME BARS, SAME COSTS, SAME WINDOW. A comparison is only worth something if
   * the only thing that changed is the rule, and re-loading history for the
   * rival would risk a different vendor answer between the two runs — the
   * defect this desk already records, where three identical runs gave 156, 480
   * and 480 trades because something was not re-read.
   */
  const runHeadToHead = async (): Promise<void> => {
    const mine = effective();
    const rival = all().find((r) => r.id === rivalId());
    const loaded = lastRun();
    if (mine === null || rival === undefined || loaded === null || h2hBusy()) return;

    h2hBusy.set(true);
    h2h.set(null);
    try {
      /* The rival runs on the SAME bar array the last run held. Nothing is
         fetched, so nothing can differ except the rule. */
      const charged = resolveCosts(specFor(), lastClose(), useMeasuredCosts());
      const r = runBacktest(compileSpec(rival), bars(), {
        costs: charged.costs,
        containsDemo: false,
      });
      h2h.set(
        compareRules(
          mine.name,
          loaded.trades,
          rival.name,
          r.refused === null ? r.trades : [],
        ),
      );
    } catch (err: unknown) {
      note.set(`That comparison did not finish: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      h2hBusy.set(false);
    }
    await Promise.resolve();
  };

  /**
   * Put the SAME rule to several markets, one after another.
   *
   * Same strategy, same bar size, same window, same cost model — the comparison
   * is only worth anything if the only thing that changed is the market. A run
   * that quietly used a different hurdle on one of them would answer a question
   * nobody asked.
   *
   * SEQUENTIAL. Each market may need `loadForPlan` to reach back, and parallel
   * backfills are how a free vendor tier starts refusing. Slower, and it is the
   * difference between a tool and a way to get rate-limited.
   */
  const runAcross = async (): Promise<void> => {
    const spec = effective();
    const picked = acrossPicked();
    if (spec === null || picked.length === 0 || acrossBusy() !== "") return;

    acrossRuns.set([]);
    acrossSummary.set(null);
    const strategy = compileSpec(spec);
    const out: MarketRun[] = [];

    for (const sym of picked) {
      acrossBusy.set(sym);
      const p = planRun(
        {
          symbol: sym,
          timeframe: timeframe(),
          fromYear: fromYear(),
          toYear: toYear(),
          balance: balance(),
          riskPct: riskPct(),
        },
        /* PLANNED AGAINST ITS OWN HOLDING, not the desk's. `planRun` takes what
           the archive has for THAT series, and passing the current market's
           would plan every run against the wrong history. */
        heldFor(sym),
      );
      if (!p.ok) {
        out.push({
          symbol: sym, timeframe: timeframe(), trades: 0, expectancyR: NaN,
          winRate: NaN, refused: true, why: p.why,
        });
        acrossRuns.set([...out]);
        continue;
      }
      try {
        const hist = await loadForPlan(opts.history, p);
        const close = hist.bars.length > 0 ? (hist.bars[hist.bars.length - 1]?.c ?? 0) : 0;
        const charged = resolveCosts(specFor(sym), close, useMeasuredCosts());
        const r = runBacktest(strategy, hist.bars, {
          costs: charged.costs,
          containsDemo: hist.containsDemo,
        });
        const m = r.refused ? { ...EMPTY_METRICS } : computeMetrics(r.trades, r.equity);
        out.push({
          symbol: sym,
          timeframe: timeframe(),
          trades: r.trades.length,
          expectancyR: r.refused ? NaN : m.expectancyR,
          winRate: r.refused ? NaN : m.winRate,
          /* `refused` is the REASON, not a flag — tsc caught the assumption,
             and the reason is the half worth keeping: the engine refuses a run
             over generated bars and that must reach the screen. */
          refused: r.refused !== null,
          why: r.refused ?? "",
        });
      } catch (err: unknown) {
        /* ONE DEAD MARKET DOES NOT ABANDON THE OTHERS, and it is named rather
           than dropped — a partial failure that vanishes makes the denominator
           a lie. */
        out.push({
          symbol: sym, timeframe: timeframe(), trades: 0, expectancyR: NaN,
          winRate: NaN, refused: true,
          why: err instanceof Error ? err.message : String(err),
        });
      }
      acrossRuns.set([...out]);
    }

    acrossBusy.set("");
    acrossSummary.set(summariseAcross(out));
  };

  /**
   * Reach for a series the archive does not hold, then re-plan.
   *
   * REPORTS WHAT ARRIVED, INCLUDING ZERO. A vendor that has never listed
   * EURUSD 15m answers with nothing, and a control that then said "done" would
   * be the most alarming possible way to say "I found none" — the same mistake
   * as rendering 0 for an unreachable service. Zero bars is stated as zero.
   */
  const fetchMissing = (): void => {
    const want = plan().missing;
    if (want === null || fetching()) return;

    const ctl = new AbortController();
    fetchAbort.set(ctl);
    fetching.set(true);
    sayFetch(`Reaching for ${want.symbol} ${want.timeframe}…`);

    void opts.history
      .backfill(want.symbol, want.timeframe, want.wantBars, {
        signal: ctl.signal,
        /* A COUNT THAT MOVES. An unchanging "Downloading…" is
           indistinguishable from a hang, which this project already records
           about the data library's own queue. */
        onProgress: (added, target) => {
          sayFetch(`${added.toLocaleString()} of about ${target.toLocaleString()} bars so far…`);
        },
      })
      .then((added: number) => {
        if (added > 0) {
          sayFetch(`${added.toLocaleString()} bars stored. Re-checking what you hold…`);
        } else {
          sayFetch(
            `No ${want.symbol} ${want.timeframe} came back. The vendors this build can reach do not ` +
              "serve that series — try a different bar size, or a symbol from the list the Market box offers.",
          );
        }
        /* RE-READ, ALWAYS. `backfill` returns a count and writes to the
           archive; the plan is computed from `holding()`, so without this the
           refusal stays on screen beside a successful download. That is the
           defect `loadForPlan` exists to have fixed, arriving one level up. */
        readHolding();
      })
      .catch((err: unknown) => {
        sayFetch(
          ctl.signal.aborted
            ? "Stopped. Anything already stored was kept."
            : `That fetch did not finish: ${err instanceof Error ? err.message : String(err)}`,
        );
        readHolding();
      })
      .finally(() => {
        fetching.set(false);
        fetchAbort.set(null);
      });
  };

  /**
   * THE SECOND RULE SET, used as a FILTER over the first.
   *
   * Empty means "test A on its own". `composePair` is deliberately asymmetric
   * — A's whole entry is the trigger, and only B's STATE conditions come
   * across — because two EVENT conditions ANDed ask for two crossings on the
   * same bar, which on 5,000 bars of BTCUSDT 1h is a handful of trades and not
   * a strategy. `hybrid.ts` argues that in full at the top of itself.
   */
  const combineId = signal(stored.combine ?? "");
  const running = signal(false);
  const note = signal("");
  const bars = signal<readonly BarView[]>([]);
  const loadedFrom = signal("");
  /* FRICTION AND SETTLE TRAVEL WITH THE METRICS. They are facts about the run
     that produced them — what it paid and how much of it was measured rather than
     assumed — and the receipt has to state both. Dropping them here and reading
     them back from a later run would be the shape of the defect this desk already
     paid for: a figure computed from state somebody forgot to re-read. */
  const result = signal<{
    metrics: Metrics;
    refused: string | null;
    trades: number;
    friction: RunFriction;
    settle: RunSettle;
  } | null>(null);

  const all = computed<RuleSpec[]>(() => [...SPECS, ...custom()]);

  const current = computed<RuleSpec | null>(() => {
    const d = draft();
    if (d) return d;
    return all().find((s) => s.id === selectedId()) ?? all()[0] ?? null;
  });

  /*
   * DECLARED HERE, BELOW `all` AND `current`, AND THAT IS NOT COSMETIC.
   *
   * `computed` in `core/signal.ts` is `effect(() => out.set(fn()))`, and an
   * effect runs IMMEDIATELY. So a computed placed above a `const` it reads
   * throws a temporal-dead-zone ReferenceError at mount, the effect logs it,
   * and the computed holds `undefined` for the life of the page. These two
   * sat above `all` and `current` and did exactly that: `combined()` was
   * undefined, `effective` then threw again on `"spec" in undefined`, and
   * `run()` — which opens `const spec = effective(); if (!spec) return;` —
   * returned before its first line of work. THE RUN BUTTON DID NOTHING, with
   * no note, no error on screen and no DOM change at all.
   */
  /** The composition, or the named reason there isn't one. Null when off. */
  const combined = computed<HybridSpec | HybridRejected | null>(() => {
    const id = combineId();
    if (id === "") return null;
    const a = current();
    const b = all().find((x) => x.id === id);
    if (!a || !b || a.id === b.id) return null;
    return composePair(a, b);
  });

  /** What will actually be tested: the hybrid when it composed, else A alone. */
  const effective = computed<RuleSpec | null>(() => {
    const c = combined();
    if (c !== null && "spec" in c) return c.spec;
    return current();
  });

  /* WHAT THE MACHINE MADE OF THE RUN. Three separate facts, because they
     fail separately: the ledger (which always exists once a run does), the
     router's answer (which needs a service), and whether we are waiting. */
  const ledger = signal<Ledger | null>(null);
  const router = signal<RouterResult | null>(null);
  const learning = signal(false);
  const learnNote = signal("");
  /** What the sample lost on the way, and why. Empty when it lost nothing. */
  const sampleNote = signal("");

  const problems = computed(() => {
    const s = current();
    return s ? validateSpec(s) : [];
  });

  const persist = (): void => {
    opts.kv.write(SLOT, {
      custom: custom(),
      selected: selectedId(),
      symbol: symbol(),
      timeframe: timeframe(),
      fromYear: fromYear(),
      toYear: toYear(),
      balance: balance(),
      riskPct: riskPct(),
      combine: combineId(),
    });
  };

  /** Editing a shipped spec forks it, rather than mutating the library. */
  const edit = (mutate: (s: RuleSpec) => RuleSpec): void => {
    const base = current();
    if (!base) return;
    const isCustom = custom().some((c) => c.id === base.id);
    const next = mutate(base);
    if (isCustom) {
      custom.set(custom().map((c) => (c.id === base.id ? next : c)));
      draft.set(null);
      persist();
    } else {
      draft.set(next);
    }
  };

  const saveDraft = (): void => {
    const d = draft();
    if (!d) return;
    /* A fork gets a new id and a name that says what it came from, because two
       strategies with the same name in one list is how you end up testing the
       one you did not mean to. */
    const id = `custom-${Date.now().toString(36)}`;
    const base = SPECS.find((s) => s.id === selectedId());
    const name = base ? `${base.name} (edited)` : d.name;
    const saved: RuleSpec = { ...d, id, name, style: "custom" };
    custom.set([...custom(), saved]);
    selectedId.set(id);
    draft.set(null);
    persist();
    note.set(`Saved as "${name}".`);
  };

  const deleteCurrent = (): void => {
    const s = current();
    if (!s) return;
    if (!custom().some((c) => c.id === s.id)) return;
    custom.set(custom().filter((c) => c.id !== s.id));
    selectedId.set(SPECS[0]?.id ?? "");
    draft.set(null);
    persist();
  };

  const revert = (): void => {
    draft.set(null);
    note.set("");
  };

  // --------------------------------------------------------------- run ---

  const run = async (): Promise<void> => {
    /* The COMPOSED spec when there is one — otherwise a combination that was
       chosen would be silently ignored, which is worse than refusing it. */
    const spec = effective();
    if (!spec) return;
    const c = combined();
    if (c !== null && !("spec" in c)) {
      note.set(`These two cannot be combined: ${c.why}`);
      return;
    }
    const bad = validateSpec(spec);
    if (bad.length > 0) {
      note.set("Fix the rule problems below before running.");
      return;
    }

    running.set(true);
    note.set("Loading history…");
    result.set(null);
    /* A ROUTER REPORT IS AN ANSWER ABOUT ONE RUN. Leaving the last one on
       screen while a new run is in flight would attach a model's verdict to a
       result it never saw — the same class as a cached sweep served without
       its age. */
    ledger.set(null);
    router.set(null);
    learnNote.set("");
    sampleNote.set("");
    try {
      const p = plan();
      if (!p.ok) {
        /*
         * THE SAME SENTENCE, A THIRD TIME.
         *
         * `planLine` returning `why` verbatim beside `plan().why` was fixed
         * once and the guard is still in place above — and pressing Run wrote
         * the identical string into `note`, which renders a few inches below.
         * The owner's screenshot shows both: "the archive holds no EURUSD 15m
         * to run on" under the inputs, and again under the button. Each of the
         * three bindings was right on its own; the SET was wrong, which is why
         * fixing two of them did not finish the job.
         *
         * The refusal is already on screen, so this says what pressing Run
         * ACHIEVED — nothing, and where to look — rather than repeating it.
         */
        note.set(
          p.missing
            ? "Nothing to run yet — use Download above to fetch this series first."
            : "Nothing to run: see the note under the window above.",
        );
        running.set(false);
        return;
      }
      /* `loadForPlan` loads, reaches back if the archive is short, AND READS IT
         BACK. That last step is the one this desk was missing: `backfill`
         returns a count and writes to the archive, so the run was using the
         bars loaded BEFORE it. Three identical runs gave 156, then 480, then
         480 trades. The argument and the measurement are in `runplan.ts`. */
      note.set(`Reaching back for ${p.wantBars.toLocaleString()} bars…`);
      const hist = await loadForPlan(opts.history, p);
      bars.set(hist.bars);
      loadedFrom.set(hist.source);

      const strategy = compileSpec(spec);
      if (hist.bars.length < strategy.warmup + 30) {
        note.set(
          `${hist.bars.length} bars loaded; this rule needs ${strategy.warmup} before its first decision. ` +
            "Nothing was run — a result on a series shorter than the warm-up is not a result.",
        );
        running.set(false);
        return;
      }

      /* `containsDemo` is passed straight through. The engine refuses to report
         a result computed over generated bars, and that refusal must reach the
         screen rather than being handled here. */
      /* WHAT THIS RUN IS CHARGED, decided before it starts and stated after.
         The last close is the price the spread is a fraction OF — a spread in
         POINTS means nothing until you know what it is a fraction of, which is
         the units trap this project has paid for more than once. */
      const close = hist.bars.length > 0 ? (hist.bars[hist.bars.length - 1]?.c ?? 0) : 0;
      lastClose.set(close);
      const charged: ResolvedCosts = resolveCosts(specFor(), close, useMeasuredCosts());
      costNote.set(charged.why);

      const r = runBacktest(strategy, hist.bars, {
        costs: charged.costs,
        containsDemo: hist.containsDemo,
      });
      const m = r.refused ? { ...EMPTY_METRICS } : computeMetrics(r.trades, r.equity);
      result.set({ metrics: m, refused: r.refused, trades: r.trades.length, friction: r.friction, settle: r.settle });

      /* THE SAME PASS, PARTITIONED. Not a second run: every trade is priced
         exactly as the full run priced it, and each belongs to the window it
         was opened in. A thin side refuses rather than printing two
         percentages for the eye to compare. */
      const times = hist.bars.map((b) => b.t);
      lastRun.set(r.refused ? null : { trades: r.trades, equity: r.equity, times });
      /* WHAT IT WAS MEASURED ON, captured here where the loaded history is in
         hand. Anywhere later and it would be the plan's numbers again. */
      ranOn.set(
        r.refused
          ? null
          : {
              bars: hist.bars.length,
              first: times[0] ?? 0,
              last: times[times.length - 1] ?? 0,
              source: hist.source,
              shortfall: hist.why,
              costs: charged.costs,
              spreadMeasured: charged.measured,
              askedBars: p.wantBars,
            },
      );
      exportNote.set("");
      holdout.set(r.refused ? null : splitRun(r.trades, r.equity, times, holdoutShare()));
      /* THE RESULT STATES ITS OWN WINDOW. "73 trades" and "4,100 trades" are
         the same sentence about different questions, and a figure that does
         not say what it was measured over is one nobody can argue with. */
      /* THE RESULT STATES THE BARS IT ACTUALLY RAN ON, not the bars the plan
         asked for. `planLine` reports the REQUEST, and printing that beside a
         trade count computed on fewer bars is the same sentence about a
         different question — the half of the defect above that would have
         survived the fix. */
      note.set(
        r.refused
          ? ""
          : `${p.symbol} ${p.timeframe} · ${hist.bars.length.toLocaleString()} bars from ${hist.source} · ` +
            charged.label +
            (hist.why ? ` — ${hist.why}` : ""),
      );

      /* LEARN FROM THE OUTPUT — but from the SETUPS, not the trades.
         `collectSignals` asks the strategy at every bar, open position or not,
         so the sample the model sees is not the one the backtest's own
         position-management rules selected. The argument is in `ledger.ts`. */
      if (!r.refused) void learn(strategy, hist.bars);
    } catch (err) {
      note.set(`Could not run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running.set(false);
    }
  };

  /**
   * Build the candidate ledger for this run and ask the router what it makes of it.
   *
   * SEPARATE FROM `run` ON PURPOSE. The backtest result is already on screen by
   * the time this starts, and it stays there whatever happens here: a router
   * that cannot be fitted — no service, too few rows, no skill — changes
   * nothing about what the strategy did, and must not be able to take the
   * result down with it.
   */
  const learn = async (strategy: ReturnType<typeof compileSpec>, series: readonly BarView[]): Promise<void> => {
    learning.set(true);
    learnNote.set("Collecting every setup…");
    try {
      const got = collectSignals(strategy, series);
      const led = buildLedger(series, got.signals, {
        horizon: LEDGER_HORIZON,
        costs: DEFAULT_COSTS,
      });
      ledger.set(led);

      /* NAME WHAT THE SAMPLE LOST. The ledger should hold MORE rows than the
         trade log, and on a short window it holds fewer — because the feature
         matrix needs 220 bars of history before it can describe a setup, where
         this rule needs far less. Nothing is wrong and nobody could tell that
         from two numbers side by side. */
      const lost: string[] = [];
      const seen = series.length - got.asked;
      if (seen > 0 && got.asked < series.length * 0.9) {
        lost.push(
          `the first ${seen.toLocaleString()} of ${series.length.toLocaleString()} bars are warm-up — ` +
            "a setup cannot be described until its indicators have converged, so the model sees a shorter " +
            "window than the backtest and may find fewer setups than it took trades",
        );
      }
      if (got.unfeatured > 0) {
        lost.push(`${got.unfeatured.toLocaleString()} setups could not be described and were dropped rather than filled with zeroes`);
      }
      if (led.skipped > 0) {
        lost.push(`${led.skipped.toLocaleString()} could not be resolved: ${led.why}`);
      }
      for (const o of got.matrix.omitted) lost.push(o);
      sampleNote.set(lost.join(". "));

      const decided = baseRate(led).decided;
      if (decided === 0) {
        learnNote.set("No setup reached its stop or its target inside the horizon, so there is nothing to learn from.");
        return;
      }

      learnNote.set(`Fitting on ${decided.toLocaleString()} decided setups…`);
      const rows = led.candidates.map((c) => ({
        t: c.time,
        outcome: c.outcome,
        features: c.features,
      }));
      const res = await trainRouter(rows);
      router.set(res);
      learnNote.set("");
    } catch (err) {
      learnNote.set(`Could not learn from this run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      learning.set(false);
    }
  };

  // ------------------------------------------------------------ editor ---

  const list = (cls: string, rows: () => HTMLElement[]) =>
    h("div", {
      class: cls,
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const r of rows()) el.appendChild(r);
        }),
    });

  type GroupKey = "long" | "short" | "exitLong" | "exitShort";

  const setGroup = (key: GroupKey, next: ConditionGroup): void => {
    edit((s) => ({ ...s, [key]: next }));
  };

  const conditionRow = (key: GroupKey, group: ConditionGroup, index: number, cond: Condition): HTMLElement =>
    h(
      "div",
      { class: "pb-cond" },
      h(
        "select",
        {
          class: "pb-sel",
          value: cond[0],
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value as ColumnId;
            setGroup(key, group.map((c, i) => (i === index ? ([v, c[1], c[2]] as Condition) : c)));
          },
        },
        ...(Object.keys(COLUMNS) as ColumnId[]).map((id) =>
          h("option", { value: id, text: COLUMNS[id], selected: id === cond[0] }),
        ),
      ),
      h(
        "select",
        {
          class: "pb-sel pb-sel-op",
          value: cond[1],
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value as OperatorId;
            setGroup(key, group.map((c, i) => (i === index ? ([c[0], v, c[2]] as Condition) : c)));
          },
        },
        ...(Object.keys(OPERATORS) as OperatorId[]).map((id) =>
          h("option", { value: id, text: OPERATORS[id], selected: id === cond[1] }),
        ),
      ),
      h("input", {
        class: "pb-operand",
        type: "text",
        value: cond[2],
        title: "Another indicator, or a number",
        oninput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          setGroup(key, group.map((c, i) => (i === index ? ([c[0], c[1], v] as Condition) : c)));
        },
      }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "✕",
        title: "Remove this condition",
        onclick: () => setGroup(key, group.filter((_, i) => i !== index)),
      }),
    );

  const groupEditor = (key: GroupKey, label: string, hint: string) =>
    h(
      "div",
      { class: "pb-group" },
      h("div", { class: "pb-group-head" },
        h("span", { class: "pb-group-label", text: label }),
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          text: "+ condition",
          onclick: () => {
            const s = current();
            if (!s) return;
            const g = (s[key] ?? []) as ConditionGroup;
            setGroup(key, [...g, ["close", ">", "ema50"] as Condition]);
          },
        }),
      ),
      h("div", { class: "pb-group-hint", text: hint }),
      list("pb-conds", () => {
        const s = current();
        if (!s) return [];
        const g = (s[key] ?? []) as ConditionGroup;
        if (g.length === 0) {
          return [h("div", { class: "pb-empty", text: "No conditions. This side will never trade." })];
        }
        return g.flatMap((c, i) => {
          const row = conditionRow(key, g, i, c);
          return i === 0 ? [row] : [h("div", { class: "pb-and", text: "AND" }), row];
        });
      }),
    );

  const stopEditor = h(
    "div",
    { class: "pb-exit-row" },
    h("span", { class: "pb-group-label", text: "Stop" }),
    h(
      "select",
      {
        class: "pb-sel",
        onchange: (e: Event) => {
          const t = (e.target as HTMLSelectElement).value;
          edit((s) => ({
            ...s,
            stop: (t === "atr" ? { type: "atr", mult: 2 } : { type: "pct", value: 1.5 }) as StopSpec,
          }));
        },
      },
      h("option", { value: "atr", text: "ATR multiple", selected: () => current()?.stop.type === "atr" }),
      h("option", { value: "pct", text: "Percent of price", selected: () => current()?.stop.type === "pct" }),
    ),
    h("input", {
      class: "pb-operand num",
      type: "number",
      step: "0.1",
      value: () => {
        const st = current()?.stop;
        return String(st ? (st.type === "atr" ? st.mult : st.value) : 2);
      },
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value) || 0;
        edit((s) => ({
          ...s,
          stop: (s.stop.type === "atr" ? { type: "atr", mult: v } : { type: "pct", value: v }) as StopSpec,
        }));
      },
    }),
  );

  const targetEditor = h(
    "div",
    { class: "pb-exit-row" },
    h("span", { class: "pb-group-label", text: "Target" }),
    h(
      "select",
      {
        class: "pb-sel",
        onchange: (e: Event) => {
          const t = (e.target as HTMLSelectElement).value;
          edit((s) => ({
            ...s,
            target: (t === "rr"
              ? { type: "rr", value: 2 }
              : t === "pct"
                ? { type: "pct", value: 1 }
                : { type: "none" }) as TargetSpec,
          }));
        },
      },
      h("option", { value: "rr", text: "R multiple", selected: () => current()?.target.type === "rr" }),
      h("option", { value: "pct", text: "Percent of price", selected: () => current()?.target.type === "pct" }),
      h("option", { value: "none", text: "Exit rule only", selected: () => current()?.target.type === "none" }),
    ),
    h("input", {
      class: "pb-operand num",
      type: "number",
      step: "0.1",
      disabled: () => current()?.target.type === "none",
      value: () => {
        const t = current()?.target;
        return String(t && t.type !== "none" ? t.value : 0);
      },
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value) || 0;
        edit((s) => ({
          ...s,
          target: (s.target.type === "pct" ? { type: "pct", value: v } : { type: "rr", value: v }) as TargetSpec,
        }));
      },
    }),
  );

  // ------------------------------------------------------------ render ---

  const picker = h(
    "select",
    {
      class: "field-input",
      value: () => selectedId(),
      onchange: (e: Event) => {
        selectedId.set((e.target as HTMLSelectElement).value);
        draft.set(null);
        result.set(null);
        note.set("");
        persist();
      },
    },
    ...Object.keys(STYLE_LABEL).map((style) =>
      h(
        "optgroup",
        { label: STYLE_LABEL[style] ?? style },
        () => {
          const rows = all().filter((s) => s.style === style);
          const frag = document.createDocumentFragment();
          for (const s of rows) frag.appendChild(h("option", { value: s.id, text: s.name }));
          return frag as unknown as HTMLElement;
        },
      ),
    ),
  );

  /* One labelled control. The label is a real `<label>` bound to its input —
     a desk full of bare boxes is one a keyboard cannot navigate. */
  let fieldSeq = 0;
  const field = (label: string, input: HTMLElement, hint: string): HTMLElement => {
    const id = `pb-f-${(fieldSeq += 1)}`;
    /* THE ID GOES ON THE CONTROL, NOT ON ITS WRAPPER. `symbolField` returns a
       span holding the input and its `<datalist>`, and a `<label for>` pointing
       at a span is a label that does nothing — it does not warn, it does not
       fail a type check, and the only symptom is that clicking the caption
       stops focusing the box. */
    const control = input.querySelector("input") ?? input;
    control.setAttribute("id", id);
    return h(
      "div",
      { class: "pb-field" },
      h("label", { class: "field-label", for: id, text: label }),
      input,
      hint ? h("span", { class: "field-hint", text: hint }) : h("span", {}),
    ) as HTMLElement;
  };

  const numInput = (get: () => number, set: (n: number) => void, step = "1"): HTMLInputElement => {
    const el = h("input", {
      class: "field-input num",
      type: "number",
      step,
      value: String(get()),
      onchange: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) {
          set(n);
          persist();
          readHolding();
        }
      },
    }) as HTMLInputElement;
    /* ASK AT MOUNT. Three change handlers called this and nothing else did, so
     the desk's opening state was always a refusal. */
  readHolding();

  /* THE BROKER'S OWN SPREADS, asked for once. A refusal here is not an error:
     an account that has never synced has no specs, and the cost control then
     says so rather than offering a switch that cannot do anything. */
  void brokerCosts().then((got) => {
    /* DISCRIMINATED ON `kind`, which is what the client actually returns. `ok`
       is the shape most of this codebase uses and this one is the exception —
       tsc caught it, which is the argument for importing a real type rather
       than assuming a familiar one. */
    if (got.kind === "ok") specs.set(got.value.specs);
  });
  /* AND AGAIN WHEN THE DESK COMES BACK. A desk is hidden, not unmounted, so a
     download made while you were elsewhere would otherwise stay invisible here
     until you retyped the symbol. */
  onShown(el, () => readHolding());

  return el;
  };

  /* SUGGESTED, NOT ENFORCED. A `<select>` would be the obvious fix and the
     wrong one: this desk accepts a market it does not hold and reaches back
     for the history, which was a defect fixed on purpose. A dropdown would
     put it back permanently, as a control. */
  const symbolInput = symbolField({
    value: () => symbol(),
    options: () => symbolOptions(heldAll()),
    ariaLabel: "Market to test",
    onChange: (v) => {
      if (v === "") return;
      symbol.set(v);
      persist();
      readHolding();
    },
  });

  const tfSelect = h(
    "select",
    {
      class: "field-input",
      onchange: (e: Event) => {
        timeframe.set((e.target as HTMLSelectElement).value);
        persist();
        readHolding();
      },
    },
    ...TFS.map((t) => h("option", { value: t, text: t, selected: t === timeframe() ? "" : undefined })),
  ) as HTMLSelectElement;

  const fromInput = numInput(fromYear, (n) => fromYear.set(Math.round(n)));
  const toInput = numInput(toYear, (n) => toYear.set(Math.round(n)));
  const balanceInput = numInput(balance, (n) => balance.set(n), "50");
  const riskInput = numInput(riskPct, (n) => riskPct.set(n), "0.25");

  const combinePicker = h(
    "select",
    {
      class: "field-input",
      id: "pb-combine",
      value: () => combineId(),
      onchange: (e: Event) => {
        combineId.set((e.target as HTMLSelectElement).value);
        result.set(null);
        note.set("");
        persist();
      },
    },
    h("option", { value: "", text: "Nothing — test this rule alone" }),
    /* A fragment, matching the strategy picker above: `h` takes one node from a
       reactive child, not an array. */
    () => {
      const frag = document.createDocumentFragment();
      for (const x of all()) {
        if (x.id === current()?.id) continue;
        frag.appendChild(h("option", { value: x.id, text: x.name }));
      }
      return frag as unknown as HTMLElement;
    },
  ) as HTMLSelectElement;

  /** The reliability curve's non-empty buckets, or none. */
  const calBuckets = computed(() => {
    const r = router();
    if (r === null || r.kind !== "ok") return [];
    /* `liveBuckets` drops the empty ones, and it does so in the card's module
       so both desks drop them the same way. A bucket with no setups has no
       observed rate, and a zero-length bar reads as "it was never right in
       this range" - the opposite of "it never said this". */
    return liveBuckets(r.report.calibration);
  });

  const metricRow = (k: string, v: () => string, title?: string) =>
    h(
      "div",
      { class: "pb-metric", ...(title ? { title } : {}) },
      h("span", { class: "pb-metric-k", text: k }),
      h("span", { class: "pb-metric-v num", text: v }),
    );

  const el = h(
    "div",
    { class: "dd pb-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Playbook" }),
      h("p", {
        class: "view-sub",
        text: "Seventeen rule sets you can read, change and test. Every rule below is printed from the same data the engine runs, so the description cannot drift from the behaviour.",
      }),
    ),

    h(
      "div",
      { class: "pb-grid" },
      h(
        "div",
        { class: "pb-col-left" },
        /* THE CONTROLS. What to test, over what, with how much — none of
           which this desk could say before: it tested whatever the chart was
           showing, over a constant 1,500 bars, with no account behind it. */
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "What to test, and over what" }),
          h(
            "div",
            { class: "pb-controls" },
            field("Market", symbolInput, "What you hold is listed first; anything else is fetched."),
            field("Bar size", tfSelect, "Smaller bars mean more trades and more friction."),
            field("From", fromInput, ""),
            field("To", toInput, ""),
            field("Balance", balanceInput, "What the simulation starts with."),
            field("Risk %", riskInput, "Of balance, per trade."),
          ),
          h("p", {
            class: "pb-plan",
            text: () => holdingNote() || planLine(plan()),
            /* Neither ok nor refused while the answer is still coming. */
            "data-ok": () => (holdingNote() ? "asking" : String(plan().ok)),
          }),
          /* ONLY WHEN THE PLAN RUNS. `planLine` returns `why` verbatim for a
             refused plan, so showing both printed the same sentence twice —
             "the archive holds no XAUUSD 15m to run on", then again. Each
             binding was right on its own. A refusal is one line; a run that
             will be clipped is a line plus its caveat. */
          h("p", {
            class: "pb-plan-why",
            text: () => (plan().ok ? plan().why : ""),
            style: () => (plan().ok && plan().why ? "" : "display:none"),
          }),

          /*
           * A REFUSAL THAT CAN BE FIXED SHOULD CARRY THE FIX.
           *
           * Shown only when `plan().missing` is set — a typed field, never a
           * match on the sentence. Two of the three refusals that reach this
           * line cannot be fixed by fetching and differ from this one in
           * English alone; a button decided by `why.includes("holds no")`
           * would offer a download that spins and finds nothing.
           */
          h(
            "div",
            { class: "pb-fetch", style: () => (plan().missing ? "" : "display:none") },
            h("button", {
              class: "primary-btn",
              type: "button",
              disabled: () => fetching(),
              text: () => {
                const m = plan().missing;
                if (fetching()) return "Fetching…";
                if (m === null) return "Download";
                return `Download ${m.symbol} ${m.timeframe}`;
              },
              onclick: fetchMissing,
            }),
            /* STOPPING IS PART OF STARTING. A long backfill with no way out is
               a control the operator has to reload the page to escape. */
            h("button", {
              class: "ghost-btn",
              type: "button",
              style: () => (fetching() ? "" : "display:none"),
              text: "Stop",
              onclick: () => fetchAbort()?.abort(),
            }),
            h("p", {
              class: "pb-fetch-size",
              text: () => {
                const m = plan().missing;
                if (m === null || fetching()) return "";
                /* SAY WHAT IT WILL COST BEFORE IT IS PRESSED. The depth is the
                   one the RUN needs, so the fetch cannot finish and leave the
                   plan still short. */
                return `About ${m.wantBars.toLocaleString()} bars — the depth this window needs. Kept on this machine.`;
              },
            }),
            h("p", { class: "pb-fetch-note", text: fetchLine }),
          ),
        ),

        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Strategy" }),
          h("div", { class: "field" }, picker),
          h("p", { class: "pb-note", text: () => current()?.note ?? "" }),

          /* COMBINE. Built since v60 in `hybrid.ts` and reachable only from the
             Strategy desk until now. */
          h(
            "div",
            { class: "field pb-combine" },
            h("label", { class: "field-label", for: "pb-combine", text: "Only while this also holds" }),
            combinePicker,
            h("p", {
              class: "pb-combine-why",
              text: () => {
                const c = combined();
                if (c === null) return "";
                if ("spec" in c) {
                  const n = c.added.length;
                  return `Adds ${n} condition${n === 1 ? "" : "s"} to the entry. The trades are the first rule's, minus what the second excludes.`;
                }
                return `Cannot be combined: ${c.why}`;
              },
              "data-refused": () => String(combined() !== null && !("spec" in (combined() as object))),
              style: () => (combined() === null ? "display:none" : ""),
            }),
          ),
          h(
            "div",
            { class: "pb-actions" },
            h("button", {
              class: "primary-btn",
              type: "button",
              disabled: () => running(),
              text: () => (running() ? "Running…" : "Run backtest"),
              onclick: () => void run(),
            }),
            h("button", {
              class: "ghost-btn",
              type: "button",
              text: "Save as new",
              "data-hidden": () => String(draft() === null),
              onclick: saveDraft,
            }),
            h("button", {
              class: "ghost-btn",
              type: "button",
              text: "Revert",
              "data-hidden": () => String(draft() === null),
              onclick: revert,
            }),
            h("button", {
              class: "ghost-btn",
              type: "button",
              text: "Delete",
              "data-hidden": () => String(!custom().some((c) => c.id === current()?.id)),
              onclick: deleteCurrent,
            }),
          ),
          h("p", { class: "pb-status", text: () => note() }),
        ),

        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Exactly how it trades" }),
          h("p", { class: "pf-hint", text: "Generated from the rules themselves, not written beside them." }),
          /*
           * READS `effective()`, NOT `current()`.
           *
           * The desk's own subtitle promises "the description cannot drift
           * from the behaviour", and adding the combine control broke that in
           * the first draft: with a filter chosen it described rule A while
           * the engine tested A+B. The EDITOR below still edits `current()` —
           * you change the base rule, not the composition — but what is
           * printed here has to be what runs.
           */
          h("div", { class: "pb-english" },
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Enter long" }),
              h("span", { class: "pb-en-v", text: () => groupText(effective()?.long) }),
            ),
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Enter short" }),
              h("span", { class: "pb-en-v", text: () => groupText(effective()?.short) }),
            ),
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Exit long" }),
              h("span", { class: "pb-en-v", text: () => groupText(effective()?.exitLong) }),
            ),
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Exit short" }),
              h("span", { class: "pb-en-v", text: () => groupText(effective()?.exitShort) }),
            ),
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Stop" }),
              h("span", { class: "pb-en-v", text: () => (effective() ? stopText(effective()!.stop) : "—") }),
            ),
            h("div", { class: "pb-en-row" },
              h("span", { class: "pb-en-k", text: "Target" }),
              h("span", { class: "pb-en-v", text: () => (effective() ? targetText(effective()!.target) : "—") }),
            ),
          ),
        ),

        h(
          "section",
          { class: "dd-panel pb-problems", "data-on": () => String(problems().length > 0) },
          h("h3", { class: "pf-sub", text: "Problems" }),
          list("pb-problem-list", () =>
            problems().map((p) =>
              h("div", { class: "pb-problem" },
                h("span", { class: "pb-problem-where", text: p.where }),
                h("span", { text: p.message }),
              ),
            ),
          ),
        ),
      ),

      h(
        "div",
        { class: "pb-col-right" },
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Result" }),
          h("p", {
            class: "pb-refused",
            "data-on": () => String(!!result()?.refused),
            text: () => result()?.refused ?? "",
          }),
          h(
            "div",
            { class: "pb-metrics", "data-on": () => String(!!result() && !result()?.refused) },
            metricRow("Trades", () => String(result()?.metrics.trades ?? 0)),
            metricRow("Win rate", () => pct(result()?.metrics.winRate ?? NaN)),
            metricRow(
              "Profit factor",
              () => fixed(result()?.metrics.profitFactor ?? NaN),
              "Gross wins over gross losses. Below 1 it loses money.",
            ),
            metricRow(
              "Expectancy",
              () => `${fixed(result()?.metrics.expectancyR ?? NaN)} R`,
              "Mean R per trade — the number that actually decides the outcome.",
            ),
            metricRow("Total return", () => pct(result()?.metrics.totalReturn ?? NaN)),
            metricRow("Max drawdown", () => pct(result()?.metrics.maxDrawdown ?? NaN)),
            metricRow(
              "Longest losing streak",
              () => String(result()?.metrics.maxConsecutiveLosses ?? 0),
              "What decides whether the strategy is sittable, and the figure every strategy pitch omits.",
            ),
            metricRow("Average bars held", () => fixed(result()?.metrics.avgBarsHeld ?? NaN, 0)),
          ),

          /*
           * DID IT STILL WORK RECENTLY?
           *
           * The panel below this one says a single window is "a description of
           * the past, not evidence of an edge". This is the cheapest thing that
           * can argue with that: the rule was not chosen for what it did in the
           * held-back slice, so agreement is worth something and disagreement is
           * worth more.
           *
           * The refusal is the common case on a short run and is shown as
           * prominently as a result would be — two percentages over a handful of
           * trades look exactly like a measurement.
           */
          h(
            "div",
            { class: "pb-holdout", "data-on": () => String(holdout() !== null) },
            h("h4", { class: "pb-holdout-head", text: "Did it still work recently?" }),
            h(
              "div",
              { class: "pb-holdout-ctl" },
              h("label", { class: "field-label", for: "pb-holdout", text: "Hold back the last" }),
              (() => {
                const sel = h("select", { class: "field-input", id: "pb-holdout" },
                  ...[0.2, 0.3, 0.4, 0.5].map((v) =>
                    h("option", { value: String(v), text: `${Math.round(v * 100)}%` }),
                  ),
                ) as HTMLSelectElement;
                sel.value = String(holdoutShare());
                sel.onchange = () => {
                  const n = Number(sel.value);
                  if (Number.isFinite(n)) holdoutShare.set(n);
                  /* RE-SPLIT WITHOUT RE-RUNNING. The trades are already priced;
                     changing where the line falls is arithmetic, not a backtest,
                     and re-running would charge the operator minutes for it. */
                  const r = lastRun();
                  if (r !== null) {
                    holdout.set(splitRun(r.trades, r.equity, r.times, holdoutShare()));
                  }
                };
                return sel;
              })(),
            ),
            h("p", {
              class: "pb-holdout-why",
              "data-agrees": () => {
                const s = holdout();
                if (s === null || !s.enough) return "unknown";
                return s.agrees === null ? "unknown" : String(s.agrees);
              },
              text: () => holdout()?.why ?? "",
            }),
            h(
              "div",
              { class: "pb-holdout-cols", style: () => (holdout()?.enough ? "" : "display:none") },
              h(
                "div",
                { class: "pb-holdout-col" },
                h("span", { class: "pb-holdout-col-head", text: "Earlier" }),
                h("span", {
                  class: "pb-holdout-fig",
                  text: () => `${fixed(holdout()?.earlier.expectancyR ?? NaN)} R`,
                }),
                h("span", {
                  class: "pb-holdout-sub",
                  text: () => `${holdout()?.earlierTrades ?? 0} trades · ${pct(holdout()?.earlier.winRate ?? NaN)} won`,
                }),
              ),
              h(
                "div",
                { class: "pb-holdout-col" },
                h("span", {
                  class: "pb-holdout-col-head",
                  text: () => `Held back (last ${Math.round((holdout()?.share ?? 0) * 100)}%)`,
                }),
                h("span", {
                  class: "pb-holdout-fig",
                  text: () => `${fixed(holdout()?.recent.expectancyR ?? NaN)} R`,
                }),
                h("span", {
                  class: "pb-holdout-sub",
                  text: () => `${holdout()?.recentTrades ?? 0} trades · ${pct(holdout()?.recent.winRate ?? NaN)} won`,
                }),
              ),
            ),
          ),

          /*
           * KEEP THE RESULT, WITH THE DATA BEHIND IT.
           *
           * A number written down without the data behind it cannot be checked
           * six months later. The receipt carries the bars that ARRIVED, the
           * vendor, the span, the cost model and whether its spread was measured
           * or assumed — everything needed to re-derive the figure, and to know
           * when a later run is answering a different question.
           */
          h(
            "div",
            { class: "pb-receipt", "data-on": () => String(ranOn() !== null) },
            h(
              "div",
              { class: "pb-receipt-ctl" },
              h("button", {
                class: "tool-btn",
                type: "button",
                text: "Save this result",
                onclick: saveReceipt,
              }),
              h("button", {
                class: "tool-btn",
                type: "button",
                text: "Copy",
                onclick: copyReceipt,
              }),
              h("span", {
                class: "pb-receipt-what",
                text: () => {
                  const ran = ranOn();
                  if (ran === null) return "";
                  return `${ran.bars.toLocaleString()} bars from ${ran.source}, ${
                    ran.spreadMeasured ? "measured" : "assumed"
                  } spread`;
                },
              }),
            ),
            h("p", { class: "pb-receipt-note", text: () => exportNote() }),
          ),

          /*
           * AGAINST ANOTHER RULE, ON THE SAME BARS.
           *
           * The verdict is the DIFFERENCE and its standard error, never two
           * figures side by side for the eye to rank. A gap the data cannot
           * support is called a tie, because choosing the higher of two
           * expectancies over forty trades each is choosing noise.
           */
          h(
            "div",
            { class: "pb-h2h", "data-on": () => String(lastRun() !== null) },
            h("h4", { class: "pb-h2h-head", text: "Against another rule" }),
            h("p", {
              class: "pb-h2h-lede",
              text: "Same bars, same costs, same window — only the rule changes. A gap smaller than the noise is reported as a tie, not a winner.",
            }),
            h(
              "div",
              { class: "pb-h2h-ctl" },
              (() => {
                const sel = h("select", { class: "field-input" }) as HTMLSelectElement;
                const fill = (): void => {
                  const mine = effective()?.id;
                  const opts = all().filter((r) => r.id !== mine);
                  sel.replaceChildren(
                    ...opts.map((r) => h("option", { value: r.id, text: r.name })),
                  );
                  if (rivalId() === "" && opts.length > 0) rivalId.set(opts[0]?.id ?? "");
                  sel.value = rivalId();
                };
                fill();
                /* REBUILT WHEN THE RULE LIST OR THE SELECTION CHANGES, so the
                   rival list never offers the rule already being tested. */
                /* `renderEffect`, not `effect`: this touches the DOM, and it is
                   the one that falls back to a timer when rAF never fires in an
                   uncomposited tab — the rule `core/frame.ts` exists for. */
                renderEffect(() => {
                  void all();
                  void effective();
                  fill();
                });
                sel.onchange = () => {
                  rivalId.set(sel.value);
                  h2h.set(null);
                };
                return sel;
              })(),
              h("button", {
                class: "tool-btn",
                type: "button",
                disabled: () => h2hBusy() || lastRun() === null,
                text: () => (h2hBusy() ? "Comparing…" : "Compare"),
                onclick: () => void runHeadToHead(),
              }),
            ),
            h("p", {
              class: "pb-h2h-why",
              "data-verdict": () => h2h()?.verdict ?? "none",
              text: () => h2h()?.why ?? "Run a backtest first, then compare another rule against it on the same bars.",
            }),
            h(
              "div",
              { class: "pb-h2h-cols", style: () => (h2h() ? "" : "display:none") },
              ...(["a", "b"] as const).map((k) =>
                h(
                  "div",
                  { class: "pb-h2h-col" },
                  h("span", { class: "pb-h2h-name", text: () => h2h()?.[k].label ?? "" }),
                  h("span", {
                    class: "pb-h2h-fig",
                    text: () => `${fixed(h2h()?.[k].expectancyR ?? NaN)} R`,
                  }),
                  h("span", {
                    class: "pb-h2h-sub",
                    text: () =>
                      `${h2h()?.[k].trades ?? 0} trades · ${pct(h2h()?.[k].winRate ?? NaN)} won`,
                  }),
                ),
              ),
            ),
          ),

          /*
           * DOES IT WORK ANYWHERE ELSE?
           *
           * Chips, not a second form: a control that takes one market per press
           * makes you run the desk five times to answer one question. The list
           * is what the archive HOLDS at this bar size, so nothing here offers a
           * market that would only refuse.
           *
           * The summary counts and names. It does not rank — sorting by
           * expectancy would turn honest measurements into a search, and the
           * winner of a search is a different claim from a rule that works.
           */
          h(
            "div",
            { class: "pb-across" },
            h("h4", { class: "pb-across-head", text: "Does it work anywhere else?" }),
            h("p", {
              class: "pb-across-lede",
              text: "The same rule, same window, same costs, on other markets you hold. Nothing here is ranked — a best-of-six is a search result, not an edge.",
            }),
            h(
              "div",
              { class: "pb-across-chips" },
              () => {
                /* `heldAll` carries `SymbolOption`, not strings — tsc refused
                   the assumption, which is the rule about never guessing a
                   dependency's shape doing its job. Only the ones the archive
                   actually HOLDS are offered: a chip that could only refuse is
                   a control that wastes a press. */
                const others = heldAll()
                  .filter((o) => o.held && o.symbol !== symbol())
                  .map((o) => o.symbol);
                if (others.length === 0) {
                  return h("p", {
                    class: "pb-across-why",
                    text: "The archive holds no other market at this bar size yet. Download one above and it will appear here.",
                  }) as HTMLElement;
                }
                return h(
                  "div",
                  { class: "pb-across-chiprow" },
                  ...others.slice(0, 12).map((m) =>
                    h("button", {
                      class: "tool-btn pb-chip",
                      type: "button",
                      "data-on": () => String(acrossPicked().includes(m)),
                      text: m,
                      onclick: () => {
                        const now = acrossPicked();
                        acrossPicked.set(
                          now.includes(m) ? now.filter((x) => x !== m) : [...now, m],
                        );
                      },
                    }),
                  ),
                ) as HTMLElement;
              },
            ),
            h(
              "div",
              { class: "pb-across-ctl" },
              h("button", {
                class: "primary-btn",
                type: "button",
                disabled: () => acrossBusy() !== "" || acrossPicked().length === 0,
                text: () =>
                  acrossBusy() !== ""
                    ? `Testing ${acrossBusy()}…`
                    : acrossPicked().length === 0
                      ? "Pick a market"
                      : `Test on ${acrossPicked().length} market${acrossPicked().length === 1 ? "" : "s"}`,
                onclick: () => void runAcross(),
              }),
            ),
            h("p", {
              class: "pb-across-why",
              "data-verdict": () => acrossSummary()?.verdict ?? "none",
              text: () => acrossSummary()?.why ?? "",
            }),
            h(
              "div",
              { class: "pb-across-rows" },
              () =>
                h(
                  "div",
                  {},
                  ...acrossRuns().map((r) =>
                    h(
                      "div",
                      { class: "pb-across-row", "data-refused": String(r.refused) },
                      h("span", { class: "pb-across-sym", text: r.symbol }),
                      h("span", {
                        class: "pb-across-fig",
                        text: r.refused ? "—" : `${fixed(r.expectancyR)} R`,
                      }),
                      h("span", {
                        class: "pb-across-sub",
                        /* A MARKET THAT COULD NOT ANSWER SAYS WHY. Dropping it
                           silently would make the denominator a lie. */
                        text: r.refused
                          ? r.why || "could not be tested"
                          : `${r.trades} trades · ${pct(r.winRate)} won`,
                      }),
                    ),
                  ),
                ) as HTMLElement,
            ),
          ),

          /*
           * WHAT THE RUN WAS CHARGED.
           *
           * A COST MODEL IS A HURDLE, so an assumed cost is an assumed
           * conclusion. The measured spread is offered and never adopted by
           * itself: a figure that moved under the operator because a service
           * answered is worse than a disagreement they can see.
           */
          h(
            "div",
            { class: "pb-costs", "data-on": () => String(costNote() !== "") },
            h(
              "label",
              { class: "pb-costs-toggle" },
              (() => {
                const box = h("input", { type: "checkbox", class: "pb-costs-box" }) as HTMLInputElement;
                box.checked = useMeasuredCosts();
                box.onchange = () => {
                  useMeasuredCosts.set(box.checked);
                  /*
                   * A CHANGED HURDLE IS A CHANGED QUESTION, so the old answer is
                   * not left sitting under a new cost model.
                   *
                   * THE PRICE IS PART OF THE ANSWER. A spread in POINTS is only
                   * a fraction once you know what it is a fraction of, and the
                   * first version of this handler passed ZERO — so
                   * `spreadFraction` divided by nothing and the card announced
                   * "the broker's spec does not give a usable spread" about a
                   * spec that is perfectly good. Found by toggling it on XAUUSD,
                   * which the broker quotes. With no run yet there is no price,
                   * and the honest answer is to say what will happen rather than
                   * to invent one.
                   */
                  const px = lastClose();
                  costNote.set(
                    px > 0
                      ? resolveCosts(specFor(), px, box.checked).why
                      : box.checked
                        ? "Press Run — the spread will be measured against the price this series is actually trading at."
                        : "Press Run to measure this rule against the assumed spread again.",
                  );
                };
                return box;
              })(),
              h("span", { text: "Charge my broker's measured spread" }),
            ),
            h("p", { class: "pb-costs-why", text: () => costNote() }),
          ),
          h("p", {
            class: "pb-verdict",
            "data-on": () => String(!!result() && !result()?.refused),
            text: () => {
              const m = result()?.metrics;
              if (!m) return "";
              const v = verdict(m);
              return `${v.rating.toUpperCase()} — ${v.why}`;
            },
          }),
          pkWhy(
            "One rule set on one symbol over one window, with costs applied. That is a description of the past, not evidence of an edge — the Strategy desk exists to put a number on how likely this result is to be luck.",
            "What this can't tell you",
          ),
        ),

        /* WHAT A MODEL MAKES OF IT. Four states, each of which says which it
           is: nothing run yet, still fitting, an answer, or a service that
           could not be reached. The third splits again into skill and no
           skill, and NO SKILL IS AN ANSWER — a panel that renders it as an
           error teaches the operator to ignore the one thing here that is
           reliably true. */
        h(
          "section",
          { class: "dd-panel pb-learn", "data-on": () => String(ledger() !== null || learning()) },
          h("h3", { class: "pf-sub", text: "What a model makes of it" }),

          h("p", {
            class: "pb-learn-status",
            text: () => learnNote(),
            style: () => (learnNote() ? "" : "display:none"),
          }),

          /* THE SAMPLE, ALWAYS — it exists whether or not any service answers,
             and it is the half of this panel the browser computed itself. */
          h(
            "div",
            { class: "pb-metrics", "data-on": () => String(ledger() !== null) },
            metricRow(
              "Setups found",
              () => (ledger()?.candidates.length ?? 0).toLocaleString(),
              "Every bar the entry condition was true - including the ones the backtest could not take because it was already in a position. That is the sample a model can honestly be scored on.",
            ),
            metricRow(
              "Resolved",
              () => {
                const l = ledger();
                return l === null ? "-" : baseRate(l).decided.toLocaleString();
              },
              `Reached the stop or the target within ${LEDGER_HORIZON} bars. The rest timed out, which is neither a win nor a loss.`,
            ),
            metricRow(
              "Base rate",
              () => {
                const l = ledger();
                return l === null ? "-" : pct(baseRate(l).rate);
              },
              "The share that hit the target. A model has to beat this to have learned anything at all - predicting the common class scores exactly this.",
            ),
            metricRow(
              "Order measured",
              () => pct(ledger()?.measuredShare ?? NaN),
              "The share of labels where the bar did not hold both the stop and the target, so which came first is known rather than assumed. Minute bars would settle the rest.",
            ),
          ),

          /* WHAT THE SAMPLE LOST, named where the total is reported. It wore
             `.pb-cal-note` until the curve moved to a shared card and took its
             classes with it — a class borrowed from a neighbouring block is a
             class that vanishes when the neighbour does. */
          h("p", {
            class: "pb-learn-sub",
            text: () => sampleNote(),
            style: () => (sampleNote() ? "" : "display:none"),
          }),

          /* THE MODEL'S ANSWER. */
          h("div", {
            class: "pb-learn-verdict",
            "data-skill": () => {
              const r = router();
              if (r === null || r.kind !== "ok") return "none";
              return r.report.skill ? "yes" : "no";
            },
            style: () => (router() === null ? "display:none" : ""),
            text: () => {
              const r = router();
              if (r === null) return "";
              /* A refusal and an unreachable service both carry their own
                 sentence; only a fitted report needs one written for it. */
              if (r.kind === "offline" || r.kind === "refused") return r.why;
              return skillSentence(r.report);
            },
          }),

          /* THE RELIABILITY CURVE, drawn by the card both desks use. It is
             the only thing that makes a threshold choosable: "in the bucket
             where it said 60% it actually won 59%, n=140" is a fact you can
             act on, and "route above 62%" is a number somebody made up. */
          calibrationCard({
            buckets: () => calBuckets(),
            note: () => {
              const r = router();
              if (r === null || r.kind !== "ok") return "";
              if (r.report.thresholdBasis !== "calibration") {
                return "No bucket cleared the base rate with enough setups in it to mean anything, so there is no threshold to suggest.";
              }
              return `Above ${pct(r.report.suggestedThreshold)} the observed rate clears the base rate - read off this curve, not assumed.`;
            },
          }),

          pkWhy(
            `The model is fitted forward only: each block is scored by a model trained on the blocks before it, never on its own future. The features are ratios and oscillators with no price level in them, so a rule tested on one market can be asked about another. What it cannot tell you is whether the RULE has an edge - it only says whether, given that the rule fired, anything here predicts which times it worked. A setup that resolves in neither direction within ${LEDGER_HORIZON} bars is a timeout and is excluded from training, because "nothing happened" is not "I was wrong".`,
            "How this was fitted, and what it can't say",
          ),
        ),

        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Edit the rules" }),
          pkWhy(
            "Change anything and the sentences on the left change with it. Editing a shipped strategy forks it — the original is never overwritten.",
            "How editing works",
          ),
          groupEditor("long", "Enter long when", "All conditions must hold on the same bar."),
          groupEditor("short", "Enter short when", "Leave empty to make it long-only."),
          groupEditor("exitLong", "Exit long when", "Checked on every close, alongside the stop and target."),
          groupEditor("exitShort", "Exit short when", ""),
          stopEditor,
          targetEditor,
        ),
      ),
    ),
  );

  return { el, current, run };
}
