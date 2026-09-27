import { describe, it, expect } from "vitest";
import {
  sizePosition,
  rewardToRisk,
  portfolioHeat,
  checkGuards,
  stopFromAtr,
  roundToStep,
  stepDecimals,
  DEFAULT_GUARDS,
  MIN_STOP_FRACTION,
  type Position,
} from "../src/risk/sizing";

describe("roundToStep", () => {
  // DOWN, always. Rounding up increases risk without saying so.
  it("rounds down, never up", () => {
    expect(roundToStep(0.0187, 0.001)).toBeCloseTo(0.018, 9);
    expect(roundToStep(0.0199, 0.001)).toBeCloseTo(0.019, 9);
  });

  it("leaves the value alone when there is no step", () => {
    expect(roundToStep(1.2345, undefined)).toBe(1.2345);
    expect(roundToStep(1.2345, 0)).toBe(1.2345);
  });

  it("survives binary float dust at an exact multiple", () => {
    expect(roundToStep(0.3, 0.1)).toBeCloseTo(0.3, 9);
    expect(roundToStep(70, 10)).toBe(70);
  });

  it("reports the decimals a step implies", () => {
    expect(stepDecimals(0.001)).toBe(3);
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(undefined)).toBe(8);
  });
});

describe("sizePosition — refusals", () => {
  const base = { equity: 10_000, riskPct: 1, entry: 100, stop: 95 };

  // The single most dangerous input in the tool.
  it("refuses a stop at the entry rather than returning infinity", () => {
    const r = sizePosition({ ...base, stop: 100 });
    expect(r.ok).toBe(false);
    expect(r.qty).toBe(0);
    expect(r.reason).toMatch(/not a position/i);
  });

  it("refuses a stop inside one basis point", () => {
    const r = sizePosition({ ...base, entry: 100, stop: 100 - 100 * (MIN_STOP_FRACTION / 2) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/basis point/i);
  });

  it("refuses non-positive equity, risk, entry and stop", () => {
    expect(sizePosition({ ...base, equity: 0 }).ok).toBe(false);
    expect(sizePosition({ ...base, riskPct: 0 }).ok).toBe(false);
    expect(sizePosition({ ...base, entry: -1 }).ok).toBe(false);
    expect(sizePosition({ ...base, stop: 0 }).ok).toBe(false);
  });

  it("refuses NaN inputs instead of propagating them", () => {
    expect(sizePosition({ ...base, equity: NaN }).ok).toBe(false);
    expect(sizePosition({ ...base, entry: NaN }).ok).toBe(false);
  });

  it("refuses when the risk budget buys less than one quantity step", () => {
    const r = sizePosition({
      equity: 100,
      riskPct: 0.1,
      entry: 70_000,
      stop: 69_000,
      instrument: { symbol: "BTCUSDT", qtyStep: 0.001 },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/quantity step/i);
  });

  it("refuses below the venue minimum quantity", () => {
    const r = sizePosition({
      ...base,
      instrument: { symbol: "X", qtyStep: 0.1, minQty: 100 },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/minimum/i);
  });

  it("refuses below the venue minimum notional", () => {
    const r = sizePosition({
      ...base,
      riskPct: 0.01,
      instrument: { symbol: "X", minNotional: 10_000 },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/notional/i);
  });
});

describe("sizePosition — arithmetic", () => {
  it("computes the textbook case exactly", () => {
    // 10,000 equity, 1% risk = 100 at risk. Stop 5 away => 20 units.
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 95 });
    expect(r.ok).toBe(true);
    expect(r.qty).toBeCloseTo(20, 9);
    expect(r.riskAmount).toBeCloseTo(100, 9);
    expect(r.riskPct).toBeCloseTo(1, 9);
    expect(r.notional).toBeCloseTo(2000, 9);
  });

  it("reads direction from where the stop sits", () => {
    expect(sizePosition({ equity: 1000, riskPct: 1, entry: 100, stop: 95 }).direction).toBe("long");
    expect(sizePosition({ equity: 1000, riskPct: 1, entry: 100, stop: 105 }).direction).toBe("short");
  });

  it("sizes a short off the same arithmetic", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 105 });
    expect(r.qty).toBeCloseTo(20, 9);
    expect(r.riskAmount).toBeCloseTo(100, 9);
  });

  it("applies a contract multiplier", () => {
    // 1 point of move on 1 contract is worth 10, so risk per contract is 50.
    const r = sizePosition({
      equity: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 95,
      instrument: { symbol: "F", contractSize: 10 },
    });
    expect(r.qty).toBeCloseTo(2, 9);
    expect(r.riskAmount).toBeCloseTo(100, 9);
  });

  it("reports stop distance as a percent of entry", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 200, stop: 190 });
    expect(r.stopDistancePct).toBeCloseTo(5, 9);
  });
});

