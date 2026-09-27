import { describe, it, expect } from "vitest";
import {
  percentileOfLast,
  median,
  ordinal,
  compression,
  narrowRange,
  volTermStructure,
  fundingCrowding,
  openInterestRead,
  participation,
  momentumDivergence,
  followThrough,
  combineLeading,
  readLeading,
  COMPRESSED,
  type LeadingComponent,
  type PositioningInput,
} from "../src/analysis/leading";
import type { ScanBars } from "../src/scan/confluence";

/* ---------------------------------------------------------------- fixtures */

interface BarSpec {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function bars(specs: readonly BarSpec[]): ScanBars {
  const n = specs.length;
  const mk = (pick: (s: BarSpec) => number): Float64Array => {
    const a = new Float64Array(n);
    specs.forEach((s, i) => (a[i] = pick(s)));
    return a;
  };
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i * 60_000;
  return { t, o: mk((s) => s.o), h: mk((s) => s.h), l: mk((s) => s.l), c: mk((s) => s.c), v: mk((s) => s.v) };
}

/** A series with a controllable per-bar range and drift. */
function synth(n: number, opts: { range?: (i: number) => number; drift?: number; vol?: (i: number) => number } = {}): ScanBars {
  const range = opts.range ?? (() => 2);
  const vol = opts.vol ?? (() => 1000);
  const drift = opts.drift ?? 0;
  const out: BarSpec[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const r = range(i);
    const o = px;
    px = px + drift + (i % 2 === 0 ? r / 4 : -r / 4);
    out.push({ o, h: Math.max(o, px) + r / 2, l: Math.min(o, px) - r / 2, c: px, v: vol(i) });
  }
  return bars(out);
}

const NO_POSITIONING: PositioningInput = {
  funding: null,
  fundingPercentile: null,
  oiNow: null,
  oiThen: null,
  priceNow: null,
  priceThen: null,
};

/* ------------------------------------------------------------------ tests */

describe("percentileOfLast", () => {
  it("puts the largest value at the top of its own history", () => {
    expect(percentileOfLast([1, 2, 3, 4, 100], 10)).toBe(1);
  });

  it("puts the smallest at the bottom", () => {
    expect(percentileOfLast([10, 20, 30, 40, 1], 10)).toBe(0);
  });

  it("compares against the lookback only, not the whole array", () => {
    /* Last value 5. With a lookback of 2 the comparison set is [9, 9]. */
    expect(percentileOfLast([1, 1, 1, 9, 9, 5], 2)).toBe(0);
  });

  it("is NaN when there is nothing to compare against", () => {
    expect(Number.isNaN(percentileOfLast([7], 10))).toBe(true);
  });

  it("skips non-finite entries instead of counting them", () => {
    expect(percentileOfLast([NaN, NaN, 1, 2, 3], 10)).toBe(1);
  });

  /* The regression. Counting only strictly-smaller values reported a series
     that never changes as the tightest reading it had ever printed. */
  it("puts a fully tied window in the middle, not at the bottom", () => {
    expect(percentileOfLast([5, 5, 5, 5, 5], 10)).toBe(0.5);
  });

  it("splits ties either side of the value", () => {
    /* Comparison set [1, 5, 5, 9] against a last of 5: one below, two tied. */
    expect(percentileOfLast([1, 5, 5, 9, 5], 10)).toBe(0.5);
  });
});

describe("ordinal", () => {
  it("uses st, nd and rd where English does", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(43)).toBe("43rd");
  });

  /* The exception every home-made version misses. */
  it("says eleventh, twelfth and thirteenth", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(113)).toBe("113th");
  });

  it("rounds before deciding the suffix", () => {
    expect(ordinal(42.6)).toBe("43rd");
    expect(ordinal(0.4)).toBe("0th");
  });
});

describe("median", () => {
  it("averages the middle pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is unmoved by a single outlier, which is why it is used here", () => {
    expect(median([1, 2, 3, 4, 1_000_000])).toBe(3);
  });

  it("is NaN for nothing usable", () => {
    expect(Number.isNaN(median([NaN, NaN]))).toBe(true);
  });
});

