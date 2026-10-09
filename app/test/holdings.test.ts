/**
 * WHAT THIS TERMINAL HOLDS.
 *
 * Thirty of the forty-two stored slots are not settings — they are data
 * the product accumulated: your alerts, your drawings, the claims ledger, the
 * journal notes, the rules the search found. Putting those in Settings as
 * controls would be a category error. What they need is a place to be seen,
 * sized, exported and cleared, and until now that existed for bars and for
 * nothing in the key-value store.
 *
 * Pure functions over a store handed in, so the arithmetic is testable without
 * a DOM and the real store cannot be reached by accident — a rule broken six
 * times in this repository through three different doors.
 */

import { describe, expect, it } from "vitest";
import { STATE_KEYS, clearPlan, exportable, inventory, type Holding } from "../src/settings/holdings";
import { entriesOfKind } from "../src/settings/registry";
import { createKV, memoryRawStore, type KV } from "../src/store/kv";
import { DRAWINGS_SLOT } from "../src/draw/store";
import { ALERT_BOOK_SLOT } from "../src/alert/store";
import { ACCOUNT_SLOT } from "../src/core/account";

const kvWith = (seed: Record<string, string> = {}): KV => createKV(memoryRawStore(seed));

/** The store namespaces its keys; a raw seed has to carry the prefix. */
const raw = (key: string, body: unknown): Record<string, string> => ({
  [`iram:${key}`]: JSON.stringify({ v: 1, value: body }),
});

describe("the inventory", () => {
  it("LISTS ONLY ACCUMULATED STATE — a preference has a home already", () => {
    const rows = inventory(kvWith());
    expect(rows).toHaveLength(entriesOfKind("state").length);
    expect(rows.some((h) => h.key === ACCOUNT_SLOT.key)).toBe(false);
  });

  it("NEVER LISTS A SECRET, so it can never reach an export", () => {
    const keys = inventory(kvWith()).map((h) => h.key);
    for (const e of entriesOfKind("secret")) expect(keys).not.toContain(e.key);
  });

  it("SIZES WHAT IS STORED, and reports nothing stored as nothing", () => {
    const stored = inventory(kvWith(raw(ALERT_BOOK_SLOT.key, [{ id: "a" }])));
    const row = stored.find((h) => h.key === ALERT_BOOK_SLOT.key);
    expect(row?.bytes).toBeGreaterThan(0);
    expect(row?.held).toBe(true);

    const empty = inventory(kvWith()).find((h) => h.key === ALERT_BOOK_SLOT.key);
    expect(empty?.bytes).toBe(0);
    expect(empty?.held).toBe(false);
  });

  it("SAYS UNREADABLE RATHER THAN ZERO when the stored value fails its own validate", () => {
    /* Zero bytes reads as "nothing stored". This is "something is stored and I
       cannot read it", which is a different thing to do about — and the
       difference is the whole reason a size alone is not enough. */
    const row = inventory(kvWith(raw(DRAWINGS_SLOT.key, "not an array")))
      .find((h) => h.key === DRAWINGS_SLOT.key);
    expect(row?.held).toBe(true);
    expect(row?.bytes).toBeGreaterThan(0);
    expect(row?.readable).toBe(false);
    expect(row?.why).toMatch(/\w{4,}/);
  });

  it("REFUSES TO CLAIM READABILITY IT CANNOT CHECK", () => {
    /* Six slots are declared inside functions, so no validator is reachable
       from here. `null` is the honest answer — not `true`, which would be a
       claim nobody verified. */
    const rows = inventory(kvWith(raw("screener.watch", { sort: "x" })));
    const row = rows.find((h) => h.key === "screener.watch");
    expect(row?.readable).toBeNull();
    expect(row?.why).toMatch(/\w{4,}/);
  });

  it("gives every row a label and a sentence, never a bare key", () => {
    for (const h of inventory(kvWith())) {
      expect(h.label.length).toBeGreaterThan(2);
      expect(h.what.length).toBeGreaterThan(12);
      expect(h.label).not.toBe(h.key);
    }
  });
});

