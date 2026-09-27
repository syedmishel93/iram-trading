/**
 * The decision section: cross-venue, derivatives, correlation, macro, drivers,
 * the forecast view, and the read those all feed.
 *
 * WHY THIS IS ITS OWN FILE
 * `mountShell` held 237 top-level declarations across 7,400 lines, and this was
 * 508 of them. The reason it had never been lifted out is that the obvious way
 * to do it — a single options object — needed twenty-one arguments, which moves
 * the coupling into a signature instead of removing it.
 *
 * MEASURED, and the measurement is what made this tractable: of those
 * twenty-one, eight were only ever mentioned in COMMENTS (`chart`, `data`,
 * `evidence`, `panel`, `shell`, `flow`, `connection`, `drawLayer`), and
 * `status` matched a property name on an unrelated object. The real surface is
 * thirteen — five of which are the foundation every section shares and now
 * arrive as `ctx`.
 *
 * So the honest interface is: the foundation, plus EIGHT things this section
 * borrows from its siblings. That list being short is the whole argument for
 * the split; if it had really been twenty-one, leaving it inline would have
 * been the better call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MOVED AND WHAT DID NOT
 *
 * Nothing about the behaviour. Every comment below was written where the code
 * lived and is carried across verbatim — including the three separate notes
 * about temporal dead zones, which are the reason the declaration ORDER inside
 * this function is load-bearing and must not be tidied.
 *
 * The section's outputs are returned rather than left in a closure, so what the
 * rest of the shell actually consumes is now twelve named values instead of
 * nineteen ambient ones.
 */

import { computed, effect, signal, untrack, type ReadSignal, type Signal } from "../../core/signal";
import type { GateRules } from "../../setup/rules";
import { calibration, forecastLine, forecastRange } from "../../analysis/forecast";
import { readLeading } from "../../analysis/leading";
import type { BarView } from "../../chart/series";
import { decide, type Decision } from "../../core/decision";
import type { EvidenceGroup } from "../../core/evidence";
import { loadBookTicker, type BookQuote } from "../../data/bookticker";
import { loadBrokerQuote } from "../../data/brokerquote";
import { currenciesFor, releaseRisk, type CalendarFeed } from "../../data/calendar";
import { buildMatrix, type CorrelationMatrix } from "../../data/correlation";
import {
  loadFunding,
  loadLongShort,
  loadOpenInterest,
  loadTakerFlow,
  readDerivatives,
  type DerivRead,
} from "../../data/derivs";
import { driversFor } from "../../data/drivers";
import { forecastStanding, type ForecastRead, type IntelResult, type RegimeRead } from "../../data/intel";
import { MACRO_LANE, macroEvidence, macroLine, readMacro } from "../../data/macro";
import { loadSpread, type SpreadRead } from "../../data/spread";
import { looksCrypto } from "../../data/venues";
import { derive as deriveFundamentals, type FundamentalsService } from "../../data/fundamentals";
import { confluence, toScanBars } from "../../scan/confluence";
import type { Detection } from "../../detect/types";
import { createDecisionDesk } from "../decision";
import { createScreener, type ScreenerWatch } from "../screener";
import type { Slot } from "../../store/kv";
import {
  createWatchLoop,
  DEFAULT_WATCH_PREFS,
  notifiable,
  parseWatchPrefs,
  toastText,
  WATCH_DELAY_MS,
  WATCH_OFF,
  type WatchPrefs,
  type WatchState,
} from "../../scan/watch";
import { notifyPermission, requestNotifyPermission } from "../../alert/notify";
import type { LazyDesk, ShellContext } from "./context";

/**
 * What this section borrows from its siblings.
 *
 * Every one is a signal or a handle owned elsewhere in the shell. They are
 * parameters rather than context members because only this section wants them —
 * a context that absorbed them would be the original closure with extra steps.
 */
