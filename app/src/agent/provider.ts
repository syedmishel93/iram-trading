/**
 * Where the agent's reasoning comes from.
 *
 * FOUR PROVIDERS, ONE INTERFACE, AND THE DEFAULT IS NOT A MODEL
 *
 *  offline  — no language model at all. A deterministic analyst that picks
 *             tools from the question, runs them, and writes the answer from a
 *             template over the RESULTS. It cannot hallucinate because it never
 *             generates a number; it can only place one. It works with no key,
 *             no account, no network beyond the terminal's own sources, and it
 *             is the default for exactly that reason.
 *
 *  local    — the Python service's `/svc/analyst`, which is the same idea with
 *             a much better scoring model behind it. Deterministic, glass-box,
 *             and it never leaves the machine.
 *
 *  openai   — any OpenAI-compatible `/v1/chat/completions` endpoint. That is
 *             Ollama and LM Studio running on localhost as much as it is a
 *             hosted vendor, and the localhost case is the interesting one:
 *             full language understanding with nothing leaving the building.
 *
 *  anthropic— the Messages API.
 *
 * WHY THE KEY IS THE USER'S
 * There is no relay, no bundled key and no vendor account behind this build.
 * Your key goes to the endpoint you named and nowhere else. It lives in the KV
 * store under a name containing "credential", which is what makes the vault
 * exporter refuse to include it in a backup — see store/vault.ts.
 *
 * WHAT EVERY PROVIDER IS TOLD
 * The same system prompt, and it is short and absolute: state nothing you did
 * not fetch. The tools are the world. If a tool failed, say it failed.
 */

import type { ToolCall, ToolDef, ToolResult } from "./tools";
import { composeDeskNote, deskNoteFollowUp, DESK_NOTE_TOOLS, isDeskNoteQuestion } from "./desknote";

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * An image the model is being shown.
 *
 * Base64 rather than a URL, always. A URL would mean the vendor fetching the
 * picture itself, which cannot work for a canvas that exists only in this tab,
 * and would mean a second party learning what the operator is looking at even
 * when the model never reads it.
 */
export interface AgentImage {
  /** "image/png" or "image/jpeg". Both APIs accept those two. */
  readonly mediaType: string;
  /** Raw base64 — NO `data:` prefix. Anthropic rejects one, OpenAI needs it. */
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
  /** What it is a picture of, so the transcript is readable without opening it. */
  readonly caption: string;
}

export interface AgentMessage {
  readonly role: Role;
  readonly content: string;
  /**
   * Pictures attached to this turn. User turns only.
   *
   * NOT every provider can see them, and the ones that cannot must say so
   * rather than answering as if they had looked — a model asked "what does
   * this chart show" that never received the chart will describe a plausible
   * chart. `offline` and `local` are deterministic analysts with no vision at
   * all, so they refuse the question instead of guessing at it.
   */
  readonly images?: readonly AgentImage[];
  /** Assistant turns only. */
  readonly toolCalls?: readonly ToolCall[];
  /** Tool turns only — which call this is the result of. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  /**
   * The assistant turn exactly as the vendor returned it. Assistant turns only.
   *
   * Opaque to everything but the provider that wrote it, and replayed VERBATIM
   * on the next request. Anthropic requires this: a turn that carried
   * `thinking` blocks alongside `tool_use` must come back with those blocks
   * unchanged, signature and all, and rebuilding the turn from `content` and
   * `toolCalls` would drop them. Tagged with the provider so a conversation
   * that switches vendor mid-way never sends one vendor's blocks to another.
   */
  readonly providerContent?: ProviderContent;
}

export interface ProviderContent {
  readonly provider: string;
  readonly blocks: readonly unknown[];
}

/**
 * Why a turn ended somewhere other than an answer or a tool call.
 *
 *  refusal    — the model declined. Shown as a message; nothing it wrote is kept.
 *  max_tokens — the answer was cut off at the output limit. Shown, and said so.
 *  pause_turn — the vendor paused a long turn. The loop resends to continue.
 */
export interface ReplyStop {
  readonly kind: "refusal" | "max_tokens" | "pause_turn";
  readonly message: string;
}

export interface ProviderReply {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly providerContent?: ProviderContent;
  readonly stop?: ReplyStop;
}

/**
 * Called with each fragment of text as it arrives.
 *
 * Streaming is presentation, not semantics: the loop still waits for the whole
 * reply before running tools, because a half-parsed tool call is not a tool
 * call. What it changes is that a ten-second answer stops being ten seconds of
 * a pulsing dot. Providers that cannot stream simply never call this, and the
 * session handles both identically.
 */
export type OnDelta = (text: string) => void;

export interface Provider {
  readonly id: string;
  readonly label: string;
  /** One sentence: where does the conversation go? Rendered in the UI. */
  readonly privacy: string;
  /** False when configuration is missing; `reason` says what. */
  ready(): { ok: boolean; reason?: string };
  chat(
    messages: readonly AgentMessage[],
    tools: readonly ToolDef[],
    signal?: AbortSignal,
    onDelta?: OnDelta,
  ): Promise<ProviderReply>;
}

/**
 * Read a Server-Sent Events body, yielding each `data:` payload.
 *
 * Written by hand rather than with EventSource because EventSource cannot issue
 * a POST or set an authorization header, which rules it out for every one of
 * these APIs. The buffering matters: a chunk boundary lands mid-line often
 * enough that a naive split drops tokens, and the symptom — occasional missing
 * words — looks like a model quirk rather than a parser bug.
 */
const NEWLINE = String.fromCharCode(10);

