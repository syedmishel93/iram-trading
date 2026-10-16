/**
 * IS IT WORKING NOW — the half a backtest cannot answer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHY IT IS NOT A SECOND ENGINE
 *
 * A backtest is a description of the past. Everything this terminal reports is
 * "worked"; nothing has ever reported "working". `arming.ts` records the gap
 * in its own header — the two server-side watchers were not written for a
 * `RuleSpec` — and the obvious fix, a live daemon that watches a rule tick by
 * tick, is a second engine with its own fill model and its own warm-up. The
 * first time it disagreed with the backtester there would be no way to tell
 * which was right.
 *
 * So this is not a watcher. A frozen rule over stored bars is DETERMINISTIC:
 * run the same engine, on the same terms, over only the bars that arrived
 * AFTER the rule was armed. The terminal does not need to have been open.
 * Nothing is re-fitted, nothing is re-chosen, and the result is out of sample
 * by construction — the rule existed, unchanged, before those bars did.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THE WHOLE FILE IS
 *
 * NO RE-OPTIMISING DURING THE VALIDATION WINDOW. That is the standing
 * requirement of walk-forward validation and it is the one thing a forward
 * record can quietly violate: edit the rule, keep the record, and every figure
 * becomes a claim about a strategy that did not exist for most of it.
 *
 * So the armed SHAPE is fingerprinted. A record whose rule no longer hashes to
 * what was armed is refused outright rather than reported with a caveat —
 * `stale` is a refusal, not a warning, because a caveat on a number is a thing
 * people read past.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND IT REFUSES A RATE IT CANNOT SUPPORT
 *
 * Fourteen firings cannot separate a 64% rule from a coin. The hit rate is
 * `null` until there are enough, and `null` is not zero: this product already
 * records a service returning a null rate for a population with nothing
 * decided, and a client that rendered it as 0.0% would have said every claim
 * lost. A TIMEOUT is kept out of the denominator too — "nothing happened" is
 * not "I was wrong", and only the second is worth learning to avoid.
 */

import { runBacktest, type BacktestOptions, type Trade } from "./engine";
import { compileSpec, type RuleSpec } from "./rules";
import type { BarView } from "../chart/series";

/** Firings below this cannot support a rate. Stated, not hidden in a formula. */
export const MIN_FORWARD_TRADES = 40;

/**
 * The armed rule's fingerprint.
 *
 * Over the SHAPE that decides trades — the id, the style, the direction, the
 * entry and exit conditions, the stop and the target — and deliberately not
 * over the name or the note, which a person may reword without changing what
 * it does. Renaming a rule must not throw away its forward record, and
 * changing a threshold must.
 */
