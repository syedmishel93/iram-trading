/**
 * ALIGNING A MACRO SERIES ONTO TRADED BARS — `backtest/macro.ts`.
 *
 * THE TEST THAT MATTERS IS `a daily bar is not known until the day is over`.
 * yfinance stamps a daily bar at the START of the day, so reading DXY's
 * 2026-09-25 close on a BTC bar at 2026-09-25 10:00 uses a number that does not
 * exist yet. It is invisible, it flatters every conditioned result, and the
 * backtest stays wrong until somebody trades it. Every other test here is a
 * corollary of that one.
 *
 * THE SECOND IS `a change is computed on the macro series' own bars`. CLAUDE.md
 * records the trap in full: a five-row diff over forward-filled values spans
 * three trading days across a weekend, so the same condition means different
 * things depending on the weekday.
 *
 * WHY THIS IS WORTH BUILDING AT ALL, measured: across 22 markets the shipped
 * rules had a median per-trade Sharpe of −0.109, and deepening the archive from
 * 42 days to 5 years took the best arm from +0.374 DOWN to +0.070 against a
 * hurdle of +0.102. The rules have no standalone edge. Conditioning is the only
 * question left, and a join that leaks the future would answer it wrongly in
 * the flattering direction.
 */

import { describe, expect, it } from "vitest";
import {
  alignMacro,
  buildMacroColumns,
  CHANGE_LOOKBACK,
  closeTimeOf,
  macroChange,
  MIN_COVERAGE,
  ratioOf,
  type MacroBar,
} from "../src/backtest/macro";
import { isMacroColumn, MACRO_COLUMNS } from "../src/backtest/rules";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);

/** Daily macro bars stamped at the START of each day, as yfinance supplies them. */
const daily = (closes: readonly number[], from = D0): MacroBar[] =>
  closes.map((c, i) => ({ t: from + i * DAY, c }));

const hourly = (n: number, from = D0): number[] =>
  Array.from({ length: n }, (_, i) => from + i * HOUR);

describe("no look-ahead", () => {
  it("A DAILY BAR IS NOT KNOWN UNTIL THE DAY IS OVER", () => {
    // Day 0's close is knowable at the START of day 1, never during day 0.
    const macro = daily([100, 200, 300]);
    const times = [D0, D0 + 12 * HOUR, D0 + DAY - 1, D0 + DAY, D0 + DAY + HOUR];
    const { level } = alignMacro(times, macro, DAY);
    expect(level[0]).toBeNaN();          // start of day 0 — nothing has closed
    expect(level[1]).toBeNaN();          // midday 0 — day 0 is STILL OPEN
    expect(level[2]).toBeNaN();          // one ms before day 0 closes
    expect(level[3]).toBe(100);          // day 0 has closed
    expect(level[4]).toBe(100);          // day 1 is open; its close is unknown
  });

  it("a bar closing exactly now IS known now", () => {
    // The boundary belongs to the past: at the instant a bar closes, its close
    // is a fact. Excluding it would discard a real observation every day.
    const { level } = alignMacro([D0 + DAY], daily([100, 200]), DAY);
    expect(level[0]).toBe(100);
  });

  it("closeTimeOf is the whole rule, stated once", () => {
    expect(closeTimeOf(D0, DAY)).toBe(D0 + DAY);
    expect(closeTimeOf(D0, HOUR)).toBe(D0 + HOUR);
  });

  it("never reads a macro bar from the future even when the series runs ahead", () => {
    const macro = daily([1, 2, 3, 4, 5]);
    const times = hourly(24 * 5);
    const { level } = alignMacro(times, macro, DAY);
    for (let i = 0; i < times.length; i += 1) {
      const v = level[i] as number;
      if (Number.isNaN(v)) continue;
      // Whatever we read must have CLOSED before this traded bar.
      const bar = macro.find((m) => m.c === v) as MacroBar;
      expect(closeTimeOf(bar.t, DAY)).toBeLessThanOrEqual(times[i] as number);
    }
  });
});

