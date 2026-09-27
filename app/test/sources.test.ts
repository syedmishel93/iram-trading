import { describe, it, expect, vi } from "vitest";
import {
  createRegistry,
  createBreaker,
  looksCrypto,
  binanceSourceV2,
  proxySourceV2,
  mt5Source,
  defaultRegistry,
  type DataSource,
} from "../src/data/sources";
import type { BarView } from "../src/chart/series";

const bars = (n: number): BarView[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 3_600_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }));

function source(over: Partial<DataSource> & { id: string }): DataSource {
  return {
    label: over.id,
    priority: 0,
    quality: "live",
    covers: "test",
    supports: () => true,
    loadBars: async () => bars(10),
    ...over,
  } as DataSource;
}

describe("looksCrypto", () => {
  it("recognises known quote assets", () => {
    expect(looksCrypto("BTCUSDT")).toBe(true);
    expect(looksCrypto("ETHBTC")).toBe(true);
  });

  it("rejects forex and equities", () => {
    expect(looksCrypto("EURUSD")).toBe(false);
    expect(looksCrypto("AAPL")).toBe(false);
    expect(looksCrypto("XAUUSD")).toBe(false);
  });

  it("does not match a bare quote asset with no base", () => {
    expect(looksCrypto("USDT")).toBe(false);
  });
});

describe("failover", () => {
  it("uses the highest-priority source that works", async () => {
    const reg = createRegistry([
      source({ id: "slow", priority: 5 }),
      source({ id: "fast", priority: 0 }),
    ]);
    const r = await reg.resolve("BTCUSDT", "1h");
    expect(r.source?.id).toBe("fast");
    expect(r.bars).toHaveLength(10);
  });

  it("falls through to the next source when the first throws", async () => {
    const reg = createRegistry([
      source({
        id: "broken",
        priority: 0,
        loadBars: async () => {
          throw new Error("502 bad gateway");
        },
      }),
      source({ id: "backup", priority: 1 }),
    ]);

    const r = await reg.resolve("BTCUSDT", "1h");
    expect(r.source?.id).toBe("backup");
    expect(r.attempts[0]?.ok).toBe(false);
    expect(r.attempts[0]?.note).toMatch(/502/);
  });

  it("treats an EMPTY result as a failure and keeps going", async () => {
    // Returning [] as success would show an empty chart while a working vendor
    // sat unused right behind it.
    const reg = createRegistry([
      source({ id: "empty", priority: 0, loadBars: async () => [] }),
      source({ id: "real", priority: 1 }),
    ]);
    const r = await reg.resolve("BTCUSDT", "1h");
    expect(r.source?.id).toBe("real");
    expect(r.attempts[0]?.note).toMatch(/no bars/);
  });

  it("skips sources that do not cover the symbol WITHOUT a request", async () => {
    // Asking Binance for EURUSD wastes a request and a round trip.
    const load = vi.fn(async () => bars(5));
    const reg = createRegistry([
      source({ id: "crypto-only", priority: 0, supports: looksCrypto, loadBars: load }),
      source({ id: "everything", priority: 1 }),
    ]);

    const r = await reg.resolve("EURUSD", "1h");
    expect(load).not.toHaveBeenCalled();
    expect(r.source?.id).toBe("everything");
    expect(r.attempts[0]?.note).toMatch(/does not cover/);
  });

  it("records every attempt in order, so the fallback is never silent", async () => {
    const reg = createRegistry([
      source({ id: "a", priority: 0, supports: () => false }),
      source({
        id: "b",
        priority: 1,
        loadBars: async () => {
          throw new Error("timeout");
        },
      }),
      source({ id: "c", priority: 2 }),
    ]);

    const r = await reg.resolve("BTCUSDT", "1h");
    expect(r.attempts.map((a) => a.source)).toEqual(["a", "b", "c"]);
    expect(r.attempts.map((a) => a.ok)).toEqual([false, false, true]);
  });

  it("carries provenance with the bars", async () => {
    const reg = createRegistry([source({ id: "px", quality: "delayed" })]);
    const r = await reg.resolve("EURUSD", "1h");
    expect(r.quality).toBe("delayed");
    expect(r.source?.id).toBe("px");
  });

  it("returns an honest empty result when every source fails", async () => {
    const reg = createRegistry([
      source({
        id: "a",
        loadBars: async () => {
          throw new Error("down");
        },
      }),
    ]);
    const r = await reg.resolve("BTCUSDT", "1h");
    expect(r.bars).toEqual([]);
    expect(r.source).toBeNull();
    expect(r.quality).toBe("unknown");
  });

  it("stops immediately on abort rather than trying every source", async () => {
    const ctl = new AbortController();
    const second = vi.fn(async () => bars(5));
    const reg = createRegistry([
      source({
        id: "first",
        priority: 0,
        loadBars: async () => {
          ctl.abort();
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        },
      }),
      source({ id: "second", priority: 1, loadBars: second }),
    ]);

    const r = await reg.resolve("BTCUSDT", "1h", { signal: ctl.signal });
    expect(second).not.toHaveBeenCalled();
    expect(r.attempts.at(-1)?.note).toBe("aborted");
  });
});

