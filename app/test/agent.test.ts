import { describe, it, expect, vi } from "vitest";
import { createToolset, runTool, type TerminalAccess, type ToolDef } from "../src/agent/tools";
import { createAgentSession } from "../src/agent/session";
import { offlineProvider, SYSTEM_PROMPT, type Provider, type ProviderReply } from "../src/agent/provider";

/** A terminal whose every reading is a known constant. */
function fakeTerminal(over: Partial<TerminalAccess> = {}): TerminalAccess {
  let symbol = "BTCUSDT";
  let timeframe = "1h";
  const bars = Array.from({ length: 100 }, (_, i) => ({
    t: 1_700_000_000_000 + i * 3_600_000,
    o: 100 + i,
    h: 105 + i,
    l: 95 + i,
    c: 102 + i,
    v: 10,
  }));
  return {
    symbol: () => symbol,
    timeframe: () => timeframe,
    bars: () => bars,
    feed: () => ({ quality: "live", note: "streaming", source: "binance", ageMs: 1200 }),
    indicators: () => ({ rsi: 71.2, atr: 3.4, atrPct: 1.7, ema20: 195, ema50: 180, ema200: 150 }),
    detections: () => [
      { kind: "bos", label: "Break of structure ↑", confidence: 0.72, reason: "close above prior high", at: 1_700_100_000_000 },
    ],
    alerts: () => [],
    higher: () => [],
    regime: () => Promise.resolve({ ok: true, state: "TREND-UP", confidence: 0.64, note: "3-state GMM" }),
    forecast: () =>
      Promise.resolve({ ok: true, pUp: 0.58, accuracy: 0.51, brier: 0.26, usable: false, standing: "inside the noise." }),
    calendar: () => Promise.resolve([]),
    storage: () => Promise.resolve({ series: 5, bars: 9204, bytes: 441_000, note: "1d kept forever" }),
    setSymbol: (s) => { symbol = s; },
    setTimeframe: (tf) => { timeframe = tf; },
    timeframes: () => ["1m", "5m", "15m", "1h", "4h", "1d"],

    riskState: () => ({
      equity: 10_000,
      defaultRiskPct: 1,
      openPositions: 1,
      heatPct: 2,
      realisedToday: -50,
      guards: { dailyLossPct: 3, maxHeatPct: 6, maxPositions: 5 },
      unprotected: [],
    }),
    sizePosition: (a) => ({
      ok: true,
      qty: 20,
      notional: 2000,
      riskAmount: 100,
      riskPct: 1,
      requestedRiskPct: a.riskPct ?? 1,
      stopDistancePct: 5,
      direction: a.stop < a.entry ? "long" : "short",
      warnings: [],
      assumptions: ["costs excluded"],
    }),
    atrStop: (a) => ({
      ok: true,
      stop: a.direction === "long" ? a.entry - 3.4 * a.multiple : a.entry + 3.4 * a.multiple,
      distancePct: 1.7 * a.multiple,
      note: "volatility arithmetic",
    }),
    rewardToRisk: () => ({ ok: true, r: 2, breakEvenWinRate: 33.33 }),
    runBacktest: (family) =>
      Promise.resolve({ ok: true, family, standing: "no-edge", verdict: "no edge", why: "noise", trades: 41, pbo: 0.89, warnings: [] }),
    scanMarket: (limit) =>
      Promise.resolve({
        ok: true,
        rows: Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
          symbol: `SYM${i}`, changePct: 1, bias: "long", score: 50, why: "because",
        })),
      }),
    decision: () => ({
      headline: "LONG at 40% confidence — 80% of the directional weight agrees, on 50% coverage.",
      bias: "long",
      score: 0.6,
      agreement: 0.8,
      coverage: 0.5,
      confidence: 0.4,
      limits: ["5 sources had nothing to say here."],
      wouldChange: ["Market structure: a confirmed break the other way"],
      evidence: [{ label: "Market structure", lean: 0.8, weight: 1, reason: "break of structure", source: "1h detectors", state: "fresh" }],
      missing: [{ label: "Regime model", state: "failed", reason: "service not running" }],
    }),
    leading: () => ({
      ok: true,
      timing: 0.7,
      direction: -0.4,
      conviction: 0.3,
      coverage: 0.75,
      headline: "A range expansion looks close, and what is committed leans down (-0.40).",
      components: [
        {
          label: "Volatility compression",
          family: "coiled",
          speaks: "when",
          value: 0.7,
          reason: "Bandwidth is in the tightest 8% of the last 120 bars.",
          limit: "A squeeze says a move is coming, never which way.",
        },
      ],
    }),
    portfolioRisk: async () => ({
      ok: true,
      blocked: null,
      sample: 400,
      gross: 50_000,
      net: 30_000,
      measuredLegs: 2,
      effectiveBets: 1.4,
      missing: ["ZZZ"],
      tails: [{ level: 0.95, var: 900, cvar: 1400, worst: 3200 }],
      contributions: [{ symbol: "BTCUSDT", cvarShare: 1200, fraction: 0.86 }],
      betas: [{ symbol: "ETHUSDT", beta: 1.2, r2: 0.7, caveat: null }],
      stress: [{ label: "COVID liquidation", factorMove: -0.5, pnl: -18_000, pctOfEquity: -18, unreliable: [] }],
      warnings: ["ZZZ has no stored bars."],
    }),
    drawings: () => [],
    drawLevel: () => ({ ok: true, id: "d1" }),
    promoteDetection: () => ({ ok: true, id: "d2", drew: "trendline" }),
    /* The record accessors default to EMPTY, not to a plausible history. A
       fake that answers "62% over 40 trades" would let a tool that silently
       fabricated its payload pass every test in this file. */
    chartImage: () => ({ ok: false, reason: "The chart has not painted yet." }),
    setupHistory: () => ({ ok: false, reason: "No replay has been run for the chart on screen yet." }),
    trackRecord: () => ({ ok: false, reason: "The terminal has not recorded any claims yet." }),
    conditionalEdge: async () => ({ ok: false, reason: "No conditional table yet." }),
    journalRecord: () => ({ ok: false, reason: "The journal has no trades in it." }),
    /* The expert's reads default to REFUSALS for the same reason. */
    setup: () => ({ ok: false, reason: "The Setup card has no read yet." }),
    /* A REFUSAL by default, like its neighbours. An empty knowledge base is
       the state every install starts in, and "nothing has been harvested" is
       an answer rather than a failure. */
    knowledge: () => ({
      ok: false as const,
      reason: "Nothing has been harvested for choch long on BTCUSDT 1h.",
    }),
    outlook: async () => ({ ok: false, refused: "40 bars loaded — a 24-bar outlook needs at least 300." }),
    findOpportunities: async () => ({ ok: false, error: "The venue universe could not be loaded." }),
    testStrategy: async () => ({ ok: false, refused: "No history in this fake.", rules: {} }),

    ...over,
  };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "x", name, args });

