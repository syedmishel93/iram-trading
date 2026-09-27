import { describe, it, expect, vi } from "vitest";
import {
  mapWithConcurrency,
  scanUniverse,
  rankRows,
  RateLimited,
  type UniverseEntry,
  type ScanRow,
  type ScanDeps,
} from "../src/scan/scanner";
import type { BarView } from "../src/chart/series";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order regardless of completion order", async () => {
    // Otherwise a table reshuffles as slow symbols land.
    const out = await mapWithConcurrency([50, 10, 30, 0], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("processes every item", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 5, async (n) => n);
    expect(out).toEqual(items);
  });

  it("handles a limit larger than the item count", async () => {
    const out = await mapWithConcurrency([1, 2], 99, async (n) => n * 3);
    expect(out).toEqual([3, 6]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });

  it("stops starting work once aborted", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const items = Array.from({ length: 40 }, (_, i) => i);

    const run = mapWithConcurrency(
      items,
      2,
      async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (started.length >= 4) controller.abort();
        return n;
      },
      { signal: controller.signal },
    );

    await run;
    expect(started.length).toBeLessThan(items.length);
  });

  it("reports each settled item as it lands", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (n) => n, {
      onSettled: (_i, r) => seen.push(r),
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------

const universe = (n: number): UniverseEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol: `SYM${i}USDT`,
    quoteVolume: (n - i) * 1000, // descending liquidity
    changePct: i % 2 ? 1.5 : -1.5,
    lastPrice: 100 + i,
  }));

const trendingBars = (n = 400): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.5;
    const o = i === 0 ? c : 100 + (i - 1) * 0.5;
    return { t: i * 3_600_000, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 };
  });

const okDeps = (over: Partial<ScanDeps> = {}): ScanDeps => ({
  loadUniverse: async () => universe(20),
  loadBars: async () => trendingBars(),
  sleep: async () => undefined,
  ...over,
});

