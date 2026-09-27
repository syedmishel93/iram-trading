import { describe, expect, it } from "vitest";
import {
  anchoredVwap,
  chandelier,
  donchian,
  ichimoku,
  keltner,
  relativeStrength,
  squeeze,
} from "../src/chart/indicators";
import { DEFAULT_BINS, profileNodes, volumeProfile } from "../src/chart/profile";
import { runStudies, STUDIES, studyColumns } from "../src/chart/studies";
import { ANCHORED_STUDIES, studySummary } from "../src/ui/studypanel";
import type { BarView } from "../src/chart/series";

/** A deterministic series: a sine wave with a linear drift, plus volume. */
function series(n: number, opts: { amp?: number; drift?: number; vol?: number } = {}): BarView[] {
  const { amp = 5, drift = 0.1, vol = 100 } = opts;
  const out: BarView[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 100 + drift * i + amp * Math.sin(i / 6);
    out.push({
      t: 1_700_000_000_000 + i * 3_600_000,
      o: mid - 0.2,
      h: mid + 1,
      l: mid - 1,
      c: mid,
      v: vol,
    });
  }
  return out;
}

const cols = (bars: readonly BarView[]) => {
  const c = studyColumns(bars);
  return { h: c.h, l: c.l, c: c.c, v: c.v, t: c.t };
};

/** Every warm-up value must be NaN, and every value after it finite. */
function warmup(values: Float64Array, firstValid: number): void {
  for (let i = 0; i < firstValid; i++) {
    expect(Number.isNaN(values[i] as number), `index ${i} should be NaN`).toBe(true);
  }
  expect(Number.isFinite(values[firstValid] as number), `index ${firstValid}`).toBe(true);
}

describe("the module contract every indicator obeys", () => {
  const bars = series(200);
  const d = cols(bars);

  it("returns arrays the same length as the input", () => {
    expect(keltner(d.h, d.l, d.c).upper).toHaveLength(200);
    expect(donchian(d.h, d.l).upper).toHaveLength(200);
    expect(ichimoku(d.h, d.l, d.c).spanA).toHaveLength(200);
    expect(chandelier(d.h, d.l, d.c).long).toHaveLength(200);
    expect(squeeze(d.h, d.l, d.c)).toHaveLength(200);
    expect(anchoredVwap(d.h, d.l, d.c, d.v, 50)).toHaveLength(200);
  });

  it("uses NaN and not zero for the warm-up", () => {
    warmup(keltner(d.h, d.l, d.c, 20).upper, 19);
    warmup(donchian(d.h, d.l, 20).upper, 19);
  });
});

describe("keltner", () => {
  const bars = series(200);
  const d = cols(bars);

  it("brackets the middle line on both sides", () => {
    const k = keltner(d.h, d.l, d.c);
    for (let i = 30; i < 200; i++) {
      expect(k.upper[i] as number).toBeGreaterThan(k.middle[i] as number);
      expect(k.lower[i] as number).toBeLessThan(k.middle[i] as number);
    }
  });

  it("widens with the multiplier", () => {
    const narrow = keltner(d.h, d.l, d.c, 20, 1);
    const wide = keltner(d.h, d.l, d.c, 20, 3);
    const i = 150;
    expect((wide.upper[i] as number) - (wide.lower[i] as number)).toBeGreaterThan(
      (narrow.upper[i] as number) - (narrow.lower[i] as number),
    );
  });
});

