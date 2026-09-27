/**
 * Studying a declarative rule, and the promise that it is the SAME study.
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * Not the arithmetic — `backtest/lab.ts` already has a suite for the sweep, the
 * walk-forward and the CSCV, and the spec path runs the identical `sweep`.
 * What is at risk is DIVERGENCE: a spec study that returns a thinner object, or
 * skips the PBO, or refuses on a different rule, would sit on the same screen
 * next to a family study and be read as comparable when it is not. So the first
 * test here compares the two studies' shapes directly, and the rest are about
 * the one thing the spec path has that the family path does not — a grid it had
 * to DERIVE, from numbers somebody wrote inside a rule.
 *
 * AND THE GRID IS WHERE THE HONESTY LIVES. A sweep that quietly held a
 * parameter fixed reports "nothing better was found" over a search it did not
 * run. Every held axis is asserted to be NAMED, not merely absent.
 */

import { describe, expect, it } from "vitest";
import {
  SPEC_GRID_CAP,
  runSpecStudy,
  runStudy,
  runSubjectStudy,
  specGrid,
  subjectLabel,
  type Study,
} from "../src/backtest/lab";
import { parseJob, parseSpec, runJob } from "../src/backtest/headless";
import { SPECS_BY_ID } from "../src/backtest/specs";
import type { RuleSpec } from "../src/backtest/rules";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** The same deterministic generator `lab.test.ts` uses: trends and reversions
 *  both occur, and nothing about it is random, so the suite cannot flake. */
function series(n: number): BarView[] {
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 17) * 0.8 + Math.sin(i / 61) * 1.6 + 0.005;
    const o = p;
    const c = p + Math.sin(i / 7) * 0.3;
    out.push({
      t: T0 + i * HOUR,
      o,
      h: Math.max(o, c) + 0.4,
      l: Math.min(o, c) - 0.4,
      c,
      v: 1000 + (i % 13) * 25,
    });
  }
  return out;
}

/* Fixtures. Each one exists to reach a different branch of `specGrid`, and the
   comment says which — a fixture whose purpose is not written down is one that
   gets "tidied" into the next fixture and takes a branch with it. */