describe("sizePosition — the risk you actually get", () => {
  // The headline defect in ordinary size calculators.
  it("reports post-rounding risk, not the requested risk", () => {
    const r = sizePosition({
      equity: 10_000,
      riskPct: 1,
      entry: 70_000,
      stop: 68_000,
      instrument: { symbol: "BTCUSDT", qtyStep: 0.001 },
    });
    expect(r.ok).toBe(true);
    // raw 0.05 exactly -> no drift here; the point is the fields exist and agree.
    expect(r.riskAmount).toBeCloseTo(r.qty * 2000, 6);
    expect(r.riskPct).toBeCloseTo((r.riskAmount / 10_000) * 100, 9);
    expect(r.requestedRiskPct).toBe(1);
  });

  it("keeps the unrounded quantity alongside the submittable one", () => {
    const r = sizePosition({
      equity: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 94.7,
      instrument: { symbol: "X", qtyStep: 1 },
    });
    expect(r.rawQty).toBeGreaterThan(r.qty);
    expect(Number.isInteger(r.qty)).toBe(true);
  });

  it("warns when rounding moved the real risk meaningfully", () => {
    const r = sizePosition({
      equity: 1_000,
      riskPct: 1,
      entry: 100,
      stop: 93,
      instrument: { symbol: "X", qtyStep: 1 },
    });
    // 10/7 = 1.43 -> 1 unit. Real risk 0.7%, not 1%.
    expect(r.qty).toBe(1);
    expect(r.riskPct).toBeCloseTo(0.7, 6);
    expect(r.warnings.join(" ")).toMatch(/rounding moved the real risk/i);
  });

  it("never rounds up into more risk than requested", () => {
    for (const stop of [94.1, 94.3, 94.9, 93.05]) {
      const r = sizePosition({
        equity: 10_000,
        riskPct: 1,
        entry: 100,
        stop,
        instrument: { symbol: "X", qtyStep: 1 },
      });
      expect(r.riskPct).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe("sizePosition — the exposure cap", () => {
  // A very tight stop turns 1% of equity into an impossible position.
  it("binds before the risk budget when the stop is tight", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.9 });
    expect(r.ok).toBe(true);
    expect(r.notionalPctOfEquity).toBeCloseTo(100, 6);
    expect(r.riskPct).toBeLessThan(1);
    expect(r.warnings.join(" ")).toMatch(/exposure cap bound/i);
  });

  it("does not bind on an ordinary stop", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 90 });
    expect(r.warnings.join(" ")).not.toMatch(/exposure cap bound/i);
    expect(r.riskPct).toBeCloseTo(1, 6);
  });

  // A 0.1% stop needs 1000% notional to put 1% of equity at risk, so a 500%
  // cap still binds — which is the cap doing exactly its job.
  it("still binds at 500% when the stop is 0.1% away", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.9, maxNotionalPct: 500 });
    expect(r.notionalPctOfEquity).toBeCloseTo(500, 6);
    expect(r.riskPct).toBeCloseTo(0.5, 6);
  });

  it("stops binding once the cap is raised past what the stop requires", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.9, maxNotionalPct: 1200 });
    expect(r.riskPct).toBeCloseTo(1, 6);
    expect(r.notionalPctOfEquity).toBeCloseTo(1000, 6);
    expect(r.warnings.join(" ")).not.toMatch(/exposure cap bound/i);
  });

  it("warns about leverage whenever notional exceeds equity", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.5, maxNotionalPct: 500 });
    expect(r.warnings.join(" ")).toMatch(/leverage/i);
  });
});

describe("sizePosition — costs and honesty", () => {
  it("computes round-trip fees and the break-even move", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 95, feesPct: 0.1 });
    expect(r.feeAmount).toBeCloseTo(r.notional * 0.001, 9);
    expect(r.breakEvenPct).toBeCloseTo(0.1, 9);
  });

  // Silence about costs is the lie; stating the omission is not.
  it("states that costs were excluded when none were supplied", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 95 });
    expect(r.assumptions.join(" ")).toMatch(/costs were not supplied/i);
  });

  it("always states that the stop is assumed to fill at its price", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 95 });
    expect(r.assumptions.join(" ")).toMatch(/gap|halt|thin book/i);
  });

  it("warns when fees are large relative to the risk", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.5, feesPct: 0.2 });
    expect(r.warnings.join(" ")).toMatch(/round-trip costs/i);
  });

  it("warns on a stop tight enough for spread to matter", () => {
    const r = sizePosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.95 });
    expect(r.warnings.join(" ")).toMatch(/spread and slippage/i);
  });
});

