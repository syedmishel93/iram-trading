/**
 * The Strategy workspace, "built together": describe → rules → backtest →
 * simulation + critique → your decision. Top to bottom, as the v5 design.
 *
 * WHAT EACH STEP REALLY IS
 *  - The conversation goes to the ANALYST SESSION (`agent/session.ts`), the
 *    same one the Analyst desk fronts. It is asked to draft one rule set and
 *    run it through its own `test_strategy` tool; the arguments of that call,
 *    read back through `parseRuleSpec`, are what become the AI's lines. Words
 *    are never parsed here — a desk that guessed rules from a sentence would
 *    be testing its guess.
 *  - The rules are `draft.ts`'s lines, each carrying its author.
 *  - The backtest is `backtest/draftrun.ts`: the engine, the walk-forward and
 *    the cost-stress run, on the archive's bars at YOUR costs.
 *  - The simulation is `backtest/montecarlo.ts` over the backtest's own
 *    trades, run only when asked. Until then it says "Not run yet" — the
 *    mock-up drew an illustrative curve here, and this does not.
 *  - The critique is `backtest/critique.ts`: measured numbers against named
 *    thresholds, from the real result.
 *  - The decision is recorded with the version it was about. A discard needs
 *    a reason, and the dropped versions stay listed with it.
 *
 * WHAT "PAPER TRADE IT" MEANS, AND WHAT IT DOES NOT
 * There is no execution path in this terminal, and the paper desk
 * (`trade/paper.ts`) is a hand-entered book with no rule runner. So paper
 * trading a rule set here is its FORWARD RECORD: the moment you choose it is
 * stored with the version, and every later backtest counts the trades the
 * rules entered after that moment — bars nobody had seen when the rules were
 * written. Nothing is sent anywhere, and the screen says so.
 */

import { computed, renderEffect, signal, type ReadSignal, type Signal } from "../../core/signal";
import { scheduleFrame } from "../../core/frame";
import { h, clear } from "../dom";
import { pkWhy } from "../panelkit";
import { createMiniChart, emptyNote } from "../minichart";
import type { KV } from "../../store/kv";
import type { AgentSession } from "../../agent/session";
import { parseRuleSpec } from "../../agent/rulespec";
import type { Costs } from "../../backtest/engine";
import { runDraft, type DraftRun } from "../../backtest/draftrun";
import { critique, COST_STRESS, type Critique } from "../../backtest/critique";
import { DEFAULT_RUIN, drawsFor, monteCarlo, type MonteCarloResult } from "../../backtest/montecarlo";
import { maxDrawdown } from "../../backtest/metrics";
import { COLUMNS, OPERATORS, type ColumnId, type Condition, type OperatorId, type RuleSpec } from "../../backtest/rules";
import type { LoadedBars, LoadHooks } from "./load";
import { paintDrawdownHistogram, paintEquity, PAD_LABELLED, utcMinute } from "./paint";
import {
  capped,
  CHAT_CAP,
  DECISION_CAP,
  DECISION_LABEL,
  emptyDraft,
  emptyFlow,
  FLOW_SLOT,
  LIBRARY_CAP,
  lineText,
  linesFromSpec,
  nextLineId,
  SECTION_LABEL,
  SECTIONS,
  similarRuns,
  specFromDraft,
  versionsTried,
  type Author,
  type ChatLine,
  type DecisionKind,
  type DecisionRecord,
  type Draft,
  type FlowState,
  type RuleLine,
  type RunSummary,
  type Section,
} from "./draft";

/** The desk's shared inputs. The family lab below reads the same signals. */
export interface FlowSettings {
  readonly spreadBp: Signal<number>;
  /** Financing per night held, in basis points. Zero is spot, which owns the asset. */
  readonly carryBp: Signal<number>;
  readonly commissionBp: Signal<number>;
  readonly slippageBp: Signal<number>;
  readonly riskPct: Signal<number>;
  readonly depth: Signal<number>;
}

export interface StrategyFlowOptions {
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  readonly settings: FlowSettings;
  /** Loads the desk's history — the same loader the family lab uses. */
  readonly load: (hooks: LoadHooks) => Promise<LoadedBars>;
  /** Where the draft, conversation, library and decisions persist. Absent: this session only, and the desk says so. */
  readonly kv?: KV;
  /** The analyst. Absent: no drafting from words, and the desk says so. */
  readonly session?: AgentSession;
  readonly now?: () => number;
}

export const costsOf = (s: FlowSettings): Costs => ({
  spread: s.spreadBp.peek() / 10_000,
  commission: s.commissionBp.peek() / 10_000,
  slippage: s.slippageBp.peek() / 10_000,
  carryPerNight: s.carryBp.peek() / 10_000,
});

/** A labelled number input bound to a signal. */
export function numField(label: string, sig: Signal<number>, unit: string, step = "1"): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label", text: label }),
    h("input", {
      class: "field-input num",
      type: "number",
      step,
      min: "0",
      value: () => String(sig()),
      oninput: (e: Event) => sig.set(Number((e.target as HTMLInputElement).value) || 0),
    }),
    h("span", { class: "field-hint", text: unit }),
  );
}

const sR = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const pct = (v: number, dp = 1): string => `${(v * 100).toFixed(dp)}%`;
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** One tag, the same class everywhere a card says who leads. */
export const whoTag = (who: "ai" | "you" | "both", text: string, title?: string): HTMLElement =>
  h("span", { class: "card-who", "data-who": who, text, ...(title ? { title } : {}) });

