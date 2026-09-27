// @vitest-environment jsdom
/**
 * THE CARD THAT PUBLISHES THIS TERMINAL TO AN AI CLIENT —
 * `ui/cards/mcpservecard.ts`.
 *
 * The card is the consent surface for an egress path: turning it on lets an MCP
 * client read the operator's equity, open positions and track record, and send
 * them wherever that client runs. So the tests here are about what the operator
 * can SEE before deciding, not about markup.
 *
 *   * **`shows neither on nor off until the server has answered`.** Three states,
 *     not two. Rendering "Off" before anything answered would be a claim about a
 *     server nobody asked — the same defect as a status strip painting "0 of 0
 *     running" green, and as rendering 0 for an unreachable service.
 *
 *   * **`lists what a client could NOT do`.** The withheld list is the more
 *     informative half of the decision: it is how you learn the client cannot
 *     evict history, import deals, change a setting or place an order. A card
 *     showing only capabilities leaves "what else could it do?" unanswered,
 *     which is the question that stops somebody turning it on.
 *
 *   * **`reads the state back after the switch`.** A fetch that WRITES must be
 *     followed by a read of what it wrote. The Playbook ran three identical runs
 *     and got 156, 480, 480 trades because a backfill's result was never read
 *     back; here the same mistake would leave the card showing "Off" on a server
 *     that is now on, or the reverse. The test pins the CALL ORDER, because no
 *     assertion about the rendered text would catch an absent third call.
 *
 *   * **`names the reach as a sentence`.** With no token set this endpoint is
 *     reachable by any process on the machine, exactly like `/svc/*`. The card
 *     says so in those words. A test asserting a stronger guarantee would be
 *     worse than none, because it would read as evidence for a claim the product
 *     does not make.
 *
 * THE TRANSPORT IS PASSED IN, WITH NO DEFAULT — so no test here can reach a
 * running gateway and turn the real server on. That rule exists because this
 * project has broken it three times through three different doors.
 */

import { describe, expect, it, vi } from "vitest";
import { createMcpServeCard } from "../src/ui/cards/mcpservecard";
import type { McpRefusal, McpServeState, McpServeSwitch } from "../src/data/mcp";
import { flushFrames } from "../src/core/frame";

const STATE: McpServeState = {
  ok: true,
  on: false,
  url: "http://127.0.0.1:8787/mcp",
  tools: [
    { name: "history_inventory", description: "What market history this terminal holds on disk, per series." },
    { name: "bars", description: "OHLC bars for one series from the durable archive. Only what is HELD." },
    { name: "risk_state", description: "The account as the risk desk sees it, and the verdict on a new trade." },
  ] as McpServeState["tools"],
  wontPublish: [
    { name: "order_send", why: "there is no execution path in this product at all" },
    { name: "store_evict", why: "deletes gigabytes of history; destructive routes are not one call away" },
  ],
  tokenRequired: false,
  reach: "any process on this machine",
  clientConfig: { mcpServers: { "iram-terminal": { url: "http://127.0.0.1:8787/mcp" } } },
};

const REFUSED: McpRefusal = {
  ok: false,
  needsAuth: false,
  why: "the terminal's own server is not answering on this address, so nothing could be asked",
};

/** A card whose transport answers whatever the test says, and nothing else. */
function mount(
  state: () => Promise<McpServeState | McpRefusal>,
  setOn: (on: boolean) => Promise<McpServeSwitch | McpRefusal> = async () => ({ ok: true, on: true }),
): { el: HTMLElement; refresh(): void } {
  const card = createMcpServeCard({ state, setOn });
  document.body.appendChild(card.el);
  return card;
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  flushFrames();
};

const text = (el: HTMLElement): string => el.textContent ?? "";

describe("the card keeps three states apart", () => {
  it("shows neither on nor off until the server has answered", () => {
    // Built, not yet refreshed. "Off" here would be a statement about a server
    // nobody asked.
    const card = createMcpServeCard({ state: async () => STATE, setOn: async () => ({ ok: true, on: true }) });
    const chip = card.el.querySelector(".msrv-state");
    expect(chip?.textContent).toBe("—");
  });

  it("says off, and that nothing outside can read it", async () => {
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    expect(card.el.querySelector(".msrv-state")?.textContent).toBe("Off");
    expect(text(card.el)).toContain("Nothing outside this terminal can read it");
  });

  it("says on, with the tool count and the address", async () => {
    const card = mount(async () => ({ ...STATE, on: true }));
    card.refresh();
    await settle();
    expect(card.el.querySelector(".msrv-state")?.textContent).toBe("On");
    expect(text(card.el)).toContain("3 read-only tools");
    expect(text(card.el)).toContain("http://127.0.0.1:8787/mcp");
  });

  it("a server that cannot be reached says so, and does not claim off", async () => {
    // "Could not ask" and "it is off" are different facts. The chip must stay
    // unanswered rather than falling to the safe-looking one.
    const card = mount(async () => REFUSED);
    card.refresh();
    await settle();
    expect(card.el.querySelector(".msrv-state")?.textContent).toBe("—");
    expect(text(card.el)).toContain("not answering on this address");
  });
});

