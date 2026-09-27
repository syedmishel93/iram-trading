/**
 * The harvest pass.
 *
 * WHAT IS TESTED HERE IS NOT THE REPLAY. `setup/simulate.ts` and
 * `setup/deep.ts` own that and have their own suites, and this file
 * deliberately does not re-assert their arithmetic — a second opinion about
 * what a win is would be the very duplication `harvest.ts` exists to avoid.
 *
 * What is tested is everything AROUND the replay, all of which is the part
 * that can fail silently:
 *
 *  - it yields between chunks rather than running an instrument in one go,
 *    which is the difference between a progress bar and a frozen terminal;
 *  - it reports progress that matches what it is actually doing;
 *  - cancel stops it AND keeps what was already replayed, because a
 *    destructive cancel is one nobody presses;
 *  - it touches no vendor unless asked;
 *  - running it twice over the same archive does not double the base.
 *
 * NO NETWORK. The history service is a fixture with a synthetic series —
 * synthetic because the shape of the bars is irrelevant to every property
 * above, and a test that needs a vendor is a test that fails on a Sunday.
 */

import { describe, expect, it, vi } from "vitest";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createKnowledgeBase } from "../src/learn/knowledge";
import { runHarvest, type HarvestHandle } from "../src/learn/harvest";
import { DEFAULT_DETECTORS } from "../src/detect/index";
import type { BarView } from "../src/chart/series";
import type { HistoryResult, HistoryService } from "../src/data/history";

/** A seeded walk. Seeded so two runs of the suite replay the same trials. */
function walk(n: number, seed = 24601): BarView[] {
  let s = seed;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
  const out: BarView[] = [];
  let p = 30_000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = Math.max(1, p + (rnd() - 0.5) * p * 0.006);
    out.push({
      t: Date.UTC(2024, 0, 1) + i * 3_600_000,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.002),
      l: Math.min(o, c) * (1 - rnd() * 0.002),
      c,
      v: 1000,
    });
    p = c;
  }
  return out;
}

const result = (bars: BarView[]): HistoryResult => ({
  bars,
  source: "fixture",
  quality: "ok",
  fromCache: true,
  gaps: [],
  coverage: 1,
  containsDemo: false,
  attempts: [],
});

interface Fixture {
  readonly history: HistoryService;
  readonly loads: string[];
  readonly backfills: string[];
}

function fixture(bars = 1400): Fixture {
  const loads: string[] = [];
  const backfills: string[] = [];
  const series = walk(bars);
  const history: HistoryService = {
    load: async (symbol, timeframe) => {
      loads.push(`${symbol} ${timeframe}`);
      return result(series);
    },
    record: async () => undefined,
    backfill: async (symbol, timeframe) => {
      backfills.push(`${symbol} ${timeframe}`);
      return 0;
    },
  };
  return { history, loads, backfills };
}

const openBase = () => createKnowledgeBase(createKV(memoryRawStore()));

interface Driver {
  readonly yieldTo: (job: () => void) => () => void;
  readonly chunks: () => number;
}

/**
 * A synchronous scheduler standing in for `scheduleFrame`.
 *
 * `onChunk` runs BEFORE the job, which is the only way a test can cancel
 * mid-flight — that is exactly the ordering `breathe` has to survive.
 */
function driver(onChunk?: (n: number) => void): Driver {
  let n = 0;
  return {
    yieldTo: (job) => {
      n += 1;
      onChunk?.(n);
      job();
      return () => undefined;
    },
    chunks: () => n,
  };
}

const base = (fx: Fixture, over: Partial<Parameters<typeof runHarvest>[0]> = {}) => ({
  history: fx.history,
  base: openBase(),
  targets: [{ symbol: "BTCUSDT", timeframe: "1h" }],
  detectors: DEFAULT_DETECTORS,
  rMultiple: 2,
  minStopAtr: 0.5,
  ...over,
});

describe("harvest chunking", () => {
  it("hands the frame back between the steps of one instrument", async () => {
    const fx = fixture();
    const d = driver();
    const run = runHarvest({ ...base(fx), yieldTo: d.yieldTo });
    await run.done;
    /* Two seams inside one instrument: before labelling the conditions and
       before replaying. One chunk would mean the whole 20 ms ran in one go. */
    expect(d.chunks()).toBeGreaterThanOrEqual(2);
  });

  it("yields between instruments as well as inside them", async () => {
    const fx = fixture();
    const one = driver();
    await runHarvest({ ...base(fx), yieldTo: one.yieldTo }).done;

    const two = driver();
    await runHarvest({
      ...base(fx, {
        targets: [
          { symbol: "BTCUSDT", timeframe: "1h" },
          { symbol: "ETHUSDT", timeframe: "1h" },
        ],
      }),
      yieldTo: two.yieldTo,
    }).done;

    expect(two.chunks()).toBeGreaterThan(one.chunks());
  });

  it("reports which instrument it is on, and how far through", async () => {
    const fx = fixture();
    const seen: string[] = [];
    let run: HarvestHandle | null = null;
    /* Sampled at each yield, which is exactly where a panel would read it. */
    const d = driver(() => {
      const p = run?.progress();
      if (p && p.total > 0) seen.push(`${p.done}/${p.total} ${p.symbol} ${p.timeframe}`);
    });
    run = runHarvest({
      ...base(fx, {
        targets: [
          { symbol: "BTCUSDT", timeframe: "1h" },
          { symbol: "ETHUSDT", timeframe: "4h" },
        ],
      }),
      yieldTo: d.yieldTo,
    });
    const report = await run.done;

    expect(seen[0]).toBe("0/2 BTCUSDT 1h");
    /* The counter moves on, and it names the second instrument by its OWN
       timeframe — a progress line that kept the first one would be describing
       a read nobody is doing. */
    expect(seen).toContain("1/2 ETHUSDT 4h");
    expect(report.rows.map((r) => `${r.symbol} ${r.timeframe}`)).toEqual([
      "BTCUSDT 1h",
      "ETHUSDT 4h",
    ]);
    expect(report.rows.every((r) => r.state === "ok")).toBe(true);
    /* Idle once finished: a progress line left on screen after the pass ends
       is a terminal that looks busy for ever. */
    expect(run.running()).toBe(false);
    expect(run.progress().total).toBe(0);
  });
});

