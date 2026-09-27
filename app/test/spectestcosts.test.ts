/**
 * THE PROMOTION TEST'S HURDLE — `backtest/spectest.ts`.
 *
 * This function DECIDES WHAT GETS PROMOTED, so the cost model is the most
 * consequential input it takes. It charged a hardcoded flat 2bp spread, which is
 * 4.8x this operator's real cost on gold — and overcharging a promotion test
 * rejects rules that would have cleared the spread actually paid, silently, with
 * nothing on screen saying why.
 *
 * WHAT CHANGED IS NOT THE NUMBER. The default is exactly what it was; the caller
 * may now say otherwise, and the result already carried its cost model so a
 * promotion can be re-derived from the figures that produced it.
 *
 * THE TEST THAT MATTERS BEYOND THE DEFAULT is `the benchmark is charged the same
 * model`. `randomEntryTest` is the yardstick the rule is measured against, and it
 * took `DEFAULT_COSTS` directly while the rule took `base.costs` — so a caller
 * passing a cheaper model would have compared its rule against a benchmark
 * paying something else. "A LEDGER MUST PRICE THE WAY THE ENGINE PRICES",
 * arriving in the one place whose whole job is a fair comparison.
 */

import { describe, expect, it } from "vitest";
import { runSpecTest } from "../src/backtest/spectest";
import { SPECS } from "../src/backtest/specs";
import { DEFAULT_COSTS, type Costs } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

/** A series with enough movement for the shipped rules to trade. */
const bars = (n: number): BarView[] => {
  const out: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    px += Math.sin(i / 13) * 0.9 + Math.sin(i / 47) * 0.4;
    out.push({ t: T0 + i * HOUR, o: px, h: px + 0.5, l: px - 0.5, c: px, v: 100 });
  }
  return out;
};

const SPEC = SPECS[0]!;
/* 3,000 bars, not 900. The random-entry benchmark REFUSES below 30 trades, and
   900 bars of this wave produced 21 — so both cost models returned the same
   refusal object and the comparison below asserted nothing. Measured, not
   guessed: the probe printed `21 trades; 30 needed`. A fixture too small to
   reach the code under test is a test that passes on its own emptiness. */
const BARS = bars(3000);
const FREE: Costs = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };

describe("the default has not moved", () => {
  it("no costs given charges exactly what it always charged", () => {
    const r = runSpecTest(SPEC, BARS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costs.spread_fraction).toBe(DEFAULT_COSTS.spread);
    expect(r.costs.commission_fraction_per_side).toBe(DEFAULT_COSTS.commission);
    expect(r.costs.slippage_fraction).toBe(DEFAULT_COSTS.slippage);
  });

  it("passing the default explicitly is the same run", () => {
    // An option that changes a result just by being supplied would move every
    // existing promotion silently.
    const a = runSpecTest(SPEC, BARS);
    const b = runSpecTest(SPEC, BARS, { costs: DEFAULT_COSTS });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("a caller may charge something else, and the result says so", () => {
  it("honours the model it was given", () => {
    const r = runSpecTest(SPEC, BARS, { costs: FREE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costs.spread_fraction).toBe(0);
    expect(r.costs.commission_fraction_per_side).toBe(0);
  });

  it("a cheaper hurdle is a different answer — otherwise the option is inert", () => {
    const charged = runSpecTest(SPEC, BARS);
    const free = runSpecTest(SPEC, BARS, { costs: FREE });
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(charged));
  });

  it("THE BENCHMARK IS CHARGED THE SAME MODEL AS THE RULE", () => {
    /* `randomEntryTest` is the yardstick. It took DEFAULT_COSTS directly while
       the rule took `base.costs`, so a caller passing a cheaper model would have
       measured its rule against a benchmark paying something else — two games,
       and the disagreement would never surface as an error.

       With costs off, a random-entry benchmark cannot be paying 2bp: its edge
       has to differ from the charged run's. */
    const charged = runSpecTest(SPEC, BARS);
    const free = runSpecTest(SPEC, BARS, { costs: FREE });
    expect(charged.ok && free.ok).toBe(true);
    if (!charged.ok || !free.ok) return;
    expect(JSON.stringify(free.random_entry)).not.toBe(JSON.stringify(charged.random_entry));
  });
});