describe("rewardToRisk", () => {
  it("computes R for a long and a short", () => {
    expect(rewardToRisk(100, 95, 110).r).toBeCloseTo(2, 9);
    expect(rewardToRisk(100, 105, 90).r).toBeCloseTo(2, 9);
  });

  // The number that stops "3:1" being treated as a synonym for "good trade".
  it("reports the break-even win rate", () => {
    expect(rewardToRisk(100, 95, 110).breakEvenWinRate).toBeCloseTo(33.333, 2);
    expect(rewardToRisk(100, 95, 105).breakEvenWinRate).toBeCloseTo(50, 6);
    // 4:1 breaks even at 20%, not 25% — it is 1/(1+R), not 1/(R+2).
    expect(rewardToRisk(100, 95, 120).breakEvenWinRate).toBeCloseTo(20, 6);
  });

  it("refuses a target on the wrong side of entry", () => {
    expect(rewardToRisk(100, 95, 99).ok).toBe(false);
    expect(rewardToRisk(100, 105, 101).ok).toBe(false);
  });

  it("refuses a zero-width stop", () => {
    expect(rewardToRisk(100, 100, 110).ok).toBe(false);
  });

  it("refuses non-numbers", () => {
    expect(rewardToRisk(NaN, 95, 110).ok).toBe(false);
  });
});

describe("portfolioHeat", () => {
  const positions: Position[] = [
    { symbol: "BTCUSDT", direction: "long", qty: 0.1, entry: 70_000, stop: 68_000 },
    { symbol: "ETHUSDT", direction: "long", qty: 2, entry: 3_000, stop: 2_900 },
  ];

  it("sums open risk as a percent of equity", () => {
    const h = portfolioHeat(positions, 10_000);
    expect(h.openRisk).toBeCloseTo(200 + 200, 6);
    expect(h.heatPct).toBeCloseTo(4, 6);
  });

  it("separates gross from net exposure", () => {
    const h = portfolioHeat(
      [
        { symbol: "A", direction: "long", qty: 1, entry: 100, stop: 90 },
        { symbol: "B", direction: "short", qty: 1, entry: 100, stop: 110 },
      ],
      10_000,
    );
    expect(h.grossNotional).toBeCloseTo(200, 6);
    expect(h.netNotional).toBeCloseTo(0, 6);
  });

  // Heat computed over stopped positions alone is a FLOOR when some have none.
  it("names unprotected positions and says heat is a floor", () => {
    const h = portfolioHeat(
      [...positions, { symbol: "SOLUSDT", direction: "long", qty: 10, entry: 150, stop: null }],
      10_000,
    );
    expect(h.unprotected).toEqual(["SOLUSDT"]);
    expect(h.warnings.join(" ")).toMatch(/FLOOR/i);
  });

  it("still counts an unprotected position's notional", () => {
    const h = portfolioHeat([{ symbol: "A", direction: "long", qty: 10, entry: 150, stop: null }], 10_000);
    expect(h.grossNotional).toBeCloseTo(1500, 6);
    expect(h.openRisk).toBe(0);
  });

  it("ranks risk by symbol, largest first", () => {
    const h = portfolioHeat(positions, 10_000);
    expect(h.bySymbol.length).toBe(2);
    expect(h.bySymbol[0]!.risk).toBeGreaterThanOrEqual(h.bySymbol[1]!.risk);
  });

  it("aggregates two positions in the same symbol", () => {
    const h = portfolioHeat(
      [
        { symbol: "A", direction: "long", qty: 1, entry: 100, stop: 90 },
        { symbol: "A", direction: "long", qty: 1, entry: 101, stop: 91 },
      ],
      10_000,
    );
    expect(h.bySymbol.length).toBe(1);
    expect(h.bySymbol[0]!.risk).toBeCloseTo(20, 6);
  });

  it("warns when one symbol dominates the book", () => {
    const h = portfolioHeat(
      [
        { symbol: "BIG", direction: "long", qty: 100, entry: 100, stop: 90 },
        { symbol: "SMALL", direction: "long", qty: 1, entry: 100, stop: 90 },
      ],
      100_000,
    );
    expect(h.warnings.join(" ")).toMatch(/of your open risk/i);
  });

  it("handles an empty book", () => {
    const h = portfolioHeat([], 10_000);
    expect(h.heatPct).toBe(0);
    expect(h.warnings).toEqual([]);
  });
});

