/**
 * SCENARIO ANALYSIS OVER A FACTOR VECTOR.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, AND WHY THE OLD SHAPE COULD NOT BE EXTENDED
 *
 * `portfolio.ts` `SCENARIOS` is five named events each carrying one
 * `factorMove`, applied to a one-factor model. "COVID liquidation: −50%" is a
 * fair summary of what crypto did, and it cannot express 2022 — rates up 250bp
 * AND equities down 20% AND the dollar up 8%, arriving at a book through three
 * betas with three different signs and, for a book holding gold against crypto,
 * partially cancelling. A single number has no way to say that.
 *
 * It stays where it is. A crypto-only book is well served by it and this module
 * needs a factor set fitted first, which needs daily history the archive may not
 * hold for every instrument.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RULES THIS FILE IS BUILT ON
 *
 * 1. **A TYPED-IN SHOCK IS AN ASSUMPTION WEARING A DATE.** If the label says
 *    March 2020 then the numbers come from March 2020. The archive holds SPX to
 *    1928, US10Y to 1962, DXY to 1971 and VIX to 1990, so the move is MEASURED
 *    by `measureWindow` — and a window the archive cannot cover is refused by
 *    name. Half a window reported under the name of the whole is the shape this
 *    project already records as a study whose dead vendors vanished from its
 *    reported span.
 *
 * 2. **A FACTOR SCENARIO ONLY MOVES WHAT THE FACTORS EXPLAIN.** The residual is
 *    by construction unpredicted by any factor shock. A book of assets the model
 *    barely explains will barely move under the worst shock anyone can name, and
 *    presenting that as "this costs you little" would be the most flattering
 *    error available — it is precisely the part of a book that blew up in the
 *    events these scenarios are named after. `scenarioPnl` reports the share it
 *    can speak to and says so when that share is small.
 *
 * 3. **AN UNMODELLED POSITION IS NOT A FLAT ONE.** Scoring it zero makes a book
 *    look safer the less of it you understand.
 */

import type { Exposure } from "./portfolio";
import type { AssetFactorModel, FactorMatrix } from "./factors";

/** A move per factor id, each in that factor's own declared unit. */
export type FactorShock = Readonly<Record<string, number>>;

/* ------------------------------------------------------- the windows ------ */

export interface HistoricalWindow {
  readonly id: string;
  readonly label: string;
  /** Inclusive start, exclusive end, epoch ms UTC. */
  readonly from: number;
  readonly to: number;
  readonly note: string;
}

const d = (y: number, m: number, day: number): number => Date.UTC(y, m - 1, day);

/**
 * Named stretches of real history.
 *
 * NO NUMBERS HERE — only dates. What each one did to each factor is read out of
 * the archive by `measureWindow`, so the scenario cannot drift from the history
 * it claims to be, and a window nobody holds data for refuses instead of
 * inventing one.
 */
export const HISTORICAL_WINDOWS: readonly HistoricalWindow[] = [
  {
    id: "gfc",
    label: "Lehman and after",
    from: d(2008, 9, 15),
    to: d(2008, 11, 21),
    note: "The bank failure and the two months behind it. The deepest joint move in equities, credit and the dollar that any of these series has recorded.",
  },
  {
    id: "volmageddon",
    label: "Volmageddon",
    from: d(2018, 2, 2),
    to: d(2018, 2, 9),
    note: "Short-volatility funds unwound in a week. Included because the equity move was modest and the volatility move was not — a scenario that separates the two factors.",
  },
  {
    id: "covid",
    label: "COVID liquidation",
    from: d(2020, 2, 19),
    to: d(2020, 3, 24),
    note: "Everything sold at once, including the assets normally held as the hedge. Correlations went to one, which is what a stress panel exists to show.",
  },
  {
    id: "rates2022",
    label: "2022 rate shock",
    from: d(2022, 1, 3),
    to: d(2022, 10, 15),
    note: "Slow by the standards of the others and far larger in rates. The scenario a single-factor model cannot express: yields, equities and the dollar all moving hard at once.",
  },
  {
    id: "svb",
    label: "SVB and the banks",
    from: d(2023, 3, 8),
    to: d(2023, 3, 18),
    note: "A rates shock in reverse — the front end rallied violently while equities fell. Useful precisely because it is the opposite sign to 2022.",
  },
  {
    id: "carry2024",
    label: "Yen carry unwind",
    from: d(2024, 7, 31),
    to: d(2024, 8, 6),
    note: "Four sessions. A funding-currency move that reached assets with no obvious connection to Japan, which is what a factor model is for.",
  },
];