describe("compression", () => {
  it("returns null, not zero, when there is not enough history", () => {
    const c = compression(synth(40));
    expect(c.value).toBeNull();
    expect(c.reason).toContain("are needed");
  });

  it("scores high when the range collapses at the end of a wide stretch", () => {
    const n = 200;
    const c = compression(synth(n, { range: (i) => (i < n - 30 ? 6 : 0.15) }));
    expect(c.value).not.toBeNull();
    expect(c.value as number).toBeGreaterThan(0.5);
    expect(c.reason).toContain("do not persist");
  });

  it("scores low on a series that never quietens", () => {
    const c = compression(synth(200, { range: () => 3 }));
    expect(c.value as number).toBeLessThan(0.5);
  });

  /* The property the whole module is organised around. */
  it("speaks only to timing, never to direction", () => {
    expect(compression(synth(200)).speaks).toBe("when");
  });

  it("says out loud that a squeeze has no direction", () => {
    expect(compression(synth(200)).limit).toContain("never which way");
  });
});

describe("narrowRange", () => {
  it("scores 1 when the last bar is the narrowest of the window", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 10; i++) specs.push({ o: 100, h: 105, l: 95, c: 100, v: 1 });
    specs.push({ o: 100, h: 100.2, l: 99.8, c: 100, v: 1 });
    const r = narrowRange(bars(specs));
    expect(r.value).toBe(1);
    expect(r.reason).toContain("narrowest");
  });

  it("does not score a wide bar as a contraction", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 10; i++) specs.push({ o: 100, h: 101, l: 99, c: 100, v: 1 });
    specs.push({ o: 100, h: 120, l: 80, c: 100, v: 1 });
    expect(narrowRange(bars(specs)).value).toBe(0);
  });

  it("refuses below the window rather than guessing", () => {
    expect(narrowRange(synth(3)).value).toBeNull();
  });
});

describe("volTermStructure", () => {
  it("reads quiet when the recent range is a fraction of the longer one", () => {
    const n = 200;
    const r = volTermStructure(synth(n, { range: (i) => (i < n - 15 ? 8 : 0.4) }));
    expect(r.value as number).toBeGreaterThan(0.4);
    expect(r.reason).toContain("gone quiet");
  });

  it("reads already-expanded when the recent range dwarfs the longer one", () => {
    const n = 200;
    const r = volTermStructure(synth(n, { range: (i) => (i < n - 15 ? 0.4 : 8) }));
    expect(r.reason).toContain("Already expanded");
    /* And it must not report an expanded market as coiled. */
    expect(r.value).toBe(0);
  });

  it("returns null below the long window", () => {
    expect(volTermStructure(synth(20)).value).toBeNull();
  });
});

describe("fundingCrowding", () => {
  const p = (over: Partial<PositioningInput>): PositioningInput => ({ ...NO_POSITIONING, ...over });

  it("leans SHORT when longs are crowded — against the crowd, by design", () => {
    const r = fundingCrowding(p({ funding: 0.0009, fundingPercentile: 0.97 }));
    expect(r.value as number).toBeLessThan(0);
    expect(r.reason).toContain("gets flushed");
  });

  it("leans long when shorts are the ones paying", () => {
    const r = fundingCrowding(p({ funding: -0.0009, fundingPercentile: 0.02 }));
    expect(r.value as number).toBeGreaterThan(0);
  });

  it("is flat in the middle of its own history, whatever the raw rate", () => {
    expect(fundingCrowding(p({ funding: 0.0001, fundingPercentile: 0.5 })).value).toBe(0);
  });

  it("returns null with no funding history, and says the instrument may be spot", () => {
    const r = fundingCrowding(NO_POSITIONING);
    expect(r.value).toBeNull();
    expect(r.reason).toContain("spot-only");
  });
});

