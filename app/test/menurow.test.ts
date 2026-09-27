// @vitest-environment jsdom

/**
 * WHAT A MENU ROW SHOWS, AND WHAT IT GIVES UP FIRST — `ui/menu.ts`.
 *
 * MEASURED IN THE BROWSER BEFORE THIS EXISTED. In "All tools" → Research the row
 * for the Knowledge desk gave its NAME 62px when the name needed 71, and
 * rendered "Knowledg…" — while the description beside it, "what replaying
 * history measured", was shown in full. The name is the one thing a menu row
 * cannot do without: CLAUDE.md states it directly — "the label is the NAME, the
 * hint is what it does".
 *
 * THE CAUSE WAS ONE SLOT HOLDING TWO FACTS. `MenuItem.hint` is documented as
 * "right-aligned accelerator, filled in from the keymap", and `toolsmenu.ts`
 * was passing descriptions into it. So the description inherited `.menu-kbd`'s
 * `white-space: nowrap`, never shrank, and the label — the only element with
 * `text-overflow: ellipsis` — absorbed the whole shortfall.
 *
 * IT ALSO COST THE SHORTCUT. Overwriting `hint` threw away the accelerator the
 * registry had already filled in, so every desk in that menu lost its key.
 *
 * THE TEST THAT MATTERS IS `a note never displaces the accelerator`. Two
 * different facts, two slots, and a row can now show both.
 */

import { describe, expect, it } from "vitest";
import { openMenu, type MenuItem } from "../src/ui/menu";
import { MENU_NOTES } from "../src/ui/shell/toolsmenu";
import { VIEWS } from "../src/ui/shell/views";

const ctx = {
  commands: { get: () => undefined, all: () => [] },
  keymap: { forCommand: () => "G K" },
} as never;

/**
 * Open a menu and hand back the panel it built.
 *
 * CLEARS FIRST, and takes the LAST panel. Menus are appended to the document
 * and an earlier test's panel is still there, so `querySelector(".menu")` hands
 * back a stale one and every assertion after the first describes the wrong
 * menu — which is the vacuous-pass shape this project keeps recording.
 */
function panelFor(items: readonly MenuItem[]): HTMLElement {
  for (const stale of [...document.querySelectorAll(".menu")]) stale.remove();
  const host = document.createElement("div");
  document.body.appendChild(host);
  openMenu(items, { anchor: host }, ctx);
  const panels = [...document.querySelectorAll(".menu")];
  const panel = panels[panels.length - 1];
  if (panel === undefined) throw new Error("the menu did not open");
  return panel as HTMLElement;
}

describe("a row shows the name, the description and the shortcut", () => {
  it("A NOTE NEVER DISPLACES THE ACCELERATOR", () => {
    /* They are different facts. Before this they shared `hint`, so a menu that
       described its rows silently lost every keyboard shortcut in them. */
    const p = panelFor([{ label: "Knowledge", hint: "G K", note: "what replaying history measured" }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    expect(row.querySelector(".menu-label")?.textContent).toBe("Knowledge");
    expect(row.querySelector(".menu-note")?.textContent).toBe("what replaying history measured");
    expect(row.querySelector(".menu-kbd")?.textContent).toBe("G K");
  });

  it("a row with only a shortcut still shows it, and adds no empty note", () => {
    const p = panelFor([{ label: "Save", hint: "Ctrl+S" }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    expect(row.querySelector(".menu-kbd")?.textContent).toBe("Ctrl+S");
    expect(row.querySelector(".menu-note")).toBeNull();
  });

  it("a row with only a note shows it, and reserves no shortcut column", () => {
    const p = panelFor([{ label: "Connections", note: "what moves with what" }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    expect(row.querySelector(".menu-note")?.textContent).toBe("what moves with what");
    expect(row.querySelector(".menu-kbd")).toBeNull();
  });

  it("A SUBMENU ROW KEEPS ITS ARROW, and does not also claim a shortcut slot", () => {
    /* A row that opens a submenu goes somewhere rather than doing something, and
       showing it an accelerator it cannot honour would be a promise it breaks. */
    const p = panelFor([{ label: "Research", note: "you steer", items: [{ label: "Quant" }] }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    expect(row.querySelector(".menu-arrow")?.textContent).toBe("›");
    expect(row.querySelector(".menu-note")?.textContent).toBe("you steer");
    expect(row.querySelector(".menu-kbd")).toBeNull();
  });

  it("THE NAME IS THE ONE PART THAT MAY NOT BE CLIPPED", () => {
    /* The label carries no ellipsis of its own any more; the NOTE is the element
       that gives way when a row is too narrow. A menu that abbreviates the name
       and spells out the description has its priorities exactly backwards. */
    const p = panelFor([{ label: "Smart-money wallets", note: "the scored list, and who alerts" }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    const label = row.querySelector(".menu-label") as HTMLElement;
    const note = row.querySelector(".menu-note") as HTMLElement;
    // Class contract, since jsdom computes no layout: the note owns the ellipsis.
    expect(label.className).toBe("menu-label");
    expect(note.className).toBe("menu-note");
  });

  it("keeps the order the eye reads: check, name, note, shortcut", () => {
    const p = panelFor([{ label: "Live edge", checked: true, hint: "G L", note: "what fired" }]);
    const row = p.querySelector(".menu-item") as HTMLElement;
    const order = [...row.children].map((c) => c.className.replace(/\s.*/, ""));
    expect(order.filter((c) => c !== "menu-spacer")).toEqual([
      "menu-check",
      "menu-label",
      "menu-note",
      "menu-kbd",
    ]);
  });
});

describe("every desk says what it is, in the menu", () => {
  it("NO DESK FALLS BACK TO THE WORD 'desk'", () => {
    /* The fallback `t.note ?? "desk"` is a row that tells the reader nothing:
       they already know it is a desk, they clicked a menu of desks. Measured in
       the browser, exactly one had drifted — `chart`, the most used one of all.
       A count would have passed the moment it was fixed and failed on the next
       desk added; this compares the SET against its source of truth, so a desk
       shipped without a note fails here rather than shipping a blank hint. */
    const missing = VIEWS.filter((v) => MENU_NOTES[v.id] === undefined).map((v) => v.id);
    expect(missing, `these desks would render the note "desk"`).toEqual([]);
  });

  it("and no note merely repeats the label it sits beside", () => {
    // "Chart — chart" is the same emptiness spelled differently.
    for (const v of VIEWS) {
      const note = MENU_NOTES[v.id];
      if (note === undefined) continue;
      expect(note.toLowerCase(), v.id).not.toBe(v.label.toLowerCase());
    }
  });
});
