/**
 * YOUR OWN RECORD, ON THE PRICE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE THING A GENERIC CHART CANNOT DRAW
 *
 * TradingView draws this market better than this terminal will — more drawing
 * tools, a larger indicator library, more data, years more work. What it cannot
 * draw is whether THIS terminal was right the last four hundred times it said
 * something about this market, because it does not know. This does: every claim
 * carries the bar it was made on, its entry, stop and target, and how it
 * resolved. Put those on the price and the chart stops being a picture of the
 * market and becomes a record of your own decisions against it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR WAYS TO MAKE IT A LIE
 *
 * Measured on the live ledger — 759 claims, 445 decided — every one of these is
 * the common case rather than an edge case:
 *
 *  1. **A STAND-DOWN IS NOT A TRADE.** 291 of 400 recent claims are the terminal
 *     REFUSING, not proposing. "Was it right to take this?" and "was it right to
 *     refuse this?" are different questions, and one mark for both answers
 *     neither. They are counted apart and drawn apart.
 *
 *  2. **PENDING IS NOT EVIDENCE.** 326 of 400 have not resolved. A pending claim
 *     drawn like a result puts hundreds of unearned marks on the chart.
 *
 *  3. **EXPIRED IS NOT A LOSS.** CLAUDE.md states it plainly: a setup that
 *     reached neither its target nor its stop is its own class, and folding it
 *     into "stop" teaches that "nothing happened" looks like "I was wrong" —
 *     when the first is most of a quiet market.
 *
 *  4. **"COULD NOT BE READ" IS NOT "NOT YET ANSWERED".** 10 of 429 live BTCUSDT
 *     1h claims are `unknowable`: one bar covered the stop and the target, so
 *     OHLC cannot say which came first. The first draft of this file folded every
 *     unrecognised outcome into `pending` and would have drawn those ten as open
 *     calls for ever. The service excludes them from its own denominator and says
 *     why; a chart that called them pending would disagree with it silently.
 *
 *  5. **ANOTHER MARKET'S CLAIM IS NOT THIS MARKET'S.** A claim made on XAUUSD 1h
 *     drawn on a BTCUSDT 5m chart sits in exactly the position a reader trusts,
 *     about the wrong thing, with nothing on screen to say so.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT RETURNS SHAPES, NOT PIXELS
 *
 * Same split every detector keeps: this reports WHAT and WHERE in data
 * coordinates, and the renderer turns that into pixels. So it is a pure function
 * that can be tested without a canvas, and the marker collision handling the
 * chart already does applies to these for free.
 */

import type { Shape, Tone } from "../detect/types";
import type { BarView } from "./series";

/** One recorded call, as `/svc/claims` returns it. */
export interface Claim {
  readonly id: string;
  /** When the call was made, in epoch ms. The bar you knew on. */
  readonly at: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly side: "long" | "short";
  /** Whether the terminal proposed the trade or refused it. */
  readonly verdict: "take" | "stand-down" | string;
  /**
   * How it resolved.
   *
   * FIVE VALUES, NOT FOUR. `unknowable` is a bar whose range covered the stop
   * AND the target: OHLC cannot say which was touched first, so the ledger
   * refuses to guess. `server/mishel_claims.py` excludes it from its denominator
   * for that reason, and this layer must not quietly call it "still open".
   */
  readonly outcome: "target" | "stop" | "expired" | "pending" | "unknowable" | string;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly r_realised: number | null;
  readonly resolved_at: number | null;
  readonly resolved_price: number | null;
}

/** Which market and bar size the chart is showing. */
export interface ChartSubject {
  readonly symbol: string;
  readonly timeframe: string;
  /** One bar's width in ms, for placing a call inside the bar it fell in. */
  readonly intervalMs: number;
}

export interface ClaimLayerOptions {
  /** `all` (default), `taken` for proposals only, or `stood-down` for refusals. */
  readonly show?: "all" | "taken" | "stood-down";
  /**
   * `decided` (DEFAULT) draws only calls that have been graded; `all` adds the
   * ones still waiting.
   *
   * MEASURED: BTCUSDT 1h holds 429 claims and 293 of them are pending. Drawn at
   * once they covered three days of candles - a thicket, which is what this file
   * already says about every call's brackets at once. The first version counted
   * pending apart and drew it anyway: the rule enforced in the arithmetic and
   * broken on the screen. A call the terminal has not been graded on yet is not
   * evidence about the terminal, and 293 of them is not a record but a fog.
   */
  readonly include?: "decided" | "all";
  /** Draw the entry, stop and target of the newest decided call. Off by default. */
  readonly levels?: boolean;
}

