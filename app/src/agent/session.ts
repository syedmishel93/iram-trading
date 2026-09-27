/**
 * The agent loop.
 *
 * Ask → the provider replies with either an answer or a list of tools it wants
 * → the tools run against live terminal state → the results go back → repeat
 * until it answers or runs out of steps.
 *
 * FOUR THINGS THIS GETS RIGHT
 *
 * 1. THE STEP CAP IS REAL AND IT IS ANNOUNCED. A model that keeps asking for
 *    tools forever is not thinking, it is stuck, and an uncapped loop over a
 *    metered API is somebody's bill. When the cap is hit the transcript says
 *    so — it does not quietly present the last partial thought as the answer.
 *
 * 2. CANCELLATION ACTUALLY CANCELS. One AbortController per ask, aborted on
 *    cancel and on a second ask. A request whose answer nobody wants must not
 *    be able to append to the transcript when it eventually lands.
 *
 * 3. A FAILED TOOL IS DATA, NOT AN EXCEPTION. It goes back to the model as a
 *    result saying what failed. The model can then say "the regime service is
 *    not running" — which is the correct answer — instead of the conversation
 *    ending in a red box.
 *
 * 4. THE TRANSCRIPT IS THE AUDIT. Every tool call and every result is a visible
 *    row, in order, before the answer that used them. That is the difference
 *    between an assistant you can check and one you have to trust.
 */

import { signal, type Signal } from "../core/signal";
import { runTool, type ToolCall, type ToolDef, type ToolResult } from "./tools";
import { SYSTEM_PROMPT, type AgentImage, type AgentMessage, type Provider } from "./provider";

export type TranscriptEntry =
  | { readonly kind: "user"; readonly at: number; readonly text: string }
  | { readonly kind: "assistant"; readonly at: number; readonly text: string; readonly provider: string }
  | {
      readonly kind: "tool";
      readonly at: number;
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly result: ToolResult;
      readonly mutates: boolean;
    }
  | { readonly kind: "error"; readonly at: number; readonly text: string }
  | { readonly kind: "note"; readonly at: number; readonly text: string };

export interface AgentSession {
  readonly transcript: Signal<readonly TranscriptEntry[]>;
  readonly busy: Signal<boolean>;
  /**
   * Text arriving from a streaming provider, before the turn completes.
   *
   * Kept OUT of the transcript on purpose: the transcript is the audit record
   * and must only ever contain finished turns. This is presentation, cleared
   * the moment the real entry lands.
   */
  readonly streaming: Signal<string>;
  ask(text: string): Promise<void>;
  cancel(): void;
  reset(): void;
  /** The raw message history, for debugging and for the vault. */
  history(): readonly AgentMessage[];
}

export interface SessionOptions {
  /** Read late, so switching provider mid-conversation works. */
  readonly provider: () => Provider;
  /** Read late, so tools can close over live signals. */
  readonly tools: () => readonly ToolDef[];
  /**
   * Tool rounds per question. Five is enough for context → data → answer with
   * two corrections; beyond that a model is looping, not working.
   */
  readonly maxSteps?: number;
  /**
   * Messages kept before trimming. Tool results are verbose and a long session
   * would otherwise grow the request until the provider rejects it outright.
   */
  readonly maxHistory?: number;
}

/* Eight: the expert's "what should I do" is context → setup, outlook, risk →
   size → answer, and a strategy request is propose → test → revise → retest.
   Five rounds cut the second off mid-revision. */
const DEFAULT_MAX_STEPS = 8;
/* Eighty: one expert answer is a dozen tool results, and forty messages
   trimmed the conversation on the second question. */
const DEFAULT_MAX_HISTORY = 80;

