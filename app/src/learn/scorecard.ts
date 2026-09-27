/**
 * What the claims add up to — the terminal's own scorecard.
 *
 * THE FAILURE MODE THIS FILE IS BUILT AGAINST
 * Three wins out of four is 75%. Written that way it reads as a fact about the
 * terminal; it is a fact about four trades. The 95% interval around it runs
 * from 30% to 95%, which is to say it is consistent with a system that is
 * excellent and with one that is worse than a coin. Every platform that shows
 * a win rate shows the 75% and not the interval, and that omission is what
 * turns four samples into a conviction.
 *
 * So no proportion leaves this module without its interval, and none is
 * reported at all below a floor where the interval is wider than the range of
 * answers anybody cares about.
 *
 * THE COMPARISON THAT IS THE POINT
 * Claims are recorded whether or not the card said to take them, so this can
 * do something no backtest can: compare what the gates LET THROUGH against
 * what they STOPPED, on the same instrument, in the same conditions, on
 * decisions made in real time with no hindsight. If the two populations
 * resolve the same, the gates are not filtering — they are just saying no, and
 * the cost of that is every stand-down that would have worked.
 *
 * That comparison is the honest version of "is this terminal any good", and it
 * is the one number here that cannot be gamed by adding features.
 *
 * WHAT IS DELIBERATELY ABSENT
 * There is no fitting here. Nothing in this module adjusts a weight, tunes a
 * threshold, or feeds anything back into the read. It measures and stops. See
 * `learn/store.ts` for why that line is drawn where it is.
 */

import type { Claim } from "./claim";
import { claimR, claimR_realised } from "./claim";

/**
 * Below this many resolved claims, a proportion is not reported.
 *
 * 20 is not a statistical threshold — there isn't one — it is the point at
 * which the 95% interval on a 50% rate is roughly ±22 points, which is still
 * enormous but is at least narrower than the gap between a good system and a
 * bad one. Under it the desk shows the count and refuses the percentage.
 */
export const MIN_FOR_RATE = 20;

export interface Proportion {
  readonly hits: number;
  readonly n: number;
  /** hits / n. NaN when n is 0. */
  readonly rate: number;
  /** Wilson 95% bounds, 0..1. */
  readonly low: number;
  readonly high: number;
  /** True when `n` clears MIN_FOR_RATE. */
  readonly reportable: boolean;
  /** Plain sentence, honest about the sample. */
  readonly text: string;
}

/**
 * The Wilson score interval.
 *
 * Not the textbook normal approximation `p ± 1.96·√(p(1−p)/n)`, which is the
 * one everybody writes and which is wrong exactly where it matters here: at
 * small n and at rates near 0 or 1 it produces bounds outside [0,1] and, at
 * 0 hits, an interval of zero width — it would report "0% and we are certain"
 * from a single loss. Wilson stays inside the range and keeps a sane width at
 * the extremes, which is the whole reason it is used for this.
 */
export function wilson(hits: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: NaN, high: NaN };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const pc = (v: number): string => `${Math.round(v * 100)}%`;

export function proportion(hits: number, n: number, what: string): Proportion {
  const { low, high } = wilson(hits, n);
  const rate = n > 0 ? hits / n : NaN;
  const reportable = n >= MIN_FOR_RATE;
  const text =
    n === 0
      ? `Nothing resolved yet, so there is no ${what} to report.`
      : reportable
        ? `${hits} of ${n} — ${pc(rate)}, and the truth is somewhere between ${pc(low)} and ${pc(high)}.`
        : `${hits} of ${n}. Too few to turn into a percentage: anywhere from ${pc(low)} to ${pc(high)} would look like this. ${MIN_FOR_RATE - n} more to go.`;
  return { hits, n, rate, low, high, reportable, text };
}

