/**
 * The settings store — everything small, durable and structured.
 *
 * WHAT WAS WRONG WITH RAW localStorage
 * Two call sites, two ad-hoc keys, `JSON.parse` inside a try/catch that
 * returned `{}` on failure. That works right up until the shape changes, and
 * then it fails in the worst available way: a value written by v40 is read by
 * v41, does not match, and is silently discarded. The user's alert book
 * disappears and nothing anywhere says why.
 *
 * FOUR PROPERTIES THIS ADDS
 *
 * 1. **Every record carries its version.** A reader that meets an older shape
 *    MIGRATES it. A reader that meets a NEWER shape — you opened an old build —
 *    refuses to touch it rather than overwriting next month's settings with
 *    this month's defaults. Downgrade is the case everyone forgets and it is
 *    the one that destroys data.
 *
 * 2. **Corrupt values are quarantined, not deleted.** A value that will not
 *    parse is moved aside under a `__quarantine` key and reported. The default
 *    is used so the terminal still boots, but the bytes are still there to
 *    recover by hand. Deleting the only copy of something you could not read is
 *    not error handling.
 *
 * 3. **Quota is a first-class outcome.** localStorage is ~5MB and throws
 *    `QuotaExceededError` on write. Writes return a result rather than throwing,
 *    so a caller can degrade instead of dying mid-render.
 *
 * 4. **Changes are observable, including from other tabs.** Two terminal
 *    windows on the same machine used to silently fight over the alert book,
 *    last-writer-wins with no indication. Now a change in one is seen by the
 *    other.
 *
 * This is NOT where bars go. Bars are Float64 columns in IndexedDB
 * (`barstore.ts`); putting a 40k-bar series through `JSON.stringify` into a 5MB
 * key-value store is how a terminal freezes for two seconds on every write.
 */

export interface Envelope<T> {
  /** Schema version of `value`. */
  v: number;
  /** Epoch ms of the last write. Drives sync conflict resolution. */
  at: number;
  value: T;
}

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "quota" | "unavailable" | "newer-on-disk"; error: string };

export type ReadOutcome = "hit" | "default" | "migrated" | "quarantined" | "refused-newer";

export interface ReadReport<T> {
  value: T;
  outcome: ReadOutcome;
  /** Version found on disk, when there was one. */
  foundVersion: number | null;
  note: string;
}

/** A migration from version `from` to `from + 1`. */
export type Migration = (value: unknown) => unknown;

export interface Slot<T> {
  key: string;
  version: number;
  fallback: () => T;
  /** Returns the value, or null if the stored shape is not usable. */
  validate: (value: unknown) => T | null;
  /** `migrations[n]` upgrades a v`n` value to v`n+1`. */
  migrations?: Record<number, Migration>;
}

/** The storage primitive, narrowed so tests need no DOM. */
export interface RawStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function memoryRawStore(seed: Record<string, string> = {}): RawStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/**
 * localStorage, or a memory store when it is unavailable.
 *
 * Private windows, embedded webviews and locked-down enterprise profiles all
 * throw on ACCESS, not just on write, so the probe is a real write. Falling
 * back to memory keeps the terminal usable for the session — settings simply do
 * not survive a reload, which is a far smaller failure than refusing to start.
 */
export function browserRawStore(): RawStore {
  return browserRawStoreProbed().store;
}

export interface RawStoreProbe {
  readonly store: RawStore;
  /**
   * False when the fallback was taken. It is NOT a promise that writes survive
   * a reload — localStorage can accept a write and still discard it on a
   * `file://` page — only that the store did not refuse us outright.
   * `store/durability.ts` is what turns this into an answer the user can act on.
   */
  readonly canPersist: boolean;
}

/**
 * The same store, plus whether we had to fall back.
 *
 * Split out because the fallback used to be invisible: `browserRawStore` caught
 * the throw, returned memory, and told nobody. Every preference then reset on
 * every reload, which reaches the user as "the symbol keeps going back to
 * BTCUSDT" with nothing on screen connecting the two.
 */
export function browserRawStoreProbed(): RawStoreProbe {
  try {
    const probe = "__iram_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return { store: localStorage, canPersist: true };
  } catch {
    return { store: memoryRawStore(), canPersist: false };
  }
}

export interface KVStats {
  keys: number;
  bytes: number;
  quarantined: number;
  /** Bytes per key, largest first. */
  largest: Array<{ key: string; bytes: number }>;
}

