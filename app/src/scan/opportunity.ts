/**
 * One symbol's tradeable opportunity, computed the way the chart computes it.
 *
 * WHY THIS FILE EXISTS
 * The terminal had two opportunity engines that never met. The screener ranked
 * fifty symbols by a direction score and could not say where to get in, where
 * the idea was wrong, or whether it had ever worked. The Setup card said all
 * three — for the ONE symbol on the chart. Finding an opportunity meant
 * clicking through the screener a row at a time to learn what the card thought.
 *
 * This runs the card's pipeline per symbol, unchanged: the same detectors, the
 * same `chooseSetup`, the same `buildPlan`, the same `simulateKind` replay. A
 * second, simpler engine for the table would have been faster to write and
 * would have disagreed with the card the first time anyone compared them.
 *
 * WHAT IT REFUSES
 *  - A plan when the engine chose no setup. The chart learned this the hard
 *    way (see "NO SETUP, NO PLAN" in ui/shell.ts); a table of fifty rows would
 *    repeat it fifty times.
 *  - To call a thin replay an edge. `edge` is null unless the replay reached
 *    `MIN_TRIALS`, and it is measured on the Wilson LOWER bound, never on the
 *    raw hit rate — three wins in three is not 100%.
 *  - To read the forming bar. Detectors on the chart see closed bars only; a
 *    scan that did otherwise would report structure that can still un-form.
 *
 * WHAT IT DOES NOT CLAIM
 * The replay is in-sample: the analogues are found on the same bars they are
 * scored over, on at most a thousand of them. It is a base rate for THIS
 * pattern on THIS instrument, not a forecast, and ranking the whole universe by
 * it would select the luckiest history — so `compareOpportunities` sorts by the
 * engine's own score first and uses edge only to demote the historically
 * adverse. The same reasoning as "THE SECOND OPINION" in ui/shell.ts.
 */

import type { BarView } from "../chart/series";
import { atr as atrSeries } from "../chart/indicators";
import { DEFAULT_DETECTORS, runDetectors, toDetectInput, type DetectorId } from "../detect/index";
import { chooseSetup, liveBarsFor } from "../setup/engine";
import { buildPlan, planRMultiple } from "../setup/plan";
import { breakEven, simulateKind } from "../setup/simulate";
import { HORIZON_BARS } from "../learn/claim";

/** Below this there is no stable ATR and nothing for the replay to score. */
export const MIN_OPPORTUNITY_BARS = 120;

export interface OpportunityContext {
  /** Bar duration, for the live window and to recognise the forming bar. */
  readonly intervalMs: number;
  /** The confluence read's lean, or null when there was none. */
  readonly bias: "long" | "short" | "neutral" | null;
  /** 0..1. */
  readonly conviction: number;
  /** The operator's own stop band, in ATR — the same rules the card uses. */
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  /** Wall clock, injected so tests do not depend on today. */
  readonly now: number;
  readonly detectors?: readonly DetectorId[];
}

export interface OpportunityHistory {
  /** Scoreable replays of this kind and direction. */
  readonly n: number;
  readonly hitRate: number | null;
  /** Wilson 95% lower bound. The number to quote. */
  readonly hitLow: number | null;
  readonly expectancy: number | null;
  /** n >= MIN_TRIALS. */
  readonly enough: boolean;
  /** The whole 90% expectancy interval is below zero. */
  readonly adverse: boolean;
  readonly note: string;
}

export interface Opportunity {
  readonly kind: string;
  readonly label: string;
  readonly direction: "long" | "short";
  readonly reason: string;
  /** Engine score 0..1 and the share of its weight that had an input. */
  readonly score: number;
  readonly grounded: number;
  /** Closed bars since the pattern became knowable. 0 = on the last close. */
  readonly barsAgo: number;
  readonly entry: number;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly stop: number;
  readonly target1: number;
  readonly target2: number;
  /** Reward-to-risk to target 1. */
  readonly rMultiple: number;
  /** Stop distance as a share of price — what one R costs in percent. */
  readonly riskPct: number;
  readonly stopFrom: "structure" | "volatility";
  readonly history: OpportunityHistory;
  /**
   * Wilson-low hit rate minus the break-even rate at this R, or null when the
   * replay is too thin to say. Positive means history clears the bar even on
   * its pessimistic reading.
   */
  readonly edge: number | null;
}

export type OpportunityRead =
  | { readonly ok: true; readonly opportunity: Opportunity }
  | { readonly ok: false; readonly reason: string };

/** Drop a trailing bar whose interval has not closed yet. */
export function closedBars(bars: readonly BarView[], intervalMs: number, now: number): readonly BarView[] {
  const last = bars[bars.length - 1];
  if (last !== undefined && intervalMs > 0 && last.t + intervalMs > now) return bars.slice(0, -1);
  return bars;
}

