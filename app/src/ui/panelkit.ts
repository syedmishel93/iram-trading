/**
 * The inspector's shared vocabulary.
 *
 * WHY THIS EXISTS
 * Nine dock panels, built at different times, each inventing its own row. The
 * Cursor panel was a bare `<dl class="kv">`; Regime and Context wrapped
 * themselves in `.panel-body`; News grew `.news-row`; the Setup card had
 * `.setup-kv`, `.setup-lbl` and `.setup-note`. Five idioms for "a label and a
 * value", each with its own spacing, its own label casing and its own idea of
 * how a number is aligned. Stacked in one 360px column they read as five
 * different applications sharing a scrollbar.
 *
 * WHAT IS SHARED AND WHAT IS NOT
 * The GRAMMAR is shared: a section has a term and a sentence, a row has a
 * label and a value and optionally a note under the value, a number is
 * right-aligned and tabular, an absent value says why rather than rendering
 * blank. The CONTENT is not — a news feed is a list of stories and a cursor
 * readout is five numbers, and forcing those into one component would be the
 * opposite mistake.
 *
 * WHERE THE LAYOUT RULES COME FROM
 * All of it is the Setup card's, which was measured rather than guessed. The
 * label column is `max-content` and the value column takes the remainder,
 * because the reverse — `minmax(0,1fr) auto` — let one 38-character value take
 * 270px of a 307px card and starved every label to 25px. Anything that
 * qualifies a value goes on its own line rather than fighting for that row.
 */

import { h, type Child } from "./dom";

/**
 * A row: a label, a value, and optionally what qualifies the value.
 *
 * `tone` colours the VALUE only, and only for values that carry a verdict —
 * never for a number that merely happens to be negative. A price that fell is
 * not bad news, and colouring it as if it were is how a readout starts
 * editorialising.
 */
export interface PkRow {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly tone?: "pos" | "neg" | "attn" | "mute";
  /** Hover text on the label, for a definition that will not fit on screen. */
  readonly hint?: string;
}

/** A section label: a short term, then what it means right now. */
export function pkLabel(term: string, note?: string): HTMLElement {
  return h(
    "div",
    { class: "pk-lbl" },
    h("span", { class: "pk-lbl-term", text: term }),
    ...(note === undefined || note === "" ? [] : [h("span", { class: "pk-lbl-note", text: note })]),
  ) as HTMLElement;
}

/**
 * A label/value grid.
 *
 * Takes the rows as data rather than as nodes so that every caller gets the
 * same alignment and the same treatment of a missing value, and so the layout
 * can be changed in one place. A row whose value is empty renders the em dash
 * rather than nothing: a blank cell is indistinguishable from a panel that
 * failed to render.
 */
export function pkRows(rows: readonly PkRow[]): HTMLElement {
  return h(
    "div",
    { class: "pk-kv" },
    ...rows.flatMap((r) => [
      h("span", {
        class: "pk-k",
        text: r.label,
        ...(r.hint === undefined ? {} : { title: r.hint }),
      }),
      h(
        "span",
        { class: "pk-v", ...(r.tone === undefined ? {} : { "data-tone": r.tone }) },
        h("span", { class: "pk-val num", text: r.value === "" ? "—" : r.value }),
        ...(r.note === undefined || r.note === "" ? [] : [h("span", { class: "pk-note", text: r.note })]),
      ),
    ]),
  ) as HTMLElement;
}

/**
 * A grid whose rows are recomputed whenever the signals they read change.
 *
 * The dock's readouts are live, and `pkRows` takes plain strings on purpose —
 * a row that is half reactive and half not is how a panel ends up with two
 * update paths. This rebuilds the whole grid instead, which for five to eight
 * rows is cheaper than the bookkeeping and cannot go out of step.
 *
 * The callback must return the rows, not nodes: `h`'s reactive child contract
 * allows exactly ONE node back, and returning an array is a mistake this
 * codebase has already made three times.
 */
export function pkRowsLive(rows: () => readonly PkRow[]): HTMLElement {
  return h("div", { class: "pk-live" }, () => pkRows(rows())) as HTMLElement;
}

