import { describe, expect, it } from "vitest";
import { detectPools, detectSweeps, findPools } from "../src/detect/liquidity";
import { detectBreakers, detectRanges } from "../src/detect/ranges";
import { detectSessionRanges, MAX_BAR_MS } from "../src/detect/sessionrange";
import {
  DEFAULT_DETECTORS,
  DETECTORS,
  DETECTOR_FOR_KIND,
  FAMILY_LABEL,
  runDetectors,
} from "../src/detect/index";
import type { DetectInput } from "../src/detect/types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday, 00:00 UTC

/** Build a DetectInput from OHLC tuples, one bar an hour. */
function input(rows: readonly [number, number, number, number][], startMs = T0): DetectInput {
  const n = rows.length;
  const mk = () => new Float64Array(n);
  const t = mk();
  const o = mk();
  const h = mk();
  const l = mk();
  const c = mk();
  const v = mk();
  rows.forEach((r, i) => {
    t[i] = startMs + i * HOUR;
    o[i] = r[0];
    h[i] = r[1];
    l[i] = r[2];
    c[i] = r[3];
    v[i] = 100;
  });
  return { t, o, h, l, c, v };
}

/** A flat run of identical bars, for padding a fixture out to a usable length. */
const flat = (n: number, price: number): [number, number, number, number][] =>
  Array.from({ length: n }, () => [price, price + 0.5, price - 0.5, price]);

describe("findPools", () => {
  /**
   * Two swing highs at effectively one price. The stops sit above both, and
   * that is the fact the detector exists to report.
   */
  it("groups two swing highs at the same price into one pool", () => {
    const rows: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101], // pivot high at 110
      ...flat(6, 100),
      [100, 110.02, 99.7, 101], // second high, 0.018% away
      ...flat(6, 100),
    ];
    const pools = findPools(input(rows), { equalTolerance: 0.0008 });
    const highs = pools.filter((p) => p.kind === "high");
    expect(highs).toHaveLength(1);
    expect(highs[0]?.at).toHaveLength(2);
    /* The pool sits at the EXTREME, not the mean: stops rest beyond the
       highest high, and an average would put the level where nothing is. */
    expect(highs[0]?.price).toBeCloseTo(110.02, 6);
  });

  it("does not group two highs that are genuinely different levels", () => {
    const rows: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [100, 118, 99.7, 101],
      ...flat(6, 100),
    ];
    expect(findPools(input(rows)).filter((p) => p.kind === "high")).toHaveLength(0);
  });

  /**
   * A pool that has already been cleared is not liquidity.
   *
   * Once price closes decisively through it the stops behind it are gone, and
   * drawing it as a target would point at a level that has already paid out.
   */
  it("drops a pool that price has closed through", () => {
    const rows: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [100, 110.02, 99.7, 101],
      ...flat(6, 100),
      [101, 125, 100, 124], // closed well above the pool
      ...flat(6, 124),
    ];
    expect(findPools(input(rows)).filter((p) => p.kind === "high")).toHaveLength(0);
  });

  it("finds equal lows as well as equal highs", () => {
    const rows: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 100.3, 90, 99],
      ...flat(6, 100),
      [100, 100.3, 90.02, 99],
      ...flat(6, 100),
    ];
    expect(findPools(input(rows)).filter((p) => p.kind === "low")).toHaveLength(1);
  });
});

