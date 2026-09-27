/**
 * The probability lattice — a Galton board whose balls are your actual trades.
 *
 * WHAT IT IS FOR, AND WHY IT IS NOT DECORATION
 *
 * The hardest thing to communicate about a positive edge is that it still loses
 * constantly. A table saying "expectancy +0.18R, win rate 41%" is correct and
 * conveys nothing about what living through it feels like; an equity curve
 * conveys the opposite of the truth, because a curve that ends higher looks like
 * a process that mostly went up.
 *
 * A bean machine says it in one image. Every trade is one ball. The pegs are
 * chance. The board is TILTED by the edge — and a tilted board still sends balls
 * to the losing side, over and over, and only settles into its shape after
 * hundreds of them. That is the law of large numbers, and it is the single most
 * important thing a backtest reader has to internalise before they size a trade
 * on 30 samples.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE BALLS COME FROM — AND THE ONE THING THIS REFUSES TO DO
 *
 * Each ball is a REAL trade's R-multiple, taken from a real backtest run, and it
 * lands in the bin its own R belongs to. It is not sampled from a fitted normal
 * curve and it is not a simulation with a win rate typed into it. That
 * distinction is the whole difference between an instrument and a screensaver:
 * a lattice fed by a distribution you chose will always look like the
 * distribution you chose.
 *
 * So `dropOrder` shuffles WHICH trade falls next — the sequence is cosmetic,
 * because a board that filled left-to-right in time would read as a trend — but
 * the multiset of outcomes is exactly the run's, and the final histogram is
 * exactly the run's histogram. Nothing is added, nothing is smoothed, and the
 * count converges on the count.
 *
 * The peg path is the only invented part, and it is invented to LAND where the
 * trade already landed: `pathFor` walks a ball to a predetermined bin. It is an
 * animation of an outcome, not a computation of one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BINS ARE IN R AND NOT IN MONEY
 *
 * Money makes two runs incomparable — the same edge on a bigger account is a
 * bigger number and not a better strategy — and a big currency figure is the
 * one thing a screen like this must not lead with. R is dimensionless, it is
 * what `engine.ts` already reports, and −1R is a landmark everybody reading it
 * already understands: it is the stop being hit.
 */

import type { Trade } from "./engine";
import { rng } from "./resample";

/** One column of the histogram. */
export interface LatticeBin {
  /** Inclusive lower edge, in R. */
  readonly from: number;
  /** Exclusive upper edge, in R. Infinity on the last bin. */
  readonly to: number;
  /** Trades whose R falls here. */
  readonly count: number;
  /** True when the whole bin is at or above break-even. */
  readonly winning: boolean;
  readonly label: string;
}

export interface Lattice {
  readonly bins: LatticeBin[];
  /** Index of the bin containing 0R — where the board's break-even line sits. */
  readonly breakEvenBin: number;
  /** Every trade's R, in the order the balls should fall. */
  readonly order: number[];
  /** Which bin each entry of `order` lands in. */
  readonly lands: number[];
  readonly trades: number;
  readonly wins: number;
  readonly expectancyR: number;
  /** Tallest bin, so a renderer can scale without a second pass. */
  readonly peak: number;
}

export const EMPTY_LATTICE: Lattice = {
  bins: [],
  breakEvenBin: -1,
  order: [],
  lands: [],
  trades: 0,
  wins: 0,
  expectancyR: 0,
  peak: 0,
};

/**
 * Bin edges, in R.
 *
 * Fixed rather than derived from the data, and that is deliberate: two runs put
 * side by side have to be comparable, and a lattice whose axis rescales itself
 * makes a tight distribution and a wild one look identical. The edges are also
 * chosen so that **−1R gets its own bin**, because "the stop was hit" is not a
 * bucket of outcomes, it is one outcome and usually the most common single one
 * on the board.
 */
export const BIN_EDGES: readonly number[] = [
  -Infinity, -1.5, -1.05, -0.95, -0.5, 0, 0.5, 1, 1.5, 2, 3, Infinity,
];

const edgeLabel = (from: number, to: number): string => {
  if (from === -Infinity) return `< ${to}R`;
  if (to === Infinity) return `${from}R +`;
  /* The stop bin is named for what it IS. "−1.05 to −0.95" is arithmetic; "stop"
     is the thing that happened. */
  if (from === -1.05 && to === -0.95) return "stop";
  return `${from} to ${to}R`;
};

/** Which bin an R-multiple belongs to. */
export function binOf(r: number): number {
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const lo = BIN_EDGES[i] as number;
    const hi = BIN_EDGES[i + 1] as number;
    if (r >= lo && r < hi) return i;
  }
  return BIN_EDGES.length - 2;
}

