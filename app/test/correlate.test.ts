/**
 * THE CROSS-ASSET WEB — `data/correlation.ts` (the measurement) and
 * `backtest/correlate.ts` (the picture).
 *
 * CLAUDE.md states the rule this has to obey: "MEASURE THE CORRELATION, NEVER
 * ENCODE IT. `-0.72` is a point estimate with no window. BTC/DXY rolling
 * correlation has swung from strongly negative to mildly positive. The card
 * shows the rolling figure, its window and its instability — or it shows
 * nothing."
 *
 * THE MEASUREMENT STAYED WHERE IT ALREADY LIVED. `data/correlation.ts` has
 * answered "how much do two markets move together" for the Risk desk since the
 * heat understatement was added, and this repository already carries THREE
 * implementations of that one fact — that module, `data/context.ts` for the
 * screener's scan, and `study/stats.ts pearsonAt` for the lag-capable version.
 * A fourth for a drawing would be the "one fact, two owners" defect committed
 * deliberately. So the web extended the owner rather than copying it, and the
 * stability check below now reaches the Risk desk too, which is where a
 * correlation that quietly reversed is most expensive.
 *
 * THE TEST THAT MATTERS IS `a pair that flips sign is reported UNSTABLE, not
 * uncorrelated`. A full-window correlation of a pair that was +0.9 for a year
 * and -0.9 for the next is about zero — which draws as "these two have nothing
 * to do with each other", the exact opposite of the truth, with nothing in the
 * number to say so.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_OVERLAP,
  UNSTABLE_ABOVE,
  correlate,
  rollingCorrelation,
  utcDay,
  type ClosesSeries,
} from "../src/data/correlation";
import {
  EDGE_FLOOR,
  correlationGraph,
  type SeriesBars,
} from "../src/backtest/correlate";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** Daily bars from a list of closes, one per calendar day. */
const daily = (closes: readonly number[], from = T0) =>
  closes.map((c, i) => ({ t: from + i * DAY, c }));

const series = (symbol: string, closes: readonly { t: number; c: number }[]): ClosesSeries => ({
  symbol,
  closes,
});

/** A deterministic pseudo-random walk, so a test never flickers. */
function walk(n: number, seed: number, drift = 0): number[] {
  let s = seed;
  let v = 100;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v *= 1 + (s / 2147483648 - 0.5) * 0.02 + drift;
    out.push(v);
  }
  return out;
}

const pair = (a: readonly { t: number; c: number }[], b: readonly { t: number; c: number }[]) =>
  correlate(series("A", a), series("B", b), { bucket: utcDay });

describe("it measures the right quantity", () => {
  it("CORRELATES RETURNS, NEVER LEVELS", () => {
    /* Two INDEPENDENT series that both trend upward correlate near +1 on price
       and near 0 on returns. A web built on levels would draw every market as
       strongly related to every other one, permanently, and look authoritative
       doing it. */
    const a = daily(walk(400, 11, 0.0015));
    const b = daily(walk(400, 99, 0.0015));
    const got = pair(a, b);

    expect(Math.abs(got.r), `returns correlation was ${got.r}`).toBeLessThan(0.3);

    // And prove the trap is real, so the assertion above is not vacuous: the
    // same two series on LEVELS are strongly "correlated".
    const xs = a.map((x) => x.c);
    const ys = b.map((x) => x.c);
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i += 1) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      dx += (xs[i]! - mx) ** 2;
      dy += (ys[i]! - my) ** 2;
    }
    expect(num / Math.sqrt(dx * dy)).toBeGreaterThan(0.8);
  });

  it("finds a real inverse relationship when there is one", () => {
    /* A TRUE MIRROR COMPOUNDS THE NEGATED RETURN. Rebasing to 100 every step
       gives a series whose returns are only approximately inverted and comes
       back around -0.70; the first version of this fixture did that, and a
       looser assertion would have hidden it. */
    const base = walk(300, 5);
    let m = 100;
    const mirror = base.map((v, i) => {
      if (i > 0) m *= 1 - (v / base[i - 1]! - 1);
      return m;
    });
    expect(pair(daily(base), daily(mirror)).r).toBeLessThan(-0.95);
  });
});

