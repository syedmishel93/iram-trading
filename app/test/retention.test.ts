import { describe, it, expect } from "vitest";
import {
  planRetention,
  applyRetention,
  ruleFor,
  DEFAULT_POLICY,
  DEFAULT_RETENTION,
  fmtBytes,
  fmtAge,
  type RetentionPolicy,
} from "../src/store/retention";
import { createArchive, memoryBackend, type SeriesInventory } from "../src/store/barstore";
import type { BarView } from "../src/chart/series";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T00:00:00Z");

function series(over: Partial<SeriesInventory> = {}): SeriesInventory {
  const bars = over.bars ?? 10_000;
  return {
    key: "binance|BTCUSDT|1m",
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "1m",
    segments: 2,
    bars,
    approxBytes: bars * 48,
    oldest: NOW - 60 * DAY,
    newest: NOW,
    qualities: ["live"],
    lastFetched: NOW,
    ...over,
  };
}

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  ...DEFAULT_POLICY,
  ...over,
});

describe("the shipped policy", () => {
  it("keeps daily and weekly bars forever", () => {
    // 17 KB a year. They are also the only series long enough to contain more
    // than one market regime, which is what a decade-long walk-forward needs.
    expect(ruleFor(DEFAULT_RETENTION, "1d").keepMs).toBeNull();
    expect(ruleFor(DEFAULT_RETENTION, "1w").keepMs).toBeNull();
  });

  it("keeps less of a fast timeframe than a slow one", () => {
    const oneMin = ruleFor(DEFAULT_RETENTION, "1m").keepMs!;
    const oneHour = ruleFor(DEFAULT_RETENTION, "1h").keepMs!;
    expect(oneMin).toBeLessThan(oneHour);
  });

  it("has a catch-all for a timeframe nobody anticipated", () => {
    const rule = ruleFor(DEFAULT_RETENTION, "7h");
    expect(rule.timeframe).toBe("*");
    expect(rule.keepMs).not.toBeNull();
  });
});

describe("planning retention", () => {
  it("trims a series with bars older than its window", () => {
    const plan = planRetention([series({ bars: 86_400 })], policy(), NOW);
    const action = plan.changes[0]!;
    expect(action.kind).toBe("trim");
    expect(action.cutoff).toBe(NOW - 30 * DAY);
    expect(action.bars).toBeGreaterThan(0);
    expect(action.reason).toMatch(/1m keeps 30 days/);
  });

  it("keeps a series entirely inside its window", () => {
    const plan = planRetention(
      [series({ oldest: NOW - 5 * DAY, newest: NOW })],
      policy(),
      NOW,
    );
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary).toMatch(/Nothing to remove/);
  });

  it("NEVER touches a pinned series", () => {
    // A study depending on this series must not have its data evicted out from
    // under it by a background sweep — the study would silently re-run on less
    // data and produce a different number with no explanation.
    const s = series({ bars: 86_400, oldest: NOW - 900 * DAY });
    const plan = planRetention([s], policy({ pinned: [s.key] }), NOW);
    expect(plan.changes).toHaveLength(0);
    expect(plan.actions[0]!.reason).toMatch(/pinned/);
  });

  it("leaves a floor of bars rather than creating a useless remnant", () => {
    // A 40-bar series is not a cheaper series; it is a broken one still
    // claiming coverage.
    const s = series({ bars: 400, oldest: NOW - 900 * DAY, newest: NOW - 800 * DAY });
    const plan = planRetention([s], policy({ minBarsPerSeries: 300 }), NOW);
    const action = plan.changes[0];
    if (action) expect(s.bars - action.bars).toBeGreaterThanOrEqual(300);
  });

  it("expires generated demo data fast, whatever its timeframe says", () => {
    const s = series({
      timeframe: "1d",
      qualities: ["demo"],
      source: "demo",
      oldest: NOW - 10 * DAY,
      newest: NOW,
      bars: 5000,
    });
    const plan = planRetention([s], policy(), NOW);
    expect(plan.changes[0]!.kind).toBe("trim");
    expect(plan.changes[0]!.reason).toMatch(/generated bars have no research value/);
  });

  it("drops the COLDEST series first when over budget", () => {
    const warm = series({ key: "binance|BTC|1d", timeframe: "1d", lastFetched: NOW, bars: 50_000 });
    const cold = series({
      key: "binance|DOGE|1d",
      symbol: "DOGE",
      timeframe: "1d",
      lastFetched: NOW - 200 * DAY,
      bars: 50_000,
    });
    const plan = planRetention([warm, cold], policy({ maxBytes: 3_000_000 }), NOW);
    const dropped = plan.changes.filter((c) => c.kind === "drop");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.key).toBe("binance|DOGE|1d");
    expect(dropped[0]!.reason).toMatch(/coldest series/);
    expect(plan.overBudget).toBe(true);
  });

  it("will not drop a pinned series even to get under budget", () => {
    const s = series({ timeframe: "1d", bars: 500_000 });
    const plan = planRetention([s], policy({ maxBytes: 1000, pinned: [s.key] }), NOW);
    expect(plan.changes).toHaveLength(0);
  });

  it("reports the space it would free before anything is deleted", () => {
    // Deletion you cannot preview is deletion you will eventually regret, and
    // some of this history is not re-downloadable at any price.
    const plan = planRetention([series({ bars: 86_400 })], policy(), NOW);
    expect(plan.bytesFreed).toBeGreaterThan(0);
    expect(plan.bytesAfter).toBe(plan.bytesBefore - plan.bytesFreed);
    expect(plan.summary).toMatch(/freed/);
  });

  it("plans nothing for an empty archive", () => {
    const plan = planRetention([], policy(), NOW);
    expect(plan.changes).toHaveLength(0);
    expect(plan.bytesBefore).toBe(0);
  });
});

