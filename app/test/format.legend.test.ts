/**
 * Legend number formatting.
 *
 * `fmtLike` exists because the change is the most-read figure on the chart and
 * the first version printed a 33-point Bitcoin move as "33.0600" — precision
 * taken from the size of the difference rather than from the scale of the thing
 * that moved. The cases below are the ones that got it wrong.
 */
import { describe, expect, it } from "vitest";
import { fmt, fmtLike } from "../src/ui/shell/format";

describe("fmtLike", () => {
  it("prints a small move on a large price at the price's precision", () => {
    // The regression: fmt(33.06) is "33.0600" because 33 is a small number.
    expect(fmt(33.06)).toBe("33.0600");
    expect(fmtLike(33.06, 78_402.94)).toBe("33.06");
  });

  it("keeps four decimals where the instrument actually has them", () => {
    // EURUSD moving 12 pips. Two decimals here would erase the move entirely.
    expect(fmtLike(0.0012, 1.0854)).toBe("0.0012");
  });

  it("keeps six where the instrument is sub-unit", () => {
    expect(fmtLike(0.00000021, 0.00004312)).toBe("0.000000");
    expect(fmtLike(0.000021, 0.00004312)).toBe("0.000021");
  });

  it("takes precision from the reference, never from the value", () => {
    // Same value, two instruments, two correct answers.
    expect(fmtLike(1.5, 90_000)).toBe("1.50");
    expect(fmtLike(1.5, 1.0854)).toBe("1.5000");
  });
});
