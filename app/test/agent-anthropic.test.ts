import { describe, it, expect } from "vitest";
import {
  anthropicModel,
  anthropicProvider,
  buildAnthropicRequest,
  toAnthropicMessages,
  SYSTEM_PROMPT,
  type AgentMessage,
} from "../src/agent/provider";
import { createAgentSession } from "../src/agent/session";
import type { ToolDef } from "../src/agent/tools";

/**
 * The Anthropic request, asserted as LITERAL wire data.
 *
 * Every expectation below is written out by hand — the model string, the
 * header value, where the cache breakpoints sit — never read back from the
 * module under test, because an expectation built from the same constant as
 * the request cannot fail when that constant is wrong.
 */

const TOOLS: ToolDef[] = [
  {
    name: "get_context",
    description: "state",
    parameters: { type: "object", properties: {} },
    run: () => ({ ok: true, summary: "BTCUSDT 1h", data: { symbol: "BTCUSDT" } }),
  },
  {
    name: "get_setup",
    description: "verdict",
    parameters: { type: "object", properties: {} },
    run: () => ({ ok: true, summary: "armed", data: { call: "armed" } }),
  },
];

const CFG = { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", model: "llama3.1" };

/** A Response whose body is these SSE events, one `data:` line each. */
function sse(events: readonly Record<string, unknown>[]): Response {
  const text = events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        /* Split mid-line on purpose: a chunk boundary inside a frame is the
           case the line buffer exists for. */
        c.enqueue(bytes.slice(0, 37));
        c.enqueue(bytes.slice(37));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const THINKING = { type: "thinking", thinking: "Check the verdict first.", signature: "sig-abc123" };

/** A turn: thinking, then a tool call, streamed in pieces. */
function toolTurn(input: string): Response {
  return sse([
    { type: "message_start", message: { id: "m1", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "verdict first." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc123" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "get_setup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input.slice(0, 1) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input.slice(1) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
}

function textTurn(text: string, stop = "end_turn", details: Record<string, unknown> | null = null): Response {
  return sse([
    { type: "message_start", message: { id: "m2", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, ...(details ? { stop_details: details } : {}) } },
    { type: "message_stop" },
  ]);
}

/** A fetch that answers from a script and records every request body. */
function scriptedFetch(replies: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (_url: string, init: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    headers.push(init.headers as Record<string, string>);
    const next = replies.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("script exhausted"));
  };
  return { fetchImpl, bodies, headers };
}

describe("the Anthropic request", () => {
  const req = buildAnthropicRequest(CFG, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "hi" }], TOOLS, true);

  it("asks for Claude Opus 5 with adaptive thinking at high effort", () => {
    expect(req.body["model"]).toBe("claude-opus-5");
    expect(req.body["thinking"]).toEqual({ type: "adaptive" });
    expect(req.body["output_config"]).toEqual({ effort: "high" });
    expect(req.body["max_tokens"]).toBe(16000);
    expect(req.body["stream"]).toBe(true);
  });

  it("opts into server-side refusal fallbacks, header and body together", () => {
    expect(req.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(req.body["fallbacks"]).toBe("default");
    /* Still required: the browser request is refused without it. */
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["x-api-key"]).toBe("sk-test");
  });

  it("caches the system prompt and the tools, with breakpoints in exactly two places", () => {
    const system = req.body["system"] as Record<string, unknown>[];
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    const tools = req.body["tools"] as Record<string, unknown>[];
    expect(tools.map((t) => t["cache_control"])).toEqual([undefined, { type: "ephemeral" }]);
    expect(tools[0]).toMatchObject({ name: "get_context", input_schema: { type: "object", properties: {} } });
    const messages = req.body["messages"] as { content: Record<string, unknown>[] }[];
    expect(JSON.stringify(messages)).not.toContain("cache_control");
  });

  it("keeps the stable prefix byte-identical across calls", () => {
    const later = buildAnthropicRequest(
      CFG,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and now?" },
      ],
      TOOLS,
      true,
    );
    expect(JSON.stringify(later.body["system"])).toBe(JSON.stringify(req.body["system"]));
    expect(JSON.stringify(later.body["tools"])).toBe(JSON.stringify(req.body["tools"]));
  });

  it("has no date or time in the system prompt to break the cache", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d|\d{1,2}:\d\d/);
  });
});

