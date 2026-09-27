/**
 * The track record, asked about the setup in front of you.
 *
 * WHY THIS FILE CLOSES A LOOP THAT WAS OPEN
 * `learn/claim.ts` records what the terminal said, before the outcome existed.
 * `learn/resolve.ts` marks it right or wrong. `learn/scorecard.ts` can already
 * answer the question no platform answers about its own filters — *do the gates
 * help, or do they just say no a lot?* — with Wilson intervals and an honest
 * "not enough evidence" arm.
 *
 * And `setup/gates.ts` imported none of it. The terminal wrote a track record
 * it never read. Every decision was made as though it were the first one, on an
 * instrument where it had already been wrong forty times.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not tune anything. No threshold moves, no weight is adjusted, nothing
 * is fitted. That is not caution, it is the measured PBO of 89% in this
 * repository's own backtests: a system that quietly re-fits its own gates on a
 * few dozen resolved claims would be overfitting with extra steps, and it would
 * do it invisibly, which is the part that disqualifies it here.
 *
 * What it does instead is make the record an ARGUMENT the card has to show,
 * with its sample size attached, in the same voice as every other gate. The
 * operator's judgement stays in the loop; what changes is that the judgement is
 * now informed by what happened last time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUT OF SAMPLE BY CONSTRUCTION, WHICH IS THE ONLY REASON IT IS WORTH ANYTHING
 *
 * `setup/scorecard.ts` replays detections over the bars currently loaded, so
 * candidates are found on the same bars they are scored over — that IS the
 * mechanism behind the 89%. It is a prior and it says so.
 *
 * A claim is different in kind: it was written down at a time, with three
 * prices and a deadline, before the bars that would settle it existed. Nothing
 * about it can be re-fitted after the fact. That is what makes a thin record of
 * claims worth more than a thick one of replays, and it is why the sample
 * floors below are low enough to be reachable.
 */

import { MIN_FOR_RATE, proportion, type Proportion } from "./scorecard";
import type { Claim } from "./claim";

/** What the record is being asked about. */
export interface PriorQuery {
  readonly symbol: string;
  readonly timeframe: string;
  /** The detection kind on the card, when there is one. */
  readonly kind?: string | undefined;
  readonly side?: "long" | "short" | undefined;
}

export type PriorStanding = "unknown" | "thin" | "supports" | "against";

export interface Prior {
  readonly standing: PriorStanding;
  /** Resolved claims this rests on. Zero when `unknown`. */
  readonly resolved: number;
  readonly hit: Proportion | null;
  /** One sentence for the card. Always states the sample. */
  readonly text: string;
  /**
   * How the query was narrowed to reach a reportable sample.
   *
   * Shown because "this shape, here" and "anything, here" are different claims
   * about the evidence, and a reader who is not told which one they got will
   * assume the stronger.
   */
  readonly scope: string;
}

export const UNKNOWN_PRIOR: Prior = {
  standing: "unknown",
  resolved: 0,
  hit: null,
  text: "",
  scope: "",
};

/**
 * Widening ladder: the most specific question first, then progressively less.
 *
 * A record of four claims about FVGs on BTCUSDT 1h says nothing; a record of
 * sixty about everything on BTCUSDT says something weaker but real. Trying the
 * narrow question first and falling back is how you get the strongest statement
 * the evidence actually supports — and reporting WHICH rung answered is how the
 * reader knows how much to believe it.
 */
const LADDER: readonly {
  readonly scope: (q: PriorQuery) => string;
  readonly match: (c: Claim, q: PriorQuery) => boolean;
}[] = [
  {
    scope: (q) => `${q.kind} on ${q.symbol} ${q.timeframe}`,
    match: (c, q) =>
      q.kind !== undefined &&
      c.symbol === q.symbol &&
      c.timeframe === q.timeframe &&
      claimKind(c) === q.kind,
  },
  {
    scope: (q) => `${q.kind} on ${q.symbol}, any timeframe`,
    match: (c, q) => q.kind !== undefined && c.symbol === q.symbol && claimKind(c) === q.kind,
  },
  {
    scope: (q) => `${q.symbol} ${q.timeframe}`,
    match: (c, q) => c.symbol === q.symbol && c.timeframe === q.timeframe,
  },
  {
    scope: (q) => `${q.symbol}, any timeframe`,
    match: (c, q) => c.symbol === q.symbol,
  },
];

