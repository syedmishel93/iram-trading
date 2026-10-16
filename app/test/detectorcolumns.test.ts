/**
 * THE DETECTORS THE CHART DRAWS, MADE TESTABLE BY A RULE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * MEASURED before any of this was written: **24 of 29 registered detectors draw
 * on the chart and cannot be named by a rule.** Springs and upthrusts (Wyckoff),
 * volume profile levels, failed breaks and retests, breaker blocks, volume
 * climax and RSI divergence were all being DETECTED, drawn, and explained in
 * prose on the chart — and there was no way to ask whether any of them made
 * money. That is the same shape this project already records as a store with a
 * writer and no reader.
 *
 * Wiring them as COLUMNS rather than as new hand-written strategies is the
 * whole point: the chart and the backtester then call the SAME detector, so
 * they cannot disagree about what a spring is.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO WAYS A DETECTOR COLUMN LIES, both pinned below
 *
 * 1. **A CAP IS A LOOK-AHEAD LEAK.** Every detector ends `slice(-maxResults)`,
 *    which is right for a chart — the question there is what to draw. In a
 *    backtest it means whether an event at bar 200 survives depends on how many
 *    events happened AFTER it. `structural.ts` records the existing five
 *    tripping over exactly this.
 *
 * 2. **A WINDOW ANCHORED TO `len` MOVES UNDER THE BACKTEST.** `detectProfile`
 *    slices periods as `end = len - k * size`, so the boundaries shift every
 *    time the series grows — correct for "the last three sessions" on a chart,
 *    and meaningless in a backtest, where yesterday's value area has to stay
 *    yesterday's. That one cannot be fixed with an option, so the column reuses
 *    `volumeProfile` — the arithmetic, one owner — on a FIXED bar grid.
 */

import { describe, it, expect } from "vitest";
import { structuralColumns, STRUCTURAL_COLUMNS } from "../src/backtest/structural";
import type { StrategyContext } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

/** The nine columns this file exists for. */
const NEW_COLUMNS = [
  "spring",
  "climax",
  "poc",
  "vah",
  "val",
  "failbreak",
  "retest",
  "breaker",
  "divergence",
] as const;

/** Spiky, with real bodies and real volume — the detectors need all three. */
function volatile(n: number, seed = 7): BarView[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const shock = rnd() < 0.12 ? 5 : 1;
    px = Math.max(1, px * (1 + (rnd() - 0.5) * 0.02 * shock));
    const c = px;
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.min(o, c) * (1 - rnd() * 0.004);
    bars.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h, l, c, v: 1000 + rnd() * 900 });
  }
  return bars;
}

function ctxFor(bars: readonly BarView[]): StrategyContext {
  const n = bars.length;
  const col = (pick: (b: BarView) => number): Float64Array => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = pick(bars[i] as BarView);
    return a;
  };
  return {
    bars,
    open: col((b) => b.o),
    high: col((b) => b.h),
    low: col((b) => b.l),
    close: col((b) => b.c),
    volume: col((b) => b.v),
    time: col((b) => b.t),
  };
}

const BARS = volatile(900, 11);

const columnOf = (id: string, upTo: number): Float64Array => {
  const ctx = ctxFor(BARS.slice(0, upTo));
  const table = structuralColumns(ctx, new Set([id]));
  const got = (table as Record<string, Float64Array | undefined>)[id];
  if (got === undefined) throw new Error("no column built for " + id);
  return got;
};

describe("every new detector is reachable as a column", () => {
  it("IS DECLARED IN THE VOCABULARY, or a rule naming it is rejected", () => {
    for (const id of NEW_COLUMNS) {
      expect(Object.prototype.hasOwnProperty.call(STRUCTURAL_COLUMNS, id), id).toBe(true);
    }
  });

  it("IS NOT VACUOUS — each one actually fires somewhere on this series", () => {
    /* A column that is zero everywhere passes every look-ahead test ever
       written. Proving it MOVES is what stops this file reporting success
       about nothing. */
    for (const id of NEW_COLUMNS) {
      const col = columnOf(id, BARS.length);
      const nonZero = [...col].filter((v) => v !== 0 && Number.isFinite(v)).length;
      expect(nonZero, id + " is zero on all " + col.length + " bars").toBeGreaterThan(0);
    }
  });
});