/**
 * Build a lattice from a run's trades.
 *
 * `seed` fixes the drop order so the same run animates the same way twice —
 * `resample.ts` makes the same argument about bootstrap draws, and it applies
 * with more force to something the operator watches: an animation that reorders
 * itself on every open cannot be compared with the one they saw yesterday.
 */
export function buildLattice(trades: readonly Trade[], seed = 0x5eed): Lattice {
  if (trades.length === 0) return EMPTY_LATTICE;

  const counts = new Array<number>(BIN_EDGES.length - 1).fill(0);
  const rs: number[] = [];
  let sum = 0;
  let wins = 0;

  for (const t of trades) {
    const r = Number.isFinite(t.rMultiple) ? t.rMultiple : 0;
    rs.push(r);
    sum += r;
    if (t.returnPct > 0) wins++;
    counts[binOf(r)] = (counts[binOf(r)] as number) + 1;
  }

  /* Shuffled, so the board does not fill left-to-right in time and read as a
     trend. The MULTISET is untouched — this only decides what falls next. */
  const order = [...rs];
  const next = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = order[i] as number;
    order[i] = order[j] as number;
    order[j] = a;
  }

  const bins: LatticeBin[] = counts.map((count, i) => {
    const from = BIN_EDGES[i] as number;
    const to = BIN_EDGES[i + 1] as number;
    return { from, to, count, winning: from >= 0, label: edgeLabel(from, to) };
  });

  return {
    bins,
    breakEvenBin: binOf(0),
    order,
    lands: order.map(binOf),
    trades: trades.length,
    wins,
    expectancyR: sum / trades.length,
    peak: Math.max(...counts),
  };
}

/**
 * A ball's path down the pegs, ending in `bin`.
 *
 * ROWS OF PEGS, AND A BALL THAT ALREADY KNOWS WHERE IT IS GOING.
 *
 * A true Galton board would let physics decide the bin and the histogram would
 * come out binomial — which is a lovely demonstration and the WRONG picture,
 * because a strategy's outcomes are not binomial. So the destination is the
 * trade's real bin and the path is fitted to reach it: at each row the ball goes
 * the way it needs to go, with the remaining freedom spent on looking natural.
 *
 * Stated plainly because a viewer is entitled to know which half is real: the
 * BIN is data, the BOUNCE is animation.
 *
 * Returns one x-offset per row, in bin units, from 0 (top centre) to `bin`.
 */
export function pathFor(bin: number, rows: number, binCount: number, next: () => number): number[] {
  const start = (binCount - 1) / 2;
  const path: number[] = [start];
  let x = start;

  for (let row = 1; row <= rows; row++) {
    const remaining = rows - row + 1;
    const need = bin - x;
    /* The step that keeps the destination reachable: never move so far that the
       rows left cannot cover the rest. Inside that window the direction is a
       coin, which is what makes two balls headed for the same bin take
       different routes. */
    const maxStep = Math.min(1, Math.abs(need) === 0 ? 1 : remaining);
    const must = Math.abs(need) >= remaining;
    const dir = must ? Math.sign(need) : next() < 0.5 ? -1 : 1;
    const step = Math.min(maxStep, 1) * dir;
    x = Math.max(0, Math.min(binCount - 1, x + step * 0.5));
    path.push(x);
  }

  /* Land exactly. A ball that stops half a bin off would be an animation
     disagreeing with the histogram it just incremented. */
  path[path.length - 1] = bin;
  return path;
}

/**
 * The sentence under the board.
 *
 * Computed here rather than in the view for the same reason `Study.headline` is:
 * a picture this persuasive needs its caveat attached to it, not placed nearby
 * by a layout that a redesign can rearrange.
 */
export function latticeNote(l: Lattice): string {
  if (l.trades === 0) return "No trades yet — nothing to drop.";

  const pct = (n: number): string => `${((n / l.trades) * 100).toFixed(0)}%`;
  const losing = l.bins.filter((b) => !b.winning).reduce((a, b) => a + b.count, 0);
  const stop = l.bins.find((b) => b.label === "stop")?.count ?? 0;

  if (l.trades < 30) {
    return (
      `${l.trades} balls. Far too few to have a shape — a board this empty will ` +
      `look like whatever the last few trades were.`
    );
  }

  const edge =
    l.expectancyR > 0
      ? `The board is tilted right by ${l.expectancyR.toFixed(2)}R per trade`
      : l.expectancyR < 0
        ? `The board is tilted LEFT by ${Math.abs(l.expectancyR).toFixed(2)}R per trade`
        : "The board is level";

  return (
    `${edge}, and ${pct(losing)} of balls still land on the losing side` +
    `${stop > 0 ? ` — ${pct(stop)} of them exactly on the stop` : ""}. ` +
    `That is what an edge looks like: not winning, just leaning.`
  );
}
