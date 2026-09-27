/**
 * Your real fills, from `/svc/recon`, and the sync from MT5.
 *
 * Every expected value here is written by hand from the fixture, never read
 * back from the code under test. URLs are checked by parsing what `fetch` was
 * actually called with (see CLAUDE.md on the QUANT_BASE test that compared a
 * bug to itself).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exitText,
  holdText,
  joinFills,
  loadFills,
  syncFills,
  type FillRecon,
  type FillTrade,
} from "../src/data/fills";

const trade = (id: number, closeMs: number, over: Partial<FillTrade> = {}): FillTrade => ({
  position_id: id,
  symbol: "EURUSD",
  side: "long",
  volume: 1,
  entry_price: 1.1,
  exit_price: 1.105,
  open_ms: closeMs - 3_600_000,
  close_ms: closeMs,
  hold_ms: 3_600_000,
  commission: -3.5,
  swap: 0,
  gross_profit: 500,
  net_profit: 496.5,
  partial_fills: false,
  comment: "",
  ...over,
});

const recon = (id: number, over: Partial<FillRecon> = {}): FillRecon => ({
  position_id: id,
  planned: true,
  slippage_R: 0,
  net_R: 1,
  gross_R: 1,
  exit_reason: "t1",
  followed_plan: true,
  notes: [],
  ...over,
});

describe("joinFills", () => {
  it("pairs by position id, not by list order", () => {
    /* Grades deliberately in the opposite order to the trades. */
    const rows = joinFills([trade(1, 1_000), trade(2, 2_000)], [recon(2, { net_R: -1 }), recon(1, { net_R: 2 })]);
    const byId = new Map(rows.map((r) => [r.trade.position_id, r.recon?.net_R]));
    expect(byId.get(1)).toBe(2);
    expect(byId.get(2)).toBe(-1);
  });

  it("puts the most recently closed trade first", () => {
    const rows = joinFills([trade(1, 1_000), trade(2, 3_000), trade(3, 2_000)], []);
    expect(rows.map((r) => r.trade.position_id)).toEqual([2, 3, 1]);
  });

  it("keeps a trade with no grade, and says so rather than inventing one", () => {
    const rows = joinFills([trade(7, 1_000)], []);
    expect(rows[0]?.recon).toBeNull();
    expect(exitText(rows[0]?.recon ?? null)).toBe("no plan");
  });
});

describe("words for the screen", () => {
  it("states hold time in the largest sensible unit", () => {
    expect(holdText(45_000)).toBe("45s");
    expect(holdText(15 * 60_000)).toBe("15m");
    expect(holdText((2 * 60 + 15) * 60_000)).toBe("2h 15m");
    expect(holdText((3 * 24 + 4) * 3_600_000)).toBe("3d 4h");
    expect(holdText(NaN)).toBe("—");
  });

  it("names how each graded trade ended", () => {
    expect(exitText(recon(1, { exit_reason: "stop" }))).toBe("hit stop");
    expect(exitText(recon(1, { exit_reason: "t2" }))).toBe("hit target 2");
    expect(exitText(recon(1, { exit_reason: "beyond_stop" }))).toBe("past the stop");
    expect(exitText(recon(1, { exit_reason: "discretionary" }))).toBe("closed by hand");
    expect(exitText(recon(1, { planned: false }))).toBe("no plan");
  });
});

describe("loadFills", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { status, ok: status < 400, json: async () => body } as Response;
    });
    return seen;
  };

  it("asks /svc/recon for the requested window", async () => {
    const seen = respond(200, { ok: true, empty: true, msg: "none" });
    await loadFills(30);
    const u = new URL(seen[0] ?? "");
    expect(u.pathname).toBe("/svc/recon");
    expect(u.searchParams.get("days")).toBe("30");
  });

  it("reports nothing imported as EMPTY, not as an error", async () => {
    respond(200, { ok: true, empty: true, msg: "No MT5 deals imported.", stats: { trades: 0 } });
    const r = await loadFills();
    expect(r.state).toBe("empty");
  });

  it("returns joined rows and the stats when there are trades", async () => {
    respond(200, {
      ok: true,
      empty: false,
      days: 90,
      trades: [trade(1, 1_000), trade(2, 2_000)],
      recons: [recon(1), recon(2, { exit_reason: "stop", net_R: -1 })],
      stats: { trades: 2, graded: 2, unplanned: 0, net_profit: 993, total_costs: -7, plan_adherence_pct: 100, beyond_stop_count: 0, findings: [] },
    });
    const r = await loadFills();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.fills).toHaveLength(2);
    expect(r.fills[0]?.trade.position_id).toBe(2);
    expect(r.stats.net_profit).toBe(993);
  });

  it("reports a service error as FAILED with its own reason", async () => {
    respond(500, { ok: false, err: "database is locked" });
    const r = await loadFills();
    expect(r).toEqual({ state: "failed", reason: "database is locked" });
  });

  it("reports an unreachable backend as OFFLINE", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await loadFills();
    expect(r.state).toBe("offline");
  });
});

describe("syncFills", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the window to /svc/mt5/sync and reports what was stored", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return { status: 200, ok: true, json: async () => ({ ok: true, stored: 12, symbols: ["EURUSD"] }) } as Response;
    });
    const r = await syncFills(30);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/svc/mt5/sync");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ days: 30 });
    expect(r).toEqual({ state: "ok", stored: 12, symbols: ["EURUSD"] });
  });

  it("passes MT5's own refusal through when the bridge cannot answer", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 502, ok: false, json: async () => ({ ok: false, err: "MT5 not connected" }) }) as Response);
    expect(await syncFills()).toEqual({ state: "failed", reason: "MT5 not connected" });
  });
});
