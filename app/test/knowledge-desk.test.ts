// @vitest-environment jsdom
/**
 * The Knowledge desk.
 *
 * WHAT IS WORTH ASSERTING ABOUT A TABLE
 * Not that it has rows. What this file pins down is the three things that make
 * the difference between a research table and a slot machine:
 *
 *  1. an unmeasured cell WITHHOLDS its rates — an em dash, not a dimmed
 *     number, because a dimmed number still gets read;
 *  2. the colour follows the STANDING and never the magnitude, so a table
 *     sorted by expectancy still has grey at the top when the top row is four
 *     trials;
 *  3. stale is a WORD on the row, not a tint.
 *
 * Plus the empty state, which is the first thing most people will ever see of
 * this desk, and the harvest button actually harvesting.
 */

import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createKnowledgeBase, buildEntry, contextAt, STALE_AFTER_MS, type TrialFact } from "../src/learn/knowledge";
import { createKnowledge } from "../src/ui/knowledge";
import { DEFAULT_DETECTORS } from "../src/detect/index";
import type { BarView } from "../src/chart/series";
import type { HistoryResult, HistoryService } from "../src/data/history";

const AT = Date.UTC(2024, 0, 3, 13, 0, 0);
const NOW = Date.UTC(2024, 0, 3, 15, 0, 0);

function trials(n: number, wins: number): TrialFact[] {
  return Array.from({ length: n }, (_, i) => ({
    at: AT,
    outcome: i < wins ? ("target" as const) : ("stop" as const),
    r: i < wins ? 2 : -1,
    heldBars: 7,
    context: contextAt(AT, "trend"),
  }));
}

function seed(base: ReturnType<typeof createKnowledgeBase>, opts: { n: number; wins: number; at: number; symbol: string }): void {
  const e = buildEntry(
    {
      source: "replay",
      symbol: opts.symbol,
      timeframe: "1h",
      kind: "choch",
      direction: "long",
      bars: 5900,
      rMultiple: 2,
      trials: trials(opts.n, opts.wins),
    },
    opts.at,
  );
  if (e === null) throw new Error("fixture produced no entry");
  base.merge([e]);
}