describe("checkGuards", () => {
  const base = { equity: 10_000, realisedToday: 0, openPositions: 0, currentHeatPct: 0 };

  it("passes a clean state", () => {
    const g = checkGuards(base);
    expect(g.pass).toBe(true);
    expect(g.breaches).toEqual([]);
  });

  it("breaches at the daily loss limit", () => {
    const g = checkGuards({ ...base, realisedToday: -300 });
    expect(g.pass).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/daily stop/i);
  });

  it("warns without breaching at two thirds of the daily limit", () => {
    const g = checkGuards({ ...base, realisedToday: -210 });
    expect(g.pass).toBe(true);
    expect(g.notes.join(" ")).toMatch(/two thirds/i);
  });

  // A profitable day must never read as a loss.
  it("treats a profit as zero loss", () => {
    const g = checkGuards({ ...base, realisedToday: 5_000 });
    expect(g.dailyLossPct).toBe(0);
    expect(g.pass).toBe(true);
  });

  it("breaches when the proposal would exceed the heat ceiling", () => {
    const g = checkGuards({ ...base, currentHeatPct: 5.5, proposedRiskPct: 1 });
    expect(g.pass).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/open risk would reach/i);
  });

  it("counts the proposed position against the position limit", () => {
    const g = checkGuards({ ...base, openPositions: DEFAULT_GUARDS.maxPositions, proposedRiskPct: 1 });
    expect(g.pass).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/past your limit/i);
  });

  it("does not invent a position when only checking state", () => {
    const g = checkGuards({ ...base, openPositions: DEFAULT_GUARDS.maxPositions });
    expect(g.pass).toBe(true);
  });

  it("honours a custom config", () => {
    const g = checkGuards({ ...base, realisedToday: -110, config: { ...DEFAULT_GUARDS, dailyLossPct: 1 } });
    expect(g.pass).toBe(false);
  });

  // The most important sentence in the module.
  it("always says it cannot see a broker or prevent an order", () => {
    expect(checkGuards(base).notes.join(" ")).toMatch(/cannot see your broker|prevent an order/i);
  });
});

describe("stopFromAtr", () => {
  it("places a long stop below and a short stop above", () => {
    expect(stopFromAtr(100, 2, 1.5, "long").stop).toBeCloseTo(97, 9);
    expect(stopFromAtr(100, 2, 1.5, "short").stop).toBeCloseTo(103, 9);
  });

  it("reports the distance as a percent", () => {
    expect(stopFromAtr(100, 2, 1.5, "long").distancePct).toBeCloseTo(3, 9);
  });

  it("refuses an unavailable ATR rather than returning the entry", () => {
    expect(stopFromAtr(100, NaN, 1.5, "long").ok).toBe(false);
    expect(stopFromAtr(100, 0, 1.5, "long").ok).toBe(false);
  });

  it("refuses a multiple that puts the stop at or below zero", () => {
    expect(stopFromAtr(100, 80, 2, "long").ok).toBe(false);
  });

  // It is arithmetic, and it says so — volatility is not structure.
  it("states that it does not know what level the stop protects", () => {
    expect(stopFromAtr(100, 2, 1.5, "long").note).toMatch(/does not know what level/i);
  });
});

/* ===========================================================================
   UNMEASURED INPUTS

   THE BUG THESE PIN, AND IT WAS THE WORST ONE FOUND IN THIS FILE.

   Every gate in `checkGuards` is a `>=` or `>` against a computed percentage,
   and every comparison against NaN is false. With account equity unset,
   `dailyLossPct` and `heatAfterPct` both came out NaN, every gate quietly
   evaluated to "not breached", and the function returned `pass: true` with an
   EMPTY breach list. Measured: down 900 on two open positions, proposing a
   third at 5%, and the answer was "clear".

   A risk guard that cannot measure must refuse and say what it could not read.
   The same rule the dock summary learned when an unmeasured viewport rendered
   as "fits without scrolling".
   ========================================================================= */

