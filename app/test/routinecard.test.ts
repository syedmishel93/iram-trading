// @vitest-environment jsdom
/**
 * THE ROUTINE CARD.
 *
 * It computes nothing — `today/routine.ts` does the arithmetic and this shows
 * it — so the tests here are about what reaches the screen: that a step nobody
 * could check is drawn as its own thing rather than as a tick or a cross, that
 * every row can be acted on, and that the card re-reads rather than freezing
 * at construction, which is a defect this repository has shipped twice.
 */

import { describe, expect, it } from "vitest";
import { createRoutineCard } from "../src/ui/cards/routinecard";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { deskLabel } from "../src/ui/shell/views";
import type { RoutineInput } from "../src/ui/today/routine";

const GOOD: RoutineInput = {
  dataAgeMin: 2,
  eventsToday: 3,
  canTrade: true,
  dayLossUsed: 0,
  watchCount: 5,
  scannedAgoMin: 20,
  planWritten: true,
  alertsArmed: 4,
  alertsCanReach: true,
  reviewedYesterday: true,
};

const rows = (el: HTMLElement) => [...el.querySelectorAll(".rt-row")] as HTMLElement[];

describe("the routine card", () => {
  it("DRAWS A ROW PER STEP, each with its own standing", () => {
    const { el } = createRoutineCard({ read: () => GOOD });
    expect(rows(el)).toHaveLength(7);
    expect(rows(el).every((r) => r.dataset["state"] === "done")).toBe(true);
    expect(el.querySelector(".rt-count")?.textContent).toBe("7/7");
    expect(el.querySelector(".rt-says")?.textContent).toBe("Ready.");
  });

  it("DRAWS A STEP NOBODY COULD CHECK AS ITS OWN THING", () => {
    /* Not a tick and not a cross. A step drawn as done when the service was
       down is the "0 of 0 running" strip again, and drawn as a failure it
       teaches the operator to ignore the card on exactly the mornings it has
       something to say. */
    const { el } = createRoutineCard({ read: () => ({ ...GOOD, canTrade: undefined }) });
    const limits = rows(el).find((r) => (r.textContent || "").includes("limits"));
    expect(limits?.dataset["state"]).toBe("unknown");
    expect(limits?.querySelector(".rt-mark")?.textContent).toBe("?");
    expect(limits?.querySelector(".rt-mark")?.getAttribute("aria-label")).toMatch(/could not be checked/i);
    expect(el.querySelector(".rt-count")?.textContent, "an unchecked step counted as done").toBe("6/7");
  });

  it("LEADS WITH WHAT IS STOPPING YOU, and colours by the standing", () => {
    const { el } = createRoutineCard({ read: () => ({ ...GOOD, canTrade: false }) });
    const says = el.querySelector(".rt-says") as HTMLElement;
    expect(says.textContent).toMatch(/stopping you/);
    /* Colour follows the STANDING, never the number — a list with one blocker
       is a different answer, not a worse version of a clean one. */
    expect(says.dataset["state"]).toBe("blocked");
  });

  it("NAMES EVERY DESK THROUGH deskLabel, never by hand", () => {
    /* One owner for a desk's display name. Fifteen stale ones had to be hunted
       down twice because this rule was broken in ordinary sentences. */
    const { el } = createRoutineCard({ read: () => GOOD, openDesk: () => {} });
    const names = [...el.querySelectorAll(".rt-go")].map((b) => (b.textContent || "").trim());
    expect(names).toContain(deskLabel("risk"));
    expect(names).toContain(deskLabel("journal"));
    expect(names.some((n) => /Opportunities|Signals desk|Analyst/.test(n))).toBe(false);
  });

  it("TAKES YOU TO THE DESK THAT ANSWERS THE STEP", () => {
    /* A routine that says what is outstanding and leaves you to find the desk
       is a list, not a routine. */
    const went: string[] = [];
    const { el } = createRoutineCard({ read: () => GOOD, openDesk: (v) => void went.push(v) });
    const go = el.querySelectorAll(".rt-go");
    expect(go.length).toBe(7);
    (go[4] as HTMLButtonElement).click();
    expect(went).toEqual(["risk"]);
  });

  it("SHOWS THE DESK WITHOUT A BUTTON WHEN IT CANNOT NAVIGATE", () => {
    /* A button that cannot go anywhere is not a button — `settings/ui.ts`
       renders an action as an enabled control whose handler does nothing, and
       that shipped once already. */
    const { el } = createRoutineCard({ read: () => GOOD });
    expect(el.querySelectorAll(".rt-go")).toHaveLength(0);
    expect(el.querySelectorAll(".rt-to")).toHaveLength(7);
  });

  it("RE-READS WHEN REFRESHED, rather than freezing at construction", () => {
    /* The holdings card froze at first construction on a store written many
       times a minute, and the inspector's scroll readout was stale by 2.8x.
       A morning's answers move while you work it. */
    let now: RoutineInput = { ...GOOD, planWritten: false };
    const card = createRoutineCard({ read: () => now });
    expect(card.el.querySelector(".rt-count")?.textContent).toBe("6/7");

    now = { ...GOOD, planWritten: true };
    expect(card.el.querySelector(".rt-count")?.textContent, "it did not re-read").toBe("6/7");
    card.refresh();
    expect(card.el.querySelector(".rt-count")?.textContent).toBe("7/7");
  });

  it("SAYS SOMETHING USEFUL ON A MORNING WHEN NOTHING ANSWERED", () => {
    const { el } = createRoutineCard({ read: () => ({}) });
    expect(el.querySelector(".rt-count")?.textContent).toBe("0/7");
    expect(el.querySelector(".rt-says")?.textContent).toMatch(/could not be checked/i);
    expect(rows(el).every((r) => r.dataset["state"] === "unknown")).toBe(true);
  });
});

