/**
 * The icon set.
 *
 * WHAT WAS WRONG WITH WHAT THIS REPLACES
 * The terminal drew its icons with Unicode glyphs — ◢ ▤ ◈ ⌗ ◎ ▦ ⊞ ⌖ ⇥ ⌕ ⛶ — and
 * two of them were EMOJI (🧲 🗑). Three problems, all visible at a glance:
 *
 *  1. Emoji render in full colour at a weight the font decides, so two buttons
 *     in the same toolbar had different colours and different visual mass than
 *     every other button. Nothing in CSS could bring them into line.
 *  2. Every glyph came from whichever font on the machine happened to have it,
 *     so stroke weight, optical size and baseline were inconsistent BETWEEN
 *     ICONS and different on every operating system.
 *  3. A glyph is text. It scales with the type ramp, inherits letter-spacing,
 *     and cannot be given a stroke width — so it could never be made to match
 *     the interface around it.
 *
 * THE RULES HERE, WHICH ARE WHAT MAKE A SET LOOK LIKE A SET
 *  - One 16×16 grid. Every path is drawn on it; nothing is scaled from another.
 *  - One stroke weight (1.5), round caps, round joins. No filled shapes except
 *    where a dot is genuinely the subject.
 *  - `currentColor` throughout, so an icon takes the colour of the control it
 *    sits in and needs no per-state rules.
 *  - Geometry aligned to half-pixels at 16px, so strokes land on the pixel grid
 *    instead of straddling it and going soft.
 */

const NS = "http://www.w3.org/2000/svg";

