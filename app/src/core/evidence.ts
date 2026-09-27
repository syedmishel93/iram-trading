/**
 * The evidence bus — one place every source puts what it knows.
 *
 * WHY THIS EXISTS
 * The terminal had grown eight things that each knew something: structure
 * detection, multi-timeframe, the confluence engine, the regime model, the
 * derivatives desk, fundamentals, cross-venue pricing, correlation. Each drew
 * its own panel. None of them could see each other, so the synthesis happened
 * in the user's head — which is the one place it is least reliable and least
 * auditable.
 *
 * This is not a scoring engine bolted on top. It is a common SHAPE that every
 * source reports in, plus one function that combines them. The combination is
 * deliberately simple and completely legible; the value is in the shape, not in
 * cleverness.
 *
 * THE THREE THINGS THIS DOES THAT A WEIGHTED AVERAGE DOES NOT
 *
 * 1. ABSENCE IS EVIDENCE. A source that could not answer is recorded as
 *    `absent` or `failed`, and it REDUCES COVERAGE. Four sources agreeing out
 *    of ten possible is not the same read as four agreeing out of four, and
 *    every naive blend reports them identically. Coverage is carried all the
 *    way to the headline so a thin read cannot pass as a strong one.
 *
 * 2. AGREEMENT IS SEPARATE FROM SCORE. Six sources leaning weakly one way and
 *    three leaning hard each way can average to the same number. They are not
 *    the same situation, and only one of them is worth acting on.
 *
 * 3. NOT EVERYTHING HAS A DIRECTION. A 6% float is not bullish or bearish; it
 *    is a fact that changes what a chart pattern is worth. Those carry
 *    `lean: null`, count toward coverage, contribute nothing to the score, and
 *    are still shown — because dropping them would be the panel deciding what
 *    you are allowed to consider.
 *
 * WHAT IT REFUSES TO DO
 * There is no threshold here that turns into a trade. `synthesise` returns a
 * lean, a confidence, a coverage figure and the sentences behind them. It does
 * not emit "buy". The standing recommendation on the confluence score — PBO
 * 89%, do not automate off it — applies to this with more force, not less,
 * because a number assembled from more inputs looks more authoritative and is
 * not.
 */

/** Which family a piece of evidence belongs to. Drives grouping, not weight. */
export type EvidenceGroup =
  | "structure"
  | "trend"
  | "flow"
  | "fundamental"
  | "onchain"
  | "venue"
  | "correlation"
  | "model"
  /** Scheduled events. Never directional — see decision.ts fromCalendar. */
  | "macro";

/**
 * Whether this source actually answered.
 *
 * `absent` and `failed` are different and both matter: absent means the source
 * does not cover this instrument (no on-chain data for gold), failed means it
 * should have and did not (the service is down). The first is a permanent
 * property of what you are looking at; the second is a thing you can fix.
 */
export type EvidenceState =
  | "fresh"
  | "stale"
  /** Asked, could have answered, did not. Counts against coverage. */
  | "absent"
  /** Asked, tried, errored. Counts against coverage, and is named separately. */
  | "failed"
  /**
   * This build has no such source at all. Listed, NOT counted.
   *
   * WHY THIS IS NOT `absent`
   * `absent` means "there was an answer to be had and we did not get it" — a
   * derivatives read on a spot pair, a calendar that has not loaded yet. It is
   * a gap, and gaps belong in the denominator, because a read standing on four
   * of ten sources must not present like four of four.
   *
   * An on-chain watcher that does not exist in this build is not a gap. It is
   * not a question the terminal is capable of asking, and counting it as one
   * subtracted a fixed 0.3 of 6.9 from EVERY read for ever — roughly four
   * points of coverage, on every instrument, permanently, for a capability
   * nobody had. That is not conservatism; it is a miscalibrated denominator,
   * and it pushes honest reads under the coverage floor for a reason that has
   * nothing to do with the market.
   *
   * It is still returned and still rendered, because silently dropping a source
   * from the list is how a terminal starts deciding what you are allowed to
   * know it does not have.
   */
  | "unavailable";

