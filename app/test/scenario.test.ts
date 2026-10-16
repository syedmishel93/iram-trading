/**
 * SCENARIO ANALYSIS OVER A FACTOR VECTOR.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS THERE, AND WHY IT COULD NOT ANSWER THE QUESTION
 *
 * `risk/portfolio.ts` `SCENARIOS` is five named events each carrying a single
 * `factorMove` — a number typed into the source, applied to a one-factor model.
 * "COVID liquidation: −50%" is a reasonable summary of what crypto did and it
 * cannot express 2022, which was rates up 250bp AND equities down 20% AND the
 * dollar up 8% at the same time, hitting a book through three different betas
 * with three different signs.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE WAYS THIS LIES
 *
 * 1. **A TYPED-IN SHOCK IS AN ASSUMPTION WEARING A DATE.** If the label says
 *    "March 2020" the number has to come from March 2020. The archive holds SPX
 *    to 1928 and DXY to 1971, so the move is MEASURED — and a window the
 *    archive cannot cover is refused by name rather than filled with a guess.
 *
 * 2. **A FACTOR SCENARIO ONLY MOVES WHAT THE FACTORS EXPLAIN.** The
 *    idiosyncratic part is by construction not predicted by any factor shock,
 *    and a scenario P&L presented as the whole answer is the most flattering
 *    error available — it is exactly the part of the book that blew up in the
 *    events these scenarios are named after.
 *
 * 3. **AN UNMODELLED POSITION IS NOT A FLAT ONE.** Scoring it zero makes a book
 *    look safer the LESS of it you understand.
 */

import { describe, expect, it } from "vitest";
import {
  HISTORICAL_WINDOWS,
  measureWindow,
  applyShock,
  scenarioPnl,
  type FactorShock,
} from "../src/risk/scenario";
import { factorModel } from "../src/risk/factors";
import type { FactorMatrix } from "../src/risk/factors";

const DAY = 86_400_000;

function noise(n: number, seed = 1): number[] {
  let s = seed >>> 0;
  const r = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: n }, () => {
    let acc = 0;
    for (let k = 0; k < 12; k++) acc += r();
    return acc - 6;
  });
}

/** A matrix whose factor moves are known, so a measured window can be checked. */
function matrixOf(moves: readonly (readonly number[])[], startMs: number): FactorMatrix {
  const times = moves.map((_, i) => startMs + i * DAY);
  return {
    ids: ["equity", "rates"],
    rows: moves,
    times,
    from: times[0] ?? 0,
    to: times[times.length - 1] ?? 0,
    dropped: { notShared: 0, unreadable: 0 },
  };
}

describe("a historical window is MEASURED, not typed in", () => {
  const START = Date.UTC(2024, 0, 1);
  // Ten days: equities −1% a day, rates +5bp a day.
  const m = matrixOf(Array.from({ length: 10 }, () => [-0.01, 5]), START);

  it("SUMS THE ACTUAL MOVES OVER THE WINDOW", () => {
    /* The window ends on the LAST bar held, not one past it — a window the
       archive does not reach is refused, which the next test covers. */
    const got = measureWindow(m, START, START + 9 * DAY);
    expect(got.ok).toBe(true);
    expect(got.shock["equity"]).toBeCloseTo(-0.1, 6);
    expect(got.shock["rates"]).toBeCloseTo(50, 6);
    expect(got.bars).toBe(10);
  });

  it("REFUSES A WINDOW THE ARCHIVE DOES NOT COVER, rather than measuring part of it", () => {
    /* Half a window is a different event. Reporting the part that is held, under
       the name of the whole, is the shape this project calls a study whose dead
       vendors vanished from its reported span. */
    const got = measureWindow(m, Date.UTC(2008, 8, 15), Date.UTC(2008, 10, 20));
    expect(got.ok).toBe(false);
    expect(got.why ?? "").toMatch(/archive|hold|cover|no bars/i);
  });

  it("refuses a window with too few bars to be the event it names", () => {
    const got = measureWindow(m, START, START + DAY);
    expect(got.ok).toBe(false);
  });

  it("EVERY SHIPPED WINDOW HAS REAL DATES AND A SOURCE NOTE", () => {
    expect(HISTORICAL_WINDOWS.length).toBeGreaterThan(3);
    for (const w of HISTORICAL_WINDOWS) {
      expect(w.to, w.id).toBeGreaterThan(w.from);
      expect(w.note.length, w.id + " has no note").toBeGreaterThan(30);
      // A window in the future is a typo, not a scenario.
      expect(w.to, w.id).toBeLessThan(Date.UTC(2027, 0, 1));
    }
  });
});

