/**
 * FRICTION ON A $500 ACCOUNT.
 *
 * `DEFAULT_COSTS` is a flat 2bp spread, 4bp commission, 1bp slippage — the same
 * three numbers for a 45-minute scalp and a two-week swing. They are ASSUMED,
 * and they set the hurdle every rule in the search has to clear, so they decide
 * which rules survive.
 *
 * At $500 the difference is not academic. A scalp targeting 0.5% pays its
 * friction on the full notional twice; a swing pays a smaller share of a bigger
 * move but carries overnight and across weekends. Charging one number for both
 * makes one of them a lie.
 *
 * WHAT THESE TESTS PIN
 *
 *  1. FRICTION IS A SHARE OF THE TARGET, and that share is the number worth
 *     reading. "9 basis points" means nothing; "18% of a 0.5% target" is the
 *     sentence that changes a decision.
 *  2. A SWING CARRIES AND A SCALP DOES NOT. Holding costs are charged per night
 *     held, and weekends count as the calendar does, not as trading days.
 *  3. THE SPREAD SAYS WHERE IT CAME FROM. Measured, estimated and assumed are
 *     three different claims, and a backtest that cannot tell them apart is one
 *     whose hurdle cannot be argued with. Binance klines carry no bid or ask at
 *     all, so a crypto spread is ESTIMATED at best — never measured.
 *  4. IT REFUSES RATHER THAN APPROXIMATING. An unknown venue is not the default
 *     venue.
 */

import { describe, expect, it } from "vitest";
import { frictionDrag, frictionFor, frictionShare, MODES, type Mode } from "../src/backtest/friction";

describe("friction by mode", () => {
  it("charges a scalp more, as a share of what it is trying to win", () => {
    const scalp = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    const swing = frictionFor({ mode: "swing", venue: "binance-spot", holdNights: 6 });
    /* The same round trip costs the same in basis points. What differs is what
       it is a share OF: a 0.5% target against a 6% one. */
    expect(frictionShare(scalp, MODES.scalp.typicalTargetPct)).toBeGreaterThan(
      frictionShare(swing, MODES.swing.typicalTargetPct),
    );
  });

  it("states the share as a fraction of the target, not as basis points", () => {
    const f = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    const share = frictionShare(f, 0.005);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    /* A 0.5% target against a round trip near 0.2% is a large share — the whole
       reason this file exists. Pinned loosely: the point is the magnitude, not
       a fee schedule that will change. */
    expect(share).toBeGreaterThan(0.1);
  });

  it("charges nothing for nights a scalp never holds", () => {
    const a = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    const b = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 3 });
    /* A scalp that somehow held three nights is a bug in the caller, not a
       cheaper trade. The mode says it does not carry, so the carry is zero and
       the reason names it. */
    expect(b.carryPct).toBe(0);
    expect(a.carryPct).toBe(0);
    expect(b.why).toMatch(/does not hold overnight/i);
  });

  it("charges a swing per night held, on a venue that actually finances", () => {
    /* SPOT CARRIES NOTHING. You own the asset; there is no financing to pay,
       and the first draft of this test asserted otherwise against binance-spot
       and failed — correctly. A perpetual pays funding, so that is where a
       per-night charge belongs. Keeping the two apart is the difference
       between a swing model that is right and one that taxes spot holders. */
    const one = frictionFor({ mode: "swing", venue: "binance-perp", holdNights: 1 });
    const six = frictionFor({ mode: "swing", venue: "binance-perp", holdNights: 6 });
    expect(six.carryPct).toBeGreaterThan(one.carryPct);
    expect(six.carryPct).toBeCloseTo(one.carryPct * 6, 10);
  });

  it("charges spot nothing overnight, because owning the asset costs no funding", () => {
    const spot = frictionFor({ mode: "swing", venue: "binance-spot", holdNights: 6 });
    expect(spot.ok).toBe(true);
    expect(spot.carryPct).toBe(0);
  });
});

