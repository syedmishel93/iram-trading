/**
 * ONE OWNER FOR A DESK'S DISPLAY NAME.
 *
 * A desk's name was written in up to three places: `VIEWS` holds it, fifteen
 * desk modules render it again as a string literal, and other desks name it a
 * third time when they link to it. Two owners for one fact drift, and nothing
 * fails — MEASURED before this guard existed, two desks already disagreed with
 * their own tabs:
 *
 *   `calculator`  tab said "Calculator"  · its heading said "Trade calculator"
 *   `survey`      tab said "Conditions"  · its heading said "Condition survey"
 *
 * Neither was red. That is the whole argument for `deskLabel`.
 */

import { describe, expect, it } from "vitest";
import { VIEWS, VIEW_IDS, deskLabel, type ViewId } from "../src/ui/shell/views";

describe("deskLabel", () => {
  it("returns the label VIEWS holds, for every desk", () => {
    for (const v of VIEWS) expect(deskLabel(v.id)).toBe(v.label);
  });

  it("COVERS EVERY DESK — a lookup that answered for some would be worse than none", () => {
    expect(VIEWS.length).toBe(27);
    for (const v of VIEWS) expect(deskLabel(v.id).length).toBeGreaterThan(0);
  });

  it("knows every id, so a persisted desk can be checked before it is used", () => {
    /* A desk whose module is gone still type-checks, because `VIEWS` still
       lists it. `VIEW_IDS` is what a runtime caller — one reading a desk id
       out of saved preferences — checks against. */
    expect(VIEW_IDS.size).toBe(VIEWS.length);
    expect(VIEW_IDS.has("screener")).toBe(true);
    expect(VIEW_IDS.has("not-a-desk")).toBe(false);
  });

  it("types the id, so an unknown desk cannot reach the renderer", () => {
    /* THE SAFETY ARGUMENT, PINNED. A `deskLabel(id: string)` that threw on an
       unknown id would throw inside a render effect — which `core/signal.ts`
       catches and logs to `window.__signalErrors`, leaving the section blank
       with nothing on screen to say why. A literal union moves the error to
       `tsc`, where it cannot be swallowed.

       `@ts-expect-error` FAILS THE BUILD IF THE LINE STOPS BEING AN ERROR, so
       this asserts the type is narrow rather than merely documenting it. */
    // @ts-expect-error — "not-a-desk" is not a ViewId
    const bad: string = deskLabel("not-a-desk");
    expect(typeof bad).toBe("undefined");

    const good: ViewId = "screener";
    expect(deskLabel(good)).toBe(deskLabel("screener"));
  });
});
