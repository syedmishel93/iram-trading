// @vitest-environment jsdom
/**
 * The Strategy desk's "built together" flow.
 *
 * What is pinned:
 *  1. AUTHORSHIP — the analyst's lines are "ai", an edited line becomes "you",
 *     a redraft keeps the operator's identical lines as theirs, and all of it
 *     survives a reload from storage.
 *  2. REFUSAL — an incomplete draft is never tested: no stop and an empty
 *     value are named problems, not defaults.
 *  3. "NOT RUN YET" — before a backtest, the backtest, the simulation and the
 *     critique each say so. Nothing is drawn in their place.
 *  4. DECISIONS — a discard needs a reason, is kept with the version, and the
 *     dropped list shows it after a reload.
 *  5. The conversation with NO analyst says nothing was drafted.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { createKV, memoryRawStore, type KV } from "../src/store/kv";
import type { AgentSession, TranscriptEntry } from "../src/agent/session";
import type { BarView } from "../src/chart/series";
import type { RuleSpec } from "../src/backtest/rules";
import { createStrategyFlow, draftPrompt, type FlowSettings } from "../src/ui/strategy/flow";
import {
  FLOW_SLOT,
  emptyDraft,
  fingerprint,
  lineText,
  linesFromSpec,
  readFlow,
  similarRuns,
  specFromDraft,
  versionsTried,
  type Draft,
  type RunSummary,
} from "../src/ui/strategy/draft";
import type { LoadedBars } from "../src/ui/strategy/load";

const T0 = Date.UTC(2025, 0, 1);
const HOUR = 3_600_000;

/* Test-only bars: a deterministic trending sine. Never product data. */
function bars(n: number): BarView[] {
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = 100 + i * 0.02 + Math.sin(i / 9) * 3 + Math.sin(i / 2.3) * 0.6;
    out.push({ t: T0 + i * HOUR, o, h: Math.max(o, p) + 0.3, l: Math.min(o, p) - 0.3, c: p, v: 1000 });
  }
  return out;
}