export async function* sseLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf(NEWLINE);
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        nl = buffer.indexOf(NEWLINE);
      }
    }
  } finally {
    /* Releasing the lock lets an aborted request actually tear its socket down
       instead of holding it until garbage collection. */
    reader.releaseLock();
  }
}

/**
 * The system prompt: a senior desk analyst, held to the terminal's rules.
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * The old prompt forbade "typically" and "historically" outright, which also
 * forbade the model from knowing anything — what a liquidity sweep is, why a
 * walk-forward beats an in-sample fit. That knowledge is the reason to connect
 * a model at all. The line is now drawn where it actually matters: METHODOLOGY
 * is the model's to use and label as general principle; a MARKET FACT about
 * this instrument now comes from a tool or is not stated. The four
 * non-negotiables are unchanged in substance — tools are the world, odds are
 * probabilities with a basis, a refusal is relayed, and no order can be placed
 * because no tool exists that could.
 *
 * STABLE BYTES. The prompt is cached (see `anthropicProvider`), so it carries
 * nothing that varies per request — no date, no symbol, no settings. Anything
 * live arrives through a tool call.
 */
export const SYSTEM_PROMPT = `You are the trading expert inside the IRAM terminal: a senior desk analyst fluent in technical analysis (market structure, trend and mean-reversion regimes, volatility, SMC/ICT concepts such as liquidity sweeps, fair value gaps and order blocks, Wyckoff, classical patterns, multi-timeframe confluence), in fundamentals and macro (rates, inflation, central banks, the economic calendar, risk-on and risk-off, intermarket relationships, and for crypto the on-chain, funding and open-interest data where the tools provide it), in quantitative validation (walk-forward testing, overfitting, Monte Carlo, base rates) and in risk management (position sizing, R multiples, drawdown, correlation). You help the operator decide; the operator executes.

How you know things
- Methodology is yours to use freely: how a pattern is defined, what a regime implies for which strategies work, why a result needs out-of-sample evidence. Label it as general principle.
- Market facts about this instrument now — prices, levels, indicator values, probabilities, event dates — come only from tool calls in this conversation. You cannot see the screen and your memory of markets is out of date, so start with get_context and fetch before you state. If a tool fails or refuses, say so and what that leaves unanswered; never fill the gap from memory.
- Predictions are probabilities from the terminal's tools, stated with their basis: modelled or measured, sample size, calibration. Write "x% of simulated paths" or "a base rate of", never "will". A thin, in-sample or uncalibrated figure is reported as exactly that.
- You are decision support. No tool can place, modify or cancel an order. If asked to trade, say plainly that execution is the operator's.

When asked what to do
For "what should I do", "should I buy or sell", or a request for your view, call get_setup first, then what the answer needs: get_decision, get_outlook, get_setup_history, get_calendar, get_risk_state, and size_position with the plan's own entry and stop. Answer in this shape:
1. The call, in one line: Take the plan / Wait for <level or condition> / Stand aside. It follows get_setup's call and gates; if you disagree with the card, say that you do and why.
2. Market read: technical, then fundamental and macro.
3. Scenarios: bull, base and bear, with the shares of simulated paths get_outlook reports and their basis.
4. The plan: entry zone, stop, targets, reward-to-risk beside its break-even rate, and the size from size_position. When a gate blocks, get_setup withholds the plan and so do you.
5. What would change the view.
6. Risks: scheduled events, open heat and correlation, thin or in-sample evidence.

When asked for a strategy
Propose a rule set in the terminal's rule language, run it with test_strategy, and report the out-of-sample result as it came back. A rule set that fails its gate is reported as failing, with the checks it failed. If you revise and retest, say how many versions you tried; each is another selection on the same bars. find_opportunities ranks setups across the market; its plans have not passed the operator's gates, so say so.

Style
Lead with the answer. Quote the numbers you fetched, with units. Be brief: the operator has the chart open. Relay the caveats the data carries and skip generic disclaimers.`;

/* ------------------------------------------------------------------ offline */

/** Keyword groups that select tools. Order is the order they are run in. */
const PLAN_RULES: readonly { readonly tool: string; readonly match: RegExp }[] = [
  { tool: "get_price_summary", match: /price|level|how much|moved?|change|range|high|low|worth/i },
  { tool: "get_indicators", match: /rsi|atr|indicator|momentum|overbought|oversold|volatil|ema|average/i },
  { tool: "list_structures", match: /structure|bos|choch|fvg|gap|order.?block|setup|pattern|break|level|zone/i },
  { tool: "get_higher_timeframes", match: /higher|htf|bigger picture|daily|weekly|context|confluence/i },
  { tool: "get_regime", match: /regime|state|trend|chop|environment|condition/i },
  { tool: "get_forecast", match: /forecast|predict|probabil|odds|next|likely|expect/i },
  { tool: "get_alerts", match: /alert|watch|notify|trigger/i },
  { tool: "get_calendar", match: /news|calendar|event|data release|fomc|cpi/i },
  { tool: "get_storage", match: /storage|disk|history|stored|retention|how much data/i },
  /**
   * Risk questions get the STATE, never a size.
   *
   * `size_position` needs an entry and a stop, and this provider has no
   * argument extraction — it fires tools with empty arguments. Guessing two
   * prices out of a sentence is exactly the brittle heuristic that must not
   * exist anywhere near a position size: mis-parse "stop 77000" as the entry
   * and the number that comes back is confidently, invisibly wrong. So the
   * offline analyst reports what your settings and book actually say and points
   * at the Risk desk, where you type the numbers yourself. A connected model,
   * which can extract arguments properly, still gets the full tool.
   */
  { tool: "get_risk_state", match: /risk|size|position|equity|heat|exposure|stop loss|how much can i/i },
  /* The Opportunities desk's pipeline, with its default reach. */
  { tool: "find_opportunities", match: /opportunit|best setups?|find (me )?(a |the )?(trade|setup)|what.?s moving/i },
  /**
   * Strategy questions get the terminal's own walk-forward, not a new rule.
   * Writing a rule set is generation, which this analyst does not do; the EMA
   * family study is the honest thing it can run, and the answer says so.
   */
  { tool: "run_backtest", match: /strateg|backtest/i },
];