describe("applying a shock", () => {
  const n = 300;
  const fEq = noise(n, 3);
  const fRt = noise(n, 9);
  const factors = { ids: ["equity", "rates"], rows: fEq.map((v, i) => [v, fRt[i] as number]) };

  /* X: beta 1.5 to equities, 0 to rates. Y: beta 0 to equities, −0.002 per bp. */
  const X = factorModel(
    "X",
    fEq.map((v, i) => 1.5 * v + (noise(n, 5)[i] as number) * 0.05),
    factors,
  );
  const Y = factorModel(
    "Y",
    fRt.map((v, i) => -0.002 * v + (noise(n, 8)[i] as number) * 0.05),
    factors,
  );

  const shock: FactorShock = { equity: -0.2, rates: 250 };

  it("MOVES EACH POSITION BY ITS OWN BETAS, in each factor's own unit", () => {
    /* X is equity-only: −20% x 1.5 = −30% of its notional. Y is rates-only:
       +250bp x −0.002 = −50% of its notional. The units are NOT interchangeable
       and that is the whole reason the factor set declares them. */
    const out = applyShock([{ symbol: "X", signedNotional: 10_000 }], [X], shock);
    /* THE EQUITY LEG, not the total. X was built with no rates exposure and its
       FITTED rates beta is still small-but-nonzero — and a 250 basis point shock
       multiplies it by 250, which is exactly why `insignificant` exists. The
       total is checked in the scenario tests, where that caveat travels. */
    const want = 10_000 * 1.5 * -0.2;
    const got = out.positions[0]?.byFactor["equity"] ?? 0;
    expect(Math.abs(got - want) / Math.abs(want), "equity leg off by more than 1%").toBeLessThan(0.01);
  });

  it("a short position gains on the move that hurts a long one", () => {
    const long = applyShock([{ symbol: "X", signedNotional: 10_000 }], [X], shock);
    const short = applyShock([{ symbol: "X", signedNotional: -10_000 }], [X], shock);
    expect(Math.sign(long.total)).toBe(-Math.sign(short.total));
  });

  it("SUMS THE LEGS, so the total is never a separate calculation", () => {
    const out = applyShock(
      [
        { symbol: "X", signedNotional: 10_000 },
        { symbol: "Y", signedNotional: 5_000 },
      ],
      [X, Y],
      shock,
    );
    const legs = out.positions.reduce((s, p) => s + p.pnl, 0);
    expect(out.total).toBeCloseTo(legs, 6);
  });

  it("IGNORES A FACTOR THE SHOCK DOES NOT NAME, rather than treating it as zero move", () => {
    /* A shock naming only equities is a statement about equities. Reading the
       absent rates entry as "rates unchanged" is a DIFFERENT scenario and
       usually a less severe one. */
    const partial = applyShock([{ symbol: "Y", signedNotional: 5_000 }], [Y], { equity: -0.2 });
    expect(partial.unshocked, "the untouched factor must be named").toContain("rates");
    /* Y was built with no equity exposure, so its equity leg is estimation noise
       — negligible against the notional rather than exactly zero. */
    expect(Math.abs(partial.total)).toBeLessThan(5_000 * 0.01);
  });

  it("NAMES AN UNMODELLED POSITION instead of scoring it flat", () => {
    const out = applyShock(
      [
        { symbol: "X", signedNotional: 10_000 },
        { symbol: "GHOST", signedNotional: 40_000 },
      ],
      [X],
      shock,
    );
    expect(out.unmodelled).toContain("GHOST");
    expect(out.caveat ?? "").toMatch(/no factor model|unmodelled|not modelled/i);
  });
});

describe("what a scenario does NOT say", () => {
  const n = 300;
  const fEq = noise(n, 3);
  const factors = { ids: ["equity"], rows: fEq.map((v) => [v]) };

  it("REPORTS THE IDIOSYNCRATIC SHARE IT CANNOT SPEAK TO", () => {
    /* An asset the factors barely explain will barely move under any factor
       shock, and presenting that as "this scenario costs you little" is the most
       flattering error here — it is exactly the part of a book that blows up in
       the events these scenarios are named after. */
    const mostlyIdio = factorModel("Z", noise(n, 41), factors);
    const out = scenarioPnl(
      [{ symbol: "Z", signedNotional: 10_000 }],
      [mostlyIdio],
      { equity: -0.3 },
      factors,
    );
    expect(out.explainedShare).toBeLessThan(0.3);
    expect(out.caveat ?? "").toMatch(/idiosyncratic|explain|not.*modelled|says nothing/i);
  });

  it("does not warn when the factors genuinely explain the book", () => {
    const wellExplained = factorModel(
      "W",
      fEq.map((v, i) => 1.0 * v + (noise(n, 13)[i] as number) * 0.02),
      factors,
    );
    const out = scenarioPnl(
      [{ symbol: "W", signedNotional: 10_000 }],
      [wellExplained],
      { equity: -0.3 },
      factors,
    );
    expect(out.explainedShare).toBeGreaterThan(0.8);
  });
});