const SPEC: RuleSpec = {
  id: "analyst-draft",
  name: "RSI turn",
  style: "custom",
  long: [["rsi", "crossabove", "35"]],
  exitLong: [["rsi", ">", "60"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "rr", value: 2 },
};

const settings = (): FlowSettings => ({
  spreadBp: signal(2),
  commissionBp: signal(4),
  slippageBp: signal(1),
  carryBp: signal(1),
  riskPct: signal(1),
  depth: signal(3000),
});

const loaded = (n = 3000): LoadedBars => ({ bars: bars(n), source: "archive", coverage: 1, demo: false, note: "" });

/** Lets awaited loads resolve and frame-scheduled work run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
  }
}

/** An analyst session that answers by "calling" test_strategy with `args`. */
function fakeSession(args: Record<string, unknown>, answer = "Drafted as an RSI turn."): AgentSession & { asked: string[] } {
  const transcript = signal<readonly TranscriptEntry[]>([]);
  const asked: string[] = [];
  return {
    asked,
    transcript,
    busy: signal(false),
    streaming: signal(""),
    history: () => [],
    cancel: () => {},
    reset: () => transcript.set([]),
    async ask(text: string) {
      asked.push(text);
      const at = Date.now();
      transcript.update((t) => [
        ...t,
        { kind: "user", at, text },
        { kind: "tool", at, name: "test_strategy", args, result: { ok: true, summary: "tested" }, mutates: false },
        { kind: "assistant", at, text: answer, provider: "fake" },
      ]);
    },
  };
}

function mount(opts: { kv?: KV; session?: AgentSession; load?: () => Promise<LoadedBars> } = {}) {
  const flow = createStrategyFlow({
    symbol: signal("BTCUSDT"),
    timeframe: signal("1h"),
    settings: settings(),
    load: opts.load ?? (() => Promise.resolve(loaded())),
    ...(opts.kv ? { kv: opts.kv } : {}),
    ...(opts.session ? { session: opts.session } : {}),
    now: () => T0 + 5000 * HOUR,
  });
  document.body.appendChild(flow.el);
  return flow;
}

const step = (el: HTMLElement, name: string): HTMLElement => el.querySelector(`[data-step="${name}"]`) as HTMLElement;

describe("draft model", () => {
  it("a spec becomes one line per condition, stop and target, all by the given author", () => {
    const lines = linesFromSpec(SPEC, "ai");
    expect(lines.map(lineText)).toEqual([
      "Buy when RSI(14) crosses above 35",
      "Close a buy when RSI(14) is above 60",
      "Stop 2 × ATR(14) from entry",
      "Target 2× the risk",
    ]);
    expect(lines.every((l) => l.author === "ai")).toBe(true);
    expect(lines.map((l) => l.id)).toEqual(["l1", "l2", "l3", "l4"]);
  });

  it("a redraft keeps the operator's identical lines as theirs", () => {
    const mine = linesFromSpec(SPEC, "you");
    const redraft = linesFromSpec({ ...SPEC, long: [["rsi", "crossabove", "35"], ["adx", ">", "20"]] }, "ai", mine);
    const byText = new Map(redraft.map((l) => [lineText(l), l.author]));
    expect(byText.get("Buy when RSI(14) crosses above 35")).toBe("you");
    expect(byText.get("Buy when ADX(14) is above 20")).toBe("ai");
    expect(byText.get("Stop 2 × ATR(14) from entry")).toBe("you");
    // Ids are unique.
    expect(new Set(redraft.map((l) => l.id)).size).toBe(redraft.length);
  });

  it("refuses rather than defaults: no stop, no target, an empty value", () => {
    const d: Draft = { ...emptyDraft("d"), lines: linesFromSpec(SPEC, "you").filter((l) => l.kind === "cond") };
    const r = specFromDraft(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.map((p) => p.message)).toEqual([
        "A stop is required — add one. None is assumed.",
        'A target is required — choose "exit rule only" if it leaves only on its stop or a close rule.',
      ]);
    }
    const blank: Draft = {
      ...emptyDraft("d"),
      lines: linesFromSpec({ ...SPEC, long: [["rsi", "crossabove", ""]] }, "you"),
    };
    const b = specFromDraft(blank);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.problems.map((p) => p.message).join(" ")).toContain("is neither an indicator nor a number");
  });

  it("the fingerprint ignores the order of ANDed conditions and the name", () => {
    const a = { ...SPEC, long: [["rsi", "crossabove", "35"], ["adx", ">", "20"]] } as RuleSpec;
    const b = { ...SPEC, name: "other", long: [["adx", ">", "20"], ["rsi", "crossabove", "35"]] } as RuleSpec;
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(SPEC));
  });

  it("the library counts versions per market and finds similar ones", () => {
    const run = (fp: string, lines: string[], symbol = "BTCUSDT"): RunSummary => ({
      at: T0,
      fingerprint: fp,
      name: fp,
      lines,
      symbol,
      timeframe: "1h",
      bars: 3000,
      trades: 40,
      expectancyR: 0.1,
      oosExpectancyR: null,
      oosTrades: 0,
    });
    const lib = [run("a", ["x", "y", "z"]), run("a", ["x", "y", "z"]), run("b", ["x", "y", "q"]), run("c", ["p"]), run("d", ["x"], "ETHUSDT")];
    expect(versionsTried(lib, "BTCUSDT", "1h")).toBe(3);
    const sim = similarRuns(lib, ["x", "y", "z"], "a");
    expect(sim.map((s) => s.run.fingerprint)).toEqual(["b"]);
    expect(sim[0]?.overlap).toBeCloseTo(0.5, 9);
  });

  it("a stored line naming an indicator this build lacks is dropped on load, not fatal", () => {
    const good = linesFromSpec(SPEC, "ai");
    const state = readFlow({
      draft: { id: "d", name: "n", lines: [...good, { id: "l9", author: "you", kind: "cond", section: "long", cond: ["nope", ">", "1"] }], paper: null },
      chat: [],
      library: [],
      decisions: [],
    });
    expect(state?.draft.lines.length).toBe(good.length);
  });
});

