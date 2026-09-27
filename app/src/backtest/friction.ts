/**
 * What a trade costs to make, by the way you are trading.
 *
 * `DEFAULT_COSTS` charges a flat 2bp spread, 4bp commission and 1bp slippage
 * for everything. Those three numbers are ASSUMED, and they set the hurdle
 * every rule in the search has to clear — so they decide which rules survive.
 * Charging a 45-minute scalp and a two-week swing the same makes one of them
 * a fiction.
 *
 * THE NUMBER THAT MATTERS IS A SHARE, NOT A RATE
 * "Nine basis points" is unreadable. "Eighteen per cent of a 0.5% target" is a
 * sentence that changes a decision, and on a $500 account across five hundred
 * scalps it is the difference between an edge and a slow bleed. `frictionShare`
 * exists so nothing has to do that division at a call site and get it wrong.
 *
 * WHERE THE SPREAD COMES FROM IS PART OF THE ANSWER
 * Binance klines carry no bid and no ask. The best available crypto spread is
 * INFERRED from trade-side alternation in aggTrades, and this repository has
 * already shipped an estimate printed as a measurement once. So the basis
 * travels with the number, a venue declares whether it publishes quotes at all,
 * and a caller claiming `measured` where the data cannot support it is
 * downgraded WITH A REASON rather than quietly believed.
 *
 * THE FEE SCHEDULES BELOW ARE PUBLISHED RATES, NOT MEASURED ONES
 * They are a starting point a real fill should replace. Every one is marked,
 * and `basis` on the result says so, because a hurdle built from a rate card
 * is a weaker claim than one built from your own fills.
 */

import type { Costs } from "./engine";

export type Mode = "scalp" | "day" | "swing";

export interface ModeSpec {
  readonly label: string;
  /** Longest a position of this kind stays open. */
  readonly maxHoldMinutes: number;
  /** Whether a position can still be open at the session roll. */
  readonly holdsOvernight: boolean;
  /**
   * The move this mode is trying to capture, as a fraction of price.
   *
   * Not a prediction — the DENOMINATOR for `frictionShare`. Friction only
   * means something next to what it is being paid out of.
   */
  readonly typicalTargetPct: number;
  readonly why: string;
}

export const MODES: Readonly<Record<Mode, ModeSpec>> = {
  scalp: {
    label: "Scalp",
    maxHoldMinutes: 45,
    holdsOvernight: false,
    typicalTargetPct: 0.005,
    why: "1m–5m bars, out inside the hour. Friction is the dominant term.",
  },
  day: {
    label: "Day",
    maxHoldMinutes: 60 * 8,
    holdsOvernight: false,
    typicalTargetPct: 0.015,
    why: "15m–1h bars, closed before the session settles, so nothing carries.",
  },
  swing: {
    label: "Swing",
    maxHoldMinutes: 60 * 24 * 14,
    holdsOvernight: true,
    typicalTargetPct: 0.06,
    why: "4h–1d bars over 2–14 days. Carry and weekend gaps are real costs.",
  },
};

export interface VenueSpec {
  readonly label: string;
  /** Taker fee per side, as a fraction of notional. PUBLISHED, not measured. */
  readonly takerPerSide: number;
  /** Whether this venue's history carries a bid and an ask at all. */
  readonly publishesQuotes: boolean;
  /** Financing per night held, as a fraction of notional. */
  readonly carryPerNight: number;
  /** A spread to assume when nothing better is supplied. */
  readonly assumedSpread: number;
}

/**
 * How many times a day a perpetual settles funding.
 *
 * Binance settles at 00:00, 08:00 and 16:00 UTC. It is a named constant because
 * `carryPerNight` is a PER-NIGHT field and the published rate is per period, and
 * a bare `* 3` in a table is a unit nobody can see.
 */
export const PERP_FUNDINGS_PER_DAY = 3;

/**
 * The venues this engine knows how to charge for.
 *
 * A venue that is not here is REFUSED rather than defaulted to another one:
 * a hurdle built from the wrong fee schedule is wrong in the direction that
 * promotes strategies, and it would be invisible.
 */
export const VENUES: Readonly<Record<string, VenueSpec>> = {
  "binance-spot": {
    label: "Binance spot",
    takerPerSide: 0.001,
    publishesQuotes: false,
    carryPerNight: 0,
    assumedSpread: 0.0001,
  },
  "binance-perp": {
    label: "Binance perpetual",
    takerPerSide: 0.0005,
    publishesQuotes: false,
    /* THE PUBLISHED RATE IS PER FUNDING PERIOD, AND THIS FIELD IS PER NIGHT.
       Binance settles funding every eight hours, so its documented 0.01% base
       rate is 0.03% a night. This field held the 8-hour figure under a per-night
       name and undercharged every perpetual swing threefold — the same class as
       the lots-versus-units defect, where a unit that goes unstated is a wrong
       answer with no symptom. The multiplication is written out rather than
       folded into a literal so the unit cannot go missing again. */
    carryPerNight: 0.0001 * PERP_FUNDINGS_PER_DAY,
    assumedSpread: 0.0001,
  },
  dukascopy: {
    label: "Dukascopy (FX, metals)",
    takerPerSide: 0,
    publishesQuotes: true,
    carryPerNight: 0.00008,
    assumedSpread: 0.00012,
  },
  mt5: {
    label: "Your MT5 broker",
    takerPerSide: 0,
    publishesQuotes: true,
    carryPerNight: 0.0001,
    assumedSpread: 0.00015,
  },
};

