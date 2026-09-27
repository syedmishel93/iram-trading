/**
 * Managing the trade after it is on.
 *
 * WHY THIS IS THE MISSING HALF
 * `setup/plan.ts` produces entry, stop and two targets, and then nothing in
 * the terminal has an opinion about the position ever again. That is the half
 * of a trade that decides the outcome. The entry sets what you can make; the
 * exit sets what you keep, and a plan that stops at "here is your stop" has
 * handed back the decision at exactly the point it gets hard.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR THINGS THAT CAN END A TRADE, AND WHY THE THIRD IS THE POINT
 *
 *  1. THE STOP. Price reached the level that said you were wrong.
 *  2. THE TARGET. Price reached the level that said you were right.
 *  3. INVALIDATION. **The reason you took it stopped being true.** A long
 *     taken on a bullish break of structure is no longer that trade once
 *     structure breaks the other way — even at a profit, even nowhere near the
 *     stop. Nothing in this terminal has ever told you that, and it is the
 *     exit that separates a plan from a hope: the other three are prices, and
 *     this one is a fact about the market.
 *  4. TIME. A setup that has not worked in N bars is a different setup. The
 *     edge in a structural entry decays; the capital is still tied up.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not move your stop for you, and it does not close anything. It
 * reports what each rule WOULD say right now and why, and the two trailing
 * methods are shown SIDE BY SIDE rather than one being picked — because which
 * one is better is a question with a measured answer, and that answer belongs
 * to the journal and the backtest lab, not to a default chosen here.
 *
 * That is not timidity about automation. A terminal that silently moved a stop
 * would be making the most consequential decision in the trade on a rule the
 * user never chose and cannot see.
 */

import { atr, chandelier } from "../chart/indicators";
import type { BarView } from "../chart/series";
import type { Direction } from "./plan";

export type ExitReason = "stop" | "target" | "invalidation" | "time" | "trail";

export interface ExitRules {
  /** Take part of the position off at this R multiple. 0 disables it. */
  readonly partialAtR: number;
  /** Move the stop to entry once this R multiple is reached. 0 disables it. */
  readonly breakEvenAtR: number;
  /** ATR multiple for the Chandelier trail. */
  readonly trailAtr: number;
  /** Lookback for the Chandelier trail and for structural trailing. */
  readonly trailBars: number;
  /** Stand down after this many bars with the trade unresolved. 0 disables. */
  readonly timeStopBars: number;
}

export const DEFAULT_EXIT_RULES: ExitRules = {
  partialAtR: 1,
  breakEvenAtR: 1,
  trailAtr: 3,
  trailBars: 22,
  timeStopBars: 20,
};

export const EXIT_LIMITS = {
  /* Below 0.25R a partial is noise and costs two sets of fees. Above 5R it
     never fires and the setting is decoration. */
  partialAtR: [0, 5],
  breakEvenAtR: [0, 5],
  /* Under 1 ATR a trail sits inside the noise and is hit by the bar it was set
     on. Over 10 it is further away than any stop anyone would place. */
  trailAtr: [1, 10],
  trailBars: [5, 100],
  timeStopBars: [0, 500],
} as const satisfies Record<keyof ExitRules, readonly [number, number]>;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** Clamped on read as well as write, for the reason `setup/rules.ts` gives. */
export function sanitiseExitRules(value: unknown): ExitRules {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    partialAtR: clamp(v["partialAtR"], EXIT_LIMITS.partialAtR, DEFAULT_EXIT_RULES.partialAtR),
    breakEvenAtR: clamp(v["breakEvenAtR"], EXIT_LIMITS.breakEvenAtR, DEFAULT_EXIT_RULES.breakEvenAtR),
    trailAtr: clamp(v["trailAtr"], EXIT_LIMITS.trailAtr, DEFAULT_EXIT_RULES.trailAtr),
    trailBars: Math.round(clamp(v["trailBars"], EXIT_LIMITS.trailBars, DEFAULT_EXIT_RULES.trailBars)),
    timeStopBars: Math.round(
      clamp(v["timeStopBars"], EXIT_LIMITS.timeStopBars, DEFAULT_EXIT_RULES.timeStopBars),
    ),
  };
}

