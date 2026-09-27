/**
 * Recommending a setup, and being willing to disagree with the ranking.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE OBSERVATION THIS IS BUILT ON
 *
 * `engine.ts` ranks candidates by structure: does it agree with the read, is
 * it fresh, is it in reach, does it name an invalidation. `deep.ts` says what
 * each kind has historically been worth. Run both on the same chart and they
 * frequently name different things — measured on ETHUSDT 1h over 5,999 bars:
 *
 *     ENGINE CHOSE      liquidity-sweep short   2 completed instances, ever
 *     HAD A RECORD      choch      87 · bos     70 · double-bottom 43
 *                       head-shoulders 32 · double-top 34 · divergence 26
 *
 * That is not a bug in either module. Sweeps, fair-value gaps, order blocks
 * and trendlines are largely reported while they are LIVE, so they barely
 * accumulate a history; breaks of structure and completed formations are
 * events, and they do. The engine is right that the sweep is the best-formed
 * idea on the chart, and the replay is right that nobody can say what a sweep
 * is worth here. Both facts belong on the card.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO
 *
 * It does not re-rank the engine. The chosen setup stays chosen, and the plan
 * stays built from it. Overriding a structural ranking with an in-sample hit
 * rate would be the PBO-89% mechanism wearing a new hat: the candidates were
 * found on the bars the hit rate is measured over, so "pick the one with the
 * best backtest" selects the luckiest of a field of three hundred.
 *
 * What it does instead is name the disagreement out loud. A second opinion the
 * operator can act on beats a blended number that has already quietly resolved
 * the argument in private.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RANKING RULE, AND WHY IT IS EDGE-OVER-BREAK-EVEN
 *
 * Not hit rate. A 45% hit rate is ruinous at 1R and excellent at 3R, so
 * ranking by hit rate ranks by reward-to-risk in disguise. Every candidate
 * here is priced at the SAME R — the plan's — so the comparable quantity is
 * how far each clears the break-even that R demands.
 *
 * And it is the Wilson LOWER BOUND that is compared, never the point estimate.
 * Ranking point estimates over a field of candidates is precisely how a
 * three-instance fluke wins: `wilsonLow` charges each candidate for its own
 * uncertainty, so a thin sample cannot outrank a thick one on luck alone.
 */

import type { Simulation } from "./simulate";
import { breakEven } from "./simulate";
import type { RankedSetup } from "./engine";

/**
 * How far past break-even a candidate must stand before it is offered.
 *
 * Two points, not zero. A candidate exactly at break-even has no edge, and one
 * a whisker above it has an edge indistinguishable from the rounding in its
 * own hit rate; offering either invites the operator to trade noise.
 */
export const MIN_EDGE = 0.02;

export interface Recommendation {
  readonly kind: string;
  readonly direction: "long" | "short";
  readonly label: string;
  /** The engine's structural score, 0..1. Kept so both views stay visible. */
  readonly score: number;
  readonly sim: Simulation;
  /** Wilson lower bound minus break-even, at the plan's R. */
  readonly edge: number;
  /** One sentence, safe to render verbatim. */
  readonly line: string;
}

export interface RecommendResult {
  /** Candidates with a real record, best edge first. May be empty. */
  readonly evidenced: readonly Recommendation[];
  /**
   * Set when the chosen setup is not the best-evidenced one.
   *
   * The whole point of the module. Empty when they agree, when nothing has a
   * record, or when the chosen setup IS the best-evidenced.
   */
  readonly disagreement: string;
  /** What the chosen setup's own record says. Null when it has none. */
  readonly chosenSim: Simulation | null;
  /** One sentence about the field as a whole. */
  readonly note: string;
}

