/**
 * The plan Autonomous mode proposes from a rule the terminal found itself.
 *
 * What is pinned:
 *  1. THE ENTRY IS THE FILL, not the signal bar's close. The backtest holds a
 *     signal and fills it at the next bar's open, charged half the spread plus
 *     slippage; a card quoting the close prints a price the engine never paid
 *     directly above that engine's figures.
 *  2. THE LEVELS ARE THE RULE'S OWN. `setup/plan.ts` would re-price the stop
 *     against an ATR band and force targets to 1R/2R, which would make the
 *     out-of-sample expectancy beside them a statement about a different trade.
 *  3. THE SAME EIGHT CHECKS as Manual mode, over the same environment.
 *  4. NOTHING CHECKED IS NOT "GO". An empty gate list must not read as a pass.
 *  5. A SIGNAL THE ENGINE WOULD HAVE DROPPED is refused, not offered.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import { autoPlan } from "../src/ui/model/autoplan";
import type { Account } from "../src/core/account";
import type { BarView } from "../src/chart/series";
import type { Discovered } from "../src/backtest/discovered";
import type { EntrySignal } from "../src/backtest/engine";
import { gatesFor, type GateEnvironment, type PlanFacts } from "../src/setup/gates";
import type { RuleSpec } from "../src/backtest/rules";

/** Plan facts good enough to ask WHICH checks run; their values are not the subject. */
const FACTS: PlanFacts = {
  plannedQty: 1,
  stopDistance: 1,
  thisTradeRiskPct: 0.5,
  stopAtrMultiple: 1.5,
};

const T0 = Date.UTC(2025, 0, 1);
const HOUR = 3_600_000;

/** Test-only bars: a deterministic ramp from 100. Never product data. */
function bars(n: number): BarView[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.5;
    return { t: T0 + i * HOUR, o: c, h: c + 0.2, l: c - 0.2, c, v: 10 };
  });
}

const SPEC: RuleSpec = {
  id: "r1",
  name: "Ramp",
  style: "custom",
  long: [["close", ">", "100"]],
  stop: { type: "pct", value: 1 },
  target: { type: "rr", value: 2 },
};

const row = (over: Partial<Discovered> = {}): Discovered => ({
  spec: SPEC,
  origin: "library",
  foundAt: T0,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 3_000,
  trials: 87,
  trades: 120,
  expectancy: 0.31,
  sharpe: 0.26,
  deflated: 0.05,
  hurdle: 0.21,
  costs: DEFAULT_COSTS,
  status: "unproven",
  ...over,
});

const account: Account = { currency: "USD", balance: 10_000, equity: 10_000, leverage: 1, riskPct: 1 };

/**
 * An environment in which nothing is wrong, so a failing check in a test below
 * is the one that test put there. Every threshold is the shipped default.
 */
const env = (over: Partial<GateEnvironment> = {}): GateEnvironment => ({
  dataAgeMs: 1_000,
  dataStaleAfterMs: 120_000,
  dataTransport: "socket",
  clockOffsetMs: 0,
  clockMatters: false,
  minutesToEvent: 24 * 60,
  eventName: null,
  embargoMinutes: 30,
  spread: 0.02,
  spreadKind: "dealing",
  spreadBudgetPct: 15,
  topOfBookQty: 1_000,
  openHeatPct: 0,
  maxHeatPct: 6,
  realisedTodayPct: 0,
  dailyLossLimitPct: 3,
  coverage: 0.99,
  coverageCeiling: 1,
  coverageFloor: 0.5,
  sourcesFailed: [],
  saneAtrBand: [0.5, 3],
  ...over,
});

/**
 * The signal a compiled `stop: {pct: 1}` rule produces on a close of 129.00:
 * risk = 1.29, so the stop is 127.71 and a 2R target is 131.58. Written out
 * rather than taken from `compileSpec`, so this fixture cannot agree with a
 * broken compiler.
 */
const signal: EntrySignal = { direction: "long", stop: 127.71, target: 131.58, reason: "close is above 100" };

const input = (over: Partial<Parameters<typeof autoPlan>[0]> = {}) => ({
  row: row(),
  signal,
  /* 60 bars: index 58 closes at 129.00 and is the signal bar; index 59 opens at
     129.50 and is the bar forming now, which is the one that fills. */
  index: 58,
  bars: bars(60),
  account,
  atr: 1.5,
  env: env(),
  ...over,
});

const ok = (p: ReturnType<typeof autoPlan>) => {
  if (!p.ok) throw new Error(`expected a plan, got a refusal: ${p.refusal}`);
  return p;
};

describe("the entry price", () => {
  /*
   * 129.50 * (1 + 0.0002 / 2 + 0.0001) = 129.50 * 1.0002 = 129.5259.
   * The signal bar's close is 129.00 and must not appear.
   */
  it("is the next bar's open charged half the spread and slippage", () => {
    const p = ok(autoPlan(input()));
    expect(p.entry).toBeCloseTo(129.5259, 6);
    expect(p.entry).not.toBeCloseTo(129, 4);
  });

  it("is null, not a guess, when the bar that fills it has not opened", () => {
    /* The signal is on the LAST bar in the array: nothing follows it yet. */
    const p = ok(autoPlan(input({ index: 59 })));
    expect(p.entry).toBeNull();
    expect(p.size).toBeNull();
    expect(p.entryNote).toContain("has not opened yet");
  });

  it("reports how far price has drifted from the fill, in R", () => {
    const p = ok(autoPlan(input()));
    /* r = 129.5259 - 127.71 = 1.8159. Last close is 129.50, which is
       129.50 - 129.5259 = -0.0259 away, i.e. -0.0143R. */
    expect(p.r).toBeCloseTo(1.8159, 4);
    expect(p.drift).toBeCloseTo(-0.0143, 3);
  });
});

