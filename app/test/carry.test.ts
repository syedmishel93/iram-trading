/**
 * THE COST THE ENGINE CHARGED AS ZERO — overnight financing.
 *
 * MEASURED BEFORE THIS EXISTED. `backtest/friction.ts` is a complete venue- and
 * mode-aware cost model with a `carryPerNight` for every venue, and it had NO
 * IMPORTER ANYWHERE. The engine charged a flat three-number cost and no
 * financing at all, so against its own round trip of 0.1200% ex-carry:
 *
 *     5-night swing        carry is 29% of total cost   charged as zero
 *     two-week hold        carry is 54% of total cost   charged as zero
 *     two-month position   carry is 83% of total cost   charged as zero
 *
 * Every swing and position result the search has ever ranked was flattered, and
 * nothing on screen said so. A cost model is a hurdle, so an uncharged cost is
 * a hurdle nobody had to clear.
 *
 * THE TEST THAT MATTERS IS `carry makes the same trade on the same bars worse`.
 * It is the only one that proves the charge reaches the ACCOUNT rather than
 * being computed and reported beside an untouched number — which is exactly the
 * state `friction.ts` was already in.
 *
 * THE SECOND IS `spot carries nothing`. You own the asset; there is no
 * financing to pay. A model that charges both penalises the cheaper instrument,
 * and this repository has already recorded a test failing correctly on that.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COSTS,
  ZERO_COSTS,
  nightsBetween,
  runBacktest,
  type BarView,
  type Costs,
  type Strategy,
} from "../src/backtest/engine";
import { frictionFor, PERP_FUNDINGS_PER_DAY, VENUES } from "../src/backtest/friction";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1); // midnight UTC, so the night count is unambiguous

/** Daily bars rising by one a bar, so a far target is hit at a known bar. */
const daily = (n: number): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + i;
    return { t: T0 + i * DAY, o: c - 0.25, h: c + 0.5, l: c - 0.5, c, v: 1000 };
  });

/** Enters long once, at bar 5, with a far stop and a target ten higher. */
const oneTrade: Strategy = {
  id: "t:one",
  label: "one long, held for days",
  warmup: 5,
  entry: (ctx, i) =>
    i === 5
      ? { direction: "long", stop: 50, target: (ctx.close[i] as number) + 10, reason: "held" }
      : null,
};

/** Everything off except the carry, so nothing else can move the number. */
const withCarry = (rate: number): Costs => ({ ...ZERO_COSTS, carryPerNight: rate });

describe("counting the nights a position was held", () => {
  it("is the number of UTC midnights crossed, not the elapsed hours", () => {
    // 22:00 to 02:00 is four hours and one night; 10:00 to 15:00 is five hours
    // and none. A charge driven by elapsed time would have both the wrong way.
    expect(nightsBetween(T0 + 22 * HOUR, T0 + 26 * HOUR)).toBe(1);
    expect(nightsBetween(T0 + 10 * HOUR, T0 + 15 * HOUR)).toBe(0);
  });

  it("counts a full week as seven, which is what a week of financing costs", () => {
    // FX pays a triple swap on Wednesday for the weekend value dates, so the
    // calendar count and the weekly total agree. Skipping Saturday and Sunday
    // would undercharge every position held over a weekend by two nights.
    expect(nightsBetween(T0, T0 + 7 * DAY)).toBe(7);
  });

  it("never returns a negative, however the caller orders its arguments", () => {
    expect(nightsBetween(T0 + 3 * DAY, T0)).toBe(0);
    expect(nightsBetween(NaN, T0)).toBe(0);
  });
});