describe("A COLUMN'S VALUE AT BAR i MUST NOT DEPEND ON BARS AFTER i", () => {
  /* The property the whole backtest rests on, checked on the COLUMNS rather
     than only through a spec — a column nothing references yet is a column
     nothing checks, and it will be referenced later by someone who assumes
     this was done. */
  /* EVERY structural column, not only the new ones. The five that were here
     before deserve the same question, and nothing had asked it of them at the
     column level —  checks specs, which only covers a column
     some shipped spec happens to name, at three bar indices. */
  for (const id of Object.keys(STRUCTURAL_COLUMNS)) {
    it(id + " decides identically on a truncated series", () => {
      /* SEVERAL LENGTHS, NOT TWO. The first version of this compared 700 against
         900 and passed for `spring`, `inrange` and `expansion` - and
         `rules.test.ts` then caught a real leak in `wyckoff-spring` at 261
         against 500. `detectRanges` tiles its ranges greedily BACKWARD from the
         last bar, so whether two lengths agree depends on where the tiling
         happens to land; one pair of lengths can agree by luck. A window edge
         falls between any two samples you choose, which is exactly why the
         spec-level test missed all of this to begin with. */
      const lengths = [261, 400, 555, 700, 900];
      const full = columnOf(id, 900);
      for (const upTo of lengths) {
        const part = columnOf(id, upTo);
        let diffs = 0;
        let firstAt = -1;
        for (let i = 0; i < upTo; i++) {
          const a = part[i] as number;
          const b = full[i] as number;
          const same = a === b || (Number.isNaN(a) && Number.isNaN(b));
          if (!same) {
            diffs += 1;
            if (firstAt < 0) firstAt = i;
          }
        }
        expect(
          diffs,
          id + " at len " + upTo + ": changed at " + diffs + " bars, first at " + firstAt,
        ).toBe(0);
      }
    });
  }
});

describe("the volume profile columns", () => {
  it("SIT ON A FIXED BAR GRID, not a window anchored to the last bar", () => {
    /* `detectProfile` slices `end = len - k * size`, so its periods slide as the
       series grows. Yesterday's value area has to stay yesterday's, or the
       backtest is trading a level that did not exist at the time. */
    const poc700 = columnOf("poc", 700);
    const poc900 = columnOf("poc", 900);
    for (let i = 300; i < 700; i++) {
      expect(poc900[i], "poc moved at bar " + i).toBe(poc700[i]);
    }
  });

  it("order val <= poc <= vah wherever all three are known", () => {
    const poc = columnOf("poc", 900);
    const vah = columnOf("vah", 900);
    const val = columnOf("val", 900);
    let checked = 0;
    for (let i = 0; i < 900; i++) {
      const p = poc[i] as number;
      const h = vah[i] as number;
      const l = val[i] as number;
      if (!Number.isFinite(p) || !Number.isFinite(h) || !Number.isFinite(l)) continue;
      if (p === 0 && h === 0 && l === 0) continue;
      checked += 1;
      expect(l, "bar " + i).toBeLessThanOrEqual(p);
      expect(p, "bar " + i).toBeLessThanOrEqual(h);
    }
    expect(checked, "no bar had all three — the test proved nothing").toBeGreaterThan(50);
  });

  it("ARE NOT KNOWN ON THE BARS THEY WERE BUILT FROM", () => {
    /* The first period cannot govern itself. A profile covering bars 0-95 is
       only knowable at bar 96, and a column that filled bar 0 with it would be
       handing the backtest the session's own outcome. */
    const poc = columnOf("poc", 900);
    /* NaN, NOT ZERO. A price column reading 0 makes `close > val` trivially true
       and `close crossbelow vah` fire on the bar the first level appears. NaN
       fails every comparison, which is what "not known" has to mean. */
    expect(Number.isNaN(poc[0] as number)).toBe(true);
    expect(Number.isNaN(poc[10] as number)).toBe(true);
  });
});

describe("the event columns carry a direction", () => {
  it("SPRING IS +1 AND UPTHRUST IS -1, never a bare 1 for both", () => {
    /* Wyckoff's two terminal events are mirror images, and a column that
       conflated them would make a long rule fire on a distribution top. */
    const col = columnOf("spring", 900);
    const vals = new Set([...col].filter((v) => v !== 0));
    expect(vals.size, "the column never fired, so the sign proves nothing").toBeGreaterThan(0);
    for (const v of vals) expect([1, -1]).toContain(v);
  });

  it("every event column is exactly -1, 0 or +1", () => {
    for (const id of ["spring", "climax", "failbreak", "retest", "breaker", "divergence"]) {
      const col = columnOf(id, 900);
      for (const v of col) expect([-1, 0, 1], id + " carried " + String(v)).toContain(v);
    }
  });
});
