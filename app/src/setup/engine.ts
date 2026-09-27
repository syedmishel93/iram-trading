/**
 * The setup engine — choosing WHICH setup, and whether there is one at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS THERE BEFORE, IN FULL
 *
 *     const leadingSetupKind = () => {
 *       let best = null;
 *       for (const d of drawn()) {
 *         if (d.direction === "neutral") continue;
 *         if (best === null || d.confidence > best.confidence) best = d;
 *       }
 *       return best?.kind ?? null;
 *     };
 *
 * That is the whole of the Setup card's setup selection: the highest-confidence
 * detection anywhere on the chart. It has four problems, and each of them is
 * visible on a card the operator is being asked to trade from.
 *
 *   1. IT IGNORES THE READ. A short trendline with confidence 0.9 names the
 *      card while the evidence says long. The label and the direction beneath
 *      it can disagree and nothing notices.
 *   2. IT IGNORES TIME. A double top confirmed four hundred bars ago outranks
 *      one at the live edge. You cannot trade the first and the card does not
 *      say so.
 *   3. IT IGNORES DISTANCE. Price may already have run three ATR past the
 *      trigger. The setup happened; it happened without you.
 *   4. THE PLAN IS NOT BUILT FROM IT. `buildPlan` takes price, ATR and the
 *      nearest swing, and never consults the chosen detection. So the "trendline
 *      setup" plan has nothing to do with the trendline. The name is decoration
 *      on a volatility stop.
 *
 * And the fifth, which is the one that produced the screenshot: when nothing is
 * found the card still renders a full plan, calls it "discretionary", and then
 * blames a gate for refusing it. "1 gate failed" is a true sentence about a
 * situation whose real description is THERE IS NOTHING HERE. The operator reads
 * a gate problem and goes looking for a gate to loosen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 *
 * Enumerates candidates, scores each on factors that are measured rather than
 * assumed, ranks them, and returns the best — or returns nothing, and says so
 * in those words. The plan is then built from the winner's own invalidation
 * level, so the stop is where the idea is wrong rather than where the
 * volatility happens to land.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT, AND WHY
 *
 * It is not a model that outputs "trade" or "do not trade". Every factor below
 * is a quantity you can check against the chart, with the sentence that
 * describes it carried alongside the number. There is no learned verdict, no
 * language model, no opaque classifier, for a reason this repository has
 * already measured: the confluence selection carries a PBO of 89% — it fails
 * out of sample about nine times in ten — and stacking an unfalsifiable layer
 * on top of that does not fix it, it hides it.
 *
 * The one place something is LEARNED is `record`: how this setup kind has
 * actually resolved, on this instrument, in the operator's own journal. That
 * is falsifiable by construction, it shrinks toward neutral when the sample is
 * small, and it reports "no record yet" rather than inventing a prior.
 *
 * A ranking cannot make a bad setup good. What it can do is stop a stale one
 * from being presented as live, and stop nothing at all from being presented
 * as something a gate refused.
 */

import type { Detection, Shape } from "../detect/types";
import { CONTEXT_KINDS } from "../detect/index";

export interface Candidate {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly direction: "long" | "short";
  /** Bar index at which the detection became knowable. */
  readonly confirmedAt: number;
  readonly confidence: number;
  readonly reason: string;
  /**
   * The price that says this idea is wrong, or null when the detection does
   * not supply one.
   *
   * Null is a real answer and not a defect: a divergence has no level, and a
   * setup with no invalidation is a direction rather than a trade. It is
   * scored as such rather than being given a substitute.
   */
  readonly invalidation: number | null;
}

export interface Factor {
  readonly id: string;
  readonly label: string;
  /** 0..1, or null when the input for it was not available. */
  readonly score: number | null;
  readonly weight: number;
  /** One sentence, naming the measurement. Shown verbatim. */
  readonly note: string;
}

