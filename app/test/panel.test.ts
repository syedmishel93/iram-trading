/**
 * The training panel.
 *
 * Every test here is about a way the join could leak the future into the
 * features. A leak is invisible downstream — it shows up as a model that works
 * beautifully until it is traded — so it has to be caught at the join.
 */

import { describe, expect, it } from "vitest";
import { buildPanel, indexAtOrBefore, panelPayload, panelRefusal } from "../src/data/panel";
import { driversFor, driverUniverse, familyOf } from "../src/data/drivers";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

const series = (n: number, step = HOUR, from = T0, base = 100, drift = 1): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const c = base + i * drift;
    return { t: from + i * step, o: c, h: c + 1, l: c - 1, c, v: 10 };
  });

describe("indexAtOrBefore", () => {
  const bars = series(5);

  it("finds the bar at an exact timestamp", () => {
    expect(indexAtOrBefore(bars, T0 + 2 * HOUR)).toBe(2);
  });

  /* NEAREST would return 3 here. Nearest includes nearest AHEAD, which is the
     leak: bar t gets handed a price from t+1. */
  it("never returns a bar from the future", () => {
    expect(indexAtOrBefore(bars, T0 + 2 * HOUR + 59 * 60_000)).toBe(2);
  });

  it("returns -1 before the series starts", () => {
    expect(indexAtOrBefore(bars, T0 - 1)).toBe(-1);
  });

  it("returns the last bar after the series ends", () => {
    expect(indexAtOrBefore(bars, T0 + 99 * HOUR)).toBe(4);
  });
});

describe("buildPanel", () => {
  const target = series(300);
  const driver = { symbol: "DXY", label: "Dollar index", role: "context" as const, bars: series(300) };

  it("builds a row per bar after the first", () => {
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [driver] });
    expect(p.rows.length).toBe(299);
  });

  /**
   * The label looks FORWARD, so the newest `horizon` bars cannot have one.
   * Zero-filling them teaches a model that the present is always quiet.
   */
  it("leaves the unresolved tail as NaN rather than zero", () => {
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [driver], horizon: 5 });
    const tail = p.rows.slice(-5);
    expect(tail.every((r) => Number.isNaN(r.y))).toBe(true);
    expect(tail.some((r) => r.y === 0)).toBe(false);
    expect(p.labelled).toBe(p.rows.length - 5);
  });

  it("counts only resolved labels as usable", () => {
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [driver], horizon: 3 });
    expect(p.labelled).toBe(296);
  });

  /**
   * THE LEAK TEST. Truncating the series after bar k must not change any
   * feature at or before k. If it does, something after k is being read to
   * build a row at k.
   */
  it("produces bit-identical features when the series is truncated", () => {
    const k = 200;
    const full = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [driver] });
    const cut = buildPanel({
      symbol: "B",
      timeframe: "1h",
      target: target.slice(0, k + 1),
      drivers: [{ ...driver, bars: driver.bars.slice(0, k + 1) }],
    });
    for (let i = 0; i < cut.rows.length; i += 1) {
      expect(cut.rows[i]?.t, `row ${i} t`).toBe(full.rows[i]?.t);
      expect(cut.rows[i]?.r, `row ${i} r`).toBe(full.rows[i]?.r);
      expect(cut.rows[i]?.x, `row ${i} x`).toEqual(full.rows[i]?.x);
    }
  });

  /* A driver that keeps different hours is carried, and the carrying is
     counted rather than absorbed into the data. */
  it("marks a carried driver instead of pretending it was observed", () => {
    const sparse = { ...driver, bars: series(150, 2 * HOUR) };
    const p = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [sparse] });
    expect(p.columns[0]?.staleBars).toBeGreaterThan(0);
    expect(p.rows.some((r) => r.carried)).toBe(true);
  });

  /* Beyond the tolerance the row goes, rather than repeating a value forever.
     A driver frozen for 200 bars is a constant, and a constant column teaches
     a model nothing while looking like data. */
  it("drops rows where a driver is staler than the tolerance", () => {
    const gappy = { ...driver, bars: [...series(50), ...series(50, HOUR, T0 + 200 * HOUR)] };
    const p = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [gappy], maxStaleBars: 3 });
    expect(p.rows.length).toBeLessThan(299);
  });

  it("says so when a driver is missing on most rows", () => {
    const short = { ...driver, bars: series(10) };
    const p = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [short] });
    expect(p.warnings.join(" ")).toMatch(/missing on more than half/i);
  });

  it("says so when there is not enough labelled data to fit anything", () => {
    const p = buildPanel({ symbol: "B", timeframe: "1h", target: series(50), drivers: [driver] });
    expect(p.warnings.join(" ")).toMatch(/not a model/i);
  });

  it("refuses a series too short to have a horizon at all", () => {
    const p = buildPanel({ symbol: "B", timeframe: "1h", target: series(2), drivers: [driver], horizon: 5 });
    expect(p.rows).toEqual([]);
    expect(p.warnings.join(" ")).toMatch(/not enough/i);
  });

  it("says plainly when there are no drivers rather than looking complete", () => {
    const p = buildPanel({ symbol: "WHAT", timeframe: "1h", target, drivers: [] });
    expect(p.warnings.join(" ")).toMatch(/its own history and nothing else/i);
  });
});