describe("toolset", () => {
  /**
   * THE SAFETY TEST. An exact allowlist, not a keyword filter.
   *
   * A regex over names was the first version of this and it was the wrong
   * shape twice over: it rejected `size_position` (a calculator) for containing
   * "position", while a tool called `submit_fill` would have sailed through.
   * Pinning the whole set means any new capability has to be added HERE, in a
   * test called "the agent can reach exactly these", where a reviewer sees it.
   */
  it("exposes exactly the known toolset and nothing else", () => {
    const names = createToolset(fakeTerminal()).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "draw_level",
        "get_alerts",
        "get_calendar",
        "get_conditional_edge",
        "get_context",
        "get_decision",
        "get_forecast",
        "get_fundamentals",
        "get_higher_timeframes",
        "get_indicators",
        "get_journal_record",
        "get_leading_read",
        "get_portfolio_risk",
        "get_price_summary",
        "get_regime",
        "get_risk_state",
        "get_setup_history",
        "get_storage",
        "get_track_record",
        "list_drawings",
        "list_structures",
        "promote_detection",
        "reward_to_risk",
        "run_backtest",
        "scan_market",
        "see_chart",
        "set_symbol",
        "set_timeframe",
        "size_position",
        "stop_from_atr",
        /* v55: the expert's reads. Each is a read or an offline computation —
           none can reach a venue's order endpoint. */
        "get_setup",
        "get_outlook",
        "find_opportunities",
        "test_strategy",
        /* v55.2: the accumulated knowledge base. A READ of what past harvests
           measured — it reaches no venue, spends nothing, and changes nothing
           on screen. */
        "get_knowledge",
      ].sort(),
    );
  });

  /**
   * The record tools.
   *
   * These are the only tools whose answer can contradict the rest of the
   * toolset, so what matters about them is that an EMPTY record surfaces as a
   * refusal the model has to relay, never as an absent field it can talk past.
   * A tool returning `{ok: true, trades: 0}` invites "no losing trades on
   * record"; a tool returning `{ok: false, error: "the journal is empty"}`
   * does not.
   */
  describe("the record tools", () => {
    it("refuse rather than reporting an empty history as a result", async () => {
      const tools = createToolset(fakeTerminal());
      for (const name of ["get_setup_history", "get_track_record", "get_journal_record"]) {
        const tool = tools.find((x) => x.name === name);
        expect(tool, name).toBeDefined();
        const r = await (tool as NonNullable<typeof tool>).run({});
        expect(r.ok, name).toBe(false);
        expect(r.error, name).toBeTruthy();
      }
    });

    it("carries the in-sample caveat in the payload, not the prompt", async () => {
      /* A caveat the model has to remember is a caveat it drops on turn nine. */
      const term = fakeTerminal({
        setupHistory: () => ({
          ok: true,
          symbol: "BTCUSDT",
          timeframe: "1h",
          bars: 6000,
          rMultiple: 2,
          breakEvenHitRate: 1 / 3,
          chosen: { kind: "choch", direction: "long" },
          kinds: [
            {
              kind: "choch",
              direction: "long",
              instances: 87,
              wins: 41,
              hitRate: 0.47,
              hitRateLowerBound: 0.37,
              expectancyR: 0.02,
              medianBars: 6,
              enoughToCharacterise: true,
              note: "41 of 87 reached target",
            },
          ],
          disagreement: "",
          caveat: "In-sample: a prior, not a forecast.",
        }),
      });
      const tool = createToolset(term).find((x) => x.name === "get_setup_history");
      const r = await (tool as NonNullable<typeof tool>).run({});
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toMatch(/in-sample/i);
    });

    it("reports the break-even rate alongside the hit rate", async () => {
      /* 47% is a losing setup at 2R and a winning one at 1R. A payload with a
         hit rate and no break-even lets the model supply the missing half, and
         the one it supplies is 50%. */
      const term = fakeTerminal({
        setupHistory: () => ({
          ok: true,
          symbol: "BTCUSDT",
          timeframe: "1h",
          bars: 6000,
          rMultiple: 2,
          breakEvenHitRate: 1 / 3,
          chosen: null,
          kinds: [],
          disagreement: "",
          caveat: "In-sample.",
        }),
      });
      const tool = createToolset(term).find((x) => x.name === "get_setup_history");
      const r = (await (tool as NonNullable<typeof tool>).run({})) as { data: { breakEvenHitRate: number } };
      expect(r.data.breakEvenHitRate).toBeCloseTo(1 / 3, 6);
    });
  });

  // The capability that must never exist, named by the verbs that would do it.
  it("exposes no tool whose name suggests execution or custody", () => {
    const names = createToolset(fakeTerminal()).map((t) => t.name).join(" ");
    expect(names).not.toMatch(
      /place|submit|execute|cancel|close_position|withdraw|transfer|deposit|wallet|api_?key|credential|secret/i,
    );
  });

  // Mutating means "changes what the user sees". Nothing that moves money can
  // be on this list, because nothing that moves money exists.
  it("marks only navigation and drawing as mutating", () => {
    const mutating = createToolset(fakeTerminal()).filter((t) => t.mutates).map((t) => t.name);
    expect(mutating.sort()).toEqual(["draw_level", "promote_detection", "set_symbol", "set_timeframe"]);
  });

  // Choosing a risk percentage for someone IS advice. The default must come
  // from the user's own settings.
  it("tells the model not to choose a risk percentage", () => {
    const tool = createToolset(fakeTerminal()).find((t) => t.name === "size_position");
    expect(tool?.description).toMatch(/OMIT unless the user stated it|never suggest|not a recommendation/i);
    expect(tool?.parameters.required).not.toContain("risk_pct");
  });

  /**
   * The two tools added in v46 are READS. This asserts the property that
   * mattered when they were added: neither one can change anything, and
   * neither appears on the mutating list above.
   */
  it("keeps the v46 analytics tools read-only", () => {
    const tools = createToolset(fakeTerminal());
    for (const name of ["get_leading_read", "get_portfolio_risk"]) {
      expect(tools.find((t) => t.name === name)?.mutates).toBeFalsy();
    }
  });

  it("gives every tool a description and an object schema", () => {
    for (const t of createToolset(fakeTerminal())) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.parameters.type).toBe("object");
    }
  });

  it("get_context reports the live state including freshness", async () => {
    const tools = createToolset(fakeTerminal());
    const r = await runTool(tools, call("get_context"));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ symbol: "BTCUSDT", timeframe: "1h", freshness: "live", bars_loaded: 100 });
  });

  it("get_price_summary measures over the requested lookback", async () => {
    const tools = createToolset(fakeTerminal());
    const r = await runTool(tools, call("get_price_summary", { lookback: 10 }));
    expect(r.ok).toBe(true);
    expect((r.data as { lookback_bars: number }).lookback_bars).toBe(10);
  });

  it("clamps a lookback longer than the series instead of reading off the end", async () => {
    const tools = createToolset(fakeTerminal());
    const r = await runTool(tools, call("get_price_summary", { lookback: 100000 }));
    expect(r.ok).toBe(true);
    expect((r.data as { lookback_bars: number }).lookback_bars).toBe(99);
  });

  it("refuses a price summary when there is nothing to compare", async () => {
    const tools = createToolset(fakeTerminal({ bars: () => [] }));
    const r = await runTool(tools, call("get_price_summary"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/two bars/i);
  });

  it("reports indicators as an error when there are too few bars", async () => {
    const tools = createToolset(
      fakeTerminal({ indicators: () => ({ rsi: NaN, atr: NaN, atrPct: NaN, ema20: NaN, ema50: NaN, ema200: NaN }) }),
    );
    const r = await runTool(tools, call("get_indicators"));
    expect(r.ok).toBe(false);
  });

  it("filters structures by kind", async () => {
    const tools = createToolset(fakeTerminal());
    const hit = await runTool(tools, call("list_structures", { kind: "bos" }));
    expect((hit.data as { structures: unknown[] }).structures.length).toBe(1);
    const miss = await runTool(tools, call("list_structures", { kind: "fvg" }));
    expect((miss.data as { structures: unknown[] }).structures.length).toBe(0);
  });

  // An absence of higher-timeframe context is not a neutral reading, and the
  // tool has to say which one it is or the model will average it away.
  it("states that no higher timeframes is an absence, not neutrality", async () => {
    const tools = createToolset(fakeTerminal());
    const r = await runTool(tools, call("get_higher_timeframes"));
    expect((r.data as { enabled: boolean }).enabled).toBe(false);
    expect((r.data as { note: string }).note).toMatch(/ABSENCE/);
  });

  it("carries the forecast's usability verdict, not just its probability", async () => {
    const tools = createToolset(fakeTerminal());
    const r = await runTool(tools, call("get_forecast"));
    expect(r.data).toMatchObject({ usable_as_signal: false });
    expect(r.summary).toMatch(/NOT usable/);
  });

  it("relays a model-service outage as a tool error", async () => {
    const tools = createToolset(
      fakeTerminal({ regime: () => Promise.resolve({ ok: false, error: "service not running" }) }),
    );
    const r = await runTool(tools, call("get_regime"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("service not running");
  });

  it("set_symbol upper-cases and applies", async () => {
    const term = fakeTerminal();
    const tools = createToolset(term);
    await runTool(tools, call("set_symbol", { symbol: "ethusdt" }));
    expect(term.symbol()).toBe("ETHUSDT");
  });

  it("set_symbol rejects an empty argument", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("set_symbol", { symbol: "  " }));
    expect(r.ok).toBe(false);
  });

  // Naming the valid set lets the model correct itself in one turn.
  it("set_timeframe names the offered timeframes when it refuses", async () => {
    const term = fakeTerminal();
    const r = await runTool(createToolset(term), call("set_timeframe", { timeframe: "3h" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1m, 5m, 15m, 1h, 4h, 1d/);
    expect(term.timeframe()).toBe("1h");
  });

  it("set_timeframe applies a valid value", async () => {
    const term = fakeTerminal();
    await runTool(createToolset(term), call("set_timeframe", { timeframe: "4h" }));
    expect(term.timeframe()).toBe("4h");
  });
});

describe("the risk tools", () => {
  it("reports the user's own configuration, not a suggestion", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("get_risk_state"));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ equity: 10_000, defaultRiskPct: 1, heatPct: 2 });
  });

  it("sizes from an entry and a stop", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("size_position", { entry: 100, stop: 95 }));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ qty: 20, direction: "long" });
  });

  it("passes an explicitly stated risk percentage through", async () => {
    const r = await runTool(
      createToolset(fakeTerminal()),
      call("size_position", { entry: 100, stop: 95, risk_pct: 2 }),
    );
    expect((r.data as { requestedRiskPct: number }).requestedRiskPct).toBe(2);
  });

  it("relays a sizing refusal as a tool error", async () => {
    const term = fakeTerminal({
      sizePosition: () => ({
        ok: false,
        reason: "The stop is at the entry.",
        qty: 0, notional: 0, riskAmount: 0, riskPct: 0, requestedRiskPct: 0,
        stopDistancePct: 0, direction: "long", warnings: [], assumptions: [],
      }),
    });
    const r = await runTool(createToolset(term), call("size_position", { entry: 100, stop: 100 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stop is at the entry/i);
  });

  it("computes an ATR stop on the correct side", async () => {
    const tools = createToolset(fakeTerminal());
    const long = await runTool(tools, call("stop_from_atr", { entry: 100, multiple: 2, direction: "long" }));
    const short = await runTool(tools, call("stop_from_atr", { entry: 100, multiple: 2, direction: "short" }));
    expect((long.data as { stop: number }).stop).toBeLessThan(100);
    expect((short.data as { stop: number }).stop).toBeGreaterThan(100);
  });

  // 3:1 is not a good trade; it is a trade that needs 25% to break even.
  it("returns the break-even win rate beside the ratio", async () => {
    const r = await runTool(
      createToolset(fakeTerminal()),
      call("reward_to_risk", { entry: 100, stop: 95, target: 110 }),
    );
    expect(r.data).toMatchObject({ r: 2 });
    expect(r.summary).toMatch(/breaks even at/i);
  });
});