export interface RecommendInputs {
  /** The engine's takeable field, best first. */
  readonly ranked: readonly RankedSetup[];
  /** `${kind}|${direction}` → replayed record. From deep.ts. */
  readonly sims: ReadonlyMap<string, Simulation>;
  /** The reward-to-risk every simulation was priced at. */
  readonly rMultiple: number;
  /** How many to offer. */
  readonly limit?: number;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Rank the takeable field by what it has historically been worth.
 *
 * Only candidates the ENGINE already considers takeable are eligible. A kind
 * with a magnificent record and no instance on the chart right now is not a
 * recommendation, it is a daydream, and the engine's disqualifiers — opposes
 * the read, expired, already run — still apply to everything offered here.
 */
export function recommend(input: RecommendInputs): RecommendResult {
  const be = breakEven(input.rMultiple);
  const limit = input.limit ?? 3;

  const chosen = input.ranked[0] ?? null;
  const chosenKey = chosen ? `${chosen.candidate.kind}|${chosen.candidate.direction}` : "";
  const chosenSim = chosen ? (input.sims.get(chosenKey) ?? null) : null;

  /* One entry per kind and direction: the engine's field contains the same
     idea several times over when higher-timeframe projections are on, and
     three rows of the same recommendation is not three recommendations. */
  const seen = new Set<string>();
  const evidenced: Recommendation[] = [];

  for (const r of input.ranked) {
    const key = `${r.candidate.kind}|${r.candidate.direction}`;
    if (seen.has(key)) continue;
    const sim = input.sims.get(key);
    if (sim === undefined || !sim.enough || sim.hitLow === null) continue;
    seen.add(key);

    const edge = sim.hitLow - be;
    if (edge < MIN_EDGE) continue;

    evidenced.push({
      kind: r.candidate.kind,
      direction: r.candidate.direction,
      label: r.candidate.label,
      score: r.score,
      sim,
      edge,
      line: `${r.candidate.label} — ${sim.wins} of ${sim.n} reached target, at least ${pct(sim.hitLow)} against ${pct(be)} needed at this reward-to-risk.`,
    });
  }

  evidenced.sort((a, b) => b.edge - a.edge || (b.sim.expectancy ?? 0) - (a.sim.expectancy ?? 0));
  const top = evidenced.slice(0, limit);

  /* ------------------------------------------------------------ the note -- */

  const measured = [...input.sims.values()].filter((s) => s.enough).length;
  const note =
    measured === 0
      ? "No setup kind on this chart has enough completed instances to characterise yet."
      : top.length === 0
        ? `${measured} setup ${measured === 1 ? "kind has" : "kinds have"} a record here, and none of them clears break-even at this reward-to-risk.`
        : `${measured} setup ${measured === 1 ? "kind has" : "kinds have"} a record here; ${top.length} ${top.length === 1 ? "clears" : "clear"} break-even.`;

  /* ---------------------------------------------------- the disagreement -- */

  let disagreement = "";
  const bestEvidenced = top[0];

  if (chosen !== null && bestEvidenced !== undefined) {
    const sameIdea =
      bestEvidenced.kind === chosen.candidate.kind && bestEvidenced.direction === chosen.candidate.direction;

    if (!sameIdea) {
      /* Two distinct cases, and they call for different sentences. The chosen
         setup having NO record is a statement about the detector; having a
         record that loses is a statement about the market. */
      disagreement =
        chosenSim === null || !chosenSim.enough
          ? `Nothing is known about ${chosen.candidate.label.toLowerCase()} here — ${
              chosenSim === null || chosenSim.n === 0
                ? "it leaves no history to replay"
                : `only ${chosenSim.n} completed ${chosenSim.n === 1 ? "instance" : "instances"}`
            }. ${bestEvidenced.label} on this chart has ${bestEvidenced.sim.n}, and clears break-even.`
          : `${bestEvidenced.label} has the better record here: ${pct(bestEvidenced.sim.hitLow as number)} against ${pct(
              chosenSim.hitLow as number,
            )} at the same reward-to-risk, on ${bestEvidenced.sim.n} and ${chosenSim.n} instances.`;
    }
  }

  return { evidenced: top, disagreement, chosenSim, note };
}
