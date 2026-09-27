/**
 * The analyst's window on the terminal.
 *
 * WHY IT IS A FILE OF ITS OWN
 * `mountShell` was 7,400 lines inside a single function and this was 598 of
 * them — the largest coherent block in it, and the one with the least reason to
 * be there. It is not wiring: it is one object of plain accessors, and its
 * dependency list is literally its own contents.
 *
 * WHAT IT IS FOR, AND THE CONSTRAINT THAT SHAPES IT
 * `agent/tools.ts` explains the design and it is worth restating here, because
 * this is where it is enforced: the analyst can see NOTHING the operator cannot
 * also see on screen, and can state no number it did not pull through one of
 * these accessors. Every method below reads a signal a panel is already
 * rendering. There is no privileged path to the archive, the vendors or the
 * network, so the agent cannot invent a figure and cannot quote one that is not
 * also somewhere in the interface.
 *
 * Adding a method here widens what the analyst can say. That is the review
 * question for anything added to this file.
 *
 * MUTABLE BINDINGS ARRIVE AS FUNCTIONS.
 * `lastRec` and `lastChoice` are reassigned by the decision pass as it runs.
 * Passed by value they would be captured once and this object would go on
 * answering with whatever they held at mount — stale by the first bar.
 */

import { TIMEFRAMES } from "./views";
import { fmt } from "./format";
import { scheduleFrame } from "../../core/frame";
import { trustLabel } from "../../core/crosscheck";
import { runStudy, type Family } from "../../backtest/lab";
import { analysePortfolio } from "../../risk/portfolio";
import { rewardToRisk, stopFromAtr } from "../../risk/sizing";
import { binanceScanDeps } from "../../data/binance";
import { breakEven } from "../../setup/simulate";
import { bySetup, computeStats } from "../../journal/stats";
import { createDrawing } from "../../draw/model";
import { derive as deriveFundamentals } from "../../data/fundamentals";
import { forecastStanding } from "../../data/intel";
import { currenciesFor, loadCalendar, upcoming } from "../../data/calendar";
import { rankRows, scanUniverse } from "../../scan/scanner";
import { readLeading } from "../../analysis/leading";
import { scorecard } from "../../learn/scorecard";
import { summarise as summariseEdge } from "../../learn/edge";
import {
  agoText,
  axisValueLabel,
  contextOfLatest,
  sharedKnowledge,
  AXES,
  type ContextAxis,
  type Direction,
  type KnowledgeCell,
} from "../../learn/knowledge";
import type { BarView } from "../../chart/series";
import { toScanBars } from "../../scan/confluence";
import type { ReadSignal } from "../../core/signal";
import type { Studies } from "../model/studies";
import type { Detection } from "../../detect/types";
import type { AlertSpec } from "../../alert/types";
import type { SeriesInventory } from "../../store/barstore";
import type { Drawing } from "../../draw/model";
import type { SetupView } from "../../setup/ui";
import { DEFAULT_RULES } from "../../setup/rules";
import { intervalMs } from "../../data/history";
import { closedBars } from "../../scan/opportunity";
import { outlookCalibration, simulateOutlook, type OutlookCalibration, type Refused as OutlookRefused } from "../../analysis/outlook";
import { runSpecTest } from "../../backtest/spectest";
import { opportunitiesReport, outlookReport, setupRead, type OutlookPlanInput } from "../../agent/reads";
import { outlookLines } from "../outlookpanel";
import { rankByOpportunity } from "../screener";

import type { TerminalAccess } from "../../agent/tools";
import type { createDecisionSection } from "./decision";
import type { createRiskSection } from "./risk";
import type { createFundamentals } from "../../data/fundamentals";


/**
 * Everything the accessors read.
 *
 * MOSTLY LOOSE, PRECISELY WHERE IT PAYS.
 * These are the shell's own live objects — signals, stores, computed values —
 * and restating twenty of their full types here would be a second declaration
 * to keep in step with the first, which is the duplication that makes a
 * monolith hard to break up in the first place.
 *
 * The exceptions are the ones whose ELEMENTS are walked below. A `readonly
 * Detection[]` gives every `.map((d) => …)` in this file its parameter type;
 * `any` gives fifteen implicit-any errors and, worse, silently accepts a typo
 * in a field name. Type where the type flows somewhere, stay loose where it
 * would only be restated.
 */