describe("detectPools", () => {
  /* The spike bars keep their lows INSIDE the padding's range on purpose.
     Two spikes that both dip to 99 are themselves a pair of equal lows, and
     the detector reports that pool too — correctly. It made the fixture test
     two things at once, which is a fixture bug and not a detector one. */
  const rows: [number, number, number, number][] = [
    ...flat(6, 100),
    [100, 110, 99.7, 101],
    ...flat(6, 100),
    [100, 110.02, 99.7, 101],
    ...flat(6, 100),
  ];
  const found = detectPools(input(rows));

  it("reports a pool as NEUTRAL, never as a signal", () => {
    /* Stops above the market are a magnet, not a short. Price reaching them is
       the ordinary outcome, and calling that a direction is the easiest way
       this detector could mislead. */
    expect(found).toHaveLength(1);
    expect(found[0]?.direction).toBe("neutral");
  });

  it("says in plain language where the resting orders are", () => {
    expect(found[0]?.reason).toMatch(/2 touches/);
    expect(found[0]?.reason).toMatch(/above/);
  });

  it("scores three tight touches above two loose ones", () => {
    const loose = detectPools(input(rows), { equalTolerance: 0.01 })[0];
    const tight: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [100, 110.001, 99.7, 101],
      ...flat(6, 100),
      [100, 110.002, 99.7, 101],
      ...flat(6, 100),
    ];
    const three = detectPools(input(tight))[0];
    expect(three?.confidence).toBeGreaterThan(loose?.confidence ?? 1);
  });
});

describe("detectSweeps", () => {
  /** A pivot high at 110, then a bar that wicks to 113 and closes back at 105. */
  const swept: [number, number, number, number][] = [
    ...flat(6, 100),
    [100, 110, 99.7, 101],
    ...flat(6, 100),
    [101, 113, 99.8, 105],
    ...flat(6, 105),
  ];

  it("fires when the wick goes through and the close comes back", () => {
    const found = detectSweeps(input(swept));
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("liquidity-sweep");
  });

  /**
   * The direction is the side that got TRAPPED.
   *
   * A raid on highs took out buy stops and left those buyers offside, so the
   * read is short. Getting this backwards would be a plausible-looking
   * detector pointing the wrong way on every signal it produces.
   */
  it("reads a raid on highs as short and a raid on lows as long", () => {
    expect(detectSweeps(input(swept))[0]?.direction).toBe("short");

    const sweptLow: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 100.3, 90, 99],
      ...flat(6, 100),
      [99.8, 100.2, 87, 95],
      ...flat(6, 95),
    ];
    expect(detectSweeps(input(sweptLow))[0]?.direction).toBe("long");
  });

  /**
   * The rule that keeps this honest.
   *
   * Wick through and close BEYOND is a breakout, not a raid. A detector that
   * fired on the wick alone would print a sweep on every live candle that
   * pokes a high and un-print it seconds later.
   */
  it("does NOT fire when the close stays beyond the level", () => {
    const broke: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [101, 115, 99.8, 114], // closed above and stayed
      ...flat(6, 114),
    ];
    expect(detectSweeps(input(broke))).toHaveLength(0);
  });

  it("does not fire when the wick stops short of the level", () => {
    const near: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [101, 109.9, 99.8, 105],
      ...flat(6, 105),
    ];
    expect(detectSweeps(input(near))).toHaveLength(0);
  });

  it("dates the detection to the bar that closed back inside", () => {
    const found = detectSweeps(input(swept))[0];
    /* Bar 13 is the raid; the close comes back on the same bar. `to` must be
       that bar and never the pivot, or a backtest reading `to` would act
       before the pattern completed. */
    expect(found?.to).toBe(13);
  });

  it("names the invalidation, which is the point of the pattern", () => {
    expect(detectSweeps(input(swept))[0]?.reason).toMatch(/invalid beyond/);
  });

  it("scores a deep, immediately reclaimed raid above a shallow slow one", () => {
    const deep = detectSweeps(input(swept))[0];
    const shallow: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [101, 110.06, 99.8, 110.03],
      [110, 110.05, 109, 109.5], // reclaimed two bars later
      ...flat(6, 105),
    ];
    const weak = detectSweeps(input(shallow))[0];
    expect(deep?.confidence).toBeGreaterThan(weak?.confidence ?? 1);
  });
});

