/**
 * "Your say": the operator's answer to each recommendation, recorded so
 * Review can compare what was recommended with what was decided.
 */

import { describe, expect, it } from "vitest";
import { SAYS_MAX, SAYS_SLOT, addSay, createSayStore, removeSay, sayFor, setupKey, type Say } from "../src/journal/says";
import { createKV, memoryRawStore } from "../src/store/kv";

const base = { symbol: "BTCUSDT", timeframe: "1h", verdict: "go", direction: "long" as const, entry: 84250.5 };
const say = (over: Partial<Say> = {}): Say => ({
  at: 1_790_000_000_000,
  key: setupKey(base),
  symbol: "BTCUSDT",
  timeframe: "1h",
  verdict: "go",
  direction: "long",
  choice: "pass",
  reason: "News is too close",
  ...over,
});

describe("setupKey", () => {
  it("is a different recommendation when the entry, direction or verdict changes", () => {
    const k = setupKey(base);
    expect(setupKey({ ...base, entry: 84300 })).not.toBe(k);
    expect(setupKey({ ...base, direction: "short" })).not.toBe(k);
    expect(setupKey({ ...base, verdict: "armed" })).not.toBe(k);
    expect(setupKey({ ...base })).toBe(k);
  });

  it("does not print NaN for a plan with no entry", () => {
    expect(setupKey({ ...base, entry: null })).not.toContain("NaN");
    expect(setupKey({ ...base, entry: Number.NaN })).not.toContain("NaN");
  });
});

describe("the log", () => {
  it("replaces an earlier answer to the same setup, newest first", () => {
    const first = addSay([], say({ choice: "pass", at: 1 }));
    const second = addSay(first, say({ choice: "use", reason: "", at: 2 }));
    expect(second).toHaveLength(1);
    expect(second[0]?.choice).toBe("use");
  });

  it("keeps answers to different setups", () => {
    const log = addSay(addSay([], say()), say({ key: setupKey({ ...base, symbol: "ETHUSDT" }), symbol: "ETHUSDT" }));
    expect(log.map((s) => s.symbol)).toEqual(["ETHUSDT", "BTCUSDT"]);
  });

  it("undo removes exactly that answer", () => {
    const k = setupKey(base);
    expect(sayFor(removeSay(addSay([], say()), k), k)).toBeNull();
  });

  it("is capped", () => {
    let log: Say[] = [];
    for (let i = 0; i < SAYS_MAX + 20; i++) log = addSay(log, say({ key: `k${i}`, at: i }));
    expect(log).toHaveLength(SAYS_MAX);
    expect(log[0]?.key).toBe(`k${SAYS_MAX + 19}`);
  });

  it("drops malformed rows on read without losing the rest", () => {
    expect(SAYS_SLOT.validate([say(), { at: "x" }, null])).toEqual([say()]);
    expect(SAYS_SLOT.validate("nope")).toBeNull();
  });
});

describe("createSayStore", () => {
  it("persists through the KV store and survives a reload", () => {
    const raw = memoryRawStore();
    createSayStore(createKV(raw)).record(say());
    const again = createSayStore(createKV(raw));
    expect(sayFor(again.all(), setupKey(base))?.reason).toBe("News is too close");
    again.undo(setupKey(base));
    expect(createSayStore(createKV(raw)).all()).toEqual([]);
  });
});