/** Questions that deserve the full sweep rather than a keyword-picked subset. */
const BRIEFING = /brief|summar|overview|what.?s (going on|happening)|analy[sz]e|read|tell me about|status/i;

const BRIEFING_TOOLS = [
  "get_price_summary",
  "get_indicators",
  "list_structures",
  "get_higher_timeframes",
  "get_regime",
];

function planTools(question: string): string[] {
  /* "What should I do" gets the desk note's fixed sweep, not a keyword guess:
     the answer to that question is the Setup card's verdict, and no keyword in
     the sentence names it. */
  if (isDeskNoteQuestion(question)) return [...DESK_NOTE_TOOLS];
  const picked: string[] = ["get_context"];
  if (BRIEFING.test(question)) {
    picked.push(...BRIEFING_TOOLS);
    return picked;
  }
  for (const rule of PLAN_RULES) {
    if (rule.match.test(question)) picked.push(rule.tool);
  }
  /* A question that matched nothing still deserves the state of the chart —
     "get_context only" is a real answer, and it is an honest one. */
  return picked;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

function fmtNum(v: unknown, digits = 2): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/**
 * Compose the offline answer from tool results.
 *
 * Every sentence below is a template with a fetched value dropped into it.
 * There is no generation step, which is precisely why this provider can be the
 * default: its worst failure mode is being terse, not being wrong.
 */
function composeOffline(results: readonly { name: string; result: ToolResult }[]): string {
  const get = (name: string): ToolResult | undefined => results.find((r) => r.name === name)?.result;
  const lines: string[] = [];

  const ctx = get("get_context");
  if (ctx?.ok) {
    const d = asRecord(ctx.data);
    lines.push(
      `**${String(d["symbol"])} · ${String(d["timeframe"])}** — ${String(d["bars_loaded"])} bars from ${String(d["source"])}, ${String(d["freshness"])} (${String(d["data_age_seconds"])}s old).`,
    );
    if (d["freshness"] !== "live") lines.push(`_${String(d["freshness_note"])}_`);
  } else if (ctx) {
    lines.push(`Could not read the terminal state: ${ctx.error ?? "unknown error"}.`);
  }

  const price = get("get_price_summary");
  if (price?.ok) {
    const d = asRecord(price.data);
    const chg = d["change_pct_over_lookback"];
    const dir = typeof chg === "number" ? (chg >= 0 ? "up" : "down") : "";
    lines.push(
      `Last close **${fmtNum(d["last_close"], 4)}**, ${dir} ${fmtNum(chg)}% over the last ${String(d["lookback_bars"])} bars. Range ${fmtNum(d["range_low"], 4)} – ${fmtNum(d["range_high"], 4)}.`,
    );
  } else if (price) {
    lines.push(`Price summary unavailable: ${price.error ?? "unknown error"}.`);
  }

  const ind = get("get_indicators");
  if (ind?.ok) {
    const d = asRecord(ind.data);
    const rsi = typeof d["rsi_14"] === "number" ? d["rsi_14"] : NaN;
    const zone =
      rsi >= 70 ? "in the overbought band" : rsi <= 30 ? "in the oversold band" : "mid-range";
    lines.push(
      `RSI(14) **${fmtNum(rsi, 1)}** — ${zone}. ATR(14) ${fmtNum(d["atr_pct_of_price"])}% of price.`,
    );
    const c20 = d["ema_20"];
    const c50 = d["ema_50"];
    if (typeof c20 === "number" && typeof c50 === "number") {
      lines.push(
        `EMA20 ${fmtNum(c20, 4)} vs EMA50 ${fmtNum(c50, 4)} — ${c20 >= c50 ? "fast above slow" : "fast below slow"}.`,
      );
    }
  } else if (ind) {
    lines.push(`Indicators unavailable: ${ind.error ?? "unknown error"}.`);
  }

  const structures = get("list_structures");
  if (structures?.ok) {
    const d = asRecord(structures.data);
    const list = Array.isArray(d["structures"]) ? (d["structures"] as Record<string, unknown>[]) : [];
    if (list.length === 0) {
      lines.push("The detectors found no structures on this series.");
    } else {
      lines.push(`**${list.length} structure${list.length === 1 ? "" : "s"}** detected, most recent first:`);
      for (const s of list.slice(-5).reverse()) {
        lines.push(`- ${String(s["label"])} (${fmtNum(s["confidence"], 2)}) — ${String(s["reason"])}`);
      }
    }
  }

  const htf = get("get_higher_timeframes");
  if (htf?.ok) {
    const d = asRecord(htf.data);
    if (d["enabled"] !== true) {
      lines.push(
        "No higher timeframes are enabled. That is an **absence** of higher-timeframe information, not a neutral reading.",
      );
    } else {
      const rows = Array.isArray(d["timeframes"]) ? (d["timeframes"] as Record<string, unknown>[]) : [];
      lines.push(
        `Higher timeframes: ${rows.map((r) => `${String(r["timeframe"])} ${String(r["bias"])}`).join(", ")}.`,
      );
    }
  }

  const regime = get("get_regime");
  if (regime?.ok) {
    const d = asRecord(regime.data);
    lines.push(
      `Regime model: **${String(d["state"])}** at ${fmtNum(Number(d["confidence"] ?? 0) * 100, 0)}% confidence. It is a 3-state Gaussian mixture, not a hidden Markov model.`,
    );
  } else if (regime) {
    lines.push(`Regime model unavailable: ${regime.error ?? "unknown error"}.`);
  }

  const forecast = get("get_forecast");
  if (forecast?.ok) {
    const d = asRecord(forecast.data);
    if (d["usable_as_signal"] === true) {
      lines.push(
        `Classifier: p(up) **${fmtNum(Number(d["p_up"] ?? 0) * 100, 1)}%**. ${String(d["standing"])}`,
      );
    } else {
      lines.push(
        `Classifier returned a probability, but it is **not usable as a signal**: ${String(d["standing"])} The number is withheld deliberately.`,
      );
    }
  } else if (forecast) {
    lines.push(`Forecast unavailable: ${forecast.error ?? "unknown error"}.`);
  }

  const alerts = get("get_alerts");
  if (alerts?.ok) {
    const d = asRecord(alerts.data);
    const list = Array.isArray(d["alerts"]) ? d["alerts"] : [];
    lines.push(list.length === 0 ? "No alerts are armed." : `${list.length} alert(s) in the book.`);
  }

  const cal = get("get_calendar");
  if (cal?.ok) {
    const d = asRecord(cal.data);
    const rows = Array.isArray(d["events"]) ? (d["events"] as Record<string, unknown>[]) : [];
    if (rows.length === 0) lines.push("No scheduled events returned by the calendar source.");
    else {
      lines.push("Scheduled ahead:");
      for (const e of rows.slice(0, 4)) {
        lines.push(`- ${String(e["when"])} — ${String(e["what"])} (${String(e["importance"])})`);
      }
    }
  }

  const risk = get("get_risk_state");
  if (risk?.ok) {
    const d = asRecord(risk.data);
    const guards = asRecord(d["guards"]);
    lines.push(
      `Risk settings: equity ${Number(d["equity"] ?? 0).toLocaleString()}, default ${fmtNum(d["defaultRiskPct"])}% per trade. Open heat **${fmtNum(d["heatPct"])}%** across ${String(d["openPositions"])} position(s), against your ${fmtNum(guards["maxHeatPct"])}% ceiling.`,
    );
    const unprotected = Array.isArray(d["unprotected"]) ? (d["unprotected"] as string[]) : [];
    if (unprotected.length > 0) {
      lines.push(
        `**${unprotected.join(", ")}** carr${unprotected.length === 1 ? "ies" : "y"} no stop, so that heat figure is a floor rather than the total.`,
      );
    }
    lines.push(
      "_To size a trade, use the Risk desk and enter the entry and stop yourself — I will not guess two prices out of a sentence._",
    );
  } else if (risk) {
    lines.push(`Risk state unavailable: ${risk.error ?? "unknown error"}.`);
  }

  const opp = get("find_opportunities");
  if (opp?.ok) {
    const d = asRecord(opp.data);
    const rows = Array.isArray(d["rows"]) ? (d["rows"] as Record<string, unknown>[]) : [];
    const failed = Array.isArray(d["failed"]) ? d["failed"].length : 0;
    lines.push(
      `**${String(d["with_setup"])} of ${String(d["scanned"])} symbols** have a setup on ${String(d["timeframe"])} (${String(d["universe"])})${failed > 0 ? `; ${failed} could not be scanned` : ""}.`,
    );
    for (const r of rows.slice(0, 8)) {
      const h = asRecord(r["history"]);
      lines.push(
        `- ${String(r["symbol"])} — ${String(r["setup"])} (${String(r["direction"])}), zone ${fmtNum(r["entry_low"], 4)} – ${fmtNum(r["entry_high"], 4)}, stop ${fmtNum(r["stop"], 4)}, target 1 ${fmtNum(r["target1"], 4)}, ${fmtNum(r["reward_to_risk_t1"])}R. Record: ${String(h["note"] ?? "none")}`,
      );
    }
    const caveats = Array.isArray(d["caveats"]) ? (d["caveats"] as unknown[]) : [];
    if (typeof caveats[1] === "string") lines.push(`_${caveats[1]}_`);
  } else if (opp) {
    lines.push(`The opportunity scan did not run: ${opp.error ?? "unknown error"}.`);
  }

  const bt = get("run_backtest");
  if (bt?.ok) {
    const d = asRecord(bt.data);
    /* A refused study ran nothing, so it has no PBO and no trades to quote —
       printing "PBO 0% over 0 trades" would read as a clean result. */
    const refused = d["standing"] === "refused";
    lines.push(
      `Walk-forward study of the **${String(d["family"])}** family on this chart: **${String(d["standing"])}** — ${String(d["verdict"])}. ${String(d["why"] ?? "")}` +
        (refused ? "" : ` Probability of backtest overfitting ${fmtNum(Number(d["pbo"] ?? NaN) * 100, 0)}% over ${String(d["trades"])} trades.`),
    );
    lines.push(
      "_Writing and testing a NEW rule set needs a connected language model (Settings); the offline analyst ran the terminal's own family study instead. The Playbook and Strategy desks let you build one by hand._",
    );
  } else if (bt) {
    lines.push(`The strategy study did not run: ${bt.error ?? "unknown error"}.`);
  }

  const storage = get("get_storage");
  if (storage?.ok) {
    const d = asRecord(storage.data);
    lines.push(
      `Archive: ${String(d["series"])} series, ${Number(d["bars"] ?? 0).toLocaleString()} bars. ${String(d["note"])}`,
    );
  }

  if (lines.length === 0) {
    return "I could not read anything about the current chart. The terminal may still be loading.";
  }

  lines.push("");
  lines.push(
    "_Composed from the tool results above by the offline analyst — no language model was consulted, and every figure is a fetched value. Connect a model in Settings for questions this cannot answer._",
  );
  return lines.join("\n");
}

/**
 * The deterministic analyst.
 *
 * Two-phase, driven by the same loop the model providers use: the first reply
 * asks for tools, the second composes the answer from what came back.
 */
export function offlineProvider(): Provider {
  return {
    id: "offline",
    label: "Offline analyst (no language model)",
    privacy: "Nothing leaves this machine. No language model is used.",
    ready: () => ({ ok: true }),

    chat(messages) {
      /* Only THIS question's tool results. Reading every tool message in the
         history made a second question answer itself instantly from the
         first question's results. */
      let lastUserAt = -1;
      messages.forEach((m, i) => {
        if (m.role === "user" && m.images === undefined) lastUserAt = i;
      });
      const lastUser = messages[lastUserAt];
      const current = messages.slice(lastUserAt + 1);
      const alreadyRan = current.some((m) => m.role === "tool");
      const deskNote = isDeskNoteQuestion(lastUser?.content ?? "");

      if (alreadyRan) {
        const results = current
          .filter((m) => m.role === "tool")
          .map((m) => {
            let parsed: ToolResult;
            try {
              parsed = JSON.parse(m.content) as ToolResult;
            } catch {
              parsed = { ok: false, error: "unreadable tool result" };
            }
            return { name: m.toolName ?? "", result: parsed };
          });
        /**
         * SIGHTLESS, AND IT SAYS SO.
         *
         * The offline analyst is a template over tool results — there is no
         * model here to look at anything. Without this it would compose a
         * perfectly ordinary answer from the numeric tools and never mention
         * that the picture it was handed went unread, which reads as though it
         * had looked. The one thing a sightless analyst must never do is stay
         * quiet about being sightless.
         */
        const sawImage = messages.some((m) => m.images !== undefined && m.images.length > 0);
        if (deskNote) {
          /* One follow-up round: size the card's own plan, from the prices
             get_setup returned. Then compose. */
          const more = deskNoteFollowUp(results);
          if (more.length > 0) return Promise.resolve({ text: "", toolCalls: more });
        }
        const body = deskNote ? composeDeskNote(results) : composeOffline(results);
        return Promise.resolve({
          text: sawImage
            ? `I cannot see images — this analyst has no language model behind it, so the chart picture went unread. Everything below is from the numbers.

${body}`
            : body,
          toolCalls: [],
        });
      }

      const plan = planTools(lastUser?.content ?? "");
      return Promise.resolve({
        text: "",
        toolCalls: plan.map((name, i) => ({ id: `offline-${i}`, name, args: {} })),
      });
    },
  };
}

/* ------------------------------------------------------ OpenAI-compatible */

export interface RemoteConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

function toOpenAITools(tools: readonly ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toOpenAIMessages(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    /* Images ride as content PARTS, and OpenAI wants a full data: URL where
       Anthropic wants the raw base64 — the one place the two APIs disagree
       about the same bytes. Text first: a picture with no question attached
       reads as "describe this", which is not what was asked. */
    if (m.role === "user" && m.images && m.images.length > 0) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...m.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Arguments arrive as a JSON STRING and may be malformed.
 *
 * A model that emits `{"symbol": "BTC` mid-token would otherwise throw inside
 * the loop and end the conversation. An empty object reaches the tool, the tool
 * says what was missing, and the model gets a chance to correct itself — which
 * is the behaviour you want from every layer of this.
 */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function openAICompatibleProvider(cfg: () => RemoteConfig): Provider {
  return {
    id: "openai",
    label: "OpenAI-compatible",
    privacy:
      "The conversation and the tool results are sent to the endpoint you configured. Point it at localhost (Ollama, LM Studio) to keep everything on this machine.",

    ready() {
      const c = cfg();
      if (!c.baseUrl) return { ok: false, reason: "No endpoint URL set." };
      if (!c.model) return { ok: false, reason: "No model name set." };
      /* A local runtime genuinely needs no key, so an empty key is only a
         problem for a host that requires one — and that host will say so. */
      return { ok: true };
    },

    async chat(messages, tools, signal, onDelta) {
      const c = cfg();
      const url = `${c.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (c.apiKey) headers["authorization"] = `Bearer ${c.apiKey}`;

      /* Only stream when somebody is listening. Without a delta handler the
         non-streaming path is simpler and its payload is easier to debug. */
      const wantStream = typeof onDelta === "function";

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: c.model,
          messages: toOpenAIMessages(messages),
          tools: toOpenAITools(tools),
          temperature: 0.2,
          ...(wantStream ? { stream: true } : {}),
        }),
        ...(signal ? { signal } : {}),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`);
      }

      if (wantStream) {
        /**
         * Reassemble the stream.
         *
         * Text arrives in fragments and so do TOOL CALLS: the name comes in one
         * delta and the arguments arrive across several more, keyed by `index`.
         * Concatenating arguments per index is the whole trick — treating each
         * delta as a complete call produces a list of fragments that parse to
         * nothing, which is exactly the failure mode that makes streaming
         * tool-use look broken.
         */
        let text = "";
        const partial = new Map<number, { id: string; name: string; args: string }>();

        for await (const payload of sseLines(res, signal)) {
          if (payload === "[DONE]") break;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            /* A malformed frame costs that fragment, not the answer. */
            continue;
          }
          const choice = asRecord((Array.isArray(frame["choices"]) ? frame["choices"] : [])[0]);
          const delta = asRecord(choice["delta"]);

          if (typeof delta["content"] === "string" && delta["content"].length > 0) {
            text += delta["content"];
            onDelta?.(delta["content"]);
          }

          const calls = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
          for (const raw of calls) {
            const r = asRecord(raw);
            const index = typeof r["index"] === "number" ? r["index"] : 0;
            const fn = asRecord(r["function"]);
            const cur = partial.get(index) ?? { id: "", name: "", args: "" };
            if (typeof r["id"] === "string" && r["id"]) cur.id = r["id"];
            if (typeof fn["name"] === "string" && fn["name"]) cur.name = fn["name"];
            if (typeof fn["arguments"] === "string") cur.args += fn["arguments"];
            partial.set(index, cur);
          }
        }

        return {
          text,
          toolCalls: [...partial.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, c2]) => ({
              id: c2.id || `call-${index}`,
              name: c2.name,
              args: parseArgs(c2.args),
            }))
            .filter((c2) => c2.name.length > 0),
        };
      }

      const json = (await res.json()) as Record<string, unknown>;
      const choices = Array.isArray(json["choices"]) ? json["choices"] : [];
      const message = asRecord(asRecord(choices[0])["message"]);
      const rawCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];

      return {
        text: typeof message["content"] === "string" ? message["content"] : "",
        toolCalls: rawCalls.map((raw, i) => {
          const r = asRecord(raw);
          const fn = asRecord(r["function"]);
          return {
            id: typeof r["id"] === "string" ? r["id"] : `call-${i}`,
            name: String(fn["name"] ?? ""),
            args: parseArgs(fn["arguments"]),
          };
        }),
      };
    },
  };
}