describe("panelPayload", () => {
  const target = series(300);
  const driver = { symbol: "DXY", label: "D", role: "context" as const, bars: series(300) };

  it("ships no NaN labels and reports what it dropped", () => {
    const p = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [driver], horizon: 4 });
    const out = panelPayload(p);
    expect(out.y.every(Number.isFinite)).toBe(true);
    expect(out.x.every((row) => row.every(Number.isFinite))).toBe(true);
    expect(out.dropped).toBe(4);
    expect(out.t.length).toBe(out.y.length);
    expect(out.x.length).toBe(out.y.length);
  });

  /* The target's own return is the first feature column, so a caller reading
     `columns` must not think column 0 is a driver. */
  it("keeps the row width one wider than the driver count", () => {
    const p = buildPanel({ symbol: "B", timeframe: "1h", target, drivers: [driver] });
    const out = panelPayload(p);
    expect(out.x[0]?.length).toBe(out.columns.length + 1);
  });
});

describe("the driver map", () => {
  it("classifies the instruments the terminal actually quotes", () => {
    expect(familyOf("BTCUSDT")).toBe("crypto-major");
    expect(familyOf("SOLUSDT")).toBe("crypto-alt");
    expect(familyOf("XAUUSD")).toBe("gold");
    expect(familyOf("EURUSD")).toBe("fx-major");
    expect(familyOf("SPX500")).toBe("equity-index");
  });

  /* Guessing a family for an unknown symbol would train a model on the wrong
     four columns and report a number for it. */
  it("returns null rather than guessing", () => {
    expect(familyOf("WHATEVER123")).toBeNull();
    expect(familyOf("")).toBeNull();
  });

  /**
   * A column that IS the target predicts the target perfectly. A panel builder
   * that allows it reports an AUC near 1.0 and means nothing by it.
   */
  it("never lists an instrument as its own driver", () => {
    for (const sym of ["BTCUSDT", "ETHUSDT", "XAUUSD", "SPX500", "EURUSD", "XAGUSD"]) {
      expect(driversFor(sym).map((d) => d.symbol), sym).not.toContain(sym);
    }
  });

  it("gives every driver a stated mechanism", () => {
    for (const sym of ["BTCUSDT", "SOLUSDT", "XAUUSD", "EURUSD"]) {
      for (const d of driversFor(sym)) {
        expect(d.why.length, `${sym} to ${d.symbol}`).toBeGreaterThan(20);
      }
    }
  });

  it("keeps the universe small enough to validate", () => {
    for (const sym of ["BTCUSDT", "SOLUSDT", "XAUUSD", "EURUSD", "SPX500"]) {
      expect(driversFor(sym).length, sym).toBeLessThanOrEqual(6);
    }
  });

  it("deduplicates the storage universe across instruments", () => {
    const u = driverUniverse(["BTCUSDT", "ETHUSDT", "XAUUSD"]);
    expect(new Set(u).size).toBe(u.length);
    expect(u).toContain("DXY");
  });
});

/* ==========================================================================
   THE LIE THE DESK WAS TELLING

   The cross-asset panel reported, on a live BTCUSDT chart:

       "The panel is malformed: x and y do not describe the same rows."

   That is `crossasset.py`'s guard against a feature matrix and a label vector
   of different lengths — a real programming error. It was not what happened.
   Every declared driver had failed to load, so every row carried a NaN, so
   `panelPayload` correctly dropped all of them, and the service received two
   empty lists. `np.asarray([])` is one-dimensional, the shape check fired, and
   the operator was handed a bug report about the code when the true finding
   was ordinary and fixable.

   The far end cannot tell those apart: it can only see the arrays. So the
   panel diagnoses itself here, where the columns and the coverage still exist.
   ========================================================================== */

describe("panelRefusal", () => {
  const target = series(400);
  const good = { symbol: "DXY", label: "Dollar index", role: "context" as const, bars: series(400) };

  it("passes a panel that can actually be fitted", () => {
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [good] });
    expect(panelRefusal(p)).toBeNull();
  });

  it("names the driver that emptied the panel, and does not say malformed", () => {
    /* A driver whose bars sit entirely outside the target's window is present
       in the column list and absent on every row — exactly the shape that
       produced the false bug report. */
    const elsewhere = {
      symbol: "SPX",
      label: "S&P 500",
      role: "lead" as const,
      bars: series(50, HOUR, T0 + 5_000 * HOUR),
    };
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [elsewhere] });
    const why = panelRefusal(p);
    expect(why).not.toBeNull();
    expect(why).toContain("S&P 500");
    expect(why).toContain("SPX");
    expect(why).toContain("not malformed");
    expect(why).not.toContain("x and y");
  });

  it("says so when there are not enough bars to build a row at all", () => {
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target: series(2), drivers: [good] });
    expect(panelRefusal(p)).toContain("not enough bars");
  });

  it("refuses a sample too small for a purged walk-forward, with the number", () => {
    const short = series(120);
    const p = buildPanel({
      symbol: "BTCUSDT",
      timeframe: "1h",
      target: short,
      drivers: [{ ...good, bars: series(120) }],
    });
    const why = panelRefusal(p);
    expect(why).toContain("below the 200");
    expect(why).toContain("standard error");
  });

  it("refuses a panel with no driver columns rather than fitting a tautology", () => {
    /* One column is the instrument's own return. A model of a series on itself
       beats a coin and has learned nothing. */
    const p = buildPanel({ symbol: "BTCUSDT", timeframe: "1h", target, drivers: [] });
    expect(panelRefusal(p)).toContain("no driver columns");
  });
});
