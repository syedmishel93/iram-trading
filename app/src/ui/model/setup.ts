/**
 * The Setup card's view model: what the terminal would trade here, and why not.
 *
 * Moved out of `mountShell` in v59. Composition, not new analysis — the read
 * comes from the decision section, the swing from the detections the chart
 * already found, the ATR from `studies`, the size from `risk/sizing` against
 * the ONE account, the gates from thresholds the operator set, and the base
 * rate from replaying this chart's own history. Nothing here computes a fresh
 * opinion.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SEVENTEEN INPUTS, AND WHY THAT IS NOT THE COUPLING CLAUDE.md REFUSES
 *
 * The extraction rule refuses a section with more than about ten siblings,
 * because moving it would move its coupling into a signature rather than
 * remove it. This one is a deliberate, named deviation. The card is the ONE
 * place every lane meets, so its inputs are its specification rather than an
 * accident of where it used to live. Every one is read-only: the model writes
 * nothing that belongs to another section (its only side effect is asking the
 * deep replay for a pass). Inside `mountShell` those seventeen reads were
 * implicit in a 6,600-line closure; here they are a typed list, each derived
 * from its real definition, so the coupling is declared rather than hidden.
 *
 * `last` is the other half. `setupView` used to write four shell-level `let`s
 * — the chosen field, the replay, the R it replayed at, the second opinion —
 * that the dock verdict, the expert and dev inspection read. They are this
 * model's OUTPUTS, so they live here and are read through `last`; nothing
 * outside writes them.
 */

import { type BarView } from "../../chart/series";
import type { createReplay } from "../../core/replay";
import { type CalendarFeed } from "../../data/calendar";
import { intervalMs } from "../../data/history";
import { macroEvidence } from "../../data/macro";
import { brokerClockOffsetMs } from "../../data/sources";
import { bySetup, planGapLine, recordLine } from "../../journal/stats";
import type { createJournal } from "../../journal/store";
import { HORIZON_BARS } from "../../learn/claim";
import { contextOfLatest, type sharedKnowledge } from "../../learn/knowledge";
import { priorFor } from "../../learn/prior";
import { cardLine } from "../../learn/scorecard";
import type { createLearnStore } from "../../learn/store";
import { portfolioHeat, sizePosition } from "../../risk/sizing";
import { DEEP_TARGET_BARS, type createDeepReplay } from "../../setup/deep";
import { chooseSetup, chosenLine, liveBarsFor } from "../../setup/engine";
import { type ExitRules, invalidationOf, readExit } from "../../setup/exit";
import { gatesFor, verdict } from "../../setup/gates";
import type { GateEnvironment } from "../../setup/gates";
import { type TradePlan, planRMultiple, stablePlan, stopAtrNow } from "../../setup/plan";
import { recommend } from "../../setup/recommend";
import { type GateRules } from "../../setup/rules";
import { type Simulation, breakEven, simulateKind } from "../../setup/simulate";
import { type LaneStatus, supervisorLine } from "../../setup/supervisor";
import { type SetupView } from "../../setup/ui";
import { openedBarIndex } from "../shell/bars";
import { computed, type ReadSignal } from "../../core/signal";
import type { ShellContext } from "../shell/context";
import type { createDecisionSection } from "../shell/decision";
import type { createRiskSection } from "../shell/risk";
import type { createStructureModel } from "./structure";
import type { createIntelModel } from "./intel";
import type { createBrokerModel } from "./broker";
import type { Studies } from "./studies";

export interface SetupModelDeps {
  /** The read, the spread, the broker quote, the macro reads. */
  readonly decisionSection: ReturnType<typeof createDecisionSection>;
  /** The structures the chart is drawing — the setup is chosen from these. */
  readonly detections: ReturnType<typeof createStructureModel>["detections"];
  /** The same series as detector input, for the historical replay. */
  readonly detectData: ReturnType<typeof createStructureModel>["detectData"];
  /** The operator's trades: open position for exits, record per setup. */
  readonly journal: ReturnType<typeof createJournal>;
  /** The claims ledger: the terminal's own resolved record. */
  readonly learn: ReturnType<typeof createLearnStore>;
  /** The knowledge base's prior for this setup in this context. */
  readonly knowledgeBase: ReturnType<typeof sharedKnowledge>;
  /** The deep replay over the archive, and its second opinion. */
  readonly deepReplay: ReturnType<typeof createDeepReplay>;
  /** Replay-aware bars; `replay.bars` is what the chart shows. */
  readonly replay: ReturnType<typeof createReplay<BarView>>;
  /** Settings ▸ Trading rules. Every gate threshold is the operator's. */
  readonly rules: ReadSignal<GateRules>;
  /** Settings ▸ exit management. */
  readonly exitRules: ReadSignal<ExitRules>;
  /** RSI and ATR, stamped with the series they came from. */
  readonly studies: ReadSignal<Studies>;
  /** Realised P&L today, for the daily-loss gate. */
  readonly riskDesk: ReturnType<typeof createRiskSection>["riskDesk"];
  /** The book the heat gate counts: broker when connected, manual otherwise. */
  readonly openBook: ReadSignal<ReturnType<ReturnType<typeof createBrokerModel>["book"]>["counted"]>;
  /** The economic calendar, for the event embargo. */
  readonly calendar: ReadSignal<CalendarFeed | null>;
  /** Whether the intel lane is still loading — silence is not an answer. */
  readonly intelBusy: ReturnType<typeof createIntelModel>["intelBusy"];
  /** What the evidence supervisor is waiting for, and when it retries. */
  readonly evidenceStatus: ReadSignal<readonly LaneStatus[]>;
  /** A once-a-second clock, so "retrying in 42s" counts down. */
  readonly nowMs: ReadSignal<number>;
}

