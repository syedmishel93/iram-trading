import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  RULE_LIMITS,
  rulesAreDefault,
  sanitiseRules,
  type GateRules,
} from "../src/setup/rules";
import { createRegistry, type DataSource } from "../src/data/sources";
import { CONFIDENCE_STEPS, densityFactor, detectSummary } from "../src/ui/detectpanel";

describe("sanitiseRules", () => {
  it("returns the defaults for nothing at all", () => {
    expect(sanitiseRules(undefined)).toEqual(DEFAULT_RULES);
    expect(sanitiseRules(null)).toEqual(DEFAULT_RULES);
    expect(sanitiseRules("not an object")).toEqual(DEFAULT_RULES);
  });

  it("keeps a value that is already sensible", () => {
    expect(sanitiseRules({ maxHeatPct: 4 }).maxHeatPct).toBe(4);
  });

  it("clamps rather than accepting a gate that would never fire", () => {
    /* 0 is not a threshold, it is the gate switched off — and on screen it is
       indistinguishable from a gate that is working. */
    expect(sanitiseRules({ embargoMinutes: 0 }).embargoMinutes).toBe(RULE_LIMITS.embargoMinutes[0]);
    expect(sanitiseRules({ maxHeatPct: 0 }).maxHeatPct).toBe(RULE_LIMITS.maxHeatPct[0]);
  });

  it("clamps a daily limit of zero, which would stand you down permanently", () => {
    expect(sanitiseRules({ dailyLossLimitPct: 0 }).dailyLossLimitPct).toBeGreaterThan(0);
  });

  it("clamps the top end too", () => {
    expect(sanitiseRules({ embargoMinutes: 9999 }).embargoMinutes).toBe(RULE_LIMITS.embargoMinutes[1]);
  });

  it("falls back rather than producing NaN from junk", () => {
    /* A NaN threshold makes every comparison false, so the gate silently
       passes everything — the worst available failure for a safety check. */
    const r = sanitiseRules({ coverageFloor: "banana", maxHeatPct: NaN });
    expect(r.coverageFloor).toBe(DEFAULT_RULES.coverageFloor);
    expect(r.maxHeatPct).toBe(DEFAULT_RULES.maxHeatPct);
  });

  it("restores the stop band when it is inverted", () => {
    /* min above max makes the stop gate refuse every trade while each field on
       its own looks reasonable. */
    const r = sanitiseRules({ minStopAtr: 4, maxStopAtr: 1 });
    expect(r.minStopAtr).toBe(DEFAULT_RULES.minStopAtr);
    expect(r.maxStopAtr).toBe(DEFAULT_RULES.maxStopAtr);
  });

  it("is idempotent", () => {
    const once = sanitiseRules({ maxHeatPct: 1e9 });
    expect(sanitiseRules(once)).toEqual(once);
  });
});

describe("rulesAreDefault", () => {
  it("is true for the defaults and false after one change", () => {
    expect(rulesAreDefault(DEFAULT_RULES)).toBe(true);
    const changed: GateRules = { ...DEFAULT_RULES, maxHeatPct: 5 };
    expect(rulesAreDefault(changed)).toBe(false);
  });
});

// ------------------------------------------------------------------ sources --

const src = (id: string, priority: number): DataSource => ({
  id,
  label: id,
  priority,
  quality: "live",
  covers: "test",
  supports: () => true,
  loadBars: async () => [],
});

describe("registry source switches", () => {
  const build = () => createRegistry([src("a", 1), src("b", 2), src("c", 3)]);

  it("offers every source by default", () => {
    expect(build().candidates("X").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("drops a disabled source from the candidates", () => {
    const r = build();
    r.setDisabled(["b"]);
    expect(r.candidates("X").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("REPLACES the set rather than adding to it", () => {
    /* Settings sends the whole set every time; an additive setter would make a
       source impossible to switch back on. */
    const r = build();
    r.setDisabled(["a", "b"]);
    r.setDisabled(["c"]);
    expect(r.disabledIds()).toEqual(["c"]);
    expect(r.isDisabled("a")).toBe(false);
  });

  it("names the switch in the attempt log rather than skipping silently", async () => {
    /* A chart that will not load because of a switch flipped last week is only
       debuggable if the log says which switch. */
    const r = build();
    r.setDisabled(["a", "b", "c"]);
    const res = await r.resolve("X", "1h");
    expect(res.bars).toEqual([]);
    expect(res.attempts.every((a) => a.note === "switched off in Settings")).toBe(true);
  });

  it("keeps the user's switch separate from the breaker's", () => {
    /* One is a decision that persists; the other is a failure that clears
       itself. Conflating them means a source you disabled quietly returns. */
    const r = build();
    r.setDisabled(["a"]);
    expect(r.isDisabled("a")).toBe(true);
    expect(r.breaker.isOpen("a")).toBe(false);
  });
});

// ------------------------------------------------------------ detect filters --

describe("detect filters", () => {
  it("density is a multiplier over the per-kind caps", () => {
    expect(densityFactor("normal")).toBe(1);
    expect(densityFactor("focused")).toBeLessThan(1);
    expect(densityFactor("everything")).toBeGreaterThan(1);
  });

  it("an unknown density falls back to normal rather than to zero", () => {
    /* A zero factor would draw nothing and look like the detectors had broken. */
    expect(densityFactor("nonsense")).toBe(1);
  });

  it("offers 'All' as a real step, not an absence", () => {
    expect(CONFIDENCE_STEPS[0]).toEqual({ value: 0, label: "All" });
  });

  it("reports filtered structures SEPARATELY from the drawing cap", () => {
    /* Two different reasons a structure is not on screen, and only one of them
       is something the user chose. */
    const line = detectSummary(3, 30, 6, 12);
    expect(line).toContain("12 hidden by your filters");
    expect(line).toContain("30 found");
  });

  it("says nothing about filters when none are hiding anything", () => {
    expect(detectSummary(3, 4, 4, 0)).not.toContain("filters");
  });

  it("does not claim a cap gap when the filters explain the whole difference", () => {
    /* 20 found, 12 filtered out, 8 drawn — all 8 survivors ARE drawn, so
       saying "20 found · 8 drawn — most recent of each type" would blame the
       cap for the user's own filter. */
    const line = detectSummary(3, 20, 8, 12);
    expect(line).toContain("8 structures drawn");
    expect(line).not.toContain("most recent of each type");
  });
});