/* ------------------------------------------------------------- Anthropic */

/**
 * The model used when the saved one is not a Claude model.
 *
 * The model field is SHARED with the OpenAI-compatible provider and defaults
 * to a local model name ("llama3.1"), so reading it verbatim sent Anthropic a
 * model it does not serve. A saved `claude-*` name is always kept — that is the
 * operator's choice — and anything else resolves to this.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export function anthropicModel(saved: string): string {
  const m = saved.trim();
  return /^claude-/i.test(m) ? m : DEFAULT_ANTHROPIC_MODEL;
}

/** Output ceiling per turn. Streamed, so no HTTP timeout at this size. */
export const ANTHROPIC_MAX_TOKENS = 16000;

/** Server-side refusal fallback, `"default"` form. The header and the body go together. */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Block = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: Block[] };

/**
 * The conversation as Anthropic content blocks.
 *
 * Three rules, each one a 400 if broken:
 *  - An assistant turn the API produced is replayed VERBATIM from
 *    `providerContent` — thinking blocks, signatures and all. Never rebuilt,
 *    never edited.
 *  - Every `tool_use` is answered by a `tool_result` in the next user turn, and
 *    all the results of one turn travel in ONE user message (splitting them
 *    teaches the model to stop calling tools in parallel). A call that never
 *    ran — the operator pressed stop — is answered as an error rather than
 *    left dangling.
 *  - Roles alternate, starting with the user; consecutive user content merges.
 */
