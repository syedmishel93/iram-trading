/**
 * The autonomous run, with the study runner injected.
 *
 * The behaviour worth pinning is the accounting: what entered the field, what
 * failed, and that a rule which could not be studied is still charged for —
 * a field of sixty that quietly becomes forty would lower the hurdle without
 * anyone being told.
 */

import { describe, expect, it, vi } from "vitest";
import { autoRun, buildField, type Entrant, type StudyOutcome } from "../src/backtest/autorun";
import { SPECS } from "../src/backtest/specs";
import { countField } from "../src/backtest/sweepplan";
import { DEFAULT_COSTS, type Trade } from "../src/backtest/engine";
import { EMPTY_METRICS } from "../src/backtest/metrics";
import type { Study } from "../src/backtest/lab";
import type { Promotion } from "../src/backtest/promote";

const trade = (r: number, i: number): Trade => ({
  direction: "long",
  entryIndex: i,
  entryTime: i,
  entryPrice: 100,
  exitIndex: i + 1,
  exitTime: i + 1,
  exitPrice: 100 + r,
  exitReason: r > 0 ? "target" : "stop",
  rMultiple: r,
  returnPct: r / 100,
  reason: "fixture",
  maeR: Math.min(0, r),
  mfeR: Math.max(0, r),
});
const trades = (n: number, mean: number): Trade[] =>
  Array.from({ length: n }, (_, i) => trade(mean + (i % 2 === 0 ? 1 : -1), i));

const promotion = (promoted: boolean): Promotion => ({
  promoted,
  checks: [{ id: "oos", passed: promoted, text: promoted ? "enough out-of-sample trades" : "only 4 out-of-sample trades" }],
  summary: promoted ? "passed" : "failed",
  outOfSample: EMPTY_METRICS,
});

const study = (mean: number, promoted = true, configs = 1): Study =>
  ({
    family: "ema",
    bars: 5_000,
    configs: Array.from({ length: configs }, (_, i) => ({ id: `c${i}` })),
    best: null,
    bestRun: null,
    walk: {
      folds: [{ index: 0, trainFrom: 0, trainTo: 1, testFrom: 1, testTo: 2, chosen: "c0", inSample: EMPTY_METRICS, outOfSample: EMPTY_METRICS, trades: trades(200, mean) }],
      aggregate: EMPTY_METRICS,
      degradation: 0.8,
      warnings: [],
      verdict: "fixture",
    },
    overfit: { pbo: 0.2, logits: [], splits: 8, oosPositiveRate: 0.7, interpretation: "fixture" },
    headline: { standing: "survived", verdict: "fixture", why: "fixture" },
    grossMetrics: null,
    promotion: promotion(promoted),
    regimes: [],
    warnings: [],
    rules: null,
  }) as unknown as Study;

const opts = { symbol: "BTCUSDT", timeframe: "1h", bars: 5_000, costs: DEFAULT_COSTS };

describe("the field", () => {
  it("is every library rule, plus hybrids, plus conditioned arms — deterministic", () => {
    /* PINS THE RELATIONSHIP, not a number. It asserted `SPECS.length +
       hybrids`, so adding conditioned arms in v63.21 broke a test about
       DETERMINISM over arithmetic — which teaches the next person to re-paste
       the total rather than read what the test is for. */
    const a = buildField({ maxHybrids: 10, contextAvailable: true });
    const b = buildField({ maxHybrids: 10, contextAvailable: true });
    expect(a.entrants.length).toBe(
      SPECS.length + a.hybrids.hybrids.length + a.conditioned.specs.length,
    );
    expect(a.entrants.map((e) => e.spec.id)).toEqual(b.entrants.map((e) => e.spec.id));
    expect(a.entrants.filter((e) => e.origin === "hybrid")).toHaveLength(10);
    expect(a.entrants.filter((e) => e.origin === "conditioned").length).toBeGreaterThan(0);
  });

  it("EVERY ARM IS ACCOUNTED FOR BY EXACTLY ONE ORIGIN", () => {
    // `countField` did `else library += 1`, so 150 conditioned arms were
    // reported as library rules and the operator's line read "175 library
    // rules" on a field holding 25. A bucket that absorbs what it does not
    // recognise stops adding up, silently.
    const { entrants } = buildField({ maxHybrids: 10, contextAvailable: true });
    const c = countField(entrants);
    expect(c.library + c.hybrids + c.conditioned + c.other).toBe(c.arms);
    expect(c.library).toBe(SPECS.length);
    expect(c.other).toBe(0);
  });

  it("ADDS NO CONDITIONED ARM UNLESS THE CONTEXT IS ACTUALLY LOADED", () => {
    /* THE SAFETY PROPERTY. A conditioned arm whose context column is NaN can
       never fire. Adding 150 of them would widen the field from ~85 to ~235 and
       RAISE the hurdle for every real arm while contributing nothing — the
       search gets strictly harder and no better. An inert capability that costs
       something is worse than one that costs nothing. */
    const off = buildField({ maxHybrids: 10 });
    expect(off.entrants.filter((e) => e.origin === "conditioned")).toHaveLength(0);
    expect(off.conditioned.specs).toHaveLength(0);

    const on = buildField({ maxHybrids: 10, contextAvailable: true });
    expect(on.entrants.filter((e) => e.origin === "conditioned").length).toBeGreaterThan(0);
    // And the field really is wider, which is what the hurdle will charge for.
    expect(on.entrants.length).toBeGreaterThan(off.entrants.length);
  });

  it("leaves out what the operator has excluded", () => {
    const first = SPECS[0]?.id as string;
    const out = buildField({ maxHybrids: 5, exclude: [first] });
    expect(out.entrants.map((e) => e.spec.id)).not.toContain(first);
  });
});

