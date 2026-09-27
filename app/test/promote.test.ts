import { describe, expect, it } from "vitest";
import {
  MAX_PBO,
  MIN_OOS_TRADES,
  MIN_RETENTION,
  promote,
  promotionLine,
} from "../src/backtest/promote";
import {
  byRegime,
  classifyRegimes,
  MIN_REGIME_TRADES,
  regimeLine,
  TREND_ADX,
  VOLATILE_PCTILE,
} from "../src/backtest/regime";
import { structuralColumns, STRUCTURAL_COLUMNS } from "../src/backtest/structural";
import { EMPTY_METRICS, type Metrics } from "../src/backtest/metrics";
import { SPECS, SPECS_BY_ID } from "../src/backtest/specs";
import { compileSpec, COLUMNS, validateSpec } from "../src/backtest/rules";
import type { BarView } from "../src/chart/series";
import type { StrategyContext, Trade } from "../src/backtest/engine";
import type { PboResult, WalkForwardFold, WalkForwardResult } from "../src/backtest/validate";

const metrics = (over: Partial<Metrics> = {}): Metrics => ({ ...EMPTY_METRICS, ...over });

const fold = (oosExpectancy: number, i = 0): WalkForwardFold => ({
  index: i,
  trainFrom: 0,
  trainTo: 100,
  testFrom: 100,
  testTo: 200,
  chosen: "x",
  inSample: metrics({ trades: 40, expectancyR: 0.5 }),
  outOfSample: metrics({ trades: 20, expectancyR: oosExpectancy }),
});

const wf = (over: Partial<WalkForwardResult> = {}): WalkForwardResult => ({
  folds: [fold(0.3, 0), fold(0.25, 1), fold(0.2, 2)],
  aggregate: metrics({ trades: 60, expectancyR: 0.25, winRate: 0.45 }),
  degradation: 0.5,
  warnings: [],
  verdict: "",
  ...over,
});

const pboOf = (v: number): PboResult => ({
  pbo: v,
  logits: [],
  splits: 8,
  oosPositiveRate: 0.6,
  interpretation: "",
});

describe("promote", () => {
  it("promotes only when every check passes", () => {
    const p = promote(wf(), pboOf(0.2));
    expect(p.promoted).toBe(true);
    expect(p.checks.every((c) => c.passed)).toBe(true);
    expect(p.summary).toMatch(/^Promoted/);
  });

  it("refuses on too small an out-of-sample sample", () => {
    const p = promote(wf({ aggregate: metrics({ trades: 12, expectancyR: 2 }) }), pboOf(0.1));
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.id === "sample")?.passed).toBe(false);
    expect(p.checks.find((c) => c.id === "sample")?.text).toContain(String(MIN_OOS_TRADES));
  });

  /**
   * The rule the whole file is.
   *
   * In-sample expectancy is what the selection maximised, so requiring it to
   * be positive tests nothing. Only the out-of-sample figure can refuse.
   */
  it("never promotes on a strong in-sample result alone", () => {
    const strongIn = wf({
      folds: [fold(-0.4, 0), fold(-0.3, 1), fold(-0.2, 2)],
      aggregate: metrics({ trades: 60, expectancyR: -0.3 }),
      degradation: -0.6,
    });
    const p = promote(strongIn, pboOf(0.1));
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.id === "expectancy")?.passed).toBe(false);
  });

  it("refuses when the edge did not survive the transition", () => {
    const p = promote(wf({ degradation: MIN_RETENTION - 0.1 }), pboOf(0.1));
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.id === "retention")?.passed).toBe(false);
  });

  /* A flattering ratio from two negatives is not retention. */
  it("does not count retention when the in-sample edge was itself negative", () => {
    const p = promote(
      wf({ aggregate: metrics({ trades: 60, expectancyR: -0.1 }), degradation: 0.9 }),
      pboOf(0.1),
    );
    expect(p.checks.find((c) => c.id === "retention")?.passed).toBe(false);
  });

  it("refuses when only one fold in three worked", () => {
    const p = promote(
      wf({ folds: [fold(0.9, 0), fold(-0.3, 1), fold(-0.2, 2)] }),
      pboOf(0.1),
    );
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.id === "folds")?.text).toMatch(/one good period is not a strategy/);
  });

  it("refuses on a PBO above the ceiling and says whose fault it is", () => {
    const p = promote(wf(), pboOf(MAX_PBO + 0.1));
    expect(p.promoted).toBe(false);
    const check = p.checks.find((c) => c.id === "pbo");
    expect(check?.passed).toBe(false);
    /* The distinction matters: a candidate can be individually sound and still
       be one the sweep had no ability to pick. */
    expect(check?.text).toMatch(/fact about the SET/);
  });

  /**
   * A check nobody ran is not a check that passed.
   *
   * Folding an absent PBO into a pass is exactly how a gate becomes
   * decoration.
   */
  it("does not promote when PBO was never computed", () => {
    const p = promote(wf());
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.id === "pbo")?.text).toMatch(/not computed/);
  });

  it("reports every reason, passing and failing", () => {
    const p = promote(wf({ aggregate: metrics({ trades: 5, expectancyR: -1 }) }), pboOf(0.9));
    expect(p.checks).toHaveLength(5);
    for (const c of p.checks) expect(c.text.length).toBeGreaterThan(10);
  });

  it("always reports out-of-sample metrics, never in-sample ones", () => {
    const p = promote(wf(), pboOf(0.2));
    expect(p.outOfSample.expectancyR).toBe(0.25);
  });
});