export function toAnthropicMessages(messages: readonly AgentMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const pushUser = (blocks: Block[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      let isError = false;
      try {
        isError = (JSON.parse(m.content) as { ok?: unknown }).ok === false;
      } catch {
        isError = true;
      }
      pushUser([
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
          ...(isError ? { is_error: true } : {}),
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      if (m.providerContent && m.providerContent.provider === "anthropic") {
        out.push({ role: "assistant", content: [...(m.providerContent.blocks as Block[])] });
        continue;
      }
      const blocks: Block[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      /* An empty assistant turn is a 400; it carried nothing, so it goes. */
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }
    /* user */
    if (m.images && m.images.length > 0) {
      /* Raw base64 in a `source` block — Anthropic REJECTS a data: URL, which
         is exactly what the OpenAI path builds from the same bytes. */
      pushUser([
        ...m.images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
        })),
        { type: "text", text: m.content },
      ]);
    } else {
      pushUser([{ type: "text", text: m.content }]);
    }
  }

  /* Answer any tool_use the next user turn does not. */
  for (let i = 0; i < out.length; i++) {
    const msg = out[i] as WireMessage;
    if (msg.role !== "assistant") continue;
    const ids = msg.content.filter((b) => b["type"] === "tool_use").map((b) => String(b["id"]));
    if (ids.length === 0) continue;
    let next = out[i + 1];
    if (!next || next.role !== "user") {
      next = { role: "user", content: [] };
      out.splice(i + 1, 0, next);
    }
    const answered = new Set(
      next.content.filter((b) => b["type"] === "tool_result").map((b) => String(b["tool_use_id"])),
    );
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length > 0) {
      next.content.unshift(
        ...missing.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: "This call was cancelled before it ran.",
          is_error: true,
        })),
      );
    }
  }
  return out;
}

