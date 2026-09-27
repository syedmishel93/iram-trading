/**
 * What the shell remembers between sessions, and how it reads it back.
 *
 * Lifted out of `shell.ts` unchanged. `mountShell` was a single 7,476-line
 * function and the file around it had become the place anything shell-shaped
 * landed; these had no dependency on that closure at all, which is what made
 * them safe to move first and is the test for whatever moves next.
 */

import { untrack, type Signal } from "../../core/signal";
import type { KV } from "../../store/kv";
import { DEFAULT_RULES, sanitiseRules, type GateRules } from "../../setup/rules";

/** The pre-v41 raw key. Read once, so an existing setup carries forward. */
export const LEGACY_PREFS_KEY = "iram.shell.v40";

/**
 * What a preference may hold.
 *
 * `number` joined the union when the volume band became resizable: its height
 * is the first preference that is a measurement rather than a choice. Stored as
 * a number rather than a string so a corrupt value fails validation here
 * instead of arriving at the engine as `NaN` pixels.
 */
/* `null` joined the union with the anchored-VWAP anchor: "no anchor set" is a
   real, storable state, distinct from the key being absent. */
/**
 * What a preference may hold.
 *
 * The nested-record arm is for `studyParams`, which is a map of indicator id →
 * parameter name → number. Widening it to `unknown` would have been less
 * typing and would also have let anything at all into the blob that every
 * boot has to parse; this stays a closed set, and anything new that does not
 * fit one of these arms has to say so here.
 */
export type PrefValue =
  | string
  | number
  | boolean
  | string[]
  | Readonly<Record<string, Readonly<Record<string, number>>>>
  | null;

/**
 * The trading rules, in their own slot.
 *
 * Separate from `shell.prefs` on purpose — see the note on `rules` below.
 */
export const RULES_SLOT = {
  key: "setup.rules",
  version: 1,
  fallback: (): GateRules => DEFAULT_RULES,
  validate: (v: unknown): GateRules | null =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? sanitiseRules(v) : null,
};

/**
 * How a pinned drawing is recognised later.
 *
 * A suffix on the label rather than a new field on `Drawing`: the shape is
 * versioned, sanitised and synced, and adding a field to it to support one
 * button would mean a migration on every stored drawing. A thin space is used
 * so the mark reads as a small annotation on the chart rather than as noise,
 * and it survives export and undo because it is simply part of the text.
 */
export const PIN_MARK = " · auto";

export const PREFS_SLOT = {
  key: "shell.prefs",
  version: 2,
  fallback: (): Record<string, PrefValue> => ({}),
  validate: (v: unknown): Record<string, PrefValue> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, PrefValue>)
      : null,

  /**
   * v1 -> v2: let the news bar's new default reach installs that already exist.
   *
   * WHY A MIGRATION AND NOT JUST A NEW DEFAULT.
   * The default is read as `prefs["newsBar"] !== false`, which sounds like it
   * would pick up anyone who never expressed a preference. It does not: this
   * snapshot is rewritten on EVERY preference save with the current value of
   * every field, so every install that has ever saved anything already holds an
   * explicit `newsBar: false` — written by the old default, not chosen by the
   * operator. A default change alone is invisible to all of them.
   *
   * So the stored `false` is dropped once, and only when it is exactly `false`.
   * A `true` is left alone because it can only have been deliberate, and after
   * this runs any `false` written again IS a choice and survives every future
   * read.
   */
  migrations: {
    1: (value: unknown): unknown => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const prefs = { ...(value as Record<string, PrefValue>) };
      if (prefs["newsBar"] === false) delete prefs["newsBar"];
      return prefs;
    },
  },
};

/**
 * Preferences, out of a bare `JSON.parse` and into the versioned store.
 *
 * The old code caught a parse failure and returned `{}` — which silently reset
 * every preference the user had, with nothing anywhere saying why. The store
 * quarantines the bytes instead, so a corrupt value is recoverable rather than
 * merely survivable.
 */
export function loadPrefs(kv: KV): Record<string, PrefValue> {
  const report = kv.read(PREFS_SLOT);
  if (report.outcome === "hit" || report.outcome === "migrated") return report.value;
  if (report.outcome === "quarantined" || report.outcome === "refused-newer") {
    console.warn(`[iram] ${report.note}`);
    return report.value;
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_PREFS_KEY) ?? "{}") as unknown;
    if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
      const adopted = legacy as Record<string, PrefValue>;
      if (Object.keys(adopted).length > 0) kv.write(PREFS_SLOT, adopted);
      return adopted;
    }
  } catch {
    /* the legacy key is best-effort; the store below is the real one */
  }
  return {};
}

/**
 * A Signal-shaped view over a getter and a setter.
 *
 * `Signal<T>` is a callable with `peek`, `set` and `update` attached, so it
 * cannot be built by spreading — the result would satisfy the type and throw
 * the first time anything called it. Built as a function with the methods
 * assigned instead.
 *
 * `peek` untracks, because that is the entire contract of peek: callers use it
 * precisely to read without registering a dependency.
 */
export function viewSignal(read: () => string, write: (v: string) => void): Signal<string> {
  const fn = (() => read()) as Signal<string>;
  Object.assign(fn, {
    peek: () => untrack(read),
    set: write,
    update: (f: (prev: string) => string) => write(f(untrack(read))),
  });
  return fn;
}

/** The same wrapper for a boolean channel. */
/**
 * Whether an unsearched market is swept without being asked.
 *
 * ON by default: the owner was shown what a sweep costs (twenty to thirty
 * seconds of eighty-five studies, and possibly a backfill first) and chose
 * automatic-once-per-market over a button. Its own slot rather than a field in
 * `PREFS_SLOT`, so turning it off survives any future migration of the layout
 * preferences it has nothing to do with.
 */
export const AUTO_SEARCH_SLOT = {
  key: "autosearch",
  version: 1,
  fallback: (): boolean => true,
  validate: (v: unknown): boolean | null => (typeof v === "boolean" ? v : null),
};

export function boolSignal(read: () => boolean, write: (v: boolean) => void): Signal<boolean> {
  const fn = (() => read()) as Signal<boolean>;
  Object.assign(fn, {
    peek: () => untrack(read),
    set: write,
    update: (f: (prev: boolean) => boolean) => write(f(untrack(read))),
  });
  return fn;
}
