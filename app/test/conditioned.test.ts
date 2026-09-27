/**
 * PAIRING EVERY RULE WITH EVERY STATE — `backtest/conditioned.ts`.
 *
 * WHY THIS EXISTS, MEASURED. Across 22 markets the shipped library had a median
 * per-trade Sharpe of −0.109. Deepening the archive from 42 days to 5 years
 * took the median arm from 58 trades to 821 and the hurdle from +0.450 to
 * +0.102 — and the best arm FELL from +0.374 to +0.070. The library has no
 * standalone edge, and that is now measured rather than suspected. The only
 * question left is whether a rule works in a particular STATE.
 *
 * THE TEST THAT MATTERS IS `the state gates both directions`. A dollar prior
 * says a falling dollar helps gold, which would make it a LONG filter — and
 * encoding that would bake in the answer the search exists to find. The state
 * gates both sides and the measurement decides.
 *
 * THE SECOND IS `every state is a sign test, never a level`. `vix > 20` is a
 * number somebody chose, and choosing it is a second search nobody charged for.
 *
 * AND THE THIRD IS THAT THE FIELD STAYS COUNTABLE. A search pays for every arm:
 * the hurdle is `sqrt(2 ln N)/sqrt(n)`, so six states over 25 rules is 150 arms
 * and sixty states would be 1,500, needing a materially better winner to say
 * anything at all. The cap is counted rather than silently applied, because a
 * field that shrinks without saying so lowers the hurdle for everything left.
 */

import { describe, expect, it } from "vitest";
import {
  buildConditioned,
  conditionedId,
  DEFAULT_MAX_CONDITIONED,
  MACRO_STATES,
} from "../src/backtest/conditioned";
import { SPECS } from "../src/backtest/specs";
import { isMacroColumn, validateSpec } from "../src/backtest/rules";

const base = SPECS.slice(0, 3);

describe("the states themselves", () => {
  it("every state is a SIGN TEST on a change, never a level threshold", () => {
    // A level like `vix > 20` is a number somebody chose; searching for it is a
    // second search nobody charged for.
    for (const s of MACRO_STATES) {
      const [col, op, rhs] = s.condition;
      expect(isMacroColumn(col), col).toBe(true);
      expect([">", "<"]).toContain(op);
      expect(rhs).toBe("0");
      expect(col.endsWith("_chg5"), `${col} should be a change, not a level`).toBe(true);
    }
  });

  it("every state carries the PRIOR that justifies spending arms on it", () => {
    // Written before the run, so a result can be read against what was
    // expected rather than a story fitted to whatever came back.
    for (const s of MACRO_STATES) {
      expect(s.why.length).toBeGreaterThan(40);
      expect(s.label.length).toBeGreaterThan(8);
    }
  });

  it("covers each axis at both signs, and nothing twice", () => {
    const keys = MACRO_STATES.map((s) => `${s.condition[0]}${s.condition[1]}`);
    expect(new Set(keys).size).toBe(keys.length);
    const cols = new Set(MACRO_STATES.map((s) => s.condition[0]));
    for (const c of cols) {
      const signs = MACRO_STATES.filter((s) => s.condition[0] === c).map((s) => s.condition[1]);
      expect(new Set(signs)).toEqual(new Set([">", "<"]));
    }
  });

  it("stays small, because every arm raises the bar for all of them", () => {
    expect(MACRO_STATES.length).toBeLessThanOrEqual(8);
  });
});