export interface RankedSetup {
  readonly candidate: Candidate;
  /** Weighted mean of the factors that HAD an input, 0..1. */
  readonly score: number;
  /**
   * Share of the total factor weight that actually had an input.
   *
   * The same idea as the read's coverage, for the same reason: a score of 0.8
   * standing on two factors out of five is not the same claim as a score of
   * 0.8 standing on all five, and a card that renders them identically is
   * lying by omission.
   */
  readonly grounded: number;
  readonly factors: readonly Factor[];
  /** What would have to change for this one to rank higher. */
  readonly missing: string;
  /**
   * Why this one cannot be taken at all, or "" when it can.
   *
   * SEPARATE FROM THE SCORE, AND THAT SEPARATION IS THE POINT.
   * A setup confirmed four hundred bars into a forty-bar life is not a
   * low-scoring setup that good factors elsewhere can outvote — it is not a
   * setup. Scored as a factor it came out at 0.69 and was offered to the
   * operator; the first version of this file did exactly that, and the test
   * that caught it is in test/engine.test.ts.
   */
  readonly disqualified: string;
}

export interface EngineResult {
  /** The chosen setup, or null when nothing cleared the floor. */
  readonly best: RankedSetup | null;
  /** Everything considered, best first. Empty when no candidates existed. */
  readonly ranked: readonly RankedSetup[];
  /**
   * Why there is no setup, when there is none. Empty when there is one.
   *
   * This is the sentence that has to exist for the card to stop blaming a gate
   * for the absence of an idea.
   */
  readonly refusal: string;
  /** What the best of a rejected field is waiting for. Empty when none. */
  readonly waitingFor: string;
}

export interface RecordLookup {
  /** Resolved outcomes for this setup kind, or null when there are none. */
  (kind: string): { readonly wins: number; readonly losses: number } | null;
}

export interface EngineInputs {
  readonly detections: readonly Detection[];
  /** Index of the newest bar. Freshness and reach are measured against it. */
  readonly atBar: number;
  readonly price: number;
  readonly atr: number;
  /** The evidence read's direction, or null when it has no lean. */
  readonly bias: "long" | "short" | "neutral" | null;
  /** How strongly, 0..1. A weak read makes agreement worth less, not more. */
  readonly conviction: number;
  /** The operator's own sane-stop ceiling, in ATR. From Settings. */
  readonly maxAtrMultiple: number;
  /** The operator's own floor. A stop tighter than this is inside the noise. */
  readonly minAtrMultiple: number;
  readonly record?: RecordLookup;
  /**
   * How many bars a setup stays live.
   *
   * Not a constant across timeframes and not pretending to be: passed in by the
   * caller, which knows the timeframe. Defaults to 40, which is a session and a
   * half on most charts.
   */
  readonly liveForBars?: number;
}

/** Nothing below this is offered as a setup. */
export const MIN_SETUP_SCORE = 0.45;

/**
 * And nothing whose ranking stands on less than this share of its factors.
 *
 * A high score built from two factors out of five is a coin flip wearing a
 * number. Refusing is the honest output, and the refusal names the gap.
 */
export const MIN_GROUNDED = 0.5;

/** Default bars a setup is considered live for. */
export const DEFAULT_LIVE_BARS = 40;

/**
 * How many bars a setup stays live on a given timeframe.
 *
 * A FIXED BAR COUNT IS THE SAME MISTAKE AS A FIXED PRICE THRESHOLD.
 * Forty bars is forty minutes on a one-minute chart and two months on a daily
 * one, and a daily double bottom does not expire in two months.
 *
 * The rule is a trading week, and it is HONESTLY A CLAMP over most of the
 * range — worth stating rather than dressing up, because the comment claiming
 * "about a week" while the code returns a constant is how a threshold stops
 * being checkable:
 *
 *     1m    a week is 7200 bars   ->  clamped to 120   (two hours)
 *     15m   a week is 480 bars    ->  clamped to 120   (thirty hours)
 *     1h    a week is 120 bars    ->  120              the rule binds here
 *     4h    a week is 30 bars     ->  30
 *     1d    a week is 5 bars      ->  clamped to 20    (four weeks)
 *
 * So: the week decides it at 1h and 4h, the upper clamp decides it intraday
 * (where 7200 bars of "live" would be absurd), and the lower clamp decides it
 * on the daily and above (where five bars is too few to be a window at all).
 */
