/**
 * Remembering what a search found.
 *
 * What is pinned:
 *  1. A CACHED RESULT ANSWERS ONE QUESTION. Change the field or the costs and
 *     it is a different search over a different hurdle — it must MISS, not
 *     serve the old conclusion.
 *  2. ONE NEW BAR DOES NOT MOVE AN ESTIMATE BUILT ON FIVE THOUSAND, but a
 *     window that has slid a week does. Measured in TIME, because a rolling
 *     window is the same length forever.
 *  3. IT STATES ITS OWN AGE. A three-day-old verdict that looks live is worse
 *     than no verdict.
 *  4. IT STAYS SMALL. A preference slot that grows without bound eventually
 *     refuses to save anything at all.
 */

import { describe, expect, it } from "vitest";
import { createKV, memoryRawStore } from "../src/store/kv";
import {
  STALE_BARS_MIN,
  SWEEP_MAX,
  createSweepCache,
  hashCosts,
  hashField,
  staleness,
  summarise,
  sweepKey,
} from "../src/backtest/sweepcache";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import type { AutoRunReport, Entrant } from "../src/backtest/autorun";
import type { SweepSummary } from "../src/backtest/sweepcache";
import type { RuleSpec } from "../src/backtest/rules";

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

const spec = (id: string): RuleSpec => ({
  id,
  name: `Rule ${id}`,
  style: "custom",
  long: [["close", ">", "100"]],
  stop: { type: "pct", value: 1 },
  target: { type: "rr", value: 2 },
});

const field = (ids: string[]): Entrant[] => ids.map((id) => ({ spec: spec(id), origin: "library" as const }));

const summary = (over: Partial<SweepSummary> = {}): SweepSummary => ({
  key: "BTCUSDT|1h|aaa|bbb",
  symbol: "BTCUSDT",
  timeframe: "1h",
  at: T0,
  bars: 5000,
  lastBar: T0,
  entered: 85,
  trials: 765,
  survivors: 0,
  line: "Nothing survived the search of 85 strategies (765 tries).",
  refusal: "all-refused",
  nearest: "the nearest miss lost money out of sample",
  failed: [],
  ...over,
});

describe("the key", () => {
  it("is a different key when the field changes", () => {
    const a = sweepKey("BTCUSDT", "1h", hashField(field(["r1", "r2"])), hashCosts(DEFAULT_COSTS));
    const b = sweepKey("BTCUSDT", "1h", hashField(field(["r1", "r2", "r3"])), hashCosts(DEFAULT_COSTS));
    expect(a).not.toBe(b);
  });

  /*
   * Costs set the hurdle every rule must clear, so a changed spread is a
   * changed question — not the same answer at a different price.
   */
  it("is a different key when the costs change", () => {
    const a = sweepKey("BTCUSDT", "1h", "f", hashCosts(DEFAULT_COSTS));
    const b = sweepKey("BTCUSDT", "1h", "f", hashCosts({ ...DEFAULT_COSTS, spread: 0.001 }));
    expect(a).not.toBe(b);
  });

  it("is the same key for the same field in the same order", () => {
    expect(hashField(field(["r1", "r2"]))).toBe(hashField(field(["r1", "r2"])));
  });

  it("separates two markets and two timeframes", () => {
    expect(sweepKey("BTCUSDT", "1h", "f", "c")).not.toBe(sweepKey("ETHUSDT", "1h", "f", "c"));
    expect(sweepKey("BTCUSDT", "1h", "f", "c")).not.toBe(sweepKey("BTCUSDT", "4h", "f", "c"));
  });
});

