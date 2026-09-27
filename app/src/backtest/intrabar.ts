/**
 * Which came first, the stop or the target.
 *
 * `engine.ts` rule 2 states the problem and the standing answer: "When a bar
 * contains both your stop and your target, assume the STOP. A daily bar that
 * traded through both tells you nothing about the order." That is right, and it
 * is PESSIMISTIC — it turns some winners into losers, so it understates edge
 * rather than inventing it, which is the correct direction to be wrong in.
 *
 * It is also the largest remaining source of error in the engine, and it is an
 * assumption rather than a measurement. With minute bars inside the parent bar
 * the order stops being a guess.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 *
 * 1. **Claim a measurement from partial coverage.** If the true first touch
 *    happened in a minute nobody has, walking the minutes that ARE present
 *    finds the SECOND touch and reports it with total confidence — a loser
 *    printed as a winner. So the minutes must cover the parent bar, and when
 *    they do not the pessimistic rule stands. Same shape as the study whose
 *    dead vendors vanished from its reported window.
 *
 * 2. **Pretend a minute is finer than it is.** A minute holding BOTH levels is
 *    exactly the original problem one level down, and the same argument
 *    applies: it tells you nothing about the order. Fall back, and say so.
 *
 * 3. **Answer a question the caller has malformed.** A long whose stop sits
 *    above its target is not a trade. Resolving it would bury the caller's bug
 *    inside a plausible-looking result.
 *
 * Every answer carries `basis`, because a resolved exit and a guessed one must
 * not be indistinguishable downstream — the house rule that a computed figure
 * states whether it is measured or modelled is the whole reason it exists.
 */

import type { BarView } from "../chart/series";
import type { Direction } from "./engine";

/** The span of the bar being settled: `[from, to)` in epoch ms. */
export interface BarSpan {
  readonly from: number;
  readonly to: number;
}

export interface Levels {
  readonly stop: number;
  readonly target: number;
  readonly direction: Direction;
}

export interface IntrabarResult {
  readonly hit: "stop" | "target" | "neither";
  /** Whether the ORDER was read off the minutes, or fallen back to the rule. */
  readonly basis: "measured" | "assumed";
  /** Minutes inside the span that were available. Lets a caller audit it. */
  readonly minutes: number;
  /** Why, when the basis is `assumed`. Empty when measured. */
  readonly why: string;
}

/**
 * The largest hole tolerated inside the parent bar before coverage is refused.
 *
 * One minute, because a minute bar IS the resolution: a gap of exactly one bar
 * width is contiguous data, not a hole. Anything larger and a touch could have
 * happened where nobody was looking.
 */
const MINUTE_MS = 60_000;

/**
 * Settle one parent bar against its minutes.
 *
 * `minutes` must be ascending by `t` and lie inside `span`; anything outside is
 * ignored rather than trusted, because a minute from the next bar would settle
 * this one on the future.
 */
export function settleBar(
  minutes: readonly BarView[],
  span: BarSpan,
  levels: Levels,
): IntrabarResult {
  const { stop, target, direction } = levels;

  /* A long stops BELOW and targets ABOVE; a short is the mirror. A caller that
     has them the wrong way round has a bug, and answering would hide it. */
  const wrongWay =
    direction === "long" ? !(stop < target) : !(stop > target);
  if (wrongWay) {
    return {
      hit: "neither",
      basis: "assumed",
      minutes: 0,
      why: `the stop is on the wrong side of the target for a ${direction}`,
    };
  }

  const inside = minutes.filter((b) => b.t >= span.from && b.t < span.to);
  const assumed = (why: string): IntrabarResult => ({
    hit: "stop",
    basis: "assumed",
    minutes: inside.length,
    why,
  });

  if (inside.length === 0) return assumed("no minute bars for this bar");

  /* COVERAGE FIRST, before reading anything off them. A first touch inside a
     missing minute makes the walk below find the second touch and call it the
     first, which is the one failure mode that flips the sign of the result. */
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (first === undefined || last === undefined) return assumed("no minute bars for this bar");
  if (first.t - span.from >= MINUTE_MS) {
    return assumed("the minutes start after the bar does");
  }
  if (span.to - (last.t + MINUTE_MS) >= MINUTE_MS) {
    return assumed("the minutes end before the bar does");
  }
  for (let i = 1; i < inside.length; i += 1) {
    const prev = inside[i - 1];
    const cur = inside[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.t - prev.t > MINUTE_MS) {
      return assumed("a minute is missing from the middle of the bar");
    }
  }

  /* Touching the level exactly IS a fill. Requiring a strict break understates
     stops, which overstates the system — the wrong direction to be wrong. */
  for (const b of inside) {
    const hitStop = direction === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = direction === "long" ? b.h >= target : b.l <= target;
    if (hitStop && hitTarget) {
      return {
        hit: "stop",
        basis: "assumed",
        minutes: inside.length,
        why: "one minute held both levels, so the order is still unknown",
      };
    }
    if (hitStop) return { hit: "stop", basis: "measured", minutes: inside.length, why: "" };
    if (hitTarget) return { hit: "target", basis: "measured", minutes: inside.length, why: "" };
  }

  return { hit: "neither", basis: "measured", minutes: inside.length, why: "" };
}

/** What a run of settled bars was able to measure, for reporting on screen. */
export interface SettleTally {
  readonly measured: number;
  readonly assumed: number;
  /** 0..1. A backtest whose exits are mostly assumed is a weaker claim. */
  readonly share: number;
}

/**
 * How much of a backtest's exits were actually resolved.
 *
 * Reported rather than inferred: "84% of exits measured" and "every exit
 * assumed" are different claims about the same equity curve, and a result that
 * does not say which is a result that cannot be argued with.
 */
export function tally(results: readonly IntrabarResult[]): SettleTally {
  let measured = 0;
  for (const r of results) if (r.basis === "measured") measured += 1;
  const n = results.length;
  return { measured, assumed: n - measured, share: n === 0 ? 0 : measured / n };
}
