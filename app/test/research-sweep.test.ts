/**
 * How strict reaches the rule tests: the operator's walk-forward rounds and
 * cost model are what the sweep actually runs with, and the sweep reports its
 * contest (rule vs not trading) in the units it was run in.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COSTS, ZERO_COSTS } from "../src/backtest/engine";

/* A pass-through spy on the REAL lab: the sweep runs exactly as in
   production, and the test reads back what it was asked to run with. */
const { runStudySpy } = vi.hoisted(() => ({ runStudySpy: vi.fn<(typeof import("../src/backtest/lab"))["runStudy"]>() }));
vi.mock("../src/backtest/lab", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/backtest/lab")>();
  runStudySpy.mockImplementation(real.runStudy);
  return { ...real, runStudy: (...args: Parameters<typeof real.runStudy>) => runStudySpy(...args) };
});
import { runOne } from "../src/study/steps";
import { buildPanel } from "../src/data/panel";
import { newStudy, type StudySpec } from "../src/study/spec";
import { splitWindow } from "../src/study/window";
import type { BarView } from "../src/chart/series";

/** A deterministic trending-then-ranging series: enough structure to trade. */
function bars(n: number): BarView[] {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  const out: BarView[] = [];
  let c = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = Math.sin(i / 300) * 0.002;
    const o = c;
    c = Math.max(1, c * (1 + drift + rnd() * 0.01));
    out.push({ t: i * 3_600_000, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1000 });
  }
  return out;
}

type StepInput = Parameters<typeof runOne>[1];

function input(spec: StudySpec, b: BarView[]): StepInput {
  const panel = buildPanel({ symbol: spec.symbol, timeframe: spec.timeframe, target: b, drivers: [], horizon: spec.horizon });
  const split = splitWindow(panel.rows.length, spec.horizon);
  return {
    spec,
    panel,
    rows: panel.rows.length,
    subjectBars: b,
    trainBars: b,
    featureSeries: [],
    rowRegimes: panel.rows.map(() => null),
    split,
    win: { requestedFrom: 0, requestedTo: 1, from: b[0]?.t ?? 0, to: b[b.length - 1]?.t ?? 0, spanMs: 1, limitedBy: [], shortfall: null, refusal: null },
    carry: { best: null },
    tests: 12,
    hypotheses: 12,
  };
}

describe("rule tests honour How strict", () => {
  const b = bars(6000);
  const base = { ...newStudy("s", "BTCUSDT", "1h", 0), context: [] };

  it("reports its contest, in the cost model it was run with", async () => {
    const withCosts = await runOne("sweep-ema", input({ ...base, costs: "standard" }, b));
    const noCosts = await runOne("sweep-ema", input({ ...base, costs: "none" }, b));
    if (withCosts.state !== "ok" || noCosts.state !== "ok") {
      /* A refusal is a result — but this fixture is built to trade, so a
         refusal here means the wiring broke, not the data. */
      throw new Error(`sweep refused: ${withCosts.state === "ok" ? "" : withCosts.reason} ${noCosts.state === "ok" ? "" : noCosts.reason}`);
    }
    expect(withCosts.contest?.baseline).toBe("not trading");
    expect(withCosts.contest?.by).toContain("after costs");
    expect(noCosts.contest?.by).toContain("with costs off");
  });

  it("passes the chosen rounds and cost model to the lab — the numbers it runs with", async () => {
    runStudySpy.mockClear();
    await runOne("sweep-ema", input({ ...base, folds: 9, costs: "none" }, b));
    await runOne("sweep-rsi", input({ ...base, folds: 99 }, b));
    const [first, second] = runStudySpy.mock.calls;
    expect(first?.[2]).toEqual({ folds: 9, costs: ZERO_COSTS });
    /* Clamped, not trusted: a corrupted stored value runs twelve rounds, not ninety-nine. */
    expect(second?.[2]).toEqual({ folds: 12, costs: DEFAULT_COSTS });
  });
});