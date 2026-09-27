/**
 * The agent's tools — the ONLY way it can learn anything.
 *
 * THE CENTRAL DESIGN DECISION
 * A language model asked "what is BTC doing" will answer. It will produce a
 * price, a percentage and a confident sentence, and every one of those numbers
 * will be invented, because the model has no access to a market. In a terminal
 * whose entire premise is that no number appears without its source, that is
 * not a rough edge — it is the single worst thing the software could do.
 *
 * So the agent is built the other way round. It is given NO market knowledge in
 * its prompt and no ability to state a figure it did not fetch. Every fact it
 * can reach comes from a tool in this file, each tool reads the same live state
 * the panels on screen are reading, and the transcript SHOWS the calls. If the
 * agent says the 4-hour RSI is 71, there is a row above it saying
 * `get_indicators(BTCUSDT, 4h) → rsi 71.2`, and you can check it against the
 * chart. An answer with no tool calls above it is an answer about nothing, and
 * it looks like one.
 *
 * WHAT IS DELIBERATELY ABSENT
 * There is no order tool. No position tool. No withdrawal, transfer, key or
 * credential tool. This is not a policy written in a prompt that a jailbreak can
 * argue with — the capability does not exist in the process. The agent cannot
 * trade because there is nothing here to trade with, which is the only version
 * of that guarantee worth having.
 *
 * TOOLS MAY NAVIGATE. `set_symbol` and `set_timeframe` change what is on your
 * screen, which is genuinely useful ("show me ether on the 4-hour") and
 * genuinely harmless: the worst case is you are looking at the wrong chart, and
 * you can see that you are.
 */

import type { AgentImage } from "./provider";
import type { OpportunitiesReport, OutlookPlanInput, OutlookReport, SetupRead } from "./reads";
import type { SpecTest } from "../backtest/spectest";
import type { RuleSpec } from "../backtest/rules";
import { parseRuleSpec, ruleSpecSchema, RULE_COLUMN_IDS } from "./rulespec";

/** JSON-Schema subset both major tool-calling APIs accept unchanged. */
export interface ToolParamSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

export interface ToolDef {
  readonly name: string;
  /** Written for the model. Says what it returns AND what it does not know. */
  readonly description: string;
  readonly parameters: ToolParamSchema;
  /** True if the tool changes what the user sees. Rendered differently. */
  readonly mutates?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

export interface ToolResult {
  readonly ok: boolean;
  /** Structured payload, shown in the transcript and sent back to the model. */
  readonly data?: unknown;
  /** Set when ok is false. A plain sentence the model can relay verbatim. */
  readonly error?: string;
  /** One line summarising the call for the transcript row. */
  readonly summary?: string;
  /**
   * A picture the model should actually SEE, not a description of one.
   *
   * Tool results are JSON, and JSON cannot carry an image to either vendor's
   * API. So a tool that produces one puts it here, and the session appends it
   * as a following user turn — the only shape that works unchanged on both
   * Anthropic's content blocks and OpenAI's content parts.
   *
   * The tool result itself still says what was captured, so a provider with no
   * vision reports "a 1600×900 PNG was captured, and I cannot see it" instead
   * of describing a chart it never received.
   */
  readonly image?: AgentImage;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /**
   * Set when the provider could not parse the model's input for this call.
   *
   * The call is then NOT run: the tool would see `{}` and answer a question
   * nobody asked. The model gets this sentence back as the result instead,
   * so it can re-issue the call.
   */
  readonly inputError?: string;
}

/**
 * Everything a tool is allowed to read.
 *
 * Passed in rather than imported so the toolset is testable without a chart, a
 * network or a DOM — the whole agent loop is exercised against a fake context.
 */
/**
 * One slice of the knowledge base, as the analyst receives it.
 *
 * Snake case, like every other tool payload: these go to a model verbatim and a
 * field the model has to guess the meaning of is a field it will guess wrong.
 */
export interface KnowledgeSlice {
  /** "all" | "regime" | "session" | "hour" | "weekday". */
  readonly axis: string;
  /** The condition in words — "Trending", "London", "13:00 UTC", "Tuesday". */
  readonly condition: string;
  readonly trials: number;
  readonly wins: number;
  readonly hit_rate: number;
  /** Wilson 95% lower bound. The number to quote when quoting one. */
  readonly at_least: number;
  readonly expectancy_r: number;
  readonly median_bars: number;
  /** False below the sample floor. A false here forbids quoting a rate. */
  readonly usable: boolean;
  /** The study behind it is past its shelf life. Say so if you use it. */
  readonly stale: boolean;
  /** Bars the contributing studies were built from. */
  readonly from_bars: number;
  readonly sources: readonly string[];
  readonly last_updated: string;
}

export type KnowledgeRead =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly symbol: string;
      readonly timeframe: string;
      readonly kind: string;
      readonly direction: string;
      /** The conditions on screen right now, which is what the slices are keyed to. */
      readonly conditions_now: {
        readonly regime: string;
        readonly sessions: readonly string[];
        readonly hour_utc: number;
        readonly weekday: string;
      };
      /** "none" until something has been harvested; then "thin" or "usable". */
      readonly standing: string;
      /** One sentence, already honest about the sample. Quotable verbatim. */
      readonly verdict: string;
      readonly slices: readonly KnowledgeSlice[];
      readonly caveat: string;
    };

export interface TerminalAccess {
  symbol(): string;
  timeframe(): string;
  /** Newest-last closed bars for the pane in focus. */
  bars(): readonly { t: number; o: number; h: number; l: number; c: number; v: number }[];
  /** Feed health, verbatim from the freshness contract. */
  /**
   * `ageMs` is null when the feed has not reported a tick age.
   *
   * It used to be substituted with 0 at the call site, which told the analyst
   * the last tick had arrived THIS INSTANT — the freshest possible answer — at
   * exactly the moment nothing was known about it.
   */
  feed(): { quality: string; note: string; source: string; ageMs: number | null };
  indicators(): { rsi: number; atr: number; atrPct: number; ema20: number; ema50: number; ema200: number };
  detections(): readonly { kind: string; label: string; confidence: number; reason: string; at: number }[];
  alerts(): readonly { id: string; label: string; symbol: string; timeframe: string; armed: boolean }[];
  /** Higher-timeframe reads, if the user has any turned on. */
  higher(): readonly { timeframe: string; bias: string; score: number }[];
  regime(): Promise<{ ok: boolean; state?: string; confidence?: number; note?: string; error?: string }>;
  forecast(): Promise<{
    ok: boolean;
    pUp?: number;
    accuracy?: number;
    brier?: number;
    standing?: string;
    usable?: boolean;
    error?: string;
  }>;
  calendar(): Promise<readonly { when: string; what: string; importance: string }[]>;
  storage(): Promise<{ series: number; bars: number; bytes: number; note: string }>;
  setSymbol(symbol: string): void;
  setTimeframe(tf: string): void;
  /** Timeframes the terminal actually offers. Used to validate arguments. */
  timeframes(): readonly string[];

