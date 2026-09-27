import { describe, expect, it } from "vitest";
import {
  PANES,
  PANE_FAMILY_LABEL,
  paneRange,
  paneSummary,
  panesHeight,
  fitPanes,
  PANE_MIN_H,
  runPanes,
  type PaneInput,
  type PaneSpec,
} from "../src/chart/panes";

/** A trending series with real ranges, so every indicator warms up. */
function input(n = 300, withVolume = true): PaneInput {
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  let px = 100;
  for (let i = 0; i < n; i++) {
    /* Deterministic wander with a drift, so momentum indicators do not sit
       pinned at an extreme and the fitted panes have a real range. */
    px *= 1 + Math.sin(i / 11) * 0.004 + 0.0004;
    c[i] = px;
    h[i] = px * 1.003;
    l[i] = px * 0.997;
    v[i] = withVolume ? 1000 + (i % 7) * 100 : 0;
  }
  return { h, l, c, v, colour: (_t, fallback) => fallback };
}

describe("PANES registry", () => {
  /**
   * The point of the module. `studies.ts` says these indicators "stay where
   * they are until the engine grows a pane stack" — this asserts the ones that
   * were stranded are now reachable.
   */
  it("covers the oscillators a price overlay could never draw", () => {
    const ids = PANES.map((p) => p.id);
    for (const id of ["rsi", "macd", "stoch", "adx", "atr", "mfi", "cci", "willr", "roc"]) {
      expect(ids).toContain(id);
    }
  });

  it("gives every pane a label, a blurb and a family the picker can group by", () => {
    for (const p of PANES) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(10);
      expect(PANE_FAMILY_LABEL[p.family]).toBeTruthy();
      expect(p.height).toBeGreaterThan(0);
    }
  });

  it("has unique ids, because they are persisted", () => {
    expect(new Set(PANES.map((p) => p.id)).size).toBe(PANES.length);
  });

  /** Every plotted array must be index-aligned to the series, as overlays are. */
  it("returns series the same length as the input, every one of them", () => {
    const d = input(300);
    for (const meta of PANES) {
      for (const ser of meta.build(d).series) {
        expect(ser.values.length, `${meta.id}/${ser.id}`).toBe(300);
      }
    }
  });

  /**
   * A bounded oscillator declares its range; an unbounded one must not. RSI
   * fitted to a 44–58 window looks like violent swings and is not; MACD forced
   * to a fixed range flattens to nothing in a quiet market.
   */
  it("fixes the scale for bounded oscillators and fits it for unbounded ones", () => {
    const d = input();
    const byId = new Map(PANES.map((p) => [p.id, p.build(d)]));
    expect(byId.get("rsi")?.range).toEqual([0, 100]);
    expect(byId.get("stoch")?.range).toEqual([0, 100]);
    expect(byId.get("willr")?.range).toEqual([-100, 0]);
    /* Unbounded, and in the instrument's own units. */
    expect(byId.get("macd")?.range).toBeUndefined();
    expect(byId.get("atr")?.range).toBeUndefined();
    expect(byId.get("cci")?.range).toBeUndefined();
  });

  /**
   * A histogram anchored to the pane floor and one anchored to zero are
   * different charts: MACD's negative bars must hang DOWN from zero.
   */
  it("gives every histogram an explicit zero to hang from", () => {
    const d = input();
    for (const meta of PANES) {
      const spec = meta.build(d);
      if (spec.series.some((s) => s.kind === "histogram")) {
        expect(spec.zero, meta.id).toBeDefined();
      }
    }
  });

  it("puts the levels that carry the reading on the bounded panes as guides", () => {
    const d = input();
    const byId = new Map(PANES.map((p) => [p.id, p.build(d)]));
    expect(byId.get("rsi")?.guides).toContain(30);
    expect(byId.get("rsi")?.guides).toContain(70);
    expect(byId.get("adx")?.guides).toContain(25);
    expect(byId.get("macd")?.guides).toContain(0);
  });

  it("draws ADX with its DI pair, since ADX alone has no direction", () => {
    const spec = PANES.find((p) => p.id === "adx")?.build(input());
    const ids = spec?.series.map((s) => s.id) ?? [];
    expect(ids).toContain("adx-plus");
    expect(ids).toContain("adx-minus");
    expect(ids).toContain("adx");
  });
});

