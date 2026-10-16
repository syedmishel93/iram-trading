/**
 * THE EVENT LOG — what the machine has been doing, and what has been failing.
 *
 * WHY THIS EXISTS, AND WHAT IT COST NOT TO HAVE IT
 *
 * `/svc/events` had 4,548 rows and no screen anywhere in the product. Inside it,
 * `pair_scan_loop` had logged 2,069 failures — 46% of every event the service
 * had ever recorded — because it called `log_event()` from inside an open write
 * transaction, which asks for a lock the same thread is holding, raises
 * "database is locked" after the busy timeout, and ROLLS BACK the dedup insert
 * that was the point of the block. It had failed on every run it ever made. The
 * loop's `last_tick_age_s` was perfectly fresh the whole time, which is why the
 * System desk's dot means STARTED and never "healthy".
 *
 * Nothing on screen could have told you. That is what this fixes, and it is the
 * general form of CLAUDE.md's largest backlog item: a capability nobody can see
 * is a capability nobody has.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A RECURRING FAILURE IS A STANDING, NOT AN EVENT
 *
 * The tail route is `LIMIT 50`. On fifty rows, two thousand failures look like
 * twelve ordinary lines, so the COUNT is done in SQL over the whole table by
 * `/svc/events/summary`. Counting the tail would have under-reported it
 * forty-fold — the same shape as "a count of what has REPORTED is not a count
 * of what EXISTS".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND A FAILURE IS NOT ALWAYS NAMED LIKE ONE
 *
 * The first classifier asked whether the kind ended in `_err`. It reported ONE
 * failing kind on a log where eleven were failing: `data_mvrv` has logged 224
 * rows, every one of them a 400, under a name that looks like ordinary data
 * collection. The server counts erroring MESSAGES too, and a kind with any is
 * failing whatever it is called.
 *
 * THREE STATES, NOT TWO. "It is waiting for a key only you can supply" is not a
 * failure — FRED has skipped 224 times asking for `FRED_API_KEY`, and filing
 * that under failures would bury the eleven that are genuinely broken.
 */

import { svcUrl } from "./backend";

/** One kind of event, counted over the whole table. */
export interface ActivityKind {
  readonly kind: string;
  /** How many times this has been recorded, ever. */
  readonly n: number;
  /** How many of those were failures. Not the same as `n` for a mixed kind. */
  readonly failed: number;
  readonly newest: number;
  readonly oldest: number;
  /** The NEWEST message, not the lexicographically largest one. */
  readonly sample: string;
  readonly failing: boolean;
  /** Waiting for something only the operator can provide. Not a failure. */
  readonly needsYou: boolean;
}

export interface ActivitySummary {
  readonly ok: boolean;
  readonly kinds: readonly ActivityKind[];
  readonly total: number;
  readonly failingTotal: number;
  readonly failingKinds: number;
  readonly needsYouKinds: number;
  readonly since: number;
  /** Set when the log holds nothing. NEVER a claim that everything worked. */
  readonly emptyReason?: string;
}