export function liveBarsFor(intervalMs: number): number {
  const WEEK = 5 * 24 * 60 * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return DEFAULT_LIVE_BARS;
  return Math.round(Math.min(120, Math.max(20, WEEK / intervalMs)));
}

/**
 * Detections that describe CONTEXT rather than a tradeable idea.
 *
 * A session range and a range are true, useful, and not setups — you do not
 * enter on "there is a range". Excluding them here rather than filtering at
 * the call site keeps the reason in one place.
 */
/* One definition, in detect/index.ts, because two lists that must agree
   and are edited separately is how this repository breaks. */
const CONTEXT_ONLY = CONTEXT_KINDS;

/**
 * The price at which this detection's idea is wrong.
 *
 * Generic over shapes on purpose: every detector already publishes its geometry
 * in data coordinates, so the invalidation is derivable from what is drawn and
 * cannot drift out of step with it. The rule is the first level price would
 * break — the NEAREST shape-derived price on the losing side — because that is
 * the one that settles the question first, whatever the pattern is called.
 */
export function invalidationOf(
  shapes: readonly Shape[],
  direction: "long" | "short",
  price: number,
  atBar: number,
): number | null {
  const long = direction === "long";
  let best: number | null = null;
  const offer = (y: number): void => {
    if (!Number.isFinite(y) || y <= 0) return;
    // Strictly on the losing side. A "stop" the wrong side of entry is not one.
    if (long ? y >= price : y <= price) return;
    if (best === null || (long ? y > best : y < best)) best = y;
  };

  for (const s of shapes) {
    switch (s.type) {
      case "level":
        offer(s.y);
        break;
      case "line": {
        /* Evaluated AT THE LIVE BAR, not at either endpoint. A trendline's
           invalidation is where the line is now, which is the whole point of a
           sloping level. */
        const span = s.x1 - s.x0;
        const y = span === 0 ? s.y0 : s.y0 + ((s.y1 - s.y0) * (atBar - s.x0)) / span;
        offer(y);
        break;
      }
      case "box":
        /* The FAR edge. Price entering a demand zone has not invalidated it;
           leaving it out the other side has. */
        offer(long ? Math.min(s.y0, s.y1) : Math.max(s.y0, s.y1));
        break;
      case "marker":
        break;
    }
  }
  return best;
}

/** Turn detections into candidates, dropping what cannot be traded. */
export function candidatesFrom(input: EngineInputs): Candidate[] {
  const out: Candidate[] = [];
  for (const d of input.detections) {
    if (d.direction === "neutral") continue;
    if (CONTEXT_ONLY.has(d.kind)) continue;
    out.push({
      id: d.id,
      kind: d.kind,
      label: d.label,
      direction: d.direction,
      confirmedAt: d.to,
      confidence: d.confidence,
      reason: d.reason,
      invalidation: invalidationOf(d.shapes, d.direction, input.price, input.atBar),
    });
  }
  return out;
}

/**
 * Wilson lower bound at 95%, the same one the rest of the terminal uses.
 *
 * A win rate from six trades is not a win rate. The lower bound shrinks toward
 * zero as the sample shrinks, so a lucky streak cannot promote a setup kind up
 * the ranking on the strength of three results.
 */
function wilsonLow(wins: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / d);
}

/**
 * Can this candidate be taken at all?
 *
 * Two conditions, both about TIME AND PLACE rather than quality. Everything
 * else this file measures is a matter of degree; these two are not, and
 * expressing them as weights let a good score elsewhere override them.
 */
