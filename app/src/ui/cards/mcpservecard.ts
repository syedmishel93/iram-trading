/**
 * THIS TERMINAL AS AN MCP SERVER — the card for `server/svc/mcpserve.py`.
 *
 * `mcpcard.ts` is the other direction: this product as a CLIENT of other
 * people's MCP servers. Here it is the server, so Claude Desktop or any other
 * MCP client can ask the terminal what history it holds, what the broker says
 * and how its past reads actually worked out.
 *
 * WHY THIS CARD EXISTS AT ALL, rather than the capability shipping silently:
 * "A CAPABILITY NOBODY CAN SEE IS A CAPABILITY NOBODY HAS" — and this one cannot
 * ship enabled, so without a surface it could never be turned on. The switch IS
 * the feature.
 *
 * WHAT THE CARD HAS TO SAY, AND WHY EACH LINE IS THERE
 *
 *   * **What it publishes.** Five read-only tools, listed by name. An operator
 *     about to let an AI client read their account should see the list before
 *     the switch, not after.
 *   * **What it will NOT publish.** The withheld list is the more informative
 *     half: it is how you learn the client cannot evict the archive, import
 *     deals, widen the disk budget or place an order. A card that showed only
 *     the capabilities would leave "what else could it do?" unanswered, which is
 *     the question that stops somebody turning it on.
 *   * **Who can reach it, as a SENTENCE.** The gateway has one optional secret;
 *     with none set this endpoint is reachable by any process on the machine,
 *     exactly like `/svc/*`. That is stated in those words. A green "secure"
 *     chip would be a claim this product cannot make, and this file would rather
 *     be trusted than reassuring.
 *
 * THE SIGNAL ORDER IS DELIBERATE. `computed` here is EAGER — it runs on
 * construction — so one declared above a `const` it reads throws a
 * temporal-dead-zone error that `effect` swallows, leaving it `undefined` for
 * the life of the page. Two of those cost the Playbook its two newest features
 * while the desk looked entirely normal. Every `computed` below sits under
 * everything it names.
 */

import { each, h } from "../dom";
import { computed, signal } from "../../core/signal";
import { pkFold, pkWhy } from "../panelkit";
import { onShown } from "./shown";
import type { McpRefusal, McpServeState, McpServeSwitch, McpTool } from "../../data/mcp";

/**
 * THE TRANSPORT IS A PARAMETER WITH NO DEFAULT, and that is a rule this project
 * has paid for three times. `createHistory` defaulted to the real bars client
 * and a test wrote 535 fixture candles into the archive the backtests read;
 * `startBackup`'s transport defaulted to the live one and a SCHEDULING test
 * overwrote thirteen of the operator's real settings slots. Under vitest the
 * global `fetch` reaches a running gateway, so a default here would let a test
 * of this card TURN THE MCP SERVER ON on the operator's machine.
 *
 * There is therefore no spelling of this call that touches the network by
 * accident, which a default can never promise.
 */
export interface McpServeDeps {
  readonly state: () => Promise<McpServeState | McpRefusal>;
  readonly setOn: (on: boolean) => Promise<McpServeSwitch | McpRefusal>;
}

/** Neither "on" nor "off" until the server has answered — three states, not two. */
type Loaded = McpServeState | null;

