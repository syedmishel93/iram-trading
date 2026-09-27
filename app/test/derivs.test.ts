import { describe, it, expect } from "vitest";
import {
  readDerivatives,
  annualisedFunding,
  fmtUsd,
  fmtNum,
  type FundingPoint,
  type OpenInterestPoint,
  type RatioPoint,
  type TakerFlowPoint,
} from "../src/data/derivs";

const funding = (rate: number, n = 30): FundingPoint[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * 28_800_000, rate, markPrice: 60_000 }));

const oi = (from: number, to: number, n = 30): OpenInterestPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3_600_000,
    amount: 1000,
    value: from + ((to - from) * i) / (n - 1),
  }));

const ls = (longPct: number): RatioPoint[] => [
  {
    time: 1,
    longAccount: longPct,
    shortAccount: 1 - longPct,
    ratio: longPct / (1 - longPct),
  },
];

const taker = (ratio: number): TakerFlowPoint[] => [
  { time: 1, buyVol: 1000 * ratio, sellVol: 1000, ratio },
];

const base = {
  funding: [] as FundingPoint[],
  openInterest: [] as OpenInterestPoint[],
  longShort: [] as RatioPoint[],
  takerFlow: [] as TakerFlowPoint[],
};

const find = (r: ReturnType<typeof readDerivatives>, id: string) =>
  r.signals.find((s) => s.id === id);

describe("annualisedFunding", () => {
  it("scales a per-interval rate to an annual percentage", () => {
    // 0.01% every 8h = 3x/day = 10.95% a year.
    expect(annualisedFunding(0.0001)).toBeCloseTo(10.95, 2);
  });

  it("keeps the sign", () => {
    expect(annualisedFunding(-0.0005)).toBeLessThan(0);
  });
});

describe("insufficient data", () => {
  it("says so rather than inventing a read", () => {
    const r = readDerivatives(base);
    expect(r.signals).toEqual([]);
    expect(r.insufficient).toMatch(/no derivatives data/);
  });

  it("reads whatever series ARE present", () => {
    const r = readDerivatives({ ...base, longShort: ls(0.5) });
    expect(r.insufficient).toBeNull();
    expect(r.signals).toHaveLength(1);
  });
});

describe("funding", () => {
  it("treats extreme funding as CROWDING, leaning against the paying side", () => {
    // Longs paying heavily is a squeeze risk against longs, not a forecast that
    // price falls. The direction is contrarian and the reason must say so.
    const hot = readDerivatives({ ...base, funding: funding(0.001) });
    const s = find(hot, "funding");
    expect(s?.direction).toBe("short");
    expect(s?.reason).toMatch(/crowded long/);
    expect(s?.reason).toMatch(/not a directional forecast/);
  });

  it("leans long when shorts are the ones paying", () => {
    expect(find(readDerivatives({ ...base, funding: funding(-0.001) }), "funding")?.direction).toBe(
      "long",
    );
  });

  it("stays neutral at ordinary funding rather than manufacturing a signal", () => {
    const s = find(readDerivatives({ ...base, funding: funding(0.00005) }), "funding");
    expect(s?.direction).toBe("neutral");
    expect(s?.reason).toMatch(/no meaningful crowding/);
  });

  it("reports both the raw rate and the annualised figure", () => {
    const s = find(readDerivatives({ ...base, funding: funding(0.0001) }), "funding");
    expect(s?.value).toMatch(/0\.0100%/);
    expect(s?.value).toMatch(/APR/);
  });
});