function disqualify(c: Candidate, i: EngineInputs, age: number, liveFor: number): string {
  /* AGAINST THE READ IS A DISQUALIFIER, NOT A PENALTY, AND THE REASON IS
     MECHANICAL AS WELL AS EDITORIAL.
     The plan's direction comes from the evidence read. A candidate pointing the
     other way supplies an invalidation level on the WRONG SIDE of entry, and a
     stop above entry on a long is not a bad stop, it is not a stop. Scoring
     this as a weight let a fresh, well-located, high-confidence short win the
     ranking on a long chart and hand the plan builder a level it could only
     misuse. The conflict is worth SEEING, which is why the candidate stays in
     `ranked` with this sentence attached. */
  if (i.bias === "long" || i.bias === "short") {
    if (c.direction !== i.bias) {
      return `Points ${c.direction}, but the read is ${i.bias} — it cannot supply the stop.`;
    }
  }
  if (age > liveFor) {
    return `Confirmed ${age} bars ago — too old (it stays valid for ${liveFor} bars).`;
  }
  if (c.invalidation !== null && i.atr > 0) {
    const travelled = Math.abs(i.price - c.invalidation) / i.atr;
    if (travelled > i.maxAtrMultiple) {
      return `Price ran ${travelled.toFixed(1)}× ATR past the level (your max is ${i.maxAtrMultiple}×) — missed it.`;
    }
  }
  return "";
}

function scoreOne(c: Candidate, i: EngineInputs): RankedSetup {
  const liveFor = i.liveForBars ?? DEFAULT_LIVE_BARS;
  const age = Math.max(0, i.atBar - c.confirmedAt);
  const factors: Factor[] = [];

  /* 1. AGREEMENT — does this point the same way as the evidence?
        Weighted by the read's own conviction: a 12%-confidence read agreeing
        with a setup is barely a fact, and treating it as a full endorsement is
        how a thin read gets laundered into a strong one. */
  if (i.bias === null || i.bias === "neutral") {
    factors.push({
      id: "agreement",
      label: "Backed by the read",
      score: null,
      weight: 0.3,
      note: "The analysis leans neither way here.",
    });
  } else {
    /* Direction agreement is settled by `disqualify` above, so what is left to
       score is HOW MUCH is behind it. A 12%-conviction read agreeing with a
       setup is barely a fact, and treating that as a full endorsement is how a
       thin read gets laundered into a strong one. */
    const conviction = clamp01(i.conviction);
    const agrees = i.bias === c.direction;
    factors.push({
      id: "agreement",
      label: "Backed by the read",
      score: agrees ? 0.5 + conviction * 0.5 : 0,
      weight: 0.3,
      note: agrees
        ? `Same direction as the read (${i.bias}, ${Math.round(conviction * 100)}% confidence).`
        : `Points ${c.direction}; the read is ${i.bias} (${Math.round(conviction * 100)}% confidence).`,
    });
  }

  /* 2. FRESHNESS — a setup you cannot still take is not a setup. */
  factors.push({
    id: "fresh",
    label: "Still live",
    score: clamp01(1 - age / liveFor),
    weight: 0.25,
    note:
      age === 0
        ? "Confirmed on the last closed bar."
        : `Confirmed ${age} ${age === 1 ? "bar" : "bars"} ago, against a ${liveFor}-bar life.`,
  });

  /* 3. REACH — has price already gone without you? Measured in ATR because a
        distance in price means nothing across instruments. */
  if (!(i.atr > 0)) {
    factors.push({
      id: "reach",
      label: "Price still near the trigger",
      score: null,
      weight: 0.2,
      note: "No ATR yet — distance can't be judged.",
    });
  } else if (c.invalidation === null) {
    factors.push({
      id: "reach",
      label: "Price still near the trigger",
      score: null,
      weight: 0.2,
      note: "This pattern has no level to measure from.",
    });
  } else {
    const travelled = Math.abs(i.price - c.invalidation) / i.atr;
    /* Best when price sits between the floor and the ceiling the operator has
       already set for a stop — that is exactly the window in which this
       invalidation makes a takeable trade. */
    const lo = i.minAtrMultiple;
    const hi = i.maxAtrMultiple;
    const score =
      travelled < lo
        ? clamp01(travelled / Math.max(lo, 1e-9))
        : travelled > hi
          ? clamp01(hi / travelled)
          : 1;
    factors.push({
      id: "reach",
      label: "Price still near the trigger",
      score,
      weight: 0.2,
      note:
        travelled < lo
          ? `Price is ${travelled.toFixed(2)}× ATR from the level — under your ${lo}× minimum, so the stop would be too tight.`
          : travelled > hi
            ? `Price ran ${travelled.toFixed(1)}× ATR past the level (max ${hi}×) — already moved.`
            : `Price is ${travelled.toFixed(2)}× ATR from the level, inside your ${lo}–${hi}× band.`,
    });
  }

  /* 4. INVALIDATION — does it say where it is wrong? */
  factors.push({
    id: "invalidation",
    label: "Names where it is wrong",
    score: c.invalidation === null ? 0 : 1,
    weight: 0.15,
    note:
      c.invalidation === null
        ? "No level — the stop would be based on volatility."
        : `Invalidated on a close through ${c.invalidation.toFixed(c.invalidation >= 1000 ? 2 : 4)}.`,
  });

  /* 5. RECORD — the only learned input, and it is the operator's own. */
  const rec = i.record?.(c.kind) ?? null;
  const n = rec === null ? 0 : rec.wins + rec.losses;
  if (rec === null || n === 0) {
    factors.push({
      id: "record",
      label: "Your record on this setup",
      score: null,
      weight: 0.1,
      note: "No track record on this setup yet — not counted either way.",
    });
  } else {
    const low = wilsonLow(rec.wins, n);
    factors.push({
      id: "record",
      label: "Your record on this setup",
      score: clamp01(low),
      weight: 0.1,
      note: `${rec.wins} of ${n} went your way (${Math.round(low * 100)}% at the cautious end, which is what counts).`,
    });
  }

  let weighted = 0;
  let usedWeight = 0;
  let totalWeight = 0;
  for (const f of factors) {
    totalWeight += f.weight;
    if (f.score === null) continue;
    weighted += f.score * f.weight;
    usedWeight += f.weight;
  }
  const score = usedWeight > 0 ? weighted / usedWeight : 0;
  const grounded = totalWeight > 0 ? usedWeight / totalWeight : 0;

  /* The weakest scored factor, named. "What would make this better" is more
     use than a number, and it is the same information. */
  const weakest = factors
    .filter((f) => f.score !== null)
    .sort((a, b) => (a.score as number) - (b.score as number))[0];

  return {
    candidate: c,
    score,
    grounded,
    factors,
    missing: weakest && (weakest.score as number) < 0.6 ? weakest.note : "",
    disqualified: disqualify(c, i, age, liveFor),
  };
}

