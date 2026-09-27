/**
 * Hybrid composition: one rule's trigger under another's condition.
 *
 * The rule under test is the one in the header of `backtest/hybrid.ts`: a
 * hybrid of two EVENTS asks for two crossings on one bar and never trades, so
 * only STATE conditions are ever contributed.
 */

import { describe, expect, it } from "vitest";
import { SPECS, SPECS_BY_ID } from "../src/backtest/specs";
import { validateSpec, type RuleSpec } from "../src/backtest/rules";
import {
  buildHybrids,
  composePair,
  contradicts,
  filterConditions,
  isEvent,
  DEFAULT_MAX_HYBRIDS,
} from "../src/backtest/hybrid";

const spec = (id: string): RuleSpec => {
  const s = SPECS_BY_ID.get(id);
  if (!s) throw new Error(`no spec ${id}`);
  return s;
};

const CROSS: RuleSpec = {
  id: "t-cross",
  name: "Cross",
  style: "scalp",
  long: [["ema9", "crossabove", "ema21"]],
  short: [["ema9", "crossbelow", "ema21"]],
  exitLong: [["close", "<", "ema21"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "rr", value: 2 },
};
const TREND: RuleSpec = {
  id: "t-trend",
  name: "Uptrend",
  style: "swing",
  long: [["ema50", ">", "ema200"]],
  short: [["ema50", "<", "ema200"]],
  stop: { type: "atr", mult: 3 },
  target: { type: "rr", value: 1 },
};

describe("events and states", () => {
  it("counts only crossings as events", () => {
    expect(isEvent(["ema9", "crossabove", "ema21"])).toBe(true);
    expect(isEvent(["ema9", ">", "ema21"])).toBe(false);
  });

  it("offers only the standing conditions as filters", () => {
    expect(filterConditions(CROSS.long)).toEqual([]);
    expect(filterConditions(TREND.long)).toEqual([["ema50", ">", "ema200"]]);
  });
});

describe("contradictions", () => {
  it("catches the same pair compared both ways", () => {
    expect(contradicts(["ema9", ">", "ema21"], ["ema9", "<", "ema21"])).toBe(true);
    expect(contradicts(["ema9", ">", "ema21"], ["ema9", ">", "ema21"])).toBe(false);
  });

  it("catches a column bounded on both sides with no room", () => {
    expect(contradicts(["rsi", ">", "70"], ["rsi", "<", "30"])).toBe(true);
    expect(contradicts(["rsi", ">", "30"], ["rsi", "<", "70"])).toBe(false);
  });

  it("says nothing about different columns — that is the backtest's job", () => {
    expect(contradicts(["rsi", ">", "70"], ["close", "<", "bbl"])).toBe(false);
  });
});

describe("composePair", () => {
  it("puts the trigger's entry under the filter's condition, keeping the trigger's risk", () => {
    const out = composePair(CROSS, TREND);
    if ("reason" in out) throw new Error(`refused: ${out.reason}`);
    expect(out.spec.long).toEqual([["ema9", "crossabove", "ema21"], ["ema50", ">", "ema200"]]);
    expect(out.spec.short).toEqual([["ema9", "crossbelow", "ema21"], ["ema50", "<", "ema200"]]);
    /* Exits, stop and target are the trigger's, untouched. */
    expect(out.spec.stop).toEqual(CROSS.stop);
    expect(out.spec.target).toEqual(CROSS.target);
    expect(out.spec.exitLong).toEqual(CROSS.exitLong);
    expect(out.added).toEqual([["ema50", ">", "ema200"]]);
    expect(validateSpec(out.spec)).toEqual([]);
  });

  it("refuses when the filter has nothing standing to add", () => {
    const out = composePair(TREND, CROSS);
    expect("reason" in out && out.reason).toBe("no-filter");
  });

  it("refuses when the filter is already in the trigger", () => {
    const out = composePair({ ...CROSS, long: [...CROSS.long, ["ema50", ">", "ema200"]] }, TREND);
    expect("reason" in out && out.reason).toBe("already-in-trigger");
  });

  it("refuses a filter that cannot be true with the trigger", () => {
    const over: RuleSpec = { ...TREND, id: "t-over", long: [["ema50", "<", "ema200"]], short: [["ema50", ">", "ema200"]] };
    const under: RuleSpec = { ...CROSS, id: "t-under", long: [["ema9", "crossabove", "ema21"], ["ema50", ">", "ema200"]] };
    const out = composePair(under, over);
    expect("reason" in out && out.reason).toBe("contradiction");
  });

  it("leaves a long-only trigger long-only", () => {
    const longOnly: RuleSpec = { ...CROSS, id: "t-long" };
    delete (longOnly as { short?: unknown }).short;
    const out = composePair(longOnly, TREND);
    if ("reason" in out) throw new Error("refused");
    expect(out.spec.short).toBeUndefined();
  });

  it("names the hybrid after both parents and says the terminal built it", () => {
    const out = composePair(CROSS, TREND);
    if ("reason" in out) throw new Error("refused");
    expect(out.spec.id).toBe("hy:t-cross+t-trend");
    expect(out.spec.name).toContain("Cross");
    expect(out.spec.name).toContain("Uptrend");
    expect(out.spec.note).toContain("Built by the terminal");
    expect(out.spec.note).toContain("not yet forward-tested");
  });
});

describe("buildHybrids over the shipped library", () => {
  it("produces valid, unique specs and counts what it refused", () => {
    const out = buildHybrids(SPECS, { max: 40 });
    expect(out.hybrids.length).toBeGreaterThan(0);
    expect(out.hybrids.length).toBeLessThanOrEqual(40);
    expect(out.considered).toBe(out.hybrids.length + out.rejected.length);
    for (const h of out.hybrids) {
      expect(validateSpec(h.spec)).toEqual([]);
      expect(h.spec.id).toBe(`hy:${h.trigger}+${h.filter}`);
      expect(h.added.length).toBeGreaterThan(0);
    }
    expect(new Set(out.hybrids.map((h) => h.spec.id)).size).toBe(out.hybrids.length);
  });

  it("gives every refusal a reason a reader can act on", () => {
    const out = buildHybrids(SPECS, { max: 10 });
    for (const r of out.rejected) expect(r.why.length).toBeGreaterThan(10);
  });

  it("counts the pairs it did not build rather than pretending they did not exist", () => {
    const out = buildHybrids(SPECS, { max: 5 });
    expect(out.hybrids).toHaveLength(5);
    expect(out.unbuilt).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const a = buildHybrids(SPECS, { max: 25 }).hybrids.map((h) => h.spec.id);
    const b = buildHybrids(SPECS, { max: 25 }).hybrids.map((h) => h.spec.id);
    expect(a).toEqual(b);
  });

  it("can be restricted to chosen triggers", () => {
    const only = spec("ema-9-21-cross").id;
    const out = buildHybrids(SPECS, { max: DEFAULT_MAX_HYBRIDS, triggers: [only] });
    for (const h of out.hybrids) expect(h.trigger).toBe(only);
  });
});