describe("the join", () => {
  it("DOES NOT INVENT A ZERO RETURN FROM A MISSING DAY", () => {
    /* A gap carried forward has a return of exactly zero. Those zeros drag every
       correlation toward zero AND inflate the sample, so the figure looks both
       weaker and better-evidenced than it is. Only days BOTH series really
       traded may contribute. */
    const closes = walk(200, 21);
    const a = daily(closes);
    const b = daily(closes).filter((_, i) => i % 7 !== 0); // a market closed one day in seven

    const got = pair(a, b);
    expect(got.overlap).toBeLessThan(a.length);
    expect(got.overlap).toBeGreaterThan(a.length * 0.6);
    // Identical closes on the days they share, so the survivors correlate.
    expect(got.r).toBeGreaterThan(0.9);
  });

  it("JOINS ON THE UTC DAY, so two vendors stamping differently still meet", () => {
    /* yfinance stamps a daily bar at midnight and a broker at the session open.
       An exact-timestamp join reports ZERO overlap for two series covering the
       same days — which reads as "no data" on a pair that is fully covered. */
    const closes = walk(120, 33);
    const a = daily(closes);
    const b = closes.map((c, i) => ({ t: T0 + i * DAY + 9 * 3_600_000, c }));

    expect(pair(a, b).overlap).toBeGreaterThan(100);
    // The default exact join is unchanged for the callers that rely on it.
    expect(correlate(series("A", a), series("B", b)).overlap).toBe(0);
  });

  it("counts one pair per day, so a bucketed join cannot inflate the sample", () => {
    // Several bars landing on one key would count that day repeatedly: the
    // sample grows while the coefficient is computed on a duplicated point.
    const closes = walk(60, 44);
    const twicePerDay = closes.flatMap((c, i) => [
      { t: T0 + i * DAY, c },
      { t: T0 + i * DAY + 3_600_000, c: c * 1.001 },
    ]);
    const got = correlate(series("A", twicePerDay), series("B", daily(closes)), { bucket: utcDay });
    expect(got.overlap).toBeLessThanOrEqual(closes.length);
  });
});

describe("a figure with no window is not a figure", () => {
  it("A PAIR THAT FLIPS SIGN IS REPORTED UNSTABLE, NOT UNCORRELATED", () => {
    /* THE ONE THAT MATTERS. +0.9 for the first half and -0.9 for the second
       averages to about zero over the whole window, which draws as "unrelated" —
       the opposite of the truth, and indistinguishable from it by the number
       alone. BTC against the dollar has actually done this. */
    const base = walk(400, 77);
    let m = 100;
    const mirrorThenFollow = base.map((v, i) => {
      if (i > 0) {
        const r = v / base[i - 1]! - 1;
        m *= 1 + (i < 200 ? -r : r);
      }
      return m;
    });
    const got = pair(daily(base), daily(mirrorThenFollow));

    expect(Math.abs(got.r), "the whole-window figure should look like nothing").toBeLessThan(0.3);
    expect(got.stable, "but it must not be REPORTED as a settled nothing").toBe(false);
    expect(got.instability).toBeGreaterThan(UNSTABLE_ABOVE);
  });

  it("a genuinely steady pair is reported stable", () => {
    // The flag has to be able to say yes, or it is not a measurement.
    const base = walk(400, 8);
    const got = pair(daily(base), daily(base));
    expect(got.stable).toBe(true);
    expect(got.instability).toBeLessThan(0.2);
  });

  it("UNKNOWN IS NOT STABLE — too short to slice is not a settled answer", () => {
    // Answering "steady" from the least evidence would be the strongest claim
    // made on the weakest basis.
    const short = walk(MIN_OVERLAP + 5, 12);
    const got = pair(daily(short), daily(short));
    expect(Number.isNaN(got.instability)).toBe(true);
    expect(got.stable).toBe(false);
  });
});

describe("it refuses rather than approximating", () => {
  it("reports no r at all below the overlap floor", () => {
    const a = daily(walk(300, 1));
    const b = daily(walk(300, 2), T0 + 290 * DAY);
    const got = pair(a, b);
    expect(got.overlap).toBeLessThan(MIN_OVERLAP);
    expect(Number.isNaN(got.r)).toBe(true);
  });

  it("a flat series has no variance, and says NaN rather than zero", () => {
    // Zero would read as "measured, and unrelated", which is a claim.
    const got = pair(daily(new Array(200).fill(100)), daily(walk(200, 6)));
    expect(Number.isNaN(got.r)).toBe(true);
  });

  it("survives bars out of order and closes that are not numbers", () => {
    const messy = [
      { t: T0 + 2 * DAY, c: 102 },
      { t: T0, c: 100 },
      { t: T0 + DAY, c: Number.NaN },
      { t: T0 + 3 * DAY, c: 103 },
    ];
    expect(() => pair(messy, daily(walk(4, 9)))).not.toThrow();
  });
});

