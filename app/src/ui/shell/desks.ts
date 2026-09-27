/**
 * Eleven desks, plus the agent desk and the archive's retention sweep.
 *
 * Moved out of `mountShell` in v59. Every one is built on first open through
 * `lazyDesk` (see shell/context.ts), so constructing them here costs nothing
 * until the operator visits. Grouped because they share one property: none
 * reads anything shell-owned beyond the five inputs below. The Briefing and
 * Alerts desks read a dozen shell signals each and stay in `shell.ts`.
 *
 * The agent desk is built EAGERLY, as it was: the analyst session exists from
 * boot and `askAgent` focuses the desk from anywhere. It is returned, and the
 * shell assigns it to the binding its other readers already hold.
 */

import { supervisor } from "../../data/net";
import { sharedKnowledge } from "../../learn/knowledge";
import { seriesKey } from "../../store/barstore";
import { DEFAULT_POLICY, applyRetention, planRetention } from "../../store/retention";
import { createAgentDesk, renderProviderConfig } from "../agent";
import { attachContextMenu, rowSubject } from "../contextmenu";
import { createData } from "../data";
import { h } from "../dom";
import { createFlow } from "../flow";
import { createKnowledge } from "../knowledge";
import { openOverlay } from "../overlay";
import { createPaper } from "../paper";
import { createPlaybook } from "../playbook";
import { createSessions } from "../sessions";
import { createSimulation } from "../simulation";
import { createSmartMoney } from "../smartmoney";
import { createStrategy } from "../strategy";
import { createSystemDesk } from "../system";
import { createStudyDesk } from "../study/desk";
import { createSurvey } from "../survey";
import { createConnections } from "../connections";
import { fetchServerBars, serverInventory } from "../../data/serverbars";
import { activitySummary } from "../../data/activity";
import { createWatchlist } from "../watchlist";
import type { ReadSignal } from "../../core/signal";
import type { BarView } from "../../chart/series";
import type { GateRules } from "../../setup/rules";
import type { ShellContext } from "./context";
import type { createWorkspaceSection } from "./workspace";
import type { createAnalystModel } from "../model/analyst";
import type { ShelfStore } from "../../backtest/shelfstore";
import type { Signal } from "../../core/signal";
import type { SweepDriver } from "../model/sweepdriver";

export interface DesksDeps {
  /** The chart's bars, replay-aware — desks that read the window on screen. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /** Settings ▸ Trading rules; the knowledge desk prices stops with them. */
  readonly rules: ReadSignal<GateRules>;
  readonly knowledgeBase: ReturnType<typeof sharedKnowledge>;
  /** The analyst session the agent desk fronts. */
  readonly analyst: ReturnType<typeof createAnalystModel>;
  /** Every workspace pane's series, so a retention sweep never evicts one. */
  readonly workspaceSeries: ReturnType<typeof createWorkspaceSection>["workspaceSeries"];
  /**
   * The shelf of strategies the terminal found by itself.
   *
   * Passed in rather than created here because the recommendation card reads
   * the same list. One store, one signal — see `backtest/shelfstore.ts`.
   */
  readonly shelf: ShelfStore;
  /** The one search, shared with the recommendation card. */
  readonly sweep: SweepDriver;
  /** The history depth the desk's control sets and the search reads. */
  readonly sweepDepth: Signal<number>;
}

