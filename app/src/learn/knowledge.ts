/**
 * The knowledge base — what replaying the past has taught, kept and sliced.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING, AND IT WAS NOT A MEASUREMENT
 *
 * The terminal could already replay history per setup on demand
 * (`setup/deep.ts`), record what it claimed and mark it (`learn/claim.ts`,
 * `learn/resolve.ts`), and sweep strategies across markets
 * (`backtest/survey.ts`). Every one of those answers a question and then throws
 * the answer away. Open a different symbol and the replay is gone; come back
 * tomorrow and it runs again from nothing.
 *
 * So the owner's request — "analyse past data and use this knowledge" — was not
 * a request for another study. It was a request for the studies to ACCUMULATE
 * into something a later read can consult. That is this file: a durable,
 * browsable base of what has been replayed, keyed by the setup and sliced by
 * the CONDITIONS it happened in.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE AXIS AT A TIME, AND THAT IS THE WHOLE DESIGN DECISION
 *
 * The obvious model is a cell per (regime × session × hour × weekday). It is
 * also useless: 3 × 5 × 24 × 7 is 2,520 cells per setup, and six thousand bars
 * of ETHUSDT 15m yield perhaps ninety CHoCH trials. Every cell would hold zero
 * or one trial and every one of them would be unusable — a base that is
 * entirely refusals is a base nobody opens twice.
 *
 * So a trial contributes to FIVE cells, one per axis, never to their
 * intersection:
 *
 *     all        the setup here, any conditions
 *     regime     trending / chopping / violent   (backtest/regime.ts)
 *     session    Sydney / Tokyo / London / New York (data/sessionmap.ts)
 *     hour       hour of day, UTC
 *     weekday    day of week, UTC
 *
 * The consequence is stated rather than hidden: the session-axis cells SUM TO
 * MORE than the trial count, because the session windows overlap and a bar at
 * 13:00 UTC is genuinely inside both London and New York. Each cell answers
 * "during London" honestly; they are not a partition and nothing here treats
 * them as one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS AN ENTRY LIST AND NOT A CELL TABLE
 *
 * Idempotence is the requirement that picks the shape. Re-running the same
 * harvest must not double the sample — and a table of running totals cannot
 * tell a re-run from new evidence, because `n += 51` looks identical either
 * way. Storing one ENTRY per study, with its own cell breakdown and an id
 * DERIVED FROM ITS INPUTS, makes the question decidable:
 *
 *   - same inputs  → same id → the merge is a no-op
 *   - deeper study → same slot, more bars → it REPLACES the shallower one
 *   - shallower    → refused, with the reason, so a short re-run cannot shrink
 *                    a base built from a long one
 *
 * Cells are then DERIVED by summing entries on demand. There is one copy of
 * every fact and it is the entry; a cell is a view of it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT FEED BACK. SAME LINE `learn/store.ts` DRAWS, SAME REASON.
 *
 * Nothing here adjusts a gate, a weight or a score. The shipped strategy set
 * has a measured PBO of 89%: the best-looking candidate out of sample is worse
 * than the median about nine times in ten. A base built by replaying patterns
 * over the bars that produced them, fed back into the ranking that chose them,
 * is that mechanism with a shorter loop and no out-of-sample split. It would
 * produce a terminal that agreed with its own history and called it learning.
 *
 * So the prior is reported BESIDE the score, never inside it, and it is allowed
 * to disagree in public.
 */

import { signal, type ReadSignal } from "../core/signal";
import { browserRawStore, createKV, type KV, type Migration, type Slot } from "../store/kv";
import type { BarView } from "../chart/series";
import type { Regime } from "../backtest/regime";
import { classifyRegimes, REGIME_LABEL } from "../backtest/regime";
import { SESSIONS, sessionOpenAt } from "../data/sessionmap";
import { wilson } from "./scorecard";

export type Direction = "long" | "short";

/** Which slice of context a cell describes. Never their intersection — see header. */
export type ContextAxis = "all" | "regime" | "session" | "hour" | "weekday";

export const AXES: readonly ContextAxis[] = ["all", "regime", "session", "hour", "weekday"];

export const AXIS_LABEL: Readonly<Record<ContextAxis, string>> = {
  all: "All conditions",
  regime: "Regime",
  session: "Session",
  hour: "Hour of day",
  weekday: "Weekday",
};

/**
 * Where a contribution came from.
 *
 * Carried per entry and shown on every row, because these are three different
 * kinds of evidence and averaging them without saying so would let a replay —
 * in-sample by construction — borrow the credibility of a claim that was
 * written down before its outcome existed.
 */
export type KnowledgeSource = "replay" | "journal" | "claims";

export const SOURCE_LABEL: Readonly<Record<KnowledgeSource, string>> = {
  replay: "replayed archive",
  journal: "your journal",
  claims: "the terminal's own resolved claims",
};

/**
 * Below this a cell is UNUSABLE and is never quoted as a rate.
 *
 * Twelve, matching `setup/simulate.ts:MIN_TRIALS` deliberately: the two numbers
 * describe the same object — completed replays of one setup — and a base that
 * characterised a sample the Setup card refuses to characterise would be the
 * same evidence answering differently in two places on one screen.
 */
