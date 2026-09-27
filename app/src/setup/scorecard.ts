/**
 * Every detection kind, ranked by what it has actually been worth here.
 *
 * WHY THIS DID NOT EXIST UNTIL THERE WERE TWENTY-NINE DETECTORS
 * `setup/simulate.ts` has been able to answer "how has this kind done" since
 * v52, and `setup/deep.ts` has had `replayAll` — the same question asked of
 * every kind at once — since the same build. Nothing in the interface has ever
 * called it. The chart replayed exactly ONE kind: whichever the setup engine
 * had chosen, on the card, for the setup in front of you.
 *
 * At thirteen detectors that was a gap. At twenty-nine it is the operator's
 * main question, and it has no answer on screen: *of all these things the
 * terminal now draws, which have ever been worth anything on this instrument?*
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IN SAMPLE, AND SAID SO EVERY TIME
 *
 * This is a replay over the bars currently loaded. The candidates are found on
 * the same bars they are scored over, which is precisely the mechanism behind
 * this repository's measured PBO of 89%. It is a PRIOR — "has this shape ever
 * done anything here" — and it is not a forecast, and the difference is the
 * reason `learn/` exists separately.
 *
 * The Learning desk's claims are out of sample: written down before the
 * outcome existed. This table is the opposite kind of evidence and the two are
 * deliberately shown together, because seeing them disagree is informative and
 * seeing only one of them is not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RANKED BY EDGE OVER BREAK-EVEN, NOT BY HIT RATE
 *
 * A 62% hit rate at 1:1 and a 41% hit rate at 2:1 are the same trade. Ranking
 * by hit rate would put every tight-target kind at the top of the table
 * regardless of whether any of them made money, so the rank is the Wilson
 * LOWER BOUND minus the break-even rate implied by the reward-to-risk — the
 * same quantity `setup/recommend.ts` ranks by, for the same reason.
 *
 * The lower bound rather than the point estimate: a kind with four wins from
 * six trials has a wonderful hit rate and no evidence, and the interval is
 * what says so.
 */

import { breakEven, MIN_TRIALS, type Simulation } from "./simulate";
import { MIN_EDGE } from "./recommend";

/** One kind's line in the table. */
export interface KindRow {
  readonly kind: string;
  readonly direction: "long" | "short";
  /** Scoreable trials — every trial except `unknowable`. */
  readonly n: number;
  readonly wins: number;
  readonly hitRate: number | null;
  /** Wilson lower bound at 95%. The number to quote when quoting one. */
  readonly hitLow: number | null;
  readonly expectancy: number | null;
  readonly breakEven: number;
  /**
   * `hitLow - breakEven`. Positive means the WORST case consistent with the
   * sample still clears the bar. Null when there is nothing to compare.
   *
   * Whether it CLEARS is `edge > MIN_EDGE`, not `edge > 0` — see `clears`.
   */
  readonly edge: number | null;
  /**
   * Past break-even by a margin worth acting on.
   *
   * `MIN_EDGE` rather than zero, borrowed from `setup/recommend.ts` which
   * already made this argument: a candidate a whisker above break-even has an
   * edge indistinguishable from the rounding in its own hit rate.
   *
   * The first version tested `> 0` and the first live run showed exactly why
   * that is wrong. `choch long` came back with a lower bound of 50% against a
   * break-even of 50% — an edge in the fourth decimal — and the table printed
   * "+0pp" next to the words "clears on the lower bound". A verdict that
   * contradicts the number beside it is worse than no verdict.
   */
  readonly clears: boolean;
  /** n >= MIN_TRIALS. Below this nothing here may be characterised. */
  readonly enough: boolean;
  /** The 90% expectancy interval sits entirely below zero. */
  readonly adverse: boolean;
  readonly note: string;
}