/* ------------------------------------------------------- measurement ------ */

export interface MeasuredWindow {
  readonly ok: boolean;
  /** Cumulative move per factor over the window, in each factor's own unit. */
  readonly shock: FactorShock;
  readonly bars: number;
  readonly from: number;
  readonly to: number;
  readonly why: string | null;
}

/** Fewer rows than this and the window is not the event it is named after. */
export const MIN_WINDOW_BARS = 3;

/**
 * What the factors actually did between two dates.
 *
 * Moves are SUMMED, which is right for both units this model carries: log
 * returns add to the log return of the whole window, and basis points add to the
 * total change in yield. A percentage change would not add, and that is the
 * reason the factor set declares a kind rather than assuming one.
 */
export function measureWindow(m: FactorMatrix, from: number, to: number): MeasuredWindow {
  const empty: FactorShock = {};
  if (m.rows.length === 0) {
    return { ok: false, shock: empty, bars: 0, from, to, why: "no factor history is loaded" };
  }

  /* COVERAGE BEFORE MEASUREMENT. The archive reaching partway into a window is a
     different event from the window, and a partial answer under the full name is
     worse than a refusal. */
  if (from < (m.times[0] ?? Infinity) || to > (m.times[m.times.length - 1] ?? -Infinity)) {
    return {
      ok: false,
      shock: empty,
      bars: 0,
      from,
      to,
      why: "the archive does not cover this window — backfill the factor series to measure it",
    };
  }

  const shock: Record<string, number> = {};
  for (const id of m.ids) shock[id] = 0;
  let bars = 0;
  for (let i = 0; i < m.times.length; i++) {
    const t = m.times[i] as number;
    if (t < from || t > to) continue;
    const row = m.rows[i] as readonly number[];
    m.ids.forEach((id, j) => {
      const v = row[j] as number;
      if (Number.isFinite(v)) shock[id] = (shock[id] as number) + v;
    });
    bars += 1;
  }

  if (bars < MIN_WINDOW_BARS) {
    return {
      ok: false,
      shock: empty,
      bars,
      from,
      to,
      why: `only ${bars} shared session${bars === 1 ? "" : "s"} fall inside this window`,
    };
  }

  return { ok: true, shock, bars, from, to, why: null };
}

/* ------------------------------------------------------------ applying --- */

export interface PositionShockResult {
  readonly symbol: string;
  readonly pnl: number;
  /** Contribution per factor, so a cancelling book can be read. */
  readonly byFactor: Readonly<Record<string, number>>;
}

export interface ShockResult {
  readonly positions: readonly PositionShockResult[];
  readonly total: number;
  /** Factor ids the model carries that this shock said nothing about. */
  readonly unshocked: readonly string[];
  readonly unmodelled: readonly string[];
  readonly caveat: string | null;
}

/**
 * Move a book by a factor shock.
 *
 * A FACTOR THE SHOCK DOES NOT NAME IS NOT MOVED, and it is reported. Reading an
 * absent entry as "unchanged" would quietly turn a statement about equities into
 * a full scenario in which rates happened to hold still — a different and
 * usually milder event than the one the operator asked about.
 */