export interface Population {
  readonly label: string;
  /** Everything in this group, resolved or not. */
  readonly total: number;
  readonly pending: number;
  /** Dropped because a single bar covered both barriers. */
  readonly unknowable: number;
  /**
   * Reached neither barrier before its horizon ended. ITS OWN OUTCOME.
   *
   * This was counted in `total` and named in no field, here and in the service
   * independently, so the numbers a reader could see did not sum to the total
   * they sat under. MEASURED on the live table: 31 of 2,113. It stays OUT of
   * `decided` -- a timeout is not a loss, and folding it in would make "nothing
   * happened" and "I was wrong" look the same -- but it is now said out loud,
   * which is the half that was wrong. `expectancyR` below already counted these,
   * and said so, which is how the gap was visible at all.
   */
  readonly expired: number;
  /** Resolved to target or stop. The denominator for `hit`. */
  readonly decided: number;
  readonly hit: Proportion;
  /**
   * Mean realised R over everything that resolved, expiries included.
   *
   * NaN when nothing has an R that can be known. Kept beside the hit rate
   * always, never instead of it: a 70% hit rate at 0.3R loses money and a 35%
   * hit rate at 3R makes it, and either number alone is an advertisement
   * rather than a measurement.
   */
  readonly expectancyR: number;
  /** Mean planned reward-to-risk, so a flattering hit rate is visible as one. */
  readonly plannedR: number;
}

function summarise(label: string, claims: readonly Claim[]): Population {
  const pending = claims.filter((c) => c.outcome === "pending").length;
  const unknowable = claims.filter((c) => c.outcome === "unknowable").length;
  const expired = claims.filter((c) => c.outcome === "expired").length;
  const won = claims.filter((c) => c.outcome === "target").length;
  const lost = claims.filter((c) => c.outcome === "stop").length;

  const rs = claims.map(claimR_realised).filter((r): r is number => r !== null);
  const planned = claims.map(claimR).filter((r) => Number.isFinite(r));

  return {
    label,
    total: claims.length,
    pending,
    unknowable,
    expired,
    decided: won + lost,
    hit: proportion(won, won + lost, "hit rate"),
    expectancyR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN,
    plannedR: planned.length > 0 ? planned.reduce((a, b) => a + b, 0) / planned.length : NaN,
  };
}

export interface GateVerdict {
  readonly taken: Population;
  readonly stoodDown: Population;
  /** Take hit rate minus stand-down hit rate, in points. NaN when unreadable. */
  readonly liftPoints: number;
  /**
   * True only when both populations clear the sample floor AND their intervals
   * do not overlap. Overlapping intervals mean the difference is not visible
   * from this much data, whatever the point estimates look like.
   */
  readonly separated: boolean;
  readonly text: string;
}

/**
 * Do the gates earn their refusals?
 *
 * The comparison is between claims the card cleared and claims it blocked, and
 * the answer is allowed to be "the gates are not helping". That outcome is the
 * reason to build this rather than a reason not to publish it — a filter that
 * does not filter is costing every opportunity it declines, and nothing else
 * in the terminal is in a position to notice.
 */
export function gateVerdict(claims: readonly Claim[]): GateVerdict {
  const taken = summarise("Cleared the gates", claims.filter((c) => c.verdict === "take"));
  const stood = summarise("Stood down", claims.filter((c) => c.verdict === "stand-down"));

  const both = taken.hit.reportable && stood.hit.reportable;
  const lift = both ? (taken.hit.rate - stood.hit.rate) * 100 : NaN;
  /* Non-overlapping Wilson intervals. A conservative test — it is harder to
     pass than a two-proportion z-test — and conservative is the right side to
     err on when the output is a sentence about whether to trust the gates. */
  const separated = both && (taken.hit.low > stood.hit.high || stood.hit.low > taken.hit.high);

  let text: string;
  if (!both) {
    const missing: string[] = [];
    if (!taken.hit.reportable) missing.push(`${taken.decided} cleared`);
    if (!stood.hit.reportable) missing.push(`${stood.decided} stood down`);
    text = `Not enough yet to tell whether the gates help — ${missing.join(" and ")} have resolved, and ${MIN_FOR_RATE} of each is the floor for a comparison.`;
  } else if (!separated) {
    text = `Setups the gates cleared hit ${pc(taken.hit.rate)}; setups they blocked hit ${pc(stood.hit.rate)}. The ranges overlap, so on this much evidence the gates are not measurably picking better than they are refusing. That is a real finding, not a missing one.`;
  } else if (lift > 0) {
    text = `Setups the gates cleared hit ${pc(taken.hit.rate)} against ${pc(stood.hit.rate)} for the ones they blocked — ${Math.round(lift)} points, and the ranges do not overlap. The gates are separating.`;
  } else {
    text = `Setups the gates BLOCKED hit ${pc(stood.hit.rate)} against ${pc(taken.hit.rate)} for the ones they cleared, and the ranges do not overlap. The gates are filtering the wrong way round on this evidence. Worth reading the failing gates before trusting another stand-down.`;
  }

  return { taken, stoodDown: stood, liftPoints: lift, separated, text };
}

