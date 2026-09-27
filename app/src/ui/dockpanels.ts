/**
 * The inspector dock's layout rules.
 *
 * THE MEASUREMENT THAT FORCED THIS
 * Nine panels in one scrolling column came to **3,828px of content in an
 * 842px viewport** — four and a half screens. Not one of them collapsed.
 * "Detected structures", which you check constantly while reading a chart,
 * started 3,199px down; "Context" is 1,002px on its own, taller than the
 * viewport, so it could never be seen whole. And 774px of venue announcements
 * — occasional reading — sat ABOVE the two panels you glance at most.
 *
 * THE DISTINCTION THE PANELS ACTUALLY FALL INTO
 * Measuring them made it obvious that there are two kinds of panel here and
 * that mixing them is what hurt:
 *
 *   GLANCE  cursor 143, regime 154, studies 101, series 164   — 562px, total
 *   READ    setup 755, context 1002, news 774, fundamentals 371, structures 364
 *
 * The glance panels together fit in two-thirds of one screen. The read panels
 * are what blow the column up, and scrolling past a thousand pixels of reading
 * to check a hundred-pixel number is the whole complaint.
 *
 * TWO MODES, BECAUSE THERE ARE TWO WAYS TO WORK
 *   column  every panel in rank order, each collapsible, state persisted.
 *           You keep the ability to see two things at once, which is the
 *           reason a trader wants a side panel rather than a dialog.
 *   stack   one card at a time, owning the full dock height, switched with a
 *           control. Nothing scrolls that does not have to.
 *
 * WHY THIS FILE HOLDS NO DOM
 * Same reason `fitFields` in livebar.ts holds none: the rule is worth testing
 * without a layout engine, and the dock is worth being able to reason about
 * without reading five hundred lines of `shell.ts`. The shell builds every
 * panel exactly as before and this decides what is shown — the same shape as
 * `livebar.refit()`.
 */

import type { IconName } from "./icons";

/**
 * The five questions the inspector answers, in the order a trade asks them.
 *
 * WHY THE DOCK HAS SECTIONS NOW (v54)
 * It was ordered by how often each panel is READ, which is a real measure and
 * produced a real improvement — but it grouped the panels by where their data
 * came from: a cursor readout, a study list, a feed monitor, a regime model.
 * The operator's question is not "which data source" but "what is happening,
 * what is likely, is there a trade, what could hit it" — and the answer to
 * that was spread across four panels in an order that put the conclusion
 * (the Setup card) above the reasoning it depends on.
 *
 * So the column now reads as one argument, top to bottom, with the verdict
 * pinned above it (shell.ts, `.dock-verdict`) so the conclusion is still the
 * first thing seen. Diagnostics — the cursor, the series, the feed — are real
 * and needed when something breaks, and are last and closed.
 */
export type DockSection = "now" | "next" | "trade" | "risk" | "evidence";

export interface DockSectionMeta {
  readonly id: DockSection;
  readonly title: string;
  /** The question the section answers, in the operator's words. */
  readonly question: string;
}

export const DOCK_SECTIONS: readonly DockSectionMeta[] = [
  { id: "now", title: "Market now", question: "What is price doing?" },
  { id: "next", title: "What's likely next", question: "Ranges and odds, with their track record" },
  { id: "trade", title: "The trade", question: "Where to enter, where it is wrong, what it pays" },
  { id: "risk", title: "Risk check", question: "What could hit this trade" },
  { id: "evidence", title: "Evidence & diagnostics", question: "What the read stands on" },
];

