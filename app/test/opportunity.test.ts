import { describe, it, expect } from "vitest";
import {
  closedBars,
  compareOpportunities,
  findOpportunity,
  newSince,
  MIN_OPPORTUNITY_BARS,
  type Opportunity,
  type OpportunityContext,
} from "../src/scan/opportunity";
import { scanUniverse, type ScanDeps, type ScanRow } from "../src/scan/scanner";
import { rankByOpportunity } from "../src/ui/screener";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/** A deterministic series with trend legs, pullbacks and noise, so detectors find structure. */
function series(n: number, seed = 7): BarView[] {
  let s = seed;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 23) * 0.6 + Math.sin(i / 71) * 0.4;
    const o = p;
    const c = o + drift + (rand() - 0.5) * 1.8;
    const h = Math.max(o, c) + rand() * 0.9;
    const l = Math.min(o, c) - rand() * 0.9;
    out.push({ t: i * HOUR, o, h, l, c, v: 1000 + rand() * 500 });
    p = c;
  }
  return out;
}

const ctx = (bars: readonly BarView[], extra: Partial<OpportunityContext> = {}): OpportunityContext => ({
  intervalMs: HOUR,
  bias: "long",
  conviction: 0.6,
  minStopAtr: 0.5,
  maxStopAtr: 3,
  // One hour after the last bar opened: that bar has closed.
  now: (bars[bars.length - 1]?.t ?? 0) + HOUR,
  ...extra,
});

describe("closedBars", () => {
  it("drops a last bar whose interval has not finished", () => {
    const bars = series(5);
    const lastOpen = (bars[4] as BarView).t;
    expect(closedBars(bars, HOUR, lastOpen + HOUR - 1)).toHaveLength(4);
  });

  it("keeps a last bar that has closed", () => {
    const bars = series(5);
    expect(closedBars(bars, HOUR, (bars[4] as BarView).t + HOUR)).toHaveLength(5);
  });
});

describe("findOpportunity", () => {
  it("refuses a short series, and says how many closed bars it had", () => {
    const bars = series(50);
    const read = findOpportunity(bars, ctx(bars));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("50 closed bars");
    expect(MIN_OPPORTUNITY_BARS).toBe(120);
  });

  it("does not count the forming bar towards the minimum", () => {
    const bars = series(120);
    const forming = findOpportunity(bars, ctx(bars, { now: (bars[119] as BarView).t + 1 }));
    expect(forming.ok).toBe(false);
    if (!forming.ok) expect(forming.reason).toContain("119 closed bars");
  });

  it("either refuses with a reason, or returns a plan whose geometry is coherent", () => {
    let plans = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const bars = series(600, seed);
      for (const bias of ["long", "short"] as const) {
        const read = findOpportunity(bars, ctx(bars, { bias }));
        if (!read.ok) {
          expect(read.reason.length).toBeGreaterThan(0);
          continue;
        }
        plans++;
        const o = read.opportunity;
        const sign = o.direction === "long" ? 1 : -1;
        // Stop on the losing side, both targets on the winning side, T2 beyond T1.
        expect(sign * (o.entry - o.stop)).toBeGreaterThan(0);
        expect(sign * (o.target1 - o.entry)).toBeGreaterThan(0);
        expect(sign * (o.target2 - o.target1)).toBeGreaterThan(0);
        // R is the target-1 distance in units of the stop distance.
        expect(o.rMultiple).toBeCloseTo(Math.abs(o.target1 - o.entry) / Math.abs(o.entry - o.stop), 6);
        // No edge is claimed from a thin replay.
        if (!o.history.enough) expect(o.edge).toBeNull();
        expect(o.barsAgo).toBeGreaterThanOrEqual(0);
      }
    }
    // The fixture must exercise the success path, or the checks above prove nothing.
    expect(plans).toBeGreaterThan(0);
  });
});