describe("guards that cannot be measured", () => {
  const live = {
    equity: 10_000,
    realisedToday: -900,
    openPositions: 2,
    currentHeatPct: 2,
    proposedRiskPct: 5,
  };

  it("still evaluates normally when everything is known", () => {
    const g = checkGuards(live);
    expect(g.measured).toBe(true);
    expect(g.pass).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/daily stop/);
  });

  it("REFUSES rather than passing when equity is unset", () => {
    for (const equity of [0, -1, NaN, undefined as unknown as number]) {
      const g = checkGuards({ ...live, equity });
      expect(g.pass, String(equity)).toBe(false);
      expect(g.measured, String(equity)).toBe(false);
      expect(g.breaches.join(" ")).toMatch(/equity is not set/i);
    }
  });

  /* The likeliest real occurrence: the ledger has not loaded yet at boot, so
     the day's P&L is undefined and the daily stop silently did not run. */
  it("REFUSES rather than passing when the day's P&L has not loaded", () => {
    const g = checkGuards({ ...live, realisedToday: undefined as unknown as number });
    expect(g.pass).toBe(false);
    expect(g.measured).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/has not passed; it has not been evaluated/i);
  });

  it("REFUSES rather than passing when open heat is not a number", () => {
    const g = checkGuards({ ...live, currentHeatPct: NaN });
    expect(g.pass).toBe(false);
    expect(g.breaches.join(" ")).toMatch(/heat ceiling cannot be checked/i);
  });

  /* The composite that was actually reachable: no equity means no heat, which
     means neither of the two gates that would have fired could fire. */
  it("does not return an empty breach list when nothing could be checked", () => {
    const h = portfolioHeat(
      [{ symbol: "BTC", direction: "long", qty: 1, entry: 100, stop: 90 }],
      NaN,
    );
    const g = checkGuards({ ...live, equity: NaN, currentHeatPct: h.heatPct });
    expect(g.pass).toBe(false);
    expect(g.breaches.length).toBeGreaterThan(0);
  });

  it("distinguishes a refusal from an unanswered question", () => {
    expect(checkGuards(live).measured).toBe(true);
    expect(checkGuards({ ...live, equity: NaN }).measured).toBe(false);
  });
});

describe("heat that cannot be measured", () => {
  const one = [{ symbol: "BTC" as const, direction: "long" as const, qty: 1, entry: 100, stop: 90 }];

  it("says so rather than returning a silent NaN", () => {
    const h = portfolioHeat(one, NaN);
    expect(h.measured).toBe(false);
    expect(h.warnings.join(" ")).toMatch(/equity is not set/i);
    /* The currency figure is still real and still worth showing. */
    expect(h.openRisk).toBe(10);
  });

  it("reports measured when equity is usable", () => {
    expect(portfolioHeat(one, 10_000).measured).toBe(true);
  });
});

describe("risk is directional", () => {
  /**
   * `Math.abs(entry - stop)` ignores which side you are on, so a long whose
   * trailing stop has moved ABOVE entry reported its locked-in profit as open
   * risk — and heat then refused trades on the strength of positions that
   * could not lose.
   */
  it("counts no risk for a long whose stop is already above entry", () => {
    const h = portfolioHeat(
      [{ symbol: "BTC", direction: "long", qty: 1, entry: 100, stop: 110 }],
      10_000,
    );
    expect(h.openRisk).toBe(0);
    expect(h.secured).toEqual(["BTC"]);
    expect(h.warnings.join(" ")).toMatch(/past entry in your favour/i);
  });

  it("counts no risk for a short whose stop is already below entry", () => {
    const h = portfolioHeat(
      [{ symbol: "BTC", direction: "short", qty: 1, entry: 100, stop: 90 }],
      10_000,
    );
    expect(h.openRisk).toBe(0);
    expect(h.secured).toEqual(["BTC"]);
  });

  it("still counts a normal long and a normal short", () => {
    const h = portfolioHeat(
      [
        { symbol: "A", direction: "long", qty: 1, entry: 100, stop: 90 },
        { symbol: "B", direction: "short", qty: 1, entry: 100, stop: 110 },
      ],
      10_000,
    );
    expect(h.openRisk).toBe(20);
    expect(h.secured).toEqual([]);
  });

  /* A secured position must not SUBTRACT from the heat of one that can lose. */
  it("does not let a risk-free position offset a risky one", () => {
    const h = portfolioHeat(
      [
        { symbol: "A", direction: "long", qty: 1, entry: 100, stop: 90 },
        { symbol: "B", direction: "long", qty: 1, entry: 100, stop: 130 },
      ],
      10_000,
    );
    expect(h.openRisk).toBe(10);
  });
});
