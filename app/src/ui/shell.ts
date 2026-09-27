/**
 * The application shell.
 *
 * Owns layout state (dock / focus), mounts the chart, and wires the
 * status bar to the freshness contract. Layout modes are attributes on one
 * root element — see shell.css for why that is the whole point.
 */

import { signal, booleanView, computed, effect, renderEffect, untrack, type Signal, reactionCount } from "../core/signal";
import { createReplay } from "../core/replay";
import { h, clear } from "./dom";
import { icon } from "./icons";
import { ChartEngine, themeFromCss, type ChartKind, type CursorState, type LineOverlay } from "../chart/engine";
import { applyPalette, effectiveColour, readColour } from "../chart/palette";
import type { PriceScale } from "../chart/viewport";
import { ema } from "../chart/indicators";
import { runStudies, studyColumns } from "../chart/studies";
import { runPanes } from "../chart/panes";
import { sanitiseAll, tunedCount, type Params } from "../chart/params";
import { pkRowsLive, type PkRow } from "./panelkit";
import { PROFILE_BASIS, volumeProfile } from "../chart/profile";
import { createJournal } from "../journal/store";
import { createLearnStore } from "../learn/store";
import { createBackfiller } from "../data/backfill";
import { createLedger } from "../learn/ledger";
import { createEdge } from "../learn/edge";
import { claimVerdict, HORIZON_BARS } from "../learn/claim";
import { DEFAULT_EXIT_RULES, sanitiseExitRules, type ExitRules } from "../setup/exit";
import { createStudyPanel } from "./studypanel";
import { createFeedMonitor } from "./feedmon";
import { brokerClockOffsetMs } from "../data/sources";
import { looksCrypto } from "../data/venues";
import { quoteWords } from "../data/brokerquote";
import { createQuantDesk } from "./quantdesk";
import { DOCK_DESIGN, DOCK_LAYOUT, DOCK_SECTIONS, defaultRemoved, dockSummary, layoutOrder, nextCard, orderedIds, panelMeta, sanitiseActive, sanitiseIds, sanitiseMode, sanitiseOpen, toggleOpen, type DockMode } from "./dockpanels";
import { realisedR } from "../journal/entry";
import { createJournalDesk } from "./journal";
import { createLearnDesk } from "./learndesk";
import { createFeed } from "../data/feed";
import { DEFAULT_DETECTORS, DETECT_DESIGN, DETECTORS, FAMILY_LABEL, type DetectorId } from "../detect";
import { higherTimeframes, tfMs } from "../detect/mtf";
import { createAlerts } from "./alerts";
import { createBrokerModel } from "./model/broker";
import { createBookPanel } from "./bookpanel";
import { browserRawStoreProbed, createKV } from "../store/kv";
import { lastBackup, pushBackup, startBackup } from "../data/settingsbackup";
import { probeDurability } from "../store/durability";
import { createLiveBar, nextTickTone, type TickTone } from "./livebar";
import { countdownTone } from "./countdown";
import { marketState } from "../data/sessions";
import { createSetupCard } from "../setup/ui";
import { DEFAULT_RULES, sanitiseRules, type GateRules } from "../setup/rules";
import { createSupervisor, type LaneStatus } from "../setup/supervisor";
import { planShapes } from "../setup/chartplan";
import { createWatchRail } from "./watchrail";
import { createStructureModel } from "./model/structure";
import { readStudies } from "./model/studies";
import { createSetupModel } from "./model/setup";
import { createOutlookModel } from "./model/outlook";
import { createLiveModel } from "./model/live";
import { createReadingsModel } from "./model/readings";
import { createDockVerdict } from "./shell/dockverdict";
import { createDesks } from "./shell/desks";
import { createAnalystModel } from "./model/analyst";
import { createIntelModel } from "./model/intel";
import { createBriefing } from "./briefing";
import { sharedKnowledge } from "../learn/knowledge";
import { opportunityOf } from "./screener";
import { createOutlookPanel } from "./outlookpanel";
import { createLiveFeed, latestLine, latestTitle, newest } from "./livefeed";
import { createDeepReplay, DEEP_TARGET_BARS } from "../setup/deep";
import { scorecard as buildScorecard, type Scorecard as KindScorecard } from "../setup/scorecard";
import { createKindTable } from "./kindtable";
import { createSettings } from "../settings/ui";
import { SECTIONS, buildSettings } from "../settings/defs";
import { attachContextMenu, chartPoint } from "./contextmenu";
import { createAccountStore } from "../core/account";
import { createSymbolPicker } from "./symbolpicker";
import { forecastStanding } from "../data/intel";
import { seasonality, type SeasonMode } from "../data/context";
import { loadCalendar, upcoming, releaseRisk, currenciesFor, type CalendarFeed } from "../data/calendar";
import { loadNews, type NewsFeed } from "../data/news";
import { createRss, EMPTY, type RssFeed } from "../data/rss";
import { createNewsBar } from "./newsbar";
import { buildTape, createTape, type TapeItem } from "./tape";
import { trustLabel } from "../core/crosscheck";
import { createAlertStore, alertId } from "../alert/store";
import { createKeymap } from "../core/keys";
import { createCommands } from "../core/commands";
import { openMenu, type MenuItem } from "./menu";
import {
  CHANGE_LOOKBACK,
  PINNED_TIMEFRAMES,
  asMenuTrigger,
  barChange,
  barRange,
  caret,
  changeDirection,
  formatLastPrice,
  formatSignedPct,
  indicatorCount,
  spanCaption,
  splitTimeframes,
} from "./shell/topbar";
import { createToaster, renderNotificationPanel } from "./toast";
import { openShortcutSheet } from "./shortcuts";
import { openOverlay } from "./overlay";
import { registerCommands, bindKeys, appMenuItems, type CommandDeps } from "./commandset";
import type { TerminalAccess } from "../agent/tools";
import { exportVault, serialiseVault, vaultFilename } from "../store/vault";
import { scheduleFrame } from "../core/frame";
import { resetNet, netHealth, governor } from "../data/net";
import { createConnectionMonitor } from "../core/connection";
import { createDrawingStore } from "../draw/store";
import { createDrawingLayer } from "./drawing";
import { createDetectPanel } from "./detectpanel";
import { detectionToSeeds, timeMapper } from "../draw/fromdetection";
import { DRAW_KINDS, createDrawing, type DrawKind } from "../draw/model";
import { portfolioHeat } from "../risk/sizing";
import { CLASS_TABS, classTab, createCatalogue, rankSymbols, type SymbolEntry } from "../data/catalogue";
import { createFundamentals } from "../data/fundamentals";
import { createFundamentalsPanel } from "./fundamentals";
import type { Tone } from "../detect/types";
import { preset, findPane, splitPane, closePane, applyLink, paneCount, type PresetName } from "../core/workspace";
import { canAnchor, presetFor, anchorFor, anchorTimeframe } from "../alert/preset";
import { deliver } from "../alert/notify";
import type { BarView } from "../chart/series";
import { createTerminalAccess } from "./shell/terminalaccess";
import { ACCENTS, CHART_STYLES, SESSION_TIMEFRAMES, THEMES, TIMEFRAMES, DENSITIES, MA_SET, VIEWS, SCOPED_VIEWS, sessionWash, type ThemeName, type Density } from "./shell/views";
import { SESSIONS } from "../data/sessionmap";
import { assetClass } from "../data/sessions";
import { indexAtOrAfter } from "./shell/bars";
import { AUTO_SEARCH_SLOT, PIN_MARK, PREFS_SLOT, RULES_SLOT, loadPrefs, viewSignal, boolSignal } from "./shell/prefs";
import { createSweepDriver } from "./model/sweepdriver";
import { createSweepCache } from "../backtest/sweepcache";
import { enrolledSeries } from "../data/library";
import { pushEnrolment } from "../data/serverbars";
import { watchedSymbols } from "./watchlist";
import { loadStudyBars } from "./strategy/load";
import { DEFAULT_COSTS } from "../backtest/engine";
import { DRAW_ICON, abbreviate, clampNum, cursorField, fmt, fmtLike, fmtOrDash, fmtPx, num, num1, num2, qualityLabel } from "./shell/format";
import type { ShellState } from "./shell/state";
import { createShellContext, type ShellContext } from "./shell/context";
import { createDecisionSection } from "./shell/decision";
import { createWorkspaceSection } from "./shell/workspace";
import { createRiskSection } from "./shell/risk";
import { createPaletteSection } from "./shell/palette";
import { createCommandBar } from "./shell/commandbar";
import { createDockCards } from "./shell/dockcards";
import { createYourSay } from "./shell/yoursay";
import { createAutoVerdict } from "./shell/autoverdict";
import { createShelfStore } from "../backtest/shelfstore";
import { createChartDrawer, sanitiseDrawerTab, type DrawerTab } from "./chartdrawer";
import { createGovCard } from "./cards/govcard";
import { createAlertsCard } from "./cards/alertscard";
import { createWhaleCard } from "./cards/whalecard";
import { createDbWalletsCard, createNewPairsCard } from "./cards/newpairscard";
import { createLevelsCard } from "./cards/levelscard";
import { createWatchCard } from "./cards/watchcard";
import { createReadCard } from "./cards/readcard";
import { keyLevels } from "../scan/keylevels";






