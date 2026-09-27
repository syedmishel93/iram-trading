/**
 * A claim: something the terminal said, written down so it can be marked wrong.
 *
 * WHY THIS FILE EXISTS
 * Before it, IRAM learnt nothing. Not "learnt slowly" — nothing. The quant
 * service says so in its own header: "the service holds no state". Every model
 * fit was computed, rendered, and discarded. Every Setup read was rendered and
 * discarded. The terminal has never once been in a position to answer the only
 * question that matters about a decision aid:
 *
 *     When it told me to take a trade, what happened next?
 *
 * A menu called "Machine learning" that showed model scores would not answer
 * that. It would show what the model said about the PAST it was fitted on,
 * which is the number every platform shows and the number that is wrong 89% of
 * the time here — that is what the measured PBO means. So the thing being
 * stored is not a model. It is the terminal's own track record, and the unit
 * of it is a claim.
 *
 * WHAT MAKES SOMETHING A CLAIM
 * It has to be falsifiable without hindsight. That means three prices — where
 * it would be entered, the level that means it was right, the level that means
 * it was wrong — and a deadline. Anything without those four is an opinion, and
 * an opinion cannot be scored. `buildClaim` refuses rather than filling a
 * missing one in, for the same reason `buildPlan` refuses a missing ATR: a
 * substituted level produces a real-looking outcome.
 *
 * THE PART THAT IS ACTUALLY WORTH HAVING
 * A claim is recorded whether or not the card said to take it. A read that
 * leans long and fails two gates is still a claim — it just carries
 * `verdict: "stand-down"`. Recording both is what lets the desk answer the
 * question nobody's platform will answer about its own filters:
 *
 *     Do the gates help, or do they just say no a lot?
 *
 * That is a comparison between two populations this file can produce and
 * nothing else in the repository can. If stand-downs resolve as well as takes,
 * the gates are costing money and the desk will say so.
 *
 * WHAT A CLAIM IS NOT
 * It is not training data. Nothing in this module feeds back into any score,
 * weight or threshold — see `learn/store.ts` for why that is a deliberate
 * refusal and not an unfinished feature.
 */

/** What the card told you to do with the lean it had. */
export type Verdict = "take" | "stand-down";

/**
 * How a claim ended.
 *
 * `unknowable` is separate from `expired` and both are separate from a loss.
 * A bar that traded through the target AND the stop does not say which came
 * first — OHLC cannot — so that claim is dropped from scoring rather than
 * guessed at. Folding it into either bucket injects a coin flip straight into
 * the hit rate, which is the statistic the whole desk rests on.
 */
export type Outcome = "pending" | "target" | "stop" | "expired" | "unknowable";

export interface Claim {
  readonly id: string;
  /** When the terminal said it. Epoch ms, real UTC. */
  readonly at: number;
  readonly symbol: string;
  readonly timeframe: string;
  /** The lean. A claim is never recorded without one — neutral says nothing. */
  readonly side: "long" | "short";
  readonly verdict: Verdict;
  /** How many gates were failing when this was said. 0 on a `take`. */
  readonly gatesFailed: number;

  /* ---- what it rested on, frozen at the time it was said ---- */

  /** −1..+1 directional score. */
  readonly score: number;
  /** 0..1 share of expected evidence that answered. */
  readonly coverage: number;
  /** 0..1 agreement scaled by coverage. */
  readonly confidence: number;
  /**
   * The chance of success the terminal implied, 0..1, or null when it implied
   * none.
   *
   * Null is the normal case and must stay distinct from 0.5. A claim with no
   * stated probability can still be scored for HIT RATE; it cannot be scored
   * for CALIBRATION, because calibration is the question "when it said 60%,
   * did it happen 60% of the time" and there is no 60% to check.
   */
  readonly probability: number | null;

  /* ---- how it gets marked ---- */

  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** After this, unresolved becomes `expired`. Epoch ms. */
  readonly expiresAt: number;

  /* ---- filled in later, by learn/resolve.ts ---- */

  readonly outcome: Outcome;
  readonly resolvedAt: number | null;
  /** The price that ended it, when one did. */
  readonly resolvedPrice: number | null;
  /** How long it took, in ms. Null while pending. */
  readonly heldMs: number | null;
}

export interface ClaimDraft {
  readonly symbol: string;
  readonly timeframe: string;
  readonly side: "long" | "short";
  readonly verdict: Verdict;
  readonly gatesFailed: number;
  readonly score: number;
  readonly coverage: number;
  readonly confidence: number;
  readonly probability?: number | null;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** How long the claim gets to come true, in ms. */
  readonly horizonMs: number;
}

export type ClaimResult = { readonly ok: true; readonly claim: Claim } | { readonly ok: false; readonly reason: string };

