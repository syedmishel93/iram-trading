/**
 * WHAT THE BROKER ACTUALLY CHARGES, AGAINST WHAT THE BACKTEST ASSUMES.
 *
 * `DEFAULT_COSTS` charges a flat 2bp spread on every instrument, and CLAUDE.md
 * states why that matters: a cost model is a HURDLE, so an assumed cost is an
 * assumed conclusion — those numbers decide which rules survive a search.
 *
 * MEASURED against this operator's live broker spec:
 *
 *     EURUSD    6 points x 1e-05 = 0.00006   ~0.56bp   assumed 2bp
 *     XAUUSD   18 points x 0.01  = 0.18      ~0.42bp   assumed 2bp
 *     BTCUSD  600 points x 0.01  = 6.00      ~0.71bp   assumed 2bp
 *
 * The assumption is three to five times the real spread, which does not make
 * backtests conservative in a harmless way: it raises the bar every candidate
 * rule has to clear, so genuinely profitable rules are discarded as noise and
 * nothing on screen says why.
 *
 * THE ARITHMETIC IS PURE AND TESTED BECAUSE IT IS UNITS ALL THE WAY DOWN — a
 * point is not a pip, a spread in points is not a spread in price, and a spread
 * in price is not a fraction of price. CLAUDE.md records a unit defaulting
 * quietly costing a risk desk a factor of 100,000.
 */

import { describe, it, expect } from "vitest";
import { spreadFraction, compareCost, type BrokerSpec } from "../src/data/brokercosts";

const eurusd: BrokerSpec = {
  symbol: "EURUSD", spread_points: 6, point: 1e-5, contract_size: 100000,
  swap_long: -13.32, swap_short: -3.72, digits: 5, tick_value: 1, tick_size: 1e-5,
};

describe("spreadFraction", () => {
  it("converts points to a fraction of price", () => {
    /* 6 points x 1e-5 = 0.00006 of price; at 1.08 that is 5.56e-5, ~0.56bp. */
    const f = spreadFraction(eurusd, 1.08);
    expect(f).toBeCloseTo(0.00006 / 1.08, 12);
    expect(f * 10000).toBeCloseTo(0.5556, 3);
  });

  it("REFUSES without a price rather than assuming one", () => {
    /* A spread in POINTS cannot become a fraction without the price it is a
       fraction of. Defaulting the price is exactly the unit bug this file's
       header cites — it would produce a plausible number that is wrong. */
    expect(spreadFraction(eurusd, 0)).toBeNull();
    expect(spreadFraction(eurusd, Number.NaN)).toBeNull();
    expect(spreadFraction(eurusd, -1)).toBeNull();
  });

  it("refuses a spec with no usable point size", () => {
    expect(spreadFraction({ ...eurusd, point: 0 }, 1.08)).toBeNull();
    expect(spreadFraction({ ...eurusd, spread_points: 0 }, 1.08)).toBeNull();
  });
});

describe("compareCost", () => {
  it("names the ratio, and which way it runs", () => {
    const c = compareCost(eurusd, 1.08, 0.0002);
    expect(c.measuredBp).toBeCloseTo(0.5556, 3);
    expect(c.assumedBp).toBeCloseTo(2, 6);
    /* 2bp / 0.5556bp = 3.6x */
    expect(c.ratio).toBeCloseTo(3.6, 1);
    expect(c.verdict).toBe("over");
  });

  it("says when the assumption is too LOW, which is the dangerous direction", () => {
    /* Charging less than reality makes a backtest look better than it can be.
       The other direction only discards edges; this one manufactures them. */
    const wide = { ...eurusd, spread_points: 60 };
    const c = compareCost(wide, 1.08, 0.0002);
    expect(c.verdict).toBe("under");
    expect(c.ratio).toBeCloseTo(0.36, 2);
  });

  it("calls a close match close, rather than reporting a spurious ratio", () => {
    /* Within 15% either way is the same number for this purpose; printing
       "1.04x" invites a correction nobody needs. */
    const c = compareCost(eurusd, 1.08, 0.00006 / 1.08);
    expect(c.verdict).toBe("close");
  });

  it("refuses when the price is unknown, and says so", () => {
    const c = compareCost(eurusd, 0, 0.0002);
    expect(c.verdict).toBe("unknown");
    expect(c.measuredBp).toBeNull();
    expect(c.why).toMatch(/price/i);
  });
});
