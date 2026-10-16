/**
 * WHAT A SEARCH FOUND, REMEMBERED.
 *
 * `autoRun` re-studies the whole field every time it is asked — 85 rules over
 * 5,000 bars, MEASURED at 13 s of studies and ~27 s of wall clock. That cost is
 * the only reason searching a market automatically is a decision rather than a
 * detail, and it is paid again on every reload for an answer that has not
 * changed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE KEY CARRIES THE FIELD AND THE COSTS, NOT JUST THE MARKET
 *
 * A cached result is only an answer to the question that produced it. Add a
 * rule to the library, change the hybrid cap, or change the spread you are
 * charged, and it is a DIFFERENT SEARCH over a different field with a different
 * hurdle — serving the old answer would be reporting a conclusion nobody
 * reached. So `fieldHash` and `costsHash` are part of the key, and a changed
 * field misses rather than lying.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS KEPT IS DELIBERATELY SMALL
 *
 * Not the `AutoRunReport`. That carries sixty hybrid specs and every survivor,
 * and the survivors are already saved to the shelf — a second copy in a
 * preference slot would be a second place for a promoted strategy to still look
 * unproven. What is kept is what the card RENDERS when a search has already
 * happened: the sentence, the refusal, the distinct failure reasons, and the
 * arithmetic behind the hurdle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A HIT STATES ITS OWN AGE
 *
 * A verdict that looks live and is three days old is worse than no verdict.
 * Every read returns when it was computed and on how many bars, and the card
 * prints it.
 */

import { intervalMs } from "../data/history";
import type { AutoRunReport, Entrant } from "./autorun";
import type { Costs } from "./engine";
import type { PromotionBar } from "./promote";
import type { KV, Slot } from "../store/kv";

/** New bars before a cached sweep is worth re-running. */
export const STALE_BARS_MIN = 25;
/** ...or this share of the studied window, whichever is larger. */
export const STALE_BARS_SHARE = 0.05;
/** How many markets are remembered. Oldest read is dropped first. */
export const SWEEP_MAX = 24;

export interface SweepSummary {
  readonly key: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** When the search ran. */
  readonly at: number;
  /** Bars it was run over — the denominator for staleness. */
  readonly bars: number;
  /** Newest bar time at the moment it ran. */
  readonly lastBar: number;
  /** Rules entered, and configurations charged for. */
  readonly entered: number;
  readonly trials: number;
  /** How many survived. Zero is the common and correct answer. */
  readonly survivors: number;
  /** The report's own sentence. */
  readonly line: string;
  /** The refusal kind, when nothing survived. */
  readonly refusal: string;
  /** Why the nearest miss missed. */
  readonly nearest: string;
  /** Distinct reasons rules could not be studied at all. */
  readonly failed: readonly string[];
}

const isSummary = (v: unknown): v is SweepSummary => {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["key"] === "string" &&
    typeof r["symbol"] === "string" &&
    typeof r["at"] === "number" &&
    typeof r["bars"] === "number"
  );
};

export const SWEEP_SLOT: Slot<readonly SweepSummary[]> = {
  key: "sweep.v1",
  version: 1,
  fallback: () => [],
  validate: (v) => (Array.isArray(v) ? v.filter(isSummary) : null),
};

/**
 * A stable digest of a string.
 *
 * FNV-1a, 32 bits, hex. Not a security hash and never used as one: it answers
 * "is this the same field as last time", where a collision costs a stale
 * summary on one market and the operator can press Search again. A real hash
 * would be a dependency for a question this small.
 */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The field, as an identity.
 *
 * The rule IDS in order, so adding a library rule, building more hybrids, or
 * excluding a retired one all produce a different field — which they are. The
 * spec BODIES are deliberately not hashed: a rule whose conditions were edited
 * keeps its id, and `hybrid.ts` composes ids, so the id list is what decides
 * what was searched.
 */
export function hashField(entrants: readonly Entrant[]): string {
  return digest(entrants.map((e) => e.spec.id).join(","));
}

/** The costs, as an identity. They set the hurdle, so they set the question. */
/**
 * The cost model, as part of the question a cached answer was the answer to.
 *
 * EVERY FIELD, AND `carryPerNight` IS WHY THIS COMMENT EXISTS. It hashed the
 * first three and not the financing, so two models differing only in the
 * overnight rate shared a key — and a verdict reached under one hurdle was
 * served as the answer to the other. Not a rounding difference: `engine.ts`
 * records that the cost this engine treated as zero for its whole life came to
 * 29% of a five-night swing and 83% of a two-month hold, so a swing strategy
 * cached at zero carry and read back at the real rate is the flattering half
 * of that gap, silently.
 *
 * Built from `Object.keys` in a fixed order rather than a hand-written list,
 * so a field added to `Costs` is in the key by construction. The list is what
 * went wrong; the derivation is the fix.
 */
export function hashCosts(costs: Costs): string {
  const keys = Object.keys(costs).sort() as Array<keyof Costs>;
  return digest(keys.map((k) => `${k}=${costs[k]}`).join("|"));
}

