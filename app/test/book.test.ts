/**
 * Reconciling the broker's book with the hand-entered one.
 *
 * TWO RULES HERE CAN COST REAL MONEY IF THEY BREAK, and neither is visible on
 * screen when it does:
 *
 *   A position whose contract size is unknown must NOT be counted. MT5 reports
 *   volume in lots; counting a lot as a unit understates the risk by the
 *   contract size, which for standard FX is 100,000. The desk would show a
 *   near-flat book on a fully loaded account.
 *
 *   A stop of ZERO means NO STOP. Treating it as a price makes the stop
 *   distance the entire entry price, and the position reports as risking its
 *   whole notional — or, with the sign the other way, as perfectly protected.
 *
 * Every expected value below is a literal or derived by hand in the comment
 * beside it. Nothing is produced by calling the code under test.
 */

import { describe, expect, it } from "vitest";
import { reconcile, symbolsNeedingContract, type ManualPosition } from "../src/trade/book";
import type { BrokerPosition, BrokerResult } from "../src/data/broker";
import { portfolioHeat } from "../src/risk/sizing";

function pos(patch: Partial<BrokerPosition> & { symbol: string }): BrokerPosition {
  return {
    ticket: 1,
    type: 0,
    volume: 1,
    price_open: 1.1,
    sl: 1.098,
    tp: 0,
    profit: 12.5,
    swap: -0.3,
    time_ms: 1_700_000_000_000,
    ...patch,
  };
}

const ok = (ps: readonly BrokerPosition[]): BrokerResult<readonly BrokerPosition[]> => ({
  state: "ok",
  value: ps,
});

const FX = new Map([["EURUSD", 100_000]]);

describe("reconcile — not connected", () => {
  it("counts every hand-entered row, because nothing contradicts them", () => {
    const manual: ManualPosition[] = [
      { symbol: "BTCUSDT", direction: "long", qty: 0.5, entry: 60_000, stop: 58_000 },
    ];
    const b = reconcile({
      broker: { state: "unavailable", reason: "MetaTrader5 package is Windows-only" },
      manual,
      contracts: new Map(),
    });
    expect(b.connected).toBe(false);
    expect(b.source).toBe("manual");
    expect(b.counted).toHaveLength(1);
    expect(b.entries[0]?.kind).toBe("manual");
  });

  it("does not claim you are flat when it simply does not know", () => {
    const b = reconcile({
      broker: { state: "disconnected", reason: "MT5 is not running" },
      manual: [],
      contracts: new Map(),
    });
    expect(b.counted).toHaveLength(0);
    expect(b.notes[0]).toContain("not a statement that you are flat");
  });
});

describe("reconcile — connected", () => {
  const manualEur: ManualPosition = {
    symbol: "EURUSD",
    direction: "long",
    qty: 1,
    entry: 1.1,
    stop: 1.09,
  };

  it("lets the broker own a row the operator also typed in", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [manualEur], contracts: FX });
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]?.kind).toBe("broker");
    /* The broker's stop, not the hand-typed 1.09. */
    expect(b.entries[0]?.position.stop).toBe(1.098);
    expect(b.notes.some((n) => n.includes("not deleted"))).toBe(true);
  });

  it("matches on symbol and direction only, so a part-close does not duplicate", () => {
    /* Broker holds 0.4 lots after a part-close; the operator's row still says 1. */
    const b = reconcile({
      broker: ok([pos({ symbol: "EURUSD", volume: 0.4 })]),
      manual: [manualEur],
      contracts: FX,
    });
    expect(b.entries).toHaveLength(1);
    expect(b.counted).toHaveLength(1);
  });

  it("does NOT match the opposite direction — that is a second position", () => {
    const short: ManualPosition = { ...manualEur, direction: "short" };
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD", type: 0 })]), manual: [short], contracts: FX });
    expect(b.entries).toHaveLength(2);
    expect(b.entries[1]?.kind).toBe("unmatched");
  });

  it("refuses to count a row the broker does not report", () => {
    const stale: ManualPosition = { symbol: "GBPUSD", direction: "long", qty: 1, entry: 1.27, stop: 1.26 };
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [stale], contracts: FX });
    expect(b.entries.find((e) => e.position.symbol === "GBPUSD")?.kind).toBe("unmatched");
    expect(b.counted.map((p) => p.symbol)).toEqual(["EURUSD"]);
    expect(b.notes.some((n) => n.includes("NOT counted"))).toBe(true);
  });

  it("counts it once the operator says it is at another venue", () => {
    const elsewhere: ManualPosition = {
      symbol: "GBPUSD",
      direction: "long",
      qty: 1,
      entry: 1.27,
      stop: 1.26,
      external: true,
    };
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [elsewhere], contracts: FX });
    expect(b.entries.find((e) => e.position.symbol === "GBPUSD")?.kind).toBe("manual");
    expect(b.counted).toHaveLength(2);
  });

  it("reports an empty broker book as a real answer", () => {
    const b = reconcile({ broker: ok([]), manual: [], contracts: FX });
    expect(b.counted).toHaveLength(0);
    expect(b.notes[0]).toContain("real answer, not a missing one");
  });
});

