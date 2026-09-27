/**
 * The trade plan — entry, stop, targets — derived from structure and ATR.
 *
 * WHAT THIS IS
 * Arithmetic over things already measured: the last swing the chart found, the
 * ATR it already computes, and the direction the decision layer already leans.
 * It is a STARTING POINT you can read and argue with, not a recommendation.
 *
 * WHY THE PLAN IS HELD STILL
 * Re-deriving entry and stop from the live price on every tick makes the
 * numbers crawl, and a plan whose stop moved while you were reading it is a
 * plan you cannot act on — you would type one number and the card would already
 * be showing another. So a plan is pinned once drawn and only redrawn when the
 * direction flips or price has genuinely walked away from where it was drawn.
 * v39 learned this the hard way and the same rule is restated here because it
 * is the difference between a usable card and a slot machine.
 *
 * WHY THE STOP PREFERS STRUCTURE OVER ATR
 * A stop placed purely by volatility ignores the level it is protecting
 * against. The swing is the reason the trade is wrong if it breaks; the ATR
 * multiple is only the floor, so a very tight swing cannot produce a stop
 * inside the noise. Whichever is FURTHER from entry wins.
 */

export type Direction = "long" | "short";

export interface PlanInputs {
  readonly direction: Direction;
  readonly price: number;
  /** Measured ATR at the newest closed bar. */
  readonly atr: number;
  /** Last swing low (for a long) or high (for a short), if the chart found one. */
  readonly swing: number | null;
  /** Minimum stop distance, in ATR. Keeps a tight swing out of the noise. */
  readonly minAtrMultiple?: number;
  /** Padding beyond the swing, in ATR, so a wick does not take you out. */
  readonly padAtr?: number;
  /**
   * The furthest a stop may sit, in ATR — the operator's own sanity ceiling.
   *
   * THE PLAN AND THE GATE WERE FIGHTING EACH OTHER. The stop rule below picks
   * the structural level whenever it is further from entry than the volatility
   * floor, with nothing bounding how far that is. The stop-sanity gate then
   * refuses anything past this ceiling. So on any chart whose nearest level
   * happened to be more than a few ATR away, the plan builder chose a stop the
   * gate was guaranteed to reject, every time, and the only thing the card
   * could say about it was "wait for a closer level".
   *
   * That is a permanent stand-down produced by two correct rules pointing in
   * opposite directions, and it is what "it is always stand down" turned out
   * to mean. Given the ceiling, the builder stops proposing stops that cannot
   * be taken and reports the level it had to give up on instead — see
   * `structureOutOfReach`, which is strictly more information than the
   * dead-end message it replaces.
   *
   * Omitted means unbounded, which is the old behaviour.
   */
  readonly maxAtrMultiple?: number;
}

export interface TradePlan {
  readonly direction: Direction;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly entry: number;
  readonly stop: number;
  readonly target1: number;
  readonly target2: number;
  /** Distance from entry to stop, in price. One R. */
  readonly r: number;
  /**
   * The stop in ATR **as it stood when the plan was drawn**.
   *
   * NOT THE NUMBER TO CHECK A STOP AGAINST. A plan is deliberately held still
   * once drawn — see `stablePlan` — so this ratio freezes with it while ATR
   * carries on moving. Use `stopAtrNow()` for anything that decides something;
   * this field is only good for saying what the plan looked like at the time.
   */
  readonly stopAtrMultiple: number;
  /** Which input actually set the stop, so the card can say so. */
  readonly stopFrom: "structure" | "volatility";
  /**
   * How far, in ATR, the structural level was when it was too far to use.
   *
   * Null whenever the structure stop was taken, or when there was no level.
   * When it is set, the plan is a VOLATILITY stop and the number says what was
   * given up: price can reach this stop without the idea being wrong, because
   * the level that would actually invalidate the idea is this many ATR away.
   * A trader can act on that. "Wait for a closer level" was not something
   * anyone could act on.
   */
  readonly structureOutOfReach: number | null;
  /** Price when this plan was drawn; drives `planIsStale`. */
  readonly drawnAt: number;
}

/**
 * The stop in ATR, measured against the ATR on screen right now.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO CLOSE
 *
 * `stopAtrMultiple` is computed once, at draw time, and the plan is then held
 * still on purpose. The stop-sanity gate read that stored field and treated it
 * as current, which made the gate a statement about a moment that had passed.
 *
 * Measured on XAUUSD, switching 1m → 1h → 1m without touching anything else:
 *
 *     chart ATR      1.45  →  18.80  →  1.49
 *     card said     23.84× → 23.84× → 23.84×
 *     truth on 1h                1.83×
 *
 * On the hourly chart the card refused a trade for a stop "23.84× ATR, your
 * sane band is 0.5–3×" when the stop was 1.83× ATR and would have passed. A
 * permanent, unexplained stand-down produced entirely by a stale denominator.
 *
 * The plan's PRICES still do not move — a number that drifts while you read it
 * is worse than one slightly behind, which is the whole point of holding it.
 * What moves is the check on it, because "is this stop sane" is a question
 * about the volatility that exists now.
 */
