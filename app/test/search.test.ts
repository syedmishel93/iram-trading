/**
 * The autonomous search's selection rule.
 *
 * The case this file exists for is the last one: a strategy that passes every
 * check `promote()` makes — thirty out-of-sample trades, retention, PBO, a
 * majority of profitable folds — and is STILL only the best arm of a large
 * search. Nothing on the recommendation path measured that before v60.
 */

import { describe, expect, it } from "vitest";
import { scoreSearch, perTradeSharpe, oosTrades, armsOf, type Candidate } from "../src/backtest/search";
import { EMPTY_METRICS, type Metrics } from "../src/backtest/metrics";
import type { Study } from "../src/backtest/lab";
import type { Trade } from "../src/backtest/engine";
import type { Promotion } from "../src/backtest/promote";

/** A trade whose only load-bearing field here is its R multiple. */
const trade = (r: number, i: number): Trade => ({
  direction: "long",
  entryIndex: i,
  entryTime: i * 3_600_000,
  entryPrice: 100,
  exitIndex: i + 1,
  exitTime: (i + 1) * 3_600_000,
  exitPrice: 100 + r,
  exitReason: r > 0 ? "target" : "stop",
  rMultiple: r,
  returnPct: r / 100,
  reason: "fixture",
  maeR: Math.min(0, r),
  mfeR: Math.max(0, r),
});

/**
 * `n` trades alternating around `mean` with a spread, so the per-trade Sharpe
 * is a real ratio rather than an artefact of identical values.
 */
const trades = (n: number, mean: number, spread = 1): Trade[] =>
  Array.from({ length: n }, (_, i) => trade(mean + (i % 2 === 0 ? spread : -spread), i));

const promotion = (promoted: boolean, summary = promoted ? "passed" : "failed"): Promotion => ({
  promoted,
  checks: promoted
    ? [{ id: "oos", passed: true, text: "enough out-of-sample trades" }]
    : [
        { id: "oos", passed: true, text: "enough out-of-sample trades" },
        { id: "retention", passed: false, text: "out-of-sample kept 12% of in-sample expectancy" },
      ],
  summary,
  outOfSample: EMPTY_METRICS as Metrics,
});

function study(opts: { trades: Trade[]; configs: number; promoted: boolean }): Study {
  return {
    family: "ema",
    bars: 5_000,
    configs: Array.from({ length: opts.configs }, (_, i) => ({ id: `c${i}` })),
    best: null,
    bestRun: null,
    walk: {
      folds: [
        { index: 0, trainFrom: 0, trainTo: 1, testFrom: 1, testTo: 2, chosen: "c0", inSample: EMPTY_METRICS, outOfSample: EMPTY_METRICS, trades: opts.trades },
      ],
      aggregate: EMPTY_METRICS,
      degradation: 0.8,
      warnings: [],
      verdict: "fixture",
    },
    overfit: { pbo: 0.2, logits: [], splits: 8, oosPositiveRate: 0.7, interpretation: "fixture" },
    headline: { standing: "survived", verdict: "fixture", why: "fixture" },
    grossMetrics: null,
    promotion: promotion(opts.promoted),
    regimes: [],
    warnings: [],
    rules: null,
  } as unknown as Study;
}

const candidate = (id: string, s: Study, origin: Candidate["origin"] = "library"): Candidate => ({ id, name: id, origin, study: s });

describe("per-trade statistics", () => {
  it("reads R multiples, not the annualised equity Sharpe", () => {
    const out = perTradeSharpe(trades(100, 0.2, 1));
    expect(out.n).toBe(100);
    expect(out.mean).toBeCloseTo(0.2, 6);
    /* mean 0.2, spread ±1 → sd ≈ 1, so the per-trade Sharpe is ≈ 0.2. */
    expect(out.sharpe).toBeGreaterThan(0.15);
    expect(out.sharpe).toBeLessThan(0.25);
  });

  it("scores a zero-spread fixture at zero rather than infinity", () => {
    expect(perTradeSharpe([trade(1, 0), trade(1, 1), trade(1, 2)]).sharpe).toBe(0);
  });

  it("pools the out-of-sample trades of every fold, and counts arms by configs", () => {
    const s = study({ trades: trades(40, 0.3), configs: 12, promoted: true });
    expect(oosTrades(s)).toHaveLength(40);
    expect(armsOf(s)).toBe(12);
  });
});

