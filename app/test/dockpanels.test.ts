import { describe, expect, it } from "vitest";
import {
  COLLAPSED_H,
  DOCK_PANELS,
  columnHeight,
  defaultOpen,
  dockSummary,
  nextCard,
  orderedIds,
  panelMeta,
  sanitiseActive,
  sanitiseMode,
  sanitiseOpen,
  toggleOpen,
  DOCK_LAYOUT,
  DOCK_SECTIONS,
  layoutOrder,
  addableCards,
  defaultRemoved,
  removeCard,
  sanitiseIds,
  shownCards,
  togglePin,
} from "../src/ui/dockpanels";

/** The measured viewport the dock was diagnosed at. */
const VIEWPORT = 812;

describe("DOCK_PANELS", () => {
  it("covers every panel the dock builds", () => {
    expect(DOCK_PANELS.map((p) => p.id).sort()).toEqual(
      [
        "context",
        "cursor",
        "feed",
        "fundamentals",
        /* v55.2. The log of what CHANGED — the only panel in the dock that is
           not a standing answer repainted in place. */
        "live",
        "news",
        "outlook",
        "regime",
        "series",
        "setup",
        "structures",
        "studies",
        /* v59.2 — the v5 design's cards, each over a service with no screen. */
        "read",
        "watch",
        "levels",
        "gov",
        "alerts",
        "whale",
        /* v62.16 — the last two capabilities whose menu row read "no screen
           yet". `newpairs` is fed by the scanner that had never written a row
           in its life until the v62.14 nesting fix. */
        "dbwallets",
        "newpairs",
      ].sort(),
    );
  });

  it("has unique ids and unique ranks, because both are persisted or ordered by", () => {
    expect(new Set(DOCK_PANELS.map((p) => p.id)).size).toBe(DOCK_PANELS.length);
    expect(new Set(DOCK_PANELS.map((p) => p.rank)).size).toBe(DOCK_PANELS.length);
  });
});

describe("orderedIds", () => {
  /**
   * THE BUG THIS FIXES. Source order in `shell.ts` put 774px of venue
   * announcements — occasional reading — above the regime and structure
   * panels, which are read constantly. Rank is by how often you look, not by
   * the order someone happened to add the panel in.
   */
  /* v54: the column is one argument in decision order. The literal lists
     below ARE the design, so a reorder has to be made here on purpose. */
  it("reads in decision order: market now, what's next, the trade, risk, evidence", () => {
    expect(orderedIds()).toEqual([
      "read", "live", "regime", "studies", "watch",
      "outlook",
      /* v59.2: "Can I trade now?" moved into the trade, ahead of Key levels —
         the v5 panel's order: recommendation, read, can I, levels, calendar. */
      "setup", "gov", "levels",
      /* `dbwallets` sits immediately after `whale` because it IS that card's
         input — the transfers there come from these wallets — and `newpairs`
         last in Risk, because it is a feed to screen rather than an answer. */
      "context", "news", "fundamentals", "alerts", "whale", "dbwallets", "newpairs",
      "structures", "cursor", "feed", "series",
    ]);
  });

  it("puts the reasoning above the conclusion it depends on", () => {
    const ids = orderedIds();
    expect(ids.indexOf("regime")).toBeLessThan(ids.indexOf("setup"));
    expect(ids.indexOf("outlook")).toBeLessThan(ids.indexOf("setup"));
  });

  it("gives every panel a section that exists", () => {
    const known = new Set(DOCK_SECTIONS.map((x) => x.id));
    for (const panel of DOCK_PANELS) expect(known.has(panel.section), panel.id).toBe(true);
  });
});

