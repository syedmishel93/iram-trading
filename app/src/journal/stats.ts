/**
 * What the journal is allowed to say, and — mostly — what it refuses to.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE
 * A journal with nine trades in it will happily report a 67% hit rate, and
 * that number is worthless: with nine samples the 95% interval around 67%
 * runs from about 30% to 93%, which includes "you are losing". Every retail
 * journal prints the point estimate anyway, in a large font, and people size
 * up on it.
 *
 * So nothing here returns a bare percentage. Every statistic comes with the
 * sample it was computed from and a `usable` flag that is false until there is
 * enough of it, and the UI is expected to print the refusal rather than the
 * number. That is the same contract `data/correlation.ts` keeps — below 30
 * overlapping bars it returns NaN rather than a coefficient — and for exactly
 * the same reason.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EXPECTANCY IN R AND NOT WIN RATE
 *
 * Win rate is the number everyone asks for and the least useful one available.
 * A 30%-hit-rate setup that pays 4R is excellent; a 70%-hit-rate setup that
 * pays 0.3R and loses 1R is a slow bleed. Both figures are reported because
 * people want the hit rate, but expectancy is the one the summary line leads
 * with, because it is the one that answers "should I keep taking this".
 */

import { holdingMs, outcome, plannedR, realisedR, type JournalEntry } from "./entry";

/**
 * Fewer closed trades than this and nothing is reported.
 *
 * 20 is not a threshold at which the numbers become reliable — it is the
 * threshold below which they are actively misleading. At 20 the interval
 * around a 50% hit rate is still roughly 28%–72%. The flag says "worth
 * looking at", never "settled", and `intervalWidth` is exported so the UI can
 * keep saying how wide the band still is.
 */
export const MIN_SAMPLE = 20;

export interface Stats {
  /** Closed trades this was computed from. */
  readonly n: number;
  /** Still open, and therefore excluded from everything below. */
  readonly open: number;
  readonly wins: number;
  readonly losses: number;
  readonly scratches: number;
  /** Share of closed trades that won, 0..1. */
  readonly hitRate: number;
  /** Mean realised R across every closed trade. The headline. */
  readonly expectancy: number;
  /** Mean R of the winners, and of the losers. */
  readonly avgWin: number;
  readonly avgLoss: number;
  /** Sum of realised R. */
  readonly totalR: number;
  /** Worst peak-to-trough run of the R curve, in R. */
  readonly maxDrawdownR: number;
  /** Median holding time in ms, or null when nothing has closed. */
  readonly medianHoldMs: number | null;
  /**
   * Mean planned R minus mean realised R, across trades that had a target.
   *
   * The most under-served number in retail trading. Consistently positive
   * means the plans are sound and the exits are early — a different problem
   * from a bad edge, with a different fix.
   */
  readonly planGap: number | null;
  /** False until `n >= MIN_SAMPLE`. The UI must not print figures without it. */
  readonly usable: boolean;
  /** Half-width of the 95% interval on the hit rate, in percentage points. */
  readonly intervalWidth: number;
}

const EMPTY: Stats = {
  n: 0, open: 0, wins: 0, losses: 0, scratches: 0,
  hitRate: 0, expectancy: 0, avgWin: 0, avgLoss: 0, totalR: 0,
  maxDrawdownR: 0, medianHoldMs: null, planGap: null,
  usable: false, intervalWidth: 100,
};

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * Half-width of the 95% Wald interval on a proportion, in percentage points.
 *
 * The crude interval rather than Wilson's, deliberately: this number exists to
 * be printed next to a hit rate so nobody mistakes it for settled, and the
 * crude form is WIDER at small n — which is the honest direction to be wrong
 * in for a figure whose whole job is conveying uncertainty.
 */
export function intervalWidth(p: number, n: number): number {
  if (n <= 0) return 100;
  return 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.01) / n) * 100;
}