describe("what a conditioned spec is", () => {
  it("THE STATE GATES BOTH DIRECTIONS", () => {
    /* Applying it to longs only would encode the directional prior the search
       exists to test. */
    const withShort = SPECS.find((s) => s.short && s.short.length > 0);
    expect(withShort, "the library needs a two-sided rule for this test").toBeTruthy();
    const { specs } = buildConditioned([withShort!], { states: [MACRO_STATES[0]!] });
    const made = specs[0]!;
    expect(made.long).toContainEqual(MACRO_STATES[0]!.condition);
    expect(made.short).toContainEqual(MACRO_STATES[0]!.condition);
  });

  it("does not invent a short side for a rule that has none", () => {
    const longOnly = { ...base[0]!, short: undefined };
    const { specs } = buildConditioned([longOnly], { states: [MACRO_STATES[0]!] });
    expect(specs[0]!.short).toBeUndefined();
  });

  it("keeps the base rule's stop and target untouched", () => {
    // Reusing a builder can silently RE-PRICE what it builds. Conditioning
    // changes WHEN a rule trades, never what it risks.
    const { specs } = buildConditioned([base[0]!], { states: [MACRO_STATES[0]!] });
    expect(specs[0]!.stop).toEqual(base[0]!.stop);
    expect(specs[0]!.target).toEqual(base[0]!.target);
  });

  it("carries the prior and the no-look-ahead promise in its note", () => {
    const { specs } = buildConditioned([base[0]!], { states: [MACRO_STATES[0]!] });
    expect(specs[0]!.note).toContain("Expected before the run");
    expect(specs[0]!.note).toContain("CLOSED");
  });

  it("produces an id that traces back to its pair", () => {
    const { specs } = buildConditioned([base[0]!], { states: [MACRO_STATES[0]!] });
    expect(specs[0]!.id).toBe(conditionedId(base[0]!.id, MACRO_STATES[0]!.id));
    expect(specs[0]!.id).toContain(base[0]!.id);
    expect(specs[0]!.id).toContain(MACRO_STATES[0]!.id);
  });

  it("every conditioned spec is a VALID spec", () => {
    // A spec the engine rejects is an arm that fails, and a failed arm still
    // raises the hurdle while contributing nothing.
    const { specs } = buildConditioned(SPECS);
    expect(specs.length).toBeGreaterThan(0);
    for (const sp of specs) {
      expect(validateSpec(sp), `${sp.id}: ${JSON.stringify(validateSpec(sp))}`).toEqual([]);
    }
  });
});

describe("the field stays countable", () => {
  it("pairs every rule with every state", () => {
    const { specs } = buildConditioned(base, { max: 1000 });
    expect(specs).toHaveLength(base.length * MACRO_STATES.length);
  });

  it("COUNTS what the cap discarded rather than dropping it silently", () => {
    // A field that shrinks without saying so lowers the hurdle for everything
    // left in it — "a field that silently shrinks lowers the hurdle without
    // telling anyone".
    const { specs, capped } = buildConditioned(base, { max: 4 });
    expect(specs).toHaveLength(4);
    expect(capped).toBe(base.length * MACRO_STATES.length - 4);
  });

  it("refuses a pair that would duplicate a test the rule already makes", () => {
    const already = {
      ...base[0]!,
      long: [...base[0]!.long, MACRO_STATES[0]!.condition],
    };
    const { specs, refused } = buildConditioned([already], { states: [MACRO_STATES[0]!] });
    expect(specs).toHaveLength(0);
    expect(refused[0]?.why).toContain("already tests");
  });

  it("refuses a rule with no entry to condition, by name", () => {
    const empty = { ...base[0]!, long: [] };
    const { specs, refused } = buildConditioned([empty], { states: [MACRO_STATES[0]!] });
    expect(specs).toHaveLength(0);
    expect(refused[0]?.why).toContain("no entry");
  });

  it("honours an exclusion, so a retired pair is not re-entered", () => {
    const id = conditionedId(base[0]!.id, MACRO_STATES[0]!.id);
    const { specs } = buildConditioned(base, { exclude: [id] });
    expect(specs.map((s) => s.id)).not.toContain(id);
  });

  it("the default cap is big enough for the shipped library", () => {
    // A cap below `rules x states` would silently truncate the field on every
    // run, and the count would be right while the search was not what it said.
    expect(DEFAULT_MAX_CONDITIONED).toBeGreaterThanOrEqual(SPECS.length * MACRO_STATES.length * 0.9);
  });

  it("is deterministic", () => {
    const a = buildConditioned(base).specs.map((s) => s.id);
    const b = buildConditioned(base).specs.map((s) => s.id);
    expect(a).toEqual(b);
  });
});
