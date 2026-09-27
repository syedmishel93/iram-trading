import { describe, it, expect } from "vitest";
import { parseRuleSpec } from "../src/agent/rulespec";
import { runSpecTest } from "../src/backtest/spectest";
import { outlookReport } from "../src/agent/reads";
import { simulateOutlook } from "../src/analysis/outlook";
import { offlineProvider, type AgentMessage } from "../src/agent/provider";
import { createToolset, runTool, type TerminalAccess } from "../src/agent/tools";
import type { BarView } from "../src/chart/series";

/** A seeded random walk: enough movement for volatility, no edge in it. */
function walk(n: number, seed = 7): BarView[] {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: BarView[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = Math.max(1, c * (1 + (rnd() - 0.5) * 0.02));
    const hi = Math.max(o, c) * (1 + rnd() * 0.004);
    const lo = Math.min(o, c) * (1 - rnd() * 0.004);
    out.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h: hi, l: lo, c, v: 100 + rnd() * 50 });
  }
  return out;
}

describe("parseRuleSpec", () => {
  it("accepts the tool description's first example as written", () => {
    const r = parseRuleSpec({
      name: "Pullback in trend",
      long: [["ema50", ">", "ema200"], ["rsi", "crossabove", "40"]],
      short: [["ema50", "<", "ema200"], ["rsi", "crossbelow", "60"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    expect(r.ok).toBe(true);
  });

  it("reads a numeric threshold written as a number, losslessly", () => {
    const r = parseRuleSpec({ long: [["rsi", "<", 30]], stop: { type: "pct", value: 1 }, target: { type: "none" } });
    expect(r.ok && r.spec.long[0]).toEqual(["rsi", "<", "30"]);
  });

  it("returns every problem at once, the terminal's own wording verbatim", () => {
    const r = parseRuleSpec({
      long: [["price", ">", "ema20"], ["rsi", "above", "50"], ["close", ">"]],
      stop: { type: "atr", mult: 0 },
      target: { type: "rr", value: 2 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      { where: "long[2]", message: "A condition must be exactly [column, operator, value]." },
      { where: "long[0]", message: '"price" is not an indicator this build computes.' },
      { where: "long[1]", message: '"above" is not an operator.' },
      { where: "stop", message: "An ATR stop needs a positive multiple." },
    ]);
  });

  it("never defaults a missing stop", () => {
    const r = parseRuleSpec({ long: [["rsi", "<", "30"]], target: { type: "none" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.where).toBe("stop");
  });
});

describe("runSpecTest", () => {
  const spec = (() => {
    const r = parseRuleSpec({
      name: "9/21 cross",
      long: [["ema9", "crossabove", "ema21"]],
      short: [["ema9", "crossbelow", "ema21"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    if (!r.ok) throw new Error("fixture spec is invalid");
    return r.spec;
  })();

  it("refuses a series shorter than the warm-up instead of reporting on it", () => {
    const r = runSpecTest(spec, walk(40));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toContain("40 bars available");
  });

  it("reports in-sample, walk-forward, the gate, Monte Carlo, random entry and excursions", () => {
    const r = runSpecTest(spec, walk(3000), { symbol: "TEST", timeframe: "1h", source: "fixture" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules["entry"]).toBe("LONG when EMA 9 crosses above EMA 21; SHORT when EMA 9 crosses below EMA 21");
    expect(r.rules["stop"]).toBe("2 × ATR(14) from entry");
    expect(r.walk_forward.folds).toHaveLength(5);
    expect(r.in_sample.metrics).toHaveProperty("sortino");
    expect(r.in_sample.metrics).toHaveProperty("calmar");
    /* One rule set has no selection to measure, so the gate cannot promote it. */
    expect(r.gate.promoted).toBe(false);
    expect(r.gate.checks.find((c) => c.id === "pbo")?.text).toBe(
      "PBO not computed — a check nobody ran is not a check that passed.",
    );
    expect(r.monte_carlo).toHaveProperty("max_drawdown_fraction");
    expect(r.random_entry).toHaveProperty("p_value");
    expect(r.data).toMatchObject({ symbol: "TEST", timeframe: "1h", source: "fixture", bars: 3000 });
  });

  it("refuses to report a result computed over generated bars", () => {
    const r = runSpecTest(spec, walk(3000), { containsDemo: true });
    expect(r.ok).toBe(false);
  });
});

describe("outlookReport", () => {
  const bars = walk(1000);
  const o = simulateOutlook(bars);
  const noLines = () => ({ range: "", lean: "", odds: null });

  it("prices a supplied plan's odds beside the break-even its R needs", () => {
    const last = bars[bars.length - 1]?.c ?? 0;
    const r = outlookReport(
      o,
      { source: "supplied by the caller", direction: "long", entry: last, stop: last * 0.99, target1: last * 1.02 },
      "",
      null,
      noLines,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* 2R to target 1 → the target must come first 1/3 of the time. */
    expect(r.odds?.["reward_to_risk_t1"]).toBe(2);
    expect(r.odds?.["break_even_rate"]).toBe(0.3333);
    expect(r.odds?.["basis"]).toBe("modelled");
    expect(r.basis).toBe("modelled");
    expect(r.cone.map((c) => c.bars_ahead)).toEqual([1, 6, 12, 24]);
    expect(r.calibration).toMatchObject({ pending: true });
    expect(r.p_up_label).toContain("NOT a directional signal");
  });

  it("refuses under 300 bars rather than projecting", () => {
    const r = outlookReport(simulateOutlook(walk(120)), null, "", null, noLines);
    expect(r.ok).toBe(false);
  });

  it("refuses odds for an incoherent plan and says why", () => {
    const last = bars[bars.length - 1]?.c ?? 0;
    const r = outlookReport(
      o,
      { source: "supplied by the caller", direction: "long", entry: last, stop: last * 1.01, target1: last * 1.02 },
      "",
      null,
      noLines,
    );
    expect(r.ok && r.odds?.["refused"]).toBe("A long stop must be below the entry.");
  });
});

describe("the expert tools' input handling", () => {
  /* Only the accessors these tests reach are real; the rest refuse. */
  const calls: unknown[] = [];
  const terminal = new Proxy({} as TerminalAccess, {
    get: (_t, key) => {
      if (key === "outlook") return async (plan: unknown) => { calls.push(plan); return { ok: false, refused: "x" }; };
      if (key === "testStrategy") return async (spec: unknown) => { calls.push(spec); return { ok: false, refused: "x", rules: {} }; };
      return () => ({ ok: false, reason: "not in this test" });
    },
  });
  const tools = createToolset(terminal);

  it("get_outlook refuses half a plan instead of guessing the rest", async () => {
    calls.length = 0;
    const r = await runTool(tools, { id: "1", name: "get_outlook", args: { entry: 100, stop: 95 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pass all of direction");
    expect(calls).toHaveLength(0);
  });

  it("test_strategy returns the problems and never reaches the backtest", async () => {
    calls.length = 0;
    const r = await runTool(tools, { id: "2", name: "test_strategy", args: { long: [["rsi", "<", "30"]] } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('stop: A stop is required');
    expect(calls).toHaveLength(0);
  });

  it("describes the rule language precisely enough to write one", () => {
    const t = tools.find((x) => x.name === "test_strategy");
    expect(t?.parameters.required).toEqual(["long", "stop", "target"]);
    expect(t?.description).toContain("Example 1:");
    expect(t?.description).toContain("Example 2:");
    expect(t?.description).toContain("crossabove");
    expect(t?.description).toContain("ema200");
  });
});

/* ------------------------------------------------------------ desk note */

const tool = (name: string, result: unknown): AgentMessage => ({
  role: "tool",
  toolName: name,
  toolCallId: name,
  content: JSON.stringify(result),
});

const CONTEXT = tool("get_context", {
  ok: true,
  data: { symbol: "BTCUSDT", timeframe: "1h", bars_loaded: 800, source: "binance", freshness: "live", data_age_seconds: 2 },
});

const ARMED = tool("get_setup", {
  ok: true,
  data: {
    symbol: "BTCUSDT",
    timeframe: "1h",
    call: "armed",
    headline: "ARMED — waiting for price at the zone.",
    blocking: [],
    unchecked: [],
    watch_level: 64210,
    plan: {
      direction: "long", entry: 64250, entry_low: 64210, entry_high: 64290, stop: 63800,
      target1: 65150, target2: 65600, reward_to_risk_t1: 2, break_even_hit_rate: 0.3333,
      stop_from: "structure", stop_atr_now: 1.4,
    },
    plan_withheld: "",
    no_setup_reason: "",
    waiting_for: "",
    history: null,
  },
});

const STAND_DOWN = tool("get_setup", {
  ok: true,
  data: {
    call: "stand-down",
    headline: "STAND DOWN — 1 gate blocks.",
    blocking: [{ text: "Spread is 41% of the stop distance — your ceiling is 25%.", clears: "A tighter spread, or a wider structural stop." }],
    unchecked: [],
    watch_level: null,
    plan: null,
    plan_withheld: "A plan exists but a gate blocks or could not be checked, so its entry, stop and size are withheld — the same rule the Setup card applies.",
    no_setup_reason: "",
    waiting_for: "",
    history: null,
  },
});

const OUTLOOK = tool("get_outlook", {
  ok: true,
  data: {
    cone: [{ bars_ahead: 24, p5: 61000, p25: 63000, p50: 64300, p75: 65500, p95: 67500, p5_pct: -5.1, p25_pct: -2, p50_pct: 0.1, p75_pct: 1.9, p95_pct: 5 }],
    p_up_base_rate: 0.51,
    p_up_label: "a base rate, NOT a directional signal.",
    lines: { range: "", lean: "", odds: "Target 1 before the stop in 38% of paths, stop first in 44%, neither in 18%." },
    calibration: { basis: "measured", note: "The 90% band held 87% of the time over 229 past checks, 24 bars ahead.", usable: true },
  },
});

describe("the offline desk note", () => {
  const p = offlineProvider();
  const ask = (q: string, results: AgentMessage[]) =>
    p.chat([{ role: "system", content: "s" }, { role: "user", content: q }, ...results], [], undefined);

  it("runs the verdict, the outlook and the risk tools for 'what should I do'", async () => {
    const r = await ask("What should I do now?", []);
    const names = r.toolCalls.map((c) => c.name);
    for (const n of ["get_context", "get_setup", "get_decision", "get_outlook", "get_setup_history", "get_calendar", "get_risk_state"]) {
      expect(names).toContain(n);
    }
  });

  it("sizes the card's plan from the prices get_setup returned, not from the sentence", async () => {
    const r = await ask("should I buy at 70000 with a stop at 69000?", [CONTEXT, ARMED]);
    expect(r.toolCalls).toEqual([{ id: "offline-size", name: "size_position", args: { entry: 64250, stop: 63800 } }]);
  });

  it("writes the six parts, with the call taken from the verdict", async () => {
    const r = await ask("What should I do now?", [
      CONTEXT,
      ARMED,
      OUTLOOK,
      tool("size_position", { ok: true, data: { qty: 0.22, riskAmount: 99, riskPct: 0.99, stopDistancePct: 0.7, warnings: [] } }),
    ]);
    expect(r.toolCalls).toEqual([]);
    const t = r.text;
    for (const h of ["**1 · The call**", "**2 · Market read**", "**3 · Scenarios — next 24 bars, modelled**", "**4 · The plan**", "**5 · What would change the view**", "**6 · Risks**"]) {
      expect(t).toContain(h);
    }
    expect(t).toContain("**Wait for price at 64,210.00.**");
    expect(t).toContain("1 in 4 simulated paths end below 63,000.00 (-2.0%)");
    expect(t).toContain("Target 1 before the stop in 38% of paths");
    expect(t).toContain("0.22 units, risking 99.00 (0.990% of equity)");
    expect(t).toMatch(/no language model was consulted/);
  });

  it("stands aside on a block, names what would clear it, and prints no entry or stop", async () => {
    const r = await ask("should I enter?", [CONTEXT, STAND_DOWN, OUTLOOK]);
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toContain("**Stand aside.**");
    expect(r.text).toContain("What would clear it: A tighter spread, or a wider structural stop.");
    expect(r.text).not.toMatch(/Stop \d/);
    expect(r.text).not.toContain("Target 1 before the stop");
  });

  it("names no call at all when the verdict is unavailable", async () => {
    const r = await ask("What should I do now?", [CONTEXT, tool("get_setup", { ok: false, error: "The Setup card has no read yet." })]);
    expect(r.text).toContain("**No call.** The Setup card has no read yet.");
  });

  it("answers the second question from its own results, not the first question's", async () => {
    const r = await p.chat(
      [
        { role: "system", content: "s" },
        { role: "user", content: "what is the RSI" },
        tool("get_indicators", { ok: true, data: { rsi_14: 71 } }),
        { role: "assistant", content: "RSI 71" },
        { role: "user", content: "What should I do now?" },
      ],
      [],
      undefined,
    );
    expect(r.toolCalls.map((c) => c.name)).toContain("get_setup");
  });
});

describe("foldsFor", () => {
  /* The live case that ran no walk-forward at all: EMA-200 warm-up, 3,000 bars. */
  it("gives an EMA-200 rule folds long enough to hold its warm-up", async () => {
    const { foldsFor } = await import("../src/backtest/spectest");
    expect(foldsFor(3000, 205)).toBe(4);
    expect(foldsFor(3000, 26)).toBe(5);
    expect(foldsFor(500, 205)).toBe(2);
  });

  it("actually scores folds for an EMA-200 rule on 3,000 bars", () => {
    const r = parseRuleSpec({
      long: [["ema50", ">", "ema200"], ["rsi", "crossabove", "40"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    if (!r.ok) throw new Error("fixture spec is invalid");
    const out = runSpecTest(r.spec, walk(3000));
    expect(out.ok && out.walk_forward.folds.length).toBe(4);
  });
});
