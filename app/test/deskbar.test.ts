// @vitest-environment jsdom
/**
 * The desk bar as WORKSPACES (v59).
 *
 * A click on a workspace you are not in must put you IN it — on the desk you
 * last used there — not open a menu about it. Trade holds the chart, and a
 * chart two clicks away is a chart nobody uses.
 */

import { describe, expect, it } from "vitest";
import { createDeskBar, groupDesks, type DeskDef } from "../src/ui/deskbar";
import { signal } from "../src/core/signal";
import { createCommands } from "../src/core/commands";
import { createKeymap } from "../src/core/keys";
import { VIEWS, WORKSPACE_LEAD } from "../src/ui/shell/views";

const DESKS: DeskDef[] = [
  { id: "briefing", label: "Today", icon: "briefing" },
  { id: "chart", label: "Chart", icon: "chart", group: "Trade" },
  { id: "flow", label: "Flow", icon: "flow", group: "Trade" },
  { id: "journal", label: "Journal", icon: "playbook", group: "Review" },
  { id: "learn", label: "Learning", icon: "learn", group: "Review" },
];

const flush = () => new Promise((r) => setTimeout(r, 0));
/* Labels repaint on the next frame (`scheduleFrame`), not synchronously. */
const frame = () => new Promise((r) => setTimeout(r, 60));

/* jsdom has no ResizeObserver. The bar uses it only to decide what spills into
   "More" at narrow widths, which none of these tests are about. */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function mount(start: string, leads?: Record<string, string>) {
  const current = signal(start);
  const selected: string[] = [];
  const el = createDeskBar({
    desks: DESKS,
    current: () => current(),
    onSelect: (id) => {
      selected.push(id);
      current.set(id);
    },
    ctx: { commands: createCommands(), keymap: createKeymap() },
    ...(leads ? { leads } : {}),
  });
  document.body.appendChild(el);
  const tab = (group: string) => el.querySelector(`[data-desk="${group}"]`) as HTMLButtonElement;
  return { current, selected, tab };
}

describe("workspaces in the desk bar", () => {
  it("opens a workspace on its first desk the first time", () => {
    const { selected, tab } = mount("briefing");
    tab("Trade").click();
    expect(selected).toEqual(["chart"]);
  });

  it("returns to the desk you last used in that workspace", async () => {
    const { current, selected, tab } = mount("briefing");
    current.set("flow");
    await flush();
    current.set("journal");
    await flush();
    tab("Trade").click();
    expect(selected.at(-1)).toBe("flow");
  });

  it("does not jump away when you click the workspace you are already in", () => {
    const { selected, tab } = mount("chart");
    tab("Trade").click();
    /* It opens the workspace's menu instead of re-selecting a desk. */
    expect(selected).toEqual([]);
  });

  it("keeps the label to the workspace name, so all five always fit", async () => {
    /* "Trade · Flow" was tried and, at 800px, pushed Review and Lab into More. */
    const { current, tab } = mount("chart");
    current.set("flow");
    await frame();
    expect(tab("Trade").textContent).toBe("Trade");
    /* Screen readers still hear which desk is open inside it. */
    expect(tab("Trade").getAttribute("aria-label")).toBe("Trade, Flow");
  });
});

describe("who leads, on the workspace tab", () => {
  /* v59.2: every tab carries its lead (the v5 design); the CURRENT one is
     marked by the tab's selected state, not by being the only one with a lead. */
  it("shows every workspace's lead", async () => {
    const { tab } = mount("chart", { Trade: "AI-led", Review: "AI finds · you judge" });
    await frame();
    const lead = (g: string) => tab(g).querySelector(".desk-tab-lead")?.textContent ?? "";
    expect(lead("Trade")).toBe("AI-led");
    expect(lead("Review")).toBe("AI finds · you judge");
  });

  it("marks the current workspace by its selected state", async () => {
    const { current, tab } = mount("chart", { Trade: "AI-led", Review: "AI finds · you judge" });
    current.set("journal");
    await frame();
    expect(tab("Review").getAttribute("aria-selected")).toBe("true");
    expect(tab("Trade").getAttribute("aria-selected")).toBe("false");
  });
});