export function createDesks(ctx: ShellContext, deps: DesksDeps) {
  const { kv, state, feed, toaster, keymap, commands, lazyDesk } = ctx;
  const { bars, rules, knowledgeBase, analyst, workspaceSeries, shelf, sweep, sweepDepth } = deps;

  // Built once: the liquidation socket must survive tab switches, or every
  // visit to the desk starts from an empty tape.
  const flow = lazyDesk(() => createFlow({ symbol: state.symbol }));

  /**
   * The Data desk, and the pin that protects what is on screen.
   *
   * `pinned` is read at sweep time rather than captured, so the series the
   * chart is CURRENTLY showing can never be evicted underneath it. Without
   * this, a background sweep could delete the bars of the symbol you are
   * looking at, and the chart would silently re-fetch a shorter history.
   */
  const pinnedSeries = (): string[] => [
    ...["binance", "proxy", "mt5", "coinbase", "bybit", "okx"].map((source) =>
      seriesKey({ source, symbol: state.symbol.peek(), timeframe: state.timeframe.peek() }),
    ),
    /* Every workspace pane too. A sweep that deleted the bars under one of four
       open charts would be exactly as wrong as deleting them under one. */
    ...workspaceSeries(),
  ];

  /* v59.2 Research: the library can download and update series, and lists
     what the system has learned from the knowledge base. */
  const data = createData({ archive: feed.archive, kv, pinned: pinnedSeries, history: feed.history, knowledge: knowledgeBase });

  /**
   * The Analyst desk.
   *
   * Built once and kept, like the other desks: a conversation that is thrown
   * away every time you glance at the chart is not a conversation.
   */
  const agentDesk = createAgentDesk({
    session: analyst.session,
    providers: analyst.providers,
    providerId: analyst.providerId,
    fallbackNote: analyst.providerFallback,
    briefs: {
      list: () => analyst.briefStore.briefs(),
      /**
       * Read from the CHOSEN provider, not from `activeProvider()`.
       *
       * `activeProvider` returns `resilientProvider`, a wrapper whose id is
       * its own — so `canArm` saw a name that is neither "offline" nor
       * "local" and cleared every configuration, including the offline
       * analyst that is the default. The arm button worked, the watcher then
       * refused every pass on the real provider id, and the brief sat armed
       * and permanently unchecked. Exactly the silent failure this guard
       * exists to prevent, hidden one indirection deep.
       *
       * Being offline blocks it too: the resilient wrapper falls back to the
       * offline analyst, which cannot judge a brief either.
       */
      blocked: analyst.briefsBlocked,
      add: (text) => {
        analyst.briefStore.add(text, state.symbol.peek(), state.timeframe.peek());
      },
      arm: (id) => analyst.briefStore.arm(id),
      disarm: (id) => analyst.briefStore.disarm(id),
      remove: (id) => analyst.briefStore.remove(id),
    },
    onConfigure: () => {
      openOverlay(
        h(
          "div",
          { class: "menu", style: "width:420px;padding:0" },
          renderProviderConfig({
            baseUrl: analyst.baseUrl,
            apiKey: analyst.apiKey,
            model: analyst.model,
            provider: analyst.chosenProvider,
          }),
        ),
        { placement: "center", className: "overlay-palette", scrim: true },
      );
    },
    /* Tailored to what is actually loaded, so the first thing you can click is
       about your chart rather than a generic demo prompt. */
    suggestions: () => [
      `Brief me on ${state.symbol()} ${state.timeframe()}`,
      "What structures are on this chart right now?",
      "Is the forecast model usable here?",
      "How much history is stored locally?",
    ],
  });

  /**
   * The automatic sweep.
   *
   * Retention that only runs when you press a button is retention that never
   * runs, and the archive that fills the origin quota is the one nobody was
   * watching. So it is a supervised job: hourly, never overlapping, isolated
   * from the rest of the app, and backing off if it fails.
   *
   * It applies the plan it just computed, with the CURRENT chart pinned — so
   * the series on screen cannot be swept out from under it. It logs what it
   * removed rather than doing it silently; deletion nobody was told about is
   * indistinguishable from data loss.
   */
  supervisor.add({
    id: "retention",
    label: "Archive retention sweep",
    everyMs: 60 * 60_000,
    run: async () => {
      const inventory = await feed.archive.inventory();
      const plan = planRetention(
        inventory,
        { ...DEFAULT_POLICY, pinned: pinnedSeries() },
        Date.now(),
      );
      if (plan.changes.length === 0) return;
      const result = await applyRetention(feed.archive, plan);
      console.info(
        `[iram] retention: removed ${result.barsRemoved.toLocaleString()} bars across ${result.applied} series. ${plan.summary}`,
      );
    },
  });
  supervisor.start();

  const strategy = lazyDesk(() => createStrategy({
    symbol: state.symbol,
    timeframe: state.timeframe,
    bars,
    history: feed.history,
    /* v59.2 Strategy: drafts and decisions persist; the conversation uses
       the Analyst desk's session. */
    kv,
    session: analyst.session,
    /* v60 Autonomous: survivors are saved here, and the recommendation card
       reads the same store. */
    shelf,
    /* v60.2: and the same SEARCH, so the card can start one without sending
       the operator here to press a button. */
    sweep,
    sweepDepth,
  }));

  /* The same history service again, for the same reason as the Playbook: a
     cross-market survey and a single-market study must be reading the same
     archive, or "held across markets" and "survived out of sample" are claims
     about different bars. No `symbol` — the survey chooses its own panel. */
  const survey = lazyDesk(() => createSurvey({
    timeframe: state.timeframe,
    history: feed.history,
  }));

  /**
   * The Connections desk — which markets move together.
   *
   * THE ARCHIVE IS WHAT YOU HAVE. It asks the inventory what daily series are
   * actually held rather than drawing a fixed list, so a market downloaded this
   * morning appears and one never fetched is NAMED rather than silently absent.
   *
   * `load` is passed explicitly and the desk declares no default for it: this
   * repository has twice had a test reach the operator's real store through a
   * transport that defaulted to the live one.
   */
  const connections = lazyDesk(() => createConnections({
    loadSeries: async () => {
      const inv = await serverInventory();
      /* DAILY ONLY. A cross-asset web needs one grid, and 1d is the only bar
         size every one of these series is held at — the macro spine is daily by
         construction. Mixing 1h crypto with 1d gold would compare a week of one
         against a year of the other under one heading. */
      const held = inv.series
        .filter((s) => s.tf === "1d" && s.bars >= 120)
        .sort((a, b) => b.bars - a.bars)
        .slice(0, 16);
      const series: Record<string, { t: number; c: number }[]> = {};
      const missing: string[] = [];
      for (const row of held) {
        const got = await fetchServerBars(row.src, row.sym, "1d", 4000);
        if (!got.ok || got.bars.length === 0) {
          missing.push(`${row.sym} — ${got.reason || "the archive returned no bars"}`);
          continue;
        }
        series[row.sym] = got.bars.map((b) => ({ t: b.t, c: b.c }));
      }
      const spans = Object.values(series).map((s) => s.length);
      return {
        series,
        missing,
        /* NAMES WHAT IT RAN ON, not what it asked for. A count beside a window
           nobody stated is the shape this project has already paid for. */
        note:
          spans.length === 0
            ? "no daily series in the archive yet"
            : `${spans.length} daily series · ${Math.min(...spans)}–${Math.max(...spans)} bars each`,
      };
    },

    /* THE JOB LOG, for the System view. `/svc/events/summary` COUNTS IN SQL over
       the whole table rather than over a tail — CLAUDE.md records a recurring
       failure being under-reported forty-fold by a LIMIT 50. */
    loadActivity: async () => {
      const got = await activitySummary();
      /* A DISCRIMINATED UNION, so the refusal carries its own reason rather
         than being inferred from a missing field. */
      if (got.kind !== "ok") throw new Error(got.why);
      return got.value.kinds;
    },

    /* THE SHELF IS ALREADY IN MEMORY. A getter, not a fetch: the Strategy desk
       writes rows into the same store, so reading it again over the network
       would be a second owner of what has been kept. */
    shelf: () => shelf.rows(),
  }));

  /* The Analyse desk, on the SAME history service as the Strategy, Survey and
     Playbook desks — and that is the entire point of it. Those three each
     fetch their own depth for their own question, so "held across markets",
     "survived out of sample" and "this rule works" have never been claims
     about the same bars. A study fixes one window and runs all of them inside
     it.

     `symbol` and `timeframe` are read ONCE, when a new study is created, and
     the study keeps its own subject afterwards. A desk whose saved document
     silently changed subject every time the chart moved would be a desk whose
     saved documents mean nothing. */
  const study = lazyDesk(() => createStudyDesk(ctx, {
    history: feed.history,
    symbol: state.symbol,
    timeframe: state.timeframe,
    /* v59.2: the Data library tab shows this same desk, not a copy. */
    library: data,
  }));

  /* Same history service as the Strategy desk, deliberately: a rule tested here
     and a family swept there must be looking at the same bars, or the two
     verdicts are not comparable. */
  const playbook = lazyDesk(() => createPlaybook({
    symbol: state.symbol,
    timeframe: state.timeframe,
    history: feed.history,
    kv,
    /* So the desk can check a year range against what is HELD before fetching,
       and say "the archive starts 2022-01-23" rather than quietly running a
       shorter window than the one asked for. */
    archive: feed.archive,
  }));

  /* Reads the chart's own bar window rather than fetching its own. The map
     describes the series you are looking at, and a desk that quietly measured a
     different window would disagree with the chart beside it. */
  const sessions = lazyDesk(() => createSessions({
    symbol: state.symbol,
    timeframe: state.timeframe,
    bars: () => bars(),
  }));

  const smartMoney = lazyDesk(() => createSmartMoney({
    symbol: state.symbol,
    timeframe: state.timeframe,
    bars: () => bars(),
  }));

  const paper = lazyDesk(() => createPaper({
    symbol: state.symbol,
    kv,
    /**
     * `bars()`, NOT `bars.peek()`.
     *
     * The other desks read the last price only inside click handlers, where a
     * peek is right — it takes the current value without subscribing. This desk
     * reads it inside a computed (the marks map) and inside a text binding, and
     * a peek there registers no dependency: the fill was correct because the
     * click read it live, but the price on screen and every unrealised P&L
     * stayed frozen at whatever was loaded when the desk was built.
     */
    lastPrice: () => {
      const list = bars();
      const last = list[list.length - 1];
      return last ? last.c : 0;
    },
    bars: () => bars(),
    notify: (msg) => toaster.push({ level: "info", title: "Paper desk", body: msg }),
  }));

  const knowledge = lazyDesk(() => createKnowledge({
    base: knowledgeBase,
    history: feed.history,
    symbol: state.symbol,
    timeframe: state.timeframe,
    detectors: () => state.detectors(),
    minStopAtr: () => rules().minStopAtr,
  }));

  /* The machine's own state. Lazy like every other desk: it asks the gateway
     two questions on activation and nothing before that. */
  const system = lazyDesk(() => createSystemDesk({ kv }));

  const watchlist = lazyDesk(() => createWatchlist({
    symbol: state.symbol,
    kv,
    /* Clicking a row moves the CHART, which is the only reason to have a
       watchlist in the same window as one. */
    open: (sym) => {
      state.symbol.set(sym.toUpperCase());
      state.view.set("chart");
    },
    /**
     * Right-click a row.
     *
     * The verbs live here rather than in watchlist.ts because they are about
     * alerts, panes and other desks, and the watchlist has no business knowing
     * about any of them. It supplies the rows; this supplies what you can do
     * to one.
     */
    onRowsReady: (rowHost) => {
      attachContextMenu({
        host: rowHost,
        ctx: { commands, keymap },
        resolve: (e) => rowSubject(e, ".wl-row"),
        items: (sym) => [
          { kind: "header", label: sym },
          {
            label: "Open on the chart",
            run: () => {
              state.symbol.set(sym);
              state.view.set("chart");
            },
          },
          {
            label: "Open in a new pane",
            run: () => {
              state.symbol.set(sym);
              state.view.set("workspace");
              commands.run("ws.splitRight");
            },
          },
          { kind: "separator" },
          {
            label: "Copy symbol",
            run: () => void navigator.clipboard?.writeText(sym),
          },
        ],
      });
    },
  }));

  /* The autonomous loop's findings. Lazy like the rest: the desk asks the
     service the moment it is built, and building it at boot would have every
     tab poll a loop nobody has opened. */
  const simulation = lazyDesk(() => createSimulation({ symbol: state.symbol, timeframe: state.timeframe }));

  return {
    simulation,
    flow,
    data,
    agentDesk,
    strategy,
    survey,
    connections,
    study,
    playbook,
    sessions,
    smartMoney,
    paper,
    knowledge,
    watchlist,
    system,
  };
}