describe("applying retention", () => {
  const hourly = (n: number, endAt: number): BarView[] =>
    Array.from({ length: n }, (_, i) => {
      const t = endAt - (n - 1 - i) * 3_600_000;
      return { t, o: 100, h: 101, l: 99, c: 100, v: 1 };
    });

  it("removes only the bars before the cutoff", async () => {
    const archive = createArchive(memoryBackend());
    const key = { source: "binance", symbol: "BTCUSDT", timeframe: "1h" };
    await archive.write(key, hourly(1000, NOW), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    const cutoff = NOW - 100 * 3_600_000;
    const removed = await archive.prune(key, cutoff);
    expect(removed).toBe(899);

    const read = await archive.read(key, { from: 0, to: NOW }, 3_600_000);
    expect(read.bars).toHaveLength(101);
    expect(read.bars[0]!.t).toBe(cutoff);
  });

  it("rewrites the segment that straddles the cutoff instead of deleting it", async () => {
    // Deleting the straddler wholesale would silently discard up to 5,000 bars
    // the policy said to KEEP, and the archive would then report full coverage
    // of a range it had just thrown away.
    const archive = createArchive(memoryBackend());
    const key = { source: "binance", symbol: "ETHUSDT", timeframe: "1h" };
    await archive.write(key, hourly(500, NOW), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    await archive.prune(key, NOW - 10 * 3_600_000);
    const inv = await archive.inventory();
    expect(inv[0]!.bars).toBe(11);
    expect(inv[0]!.oldest).toBe(NOW - 10 * 3_600_000);
  });

  it("executes a plan and reports what it actually removed", async () => {
    const archive = createArchive(memoryBackend());
    const key = { source: "binance", symbol: "BTCUSDT", timeframe: "1h" };
    await archive.write(key, hourly(2000, NOW), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    const inventory = await archive.inventory();
    const plan = planRetention(
      inventory,
      policy({ rules: [{ timeframe: "1h", keepMs: 100 * 3_600_000, why: "test" }] }),
      NOW,
    );
    const result = await applyRetention(archive, plan);

    expect(result.applied).toBe(1);
    expect(result.barsRemoved).toBeGreaterThan(1800);
    expect(result.errors).toHaveLength(0);
    expect((await archive.inventory())[0]!.bars).toBe(101);
  });

  it("carries on past a failing series instead of abandoning the sweep", async () => {
    // The next one may be the large cold series that actually frees the space.
    const archive = createArchive(memoryBackend());
    const broken = {
      ...archive,
      prune: async () => {
        throw new Error("backend exploded");
      },
    };
    const plan = planRetention([series({ bars: 86_400 })], policy(), NOW);
    const result = await applyRetention(broken, plan);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe("backend exploded");
  });

  it("reports per-series detail the desk can list", async () => {
    const archive = createArchive(memoryBackend());
    await archive.write(
      { source: "binance", symbol: "BTCUSDT", timeframe: "1h" },
      hourly(100, NOW),
      { source: "binance", quality: "live", fetchedAt: 12345 },
    );
    const inv = await archive.inventory();
    expect(inv[0]!.symbol).toBe("BTCUSDT");
    expect(inv[0]!.timeframe).toBe("1h");
    expect(inv[0]!.qualities).toEqual(["live"]);
    expect(inv[0]!.lastFetched).toBe(12345);
    expect(inv[0]!.approxBytes).toBe(100 * 48);
  });
});

describe("formatting", () => {
  it("reads bytes the way a person would say them", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(512 * 1024 * 1024)).toBe("512 MB");
  });

  it("reads ages the way a person would say them", () => {
    expect(fmtAge(30 * DAY)).toBe("30 days");
    expect(fmtAge(365 * DAY)).toBe("1 year");
    expect(fmtAge(3 * 365 * DAY)).toBe("3 years");
  });
});