/**
 * Rank the field and choose, or refuse.
 *
 * Deterministic and pure: same inputs, same answer, every time. That is not a
 * stylistic preference — a selector that can return two answers for one chart
 * cannot be held to a track record, and the track record is the only thing
 * that makes any of this checkable.
 */
export function chooseSetup(input: EngineInputs): EngineResult {
  const candidates = candidatesFrom(input);
  if (candidates.length === 0) {
    return {
      best: null,
      ranked: [],
      refusal:
        "No trade — no directional setup on this chart.",
      waitingFor: "",
    };
  }

  const scored = candidates.map((c) => scoreOne(c, input));
  /* Takeable ones first, then by score. Disqualified candidates STAY in the
     list — "four candidates and all of them expired" is a materially different
     chart from "no candidates", and the operator should be able to see which
     one they are looking at. */
  const ranked = [...scored].sort(
    (a, b) =>
      Number(a.disqualified !== "") - Number(b.disqualified !== "") ||
      b.score - a.score ||
      b.candidate.confidence - a.candidate.confidence,
  );

  const live = ranked.filter((r) => r.disqualified === "");
  if (live.length === 0) {
    const nearest = ranked[0] as RankedSetup;
    return {
      best: null,
      ranked,
      refusal: `No trade — none of the ${ranked.length} ${ranked.length === 1 ? "setup" : "setups"} found can still be taken.`,
      waitingFor: nearest.disqualified,
    };
  }

  const top = live[0] as RankedSetup;

  if (top.grounded < MIN_GROUNDED) {
    return {
      best: null,
      ranked,
      refusal: `No trade — the best setup (${top.candidate.label}) had only ${Math.round(top.grounded * 100)}% of the data it needs.`,
      waitingFor: top.missing,
    };
  }

  if (top.score < MIN_SETUP_SCORE) {
    return {
      best: null,
      ranked,
      refusal: `No trade — the best of ${ranked.length} setups (${top.candidate.label}) scores ${Math.round(top.score * 100)}, under the ${Math.round(MIN_SETUP_SCORE * 100)} minimum.`,
      waitingFor: top.missing,
    };
  }

  return { best: top, ranked, refusal: "", waitingFor: "" };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One line saying how the winner was arrived at.
 *
 * The card renders a single setup name, so nothing on it distinguishes "the
 * only thing on the chart" from "the best of ninety-one, eighty-one of which
 * could not be taken". Those are different amounts of evidence for the same
 * word, and a selector nobody can see the working of is indistinguishable from
 * the one this replaced — which picked the global maximum and looked just as
 * confident doing it.
 *
 * Measured on BTCUSDT 1m: 91 candidates, 81 disqualified, survivors scoring 92
 * down to 24.
 */
/**
 * The best candidate that is a genuinely DIFFERENT idea from the winner.
 *
 * Higher-timeframe projections put the same structure on the chart more than
 * once — a 1d sell-side sweep and its 15m projection are one idea seen twice,
 * and they tie by construction. Measured on ETHUSDT 1d, where the top two were
 * exactly that and the margin warning fired on a field with no real ambiguity
 * in it. Two candidates count as one idea when they share a kind and a
 * direction and their invalidations sit within a quarter of an ATR.
 */
function rivalTo(
  best: RankedSetup,
  ranked: readonly RankedSetup[],
  atr: number,
): RankedSetup | null {
  const near = Number.isFinite(atr) && atr > 0 ? atr * 0.25 : 0;
  for (const r of ranked) {
    if (r === best || r.disqualified !== "") continue;
    const sameKind = r.candidate.kind === best.candidate.kind;
    const sameSide = r.candidate.direction === best.candidate.direction;
    const a = r.candidate.invalidation;
    const b = best.candidate.invalidation;
    const sameLevel = a !== null && b !== null && Math.abs(a - b) <= near;
    if (sameKind && sameSide && (sameLevel || near === 0)) continue;
    return r;
  }
  return null;
}

export function chosenLine(r: EngineResult, atrHint = NaN): string {
  const best = r.best;
  if (best === null) return "";
  const total = r.ranked.length;
  const dropped = r.ranked.filter((x) => x.disqualified !== "").length;
  const parts = [`scored ${Math.round(best.score * 100)}`];
  if (total > 1) {
    parts.push(
      dropped > 0
        ? `best of ${total} found, ${dropped} no longer takeable`
        : `best of ${total} found`,
    );
  }

  /**
   * HOW CLEARLY IT WON, WHICH MATTERS MORE THE BIGGER THE FIELD IS.
   *
   * Measured across twelve charts: 86 to 309 candidates each, 4 to 42 of them
   * takeable. Picking the maximum of forty draws produces a high number
   * whether or not the winner is any good — that is the same selection bias
   * the PBO figure on this card is about. A margin of 1 point over the
   * runner-up means the name at the top is close to arbitrary and swapping it
   * for the second would change nothing; a margin of 40 means the choice is
   * real. Stating it is the difference between a ranking and a leaderboard.
   */
  const runnerUp = rivalTo(best, r.ranked, atrHint);
  if (runnerUp) {
    const margin = Math.round((best.score - runnerUp.score) * 100);
    parts.push(
      margin < 5
        ? `about equal to ${runnerUp.candidate.label.toLowerCase()} — close call`
        : `${margin} ahead of ${runnerUp.candidate.label.toLowerCase()}`,
    );
  }

  if (best.grounded < 1) {
    parts.push(`${Math.round(best.grounded * 100)}% of its data available`);
  }
  return `${best.candidate.label} — ${parts.join(", ")}.`;
}