export function mountShell(root: HTMLElement): void {
  /**
   * The store, and whether it keeps anything.
   *
   * Probed BEFORE `loadPrefs`, because the beacon has to be read before any
   * other write can muddy it, and because the answer decides whether the empty
   * prefs below mean "new user" or "your settings were thrown away again".
   */
  const rawStore = browserRawStoreProbed();
  const durability = probeDurability(rawStore.store, {
    protocol: typeof location === "undefined" ? undefined : location.protocol,
    storeCanPersist: rawStore.canPersist,
  });
  const kv = createKV(rawStore.store);
  /* BACK IT UP TO THE SERVER. `POST /svc/backup` has existed since v29 and had
     NO caller anywhere: what the server held was a 15-day-old test fixture
     (`0xabc`, tier S — the one CLAUDE.md records four test files writing into
     the operator's live database), so every setting in this browser lived in
     exactly one place localStorage is free to evict. Debounced, and it REFUSES
     to upload an empty profile over a good copy. */
  /* The transport is passed EXPLICITLY — see `startBackup`'s own note. Its
     default was live, and a scheduling test reached this very server through
     it. */
  startBackup(kv, (r) => lastBackup.set(r), pushBackup);
  /* One account, created before any desk, so both read the same object. */
  const account = createAccountStore(kv);
  const prefs = loadPrefs(kv);
  const linkedView = (): string | null => {
    try {
      const v = new URLSearchParams(globalThis.location?.search ?? "").get("view");
      return v !== null && VIEWS.some((d) => d.id === v) ? v : null;
    } catch {
      return null;
    }
  };
  /* Saved under the v5 inspector design? See DOCK_DESIGN in dockpanels.ts. */
  const v5 = prefs["dockDesign"] === DOCK_DESIGN;
  /* Saved under the current detector design? See DETECT_DESIGN in detect/index.ts. */
  const detectGen = prefs["detectDesign"] === DETECT_DESIGN;

  const state: ShellState = {
    theme: signal<ThemeName>((prefs["theme"] as ThemeName) ?? "iram"),
    /* The Briefing, on a first run (v56). NOT a change for anyone already
       using the terminal: `view` is persisted, so an existing install opens
       on whatever it was last on. A product whose front door is a chart of
       whatever instrument you last looked at has no front door. */
    /* v59.2: `?view=<desk id>` opens a desk directly — a bookmark or a link
       to "the Strategy desk", and how screenshots of each workspace are
       taken. Only a known desk id is honoured; anything else is ignored. */
    view: signal<string>(linkedView() ?? (prefs["view"] as string) ?? "briefing"),
    dockOpen: signal<boolean>(prefs["dockOpen"] !== false),
    focus: signal<"off" | "on" | "full">("off"),
    symbol: signal<string>((prefs["symbol"] as string) ?? "BTCUSDT"),
    timeframe: signal<string>((prefs["timeframe"] as string) ?? "1h"),
    chartKind: signal<ChartKind>((prefs["chartKind"] as ChartKind) ?? "candles"),
    /* Linear by default. Log is right for long ranges and wrong-looking for the
       intraday window most sessions open on, so it is offered rather than
       assumed — and remembered once chosen. */
    priceScale: signal<PriceScale>((prefs["priceScale"] as PriceScale) ?? "linear"),
    /* On by default. It is a background wash that costs nothing to ignore, and
       "which session is this" is a question an intraday chart should not make
       you compute. */
    sessionBands: signal<boolean>(prefs["sessionBands"] !== false),
    /* On by default: a grid is what makes a level readable off the axis,
       and it is now switchable for anyone who wants price alone. */
    gridOn: signal<boolean>(prefs["grid"] !== false),
    /* Empty means "whatever the theme says" — see `chart/palette.ts` for why the
       stored value is an override rather than a colour. */
    candleUp: signal<string>(typeof prefs["candleUp"] === "string" ? (prefs["candleUp"] as string) : ""),
    candleDown: signal<string>(typeof prefs["candleDown"] === "string" ? (prefs["candleDown"] as string) : ""),
    mas: signal<string[]>(
      Array.isArray(prefs["mas"]) ? (prefs["mas"] as string[]) : ["ema20", "ema50"],
      // Arrays are compared by content: a fresh array with the same ids must
      // not count as a change, or every save would recompute every indicator.
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    studies: signal<string[]>(
      /* Empty by default. Nine studies switched on at once is a chart nobody
         can read, and a default that has to be undone is worse than one that
         has to be chosen. */
      Array.isArray(prefs["studies"]) ? (prefs["studies"] as string[]) : [],
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    panes: signal<string[]>(
      /* Empty by default, for the same reason as studies — and more sharply,
         because every pane takes height away from the price plot. */
      Array.isArray(prefs["panes"]) ? (prefs["panes"] as string[]) : [],
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    /* Sanitised on the way IN, not on the way out: a value saved under a range
       a later build narrowed is clamped once here rather than at every read.
       Compared by content for the same reason the arrays above are — a new
       object with identical numbers must not repaint the chart. */
    studyParams: signal<Record<string, Params>>(
      sanitiseAll(prefs["studyParams"]),
      (a, b) => JSON.stringify(a) === JSON.stringify(b),
    ),
    /* The dock's layout. Declared HERE with the other persisted preferences
       rather than beside the dock five hundred lines below, because the effect
       that saves them runs long before that — the temporal-dead-zone trap that
       has taken this shell down three times. */
    /* v59.2: a layout saved under an earlier design is reset once to the v5
       inspector — see DOCK_DESIGN. `v5` is false exactly once per install. */
    dockMode: signal<DockMode>(v5 ? sanitiseMode(prefs["dockMode"]) : "column"),
    dockOpenIds: signal<string[]>(
      sanitiseOpen(v5 ? prefs["dockOpenIds"] : null, prefs["dockLayout"]),
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    dockCard: signal<string>(sanitiseActive(prefs["dockCard"])),
    dockPinned: signal<string[]>(sanitiseIds(v5 ? prefs["dockPinned"] : null, []), (a, b) => a.length === b.length && a.every((v, i) => v === b[i])),
    /* The drawer under the chart starts COLLAPSED (the v5 design): the
       chart is the point, the drawer is where you look second. */
    chartDrawerOpen: signal<boolean>(prefs["chartDrawerOpen"] === true),
    chartDrawerTab: signal<DrawerTab>(sanitiseDrawerTab(prefs["chartDrawerTab"])),
    dockRemoved: signal<string[]>(sanitiseIds(v5 ? prefs["dockRemoved"] : null, defaultRemoved()), (a, b) => a.length === b.length && a.every((v, i) => v === b[i])),
    /* GATED ON `DETECT_DESIGN`, and defaulting to `DEFAULT_DETECTORS` rather
       than a hand-written list. Both halves were wrong: a saved set was read
       back verbatim for ever (the owner's held ONE detector of 29), and the
       fallback named three by hand while `DEFAULT_DETECTORS` — imported into
       this very file — names nine. Two lists for one fact, and they disagreed. */
    detectors: signal<DetectorId[]>(
      detectGen && Array.isArray(prefs["detectors"])
        ? (prefs["detectors"] as DetectorId[])
        : [...DEFAULT_DETECTORS],
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    htf: signal<string[]>(
      Array.isArray(prefs["htf"]) ? (prefs["htf"] as string[]) : [],
      (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    ),
    density: signal<Density>((prefs["density"] as Density) ?? "standard"),
  };

  /**
   * The volume band: whether it is shown, and how tall.
   *
   * Declared HERE, beside the other preference-backed signals, and not down
   * with the chart code that uses them. The first version put them next to the
   * drag handler, four thousand lines below the effect that persists them — a
   * temporal dead zone that threw `Cannot access 'volumeOn' before
   * initialization` on the effect's very first run. Because that effect writes
   * the WHOLE preference snapshot, the throw did not just lose the volume
   * settings: it killed the effect, and nothing at all was saved from then on.
   * A preference that silently stops persisting is invisible until someone
   * restarts and loses their layout, so the declaration order here is load
   * bearing.
   */
  const volumeHeight = signal<number>(
    typeof prefs["volumeHeight"] === "number" ? (prefs["volumeHeight"] as number) : ChartEngine.VOLUME_H,
  );
  const volumeOn = signal<boolean>(prefs["volumeOn"] !== false);

  /**
   * Fetch the read's evidence on symbol change, without waiting to be asked.
   *
   * Declared HERE, beside the other preference-backed signals, for the reason
   * spelled out two comments up: this file has thrown a temporal dead zone on
   * the persistence effect three separate times, and each one silently stopped
   * ALL preferences from saving.
   *
   * Default on. See `createSupervisor` below for the measurement — a fresh chart reported
   * 13% coverage with a third of its declared evidence sitting behind panels
   * nobody had opened.
   */
  const evidenceAuto = signal<boolean>(prefs["evidenceAuto"] !== false);

  /**
   * The news bar, above the live bar.
   *
   * DECLARED HERE, four thousand lines above where the bar is built, for the
   * reason the two comments above give at length: the persistence effect reads
   * every preference signal, and one declared below it throws a temporal dead
   * zone on that effect's FIRST run — which does not merely lose this setting,
   * it kills the effect and nothing is saved from then on. This file has done
   * that three times. The first draft of this signal was declared at the mount
   * site and would have been the fourth.
   *
   * ON by default, and it did not used to be.
   *
   * The argument for off was that it is a strip of chrome and the most
   * interruptive thing on screen. What that reasoning missed is that the
   * service ships a working feed list — `DEFAULT_FEEDS` in `mishel_rss.py`,
   * five sources including the Fed and the majors — so the bar has something to
   * say from the first run, and a headline row is the one piece of context a
   * price chart cannot supply for itself.
   *
   * `!== false` rather than `=== true`, so the saved preference still wins in
   * both directions: someone who turned it off stays off, and someone who never
   * touched it now gets it. A `=== true` default cannot be flipped without
   * ignoring the stored value of everyone who left it alone.
   */
  const newsOn = signal<boolean>(prefs["newsBar"] !== false);
  const accent = signal<string>(
    typeof prefs["accent"] === "string" && (ACCENTS as readonly string[]).includes(prefs["accent"]) ? prefs["accent"] : "theme",
  );
  /* The watchlist rail beside the chart (v55). On by default until v59.2.
     The v5 design has no left rail — the watchlist is an inspector card and
     the Today page's focus list — and MEASURED at 1440 the rail's 245px left
     the chart toolbar 802px for 1,227px of controls. So the v5 reset
     (DOCK_DESIGN) turns it off once; after that the operator's choice sticks,
     and a rail switched back on is still handled by the toolbar's give-way
     order in v5.css. */
  const railOn = signal<boolean>(v5 ? prefs["watchRail"] !== false : false);

  /**
   * Where the anchored VWAP hangs from — a TIMESTAMP, never a bar index.
   *
   * An index is meaningless across a reload: load 300 bars instead of 800 and
   * index 412 is a different candle, or no candle. Storing the time and
   * resolving it against whatever is loaded means the anchor stays on the bar
   * you actually chose, or disappears honestly when that bar is outside the
   * window rather than silently sliding to another one.
   *
   * Declared HERE, above the preferences effect that reads it, and not beside
   * the study panel where it is used. A const declared below an effect that
   * reads it throws on that effect's first run and takes the whole effect with
   * it — which in this file means nothing persists at all. That has happened
   * once already.
   */
  /**
   * The journal, and the exit rules the Setup card reads.
   *
   * Declared up here with the other persisted state rather than beside the
   * card that uses them, for the reason spelled out on `avwapAnchorTime`
   * below: a const read by an effect declared above it throws on that effect's
   * first run and takes the whole effect with it.
   */
  const journal = createJournal(kv);

  /**
   * False until every desk has been constructed. See the gate in the view
   * switch below for what this is protecting against and how it was measured.
   */
  const desksReady = signal(false);

  /**
   * A desk built the first time it is opened, not at boot.
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHAT IT COSTS TO BUILD A DESK NOBODY IS LOOKING AT
   *
   * Desks are constructed detached — the shell holds `.el` and inserts it when
   * the view switches — so an unopened desk contributes NOTHING to the element
   * tree and is completely invisible in the inspector. What it does contribute
   * is effects, and those run for the rest of the session.
   *
   * Measured on the chart view, which is the default and where the terminal
   * spends nearly all of its time: 994 live reactions against 1,452 DOM nodes.
   * Most of that belonged to seventeen desks the operator was not looking at,
   * each re-deriving its panels on every tick of a symbol they had not opened
   * it for.
   *
   * ────────────────────────────────────────────────────────────────────────
   * IT ALSO RETIRES A CLASS OF BUG
   *
   * `shell.ts` has produced the same temporal-dead-zone crash seven times, and
   * the desks were the sharpest edge of it: `createJournalDesk` renders at
   * construction and reads `setupView`, so it had to be declared below it, and
   * the comment holding that ordering in place is longer than the call. The
   * `desksReady` gate in the view switch exists for the same reason.
   *
   * A thunk is not evaluated until the view is opened, by which point every
   * `const` in this function is initialised. The ordering constraint stops
   * being something a comment has to defend.
   */
  /* `LazyDesk` and `lazyDesk` moved to `./shell/context.ts`. They were declared
     inside this closure, which meant a section lifted into its own file could
     not name the type its own desks have. Behaviour is unchanged — the same
     signal-backed `built()` probe, for the same measured reason recorded there. */

  /**
   * The learning store, up here for the same dead-zone reason as the journal.
   *
   * It is read by the recording effect declared far below, and by the sweep
   * inside `loadData` — both of which run before anything near the Learning
   * desk is constructed. A store declared beside its desk would be in the
   * temporal dead zone for both, and the failure is the one this file has
   * already had four times: the effect throws, `createReaction` swallows it,
   * and nothing is ever recorded with no error anywhere on screen.
   */
  const learn = createLearnStore(kv);

  /**
   * The durable copy of the track record.
   *
   * Claims stay in the browser and everything keeps reading them from there —
   * the terminal works identically with the service stopped. This mirrors them
   * to the local ledger, which is the only place they survive a cleared cache,
   * a quota failure, or the five-thousand-entry cap. Best effort by design: the
   * service is usually not running, and `ledger.status()` says which of "not
   * running" and "refused the batch" happened rather than raising a toast the
   * operator would learn to dismiss.
   */
  const ledger = createLedger({ claims: learn.claims });
  effect(() => {
    /* Depend on the claims themselves so a new claim and a RESOLUTION both
       trigger a push — `pendingFor` keys on id AND outcome for the same
       reason. */
    learn.claims();
    void ledger.push();
  });

  /**
   * The trial mirror.
   *
   * Deliberately NOT wired to an effect the way the claims ledger is. A claim
   * is made a handful of times an hour; the replay produces hundreds of trials
   * and re-runs whenever the symbol, timeframe, R multiple or bar count
   * changes, which on a one-minute chart is every minute. Pushing on every
   * recomputation would be a steady write load for rows that are identical by
   * construction — the ids are derived from the trials, so a re-push converges
   * rather than duplicating, but converging on the same rows a thousand times
   * a day is still a thousand round trips.
   *
   * So it pushes when the operator asks, from the Learning desk, and the
   * conditional read below pulls whatever has accumulated.
   */
  const edge = createEdge({ symbol: () => state.symbol(), timeframe: () => state.timeframe() });

  const EXIT_SLOT = {
    key: "setup.exitRules",
    version: 1,
    fallback: (): ExitRules => DEFAULT_EXIT_RULES,
    validate: (v: unknown): ExitRules => sanitiseExitRules(v),
  };
  const exitRules = signal<ExitRules>(sanitiseExitRules(kv.read(EXIT_SLOT).value));
  const setExitRule = (patch: Partial<ExitRules>): void => {
    const next = sanitiseExitRules({ ...exitRules.peek(), ...patch });
    exitRules.set(next);
    const res = kv.write(EXIT_SLOT, next);
    if (!res.ok) console.warn(`[iram] exit rules not saved — ${res.error}`);
  };

  const avwapAnchorTime = signal<number | null>(
    typeof prefs["avwapAnchor"] === "number" ? (prefs["avwapAnchor"] as number) : null,
  );

  const setVolumeHeight = (px: number): void => {
    /* The engine clamps against the live host height and returns what it
       actually applied, so a drag stops at the limit instead of drifting away
       from the cursor. */
    const applied = chart?.setVolumeHeight(px);
    volumeHeight.set(applied ?? px);
    placeVolResizer();
  };

  /**
   * The gate thresholds the Setup card calls "yours".
   *
   * Kept in its own KV slot rather than in `prefs`, because these are trading
   * rules and the preference blob is UI state: a corrupt theme should not be
   * able to take your daily loss limit with it, and a rules slot that fails
   * validation quarantines on its own and comes back as the documented
   * defaults. `sanitiseRules` is applied on READ as well as write, so a file
   * edited by hand cannot produce a card that silently refuses everything.
   */
  const rulesRaw = kv.read(RULES_SLOT);
  const rules = signal<GateRules>(sanitiseRules(rulesRaw.value));

  const setRules = (patch: Partial<GateRules>): void => {
    const next = sanitiseRules({ ...rules.peek(), ...patch });
    rules.set(next);
    kv.write(RULES_SLOT, next);
  };

  /**
   * Venues the user has switched off, remembered across restarts.
   *
   * The registry holds the live set; this signal is what gets persisted and
   * what re-applies it on boot. Two representations of one fact, but the
   * registry is created inside `createFeed` before preferences are read, so
   * something has to carry the choice across that gap.
   */
  const disabledSources = signal<string[]>(
    Array.isArray(prefs["disabledSources"]) ? (prefs["disabledSources"] as string[]) : [],
  );

  /**
   * What the detectors DRAW, as opposed to what they find.
   *
   * Filters over measured output, never over the detection itself. Nothing here
   * can make a structure appear that was not there, which is the line between
   * this and the "sensitivity" control the panel deliberately does not have.
   */
  const detectMinConfidence = signal<number>(
    typeof prefs["detectMinConfidence"] === "number" ? (prefs["detectMinConfidence"] as number) : 0,
  );
  const detectDensity = signal<string>((prefs["detectDensity"] as string) ?? "normal");
  const detectDirection = signal<string>((prefs["detectDirection"] as string) ?? "both");

  const alertSound = signal<boolean>(prefs["alertSound"] !== false);
  const alertDesktop = signal<boolean>(prefs["alertDesktop"] === true);

  /**
   * The dock the USER asked for, as distinct from the dock currently on screen.
   *
   * These are not the same thing and conflating them lost people the dock
   * permanently. Below 1100px the dock becomes an overlay and is auto-closed so
   * it does not cover the desk behind it — but `state.dockOpen` is what gets
   * persisted, so that transient, layout-driven close was written into
   * preferences as though it had been a decision. Quit while narrow and the
   * next launch at full width came up with the dock shut, `dockBeforeNarrow`
   * null, and nothing to restore from: the Setup card, the Fundamentals panel
   * and the whole inspector were simply gone, with only a toolbar icon most
   * people never find standing between the user and their layout.
   *
   * So intent is tracked separately and intent is what is saved. `applyNarrow`
   * moves the screen; only a real toggle moves this.
   */
  const dockIntent = signal<boolean>(prefs["dockOpen"] !== false);

  /** The Setup card's wrapper, so a command can scroll it into view. */
  const setupMount: { el: HTMLElement | null } = { el: null };

  /**
   * Open the dock and put the Setup card in front of you.
   *
   * Scrolled on the next frame, not immediately: the dock's width transitions
   * from zero, and a `scrollIntoView` measured mid-transition lands on the
   * wrong offset. It is also first in the dock, so the scroll is usually a
   * no-op — it earns its place when the dock is already scrolled elsewhere.
   */
  const revealSetup = (): void => {
    state.dockOpen.set(true);
    dockIntent.set(true);
    scheduleFrame(() => setupMount.el?.scrollIntoView?.({ block: "start" }));
  };

  /** What every user-facing dock control writes: the screen AND the intent. */
  const dockToggle = boolSignal(
    () => state.dockOpen(),
    (v) => {
      state.dockOpen.set(v);
      dockIntent.set(v);
    },
  );

  effect(() => {
    const snapshot = {
      theme: state.theme(),
      view: state.view(),
      dockOpen: dockIntent(),
      symbol: state.symbol(),
      timeframe: state.timeframe(),
      chartKind: state.chartKind(),
      priceScale: state.priceScale(),
      sessionBands: state.sessionBands(),
      grid: state.gridOn(),
      candleUp: state.candleUp(),
      candleDown: state.candleDown(),
      mas: state.mas(),
      studies: state.studies(),
      panes: state.panes(),
      studyParams: state.studyParams(),
      dockMode: state.dockMode(),
      dockOpenIds: state.dockOpenIds(),
      watchRail: railOn(),
      /* Which column the open set was chosen for. See DOCK_LAYOUT. */
      dockLayout: DOCK_LAYOUT,
      dockDesign: DOCK_DESIGN,
      detectDesign: DETECT_DESIGN,
      dockCard: state.dockCard(),
      dockPinned: state.dockPinned(),
      dockRemoved: state.dockRemoved(),
      chartDrawerOpen: state.chartDrawerOpen(),
      chartDrawerTab: state.chartDrawerTab(),
      detectors: state.detectors(),
      htf: state.htf(),
      density: state.density(),
      accent: accent(),
      alertSound: alertSound(),
      alertDesktop: alertDesktop(),
      volumeOn: volumeOn(),
      volumeHeight: volumeHeight(),
      evidenceAuto: evidenceAuto(),
      newsBar: newsOn(),
      avwapAnchor: avwapAnchorTime(),
      disabledSources: disabledSources(),
      detectMinConfidence: detectMinConfidence(),
      detectDensity: detectDensity(),
      detectDirection: detectDirection(),
    };
    const res = kv.write(PREFS_SLOT, snapshot);
    // Quota is worth saying out loud once: the user's next question is why the
    // theme keeps resetting, and the answer is in the Data desk.
    if (!res.ok) console.warn(`[iram] preferences not saved — ${res.error}`);
  });

  effect(() => document.documentElement.setAttribute("data-theme", state.theme()));
  effect(() => document.documentElement.setAttribute("data-density", state.density()));
  /* "theme" sets NO attribute, so the theme's own brand applies — see the
     accent block at the end of tokens.css. */
  effect(() => {
    const a = accent();
    if (a === "theme") document.documentElement.removeAttribute("data-accent");
    else document.documentElement.setAttribute("data-accent", a);
  });

  const feed = createFeed();

  /**
   * Setup base rates, replayed over deep history.
   *
   * Declared HERE — immediately after `feed`, and far above every reader —
   * rather than beside the decision code that uses it. `shell.ts` has produced
   * the same temporal-dead-zone crash seven times, always because a `const`
   * was declared below something that reached it from inside a closure, and
   * tsc cannot see that case. Its own dependencies (`state`, `rules`) are read
   * lazily through the closures below, so nothing here runs at construction.
   *
   * See setup/deep.ts for why this exists at all: the chart's 800-bar window
   * contains too few instances of any one pattern to characterise it, and a
   * full pass over ten thousand bars costs thirteen milliseconds.
   */
  /* Three dependency-free factories, up here because `ctx` carries the toaster
     and because a keymap or a command registry created mid-assembly would be
     invisible to anything declared above it. */
  const keymap = createKeymap();
  const commands = createCommands();
  const toaster = createToaster();

  /**
   * THE FOUNDATION, ASSEMBLED ONCE.
   *
   * Everything above this line is what a section may assume exists: storage,
   * preferences, the account, the reactive state, the feed, the toaster and the
   * desk memoiser. Everything below is assembly.
   *
   * Built here rather than threaded as loose arguments because the alternative
   * was measured and rejected: 237 top-level declarations in this function, 99
   * of them read by three or more sections. A section lifted out needed a
   * twenty-argument options object, which moves the coupling into a signature
   * instead of removing it. `ctx` is the half that is genuinely common; what one
   * section borrows from ANOTHER stays an explicit parameter, because that list
   * being short is the only evidence a split was worth making.
   */
  const ctx: ShellContext = createShellContext({
    kv,
    prefs,
    account,
    state,
    feed,
    toaster,
    commands,
    keymap,
    });

  /* Pulled off the context here, so the nineteen `lazyDesk(...)` calls below
     read exactly as they did while it was a local const — and so it is in scope
     for the first of them, 900 lines above where the decision section now sits. */
  const { lazyDesk } = ctx;

  /**
   * What past replays have taught, kept across sessions (v55.3).
   *
   * One base, shared by the Knowledge desk, the Setup card's second history
   * line and the analyst's `get_knowledge` tool — so all three quote the same
   * numbers. It is reported BESIDE the in-sample replay, never merged into the
   * score: selecting on a base rate found in the same bars is the PBO
   * mechanism this repository already measures.
   */
  const knowledgeBase = sharedKnowledge(kv);

  const deepReplay = createDeepReplay({
    history: feed.history,
    detectors: () => state.detectors(),
    minStopAtr: () => rules().minStopAtr,
  });

  /**
   * Re-apply the user's venue choices to the registry.
   *
   * `createFeed` builds the registry from `defaultRegistry()` with everything
   * on, and it runs before preferences have been read — so without this the
   * switches in Settings would take effect for one session and be forgotten.
   * An effect rather than a one-shot so a change in Settings reaches the
   * registry immediately, without a reload.
   */
  effect(() => {
    feed.registry.setDisabled(disabledSources());
  });

  // ------------------------------------------------------------- chrome ---
  /**
   * The keyboard, the command registry, the notification log and the palette.
   *
   * Created here — before the desks — because desks register commands and
   * bindings of their own, and because the toaster must exist before anything
   * that could fail has a chance to.
   */
  /**
   * Connection health.
   *
   * Reads the governor every few seconds and makes NO requests of its own —
   * measuring the network by polling it is how a connection monitor becomes
   * the thing that gets you rate limited.
   */
  const connection = createConnectionMonitor({
    snapshots: () =>
      governor.stats().hosts.map((hs) => ({
        host: hs.host,
        label: hs.label,
        latencyMs: hs.latencyMs,
        latencySamples: hs.latencySamples,
        bannedUntil: hs.bannedUntil,
        banReason: hs.banReason,
        softBlocked: hs.softBlocked,
        softBlockReason: hs.softBlockReason,
        queued: hs.queued,
        rejections: hs.rejections,
        lastRejectionAt: hs.lastRejectionAt,
      })),
  });

  /* `keymap`, `commands` and `toaster` moved up into the foundation — they take
     no arguments and every section uses them. See the block above `ctx`. */

  /**
   * Tell the user their settings are not being kept, ONCE, and pinned.
   *
   * `ttlMs: 0` because this must not scroll away: the whole failure is that the
   * terminal silently forgets, and a warning that also disappears would be the
   * same bug wearing a different hat. It is still dismissible, and it stays in
   * the notification log afterwards.
   *
   * `durable` and `unknown` say nothing at all. A first run on a healthy
   * browser must be quiet, or the warning becomes noise and gets ignored on the
   * one day it matters.
   */
  if (durability.state === "ephemeral" || durability.state === "at-risk") {
    toaster.push({
      level: "warn",
      ttlMs: 0,
      key: "storage-durability",
      title:
        durability.state === "ephemeral"
          ? "Your settings are not being saved"
          : "Your settings may not be saved",
      body: `${durability.note}${durability.remedy ? ` ${durability.remedy}` : ""}`,
    });
  }

  /* The half-typed key sequence, mirrored into a signal so the status bar can
     bind to it. It changes on a TIMER as well as on input, so a poll would not
     be enough. */
  const chordPending = signal<string>("");
  keymap.onPending((chords) =>
    chordPending.set(chords.map((c) => c.key.toUpperCase()).join(" ")),
  );

  const RECENT_SLOT = {
    key: "commands.recent",
    version: 1,
    fallback: (): string[] => [],
    validate: (v: unknown): string[] | null =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null,
  };
  const recentRead = kv.read(RECENT_SLOT);
  commands.seedRecent(recentRead.value);
  // Persisted so the palette's empty state is useful on the FIRST keystroke of
  // a session, not only after you have used it once.
  commands.onRun(() => void kv.write(RECENT_SLOT, [...commands.recent()]));


  /**
   * THE VIEW EVERYTHING ELSE READS.
   *
   * While replay is off this is `feed.bars` unchanged, by identity. While it is
   * on it is a PREFIX of the series, and nothing downstream is told about it —
   * the chart, the detectors, the alert engine and the studies all just receive
   * fewer bars. That is the look-ahead firewall: there is no future to leak
   * because the future is not in the array they are handed. See core/replay.ts.
   */
  const replay = createReplay<BarView>(feed.bars);
  const bars = replay.bars;

  const cursor = signal<CursorState | null>(null);
  const loading = signal(false);
  /** True while older bars are being fetched, for the left-edge indicator. */
  const olderPending = signal(false);

  /**
   * The alert book lives at shell level, not inside the Signals desk.
   *
   * An alert that only evaluates while its own tab is open is a decoration.
   * This is created before the desks and evaluated by an effect below, so it
   * runs on the chart, the screener, or anywhere else.
   */
  const alertStore = createAlertStore(kv);

  /**
   * The model layer, asked on demand — `ui/model/intel.ts`.
   *
   * Both models are seconds of server CPU, so nothing here runs on a tick or on
   * a symbol change — it runs when you press the button, and the panel says so.
   *
   * Constructed HERE rather than lower down because the Setup card and the
   * evidence supervisor both read these signals and both are built above the
   * point the old declarations sat at. The same temporal-dead-zone rule the
   * declarations around this one carry.
   */
  const { intel, regime, forecast, intelBusy, intelAnsweredAt, runIntel } =
    createIntelModel(ctx, { bars });


  /**
   * What the evidence supervisor is waiting for. Declared HERE, thousands of
   * lines above `createSupervisor`, because the Setup card reads it and the
   * card is built long before the supervisor is.
   *
   * This file has been bitten by that temporal dead zone six times and
   * typescript cannot see it: the read is inside a closure, so `tsc` is happy
   * and the browser throws at first paint. Moving the declaration is the fix.
   * See `nowMs` a few lines below for the same note.
   */
  const evidenceStatus = signal<readonly LaneStatus[]>([]);

  const seasonMode = signal<SeasonMode>("hour");
  const season = computed(() => seasonality(bars(), seasonMode()));
  /**
   * A once-a-second clock, declared HERE rather than beside the live bar.
   *
   * Three things read it now — the bar countdown, the chart's axis tag and the
   * tape's release countdowns — and the tape is built with the top bar, several
   * thousand lines above where this used to live. A `const` read by something
   * constructed earlier is the temporal dead zone this file has been bitten by
   * five times; moving the declaration is the fix, not another guard.
   *
   * Deliberately NOT wrapped in `onCleanup`: that pushes onto the ACTIVE
   * reaction and there is none out here, so it would be a silent no-op that
   * merely looked like teardown. `mountShell` runs once for the life of the
   * document and the interval is meant to outlive everything in it.
   */
  const nowMs = signal<number>(Date.now());
  setInterval(() => nowMs.set(Date.now()), 1000);

  const calendar = signal<CalendarFeed | null>(null);
  const news = signal<NewsFeed | null>(null);

  /**
   * The tape's contents, rebuilt from what the terminal already knows.
   *
   * A function rather than a `computed`: it reads `nowMs`, which ticks once a
   * second, and caching a value that is invalidated every second buys nothing
   * while costing a cache line the rest of the bar would share.
   *
   * `alerts: []` is a gap and it is deliberate. `createAlerts` does not expose
   * its fires — its handle is `{ el }` — so putting the operator's own fired
   * conditions on the tape means widening that interface, which is a change to
   * the alert engine rather than to this. The input stays declared so the
   * extension point is visible instead of being rediscovered later.
   */
  const tapeItems = (): readonly TapeItem[] =>
    buildTape({
      now: nowMs(),
      feed: feed.state(),
      marketClosed: marketState(state.symbol(), nowMs()) === "closed",
      calendar: calendar(),
      currencies: currenciesFor(state.symbol()),
      news: news(),
      alerts: [],
    });

  const tape = createTape({
    items: tapeItems,
    now: () => nowMs(),
    /* Clicking a release opens the desk that holds the calendar; clicking an
       announcement opens the one that holds the venue feed. A tape line that
       cannot be followed up is a line you have to remember, which is the job
       this is supposed to be doing for you. */
    onOpen: (item) => {
      if (item.kind === "release" || item.kind === "announcement") state.view.set("decision");
      else if (item.kind === "feed") state.dockOpenIds.update((ids) => (ids.includes("feed") ? ids : [...ids, "feed"]));
    },
  });

  /**
   * Refresh the calendar and the news.
   *
   * Both are cached in the network layer, so calling this on a desk switch is
   * cheap and keeps the panels current without a "Load" button — the user asked
   * for FRESH sources, and a source you have to remember to press a button for
   * is not fresh, it is on demand.
   */
  const refreshMacro = (): void => {
    void loadCalendar().then((r) => calendar.set(r));
    void loadNews({ limit: 12 }).then((r) => news.set(r));
  };



  let chart: ChartEngine | null = null;
  let chartHost: HTMLElement | null = null;
  /** The volume band's drag handle, parked on the boundary the engine reports. */
  let volResizer: HTMLElement | null = null;



  /**
   * Detections, filters and the draw cap — `ui/model/structure.ts`.
   *
   * Moved out whole (v56). Eight derived reads that had no DOM and no effects
   * in them, over five siblings. Destructured here so every call site below is
   * unchanged, which is what makes the move reviewable as a move.
   */
  const {
    closedBarCount,
    detectData,
    detections,
    alertDetections,
    filteredOut,
    drawn,
    detectCounts,
  } = createStructureModel(ctx, {
    bars,
    detectMinConfidence,
    detectDensity,
    detectDirection,
    alertStore,
  });

  /**
   * Copy what is drawn into drawings the user owns.
   *
   * `drawn()`, not `detections()`: pinning the full set would put 31 structures
   * on a chart showing 6, and the ones it added would be the ones deliberately
   * capped away as too old to matter. What you see is what gets pinned.
   *
   * One `begin`/`commit` pair around the whole batch, so a pin that produced
   * fourteen drawings is ONE undo rather than fourteen.
   */
  const pinDetections = (): void => {
    const series = bars.peek();
    const structures = drawn.peek();
    if (series.length === 0 || structures.length === 0) return;

    const timeAt = timeMapper(Float64Array.from(series, (b) => b.t));
    const symbol = state.symbol.peek();
    const timeframe = state.timeframe.peek();

    drawStore.begin();
    let added = 0;
    for (const det of structures) {
      for (const seed of detectionToSeeds(det, timeAt)) {
        drawStore.add(
          createDrawing(seed.kind, seed.anchors, {
            symbol,
            timeframe,
            tone: seed.tone,
            /* Marked so "Remove pinned" can find these again without keeping a
               second list that would go stale the first time one was deleted
               by any other route. */
            text: `${seed.text ?? ""}${PIN_MARK}`,
            ...(seed.extendRight === undefined ? {} : { extendRight: seed.extendRight }),
          }),
        );
        added++;
      }
    }
    drawStore.commit();

    toaster.push({
      level: added > 0 ? "success" : "warn",
      title: added > 0 ? `Pinned ${added} drawing${added === 1 ? "" : "s"}` : "Nothing to pin",
      body:
        added > 0
          ? "They are yours now — editable, and they stay when the detector is switched off. Ctrl+Z undoes the lot."
          : "The structures on screen have no drawable geometry.",
    });
  };

  /**
   * A panel hanging off a control in the chart header.
   *
   * Built here rather than reaching for `openOverlay`: an overlay is a modal
   * layer with a scrim and focus capture, and this is a set of toggles you flip
   * two or three of while watching the chart change behind them. Capturing the
   * screen for that would be wrong — you would have to reopen it after every
   * click to see what the last one did.
   *
   * RE-ANCHORABLE since the Fusion header. The detector and study panels used
   * to own a button each; they are now opened from menu rows (the Indicators
   * pill and the overflow menu), so the anchor is passed at open time and the
   * panel hangs from whichever control opened it.
   *
   * Closes on outside pointerdown and on Escape. Escape stops propagating, so
   * dismissing the panel does not also clear the armed drawing tool, and hands
   * focus back to the control that opened it.
   */
  const anchoredPopover = (
    panel: HTMLElement,
  ): { readonly host: HTMLElement; readonly open: (anchor: HTMLElement) => void } => {
    panel.hidden = true;
    let off: (() => void) | null = null;
    let anchor: HTMLElement | null = null;

    /**
     * Positioned against the viewport, not the anchor.
     *
     * The context bar scrolls horizontally when narrow, and an overflow
     * container CLIPS absolutely-positioned descendants. Fixed coordinates
     * escape it, at the cost of having to be recomputed on open.
     *
     * Flipped to the right edge when it would otherwise run off screen, and
     * never allowed above the toolbar.
     */
    const place = (): void => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const w = panel.offsetWidth || 260;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(r.bottom + 4)}px`;
    };

    const close = (): void => {
      panel.hidden = true;
      off?.();
      off = null;
    };

    const open = (at: HTMLElement): void => {
      close();
      anchor = at;
      panel.hidden = false;
      place();

      /* Re-placed rather than closed on scroll or resize: closing a panel
         because the window moved discards a set of toggles mid-thought. */
      const onMove = (): void => place();
      window.addEventListener("resize", onMove);
      window.addEventListener("scroll", onMove, true);

      const onDown = (e: Event): void => {
        if (!panel.contains(e.target as Node)) close();
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close();
        anchor?.focus();
      };
      /* Next task, for the reason `openOverlay` gives: the press that chose the
         menu row opening this panel is still propagating. */
      const arm = setTimeout(() => {
        document.addEventListener("pointerdown", onDown, true);
      }, 0);
      document.addEventListener("keydown", onKey, true);
      off = () => {
        clearTimeout(arm);
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onMove);
        window.removeEventListener("scroll", onMove, true);
      };

      /* Keyboard users land inside the panel, as they did when it followed
         its own button in the tab order. */
      /* The first one that is actually RENDERED: the study panel's first
         button is a "0 tuned" chip hidden while nothing is tuned, and focus()
         on a hidden element silently does nothing. */
      const first = [...panel.querySelectorAll<HTMLElement>("button, input, select, [tabindex]")].find(
        (el) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled,
      );
      first?.focus({ preventScroll: true });
    };

    return { host: h("span", { class: "tool-pop-wrap" }, panel) as HTMLElement, open };
  };

  const detectPopover = () =>
    anchoredPopover(
      createDetectPanel({
        detectors: state.detectors as unknown as Signal<string[]>,
        detectorSet: DETECTORS.map((d) => ({
          id: d.id,
          label: d.label,
          blurb: d.blurb,
          family: d.family,
          familyLabel: FAMILY_LABEL[d.family],
        })),
        defaultDetectors: DEFAULT_DETECTORS,
        htf: state.htf,
        htfChoices: () => higherTimeframes(state.timeframe()),
        counts: () => detectCounts(),
        found: () => detections().length,
        drawn: () => drawn().length,
        minConfidence: detectMinConfidence,
        density: detectDensity,
        direction: detectDirection,
        filtered: () => filteredOut(),
        onPin: pinDetections,
        pinnedCount: () => pinnedOnThisChart().length,
        onClearPinned: clearPinned,
      }),
    );

  /**
   * Panes the chart had no room for, reported by the engine.
   *
   * Declared here, above `studyPopover`, because the popover reads it at
   * construction. A `const` read by a callback defined earlier in this file is
   * the temporal-dead-zone trap that has taken this shell down three times.
   */
  const panesDropped = signal<string[]>([]);

  const studyPopover = () =>
    anchoredPopover(
      createStudyPanel({
        studies: state.studies,
        panes: state.panes,
        params: state.studyParams,
        panesDropped: () => panesDropped(),
        anchor: avwapAnchorTime,
        newestBarTime: () => {
          const b = bars();
          return b.length === 0 ? null : (b[b.length - 1] as BarView).t;
        },
        /* The most recent swing the detectors already found. Reusing their
           pivots rather than finding a swing again means the anchor lands on
           the same bar the chart has drawn structure at — two different swing
           definitions on one screen is a bug report waiting to happen. */
        swingTime: () => {
          /* The newest structure the detectors found, whatever kind it is.
             `from` is the bar the structure starts at, which is the swing the
             anchor should hang from. */
          const b = bars();
          if (b.length === 0) return null;
          let newest = -1;
          for (const det of detections()) if (det.from > newest) newest = det.from;
          if (newest < 0 || newest >= b.length) return null;
          return (b[newest] as BarView).t;
        },
        anchorLabel: () => {
          const t = avwapAnchorTime();
          return t === null ? "" : new Date(t).toLocaleString();
        },
        profile: () => {
          const p = volumeProfile(bars());
          return p === null
            ? null
            : { poc: p.poc, vah: p.vah, val: p.val, basis: PROFILE_BASIS };
        },
        /* The same rule the price axis uses, so a level read off this panel
           and the same level read off the chart are the same string. */
        price: (v) => (v >= 1000 ? v.toFixed(2) : v.toFixed(5)),
      }),
    );

  /**
   * Drawings that came from Pin, on the chart in front of you.
   *
   * Identified by a marker in `text` rather than by a separate list, because a
   * separate list is a second source of truth that goes stale the moment a
   * drawing is deleted by any of the four other routes that can delete one.
   * The marker travels with the drawing through undo, export and sync.
   */
  const pinnedOnThisChart = () =>
    drawStore
      .visible(state.symbol(), state.timeframe())
      .filter((d) => typeof d.text === "string" && d.text.endsWith(PIN_MARK));

  /**
   * Remove what Pin added, and nothing else.
   *
   * Scoped to this chart and to pinned drawings only: a "clear" that also took
   * the trendline you drew by hand would be unforgivable, and there would be no
   * way to tell which had happened afterwards.
   */
  const clearPinned = (): void => {
    const doomed = pinnedOnThisChart();
    if (doomed.length === 0) return;
    drawStore.begin();
    for (const d of doomed) drawStore.remove(d.id);
    drawStore.commit();
    toaster.push({
      level: "success",
      title: `Removed ${doomed.length} pinned drawing${doomed.length === 1 ? "" : "s"}`,
      body: "Only drawings created by Pin were touched. Ctrl+Z brings them back.",
    });
  };

  /** RSI and ATR, stamped with the series they came from. See
      `ui/model/studies.ts` for why the stamp is the ARRAY and not its times. */
  const studies = computed(() => readStudies(bars()));

  // --------------------------------------------------------------- risk ---

  /**
   * The Risk desk, the calculator and the shared archive read — now
   * `./shell/risk.ts`. Two siblings: the bars and the computed indicator read.
   */
  const { riskDesk, calculator, loadArchiveCloses, bookSlot, countedSource } = createRiskSection(ctx, { bars, studies });

  /**
   * THE BROKER, AND THE BOOK EVERY RISK FIGURE IS NOW COMPUTED FROM.
   *
   * Until this existed, `riskDesk.positions` — rows the operator typed in by
   * hand — was the input to portfolio heat, to the correlation exposure count,
   * to the Briefing's "where you stand", and to every lot size. Those answers
   * were correct for their inputs and the inputs were a guess, while
   * `/mt5/positions` had been able to answer the same question for a long time
   * and nothing in the frontend had ever called it.
   *
   * The Risk desk goes on owning the hand-entered rows, because those are the
   * operator's own input and must stay editable. This owns the RECONCILED
   * book: broker rows win, hand-entered rows the broker does not report are
   * shown and NOT counted, and a row whose contract size is unknown is refused
   * rather than counted at one unit per lot. See `trade/book.ts`.
   */
  const broker = createBrokerModel(ctx, { manual: riskDesk.positions });

  /** What you are actually in. NOT `riskDesk.positions`, which is what you typed. */
  const openBook = computed(() => broker.book().counted);

  /* Filled now rather than passed in, which is what breaks the cycle between
     the desk that owns the hand-entered rows and the panel that reconciles
     them against the broker. */
  bookSlot.appendChild(createBookPanel({ broker, account, manual: riskDesk.positions }));

  /* The Risk desk's own figures now read the reconciled book. Without this the
     desk whose entire job is risk would go on reporting heat from the rows
     somebody typed in, while the chip in the command bar showed the broker's
     equity — two numbers from two books, side by side, which is precisely the
     defect `core/account.ts` exists to prevent. */
  effect(() => countedSource.set(broker.book().counted));

  // ----------------------------------------------------------- drawings ---

  const drawStore = createDrawingStore(kv);
  /** Armed tool, or null for select mode. */
  const drawTool = signal<DrawKind | null>(null);
  const drawMagnet = signal<boolean>(prefs["drawMagnet"] !== false);
  const drawTone = signal<Tone>("accent");

  /**
   * Declared here, assigned once the chart host exists.
   *
   * MEASURED as a temporal-dead-zone crash: the drawing toolbar's
   * `disabled: () => drawLayer?.selected() === null` is a reactive prop, and
   * `h()` runs those IMMEDIATELY when it builds the element — which happens
   * several hundred lines before the layer itself is constructed. A `const`
   * there threw "Cannot access 'drawLayer' before initialization" on every
   * boot, four times, inside a signal effect that swallowed it into a console
   * error rather than a visible failure. Same shape as `chart` and `agentDesk`
   * above, and for the same reason.
   */
  let drawLayer: import("./drawing").DrawingLayer | null = null;

  // ---------------------------------------------------------- catalogue ---

  /**
   * Every symbol the venue lists, ranked by liquidity.
   *
   * Fetched once a day and cached, because the universe call costs weight 40 —
   * the single most expensive request the terminal makes. The palette answers
   * from memory, so a keystroke never waits on a network round trip.
   */
  const catalogue = createCatalogue(kv);
  catalogue.ensure();

  // ------------------------------------------------------- fundamentals ---

  /**
   * What the chart cannot show: supply, float, dilution, turnover.
   *
   * One request returns 250 assets with every field, cached for an hour, so a
   * whole session costs a single call. Fetched eagerly at boot because the
   * panel is in the inspector and visible immediately — waiting for a click
   * would mean the most-visible panel is the one that is always empty.
   */
  const fundamentals = createFundamentals(kv);
  fundamentals.ensure();

  // ----------------------------------------------------------- decision ---

  /**
   * Cross-venue, derivatives, correlation, macro, drivers, the forecast view,
   * and the read they feed — all of it now in `./shell/decision.ts`.
   *
   * 508 lines lived here. It was never lifted out because the obvious options
   * object needed twenty-one arguments; measuring showed eight of those were
   * comment words and one was a property name on an unrelated object, so the
   * real surface is the foundation plus the eight siblings listed below.
   *
   * `watchlist` is a THUNK because it is declared further down this function.
   * The screener's "add these" handler runs long after assembly, so a value
   * captured here would be `undefined` — the single genuine forward reference
   * in the section, and the reason the parameter is a function.
   */
  const decisionSection = createDecisionSection(ctx, {
    bars,
    calendar,
    detections,
    forecast,
    regime,
    fundamentals,
    watchlist: () => watchlist(),
    rules,
    openPositions: () => openBook().length,
  });

  const {
    spread,
    spreadAt,
    brokerQuote,
    derivatives,
    decision,
    refreshDecision,
    driverBars,
    loadDrivers,
    screener,
    decisionDesk,
  } = decisionSection;

  // ---------------------------------------------------------- workspace ---

  /**
   * The multi-pane workspace — now `./shell/workspace.ts`.
   *
   * It takes the context and NOTHING else: measured, it reads five things from
   * outside itself and all five are foundation. The first section in this file
   * with no sibling dependencies at all.
   */
  const { WORKSPACE_PRESETS, layout, setLayout, activePaneId, cyclePaneLink, workspace, workspaceSeries } =
    createWorkspaceSection(ctx);


  const emaAt = (period: number): number => {
    const series = bars.peek();
    if (series.length < period) return NaN;
    const close = Float64Array.from(series, (b) => b.c);
    const line = ema(close, period);
    return line[line.length - 1] ?? NaN;
  };

  /**
   * The analyst's window on the terminal, as a named value.
   *
   * Hoisted out of the `createAgentSession` call because a standing brief runs
   * in its OWN throwaway session and must see EXACTLY the same terminal — a
   * second object assembled at a second call site is a second definition of
   * what the analyst can reach, and the two would drift.
   */
  const terminalAccess: TerminalAccess = createTerminalAccess({
    state, feed, bars, learn, riskDesk, journal, edge,
    deepReplay, calendar, intel, drawStore, detections, emaAt,
    portfolioHeat, alertStore, decision, fundamentals, studies,
    /* Read through a function: both are reassigned by the decision pass, and
       captured by value this object would answer with whatever they held at
       mount. */
    lastRec: () => setupLast.rec,
    lastChoice: () => setupLast.choice,
    /* The Setup card's own view model, so the expert's `get_setup` answers
       with the verdict the inspector is showing rather than re-deriving one.
       `peek`, not a read: this object is built once and the tool is called
       from outside any reactive scope. */
    setupView: () => setupView.peek(),
    /* CALLS the compositor rather than returning it — lazy only because
       `composeChart` is declared further down. `() => composeChart` handed
       `see_chart` a function where it wanted a canvas and threw on every
       call; `any` accepted it, and the real type now refuses it. */
    composeChart: () => composeChart(),
    loadArchiveCloses,
  });

  /**
   * The analyst — `ui/model/analyst.ts`.
   *
   * Built here rather than above `terminalAccess` because it takes it: the
   * window stays assembled beside the signals it reads, and the subsystem that
   * uses it moves out whole.
   */
  const analyst = createAnalystModel(ctx, { connection, closedBarCount, terminalAccess });


  let agentDesk: import("./agent").AgentDesk | null = null;

  const askAgent = (question?: string): void => {
    state.view.set("agent");
    /* The desk mounts on the next frame; focusing before it is in the document
       does nothing and leaves the caret on the body. */
    scheduleFrame(() => {
      agentDesk?.focus();
      if (question) void analyst.session.ask(question);
    });
  };

  // ------------------------------------------------------------ palette ---
  //
  // Lifted to `./shell/palette.ts`: five sources, one export, three siblings.

  const { palette } = createPaletteSection(ctx, { bars, catalogue, detections });
  // ------------------------------------------------------ shown symbol ---
  //
  // Its own section because it is not the palette's, and sitting under the
  // palette's header made every measurement of that section wrong: a tool
  // asked what the palette exports answered `palette, shownSymbol,
  // shownTimeframe, setShownSymbol, setShownTimeframe` -- five outputs for a
  // thing with one. These four are topbar-to-workspace glue, read by the
  // timeframe strip, the symbol picker and the topbar labels.

  /**
   * The topbar reads and writes THE THING YOU ARE LOOKING AT.
   *
   * On every desk but the workspace that is `state.symbol` / `state.timeframe`.
   * On the workspace it is the ACTIVE PANE — otherwise switching a pane to 1h
   * leaves the topbar lit on 1m, and a control bar that does not describe what
   * is on screen is worse than no control bar, because you will trust it.
   *
   * Writes go through `applyLink`, so the topbar moves a pane's whole link
   * channel exactly the way the pane's own controls do. One code path, one
   * behaviour.
   */
  const onWorkspace = (): boolean => state.view() === "workspace";

  const shownSymbol = (): string => {
    if (!onWorkspace()) return state.symbol();
    return findPane(layout(), activePaneId())?.symbol ?? state.symbol();
  };

  const shownTimeframe = (): string => {
    if (!onWorkspace()) return state.timeframe();
    return findPane(layout(), activePaneId())?.timeframe ?? state.timeframe();
  };

  const setShownSymbol = (symbol: string): void => {
    if (!onWorkspace()) {
      state.symbol.set(symbol);
      return;
    }
    setLayout(applyLink(layout.peek(), activePaneId.peek(), { symbol }));
  };

  const setShownTimeframe = (timeframe: string): void => {
    if (!onWorkspace()) {
      state.timeframe.set(timeframe);
      return;
    }
    setLayout(applyLink(layout.peek(), activePaneId.peek(), { timeframe }));
  };

  // ----------------------------------------------------------- commands ---

  /**
   * Export the chart as a PNG, drawings and all.
   *
   * The engine paints on TWO stacked canvases — a base layer for candles and
   * annotations, an overlay for the crosshair — so a single `toDataURL` would
   * capture whichever one you happened to ask. They are composited onto a third
   * canvas here, over an opaque background, because the overlay is transparent
   * and a PNG with an alpha channel becomes unreadable the moment it is pasted
   * into anything with a light theme.
   */
  const composeChart = (): HTMLCanvasElement | null => {
    const host = chartHost;
    if (!host) return null;
    const layers = Array.from(host.querySelectorAll("canvas"));
    if (layers.length === 0) return null;

    const first = layers[0] as HTMLCanvasElement;
    const out = document.createElement("canvas");
    out.width = first.width;
    out.height = first.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;

    const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-base").trim();
    ctx.fillStyle = bg || "#0B0E14";
    ctx.fillRect(0, 0, out.width, out.height);
    for (const layer of layers) ctx.drawImage(layer, 0, 0, out.width, out.height);

    /* A caption burned into the image, not added afterwards. An exported chart
       gets pasted into a message and outlives the context it was taken in;
       without the symbol, timeframe and time on the pixels, it is a picture of
       an unidentified market at an unknown moment. */
    const scale = out.width / Math.max(1, first.clientWidth || out.width);
    ctx.font = `${Math.round(11 * scale)}px ui-monospace, monospace`;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#7A8494";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `${state.symbol.peek()} · ${state.timeframe.peek()} · ${feed.state.peek().source} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`,
      Math.round(8 * scale),
      out.height - Math.round(6 * scale),
    );
    return out;
  };

  /**
   * Export the chart as a PNG, drawings and all.
   *
   * The compositing lives in `composeChart` because the analyst's `see_chart`
   * needs the SAME pixels — same layers, same opaque background, same burned-in
   * caption. A model shown a different rendering from the one the operator can
   * export is a model being asked about a picture nobody else can see.
   */
  const exportChartPng = (): void => {
    const out = composeChart();
    if (out === null) {
      toaster.push({ level: "warn", title: "Nothing to export", body: "The chart has not painted yet." });
      return;
    }

    out.toBlob((blob) => {
      if (!blob) {
        toaster.push({ level: "error", title: "Export failed", body: "The browser could not encode the image." });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = h("a", {
        href: url,
        download: `${state.symbol.peek()}-${state.timeframe.peek()}-${new Date().toISOString().slice(0, 10)}.png`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      scheduleFrame(() => URL.revokeObjectURL(url));
      toaster.push({ level: "success", title: "Chart exported", body: `${out.width}×${out.height} PNG, with the symbol and time on it.` });
    }, "image/png");
  };

  const download = (name: string, text: string): void => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoked on the next frame: revoking synchronously can beat the download. */
    scheduleFrame(() => URL.revokeObjectURL(url));
  };

  let bellAnchor: HTMLElement | null = null;

  const deps: CommandDeps = {
    commands,
    keymap,
    newsOn,
    railOn,
    view: state.view,
    theme: state.theme as unknown as Signal<string>,
    themes: THEMES,
    density: state.density as unknown as Signal<string>,
    densities: DENSITIES,
    dockOpen: dockToggle,
    revealSetup,
    volumeOn,
    gridOn: state.gridOn,
    sessionBands: state.sessionBands,
    /* A boolean VIEW of the two-valued scale, so the command reads as a toggle
       while the signal keeps its own vocabulary. Not a mirrored copy: there is
       one source of truth and the on-chart `lin`/`log` button still drives it. */
    logScale: booleanView(state.priceScale, (v) => v === "log", (on) => (on ? "log" : "linear")),
    resetVolumeHeight: () => setVolumeHeight(ChartEngine.VOLUME_H),
    focus: state.focus,
    /* Wrapped so the palette, the menus and the topbar all move the same
       thing. Two routes to "set the timeframe" that disagree is the exact class
       of bug the single command registry exists to prevent. */
    symbol: viewSignal(shownSymbol, setShownSymbol),
    timeframe: viewSignal(shownTimeframe, setShownTimeframe),
    timeframes: TIMEFRAMES,
    chartKind: state.chartKind as unknown as Signal<string>,
    chartKinds: ["candles", "hollow", "heikin", "bars", "line", "area"],
    mas: state.mas,
    maSet: MA_SET.map((m) => ({ id: m.id, period: m.period })),
    detectors: state.detectors as unknown as Signal<string[]>,
    detectorSet: DETECTORS.map((x) => ({ id: x.id, label: x.label })),
    htf: state.htf,
    htfChoices: () => higherTimeframes(state.timeframe()),
    alertSound,
    alertDesktop,
    viewList: VIEWS.map((v) => ({ id: v.id, label: v.label })),

    workspacePresets: WORKSPACE_PRESETS,
    applyWorkspacePreset: (id) => {
      /* Seeded from the CHART desk's symbol, not from the outgoing layout: you
         reach for a preset when you want to start over, and starting over on
         whatever the old first pane happened to hold is not starting over. */
      setLayout(
        preset(id as PresetName, {
          symbol: state.symbol.peek(),
          timeframe: state.timeframe.peek(),
        }),
      );
      state.view.set("workspace");
    },
    splitActivePane: (dir) => setLayout(splitPane(layout.peek(), activePaneId.peek(), dir)),
    closeActivePane: () => setLayout(closePane(layout.peek(), activePaneId.peek())),
    canCloseActivePane: () => paneCount(layout()) > 1 && state.view() === "workspace",
    cycleActivePaneLink: () => cyclePaneLink(activePaneId.peek()),
    activePaneLink: () => findPane(layout(), activePaneId())?.link ?? "none",

    drawKinds: DRAW_KINDS.map((k) => ({ id: k.id, label: k.label, hint: k.hint })),
    armDrawTool: (id) => {
      drawTool.set(id as DrawKind | null);
      /* Arming a tool from the palette while another desk is open would put you
         in a mode you cannot see. */
      if (id !== null) state.view.set("chart");
    },
    armedDrawTool: () => drawTool(),
    magnet: () => drawMagnet(),
    toggleMagnet: () => drawMagnet.update((v) => !v),
    undoDrawing: () => void drawStore.undo(),
    canUndoDrawing: () => {
      drawStore.revision();
      return drawStore.canUndo();
    },
    redoDrawing: () => void drawStore.redo(),
    canRedoDrawing: () => {
      drawStore.revision();
      return drawStore.canRedo();
    },
    deleteDrawing: () => drawLayer?.deleteSelected(),
    hasDrawingSelected: () => drawLayer?.selected() !== null && drawLayer !== null,
    clearDrawings: () => drawStore.clearChart(state.symbol.peek(), state.timeframe.peek()),
    drawingCount: () => drawStore.visible(state.symbol(), state.timeframe()).length,

    goLive: () => chart?.goLive(),
    reload: () => void loadData(),
    toggleReplay: () => (replay.active.peek() ? replay.stop() : replay.start()),
    replayActive: () => replay.active(),
    replayStep: (n) => replay.step(n),
    openPalette: (initial) => palette.toggle(initial ?? ""),
    openShortcuts: () => void openShortcutSheet(keymap, commands),
    openSettings: () => settings().open(),
    openNotifications: () => {
      toaster.markAllRead();
      openOverlay(renderNotificationPanel(toaster), {
        ...(bellAnchor ? { anchor: bellAnchor } : {}),
        placement: "top-start",
        className: "overlay-menu",
      });
    },
    askAgent,

    exportVault: (withHistory) => {
      void (async () => {
        try {
          const file = await exportVault(kv, withHistory ? feed.archive : null, {
            includeArchive: withHistory,
          });
          download(vaultFilename(file.createdAt), serialiseVault(file));
          toaster.push({
            level: "success",
            title: "Vault exported",
            body:
              file.redacted.length > 0
                ? `Withheld ${file.redacted.length} credential-shaped key(s): ${file.redacted.join(", ")}.`
                : "No credential-shaped keys were present.",
          });
        } catch (err) {
          toaster.push({
            level: "error",
            title: "Export failed",
            body: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    },

    resetNetwork: () => {
      const before = netHealth();
      resetNet();
      toaster.push({
        level: "warn",
        title: "Request governor reset",
        body: `Cleared ${before.cacheEntries} cached response(s) and every host budget. A venue-side ban is NOT cleared by this — only time clears that.`,
      });
    },

    exportChartPng,
    copyChartSummary: () => {
      const st = studies.peek();
      const series = bars.peek();
      const last = series[series.length - 1];
      const feedNow = feed.state.peek();
      const text = [
        `${state.symbol.peek()} ${state.timeframe.peek()}`,
        `close ${last ? fmt(last.c) : "—"} · ${series.length} bars · ${feedNow.source} (${feedNow.quality})`,
        `RSI(14) ${num1(st.rsi)} · ATR(14) ${num2(st.atrPct)}% of price`,
        `${detections.peek().length} structure(s) detected`,
        `as of ${new Date().toISOString()}`,
      ].join("\n");
      void navigator.clipboard
        ?.writeText(text)
        .then(() =>
          toaster.push({ level: "success", title: "Copied", body: text.split("\n")[0] ?? "" }),
        )
        .catch(() =>
          toaster.push({
            level: "error",
            title: "Clipboard refused",
            body: "The browser blocked clipboard access for this page.",
          }),
        );
    },

    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else
        void document.documentElement.requestFullscreen().catch(() => {
          toaster.push({
            level: "warn",
            title: "Full screen refused",
            body: "The browser declined the request.",
          });
        });
    },
  };

  registerCommands(deps);
  bindKeys(deps);
  /*
   * FILM GRAIN, over the whole window.
   *
   * A flat CSS surface is what makes a dark interface look like a screenshot
   * of a stylesheet rather than a product, and 4% of fractal noise is most of
   * the difference. It is the ONE effect applied to the window rather than to
   * an element, so it lives here and not in a desk.
   *
   * `position: fixed` and `pointer-events: none`, so it never takes a click,
   * and `--grain` is 0 on the light theme — noise over white reads as a dirty
   * screen. Inline SVG rather than an image: it is 200 bytes, it needs no
   * network, and `feTurbulence` is resolution-independent, so it does not
   * soften on a HiDPI display the way a tiled PNG would.
   */
  const grainLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  grainLayer.setAttribute("class", "grain");
  grainLayer.setAttribute("aria-hidden", "true");
  grainLayer.innerHTML =
    '<filter id="iram-grain"><feTurbulence type="fractalNoise" baseFrequency="0.85"' +
    ' numOctaves="3" stitchTiles="stitch"/></filter>' +
    '<rect width="100%" height="100%" filter="url(#iram-grain)"/>';
  document.body.appendChild(grainLayer);

  keymap.attach(window);

  /**
   * ONE application menu, not seven.
   *
   * `appMenuItems` nests the former File/View/Chart/Draw/Tools/Help menus as
   * submenus, so nothing became less reachable and the row got ~250px back for
   * the things that are used constantly. See the note in commandset.ts.
   */
  const appMenu = h(
    "button",
    {
      class: "appmenu-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Menu",
      onpointerdown: (e: Event) => {
        /* pointerdown for the same reason the old menu bar used it: the overlay
           dismisses on pointerdown, so a click handler would reopen what the
           same press had just closed. */
        e.preventDefault();
        const btn = e.currentTarget as HTMLElement;
        if (btn.getAttribute("aria-expanded") === "true") return;
        btn.setAttribute("aria-expanded", "true");
        openMenu(appMenuItems(deps), {
          anchor: btn,
          placement: "bottom-start",
          ctx: { commands, keymap },
          onClose: () => btn.setAttribute("aria-expanded", "false"),
        });
      },
    },
    h("span", { class: "brand-mark", ref: (el: HTMLElement) => el.appendChild(icon("brand", { size: 12 })) }),
    h("span", { class: "appmenu-name", text: "IRAM" }),
    h("span", { class: "appmenu-caret", text: "▾", "aria-hidden": "true" }),
  );

  // ------------------------------------------------------------- topbar ---

  /**
   * Filled by the input's `ref`, wired to the picker just below the topbar.
   *
   * A holder rather than a bare `let`: control-flow analysis cannot see the
   * `ref` callback run, so a plain local would still be typed `null` at the use
   * site and narrow to `never` inside the guard.
   */
  const symbolInputRef: { el: HTMLInputElement | null } = { el: null };

  /**
   * The Fusion chart header's moving parts, built before the row itself.
   *
   * The menus are `openMenu` — the primitive the app menu and the desk bar
   * already use — and every row that has a registered command names it by id,
   * so its tick, its accelerator and its handler are the palette's own. See
   * `ui/shell/topbar.ts` for why the row stopped being twenty-four buttons.
   */
  const menuCtx = { commands, keymap };
  const detectPop = detectPopover();
  const studyPop = studyPopover();

  /** Price, change and range of the CHART desk's series — the status bar's source. */
  const headline = computed(() => {
    const series = bars();
    const last = series[series.length - 1];
    return {
      price: last ? last.c : null,
      change: barChange(series),
      range: barRange(series),
      span: spanCaption(state.timeframe(), CHANGE_LOOKBACK),
    };
  });
  const tfSplit = () => splitTimeframes(TIMEFRAMES, PINNED_TIMEFRAMES, shownTimeframe());
  const currentStyle = () =>
    CHART_STYLES.find((s) => s.id === state.chartKind()) ?? (CHART_STYLES[0] as (typeof CHART_STYLES)[number]);
  const indicatorsOn = () => indicatorCount(state.mas(), state.studies(), state.panes());
  const studiesOn = () => state.studies().length + state.panes().length;

  /* `cls` so a single reading can leave the row on its own: ATR is the first
     thing shed, because the live bar at the foot of the screen already carries
     it and the two range figures do not appear anywhere else in the chrome. */
  const headStat = (label: () => string, value: () => string, title: () => string, cls = ""): HTMLElement =>
    h(
      "span",
      { class: `tb-stat${cls ? ` ${cls}` : ""}`, title },
      h("span", { class: "tb-stat-k", text: label }),
      h("span", { class: "tb-stat-v", text: value }),
    );

  const indicatorsBtn: HTMLButtonElement = asMenuTrigger(
    h(
      "button",
      {
        class: "tool-btn wide tb-pill",
        type: "button",
        title: "Indicators — moving averages, and RSI, MACD, Ichimoku, bands, VWAP and their settings",
        "aria-label": () => `Indicators, ${indicatorsOn()} on`,
        "data-on": () => String(indicatorsOn() > 0),
        /* A dot for any study running non-published settings, as before. */
        "data-tuned": () => String(tunedCount(state.studyParams()) > 0),
      },
      icon("indicators"),
      h("span", { class: "tb-pill-label tb-ind-label", text: "Indicators" }),
      h("span", {
        class: "tb-count",
        "data-zero": () => String(indicatorsOn() === 0),
        text: () => String(indicatorsOn()),
      }),
      caret(),
    ) as HTMLButtonElement,
    {
      ctx: menuCtx,
      items: (): MenuItem[] => {
        const n = studiesOn();
        return [
          { kind: "header", label: "Moving averages" },
          ...MA_SET.map((ma): MenuItem => ({ id: `chart.${ma.id}`, label: `EMA ${ma.period}` })),
          { kind: "separator" },
          {
            label: "Studies and oscillators…",
            hint: n > 0 ? `${n} on` : "none",
            run: () => studyPop.open(indicatorsBtn),
          },
        ];
      },
    },
  );

  /**
   * v59.2 — AUTO-MARKING, OUT OF THE OVERFLOW (the v5 toolbar).
   *
   * What the AI marks on the chart is the Chart workspace's whole premise
   * ("AI-led"), and it was the fourth row of a "⋯" menu. Now a labelled pill
   * with the number of detectors on, opening the same popover the overflow
   * row opens — one popover, two ways in.
   */
  const autoMarkBtn = h(
    "button",
    {
      class: "tool-btn wide tb-pill tb-automark",
      type: "button",
      title: "Auto-marking — the structures, levels, gaps and patterns the AI draws on the chart",
      "aria-label": () => `Auto-marking, ${state.detectors().length} on`,
      "data-on": () => String(state.detectors().length > 0),
      onclick: () => detectPop.open(autoMarkBtn),
    },
    icon("detect"),
    h("span", { class: "tb-pill-label tb-am-label", text: "Auto-marking" }),
    h("span", {
      class: "tb-count",
      "data-zero": () => String(state.detectors().length === 0),
      text: () => String(state.detectors().length),
    }),
  ) as HTMLButtonElement;

  const overflowBtn: HTMLButtonElement = asMenuTrigger(
    h(
      "button",
      {
        class: "tool-btn tb-overflow",
        type: "button",
        "aria-label": "More chart actions",
        /* Lit while auto-detect is finding things — the at-a-glance signal the
           detector's own button used to carry before it moved in here. */
        "data-on": () => String(state.detectors().length > 0),
        title: () =>
          state.detectors().length > 0
            ? "Live edge, reload, export, auto-detect (on), studies"
            : "Live edge, reload, export, auto-detect, studies",
      },
      h("span", { text: "⋯", "aria-hidden": "true" }),
    ) as HTMLButtonElement,
    {
      ctx: menuCtx,
      placement: "bottom-end",
      items: (): MenuItem[] => {
        const det = state.detectors().length;
        const n = studiesOn();
        return [
          { id: "chart.goLive" },
          { id: "chart.reload" },
          { id: "chart.exportPng" },
          { kind: "separator" },
          {
            label: "Auto-detect…",
            hint: det > 0 ? `${det} on` : "off",
            run: () => detectPop.open(overflowBtn),
          },
          {
            label: "Studies and oscillators…",
            hint: n > 0 ? `${n} on` : "none",
            run: () => studyPop.open(overflowBtn),
          },
        ];
      },
    },
  );

  const topbar = h(
    "header",
    { class: "topbar" },

    h(
      "div",
      { class: "sym-picker" },
      h("input", {
        class: "sym-input num",
        value: () => shownSymbol(),
        "aria-label": "Symbol",
        title: "Symbol — type to search, ↑↓ to pick, Esc to cancel",
        spellcheck: "false",
        /**
         * No `onchange`.
         *
         * It used to be the only handler here, and it fires on BLUR — so
         * typing "ETH" and clicking away committed `ETH`, wrote it to
         * preferences, and the next boot came up on an instrument no venue
         * quotes with a chart of zero bars. The picker below commits only on
         * Enter or a click on a row, and restores the box otherwise.
         */
        ref: (el: HTMLInputElement) => {
          symbolInputRef.el = el;
        },
      }),
    ),

    /**
     * The price headline: the last close of the chart's own series, and its
     * change over the last 24 bars, captioned with the span those bars cover.
     * No animation on a tick — this changes many times a minute.
     */
    h(
      "div",
      { class: "tb-quote", role: "group", "aria-label": "Last price" },
      h("span", { class: "tb-price", text: () => formatLastPrice(headline().price) }),
      h(
        "span",
        {
          class: "tb-chg",
          "data-dir": () => {
            const c = headline().change;
            return c ? changeDirection(c.pct) : "none";
          },
          title: () => {
            const q = headline();
            return q.change
              ? `Change over the last ${q.change.lookback} bars (${q.span}): ${formatLastPrice(q.change.from)} → ${formatLastPrice(q.change.to)}`
              : `Needs ${CHANGE_LOOKBACK + 1} bars to measure a ${CHANGE_LOOKBACK}-bar change`;
          },
        },
        h("span", {
          class: "tb-chg-v",
          text: () => {
            const c = headline().change;
            return c ? formatSignedPct(c.pct) : "—";
          },
        }),
        h("span", { class: "tb-chg-k", text: () => headline().span }),
      ),
    ),

    h(
      "div",
      { class: "tb-stats" },
      headStat(
        () => `${headline().span} high`,
        () => {
          const r = headline().range;
          return r ? formatLastPrice(r.high) : "—";
        },
        () => `Highest high of the last ${CHANGE_LOOKBACK} bars`,
      ),
      headStat(
        () => `${headline().span} low`,
        () => {
          const r = headline().range;
          return r ? formatLastPrice(r.low) : "—";
        },
        () => `Lowest low of the last ${CHANGE_LOOKBACK} bars`,
      ),
      headStat(
        () => "ATR",
        () => (Number.isFinite(studies().atrPct) ? `${num2(studies().atrPct)}%` : "—"),
        () => "ATR(14) as a share of the last price",
        "tb-stat-atr",
      ),
    ),

    /* The hairline, not the spacer: what you are looking at on the left of it,
       what you can change about it on the right. See `.tb-sep` in topbar.css. */
    h("div", { class: "tb-sep", "aria-hidden": "true" }),

    h(
      "div",
      { class: "tf-group", role: "group", "aria-label": "Timeframe" },
      ...tfSplit().visible.map((tf) =>
        h("button", {
          class: "tf-btn",
          type: "button",
          text: tf,
          "aria-pressed": () => String(shownTimeframe() === tf),
          onclick: () => setShownTimeframe(tf),
        }),
      ),
      /* The ends of the ladder. Names the timeframe when it is one of them, so
         the row always says what is on the chart. */
      asMenuTrigger(
        h(
          "button",
          {
            class: "tf-btn tf-more",
            type: "button",
            title: "More timeframes",
            "aria-pressed": () => String(tfSplit().moreCurrent !== null),
          },
          h("span", { text: () => tfSplit().moreCurrent ?? "More" }),
          caret(),
        ) as HTMLButtonElement,
        {
          ctx: menuCtx,
          placement: "bottom-end",
          items: () => tfSplit().more.map((tf): MenuItem => ({ id: `market.tf.${tf}` })),
        },
      ),
    ),

    /* Six styles behind one pill. The pill's title carries the current style's
       hint, because Heikin's warning has to be readable where it is chosen. */
    asMenuTrigger(
      h(
        "button",
        {
          class: "tool-btn wide tb-pill tb-style",
          type: "button",
          title: () => `Chart style — ${currentStyle().hint}`,
          "aria-label": () => `Chart style: ${currentStyle().label}`,
        },
        h("span", { class: "tb-pill-label", text: () => currentStyle().label }),
        caret(),
      ) as HTMLButtonElement,
      {
        ctx: menuCtx,
        items: () => CHART_STYLES.map((st): MenuItem => ({ id: `chart.kind.${st.id}`, label: st.label })),
      },
    ),

    indicatorsBtn,
    autoMarkBtn,

    /*
     * THE SPACER, AND WHY IT IS HERE RATHER THAN BESIDE THE PRICE.
     *
     * It used to sit immediately after the quote, so the row was two clusters
     * with everything between them: MEASURED on a 1524px chart column, the
     * price ended at x=567 and the timeframes began at x=934 — 367px of empty
     * band across the top of the chart, made worse by the fit loop, which had
     * already hidden the range stats to make room the row did not need. That
     * is the "empty space" in the owner's screenshot.
     *
     * The approved mockup (`docs/iram-redesign-v5.html`, `.ctb`) puts its
     * spacer AFTER auto-marking, so the symbol, the price, the timeframes and
     * the three pills read as one left-hand group and only the view actions —
     * Fit, Log, Replay, the overflow and the feed badge — are anchored right.
     * Same rule as before ("what you are looking at" left, "what you can
     * change about it" right); the boundary is just in the right place now.
     */
    h("div", { class: "topbar-spacer" }),

    h(
      "div",
      { class: "topbar-actions", role: "group", "aria-label": "View" },
      /* v59.2 — Fit and Log, labelled, as in the v5 toolbar. Fit is the
         engine's goLive(): back to the newest bars with the price axis
         fitted again. Log is the same switch as the "lin/log" corner. */
      h("button", {
        class: "tool-btn tb-fit",
        type: "button",
        text: "Fit",
        title: "Back to the latest bars, price axis fitted",
        onclick: () => chart?.goLive(),
      }),
      h("button", {
        class: "tool-btn tb-log",
        type: "button",
        text: "Log",
        title: "Logarithmic price axis",
        "aria-pressed": () => String(state.priceScale() === "log"),
        onclick: () => state.priceScale.set(state.priceScale() === "log" ? "linear" : "log"),
      }),
      h(
        "button",
        {
          class: "tool-btn wide",
          type: "button",
          title: "Step through history bar by bar. Nothing downstream can see past the cursor.",
          "aria-pressed": () => String(replay.active()),
          onclick: () => (replay.active() ? replay.stop() : replay.start()),
        },
        icon("stepForward"),
        h("span", { text: () => (replay.active() ? "Replaying" : "Replay") }),
      ),
      overflowBtn,
    ),

    h(
      "div",
      { class: "feed-badge", "data-feed": () => feed.state().quality },
      h("span", { class: "feed-dot", "data-feed": () => feed.state().quality }),
      h("span", { text: () => qualityLabel(feed.state().quality) }),
      h("span", { class: "feed-note", text: () => feed.state().note }),
    ),

    /* The two panels opened from menu rows. Fixed-positioned, so where they
       sit in the DOM does not decide where they draw. */
    detectPop.host,
    studyPop.host,
  );

  /**
   * The symbol box becomes a real picker.
   *
   * It searches the SAME catalogue the command palette does — every pair the
   * venue lists, ranked by 24-hour volume — rather than a second, smaller list
   * that would drift out of step with it. The box previously offered no hint
   * that anything could be searched, which is most of why "I cannot change the
   * currency pair" is a thing anyone has to say about a terminal that can in
   * fact quote several thousand of them.
   */
  /**
   * Settings.
   *
   * Built from a schema rather than laid out by hand, so adding a preference is
   * adding a definition. Every entry reads and writes state that already exists
   * — this screen owns no values of its own, which is the whole point after the
   * equity defect. See `settings/defs.ts`.
   */
  const settings = lazyDesk(() => createSettings({
    sections: SECTIONS,
    settings: buildSettings({
      account,
      /* The SAME signal the chart renders from, not a copy — a period changed
         in Settings is the period the next repaint uses. */
      studyParams: state.studyParams,
      symbol: () => state.symbol(),
      rules: () => rules(),
      setRule: setRules,
      resetRules: () => {
        rules.set(DEFAULT_RULES);
        kv.write(RULES_SLOT, DEFAULT_RULES);
      },
      exitRules: () => exitRules(),
      setExitRule,
      resetExitRules: () => setExitRule(DEFAULT_EXIT_RULES),
      /**
       * Read fresh each time the panel is built, so a source the breaker parked
       * two minutes ago is described as parked rather than as healthy. The
       * breaker's state and the user's switch are reported separately because
       * they mean different things — one is a failure that clears itself, the
       * other is a decision that does not.
       */
      sources: () =>
        feed.registry.sources.map((src, i) => ({
          id: src.id,
          label: src.label,
          covers: src.covers,
          quality: src.quality,
          /* The POSITION in the failover order, one-based — not the raw
             `priority` field. Priorities are sparse (0,1,2,3,4,9) because they
             encode intent with room to insert between them, so showing them
             directly produced "tried 0th" for the source that is tried first
             and "tried 9th" for the sixth of six. */
          priority: i + 1,
          enabled: !feed.registry.isDisabled(src.id),
          parked: feed.registry.breaker.isOpen(src.id),
        })),
      sourceEnabled: (id) => !disabledSources().includes(id),
      setSourceEnabled: (id, on) => {
        const next = new Set(feed.registry.disabledIds());
        if (on) next.delete(id);
        else next.add(id);
        feed.registry.setDisabled(next);
        disabledSources.set([...next]);
      },
      sessionBands: state.sessionBands,
      gridOn: state.gridOn,
      candleUp: state.candleUp,
      candleDown: state.candleDown,
      /* The picker has to show the colour the chart is PAINTING with, not the
         override — which is empty until someone picks one. `effectiveColour`
         resolves through the theme, so an untouched setting opens on the real
         green rather than on black. */
      effectiveCandle: (which: "up" | "down") => {
        const raw = which === "up" ? state.candleUp() : state.candleDown();
        return readColour(raw) ?? effectiveColour(which);
      },
      volumeOn,
      evidenceAuto,
      volumeHeight: () => volumeHeight(),
      setVolumeHeight,
      theme: state.theme as unknown as Signal<string>,
      themes: THEMES,
      density: state.density as unknown as Signal<string>,
      densities: DENSITIES,
      accent,
      accents: ACCENTS,
      /* The three layout preferences the Appearance presets write. They are
         existing signals; the preset applies through the same ones the
         individual settings use, never a parallel path. */
      watchRail: railOn,
      newsBar: newsOn,
      dockOpen: dockToggle,
      defaultTimeframe: state.timeframe,
      timeframes: TIMEFRAMES,
      chartKind: state.chartKind as unknown as Signal<string>,
      chartKinds: ["candles", "hollow", "heikin", "bars", "line", "area"],
      alertSound,
      alertDesktop,
      durability: {
        state: durability.state,
        note: durability.note,
        remedy: durability.remedy,
      },
      storageBytes: () => kv.stats().bytes,
      feedNote: () => {
        const f = feed.state();
        return `${f.source} · ${qualityLabel(f.quality)}${f.note ? ` — ${f.note}` : ""}`;
      },
      version: `IRAM terminal v${__APP_VERSION__}`,
      openKeyboardSheet: () => openShortcutSheet(keymap, commands),
      openNotificationLog: () => deps.openNotifications(),
      exportVault: () => commands.run("file.exportSettings"),
      resetGovernor: () => commands.run("net.reset"),
    }),
    footerNote: () =>
      durability.state === "durable"
        ? "Stored on this browser. Changes apply immediately."
        : "Changes apply immediately — but see Data & storage, they may not survive a reload.",
  }));

  /**
   * Mark the context bar while it actually overflows.
   *
   * Drives the fade in shell.css. Without it the row hides its scrollbar and
   * cuts the last group mid-word, which reads as broken rather than as
   * scrollable — the controls were always reachable, but nothing said so.
   *
   * FITTED FIRST, SCROLLED LAST. The row's width is the chart column's, not
   * the window's — the dock takes its share — so a viewport media query
   * cannot know when to shed anything. MEASURED at 1600px with the dock open:
   * 1,208px of row for 1,398px of content. Each `data-fit` step sheds
   * something every figure of which is also elsewhere (the range stats, then
   * the pill words), and only if the tightest step still overflows does the
   * row scroll under the fade. One forced layout per step, three at most, on
   * resize only. The quote and the feed badge are observed too, because their
   * text — not the window — is what grows.
   */
  if (typeof ResizeObserver === "function") {
    /* v59.2 adds "tighter" and "tightest" (styles/topbar.css): with the
       v5 toolbar's Auto-marking, Fit and Log the row needed 1,227px and got
       802 at 1440 with the watchlist rail on. Same loop, two more steps. */
    /*
     * SIX RUNGS, NOT FIVE (v60.1), and the reason is a measurement.
     *
     * The loop walks down until the row stops overflowing, so a rung that
     * sheds more than the row is short by leaves the difference as empty
     * band. MEASURED at a 1282px chart column, with the old five:
     *
     *     full      overflows by 289
     *     compact   overflows by 2      <- two pixels
     *     tight     293 to spare
     *
     * Two pixels short of fitting, so it took a step that gave up 291 more
     * than it needed, and the row carried 293px of nothing across the top of
     * the chart. That is the empty space in the owner's screenshot, and the
     * cause is a rung that sheds three things at once rather than a loop that
     * chose wrongly. The range stats now leave one reading at a time — see
     * the ladder in styles/topbar.css, where each rung names its cost.
     */
    const FIT_STEPS = ["full", "compact", "snug", "tight", "tighter", "tightest"] as const;
    const overflows = (): boolean => topbar.scrollWidth > topbar.clientWidth + 1;
    const markOverflow = (): void => {
      topbar.setAttribute("data-overflow", String(overflows()));
    };
    const fitRow = (): void => {
      if (topbar.clientWidth === 0) return; /* Not laid out, or a desk without it. */
      for (const step of FIT_STEPS) {
        topbar.setAttribute("data-fit", step);
        if (!overflows()) break;
      }
      markOverflow();
    };
    const ro = new ResizeObserver(fitRow);
    ro.observe(topbar);
    for (const el of topbar.querySelectorAll(".tb-quote, .feed-badge")) ro.observe(el);
    topbar.addEventListener("scroll", markOverflow, { passive: true });
    fitRow();
  }

  const symbolInput = symbolInputRef.el;
  if (symbolInput) {
    /**
     * The tabs, which used to be quote currencies and are now asset classes.
     *
     * WHAT WAS WRONG WITH QUOTE CURRENCIES
     * USDT / USDC / BTC / ETH / Other is a fact about crypto pairs and a
     * category error for everything else. EURUSD quotes in USD, which was not a
     * tab; USDJPY matched no quote suffix at all and landed in "Other" beside
     * whatever the exchange had not classified. The five forex instruments the
     * catalogue carried were all reachable and none of them was findable —
     * which is what "I cannot see the forex pairs" was describing.
     *
     * Class is the split a person actually thinks in, and it costs nothing:
     * `risk/instruments.ts` has tagged the whole table with it since long
     * before the picker asked.
     */
    const SYMBOL_TABS = CLASS_TABS.map((t) => ({ id: t.id, label: t.label }));

    const inTab = (entry: SymbolEntry, tab: string | null): boolean =>
      tab === null || classTab(entry.cls) === tab;

    const pool = (tab: string | null) =>
      tab === null ? catalogue.symbols() : catalogue.symbols().filter((e) => inTab(e, tab));

    const picker = createSymbolPicker({
      input: symbolInput,
      current: () => shownSymbol(),
      filters: SYMBOL_TABS,
      total: (tab) => pool(tab).length,
      search: (query, limit, tab) =>
        rankSymbols(pool(tab), query, limit).map((r) => ({
          symbol: r.item.symbol,
          detail:
            r.item.symbol === shownSymbol()
              ? "on screen"
              : r.item.volume > 0
                ? `${abbreviate(r.item.volume)} 24h`
                : /* No volume is known for an instrument-table entry, so the
                     right-hand column carries its name instead of a blank.
                     "Gold" beside XAUUSD is the more useful column anyway. */
                  (r.item.name ?? ""),
        })),
      commit: (symbol) => setShownSymbol(symbol),
      /* A refused entry is explained, never swallowed. Silently reverting the
         box is what made this control feel broken in the first place. */
      reject: (typed, reason) =>
        toaster.push({
          level: "warn",
          key: "symbol-rejected",
          title: `Not loaded: ${typed || "(empty)"}`,
          body: reason,
        }),
    });
    symbolInput.parentElement?.appendChild(picker.el);
    /* The list is only as good as the catalogue, and the catalogue is lazy. */
    catalogue.ensure();
  }

  // -------------------------------------------------------- command bar ---
  //
  // Lifted to `./shell/commandbar.ts`: one element out, five siblings in.

  const { commandbar } = createCommandBar(ctx, {
    appMenu,
    askAgent,
    dockToggle,
    settings,
    palette,
    broker,
    /* The dock's cards are built further down; this runs at click time. */
    revealCard: (id: string) => {
      state.view.set("chart");
      dockCards.reveal(id);
    },
  });
  // --------------------------------------------------------------- main ---

  const legend = h("div", { class: "legend" });

  /**
   * The desks that need nothing from the shell but the chart's bars, the
   * operator's rules, the knowledge base, the analyst and the workspace's
   * series — `./shell/desks.ts`. Briefing and Alerts stay here: each reads a
   * dozen shell-owned signals, which is the reason they are not in that file.
   */
  /**
   * The strategies the terminal found by itself.
   *
   * Built HERE, above the desks, because two things read it: the Strategy
   * desk's Autonomous mode, which writes survivors to it, and the AI
   * recommendation card, which asks whether any of them fires on this bar.
   * One store, one signal — a second reader of `DISCOVERED_SLOT` would hold
   * its own snapshot and go on calling a promoted strategy unproven.
   */
  const shelf = createShelfStore(kv);

  /**
   * ONE SEARCH, for the same reason there is one shelf.
   *
   * The Strategy desk's Autonomous tab and the inspector's recommendation card
   * both start sweeps. Two drivers would be two runs competing for one worker
   * pool, charging the best-of-N hurdle twice for a field tested once, and
   * racing each other into `shelf.addAll`. The driver owns `running`, so the
   * second request is refused rather than queued.
   *
   * Built here rather than inside the Strategy desk because that desk is lazy
   * — asking it for a driver would construct its whole DOM at boot for a card
   * that only wants to call `run`.
   */
  /**
   * Whether an unsearched market is searched without being asked.
   *
   * Persisted, and ON by default: the owner chose automatic-on-first-open after
   * being shown what a sweep costs. The switch is rendered on the card itself
   * rather than buried in Settings, because it governs something that spends
   * thirty seconds of this machine's CPU unbidden.
   */
  const autoSearchRev = signal(0);
  const autoSearch = boolSignal(
    /* kv reads are not reactive; this ticks after every write. */
    () => {
      autoSearchRev();
      return kv.get(AUTO_SEARCH_SLOT);
    },
    (v) => {
      kv.write(AUTO_SEARCH_SLOT, v);
      autoSearchRev.update((n) => n + 1);
    },
  );

  /**
   * ENROL THE LIBRARY, ONCE, AT BOOT.
   *
   * The server's `bars_loop` keeps series current with the terminal closed —
   * which is the whole reason the durable archive exists — but it reads its
   * list from a config key that NOTHING WROTE. It ran hourly and did nothing:
   * a component that reports a healthy tick and produces no work, which is the
   * hardest kind of dead to notice.
   *
   * The list is the macro spine plus whatever is on the watchlist, computed in
   * `data/library.ts` and pushed from here. Fire-and-forget: a gateway that is
   * not running is the ordinary case for anyone who opened the built page
   * directly, and the browser's own archive is unaffected either way.
   */
  void pushEnrolment(enrolledSeries(watchedSymbols(kv)));

  const sweepDepth = signal(5000);
  /* What earlier searches found, so a market is not re-studied for an answer
     that has not changed — `backtest/sweepcache.ts`. */
  const sweepCache = createSweepCache(kv);
  const sweep = createSweepDriver({
    shelf,
    cache: sweepCache,
    load: (symbol, timeframe, hooks) =>
      loadStudyBars(feed.history, symbol, timeframe, sweepDepth.peek(), () => bars.peek(), hooks),
    /* The costs the Strategy desk's Backtest card sets are its own; a search
       started from the inspector has no card to read, so it uses the engine's
       stated defaults and the row it saves records which were charged. */
    costs: () => DEFAULT_COSTS,
    riskPerTrade: () => account.effective().riskPct / 100,
    excludedFor: (sym, tf) =>
      shelf
        .rows()
        .filter((d) => d.status === "retired" && d.symbol === sym && d.timeframe === tf)
        .map((d) => d.spec.id),
  });

  const desks = createDesks(ctx, { bars, rules, knowledgeBase, analyst, workspaceSeries, shelf, sweep, sweepDepth });
  const { flow, data, strategy, survey, study, playbook, simulation, sessions, smartMoney, paper, knowledge, watchlist, system, connections } =
    desks;
  agentDesk = desks.agentDesk;

  /**
   * The Briefing — the front door (v56).
   *
   * Built on first open like every other desk, and that is what lets it read
   * `setupView`, `liveEvents` and `railSetups`, all of which are declared
   * BELOW this line. A thunk is not evaluated until the view is opened, by
   * which point every binding in this closure is initialised — the reason
   * `lazyDesk` exists, stated in shell/context.ts.
   *
   * It is handed the owners themselves, never copies: `riskDesk.positions`,
   * the alert store's own log, the Setup card's own view model. The desk
   * states no figure it did not get from one of them.
   */
  const briefing = lazyDesk(() =>
    createBriefing({
      symbol: state.symbol,
      timeframe: state.timeframe,
      account,
      positions: openBook,
      setup: setupView,
      events: liveEvents,
      fires: alertStore.log,
      opportunities: railSetups,
      /* The screener's own probe, passed as the function it is. `lazyDesk`
         backs `built()` with a SIGNAL precisely so a reader re-runs once the
         desk exists; calling it here and passing the boolean would leave the
         card saying "not run" for the whole session. */
      scanned: screener.built,
      regime,
      nowMs,
      /* Picking one puts it on the chart. "Where else to look" that leaves you
         on the same screen has not answered itself. */
      onPick: (sym) => {
        setShownSymbol(sym);
        state.view.set("chart");
      },
      onOpen: (view) => state.view.set(view),
      /* v59.2 Today: "Ask a follow-up", the focus list's watchlist fallback,
         the last Opportunities scan (only once that desk exists — building it
         here would start a scan nobody asked for), and the shell's KV. */
      onAsk: askAgent,
      watchlist: () => watchlist().list(),
      scanRows: () => (screener.built() ? screener().rows() : []),
      kv,
    }),
  );

  const alerts = lazyDesk(() => createAlerts({
    symbol: state.symbol,
    timeframe: state.timeframe,
    data: detectData,
    detections: alertDetections,
    closedCount: closedBarCount,
    store: alertStore,
    sound: alertSound,
    desktop: alertDesktop,
  }));

  /**
   * The pass that makes alerts real.
   *
   * Runs on every change to the closed-bar set, on every desk, whether or not
   * the Signals view is mounted. The store de-duplicates by (alert, bar time),
   * so re-walking all of history each pass is free of consequence.
   *
   * The FIRST pass is silent. A book of alerts loaded against six months of
   * bars legitimately produces dozens of historical fires; announcing them
   * would be a notification storm describing things that happened in March.
   */
  let alertsPrimed = false;
  effect(() => {
    const data = detectData();
    const dets = alertDetections();
    const n = closedBarCount();
    /**
     * Read the book itself, not just the data.
     *
     * `alertDetections` usually returns the very array `detections` produced,
     * and a computed compares by identity — so adding an alert changed the book
     * without changing any value this effect could see, and the new alert was
     * never evaluated. It sat in storage, correct and invisible. Depending on
     * the specs directly is what makes a newly added alert appear at once.
     */
    alertStore.specs();
    // Reading symbol/timeframe keeps the pass re-priming when the context
    // changes, so switching symbol does not announce that symbol's history.
    const sym = state.symbol();
    const tf = state.timeframe();
    if (!data || n === 0) return;

    const fresh = untrack(() =>
      alertStore.evaluate({ symbol: sym, timeframe: tf, data, detections: dets, closedCount: n }),
    );
    if (!alertsPrimed) {
      alertsPrimed = true;
      return;
    }
    if (fresh.length > 0) {
      deliver(fresh, { sound: alertSound.peek(), desktop: alertDesktop.peek(), symbol: sym });
    }
  });

  // Changing symbol or timeframe means a different book against different
  // bars: prime it again rather than announcing the new context's history.
  effect(() => {
    state.symbol();
    state.timeframe();
    alertsPrimed = false;
  });

  /**
   * The drawer under the chart — Objects, Ask the AI, Positions, Alerts log
   * (`./chartdrawer.ts`). Collapsed to one row by default. The Ask tab uses
   * the SAME analyst session as the Analyst desk, so a question asked here is
   * in the desk's transcript too.
   */
  const chartDrawer = createChartDrawer({
    open: state.chartDrawerOpen,
    tab: state.chartDrawerTab,
    symbol: () => state.symbol(),
    timeframe: () => state.timeframe(),
    detectors: state.detectors,
    detections: () => detections(),
    drawStore,
    session: analyst.session,
    onOpenAnalyst: () => askAgent(),
    broker,
    fmtPx,
    providerNote: analyst.providerFallback,
  });

  const main = h(
    "main",
    { class: "main" },
    h(
      "div",
      {
        class: "chart-wrap",
        // The chart is never unmounted when another view is shown: tearing down
        // the canvas would drop its context and force a full reload of history
        // on the way back. Hiding it keeps the engine warm and the return
        // instant — the same reasoning as focus mode collapsing tracks to zero
        // rather than display:none.
        "data-hidden": () => String(state.view() !== "chart"),
        // Replay owns the bottom strip while it is on: the two control clusters
        // stacked on top of each other made both unreadable.
        "data-replay": () => String(replay.active()),
      },
      /**
       * The chart toolbar.
       *
       * It used to be a floating panel over the top-left of the chart, and it
       * was wrong for two reasons that compound: it covered the price action it
       * was there to annotate, and it was the only floating thing on a screen
       * of docked panels, so it read as something that had come loose rather
       * than as part of the application.
       *
       * Now it is a strip along the top of the chart area, in the flow, holding
       * everything that puts a MARK on the chart — the drawing tools, the
       * detectors, the studies. Nothing overlapping the candles.
       *
       * The view actions that used to end this row — Replay, Live edge,
       * Reload, Export — moved up to the context bar, which had 994px of empty
       * space and is the bar that already says which series you are looking
       * at. They change the window, not the annotations, so they were the odd
       * half of a row with two jobs.
       */
      h(
        "div",
        { class: "chart-toolbar", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Chart tools" },

        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Select and move (Esc)",
          "aria-label": "Select and move",
          "aria-pressed": () => String(drawTool() === null),
          onclick: () => drawTool.set(null),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("cursor")),
        }),

        h("span", { class: "tool-sep" }),

        ...DRAW_KINDS.map((k) =>
          h("button", {
            class: "tool-btn",
            type: "button",
            title: `${k.label} — ${k.hint}`,
            "aria-label": k.label,
            "aria-pressed": () => String(drawTool() === k.id),
            onclick: () => drawTool.update((cur) => (cur === k.id ? null : k.id)),
            ref: (el: HTMLButtonElement) => el.appendChild(icon(DRAW_ICON[k.id])),
          }),
        ),

        h("span", { class: "tool-sep" }),

        /* The volume band's on/off. It sits with the chart actions rather than
           in a menu because it is a thing you flip while looking at the chart,
           and because for two versions there was no way to flip it at all. */
        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Volume pane (V) — drag its top edge to resize, double-click to reset",
          "aria-label": "Volume pane",
          "aria-pressed": () => String(volumeOn()),
          onclick: () => volumeOn.update((v) => !v),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("volume")),
        }),

        /**
         * Auto-detect, beside the pen rather than four panels down the dock.
         *
         * Same row as the drawing tools because it is the same job — putting
         * marks on the chart — and because the dock it used to live in is
         * closed about half the time, which made the detectors invisible.
         *
         * A popover rather than an inline strip: six toggles, a higher-
         * timeframe row and a pin button do not fit in a toolbar without
         * pushing the drawing tools off the end, and the toolbar's job is to
         * stay one uncrowded row.
         */
        h("span", { class: "tool-sep" }),

        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Magnet — snap to the nearest open, high, low or close (M)",
          "aria-label": "Magnet",
          "aria-pressed": () => String(drawMagnet()),
          onclick: () => drawMagnet.update((v) => !v),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("magnet")),
        }),
        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Undo (Ctrl+Z)",
          "aria-label": "Undo",
          disabled: () => !drawStore.canUndo(),
          onclick: () => drawStore.undo(),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("undo")),
        }),
        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Redo (Ctrl+Shift+Z)",
          "aria-label": "Redo",
          disabled: () => !drawStore.canRedo(),
          onclick: () => drawStore.redo(),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("redo")),
        }),
        h("button", {
          class: "tool-btn",
          type: "button",
          title: "Delete selected (Del)",
          "aria-label": "Delete selected drawing",
          disabled: () => drawLayer?.selected() === null,
          onclick: () => drawLayer?.deleteSelected(),
          ref: (el: HTMLButtonElement) => el.appendChild(icon("trash")),
        }),

      ),
      /**
       * The chart body.
       *
       * A positioning context of its own, BELOW the toolbar. The canvas, the
       * legend, the empty state and the replay bar are all absolutely
       * positioned inside it — without this wrapper they position against
       * `.chart-wrap` and paint over the toolbar, which is exactly what
       * happened the first time.
       */
      /* v59.2: the chart body and the drawer under it, as one column, so the
         drawer spans the chart and not the tool rail beside it. */
      h(
        "div",
        { class: "chart-col" },
      h(
        "div",
        { class: "chart-body" },
        h("div", {
          class: "chart-host",
          ref: (el: HTMLDivElement) => {
            chartHost = el;
          },
        }),
        /**
         * The volume band's drag handle.
         *
         * Sits ON the boundary the engine reports rather than at a constant
         * offset, so it cannot drift out of step with the band it resizes. The
         * band had no controls at all before this: `setVolume` was implemented
         * and called from nowhere, and the height was a `static readonly` read
         * directly in three places — so it could not be closed, enlarged or
         * resized, exactly as reported.
         */
        h("div", {
          class: "vol-resizer",
          role: "separator",
          "aria-label": "Resize the volume pane",
          "aria-orientation": "horizontal",
          title: "Drag to resize the volume pane · double-click to reset · V hides it",
          ref: (el: HTMLElement) => { volResizer = el; },
          onpointerdown: startVolumeResize,
          ondblclick: () => setVolumeHeight(ChartEngine.VOLUME_H),
        }),
        legend,
      /**
       * The price-scale switch, at the foot of the price gutter.
       *
       * Placed ON the axis it changes rather than in the toolbar, because that
       * is the only place it is unambiguous which of the two axes it applies
       * to — and because it is where the hand already is after dragging the
       * scale. Every terminal that has this puts it here.
       */
      /* Says the chart is reaching further back, at the edge it is reaching
         from. A fetch with no visible sign of itself is indistinguishable from
         a chart that has simply stopped having data — which is the exact
         confusion this whole feature exists to remove. */
      h("div", {
        class: "history-pending",
        "data-on": () => String(olderPending()),
        text: "loading history…",
        "aria-live": "polite",
      }),
      h("button", {
        class: "scale-toggle",
        type: "button",
        text: () => (state.priceScale() === "log" ? "log" : "lin"),
        "data-on": () => String(state.priceScale() === "log"),
        title:
          "Price axis: linear gives equal height to equal DOLLAR moves, log to equal PERCENTAGE moves. Log is the one trend lines and channels assume.",
        "aria-label": "Toggle logarithmic price scale",
        onclick: () => state.priceScale.set(state.priceScale() === "log" ? "linear" : "log"),
      }),
      h("div", {
        class: "chart-empty",
        "data-show": () => String(bars().length === 0),
        text: () => (loading() ? "Loading…" : "No data. Pick a source below."),
      }),
      /**
       * Replay controls.
       *
       * Deliberately on the chart rather than in a desk: replay is a mode the
       * whole terminal is in, and a mode you can forget you are in is one that
       * will eventually have you reading a two-week-old alert as live. The bar
       * is visible for as long as the mode is.
       */
      h(
        "div",
        { class: "replay-bar", "data-on": () => String(replay.active()) },
        h("span", { class: "replay-tag", text: "REPLAY" }),
        h("button", {
          class: "ghost-btn tiny",
          title: "Back 10 bars",
          "aria-label": "Back 10 bars",
          ref: (el: HTMLButtonElement) => el.appendChild(icon("jumpBack")),
          onclick: () => replay.step(-10),
        }),
        h("button", {
          class: "ghost-btn tiny",
          title: "Back one bar",
          "aria-label": "Back one bar",
          ref: (el: HTMLButtonElement) => el.appendChild(icon("stepBack")),
          onclick: () => replay.step(-1),
        }),
        h("button", {
          class: "ghost-btn tiny",
          title: "Play / pause",
          "aria-label": "Play or pause the replay",
          ref: (el: HTMLButtonElement) => {
            renderEffect(() => {
              clear(el);
              el.appendChild(icon(replay.playing() ? "pause" : "play"));
            });
          },
          onclick: () => replay.toggle(),
        }),
        h("button", {
          class: "ghost-btn tiny",
          title: "Forward one bar",
          "aria-label": "Forward one bar",
          ref: (el: HTMLButtonElement) => el.appendChild(icon("stepForward")),
          onclick: () => replay.step(1),
        }),
        h("button", {
          class: "ghost-btn tiny",
          title: "Forward 10 bars",
          "aria-label": "Forward 10 bars",
          ref: (el: HTMLButtonElement) => el.appendChild(icon("jumpForward")),
          onclick: () => replay.step(10),
        }),
        h("input", {
          class: "replay-scrub",
          type: "range",
          min: "0",
          step: "1",
          max: () => String(Math.max(1, feed.bars().length)),
          value: () => String(replay.cursor()),
          oninput: (e: Event) => replay.cursor.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("span", {
          class: "replay-pos num",
          // The date, not just the index: "bar 412" tells you nothing about
          // where in the market's history you are standing.
          text: () => {
            const list = bars();
            const last = list[list.length - 1];
            const when = last ? new Date(last.t).toISOString().slice(0, 16).replace("T", " ") : "—";
            return `${replay.cursor()} / ${feed.bars().length} · ${when}`;
          },
        }),
        h("button", {
          class: "ghost-btn tiny",
          text: "Exit",
          onclick: () => replay.stop(),
        }),
      ),
      ),
        chartDrawer,
      ),

    ),

    h(
      "div",
      { class: "view-slot", "data-hidden": () => String(state.view() === "chart") },
      () => {
        const view = state.view();

        /**
         * THE DEAD-ZONE GATE. Do not remove it to "simplify" this switch.
         *
         * This callback is a render effect and it runs DURING `mountShell`,
         * at this position in the file. Three desks — journal, quant, learn —
         * are constructed four hundred lines further down, so if the saved
         * view is one of those, this branch reads a `const` that has not been
         * initialised yet. `createReaction` swallows the ReferenceError, the
         * effect dies, and the desk never renders at all.
         *
         * MEASURED, not theorised: with `view: "quant"` in saved preferences,
         * a reload produced an empty `.view-slot`, no `.qd` in the document,
         * and `Cannot access 'quantDesk' before initialization` as the only
         * trace — in a log nobody reads, because the terminal otherwise looked
         * fine. Anyone who closed the terminal on the Journal or Quant desk
         * reopened it to a blank page.
         *
         * It survived because the DEFAULT view is `chart`, which returns
         * before touching any of them, so it only ever fired for somebody who
         * had left the terminal somewhere else — and it left nothing on screen
         * to report.
         *
         * The gate makes the dependency explicit instead of accidental: while
         * the desks are still being built this renders nothing, and flipping
         * `desksReady` re-runs the effect once they exist. Ordinary reactivity
         * doing what a hand-maintained declaration order was failing to do.
         */
        if (!desksReady()) return document.createComment("desks not built yet");

        if (view === "briefing") return briefing().el;
        if (view === "screener") return screener().el;
        if (view === "flow") return flow().el;
        if (view === "signals") return alerts().el;
        if (view === "strategy") return strategy().el;
        if (view === "study") return study().el;
        if (view === "survey") return survey().el;
        if (view === "connections") return connections().el;
    if (view === "knowledge") return knowledge().el;
        if (view === "playbook") return playbook().el;
        if (view === "simulation") return simulation();
        if (view === "sessions") return sessions().el;
        if (view === "watchlist") return watchlist().el;
        if (view === "paper") return paper().el;
        if (view === "journal") return journalDesk().el;
        if (view === "quant") return quantDesk();
        if (view === "learn") return learnDesk().el;
        if (view === "smart") return smartMoney().el;
        if (view === "data") return data.el;
        if (view === "system") return system().el;
        if (view === "agent") return agentDesk ? agentDesk.el : document.createComment("");
        if (view === "workspace") return workspace.el;
        if (view === "risk") return riskDesk.el;
        if (view === "calculator") return calculator().el;
        if (view === "decision") return decisionDesk().el;
        /* Every view in VIEWS now has a real desk. An id that reaches here is a
           bug in the view list rather than a feature awaiting a port, so it
           renders nothing rather than an "unported" panel that would be a lie. */
        return document.createComment(`no desk for view "${view}"`);
      },
    ),

    h("div", {
      class: "dock-resizer",
      onpointerdown: startDockResize,
    }),
  );

  // --------------------------------------------------------------- dock ---

  /**
   * The Setup card's view — `ui/model/setup.ts`.
   *
   * Composition, not analysis: the read, the chosen setup, the plan, the
   * size, the gates and the replayed base rate, assembled into the one object
   * the card, the dock verdict and the expert all read. `setupLast` is what
   * that pass last decided — the chosen field, the replay, its R and the
   * second opinion — for the readers that need more than the view.
   */
  const { view: setupView, last: setupLast } = createSetupModel(ctx, {
    decisionSection,
    detections,
    detectData,
    journal,
    learn,
    knowledgeBase,
    deepReplay,
    replay,
    rules,
    exitRules,
    studies,
    riskDesk,
    openBook,
    calendar,
    intelBusy,
    evidenceStatus,
    nowMs,
  });

  /**
   * Constructed HERE, below `setupView`, and that position is load-bearing.
   *
   * `createJournalDesk` renders once at construction, and its `context()`
   * reads `setupView()`. Built up beside the other
   * desks — which is where it naturally belongs — that first render runs
   * before either exists and throws `Cannot access 'setupView' before
   * initialization`, which kills the effect and, because effects are shared,
   * takes a good deal else with it. TypeScript cannot see this: both are
   * in scope, just not yet initialised.
   *
   * The view slot above refers to `journalDesk` from inside a reactive child,
   * which is evaluated on the next frame rather than eagerly, so a reference
   * appearing earlier in the file than this declaration is fine.
   */
  /**
   * The Journal desk.
   *
   * `context()` reads the SAME view the Setup card renders, so a trade
   * recorded here carries the setup, score and gate state the card was showing
   * at that moment rather than a second, subtly different derivation of them.
   */
  const journalDesk = lazyDesk(() => createJournalDesk({
    journal,
    /* v59.2 Review: judgements and rules persist in the shell's KV; the news
       check reads the same calendar the inspector shows. */
    kv,
    calendar,
    context: () => {
      const v = setupView();
      const d = decision();
      return {
        symbol: state.symbol(),
        timeframe: state.timeframe(),
        direction: (v?.plan?.direction ?? (d && d.bias === "short" ? "short" : "long")) as
          | "long"
          | "short",
        entry: v?.plan?.entry ?? null,
        stop: v?.plan?.stop ?? null,
        target: v?.plan?.target1 ?? null,
        /* The SAME setup the card chose, not a second opinion. A journal entry
           whose setupKind disagrees with the card that produced it corrupts the
           record the engine later ranks on. */
        setupKind: v?.verdict.strategy ?? null,
        score: d ? Math.round(Math.abs(d.score) * 100) : null,
        gatesBlocking: (v?.gates ?? []).filter((g) => g.status === "block").map((g) => g.text),
        /* Recorded so a trade taken on a delayed or cached feed can be told
           apart later from one taken on a live one. That difference shows up
           in the fills long before it shows up in the statistics. */
        source: feed.activeSource(),
        quality: feed.streamStatus(),
      };
    },
    price: () => {
      const list = bars();
      const last = list[list.length - 1];
      return last ? last.c : null;
    },
    notify: (level, title, body) => toaster.push({ level, title, body }),
  }));

  /**
   * The Quant desk.
   *
   * Declared after `journalDesk` because it reads the journal, and after
   * `setupView` for the same temporal-dead-zone reason spelt out above — the
   * desk renders at construction, so anything it reads must already exist.
   *
   * The confounders handed to the causal endpoint are the ones the journal
   * ACTUALLY records at entry time: the confluence score, the setup kind and
   * the hour. Not the regime, which would be the better adjustment and is not
   * stored — deriving it now from today's bars would be adjusting for a
   * condition measured after the fact, which is worse than not adjusting.
   */
  const quantDesk = lazyDesk(() => createQuantDesk({
    symbol: () => state.symbol(),
    timeframe: () => state.timeframe(),
    bars: () => bars(),
    /* Empty when the series has not loaded, so the panel can count how many
       drivers it is actually missing rather than fitting on whatever arrived. */
    driverBars: (sym: string) => driverBars().get(sym) ?? [],
    ensureDrivers: () => loadDrivers(),
    /* Every finished fit is kept, so the Learning desk can answer "does it
       still say what it said last time" — which is the only question about a
       model that a fresh score cannot answer for itself. */
    keep: (r) => {
      learn.addRun(r);
    },
    returns: () =>
      journal
        .entries()
        .filter((e) => e.closedAt !== null)
        .sort((a, b) => (a.closedAt as number) - (b.closedAt as number))
        .map((e) => realisedR(e))
        .filter((r): r is number => r !== null),
    trades: () =>
      journal
        .entries()
        .filter((e) => e.closedAt !== null)
        .map((e) => ({ e, r: realisedR(e) }))
        .filter((x) => x.r !== null)
        .map(({ e, r }) => ({
          /* "as-planned" is the treatment; "modified" and "off-plan" are both
             control. Three-way would be the richer question and needs three
             populated arms — with a real book that is usually two of them
             empty, and the endpoint would refuse. */
          onPlan: e.adherence === "as-planned",
          r,
          score: e.scoreAtEntry ?? 0,
          setupKind: e.setupKind ?? "discretionary",
          hour: new Date(e.openedAt).getUTCHours(),
        })),
  }));

  /**
   * The Learning desk.
   *
   * `resolveNow` sweeps against the series currently in memory only. It cannot
   * reach for history it does not have — fetching every instrument in the
   * track record to settle it would be dozens of outbound requests from one
   * button press, which is how this terminal earned a 429 storm once already.
   * So the button settles what is loaded and the desk says exactly that.
   */
  /**
   * Every kind's record, as one table.
   *
   * `replayAll` has been able to produce this since v52 and nothing has ever
   * rendered it: the chart replayed exactly one kind, whichever the engine had
   * chosen. At thirteen detectors that was a gap; at twenty-nine it is the
   * operator's main question. The pass itself is the one `refreshDecision`
   * already asks for, so this costs a read of a signal rather than a second
   * replay.
   *
   * Null while the pass is for another chart. A table headed ETHUSDT while the
   * chart shows gold is worse than an empty one.
   */
  const kindScorecard = computed<KindScorecard | null>(() => {
    const deep = deepReplay.result();
    if (deep === null) return null;
    if (deep.symbol !== state.symbol() || deep.timeframe !== state.timeframe()) return null;
    return buildScorecard(deep.sims.values(), deep.rMultiple, deep.bars);
  });

  /* Keeping the replay: the operator-asked half of the trial mirror. */
  const keepNote = signal("");
  const keepBusy = signal(false);
  const keepReplay = (): void => {
    const deep = deepReplay.result();
    if (deep === null) {
      keepNote.set("Nothing has been replayed yet.");
      return;
    }
    const sims = [...deep.sims.values()];
    if (sims.length === 0) {
      keepNote.set("That replay produced no outcomes to keep.");
      return;
    }
    keepBusy.set(true);
    keepNote.set("");
    void edge.push(sims).then((written) => {
      keepBusy.set(false);
      if (written < 0) {
        /* The handle's own reason, verbatim — it distinguishes "the service is
           not running" from "it refused", and those want different actions. */
        keepNote.set(edge.lastError() || "The record service did not accept it.");
        return;
      }
      keepNote.set(
        written === 0
          ? "Nothing new — this replay was already kept."
          : `Kept ${written.toLocaleString()} outcome${written === 1 ? "" : "s"}.`,
      );
    });
  };

  const learnDesk = lazyDesk(() => createLearnDesk({
    store: learn,
    kindTable: () =>
      createKindTable({
        card: () => kindScorecard(),
        busy: () => deepReplay.busy(),
        /* Offered only when there is meaningfully more to read. At 5,999 of
           6,000 bars the button would run a pass that changes nothing — the
           same guard `canDeepen` applies on the setup card. */
        onDeepen:
          (kindScorecard()?.bars ?? 0) < DEEP_TARGET_BARS * 0.95
            ? () => {
                void deepReplay.deepen(state.symbol(), state.timeframe(), setupLast.rMultiple);
              }
            : null,
        deepTarget: DEEP_TARGET_BARS,
        /* THE TRIAL MIRROR'S PUSH, WHICH HAD NO CALLER.
           The comment beside `createEdge` says it "pushes when the operator
           asks, from the Learning desk"; nothing asked, so `trials` could
           never fill and the conditional-edge read had nothing to read. */
        onKeep: (kindScorecard()?.rows.length ?? 0) > 0 ? keepReplay : null,
        keepNote: () => keepNote(),
        keepBusy: () => keepBusy(),
      }),
    symbol: () => state.symbol(),
    openSymbol: (sym, timeframe) => {
      state.symbol.set(sym);
      state.timeframe.set(timeframe);
      state.view.set("chart");
    },
    resolveNow: () => {
      const sym = state.symbol.peek().toUpperCase();
      const tf = state.timeframe.peek();
      learn.resolvePending((s, t) => (s === sym && t === tf ? feed.bars.peek() : []));
    },
  }));

  /**
   * Every desk now exists. Release the gate in the view switch.
   *
   * Placed after the LAST desk construction rather than at the end of
   * `mountShell`, so it is obvious what it is waiting for: move a desk below
   * this line and the gate stops protecting it. A comment cannot enforce that,
   * but the position makes the mistake visible in a diff.
   */
  desksReady.set(true);

  /**
   * Write the card's read down, so it can be marked wrong later.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THIS IS AN EFFECT ON `setupView` AND NOT A CALL INSIDE IT
   *
   * `setupView` is a `computed`, and a computed that writes to a store is a
   * side effect inside a derivation — it would re-enter the signal graph
   * mid-flush, and any throw inside it would leave the whole card holding
   * `undefined` for ever. The read is derived; recording it is a consequence.
   *
   * WHAT IS DELIBERATELY NOT RECORDED
   *
   *   · `unknown` verdicts. The gates could not be evaluated, which is neither
   *     a refusal nor a clearance — see `claimVerdict`.
   *   · Anything without a plan. No plan means no stop and no target, and a
   *     claim without those is an opinion nobody can mark.
   *   · Anything on a replay. Replay bars are history the terminal already
   *     knows the answer to; recording a "prediction" made while scrubbing
   *     through 2023 would fill the track record with hindsight and there
   *     would be no way afterwards to tell those rows from real ones.
   *
   * The cooldown and the change-of-mind rule live in `learn/claim.ts`; without
   * them a chart left open would write one claim per tick and the hit rate
   * would become a measurement of how long the tab was open.
   */
  effect(() => {
    const v = setupView();
    if (v === null || !learn.enabled()) return;
    if (replay.active()) return;

    const kind = claimVerdict(v.verdict.kind);
    if (kind === null) return;

    const plan = v.plan;
    if (plan === null) return;

    /* The lean, not the plan's direction. They are the same thing today, and
       reading it from the verdict line rather than the plan keeps it that way
       by construction if the plan ever starts proposing a fade. */
    const side = plan.direction;
    const d = decision();

    /* Target 1, not target 2. It is the level the plan actually expects to
       reach, and scoring against the further one would mark a plan wrong for
       failing to do something it never claimed it would. */
    learn.record({
      symbol: v.symbol,
      timeframe: v.timeframe,
      side,
      verdict: kind,
      gatesFailed: v.verdict.blocking.length,
      score: d.score,
      coverage: d.coverage,
      confidence: d.confidence,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target1,
      horizonMs: tfMs(v.timeframe) * HORIZON_BARS,
    });
  });

  /**
   * The dock body. Held for the layout effect below, which applies panel order.
   *
   * IT USED TO BE HELD FOR MEASURING TOO. A tick signal and a ResizeObserver
   * existed to keep a scroll-depth figure in the summary line current, and
   * they did not: a ResizeObserver watches an element's own BOX, and this
   * body's box never changes - what grows is the CONTENT inside it, when the
   * Setup card fills in asynchronously and on every refresh after that. So the
   * line was measured once, before the tallest panel had any content, and held
   * 1.2 screens for the rest of the session against a real 3.4.
   *
   * All three are gone with the figure they served. The reasoning for removing
   * it rather than observing ten panels to keep it honest is on `dockSummary`.
   */
  let dockBodyEl: HTMLElement | null = null;

  /**
   * The dock's card switcher, shown only in stack mode.
   *
   * A scrolling strip of names rather than a dropdown: the point of a stack is
   * that you can see WHICH cards exist and get to any of them in one click. A
   * `select` would hide the set behind an interaction and make the stack worse
   * than the column it replaced.
   */
  const dockSwitcher = h(
    "div",
    { class: "dock-cards", role: "tablist", "aria-label": "Inspector cards" },
    ...orderedIds().map((id) =>
      h("button", {
        class: "dock-card-tab",
        type: "button",
        role: "tab",
        "aria-selected": () => String(state.dockCard() === id),
        hidden: () => state.dockRemoved().includes(id),
        text: panelMeta(id)?.title ?? id,
        onclick: () => state.dockCard.set(id),
      }),
    ),
  ) as HTMLElement;

  /** What's likely next: the outlook, its odds, its track record —
      `ui/model/outlook.ts`. */
  const { outlookRead, outlookPlan, outlookOdds, outlookCal } = createOutlookModel(ctx, {
    bars,
    closedBarCount,
    setupView,
  });

  /**
   * Section headings between the dock's panels. Built once and ordered with the
   * panels by the layout effect below (`layoutOrder`), so they cannot fall out
   * of step with the column. Hidden in stack mode, where one card shows.
   */
  const dockSectionHeads = DOCK_SECTIONS.map((sec) =>
    h(
      "div",
      { class: "dock-sec", "data-sec": sec.id },
      h("span", { class: "dock-sec-title", text: sec.title }),
      h("span", { class: "dock-sec-q", text: sec.question }),
    ),
  );


  /** The one surface that says what CHANGED — `ui/model/live.ts`. */
  const { liveEngine, liveEvents, publishLive } = createLiveModel(ctx, {
    replay,
    nowMs,
    detections,
    closedBarCount,
    setupView,
    setupLast,
  });

  /** The answer, pinned above the argument — `./shell/dockverdict.ts`. */
  /**
   * Which half of the recommendation card is on screen.
   *
   * In memory, like the Strategy desk's own mode: it is where you are, not a
   * preference. A saved one would open the terminal on a panel the operator
   * did not choose this session — and, worse here, could open it on the
   * autonomous panel of a market with an empty shelf.
   */
  const recMode = signal<"manual" | "autonomous">("manual");

  const dockVerdict = createDockVerdict(ctx, {
    setupView,
    setupLast,
    calendar,
    dockBody: () => dockBodyEl,
    /* Late-bound: dockCards is built just below. */
    reveal: (id) => dockCards.reveal(id),
  });

  /** Card heads, "+ Add panel" and the shut inspector's icon strip —
      `./shell/dockcards.ts`. */
  const dockCards = createDockCards(ctx, { dockToggle, dockBody: () => dockBodyEl });

  const dock = h(
    "aside",
    { class: "dock", "data-mode": () => state.dockMode() },
    /*
     * WHAT A CLOSED DOCK LOOKS LIKE.
     *
     * Nothing, until now — the track collapsed to zero and the panel left no
     * trace, so the only routes back were the `B` key and a 22px toolbar icon.
     * The comment on `dockIntent` above already named that as the residual
     * risk ("a toolbar icon most people never find standing between the user
     * and their layout"), and it stopped being hypothetical when the person
     * who owns this product asked twice where the panel had gone. Both routes
     * worked; a screen showing no evidence that a panel exists is not
     * something a working shortcut fixes.
     *
     * v59.2: the rail is now an icon strip, one icon per card — see
     * `./shell/dockcards.ts`. What follows is why it exists at all.
     *
     * So the closed state is a rail, and the rail is the affordance. It writes
     * through `dockToggle` rather than `state.dockOpen`, which is the whole
     * point of that signal existing: reopening from here is a DECISION and has
     * to be persisted as one, exactly like the icon and the keybinding. Setting
     * `state.dockOpen` directly would reopen the panel and lose it again on the
     * next launch.
     *
     * Rendered as the dock's own first child, not as an overlay on `.main`:
     * `.dock-resizer` is positioned over the chart and can afford to be, at
     * 6px; 22px across the price axis would cover its labels. As a child it
     * takes the grid track the closed dock now keeps, so the chart is 22px
     * narrower and nothing is painted over.
     */
    dockCards.iconStrip,
    /* IDENTITY ONLY: what this panel is, and what it is looking at.

       The Column/Stack toggle used to be here and is now in the row below,
       with the rest of the panel's controls. Two reasons, one of them
       measured. The measured one is in `.dock-head`'s comment: at the dock's
       260px minimum this row's content came to 279px and the toggle - last in
       the row, and unshrinkable - was clipped by the shell. The other is that
       a layout mode is a session-level setting, and it was sitting in the
       highest-value row in the panel, beside the symbol. */
    h(
      "div",
      { class: "dock-head" },
      h("span", { class: "label", text: "Inspector" }),
      h("span", { class: "chip", text: () => state.symbol() }),
      h("span", { class: "dock-spacer" }),
    ),

    /* Stack controls: previous, the card strip, next. Arrows because the strip
       scrolls once there are nine of them, and stepping is how you sweep. */
    h(
      "div",
      { class: "dock-stackbar" },
      h("button", {
        class: "dock-step",
        type: "button",
        text: "‹",
        title: "Previous card",
        "aria-label": "Previous card",
        onclick: () => state.dockCard.set(nextCard(state.dockCard(), -1, state.dockRemoved())),
      }),
      dockSwitcher,
      h("button", {
        class: "dock-step",
        type: "button",
        text: "›",
        title: "Next card",
        "aria-label": "Next card",
        onclick: () => state.dockCard.set(nextCard(state.dockCard(), 1, state.dockRemoved())),
      }),
    ),

    /* WHAT YOU HAVE BUILT, AND THE CONTROLS THAT CHANGE IT.

       The count no longer reports scroll depth in screens. That figure was
       frozen at 1.2 against a live measurement of 3.4, and it duplicated the
       scrollbar thumb, which is the same ratio drawn by the browser and always
       correct. The whole account is on `dockSummary` in dockpanels.ts. */
    h(
      "div",
      { class: "dock-summary" },
      h("span", {
        class: "dock-count",
        /* v59.2: the v5 head reads "Panels"; the count is in the title. */
        text: "Panels",
        title: () => dockSummary(state.dockMode(), state.dockOpenIds(), state.dockRemoved()),
      }),
      h("button", {
        class: "dock-mini",
        type: "button",
        text: () => (state.dockOpenIds().length === 0 ? "Open defaults" : "Collapse all"),
        title: "Collapse every panel, or restore the defaults",
        onclick: () =>
          state.dockOpenIds.set(state.dockOpenIds().length === 0 ? sanitiseOpen(null, DOCK_LAYOUT) : []),
      }),
      dockCards.addButton,
      h("button", {
        class: "dock-mini",
        type: "button",
        text: "Hide",
        title: "Hide the inspector — its cards stay as icons at the edge (B or ])",
        onclick: () => dockToggle.set(false),
      }),
      /* Two buttons rather than one toggle, because a single button that says
         "Stack" is ambiguous about whether that is the current state or the
         thing it will do to you. */
      h(
        "div",
        { class: "dock-modes", role: "group", "aria-label": "Dock layout" },
        ...(["column", "stack"] as const).map((m) =>
          h("button", {
            class: "dock-mode",
            type: "button",
            "aria-pressed": () => String(state.dockMode() === m),
            title: m === "column" ? "All panels, collapsible" : "One card at a time",
            text: m === "column" ? "Column" : "Stack",
            onclick: () => state.dockMode.set(m),
          }),
        ),
      ),
    ),
    /* v59.2 — THE AI RECOMMENDATION CARD (the v5 design): the verdict and
       the operator's answer to it, one card, first in the panel and always
       in view. AI-tinted, because every word above "Your say" is the
       terminal's. */
    h(
      "section",
      { class: "rec-card", "data-who": "ai", "aria-label": "AI recommendation", "data-mode": () => recMode() },
      h(
        "div",
        { class: "rec-head" },
        h("span", { class: "card-ic", ref: (el: HTMLElement) => el.appendChild(icon("sparkle", { size: 13 })) }),
        h("span", { class: "rec-title", text: "AI recommendation" }),
        /* v60 — the same two-way switch as the Strategy desk, on the card the
           recommendation appears on. Manual is the Setup card's verdict,
           unchanged; Autonomous is what the terminal's OWN searches say about
           this chart. Both are the terminal speaking, so the card stays
           AI-tinted in either. */
        h(
          "div",
          { class: "seg rec-modes", role: "group", "aria-label": "Recommendation mode" },
          h("button", {
            class: "seg-btn",
            type: "button",
            "data-mode": "manual",
            "aria-pressed": () => String(recMode() === "manual"),
            title: "The chart read: detectors, checks and the plan they imply",
            text: "Manual",
            onclick: () => recMode.set("manual"),
          }),
          h("button", {
            class: "seg-btn",
            type: "button",
            "data-mode": "autonomous",
            "aria-pressed": () => String(recMode() === "autonomous"),
            title: "Strategies the terminal found by searching this market, checked against the last closed bar",
            text: "Autonomous",
            onclick: () => recMode.set("autonomous"),
          }),
        ),
        h("span", { class: "card-who", "data-who": "ai", text: "AI" }),
      ),
      h(
        "div",
        { class: "rec-pane", "data-show": () => String(recMode() === "manual") },
        dockVerdict,
        /* The operator's answer to the verdict — `./shell/yoursay.ts`. */
        createYourSay(ctx, {
          setupView,
          onUse: () => state.view.set("calculator"),
          onAdjust: () => state.view.set("decision"),
        }),
      ),
      h(
        "div",
        { class: "rec-pane", "data-show": () => String(recMode() === "autonomous") },
        createAutoVerdict(ctx, {
          shelf,
          bars,
          closedBarCount,
          onOpenStrategy: () => state.view.set("strategy"),
          onUse: () => state.view.set("calculator"),
          onAdjust: () => state.view.set("decision"),
          /* v60.2 — the card searches, sizes and checks for itself. */
          sweep,
          autoSearch,
          account: () => account.effective(),
          atr: () => studies().atr,
          /* THE SAME READINGS THE MANUAL PANE IS JUDGED BY. `setupLast.env` is
             written by the Setup model on every pass, and is null while that
             model refuses to answer for this instrument — which the card
             reports as "nothing checked yet" rather than as a pass. */
          env: () => setupLast.env,
        }),
      ),
    ),
    h(
      "div",
      {
        class: "dock-body",
        ref: (el: HTMLElement) => {
          dockBodyEl = el;
        },
      },
      ...dockSectionHeads,

      /* FIRST IN THE COLUMN (see DOCK_PANELS): the only panel here that says
         what CHANGED rather than what is true. Source order is not what decides
         that — `layoutOrder()` is — but it is built first because it is read
         first. */
      panel(
        "live", "Live",
        createLiveFeed({
          events: liveEvents,
          /* Twelve rows. The engine keeps 200 and this is the top of that: a
             dock column is 360px wide and a log longer than a screen is a log
             nobody reaches the bottom of. The count in the head says how many
             there really are. */
          limit: 12,
          onClear: () => {
            liveEngine.clear();
            publishLive();
          },
          price: fmtPx,
        }),
      ),

      panel(
        "outlook", "Price outlook",
        createOutlookPanel({
          outlook: outlookRead,
          odds: outlookOdds,
          calibration: outlookCal,
          plan: outlookPlan,
          price: fmtPx,
        }),
      ),

      /* The Setup card. Fourth in the column since v54 — the reasoning above it,
         the verdict pinned over all of it in `.dock-verdict`. */
      panel(
        "setup", "Setup",
        h("div", { class: "setup-mount", ref: (el: HTMLElement) => { setupMount.el = el; } },
        createSetupCard({
          view: setupView,
          onCopyToCalculator: () => state.view.set("calculator"),
          onOpenDecision: () => state.view.set("decision"),
          onDeepen: () => {
            void deepReplay.deepen(state.symbol(), state.timeframe(), setupLast.rMultiple);
          },
        })),
      ),

      panel(
        "fundamentals", "Fundamentals",
        createFundamentalsPanel({ service: fundamentals, symbol: state.symbol }),
      ),

      /* v59.2 — cards over services that ran with no screen. Built even when
         removed from the column, like every panel here, so adding one back is
         instant and keeps its state; each polls only while it is attached. */
      panel("gov", "Can I trade now?", createGovCard().el),
      panel(
        "alerts", "Price alerts",
        createAlertsCard({
          symbol: state.symbol,
          /* The last bar's close — `bars` is the replay-aware series, so in
             replay the distance is measured from the replayed price. */
          price: () => {
            const b = bars();
            const last = b[b.length - 1];
            return last ? last.c : null;
          },
          fmtPx,
        }).el,
      ),
      panel("whale", "Whale watch", createWhaleCard().el),
      /* The two capabilities that ran for releases with a greyed-out menu row
         reading "no screen yet". The scanner behind `newpairs` had also never
         written a row — see `newpairscard.ts`. */
      panel("dbwallets", "Smart-money wallets", createDbWalletsCard().el),
      panel("newpairs", "New token pairs", createNewPairsCard().el),
      /* The AI read: five steps from what was measured — `scan/chartread.ts`.
         Its pullback step reads the SAME `keyLevels` result the Key levels card
         shows, so the two cannot name different zones. */
      panel(
        "read", "AI read of the chart",
        createReadCard({
          input: () => {
            const b = bars();
            const price = b[b.length - 1]?.c ?? null;
            const s = studies();
            return {
              closes: b.map((x) => x.c),
              detections: detections(),
              levels: keyLevels(detections(), price, { atr: s.atr, enabled: state.detectors() }),
              rsi: s.rsi,
              fmtPx,
            };
          },
        }),
      ),
      /* The nearest support and resistance the detectors found, merged within
         a quarter ATR — `scan/keylevels.ts`. */
      panel(
        "levels", "Key levels",
        createLevelsCard({
          detections,
          price: () => {
            const b = bars();
            return b[b.length - 1]?.c ?? null;
          },
          fmtPx,
          atr: () => studies().atr,
        }),
      ),
      /* The same list the left rail shows (`watchlist().list`), not a copy.
         NAMED COST: the card keeps its own quote snapshot, because the rail's
         is created and destroyed with the rail. Both on screen = two Binance
         ticker calls per refresh. The card is off the column by default and
         refreshes only while visible. */
      panel(
        "watch", "Watchlist",
        createWatchCard({
          symbols: watchlist().list,
          current: state.symbol,
          onSelect: (sym) => state.symbol.set(sym.toUpperCase()),
          onOpenDesk: () => state.view.set("watchlist"),
        }),
      ),

      panel(
        "cursor", "Cursor",
        pkRowsLive(() =>
          (["open", "high", "low", "close", "volume"] as const).map(
            (k): PkRow => ({
              label: k.charAt(0).toUpperCase() + k.slice(1),
              value: cursorField(cursor(), bars(), k),
            }),
          ),
        ),
      ),

      panel(
        "context", "Context",
        h(
          "div",
          { class: "panel-body" },
          h(
            "div",
            { class: "det-toggles" },
            ...(["hour", "weekday", "month"] as const).map((m) =>
              h(
                "button",
                {
                  class: "det-toggle",
                  "aria-pressed": () => String(seasonMode() === m),
                  onclick: () => seasonMode.set(m),
                },
                h("span", { text: m === "hour" ? "By hour" : m === "weekday" ? "By day" : "By month" }),
              ),
            ),
          ),
          h("div", {
            class: "season-grid",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const s2 = season();
                clear(el);
                // Scale bars against the largest ABSOLUTE mean, so a chart of
                // small effects does not render as a chart of big ones.
                const peak = Math.max(
                  1e-9,
                  ...s2.buckets.map((b) => (b.sufficient ? Math.abs(b.meanReturn) : 0)),
                );
                for (const b of s2.buckets) {
                  if (b.samples === 0) continue;
                  const w = b.sufficient ? (Math.abs(b.meanReturn) / peak) * 100 : 0;
                  el.appendChild(
                    h(
                      "div",
                      {
                        class: "season-row",
                        "data-thin": String(!b.sufficient),
                        "data-dir": b.meanReturn >= 0 ? "up" : "down",
                        title: `${b.samples} samples · ${(b.upRate * 100).toFixed(0)}% closed up`,
                      },
                      h("span", { class: "season-label", text: b.label }),
                      h("span", { class: "season-bar", style: `--w:${w.toFixed(1)}%` }),
                      h("span", {
                        class: "season-val num",
                        text: b.sufficient ? `${(b.meanReturn * 100).toFixed(3)}%` : `n=${b.samples}`,
                      }),
                    ),
                  );
                }
              });
            },
          }),
          h("p", { class: "muted small", text: () => season().note }),
          /**
           * The release still ahead, and what it means.
           *
           * Leads with the DISCOUNT rather than the list, because the single
           * most decision-relevant fact about the calendar is not which events
           * exist — it is whether one of them is about to make the read on
           * screen stop mattering.
           */
          h("div", {
            class: "cal-lede",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const c = calendar();
                clear(el);
                if (!c?.ok) return;
                const risk = releaseRisk(c.events, {
                  now: Date.now(),
                  currencies: currenciesFor(state.symbol()),
                });
                if (!risk.next) return;
                el.appendChild(
                  h(
                    "div",
                    { class: "cal-alarm", "data-impact": risk.next.event.impact },
                    h("span", { class: "cal-alarm-bar", style: `width:${Math.round(risk.discount * 100)}%` }),
                    h("span", { class: "cal-alarm-text", text: risk.note }),
                  ),
                );
              });
            },
          }),

          h("div", {
            class: "cal-block",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const c = calendar();
                clear(el);
                if (!c) {
                  el.appendChild(h("p", { class: "muted small", text: "Calendar: loading." }));
                  return;
                }
                if (!c.ok) {
                  el.appendChild(h("p", { class: "muted small", text: c.error }));
                  return;
                }
                const next = upcoming(c.events, {
                  now: Date.now(),
                  currencies: currenciesFor(state.symbol()),
                  minImpact: "medium",
                  limit: 8,
                });
                if (next.length === 0) {
                  el.appendChild(
                    h("p", {
                      class: "muted small",
                      /* "in the loaded week", never "nothing scheduled" —
                         the feed publishes the current week only. */
                      text: `Nothing of medium impact or above left for ${currenciesFor(state.symbol()).join(", ")} in the loaded week.`,
                    }),
                  );
                  return;
                }
                for (const r of next) {
                  const e = r.event;
                  el.appendChild(
                    h(
                      "div",
                      { class: "cal-row", "data-impact": e.impact, title: r.note },
                      h("span", {
                        class: "cal-when num",
                        text: new Date(e.at).toISOString().slice(5, 16).replace("T", " "),
                      }),
                      h("span", { class: "cal-ccy", text: e.currency }),
                      h("span", { class: "cal-what", text: e.title }),
                      /* Forecast and previous were fetched and discarded by the
                         old path. They are the reason a release is priced in or
                         not, so they belong on the row rather than in a tooltip. */
                      h("span", {
                        class: "cal-fig num",
                        text: e.forecast ? `${e.forecast} vs ${e.previous || "—"}` : "",
                      }),
                      h("span", { class: "trust-dot", "data-trust": r.trust, title: r.note }),
                    ),
                  );
                }
              });
            },
          }),
          h(
            "div",
            { class: "alert-form-actions" },
            h("button", {
              class: "ghost-btn tiny",
              text: "Refresh",
              onclick: () => refreshMacro(),
            }),
          ),
          h("p", {
            class: "muted small",
            text: () => calendar()?.provenance ?? "",
          }),
        ),
      ),

      panel(
        "news", "Venue announcements",
        h(
          "div",
          { class: "news-wrap" },
          h("div", {
            class: "news-block",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const n = news();
                clear(el);
                if (!n) {
                  el.appendChild(h("p", { class: "muted small", text: "Announcements: loading." }));
                  return;
                }
                if (n.stories.length === 0) {
                  el.appendChild(
                    h("p", {
                      class: "muted small",
                      text:
                        n.sources.length === 0
                          ? "No venue answered."
                          : "Nothing in the market-moving categories right now. Promotions are filtered out.",
                    }),
                  );
                  return;
                }
                for (const story of n.stories) {
                  el.appendChild(
                    h(
                      "div",
                      { class: "news-row", "data-trust": story.trust },
                      h("span", {
                        class: "news-when num",
                        text: new Date(story.at).toISOString().slice(5, 16).replace("T", " "),
                      }),
                      h("span", { class: "news-what", text: story.title }),
                      /* Publishers, not item count. A venue repeating itself is
                         one publisher saying it once. */
                      h("span", {
                        class: "news-src",
                        text: story.publishers.join(" + "),
                        title: trustLabel(story.trust),
                      }),
                    ),
                  );
                }
              });
            },
          }),
          h("p", { class: "muted small", text: () => news()?.provenance ?? "" }),
        ),
      ),

      panel(
        "regime", "Regime & model",
        h(
          "div",
          { class: "panel-body" },
          h(
            "div",
            { class: "alert-form-actions" },
            h("button", {
              class: "ghost-btn tiny",
              disabled: () => intelBusy(),
              text: () => (intelBusy() ? "Asking…" : "Run models"),
              onclick: () => void runIntel(),
            }),
          ),
          h("div", {
            class: "intel-block",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const r = regime();
                clear(el);
                if (!r) {
                  el.appendChild(
                    h("p", {
                      class: "muted small",
                      text: "Not run. The regime model and the walk-forward classifier live in the Python service; they are asked on demand, never on every tick.",
                    }),
                  );
                  return;
                }
                if (!r.ok) {
                  el.appendChild(h("p", { class: "muted small", text: r.error }));
                  return;
                }
                el.appendChild(
                  h(
                    "div",
                    { class: "intel-head" },
                    h("span", { class: "intel-state", text: r.state }),
                    h("span", { class: "intel-conf num", text: r.confidence.toFixed(2) }),
                  ),
                );
                const total = Object.values(r.last48).reduce((a, b) => a + b, 0) || 1;
                for (const [name, count] of Object.entries(r.last48).sort((a, b) => b[1] - a[1])) {
                  el.appendChild(
                    h(
                      "div",
                      { class: "intel-bar-row" },
                      h("span", { class: "intel-bar-name", text: name }),
                      h("span", {
                        class: "intel-bar",
                        style: `--w:${((count / total) * 100).toFixed(0)}%`,
                      }),
                      h("span", { class: "intel-bar-n num", text: String(count) }),
                    ),
                  );
                }
                el.appendChild(h("p", { class: "muted small", text: r.note }));
              });
            },
          }),
          h("div", {
            class: "intel-block",
            ref: (el: HTMLDivElement) => {
              renderEffect(() => {
                const f = forecast();
                clear(el);
                if (!f) return;
                if (!f.ok) {
                  el.appendChild(h("p", { class: "muted small", text: f.error }));
                  return;
                }
                const standing = forecastStanding(f);
                el.appendChild(
                  h(
                    "div",
                    { class: "intel-head", "data-usable": String(standing.usable) },
                    h("span", { class: "intel-state", text: `${(f.pUp * 100).toFixed(1)}% up` }),
                    h("span", { class: "intel-conf num", text: `${f.horizon}-bar` }),
                  ),
                );
                // The verdict sits ON the probability, not in a footnote: an
                // uncalibrated model that looks confident is the whole danger.
                el.appendChild(h("p", { class: "muted small", text: standing.why }));
              });
            },
          }),
        ),
      ),

      panel(
        /**
         * What was FOUND. The controls that decide what to look for now live
         * in the chart toolbar, beside the drawing tools — see
         * `createDetectPanel`. Two copies of the same toggles in two places is
         * two things to keep in sync and one more question for the user
         * ("which of these is the real one?"), so this panel kept the half a
         * dock is good at — a scrollable list you read — and gave up the half
         * a toolbar is good at.
         */
        "structures", "Detected structures",
        h("div", {
          class: "det-count",
          text: () => {
            if (state.detectors().length === 0) {
              return "No detectors on — switch them on from the ⌖ button above the chart.";
            }
            const total = detections().length;
            if (total === 0) return "nothing detected in this range";
            const shown = drawn().length;
            return shown === total
              ? `${total} structure${total === 1 ? "" : "s"} drawn`
              : `${total} found · ${shown} drawn (most recent of each type)`;
          },
        }),
        h("div", {
          class: "det-list",
          ref: (el: HTMLDivElement) => {
            renderEffect(() => {
              const found = detections();
              clear(el);
              // Newest first: the structure that just completed is the one being
              // traded off, not the one from 600 bars ago.
              const data = detectData.peek();
              const existing = new Set(
                alertStore
                  .specs()
                  .filter((a) => a.anchor.kind === "detection")
                  .map((a) => `${(a.anchor as { detKind: string }).detKind}:${(a.anchor as { fromTime: number }).fromTime}`),
              );
              for (const d of [...found].reverse().slice(0, 40)) {
                // One click from "I see this structure" to "tell me when it
                // breaks". The two-click version is the one nobody uses during
                // a fast move, which is the only time it matters.
                const fromTime = data ? (data.t[d.from] ?? 0) : 0;
                const key = `${d.kind}:${fromTime}`;
                el.appendChild(
                  h(
                    "div",
                    { class: "det-item", "data-dir": d.direction },
                    h(
                      "div",
                      { class: "det-item-head" },
                      h("span", { class: "det-item-label", text: d.label }),
                      h("span", { class: "det-item-conf num", text: d.confidence.toFixed(2) }),
                    ),
                    h("p", { class: "det-item-reason", text: d.reason }),
                    data && canAnchor(d)
                      ? h("button", {
                          class: "det-item-alert",
                          "data-done": String(existing.has(key)),
                          title: presetFor(d).blurb,
                          text: existing.has(key) ? "Alert set" : "Alert me",
                          onclick: () => {
                            if (existing.has(key)) {
                              state.view.set("signals");
                              return;
                            }
                            alertStore.add({
                              id: alertId(Date.now()),
                              symbol: state.symbol.peek(),
                              timeframe: state.timeframe.peek(),
                              anchor: anchorFor(d, fromTime),
                              ...(anchorTimeframe(d) ? { timeframeAnchor: anchorTimeframe(d) as string } : {}),
                              condition: presetFor(d).condition,
                              once: true,
                              cooldownBars: 0,
                              enabled: true,
                              createdAt: Date.now(),
                              note: "",
                            });
                          },
                        })
                      : null,
                  ),
                );
              }
            });
          },
        }),
      ),

      panel(
        "studies", "Studies",
        pkRowsLive(() => {
          const st = studies();
          /* RSI is the one value here that carries a verdict, so it is the one
             that gets a tone. ATR is a magnitude — colouring it would be the
             panel editorialising about volatility. */
          const rsiTone: PkRow["tone"] | undefined = Number.isNaN(st.rsi)
            ? undefined
            : st.rsi >= 70
              ? "neg"
              : st.rsi <= 30
                ? "pos"
                : undefined;
          return [
            { label: "RSI(14)", value: num1(st.rsi), ...(rsiTone ? { tone: rsiTone } : {}) },
            { label: "ATR(14)", value: fmtOrDash(st.atr) },
            { label: "ATR %", value: Number.isNaN(st.atrPct) ? "" : `${num2(st.atrPct)}%` },
          ];
        }),
      ),

      /* The plumbing, visible at last. See ui/feedmon.ts — every one of the six
         sources, which is serving, what the breaker has parked, how the bars
         are arriving and the broker clock correction that used to be silent. */
      panel(
        "feed", "Feed & network",
        createFeedMonitor({
          log: feed.log,
          state: () => feed.state(),
          transport: feed.transport,
          pollEveryMs: feed.pollEveryMs,
          activeSource: feed.activeSource,
          reconnects: feed.reconnects,
          registry: feed.registry,
          symbol: () => state.symbol(),
          clockOffsetMs: () => brokerClockOffsetMs(),
        }).el,
      ),

      panel(
        "series", "Series",
        pkRowsLive(() => {
          const st = feed.state();
          const gaps = feed.gaps().length;
          return [
            { label: "Bars", value: String(bars().length) },
            {
              label: "Source",
              value: st.source,
              ...(feed.fromCache() ? { note: "served from cache" } : {}),
            },
            {
              label: "History gaps",
              value: gaps === 0 ? "none" : String(gaps),
              ...(gaps > 0 ? { tone: "neg" as const } : {}),
              ...(gaps > 0 ? { note: "a backtest over this window is running on holes" } : {}),
            },
            { label: "Quality", value: qualityLabel(st.quality) },
            /* An unreadable age is "—", never "0s". Zero seconds is the
               freshest possible reading and the exact opposite of not knowing
               — the same substitution that was telling the analyst the feed
               had just ticked when nothing was known about it. */
            {
              label: "Tick age",
              value: Number.isFinite(st.tickAgeMs) ? `${(st.tickAgeMs / 1000).toFixed(0)}s` : "",
              ...(Number.isFinite(st.tickAgeMs) ? {} : { note: "not reported by this feed" }),
            },
            {
              label: "Vendor lag",
              value: Number.isFinite(st.vendorLagMs) ? `${(st.vendorLagMs / 60000).toFixed(1)}m` : "",
            },
          ];
        }),
      ),

    ),
  );

  /**
   * One dock panel.
   *
   * The header is a BUTTON now, not an `h3`. Every panel in the dock was a
   * fixed block before, which is how the column reached 3,828px in an 842px
   * viewport with no way to shorten it.
   *
   * The body is wrapped so collapsing hides one element rather than N: the
   * panels pass a variable number of children and hiding them individually
   * would leave any that a later edit forgot about still visible.
   */
  /**
   * Apply the dock layout.
   *
   * The same shape as `livebar.refit()`: every panel is BUILT unconditionally
   * and this decides what is shown and in what order. Rebuilding the dock body
   * on a mode change would throw away the scroll position, the cursor readout
   * and any panel-local state, for a layout change that is pure presentation.
   *
   * Order comes from `orderedIds()` and is applied with CSS `order`, so source
   * order in this file stops being the thing that decides what you read first —
   * which is how a 774px news panel ended up above the structure list.
   */
  renderEffect(() => {
    const mode = state.dockMode();
    const active = state.dockCard();
    const pinned = state.dockPinned();
    const removed = state.dockRemoved();
    const body = dockBodyEl;
    if (!body) return;

    /* v59.2: pins first, removed cards and emptied sections get no slot. */
    const { sections, panels } = layoutOrder(pinned, removed);
    const last = sections.size + panels.size;
    for (const el of Array.from(body.children) as HTMLElement[]) {
      const sec = el.dataset["sec"];
      if (sec !== undefined) {
        const slot = sections.get(sec as Parameters<typeof sections.get>[0]);
        el.style.order = String(slot ?? last);
        el.hidden = mode === "stack" || slot === undefined;
        continue;
      }
      const id = el.dataset["panel"];
      if (id === undefined) continue;
      /* An unranked panel sorts last rather than first. A new panel someone
         forgets to register should be easy to miss, not jump to the top. */
      el.style.order = String(panels.get(id) ?? last);
      el.dataset["pinned"] = String(pinned.includes(id));
      el.hidden = removed.includes(id) || (mode === "stack" && id !== active);
    }
  });

  function panel(id: string, fallbackTitle: string, ...body: HTMLElement[]): HTMLElement {
    /* The registry's title, so renaming a panel is one edit in dockpanels.ts
       and the header, the stack tab and the summary cannot disagree. */
    const title = panelMeta(id)?.title ?? fallbackTitle;
    return h(
      "section",
      {
        class: "panel",
        "data-panel": id,
        /* v59.2: AI cards are tinted — see `.panel[data-who="ai"]`. */
        "data-who": panelMeta(id)?.who ?? "",
        "data-open": () => String(state.dockOpenIds().includes(id)),
      },
      /* v59.2: the collapse button sits inside a card head that adds the
         icon, who produces it, pin and remove — `./shell/dockcards.ts`. */
      dockCards.cardHead(
        id,
        h(
          "button",
          {
            class: "panel-head",
            type: "button",
            "aria-expanded": () => String(state.dockOpenIds().includes(id)),
            title: () => (state.dockOpenIds().includes(id) ? `Collapse ${title}` : `Expand ${title}`),
            onclick: () => state.dockOpenIds.set(toggleOpen(state.dockOpenIds(), id)),
          },
          h("span", { class: "panel-caret", "aria-hidden": "true" }),
          h("span", { class: "label", text: title }),
        ) as HTMLElement,
      ),
      h("div", { class: "panel-body" }, ...body),
    ) as HTMLElement;
  }

  // ----------------------------------------------------------- live bar ---

  /**
   * The bottom row stops describing the terminal and starts describing the
   * market and your money. See `ui/livebar.ts` for why it ranks its fields and
   * why it does not scroll.
   *
   * Everything the old status bar showed is still here — it moved behind the
   * health chip, which expands it on click. Nothing was deleted; it stopped
   * occupying the row by default.
   */
  const chordPendingEl = h("span", {
    class: "status-item chord-pending",
    "data-on": () => String(chordPending().length > 0),
    text: () => `${chordPending()} …`,
  }) as HTMLElement;

  const bellEl = h(
    "button",
    {
      class: "status-item bell",
      type: "button",
      title: "Notification log (Shift+N)",
      onclick: () => deps.openNotifications(),
      ref: (el: HTMLButtonElement) => {
        bellAnchor = el;
      },
    },
    h("span", { class: "bell-icon", ref: (el: HTMLElement) => el.appendChild(icon("bell")) }),
    h("span", {
      class: "bell-count",
      "data-zero": () => String(toaster.unread() === 0),
      text: () => String(Math.min(99, toaster.unread())),
    }),
  ) as HTMLElement;


  /** What the live bar reads: last bar, heat, sessions, fresh structure,
      the bar countdown and the next-bar band — `ui/model/readings.ts`. */
  const { lastBar, heatNow, sessionClock, freshDetections, barCountdown, nextBarBand } =
    createReadingsModel(ctx, { replay, nowMs, detections, openBook });

  /*
   * EVERY SIGNAL IS READ BEFORE THE `chart` GUARD, AND THAT ORDER IS LOAD-BEARING.
   *
   * `chart` is assigned several hundred lines below this, so both of these
   * effects run once at mount with it still null. An early `if (!chart) return`
   * would return having read NOTHING — no dependencies, so no re-run, ever.
   * The effect would not throw, would not warn, and would simply never fire
   * again: the band and the countdown would be permanently absent on a chart
   * that otherwise worked. Measured exactly that way before this comment
   * existed. Read first, guard second — which is what the overlay and pane
   * effects below already do, for the same reason.
   */
  renderEffect(() => {
    /* Not on replay: the "next" bar there is one the operator can scrub to,
       and drawing a forecast of a bar that is already in the series would be
       the look-ahead this codebase spends most of its comments avoiding. */
    const onReplay = replay.active();
    const band = onReplay ? null : nextBarBand();
    if (!chart) return;
    chart.setProjection(
      band === null
        ? null
        : { low: band.low, high: band.high, confidence: 0.8, calibrated: band.calibrated },
    );
  });

  renderEffect(() => {
    const cd = barCountdown();
    const tone = countdownTone(cd.kind);
    if (!chart) return;
    chart.setCountdown({ text: cd.text, tone: tone === "warn" ? "warn" : tone === "mute" ? "mute" : "live" });
  });

  const liveBar = createLiveBar({
    trailing: [chordPendingEl, bellEl],
    /**
     * The tape, moved down from the context bar where it was being crushed.
     *
     * Ranked 11 — below every number on the bar. It is a convenience, and the
     * repository already made this argument once in `shell.css`: a convenience
     * that damages the things around it is not one. 260px is the width below
     * which a headline is not worth reading; under that it is dropped whole
     * rather than truncated, because a truncated tape with a live dot beside
     * it is a claim that the operator is being kept informed.
     */
    ticker: { el: tape.el, rank: 11, minWidth: 260 },
    health: {
      dot: () => {
        const q = feed.state().quality;
        return q === "live" ? "live" : q === "delayed" ? "delayed" : q === "stale" ? "stale" : "off";
      },
      text: () => {
        const c = connection.state();
        const latency = !c.online
          ? "offline"
          : c.fastest
            ? `${c.fastest.latencyMs}ms`
            : c.provisional
              ? `~${c.provisional.latencyMs}ms`
              : "—";
        return `${feed.state().source} · ${latency}`;
      },
      onExpand: () => deps.openNotifications(),
    },
    fields: [
      {
        id: "price",
        zone: "instrument",
        rank: 1,
        value: () => {
          const b = lastBar();
          return b ? num(b.c, b.c >= 1000 ? 2 : 5) : "—";
        },
        covered: () => lastBar() !== null,
        /* Direction of the last print. Reset on a change of instrument or
           timeframe, so one market's last tick never colours another's price. */
        tone: (() => {
          let key = "";
          let prev: number | null = null;
          let held: TickTone | undefined;
          return (): TickTone | undefined => {
            const b = lastBar();
            const k = `${state.symbol()}|${state.timeframe()}`;
            if (k !== key) {
              key = k;
              prev = null;
              held = undefined;
            }
            if (!b) return held;
            held = nextTickTone(prev, b.c, held);
            prev = b.c;
            return held;
          };
        })(),
      },
      {
        id: "symbol",
        zone: "instrument",
        rank: 3,
        value: () => `${state.symbol()} · ${state.timeframe()}`,
      },
      {
        /* The span is MEASURED from the bars rather than read off the timeframe
           label, the local clock is corrected against the feed, and the three
           ways of not counting down are three different words. See ui/countdown.ts. */
        id: "countdown",
        zone: "instrument",
        rank: 6,
        label: "next",
        value: () => barCountdown().text,
        tone: () => countdownTone(barCountdown().kind),
        covered: () => barCountdown().kind !== "unknown",
      },
      {
        id: "spread",
        zone: "instrument",
        rank: 4,
        label: "spread",
        value: () => {
          /* The broker's dealing spread where there is one — it is the number
             you actually pay, and on every forex and metals instrument this
             row read "none" while the bridge had it all along. */
          const q = brokerQuote();
          if (q && q.ok) return quoteWords(q);
          const s = spread();
          return s && s.ok ? `${num(s.spreadPct, 3)}%` : "—";
        },
        /* No cross-venue read is a GAP, not a zero: printing 0% would say the
           venues agree exactly, which is a claim we have not measured. */
        covered: () => {
          const q = brokerQuote();
          if (q !== null && q.ok) return true;
          const s = spread();
          return s !== null && s.ok;
        },
      },
      {
        id: "atr",
        zone: "market",
        rank: 7,
        label: "atr",
        value: () => num(studies().atr, 2),
        covered: () => Number.isFinite(studies().atr),
      },
      {
        /**
         * Which books are open, and how long until that changes.
         *
         * The Sessions desk has modelled this since v49 and the chart has had
         * session ranges drawn on it since; neither answers the question you
         * actually ask at the moment of taking a trade, which is "is the
         * liquidity I am about to need still going to be here". Two open
         * sessions and eleven minutes to the London close is a different
         * decision from two open sessions and four hours.
         *
         * Named sessions rather than a count: "London+NY" is the answer, "2"
         * is a riddle.
         */
        id: "session",
        zone: "market",
        rank: 8,
        label: "open",
        value: () => {
          const s2 = sessionClock();
          return s2.open.length === 0 ? "none" : `${s2.open.join("+")} ${s2.next}`;
        },
        tone: () => (sessionClock().open.length === 0 ? "mute" : undefined),
      },
      {
        /**
         * What the detectors have just found, on the bar that closed.
         *
         * Twenty-nine detectors run on every bar close and, before this, the
         * only way to learn that any of them had fired was to be looking at
         * the chart at the moment it drew. The chart is a picture of the past;
         * this is the one place on screen that says something changed.
         *
         * Counts what is NEW on the last two bars, not what is on the chart —
         * a standing count of forty marks is wallpaper within an hour.
         */
        id: "detections",
        zone: "market",
        rank: 6,
        label: "new",
        value: () => {
          const fresh = freshDetections();
          return fresh.length === 0 ? "—" : `${fresh.length} · ${fresh[0]?.label ?? ""}`;
        },
        tone: () => (freshDetections().length > 0 ? "warn" : "mute"),
        covered: () => detections().length > 0,
      },
      {
        /**
         * THE NEWEST EVENT, IN TWO WORDS.
         *
         * The row beside it counts what is NEW on the chart — a standing
         * measure of the detectors. This is the other half: not "there are
         * three fresh structures" but "the gates just cleared", "the feed just
         * stopped updating", "price just entered the zone". The two rank
         * together on purpose; they answer the same question from opposite
         * ends, and neither supersedes the other.
         *
         * Two words is all a bar with thirteen fields can spare, so the whole
         * sentence and its measurement are the field's tooltip and the Live
         * panel is a click away. A half-cut sentence would be worse than a
         * label — the `Te…` lesson, one field over.
         *
         * `warn` is the attention role and `mute` is muted text, which is the
         * severity scale exactly. Never `up`/`down`: an event is not a
         * direction.
         */
        id: "live",
        zone: "market",
        rank: 6,
        label: "live",
        value: () => latestLine(newest(liveEvents())),
        title: () => latestTitle(newest(liveEvents())),
        tone: () => (newest(liveEvents())?.severity === "act" ? "warn" : "mute"),
        covered: () => newest(liveEvents()) !== null,
      },
      {
        id: "rsi",
        zone: "market",
        rank: 9,
        label: "rsi",
        value: () => num(studies().rsi, 0),
        covered: () => Number.isFinite(studies().rsi),
      },
      {
        id: "bars",
        zone: "market",
        rank: 10,
        value: () => `${bars().length} bars`,
      },
      {
        id: "heat",
        zone: "money",
        rank: 2,
        label: "heat",
        value: () => `${num(heatNow().heatPct, 1)}%`,
        tone: () => {
          const h2 = heatNow().heatPct;
          return h2 >= 6 ? "neg" : h2 >= 3 ? "warn" : undefined;
        },
      },
      {
        id: "positions",
        zone: "money",
        rank: 8,
        label: "pos",
        value: () => String(openBook().length),
      },
      {
        id: "today",
        zone: "money",
        rank: 5,
        label: "today",
        value: () => num(riskDesk.realisedToday(), 2),
        tone: () => {
          const r = riskDesk.realisedToday();
          return r > 0 ? "pos" : r < 0 ? "neg" : "mute";
        },
      },
    ],
  });

  const status = liveBar.el;


  /* ------------------------------------------------------------- news bar ---
   *
   * A second strip above the live bar, carrying headlines from RSS and Atom
   * feeds. Separate from the tape on purpose: the tape says what is happening
   * to THIS instrument — its venue's announcements, its releases, its feed
   * health — while this is the world, and merging them would mean a Fed press
   * release and a Bybit maintenance notice competing for one slot.
   *
   * The feeds are fetched by `server/mishel_rss.py`, because almost no
   * newsroom sends CORS headers on its RSS; see `data/rss.ts`.
   *
   * OFF UNLESS ASKED FOR. It is a row of chrome above the chart and the most
   * interruptive thing on the screen. The grid collapses its track to zero
   * when it is off, so a terminal that never turns it on pays nothing.
   */
  const newsFeed = signal<RssFeed>(EMPTY);
  const rss = createRss();

  const loadNewsFeed = (): void => {
    if (!newsOn.peek()) return;
    void rss.load().then((f) => newsFeed.set(f));
  };

  const newsBar = createNewsBar({
    feed: newsFeed,
    now: () => nowMs(),
    onRefresh: () => loadNewsFeed(),
  });

  /* Fetches when it is switched on and then on a timer, never while it is off.
     A bar nobody is looking at must not be polling five newsrooms. */
  effect(() => {
    if (!newsOn()) return;
    loadNewsFeed();
  });

  /* Five minutes. Newsrooms publish in minutes and the service caches for two,
     so anything faster is a request that returns the same bytes. */
  setInterval(loadNewsFeed, 5 * 60_000);

  /* The watchlist rail's grid cell. Empty until the rail is first shown —
     see "THE WATCHLIST RAIL" below. */
  const railArea = h("aside", { class: "watchrail-area", "aria-label": "Watchlist" }) as HTMLElement;

  const shell = h(
    "div",
    { class: "shell" },
    commandbar,
    railArea,
    topbar,
    main,
    dock,
    newsBar.el,
    status,
  );
  root.appendChild(shell);
  /* Outside the shell grid: the shell clips its children to their tracks, and
     a toast must be able to float over the chart. */
  document.body.appendChild(toaster.el);

  /**
   * Below the breakpoint the dock becomes a floating overlay (see shell.css).
   * An overlay that is open by default covers the view behind it — at narrow
   * widths the Flow and Screener desks were completely unreachable. So entering
   * narrow auto-closes it, and leaving restores whatever the user had. The
   * toggle still works while narrow; this only changes the DEFAULT.
   */
  const narrow = window.matchMedia("(max-width: 1100px)");

  /**
   * Narrow closes the dock; wide restores what the user asked for.
   *
   * Reading `dockIntent` rather than a local snapshot is the point: the
   * snapshot version only restored if the SAME page load had made the
   * transition, so a boot that started narrow had nothing to go back to and
   * left the dock shut for good. Intent survives the resize, the reload and the
   * quit, because it is the only thing written to preferences.
   */
  const applyNarrow = (isNarrow: boolean): void => {
    state.dockOpen.set(isNarrow ? false : dockIntent.peek());
  };

  applyNarrow(narrow.matches);
  narrow.addEventListener("change", (e) => applyNarrow(e.matches));

  // Leaving the screener cancels any scan in flight. Letting it run to
  // completion against a view nobody is looking at burns vendor rate limit that
  // the chart's own requests then cannot use.
  effect(() => {
    const view = state.view();
    /* `.built()` before `.cancel()`. Reaching through the thunk here would
       construct the very desk being told to stop, on every single view change
       — and a scan that was never started needs no cancelling. */
    if (view !== "screener" && screener.built()) screener().cancel();
    if (view === "flow") flow().activate();
    else if (flow.built()) flow().cancel();
    // Re-reads the archive on entry: it changes underneath the desk whenever a
    // chart loads, so a cached inventory would show yesterday's numbers.
    if (view === "data") data.activate();
    /* Same reason, for the machine's own state: the archive grows and the
       loops tick whether or not this desk is open, so a cached reading would
       be whatever was true when it was last looked at. */
    if (view === "system") system().activate();
    /* Cross-venue costs four requests, so it loads on entry rather than on a
       timer — and only when it has nothing for this symbol. */
    if (view === "decision" && spread.peek() === null) refreshDecision();
  });

  renderEffect(() => {
    shell.setAttribute("data-dock", state.dockOpen() ? "open" : "closed");
    shell.setAttribute("data-focus", state.focus());
    shell.setAttribute("data-news", newsOn() ? "on" : "off");
    /* The context bar collapses on desks it does not describe. A symbol box and
       six timeframe buttons sitting above the settings archive are controls
       that claim to change what you are looking at and do not. */
    shell.setAttribute("data-scoped", SCOPED_VIEWS.has(state.view()) ? "yes" : "no");
    shell.setAttribute("data-view", state.view());
    /* v59.2: the WORKSPACE, for the v5 layout — the inspector and the symbol
       bar belong to Chart; the other four workspaces are full-width pages. */
    const view = state.view();
    shell.setAttribute("data-ws", VIEWS.find((v) => v.id === view)?.group ?? "");
    shell.setAttribute("data-rail", railOn() && state.view() === "chart" ? "on" : "off");
  });

  /**
   * THE WATCHLIST RAIL (v55).
   *
   * Created on first show and DESTROYED when hidden, not merely hidden by CSS:
   * the rail polls quotes every 15s while it exists, and a display:none rail
   * would keep doing that behind a desk nobody is looking at.
   *
   * The list is the Watchlist desk's own signal — one list, one owner — which
   * builds that desk on first use of the rail; it is a signal and a KV read.
   *
   * Setups: the chart's own symbol reads the live verdict (the same
   * `setupView` the inspector renders); every other symbol reads the latest
   * Opportunities scan, and only if one has run (`screener.built()`), so the
   * rail never starts a scan of its own. A symbol neither source knows says
   * nothing rather than "no setup".
   */
  const railSetups = computed(() => {
    const out = new Map<string, { label: string; direction: "long" | "short"; live: boolean }>();
    if (screener.built()) {
      for (const row of screener().rows()) {
        const o = opportunityOf(row);
        if (!o) continue;
        out.set(row.symbol, {
          label: `${o.direction === "long" ? "Long" : "Short"} · ${o.label}`,
          direction: o.direction,
          live: !o.history.adverse,
        });
      }
    }
    const sv = setupView();
    if (sv && !sv.setupRefusal && sv.plan) {
      const k = sv.verdict.kind;
      const word = k === "go" ? "gates pass" : k === "armed" ? "armed" : k === "conflict" ? "macro disagrees" : k === "stand-down" ? "stand down" : "not checked";
      out.set(state.symbol(), {
        label: `${sv.plan.direction === "long" ? "Long" : "Short"} · ${word}`,
        direction: sv.plan.direction,
        live: k === "go" || k === "armed",
      });
    }
    return out as ReadonlyMap<string, { label: string; direction: "long" | "short"; live: boolean }>;
  });
  let rail: ReturnType<typeof createWatchRail> | null = null;
  effect(() => {
    const want = railOn() && state.view() === "chart";
    if (want && rail === null) {
      rail = createWatchRail({
        symbols: watchlist().list,
        active: state.symbol,
        onPick: (sym) => state.symbol.set(sym.toUpperCase()),
        setups: railSetups,
      });
      railArea.appendChild(rail.el);
    } else if (!want && rail !== null) {
      rail.destroy();
      rail.el.remove();
      rail = null;
    }
  });

  // ---- chart lifecycle ----------------------------------------------------

  if (chartHost) {
    chart = new ChartEngine(chartHost);
    chart.onCursor = (c) => cursor.set({ ...c });
    /* The engine re-fits the pane stack on every resize, and the shell has no
       other way to learn that a pane it asked for is not being drawn. */
    chart.onPaneFit = (dropped) => panesDropped.set([...dropped]);
    /* Fires on every pan frame near the left edge; `loadOlder` is idempotent
       and returns immediately when a fetch is already in flight. */
    chart.onNeedHistory = () => void loadOlder();

    /**
     * Restore the band, then keep the handle glued to it.
     *
     * A `renderEffect` rather than a one-shot: the boundary moves whenever the
     * chart is re-laid out — a resized window, an opened dock, focus mode — and
     * a handle that only got placed at boot would sit in the middle of the
     * candles the first time any of those happened.
     */
    chart.setVolume(volumeOn.peek());
    chart.setVolumeHeight(volumeHeight.peek());

    renderEffect(() => {
      const on = volumeOn();
      const px = volumeHeight();
      if (!chart) return;
      chart.setVolume(on);
      if (on) chart.setVolumeHeight(px);
      placeVolResizer();
    });

    /* The host resizing does not change either signal, so the effect above
       would not re-run — but the boundary has moved. */
    new ResizeObserver(() => placeVolResizer()).observe(chartHost);
  }

  /**
   * Drawing input.
   *
   * Listens on the chart HOST in the capture phase, so it sees pointer events
   * before the chart's own crosshair and pan handlers and can decline them by
   * doing nothing. Panning a chart that has drawings on it behaves exactly as
   * it did before drawings existed. See ui/drawing.ts.
   */
  drawLayer = chartHost
    ? createDrawingLayer({
        host: chartHost,
        chart: () => chart,
        store: drawStore,
        symbol: () => state.symbol(),
        timeframe: () => state.timeframe(),
        tool: drawTool,
        magnet: drawMagnet,
        tone: drawTone,
        /* Disarm after one shape. Staying armed is how you end up with four
           trendlines you did not mean to draw. */
        onFinish: () => drawTool.set(null),
      })
    : null;

  /**
   * Right-click on the chart.
   *
   * The terminal had exactly ONE `oncontextmenu` handler across twenty-seven UI
   * modules before this, so the single most-used surface in the application
   * answered a right-click with nothing. Every item here is a command id, so
   * titles and accelerators come from the registry and cannot drift.
   *
   * The price under the pointer is the whole point: "alert me HERE" is a
   * different, faster thought from "open the Signals desk, add an alert, type
   * the level I was just looking at".
   */
  if (chartHost) {
    attachContextMenu({
      host: chartHost,
      ctx: { commands, keymap },
      resolve: (e) => chartPoint(e, chartHost as HTMLElement, chart?.viewport ?? null),
      items: (point) => {
        const price = point.price;
        const shown = price >= 1000 ? price.toFixed(2) : price.toFixed(5);
        const last = bars.peek()[bars.peek().length - 1]?.c ?? price;
        const above = price >= last;
        return [
          { kind: "header", label: `${state.symbol()} at ${shown}` },
          {
            /* The direction is inferred from where price is NOW, so the alert
               means "tell me when it gets here" rather than firing on the next
               bar because the level was already crossed. */
            label: above ? "Alert me when price rises to here" : "Alert me when price falls to here",
            run: () => {
              const now = Date.now();
              alertStore.add({
                id: alertId(now),
                symbol: state.symbol.peek(),
                timeframe: state.timeframe.peek(),
                anchor: { kind: "price", price },
                condition: above ? "cross-above" : "cross-below",
                once: true,
                cooldownBars: 0,
                enabled: true,
                createdAt: now,
                note: "",
              });
              toaster.push({
                level: "success",
                title: "Alert armed",
                body: `${state.symbol.peek()} ${above ? "crosses above" : "crosses below"} ${shown}`,
                action: { label: "Signals desk", run: () => state.view.set("signals") },
              });
            },
          },
          {
            label: "Copy this price",
            run: () => void navigator.clipboard?.writeText(shown),
          },
          { kind: "separator" },
          { label: "Draw", items: DRAW_KINDS.map((k) => ({ id: `draw.${k.id}` })) },
          { id: "draw.magnet" },
          { kind: "separator" },
          /* The appearance switches, on the surface they change.
             A right-click on the chart is where someone asks "turn that off",
             and sending them to Settings for a two-state toggle they are
             pointing at is the long way round. These are the same command ids
             the palette and the Chart menu use, so a checkmark here cannot
             disagree with a checkmark there. */
          {
            label: "Appearance",
            items: [
              { id: "chart.grid" },
              { id: "chart.sessions" },
              { id: "chart.volume" },
              { kind: "separator" },
              ...CHART_STYLES.map((k) => ({ id: `chart.kind.${k.id}` })),
              { kind: "separator" },
              { id: "chart.logScale" },
            ],
          },
          { label: "Moving averages", items: MA_SET.map((ma) => ({ id: `chart.${ma.id}` })) },
          { kind: "separator" },
          { id: "chart.goLive" },
          { id: "chart.reload" },
          { id: "chart.exportPng" },
          { id: "chart.copySummary" },
        ];
      },
    });
  }

  /**
   * Macro context loads itself.
   *
   * Deferred off the critical path with `requestIdleCallback` — the chart is
   * what the user is waiting for, and a calendar fetch racing it for the
   * governor's budget delays the thing they actually asked to see. Both loads
   * are cached in the network layer, so the refresh button below is a way to
   * force the issue rather than the only way to get data.
   */
  const idle =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback
      : (fn: () => void) => window.setTimeout(fn, 1500);
  idle(() => refreshMacro());

  /**
   * And again, on a timer, because the tape claims to be live.
   *
   * `refreshMacro` used to run exactly once per session, which was fine when
   * its only consumers were two panels you opened deliberately. The tape is on
   * screen the whole time and says "in 4 min" about a release — a countdown
   * against a calendar fetched hours ago is a countdown to an event that may
   * already have been revised or cancelled.
   *
   * Five minutes, and both lanes are cached in the network layer, so a tab
   * left open overnight costs a few hundred requests rather than a few
   * thousand. Skipped while the tab is hidden: a background tab is not reading
   * the tape, and the refresh on becoming visible again is what matters.
   */
  const MACRO_REFRESH_MS = 5 * 60_000;
  setInterval(() => {
    if (document.hidden) return;
    refreshMacro();
  }, MACRO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMacro();
  });

  // Theme changes must reach the canvas: it caches resolved colours because
  // reading computed style per frame would be absurd.
  effect(() => {
    state.theme();
    /* The palette is read here too, so changing a candle colour repaints through
       the same path a theme change does. `applyPalette` writes the custom
       properties FIRST; `themeFromCss` then reads the resolved values, which is
       why the override needs no argument of its own. */
    applyPalette({ up: state.candleUp(), down: state.candleDown() });
    queueMicrotask(() => chart?.setTheme(themeFromCss()));
  });

  effect(() => chart?.setKind(state.chartKind()));

  // Indicators recompute only when bars, selection or theme change — not on
  // every repaint. EMA over 800 bars is trivial, but the same effect will carry
  // the heavier studies later, and doing it in the paint path would not scale.
  renderEffect(() => {
    const series = bars();
    const selected = state.mas();
    const studies = state.studies();
    const anchorTime = avwapAnchorTime();
    state.theme();
    if (!chart) return;

    if (series.length === 0) {
      chart.setOverlays([]);
      return;
    }

    const close = Float64Array.from(series, (b) => b.c);
    const css = getComputedStyle(document.documentElement);
    const colour = (token: string, fallback: string): string =>
      css.getPropertyValue(token).trim() || fallback;
    const overlays: LineOverlay[] = [];

    for (const ma of MA_SET) {
      if (!selected.includes(ma.id)) continue;
      overlays.push({
        id: ma.id,
        values: ema(close, ma.period),
        color: colour(ma.token, "#4C82FB"),
      });
    }

    /* The registry, which is where every study added after the first three
       EMAs lives. Skipped entirely when nothing is enabled, so the common case
       costs one array comparison rather than nine indicator passes. */
    if (studies.length > 0) {
      const cols = studyColumns(series);
      const anchorIndex = anchorTime === null ? null : indexAtOrAfter(series, anchorTime);
      for (const line of runStudies(studies, { ...cols, colour, anchorIndex }, state.studyParams())) {
        overlays.push(line);
      }
    }

    chart.setOverlays(overlays);
  });

  /**
   * The pane stack, in its own effect.
   *
   * Separate from the overlay effect above rather than folded into it, because
   * `setPanes` changes the BOTTOM INSET and therefore the height of the price
   * plot. Recomputing the panes every time a moving average is toggled would
   * resize the price plot for a change that has nothing to do with it, and the
   * whole chart would jump.
   */
  renderEffect(() => {
    const series = bars();
    const enabled = state.panes();
    state.theme();
    if (!chart) return;

    if (series.length === 0 || enabled.length === 0) {
      chart.setPanes([]);
      return;
    }

    const css = getComputedStyle(document.documentElement);
    const colour = (token: string, fallback: string): string =>
      css.getPropertyValue(token).trim() || fallback;
    const cols = studyColumns(series);
    chart.setPanes(
      runPanes(enabled, { h: cols.h, l: cols.l, c: cols.c, v: cols.v, colour }, state.studyParams()),
    );
  });

  renderEffect(() => {
    /* Detected structures and hand-drawn ones go through the SAME annotation
       path, so they pan, zoom and re-theme together and are pixel-identical.
       `draft` is read so the shape following the cursor repaints while a
       drawing is being placed. */
    const detected = drawn().flatMap((d) => d.shapes);
    drawLayer?.draft();
    /* The Setup card's plan, on the chart: entry zone, stop, both targets.
       Dashed and labelled "(not live)" when the gates do not clear it. Drawn
       first so detected and hand-drawn shapes sit on top of it. */
    const sv = setupView();
    const plan = sv ? planShapes(sv.plan, bars().length - 1, sv.setupRefusal ? "unknown" : sv.verdict.kind) : [];
    chart?.setAnnotations([...plan, ...detected, ...(drawLayer?.shapes() ?? [])]);
  });

  renderEffect(() => {
    const series = bars();
    /* THE KEY, NOT THE LENGTH. Read before the `chart` guard so this effect
       registers its dependencies whichever branch it takes — the mistake this
       file has made before, where an early return above the first signal read
       left an effect that never ran again.

       Replay is part of the identity: stepping through history is a different
       series from the live one even on the same instrument and timeframe, and
       starting or stopping it should put the view back at the cursor rather
       than leave it wherever the other mode had scrolled to. */
    const key = `${feed.loadedSymbol()}|${feed.loadedTimeframe()}|${replay.active() ? "replay" : "live"}`;
    if (!chart) return;
    chart.setSeries(series, key);
  });

  /**
   * The chart legend.
   *
   * WHY IT READS THE LAST BAR WHEN THE CURSOR IS AWAY
   * It used to show O/H/L/C only while the pointer was over the plot, and
   * `SYMBOL · TF` the rest of the time. But the resting state is the state the
   * chart is in almost always — while you read the Setup card, while you size a
   * position, while you do anything other than actively scrub — and in that
   * state the four numbers a price chart exists to report were not on screen.
   * Every terminal worth the name defaults them to the newest bar, and the
   * pointer then overrides that per bar. The cursor path below is unchanged;
   * what changed is that there is now something to override.
   *
   * THE CHANGE IS AGAINST THE PREVIOUS CLOSE, NOT THE OPEN
   * `close - open` is the candle's own body and is already drawn — it is the
   * thing you can see. What cannot be seen is where this bar sits against the
   * last one, which is what "-70.7 (-0.09%)" answers and what every quote in
   * the world means by "change".
   */
  renderEffect(() => {
    const scale = state.priceScale();
    if (chart) chart.setPriceScale(scale);
  });

  /**
   * Session bands behind the candles.
   *
   * THREE CONDITIONS, AND EACH REMOVES A LIE RATHER THAN SAVING WORK.
   *
   *  - ABOVE 4h THERE ARE NO BANDS. A daily candle spans every session there
   *    is, so tinting it by the session its open happened to fall in would be
   *    a confident-looking falsehood — and the higher the timeframe the more
   *    confident and the more false.
   *  - EQUITIES GET NONE. `SESSIONS` are the FX day (Sydney, Tokyo, London,
   *    New York). A US stock does not trade the Tokyo session, and shading one
   *    as though it did is worse than shading nothing.
   *  - THE OVERLAP IS NOT A FOURTH BAND. London and New York overlap for four
   *    hours and the washes simply add, so the busiest part of the day comes
   *    out darkest on its own. Painting a separate "overlap" colour would be
   *    inventing a fifth session that does not exist.
   */
  /* The grid is a pure view preference — nothing about the data changes — so it
     is its own effect rather than a branch inside the session one. */
  renderEffect(() => {
    const on = state.gridOn();
    if (chart) chart.setGrid(on);
  });

  renderEffect(() => {
    const tf = state.timeframe();
    const symbol = state.symbol();
    if (!chart) return;

    const intraday = SESSION_TIMEFRAMES.has(tf);
    const cls = assetClass(symbol);
    const applies = cls === "forex" || cls === "metal" || cls === "crypto";
    if (!intraday || !applies || !state.sessionBands()) {
      chart.setSessions([]);
      return;
    }

    chart.setSessions(
      SESSIONS.map((w) => ({
        id: w.id,
        openUtc: w.openUtc,
        closeUtc: w.closeUtc,
        /* One wash for all four. They differ by WHEN, not by kind, and four
           colours would read as four categories of thing. */
        colour: sessionWash(),
      })),
    );
  });

  renderEffect(() => {
    const c = cursor();
    const series = bars();
    legend.textContent = "";
    if (series.length === 0) {
      legend.appendChild(h("span", { class: "legend-hint", text: `${state.symbol()} · ${state.timeframe()}` }));
      return;
    }

    const hovering = c !== null && c.inside && c.index >= 0 && c.index < series.length;
    const index = hovering ? (c as CursorState).index : series.length - 1;
    const b = series[index];
    if (!b) return;

    const prev = index > 0 ? series[index - 1] : undefined;
    /* Against the previous close where there is one; against this bar's own
       open on the very first bar, where there is nothing else to compare to. */
    const ref = prev ? prev.c : b.o;
    const delta = b.c - ref;
    const pct = ref !== 0 ? (delta / ref) * 100 : 0;
    const up = delta >= 0;

    legend.appendChild(
      h("span", { class: "legend-sym", text: `${state.symbol()} · ${state.timeframe()}` }),
    );
    /* The venue, because "BTCUSDT" is a different price on different venues and
       the number being read is one of them. It lives in the status bar too, at
       the other end of the window from the price it qualifies. */
    const venue = feed.activeSource();
    if (venue && venue !== "—") {
      legend.appendChild(h("span", { class: "legend-venue", text: venue }));
    }

    for (const [k, v] of [
      ["O", b.o],
      ["H", b.h],
      ["L", b.l],
      ["C", b.c],
    ] as const) {
      legend.appendChild(h("span", { class: "legend-key", text: k }));
      legend.appendChild(
        h("span", { class: "legend-val num", "data-dir": up ? "up" : "down", text: fmt(v) }),
      );
    }

    legend.appendChild(
      h("span", {
        class: "legend-chg num",
        "data-dir": up ? "up" : "down",
        text: `${up ? "+" : "−"}${fmtLike(Math.abs(delta), b.c)} (${up ? "+" : "−"}${Math.abs(pct).toFixed(2)}%)`,
        title: "Change against the previous bar's close.",
      }),
    );

    /* The forecast band stays, but only at rest: while scrubbing, the legend is
       reporting a bar that has already happened and a forecast of the next one
       has nothing to do with it. */
    if (!hovering) {
      const band = replay.active() ? null : nextBarBand();
      if (band !== null) {
        legend.appendChild(
          h("span", {
            class: "legend-fc",
            "data-ok": band.calibrated ? "true" : "false",
            text: band.calibrated
              ? `next bar 80% range ${fmt(band.low)}–${fmt(band.high)}`
              : `next bar range ${fmt(band.low)}–${fmt(band.high)} · uncalibrated`,
            title: band.calibrated
              ? "Where the next close is expected to land, at 80% confidence, from the volatility model. It is a size forecast, not a direction call — the band is symmetric by construction."
              : "The volatility model failed its own calibration replay on this history: its 80% intervals did not contain 80% of outcomes. Shown so it is not silently absent, drawn muted so it is not read as checked.",
          }),
        );
      }
    }
  });

  // ---- deeper history, on demand ------------------------------------------
  /**
   * Older bars when the operator pans back to the edge of what is loaded.
   *
   * The guards, the exhaustion set and the re-entrancy latch live in
   * `data/backfill.ts` — ninety lines of async control flow that were unreachable
   * from a test while they sat inside this function. What stays here is the
   * wiring: which signals it reads and where its progress is shown.
   */
  const backfiller = createBackfiller({
    loadedSymbol: () => feed.loadedSymbol(),
    loadedTimeframe: () => feed.loadedTimeframe(),
    barCount: () => bars().length,
    oldestBarTime: () => bars()[0]?.t ?? null,
    replayActive: () => replay.active(),
    backfill: (symbol, tf, target) => feed.history.backfill(symbol, tf, target),
    reload: (symbol, tf, limit) => feed.loadSymbol(symbol, tf, limit),
    note: (e) =>
      feed.log.record({
        kind: "notice",
        source: feed.activeSource(),
        symbol: e.symbol,
        timeframe: e.timeframe,
        ok: e.ok,
        text: e.text,
      }),
    setPending: (on) => olderPending.set(on),
  });

  const loadOlder = (): Promise<void> => backfiller.loadOlder();

  /* A changed instrument is a fresh question: whatever the last one ran out of
     says nothing about this one. */
  effect(() => {
    backfiller.reset(feed.loadedSymbol(), feed.loadedTimeframe());
  });


  // ---- data loading -------------------------------------------------------

  /**
   * Fetch the evidence the read is made of, without being asked.
   *
   * THE MEASUREMENT THAT FORCED THIS
   * The Setup card reported "24% of sources answered" on a healthy BTCUSDT 1m
   * chart, and the reason was not that the sources failed. It was that nobody
   * had asked them. `runIntel()` — regime and forecast — was reachable only
   * from a button in the Regime panel. `refreshDecision()` — cross-venue spread
   * and the whole derivatives block — ran only when you opened the Decision
   * desk. Measured on a fresh load, with the optional lanes cold:
   *
   *     expected weight   6.9   every source the read declares
   *     answered          0.75  confluence, thinning, coiled
   *     coverage          13%
   *
   * Six sources worth 2.5 of that 6.9 — regime 0.5, forecast 0.4, derivatives
   * 0.7, venue 0.3, correlation 0.3, calendar 0.3 — were sitting behind panels
   * the user had not opened. A third of the evidence the terminal already knows
   * how to fetch, absent from every read, permanently, unless you happened to
   * click the right tab first.
   *
   * That is not a thin market. That is a terminal not asking its own questions.
   *
   * WHY IT IS DEFERRED AND NOT SIMPLY CALLED
   * The chart is what the user is waiting for. These lanes go through the same
   * governor budget, so firing them alongside the bar load delays the thing
   * that was actually requested. `idle` puts them behind the first paint; the
   * governor's own queue does the rest.
   *
   * WHY IT IS NOT UNCONDITIONAL
   * `evidenceAuto` is a preference (Settings ▸ Data). Someone on a metered connection, or with
   * the intelligence service deliberately off, gets a read that says 13% and
   * MEANS it, rather than one that quietly spends their bandwidth. The default
   * is on, because a read that does not consult what it has is the worse
   * failure of the two.
   */
  /**
   * The evidence lanes, and the thing that keeps them alive.
   *
   * ONE ATTEMPT WAS NOT ENOUGH; NOR WERE THREE.
   * The first `warmEvidence` asked once per symbol load. The second retried at
   * 6s, 20s and 60s and then stopped for ever. Both were warm-ups, and the
   * failure the operator kept hitting is not a cold start — it is a service
   * that goes away at eleven o'clock and comes back at noon, or an answer that
   * was fetched an hour ago and no longer describes the chart. Measured on
   * XAUUSD: 71% coverage with the model lanes answering against a 60% floor,
   * low thirties without them, and the card saying STAND DOWN with no way for
   * the operator to know why or what to do.
   *
   * `setup/supervisor.ts` owns the retrying now — for as long as the terminal
   * is open, on a backoff that widens to five minutes, per lane, and reporting
   * which lanes are waiting so the card can say so out loud.
   *
   * `evidenceAuto` (Settings ▸ Data) still governs the whole thing. Someone on
   * a metered connection, or with the intelligence service deliberately off,
   * gets a read that says 34% and MEANS it rather than one that quietly spends
   * their bandwidth.
   */
  /* `evidence`, not `supervisor`: data/net already exports a connection
     supervisor into this scope and two things with one name in a 7000-line
     file is how the wrong one gets called. */
  const evidence = createSupervisor({
    lanes: [
      {
        id: "models",
        label: "Regime and forecast",
        /* One lane for two reads because they are one request. Splitting them
           would double the traffic to a service that answers both together. */
        applies: () => true,
        answeredAt: () => intelAnsweredAt(),
        refresh: () => runIntel(),
        /* Fifteen minutes is fifteen new bars on a one-minute chart. A regime
           fitted on a series that far behind is describing a chart that is no
           longer on screen. */
        maxAgeMs: 15 * 60_000,
      },
      {
        id: "dealing",
        label: "Dealing spread",
        applies: () => !looksCrypto(state.symbol()),
        answeredAt: () => {
          const q = brokerQuote();
          return q && q.ok ? q.asOf : null;
        },
        refresh: () => refreshDecision(),
        /* A spread is the cost of entering NOW. Three minutes old is already a
           historical fact — see MAX_QUOTE_AGE_MS in data/brokerquote.ts. */
        maxAgeMs: 3 * 60_000,
      },
      {
        id: "book",
        label: "Top of book",
        applies: () => looksCrypto(state.symbol()),
        answeredAt: () => {
          const q = brokerQuote();
          return q && q.ok ? q.asOf : null;
        },
        refresh: () => refreshDecision(),
        maxAgeMs: 3 * 60_000,
      },
      {
        id: "derivatives",
        label: "Derivatives",
        /* Absent, not failed, on anything the venues do not list. Retrying
           would ask an unanswerable question about gold for ever, and the
           measured cost of asking was four requests per symbol change to a
           futures API that answers too-much with a lengthening ban. */
        applies: () => looksCrypto(state.symbol()),
        answeredAt: () => {
          const d = derivatives();
          return d && d.read ? d.asOf : null;
        },
        refresh: () => refreshDecision(),
      },
      {
        id: "crossVenue",
        label: "Cross-venue",
        applies: () => looksCrypto(state.symbol()),
        answeredAt: () => spreadAt(),
        refresh: () => refreshDecision(),
      },
      {
        id: "calendar",
        label: "Economic calendar",
        /* Supervised even though `refreshMacro` already runs on a timer: the
           embargo gate and the tape both stand on this, and the timer has no
           idea whether the fetch it fired actually produced anything. */
        applies: () => true,
        answeredAt: () => {
          const c = calendar();
          return c && c.ok ? c.asOf : null;
        },
        refresh: () => loadCalendar().then((r) => calendar.set(r)),
        maxAgeMs: 10 * 60_000,
      },
    ],
    visible: () => !document.hidden && evidenceAuto(),
    onChange: (status) => evidenceStatus.set(status),
  });

  /**
   * Point the supervisor at whatever is on screen.
   *
   * Keyed on symbol AND timeframe: a regime fitted on the hourly says nothing
   * about the minute chart, and the previous instrument's failures say nothing
   * about this one. Same argument as `heldPlanKey` and the chart's series key.
   */
  effect(() => {
    const key = `${state.symbol()}|${state.timeframe()}`;
    if (!evidenceAuto()) return;
    evidence.watch(key);
    /* `poke` as well as `watch`, because `watch` short-circuits on an unchanged
       key — which is exactly the case when this effect re-runs because the
       operator just switched the preference back ON. Without it, turning
       auto-fetch on did nothing until the next symbol change. Idempotent: any
       lane already in flight is skipped. */
    evidence.poke();
  });

  /* Coming back to the tab is the single most likely moment for a lane to be
     both stale and fixable, and the operator is about to read the card. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) evidence.poke();
  });

  async function loadData(): Promise<void> {
    loading.set(true);
    const symbol = state.symbol();
    const tf = state.timeframe();
    // Binance first because it needs no local process; the proxy second because
    // it covers everything Binance does not (forex, equities, metals).
    // One call: the registry handles failover across sources, and the archive
    // answers instantly when it holds something current.
    const ok = await feed.loadSymbol(symbol, tf, 800);
    // startLive is a no-op for sources with no socket, so it never leaves the
    // terminal claiming live updates it will not receive.
    if (ok) feed.startLive(symbol, tf);
    else feed.stopLive();
    loading.set(false);
    /* After the bars, because `runIntel` reads them. A regime fitted on an
       empty series is not a regime. */
    /* The bars are what `runIntel` fits on, so the supervisor is told to look
       again only once they have landed. `poke` rather than `watch`: the key has
       not changed, and a fresh series is exactly the "conditions have changed"
       that should ignore any backoff already earned. */
    if (ok) evidence.poke();

    /**
     * Mark any claim these bars can settle.
     *
     * THIS IS WHY RESOLUTION IS NOT A LIVE WATCHER. A claim made three weeks
     * ago on an instrument you have not opened since gets marked the moment
     * you open it, from the same bars you are looking at. A watcher would only
     * ever resolve claims made while the terminal was open on the chart you
     * happened to be watching — which biases the track record towards the
     * instruments you watch most, and a track record with that bias in it is
     * measuring your attention rather than the terminal.
     *
     * Only ever the series just loaded, and never a replay slice: replay bars
     * are history the terminal already knows the answer to.
     */
    if (ok && !replay.active.peek()) {
      learn.resolvePending((sym, timeframe) =>
        sym === symbol.toUpperCase() && timeframe === tf ? feed.bars.peek() : [],
      );
    }
  }

  effect(() => {
    state.symbol();
    state.timeframe();
    void loadData();
  });

  // ---- volume pane --------------------------------------------------------

  /**
   * Park the handle on the boundary the engine reports.
   *
   * Called after anything that could move it — a drag, a toggle, a window
   * resize, a repaint. Reading `volumeTop()` rather than recomputing the same
   * arithmetic here is the point: two places deriving one boundary is how the
   * pane and the axis collided the first time this was built.
   */
  function placeVolResizer(): void {
    if (!volResizer || !chart) return;
    if (!volumeOn.peek()) {
      volResizer.hidden = true;
      return;
    }
    volResizer.hidden = false;
    volResizer.style.top = `${Math.round(chart.volumeTop())}px`;
  }

  function startVolumeResize(evt: Event): void {
    const e = evt as PointerEvent;
    e.preventDefault();
    e.stopPropagation();
    if (!chart) return;
    const startY = e.clientY;
    const startH = chart.getVolumeHeight();
    shell.setAttribute("data-resizing", "volume");

    /* Dragging the handle UP makes the band taller, so the delta is inverted.
       Getting this backwards is the classic version of this control. */
    const onMove = (ev: PointerEvent): void => setVolumeHeight(startH - (ev.clientY - startY));
    const onUp = (): void => {
      shell.removeAttribute("data-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ---- dock resize --------------------------------------------------------

  function startDockResize(evt: Event): void {
    const e = evt as PointerEvent;
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(shell).getPropertyValue("--w-dock")) || 360;
    shell.setAttribute("data-resizing", "dock");

    const onMove = (ev: PointerEvent): void => {
      const next = clampNum(startW - (ev.clientX - startX), 260, 720);
      shell.style.setProperty("--w-dock", `${next}px`);
    };
    const onUp = (): void => {
      shell.removeAttribute("data-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ---- keyboard -----------------------------------------------------------

  /**
   * The keyboard is `keymap`, attached above — this listener handles only the
   * one case that is not a command: Escape leaving focus mode.
   *
   * It runs LAST on purpose. The overlay stack claims Escape in the capture
   * phase while anything is open, so pressing it with a menu up closes the menu
   * and leaves focus mode alone, which is what people expect.
   */
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (state.focus.peek() !== "off") state.focus.set("off");
  });

  // ---- dev inspection ------------------------------------------------------
  // Stripped from production builds by the `import.meta.env.DEV` guard. Having
  // a handle on the live feed and chart from the console is the difference
  // between diagnosing a render stall in a minute and guessing at it.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>)["__iram"] = {
      feed,
      state,
      get chart() {
        return chart;
      },
      lastBar: () => {
        const list = bars.peek();
        return list.length ? list[list.length - 1] : null;
      },
      /* The setup engine's whole field, not just the winner. Checking that a
         selector REFUSES often enough to mean anything is not something the
         card can show — it only ever renders one answer. */
      get setup() {
        return setupLast.choice;
      },
      /* The replayed trials, in full. The card shows a summary; measuring
         whether the simulator is being honest needs the individual outcomes —
         particularly the `unknowable` ones, which are the first thing a
         backtest quietly loses. */
      get sim() {
        return setupLast.sim;
      },
      /* Everything the detectors currently report, which is NOT the same as
         everything they ever found — see the note on walk-forward replay in
         setup/simulate.ts. Exposed because telling those two apart from the
         outside is impossible without it. */
      get detections() {
        return detections();
      },
      /* The deep pass, with its own bar count. The card only ever shows one
         setup's base rate; checking that the pass ran at all, and over how much
         history, is impossible from the outside without this. */
      get deep() {
        const r = deepReplay.result();
        return r === null
          ? null
          : { ...r, sims: Object.fromEntries([...r.sims].map(([k, v]) => [k, v])) };
      },
      deepen: () => deepReplay.deepen(state.symbol(), state.timeframe(), setupLast.rMultiple),
      /* The engine's pick and the replay's pick, side by side. Checking that
         they are ALLOWED to disagree is not something the card can show — it
         only renders the disagreement when there is one. */
      get recommendation() {
        return setupLast.rec;
      },
      /* Whether the track record is actually being made durable. "Unreachable"
         is the normal state and has to be distinguishable from "mirrored", or
         somebody believes they have a backup they do not have. */
      get ledger() {
        return ledger.status();
      },
      /* Live reactions. The cost of a desk that is built and never opened is
         invisible in the element tree — it is detached DOM — but every one of
         its effects still re-runs on every tick. This is the only place that
         cost is countable. */
      get reactions() {
        return reactionCount();
      },
      /* The analyst's window, callable without a model on the other end.
         Nothing unit-tests `mountShell`, so the wiring of these accessors —
         which is where `see_chart` was broken for want of a type — can only
         be exercised live, and this is the handle for doing it. */
      terminalAccess,
      /* Standing briefs, and the count of paid checks each has cost. The cost
         is the whole risk of the feature, so it has to be inspectable without
         opening a desk. */
      get briefs() {
        return analyst.briefStore.briefs();
      },
      get briefTranscript() {
        return analyst.briefTranscript();
      },
      brief: {
        add: (text: string) =>
          analyst.briefStore.add(text, state.symbol.peek(), state.timeframe.peek()),
        arm: (id: string) => analyst.briefStore.arm(id),
        disarm: (id: string) => analyst.briefStore.disarm(id),
        remove: (id: string) => analyst.briefStore.remove(id),
        tick: () => analyst.watcher.tick(),
      },
    };
  }

  // ---- clock --------------------------------------------------------------

  const clockEl = status.querySelector("#clock");
  const tickClock = (): void => {
    if (clockEl) clockEl.textContent = new Date().toISOString().slice(11, 19) + " UTC";
  };
  tickClock();
  window.setInterval(tickClock, 1000);
}

// -------------------------------------------------------------- helpers ---