/** One row of the tail. */
export interface ActivityEvent {
  readonly id: number;
  readonly t: number;
  readonly kind: string;
  readonly msg: string;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

async function ask<T>(path: string): Promise<Answer<T>> {
  const url = svcUrl(path);
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    /* Addressed to the operator, who can start the service — not to a
       developer reading a stack. */
    return { kind: "offline", why: `the activity log is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `the activity log answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    return { kind: "offline", why: `the activity log did not answer with a report on ${url}` };
  }
}

/** Counts per kind over the WHOLE table, failures first. */
export function activitySummary(): Promise<Answer<ActivitySummary>> {
  return ask<ActivitySummary>("/svc/events/summary");
}

/** The most recent events. A tail, deliberately — the counts come from the summary. */
export function activityTail(limit = 60): Promise<Answer<readonly ActivityEvent[]>> {
  return ask<readonly ActivityEvent[]>(`/svc/events?limit=${Math.max(1, Math.min(500, limit))}`);
}

/**
 * What a job is called, in the operator's words.
 *
 * CLAUDE.md's rule: copy describes the operator's world, not the work that
 * produced it. `data_forexfactory_cal` is a function name with the suffix
 * stripped; "Economic calendar" is what it is. Anything not named here keeps its
 * raw kind rather than being prettified into something misleading — a guessed
 * label on an unknown job is worse than the honest identifier.
 */
/**
 * How many entries a kind has, said honestly.
 *
 * A LOG ENTRY IS NOT A RUN, and the first version of this card said it was:
 * "224 of 224 failed" and "223 runs". `mishel_data.py` calls `log(...)` inside
 * an `except` for most feeds and never on success, so for those kinds every row
 * IS a failure and the denominator is the failure count printed twice. It reads
 * as "it ran 224 times and failed every one" when it may have run five hundred
 * times and logged 224 failures. The number was right and the sentence was
 * wrong, which is worse than being visibly wrong.
 *
 * Only the loop knows how often it ran, and it does not say. So this counts
 * entries and calls them entries, and prints a ratio only where a real
 * denominator exists.
 */
export function entryCount(k: { n: number; failed: number; failing: boolean }): string {
  const n = k.n.toLocaleString();
  if (!k.failing) return `${n} ${k.n === 1 ? "entry" : "entries"}`;
  /* Every entry is a failure: there is no honest "of N" to print. */
  if (k.failed >= k.n) return `${n} ${k.n === 1 ? "failure" : "failures"} logged`;
  return `${k.failed.toLocaleString()} of ${n} entries failed`;
}

/**
 * THE JOBS, and every event kind each one writes.
 *
 * A JOB IS THE UNIT, NOT A KIND. A job logs its successes and its failures
 * under different kinds — `newpair` and `pair_err` are one scanner — so those
 * MUST share a label. The first version was a flat kind→label map, which made
 * that sharing indistinguishable from an accident: two genuinely different jobs
 * were both called "Economic calendar" and the card printed the name twice with
 * different counts beside it, which is unreadable and was only caught on screen.
 *
 * Declaring the job once and listing its kinds makes the label unique BY
 * CONSTRUCTION for a job, and lets the test assert the thing that actually
 * matters: that no two JOBS answer to one name.
 */
const JOBS: readonly { readonly label: string; readonly kinds: readonly string[] }[] = [
  { label: "New-token scan", kinds: ["newpair", "pair_err"] },
  { label: "Large-transfer watch", kinds: ["whale", "whale_err"] },
  { label: "Smart-money wallet alerts", kinds: ["dbalert", "dbalert_err"] },
  { label: "Grading what it claimed", kinds: ["claims_push"] },
  { label: "Replay findings", kinds: ["edge_push"] },
  { label: "Broker sync", kinds: ["mt5_sync"] },
  { label: "Settings backup", kinds: ["backup"] },
  { label: "Daily briefing", kinds: ["daily_brief"] },
  { label: "Market data sweep", kinds: ["data_collect"] },
  { label: "Bitcoin MVRV", kinds: ["data_mvrv"] },
  { label: "Federal Reserve series", kinds: ["data_fred"] },
  /* `data_forexfactory_cal` is kept here although the feed was REMOVED in
     v62.15: 225 of its failures are still in the log and a reader looking at
     them deserves a name rather than a raw kind. It will not grow again. */
  { label: "Economic calendar feed (retired)", kinds: ["data_forexfactory_cal"] },
  { label: "Economic calendar", kinds: ["data_calendar"] },
  { label: "Crypto headlines", kinds: ["data_cointelegraph"] },
  { label: "Investing.com headlines", kinds: ["data_investing"] },
  { label: "Futures positioning", kinds: ["data_cot"] },
  { label: "CoinGecko prices", kinds: ["data_cg"] },
  { label: "Bitcoin difficulty", kinds: ["data_difficulty"] },
  { label: "Bitcoin hashrate", kinds: ["data_hashrate"] },
  { label: "Hourly history top-up", kinds: ["bars_topup_empty"] },
  { label: "Telegram delivery", kinds: ["tg_error"] },
];

const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  JOBS.flatMap((j) => j.kinds.map((k) => [k, j.label] as const)),
);

/** The jobs, for the test that asserts no two answer to one name. */
export function activityJobs(): typeof JOBS {
  return JOBS;
}

export function activityLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}