describe("layoutOrder", () => {
  it("puts each section heading directly before its first panel", () => {
    /* THE INVARIANT, NOT THE INDICES.
     *
     * This asserted twenty absolute positions, so adding two panels to `risk`
     * moved `evidence` from 18 to 20 and broke a test about SECTION HEADINGS
     * for a reason that had nothing to do with section headings. That is
     * CLAUDE.md's "a guard test that pins a COUNT fails on addition" — and
     * worse, it fails LOUDLY for the wrong reason, which trains the next person
     * to renumber it rather than read it.
     *
     * The fact being protected is a relationship: a heading is immediately
     * followed by a panel of ITS OWN section, and a section with panels always
     * has a heading. Stated that way it survives every addition and still
     * catches a panel filed under the wrong heading, which is the defect.
     */
    const { sections, panels } = layoutOrder();
    const at = new Map<number, { kind: "section" | "panel"; id: string }>();
    for (const [id, i] of sections) at.set(i, { kind: "section", id });
    for (const [id, i] of panels) at.set(i, { kind: "panel", id });

    const sectionOf = new Map(DOCK_PANELS.map((p) => [p.id, p.section]));
    const used = [...sections.keys()].filter((sec) =>
      DOCK_PANELS.some((p) => p.section === sec),
    );
    expect(used.length, "no section has any panels — layoutOrder parsed nothing").toBeGreaterThan(3);

    for (const sec of used) {
      const i = sections.get(sec);
      expect(i, `section ${sec} has panels but no heading`).toBeTypeOf("number");
      const next = at.get((i as number) + 1);
      expect(next?.kind, `nothing directly after the ${sec} heading`).toBe("panel");
      expect(sectionOf.get(next?.id ?? ""), `the panel after ${sec} belongs elsewhere`).toBe(sec);
    }

    /* And the first thing in the dock is a heading, not a loose panel. */
    expect(at.get(0)?.kind).toBe("section");
  });

  it("puts pinned cards above every section, in the order they were pinned", () => {
    const { sections, panels } = layoutOrder(["gov", "setup"]);
    expect(panels.get("gov")).toBe(0);
    expect(panels.get("setup")).toBe(1);
    expect(sections.get("now")).toBe(2);
  });

  it("gives a removed card no slot, and a section with nothing left no heading", () => {
    const { sections, panels } = layoutOrder([], ["outlook"]);
    expect(panels.has("outlook")).toBe(false);
    /* Outlook is the only card in "What's likely next". */
    expect(sections.has("next")).toBe(false);
    const pinnedAway = layoutOrder(["outlook"], []);
    expect(pinnedAway.sections.has("next")).toBe(false);
  });

  it("ignores a pin on a card that has been removed", () => {
    const { panels } = layoutOrder(["gov"], ["gov"]);
    expect(panels.has("gov")).toBe(false);
  });
});

describe("pin, remove, add (v59.2)", () => {
  it("removing a card also unpins it, so adding it back does not revive a pin", () => {
    expect(removeCard({ pinned: ["gov", "setup"], removed: [] }, "gov")).toEqual({ pinned: ["setup"], removed: ["gov"] });
  });

  it("offers exactly the removed cards to add, in column order", () => {
    expect(addableCards(["whale", "watch"]).map((p) => p.id)).toEqual(["watch", "whale"]);
    expect(addableCards([])).toEqual([]);
  });

  it("toggles a pin", () => {
    expect(togglePin([], "gov")).toEqual(["gov"]);
    expect(togglePin(["gov"], "gov")).toEqual([]);
  });

  it("keeps a saved empty list as a decision, and gives never-saved the default", () => {
    expect(sanitiseIds([], defaultRemoved())).toEqual([]);
    expect(sanitiseIds(undefined, defaultRemoved())).toEqual(defaultRemoved());
    expect(sanitiseIds(["gov", "gov", "gone", 3], [])).toEqual(["gov"]);
  });

  /* The v5 design: the recommendation above, and exactly these four cards on
     the column. Everything else is one click away under "+ Add panel". */
  it("puts exactly the v5 design's four cards on the column", () => {
    const on = DOCK_PANELS.filter((p) => !defaultRemoved().includes(p.id)).map((p) => p.id).sort();
    expect(on).toEqual(["context", "gov", "levels", "read"]);
  });

  it("lists the icon strip pins first, removed cards absent", () => {
    const ids = shownCards(["structures"], ["whale"]).map((p) => p.id);
    expect(ids[0]).toBe("structures");
    expect(ids).not.toContain("whale");
    expect(ids.filter((x) => x === "structures")).toHaveLength(1);
  });

  it("says who produces every card", () => {
    for (const p of DOCK_PANELS) expect(["ai", "you", "both", ""]).toContain(p.who);
  });
});

