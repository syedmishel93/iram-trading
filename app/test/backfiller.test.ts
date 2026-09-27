/**
 * The auto-backfill guards.
 *
 * Each of these exists because removing it produces a specific, reproducible
 * failure — an unbounded loop against a vendor, thirty overlapping fetches from
 * one drag, or one symbol's history applied to another's chart. They were
 * untestable while they lived inside `mountShell`, which is the whole reason
 * the logic moved.
 */

import { describe, expect, it, vi } from "vitest";
import { createBackfiller, HISTORY_MAX, type BackfillDeps } from "../src/data/backfill";

/** A harness whose bar count grows by `grows` on each successful reload. */
function harness(over: Partial<BackfillDeps> & { grows?: number } = {}) {
  let count = over.barCount ? over.barCount() : 800;
  const grows = over.grows ?? 800;
  const notes: string[] = [];
  const pending: boolean[] = [];
  const deps: BackfillDeps = {
    loadedSymbol: () => "BTCUSDT",
    loadedTimeframe: () => "1h",
    barCount: () => count,
    oldestBarTime: () => 1_700_000_000_000,
    replayActive: () => false,
    backfill: vi.fn(async () => undefined),
    reload: vi.fn(async () => {
      count += grows;
    }),
    note: (e) => notes.push(e.text),
    setPending: (on) => pending.push(on),
    ...over,
  };
  return { deps, notes, pending, count: () => count, b: createBackfiller(deps) };
}

describe("re-entrancy", () => {
  it("collapses a whole drag into one fetch", async () => {
    // The chart's edge callback fires on every pan frame. Without the latch,
    // one drag launches thirty overlapping fetches of the same window.
    const h = harness();
    await Promise.all(Array.from({ length: 30 }, () => h.b.loadOlder()));
    expect(h.deps.backfill).toHaveBeenCalledTimes(1);
  });

  it("allows a second fetch once the first has finished", async () => {
    const h = harness();
    await h.b.loadOlder();
    await h.b.loadOlder();
    expect(h.deps.backfill).toHaveBeenCalledTimes(2);
  });
});

describe("exhaustion", () => {
  it("stops asking once a fetch returns nothing new", async () => {
    // A vendor with no more history answers "more" with the same bars. Retrying
    // that on every pan frame is an unbounded loop against a rate limit.
    const h = harness({ grows: 0 });
    await h.b.loadOlder();
    await h.b.loadOlder();
    await h.b.loadOlder();
    expect(h.deps.backfill).toHaveBeenCalledTimes(1);
    expect(h.b.isExhausted("BTCUSDT", "1h")).toBe(true);
  });

  it("says where the history actually ends, rather than going quiet", async () => {
    const h = harness({ grows: 0 });
    await h.b.loadOlder();
    expect(h.notes[0]).toContain("no history before");
    expect(h.notes[0]).toContain("2023-11-14");
  });

  it("stops asking after a refusal, and says why", async () => {
    const h = harness({
      backfill: vi.fn(async () => {
        throw new Error("429 rate limited");
      }),
    });
    await h.b.loadOlder();
    await h.b.loadOlder();
    expect(h.deps.backfill).toHaveBeenCalledTimes(1);
    expect(h.notes[0]).toContain("429");
  });

  it("lets an instrument ask again when the operator returns to it", async () => {
    const h = harness({ grows: 0 });
    await h.b.loadOlder();
    expect(h.b.isExhausted("BTCUSDT", "1h")).toBe(true);
    h.b.reset("BTCUSDT", "1h");
    expect(h.b.isExhausted("BTCUSDT", "1h")).toBe(false);
  });
});

describe("what it refuses to do", () => {
  it("does not apply bars to a chart the operator has left", async () => {
    // The symbol can change while a fetch is in flight. These bars belong to
    // the old one.
    let symbol = "BTCUSDT";
    const h = harness({
      loadedSymbol: () => symbol,
      backfill: vi.fn(async () => {
        symbol = "ETHUSDT";
      }),
    });
    await h.b.loadOlder();
    expect(h.deps.reload).not.toHaveBeenCalled();
  });

  it("stays out of replay", async () => {
    // Replay hands out a deliberately shortened array. Asking for more history
    // inside it is asking to see past the cursor.
    const h = harness({ replayActive: () => true });
    await h.b.loadOlder();
    expect(h.deps.backfill).not.toHaveBeenCalled();
  });

  it("stops at the ceiling", async () => {
    const h = harness({ barCount: () => HISTORY_MAX });
    await h.b.loadOlder();
    expect(h.deps.backfill).not.toHaveBeenCalled();
  });

  it("does nothing with no bars and no instrument", async () => {
    const empty = harness({ barCount: () => 0 });
    await empty.b.loadOlder();
    expect(empty.deps.backfill).not.toHaveBeenCalled();

    const none = harness({ loadedSymbol: () => "" });
    await none.b.loadOlder();
    expect(none.deps.backfill).not.toHaveBeenCalled();
  });
});

describe("the progress indicator", () => {
  it("is raised and lowered exactly once, even on failure", async () => {
    // A pending flag left raised is a spinner that never stops.
    const h = harness({
      backfill: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await h.b.loadOlder();
    expect(h.pending).toEqual([true, false]);
  });
});