/** Left to right in the switcher, top to bottom in the column. */
export interface DockPanelMeta {
  readonly id: string;
  readonly title: string;
  readonly section: DockSection;
  /**
   * Order within the whole column. Sections come first (see `DOCK_SECTIONS`);
   * rank orders panels inside a section and is unique across the dock because
   * it is also the stack-mode card order.
   */
  readonly rank: number;
  /**
   * `glance` is a handful of numbers you want present; `read` is something you
   * open deliberately. Only used to choose sensible defaults — the operator's
   * saved state always wins over it.
   */
  readonly kind: "glance" | "read";
  /** Open by default in column mode, on a first run with nothing saved. */
  readonly defaultOpen: boolean;
  /**
   * Measured height in px at 360px wide, for the summary line. Approximate.
   * RE-MEASURED v59.2, every card, in the browser at the dock's own 360px —
   * several v5x figures had drifted by 100px+ (setup 755 -> 808, context
   * 1002 -> 705, feed 520 -> 1006). Live stays at its full-list 320: it grows
   * with events, and a budget that assumes a short list is one that fails on
   * a busy day.
   */
  readonly approxHeight: number;
  /** The glyph on the card head and in the icon strip when the dock is shut. */
  readonly icon: IconName;
  /**
   * Who produces what the card says (v59.2): "ai" — the terminal reads it
   * for you; "you" — it holds your own decisions; "both" — your rules, the
   * terminal's check; "" — plain data, nobody's opinion.
   */
  readonly who: CardWho;
  /**
   * On the column by default. Off means ADDABLE, not deleted: it is one
   * click away under "+ Add panel", and a removed card keeps its state.
   */
  readonly defaultOn: boolean;
}

export type CardWho = "ai" | "you" | "both" | "";