export interface KV {
  read<T>(slot: Slot<T>): ReadReport<T>;
  /** Convenience: the value only. */
  get<T>(slot: Slot<T>): T;
  write<T>(slot: Slot<T>, value: T, at?: number): WriteResult;
  /** Epoch ms of the last write to this slot, or null. */
  touchedAt(key: string): number | null;
  remove(key: string): void;
  /** Every namespaced key currently held, without the prefix. */
  keys(): string[];
  /** Raw envelope, for sync and export. Never migrates. */
  rawEnvelope(key: string): Envelope<unknown> | null;
  /** Write a raw envelope, for sync and import. Refuses to go backwards. */
  putEnvelope(key: string, env: Envelope<unknown>): WriteResult;
  stats(): KVStats;
  /** Fires on any local write, and on writes from other tabs. */
  subscribe(fn: (key: string) => void): () => void;
  quarantine(): Array<{ key: string; raw: string }>;
  clearQuarantine(): void;
}

const PREFIX = "iram:";
const QUARANTINE = "iram:__quarantine:";

export function createKV(raw: RawStore = browserRawStore(), now: () => number = Date.now): KV {
  const listeners = new Set<(key: string) => void>();
  const fire = (key: string): void => {
    for (const fn of [...listeners]) {
      try {
        fn(key);
      } catch {
        // A broken subscriber must not stop the others, and must not make a
        // successful write look like a failed one.
      }
    }
  };

  // Cross-tab. `storage` fires in OTHER documents only, which is exactly the
  // case local `fire()` cannot cover.
  let detachStorage: (() => void) | null = null;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onStorage = (e: StorageEvent): void => {
      if (e.key && e.key.startsWith(PREFIX)) fire(e.key.slice(PREFIX.length));
    };
    window.addEventListener("storage", onStorage);
    detachStorage = () => window.removeEventListener("storage", onStorage);
  }
  void detachStorage;

  const quarantineValue = (key: string, text: string, why: string): void => {
    try {
      raw.setItem(`${QUARANTINE}${key}:${now()}`, JSON.stringify({ why, raw: text }));
      raw.removeItem(`${PREFIX}${key}`);
    } catch {
      // If we cannot even set the quarantine record, leave the original in
      // place. Removing it would destroy the only copy.
    }
  };

  /**
   * Read and validate one envelope.
   *
   * `report` exists because quarantining REMOVES the original key, so a caller
   * that afterwards asks "was there something here?" is told no — and reports
   * "nothing stored yet" for a value it just moved aside. Telling the user
   * their settings were never there, when they were quarantined a microsecond
   * ago, is exactly the silent-loss message this module exists to prevent.
   */
  const parse = (key: string, report?: { quarantined: boolean }): Envelope<unknown> | null => {
    const text = raw.getItem(`${PREFIX}${key}`);
    if (text === null) return null;
    try {
      const obj = JSON.parse(text) as unknown;
      if (
        obj !== null &&
        typeof obj === "object" &&
        typeof (obj as Envelope<unknown>).v === "number" &&
        "value" in (obj as Envelope<unknown>)
      ) {
        const env = obj as Envelope<unknown>;
        return { v: env.v, at: typeof env.at === "number" ? env.at : 0, value: env.value };
      }
      // A bare value from before envelopes existed. Adopt it as v1 rather than
      // discarding it — this is the upgrade path from the old raw keys.
      return { v: 1, at: 0, value: obj };
    } catch (err) {
      quarantineValue(key, text, err instanceof Error ? err.message : "unparseable");
      if (report) report.quarantined = true;
      return null;
    }
  };

  const store: KV = {
    read<T>(slot: Slot<T>): ReadReport<T> {
      const report = { quarantined: false };
      const env = parse(slot.key, report);
      if (env === null) {
        return {
          value: slot.fallback(),
          outcome: report.quarantined ? "quarantined" : "default",
          foundVersion: null,
          note: report.quarantined
            ? `"${slot.key}" could not be parsed; the bytes were moved to quarantine and the default is in use.`
            : "nothing stored yet",
        };
      }

      if (env.v > slot.version) {
        // Written by a NEWER build. Read-only from here: this build does not
        // know the shape, and writing over it would destroy settings the user
        // will get back the moment they reopen the newer build.
        return {
          value: slot.fallback(),
          outcome: "refused-newer",
          foundVersion: env.v,
          note: `"${slot.key}" was written by a newer version (v${env.v} > v${slot.version}). Left untouched; running on defaults.`,
        };
      }

      let value: unknown = env.value;
      let migrated = false;
      for (let v = env.v; v < slot.version; v++) {
        const step = slot.migrations?.[v];
        if (!step) {
          return {
            value: slot.fallback(),
            outcome: "default",
            foundVersion: env.v,
            note: `"${slot.key}" is v${env.v} and no migration to v${v + 1} exists; using defaults.`,
          };
        }
        try {
          value = step(value);
          migrated = true;
        } catch (err) {
          return {
            value: slot.fallback(),
            outcome: "default",
            foundVersion: env.v,
            note: `migrating "${slot.key}" v${v} -> v${v + 1} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }

      const valid = slot.validate(value);
      if (valid === null) {
        return {
          value: slot.fallback(),
          outcome: "default",
          foundVersion: env.v,
          note: `"${slot.key}" did not match the expected shape; using defaults.`,
        };
      }

      if (migrated) store.write(slot, valid, env.at);
      return {
        value: valid,
        outcome: migrated ? "migrated" : "hit",
        foundVersion: env.v,
        note: migrated ? `migrated v${env.v} -> v${slot.version}` : "",
      };
    },

    get<T>(slot: Slot<T>): T {
      return store.read(slot).value;
    },

    write<T>(slot: Slot<T>, value: T, at?: number): WriteResult {
      const existing = parse(slot.key);
      if (existing !== null && existing.v > slot.version) {
        return {
          ok: false,
          reason: "newer-on-disk",
          error: `"${slot.key}" on disk is v${existing.v}, newer than this build's v${slot.version}`,
        };
      }
      const env: Envelope<T> = { v: slot.version, at: at ?? now(), value };
      try {
        raw.setItem(`${PREFIX}${slot.key}`, JSON.stringify(env));
        fire(slot.key);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const quota = /quota|exceeded|NS_ERROR_DOM_QUOTA/i.test(msg) || (err as DOMException)?.name === "QuotaExceededError";
        return {
          ok: false,
          reason: quota ? "quota" : "unavailable",
          error: quota
            ? `browser storage is full (~5MB). "${slot.key}" was not saved. Clear old data from the Data desk.`
            : msg,
        };
      }
    },

    touchedAt(key) {
      return parse(key)?.at ?? null;
    },

    remove(key) {
      raw.removeItem(`${PREFIX}${key}`);
      fire(key);
    },

    keys() {
      const out: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const k = raw.key(i);
        if (k && k.startsWith(PREFIX) && !k.startsWith(QUARANTINE)) out.push(k.slice(PREFIX.length));
      }
      return out.sort();
    },

    rawEnvelope(key) {
      return parse(key);
    },

    putEnvelope(key, env) {
      const existing = parse(key);
      // Sync must never move a record backwards in time. Without this a slow
      // remote push lands after a local edit and silently reverts it.
      if (existing !== null && existing.at > env.at) {
        return {
          ok: false,
          reason: "newer-on-disk",
          error: `local "${key}" is newer (${new Date(existing.at).toISOString()})`,
        };
      }
      try {
        raw.setItem(`${PREFIX}${key}`, JSON.stringify(env));
        fire(key);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: /quota/i.test(msg) ? "quota" : "unavailable", error: msg };
      }
    },

    stats() {
      let bytes = 0;
      let quarantined = 0;
      const sizes: Array<{ key: string; bytes: number }> = [];
      for (let i = 0; i < raw.length; i++) {
        const k = raw.key(i);
        if (!k || !k.startsWith(PREFIX)) continue;
        const text = raw.getItem(k) ?? "";
        // UTF-16 in every engine that implements the spec.
        const size = (k.length + text.length) * 2;
        if (k.startsWith(QUARANTINE)) {
          quarantined++;
          bytes += size;
          continue;
        }
        bytes += size;
        sizes.push({ key: k.slice(PREFIX.length), bytes: size });
      }
      sizes.sort((a, b) => b.bytes - a.bytes);
      return { keys: sizes.length, bytes, quarantined, largest: sizes.slice(0, 10) };
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    quarantine() {
      const out: Array<{ key: string; raw: string }> = [];
      for (let i = 0; i < raw.length; i++) {
        const k = raw.key(i);
        if (k && k.startsWith(QUARANTINE)) out.push({ key: k, raw: raw.getItem(k) ?? "" });
      }
      return out;
    },

    clearQuarantine() {
      for (const { key } of store.quarantine()) raw.removeItem(key);
    },
  };

  return store;
}

// ------------------------------------------------------------------ slots --

/** Anything JSON round-trips. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A slot for a plain record of primitives — the shape the shell's UI state and
 * most preferences take.
 */
export function recordSlot(key: string, version = 1): Slot<Record<string, unknown>> {
  return {
    key,
    version,
    fallback: () => ({}),
    validate: (v) => (isRecord(v) ? v : null),
  };
}

/** A slot for a list, with per-item validation so one bad row drops out alone. */
export function listSlot<T>(
  key: string,
  version: number,
  isItem: (v: unknown) => v is T,
  migrations?: Record<number, Migration>,
): Slot<T[]> {
  return {
    key,
    version,
    fallback: () => [],
    // A half-written entry must drop out; it must not take the whole book with
    // it. This is why validation is per item and not on the array.
    validate: (v) => (Array.isArray(v) ? v.filter(isItem) : null),
    ...(migrations ? { migrations } : {}),
  };
}