export interface AccessDeps {
  readonly state: any;
  readonly feed: any;
  readonly bars: any;
  /** The bar archive's inventory rows, walked for the storage summary. */
  readonly learn: any;
  readonly riskDesk: any;
  readonly journal: any;
  readonly edge: any;
  readonly deepReplay: any;
  readonly calendar: any;
  readonly intel: any;
  readonly drawStore: { visible(symbol: string, tf: string): readonly Drawing[]; add(d: Drawing): void };
  readonly detections: ReadSignal<readonly Detection[]>;
  readonly emaAt: (period: number) => number;
  readonly portfolioHeat: any;
  /**
   * Read through a call, never captured.
   *
   * `lastRec` and `lastChoice` are REASSIGNED by the decision pass. The other
   * three are simply declared later in `mountShell` than this object is built —
   * which was invisible while everything lived in one closure and the accessors
   * resolved them lazily, and becomes a temporal-dead-zone error the moment the
   * object is constructed from arguments. A getter restores the laziness the
   * object literal had for free.
   */
  readonly lastRec: () => any;
  readonly lastChoice: () => any;
  /**
   * The PNG export's compositor ITSELF, not a getter that returns it.
   *
   * Until v60 this was typed `() => any` and the shell passed
   * `() => composeChart` — a function returning the compositor. `any` accepted
   * it, so `chartImage` received a FUNCTION where it expected a canvas: not
   * null, `.width` undefined, and `toDataURL` a TypeError. The shell now
   * passes `() => composeChart()`, which is still lazy (the compositor is
   * declared later in `mountShell`) and is the only shape this type admits.
   */
  readonly composeChart: () => HTMLCanvasElement | null;
  readonly loadArchiveCloses: ReturnType<typeof createRiskSection>["loadArchiveCloses"];
  /* Shell-local values the accessors read. Functions where the shell rebuilds
     them, plain references where it does not. */
  readonly alertStore: { specs(): readonly AlertSpec[] };
  readonly decision: ReturnType<typeof createDecisionSection>["decision"];
  readonly fundamentals: ReturnType<typeof createFundamentals>;
  readonly studies: ReadSignal<Studies>;
  /**
   * The Setup card's own view, read late for the same reason as `lastRec`.
   *
   * OPTIONAL, and that is a statement about wiring, not about the data: when
   * the host has not passed it, `get_setup` refuses in words ("not connected")
   * rather than rebuilding a verdict here. A second derivation of the gates
   * would be a second owner of the one fact the operator acts on.
   */
  readonly setupView?: () => SetupView | null;
}