describe("runPanes", () => {
  it("builds only what is enabled, in registry order", () => {
    /* Requested back to front; the registry order is what comes out, so the
       stack does not reshuffle when a pane is toggled off and on again. */
    const out = runPanes(["macd", "rsi"], input());
    expect(out.map((p) => p.id)).toEqual(["rsi", "macd"]);
  });

  /**
   * The enabled set is PERSISTED. A pane removed in a later version must not
   * brick the chart of anyone who had it switched on — the same reason
   * `runStudies` skips unknown ids.
   */
  it("skips an id it does not know rather than throwing", () => {
    expect(runPanes(["rsi", "pane-from-the-future"], input()).map((p) => p.id)).toEqual(["rsi"]);
  });

  it("builds nothing when nothing is enabled", () => {
    expect(runPanes([], input())).toEqual([]);
  });
});

describe("panesHeight", () => {
  it("sums the stack, which is what the engine takes off the price plot", () => {
    const panes = runPanes(["rsi", "macd"], input());
    expect(panesHeight(panes)).toBe(90 + 100);
    expect(panesHeight([])).toBe(0);
  });
});

describe("paneRange", () => {
  const d = input();
  const spec = (id: string): PaneSpec => PANES.find((p) => p.id === id)?.build(d) as PaneSpec;

  it("returns the declared range untouched, ignoring the data", () => {
    expect(paneRange(spec("rsi"), 100, 300)).toEqual({ lo: 0, hi: 100 });
  });

  it("fits an unbounded pane to what is actually on screen", () => {
    const r = paneRange(spec("atr"), 100, 300);
    expect(r).not.toBeNull();
    expect((r as { lo: number }).lo).toBeLessThan((r as { hi: number }).hi);
  });

  /**
   * A histogram whose baseline falls outside the fitted range is drawn from
   * outside the pane, and every bar clips to full height.
   */
  it("always includes a histogram's zero in the fitted range", () => {
    const r = paneRange(spec("macd"), 100, 300) as { lo: number; hi: number };
    expect(r.lo).toBeLessThanOrEqual(0);
    expect(r.hi).toBeGreaterThanOrEqual(0);
  });

  it("includes the guides, so a guide is never drawn off the pane", () => {
    const r = paneRange(spec("cci"), 100, 300) as { lo: number; hi: number };
    expect(r.lo).toBeLessThanOrEqual(-100);
    expect(r.hi).toBeGreaterThanOrEqual(100);
  });

  /**
   * A window entirely inside the warm-up has no finite value. Returning a
   * 0..1 window would draw a flat line at the floor that reads as a genuine
   * value of zero; null lets the engine print "warming up" instead.
   */
  it("returns null for a window with no finite value, rather than inventing one", () => {
    expect(paneRange(spec("atr"), 0, 3)).toBeNull();
  });

  it("opens a window around a genuinely flat indicator instead of dividing by zero", () => {
    const flat: PaneSpec = {
      id: "flat",
      label: "flat",
      height: 80,
      series: [{ id: "f", values: Float64Array.from([5, 5, 5, 5]), color: "#fff", kind: "line" }],
    };
    const r = paneRange(flat, 0, 4) as { lo: number; hi: number };
    expect(r.hi).toBeGreaterThan(r.lo);
    expect(r.lo).toBeLessThan(5);
    expect(r.hi).toBeGreaterThan(5);
  });
});