export interface Evidence {
  readonly id: string;
  readonly group: EvidenceGroup;
  readonly label: string;
  /**
   * Directional lean, −1 (short) to +1 (long). NULL means informational: the
   * fact matters but does not point a direction.
   */
  readonly lean: number | null;
  /** Relative importance, 0..1. Only compared against other evidence. */
  readonly weight: number;
  /** Plain language, shown verbatim. Never a code. */
  readonly reason: string;
  /** Where it came from. Rendered next to the reason. */
  readonly source: string;
  /** When the underlying data was true. 0 when not applicable. */
  readonly asOf: number;
  readonly state: EvidenceState;
  /**
   * True when this source can never answer FOR THIS INSTRUMENT.
   *
   * Not the same as `unavailable`, which is about the build. This is about the
   * instrument: gold has no perpetual, so there is no funding rate to read; the
   * fundamentals aggregator ranks crypto by market capitalisation and does not
   * list a metal; cross-venue pricing needs more than one venue quoting it.
   * None of those is a gap the operator can close, on any day, by any action.
   *
   * WHY IT HAS TO BE VISIBLE
   * The coverage FLOOR is a user rule — "refuse a read standing on less than
   * 60% of its evidence" — and it was being checked against a pool that, on a
   * non-crypto instrument, is 21% impossible. Measured on XAUUSD: derivatives
   * 0.7, fundamentals 0.4 and cross-venue 0.3 of an expected 6.6 cannot answer
   * on any day, at any hour, however healthy every service is. So a 60% floor
   * is really being asked of a 79% ceiling, and the card said "53% of sources
   * answered — your floor is 60%" as though the missing 7 points were somewhere
   * to be found.
   *
   * It still counts against coverage. Gold genuinely IS read on less evidence
   * than a perpetual, and hiding that would be the read flattering itself. What
   * changes is that the gate can say what was actually attainable.
   */
  readonly structural?: boolean;
  /** What would flip or invalidate this. The most useful field on the object. */
  readonly flip?: string;
}

export interface Read {
  /** −1..+1. Weighted mean of directional evidence only. */
  readonly score: number;
  readonly bias: "long" | "short" | "neutral";
  /** 0..1 — share of directional weight pulling with the bias. */
  readonly agreement: number;
  /**
   * 0..1 — share of the EXPECTED weight that actually answered.
   *
   * The number that stops four agreeing sources out of ten reading like four
   * out of four.
   */
  readonly coverage: number;
  /**
   * The most coverage this instrument could reach with every service healthy.
   *
   * 1 when nothing is structurally missing. Below 1 when a source cannot apply
   * here at all — see `Evidence.structural`. The coverage gate compares against
   * this so it can say what was attainable rather than implying that a floor it
   * cannot reach was simply not reached.
   */
  readonly attainable: number;
  /** 0..1. Agreement scaled by coverage, then gated. Never exceeds coverage. */
  readonly confidence: number;
  /** Sentences describing why the read is limited. Empty when it is not. */
  readonly limits: readonly string[];
  /** Every input, strongest contribution first. */
  readonly evidence: readonly Evidence[];
  /** Sources that did not answer, and which kind of not-answering it was. */
  readonly missing: readonly Evidence[];
  /** `flip` from the heaviest contributors — what would change the picture. */
  readonly wouldChange: readonly string[];
}

/** Below this share of expected weight, a read is not worth calling a read. */
export const MIN_COVERAGE = 0.35;

/** |score| under this is neutral. Deliberately wide. */
export const NEUTRAL_BAND = 0.12;

/** How many flip conditions to surface. More is a wall nobody reads. */
const MAX_FLIPS = 4;

/**
 * Below this share of agreement, the read says the sources disagree.
 *
 * Set at 0.7 rather than 0.6 so that a two-against-one split — 67% agreement,
 * and the most common shape of a genuinely contested read — gets named. At 0.6
 * that case passed silently, and an average that hides a third of its weight
 * pointing the other way is exactly what `agreement` exists to expose.
 */
const DISAGREEMENT_BELOW = 0.7;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Only fresh or stale evidence contributes; absent and failed cannot. */
function contributes(e: Evidence): boolean {
  return e.state === "fresh" || e.state === "stale";
}

/**
 * Stale evidence counts, at a discount.
 *
 * Dropping it entirely would make a five-minute-old funding rate equivalent to
 * having no funding data at all, which is wrong in the other direction. Half
 * weight says "this was true recently" without letting it drive.
 */
const STALE_DISCOUNT = 0.5;

function effectiveWeight(e: Evidence): number {
  const w = Number.isFinite(e.weight) ? clamp(e.weight, 0, 1) : 0;
  return e.state === "stale" ? w * STALE_DISCOUNT : w;
}