describe("staleness", () => {
  it("is not stale after a handful of bars", () => {
    const s = staleness(summary(), T0 + 3 * H);
    expect(s.stale).toBe(false);
    expect(s.newBars).toBe(3);
    expect(s.why).toContain("under the");
  });

  /*
   * THE TRAP THIS EXISTS FOR. A 5,000-bar study window is still 5,000 bars a
   * week later, with every bar in it newer — so counting array length would
   * report zero and a cached sweep would never go stale at all.
   */
  it("is stale when the window has slid on, even though it is the same length", () => {
    const s = staleness(summary({ bars: 5000 }), T0 + 400 * H);
    expect(s.newBars).toBe(400);
    expect(s.stale).toBe(true);
    expect(s.why).toContain("have closed since");
  });

  it("scales the threshold with the window rather than using one number", () => {
    /* 5% of 5,000 is 250, well past the 25-bar floor. */
    expect(staleness(summary({ bars: 5000 }), T0 + 100 * H).stale).toBe(false);
    expect(staleness(summary({ bars: 5000 }), T0 + 250 * H).stale).toBe(true);
    /* A short study is held to the floor, not to 5% of very little. */
    expect(staleness(summary({ bars: 200 }), T0 + STALE_BARS_MIN * H).stale).toBe(true);
  });

  it("never reports negative progress when the newest bar has not moved", () => {
    const s = staleness(summary(), T0);
    expect(s.newBars).toBe(0);
    expect(s.stale).toBe(false);
  });
});

describe("what is remembered", () => {
  const report = (over: Partial<AutoRunReport> = {}): AutoRunReport =>
    ({
      symbol: "BTCUSDT",
      timeframe: "1h",
      at: T0,
      entered: 85,
      hybrids: { hybrids: [], rejected: [], considered: 0, unbuilt: 0 },
      failed: [
        { id: "a", why: "not enough history" },
        { id: "b", why: "not enough history" },
        { id: "c", why: "the engine is missing" },
      ],
      search: { trials: 765, scored: [], survivors: [], refusal: null, line: "x" },
      keep: [],
      line: "Nothing survived.",
      ...over,
    }) as unknown as AutoRunReport;

  it("collapses repeated failure reasons — copies of one sentence are not facts", () => {
    const s = summarise(report(), { key: "k", bars: 5000, lastBar: T0, at: T0 });
    expect(s.failed).toEqual(["not enough history", "the engine is missing"]);
  });

  it("keeps the sentence and the arithmetic behind the hurdle", () => {
    const s = summarise(report(), { key: "k", bars: 5000, lastBar: T0, at: T0 });
    expect(s.line).toBe("Nothing survived.");
    expect(s.trials).toBe(765);
    expect(s.entered).toBe(85);
    expect(s.survivors).toBe(0);
  });
});

describe("the store", () => {
  const fresh = () => createSweepCache(createKV(memoryRawStore()));

  it("returns what it was given, and null for a market never searched", () => {
    const c = fresh();
    c.put(summary());
    expect(c.get("BTCUSDT|1h|aaa|bbb")?.trials).toBe(765);
    expect(c.get("ETHUSDT|1h|aaa|bbb")).toBeNull();
  });

  it("replaces a market's entry rather than accumulating copies", () => {
    const c = fresh();
    c.put(summary({ trials: 100 }));
    c.put(summary({ trials: 765 }));
    expect(c.all()).toHaveLength(1);
    expect(c.get("BTCUSDT|1h|aaa|bbb")?.trials).toBe(765);
  });

  it("survives a reload, which is the entire point", () => {
    const kv = createKV(memoryRawStore());
    createSweepCache(kv).put(summary());
    expect(createSweepCache(kv).get("BTCUSDT|1h|aaa|bbb")).not.toBeNull();
  });

  it("forgets on request, so a re-search is always available", () => {
    const c = fresh();
    c.put(summary());
    c.forget("BTCUSDT|1h|aaa|bbb");
    expect(c.get("BTCUSDT|1h|aaa|bbb")).toBeNull();
  });

  it("caps itself, dropping the oldest first", () => {
    const c = fresh();
    for (let i = 0; i < SWEEP_MAX + 6; i++) {
      c.put(summary({ key: `S${i}|1h|f|c`, symbol: `S${i}`, at: T0 + i * H }));
    }
    expect(c.all()).toHaveLength(SWEEP_MAX);
    /* The oldest went; the newest stayed. */
    expect(c.get("S0|1h|f|c")).toBeNull();
    expect(c.get(`S${SWEEP_MAX + 5}|1h|f|c`)).not.toBeNull();
  });
});