export interface Scorecard {
  readonly rows: readonly KindRow[];
  /** Kinds with a usable sample, best edge first. */
  readonly ranked: readonly KindRow[];
  readonly measured: number;
  readonly clearing: number;
  readonly rMultiple: number;
  readonly bars: number;
  /** One sentence, safe to render verbatim. Leads with the refusal. */
  readonly headline: string;
}

export function toRow(sim: Simulation, rMultiple: number): KindRow {
  const be = breakEven(rMultiple);
  const edge = sim.hitLow === null ? null : sim.hitLow - be;
  return {
    clears: sim.enough && edge !== null && edge > MIN_EDGE,
    kind: sim.kind,
    direction: sim.direction,
    n: sim.n,
    wins: sim.wins,
    hitRate: sim.hitRate,
    hitLow: sim.hitLow,
    expectancy: sim.expectancy,
    breakEven: be,
    edge,
    enough: sim.enough,
    adverse: sim.adverse,
    note: sim.note,
  };
}

/**
 * Build the table.
 *
 * `sims` is whatever `replayAll` produced. Kinds with no completed instance are
 * dropped rather than shown as zero rows: "no record" and "a record of nothing"
 * read identically in a table and mean opposite things, and the count of
 * dropped kinds is reported in the headline instead.
 */
export function scorecard(
  sims: Iterable<Simulation>,
  rMultiple: number,
  bars: number,
): Scorecard {
  const rows: KindRow[] = [];
  for (const sim of sims) {
    if (sim.n === 0) continue;
    rows.push(toRow(sim, rMultiple));
  }

  /* Only characterisable kinds may be ranked. A kind with six trials can have
     the best-looking edge in the table and it is not a finding — including it
     in the ranking would put it at the top, which is the whole failure. */
  const ranked = rows
    .filter((r) => r.enough && r.edge !== null)
    .sort((a, b) => (b.edge as number) - (a.edge as number));

  const measured = rows.filter((r) => r.enough).length;
  const clearing = ranked.filter((r) => r.clears).length;

  return {
    rows: rows.sort((a, b) => b.n - a.n),
    ranked,
    measured,
    clearing,
    rMultiple,
    bars,
    headline: headlineFor(rows.length, measured, clearing, rMultiple, bars, ranked[0]),
  };
}

/**
 * The sentence at the top.
 *
 * Leads with what cannot be said. A reader who sees "3 kinds clear break-even"
 * first will not read the clause about the sample being in-sample, so the
 * clause goes first.
 */
export function headlineFor(
  total: number,
  measured: number,
  clearing: number,
  rMultiple: number,
  bars: number,
  best: KindRow | undefined,
): string {
  if (total === 0) {
    return "No completed instance of any kind in the bars loaded — nothing to replay.";
  }
  if (measured === 0) {
    return (
      `${total} kind${total === 1 ? "" : "s"} left a mark in ${bars.toLocaleString()} bars, but ` +
      `none has the ${MIN_TRIALS} completed instances needed to characterise it. ` +
      `That is a statement about the sample, not about the kinds.`
    );
  }

  const be = breakEven(rMultiple);
  const stem =
    `Replayed in-sample over ${bars.toLocaleString()} bars at ${rMultiple.toFixed(2)}R, where ` +
    `break-even is ${(be * 100).toFixed(0)}%. ${measured} of ${total} kinds have enough ` +
    `instances to characterise.`;

  if (clearing === 0) {
    /* The expected result, and the one that must not be softened. */
    return (
      `${stem} None of them clears break-even once the lower bound is used — which is what ` +
      `you should expect, and the reason none of this is automated.`
    );
  }
  return (
    `${stem} ${clearing} clear${clearing === 1 ? "s" : ""} it on the lower bound by more than ` +
    `${(MIN_EDGE * 100).toFixed(0)} points` +
    (best ? `, best ${best.kind.replace(/-/g, " ")} ${best.direction} at ` +
      `${((best.hitLow ?? 0) * 100).toFixed(0)}% against ${(be * 100).toFixed(0)}%` : "") +
    `. Found and scored on the same bars, so treat it as a prior and nothing more.`
  );
}
