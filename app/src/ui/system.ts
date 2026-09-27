/**
 * THE SYSTEM DESK — what this machine holds, and what it is doing.
 *
 * These two cards first shipped inside Research ▸ Data, which was the wrong
 * home and the owner said so: storage, downloads and twelve background jobs
 * are not research, and the tools menu even had a "Review and system" group
 * that did not contain them. A capability filed under the wrong heading is
 * only slightly easier to find than one with no screen at all.
 *
 * One desk, two questions, in the order somebody asks them:
 *
 *   1. WHAT DO I HOLD?    the durable archive, the bulk store, and the control
 *                         that fills them.
 *   2. IS IT WORKING?     the twelve jobs that run with the terminal closed.
 *   3. CAN IT REACH ME?   the one path any of them has to your attention.
 *
 * The third belongs here and nowhere else: the alert loop, the signal loop and
 * the dead-man's-switch heartbeat all send through `/svc/notify`, and until it
 * was wired every one of them fired into nothing. A status page listing twelve
 * jobs but not the channel they speak through omits whether any can be heard.
 *
 * Research ▸ Data keeps its own job — the per-series library you download and
 * manage — rather than doubling as the machine's status page.
 */

import { createArchiveCard } from "./data/archive";
import { createSystemCard } from "./data/system";
import { createActivityCard } from "./data/activity";
import { createConnectionsCard } from "./data/connections";
import { createMcpCard } from "./cards/mcpcard";
import { createMcpServeCard } from "./cards/mcpservecard";
import { serveState, setServe } from "../data/mcp";
import { createServerSettingsCard } from "./cards/settingscard";
import { notifyCard } from "./cards/notifycard";
import { h } from "./dom";
import { watchedSymbols } from "./watchlist";
import type { KV } from "../store/kv";

export interface SystemDeskOptions {
  readonly kv: KV;
}

export function createSystemDesk(opts: SystemDeskOptions): {
  readonly el: HTMLElement;
  activate(): void;
} {
  const archive = createArchiveCard({ kv: opts.kv, watchlist: () => watchedSymbols(opts.kv) });
  const services = createSystemCard();
  /* THE LOG THE LOOPS WRITE TO. The card above says which jobs STARTED; this
     one says which have been failing — a distinction that cost 2,069 silent
     failures of one loop, whose tick age was fresh the whole time. */
  const activity = createActivityCard();
  /* SEVEN ROUTES THAT HAD NO CALLER, in one card because they answer one
     question: is everything this terminal needs actually reachable. */
  const connections = createConnectionsCard();
  /* TWELVE ROUTES THAT HAD NO CALLER, built this session and left unreachable —
     the "capability with no screen" metric reopened by the person who drove it to
     zero. It sits beside the connections card because that one answers "is what
     this terminal needs reachable" and this one answers the same question one
     step out: what else have I connected it to. */
  const mcp = createMcpCard();
  // The OTHER direction, beside the client card: same subject, one desk.
  const mcpServe = createMcpServeCard({ state: serveState, setOn: setServe });
  /* The last two routes this session left unreachable. It sits beside the
     stored-history card because the budget governs that store, and a setting
     three desks from the thing it controls is one nobody connects to its
     effect. */
  const serverSettings = createServerSettingsCard();

  const el = h(
    "section",
    { class: "dd sys-desk" },
    h(
      "header",
      { class: "sys-head" },
      h("h1", { class: "sys-title", text: "What this machine holds, and what it is doing." }),
      h("p", {
        class: "sys-lede",
        text: "Your history lives in two places: a fast copy in this browser, and a durable copy on the server that survives clearing it. Below that, the jobs that keep both current while the terminal is closed.",
      }),
    ),
    archive.el,
    services.el,
    activity.el,
    connections.el,
    mcp.el,
    mcpServe.el,
    serverSettings.el,
    notifyCard(),
  ) as HTMLElement;

  return {
    el,
    activate() {
      void archive.refresh();
      void services.refresh();
      void activity.refresh();
      connections.refresh();
      mcp.refresh();
      mcpServe.refresh();
      serverSettings.refresh();
    },
  };
}