  /* --- risk. All of it is arithmetic over numbers the USER configured. --- */

  /** The user's own risk settings and current book. Never the model's choice. */
  riskState(): {
    equity: number;
    defaultRiskPct: number;
    openPositions: number;
    /** Null when account equity is unset, so open risk has no percentage. */
    heatPct: number | null;
    realisedToday: number;
    guards: { dailyLossPct: number; maxHeatPct: number; maxPositions: number };
    unprotected: readonly string[];
  };
  /** Run the size calculator. The caller supplies entry and stop. */
  sizePosition(args: { entry: number; stop: number; riskPct?: number }): {
    ok: boolean;
    reason?: string;
    qty: number;
    notional: number;
    riskAmount: number;
    riskPct: number;
    requestedRiskPct: number;
    stopDistancePct: number;
    direction: string;
    warnings: readonly string[];
    assumptions: readonly string[];
  };
  /** Where N x ATR sits from a price. Volatility arithmetic, not a suggestion. */
  atrStop(args: { entry: number; multiple: number; direction: "long" | "short" }): {
    ok: boolean;
    reason?: string;
    stop: number;
    distancePct: number;
    note: string;
  };
  /** Reward-to-risk and the win rate at which it breaks even. */
  rewardToRisk(args: { entry: number; stop: number; target: number }): {
    ok: boolean;
    reason?: string;
    r: number;
    breakEvenWinRate: number;
  };

  /* --- heavier engines, all of which already exist elsewhere ----------- */

  /** Walk-forward study over the loaded series. Seconds of CPU. */
  runBacktest(family: string): Promise<{
    ok: boolean;
    error?: string;
    family?: string;
    standing?: string;
    verdict?: string;
    why?: string;
    trades?: number;
    pbo?: number;
    warnings?: readonly string[];
  }>;
  /** Top of the screener's ranking. Expensive; the venue budget applies. */
  scanMarket(limit: number): Promise<{
    ok: boolean;
    error?: string;
    rows?: readonly { symbol: string; changePct: number; bias: string; score: number; why: string }[];
  }>;

  /* --- drawings -------------------------------------------------------- */

  /**
   * Reported fundamentals for the instrument on screen, or null when the
   * aggregator does not cover it (metals, FX, equities).
   */
  fundamentals(): {
    ok: boolean;
    reason?: string;
    name?: string;
    rank?: number;
    marketCap?: number;
    fullyDiluted?: number;
    volume24h?: number;
    circulating?: number;
    maxSupply?: number | null;
    floatPct?: number | null;
    dilutionMultiple?: number | null;
    turnoverPct?: number;
    belowAthPct?: number;
    change24h?: number;
    change7d?: number;
    change30d?: number;
    notes?: readonly string[];
    source?: string;
  };

  /**
   * The chart as pixels — the same composite `Export chart` writes to a PNG.
   *
   * Null when nothing has painted. The caption is burned into the image by the
   * compositor, so a model that can see it can also read which instrument and
   * timeframe it is looking at without being told separately, and cannot be
   * shown one chart while being asked about another.
   */
  chartImage(): {
    ok: boolean;
    reason?: string;
    mediaType?: string;
    dataBase64?: string;
    width?: number;
    height?: number;
    caption?: string;
  };

  /* --- the terminal's own record ---------------------------------------
   *
   * WHY THE AGENT NEEDED THESE AT ALL
   *
   * Twenty-five tools, and not one of them could answer "how has this actually
   * gone". The agent could read every indicator, every detection, every model
   * output and the whole assembled decision — and was structurally incapable
   * of noticing that the setup it was describing had never once worked on this
   * chart. It could describe the terminal's opinion in great detail and had no
   * way to check it against an outcome.
   *
   * These three close that gap, and they are the only tools here whose answer
   * can contradict the rest of the toolset. That is the point of them.
   */

  /**
   * What every setup kind on this chart has historically been worth.
   *
   * From setup/deep.ts: real instances replayed over the archive, at the R the
   * current plan uses. In-sample by construction — the patterns were found on
   * the bars they are scored over — so it is a prior, and the tool says so in
   * its own payload rather than trusting the model to remember.
   */
  setupHistory(): {
    ok: boolean;
    reason?: string;
    symbol?: string;
    timeframe?: string;
    bars?: number;
    rMultiple?: number;
    breakEvenHitRate?: number;
    chosen?: { kind: string; direction: string } | null;
    kinds?: readonly {
      kind: string;
      direction: string;
      instances: number;
      wins: number;
      hitRate: number | null;
      hitRateLowerBound: number | null;
      expectancyR: number | null;
      medianBars: number | null;
      enoughToCharacterise: boolean;
      note: string;
    }[];
    disagreement?: string;
    caveat?: string;
  };

  /**
   * The accumulated knowledge base, asked about one setup in today's conditions.
   *
   * DISTINCT FROM BOTH ITS NEIGHBOURS, AND THE DISTINCTION IS THE VALUE.
   * `setupHistory` replays the chart in front of you, now, and forgets it the
   * moment the symbol changes. `conditionalEdge` slices THAT replay and
   * corrects for having examined twenty cells. This reads `learn/knowledge.ts`
   * — every harvest ever run, on this instrument and others, kept — so it can
   * answer "and how has this gone in a chopping market, on this instrument,
   * across six thousand bars harvested last week" without re-running anything.
   *
   * Every cell states its sample and whether the study behind it has gone
   * stale. Cells under the floor are returned marked unusable rather than
   * quietly omitted: "this has never been measured here" and "this was measured
   * and it is thin" are different facts, and only one of them is worth waiting
   * on.
   */
  knowledge(args: {
    symbol?: string | undefined;
    timeframe?: string | undefined;
    kind?: string | undefined;
    direction?: string | undefined;
  }): KnowledgeRead;

  /**
   * The operator's OWN record: claims the terminal made, and how they resolved.
   *
   * Distinct from `setupHistory` in the way that matters — these are things the
   * terminal actually said, at the time, before the outcome was known, so they
   * are out of sample. A model comparing the two is comparing a backtest with a
   * track record, which is the comparison the whole `learn/` module exists for.
   */
  /**
   * The conditional table from `server/mishel_edge.py`.
   *
   * The third record-shaped tool, and the one whose answer is USUALLY a
   * refusal — it slices one sample into twenty-odd cells and then corrects for
   * having done so. That refusal is the payload, not an error, which is why
   * this returns `ok: true` with a `text` saying nothing survived rather than
   * failing.
   */
  conditionalEdge(kind?: string): Promise<{
    ok: boolean;
    reason?: string;
    available?: boolean;
    trials?: number;
    days?: number;
    comparisons?: number;
    text?: string;
    data?: unknown;
  }>;
  trackRecord(): {
    ok: boolean;
    reason?: string;
    claims?: number;
    resolved?: number;
    pending?: number;
    takes?: { n: number; wins: number; hitRate: number | null; lowerBound: number | null };
    standDowns?: { n: number; wins: number; hitRate: number | null; lowerBound: number | null };
    gatesVerdict?: string;
    note?: string;
  };

