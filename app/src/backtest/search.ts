/**
 * The autonomous search: what survives looking at every strategy at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS FILE EXISTS FOR
 *
 * "Try every strategy and show me the best one" is a machine for producing
 * flukes, and the more thorough it is the worse it gets. Search three hundred
 * arms of pure noise and the best of them still comes back with a handsome
 * curve, a respectable Sharpe and a story — because something has to come
 * first. The terminal already knows this: `validate.pbo` measures whether the
 * selection was meaningful, `promote()` refuses anything that fails it, and
 * `study/stats.ts` `deflatedSharpe` charges a result for the number of tries
 * it took to find it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY REUSES
 *
 * REUSED, UNCHANGED: `promote(walk, pbo)` — thirty out-of-sample trades, 40%
 * retention, PBO at or below 0.5, a majority of profitable folds. Those
 * thresholds live in `promote.ts` and must keep living there; a second copy
 * with its own numbers is how two desks come to disagree about the same
 * strategy. The lab computes it per study already (`Study.promotion`).
 *
 * ADDED HERE, because nothing on this path has it: THE COST OF THE SEARCH.
 * `promote()` judges one strategy in isolation — correctly, because that is
 * what it is for. It cannot know that this strategy is the best of four
 * hundred arms, and being the best of four hundred is worth a great deal of
 * apparent edge on its own. So a survivor must ALSO clear the best-of-N hurdle
 * for the number of arms the search actually had.
 *
 * Measured shape of that hurdle, per-trade Sharpe, from `deflatedSharpe`:
 *
 *     trials     120 OOS trades      300 OOS trades
 *        25      0.21                0.13
 *       100      0.25                0.16
 *       400      0.29                0.18
 *
 * So a strategy at 0.20 per-trade Sharpe over 120 out-of-sample trades is,
 * after a 400-arm search, indistinguishable from the best arm of a search over
 * nothing at all — while `promote()` alone would have passed it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNITS, ONCE, BECAUSE THIS HAS BITTEN THE PROJECT BEFORE
 *
 * `deflatedSharpe` wants a PER-OBSERVATION Sharpe and the number of those
 * observations. Here an observation is one out-of-sample TRADE, and the Sharpe
 * is the mean R over the standard deviation of R across those trades — not
 * `Metrics.sharpe`, which is annualised from the equity curve. CLAUDE.md
 * records what the annualised figure did here: an annualised 4.93 over 77
 * trades "deflated" by 0.85 and printed as though the search had been paid
 * for.
 *
 * Only out-of-sample trades are read (`WalkForwardFold.trades`), never the
 * in-sample fit that chose the configuration.
 */

import type { Study } from "./lab";
import type { Trade } from "./engine";
import { deflatedSharpe, type DeflatedSharpe } from "../study/stats";

/** Per-trade Sharpe left after the best-of-N hurdle, below which: nothing. */
export const MIN_DEFLATED = 0;

export interface Candidate {
  /** A `SPECS` id, a hybrid id (`hy:a+b`), or a family id. */
  readonly id: string;
  readonly name: string;
  /** Whether the terminal wrote this rule itself. */
  readonly origin: "library" | "hybrid" | "family" | "conditioned";
  readonly study: Study;
}

export interface SearchInput {
  readonly candidates: readonly Candidate[];
  /**
   * Arms evaluated that are NOT in `candidates`: hybrids built and discarded,
   * a previous sweep over these same bars, a run the operator repeated. The
   * hurdle is computed on the total, because the hurdle belongs to the search
   * rather than to the strategy.
   */
  readonly priorTrials?: number;
}

export interface Scored {
  readonly id: string;
  readonly name: string;
  readonly origin: Candidate["origin"];
  /** Out-of-sample trades every figure here stands on. */
  readonly trades: number;
  /** Mean R per out-of-sample trade. */
  readonly expectancy: number;
  /** Per-trade Sharpe, out of sample. See the units note in the header. */
  readonly sharpe: number;
  readonly deflated: DeflatedSharpe;
  /** The existing gate's verdict, unchanged — `promote.ts`. */
  readonly promoted: boolean;
  readonly promotionSummary: string;
  /** Why it is not offered, or null when it survived. */
  readonly rejected: string | null;
}

export type Refusal =
  | { readonly kind: "no-candidates"; readonly why: string }
  | { readonly kind: "all-refused"; readonly why: string; readonly best: Scored }
  | { readonly kind: "beaten-by-noise"; readonly why: string; readonly best: Scored };

export interface SearchResult {
  /** Arms the hurdle was computed over. */
  readonly trials: number;
  readonly scored: readonly Scored[];
  /** Survivors, most edge-after-the-search first. Empty is a real answer. */
  readonly survivors: readonly Scored[];
  readonly refusal: Refusal | null;
  /** One line for a card: what was searched, and what came of it. */
  readonly line: string;
}