export function createTerminalAccess(d: AccessDeps): TerminalAccess {
  const {
    state, feed, bars, learn, riskDesk, journal, edge,
    deepReplay, calendar, intel, drawStore, detections, emaAt,
    portfolioHeat, lastRec, lastChoice,
    alertStore, decision, fundamentals, studies,
    composeChart,
    loadArchiveCloses,
    setupView,
  } = d;

  const readSetup = () => setupRead(setupView === undefined ? undefined : setupView());

  /**
   * The outlook band's track record, once per instrument.
   *
   * The same computation the dock's outlook panel runs — `outlookCalibration`
   * over the archive's closed bars — memoised by symbol and timeframe, so the
   * analyst asking twice costs one archive read. `load` reads what is held; it
   * does not page the vendor.
   */
  const calCache = new Map<string, Promise<OutlookCalibration | OutlookRefused>>();
  const calibrationFor = (sym: string, tf: string): Promise<OutlookCalibration | OutlookRefused> => {
    const key = `${sym}|${tf}`;
    const hit = calCache.get(key);
    if (hit) return hit;
    const p = (feed.history.load(sym, tf, { limit: 6000 }) as Promise<{ bars: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[] }>)
      .then((res): OutlookCalibration | OutlookRefused =>
        outlookCalibration(res.bars.slice(0, Math.max(0, res.bars.length - 1))),
      )
      .catch((): OutlookRefused => {
        calCache.delete(key);
        return { ok: false, refused: "the local archive could not be read" };
      });
    calCache.set(key, p);
    return p;
  };

  return {
    symbol: () => state.symbol.peek(),
    timeframe: () => state.timeframe.peek(),
    bars: () => bars.peek(),
    feed: () => {
      const st = feed.state.peek();
      return {
        quality: st.quality,
        note: st.note,
        source: st.source,
        /* Null, not 0. Zero is "the tick arrived this instant", which is
           the freshest possible reading and the exact opposite of what an
           unknown age means. */
        ageMs: Number.isFinite(st.tickAgeMs) ? st.tickAgeMs : null,
      };
    },
    indicators: () => {
      const st = studies.peek();
      return {
        rsi: st.rsi,
        atr: st.atr,
        atrPct: st.atrPct,
        ema20: emaAt(20),
        ema50: emaAt(50),
        ema200: emaAt(200),
      };
    },
    detections: () => {
      const series = bars.peek();
      return detections.peek().map((d) => ({
        kind: d.kind,
        label: d.label,
        confidence: d.confidence,
        reason: d.reason,
        at: series[Math.min(d.to, series.length - 1)]?.t ?? 0,
      }));
    },
    alerts: () =>
      alertStore.specs().map((a) => ({
        id: a.id,
        /* The anchor already carries a human label captured at creation, so
           an orphaned alert can still say what it watched. */
        label:
          a.anchor.kind === "price"
            ? `${a.condition} price ${a.anchor.price}`
            : `${a.condition} ${a.anchor.label}`,
        symbol: a.symbol,
        timeframe: a.timeframe,
        armed: a.enabled,
      })),
    higher: () => {
      /* Only what the user actually enabled. An empty list is reported as
         an ABSENCE by the tool, never as a neutral reading. */
      const enabled = state.htf.peek();
      const all = detections.peek();
      return enabled.map((tf: string) => {
        const own = all.filter((d) => d.id.startsWith(`${tf}:`));
        const last = own[own.length - 1];
        return {
          timeframe: tf,
          bias: last ? last.direction : "no structure detected",
          score: last ? last.confidence : 0,
        };
      });
    },
    regime: async () => {
      const r = await intel.regime(bars.peek());
      return r.ok
        ? { ok: true, state: r.state, confidence: r.confidence, note: r.note }
        : { ok: false, error: r.error };
    },
    forecast: async () => {
      const f = await intel.forecast(bars.peek(), 24);
      if (!f.ok) return { ok: false, error: f.error };
      const standing = forecastStanding(f);
      return {
        ok: true,
        pUp: f.pUp,
        accuracy: f.accuracy,
        brier: f.brier,
        usable: standing.usable,
        standing: standing.why,
      };
    },
    calendar: async () => {
      const cal = calendar.peek() ?? (await loadCalendar());
      if (!cal.ok) return [];
      /* The source DOES publish an impact tier now — the old path fetched
         it and threw it away, so this field used to have to say "not
         published by the source". It reports the cross-check verdict too,
         because a figure two copies disagree about is a different fact
         from one they agree on, and the model must be able to say so. */
      const now = Date.now();
      return upcoming(cal.events, {
        now,
        currencies: currenciesFor(state.symbol.peek()),
        limit: 6,
      }).map((r) => ({
        when: new Date(r.event.at).toISOString(),
        what: `${r.event.currency} ${r.event.title}${
          r.event.forecast ? ` (forecast ${r.event.forecast}, previous ${r.event.previous})` : ""
        }`,
        importance: `${r.event.impact} impact — ${trustLabel(r.trust)}`,
      }));
    },
    storage: async () => {
      const inv = await feed.archive.inventory();
      return {
        series: inv.length,
        bars: inv.reduce((a: number, x: SeriesInventory) => a + x.bars, 0),
        bytes: inv.reduce((a: number, x: SeriesInventory) => a + x.approxBytes, 0),
        note: "Daily and weekly bars are kept forever; intraday ages out. See the Data desk.",
      };
    },
    setSymbol: (sym) => state.symbol.set(sym),
    setTimeframe: (tf) => state.timeframe.set(tf),
    timeframes: () => TIMEFRAMES,

    /* --- risk. Every value here is one the USER entered. ------------ */

    riskState: () => {
      const cfg = riskDesk.config.peek();
      const book = riskDesk.positions.peek();
      const hh = portfolioHeat(book, cfg.equity);
      return {
        equity: cfg.equity,
        defaultRiskPct: cfg.riskPct,
        openPositions: book.length,
        /* Null, not 0. Reporting "no open risk" to the analyst when open
           risk is unmeasurable is how it ends up reasoning that there is
           room for another position. */
        heatPct: Number.isFinite(hh.heatPct) ? hh.heatPct : null,
        realisedToday: riskDesk.realisedToday.peek(),
        guards: cfg.guards,
        unprotected: hh.unprotected,
      };
    },

    sizePosition: (a) => {
      const out = riskDesk.size(a.entry, a.stop, a.riskPct);
      return {
        ok: out.ok,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        qty: out.qty,
        notional: out.notional,
        riskAmount: out.riskAmount,
        riskPct: out.riskPct,
        requestedRiskPct: out.requestedRiskPct,
        stopDistancePct: out.stopDistancePct,
        direction: out.direction,
        warnings: out.warnings,
        assumptions: out.assumptions,
      };
    },

    atrStop: (a) => {
      const out = stopFromAtr(a.entry, studies.peek().atr, a.multiple, a.direction);
      return {
        ok: out.ok,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        stop: out.stop,
        distancePct: out.distancePct,
        note: out.note,
      };
    },

    rewardToRisk: (a) => {
      const out = rewardToRisk(a.entry, a.stop, a.target);
      return {
        ok: out.ok,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        r: out.r,
        breakEvenWinRate: out.breakEvenWinRate,
      };
    },

    /* --- engines the terminal already owns -------------------------- */

    runBacktest: async (family) => {
      const series = bars.peek();
      if (series.length < 300) {
        return { ok: false, error: `${series.length} bars loaded — a walk-forward study needs at least 300.` };
      }
      const fam = (["ema", "rsi", "confluence"] as const).includes(family as Family)
        ? (family as Family)
        : "ema";
      /* Seconds of synchronous CPU. Yielding a frame first lets the
         transcript paint the tool row before the tab locks up, so the
         pause is visibly the study running rather than the app hanging. */
      await new Promise<void>((resolve) => scheduleFrame(() => resolve()));
      const study = runStudy(fam, series);
      return {
        ok: true,
        family: fam,
        standing: study.headline.standing,
        verdict: study.headline.verdict,
        why: study.headline.why,
        trades: study.bestRun?.trades.length ?? 0,
        pbo: study.overfit.pbo,
        warnings: study.warnings,
      };
    },

    scanMarket: async (limit) => {
      try {
        const rows = await scanUniverse(binanceScanDeps, {
          interval: state.timeframe.peek(),
          /* Scan a few more than asked for and rank, so the top N is the
             top of a real ranking rather than the first N by volume. */
          top: Math.max(limit * 3, 30),
          quote: "USDT",
        });
        return {
          ok: true,
          rows: rankRows(rows)
            .slice(0, limit)
            .map((r) => ({
              symbol: r.symbol,
              changePct: r.changePct,
              bias: r.result?.bias ?? "none",
              score: r.result ? Math.round(r.result.score * 100) : 0,
              why: r.result?.insufficient ?? r.result?.signals[0]?.reason ?? "no read",
            })),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /* --- drawings --------------------------------------------------- */

    fundamentals: () => {
      const f = fundamentals.find(state.symbol.peek());
      if (!f) {
        return {
          ok: false,
          reason: `The aggregator covers crypto assets by market capitalisation and does not list ${state.symbol.peek()}. There is no fundamental data for this instrument — do not reason as though there were.`,
        };
      }
      const d = deriveFundamentals(f);
      return {
        ok: true,
        name: f.name,
        rank: f.rank,
        marketCap: f.marketCap,
        fullyDiluted: f.fullyDiluted,
        volume24h: f.volume24h,
        circulating: f.circulating,
        maxSupply: f.maxSupply,
        floatPct: d.float === null ? null : d.float * 100,
        dilutionMultiple: d.dilution,
        turnoverPct: d.turnover * 100,
        belowAthPct: d.belowAth,
        change24h: f.change24h,
        change7d: f.change7d,
        change30d: f.change30d,
        notes: d.notes,
        source: "CoinGecko. Circulating supply is self-reported by the project.",
      };
    },

    decision: () => {
      const d = decision();
      return {
        headline: d.headline,
        bias: d.bias,
        score: d.score,
        agreement: d.agreement,
        coverage: d.coverage,
        confidence: d.confidence,
        limits: d.limits,
        wouldChange: d.wouldChange,
        evidence: d.evidence.map((e) => ({
          label: e.label,
          lean: e.lean,
          weight: e.weight,
          reason: e.reason,
          source: e.source,
          state: e.state,
        })),
        missing: d.missing.map((e) => ({ label: e.label, state: e.state, reason: e.reason })),
      };
    },

    /**
     * The leading read, handed to the analyst on its three separate axes.
     *
     * Recomputed here rather than cached off the Decision desk because the
     * analyst can be asked about the chart at any moment, including before
     * the Decision desk has ever been opened — and a tool that silently
     * returned the last desk visit would answer about a different symbol.
     */
    leading: () => {
      const series = bars.peek();
      const closed = Math.max(0, series.length - 1);
      if (closed < 210) {
        return {
          ok: false,
          timing: 0,
          direction: null,
          conviction: 0,
          coverage: 0,
          headline: "",
          components: [],
          reason: `Only ${closed} closed bars are loaded; 210 are needed before any of these can be ranked against their own history.`,
        };
      }
      const l = readLeading(toScanBars(series.slice(0, closed)));
      return {
        ok: true,
        timing: l.timing,
        direction: l.direction,
        conviction: l.conviction,
        coverage: l.coverage,
        headline: l.headline,
        components: l.components.map((c) => ({
          label: c.label,
          family: c.family,
          speaks: c.speaks,
          value: c.value,
          reason: c.reason,
          limit: c.limit,
        })),
      };
    },

    /**
     * Portfolio risk, read from the archive on demand.
     *
     * The flattening here is deliberate: the model is given `measuredLegs`
     * beside `effectiveBets` so it cannot quote the ratio against the
     * position count, and `missing` separately so an exclusion cannot be
     * lost inside a warning string it might paraphrase away.
     */
    portfolioRisk: async () => {
      const book = riskDesk.positions.peek();
      const factor = "BTCUSDT";
      const symbols = [...new Set([...book.map((x: { symbol: string }) => x.symbol), factor])];
      const closes = await loadArchiveCloses(symbols);
      const r = analysePortfolio({
        positions: book,
        equity: riskDesk.config.peek().equity,
        series: closes,
        factorSymbol: factor,
      });
      return {
        ok: r.ok,
        blocked: r.blocked,
        sample: r.sample,
        gross: r.gross,
        net: r.net,
        measuredLegs: r.diversification.measured,
        effectiveBets: r.diversification.effectiveBets,
        missing: r.missing,
        tails: r.tails.map((t) => ({ level: t.level, var: t.var, cvar: t.cvar, worst: t.worst })),
        contributions: r.contributions.map((c) => ({
          symbol: c.symbol,
          cvarShare: c.cvarShare,
          fraction: c.fraction,
        })),
        betas: r.betas
          .filter((b) => b.symbol !== r.factor)
          .map((b) => ({ symbol: b.symbol, beta: b.beta, r2: b.r2, caveat: b.caveat })),
        stress: r.stress.map((x) => ({
          label: x.scenario.label,
          factorMove: x.scenario.factorMove,
          pnl: x.pnl,
          pctOfEquity: x.pctOfEquity,
          unreliable: x.unreliable,
        })),
        warnings: r.warnings,
      };
    },

    /* --- the expert's reads ------------------------------------------ */

    setup: () => readSetup(),

    outlook: async (supplied) => {
      const series = bars.peek();
      /* Closed bars only, exactly as the dock's outlook panel reads them. */
      const o = simulateOutlook(series.slice(0, Math.max(0, series.length - 1)));
      let plan: OutlookPlanInput | null = supplied;
      let planNote = supplied ? "Odds are for the plan supplied in the call." : "";
      if (plan === null) {
        const s = readSetup();
        if (!s.ok) planNote = `No odds: ${s.reason}`;
        else if (s.plan === null) {
          planNote =
            s.call === "no-setup"
              ? `No odds: there is no setup. ${s.no_setup_reason}`
              : `No odds: ${s.plan_withheld || s.plan_problem || "the Setup card has no plan."}`;
        } else {
          plan = {
            source: "terminal setup",
            direction: s.plan.direction,
            entry: s.plan.entry,
            stop: s.plan.stop,
            target1: s.plan.target1,
            target2: s.plan.target2,
          };
          planNote = "Odds are for the Setup card's plan.";
        }
      }
      const cal = await calibrationFor(state.symbol.peek(), state.timeframe.peek());
      const panelPlan = plan
        ? { direction: plan.direction, entry: plan.entry, stop: plan.stop, target1: plan.target1 }
        : null;
      return outlookReport(o, plan, planNote, cal, (odds) =>
        o.ok ? outlookLines(o, odds, panelPlan, fmt) : { range: "", lean: "", odds: null },
      );
    },

    findOpportunities: async ({ limit, universe }) => {
      const tf = state.timeframe.peek();
      try {
        const rows = await scanUniverse(binanceScanDeps, {
          interval: tf,
          top: universe,
          /* The Opportunities desk's own depth and stop band, so a row here
             and a row there are the same answer. */
          bars: 1000,
          concurrency: 6,
          quote: "USDT",
          opportunity: {
            intervalMs: intervalMs(tf),
            minStopAtr: DEFAULT_RULES.minStopAtr,
            maxStopAtr: DEFAULT_RULES.maxStopAtr,
            now: Date.now(),
          },
        });
        return opportunitiesReport(rankByOpportunity(rankRows(rows)), {
          timeframe: tf,
          universe: `top ${universe} USDT pairs by 24h quote volume on Binance`,
          limit,
          minStopAtr: DEFAULT_RULES.minStopAtr,
          maxStopAtr: DEFAULT_RULES.maxStopAtr,
          stopRuleSource: "the terminal's default stop band, as the Opportunities desk uses",
        });
      } catch (err) {
        console.warn("[agent] opportunity scan failed", err);
        return {
          ok: false,
          error: "The venue universe could not be loaded, so nothing was scanned. The exchange may be unreachable from here.",
        };
      }
    },

    testStrategy: async (spec) => {
      const sym = state.symbol.peek();
      const tf = state.timeframe.peek();
      let res: { bars: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[]; source: string; containsDemo: boolean };
      try {
        res = await feed.history.load(sym, tf, { limit: 3000 });
      } catch (err) {
        console.warn("[agent] history load failed", err);
        return {
          ok: false,
          rules: {},
          refused: `The history for ${sym} ${tf} could not be read, so nothing was tested.`,
        };
      }
      /* Seconds of CPU on a deep series. Let the tool row paint first, so the
         pause is visibly the test running rather than the tab hanging. */
      await new Promise<void>((resolve) => scheduleFrame(() => resolve()));
      return runSpecTest(spec, closedBars(res.bars, intervalMs(tf), Date.now()), {
        containsDemo: res.containsDemo,
        symbol: sym,
        timeframe: tf,
        source: res.source,
      });
    },

    drawings: () =>
      drawStore.visible(state.symbol.peek(), state.timeframe.peek()).map((d) => ({
        id: d.id,
        kind: d.kind,
        text: d.text ?? "",
        detail: d.anchors.map((a) => fmt(a.p)).join(" → "),
      })),

    drawLevel: (a) => {
      if (!Number.isFinite(a.price) || a.price <= 0) {
        return { ok: false, reason: "That is not a price." };
      }
      const d = createDrawing("hline", [{ t: Date.now(), p: a.price }], {
        symbol: state.symbol.peek(),
        timeframe: state.timeframe.peek(),
        tone: "accent",
        ...(a.label ? { text: a.label } : {}),
      });
      drawStore.add(d);
      return { ok: true, id: d.id };
    },

    /**
     * The chart as pixels.
     *
     * `composeChart()` is the compositor the PNG export uses, so the model
     * receives EXACTLY what the operator would get from Export — same
     * layers, same opaque background, same burned-in caption. Showing a
     * model a private rendering would make its answer uncheckable against
     * the only copy anyone else can see.
     *
     * Downscaled to at most 1,400px wide. A retina chart is 3,200px, which
     * is several megabytes of base64 for no gain: both vendors resize
     * beyond roughly this width anyway, and the operator pays for the
     * upload in tokens either way.
     */
    chartImage: () => {
      const src = composeChart();
      if (src === null) return { ok: false, reason: "The chart has not painted yet." };
      const MAX_W = 1400;
      let out = src;
      if (src.width > MAX_W) {
        const scale = MAX_W / src.width;
        const small = document.createElement("canvas");
        small.width = MAX_W;
        small.height = Math.round(src.height * scale);
        const sctx = small.getContext("2d");
        if (sctx) {
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(src, 0, 0, small.width, small.height);
          out = small;
        }
      }
      const url = out.toDataURL("image/png");
      const comma = url.indexOf(",");
      if (comma < 0) return { ok: false, reason: "The browser could not encode the chart." };
      return {
        ok: true,
        mediaType: "image/png",
        /* Raw base64. The `data:` prefix is added back by the OpenAI path
           and rejected outright by Anthropic's. */
        dataBase64: url.slice(comma + 1),
        width: out.width,
        height: out.height,
        caption: `${state.symbol.peek()} ${state.timeframe.peek()} · ${feed.state.peek().source}`,
      };
    },

    /**
     * WHAT THE AGENT COULD NOT SEE.
     *
     * Twenty-five tools, and not one of them could answer "how has this
     * actually gone". The analyst could read every indicator, every
     * detection, every model output and the whole assembled decision, and
     * was structurally unable to notice that the setup it was describing
     * had never once worked on this chart. These three are the only tools
     * whose answer can contradict the rest of the toolset, which is the
     * reason to have them.
     */
    setupHistory: () => {
      const d = deepReplay.result();
      if (d === null || d.symbol !== state.symbol.peek() || d.timeframe !== state.timeframe.peek()) {
        return { ok: false, reason: "No replay has been run for the chart on screen yet." };
      }
      const chosenCand = lastChoice()?.best?.candidate ?? null;
      return {
        ok: true,
        symbol: d.symbol,
        timeframe: d.timeframe,
        bars: d.bars,
        rMultiple: d.rMultiple,
        breakEvenHitRate: breakEven(d.rMultiple),
        chosen: chosenCand ? { kind: chosenCand.kind, direction: chosenCand.direction } : null,
        kinds: [...d.sims.entries()].map(([key, sim]) => {
          const [kind, direction] = key.split("|") as [string, string];
          return {
            kind,
            direction,
            instances: sim.n,
            wins: sim.wins,
            hitRate: sim.hitRate,
            hitRateLowerBound: sim.hitLow,
            expectancyR: sim.expectancy,
            medianBars: sim.medianBars,
            enoughToCharacterise: sim.enough,
            note: sim.note,
          };
        }),
        disagreement: lastRec()?.disagreement ?? "",
        /* Carried in the payload rather than trusted to the prompt. A
           caveat the model has to remember is a caveat it will drop on
           turn nine. */
        caveat:
          "In-sample: these patterns were found on the same bars they are scored over. " +
          "A prior, not a forecast. The user's own journal outranks it.",
      };
    },

    /**
     * The knowledge base, asked about one setup in today's conditions.
     *
     * THE CONTEXT IS TAKEN FROM THE CHART'S OWN BARS, AND ONLY THE CHART'S.
     * A regime label is a measurement of a series, so asking about an
     * instrument that is not on screen means there are no bars here to label
     * it from. Rather than guessing a regime — which would file the answer
     * under a condition nobody measured — the context goes null, the ladder
     * falls through to the "any conditions" rung, and the payload says the
     * conditions are unknown. A condition-sliced answer about a chart nobody
     * has loaded would be the most confident wrong number in the toolset.
     */
    knowledge: (a) => {
      const onScreenSym = state.symbol.peek() as string;
      const onScreenTf = state.timeframe.peek() as string;
      const sym = (a.symbol ?? onScreenSym).toUpperCase();
      const tf = a.timeframe ?? onScreenTf;

      const cand = lastChoice()?.best?.candidate ?? null;
      const kind = a.kind ?? (typeof cand?.kind === "string" ? (cand.kind as string) : "");
      const dirRaw = a.direction ?? (typeof cand?.direction === "string" ? (cand.direction as string) : "");
      if (kind === "") {
        return {
          ok: false,
          reason:
            "No setup kind was given and the card has not chosen one on this chart, so there is nothing to look up. Pass `kind` and `direction`.",
        };
      }
      if (dirRaw !== "long" && dirRaw !== "short") {
        return { ok: false, reason: `"${dirRaw || "(none)"}" is not a direction — pass 'long' or 'short'.` };
      }
      const direction: Direction = dirRaw;

      const sameChart = sym === onScreenSym.toUpperCase() && tf === onScreenTf;
      /* `contextOfLatest` is memoised on the series itself, so the analyst
         asking three times in one turn labels the bars once — and it is the
         same function the Setup card's own second line reads, so the tool and
         the card can never disagree about which regime it is. */
      const context = sameChart ? contextOfLatest(bars.peek() as readonly BarView[]) : null;

      const base = sharedKnowledge();
      const prior = base.priorFor(sym, tf, kind, direction, context);
      if (prior.standing === "none" && prior.cell === null) {
        return {
          ok: false,
          reason:
            `Nothing has been harvested for ${kind} ${direction} on ${sym} ${tf}. That means it has NOT BEEN MEASURED here — ` +
            `not that it does not work. Run "Learn from history" on the Knowledge desk to measure it.`,
        };
      }

      /* Which slices to return: everything on the coarse axes, and only the
         CURRENT value on the fine ones. Twenty-four hour cells and seven
         weekday cells for one setup is a table the model will go shopping in,
         which is the exact mistake the sample floor exists to stop. */
      const all = base
        .cells()
        .filter((c) => c.symbol === sym && c.timeframe === tf && c.kind === kind && c.direction === direction);
      const wanted = (c: KnowledgeCell): boolean => {
        if (c.axis === "all" || c.axis === "regime" || c.axis === "session") return true;
        if (context === null) return false;
        if (c.axis === "hour") return c.value === String(context.hourUtc);
        return c.value === String(context.weekday);
      };
      const order = (axis: ContextAxis): number => AXES.indexOf(axis);
      const slices = all
        .filter(wanted)
        .sort((x, y) => (x.axis === y.axis ? y.trials - x.trials : order(x.axis) - order(y.axis)))
        .map((c) => ({
          axis: c.axis,
          condition: c.label,
          trials: c.trials,
          wins: c.wins,
          hit_rate: c.hitRate,
          at_least: c.hitLow,
          expectancy_r: c.expectancyR,
          median_bars: c.medianBars,
          usable: c.usable,
          stale: c.stale,
          from_bars: c.bars,
          sources: c.sources,
          last_updated: agoText(Date.now() - c.updatedAt),
        }));

      return {
        ok: true,
        symbol: sym,
        timeframe: tf,
        kind,
        direction,
        conditions_now:
          context === null
            ? { regime: "unknown", sessions: [], hour_utc: -1, weekday: "unknown" }
            : {
                regime: axisValueLabel("regime", context.regime),
                sessions: context.sessions.map((s) => axisValueLabel("session", s)),
                hour_utc: context.hourUtc,
                weekday: axisValueLabel("weekday", String(context.weekday)),
              },
        standing: prior.standing,
        slices,
        verdict:
          prior.line ||
          `Nothing in this base has reached the sample floor for ${kind} ${direction} on ${sym} ${tf} yet.`,
        /* Carried in the payload rather than trusted to the prompt, for the
           same reason `setupHistory`'s caveat is. */
        caveat:
          "Replayed from the user's own archive and therefore in-sample: the patterns were found on the bars they are scored over. " +
          "Reported beside the read, never inside it — do not merge it into a score. A slice with usable=false may not be quoted as a rate.",
      };
    },

    conditionalEdge: async (kind?: string) => {
      const table = await edge.conditional(kind ?? null);
      if (!table) {
        return {
          ok: false,
          reason: edge.lastError() || "The local service did not answer.",
        };
      }
      /* An unavailable table is still an ANSWER — "these trials span one day,
         so no breakdown is offered" is exactly what the analyst needs to hear.
         Returning it as an error would make the model treat a correct refusal
         as a broken tool and work around it. */
      return {
        ok: true,
        available: table.available,
        trials: table.trials,
        days: table.days,
        /* `exactOptionalPropertyTypes` — an absent field and a field set to
           undefined are different things here, and the table genuinely omits
           `comparisons` when it declined to slice at all. */
        ...(table.comparisons === undefined ? {} : { comparisons: table.comparisons }),
        text: summariseEdge(table),
        data: table,
      };
    },

    trackRecord: () => {
      const claims = learn.claims.peek();
      if (claims.length === 0) {
        return { ok: false, reason: "The terminal has not recorded any claims yet." };
      }
      const card = scorecard(claims);
      const prop = (p: { hits: number; n: number; rate: number; low: number }) => ({
        n: p.n,
        wins: p.hits,
        hitRate: Number.isFinite(p.rate) ? p.rate : null,
        lowerBound: p.n > 0 ? p.low : null,
      });
      return {
        ok: true,
        claims: claims.length,
        resolved: card.all.decided,
        pending: card.all.pending,
        takes: prop(card.gates.taken.hit),
        standDowns: prop(card.gates.stoodDown.hit),
        gatesVerdict: card.gates.text,
        note: card.headline,
      };
    },

    journalRecord: () => {
      const entries = journal.entries.peek();
      if (entries.length === 0) return { ok: false, reason: "The journal has no trades in it." };
      const st = computeStats(entries);
      return {
        ok: true,
        trades: entries.length,
        closed: st.n,
        open: st.open,
        wins: st.wins,
        losses: st.losses,
        hitRate: st.n > 0 ? st.hitRate : null,
        expectancyR: st.n > 0 ? st.expectancy : null,
        bySetup: [...bySetup(entries).entries()]
          .map(([kind, s]) => ({ kind, n: s.n, wins: s.wins, losses: s.losses }))
          .sort((a, b) => b.n - a.n),
      };
    },

    promoteDetection: (a) => {
      const series = bars.peek();
      const found = detections.peek().find((d) => d.label === a.label);
      if (!found) {
        return { ok: false, reason: `No structure is labelled "${a.label}" on this chart right now.` };
      }
      const from = series[Math.max(0, Math.min(found.from, series.length - 1))];
      const to = series[Math.max(0, Math.min(found.to, series.length - 1))];
      if (!from || !to) return { ok: false, reason: "That structure is outside the loaded bars." };

      /* A one-bar structure is a level, not a line: two identical anchors
         would render as a dot and hit-test as nothing. */
      const d =
        from.t === to.t
          ? createDrawing("hline", [{ t: to.t, p: to.c }], {
              symbol: state.symbol.peek(),
              timeframe: state.timeframe.peek(),
              tone: "accent",
              text: found.label,
            })
          : createDrawing(
              "trendline",
              [
                { t: from.t, p: from.c },
                { t: to.t, p: to.c },
              ],
              {
                symbol: state.symbol.peek(),
                timeframe: state.timeframe.peek(),
                tone: "accent",
                text: found.label,
              },
            );
      drawStore.add(d);
      return { ok: true, id: d.id, drew: `${d.kind} from "${found.label}"` };
    },
  };
}
