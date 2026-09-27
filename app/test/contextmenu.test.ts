// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachContextMenu, chartPoint, rowSubject } from "../src/ui/contextmenu";
import { createCommands } from "../src/core/commands";
import { createKeymap } from "../src/core/keys";
import type { MenuItem } from "../src/ui/menu";

const ctx = () => ({ commands: createCommands(), keymap: createKeymap() });

const rightClick = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 100,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("attachContextMenu", () => {
  it("opens a menu and suppresses the browser's own", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const items = vi.fn((): MenuItem[] => [{ label: "Alert here", run: () => {} }]);
    attachContextMenu({ host, resolve: () => "subject", items, ctx: ctx() });

    const e = rightClick(host);
    expect(items).toHaveBeenCalledWith("subject", e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector(".menu")).not.toBeNull();
  });

  it("lets the browser menu through when the resolver declines", () => {
    /* Right-clicking a text selection or an input must still give you Copy and
       Paste. A resolver returning null means "not my target". */
    const host = document.createElement("div");
    document.body.appendChild(host);
    attachContextMenu({ host, resolve: () => null, items: () => [], ctx: ctx() });

    const e = rightClick(host);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("lets the browser menu through when there is nothing to show", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    attachContextMenu({ host, resolve: () => "x", items: () => [], ctx: ctx() });

    const e = rightClick(host);
    expect(e.defaultPrevented).toBe(false);
  });

  it("shift-right-click always gives the browser menu", () => {
    /* The standard escape hatch for inspecting an element. */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const items = vi.fn((): MenuItem[] => [{ label: "x", run: () => {} }]);
    attachContextMenu({ host, resolve: () => "x", items, ctx: ctx() });

    const e = rightClick(host, { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(items).not.toHaveBeenCalled();
  });

  it("a second right-click replaces the first menu rather than stacking", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    attachContextMenu({
      host,
      resolve: () => "x",
      items: () => [{ label: "one", run: () => {} }],
      ctx: ctx(),
    });
    rightClick(host);
    rightClick(host, { clientX: 300, clientY: 300 });
    expect(document.querySelectorAll(".menu")).toHaveLength(1);
  });

  it("the disposer detaches the listener", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const items = vi.fn((): MenuItem[] => [{ label: "x", run: () => {} }]);
    const off = attachContextMenu({ host, resolve: () => "x", items, ctx: ctx() });
    off();
    rightClick(host);
    expect(items).not.toHaveBeenCalled();
  });
});

describe("rowSubject", () => {
  it("finds the symbol of the row that was clicked", () => {
    document.body.innerHTML = `<div class="wl-row" data-symbol="ETHUSDT"><span id="cell">1.2</span></div>`;
    const e = new MouseEvent("contextmenu", { bubbles: true });
    document.getElementById("cell")!.dispatchEvent(e);
    expect(rowSubject(e, ".wl-row")).toBe("ETHUSDT");
  });

  it("returns null outside any row", () => {
    document.body.innerHTML = `<div id="loose">x</div>`;
    const e = new MouseEvent("contextmenu", { bubbles: true });
    document.getElementById("loose")!.dispatchEvent(e);
    expect(rowSubject(e, ".wl-row")).toBeNull();
  });

  it("returns null for a row with an empty attribute — a header, typically", () => {
    document.body.innerHTML = `<div class="wl-row" data-symbol=""><span id="c">Symbol</span></div>`;
    const e = new MouseEvent("contextmenu", { bubbles: true });
    document.getElementById("c")!.dispatchEvent(e);
    expect(rowSubject(e, ".wl-row")).toBeNull();
  });
});

describe("chartPoint", () => {
  const viewport = {
    priceAtY: (y: number) => 80_000 - y * 10,
    indexAtX: (x: number) => x / 5,
    plotLeft: 10,
    plotTop: 10,
    plotWidth: 500,
    plotHeight: 300,
  };

  const hostAt = (): HTMLElement => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 400 }) as DOMRect;
    return host;
  };

  it("converts a click inside the plot into a price and an index", () => {
    const e = new MouseEvent("contextmenu", { clientX: 100, clientY: 50 });
    expect(chartPoint(e, hostAt(), viewport)).toEqual({
      price: 79_500,
      index: 20,
      x: 100,
      y: 50,
    });
  });

  it("returns null outside the plot area — an axis is not a price", () => {
    const onAxis = new MouseEvent("contextmenu", { clientX: 560, clientY: 50 });
    expect(chartPoint(onAxis, hostAt(), viewport)).toBeNull();
    const aboveTop = new MouseEvent("contextmenu", { clientX: 100, clientY: 2 });
    expect(chartPoint(aboveTop, hostAt(), viewport)).toBeNull();
  });

  it("returns null when there is no chart yet", () => {
    const e = new MouseEvent("contextmenu", { clientX: 100, clientY: 50 });
    expect(chartPoint(e, hostAt(), null)).toBeNull();
  });

  it("refuses a non-finite price rather than offering to alert on NaN", () => {
    const broken = { ...viewport, priceAtY: () => Number.NaN };
    const e = new MouseEvent("contextmenu", { clientX: 100, clientY: 50 });
    expect(chartPoint(e, hostAt(), broken)).toBeNull();
  });
});