/** Path data for every icon, on a 16×16 grid. */
const PATHS: Readonly<Record<string, readonly string[]>> = {
  /* --- navigation ----------------------------------------------------- */
  briefing: ["M2.5 2.5h5v4h-5z", "M8.5 2.5h5v4h-5z", "M2.5 9.5h5v4h-5z", "M8.5 9.5h5v4h-5z"],
  /* Four rungs of a ladder, longest at the bottom: the study narrows as it
     goes — every series, then the joint window, then the training split, then
     the one finding that survived. */
  study: ["M2.5 3.5h11", "M3.5 6.5h9", "M4.5 9.5h7", "M6 12.5h4"],
  chart: ["M2 13.5V2.5", "M2 13.5h12", "M4.5 11V7", "M7 11V4", "M9.5 11V8.5", "M12 11V5.5"],
  signals: ["M2 8h2.5l2-4 3 8 2-4H14"],
  strategy: ["M2.5 12.5 6 9l2.5 2L13.5 5", "M10.5 5h3v3"],
  /* Three columns of differing height inside a frame — a grid of cells, some
     tall and some short, which is what a condition survey actually is. */
  survey: ["M2 2.5v11h12", "M4.5 11.5V8", "M8 11.5V4.5", "M11.5 11.5V6.5"],
  risk: ["M8 2 2.5 4.5v4c0 3 2.3 5 5.5 5.5 3.2-.5 5.5-2.5 5.5-5.5v-4L8 2Z", "M8 6v3", "M8 11h.01"],
  /* A calculator: keypad body, display, and one column of keys. */
  /* Nested blocks — structure inside structure. */
  smart: ["M2 11.5h3.5v3H2z", "M6.5 7h3.5v7.5H6.5z", "M11 3h3v11.5h-3z"],
  /* A ledger sheet with a tick — practice trades, written down. */
  paper: ["M3.5 2h9v12h-9z", "M6 5.5h4M6 8h4", "M6 11l1.2 1.2L10 9.5"],
  /* A star: the list you keep. */
  watchlist: ["M8 2 9.9 6.1l4.6.6-3.3 3.2.8 4.5L8 12.3 4 14.4l.8-4.5L1.5 6.7l4.6-.6z"],
  /* A clock face — sessions are a question about the time of day. */
  sessions: ["M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "M8 4.5V8l2.5 1.5"],
  /* A playbook: bound pages with a rule marked on them. */
  playbook: ["M3 3.5h4.5A1.5 1.5 0 0 1 9 5v8a1.5 1.5 0 0 0-1.5-1.5H3z", "M13 3.5H8.5A1.5 1.5 0 0 0 7 5v8a1.5 1.5 0 0 1 1.5-1.5H13z", "M10.5 6.5h1"],
  calculator: ["M3.5 1.5h9v13h-9z", "M5.5 4h5", "M5.5 7h1.5M5.5 10h1.5M5.5 12.5h1.5", "M9.5 7h1.5M9.5 10v2.5"],
  screener: ["M2.5 3.5h11", "M2.5 8h11", "M2.5 12.5h11", "M5.5 2v3", "M9.5 6.5v3", "M6.5 11v3"],
  flow: ["M2 5h7", "M7 3 9 5 7 7", "M14 11H7", "M9 9l-2 2 2 2"],
  data: ["M8 2c3 0 5 .9 5 2s-2 2-5 2-5-.9-5-2 2-2 5-2Z", "M3 4v8c0 1.1 2 2 5 2s5-.9 5-2V4", "M3 8c0 1.1 2 2 5 2s5-.9 5-2"],
  analyst: ["M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z", "M8 2v12", "M8 5.5a2.5 2.5 0 0 1 0 5"],
  workspace: ["M2.5 2.5h11v11h-11z", "M8 2.5v11", "M8 8h5.5"],
  decision: ["M8 2 14 8l-6 6-6-6 6-6Z", "M8 5.5v3", "M8 10.5h.01"],

  /* --- chrome --------------------------------------------------------- */
  search: ["M7.25 12a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Z", "M10.75 10.75 13.5 13.5"],
  bell: ["M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z", "M6.75 12a1.5 1.5 0 0 0 2.5 0"],
  dock: ["M2.5 3h11v10h-11z", "M10 3v10"],
  focus: ["M2.5 6V3h3", "M10.5 3h3v3", "M13.5 10v3h-3", "M5.5 13h-3v-3"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
  /* v59.2 card controls and card glyphs. */
  pin: ["M6 2.5h4l-.6 4 2.6 2H4l2.6-2z", "M8 8.5V14"],
  plus: ["M8 3v10", "M3 8h10"],
  sparkle: ["M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z"],
  calendar: ["M2.5 3.5h11v10h-11z", "M2.5 6.5h11", "M5.5 2v3", "M10.5 2v3"],
  news: ["M3 2.5h10v11H3z", "M5.5 5.5h5", "M5.5 8h5", "M5.5 10.5h3"],
  levels: ["M2 4.5h12", "M2 8h12", "M2 11.5h12"],
  whale: ["M2 9c2.5-4 9.5-4 12 0-2.5 2.6-9.5 2.6-12 0z", "M14 9l1.5-2"],
  drawer: ["M2.5 3h11v10h-11z", "M2.5 10h11"],
  chevronRight: ["M6.5 3.5 11 8l-4.5 4.5"],
  chevronLeft: ["M9.5 3.5 5 8l4.5 4.5"],
  chevronDown: ["M3.5 6.5 8 11l4.5-4.5"],
  check: ["M3 8.5 6.5 12 13 4.5"],
  settings: ["M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"],
  refresh: ["M13 8a5 5 0 1 1-1.6-3.7", "M13.5 2v3h-3"],
  download: ["M8 2.5v7", "M5 7l3 3 3-3", "M3 12.5h10"],
  copy: ["M5.5 5.5h8v8h-8z", "M10.5 5.5v-3h-8v8h3"],

  /* --- drawing -------------------------------------------------------- */
  cursor: ["M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3", "M8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  trendline: ["M3 12.5 13 3.5", "M3 13.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", "M13 4.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  ray: ["M2.5 12.5 13.5 3.5", "M9.5 3.5h4v4"],
  hline: ["M2 8h12", "M5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  vline: ["M8 2v12", "M9 5a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z"],
  rect: ["M2.5 4.5h11v7h-11z"],
  fib: ["M2 4h12", "M2 7h12", "M2 10h12", "M2 13h12", "M2 4v9"],
  measure: ["M8 2.5v11", "M5.5 5 8 2.5 10.5 5", "M5.5 11 8 13.5 10.5 11", "M2.5 8h2"],
  note: ["M4 3.5h8", "M8 3.5v9", "M6 12.5h4"],
  channel: ["M2 10.5 10.5 2", "M5.5 14 14 5.5", "M2 10.5 5.5 14", "M10.5 2 14 5.5"],
  pitchfork: ["M8 14.5V8", "M3.5 8h9", "M3.5 8V3", "M8 8V3", "M12.5 8V3"],
  fibext: ["M2 13.5h12", "M2 10h12", "M2 6.5h12", "M8 5.5V1.5", "M6 3.5 8 1.5l2 2"],
  position: ["M2.5 3h11v4.5h-11z", "M2.5 8.5h11V13h-11z", "M1.5 8h13"],
  arrow: ["M3 13 12.5 3.5", "M7.5 3.5h5v5"],
  magnet: ["M4 3v5a4 4 0 0 0 8 0V3", "M4 3h3v5a1 1 0 0 0 2 0V3h3", "M4 6h3M9 6h3"],
  undo: ["M3 8a5 5 0 1 1 1.6 3.7", "M2.5 4.5v3h3"],
  redo: ["M13 8a5 5 0 1 0-1.6 3.7", "M13.5 4.5v3h-3"],
  trash: ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5 5 13.5h6l.5-9", "M7 7v4M9 7v4"],
  /* Auto-detect: a reticle with a structure line found inside it. The corners
     say "looking", the line says what it found — a plain magnifier would have
     read as search, which is the omnibox's job. */
  detect: [
    "M2.5 5.5v-3h3", "M13.5 5.5v-3h-3", "M2.5 10.5v3h3", "M13.5 10.5v3h-3",
    "M5 10l2-2.5L9 9l2-3.5",
  ],
  /* Volume: histogram bars of unequal height sitting on a baseline. */
  volume: ["M2.5 13.5h11", "M4 13.5V9", "M6.5 13.5V5", "M9 13.5V10.5", "M11.5 13.5V7"],
  /* Studies: two bands around a line. The bands are the point — everything in
     the registry that is not a plain moving average is an envelope of some
     kind, and a single sloping line would read as the EMA control next to it. */
  /* "fx" — the mark every charting package uses for the indicator library.
     Drawn rather than set as text so it inherits the same stroke weight as its
     neighbours in the toolbar; a <text> node at 16px renders at a different
     visual weight from the paths beside it and reads as a different family. */
  indicators: [
    "M8.2 3.2c-1.6-.8-2.6.2-2.6 1.8V13",
    "M4 7h3.6",
    "M10 8.6l3.6 4.4",
    "M13.6 8.6L10 13",
  ],
  studies: [
    "M2 5.5C4.5 5.5 5.5 3 8 3s3.5 2.5 6 2.5",
    "M2 10.5c2.5 0 3.5-2.5 6-2.5s3.5 2.5 6 2.5",
    "M2 8c2.5 0 3.5-2.5 6-2.5S11.5 8 14 8",
  ],
  /* A distribution with a fitted curve over it. The quant desk is about
     fitting a model to a spread of outcomes, and a bell curve is the one
     shape that reads as that rather than as another price chart. */
  quant: [
    "M2 13c2.5 0 3-8 6-8s3.5 8 6 8",
    "M2 13h12",
    "M5.5 13v-2.5M8 13V6.5M10.5 13v-2.5",
  ],
  /* Learning. A tally — four strokes and the fifth struck through — because
     that is what this desk holds: a count of things claimed and marked, kept
     by hand. Deliberately NOT a brain, a chip or a sparkline: every one of
     those promises a model doing the thinking, and the whole argument of the
     desk is that what is stored is a record rather than an intelligence. */
  learn: ["M3.5 4.5v7", "M6.5 4.5v7", "M9.5 4.5v7", "M12.5 4.5v7", "M2.5 12.5 13.5 3.5"],

  splitRight: ["M2.5 3h11v10h-11z", "M8 3v10"],
  splitDown: ["M2.5 3h11v10h-11z", "M2.5 8h11"],

  /* --- replay --------------------------------------------------------- */
  play: ["M5 3.5 12 8l-7 4.5V3.5Z"],
  pause: ["M6 3.5v9M10 3.5v9"],
  stepBack: ["M10.5 3.5 5.5 8l5 4.5V3.5Z", "M4 3.5v9"],
  stepForward: ["M5.5 3.5 10.5 8l-5 4.5V3.5Z", "M12 3.5v9"],
  jumpBack: ["M8 3.5 3.5 8 8 12.5V3.5Z", "M13 3.5 8.5 8l4.5 4.5V3.5Z"],
  jumpForward: ["M8 3.5 12.5 8 8 12.5V3.5Z", "M3 3.5 7.5 8 3 12.5V3.5Z"],
  live: ["M2.5 11.5 6 7l3 3 4.5-6", "M13.5 4v3h-3"],

  /* --- brand ---------------------------------------------------------- */
  brand: ["M3 13h10L3 3v10Z"],
};

export type IconName = keyof typeof PATHS;

/** Icons drawn as a solid shape rather than a stroke. */
const FILLED = new Set<string>(["play", "stepBack", "stepForward", "jumpBack", "jumpForward", "brand"]);

/** Sub-paths that are dots or handles and want filling inside a stroked icon. */
const DOT = /^M(\d|\d\.\d)+ (\d|\d\.\d)+a1 1 0 1 0/;

export interface IconOptions {
  /** Rendered size in px. The grid is 16; other sizes scale the whole path. */
  readonly size?: number;
  /** Extra class on the <svg>. */
  readonly className?: string;
  /**
   * Accessible name. OMIT IT when the icon sits inside a control that already
   * has a label or a title — a button announced twice is worse than one
   * announced once, and that is the usual outcome of decorating everything.
   */
  readonly title?: string;
}

/**
 * Build one icon.
 *
 * Returns an `<svg>`, not a string, so nothing here can inject markup — the
 * same reason the palette builds its highlights from text nodes.
 */
export function icon(name: IconName, opts: IconOptions = {}): SVGSVGElement {
  const size = opts.size ?? 16;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", `icon${opts.className ? ` ${opts.className}` : ""}`);
  /* Decorative by default. A control's own label is the accessible name; an
     icon repeating it makes a screen reader say everything twice. */
  if (opts.title) {
    svg.setAttribute("role", "img");
    const t = document.createElementNS(NS, "title");
    t.textContent = opts.title;
    svg.appendChild(t);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }

  const filled = FILLED.has(name);
  /* `noUncheckedIndexedAccess` makes even a keyof-derived lookup optional. An
     empty fallback is the right failure: a missing icon should be an invisible
     gap, never a thrown error inside a render effect. */
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    if (filled || DOT.test(d)) {
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
  }

  return svg;
}

/** Every icon name, for the audit test that pins the set. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];
