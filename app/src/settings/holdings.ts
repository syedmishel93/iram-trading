/**
 * WHAT THIS TERMINAL HOLDS, AS ARITHMETIC.
 *
 * Thirty of the forty-two stored slots are not settings. They are data
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
  /**
   * What this holding occupies, as `kv.stats()` measures it: the key counts
   * and a UTF-16 code unit is two bytes. Bytes `kv` has SET ASIDE because they
   * would not parse are included, because they are still on the disk.
   *
   * Measured from the stored text, never from a re-serialised envelope — the
   * previous version's figure understated the real footprint by roughly half
   * and disagreed with the one other place in the product that reports it.
   */
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

/**
 * The bytes `kv` set aside for this key because they would not parse.
 *
 * A quarantine key is `__quarantine:<key>:<when>`, so the key is matched with
 * its colon attached — `split(":")` on an opaque key is how a chain id ends up
 * in an address column, which this repository records. Several passes can set
 * aside several copies; they are all still occupied space.
 */
function setAside(kv: KV, key: string): { rows: number; bytes: number } {
  let rows = 0;
  let bytes = 0;
  for (const q of kv.quarantine()) {
    if (!q.key.includes(`__quarantine:${key}:`)) continue;
    rows += 1;
    bytes += (q.key.length + q.raw.length) * 2;
  }
  return { rows, bytes };
}

function readabilityOf(entry: SlotEntry, kv: KV, held: boolean, aside: number): {
  readable: boolean | null;
  why: string;
} {
  if (!held) {
    /* SET ASIDE IS NOT ABSENT. Reading bytes that will not parse moves them to
       a quarantine key and removes the live one — so the render AFTER a
       corrupt holding was found had no live key and said "Nothing stored
       yet." about data that still exists, a few keys away, and that the
       operator may want to recover. "Could not read it" and "there was never
       anything" are different facts. */
    if (aside > 0) {
      return {
        readable: false,
        why:
          aside === 1
            ? "Unreadable, and kept aside rather than deleted. Nothing new has been stored since."
            : `Unreadable on ${aside} occasions, and each copy was kept aside rather than deleted.`,
      };
    }
    return { readable: null, why: "Nothing stored yet." };
  }
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
    /* SIZE FIRST, AND WITHOUT PARSING.
       The previous version sized through `rawEnvelope`, which parses — and
       parsing quarantines bytes that will not parse and removes the key. So
       rendering this card DELETED a corrupt holding, reported it as 0 bytes
       (drawn as an em dash, which reads as "nothing"), took its reason from a
       later read that no longer found anything, and on the next render called
       it "Nothing stored yet." The one case the operator most needs told
       about was the one case the card erased. */
    const bytes = held ? kv.rawBytes(e.key) : 0;
    const aside = setAside(kv, e.key);
    const { readable, why } = readabilityOf(e, kv, held, aside.rows);
    return {
      key: e.key,
      label: e.label,
      what: e.what,
      /* Read BEFORE the readability check and reported as it was found. A
         holding that has just been quarantined is still a holding the
         operator had: `held` says it was there and `readable` says it is
         not, which are two different facts and both are true. */
      held,
      /* Space set aside counts as space. A corrupt holding reporting zero is
         how a disk figure disagrees with the disk. */
      bytes: bytes + aside.bytes,
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
  /* REGISTRY ORDER, WHICH IS WHAT THE DOC ALREADY CLAIMED. It returned the
     order the keys arrived in — the order the operator happened to tick the
     boxes — and these labels are the sentence on a destructive confirmation.
     The same list of slots has to read the same way every time, or the one
     sentence somebody checks before deleting something changes shape between
     attempts. A duplicate key is counted once for the same reason. */
  const wanted = new Set(keys);
  const labels: string[] = [];
  for (const e of entriesOfKind("state")) if (wanted.has(e.key)) labels.push(e.label);
  const unknown: string[] = [];
  for (const k of wanted) if (!clearable.has(k)) unknown.push(k);
  return { labels, unknown };
}

/** Total bytes held, for the one figure the card leads with. */
export function heldBytes(rows: readonly Holding[]): number {
  return rows.reduce((n, h) => n + h.bytes, 0);
}

/**
 * Registry order, so the view and the plan cannot disagree about order.
 *
 * READ BY THE GUARD, which is a real reader and the only one it needs: it is
 * the list `inventory` and `clearPlan` must both produce, and a test comparing
 * them against it is what makes "cannot disagree" a checked claim rather than
 * a sentence in a comment. It was exported, documented as the mechanism, and
 * referenced nowhere — which is this repository's own recorded defect class.
 */
export const STATE_KEYS: readonly string[] = REGISTRY.filter((e) => e.kind === "state").map(
  (e) => e.key,
);

/**
 * Whether this holding may be handed to the operator as a file.
 *
 * THE ONE SAFETY RULE OF THE EXPORT BUTTON, and it was inlined in the DOM, so
 * it could not be checked as arithmetic. Handing somebody a file that fails
 * its own validator is handing them a file they cannot put back, and it looks
 * like a backup.
 *
 * `readable === null` PASSES, deliberately: ten state slots carry no validator
 * reachable from here, so refusing them would remove export from a third of
 * the view on the strength of a check nobody ran. It is the weakest of the
 * three answers and it is recorded as such — see `Holding.readable`.
 */
export function exportable(h: Holding): boolean {
  return h.held && h.readable !== false;
}
