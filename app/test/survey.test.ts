/**
 * The cross-market survey.
 *
 * The property worth testing is not "does it compute an average". It is the one
 * the module exists for: **a significant edge across correlated markets is not a
 * style finding**, and the survey must say so by name. The pair of tests around
 * `one-market` is the centre of this file — the same synthetic edge, tested twice,
 * reported as a finding on a diversified panel and refused on a crypto-only one.
 *
 * Everything else guards a way the survey could quietly mislead: a market that
 * failed to load being invisible, a thin cell inflating the multiplicity
 * correction, two timeframes pooled into one number.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_BLOCS,
  MIN_CELL_TOTAL,
  MIN_CELL_TRADES,
  recommendFor,
  runSurvey,
  type SurveyMarket,
} from "../src/backtest/survey";
import { panelLimit, resolutionLimit } from "../src/backtest/survey";
import { FDR, rng } from "../src/backtest/resample";
import { SPECS } from "../src/backtest/specs";
import { PANEL, DEFAULT_SELECTION, blocsOf, panelCaveat } from "../src/backtest/universe";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;

/**
 * A mean-reverting series: price pulled towards a fixed anchor each bar.
 *
 * Chosen because it gives the shipped reversion rules a REAL edge, so the survey
 * has something true to find. A random walk gives every rule a small loss to
 * costs, which tests only the refusal path.
 */
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

/** A plain random walk — no edge for anything to find. */
function walk(n: number, seed: number, vol: number): BarView[] {
  const next = rng(seed);
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const shock = (next() - 0.5) * 2 * vol;
    const o = p;
    const c = p * (1 + shock);
    out.push({
      t: 1_600_000_000_000 + i * H,
      o,
      h: Math.max(o, c) * (1 + Math.abs(shock) * 0.4),
      l: Math.min(o, c) * (1 - Math.abs(shock) * 0.4),
      c,
      v: 1000,
    });
    p = c;
  }
  return out;
}

const market = (symbol: string, bars: BarView[]): SurveyMarket => ({
  symbol,
  timeframe: "1h",
  bars,
});

/**
 * A six-rule set and a draw count that can actually resolve it.
 *
 * The pairing is not arbitrary and not only about speed. The multiplicity
 * correction cannot report a q below `cells / (draws + 1)`, so `draws` has to be
 * chosen against the number of cells or the survey becomes incapable of
 * reporting anything — see the `resolutionLimit` block below, which is the guard
 * that caught this file getting it wrong. Six rules give 24 cells; 400 draws
 * resolve to 0.06, inside the 10% threshold.
 *
 * Two reversion rules, one band fade, two trend rules and a session rule, so the
 * style table has more than one row to compare.
 */
const SIX = SPECS.filter((sp) =>
  [
    "rsi-reversion",
    "cci-extremes",
    "bb-fade",
    "ema-9-21-cross",
    "macd-signal-cross",
    "vwap-cross",
  ].includes(sp.id),
);

const SET = { draws: 400, specs: SIX } as const;

/** For tests about skipping and plumbing, where no cell needs to be reportable. */
const FAST = { draws: 200, specs: SIX } as const;

describe("the universe", () => {
  it("declares a bloc for every panel entry", () => {
    for (const m of PANEL) {
      expect(m.bloc).toBeTruthy();
      expect(m.why.length).toBeGreaterThan(20);
    }
  });

  it("defaults to a selection spanning distinct blocs", () => {
    // The default must not be four names for one market — that is the error the
    // whole agreement mechanism exists to catch.
    expect(blocsOf(DEFAULT_SELECTION).length).toBe(DEFAULT_SELECTION.length);
  });

  it("warns when a panel is all one bloc", () => {
    const note = panelCaveat(["BTCUSDT", "ETHUSDT"]);
    expect(note).toMatch(/crypto/i);
    expect(note).toMatch(/agreeing with itself|move together/i);
  });

  it("warns when a symbol's correlation is unknown", () => {
    expect(panelCaveat(["BTCUSDT", "XAUUSD", "WHATEVER"])).toMatch(/outside the declared panel/i);
  });

  it("has nothing to say about a well-spread panel", () => {
    expect(panelCaveat(["BTCUSDT", "XAUUSD", "SPX500", "EURUSD"])).toBeNull();
  });

  it("refuses an empty selection", () => {
    expect(panelCaveat([])).toMatch(/nothing to survey/i);
  });
});

