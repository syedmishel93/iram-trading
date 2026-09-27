/**
 * What the AI noticed in YOUR trades — a fixed, documented set of checks.
 *
 * WHY A FIXED SET, AND NOT "FIND ANYTHING"
 * A search over every way to slice a trade list will always find something:
 * with thirty trades there are hundreds of subsets, and one of them lost six
 * times in a row by chance. So the checks are named here, in advance, six of
 * them (plus a seventh that only counts your reasons for passing), and every one reports — found, not found, too few trades, or cannot
 * check — so the screen can show what was LOOKED FOR and not only what turned
 * up. A list of findings with no list of checks behind it is a highlight reel.
 *
 * THE BAR FOR "FOUND"
 * A comparison between two groups of trades must clear all three:
 *
 *   - at least MIN_TRADES closed trades overall, and MIN_GROUP in each group
 *     being compared — below that a rate is whichever few trades landed there;
 *   - a gap of at least MIN_GAP (20 percentage points) — smaller gaps are not
 *     worth a rule even when they are real;
 *   - a two-proportion z-test below ALPHA (5%), Bonferroni-divided when the
 *     check picks the worst of several buckets (the session check), because
 *     the worst of five is not a typical one.
 *
 * Six checks at 5% each: on a record with no pattern in it at all, roughly one
 * review in four will still show one "found". That is the reason the operator
 * judges each one — the check proposes, it does not conclude — and it is said
 * on screen behind "Why?".
 *
 * WHERE THE TRADES COME FROM
 * MT5 fills when there are any, otherwise the journal. NEVER BOTH: the same
 * trade can sit in each and there is no reliable key joining a browser journal
 * row to a broker position, so merging would count trades twice. One exception,
 * stated on the result: the early-exit check reads the JOURNAL, because a fill
 * does not carry the target you planned, and inventing one would be fabricated
 * data (see `data/fills.ts`).
 *
 * PURE. No DOM, no fetch, no clock except what is passed in.
 */

import { BREAKEVEN_R, holdingMs, outcome, plannedR, realisedR, type JournalEntry } from "./entry";
import type { Fill } from "../data/fills";
import { holdText } from "../data/fills";
import { currenciesFor, type CalendarFeed, type EconEvent } from "../data/calendar";
import { SESSIONS } from "../data/sessionmap";
import { twoSidedP } from "../study/stats";
import type { Say } from "./says";

/** Below this many closed trades no check reports anything but "too few". */
export const MIN_TRADES = 10;
/** Each group in a comparison needs at least this many trades. */
export const MIN_GROUP = 5;
/** Smallest gap in a rate that counts, as a fraction (0.2 = 20 points). */
export const MIN_GAP = 0.2;
/** Significance level for one comparison. */
export const ALPHA = 0.05;
/** The news window, either side of a release. */
export const NEWS_WINDOW_MS = 30 * 60_000;
/** Early exits: the median winner must realise at most this share of its plan. */
export const EARLY_EXIT_RATIO = 0.6;
/** Holding: losers held at least this many times longer than winners. */
export const HOLD_RATIO = 1.5;
/** Passes: one named reason must cover at least this share of them. */
export const PASS_SHARE = 0.5;

export type TradeSource = "fills" | "journal";

/** One closed trade, in the shape every check reads. Built only by the adapters below. */
export interface ReviewTrade {
  readonly id: string;
  readonly source: TradeSource;
  readonly symbol: string;
  readonly side: "long" | "short";
  readonly openedAt: number;
  readonly closedAt: number | null;
  /** Realised R, when the record can say it. */
  readonly r: number | null;
  readonly result: "win" | "loss" | "breakeven";
  /** The target, in R, as planned when the trade was opened. Null when none was recorded. */
  readonly plannedR: number | null;
  readonly holdMs: number | null;
  /**
   * Whether the trade was WITH or AGAINST the higher-timeframe trend at entry.
   * Neither source records this today, so it is always null — and the trend
   * check says so rather than guessing it from the chart after the fact.
   */
  readonly htf: "with" | "against" | null;
}