export function synthesise(input: readonly Evidence[]): Read {
  const all = input.filter((e) => Number.isFinite(e.weight));
  const missing = all.filter((e) => !contributes(e));
  const present = all.filter(contributes);

  /* Coverage is measured against every source that WAS ASKED, including the
     ones that could not answer. That is the whole point of the figure.

     `unavailable` is the one exclusion, and it is not a loophole: it means this
     build cannot ask the question at all, so there was never an answer to be
     missing. See EvidenceState. */
  const asked = all.filter((e) => e.state !== "unavailable");
  const expected = asked.reduce((sum, e) => sum + clamp(e.weight, 0, 1), 0);
  const answered = present.reduce((sum, e) => sum + effectiveWeight(e), 0);
  const coverage = expected > 0 ? clamp(answered / expected, 0, 1) : 0;

  /* What the best possible day looks like on THIS instrument. Structural gaps
     stay in `expected` — the read really is thinner — but they come out of the
     ceiling, so the gate can distinguish "you are missing evidence" from "this
     evidence does not exist here". */
  const impossible = asked
    .filter((e) => e.structural === true)
    .reduce((sum, e) => sum + clamp(e.weight, 0, 1), 0);
  const attainable = expected > 0 ? clamp((expected - impossible) / expected, 0, 1) : 0;

  const directional = present.filter((e) => e.lean !== null);
  const directionalWeight = directional.reduce((sum, e) => sum + effectiveWeight(e), 0);

  const score =
    directionalWeight > 0
      ? clamp(
          directional.reduce((sum, e) => sum + (e.lean as number) * effectiveWeight(e), 0) /
            directionalWeight,
          -1,
          1,
        )
      : 0;

  const bias: Read["bias"] = score > NEUTRAL_BAND ? "long" : score < -NEUTRAL_BAND ? "short" : "neutral";

  /* Agreement: share of directional weight pointing the same way as the bias.
     Neutral gets 0 rather than 1 — nothing agrees on nothing. */
  const withBias =
    bias === "neutral"
      ? 0
      : directional
          .filter((e) => (bias === "long" ? (e.lean as number) > 0 : (e.lean as number) < 0))
          .reduce((sum, e) => sum + effectiveWeight(e), 0);
  const agreement = directionalWeight > 0 ? clamp(withBias / directionalWeight, 0, 1) : 0;

  const limits: string[] = [];

  if (coverage < MIN_COVERAGE) {
    /**
     * Enough precision that the comparison in the sentence is visible.
     *
     * Both numbers were `.toFixed(0)`, so a coverage of 34.7% against a 35%
     * floor rendered as "Only 35% ... That is below the 35% floor" — a
     * sentence that contradicts itself, photographed on XAUUSD 1h. The
     * comparison was right and the rendering made it read as wrong, which for
     * a line whose whole job is to be believed is the same as being wrong.
     *
     * One decimal only when the two would otherwise collide: "34.7% ... below
     * the 35% floor" is precise where it needs to be and unchanged everywhere
     * else, and a permanent decimal on a coverage figure implies a precision
     * this number does not have.
     */
    const collides =
      Math.round(coverage * 100) === Math.round(MIN_COVERAGE * 100);
    const shown = (coverage * 100).toFixed(collides ? 1 : 0);
    limits.push(
      `Only ${shown}% of the evidence this read expects actually answered. That is below the ${(MIN_COVERAGE * 100).toFixed(0)}% floor — treat the direction as unsupported rather than weak.`,
    );
  }

  const failed = missing.filter((e) => e.state === "failed");
  if (failed.length > 0) {
    limits.push(
      `${failed.length} source${failed.length === 1 ? "" : "s"} failed rather than being unavailable: ${failed.map((e) => e.label).join(", ")}. That is fixable, and until it is the read is thinner than it looks.`,
    );
  }

  const absent = missing.filter((e) => e.state === "absent");
  if (absent.length > 0) {
    /**
     * The aggregate line must NOT assert a cause.
     *
     * It originally read "... do not cover this instrument", which was true of
     * on-chain data on gold and false of everything else in the list: a higher
     * timeframe nobody enabled, a model nobody ran, a scan that has not
     * happened. Each row carries its own accurate reason, so the summary counts
     * and points rather than explaining — and says the one thing that IS true
     * of all of them, which is that silence is not a neutral vote.
     */
    limits.push(
      `${absent.length} source${absent.length === 1 ? "" : "s"} had nothing to say here: ${absent.map((e) => e.label).join(", ")}. Each row below says why. Not answering is not the same as answering neutral.`,
    );
  }

  const stale = present.filter((e) => e.state === "stale");
  if (stale.length > 0) {
    limits.push(
      `${stale.map((e) => e.label).join(", ")} ${stale.length === 1 ? "is" : "are"} stale and counted at half weight.`,
    );
  }

  if (directional.length > 0 && agreement < DISAGREEMENT_BELOW && bias !== "neutral") {
    limits.push(
      `Only ${(agreement * 100).toFixed(0)}% of the directional weight leans ${bias}. The sources disagree; the average hides that.`,
    );
  }

  /**
   * Confidence is agreement SCALED BY COVERAGE, and can never exceed coverage.
   *
   * Perfect agreement among two sources out of ten is not high confidence, and
   * every blend that multiplies without that ceiling will eventually report
   * one. Below the coverage floor it is zeroed outright rather than reported
   * small, because a small confidence still reads as a direction.
   */
  const confidence = coverage < MIN_COVERAGE ? 0 : clamp(agreement * coverage, 0, coverage);

  const ranked = present
    .slice()
    .sort((a, b) => {
      const ca = Math.abs(a.lean ?? 0) * effectiveWeight(a);
      const cb = Math.abs(b.lean ?? 0) * effectiveWeight(b);
      if (cb !== ca) return cb - ca;
      /* Informational evidence sorts by weight so it does not all sink to the
         bottom in registration order. */
      return effectiveWeight(b) - effectiveWeight(a);
    });

  const wouldChange = ranked
    .filter((e) => typeof e.flip === "string" && e.flip.length > 0)
    .slice(0, MAX_FLIPS)
    .map((e) => `${e.label}: ${e.flip as string}`);

  return {
    score,
    bias,
    agreement,
    coverage,
    confidence,
    limits,
    evidence: ranked,
    attainable,
    missing,
    wouldChange,
  };
}