export const MIN_CELL_TRIALS = 12;

/**
 * Past this age an entry is flagged stale rather than silently trusted.
 *
 * Thirty days is not a statistical threshold. It is roughly the point at which
 * an instrument's archive has moved on enough that a replay of it is a
 * statement about a window that no longer includes the present — and, more
 * practically, it is long enough that a base built once and never refreshed
 * stops looking current on the desk.
 */
export const STALE_AFTER_MS = 30 * 86_400_000;

/**
 * How many studies the base keeps.
 *
 * MEASURED, not guessed. One entry carries at most 1 + 3 + 4 + 24 + 7 = 39
 * cells; a cell serialises to roughly 60 bytes and an entry header to about
 * 200, so an entry is ~2.5 kB of JSON. 240 entries is ~600 kB against a ~5 MB
 * localStorage budget already shared with the claim book (~1.4 MB at its own
 * cap), the journal, the drawings and the alert book.
 */
export const MAX_ENTRIES = 240;

/* -------------------------------------------------------------------------- */
/* context                                                                     */
/* -------------------------------------------------------------------------- */

/** The conditions one historical trial opened in. */
export interface TrialContext {
  readonly regime: Regime;
  /**
   * Every session window open at that bar, by id. Usually two — the windows
   * overlap by design and so do these.
   */
  readonly sessions: readonly string[];
  /** 0-23, UTC. Everything is bucketed in UTC; only labels convert. */
  readonly hourUtc: number;
  /** 0 = Sunday, matching `Date.getUTCDay`. */
  readonly weekday: number;
}

/**
 * The context of a bar.
 *
 * UTC throughout, for the reason `data/sessionmap.ts` states: an hour-of-day
 * pattern that shifts with the reader's clock is a rendering artefact, not a
 * pattern.
 */
export function contextAt(at: number, regime: Regime): TrialContext {
  const d = new Date(at);
  const hourUtc = d.getUTCHours();
  return {
    regime,
    sessions: SESSIONS.filter((s) => sessionOpenAt(s, hourUtc)).map((s) => s.id),
    hourUtc,
    weekday: d.getUTCDay(),
  };
}

/**
 * The conditions the NEWEST CLOSED BAR of a series is in.
 *
 * This is what a live read has to pass to `priorFor`, and it is the one part
 * of the query that is a measurement rather than a lookup — so it lives here
 * rather than being re-derived at each call site. `mountShell`'s decision pass
 * runs on ticks and the Setup card is refreshed from it, so a naive version
 * would re-label eight hundred bars several times a second.
 *
 * MEMOISED ON THE SERIES ITSELF, not on the symbol: a key of (length, last
 * timestamp, last close) changes exactly when a new bar closes or the forming
 * bar moves, which is precisely when the label can change. Keying on the
 * symbol would go stale on every tick of the same chart.
 *
 * MEASURED: `classifyRegimes` costs 1.1 ms on 800 bars and 9.1 ms on 6,000
 * (best of 5 after two warm-ups, `vite-node`). The 800-bar figure is the one
 * that matters here —
 * it is what the chart holds — and it is why this is memoised rather than
 * chunked: a tenth of a frame, once per closed bar, is not worth a scheduler.
 *
 * Returns null under 30 bars, which is where `classifyRegimes` itself stops
 * labelling. A guessed regime would file a live read under a condition nobody
 * measured.
 */
let ctxKey = "";
let ctxValue: TrialContext | null = null;

export function contextOfLatest(bars: readonly BarView[]): TrialContext | null {
  const len = Math.max(0, bars.length - 1);
  if (len < 30) return null;
  const last = bars[len - 1];
  if (last === undefined) return null;
  const key = `${len}|${last.t}|${last.c}`;
  if (key === ctxKey) return ctxValue;
  const regime = classifyRegimes(bars.slice(0, len))[len - 1];
  ctxValue = regime === undefined ? null : contextAt(last.t, regime);
  ctxKey = key;
  return ctxValue;
}