describe("the model setting", () => {
  it("replaces the shared local-model default with claude-opus-5", () => {
    expect(anthropicModel("llama3.1")).toBe("claude-opus-5");
    expect(anthropicModel("")).toBe("claude-opus-5");
  });
  it("keeps a Claude model the operator saved", () => {
    expect(anthropicModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(anthropicModel(" claude-opus-4-8 ")).toBe("claude-opus-4-8");
  });
});

describe("replaying a turn", () => {
  it("sends an assistant turn back exactly as the API returned it", () => {
    const blocks = [THINKING, { type: "tool_use", id: "tu_1", name: "get_setup", input: {} }];
    const wire = toAnthropicMessages([
      { role: "user", content: "what should I do?" },
      { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "get_setup", args: {} }], providerContent: { provider: "anthropic", blocks } },
      { role: "tool", toolCallId: "tu_1", toolName: "get_setup", content: '{"ok":true}' },
    ]);
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check the verdict first.", signature: "sig-abc123" },
        { type: "tool_use", id: "tu_1", name: "get_setup", input: {} },
      ],
    });
    expect(wire[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"ok":true}' }] });
  });

  it("puts every result of one turn in ONE user message, and marks a failed tool", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", args: {} }, { id: "b", name: "y", args: {} }] },
      { role: "tool", toolCallId: "a", content: '{"ok":true}' },
      { role: "tool", toolCallId: "b", content: '{"ok":false,"error":"down"}' },
    ];
    const wire = toAnthropicMessages(msgs);
    expect(wire).toHaveLength(3);
    expect(wire[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: '{"ok":true}' },
      { type: "tool_result", tool_use_id: "b", content: '{"ok":false,"error":"down"}', is_error: true },
    ]);
  });

  it("answers a tool call that was cancelled before it ran, instead of leaving it dangling", () => {
    const wire = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", args: {} }] },
      { role: "user", content: "never mind" },
    ]);
    expect(wire[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "a",
      content: "This call was cancelled before it ran.",
      is_error: true,
    });
    expect(wire[2]?.content[1]).toEqual({ type: "text", text: "never mind" });
  });

  it("never sends one vendor's blocks to another", () => {
    const wire = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "hello", providerContent: { provider: "openai", blocks: [{ type: "weird" }] } },
    ]);
    expect(wire[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });
});

describe("the Anthropic provider in the loop", () => {
  const build = (fetchImpl: (u: string, i: RequestInit) => Promise<Response>) =>
    createAgentSession({
      provider: () => anthropicProvider(() => CFG, fetchImpl),
      tools: () => TOOLS,
    });

  it("replays the thinking block unchanged on the request after a tool call", async () => {
    const { fetchImpl, bodies } = scriptedFetch([toolTurn("{}"), textTurn("Wait for the level.")]);
    const s = build(fetchImpl);
    await s.ask("What should I do now?");

    expect(bodies).toHaveLength(2);
    const second = bodies[1]?.["messages"] as { role: string; content: Record<string, unknown>[] }[];
    expect(second[0]).toEqual({ role: "user", content: [{ type: "text", text: "What should I do now?" }] });
    expect(second[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check the verdict first.", signature: "sig-abc123" },
        { type: "tool_use", id: "tu_1", name: "get_setup", input: {} },
      ],
    });
    expect(second[2]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    const answer = s.transcript().filter((e) => e.kind === "assistant");
    expect(answer.map((e) => (e as { text: string }).text)).toEqual(["Wait for the level."]);
  });

  it("does not run a tool whose streamed input is not valid JSON, and tells the model", async () => {
    let ran = 0;
    const tools: ToolDef[] = [{ ...TOOLS[1] as ToolDef, run: () => { ran++; return { ok: true }; } }];
    const { fetchImpl, bodies } = scriptedFetch([toolTurn('{"entry": 1'), textTurn("ok")]);
    const s = createAgentSession({ provider: () => anthropicProvider(() => CFG, fetchImpl), tools: () => tools });
    await s.ask("q");
    expect(ran).toBe(0);
    const second = bodies[1]?.["messages"] as { content: Record<string, unknown>[] }[];
    const result = second[2]?.content[0] as Record<string, unknown>;
    expect(result["is_error"]).toBe(true);
    expect(String(result["content"])).toContain("could not be read");
  });

  it("shows a refusal with its category and keeps nothing the model wrote", async () => {
    const { fetchImpl } = scriptedFetch([textTurn("partial", "refusal", { type: "refusal", category: "cyber" })]);
    const s = build(fetchImpl);
    await s.ask("q");
    const last = s.transcript()[s.transcript().length - 1];
    expect(last).toMatchObject({ kind: "error" });
    expect((last as { text: string }).text).toContain("(category: cyber)");
    expect(s.history().filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("says when an answer was cut off at the output limit", async () => {
    const { fetchImpl } = scriptedFetch([textTurn("The call is", "max_tokens")]);
    const s = build(fetchImpl);
    await s.ask("q");
    const kinds = s.transcript().map((e) => e.kind);
    expect(kinds).toEqual(["user", "assistant", "note"]);
    expect((s.transcript()[2] as { text: string }).text).toContain("cut off");
  });

  it("continues a paused turn by resending it", async () => {
    const paused = sse([
      { type: "message_start", message: { id: "m0", role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
      { type: "message_stop" },
    ]);
    const { fetchImpl, bodies } = scriptedFetch([paused, textTurn("done")]);
    const s = build(fetchImpl);
    await s.ask("q");
    expect(bodies).toHaveLength(2);
    const second = bodies[1]?.["messages"] as { role: string; content: unknown }[];
    expect(second[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Working" }] });
  });

  it("names the vendor's own message when the request is refused over HTTP", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
          status: 401,
          statusText: "Unauthorized",
        }),
      );
    const s = build(fetchImpl);
    await s.ask("q");
    const last = s.transcript()[s.transcript().length - 1] as { kind: string; text: string };
    expect(last.kind).toBe("error");
    expect(last.text).toBe("401 Unauthorized — invalid x-api-key");
  });
});