  /** The operator's own journal: real trades, entered by hand. */
  journalRecord(): {
    ok: boolean;
    reason?: string;
    trades?: number;
    closed?: number;
    open?: number;
    wins?: number;
    losses?: number;
    hitRate?: number | null;
    expectancyR?: number | null;
    bySetup?: readonly { kind: string; n: number; wins: number; losses: number }[];
  };

  /** The assembled read across every source. See core/decision.ts. */
  decision(): {
    headline: string;
    bias: string;
    score: number;
    agreement: number;
    coverage: number;
    confidence: number;
    limits: readonly string[];
    wouldChange: readonly string[];
    evidence: readonly { label: string; lean: number | null; weight: number; reason: string; source: string; state: string }[];
    missing: readonly { label: string; state: string; reason: string }[];
  };

  /**
   * The leading read for the current instrument. See analysis/leading.ts.
   *
   * Returned with its three axes SEPARATE, exactly as the module keeps them.
   * Handing the model one blended number would undo the whole point at the last
   * step, and a language model given a single "leading score" will describe it
   * as a direction — that is what the word invites.
   */
  leading(): {
    ok: boolean;
    timing: number;
    direction: number | null;
    conviction: number;
    coverage: number;
    headline: string;
    components: readonly { label: string; family: string; speaks: string; value: number | null; reason: string; limit: string }[];
    reason?: string;
  };

  /**
   * Portfolio risk over the book, from stored bars. See risk/portfolio.ts.
   *
   * Async because it reads the archive. It never fetches, so the worst case is
   * a refusal naming the symbols that have no history — which the model is
   * told to repeat rather than work around.
   */
  portfolioRisk(): Promise<{
    ok: boolean;
    blocked: string | null;
    sample: number;
    gross: number;
    net: number;
    measuredLegs: number;
    effectiveBets: number;
    missing: readonly string[];
    tails: readonly { level: number; var: number; cvar: number; worst: number }[];
    contributions: readonly { symbol: string; cvarShare: number; fraction: number }[];
    betas: readonly { symbol: string; beta: number; r2: number; caveat: string | null }[];
    stress: readonly { label: string; factorMove: number; pnl: number; pctOfEquity: number; unreliable: readonly string[] }[];
    warnings: readonly string[];
  }>;

  /* --- the expert's reads ---------------------------------------------- */

  /** The Setup card's verdict, gates and plan — its own view, restated. */
  setup(): SetupRead;
  /**
   * The multi-bar outlook from analysis/outlook.ts, with target-before-stop
   * odds for `plan` — or for the Setup card's plan when `plan` is null.
   */
  outlook(plan: OutlookPlanInput | null): Promise<OutlookReport>;
  /** The Opportunities desk's pipeline over the top `universe` symbols by volume. */
  findOpportunities(args: { limit: number; universe: number }): Promise<OpportunitiesReport>;
  /** A validated rule set through backtest, walk-forward, gate, Monte Carlo and excursions. */
  testStrategy(spec: RuleSpec): Promise<SpecTest>;

  drawings(): readonly { id: string; kind: string; text: string; detail: string }[];
  /** Add a horizontal level at a price. Editable afterwards like any drawing. */
  drawLevel(args: { price: number; label?: string }): { ok: boolean; reason?: string; id?: string };
  /** Turn a detected structure into an editable drawing you own. */
  promoteDetection(args: { label: string }): { ok: boolean; reason?: string; id?: string; drew?: string };
}

const num = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toFixed(digits) : "unavailable";

/** A percentage with its sign, so a range reads "-3.1% to +4.0%". */
const signed = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "unavailable");

/** Reject an argument that is not a non-empty string, with a usable message. */
function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Build the toolset.
 *
 * Descriptions are written for the model and are unusually blunt about limits.
 * "Returns the classifier's out-of-sample accuracy; if it is below 0.53 the
 * probability is inside the noise and must not be presented as a signal" is a
 * sentence the model will actually respect, where a vague "be careful" is not.
 */
