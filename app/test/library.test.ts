/**
 * What the terminal keeps current, and what must never be sized.
 *
 * What is pinned:
 *  1. THE SPINE IS ENROLLED AT BOTH TIMEFRAMES. Before this existed the whole
 *     product held ONE series, because the top-up job only ever refreshed what
 *     somebody had added by hand — and it shipped switched off.
 *  2. WATCHING A MARKET ENROLS IT. A market you are watching is one you will
 *     want history for.
 *  3. A YIELD IS NOT AN INSTRUMENT. `sizePosition` defaults `contractSize` to
 *     1, so a "position" in US10Y at 4.43 would compute a size in the
 *     thousands and report it with total confidence — the lots-versus-units
 *     defect CLAUDE.md records, in a new place.
 *  4. THE WIRE FORM ROUND-TRIPS. The server reads this list back out of one
 *     config string; a symbol carrying a separator would silently split.
 */

import { describe, expect, it } from "vitest";
import {
  BUDGET_SLOT,
  DEFAULT_BUDGET_GB,
  ENROLLED_TIMEFRAMES,
  MACRO_SPINE,
  enrolledSeries,
  enrolmentLine,
} from "../src/data/library";
import { isContextOnly } from "../src/risk/instruments";

describe("what gets enrolled", () => {
  it("keeps every spine series at every enrolled timeframe", () => {
    const rows = enrolledSeries([]);
    expect(rows).toHaveLength(MACRO_SPINE.length * ENROLLED_TIMEFRAMES.length);
    for (const tf of ENROLLED_TIMEFRAMES) {
      expect(rows.filter((r) => r.timeframe === tf)).toHaveLength(MACRO_SPINE.length);
    }
  });

  it("enrols what you are watching", () => {
    const rows = enrolledSeries(["SOLUSDT"]);
    const sol = rows.filter((r) => r.symbol === "SOLUSDT");
    expect(sol).toHaveLength(ENROLLED_TIMEFRAMES.length);
    expect(sol[0]?.source).toBe("binance");
  });

  it("does not enrol the same series twice when the watchlist repeats the spine", () => {
    const rows = enrolledSeries(["BTCUSDT", "btcusdt", " BTCUSDT "]);
    expect(rows.filter((r) => r.symbol === "BTCUSDT" && r.timeframe === "1h")).toHaveLength(1);
  });

  it("ignores blank entries rather than enrolling a nameless series", () => {
    const rows = enrolledSeries(["", "   "]);
    expect(rows).toHaveLength(MACRO_SPINE.length * ENROLLED_TIMEFRAMES.length);
  });
});

describe("what must never be traded", () => {
  /*
   * The four that explain the market rather than being one. Named individually
   * rather than derived from the spine, so adding a tradeable instrument to
   * the spine cannot quietly make this assertion vacuous.
   */
  it("marks yields and indices as context, not as instruments", () => {
    for (const sym of ["DXY", "US10Y", "US1Y", "US10YR", "HYOAS", "SPX", "NDX", "VIX", "COPPER"]) {
      expect(isContextOnly(sym), `${sym} must be context-only`).toBe(true);
    }
  });

  it("leaves real instruments tradeable", () => {
    for (const sym of ["BTCUSDT", "ETHUSDT", "XAUUSD", "EURUSD"]) {
      expect(isContextOnly(sym), `${sym} must stay tradeable`).toBe(false);
    }
  });

  /*
   * An unknown symbol is TRADEABLE. The catalogue holds thousands of venue
   * symbols the instrument table has never heard of, and refusing to size one
   * because it is absent would break every instrument not listed.
   */
  it("treats an unknown symbol as tradeable rather than refusing it", () => {
    expect(isContextOnly("WIFUSDT")).toBe(false);
  });

  it("carries the distinction onto every enrolled row", () => {
    const rows = enrolledSeries([]);
    expect(rows.find((r) => r.symbol === "US10Y")?.tradeable).toBe(false);
    expect(rows.find((r) => r.symbol === "BTCUSDT")?.tradeable).toBe(true);
  });
});

describe("the wire form", () => {
  it("round-trips through the single config string the server reads", () => {
    const rows = enrolledSeries(["SOLUSDT"]);
    const line = enrolmentLine(rows);
    const back = line.split(",").map((p) => p.split("|"));
    expect(back).toHaveLength(rows.length);
    expect(back.every((b) => b.length === 3 && b.every((x) => x.length > 0))).toBe(true);
  });

  it("never emits a field containing the separators it is joined with", () => {
    /* A symbol carrying a comma or a pipe would split into a different series
       on the way back out, silently. */
    for (const r of enrolledSeries(["SOLUSDT"])) {
      for (const field of [r.source, r.symbol, r.timeframe]) {
        expect(field).not.toContain(",");
        expect(field).not.toContain("|");
      }
    }
  });
});

describe("the disk budget", () => {
  /*
   * A NUMBER THE OPERATOR SETS, not a constant. The owner's words: "20 gb is
   * not a must or a fixed rule ... its a personal computer". The default is
   * deliberately modest, because bars for the whole spine are well under a
   * gigabyte and anything beyond that should be a deliberate choice.
   */
  it("defaults modestly and accepts a number the operator chooses", () => {
    expect(BUDGET_SLOT.fallback()).toBe(DEFAULT_BUDGET_GB);
    expect(DEFAULT_BUDGET_GB).toBeLessThanOrEqual(20);
    expect(BUDGET_SLOT.validate(20)).toBe(20);
  });

  it("refuses a budget that is not a usable size", () => {
    expect(BUDGET_SLOT.validate(0)).toBeNull();
    expect(BUDGET_SLOT.validate(-5)).toBeNull();
    expect(BUDGET_SLOT.validate("20")).toBeNull();
    expect(BUDGET_SLOT.validate(Number.NaN)).toBeNull();
  });
});