describe("circuit breaker", () => {
  const harness = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("opens after the failure threshold and skips the source", () => {
    const h = harness();
    const b = createBreaker({ threshold: 3, cooldownMs: 1000, now: h.now });

    b.recordFailure("x");
    b.recordFailure("x");
    expect(b.isOpen("x")).toBe(false);
    b.recordFailure("x");
    expect(b.isOpen("x")).toBe(true);
  });

  it("closes again after the cooldown", () => {
    const h = harness();
    const b = createBreaker({ threshold: 1, cooldownMs: 1000, now: h.now });
    b.recordFailure("x");
    expect(b.isOpen("x")).toBe(true);
    h.advance(1001);
    expect(b.isOpen("x")).toBe(false);
  });

  it("a success clears the failure count", () => {
    const h = harness();
    const b = createBreaker({ threshold: 2, cooldownMs: 1000, now: h.now });
    b.recordFailure("x");
    b.recordSuccess("x");
    b.recordFailure("x");
    expect(b.isOpen("x")).toBe(false);
  });

  it("spares a dead vendor 200 doomed requests during a scan", async () => {
    // Without the breaker, a screener scanning 200 symbols against a dead
    // source takes 200 timeouts before falling through, every time.
    const h = harness();
    const dead = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const reg = createRegistry(
      [source({ id: "dead", priority: 0, loadBars: dead }), source({ id: "alive", priority: 1 })],
      createBreaker({ threshold: 3, cooldownMs: 60_000, now: h.now }),
    );

    for (let i = 0; i < 50; i++) await reg.resolve(`SYM${i}USDT`, "1h");

    expect(dead).toHaveBeenCalledTimes(3); // then the breaker held it shut
  });

  it("lets exactly one probe through after the cooldown", async () => {
    const h = harness();
    const dead = vi.fn(async () => {
      throw new Error("still down");
    });
    const reg = createRegistry(
      [source({ id: "dead", priority: 0, loadBars: dead }), source({ id: "alive", priority: 1 })],
      createBreaker({ threshold: 1, cooldownMs: 1000, now: h.now }),
    );

    await reg.resolve("AUSDT", "1h");
    expect(dead).toHaveBeenCalledTimes(1);

    await reg.resolve("BUSDT", "1h");
    expect(dead).toHaveBeenCalledTimes(1); // breaker open

    h.advance(1001);
    await reg.resolve("CUSDT", "1h");
    expect(dead).toHaveBeenCalledTimes(2); // one probe
  });

  it("does NOT count an abort as a source failure", async () => {
    // The user switching symbols quickly must not open the breaker on a
    // perfectly healthy vendor.
    const b = createBreaker({ threshold: 1 });
    const ctl = new AbortController();
    const reg = createRegistry(
      [
        source({
          id: "s",
          loadBars: async () => {
            ctl.abort();
            const e = new Error("abort");
            e.name = "AbortError";
            throw e;
          },
        }),
      ],
      b,
    );

    await reg.resolve("BTCUSDT", "1h", { signal: ctl.signal });
    expect(b.state("s").failures).toBe(0);
    expect(b.isOpen("s")).toBe(false);
  });
});

