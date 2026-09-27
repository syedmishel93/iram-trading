import { describe, expect, it } from "vitest";
import {
  PINNED_TIMEFRAMES,
  barChange,
  barRange,
  changeDirection,
  formatLastPrice,
  formatSignedPct,
  indicatorCount,
  spanCaption,
  splitTimeframes,
} from "../src/ui/shell/topbar";
import { TIMEFRAMES } from "../src/ui/shell/views";

const closes = (...c: number[]) => c.map((v) => ({ c: v }));

describe("splitTimeframes", () => {
  it("keeps the pinned five on the face in ladder order, the rest in More", () => {
    const s = splitTimeframes(TIMEFRAMES, PINNED_TIMEFRAMES, "1h");
    expect(s.visible).toEqual(["5m", "15m", "1h", "4h", "1d"]);
    expect(s.more).toEqual(["1m", "3m", "1w", "1M"]);
    expect(s.moreCurrent).toBeNull();
  });

  it("names the current timeframe when it lives in More", () => {
    expect(splitTimeframes(TIMEFRAMES, PINNED_TIMEFRAMES, "1w").moreCurrent).toBe("1w");
    expect(splitTimeframes(TIMEFRAMES, PINNED_TIMEFRAMES, "1M").moreCurrent).toBe("1M");
  });

  it("does not confuse 1m with 1M", () => {
    expect(splitTimeframes(TIMEFRAMES, PINNED_TIMEFRAMES, "1m").moreCurrent).toBe("1m");
  });
});

describe("barChange", () => {
  it("measures from the close exactly `lookback` bars before the last", () => {
    const r = barChange(closes(100, 999, 110), 2);
    expect(r).toEqual({ pct: 10, from: 100, to: 110, lookback: 2 });
  });

  it("refuses with too few bars rather than measuring a shorter span", () => {
    expect(barChange(closes(100, 110), 2)).toBeNull();
    expect(barChange([], 24)).toBeNull();
  });

  it("refuses a non-positive or non-finite reference", () => {
    expect(barChange(closes(0, 5, 10), 2)).toBeNull();
    expect(barChange(closes(Number.NaN, 5, 10), 2)).toBeNull();
  });

  it("defaults to 24 bars", () => {
    const series = closes(...Array.from({ length: 25 }, (_, i) => (i === 0 ? 200 : 100)));
    expect(barChange(series)?.pct).toBe(-50);
  });
});

describe("barRange", () => {
  it("takes the high and low of the last `lookback` bars only", () => {
    const bars = [
      { h: 500, l: 1 },
      { h: 12, l: 9 },
      { h: 15, l: 10 },
    ];
    expect(barRange(bars, 2)).toEqual({ high: 15, low: 9 });
  });

  it("refuses with fewer bars than the lookback", () => {
    expect(barRange([{ h: 1, l: 1 }], 2)).toBeNull();
  });
});

describe("formatSignedPct / changeDirection", () => {
  it("signs a rise, keeps the minus on a fall", () => {
    expect(formatSignedPct(0.1)).toBe("+0.10%");
    expect(formatSignedPct(-2.345)).toBe("-2.35%");
  });

  it("prints a figure that rounds to zero unsigned, and calls it flat", () => {
    expect(formatSignedPct(-0.001)).toBe("0.00%");
    expect(formatSignedPct(0.004)).toBe("0.00%");
    expect(changeDirection(-0.001)).toBe("flat");
  });

  it("gives the direction of the printed figure", () => {
    expect(changeDirection(0.1)).toBe("up");
    expect(changeDirection(-0.1)).toBe("down");
  });

  it("dashes a non-finite figure", () => {
    expect(formatSignedPct(Number.NaN)).toBe("—");
    expect(changeDirection(Number.POSITIVE_INFINITY)).toBe("flat");
  });
});

describe("spanCaption", () => {
  it("names the span 24 bars cover", () => {
    expect(spanCaption("1h", 24)).toBe("24h");
    expect(spanCaption("15m", 24)).toBe("6h");
    expect(spanCaption("4h", 24)).toBe("4d");
    expect(spanCaption("5m", 24)).toBe("2h");
    expect(spanCaption("3m", 24)).toBe("72m");
    expect(spanCaption("1d", 24)).toBe("24d");
    expect(spanCaption("1w", 24)).toBe("24w");
    expect(spanCaption("1M", 24)).toBe("24mo");
  });

  it("falls back to a bar count on a label it cannot read", () => {
    expect(spanCaption("tick", 24)).toBe("24 bars");
  });
});

describe("formatLastPrice", () => {
  it("uses the status bar's rule and dashes a missing bar", () => {
    expect(formatLastPrice(null)).toBe("—");
    expect(formatLastPrice(Number.NaN)).toBe("—");
    expect(formatLastPrice(81416.97).replace(/[^\d.]/g, "")).toBe("81416.97");
    expect(formatLastPrice(1.0845).replace(/[^\d.]/g, "")).toBe("1.08450");
  });
});

describe("indicatorCount", () => {
  it("counts averages, studies and panes together", () => {
    expect(indicatorCount(["ema20", "ema50"], [], [])).toBe(2);
    expect(indicatorCount(["ema20"], ["vwap"], ["rsi", "macd"])).toBe(4);
    expect(indicatorCount([], [], [])).toBe(0);
  });
});