/**
 * The trap this guard exists for was found by a failing test, not by reasoning.
 *
 * A bootstrap over N draws cannot report p below 1/(N+1); BH multiplies that by
 * cells/rank; so the best q reachable is cells/(N+1). Set draws low enough and
 * the survey becomes incapable of reporting a finding — and would say "nothing
 * survived" in exactly the words it uses for a real null, with the data playing
 * no part. That is a confident wrong answer, which is worse than an error.
 */
describe("the resolution limit", () => {
  it("says nothing when the draws can resolve the threshold", () => {
    // 24 cells at 400 draws => best q 0.06, inside the 10% threshold.
    expect(resolutionLimit(24, 400)).toBeNull();
    expect(resolutionLimit(75, 2000)).toBeNull();
  });

  it("catches the setting that can never report a finding", () => {
    const note = resolutionLimit(75, 200);
    expect(note).toMatch(/^Underpowered/);
    expect(note).toMatch(/0\.37/);
    expect(note).toMatch(/the limit is the draw count, not the data/);
  });

  it("says how many draws would be enough, and is right about it", () => {
    const cells = 75;
    const note = resolutionLimit(cells, 200) as string;
    const needed = Number((/([\d,]+) draws or more/.exec(note)?.[1] ?? "0").replace(/,/g, ""));
    expect(needed).toBeGreaterThan(200);
    // The advice must actually clear the limit, and be the smallest that does.
    expect(resolutionLimit(cells, needed)).toBeNull();
    expect(resolutionLimit(cells, needed - 1)).not.toBeNull();
  });

  it("is quiet when there is nothing to correct", () => {
    expect(resolutionLimit(0, 10)).toBeNull();
  });

  it("takes over the headline, because every number under it is unreadable", () => {
    /* Two blocs, so the PANEL limit does not fire and the draw count is the only
       blocker left — the two are checked in that order precisely so a survey
       reports the limit that actually binds. */
    const s = runSurvey(
      [
        market("BTCUSDT", reverting(2000, 11, 0.01)),
        market("XAUUSD", reverting(2000, 12, 0.004)),
      ],
      { draws: 20 },
    );
    expect(s.blocked).toMatch(/^Underpowered/);
    expect(s.headline).toBe(s.blocked);
    // And it is the FIRST caveat, not buried under the panel notes.
    expect(s.caveats[0]).toBe(s.blocked);
  });

  it("agrees with the threshold it is checking against", () => {
    // cells/(draws+1) exactly at FDR must pass; a hair above must not.
    const draws = 999;
    const exact = Math.floor(FDR * (draws + 1));
    expect(resolutionLimit(exact, draws)).toBeNull();
    expect(resolutionLimit(exact + 1, draws)).not.toBeNull();
  });
});

/**
 * The other structural blocker, found by RUNNING the desk rather than by
 * reasoning about it: on an install with no MT5 bridge only the crypto legs
 * load, so the panel is one bloc, `holds` is unreachable, and the survey was
 * reporting "none showed a positive edge that independent markets agreed on"
 * about a panel containing one market.
 */
describe("the panel limit", () => {
  it("is quiet once two independent blocs are present", () => {
    expect(panelLimit(MIN_BLOCS, 2)).toBeNull();
    expect(panelLimit(4, 4)).toBeNull();
  });

  it("catches the panel that cannot satisfy the agreement rule", () => {
    const note = panelLimit(1, 2) as string;
    expect(note).toMatch(/^Only one correlation bloc loaded \(2 markets\)/);
    expect(note).toMatch(/NOTHING can hold/);
    expect(note).toMatch(/the limit is the panel, not the data/);
  });

  it("says the numbers are still real, and what they describe", () => {
    // The refusal must not read as "these results are wrong". They are correct
    // arithmetic with a narrower scope than the desk's headline implies.
    const note = panelLimit(1, 1) as string;
    expect(note).toMatch(/real arithmetic on real bars/);
    expect(note).toMatch(/that one market/);
    expect(note).toMatch(/gold, an index or an FX pair/);
  });

  it("gets the singular right", () => {
    expect(panelLimit(1, 1)).toMatch(/\(1 market\)/);
    expect(panelLimit(1, 3)).toMatch(/\(3 markets\)/);
  });

  it("has its own words for an empty panel", () => {
    expect(panelLimit(0, 0)).toMatch(/nothing to survey/i);
  });

  it("outranks the draw count, because it binds at any draw count", () => {
    // One bloc AND too few draws. The panel limit is the one that cannot be
    // fixed by a setting, so it is the one reported.
    const s = runSurvey([market("BTCUSDT", reverting(2000, 11, 0.01))], { draws: 20, specs: SIX });
    expect(s.blocked).toMatch(/^Only one correlation bloc/);
  });
});

