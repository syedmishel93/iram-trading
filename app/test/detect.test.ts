import { describe, it, expect } from "vitest";
import { findPivots, alternate, lastPivots, noiseShare, prominenceFloor } from "../src/detect/pivots";
import { detectStructure, detectLevels } from "../src/detect/structure";
import { detectFVG, detectOrderBlocks } from "../src/detect/zones";
import {
  detectDoubles,
  detectHeadShoulders,
  detectTrendlines,
  detectDivergence,
} from "../src/detect/formations";
import { runDetectors, toDetectInput, DETECTORS } from "../src/detect";
import type { DetectInput } from "../src/detect/types";
import type { BarView } from "../src/chart/series";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

/** Build bars from a close path; highs/lows hug the body unless widened. */
function bars(closes: number[], wick = 0.002): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] as number);
    return {
      t: i * 3_600_000,
      o,
      h: Math.max(o, c) * (1 + wick),
      l: Math.min(o, c) * (1 - wick),
      c,
      v: 1000,
    };
  });
}

const input = (closes: number[], wick?: number): DetectInput => toDetectInput(bars(closes, wick));

/** A zig-zag path: up `up` then down `down`, repeated. */
function zigzag(legs: Array<{ to: number; bars: number }>, start = 100): number[] {
  const out = [start];
  let cur = start;
  for (const leg of legs) {
    const step = (leg.to - cur) / leg.bars;
    for (let i = 0; i < leg.bars; i++) out.push((cur += step));
    cur = leg.to;
  }
  return out;
}

describe("pivots", () => {
  it("finds a swing high and a swing low", () => {
    const d = input(zigzag([{ to: 120, bars: 10 }, { to: 90, bars: 10 }, { to: 115, bars: 10 }]));
    const p = findPivots(d.h, d.l, { left: 3, right: 3 });
    expect(p.some((x) => x.kind === "high")).toBe(true);
    expect(p.some((x) => x.kind === "low")).toBe(true);
  });

  it("does NOT confirm a pivot until `right` bars have closed after it", () => {
    // The look-ahead guarantee. A detector that ignores this reads the future:
    // at bar i it uses bars i+1..i+right that had not happened yet.
    const d = input(zigzag([{ to: 120, bars: 10 }, { to: 90, bars: 10 }]));
    for (const p of findPivots(d.h, d.l, { left: 3, right: 3 })) {
      expect(p.confirmedAt).toBe(p.index + 3);
      expect(p.confirmedAt).toBeGreaterThan(p.index);
    }
  });

  it("never reports a pivot inside the unconfirmable tail", () => {
    const d = input(zigzag([{ to: 130, bars: 20 }, { to: 100, bars: 20 }]));
    const len = d.c.length;
    for (const p of findPivots(d.h, d.l, { left: 3, right: 3 }, len)) {
      expect(p.index).toBeLessThan(len - 3);
    }
  });

  it("returns nothing for a series shorter than the window", () => {
    const d = input([1, 2, 3]);
    expect(findPivots(d.h, d.l, { left: 3, right: 3 })).toEqual([]);
  });

  it("drops pivots below the prominence floor", () => {
    const noisy = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i) * 0.01);
    const d = input(noisy, 0);
    const loose = findPivots(d.h, d.l, { left: 2, right: 2, minProminence: 0 });
    const strict = findPivots(d.h, d.l, { left: 2, right: 2, minProminence: 0.05 });
    expect(strict.length).toBeLessThan(loose.length);
  });

  it("collapses a staircase of same-kind pivots to the extreme one", () => {
    const p = alternate([
      { kind: "high", index: 1, price: 10, confirmedAt: 4, prominence: 0.1 },
      { kind: "high", index: 5, price: 14, confirmedAt: 8, prominence: 0.1 },
      { kind: "low", index: 9, price: 5, confirmedAt: 12, prominence: 0.1 },
    ]);
    expect(p).toHaveLength(2);
    expect(p[0]?.price).toBe(14);
  });

  it("lastPivots respects confirmation, not the pivot index", () => {
    const list = [
      { kind: "high" as const, index: 5, price: 10, confirmedAt: 8, prominence: 0.1 },
      { kind: "low" as const, index: 12, price: 5, confirmedAt: 15, prominence: 0.1 },
    ];
    expect(lastPivots(list, 7).high).toBeNull(); // seen but not yet confirmed
    expect(lastPivots(list, 8).high?.index).toBe(5);
    expect(lastPivots(list, 14).low).toBeNull();
  });
});

