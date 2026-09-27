/**
 * The AI read of the chart. Every step is built from a measurement, and each
 * refuses by name when it cannot check — tested here with REAL Detection and
 * KeyLevelsResult shapes.
 */

import { describe, expect, it } from "vitest";
import { chartRead, emaLast, trendRead, DIVERGENCE_WINDOW } from "../src/scan/chartread";
import { keyLevels } from "../src/scan/keylevels";
import type { Detection, DetectionKind } from "../src/detect/types";

const fmtPx = (v: number): string => v.toFixed(2);

function det(kind: DetectionKind, direction: Detection["direction"], from: number, to: number, y: number, extra: Partial<Detection> = {}): Detection {
  return {
    id: `${kind}-${from}-${to}`,
    kind,
    label: kind,
    direction,
    from,
    to,
    confidence: 0.7,
    reason: "fixture",
    shapes: [{ type: "level", x0: from, y, tone: direction === "long" ? "bull" : "bear" }],
    ...extra,
  };
}

/** A steady climb: every EMA stacks up. */
const rising = (n: number): number[] => Array.from({ length: n }, (_, i) => 100 + i * 0.5);
const falling = (n: number): number[] => Array.from({ length: n }, (_, i) => 300 - i * 0.5);

describe("emaLast", () => {
  it("refuses a series shorter than its period", () => {
    expect(emaLast([1, 2, 3], 5)).toBeNull();
  });
  it("equals the mean when the series is exactly one period long", () => {
    expect(emaLast([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 10);
  });
});

describe("trendRead", () => {
  it("says up only when 20 > 50 > 200", () => {
    expect(trendRead(rising(260)).dir).toBe("up");
    expect(trendRead(falling(260)).dir).toBe("down");
  });
  it("names the bar count it needs rather than guessing", () => {
    const t = trendRead(rising(30));
    expect(t.dir).toBe("unknown");
    expect(t.text).toContain("50 bars");
    expect(t.text).toContain("30");
  });
  it("reads 20 vs 50 alone when there are too few bars for the 200, and says so", () => {
    const t = trendRead(rising(120));
    expect(t.dir).toBe("up");
    expect(t.text).toContain("200 needs 200 bars");
  });
});

describe("chartRead", () => {
  const closes = rising(260);
  const price = closes[closes.length - 1] as number;

  it("always returns the five steps in order", () => {
    const steps = chartRead({ closes, detections: [], levels: keyLevels([], price), rsi: 55, fmtPx });
    expect(steps.map((s) => s.key)).toEqual(["trend", "structure", "pullback", "momentum", "marked"]);
  });

  it("reports the LATEST structure break, with its level and age", () => {
    const d = [det("bos", "long", 200, 240, 210), det("bos", "long", 100, 150, 170)];
    const s = chartRead({ closes, detections: d, levels: keyLevels(d, price), rsi: 55, fmtPx })[1];
    expect(s?.text).toBe("break of structure: price broke above 210.00 19 bars ago.");
    expect(s?.tone).toBe("pos");
  });

  it("marks a break against the trend as a caution", () => {
    const d = [det("choch", "short", 230, 250, 220)];
    const s = chartRead({ closes, detections: d, levels: keyLevels(d, price), rsi: 55, fmtPx })[1];
    expect(s?.text).toContain("change of character");
    expect(s?.tone).toBe("attn");
  });

  it("finds the pullback zone on the side a pullback travels, from keyLevels", () => {
    const gap: Detection = {
      ...det("fvg", "long", 240, 245, 0),
      /* `extend: true` is how the FVG detector marks a gap still OPEN. */
      shapes: [{ type: "box", x0: 240, x1: 260, y0: 220, y1: 222, tone: "bull", extend: true }],
    };
    const levels = keyLevels([gap], price);
    const s = chartRead({ closes, detections: [gap], levels, rsi: 55, fmtPx })[2];
    expect(s?.key).toBe("pullback");
    expect(s?.text).toContain("220.00");
    expect(s?.text).toContain("buyers");
  });

  it("skips a gap that has already been filled — a used zone is not a pullback area", () => {
    const filled: Detection = {
      ...det("fvg", "long", 240, 245, 0),
      shapes: [{ type: "box", x0: 240, x1: 250, y0: 220, y1: 222, tone: "bull" }],
    };
    const s = chartRead({ closes, detections: [filled], levels: keyLevels([filled], price), rsi: 55, fmtPx })[2];
    expect(s?.text).toBe("no unused gap or order block below — no clean pullback area.");
    expect(s?.tone).toBe("attn");
  });

  it("refuses a pullback side when there is no trend", () => {
    const s = chartRead({ closes: rising(20), detections: [], levels: keyLevels([], 110), rsi: 50, fmtPx })[2];
    expect(s?.text).toContain("no clear trend");
    expect(s?.tone).toBe("mute");
  });

  it("calls a recent divergence against the trend a tiring push", () => {
    const last = closes.length - 1;
    const d = [det("divergence", "short", last - 12, last - 5, price)];
    const s = chartRead({ closes, detections: d, levels: keyLevels(d, price), rsi: 64, fmtPx })[3];
    expect(s?.text).toContain("tiring");
    expect(s?.tone).toBe("attn");
  });

  it("ignores a divergence older than the window", () => {
    const last = closes.length - 1;
    const d = [det("divergence", "short", 10, last - DIVERGENCE_WINDOW - 1, price)];
    const s = chartRead({ closes, detections: d, levels: keyLevels(d, price), rsi: 55, fmtPx })[3];
    expect(s?.text).toContain("RSI 55");
  });

  it("says RSI cannot be read instead of printing NaN", () => {
    const s = chartRead({ closes, detections: [], levels: keyLevels([], price), rsi: Number.NaN, fmtPx })[3];
    expect(s?.text).not.toContain("NaN");
    expect(s?.tone).toBe("mute");
  });

  it("counts what is marked by kind", () => {
    const d = [
      det("level", "neutral", 1, 2, 150),
      det("double-top", "short", 3, 9, 160),
      det("fvg", "long", 4, 5, 140),
      det("fvg", "long", 6, 7, 141),
    ];
    const s = chartRead({ closes, detections: d, levels: keyLevels(d, price), rsi: 55, fmtPx })[4];
    expect(s?.text).toBe("1 level, 1 pattern and 2 gaps among 4 marks.");
  });
});