/**
 * The plan's reward-to-risk, as a multiple.
 *
 * WHY THIS IS A FUNCTION AND NOT A FIELD
 * `plan.r` is ONE R MEASURED IN PRICE — the entry-to-stop distance — and it is
 * named `r` because that is what traders call that distance. It is not the
 * reward-to-risk multiple, and the two are trivially confusable at a call site
 * where both would typecheck as `number`.
 *
 * They were confused, once, in earnest: the setup simulator took `plan.r` as
 * its target multiple and placed simulated targets 165 R away on ETHUSDT 1d.
 * All twelve replayed trials stopped out, the card reported a hit rate of zero
 * and flagged the setup as historically adverse, and every number in that
 * chain was internally consistent. Nothing but live data caught it.
 *
 * So the conversion lives here, next to the field it is derived from, and
 * anything wanting "how many R does this plan aim for" calls this instead of
 * doing the division itself.
 *
 * Measured to `target1`: the first target is the one the plan actually commits
 * to, and the one a hit rate must be quoted at to mean anything.
 */
export function planRMultiple(plan: TradePlan): number {
  if (!(plan.r > 0)) return 0;
  return Math.abs(plan.target1 - plan.entry) / plan.r;
}

export function stopAtrNow(plan: TradePlan, atr: number): number {
  if (!Number.isFinite(atr) || atr <= 0) return NaN;
  return plan.r / atr;
}

export const DEFAULT_MIN_ATR = 1;
export const DEFAULT_PAD_ATR = 0.15;
/** Entry zone half-width, in ATR. A zone, because a single tick is not a plan. */
const ZONE_ATR = 0.25;

export interface PlanFailure {
  readonly ok: false;
  readonly reason: string;
}
export type PlanResult = ({ ok: true } & TradePlan) | PlanFailure;

export function buildPlan(input: PlanInputs): PlanResult {
  const { direction, price, atr, swing } = input;

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: "No price on the chart yet." };
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    /* Refuse rather than substitute a percentage of price: a made-up
       volatility produces a real-looking stop and a real-looking size. */
    return { ok: false, reason: "ATR is not available for this series, so a stop cannot be placed." };
  }

  const minAtr = input.minAtrMultiple ?? DEFAULT_MIN_ATR;
  const pad = input.padAtr ?? DEFAULT_PAD_ATR;
  const long = direction === "long";

  const volatilityStop = long ? price - atr * minAtr : price + atr * minAtr;
  const structureStop =
    swing !== null && Number.isFinite(swing)
      ? long
        ? swing - atr * pad
        : swing + atr * pad
      : null;

  /* Whichever sits FURTHER from entry. A structure stop inside the ATR floor is
     a stop inside the noise; an ATR stop closer than the swing ignores the
     level that would actually invalidate the idea. */
  let stop = volatilityStop;
  let stopFrom: TradePlan["stopFrom"] = "volatility";
  let structureOutOfReach: number | null = null;
  if (structureStop !== null) {
    const structureIsFurther = long ? structureStop < volatilityStop : structureStop > volatilityStop;
    if (structureIsFurther) {
      /* Only if it is takeable. A stop the operator's own ceiling forbids is
         not a better stop than the volatility one — it is a plan that cannot
         be acted on. See `maxAtrMultiple`. */
      const structureAtr = Math.abs(price - structureStop) / atr;
      const ceiling = input.maxAtrMultiple;
      if (ceiling !== undefined && Number.isFinite(ceiling) && structureAtr > ceiling) {
        structureOutOfReach = structureAtr;
      } else {
        stop = structureStop;
        stopFrom = "structure";
      }
    }
  }

  if (stop <= 0) return { ok: false, reason: "That stop lands at or below zero." };

  const r = Math.abs(price - stop);
  if (r <= 0) return { ok: false, reason: "The stop and the entry are the same price." };

  return {
    ok: true,
    direction,
    entry: price,
    entryLow: price - atr * ZONE_ATR,
    entryHigh: price + atr * ZONE_ATR,
    stop,
    target1: long ? price + r : price - r,
    target2: long ? price + 2 * r : price - 2 * r,
    r,
    stopAtrMultiple: r / atr,
    stopFrom,
    structureOutOfReach,
    drawnAt: price,
  };
}

/**
 * Has price walked far enough from where the plan was drawn to redraw it?
 *
 * The threshold is in ATR so it means the same thing on gold and on a memecoin.
 * Below it the plan is kept EXACTLY as drawn — not nudged, not recomputed —
 * because a number that drifts while you read it is worse than one that is
 * slightly behind.
 */
export const REDRAW_ATR = 0.4;

export function planIsStale(plan: TradePlan, price: number, atr: number, direction: Direction): boolean {
  if (plan.direction !== direction) return true;
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return false;
  return Math.abs(price - plan.drawnAt) >= REDRAW_ATR * atr;
}

/**
 * Keep the previous plan unless it is genuinely out of date.
 *
 * The whole stability rule in one call, so no caller has to remember it.
 */
export function stablePlan(
  previous: TradePlan | null,
  input: PlanInputs,
): PlanResult {
  if (previous && !planIsStale(previous, input.price, input.atr, input.direction)) {
    return { ok: true, ...previous };
  }
  return buildPlan(input);
}