export function createAgentSession(opts: SessionOptions): AgentSession {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;

  const transcript = signal<readonly TranscriptEntry[]>([]);
  const busy = signal(false);
  const streaming = signal("");
  let messages: AgentMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  let controller: AbortController | null = null;

  const push = (entry: TranscriptEntry): void => {
    transcript.update((prev) => [...prev, entry]);
  };

  /**
   * Trim the middle, never the ends.
   *
   * The system prompt is the rules and the recent turns are the conversation;
   * what is safe to drop is the oldest exchanges. Dropping from the END would
   * remove the question being answered, and dropping the system prompt would
   * remove the only thing stopping the model inventing prices.
   */
  const trim = (): void => {
    if (messages.length <= maxHistory) return;
    const system = messages[0] as AgentMessage;
    const tail = messages.slice(messages.length - (maxHistory - 1));
    /**
     * A tool result whose originating assistant turn was trimmed away is an
     * orphan, and both APIs reject it. Drop leading tool messages until the
     * window starts on a clean turn.
     */
    /* And the window must open on a USER turn: an assistant turn first is a
       request Anthropic rejects, and one carrying tool calls would lose the
       results that answered them. */
    let start = 0;
    while (start < tail.length && tail[start]?.role !== "user") start++;
    messages = [system, ...tail.slice(start)];
  };

  async function step(signalObj: AbortSignal, provider: Provider): Promise<boolean> {
    const tools = opts.tools();

    streaming.set("");
    const reply = await provider.chat(messages, tools, signalObj, (delta) => {
      /* Aborted mid-stream: stop painting immediately rather than finishing the
         sentence of an answer nobody is waiting for. */
      if (signalObj.aborted) return;
      streaming.update((prev) => prev + delta);
    });
    streaming.set("");

    if (signalObj.aborted) return true;

    /* A refusal ends the turn with a message and KEEPS NOTHING the model
       wrote: a declined answer replayed as the model's own words would be
       read back to it as something it said. */
    if (reply.stop?.kind === "refusal") {
      push({ kind: "error", at: Date.now(), text: reply.stop.message });
      return true;
    }
    /* A paused turn is resent as it stands; the vendor continues it. */
    if (reply.stop?.kind === "pause_turn") {
      messages.push({
        role: "assistant",
        content: reply.text,
        ...(reply.providerContent ? { providerContent: reply.providerContent } : {}),
      });
      if (reply.text.trim().length > 0) {
        push({ kind: "assistant", at: Date.now(), provider: provider.label, text: reply.text.trim() });
      }
      return false;
    }

    if (reply.toolCalls.length === 0) {
      const text = reply.text.trim();
      push({
        kind: "assistant",
        at: Date.now(),
        provider: provider.label,
        text:
          text.length > 0
            ? text
            : "The model returned an empty answer. Nothing was fetched, so there is nothing to report.",
      });
      messages.push({
        role: "assistant",
        content: reply.text,
        ...(reply.providerContent ? { providerContent: reply.providerContent } : {}),
      });
      if (reply.stop?.kind === "max_tokens") {
        push({ kind: "note", at: Date.now(), text: reply.stop.message });
      }
      /* Trim here too. The tool branch below trims after its results land, but
         a conversation that never calls a tool would otherwise grow without
         bound until the provider rejected the request. */
      trim();
      return true;
    }

    messages.push({
      role: "assistant",
      content: reply.text,
      toolCalls: reply.toolCalls,
      /* Replayed verbatim on the next request — the thinking blocks that
         came with these tool calls must go back unchanged. */
      ...(reply.providerContent ? { providerContent: reply.providerContent } : {}),
    });
    /* Any prose the model emitted ALONGSIDE its tool calls is shown, because it
       is usually "let me check the higher timeframe first" and hiding it makes
       the pause look like a stall. */
    if (reply.text.trim().length > 0) {
      push({ kind: "assistant", at: Date.now(), provider: provider.label, text: reply.text.trim() });
    }

    for (const call of reply.toolCalls) {
      if (signalObj.aborted) return true;
      const result = await runTool(tools, call as ToolCall);
      const def = tools.find((t) => t.name === call.name);
      push({
        kind: "tool",
        at: Date.now(),
        name: call.name,
        args: call.args,
        result,
        mutates: def?.mutates === true,
      });
      /* The JSON result, always — it is what the transcript shows and what a
         sightless provider has to work from. `image` is stripped out of it:
         several hundred kilobytes of base64 inside a tool_result would be sent
         to the model as TEXT, which no vendor can decode as a picture and
         every vendor bills for. */
      const { image, ...payload } = result as ToolResult & { image?: AgentImage };
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(payload),
      });

      /**
       * The picture, as its own user turn.
       *
       * Neither API accepts an image inside a tool result in a way that works
       * on both, so it arrives as the next user message instead. The text
       * beside it matters: without it the model receives a bare image after a
       * tool call and treats it as a new request to describe something, losing
       * the question it was actually answering.
       */
      if (image !== undefined) {
        messages.push({
          role: "user",
          content: `The chart you asked to see: ${image.caption}. Answer the question I originally asked, using this picture together with whatever the numeric tools told you.`,
          images: [image],
        });
      }
    }

    trim();
    return false;
  }

  const session: AgentSession = {
    transcript,
    busy,
    streaming,

    history: () => messages.slice(),

    cancel() {
      controller?.abort();
      controller = null;
      busy.set(false);
      streaming.set("");
    },

    reset() {
      session.cancel();
      messages = [{ role: "system", content: SYSTEM_PROMPT }];
      transcript.set([]);
      streaming.set("");
    },

    async ask(text) {
      const question = text.trim();
      if (question.length === 0) return;

      /* A second question supersedes the first. Two loops appending to one
         transcript would interleave their tool calls into nonsense. */
      controller?.abort();
      const local = new AbortController();
      controller = local;

      const provider = opts.provider();
      const readiness = provider.ready();

      push({ kind: "user", at: Date.now(), text: question });

      if (!readiness.ok) {
        push({
          kind: "error",
          at: Date.now(),
          text: `${provider.label} is not configured — ${readiness.reason ?? "missing settings"}. Pick a provider in the agent's settings, or use the offline analyst, which needs nothing.`,
        });
        return;
      }

      messages.push({ role: "user", content: question });
      trim();
      busy.set(true);

      try {
        let done = false;
        let steps = 0;
        while (!done && steps < maxSteps) {
          if (local.signal.aborted) break;
          done = await step(local.signal, provider);
          steps++;
        }
        if (!done && !local.signal.aborted) {
          push({
            kind: "note",
            at: Date.now(),
            text: `Stopped after ${maxSteps} tool rounds without a final answer. Everything fetched is above; the reasoning did not converge.`,
          });
        }
      } catch (err) {
        if (local.signal.aborted) {
          push({ kind: "note", at: Date.now(), text: "Cancelled." });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          push({
            kind: "error",
            at: Date.now(),
            text: /failed to fetch|networkerror|load failed/i.test(msg)
              ? `Could not reach ${provider.label}. ${msg}`
              : msg,
          });
        }
      } finally {
        /* Only the CURRENT ask may clear the flag. A superseded loop finishing
           late would otherwise mark the terminal idle while the live one runs. */
        if (controller === local) {
          busy.set(false);
          controller = null;
        }
      }
    },
  };

  return session;
}
