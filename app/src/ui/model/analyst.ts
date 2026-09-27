/**
 * The analyst: which model answers, what it may reach, and the standing briefs.
 *
 * WHY IT IS ITS OWN FILE, AND WHY IT IS ONLY THREE SIBLINGS
 * Counted naively this section borrows TWENTY-TWO things from the rest of the
 * shell, which the repository's own extraction rule refuses outright. But
 * twenty-one of those twenty-two exist for one reason: assembling
 * `TerminalAccess`, the analyst's window on the terminal. That object is
 * deliberately built once, in `mountShell`, beside the signals it reads — a
 * second assembly at a second call site would be a second definition of what
 * the analyst can see, and the two would drift.
 *
 * So `terminalAccess` stays where it is and arrives here as ONE dependency.
 * The rest of the section — the provider stack, the fallback rules, the
 * session, the brief store and its watcher — borrows three things:
 * `terminalAccess`, the connection monitor, and the closed-bar count that
 * drives the watcher. That is the number the split is justified by.
 *
 * WHAT IS RETURNED, AND WHY AS ONE OBJECT
 * Twelve values are read from outside: the Settings desk configures the
 * provider, the Analyst desk drives the session, and dev inspection reads the
 * briefs. Returned as a single named `analyst` rather than twelve loose
 * bindings, because twelve loose names in the shell is the shape this file
 * exists to undo — the backlog's own verdict on the live bar was "eight
 * exports is not encapsulation".
 *
 * Not one comment in the moved text was rewritten. The notes on why the key
 * lives outside `prefs`, why the offline analyst is a floor rather than a
 * mode, why a brief runs in its own session and goes direct to the chosen
 * provider rather than the resilient wrapper, and why the watcher is driven by
 * closed bars were all written against this code.
 */

import { effect, signal, type ReadSignal } from "../../core/signal";
import { createAgentSession } from "../../agent/session";
import { canArm, createBriefStore, createBriefWatcher, type Brief } from "../../agent/brief";
import { createToolset, type TerminalAccess } from "../../agent/tools";
import {
  offlineProvider,
  fallbackProvider,
  openAICompatibleProvider,
  anthropicProvider,
  type Provider,
} from "../../agent/provider";
import type { createConnectionMonitor } from "../../core/connection";
import type { ShellContext } from "../shell/context";

/** What the analyst borrows from its siblings. Three. */
export interface AnalystModelDeps {
  /** Whether the machine has a network. Decides the offline floor. */
  readonly connection: ReturnType<typeof createConnectionMonitor>;
  /** Closed bars. The brief watcher ticks on these and never on a forming bar. */
  readonly closedBarCount: ReadSignal<number>;
  /** The analyst's window on the terminal — assembled once, in `mountShell`. */
  readonly terminalAccess: TerminalAccess;
}

