import { describe, it, expect } from "vitest";
import {
  INSTRUMENTS,
  findInstrument,
  pipValue,
  quoteToUsd,
  needsCrossRate,
  CROSS_RATE_SYMBOL,
  type InstrumentSpec,
} from "../src/risk/instruments";
import { calculate, NO_COSTS, MARGIN_CALL, type CostModel } from "../src/risk/calculator";

const spec = (symbol: string): InstrumentSpec => {
  const s = findInstrument(symbol);
  if (!s) throw new Error(`no spec for ${symbol}`);
  return s;
};

const EURUSD = spec("EURUSD");
const USDJPY = spec("USDJPY");
const GBPJPY = spec("GBPJPY");
const BTCUSD = spec("BTCUSD");
const XAUUSD = spec("XAUUSD");

describe("the instrument table", () => {
  it("has no duplicate symbols — the source table had SHIBUSD twice", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const i of INSTRUMENTS) {
      if (seen.has(i.symbol)) dupes.push(i.symbol);
      seen.add(i.symbol);
    }
    expect(dupes).toEqual([]);
  });

  it("holds the counts the module comment claims", () => {
    /* These numbers are asserted in prose in instruments.ts, in risk.css and in
       the repo's docs/HANDOVER.md, and all three were WRONG before this test existed — the
       comment said "66 of 71" for a table of 72. A count stated in a comment
       and nowhere else drifts the first time a row is added.

       The table grew from 72 to 129 when the picker started reading it: 31 more
       forex crosses and exotics, 2 metals, 6 indices and 18 equities. Those
       were all reachable only by typing the ticker from memory before, because
       the catalogue never merged this table in. */
    expect(INSTRUMENTS).toHaveLength(129);
    const quoteUsd = INSTRUMENTS.filter((i) => i.quote === "USD");
    const baseUsd = INSTRUMENTS.filter((i) => i.quote !== "USD" && i.base === "USD");
    const cross = INSTRUMENTS.filter(needsCrossRate);
    expect(quoteUsd).toHaveLength(83);
    expect(baseUsd).toHaveLength(12);
    expect(cross).toHaveLength(34);
    /* Exact = the two branches that need no external rate. */
    expect(quoteUsd.length + baseUsd.length).toBe(95);
    /* Every instrument lands in exactly one branch. */
    expect(quoteUsd.length + baseUsd.length + cross.length).toBe(INSTRUMENTS.length);
  });

  it("has a class for every row, so none can fall out of the picker", () => {
    /* An instrument with no class is one the symbol picker has no tab for,
       which is the exact way forex became unfindable. */
    const classes = new Set(["forex", "crypto", "perp", "metal", "index", "stock"]);
    for (const i of INSTRUMENTS) expect(classes.has(i.cls), i.symbol).toBe(true);
  });

  it("gives every instrument a positive pip and contract size", () => {
    for (const i of INSTRUMENTS) {
      expect(i.pip, i.symbol).toBeGreaterThan(0);
      expect(i.contractSize, i.symbol).toBeGreaterThan(0);
    }
  });

  it("names a convertible rate for every non-USD quote currency", () => {
    for (const i of INSTRUMENTS) {
      if (i.quote === "USD" || i.base === "USD") continue;
      expect(CROSS_RATE_SYMBOL[i.quote], `${i.symbol} quotes ${i.quote}`).toBeDefined();
    }
  });

  it("matches the feed's venue suffixes onto the table", () => {
    expect(findInstrument("BTCUSDT")?.symbol).toBe("BTCUSD");
    expect(findInstrument("ethusdc")?.symbol).toBe("ETHUSD");
    expect(findInstrument("EUR/USD")?.symbol).toBe("EURUSD");
    expect(findInstrument("NOTATHING")).toBeUndefined();
  });
});