describe("where the spread came from", () => {
  it("labels an assumed spread as assumed", () => {
    const f = frictionFor({ mode: "day", venue: "binance-spot", holdNights: 0 });
    expect(f.spreadBasis).toBe("assumed");
  });

  it("takes a supplied estimate and says it is an ESTIMATE, never measured", () => {
    /* Binance klines carry no bid or ask. The best available crypto spread is
       inferred from trade-side alternation, and calling that "measured" is the
       error this repository already fixed once by printing an estimate as a
       measurement. */
    const f = frictionFor({
      mode: "day",
      venue: "binance-spot",
      holdNights: 0,
      spread: { value: 0.00008, basis: "estimated" },
    });
    expect(f.spreadBasis).toBe("estimated");
    expect(f.costs.spread).toBeCloseTo(0.00008, 10);
  });

  it("accepts a measured spread only where bid and ask actually exist", () => {
    const f = frictionFor({
      mode: "day",
      venue: "dukascopy",
      holdNights: 0,
      spread: { value: 0.00012, basis: "measured" },
    });
    expect(f.spreadBasis).toBe("measured");
  });

  it("REFUSES a measured spread on a venue that publishes no quotes", () => {
    /* A caller passing `measured` for a kline-only venue has made a claim the
       data cannot support. Downgrading silently would launder it. */
    const f = frictionFor({
      mode: "day",
      venue: "binance-spot",
      holdNights: 0,
      spread: { value: 0.00008, basis: "measured" },
    });
    expect(f.spreadBasis).toBe("estimated");
    expect(f.why).toMatch(/no quotes|bid|ask/i);
  });
});

describe("refusing rather than approximating", () => {
  it("refuses an unknown venue instead of falling back to a default one", () => {
    const f = frictionFor({ mode: "day", venue: "nowhere" as never, holdNights: 0 });
    expect(f.ok).toBe(false);
    expect(f.why).toMatch(/venue/i);
  });

  it("is ok on a known venue", () => {
    expect(frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 }).ok).toBe(true);
  });

  it("gives every mode a target it is actually trying to win", () => {
    for (const k of Object.keys(MODES) as Mode[]) {
      expect(MODES[k].typicalTargetPct).toBeGreaterThan(0);
      expect(MODES[k].maxHoldMinutes).toBeGreaterThan(0);
    }
  });
});

/**
 * THE $500 CASE, AS ARITHMETIC RATHER THAN A CLAIM.
 *
 * The document that prompted this work says friction "can consume over 30% of
 * total returns" across 500 scalps on a small balance. That is checkable, and
 * checking it is the difference between a warning and a number.
 *
 * These pin the magnitudes, not a fee schedule — a venue changing its rates
 * should move them, and the test should then be re-read rather than re-tuned.
 */
describe("what this actually costs on $500", () => {
  it("makes a scalp pay a THIRD or more of its own target in friction", () => {
    const f = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    const share = frictionShare(f, MODES.scalp.typicalTargetPct);
    expect(share).toBeGreaterThan(0.33);
    /* The same round trip against a swing's target is a rounding error, which
       is the entire argument for charging by mode. */
    expect(frictionShare(f, MODES.swing.typicalTargetPct)).toBeLessThan(0.1);
  });

  it("shows 500 full-size scalps costing MORE THAN THE ACCOUNT in fees alone", () => {
    /* Not a rhetorical flourish: 500 round trips at ~0.23% of notional, with
       the whole $500 deployed each time, is more than $500 of friction. The
       document guessed 30% of returns; on these inputs it is over 100% of
       CAPITAL, and it is why position size and trade count belong in the
       simulation rather than in a footnote. */
    const f = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    const drag = frictionDrag(f, 500, 500, 500);
    expect(drag).toBeGreaterThan(1);
  });

  it("falls to something survivable once size is risk-bounded", () => {
    /* The same 500 trades at 1% risk with a 0.5% stop is roughly $100 of
       notional, not $500 — and the drag becomes a cost rather than a wipeout.
       This is the sizing engine earning its place. */
    const f = frictionFor({ mode: "scalp", venue: "binance-spot", holdNights: 0 });
    expect(frictionDrag(f, 500, 100, 500)).toBeLessThan(0.3);
  });
});