export const DOCK_PANELS: readonly DockPanelMeta[] = [
  /* MARKET NOW. Small, constantly wanted: what just changed, the regime, and
     the two studies that say how fast and how far price is moving.

     THE LIVE PANEL IS FIRST IN THE SECTION, AND THAT IS THE POINT (v55.2).
     Every other panel in this dock answers a standing question and repaints
     its answer in place — so an operator who looks away for ten minutes has no
     way to find out what happened while they were not looking, short of
     re-reading ten panels and remembering what each of them said before. This
     one is the only surface that says what CHANGED, which makes it the first
     answer to "what is price doing?" rather than the last. It is a `read`
     rather than a `glance`: the sentences are prose and the numbers are behind
     a disclosure, which is not a thing you take in at a glance.

     321px MEASURED in the browser at the dock's own 360px, with five events
     shut. It grows with the list up to the panel's twelve-row limit, which is
     what every `read` here does and is why the figure is documented as
     approximate. */
  /* v59.2 AI READ: five numbered steps built from what the terminal
     measured — trend, structure, pullback, momentum, what is marked
     (`scan/chartread.ts`). First in the section because it is the one-glance
     answer to the section's question; shut by default, like the mockup. */
  { id: "read", title: "AI read of the chart", section: "now", rank: 0.5, kind: "glance", defaultOpen: false, approxHeight: 265, icon: "sparkle", who: "ai", defaultOn: true },
  { id: "live", title: "Live", section: "now", rank: 1, kind: "read", defaultOpen: true, approxHeight: 320, icon: "live", who: "ai", defaultOn: false },
  { id: "regime", title: "Regime & model", section: "now", rank: 2, kind: "glance", defaultOpen: false, approxHeight: 161, icon: "quant", who: "ai", defaultOn: false },
  { id: "studies", title: "Momentum & volatility", section: "now", rank: 3, kind: "glance", defaultOpen: false, approxHeight: 104, icon: "indicators", who: "", defaultOn: false },

  /* WHAT'S LIKELY NEXT. The range of outcomes over the next day of bars,
     simulated from this instrument's own moves, and the odds of the plan's
     target before its stop — with the band's measured track record. */
  { id: "outlook", title: "Price outlook", section: "next", rank: 4, kind: "glance", defaultOpen: true, approxHeight: 309, icon: "survey", who: "ai", defaultOn: false },

  /* THE TRADE. The Setup card: entry zone, stop, targets, size, gates, and how
     this pattern resolved here before. The largest thing that stays open. */
  { id: "setup", title: "Setup & plan", section: "trade", rank: 5, kind: "read", defaultOpen: true, approxHeight: 808, icon: "decision", who: "ai", defaultOn: false },

  /* RISK CHECK. What could hit the trade from outside the chart. Long reads,
     closed by default; the verdict line above the column carries a release
     warning when one is close, so closed does not mean unseen. */
  { id: "context", title: "Calendar & seasonality", section: "risk", rank: 6, kind: "read", defaultOpen: false, approxHeight: 705, icon: "calendar", who: "", defaultOn: true },
  { id: "news", title: "Venue announcements", section: "risk", rank: 7, kind: "read", defaultOpen: false, approxHeight: 789, icon: "news", who: "", defaultOn: false },
  { id: "fundamentals", title: "Fundamentals", section: "risk", rank: 8, kind: "read", defaultOpen: false, approxHeight: 299, icon: "briefing", who: "", defaultOn: false },

  /* EVIDENCE & DIAGNOSTICS. What the read stands on, and the plumbing. The
     feed monitor is still the first thing wanted when the chart stops moving;
     it is one click away in a section named for exactly that. */
  { id: "structures", title: "Detected structures", section: "evidence", rank: 9, kind: "read", defaultOpen: false, approxHeight: 371, icon: "detect", who: "ai", defaultOn: false },
  { id: "cursor", title: "Cursor", section: "evidence", rank: 10, kind: "glance", defaultOpen: false, approxHeight: 150, icon: "cursor", who: "", defaultOn: false },
  { id: "feed", title: "Feed & network", section: "evidence", rank: 11, kind: "read", defaultOpen: false, approxHeight: 1006, icon: "flow", who: "", defaultOn: false },
  { id: "series", title: "Series", section: "evidence", rank: 12, kind: "glance", defaultOpen: false, approxHeight: 189, icon: "data", who: "", defaultOn: false },

  /* v59.2 — the cards the v5 design adds, each over a service that already
     ran with no screen. Decimal ranks slot them between existing panels
     without renumbering the ones saved layouts refer to.

     WATCHLIST: your symbols, beside the chart they switch. */
  { id: "watch", title: "Watchlist", section: "now", rank: 3.5, kind: "glance", defaultOpen: true, approxHeight: 186, icon: "watchlist", who: "you", defaultOn: false },
  /* KEY LEVELS: the nearest support and resistance the detectors found,
     ranked by distance from price — the structure list, answered. */
  { id: "levels", title: "Key levels", section: "trade", rank: 5.2, kind: "glance", defaultOpen: false, approxHeight: 239, icon: "levels", who: "ai", defaultOn: true },
  /* CAN I TRADE NOW: the server's risk governor — your limits, its check.
     First in Risk because it is the one answer there that can say NO. */
  { id: "gov", title: "Can I trade now?", section: "trade", rank: 5.1, kind: "glance", defaultOpen: true, approxHeight: 225, icon: "risk", who: "both", defaultOn: true },
  /* PRICE ALERTS: armed on the server, so they fire with the terminal shut. */
  { id: "alerts", title: "Price alerts", section: "risk", rank: 8.5, kind: "glance", defaultOpen: true, approxHeight: 151, icon: "bell", who: "you", defaultOn: false },
  /* WHALE WATCH: large transfers from wallets you follow. */
  { id: "whale", title: "Whale watch", section: "risk", rank: 8.7, kind: "read", defaultOpen: true, approxHeight: 437, icon: "whale", who: "", defaultOn: false },
  /* SMART-MONEY WALLETS: the scored list the alert loop watches. Ranked
     immediately after Whale watch because it IS that card's input — the
     transfers there come from these wallets. */
  /* 124 MEASURED in the browser with one wallet; it grows a row at a time. */
  { id: "dbwallets", title: "Smart-money wallets", section: "risk", rank: 8.8, kind: "read", defaultOpen: false, approxHeight: 124, icon: "whale", who: "", defaultOn: false },
  /* NEW TOKEN PAIRS: what the scanner has seen listed. Last in Risk, and
     `defaultOpen: false`, because it is a feed to screen rather than an answer
     — nothing here should greet anyone who did not ask for it. */
  /* 575 MEASURED with the list capped at twelve. It was 1,502 uncapped, in a
     dock whose next largest panel is 456 — an estimate is a measurement that
     has stopped being checked, so this one was taken from the browser. */
  { id: "newpairs", title: "New token pairs", section: "risk", rank: 8.9, kind: "read", defaultOpen: false, approxHeight: 575, icon: "whale", who: "", defaultOn: false },
];

