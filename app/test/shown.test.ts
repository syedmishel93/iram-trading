// @vitest-environment jsdom
/**
 * `isShown` — the card poll guard. The defect it replaces: cards polled on
 * `isConnected`, which stays true for a card hidden by an attribute or by a
 * `display: none` ancestor (a removed card, a shut inspector).
 */

import { afterEach, describe, expect, it } from "vitest";
import { isShown } from "../src/ui/cards/shown";

const box = (el: Element, rects: number): void => {
  Object.defineProperty(el, "getClientRects", { configurable: true, value: () => ({ length: rects }) });
};

afterEach(() => document.body.replaceChildren());

describe("isShown", () => {
  it("is false for a card that is connected but not rendered — the old guard said true", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    box(el, 0);
    expect(el.isConnected).toBe(true);
    expect(isShown(el)).toBe(false);
  });

  it("is true for a connected card with a box", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    box(el, 1);
    expect(isShown(el)).toBe(true);
  });

  it("is false for a detached card even if something reports a box", () => {
    const el = document.createElement("div");
    box(el, 1);
    expect(isShown(el)).toBe(false);
  });
});