describe("openInterestRead", () => {
  const p = (oiNow: number, oiThen: number, priceNow: number, priceThen: number): PositioningInput => ({
    ...NO_POSITIONING,
    oiNow,
    oiThen,
    priceNow,
    priceThen,
  });

  it("leans long when new money commits into a rise", () => {
    const r = openInterestRead(p(120, 100, 110, 100));
    expect(r.value as number).toBeGreaterThan(0);
    expect(r.reason).toContain("New money is committing");
  });

  it("leans short when open interest builds into a fall", () => {
    expect(openInterestRead(p(120, 100, 90, 100)).value as number).toBeLessThan(0);
  });

  /* The two readings that every other platform gets wrong by giving them a
     direction. Short covering is a rally with no buyers; it has no lean. */
  it("gives short covering NO lean, and names it", () => {
    const r = openInterestRead(p(80, 100, 110, 100));
    expect(r.value).toBe(0);
    expect(r.reason).toContain("short covering");
  });

  it("gives capitulation NO lean, and says the flush is now rather than ahead", () => {
    const r = openInterestRead(p(80, 100, 90, 100));
    expect(r.value).toBe(0);
    expect(r.reason).toContain("capitulating");
  });

  it("reads nothing from moves too small to mean anything", () => {
    expect(openInterestRead(p(100.5, 100, 100.05, 100)).value).toBe(0);
  });

  it("returns null with no open-interest history", () => {
    expect(openInterestRead(NO_POSITIONING).value).toBeNull();
  });
});

describe("participation", () => {
  it("scores below the neutral half when the recent bars trade thin", () => {
    const n = 200;
    const r = participation(synth(n, { vol: (i) => (i < n - 5 ? 1000 : 200) }));
    expect(r.value as number).toBeLessThan(0.5);
    expect(r.reason).toContain("thinly");
  });

  it("scores above it when the move has attendance", () => {
    const n = 200;
    const r = participation(synth(n, { vol: (i) => (i < n - 5 ? 1000 : 3000) }));
    expect(r.value as number).toBeGreaterThan(0.5);
    expect(r.reason).toContain("attendance");
  });

  it("says so rather than returning zero when the feed carries no volume", () => {
    const r = participation(synth(200, { vol: () => 0 }));
    expect(r.value).toBeNull();
    expect(r.reason).toContain("no volume");
  });

  it("scales conviction and never signs it", () => {
    expect(participation(synth(200)).speaks).toBe("how much");
  });
});

describe("momentumDivergence", () => {
  it("finds a bearish divergence when the second high is weaker", () => {
    /* Two rallies: the second reaches a higher price on a much smaller push,
       so RSI at the second peak is lower. */
    const specs: BarSpec[] = [];
    const push = (from: number, to: number, steps: number) => {
      for (let i = 1; i <= steps; i++) {
        const c = from + ((to - from) * i) / steps;
        specs.push({ o: c, h: c + 0.2, l: c - 0.2, c, v: 1000 });
      }
    };
    push(100, 100, 20);
    push(100, 130, 25); /* strong first rally */
    push(130, 110, 20);
    push(110, 131, 40); /* higher high, much slower */
    push(131, 128, 20);
    const r = momentumDivergence(bars(specs));
    expect(r.value as number).toBeLessThan(0);
    expect(r.reason).toContain("higher high");
  });

  it("reports no divergence when the swings confirm", () => {
    const r = momentumDivergence(synth(200, { drift: 0.05 }));
    expect(r.value).toBe(0);
    expect(r.reason).toContain("No divergence");
  });

  it("returns null with too little history to hold two swings", () => {
    expect(momentumDivergence(synth(20)).value).toBeNull();
  });

  it("states that trends diverge before they turn", () => {
    expect(momentumDivergence(synth(200)).limit).toContain("before they turn");
  });
});

describe("followThrough", () => {
  it("is positive when bars close near their highs", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 20; i++) specs.push({ o: 100, h: 102, l: 99, c: 101.9, v: 1 });
    expect(followThrough(bars(specs)).value as number).toBeGreaterThan(0.5);
  });

  it("is negative when bars close near their lows", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 20; i++) specs.push({ o: 100, h: 102, l: 99, c: 99.1, v: 1 });
    expect(followThrough(bars(specs)).value as number).toBeLessThan(-0.5);
  });

  it("is flat on mid-range closes", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 20; i++) specs.push({ o: 100, h: 102, l: 98, c: 100, v: 1 });
    expect(Math.abs(followThrough(bars(specs)).value as number)).toBeLessThan(0.05);
  });

  it("returns null when every bar in the window has no range", () => {
    const specs: BarSpec[] = [];
    for (let i = 0; i < 20; i++) specs.push({ o: 100, h: 100, l: 100, c: 100, v: 1 });
    expect(followThrough(bars(specs)).value).toBeNull();
  });

  /* The honesty requirement: this must never be presented as real delta. */
  it("declares itself a proxy in both its label and its limit", () => {
    const r = followThrough(synth(50));
    expect(r.label).toContain("proxy");
    expect(r.limit).toContain("not a measurement of it");
  });
});

