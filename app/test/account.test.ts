/**
 * THE ACCOUNT SIMULATION — what the run did to real money, including killing it.
 *
 * WHAT THESE PIN
 *
 *  1. RUIN STOPS THE RUN. The engine's equity curve is a MULTIPLIER and
 *     multipliers never reach zero — risking 1% of a shrinking balance leaves
 *     something after the two-hundredth loss. Real accounts are closed out.
 *     A curve that carries on past the point the account died is the most
 *     flattering error available, because every recovery after it is imaginary.
 *
 *  2. THE TRADES IT NEVER LIVED TO TAKE ARE COUNTED AND NAMED. Silently doing
 *     less than the run contained is the same shape as a study whose dead
 *     vendors vanished from its reported window.
 *
 *  3. DOWNSAMPLING KEEPS THE EXTREMES. The distance between the peak and the
 *     trough IS the drawdown, so a chart drawn from every-nth points would
 *     understate the one number that decides whether anyone could sit through
 *     the run.
 *
 *  4. RISK IS SIZED ON THE BALANCE BEFORE THE TRADE. Sizing on the balance
 *     after would use the trade's own result to decide how big it was.
 */

import { describe, expect, it } from "vitest";
import { simulateAccount, curvePoints } from "../src/backtest/account";
import type { Trade } from "../src/backtest/engine";

const HOUR = 3_600_000;

const trade = (i: number, r: number): Trade => ({
  direction: "long",
  entryIndex: i,
  entryTime: i * HOUR,
  entryPrice: 100,
  exitIndex: i + 1,
  exitTime: (i + 1) * HOUR,
  exitPrice: 100 + r,
  exitReason: r > 0 ? "target" : "stop",
  rMultiple: r,
  returnPct: r / 100,
  reason: "test",
  maeR: 0,
  mfeR: 0,
});

describe("an account that dies stays dead", () => {
  it("stops at the ruin floor and says how many trades it never reached", () => {
    // Twenty full losses at 20% risk takes $500 below $50 long before the end,
    // and the ten winners after it must not resurrect it.
    const losses = Array.from({ length: 20 }, (_, i) => trade(i, -1));
    const wins = Array.from({ length: 10 }, (_, i) => trade(20 + i, 3));
    const run = simulateAccount([...losses, ...wins], { balance: 500, riskPct: 20 });

    expect(run.ruinedAt).not.toBeNull();
    expect(run.taken).toBeLessThan(30);
    expect(run.unreachable).toBe(30 - run.taken);
    expect(run.end).toBeLessThanOrEqual(50);
    // The reason is on screen, not inferred from a smaller number.
    expect(run.why).toContain("closes the account out");
  });

  it("survives the same trades at a risk the account can carry", () => {
    const losses = Array.from({ length: 20 }, (_, i) => trade(i, -1));
    const wins = Array.from({ length: 10 }, (_, i) => trade(20 + i, 3));
    const run = simulateAccount([...losses, ...wins], { balance: 500, riskPct: 1 });

    expect(run.ruinedAt).toBeNull();
    expect(run.taken).toBe(30);
    expect(run.unreachable).toBe(0);
    expect(run.why).toBe("");
    // 20 losses then 10 wins at 3R: comfortably ahead.
    expect(run.end).toBeGreaterThan(500);
  });
});

describe("the arithmetic is the one every risk rule here means", () => {
  it("risks a percent of the balance BEFORE the trade, and compounds", () => {
    const run = simulateAccount([trade(0, 1), trade(1, 1)], { balance: 1000, riskPct: 10 });
    // 1000 -> 1100 -> 1210. Not 1200, which is what fixed-money sizing gives.
    expect(run.end).toBeCloseTo(1210, 6);
  });

  it("reports the largest peak-to-trough fall, not the fall from the start", () => {
    // Up 50%, then down to below the start: the drawdown is measured from the
    // peak, which is the only number a person sitting through it experiences.
    const run = simulateAccount([trade(0, 5), trade(1, -4)], { balance: 1000, riskPct: 10 });
    expect(run.peak).toBeCloseTo(1500, 6);
    expect(run.maxDrawdown).toBeCloseTo(0.4, 6);
  });

  it("refuses a balance or a risk of zero rather than dividing by it", () => {
    const zero = simulateAccount([trade(0, 1)], { balance: 0, riskPct: 1 });
    expect(zero.why).toContain("above zero");
    expect(zero.curve).toHaveLength(0);
    expect(simulateAccount([trade(0, 1)], { balance: 500, riskPct: 0 }).why).toContain("above zero");
  });

  it("orders trades by when they CLOSED, because that is when the money moved", () => {
    const late = { ...trade(0, 1), exitTime: 99 * HOUR };
    const early = { ...trade(50, -1), exitTime: 2 * HOUR };
    const run = simulateAccount([late, early], { balance: 1000, riskPct: 10 });
    // -10% then +10% of the reduced balance: 1000 -> 900 -> 990.
    expect(run.end).toBeCloseTo(990, 6);
  });
});

describe("downsampling cannot flatten the drawdown", () => {
  it("keeps the highest and lowest point of the curve", () => {
    const pts = Array.from({ length: 5000 }, (_, i) => ({ t: i, equity: 1000 + Math.sin(i / 50) * 10 }));
    // A spike and a crater buried mid-series, which every-nth sampling loses.
    pts[1234] = { t: 1234, equity: 9999 };
    pts[3777] = { t: 3777, equity: 1 };

    const cut = curvePoints(pts, 200);
    expect(cut.length).toBeLessThanOrEqual(220);
    expect(Math.max(...cut.map((p) => p.equity))).toBe(9999);
    expect(Math.min(...cut.map((p) => p.equity))).toBe(1);
  });

  it("stays in time order and ends where the curve ends", () => {
    const pts = Array.from({ length: 3000 }, (_, i) => ({ t: i * HOUR, equity: 500 + i }));
    const cut = curvePoints(pts, 100);
    for (let i = 1; i < cut.length; i += 1) {
      expect((cut[i] as { t: number }).t).toBeGreaterThanOrEqual((cut[i - 1] as { t: number }).t);
    }
    expect((cut[cut.length - 1] as { t: number }).t).toBe(2999 * HOUR);
  });

  it("returns the curve unchanged when it already fits", () => {
    const pts = [
      { t: 1, equity: 10 },
      { t: 2, equity: 20 },
    ];
    expect(curvePoints(pts, 400)).toEqual(pts);
  });
});