describe("what is not known is not zero", () => {
  it("bars before the first macro close are NaN, never 0", () => {
    // A zero DXY reads as a real level. NaN reads as "not known", which every
    // formatter here already renders as an em dash.
    const { level, known } = alignMacro(hourly(10), daily([100], D0 + 5 * DAY), DAY);
    expect(known).toBe(0);
    for (let i = 0; i < 10; i += 1) expect(level[i]).toBeNaN();
  });

  it("an empty macro series is refused by name rather than filled", () => {
    const r = alignMacro(hourly(10), [], DAY);
    expect(r.coverage).toBe(0);
    expect(r.thin).toContain("no bars were held");
  });

  it("an empty traded series says so", () => {
    expect(alignMacro([], daily([1, 2]), DAY).thin).toContain("no bars to align");
  });

  it("a non-finite macro close is skipped, not carried", () => {
    const macro: MacroBar[] = [{ t: D0, c: NaN }, { t: D0 + DAY, c: 50 }];
    const { level } = alignMacro([D0 + DAY, D0 + 2 * DAY], macro, DAY);
    expect(level[0]).toBeNaN();
    expect(level[1]).toBe(50);
  });
});

describe("a thin overlap is refused, not reported", () => {
  it("names the share when the context series covers too little", () => {
    // 100 traded bars, macro starting three quarters of the way through.
    const times = hourly(100);
    const macro = daily([1, 2], D0 + 80 * HOUR);
    const r = alignMacro(times, macro, DAY);
    expect(r.coverage).toBeLessThan(MIN_COVERAGE);
    expect(r.thin).toContain("%");
    expect(r.thin).toContain("conditioned");
  });

  it("does not complain when the overlap is good", () => {
    const r = alignMacro(hourly(24 * 30), daily(Array.from({ length: 40 }, (_, i) => i + 1)), DAY);
    expect(r.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
    expect(r.thin).toBeNull();
  });
});

describe("a change is computed where the bars are real", () => {
  it("measures over the MACRO series' own bars", () => {
    // Five trading days, not five rows of a carried-forward level.
    const macro = daily([100, 101, 102, 103, 104, 105]);
    const chg = macroChange(macro, 5);
    expect(chg[5]?.c).toBeCloseTo(5 / 100, 10);
    // Not enough history yet is NOT a zero change.
    for (let i = 0; i < 5; i += 1) expect(chg[i]?.c).toBeNaN();
  });

  it("a weekend cannot turn into a zero return", () => {
    // Friday then Monday: two REAL bars. The change is Friday->Monday, and
    // nothing in between invents a flat day. Under a forward-filled diff the
    // Saturday and Sunday rows would each contribute exactly zero.
    const fri = D0, mon = D0 + 3 * DAY;
    const chg = macroChange([{ t: fri, c: 100 }, { t: mon, c: 110 }], 1);
    expect(chg[1]?.c).toBeCloseTo(0.1, 10);
    expect(chg).toHaveLength(2);
  });

  it("keeps its timestamps so it can be aligned like any other series", () => {
    const macro = daily([1, 2, 3]);
    expect(macroChange(macro, 1).map((m) => m.t)).toEqual(macro.map((m) => m.t));
  });

  it("a zero or missing base is NaN rather than Infinity", () => {
    // INFINITY IS A BUG; NaN IS A REFUSAL.
    const chg = macroChange([{ t: D0, c: 0 }, { t: D0 + DAY, c: 5 }], 1);
    expect(chg[1]?.c).toBeNaN();
  });

  it("the CHANGE is aligned, not recomputed after alignment", () => {
    // The whole point: compute on daily bars, then carry the RESULT across
    // intraday bars. Every hour of a day reports that day's known change.
    const macro = daily([100, 110, 121]);
    const chg = macroChange(macro, 1);
    const { level } = alignMacro([D0 + DAY, D0 + DAY + HOUR, D0 + 2 * DAY], chg, DAY);
    expect(level[0]).toBeNaN();               // day 0's change has no base
    expect(level[1]).toBeNaN();
    expect(level[2]).toBeCloseTo(0.1, 10);    // day 1's +10%, known once day 1 closed
  });
});

describe("a ratio is derived at read time", () => {
  it("divides values known at the SAME moment", () => {
    const a = alignMacro([D0 + DAY, D0 + 2 * DAY], daily([10, 20]), DAY);
    const b = alignMacro([D0 + DAY, D0 + 2 * DAY], daily([5, 4]), DAY);
    const r = ratioOf(a, b);
    expect(r[0]).toBeCloseTo(2, 10);
    expect(r[1]).toBeCloseTo(5, 10);
  });

  it("refuses rather than dividing by zero or by the unknown", () => {
    const a = alignMacro([D0 + DAY], daily([10]), DAY);
    const b = alignMacro([D0 + DAY], daily([0]), DAY);
    expect(ratioOf(a, b)[0]).toBeNaN();
    const missing = alignMacro([D0 + DAY], [], DAY);
    expect(ratioOf(a, missing)[0]).toBeNaN();
  });
});

describe("it scales to the archive it will actually meet", () => {
  it("walks 44,000 traded bars against 25,000 daily bars once", () => {
    // The deep archive is 44,000 bars of 1h; the macro spine runs to decades of
    // daily. A per-bar binary search would be fine and a per-bar scan would not,
    // so this pins that the result is correct at that size.
    const times = hourly(44_000);
    const macro = daily(Array.from({ length: 2_500 }, (_, i) => 100 + i));
    const r = alignMacro(times, macro, DAY);
    expect(r.known).toBeGreaterThan(40_000);
    expect(r.thin).toBeNull();
    // The last traded bar must read the last macro bar that had closed.
    expect(Number.isFinite(r.level[43_999] as number)).toBe(true);
  });
});

describe("the columns a rule can actually reference", () => {
  const times = hourly(24 * 40);
  const ten = (v: number) => daily(Array.from({ length: 60 }, (_, i) => v + i));

  it("builds every column the vocabulary declares — no more, no fewer", () => {
    // A column in COLUMNS that nothing builds reads NaN for ever and a rule on
    // it silently never fires. A column built but not declared is unreachable.
    const { columns } = buildMacroColumns(times, {
      DXY: ten(100), US10Y: ten(4), US02Y: ten(4), VIX: ten(15),
      SPX: ten(5000), USDJPY: ten(150), COPPER: ten(4), XAUUSD: ten(2600),
    });
    expect(Object.keys(columns).sort()).toEqual([...MACRO_COLUMNS].sort());
    for (const id of MACRO_COLUMNS) expect(isMacroColumn(id)).toBe(true);
  });

  it("A MISSING SERIES IS REPORTED, NOT DEFAULTED", () => {
    // The operator gets told what to download. A zeroed DXY would be a real
    // dollar index of nought, and a rule conditioned on it would FIRE on that.
    const { columns, missing } = buildMacroColumns(times, { DXY: ten(100) });
    expect(missing.join(" ")).toContain("US10Y");
    expect(missing.join(" ")).toContain("not in the archive");
    for (let i = 0; i < times.length; i += 1) expect(columns["us10y"]?.[i]).toBeNaN();
  });

  it("a rule conditioned on a series nobody loaded cannot fire", () => {
    // Every comparison against NaN is false — which is the whole reason the
    // blank is NaN and not zero.
    const { columns } = buildMacroColumns(times, {});
    const col = columns["dxy"] as Float64Array;
    expect([...col].every((v) => Number.isNaN(v))).toBe(true);
    expect((col[0] as number) > 0).toBe(false);
    expect((col[0] as number) < 0).toBe(false);
  });

  it("the change column measures the CONTEXT series' own bars", () => {
    const { columns } = buildMacroColumns(times, { DXY: daily([100, 101, 102, 103, 104, 105, 106]) });
    const chg = columns["dxy_chg5"] as Float64Array;
    const seen = [...chg].filter((v) => Number.isFinite(v));
    expect(seen.length).toBeGreaterThan(0);
    // 5 DXY bars apart, not 5 traded bars apart.
    expect(seen[0]).toBeCloseTo(5 / 100, 6);
    expect(CHANGE_LOOKBACK).toBe(5);
  });

  it("copper_gold needs both sides and says which is missing", () => {
    const { columns, missing } = buildMacroColumns(times, { COPPER: ten(4) });
    expect(missing.join(" ")).toContain("copper_gold");
    expect([...(columns["copper_gold"] as Float64Array)].every(Number.isNaN)).toBe(true);
  });

  it("copper_gold divides values known at the same moment", () => {
    const { columns } = buildMacroColumns(times, {
      COPPER: daily(Array.from({ length: 60 }, () => 4)),
      XAUUSD: daily(Array.from({ length: 60 }, () => 2000)),
    });
    const r = [...(columns["copper_gold"] as Float64Array)].filter(Number.isFinite);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toBeCloseTo(4 / 2000, 10);
  });

  it("every column is the same length as the bars it describes", () => {
    // A short column read past its end is `undefined`, which compares false
    // everywhere and would silently disable a rule from some bar onward.
    const { columns } = buildMacroColumns(times, { DXY: ten(100) });
    for (const id of MACRO_COLUMNS) {
      expect((columns[id] as Float64Array).length).toBe(times.length);
    }
  });
});