/** Mean and sample standard deviation of R, per trade. */
export function perTradeSharpe(trades: readonly Trade[]): { readonly n: number; readonly mean: number; readonly sharpe: number } {
  const rs = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  const n = rs.length;
  if (n < 2) return { n, mean: n === 1 ? (rs[0] as number) : 0, sharpe: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
  /* Every trade returning exactly the same R is a property of a fixture, not
     of a market. An infinite Sharpe would clear any hurdle, so it scores 0. */
  return { n, mean, sharpe: sd > 0 ? mean / sd : 0 };
}

/** The out-of-sample trades of every fold, pooled in order. */
export function oosTrades(study: Study): Trade[] {
  const out: Trade[] = [];
  for (const fold of study.walk.folds) out.push(...fold.trades);
  return out;
}

/**
 * How many arms a study represents.
 *
 * Every configuration in its grid, because the study already picked the best
 * of them. A study that tried one configuration is one arm.
 */
export function armsOf(study: Study): number {
  return Math.max(1, study.configs.length);
}

/**
 * Score every candidate against the hurdle the whole search implies.
 *
 * The trial count is the same for every candidate on purpose: each is one arm
 * of ONE search, and what has to be paid for is the search.
 */
export function scoreSearch(input: SearchInput): SearchResult {
  const trials = Math.max(
    1,
    input.candidates.reduce((sum, c) => sum + armsOf(c.study), 0) + Math.max(0, Math.floor(input.priorTrials ?? 0)),
  );

  if (input.candidates.length === 0) {
    return {
      trials,
      scored: [],
      survivors: [],
      refusal: { kind: "no-candidates", why: "No strategy could be run on this chart, so there is nothing to judge." },
      line: "Nothing was searched.",
    };
  }

  const scored: Scored[] = input.candidates.map((c) => {
    const { n, mean, sharpe } = perTradeSharpe(oosTrades(c.study));
    const deflated = deflatedSharpe(sharpe, trials, Math.max(1, n));
    const promotion = c.study.promotion;
    const failed = promotion.checks.find((k) => !k.passed);
    const rejected = !promotion.promoted
      ? (failed?.text ?? promotion.summary)
      : deflated.deflated <= MIN_DEFLATED
        ? `the best of ${trials.toLocaleString()} tries on no edge at all scores ${deflated.hurdle.toFixed(2)} of per-trade Sharpe; this scored ${sharpe.toFixed(2)}`
        : null;
    return {
      id: c.id,
      name: c.name,
      origin: c.origin,
      trades: n,
      expectancy: mean,
      sharpe,
      deflated,
      promoted: promotion.promoted,
      promotionSummary: promotion.summary,
      rejected,
    };
  });

  const survivors = scored.filter((s) => s.rejected === null).sort((a, b) => b.deflated.deflated - a.deflated.deflated);

  if (survivors.length > 0) {
    const best = survivors[0] as Scored;
    return {
      trials,
      scored,
      survivors,
      refusal: null,
      line:
        `${survivors.length} of ${input.candidates.length} strategies survived ${trials.toLocaleString()} tries. ` +
        `Best: ${best.name} — ${best.expectancy >= 0 ? "+" : ""}${best.expectancy.toFixed(2)}R a trade over ${best.trades} out-of-sample trades, ` +
        `${best.deflated.deflated.toFixed(2)} of per-trade Sharpe left once the search is paid for.`,
    };
  }

  /* Nothing survived, and WHICH refusal is the useful part: "none was good
     enough" and "the best one is what searching this hard finds in noise" ask
     the operator for different things. Rank the failures by what is left after
     the hurdle so the nearest miss is a real nearest miss. */
  const best = [...scored].sort((a, b) => b.deflated.deflated - a.deflated.deflated)[0] as Scored;
  const onlyTheSearch = best.promoted;
  return {
    trials,
    scored,
    survivors: [],
    refusal: onlyTheSearch
      ? {
          kind: "beaten-by-noise",
          best,
          why:
            `Nothing survived. ${best.name} passed every check on its own — ${best.expectancy >= 0 ? "+" : ""}${best.expectancy.toFixed(2)}R a trade over ${best.trades} out-of-sample trades — ` +
            `but ${trials.toLocaleString()} tries on no edge at all would be expected to turn up ${best.deflated.hurdle.toFixed(2)} of per-trade Sharpe, and it scored ${best.sharpe.toFixed(2)}. ` +
            `That is a result of the search, not of the market.`,
        }
      : {
          kind: "all-refused",
          best,
          why: `Nothing survived ${trials.toLocaleString()} tries. The nearest miss was ${best.name}: ${best.rejected ?? best.promotionSummary}`,
        },
    line: `Nothing survived the search of ${input.candidates.length} strategies (${trials.toLocaleString()} tries).`,
  };
}
