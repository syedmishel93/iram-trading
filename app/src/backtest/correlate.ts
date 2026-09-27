/**
 * THE CROSS-ASSET WEB — turning measured correlations into a drawable graph.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT OWNS THE PICTURE, NOT THE ARITHMETIC
 *
 * `data/correlation.ts` already answers "how much do two markets move together"
 * for the Risk desk, where a correlated book makes summed heat an
 * understatement. Writing a second answer here would have been a fourth
 * implementation of one fact in this repository — `data/correlation.ts`,
 * `data/context.ts` for the screener's scan, and `study/stats.ts pearsonAt` for
 * the lag-capable version already exist — and the one thing this project has
 * learned repeatedly is that two owners of a fact disagree and nothing says so.
 *
 * So the pairwise measurement is delegated, and what lives here is the part that
 * is genuinely about a PICTURE: which symbols become nodes, which pairs are
 * worth a line, how big a node should be, and what is refused.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A DRAWN LINE CLAIMS
 *
 * Every edge on screen reads as a fact, so three rules apply and all three are
 * tested:
 *
 *  1. **BELOW THE FLOOR, NOTHING IS DRAWN.** A web with a line between every
 *     pair is a picture of noise. Anything under `EDGE_FLOOR` is left out — and
 *     COUNTED, because "these markets are unrelated" is a finding and an empty
 *     card is not.
 *
 *  2. **A PAIR THAT COULD NOT BE MEASURED IS NAMED.** A silently missing edge is
 *     indistinguishable from a measured absence.
 *
 *  3. **INSTABILITY TRAVELS WITH THE EDGE.** A correlation that reversed inside
 *     the window must not reach the renderer looking like a settled one — the
 *     whole reason `correlate()` slices the overlap.
 */

import { correlate, utcDay, type ClosesSeries } from "../data/correlation";
import type { MacroBar } from "./macro";
import type { GraphEdge, GraphNode } from "../viz/layout";

/** Daily bars keyed by the symbol the archive stores them under. */
export type SeriesBars = Readonly<Record<string, readonly MacroBar[]>>;

/** |r| below this is noise, and a drawn line reads as a fact. */
export const EDGE_FLOOR = 0.3;

/** An edge with the facts the renderer needs to stay honest about it. */
export interface CorrelationEdge extends GraphEdge {
  /** Days both markets really traded. Never a filled one. */
  readonly n: number;
  readonly instability: number;
  readonly stable: boolean;
}

export interface CorrelationGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly CorrelationEdge[];
  /** Pairs measured honestly and found unrelated. A finding, so it is counted. */
  readonly belowFloor: number;
  /** Pairs that could not be measured, each with the reason. */
  readonly refused: readonly { readonly pair: string; readonly why: string }[];
}

/**
 * Which group a symbol sits in on the ring.
 *
 * AN EXPLICIT TABLE, NOT A SHAPE TEST. Matching "anything ending USDT" would put
 * EURUSDT — a market Binance really lists — in with the crypto, and this
 * repository has already recorded that exact trap.
 */
const GROUPS: Readonly<Record<string, string>> = {
  BTCUSDT: "crypto", ETHUSDT: "crypto", SOLUSDT: "crypto", BNBUSDT: "crypto", XRPUSDT: "crypto",
  XAUUSD: "metals", COPPER: "metals",
  EURUSD: "fx", USDJPY: "fx", DXY: "fx",
  US02Y: "rates", US10Y: "rates",
  SPX: "equity", NDX: "equity", VIX: "equity",
};

/** Everything unmapped sits together rather than being guessed into a group. */
export const UNGROUPED = "other";

const asSeries = (symbol: string, bars: readonly MacroBar[]): ClosesSeries => ({
  symbol,
  closes: bars.map((b) => ({ t: b.t, c: b.c })),
});

/**
 * Every pair, measured, with the unmeasurable named.
 *
 * JOINED ON THE UTC DAY, because these series come from different vendors:
 * yfinance stamps a daily bar at midnight and the broker at its session open, so
 * an exact-timestamp join would report zero overlap between two series covering
 * the same days.
 */
export function correlationGraph(series: SeriesBars): CorrelationGraph {
  const symbols = Object.keys(series).sort();
  const edges: CorrelationEdge[] = [];
  const refused: { pair: string; why: string }[] = [];
  let belowFloor = 0;

  /** Sum of |r| over the edges that survived, per symbol — drives the radius. */
  const pull = new Map<string, number>(symbols.map((s) => [s, 0]));

  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const A = symbols[i] as string;
      const B = symbols[j] as string;
      const got = correlate(
        asSeries(A, series[A] ?? []),
        asSeries(B, series[B] ?? []),
        { bucket: utcDay },
      );

      if (!Number.isFinite(got.r)) {
        refused.push({
          pair: `${A}/${B}`,
          why:
            got.overlap < 30
              ? `only ${got.overlap} day${got.overlap === 1 ? "" : "s"} where both traded — too few for a correlation to describe the pair rather than the overlap`
              : "one of these two did not move over the shared days, so there is no variation to compare",
        });
        continue;
      }
      if (Math.abs(got.r) < EDGE_FLOOR) {
        belowFloor += 1;
        continue;
      }

      pull.set(A, (pull.get(A) ?? 0) + Math.abs(got.r));
      pull.set(B, (pull.get(B) ?? 0) + Math.abs(got.r));
      edges.push({
        from: A,
        to: B,
        value: got.r,
        /* CONFIDENCE IS NOT THE CORRELATION. It is how much the figure held up.
           Without this a strong number that reversed halfway would pull its two
           nodes together in the layout exactly as hard as a steady one, so the
           picture would place them as firm neighbours on evidence that says
           otherwise. */
        confidence: got.stable ? 1 : 0.35,
        n: got.overlap,
        instability: got.instability,
        stable: got.stable,
      });
    }
  }

  const maxPull = Math.max(1e-9, ...[...pull.values()]);
  const nodes: GraphNode[] = symbols.map((s) => ({
    id: s,
    label: s,
    group: GROUPS[s] ?? UNGROUPED,
    /* SIZE IS HOW CONNECTED IT IS, not how big the market is. A market nothing
       else moves with is a small node, which is the true and useful reading. */
    weight: (pull.get(s) ?? 0) / maxPull,
  }));

  return { nodes, edges, belowFloor, refused };
}