describe("the clear plan", () => {
  it("NAMES EVERY SLOT IT WILL EMPTY, by label", () => {
    /* A bulk action that reports a count instead of the things it will destroy
       is how somebody clears more than they meant to. */
    const plan = clearPlan([ALERT_BOOK_SLOT.key, DRAWINGS_SLOT.key]);
    expect(plan.labels).toHaveLength(2);
    expect(plan.labels.every((l) => l.length > 3)).toBe(true);
    expect(plan.unknown).toEqual([]);
  });

  it("REFUSES A KEY IT DOES NOT KNOW rather than clearing something else", () => {
    const plan = clearPlan(["not.a.slot"]);
    expect(plan.labels).toEqual([]);
    expect(plan.unknown).toEqual(["not.a.slot"]);
  });

  it("REFUSES A PREFERENCE OR A SECRET, even if one is asked for by key", () => {
    /* The view never offers them, so a key arriving here is a caller bug or a
       crafted id — either way, clearing the account or the credential because
       somebody passed its key is not something this should be able to do. */
    const plan = clearPlan([ACCOUNT_SLOT.key, "agent.credential"]);
    expect(plan.labels).toEqual([]);
    expect(plan.unknown).toHaveLength(2);
  });
});

describe("a holding whose bytes will not parse", () => {
  /* Not "fails its own validate" — that case was already covered and already
     correct. This is TEXT THAT IS NOT JSON, which is what a truncated write or
     a disk fault leaves behind, and it is the case the card erased. */
  const corrupt = (key: string): KV => createKV(memoryRawStore({ [`iram:${key}`]: "{not json" }));

  it("REPORTS ITS REAL SIZE, not zero", () => {
    /* MEASURED before the fix: bytes 0, which `size()` draws as an em dash —
       the same mark the card uses for "nothing stored". `inventory` sized
       through `rawEnvelope`, which parses; parsing set the value aside and
       removed the key, so the figure described what was left rather than what
       was there. Sizing must be readable from the outside of the value. */
    const row = inventory(corrupt(ALERT_BOOK_SLOT.key)).find((h) => h.key === ALERT_BOOK_SLOT.key);
    expect(row?.bytes, "a corrupt holding reported as occupying nothing").toBeGreaterThan(0);
    expect(row?.readable).toBe(false);
  });

  it("AGREES WITH THE STORE'S OWN FIGURE for the same key", () => {
    /* `kv.stats()` already reports this quantity. Two surfaces in one product
       reporting one quantity differently is the disagreement this branch
       exists to remove — and the old figure, taken from a re-serialised
       envelope with the key omitted, was out by about half. */
    const kv = createKV(memoryRawStore(raw(ALERT_BOOK_SLOT.key, [{ id: "a", note: "x".repeat(200) }])));
    const row = inventory(kv).find((h) => h.key === ALERT_BOOK_SLOT.key);
    const fromStats = kv.stats().largest.find((x) => x.key === ALERT_BOOK_SLOT.key);
    expect(row?.bytes).toBe(fromStats?.bytes);
  });

  it("DOES NOT CALL IT NOTHING ON THE SECOND LOOK", () => {
    /* The render that found the corrupt value set it aside, which removes the
       live key — so the NEXT render found nothing and said "Nothing stored
       yet." about data that existed a moment earlier and still exists, set
       aside, a few keys away. "Could not read it" and "there was never
       anything" must not render the same. */
    const kv = corrupt(ALERT_BOOK_SLOT.key);
    const first = inventory(kv).find((h) => h.key === ALERT_BOOK_SLOT.key);
    expect(first?.readable).toBe(false);

    const again = inventory(kv).find((h) => h.key === ALERT_BOOK_SLOT.key);
    expect(again?.why, "a set-aside holding reported as never stored").not.toMatch(/nothing stored/i);
    expect(again?.readable, "a set-aside holding reported as unchecked").toBe(false);
    expect(again?.bytes, "the set-aside bytes stopped being counted").toBeGreaterThan(0);
  });

  it("LEAVES A HEALTHY HOLDING ALONE", () => {
    /* The guard against over-reach: a store with no quarantine rows must not
       pick up another key's set-aside copies, and a readable holding must not
       be described as unreadable because a NEIGHBOUR was. */
    const kv = createKV(memoryRawStore({
      ...raw(DRAWINGS_SLOT.key, []),
      [`iram:${ALERT_BOOK_SLOT.key}`]: "{not json",
    }));
    inventory(kv);
    const row = inventory(kv).find((h) => h.key === DRAWINGS_SLOT.key);
    expect(row?.readable).toBe(true);
    expect(row?.why).toMatch(/read/i);
  });
});

