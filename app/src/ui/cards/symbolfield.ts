/**
 * A symbol box that SHOWS what there is, without stopping you asking for more.
 *
 * WHY THIS IS NOT A `<datalist>`, HAVING BEEN ONE FOR EXACTLY ONE RELEASE
 *
 * A datalist looked like the right answer: native, keyboard-accessible, and a
 * suggestion list rather than a closed set. It was reported as broken the first
 * time anybody used it, and the report was correct.
 *
 * A browser filters a datalist by WHAT IS ALREADY IN THE BOX. These fields are
 * pre-filled — the Playbook opens on the chart's market — so opening the list
 * on a field reading "XAUUSD" offers exactly one row: XAUUSD. All 131 options
 * were in the DOM and correctly bound; the browser was hiding 130 of them
 * because they did not match the text. "It only shows XAUUSD" is precisely what
 * that looks like, and there is no attribute that turns it off.
 *
 * So this uses `ui/symbolpicker.ts`, which the chart's own symbol box has used
 * since v50 and which was built for this exact complaint — its header opens
 * "what a trader reports as 'I cannot change the currency pair'". It opens on
 * the WHOLE list whatever the box says, narrows as you type, commits only on
 * Enter or a click, and restores on Escape.
 *
 * SUGGESTED, NOT ENFORCED — still the point.
 *
 * `isAcceptableSymbol` takes a `known` predicate and lets anything symbol-shaped
 * through regardless. CLAUDE.md's reason stands: THE ARCHIVE IS WHAT YOU HAVE,
 * NOT WHAT YOU CAN GET, and the Playbook deliberately accepts a market it does
 * not hold and reaches back for the history. A control that could not express
 * that would delete a feature that was added on purpose.
 *
 * WHAT YOU HOLD COMES FIRST, AND SAYS SO
 *
 * "What can I test right now" and "what does this product know about" are
 * different questions, and the first is the one someone opening a backtest desk
 * is asking. Held series lead, annotated with what is held.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import { INSTRUMENTS } from "../../risk/instruments";
import { proxyBase } from "../../data/backend";
import { signal } from "../../core/signal";
import { createSymbolPicker, isAcceptableSymbol, normaliseSymbol, rejectionReason } from "../symbolpicker";
import type { SeriesInventory } from "../../store/barstore";

export interface SymbolOption {
  readonly symbol: string;
  /** What to say about it: what is held, or what it is. */
  readonly note: string;
  /** True when the archive holds bars for it. */
  readonly held: boolean;
}

/**
 * One row per SYMBOL, not per series.
 *
 * An inventory row is (source, symbol, timeframe) — the Data desk records that
 * SPX500 holding 1h from two vendors is one bar size and not two, and the same
 * distinction applies here: a symbol held at three bar sizes from two sources
 * is one thing you can type, and six rows for it is a list nobody can read.
 */
export function heldSymbols(rows: readonly SeriesInventory[]): SymbolOption[] {
  const by = new Map<string, { tfs: Set<string>; bars: number }>();
  for (const r of rows) {
    if (!r.symbol || !(r.bars > 0)) continue;
    const key = r.symbol.toUpperCase();
    const at = by.get(key) ?? { tfs: new Set<string>(), bars: 0 };
    at.tfs.add(r.timeframe);
    at.bars += r.bars;
    by.set(key, at);
  }
  return [...by.entries()]
    /* Richest first: the symbol you hold most of is the one a backtest has the
       most to say about, and the likeliest thing being reached for. */
    .sort((a, b) => b[1].bars - a[1].bars)
    .map(([symbol, at]) => {
      const tfs = [...at.tfs];
      return {
        symbol,
        note: `${at.bars.toLocaleString()} bars · ${tfs.join(", ")}`,
        held: true,
      };
    });
}

/**
 * Everything worth showing: what is held, then what is known.
 *
 * A SYMBOL APPEARS ONCE. Held wins, because its note carries the fact that
 * matters — "Gold vs US dollar" under an entry saying "12,806 bars" would push
 * the useful half off the row.
 */
/** Suffixes this broker family appends. An explicit SET, never a shape. */
const BROKER_SUFFIXES = new Set(["s", "pro", "raw", "ecn", "cash", "c", "m", "i"]);

