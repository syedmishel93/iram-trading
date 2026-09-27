/**
 * Where the journal lives.
 *
 * WHY A CAP, AND WHY IT IS THE OLDEST THAT GO
 * Journal entries are small and a serious book is a few thousand of them, so
 * the cap is generous rather than tight. It exists because this shares a
 * storage budget with the bar archive and the drawing store, and an unbounded
 * list in a quota-limited store eventually fails a write — silently, on the
 * one entry you most wanted to keep, since it is always the newest write that
 * fails. Capping is the only way to make that failure predictable.
 *
 * The oldest go, not the smallest or the closed ones. A journal is a time
 * series, and dropping trades by any rule other than age would put a hole in
 * the middle of it that every statistic downstream would silently step over.
 *
 * WHY OPEN TRADES ARE NEVER EVICTED
 * An open position dropped from the book is a trade you are still in with no
 * record that you are. That is the one failure mode here with a real cost, so
 * open entries are exempt from the cap entirely and the eviction runs over the
 * closed ones. Somebody with 5,000 open positions has a different problem.
 */

import { signal, type Signal } from "../core/signal";
import { sanitiseEntry, type JournalEntry, type NewEntry } from "./entry";
import type { KV } from "../store/kv";

/** Generous. See the header for why it exists at all. */
export const MAX_ENTRIES = 5000;

const SLOT = {
  key: "journal.entries",
  version: 1,
  fallback: (): JournalEntry[] => [],
  validate: (v: unknown): JournalEntry[] | null => {
    if (!Array.isArray(v)) return null;
    /* Per-entry validation, and a bad row is DROPPED rather than failing the
       whole read. One corrupt entry must not cost somebody their entire
       trading record — which is exactly what returning null here would do. */
    const out: JournalEntry[] = [];
    for (const raw of v) {
      const e = sanitiseEntry(raw);
      if (e !== null) out.push(e);
    }
    return out;
  },
};

export interface Journal {
  readonly entries: Signal<readonly JournalEntry[]>;
  /** Newest first, which is how anyone reads a journal. */
  recent(limit?: number): readonly JournalEntry[];
  forSetup(kind: string | null): readonly JournalEntry[];
  open(): readonly JournalEntry[];
  add(entry: NewEntry): JournalEntry;
  /** Record the exit. Returns the updated entry, or null if the id is unknown. */
  close(id: string, exit: number, closedAt?: number): JournalEntry | null;
  update(id: string, patch: Partial<JournalEntry>): JournalEntry | null;
  remove(id: string): void;
  /** Import entries, skipping ids already present. Returns how many landed. */
  merge(incoming: readonly JournalEntry[]): number;
  /** Why the last write failed, or empty. Surfaced rather than swallowed. */
  readonly lastError: Signal<string>;
}

let counter = 0;

/**
 * Entry ids.
 *
 * Time plus a counter rather than a random string: two entries created in the
 * same millisecond must not collide, and an id that sorts by creation time
 * makes a corrupted store readable by eye. Not a UUID because nothing here is
 * distributed — `store/sync.ts` merges by id and would treat a duplicate as
 * the same trade, which is the correct behaviour for a re-import.
 */
function makeId(at: number): string {
  counter = (counter + 1) % 100000;
  return `j${at.toString(36)}-${counter.toString(36)}`;
}

export function createJournal(kv: KV, now: () => number = Date.now): Journal {
  const entries = signal<readonly JournalEntry[]>(kv.read(SLOT).value);
  const lastError = signal("");

  const persist = (next: readonly JournalEntry[]): void => {
    const trimmed = evict(next);
    entries.set(trimmed);
    const res = kv.write(SLOT, [...trimmed]);
    /* Surfaced, not swallowed. A journal that silently stops saving is worse
       than no journal: you keep filing trades into it and find out months
       later that the record is not there. */
    lastError.set(res.ok ? "" : `Journal not saved — ${res.error}`);
  };

  return {
    entries,
    lastError,

    recent(limit = 50) {
      return [...entries.peek()].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit);
    },

    forSetup(kind) {
      return entries.peek().filter((e) => (e.setupKind ?? null) === kind);
    },

    open() {
      return entries.peek().filter((e) => e.exit === null);
    },

    add(entry) {
      const at = entry.openedAt || now();
      const made: JournalEntry = {
        closedAt: null,
        exit: null,
        ...entry,
        id: makeId(at),
        openedAt: at,
      };
      persist([...entries.peek(), made]);
      return made;
    },

    close(id, exit, closedAt) {
      const list = entries.peek();
      const found = list.find((e) => e.id === id);
      if (found === undefined) return null;
      const updated: JournalEntry = { ...found, exit, closedAt: closedAt ?? now() };
      persist(list.map((e) => (e.id === id ? updated : e)));
      return updated;
    },

    update(id, patch) {
      const list = entries.peek();
      const found = list.find((e) => e.id === id);
      if (found === undefined) return null;
      /* `id` and `openedAt` are not patchable. Letting either move would break
         the eviction order and the sync join at once. */
      const updated: JournalEntry = { ...found, ...patch, id: found.id, openedAt: found.openedAt };
      persist(list.map((e) => (e.id === id ? updated : e)));
      return updated;
    },

    remove(id) {
      persist(entries.peek().filter((e) => e.id !== id));
    },

    merge(incoming) {
      const have = new Set(entries.peek().map((e) => e.id));
      const fresh = incoming.filter((e) => !have.has(e.id));
      if (fresh.length === 0) return 0;
      persist([...entries.peek(), ...fresh]);
      return fresh.length;
    },
  };
}

/**
 * Drop the oldest CLOSED entries until the book fits.
 *
 * Open positions are never evicted — see the header. If the book is over the
 * cap on open positions alone, everything is kept and the cap is exceeded,
 * because losing the record of a live trade is worse than a large write.
 */
function evict(list: readonly JournalEntry[]): readonly JournalEntry[] {
  if (list.length <= MAX_ENTRIES) return list;
  const open = list.filter((e) => e.exit === null);
  const closed = list
    .filter((e) => e.exit !== null)
    .sort((a, b) => a.openedAt - b.openedAt);
  const room = Math.max(0, MAX_ENTRIES - open.length);
  const kept = closed.slice(closed.length - room);
  return [...kept, ...open].sort((a, b) => a.openedAt - b.openedAt);
}
