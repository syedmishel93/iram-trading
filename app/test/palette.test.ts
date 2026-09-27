// @vitest-environment jsdom
/**
 * Candle colour overrides.
 *
 * The property that matters is the one that motivated the design: an
 * un-overridden colour must FOLLOW the theme. Storing "the current green" and
 * calling it a default passes every obvious test and then fails silently the
 * first time someone switches theme, because a stored `#2DBE8E` cannot know it
 * was only ever a default. So `applyPalette` REMOVES the property rather than
 * writing the theme's value into it, and the tests below check the removal
 * specifically.
 */

import { describe, expect, it } from "vitest";
import {
  applyPalette,
  DOWN_VAR,
  effectiveColour,
  isThemePalette,
  readColour,
  THEME_PALETTE,
  toHex,
  UP_VAR,
} from "../src/chart/palette";

const root = (): HTMLElement => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
};

describe("readColour", () => {
  it("accepts six-digit hex", () => {
    expect(readColour("#2DBE8E")).toBe("#2dbe8e");
    expect(readColour("  #ff0000  ")).toBe("#ff0000");
  });

  it("expands three-digit hex", () => {
    expect(readColour("#f0a")).toBe("#ff00aa");
    expect(readColour("#FFF")).toBe("#ffffff");
  });

  it("treats empty as no override, which is the whole point", () => {
    expect(readColour("")).toBeNull();
    expect(readColour("   ")).toBeNull();
  });

  it("rejects anything that is not a plain hex colour", () => {
    // The value is written into a CSS custom property. A strict pattern costs
    // nothing when the control writing it is a colour picker.
    for (const bad of ["red", "rgb(1,2,3)", "#12345", "#gggggg", "red; background: url(x)", "var(--pos)"]) {
      expect(readColour(bad), bad).toBeNull();
    }
  });
});

describe("applyPalette", () => {
  it("writes the colour and derives the wash", () => {
    const el = root();
    applyPalette({ up: "#3fa0ff", down: "#ff7043" }, el);
    expect(el.style.getPropertyValue(UP_VAR)).toBe("#3fa0ff");
    expect(el.style.getPropertyValue(DOWN_VAR)).toBe("#ff7043");
    expect(el.style.getPropertyValue("--candle-up-wash")).toContain("#3fa0ff");
    expect(el.style.getPropertyValue("--candle-up-wash")).toContain("14%");
  });

  /** THE ONE THAT MATTERS. */
  it("REMOVES the property when the override is cleared", () => {
    const el = root();
    applyPalette({ up: "#3fa0ff", down: "#ff7043" }, el);
    applyPalette(THEME_PALETTE, el);
    // Not "set to green" — absent, so the token chain falls through to the
    // theme and keeps following it.
    expect(el.style.getPropertyValue(UP_VAR)).toBe("");
    expect(el.style.getPropertyValue(DOWN_VAR)).toBe("");
    expect(el.style.getPropertyValue("--candle-up-wash")).toBe("");
  });

  it("clears one colour without disturbing the other", () => {
    const el = root();
    applyPalette({ up: "#3fa0ff", down: "#ff7043" }, el);
    applyPalette({ up: "", down: "#ff7043" }, el);
    expect(el.style.getPropertyValue(UP_VAR)).toBe("");
    expect(el.style.getPropertyValue(DOWN_VAR)).toBe("#ff7043");
  });

  it("ignores a malformed value rather than writing it", () => {
    const el = root();
    applyPalette({ up: "not a colour", down: "" }, el);
    expect(el.style.getPropertyValue(UP_VAR)).toBe("");
  });

  it("normalises before writing, so the stored form is predictable", () => {
    const el = root();
    applyPalette({ up: "#ABC", down: "" }, el);
    expect(el.style.getPropertyValue(UP_VAR)).toBe("#aabbcc");
  });

  it("is idempotent", () => {
    const el = root();
    applyPalette({ up: "#3fa0ff", down: "" }, el);
    const once = el.getAttribute("style");
    applyPalette({ up: "#3fa0ff", down: "" }, el);
    expect(el.getAttribute("style")).toBe(once);
  });
});

describe("isThemePalette", () => {
  it("is true only while nothing is overridden", () => {
    expect(isThemePalette(THEME_PALETTE)).toBe(true);
    expect(isThemePalette({ up: "", down: "" })).toBe(true);
    expect(isThemePalette({ up: "#fff", down: "" })).toBe(false);
    expect(isThemePalette({ up: "", down: "#fff" })).toBe(false);
  });

  it("treats a malformed override as no override", () => {
    // It will not be applied, so reporting it as an override would leave the
    // reset action enabled with nothing to reset.
    expect(isThemePalette({ up: "banana", down: "" })).toBe(true);
  });
});

describe("effectiveColour", () => {
  it("reads back an override", () => {
    const el = root();
    applyPalette({ up: "#3fa0ff", down: "#ff7043" }, el);
    expect(effectiveColour("up", el)).toBe("#3fa0ff");
    expect(effectiveColour("down", el)).toBe("#ff7043");
  });

  it("falls through to the theme when nothing is overridden", () => {
    const el = root();
    el.style.setProperty("--pos", "#123456");
    el.style.setProperty("--neg", "#654321");
    expect(effectiveColour("up", el)).toBe("#123456");
    expect(effectiveColour("down", el)).toBe("#654321");
  });

  it("never returns an empty string — a picker cannot render one", () => {
    const el = root();
    expect(effectiveColour("up", el)).toMatch(/^#[0-9a-f]{6}$/);
    expect(effectiveColour("down", el)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("toHex", () => {
  it("passes hex straight through, normalised", () => {
    expect(toHex("#ABCDEF")).toBe("#abcdef");
    expect(toHex("#abc")).toBe("#aabbcc");
  });

  it("resolves a colour the picker cannot take", () => {
    // `--pos` is allowed to be rgb() or a named colour; the swatch needs hex.
    expect(toHex("rgb(18, 52, 86)")).toBe("#123456");
  });

  it("returns null for something that is not a colour", () => {
    expect(toHex("definitely not a colour")).toBeNull();
  });
});
