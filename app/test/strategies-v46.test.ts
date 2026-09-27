import { describe, it, expect } from "vitest";
import {
  rollingPercentile,
  squeezeBreakout,
  donchianBreakout,
  regimeGatedReversion,
  candidateGrid,
} from "../src/backtest/strategies";
import type { StrategyContext } from "../src/backtest/engine";

/* ------------------------------------------------------------------ setup */

interface Spec {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function ctxOf(specs: readonly Spec[]): StrategyContext {
  const n = specs.length;
  const col = (pick: (s: Spec) => number): Float64Array => {
    const a = new Float64Array(n);
    specs.forEach((s, i) => (a[i] = pick(s)));
    return a;
  };
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) time[i] = i * 3_600_000;
  const open = col((s) => s.o);
  const high = col((s) => s.h);
  const low = col((s) => s.l);
  const close = col((s) => s.c);
  const volume = col((s) => s.v);
  return {
    bars: specs.map((s, i) => ({ t: (time[i] as number), o: s.o, h: s.h, l: s.l, c: s.c, v: s.v })),
    open,
    high,
    low,
    close,
    volume,
    time,
  } as StrategyContext;
}

/** Truncate a context to bars 0..i, so a strategy cannot see past `i`. */
function truncate(ctx: StrategyContext, i: number): StrategyContext {
  return {
    bars: ctx.bars.slice(0, i + 1),
    open: ctx.open.slice(0, i + 1),
    high: ctx.high.slice(0, i + 1),
    low: ctx.low.slice(0, i + 1),
    close: ctx.close.slice(0, i + 1),
    volume: ctx.volume.slice(0, i + 1),
    time: ctx.time.slice(0, i + 1),
  } as StrategyContext;
}

/** A deterministic series with a controllable per-bar range and drift. */
function walkSpecs(n: number, opts: { range?: (i: number) => number; drift?: (i: number) => number } = {}): Spec[] {
  const range = opts.range ?? (() => 2);
  const drift = opts.drift ?? (() => 0);
  const out: Spec[] = [];
  let px = 100;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const u = seed / 0xffffffff - 0.5;
    const r = range(i);
    const o = px;
    px = px + drift(i) + u * r;
    out.push({ o, h: Math.max(o, px) + r / 3, l: Math.min(o, px) - r / 3, c: px, v: 1000 });
  }
  return out;
}

/* ---------------------------------------------------------------- helpers */

describe("rollingPercentile", () => {
  it("leaves the warm-up window unranked rather than ranking against nothing", () => {
    const p = rollingPercentile(Float64Array.from([1, 2, 3, 4, 5]), 3);
    expect(Number.isNaN(p[0] as number)).toBe(true);
    expect(Number.isNaN(p[2] as number)).toBe(true);
    expect(p[3]).toBe(1);
  });

  /* Must match analysis/leading.ts exactly, or the backtest is testing a
     different rule from the one the desk displays. */
  it("counts ties as half, like the desk does", () => {
    const p = rollingPercentile(Float64Array.from([5, 5, 5, 5, 5, 5]), 3);
    expect(p[5]).toBe(0.5);
  });

  it("ranks only against the trailing window, not the whole series", () => {
    /* At index 5 the window is [9, 9, 9] and the value is 1 → bottom. */
    const p = rollingPercentile(Float64Array.from([1, 1, 9, 9, 9, 1]), 3);
    expect(p[5]).toBe(0);
  });
});

/* ------------------------------------------------------------ look-ahead */

describe("no strategy in the grid can see the future", () => {
  /* The single most valuable test in this file. A backtest that indexes past
     bar i produces a beautiful curve and no edge, and the mistake is invisible
     in the result — it only shows up as live performance that never arrives.

     Every candidate is evaluated twice at the same bar: once with the whole
     series present, once with everything after that bar physically removed. A
     strategy that reads ahead disagrees with itself. */
  const specs = walkSpecs(600, { range: (i) => (i % 97 < 20 ? 0.4 : 3), drift: (i) => (i > 300 ? 0.08 : -0.05) });
  const full = ctxOf(specs);

  for (const strat of candidateGrid()) {
    it(strat.id, () => {
      let compared = 0;
      for (let i = strat.warmup; i < specs.length; i += 7) {
        const a = strat.entry(full, i);
        const b = strat.entry(truncate(full, i), i);
        expect(
          a === null ? null : { direction: a.direction, stop: a.stop.toPrecision(10) },
          `${strat.id} disagreed with itself at bar ${i}`,
        ).toEqual(b === null ? null : { direction: b.direction, stop: b.stop.toPrecision(10) });
        compared++;
      }
      /* Guard against a vacuous pass: if warm-up swallowed the series there was
         nothing to compare and the test proved nothing. */
      expect(compared).toBeGreaterThan(10);
    });
  }
});