/** Closed journal entries. Open ones are not a result yet. */
export function fromJournal(entries: readonly JournalEntry[]): ReviewTrade[] {
  const out: ReviewTrade[] = [];
  for (const e of entries) {
    const o = outcome(e);
    if (o === "open") continue;
    out.push({
      id: e.id,
      source: "journal",
      symbol: e.symbol,
      side: e.direction,
      openedAt: e.openedAt,
      closedAt: e.closedAt,
      r: realisedR(e),
      result: o,
      plannedR: plannedR(e),
      holdMs: holdingMs(e),
      htf: null,
    });
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * MT5 round trips. R comes from the server's grade when it had a plan to grade
 * against; otherwise the result is the SIGN of the net profit, and no R is
 * claimed. A fill never carries a planned target.
 */
export function fromFills(fills: readonly Fill[]): ReviewTrade[] {
  return fills
    .map((f): ReviewTrade => {
      const t = f.trade;
      const netR = f.recon?.net_R;
      const r = typeof netR === "number" && Number.isFinite(netR) ? netR : null;
      const result: ReviewTrade["result"] =
        r !== null
          ? r > BREAKEVEN_R ? "win" : r < -BREAKEVEN_R ? "loss" : "breakeven"
          : t.net_profit > 0 ? "win" : t.net_profit < 0 ? "loss" : "breakeven";
      return {
        id: `mt5-${t.position_id}`,
        source: "fills",
        symbol: t.symbol,
        side: t.side,
        openedAt: t.open_ms,
        closedAt: t.close_ms,
        r,
        result,
        plannedR: null,
        holdMs: Number.isFinite(t.hold_ms) && t.hold_ms >= 0 ? t.hold_ms : null,
        htf: null,
      };
    })
    .sort((a, b) => a.openedAt - b.openedAt);
}

/** The part of the economic calendar a check can use, and the span it covers. */
export interface CalendarWindow {
  readonly events: readonly EconEvent[];
  /** First and last release in the file. Trades outside this span cannot be checked. */
  readonly from: number;
  readonly to: number;
}

/** Null when there is no usable calendar — which the news check reports as such. */
export function calendarWindow(feed: CalendarFeed | null): CalendarWindow | null {
  if (feed === null || !feed.ok || feed.events.length === 0) return null;
  const events = feed.events.map((r) => r.event);
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (e.at < from) from = e.at;
    if (e.at > to) to = e.at;
  }
  return { events, from, to };
}

export type PatternId = "news" | "trend" | "early-exit" | "session" | "holding" | "after-loss" | "passes";
export type PatternState = "found" | "not-found" | "too-few" | "cannot-check";

export interface PatternNumber {
  readonly label: string;
  readonly value: string;
}

export interface Pattern {
  readonly id: PatternId;
  /** What was checked, in a few plain words — shown in "What was checked". */
  readonly check: string;
  /** One line: the finding, or the refusal. */
  readonly claim: string;
  readonly numbers: readonly PatternNumber[];
  /** Trades the check actually used. */
  readonly n: number;
  /** The fewest it needs. */
  readonly minN: number;
  readonly state: PatternState;
  /** Why the state is what it is — the named field, the named floor, or the test result. */
  readonly reason: string;
  /** The method, thresholds and inputs, for "Why?". */
  readonly working: string;
  readonly source: TradeSource;
  /**
   * Effect size on a 0..1 scale, used ONLY to rank found patterns for the rule
   * proposal: a rate gap for the comparisons, 1 - ratio for early exits,
   * 1 - 1/ratio for holding. Zero when not found.
   */
  readonly strength: number;
  /** A starting wording for a rule, when found. The operator rewords it. */
  readonly rule: string | null;
}

/* ------------------------------------------------------------ helpers --- */

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const r1 = (x: number): string => `${x.toFixed(1)}R`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  if (s.length === 0) return Number.NaN;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Two-proportion z-test, pooled, two-sided. */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return twoSidedP((k1 / n1 - k2 / n2) / se);
}

/**
 * Mann-Whitney U, normal approximation, two-sided. No tie correction: the
 * inputs are holding times in milliseconds, where ties are rare, and ignoring
 * them makes the test slightly conservative rather than generous.
 */
export function mannWhitneyP(a: readonly number[], b: readonly number[]): number {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && (all[j + 1] as { v: number }).v === (all[i] as { v: number }).v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    i = j + 1;
  }
  let r1sum = 0;
  all.forEach((x, i) => {
    if (x.g === 0) r1sum += ranks[i] as number;
  });
  const u = r1sum - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return sd === 0 ? 1 : twoSidedP((u - mu) / sd);
}

const pText = (p: number): string => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

interface Split {
  readonly k1: number;
  readonly n1: number;
  readonly k2: number;
  readonly n2: number;
}