describe("the order and the export rule, as arithmetic", () => {
  it("NAMES WHAT IT WILL EMPTY IN THE SAME ORDER EVERY TIME", () => {
    /* It returned the order the keys arrived in — the order the operator
       happened to tick the boxes — while its own doc said registry order.
       These labels ARE the sentence on a destructive confirmation, so the same
       selection has to read the same way every time it is made. */
    const a = clearPlan([DRAWINGS_SLOT.key, ALERT_BOOK_SLOT.key]);
    const b = clearPlan([ALERT_BOOK_SLOT.key, DRAWINGS_SLOT.key]);
    expect(a.labels).toEqual(b.labels);
    const order = STATE_KEYS.filter((k) => k === DRAWINGS_SLOT.key || k === ALERT_BOOK_SLOT.key);
    expect(a.labels).toHaveLength(order.length);
  });

  it("COUNTS A KEY ASKED FOR TWICE ONCE", () => {
    /* "This empties Alerts, Alerts." is a sentence that makes somebody stop
       and wonder what it is about to do twice. */
    expect(clearPlan([ALERT_BOOK_SLOT.key, ALERT_BOOK_SLOT.key]).labels).toHaveLength(1);
  });

  it("LISTS EVERY STATE SLOT IN STATE_KEYS, in the order the view renders", () => {
    /* `STATE_KEYS` was exported, documented as the thing that keeps the view
       and the plan in step, and read by nothing — a comment describing a
       mechanism that was not one. This is the reader, and it is the only one
       it needs: it makes "cannot disagree" a checked claim. */
    expect(inventory(kvWith()).map((h) => h.key)).toEqual([...STATE_KEYS]);
  });

  it("REFUSES AN EXPORT ONLY WHERE THE VALUE DID NOT READ", () => {
    /* The export button's one safety rule, which was inlined in a DOM
       expression and so could not be checked. Handing somebody a file that
       fails its own validator is handing them a file they cannot put back,
       and it looks like a backup. */
    const kv = kvWith({ ...raw(ALERT_BOOK_SLOT.key, [{ id: "a" }]), ...raw(DRAWINGS_SLOT.key, "not an array") });
    const rows = inventory(kv);
    const good = rows.find((h) => h.key === ALERT_BOOK_SLOT.key) as Holding;
    const bad = rows.find((h) => h.key === DRAWINGS_SLOT.key) as Holding;
    const empty = inventory(kvWith()).find((h) => h.key === ALERT_BOOK_SLOT.key) as Holding;

    expect(exportable(good)).toBe(true);
    expect(exportable(bad), "a value that failed its own validator was offered as a file").toBe(false);
    expect(exportable(empty), "nothing stored was offered as a file").toBe(false);
  });

  it("STILL OFFERS A HOLDING NOBODY COULD CHECK, and that is the weakest answer here", () => {
    /* `readable === null` passes deliberately: ten state slots carry no
       validator reachable from the registry, and refusing them would remove
       export from a third of the view on the strength of a check nobody ran.
       Pinned so the choice is visible rather than incidental. */
    const unchecked = inventory(kvWith(raw("workspace.layout", { panes: [] })))
      .find((h) => h.key === "workspace.layout") as Holding;
    expect(unchecked.readable).toBeNull();
    expect(exportable(unchecked)).toBe(true);
  });
});