/** The prompt the analyst receives. Exported so a test can pin what it is asked. */
export function draftPrompt(idea: string, symbol: string, timeframe: string, current: RuleSpec | null, currentLines: readonly string[]): string {
  const rules = current
    ? JSON.stringify({
        name: current.name,
        long: current.long,
        short: current.short ?? [],
        exitLong: current.exitLong ?? [],
        exitShort: current.exitShort ?? [],
        stop: current.stop,
        target: current.target,
      })
    : currentLines.length > 0
      ? `(incomplete) ${currentLines.join("; ")}`
      : "none yet";
  return (
    `Strategy desk, ${symbol} ${timeframe}. Turn the operator's idea into ONE rule set in the terminal's rule language ` +
    "and run it with test_strategy. If the tool says it is invalid, fix it and call again. " +
    "If part of the idea cannot be written in the rule language (a session time, a news filter, anything with no column), " +
    "say plainly which part was left out — never replace it with a different condition without saying so. " +
    "Keep the operator's existing rules unless the idea changes them.\n" +
    `Current rules: ${rules}\n` +
    `The idea: ${idea}`
  );
}

export interface LastRun {
  readonly result: DraftRun;
  readonly symbol: string;
  readonly timeframe: string;
  readonly fingerprint: string;
  readonly loaded: LoadedBars;
  /** True when an identical earlier run was reused rather than recomputed. */
  readonly reused: boolean;
}

