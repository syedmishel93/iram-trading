/**
 * WHAT THIS TERMINAL HOLDS.
 *
 * Twenty-one of the thirty-four stored slots are not settings — they are data
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
import { clearPlan, inventory } from "../src/settings/holdings";
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