/** Stop and target both varyable, no bounded column: the ordinary case. */
const PLAIN: RuleSpec = {
  id: "t-plain",
  name: "Plain EMA cross",
  style: "scalp",
  long: [["ema9", "crossabove", "ema21"]],
  short: [["ema9", "crossbelow", "ema21"]],
  exitLong: [["close", "<", "ema21"]],
  exitShort: [["close", ">", "ema21"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "rr", value: 2 },
};

/** No target, so the threshold axis has room under the cap. */
const THRESHOLD: RuleSpec = {
  ...PLAIN,
  id: "t-threshold",
  name: "ADX-gated cross",
  long: [["adx", ">", "25"], ["ema9", "crossabove", "ema21"]],
  short: [["adx", ">", "25"], ["ema9", "crossbelow", "ema21"]],
  target: { type: "none" },
};

/** One bounded column, two different numbers: not varied, and said so. */
const AMBIGUOUS: RuleSpec = {
  ...PLAIN,
  id: "t-ambiguous",
  name: "RSI band",
  long: [["rsi", "<", "30"]],
  short: [["rsi", ">", "70"]],
  target: { type: "none" },
};

/** ONE threshold, three points from the top of its own range. Long only, on
 *  purpose: a mirrored short would trip the ambiguous-column branch instead
 *  and this test would pass while checking something else entirely. */
const AT_THE_EDGE: RuleSpec = {
  id: "t-edge",
  name: "RSI extreme",
  style: "reversion",
  long: [["rsi", ">", "97"]],
  exitLong: [["close", "<", "ema21"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "none" },
};

/** Nothing varyable at all: an 80% stop is outside the band the lab will
 *  invent neighbours inside, there is no target, and no bounded column. */
const FIXED: RuleSpec = {
  ...PLAIN,
  id: "t-fixed",
  name: "Wide fixed stop",
  stop: { type: "pct", value: 80 },
  target: { type: "none" },
};

describe("a spec study is the same study", () => {
  it("returns every field a family study returns, and no fewer", () => {
    const bars = series(2400);
    const fromSpec = runSpecStudy(PLAIN, bars);
    const fromFamily = runStudy("ema", bars);
    expect(Object.keys(fromSpec).sort()).toEqual(Object.keys(fromFamily).sort());
  });

  it("walks forward and computes PBO, like the family path — not one or the other", () => {
    const s = runSpecStudy(PLAIN, series(2400));
    expect(s.walk.folds.length).toBeGreaterThan(0);
    expect(s.overfit.splits).toBeGreaterThan(0);
    expect(s.promotion.checks.length).toBeGreaterThan(0);
    expect(s.headline.verdict.length).toBeGreaterThan(0);
    // A study with trades has regime slices; one without has an empty list and
    // not a missing field, which is what the family path promises too.
    expect(Array.isArray(s.regimes)).toBe(true);
  });

  it("says what it studied, and carries the rule that was studied", () => {
    const s = runSpecStudy(PLAIN, series(2400));
    expect(s.subject.kind).toBe("spec");
    expect(s.subject.id).toBe("t-plain");
    // The spec TRAVELS with the study. A rule is editable at runtime, so an id
    // alone would name whatever the rule has become by the time this is read.
    expect(s.subject.kind === "spec" && s.subject.spec.stop).toEqual({ type: "atr", mult: 2 });
    expect(subjectLabel(s.subject)).toBe("Plain EMA cross");

    const f = runStudy("rsi", series(2400));
    expect(f.subject).toEqual({ kind: "family", id: "rsi" });
    expect(subjectLabel(f.subject)).toBe("RSI reversion");
  });

  it("is deterministic — the same bars give the same verdict", () => {
    const a = runSpecStudy(PLAIN, series(2400));
    const b = runSpecStudy(PLAIN, series(2400));
    expect(a.headline).toEqual(b.headline);
    expect(a.configs.map((c) => c.score)).toEqual(b.configs.map((c) => c.score));
  });

  it("dispatches on the subject, so a job does not have to know which call to make", () => {
    const bars = series(2400);
    const viaSubject = runSubjectStudy({ kind: "spec", id: PLAIN.id, spec: PLAIN }, bars);
    expect(viaSubject.configs.map((c) => c.id)).toEqual(runSpecStudy(PLAIN, bars).configs.map((c) => c.id));
    expect(runSubjectStudy({ kind: "family", id: "ema" }, bars).subject).toEqual({
      kind: "family",
      id: "ema",
    });
  });
});

describe("refusing is a result here too", () => {
  it("refuses too little history, and says how much it needed", () => {
    // 26-bar warm-up on this rule, so the floor is 104 bars.
    const s = runSpecStudy(PLAIN, series(80));
    expect(s.headline.standing).toBe("refused");
    expect(s.headline.why).toMatch(/not enough/);
    expect(s.headline.why).toMatch(/this rule/);
    expect(s.configs).toHaveLength(0);
    expect(s.bestRun).toBeNull();
    // Still a whole Study: a refusal is not a thinner object.
    expect(s.subject).toEqual({ kind: "spec", id: "t-plain", spec: PLAIN });
  });

  it("refuses a rule that is not testable, naming the token", () => {
    const broken = { ...PLAIN, id: "t-broken", long: [["nosuch", ">", "1"]] } as unknown as RuleSpec;
    const s = runSpecStudy(broken, series(2400));
    expect(s.headline.standing).toBe("refused");
    expect(s.headline.why).toContain("nosuch");
    expect(s.configs).toHaveLength(0);
  });
});

describe("the derived grid", () => {
  it("varies the stop and the target, and lands on the family grid's own values", () => {
    const g = specGrid(PLAIN);
    // 2 x ATR and 2 x risk become 1.5 / 2 / 3 — the same three reward-to-risk
    // values `familyGrid` sweeps by hand. Asserted as literals, not read back
    // out of the thing under test.
    expect(g.axes.map((a) => a.values)).toEqual([
      [1.5, 2, 3],
      [1.5, 2, 3],
    ]);
    expect(g.strategies).toHaveLength(9);
    expect(g.held).toEqual([]);
  });

  it("never exceeds the cap, on any of the 25 shipped specs", () => {
    // The cap is pinned as a LITERAL, not read back out of the module: with
    // only `<= SPEC_GRID_CAP` asserted, raising the cap would raise the test
    // with it and a 27-config sweep would arrive unannounced.
    expect(SPEC_GRID_CAP).toBe(12);
    expect(SPECS_BY_ID.size).toBe(25);
    for (const spec of SPECS_BY_ID.values()) {
      const n = specGrid(spec).strategies.length;
      // Three values per axis, so 1, 3 and 9 are the only reachable sizes.
      expect([1, 3, 9]).toContain(n);
      expect(n).toBeLessThanOrEqual(12);
    }
  });

  it("holds a third axis rather than growing to 27, and names what it held", () => {
    // The shipped Donchian breakout has a stop, a target AND an ADX threshold.
    const spec = SPECS_BY_ID.get("donchian-breakout") as RuleSpec;
    const g = specGrid(spec);
    expect(g.strategies).toHaveLength(9);
    expect(g.axes).toHaveLength(2);
    const reason = g.held.join(" ");
    expect(reason).toContain("ADX(14)");
    expect(reason).toContain("27");
    expect(reason).toContain(String(SPEC_GRID_CAP));
  });

  it("varies a bounded threshold when there IS room under the cap", () => {
    const g = specGrid(THRESHOLD);
    expect(g.axes.map((a) => a.what)).toEqual(["stop (× ATR)", "ADX(14) threshold"]);
    expect(g.axes[1]?.values).toEqual([20, 25, 30]);
    expect(g.strategies).toHaveLength(9);
    // The rule has ADX in the long group and in the short group. Moving one
    // without the other would make the rule asymmetric under the same name.
    const twenty = g.strategies.find((s) => s.params["threshold"] === 20);
    expect(twenty?.rules.entry).toContain("ADX(14) is above 20");
    expect(twenty?.rules.entry.match(/ADX\(14\) is above 20/g)).toHaveLength(2);
    expect(twenty?.rules.entry).not.toContain("above 25");
  });

  it("holds a column that appears with two different thresholds", () => {
    const g = specGrid(AMBIGUOUS);
    expect(g.axes.map((a) => a.what)).toEqual(["stop (× ATR)"]);
    const reason = g.held.join(" ");
    expect(reason).toContain("RSI(14)");
    expect(reason).toContain("30");
    expect(reason).toContain("70");
  });

  it("holds a threshold whose neighbours leave the column's own range", () => {
    // RSI > 97 has no 102. A condition outside its column's range never fires,
    // and a config that never trades is a hole in the grid, not a variant.
    const g = specGrid(AT_THE_EDGE);
    expect(g.axes.map((a) => a.what)).toEqual(["stop (× ATR)"]);
    expect(g.held.join(" ")).toMatch(/0-100/);
    expect(g.strategies).toHaveLength(3);
  });

  it("gives every variant a distinct id", () => {
    // Two configs sharing an id collide in the study's `runs` map, and one
    // config's equity curve is then reported under the other's row.
    const ids = specGrid(SPECS_BY_ID.get("donchian-breakout") as RuleSpec).strategies.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a spec with nothing to vary", () => {
  it("studies it as ONE configuration, unchanged", () => {
    const g = specGrid(FIXED);
    expect(g.strategies).toHaveLength(1);
    // Unchanged means unchanged: no id suffix, no invented neighbour.
    expect(g.strategies[0]?.id).toBe("t-fixed");
    expect(g.strategies[0]?.params["stop"]).toBe(80);
    expect(g.held.join(" ")).toContain("was not varied");
  });

  it("does not report that single backtest as a search", () => {
    const s = runSpecStudy(FIXED, series(2400));
    expect(s.configs).toHaveLength(1);
    expect(s.overfit.splits).toBe(0);
    // PBO of 0 over nothing is easy to read as "no overfitting risk". Something
    // on the study has to say otherwise, in words.
    expect(s.warnings.join(" ")).toContain("single backtest");
    expect(s.warnings.join(" ")).toContain("not a search");
  });
});

describe("the trial count", () => {
  it("is configs.length, and it equals the grid the study actually walked", () => {
    // The number a caller deflates by. One row per grid entry, so the two
    // cannot disagree unless the sweep stopped early without saying so.
    const s = runSpecStudy(PLAIN, series(2400));
    expect(s.configs.length).toBe(specGrid(PLAIN).strategies.length);
    expect(s.configs.length).toBe(9);

    const f = runStudy("ema", series(2400));
    expect(f.configs.length).toBe(12);
  });

  it("is zero when nothing ran, rather than the size of the grid that did not", () => {
    expect(runSpecStudy(PLAIN, series(80)).configs.length).toBe(0);
    expect(runJob({ spec: PLAIN, bars: series(80), opts: {} }).configs).toBe(0);
  });

  it("is what the job reports", () => {
    const job = runJob({ spec: PLAIN, bars: series(2400), opts: {} });
    expect(job.configs).toBe(job.study.configs.length);
    expect(job.configs).toBe(9);
  });
});

describe("a job crossing a process boundary", () => {
  const bars = series(300).map((b) => ({ ...b }));

  it("still accepts a family job, unchanged", () => {
    const parsed = parseJob({ family: "ema", bars, opts: { riskPerTrade: 0.01 } });
    expect(parsed.subject).toEqual({ kind: "family", id: "ema" });
    expect(parsed.bars).toHaveLength(300);
    expect(parsed.opts.riskPerTrade).toBe(0.01);
  });

  it("accepts a spec job", () => {
    const parsed = parseJob({ spec: PLAIN, bars, opts: {} });
    expect(parsed.subject.kind).toBe("spec");
    expect(parsed.subject.id).toBe("t-plain");
  });

  it("refuses a job that names neither subject", () => {
    expect(() => parseJob({ bars })).toThrow(/neither/);
  });

  it("refuses a job that names both — picking one would be a guess", () => {
    expect(() => parseJob({ family: "ema", spec: PLAIN, bars })).toThrow(/both/);
  });

  it("refuses a spec whose shape would throw inside the validator", () => {
    // `validateSpec` reads `spec.stop.type` directly, so the shape check has to
    // come first or a bad job is a TypeError two layers from its cause.
    expect(() => parseSpec({ ...PLAIN, stop: 7 })).toThrow(/spec.stop must be an object/);
    expect(() => parseSpec({ ...PLAIN, stop: { type: "atr" } })).toThrow(/finite number/);
    expect(() => parseSpec({ ...PLAIN, target: { type: "wishful", value: 2 } })).toThrow(/spec.target.type/);
    expect(() => parseSpec({ ...PLAIN, style: "aggressive" })).toThrow(/spec.style/);
    expect(() => parseSpec({ ...PLAIN, long: "ema9 > ema21" })).toThrow(/array of conditions/);
    expect(() => parseSpec({ ...PLAIN, id: "" })).toThrow(/non-empty/);
  });

  it("refuses a spec the editor's own validator would refuse, with the same words", () => {
    expect(() => parseSpec({ ...PLAIN, long: [["nosuch", ">", "1"]] })).toThrow(
      /is not an indicator this build computes/,
    );
  });

  it("round-trips a spec through JSON without changing the study", () => {
    // What the worker actually receives is text. A spec that survives the
    // engine in memory and not on the pipe is a defect only the server sees.
    const wire = JSON.parse(JSON.stringify({ spec: PLAIN, bars: series(2400), opts: {} })) as unknown;
    const viaWire: Study = runJob(wire).study;
    const direct = runSpecStudy(PLAIN, series(2400));
    expect(viaWire.configs.map((c) => [c.id, c.score])).toEqual(direct.configs.map((c) => [c.id, c.score]));
    expect(viaWire.headline).toEqual(direct.headline);
  });
});