/**
 * The request, as data. Exported so tests assert the literal body.
 *
 * CACHING. `tools` and `system` are byte-identical on every call — no
 * timestamp, no symbol, tool order fixed by `createToolset` — with a
 * breakpoint on the system block and on the LAST tool, so the whole stable
 * prefix is read from cache after the first question.
 */
export function buildAnthropicRequest(
  cfg: RemoteConfig,
  messages: readonly AgentMessage[],
  tools: readonly ToolDef[],
  stream: boolean,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const systemText = messages.find((m) => m.role === "system")?.content ?? SYSTEM_PROMPT;
  const last = tools.length - 1;
  return {
    url: `${base}/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      /* Without this header the browser request is refused outright. It is
         named "dangerous" because it puts a key in a page; here the key is the
         user's own and goes only to the vendor they chose. */
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": ANTHROPIC_FALLBACK_BETA,
    },
    body: {
      model: anthropicModel(cfg.model),
      max_tokens: ANTHROPIC_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      tools: tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        /* Streamed tool input arrives as it is generated rather than in one
           burst; the price is that the API no longer validates it, which is
           why every input is JSON.parse'd at block stop and a failure goes
           back to the model as an error result. */
        ...(stream ? { eager_input_streaming: true } : {}),
        ...(i === last ? { cache_control: { type: "ephemeral" } } : {}),
      })),
      messages: toAnthropicMessages(messages),
      /* On a safety decline the API re-runs the request on the fallback model
         it recommends for that category, inside the same call. */
      fallbacks: "default",
      ...(stream ? { stream: true } : {}),
    },
  };
}

/** The error a refused HTTP call becomes: status, then the vendor's own message. */
async function httpError(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 300);
  try {
    const msg = asRecord(asRecord(JSON.parse(raw) as unknown)["error"])["message"];
    if (typeof msg === "string" && msg) detail = msg;
  } catch {
    /* Not JSON — keep the raw prefix. */
  }
  return new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Blocks + stop reason → the reply the session understands.
 *
 * A tool_use whose input could not be parsed carries `inputError`, and
 * `runTool` answers it without running anything.
 */
export function anthropicReply(
  blocks: readonly Block[],
  stopReason: string,
  stopDetails: Record<string, unknown> | null,
  inputErrors: ReadonlyMap<string, string> = new Map(),
): ProviderReply {
  let text = "";
  const calls: ToolCall[] = [];
  for (const b of blocks) {
    if (b["type"] === "text" && typeof b["text"] === "string") text += b["text"];
    else if (b["type"] === "tool_use") {
      const id = String(b["id"] ?? "");
      const err = inputErrors.get(id);
      calls.push({
        id,
        name: String(b["name"] ?? ""),
        args: asRecord(b["input"]),
        ...(err !== undefined ? { inputError: err } : {}),
      });
    }
  }

  if (stopReason === "refusal") {
    const cat = stopDetails && typeof stopDetails["category"] === "string" ? stopDetails["category"] : null;
    return {
      text: "",
      toolCalls: [],
      stop: {
        kind: "refusal",
        message: `Claude declined to answer this request${cat ? ` (category: ${cat})` : ""}, and no fallback model answered it either. Nothing it wrote is shown or kept. Rephrase the question, or ask about something else.`,
      },
    };
  }
  if (stopReason === "max_tokens") {
    /* Any tool call is incomplete, so none is run and the turn is kept as
       text only — replaying a tool_use with no result would be rejected. */
    return {
      text,
      toolCalls: [],
      stop: {
        kind: "max_tokens",
        message: `The answer was cut off at the ${ANTHROPIC_MAX_TOKENS.toLocaleString("en-US")}-token output limit. What is shown is incomplete; ask for the rest, or for a shorter answer.`,
      },
    };
  }
  const providerContent: ProviderContent = { provider: "anthropic", blocks: [...blocks] };
  if (stopReason === "pause_turn") {
    return {
      text,
      toolCalls: [],
      providerContent,
      stop: { kind: "pause_turn", message: "The model paused a long turn; continuing it." },
    };
  }
  return { text, toolCalls: calls, providerContent };
}

/**
 * Reassemble a streamed message into its content blocks.
 *
 * Text is forwarded to `onDelta` as it arrives. Thinking and signature deltas
 * are accumulated into their block untouched, because the block is replayed
 * byte-for-byte on the next request. A tool_use's input arrives as fragments
 * of JSON (`input_json_delta`) and is parsed once, at the block's stop.
 */
export async function readAnthropicStream(
  res: Response,
  signal: AbortSignal | undefined,
  onDelta: OnDelta | undefined,
): Promise<ProviderReply> {
  const blocks: Block[] = [];
  const json = new Map<number, string>();
  const inputErrors = new Map<string, string>();
  let stopReason = "";
  let stopDetails: Record<string, unknown> | null = null;

  for await (const payload of sseLines(res, signal)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev["type"];
    const index = typeof ev["index"] === "number" ? ev["index"] : -1;
    if (type === "content_block_start") {
      const block = { ...asRecord(ev["content_block"]) };
      blocks[index] = block;
      if (block["type"] === "tool_use") json.set(index, "");
    } else if (type === "content_block_delta") {
      const b = blocks[index];
      const d = asRecord(ev["delta"]);
      if (!b) continue;
      if (d["type"] === "text_delta" && typeof d["text"] === "string") {
        b["text"] = String(b["text"] ?? "") + d["text"];
        onDelta?.(d["text"]);
      } else if (d["type"] === "input_json_delta" && typeof d["partial_json"] === "string") {
        json.set(index, (json.get(index) ?? "") + d["partial_json"]);
      } else if (d["type"] === "thinking_delta" && typeof d["thinking"] === "string") {
        b["thinking"] = String(b["thinking"] ?? "") + d["thinking"];
      } else if (d["type"] === "signature_delta" && typeof d["signature"] === "string") {
        b["signature"] = d["signature"];
      } else if (d["type"] === "citations_delta" && d["citation"] !== undefined) {
        b["citations"] = [...(Array.isArray(b["citations"]) ? b["citations"] : []), d["citation"]];
      }
    } else if (type === "content_block_stop") {
      const b = blocks[index];
      if (b && b["type"] === "tool_use") {
        const raw = json.get(index) ?? "";
        try {
          const parsed = raw.trim() === "" ? {} : (JSON.parse(raw) as unknown);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("the input is not a JSON object");
          }
          b["input"] = parsed;
        } catch (err) {
          b["input"] = {};
          inputErrors.set(String(b["id"] ?? ""), err instanceof Error ? err.message : "invalid JSON");
        }
      }
    } else if (type === "message_delta") {
      const d = asRecord(ev["delta"]);
      if (typeof d["stop_reason"] === "string") stopReason = d["stop_reason"];
      const details = d["stop_details"] ?? ev["stop_details"];
      if (details !== null && typeof details === "object") stopDetails = details as Record<string, unknown>;
    } else if (type === "error") {
      const e = asRecord(ev["error"]);
      throw new Error(`Anthropic stream error — ${String(e["message"] ?? e["type"] ?? "unknown")}`);
    } else if (type === "message_stop") {
      break;
    }
  }
  return anthropicReply(
    blocks.filter((b): b is Block => b !== undefined),
    stopReason,
    stopDetails,
    inputErrors,
  );
}

export function anthropicProvider(
  cfg: () => RemoteConfig,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Provider {
  return {
    id: "anthropic",
    get label() {
      return `Anthropic · ${anthropicModel(cfg().model)}`;
    },
    privacy: "The conversation and the tool results are sent to api.anthropic.com with your own key.",

    ready() {
      if (!cfg().apiKey) return { ok: false, reason: "No API key set." };
      return { ok: true };
    },

    async chat(messages, tools, signal, onDelta) {
      const stream = typeof onDelta === "function";
      const req = buildAnthropicRequest(cfg(), messages, tools, stream);
      const res = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw await httpError(res);
      if (stream) return readAnthropicStream(res, signal, onDelta);

      const json = asRecord((await res.json()) as unknown);
      const blocks = (Array.isArray(json["content"]) ? json["content"] : []).map((b: unknown) => ({ ...asRecord(b) }));
      const details = json["stop_details"];
      return anthropicReply(
        blocks,
        typeof json["stop_reason"] === "string" ? json["stop_reason"] : "",
        details !== null && typeof details === "object" ? (details as Record<string, unknown>) : null,
      );
    },
  };
}


/**
 * Reachability, as distinct from configuration.
 *
 * WHY THIS EXISTS. `ready()` answers "is this backend configured?" — it reads
 * settings and nothing else. It CANNOT answer "is this backend running?",
 * because the only way to know that is to try. The OpenAI-compatible provider
 * ships with a working default (a local Ollama URL and a model name), so
 * `ready()` says yes on a machine where nothing is listening on that port, and
 * the desk answered every question with a connection error.
 *
 * THE DISCRIMINATION THAT MATTERS. Not every failure means "unreachable", and
 * treating them alike would be worse than the bug:
 *
 *  - `TypeError` from fetch means the request never reached anything — wrong
 *    port, nothing listening, DNS gone, no network. There is a real answer
 *    available locally, so fall back and say so.
 *  - A thrown `Error` carrying an HTTP status means the endpoint IS there and
 *    REFUSED — a bad key, an unknown model, a server fault. Falling back here
 *    would hide a wrong API key behind plausible local answers, which is the
 *    worst outcome of the three. So it propagates, untouched.
 *  - `AbortError` is the user pressing stop. Not a failure at all.
 *
 * The fallback is per-call, never sticky: the next message tries the real
 * backend again, so starting the model server mid-session just works.
 */
export interface FallbackHooks {
  /** Called when a call fell through to the local analyst, with the reason. */
  onFallback(reason: string): void;
  /** Called when the primary answered, to clear a stale reason. */
  onPrimary(): void;
}

export function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  /* Cross-realm TypeErrors (a worker, a bundled polyfill) fail instanceof. */
  return err instanceof Error && err.name === "TypeError";
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function fallbackProvider(
  primary: () => Provider,
  fallback: Provider,
  hooks: FallbackHooks,
): Provider {
  /* Who answered the last call. The transcript labels an answer with this, so
     a reply the offline analyst wrote is not captioned with the name of the
     model that could not be reached. */
  let served: Provider | null = null;
  return {
    get id() {
      return primary().id;
    },
    get label() {
      return (served ?? primary()).label;
    },
    get privacy() {
      return primary().privacy;
    },
    ready() {
      /* Always ready: if the primary is not, the local analyst is. Reporting
         "not ready" here would block the desk from answering at all, which is
         the opposite of what the fallback is for. */
      return { ok: true };
    },
    async chat(messages, tools, signal, onDelta) {
      const p = primary();
      const state = p.ready();
      if (!state.ok) {
        hooks.onFallback(
          `${p.label} is not configured (${state.reason ?? "missing settings"}) — answering from the terminal's own data only.`,
        );
        served = fallback;
        return fallback.chat(messages, tools, signal, onDelta);
      }

      try {
        const reply = await p.chat(messages, tools, signal, onDelta);
        served = p;
        hooks.onPrimary();
        return reply;
      } catch (err) {
        if (isAbort(err)) throw err;
        if (!isTransportFailure(err)) {
          /* Reachable and refusing. The user must see this. */
          hooks.onPrimary();
          throw err;
        }
        hooks.onFallback(
          `${p.label} is not reachable — answering from the terminal's own data only. It will be tried again on the next message.`,
        );
        served = fallback;
        return fallback.chat(messages, tools, signal, onDelta);
      }
    },
  };
}
