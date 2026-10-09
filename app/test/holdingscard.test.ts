// @vitest-environment jsdom
/**
 * THE HOLDINGS CARD, and the two ways a clear goes wrong.
 *
 * Clearing is the only destructive thing on this card, so the tests are mostly
 * about it: that it names what it will empty rather than counting it, and that
 * the surfaces rendering from a slot are told when it goes.
 */

import { describe, expect, it } from "vitest";
import { createHoldingsCard } from "../src/ui/cards/holdingscard";
import { entriesOfKind } from "../src/settings/registry";
import { createKV, memoryRawStore, type KV } from "../src/store/kv";
import { ALERT_BOOK_SLOT } from "../src/alert/store";

const seeded = (): KV =>
  createKV(
    memoryRawStore({
      [`iram:${ALERT_BOOK_SLOT.key}`]: JSON.stringify({ v: 1, value: [{ id: "a" }] }),
      "iram:drawings.book": JSON.stringify({ v: 1, value: "not an array" }),
    }),
  );

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

describe("the holdings card", () => {
  it("LISTS EVERY STATE SLOT, so nothing stored is invisible", () => {
    const el = createHoldingsCard({ kv: seeded() });
    expect(el.querySelectorAll("[data-slot]")).toHaveLength(entriesOfKind("state").length);
  });

  it("NAMES WHAT A CLEAR WILL EMPTY, before it empties it", async () => {
    /* A bulk action that reports a count is how somebody destroys more than
       they meant. The confirmation carries labels. */
    const el = createHoldingsCard({ kv: seeded() });
    el.querySelector<HTMLInputElement>(`[data-pick="${ALERT_BOOK_SLOT.key}"]`)?.click();
    el.querySelector<HTMLButtonElement>('[data-act="clear"]')?.click();
    await tick();
    const confirm = el.querySelector('[data-confirm]');
    expect(confirm, "no confirmation was shown").not.toBeNull();
    expect(confirm?.textContent).toContain("Alerts");
  });

  it("CLEARS NOTHING UNTIL THE CONFIRMATION IS ANSWERED", async () => {
    const kv = seeded();
    const el = createHoldingsCard({ kv });
    el.querySelector<HTMLInputElement>(`[data-pick="${ALERT_BOOK_SLOT.key}"]`)?.click();
    el.querySelector<HTMLButtonElement>('[data-act="clear"]')?.click();
    await tick();
    expect(kv.keys()).toContain(ALERT_BOOK_SLOT.key);
  });

  it("TELLS THE SURFACES READING A SLOT THAT IT IS GONE", async () => {
    /* Clearing the alert book while the Alerts desk renders from it leaves the
       operator looking at data that no longer exists. */
    const kv = seeded();
    let told = 0;
    const el = createHoldingsCard({ kv, onCleared: () => { told += 1; } });
    el.querySelector<HTMLInputElement>(`[data-pick="${ALERT_BOOK_SLOT.key}"]`)?.click();
    el.querySelector<HTMLButtonElement>('[data-act="clear"]')?.click();
    await tick();
    el.querySelector<HTMLButtonElement>('[data-act="clear-confirm"]')?.click();
    await tick();
    expect(kv.keys()).not.toContain(ALERT_BOOK_SLOT.key);
    expect(told).toBe(1);
  });

  it("OFFERS NO EXPORT FOR A HOLDING IT COULD NOT READ", () => {
    /* Exporting bytes that fail their own validator hands somebody a file that
       cannot be put back. */
    const el = createHoldingsCard({ kv: seeded() });
    const row = el.querySelector('[data-slot="drawings.book"]');
    expect(row?.getAttribute("data-readable")).toBe("false");
    expect(row?.querySelector('[data-act="export"]')).toBeNull();
  });

  it("OFFERS NO CLEAR FOR A SLOT HOLDING NOTHING", () => {
    const el = createHoldingsCard({ kv: seeded() });
    const empty = el.querySelector('[data-slot="today.plan"]');
    expect(empty?.getAttribute("data-held")).toBe("false");
    expect(empty?.querySelector("[data-pick]")).toBeNull();
  });
});