describe("the v59 workspaces themselves", () => {
  const groups = groupDesks(VIEWS.map((v) => ({ id: v.id, label: v.label, icon: v.icon, ...("group" in v ? { group: v.group } : {}) })));

  it("ARE IN THE ORDER A TRADE IS WORKED", () => {
    /* SIX SINCE v63.27, and the order is the fact rather than the number.
       `Trade` was split out of `Chart`, which had grown to 10 of 26 desks and,
       counting the inspector cards the tools menu files under it, half of
       everything the terminal can do.

       It sits between Chart and Research because that is the order the work
       happens in: read the price, size what you are about to do against the
       book, and only then go looking for why. Research and Strategy follow as
       the slower half, and Review is last because it judges all of it. */
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Chart",
      "Trade",
      "Research",
      "Strategy",
      "Review",
    ]);
  });

  it("opens Trade on the desk that sizes, not on a calculator", () => {
    /* The first desk in a workspace is where clicking its tab lands, so it has
       to be the one the workspace is named for. */
    expect(groups.find((g) => g.label === "Trade")?.desks[0]?.id).toBe("risk");
  });

  it("open Chart on the chart", () => {
    expect(groups.find((g) => g.label === "Chart")?.desks[0]?.id).toBe("chart");
  });

  it("each say who leads, and no lead names a workspace that does not exist", () => {
    expect(Object.keys(WORKSPACE_LEAD).sort()).toEqual(groups.map((g) => g.label).sort());
    for (const v of Object.values(WORKSPACE_LEAD)) expect(v.length).toBeGreaterThan(0);
  });

  /*
   * THE FACT IS "NOTHING IS LOST", NOT "THERE ARE TWENTY-THREE".
   *
   * This asserted a hardcoded count, so it failed the moment a desk was ADDED
   * — which is not the thing it is guarding against. Worse, a count can stay
   * right while the set is wrong: drop one desk and add another and 23 is
   * still 23. Comparing the ids pins what the name says, and survives every
   * future desk without being edited.
   */
  it("lose no desk in the regrouping", () => {
    const grouped = groups.flatMap((g) => g.desks).map((d) => d.id).sort();
    expect(grouped).toEqual(VIEWS.map((v) => v.id).sort());
  });

  it("put every desk in exactly one workspace", () => {
    const grouped = groups.flatMap((g) => g.desks).map((d) => d.id);
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

type Recalled = Readonly<Record<string, string>>;

describe("where you were, after a restart", () => {
  /** A second mount, as a reload is: a new bar over the same stored map. */
  function mountWith(start: string, recall: () => Recalled, remember: (m: Recalled) => void) {
    const current = signal(start);
    const selected: string[] = [];
    const el = createDeskBar({
      desks: DESKS,
      current: () => current(),
      onSelect: (id: string) => {
        selected.push(id);
        current.set(id);
      },
      ctx: { commands: createCommands(), keymap: createKeymap() },
      recall,
      remember,
    });
    document.body.appendChild(el);
    return {
      current,
      selected,
      tab: (group: string) => el.querySelector(`[data-desk="${group}"]`) as HTMLButtonElement,
    };
  }

  it("REMEMBERS THE DESK, so the morning does not start with re-navigating", async () => {
    /* MEASURED before this: `lastIn` is a `new Map()` inside the factory, so a
       reload puts every workspace back on its FIRST desk. The bar's own header
       argues that a desk two clicks away is a desk nobody uses; a workspace
       that forgets is exactly that, every morning. */
    const store: Record<string, string> = {};
    const recall = (): Recalled => store;
    const remember = (m: Recalled): void => void Object.assign(store, m);

    const first = mountWith("briefing", recall, remember);
    first.current.set("flow");
    await flush();
    /* `briefing` has no group, so it IS its own workspace and records itself —
       `groupDesks` keys a lone desk by its own id. Pinned rather than filtered
       out: a solo workspace remembering itself is the behaviour, not noise. */
    expect(store["Trade"], "nothing was stored when the desk changed").toBe("flow");
    expect(store["briefing"]).toBe("briefing");

    /* The reload. */
    const again = mountWith("briefing", recall, remember);
    again.tab("Trade").click();
    expect(again.selected.at(-1), "the workspace forgot where you were").toBe("flow");
  });

  it("IGNORES A STORED DESK THAT NO LONGER EXISTS", () => {
    /* A desk id is persisted, and desks get renamed and retired. A stored id
       that names nothing must fall back to the workspace's first desk rather
       than selecting a view the shell cannot render — the blank-desk failure
       `views.ts` already guards its ids against. */
    const store: Record<string, string> = { Trade: "a-desk-that-went-away", Review: "learn" };
    const m = mountWith("briefing", () => store, () => {});
    m.tab("Trade").click();
    expect(m.selected.at(-1)).toBe("chart");
    m.tab("Review").click();
    expect(m.selected.at(-1), "a stored id that IS real should still be honoured").toBe("learn");
  });

  it("IGNORES A STORED DESK FILED UNDER THE WRONG WORKSPACE", () => {
    /* Re-grouping moves desks between workspaces, and the stored map is keyed
       by workspace. "Trade: journal" is a real desk in the wrong bucket, which
       would send a click on Trade to a Review desk — worse than forgetting,
       because then the bar highlights neither. */
    const store: Record<string, string> = { Trade: "journal" };
    const m = mountWith("briefing", () => store, () => {});
    m.tab("Trade").click();
    expect(m.selected.at(-1)).toBe("chart");
  });

  it("STILL WORKS WITH NOTHING PASSED, because the store is opt-in", async () => {
    /* No `recall`, no `remember`: the old in-memory behaviour exactly. A
       default that reached a real store is the rule this repository has broken
       six times through three different doors. */
    const { current, selected, tab } = mount("briefing");
    current.set("flow");
    await flush();
    /* Step OUT of Trade before clicking it. A click on the workspace you are
       standing in opens its menu and selects nothing, which is correct and is
       what the first version of this test got wrong. */
    current.set("journal");
    await flush();
    tab("Trade").click();
    expect(selected.at(-1)).toBe("flow");
  });
});