describe("squeeze", () => {
  it("is 1 only while Bollinger sits inside Keltner", () => {
    /* A dead-flat series has zero standard deviation and a non-zero true range
       from the fixed high-low, so Bollinger collapses inside Keltner and the
       squeeze must fire on every settled bar. */
    const flat: BarView[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 10,
    }));
    const d = cols(flat);
    const sq = squeeze(d.h, d.l, d.c);
    expect(sq[80]).toBe(1);
  });

  /**
   * MEASURED, after a wrong first guess.
   *
   * My first attempt alternated close between 99 and 101 inside a 99–101 bar,
   * expecting that to blow Bollinger past Keltner. It does not, and the reason
   * is instructive: true range counts the GAP to the previous close, so
   * jittering the close raises ATR just as fast as it raises the standard
   * deviation, and the squeeze stays on. What actually releases a squeeze is a
   * TREND — closes travelling steadily in one direction, where the deviation
   * grows with the distance covered while the bar-to-bar true range does not.
   */
  it("releases when price starts trending, not merely jittering", () => {
    const jitter: BarView[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100,
      h: 101,
      l: 99,
      c: i % 2 === 0 ? 99 : 101,
      v: 10,
    }));
    expect(squeeze(cols(jitter).h, cols(jitter).l, cols(jitter).c)[80]).toBe(1);

    const trend: BarView[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100 + i,
      h: 100.05 + i,
      l: 99.95 + i,
      c: 100 + i,
      v: 10,
    }));
    expect(squeeze(cols(trend).h, cols(trend).l, cols(trend).c)[80]).toBe(0);
  });
});

describe("donchian", () => {
  const bars = series(100);
  const d = cols(bars);

  it("puts the middle exactly halfway between the bands", () => {
    const c = donchian(d.h, d.l, 20);
    for (let i = 25; i < 100; i++) {
      expect(c.middle[i] as number).toBeCloseTo(
        ((c.upper[i] as number) + (c.lower[i] as number)) / 2,
        10,
      );
    }
  });

  /**
   * The reason `excludeCurrent` exists.
   *
   * A channel that includes the bar being tested can never be broken by it —
   * the bar is its own high — so every breakout study built on the inclusive
   * form is a study of nothing. This asserts the two forms genuinely differ on
   * a bar that makes a new high.
   */
  it("excludes the current bar when asked, so a breakout is possible at all", () => {
    const rising: BarView[] = Array.from({ length: 40 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100 + i,
      h: 101 + i,
      l: 99 + i,
      c: 100 + i,
      v: 1,
    }));
    const d2 = cols(rising);
    const inclusive = donchian(d2.h, d2.l, 20, false);
    const exclusive = donchian(d2.h, d2.l, 20, true);
    const i = 35;
    expect(d2.h[i] as number).toBeGreaterThan(exclusive.upper[i] as number);
    expect(d2.h[i] as number).toBe(inclusive.upper[i] as number);
  });
});

describe("ichimoku", () => {
  const bars = series(200);
  const d = cols(bars);
  const r = ichimoku(d.h, d.l, d.c);

  /**
   * The displacement, which is the part an implementation gets silently wrong.
   *
   * The cloud belongs 26 bars ahead of the data it was computed from. An
   * implementation that skips the shift draws a completely plausible cloud on
   * the wrong bars, and nothing on screen reveals it.
   */
  it("shifts the cloud forward by the displacement", () => {
    const undisplaced = ichimoku(d.h, d.l, d.c, 9, 26, 52, 0);
    for (let i = 60; i < 200; i++) {
      expect(r.spanA[i] as number).toBeCloseTo(undisplaced.spanA[i - 26] as number, 10);
    }
  });

  it("leaves the first `displacement` bars of the cloud empty", () => {
    for (let i = 0; i < 26; i++) expect(Number.isNaN(r.spanA[i] as number)).toBe(true);
  });

  it("displaces the lagging span backwards, so it stops short of the live edge", () => {
    for (let i = 0; i < 174; i++) {
      expect(r.lagging[i] as number).toBe(d.c[i + 26] as number);
    }
    for (let i = 174; i < 200; i++) {
      expect(Number.isNaN(r.lagging[i] as number)).toBe(true);
    }
  });

  it("puts span A exactly between conversion and base, before the shift", () => {
    const u = ichimoku(d.h, d.l, d.c, 9, 26, 52, 0);
    for (let i = 30; i < 200; i++) {
      expect(u.spanA[i] as number).toBeCloseTo(
        ((u.conversion[i] as number) + (u.base[i] as number)) / 2,
        10,
      );
    }
  });
});