describe("the levels", () => {
  it("are the rule's own, not an ATR band's", () => {
    const p = ok(autoPlan(input()));
    expect(p.stop).toBe(127.71);
    expect(p.target).toBe(131.58);
  });

  /*
   * A 3R rule must read as 3R. `buildPlan` hardcodes target1 at 1R and target2
   * at 2R, which is why it is not used here.
   */
  it("keep a 3R target at 3R", () => {
    const p = ok(autoPlan(input({ signal: { ...signal, target: 129.5259 + 3 * 1.8159 } })));
    expect(p.rr).toBeCloseTo(3, 2);
  });

  it("give the exit conditions in words when the rule has no target", () => {
    const exiting: RuleSpec = { ...SPEC, target: { type: "none" }, exitLong: [["rsi14", "<", "50"]] };
    const p = ok(
      autoPlan(input({ row: row({ spec: exiting }), signal: { ...signal, target: undefined } })),
    );
    expect(p.target).toBeNull();
    expect(p.rr).toBeNull();
    expect(p.exitRule ?? "").toMatch(/rsi/i);
    /* And what those exits were actually worth, so "no target" is not "no
       idea what this returns". */
    expect(p.provenR).toBe(0.31);
  });
});

describe("the checks", () => {
  /*
   * A SUPERSET OF MANUAL, NOT AN EQUAL SET — and stating it that way is the
   * point. This test asserted a length of eight, so it broke on the ADDITION of
   * the search check while it would have passed if a check had been swapped out
   * for another: the failure mode a count cannot see. What it exists to protect
   * is that the autonomous path is never WEAKER than the hand-drawn one, so it
   * now pins that, plus the one check only this path can make.
   *
   * The search row is the difference. A rule reaching this card won a sweep, and
   * the width of that sweep is a fact about the rule that a hand-drawn setup
   * simply does not have.
   */
  it("runs every check Manual runs, PLUS the one about the search", () => {
    const p = ok(autoPlan(input()));
    expect(p.checked).toBe(true);
    const ids = p.gates.map((g) => g.id);
    /* THE MANUAL SET, DERIVED RATHER THAN LISTED. A hand-written list of eight
       ids is the same defect as a hand-written count: it agrees with whatever it
       was written against. This asks the real evaluator for the set it produces
       with no search attached, which IS what the Manual desk passes. */
    const manual = gatesFor(env(), FACTS, null, null).map((g) => g.id);
    expect(manual.length).toBeGreaterThan(5);
    expect(manual).not.toContain("search");
    for (const id of manual) expect(ids, `lost the ${id} check`).toContain(id);
    expect(ids).toContain("search");
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.verdict.total).toBe(p.gates.length);
  });

  it("stands the trade down when a release is inside the embargo", () => {
    const p = ok(
      autoPlan(input({ env: env({ minutesToEvent: 14, eventName: "SNB Press Conference" }) })),
    );
    expect(p.verdict.kind).toBe("stand-down");
    expect(p.verdict.headline).toBe("NO TRADE");
    expect(p.verdict.blocking.map((g) => g.id)).toContain("news");
  });

  /*
   * THE OWNER CHOSE ALL EIGHT, so a rule whose own stop is outside the sane
   * band is stood down rather than exempted. atr 0.2 makes the 1.82 stop a
   * 9x multiple against a 0.5-3 band.
   */
  it("applies the stop band to a rule's own stop, and says so", () => {
    const p = ok(autoPlan(input({ atr: 0.2 })));
    expect(p.verdict.blocking.map((g) => g.id)).toContain("stop");
  });

  /*
   * NOTHING ASKED IS NOT NOTHING WRONG. An empty gate list read as "none
   * blocking, none unknown" would come back `go` with 0 of 0 passed.
   */
  it("never reports an unchecked market as go", () => {
    const p = ok(autoPlan(input({ env: null })));
    expect(p.checked).toBe(false);
    expect(p.gates).toHaveLength(0);
    expect(p.verdict.kind).toBe("unknown");
    expect(p.verdict.kind).not.toBe("go");
    expect(p.verdict.headline).toBe("CAN'T CHECK YET");
  });
});

describe("what it refuses", () => {
  /*
   * The engine drops a long whose stop is at or above the filled entry rather
   * than booking a trade that could never have existed. So must this.
   */
  it("refuses a signal the backtest itself would not have filled", () => {
    const p = autoPlan(input({ signal: { ...signal, stop: 131 } }));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    /* The refusal has to say WHY, not just decline: the operator's next
       question is whether the rule is broken or the market gapped. */
    expect(p.refusal).toContain("past the rule's own stop");
    expect(p.refusal).toContain("The backtest drops a signal like this");
  });

  it("refuses rather than sizing a trade with no risk in it", () => {
    const p = autoPlan(input({ signal: { ...signal, stop: 129.5259 } }));
    expect(p.ok).toBe(false);
  });
});
