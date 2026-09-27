/**
 * Marking claims right or wrong, from bars the terminal already has.
 *
 * THE ONE RULE
 * A claim is resolved from bars STRICTLY AFTER it was made. Not at, after. The
 * bar a claim was made inside is still forming — its high and low are not final
 * — and reading it is look-ahead of the purest kind: the claim would be scored
 * against the very move that produced it. The Python side learnt this and wrote
 * it into `quant/ml.py`; this is the same rule for the same reason, in the
 * language the claims live in.
 *
 * WHY THIS IS A PURE FUNCTION OVER BARS AND NOT A LIVE WATCHER
 * A watcher only resolves claims made while the terminal was open, on the
 * chart you happened to be looking at. That biases the track record towards
 * the instruments you watch most, which is the opposite of what a track record
 * is for. Resolving from history means a claim made three weeks ago on a chart
 * you have not opened since is marked the moment you open it, from the same
 * bars you are looking at.
 *
 * WHAT IT REFUSES TO DECIDE
 * A bar whose range covers both the target and the stop does not say which was
 * touched first. OHLC cannot answer that — it is four numbers, not a path. The
 * claim is marked `unknowable` and drops out of every statistic downstream.
 * The alternative is a coin flip inside the hit rate, and a hit rate with
 * coin flips in it is worse than no hit rate, because it looks like one.
 */

import type { BarView } from "../chart/series";
import type { Claim, Outcome } from "./claim";

export interface Resolution {
  readonly outcome: Outcome;
  readonly at: number | null;
  readonly price: number | null;
}

/**
 * Resolve one claim against a series.
 *
 * `bars` must be ascending in time; anything at or before `claim.at` is
 * ignored. Returns `pending` when the series simply has not reached far enough
 * — which is a different statement from `expired`, and the two must not be
 * folded together: pending means come back later, expired means the claim had
 * its chance and did not take it.
 */
export function resolveClaim(claim: Claim, bars: readonly BarView[]): Resolution {
  if (claim.outcome !== "pending") {
    return { outcome: claim.outcome, at: claim.resolvedAt, price: claim.resolvedPrice };
  }

  const long = claim.side === "long";
  let last: BarView | null = null;

  for (const b of bars) {
    if (b.t <= claim.at) continue;
    if (b.t > claim.expiresAt) break;
    last = b;

    const hitTarget = long ? b.h >= claim.target : b.l <= claim.target;
    const hitStop = long ? b.l <= claim.stop : b.h >= claim.stop;

    if (hitTarget && hitStop) {
      /* Both inside one bar. See the header — this is not a tie to break. */
      return { outcome: "unknowable", at: b.t, price: b.c };
    }
    if (hitTarget) return { outcome: "target", at: b.t, price: claim.target };
    if (hitStop) return { outcome: "stop", at: b.t, price: claim.stop };
  }

  /* Nothing was touched. Whether that is `expired` or `pending` depends on
     whether the series has actually reached the deadline — and the test is the
     LAST BAR AVAILABLE, not the wall clock. A gap in history, a feed that was
     down, a symbol not loaded for a month: in all three the clock has passed
     the deadline while the evidence has not, and calling that expired would
     score a claim on bars nobody has. */
  const lastAvailable = bars.length > 0 ? (bars[bars.length - 1] as BarView).t : -Infinity;
  if (lastAvailable >= claim.expiresAt) {
    return { outcome: "expired", at: claim.expiresAt, price: last ? last.c : null };
  }
  return { outcome: "pending", at: null, price: null };
}

/** Apply a resolution to a claim, returning a new one. */
export function applyResolution(claim: Claim, r: Resolution): Claim {
  if (r.outcome === "pending") return claim;
  return {
    ...claim,
    outcome: r.outcome,
    resolvedAt: r.at,
    resolvedPrice: r.price,
    heldMs: r.at !== null ? Math.max(0, r.at - claim.at) : null,
  };
}

export interface SweepReport {
  /** Claims that changed state. */
  readonly resolved: readonly Claim[];
  /** Still pending after the sweep. */
  readonly stillPending: number;
  /** Claims whose series was not supplied at all. */
  readonly notChecked: number;
}

/**
 * Resolve every pending claim for which bars were supplied.
 *
 * `barsFor` returns the series for one instrument and timeframe, or an empty
 * array when it is not loaded. Empty means NOT CHECKED, never expired: a claim
 * must not be marked against a series the terminal does not have, and the
 * difference between "no bars" and "bars that went nowhere" is the difference
 * between an honest track record and a pessimistic one.
 */
export function sweep(
  claims: readonly Claim[],
  barsFor: (symbol: string, timeframe: string) => readonly BarView[],
): SweepReport {
  const resolved: Claim[] = [];
  let stillPending = 0;
  let notChecked = 0;

  for (const c of claims) {
    if (c.outcome !== "pending") continue;
    const bars = barsFor(c.symbol, c.timeframe);
    if (bars.length === 0) {
      notChecked++;
      continue;
    }
    const r = resolveClaim(c, bars);
    if (r.outcome === "pending") {
      stillPending++;
      continue;
    }
    resolved.push(applyResolution(c, r));
  }

  return { resolved, stillPending, notChecked };
}