describe("scanUniverse", () => {
  it("scans only the top N by liquidity", async () => {
    const seen: string[] = [];
    const rows = await scanUniverse(
      okDeps({
        loadBars: async (symbol) => {
          seen.push(symbol);
          return trendingBars();
        },
      }),
      { interval: "1h", top: 5 },
    );

    expect(rows).toHaveLength(5);
    // Universe is built with descending volume, so the top 5 are SYM0..SYM4.
    expect(seen.sort()).toEqual(["SYM0USDT", "SYM1USDT", "SYM2USDT", "SYM3USDT", "SYM4USDT"]);
  });

  it("filters to the requested quote asset", async () => {
    const mixed: UniverseEntry[] = [
      { symbol: "AAAUSDT", quoteVolume: 900, changePct: 1, lastPrice: 1 },
      { symbol: "BBBBTC", quoteVolume: 800, changePct: 1, lastPrice: 1 },
      { symbol: "CCCUSDT", quoteVolume: 700, changePct: 1, lastPrice: 1 },
    ];
    const rows = await scanUniverse(okDeps({ loadUniverse: async () => mixed }), {
      interval: "1h",
      top: 10,
      quote: "USDT",
    });
    expect(rows.map((r) => r.symbol)).toEqual(["AAAUSDT", "CCCUSDT"]);
  });

  it("attaches a confluence result with its reasoning", async () => {
    const rows = await scanUniverse(okDeps(), { interval: "1h", top: 2 });
    expect(rows[0]?.result?.bias).toBe("long");
    expect(rows[0]?.result?.signals.length).toBeGreaterThan(3);
    for (const s of rows[0]?.result?.signals ?? []) {
      expect(s.reason.length).toBeGreaterThan(10);
    }
  });

  it("KEEPS a failed symbol as a row carrying its error", async () => {
    // A screener that returns 4 rows when you asked for 5, with no explanation,
    // is lying about its coverage.
    const rows = await scanUniverse(
      okDeps({
        loadBars: async (symbol) => {
          if (symbol === "SYM2USDT") throw new Error("delisted");
          return trendingBars();
        },
      }),
      { interval: "1h", top: 5 },
    );

    expect(rows).toHaveLength(5);
    const bad = rows.find((r) => r.symbol === "SYM2USDT");
    expect(bad?.error).toBe("delisted");
    expect(bad?.result).toBeNull();
  });

  it("marks a too-short series as insufficient rather than scoring it", async () => {
    const rows = await scanUniverse(okDeps({ loadBars: async () => trendingBars(50) }), {
      interval: "1h",
      top: 1,
    });
    expect(rows[0]?.result?.insufficient).toMatch(/need 210/);
    expect(rows[0]?.result?.bias).toBe("neutral");
  });

  it("reports progress including failures", async () => {
    const progress: Array<{ done: number; total: number; failed: number }> = [];
    await scanUniverse(
      okDeps({
        loadBars: async (symbol) => {
          if (symbol === "SYM1USDT") throw new Error("nope");
          return trendingBars();
        },
      }),
      { interval: "1h", top: 4, onProgress: (p) => progress.push({ ...p }) },
    );

    expect(progress.at(-1)).toEqual({ done: 4, total: 4, failed: 1 });
  });

  it("backs the whole scan off on a 429 instead of retrying per symbol", async () => {
    // A 429 is a statement about the client, not about one symbol.
    const sleeps: number[] = [];
    let first = true;
    const rows = await scanUniverse(
      okDeps({
        loadBars: async () => {
          if (first) {
            first = false;
            throw new RateLimited(2500);
          }
          return trendingBars();
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
      { interval: "1h", top: 4, concurrency: 2 },
    );

    expect(sleeps).toContain(2500);
    expect(rows.every((r) => r.error === null)).toBe(true);
  });

  it("surfaces an error when the retry after a 429 also fails", async () => {
    const rows = await scanUniverse(
      okDeps({
        loadBars: async () => {
          throw new RateLimited(10);
        },
      }),
      { interval: "1h", top: 2 },
    );
    expect(rows.every((r) => r.error !== null)).toBe(true);
  });

  it("returns nothing once the scan is superseded", async () => {
    // Switching timeframe mid-scan must not leak stale rows into the new table.
    const controller = new AbortController();
    const gate = deferred<BarView[]>();
    let calls = 0;

    const promise = scanUniverse(
      okDeps({
        loadBars: async () => {
          calls++;
          if (calls === 1) return gate.promise;
          return trendingBars();
        },
      }),
      { interval: "1h", top: 8, concurrency: 1, signal: controller.signal },
    );

    controller.abort();
    gate.resolve(trendingBars());
    expect(await promise).toEqual([]);
  });

  it("does not call loadBars at all if aborted before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const loadBars = vi.fn(async () => trendingBars());
    const rows = await scanUniverse(okDeps({ loadBars }), {
      interval: "1h",
      top: 5,
      signal: controller.signal,
    });
    expect(rows).toEqual([]);
    expect(loadBars).not.toHaveBeenCalled();
  });
});

describe("rankRows", () => {
  const row = (symbol: string, score: number, confidence: number, volume = 100): ScanRow => ({
    symbol,
    lastPrice: 1,
    changePct: 0,
    quoteVolume: volume,
    error: null,
    result: {
      bias: score > 0 ? "long" : score < 0 ? "short" : "neutral",
      score,
      agreement: 1,
      confidence,
      signals: [],
      insufficient: null,
    },
  });

  it("ranks by conviction, not by raw score", () => {
    // A strong-looking read the engine does not trust must not outrank a
    // moderate one it does.
    const ranked = rankRows([row("LOUD", 0.9, 0.2), row("SURE", 0.5, 0.95)]);
    expect(ranked[0]?.symbol).toBe("SURE");
  });

  it("treats shorts and longs symmetrically", () => {
    const ranked = rankRows([row("UP", 0.4, 0.5), row("DOWN", -0.8, 0.9)]);
    expect(ranked[0]?.symbol).toBe("DOWN");
  });

  it("sorts un-scannable rows last without dropping them", () => {
    const broken: ScanRow = {
      symbol: "BROKEN",
      lastPrice: 1,
      changePct: 0,
      quoteVolume: 999_999,
      result: null,
      error: "delisted",
    };
    const ranked = rankRows([broken, row("GOOD", 0.5, 0.9)]);
    expect(ranked[0]?.symbol).toBe("GOOD");
    expect(ranked[1]?.symbol).toBe("BROKEN");
    expect(ranked).toHaveLength(2);
  });

  it("breaks ties on liquidity", () => {
    const ranked = rankRows([row("THIN", 0.5, 0.8, 10), row("DEEP", 0.5, 0.8, 5000)]);
    expect(ranked[0]?.symbol).toBe("DEEP");
  });

  it("does not mutate its input", () => {
    const input = [row("A", 0.1, 0.1), row("B", 0.9, 0.9)];
    const copy = [...input];
    rankRows(input);
    expect(input).toEqual(copy);
  });
});
