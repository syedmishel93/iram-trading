/**
 * WHAT THIS TERMINAL HOLDS, AS ARITHMETIC.
 *
 * Twenty-one of the thirty-four stored slots are not settings. They are data
 * the product accumulated — alerts, drawings, the claims ledger, journal
 * notes, the rules the search found — and the right surface for them is not a
 * settings control but a holdings view: what is here, how big it is, take a
 * copy, throw it away.
 *
 * PURE OVER A STORE HANDED IN. Nothing here reaches the real one, which is the
 * rule this repository has broken six times through three different doors —
 * four test files missing an env var, a history client defaulting to the live
 * bars route, and a backup transport defaulting to the live one. A default
 * that is inert cannot be reached by a test that does not know it exists.
 *
 * It is also why the sizing and the clear plan are functions over an
 * inventory rather than methods on a card: the four rules that matter are
 * checkable as arithmetic instead of as DOM.
 */

import type { KV } from "../store/kv";
import { REGISTRY, entriesOfKind, type SlotEntry } from "./registry";

export interface Holding {
  readonly key: string;
  readonly label: string;
  readonly what: string;
  /** Whether anything is stored under this key at all. */
  readonly held: boolean;
  /** Bytes of the stored envelope. Zero when nothing is held. */
  readonly bytes: number;
  /** Epoch ms of the last write, or null if never written. */
  readonly touchedAt: number | null;
  /**
   * Whether the stored value passes its own validator.
   *
   * `null` IS A REAL ANSWER AND NOT A DEFAULT. Six slots are declared inside
   * functions, so no validator is reachable from here; claiming `true` for
   * those would be a claim nobody checked. A module that refuses rather than
   * approximates is the house rule, and this is where it lands.
   */
  readonly readable: boolean | null;
  /** One line a person can act on. Never empty. */
  readonly why: string;
}

export interface ClearPlan {
  /** Labels of the slots that would be emptied, in registry order. */
  readonly labels: readonly string[];
  /** Keys that name nothing clearable — refused, never guessed at. */
  readonly unknown: readonly string[];
}

function readabilityOf(entry: SlotEntry, kv: KV, held: boolean): {
  readable: boolean | null;
  why: string;
} {
  if (!held) return { readable: null, why: "Nothing stored yet." };
  if (entry.slot === undefined) {
    return {
      readable: null,
      why: "Stored, and its size is exact. Whether it still reads is checked where it is used.",
    };
  }
  const report = kv.read(entry.slot);
  if (report.outcome === "quarantined") {
    return { readable: false, why: `Stored but unreadable, and kept aside: ${report.note}` };
  }
  if (report.outcome === "refused-newer") {
    return { readable: false, why: "Written by a newer build than this one, so it is left alone." };
  }
  if (report.outcome === "default") {
    return {
      readable: false,
      why: "Stored, but it does not match the shape this build expects, so the default is in use.",
    };
  }
  return {
    readable: true,
    why: report.outcome === "migrated" ? "Read, after being brought up to date." : "Read normally.",
  };
}

/**
 * Every `state` slot, with what is actually stored under it.
 *
 * `preference` has a home in Settings; `secret` is never listed, so it can
 * never reach an export; `legacy` is migration machinery rather than something
 * the operator keeps.
 */
export function inventory(kv: KV): readonly Holding[] {
  const present = new Set(kv.keys());
  return entriesOfKind("state").map((e): Holding => {
    const held = present.has(e.key);
    const env = held ? kv.rawEnvelope(e.key) : null;
    const { readable, why } = readabilityOf(e, kv, held);
    return {
      key: e.key,
      label: e.label,
      what: e.what,
      held,
      bytes: env === null ? 0 : JSON.stringify(env).length,
      touchedAt: kv.touchedAt(e.key),
      readable,
      why,
    };
  });
}

/**
 * What clearing these keys would actually empty.
 *
 * NAMES, NOT A COUNT. "Clear 4 items" is how somebody destroys something they
 * did not mean to; this repository already records a bulk delete that had to
 * return the skipped ROWS rather than how many, for the same reason.
 *
 * A key that is not a clearable holding is REFUSED rather than ignored. Only
 * `state` can be cleared here: a preference belongs in Settings and a secret
 * must not be removable by passing its key to a list.
 */
export function clearPlan(keys: readonly string[]): ClearPlan {
  const clearable = new Map(entriesOfKind("state").map((e) => [e.key, e.label]));
  const labels: string[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const label = clearable.get(k);
    if (label === undefined) unknown.push(k);
    else labels.push(label);
  }
  return { labels, unknown };
}

/** Total bytes held, for the one figure the card leads with. */
export function heldBytes(rows: readonly Holding[]): number {
  return rows.reduce((n, h) => n + h.bytes, 0);
}

/** Registry order, so the view and the plan cannot disagree about order. */
export const STATE_KEYS: readonly string[] = REGISTRY.filter((e) => e.kind === "state").map(
  (e) => e.key,
);