let counter = 0;

/**
 * Ids sort by creation time and carry no randomness.
 *
 * Same reasoning as `journal/store.ts`: nothing here is distributed, a
 * duplicate id means the same claim, and an id you can read by eye is worth
 * more than a UUID when the store has to be recovered by hand.
 */
export function makeClaimId(at: number): string {
  counter = (counter + 1) % 100000;
  return `c${at.toString(36)}-${counter.toString(36)}`;
}

/**
 * The shortest a claim may live.
 *
 * A horizon under a minute cannot be resolved from bars — the bar it was made
 * in has not closed. Rather than record something unresolvable and let it age
 * into `expired`, which would quietly depress the hit rate with claims that
 * never had a chance, it is refused.
 */
export const MIN_HORIZON_MS = 60_000;

/** The longest. Beyond a fortnight the claim is about a different market. */
export const MAX_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Build a claim, or say why not.
 *
 * Every refusal here is a case where scoring would have been possible but
 * meaningless. That distinction is the whole file: a claim that cannot be
 * marked wrong must not be counted among the ones that can, because the
 * denominator is what makes a hit rate a hit rate.
 */
export function buildClaim(draft: ClaimDraft, at: number): ClaimResult {
  const { entry, stop, target, side } = draft;

  for (const [name, v] of [
    ["entry", entry],
    ["stop", stop],
    ["target", target],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      return { ok: false, reason: `No usable ${name} price, so this read cannot be marked right or wrong later.` };
    }
  }

  /* The levels have to be on the correct sides of entry, or "reached the
     target" means something different from what the card showed. A long whose
     target sits below its entry is not a claim with an odd shape; it is a bug
     upstream, and recording it would bury that bug inside a hit rate. */
  const long = side === "long";
  if (long ? target <= entry : target >= entry) {
    return { ok: false, reason: `A ${side} claim needs its target ${long ? "above" : "below"} the entry.` };
  }
  if (long ? stop >= entry : stop <= entry) {
    return { ok: false, reason: `A ${side} claim needs its stop ${long ? "below" : "above"} the entry.` };
  }

  if (!Number.isFinite(draft.horizonMs) || draft.horizonMs < MIN_HORIZON_MS) {
    return {
      ok: false,
      reason: `A claim needs at least ${Math.round(MIN_HORIZON_MS / 1000)}s to come true. Anything shorter cannot be checked against a closed bar.`,
    };
  }
  const horizon = Math.min(draft.horizonMs, MAX_HORIZON_MS);

  const p = draft.probability;
  const probability = typeof p === "number" && Number.isFinite(p) && p > 0 && p < 1 ? p : null;

  return {
    ok: true,
    claim: {
      id: makeClaimId(at),
      at,
      symbol: draft.symbol.toUpperCase(),
      timeframe: draft.timeframe,
      side,
      verdict: draft.verdict,
      gatesFailed: Math.max(0, Math.round(draft.gatesFailed)),
      score: clamp(draft.score, -1, 1),
      coverage: clamp(draft.coverage, 0, 1),
      confidence: clamp(draft.confidence, 0, 1),
      probability,
      entry,
      stop,
      target,
      expiresAt: at + horizon,
      outcome: "pending",
      resolvedAt: null,
      resolvedPrice: null,
      heldMs: null,
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return !Number.isFinite(v) ? 0 : Math.min(hi, Math.max(lo, v));
}

/**
 * Reward-to-risk as the claim was drawn.
 *
 * Reported rather than gated on. A 0.4R claim is a bad trade and a perfectly
 * valid claim, and the desk should be able to show that low-R claims hit more
 * often while still losing money — which is the single most common way a hit
 * rate misleads, and the reason this number is kept beside it everywhere.
 */
export function claimR(c: Claim): number {
  const risk = Math.abs(c.entry - c.stop);
  return risk > 0 ? Math.abs(c.target - c.entry) / risk : NaN;
}

/** Did this claim make money, in R? Null while it cannot be known. */
export function claimR_realised(c: Claim): number | null {
  if (c.outcome === "target") return claimR(c);
  if (c.outcome === "stop") return -1;
  if (c.outcome === "expired") {
    /* Closed at the deadline, wherever price was. Without the exit price this
       is unknown rather than zero — "it did not reach either barrier" is not
       "it went nowhere", and scoring it as flat flatters every claim that was
       quietly deep in the red when the clock ran out. */
    if (c.resolvedPrice === null) return null;
    const risk = Math.abs(c.entry - c.stop);
    if (risk <= 0) return null;
    const move = c.side === "long" ? c.resolvedPrice - c.entry : c.entry - c.resolvedPrice;
    return move / risk;
  }
  return null;
}

/**
 * How long to wait before recording another claim on the same instrument.
 *
 * The Setup card recomputes on every tick. Without this, a chart left open for
 * an hour writes thousands of near-identical claims, all resolving together,
 * and the hit rate becomes a measurement of how long the tab was open. One
 * claim per side per instrument per window is the honest sampling rate.
 */
export const RECORD_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Should this draft be written down, given what is already stored?
 *
 * A new claim is allowed when nothing comparable is pending, when the cooldown
 * has passed, or when the terminal has genuinely CHANGED ITS MIND — a flipped
 * side, or a verdict that moved between take and stand-down. The last case is
 * the one that matters: a card that switches from stand-down to take is making
 * a new statement, and suppressing it to respect a timer would lose the only
 * claims the gates ever actually let through.
 */
export function shouldRecord(
  existing: readonly Claim[],
  draft: ClaimDraft,
  now: number,
  cooldownMs: number = RECORD_COOLDOWN_MS,
): boolean {
  const symbol = draft.symbol.toUpperCase();
  let newest: Claim | null = null;
  for (const c of existing) {
    if (c.symbol !== symbol || c.timeframe !== draft.timeframe) continue;
    if (newest === null || c.at > newest.at) newest = c;
  }
  if (newest === null) return true;
  if (newest.side !== draft.side) return true;
  if (newest.verdict !== draft.verdict) return true;
  return now - newest.at >= cooldownMs;
}

/**
 * How many bars a claim gets to come true.
 *
 * 24, matching `DEFAULT_HORIZON` in `server/quant/ml.py`. Not a coincidence and
 * not arbitrary: the Python classifier labels its training data with a
 * triple barrier over 24 bars, so a claim recorded here is asking the SAME
 * question over the SAME window. Two numbers that measure different horizons
 * cannot be compared, and being able to hold the terminal's live record next
 * to the model's fitted score is the entire reason to match them.
 */
export const HORIZON_BARS = 24;

/**
 * Whether a card verdict is a claim at all, and which kind.
 *
 * `go` and `armed` are both takes — armed means the gates cleared it and price
 * has not arrived yet, which is a statement about timing rather than about
 * permission.
 *
 * `unknown` is deliberately NOT recorded. It means the gates could not be
 * evaluated — a dead feed, an unmeasured clock — and it is neither a refusal
 * nor a clearance. Filing it under stand-downs would fill the "what the gates
 * blocked" population with cases where the gates never ran, and the whole
 * value of that population is that it contains genuine refusals to compare
 * against genuine clearances. A comparison contaminated at one end is worse
 * than no comparison, because it still produces a number.
 */
export function claimVerdict(kind: string): Verdict | null {
  if (kind === "go" || kind === "armed") return "take";
  if (kind === "stand-down" || kind === "conflict") return "stand-down";
  return null;
}

/**
 * Read one record back from storage, or reject it.
 *
 * Per-record and total, mirroring the journal: one corrupt claim must not cost
 * the whole track record, because a track record with a hole in it is exactly
 * the kind of damage nobody notices until they are relying on the number.
 */
export function sanitiseClaim(raw: unknown): Claim | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const num = (k: string): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  const id = str("id");
  const at = num("at");
  const symbol = str("symbol");
  const timeframe = str("timeframe");
  const side = o["side"];
  const verdict = o["verdict"];
  const outcome = o["outcome"];
  const entry = num("entry");
  const stop = num("stop");
  const target = num("target");
  const expiresAt = num("expiresAt");

  if (id === null || at === null || symbol === null || timeframe === null) return null;
  if (side !== "long" && side !== "short") return null;
  if (verdict !== "take" && verdict !== "stand-down") return null;
  if (
    outcome !== "pending" &&
    outcome !== "target" &&
    outcome !== "stop" &&
    outcome !== "expired" &&
    outcome !== "unknowable"
  ) {
    return null;
  }
  if (entry === null || stop === null || target === null || expiresAt === null) return null;

  const prob = num("probability");

  return {
    id,
    at,
    symbol: symbol.toUpperCase(),
    timeframe,
    side,
    verdict,
    gatesFailed: Math.max(0, Math.round(num("gatesFailed") ?? 0)),
    score: clamp(num("score") ?? 0, -1, 1),
    coverage: clamp(num("coverage") ?? 0, 0, 1),
    confidence: clamp(num("confidence") ?? 0, 0, 1),
    probability: prob !== null && prob > 0 && prob < 1 ? prob : null,
    entry,
    stop,
    target,
    expiresAt,
    outcome,
    resolvedAt: num("resolvedAt"),
    resolvedPrice: num("resolvedPrice"),
    heldMs: num("heldMs"),
  };
}
