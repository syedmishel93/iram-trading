// @vitest-environment jsdom
/**
 * The on-chain whale client and card.
 *
 * Fixtures are the rows the live service actually returned (which are
 * themselves leaked test fixtures — see CLAUDE.md on tests writing to the
 * operator's database). Every expected value is written by hand; URLs and
 * request bodies are checked by parsing what `fetch` was called with.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ageText,
  isAddress,
  loadOnchain,
  parseEvents,
  parseWallets,
  shortAddr,
  unwatchWallet,
  watchWallet,
} from "../src/data/onchain";
import { createWhaleCard } from "../src/ui/cards/whalecard";

const LIVE_WATCH = [
  { chain: "ethereum", enabled: 1, id: 1, min_usd: 5000.0, wallet: "0xdna1111111111111111111111111111111111111" },
  { chain: "ethereum", enabled: 1, id: 2, min_usd: 10000.0, wallet: "0xnodna11111111111111111111111111111111111" },
];
const LIVE_EVENTS = [
  { amount: 10.0, chain: "ethereum", direction: "SELL", sym: "PEPE", t: 1783676794.920117, token: "0xtok", wallet: "0xlead" },
  { amount: 2.5, chain: "base", direction: "BUY", sym: "WETH", t: 1783690000, token: "0xweth", wallet: "0xlead" },
];
const REAL = "0x12ab34cd56ef7890a1b2c3d4e5f60718293a9f3c";

describe("parseWallets", () => {
  it("reads the live rows with their units", () => {
    expect(parseWallets(LIVE_WATCH)).toEqual([
      { id: 1, wallet: "0xdna1111111111111111111111111111111111111", chain: "ethereum", minUsd: 5000, enabled: true },
      { id: 2, wallet: "0xnodna11111111111111111111111111111111111", chain: "ethereum", minUsd: 10000, enabled: true },
    ]);
  });

  it("keeps a switched-off row as switched off", () => {
    expect(parseWallets([{ ...LIVE_WATCH[0], enabled: 0 }])[0]?.enabled).toBe(false);
  });

  it("drops malformed rows rather than filling them in", () => {
    expect(
      parseWallets([
        null,
        "x",
        { id: 3, wallet: "", min_usd: 1, enabled: 1 },
        { id: 4, wallet: REAL, min_usd: "10000", enabled: 1 },
        { id: 5, wallet: REAL, min_usd: 1, enabled: "yes" },
        { id: 6, wallet: REAL, min_usd: 1, enabled: 1, chain: null },
      ]),
    ).toEqual([{ id: 6, wallet: REAL, chain: null, minUsd: 1, enabled: true }]);
    expect(parseWallets({ rows: [] })).toEqual([]);
  });
});

describe("parseEvents", () => {
  it("reads the live rows, newest first, amount in tokens", () => {
    const e = parseEvents(LIVE_EVENTS);
    expect(e.map((x) => x.sym)).toEqual(["WETH", "PEPE"]);
    expect(e[1]).toEqual({
      wallet: "0xlead",
      chain: "ethereum",
      t: 1783676794.920117,
      token: "0xtok",
      sym: "PEPE",
      direction: "SELL",
      amount: 10,
    });
  });

  it("drops rows with no time, an unknown direction or no amount", () => {
    const base = LIVE_EVENTS[0];
    expect(
      parseEvents([
        { ...base, t: null },
        { ...base, direction: "HOLD" },
        { ...base, amount: "10" },
        { ...base, wallet: 7 },
        { ...base, sym: "" },
      ]).map((x) => x.sym),
    ).toEqual(["?"]);
  });
});

describe("words", () => {
  it("accepts only 0x + 40 hex digits", () => {
    expect(isAddress(REAL)).toBe(true);
    expect(isAddress(REAL.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isAddress("0xdna1111111111111111111111111111111111111")).toBe(false);
    expect(isAddress("0xnodna11111111111111111111111111111111111")).toBe(false);
    expect(isAddress("0xlead")).toBe(false);
    expect(isAddress(REAL.slice(0, -1))).toBe(false);
    expect(isAddress(`${REAL}0`)).toBe(false);
    expect(isAddress(REAL.slice(2))).toBe(false);
  });

  it("shortens an address to its first six and last four", () => {
    expect(shortAddr(REAL)).toBe("0x12ab…9f3c");
    expect(shortAddr("0xlead")).toBe("0xlead");
  });

  it("states age in the largest whole unit", () => {
    const now = 1_000_000_000_000;
    const s = now / 1000;
    expect(ageText(s - 5, now)).toBe("just now");
    expect(ageText(s - 12 * 60, now)).toBe("12 min ago");
    expect(ageText(s - 5 * 3600 - 59, now)).toBe("5 h ago");
    expect(ageText(s - 3 * 86_400 - 100, now)).toBe("3 d ago");
    expect(ageText(s + 3600, now)).toBe("time is in the future");
    expect(ageText(NaN, now)).toBe("—");
  });
});

type Call = { url: string; init?: RequestInit };

function stub(route: (url: URL, init?: RequestInit) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = route(new URL(url), init);
    return { status: r.status, ok: r.status < 400, json: async () => r.body } as Response;
  });
  return calls;
}

const live = (u: URL) =>
  u.pathname === "/svc/onchain/watch" ? { status: 200, body: LIVE_WATCH } : { status: 200, body: LIVE_EVENTS };

describe("loadOnchain", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the watch and events routes, and reads both", async () => {
    const calls = stub(live);
    const r = await loadOnchain(8);
    const paths = calls.map((c) => new URL(c.url).pathname).sort();
    expect(paths).toEqual(["/svc/onchain/events", "/svc/onchain/watch"]);
    const ev = calls.find((c) => new URL(c.url).pathname === "/svc/onchain/events");
    expect(new URL(ev?.url ?? "").searchParams.get("limit")).toBe("8");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.value.wallets).toHaveLength(2);
    expect(r.value.events).toHaveLength(2);
    expect(r.value.skipped).toBe(0);
  });

  it("counts rows it could not read instead of losing them silently", async () => {
    stub((u) => (u.pathname === "/svc/onchain/watch" ? { status: 200, body: [...LIVE_WATCH, { junk: 1 }] } : { status: 200, body: LIVE_EVENTS }));
    const r = await loadOnchain();
    expect(r.state === "ok" && r.value.skipped).toBe(1);
  });

  it("is OFFLINE when the backend does not answer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await loadOnchain()).state).toBe("offline");
  });

  it("is OFFLINE when the events route fails, not an empty list", async () => {
    stub((u) => (u.pathname === "/svc/onchain/watch" ? { status: 200, body: LIVE_WATCH } : { status: 500, body: { err: "database is locked" } }));
    expect(await loadOnchain()).toEqual({ state: "offline", reason: "database is locked" });
  });

  it("is OFFLINE when something other than JSON answers", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 404, ok: false, json: async () => { throw new SyntaxError("Unexpected token <"); } }) as unknown as Response);
    expect((await loadOnchain()).state).toBe("offline");
  });
});

describe("watch and unwatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs a valid address, lower-cased, with chain and dollar minimum", async () => {
    const calls = stub(() => ({ status: 200, body: { ok: true } }));
    const r = await watchWallet({ wallet: `  ${REAL.toUpperCase().replace("0X", "0x")} `, chain: "base", minUsd: 25000 });
    expect(r).toEqual({ ok: true });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/svc/onchain/watch");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ wallet: REAL, chain: "base", min_usd: 25000 });
  });

  it("refuses a malformed address without asking the server", async () => {
    const calls = stub(() => ({ status: 200, body: { ok: true } }));
    const r = await watchWallet({ wallet: "0xdna1111111111111111111111111111111111111", chain: "ethereum", minUsd: 10000 });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("passes the server's refusal through", async () => {
    stub(() => ({ status: 400, body: { ok: false, err: "wallet address required" } }));
    expect(await watchWallet({ wallet: REAL, chain: "ethereum", minUsd: 10000 })).toEqual({ ok: false, reason: "wallet address required" });
  });

  it("unwatches through POST /svc/onchain/unwatch, which switches off rather than deletes", async () => {
    const calls = stub(() => ({ status: 200, body: { ok: true } }));
    expect(await unwatchWallet("0xDNA1111111111111111111111111111111111111")).toEqual({ ok: true });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/svc/onchain/unwatch");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ wallet: "0xdna1111111111111111111111111111111111111" });
  });

  it("an unreachable backend is a refusal with a reason", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await unwatchWallet(REAL);
    expect(r.ok).toBe(false);
  });
});

describe("the card", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says the service is not answering when fetch fails — not that nothing is watched", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const card = createWhaleCard();
    document.body.appendChild(card.el);
    await vi.waitFor(() => expect(card.el.textContent).toContain("The on-chain service is not answering."));
    expect(card.el.textContent).not.toContain("No wallets watched");
  });

  it("says nothing is watched when the service answers with no wallets", async () => {
    stub((u) => ({ status: 200, body: u.pathname === "/svc/onchain/watch" ? [] : [] }));
    const card = createWhaleCard();
    await vi.waitFor(() =>
      expect(card.el.textContent).toContain("No wallets watched. Add one to be told about its large transfers."),
    );
    expect(card.el.textContent).not.toContain("not answering");
  });

  it("marks the fixture wallets invalid, labels amounts in tokens and shows each age", async () => {
    stub(live);
    const card = createWhaleCard();
    await vi.waitFor(() => expect(card.el.querySelectorAll(".wh-wallet")).toHaveLength(2));
    expect(card.el.querySelectorAll(".wh-bad")).toHaveLength(2);
    const rows = [...card.el.querySelectorAll(".wh-event")].map((r) => r.textContent ?? "");
    expect(rows[1]).toContain("SELL");
    expect(rows[1]).toContain("10 PEPE");
    expect(rows[1]).not.toContain("$");
    expect(rows[1]).toMatch(/ago|future/);
  });

  it("refuses a malformed address in the form with a one-line reason", async () => {
    const calls = stub(live);
    const card = createWhaleCard();
    await vi.waitFor(() => expect(card.el.querySelectorAll(".wh-wallet")).toHaveLength(2));
    const before = calls.length;
    const input = card.el.querySelector<HTMLInputElement>(".wh-addr");
    if (input) input.value = "0xnot-an-address";
    card.el.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(card.el.querySelector(".wh-msg")?.textContent).toContain("40 hex digits");
    expect(calls.length).toBe(before);
  });
});
