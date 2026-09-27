/**
 * THE HELD-BACK WINDOW — `backtest/holdout.ts`.
 *
 * The Playbook reported one window and said so: "a description of the past, not
 * evidence of an edge". The operator has already CHOSEN the rule set, usually
 * after seeing how it did, so a number computed over the window the choice was
 * made on cannot argue with it. Holding back the most recent slice is the
 * cheapest instrument that can.
 *
 * THE TESTS THAT MATTER ARE THE REFUSALS. A split that reports two percentages
 * over six trades a side looks exactly like a measurement and is noise — the
 * "0 of 0 running" mistake with a denominator attached. `enough: false` and a
 * sentence naming WHICH side is short is the honest output, and it is the most
 * common one on a short run.
 */

import { describe, expect, it } from "vitest";
import { splitRun, MIN_PER_SIDE, DEFAULT_HOLDOUT } from "../src/backtest/holdout";
import type { Trade } from "../src/backtest/engine";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** A trade entered on a given day, with a stated R. */
const trade = (day: number, r: number): Trade =>
  ({
    direction: "long",
    entryIndex: day,
    entryTime: T0 + day * DAY,
    entryPrice: 100,
    exitIndex: day + 1,
    exitTime: T0 + (day + 1) * DAY,
    exitPrice: 100 + r,
    exitReason: r > 0 ? "target" : "stop",
    rMultiple: r,
    returnPct: r / 100,
    reason: "test",
  }) as Trade;

/** `n` bars, one a day. */
const barTimes = (n: number): number[] => Array.from({ length: n }, (_, i) => T0 + i * DAY);

/** A flat equity curve of the right length — drawdown is not what these pin. */
const equity = (n: number): number[] => Array.from({ length: n }, () => 1000);

/** `n` trades spread over `days`, each with the same R. */
const spread = (n: number, days: number, r: number, from = 0): Trade[] =>
  Array.from({ length: n }, (_, i) => trade(from + Math.floor((i * days) / n), r));

describe("it refuses a comparison it cannot support", () => {
  it("names the side that is short", () => {
    // 40 early, 5 recent: enough overall, and the held-back window says nothing.
    const trades = [...spread(40, 60, 0.5), ...spread(5, 20, 0.5, 80)];
    const s = splitRun(trades, equity(100), barTimes(100), 0.2);
    expect(s.enough).toBe(false);
    expect(s.why).toMatch(/held-back window/i);
    expect(s.recentTrades).toBe(5);
    expect(s.agrees).toBeNull();
  });

  it("says so when BOTH sides are thin, rather than naming one", () => {
    const s = splitRun(spread(10, 90, 0.5), equity(100), barTimes(100), DEFAULT_HOLDOUT);
    expect(s.enough).toBe(false);
    expect(s.why).toMatch(/only \d+ and \d+ trades/);
  });

  it("a refusal carries no metrics to misread", () => {
    const s = splitRun(spread(4, 90, 0.5), equity(100), barTimes(100));
    expect(s.earlier.trades).toBe(0);
    expect(s.recent.trades).toBe(0);
    // The COUNTS are still reported — they are what the operator acts on.
    expect(s.earlierTrades + s.recentTrades).toBe(4);
  });

  it("refuses a share that is not a share", () => {
    for (const bad of [0, 1, -0.2, 1.5, NaN]) {
      expect(splitRun(spread(100, 90, 0.5), equity(100), barTimes(100), bad).enough).toBe(false);
    }
  });

  it("refuses when the bars span no time", () => {
    const flat = [T0, T0, T0];
    expect(splitRun(spread(100, 1, 0.5), equity(3), flat).why).toMatch(/span any time/i);
  });
});

describe("it compares the two windows when both can answer", () => {
  /* 60 winners early, 60 winners recent — over 200 days, split at the last 30%. */
  const agreeing = [...spread(60, 130, 0.5), ...spread(60, 60, 0.4, 140)];

  it("splits on TIME, so a rule that stopped trading is visible", () => {
    const s = splitRun(agreeing, equity(200), barTimes(200), 0.3);
    expect(s.enough).toBe(true);
    // The boundary is 70% of the way along the span, not 70% of the trades.
    expect(s.at).toBeGreaterThan(T0 + 130 * DAY);
    expect(s.at).toBeLessThan(T0 + 150 * DAY);
  });

  it("reports agreement when both windows point the same way", () => {
    const s = splitRun(agreeing, equity(200), barTimes(200), 0.3);
    expect(s.agrees).toBe(true);
    expect(s.why).toMatch(/same way/i);
    expect(s.earlierTrades).toBeGreaterThanOrEqual(MIN_PER_SIDE);
    expect(s.recentTrades).toBeGreaterThanOrEqual(MIN_PER_SIDE);
  });

  it("CATCHES THE CASE IT EXISTS FOR: made money early, loses it recently", () => {
    const turned = [...spread(60, 130, 0.8), ...spread(60, 60, -0.6, 140)];
    const s = splitRun(turned, equity(200), barTimes(200), 0.3);
    expect(s.enough).toBe(true);
    expect(s.agrees).toBe(false);
    expect(s.why).toMatch(/disagree/i);
    expect(s.earlier.expectancyR).toBeGreaterThan(0);
    expect(s.recent.expectancyR).toBeLessThan(0);
  });

  it("compares the SIGN, not the size — a halved edge still agrees", () => {
    // A rule whose expectancy fell from 0.8R to 0.1R is still a rule that works,
    // and calling that a disagreement would cry wolf on every real strategy.
    const faded = [...spread(60, 130, 0.8), ...spread(60, 60, 0.1, 140)];
    const s = splitRun(faded, equity(200), barTimes(200), 0.3);
    expect(s.agrees).toBe(true);
  });

  it("each window's trades are counted once and only once", () => {
    const s = splitRun(agreeing, equity(200), barTimes(200), 0.3);
    expect(s.earlierTrades + s.recentTrades).toBe(agreeing.length);
  });

  it("a bigger holdout moves the boundary earlier", () => {
    const small = splitRun(agreeing, equity(200), barTimes(200), 0.2);
    const big = splitRun(agreeing, equity(200), barTimes(200), 0.5);
    expect(big.at).toBeLessThan(small.at);
  });
});