describe("paneSummary", () => {
  it("says plainly when the chart is price only", () => {
    expect(paneSummary([], true)).toMatch(/price only/);
  });

  it("lists what is stacked below the chart", () => {
    const line = paneSummary(["rsi", "macd"], true);
    expect(line).toContain("RSI");
    expect(line).toContain("MACD");
  });

  /**
   * Most FX feeds report no volume at all. MFI on a zero-volume feed draws a
   * flat line that looks exactly like a reading, so the gap is NAMED — the
   * same refusal `profile.ts` makes by returning null.
   */
  it("names the volume pane the feed cannot compute rather than letting it draw flat", () => {
    const line = paneSummary(["rsi", "mfi"], false);
    expect(line).toMatch(/no volume/);
    expect(line).toContain("Money flow");
  });

  it("stays quiet about volume when the feed has it", () => {
    expect(paneSummary(["mfi"], true)).not.toMatch(/no volume/);
  });

  it("ignores an unknown persisted id here too", () => {
    expect(paneSummary(["pane-from-the-future"], true)).toMatch(/price only/);
  });
});

describe("fitPanes", () => {
  const spec = (id: string, height: number): PaneSpec => ({ id, label: id, height, series: [] });

  it("leaves a stack that fits completely alone", () => {
    const r = fitPanes([spec("a", 90), spec("b", 100)], 800);
    expect(r.visible.map((p) => p.height)).toEqual([90, 100]);
    expect(r.dropped).toEqual([]);
  });

  /**
   * The failure this exists for. `Viewport.plotHeight` clamps at zero, so an
   * oversized stack does not throw — it drives the price plot to zero height
   * and draws every candle on one line. Three panes total 280px against a
   * 128px chart, which is an ordinary short window.
   */
  it("never lets the stack take more than half the chart", () => {
    const r = fitPanes([spec("a", 90), spec("b", 100), spec("c", 90)], 300);
    expect(panesHeight(r.visible)).toBeLessThanOrEqual(150);
  });

  it("scales proportionally before it drops anything", () => {
    const r = fitPanes([spec("a", 100), spec("b", 100)], 300);
    expect(r.dropped).toEqual([]);
    /* Both survive, both shrank, and they shrank by the same factor. */
    expect(r.visible).toHaveLength(2);
    expect(r.visible[0]?.height).toBe(r.visible[1]?.height);
  });

  /**
   * Half a stack you can read beats a full one you cannot: below PANE_MIN_H a
   * pane cannot fit its label and a legible line, so the stack loses panes
   * rather than shrinking past that floor.
   */
  it("drops from the bottom rather than shrinking below the readable floor", () => {
    const r = fitPanes([spec("a", 90), spec("b", 90), spec("c", 90), spec("d", 90)], 200);
    expect(r.visible.length).toBeGreaterThan(0);
    for (const p of r.visible) expect(p.height).toBeGreaterThanOrEqual(PANE_MIN_H);
    expect(r.dropped.length).toBeGreaterThan(0);
    /* Dropped from the END, so the stack does not reshuffle. */
    expect([...r.visible.map((p) => p.id), ...r.dropped]).toEqual(["a", "b", "c", "d"]);
  });

  it("drops everything rather than draw an unreadable sliver", () => {
    const r = fitPanes([spec("a", 90)], 40);
    expect(r.visible).toEqual([]);
    expect(r.dropped).toEqual(["a"]);
  });

  it("has nothing to say about an empty stack", () => {
    expect(fitPanes([], 800)).toEqual({ visible: [], dropped: [] });
  });

  it("survives a chart with no height at all, which is the pre-layout state", () => {
    expect(fitPanes([spec("a", 90)], 0).visible).toEqual([]);
  });
});

describe("paneSummary with dropped panes", () => {
  /**
   * A pane switched on and not on screen must be NAMED. Silently omitting it
   * is indistinguishable from the indicator being broken.
   */
  it("names the pane there was no room for", () => {
    const line = paneSummary(["rsi", "macd", "adx"], true, ["adx"]);
    expect(line).toMatch(/No room for/);
    expect(line).toContain("ADX");
    expect(line).toMatch(/taller/);
  });

  it("says nothing about room when everything fits", () => {
    expect(paneSummary(["rsi"], true, [])).not.toMatch(/No room/);
  });
});