export interface DecisionSectionDeps {
  /** The chart's bars, replay-aware. Owned by the chrome section. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /** The economic calendar read, or null before it lands. */
  readonly calendar: Signal<CalendarFeed | null>;
  /** Detector output for the current chart, including projected higher frames. */
  readonly detections: ReadSignal<Detection[]>;
  readonly forecast: Signal<IntelResult<ForecastRead> | null>;
  readonly regime: Signal<IntelResult<RegimeRead> | null>;
  /**
   * The fundamentals store.
   *
   * The REAL service type, not a hand-written `{ find(): … }` stub. The first
   * draft stubbed it and the compiler caught it immediately: a thin shape
   * satisfies the call site and then fails to satisfy `derive`, which wants the
   * whole row. Narrowing a dependency by retyping it is how two files come to
   * disagree about what a record contains.
   */
  readonly fundamentals: FundamentalsService;
  /**
   * How many positions are open, for the correlation read's exposure count.
   *
   * A NUMBER, not a position list, and not the hand-written
   * `{ positions(): readonly unknown[] }` stub this replaces. Only the count
   * was ever used, the stub narrowed a real dependency to satisfy one call
   * site — the thing CLAUDE.md forbids and that has caused three defects here
   * — and it named the Risk desk, which is no longer where the answer comes
   * from. The truth is the reconciled broker book; this asks for the fact it
   * needs and lets the caller decide where that comes from.
   */
  readonly openPositions: () => number;
  /**
   * The watchlist, LATE-BOUND on purpose.
   *
   * It is declared after this section, so it arrives as a thunk rather than a
   * value: the screener's "add these" handler runs long after assembly, and a
   * value captured here would have been `undefined`. The single genuine
   * forward reference in the whole section.
   */
  readonly watchlist: () => { addMany(symbols: readonly string[]): number };
  /**
   * The operator's gate rules. The opportunity finder plans every symbol with
   * the same stop band the Setup card uses, or a row and the card would
   * disagree about the same chart.
   */
  readonly rules: ReadSignal<GateRules>;
}

/** What the rest of the shell consumes. Twelve values, all of them read. */
export interface DecisionSection {
  readonly spread: Signal<SpreadRead | null>;
  readonly spreadAt: Signal<number | null>;
  readonly brokerQuote: Signal<BookQuote | null>;
  readonly derivatives: Signal<{ read: DerivRead | null; asOf: number; error?: string } | null>;
  readonly decision: ReadSignal<Decision>;
  readonly decisionBusy: Signal<boolean>;
  readonly refreshDecision: () => Promise<void>;
  readonly macroReads: () => ReturnType<typeof readMacro>;
  readonly driverBars: Signal<ReadonlyMap<string, readonly BarView[]>>;
  readonly loadDrivers: () => Promise<void>;
  readonly screener: LazyDesk<ReturnType<typeof createScreener>>;
  readonly decisionDesk: LazyDesk<ReturnType<typeof createDecisionDesk>>;
}