describe("chandelier", () => {
  /**
   * The ratchet IS the indicator.
   *
   * A trailing stop that loosens is not a trailing stop. This is the property
   * a naive `high - mult * atr` implementation fails the moment the lookback
   * high rolls off the back of the window.
   */
  it("never lets the long exit fall while price holds above it", () => {
    const rising: BarView[] = Array.from({ length: 120 }, (_, i) => ({
      t: i * 3_600_000,
      o: 100 + i,
      h: 101 + i,
      l: 99 + i,
      c: 100 + i,
      v: 1,
    }));
    const d = cols(rising);
    const ce = chandelier(d.h, d.l, d.c);
    for (let i = 40; i < 120; i++) {
      expect(ce.long[i] as number).toBeGreaterThanOrEqual(ce.long[i - 1] as number);
    }
  });

  it("never lets the short exit rise while price holds below it", () => {
    const falling: BarView[] = Array.from({ length: 120 }, (_, i) => ({
      t: i * 3_600_000,
      o: 300 - i,
      h: 301 - i,
      l: 299 - i,
      c: 300 - i,
      v: 1,
    }));
    const d = cols(falling);
    const ce = chandelier(d.h, d.l, d.c);
    for (let i = 40; i < 120; i++) {
      expect(ce.short[i] as number).toBeLessThanOrEqual(ce.short[i - 1] as number);
    }
  });

  /**
   * The side that is TRENDING is the side whose stop brackets price.
   *
   * My first version asserted both on one oscillating series and the short leg
   * failed — correctly. In an uptrend the 22-bar low sits far below price and
   * three ATR does not span the gap, so the short exit legitimately prints
   * below price. That is the indicator saying "there is no short here to
   * trail", not a bug, and asserting otherwise would have pinned a wrong
   * expectation into the suite.
   */
  it("brackets price on whichever side is actually trending", () => {
    const up = cols(
      Array.from({ length: 120 }, (_, i) => ({
        t: i * 3_600_000,
        o: 100 + i,
        h: 101 + i,
        l: 99 + i,
        c: 100 + i,
        v: 1,
      })),
    );
    const ceUp = chandelier(up.h, up.l, up.c);
    expect(ceUp.long[110] as number).toBeLessThan(up.c[110] as number);

    const down = cols(
      Array.from({ length: 120 }, (_, i) => ({
        t: i * 3_600_000,
        o: 300 - i,
        h: 301 - i,
        l: 299 - i,
        c: 300 - i,
        v: 1,
      })),
    );
    const ceDown = chandelier(down.h, down.l, down.c);
    expect(ceDown.short[110] as number).toBeGreaterThan(down.c[110] as number);
  });
});

describe("anchoredVwap", () => {
  const bars = series(100);
  const d = cols(bars);

  it("is NaN before the anchor rather than zero", () => {
    const v = anchoredVwap(d.h, d.l, d.c, d.v, 40);
    for (let i = 0; i < 40; i++) expect(Number.isNaN(v[i] as number)).toBe(true);
    expect(Number.isFinite(v[40] as number)).toBe(true);
  });

  it("starts at the anchor bar's own typical price", () => {
    const v = anchoredVwap(d.h, d.l, d.c, d.v, 40);
    const typical = ((d.h[40] as number) + (d.l[40] as number) + (d.c[40] as number)) / 3;
    expect(v[40] as number).toBeCloseTo(typical, 10);
  });

  it("weights by volume — a heavy bar pulls the average toward it", () => {
    const heavy = series(10).map((b, i) => (i === 5 ? { ...b, v: 100000 } : { ...b, v: 1 }));
    const dd = cols(heavy);
    const v = anchoredVwap(dd.h, dd.l, dd.c, dd.v, 0);
    const at5 = ((heavy[5] as BarView).h + (heavy[5] as BarView).l + (heavy[5] as BarView).c) / 3;
    expect(v[9] as number).toBeCloseTo(at5, 1);
  });

  /* An FX feed reports no volume at all. Dividing by zero would emit Infinity
     into the column and paint a line off the top of the chart. */
  it("degrades to a plain typical-price average on a volumeless feed", () => {
    const novol = series(20).map((b) => ({ ...b, v: 0 }));
    const dd = cols(novol);
    const v = anchoredVwap(dd.h, dd.l, dd.c, dd.v, 0);
    for (let i = 0; i < 20; i++) expect(Number.isFinite(v[i] as number)).toBe(true);
  });
});

