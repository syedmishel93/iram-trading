/**
 * THE SAME BARS MUST GIVE THE SAME VERDICT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST EXISTS
 *
 * `survey.test.ts` failed twice in one full-suite run with "expected 0 to be
 * greater than 0" — no cell held — and passed on its own and in two other
 * full-suite runs on the same tree. CLAUDE.md's ledger already names `survey`
 * among the tests that "failed run to run" under load.
 *
 * But load cannot change arithmetic. `runSurvey` takes bars built by a SEEDED
 * generator, its bootstrap is a seeded PRNG whose seed is derived from the
 * data, and `resample.ts` imports nothing at all. So one of two things is
 * true: either the survey is not actually deterministic, or something outside
 * it leaks in. The first would be the worst defect this product could have —
 * an engine whose verdict depends on when you asked is an engine that cannot
 * refuse a false claim — so it gets a test of its own rather than a ledger
 * line.
 *
 * This pins the property, not the numbers. It does not assert that any
 * particular cell holds; it asserts that two runs over identical input agree
 * about every cell, which is the claim `resample.ts` makes in its own header:
 * "two runs over identical trades" must give the same answer, and a bootstrap
 * seeded from `Math.random` "breaks the same promise more quietly".
 */

import { describe, expect, it } from "vitest";
import { runSurvey } from "../src/backtest/survey";
import { rng } from "../src/backtest/resample";
import { SPECS } from "../src/backtest/specs";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;

/** The same generator `survey.test.ts` uses: seeded, so the bars are fixed. */
function reverting(n: number, seed: number, vol: number, pull = 0.05): BarView[] {
  const next = rng(seed);
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const shock = (next() - 0.5) * 2 * vol;
    const o = p;
    const c = p + (100 - p) * pull + p * shock;
    out.push({
      t: 1_600_000_000_000 + i * H,
      o,
      h: Math.max(o, c) * (1 + Math.abs(shock) * 0.4),
      l: Math.min(o, c) * (1 - Math.abs(shock) * 0.4),
      c,
      v: 1000 + next() * 500,
    });
    p = c;
  }
  return out;
}

const SIX = SPECS.filter((sp) =>
  ["rsi-reversion", "cci-extremes", "bb-fade", "ema-9-21-cross", "macd-signal-cross", "vwap-cross"].includes(sp.id),
);

const panel = () => [
  { symbol: "BTCUSDT", timeframe: "1h", bars: reverting(3000, 11, 0.01) },
  { symbol: "XAUUSD", timeframe: "1h", bars: reverting(3000, 12, 0.004) },
  { symbol: "SPX500", timeframe: "1h", bars: reverting(3000, 13, 0.005) },
  { symbol: "EURUSD", timeframe: "1h", bars: reverting(3000, 14, 0.003) },
];

/** Everything a verdict rests on, and nothing that is allowed to differ. */
const verdicts = (s: ReturnType<typeof runSurvey>) => ({
  blocked: s.blocked,
  held: s.held,
  styles: s.styles.map((c) => ({ key: c.key, standing: c.standing, q: c.q, expectancyR: c.expectancyR, trades: c.trades })),
  rules: s.rules.map((c) => ({ key: c.key, standing: c.standing, q: c.q, expectancyR: c.expectancyR, trades: c.trades })),
});

describe("the survey is deterministic", () => {
  it("GIVES THE SAME VERDICT TWICE over the same bars", () => {
    /* `ms` is excluded on purpose: elapsed time is the one field that MUST
       differ between runs, and comparing the whole object would fail for the
       only honest reason. */
    const a = runSurvey(panel(), { draws: 400, specs: SIX });
    const b = runSurvey(panel(), { draws: 400, specs: SIX });
    expect(verdicts(b)).toEqual(verdicts(a));
  });

  it("DOES NOT DEPEND ON THE CLOCK", () => {
    /* A survey whose standing moved with the time of day would explain the
       intermittent failure exactly, and would be unfixable by a timeout. */
    const real = runSurvey(panel(), { draws: 400, specs: SIX });
    const frozen = runSurvey(panel(), { draws: 400, specs: SIX, now: () => 0 });
    expect(verdicts(frozen)).toEqual(verdicts(real));
  });

  it("DOES NOT DEPEND ON Math.random", () => {
    /* The bootstrap's seed is derived from the data, and `resample.ts` says in
       its own header that seeding from `Math.random` "breaks the same promise
       more quietly". This is that sentence, enforced: with the global
       generator pinned to a constant, nothing may move. */
    const before = runSurvey(panel(), { draws: 400, specs: SIX });
    const real = Math.random;
    try {
      Math.random = () => 0.42;
      const pinned = runSurvey(panel(), { draws: 400, specs: SIX });
      expect(verdicts(pinned)).toEqual(verdicts(before));
    } finally {
      Math.random = real;
    }
  });
});