describe("markets that cannot be used are reported, never dropped", () => {
  const good = () => market("BTCUSDT", walk(1200, 1, 0.01));

  it("skips generated data and says so", () => {
    const s = runSurvey([good(), { ...market("XAUUSD", walk(1200, 2, 0.005)), containsDemo: true }], FAST);
    expect(s.markets.map((m) => m.symbol)).toEqual(["BTCUSDT"]);
    expect(s.skipped).toEqual([{ symbol: "XAUUSD", reason: "series contains generated data" }]);
    expect(s.caveats.join(" ")).toMatch(/XAUUSD/);
  });

  it("honours allowDemo when the caller asks for it", () => {
    const s = runSurvey(
      [good(), { ...market("XAUUSD", walk(1200, 2, 0.005)), containsDemo: true }],
      { ...FAST, allowDemo: true },
    );
    expect(s.skipped).toEqual([]);
    expect(s.markets).toHaveLength(2);
  });

  it("skips a series with holes in it", () => {
    const s = runSurvey([good(), { ...market("XAUUSD", walk(1200, 2, 0.005)), coverage: 0.6 }], FAST);
    expect(s.skipped[0]?.symbol).toBe("XAUUSD");
    expect(s.skipped[0]?.reason).toMatch(/coverage 60\.0%/);
  });

  it("refuses to pool two timeframes into one number", () => {
    const s = runSurvey(
      [good(), { ...market("XAUUSD", walk(1200, 2, 0.005)), timeframe: "1d" }],
      FAST,
    );
    expect(s.timeframe).toBe("1h");
    expect(s.skipped[0]?.reason).toMatch(/timeframe 1d does not match/);
  });

  it("skips a market with too little history for the rule set", () => {
    /* The floor is the rule set's own longest warm-up plus fifty, so it moves
       with `specs`. Forty bars is below it for any set. */
    const s = runSurvey([good(), market("XAUUSD", walk(40, 2, 0.005))], FAST);
    expect(s.markets.map((m) => m.symbol)).toEqual(["BTCUSDT"]);
    expect(s.skipped[0]?.reason).toMatch(/^40 bars is below the \d+ this rule set needs$/);
  });

  it("says there is nothing to survey when every market failed", () => {
    const s = runSurvey([{ ...good(), coverage: 0.1 }], FAST);
    expect(s.markets).toHaveLength(0);
    expect(s.headline).toMatch(/nothing to survey/i);
    expect(s.tested).toBe(0);
  });

  it("counts agreement only over markets that loaded", () => {
    const s = runSurvey(
      [good(), { ...market("XAUUSD", walk(1200, 2, 0.005)), coverage: 0.5 }],
      FAST,
    );
    for (const cell of [...s.styles, ...s.rules]) {
      expect(cell.blocs).toBeLessThanOrEqual(1);
      expect(cell.legs.map((l) => l.symbol)).toEqual(["BTCUSDT"]);
    }
  });
});

describe("a random walk yields no findings", () => {
  const s = runSurvey(
    [
      market("BTCUSDT", walk(2400, 1, 0.012)),
      market("XAUUSD", walk(2400, 2, 0.004)),
      market("SPX500", walk(2400, 3, 0.005)),
      market("EURUSD", walk(2400, 4, 0.003)),
    ],
    SET,
  );

  it("is powered enough for its own conclusion to mean anything", () => {
    /* Without this the block below is vacuous: an underpowered survey reports
       "nothing survived" whatever the data says. This assertion is what makes
       "holds nothing" a statement about the random walk. */
    expect(s.blocked).toBeNull();
  });

  it("tests a real number of cells", () => {
    expect(s.tested).toBeGreaterThan(10);
  });

  it("holds nothing", () => {
    expect(s.held).toBe(0);
    expect([...s.styles, ...s.rules].filter((c) => c.standing === "holds")).toHaveLength(0);
  });

  it("says so at the top, without leading with a return", () => {
    expect(s.headline).toMatch(/^Nothing survived/);
    expect(s.headline).toMatch(/a best row is not a finding/);
  });

  it("gives an honest empty recommendation for every condition", () => {
    for (const regime of ["trend", "chop", "volatile"] as const) {
      const rec = recommendFor(s, regime);
      expect(rec.holds).toHaveLength(0);
      expect(rec.text).toMatch(/Nothing held|Nothing was testable/);
    }
  });

  it("spends its bars across the three regimes", () => {
    const total = s.exposure.trend + s.exposure.chop + s.exposure.volatile;
    expect(total).toBeCloseTo(1, 6);
    for (const v of Object.values(s.exposure)) expect(v).toBeGreaterThan(0);
  });
});