describe("pip value, against first principles", () => {
  /* The identity the whole module rests on:
     pipValue = pip x contractSize x (USD per unit of quote). */
  it("is pip x contract for a dollar-quoted instrument", () => {
    expect(pipValue(EURUSD, 1.0842).value).toBeCloseTo(10, 10);
    expect(pipValue(BTCUSD, 68420).value).toBeCloseTo(1, 10);
    expect(pipValue(XAUUSD, 2352).value).toBeCloseTo(1, 10);
  });

  it("divides by the price when USD is the BASE, and does not need a second rate", () => {
    /* 0.01 x 100_000 = 1000 JPY per pip per lot; at 156.30 that is $6.398. */
    expect(pipValue(USDJPY, 156.3).value).toBeCloseTo(1000 / 156.3, 10);
  });

  it("reproduces the error in the constants it replaced", () => {
    /* The recovered table hardcoded 9.09 for every JPY pair — the value at a
       USD/JPY of about 110. This test exists to keep the correction honest: if
       someone reintroduces a constant, the magnitude of what it costs is here. */
    const legacyConstant = 9.09;
    const derived = pipValue(USDJPY, 156.3).value;
    expect(derived).toBeCloseTo(6.4, 1);
    expect(legacyConstant / derived - 1).toBeGreaterThan(0.4); // 42% high
  });

  it("refuses rather than guessing when a cross rate is missing", () => {
    const got = pipValue(GBPJPY, 198.6);
    expect(Number.isNaN(got.value)).toBe(true);
    expect(got.basis).toEqual({ kind: "unknown", rateSymbol: "USDJPY" });
  });

  it("converts a cross once the rate is supplied, and inverts USDxxx correctly", () => {
    /* GBP/JPY: 1000 JPY per pip per lot, converted at USD/JPY 156.30. The
       inversion is the classic silent bug — 1000 x 156.30 is also a number. */
    const got = pipValue(GBPJPY, 198.6, 156.3);
    expect(got.value).toBeCloseTo(1000 / 156.3, 8);
    expect(got.value).toBeLessThan(20);
  });

  it("uses an xxxUSD cross rate as-is rather than inverting it", () => {
    const eurgbp = spec("EURGBP");
    /* 10 GBP per pip per lot; at GBP/USD 1.27 that is $12.70. */
    expect(pipValue(eurgbp, 0.853, 1.27).value).toBeCloseTo(12.7, 8);
  });

  it("flags exactly the instruments that need a rate the price cannot supply", () => {
    const need = INSTRUMENTS.filter(needsCrossRate).map((i) => i.symbol).sort();
    expect(need).toEqual(
      [
        "AUDCAD", "AUDCHF", "AUDJPY", "AUDNZD", "AUS200", "CADCHF", "CADJPY",
        "CHFJPY", "EU50", "EURAUD", "EURCAD", "EURCHF", "EURCZK", "EURGBP",
        "EURHUF", "EURJPY", "EURNOK", "EURNZD", "EURPLN", "EURSEK", "EURTRY",
        "FRA40", "GBPAUD", "GBPCAD", "GBPCHF", "GBPJPY", "GBPNZD", "GER40",
        "HK50", "JPN225", "NZDCAD", "NZDCHF", "NZDJPY", "UK100",
      ].sort(),
    );
  });

  /**
   * The invariant behind the list above, which is what actually matters.
   *
   * A cross with no entry in `CROSS_RATE_SYMBOL` returns NaN from `pipValue`
   * and names no rate that would fix it — a silent hole in the calculator on
   * exactly the pairs whose pip value is least obvious. Adding 31 crosses and
   * exotics to the table without this check would have opened fourteen of them.
   */
  it("can name the rate that would resolve every cross", () => {
    for (const i of INSTRUMENTS.filter(needsCrossRate)) {
      const basis = pipValue(i, 1, undefined).basis;
      expect(basis.kind, i.symbol).toBe("unknown");
      if (basis.kind !== "unknown") throw new Error("unreachable");
      expect(basis.rateSymbol, i.symbol).toMatch(/^[A-Z]{6}$/);
      expect(Number.isFinite(pipValue(i, 1, 1.25).value), i.symbol).toBe(true);
    }
  });
});

describe("notional, which is where the old calculator broke", () => {
  const base = {
    balance: 10000,
    equity: 10000,
    leverage: 100,
    riskPct: 1,
    lots: 1,
    costs: NO_COSTS,
  } as const;

  it("is lots x contract x price for a dollar-quoted pair", () => {
    const r = calculate({ ...base, spec: EURUSD, direction: "buy", entry: 1.0842, stop: 1.08 });
    expect(r.notional).toBeCloseTo(108420, 4);
    expect(r.margin).toBeCloseTo(1084.2, 4);
  });

  it("is the contract size itself when USD is the base — the price cancels", () => {
    /* One lot of USD/JPY is 100,000 US DOLLARS. The old formula returned
       entry x lots x contract = 15.6 MILLION and called it dollars, so margin
       came out at $156,300 instead of $1,000 and the trade read as impossible. */
    const r = calculate({ ...base, spec: USDJPY, direction: "buy", entry: 156.3, stop: 155.8 });
    expect(r.notional).toBeCloseTo(100000, 6);
    expect(r.margin).toBeCloseTo(1000, 6);
    expect(r.canOpen).toBe(true);
  });

  it("keeps notional independent of the price for a USD-base pair", () => {
    const at = (px: number) =>
      calculate({ ...base, spec: USDJPY, direction: "buy", entry: px, stop: px - 0.5 }).notional;
    expect(at(100)).toBeCloseTo(at(200), 6);
  });

  it("satisfies notional = lots x contract x price x quoteToUsd for every instrument", () => {
    for (const i of INSTRUMENTS) {
      const price = 100;
      const rate = needsCrossRate(i) ? 1.25 : undefined;
      const conv = quoteToUsd(i, price, rate);
      const r = calculate({
        ...base,
        spec: i,
        direction: "buy",
        entry: price,
        stop: price * 0.99,
        ...(rate === undefined ? {} : { crossRate: rate }),
      });
      expect(r.ok, i.symbol).toBe(true);
      expect(r.notional, i.symbol).toBeCloseTo(1 * i.contractSize * price * conv.value, 6);
    }
  });
});

