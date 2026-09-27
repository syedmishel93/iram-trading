/**
 * THE SEARCH FIELD AS A GRAPH — `viz/fieldgraph.ts`.
 *
 * The question the conditioned work exists to answer is "does this rule work in
 * this STATE", and that question is literally bipartite: rules on one side,
 * market states on the other, one arm per pair. `conditionedId` was built
 * parseable for exactly this — "so a survivor can be traced to its pair".
 *
 * THE TEST THAT MATTERS IS `an arm that did not clear its hurdle is drawn as
 * not clearing`. Measured on this archive, ZERO of 69 deep arms cleared: best
 * +0.070 against a hurdle of +0.102. A picture that drew all 150 arms the same
 * would turn that finding — the most important one this project has — into
 * decoration.
 *
 * THE SECOND IS `the hurdle comes from the row, never recomputed here`. Each row
 * recorded the hurdle it actually had to clear, which depends on how wide the
 * field was when it won. Re-deriving it now from a different field size would
 * quietly re-judge old rows against today's search.
 */

import { describe, expect, it } from "vitest";
import { fieldGraph, splitConditionedId } from "../src/viz/fieldgraph";
import { conditionedId } from "../src/backtest/conditioned";
import type { Discovered } from "../src/backtest/discovered";

const row = (over: Partial<Discovered> & { spec: Discovered["spec"] }): Discovered => ({
  origin: "conditioned",
  foundAt: 1_790_000_000,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 44_000,
  trials: 550,
  trades: 821,
  expectancy: 0.01,
  sharpe: 0.07,
  deflated: -0.032,
  hurdle: 0.102,
  costs: { spread: 0.0002, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 },
  status: "unproven",
  ...over,
});

const spec = (id: string) =>
  ({ id, name: id, style: "custom", long: [], stop: { type: "atr", mult: 2 }, target: { type: "rr", value: 2 } }) as unknown as Discovered["spec"];

describe("reading an arm back to its pair", () => {
  it("splits an id built by `conditionedId`", () => {
    const id = conditionedId("ema-cross", "usd-down");
    expect(splitConditionedId(id)).toEqual({ rule: "ema-cross", state: "usd-down" });
  });

  it("returns null for a rule that was never conditioned", () => {
    // A plain library rule has no state, and inventing one would put it on a
    // side of the picture it does not belong to.
    expect(splitConditionedId("ema-cross")).toBeNull();
  });

  it("SPLITS ON THE LAST SEPARATOR, so a rule id containing one survives", () => {
    /* A base id may itself contain a `+`. Splitting on the FIRST would cut the
       rule in half and invent a state from its own tail — an opaque key parsed
       by guessing, which this project already records as a defect. */
    const id = conditionedId("ema+rsi", "vol-up");
    expect(splitConditionedId(id)).toEqual({ rule: "ema+rsi", state: "vol-up" });
  });

  it("refuses a malformed id rather than repairing it", () => {
    expect(splitConditionedId("mc:")).toBeNull();
    expect(splitConditionedId("mc:only-a-rule")).toBeNull();
    expect(splitConditionedId("")).toBeNull();
  });
});

describe("the field", () => {
  const rows: readonly Discovered[] = [
    row({ spec: spec(conditionedId("ema-cross", "usd-down")), deflated: -0.03, hurdle: 0.102, trades: 821 }),
    row({ spec: spec(conditionedId("ema-cross", "vol-up")), deflated: 0.08, hurdle: 0.102, trades: 640 }),
    row({ spec: spec(conditionedId("rsi-rev", "usd-down")), deflated: -0.11, hurdle: 0.102, trades: 900 }),
    row({ spec: spec("plain-library-rule"), origin: "library", deflated: -0.2, hurdle: 0.45, trades: 58 }),
  ];

  it("puts rules on one side and states on the other", () => {
    const g = fieldGraph(rows);
    const groups = new Set(g.nodes.map((n) => n.group));
    expect(groups.has("rule")).toBe(true);
    expect(groups.has("state")).toBe(true);
    expect(g.nodes.filter((n) => n.group === "rule").map((n) => n.id).sort())
      .toEqual(["ema-cross", "rsi-rev"]);
    expect(g.nodes.filter((n) => n.group === "state").map((n) => n.id).sort())
      .toEqual(["usd-down", "vol-up"]);
  });

  it("one edge per arm, joining its rule to its state", () => {
    const g = fieldGraph(rows);
    expect(g.edges).toHaveLength(3);
    for (const e of g.edges) expect(e.from).not.toBe(e.to);
  });

  it("AN ARM THAT DID NOT CLEAR ITS HURDLE IS DRAWN AS NOT CLEARING", () => {
    /* THE FINDING THIS PICTURE EXISTS FOR. Zero of 69 deep arms cleared on this
       archive. Drawing all of them alike would turn that into decoration. */
    const g = fieldGraph(rows);
    const cleared = g.edges.filter((e) => e.value > 0);
    const missed = g.edges.filter((e) => e.value <= 0);
    expect(cleared).toHaveLength(1);
    expect(missed).toHaveLength(2);
  });

  it("THE HURDLE COMES FROM THE ROW, never recomputed here", () => {
    /* Each row recorded the hurdle it actually had to clear, which depends on
       how wide the field was when it won. Re-deriving it now would judge an old
       row against today's search — and the width has changed twice already. */
    const g = fieldGraph(rows);
    const src = fieldGraph.toString();
    expect(src).not.toContain("deflatedSharpe");
    expect(src).toContain("deflated");
    expect(g.summary.cleared).toBe(1);
    expect(g.summary.arms).toBe(3);
  });

  it("leaves an unconditioned rule out of the pairing, and counts it", () => {
    // A library rule has no state. Placing it anywhere on the state side would
    // be inventing the very thing the picture is measuring.
    const g = fieldGraph(rows);
    expect(g.nodes.some((n) => n.id === "plain-library-rule")).toBe(false);
    expect(g.summary.unpaired).toBe(1);
  });

  it("sizes a rule by how many states it was tried in", () => {
    // The search cost is per arm, so a rule tried in six states is six arms.
    const g = fieldGraph(rows);
    const ema = g.nodes.find((n) => n.id === "ema-cross")!;
    const rsi = g.nodes.find((n) => n.id === "rsi-rev")!;
    expect(ema.weight).toBeGreaterThan(rsi.weight);
  });

  it("states the field width, because it sets the hurdle for everything in it", () => {
    const g = fieldGraph(rows);
    expect(g.summary.why).toContain("3");
    expect(g.summary.why.length).toBeGreaterThan(30);
  });

  it("an empty shelf is an empty field, not a claim that nothing works", () => {
    const g = fieldGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.summary.arms).toBe(0);
    expect(g.summary.why).toContain("nothing");
  });

  it("weights every node into the range the layout expects", () => {
    const g = fieldGraph(rows);
    expect(g.nodes.every((n) => n.weight >= 0 && n.weight <= 1)).toBe(true);
  });
});
