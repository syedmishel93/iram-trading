/**
 * Retention — what the archive keeps, and what it lets go.
 *
 * THE QUESTION THIS ANSWERS
 * "How much data will the system keep?" Until now the honest answer was
 * "everything, forever, until the browser kills the tab". That is not a policy,
 * it is the absence of one, and the way you discover it is that IndexedDB hits
 * the origin quota mid-write and the archive is left half-updated.
 *
 * TWO STAGES, IN THIS ORDER, AND THE ORDER MATTERS
 *
 *   1. **By age, per timeframe.** A 1-minute bar from eight months ago is not
 *      research material, it is 48 bytes of weight. A daily bar from 2009 is
 *      the whole point of having an archive. Retention that applies one number
 *      to both is wrong in both directions at once.
 *
 *   2. **By budget, only if still over.** Whole series, coldest first, where
 *      "cold" is when it was last FETCHED — not how old the bars are. A daily
 *      series you loaded yesterday is warm even though its newest bar is
 *      yesterday's.
 *
 * WHAT IT WILL NOT DELETE
 *  - Anything PINNED. A series a backtest depends on cannot be evicted out from
 *    under it by a background sweep, or the study silently re-runs on less data
 *    and produces a different number with no explanation.
 *  - Enough bars to break a series. Every series keeps a floor (default 300
 *    bars) regardless of age, because a 40-bar remnant is not a cheaper series,
 *    it is a useless one taking up space and offering false coverage.
 *
 * DRY RUN FIRST, ALWAYS
 * `planRetention()` is pure and returns exactly what would happen and why.
 * `applyRetention()` executes a plan it was handed. Deletion you cannot preview
 * is deletion you will eventually regret, and this is the user's own market
 * history — some of it is not re-downloadable at any price.
 */

import type { BarArchive, SeriesInventory } from "./barstore";
import { parseSeriesKey } from "./barstore";

const DAY = 86_400_000;

export interface RetentionRule {
  /** Timeframe this applies to, e.g. "1m". "*" is the catch-all. */
  timeframe: string;
  /** Maximum age of a bar, in ms. `null` means keep forever. */
  keepMs: number | null;
  why: string;
}

/**
 * The shipped policy.
 *
 * Sized from what these actually cost. One bar is six Float64 columns — 48
 * bytes — so:
 *
 *   1m  ×  30 days  =  43,200 bars  ≈ 2.1 MB per symbol
 *   5m  ×  90 days  =  25,920 bars  ≈ 1.2 MB
 *   15m × 180 days  =  17,280 bars  ≈ 0.8 MB
 *   1h  ×   3 years =  26,280 bars  ≈ 1.3 MB
 *   4h  ×   5 years =  10,950 bars  ≈ 0.5 MB
 *   1d  ×  forever  =     365/year  ≈ 17 KB per year
 *
 * Twenty symbols across all of those is roughly 120 MB — comfortable inside a
 * browser origin quota, and enough history for every study in the lab.
 *
 * Daily and weekly are kept forever on purpose. They are the only series long
 * enough to contain more than one market regime, they are what a walk-forward
 * across a decade needs, and at 17 KB a year they will never be the reason you
 * run out of room.
 */
export const DEFAULT_RETENTION: readonly RetentionRule[] = [
  { timeframe: "1m", keepMs: 30 * DAY, why: "intraday research window; 43k bars/symbol" },
  { timeframe: "3m", keepMs: 45 * DAY, why: "intraday" },
  { timeframe: "5m", keepMs: 90 * DAY, why: "one quarter of intraday structure" },
  { timeframe: "15m", keepMs: 180 * DAY, why: "half a year" },
  { timeframe: "30m", keepMs: 365 * DAY, why: "one year" },
  { timeframe: "1h", keepMs: 3 * 365 * DAY, why: "three years — enough for walk-forward" },
  { timeframe: "2h", keepMs: 3 * 365 * DAY, why: "three years" },
  { timeframe: "4h", keepMs: 5 * 365 * DAY, why: "five years" },
  { timeframe: "6h", keepMs: 5 * 365 * DAY, why: "five years" },
  { timeframe: "12h", keepMs: 8 * 365 * DAY, why: "eight years" },
  { timeframe: "1d", keepMs: null, why: "kept forever — 17 KB/year and the only multi-regime series" },
  { timeframe: "1w", keepMs: null, why: "kept forever" },
  { timeframe: "*", keepMs: 2 * 365 * DAY, why: "unrecognised timeframe: two years" },
];

