/**
 * The shelf of strategies the terminal found by itself: what is kept, what is
 * dropped, and the rule that retires one when the forward record disagrees
 * with its backtest.
 */

import { describe, expect, it } from "vitest";
import {
  DISCOVERED_SLOT,
  MIN_FORWARD_TRADES,
  addDiscovered,
  applyForward,
  forwardVerdict,
  keyOf,
  promoteDiscovered,
  retireDiscovered,
  spreadOf,
  type Discovered,
} from "../src/backtest/discovered";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import type { RuleSpec } from "../src/backtest/rules";

const spec = (id: string): RuleSpec => ({
  id,
  name: id,
  style: "custom",
  long: [["ema9", "crossabove", "ema21"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "rr", value: 2 },
});

const row = (over: Partial<Discovered> = {}): Discovered => ({
  spec: spec("s1"),
  origin: "hybrid",
  foundAt: 1_000,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 5_000,
  trials: 400,
  trades: 120,
  /* 0.40R a trade with a per-trade Sharpe of 0.4 → a spread of 1.0R. */
  expectancy: 0.4,
  sharpe: 0.4,
  deflated: 0.11,
  hurdle: 0.29,
  costs: DEFAULT_COSTS,
  status: "unproven",
  ...over,
});

describe("the row", () => {
  it("is one per strategy per instrument", () => {
    expect(keyOf(row())).toBe("s1|BTCUSDT|1h");
    expect(keyOf(row({ timeframe: "4h" }))).not.toBe(keyOf(row()));
  });

  it("recovers the per-trade spread the backtest had", () => {
    expect(spreadOf(row())).toBeCloseTo(1, 6);
    expect(spreadOf(row({ sharpe: 0 }))).toBe(0);
  });
});

describe("the forward rule", () => {
  it("refuses to judge a sample too small to answer", () => {
    const v = forwardVerdict(row(), { trades: MIN_FORWARD_TRADES - 1, expectancy: -2, from: 0 });
    expect(v.kind).toBe("too-few");
    expect(v.why).toContain(String(MIN_FORWARD_TRADES));
  });

  it("holds when the gap is inside the noise of the sample", () => {
    /* 25 forward trades, spread 1.0R → SE 0.20R, floor 0.40 − 0.40 = 0.00R. */
    expect(forwardVerdict(row(), { trades: 25, expectancy: 0.05, from: 0 }).kind).toBe("holding");
  });

  it("retires when it is two standard errors below, and says the arithmetic", () => {
    const v = forwardVerdict(row(), { trades: 25, expectancy: -0.3, from: 0 });
    expect(v.kind).toBe("below");
    expect(v.why).toContain("0.40R");
    expect(v.why).toContain("spread");
  });

  it("never acts on a strategy doing better than its backtest", () => {
    expect(forwardVerdict(row(), { trades: 100, expectancy: 5, from: 0 }).kind).toBe("holding");
  });

  it("applyForward retires the row, keeping the reason", () => {
    const out = applyForward(row(), { trades: 25, expectancy: -0.3, from: 0 });
    expect(out.status).toBe("retired");
    expect(out.retiredWhy).toContain("below");
    expect(out.forward?.trades).toBe(25);
  });

  it("applyForward records a holding run without changing the status", () => {
    const out = applyForward(row(), { trades: 25, expectancy: 0.35, from: 0 });
    expect(out.status).toBe("unproven");
    expect(out.forward?.expectancy).toBeCloseTo(0.35, 6);
  });
});

describe("the shelf", () => {
  it("replaces a re-run of the same strategy but keeps when it was first found", () => {
    const first = row({ foundAt: 1_000, expectancy: 0.4 });
    const again = row({ foundAt: 9_999, expectancy: 0.2 });
    const out = addDiscovered([first], again);
    expect(out).toHaveLength(1);
    expect(out[0]?.expectancy).toBeCloseTo(0.2, 6);
    expect(out[0]?.foundAt).toBe(1_000);
  });

  it("does not demote a promoted strategy when the search runs again", () => {
    const promoted = row({ status: "promoted" });
    const out = addDiscovered([promoted], row({ status: "unproven" }));
    expect(out[0]?.status).toBe("promoted");
  });

  it("keeps rows for the same rule on other instruments", () => {
    const out = addDiscovered([row()], row({ symbol: "ETHUSDT" }));
    expect(out).toHaveLength(2);
  });

  it("drops retired rows first at the cap, and never a promoted one", () => {
    const list: Discovered[] = [
      row({ spec: spec("keep-promoted"), status: "promoted", deflated: 0.01 }),
      row({ spec: spec("retired-1"), status: "retired", deflated: 0.9 }),
      row({ spec: spec("unproven-weak"), deflated: 0.02 }),
    ];
    const out = addDiscovered(list, row({ spec: spec("new") }), 3);
    const ids = out.map((d) => d.spec.id);
    expect(ids).toContain("keep-promoted");
    expect(ids).toContain("new");
    expect(ids).not.toContain("retired-1");
  });

  it("promotes and retires by key", () => {
    const list = [row()];
    expect(promoteDiscovered(list, "s1|BTCUSDT|1h")[0]?.status).toBe("promoted");
    const retired = retireDiscovered(list, "s1|BTCUSDT|1h", "I stopped believing it");
    expect(retired[0]?.status).toBe("retired");
    expect(retired[0]?.retiredWhy).toBe("I stopped believing it");
  });
});

describe("the slot", () => {
  it("keeps good rows and drops malformed ones without losing the shelf", () => {
    const good = row();
    expect(DISCOVERED_SLOT.validate([good, { spec: { id: "x" } }, null])).toEqual([good]);
    expect(DISCOVERED_SLOT.validate("nonsense")).toBeNull();
    expect(DISCOVERED_SLOT.fallback()).toEqual([]);
  });
});
