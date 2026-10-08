// @vitest-environment jsdom
/**
 * A LINK TO A DESK IS NAMED BY THE DESK.
 *
 * `ownerLink` took a label and a callback and knew nothing about where it went,
 * which is how a link's text comes to name a desk that has since been renamed.
 * Two lists naming the same thing will disagree and nothing will say so —
 * measured once in this repository at 0 of 24 group names agreeing between
 * `views.ts` and `toolsmenu.ts`.
 *
 * SEPARATE FROM `desklabel.test.ts` ON PURPOSE. That file scans the source
 * tree and needs the node environment; under jsdom `import.meta.url` is an
 * http URL and `fileURLToPath` refuses it. These need a document. One concern
 * each.
 */

import { describe, expect, it } from "vitest";
import { deskLabel } from "../src/ui/shell/views";
import { ownerLink } from "../src/ui/briefing";

describe("a link to a desk", () => {
  it("IS NAMED BY THE DESK, not by whoever wrote the link", () => {
    const el = ownerLink("screener", () => {});
    expect(el.textContent).toBe(deskLabel("screener"));
    expect(el.getAttribute("data-opens")).toBe("screener");
  });

  it("OPENS THE DESK IT NAMES", () => {
    /* The id is passed to the handler rather than captured by the caller, so
       the name and the destination come from one argument and cannot be made
       to disagree. */
    const opened: string[] = [];
    const el = ownerLink("signals", (v) => opened.push(v));
    el.click();
    expect(opened).toEqual(["signals"]);
  });

  it("STILL ALLOWS A LINK THAT DELIBERATELY SAYS SOMETHING ELSE", () => {
    /* Three of the six calls are a call to action rather than a name — "Open
       chart", "Full feed", "Risk desk". Flattening all six to the bare desk
       name would put two links both reading "Chart" in different cards and
       lose what those phrases say. The DEFAULT is the desk's own name, so the
       case that can drift is the one that costs an argument. */
    const el = ownerLink("chart", () => {}, "Open chart");
    expect(el.textContent).toBe("Open chart");
    expect(el.getAttribute("data-opens")).toBe("chart");
  });

  it("TAKES AN ID, SO A WRONG NAME CANNOT BE PASSED AT ALL", () => {
    /* `@ts-expect-error` fails the build if this line ever stops being an
       error, so this asserts the signature is narrow rather than describing
       it. A label passed here used to be the whole defect. */
    // @ts-expect-error — the first argument is a ViewId, not a label
    const el = ownerLink("Opportunities", () => {});
    expect(el.getAttribute("data-opens")).toBe("Opportunities");
  });
});