/**
 * The promotion bar, as part of the question too.
 *
 * What survived a sweep depends on the bar it had to clear every bit as much
 * as on the costs it was charged, and the three thresholds became something the
 * operator can move. A verdict reached at thirty out-of-sample trades, served
 * back to somebody who has since lowered the floor to five, is a conclusion
 * nobody reached — the same defect as the financing the cost hash used to omit,
 * caught before it could ship rather than after.
 *
 * Derived from `Object.keys`, for the reason the costs hash now is: the
 * hand-written list is what goes wrong.
 */
export function hashBar(bar: PromotionBar): string {
  const keys = Object.keys(bar).sort() as Array<keyof PromotionBar>;
  return digest(keys.map((k) => `${k}=${bar[k]}`).join("|"));
}

export function sweepKey(
  symbol: string,
  timeframe: string,
  field: string,
  costs: string,
  bar = "",
): string {
  /* `bar` defaults to empty so every existing caller keeps the key it had and
     no stored sweep is orphaned by the signature alone. A caller that passes
     one gets a key that distinguishes the bar; one that does not is exactly
     where it was. */
  return `${symbol.toUpperCase()}|${timeframe}|${field}|${costs}${bar === "" ? "" : `|${bar}`}`;
}

export interface Staleness {
  readonly stale: boolean;
  /** Addressed to the operator, and always populated. */
  readonly why: string;
  readonly newBars: number;
  readonly threshold: number;
}

/**
 * Whether a remembered search is worth re-running.
 *
 * ONE NEW BAR DOES NOT MOVE AN ESTIMATE BUILT ON FIVE THOUSAND. Re-running on
 * every bar close would spend thirty seconds to change a figure in the third
 * decimal, and would make automatic search indistinguishable from a busy loop.
 * The threshold is a share of the window, floored, so a short study is not held
 * to the same absolute count as a long one.
 */
export function staleness(prev: SweepSummary, lastBarNow: number): Staleness {
  const threshold = Math.max(STALE_BARS_MIN, Math.floor(prev.bars * STALE_BARS_SHARE));
  /*
   * BARS ARRIVED, measured in TIME rather than in array length.
   *
   * A study window is a rolling 5,000 bars: it is still 5,000 a week later,
   * with every bar in it newer. So `barsNow - prev.bars` reports ZERO for a
   * market that has moved on entirely, and a cached sweep would never go
   * stale. The honest count is the gap between the newest bar then and now,
   * divided by this timeframe's own spacing.
   */
  const step = intervalMs(prev.timeframe);
  const newBars = lastBarNow > prev.lastBar && step > 0 ? Math.floor((lastBarNow - prev.lastBar) / step) : 0;
  const stale = newBars >= threshold;
  return {
    stale,
    newBars,
    threshold,
    why: stale
      ? `${newBars.toLocaleString()} bars have closed since this was searched, past the ${threshold} it takes to be worth re-running.`
      : `Searched on ${prev.bars.toLocaleString()} bars; ${newBars} have closed since, under the ${threshold} it takes to be worth re-running.`,
  };
}

export interface SweepCache {
  get(key: string): SweepSummary | null;
  put(summary: SweepSummary): void;
  forget(key: string): void;
  all(): readonly SweepSummary[];
}

/** Everything a summary needs that the report does not carry itself. */
export interface SummaryContext {
  readonly key: string;
  readonly bars: number;
  readonly lastBar: number;
  readonly at: number;
}

/** Trim a finished run down to what a card renders. See the header. */
export function summarise(report: AutoRunReport, ctx: SummaryContext): SweepSummary {
  const refusal = report.search.refusal;
  return {
    key: ctx.key,
    symbol: report.symbol,
    timeframe: report.timeframe,
    at: ctx.at,
    bars: ctx.bars,
    lastBar: ctx.lastBar,
    entered: report.entered,
    trials: report.search.trials,
    survivors: report.search.survivors.length,
    line: report.line,
    refusal: refusal ? refusal.kind : "",
    nearest: refusal && refusal.kind !== "no-candidates" ? refusal.why : "",
    /* Distinct: eighty-five copies of one sentence is not eighty-five facts. */
    failed: [...new Set(report.failed.map((f) => f.why))].slice(0, 5),
  };
}

export function createSweepCache(kv: KV): SweepCache {
  let rows: SweepSummary[] = [...kv.get(SWEEP_SLOT)];

  const commit = (): void => {
    /* Newest first, capped. A cache that grows without bound is a preference
       slot that eventually refuses to save anything at all. */
    rows.sort((a, b) => b.at - a.at);
    if (rows.length > SWEEP_MAX) rows = rows.slice(0, SWEEP_MAX);
    kv.write(SWEEP_SLOT, rows);
  };

  return {
    get: (key) => rows.find((r) => r.key === key) ?? null,
    put: (summary) => {
      rows = rows.filter((r) => r.key !== summary.key);
      rows.push(summary);
      commit();
    },
    forget: (key) => {
      rows = rows.filter((r) => r.key !== key);
      commit();
    },
    all: () => rows,
  };
}
