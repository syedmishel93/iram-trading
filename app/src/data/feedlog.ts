/**
 * What the network is actually doing, as it does it.
 *
 * WHY THIS EXISTS
 * The terminal already failed over between six data sources, opened circuit
 * breakers, reconnected sockets, served bars from the archive and parked banned
 * hosts — and reported all of it as a single word in the status bar. When the
 * chart went stale there was no way to answer the only question that matters:
 * *which source am I on, when did it last hand me something, and what happened
 * to the ones it skipped?* `Resolution.attempts` was computed on every load and
 * then thrown away in the same expression that returned the bars.
 *
 * WHAT WAS FOUND THE MOMENT IT WAS WRITTEN DOWN
 * MT5 and both proxy sources return `null` from `streamUrl`, so a gold or forex
 * chart had no socket and no poller: it loaded once and then aged, silently,
 * for ever. "STALE — no update for 218s" was not a network fault. It was the
 * terminal having nothing at all that would ever ask again.
 *
 * THE RULES
 *  · A ring buffer, bounded. A log that grows without limit is a leak, and this
 *    one is appended to several times a second on a live socket.
 *  · Every entry carries the CLOCK IT HAPPENED AT and how long it took. Ages
 *    are computed at render time so a paused tab does not freeze them.
 *  · Nothing here retries, reconnects or decides anything. It is a witness. A
 *    diagnostic that can change what it is diagnosing is not a diagnostic.
 */

import { signal, type Signal } from "../core/signal";

export type FeedEventKind =
  /** A source was tried during failover — succeeded, failed or was skipped. */
  | "attempt"
  /** The series is now being served by a different source than before. */
  | "switch"
  /** A live bar arrived down the socket. */
  | "tick"
  /** A poll cycle asked a socketless source for the newest bars. */
  | "poll"
  /** The socket changed state: connecting, open, reconnecting, closed. */
  | "socket"
  /** A whole load finished — how many bars, from where, cache or wire. */
  | "load"
  /** Something the operator should see: a park, a refusal, a clock correction. */
  | "notice";

export interface FeedEvent {
  /** Monotonic, so two events in the same millisecond still order. */
  readonly seq: number;
  readonly at: number;
  readonly kind: FeedEventKind;
  /** Source id (`binance`, `mt5`, …) or the transport name. Never blank. */
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** One sentence, already written for a human. */
  readonly text: string;
  /** Round-trip in ms where one was measured. */
  readonly ms?: number;
  readonly ok: boolean;
}

/**
 * How many events are kept.
 *
 * 500 is roughly twenty minutes of a 1m socket, or several hundred failovers.
 * Enough to answer "what happened just before it broke" and small enough that
 * re-rendering the whole list stays free.
 */
export const CAPACITY = 500;

export interface SourceStat {
  readonly source: string;
  readonly attempts: number;
  readonly ok: number;
  readonly failed: number;
  /** Mean round-trip over successful attempts only. NaN when there are none. */
  readonly avgMs: number;
  readonly lastAt: number;
  readonly lastNote: string;
}

/**
 * Roll the log up per source.
 *
 * Pure, so the summary is testable without a network. Failures keep their note
 * rather than being counted into a bare number: "3 failed" tells you nothing you
 * can act on, and "3 failed — ECONNREFUSED" tells you the proxy is not running.
 */
export function summarise(events: readonly FeedEvent[]): SourceStat[] {
  const by = new Map<string, { a: number; ok: number; f: number; sum: number; n: number; at: number; note: string }>();
  for (const e of events) {
    if (e.kind !== "attempt") continue;
    const cur = by.get(e.source) ?? { a: 0, ok: 0, f: 0, sum: 0, n: 0, at: 0, note: "" };
    cur.a += 1;
    if (e.ok) {
      cur.ok += 1;
      if (typeof e.ms === "number" && Number.isFinite(e.ms)) {
        cur.sum += e.ms;
        cur.n += 1;
      }
    } else {
      cur.f += 1;
    }
    /* The LAST note wins, not the last failure's note: a source that failed and
       then recovered must not still be described by its failure. */
    if (e.at >= cur.at) {
      cur.at = e.at;
      cur.note = e.text;
    }
    by.set(e.source, cur);
  }

  return [...by.entries()]
    .map(([source, v]) => ({
      source,
      attempts: v.a,
      ok: v.ok,
      failed: v.f,
      avgMs: v.n > 0 ? v.sum / v.n : NaN,
      lastAt: v.at,
      lastNote: v.note,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

export interface FeedLog {
  readonly events: Signal<readonly FeedEvent[]>;
  /** Total ever recorded, including the ones the ring has dropped. */
  readonly total: () => number;
  record(e: Omit<FeedEvent, "seq" | "at"> & { at?: number }): void;
  clear(): void;
}

export function createFeedLog(capacity = CAPACITY, now: () => number = Date.now): FeedLog {
  const events = signal<readonly FeedEvent[]>([]);
  let seq = 0;

  return {
    events,
    total: () => seq,

    record(e) {
      seq += 1;
      const entry: FeedEvent = {
        seq,
        at: e.at ?? now(),
        kind: e.kind,
        source: e.source || "—",
        symbol: e.symbol,
        timeframe: e.timeframe,
        text: e.text,
        ok: e.ok,
        ...(e.ms !== undefined ? { ms: e.ms } : {}),
      };
      /* Newest FIRST. The panel reads top-down and the interesting end of a
         diagnostic log is the recent end; reversing at render time would sort
         five hundred entries on every repaint to save one unshift here. */
      const next = [entry, ...events.peek()];
      events.set(next.length > capacity ? next.slice(0, capacity) : next);
    },

    clear() {
      events.set([]);
    },
  };
}

/* Deliberately NO shared singleton here.
   `governor` and `responseCache` are shared because there is genuinely one rate
   budget and one cache per document. There is NOT one feed: `workspace.ts`
   builds one per pane. A module-level log would interleave every pane's events
   into a single stream, which was tried and read as a fault the first time a
   four-pane layout opened four sockets. Each `createFeed` owns its own. */