export interface Bin {
  /** Lower edge of the score band, −1..1 in steps of 0.2. */
  readonly from: number;
  readonly to: number;
  readonly hit: Proportion;
  readonly expectancyR: number;
}

/**
 * Hit rate by the score the read carried at the time.
 *
 * This is the honest replacement for a calibration curve. A calibration curve
 * needs a stated PROBABILITY, and the confluence score is not one — it is
 * −1..+1 with no claim about frequency attached. Plotting it as though it were
 * a probability would invent a claim the terminal never made, so what is
 * plotted instead is: when the score was in this band, how often did it work?
 *
 * If the bands come out flat, the score carries no information about outcome,
 * and that is exactly the thing a PBO of 89% predicts. It should be possible
 * to see that here rather than infer it.
 */
export function byScore(claims: readonly Claim[], bands = 5): readonly Bin[] {
  const out: Bin[] = [];
  const w = 1 / bands;
  for (let i = 0; i < bands; i++) {
    const lo = i * w;
    /* The top band closes at 1 inclusive; every other is half-open, so a score
       landing exactly on an edge falls in one band rather than two or none. */
    const hi = i === bands - 1 ? Number.POSITIVE_INFINITY : lo + w;
    const inBand = claims.filter((c) => {
      /* Absolute score: a −0.8 short and a +0.8 long are the same STRENGTH of
         claim in opposite directions, and splitting them halves every sample
         to answer a question nobody asked. Whether the direction was right is
         already carried by the outcome. */
      const s = Math.abs(c.score);
      return s >= lo && s < hi;
    });
    const won = inBand.filter((c) => c.outcome === "target").length;
    const lost = inBand.filter((c) => c.outcome === "stop").length;
    const rs = inBand.map(claimR_realised).filter((r): r is number => r !== null);
    out.push({
      from: lo,
      to: i === bands - 1 ? 1 : lo + w,
      hit: proportion(won, won + lost, "hit rate"),
      expectancyR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN,
    });
  }
  return out;
}

export interface Scorecard {
  readonly all: Population;
  readonly gates: GateVerdict;
  readonly scoreBands: readonly Bin[];
  readonly bySymbol: readonly Population[];
  /** Oldest and newest claim, so the window the numbers cover is visible. */
  readonly from: number | null;
  readonly to: number | null;
  /** The one line at the top of the desk. */
  readonly headline: string;
}