export interface RetentionPolicy {
  rules: readonly RetentionRule[];
  /** Total archive budget. Over this, cold series are dropped whole. */
  maxBytes: number;
  /** Series keys that are never touched. */
  pinned: readonly string[];
  /** Never leave a series shorter than this many bars. */
  minBarsPerSeries: number;
  /** Demo data is generated; it has no research value and expires fast. */
  demoKeepMs: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  rules: DEFAULT_RETENTION,
  maxBytes: 512 * 1024 * 1024,
  pinned: [],
  minBarsPerSeries: 300,
  demoKeepMs: DAY,
};

export function ruleFor(rules: readonly RetentionRule[], timeframe: string): RetentionRule {
  return (
    rules.find((r) => r.timeframe === timeframe) ??
    rules.find((r) => r.timeframe === "*") ?? {
      timeframe: "*",
      keepMs: null,
      why: "no rule matched; kept",
    }
  );
}

export type ActionKind = "trim" | "drop" | "keep";

export interface RetentionAction {
  key: string;
  symbol: string;
  timeframe: string;
  kind: ActionKind;
  /** For `trim`: bars before this instant go. */
  cutoff: number | null;
  /** Bars this action removes. */
  bars: number;
  bytes: number;
  reason: string;
}

export interface RetentionPlan {
  actions: RetentionAction[];
  /** Actions that actually change something. */
  changes: RetentionAction[];
  totalBars: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesFreed: number;
  overBudget: boolean;
  summary: string;
}

/**
 * What retention WOULD do. Pure: no archive, no clock, no side effects.
 */