/** A titled block: the label, then whatever the panel puts in it. */
export function pkSection(term: string, note: string | undefined, ...body: Child[]): HTMLElement {
  return h("div", { class: "pk-sec" }, pkLabel(term, note), ...body) as HTMLElement;
}

/**
 * The state a panel is in when it has nothing to show.
 *
 * Three kinds, and they are NOT interchangeable. "Loading" will change on its
 * own; "empty" is a real, final answer; "unavailable" means the panel could
 * not ask. Rendering all three as an empty box is how "no events scheduled"
 * and "the calendar failed to load" become the same sentence — the exact
 * distinction the news gate exists to preserve.
 */
export function pkEmpty(kind: "loading" | "empty" | "unavailable", text: string): HTMLElement {
  return h("p", { class: "pk-empty", "data-kind": kind, text }) as HTMLElement;
}

/** A small pill. Same shape everywhere it appears. */
export function pkChip(text: string, tone?: "pos" | "neg" | "attn" | "accent"): HTMLElement {
  return h("span", {
    class: "pk-chip",
    ...(tone === undefined ? {} : { "data-tone": tone }),
    text,
  }) as HTMLElement;
}

/**
 * A number, formatted the same way everywhere in the dock.
 *
 * WHY THIS IS NOT `toFixed(2)`
 * A terminal quotes gold at 4,336.56, BTC at 77,104.31, EURUSD at 1.08423 and
 * a lot size at 0.1291. One decimal count cannot serve those, and picking per
 * call site is how the Setup card came to print a quantity as
 * `0.1291181424547554`. Significant figures scale with magnitude, which is
 * what a price actually needs.
 *
 * Returns `"—"` for anything that is not a finite number, because a readout
 * that prints `NaN` has told you it does not have the value in the least
 * useful way available.
 */
export function pkNum(v: number, opts: { readonly decimals?: number; readonly sig?: number } = {}): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (opts.decimals !== undefined) {
    return v.toLocaleString(undefined, {
      minimumFractionDigits: opts.decimals,
      maximumFractionDigits: opts.decimals,
    });
  }
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  /* Thousands separators above 1000; significant figures below it, so 0.00042
     keeps its information and 77,104.31 does not grow a tail. */
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : Math.min(8, (opts.sig ?? 4) + Math.ceil(-Math.log10(abs)));
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** A percentage, with its sign kept when the sign is the point. */
export function pkPct(v: number, decimals = 2, signed = false): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const s = v.toFixed(decimals);
  return `${signed && v > 0 ? "+" : ""}${s}%`;
}

/**
 * The explanation behind a number, one click away instead of always open.
 *
 * WHY: the desks explained everything inline — every card ended in a muted
 * paragraph of method and caveat, and the inspector read as a document rather
 * than an instrument. The caveats are the product's honesty and are NOT being
 * removed; they are being moved from "always in the way" to "always one click
 * away". What stays inline is the verdict: a card must still say what it
 * found, and must still say when it refused, without anyone opening anything.
 *
 * A native <details>, so it is keyboard-operable and announced by screen
 * readers with no script, and the open/closed state costs nothing to keep.
 */
/**
 * The same disclosure as `pkWhy`, for a BODY rather than a sentence.
 *
 * `pkWhy` takes a string, so reference material that is a table — a retention
 * policy, a list of hosts — had no way to be folded away and stayed on screen
 * permanently. Same classes, so the two read as one control.
 */
export function pkFold(label: string, ...body: Child[]): HTMLElement {
  return h(
    "details",
    { class: "pk-why" },
    h("summary", { class: "pk-why-sum", text: label }),
    h("div", { class: "pk-fold-body" }, ...body),
  ) as HTMLElement;
}

export function pkWhy(text: string | (() => string), label = "How this is measured"): HTMLElement {
  return h(
    "details",
    { class: "pk-why" },
    h("summary", { class: "pk-why-sum", text: label }),
    h("p", { class: "pk-why-body", text }),
  ) as HTMLElement;
}