/** The shared verdict for a two-group rate comparison where group 1 is the suspect one. */
function judgeSplit(s: Split, alpha: number): { state: "found" | "not-found"; gap: number; p: number; reason: string } {
  const a = s.k1 / s.n1;
  const b = s.k2 / s.n2;
  const gap = a - b;
  const p = twoProportionP(s.k1, s.n1, s.k2, s.n2);
  if (gap >= MIN_GAP && p < alpha) {
    return { state: "found", gap, p, reason: `A ${Math.round(gap * 100)}-point gap, ${pText(p)} (needs ${Math.round(MIN_GAP * 100)} points and p < ${alpha.toFixed(3)}).` };
  }
  const why =
    gap < MIN_GAP
      ? `the gap is ${Math.round(gap * 100)} points, under the ${Math.round(MIN_GAP * 100)} needed`
      : `${pText(p)}, not under ${alpha.toFixed(3)} — a gap this size happens by chance on this few trades`;
  return { state: "not-found", gap, p, reason: `No pattern: ${why}.` };
}

const TOO_FEW_TOTAL = (n: number, what = "closed trades"): string =>
  `Only ${plural(n, what.replace(/s$/, ""), what)} — at least ${MIN_TRADES} needed before this can say anything.`;

const TOO_FEW_GROUP = (label1: string, n1: number, label2: string, n2: number): string =>
  `${label1}: ${n1}, ${label2}: ${n2} — each side needs at least ${MIN_GROUP}, so this cannot say yet.`;

const SPLIT_METHOD =
  `Two groups of your trades compared on one rate. Found only with ${MIN_TRADES}+ trades, ${MIN_GROUP}+ in each group, a gap of ${Math.round(MIN_GAP * 100)}+ points, and a two-proportion z-test under ${ALPHA}.`;

/* ------------------------------------------------------------- checks --- */

function checkNews(trades: readonly ReviewTrade[], cal: CalendarWindow | null, source: TradeSource): Pattern {
  const base = {
    id: "news" as const,
    check: "Losses near high-impact news",
    minN: MIN_TRADES,
    source,
    strength: 0,
    rule: null,
  };
  if (cal === null) {
    return {
      ...base,
      claim: "Cannot check news timing: the economic calendar is not loaded.",
      numbers: [],
      n: 0,
      state: "cannot-check",
      reason: "No economic calendar answered, so trades cannot be matched to releases.",
      working: "Needs the economic calendar. It loads with the terminal; when it is down, this check waits rather than assuming there was no news.",
    };
  }
  const inside = trades.filter((t) => t.openedAt >= cal.from && t.openedAt <= cal.to);
  const span = `${new Date(cal.from).toUTCString().slice(5, 16)} to ${new Date(cal.to).toUTCString().slice(5, 16)}`;
  const working = `${SPLIT_METHOD} Near news = opened within ${NEWS_WINDOW_MS / 60_000} minutes of a high-impact release for one of the pair's currencies (USD counts for crypto). The calendar covers ${span} only — it is a weekly file — so trades outside that span are not counted either way.`;
  if (inside.length === 0) {
    return {
      ...base,
      claim: `Cannot check news timing: the calendar only covers ${span}, and none of your ${trades.length} trades fall in it.`,
      numbers: [{ label: "Calendar covers", value: span }],
      n: 0,
      state: "cannot-check",
      reason: `The calendar covers ${span} only (the current week's file); no trade was opened in that span.`,
      working,
    };
  }
  const near = (t: ReviewTrade): boolean => {
    const ccy = currenciesFor(t.symbol);
    return cal.events.some(
      (e) =>
        e.impact === "high" &&
        (ccy.includes(e.currency) || e.currency === "ALL") &&
        Math.abs(e.at - t.openedAt) <= NEWS_WINDOW_MS,
    );
  };
  const g1 = inside.filter(near);
  const g2 = inside.filter((t) => !near(t));
  const s: Split = {
    k1: g1.filter((t) => t.result === "loss").length,
    n1: g1.length,
    k2: g2.filter((t) => t.result === "loss").length,
    n2: g2.length,
  };
  const numbers = [
    { label: "Near news, lost", value: `${s.k1} of ${s.n1}` },
    { label: "Otherwise, lost", value: `${s.k2} of ${s.n2}` },
    { label: "Calendar covers", value: span },
  ];
  if (inside.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(inside.length, "trade")} fall inside the calendar's week — not enough to say.`, numbers, n: inside.length, state: "too-few", reason: TOO_FEW_TOTAL(inside.length, "trades inside the calendar's span"), working };
  }
  if (s.n1 < MIN_GROUP || s.n2 < MIN_GROUP) {
    return { ...base, claim: `Only ${plural(s.n1, "trade")} near news — not enough to say.`, numbers, n: inside.length, state: "too-few", reason: TOO_FEW_GROUP("near news", s.n1, "away from news", s.n2), working };
  }
  const v = judgeSplit(s, ALPHA);
  return {
    ...base,
    claim:
      v.state === "found"
        ? `Losses cluster within ${NEWS_WINDOW_MS / 60_000} min of high-impact news: ${s.k1} of ${s.n1} lost, against ${pct(s.k2 / s.n2)} otherwise.`
        : `No sign news timing hurts you: ${pct(s.k1 / s.n1)} lost near news, ${pct(s.k2 / s.n2)} otherwise.`,
    numbers: [...numbers, { label: "Test", value: pText(v.p) }],
    n: inside.length,
    state: v.state,
    reason: v.reason,
    working,
    strength: v.state === "found" ? v.gap : 0,
    rule: v.state === "found" ? `No new trade within ${NEWS_WINDOW_MS / 60_000} minutes of high-impact news for the pair's currencies — even when the setup is clean.` : null,
  };
}