export interface ClaimLayer {
  readonly shapes: readonly Shape[];
  /**
   * How many marks were actually drawn.
   *
   * THE CONTROL READS THIS, NOT THE CLAIM COUNT. A badge saying 429 beside a
   * chart carrying 41 marks is a number the operator can see is wrong, and a
   * layer whose own count contradicts the screen loses the credibility it exists
   * to earn.
   */
  readonly marks: number;
  /** What was counted, split so no two questions share a number. */
  readonly counted: {
    readonly hits: number;
    readonly misses: number;
    /** Reached neither barrier inside its horizon. Its own class, never a loss. */
    readonly expired: number;
    readonly pending: number;
    /** One bar covered both barriers, so the order cannot be recovered. */
    readonly unknowable: number;
    readonly taken: number;
    readonly stoodDown: number;
    /**
     * THE TWO POPULATIONS, KEPT APART.
     *
     * A pooled rate over takes and refusals answers neither question: reaching
     * target is the trade working when it was TAKEN and the refusal costing
     * something when it was REFUSED. `server/mishel_claims.py` `gate_verdict`
     * splits them for the same reason and compares them; this reports the same
     * way rather than inventing a second interpretation.
     */
    readonly takenHits: number;
    readonly takenDecided: number;
    readonly stoodHits: number;
    readonly stoodDecided: number;
  };
  /** What was left out, and why. A silent drop is indistinguishable from none. */
  readonly dropped: {
    readonly otherMarket: number;
    readonly offChart: number;
    readonly unreadable: number;
    readonly hidden: number;
    /** Counted, still waiting on an outcome, and deliberately not drawn. */
    readonly unresolved: number;
  };
  /** The operator's sentence, with the sample in it. */
  readonly why: string;
}

const EMPTY_COUNT = {
  hits: 0,
  misses: 0,
  expired: 0,
  pending: 0,
  unknowable: 0,
  taken: 0,
  stoodDown: 0,
  takenHits: 0,
  takenDecided: 0,
  stoodHits: 0,
  stoodDecided: 0,
};

/**
 * The bar a moment fell in, by TIME.
 *
 * NOT BY POSITION. A gapped series indexes differently from a continuous one, so
 * a call placed by array position drifts by exactly the number of missing bars —
 * silently, and further the older the call.
 */