/** Build the analyst. Return type inferred, per the extraction procedure. */
export function createAnalystModel(ctx: ShellContext, deps: AnalystModelDeps) {
  const { kv, prefs, state, feed, toaster } = ctx;
  const { connection, closedBarCount, terminalAccess } = deps;

  // -------------------------------------------------------------- agent ---

  /**
   * The analyst.
   *
   * Its window on the terminal is `TerminalAccess` — an interface of plain
   * accessors over the very signals the panels are reading. That is deliberate:
   * the agent cannot see anything the user cannot also see on screen, and it
   * cannot state a number it did not pull through one of these. See
   * agent/tools.ts for why that is the whole design rather than a precaution.
   */
  const agentProviderId = signal<string>((prefs["agentProvider"] as string) ?? "offline");
  const agentBaseUrl = signal<string>(
    (prefs["agentBaseUrl"] as string) ?? "http://localhost:11434/v1",
  );
  const agentModel = signal<string>((prefs["agentModel"] as string) ?? "llama3.1");

  /**
   * The key is NOT in `prefs`.
   *
   * It lives under its own KV slot whose name contains "credential", which is
   * what makes the vault exporter withhold it from a backup — see
   * store/vault.ts `looksSecret`. Putting it in the preferences blob would have
   * smuggled it into every export the user ever shared.
   */
  const AGENT_KEY_SLOT = {
    key: "agent.credential",
    version: 1,
    fallback: (): string => "",
    validate: (v: unknown): string | null => (typeof v === "string" ? v : null),
  };
  const agentApiKey = signal<string>(kv.read(AGENT_KEY_SLOT).value);
  effect(() => void kv.write(AGENT_KEY_SLOT, agentApiKey()));

  const remoteConfig = () => ({
    baseUrl: agentBaseUrl.peek(),
    apiKey: agentApiKey.peek(),
    model: agentModel.peek(),
  });

  /**
   * THE OFFLINE ANALYST IS NO LONGER A MODE YOU PICK.
   *
   * It used to sit in the provider dropdown as a peer of the model backends,
   * which meant a user could be running it without realising and wondering why
   * the answers were terse — and it meant "offline" was a setting you could
   * leave switched on while perfectly online.
   *
   * Now it is the FLOOR. `activeProvider()` reaches for it in exactly two
   * situations, both MEASURED rather than chosen: the machine has no network,
   * or the selected backend is not configured. The desk says which, so falling
   * back is never silent.
   */
  const offlineAnalyst = offlineProvider();

  const AGENT_PROVIDERS: Provider[] = [
    openAICompatibleProvider(remoteConfig),
    anthropicProvider(() => ({ ...remoteConfig(), baseUrl: "https://api.anthropic.com/v1" })),
  ];

  const chosenProvider = (): Provider =>
    AGENT_PROVIDERS.find((pv) => pv.id === agentProviderId()) ?? (AGENT_PROVIDERS[0] as Provider);

  /**
   * Why the analyst is answering the way it is. Empty when it is not.
   *
   * Two kinds of reason land here, and they differ in WHEN they are knowable:
   *
   *  - BEFORE a call: no network, or the backend is not configured. Both are
   *    readable from state, so the note is on screen before you type a word.
   *  - AFTER a call: the backend was configured but nothing was listening.
   *    That cannot be known without trying — the OpenAI-compatible provider
   *    ships with a working localhost DEFAULT, so `ready()` says yes on a
   *    machine where no model server is running. See fallbackProvider.
   */
  const reachabilityNote = signal("");

  const providerFallback = (): string => {
    if (!connection.online()) {
      return "No network — answering from the terminal's own data only. Nothing is being sent anywhere.";
    }
    const ready = chosenProvider().ready();
    if (!ready.ok) {
      return `${chosenProvider().label} is not configured (${ready.reason ?? "missing settings"}) — answering from the terminal's own data only.`;
    }
    return reachabilityNote();
  };

  /**
   * What the session actually calls.
   *
   * Offline, the local analyst is handed over directly — there is no point
   * attempting a request that cannot leave the machine. Online, the wrapper
   * tries the real backend and drops through ONLY on a transport failure. An
   * HTTP refusal still surfaces as an error, because hiding a wrong API key
   * behind a plausible local answer is worse than showing the error.
   */
  const resilientProvider = fallbackProvider(chosenProvider, offlineAnalyst, {
    onFallback: (reason) => reachabilityNote.set(reason),
    onPrimary: () => reachabilityNote.set(""),
  });

  const activeProvider = (): Provider =>
    connection.online() ? resilientProvider : offlineAnalyst;

  const agentSession = createAgentSession({
    provider: activeProvider,
    tools: () => createToolset(terminalAccess),
  });

  /**
   * Standing briefs — the analyst watching for something and saying so unasked.
   *
   * The only thing in this terminal that can spend the operator's money while
   * nobody is looking, so every guard is in `agent/brief.ts` and none of them
   * is here: armed by hand, floored at five minutes however fast the chart,
   * one check per closed bar, and firing disarms. This is only the wiring.
   */
  const BRIEFS_SLOT = {
    key: "agent.briefs",
    version: 1,
    fallback: (): Brief[] => [],
    validate: (v: unknown): Brief[] | null => (Array.isArray(v) ? (v as Brief[]) : null),
  };
  /* The last brief evaluation's transcript, kept for diagnosis. A feature
     that runs unattended is one whose failures nobody witnesses, so the raw
     turns have to be reachable after the fact. */
  let lastBriefTranscript: readonly import("../../agent/session").TranscriptEntry[] = [];
  const briefStore = createBriefStore();
  briefStore.briefs.set(kv.read(BRIEFS_SLOT).value);
  effect(() => void kv.write(BRIEFS_SLOT, briefStore.briefs() as Brief[]));

  /**
   * One definition of "may a brief run", asked by both the watcher and the desk.
   *
   * Declared here rather than inline in each so the button the operator sees and
   * the check that actually spends money cannot disagree — which they did, in
   * the first version, because one looked at the resilient wrapper's id and the
   * other at the provider behind it.
   */
  const briefsBlocked = (): string => {
    if (!connection.online()) {
      return "The terminal is offline, so the analyst is answering from its own data and cannot judge a brief.";
    }
    const pv = chosenProvider();
    const r = canArm(pv.id, pv.ready());
    return r.ok ? "" : r.reason;
  };

  const briefWatcher = createBriefWatcher({
    store: briefStore,
    blocked: briefsBlocked,
    /**
     * One evaluation, in its OWN session.
     *
     * Not the conversation's session: a brief check would otherwise appear in
     * the transcript the operator is reading, and its tool calls would become
     * context for their next question. A throwaway session reuses the whole
     * loop — step cap, cancellation, the image turn — rather than growing a
     * second implementation of it that could drift.
     */
    evaluate: async (b, prompt) => {
      const one = createAgentSession({
        /**
         * `chosenProvider`, NOT `activeProvider`.
         *
         * `activeProvider` is the resilient wrapper: when the endpoint is
         * unreachable it silently answers from the offline analyst instead.
         * That is right for a conversation — a degraded answer beats none —
         * and wrong here, because the offline analyst is a template and
         * whatever it produced would be parsed as a verdict on a condition it
         * never evaluated.
         *
         * Configuration cannot rule this out either: the OpenAI-compatible
         * provider defaults to a keyless Ollama on localhost, so it reports
         * itself ready whether or not anything is listening. Going direct
         * means an unreachable endpoint THROWS, and the watcher records
         * "Could not check" against the brief where the operator can see it.
         */
        provider: chosenProvider,
        tools: () => createToolset(terminalAccess),
      });
      await one.ask(
        `${prompt}

The condition to watch, on ${b.symbol} ${b.timeframe}:
${b.text}`,
      );
      /**
       * An ERROR in the transcript is not the same as an unreadable answer.
       *
       * The session catches provider failures and files them as `error`
       * entries rather than throwing, so without this the brief reported "the
       * analyst gave no readable answer" for a refused connection — true, and
       * useless. Measured with nothing listening on the Ollama port: the
       * operator saw a checked brief and no reason.
       *
       * Surfaced as a throw so the watcher's own handler writes it against the
       * brief with its "Could not check" prefix, in one place.
       */
      const entries = one.transcript();
      lastBriefTranscript = entries;
      const failed = [...entries].reverse().find((e) => e.kind === "error");
      const answer = [...entries].reverse().find((e) => e.kind === "assistant");
      if (answer === undefined && failed !== undefined && "text" in failed) {
        throw new Error(String(failed.text));
      }
      return answer && "text" in answer ? String(answer.text) : "";
    },
    /* Bars, not the clock. A brief is evaluated against what closed, so a dead
       feed produces no checks rather than a stream of identical ones. */
    lastBarCloseAt: (sym, tf) => {
      if (sym !== feed.loadedSymbol.peek() || tf !== feed.loadedTimeframe.peek()) return 0;
      const list = feed.bars.peek();
      /* The last CLOSED bar. The forming one has not closed and checking
         against it would fire on a wick that unwinds before the bar ends. */
      return list.length >= 2 ? (list[list.length - 2]?.t ?? 0) : 0;
    },
    onFire: (b, why) => {
      toaster.push({
        level: "info",
        title: `Brief fired — ${b.symbol} ${b.timeframe}`,
        body: why,
        action: { label: "Open analyst", run: () => state.view.set("agent") },
      });
    },
  });

  /* Driven by closed bars. `closedBarCount` changes when a bar closes and
     never on a tick, so this cannot be charged for the forming bar. */
  effect(() => {
    closedBarCount();
    void briefWatcher.tick();
  });

  return {
    /** The conversation the Analyst desk drives. */
    session: agentSession,
    /** The configurable backends, for the Settings desk's dropdown. */
    providers: AGENT_PROVIDERS,
    providerId: agentProviderId,
    baseUrl: agentBaseUrl,
    apiKey: agentApiKey,
    model: agentModel,
    /** The backend the operator picked — NOT the resilient wrapper. */
    chosenProvider,
    /** Why the analyst is answering the way it is, or "". */
    providerFallback,
    /** Standing briefs. */
    briefStore,
    watcher: briefWatcher,
    briefsBlocked,
    /** The last brief evaluation's raw turns, for diagnosis. */
    briefTranscript: (): readonly import("../../agent/session").TranscriptEntry[] =>
      lastBriefTranscript,
  };
}