export function planRetention(
  inventory: readonly SeriesInventory[],
  policy: RetentionPolicy,
  now: number,
): RetentionPlan {
  const pinned = new Set(policy.pinned);
  const actions: RetentionAction[] = [];

  const bytesBefore = inventory.reduce((a, s) => a + s.approxBytes, 0);
  // Bytes each series will still occupy once age rules have been applied.
  const remaining = new Map<string, number>();

  for (const s of inventory) {
    const base = {
      key: s.key,
      symbol: s.symbol,
      timeframe: s.timeframe,
      bytes: 0,
      bars: 0,
    };

    if (pinned.has(s.key)) {
      actions.push({ ...base, kind: "keep", cutoff: null, reason: "pinned — never swept" });
      remaining.set(s.key, s.approxBytes);
      continue;
    }

    /* Legacy demo segments from a build that still had a generator. There is
       no way to create one now, so this rule is a one-way cleanup. */
    const isDemo = s.qualities.includes("demo") || s.source === "demo";
    const rule = ruleFor(policy.rules, s.timeframe);
    const keepMs = isDemo ? policy.demoKeepMs : rule.keepMs;

    if (keepMs === null) {
      actions.push({ ...base, kind: "keep", cutoff: null, reason: `${s.timeframe}: ${rule.why}` });
      remaining.set(s.key, s.approxBytes);
      continue;
    }

    const cutoff = now - keepMs;
    if (s.oldest >= cutoff) {
      actions.push({
        ...base,
        kind: "keep",
        cutoff: null,
        reason: `all bars inside the ${fmtAge(keepMs)} window`,
      });
      remaining.set(s.key, s.approxBytes);
      continue;
    }

    // Estimate the doomed share from the time span. Bars are near-uniform
    // within a timeframe, and an estimate is the right tool for a preview — the
    // archive returns the true count when the plan is applied.
    const span = Math.max(1, s.newest - s.oldest);
    const doomedShare = Math.min(1, Math.max(0, (cutoff - s.oldest) / span));
    let doomedBars = Math.round(s.bars * doomedShare);

    // The floor. A series trimmed to 40 bars is not a smaller series, it is a
    // broken one that still claims coverage.
    const survivors = s.bars - doomedBars;
    if (survivors < policy.minBarsPerSeries) {
      doomedBars = Math.max(0, s.bars - policy.minBarsPerSeries);
    }

    if (doomedBars <= 0) {
      actions.push({
        ...base,
        kind: "keep",
        cutoff: null,
        reason: `at the ${policy.minBarsPerSeries}-bar floor`,
      });
      remaining.set(s.key, s.approxBytes);
      continue;
    }

    const freed = doomedBars * 6 * 8;
    actions.push({
      ...base,
      kind: "trim",
      cutoff,
      bars: doomedBars,
      bytes: freed,
      reason: isDemo
        ? `demo data older than ${fmtAge(policy.demoKeepMs)} — generated bars have no research value`
        : `${s.timeframe} keeps ${fmtAge(keepMs)}: ${rule.why}`,
    });
    remaining.set(s.key, s.approxBytes - freed);
  }

  // ---- stage two: budget.
  let projected = [...remaining.values()].reduce((a, b) => a + b, 0);
  const overBudget = projected > policy.maxBytes;

  if (overBudget) {
    // Coldest first, by last fetch. Pinned series are not candidates, and
    // neither is a series small enough that dropping it would not help.
    const candidates = inventory
      .filter((s) => !pinned.has(s.key))
      .sort((a, b) => a.lastFetched - b.lastFetched);

    for (const s of candidates) {
      if (projected <= policy.maxBytes) break;
      const left = remaining.get(s.key) ?? 0;
      if (left <= 0) continue;
      const idx = actions.findIndex((a) => a.key === s.key);
      const action: RetentionAction = {
        key: s.key,
        symbol: s.symbol,
        timeframe: s.timeframe,
        kind: "drop",
        cutoff: null,
        bars: s.bars,
        bytes: s.approxBytes,
        reason: `archive over its ${fmtBytes(policy.maxBytes)} budget; coldest series (last fetched ${fmtWhen(
          s.lastFetched,
          now,
        )})`,
      };
      if (idx >= 0) actions[idx] = action;
      else actions.push(action);
      projected -= left;
      remaining.set(s.key, 0);
    }
  }

  const changes = actions.filter((a) => a.kind !== "keep");
  const bytesFreed = changes.reduce((a, c) => a + c.bytes, 0);
  const totalBars = changes.reduce((a, c) => a + c.bars, 0);

  return {
    actions,
    changes,
    totalBars,
    bytesBefore,
    bytesAfter: Math.max(0, bytesBefore - bytesFreed),
    bytesFreed,
    overBudget,
    summary:
      changes.length === 0
        ? `Nothing to remove. ${inventory.length} series, ${fmtBytes(bytesBefore)}, all inside policy.`
        : `${changes.length} of ${inventory.length} series affected: ${changes.filter((c) => c.kind === "drop").length} dropped, ${
            changes.filter((c) => c.kind === "trim").length
          } trimmed. ${totalBars.toLocaleString()} bars, ${fmtBytes(bytesFreed)} freed.`,
  };
}

export interface RetentionResult {
  applied: number;
  barsRemoved: number;
  bytesFreed: number;
  errors: Array<{ key: string; error: string }>;
}

/** Execute a plan. Takes the plan, never re-derives it — you approved THAT one. */
export async function applyRetention(
  archive: BarArchive,
  plan: RetentionPlan,
): Promise<RetentionResult> {
  let applied = 0;
  let barsRemoved = 0;
  let bytesFreed = 0;
  const errors: Array<{ key: string; error: string }> = [];

  for (const action of plan.changes) {
    const key = parseSeriesKey(action.key);
    try {
      if (action.kind === "drop") {
        await archive.clear(key);
        barsRemoved += action.bars;
        bytesFreed += action.bytes;
      } else if (action.kind === "trim" && action.cutoff !== null) {
        const removed = await archive.prune(key, action.cutoff);
        barsRemoved += removed;
        bytesFreed += removed * 6 * 8;
      }
      applied++;
    } catch (err) {
      // One failing series must not abandon the sweep: the next one may be the
      // large cold one that actually frees the space.
      errors.push({ key: action.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { applied, barsRemoved, bytesFreed, errors };
}

// ----------------------------------------------------------- formatting ----

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function fmtAge(ms: number): string {
  const days = ms / DAY;
  if (days >= 365) {
    const y = days / 365;
    return `${y % 1 === 0 ? y : y.toFixed(1)} year${y === 1 ? "" : "s"}`;
  }
  if (days >= 1) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function fmtWhen(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return "never";
  const ms = now - at;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}