function checkTrend(trades: readonly ReviewTrade[], source: TradeSource): Pattern {
  const base = { id: "trend" as const, check: "Trades against the higher-timeframe trend", minN: MIN_TRADES, source, strength: 0, rule: null };
  const working = `${SPLIT_METHOD} Needs the higher-timeframe trend recorded AT ENTRY. Reading it off the chart afterwards would use hindsight, so it is not done.`;
  const known = trades.filter((t) => t.htf !== null);
  if (known.length === 0) {
    return {
      ...base,
      claim: "Cannot check trend: your trades do not record the higher-timeframe trend at entry.",
      numbers: [],
      n: 0,
      state: "cannot-check",
      reason: `Missing field: the higher-timeframe trend at entry. Neither the journal nor MT5 fills record it, and none of your ${trades.length} trades carry it.`,
      working,
    };
  }
  const against = known.filter((t) => t.htf === "against");
  const withT = known.filter((t) => t.htf === "with");
  const s: Split = {
    k1: against.filter((t) => t.result !== "win").length,
    n1: against.length,
    k2: withT.filter((t) => t.result !== "win").length,
    n2: withT.length,
  };
  const winA = s.n1 ? (s.n1 - s.k1) / s.n1 : 0;
  const winW = s.n2 ? (s.n2 - s.k2) / s.n2 : 0;
  const numbers = [
    { label: "Against trend, won", value: `${s.n1 - s.k1} of ${s.n1}` },
    { label: "With trend, won", value: `${s.n2 - s.k2} of ${s.n2}` },
  ];
  if (known.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(known.length, "trade")} record the trend — not enough to say.`, numbers, n: known.length, state: "too-few", reason: TOO_FEW_TOTAL(known.length, "trades with the trend recorded"), working };
  }
  if (s.n1 < MIN_GROUP || s.n2 < MIN_GROUP) {
    return { ...base, claim: `Only ${plural(s.n1, "trade")} against the trend — not enough to say.`, numbers, n: known.length, state: "too-few", reason: TOO_FEW_GROUP("against the trend", s.n1, "with it", s.n2), working };
  }
  const v = judgeSplit(s, ALPHA);
  return {
    ...base,
    claim:
      v.state === "found"
        ? `Trades against the higher-timeframe trend: win rate ${pct(winA)} vs ${pct(winW)} with it.`
        : `No sign trading against the trend hurts you: ${pct(winA)} against, ${pct(winW)} with it.`,
    numbers: [...numbers, { label: "Test", value: pText(v.p) }],
    n: known.length,
    state: v.state,
    reason: v.reason,
    working,
    strength: v.state === "found" ? v.gap : 0,
    rule: v.state === "found" ? "Only take trades in the direction of the higher-timeframe trend." : null,
  };
}

function checkEarlyExit(planned: readonly ReviewTrade[]): Pattern {
  const base = { id: "early-exit" as const, check: "Winners closed before the planned target", minN: MIN_GROUP, source: "journal" as const, strength: 0, rule: null };
  const working = `Your winners' median exit, in R, against the median target you planned for those same trades. Found when the exit is at most ${pct(EARLY_EXIT_RATIO)} of the plan across ${MIN_GROUP}+ winners. No significance test: this compares you with your own plan, not two groups. Read from the JOURNAL — MT5 fills do not record a planned target.`;
  const withPlan = planned.filter((t) => t.plannedR !== null && t.plannedR > 0 && t.r !== null);
  if (withPlan.length === 0) {
    return {
      ...base,
      claim: "Cannot check early exits: no closed trade records a planned target.",
      numbers: [],
      n: 0,
      state: "cannot-check",
      reason:
        planned.length === 0
          ? "Missing field: planned target. MT5 fills do not carry one, and the journal has no closed trades."
          : `Missing field: planned target. None of your ${planned.length} closed journal trades has a target and a stop to measure it in R.`,
      working,
    };
  }
  const winners = withPlan.filter((t) => t.result === "win");
  const exits = winners.map((t) => t.r as number);
  const plans = winners.map((t) => t.plannedR as number);
  const short = winners.filter((t) => (t.r as number) < (t.plannedR as number) - BREAKEVEN_R).length;
  const numbers =
    winners.length > 0
      ? [
          { label: "Median exit", value: r1(median(exits)) },
          { label: "Median plan", value: r1(median(plans)) },
          { label: "Closed short of target", value: `${short} of ${winners.length}` },
        ]
      : [{ label: "Winners with a plan", value: "0" }];
  if (winners.length < MIN_GROUP) {
    return { ...base, claim: `Only ${plural(winners.length, "winner")} with a planned target — not enough to say.`, numbers, n: winners.length, state: "too-few", reason: `${plural(winners.length, "winning trade")} with a planned target; at least ${MIN_GROUP} needed.`, working };
  }
  const ratio = median(exits) / median(plans);
  const found = ratio <= EARLY_EXIT_RATIO;
  return {
    ...base,
    claim: found
      ? `You cut winners early: median exit at ${r1(median(exits))} vs plan ${r1(median(plans))}.`
      : `Winners mostly run to plan: median exit ${r1(median(exits))} against ${r1(median(plans))} planned.`,
    numbers,
    n: winners.length,
    state: found ? "found" : "not-found",
    reason: found
      ? `Median exit is ${pct(ratio)} of the plan (found at ${pct(EARLY_EXIT_RATIO)} or less).`
      : `No pattern: median exit is ${pct(ratio)} of the plan, above the ${pct(EARLY_EXIT_RATIO)} line.`,
    working,
    strength: found ? Math.max(0, 1 - ratio) : 0,
    rule: found ? "Let winners run to the planned target. Close early only if the plan's own exit condition happens." : null,
  };
}

