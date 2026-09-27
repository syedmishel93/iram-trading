/**
 * EVERY REGISTERED DESK IS ACTUALLY REACHABLE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Adding a desk takes two edits in two files: a row in `VIEWS`, which puts it on
 * the desk bar and in the tools menu, and a line in `mountShell`'s view
 * dispatch, which decides what to render. MEASURED when `results` was added and
 * only the first edit was made: the workspace tab appeared, the menu row
 * appeared, clicking it selected the workspace — **and the desk area rendered
 * completely blank, with zero console errors and zero swallowed signal errors.**
 *
 * Nothing could have caught it. `tsc` is happy: the dispatch is a chain of
 * `if`s returning elements, and an id nobody tests for simply falls through.
 * Every grouping test passed, because the row was in `VIEWS` exactly as
 * intended. The only symptom was an empty screen.
 *
 * Same family as the uncalled routes and the loops with no writer: a name in
 * one list and not the other, where both lists look complete on their own.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT READS SOURCE TEXT, AND SAYS SO
 *
 * `mountShell` cannot be instantiated in jsdom — nothing unit-tests it, which
 * this project already records. So this greps the dispatch instead, and that
 * carries a known cost: a test that reads source text loses coverage silently
 * when the code moves. The mitigation is the one that file already prescribes —
 * it PRINTS what it parsed and FAILS on a zero, so a dispatch that has been
 * restructured out from under it breaks loudly rather than passing on nothing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VIEWS } from "../src/ui/shell/views";

const SHELL = new URL("../src/ui/shell.ts", import.meta.url);

describe("the view dispatch", () => {
  const src = readFileSync(SHELL, "utf8");
  /* `if (view === "x")` — the one shape the dispatch uses. */
  const dispatched = new Set(
    [...src.matchAll(/view === "([\w-]+)"/g)].map((m) => m[1] as string),
  );

  it("PARSES THE DISPATCH AT ALL, or it is reporting success about nothing", () => {
    expect(
      dispatched.size,
      "matched no `view === \"...\"` branches — the dispatch has been restructured " +
        "and this test is now checking nothing",
    ).toBeGreaterThan(10);
  });

  /**
   * `chart` is the base layer the view slot OVERLAYS, not a branch of it, so it
   * is the one id with no dispatch line. Verified rather than assumed: the
   * fallback at the end of the chain returns `document.createComment(...)`, and
   * the chart plainly renders — which it could not do through that path.
   */
  const NOT_DISPATCHED = new Set(["chart"]);

  it("RENDERS SOMETHING FOR EVERY DESK IN VIEWS", () => {
    const missing = VIEWS.map((v) => v.id).filter(
      (id) => !dispatched.has(id) && !NOT_DISPATCHED.has(id),
    );
    expect(
      missing,
      `these desks are on the bar and in the menu and render a blank screen: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("dispatches nothing that is not a registered desk", () => {
    /* The other direction: a branch for an id no longer in `VIEWS` is dead code
       that reads as a working feature. `chart` is the shell's own default and is
       not dispatched by name, so it is the one exemption. */
    const known = new Set<string>(VIEWS.map((v) => v.id));
    known.add("chart");
    const orphans = [...dispatched].filter((id) => !known.has(id));
    expect(orphans, `dispatched but not registered: ${orphans.join(", ")}`).toEqual([]);
  });
});