describe("an answer that arrives late", () => {
  it("REACHES THE SCREEN WITHOUT ANYONE CALLING REFRESH", async () => {
    /* MEASURED on the running terminal before this: the calendar loads
       asynchronously at boot, so one reload showed "17 scheduled, 2 high
       impact" and the next showed "could not check — the calendar did not
       answer". Same build, same machine — the card had rendered before the
       feed arrived and never looked again. It was only right by luck of
       timing, which is the worst way for a thing to be right.

       The card reads through signals, so tracking them is the fix; `refresh()`
       remains for callers that want to force it, and this is for the ones that
       cannot know to. */
    const calendar = signal<{ total: number; high: number } | null>(null);
    /* GOOD carries `eventsToday`, so it has to come out of the base here or
       the step is answered before the feed lands and the test proves nothing.
       An expected value that is true before the change is the trap this
       repository records as "a test that compared the bug to itself". */
    const { eventsToday: _t, eventsHigh: _h, ...WITHOUT_CALENDAR } = GOOD;
    const { el } = createRoutineCard({
      read: () => {
        const c = calendar();
        return { ...WITHOUT_CALENDAR, ...(c === null ? {} : { eventsToday: c.total, eventsHigh: c.high }) };
      },
    });

    const events = () =>
      [...el.querySelectorAll(".rt-row")].find((r) => (r.textContent || "").includes("scheduled")) as HTMLElement;
    expect(events().dataset["state"], "it should not claim an answer it does not have").toBe("unknown");

    /* The feed lands, and nobody tells the card. Effects here are BATCHED, so
       the redraw is a tick away — checking synchronously reads the old DOM and
       reports a working card as broken, which is how I first mis-read this. */
    calendar.set({ total: 17, high: 2 });
    /* `renderEffect` repaints through `scheduleFrame`, so the redraw is a
       FRAME away, not a tick. Checking synchronously reads the old DOM and
       reports a working card as broken, which is how I first mis-read this —
       and `scheduleFrame` exists precisely because a bare rAF never fires in
       a tab that is not composited. */
    flushFrames();
    expect(events().dataset["state"]).toBe("done");
    expect(events().querySelector(".rt-says-row")?.textContent).toMatch(/17 scheduled, 2 high impact/);
  });
});
