/**
 * THE CANDIDATE LEDGER — every setup that occurred, not every trade that was taken.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE TRADE LOG
 *
 * The obvious training set for a "will this win?" model is the history of
 * trades the system took. It is the wrong one, and the reason is the whole
 * point of this file: a backtest SKIPS a signal while a position is already
 * open, and skips whatever a filter rejected. So the trade log is a SELECTED
 * sample — you never observe what the skipped setups would have done — and a
 * model trained on it learns the selection rule, not the market.
 *
 * The ledger records a candidate at EVERY bar the entry condition was true,
 * whether or not a position was open, whether or not any filter liked it, with
 * the outcome it would have had. That is the sample a router can honestly be
 * trained and scored on.
 *
 * WHAT THESE TESTS PIN
 *
 *  1. OVERLAPPING SETUPS ARE ALL RECORDED. This is the selection-bias fix, and
 *     it is the one property that makes the ledger different from the trade log.
 *  2. NO LOOK-AHEAD. Features come from bars up to and including the signal
 *     bar; the outcome comes strictly after it. A feature that can see its own
 *     answer makes a model that is perfect in backtest and worthless live.
 *  3. A TIMEOUT IS ITS OWN OUTCOME. A setup that reaches neither level inside
 *     the horizon is not a loss. Labelling it one teaches the model that
 *     "nothing happened" looks like "I was wrong", which are different, and the
 *     second is the only one worth avoiding.
 *  4. THE LABEL CARRIES ITS BASIS. Resolved from minutes or assumed by the
 *     pessimistic rule — the model should be able to train on the resolved ones
 *     alone if it wants to, and it cannot if the two are indistinguishable.
 *  5. IT USES THE ENGINE'S OWN FILL MODEL. A ledger priced differently from the
 *     backtest trains the router on a game the engine does not play.
 */

import { describe, expect, it } from "vitest";
import { buildLedger, type Signal } from "../src/backtest/ledger";
import { DEFAULT_COSTS, ZERO_COSTS } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/** A bar with an explicit range, so a test can place a stop or target in it. */
const bar = (i: number, o: number, h: number, l: number, c: number): BarView => ({
  t: i * HOUR,
  o,
  h,
  l,
  c,
  v: 1,
});

/** Flat bars at 100, so nothing is hit unless a test puts it there. */
const flat = (n: number, from = 0): BarView[] =>
  Array.from({ length: n }, (_, k) => bar(from + k, 100, 100.5, 99.5, 100));

const longAt = (i: number): Signal => ({
  index: i,
  direction: "long",
  stop: 98,
  target: 104,
  reason: "test",
  features: { rsi: 30, adx: 25 },
});

describe("the ledger records setups, not trades", () => {
  it("RECORDS OVERLAPPING SETUPS — the trade log's selection is the whole problem", () => {
    /* Three signals one bar apart. A backtest takes the first and skips the
       next two while that position is open; the ledger keeps all three,
       because what the skipped two would have done is exactly the information
       a router needs and the trade log destroys. */
    const bars = [...flat(3), bar(3, 100, 105, 99.5, 104), ...flat(10, 4)];
    const led = buildLedger(bars, [longAt(0), longAt(1), longAt(2)], { horizon: 8 });
    expect(led.candidates).toHaveLength(3);
  });

  it("gives every candidate the bar it was signalled on", () => {
    const bars = [...flat(3), bar(3, 100, 105, 99.5, 104), ...flat(10, 4)];
    const led = buildLedger(bars, [longAt(0), longAt(2)], { horizon: 8 });
    expect(led.candidates.map((c) => c.index)).toEqual([0, 2]);
  });
});