describe("promotionLine", () => {
  it("says plainly when nothing survived", () => {
    const none = [promote(wf({ aggregate: metrics({ trades: 3 }) }), pboOf(0.9))];
    expect(promotionLine(none)).toMatch(/^0 of 1 promoted/);
    expect(promotionLine(none)).toMatch(/ordinary result/);
  });

  it("counts the survivors when there are some", () => {
    const mixed = [promote(wf(), pboOf(0.2)), promote(wf({ degradation: 0.1 }), pboOf(0.2))];
    expect(promotionLine(mixed)).toMatch(/^1 of 2 promoted/);
  });

  it("handles an empty set", () => {
    expect(promotionLine([])).toMatch(/Nothing tested/);
  });
});

/* ------------------------------------------------------------------ regime */

function trending(n: number, step = 1): BarView[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * 3_600_000,
    o: 100 + i * step,
    h: 100.6 + i * step,
    l: 99.4 + i * step,
    c: 100 + i * step,
    v: 100,
  }));
}

function choppy(n: number): BarView[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * 3_600_000,
    o: 100 + (i % 2) * 0.2,
    h: 100.4,
    l: 99.6,
    c: 100 + (i % 2) * 0.2,
    v: 100,
  }));
}

describe("classifyRegimes", () => {
  it("returns one label per bar", () => {
    expect(classifyRegimes(trending(300))).toHaveLength(300);
  });

  it("calls a clean directional run a trend", () => {
    const r = classifyRegimes(trending(300));
    const late = r.slice(200);
    expect(late.filter((x) => x === "trend").length).toBeGreaterThan(late.length / 2);
  });

  it("calls a flat oscillation chop", () => {
    const r = classifyRegimes(choppy(300));
    const late = r.slice(200);
    expect(late.every((x) => x === "chop")).toBe(true);
  });

  /**
   * A volatility spike outranks a strong ADX, and that ordering is the point.
   *
   * A high ADX during a spike is usually one enormous candle rather than a
   * trend anyone could have ridden; filing those bars under "trend" is what
   * makes a trend strategy look better than it traded.
   */
  it("prefers 'violent' over 'trend' when the range explodes", () => {
    const bars = trending(300);
    for (let i = 280; i < 300; i++) {
      const b = bars[i] as BarView;
      (bars as BarView[])[i] = { ...b, h: b.c * 1.3, l: b.c * 0.7 };
    }
    const r = classifyRegimes(bars);
    expect(r.slice(290)).toContain("volatile");
  });

  it("survives a series too short to classify", () => {
    expect(classifyRegimes([])).toEqual([]);
    expect(classifyRegimes(trending(10))).toHaveLength(10);
  });

  it("states its thresholds rather than burying them in a branch", () => {
    expect(TREND_ADX).toBe(25);
    expect(VOLATILE_PCTILE).toBe(0.8);
  });
});