export function createDecisionSection(
  ctx: ShellContext,
  d: DecisionSectionDeps,
): DecisionSection {
  const { state, kv, feed, toaster, lazyDesk } = ctx;
  const { bars, calendar, detections, forecast, regime, fundamentals, openPositions, watchlist } = d;


  /**
   * The cross-venue and correlation reads.
   *
   * Both cost requests, so neither is on a timer: they refresh when the desk is
   * opened or the button is pressed. A synthesis that silently re-polls four
   * venues every few seconds would spend the request budget the chart needs.
   */
  const spread = signal<SpreadRead | null>(null);
  /**
   * The broker's live bid-ask, for instruments the broker actually quotes.
   *
   * A DIFFERENT MEASUREMENT from `spread` above, and the two must never be
   * merged — see data/brokerquote.ts. `spread` is a cross-venue basis and
   * answers "is this quote odd"; this is the dealing spread and answers "what
   * does entering cost me", which is the question the spread gate asks.
   */
  const brokerQuote = signal<BookQuote | null>(null);
  const correlationMatrix = signal<CorrelationMatrix | null>(null);
  const derivatives = signal<{ read: DerivRead | null; asOf: number; error?: string } | null>(null);
  const decisionBusy = signal(false);

  /** When the cross-venue read last landed. `SpreadRead` carries no timestamp. */
  const spreadAt = signal<number | null>(null);

  /** The in-flight refresh, so a second caller joins it instead of being dropped. */
  let decisionRun: Promise<void> | null = null;

  /**
   * RETURNS A PROMISE NOW, AND THAT IS NOT COSMETIC.
   *
   * The supervisor decides whether a lane failed by looking at what is there
   * when its `refresh` resolves. A fire-and-forget refresh resolves instantly,
   * before anything has been fetched, so every lane would be counted as failed
   * on every sweep and the backoff would widen against a service that was
   * working perfectly. Joining an in-flight run rather than returning early is
   * the same argument: an immediate return is indistinguishable from a failure.
   */
  const refreshDecision = (): Promise<void> => {
    if (decisionRun) return decisionRun;
    decisionBusy.set(true);
    const symbol = state.symbol.peek();

    /**
     * BOTH LANES ARE CRYPTO-ONLY, AND ASKING ANYWAY IS NOT FREE.
     *
     * `loadFunding`, `loadOpenInterest`, `loadLongShort` and `loadTakerFlow`
     * are Binance FUTURES endpoints; `loadSpread` compares crypto venues. On
     * XAUUSD none of them can return anything, and until this guard existed the
     * terminal asked all five anyway — measured at seven outbound requests per
     * symbol change on a gold chart, four of them to `fapi.binance.com` about
     * an instrument Binance does not list.
     *
     * That was survivable while the refresh only ran when you opened the
     * Decision desk. The evidence supervisor now runs it on every symbol change, and the
     * browser console filled with 429s within a few switches. Binance answers
     * too-much with 429, then 418, and 418 is a ban that gets LONGER each time
     * you retry into it — so a rate limit earned by asking unanswerable
     * questions about gold would take out the crypto charts as well.
     *
     * Skipping is also the more honest result. An unasked lane reports `absent`
     * with its own accurate reason ("cross-venue pricing covers crypto pairs"),
     * where asking produced a `failed` — and `failed` means "fixable", which
     * this never was.
     */
    const cryptoLanes = looksCrypto(symbol);
    if (!cryptoLanes) {
      spread.set(null);
      derivatives.set(null);
      /* ONE local request instead of the five remote ones skipped above, and it
         answers the question the skipped ones could not: what this trade costs
         to enter, from the broker that fills it. */
      decisionRun = loadBrokerQuote(symbol)
        .then((q) => {
          if (state.symbol.peek() === symbol) brokerQuote.set(q);
        })
        .finally(() => {
          decisionBusy.set(false);
          decisionRun = null;
        });
      return decisionRun;
    }

    /**
     * THE OTHER HALF OF THE SAME FIX, AND THE LARGER HALF.
     *
     * `loadBrokerQuote` above gave MT5 instruments a real dealing spread and
     * left crypto on the cross-venue basis, because there was nothing else to
     * give it. There is now: the venue publishes its own top of book.
     *
     * Measured on BTCUSDT: the basis the gate was being fed read 0.059% where
     * the actual Binance bid-ask was $0.01 — a factor of four and a half
     * thousand. The gate refused a 134-point stop for a cost of $45 that
     * nobody was paying. See data/bookticker.ts for the whole measurement.
     *
     * Issued alongside the two lanes below rather than inside them: it is one
     * weight-2 request, it cannot fail them, and the spread gate is the gate
     * most likely to be the only thing standing between a read and a plan.
     */
    const book = loadBookTicker(symbol).then((q) => {
      if (state.symbol.peek() === symbol) brokerQuote.set(q);
    });

    const lanes = (async () => {
      /**
       * Both reads at once, and neither can sink the other.
       *
       * `allSettled`, not `all`: futures data does not exist for every spot
       * symbol, and a spot-only pair must still get its cross-venue read rather
       * than the whole refresh failing because there is no perpetual.
       */
      const [spreadResult, derivResult] = await Promise.allSettled([
        loadSpread(symbol),
        (async () => {
          const [funding, openInterest, longShort, takerFlow] = await Promise.all([
            loadFunding(symbol),
            loadOpenInterest(symbol),
            loadLongShort(symbol),
            loadTakerFlow(symbol),
          ]);
          return readDerivatives({ funding, openInterest, longShort, takerFlow });
        })(),
      ]);

      /* A symbol change mid-flight must not paint the old instrument's data
         onto the new one. */
      if (state.symbol.peek() !== symbol) return;

      spread.set(spreadResult.status === "fulfilled" ? spreadResult.value : null);
      spreadAt.set(spreadResult.status === "fulfilled" && spreadResult.value.ok ? Date.now() : null);

      derivatives.set(
        derivResult.status === "fulfilled"
          ? { read: derivResult.value, asOf: Date.now() }
          : {
              read: null,
              asOf: 0,
              error:
                derivResult.reason instanceof Error
                  ? derivResult.reason.message
                  : String(derivResult.reason),
            },
      );
    })();

    decisionRun = Promise.all([book, lanes])
      .then(() => undefined)
      .finally(() => {
        decisionBusy.set(false);
        decisionRun = null;
      });
    return decisionRun;
  };

  /* A new instrument invalidates the spread. Showing BTC's cross-venue basis
     while ETH is on screen is exactly the class of stale-context bug the
     freshness contract exists to prevent.

     The correlation matrix is NOT invalidated: it describes the watchlist, not
     the instrument, and it stays true when you look at a different member of
     that watchlist. */
  effect(() => {
    state.symbol();
    spread.set(null);
    spreadAt.set(null);
    derivatives.set(null);
    brokerQuote.set(null);
  });

  const screener = lazyDesk(() => createScreener({
    timeframe: state.timeframe,
    kv,
    stopRules: () => d.rules(),
    watch: watchUi,
    onPick: (symbol) => {
      state.symbol.set(symbol);
      state.view.set("chart");
    },
    /* The screener finds candidates; the watchlist keeps them. Wiring the two
       together here rather than in either desk keeps both ignorant of the
       other. */
    onAddToWatchlist: (symbols) => {
      const added = watchlist().addMany(symbols);
      toaster.push({
        level: added > 0 ? "success" : "info",
        title:
          added === 0
            ? "Already on the watchlist"
            : `Added ${added} to the watchlist`,
        ...(added < symbols.length
          ? { body: `${symbols.length - added} were already there.` }
          : {}),
        action: { label: "Watchlist", run: () => state.view.set("watchlist") },
      });
    },
  }));

  /**
   * "Watch for new setups" — the loop lives HERE, not in the desk.
   *
   * The desk is a `lazyDesk`, built on first open and kept; this section lives
   * as long as the shell. The whole point of watching is to be told while on
   * the chart, so the loop must survive every desk switch — and the shell's
   * "leaving the screener cancels its scan" effect only cancels the
   * OPERATOR's scans (see `ScreenerHandle.cancel`), never a watched one.
   *
   * A watched scan builds the desk if it has never been opened. That is the
   * price of reusing its scan, its `newSince` memory and its table rather than
   * keeping a second copy of each; it is paid only by someone who turned the
   * watch on, and never at boot (a restored watch waits `WATCH_DELAY_MS`).
   *
   * Teardown: switching it off clears the timer and aborts a watched scan in
   * flight. The section itself lives for the page, as every section does.
   */
  const WATCH_SLOT: Slot<WatchPrefs> = {
    key: "screener.watch",
    version: 1,
    fallback: () => DEFAULT_WATCH_PREFS,
    validate: parseWatchPrefs,
  };
  const watchPrefs = signal<WatchPrefs>(kv.get(WATCH_SLOT));
  const watchState = signal<WatchState>(WATCH_OFF);
  const desktopPerm = signal(notifyPermission());
  /** So a failing vendor produces ONE warning, not one per bar. */
  let watchFailing = false;

  const announce = (tf: string, fresh: Parameters<typeof notifiable>[0]): void => {
    const hits = notifiable(fresh, watchPrefs.peek());
    if (hits.length === 0) return;
    const text = toastText(tf, hits);
    const open = (): void => state.view.set("screener");
    /* The toaster is the notification centre too: every push lands in the
       bell's log, so a toast missed while reading the chart is not lost. */
    toaster.push({
      level: "info",
      title: text.title,
      body: text.body,
      key: `scan-watch:${tf}`,
      ttlMs: 12_000,
      action: { label: "Opportunities", run: open },
    });
    /* Desktop ONLY if already granted — never asked for here — and only when
       the page is not the focused window, where the toast already covers it. */
    if (notifyPermission() !== "granted" || document.hasFocus()) return;
    try {
      const n = new Notification(text.title, { body: text.body, tag: `iram-scan-watch:${tf}` });
      n.onclick = () => {
        window.focus();
        open();
        n.close();
      };
    } catch {
      /* Some browsers only allow notifications from a service worker. The
         toast and the log still carry it. */
    }
  };

  const watchLoop = createWatchLoop({
    clock: {
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      hidden: () => document.hidden,
    },
    delayMs: WATCH_DELAY_MS,
    timeframe: () => state.timeframe.peek(),
    scan: async () => {
      const out = await screener().scan("watch");
      if (out === null) return;
      if (out.error !== null) {
        if (!watchFailing) {
          toaster.push({
            level: "warn",
            title: "Watched scan failed",
            body: `${out.error}. Watching carries on and tries again at the next bar.`,
            key: "scan-watch-error",
          });
        }
        watchFailing = true;
        throw new Error(out.error);
      }
      watchFailing = false;
      if (!out.baseline) announce(out.timeframe, out.fresh);
    },
    abort: () => {
      if (screener.built()) screener().abortWatch();
    },
    onState: (s) => watchState.set(s),
  });

  const saveWatch = (next: WatchPrefs): void => {
    watchPrefs.set(next);
    kv.write(WATCH_SLOT, next);
  };

  const watchUi: ScreenerWatch = {
    state: () => watchState(),
    prefs: () => watchPrefs(),
    setOn: (on) => {
      saveWatch({ ...watchPrefs.peek(), on });
      if (on) watchLoop.start({ immediate: true });
      else watchLoop.stop();
    },
    setRule: (rule) => saveWatch({ ...watchPrefs.peek(), withinBars: rule.withinBars, requireEdge: rule.requireEdge }),
    desktop: () => desktopPerm(),
    requestDesktop: () => {
      void requestNotifyPermission().then((p) => desktopPerm.set(p));
    },
  };

  /* A new timeframe is a new bar clock. `untrack` so only the timeframe is a
     dependency; the loop reads the rest itself. */
  effect(() => {
    state.timeframe();
    untrack(() => watchLoop.retime());
  });
  document.addEventListener("visibilitychange", () => watchLoop.visibility());
  if (watchPrefs.peek().on) watchLoop.start({ immediate: false });

  /**
   * The decision layer lives BELOW the screener deliberately.
   *
   * `effect()` and `computed()` run immediately, and the correlation effect
   * reads `screener.rows()`. Declared above the screener it threw "Cannot
   * access 'screener' before initialization" on boot — the same temporal
   * dead zone that caught `drawLayer` in v43.1, and invisible to the type
   * checker for the same reason: the reference is inside a closure, so TS
   * cannot know when it runs.
   */
  /**
   * Correlation, built from series the screener has ALREADY fetched.
   *
   * `scanUniverse` retains trimmed closes for cross-symbol work and until now
   * discarded them. Building the matrix here costs no requests at all — which
   * is the only reason it can be recomputed freely rather than behind a button.
   */
  effect(() => {
    /**
     * GUARDED, because this effect was the last thing keeping the screener
     * eager.
     *
     * It reads `rows()`, so reaching through the thunk constructed the whole
     * desk at boot — for a matrix that is null until a scan has actually run,
     * which cannot happen before the operator opens it. `built()` is a signal,
     * so this re-runs by itself the moment the desk exists.
     */
    if (!screener.built()) {
      correlationMatrix.set(null);
      return;
    }
    const rows = screener().rows();
    const withCloses = rows.filter((r) => r.closes !== null && r.closes.length > 0);
    correlationMatrix.set(
      withCloses.length >= 2
        ? buildMatrix(
            withCloses.map((r) => ({
              symbol: r.symbol,
              closes: r.closes as { t: number; c: number }[],
            })),
          )
        : null,
    );
  });

  /**
   * The read itself.
   *
   * A `computed`, so it recomputes when any input signal changes and is cached
   * between readers — the desk, the status bar and the agent tool all read the
   * same object rather than each assembling their own.
   */
  /**
   * Declared HERE, above the `decision` computed that reads it.
   *
   * The third time this ordering has mattered in this file. A const read by an
   * effect or computed declared above it throws on that reader's first run,
   * and in `shell.ts` a thrown effect takes everything else in it down —
   * which is how a whole preferences snapshot once stopped persisting. Empty
   * until `loadMacro` is asked for, so the decision reads exactly as it did
   * before v49 for anyone who never opens the lane.
   */
  const macroBars = signal<ReadonlyMap<string, readonly BarView[]>>(new Map());
  const macroBusy = signal(false);

  /**
   * Bars for the current instrument's declared drivers.
   *
   * SEPARATE FROM `macroBars`, which holds the four series the Decision desk
   * correlates against for every instrument. The driver set is per-instrument
   * and wider — an alt's drivers include BTC and ETH, gold's include silver —
   * so merging the two maps would mean one of them silently deciding what the
   * other contains.
   *
   * A series that will not load is ABSENT from the map, never present-and-
   * empty. The cross-asset panel counts how many drivers it actually got and
   * refuses to fit on a subset without saying so: a model trained on two of
   * five columns is not the model the panel claims it is.
   */
  const driverBars = signal<ReadonlyMap<string, readonly BarView[]>>(new Map());
  const driverBusy = signal(false);

  /**
   * Loaded ON REQUEST, never automatically — the same rule the macro lane
   * follows and for the same reason stated there: this is four to five extra
   * series, and a panel that silently multiplies the request budget is one
   * that eventually earns a rate-limit ban on the user's behalf.
   */
  const loadDrivers = async (): Promise<void> => {
    const sym = state.symbol.peek();
    const tf = state.timeframe.peek();
    const wanted = driversFor(sym);
    if (wanted.length === 0) {
      driverBars.set(new Map());
      return;
    }
    if (driverBusy.peek()) return;
    driverBusy.set(true);
    try {
      const pairs = await Promise.all(
        wanted.map(async (d) => {
          try {
            const res = await feed.history.load(d.symbol, tf, { limit: 1500 });
            return [d.symbol, res.bars] as const;
          } catch {
            /* A driver that will not load is ABSENT, never present-and-empty.
               "Uncorrelated" and "not loaded" must not blur into each other. */
            return [d.symbol, [] as readonly BarView[]] as const;
          }
        }),
      );
      driverBars.set(new Map(pairs.filter(([, b]) => b.length > 0)));
    } finally {
      driverBusy.set(false);
    }
  };

  const decision = computed<Decision>(() => {
    const series = bars();
    const closed = Math.max(0, series.length - 1);
    const conf =
      closed >= 210
        ? confluence(toScanBars(series.slice(0, closed)))
        : null;

    const f = fundamentals.find(state.symbol());
    const openCount = openPositions();

    /* The calendar read for THIS instrument's currencies. Reading the signal
       here is what makes the decision recompute when the calendar arrives —
       the release discount would otherwise sit on a stale read until something
       else moved. */
    const cal = calendar();
    const calRead = !cal
      ? null
      : !cal.ok
        ? { ok: false, discount: 0, note: "", error: cal.error }
        : {
            ok: true,
            ...(() => {
              const r = releaseRisk(cal.events, {
                now: Date.now(),
                currencies: currenciesFor(state.symbol()),
              });
              return { discount: r.discount, note: r.note };
            })(),
          };

    /**
     * The leading read, computed on CLOSED bars only.
     *
     * `series.slice(0, closed)` is the same slice the confluence engine gets a
     * few lines above, and for the same reason: the forming bar has a range and
     * a close that are both still moving, so a compression percentile that
     * included it would flicker every tick and a follow-through reading would
     * report where price happens to be sitting rather than where it settled.
     */
    const lead = closed >= 210 ? readLeading(toScanBars(series.slice(0, closed))) : null;
    const coiledComponent = lead?.components.find((c) => c.id === "compression");
    const thinning = (lead?.components ?? []).filter((c) => c.family === "thinning" && c.speaks === "which way");
    const answeredThinning = thinning.filter((c) => c.value !== null);

    const leadingRead = !lead
      ? null
      : {
          ok: true,
          timing: lead.timing,
          coiledReason: coiledComponent?.reason ?? "Compression could not be measured.",
          /* Mean of the thinning components that ANSWERED. A component with no
             reading is not a zero vote — averaging it in as one would drag a
             real divergence towards neutral and quietly understate it. */
          thinningLean:
            answeredThinning.length === 0
              ? null
              : answeredThinning.reduce((sum, c) => sum + (c.value as number), 0) / answeredThinning.length,
          thinningReason:
            answeredThinning.length === 0
              ? (thinning[0]?.reason ?? "No participation reading.")
              : answeredThinning.map((c) => c.reason).join(" "),
          coverage: lead.coverage,
        };

    return decide({
      symbol: state.symbol(),
      timeframe: state.timeframe(),
      now: Date.now(),
      confluence: conf,
      leading: leadingRead,
      detections: detections(),
      higher: state.htf().map((tf) => {
        const own = detections().filter((d) => d.id.startsWith(`${tf}:`));
        const last = own[own.length - 1];
        return {
          timeframe: tf,
          bias: last ? last.direction : "neutral",
          score: last ? last.confidence : 0,
        };
      }),
      higherEnabled: state.htf(),
      regime: (() => {
        const r = regime();
        if (!r) return null;
        return r.ok
          ? { ok: true, state: r.state, confidence: r.confidence }
          : { ok: false, error: r.error };
      })(),
      forecast: (() => {
        const f2 = forecast();
        if (!f2) return null;
        if (!f2.ok) return { ok: false, error: f2.error };
        const standing = forecastStanding(f2);
        return { ok: true, pUp: f2.pUp, usable: standing.usable, standing: standing.why };
      })(),
      derivatives: derivatives(),
      fundamentals: f ? { row: f, derived: deriveFundamentals(f), asOf: Date.parse(f.updatedAt) || 0 } : null,
      spread: spread(),
      correlation: correlationMatrix()
        ? { matrix: correlationMatrix() as CorrelationMatrix, openPositions: openCount }
        : null,
      onchain: null,
      /* Cross-asset context, once the lane has been loaded. Empty until then,
         so the read is identical to the pre-v49 one for anyone who never asks
         for it. */
      macro: macroEvidence(readMacro(state.symbol(), bars(), macroBars()), Date.now()),
      calendar: calRead,
    });
  });

  /**
   * The macro lane, loaded on request.
   *
   * Not automatically, and not on every symbol change: it is four extra
   * series, and a panel that silently quadruples the request budget is one
   * that eventually earns a rate-limit ban on somebody else's behalf. The
   * governor in `core/kernel.ts` would survive it; the user's connection to
   * the venue might not.
   */

  const loadMacro = (): void => {
    if (macroBusy.peek()) return;
    macroBusy.set(true);
    const tf = state.timeframe.peek();
    void Promise.all(
      MACRO_LANE.map(async (m) => {
        try {
          const res = await feed.history.load(m.symbol, tf, { limit: 800 });
          return [m.symbol, res.bars] as const;
        } catch {
          /* A macro series that will not load is ABSENT, never zero. The
             difference between "uncorrelated" and "not loaded" is exactly the
             sort of thing that must not be blurred. */
          return [m.symbol, [] as readonly BarView[]] as const;
        }
      }),
    )
      .then((pairs) => {
        macroBars.set(new Map(pairs.filter(([, b]) => b.length > 0)));
      })
      .finally(() => macroBusy.set(false));
  };

  const macroReads = () => readMacro(state.symbol(), bars(), macroBars());

  /**
   * The forecast, computed lazily and only on the Decision desk.
   *
   * `calibration` replays the model over the whole loaded history, which is
   * O(n²) in the worst case — perfectly fine once on a desk switch, and far
   * too slow to sit in the chart's repaint path.
   */
  const forecastView = () => {
    if (state.view() !== "decision") return null;
    const series = bars();
    const f = forecastRange(series);
    const cal = calibration(series);
    if (f === null) return null;
    return {
      line: forecastLine(f, cal),
      buckets: cal.buckets,
      error: cal.error,
      usable: cal.usable,
    };
  };

  const decisionDesk = lazyDesk(() => createDecisionDesk({
    decision,
    busy: decisionBusy,
    refresh: refreshDecision,
    forecast: forecastView,
    macro: () => {
      const rows = macroReads();
      return { line: macroLine(rows), rows };
    },
    loadMacro,
    macroBusy,
    /* "Show me" jumps to the desk that owns the evidence, so a summary line is
       always one click from the panel that produced it. */
    onOpenSource: (group: EvidenceGroup) => {
      const target: Record<string, string> = {
        structure: "chart",
        trend: "chart",
        flow: "flow",
        fundamental: "chart",
        onchain: "flow",
        venue: "chart",
        correlation: "screener",
        model: "chart",
      };
      state.view.set(target[group] ?? "chart");
    },
  }));

  return {
    spread,
    spreadAt,
    brokerQuote,
    derivatives,
    decision,
    decisionBusy,
    refreshDecision,
    macroReads,
    driverBars,
    loadDrivers,
    screener,
    decisionDesk,
  };
}