export function createStrategyFlow(opts: StrategyFlowOptions) {
  const now = opts.now ?? Date.now;
  const kv = opts.kv;
  const initial = kv ? kv.read(FLOW_SLOT).value : emptyFlow();
  const state = signal<FlowState>(initial);

  const save = (next: FlowState): void => {
    state.set(next);
    kv?.write(FLOW_SLOT, next);
  };
  const setDraft = (d: Draft): void => save({ ...state.peek(), draft: d });
  const say = (who: ChatLine["who"], text: string): void => {
    const s = state.peek();
    save({ ...s, chat: capped(s.chat, { who, text, at: now() }, CHAT_CAP) });
  };

  const draft = computed(() => state().draft);
  const parsed = computed(() => specFromDraft(draft()));
  /**
   * The draft as a spec NOW, for handlers.
   *
   * Not `parsed.peek()`: a computed settles on a microtask, so read straight
   * after `setDraft` it still holds the PREVIOUS draft. That is how the
   * analyst's first draft was found never to be tested — `test()` saw the
   * empty draft before it, refused, and the screen stayed on "Not run yet".
   * `parsed` stays for bindings, which re-render when it settles.
   */
  const parseNow = () => specFromDraft(state.peek().draft);
  const last = signal<LastRun | null>(null);
  const mc = signal<MonteCarloResult | null>(null);
  const testing = signal(false);
  const simulating = signal(false);
  const asking = signal(false);
  const progress = signal("");
  /** Identical rules on identical bars at identical costs: the run is reused, not recomputed. In memory only — trades are not stored. */
  const cache = new Map<string, DraftRun>();

  const currentFingerprint = (): string | null => {
    const p = parsed();
    return p.ok ? p.fingerprint : null;
  };
  /** The last run is about a different version of the rules than the one on screen. */
  const stale = computed(() => {
    const r = last();
    return r !== null && r.fingerprint !== currentFingerprint();
  });

  // ------------------------------------------------------------ backtest ---

  async function test(): Promise<void> {
    const p = parseNow();
    if (!p.ok || testing.peek()) return;
    testing.set(true);
    mc.set(null);
    progress.set("Loading your stored bars…");
    const symbol = opts.symbol.peek();
    const timeframe = opts.timeframe.peek();
    const costs = costsOf(opts.settings);
    const risk = opts.settings.riskPct.peek() / 100;
    try {
      const loaded = await opts.load({ progress: (t) => progress.set(t) });
      progress.set(loaded.note);
      if (loaded.bars.length === 0) {
        last.set({
          result: { ok: false, refused: "No bars could be loaded for this market, so nothing was tested." },
          symbol,
          timeframe,
          fingerprint: p.fingerprint,
          loaded,
          reused: false,
        });
        return;
      }
      /* Yield so "Testing…" paints before the run blocks the thread. Through
         `scheduleFrame`: a bare rAF never fires in a background tab. */
      await new Promise((r) => scheduleFrame(() => scheduleFrame(() => r(null))));
      const first = loaded.bars[0]?.t ?? 0;
      const lastT = loaded.bars[loaded.bars.length - 1]?.t ?? 0;
      const key = [p.fingerprint, symbol, timeframe, loaded.bars.length, first, lastT, costs.spread, costs.commission, costs.slippage, risk, loaded.coverage, loaded.demo].join("|");
      const hit = cache.get(key);
      const result =
        hit ??
        runDraft(p.spec, loaded.bars, { costs, riskPerTrade: risk, coverage: loaded.coverage, containsDemo: loaded.demo });
      if (!hit) cache.set(key, result);
      last.set({ result, symbol, timeframe, fingerprint: p.fingerprint, loaded, reused: hit !== undefined });
      if (result.ok && !hit) {
        const summary: RunSummary = {
          at: now(),
          fingerprint: p.fingerprint,
          name: p.spec.name,
          lines: state.peek().draft.lines.map(lineText),
          symbol,
          timeframe,
          bars: result.bars,
          trades: result.metrics.trades,
          expectancyR: result.metrics.expectancyR,
          oosExpectancyR: result.walk.folds.length > 0 ? result.walk.aggregate.expectancyR : null,
          oosTrades: result.walk.aggregate.trades,
        };
        const s = state.peek();
        save({ ...s, library: capped(s.library, summary, LIBRARY_CAP) });
      }
    } finally {
      testing.set(false);
    }
  }

  function simulate(): void {
    const r = last.peek();
    if (!r || !r.result.ok || r.result.trades.length === 0 || simulating.peek()) return;
    const run = r.result;
    simulating.set(true);
    scheduleFrame(() => {
      try {
        if (last.peek() !== r) return;
        mc.set(
          monteCarlo(
            run.trades.map((t) => t.rMultiple),
            run.riskPerTrade,
            { draws: drawsFor(run.trades.length), ruinDrawdown: DEFAULT_RUIN },
          ),
        );
      } finally {
        simulating.set(false);
      }
    });
  }

  const review = computed((): Critique | null => {
    const r = last();
    if (!r || !r.result.ok) return null;
    return critique({
      ...r.result,
      mc: mc(),
      versionsTried: Math.max(1, versionsTried(state().library, r.symbol, r.timeframe)),
    });
  });

  // -------------------------------------------------------- conversation ---

  async function send(text: string): Promise<void> {
    const idea = text.trim();
    if (idea === "" || asking.peek()) return;
    say("you", idea);
    const session = opts.session;
    if (!session) {
      say("note", "No analyst is connected to this desk, so nothing was drafted from those words. Write the rules yourself below.");
      return;
    }
    const p = parseNow();
    const prompt = draftPrompt(
      idea,
      opts.symbol.peek(),
      opts.timeframe.peek(),
      p.ok ? p.spec : null,
      state.peek().draft.lines.map(lineText),
    );
    asking.set(true);
    const start = session.transcript.peek().length;
    try {
      await session.ask(prompt);
    } finally {
      asking.set(false);
    }
    const all = session.transcript.peek();
    const fresh = all.length >= start ? all.slice(start) : all;

    let spec: RuleSpec | null = null;
    let problems: string[] = [];
    for (const e of fresh) {
      if (e.kind !== "tool" || e.name !== "test_strategy") continue;
      const got = parseRuleSpec(e.args);
      if (got.ok) {
        spec = got.spec;
        problems = [];
      } else {
        problems = got.problems.map((q) => `${q.where}: ${q.message}`);
      }
    }
    const answer = [...fresh].reverse().find((e) => e.kind === "assistant");
    const failed = [...fresh].reverse().find((e) => e.kind === "error");
    if (answer && answer.kind === "assistant") say("ai", answer.text);
    else if (failed && failed.kind === "error") say("note", failed.text);

    if (spec === null) {
      say(
        "note",
        problems.length > 0
          ? `The analyst's last rule set could not be read, so the rules did not change: ${problems.join(" | ")}`
          : "No rule set came back that this desk could read, so the rules did not change. (The offline analyst has no language model and cannot turn words into rules.)",
      );
      return;
    }
    const d = state.peek().draft;
    const lines = linesFromSpec(spec, "ai", d.lines);
    const kept = lines.filter((l) => l.author === "you").length;
    setDraft({ ...d, name: d.name.trim() || spec.name, lines });
    say(
      "note",
      `Drafted ${lines.length} rules${kept > 0 ? `; ${kept} of yours kept as they were` : ""}. Testing on your stored bars.`,
    );
    void test();
  }

  // ---------------------------------------------------------------- rules ---

  const editLine = (id: string, next: (l: RuleLine) => RuleLine): void => {
    const d = state.peek().draft;
    setDraft({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...next(l), author: "you" as Author } : l)) });
  };
  const removeLine = (id: string): void => {
    const d = state.peek().draft;
    setDraft({ ...d, lines: d.lines.filter((l) => l.id !== id) });
  };
  const addLine = (make: (id: string) => RuleLine): void => {
    const d = state.peek().draft;
    setDraft({ ...d, lines: [...d.lines, make(nextLineId(d.lines))] });
  };

  const select = <T extends string>(value: T, options: readonly (readonly [T, string])[], onPick: (v: T) => void, label: string): HTMLElement =>
    h(
      "select",
      {
        class: "field-input strat-sel",
        "aria-label": label,
        onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value as T),
      },
      ...options.map(([v, text]) => h("option", { value: v, text, selected: v === value })),
    );

  const numInput = (value: number, onCommit: (v: number) => void, label: string): HTMLElement =>
    h("input", {
      class: "field-input num strat-num",
      type: "number",
      step: "0.1",
      min: "0",
      value: String(value),
      "aria-label": label,
      onchange: (e: Event) => onCommit(Number((e.target as HTMLInputElement).value)),
    });

  const COLUMN_OPTS = (Object.keys(COLUMNS) as ColumnId[]).map((id) => [id, COLUMNS[id]] as const);
  const OPERATOR_OPTS = (Object.keys(OPERATORS) as OperatorId[]).map((id) => [id, OPERATORS[id]] as const);
  const SECTION_OPTS = SECTIONS.map((s) => [s, SECTION_LABEL[s]] as const);

  const ruleRow = (l: RuleLine): HTMLElement => {
    const controls: HTMLElement[] = [];
    if (l.kind === "cond") {
      controls.push(
        select<Section>(l.section, SECTION_OPTS, (v) => editLine(l.id, (x) => (x.kind === "cond" ? { ...x, section: v } : x)), "When"),
        select<ColumnId>(l.cond[0], COLUMN_OPTS, (v) => editLine(l.id, (x) => (x.kind === "cond" ? { ...x, cond: [v, x.cond[1], x.cond[2]] as Condition } : x)), "Indicator"),
        select<OperatorId>(l.cond[1], OPERATOR_OPTS, (v) => editLine(l.id, (x) => (x.kind === "cond" ? { ...x, cond: [x.cond[0], v, x.cond[2]] as Condition } : x)), "Comparison"),
        h("input", {
          class: "field-input strat-operand",
          type: "text",
          value: String(l.cond[2]),
          placeholder: "a number or an indicator id",
          title: "Another indicator's id (for example ema50), or a number",
          "aria-label": "Value",
          onchange: (e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            editLine(l.id, (x) => (x.kind === "cond" ? { ...x, cond: [x.cond[0], x.cond[1], v] as Condition } : x));
          },
        }),
      );
    } else if (l.kind === "stop") {
      const v = l.stop.type === "atr" ? l.stop.mult : l.stop.value;
      controls.push(
        h("span", { class: "strat-rule-kind", text: "Stop" }),
        select<"atr" | "pct">(
          l.stop.type,
          [["atr", "× ATR(14) from entry"], ["pct", "% from entry"]],
          (t) => editLine(l.id, (x) => (x.kind === "stop" ? { ...x, stop: t === "atr" ? { type: "atr", mult: v } : { type: "pct", value: v } } : x)),
          "Stop type",
        ),
        numInput(v, (n) => editLine(l.id, (x) => (x.kind === "stop" ? { ...x, stop: x.stop.type === "atr" ? { type: "atr", mult: n } : { type: "pct", value: n } } : x)), "Stop size"),
      );
    } else {
      const v = l.target.type === "none" ? 0 : l.target.value;
      controls.push(
        h("span", { class: "strat-rule-kind", text: "Target" }),
        select<"rr" | "pct" | "none">(
          l.target.type,
          [["rr", "× the risk"], ["pct", "% from entry"], ["none", "exit rule only"]],
          (t) => editLine(l.id, (x) => (x.kind === "target" ? { ...x, target: t === "none" ? { type: "none" } : { type: t, value: v } } : x)),
          "Target type",
        ),
      );
      if (l.target.type !== "none") {
        controls.push(
          numInput(v, (n) => editLine(l.id, (x) => (x.kind === "target" && x.target.type !== "none" ? { ...x, target: { type: x.target.type, value: n } } : x)), "Target size"),
        );
      }
    }
    return h(
      "div",
      { class: "strat-rule", "data-author": l.author, "data-line": l.id },
      whoTag(l.author, l.author === "ai" ? "AI" : "You", l.author === "ai" ? "Drafted by the analyst" : "Written or edited by you"),
      h("div", { class: "strat-rule-ctl" }, ...controls),
      h("button", {
        class: "ghost-btn tiny strat-rule-x",
        type: "button",
        text: "✕",
        "aria-label": `Remove: ${lineText(l)}`,
        onclick: () => removeLine(l.id),
      }),
    );
  };

  const rulesList = h("div", { class: "strat-rules" });
  renderEffect(() => {
    const d = draft();
    clear(rulesList);
    if (d.lines.length === 0) {
      rulesList.appendChild(h("p", { class: "muted small", text: "No rules yet. Describe the idea, or add your own rule." }));
      return;
    }
    for (const l of d.lines) rulesList.appendChild(ruleRow(l));
  });

  const problemList = h("ul", { class: "strat-problems" });
  renderEffect(() => {
    const p = parsed();
    clear(problemList);
    if (p.ok || draft().lines.length === 0) return;
    for (const q of p.problems) problemList.appendChild(h("li", { text: q.message }));
  });

  const rulesCard = h(
    "section",
    { class: "panel strat-card", "data-step": "rules" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "The rules" }),
      h("span", { class: "strat-hint", text: "edit any line · the AI marks its own" }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("input", {
        class: "field-input strat-name",
        type: "text",
        placeholder: "Name this strategy",
        "aria-label": "Strategy name",
        value: () => draft().name,
        onchange: (e: Event) => setDraft({ ...state.peek().draft, name: (e.target as HTMLInputElement).value }),
      }),
      rulesList,
      problemList,
      h(
        "div",
        { class: "strat-add" },
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: "+ Add your rule",
          /* The value starts EMPTY: a threshold nobody typed would be tested
             as the operator's. The line refuses until it is filled in. */
          onclick: () => addLine((id) => ({ id, author: "you", kind: "cond", section: "long", cond: ["close", ">", ""] as unknown as Condition })),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: "+ Stop",
          "data-show": () => String(!draft().lines.some((l) => l.kind === "stop")),
          onclick: () => addLine((id) => ({ id, author: "you", kind: "stop", stop: { type: "atr", mult: 0 } })),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: "+ Target",
          "data-show": () => String(!draft().lines.some((l) => l.kind === "target")),
          onclick: () => addLine((id) => ({ id, author: "you", kind: "target", target: { type: "rr", value: 0 } })),
        }),
      ),
      pkWhy(
        "Each line is one condition, the stop or the target. Conditions in the same group must all hold on the same closed bar. " +
          "AI marks a line the analyst drafted; You marks a line you added or changed — editing an AI line makes it yours. " +
          "When the analyst redrafts, any line identical to one already here keeps its mark. " +
          "A new line starts with no value and a new stop or target with no size, so nothing is tested that you did not choose.",
        "Why?",
      ),
    ),
  );

  // --------------------------------------------------------- conversation ---

  const chatLog = h("div", { class: "strat-chat", role: "log", "aria-live": "polite" });
  renderEffect(() => {
    const chat = state().chat;
    clear(chatLog);
    if (chat.length === 0) {
      chatLog.appendChild(
        h("p", {
          class: "muted small",
          /* ONE SHORT LINE. The worked example moved into this card's own
             "Why?" — see below — rather than being cut: shortening must MOVE
             detail, never delete it. MEASURED on the Strategy desk, 53% of the
             first screen went before the first control, and this was 142
             characters of it, sitting above an input whose placeholder already
             carries an example of its own. */
          text: "Describe the idea in words. The analyst drafts it as rules and tests it.",
        }),
      );
      return;
    }
    for (const c of chat) {
      chatLog.appendChild(
        h(
          "div",
          { class: "strat-msg", "data-who": c.who },
          c.who === "note" ? null : whoTag(c.who, c.who === "ai" ? "AI" : "You"),
          h("p", { class: "strat-msg-text", text: c.text }),
        ),
      );
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  const idea = signal("");
  const ideaInput = h("input", {
    class: "field-input strat-idea",
    type: "text",
    placeholder: "e.g. only take it when ADX is above 20",
    "aria-label": "Describe the idea",
    value: () => idea(),
    oninput: (e: Event) => idea.set((e.target as HTMLInputElement).value),
    onkeydown: (e: Event) => {
      if ((e as KeyboardEvent).key === "Enter") {
        const v = idea.peek();
        idea.set("");
        void send(v);
      }
    },
  });

  const chatCard = h(
    "section",
    { class: "panel strat-card strat-chat-card", "data-step": "conversation" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "The conversation" }),
      whoTag("both", "Both"),
    ),
    h(
      "div",
      { class: "panel-body" },
      opts.session
        ? null
        : h("p", {
            class: "small strat-warn",
            text: "No analyst is connected to this desk, so words cannot become rules here. Write the rules yourself.",
          }),
      chatLog,
      h(
        "div",
        { class: "strat-send" },
        ideaInput,
        h("button", {
          class: "primary-btn",
          type: "button",
          disabled: () => asking() || idea().trim() === "",
          text: () => (asking() ? "Drafting…" : "Send"),
          onclick: () => {
            const v = idea.peek();
            idea.set("");
            void send(v);
          },
        }),
      ),
      pkWhy(
        /* THE WORKED EXAMPLE LEADS, because it is the part that teaches the
           rule language and it used to be the first thing on the card. */
        "For example: “buy pullbacks to the 50 EMA while it is above the 200”. " +
          "Your words go to the analyst you chose in its settings, with the rules currently here. It is asked to draft ONE rule set in the terminal's rule language and test it with its own tool; the rules it tested are what appear, marked AI. " +
          "A part of the idea the rule language cannot express — a session time, a news filter — is left out, and the analyst is told to say which. " +
          "The same exchange, tool calls included, is in the Analyst desk's transcript.",
        "Why?",
      ),
    ),
  );

  // ------------------------------------------------------------ backtest ---

  const resultLines = (): HTMLElement => {
    const r = last();
    if (!r) return h("p", { class: "strat-empty", text: "Not run yet." });
    if (!r.result.ok) return h("p", { class: "strat-refused", text: `Not run: ${r.result.refused}` });
    const run = r.result;
    const m = run.metrics;
    const wf = run.walk;
    const oos = wf.aggregate;
    return h(
      "div",
      { class: "strat-result" },
      h("p", {
        class: "strat-answer",
        text:
          m.trades === 0
            ? "The rules never traded on these bars."
            : `${m.trades} trades, ${sR(m.expectancyR)} a trade after costs.`,
      }),
      h("p", {
        class: "small",
        text:
          wf.folds.length > 0
            ? `On unseen data: ${oos.trades} trades, ${sR(oos.expectancyR)} a trade${Number.isFinite(wf.degradation) && m.expectancyR > 0 ? `, ${pct(wf.degradation, 0)} of the edge kept` : ""}.`
            : `On unseen data: not tested — ${wf.verdict}.`,
      }),
      h("p", {
        class: "muted small",
        text:
          `${run.bars} bars of ${r.symbol} ${r.timeframe} from ${r.loaded.source}, ${utcMinute(run.from)} to ${utcMinute(run.to)} · ` +
          `${pct(r.loaded.coverage)} covered · max drawdown ${pct(m.maxDrawdown)}` +
          (r.reused ? " · identical earlier run reused, nothing recomputed" : ""),
      }),
      pkWhy(
        () =>
          `In sample: the whole window, which the rules may have been written against. On unseen data: ${wf.folds.length} rolling walk-forward folds, each tested on the slice after its training slice, trades pooled. ` +
          `Costs: ${opts.settings.spreadBp.peek()}bp spread, ${opts.settings.commissionBp.peek()}bp commission a side, ${opts.settings.slippageBp.peek()}bp slippage, ${opts.settings.carryBp.peek()}bp a night held, at ${(run.riskPerTrade * 100).toFixed(1)}% risk a trade. ` +
          (run.promotion
            ? `The promotion gate: ${run.promotion.summary} Its overfitting-probability check needs a SET of candidates and cannot run on one rule set, so one rule set is never promoted on its own. `
            : "") +
          (run.full.warnings.length > 0 ? `Engine warnings: ${run.full.warnings.join(" ")}` : ""),
        "Why?",
      ),
    );
  };

  const similarList = h("div", { class: "strat-similar" });
  renderEffect(() => {
    const d = draft();
    const fp = currentFingerprint();
    const found = similarRuns(state().library, d.lines.map(lineText), fp);
    clear(similarList);
    if (found.length === 0) {
      similarList.appendChild(h("p", { class: "muted small", text: "No earlier version in your library shares half its rules with this one." }));
      return;
    }
    similarList.appendChild(h("p", { class: "small strat-sub-head", text: "Earlier versions like this one" }));
    for (const { run, overlap: o } of found) {
      similarList.appendChild(
        h(
          "div",
          { class: "strat-similar-row" },
          h("span", { class: "strat-similar-name", text: run.name, title: run.lines.join("\n") }),
          h("span", { class: "num", text: `${pct(o, 0)} same` }),
          h("span", { class: "num", text: `${run.trades} trades · ${sR(run.expectancyR)}` }),
          h("span", {
            class: "num",
            text: run.oosExpectancyR === null ? "unseen: not tested" : `unseen: ${sR(run.oosExpectancyR)} (${run.oosTrades})`,
          }),
          h("span", { class: "muted", text: `${run.symbol} ${run.timeframe} · ${day(run.at)}` }),
        ),
      );
    }
  });

  const s = opts.settings;
  const backtestCard = h(
    "section",
    { class: "panel strat-card", "data-step": "backtest" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Backtest on your stored data" }),
      whoTag("both", "you pick · AI reuses"),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", { class: "small", text: () => `${opts.symbol()} · ${opts.timeframe()} — the market on the chart, from the local archive.` }),
      h(
        "div",
        { class: "cost-grid" },
        numField("History", s.depth, "bars", "500"),
        numField("Spread", s.spreadBp, "bp"),
        numField("Carry a night", s.carryBp, "bp"),
        numField("Commission", s.commissionBp, "bp / side"),
        numField("Slippage", s.slippageBp, "bp"),
        numField("Risk", s.riskPct, "% / trade", "0.1"),
      ),
      h(
        "div",
        { class: "strat-actions" },
        h("button", {
          class: "primary-btn",
          type: "button",
          disabled: () => testing() || !parsed().ok,
          text: () => (testing() ? "Testing…" : "Run backtest"),
          title: () => {
            const p = parsed();
            return p.ok ? "" : "Fix the rules first";
          },
          onclick: () => void test(),
        }),
        h("span", { class: "muted small", "data-show": () => String(progress() !== ""), text: () => progress() }),
      ),
      h("p", {
        class: "small strat-warn",
        "data-show": () => String(stale()),
        text: "The rules changed since this backtest. Run it again before reading the result.",
      }),
      h("div", {}, () => resultLines()),
      similarList,
      h("p", {
        class: "muted small",
        text: "Earlier versions that share rules with this one are listed with their results. An identical re-run on the same bars is reused, not recomputed; any change is recomputed in full. Versions you dropped are kept below, with your reason.",
      }),
    ),
  );

  // ---------------------------------------------------------- simulation ---

  const equityChart = createMiniChart(
    {
      height: 110,
      label: "The backtest's equity curve, in sample, after costs, in multiples of starting capital",
      paint: (f) => {
        const r = last.peek();
        if (!r || !r.result.ok) {
          emptyNote(f, "not run yet");
          return null;
        }
        return paintEquity(f, r.result.full.equity, null);
      },
    },
    "height:110px",
  );
  renderEffect(() => {
    last();
    equityChart.repaint();
  });

  const ddChart = createMiniChart(
    {
      height: 70,
      label: "Histogram of simulated worst drawdowns, with the backtest's own and the ruin level marked",
      pad: PAD_LABELLED,
      paint: (f) => {
        const r = mc.peek();
        const run = last.peek();
        if (!r || r.refused !== null || !run || !run.result.ok) {
          emptyNote(f, "not run yet");
          return null;
        }
        return paintDrawdownHistogram(f, r.drawdowns, maxDrawdown(run.result.full.equity), r.ruinDrawdown);
      },
    },
    "height:70px",
  );
  renderEffect(() => {
    mc();
    last();
    ddChart.repaint();
  });

  const simText = (): string => {
    const r = mc();
    const run = last();
    if (!run || !run.result.ok) return "Not run yet — run the backtest first; the simulation reorders its trades.";
    if (run.result.trades.length === 0) return "Not run — the backtest took no trades.";
    if (!r) return "Not run yet.";
    if (r.refused !== null) return `Not simulated: ${r.refused}.`;
    return (
      `${r.draws} reorderings of these ${r.trades} trades at ${pct(r.riskPerTrade)} risk: ` +
      `worst drawdown ${pct(r.maxDrawdown.p50)} typically, ${pct(r.maxDrawdown.p95)} in the worst 5%. ` +
      `${pct(r.ruinProbability)} fell ${pct(r.ruinDrawdown, 0)} or more.`
    );
  };

  const critiqueBody = h("div", { class: "strat-critique" });
  renderEffect(() => {
    const c = review();
    const r = last();
    clear(critiqueBody);
    if (!c) {
      critiqueBody.appendChild(
        h("p", {
          class: "strat-empty",
          text:
            r && !r.result.ok
              ? "Nothing to critique — the backtest did not run."
              : "Not run yet — the critique reads the backtest's result.",
        }),
      );
      return;
    }
    critiqueBody.appendChild(h("p", { class: "strat-critique-head", text: c.headline }));
    if (stale.peek()) {
      critiqueBody.appendChild(h("p", { class: "small strat-warn", text: "About the previous version of the rules." }));
    }
    const list = h("ul", { class: "strat-findings" });
    for (const f of c.findings) {
      list.appendChild(h("li", { class: "strat-finding", "data-check": f.id }, h("span", { text: f.text }), pkWhy(f.why, "Why?")));
    }
    if (c.findings.length > 0) critiqueBody.appendChild(list);
    critiqueBody.appendChild(
      h(
        "details",
        { class: "strat-checks" },
        h("summary", { text: `All ${c.checks.length} checks` }),
        ...c.checks.map((k) =>
          h(
            "div",
            { class: "strat-check", "data-passed": k.passed === null ? "na" : String(k.passed) },
            h("span", { class: "strat-check-mark", text: k.passed === null ? "–" : k.passed ? "✓" : "✗" }),
            h("span", { text: `${k.label}: ${k.text}` }),
          ),
        ),
      ),
    );
  });

  const simCard = h(
    "section",
    { class: "panel strat-card", "data-step": "simulation" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Simulation" }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        disabled: () => {
          const r = last();
          return simulating() || !r || !r.result.ok || r.result.trades.length === 0;
        },
        text: () => (simulating() ? "Simulating…" : "Run simulation"),
        onclick: () => simulate(),
      }),
    ),
    h(
      "div",
      { class: "panel-body strat-sim-grid" },
      h(
        "div",
        { class: "strat-sim" },
        equityChart.el,
        h("p", { class: "muted small", text: "The backtest's own curve — in sample, after costs. A description of the past, not a forecast." }),
        ddChart.el,
        h("p", { class: "small strat-sim-text", text: simText }),
        pkWhy(
          "The simulation redraws the backtest's own trades in random order, with replacement, and compounds each at your risk per trade. Bars: the worst drawdown of each path; solid line: the backtest's own; dashed: the ruin level. " +
            "It assumes trades are independent, so a rule whose losers cluster is riskier than this shows. It uses the same trades, never new ones — an edge that is not there is not rescued by reordering it.",
          "Why?",
        ),
      ),
      h(
        "div",
        { class: "panel strat-critique-card" },
        h(
          "header",
          { class: "panel-head" },
          h("h3", { class: "panel-title", text: "AI critique" }),
          whoTag("ai", "AI", "Computed by the terminal from the result — measured numbers against named limits"),
        ),
        critiqueBody,
        pkWhy(
          `Every line is one number from the backtest compared with one stated limit: sample size, whether it makes money after costs, whether it held on unseen data, whether it survives ${COST_STRESS}× your costs, whether a few trades carry it, drawdown against return, which market conditions it traded in, the simulated risk of ruin once simulated, and how many versions you have tried. A check that could not be measured says so instead of passing. No language model writes these.`,
          "Why?",
        ),
      ),
    ),
  );

  // ------------------------------------------------------------ decision ---

  const discarding = signal(false);
  const reason = signal("");
  const lastDecision = signal<DecisionRecord | null>(null);

  const decide = (kind: DecisionKind, why = ""): void => {
    const d = state.peek().draft;
    const p = parseNow();
    const fp = p.ok ? p.fingerprint : "";
    const lines = d.lines.map(lineText);
    const s0 = state.peek();
    const result = [...s0.library].reverse().find((r) => r.fingerprint === fp && fp !== "") ?? null;
    const rec: DecisionRecord = {
      at: now(),
      kind,
      name: d.name.trim() || (p.ok ? p.spec.name : "Untitled draft"),
      fingerprint: fp,
      lines,
      reason: why,
      symbol: opts.symbol.peek(),
      timeframe: opts.timeframe.peek(),
      result,
    };
    let nextDraft: Draft = d;
    if (kind === "paper" && fp !== "") nextDraft = { ...d, paper: { since: rec.at, fingerprint: fp } };
    if (kind === "discard") nextDraft = emptyDraft(`draft-${rec.at.toString(36)}`);
    save({ ...s0, draft: nextDraft, decisions: capped(s0.decisions, rec, DECISION_CAP) });
    lastDecision.set(rec);
    if (kind === "discard") {
      last.set(null);
      mc.set(null);
      say("note", `Dropped “${rec.name}”: ${why}`);
    }
    discarding.set(false);
    reason.set("");
  };

  const paperLine = (): string => {
    const d = draft();
    const pm = d.paper;
    if (!pm) return "";
    const since = utcMinute(pm.since);
    if (pm.fingerprint !== currentFingerprint()) {
      return `The rules changed after you started paper trading on ${since}; that record belongs to the earlier version.`;
    }
    const r = last();
    if (!r || !r.result.ok || r.fingerprint !== pm.fingerprint) {
      return `Paper trading since ${since}. Run the backtest on fresh bars to count the trades since then.`;
    }
    const after = r.result.trades.filter((t) => t.entryTime >= pm.since);
    if (after.length === 0) return `Paper trading since ${since}. No trades entered since then.`;
    const total = after.reduce((a, t) => a + t.rMultiple, 0);
    return `Paper trading since ${since}: ${after.length} trade${after.length === 1 ? "" : "s"} entered since, ${sR(total)} in total${after.length < 30 ? " — too few to read yet" : ""}.`;
  };

  const droppedList = h("div", { class: "strat-dropped" });
  renderEffect(() => {
    const dropped = state().decisions.filter((x) => x.kind === "discard").slice().reverse();
    clear(droppedList);
    if (dropped.length === 0) {
      droppedList.appendChild(h("p", { class: "muted small", text: "No versions dropped yet." }));
      return;
    }
    droppedList.appendChild(h("p", { class: "small strat-sub-head", text: `Versions you dropped (${dropped.length})` }));
    for (const x of dropped) {
      droppedList.appendChild(
        h(
          "details",
          { class: "strat-drop" },
          h(
            "summary",
            {},
            h("span", { class: "strat-drop-name", text: x.name }),
            h("span", { class: "strat-drop-why", text: x.reason }),
            h("span", { class: "muted", text: `${x.symbol} ${x.timeframe} · ${day(x.at)}` }),
          ),
          h(
            "ul",
            { class: "strat-drop-lines" },
            ...x.lines.map((t) => h("li", { text: t })),
            x.result
              ? h("li", {
                  class: "muted",
                  text: `Last backtest: ${x.result.trades} trades, ${sR(x.result.expectancyR)}${x.result.oosExpectancyR === null ? "" : `, unseen ${sR(x.result.oosExpectancyR)}`}.`,
                })
              : h("li", { class: "muted", text: "Never backtested." }),
          ),
        ),
      );
    }
  });

  const hasRules = (): boolean => draft().lines.length > 0;
  const decisionCard = h(
    "section",
    { class: "panel strat-card", "data-step": "decision" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Your decision" }),
      whoTag("you", "You"),
    ),
    h(
      "div",
      { class: "panel-body" },
      h(
        "div",
        { class: "strat-decide" },
        h("button", {
          class: "ghost-btn",
          type: "button",
          "data-decision": "iterate",
          disabled: () => !hasRules(),
          text: DECISION_LABEL.iterate,
          onclick: () => decide("iterate"),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          "data-decision": "paper",
          disabled: () => {
            const r = last();
            return !r || !r.result.ok || stale();
          },
          title: () => (last()?.result.ok && !stale() ? "" : "Run the backtest on these rules first"),
          text: DECISION_LABEL.paper,
          onclick: () => decide("paper"),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          "data-decision": "discard",
          disabled: () => !hasRules(),
          text: DECISION_LABEL.discard,
          onclick: () => discarding.set(!discarding.peek()),
        }),
      ),
      h(
        "div",
        { class: "strat-discard", "data-show": () => String(discarding()) },
        h("input", {
          class: "field-input",
          type: "text",
          placeholder: "Why drop it? (kept with the version)",
          "aria-label": "Reason for discarding",
          value: () => reason(),
          oninput: (e: Event) => reason.set((e.target as HTMLInputElement).value),
        }),
        h("button", {
          class: "primary-btn",
          type: "button",
          disabled: () => reason().trim() === "",
          text: "Drop this version",
          onclick: () => decide("discard", reason.peek().trim()),
        }),
      ),
      h("p", {
        class: "small",
        "data-show": () => String(lastDecision() !== null),
        text: () => {
          const x = lastDecision();
          if (!x) return "";
          return `Recorded: ${DECISION_LABEL[x.kind]} — “${x.name}”, ${utcMinute(x.at)}.`;
        },
      }),
      h("p", { class: "small", "data-show": () => String(paperLine() !== ""), text: paperLine }),
      droppedList,
      pkWhy(
        "Keep iterating records this version as a checkpoint. Paper trade it starts this version's forward record: nothing is sent to a broker or to the paper desk — this terminal cannot place orders — but every later backtest counts the trades the rules entered after that moment, on bars nobody had seen when the rules were written. Discard needs a reason; the version, its rules and its last result stay listed with it." +
          (kv ? "" : " Not saved: this desk was opened without storage, so all of this lasts only until the page reloads."),
        "Why?",
      ),
    ),
  );

  const el = h(
    "div",
    { class: "strat-flow-page" },
    h(
      "header",
      { class: "strat-head" },
      whoTag("both", "Built together"),
      h("h2", { class: "strat-title", text: "Describe the idea. The AI drafts, tests and critiques. You shape it." }),
    ),
    h(
      "div",
      { class: "strat-flow" },
      chatCard,
      h("div", { class: "strat-stack" }, rulesCard, backtestCard, simCard, decisionCard),
    ),
  );

  /**
   * Put a finished spec into the editor — "Open in Manual" from the Autonomous
   * mode and the Discovered shelf.
   *
   * Through `linesFromSpec`, so a line identical to one already on the desk
   * keeps ITS author: loading a discovered rule over the operator's own draft
   * must not re-stamp their rules as the terminal's. It does NOT test: the
   * point of opening one here is to read and change it first, and a backtest
   * the operator did not ask for would overwrite the result they were looking
   * at.
   */
  function loadSpec(spec: RuleSpec): void {
    const d = state.peek().draft;
    const lines = linesFromSpec(spec, "ai", d.lines);
    setDraft({ ...d, name: spec.name, lines, paper: null });
    last.set(null);
    mc.set(null);
    say("note", `Loaded “${spec.name}” into the editor. It has not been re-run here — press Run backtest to test it on the bars this desk loads.`);
  }

  return {
    el,
    /** For tests and for the shell's commands. */
    state: state as ReadSignal<FlowState>,
    last: last as ReadSignal<LastRun | null>,
    review,
    send,
    test,
    simulate,
    decide,
    loadSpec,
  };
}