/* ----------------------------------------------------------- squeeze --- */

describe("squeezeBreakout", () => {
  const strat = squeezeBreakout(20, 60, 0.2, 1.5, 2);

  /* Written expecting zero entries on a permanently wide market, and it found
     nine. That is CORRECT and is a property of any percentile threshold: the
     tightest 20% of a series is 20% of it however violent the series is. The
     squeeze condition therefore cannot be selective on its own — the
     selectivity comes entirely from requiring a close outside the band on top
     of it, and the module comments now say so. */
  it("is not made selective by the squeeze condition alone", () => {
    const ctx = ctxOf(walkSpecs(400, { range: () => 4 }));
    let entries = 0;
    for (let i = strat.warmup; i < 400; i++) if (strat.entry(ctx, i)) entries++;
    expect(entries).toBeGreaterThan(0);
    /* But the break requirement still keeps it rare. */
    expect(entries / (400 - strat.warmup)).toBeLessThan(0.05);
  });

  /**
   * Wide, then quiet for TWENTY bars, then a push.
   *
   * Twenty and not eighty, and the difference is the whole lesson. The
   * bandwidth percentile ranks against the last 60 bars, so a contraction that
   * lasts longer than that window becomes its own reference and stops reading
   * as a contraction at all. A quiet stretch has to be quiet RELATIVE TO
   * SOMETHING still inside the window to register.
   */
  const contraction = (sign: 1 | -1): Spec[] => {
    const specs = walkSpecs(300, { range: (i) => (i < 240 ? 4 : i < 260 ? 0.12 : 4) });
    for (let i = 260; i < 300; i++) {
      const prev = specs[i - 1] as Spec;
      const c = prev.c + 3 * sign;
      specs[i] =
        sign > 0
          ? { o: prev.c, h: c + 0.5, l: prev.c - 0.2, c, v: 1000 }
          : { o: prev.c, h: prev.c + 0.2, l: c - 0.5, c, v: 1000 };
    }
    return specs;
  };

  const firstFrom = (specs: readonly Spec[], from: number) => {
    const ctx = ctxOf(specs);
    for (let i = from; i < specs.length; i++) {
      const e = strat.entry(ctx, i);
      if (e) return e;
    }
    return null;
  };

  it("fires on the break out of a genuine contraction", () => {
    const fired = firstFrom(contraction(1), 259);
    expect(fired).not.toBeNull();
    expect(fired?.direction).toBe("long");
    expect(fired?.reason).toContain("percentile");
  });

  /* The limitation, pinned so it cannot be forgotten. A coil that outlasts the
     ranking window is invisible to this rule — which is a real property of the
     desk reading too, and the reason `rank` is a parameter rather than a
     constant. */
  it("stops seeing a contraction that has outlasted its own ranking window", () => {
    const specs = walkSpecs(300, { range: (i) => (i < 200 ? 4 : i < 280 ? 0.12 : 4) });
    for (let i = 280; i < 300; i++) {
      const prev = specs[i - 1] as Spec;
      const c = prev.c + 3;
      specs[i] = { o: prev.c, h: c + 0.5, l: prev.c - 0.2, c, v: 1000 };
    }
    expect(firstFrom(specs, 279)).toBeNull();
  });

  /* The design decision the module comment is about: the strategy supplies the
     timing and the market supplies the direction. */
  it("takes a downside break out of the same squeeze", () => {
    expect(firstFrom(contraction(-1), 259)?.direction).toBe("short");
  });

  it("puts the stop below the price on a long break, by a real distance", () => {
    const specs = contraction(1);
    const ctx = ctxOf(specs);
    for (let i = 259; i < 300; i++) {
      const e = strat.entry(ctx, i);
      if (!e) continue;
      const price = ctx.close[i] as number;
      expect(e.stop).toBeLessThan(price);
      expect(price - e.stop).toBeGreaterThan(0);
      return;
    }
    throw new Error("no entry was produced, so the assertion never ran");
  });

  it("documents its own rules", () => {
    expect(strat.rules.entry).toContain("bandwidth");
    expect(strat.rules.stop).toContain("ATR");
  });
});

/* ---------------------------------------------------------- donchian --- */