describe("defaults", () => {
  /**
   * The old column was 3,828px in an 842px viewport — 4.5 screens. The default
   * open set has to be a real improvement on a first run, before anyone has
   * tuned anything.
   */
  /**
   * v55.2 RAISED THIS FROM 2 TO 2.4, AND THAT IS A DELIBERATE DEVIATION.
   *
   * The v54 column measured 1.89 screens, so ANY new panel opened by default
   * broke a threshold of 2 — including the one the owner asked for. Rather
   * than close the Live log on a first run (a feature behind a shut row in a
   * list is a feature nobody finds, which is the argument the closed dock rail
   * already settled) or shut the Outlook that v54 deliberately opened, the
   * number moves and says so here.
   *
   * WHAT THE GUARD IS ACTUALLY FOR is unchanged: the column that forced this
   * whole file was 3,828px in an 842px viewport — 4.5 screens, uncollapsible.
   * The default set is 2.28 screens, still half of that, and the test below
   * pins the other half of the promise by comparing against the
   * everything-open column rather than against a viewport. Two guards, and
   * only the softer one moved.
   */
  it("opens a default set that fits in well under the 4.5 screens that forced this file", () => {
    expect(columnHeight(defaultOpen()) / VIEWPORT).toBeLessThan(2.4);
  });

  it("is a very large improvement on the every-panel-open column", () => {
    const everything = columnHeight(DOCK_PANELS.map((p) => p.id));
    expect(columnHeight(defaultOpen())).toBeLessThan(everything * 0.45);
  });

  it("leaves the three biggest reads closed", () => {
    const open = defaultOpen();
    expect(open).not.toContain("context");
    expect(open).not.toContain("news");
    expect(open).not.toContain("fundamentals");
  });

  /* v55.2: the panel that says what changed is the first thing in the column
     and open on a first run. A feature shipped behind a shut row in a list is
     a feature nobody finds — the argument the closed dock rail settled. */
  /* v59.2: the AI read is first in the column (shut by default, as in the
     v5 design); the live log is still the first thing OPEN. */
  it("opens the live log, first of the open cards", () => {
    expect(defaultOpen()).toContain("live");
    expect(orderedIds().filter((id) => defaultOpen().includes(id))[0]).toBe("live");
    expect(orderedIds()[0]).toBe("read");
  });

  it("opens the outlook and closes the diagnostics", () => {
    const open = defaultOpen();
    expect(open).toContain("outlook");
    for (const d of ["cursor", "feed", "series", "structures"]) expect(open).not.toContain(d);
  });

  it("opens the setup card, because it is why you looked at the chart", () => {
    expect(defaultOpen()).toContain("setup");
  });
});

describe("sanitiseOpen", () => {
  it("falls back to the defaults when nothing is saved", () => {
    expect(sanitiseOpen(undefined, DOCK_LAYOUT)).toEqual(defaultOpen());
    expect(sanitiseOpen("nonsense", DOCK_LAYOUT)).toEqual(defaultOpen());
  });

  /**
   * The set is persisted, so a panel removed in a later version must not brick
   * the dock — the same rule `runStudies` and `runPanes` follow.
   */
  it("replaces a set saved for an older column with the defaults, once", () => {
    // A pre-v54 install: the Cursor open, the Outlook unknown to it.
    expect(sanitiseOpen(["setup", "cursor"], undefined)).toEqual(defaultOpen());
    expect(sanitiseOpen(["setup", "cursor"], 1)).toEqual(defaultOpen());
    /* And a set saved under v54's layout, which knows every panel here except
       the Live log — so it would have shipped the feature shut. */
    expect(sanitiseOpen(["setup", "regime", "studies", "outlook"], 2)).toEqual(defaultOpen());
    // Saved under this layout: the operator's choice wins again.
    expect(sanitiseOpen(["setup", "cursor"], DOCK_LAYOUT)).toEqual(["setup", "cursor"]);
  });

  it("drops an id it does not recognise", () => {
    expect(sanitiseOpen(["setup", "panel-from-the-future", "cursor"], DOCK_LAYOUT)).toEqual(["setup", "cursor"]);
  });

  /**
   * Closing everything is a legitimate thing to want. Treating an empty array
   * as "unset" and re-opening five panels would be the dock overruling a
   * deliberate choice, and it would happen on every reload.
   */
  it("respects an empty saved set rather than restoring the defaults", () => {
    expect(sanitiseOpen([], DOCK_LAYOUT)).toEqual([]);
  });
});

describe("sanitiseMode and sanitiseActive", () => {
  it("defaults to the column, which is the mode that shows most at once", () => {
    expect(sanitiseMode(undefined)).toBe("column");
    expect(sanitiseMode("banana")).toBe("column");
    expect(sanitiseMode("stack")).toBe("stack");
  });

  /* A stack with no card selected is an empty dock, and an empty dock reads as
     broken rather than as empty. */
  it("never leaves the stack with no card", () => {
    expect(sanitiseActive(undefined)).toBe("setup");
    expect(sanitiseActive("gone")).toBe("setup");
    expect(sanitiseActive("news")).toBe("news");
  });
});

describe("nextCard", () => {
  it("steps forward and back through the cards in rank order", () => {
    expect(nextCard("setup", 1)).toBe("gov");
    expect(nextCard("setup", -1)).toBe("outlook");
    expect(nextCard("live", 1)).toBe("regime");
  });

  it("skips a removed card", () => {
    expect(nextCard("setup", 1, ["gov"])).toBe("levels");
  });

  it("wraps at both ends rather than sticking", () => {
    const ids = orderedIds();
    expect(nextCard(ids[ids.length - 1] as string, 1)).toBe(ids[0]);
    expect(nextCard(ids[0] as string, -1)).toBe(ids[ids.length - 1]);
  });

  it("starts from the first card when the current one is unknown", () => {
    expect(nextCard("gone", 1)).toBe(orderedIds()[1]);
  });
});