/**
 * THE CENTRAL PAIR.
 *
 * One synthetic edge, two panels. Diversified, it is a finding. Confined to a
 * single correlation bloc, the SAME edge with the SAME significance is refused —
 * because two crypto pairs agreeing is one market agreeing with itself.
 */
describe("a real edge, and whether the panel can support the claim", () => {
  /**
   * A SMALL spec set, deliberately.
   *
   * Not for speed — for statistical validity. The number of cells drives the
   * multiplicity correction, and the correction cannot report below
   * `cells / (draws + 1)`. Six rules give 24 cells, which 400 draws can resolve
   * to 0.06; the full 26-rule set at 400 draws could not report a finding at all.
   * `resolutionLimit` is what makes that a stated constraint rather than a trap,
   * and the test below exercises it directly.
   */
  const SIX = SPECS.filter((sp) =>
    ["rsi-reversion", "cci-extremes", "bb-fade", "ema-9-21-cross", "macd-signal-cross", "vwap-cross"].includes(sp.id),
  );
  const SET = { draws: 400, specs: SIX } as const;

  const diversified = runSurvey(
    [
      market("BTCUSDT", reverting(3000, 11, 0.01)),
      market("XAUUSD", reverting(3000, 12, 0.004)),
      market("SPX500", reverting(3000, 13, 0.005)),
      market("EURUSD", reverting(3000, 14, 0.003)),
    ],
    SET,
  );

  const cryptoOnly = runSurvey(
    [
      market("BTCUSDT", reverting(3000, 11, 0.01)),
      market("ETHUSDT", reverting(3000, 15, 0.011)),
    ],
    SET,
  );

  it("is powered enough for the diversified panel to report anything", () => {
    // If this fails, every other expectation about `diversified` is vacuous.
    expect(diversified.blocked).toBeNull();
  });

  it("blocks the single-bloc panel at the headline, not only per cell", () => {
    /* The crypto-only panel cannot produce a finding by construction, and saying
       so at the top is the point: the per-cell `one-market` standings below are
       the same answer in detail, but a reader who only reads the headline must
       not come away thinking the DATA was unconvincing. */
    expect(cryptoOnly.blocked).toMatch(/^Only one correlation bloc loaded/);
    expect(cryptoOnly.headline).toBe(cryptoOnly.blocked);
    expect(cryptoOnly.blocked).toMatch(/the limit is the panel, not the data/);
  });

  it("finds the reversion edge on a diversified panel", () => {
    const held = diversified.styles.filter((c) => c.standing === "holds");
    expect(held.length).toBeGreaterThan(0);
    expect(held.map((c) => c.style)).toContain("reversion");
    expect(diversified.held).toBeGreaterThan(0);
  });

  it("requires independent blocs to agree before calling it held", () => {
    for (const cell of diversified.styles.filter((c) => c.standing === "holds")) {
      expect(cell.blocs).toBeGreaterThanOrEqual(MIN_BLOCS);
      expect(cell.agree / cell.blocs).toBeGreaterThanOrEqual(0.66);
      expect(cell.expectancyR).toBeGreaterThan(0);
      expect(cell.q).toBeLessThanOrEqual(0.1);
    }
  });

  it("recommends by condition, and names the caveat", () => {
    const best = diversified.styles.find((c) => c.standing === "holds");
    expect(best).toBeDefined();
    const rec = recommendFor(diversified, (best as { regime: "trend" | "chop" | "volatile" }).regime);
    expect(rec.holds.length).toBeGreaterThan(0);
    expect(rec.text).toMatch(/Screening only|walk it forward/i);
  });

  it("REFUSES the same edge as a style finding on a single-bloc panel", () => {
    const significant = cryptoOnly.styles.filter((c) => c.expectancyR > 0 && c.q <= 0.1);
    // The edge is still there and still statistically significant...
    expect(significant.length).toBeGreaterThan(0);
    // ...and not one cell is allowed to be a finding.
    expect(cryptoOnly.held).toBe(0);
    for (const cell of significant) {
      expect(cell.standing).toBe("one-market");
      expect(cell.blocs).toBe(1);
    }
  });

  it("explains the refusal in the cell's own words", () => {
    const cell = cryptoOnly.styles.find((c) => c.standing === "one-market");
    expect(cell).toBeDefined();
    expect(cell?.verdict).toMatch(/fact about that market, not about the rule/i);
  });

  it("carries the single-bloc caveat on the survey", () => {
    expect(cryptoOnly.caveats.join(" ")).toMatch(/agreeing with itself/i);
  });

  it("always carries the in-sample caveat, whatever the result", () => {
    for (const s of [diversified, cryptoOnly]) {
      expect(s.caveats.join(" ")).toMatch(/same history it was chosen from/i);
      expect(s.caveats.join(" ")).toMatch(/walk-forward/i);
    }
  });
});