const opp = (over: Partial<Opportunity> & { adverse?: boolean }): Opportunity => ({
  kind: "bos",
  label: "Break of structure",
  direction: "long",
  reason: "",
  score: 0.6,
  grounded: 1,
  barsAgo: 2,
  entry: 100,
  entryLow: 99,
  entryHigh: 101,
  stop: 98,
  target1: 104,
  target2: 106,
  rMultiple: 2,
  riskPct: 0.02,
  stopFrom: "structure",
  history: {
    n: 30,
    hitRate: 0.5,
    hitLow: 0.33,
    expectancy: 0.2,
    enough: true,
    adverse: over.adverse ?? false,
    note: "",
  },
  edge: 0,
  ...over,
});

describe("compareOpportunities", () => {
  it("puts a historically adverse setup last, whatever its score", () => {
    const bad = opp({ score: 0.95, adverse: true });
    const ok = opp({ score: 0.5 });
    expect([bad, ok].sort(compareOpportunities)[0]).toBe(ok);
  });

  it("ranks by score times grounding before freshness", () => {
    const thin = opp({ score: 0.9, grounded: 0.5 }); // 0.45
    const solid = opp({ score: 0.6, grounded: 1 }); // 0.60
    expect([thin, solid].sort(compareOpportunities)[0]).toBe(solid);
  });

  it("breaks a score tie by freshness, then by edge", () => {
    const old = opp({ barsAgo: 9 });
    const fresh = opp({ barsAgo: 1 });
    expect([old, fresh].sort(compareOpportunities)[0]).toBe(fresh);
    const noEdge = opp({ edge: null });
    const edged = opp({ edge: 0.05 });
    expect([noEdge, edged].sort(compareOpportunities)[0]).toBe(edged);
  });
});

describe("newSince", () => {
  it("flags new symbols and changed setups, not re-priced ones", () => {
    const prev = new Map([
      ["AAA", "bos|long"],
      ["BBB", "sweep|short"],
    ]);
    const cur = new Map([
      ["AAA", opp({ kind: "bos", direction: "long", entry: 123 })],
      ["BBB", opp({ kind: "sweep", direction: "long" })],
      ["CCC", opp({})],
    ]);
    expect([...newSince(prev, cur)].sort()).toEqual(["BBB", "CCC"]);
  });
});

describe("scanUniverse with opportunity", () => {
  const deps = (bars: BarView[]): ScanDeps => ({
    loadUniverse: async () => [
      { symbol: "AUSDT", quoteVolume: 2, changePct: 0, lastPrice: 1 },
      { symbol: "BUSDT", quoteVolume: 1, changePct: 0, lastPrice: 1 },
    ],
    loadBars: async () => bars,
  });

  it("attaches an opportunity read to every row when asked", async () => {
    const bars = series(400, 3);
    const rows = await scanUniverse(deps(bars), {
      interval: "1h",
      top: 2,
      opportunity: { intervalMs: HOUR, minStopAtr: 0.5, maxStopAtr: 3, now: (bars[399] as BarView).t + HOUR },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.opportunity).toBeDefined();
  });

  it("leaves rows untouched when not asked", async () => {
    const rows = await scanUniverse(deps(series(400, 3)), { interval: "1h", top: 2 });
    for (const r of rows) expect(r.opportunity).toBeUndefined();
  });
});

describe("rankByOpportunity", () => {
  const row = (symbol: string, o: Opportunity | null): ScanRow => ({
    symbol,
    lastPrice: 1,
    changePct: 0,
    quoteVolume: 1,
    result: null,
    closes: null,
    error: null,
    opportunity: o ? { ok: true, opportunity: o } : { ok: false, reason: "No setup cleared the engine's floor." },
  });

  it("puts rows with a setup first, in the engine's order, and keeps the rest in their given order", () => {
    const ranked = rankByOpportunity([
      row("NONE1", null),
      row("WEAK", opp({ score: 0.5 })),
      row("NONE2", null),
      row("STRONG", opp({ score: 0.9 })),
    ]);
    expect(ranked.map((r) => r.symbol)).toEqual(["STRONG", "WEAK", "NONE1", "NONE2"]);
  });
});