export function createSetupModel(ctx: ShellContext, deps: SetupModelDeps) {
  const { state, feed, account } = ctx;
  const {
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
  } = deps;
  const { decision, spread, brokerQuote, macroReads, decisionBusy } = decisionSection;
  const bars = replay.bars;

  /**
   * What the last pass decided, for readers that need more than the view:
   * the dock verdict's label, `deepen`'s R, the expert's `get_setup`, and dev
   * inspection. Written ONLY by `setupView` below.
   */
  const last: {
    /** The setup engine's most recent field, not just its winner. */
    choice: ReturnType<typeof chooseSetup> | null;
    /** The replayed trials behind the card's base rate. */
    sim: Simulation | null;
    /** The R the card last replayed at. `deepen` must use the same one or it
        produces a base rate for a different trade than the one on screen. */
    rMultiple: number;
    /** The deep replay's second opinion on the engine's pick. */
    rec: ReturnType<typeof recommend> | null;
    /**
     * The market's own readings, for the Autonomous card's checks.
     *
     * Null until the first pass, and null again whenever this model refuses to
     * answer — its guards are about the series matching the instrument on
     * screen, and an environment measured on the wrong market is worse than
     * none. The card reads null as "can't check yet", which is the truth.
     */
    env: GateEnvironment | null;
  } = { choice: null, sim: null, rMultiple: 2, rec: null, env: null };
  let simCache: { key: string; sim: Simulation } | null = null;

  /**
   * The Setup card's view.
   *
   * Composition, not new analysis: the read comes from `decision`, the swing
   * from the detections the chart already found, the ATR from `studies`, the
   * size from `risk/sizing` against the ONE account, and the gates from
   * thresholds the user set. Nothing here computes a fresh opinion.
   */
  let heldPlan: TradePlan | null = null;
  /**
   * Which series `heldPlan` describes.
   *
   * A PLAN IS A STATEMENT ABOUT ONE INSTRUMENT ON ONE TIMEFRAME, and without
   * this it was carried across both. `stablePlan` only discards a plan when
   * PRICE has drifted `REDRAW_ATR` from where it was drawn — and switching
   * timeframe moves no price at all, so a 1-minute plan survived onto the
   * hourly chart intact.
   *
   * Measured on XAUUSD, 1m → 1h → 1m: chart ATR went 1.45 → 18.80 → 1.49 and
   * the plan never changed. A 0.72-point entry zone — one minute's worth of
   * range — was still on screen on the hourly, and the sanity gate was
   * refusing it on a ratio computed against a volatility from another
   * timeframe.
   *
   * Symbol changes mostly self-healed, because the price gap between two
   * instruments is enormous and trips the drift test by accident. "By
   * accident" is not a guarantee: two instruments quoted near the same number
   * would not trip it at all.
   */
  let heldPlanKey = "";

  /**
   * Which detector the current read is leaning on.
   *
   * The highest-confidence DRAWN structure pointing the way the decision
   * leans. Drawn rather than found, deliberately: the journal should record
   * the setup you were actually looking at, not one the density filter left
   * off the chart.
   */
  /** The open journal entry for what is on screen, if there is one. */
  const openHere = () =>
    journal.entries().find(
      (e) => e.exit === null && e.symbol === state.symbol() && e.timeframe === state.timeframe(),
    ) ?? null;

  /**
   * Exit management for the position you are actually in.
   *
   * Null when there is no open entry for this instrument — the card must not
   * invent a trade to manage. `invalidationOf` is fed the SAME detections the
   * chart is drawing, so the terminal never holds two opinions about whether
   * structure has broken.
   */
  const exitRead = () => {
    const open = openHere();
    const series = bars();
    if (open === null || series.length === 0) return null;
    const openedAtBar = openedBarIndex(series, open.openedAt);
    if (openedAtBar === null) return null;
    const trade = {
      direction: open.direction,
      entry: open.entry,
      stop: open.stop,
      target: open.target,
      openedAtBar,
      setupKind: open.setupKind,
    };
    return readExit(trade, series, exitRules(), invalidationOf(trade, detections()));
  };

  /**
   * The macro lane's net direction, -1..+1, or null when it produced nothing.
   *
   * Weighted by each read's own weight, so a tight correlation on a series
   * that has actually moved counts for more than a loose one that has not.
   *
   * NULL AND ZERO ARE DIFFERENT and the verdict depends on the distinction:
   * null is "no macro series is loaded, or none is correlated enough to
   * speak", zero is "they are loaded, measured, and neutral". Only the second
   * is a finding, and only a finding should be able to raise a conflict.
   */
  const netMacroLean = (): number | null => {
    const ev = macroEvidence(macroReads(), Date.now());
    const directional = ev.filter(
      (e): e is typeof e & { lean: number } => typeof e.lean === "number",
    );
    if (directional.length === 0) return null;
    const wSum = directional.reduce((a, e) => a + e.weight, 0);
    if (wSum <= 0) return null;
    return directional.reduce((a, e) => a + e.lean * e.weight, 0) / wSum;
  };

  /**
   * A quantity a human can read.
   *
   * `sizing.ts` rounds to the instrument's `qtyStep` when it has one — and
   * plenty do not, XAUUSD among them, so the card was rendering
   * "0.1291181424547554". Sixteen decimal places is not more precise, it is
   * just a float that nobody trimmed, and it makes the whole card look
   * unfinished.
   *
   * Significant figures rather than fixed decimals, because one field renders
   * both 0.129 lots of gold and 12,500 units of a small-cap: `toFixed(2)`
   * would turn the first into "0.13" and the second into a wall of zeroes.
   */
  const formatQty = (q: number): string => {
    if (!Number.isFinite(q)) return "—";
    const abs = Math.abs(q);
    if (abs >= 1000) return q.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (abs >= 1) return q.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (abs >= 0.01) return q.toFixed(4);
    /* Below a hundredth the leading zeros carry no information, so precision
       is spent on the digits that do. */
    return q.toPrecision(3);
  };

  const setupView = computed<SetupView | null>(() => {
    const d = decision();
    const series = bars();
    if (series.length === 0) return null;

    /**
     * REFUSE TO RENDER ACROSS A SYMBOL SWITCH.
     *
     * `bars` keeps the previous instrument's series while the new one loads —
     * correct for the chart, which must not blank — so for a second or two
     * everything derived from it describes the OLD symbol while the card is
     * titled with the new one. Measured: gold's live broker spread (0.18)
     * divided by Bitcoin's stop distance (~460), rendered as "Spread is 0.0% of
     * the stop distance — Measured from your broker's live bid-ask". A gate
     * that decides whether a trade is affordable, passing on arithmetic that
     * crossed two instruments, with a provenance line vouching for it.
     *
     * The card's idle state is the honest answer for that second.
     */
    if (feed.loadedSymbol() !== state.symbol()) return null;
    /* AND the timeframe, which is the silent half of the same bug. A symbol
       switch changes the price by orders of magnitude and tends to produce
       something visibly absurd; a timeframe switch changes no price at all and
       every volatility, so a plan built across one looks entirely reasonable
       and is about a chart nobody is looking at. Measured on XAUUSD 1h → 1m: a
       1.00× ATR stop placed 18.94 points away — the hourly ATR — on a minute
       chart whose ATR was 1.47, then reported as 12.89× and refused. */
    if (feed.loadedTimeframe() !== state.timeframe()) return null;

    /**
     * AND THE SERIES IN HAND MUST BE THE ONE THOSE TWO ARE DESCRIBING.
     *
     * `bars` is not `feed.bars` — it is `replay.bars`, a computed over it. So
     * the two guards above can both be satisfied by signals that have already
     * updated while the series this function actually reads is still the
     * previous instrument's. Effects here flush in queue order, not
     * topological order, and that window is real.
     *
     * Measured switching XAUUSD → BTCUSDT: `loadedSymbol`, `loadedTimeframe`
     * and the Studies panel had all moved to Bitcoin while the plan was built
     * from gold's ATR of 1.85, giving a "1.00× ATR volatility stop" 1.85
     * points wide on a chart whose ATR was 32.55 — reported as 0.06× ATR and
     * refused for being inside the noise. It did not self-heal: the plan is
     * held still once drawn, so the wrong one simply stayed.
     *
     * Replay hands back the source array BY IDENTITY when it is off, which is
     * what makes this a comparison rather than a scan.
     */
    if (!replay.active() && series !== feed.bars()) return null;

    /* AND the derived readings have to have caught up too, which the two
       signals above cannot tell you. `setupView` depends on `bars` both
       directly and through `studies`, and effects flush in queue order rather
       than topological order — so this can run with the new series and the old
       ATR. Measured twice: on XAUUSD 1m → 1h as a 2.04 stop on a 19.10 ATR
       chart, refused for being 0.11× ATR; and on BTCUSDT → XAUUSD as gold's
       price carrying Bitcoin's ATR of 26.71. See the stamp on `studies`, and
       note that it compares the ARRAY, not its timestamps — two instruments on
       the same timeframe share every timestamp they have. */
    const st = studies();
    if (st.stamp.from !== series) return null;

    const price = series[series.length - 1]?.c ?? 0;
    const atr = st.atr;
    const direction: "long" | "short" = d.bias === "short" ? "short" : "long";

    /* The most recent swing on the side the stop would sit. `detectStructure`
       already found these; re-deriving them here would be a second opinion. */
    /* `level` detections are the swing-derived support/resistance the chart
       already found. Their `level` shapes carry the price, which is the only
       part a stop needs. */
    const swings = detections()
      .filter((x) => x.kind === "level")
      .flatMap((x) =>
        x.shapes.filter((sh) => sh.type === "level").map((sh) => (sh as { y: number }).y),
      );
    const below = swings.filter((y) => y < price).sort((a, b) => b - a)[0] ?? null;
    const above = swings.filter((y) => y > price).sort((a, b) => a - b)[0] ?? null;
    const nearestSwing = direction === "long" ? below : above;

    /**
     * WHICH setup, chosen properly, and whether there is one at all.
     *
     * This replaces `leadingSetupKind()` — highest confidence anywhere on the
     * chart — which ignored the read, ignored how old the structure was, and
     * ignored whether price had already run past it. See setup/engine.ts for
     * the four ways that went wrong and the fifth, which is the one the
     * operator kept photographing: with no setup at all the card still drew a
     * full plan, labelled it "discretionary", and then blamed a gate for
     * refusing it.
     */
    const chosen = chooseSetup({
      detections: detections(),
      atBar: Math.max(0, series.length - 1),
      price,
      atr,
      bias: d.bias,
      /* The read's own conviction, not its direction's sign. A 12% read
         agreeing with a setup is barely a fact. */
      conviction: Math.min(1, Math.abs(d.confidence)),
      maxAtrMultiple: rules().maxStopAtr,
      minAtrMultiple: rules().minStopAtr,
      /* Bars, from the timeframe: a setup stays live for about a session and a
         half, and a session is a different number of bars on every chart. */
      liveForBars: liveBarsFor(intervalMs(state.timeframe())),
      record: (kind) => {
        const st = bySetup(journal.entries()).get(kind);
        /* `n` is CLOSED trades. Scratches are neither, so they are excluded
           from both sides rather than silently counted as losses. */
        if (st === undefined || st.n === 0) return null;
        return { wins: st.wins, losses: st.losses };
      },
    });

    /**
     * THE STOP COMES FROM THE SETUP NOW.
     *
     * `buildPlan` prefers whichever of the structural and volatility stops sits
     * further from entry, and the structural one used to be "the nearest swing
     * level on that side" — a level with no relationship to the idea being
     * traded. The chosen setup publishes the price at which it is wrong, so
     * that is what the plan is invalidated on, and the label on the card
     * finally describes the plan underneath it.
     */
    const swing = chosen.best?.candidate.invalidation ?? nearestSwing;
    last.choice = chosen;

    /* Drop the held plan the moment it stops describing what is on screen.
       See `heldPlanKey`. */
    const planKey = `${state.symbol()}|${state.timeframe()}`;
    if (planKey !== heldPlanKey) {
      heldPlan = null;
      heldPlanKey = planKey;
    }

    /**
     * NO SETUP, NO PLAN. The guard the note above only half-made.
     *
     * That note says the fix was to take the stop from the chosen setup rather
     * than from "the nearest swing level on that side". It changed where the
     * stop came from and left the `?? nearestSwing` fallback in place — so with
     * `chosen.best === null` the builder still ran, still found a swing, and
     * still produced a complete plan. The card then printed a full entry zone,
     * stop and two targets under the words "There is no setup here — this is
     * not a gate refusing one", and labelled the block "NOT LIVE — a gate is
     * refusing it". Three statements, three different accounts of the same
     * moment, one of them an actionable price.
     *
     * The operator photographed this again on XAUUSD 1h at v55. It is the same
     * bug the note describes as fixed, which is why the guard is here at the
     * point the plan is BUILT rather than anywhere it is rendered: every render
     * site would have to remember, and one of them would not.
     *
     * `heldPlan` is cleared too. Leaving it would let a plan from before the
     * setup expired come back the moment any setup reappeared, carrying an
     * entry zone drawn for a structure that no longer exists.
     */
    const built =
      chosen.best === null
        ? null
        : stablePlan(heldPlan, {
            direction,
            price,
            atr,
            swing,
            /* The operator's own ceiling, so the builder stops proposing stops
               their own gate will refuse. See `maxAtrMultiple` in
               setup/plan.ts. */
            maxAtrMultiple: rules().maxStopAtr,
          });
    const plan = built !== null && built.ok ? ({ ...built } as TradePlan) : null;
    heldPlan = plan;

    /**
     * WHAT HAPPENED THE LAST N TIMES THIS SETUP APPEARED HERE.
     *
     * The engine can say this candidate beat 272 others. It cannot say the
     * idea works. `simulateKind` replays every completed historical instance
     * of the same detector on this instrument against the bars that actually
     * followed it, at the R the plan is actually using — so the card can put a
     * base rate next to the score instead of an ordinal on its own.
     *
     * Deliberately NOT fed back into the ranking: the candidates were found on
     * the same bars the trials are scored on, and ranking by in-sample
     * performance is the exact mechanism behind the PBO of 89% this terminal
     * already measures. See the header of setup/simulate.ts.
     *
     * Memoised on the identity of the DATA and the plan's R, not on the
     * moment: `refreshDecision` runs on ticks, and a 300-trial replay per tick
     * would be paid for out of the frame budget for no new information.
     */
    const sim = ((): Simulation | null => {
      const best = chosen.best;
      const dd = detectData();
      if (best === null || dd === null || plan === null) return null;
      /**
       * THE REPLAY HORIZON IS NOT THE LIVE WINDOW.
       *
       * `liveBarsFor` answers "how long does this setup stay TAKEABLE" — about
       * a session and a half, up to 120 bars. That is the wrong question here.
       * A trade needs however long it needs to resolve, and using the takeable
       * window meant discarding every analogue within 120 bars of the live
       * edge: on ETHUSDT 15m that cut the sweep sample from 18 instances to 4.
       *
       * `HORIZON_BARS` is the terminal's existing answer, and using it makes
       * three numbers comparable that otherwise could not be: this simulated
       * hit rate, the recorded hit rate of claims in learn/, and the labels
       * `server/quant/ml.py` fits its classifier on — all three now ask what
       * happened within the same 24 bars.
       */
      const horizon = HORIZON_BARS;
      /* `plan.r` is ONE R IN PRICE — the entry-to-stop distance — not the
         reward-to-risk multiple. Passing it as the multiple put the simulated
         target 165 R away on ETHUSDT 1d and every one of the twelve trials
         stopped out inside a bar, which is what a target price cannot be
         reached in a lifetime looks like from the outside. The multiple is the
         first target measured in those units. */
      const rMultiple = planRMultiple(plan);
      if (!(rMultiple > 0)) return null;
      last.rMultiple = rMultiple;
      const key = [
        state.symbol(),
        state.timeframe(),
        best.candidate.kind,
        best.candidate.direction,
        dd.c.length,
        rMultiple.toFixed(2),
        horizon,
      ].join("|");
      /**
       * DEEP HISTORY FIRST, the chart window only as a fallback.
       *
       * The deep pass replays the same kinds over everything the archive holds
       * — typically thousands of bars against the chart's 800 — and it is the
       * difference between a sample that can be characterised and one that
       * cannot. Asked for here rather than on a timer so it tracks whatever
       * chart and R the operator is actually looking at, and memoised inside
       * `createDeepReplay` so asking on every tick costs one map lookup.
       *
       * CHECKED BEFORE `simCache`, NOT AFTER. The deep pass is asynchronous, so
       * the first few ticks after a chart change find nothing and fall through
       * to the shallow replay — and the cache key cannot see the difference,
       * because none of the things it is built from change when the pass
       * lands. Caching the fallback ahead of the lookup would therefore pin the
       * 800-bar answer for as long as the operator stayed on that chart, and
       * the deep sample would only ever appear after an unrelated reload.
       */
      deepReplay.request(state.symbol(), state.timeframe(), rMultiple);
      const deep = deepReplay.lookup(
        state.symbol(),
        state.timeframe(),
        best.candidate.kind,
        best.candidate.direction,
      );
      if (deep !== null) return deep;

      if (simCache !== null && simCache.key === key) return simCache.sim;
      const out = simulateKind(
        best.candidate.kind,
        best.candidate.direction,
        detections(),
        dd,
        dd.c.length,
        {
          rMultiple,
          horizonBars: horizon,
          /* Both stop rules come from the operator's own settings, not from
             anything this module invented: the fallback used when a detection
             publishes no geometry, and the floor applied to every trial — the
             same floor `buildPlan` applies to the live plan, so the replay
             prices the trade the terminal would actually have proposed. */
          atrStopMultiple: rules().minStopAtr,
          minAtrMultiple: rules().minStopAtr,
        },
      );
      simCache = { key, sim: out };
      return out;
    })();
    last.sim = sim;

    /**
     * THE SECOND OPINION.
     *
     * `chooseSetup` ranks by structure; the deep replay says what each of those
     * structures has been worth here. They disagree often, and for a reason
     * that is not a fault in either: sweeps, gaps and order blocks are mostly
     * reported while LIVE and so leave almost no history, while breaks of
     * structure and completed formations are events and leave plenty.
     *
     * Reported, never merged. Re-ranking the engine by an in-sample hit rate
     * would select the luckiest of three hundred candidates found on the same
     * bars the rate is measured over — the PBO-89% mechanism exactly.
     */
    const deepNow = deepReplay.result();
    const rec =
      deepNow !== null && deepNow.symbol === state.symbol() && deepNow.timeframe === state.timeframe()
        ? recommend({ ranked: chosen.ranked, sims: deepNow.sims, rMultiple: last.rMultiple })
        : null;
    last.rec = rec;

    const acct = account.effective();
    const heat = portfolioHeat(openBook(), acct.equity);
    const sized =
      plan !== null
        ? sizePosition({
            equity: acct.equity,
            riskPct: acct.riskPct,
            entry: plan.entry,
            stop: plan.stop,
          })
        : null;

    const sp = spread();
    const bq = brokerQuote();
    const cal = calendar();
    const nextEvent =
      cal && cal.ok
        ? (cal.events
            .map((r) => r.event)
            .filter((e) => e.at > Date.now())
            .sort((a, b) => a.at - b.at)[0] ?? null)
        : null;

    const feedNow = feed.state();
    const spanNow = intervalMs(state.timeframe());

    /**
     * What the terminal's own resolved record says about this setup.
     *
     * Read live from the ledger every time the card rebuilds, rather than
     * cached: a claim resolving is exactly the event that should change this,
     * and a cached prior would go on arguing from a record that has moved.
     *
     * `learn.enabled()` is honoured — with the ledger off there is no record to
     * consult and the gate says so rather than inventing one from a partial
     * history the operator chose not to keep.
     */
    const record = learn.enabled()
      ? priorFor(learn.snapshot().claims, {
          symbol: state.symbol(),
          timeframe: state.timeframe(),
          kind: chosen.best?.candidate.kind,
          side: chosen.best?.candidate.direction,
        })
      : null;

    /*
     * THE ENVIRONMENT, NAMED, so the Autonomous card can be judged by the same
     * readings — see `GateEnvironment` in setup/gates.ts. It is everything the
     * checks need that is not about this particular plan; the four plan facts
     * are supplied beside it, and `record` is an argument because a rule's
     * record and a detector's are different objects about different things.
     */
    const env: GateEnvironment = {
      /* The gate every other gate stands on. `classify` already calls three
         bar-spans stale; the gate uses the same threshold rather than inventing
         a second definition of "old" that could disagree with the badge. */
      dataAgeMs: Number.isFinite(feedNow.tickAgeMs) ? feedNow.tickAgeMs : null,
      dataStaleAfterMs: spanNow > 0 ? spanNow * 3 : 120_000,
      dataTransport: feed.transport(),
      clockOffsetMs: brokerClockOffsetMs(),
      /* Only the broker bridge keeps its own server clock. Binance and the
         public venues stamp klines in UTC, and asking this of them would put a
         permanent "unverified" on a feed with nothing to verify. */
      clockMatters: feed.activeSource() === "mt5",
      minutesToEvent: cal === null || !cal.ok ? null : nextEvent ? (nextEvent.at - Date.now()) / 60000 : 24 * 60,
      eventName: nextEvent?.title ?? null,
      /* Every threshold below is the USER'S, from Settings ▸ Trading rules.
         They were literals here while the card said "your limit is 6.0%" and
         "your floor is 60%" about numbers nobody had ever been shown. */
      embargoMinutes: rules().embargoMinutes,
      /**
       * The dealing spread first, the cross-venue basis only as a fallback.
       *
       * They are different measurements — see data/brokerquote.ts — and this
       * gate is about the cost of ENTERING, which is the bid-ask. The broker's
       * own quote is that number exactly, for the venue that fills you. The
       * cross-venue gap was standing in for it because nothing else was
       * available, and on gold nothing was available at all, so the gate simply
       * said it could not check.
       */
      spread: bq && bq.ok ? bq.spread : sp && sp.ok ? (sp.spreadPct / 100) * price : null,
      /**
       * `"book"` when the quote came from an exchange's top of book, `"dealing"`
       * when it came from the broker bridge.
       *
       * Kept apart because the two carry different guarantees. A broker's quote
       * is the price it will deal at; an exchange's best bid and ask are
       * resting orders you must FIT INSIDE, and the size that fits is a fact
       * the card can only state if the kinds are distinguishable here.
       */
      spreadKind:
        bq && bq.ok ? ("depth" in bq && bq.depth ? "book" : "dealing") : sp && sp.ok ? "cross-venue" : null,
      /* The thinner side: crossing costs whichever side you take, and quoting
         the deeper one would flatter every plan that happens to be going the
         other way. */
      topOfBookQty:
        bq && bq.ok && "depth" in bq && bq.depth ? Math.min(bq.depth.bidQty, bq.depth.askQty) : null,
      spreadBudgetPct: rules().spreadBudgetPct,
      openHeatPct: heat.heatPct,
      maxHeatPct: rules().maxHeatPct,
      realisedTodayPct: acct.equity > 0 ? (riskDesk.realisedToday() / acct.equity) * 100 : 0,
      dailyLossLimitPct: rules().dailyLossLimitPct,
      coverage: d.coverage,
      coverageCeiling: d.attainable,
      coverageFloor: rules().coverageFloor,
      /* `failed`, not `absent`. See `sourcesFailed` — one is a service to go
         and start, the other is a source this instrument does not have, and
         the card was rendering them as the same percentage. */
      sourcesFailed: d.missing.filter((m) => m.state === "failed").map((m) => m.label),
      saneAtrBand: [rules().minStopAtr, rules().maxStopAtr],
    };
    last.env = env;

    const gates = gatesFor(
      env,
      {
        plannedQty: sized?.ok && Number.isFinite(sized.qty) ? sized.qty : null,
        stopDistance: plan?.r ?? 0,
        thisTradeRiskPct: sized?.ok ? sized.riskPct : acct.riskPct,
        /* The LIVE multiple, not the one frozen into the plan when it was
           drawn. See `stopAtrNow` — the stored field made this gate a
           statement about a moment that had passed, and on XAUUSD it stood a
           1.83× stop down as "23.84× ATR" across a timeframe switch. */
        stopAtrMultiple: plan === null ? 0 : stopAtrNow(plan, atr),
      },
      record,
      /* NO SEARCH. A setup drawn by hand on this desk was not selected out of a
         field, so it has no multiplicity to pay for and the search row is not
         shown. That is a stated null rather than an omission: the argument is
         required precisely so the autonomous path cannot forget to pass its own. */
      null,
    );

    const money = (n: number): string =>
      `${acct.currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

    return {
      verdict: verdict(gates, {
        direction,
        score: Math.abs(d.score) * 100,
        coverage: d.coverage,
        /* ARMED vs GO: gates passing means you are ALLOWED to take the trade,
           not that price is offering it. Null when there is no plan, in which
           case the card shows `planProblem` instead. */
        trigger: plan
          ? { price, entryLow: plan.entryLow, entryHigh: plan.entryHigh }
          : null,
        macroLean: netMacroLean(),
        strategy: chosen.best?.candidate.kind ?? null,
      }),
      plan,
      stopAtrLive: plan === null ? NaN : stopAtrNow(plan, atr),
      /**
       * Why there is no plan, when there is none.
       *
       * Three cases, and they must not be collapsed. `built === null` means no
       * setup was chosen at all — the engine's own refusal is the explanation
       * and it is already on the card above, so repeating a builder's reason
       * here would invent a second, different account of the same silence.
       * `built.ok === false` means a setup exists and the plan could not be
       * drawn for it, which is the builder's story to tell.
       */
      planProblem: built === null ? null : built.ok ? null : built.reason,
      size:
        sized && sized.ok
          ? {
              qty: formatQty(sized.qty),
              riskMoney: money(sized.riskAmount),
              riskPct: `${sized.riskPct.toFixed(2)}% of equity`,
              notional: money(sized.notional),
              margin: money(sized.notional / Math.max(1, acct.leverage)),
            }
          : null,
      gates,
      symbol: state.symbol(),
      timeframe: state.timeframe(),
      /**
       * The line that used to read "No record for this setup type yet".
       *
       * It is a real measurement now, and it still says exactly that whenever
       * the record does not exist — `recordLine` refuses to print a percentage
       * below `MIN_SAMPLE`, because a 67% hit rate off nine trades has a 95%
       * band running from about 30% to 93% and that band includes "you are
       * losing".
       *
       * Keyed on the setup kind the plan came from, so it answers the question
       * the card is actually asking: not "how am I doing" but "how am I doing
       * on THIS". A gap between planned and realised R is appended when it is
       * large enough to act on.
       */
      /**
       * What the read is standing on, for the card's evidence block.
       *
       * Built from the SAME `decide()` result the verdict came from, not a
       * second call: two assemblies of the same evidence can disagree if a lane
       * lands between them, and a card whose coverage figure contradicts its
       * own source list is worse than one with no source list at all.
       */
      evidence: {
        coverage: d.coverage,
        answered: d.evidence
          .filter((e) => e.state === "fresh" || e.state === "stale")
          .map((e) => ({
            label: e.label,
            reason: e.state === "stale" ? `${e.reason} (stale, counted at half weight)` : e.reason,
          })),
        missing: d.missing.map((e) => ({
          label: e.label,
          reason: e.reason,
          kind: (e.state === "failed"
            ? "failed"
            : e.state === "unavailable"
              ? "unavailable"
              : "absent") as "absent" | "failed" | "unavailable",
        })),
        /* Silence during a load is not an answer, and the card must not let it
           read as one — the number moves as the lanes land. */
        loading: decisionBusy() || intelBusy(),
        /* Read through `nowMs` so the countdown in this sentence ticks. A line
           that says "retrying in 42s" and then says it for five minutes is a
           worse lie than saying nothing. */
        retrying: supervisorLine(evidenceStatus(), nowMs()),
      },

      setupRefusal: chosen.refusal,
      setupWaitingFor: chosen.waitingFor,
      setupWhy: chosenLine(chosen, atr),
      /* The base rate for whatever the engine chose, replayed from this
         chart's own bars. Null when there is no setup or no plan — there is
         no R to simulate at, and a track record quoted at the wrong R is a
         different setup's track record. */
      history:
        sim === null || plan === null
          ? null
          : {
              note: sim.note,
              n: sim.n,
              wins: sim.wins,
              hitRate: sim.hitRate,
              hitLow: sim.hitLow,
              expectancy: sim.expectancy,
              breakEven: breakEven(planRMultiple(plan)),
              medianBars: sim.medianBars,
              enough: sim.enough,
              adverse: sim.adverse,
              /* The bar count qualifies every number above it: the same setup
                 reads "4 instances" on the chart window and "75" once the
                 archive has been extended, and only one of those licenses a
                 statement. */
              bars: deepReplay.result()?.bars ?? 0,
              /* Not "has it been deepened" but "would deepening change
                 anything": the archive frequently already holds the full
                 target after a previous session, and offering to fetch what is
                 already held is a button that does nothing. */
              canDeepen:
                !(deepReplay.result()?.deepened ?? false) &&
                /* A margin, not equality. A vendor that serves 5,999 of a
                   requested 6,000 has given everything it has, and offering to
                   fetch the missing one is the button-that-does-nothing again. */
                (deepReplay.result()?.bars ?? 0) < DEEP_TARGET_BARS * 0.95,
              busy: deepReplay.busy(),
              progress: deepReplay.progress(),
              disagreement: rec?.disagreement ?? "",
              alternatives: (rec?.evidenced ?? []).map((r) => r.line),
              fieldNote: rec?.note ?? "",
              /* The knowledge base's cell for THIS setup in THIS context,
                 under the plan's own R. Reported beside the in-sample replay
                 above it, never merged with it. */
              prior: knowledgeBase.priorFor(
                state.symbol(),
                state.timeframe(),
                chosen.best?.candidate.kind ?? "",
                chosen.best?.candidate.direction === "short" ? "short" : "long",
                contextOfLatest(bars()),
                plan === null ? 0 : planRMultiple(plan),
              ),
            },

      /* The card's own track record. Reads the claim store directly rather
         than being handed a summary, so it can never disagree with the
         Learning desk about the same claims. */
      learned: cardLine(learn.claims(), state.symbol()),

      record: (() => {
        const kind = chosen.best?.candidate.kind ?? null;
        const stats = bySetup(journal.entries()).get(kind ?? "discretionary");
        const line = recordLine(kind, stats);
        const gap = stats === undefined ? "" : planGapLine(stats);
        return gap === "" ? line : `${line} ${gap}`;
      })(),

      exit: (() => {
        const ex = exitRead();
        if (ex === null) return null;
        return {
          openR: ex.openR,
          barsHeld: ex.barsHeld,
          headline: ex.headline?.text ?? null,
          headlineKind: ex.headline?.reason ?? null,
          /* The triggered one is already the headline; repeating it under
             itself is the card saying the same thing twice. */
          lines: ex.suggestions.filter((sg) => sg !== ex.headline).map((sg) => sg.text),
        };
      })(),
    };
  });

  return { view: setupView, last: last as Readonly<typeof last> };
}
