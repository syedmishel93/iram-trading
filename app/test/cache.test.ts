import { describe, it, expect } from "vitest";
import { createCache, barTtlMs, estimateBytes, requestKey } from "../src/store/cache";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("bar freshness", () => {
  it("stays fresh until the forming bar closes, not for a fixed guess", () => {
    const HOUR = 3_600_000;
    // 20 minutes into the hour: 40 left, plus a second of publisher slack.
    const at = 3 * HOUR + 20 * 60_000;
    expect(barTtlMs(HOUR, at)).toBe(40 * 60_000 + 1000);
  });

  it("never exceeds one interval", () => {
    const HOUR = 3_600_000;
    // Exactly on a boundary the naive answer is interval + slack, which would
    // let a closed bar be served as current for a second past its successor.
    expect(barTtlMs(HOUR, 5 * HOUR)).toBe(HOUR);
  });

  it("has a floor so a 1m chart is not refreshed four times a second", () => {
    const MIN = 60_000;
    expect(barTtlMs(MIN, 5 * MIN - 1)).toBeGreaterThanOrEqual(750);
  });

  it("gives a safe answer for a nonsense interval", () => {
    expect(barTtlMs(0, 1000)).toBe(5000);
    expect(barTtlMs(-1, 1000)).toBe(5000);
  });
});

describe("the response cache", () => {
  it("serves a fresh value without calling the loader again", async () => {
    const c = clock();
    const cache = createCache({ now: c.now });
    let calls = 0;
    const load = async (): Promise<number> => {
      calls++;
      return 42;
    };

    const first = await cache.load("k", load, { ttlMs: 1000 });
    const second = await cache.load("k", load, { ttlMs: 1000 });
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe(42);
  });

  it("reloads once the value is stale", async () => {
    const c = clock();
    const cache = createCache({ now: c.now });
    let calls = 0;
    const load = async (): Promise<number> => ++calls;

    await cache.load("k", load, { ttlMs: 1000 });
    c.advance(1001);
    const again = await cache.load("k", load, { ttlMs: 1000 });
    expect(calls).toBe(2);
    expect(again.value).toBe(2);
  });

  it("reports the AGE of a stale value it serves", async () => {
    // A cache that hides age is worse than no cache: the freshness badge would
    // present a 40-second-old price as live and you would act on it.
    const c = clock();
    const cache = createCache({ now: c.now });
    await cache.load("k", async () => 1, { ttlMs: 1000 });
    c.advance(40_000);

    const read = await cache.load("k", async () => 2, { ttlMs: 1000, swr: true });
    expect(read.stale).toBe(true);
    expect(read.ageMs).toBe(40_000);
    expect(read.value).toBe(1);
  });

  it("keeps the stale value when a background refresh fails", async () => {
    // A slow or broken vendor must not turn a populated panel into an empty
    // one; the old number with its age is strictly more useful than nothing.
    const c = clock();
    const cache = createCache({ now: c.now });
    await cache.load("k", async () => 1, { ttlMs: 100 });
    c.advance(500);

    await cache.load(
      "k",
      async () => {
        throw new Error("vendor down");
      },
      { ttlMs: 100, swr: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.peek<number>("k")!.value).toBe(1);
  });

  it("coalesces concurrent misses into one load", async () => {
    const cache = createCache();
    let calls = 0;
    const load = async (): Promise<number> => {
      calls++;
      await Promise.resolve();
      return 7;
    };
    const [a, b, d] = await Promise.all([
      cache.load("k", load, { ttlMs: 1000 }),
      cache.load("k", load, { ttlMs: 1000 }),
      cache.load("k", load, { ttlMs: 1000 }),
    ]);
    expect(calls).toBe(1);
    expect([a.value, b.value, d.value]).toEqual([7, 7, 7]);
    expect(cache.stats().coalesced).toBe(2);
  });

  it("bypasses the stored value on refresh but still stores the new one", async () => {
    const c = clock();
    const cache = createCache({ now: c.now });
    let n = 0;
    const load = async (): Promise<number> => ++n;
    await cache.load("k", load, { ttlMs: 10_000 });
    const forced = await cache.load("k", load, { ttlMs: 10_000, refresh: true });
    expect(forced.value).toBe(2);
    expect(cache.peek<number>("k")!.value).toBe(2);
  });

  it("evicts least-recently-used entries when over budget", async () => {
    const cache = createCache({ maxBytes: 300 });
    await cache.load("a", async () => "x", { ttlMs: 10_000, bytes: 100 });
    await cache.load("b", async () => "x", { ttlMs: 10_000, bytes: 100 });
    // Touch "a" so "b" becomes the coldest.
    cache.peek("a");
    await cache.load("c", async () => "x", { ttlMs: 10_000, bytes: 200 });

    expect(cache.keys()).toContain("c");
    expect(cache.keys()).not.toContain("b");
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it("refuses a single value bigger than the whole budget instead of thrashing", async () => {
    const cache = createCache({ maxBytes: 100 });
    await cache.load("a", async () => "x", { ttlMs: 1000, bytes: 50 });
    await cache.load("huge", async () => "x", { ttlMs: 1000, bytes: 5000 });
    expect(cache.keys()).not.toContain("huge");
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
  });

  it("invalidates by exact key and by prefix", async () => {
    const cache = createCache();
    await cache.load("bars:BTC:1h", async () => 1, { ttlMs: 1000 });
    await cache.load("bars:BTC:4h", async () => 1, { ttlMs: 1000 });
    await cache.load("flow:BTC", async () => 1, { ttlMs: 1000 });

    expect(cache.invalidate("bars:", true)).toBe(2);
    expect(cache.keys()).toEqual(["flow:BTC"]);
    expect(cache.invalidate("flow:BTC")).toBe(1);
    expect(cache.keys()).toEqual([]);
  });

  it("tracks a hit rate the desk can show", async () => {
    const cache = createCache();
    const load = async (): Promise<number> => 1;
    await cache.load("k", load, { ttlMs: 10_000 });
    await cache.load("k", load, { ttlMs: 10_000 });
    await cache.load("k", load, { ttlMs: 10_000 });
    expect(cache.stats().hitRate).toBeCloseTo(2 / 3, 6);
  });
});

describe("size estimation", () => {
  it("does not walk a huge array element by element", () => {
    // Measuring 40,000 bars one at a time costs more than the memory it is
    // accounting for, so it samples. It only has to be proportional.
    const bars = Array.from({ length: 40_000 }, (_, i) => ({ t: i, o: 1, h: 2, l: 0, c: 1, v: 9 }));
    const size = estimateBytes(bars);
    expect(size).toBeGreaterThan(40_000);
    expect(Number.isFinite(size)).toBe(true);
  });

  it("measures a typed array exactly", () => {
    expect(estimateBytes(new Float64Array(100))).toBe(800 + 32);
  });

  it("handles null and undefined without throwing", () => {
    expect(estimateBytes(null)).toBeGreaterThan(0);
    expect(estimateBytes(undefined)).toBeGreaterThan(0);
  });
});

describe("cache keys", () => {
  it("sorts query parameters so one request is one entry", () => {
    // Without this, `?a=1&b=2` and `?b=2&a=1` are two entries for one request
    // and the cache silently halves its own hit rate.
    const a = requestKey("https://api.binance.com/api/v3/klines?symbol=BTC&interval=1h");
    const b = requestKey("https://api.binance.com/api/v3/klines?interval=1h&symbol=BTC");
    expect(a).toBe(b);
  });

  it("keeps different hosts apart", () => {
    expect(requestKey("https://a.test/x")).not.toBe(requestKey("https://b.test/x"));
  });
});