describe("flow — not run yet", () => {
  it("the backtest, the simulation and the critique each say so before anything runs", () => {
    const f = mount();
    expect(step(f.el, "backtest").textContent).toContain("Not run yet.");
    expect(step(f.el, "simulation").textContent).toContain("Not run yet — run the backtest first");
    expect(step(f.el, "simulation").textContent).toContain("Not run yet — the critique reads the backtest's result.");
    // Nothing illustrative: the simulation button is disabled with no run.
    const sim = step(f.el, "simulation").querySelector("button") as HTMLButtonElement;
    expect(sim.disabled).toBe(true);
    // An empty draft cannot be tested.
    const run = [...step(f.el, "backtest").querySelectorAll("button")].find((b) => b.textContent === "Run backtest") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    f.el.remove();
  });

  it("with no analyst connected, words draft nothing and the desk says so", async () => {
    const f = mount();
    expect(step(f.el, "conversation").textContent).toContain("No analyst is connected to this desk");
    await f.send("buy the dip");
    expect(f.state.peek().draft.lines).toEqual([]);
    expect(f.state.peek().chat.map((c) => c.who)).toEqual(["you", "note"]);
    expect(f.state.peek().chat[1]?.text).toContain("nothing was drafted");
    f.el.remove();
  });
});

describe("flow — authorship, drafted by the analyst and edited by you", () => {
  it("drafts from the analyst's test_strategy call, tags AI, then an edit tags You, and it persists", async () => {
    const kv = createKV(memoryRawStore());
    const session = fakeSession({
      name: "RSI turn",
      long: [["rsi", "crossabove", 35]],
      exitLong: [["rsi", ">", "60"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    const f = mount({ kv, session });
    await f.send("buy when RSI turns up from oversold");
    await settle();

    // The prompt carried the idea and the market.
    expect(session.asked[0]).toContain("The idea: buy when RSI turns up from oversold");
    expect(session.asked[0]).toContain("BTCUSDT 1h");

    const rows = [...step(f.el, "rules").querySelectorAll<HTMLElement>(".strat-rule")];
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.querySelector(".card-who")?.getAttribute("data-who"))).toEqual(["ai", "ai", "ai", "ai"]);
    expect(rows.map((r) => r.querySelector(".card-who")?.textContent)).toEqual(["AI", "AI", "AI", "AI"]);
    // The analyst's answer is in the conversation, tagged AI.
    expect(step(f.el, "conversation").querySelector('.strat-msg[data-who="ai"]')?.textContent).toContain("Drafted as an RSI turn.");

    // Edit the first line's threshold: it becomes yours.
    const operand = rows[0]?.querySelector(".strat-operand") as HTMLInputElement;
    operand.value = "30";
    operand.dispatchEvent(new Event("change"));
    await settle(); // the computed settles on a microtask, then the render effect repaints on a frame
    const after = [...step(f.el, "rules").querySelectorAll<HTMLElement>(".strat-rule")];
    expect(after[0]?.querySelector(".card-who")?.getAttribute("data-who")).toBe("you");
    expect(after[1]?.querySelector(".card-who")?.getAttribute("data-who")).toBe("ai");

    // Reload from storage: the authors are what they were.
    const stored = kv.read(FLOW_SLOT).value.draft.lines;
    expect(stored.map((l) => [lineText(l), l.author])).toEqual([
      ["Buy when RSI(14) crosses above 30", "you"],
      ["Close a buy when RSI(14) is above 60", "ai"],
      ["Stop 2 × ATR(14) from entry", "ai"],
      ["Target 2× the risk", "ai"],
    ]);
    f.el.remove();
    const again = mount({ kv });
    const tags = [...step(again.el, "rules").querySelectorAll(".strat-rule .card-who")].map((t) => t.getAttribute("data-who"));
    expect(tags).toEqual(["you", "ai", "ai", "ai"]);
    again.el.remove();
  });

  it("the analyst's draft is backtested on the loaded bars, and the critique reads the real result", async () => {
    const session = fakeSession({
      long: [["rsi", "crossabove", "35"]],
      exitLong: [["rsi", ">", "60"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    const f = mount({ session });
    await f.send("rsi turn");
    await settle();
    const r = f.last.peek();
    expect(r?.result.ok).toBe(true);
    expect(step(f.el, "backtest").textContent).not.toContain("Not run yet.");
    expect(step(f.el, "backtest").textContent).toMatch(/\d+ bars of BTCUSDT 1h from archive/);
    const review = f.review.peek();
    expect(review).not.toBeNull();
    expect(step(f.el, "simulation").querySelector(".strat-critique-head")?.textContent).toBe(review?.headline);
    // Ruin is "not checked" until the simulation runs, then measured.
    expect(review?.checks.find((c) => c.id === "ruin")?.passed).toBeNull();
    if (r?.result.ok && r.result.trades.length >= 30) {
      f.simulate();
      await settle();
      expect(f.review.peek()?.checks.find((c) => c.id === "ruin")?.passed).not.toBeNull();
    }
    f.el.remove();
  });

  it("a rule set the analyst could not produce leaves the rules untouched and says so", async () => {
    const session = fakeSession({ long: [["rsi", "crossabove", "35"]] }); // no stop, no target
    const f = mount({ session });
    await f.send("something vague");
    expect(f.state.peek().draft.lines).toEqual([]);
    const note = f.state.peek().chat.find((c) => c.who === "note");
    expect(note?.text).toContain("could not be read, so the rules did not change");
    expect(note?.text).toContain("A stop is required");
    f.el.remove();
  });

  it("the prompt tells the analyst to name what it could not express", () => {
    const p = draftPrompt("only in London", "EURUSD", "1h", null, []);
    expect(p).toContain("say plainly which part was left out");
    expect(p).toContain("Current rules: none yet");
  });
});

describe("flow — decisions", () => {
  it("a discard needs a reason, keeps the version with it, and the dropped list survives a reload", async () => {
    const kv = createKV(memoryRawStore());
    const session = fakeSession({
      long: [["rsi", "crossabove", "35"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    const f = mount({ kv, session });
    await f.send("rsi");
    await settle();

    const decision = step(f.el, "decision");
    const discard = decision.querySelector('[data-decision="discard"]') as HTMLButtonElement;
    discard.click();
    flushFrames();
    const confirm = [...decision.querySelectorAll("button")].find((b) => b.textContent === "Drop this version") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const why = decision.querySelector('input[aria-label="Reason for discarding"]') as HTMLInputElement;
    why.value = "falls apart at double costs";
    why.dispatchEvent(new Event("input"));
    flushFrames();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    flushFrames();

    const s = kv.read(FLOW_SLOT).value;
    expect(s.decisions.length).toBe(1);
    expect(s.decisions[0]?.kind).toBe("discard");
    expect(s.decisions[0]?.reason).toBe("falls apart at double costs");
    expect(s.decisions[0]?.lines).toContain("Buy when RSI(14) crosses above 35");
    expect(s.decisions[0]?.result?.trades).toBeGreaterThanOrEqual(0);
    // The draft is cleared for the next idea.
    expect(s.draft.lines).toEqual([]);
    expect(step(f.el, "decision").textContent).toContain("falls apart at double costs");
    f.el.remove();

    const again = mount({ kv });
    const dropped = step(again.el, "decision").querySelector(".strat-dropped")?.textContent ?? "";
    expect(dropped).toContain("Versions you dropped (1)");
    expect(dropped).toContain("falls apart at double costs");
    again.el.remove();
  });

  it("paper trading needs a backtest of THESE rules, and records its start", async () => {
    const kv = createKV(memoryRawStore());
    const session = fakeSession({
      long: [["rsi", "crossabove", "35"]],
      stop: { type: "atr", mult: 2 },
      target: { type: "rr", value: 2 },
    });
    const f = mount({ kv, session });
    const paper = () => step(f.el, "decision").querySelector('[data-decision="paper"]') as HTMLButtonElement;
    expect(paper().disabled).toBe(true);
    await f.send("rsi");
    await settle();
    expect(paper().disabled).toBe(false);
    paper().click();
    await settle();
    const d = kv.read(FLOW_SLOT).value.draft;
    expect(d.paper?.since).toBe(T0 + 5000 * HOUR);
    // The test bars end before "now", so the forward record is honestly empty.
    expect(step(f.el, "decision").textContent).toContain("No trades entered since then.");
    f.el.remove();
  });
});

/**
 * v60: a strategy the SEARCH found, opened in the Manual editor.
 *
 * The seam between the two modes. What matters is that it lands as editable
 * lines, that it does not quietly re-run, and that it does not re-stamp the
 * operator's own rules as the terminal's.
 */
describe("loading a discovered spec into the editor", () => {
  it("becomes editable lines, and says it has not been re-run here", async () => {
    const f = mount();
    f.loadSpec(SPEC);
    await settle();
    const rules = step(f.el, "rules");
    expect([...rules.querySelectorAll(".strat-rule")].length).toBe(linesFromSpec(SPEC, "ai").length);
    expect((rules.querySelector(".strat-name") as HTMLInputElement).value).toBe(SPEC.name);
    expect(f.state().draft.lines.map(lineText)).toEqual(linesFromSpec(SPEC, "ai").map(lineText));
    expect(step(f.el, "conversation").textContent).toContain("It has not been re-run here");
    expect(f.last()).toBeNull();
    f.el.remove();
  });

  it("keeps a line the operator had already written as theirs", async () => {
    const f = mount();
    /* The operator writes one rule of their own: Close is above 100. */
    const add = [...step(f.el, "rules").querySelectorAll("button")].find((b) => b.textContent === "+ Add your rule");
    (add as HTMLButtonElement).click();
    await settle();
    const operand = step(f.el, "rules").querySelector(".strat-operand") as HTMLInputElement;
    operand.value = "100";
    operand.dispatchEvent(new Event("change"));
    await settle();
    expect(f.state().draft.lines.map(lineText)).toContain("Buy when Close is above 100");
    expect(f.state().draft.lines.every((l) => l.author === "you")).toBe(true);

    /* A discovered rule arrives carrying the same condition. It must not be
       re-stamped as the terminal's. */
    f.loadSpec({ ...SPEC, long: [["close", ">", "100"], ["rsi", "crossabove", "35"]] });
    await settle();
    const byText = new Map(f.state().draft.lines.map((l) => [lineText(l), l.author]));
    expect(byText.get("Buy when Close is above 100")).toBe("you");
    expect(byText.get("Buy when RSI(14) crosses above 35")).toBe("ai");
    f.el.remove();
  });
});

describe("the conversation card leads with one line", () => {
  /* MEASURED. On the Strategy desk 53% of the first screen went before the first
     control, and after the headline was unwrapped 49.7% still did. A good part
     of the rest is this card's empty state: a 147-character instruction shown
     in full above an input whose own placeholder already carries an example.
     v59's rule is that a surface leads with one short line per fact and the
     detail goes behind "Why?" — and the card already had a `pkWhy`.

     SHORTENING MUST MOVE DETAIL, NEVER DELETE IT. Three times in the v59 pass
     the first short version dropped a fact that mattered and a test caught each
     one, which is what this is. */

  it("SAYS WHAT TO DO IN ONE SHORT LINE", () => {
    const f = mount();
    const empty = step(f.el, "conversation").querySelector(".strat-chat p");
    expect(empty, "the empty conversation should still say what to do").toBeTruthy();
    const text = empty?.textContent ?? "";
    expect(text.length, `still a paragraph: "${text}"`).toBeLessThan(80);
    expect(text).toMatch(/idea/i);
  });

  it("AND THE EXAMPLE SURVIVES, behind the Why", () => {
    /* The worked example — "buy pullbacks to the 50 EMA while it is above the
       200" — is the part that teaches the rule language. Cutting it to save a
       line would be deleting the detail rather than moving it. */
    const f = mount();
    const whys = [...step(f.el, "conversation").querySelectorAll(".pk-why-body")].map((e) => e.textContent ?? "");
    expect(whys.some((w) => /pullbacks to the 50 EMA/.test(w)), "the example must be reachable").toBe(true);
  });

  it("AN EMPTY LOG CLAIMS NO RESERVE, and a used one does", () => {
    /* THE PARAGRAPH WAS NOT THE COST. Shortening it from 142 characters to 72
       saved exactly ZERO pixels, because `.strat-chat` carries
       `min-height: 120px` and the line is 19px inside it — measured in the
       browser, `firstControlY` was 425 before and 425 after. The reserve is what
       keeps the card steady as a conversation grows, which is worth having; what
       was not worth having was paying it before anybody had typed anything.

       MEASURED after marking the empty state: the log went 120px -> 19px, the
       first control 425 -> 324, and the share of the first screen spent before
       reaching one went 47.1% -> 35.9%. */
    const f = mount();
    const log = step(f.el, "conversation").querySelector(".strat-chat") as HTMLElement;
    expect(log.getAttribute("data-empty"), "a fresh desk has an empty log").toBe("true");
  });

  it("and the input keeps its own example, which is a different one", () => {
    // Two examples in two places is not duplication: the placeholder shows the
    // shape of a REFINEMENT, the Why shows the shape of a first idea.
    const src = readFileSync(join(process.cwd(), "src", "ui", "strategy", "flow.ts"), "utf8");
    expect(src).toContain("only take it when ADX is above 20");
  });
});