export function specFingerprint(spec: RuleSpec): string {
  const shape = JSON.stringify({
    id: spec.id,
    style: spec.style,
    long: spec.long,
    short: spec.short ?? null,
    exitLong: spec.exitLong ?? null,
    exitShort: spec.exitShort ?? null,
    stop: spec.stop,
    target: spec.target,
  });
  let h = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface Armed {
  readonly specId: string;
  /** What the rule looked like when it was armed. See `specFingerprint`. */
  readonly fingerprint: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** Epoch ms. Only bars STRICTLY after this count. */
  readonly armedAt: number;
}

export type ForwardState =
  /** Armed, and no bar has closed since. Not a failure. */
  | "waiting"
  /** Firing, but too few to state a rate. */
  | "thin"
  /** Enough to state a rate. */
  | "measured"
  /** The rule changed since it was armed. The record cannot be read. */
  | "stale";

export interface Forward {
  readonly state: ForwardState;
  readonly symbol: string;
  readonly timeframe: string;
  readonly armedAt: number;
  /** Bars that have closed since arming. */
  readonly bars: number;
  readonly fired: number;
  readonly won: number;
  readonly lost: number;
  /** Reached neither level inside the horizon. Its own outcome, not a loss. */
  readonly timedOut: number;
  /**
   * Wins over wins-plus-losses, or null.
   *
   * NULL IS NOT ZERO. Null says nothing has been decided yet; 0.0 says every
   * decided firing lost. This product has already shipped a client that
   * rendered the first as the second.
   */
  readonly hitRate: number | null;
  /** Total R across decided firings. Null while nothing is decided. */
  readonly totalR: number | null;
  /** One line, addressed to the operator. Always populated. */
  readonly says: string;
}

const empty = (a: Armed, state: ForwardState, bars: number, says: string): Forward => ({
  state,
  symbol: a.symbol,
  timeframe: a.timeframe,
  armedAt: a.armedAt,
  bars,
  fired: 0,
  won: 0,
  lost: 0,
  timedOut: 0,
  hitRate: null,
  totalR: null,
  says,
});

/**
 * What this rule has done since it was armed.
 *
 * `bars` is the WHOLE series; the slicing happens here so a caller cannot
 * accidentally hand over a window that starts before the arm and call the
 * result forward evidence. The warm-up is the one exception and it is handled
 * by the engine, which is given the bars it needs to compute indicators and
 * told where the record starts.
 */
export function forwardSince(
  spec: RuleSpec,
  armed: Armed,
  bars: readonly BarView[],
  opts: BacktestOptions = {},
): Forward {
  /* THE REFUSAL COMES FIRST, because everything below it would otherwise be a
     claim about a rule that no longer exists. */
  if (specFingerprint(spec) !== armed.fingerprint) {
    return empty(
      armed,
      "stale",
      0,
      "This rule has been edited since it was armed, so its forward record is about a different rule. Re-arm it to start a new one.",
    );
  }

  const after = bars.filter((b) => b.t > armed.armedAt);
  if (after.length === 0) {
    return empty(armed, "waiting", 0, "Armed. No bar has closed since.");
  }

  /* The engine needs history BEFORE the window to warm its indicators up — a
     rule reading EMA 200 cannot fire on the first bar after arming. It is
     given the whole series and the trades outside the window are dropped,
     which is the only way the indicator values match what a live reader would
     have seen. */
  const strategy = compileSpec(spec);
  const run = runBacktest(strategy, bars, opts);
  if (run.refused !== null) {
    return empty(armed, "waiting", after.length, `Could not be measured: ${run.refused}`);
  }

  const mine = run.trades.filter((t: Trade) => t.entryTime > armed.armedAt);
  const won = mine.filter((t) => t.exitReason === "target").length;
  const lost = mine.filter((t) => t.exitReason === "stop").length;
  /* "rule" and "end-of-data" exits are neither: the first is the rule closing
     its own position, the second is a trade still open when the bars ran out.
     Counting either as a loss would teach a reader that "nothing happened"
     looks like "I was wrong". */
  const timedOut = mine.length - won - lost;
  const decided = won + lost;

  const totalR = decided === 0 ? null : rOf(mine);

  if (mine.length === 0) {
    return {
      ...empty(armed, "thin", after.length, `Armed, ${days(armed.armedAt, after)} ago. It has not fired yet.`),
      bars: after.length,
    };
  }

  const thin = decided < MIN_FORWARD_TRADES;
  const hitRate = thin || decided === 0 ? null : won / decided;

  return {
    state: thin ? "thin" : "measured",
    symbol: armed.symbol,
    timeframe: armed.timeframe,
    armedAt: armed.armedAt,
    bars: after.length,
    fired: mine.length,
    won,
    lost,
    timedOut,
    hitRate,
    totalR,
    says: thin
      ? `${mine.length} fired since arming — ${decided} decided, too few to state a rate. About ${MIN_FORWARD_TRADES - decided} more needed.`
      : `${Math.round((hitRate as number) * 100)}% of ${decided} decided firings reached target.`,
  };
}

/**
 * R across the firings, read off the trades rather than recomputed.
 *
 * `rMultiple` is the engine's own figure, charged with the engine's own costs.
 * My first version recomputed it from the entry and exit prices and could only
 * recover the risk for a STOPPED trade — so it summed the losses and skipped
 * the wins, and would have reported a profitable rule as negative. The engine
 * already knows; asking it is both shorter and the only version that can agree
 * with the backtest this record is meant to be compared against.
 *
 * Over DECIDED firings only. A trade still open when the bars ran out has an
 * R so far, not an R.
 */
function rOf(trades: readonly Trade[]): number {
  let sum = 0;
  for (const t of trades) {
    if (t.exitReason === "target" || t.exitReason === "stop") sum += t.rMultiple;
  }
  return sum;
}

function days(armedAt: number, after: readonly BarView[]): string {
  const last = after[after.length - 1];
  const ms = (last === undefined ? Date.now() : last.t) - armedAt;
  const d = Math.max(0, Math.round(ms / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
}