/** The (axis, value) pairs one trial contributes to. */
export function cellsOf(ctx: TrialContext): readonly { axis: ContextAxis; value: string }[] {
  const out: { axis: ContextAxis; value: string }[] = [
    { axis: "all", value: "" },
    { axis: "regime", value: ctx.regime },
    { axis: "hour", value: String(ctx.hourUtc) },
    { axis: "weekday", value: String(ctx.weekday) },
  ];
  /* No open session is not a hole to be filled with a guess. With the windows
     in `sessionmap.ts` every hour is covered, so this arm is unreachable today
     and is kept because the windows are a convention that can change, and the
     honest answer to "which session was that" is then "none of the four". */
  if (ctx.sessions.length === 0) out.push({ axis: "session", value: "none" });
  for (const id of ctx.sessions) out.push({ axis: "session", value: id });
  return out;
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The human name of an (axis, value), for a table cell or a sentence. */
export function axisValueLabel(axis: ContextAxis, value: string): string {
  switch (axis) {
    case "all":
      return "Any conditions";
    case "regime":
      return REGIME_LABEL[value as Regime] ?? value;
    case "session": {
      const s = SESSIONS.find((w) => w.id === value);
      return s ? s.name : value === "none" ? "No major session" : value;
    }
    case "hour": {
      const h = Number(value);
      return Number.isFinite(h) ? `${String(h).padStart(2, "0")}:00 UTC` : value;
    }
    case "weekday": {
      const d = Number(value);
      return WEEKDAY[d] ?? value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* the stored shape                                                            */
/* -------------------------------------------------------------------------- */

/** One (axis, value) slice of one study. Summable — see `combine`. */
export interface EntryCell {
  readonly axis: ContextAxis;
  readonly value: string;
  readonly trials: number;
  readonly wins: number;
  readonly losses: number;
  readonly expiries: number;
  /** Sum of realised R across the cell's trials. Expectancy is this over trials. */
  readonly sumR: number;
  /** True median bars-to-resolve WITHIN this cell of this study. */
  readonly medianBars: number;
}

/**
 * One study: everything one replay of one setup on one instrument produced.
 *
 * `id` is derived from the inputs and nothing else, which is what makes a
 * re-run a no-op instead of a second opinion.
 */
export interface KnowledgeEntry {
  readonly id: string;
  /** `source|symbol|timeframe|kind|direction`. One study per slot is kept. */
  readonly slot: string;
  readonly source: KnowledgeSource;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly direction: Direction;
  /** Bars the study was built from. The number that licenses every cell in it. */
  readonly bars: number;
  /** The reward-to-risk every trial was priced at. */
  readonly rMultiple: number;
  /** Epoch ms of the first and last trial observed. */
  readonly first: number;
  readonly last: number;
  /** When this study was written. Drives staleness. */
  readonly at: number;
  readonly cells: readonly EntryCell[];
}

export interface KnowledgeState {
  readonly entries: readonly KnowledgeEntry[];
  /**
   * What the cap dropped on the last write, in words. Empty when it has never
   * bound.
   *
   * Kept in the record rather than in a variable because the drop happens on a
   * write the operator may not be watching, and a cap that silently discards
   * evidence is indistinguishable from a base that never learned it.
   */
  readonly droppedNote: string;
}

/* ------------------------------------------------------------------- id --- */

/**
 * FNV-1a, 32-bit, hex.
 *
 * Not for security. It needs exactly one property: the same inputs must give
 * the same string on every machine and every run, so that re-running a study
 * produces an id the base recognises as one it already holds.
 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * What identifies a study, and why the R multiple is part of it.
 *
 * A 40% hit rate is excellent at 3R and ruinous at 1R. Two studies of the same
 * pattern at different reward-to-risk are therefore not two samples of one
 * thing — they are two different questions, and pooling them would produce a
 * hit rate that belongs to neither. It is in the slot, so a 2R harvest never
 * overwrites a 1R one and `combine` never sums across them.
 */
export function slotOf(
  source: KnowledgeSource,
  symbol: string,
  timeframe: string,
  kind: string,
  direction: Direction,
  rMultiple: number,
): string {
  return `${source}|${symbol.toUpperCase()}|${timeframe}|${kind}|${direction}|${rMultiple.toFixed(2)}`;
}

/**
 * The id of a study, from its inputs.
 *
 * Includes the trial count and the first/last trial times as well as the bar
 * count, because two passes over the same 6,000 bars with different detector
 * settings are different studies and must not silently overwrite one another
 * as though they were a repeat.
 */
export function entryId(e: Omit<KnowledgeEntry, "id" | "at">): string {
  const trials = e.cells.find((c) => c.axis === "all")?.trials ?? 0;
  return fnv1a(
    [e.slot, e.bars, e.rMultiple.toFixed(4), e.first, e.last, trials, e.cells.length].join("~"),
  );
}

/* ------------------------------------------------------------- building --- */

/** One historical trial, as the harvest hands it over. */
export interface TrialFact {
  /** Epoch ms of the bar the trial opened from. */
  readonly at: number;
  readonly outcome: "target" | "stop" | "expired";
  /** Realised R. */
  readonly r: number;
  /** Bars from open to resolution. */
  readonly heldBars: number;
  readonly context: TrialContext;
}

export interface EntryInput {
  readonly source: KnowledgeSource;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly direction: Direction;
  readonly bars: number;
  readonly rMultiple: number;
  readonly trials: readonly TrialFact[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Turn one study's trials into an entry.
 *
 * Returns null on an empty trial list rather than an entry with zero
 * everywhere: a study that found nothing is not knowledge, and storing it would
 * spend a cap slot on a row that can only ever say "nothing here".
 */
export function buildEntry(input: EntryInput, at: number): KnowledgeEntry | null {
  if (input.trials.length === 0) return null;

  const buckets = new Map<string, { axis: ContextAxis; value: string; held: number[]; t: TrialFact[] }>();
  for (const t of input.trials) {
    for (const { axis, value } of cellsOf(t.context)) {
      const key = `${axis} ${value}`;
      let b = buckets.get(key);
      if (b === undefined) {
        b = { axis, value, held: [], t: [] };
        buckets.set(key, b);
      }
      b.held.push(t.heldBars);
      b.t.push(t);
    }
  }

  const cells: EntryCell[] = [...buckets.values()]
    .map((b) => ({
      axis: b.axis,
      value: b.value,
      trials: b.t.length,
      wins: b.t.filter((x) => x.outcome === "target").length,
      losses: b.t.filter((x) => x.outcome === "stop").length,
      expiries: b.t.filter((x) => x.outcome === "expired").length,
      sumR: b.t.reduce((s, x) => s + x.r, 0),
      medianBars: median(b.held),
    }))
    /* Deterministic order. Two runs of the same study must serialise
       identically, or the id derived from them is not stable across a reload. */
    .sort((a, b) => (a.axis === b.axis ? a.value.localeCompare(b.value) : a.axis.localeCompare(b.axis)));

  const times = input.trials.map((t) => t.at);
  const core = {
    slot: slotOf(
      input.source,
      input.symbol,
      input.timeframe,
      input.kind,
      input.direction,
      input.rMultiple,
    ),
    source: input.source,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    kind: input.kind,
    direction: input.direction,
    bars: input.bars,
    rMultiple: input.rMultiple,
    first: Math.min(...times),
    last: Math.max(...times),
    cells,
  };
  return { ...core, id: entryId(core), at };
}

/* -------------------------------------------------------------------------- */
/* reading: cells                                                              */
/* -------------------------------------------------------------------------- */

/** A cell of the base: one (setup, axis, value), summed over every study of it. */
export interface KnowledgeCell {
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly direction: Direction;
  readonly axis: ContextAxis;
  readonly value: string;
  readonly label: string;
  /**
   * The reward-to-risk every trial behind this cell was priced at.
   *
   * On the face of the cell rather than in a footnote: a hit rate without the
   * R it was measured at is half a fact, and the half that is missing is the
   * one that decides whether the number is good news.
   */
  readonly rMultiple: number;

  readonly trials: number;
  readonly wins: number;
  readonly losses: number;
  readonly expiries: number;
  readonly hitRate: number;
  /** Wilson 95% lower bound. The number to quote when quoting one. */
  readonly hitLow: number;
  /** Mean realised R per attempt. */
  readonly expectancyR: number;
  readonly medianBars: number;
  /**
   * True when more than one study fed this cell, so `medianBars` is a
   * trial-weighted mean of their medians rather than a median.
   *
   * A median is not summable and two studies cannot be pooled into one without
   * their raw trial lists, which this base deliberately does not keep. Saying
   * which of the two numbers is on screen is cheaper than storing the lists and
   * more honest than calling the pooled figure a median.
   */
  readonly medianPooled: boolean;

  /** Bars the contributing studies were built from, summed. */
  readonly bars: number;
  readonly first: number;
  readonly last: number;
  readonly updatedAt: number;
  readonly stale: boolean;
  /** trials >= MIN_CELL_TRIALS. Below it nothing here may be characterised. */
  readonly usable: boolean;
  readonly sources: readonly KnowledgeSource[];
  readonly studies: number;
}

const EMPTY_LIST: readonly KnowledgeEntry[] = [];

/**
 * Sum every study's view of one (axis, value) into a cell.
 *
 * Exported for the desk and for tests. `now` is a parameter rather than
 * `Date.now()` so a staleness test does not have to wait a month.
 */
export function combine(
  entries: readonly KnowledgeEntry[],
  axis: ContextAxis,
  value: string,
  now: number,
): KnowledgeCell | null {
  const parts: { e: KnowledgeEntry; c: EntryCell }[] = [];
  for (const e of entries) {
    const c = e.cells.find((x) => x.axis === axis && x.value === value);
    if (c !== undefined && c.trials > 0) parts.push({ e, c });
  }
  if (parts.length === 0) return null;

  const head = parts[0] as { e: KnowledgeEntry; c: EntryCell };
  const trials = parts.reduce((s, p) => s + p.c.trials, 0);
  const wins = parts.reduce((s, p) => s + p.c.wins, 0);
  const sumR = parts.reduce((s, p) => s + p.c.sumR, 0);
  const updatedAt = Math.max(...parts.map((p) => p.e.at));

  return {
    symbol: head.e.symbol,
    timeframe: head.e.timeframe,
    kind: head.e.kind,
    direction: head.e.direction,
    axis,
    value,
    label: axisValueLabel(axis, value),
    rMultiple: head.e.rMultiple,
    trials,
    wins,
    losses: parts.reduce((s, p) => s + p.c.losses, 0),
    expiries: parts.reduce((s, p) => s + p.c.expiries, 0),
    hitRate: wins / trials,
    hitLow: wilson(wins, trials).low,
    expectancyR: sumR / trials,
    medianBars: parts.reduce((s, p) => s + p.c.medianBars * p.c.trials, 0) / trials,
    medianPooled: parts.length > 1,
    bars: parts.reduce((s, p) => s + p.e.bars, 0),
    first: Math.min(...parts.map((p) => p.e.first)),
    last: Math.max(...parts.map((p) => p.e.last)),
    updatedAt,
    stale: now - updatedAt > STALE_AFTER_MS,
    usable: trials >= MIN_CELL_TRIALS,
    sources: [...new Set(parts.map((p) => p.e.source))].sort(),
    studies: parts.length,
  };
}

/** Every cell the base holds, optionally narrowed to one axis. */
export function allCells(
  entries: readonly KnowledgeEntry[],
  now: number,
  axis?: ContextAxis,
): readonly KnowledgeCell[] {
  const seen = new Map<string, { axis: ContextAxis; value: string; pool: KnowledgeEntry[] }>();
  for (const e of entries) {
    for (const c of e.cells) {
      if (axis !== undefined && c.axis !== axis) continue;
      /* The R multiple is IN THE KEY. Without it a 1R study and a 3R study of
         the same pattern would be summed into one hit rate that describes
         neither — see `slotOf`. */
      const key = `${e.symbol} ${e.timeframe} ${e.kind} ${e.direction} ${e.rMultiple.toFixed(2)} ${c.axis} ${c.value}`;
      const held = seen.get(key);
      if (held === undefined) seen.set(key, { axis: c.axis, value: c.value, pool: [e] });
      else held.pool.push(e);
    }
  }
  const out: KnowledgeCell[] = [];
  for (const { axis: a, value, pool } of seen.values()) {
    const cell = combine(pool, a, value, now);
    if (cell !== null) out.push(cell);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* reading: the prior                                                          */
/* -------------------------------------------------------------------------- */

export type PriorStanding = "none" | "thin" | "usable";

export interface KnowledgePrior {
  readonly standing: PriorStanding;
  /** The cell that answered, or null when nothing did. */
  readonly cell: KnowledgeCell | null;
  /** Which axis answered. "" when none did. */
  readonly axis: ContextAxis | "";
  /** One line, safe to render verbatim. Always states the sample. */
  readonly line: string;
  /** True when the entry behind it is past STALE_AFTER_MS. */
  readonly stale: boolean;
}

export const NO_PRIOR: KnowledgePrior = {
  standing: "none",
  cell: null,
  axis: "",
  line: "",
  stale: false,
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const rr = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

/**
 * "2h ago", "3 days ago".
 *
 * Exported because the desk prints the same phrase and two formatters would
 * eventually disagree about what counts as a day.
 */
export function agoText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "replays of 5,900 bars" / "your journal" / two of them joined. */
function sourcePhrase(cell: KnowledgeCell): string {
  const bits = cell.sources.map((s) =>
    s === "replay" ? `replays of ${cell.bars.toLocaleString()} bars` : SOURCE_LABEL[s],
  );
  if (bits.length === 1) return bits[0] as string;
  return `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1] as string}`;
}

/** The phrase naming the slice, matching the axis it came from. */
function axisPhrase(axis: ContextAxis, cell: KnowledgeCell): string {
  switch (axis) {
    case "all":
      return "here, any conditions";
    case "regime":
      return "this regime here";
    case "session":
      return `the ${cell.label} session here`;
    case "hour":
      return `this hour (${cell.label}) here`;
    case "weekday":
      return `${cell.label}s here`;
  }
}

/**
 * The ladder the prior walks.
 *
 * Narrowest question first. A regime cell is the one the Setup card asks for
 * — it is the condition you are actually in — and when it has not reached the
 * floor the answer widens rather than refusing outright, saying which rung
 * answered. Reporting the rung is the whole point: "in this regime" and "here,
 * any conditions" are different claims and a reader not told which one they got
 * will assume the stronger.
 */
const DEFAULT_LADDER: readonly ContextAxis[] = ["regime", "session", "all"];

/**
 * What the base knows about this setup, in these conditions.
 *
 * Reported BESIDE the score and never folded into it — see the header, and
 * `setup/simulate.ts` for the measured PBO that makes the distinction matter.
 */
export interface PriorOptions {
  readonly now?: number;
  /**
   * The reward-to-risk the caller is asking about — the live plan's, normally.
   *
   * Studies at a different R are a different question (see `slotOf`), so the
   * base answers from the nearest R it holds and NEVER pools them. Omitted, it
   * answers from whichever R has the most trials, which is the strongest
   * statement the evidence supports about something.
   */
  readonly rMultiple?: number;
  readonly ladder?: readonly ContextAxis[];
}

export function priorFor(
  entries: readonly KnowledgeEntry[],
  symbol: string,
  timeframe: string,
  kind: string,
  direction: Direction,
  context: TrialContext | null,
  opts: PriorOptions = {},
): KnowledgePrior {
  const now = opts.now ?? Date.now();
  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const sym = symbol.toUpperCase();
  const here = entries.filter(
    (e) => e.symbol === sym && e.timeframe === timeframe && e.kind === kind && e.direction === direction,
  );
  if (here.length === 0) return NO_PRIOR;

  /* Pick ONE reward-to-risk and answer from it alone. */
  const byR = new Map<number, KnowledgeEntry[]>();
  for (const e of here) {
    const list = byR.get(e.rMultiple);
    if (list === undefined) byR.set(e.rMultiple, [e]);
    else list.push(e);
  }
  const trialsOf = (list: readonly KnowledgeEntry[]): number =>
    list.reduce((s, e) => s + (e.cells.find((c) => c.axis === "all")?.trials ?? 0), 0);
  const groups = [...byR.entries()];
  const chosen =
    opts.rMultiple === undefined
      ? groups.reduce((best, g) => (trialsOf(g[1]) > trialsOf(best[1]) ? g : best))
      : groups.reduce((best, g) =>
          Math.abs(g[0] - (opts.rMultiple as number)) < Math.abs(best[0] - (opts.rMultiple as number)) ? g : best,
        );
  const mine = chosen[1];

  const valueFor = (axis: ContextAxis): string | null => {
    if (axis === "all") return "";
    if (context === null) return null;
    if (axis === "regime") return context.regime;
    if (axis === "hour") return String(context.hourUtc);
    if (axis === "weekday") return String(context.weekday);
    return context.sessions[0] ?? "none";
  };

  let thin: KnowledgeCell | null = null;
  let thinAxis: ContextAxis | "" = "";

  for (const axis of ladder) {
    const value = valueFor(axis);
    if (value === null) continue;
    const cell = combine(mine, axis, value, now);
    if (cell === null) continue;
    if (!cell.usable) {
      if (thin === null) {
        thin = cell;
        thinAxis = axis;
      }
      continue;
    }
    const staleBit = cell.stale
      ? ` Last harvested ${agoText(now - cell.updatedAt)} — stale; re-harvest before leaning on it.`
      : "";
    return {
      standing: "usable",
      cell,
      axis,
      stale: cell.stale,
      line:
        `In ${axisPhrase(axis, cell)}: ${cell.wins} of ${cell.trials}, at least ${pct(cell.hitLow)}, ` +
        `${rr(cell.expectancyR)} per attempt — from ${sourcePhrase(cell)}, ` +
        `last updated ${agoText(now - cell.updatedAt)}.${staleBit}`,
    };
  }

  /* Something is on the record but no rung reached the floor. Worth saying:
     "nothing yet" and "too little to read" send the operator to different
     places, and only one of them is worth waiting on. */
  if (thin !== null && thinAxis !== "") {
    return {
      standing: "thin",
      cell: thin,
      axis: thinAxis,
      stale: thin.stale,
      line:
        `In ${axisPhrase(thinAxis, thin)}: only ${thin.trials} ` +
        `${thin.trials === 1 ? "trial" : "trials"} harvested, under the ${MIN_CELL_TRIALS} ` +
        `needed before a rate means anything.`,
    };
  }
  return NO_PRIOR;
}

/* -------------------------------------------------------------------------- */
/* storage                                                                     */
/* -------------------------------------------------------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function sanitiseCell(raw: unknown): EntryCell | null {
  if (!isRecord(raw)) return null;
  const axis = raw["axis"];
  const value = raw["value"];
  if (typeof axis !== "string" || !AXES.includes(axis as ContextAxis)) return null;
  if (typeof value !== "string") return null;
  const num = (k: string): number | null => {
    const v = raw[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const trials = num("trials");
  const wins = num("wins");
  const losses = num("losses");
  const expiries = num("expiries");
  const sumR = num("sumR");
  const medianBars = num("medianBars");
  if (trials === null || wins === null || losses === null) return null;
  if (expiries === null || sumR === null || medianBars === null) return null;
  if (trials <= 0 || wins < 0 || wins > trials) return null;
  return { axis: axis as ContextAxis, value, trials, wins, losses, expiries, sumR, medianBars };
}

/**
 * One stored entry, or null.
 *
 * Per ENTRY, never on the array: a half-written study must drop out on its own
 * rather than taking every other study with it. Same rule, same reason as
 * `listSlot` in `store/kv.ts`.
 */
export function sanitiseEntry(raw: unknown): KnowledgeEntry | null {
  if (!isRecord(raw)) return null;
  const str = (k: string): string | null => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  const num = (k: string): number | null =>
    typeof raw[k] === "number" && Number.isFinite(raw[k] as number) ? (raw[k] as number) : null;

  const id = str("id");
  const slot = str("slot");
  const source = str("source");
  const symbol = str("symbol");
  const timeframe = str("timeframe");
  const kind = str("kind");
  const direction = str("direction");
  const bars = num("bars");
  const rMultiple = num("rMultiple");
  const first = num("first");
  const last = num("last");
  const at = num("at");
  if (id === null || slot === null || symbol === null || timeframe === null || kind === null) return null;
  if (source !== "replay" && source !== "journal" && source !== "claims") return null;
  if (direction !== "long" && direction !== "short") return null;
  if (bars === null || rMultiple === null || first === null || last === null || at === null) return null;

  const rawCells = raw["cells"];
  if (!Array.isArray(rawCells)) return null;
  const cells: EntryCell[] = [];
  for (const c of rawCells) {
    const ok = sanitiseCell(c);
    if (ok !== null) cells.push(ok);
  }
  if (cells.length === 0) return null;

  return { id, slot, source, symbol, timeframe, kind, direction, bars, rMultiple, first, last, at, cells };
}

/**
 * v1 → v2: the bare entry list becomes a record carrying the cap's own note.
 *
 * WHY A MIGRATION EXISTS ON A NEW SLOT, SAID PLAINLY RATHER THAN IMPLIED.
 * No install is KNOWN to hold v1. It is declared, supported and tested anyway,
 * because a slot whose migration table is empty has an untested mechanism, and
 * the first real shape change would then be the first time that path ever ran —
 * on the operator's only copy of the base. `kv.putEnvelope` (the sync and
 * import path) can also land a v1 envelope from another machine, so the reader
 * is reachable rather than theoretical.
 */
const migrateV1ToV2: Migration = (value: unknown): unknown => ({
  entries: Array.isArray(value) ? value : [],
  droppedNote: "",
});

export const KNOWLEDGE_SLOT: Slot<KnowledgeState> = {
  key: "learn.knowledge",
  version: 2,
  fallback: (): KnowledgeState => ({ entries: [], droppedNote: "" }),
  validate: (v: unknown): KnowledgeState | null => {
    if (!isRecord(v)) return null;
    const list = v["entries"];
    if (!Array.isArray(list)) return null;
    const entries: KnowledgeEntry[] = [];
    for (const raw of list) {
      const e = sanitiseEntry(raw);
      if (e !== null) entries.push(e);
    }
    const note = v["droppedNote"];
    return { entries, droppedNote: typeof note === "string" ? note : "" };
  },
  migrations: { 1: migrateV1ToV2 },
};

/**
 * Drop the oldest studies until the list fits, and SAY WHAT WENT.
 *
 * Oldest by write time, which is the only ordering that does not quietly
 * prefer one instrument. A cap that discards evidence without a word is
 * indistinguishable from a base that never learned it, so the note travels with
 * the record and the desk prints it.
 */
export function evictEntries(
  list: readonly KnowledgeEntry[],
  max = MAX_ENTRIES,
): { kept: readonly KnowledgeEntry[]; dropped: readonly KnowledgeEntry[]; note: string } {
  if (list.length <= max) return { kept: list, dropped: [], note: "" };
  const byAge = [...list].sort((a, b) => a.at - b.at);
  const dropped = byAge.slice(0, byAge.length - max);
  const keptIds = new Set(byAge.slice(byAge.length - max).map((e) => e.id));
  const symbols = [...new Set(dropped.map((d) => d.symbol))].sort();
  return {
    kept: list.filter((e) => keptIds.has(e.id)),
    dropped,
    note:
      `The base is full at ${max} studies. ${dropped.length} of the oldest ` +
      `${dropped.length === 1 ? "study was" : "studies were"} dropped to make room — ` +
      `${symbols.join(", ")}. Harvest them again to get them back.`,
  };
}

export interface MergeReport {
  readonly added: number;
  readonly replaced: number;
  /** Already held, byte for byte. The idempotent case. */
  readonly unchanged: number;
  /** Studies refused, each with the reason. */
  readonly refused: readonly string[];
  readonly dropped: number;
  /** One sentence the desk can print verbatim. */
  readonly note: string;
}

export interface KnowledgeBase {
  readonly entries: ReadSignal<readonly KnowledgeEntry[]>;
  readonly droppedNote: ReadSignal<string>;
  readonly lastError: ReadSignal<string>;

  /** Deterministic and idempotent — see the header. */
  merge(incoming: readonly KnowledgeEntry[]): MergeReport;

  /** The cell answering one (setup, axis, value) at one reward-to-risk. */
  cell(
    symbol: string,
    timeframe: string,
    kind: string,
    direction: Direction,
    rMultiple: number,
    axis: ContextAxis,
    value: string,
  ): KnowledgeCell | null;

  /** Every cell held, optionally one axis. For the desk. */
  cells(axis?: ContextAxis): readonly KnowledgeCell[];

  /** What the base knows about this setup, in these conditions. */
  priorFor(
    symbol: string,
    timeframe: string,
    kind: string,
    direction: Direction,
    context: TrialContext | null,
    rMultiple?: number,
  ): KnowledgePrior;

  forget(filter: (e: KnowledgeEntry) => boolean): number;
  forgetAll(): number;
  snapshot(): KnowledgeState;
}

export function createKnowledgeBase(kv: KV, now: () => number = Date.now): KnowledgeBase {
  const read = kv.read(KNOWLEDGE_SLOT);
  const entries = signal<readonly KnowledgeEntry[]>(read.value.entries);
  const droppedNote = signal<string>(read.value.droppedNote);
  const lastError = signal("");

  const persist = (next: readonly KnowledgeEntry[], note: string): void => {
    entries.set(next);
    droppedNote.set(note);
    const res = kv.write(KNOWLEDGE_SLOT, { entries: [...next], droppedNote: note });
    lastError.set(res.ok ? "" : `What the terminal has learned was not saved — ${res.error}`);
  };

  const base: KnowledgeBase = {
    entries,
    droppedNote,
    lastError,

    merge(incoming) {
      const held = [...entries.peek()];
      const byId = new Map(held.map((e) => [e.id, e]));
      const bySlot = new Map(held.map((e) => [e.slot, e]));

      let added = 0;
      let replaced = 0;
      let unchanged = 0;
      const refused: string[] = [];

      for (const raw of incoming) {
        const e = sanitiseEntry(raw);
        if (e === null) {
          refused.push("a study arrived in a shape this build does not recognise and was not merged.");
          continue;
        }
        /* IDEMPOTENCE, and it is one line. The id is derived from the inputs,
           so a repeat of the same study is the same id and there is nothing to
           do. Re-running a harvest can therefore never double a sample. */
        if (byId.has(e.id)) {
          unchanged++;
          continue;
        }
        const prev = bySlot.get(e.slot);
        if (prev === undefined) {
          held.push(e);
          byId.set(e.id, e);
          bySlot.set(e.slot, e);
          added++;
          continue;
        }
        /* A shallower re-run must not shrink a base built from a longer one.
           Equal depth replaces, because that is a refresh of the same window
           with a newer archive; less depth is refused WITH THE REASON, so an
           operator who wonders why nothing changed is told. */
        if (e.bars < prev.bars) {
          refused.push(
            `${e.symbol} ${e.timeframe} ${e.kind} ${e.direction}: this pass covered ${e.bars.toLocaleString()} bars and the study already held covers ${prev.bars.toLocaleString()}. Kept the deeper one.`,
          );
          continue;
        }
        const at = held.indexOf(prev);
        held[at] = e;
        byId.delete(prev.id);
        byId.set(e.id, e);
        bySlot.set(e.slot, e);
        replaced++;
      }

      const evicted = evictEntries(held);
      if (added > 0 || replaced > 0 || evicted.dropped.length > 0) {
        persist(evicted.kept, evicted.note || droppedNote.peek());
      }

      const bits: string[] = [];
      if (added > 0) bits.push(`${added} new`);
      if (replaced > 0) bits.push(`${replaced} refreshed`);
      if (unchanged > 0) bits.push(`${unchanged} already held`);
      if (refused.length > 0) bits.push(`${refused.length} refused`);
      return {
        added,
        replaced,
        unchanged,
        refused,
        dropped: evicted.dropped.length,
        note: bits.length === 0 ? "Nothing to merge." : `${bits.join(", ")}.`,
      };
    },

    cell(symbol, timeframe, kind, direction, rMultiple, axis, value) {
      const sym = symbol.toUpperCase();
      const mine = entries().filter(
        (e) =>
          e.symbol === sym &&
          e.timeframe === timeframe &&
          e.kind === kind &&
          e.direction === direction &&
          e.rMultiple === rMultiple,
      );
      return mine.length === 0 ? null : combine(mine, axis, value, now());
    },

    cells(axis) {
      return axis === undefined ? allCells(entries(), now()) : allCells(entries(), now(), axis);
    },

    priorFor(symbol, timeframe, kind, direction, context, rMultiple) {
      return priorFor(entries(), symbol, timeframe, kind, direction, context, {
        now: now(),
        ...(rMultiple === undefined ? {} : { rMultiple }),
      });
    },

    forget(filter) {
      const before = entries.peek();
      const kept = before.filter((e) => !filter(e));
      const gone = before.length - kept.length;
      if (gone > 0) persist(kept, droppedNote.peek());
      return gone;
    },

    forgetAll() {
      const gone = entries.peek().length;
      if (gone > 0) persist(EMPTY_LIST, "");
      return gone;
    },

    snapshot() {
      return { entries: entries.peek(), droppedNote: droppedNote.peek() };
    },
  };

  return base;
}

/**
 * The application's one knowledge base.
 *
 * ONE FACT, ONE OWNER. The desk, the Setup card's second line and the analyst's
 * tool must all read the same base, or the terminal would show three answers to
 * one question and call them all measurements. `mountShell` does not build this
 * one — it is created on first use, from the browser's own storage — precisely
 * so that a caller cannot accidentally create a second.
 *
 * Tests never touch it: they call `createKnowledgeBase` with a memory store.
 */
let shared: KnowledgeBase | null = null;

export function sharedKnowledge(kv?: KV): KnowledgeBase {
  /* `browserRawStore` already falls back to memory when storage throws on
     access — private windows, embedded webviews, a Node test that reached here
     by accident — so this cannot be the thing that stops the terminal booting.
     What it cannot do is survive a reload, and `store/durability.ts` is what
     turns that into something the operator is told. */
  if (shared === null) shared = createKnowledgeBase(kv ?? createKV(browserRawStore()));
  return shared;
}

/** True once the base has been opened. Lets a caller avoid forcing it into life. */
export function knowledgeOpened(): boolean {
  return shared !== null;
}

/** Tests only. Drops the singleton so each case starts from nothing. */
export function resetSharedKnowledge(): void {
  shared = null;
}