export function createToolset(t: TerminalAccess): ToolDef[] {
  const noArgs: ToolParamSchema = { type: "object", properties: {} };

  return [
    {
      name: "get_context",
      description:
        "The terminal's current state: which symbol and timeframe are on screen, " +
        "the data source, and how fresh it is. Call this FIRST in any conversation " +
        "about 'the chart' or 'this market', because the user is looking at " +
        "something specific and you cannot see their screen.",
      parameters: noArgs,
      run: () => {
        const feed = t.feed();
        const bars = t.bars();
        const last = bars[bars.length - 1];
        return {
          ok: true,
          summary: `${t.symbol()} ${t.timeframe()} · ${feed.quality} · ${bars.length} bars`,
          data: {
            symbol: t.symbol(),
            timeframe: t.timeframe(),
            source: feed.source,
            freshness: feed.quality,
            freshness_note: feed.note,
            data_age_seconds: feed.ageMs === null ? null : Math.round(feed.ageMs / 1000),
            bars_loaded: bars.length,
            last_close: last ? last.c : null,
            last_bar_time: last ? new Date(last.t).toISOString() : null,
          },
        };
      },
    },

    {
      name: "get_price_summary",
      description:
        "Recent price action for the loaded series: last close, the change over " +
        "the last N bars, and the range. Prices are as-fetched from the source " +
        "named by get_context — never estimate a price yourself.",
      parameters: {
        type: "object",
        properties: {
          lookback: {
            type: "integer",
            description: "How many bars back to measure. Default 24.",
          },
        },
      },
      run: (args) => {
        const bars = t.bars();
        if (bars.length < 2) {
          return { ok: false, error: "Fewer than two bars are loaded; there is nothing to compare." };
        }
        const raw = typeof args["lookback"] === "number" ? Math.floor(args["lookback"]) : 24;
        const look = Math.max(1, Math.min(raw, bars.length - 1));
        const last = bars[bars.length - 1] as { c: number; t: number };
        const then = bars[bars.length - 1 - look] as { c: number };

        let hi = -Infinity;
        let lo = Infinity;
        for (let i = bars.length - 1 - look; i < bars.length; i++) {
          const b = bars[i];
          if (!b) continue;
          if (b.h > hi) hi = b.h;
          if (b.l < lo) lo = b.l;
        }
        const change = then.c === 0 ? NaN : ((last.c - then.c) / then.c) * 100;
        return {
          ok: true,
          summary: `${t.symbol()} ${num(last.c, 4)} · ${num(change)}% over ${look} bars`,
          data: {
            symbol: t.symbol(),
            timeframe: t.timeframe(),
            last_close: last.c,
            change_pct_over_lookback: Number.isFinite(change) ? Number(change.toFixed(3)) : null,
            lookback_bars: look,
            range_high: hi,
            range_low: lo,
            as_of: new Date(last.t).toISOString(),
          },
        };
      },
    },

    {
      name: "get_indicators",
      description:
        "Indicator readings at the most recent CLOSED bar: RSI(14), ATR(14) both " +
        "absolute and as a percentage of price, and EMA 20/50/200. These are " +
        "computed locally from the loaded bars.",
      parameters: noArgs,
      run: () => {
        const i = t.indicators();
        if (!Number.isFinite(i.rsi)) {
          return { ok: false, error: "Not enough bars loaded to compute indicators (need at least 30)." };
        }
        return {
          ok: true,
          summary: `RSI ${num(i.rsi, 1)} · ATR ${num(i.atrPct, 2)}%`,
          data: {
            rsi_14: Number(i.rsi.toFixed(2)),
            atr_14: Number(i.atr.toFixed(6)),
            atr_pct_of_price: Number(i.atrPct.toFixed(3)),
            ema_20: Number.isFinite(i.ema20) ? Number(i.ema20.toFixed(6)) : null,
            ema_50: Number.isFinite(i.ema50) ? Number(i.ema50.toFixed(6)) : null,
            ema_200: Number.isFinite(i.ema200) ? Number(i.ema200.toFixed(6)) : null,
          },
        };
      },
    },

    {
      name: "list_structures",
      description:
        "Market structures the detectors have found on the loaded series: breaks " +
        "of structure, changes of character, fair value gaps, order blocks, " +
        "levels, double tops/bottoms, trendlines and divergences. Each carries " +
        "the detector's own confidence and its stated reason. These are " +
        "RULE-BASED detections, not predictions.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Optional filter, e.g. 'bos', 'fvg', 'order-block'.",
          },
          limit: { type: "integer", description: "Most recent N. Default 12." },
        },
      },
      run: (args) => {
        const kind = str(args, "kind");
        const limit =
          typeof args["limit"] === "number" ? Math.max(1, Math.min(50, Math.floor(args["limit"]))) : 12;
        let list = t.detections();
        if (kind) list = list.filter((d) => d.kind === kind);
        const recent = list.slice(-limit);
        if (recent.length === 0) {
          return {
            ok: true,
            summary: kind ? `no ${kind} found` : "no structures found",
            data: { structures: [], note: "The detectors found nothing matching on this series." },
          };
        }
        return {
          ok: true,
          summary: `${recent.length} structure${recent.length === 1 ? "" : "s"}`,
          data: {
            structures: recent.map((d) => ({
              kind: d.kind,
              label: d.label,
              confidence: Number(d.confidence.toFixed(3)),
              reason: d.reason,
              at: new Date(d.at).toISOString(),
            })),
          },
        };
      },
    },

    {
      name: "get_higher_timeframes",
      description:
        "Structure from the higher timeframes the user has enabled, projected onto " +
        "the current chart. Empty if the user has not turned any on — say so " +
        "rather than treating the absence as a neutral reading.",
      parameters: noArgs,
      run: () => {
        const rows = t.higher();
        return {
          ok: true,
          summary: rows.length === 0 ? "no higher timeframes enabled" : `${rows.length} timeframe(s)`,
          data: {
            enabled: rows.length > 0,
            timeframes: rows,
            note:
              rows.length === 0
                ? "The user has no higher timeframes enabled. This is an ABSENCE of information, not a neutral bias."
                : "",
          },
        };
      },
    },

    {
      name: "get_regime",
      description:
        "The regime model's read: a 3-state Gaussian mixture over return and " +
        "rolling volatility, labelled from measured means. It is called 'HMM-lite' " +
        "in its own source and is NOT a hidden Markov model. Requires the local " +
        "Python service; returns an error if it is not running.",
      parameters: noArgs,
      run: async () => {
        const r = await t.regime();
        if (!r.ok) return { ok: false, error: r.error ?? "The regime model is unavailable." };
        return {
          ok: true,
          summary: `${r.state} (${num((r.confidence ?? 0) * 100, 0)}%)`,
          data: { state: r.state, confidence: r.confidence, model_note: r.note },
        };
      },
    },

    {
      name: "get_forecast",
      description:
        "The classifier's probability that the next horizon return is positive, " +
        "WITH its measured out-of-sample accuracy and Brier score. Rules you must " +
        "follow: a Brier score at or above 0.25 is worse than always saying 50%, " +
        "and accuracy below 0.53 is inside the noise. In either case the " +
        "probability is not a signal and you must say so instead of relaying it.",
      parameters: noArgs,
      run: async () => {
        const f = await t.forecast();
        if (!f.ok) return { ok: false, error: f.error ?? "The forecast model is unavailable." };
        return {
          ok: true,
          summary: `p(up) ${num((f.pUp ?? 0) * 100, 1)}% · ${f.usable ? "usable" : "NOT usable"}`,
          data: {
            p_up: f.pUp,
            out_of_sample_accuracy: f.accuracy,
            brier_score: f.brier,
            usable_as_signal: f.usable === true,
            standing: f.standing,
          },
        };
      },
    },

    {
      name: "get_alerts",
      description:
        "The user's alert book: which alerts exist, what each one watches, on " +
        "which symbol and timeframe, and whether it is currently armed. An " +
        "empty book means no alerts are set, not that none fired.",
      parameters: noArgs,
      run: () => {
        const list = t.alerts();
        return {
          ok: true,
          summary: `${list.length} alert${list.length === 1 ? "" : "s"}`,
          data: { alerts: list },
        };
      },
    },

    {
      name: "get_calendar",
      description:
        "Scheduled economic events ahead. Timing is scheduled, not predicted. " +
        "Empty if the calendar source is unreachable — do not fill the gap.",
      parameters: noArgs,
      run: async () => {
        const rows = await t.calendar();
        return {
          ok: true,
          summary: `${rows.length} upcoming`,
          data: { events: rows },
        };
      },
    },

    {
      name: "get_storage",
      description:
        "How much history the terminal is holding locally, and the retention " +
        "policy note. Use for questions about stored data, disk use or coverage.",
      parameters: noArgs,
      run: async () => {
        const s = await t.storage();
        return {
          ok: true,
          summary: `${s.series} series · ${s.bars.toLocaleString()} bars`,
          data: s,
        };
      },
    },

    {
      name: "set_symbol",
      description:
        "Change the symbol on the user's chart. Use when they ask to see " +
        "something. Do not use to 'check' a symbol — you cannot read the result " +
        "in the same turn, because the data has to load first.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "e.g. BTCUSDT, XAUUSD" } },
        required: ["symbol"],
      },
      mutates: true,
      run: (args) => {
        const symbol = str(args, "symbol");
        if (!symbol) return { ok: false, error: "No symbol given." };
        const clean = symbol.toUpperCase();
        t.setSymbol(clean);
        return { ok: true, summary: `chart → ${clean}`, data: { symbol: clean } };
      },
    },

    {
      name: "see_chart",
      description:
        "Look at the chart the user is looking at, as a picture. Returns the same " +
        "composite the Export button writes: candles, indicators, detections, " +
        "drawings and the plan overlay, with the symbol, timeframe, source and " +
        "time burned into the image. Use it when the question is genuinely visual " +
        "— 'does this look like a wedge to you', 'what am I missing here' — and " +
        "NOT as a substitute for the numeric tools: a price read off pixels is a " +
        "guess, and get_price_summary is exact. If you cannot see images, say so " +
        "plainly rather than describing what you would expect a chart to show.",
      parameters: noArgs,
      run: () => {
        const img = t.chartImage();
        if (!img.ok || !img.dataBase64) {
          return { ok: false, error: img.reason ?? "The chart has not painted yet." };
        }
        return {
          ok: true,
          summary: `${img.width}×${img.height} PNG · ${img.caption ?? ""}`.trim(),
          data: {
            captured: true,
            width: img.width,
            height: img.height,
            caption: img.caption,
            /* Said in the RESULT, not only in the description, because this is
               the sentence a sightless provider has to relay. */
            note:
              "The image is attached to the next turn. If you cannot see images, say that you " +
              "cannot rather than describing the chart.",
          },
          image: {
            mediaType: img.mediaType ?? "image/png",
            dataBase64: img.dataBase64,
            width: img.width ?? 0,
            height: img.height ?? 0,
            caption: img.caption ?? "chart",
          },
        };
      },
    },

    {
      name: "get_setup_history",
      description:
        "What every setup kind on the CURRENT chart has historically been worth: " +
        "how many completed instances the archive holds, how many reached target, " +
        "and the hit rate needed just to break even at the plan's reward-to-risk. " +
        "Call this whenever you are about to describe a setup as good, strong or " +
        "high-probability — it is the only tool that can contradict the others, " +
        "and a setup with no record here is one nobody can characterise, which is " +
        "a different statement from one that fails. Replayed from the user's own " +
        "bars and IN-SAMPLE: treat it as a prior, never as a forecast.",
      parameters: noArgs,
      run: () => {
        const h = t.setupHistory();
        if (!h.ok) return { ok: false, error: h.reason ?? "No replay available for this chart yet." };
        const measured = (h.kinds ?? []).filter((k) => k.enoughToCharacterise).length;
        return {
          ok: true,
          summary: `${h.symbol} ${h.timeframe} · ${h.bars?.toLocaleString()} bars · ${measured} of ${(h.kinds ?? []).length} kinds characterisable`,
          data: h,
        };
      },
    },

    {
      name: "get_knowledge",
      description:
        "What the terminal has ACCUMULATED about a setup, sliced by the condition it " +
        "happened in — regime (trending/chopping/violent), session, hour of day and " +
        "weekday. Different from get_setup_history, which replays only the chart on " +
        "screen and forgets it: this reads the knowledge base the user has harvested " +
        "from history, so it can answer 'and how has this gone in a chopping market " +
        "here' from thousands of bars replayed earlier. Every slice carries its trial " +
        "count, a Wilson lower bound, whether it clears the sample floor (`usable`) and " +
        "whether the study behind it has gone stale. NEVER quote a rate from a slice " +
        "with usable=false — say it has not been measured enough and give the count. " +
        "Returns ok=false with a reason when nothing has been harvested for this setup, " +
        "which means 'not measured', NOT 'does not work'. Defaults to the chart on " +
        "screen and the setup the card chose.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Defaults to the chart on screen." },
          timeframe: { type: "string", description: "Defaults to the chart on screen." },
          kind: {
            type: "string",
            description: "Detection kind, e.g. 'choch'. Defaults to the setup the card chose.",
          },
          direction: { type: "string", enum: ["long", "short"], description: "Defaults to the chosen setup's." },
        },
      },
      run: (args) => {
        const k = t.knowledge({
          symbol: typeof args["symbol"] === "string" ? args["symbol"] : undefined,
          timeframe: typeof args["timeframe"] === "string" ? args["timeframe"] : undefined,
          kind: typeof args["kind"] === "string" ? args["kind"] : undefined,
          direction: typeof args["direction"] === "string" ? args["direction"] : undefined,
        });
        if (!k.ok) return { ok: false, error: k.reason };
        const usable = k.slices.filter((s) => s.usable).length;
        return {
          ok: true,
          summary: `${k.symbol} ${k.timeframe} ${k.kind} ${k.direction} · ${usable} of ${k.slices.length} slices measurable · ${k.standing}`,
          data: k,
        };
      },
    },

    {
      name: "get_conditional_edge",
      description:
        "The same replayed trials as get_setup_history, but sliced by the " +
        "conditions each one happened under: session, weekday, volatility " +
        "regime and direction, NET of spread and slippage. Call it when you are " +
        "tempted to say a setup works better at some time or in some condition. " +
        "Its usual answer is that nothing survives: it examines twenty-odd cells " +
        "and corrects the significance threshold for having examined them, so a " +
        "cell that looks like an edge on a naive reading is reported as what you " +
        "would expect to see with nothing there. Quote its verdict verbatim and " +
        "do NOT go looking for a better-looking cell inside the returned table — " +
        "that is the exact mistake the correction exists to stop.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Restrict to one detection kind, e.g. 'spring'. Omit for every kind at once.",
          },
        },
      },
      run: async (args) => {
        const kind = typeof args?.["kind"] === "string" ? (args["kind"] as string) : undefined;
        const r = await t.conditionalEdge(kind);
        if (!r.ok) return { ok: false, error: r.reason ?? "No conditional table available." };
        return {
          ok: true,
          summary: r.text ?? `${r.trials ?? 0} trials over ${r.days ?? 0} days`,
          data: r.data ?? r,
        };
      },
    },

    {
      name: "get_track_record",
      description:
        "The terminal's OWN record: claims it made before the outcome was known, " +
        "and how they resolved. Out of sample, unlike get_setup_history. Includes " +
        "both the trades it cleared and the ones its gates refused, which is the " +
        "only way to answer whether the gates help or merely say no a lot. " +
        "Reports 'no record yet' rather than inventing a prior — say so plainly " +
        "when it does; a thin record is a fact about the terminal, not a gap to " +
        "fill with a guess.",
      parameters: noArgs,
      run: () => {
        const r = t.trackRecord();
        if (!r.ok) return { ok: false, error: r.reason ?? "No claims recorded yet." };
        return {
          ok: true,
          summary: `${r.resolved ?? 0} resolved of ${r.claims ?? 0} claims`,
          data: r,
        };
      },
    },

    {
      name: "get_journal_record",
      description:
        "The user's own trading journal: real trades they entered by hand, with " +
        "hit rate and expectancy per setup kind. This is the user's history, not " +
        "the terminal's — treat it as the most authoritative record available and " +
        "never contradict it with a backtest. Empty for a new book, and an empty " +
        "book means say so.",
      parameters: noArgs,
      run: () => {
        const j = t.journalRecord();
        if (!j.ok) return { ok: false, error: j.reason ?? "The journal is empty." };
        return { ok: true, summary: `${j.closed ?? 0} closed of ${j.trades ?? 0} trades`, data: j };
      },
    },

    {
      name: "get_decision",
      description:
        "The terminal's assembled read: every source in one shape, with what " +
        "each contributes and what did not answer. Prefer this over calling the " +
        "individual tools when the user asks a broad question — it is the same " +
        "data, already combined, and it carries the COVERAGE figure. Rules you " +
        "must follow: lead with coverage, not with the direction. A bias on 30% " +
        "coverage is unsupported, not weak, and reporting it as a weak signal " +
        "is the single most misleading thing you could do with this tool. Relay " +
        "the limits verbatim.",
      parameters: noArgs,
      run: () => {
        const d = t.decision();
        return {
          ok: true,
          summary: d.headline,
          data: d,
        };
      },
    },

    {
      name: "get_leading_read",
      description:
        "The leading-indicator read for the instrument on screen, kept on THREE " +
        "SEPARATE AXES that you must not merge. `timing` (0-1) is how close a " +
        "range expansion looks and says NOTHING about direction — never report " +
        "a squeeze as bullish or bearish, because compression carries no " +
        "direction and claiming otherwise is the single most common lie told " +
        "about this indicator. `direction` (-1..+1, or null) comes only from " +
        "positioning and participation; null means nothing spoke, which is not " +
        "the same as neutral. `conviction` (0-1) scales the others and has no " +
        "sign of its own. Each component carries a `limit` — quote it whenever " +
        "you quote the component. Coverage below 1 means some inputs had NO " +
        "data, not that they were neutral.",
      parameters: noArgs,
      run: () => {
        const l = t.leading();
        if (!l.ok) return { ok: false, summary: l.reason ?? "No leading read for this instrument." };
        return { ok: true, summary: l.headline, data: l };
      },
    },

    {
      name: "get_portfolio_risk",
      description:
        "Risk across the whole open book, measured from bars stored locally — " +
        "value at risk and expected shortfall, which position carries the loss " +
        "on the worst days, exposure to the benchmark with the R-squared beside " +
        "each beta, and historical stress scenarios. Rules you must follow: if " +
        "`blocked` is set, report that sentence and stop — do not estimate. If " +
        "`missing` is non-empty those symbols were EXCLUDED and the book is " +
        "riskier than the figures show; say so. Never quote a beta without its " +
        "R-squared. `effectiveBets` is out of `measuredLegs`, not out of the " +
        "position count. Every stress figure is optimistic because betas taken " +
        "in calm markets understate crashes. This tool reports; it cannot " +
        "change a position or place an order.",
      parameters: noArgs,
      run: async () => {
        const r = await t.portfolioRisk();
        if (!r.ok) return { ok: false, summary: r.blocked ?? "The book could not be analysed." };
        const tail = r.tails[0];
        return {
          ok: true,
          summary:
            `${r.measuredLegs} measured leg(s) behaving like ${r.effectiveBets.toFixed(1)} independent bets` +
            (tail ? ` · 95% one-bar VaR ${tail.var.toFixed(0)}, shortfall ${tail.cvar.toFixed(0)}` : "") +
            (r.missing.length > 0 ? ` · ${r.missing.join(", ")} EXCLUDED for having no stored bars` : ""),
          data: r,
        };
      },
    },

    {
      name: "get_risk_state",
      description:
        "The user's own risk configuration and current book: account equity, " +
        "their default risk per trade, open position count, current portfolio " +
        "heat, realised P&L today, their configured guardrails, and any " +
        "positions carrying no stop. These are numbers the USER entered — you " +
        "must never suggest changing them, and you must never invent them.",
      parameters: noArgs,
      run: () => {
        const r = t.riskState();
        return {
          ok: true,
          summary: `equity ${r.equity.toLocaleString()} · heat ${
            r.heatPct === null ? "not measurable (equity unset)" : `${r.heatPct.toFixed(2)}%`
          } · ${r.openPositions} open`,
          data: r,
        };
      },
    },

    {
      name: "size_position",
      description:
        "Compute the position size implied by an entry, a stop and a risk " +
        "percentage. This is ARITHMETIC, not a recommendation. Rules you must " +
        "follow: omit risk_pct unless the user stated a number in this " +
        "conversation — the default comes from their settings and choosing one " +
        "for them would be advice. Report the returned risk_pct, which is the " +
        "post-rounding truth, not requested_risk_pct. Relay every warning and " +
        "assumption verbatim; they are the part that matters.",
      parameters: {
        type: "object",
        properties: {
          entry: { type: "number", description: "Entry price." },
          stop: { type: "number", description: "Stop price. Below entry is long, above is short." },
          risk_pct: {
            type: "number",
            description: "Percent of equity to risk. OMIT unless the user stated it.",
          },
        },
        required: ["entry", "stop"],
      },
      run: (args) => {
        const entry = Number(args["entry"]);
        const stop = Number(args["stop"]);
        const riskPct = typeof args["risk_pct"] === "number" ? args["risk_pct"] : undefined;
        const out = t.sizePosition({
          entry,
          stop,
          ...(riskPct !== undefined ? { riskPct } : {}),
        });
        if (!out.ok) return { ok: false, error: out.reason ?? "The size could not be computed." };
        return {
          ok: true,
          summary: `${out.qty} @ ${entry} · risking ${out.riskAmount.toFixed(2)} (${out.riskPct.toFixed(3)}%)`,
          data: out,
        };
      },
    },

    {
      name: "stop_from_atr",
      description:
        "Where a stop sits at N times the measured ATR from a price. This is " +
        "volatility arithmetic and it says so: it does not know what level the " +
        "stop is meant to sit behind, and you must not present it as a chosen " +
        "stop placement.",
      parameters: {
        type: "object",
        properties: {
          entry: { type: "number" },
          multiple: { type: "number", description: "ATR multiple, e.g. 1.5." },
          direction: { type: "string", description: "long or short." },
        },
        required: ["entry", "multiple", "direction"],
      },
      run: (args) => {
        const direction = args["direction"] === "short" ? "short" : "long";
        const out = t.atrStop({
          entry: Number(args["entry"]),
          multiple: Number(args["multiple"]),
          direction,
        });
        if (!out.ok) return { ok: false, error: out.reason ?? "Could not compute an ATR stop." };
        return { ok: true, summary: `stop ${out.stop.toPrecision(8)} (${out.distancePct.toFixed(2)}%)`, data: out };
      },
    },

    {
      name: "reward_to_risk",
      description:
        "Reward-to-risk for an entry, stop and target, WITH the win rate at " +
        "which that ratio breaks even before costs. Always report the " +
        "break-even win rate alongside the ratio: 3:1 is not a good trade, it " +
        "is a trade that needs 25% to break even.",
      parameters: {
        type: "object",
        properties: { entry: { type: "number" }, stop: { type: "number" }, target: { type: "number" } },
        required: ["entry", "stop", "target"],
      },
      run: (args) => {
        const out = t.rewardToRisk({
          entry: Number(args["entry"]),
          stop: Number(args["stop"]),
          target: Number(args["target"]),
        });
        if (!out.ok) return { ok: false, error: out.reason ?? "Could not compute reward to risk." };
        return {
          ok: true,
          summary: `${out.r.toFixed(2)}R · breaks even at ${out.breakEvenWinRate.toFixed(1)}%`,
          data: out,
        };
      },
    },

    {
      name: "run_backtest",
      description:
        "Run a walk-forward study of a strategy family over the loaded series, " +
        "with out-of-sample folds and a probability-of-backtest-overfitting " +
        "score. Families: ema, rsi, confluence. Takes SECONDS — only call it " +
        "when the user asked about strategy performance. Report the standing " +
        "and the PBO, never the return alone: a high PBO means the result is " +
        "selection noise and the return is meaningless.",
      parameters: {
        type: "object",
        properties: { family: { type: "string", description: "ema, rsi or confluence." } },
        required: ["family"],
      },
      run: async (args) => {
        const family = str(args, "family") ?? "ema";
        const out = await t.runBacktest(family);
        if (!out.ok) return { ok: false, error: out.error ?? "The study could not run." };
        return {
          ok: true,
          summary: `${out.family}: ${out.standing} · PBO ${((out.pbo ?? 0) * 100).toFixed(0)}%`,
          data: out,
        };
      },
    },

    {
      name: "scan_market",
      description:
        "Rank the live venue universe by the confluence engine and return the " +
        "top rows with each one's stated reason. Expensive: it fetches candles " +
        "per symbol and spends the venue request budget, so only call it when " +
        "the user asked what is moving or what to look at.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "Rows to return. Default 10." } },
      },
      run: async (args) => {
        const limit = typeof args["limit"] === "number" ? Math.max(1, Math.min(25, Math.floor(args["limit"]))) : 10;
        const out = await t.scanMarket(limit);
        if (!out.ok) return { ok: false, error: out.error ?? "The scan could not run." };
        return { ok: true, summary: `${out.rows?.length ?? 0} ranked`, data: out };
      },
    },

    {
      name: "get_fundamentals",
      description:
        "Reported fundamentals for the instrument on screen: market cap and " +
        "rank, fully-diluted valuation, circulating and maximum supply, float, " +
        "24h turnover, and distance from the all-time high. Rules: this is an " +
        "AGGREGATOR's data and CIRCULATING SUPPLY IS SELF-REPORTED BY THE " +
        "PROJECT — float and dilution are computed from it and inherit that " +
        "uncertainty, so say where the numbers came from. It covers crypto " +
        "only; for metals, FX or equities it returns an error and you must say " +
        "there is no fundamental data rather than reasoning without it.",
      parameters: noArgs,
      run: () => {
        const f = t.fundamentals();
        if (!f.ok) return { ok: false, error: f.reason ?? "No fundamental data for this instrument." };
        return {
          ok: true,
          summary: `${f.name} · #${f.rank} · ${num((f.marketCap ?? 0) / 1e9, 1)}B cap`,
          data: f,
        };
      },
    },

    {
      name: "get_setup",
      description:
        "The Setup card's verdict for the chart on screen — the terminal's own answer to " +
        "'is there a trade here, and may I take it'. `call` is one of: go (the plan is live " +
        "under the operator's own rules), armed (the plan is valid and price has not reached " +
        "`watch_level` yet), conflict (gates pass but the macro lane disagrees — a reason to " +
        "size down, not a refusal), stand-down (a gate blocks; each `blocking[].clears` says " +
        "what would clear it), unknown (a gate could not be checked, which is not a pass), " +
        "no-setup (the engine found nothing to trade; `waiting_for` says what to watch). " +
        "`plan` holds the entry zone, stop, targets and reward-to-risk, and is null whenever a " +
        "gate blocks — never reconstruct a withheld plan. Ground every 'what should I do' " +
        "answer in this call.",
      parameters: noArgs,
      run: () => {
        const s = t.setup();
        if (!s.ok) return { ok: false, error: s.reason };
        return {
          ok: true,
          summary: `${s.symbol} ${s.timeframe} · ${s.call} · ${s.gates_passed}/${s.gates_total} gates`,
          data: s,
        };
      },
    },

    {
      name: "get_outlook",
      description:
        "The simulated range of price over the next bars and, for a plan, the share of " +
        "simulated paths that reach target 1 before the stop. Modelled, not measured: " +
        "filtered historical simulation from this instrument's own past moves at today's " +
        "volatility (2000 seeded paths). Returns the cone (p5/p25/p50/p75/p95 as prices and as " +
        "% from the last close) at several horizons, `p_up_base_rate` — a base rate, never a " +
        "direction — the plan's odds beside the break-even rate its R needs, every " +
        "assumption, and `calibration`: how often the 90% band actually held out of sample " +
        "(measured). Quote odds as 'x% of simulated paths', never as what will happen. With no " +
        "arguments it uses the Setup card's plan; pass direction, entry, stop and target1 " +
        "(target2 optional) to test the operator's own idea. Refuses under 300 bars.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["long", "short"], description: "Plan direction." },
          entry: { type: "number", description: "Entry price." },
          stop: { type: "number", description: "Stop price." },
          target1: { type: "number", description: "First target price." },
          target2: { type: "number", description: "Optional second target price." },
        },
      },
      run: async (args) => {
        const given = ["direction", "entry", "stop", "target1"].filter((k) => args[k] !== undefined);
        let plan: OutlookPlanInput | null = null;
        if (given.length > 0) {
          const dir = args["direction"];
          const nums = ["entry", "stop", "target1"].map((k) => args[k]);
          if (given.length < 4 || (dir !== "long" && dir !== "short") || !nums.every((v) => typeof v === "number")) {
            return {
              ok: false,
              error:
                "To test your own plan pass all of direction ('long' or 'short'), entry, stop and target1 as numbers — or pass nothing to use the Setup card's plan.",
            };
          }
          const t2 = args["target2"];
          plan = {
            source: "supplied by the caller",
            direction: dir,
            entry: args["entry"] as number,
            stop: args["stop"] as number,
            target1: args["target1"] as number,
            ...(typeof t2 === "number" ? { target2: t2 } : {}),
          };
        }
        const o = await t.outlook(plan);
        if (!o.ok) return { ok: false, error: o.refused };
        const last = o.cone[o.cone.length - 1];
        const odds = o.odds;
        const oddsBit =
          odds && typeof odds["target1_first"] === "number"
            ? ` · T1 first ${num((odds["target1_first"] as number) * 100, 0)}% vs ${num((odds["break_even_rate"] as number) * 100, 0)}% break-even`
            : "";
        return {
          ok: true,
          summary: last
            ? `${last.bars_ahead} bars: 90% of paths ${signed(last.p5_pct)}% to ${signed(last.p95_pct)}%${oddsBit}`
            : "outlook",
          data: o,
        };
      },
    },

    {
      name: "find_opportunities",
      description:
        "Rank tradeable setups across the venue universe with the Opportunities desk's own " +
        "pipeline — the Setup card's detectors, setup engine, plan builder and history " +
        "replay, run per symbol on the chart's timeframe. Scans the top `universe` USDT pairs " +
        "by 24h volume (default 30, max 50) and returns the best `limit` rows (default 10, max " +
        "25) with entry zone, stop, targets, R, bars since the pattern confirmed, the replayed " +
        "record and its edge over break-even. Failed symbols are listed by name. Expensive: one " +
        "history request per symbol. These plans have NOT been through the operator's gates — " +
        "say so, and send them to the chart before anything else.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Rows to return. Default 10, max 25." },
          universe: { type: "integer", description: "Symbols to scan, by volume. Default 30, max 50." },
        },
      },
      run: async (args) => {
        const pick = (k: string, d: number, max: number): number =>
          typeof args[k] === "number" ? Math.max(1, Math.min(max, Math.floor(args[k] as number))) : d;
        const out = await t.findOpportunities({ limit: pick("limit", 10, 25), universe: pick("universe", 30, 50) });
        if (!out.ok) return { ok: false, error: out.error };
        return {
          ok: true,
          summary:
            `${out.with_setup} with a setup of ${out.scanned} scanned` +
            (out.failed.length > 0 ? ` · ${out.failed.length} failed` : ""),
          data: out,
        };
      },
    },

    {
      name: "test_strategy",
      description:
        "Backtest a rule set in the terminal's own rule language on the current chart's " +
        "history, then put it through the out-of-sample gate. Returns the rules as the " +
        "terminal renders them, in-sample metrics (win rate, profit factor, expectancy in R, " +
        "max drawdown, Sharpe, Sortino, CAGR, Calmar), a 5-fold walk-forward with pooled " +
        "out-of-sample metrics and retention, the promotion gate's checks, Monte Carlo " +
        "drawdown percentiles and ruin probability, a random-entry p-value, and MAE/MFE. Costs " +
        "are on. If the input is invalid it returns every problem verbatim — fix them and call " +
        "again. A rule set that fails the gate is reported as failing; the PBO check cannot run " +
        "on one rule set, so the gate never promotes a single rule on its own.\n" +
        "Each condition is [column, operator, value], ANDed within a list. Columns: " +
        `${RULE_COLUMN_IDS.join(", ")}. ` +
        "Structural columns (bos, choch, sweep, expansion) are +1/-1 on the bar the event " +
        "completed and 0 otherwise; infvg/inob are +1/-1 while inside; squeeze and inrange are 1/0. " +
        "Operators: >, <, >=, <=, crossabove, crossbelow.\n" +
        'Example 1: {"name":"Pullback in trend","long":[["ema50",">","ema200"],["rsi","crossabove","40"]],' +
        '"short":[["ema50","<","ema200"],["rsi","crossbelow","60"]],"stop":{"type":"atr","mult":2},' +
        '"target":{"type":"rr","value":2}}\n' +
        'Example 2: {"name":"Sweep reclaim","long":[["sweep",">","0"],["close",">","ema20"]],' +
        '"exitLong":[["close","<","ema20"]],"stop":{"type":"pct","value":1.5},"target":{"type":"none"}}',
      parameters: ruleSpecSchema(),
      run: async (args) => {
        const parsed = parseRuleSpec(args);
        if (!parsed.ok) {
          return {
            ok: false,
            error:
              "The rule set is not valid: " +
              parsed.problems.map((p) => `${p.where}: ${p.message}`).join(" | "),
            data: { problems: parsed.problems },
          };
        }
        const out = await t.testStrategy(parsed.spec);
        if (!out.ok) return { ok: false, error: out.refused, data: { rules: out.rules } };
        const oos = out.walk_forward.out_of_sample;
        return {
          ok: true,
          summary:
            `${out.gate.promoted ? "PROMOTED" : "not promoted"} · OOS ${String(oos["trades"])} trades, ` +
            `${String(oos["expectancy_r"])}R · in-sample ${String(out.in_sample.metrics["trades"])} trades`,
          data: out,
        };
      },
    },

    {
      name: "list_drawings",
      description: "The drawings currently on this chart, with their prices.",
      parameters: noArgs,
      run: () => {
        const list = t.drawings();
        return { ok: true, summary: `${list.length} drawing${list.length === 1 ? "" : "s"}`, data: { drawings: list } };
      },
    },

    {
      name: "draw_level",
      description:
        "Draw a horizontal line at a price on the user's chart. Use it to mark " +
        "a level you have already established from a tool result — never a " +
        "price you produced yourself. The user can move or delete it like any " +
        "drawing they made.",
      parameters: {
        type: "object",
        properties: {
          price: { type: "number" },
          label: { type: "string", description: "Short caption, e.g. 'prior day high'." },
        },
        required: ["price"],
      },
      mutates: true,
      run: (args) => {
        const price = Number(args["price"]);
        const label = str(args, "label");
        const out = t.drawLevel({ price, ...(label ? { label } : {}) });
        if (!out.ok) return { ok: false, error: out.reason ?? "Could not draw that level." };
        return { ok: true, summary: `drew a level at ${price}`, data: out };
      },
    },

    {
      name: "promote_detection",
      description:
        "Turn a structure the detectors found into an editable drawing the user " +
        "owns. Pass the label exactly as list_structures reported it. This is " +
        "how a detected trendline or level becomes something the user can drag, " +
        "rather than an overlay that vanishes on the next recompute.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "The structure's label from list_structures." } },
        required: ["label"],
      },
      mutates: true,
      run: (args) => {
        const label = str(args, "label");
        if (!label) return { ok: false, error: "No structure label given." };
        const out = t.promoteDetection({ label });
        if (!out.ok) return { ok: false, error: out.reason ?? "No structure matched that label." };
        return { ok: true, summary: out.drew ?? "drawn", data: out };
      },
    },

    {
      name: "set_timeframe",
      description:
        "Change the timeframe on the user's chart. Only the timeframes the " +
        "terminal offers are valid; if you pass one it does not have, the error " +
        "names the whole set so you can pick again. As with set_symbol, the new " +
        "data is not available to you in this same turn.",
      parameters: {
        type: "object",
        properties: { timeframe: { type: "string", description: "One of the offered timeframes." } },
        required: ["timeframe"],
      },
      mutates: true,
      run: (args) => {
        const tf = str(args, "timeframe");
        if (!tf) return { ok: false, error: "No timeframe given." };
        const offered = t.timeframes();
        if (!offered.includes(tf)) {
          /* Naming the valid set lets the model correct itself in one turn
             instead of guessing again. */
          return { ok: false, error: `"${tf}" is not offered. Available: ${offered.join(", ")}.` };
        }
        t.setTimeframe(tf);
        return { ok: true, summary: `chart → ${tf}`, data: { timeframe: tf } };
      },
    },
  ];
}

/**
 * Execute one call, converting any throw into a reportable result.
 *
 * A tool that throws must not end the conversation: the model is perfectly
 * capable of reading "that failed because X" and trying something else, and a
 * loop that dies on the first failure is one bad network moment from useless.
 */
export async function runTool(tools: readonly ToolDef[], call: ToolCall): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return {
      ok: false,
      error: `No tool named "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}.`,
    };
  }
  if (call.inputError !== undefined) {
    return { ok: false, error: `The input for ${call.name} could not be read (${call.inputError}). Nothing was run; send the call again with valid JSON.` };
  }
  try {
    return await tool.run(call.args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