describe("toggleOpen", () => {
  it("opens what is closed and closes what is open", () => {
    expect(toggleOpen(["setup"], "cursor")).toEqual(["setup", "cursor"]);
    expect(toggleOpen(["setup", "cursor"], "setup")).toEqual(["cursor"]);
  });

  /**
   * A mutated array compares equal to itself, so the signal would not repaint
   * and the header would visibly do nothing.
   */
  it("returns a new array rather than mutating the old one", () => {
    const before = ["setup"];
    const after = toggleOpen(before, "cursor");
    expect(after).not.toBe(before);
    expect(before).toEqual(["setup"]);
  });
});

describe("dockSummary", () => {
  /**
   * THE BUG THIS BLOCK NOW GUARDS AGAINST.
   *
   * The line used to take a measured content height and viewport height and
   * report the ratio as "N screens of scroll". Measured live at 1600x900 with
   * the default open set, it read "4 panels open - 1.2 screens of scroll"
   * while `scrollHeight / clientHeight` on the same element in the same frame
   * was 2329 / 682 = 3.4. Wrong by a factor of 2.8, permanently: the observer
   * feeding it watched the dock body's own box, and what grew was the content
   * inside that box.
   *
   * NO TEST COULD HAVE CAUGHT IT, and that is the reason the figure is gone
   * rather than repaired. Every argument was passed in, so the function was
   * correct for its inputs and the tests below all passed; the staleness lived
   * in the caller, in an asynchronous DOM measurement no unit test observes.
   * A readout whose honesty depends on something untestable is a readout that
   * will be wrong again.
   *
   * So the line now says only what it can derive from its arguments, and every
   * assertion here is on a pure function of them.
   */
  it("takes no measurements, so it cannot report a stale one", () => {
    /* The signature IS the guarantee. Two arguments, both state. */
    expect(dockSummary.length).toBe(2);
    const line = dockSummary("column", defaultOpen());
    expect(line).not.toMatch(/screen/i);
    expect(line).not.toMatch(/scroll/i);
    expect(line).not.toMatch(/fits/i);
  });

  it("says how many are open out of how many there are", () => {
    /* The second half is what the collapsed panels became: a list, and this is
       its length. */
    const line = dockSummary("column", ["setup"]);
    expect(line).toBe(`1 of ${DOCK_PANELS.length} open`);
  });

  it("counts every open panel", () => {
    expect(dockSummary("column", ["setup", "cursor"])).toBe(
      `2 of ${DOCK_PANELS.length} open`,
    );
    const all = DOCK_PANELS.map((p) => p.id);
    expect(dockSummary("column", all)).toBe(
      `${DOCK_PANELS.length} of ${DOCK_PANELS.length} open`,
    );
  });

  it("ignores an unknown id in the count", () => {
    /* A persisted set from an older version can name a panel that no longer
       exists. It must not be counted as open, because it is not on screen. */
    expect(dockSummary("column", ["setup", "gone"])).toBe(
      `1 of ${DOCK_PANELS.length} open`,
    );
  });

  it("points at the list when nothing is open", () => {
    /* The row's own button reads "Open defaults" in this state, so the
       sentence has the other job: saying that the names below are clickable. */
    const line = dockSummary("column", []);
    expect(line).toMatch(/click a name/i);
  });

  it("describes the stack by its card count, not by scroll", () => {
    const line = dockSummary("stack", []);
    expect(line).toMatch(/One card at a time/);
    expect(line).toContain(String(DOCK_PANELS.length));
  });

  it("reports the stack the same way whatever the open set", () => {
    /* Stack mode shows one card regardless of what column mode had open, so
       the open set must not leak into the line. */
    expect(dockSummary("stack", DOCK_PANELS.map((p) => p.id))).toBe(
      dockSummary("stack", []),
    );
  });
});

describe("columnHeight", () => {
  it("charges a collapsed panel only its header", () => {
    expect(columnHeight([], [])).toBe(COLLAPSED_H * DOCK_PANELS.length);
  });

  it("charges an open panel its content", () => {
    const setup = panelMeta("setup");
    expect(columnHeight(["setup"], [])).toBe(
      (setup as { approxHeight: number }).approxHeight + COLLAPSED_H * (DOCK_PANELS.length - 1),
    );
  });

  it("charges a removed card nothing — it is not drawn at all", () => {
    expect(columnHeight([], ["setup"])).toBe(COLLAPSED_H * (DOCK_PANELS.length - 1));
    expect(columnHeight(["setup"], ["setup"])).toBe(COLLAPSED_H * (DOCK_PANELS.length - 1));
  });
});
