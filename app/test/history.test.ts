import { describe, it, expect, vi } from "vitest";
import { createHistory, intervalMs } from "../src/data/history";
import { createArchive, memoryBackend } from "../src/store/barstore";
import { createRegistry, createBreaker, type DataSource } from "../src/data/sources";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;
const NOW = 1_800_000_000_000;

/** `count` hourly bars ending at `endT`. */
function bars(endT: number, count: number): BarView[] {
  return Array.from({ length: count }, (_, i) => {
    const t = endT - (count - 1 - i) * H;
    return { t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 };
  });
}

function source(over: Partial<DataSource> & { id: string }): DataSource {
  return {
    label: over.id,
    priority: 0,
    quality: "live",
    covers: "test",
    supports: () => true,
    loadBars: async () => bars(NOW, 100),
    ...over,
  } as DataSource;
}

/**
 * A durable archive that holds nothing and is never reachable.
 *
 * The default one talks to `/svc/bars` through the global `fetch`, which these
 * tests stub — so without this, a scenario built to mean "every source is
 * down" would still be answered, by the stub, on the fallback path.
 */
const DOWN = {
  read: async () => [] as const,
  write: () => {},
};

const setup = (sources: DataSource[], now = () => NOW, server = DOWN) => {
  const archive = createArchive(memoryBackend());
  const registry = createRegistry(sources, createBreaker({ now }));
  return { archive, registry, history: createHistory(registry, archive, now, server) };
};

describe("intervalMs", () => {
  it("parses the timeframe vocabulary", () => {
    expect(intervalMs("1m")).toBe(60_000);
    expect(intervalMs("15m")).toBe(900_000);
    expect(intervalMs("4h")).toBe(4 * H);
    expect(intervalMs("1d")).toBe(86_400_000);
  });

  it("falls back to an hour on nonsense rather than 0", () => {
    // A 0 interval divides by zero all the way down the stack.
    expect(intervalMs("banana")).toBe(3_600_000);
    expect(intervalMs("0m")).toBe(3_600_000);
  });
});