/**
 * The instrument, without the broker's suffix.
 *
 * AN EXPLICIT SET, NOT A PATTERN. A rule that strips any short trailing `.X`
 * turns the real ticker `BRK.B` into `BRK` — a wrong answer that looks right
 * and would chart a different company. The server's `canonical_symbol` makes
 * the same choice for the same reason; this is its client half.
 */
export function canonicalBrokerSymbol(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return s.toUpperCase();
  const tail = s.slice(dot + 1).toLowerCase();
  return BROKER_SUFFIXES.has(tail) ? s.slice(0, dot).toUpperCase() : s.toUpperCase();
}

/**
 * Add everything the broker quotes that is not already on offer.
 *
 * MEASURED: the broker lists 272 symbols and `INSTRUMENTS` describes 132, so a
 * third of what this account can actually trade could not be picked. The route
 * that knew had no caller.
 *
 * A BROKER SYMBOL IS NOT AUTOMATICALLY A SIZEABLE ONE. Contract size, pip value
 * and the `contextOnly` flag all live in `INSTRUMENTS`, and everything that
 * sizes a position walks that table. So a symbol the broker quotes and the
 * table does not describe is offered with that stated, rather than silently
 * promoted into something the sizer will later meet and default — which is the
 * units defect this codebase records three times over.
 *
 * AND AN EMPTY LIST IS A NO-OP. "Could not ask the bridge" must never shrink
 * the list the operator already had.
 */
export function mergeBrokerSymbols(
  offered: readonly SymbolOption[],
  brokerSymbols: readonly string[],
): SymbolOption[] {
  const seen = new Set(offered.map((o) => o.symbol.toUpperCase()));
  const extra: SymbolOption[] = [];
  for (const raw of brokerSymbols) {
    const sym = canonicalBrokerSymbol(raw);
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    extra.push({
      symbol: sym,
      /* Says both halves: your broker quotes it, and this product cannot size
         it until someone describes it. */
      note: "your broker quotes this · chart only, no sizing",
      held: false,
    });
  }
  extra.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [...offered, ...extra];
}

/**
 * What the broker quotes. Module-level and fetched ONCE.
 *
 * `symbolOptions` has five callers across five desks. Fetching in each would
 * ask the bridge five times for a list that changes when an account does, and
 * would give the five desks five different answers while the requests were in
 * flight. One owner, one request, and every caller sees the same list — the
 * rule `views.ts` and `toolsmenu.ts` demonstrated the cost of breaking, with
 * 0 of 24 groups agreeing.
 */
const brokerList = signal<readonly string[]>([]);
let asked = false;