export function exitRulesAreDefault(r: ExitRules): boolean {
  return (Object.keys(DEFAULT_EXIT_RULES) as (keyof ExitRules)[]).every(
    (k) => r[k] === DEFAULT_EXIT_RULES[k],
  );
}

export interface OpenTrade {
  readonly direction: Direction;
  readonly entry: number;
  readonly stop: number;
  readonly target: number | null;
  /** Bar index the position was opened at, within the loaded series. */
  readonly openedAtBar: number;
  /**
   * What the trade was taken on — "bos", "liquidity-sweep", "fvg".
   *
   * This is what makes rule 3 possible. Without it there is no "reason" for
   * the reason to stop being true, and invalidation collapses back into the
   * stop.
   */
  readonly setupKind: string | null;
}

export interface ExitSuggestion {
  readonly reason: ExitReason;
  /** The price this rule is watching, or null for a rule about time. */
  readonly level: number | null;
  /** Whether the condition has ALREADY been met. */
  readonly triggered: boolean;
  /** Plain language, printed verbatim. Same contract as the gates. */
  readonly text: string;
}

export interface ExitRead {
  /** Unrealised R right now. */
  readonly openR: number;
  /** Where a break-even stop would sit, once earned. Null until then. */
  readonly breakEven: number | null;
  /** Chandelier trail level for this side. Null during warm-up. */
  readonly atrTrail: number | null;
  /** Structural trail — behind the last swing on the trade's side. */
  readonly structureTrail: number | null;
  /** Bars held. */
  readonly barsHeld: number;
  readonly suggestions: readonly ExitSuggestion[];
  /**
   * The single most urgent thing, or null when nothing needs doing.
   *
   * Ordered by consequence and not by rule number: an invalidation outranks a
   * partial, because one says the trade is no longer the trade and the other
   * says a routine bit of housekeeping is due.
   */
  readonly headline: ExitSuggestion | null;
}

const fmt = (v: number): string =>
  Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toFixed(6);

/**
 * Read the state of an open trade against the exit rules.
 *
 * `invalidated` is passed IN rather than derived here, because deciding
 * whether structure has flipped is the detectors' job and re-deriving it would
 * put a second definition of "break of structure" on the same screen as the
 * first. `shell.ts` reads the current detections and answers the question once.
 */