describe("the outcome, and when it refuses to name one", () => {
  it("labels a target reached before the stop", () => {
    const bars = [...flat(2), bar(2, 100, 106, 99.5, 105), ...flat(8, 3)];
    const led = buildLedger(bars, [longAt(0)], { horizon: 8, costs: ZERO_COSTS });
    expect(led.candidates[0]?.outcome).toBe("target");
  });

  it("labels a stop reached before the target", () => {
    const bars = [...flat(2), bar(2, 100, 100.5, 97, 98), ...flat(8, 3)];
    const led = buildLedger(bars, [longAt(0)], { horizon: 8, costs: ZERO_COSTS });
    expect(led.candidates[0]?.outcome).toBe("stop");
  });

  it("calls a setup that reached NEITHER a timeout, never a loss", () => {
    /* "Nothing happened" and "I was wrong" are different facts, and only the
       second is worth learning to avoid. Folding one into the other teaches
       the model to fear quiet markets. */
    const led = buildLedger(flat(12), [longAt(0)], { horizon: 6 });
    expect(led.candidates[0]?.outcome).toBe("timeout");
  });

  it("assumes the STOP when one bar holds both, and says the basis was assumed", () => {
    const bars = [...flat(2), bar(2, 100, 106, 97, 100), ...flat(8, 3)];
    const led = buildLedger(bars, [longAt(0)], { horizon: 8 });
    expect(led.candidates[0]?.outcome).toBe("stop");
    expect(led.candidates[0]?.basis).toBe("assumed");
  });

  it("reports basis MEASURED when minutes settle the ambiguous bar", () => {
    /* The same bar, with minutes showing the target came first. Without them
       the pessimistic rule stands; with them it is a fact. */
    const bars = [...flat(2), bar(2, 100, 106, 97, 100), ...flat(8, 3)];
    /* SIXTY minutes, because the parent is an hour. The first draft supplied
       two and the coverage guard refused it — correctly, and for the second
       time in this build: two minutes cannot settle a sixty-minute bar, and a
       resolver that accepted them would be reading the second touch as the
       first. Minute 3 takes the target, minute 40 would have taken the stop. */
    const minutes = Array.from({ length: 60 }, (_, k) => {
      const t = 2 * HOUR + k * 60_000;
      if (k === 3) return { t, o: 100, h: 106, l: 99.5, c: 105, v: 1 };
      if (k === 40) return { t, o: 105, h: 105, l: 97, c: 98, v: 1 };
      return { t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 };
    });
    const led = buildLedger(bars, [longAt(0)], {
      horizon: 8,
      minutes: { barMs: HOUR, bars: minutes },
    });
    expect(led.candidates[0]?.outcome).toBe("target");
    expect(led.candidates[0]?.basis).toBe("measured");
  });
});

describe("no look-ahead", () => {
  it("resolves the outcome strictly AFTER the signal bar", () => {
    /* The signal bar itself trades through the target. If the resolver looked
       at it, this would be a winner on the bar the decision was made — the
       single most common backtest lie, one level down from the fill. */
    const bars = [bar(0, 100, 106, 99.5, 100), ...flat(10, 1)];
    const led = buildLedger(bars, [longAt(0)], { horizon: 8 });
    expect(led.candidates[0]?.outcome).toBe("timeout");
  });

  it("keeps the features it was handed, and adds nothing from the future", () => {
    const led = buildLedger(flat(12), [longAt(0)], { horizon: 6 });
    expect(led.candidates[0]?.features).toEqual({ rsi: 30, adx: 25 });
  });
});

describe("priced the way the engine prices", () => {
  it("charges the entry through the same fill model, so R is comparable", () => {
    const bars = [...flat(2), bar(2, 100, 106, 99.5, 105), ...flat(8, 3)];
    const free = buildLedger(bars, [longAt(0)], { horizon: 8, costs: ZERO_COSTS });
    const paid = buildLedger(bars, [longAt(0)], { horizon: 8, costs: DEFAULT_COSTS });
    /* Costs can only reduce a winner's R. A ledger that ignores them trains a
       router on a market with no spread. */
    expect(paid.candidates[0]?.rMultiple).toBeLessThan(free.candidates[0]?.rMultiple ?? 0);
  });

  it("summarises what share of its labels were actually measured", () => {
    const bars = [...flat(2), bar(2, 100, 106, 97, 100), ...flat(8, 3)];
    const led = buildLedger(bars, [longAt(0), longAt(1)], { horizon: 8 });
    expect(led.measuredShare).toBe(0);
    expect(led.candidates).toHaveLength(2);
  });
});

describe("refusing rather than approximating", () => {
  it("drops a signal whose stop is on the wrong side and names it", () => {
    const bad: Signal = { ...longAt(0), stop: 106 };
    const led = buildLedger(flat(12), [bad], { horizon: 6 });
    expect(led.candidates).toHaveLength(0);
    expect(led.skipped).toBe(1);
    expect(led.why).toMatch(/stop/i);
  });

  it("drops a signal with no bars after it to resolve against", () => {
    const led = buildLedger(flat(3), [longAt(2)], { horizon: 6 });
    expect(led.candidates).toHaveLength(0);
    expect(led.skipped).toBe(1);
  });
});