/** Non-overlapping UTC buckets built from the four majors' hours in `data/sessionmap.ts`. */
function sessionBuckets(): { id: string; name: string; from: number; to: number }[] {
  const at = (id: string): { openUtc: number; closeUtc: number } =>
    SESSIONS.find((s) => s.id === id) ?? { openUtc: 0, closeUtc: 0 };
  const tokyo = at("tokyo");
  const london = at("london");
  const ny = at("newyork");
  return [
    { id: "asia", name: "Asia", from: tokyo.openUtc, to: london.openUtc },
    { id: "london", name: "London", from: london.openUtc, to: ny.openUtc },
    { id: "overlap", name: "London / New York overlap", from: ny.openUtc, to: london.closeUtc },
    { id: "newyork", name: "New York", from: london.closeUtc, to: ny.closeUtc },
    { id: "late", name: "Late / Sydney", from: ny.closeUtc, to: 24 },
  ];
}

function checkSession(trades: readonly ReviewTrade[], source: TradeSource): Pattern {
  const buckets = sessionBuckets();
  const base = { id: "session" as const, check: "Losses concentrated in one session", minN: MIN_TRADES, source, strength: 0, rule: null };
  const label = (b: { name: string; from: number; to: number }): string =>
    `${b.name} (${String(b.from).padStart(2, "0")}:00–${String(b.to % 24).padStart(2, "0")}:00 UTC)`;
  const of = (t: ReviewTrade): string => {
    const hr = new Date(t.openedAt).getUTCHours();
    return (buckets.find((b) => hr >= b.from && hr < b.to) ?? buckets[buckets.length - 1] as { id: string }).id;
  };
  const tested = buckets.filter((b) => {
    const n1 = trades.filter((t) => of(t) === b.id).length;
    return n1 >= MIN_GROUP && trades.length - n1 >= MIN_GROUP;
  });
  const alpha = ALPHA / Math.max(1, tested.length);
  const working = `${SPLIT_METHOD} Each session with ${MIN_GROUP}+ trades is compared with all other hours, by the hour each trade OPENED in UTC. Because the worst of several sessions is picked, the test level is divided by the number compared (${tested.length}): p < ${alpha.toFixed(3)}. Session hours are the conventional ones from the Sessions desk and do not move for daylight saving.`;
  const perBucket = buckets.map((b) => {
    const g = trades.filter((t) => of(t) === b.id);
    return { b, n: g.length, k: g.filter((t) => t.result === "loss").length };
  });
  const numbers = perBucket.filter((x) => x.n > 0).map((x) => ({ label: `${x.b.name}, lost`, value: `${x.k} of ${x.n}` }));
  if (trades.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(trades.length, "trade")} — not enough to say.`, numbers, n: trades.length, state: "too-few", reason: TOO_FEW_TOTAL(trades.length), working };
  }
  if (tested.length === 0) {
    return { ...base, claim: "No session has enough trades on both sides to compare — not enough to say.", numbers, n: trades.length, state: "too-few", reason: `No session has ${MIN_GROUP}+ trades with ${MIN_GROUP}+ outside it.`, working };
  }
  let best: { b: (typeof buckets)[number]; s: Split; v: ReturnType<typeof judgeSplit> } | null = null;
  for (const b of tested) {
    const x = perBucket.find((p) => p.b.id === b.id) as { n: number; k: number };
    const s: Split = { k1: x.k, n1: x.n, k2: trades.filter((t) => t.result === "loss").length - x.k, n2: trades.length - x.n };
    const v = judgeSplit(s, alpha);
    if (best === null || v.gap > best.v.gap) best = { b, s, v };
  }
  const w = best as NonNullable<typeof best>;
  const found = w.v.state === "found";
  return {
    ...base,
    claim: found
      ? `Losses bunch in the ${w.b.name} session: ${w.s.k1} of ${w.s.n1} lost, against ${pct(w.s.k2 / w.s.n2)} at other hours.`
      : `No session stands out: the worst, ${w.b.name}, lost ${pct(w.s.k1 / w.s.n1)} against ${pct(w.s.k2 / w.s.n2)} elsewhere.`,
    numbers: [...numbers, { label: "Test (worst session)", value: pText(w.v.p) }],
    n: trades.length,
    state: w.v.state,
    reason: w.v.reason,
    working,
    strength: found ? w.v.gap : 0,
    rule: found ? `No new trades in the ${label(w.b)} session until the record there improves.` : null,
  };
}

function checkHolding(trades: readonly ReviewTrade[], source: TradeSource): Pattern {
  const base = { id: "holding" as const, check: "Losers held longer than winners", minN: MIN_TRADES, source, strength: 0, rule: null };
  const working = `Median time held, losers against winners. Found when losers are held ${HOLD_RATIO}x as long or more, with ${MIN_GROUP}+ of each and a Mann-Whitney test under ${ALPHA}. Holding losers longer is the classic sign of moving a stop or waiting for a loss to come back.`;
  const timed = trades.filter((t) => t.holdMs !== null);
  if (timed.length === 0) {
    return { ...base, claim: "Cannot check holding time: no trade records when it closed.", numbers: [], n: 0, state: "cannot-check", reason: `Missing field: close time. None of your ${trades.length} trades has one.`, working };
  }
  const losers = timed.filter((t) => t.result === "loss").map((t) => t.holdMs as number);
  const winners = timed.filter((t) => t.result === "win").map((t) => t.holdMs as number);
  const numbers = [
    { label: "Losers, median held", value: losers.length ? holdText(median(losers)) : "—" },
    { label: "Winners, median held", value: winners.length ? holdText(median(winners)) : "—" },
    { label: "Losers / winners", value: `${losers.length} / ${winners.length}` },
  ];
  if (timed.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(timed.length, "trade")} — not enough to say.`, numbers, n: timed.length, state: "too-few", reason: TOO_FEW_TOTAL(timed.length), working };
  }
  if (losers.length < MIN_GROUP || winners.length < MIN_GROUP) {
    return { ...base, claim: `Only ${plural(Math.min(losers.length, winners.length), losers.length < winners.length ? "loser" : "winner")} — not enough to say.`, numbers, n: timed.length, state: "too-few", reason: TOO_FEW_GROUP("losers", losers.length, "winners", winners.length), working };
  }
  const mw = median(winners);
  const ml = median(losers);
  const ratio = mw > 0 ? ml / mw : ml > 0 ? Number.POSITIVE_INFINITY : 1;
  const p = mannWhitneyP(losers, winners);
  const found = ratio >= HOLD_RATIO && p < ALPHA;
  const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "—";
  return {
    ...base,
    claim: found
      ? `You hold losers longer: median ${holdText(ml)} against ${holdText(mw)} for winners.`
      : `Losers and winners are held for similar times: ${holdText(ml)} against ${holdText(mw)}.`,
    numbers: [...numbers, { label: "Test", value: pText(p) }],
    n: timed.length,
    state: found ? "found" : "not-found",
    reason: found
      ? `Losers held ${ratioText} as long, ${pText(p)}.`
      : ratio < HOLD_RATIO
        ? `No pattern: losers held ${ratioText} as long, under the ${HOLD_RATIO}x line.`
        : `No pattern: ${pText(p)}, not under ${ALPHA} — this few trades can show a gap by chance.`,
    working,
    strength: found ? Math.max(0, Math.min(1, 1 - 1 / ratio)) : 0,
    rule: found ? "Keep the stop where the plan put it — never widen it to give a losing trade more time." : null,
  };
}