describe("the sample floors", () => {
  const s = runSurvey(
    [
      market("BTCUSDT", reverting(2000, 11, 0.01)),
      market("XAUUSD", reverting(2000, 12, 0.004)),
    ],
    FAST,
  );

  it("marks a cell below the pooled floor as thin, not as no-edge", () => {
    const thin = [...s.styles, ...s.rules].filter((c) => c.standing === "thin");
    for (const cell of thin) expect(cell.trades).toBeLessThan(MIN_CELL_TOTAL);
    // The distinction is the point: "not measured" is not "measured and flat".
    for (const cell of thin.filter((c) => c.trades > 0)) {
      expect(cell.verdict).toMatch(/not tested|Not "no edge": not measured/);
    }
  });

  it("keeps thin cells out of the multiplicity correction", () => {
    const cells = [...s.styles, ...s.rules];
    const thin = cells.filter((c) => c.standing === "thin").length;
    expect(s.tested).toBe(cells.length - thin);
    // A cell too small to test is not a hypothesis that was tried, so admitting
    // it would penalise every cell that deserved testing.
    expect(thin).toBeGreaterThan(0);
  });

  it("never runs a bootstrap on a thin cell", () => {
    for (const cell of [...s.styles, ...s.rules].filter((c) => c.standing === "thin")) {
      expect(cell.boot.draws).toBe(0);
      expect(cell.boot.p).toBe(1);
    }
  });

  it("only lets a market's leg vote once it has a real sample", () => {
    for (const cell of [...s.styles, ...s.rules]) {
      for (const leg of cell.legs) {
        expect(leg.qualifies).toBe(leg.trades >= MIN_CELL_TRADES);
      }
    }
  });

  it("says nothing was testable when nothing reaches the floor", () => {
    const tiny = runSurvey(
      [market("BTCUSDT", walk(320, 7, 0.008)), market("XAUUSD", walk(320, 8, 0.004))],
      { ...FAST, specs: SPECS.filter((sp) => sp.id === "ema-50-200-cross") },
    );
    if (tiny.tested === 0) {
      expect(tiny.headline).toMatch(/Nothing was testable/);
    } else {
      expect(tiny.held).toBe(0);
    }
  });
});