/** Ask the bridge once. Silent on failure: this ADDS symbols, it never removes. */
function ensureBrokerSymbols(): void {
  if (asked) return;
  asked = true;
  void (async () => {
    try {
      const res = await fetch(new URL("/mt5/symbols", proxyBase()).toString());
      if (!res.ok) return;
      const body = (await res.json()) as { symbols?: unknown };
      if (Array.isArray(body.symbols)) {
        brokerList.set(body.symbols.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      /* A bridge that is not running must leave the picker exactly as it was.
         "Could not ask" is not "there are no symbols", and this is the one
         place where conflating them would REMOVE something from the screen. */
    }
  })();
}

export function symbolOptions(held: readonly SymbolOption[]): SymbolOption[] {
  ensureBrokerSymbols();
  const seen = new Set(held.map((o) => o.symbol.toUpperCase()));
  const rest: SymbolOption[] = [];
  for (const i of INSTRUMENTS) {
    const s = i.symbol.toUpperCase();
    if (seen.has(s)) continue;
    seen.add(s);
    rest.push({ symbol: i.symbol, note: `${i.name} · ${i.cls}`, held: false });
  }
  /* Broker symbols LAST: what you hold, then what this product describes, then
     everything else the account can reach. Reading `brokerList()` here is what
     makes the picker re-render when the answer lands. */
  return mergeBrokerSymbols([...held, ...rest], brokerList());
}

/**
 * The rows to show for a query, best first.
 *
 * AN EMPTY QUERY RETURNS EVERYTHING, in the list's own order. That is the whole
 * behaviour a datalist could not give: opening the box on a pre-filled field
 * has to show the universe, not the one row that happens to match the text
 * already in it.
 *
 * A typed query matches loosely — a market name is an OPEN field and a partial
 * one is the point, which is the other half of the rule CLAUDE.md states about
 * matching a closed vocabulary exactly. A prefix beats a substring, and ties
 * keep the list's order, so what you hold stays at the top.
 */
export function rankOptions(
  options: readonly SymbolOption[],
  query: string,
  limit: number,
): SymbolOption[] {
  const q = normaliseSymbol(query);
  if (q === "") return options.slice(0, limit);
  const starts: SymbolOption[] = [];
  const has: SymbolOption[] = [];
  for (const o of options) {
    const s = o.symbol.toUpperCase();
    if (s.startsWith(q)) starts.push(o);
    else if (s.includes(q) || o.note.toUpperCase().includes(q)) has.push(o);
  }
  return [...starts, ...has].slice(0, limit);
}

export interface SymbolFieldOptions {
  /** Current value. */
  readonly value: () => string;
  /** Called on a deliberate commit — Enter, or a click on a row. */
  readonly onChange: (symbol: string) => void;
  /**
   * Called with the raw text on every keystroke.
   *
   * FOR A CALLER WITH ITS OWN COMMIT BUTTON. The picker commits on Enter or a
   * row click, and a desk whose Add button reads a draft signal would find it
   * empty — which is exactly what happened: removing this broke the Briefing's
   * "+ add" and `today.test.ts` caught it. The picker narrows its own list from
   * its own listener, so this is an additional reader and not a replacement.
   */
  readonly onInput?: (raw: string) => void;
  /** Told why an entry was refused, so the box is never silently ignored. */
  readonly onReject?: (typed: string, reason: string) => void;
  /** What to show. Re-read on every open, so a new download appears. */
  readonly options: () => readonly SymbolOption[];
  readonly className?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
}

/**
 * The input and its picker, as one element.
 *
 * NO `onchange`. It fires on BLUR, and `symbolpicker.ts` records what that cost
 * on the chart's own box: typing "ETH" and clicking away committed `ETH`, wrote
 * it to preferences, and the next boot came up on an instrument no venue quotes.
 * The picker commits on Enter or a click and restores the box otherwise.
 */
export function symbolField(opts: SymbolFieldOptions): HTMLElement {
  const input = h("input", {
    class: opts.className ?? "field-input mono",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
    title: "Type to search, ↑↓ to pick, Enter to use it, Esc to cancel",
    value: opts.value(),
    ...(opts.onInput ? { oninput: (e: Event) => opts.onInput?.((e.target as HTMLInputElement).value) } : {}),
  }) as HTMLInputElement;

  const picker = createSymbolPicker({
    input,
    current: () => opts.value(),
    total: () => opts.options().length,
    search: (query, limit) =>
      rankOptions(opts.options(), query, limit).map((o) => ({ symbol: o.symbol, detail: o.note })),
    commit: (symbol) => {
      const s = normaliseSymbol(symbol);
      /* The picker already refuses a half-typed ticker; this is the second
         lock, because `commit` is also reachable from a row click and a caller
         that stored an empty string would persist it. */
      if (s !== "" && isAcceptableSymbol(s, (x) => opts.options().some((o) => o.symbol.toUpperCase() === x))) {
        opts.onChange(s);
      } else if (opts.onReject) {
        opts.onReject(s, rejectionReason(s));
      }
    },
    ...(opts.onReject ? { reject: opts.onReject } : {}),
  });

  /* A VALUE SET FROM ELSEWHERE HAS TO REACH THE BOX. The chart's symbol, a
     restored preference or a click on another desk all change the signal
     without touching this element. Skipped while it has focus, or it would
     fight someone mid-word — and while the picker is open, because the box is
     then the query rather than the value. */
  renderEffect(() => {
    const v = opts.value();
    if (document.activeElement !== input && !picker.isOpen() && input.value !== v) input.value = v;
  });

  return h("span", { class: "symfield" }, input, picker.el) as HTMLElement;
}