describe("the shipped sources", () => {
  it("binance covers crypto and offers a stream", () => {
    const s = binanceSourceV2();
    expect(s.supports("BTCUSDT")).toBe(true);
    expect(s.supports("EURUSD")).toBe(false);
    expect(s.streamUrl?.("BTCUSDT", "1h")).toMatch(/btcusdt@kline_1h/);
  });

  it("the proxy calls /ohlc with a provider, matching the server contract", async () => {
    // The server serves /ohlc?provider=&symbol=&interval=&limit=. Calling
    // /bars?tf= (which it does not serve) 404s every forex request.
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ bars: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const bars = await proxySourceV2("http://127.0.0.1:8787").loadBars("EURUSD", "1h", {
        limit: 500,
      });
      expect(bars).toHaveLength(1);
      const url = calls[0] as string;
      expect(url).toContain("/ohlc");
      expect(url).toContain("provider=yfinance");
      expect(url).toContain("symbol=EURUSD");
      expect(url).toContain("interval=1h");
      expect(url).not.toContain("/bars");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uppercases the symbol the way the proxy expects", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ bars: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await proxySourceV2().loadBars("eurusd", "1h", {});
      expect(calls[0]).toContain("symbol=EURUSD");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops malformed rows rather than emitting NaN bars", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          bars: [
            { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
            { t: 2, o: "x", h: 2, l: 0.5, c: 1.5, v: 1 },
            { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      expect(await proxySourceV2().loadBars("EURUSD", "1h", {})).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces the proxy's own error message, not just a status code", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "yfinance: not installed" }), { status: 502 })) as typeof fetch;
    try {
      await expect(proxySourceV2().loadBars("EURUSD", "1h", {})).rejects.toThrow(/not installed/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the proxy covers everything, is DELAYED, and has no stream", () => {
    // It polls upstream vendors. Returning null is how the shell knows not to
    // claim live updates it will never receive.
    const s = proxySourceV2();
    expect(s.supports("EURUSD")).toBe(true);
    expect(s.supports("BTCUSDT")).toBe(true);
    expect(s.quality).toBe("delayed");
    expect(s.streamUrl?.("EURUSD", "1h")).toBeNull();
  });

  it("prefers YOUR broker over the free delayed vendor for forex", async () => {
    // MT5 is the venue you are filled at, so its prices are the only ones true
    // for you — and it is the only genuinely real-time free FX feed available.
    const reg = defaultRegistry();
    expect(reg.candidates("EURUSD").map((s) => s.id)).toEqual(["mt5", "proxy"]);
    expect(reg.sources.find((s) => s.id === "mt5")?.quality).toBe("live");
  });

  // The crypto venues must not claim forex just because splitPair can parse it.
  it("keeps the crypto exchanges away from forex", () => {
    const reg = defaultRegistry();
    const ids = reg.candidates("EURUSD").map((s) => s.id);
    expect(ids).not.toContain("coinbase");
    expect(ids).not.toContain("bybit");
    expect(ids).not.toContain("okx");
  });

  it("keeps crypto on the exchange, not the broker's synthetic CFD", () => {
    // An MT5 crypto CFD is the broker's own price, not the exchange's. They are
    // not the same instrument and must not be blended.
    const reg = defaultRegistry();
    expect(reg.candidates("BTCUSDT").map((s) => s.id)).toEqual([
      "binance",
      "coinbase",
      "bybit",
      "okx",
      "proxy",
    ]);
    expect(mt5Source().supports("BTCUSDT")).toBe(false);
    expect(mt5Source().supports("EURUSD")).toBe(true);
  });

  it("falls back to the delayed vendor while MT5 is not logged in", async () => {
    // Nothing needs reconfiguring when MT5 comes up; the next probe succeeds.
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("provider=mt5")) {
        return new Response(JSON.stringify({ error: "mt5: Authorization failed" }), { status: 502 });
      }
      return new Response(
        JSON.stringify({ bars: [{ t: 1, o: 1.1, h: 1.2, l: 1.0, c: 1.15, v: 0 }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const r = await defaultRegistry().resolve("EURUSD", "1h");
      expect(r.source?.id).toBe("proxy");
      expect(r.quality).toBe("delayed");
      // And it says WHY it fell back, rather than falling back silently.
      expect(r.attempts.find((a) => a.source === "mt5")?.note).toMatch(/Authorization failed/);
      expect(calls.some((u) => u.includes("provider=mt5"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses MT5 the moment it starts answering", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ bars: [{ t: 1, o: 1.1, h: 1.2, l: 1.0, c: 1.15, v: 0 }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      const r = await defaultRegistry().resolve("EURUSD", "1h");
      expect(r.source?.id).toBe("mt5");
      expect(r.quality).toBe("live");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("orders binance ahead of the proxy", () => {
    const reg = createRegistry([proxySourceV2(), binanceSourceV2()]);
    expect(reg.sources[0]?.id).toBe("binance");
  });

  it("lists only the sources that can serve a symbol", () => {
    const reg = createRegistry([binanceSourceV2(), proxySourceV2()]);
    expect(reg.candidates("BTCUSDT").map((s) => s.id)).toEqual(["binance", "proxy"]);
    expect(reg.candidates("EURUSD").map((s) => s.id)).toEqual(["proxy"]);
  });
});