describe("pooling is honest about who produced the trades", () => {
  it("reports the pooled mean AND the cross-market median", () => {
    const s = runSurvey(
      [
        market("BTCUSDT", reverting(3000, 11, 0.01)),
        market("XAUUSD", reverting(3000, 12, 0.004)),
        market("SPX500", reverting(3000, 13, 0.005)),
      ],
      FAST,
    );
    const cell = s.styles.find((c) => c.trades > MIN_CELL_TOTAL && c.legs.filter((l) => l.qualifies).length >= 2);
    expect(cell).toBeDefined();
    // Both numbers exist and are finite; they are allowed to disagree, and the
    // disagreement is the finding.
    expect(Number.isFinite(cell?.expectancyR as number)).toBe(true);
    expect(Number.isFinite(cell?.medianR as number)).toBe(true);
  });

  it("weights the pooled figure by trades, not by market", () => {
    // One long market and one short one. The pooled expectancy must be the mean
    // over all trades — the number that describes what actually happened — and
    // the median must be the per-market one.
    const s = runSurvey(
      [market("BTCUSDT", reverting(3000, 11, 0.01)), market("XAUUSD", reverting(900, 12, 0.004))],
      FAST,
    );
    for (const cell of [...s.styles, ...s.rules].filter((c) => c.trades > 0)) {
      const legsTotal = cell.legs.reduce((a, l) => a + l.trades, 0);
      expect(legsTotal).toBe(cell.trades);
      const weighted =
        cell.legs.reduce((a, l) => a + l.expectancyR * l.trades, 0) / Math.max(1, cell.trades);
      expect(cell.expectancyR).toBeCloseTo(weighted, 8);
    }
  });

  it("counts two markets in one bloc as a single vote", () => {
    const s = runSurvey(
      [
        market("BTCUSDT", reverting(3000, 11, 0.01)),
        market("ETHUSDT", reverting(3000, 15, 0.011)),
        market("XAUUSD", reverting(3000, 12, 0.004)),
      ],
      FAST,
    );
    for (const cell of [...s.styles, ...s.rules]) {
      const qualifying = cell.legs.filter((l) => l.qualifies);
      const symbols = new Set(qualifying.map((l) => l.symbol));
      const blocs = new Set(qualifying.map((l) => l.bloc));
      expect(cell.blocs).toBe(blocs.size);
      // Three qualifying symbols can only ever be two blocs here.
      if (symbols.size === 3) expect(cell.blocs).toBe(2);
      expect(cell.agree).toBeLessThanOrEqual(cell.blocs);
    }
  });
});

describe("reproducibility", () => {
  const build = (): SurveyMarket[] => [
    market("BTCUSDT", reverting(2000, 11, 0.01)),
    market("XAUUSD", reverting(2000, 12, 0.004)),
  ];

  it("gives the same verdicts on the same bars", () => {
    const a = runSurvey(build(), FAST);
    const b = runSurvey(build(), FAST);
    expect(a.styles.map((c) => [c.key, c.standing, c.q])).toEqual(
      b.styles.map((c) => [c.key, c.standing, c.q]),
    );
    expect(a.headline).toBe(b.headline);
    expect(a.held).toBe(b.held);
  });

  it("does not depend on the order the markets were given in", () => {
    const forward = runSurvey(build(), FAST);
    const reversed = runSurvey([...build()].reverse(), FAST);
    const key = (c: { key: string; trades: number; expectancyR: number }) =>
      `${c.key}|${c.trades}|${c.expectancyR.toFixed(9)}`;
    // Same cells, same pooled arithmetic. The reported timeframe comes from the
    // first market, which is identical here.
    expect(new Set(forward.styles.map(key))).toEqual(new Set(reversed.styles.map(key)));
  });
});

describe("what to avoid is a finding too", () => {
  it("names losing cells that independent markets agree on", () => {
    const s = runSurvey(
      [
        market("BTCUSDT", walk(2400, 1, 0.012)),
        market("XAUUSD", walk(2400, 2, 0.004)),
        market("SPX500", walk(2400, 3, 0.005)),
        market("EURUSD", walk(2400, 4, 0.003)),
      ],
      FAST,
    );
    const rec = recommendFor(s, "chop");
    // On a random walk every rule loses to costs, so there is plenty to avoid.
    expect(rec.avoid.length).toBeGreaterThan(0);
    for (const cell of rec.avoid) {
      expect(cell.expectancyR).toBeLessThan(0);
      expect(cell.blocs).toBeGreaterThanOrEqual(MIN_BLOCS);
    }
    expect(rec.text).toMatch(/avoid/i);
  });

  it("can be asked about rules rather than styles", () => {
    const s = runSurvey(
      [market("BTCUSDT", walk(2400, 1, 0.012)), market("XAUUSD", walk(2400, 2, 0.004))],
      FAST,
    );
    const rec = recommendFor(s, "trend", "rules");
    for (const cell of [...rec.holds, ...rec.avoid]) {
      expect(cell.specId).not.toBeNull();
      expect(cell.style).toBeNull();
    }
  });
});