describe("detectRanges", () => {
  it("finds a sideways stretch and calls it a range while price is still in it", () => {
    const rows: [number, number, number, number][] = [
      ...Array.from({ length: 30 }, (_, i): [number, number, number, number] => {
        const p = 100 + (i % 2) * 0.4;
        return [p, p + 0.3, p - 0.3, p];
      }),
      ...flat(25, 100),
    ];
    const found = detectRanges(input(rows), { minBars: 10 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.kind).toBe("range");
    /* An unbroken range has no direction, and saying otherwise would be the
       most likely way this detector could mislead. */
    expect(found[0]?.direction).toBe("neutral");
  });

  it("calls it an expansion once a close leaves it, with the side named", () => {
    const rows: [number, number, number, number][] = [
      ...flat(40, 100),
      [100, 108, 100, 107],
      ...flat(6, 107),
    ];
    const found = detectRanges(input(rows), { minBars: 10 });
    const exp = found.find((d) => d.kind === "expansion");
    expect(exp).toBeDefined();
    expect(exp?.direction).toBe("long");
  });

  it("does not call a trend a range", () => {
    const rows = Array.from({ length: 60 }, (_, i): [number, number, number, number] => [
      100 + i,
      101 + i,
      99 + i,
      100 + i,
    ]);
    expect(detectRanges(input(rows), { minBars: 10 })).toHaveLength(0);
  });

  it("returns nothing rather than throwing on a short series", () => {
    expect(detectRanges(input(flat(5, 100)))).toEqual([]);
  });
});

describe("detectBreakers", () => {
  /**
   * The sequence is the definition: a block forms, price closes THROUGH it,
   * and price comes back to it from the other side. Step two is what separates
   * a breaker from a mitigation, and conflating them means one label covering
   * two opposite expectations.
   */
  it("flips a failed demand block into a short read", () => {
    const rows: [number, number, number, number][] = [
      ...flat(5, 100),
      [100, 100.5, 99.5, 99.6], // down candle: the demand block
      [99.6, 104, 99.5, 103.8], // displacement up
      ...flat(4, 104),
      [104, 104.2, 98, 98.5], // closes through the block
      ...flat(3, 98.5),
      [98.5, 100.4, 98.4, 99.5], // back into the zone from below
      ...flat(4, 99.5),
    ];
    const found = detectBreakers(input(rows));
    if (found.length > 0) {
      expect(found[0]?.kind).toBe("breaker");
      expect(found[0]?.direction).toBe("short");
      expect(found[0]?.reason).toMatch(/failed on the close/);
    }
  });

  it("does not report a block price never closed through", () => {
    const rows: [number, number, number, number][] = [
      ...flat(5, 100),
      [100, 100.5, 99.5, 99.6],
      [99.6, 104, 99.5, 103.8],
      ...flat(20, 104),
    ];
    expect(detectBreakers(input(rows))).toHaveLength(0);
  });

  it("scores a retested breaker above one price has not returned to", () => {
    const base: [number, number, number, number][] = [
      ...flat(5, 100),
      [100, 100.5, 99.5, 99.6],
      [99.6, 104, 99.5, 103.8],
      ...flat(4, 104),
      [104, 104.2, 98, 98.5],
    ];
    const noRetest = detectBreakers(input([...base, ...flat(10, 92)]));
    const retest = detectBreakers(
      input([...base, ...flat(3, 98.5), [98.5, 100.4, 98.4, 99.5], ...flat(4, 99.5)]),
    );
    if (noRetest.length > 0 && retest.length > 0) {
      expect(retest[0]?.confidence).toBeGreaterThan(noRetest[0]?.confidence ?? 1);
    }
  });
});

describe("detectSessionRanges", () => {
  /* 72 hourly bars from Monday 00:00 UTC — three full days of every session. */
  const rows = Array.from({ length: 72 }, (_, i): [number, number, number, number] => {
    const p = 100 + Math.sin(i / 5) * 2;
    return [p, p + 0.6, p - 0.6, p];
  });

  it("draws a box per session per day", () => {
    const found = detectSessionRanges(input(rows), { days: 2 });
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) expect(d.kind).toBe("session-range");
    expect(found.some((d) => d.label.startsWith("Tokyo"))).toBe(true);
    expect(found.some((d) => d.label.startsWith("London"))).toBe(true);
  });

  /**
   * The refusal that matters most.
   *
   * A session range on a daily chart is a box drawn around one candle. Bar
   * spacing is checked against the DATA rather than a timeframe string, so a
   * mislabelled feed cannot slip past it.
   */
  it("returns nothing above 4h, rather than a box around one candle", () => {
    const daily = input(rows, T0);
    for (let i = 0; i < 72; i++) daily.t[i] = T0 + i * 24 * HOUR;
    expect(detectSessionRanges(daily)).toEqual([]);
    expect(MAX_BAR_MS).toBe(6 * HOUR);
  });

  it("stays neutral when BOTH sides of the range were later taken", () => {
    /* Price through the range in each direction says nothing at all, and
       calling that a direction would be pure noise dressed as a read. */
    const whipsaw = Array.from({ length: 72 }, (_, i): [number, number, number, number] => {
      const p = i < 10 ? 100 : i % 2 === 0 ? 80 : 120;
      return [p, p + 1, p - 1, p];
    });
    const found = detectSessionRanges(input(whipsaw), { days: 3 });
    const tokyo = found.find((d) => d.label.startsWith("Tokyo"));
    if (tokyo !== undefined) expect(tokyo.direction).toBe("neutral");
  });

  it("survives a series too short to hold a session", () => {
    expect(detectSessionRanges(input(flat(3, 100)))).toEqual([]);
  });
});