function barAt(bars: readonly BarView[], t: number, intervalMs: number): number {
  if (bars.length === 0 || !Number.isFinite(t)) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  if (t < (bars[0] as BarView).t) return -1;
  const last = bars[hi] as BarView;
  /* Past the last bar's own span is off the chart, not "the last bar". */
  if (t >= last.t + intervalMs) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((bars[mid] as BarView).t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Target is a hit, stop is a miss, expired is neither. */
function toneFor(outcome: string): Tone {
  if (outcome === "target") return "bull";
  if (outcome === "stop") return "bear";
  return "neutral";
}

/**
 * The mark itself.
 *
 * A PROPOSAL AND A REFUSAL DO NOT WEAR THE SAME GLYPH, because they answer
 * different questions. A refusal that was right means price did NOT do what a
 * trade would have needed.
 */
function textFor(outcome: string): string {
  /* EXACTLY ONE CHARACTER, ALWAYS. A group of calls sharing a bar appends its
     count to this, and the first version carried the verdict as a TRAILING DOT -
     so a refused group of forty-five rendered `✓·45` and read at 1:1 as a
     negative number. The verdict is carried by POSITION now (see `above`), which
     costs no characters and cannot be misread as arithmetic.

     THREE DIFFERENT REASONS A CALL HAS NO RESULT, three different marks: nobody
     has looked yet, the horizon ran out, and the bar cannot be read. Sharing a
     glyph between any two of them makes the chart answer a question it was not
     asked. */
  if (outcome === "target") return "✓";
  if (outcome === "stop") return "✗";
  /* NOT AN EN DASH, AND NOT A MIDDLE DOT. Those were the first choices and both
     are characters a NUMBER CAN ABSORB: ten expired calls on one bar rendered
     `–10` and read as negative ten, and pending would have rendered `·10` as a
     decimal. A tilde says "it drifted" and a hollow ring says "still open", and
     neither can join the count that follows it. */
  if (outcome === "expired") return "~";
  if (outcome === "unknowable") return "?";
  return "○";
}

/**
 * Turn the ledger into shapes for this chart.
 *
 * Everything not drawn is COUNTED, because a canvas cannot tell a missing mark
 * from a call that was never made.
 */
export function claimShapes(
  claims: readonly Claim[],
  bars: readonly BarView[],
  subject: ChartSubject,
  opts: ClaimLayerOptions = {},
): ClaimLayer {
  const show = opts.show ?? "all";
  const include = opts.include ?? "decided";
  const shapes: Shape[] = [];
  const counted = { ...EMPTY_COUNT };
  const dropped = { otherMarket: 0, offChart: 0, unreadable: 0, hidden: 0, unresolved: 0 };

  let newestDecided: { claim: Claim; x: number } | null = null;

  /**
   * THE CALLS ON ONE BAR, GATHERED BEFORE ANY OF THEM IS DRAWN.
   *
   * A mark per claim looked right until it was MEASURED at 1:1: where a dozen
   * calls shared a bar the renderer's collision handling pushed them into a
   * vertical tower reaching well above and below the candle. On a price chart a
   * y position IS a price, so that tower drew claims at levels nobody ever
   * traded — plausible, unlabelled and not red, which is the same failure as a
   * per-series scale on an equity chart.
   *
   * Keyed by verdict as well as by bar, because a proposal and a refusal answer
   * different questions and merging them would lose the distinction this whole
   * layer is built around.
   */
  const groups = new Map<string, { x: number; took: boolean; members: Claim[] }>();

  for (const c of claims) {
    /* THIS MARKET AND THIS BAR SIZE ONLY. A claim about another series would sit
       in a position the reader trusts, describing something else. */
    if (c.symbol !== subject.symbol || c.timeframe !== subject.timeframe) {
      dropped.otherMarket += 1;
      continue;
    }
    if (!Number.isFinite(c.at) || !Number.isFinite(c.entry)) {
      dropped.unreadable += 1;
      continue;
    }
    const x = barAt(bars, c.at, subject.intervalMs);
    if (x < 0) {
      /* NOT CLAMPED TO THE EDGE. Clamping stacks every older call on the first
         bar — a cluster that reads as a flurry of calls at a moment when
         nothing happened. */
      dropped.offChart += 1;
      continue;
    }

    const took = c.verdict === "take";
    if (took) counted.taken += 1;
    else counted.stoodDown += 1;

    if (c.outcome === "target" || c.outcome === "stop") {
      const hit = c.outcome === "target" ? 1 : 0;
      if (took) {
        counted.takenDecided += 1;
        counted.takenHits += hit;
      } else {
        counted.stoodDecided += 1;
        counted.stoodHits += hit;
      }
    }

    if (c.outcome === "target") counted.hits += 1;
    else if (c.outcome === "stop") counted.misses += 1;
    else if (c.outcome === "expired") counted.expired += 1;
    else if (c.outcome === "unknowable") counted.unknowable += 1;
    else counted.pending += 1;

    if ((show === "taken" && !took) || (show === "stood-down" && took)) {
      dropped.hidden += 1;
      continue;
    }

    /* THE DEFAULT HIDES DOUBT, NEVER EVIDENCE. Only `pending` is held back, and
       only after being counted: a target, a stop, a timeout and an unreadable
       bar are all things that HAPPENED, and a default that could suppress one of
       them would flatter the record by omission. */
    if (include === "decided" && c.outcome === "pending") {
      dropped.unresolved += 1;
      continue;
    }

    /* GATHERED, NOT DRAWN YET. One mark per (bar, verdict) — see `flush` below
       for why a mark per claim was wrong. */
    const key = `${x}|${took ? "t" : "s"}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { x, took, members: [c] });
    else g.members.push(c);

    /* GRADED, not merely "not pending". An expired or unknowable call's brackets
       drawn as the newest result would put levels on the chart for a call that
       nobody can say anything about. */
    const graded = c.outcome === "target" || c.outcome === "stop";
    if (graded && (newestDecided === null || c.at > newestDecided.claim.at)) {
      newestDecided = { claim: c, x };
    }
  }

  /**
   * One mark per group.
   *
   * A lone call keeps its own glyph. Several become that glyph plus the count,
   * so collapsing never reports fewer calls than there were, and the price is
   * the MEAN of the entries in the group — always inside the range the calls
   * were actually made around, never an invented level.
   */
  for (const g of groups.values()) {
    const n = g.members.length;
    const first = g.members[0] as Claim;
    const hits = g.members.filter((m) => m.outcome === "target").length;
    const misses = g.members.filter((m) => m.outcome === "stop").length;
    const mean = g.members.reduce((acc, m) => acc + m.entry, 0) / n;
    /* The group's OWN BALANCE, so a bar of five misses does not wear the mark of
       the one hit that happens to be first in the list. */
    const outcome =
      n === 1 ? first.outcome : hits > misses ? "target" : misses > hits ? "stop" : "expired";
    /* ONE OWNER FOR outcome -> tone. Writing the ternary again here was a second
       copy of `toneFor` that could drift from it silently. */
    const tone: Tone = toneFor(outcome);
    const glyph = textFor(outcome);
    shapes.push({
      type: "marker",
      x: g.x,
      y: mean,
      tone,
      text: n === 1 ? glyph : `${glyph}${n}`,
      /* THE PRIMARY SPLIT, CARRIED BY POSITION: trades the terminal took sit
         BELOW the bar, ones it refused sit ABOVE. That was previously a trailing
         dot on the glyph, which a group count turned into what looked like a
         negative number. Side was the old rule and is the weaker fact here -
         whether the terminal acted is what a reader is asking. */
      above: !g.took,
    });
  }
  const marks = shapes.length;

  /* THE NEWEST DECIDED CALL'S LEVELS, on request only. Every call's brackets at
     once is a thicket; the most recent one is the question a reader has. */
  if (opts.levels === true && newestDecided !== null) {
    const { claim: c, x } = newestDecided;
    for (const [price, label, tone] of [
      [c.entry, "entry", "accent"],
      [c.stop, "stop", "bear"],
      [c.target, "target", "bull"],
    ] as const) {
      if (!Number.isFinite(price)) continue;
      shapes.push({ type: "level", x0: x, y: price, tone, label, dashed: true });
    }
  }

  const decided = counted.hits + counted.misses;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

  /**
   * THE LEDE IS THE ANSWER: two rates, never pooled into one.
   *
   * Reaching target means the trade worked when it was TAKEN and the refusal
   * cost something when it was REFUSED, so "would have" is the only phrasing for
   * the second that does not read as good news.
   */
  const lede = [
    counted.takenDecided > 0
      ? `Taken: ${counted.takenHits} of ${counted.takenDecided} reached target.`
      : "",
    counted.stoodDecided > 0
      ? `Refused: ${counted.stoodHits} of ${counted.stoodDecided} would have.`
      : "",
  ].filter((t) => t !== "");

  /**
   * EVERYTHING THAT QUALIFIES IT, and nothing left silent.
   *
   * A category excluded from a denominator and named nowhere leaves a reader
   * unable to tell a class from a bug - the gap `mishel_claims.py` records
   * closing for `expired` on its own side.
   */
  const qualifiers = [
    marks > 0 ? `${plural(marks, "mark")} on these bars` : "",
    counted.expired > 0 ? `${counted.expired} ran out of time (not a loss)` : "",
    counted.unknowable > 0
      ? `${counted.unknowable} could not be read (one bar hit both sides)`
      : "",
    counted.pending > 0
      ? `${counted.pending} still open${dropped.unresolved > 0 ? " and not drawn" : ""}`
      : "",
    dropped.hidden > 0
      ? `${dropped.hidden} ${show === "taken" ? "stood down" : "taken"} and hidden`
      : "",
    dropped.offChart > 0 ? `${dropped.offChart} outside these bars` : "",
  ].filter((t) => t !== "");

  const why =
    claims.length === 0
      ? "no claims recorded for this market yet"
      : decided === 0
        ? `${plural(counted.pending, "call")} here, none resolved yet — nothing to score` +
          (dropped.unresolved > 0 ? ", so none is drawn" : "")
        : [lede.join(" "), qualifiers.join("; ")].filter((t) => t !== "").join(" ");

  return { shapes, marks, counted, dropped, why };
}