describe("the graph it hands the renderer", () => {
  const bars: SeriesBars = {
    BTCUSDT: daily(walk(400, 11)),
    ETHUSDT: daily(walk(400, 12)),
    XAUUSD: daily(walk(400, 13)),
    DXY: daily(walk(400, 14)),
    VIX: daily(walk(400, 15)),
  };

  it("makes one node per series and never a self-edge", () => {
    const g = correlationGraph(bars);
    expect(g.nodes).toHaveLength(5);
    expect(g.edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it("DRAWS NOTHING BELOW THE FLOOR, because a line reads as a fact", () => {
    /* A web with an edge between every pair is a picture of nothing. Anything
       under the floor is left out — and COUNTED, so "these markets are
       unrelated" is visible as a finding rather than as an empty card. */
    const g = correlationGraph(bars);
    for (const e of g.edges) expect(Math.abs(e.value)).toBeGreaterThanOrEqual(EDGE_FLOOR);
    expect(g.belowFloor + g.edges.length + g.refused.length).toBe((5 * 4) / 2);
  });

  it("names every pair it could not measure, rather than dropping it", () => {
    // A silently missing edge is indistinguishable from a measured absence.
    const g = correlationGraph({ ...bars, NEW: daily(walk(10, 16)) });
    expect(g.refused.length).toBeGreaterThan(0);
    expect(g.refused.some((r) => r.pair.includes("NEW"))).toBe(true);
    expect(g.refused[0]!.why.length).toBeGreaterThan(20);
  });

  it("carries the instability onto the edge, so the renderer can show it", () => {
    const g = correlationGraph(bars);
    for (const e of g.edges) {
      expect(typeof e.stable).toBe("boolean");
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("AN UNSTABLE EDGE IS TRUSTED LESS BY THE LAYOUT, not just by the paint", () => {
    /* Confidence feeds the spring strength. Without it a strong figure that
       reversed halfway would pull its two nodes together exactly as hard as a
       steady one, so the PICTURE would place them as firm neighbours on evidence
       that says otherwise — and position is the first thing anyone reads. */
    const base = walk(400, 77);
    let m = 100;
    const flip = base.map((v, i) => {
      if (i > 0) {
        const r = v / base[i - 1]! - 1;
        m *= 1 + (i < 200 ? -r : r);
      }
      return m;
    });
    const g = correlationGraph({ A: daily(base), B: daily(base), C: daily(flip) });
    const steady = g.edges.find((e) => e.from === "A" && e.to === "B");
    expect(steady?.confidence).toBe(1);
    for (const e of g.edges) if (!e.stable) expect(e.confidence).toBeLessThan(1);
  });

  it("weights every node into the range the layout expects", () => {
    // The two modules have to agree, or the card refuses at runtime — the worst
    // place to find a shape mismatch.
    const g = correlationGraph(bars);
    expect(g.nodes.every((n) => n.weight >= 0 && n.weight <= 1)).toBe(true);
    expect(g.nodes.every((n) => typeof n.id === "string" && n.id.length > 0)).toBe(true);
  });

  it("an empty archive is an empty graph, not a throw", () => {
    const g = correlationGraph({});
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});

describe("how the correlation moved, window by window", () => {
  /* `stable` says THAT a pair reversed; this says WHEN, which is the difference
     between a caveat and something an operator can act on. */

  const base = walk(500, 77);
  let m = 100;
  const flips = base.map((v, i) => {
    if (i > 0) {
      const r = v / base[i - 1]! - 1;
      m *= 1 + (i < 250 ? -r : r);
    }
    return m;
  });

  it("SHOWS THE REVERSAL AS A CROSSING, not as an average of nothing", () => {
    /* The whole-window figure for this pair is about zero. The rolling one must
       start strongly negative and end strongly positive, which is the fact the
       single number destroys. */
    const pts = rollingCorrelation(series("A", daily(base)), series("B", daily(flips)), {
      bucket: utcDay,
      window: 90,
    });
    expect(pts.length).toBeGreaterThan(5);
    expect(pts[0]!.r).toBeLessThan(-0.5);
    expect(pts[pts.length - 1]!.r).toBeGreaterThan(0.5);
  });

  it("A POINT IS STAMPED AT THE END OF ITS WINDOW, never the middle", () => {
    /* A correlation computed from bars up to Friday is a fact you possess on
       Friday. Drawing it at Wednesday puts knowledge earlier on the axis than it
       existed — look-ahead in a picture, and just as invisible as reading a
       daily bar's close during its own day. */
    const win = 90;
    const pts = rollingCorrelation(series("A", daily(base)), series("B", daily(base)), {
      bucket: utcDay,
      window: win,
    });
    const firstDay = utcDay(T0);
    // The earliest knowable point sits at least `win` days after the first bar.
    expect(pts[0]!.t - firstDay).toBeGreaterThanOrEqual(win);
  });

  it("refuses a window shorter than the overlap floor rather than shrinking it", () => {
    // A 10-bar correlation drawn as a line is noise with a shape.
    const short = rollingCorrelation(series("A", daily(walk(40, 1))), series("B", daily(walk(40, 2))), {
      bucket: utcDay,
      window: 10,
    });
    expect(short).toHaveLength(0);
  });

  it("bounds how many points it returns, whatever the history", () => {
    // A 40px sparkline cannot show 3,000 of them, and computing them to throw
    // them away is work nobody sees.
    const many = rollingCorrelation(series("A", daily(walk(3000, 3))), series("B", daily(walk(3000, 4))), {
      bucket: utcDay,
      window: 90,
      points: 50,
    });
    expect(many.length).toBeLessThanOrEqual(60);
    expect(many.length).toBeGreaterThan(10);
  });

  it("is ascending in time, so a line drawn through it cannot zigzag", () => {
    const pts = rollingCorrelation(series("A", daily(base)), series("B", daily(flips)), {
      bucket: utcDay,
      window: 90,
    });
    for (let i = 1; i < pts.length; i += 1) expect(pts[i]!.t).toBeGreaterThanOrEqual(pts[i - 1]!.t);
  });

  it("an empty pair is an empty line, not a throw", () => {
    expect(rollingCorrelation(series("A", []), series("B", []))).toHaveLength(0);
  });
});