export type SpreadBasis = "measured" | "estimated" | "assumed";

export interface FrictionInput {
  readonly mode: Mode;
  readonly venue: string;
  /** Nights the position is held. Ignored by a mode that does not carry. */
  readonly holdNights: number;
  /** A better spread than the venue's default, with where it came from. */
  readonly spread?: { readonly value: number; readonly basis: SpreadBasis };
}

export interface Friction {
  readonly ok: boolean;
  readonly costs: Costs;
  /** Financing for the nights held, as a fraction of notional. */
  readonly carryPct: number;
  readonly spreadBasis: SpreadBasis;
  /** Round trip, everything in, as a fraction of notional. */
  readonly roundTripPct: number;
  readonly why: string;
}

const REFUSED: Costs = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };

/**
 * What one round trip costs, in this mode, on this venue.
 *
 * `slippage` stays the engine's own assumption: it is not a published rate and
 * nothing here can measure it. It is charged per side, like the engine does.
 */
export function frictionFor(input: FrictionInput): Friction {
  const mode = MODES[input.mode];
  const venue = VENUES[input.venue];
  if (venue === undefined || mode === undefined) {
    return {
      ok: false,
      costs: REFUSED,
      carryPct: 0,
      spreadBasis: "assumed",
      roundTripPct: 0,
      why: `no fee schedule for venue "${input.venue}" — add one rather than charging another venue's rates`,
    };
  }

  const notes: string[] = [];

  /* THE SPREAD, AND WHETHER THE CLAIM ABOUT IT SURVIVES THE VENUE.
     A caller can only claim `measured` where the venue's history actually
     carries a bid and an ask. Anywhere else the best it can be is an estimate,
     and it is downgraded out loud. */
  let spread = venue.assumedSpread;
  let spreadBasis: SpreadBasis = "assumed";
  if (input.spread !== undefined) {
    spread = input.spread.value;
    spreadBasis = input.spread.basis;
    if (spreadBasis === "measured" && !venue.publishesQuotes) {
      spreadBasis = "estimated";
      notes.push(
        `${venue.label} publishes no bid or ask in its history, so this spread is an estimate, not a measurement`,
      );
    }
  }

  /* CARRY. A mode that does not hold overnight cannot be charged for nights,
     whatever the caller passes — and the discrepancy is worth naming, because
     a scalp reporting three nights held is a bug upstream. */
  let carryPct = 0;
  if (!mode.holdsOvernight) {
    if (input.holdNights > 0) {
      notes.push(`a ${mode.label.toLowerCase()} does not hold overnight, so no carry was charged`);
    }
  } else {
    carryPct = venue.carryPerNight * Math.max(0, input.holdNights);
  }

  const costs: Costs = {
    spread,
    commission: venue.takerPerSide,
    slippage: 0.0001,
    /* THE RATE TRAVELS, NOT THE TOTAL. `holdNights` above is a guess about a
       typical trade of this mode; the engine knows what each trade actually
       held, so it gets the per-night rate and does its own multiplication. A
       mode that cannot hold overnight hands over a ZERO RATE rather than a zero
       total, or the engine would reinstate a cost this mode has already said it
       does not pay. */
    carryPerNight: mode.holdsOvernight ? venue.carryPerNight : 0,
  };

  /* Round trip: half the spread plus slippage on each side — the engine's own
     fill model — plus commission on each side, plus the carry. */
  const perSide = costs.spread / 2 + costs.slippage;
  const roundTripPct = perSide * 2 + costs.commission * 2 + carryPct;

  return {
    ok: true,
    costs,
    carryPct,
    spreadBasis,
    roundTripPct,
    why: notes.join("; "),
  };
}

/**
 * Friction as a share of the move being attempted, 0..1.
 *
 * The number to put on screen. A round trip of 22bp is meaningless on its own
 * and is 44% of a 0.5% scalp target.
 */
export function frictionShare(f: Friction, targetPct: number): number {
  if (!(targetPct > 0)) return 0;
  return f.roundTripPct / targetPct;
}

/**
 * What friction costs over a run of trades, as a fraction of starting capital.
 *
 * The document that prompted this file claims friction can consume 30% of
 * returns over 500 scalps. That is checkable rather than quotable: this is the
 * arithmetic, and the Simulation desk shows it against the account's own size.
 */
export function frictionDrag(f: Friction, trades: number, notionalPerTrade: number, capital: number): number {
  if (!(capital > 0) || trades <= 0) return 0;
  return (f.roundTripPct * notionalPerTrade * trades) / capital;
}