describe("load", () => {
  it("fetches from the network and persists what it fetched", async () => {
    const { history, archive } = setup([source({ id: "net" })]);
    const r = await history.load("BTCUSDT", "1h", { limit: 100 });

    expect(r.bars).toHaveLength(100);
    expect(r.fromCache).toBe(false);
    expect(r.source).toBe("net");

    const stored = await archive.read(
      { source: "net", symbol: "BTCUSDT", timeframe: "1h" },
      { from: 0, to: NOW },
      H,
    );
    expect(stored.bars).toHaveLength(100);
  });

  it("serves the SECOND call from cache without touching the network", async () => {
    const load = vi.fn(async () => bars(NOW, 100));
    const { history } = setup([source({ id: "net", loadBars: load })]);

    await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(load).toHaveBeenCalledTimes(1);

    const second = await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
    expect(second.bars).toHaveLength(100);
  });

  it("refuses a cache hit when the newest stored bar is too old", async () => {
    // Yesterday's close must never masquerade as today's.
    let t = NOW;
    const load = vi.fn(async () => bars(t, 100));
    const { history } = setup([source({ id: "net", loadBars: load })], () => t);

    await history.load("BTCUSDT", "1h", { limit: 100 });
    t += 10 * H; // ten hours pass
    const r = await history.load("BTCUSDT", "1h", { limit: 100 });

    expect(load).toHaveBeenCalledTimes(2);
    expect(r.fromCache).toBe(false);
  });

  it("honours an explicit refresh", async () => {
    const load = vi.fn(async () => bars(NOW, 100));
    const { history } = setup([source({ id: "net", loadBars: load })]);
    await history.load("BTCUSDT", "1h", { limit: 100 });
    await history.load("BTCUSDT", "1h", { limit: 100, refresh: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("carries provenance through to the result", async () => {
    const { history } = setup([source({ id: "px", quality: "delayed" })]);
    const r = await history.load("EURUSD", "1h", { limit: 50 });
    expect(r.quality).toBe("delayed");
    expect(r.source).toBe("px");
  });

  it("reports the attempts that led to the answer", async () => {
    const { history } = setup([
      source({
        id: "dead",
        priority: 0,
        loadBars: async () => {
          throw new Error("503");
        },
      }),
      source({ id: "alive", priority: 1 }),
    ]);
    const r = await history.load("BTCUSDT", "1h", { limit: 50 });
    expect(r.source).toBe("alive");
    expect(r.attempts.map((a) => a.source)).toEqual(["dead", "alive"]);
  });
});

describe("degradation", () => {
  it("falls back to STALE archived bars when every source is down, and says so", async () => {
    // Stale-but-labelled beats an empty chart; the freshness contract marks it.
    let t = NOW;
    let alive = true;
    const { history } = setup(
      [
        source({
          id: "net",
          loadBars: async () => {
            if (!alive) throw new Error("vendor down");
            return bars(t, 100);
          },
        }),
      ],
      () => t,
    );

    await history.load("BTCUSDT", "1h", { limit: 100 });
    alive = false;
    t += 50 * H; // cache is now far too old to be a fresh hit

    const r = await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(r.bars.length).toBeGreaterThan(0);
    expect(r.fromCache).toBe(true);
    expect(r.attempts.some((a) => !a.ok)).toBe(true);
  });

  /*
   * "NO NETWORK" NOW INCLUDES THE DURABLE ARCHIVE. Since v60.3 the history
   * service falls back to the server's copy when every vendor fails, so a
   * scenario meaning "nothing anywhere has these bars" has to say so —
   * `DOWN` below. The first version of this test failed the SOURCES while
   * leaving `fetch` stubbed to answer, and the service duly reported a
   * hundred bars in the one case that must return none.
   */
  it("returns an honest empty result when there is no network AND no archive", async () => {
    const { history } = setup([
      source({
        id: "net",
        loadBars: async () => {
          throw new Error("down");
        },
      }),
    ]);
    const r = await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(r.bars).toEqual([]);
    expect(r.source).toBe("none");
    expect(r.coverage).toBe(0);
    expect(r.gaps).toHaveLength(1);
  });

  /*
   * THE STATE A FRESH BROWSER STARTS IN. No local archive, and suppose the
   * vendor is down too — before v60.3 that was an empty chart and an operator
   * with nothing to backtest on, because every bar this product had ever held
   * lived in one profile's IndexedDB. The durable copy is the reason it is
   * recoverable, and it is reported as cached rather than as live.
   */
  it("falls back to the durable server archive when every vendor is down", async () => {
    const stored = [
      { t: NOW - 2 * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: NOW - H, o: 1.5, h: 2.5, l: 1, c: 2, v: 11 },
    ];
    const { history } = setup(
      [
        source({
          id: "net",
          loadBars: async () => {
            throw new Error("down");
          },
        }),
      ],
      () => NOW,
      { read: async () => stored, write: () => {} },
    );

    const r = await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(r.bars).toEqual(stored);
    expect(r.fromCache, "a stored bar is not a live one").toBe(true);
    expect(r.attempts.some((a) => a.source === "server archive" && a.ok)).toBe(true);
  });

  /*
   * A TEST MUST NOT BE ABLE TO WRITE TO THE OPERATOR'S DATABASE.
   *
   * It did. MEASURED: a vitest run with `python run.py` up put fixture series
   * called `net`, `a`, `alive`, `px` and `b`, dated 2027, into the live
   * `server/mishel.db` beside the real BTCUSDT history — 535 rows of invented
   * candles in the archive the backtests read. `createHistory` defaulted to the
   * live `/svc/bars` client, and the global `fetch` in this environment reaches
   * a running gateway.
   *
   * The fix is a shape, not a stub: the default is INERT and `data/feed.ts`
   * opts in once. This pins it, because the next person to add a test that
   * builds a history service will not know any of the above.
   */
  it("cannot reach the operator's durable archive unless a caller opts in", async () => {
    const archive = createArchive(memoryBackend());
    const registry = createRegistry([source({ id: "net" })], createBreaker({ now: () => NOW }));
    /* No fourth argument — exactly how a new test would write it. */
    const history = createHistory(registry, archive, () => NOW);

    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ bars: [] }) } as Response);
    });

    await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(calls.filter((u) => u.includes("/svc/bars"))).toEqual([]);
  });

  it("mirrors a warm local archive to the durable copy, so it is not only what arrived later", async () => {
    const written: number[] = [];
    const { history } = setup([source({ id: "net" })], () => NOW, {
      read: async () => [],
      write: (_s, _y, _t, bars) => {
        written.push(bars.length);
      },
    });

    await history.load("BTCUSDT", "1h", { limit: 100 });
    expect(written.length, "a fetch must reach the durable copy").toBeGreaterThan(0);
  });
});