describe("relativeStrength", () => {
  it("starts at 100 and rises when the numerator outperforms", () => {
    const a = Float64Array.from([100, 110, 120, 130]);
    const b = Float64Array.from([100, 100, 100, 100]);
    const rs = relativeStrength(a, b);
    expect(rs[0] as number).toBeCloseTo(100, 10);
    expect(rs[3] as number).toBeCloseTo(130, 10);
  });

  it("falls when the numerator underperforms even though both are rising", () => {
    /* The whole point: an asset up 10% against a benchmark up 50% is losing,
       and a correlation would call these two nearly identical. */
    const a = Float64Array.from([100, 105, 110]);
    const b = Float64Array.from([100, 130, 150]);
    const rs = relativeStrength(a, b);
    expect(rs[2] as number).toBeLessThan(100);
  });

  it("skips unjoinable bars instead of inventing a ratio", () => {
    const a = Float64Array.from([100, NaN, 120]);
    const b = Float64Array.from([100, 100, 100]);
    const rs = relativeStrength(a, b);
    expect(Number.isNaN(rs[1] as number)).toBe(true);
  });
});

describe("volumeProfile", () => {
  it("puts the point of control where the volume actually was", () => {
    /* Twenty bars at 100 and two at 200. The shelf is at 100. */
    const bars: BarView[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({ t: i * 1000, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000 });
    }
    for (let i = 0; i < 2; i++) {
      bars.push({ t: (20 + i) * 1000, o: 200, h: 200.5, l: 199.5, c: 200, v: 10 });
    }
    const p = volumeProfile(bars);
    expect(p).not.toBeNull();
    if (p === null) throw new Error("unreachable");
    expect(p.poc).toBeGreaterThan(99);
    expect(p.poc).toBeLessThan(101);
  });

  it("orders the value area around the point of control", () => {
    const p = volumeProfile(series(300));
    if (p === null) throw new Error("unreachable");
    expect(p.val).toBeLessThanOrEqual(p.poc);
    expect(p.vah).toBeGreaterThanOrEqual(p.poc);
  });

  it("encloses roughly the requested share of volume", () => {
    const p = volumeProfile(series(300), DEFAULT_BINS, 0.7);
    if (p === null) throw new Error("unreachable");
    const inside = p.bins
      .filter((b) => b.high > p.val && b.low < p.vah)
      .reduce((a, b) => a + b.volume, 0);
    expect(inside / p.total).toBeGreaterThan(0.65);
    /* Overshoot is expected — the area grows a whole bin at a time and cannot
       stop halfway through one. */
    expect(inside / p.total).toBeLessThan(0.85);
  });

  it("conserves volume: every bar's volume lands somewhere", () => {
    const bars = series(150);
    const p = volumeProfile(bars);
    if (p === null) throw new Error("unreachable");
    const expected = bars.reduce((a, b) => a + b.v, 0);
    expect(p.total).toBeCloseTo(expected, 6);
  });

  it("distributes by OVERLAP, not by bin count", () => {
    /* One bar spanning 100–110 against 10 bins over that range must put a
       tenth of its volume in each, not all of it in the first. */
    const one: BarView[] = [{ t: 0, o: 100, h: 110, l: 100, c: 105, v: 1000 }];
    const p = volumeProfile(one, 10);
    if (p === null) throw new Error("unreachable");
    for (const b of p.bins) expect(b.volume).toBeCloseTo(100, 6);
  });

  /**
   * The refusal.
   *
   * An FX feed reports no volume. A profile over an all-zero column would be a
   * flat block with a point of control wherever the loop broke ties — a
   * confident, meaningless line drawn across the chart.
   */
  it("returns null rather than a shape when there is no volume", () => {
    expect(volumeProfile(series(50).map((b) => ({ ...b, v: 0 })))).toBeNull();
  });

  it("returns null for an empty or flat window", () => {
    expect(volumeProfile([])).toBeNull();
    const flat: BarView[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 5 }];
    expect(volumeProfile(flat)).toBeNull();
  });

  it("handles a doji whose whole range sits in one bin", () => {
    const bars: BarView[] = [
      { t: 0, o: 100, h: 100, l: 100, c: 100, v: 50 },
      { t: 1, o: 100, h: 120, l: 100, c: 110, v: 50 },
    ];
    const p = volumeProfile(bars, 10);
    if (p === null) throw new Error("unreachable");
    expect(p.total).toBeCloseTo(100, 6);
  });
});