export function scorecard(claims: readonly Claim[]): Scorecard {
  const all = summarise("Everything", claims);
  const gates = gateVerdict(claims);

  const symbols = [...new Set(claims.map((c) => c.symbol))].sort();
  const bySymbol = symbols
    .map((s) => summarise(s, claims.filter((c) => c.symbol === s)))
    .sort((a, b) => b.decided - a.decided);

  const times = claims.map((c) => c.at);
  const from = times.length > 0 ? Math.min(...times) : null;
  const to = times.length > 0 ? Math.max(...times) : null;

  let headline: string;
  if (claims.length === 0) {
    headline =
      "Nothing recorded yet. Every read the Setup card produces gets written down here with the levels that would prove it right or wrong, and marked from your own bars once they arrive.";
  } else if (all.decided === 0) {
    headline = `${claims.length} recorded, none resolved yet. They resolve from the bars you load — open the instruments they were made on and they will be marked.`;
  } else if (!all.hit.reportable) {
    headline = `${all.decided} resolved of ${claims.length} recorded. ${all.hit.text}`;
  } else {
    const r = Number.isFinite(all.expectancyR) ? `${all.expectancyR >= 0 ? "+" : ""}${all.expectancyR.toFixed(2)}R` : "no R yet";
    headline = `${all.decided} resolved. ${all.hit.text} Average outcome ${r} per claim, against ${Number.isFinite(all.plannedR) ? `${all.plannedR.toFixed(1)}R planned` : "an unknown plan"}.`;
  }

  return { all, gates, scoreBands: byScore(claims), bySymbol, from, to, headline };
}

/**
 * One line for the Setup card, about the card itself.
 *
 * WHY THIS BELONGS ON THE CARD AND NOT ONLY ON THE LEARNING DESK
 * A track record on a separate page is a page you have to remember to visit,
 * and nobody visits it at the moment they are deciding — which is the only
 * moment it changes anything. The card already carries `recordLine`, which
 * measures YOUR trades from the journal. This measures the CARD's claims, and
 * the two are different questions that are easy to confuse:
 *
 *   record   what you did, and how it went
 *   learned  what this card said, and how that went
 *
 * You can trade badly on good reads and well on bad ones, so a card that
 * showed only the first would let its own accuracy go unexamined for ever.
 *
 * SCOPE FALLS BACK, AND SAYS WHEN IT HAS
 * The instrument is the right scope and will almost never have the samples, so
 * it falls back to every instrument together and LABELS which one it used.
 * Silently widening the scope would let a number about Bitcoin be read as a
 * number about gold.
 *
 * Returns null rather than a hedged sentence when there is genuinely nothing —
 * a card line that says "not enough data" on every render is noise that trains
 * people to skip the row it lives in.
 */
export function cardLine(claims: readonly Claim[], symbol: string): string | null {
  const sym = symbol.toUpperCase();
  const here = claims.filter((c) => c.symbol === sym);

  const hereCard = scorecard(here);
  const allCard = scorecard(claims);

  const use = hereCard.all.hit.reportable
    ? { card: hereCard, scope: `On ${sym}` }
    : allCard.all.hit.reportable
      ? { card: allCard, scope: "Across every instrument" }
      : null;

  if (use === null) {
    const decided = allCard.all.decided;
    if (decided === 0 && claims.length === 0) return null;
    /* `MIN_FOR_RATE - decided`, not `MIN_FOR_RATE`. The first version printed
       the floor itself, so one settled read read as "20 short" — a countdown
       that never moved, which is worse than no countdown because it looks like
       one. */
    const togo = MIN_FOR_RATE - decided;
    return `This card's own record: ${decided} read${decided === 1 ? "" : "s"} settled so far, ${togo} short of a readable rate. It is counting.`;
  }

  const p = use.card.all;
  const r = Number.isFinite(p.expectancyR)
    ? `${p.expectancyR >= 0 ? "+" : ""}${p.expectancyR.toFixed(2)}R per read`
    : "no R yet";
  const base = `${use.scope}, this card's reads have been right ${pc(p.hit.rate)} of the time (${pc(p.hit.low)}–${pc(p.hit.high)}), ${r}.`;

  /* The gate finding is appended ONLY when it separated. An overlapping
     comparison is a real finding on the Learning desk, where there is room to
     explain what overlap means; on a card it would read as a warning. */
  const g = use.card.gates;
  if (g.separated) {
    return g.liftPoints > 0
      ? `${base} Setups it cleared have done measurably better than the ones it blocked.`
      : `${base} Setups it BLOCKED have done measurably better than the ones it cleared — read the failing gates before trusting another stand-down.`;
  }
  return base;
}