describe("the engine tools", () => {
  it("runs a backtest and surfaces the standing and PBO", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("run_backtest", { family: "ema" }));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no-edge/);
    expect(r.summary).toMatch(/PBO 89%/);
  });

  it("clamps the scan limit", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("scan_market", { limit: 9999 }));
    expect((r.data as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(25);
  });

  it("relays a scan failure rather than returning empty rows", async () => {
    const term = fakeTerminal({ scanMarket: () => Promise.resolve({ ok: false, error: "rate limited" }) });
    const r = await runTool(createToolset(term), call("scan_market", {}));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate limited");
  });
});

describe("the drawing tools", () => {
  it("draws a level", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("draw_level", { price: 70_000, label: "prior high" }));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/70000/);
  });

  it("promotes a detection into an editable drawing", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("promote_detection", { label: "Break of structure ↑" }));
    expect(r.ok).toBe(true);
  });

  it("refuses an empty structure label", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("promote_detection", { label: "  " }));
    expect(r.ok).toBe(false);
  });

  it("relays a failed promotion", async () => {
    const term = fakeTerminal({ promoteDetection: () => ({ ok: false, reason: "no structure matched" }) });
    const r = await runTool(createToolset(term), call("promote_detection", { label: "ghost" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no structure matched");
  });
});

describe("runTool", () => {
  it("names the available tools when asked for one that does not exist", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("place_order", { size: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No tool named "place_order"/);
    expect(r.error).toMatch(/get_context/);
  });

  // A throwing tool must not end the conversation; the model can read the
  // failure and try something else.
  it("converts a throw into a reportable result", async () => {
    const boom: ToolDef = {
      name: "boom",
      description: "x".repeat(50),
      parameters: { type: "object", properties: {} },
      run: () => { throw new Error("kaboom"); },
    };
    const r = await runTool([boom], call("boom"));
    expect(r).toEqual({ ok: false, error: "kaboom" });
  });

  it("converts a rejected promise into a reportable result", async () => {
    const boom: ToolDef = {
      name: "boom",
      description: "x".repeat(50),
      parameters: { type: "object", properties: {} },
      run: () => Promise.reject(new Error("async kaboom")),
    };
    expect((await runTool([boom], call("boom"))).error).toBe("async kaboom");
  });
});

/** A provider that plays a fixed script of replies. */
function scriptedProvider(script: ProviderReply[], over: Partial<Provider> = {}): Provider {
  let i = 0;
  return {
    id: "fake",
    label: "Fake",
    privacy: "nowhere",
    ready: () => ({ ok: true }),
    chat: () => Promise.resolve(script[i++] ?? { text: "done", toolCalls: [] }),
    ...over,
  };
}

describe("offlineProvider", () => {
  it("asks for context first, always", async () => {
    const p = offlineProvider();
    const reply = await p.chat([{ role: "user", content: "hello" }], [], undefined);
    expect(reply.toolCalls[0]?.name).toBe("get_context");
  });

  it("picks tools from the question's keywords", async () => {
    const p = offlineProvider();
    const reply = await p.chat([{ role: "user", content: "what is the RSI doing" }], [], undefined);
    expect(reply.toolCalls.map((c) => c.name)).toContain("get_indicators");
    expect(reply.toolCalls.map((c) => c.name)).not.toContain("get_calendar");
  });

  it("runs the full sweep for a briefing request", async () => {
    const p = offlineProvider();
    const reply = await p.chat([{ role: "user", content: "brief me on this chart" }], [], undefined);
    const names = reply.toolCalls.map((c) => c.name);
    expect(names).toContain("get_regime");
    expect(names).toContain("list_structures");
    expect(names).toContain("get_price_summary");
  });

  it("composes an answer from tool results once they exist", async () => {
    const p = offlineProvider();
    const reply = await p.chat(
      [
        { role: "user", content: "brief me" },
        {
          role: "tool",
          toolName: "get_context",
          content: JSON.stringify({
            ok: true,
            data: { symbol: "BTCUSDT", timeframe: "1h", bars_loaded: 800, source: "binance", freshness: "live", data_age_seconds: 2 },
          }),
        },
      ],
      [],
      undefined,
    );
    expect(reply.toolCalls.length).toBe(0);
    expect(reply.text).toContain("BTCUSDT");
    expect(reply.text).toContain("800");
  });

  // The whole justification for shipping this as the default.
  it("says out loud that no model was consulted", async () => {
    const p = offlineProvider();
    const reply = await p.chat(
      [
        { role: "user", content: "brief me" },
        { role: "tool", toolName: "get_context", content: JSON.stringify({ ok: true, data: {} }) },
      ],
      [],
      undefined,
    );
    expect(reply.text).toMatch(/no language model was consulted/i);
  });

  // An unusable classifier's probability must be withheld, not relayed.
  it("withholds an unusable forecast probability", async () => {
    const p = offlineProvider();
    const reply = await p.chat(
      [
        { role: "user", content: "forecast" },
        {
          role: "tool",
          toolName: "get_forecast",
          content: JSON.stringify({
            ok: true,
            data: { p_up: 0.58, usable_as_signal: false, standing: "Brier 0.26 is worse than saying 50%." },
          }),
        },
      ],
      [],
      undefined,
    );
    expect(reply.text).toMatch(/not usable/i);
    expect(reply.text).not.toContain("58.0%");
  });

  it("survives an unreadable tool result", async () => {
    const p = offlineProvider();
    const reply = await p.chat(
      [
        { role: "user", content: "brief me" },
        { role: "tool", toolName: "get_context", content: "{not json" },
      ],
      [],
      undefined,
    );
    expect(reply.text.length).toBeGreaterThan(0);
  });
});

describe("createAgentSession", () => {
  const build = (provider: Provider, over: Partial<Parameters<typeof createAgentSession>[0]> = {}) =>
    createAgentSession({
      provider: () => provider,
      tools: () => createToolset(fakeTerminal()),
      ...over,
    });

  /**
   * Vision.
   *
   * The two failure modes worth pinning: base64 leaking into the tool result
   * as TEXT (which no vendor decodes as a picture and every vendor bills for),
   * and a picture arriving with no question attached (which turns "is this a
   * wedge" into "describe this image").
   */
  describe("seeing the chart", () => {
    const withChart = (): ReturnType<typeof fakeTerminal> =>
      fakeTerminal({
        chartImage: () => ({
          ok: true,
          mediaType: "image/png",
          dataBase64: "QUJDRA==",
          width: 1400,
          height: 800,
          caption: "BTCUSDT 1h · binance",
        }),
      });

    it("strips the image out of the tool result and attaches it as a user turn", async () => {
      const s = build(
        scriptedProvider([
          { text: "", toolCalls: [{ id: "c1", name: "see_chart", args: {} }] },
          { text: "It is a wedge.", toolCalls: [] },
        ]),
        { tools: () => createToolset(withChart()) },
      );
      await s.ask("is this a wedge?");

      const hist = s.history();
      const toolTurn = hist.find((m) => m.role === "tool");
      expect(toolTurn).toBeDefined();
      /* The bytes must NOT be in the JSON the model reads as text. */
      expect(toolTurn?.content).not.toContain("QUJDRA==");
      expect(toolTurn?.content).toContain("captured");

      const imageTurn = hist.find((m) => m.role === "user" && m.images !== undefined);
      expect(imageTurn).toBeDefined();
      expect(imageTurn?.images?.[0]?.dataBase64).toBe("QUJDRA==");
      /* And it carries a question, not a bare picture. */
      expect(imageTurn?.content).toMatch(/question I originally asked/i);
    });

    it("reports the refusal when nothing has painted", async () => {
      const s = build(
        scriptedProvider([
          { text: "", toolCalls: [{ id: "c1", name: "see_chart", args: {} }] },
          { text: "done", toolCalls: [] },
        ]),
      );
      await s.ask("look at the chart");
      const hist = s.history();
      expect(hist.some((m) => m.role === "user" && m.images !== undefined)).toBe(false);
      expect(hist.find((m) => m.role === "tool")?.content).toMatch(/has not painted/i);
    });
  });

  it("starts with the system prompt and an empty transcript", () => {
    const s = build(scriptedProvider([]));
    expect(s.transcript().length).toBe(0);
    expect(s.history()[0]).toMatchObject({ role: "system", content: SYSTEM_PROMPT });
  });

  it("ignores an empty question", async () => {
    const s = build(scriptedProvider([]));
    await s.ask("   ");
    expect(s.transcript().length).toBe(0);
  });

  it("records the question then the answer", async () => {
    const s = build(scriptedProvider([{ text: "Hello.", toolCalls: [] }]));
    await s.ask("hi");
    const t = s.transcript();
    expect(t[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(t[1]).toMatchObject({ kind: "assistant", text: "Hello." });
  });

  it("runs a requested tool and puts the result in the transcript before the answer", async () => {
    const s = build(
      scriptedProvider([
        { text: "", toolCalls: [{ id: "1", name: "get_context", args: {} }] },
        { text: "It is BTC on the hourly.", toolCalls: [] },
      ]),
    );
    await s.ask("what am I looking at");
    const kinds = s.transcript().map((e) => e.kind);
    expect(kinds).toEqual(["user", "tool", "assistant"]);
    const toolEntry = s.transcript()[1] as { result: { ok: boolean } };
    expect(toolEntry.result.ok).toBe(true);
  });

  it("feeds the tool result back to the provider as a tool message", async () => {
    const chat = vi.fn().mockResolvedValueOnce({ text: "", toolCalls: [{ id: "1", name: "get_context", args: {} }] })
      .mockResolvedValueOnce({ text: "ok", toolCalls: [] });
    const s = build(scriptedProvider([], { chat }));
    await s.ask("q");
    const second = chat.mock.calls[1]?.[0] as { role: string }[];
    expect(second.some((m) => m.role === "tool")).toBe(true);
  });

  it("shows prose the model emitted alongside its tool calls", async () => {
    const s = build(
      scriptedProvider([
        { text: "Let me check the chart.", toolCalls: [{ id: "1", name: "get_context", args: {} }] },
        { text: "Done.", toolCalls: [] },
      ]),
    );
    await s.ask("q");
    expect(s.transcript()[1]).toMatchObject({ kind: "assistant", text: "Let me check the chart." });
  });

  it("flags a mutating tool call", async () => {
    const s = build(
      scriptedProvider([
        { text: "", toolCalls: [{ id: "1", name: "set_symbol", args: { symbol: "ETHUSDT" } }] },
        { text: "Switched.", toolCalls: [] },
      ]),
    );
    await s.ask("show me eth");
    expect(s.transcript()[1]).toMatchObject({ kind: "tool", mutates: true });
  });

  // An uncapped loop over a metered API is somebody's bill.
  it("stops at the step cap and says so rather than presenting a partial answer", async () => {
    const forever = scriptedProvider([], {
      chat: () => Promise.resolve({ text: "", toolCalls: [{ id: "1", name: "get_context", args: {} }] }),
    });
    const s = build(forever, { maxSteps: 3 });
    await s.ask("loop");
    const last = s.transcript()[s.transcript().length - 1];
    expect(last?.kind).toBe("note");
    expect((last as { text: string }).text).toMatch(/3 tool rounds/);
  });

  it("reports a provider failure as an error entry, not a throw", async () => {
    const s = build(scriptedProvider([], { chat: () => Promise.reject(new Error("502 upstream")) }));
    await expect(s.ask("q")).resolves.toBeUndefined();
    expect(s.transcript()[1]).toMatchObject({ kind: "error" });
    expect((s.transcript()[1] as { text: string }).text).toContain("502 upstream");
  });

  it("explains a network failure in terms of the provider", async () => {
    const s = build(scriptedProvider([], { chat: () => Promise.reject(new Error("Failed to fetch")) }));
    await s.ask("q");
    expect((s.transcript()[1] as { text: string }).text).toMatch(/Could not reach Fake/);
  });

  it("refuses to start when the provider is not configured", async () => {
    const s = build(scriptedProvider([], { ready: () => ({ ok: false, reason: "No API key set." }) }));
    await s.ask("q");
    expect(s.transcript()[1]).toMatchObject({ kind: "error" });
    expect((s.transcript()[1] as { text: string }).text).toMatch(/No API key set/);
    // It must not have added the question to the history it would have sent.
    expect(s.history().some((m) => m.role === "user")).toBe(false);
  });

  // Streaming is presentation. The transcript is the audit record and must
  // only ever contain finished turns.
  it("exposes streamed text outside the transcript, then clears it", async () => {
    const seen: string[] = [];
    const provider = scriptedProvider([], {
      chat: (_m, _t, _s, onDelta) => {
        onDelta?.("Hel");
        seen.push("a");
        onDelta?.("lo.");
        return Promise.resolve({ text: "Hello.", toolCalls: [] });
      },
    });
    const s2 = build(provider);
    await s2.ask("hi");
    expect(seen.length).toBe(1);
    expect(s2.streaming()).toBe("");
    expect((s2.transcript()[1] as { text: string }).text).toBe("Hello.");
    // Nothing partial ever reached the transcript.
    expect(s2.transcript().length).toBe(2);
  });

  it("clears streamed text on cancel", () => {
    const s2 = build(
      scriptedProvider([], {
        chat: (_m, _t, _s, onDelta) => {
          onDelta?.("partial");
          return new Promise<never>(() => {});
        },
      }),
    );
    void s2.ask("q");
    expect(s2.streaming()).toBe("partial");
    s2.cancel();
    expect(s2.streaming()).toBe("");
  });

  it("works with a provider that never streams", async () => {
    const s2 = build(scriptedProvider([{ text: "done", toolCalls: [] }]));
    await s2.ask("q");
    expect(s2.streaming()).toBe("");
    expect((s2.transcript()[1] as { text: string }).text).toBe("done");
  });

  it("clears busy when the answer lands", async () => {
    const s = build(scriptedProvider([{ text: "done", toolCalls: [] }]));
    await s.ask("q");
    expect(s.busy()).toBe(false);
  });

  it("reset clears the transcript and the history back to the system prompt", async () => {
    const s = build(scriptedProvider([{ text: "done", toolCalls: [] }]));
    await s.ask("q");
    s.reset();
    expect(s.transcript().length).toBe(0);
    expect(s.history().length).toBe(1);
  });

  it("cancel clears busy", async () => {
    const s = build(scriptedProvider([], { chat: () => new Promise(() => {}) }));
    void s.ask("q");
    s.cancel();
    expect(s.busy()).toBe(false);
  });

  // Two loops appending to one transcript would interleave into nonsense.
  it("a second ask supersedes the first", async () => {
    let release: ((r: ProviderReply) => void) | null = null;
    const chat = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ProviderReply>((res) => { release = res; }))
      .mockResolvedValue({ text: "second answer", toolCalls: [] });
    const s = build(scriptedProvider([], { chat }));

    void s.ask("first");
    const second = s.ask("second");
    release?.({ text: "first answer", toolCalls: [] });
    await second;

    const answers = s.transcript().filter((e) => e.kind === "assistant") as { text: string }[];
    expect(answers.map((a) => a.text)).toEqual(["second answer"]);
  });

  it("names the empty-answer case instead of showing a blank bubble", async () => {
    const s = build(scriptedProvider([{ text: "   ", toolCalls: [] }]));
    await s.ask("q");
    expect((s.transcript()[1] as { text: string }).text).toMatch(/empty answer/i);
  });

  // Dropping the system prompt would remove the only thing stopping the model
  // inventing prices; dropping the end would remove the question.
  it("trims the middle of a long history, never the system prompt", async () => {
    const s = build(scriptedProvider([]), { maxHistory: 6 });
    for (let i = 0; i < 12; i++) await s.ask(`question ${i}`);
    const h = s.history();
    expect(h.length).toBeLessThanOrEqual(6);
    expect(h[0]).toMatchObject({ role: "system" });
    expect(h[h.length - 1]).toMatchObject({ role: "assistant" });
  });

  it("never leaves an orphan tool message at the head of a trimmed window", async () => {
    const s = build(
      scriptedProvider([], {
        chat: (msgs) =>
          Promise.resolve(
            msgs.filter((m) => m.role === "tool").length > 0
              ? { text: "answer", toolCalls: [] }
              : { text: "", toolCalls: [{ id: "1", name: "get_context", args: {} }] },
          ),
      }),
      { maxHistory: 4 },
    );
    for (let i = 0; i < 6; i++) await s.ask(`q${i}`);
    expect(s.history()[1]?.role).not.toBe("tool");
  });
});

describe("the v46 analytics tools", () => {
  it("get_leading_read hands back all three axes rather than one score", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("get_leading_read"));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ timing: 0.7, direction: -0.4, conviction: 0.3 });
  });

  /* The instruction that keeps a language model from turning a squeeze into a
     direction, which is the single most common thing said about the indicator
     and is false. */
  it("tells the model in as many words that compression has no direction", () => {
    const tool = createToolset(fakeTerminal()).find((t) => t.name === "get_leading_read");
    expect(tool?.description).toMatch(/NOTHING about direction/);
    expect(tool?.description).toMatch(/null means nothing spoke/);
  });

  it("carries each component limit through, so a caveat cannot be dropped", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("get_leading_read"));
    const comps = (r.data as { components: readonly { limit: string }[] }).components;
    expect(comps[0]?.limit).toContain("never which way");
  });

  it("refuses rather than estimating when the leading read is unavailable", async () => {
    const tools = createToolset(
      fakeTerminal({
        leading: () => ({
          ok: false,
          timing: 0,
          direction: null,
          conviction: 0,
          coverage: 0,
          headline: "",
          components: [],
          reason: "Only 40 closed bars are loaded; 210 are needed.",
        }),
      }),
    );
    const r = await runTool(tools, call("get_leading_read"));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("210 are needed");
  });

  it("get_portfolio_risk puts the exclusion in the summary, not only in a warning", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("get_portfolio_risk"));
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("ZZZ");
    expect(r.summary).toContain("EXCLUDED");
  });

  /* effectiveBets is out of measuredLegs, never out of the position count. */
  it("quotes the bet count against the legs it measured", async () => {
    const r = await runTool(createToolset(fakeTerminal()), call("get_portfolio_risk"));
    expect(r.summary).toContain("2 measured leg(s) behaving like 1.4 independent bets");
  });

  it("passes a block straight through instead of estimating around it", async () => {
    const tools = createToolset(
      fakeTerminal({
        portfolioRisk: async () => ({
          ok: false,
          blocked: "Only 12 bars are shared by every symbol in the book; 60 are needed.",
          sample: 0,
          gross: 0,
          net: 0,
          measuredLegs: 0,
          effectiveBets: 0,
          missing: [],
          tails: [],
          contributions: [],
          betas: [],
          stress: [],
          warnings: [],
        }),
      }),
    );
    const r = await runTool(tools, call("get_portfolio_risk"));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("60 are needed");
  });

  it("tells the model never to quote a beta without its R-squared", () => {
    const tool = createToolset(fakeTerminal()).find((t) => t.name === "get_portfolio_risk");
    expect(tool?.description).toMatch(/[Nn]ever quote a beta without its/);
    expect(tool?.description).toMatch(/cannot.*change a position or place an order/);
  });
});