/**
 * The dock layout version, persisted beside the open set.
 *
 * WHY. The open set is saved, and a saved set from before v54 was chosen for a
 * different column — it would keep the Cursor open, leave the new Outlook
 * closed, and present the restructured dock in the old arrangement for every
 * existing install, the same way a saved theme NAME kept the old palette. So a
 * saved set from an older layout is replaced by the defaults ONCE; after that
 * the operator's choices win again, as they always did.
 *
 * v55.2 BUMPS IT TO 3 FOR EXACTLY THE SAME REASON. Adding the Live panel with
 * `defaultOpen: true` changes nothing for anybody who has already used the
 * terminal: their saved set names eleven panels and not this one, and a set
 * that does not name a panel closes it. So every existing install would have
 * shipped the feature with it shut, behind a row in a list — which is the
 * theme-NAME trap and the v54 trap, a third time. One bump, one replacement,
 * and the operator's choices win again from the next click.
 */
export const DOCK_LAYOUT = 4;

/**
 * v59.2 — the v5 DESIGN of the inspector, as a saved-preference generation.
 *
 * The v5 panel is the AI recommendation (pinned above the column) and four
 * cards — AI read, Can I trade now?, Key levels, Calendar — with everything
 * else one click away under "+ Add panel". An operator's SAVED layout would
 * otherwise keep the old column forever (the owner's did: Stack mode, twelve
 * panels, and "it looks still same"), so a layout saved under an earlier
 * design is reset ONCE to these defaults. After that every choice sticks.
 */
export const DOCK_DESIGN = 5;

export type DockMode = "column" | "stack";

const BY_ID = new Map(DOCK_PANELS.map((p) => [p.id, p]));

/**
 * Height a collapsed panel still costs — its own header.
 *
 * Mirrors `.dock .panel-head`'s `min-height` in components.css. Measured
 * rather than guessed: the first value here was 34 and the real header is 32,
 * which over nine panels is enough to move the summary line by a fifth of a
 * screen.
 */
export const COLLAPSED_H = 32;

/**
 * Panel ids in display order.
 *
 * By rank, NOT by the order the shell happens to build them in. Source order
 * is an implementation detail and it is exactly what produced the old layout.
 */
export function orderedIds(): string[] {
  const sec = (id: DockSection): number => DOCK_SECTIONS.findIndex((x) => x.id === id);
  return [...DOCK_PANELS]
    .sort((a, b) => sec(a.section) - sec(b.section) || a.rank - b.rank)
    .map((p) => p.id);
}

/**
 * Where each section heading and each panel sits, as CSS `order` values.
 *
 * A heading takes the slot just before its first panel. Returned rather than
 * applied, so the layout is testable without a DOM — the rule of this file.
 */
export function layoutOrder(
  pinned: readonly string[] = [],
  removed: readonly string[] = [],
): { readonly sections: ReadonlyMap<DockSection, number>; readonly panels: ReadonlyMap<string, number> } {
  /* v59.2: PINNED CARDS COME FIRST, in the order they were pinned, above
     every section; a REMOVED card gets no slot at all (the caller hides it).
     A section whose cards are all pinned or removed gets no slot either, so
     its heading is hidden rather than left over an empty stretch. */
  const out = new Set(removed);
  const pins = pinned.filter((id) => BY_ID.has(id) && !out.has(id));
  const pinSet = new Set(pins);
  const sections = new Map<DockSection, number>();
  const panels = new Map<string, number>();
  let slot = 0;
  for (const id of pins) panels.set(id, slot++);
  for (const id of orderedIds()) {
    if (out.has(id) || pinSet.has(id)) continue;
    const meta = BY_ID.get(id) as DockPanelMeta;
    if (!sections.has(meta.section)) sections.set(meta.section, slot++);
    panels.set(id, slot++);
  }
  return { sections, panels };
}

