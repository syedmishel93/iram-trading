/**
 * The client half of the durable bar archive.
 *
 * What is pinned:
 *  1. THE MIRROR IS BEST-EFFORT. A gateway that is not running must not break
 *     a chart — anyone who opened the built page directly has no gateway, and
 *     that is the ordinary case rather than an error.
 *  2. IT CHUNKS. The server refuses more than `SERVER_CHUNK` in one request,
 *     and a 5,000-bar study window is exactly the size that would hit it.
 *  3. IT NAMES THE FORMING BAR. The last bar a vendor returns is still
 *     forming; its close changes every tick, so it must not be stored as one.
 *  4. THE URL IS JOINED, NOT INTERPOLATED — the shape that stopped the Quant
 *     desk's `() => quantBase()/quant/health` 404 from being possible again.
 *     Asserted by PARSING what fetch was called with, never by rebuilding the
 *     expected string from the code under test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_CHUNK, fetchServerBars, putServerBars, requestPersistence, serverInventory } from "../src/data/serverbars";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;

function bars(n: number, from = 0): BarView[] {
  return Array.from({ length: n }, (_, i) => ({
    t: from + i * H,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100.5 + i,
    v: 10,
  }));
}

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reading the durable archive", () => {
  it("asks a real URL with the series named in the query", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (url: string) => {
      seen.push(String(url));
      return okJson({ ok: true, bars: bars(3) });
    });
    const r = await fetchServerBars("binance", "BTCUSDT", "1h", 500, f as unknown as typeof fetch);

    expect(r.ok).toBe(true);
    expect(r.bars).toHaveLength(3);

    const u = new URL(seen[0] as string);
    expect(u.pathname).toBe("/svc/bars");
    expect(u.searchParams.get("src")).toBe("binance");
    expect(u.searchParams.get("sym")).toBe("BTCUSDT");
    expect(u.searchParams.get("tf")).toBe("1h");
    expect(u.searchParams.get("n")).toBe("500");
  });

  it("drops rows that are not bars rather than passing them to the chart", async () => {
    const f = vi.fn(async () => okJson({ ok: true, bars: [...bars(2), { t: 5, o: "x" }, null] }));
    const r = await fetchServerBars("binance", "BTCUSDT", "1h", 10, f as unknown as typeof fetch);
    expect(r.bars).toHaveLength(2);
  });

  it("says the service is not answering rather than throwing", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await fetchServerBars("binance", "BTCUSDT", "1h", 10, f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.bars).toEqual([]);
    expect(r.reason).toContain("not answering");
  });
});

describe("writing to the durable archive", () => {
  it("splits a window larger than the server will accept", async () => {
    const sent: number[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { bars: unknown[] };
      sent.push(body.bars.length);
      return okJson({ ok: true, stored: body.bars.length });
    });

    const n = SERVER_CHUNK + 250;
    const stored = await putServerBars("binance", "BTCUSDT", "1h", bars(n), {
      fetchImpl: f as unknown as typeof fetch,
    });

    expect(sent).toEqual([SERVER_CHUNK, 250]);
    expect(stored).toBe(n);
  });

  it("tells the server which bar is still forming", async () => {
    let body: { closedBefore?: number } = {};
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { closedBefore?: number };
      return okJson({ ok: true, stored: 0 });
    });
    const window = bars(5);
    const newest = window[window.length - 1] as BarView;
    await putServerBars("binance", "BTCUSDT", "1h", window, {
      closedBefore: newest.t,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(body.closedBefore).toBe(newest.t);
  });

  /*
   * A CHART MUST NOT FAIL BECAUSE A BACKUP STORE IS ABSENT. Anyone who opened
   * the built page without `python run.py` has no gateway at all, and the
   * local archive already holds these bars.
   */
  it("gives up quietly when the gateway is not running", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      putServerBars("binance", "BTCUSDT", "1h", bars(3), { fetchImpl: f as unknown as typeof fetch }),
    ).resolves.toBe(0);
  });

  it("stops chunking once the server refuses, rather than hammering it", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls += 1;
      return { ok: false, status: 413, json: async () => ({}) } as unknown as Response;
    });
    await putServerBars("binance", "BTCUSDT", "1h", bars(SERVER_CHUNK * 3), {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(calls).toBe(1);
  });
});

describe("the inventory", () => {
  it("reports what is held, and totals it", async () => {
    const f = vi.fn(async () =>
      okJson({
        ok: true,
        total_bars: 14,
        series: [{ src: "binance", sym: "BTCUSDT", tf: "1h", bars: 10, oldest: 0, newest: 9 * H }],
      }),
    );
    const r = await serverInventory(f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.totalBars).toBe(14);
    expect(r.series[0]?.sym).toBe("BTCUSDT");
  });
});

describe("persistent storage", () => {
  it("does not ask twice when it is already granted", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => true, persist } });
    const r = await requestPersistence();
    expect(r.granted).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  /*
   * A REFUSAL IS REPORTED, NOT ASSUMED EITHER WAY. Chrome grants this silently
   * to installed origins and declines otherwise, and an operator planning to
   * backtest on this archive needs to know which happened.
   */
  it("says plainly when the browser declines", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist: async () => false } });
    const r = await requestPersistence();
    expect(r.granted).toBe(false);
    expect(r.why).toContain("may evict");
    expect(r.why).toContain("server is unaffected");
  });

  it("says so when the browser has no such notion at all", async () => {
    vi.stubGlobal("navigator", {});
    const r = await requestPersistence();
    expect(r.granted).toBe(false);
    expect(r.why).toContain("evictable");
  });
});