describe("autoRun", () => {
  const runner = (make: (e: Entrant, i: number) => StudyOutcome) => vi.fn(async (entrants: readonly Entrant[], onProgress: (p: { done: number; total: number; last: string }) => void) => {
    const out: StudyOutcome[] = [];
    entrants.forEach((e, i) => {
      out.push(make(e, i));
      onProgress({ done: i + 1, total: entrants.length, last: e.spec.name });
    });
    return out;
  });

  it("reports progress as rules finish — one tick per entrant", async () => {
    /* PINS THE RELATIONSHIP. It asserted `SPECS.length + 3`, so widening the
       field with conditioned arms broke a test about PROGRESS over arithmetic.
       What it is for is that every rule handed to the runner reports once, and
       the runner itself is the honest witness to how many there were. */
    const seen: number[] = [];
    let handed = 0;
    await autoRun(
      { ...opts, maxHybrids: 3, contextAvailable: true, onProgress: (p) => seen.push(p.done) },
      { runStudies: runner((e) => { handed += 1; return { id: e.spec.id, study: study(0.05, false) }; }) },
    );
    expect(seen[0]).toBe(1);
    expect(handed).toBeGreaterThan(SPECS.length);
    expect(seen.at(-1)).toBe(handed);
  });

  it("keeps a survivor as an unproven row carrying its provenance", async () => {
    const strong = SPECS[0]?.id as string;
    const report = await autoRun(
      { ...opts, maxHybrids: 2 },
      { runStudies: runner((e) => ({ id: e.spec.id, study: e.spec.id === strong ? study(0.6) : study(0.01, false) })), now: () => 7_000 },
    );
    expect(report.keep).toHaveLength(1);
    const kept = report.keep[0];
    expect(kept?.status).toBe("unproven");
    expect(kept?.symbol).toBe("BTCUSDT");
    expect(kept?.timeframe).toBe("1h");
    expect(kept?.bars).toBe(5_000);
    expect(kept?.foundAt).toBe(7_000);
    expect(kept?.costs).toEqual(DEFAULT_COSTS);
    /* The hurdle it cleared depends on the size of the search, so the row
       carries the trial count rather than the survivor's own numbers alone. */
    expect(kept?.trials).toBe(report.search.trials);
    expect(kept?.trials).toBeGreaterThan(SPECS.length);
  });

  it("keeps nothing when nothing survives, and says so", async () => {
    const report = await autoRun({ ...opts, maxHybrids: 2 }, { runStudies: runner((e) => ({ id: e.spec.id, study: study(0.02, false) })) });
    expect(report.keep).toEqual([]);
    expect(report.search.survivors).toEqual([]);
    expect(report.line).toContain("Nothing survived");
  });

  it("charges the search for rules that could not be studied, and names them", async () => {
    const failing = SPECS[1]?.id as string;
    let handed = 0;
    const report = await autoRun(
      { ...opts, maxHybrids: 0, contextAvailable: true },
      { runStudies: runner((e) => { handed += 1; return e.spec.id === failing ? { id: e.spec.id, study: null, error: "not enough history" } : { id: e.spec.id, study: study(0.3) }; }) },
    );
    expect(report.failed).toEqual([{ id: failing, why: "not enough history" }]);
    expect(report.line).toContain("could not be studied");
    /* ONE ARM EACH, INCLUDING THE ONE THAT FAILED. A rule that could not be
       studied was still chosen, built and attempted, and charging for it keeps
       the hurdle honest — a field that silently shrinks lowers the bar. The
       count comes from what the runner was HANDED, not from a constant: with
       conditioned arms the field is no longer `SPECS.length`, and pinning that
       number made this test fail over arithmetic rather than over the fact it
       exists for. */
    expect(report.search.trials).toBe(handed);
    expect(handed).toBeGreaterThan(SPECS.length);
  });

  it("gives a failed study a reason even when the runner supplies none", async () => {
    const report = await autoRun({ ...opts, maxHybrids: 0 }, { runStudies: runner((e) => ({ id: e.spec.id, study: null })) });
    expect(report.failed[0]?.why).toContain("gave no reason");
  });

  it("adds the caller's prior trials to the hurdle", async () => {
    const run = (prior: number) =>
      autoRun({ ...opts, maxHybrids: 0, priorTrials: prior }, { runStudies: runner((e) => ({ id: e.spec.id, study: study(0.3) })) });
    const a = await run(0);
    const b = await run(500);
    expect(b.search.trials - a.search.trials).toBe(500);
  });
});