/** The open set for a first run. */
export function defaultOpen(): string[] {
  return DOCK_PANELS.filter((p) => p.defaultOpen).map((p) => p.id);
}

/**
 * Clean a persisted open-set.
 *
 * Unknown ids are dropped, because the set is persisted and a panel removed in
 * a later version must not brick the dock — the same rule `runStudies` and
 * `runPanes` follow. An EMPTY saved set is respected rather than reset to the
 * defaults: closing everything is a legitimate thing to want, and quietly
 * re-opening five panels because the array was empty would be the dock
 * overruling a deliberate choice.
 */
/* `layout` is REQUIRED, with no default, on purpose. A pre-v54 install has no
   saved layout at all, so the value arrives as `undefined` — and a default
   parameter substitutes on exactly `undefined`, which made the first version
   of this treat every old install as current and migrate none of them. Caught
   by the test that asks for it. */
export function sanitiseOpen(saved: unknown, layout: unknown): string[] {
  if (!Array.isArray(saved)) return defaultOpen();
  /* A set saved for an older column. See `DOCK_LAYOUT`. */
  if (layout !== DOCK_LAYOUT) return defaultOpen();
  return saved.filter((id): id is string => typeof id === "string" && BY_ID.has(id));
}

export function sanitiseMode(saved: unknown): DockMode {
  return saved === "stack" ? "stack" : "column";
}

/**
 * The card to show in stack mode.
 *
 * Falls back to the highest-ranked panel rather than to nothing: a stack with
 * no card selected is an empty dock, and an empty dock reads as broken.
 */
export function sanitiseActive(saved: unknown): string {
  /* The Setup card, not the first card in the column: a stack shows one card
     at a time, and the one to land on is the answer, not the regime. */
  return typeof saved === "string" && BY_ID.has(saved) ? saved : "setup";
}

/** Step through the cards, wrapping at both ends. */
export function nextCard(current: string, delta: number, removed: readonly string[] = []): string {
  const out = new Set(removed);
  const all = orderedIds().filter((id) => !out.has(id));
  const ids = all.length > 0 ? all : orderedIds();
  const i = ids.indexOf(current);
  const from = i < 0 ? 0 : i;
  const n = ids.length;
  return ids[(((from + delta) % n) + n) % n] as string;
}

export function panelMeta(id: string): DockPanelMeta | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Roughly how tall the column is with this open set, in screens.
 *
 * Exported so the dock can TELL you what you have built. The old column was
 * 4.5 screens and nothing on screen said so; the number is the whole reason
 * this module exists, and hiding it would repeat the original mistake.
 */
export function columnHeight(open: readonly string[], removed: readonly string[] = defaultRemoved()): number {
  /* v59.2: a REMOVED card is not drawn at all, not even as a 32px row, so it
     adds nothing. The default is the default removed set, so "the column a
     first run sees" is what an unqualified call measures. */
  const openSet = new Set(open);
  const out = new Set(removed);
  return DOCK_PANELS.reduce(
    (sum, p) => sum + (out.has(p.id) ? 0 : openSet.has(p.id) ? p.approxHeight : COLLAPSED_H),
    0,
  );
}

