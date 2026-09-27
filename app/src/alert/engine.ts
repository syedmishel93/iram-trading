/**
 * Alert evaluation.
 *
 * A pure function over bars. That is not tidiness for its own sake — it is what
 * makes an alert TESTABLE AGAINST HISTORY. Because evaluating the last bar and
 * evaluating six months use the same code path, the alerts you get live are the
 * alerts a replay would have given you, and any disagreement is a bug rather
 * than a mystery.
 *
 * THREE THINGS IT REFUSES TO DO
 *  - Fire on a forming bar. Everything except `touch` is judged on closes, and
 *    a forming bar has no close. The "close" of the current bar is the last
 *    trade, and it changes; an alert that fires on it un-fires a second later.
 *  - Fire on hindsight. An alert anchored to a structure cannot fire on or
 *    before the bar that revealed the structure. See anchor.ts `validFrom`.
 *  - Fire repeatedly on one event. Every condition carries hysteresis: the
 *    state must reset before it can fire again. Price sitting exactly on a
 *    trendline produces one alert, not one per bar.
 */

import type { DetectInput } from "../detect/types";
import type { Band, ResolvedAnchor } from "./anchor";
import type { AlertCondition, AlertFire, AlertSpec } from "./types";

/** How the price sat relative to the anchor on one bar. */
type Side = "above" | "below" | "inside";

function sideOf(close: number, band: Band): Side {
  if (close > band.hi) return "above";
  if (close < band.lo) return "below";
  return "inside";
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
}

function satisfied(cond: AlertCondition, prev: Side, cur: Side): boolean {
  switch (cond) {
    // "inside" counts as not-yet-above, so a close that starts on the line and
    // then clears it is a genuine cross rather than a missed one.
    case "cross-above":
      return prev !== "above" && cur === "above";
    case "cross-below":
      return prev !== "below" && cur === "below";
    case "cross-any":
      return (prev !== "above" && cur === "above") || (prev !== "below" && cur === "below");
    case "enter":
      return prev !== "inside" && cur === "inside";
    case "exit":
      return prev === "inside" && cur !== "inside";
    case "touch":
      return false; // handled separately: it reads the range, not the close
  }
}

function reasonFor(
  cond: AlertCondition,
  label: string,
  price: number,
  anchorPrice: number,
): string {
  const at = `${label} at ${fmt(anchorPrice)}`;
  switch (cond) {
    case "cross-above":
      return `Closed ${fmt(price)}, above ${at}`;
    case "cross-below":
      return `Closed ${fmt(price)}, below ${at}`;
    case "cross-any":
      return `Closed ${fmt(price)}, through ${at}`;
    case "enter":
      return `Closed ${fmt(price)}, inside ${label}`;
    case "exit":
      return `Closed ${fmt(price)}, out of ${label}`;
    case "touch":
      return `Wick reached ${fmt(anchorPrice)} on ${label} — not confirmed by a close`;
  }
}

export interface EvaluateOptions {
  /**
   * Number of CLOSED bars. Anything at or beyond this index is still forming
   * and is not evidence of anything yet.
   */
  closedCount: number;
  /**
   * Only report fires at or after this index. Used to turn a full-history
   * evaluation into "what is new since I last looked" without changing any of
   * the state machine that produced it.
   */
  since?: number;
}

/**
 * Run one alert over the bars and return every fire it would have produced.
 *
 * The whole history is always walked, even when only the newest bar is wanted.
 * That is deliberate: hysteresis and cooldown are path-dependent, so deciding
 * whether the newest bar fires REQUIRES knowing whether the alert was already
 * triggered. Evaluating the last bar in isolation is how an alert fires every
 * single bar of a trend.
 */
export function evaluateAlert(
  spec: AlertSpec,
  data: DetectInput,
  anchor: ResolvedAnchor,
  opts: EvaluateOptions,
): AlertFire[] {
  const out: AlertFire[] = [];
  const end = Math.min(opts.closedCount, data.c.length);
  /**
   * Start one bar EARLY, purely to learn which side price was on.
   *
   * A crossing is a comparison between two bars, so the first bar that may fire
   * needs a predecessor. Reading the predecessor is not hindsight: at
   * `validFrom` the structure is known AND the previous bar has already closed,
   * so both facts are legitimately in hand. Seeding at `validFrom` instead
   * would silently swallow a break that happens on the very first bar after
   * confirmation — which is the most important one there is.
   */
  const seed = Math.max(0, anchor.validFrom - 1);
  const since = opts.since ?? 0;

  let prev: Side | null = null;
  let lastFire = -Infinity;
  /** Hysteresis for `touch`: the range must clear the anchor before re-arming. */
  let touching = false;

  for (let i = seed; i < end; i++) {
    /** Below this the bar only informs state; it can never raise an alert. */
    const mayFire = i >= anchor.validFrom;
    const band = anchor.at(i);
    if (band === null) {
      prev = null;
      touching = false;
      continue;
    }

    const close = data.c[i] as number;

    if (spec.condition === "touch") {
      const hi = data.h[i] as number;
      const lo = data.l[i] as number;
      const hit = hi >= band.lo && lo <= band.hi;
      const fires = mayFire && hit && !touching && i - lastFire >= spec.cooldownBars;
      touching = hit;
      if (!fires) continue;
      lastFire = i;
      if (i >= since) {
        // Report the extreme that actually reached it, not the close: the close
        // may be nowhere near, and saying otherwise would misdescribe the event.
        const reached = hi >= band.lo && hi <= band.hi ? hi : lo;
        out.push({
          alertId: spec.id,
          index: i,
          time: data.t[i] as number,
          price: reached,
          anchorPrice: (band.lo + band.hi) / 2,
          reason: reasonFor("touch", anchor.label, reached, (band.lo + band.hi) / 2),
        });
      }
      if (spec.once) break;
      continue;
    }

    const cur = sideOf(close, band);
    // The first resolvable bar establishes the side. It cannot be a crossing,
    // because there is nothing to have crossed FROM.
    if (prev === null) {
      prev = cur;
      continue;
    }

    if (mayFire && satisfied(spec.condition, prev, cur) && i - lastFire >= spec.cooldownBars) {
      lastFire = i;
      if (i >= since) {
        const anchorPrice = cur === "above" ? band.hi : cur === "below" ? band.lo : (band.lo + band.hi) / 2;
        out.push({
          alertId: spec.id,
          index: i,
          time: data.t[i] as number,
          price: close,
          anchorPrice,
          reason: reasonFor(spec.condition, anchor.label, close, anchorPrice),
        });
      }
      prev = cur;
      if (spec.once) break;
      continue;
    }

    prev = cur;
  }

  return out;
}
