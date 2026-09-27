/**
 * What the trades did while they were open.
 *
 * The equity curve records where each trade ENDED. MAE and MFE record where it
 * went on the way, and that is the only evidence about the two exits a rule
 * sets by hand:
 *
 *  - THE STOP. If nine winners in ten never went more than 0.6R against the
 *    entry, a stop at 1R is paying for room that winners do not use. The
 *    reverse is the costlier finding: winners that routinely go 0.9R against
 *    you mean the stop is where the good trades breathe.
 *  - THE TARGET. Losers that were once a full R in profit are trades the exit
 *    gave back. Winners that closed at a small share of their best excursion
 *    are trades the exit cut short.
 *
 * WHAT IT DOES NOT CLAIM
 * These are in-sample descriptions of one configuration's trades. Moving the
 * stop to the 90th percentile of winners' heat and re-running is curve-fitting
 * with extra steps; the reading is a question to take to the walk-forward, not
 * an answer. Excursions are gross of costs and the exit bar is resolved
 * pessimistically — see `Trade.maeR` in engine.ts.
 */

import type { Trade } from "./engine";

/** Below this many trades on either side, a percentile is an anecdote. */
export const MIN_SIDE = 10;
export const MIN_TRADES = 30;

export interface ExcursionRead {
  /** Why nothing is stated, or null. */
  readonly refused: string | null;
  readonly winners: number;
  readonly losers: number;
  /** Adverse excursion of WINNERS, in R: median and 90th percentile. */
  readonly winnerMaeP50: number;
  readonly winnerMaeP90: number;
  /** Favourable excursion of LOSERS, in R: median. */
  readonly loserMfeP50: number;
  /** Share of losers that were at least 1R in profit before they lost. */
  readonly losersOnceUp1R: number;
  /**
   * Median of (realised R / MFE) over winners that did NOT exit at their
   * target: how much of the best available move the exit kept. Null when every
   * winner took its target.
   *
   * WHY TARGET EXITS ARE LEFT OUT. A target exit caps the favourable
   * excursion AT the target (see `Trade.mfeR`), so its capture is 100% by
   * construction, less costs. The first version averaged them in and reported
   * "winners kept 97.4% of their best move" on a live BTCUSDT study whose
   * winners were nearly all target exits — a number made entirely of the
   * measurement's own cap. Net over gross, so even a perfect discretionary
   * exit reads a little under 1.
   */
  readonly captureP50: number | null;
  /** Winners that exited at their target, so the capture read excludes them. */
  readonly targetWinners: number;
  /** Every trade's (MAE, final R), for the scatter. */
  readonly points: readonly { readonly mae: number; readonly mfe: number; readonly r: number }[];
}

const EMPTY = (refused: string, winners = 0, losers = 0): ExcursionRead => ({
  refused,
  winners,
  losers,
  winnerMaeP50: 0,
  winnerMaeP90: 0,
  loserMfeP50: 0,
  losersOnceUp1R: 0,
  captureP50: null,
  targetWinners: 0,
  points: [],
});

/**
 * Nearest-rank percentile of an ascending array: the smallest value with at
 * least `q` of the sample at or below it. Chosen over interpolation because it
 * always names a trade that happened.
 */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

export function readExcursions(trades: readonly Trade[]): ExcursionRead {
  /* A study produced by a build that predates the fields has trades without
     them. Refusing is honest; treating a missing field as zero would report
     that no trade ever went against its entry. */
  if (trades.some((t) => !Number.isFinite(t.maeR) || !Number.isFinite(t.mfeR))) {
    return EMPTY("these trades carry no excursion data — re-run the study");
  }
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  if (trades.length < MIN_TRADES) {
    return EMPTY(`${trades.length} trades; at least ${MIN_TRADES} are needed`, wins.length, losses.length);
  }
  if (wins.length < MIN_SIDE || losses.length < MIN_SIDE) {
    return EMPTY(
      `${wins.length} winners and ${losses.length} losers; each side needs at least ${MIN_SIDE}`,
      wins.length,
      losses.length,
    );
  }

  const asc = (xs: number[]): number[] => xs.sort((a, b) => a - b);
  const winMae = asc(wins.map((t) => t.maeR));
  const loseMfe = asc(losses.map((t) => t.mfeR));
  const managed = wins.filter((t) => t.exitReason !== "target" && t.mfeR > 0);
  const capture = asc(managed.map((t) => t.rMultiple / t.mfeR));

  return {
    refused: null,
    winners: wins.length,
    losers: losses.length,
    winnerMaeP50: percentile(winMae, 0.5),
    winnerMaeP90: percentile(winMae, 0.9),
    loserMfeP50: percentile(loseMfe, 0.5),
    losersOnceUp1R: losses.filter((t) => t.mfeR >= 1).length / losses.length,
    captureP50: capture.length > 0 ? percentile(capture, 0.5) : null,
    targetWinners: wins.filter((t) => t.exitReason === "target").length,
    points: trades.map((t) => ({ mae: t.maeR, mfe: t.mfeR, r: t.rMultiple })),
  };
}