describe("open interest", () => {
  it("is directionless on its own and always states price alongside it", () => {
    const up = readDerivatives({ ...base, openInterest: oi(1e9, 1.3e9), priceChangePct: 5 });
    const down = readDerivatives({ ...base, openInterest: oi(1e9, 1.3e9), priceChangePct: -5 });

    expect(find(up, "open-interest")?.direction).toBe("long");
    expect(find(down, "open-interest")?.direction).toBe("short");
    expect(find(up, "open-interest")?.reason).toMatch(/price rose/);
    expect(find(down, "open-interest")?.reason).toMatch(/price fell/);
  });

  it("reads falling OI as exits, not as a directional signal", () => {
    const s = find(
      readDerivatives({ ...base, openInterest: oi(1.3e9, 1e9), priceChangePct: 5 }),
      "open-interest",
    );
    expect(s?.direction).toBe("neutral");
    expect(s?.reason).toMatch(/positions closing/);
  });

  it("stays neutral when OI barely moved", () => {
    const s = find(
      readDerivatives({ ...base, openInterest: oi(1e9, 1.005e9), priceChangePct: 3 }),
      "open-interest",
    );
    expect(s?.direction).toBe("neutral");
    expect(s?.reason).toMatch(/flat/);
  });

  it("names the squeeze risk that rising OI creates", () => {
    const s = find(
      readDerivatives({ ...base, openInterest: oi(1e9, 1.4e9), priceChangePct: 8 }),
      "open-interest",
    );
    expect(s?.reason).toMatch(/squeeze/);
  });
});

describe("positioning", () => {
  it("fades a lopsided crowd and says it is contrarian", () => {
    const crowded = find(readDerivatives({ ...base, longShort: ls(0.78) }), "positioning");
    expect(crowded?.direction).toBe("short");
    expect(crowded?.reason).toMatch(/contrarian/);
    // And it must not overclaim: crowds stay crowded.
    expect(crowded?.reason).toMatch(/can stay lopsided/);
  });

  it("fades a lopsided short crowd the other way", () => {
    expect(find(readDerivatives({ ...base, longShort: ls(0.22) }), "positioning")?.direction).toBe(
      "long",
    );
  });

  it("stays neutral on a balanced book", () => {
    const s = find(readDerivatives({ ...base, longShort: ls(0.51) }), "positioning");
    expect(s?.direction).toBe("neutral");
    expect(s?.reason).toMatch(/balanced/);
  });
});

describe("taker flow", () => {
  it("reads aggressive buying as long", () => {
    const s = find(readDerivatives({ ...base, takerFlow: taker(1.4) }), "taker-flow");
    expect(s?.direction).toBe("long");
    expect(s?.reason).toMatch(/lifting the book/);
  });

  it("reads aggressive selling as short", () => {
    expect(find(readDerivatives({ ...base, takerFlow: taker(0.6) }), "taker-flow")?.direction).toBe(
      "short",
    );
  });

  it("stays neutral when neither side is aggressive", () => {
    const s = find(readDerivatives({ ...base, takerFlow: taker(1.02) }), "taker-flow");
    expect(s?.direction).toBe("neutral");
  });
});

describe("the glass-box contract", () => {
  it("gives every signal a value and a real reason", () => {
    const r = readDerivatives({
      funding: funding(0.0008),
      openInterest: oi(1e9, 1.3e9),
      longShort: ls(0.71),
      takerFlow: taker(1.35),
      priceChangePct: 4,
    });
    expect(r.signals).toHaveLength(4);
    for (const s of r.signals) {
      expect(s.reason.trim().length).toBeGreaterThan(25);
      expect(s.value.trim().length).toBeGreaterThan(0);
      expect(s.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps signal ids unique", () => {
    const r = readDerivatives({
      funding: funding(0.0001),
      openInterest: oi(1e9, 1.1e9),
      longShort: ls(0.5),
      takerFlow: taker(1),
      priceChangePct: 1,
    });
    const ids = r.signals.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("formatting", () => {
  it("scales money to B/M/K", () => {
    expect(fmtUsd(8.4e9)).toBe("$8.40B");
    expect(fmtUsd(2.5e6)).toBe("$2.5M");
    expect(fmtUsd(4300)).toBe("$4K");
  });

  it("returns a dash for non-numbers instead of NaN", () => {
    expect(fmtUsd(NaN)).toBe("—");
    expect(fmtNum(Infinity)).toBe("—");
  });
});