export function createMcpServeCard(deps: McpServeDeps): { readonly el: HTMLElement; refresh(): void } {
  const state = signal<Loaded>(null);
  const note = signal<string>("");
  const busy = signal<boolean>(false);
  const copied = signal<boolean>(false);

  async function refresh(): Promise<void> {
    const got = await deps.state();
    if (got.ok === false) {
      note.set(got.why);
      return;
    }
    note.set("");
    state.set(got);
  }

  async function toggle(): Promise<void> {
    const now = state();
    if (!now) return;
    busy.set(true);
    const got = await deps.setOn(!now.on);
    busy.set(false);
    if (got.ok === false) {
      note.set(got.why);
      return;
    }
    // Read the state BACK rather than assuming the switch took: a fetch that
    // writes must be followed by a read of what it wrote.
    await refresh();
  }

  function snippet(): string {
    const s = state();
    if (!s) return "";
    return JSON.stringify(s.clientConfig, null, 2);
  }

  async function copy(): Promise<void> {
    const text = snippet();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied.set(true);
      window.setTimeout(() => copied.set(false), 1500);
    } catch {
      // A denied clipboard is not a failure of the feature — the snippet is on
      // screen and selectable. Say so rather than reporting an error.
      note.set("This browser would not let the terminal write to the clipboard. The text below can be selected.");
    }
  }

  // ---- computeds: every one BELOW everything it reads (see the header) ----

  const on = computed(() => state()?.on === true);
  const answered = computed(() => state() !== null);
  const tools = computed<readonly McpTool[]>(() => state()?.tools ?? []);
  const withheld = computed(() => state()?.wontPublish ?? []);

  /** One short line. The standing, not the reasoning. */
  const standing = computed(() => {
    const s = state();
    if (!s) return note() || "Asking the terminal…";
    return s.on
      ? `On. ${s.tools.length} read-only tools published at ${s.url}`
      : "Off. Nothing outside this terminal can read it.";
  });

  const toolBox = h("div", { class: "msrv-list" }) as HTMLElement;
  const wontBox = h("div", { class: "msrv-list" }) as HTMLElement;

  /* `each()` reuses the node for an unchanged key and never calls `render`
     again, so every value a row shows is read through a FUNCTION that looks the
     item up by name in the live signal. These particular descriptions are server
     constants and would survive being captured — but a row that reads its own
     fields once is the defect that left an MCP row on "checking" for ever, and
     the next list here will not be constant. */
  each(toolBox, () => tools(), (t) => t.name, (t) =>
    h(
      "div",
      { class: "msrv-tool" },
      h("span", { class: "msrv-tool-name" }, () => t.name),
      h("span", { class: "msrv-tool-what" },
        () => tools().find((x) => x.name === t.name)?.description ?? t.description),
    ) as HTMLElement);

  each(wontBox, () => withheld(), (w) => w.name, (w) =>
    h(
      "div",
      { class: "msrv-tool" },
      h("span", { class: "msrv-tool-name" }, () => w.name),
      h("span", { class: "msrv-tool-what" },
        () => withheld().find((x) => x.name === w.name)?.why ?? w.why),
    ) as HTMLElement);

  const el = h(
    "section",
    { class: "dd-panel msrv-card" },
    h(
      "div",
      { class: "panel-head" },
      h("h3", {}, "Publish to an AI client"),
      h("span", { class: "msrv-state", "data-on": () => (on() ? "1" : "0") },
        () => (answered() ? (on() ? "On" : "Off") : "—")),
    ),

    h("p", { class: "msrv-lede" }, () => standing()),

    pkWhy(
      () =>
        "This terminal can act as an MCP server, so Claude Desktop or another MCP " +
        "client reads its data directly instead of you copying figures out. It is " +
        "off until you turn it on, because a client sends what it reads to whoever " +
        "runs it — your equity, your open positions and your track record would " +
        "leave this machine. Everything published is read-only: a client cannot " +
        "place an order (this product has no execution path at all), delete " +
        "history, import deals or change a setting.",
      "What this is, and what turning it on means",
    ),

    h(
      "div",
      { class: "msrv-acts" },
      h(
        "button",
        {
          /* `ghost-btn`, NOT `primary-btn`, and not in either direction.
             MEASURED first: the class here was `btn`, which this codebase does
             not declare anywhere -- computed style was a transparent 21px box
             with no border, so the card's only action rendered as plain text.
             "Verify the ELEMENT, not the stylesheet."

             Ghost rather than primary is a decision, not a fallback: turning
             this on opens an egress path for the operator's account figures,
             and a button styled as the thing the page wants you to press is the
             wrong shape for a consent control. It also inherits press feedback
             and hover from `components.css` and `press.css`, which is the
             reason `.alc-` and the chart drawer reuse it too. */
          class: "ghost-btn",
          disabled: () => !answered() || busy(),
          onclick: () => void toggle(),
        },
        () => (busy() ? "Saving…" : on() ? "Turn off" : "Turn on"),
      ),
      h("span", { class: "msrv-reach" }, () => (answered() ? `Reachable by: ${state()?.reach ?? ""}` : "")),
    ),

    h("p", { class: "msrv-note", "data-on": () => (note() ? "1" : "0") }, () => note()),

    // What it publishes. Before the switch in importance, so it is not folded.
    h(
      "div",
      { class: "msrv-tools", "data-on": () => (tools().length > 0 ? "1" : "0") },
      h("div", { class: "msrv-sub" }, "What a client could read"),
      toolBox,
    ),

    // What it will NOT. The more informative half of the decision.
    pkFold("What it cannot do, whatever the client asks", wontBox),

    pkFold(
      "Set it up in your client",
      h(
        "div",
        { class: "msrv-cfg" },
        h(
          "p",
          { class: "msrv-cfg-lede" },
          () =>
            state()?.tokenRequired === true
              ? "Add this to your client's MCP config and replace the placeholder with your MISHEL_TOKEN."
              : "Add this to your client's MCP config. No token is set on this terminal, so none is needed.",
        ),
        h("pre", { class: "msrv-snip" }, () => snippet()),
        h(
          "button",
          { class: "ghost-btn tiny", onclick: () => void copy() },
          () => (copied() ? "Copied" : "Copy"),
        ),
      ),
    ),
  ) as HTMLElement;

  // A card polls only while it is ON SCREEN. `isConnected` is not "on screen":
  // every card here is built once and kept, so a card in a shut panel is still
  // connected and would go on asking from behind it.
  onShown(el, () => void refresh());

  return { el, refresh: () => void refresh() };
}