export function applyShock(
  book: readonly Exposure[],
  models: readonly AssetFactorModel[],
  shock: FactorShock,
): ShockResult {
  const byId = new Map(models.map((m) => [m.symbol, m]));
  const known = new Set<string>();
  for (const m of models) for (const id of Object.keys(m.betas)) known.add(id);
  const unshocked = [...known].filter((id) => !Number.isFinite(shock[id] as number)).sort();

  const unmodelled: string[] = [];
  let gross = 0;
  let unmodelledNotional = 0;
  const positions: PositionShockResult[] = [];

  for (const e of book) {
    gross += Math.abs(e.signedNotional);
    const m = byId.get(e.symbol);
    if (m === undefined) {
      unmodelled.push(e.symbol);
      unmodelledNotional += Math.abs(e.signedNotional);
      continue;
    }
    const byFactor: Record<string, number> = {};
    let pnl = 0;
    for (const [id, move] of Object.entries(shock)) {
      const beta = m.betas[id];
      if (beta === undefined || !Number.isFinite(beta) || !Number.isFinite(move)) continue;
      const part = e.signedNotional * beta * move;
      byFactor[id] = part;
      pnl += part;
    }
    positions.push({ symbol: e.symbol, pnl, byFactor });
  }

  const unmodelledShare = gross > 0 ? unmodelledNotional / gross : 0;
  const caveat =
    unmodelled.length > 0
      ? `${unmodelled.join(", ")} has no factor model and is not moved — ` +
        `${(unmodelledShare * 100).toFixed(0)}% of the book by notional, excluded rather than counted as flat`
      : null;

  return {
    positions,
    total: positions.reduce((s, p) => s + p.pnl, 0),
    unshocked,
    unmodelled,
    caveat,
  };
}

/* ------------------------------------------------ what it cannot say ------ */

export interface ScenarioResult extends ShockResult {
  /**
   * Notional-weighted R² of the book: the share of its variance the factor set
   * explains, and therefore the share this scenario can speak to at all.
   */
  readonly explainedShare: number;
}

/** Below this, a factor scenario is not describing the book it is applied to. */
export const MIN_EXPLAINED = 0.4;

/**
 * Apply a shock AND say how much of the book it can speak to.
 *
 * This is the function the desk should call. `applyShock` answers the
 * arithmetic; this one answers the question a reader actually has, which is
 * whether the arithmetic is about their book.
 */
export function scenarioPnl(
  book: readonly Exposure[],
  models: readonly AssetFactorModel[],
  shock: FactorShock,
  _factors: { readonly ids: readonly string[]; readonly rows: readonly (readonly number[])[] },
): ScenarioResult {
  const base = applyShock(book, models, shock);
  const byId = new Map(models.map((m) => [m.symbol, m]));

  let weighted = 0;
  let weight = 0;
  for (const e of book) {
    const w = Math.abs(e.signedNotional);
    if (!(w > 0)) continue;
    weight += w;
    const r2 = byId.get(e.symbol)?.r2;
    /* An unmodelled position contributes ZERO explained share rather than being
       left out of the denominator. Dropping it would make a book the model
       cannot describe look perfectly described. */
    weighted += w * (Number.isFinite(r2) ? (r2 as number) : 0);
  }
  const explainedShare = weight > 0 ? weighted / weight : 0;

  const parts: string[] = [];
  if (base.caveat !== null) parts.push(base.caveat);
  if (explainedShare < MIN_EXPLAINED) {
    parts.push(
      `these factors explain ${(explainedShare * 100).toFixed(0)}% of this book's movement, ` +
        `so the scenario says nothing about the other ${((1 - explainedShare) * 100).toFixed(0)}% — ` +
        `which is the part that moves when a name gets into trouble on its own`,
    );
  }
  if (base.unshocked.length > 0) {
    parts.push(`${base.unshocked.join(", ")} was not moved by this scenario`);
  }

  /* LEGS RESTING ON A BETA THAT IS NOT DISTINGUISHABLE FROM ZERO.
     This matters most where the unit is small: a rates beta is around 1e-4, and
     a 250bp shock multiplies it by 250, so pure estimation noise can dominate
     the total. MEASURED while writing these tests — an asset built with NO rates
     exposure produced +14,408 on a 10,000 book from a fitted beta of that kind. */
  const shaky = new Set<string>();
  for (const m of models) {
    for (const id of m.insignificant) {
      if (Number.isFinite(shock[id] as number)) shaky.add(`${m.symbol}/${id}`);
    }
  }
  if (shaky.size > 0) {
    parts.push(
      `${[...shaky].sort().join(", ")} rest${shaky.size === 1 ? "s" : ""} on a beta that is ` +
        `not distinguishable from zero — those legs are estimates of nothing`,
    );
  }

  return { ...base, explainedShare, caveat: parts.length > 0 ? parts.join(". ") : null };
}
