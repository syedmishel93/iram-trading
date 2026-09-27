/**
 * THE LAST HOP: context series reaching a study — `backtest/headless.ts`.
 *
 * Everything underneath this was built and proved first — the look-ahead-free
 * join, the column builder, the conditioned field — and none of it does
 * anything until a job actually CARRIES the context series and the engine
 * receives the aligned columns. A conditioned rule whose column is NaN cannot
 * fire, and from outside that is indistinguishable from a rule that found no
 * signal: the run completes and reports a number.
 *
 * THE TEST THAT MATTERS IS `a conditioned rule fires WITH context and not
 * WITHOUT`. It is the only one that proves the wiring exists rather than
 * compiling. Everything else here guards a way it could silently stop working.
 *
 * THE SECOND IS `a shared context without the macro columns is not reused`.
 * `runBacktest()` reuses a cached context keyed on the BARS' IDENTITY, which says
 * nothing about whether that cache carries the context series this caller
 * asked for — so a sweep that built one plain context first would hand it to
 * every conditioned arm, each would read NaN, and 150 arms would silently never
 * fire while still raising the hurdle for everything else.
 */

import { describe, expect, it } from "vitest";
import { parseContext, parseJob, runJob } from "../src/backtest/headless";
import { makeContext, runBacktest, ZERO_COSTS, type BarView } from "../src/backtest/engine";
import { compileSpec } from "../src/backtest/rules";
import { buildMacroColumns } from "../src/backtest/macro";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** A rising series, so a "close above the open" style rule trades often. */
const bars = (n: number): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const px = 100 + Math.sin(i / 9) * 4 + i * 0.02;
    return { t: T0 + i * HOUR, o: px - 0.3, h: px + 0.6, l: px - 0.6, c: px, v: 100 + (i % 7) };
  });

/** Daily context bars stamped at the START of each day, as the archive holds them. */
const ctxBars = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, c: f(i) }));

/** `close > open`, gated on the dollar falling. */
const conditionedSpec = {
  id: "t:cond",
  name: "close above open, only while the dollar is falling",
  style: "custom" as const,
  long: [["close", ">", "open"], ["dxy_chg5", "<", "0"]] as never,
  stop: { type: "atr" as const, mult: 2 },
  target: { type: "rr" as const, value: 2 },
};

const plainSpec = { ...conditionedSpec, id: "t:plain", long: [["close", ">", "open"]] as never };

describe("a job carries its context series", () => {
  it("parses {SYMBOL: [{t,c}]} and sorts each ascending", () => {
    // `alignMacro` walks both series once together, so an out-of-order bar
    // would be read as the newest known value at the wrong moment.
    const got = parseContext({ DXY: [{ t: 3, c: 3 }, { t: 1, c: 1 }, { t: 2, c: 2 }] });
    expect(got?.["DXY"]?.map((b) => b.t)).toEqual([1, 2, 3]);
  });

  it("no context at all is null, not an empty map", () => {
    expect(parseContext(undefined)).toBeNull();
    expect(parseContext({})).toBeNull();
    expect(parseContext([])).toBeNull();
  });

  it("REFUSES a malformed series rather than dropping it", () => {
    // A silently dropped series leaves every conditioned arm reading NaN and
    // never firing, which looks exactly like a rule with no signal.
    expect(() => parseContext({ DXY: "nope" })).toThrow(/must be an array/);
    expect(() => parseContext({ DXY: [{ t: 1 }] })).toThrow(/finite t and c/);
    expect(() => parseContext({ DXY: [{ t: NaN, c: 1 }] })).toThrow(/finite t and c/);
  });

  it("parseJob aligns the context onto the job's own bars", () => {
    const b = bars(240);
    const job = {
      spec: plainSpec,
      bars: b,
      context: { DXY: ctxBars(20, (i) => 100 - i) },
    };
    const parsed = parseJob(job);
    expect(parsed.context).toBeTruthy();
    expect(parsed.opts.macro?.["dxy"]).toHaveLength(b.length);
    expect(parsed.opts.macro?.["dxy_chg5"]).toHaveLength(b.length);
  });

  it("a job with no context leaves `macro` unset, not filled with zeros", () => {
    const parsed = parseJob({ spec: plainSpec, bars: bars(120) });
    expect(parsed.context).toBeUndefined();
    expect(parsed.opts.macro).toBeUndefined();
  });

  it("the result SAYS which context it was given", () => {
    // A run that had none is not the same as one whose rules found nothing,
    // and from outside they look identical.
    const b = bars(300);
    const withCtx = runJob({ spec: plainSpec, bars: b, context: { DXY: ctxBars(30, () => 100) } });
    expect(withCtx.context).toEqual(["DXY"]);
    const without = runJob({ spec: plainSpec, bars: b });
    expect(without.context).toEqual([]);
  });
});

