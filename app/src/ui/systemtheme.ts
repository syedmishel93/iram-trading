/**
 * Following the machine's light/dark setting.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS DID NOT EXIST
 *
 * MEASURED before writing it: the terminal ships SEVEN themes, one of them
 * (`daylight`) a light one, `index.html` already declares
 * `<meta name="color-scheme" content="dark light">` — and **nothing in the tree
 * read `prefers-color-scheme`**. The browser knew; the app never asked. A first
 * run on a machine set to light got the dark theme, and the only way to match
 * the system was to pick a theme by hand and repick it whenever the system
 * flipped.
 *
 * Its sibling query is honoured in 72 rules: `prefers-reduced-motion` drops
 * every `--dur-*` to zero. This one was simply never wired.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RULES
 *
 * 1. AN EXPLICIT CHOICE ALWAYS WINS. A saved theme is a decision, and this
 *    project already records that a layout the operator has saved survives every
 *    redesign. `auto` is a value they can PICK, never something that overrides
 *    what they picked.
 *
 * 2. IT KEEPS FOLLOWING. Resolving once at boot gives a light theme that stays
 *    light when the machine goes dark at sunset — worse than not following at
 *    all, because it looked like it worked.
 *
 * 3. NO `matchMedia` IS NOT LIGHT. jsdom has none and neither do some embedded
 *    webviews. Guessing light there is how a terminal boots white on a trading
 *    floor at four in the morning, so the absence of an answer resolves to the
 *    shipped default.
 */

import { THEMES, type ThemeName } from "./shell/views";

/** What the terminal ships as, and what `auto` means in the dark. */
export const DEFAULT_THEME: ThemeName = "iram";

/** What `auto` means in the light. The one light palette in the set. */
export const LIGHT_THEME: ThemeName = "daylight";

/**
 * What the theme picker offers, `auto` first.
 *
 * FIRST BECAUSE IT IS THE DEFAULT. A list whose default sits seventh reads as
 * seven equal options with an arbitrary winner; a named theme below it is
 * plainly a decision to override the system.
 */
export const THEME_CHOICES: readonly string[] = ["auto", ...THEMES];

/** The stored value: a theme name, or `auto` to follow the system. */
export type ThemeChoice = ThemeName | "auto";

const KNOWN: ReadonlySet<string> = new Set(THEMES);

/**
 * The theme to actually apply.
 *
 * IT ALWAYS RETURNS A REAL THEME NAME. `data-theme="auto"` matches no rule in
 * `tokens.css`, so every custom property would fall through to whatever `:root`
 * carries — and an undefined custom property INHERITS rather than being
 * ignored, which this project has already measured turning a trust dot
 * completely invisible. A value that no longer exists resolves the same way, so
 * a theme removed in a later version cannot leave the app unstyled.
 */
export function resolveTheme(stored: string, systemDark: boolean): ThemeName {
  if (stored !== "auto" && KNOWN.has(stored)) return stored as ThemeName;
  if (stored === "auto") return systemDark ? DEFAULT_THEME : LIGHT_THEME;
  return DEFAULT_THEME;
}

/**
 * Call `onChange` with the system's current setting, and again whenever it
 * changes. Returns a disposer.
 *
 * THE FIRST CALL IS SYNCHRONOUS, because a watcher that waits for a change
 * leaves the first paint wrong until the operator happens to flip their
 * machine's setting — which for most people is never.
 *
 * `media` is a parameter so a test can drive it. NO LIVE DEFAULT is the rule
 * this project keeps relearning, and here the default is `window.matchMedia`,
 * which is inert: it reads a preference and reaches nothing.
 */
export function watchSystemTheme(
  onChange: (systemDark: boolean) => void,
  media: typeof window.matchMedia | undefined = typeof window === "undefined"
    ? undefined
    : window.matchMedia?.bind(window),
): () => void {
  let mql: MediaQueryList | null = null;
  try {
    mql = media ? media("(prefers-color-scheme: dark)") : null;
  } catch {
    mql = null;
  }

  if (mql === null) {
    /* NOT A GUESS OF LIGHT. See the header: the absence of an answer resolves
       to what the terminal ships as. */
    onChange(true);
    return () => {};
  }

  const handler = (e: MediaQueryListEvent | MediaQueryList): void => {
    onChange(e.matches);
  };
  onChange(mql.matches);

  /* `addListener` is the deprecated form and the only one some webviews have.
     Both are tried, and the disposer removes whichever was attached. */
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler as (e: Event) => void);
    return () => mql?.removeEventListener("change", handler as (e: Event) => void);
  }
  const legacy = mql as unknown as {
    addListener?: (fn: (e: MediaQueryListEvent) => void) => void;
    removeListener?: (fn: (e: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener?.(handler);
  return () => legacy.removeListener?.(handler);
}