/**
 * The line under the dock head.
 *
 * IT USED TO REPORT SCROLL DEPTH IN SCREENS, AND THE NUMBER WAS FROZEN.
 * MEASURED, live, at 1600x900 with the default open set: the line read
 * "4 panels open - 1.2 screens of scroll" while `scrollHeight /
 * clientHeight` on the same element in the same frame was 2329 / 682 =
 * **3.4**. Wrong by a factor of 2.8, in a readout whose own comment argued it
 * had to take measured values "rather than estimating".
 *
 * WHY IT FROZE. `scrollHeight` is not reactive, so shell.ts published a tick
 * from the layout effect and from a ResizeObserver on the dock body. A
 * ResizeObserver watches an element's own BOX, and the body's box never
 * changes: what changes is the CONTENT inside it, when the Setup card fills in
 * asynchronously and on every data refresh after that. So the figure was
 * measured once, before the tallest panel had any content, and then held that
 * value for the rest of the session.
 *
 * WHY IT IS NOT FIXED WITH A BETTER OBSERVER. Because it was a duplicate. The
 * dock body scrolls with a real 10px scrollbar (`base.css` styles the thumb
 * against a transparent track), and a scrollbar thumb IS the ratio of viewport
 * to content — drawn continuously, by the browser, always correct. Keeping a
 * second copy of that number in text meant observing ten panels for the
 * privilege of restating something already on screen, with a wrong value as
 * the cost of getting it slightly out of step.
 *
 * So the line reports what it can know from its arguments alone and cannot go
 * stale: how many panels are open, out of how many there are. The second half
 * is new, and it is the one the redesign needs — a shut panel is now a row in
 * a list rather than an empty card, and this says how long that list is.
 */
export function dockSummary(mode: DockMode, open: readonly string[], removed: readonly string[] = []): string {
  const out = new Set(removed);
  const shown = DOCK_PANELS.filter((p) => !out.has(p.id)).length;
  if (mode === "stack") return `One card at a time. ${shown} cards.`;
  const n = open.filter((id) => BY_ID.has(id) && !out.has(id)).length;
  if (n === 0) return "Nothing open — click a name below.";
  return `${n} of ${shown} open`;
}

/** Cards off the column by default — see `defaultOn`. */
export function defaultRemoved(): string[] {
  return DOCK_PANELS.filter((p) => !p.defaultOn).map((p) => p.id);
}

/**
 * A saved list of card ids (pinned or removed), cleaned.
 *
 * Not an array means NEVER SAVED, and gets the fallback; an array — even an
 * empty one — is a decision and is kept, minus ids no longer registered and
 * duplicates. Same distinction as `sanitiseOpen`: "removed nothing" and
 * "never chose" must not collapse into one value.
 */
export function sanitiseIds(saved: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(saved)) return [...fallback];
  const seen = new Set<string>();
  for (const id of saved) if (typeof id === "string" && BY_ID.has(id)) seen.add(id);
  return [...seen];
}

/** Pin or unpin. Pinning appends, so the newest pin sits lowest of the pins. */
export function togglePin(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
}

/**
 * Remove a card from the column: out of `removed`'s complement and out of
 * the pins, so re-adding it does not silently bring back a pin.
 */
export function removeCard(
  state: { readonly pinned: readonly string[]; readonly removed: readonly string[] },
  id: string,
): { pinned: string[]; removed: string[] } {
  return {
    pinned: state.pinned.filter((x) => x !== id),
    removed: state.removed.includes(id) ? [...state.removed] : [...state.removed, id],
  };
}

/** The cards that "+ Add panel" offers: the removed ones, in column order. */
export function addableCards(removed: readonly string[]): DockPanelMeta[] {
  const out = new Set(removed);
  return orderedIds()
    .filter((id) => out.has(id))
    .map((id) => BY_ID.get(id) as DockPanelMeta);
}

/** The cards on the column, pins first — what the icon strip shows. */
export function shownCards(pinned: readonly string[], removed: readonly string[]): DockPanelMeta[] {
  const { panels } = layoutOrder(pinned, removed);
  return [...panels.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => BY_ID.get(id) as DockPanelMeta);
}

/**
 * Toggle one panel's open state.
 *
 * Returns a NEW array rather than mutating, so the signal's equality check
 * still sees a change. A mutated array compares equal to itself and the dock
 * would not repaint — the failure mode is a header that visibly does nothing.
 */
export function toggleOpen(open: readonly string[], id: string): string[] {
  return open.includes(id) ? open.filter((x) => x !== id) : [...open, id];
}
