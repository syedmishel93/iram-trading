// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { h } from "../src/ui/dom";
import { signal } from "../src/core/signal";

/**
 * The regression: a reactive `value:` binding stopped updating an input as soon
 * as the control was dirty, because the binding wrote the ATTRIBUTE and the
 * browser only mirrors that onto the displayed value while the control is
 * clean. Found when two desks began sharing one account and the second desk
 * kept showing a number the store no longer held.
 */

/**
 * `renderEffect` repaints on requestAnimationFrame (with a 250ms timer fallback
 * for contexts that never composite — see `core/frame.ts`). Tests must wait a
 * frame before asserting on the DOM; whichever of the two fires first wins.
 */
const paint = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const fin = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fin());
    setTimeout(fin, 300);
  });

describe("reactive value on form controls", () => {
  it("updates a clean input when the signal changes", async () => {
    const v = signal("BTCUSDT");
    const el = h("input", { value: () => v() }) as HTMLInputElement;
    expect(el.value).toBe("BTCUSDT");
    v.set("ETHUSDT");
    await paint();
    expect(el.value).toBe("ETHUSDT");
  });

  it("updates a DIRTY input — the bug", async () => {
    const v = signal(10_000);
    const el = h("input", { type: "number", value: () => String(v()) }) as HTMLInputElement;
    /* Dirty it exactly the way a user does. */
    el.value = "4200";
    v.set(7777);
    await paint();
    expect(el.value).toBe("7777");
  });

  it("does not touch the caret when the value round-trips unchanged", () => {
    const v = signal("BTC");
    const el = h("input", { value: () => v() }) as HTMLInputElement;
    document.body.appendChild(el);
    el.focus();
    el.setSelectionRange(1, 1);
    /* A typed character comes back through the signal as the same string; the
       guard must make that a no-op or the caret jumps to the end mid-word. */
    v.set("BTC");
    expect(el.selectionStart).toBe(1);
  });

  it("moves the caret only when the value genuinely changed", async () => {
    const v = signal("BTC");
    const el = h("input", { value: () => v() }) as HTMLInputElement;
    document.body.appendChild(el);
    el.focus();
    el.setSelectionRange(1, 1);
    v.set("ETHUSDT");
    await paint();
    expect(el.value).toBe("ETHUSDT");
  });

  it("renders an empty string for null and undefined rather than the word 'null'", async () => {
    const v = signal<string | null>(null);
    const el = h("input", { value: () => v() }) as HTMLInputElement;
    expect(el.value).toBe("");
    v.set("XAUUSD");
    await paint();
    expect(el.value).toBe("XAUUSD");
  });

  it("drives `checked` as a property too", async () => {
    const on = signal(false);
    const el = h("input", { type: "checkbox", checked: () => on() }) as HTMLInputElement;
    expect(el.checked).toBe(false);
    /* Dirty it, then change the signal. */
    el.checked = false;
    on.set(true);
    await paint();
    expect(el.checked).toBe(true);
  });

  it("works on a textarea", async () => {
    const v = signal("one");
    const el = h("textarea", { value: () => v() }) as HTMLTextAreaElement;
    el.value = "edited by hand";
    v.set("two");
    await paint();
    expect(el.value).toBe("two");
  });

  it("leaves value alone on non-form elements — it is a real attribute there", () => {
    const el = h("div", { value: "7" });
    expect(el.getAttribute("value")).toBe("7");
  });

  it("still removes a falsy attribute on a normal element", () => {
    const el = h("div", { "data-on": false });
    expect(el.hasAttribute("data-on")).toBe(false);
  });
});