describe("lot sizing", () => {
  const base = {
    spec: EURUSD,
    balance: 10000,
    equity: 10000,
    leverage: 100,
    riskPct: 1,
    direction: "buy" as const,
    entry: 1.1,
    stop: 1.095,
    costs: NO_COSTS,
  };

  it("recommends the size that risks exactly the stated percent", () => {
    /* 50 pip stop, $10 per pip per lot, $100 of risk -> 0.2 lots. */
    const r = calculate({ ...base, lots: 0.2 });
    expect(r.stopPips).toBeCloseTo(50, 6);
    expect(r.riskAmount).toBeCloseTo(100, 6);
    expect(r.recommendedLots).toBeCloseTo(0.2, 6);
  });

  it("makes the recommendation self-consistent: trading it risks the rule exactly", () => {
    const r1 = calculate({ ...base, lots: 1 });
    const r2 = calculate({ ...base, lots: r1.recommendedLots });
    expect(r2.actualRiskPct).toBeCloseTo(base.riskPct, 8);
    expect(r2.withinRisk).toBe(true);
  });

  it("reports oversize against the rule rather than quietly resizing", () => {
    const r = calculate({ ...base, lots: 1 });
    expect(r.withinRisk).toBe(false);
    expect(r.actualRiskPct).toBeCloseTo(5, 6);
    expect(r.warnings.join(" ")).toContain("over the 1% rule");
  });

  it("scales the recommendation inversely with the stop distance", () => {
    const tight = calculate({ ...base, stop: 1.0975, lots: 0.1 }); // 25 pips
    const wide = calculate({ ...base, stop: 1.09, lots: 0.1 }); // 100 pips
    expect(tight.recommendedLots).toBeCloseTo(wide.recommendedLots * 4, 6);
  });
});

