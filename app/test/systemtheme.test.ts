/**
 * FOLLOWING THE SYSTEM'S LIGHT/DARK SETTING.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING
 *
 * MEASURED: this terminal ships SEVEN themes, one of which (`daylight`) is a
 * light one, and **nothing in the tree reads `prefers-color-scheme`**. The
 * document already declares `<meta name="color-scheme" content="dark light">`,
 * so the browser knows; the app never asked. A first run on a machine set to
 * light mode gets the dark theme and no way to say "match my system" short of
 * picking a theme by hand and repicking it every time the system flips.
 *
 * `prefers-reduced-motion` is honoured in 72 rules. The sibling query was simply
 * never wired.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RULES IT HAS TO FOLLOW
 *
 * 1. **AN EXPLICIT CHOICE ALWAYS WINS.** A saved theme is a decision, and this
 *    project already records that a layout the operator has saved survives every
 *    redesign. `auto` is a value they can choose, never something that overrides
 *    what they chose.
 *
 * 2. **IT KEEPS FOLLOWING.** Resolving once at boot would be a light theme that
 *    stays light when the machine goes dark at sunset — worse than not following
 *    at all, because it looked like it worked.
 *
 * 3. **NO MATCHMEDIA IS NOT DARK.** An environment without `matchMedia` (jsdom,
 *    an old webview) must fall back to the shipped default rather than guessing,
 *    which is how a terminal comes to boot white on a trading floor.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  LIGHT_THEME,
  resolveTheme,
  watchSystemTheme,
  LIGHT_THEMES,
  appearanceOf,
  nextAppearance,
} from "../src/ui/systemtheme";
import { readFileSync } from "node:fs";
import { THEMES } from "../src/ui/shell/views";

/** A fake `matchMedia` with a controllable match and listener set. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.delete(fn);
    },
  };
  return {
    matchMedia: (() => mql) as unknown as typeof window.matchMedia,
    flip(next: boolean) {
      mql.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
    listenerCount: () => listeners.size,
  };
}

describe("resolveTheme", () => {
  it("PASSES AN EXPLICIT CHOICE STRAIGHT THROUGH", () => {
    /* The saved theme is a decision. Nothing here may override it. */
    for (const t of THEMES) {
      expect(resolveTheme(t, true)).toBe(t);
      expect(resolveTheme(t, false)).toBe(t);
    }
  });

  it("maps auto to the light theme when the system is light", () => {
    expect(resolveTheme("auto", false)).toBe(LIGHT_THEME);
  });

  it("maps auto to the shipped dark theme when the system is dark", () => {
    expect(resolveTheme("auto", true)).toBe(DEFAULT_THEME);
  });

  it("RESOLVES TO A REAL THEME, always", () => {
    /* `data-theme="auto"` matches no rule in `tokens.css`, so the palette would
       fall back to whatever `:root` happens to carry — an undefined custom
       property INHERITS rather than being ignored, which this project has
       already measured turning a trust dot invisible. */
    const named = new Set<string>(THEMES);
    expect(named.has(resolveTheme("auto", true))).toBe(true);
    expect(named.has(resolveTheme("auto", false))).toBe(true);
  });

  it("falls back to the shipped default for a stored value that no longer exists", () => {
    // A theme removed in a later version must not leave the app unstyled.
    expect(resolveTheme("a-theme-that-was-deleted", true)).toBe(DEFAULT_THEME);
  });
});

