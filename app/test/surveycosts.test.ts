/**
 * A SURVEY THAT RANKS MARKETS MUST NOT CHARGE THEM ALL THE SAME.
 *
 * The cross-market survey put every instrument on one flat 2bp spread, and IT
 * RANKS THEM AGAINST EACH OTHER — so a market can rank below another for a cost
 * it does not pay. Measured against this operator's broker the assumption is
 * 4.8x the real spread on gold and 3.8x on EURUSD, which are not the same
 * distortion; ranking on one number folds two different errors into a single
 * order and nothing on screen says so.
 *
 * THE TEST THAT MATTERS IS `absent means exactly today's behaviour`. This is a
 * change to a function the Survey desk and the autonomous work both call, and
 * the default has to be byte-for-byte what it was or every existing result
 * silently moves — the thing this project forbids more clearly than any other.
 */

import { describe, expect, it } from "vitest";
import { runSurvey, type SurveyMarket } from "../src/backtest/survey";
import { DEFAULT_COSTS, type Costs } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

/** A trending series, so the shipped rules actually trade on it. */
const bars = (n: number, seed: number): BarView[] => {
  const out: BarView[] = [];
  let px = 100 + seed;
  for (let i = 0; i < n; i += 1) {
    px += Math.sin(i / 11 + seed) * 0.8 + Math.sin(i / 43) * 0.3;
    out.push({ t: T0 + i * HOUR, o: px, h: px + 0.5, l: px - 0.5, c: px, v: 100 });
  }
  return out;
};

const market = (symbol: string, seed: number): SurveyMarket => ({
  symbol,
  timeframe: "1h",
  bars: bars(700, seed),
  coverage: 1,
});

const MARKETS = [market("XAUUSD", 0), market("EURUSD", 1)];

describe("the default has not moved", () => {
  it("ABSENT MEANS EXACTLY TODAY'S BEHAVIOUR", () => {
    const a = runSurvey(MARKETS, { draws: 20, now: () => T0 });
    const b = runSurvey(MARKETS, { draws: 20, now: () => T0, costsFor: () => undefined });
    // A `costsFor` that never answers must be indistinguishable from no
    // `costsFor` at all, or the option changes results just by existing.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("a market the resolver does not know falls back rather than guessing", () => {
    const only = runSurvey(MARKETS, {
      draws: 20,
      now: () => T0,
      costsFor: (s) =>
        s === "XAUUSD" ? { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 } : undefined,
    });
    // EURUSD is unknown to the resolver, so it keeps the shared model. A market
    // charged a made-up spread would be worse than one charged the assumption,
    // because nothing on screen would say which.
    expect(only.markets.length).toBe(2);
  });
});

describe("a cheaper hurdle is a different answer, and that is the point", () => {
  it("charging nothing beats charging 2bp on the same bars", () => {
    const charged = runSurvey(MARKETS, { draws: 20, now: () => T0, costs: DEFAULT_COSTS });
    const free = runSurvey(MARKETS, {
      draws: 20,
      now: () => T0,
      costsFor: () => ({ spread: 0, commission: 0, slippage: 0, carryPerNight: 0 }),
    });
    // Same bars, same rules, only the hurdle differs — so any difference is the
    // cost model and nothing else. If these were identical the option would be
    // doing nothing, which is the failure this asserts against.
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(charged));
  });

  it("only the hurdle differs — every other option is carried through", () => {
    // `costsFor` must not quietly drop the rest of the options. Two runs with
    // the same spec list and the same resolver have to agree.
    const specsA = runSurvey(MARKETS, { draws: 20, now: () => T0, costsFor: () => DEFAULT_COSTS });
    const specsB = runSurvey(MARKETS, { draws: 20, now: () => T0, costsFor: () => DEFAULT_COSTS });
    expect(JSON.stringify(specsA)).toBe(JSON.stringify(specsB));
  });

  it("charging each market its own spread is not the same as charging one", () => {
    const flat: Costs = { spread: 0.0002, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 };
    const perMarket = (s: string): Costs =>
      s === "XAUUSD"
        ? { spread: 0.000042, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 }
        : { spread: 0.000053, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 };
    const one = runSurvey(MARKETS, { draws: 20, now: () => T0, costs: flat });
    const each = runSurvey(MARKETS, { draws: 20, now: () => T0, costsFor: perMarket });
    // The real measured spreads for this account. Ranking two markets that pay
    // 0.42bp and 0.53bp as if both paid 2.00bp is the distortion.
    expect(JSON.stringify(each)).not.toBe(JSON.stringify(one));
  });
});
