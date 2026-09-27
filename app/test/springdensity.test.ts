/**
 * HOW OFTEN THE STRUCTURAL EVENT COLUMNS ACTUALLY FIRE.
 *
 * MEASURED on the live desk the moment the rules were wired up: "Wyckoff spring"
 * took **10,479 trades over 41,536 BTCUSDT 1h bars**, which is a spring every
 * four bars and holds a position three quarters of the time. Wyckoff's spring is
 * a terminal shakeout in a formed accumulation range — a handful a year, not one
 * a shift — so a rule firing that often is testing something else and wearing
 * the name.
 *
 * THE RESULT WAS NOT WRONG. −0.09R over 10,479 trades, and −0.08R in the
 * held-back 30%, is a real measurement of the rule as written and the two
 * windows agreeing is the strongest part of it. But reporting that as "Wyckoff
 * does not work" would be a claim about a method, made from a rule that fires a
 * thousand times more often than the method describes.
 *
 * So the density is a FACT ABOUT THE COLUMN and it gets pinned here rather than
 * discovered again from a trade count. If a detector is loosened later, this is
 * what fails.
 */

import { describe, expect, it } from "vitest";
import { structuralColumns } from "../src/backtest/structural";
import type { StrategyContext } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

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

const N = 2000;
const BARS = volatile(N, 5);

const density = (id: string): number => {
  const table = structuralColumns(ctxFor(BARS), new Set([id]));
  const col = (table as Record<string, Float64Array | undefined>)[id];
  if (col === undefined) throw new Error("no column for " + id);
  let fired = 0;
  for (const v of col) if (v !== 0 && Number.isFinite(v)) fired += 1;
  return fired / N;
};

describe("a structural event is an EVENT, not a state in disguise", () => {
  /* The share of bars each one marks. A column firing on a tenth of all bars is
     not describing a rare structure, whatever it is called — and every rule
     built on it inherits that, silently, as a trade count nobody questions. */
  const LIMITS: ReadonlyArray<readonly [string, number]> = [
    ["spring", 0.2],
    ["climax", 0.1],
    ["failbreak", 0.2],
    ["retest", 0.2],
    ["breaker", 0.2],
    ["divergence", 0.2],
    ["sweep", 0.2],
    ["bos", 0.2],
    ["choch", 0.2],
  ];

  for (const [id, cap] of LIMITS) {
    it(id + " marks a minority of bars, and is not silent", () => {
      const d = density(id);
      /* BOTH ENDS. A zero passes any upper bound ever written, which is how a
         checker whose pattern stopped matching reports a clean tree. */
      expect(d, id + " never fired — the check proves nothing").toBeGreaterThan(0);
      expect(d, id + " fired on " + (d * 100).toFixed(1) + "% of bars").toBeLessThan(cap);
    });
  }
});