/* ------------------------------------------------------------- helpers --- */

/** Build an absent marker so a source that cannot answer still counts. */
export function absent(
  id: string,
  group: EvidenceGroup,
  label: string,
  weight: number,
  reason: string,
  /** Set when this instrument can never have this source. See `structural`. */
  structural = false,
): Evidence {
  return {
    id,
    group,
    label,
    lean: null,
    weight,
    reason,
    source: "—",
    asOf: 0,
    state: "absent",
    ...(structural ? { structural: true } : {}),
  };
}

/**
 * Build a not-in-this-build marker. Listed, never counted — see EvidenceState.
 *
 * Use this ONLY when the terminal has no such subsystem. A source that exists
 * and merely has not loaded yet is `absent`, and calling it unavailable would
 * be a read quietly grading itself on a curve.
 */
export function unavailable(
  id: string,
  group: EvidenceGroup,
  label: string,
  weight: number,
  reason: string,
): Evidence {
  return { id, group, label, lean: null, weight, reason, source: "—", asOf: 0, state: "unavailable" };
}

/** Build a failure marker. Distinct from absent — see EvidenceState. */
export function failed(
  id: string,
  group: EvidenceGroup,
  label: string,
  weight: number,
  reason: string,
): Evidence {
  return { id, group, label, lean: null, weight, reason, source: "—", asOf: 0, state: "failed" };
}

/**
 * Mark evidence stale when its data is older than `maxAgeMs`.
 *
 * Applied by the caller at assembly time rather than inside each source,
 * because "how old is too old" depends on the timeframe you are trading, not on
 * where the number came from.
 */
export function ageCheck(e: Evidence, maxAgeMs: number, now = Date.now()): Evidence {
  if (e.state !== "fresh" || e.asOf <= 0) return e;
  return now - e.asOf > maxAgeMs ? { ...e, state: "stale" } : e;
}

/** Group evidence for rendering, preserving the ranked order inside each. */
export function byGroup(evidence: readonly Evidence[]): Map<EvidenceGroup, Evidence[]> {
  const out = new Map<EvidenceGroup, Evidence[]>();
  for (const e of evidence) {
    const list = out.get(e.group);
    if (list) list.push(e);
    else out.set(e.group, [e]);
  }
  return out;
}

/** Human label for a lean, used in every surface that renders one. */
export function leanLabel(lean: number | null): string {
  if (lean === null) return "context";
  if (lean > 0.5) return "strong long";
  if (lean > 0.12) return "long";
  if (lean < -0.5) return "strong short";
  if (lean < -0.12) return "short";
  return "flat";
}