describe("the engine charges it", () => {
  const bars = daily(40);

  it("CARRY MAKES THE SAME TRADE ON THE SAME BARS WORSE", () => {
    /* THE PROOF THAT THE CHARGE REACHES THE ACCOUNT. `friction.ts` computed a
       carry for a year and nothing read it, and a carry that is reported but
       not subtracted is the same defect with a number beside it. */
    const free = runBacktest(oneTrade, bars, { costs: withCarry(0) });
    const paid = runBacktest(oneTrade, bars, { costs: withCarry(0.0003) });

    const a = free.trades[0];
    const b = paid.trades[0];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    // The same trade: same entry bar, same exit bar. Only the charge differs.
    expect(b!.entryIndex).toBe(a!.entryIndex);
    expect(b!.exitIndex).toBe(a!.exitIndex);
    expect(b!.returnPct).toBeLessThan(a!.returnPct);
  });

  it("charges exactly the rate times the nights, and states both", () => {
    // Pins the RELATIONSHIP rather than a magic number, with an absolute check
    // on the nights so the relationship cannot be satisfied by zero of them.
    const rate = 0.0003;
    const free = runBacktest(oneTrade, bars, { costs: withCarry(0) });
    const paid = runBacktest(oneTrade, bars, { costs: withCarry(rate) });
    const t = paid.trades[0]!;

    expect(t.nightsHeld).toBe(nightsBetween(t.entryTime, t.exitTime));
    expect(t.nightsHeld).toBeGreaterThan(4);
    expect(t.carryPct).toBeCloseTo(rate * t.nightsHeld, 12);
    expect(free.trades[0]!.returnPct - t.returnPct).toBeCloseTo(t.carryPct, 12);
  });

  it("a longer hold pays more at the same rate", () => {
    const rate = 0.0003;
    const shortHold = runBacktest(oneTrade, bars, { costs: withCarry(rate) }).trades[0]!;
    const slower: Strategy = {
      ...oneTrade,
      entry: (ctx, i) =>
        i === 5
          ? { direction: "long", stop: 50, target: (ctx.close[i] as number) + 25, reason: "held" }
          : null,
    };
    const longHold = runBacktest(slower, bars, { costs: withCarry(rate) }).trades[0]!;
    expect(longHold.nightsHeld).toBeGreaterThan(shortHold.nightsHeld);
    expect(longHold.carryPct).toBeGreaterThan(shortHold.carryPct);
  });

  it("SPOT CARRIES NOTHING, so a zero rate leaves the result untouched", () => {
    // You own the asset. A model that charges financing on spot quietly
    // penalises the cheaper instrument.
    const t = runBacktest(oneTrade, bars, { costs: withCarry(0) }).trades[0]!;
    expect(t.carryPct).toBe(0);
    expect(VENUES["binance-spot"]!.carryPerNight).toBe(0);
  });

  it("an intraday trade crosses no midnight and pays no carry", () => {
    // The charge follows the nights actually held, not a mode somebody
    // declared: a rule that is out inside the session cannot be charged.
    const hourly: BarView[] = Array.from({ length: 30 }, (_, i) => {
      const c = 100 + i;
      return { t: T0 + i * HOUR, o: c - 0.25, h: c + 0.5, l: c - 0.5, c, v: 1000 };
    });
    const quick: Strategy = {
      id: "t:quick",
      label: "in and out inside the day",
      warmup: 5,
      entry: (ctx, i) =>
        i === 5
          ? { direction: "long", stop: 50, target: (ctx.close[i] as number) + 2, reason: "quick" }
          : null,
    };
    const t = runBacktest(quick, hourly, { costs: withCarry(0.0003) }).trades[0]!;
    expect(t.nightsHeld).toBe(0);
    expect(t.carryPct).toBe(0);
  });

  it("the run reports what carry cost in total, summed from the trades it booked", () => {
    // A total nobody can see is a total nobody argues with.
    const paid = runBacktest(oneTrade, bars, { costs: withCarry(0.0003) });
    const summed = paid.trades.reduce((s, t) => s + t.carryPct, 0);
    expect(paid.friction.carryPct).toBeCloseTo(summed, 12);
    expect(paid.friction.carryPct).toBeGreaterThan(0);
  });

  it("DOES NOT SAY NOTHING WAS HELD OVERNIGHT WHEN 350 NIGHTS WERE", () => {
    /* Read off a real run through the shipped worker: a swing holding 350 nights
       at a ZERO rate printed "No position was held overnight, so nothing was
       financed". Every number on the line was correct and the sentence described
       a different run — which is worse than being visibly wrong, because nothing
       looks off. A zero rate and zero nights are different facts. */
    const held = runBacktest(oneTrade, bars, { costs: withCarry(0) });
    expect(held.friction.nights).toBeGreaterThan(0);
    expect(held.friction.carryPct).toBe(0);
    expect(held.friction.why).not.toContain("No position was held overnight");
    expect(held.friction.why).toContain("charged nothing for them");

    // And a genuinely intraday run still says the simple thing.
    const hourly: BarView[] = Array.from({ length: 30 }, (_, i) => {
      const c = 100 + i;
      return { t: T0 + i * HOUR, o: c - 0.25, h: c + 0.5, l: c - 0.5, c, v: 1000 };
    });
    const quick: Strategy = {
      id: "t:quick2",
      label: "out inside the day",
      warmup: 5,
      entry: (ctx, i) =>
        i === 5
          ? { direction: "long", stop: 50, target: (ctx.close[i] as number) + 2, reason: "quick" }
          : null,
    };
    const flat = runBacktest(quick, hourly, { costs: withCarry(0.0003) });
    expect(flat.friction.nights).toBe(0);
    expect(flat.friction.why).toContain("No position was held overnight");
  });

  it("DEFAULT_COSTS states a carry rather than omitting one", () => {
    // Omission was the defect: a field nobody set read as a cost nobody pays.
    expect(DEFAULT_COSTS.carryPerNight).toBeGreaterThan(0);
    expect(ZERO_COSTS.carryPerNight).toBe(0);
  });
});

describe("the venue rates the engine is handed", () => {
  it("frictionFor hands back the RATE, so the engine charges the real hold", () => {
    // `FrictionInput.holdNights` is a guess about a typical trade; the engine
    // knows each trade's own hold. Passing the rate through means the two
    // cannot disagree.
    const f = frictionFor({ mode: "swing", venue: "mt5", holdNights: 5 });
    expect(f.ok).toBe(true);
    expect(f.costs.carryPerNight).toBe(VENUES["mt5"]!.carryPerNight);
  });

  it("a mode that cannot hold overnight is handed a ZERO RATE, not just a zero total", () => {
    // Handing the engine a rate for a scalp would let the engine reinstate a
    // cost this mode has already said it does not pay.
    const f = frictionFor({ mode: "scalp", venue: "mt5", holdNights: 3 });
    expect(f.costs.carryPerNight).toBe(0);
    expect(f.carryPct).toBe(0);
  });

  it("A PERPETUAL'S FUNDING IS PER FUNDING PERIOD, NOT PER NIGHT", () => {
    /* THE UNIT ERROR. Binance charges funding every eight hours, so a published
       0.01% is 0.03% a night. The venue table called the 8-hour figure a
       per-night rate and undercharged every perp swing threefold — the same
       class as the lots-versus-units bug, where a unit that defaults is a wrong
       answer with no symptom. */
    expect(PERP_FUNDINGS_PER_DAY).toBe(3);
    expect(VENUES["binance-perp"]!.carryPerNight).toBeCloseTo(0.0001 * PERP_FUNDINGS_PER_DAY, 12);
  });
});