describe("what it refuses to answer", () => {
  const base = {
    spec: EURUSD,
    balance: 10000,
    equity: 10000,
    leverage: 100,
    riskPct: 1,
    lots: 0.1,
    costs: NO_COSTS,
  };

  it("blocks a stop sitting on the entry instead of returning infinity", () => {
    const r = calculate({ ...base, direction: "buy", entry: 1.1, stop: 1.1 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("not a trade");
    expect(Number.isNaN(r.recommendedLots)).toBe(true);
  });

  it("blocks a buy whose stop is above the entry rather than flipping the direction", () => {
    const r = calculate({ ...base, direction: "buy", entry: 1.1, stop: 1.12 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("stop below the entry");
  });

  it("blocks the same way for a sell", () => {
    const r = calculate({ ...base, direction: "sell", entry: 1.1, stop: 1.08 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("stop above the entry");
  });

  it("blocks a cross with no rate, and names the rate that would unblock it", () => {
    const r = calculate({ ...base, spec: GBPJPY, direction: "buy", entry: 198.6, stop: 198.1 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toContain("USDJPY");
    expect(r.blocked).toContain("JPY");
  });

  it("produces every figure once that rate arrives", () => {
    const r = calculate({
      ...base,
      spec: GBPJPY,
      direction: "buy",
      entry: 198.6,
      stop: 198.1,
      crossRate: 156.3,
    });
    expect(r.ok).toBe(true);
    expect(r.pipValue).toBeGreaterThan(0);
    expect(r.margin).toBeGreaterThan(0);
  });
});

describe("costs, and the reward that survives them", () => {
  const costs: CostModel = {
    spreadPips: 1.5,
    commissionPerLot: 7,
    swapPerNight: -2,
    nights: 3,
    slippagePips: 0.5,
  };
  const base = {
    spec: EURUSD,
    balance: 10000,
    equity: 10000,
    leverage: 100,
    riskPct: 1,
    direction: "buy" as const,
    entry: 1.1,
    stop: 1.095,
    takeProfit: 1.11,
    lots: 0.2,
    costs,
  };

  it("charges commission on both sides and swap per lot per night", () => {
    const r = calculate(base);
    expect(r.costBreakdown.commission).toBeCloseTo(7 * 0.2 * 2, 8);
    expect(r.costBreakdown.swap).toBeCloseTo(-2 * 3 * 0.2, 8);
    expect(r.costBreakdown.spread).toBeCloseTo(1.5 * 10 * 0.2, 8);
    expect(r.costBreakdown.slippage).toBeCloseTo(0.5 * 10 * 0.2, 8);
  });

  it("sums the breakdown exactly — no residual", () => {
    const c = calculate(base).costBreakdown;
    expect(c.spread + c.commission + c.swap + c.slippage).toBeCloseTo(c.total, 10);
  });

  it("takes costs off the win and adds them to the loss", () => {
    const r = calculate(base);
    expect(r.netProfit).toBeCloseTo(r.grossProfit - r.costBreakdown.total, 8);
    expect(r.netLoss).toBeCloseTo(r.grossLoss + r.costBreakdown.total, 8);
    expect(r.netRr).toBeLessThan(r.rr);
  });

  it("reports the move needed just to cover costs", () => {
    const r = calculate(base);
    /* total / (pipValue x lots) — pips of favourable movement before break-even. */
    expect(r.breakEvenPips).toBeCloseTo(r.costBreakdown.total / (10 * 0.2), 8);
  });

  it("warns when costs flip a winning ratio into a losing one", () => {
    /* 2:1 gross on a stop so tight that the fixed commission dominates. */
    const r = calculate({
      ...base,
      entry: 1.1,
      stop: 1.0999,
      takeProfit: 1.1002,
      lots: 0.01,
      costs: { ...NO_COSTS, commissionPerLot: 7 },
    });
    expect(r.rr).toBeGreaterThanOrEqual(1);
    expect(r.netRr).toBeLessThan(1);
    expect(r.warnings.join(" ")).toContain("after them it does not");
  });

  it("calls an empty cost model an assumption rather than zero cost", () => {
    const r = calculate({ ...base, costs: NO_COSTS });
    expect(r.costBreakdown.total).toBe(0);
    expect(r.assumptions.join(" ")).toContain("unfilled cost model");
  });

  it("says so when there is no target, instead of implying a reward", () => {
    const { takeProfit: _drop, ...noTp } = base;
    const r = calculate(noTp);
    expect(Number.isNaN(r.rr)).toBe(true);
    expect(Number.isNaN(r.netProfit)).toBe(true);
    expect(r.assumptions.join(" ")).toContain("No target given");
  });
});

describe("margin health", () => {
  const base = {
    spec: EURUSD,
    balance: 1000,
    equity: 1000,
    riskPct: 1,
    direction: "buy" as const,
    entry: 1.1,
    stop: 1.09,
    costs: NO_COSTS,
  };

  it("warns below a 100% margin level", () => {
    /* 1 lot at 1:100 needs ~$1,100 of margin against $1,000 of equity. */
    const r = calculate({ ...base, leverage: 100, lots: 1 });
    expect(r.canOpen).toBe(false);
    expect(r.warnings.join(" ")).toContain("cannot be opened");
  });

  it("is comfortable when the position is small against the equity", () => {
    const r = calculate({ ...base, leverage: 100, lots: 0.05 });
    expect(r.canOpen).toBe(true);
    expect(r.marginLevel).toBeGreaterThan(MARGIN_CALL);
    expect(r.warnings.join(" ")).not.toContain("Margin level");
  });

  it("reports an infinite margin level rather than dividing by zero at zero lots", () => {
    const r = calculate({ ...base, leverage: 100, lots: 0 });
    expect(r.marginLevel).toBe(Infinity);
    expect(r.warnings.join(" ")).toContain("Lot size is zero");
  });

  it("flags leverage above the venue cap", () => {
    const r = calculate({ ...base, spec: spec("SUIPERP"), leverage: 100, lots: 1, entry: 2, stop: 1.9 });
    expect(r.warnings.join(" ")).toContain("caps leverage at 1:50");
  });
});

describe("the R ladder", () => {
  it("steps away from entry by the stop distance, upward for a buy", () => {
    const r = calculate({
      spec: EURUSD,
      balance: 10000,
      equity: 10000,
      leverage: 100,
      riskPct: 1,
      direction: "buy",
      entry: 1.1,
      stop: 1.09,
      lots: 0.1,
      costs: NO_COSTS,
    });
    expect(r.rLevels.map((l) => l.price)).toEqual([1.11, 1.12, 1.1300000000000001].map((v) => expect.closeTo(v, 8)));
  });

  it("steps downward for a sell", () => {
    const r = calculate({
      spec: EURUSD,
      balance: 10000,
      equity: 10000,
      leverage: 100,
      riskPct: 1,
      direction: "sell",
      entry: 1.1,
      stop: 1.11,
      lots: 0.1,
      costs: NO_COSTS,
    });
    expect(r.rLevels[0]?.price).toBeCloseTo(1.09, 8);
    expect(r.rLevels[2]?.price).toBeCloseTo(1.07, 8);
  });
});
