/**
 * The joint window, the split and the parameter budget.
 *
 * These three decide what a study is ABOUT — which period, which bars the
 * model was allowed to see, and how much structure the data can carry. A
 * defect in any of them is silent: the study still runs, still produces a
 * headline, and is about something other than what was asked for.
 *
 * Every expected value here is a literal or is derived by hand in the comment
 * beside it. Nothing is produced by calling the function under test.
 */

import { describe, expect, it } from "vitest";
import {
  embargoFor,
  jointWindow,
  parameterBudget,
  ROWS_PER_PARAMETER,
  spanLabel,
  splitWindow,
  YEAR_MS,
  type SeriesSpan,
} from "../src/study/window";

const DAY = 86_400_000;

function span(patch: Partial<SeriesSpan> & { symbol: string }): SeriesSpan {
  return {
    label: patch.symbol,
    role: "driver",
    bars: 10_000,
    first: 0,
    last: 0,
    gaps: [],
    coverage: 1,
    ...patch,
  };
}

describe("spanLabel", () => {
  it("names months and years, never decimals", () => {
    expect(spanLabel(YEAR_MS * 2 + (YEAR_MS / 12) * 5)).toBe("2 years 5 months");
    expect(spanLabel(YEAR_MS)).toBe("1 year");
    expect(spanLabel((YEAR_MS / 12) * 11)).toBe("11 months");
  });

  it("rolls twelve months into the next year rather than saying so", () => {
    /* 11.6 months rounds to 12, which must not print as "0 years 12 months". */
    expect(spanLabel(YEAR_MS * 0.97)).toBe("1 year");
  });

  it("falls back to days below a month", () => {
    expect(spanLabel(6 * DAY)).toBe("6 days");
    expect(spanLabel(0)).toBe("nothing");
  });
});

describe("jointWindow", () => {
  const now = 10 * YEAR_MS;
  const fiveYearsAgo = now - 5 * YEAR_MS;

  it("returns the requested window when every series covers it", () => {
    const w = jointWindow(
      span({ symbol: "BTCUSDT", first: now - 8 * YEAR_MS, last: now }),
      [span({ symbol: "XAUUSD", first: now - 9 * YEAR_MS, last: now })],
      fiveYearsAgo,
      now,
    );
    expect(w.refusal).toBeNull();
    expect(w.shortfall).toBeNull();
    expect(w.from).toBe(fiveYearsAgo);
    expect(w.limitedBy).toHaveLength(0);
  });

  it("is cut by the thinnest series and names it", () => {
    const dxyStart = now - 2.4 * YEAR_MS;
    const w = jointWindow(
      span({ symbol: "BTCUSDT", first: now - 8 * YEAR_MS, last: now }),
      [span({ symbol: "DXY", label: "Dollar index", first: dxyStart, last: now, bars: 14_880 })],
      fiveYearsAgo,
      now,
    );
    expect(w.from).toBe(dxyStart);
    expect(w.limitedBy[0]?.symbol).toBe("DXY");
    expect(w.shortfall).toContain("You asked for 5 years");
    expect(w.shortfall).toContain("Dollar index");
    expect(w.shortfall).toContain("14,880");
  });

  it("does not raise a shortfall for a few hours of vendor slack", () => {
    const w = jointWindow(
      span({ symbol: "BTCUSDT", first: fiveYearsAgo + 4 * 3_600_000, last: now }),
      [],
      fiveYearsAgo,
      now,
    );
    expect(w.shortfall).toBeNull();
  });

  it("refuses when a series loaded nothing, and says which", () => {
    const w = jointWindow(
      span({ symbol: "BTCUSDT", first: now - 8 * YEAR_MS, last: now }),
      [span({ symbol: "US10Y", label: "US 10-year yield", bars: 0 })],
      fiveYearsAgo,
      now,
    );
    expect(w.refusal).toContain("US 10-year yield");
    expect(w.from).toBe(0);
  });

  it("refuses when the spans do not overlap at all", () => {
    const w = jointWindow(
      span({ symbol: "BTCUSDT", first: now - 2 * YEAR_MS, last: now }),
      [span({ symbol: "OLD", first: now - 9 * YEAR_MS, last: now - 5 * YEAR_MS })],
      fiveYearsAgo,
      now,
    );
    expect(w.refusal).toContain("do not overlap");
  });
});

describe("splitWindow", () => {
  it("leaves two full embargoes between three segments", () => {
    /* 10,000 rows, horizon 24. Embargo 48 per boundary, 96 discarded,
       9,904 usable. 60/20/20 gives 5,942 / 1,980 / 1,982. */
    const s = splitWindow(10_000, 24);
    expect(s.embargo).toBe(48);
    expect(s.discarded).toBe(96);
    expect(s.train.bars).toBe(5_942);
    expect(s.validate.bars).toBe(1_980);
    expect(s.holdout.bars).toBe(1_982);
    expect(s.train.bars + s.validate.bars + s.holdout.bars + s.discarded).toBe(10_000);
  });

  it("puts the embargo IN the index gap, so no bar is in two segments", () => {
    const s = splitWindow(10_000, 24);
    expect(s.validate.from - s.train.to).toBe(48);
    expect(s.holdout.from - s.validate.to).toBe(48);
    expect(s.holdout.to).toBe(10_000);
  });

  it("scales the embargo with the horizon rather than fixing it", () => {
    expect(embargoFor(1)).toBe(2);
    expect(embargoFor(24)).toBe(48);
    expect(embargoFor(200)).toBe(400);
  });

  it("refuses a window too short to hold ten independent observations", () => {
    /* horizon 24 needs 240 bars per segment; 600 rows cannot give three. */
    const s = splitWindow(600, 24);
    expect(s.refusal).toContain("ten non-overlapping observations");
  });

  it("refuses outright when the embargo alone exhausts the window", () => {
    const s = splitWindow(50, 200);
    expect(s.refusal).toContain("leaves nothing behind");
    expect(s.train.bars).toBe(0);
  });
});

describe("parameterBudget", () => {
  it("divides by the horizon before dividing by the rows per parameter", () => {
    /* 12,614 / 24 = 525 independent observations; 525 / 20 = 26. */
    const b = parameterBudget(12_614, 24);
    expect(b.effectiveN).toBe(525);
    expect(b.budget).toBe(26);
  });

  it("does not treat overlapping labels as independent", () => {
    /* The bug this guards: budget computed from the row count would be
       12,614 / 20 = 630, twenty-four times too generous. */
    const b = parameterBudget(12_614, 24);
    expect(b.budget).toBeLessThan(12_614 / ROWS_PER_PARAMETER);
  });

  it("states its inputs and its assumption in the working", () => {
    const b = parameterBudget(12_614, 24);
    expect(b.working).toContain("12,614");
    expect(b.working).toContain("24-bar horizon");
    expect(b.working).toContain("20");
    expect(b.working).toContain("convention");
  });

  it("reaches zero rather than a fraction on a tiny window", () => {
    expect(parameterBudget(100, 24).budget).toBe(0);
    expect(parameterBudget(0, 24).effectiveN).toBe(0);
  });
});