export function readExit(
  trade: OpenTrade,
  bars: readonly BarView[],
  rules: ExitRules,
  invalidated: { readonly yes: boolean; readonly why: string },
): ExitRead | null {
  const n = bars.length;
  if (n === 0 || trade.openedAtBar < 0 || trade.openedAtBar >= n) return null;

  const last = bars[n - 1] as BarView;
  const price = last.c;
  const risk = Math.abs(trade.entry - trade.stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;

  const long = trade.direction === "long";
  const move = long ? price - trade.entry : trade.entry - price;
  const openR = move / risk;
  const barsHeld = n - 1 - trade.openedAtBar;

  const h = Float64Array.from(bars, (b) => b.h);
  const l = Float64Array.from(bars, (b) => b.l);
  const c = Float64Array.from(bars, (b) => b.c);

  const ce = chandelier(h, l, c, rules.trailBars, rules.trailAtr, n);
  const rawTrail = (long ? ce.long[n - 1] : ce.short[n - 1]) as number;
  const atrTrail = Number.isFinite(rawTrail) ? rawTrail : null;

  /* Structural trail: the extreme of the last `trailBars` bars on the side the
     stop protects, padded by a fraction of ATR so a wick does not take it. */
  const a = atr(h, l, c, 14, n);
  const pad = Number.isFinite(a[n - 1] as number) ? (a[n - 1] as number) * 0.15 : 0;
  const from = Math.max(trade.openedAtBar, n - rules.trailBars);
  let extreme = long ? Infinity : -Infinity;
  for (let i = from; i < n; i++) {
    const b = bars[i] as BarView;
    if (long) extreme = Math.min(extreme, b.l);
    else extreme = Math.max(extreme, b.h);
  }
  const structureTrail = Number.isFinite(extreme)
    ? long
      ? extreme - pad
      : extreme + pad
    : null;

  const breakEven =
    rules.breakEvenAtR > 0 && openR >= rules.breakEvenAtR ? trade.entry : null;

  const suggestions: ExitSuggestion[] = [];

  /* 3, first in the list because it is first in consequence. */
  if (invalidated.yes) {
    suggestions.push({
      reason: "invalidation",
      level: null,
      triggered: true,
      text: `The reason for this trade is gone — ${invalidated.why}. This is no longer the setup you entered, whatever the price is doing.`,
    });
  }

  if (rules.partialAtR > 0) {
    const level = long
      ? trade.entry + rules.partialAtR * risk
      : trade.entry - rules.partialAtR * risk;
    const hit = openR >= rules.partialAtR;
    suggestions.push({
      reason: "target",
      level,
      triggered: hit,
      text: hit
        ? `Past ${rules.partialAtR}R at ${fmt(level)} — the partial you set is due.`
        : `Partial at ${rules.partialAtR}R sits at ${fmt(level)}; you are at ${openR.toFixed(2)}R.`,
    });
  }

  if (breakEven !== null) {
    suggestions.push({
      reason: "stop",
      level: breakEven,
      triggered: true,
      /* "Free" is doing real work here: past break-even the worst case is a
         scratch, and that changes how the rest of the trade should be held. */
      text: `Past ${rules.breakEvenAtR}R — a stop at entry (${fmt(breakEven)}) makes the rest of this trade free.`,
    });
  }

  if (atrTrail !== null && structureTrail !== null) {
    const tighter = long
      ? Math.max(atrTrail, structureTrail)
      : Math.min(atrTrail, structureTrail);
    const which = tighter === atrTrail ? "volatility" : "structure";
    suggestions.push({
      reason: "trail",
      level: tighter,
      triggered: false,
      /* BOTH are reported, and the tighter is named rather than chosen. Which
         method is better is a measured question — the lab and the journal
         answer it, and a default picked in this file would pre-empt them. */
      text: `Trail: ${which} is tighter at ${fmt(tighter)} (ATR ${fmt(atrTrail)}, structure ${fmt(structureTrail)}).`,
    });
  }

  if (rules.timeStopBars > 0 && barsHeld >= rules.timeStopBars && Math.abs(openR) < 1) {
    suggestions.push({
      reason: "time",
      level: null,
      triggered: true,
      text: `${barsHeld} bars held and still inside 1R. A setup that has not worked by now is a different setup.`,
    });
  }

  /* Consequence order, not rule order. */
  const RANK: Record<ExitReason, number> = {
    invalidation: 0, stop: 1, time: 2, target: 3, trail: 4,
  };
  const headline =
    suggestions
      .filter((s) => s.triggered)
      .sort((a2, b2) => RANK[a2.reason] - RANK[b2.reason])[0] ?? null;

  return { openR, breakEven, atrTrail, structureTrail, barsHeld, suggestions, headline };
}

/**
 * Has the reason for the trade stopped being true?
 *
 * Answered from the detections the chart is ALREADY showing, so the terminal
 * never holds two opinions about whether structure has broken.
 *
 * The test is deliberately narrow: a structure break in the OPPOSITE direction,
 * dated after the trade was opened. Not "a bearish detection appeared" — on a
 * busy chart something bearish appears every few bars, and an invalidation
 * that fires constantly is one you will learn to dismiss, which costs you the
 * one time it mattered.
 */
export function invalidationOf(
  trade: OpenTrade,
  detections: readonly {
    kind: string;
    direction: "long" | "short" | "neutral";
    to: number;
    label: string;
  }[],
): { yes: boolean; why: string } {
  const opposite = trade.direction === "long" ? "short" : "long";
  const STRUCTURAL = new Set(["bos", "choch"]);

  for (const d of detections) {
    if (d.to <= trade.openedAtBar) continue;
    if (d.direction !== opposite) continue;
    if (!STRUCTURAL.has(d.kind)) continue;
    return {
      yes: true,
      why: `${d.label.toLowerCase()} against you since you opened`,
    };
  }
  return { yes: false, why: "" };
}