/**
 * The detection kind a claim was made about.
 *
 * Optional on `Claim` because claims predate the field. An older claim is not
 * broken — it simply cannot answer the narrowest rung of the ladder, and falls
 * through to a symbol-level one that it can.
 */
function claimKind(c: Claim): string | undefined {
  const kind = (c as unknown as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : undefined;
}

/**
 * Resolved one way or the other.
 *
 * `target` and `stop` only. `expired` means the deadline passed without either
 * level being reached, and `unknowable` means the bars to settle it are missing
 * — counting either as a loss would invent a losing record out of claims that
 * were never settled, which is the same error as counting a cancelled order as
 * a losing trade. `scorecard.ts` draws the line in the same place.
 */
function isDecided(c: Claim): boolean {
  return c.outcome === "target" || c.outcome === "stop";
}

/**
 * What the record says about this setup.
 *
 * Only claims the card CLEARED are counted. A stand-down that would have worked
 * is evidence about the gates, not about the shape, and mixing the two would
 * answer neither question — `gateVerdict` is where that comparison belongs.
 */
export function priorFor(claims: readonly Claim[], q: PriorQuery): Prior {
  const decided = claims.filter((c) => isDecided(c) && c.verdict === "take");
  if (decided.length === 0) return UNKNOWN_PRIOR;

  for (const rung of LADDER) {
    let pool = decided.filter((c) => rung.match(c, q));
    if (q.side !== undefined) {
      /* Side-matched only while that still leaves a reportable sample. A long
         record is genuinely different from a short one on the same shape, and
         also halves the evidence — so it is a refinement, never a requirement. */
      const sided = pool.filter((c) => c.side === q.side);
      if (sided.length >= MIN_FOR_RATE) pool = sided;
    }
    if (pool.length < MIN_FOR_RATE) continue;

    const hit = proportion(pool.filter((c) => c.outcome === "target").length, pool.length, "hit");
    const scope = rung.scope(q);
    return {
      standing: standingOf(hit),
      resolved: pool.length,
      hit,
      scope,
      text: sentence(hit, pool.length, scope),
    };
  }

  /* Something is on the record but no rung reached the floor. Worth saying:
     "nothing yet" and "too little to read" send the operator to different
     places, and only one of them is worth waiting on. */
  const anywhere = decided.filter((c) => c.symbol === q.symbol).length;
  if (anywhere > 0) {
    return {
      standing: "thin",
      resolved: anywhere,
      hit: null,
      scope: q.symbol,
      text: `${anywhere} resolved on ${q.symbol} — needs ${MIN_FOR_RATE} before a hit rate is meaningful.`,
    };
  }
  return UNKNOWN_PRIOR;
}

/**
 * Where the interval sits relative to a coin toss.
 *
 * The INTERVAL, not the point estimate. Four hits from six is a 67% hit rate
 * and an interval spanning 30% to 90%, which supports nothing; calling that
 * "supports" on the point estimate is exactly how a thin record becomes a
 * confident-sounding number.
 */
function standingOf(hit: Proportion): PriorStanding {
  if (!hit.reportable) return "thin";
  if (hit.low > 0.5) return "supports";
  if (hit.high < 0.5) return "against";
  return "thin";
}

function pc(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function sentence(hit: Proportion, n: number, scope: string): string {
  const band = `${pc(hit.low)}–${pc(hit.high)}`;
  if (hit.low > 0.5) {
    return `Track record: ${scope} won ${pc(hit.rate)} of ${n} calls (likely range ${band}) — better than a coin flip.`;
  }
  if (hit.high < 0.5) {
    return `Track record: ${scope} won ${pc(hit.rate)} of ${n} calls (likely range ${band}) — worse than a coin flip. This setup has a losing record here.`;
  }
  return `Track record: ${scope} won ${pc(hit.rate)} of ${n} calls (likely range ${band}) — not clearly better or worse than a coin flip.`;
}