describe("watchSystemTheme", () => {
  it("REPORTS THE CURRENT SETTING IMMEDIATELY, not only on the next change", () => {
    /* A watcher that waits for a change leaves the first paint wrong until the
       operator happens to flip their machine's setting. */
    const m = fakeMedia(false);
    const seen: boolean[] = [];
    watchSystemTheme((dark) => seen.push(dark), m.matchMedia);
    expect(seen).toEqual([false]);
  });

  it("KEEPS FOLLOWING after the first read", () => {
    /* Resolving once at boot is a light theme that stays light when the machine
       goes dark at sunset — and looks like it worked. */
    const m = fakeMedia(true);
    const seen: boolean[] = [];
    watchSystemTheme((dark) => seen.push(dark), m.matchMedia);
    m.flip(false);
    m.flip(true);
    expect(seen).toEqual([true, false, true]);
  });

  it("STOPS LISTENING when disposed, so a remount does not stack watchers", () => {
    const m = fakeMedia(true);
    const stop = watchSystemTheme(() => {}, m.matchMedia);
    expect(m.listenerCount()).toBe(1);
    stop();
    expect(m.listenerCount()).toBe(0);
  });

  it("NO MATCHMEDIA IS NOT DARK — it reports the shipped default and does not throw", () => {
    /* jsdom has no `matchMedia`, and neither do some embedded webviews. Guessing
       light there is how a terminal boots white on a trading floor. */
    const seen: boolean[] = [];
    const stop = watchSystemTheme((dark) => seen.push(dark), undefined);
    expect(seen).toEqual([true]);
    expect(() => stop()).not.toThrow();
  });

  it("survives a matchMedia that throws rather than taking the app down with it", () => {
    const throwing = (() => {
      throw new Error("no");
    }) as unknown as typeof window.matchMedia;
    const seen: boolean[] = [];
    expect(() => watchSystemTheme((d) => seen.push(d), throwing)).not.toThrow();
    expect(seen).toEqual([true]);
  });

  it("does not call back after disposal", () => {
    const m = fakeMedia(true);
    const fn = vi.fn();
    const stop = watchSystemTheme(fn, m.matchMedia);
    stop();
    m.flip(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("WHICH THEMES ARE LIGHT is owned by the stylesheet", () => {
  /* A hand-written list that nothing compared would be right today and wrong the
     first time a light theme is added — and the symptom is a toggle that claims
     to switch to light and stays dark. `tokens.css` declares every theme's base
     surface; this reads it and works the answer out. */
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

  const luminance = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    /* Rec. 709 relative luminance, which is what "is this light" means to an eye
       rather than to an average of three channels. */
    return (0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)) / 255;
  };

  const fromCss = new Set<string>();
  const re = /\[data-theme="(\w+)"\]\s*\{[^}]*?--p-bg-base:\s*(#[0-9A-Fa-f]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tokens)) !== null) {
    if (luminance(m[2] as string) > 0.5) fromCss.add(m[1] as string);
  }

  it("PARSES THE STYLESHEET AT ALL, or it is checking nothing", () => {
    const declared = [...tokens.matchAll(/\[data-theme="(\w+)"\]\s*\{[^}]*?--p-bg-base:/g)];
    expect(declared.length, "found no theme base surfaces in tokens.css").toBeGreaterThan(5);
  });

  it("agrees with the stylesheet about every theme", () => {
    expect([...LIGHT_THEMES].sort()).toEqual([...fromCss].sort());
  });
});

describe("the light/dark toggle", () => {
  it("reads a stored theme as one of the three states", () => {
    expect(appearanceOf("auto")).toBe("auto");
    expect(appearanceOf(LIGHT_THEME)).toBe("light");
    expect(appearanceOf(DEFAULT_THEME)).toBe("dark");
    expect(appearanceOf("tradingview")).toBe("dark");
  });

  it("CYCLES THROUGH ALL THREE, so auto is reachable in one press", () => {
    /* `auto` is the default for a fresh install and is otherwise only reachable
       by opening Settings. A two-way toggle would throw it away the first time
       anybody pressed the button and give them no way back. */
    const a = nextAppearance("auto");
    expect(a.appearance).toBe("light");
    const b = nextAppearance(a.theme);
    expect(b.appearance).toBe("dark");
    const c = nextAppearance(b.theme);
    expect(c.appearance).toBe("auto");
    expect(c.theme).toBe("auto");
  });

  it("REMEMBERS WHICH DARK THEME, rather than always landing on the default", () => {
    /* Six of the seven themes are dark. An operator who chose `tradingview` and
       pressed this twice would silently be moved to `iram` and have to find
       Settings to get back. */
    const toDark = nextAppearance(LIGHT_THEME, "tradingview");
    expect(toDark.theme).toBe("tradingview");
  });

  it("falls back to the shipped dark theme when the remembered one is light or unknown", () => {
    expect(nextAppearance(LIGHT_THEME, LIGHT_THEME).theme).toBe(DEFAULT_THEME);
    expect(nextAppearance(LIGHT_THEME, "nonsense").theme).toBe(DEFAULT_THEME);
  });

  it("ALWAYS STORES SOMETHING resolveTheme can render", () => {
    let cur = "auto";
    const named = new Set<string>([...THEMES, "auto"]);
    for (let i = 0; i < 7; i++) {
      cur = nextAppearance(cur).theme;
      expect(named.has(cur), cur + " is not a storable value").toBe(true);
      expect(new Set<string>(THEMES).has(resolveTheme(cur, true))).toBe(true);
    }
  });
});
