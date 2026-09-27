import { describe, it, expect } from "vitest";
import { nextTickTone } from "../src/ui/livebar";

describe("nextTickTone", () => {
  it("reads an uptick as up and a downtick as down, in the CANDLE colours, not the P&L ones", () => {
    expect(nextTickTone(100, 100.5, undefined)).toBe("up");
    expect(nextTickTone(100, 99.5, "up")).toBe("down");
  });

  it("holds the last direction on an unchanged print rather than blinking to neutral", () => {
    expect(nextTickTone(100, 100, "down")).toBe("down");
    expect(nextTickTone(100, 100, undefined)).toBeUndefined();
  });

  it("says nothing before there is a previous print to compare with", () => {
    expect(nextTickTone(null, 100, undefined)).toBeUndefined();
  });

  it("ignores a non-finite print", () => {
    expect(nextTickTone(100, Number.NaN, "up")).toBe("up");
  });
});
