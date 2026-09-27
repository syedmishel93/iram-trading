import { describe, it, expect } from "vitest";
import { classify } from "../src/data/feed";

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = 1_760_000_000_000;

describe("freshness contract", () => {
  it("reports LIVE when the tick is recent and the vendor is current", () => {
    const s = classify(NOW - 2_000, NOW - HOUR, HOUR, "binance", NOW);
    expect(s.quality).toBe("live");
  });

  it("separates a healthy socket from current data", () => {
    // The failure this exists to prevent: a vendor streaming a perfectly alive
    // connection of 15-minute-old prices. The socket is fine; the data is not.
    const s = classify(NOW - 1_000, NOW - HOUR - 15 * MIN, HOUR, "yfinance", NOW);
    expect(s.quality).toBe("delayed");
    expect(s.note).toMatch(/behind/);
  });

  it("never labels a delayed vendor as plain live", () => {
    const s = classify(NOW - 500, NOW - HOUR - 10 * MIN, HOUR, "proxy", NOW);
    expect(s.quality).not.toBe("live");
  });

  it("does not count the expected one-bar age as vendor lag", () => {
    // The newest CLOSED bar is by definition one interval old. Counting that as
    // lag would mark every healthy feed on every timeframe as delayed.
    const s = classify(NOW - 1_000, NOW - HOUR, HOUR, "binance", NOW);
    expect(s.vendorLagMs).toBe(0);
    expect(s.quality).toBe("live");
  });

  it("goes STALE after three missed bars", () => {
    const s = classify(NOW - 4 * HOUR, NOW - HOUR, HOUR, "binance", NOW);
    expect(s.quality).toBe("stale");
    expect(s.note).toMatch(/no update/);
  });

  it("scales staleness to the timeframe, not a fixed wall-clock", () => {
    // 4 minutes is dead on a 1m chart and perfectly healthy on a 1h chart.
    const age = 4 * MIN;
    expect(classify(NOW - age, NOW - MIN, MIN, "x", NOW).quality).toBe("stale");
    expect(classify(NOW - age, NOW - HOUR, HOUR, "x", NOW).quality).toBe("live");
  });

  it("reports OFFLINE when no tick has ever arrived", () => {
    const s = classify(0, 0, HOUR, "binance", NOW);
    expect(s.quality).toBe("offline");
  });
});