describe("provenance isolation", () => {
  it("never merges demo bars into a real series", async () => {
    // A model trained on synthetic candles blended with real ones is worse than
    // one with no data, because it looks trained.
    const { history, archive } = setup([source({ id: "net" })]);
    await history.load("BTCUSDT", "1h", { limit: 100 });
    await history.record("BTCUSDT", "1h", "demo", "demo", bars(NOW, 50));

    const real = await archive.read(
      { source: "net", symbol: "BTCUSDT", timeframe: "1h" },
      { from: 0, to: NOW },
      H,
    );
    expect(real.containsDemo).toBe(false);

    const fake = await archive.read(
      { source: "demo", symbol: "BTCUSDT", timeframe: "1h" },
      { from: 0, to: NOW },
      H,
    );
    expect(fake.containsDemo).toBe(true);
  });

  it("keeps each source's archive separate", async () => {
    const { history, archive } = setup([
      source({ id: "a", priority: 0, supports: (s) => s === "BTCUSDT" }),
      source({ id: "b", priority: 1, loadBars: async () => bars(NOW, 30) }),
    ]);

    await history.load("BTCUSDT", "1h", { limit: 100 });
    await history.load("EURUSD", "1h", { limit: 30 });

    expect(await archive.coverage({ source: "a", symbol: "EURUSD", timeframe: "1h" }, H)).toEqual([]);
    expect(
      (await archive.coverage({ source: "b", symbol: "EURUSD", timeframe: "1h" }, H)).length,
    ).toBe(1);
  });
});

describe("record", () => {
  it("persists live bars so a reload keeps them", async () => {
    const { history, archive } = setup([source({ id: "net" })]);
    await history.record("BTCUSDT", "1h", "net", "live", bars(NOW, 5));
    const r = await archive.read(
      { source: "net", symbol: "BTCUSDT", timeframe: "1h" },
      { from: 0, to: NOW },
      H,
    );
    expect(r.bars).toHaveLength(5);
  });

  it("ignores an empty write", async () => {
    const { history, archive } = setup([source({ id: "net" })]);
    await history.record("BTCUSDT", "1h", "net", "live", []);
    expect((await archive.stats()).bars).toBe(0);
  });
});

describe("backfill", () => {
  it("walks backwards until the target is met", async () => {
    let pages = 0;
    const { history, archive } = setup([
      source({
        id: "net",
        loadBars: async (_s, _tf, o) => {
          // Newest page first request has no `from`; backfill always passes one.
          if (o.from === undefined) return bars(NOW, 200);
          pages++;
          return bars(o.to as number, 200);
        },
      }),
    ]);

    await history.load("BTCUSDT", "1h", { limit: 200 });
    const added = await history.backfill("BTCUSDT", "1h", 600);

    expect(added).toBeGreaterThanOrEqual(400);
    expect(pages).toBeGreaterThan(0);
    const stats = await archive.stats();
    expect(stats.bars).toBeGreaterThanOrEqual(600);
  });

  it("stops when the vendor has no more history instead of looping", async () => {
    const load = vi.fn(async (_s: string, _tf: string, o: { from?: number }) =>
      o.from === undefined ? bars(NOW, 100) : [],
    );
    const { history } = setup([source({ id: "net", loadBars: load as DataSource["loadBars"] })]);

    await history.load("BTCUSDT", "1h", { limit: 100 });
    const added = await history.backfill("BTCUSDT", "1h", 100_000);
    expect(added).toBe(0);
    // One empty page is enough to conclude; it must not spin to the guard.
    expect(load.mock.calls.filter((c) => c[2]?.from !== undefined)).toHaveLength(1);
  });

  it("reports progress as it goes", async () => {
    const seen: number[] = [];
    const { history } = setup([
      source({
        id: "net",
        loadBars: async (_s, _tf, o) =>
          o.from === undefined ? bars(NOW, 100) : bars(o.to as number, 100),
      }),
    ]);
    await history.load("BTCUSDT", "1h", { limit: 100 });
    await history.backfill("BTCUSDT", "1h", 400, { onProgress: (a) => seen.push(a) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(300);
  });

  it("stops promptly when aborted", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const { history } = setup([
      source({
        id: "net",
        loadBars: async (_s, _tf, o) => {
          if (o.from === undefined) return bars(NOW, 100);
          calls++;
          ctl.abort();
          return bars(o.to as number, 100);
        },
      }),
    ]);
    await history.load("BTCUSDT", "1h", { limit: 100 });
    await history.backfill("BTCUSDT", "1h", 100_000, { signal: ctl.signal });
    expect(calls).toBe(1);
  });

  it("does nothing for a symbol no source covers", async () => {
    const { history } = setup([source({ id: "net", supports: () => false })]);
    expect(await history.backfill("NOPE", "1h", 500)).toBe(0);
  });
});
