import { describe, it, expect } from "vitest";
import { runBacktest, ZERO_COSTS, type BarView, type Strategy, type Trade } from "../src/backtest/engine";
import { percentile, readExcursions } from "../src/backtest/excursion";

const H = 3_600_000;

const bar = (i: number, o: number, h: number, l: number, c: number): BarView => ({ t: i * H, o, h, l, c, v: 1 });

/** Flat bars after the scripted ones, so the engine's minimum length is met. */
const pad = (from: number, price: number, n = 10): BarView[] =>
  Array.from({ length: n }, (_, k) => bar(from + k, price, price, price, price));

/** Enters once, on the first decision, and never again. */
const once = (direction: "long" | "short", stop: number, target?: number): Strategy => ({
  id: "once",
  label: "once",
  warmup: 0,
  entry: (_ctx, i) => (i === 0 ? { direction, stop, ...(target !== undefined ? { target } : {}), reason: "test" } : null),
});

describe("engine MAE/MFE", () => {
  it("a stop-out counts the adverse side only up to the stop, and none of the exit bar's favourable side", () => {
    // Entry fills at bar 1's open, 100; 1R = 5.
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 103, 97, 101),
      bar(2, 101, 108, 99, 107),
      bar(3, 107, 111, 90, 95), // hits both; the engine takes the stop
      ...pad(4, 95),
    ];
    const t = runBacktest(once("long", 95, 110), bars, { costs: ZERO_COSTS }).trades[0] as Trade;
    expect(t.exitReason).toBe("stop");
    expect(t.maeR).toBeCloseTo(1, 10); // capped at the stop, not the 90 low: (100-95)/5
    expect(t.mfeR).toBeCloseTo(1.6, 10); // bar 2's 108, not bar 3's 111: (108-100)/5
  });

  it("a target exit caps the favourable side at the target and keeps the bar's adverse side", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 103, 97, 101),
      bar(2, 101, 108, 99, 107),
      bar(3, 107, 112, 96, 111),
      ...pad(4, 111),
    ];
    const t = runBacktest(once("long", 95, 110), bars, { costs: ZERO_COSTS }).trades[0] as Trade;
    expect(t.exitReason).toBe("target");
    expect(t.mfeR).toBeCloseTo(2, 10); // (110-100)/5, not the 112 high
    expect(t.maeR).toBeCloseTo(0.8, 10); // bar 3's 96: (100-96)/5
  });

  it("measures a short from the other side, through to the end of the data", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 102, 96, 98),
      bar(2, 98, 104, 93, 94),
      ...pad(3, 94),
    ];
    const t = runBacktest(once("short", 105), bars, { costs: ZERO_COSTS }).trades[0] as Trade;
    expect(t.exitReason).toBe("end-of-data");
    expect(t.maeR).toBeCloseTo(0.8, 10); // high 104 against a 100 short: 4/5
    expect(t.mfeR).toBeCloseTo(1.4, 10); // low 93: 7/5
  });
});

describe("percentile", () => {
  it("is nearest-rank, so it always names a value that occurred", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(percentile([], 0.5)).toBe(0);
  });
});

const trade = (
  returnPct: number,
  rMultiple: number,
  maeR: number,
  mfeR: number,
  exitReason: Trade["exitReason"] = returnPct > 0 ? "rule" : "stop",
): Trade => ({
  direction: "long",
  entryIndex: 0,
  entryTime: 0,
  entryPrice: 100,
  exitIndex: 1,
  exitTime: H,
  exitPrice: 100,
  exitReason,
  rMultiple,
  returnPct,
  reason: "",
  maeR,
  mfeR,
});

describe("readExcursions", () => {
  // 15 winners with MAE 0.1..1.5, R 1 and MFE 2; 15 losers with MFE 0..2.8.
  const winners = Array.from({ length: 15 }, (_, k) => trade(0.01, 1, 0.1 * (k + 1), 2));
  const losers = Array.from({ length: 15 }, (_, k) => trade(-0.01, -1, 1, 0.2 * k));

  it("reads winners' heat, losers' give-back and the capture ratio", () => {
    const r = readExcursions([...winners, ...losers]);
    expect(r.refused).toBeNull();
    expect(r.winnerMaeP50).toBeCloseTo(0.8, 10); // rank ceil(7.5) = 8 of 15
    expect(r.winnerMaeP90).toBeCloseTo(1.4, 10); // rank ceil(13.5) = 14
    expect(r.loserMfeP50).toBeCloseTo(1.4, 10); // 8th of 0, 0.2, ... 2.8
    expect(r.losersOnceUp1R).toBeCloseTo(10 / 15, 10); // 1.0 .. 2.8 is ten values
    expect(r.captureP50).toBeCloseTo(0.5, 10); // 1R kept of 2R available
    expect(r.targetWinners).toBe(0);
    expect(r.points).toHaveLength(30);
  });

  it("leaves target exits out of capture, whose excursion the target itself caps", () => {
    // Ten rule exits keeping 1R of 4R, five target exits "keeping" 2R of 2R.
    const mixed = [
      ...Array.from({ length: 10 }, () => trade(0.01, 1, 0.3, 4)),
      ...Array.from({ length: 5 }, () => trade(0.02, 2, 0.3, 2, "target")),
      ...losers,
    ];
    const r = readExcursions(mixed);
    expect(r.captureP50).toBeCloseTo(0.25, 10);
    expect(r.targetWinners).toBe(5);
    const allTarget = readExcursions([...Array.from({ length: 15 }, () => trade(0.02, 2, 0.3, 2, "target")), ...losers]);
    expect(allTarget.captureP50).toBeNull();
  });

  it("refuses under 30 trades", () => {
    expect(readExcursions(winners.slice(0, 10).concat(losers.slice(0, 10))).refused).toContain("20 trades");
  });

  it("refuses a lopsided sample", () => {
    const r = readExcursions([...winners, ...winners, trade(-0.01, -1, 1, 0)]);
    expect(r.refused).toContain("1 losers");
  });

  it("refuses trades from a build without excursion data rather than reading them as zero", () => {
    const old = { ...trade(0.01, 1, 0, 0) } as Partial<Trade>;
    delete old.maeR;
    delete old.mfeR;
    const r = readExcursions([...winners, ...losers, old as Trade]);
    expect(r.refused).toContain("re-run");
  });
});