describe("what the operator can see before deciding", () => {
  it("lists every tool a client could read, with what it returns", async () => {
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    const names = [...card.el.querySelectorAll(".msrv-tools .msrv-tool-name")].map((n) => n.textContent);
    expect(names).toEqual(["history_inventory", "bars", "risk_state"]);
    expect(text(card.el)).toContain("Only what is HELD");
  });

  it("lists what a client could NOT do, with the reason", async () => {
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    const body = text(card.el);
    expect(body).toContain("order_send");
    expect(body).toContain("no execution path");
    expect(body).toContain("store_evict");
    expect(body).toContain("deletes gigabytes");
  });

  it("names the reach as a sentence, not a reassurance", async () => {
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    const body = text(card.el);
    expect(body).toContain("any process on this machine");
    // It must not claim a guarantee the gateway does not make.
    expect(body).not.toMatch(/\bsecure\b/i);
    expect(body).not.toMatch(/\bencrypted\b/i);
  });

  it("the setup snippet points at the SAME address the card reports", async () => {
    // A snippet describing a server that is not there is worse than none.
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    const snip = card.el.querySelector(".msrv-snip")?.textContent ?? "";
    expect(snip).toContain(STATE.url);
    expect(JSON.parse(snip)).toEqual(STATE.clientConfig);
  });

  it("says a token is needed only when one is set", async () => {
    const without = mount(async () => STATE);
    without.refresh();
    await settle();
    expect(text(without.el)).toContain("No token is set");

    const withTok = mount(async () => ({ ...STATE, tokenRequired: true }));
    withTok.refresh();
    await settle();
    expect(text(withTok.el)).toContain("MISHEL_TOKEN");
  });

  it("explains that turning it on sends account figures off the machine", async () => {
    // The consent has to be informed. This is the sentence that makes it so.
    const card = mount(async () => STATE);
    card.refresh();
    await settle();
    const body = text(card.el);
    expect(body).toContain("leave this machine");
    expect(body).toContain("read-only");
  });
});

describe("the switch", () => {
  it("READS THE STATE BACK after writing it", async () => {
    // The call ORDER is the assertion, because the defect is an ABSENT third
    // call and no check on the rendered shape would show it.
    const calls: string[] = [];
    const card = mount(
      async () => {
        calls.push("read");
        return STATE;
      },
      async (on) => {
        calls.push(`write:${String(on)}`);
        return { ok: true, on };
      },
    );
    card.refresh();
    await settle();
    expect(calls).toEqual(["read"]);

    (card.el.querySelector(".msrv-acts button") as HTMLButtonElement).click();
    await settle();
    expect(calls).toEqual(["read", "write:true", "read"]);
  });

  it("offers the opposite of the current state", async () => {
    const off = mount(async () => STATE);
    off.refresh();
    await settle();
    expect(off.el.querySelector(".msrv-acts button")?.textContent).toBe("Turn on");

    const on = mount(async () => ({ ...STATE, on: true }));
    on.refresh();
    await settle();
    expect(on.el.querySelector(".msrv-acts button")?.textContent).toBe("Turn off");
  });

  it("cannot be pressed before the server has answered", async () => {
    // A switch that acts on an unknown state would send `!undefined`.
    const card = createMcpServeCard({ state: async () => STATE, setOn: async () => ({ ok: true, on: true }) });
    const btn = card.el.querySelector(".msrv-acts button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("a switch that fails shows why and does not pretend it worked", async () => {
    const card = mount(
      async () => STATE,
      async () => ({ ok: false, needsAuth: false, why: "the terminal refused to write the setting" }),
    );
    card.refresh();
    await settle();
    (card.el.querySelector(".msrv-acts button") as HTMLButtonElement).click();
    await settle();
    expect(text(card.el)).toContain("refused to write the setting");
    expect(card.el.querySelector(".msrv-state")?.textContent).toBe("Off");
  });

  it("does not reach the network by itself — the transport is the only way in", () => {
    // PROVES the shape that stops a test turning the real server on. If a
    // default were reintroduced, a card built with no deps would compile.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const card = createMcpServeCard({ state: async () => STATE, setOn: async () => ({ ok: true, on: true }) });
    expect(card.el).toBeInstanceOf(HTMLElement);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