describe("combineLeading", () => {
  const c = (over: Partial<LeadingComponent>): LeadingComponent => ({
    id: "x",
    label: "x",
    family: "coiled",
    speaks: "when",
    value: 0,
    reason: "",
    limit: "",
    ...over,
  });

  it("keeps a timing component entirely out of the direction figure", () => {
    const r = combineLeading([c({ speaks: "when", value: 1 })]);
    expect(r.timing).toBe(1);
    /* Not zero — NULL. Nothing spoke to direction, and that is a different
       statement from "direction is neutral". */
    expect(r.direction).toBeNull();
  });

  it("keeps a direction component entirely out of the timing figure", () => {
    const r = combineLeading([c({ speaks: "which way", value: -1 })]);
    expect(r.direction).toBe(-1);
    expect(r.timing).toBe(0);
  });

  it("lets a conviction component scale nothing but conviction", () => {
    const r = combineLeading([c({ speaks: "how much", value: 0.9 })]);
    expect(r.conviction).toBeCloseTo(0.9, 9);
    expect(r.direction).toBeNull();
    expect(r.timing).toBe(0);
  });

  it("counts a null component against coverage rather than as a neutral vote", () => {
    const r = combineLeading([
      c({ speaks: "which way", value: 1 }),
      c({ speaks: "which way", value: null }),
    ]);
    expect(r.coverage).toBe(0.5);
    /* The answered component is not diluted by the silent one. */
    expect(r.direction).toBe(1);
    expect(r.headline).toContain("1 of 2 inputs answered");
  });

  it("defaults conviction to the neutral half when nothing measures it", () => {
    expect(combineLeading([c({ speaks: "when", value: 0.2 })]).conviction).toBe(0.5);
  });

  it("writes a sentence, never a single score", () => {
    const r = combineLeading([
      c({ speaks: "when", value: 0.9 }),
      c({ speaks: "which way", value: 0.8 }),
      c({ speaks: "how much", value: 0.2 }),
    ]);
    expect(r.headline).toContain("expansion looks close");
    expect(r.headline).toContain("leans up");
    expect(r.headline).toContain("Participation is thin");
  });

  it("is empty-safe", () => {
    const r = combineLeading([]);
    expect(r.coverage).toBe(0);
    expect(r.direction).toBeNull();
  });
});

describe("readLeading", () => {
  it("still returns the positioning components when the instrument is spot", () => {
    const r = readLeading(synth(300));
    const ids = r.components.map((x) => x.id);
    expect(ids).toContain("fundingCrowd");
    expect(ids).toContain("oiRead");
    /* Present but unanswered, so coverage falls and the headline says so —
       a spot instrument really does have less behind it. */
    expect(r.coverage).toBeLessThan(1);
    expect(r.headline).toContain("inputs answered");
  });

  it("reaches full coverage when positioning is supplied", () => {
    const r = readLeading(synth(300), {
      funding: 0.0004,
      fundingPercentile: 0.6,
      oiNow: 110,
      oiThen: 100,
      priceNow: 105,
      priceThen: 100,
    });
    expect(r.coverage).toBe(1);
  });

  it("never returns a direction built from a squeeze", () => {
    /* A hard compression with no positioning and confirming swings: timing
       should be high and direction must not be dragged along with it. */
    const n = 300;
    const r = readLeading(synth(n, { range: (i) => (i < n - 30 ? 6 : 0.1) }));
    expect(r.timing).toBeGreaterThan(0.4);
    const way = r.components.filter((x) => x.speaks === "which way");
    expect(way.every((x) => x.family !== "coiled")).toBe(true);
  });

  it("keeps the compressed threshold where the comment says it is", () => {
    expect(COMPRESSED).toBe(0.15);
  });
});