describe("byRegime", () => {
  const trade = (entryIndex: number, r: number): Trade => ({
    direction: "long",
    entryIndex,
    entryTime: 0,
    entryPrice: 100,
    exitIndex: entryIndex + 5,
    exitTime: 0,
    exitPrice: 101,
    exitReason: "target",
    rMultiple: r,
    returnPct: r * 0.01,
    reason: "",
    maeR: 0,
    mfeR: 0,
  });

  it("attributes a trade to the regime it ENTERED in", () => {
    const bars = trending(300);
    const regimes = classifyRegimes(bars);
    const at = 250;
    const slices = byRegime([trade(at, 1)], bars, regimes);
    const claimed = slices.find((s) => s.metrics.trades === 1);
    expect(claimed?.regime).toBe(regimes[at]);
  });

  it("returns a slice for every regime, even empty ones", () => {
    const slices = byRegime([], trending(300));
    expect(slices.map((s) => s.regime)).toEqual(["trend", "chop", "volatile"]);
    for (const s of slices) expect(s.metrics.trades).toBe(0);
  });

  it("reports exposure as a share of the tested bars", () => {
    const slices = byRegime([], trending(300));
    const total = slices.reduce((a, s) => a + s.exposure, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("gives each slice its own drawdown rather than the whole run's", () => {
    const bars = trending(300);
    const regimes = classifyRegimes(bars);
    const trendBar = regimes.findIndex((x) => x === "trend");
    const slices = byRegime(
      [trade(trendBar, -1), trade(trendBar + 1, -1), trade(trendBar + 2, 3)],
      bars,
      regimes,
    );
    const s = slices.find((x) => x.regime === "trend");
    expect(s?.metrics.trades).toBe(3);
    expect(s?.metrics.maxDrawdown).toBeGreaterThan(0);
  });
});

describe("regimeLine", () => {
  const slice = (regime: "trend" | "chop" | "volatile", trades: number, expectancyR: number) => ({
    regime,
    metrics: metrics({ trades, expectancyR }),
    exposure: 0.33,
  });

  it("refuses to compare regimes on a thin book", () => {
    const line = regimeLine([slice("trend", 4, 2), slice("chop", 3, -1)]);
    expect(line).toMatch(/Too few trades/);
    expect(line).toContain(String(MIN_REGIME_TRADES));
  });

  it("says so when nothing traded at all", () => {
    expect(regimeLine([slice("trend", 0, 0)])).toMatch(/No trades/);
  });

  /* Under a quarter of an R the split is not something anyone can trade on,
     and naming a "best regime" on that gap invites filtering a strategy down
     to whichever slice happened to look good. */
  it("does not manufacture a difference that is not there", () => {
    const line = regimeLine([slice("trend", 40, 0.30), slice("chop", 40, 0.22)]);
    expect(line).toMatch(/^Similar across regimes/);
  });

  it("names the gap when it is large enough to act on", () => {
    const line = regimeLine([slice("trend", 40, 0.6), slice("chop", 40, -0.3)]);
    expect(line).toMatch(/Trending/);
    expect(line).toMatch(/Chopping/);
    expect(line).toMatch(/two different strategies wearing one name/);
  });
});

/* -------------------------------------------------------------- structural */

describe("the structural columns", () => {
  const ctxFor = (bars: BarView[]): StrategyContext => ({
    bars,
    open: Float64Array.from(bars, (b) => b.o),
    high: Float64Array.from(bars, (b) => b.h),
    low: Float64Array.from(bars, (b) => b.l),
    close: Float64Array.from(bars, (b) => b.c),
    volume: Float64Array.from(bars, (b) => b.v),
    time: Float64Array.from(bars, (b) => b.t),
  });

  it("are all in the rule vocabulary, so a spec can reference them", () => {
    for (const id of Object.keys(STRUCTURAL_COLUMNS)) {
      expect(Object.prototype.hasOwnProperty.call(COLUMNS, id), id).toBe(true);
    }
  });

  it("returns arrays the same length as the series", () => {
    const bars = trending(300);
    const cols = structuralColumns(ctxFor(bars), new Set(["bos", "sweep", "infvg"]));
    for (const [id, col] of Object.entries(cols)) {
      expect(col, id).toHaveLength(300);
    }
  });

  it("builds only the columns that were asked for", () => {
    const cols = structuralColumns(ctxFor(trending(300)), new Set(["bos"]));
    expect(cols.bos).toBeDefined();
    expect(cols.sweep).toBeUndefined();
  });

  /**
   * The leak this file was written around.
   *
   * A structural event must be written at the bar it became KNOWABLE, never at
   * the bar the pattern started — and it must not depend on how many events
   * came after it. The second half is what the detectors' display caps broke:
   * `slice(-maxResults)` keeps the most recent N, so truncating the series
   * changed whether a signal at bar 200 existed at all.
   */
  it("does not change a past bar's value when later bars are added", () => {
    const full = trending(400, 1);
    for (let i = 120; i < 140; i++) {
      const b = full[i] as BarView;
      (full as BarView[])[i] = { ...b, h: b.h * 1.05, l: b.l * 0.95 };
    }
    const short = full.slice(0, 300);
    const colsFull = structuralColumns(ctxFor(full), new Set(["bos", "sweep", "expansion"]));
    const colsShort = structuralColumns(ctxFor(short), new Set(["bos", "sweep", "expansion"]));
    for (const id of ["bos", "sweep", "expansion"] as const) {
      for (let i = 0; i < 250; i++) {
        expect(
          colsShort[id]?.[i],
          `${id} at bar ${i} changed when later bars arrived`,
        ).toBe(colsFull[id]?.[i]);
      }
    }
  });
});

describe("the v49 structural specs", () => {
  const IDS = [
    "sweep-reclaim",
    "sweep-with-trend",
    "bos-continuation",
    "fvg-retest",
    "ob-retest",
    "range-expansion",
    "squeeze-release",
    "donchian-breakout",
  ];

  it("are all present and all compile", () => {
    for (const id of IDS) {
      const spec = SPECS_BY_ID.get(id);
      expect(spec, id).toBeDefined();
      expect(validateSpec(spec!), id).toEqual([]);
      expect(() => compileSpec(spec!)).not.toThrow();
    }
  });

  it("brought the set to twenty-five, which is the number the PBO warning is about", () => {
    expect(SPECS).toHaveLength(25);
  });

  it("each carry a note that says what to distrust", () => {
    for (const id of IDS) {
      expect(SPECS_BY_ID.get(id)?.note?.length ?? 0, id).toBeGreaterThan(40);
    }
  });
});
