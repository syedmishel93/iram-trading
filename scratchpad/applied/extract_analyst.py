"""Move the analyst subsystem out of mountShell into ui/model/analyst.ts.

Two ranges move; `emaAt` and the `createTerminalAccess` call between them stay,
because `terminalAccess` is assembled from twenty-one shell locals and moving
THAT would relocate the coupling instead of removing it. It arrives as one
sibling, which is what takes this section from twenty-two siblings to three.
"""
import pathlib

SRC = pathlib.Path(
    r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src"
)

HEADER = '''/**
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

'''

FOOTER = '''
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
'''

CALL = '''  /**
   * The analyst — `ui/model/analyst.ts`.
   *
   * Built here rather than above `terminalAccess` because it takes it: the
   * window stays assembled beside the signals it reads, and the subsystem that
   * uses it moves out whole.
   */
  const analyst = createAnalystModel(ctx, { connection, closedBarCount, terminalAccess });
'''

# 1-indexed, inclusive. Part 1 is the provider stack; part 2 the session,
# the brief store, the watcher and the tick effect.
P1 = (1409, 1512)
P2 = (1548, 1676)

RENAMES = [
    ("    session: agentSession,", None),  # placeholder, unused
]

# External call sites, rewritten to read through the one object.
CALLSITES = [
    ("    session: agentSession,\n    providers: AGENT_PROVIDERS,\n    providerId: agentProviderId,\n    fallbackNote: providerFallback,",
     "    session: analyst.session,\n    providers: analyst.providers,\n    providerId: analyst.providerId,\n    fallbackNote: analyst.providerFallback,"),
    ("      list: () => briefStore.briefs(),", "      list: () => analyst.briefStore.briefs(),"),
    ("      blocked: briefsBlocked,", "      blocked: analyst.briefsBlocked,"),
    ("        briefStore.add(text, state.symbol.peek(), state.timeframe.peek());",
     "        analyst.briefStore.add(text, state.symbol.peek(), state.timeframe.peek());"),
    ("      arm: (id) => briefStore.arm(id),\n      disarm: (id) => briefStore.disarm(id),\n      remove: (id) => briefStore.remove(id),",
     "      arm: (id) => analyst.briefStore.arm(id),\n      disarm: (id) => analyst.briefStore.disarm(id),\n      remove: (id) => analyst.briefStore.remove(id),"),
    ("            baseUrl: agentBaseUrl,\n            apiKey: agentApiKey,\n            model: agentModel,\n            provider: chosenProvider,",
     "            baseUrl: analyst.baseUrl,\n            apiKey: analyst.apiKey,\n            model: analyst.model,\n            provider: analyst.chosenProvider,"),
    ("        return briefStore.briefs();", "        return analyst.briefStore.briefs();"),
    ("        return lastBriefTranscript;", "        return analyst.briefTranscript();"),
    ("          briefStore.add(text, state.symbol.peek(), state.timeframe.peek()),",
     "          analyst.briefStore.add(text, state.symbol.peek(), state.timeframe.peek()),"),
    ("        arm: (id: string) => briefStore.arm(id),\n        disarm: (id: string) => briefStore.disarm(id),\n        remove: (id: string) => briefStore.remove(id),",
     "        arm: (id: string) => analyst.briefStore.arm(id),\n        disarm: (id: string) => analyst.briefStore.disarm(id),\n        remove: (id: string) => analyst.briefStore.remove(id),"),
    ("        tick: () => briefWatcher.tick(),", "        tick: () => analyst.watcher.tick(),"),
]


def main() -> None:
    p = SRC / "ui" / "shell.ts"
    raw = p.read_text(encoding="utf-8")
    crlf = "\r\n" in raw
    lines = raw.replace("\r\n", "\n").split("\n")

    b1 = lines[P1[0] - 1 : P1[1]]
    b2 = lines[P2[0] - 1 : P2[1]]
    assert b1[0].strip().endswith("agent ---"), b1[0]
    assert "activeProvider" in b1[-2], b1[-2]
    assert b2[0].strip().startswith("const agentSession"), b2[0]
    assert b2[-1].strip() == "});", b2[-1]

    moved = "\n".join(b1).rstrip() + "\n\n" + "\n".join(b2).rstrip()
    moved = moved.replace("createToolset(terminalAccess)", "createToolset(terminalAccess)")
    (SRC / "ui" / "model" / "analyst.ts").write_text(
        HEADER + moved + "\n" + FOOTER,
        encoding="utf-8",
        newline="\r\n" if crlf else "\n",
    )

    # Rebuild the shell: keep everything outside the two ranges, and put the
    # one call in where part 2 was (after `terminalAccess` exists).
    rest = (
        lines[: P1[0] - 1]
        + lines[P1[1] : P2[0] - 1]
        + CALL.split("\n")
        + lines[P2[1] :]
    )
    body = "\n".join(rest)

    for old, new in CALLSITES:
        assert body.count(old) == 1, ("CALLSITE", old[:60], body.count(old))
        body = body.replace(old, new)

    anchor = 'import { createStructureModel } from "./model/structure";'
    assert body.count(anchor) == 1
    body = body.replace(
        anchor, anchor + '\nimport { createAnalystModel } from "./model/analyst";'
    )
    p.write_text(body, encoding="utf-8", newline="\r\n" if crlf else "\n")
    print("moved %d lines into ui/model/analyst.ts" % (len(b1) + len(b2)))


main()
