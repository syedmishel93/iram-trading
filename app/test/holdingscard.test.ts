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
    const { el } = createHoldingsCard({ kv: seeded() });
    expect(el.querySelectorAll("[data-slot]")).toHaveLength(entriesOfKind("state").length);
  });

  it("NAMES WHAT A CLEAR WILL EMPTY, before it empties it", async () => {
    /* A bulk action that reports a count is how somebody destroys more than
       they meant. The confirmation carries labels. */
    const { el } = createHoldingsCard({ kv: seeded() });
    el.querySelector<HTMLInputElement>(`[data-pick="${ALERT_BOOK_SLOT.key}"]`)?.click();
    el.querySelector<HTMLButtonElement>('[data-act="clear"]')?.click();
    await tick();
    const confirm = el.querySelector('[data-confirm]');
    expect(confirm, "no confirmation was shown").not.toBeNull();
    expect(confirm?.textContent).toContain("Alerts");
  });

  it("CLEARS NOTHING UNTIL THE CONFIRMATION IS ANSWERED", async () => {
    const kv = seeded();
    const { el } = createHoldingsCard({ kv });
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
    const { el } = createHoldingsCard({ kv, onCleared: () => { told += 1; } });
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
    const { el } = createHoldingsCard({ kv: seeded() });
    const row = el.querySelector('[data-slot="drawings.book"]');
    expect(row?.getAttribute("data-readable")).toBe("false");
    expect(row?.querySelector('[data-act="export"]')).toBeNull();
  });

  it("OFFERS NO CLEAR FOR A SLOT HOLDING NOTHING", () => {
    const { el } = createHoldingsCard({ kv: seeded() });
    const empty = el.querySelector('[data-slot="today.plan"]');
    expect(empty?.getAttribute("data-held")).toBe("false");
    expect(empty?.querySelector("[data-pick]")).toBeNull();
  });
});

describe("the holdings card after it has been used", () => {
  it("TELLS THE CALLER WHAT ACTUALLY WENT", () => {
    /* C4. Clearing did not stick: `onCleared` was built, tested, and never
       passed by the one production caller, and only four of the owning modules
       subscribe to the store. The rest read once into a signal and write the
       whole signal back on any change — so clearing the alert book and then
       dismissing one alert wrote the full stale book straight back, with
       nothing on screen saying the clear had been undone.

       The keys matter, not just the fact: a refusal reported as a deletion is
       a bulk action silently doing less than it says. */
    const kv = seeded();
    const told: string[][] = [];
    const { el } = createHoldingsCard({ kv, onCleared: (keys) => void told.push([...keys]) });

    const pick = el.querySelector(`[data-pick="${ALERT_BOOK_SLOT.key}"]`) as HTMLInputElement;
    pick.click();
    (el.querySelector('[data-act="clear"]') as HTMLElement).click();
    (el.querySelector('[data-act="clear-confirm"]') as HTMLElement).click();

    expect(told, "the caller was not told anything was cleared").toHaveLength(1);
    expect(told[0]).toEqual([ALERT_BOOK_SLOT.key]);
    expect(kv.keys()).not.toContain(ALERT_BOOK_SLOT.key);
  });

  it("SAYS THE TERMINAL WILL RELOAD, before anything is deleted", () => {
    /* The reload IS the re-seed for the five owning stores that do not
       subscribe. An unannounced reload is a surprise; an unannounced
       resurrection of the data is worse. The sentence is the promise. */
    const { el } = createHoldingsCard({ kv: seeded() });
    (el.querySelector(`[data-pick="${ALERT_BOOK_SLOT.key}"]`) as HTMLInputElement).click();
    (el.querySelector('[data-act="clear"]') as HTMLElement).click();
    const confirm = el.querySelector("[data-confirm]") as HTMLElement;
    expect(confirm.textContent).toMatch(/cannot be undone/i);
    expect(confirm.textContent, "the reload is not mentioned").toMatch(/reload/i);
  });

  it("RE-READS THE STORE WHEN IT IS REFRESHED", () => {
    /* I3. The card was built once on a store its own notes describe as written
       many times a minute, and `activate()` refreshed the seven other cards on
       that desk and not this one — because it was handed a bare element. */
    const kv = createKV(memoryRawStore());
    const card = createHoldingsCard({ kv });
    const row = () => card.el.querySelector(`[data-slot="${ALERT_BOOK_SLOT.key}"]`) as HTMLElement;
    expect(row().dataset["held"]).toBe("false");

    kv.write(ALERT_BOOK_SLOT, [] as never);
    expect(row().dataset["held"], "the card still reported the old store").toBe("false");

    card.refresh();
    expect(row().dataset["held"]).toBe("true");
  });

  it("FORGETS A SELECTION THAT IS NO LONGER THERE", () => {
    /* `picked` survived every re-render, so a key emptied elsewhere — another
       tab, the owning desk, a previous clear — stayed selected: the foot
       offered "Clear 1…" for a row with no checkbox, and a selection with
       nothing clearable in it rendered "This empties ." on the one
       destructive control in this view. */
    const kv = seeded();
    const card = createHoldingsCard({ kv });
    (card.el.querySelector(`[data-pick="${ALERT_BOOK_SLOT.key}"]`) as HTMLInputElement).click();
    expect(card.el.querySelector('[data-act="clear"]')).not.toBeNull();

    kv.remove(ALERT_BOOK_SLOT.key);
    card.refresh();
    expect(
      card.el.querySelector('[data-act="clear"]'),
      "a clear was still offered for a row that is gone",
    ).toBeNull();
  });

  it("EXPORTS THROUGH THE ONE OWNER, with the stored bytes", () => {
    /* I2. The card built its own anchor and got both rules wrong at once. The
       transport is injected so this can be watched without a navigator. */
    const saved: Array<{ name: string; text: string }> = [];
    const { el } = createHoldingsCard({
      kv: seeded(),
      save: (name, text) => void saved.push({ name, text }),
    });
    const row = el.querySelector(`[data-slot="${ALERT_BOOK_SLOT.key}"]`) as HTMLElement;
    (row.querySelector('[data-act="export"]') as HTMLElement).click();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe(`${ALERT_BOOK_SLOT.key}.json`);
    /* The RAW envelope, exactly as stored — a file somebody can put back,
       not a re-serialised value with its version stripped. */
    const file = JSON.parse(saved[0]?.text ?? "null") as { v: number; value: unknown };
    expect(file.v).toBe(1);
    expect(file.value).toEqual([{ id: "a" }]);
  });
});
