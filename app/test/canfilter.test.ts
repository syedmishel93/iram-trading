/**
 * WHICH RULES CAN ACT AS A FILTER — asked before the operator picks one.
 *
 * The Playbook's "Only while this also holds" listed every shipped rule and
 * refused about a third of them AFTER the choice was made, with a sentence
 * beginning "Cannot be combined". The sentence is correct and it arrives too
 * late: a menu whose rows are a third dead is one you learn by trial.
 *
 * The reason is real and not a limitation worth removing. A rule spec condition
 * is either an EVENT (`crossabove` / `crossbelow`, true on ONE bar) or a STATE
 * (`>` `<` `>=` `<=`, true for as long as it holds). Conditions are ANDed, so a
 * filter built from events asks for two crossings on the SAME bar — a handful
 * of trades, which is not a strategy but a sample too small for anything
 * downstream to speak to. A rule made only of crossings has no world-state to
 * restrict another rule with.
 */

import { describe, expect, it } from "vitest";
import { canFilter, filtersBothSides, filterConditions, composePair } from "../src/backtest/hybrid";
import { SPECS, SPECS_BY_ID } from "../src/backtest/specs";
import type { RuleSpec } from "../src/backtest/rules";

const spec = (over: Partial<RuleSpec>): RuleSpec => ({
  id: "x",
  name: "X",
  style: "custom",
  long: [["close", ">", "ema50"]],
  short: [["close", "<", "ema50"]],
  exitLong: [["close", "<", "ema21"]],
  exitShort: [["close", ">", "ema21"]],
  stop: { type: "pct", value: 1 },
  target: { type: "rr", value: 2 },
  ...over,
});

describe("canFilter", () => {
  it("IS FALSE FOR A RULE MADE ONLY OF CROSSINGS", () => {
    /* `cci-extremes` is the live example: its entire entry is
       `cci crossabove -100`, one event and nothing else. */
    const onlyEvents = spec({
      long: [["cci", "crossabove", "-100"]],
      short: [["cci", "crossbelow", "100"]],
    });
    expect(canFilter(onlyEvents)).toBe(false);
  });

  it("is true when BOTH sides carry a standing condition", () => {
    const withState = spec({
      long: [["stochk", "crossabove", "stochd"], ["stochk", "<", "40"]],
      short: [["stochk", "crossbelow", "stochd"], ["stochk", ">", "60"]],
    });
    expect(canFilter(withState)).toBe(true);
  });

  it("IS TRUE FOR A ONE-SIDED FILTER, because the composer accepts one", () => {
    /* MY FIRST VERSION REQUIRED BOTH SIDES AND WAS WRONG — measured against the
       real composer, which gates on the LONG side only and mirrors onto shorts
       when it can. A stricter menu would have greyed out `macd-signal-cross`,
       a pair the composer would have built, and the operator would never have
       learned it was possible. Predicting the authority is the whole job. */
    const half = spec({
      long: [["rsi", "crossabove", "30"], ["ema50", ">", "ema200"]],
      short: [["rsi", "crossbelow", "70"]],
    });
    expect(canFilter(half)).toBe(true);
    expect(filtersBothSides(half), "and it is reported as one-sided").toBe(false);
  });

  it("A ONE-SIDED FILTER REALLY DOES LEAVE THE SHORTS ALONE", () => {
    /* The reason `filtersBothSides` exists. "Adds 1 condition to the entry"
       reads as though it applied to the whole rule; here it applies to half of
       it, and half the trades are exactly what they were before. */
    const trigger = spec({ id: "t", long: [["close", ">", "ema50"]], short: [["close", "<", "ema50"]] });
    const half = spec({
      id: "f",
      long: [["ema50", ">", "ema200"]],
      short: [["rsi", "crossbelow", "70"]],
    });
    const got = composePair(trigger, half);
    expect("spec" in got).toBe(true);
    if ("spec" in got) {
      expect(got.spec.long).toHaveLength(2);
      expect(got.spec.short, "the short entry is untouched").toHaveLength(1);
    }
  });

  it("AGREES WITH composePair ON EVERY SHIPPED RULE, which is the point", () => {
    /* The menu is only honest if the answer it shows before the click is the
       answer the composer gives after it. Asserted against the real composer,
       not against a second copy of the reasoning. */
    const trigger = SPECS_BY_ID.get("ema-cross") ?? (SPECS[0] as RuleSpec);
    for (const s of SPECS) {
      if (s.id === trigger.id) continue;
      const got = composePair(trigger, s);
      const refusedForNoFilter = !("spec" in got) && got.reason === "no-filter";
      expect(canFilter(s), s.id + " disagreed with composePair").toBe(!refusedForNoFilter);
    }
  });

  it("SOME SHIPPED RULES CAN AND SOME CANNOT — or the menu would not need this", () => {
    const yes = SPECS.filter(canFilter).length;
    expect(yes, "no rule can filter — the check is inverted").toBeGreaterThan(0);
    expect(yes, "every rule can filter — nothing to mark").toBeLessThan(SPECS.length);
  });

  it("is exactly whether filterConditions finds anything on the long side", () => {
    for (const s of SPECS) {
      expect(canFilter(s), s.id).toBe(filterConditions(s.long).length > 0);
    }
  });

  it("AT LEAST ONE SHIPPED RULE FILTERS ONLY ONE SIDE, or the warning is dead code", () => {
    const oneSided = SPECS.filter((s) => canFilter(s) && !filtersBothSides(s));
    expect(oneSided.length, "nothing to warn about — drop the warning").toBeGreaterThan(0);
  });
});