function checkAfterLoss(trades: readonly ReviewTrade[], source: TradeSource): Pattern {
  const base = { id: "after-loss" as const, check: "What happens after a loss", minN: MIN_TRADES, source, strength: 0, rule: null };
  const working = `${SPLIT_METHOD} Trades in the order they were opened; each is grouped by the result of the trade before it (a loss, or anything else). The first trade has no "before" and is left out.`;
  const seq = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const afterLoss: ReviewTrade[] = [];
  const afterOther: ReviewTrade[] = [];
  for (let i = 1; i < seq.length; i++) {
    ((seq[i - 1] as ReviewTrade).result === "loss" ? afterLoss : afterOther).push(seq[i] as ReviewTrade);
  }
  const s: Split = {
    k1: afterLoss.filter((t) => t.result === "loss").length,
    n1: afterLoss.length,
    k2: afterOther.filter((t) => t.result === "loss").length,
    n2: afterOther.length,
  };
  const numbers = [
    { label: "After a loss, lost", value: `${s.k1} of ${s.n1}` },
    { label: "Otherwise, lost", value: `${s.k2} of ${s.n2}` },
  ];
  if (seq.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(seq.length, "trade")} — not enough to say.`, numbers, n: seq.length, state: "too-few", reason: TOO_FEW_TOTAL(seq.length), working };
  }
  if (s.n1 < MIN_GROUP || s.n2 < MIN_GROUP) {
    return { ...base, claim: `Only ${plural(s.n1, "trade")} taken after a loss — not enough to say.`, numbers, n: seq.length, state: "too-few", reason: TOO_FEW_GROUP("after a loss", s.n1, "after anything else", s.n2), working };
  }
  const v = judgeSplit(s, ALPHA);
  return {
    ...base,
    claim:
      v.state === "found"
        ? `Losses follow losses: after a loss, ${s.k1} of ${s.n1} next trades also lost, against ${pct(s.k2 / s.n2)} otherwise.`
        : `A loss does not seem to throw you: ${pct(s.k1 / s.n1)} of next trades lost, against ${pct(s.k2 / s.n2)} otherwise.`,
    numbers: [...numbers, { label: "Test", value: pText(v.p) }],
    n: seq.length,
    state: v.state,
    reason: v.reason,
    working,
    strength: v.state === "found" ? v.gap : 0,
    rule: v.state === "found" ? "After a losing trade, no new trade for the rest of that session." : null,
  };
}

/**
 * What you pass on — from the decision log (`journal/says.ts`), your answer
 * to each AI recommendation. DESCRIPTIVE ONLY: it counts your reasons for
 * passing. It says nothing about whether passing was right, because a passed
 * setup has no trade and no result, and inventing one (from what price did
 * next) would grade you on a trade you never took. No rule is proposed from
 * it for the same reason. Source is always the decision log, whatever the
 * trade record in use; `source` is reported as "journal".
 */
function checkPasses(says: readonly Say[] | null): Pattern {
  const base = { id: "passes" as const, check: "What you pass on", minN: MIN_TRADES, source: "journal" as const, strength: 0, rule: null };
  const working = `Your answers to the AI's recommendations ("Your say" under the verdict), counted by the reason you gave for passing. Found when ${MIN_TRADES}+ passes are recorded and one named reason covers ${Math.round(PASS_SHARE * 100)}%+ of them ("Other" and blank never count as the pattern). It does not say whether passing was right: a setup you passed on has no trade, so there is no result to grade.`;
  if (says === null) {
    return { ...base, claim: "Cannot check what you pass on: the decision log is not available here.", numbers: [], n: 0, state: "cannot-check", reason: "Missing source: the decision log (your answers to the AI's recommendations) was not passed to this screen.", working };
  }
  const passes = says.filter((s) => s.choice === "pass");
  const used = says.filter((s) => s.choice !== "pass").length;
  const counts = new Map<string, number>();
  for (const s of passes) {
    const k = s.reason.trim() === "" ? "No reason given" : s.reason;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const numbers = [
    { label: "Passed / taken or adjusted", value: `${passes.length} / ${used}` },
    ...ranked.map(([k, v]) => ({ label: k, value: `${v} of ${passes.length}` })),
  ];
  if (passes.length < MIN_TRADES) {
    return { ...base, claim: `Only ${plural(passes.length, "pass", "passes")} recorded — not enough to say.`, numbers, n: passes.length, state: "too-few", reason: `${plural(passes.length, "pass", "passes")} in the decision log; at least ${MIN_TRADES} needed.`, working };
  }
  const top = ranked.find(([k]) => k !== "Other" && k !== "No reason given");
  const share = top ? top[1] / passes.length : 0;
  if (top && share >= PASS_SHARE) {
    return {
      ...base,
      claim: `Most of your passes are for one reason: "${top[0]}" — ${top[1]} of ${passes.length}.`,
      numbers,
      n: passes.length,
      state: "found",
      reason: `One reason covers ${pct(share)} of passes (found at ${pct(PASS_SHARE)} or more). Whether those passes were right is not measured.`,
      working,
      strength: share,
    };
  }
  return {
    ...base,
    claim: `Your passes are spread across reasons${top ? `; the most common, "${top[0]}", is ${pct(share)}` : ""}.`,
    numbers,
    n: passes.length,
    state: "not-found",
    reason: `No pattern: no named reason covers ${pct(PASS_SHARE)} of passes.`,
    working,
  };
}

/* -------------------------------------------------------------- entry --- */

export interface PatternInput {
  /** Closed MT5 round trips, already adapted. Preferred when non-empty. */
  readonly fills: readonly ReviewTrade[];
  /** Closed journal trades, already adapted. Used when there are no fills, and always for early exits. */
  readonly journal: readonly ReviewTrade[];
  readonly calendar: CalendarWindow | null;
  /** The decision log. Absent or null: the "what you pass on" check cannot check. */
  readonly says?: readonly Say[] | null;
}

/** Which trades the checks read, and why — shown above the findings. */
export function tradeSource(input: PatternInput): { source: TradeSource; trades: readonly ReviewTrade[] } {
  return input.fills.length > 0
    ? { source: "fills", trades: input.fills }
    : { source: "journal", trades: input.journal };
}

/** Every check, in a fixed order. Always seven results — a check never disappears. */
export function checkPatterns(input: PatternInput): Pattern[] {
  const { source, trades } = tradeSource(input);
  return [
    checkNews(trades, input.calendar, source),
    checkTrend(trades, source),
    checkEarlyExit(input.journal),
    checkSession(trades, source),
    checkHolding(trades, source),
    checkAfterLoss(trades, source),
    checkPasses(input.says ?? null),
  ];
}

export type Verdict = "true" | "false";

/**
 * The rule the AI proposes: from the STRONGEST pattern that is found now AND
 * that you marked true. A pattern you rejected, or have not judged, never
 * becomes a rule proposal — the AI finds, you judge.
 */
export function proposeRule(
  patterns: readonly Pattern[],
  verdict: (id: PatternId) => Verdict | null,
): { readonly from: PatternId; readonly text: string; readonly claim: string } | null {
  const confirmed = patterns
    .filter((p) => p.state === "found" && p.rule !== null && verdict(p.id) === "true")
    .sort((a, b) => b.strength - a.strength || b.n - a.n);
  const top = confirmed[0];
  return top ? { from: top.id, text: top.rule as string, claim: top.claim } : null;
}
