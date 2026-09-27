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

  it("are five, in the order a trade is worked", () => {
    expect(groups.map((g) => g.label)).toEqual(["Today", "Chart", "Research", "Strategy", "Review"]);
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