describe("scoreSearch", () => {
  it("has nothing to say when nothing ran", () => {
    const out = scoreSearch({ candidates: [] });
    expect(out.refusal?.kind).toBe("no-candidates");
    expect(out.survivors).toEqual([]);
  });

  it("passes a strong strategy from a small search", () => {
    const out = scoreSearch({ candidates: [candidate("strong", study({ trades: trades(200, 0.5, 1), configs: 1, promoted: true }))] });
    expect(out.survivors.map((s) => s.id)).toEqual(["strong"]);
    expect(out.refusal).toBeNull();
    expect(out.line).toContain("survived");
  });

  it("REFUSES the same strategy once the search that found it is large enough", () => {
    /* One arm each, but 4,000 arms were tried before this one. Nothing about
       the strategy changed — only what it took to find it. */
    const s = study({ trades: trades(60, 0.12, 1), configs: 1, promoted: true });
    const small = scoreSearch({ candidates: [candidate("x", s)] });
    const huge = scoreSearch({ candidates: [candidate("x", s)], priorTrials: 4_000 });
    expect(small.survivors).toHaveLength(1);
    expect(huge.survivors).toHaveLength(0);
    expect(huge.refusal?.kind).toBe("beaten-by-noise");
    expect(huge.refusal?.why).toContain("result of the search");
  });

  it("counts every configuration of every candidate as an arm", () => {
    const out = scoreSearch({
      candidates: [
        candidate("a", study({ trades: trades(40, 0.3), configs: 12, promoted: true })),
        candidate("b", study({ trades: trades(40, 0.3), configs: 8, promoted: true })),
      ],
      priorTrials: 30,
    });
    expect(out.trials).toBe(50);
  });

  it("keeps the existing gate's refusal wording rather than inventing its own", () => {
    const out = scoreSearch({ candidates: [candidate("weak", study({ trades: trades(60, 0.4), configs: 1, promoted: false }))] });
    expect(out.survivors).toHaveLength(0);
    expect(out.scored[0]?.rejected).toContain("12% of in-sample expectancy");
    expect(out.refusal?.kind).toBe("all-refused");
  });

  it("ranks by the mean when the search was small — the hurdle is not yet the story", () => {
    /* Two arms: the hurdle is ~0.09 of Sharpe for the 40-trade sample and
       ~0.03 for the 400-trade one, so the better mean (0.45 vs 0.35) wins. */
    const out = scoreSearch({
      candidates: [
        candidate("thin", study({ trades: trades(40, 0.45, 1), configs: 1, promoted: true })),
        candidate("thick", study({ trades: trades(400, 0.35, 1), configs: 1, promoted: true })),
      ],
    });
    expect(out.survivors[0]?.id).toBe("thin");
  });

  it("turns that around once the search is wide: a thin sample pays far more", () => {
    /* 2,000 arms. Standard error is sqrt((1+S²/2)/n), so it falls with the
       SQUARE ROOT of the sample: 0.166 at 40 trades against 0.052 at 400. The
       same hurdle multiplier therefore costs the thin sample ~0.58 of Sharpe
       and the thick one ~0.18 — enough to reverse the ranking and to refuse
       the thin one outright. */
    const out = scoreSearch({
      candidates: [
        candidate("thin", study({ trades: trades(40, 0.45, 1), configs: 1, promoted: true })),
        candidate("thick", study({ trades: trades(400, 0.35, 1), configs: 1, promoted: true })),
      ],
      priorTrials: 2_000,
    });
    expect(out.survivors[0]?.id).toBe("thick");
    expect(out.survivors.map((x) => x.id)).not.toContain("thin");
  });

  it("separates 'none was good enough' from 'the best is what the search finds in noise'", () => {
    const failed = scoreSearch({ candidates: [candidate("f", study({ trades: trades(60, 0.4), configs: 1, promoted: false }))] });
    expect(failed.refusal?.kind).toBe("all-refused");
    const noise = scoreSearch({ candidates: [candidate("n", study({ trades: trades(60, 0.1, 1), configs: 1, promoted: true }))], priorTrials: 5_000 });
    expect(noise.refusal?.kind).toBe("beaten-by-noise");
  });
});