export function computeStats(entries: readonly JournalEntry[]): Stats {
  const open = entries.filter((e) => outcome(e) === "open").length;
  const closed = entries.filter((e) => e.exit !== null);
  if (closed.length === 0) return { ...EMPTY, open };

  const rs: number[] = [];
  const winR: number[] = [];
  const lossR: number[] = [];
  let wins = 0;
  let losses = 0;
  let scratches = 0;

  for (const e of closed) {
    const r = realisedR(e);
    if (r === null) continue;
    rs.push(r);
    const o = outcome(e);
    if (o === "win") {
      wins++;
      winR.push(r);
    } else if (o === "loss") {
      losses++;
      lossR.push(r);
    } else {
      scratches++;
    }
  }
  if (rs.length === 0) return { ...EMPTY, open };

  /* Peak-to-trough of the CUMULATIVE R curve, in trade order. Not the worst
     single loss — a run of four −1R trades hurts the same as one −4R and the
     book only shows you the second. */
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  const holds = closed.map(holdingMs).filter((x): x is number => x !== null);

  const withTarget = closed.filter((e) => e.target !== null);
  const gaps = withTarget
    .map((e) => {
      const p = plannedR(e);
      const r = realisedR(e);
      return p === null || r === null ? null : p - r;
    })
    .filter((x): x is number => x !== null);

  const n = rs.length;
  const hitRate = wins / n;
  const total = rs.reduce((a, b) => a + b, 0);

  return {
    n,
    open,
    wins,
    losses,
    scratches,
    hitRate,
    expectancy: total / n,
    avgWin: winR.length === 0 ? 0 : winR.reduce((a, b) => a + b, 0) / winR.length,
    avgLoss: lossR.length === 0 ? 0 : lossR.reduce((a, b) => a + b, 0) / lossR.length,
    totalR: total,
    maxDrawdownR: maxDd,
    medianHoldMs: holds.length === 0 ? null : median(holds),
    planGap: gaps.length === 0 ? null : gaps.reduce((a, b) => a + b, 0) / gaps.length,
    usable: n >= MIN_SAMPLE,
    intervalWidth: intervalWidth(hitRate, n),
  };
}

/**
 * Stats per setup kind — the question the Setup card actually asks.
 *
 * Keyed by `setupKind`, with discretionary trades under the literal key
 * "discretionary" rather than dropped. A book where the discretionary trades
 * outperform every detector is a real and important finding, and silently
 * excluding them would hide it.
 */
export function bySetup(entries: readonly JournalEntry[]): Map<string, Stats> {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const key = e.setupKind ?? "discretionary";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  const out = new Map<string, Stats>();
  for (const [key, list] of groups) out.set(key, computeStats(list));
  return out;
}

/** Stats split by how closely the plan was followed. */
export function byAdherence(entries: readonly JournalEntry[]): Map<string, Stats> {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.adherence);
    if (list === undefined) groups.set(e.adherence, [e]);
    else list.push(e);
  }
  const out = new Map<string, Stats>();
  for (const [key, list] of groups) out.set(key, computeStats(list));
  return out;
}

/**
 * The line the Setup card prints where it used to say "no record".
 *
 * The refusal is the default and stays the default until the sample earns
 * otherwise. Two shapes, and the first one is not an error message — it is the
 * accurate statement, and printing 67% off nine trades instead would be the
 * error.
 */
export function recordLine(kind: string | null, stats: Stats | undefined): string {
  const label = kind === null ? "Discretionary trades" : `This setup type`;

  if (stats === undefined || stats.n === 0) {
    return stats !== undefined && stats.open > 0
      ? `${label}: ${stats.open} open, none closed yet — nothing measured.`
      : `No record for this setup type yet — nothing here has been measured on your trades.`;
  }

  if (!stats.usable) {
    return `${label}: ${stats.n} closed trade${stats.n === 1 ? "" : "s"} — too few to measure. ${MIN_SAMPLE} is the floor.`;
  }

  const exp = stats.expectancy >= 0 ? `+${stats.expectancy.toFixed(2)}` : stats.expectancy.toFixed(2);
  const hit = (stats.hitRate * 100).toFixed(0);
  const band = stats.intervalWidth.toFixed(0);
  return `${label}: ${stats.n} trades, ${exp}R expectancy, ${hit}% hit rate (±${band} points at 95%).`;
}

/**
 * The gap between what the plans aimed at and what was taken.
 *
 * Only stated when it is large enough to act on. A 0.2R gap over 25 trades is
 * noise; naming it would send somebody off to fix a problem they do not have.
 */
export const PLAN_GAP_THRESHOLD = 0.5;

export function planGapLine(stats: Stats): string {
  if (!stats.usable || stats.planGap === null) return "";
  if (Math.abs(stats.planGap) < PLAN_GAP_THRESHOLD) return "";
  return stats.planGap > 0
    ? `Your exits come ${stats.planGap.toFixed(1)}R short of your targets on average — the plans are not the problem, the holding is.`
    : `You are running ${Math.abs(stats.planGap).toFixed(1)}R past your targets on average.`;
}