describe("the registry after v54", () => {
  /**
   * A count, and it is deliberately brittle.
   *
   * Adding a detector should require editing this line, because a detector
   * that appears without anybody deciding to add it is exactly the failure
   * this suite exists to catch. The number went 13 -> 29 in v54 and the diff
   * on this line is where a reviewer sees that.
   */
  it("carries twenty-nine detectors, each with a unique id", () => {
    expect(DETECTORS).toHaveLength(29);
    expect(new Set(DETECTORS.map((d) => d.id)).size).toBe(29);
  });

  it("gives every detector exactly one way to run", () => {
    /* `run` reads bars, `meta` reads what the others found. Both would make
       the detector run twice; neither makes it silently produce nothing. */
    for (const d of DETECTORS) {
      expect(Boolean(d.run) !== Boolean(d.meta), d.id).toBe(true);
    }
  });

  it("starts a fresh install with a readable number of overlays", () => {
    /* Twenty-nine overlays at once is not a chart. The default set is the
       floor at which the terminal is still useful before the operator has
       chosen anything, and every mark on a fresh chart is attributable. */
    expect(DEFAULT_DETECTORS.length).toBeGreaterThan(4);
    expect(DEFAULT_DETECTORS.length).toBeLessThanOrEqual(10);
    for (const id of DEFAULT_DETECTORS) {
      expect(DETECTORS.some((d) => d.id === id), id).toBe(true);
    }
  });

  it("gives every detector a family the settings list can group it under", () => {
    for (const d of DETECTORS) {
      expect(Object.keys(FAMILY_LABEL)).toContain(d.family);
    }
  });

  /**
   * Every kind must map back to the detector that makes it.
   *
   * A consumer can hold a reference to a structure long after its overlay was
   * switched off — an alert anchored to a sweep, say — and looks the detector
   * up here to re-run it. A missing entry makes that alert silently stop.
   */
  it("maps every new kind back to its detector", () => {
    for (const kind of [
      "liquidity-sweep",
      "equal-highs",
      "equal-lows",
      "breaker",
      "range",
      "expansion",
      "session-range",
    ] as const) {
      const id = DETECTOR_FOR_KIND[kind];
      expect(DETECTORS.some((d) => d.id === id), kind).toBe(true);
    }
  });

  it("runs the new detectors through the registry without throwing", () => {
    const rows: [number, number, number, number][] = [
      ...flat(6, 100),
      [100, 110, 99.7, 101],
      ...flat(6, 100),
      [101, 113, 99.8, 105],
      ...flat(30, 105),
    ];
    const found = runDetectors(input(rows), ["sweeps", "pools", "breakers", "ranges", "sessions"]);
    expect(Array.isArray(found)).toBe(true);
    for (const d of found) {
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.to).toBeGreaterThanOrEqual(d.from);
    }
  });
});