describe("donchianBreakout", () => {
  const strat = donchianBreakout(20, 10, 2);

  it("measures the channel over the PREVIOUS bars, so a new high can break it", () => {
    /* A monotone ramp: every bar sets a new high. If the channel included bar
       i, price could never exceed it and nothing would ever fire. */
    const specs = walkSpecs(200, { range: () => 0.5, drift: () => 1 });
    const ctx = ctxOf(specs);
    let entries = 0;
    for (let i = strat.warmup; i < 200; i++) if (strat.entry(ctx, i)) entries++;
    expect(entries).toBeGreaterThan(0);
  });

  it("goes short on a break of the lower channel", () => {
    const specs = walkSpecs(200, { range: () => 0.5, drift: () => -1 });
    const ctx = ctxOf(specs);
    let dir: string | null = null;
    for (let i = strat.warmup; i < 200 && !dir; i++) dir = strat.entry(ctx, i)?.direction ?? null;
    expect(dir).toBe("short");
  });

  /* A trend system that caps its winners throws away the tail that is the whole
     reason to follow trends. */
  it("sets no fixed target", () => {
    const specs = walkSpecs(200, { range: () => 0.5, drift: () => 1 });
    const ctx = ctxOf(specs);
    for (let i = strat.warmup; i < 200; i++) {
      const e = strat.entry(ctx, i);
      if (e) {
        expect(e.target).toBeUndefined();
        return;
      }
    }
    throw new Error("no entry was produced, so the assertion never ran");
  });

  it("exits a long when price closes back through the exit channel", () => {
    const specs = walkSpecs(200, { range: () => 0.5, drift: (i) => (i < 150 ? 1 : -3) });
    const ctx = ctxOf(specs);
    const position = { direction: "long" as const, entryIndex: 100, entryPrice: 100, stop: 90, target: null, reason: "" };
    let exited: string | null = null;
    for (let i = 160; i < 200 && !exited; i++) exited = strat.exit?.(ctx, position, i) ?? null;
    expect(exited).toContain("below");
  });
});

/* ------------------------------------------------------ regime-gated --- */

describe("regimeGatedReversion", () => {
  /* A staircase: thirty bars up, ten back. Measured on this fixture, ADX runs
     39 to 100 and RSI spans 44.8 to 100, so there ARE crossings of the 70 line
     for the rule to act on — the gate is the only thing that can stop them. */
  const staircase = () => walkSpecs(500, { range: () => 1.5, drift: (i) => (i % 40 < 30 ? 1.2 : -1) });

  it("refuses to trade while ADX says there is a trend", () => {
    const strat = regimeGatedReversion(14, 30, 70, 15, 2, 1.5);
    const ctx = ctxOf(staircase());
    let entries = 0;
    for (let i = strat.warmup; i < 500; i++) if (strat.entry(ctx, i)) entries++;
    expect(entries).toBe(0);
  });

  it("takes the same setups once the gate is opened", () => {
    /* Identical data, identical RSI rule, only the ADX ceiling changes. If the
       gate is what blocked the trades above, raising it must let them through —
       otherwise the previous test was passing because the fixture produced no
       crossings at all, which would prove nothing about the gate. */
    const open = regimeGatedReversion(14, 30, 70, 100, 2, 1.5);
    const ctx = ctxOf(staircase());
    let entries = 0;
    for (let i = open.warmup; i < 500; i++) if (open.entry(ctx, i)) entries++;
    expect(entries).toBeGreaterThan(0);
  });

  it("names the ADX reading in the reason, so the gate is visible on the trade", () => {
    const strat = regimeGatedReversion(14, 30, 70, 100, 2, 1.5);
    const ctx = ctxOf(staircase());
    for (let i = strat.warmup; i < 500; i++) {
      const e = strat.entry(ctx, i);
      if (e) {
        expect(e.reason).toContain("ADX");
        return;
      }
    }
    throw new Error("no entry was produced, so the assertion never ran");
  });
});

describe("the candidate grid", () => {
  it("carries the v46 systems", () => {
    const ids = candidateGrid().map((s) => s.id);
    expect(ids.some((id) => id.startsWith("squeeze-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("donchian-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("regrev-"))).toBe(true);
  });

  it("has no duplicate ids, which would silently collapse two candidates into one", () => {
    const ids = candidateGrid().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* Every extra candidate inflates the probability of backtest overfitting
     that validate.ts measures. The grid is allowed to grow, but not quietly. */
  it("stays small enough that the overfitting estimate means something", () => {
    expect(candidateGrid().length).toBeLessThanOrEqual(24);
  });

  it("documents every candidate", () => {
    for (const s of candidateGrid()) {
      expect(s.rules.entry.length, s.id).toBeGreaterThan(10);
      expect(s.rules.stop.length, s.id).toBeGreaterThan(5);
      expect(s.rules.exit.length, s.id).toBeGreaterThan(5);
    }
  });
});
