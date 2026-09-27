/**
 * Candle colour overrides.
 *
 * WHY AN OVERRIDE AND NOT A SETTING THAT HOLDS THE COLOUR
 * The obvious design stores two hex strings and paints with them. It has one
 * flaw that only shows up later: the moment a colour is stored, the theme stops
 * mattering. Switch from the dark theme to Daylight and the candles keep the
 * greens picked for a black background, because a stored `#2DBE8E` cannot know
 * it was only ever the default.
 *
 * So the stored value is an OVERRIDE, and its empty state is "whatever the theme
 * says". Nothing is written until someone picks a colour; clearing it restores
 * the theme rather than restoring a hardcoded green that happened to match one
 * theme in five.
 *
 * HOW IT REACHES THE CANVAS
 * By writing two CSS custom properties on `:root` — not by threading a colour
 * through the chart's API. `themeFromCss` already reads `--candle-up` and
 * `--candle-down`, and `tokens.css` already defaults them to `--pos`/`--neg`,
 * so an override is a variable assignment and every consumer picks it up on the
 * next theme read. The alternative — an extra argument on `setTheme` — would put
 * the same value in two places and give them a chance to disagree.
 *
 * WHY IT IS NOT `--pos` AND `--neg`
 * Those also colour a P&L figure, a passing gate, a rising correlation and the
 * heat bar. Someone who wants blue-and-orange candles has said nothing about
 * whether a winning trade should stop being green, and quietly recolouring the
 * whole terminal from a chart setting is the kind of surprise that makes people
 * stop touching settings.
 */

/** The two colours a candle is drawn in. Empty string means "use the theme". */
export interface CandlePalette {
  readonly up: string;
  readonly down: string;
}

export const THEME_PALETTE: CandlePalette = { up: "", down: "" };

/**
 * Accept a colour, or reject it.
 *
 * `#rgb` and `#rrggbb` only. Deliberately narrow: the value is written straight
 * into a CSS custom property, and a custom property will happily accept
 * `red; background: url(...)` — CSS does not evaluate it as script, but it does
 * let a malformed value leak out of the declaration it was meant for. A strict
 * pattern costs nothing here because the control that writes it is a colour
 * picker, and it means a hand-typed value is either a colour or is ignored.
 *
 * Returns the normalised six-digit lower-case form, or null.
 */
export function readColour(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    const r = v[1] as string;
    const g = v[2] as string;
    const b = v[3] as string;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

/** The custom properties an override writes. */
export const UP_VAR = "--candle-up";
export const DOWN_VAR = "--candle-down";
const UP_WASH_VAR = "--candle-up-wash";
const DOWN_WASH_VAR = "--candle-down-wash";

/**
 * What the chart is painting with right now, whether or not it is overridden.
 *
 * Reads the RESOLVED value, so an un-overridden colour comes back as the theme's
 * own — which is what a colour picker has to show. A picker sitting on `#000000`
 * because the override happens to be empty is the control lying about the state
 * it is editing.
 */
export function effectiveColour(
  which: "up" | "down",
  root: HTMLElement = document.documentElement,
): string {
  const raw = getComputedStyle(root).getPropertyValue(which === "up" ? UP_VAR : DOWN_VAR).trim();
  return readColour(raw) ?? fallbackFor(which, root);
}

/**
 * The theme's own colour, for when the resolved value is not a plain hex.
 *
 * `--pos` can legitimately be `rgb(...)`, a named colour, or a `color-mix`. The
 * picker needs six hex digits, so this asks the browser to resolve whatever it
 * is by painting it and reading it back.
 */
function fallbackFor(which: "up" | "down", root: HTMLElement): string {
  const raw = getComputedStyle(root).getPropertyValue(which === "up" ? "--pos" : "--neg").trim();
  return toHex(raw) ?? (which === "up" ? "#2dbe8e" : "#f0616d");
}

/**
 * Any CSS colour to `#rrggbb`, via the browser's own parser.
 *
 * Returns null when the string is not a colour at all, so a malformed token can
 * never reach a control as though it were one.
 */
export function toHex(css: string, doc: Document = document): string | null {
  const direct = readColour(css);
  if (direct) return direct;
  const probe = doc.createElement("span");
  probe.style.color = "";
  probe.style.color = css;
  if (probe.style.color === "") return null;

  doc.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(resolved);
  if (!m) return null;
  const hex = (n: string): string => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1] as string)}${hex(m[2] as string)}${hex(m[3] as string)}`;
}

/**
 * Push the override onto the document, or take it off.
 *
 * The washes are derived rather than stored: they are the same colour at 14%,
 * used for volume bars and zone fills, and a stored pair would be a second thing
 * to keep in step with the first for no benefit.
 */
export function applyPalette(
  palette: CandlePalette,
  root: HTMLElement = document.documentElement,
): void {
  const set = (colourVar: string, washVar: string, raw: string): void => {
    const colour = readColour(raw);
    if (colour === null) {
      /* Removing the property is what restores the theme. Setting it to the
         theme's CURRENT colour would look identical and then fail to follow the
         next theme change — the bug this module's header is about. */
      root.style.removeProperty(colourVar);
      root.style.removeProperty(washVar);
      return;
    }
    root.style.setProperty(colourVar, colour);
    root.style.setProperty(washVar, `color-mix(in srgb, ${colour} 14%, transparent)`);
  };

  set(UP_VAR, UP_WASH_VAR, palette.up);
  set(DOWN_VAR, DOWN_WASH_VAR, palette.down);
}

/** True when neither colour is overridden — the theme is in charge. */
export function isThemePalette(palette: CandlePalette): boolean {
  return readColour(palette.up) === null && readColour(palette.down) === null;
}
