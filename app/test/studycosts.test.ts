/**
 * WHAT A STUDY'S RULE TESTS ARE CHARGED — `study/steps.ts studyCosts`.
 *
 * The study had a two-way control, `standard` or `none`, so costs-off was
 * reachable and the broker's real spread was not. Measured against this account
 * the standard 2bp is 4.8x the true figure on gold — and because costs set the
 * hurdle a rule must clear, overcharging DISCARDS rules that would have cleared
 * what is actually paid, silently.
 *
 * THE TESTS THAT MATTER ARE THE FALLBACKS. `measured` with nothing to measure
 * has to land on the ASSUMPTION, never on a guess and never on the cheaper end:
 * a study charged a made-up spread would look exactly like one charged properly,
 * and the assumption is the harsher side, so a fallback cannot manufacture an
 * edge. Every path that cannot answer returns `standard`.
 */

import { describe, expect, it } from "vitest";
import { studyCosts } from "../src/study/steps";
import { DEFAULT_COSTS, ZERO_COSTS } from "../src/backtest/engine";
import type { BrokerSpec } from "../src/data/brokercosts";
import type { BarView } from "../src/chart/series";

/** XAUUSD as this operator's broker reports it, under the SUFFIXED name. */
const XAU: BrokerSpec = {
  symbol: "XAUUSD.s",
  digits: 2,
  point: 0.01,
  spread_points: 17,
  contract_size: 100,
  tick_size: 0.01,
  tick_value: 0.01,
  stops_level: 0,
  swap_long: -12,
  swap_short: -4,
} as BrokerSpec;

const bars = (close: number): BarView[] => [
  { t: 1, o: close, h: close, l: close, c: close, v: 1 },
  { t: 2, o: close, h: close, l: close, c: close, v: 1 },
];

const SPECS = { "XAUUSD.s": XAU } as Record<string, BrokerSpec>;
const PRICE = bars(4000);

describe("the two models that already existed are unchanged", () => {
  it("none is costs off", () => {
    expect(studyCosts("none", "XAUUSD", PRICE, SPECS)).toEqual(ZERO_COSTS);
  });

  it("standard is the engine's assumption", () => {
    expect(studyCosts("standard", "XAUUSD", PRICE, SPECS)).toEqual(DEFAULT_COSTS);
  });

  it("none wins even when a spec is available — the operator asked for no costs", () => {
    expect(studyCosts("none", "XAUUSD", PRICE, SPECS)).toEqual(ZERO_COSTS);
  });
});

describe("measured charges the broker's spread, and only the spread", () => {
  it("reads it through the broker's SUFFIXED name", () => {
    // The terminal says XAUUSD and the broker quotes XAUUSD.s — the pair that
    // cost a release when sizing could find neither spelling.
    const got = studyCosts("measured", "XAUUSD", PRICE, SPECS);
    expect(got.spread).toBeGreaterThan(0);
    expect(got.spread).toBeLessThan(DEFAULT_COSTS.spread);
  });

  it("leaves commission and slippage at the assumption, and that is deliberate", () => {
    // A broker's commission is per-lot and account-specific; slippage belongs to
    // the venue and the order size. Reading either off an instrument spec would
    // be a third model, neither measured nor assumed.
    const got = studyCosts("measured", "XAUUSD", PRICE, SPECS);
    expect(got.commission).toBe(DEFAULT_COSTS.commission);
    expect(got.slippage).toBe(DEFAULT_COSTS.slippage);
  });

  it("the spread is a fraction OF THE PRICE, so the price changes it", () => {
    // A spread in POINTS means nothing until you know what it is a fraction of
    // — the units trap this project has paid for more than once.
    const cheap = studyCosts("measured", "XAUUSD", bars(4000), SPECS);
    const dear = studyCosts("measured", "XAUUSD", bars(1000), SPECS);
    expect(dear.spread).toBeGreaterThan(cheap.spread);
  });
});

describe("it falls back to the ASSUMPTION rather than guessing", () => {
  it("no specs synced at all", () => {
    expect(studyCosts("measured", "XAUUSD", PRICE, undefined)).toEqual(DEFAULT_COSTS);
    expect(studyCosts("measured", "XAUUSD", PRICE, {})).toEqual(DEFAULT_COSTS);
  });

  it("a symbol the broker does not quote", () => {
    // BTCUSDT is Binance's; the broker has BTCUSD. Matching them would be the
    // EURUSD/EURUSDT trap — real numbers for a different market.
    expect(studyCosts("measured", "BTCUSDT", PRICE, SPECS)).toEqual(DEFAULT_COSTS);
  });

  it("a spec that gives no usable spread", () => {
    const broken = { "XAUUSD.s": { ...XAU, spread_points: 0 } } as Record<string, BrokerSpec>;
    expect(studyCosts("measured", "XAUUSD", PRICE, broken)).toEqual(DEFAULT_COSTS);
  });

  it("no bars, so no price to make a fraction from", () => {
    expect(studyCosts("measured", "XAUUSD", [], SPECS)).toEqual(DEFAULT_COSTS);
  });

  it("a price of zero does not divide", () => {
    expect(studyCosts("measured", "XAUUSD", bars(0), SPECS)).toEqual(DEFAULT_COSTS);
  });

  it("EVERY fallback lands on the harsher end, never the cheaper one", () => {
    // The direction is the safety property: a fallback that charged less would
    // manufacture an edge out of a missing broker sync.
    for (const got of [
      studyCosts("measured", "XAUUSD", PRICE, undefined),
      studyCosts("measured", "NOPE", PRICE, SPECS),
      studyCosts("measured", "XAUUSD", [], SPECS),
    ]) {
      expect(got.spread).toBe(DEFAULT_COSTS.spread);
      expect(got.spread).toBeGreaterThan(0);
    }
  });
});