describe("what a harvest touches", () => {
  it("reads the archive and never pages a vendor unless asked", async () => {
    const fx = fixture();
    await runHarvest({ ...base(fx), yieldTo: driver().yieldTo }).done;
    expect(fx.loads).toEqual(["BTCUSDT 1h"]);
    expect(fx.backfills).toEqual([]);
  });

  it("pages the vendor only when reaching further back is asked for", async () => {
    const fx = fixture();
    await runHarvest({ ...base(fx, { backfill: true }), yieldTo: driver().yieldTo }).done;
    expect(fx.backfills).toEqual(["BTCUSDT 1h"]);
  });

  it("refuses an instrument with too little history, and says why", async () => {
    const fx = fixture(120);
    const report = await runHarvest({ ...base(fx), yieldTo: driver().yieldTo }).done;
    expect(report.rows[0]?.state).toBe("short");
    expect(report.rows[0]?.note).toContain("under the 300");
    expect(report.merged).toBeNull();
  });

  it("turns one dead instrument into a row rather than an exception", async () => {
    const fx = fixture();
    const broken: HistoryService = {
      ...fx.history,
      load: vi.fn(async (symbol: string) => {
        if (symbol === "DEAD") throw new Error("the data proxy is not answering on this address");
        return fx.history.load(symbol, "1h");
      }) as HistoryService["load"],
    };
    const report = await runHarvest({
      ...base(fx, {
        targets: [
          { symbol: "DEAD", timeframe: "1h" },
          { symbol: "BTCUSDT", timeframe: "1h" },
        ],
      }),
      history: broken,
      yieldTo: driver().yieldTo,
    }).done;

    expect(report.rows[0]?.state).toBe("failed");
    expect(report.rows[0]?.note).toBe("the data proxy is not answering on this address");
    /* And the second instrument still ran. */
    expect(report.rows[1]?.state).toBe("ok");
  });
});

describe("cancel", () => {
  it("stops the rest and keeps what was already replayed", async () => {
    const fx = fixture();
    let run: HarvestHandle | null = null;
    /* Cancel on the third yield — inside the first instrument's chunking, so
       the second instrument is never read at all. */
    const d = driver((n) => {
      if (n === 3) run?.cancel();
    });
    run = runHarvest({
      ...base(fx, {
        targets: [
          { symbol: "BTCUSDT", timeframe: "1h" },
          { symbol: "ETHUSDT", timeframe: "1h" },
        ],
      }),
      yieldTo: d.yieldTo,
    });
    const report = await run.done;

    expect(report.cancelled).toBe(true);
    expect(report.rows[1]?.state).toBe("cancelled");
    expect(fx.loads).toEqual(["BTCUSDT 1h"]);
    /* The first instrument finished before the cancel landed, so its work is
       in the base. A cancel that threw it away would be a cancel nobody
       presses. */
    expect(report.rows[0]?.state).toBe("ok");
    expect(report.note).toContain("Stopped early");
    expect(run.running()).toBe(false);
  });
});

describe("running it twice", () => {
  it("does not double the base", async () => {
    const fx = fixture();
    const shared = openBase();

    const first = await runHarvest({ ...base(fx, { base: shared }), yieldTo: driver().yieldTo }).done;
    expect(first.merged?.added).toBeGreaterThan(0);
    const cellsAfterOne = shared.cells("all").map((c) => `${c.kind}|${c.direction}|${c.trials}`).sort();

    const second = await runHarvest({ ...base(fx, { base: shared }), yieldTo: driver().yieldTo }).done;
    /* Every study is recognised as one already held. Nothing added, nothing
       replaced, and no trial counted twice. */
    expect(second.merged?.added).toBe(0);
    expect(second.merged?.replaced).toBe(0);
    expect(second.merged?.unchanged).toBe(first.merged?.added);

    const cellsAfterTwo = shared.cells("all").map((c) => `${c.kind}|${c.direction}|${c.trials}`).sort();
    expect(cellsAfterTwo).toEqual(cellsAfterOne);
  });

  it("files trials under the conditions they happened in", async () => {
    const fx = fixture();
    const shared = openBase();
    await runHarvest({ ...base(fx, { base: shared }), yieldTo: driver().yieldTo }).done;

    const axes = new Set(shared.cells().map((c) => c.axis));
    /* Every axis is populated, and none of them is the intersection of two —
       that is the whole storage model. */
    expect([...axes].sort()).toEqual(["all", "hour", "regime", "session", "weekday"]);

    /* A regime cell's trials can never exceed the instrument's own total: the
       regime axis IS a partition, even though the session axis is not. */
    for (const all of shared.cells("all")) {
      const total = shared
        .cells("regime")
        .filter((c) => c.kind === all.kind && c.direction === all.direction)
        .reduce((s, c) => s + c.trials, 0);
      expect(total).toBe(all.trials);
    }
  });
});