export function findOpportunity(bars: readonly BarView[], ctx: OpportunityContext): OpportunityRead {
  const closed = closedBars(bars, ctx.intervalMs, ctx.now);
  if (closed.length < MIN_OPPORTUNITY_BARS) {
    return {
      ok: false,
      reason: `${closed.length} closed bars; a setup needs at least ${MIN_OPPORTUNITY_BARS} to measure volatility and replay history.`,
    };
  }

  const data = toDetectInput(closed);
  const len = data.c.length;
  const atBar = len - 1;
  const price = data.c[atBar] as number;
  const atr = atrSeries(data.h, data.l, data.c, 14)[atBar] as number;
  if (!(atr > 0)) return { ok: false, reason: "ATR is not measurable on this series." };

  const detections = runDetectors(data, ctx.detectors ?? DEFAULT_DETECTORS, len);
  const chosen = chooseSetup({
    detections,
    atBar,
    price,
    atr,
    bias: ctx.bias,
    conviction: Math.max(0, Math.min(1, ctx.conviction)),
    maxAtrMultiple: ctx.maxStopAtr,
    minAtrMultiple: ctx.minStopAtr,
    liveForBars: liveBarsFor(ctx.intervalMs),
  });
  const best = chosen.best;
  if (best === null) return { ok: false, reason: chosen.refusal || "No setup cleared the engine's floor." };

  const c = best.candidate;
  /* The CANDIDATE's direction, not the read's. The chart plans in the read's
     direction because it shows one read and one card; a table row is about the
     setup, and a short plan hung on a long setup's invalidation would place the
     stop on the wrong side of entry. */
  const built = buildPlan({
    direction: c.direction,
    price,
    atr,
    swing: c.invalidation,
    minAtrMultiple: ctx.minStopAtr,
    maxAtrMultiple: ctx.maxStopAtr,
  });
  if (!built.ok) return { ok: false, reason: built.reason };
  const rMultiple = planRMultiple(built);
  if (!(rMultiple > 0)) return { ok: false, reason: "The plan has no measurable reward-to-risk." };

  const sim = simulateKind(c.kind, c.direction, detections, data, len, {
    rMultiple,
    horizonBars: HORIZON_BARS,
    atrStopMultiple: ctx.minStopAtr,
    minAtrMultiple: ctx.minStopAtr,
  });
  const edge = sim.enough && sim.hitLow !== null ? sim.hitLow - breakEven(rMultiple) : null;

  return {
    ok: true,
    opportunity: {
      kind: c.kind,
      label: c.label,
      direction: c.direction,
      reason: c.reason,
      score: best.score,
      grounded: best.grounded,
      barsAgo: Math.max(0, atBar - c.confirmedAt),
      entry: built.entry,
      entryLow: built.entryLow,
      entryHigh: built.entryHigh,
      stop: built.stop,
      target1: built.target1,
      target2: built.target2,
      rMultiple,
      riskPct: price > 0 ? built.r / price : 0,
      stopFrom: built.stopFrom,
      history: {
        n: sim.n,
        hitRate: sim.hitRate,
        hitLow: sim.hitLow,
        expectancy: sim.expectancy,
        enough: sim.enough,
        adverse: sim.adverse,
        note: sim.note,
      },
      edge,
    },
  };
}

/**
 * Order for the table.
 *
 * Historically ADVERSE setups sort below everything else — that is a refusal,
 * not a preference. Otherwise by engine score scaled by how grounded it is,
 * then freshness. Edge breaks ties only: see the header for why an in-sample
 * base rate must not be the primary key.
 */
export function compareOpportunities(a: Opportunity, b: Opportunity): number {
  if (a.history.adverse !== b.history.adverse) return a.history.adverse ? 1 : -1;
  const sa = a.score * a.grounded;
  const sb = b.score * b.grounded;
  if (Math.abs(sb - sa) > 1e-9) return sb - sa;
  if (a.barsAgo !== b.barsAgo) return a.barsAgo - b.barsAgo;
  return (b.edge ?? -Infinity) - (a.edge ?? -Infinity);
}

/**
 * Symbols whose opportunity is new since the previous scan.
 *
 * Keyed on symbol, kind and direction — a setup that merely re-priced its entry
 * as the bars moved is the same opportunity, and flagging it as new on every
 * rescan would teach the operator to ignore the flag.
 */
export function newSince(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, Opportunity>,
): Set<string> {
  const out = new Set<string>();
  for (const [symbol, o] of current) {
    if (previous.get(symbol) !== `${o.kind}|${o.direction}`) out.add(symbol);
  }
  return out;
}

export function opportunityKey(o: Opportunity): string {
  return `${o.kind}|${o.direction}`;
}