describe("the wiring actually reaches the engine", () => {
  const b = bars(400);
  const strat = compileSpec(conditionedSpec as never);

  it("A CONDITIONED RULE FIRES WITH CONTEXT AND NOT WITHOUT", () => {
    /* THE PROOF THAT THE HOP EXISTS. Without the columns every comparison
       against NaN is false, so the rule cannot trade; with a falling dollar it
       can. If this passed both ways the feature would be inert. */
    const falling = buildMacroColumns(
      b.map((x) => x.t),
      { DXY: ctxBars(40, (i) => 100 - i) },     // down every day
    ).columns;

    const withNone = runBacktest(strat, b, { costs: ZERO_COSTS });
    const withCtx = runBacktest(strat, b, { costs: ZERO_COSTS, macro: falling });

    expect(withNone.trades.length).toBe(0);
    expect(withCtx.trades.length).toBeGreaterThan(0);
  });

  it("and it does NOT fire when the state is false", () => {
    // A rising dollar means the gate is shut, so the same rule on the same
    // bars trades nothing — which is the state being read, not ignored.
    const rising = buildMacroColumns(
      b.map((x) => x.t),
      { DXY: ctxBars(40, (i) => 100 + i) },
    ).columns;
    expect(runBacktest(strat, b, { costs: ZERO_COSTS, macro: rising }).trades.length).toBe(0);
  });

  it("the unconditioned rule trades either way — the gate is the only difference", () => {
    // Guards against the conditioned run failing for some unrelated reason.
    const plain = compileSpec(plainSpec as never);
    expect(runBacktest(plain, b, { costs: ZERO_COSTS }).trades.length).toBeGreaterThan(0);
  });

  it("A SHARED CONTEXT WITHOUT THE MACRO COLUMNS IS NOT REUSED", () => {
    /* `runBacktest()` caches a context keyed on the BARS' IDENTITY, which says
       nothing about whether it carries the context series this caller asked
       for. A sweep that built one plain context first would hand it to every
       conditioned arm and each would read NaN — 150 arms silently never firing
       while still raising the hurdle for everything else. */
    const plainCtx = makeContext(b);
    const falling = buildMacroColumns(
      b.map((x) => x.t),
      { DXY: ctxBars(40, (i) => 100 - i) },
    ).columns;
    const out = runBacktest(strat, b, { costs: ZERO_COSTS, macro: falling }, plainCtx);
    expect(out.trades.length).toBeGreaterThan(0);
  });

  it("a matching shared context IS reused, so the optimisation still works", () => {
    const falling = buildMacroColumns(
      b.map((x) => x.t),
      { DXY: ctxBars(40, (i) => 100 - i) },
    ).columns;
    const shared = makeContext(b, falling);
    const a = runBacktest(strat, b, { costs: ZERO_COSTS, macro: falling }, shared);
    const c = runBacktest(strat, b, { costs: ZERO_COSTS, macro: falling });
    expect(a.trades.length).toBe(c.trades.length);
  });
});