function walk(n: number, seedValue = 24601): BarView[] {
  let s = seedValue;
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

const history = (bars: BarView[]): HistoryService => ({
  load: async (): Promise<HistoryResult> => ({
    bars,
    source: "fixture",
    quality: "ok",
    fromCache: true,
    gaps: [],
    coverage: 1,
    containsDemo: false,
    attempts: [],
  }),
  record: async () => undefined,
  backfill: async () => 0,
});

function desk(base: ReturnType<typeof createKnowledgeBase>, bars = walk(1400)) {
  return createKnowledge({
    base,
    history: history(bars),
    symbol: signal("BTCUSDT"),
    timeframe: signal("1h"),
    detectors: () => DEFAULT_DETECTORS,
    minStopAtr: () => 0.5,
  });
}

const openBase = () => createKnowledgeBase(createKV(memoryRawStore()), () => NOW);

describe("the empty state", () => {
  it("invites a harvest rather than saying no data", () => {
    const el = desk(openBase()).el;
    const empty = el.querySelector(".kb-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("Nothing has been learned from the past yet");
    /* It says what a harvest READS and what it costs, which is the part that
       turns a dead end into a next step. */
    expect(empty?.textContent).toContain("no vendor requests unless you ask");
    expect(el.querySelector(".kb-table")).toBeNull();
    /* And the button is present in the empty state, not only afterwards. */
    expect(el.querySelector(".kb-go")?.textContent).toBe("Learn from history");
  });
});

describe("the table", () => {
  it("withholds every rate on a cell under the floor, and greys the row", () => {
    const base = openBase();
    seed(base, { n: 5, wins: 4, at: NOW, symbol: "BTCUSDT" });
    const el = desk(base).el;

    const row = el.querySelector(".kb-row:not(.kb-header):not(.kb-filters)");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-standing")).toBe("thin");

    /* The sample is printed; everything to its right is an em dash. 4 of 5 is
       an 80% hit rate and it is not on screen anywhere. */
    expect(row?.querySelector(".kb-trials")?.textContent).toBe("5");
    expect(row?.textContent).not.toContain("80%");
    const dashes = [...(row?.querySelectorAll(".kb-cell") ?? [])].filter((c) => c.textContent === "—");
    expect(dashes).toHaveLength(4);
  });

  it("colours on the lower bound against break-even, not on the rate", () => {
    /* 30 of 44 is a 68% hit rate at 2R, whose break-even is 33%. The Wilson
       lower bound is 0.5344… (computed independently), which clears it, so the
       row stands as "clears". */
    const strong = openBase();
    seed(strong, { n: 44, wins: 30, at: NOW, symbol: "BTCUSDT" });
    expect(
      desk(strong).el.querySelector(".kb-row:not(.kb-header):not(.kb-filters)")?.getAttribute("data-standing"),
    ).toBe("clears");

    /* 8 of 20 is a 40% hit rate — still above the 33% break-even on the point
       estimate — but the lower bound is 0.2178…, which is not. "Short", not
       "clears": the point estimate is what a reader supplies for themselves
       and it is the one number this table refuses to colour. */
    const weak = openBase();
    seed(weak, { n: 20, wins: 8, at: NOW, symbol: "BTCUSDT" });
    expect(
      desk(weak).el.querySelector(".kb-row:not(.kb-header):not(.kb-filters)")?.getAttribute("data-standing"),
    ).toBe("short");
  });

  it("says STALE in a word", () => {
    const base = openBase();
    seed(base, { n: 44, wins: 30, at: NOW - STALE_AFTER_MS - 86_400_000, symbol: "BTCUSDT" });
    const row = desk(base).el.querySelector(".kb-row:not(.kb-header):not(.kb-filters)");
    expect(row?.getAttribute("data-stale")).toBe("true");
    expect(row?.querySelector(".kb-stale")?.textContent).toBe("STALE");
  });

  it("shows one axis at a time and can be switched", () => {
    const base = openBase();
    seed(base, { n: 44, wins: 30, at: NOW, symbol: "BTCUSDT" });
    const el = desk(base).el;

    /* Regime by default: one row, the condition the trials happened in. */
    const first = el.querySelectorAll(".kb-row:not(.kb-header):not(.kb-filters)");
    expect(first).toHaveLength(1);
    expect(first[0]?.querySelector(".kb-cond")?.textContent).toBe("Trending");

    const buttons = [...el.querySelectorAll(".kb-axis .seg-btn")] as HTMLButtonElement[];
    const session = buttons.find((b) => b.textContent === "Session");
    session?.click();
    /* Effects in this graph repaint on a FRAME, not synchronously — the same
       property `learn/store.ts` records about its own persistence. A test that
       read the DOM in the click's own tick would be asserting the frame before
       the one the user sees. */
    flushFrames();

    const rows = [...el.querySelectorAll(".kb-row:not(.kb-header):not(.kb-filters)")];
    /* 13:00 UTC is inside London and New York both. Two rows, and they are the
       two sessions — the axis is not a partition and the desk does not pretend
       it is. */
    expect(rows.map((r) => r.querySelector(".kb-cond")?.textContent).sort()).toEqual(["London", "New York"]);
  });
});

describe("the harvest button", () => {
  it("runs a harvest and fills the table", async () => {
    const base = openBase();
    const handle = desk(base);
    expect(handle.el.querySelector(".kb-empty")).not.toBeNull();

    (handle.el.querySelector(".kb-go") as HTMLButtonElement).click();

    /* The pass yields through `scheduleFrame`, which falls back to a timer, so
       waiting here is waiting on real chunks rather than on a mock. */
    const deadline = Date.now() + 8000;
    while (base.entries().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(base.entries().length).toBeGreaterThan(0);
    flushFrames();
    expect(handle.el.querySelector(".kb-empty")).toBeNull();
    expect(handle.el.querySelector(".kb-table")).not.toBeNull();
  }, 20_000);
});