describe("market structure", () => {
  it("labels a continuation break BOS and a counter-trend break CHoCH", () => {
    // The distinction is the whole point: labelling every break a BOS throws
    // away the only information that made the concept worth having.
    const path = zigzag([
      { to: 130, bars: 12 },
      { to: 115, bars: 8 },
      { to: 150, bars: 12 }, // takes the prior high -> BOS (up continues)
      { to: 105, bars: 16 }, // takes the prior low  -> CHoCH (trend flips)
    ]);
    const found = detectStructure(input(path));
    expect(found.some((d) => d.kind === "bos")).toBe(true);
    expect(found.some((d) => d.kind === "choch")).toBe(true);

    const choch = found.find((d) => d.kind === "choch");
    expect(choch?.reason).toMatch(/AGAINST/);
  });

  it("confirms breaks on CLOSE, not on wick", () => {
    // A wick through a level that closes back inside is the liquidity sweep the
    // level exists to describe. Treating it as a break inverts the meaning.
    const closes = [...Array(30).fill(100), 104, ...Array(20).fill(99)];
    const b = bars(closes, 0);
    // Bar 40 wicks far above every prior high but closes back at 99.
    const spike = b[40] as Bar;
    spike.h = 200;

    const found = detectStructure(toDetectInput(b));
    // Nothing may be reported at the wick bar: it closed back inside.
    expect(found.some((d) => d.to === 40)).toBe(false);
    // And no bullish break may claim a close that never happened.
    for (const d of found.filter((x) => x.direction === "long")) {
      expect(closes[d.to] as number).toBeGreaterThan(100);
    }
  });

  it("fires once per swing, not on every later bar", () => {
    const path = zigzag([{ to: 130, bars: 10 }, { to: 118, bars: 6 }, { to: 170, bars: 30 }]);
    const found = detectStructure(input(path));
    const keys = found.map((d) => d.id);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every detection a reason and a shape", () => {
    const path = zigzag([{ to: 130, bars: 12 }, { to: 112, bars: 8 }, { to: 150, bars: 12 }]);
    for (const d of detectStructure(input(path))) {
      expect(d.reason.length).toBeGreaterThan(20);
      expect(d.shapes.length).toBeGreaterThan(0);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("levels", () => {
  it("needs more than one touch — a single swing is not a level", () => {
    const once = zigzag([{ to: 130, bars: 10 }, { to: 100, bars: 10 }]);
    const twice = zigzag([
      { to: 130, bars: 10 },
      { to: 100, bars: 10 },
      { to: 130, bars: 10 },
      { to: 100, bars: 10 },
    ]);
    expect(detectLevels(input(once)).length).toBeLessThanOrEqual(
      detectLevels(input(twice)).length,
    );
  });

  it("reports how many swings formed the level", () => {
    // Highs must sit inside the clustering tolerance, and the LAST swing needs
    // trailing bars or it is never confirmed — the same look-ahead rule pivots
    // obey everywhere else.
    const path = zigzag([
      { to: 130, bars: 10 },
      { to: 100, bars: 10 },
      { to: 130.1, bars: 10 },
      { to: 101, bars: 10 },
      { to: 130.2, bars: 10 },
      { to: 105, bars: 10 },
    ]);
    const levels = detectLevels(input(path));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]?.reason).toMatch(/swings within/);
  });
});

describe("fair value gaps", () => {
  const gapUp = (): Bar[] => {
    const b = bars(Array.from({ length: 40 }, () => 100), 0.001);
    // Bar 20 gaps well above bar 18's high and stays there.
    for (let i = 20; i < 40; i++) {
      const bar = b[i] as Bar;
      bar.o = 110;
      bar.c = 110;
      bar.h = 111;
      bar.l = 109;
    }
    return b;
  };

  it("finds a three-bar imbalance", () => {
    const found = detectFVG(toDetectInput(gapUp()), { hideMitigated: false });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.direction).toBe("long");
    expect(found[0]?.reason).toMatch(/did not overlap/);
  });

  it("hides a gap price has traded back through", () => {
    const b = gapUp();
    // Come back down into the gap.
    for (let i = 30; i < 40; i++) {
      const bar = b[i] as Bar;
      bar.o = 100;
      bar.c = 100;
      bar.h = 111;
      bar.l = 99;
    }
    const hidden = detectFVG(toDetectInput(b), { hideMitigated: true });
    const shown = detectFVG(toDetectInput(b), { hideMitigated: false });
    expect(hidden.length).toBeLessThan(shown.length);
    expect(shown.some((d) => d.reason.includes("already mitigated"))).toBe(true);
  });

  it("ignores gaps below the size floor", () => {
    const found = detectFVG(toDetectInput(gapUp()), { minSize: 0.5, hideMitigated: false });
    expect(found).toEqual([]);
  });
});

describe("order blocks", () => {
  it("picks the last opposing candle before a displacement", () => {
    const b = bars(Array.from({ length: 30 }, () => 100), 0.001);
    // Bar 19 closes down, bar 20 displaces hard up.
    const down = b[19] as Bar;
    down.o = 101;
    down.c = 99;
    down.h = 101.5;
    down.l = 98.5;
    const push = b[20] as Bar;
    push.o = 99;
    push.c = 108;
    push.h = 108.5;
    push.l = 99;
    for (let i = 21; i < 30; i++) {
      const bar = b[i] as Bar;
      bar.o = 108;
      bar.c = 109;
      bar.h = 110;
      bar.l = 107.5;
    }

    const found = detectOrderBlocks(toDetectInput(b), { hideMitigated: false });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.direction).toBe("long");
    expect(found[0]?.reason).toMatch(/last down close/);
  });
});

describe("order block deduplication", () => {
  it("yields ONE block when consecutive displacements share a block candle", () => {
    // Two displacement bars in a row both look back to the same opposing
    // candle. Without dedup the zone is detected twice, drawn twice, and
    // carries a colliding id.
    const b = bars(Array.from({ length: 40 }, () => 100), 0.001);
    const down = b[19] as Bar;
    down.o = 101;
    down.c = 99;
    down.h = 101.5;
    down.l = 98.5;
    for (const idx of [20, 21]) {
      const push = b[idx] as Bar;
      push.o = 99;
      push.c = 108 + idx;
      push.h = push.c + 1;
      push.l = 99;
    }

    const found = detectOrderBlocks(toDetectInput(b), { hideMitigated: false });
    const ids = found.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(found.filter((d) => d.from === 19)).toHaveLength(1);
  });
});

describe("formations", () => {
  it("only reports a double top AFTER the neckline breaks", () => {
    // Two highs and a hope is not a double top.
    const unconfirmed = zigzag([
      { to: 140, bars: 12 },
      { to: 120, bars: 10 },
      { to: 139, bars: 12 },
      { to: 132, bars: 6 }, // pulls back but never breaks 120
    ]);
    expect(detectDoubles(input(unconfirmed))).toEqual([]);

    const confirmed = zigzag([
      { to: 140, bars: 12 },
      { to: 120, bars: 10 },
      { to: 139, bars: 12 },
      { to: 105, bars: 14 }, // closes through the neckline
    ]);
    /* `minProminence: 0` because this test is about the PATTERN LOGIC — two
       twin highs and a close through the neckline — not about the swing
       threshold, which is calibrated separately and has its own tests below.
       The fixture is a perfectly smooth zigzag, so a bar's "typical range" is
       a twelfth of the swing it is part of and the adaptive floor lands right
       on the boundary. Real series are nothing like that; pinning the logic
       against a threshold artefact of the fixture would test neither. */
    const found = detectDoubles(input(confirmed), { minProminence: 0 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.kind).toBe("double-top");
    expect(found[0]?.direction).toBe("short");
    expect(found[0]?.reason).toMatch(/confirmed by the close/);
  });

  it("finds a double bottom in the mirror case", () => {
    const path = zigzag([
      { to: 80, bars: 12 },
      { to: 100, bars: 10 },
      { to: 81, bars: 12 },
      { to: 118, bars: 14 },
    ]);
    const found = detectDoubles(input(path));
    expect(found.some((d) => d.kind === "double-bottom" && d.direction === "long")).toBe(true);
  });

  it("requires the head to exceed both shoulders", () => {
    const hs = zigzag([
      { to: 120, bars: 8 }, // left shoulder
      { to: 105, bars: 6 },
      { to: 145, bars: 10 }, // head
      { to: 104, bars: 8 },
      { to: 121, bars: 8 }, // right shoulder
      { to: 85, bars: 12 }, // neckline break
    ]);
    /* `minProminence: 0` for the same reason as the double-top test above:
       this pins the head-and-shoulders geometry, not the swing threshold. */
    const found = detectHeadShoulders(input(hs), { minProminence: 0 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.direction).toBe("short");
    expect(found[0]?.reason).toMatch(/shoulders/);

    // A "head" that does not exceed the shoulders is not a head.
    const flat = zigzag([
      { to: 120, bars: 8 },
      { to: 105, bars: 6 },
      { to: 118, bars: 10 },
      { to: 104, bars: 8 },
      { to: 121, bars: 8 },
      { to: 85, bars: 12 },
    ]);
    expect(detectHeadShoulders(input(flat))).toEqual([]);
  });

  it("needs three touches for a trendline — two points is just a line", () => {
    const three = zigzag([
      { to: 120, bars: 8 },
      { to: 104, bars: 8 },
      { to: 128, bars: 8 },
      { to: 110, bars: 8 },
      { to: 136, bars: 8 },
      { to: 116, bars: 8 },
    ]);
    const found = detectTrendlines(input(three), { minTouches: 3 });
    for (const d of found) expect(d.reason).toMatch(/[3-9] swing/);

    expect(detectTrendlines(input(three), { minTouches: 99 })).toEqual([]);
  });

  it("finds bearish divergence when price rises and RSI does not", () => {
    // Strong first leg, then a marginally higher high on much weaker momentum.
    const path = [
      ...zigzag([{ to: 160, bars: 25 }], 100),
      ...zigzag([{ to: 130, bars: 18 }], 160),
      ...zigzag([{ to: 162, bars: 40 }], 130),
      ...zigzag([{ to: 150, bars: 10 }], 162),
    ];
    const found = detectDivergence(input(path), { maxAgeBars: 200 });
    for (const d of found) {
      expect(d.reason).toMatch(/momentum did not confirm/);
      expect(["long", "short"]).toContain(d.direction);
    }
  });
});

describe("registry", () => {
  it("every detector has a label and a blurb", () => {
    for (const d of DETECTORS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.blurb.length).toBeGreaterThan(10);
    }
  });

  it("runs only what is enabled", () => {
    const path = zigzag([{ to: 140, bars: 12 }, { to: 118, bars: 10 }, { to: 160, bars: 14 }]);
    const d = input(path);
    expect(runDetectors(d, [])).toEqual([]);
    expect(runDetectors(d, ["structure"]).every((x) => x.kind === "bos" || x.kind === "choch")).toBe(
      true,
    );
  });

  it("returns detections ordered by the bar they became knowable", () => {
    const path = zigzag([
      { to: 140, bars: 12 },
      { to: 118, bars: 10 },
      { to: 160, bars: 14 },
      { to: 110, bars: 16 },
    ]);
    const found = runDetectors(input(path), ["structure", "levels", "fvg", "divergence"]);
    for (let i = 1; i < found.length; i++) {
      expect(found[i]?.to).toBeGreaterThanOrEqual(found[i - 1]?.to as number);
    }
  });

  it("survives a detector throwing without losing the others", () => {
    // One broken detector must not blank the whole chart's annotations.
    const d = input(zigzag([{ to: 140, bars: 12 }, { to: 118, bars: 10 }, { to: 160, bars: 14 }]));
    const broken = { ...d, h: null as unknown as Float64Array };
    expect(() => runDetectors(broken, ["structure", "levels"])).not.toThrow();
  });

  it("every detection carries a reason, id and shapes", () => {
    // The same glass-box contract the confluence engine enforces.
    const path = zigzag([
      { to: 145, bars: 14 },
      { to: 115, bars: 12 },
      { to: 158, bars: 14 },
      { to: 108, bars: 16 },
    ]);
    const found = runDetectors(
      input(path),
      DETECTORS.map((x) => x.id),
    );
    expect(found.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const f of found) {
      expect(f.reason.trim().length).toBeGreaterThan(20);
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.shapes.length).toBeGreaterThan(0);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
    }
  });
});

/* ==========================================================================
   A THRESHOLD THAT MEANT TWO DIFFERENT THINGS

   Six of the thirteen detectors were dead on gold and nobody could tell,
   because a detector that finds nothing looks exactly like a detector that is
   broken. The cause was a threshold expressed as a SHARE OF PRICE and applied
   to every instrument: `minProminence: 0.004` for the formation detectors,
   `displacement: 0.012` for order blocks, `minSize: 0.001` for fair value
   gaps.

   Measured on 810 live bars of each, same timeframe, near-identical total
   range (BTCUSDT 1.94%, XAUUSD 2.19%):

       minProminence 0.004     BTCUSDT 1m   9 pivots  → 2 trendlines, 1 double
                               XAUUSD 1m    0 pivots  → nothing, on any load

   And `displacement: 0.012` asked for a single candle 32× a normal bar on
   gold and 22× on Bitcoin — so order blocks returned zero on BOTH, and with
   them breaker blocks, which are built entirely on top of order blocks.

   Everything below is in multiples of the series' OWN typical bar range,
   which is the same argument `REDRAW_ATR` in setup/plan.ts already makes:
   the threshold has to mean the same thing on gold and on a memecoin.
   ========================================================================== */

/** `[high, low, close]` columns, so the helpers can be spread into. */
const cols = (b: readonly BarView[]): [Float64Array, Float64Array, Float64Array] => {
  const d = toDetectInput(b);
  return [d.h, d.l, d.c];
};

describe("thresholds scale with the instrument's own noise", () => {
  /** A series with a controllable bar-to-bar range around a flat mean. */
  const noisy = (n: number, price: number, barPct: number, seed = 1): BarView[] => {
    let x = seed;
    const rnd = (): number => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const out: BarView[] = [];
    for (let i = 0; i < n; i++) {
      const c = price * (1 + (rnd() - 0.5) * barPct * 4);
      const r = price * barPct;
      out.push({ t: i * 60_000, o: c, h: c + r / 2, l: c - r / 2, c, v: 1 });
    }
    return out;
  };

  it("measures the typical bar range as a share of price", () => {
    const share = noiseShare(...cols(noisy(300, 100, 0.01)));
    expect(share).toBeGreaterThan(0.005);
    expect(share).toBeLessThan(0.05);
  });

  it("sets a HIGHER bar on a noisier series and a lower one on a calm series", () => {
    /* This is the whole point. The same multiple has to produce a large
       threshold where bars are large and a small one where they are small,
       which is exactly what a fixed share of price cannot do. */
    const calm = prominenceFloor(...cols(noisy(300, 100, 0.001)), 4, 0.004);
    const wild = prominenceFloor(...cols(noisy(300, 100, 0.02)), 4, 0.004);
    expect(wild).toBeGreaterThan(calm * 5);
  });

  it("is independent of the price level, which is what the old one was not", () => {
    /* Gold at 4,375 and Bitcoin at 77,000 with the same relative volatility
       must get the same threshold. Under a share-of-price constant they did
       too — and that was the bug, because the same SHARE is a different amount
       of market when the bars are a different size. */
    const cheap = prominenceFloor(...cols(noisy(300, 100, 0.005)), 4, 0.004);
    const dear = prominenceFloor(...cols(noisy(300, 90_000, 0.005)), 4, 0.004);
    expect(dear).toBeCloseTo(cheap, 4);
  });

  it("falls back rather than returning a zero floor it cannot measure", () => {
    /* A zero floor accepts every one-bar wiggle as a swing — the opposite
       failure, and a noisier one than finding nothing. */
    const flat: BarView[] = Array.from({ length: 5 }, (_, i) => ({
      t: i * 60_000, o: 100, h: 100, l: 100, c: 100, v: 0,
    }));
    expect(prominenceFloor(...cols(flat), 4, 0.004)).toBe(0.004);
  });

  it("finds swings on a series where the old fixed threshold found none", () => {
    /* THE REPRODUCTION, IN MINIATURE.

       Real swings — a 0.25% zigzag, which on gold at 4,375 is a ten-point
       move anyone would trade — built from bars a twentieth of that size.
       Nothing here reaches 0.4% of price, so the old constant sees a flat
       line; the noise-relative floor sees the swings that are actually there.
       This is the shape of 1-minute gold. */
    const gentle: BarView[] = [];
    const price = 4375;
    let px = price;
    let dir = 1;
    for (let i = 0; i < 400; i++) {
      /* Impulse then consolidation, which is the shape real price makes and
         the reason a local prominence measure works at all: three quick bars
         of travel, ten quiet ones, then the other way. A smooth ramp would
         put every pivot exactly on the threshold by construction and would be
         testing the fixture. */
      const impulse = i % 13 < 3;
      px += dir * price * (impulse ? 0.0012 : 0.00002);
      if (i % 13 === 12) dir = -dir;
      const r = price * 0.00008;
      gentle.push({ t: i * 60_000, o: px, h: px + r, l: px - r, c: px, v: 1 });
    }
    const [h, l, c] = cols(gentle);
    expect(findPivots(h, l, { left: 4, right: 4, minProminence: 0.004 }, c.length)).toHaveLength(0);
    const floor = prominenceFloor(h, l, c, 4, 0.004);
    expect(
      findPivots(h, l, { left: 4, right: 4, minProminence: floor }, c.length).length,
    ).toBeGreaterThan(0);
  });
});