describe("profileNodes", () => {
  it("finds the shelf as a high-volume node", () => {
    const bars: BarView[] = [];
    for (let i = 0; i < 60; i++) {
      bars.push({ t: i * 1000, o: 100, h: 100.4, l: 99.6, c: 100, v: 1000 });
    }
    for (let i = 0; i < 20; i++) {
      bars.push({ t: (60 + i) * 1000, o: 100 + i, h: 100.5 + i, l: 99.5 + i, c: 100 + i, v: 10 });
    }
    const p = volumeProfile(bars);
    if (p === null) throw new Error("unreachable");
    const nodes = profileNodes(p);
    const hvn = nodes.filter((n) => n.kind === "hvn");
    expect(hvn.length).toBeGreaterThan(0);
    expect(hvn[0]?.price).toBeGreaterThan(98);
    expect(hvn[0]?.price).toBeLessThan(102);
  });

  it("reports nothing for a perfectly even distribution", () => {
    const one: BarView[] = [{ t: 0, o: 100, h: 110, l: 100, c: 105, v: 1000 }];
    const p = volumeProfile(one, 10);
    if (p === null) throw new Error("unreachable");
    expect(profileNodes(p)).toEqual([]);
  });
});

describe("the study registry", () => {
  const bars = series(300);
  const input = {
    ...studyColumns(bars),
    colour: () => "#fff",
    anchorIndex: 100,
  };

  it("gives every study a unique id and a non-empty blurb", () => {
    const ids = new Set<string>();
    for (const st of STUDIES) {
      expect(ids.has(st.id), st.id).toBe(false);
      ids.add(st.id);
      expect(st.blurb.length).toBeGreaterThan(10);
    }
  });

  it("produces overlays the same length as the series, for every study", () => {
    for (const st of STUDIES) {
      for (const line of st.run(input)) {
        expect(line.values, `${st.id}/${line.id}`).toHaveLength(300);
      }
    }
  });

  it("gives every overlay a unique id within one run", () => {
    const lines = runStudies(
      STUDIES.map((s) => s.id),
      input,
    );
    const ids = new Set(lines.map((l) => l.id));
    expect(ids.size).toBe(lines.length);
  });

  /**
   * Study ids are PERSISTED. A build that dropped one would otherwise refuse
   * to open on the preferences written by the build before it.
   */
  it("skips an unknown id instead of throwing", () => {
    expect(() => runStudies(["no-such-study"], input)).not.toThrow();
    expect(runStudies(["no-such-study"], input)).toEqual([]);
  });

  it("draws no profile levels when the feed has no volume", () => {
    const novol = studyColumns(series(200).map((b) => ({ ...b, v: 0 })));
    const lines = runStudies(["profile"], { ...novol, colour: () => "#fff", anchorIndex: null });
    expect(lines).toEqual([]);
  });
});

describe("studySummary", () => {
  it("says nothing is on when nothing is on", () => {
    expect(studySummary([], false, true)).toMatch(/No studies/);
  });

  /* The two reasons an enabled study can be invisible are reported separately,
     because only one of them is something a click can fix. */
  it("names a missing anchor as the reason anchored VWAP is blank", () => {
    expect(studySummary(["avwap"], false, true)).toMatch(/no anchor/i);
    expect(studySummary(["avwap"], true, true)).not.toMatch(/no anchor/i);
  });

  it("names a volumeless feed as the reason the volume studies are blank", () => {
    expect(studySummary(["profile"], true, false)).toMatch(/no volume/i);
    expect(studySummary(["keltner"], true, false)).not.toMatch(/no volume/i);
  });

  it("agrees with the registry about which studies need an anchor", () => {
    for (const id of ANCHORED_STUDIES) {
      expect(STUDIES.some((s) => s.id === id), id).toBe(true);
    }
  });
});