describe("lots are not units", () => {
  it("excludes a position whose contract size is unknown", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [], contracts: new Map() });
    expect(b.entries[0]?.unsized).not.toBeNull();
    expect(b.counted).toHaveLength(0);
    expect(b.refusal).toContain("100,000");
    expect(b.refusal).toContain("FLOOR");
  });

  it("carries the contract size through when it is known", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [], contracts: FX });
    expect(b.entries[0]?.unsized).toBeNull();
    expect(b.entries[0]?.position.contractSize).toBe(100_000);
    expect(b.refusal).toBeNull();
  });

  it("is the difference between $200 of risk and two tenths of a cent", () => {
    /* One lot of EURUSD, entry 1.1000, stop 1.0980. Twenty pips.
       Correct:   0.0020 * 1 * 100,000 = $200.
       Defaulted: 0.0020 * 1 *       1 = $0.002. */
    const sized = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [], contracts: FX });
    const heat = portfolioHeat(sized.counted, 10_000);
    expect(heat.openRisk).toBeCloseTo(200, 6);
    expect(heat.heatPct).toBeCloseTo(2, 6);

    const unsized = reconcile({ broker: ok([pos({ symbol: "EURUSD" })]), manual: [], contracts: new Map() });
    /* Excluded rather than counted at 1x — the whole point. */
    expect(portfolioHeat(unsized.counted, 10_000).openRisk).toBe(0);
  });
});

describe("a stop of zero is no stop", () => {
  it("becomes null, not a price", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD", sl: 0 })]), manual: [], contracts: FX });
    expect(b.entries[0]?.position.stop).toBeNull();
  });

  it("reports the position as unprotected rather than as risking its notional", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD", sl: 0 })]), manual: [], contracts: FX });
    const heat = portfolioHeat(b.counted, 10_000);
    expect(heat.unprotected).toEqual(["EURUSD"]);
    /* Had 0 been treated as a price, the stop distance would be the whole
       entry: 1.1 * 1 * 100,000 = $110,000 on a $10,000 account. */
    expect(heat.openRisk).toBe(0);
  });
});

describe("short positions", () => {
  it("reads MT5 type 1 as short", () => {
    const b = reconcile({
      broker: ok([pos({ symbol: "EURUSD", type: 1, price_open: 1.1, sl: 1.102 })]),
      manual: [],
      contracts: FX,
    });
    expect(b.entries[0]?.position.direction).toBe("short");
    /* Stop ABOVE entry on a short is real risk: 0.002 * 100,000 = $200. */
    expect(portfolioHeat(b.counted, 10_000).openRisk).toBeCloseTo(200, 6);
  });
});

describe("open P&L", () => {
  it("is null for a hand-entered row rather than zero", () => {
    const b = reconcile({
      broker: { state: "disconnected", reason: "off" },
      manual: [{ symbol: "BTCUSDT", direction: "long", qty: 1, entry: 60_000, stop: 59_000 }],
      contracts: new Map(),
    });
    expect(b.entries[0]?.profit).toBeNull();
  });

  it("carries the broker's figure when there is one", () => {
    const b = reconcile({ broker: ok([pos({ symbol: "EURUSD", profit: -41.2 })]), manual: [], contracts: FX });
    expect(b.entries[0]?.profit).toBe(-41.2);
  });
});

describe("symbolsNeedingContract", () => {
  it("is the distinct set, sorted", () => {
    expect(
      symbolsNeedingContract([
        pos({ symbol: "EURUSD" }),
        pos({ symbol: "XAUUSD" }),
        pos({ symbol: "EURUSD", ticket: 2 }),
      ]),
    ).toEqual(["EURUSD", "XAUUSD"]);
  });
});
