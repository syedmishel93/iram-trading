/**
 * A real picker on the symbol box.
 *
 * WHAT WAS WRONG
 * The symbol box was a bare `<input>` with one `onchange` handler. Three things
 * followed from that, and together they are what a trader reports as
 * "I cannot change the currency pair":
 *
 *  1. **No affordance.** Nothing about the control says it can be searched.
 *     The catalogue behind the command palette already knows every pair the
 *     venue lists, ranked by 24-hour volume — the box just never asked it. You
 *     had to already know the exact ticker string to type.
 *
 *  2. **A half-typed symbol was committed.** `change` fires on blur, so typing
 *     "ETH" and clicking away set the symbol to `ETH`. Nothing rejects it: it
 *     is written to preferences, and the next boot restores an instrument no
 *     venue quotes, with a chart of zero bars and no route back. I reproduced
 *     exactly that — the terminal came up on `NOTAREALPAIR` and stayed there.
 *
 *  3. **No way to abandon an edit.** Escape did nothing, so a mistyped box had
 *     to be corrected character by character.
 *
 * WHY IT IS A BROWSER AND NOT JUST A TYPEAHEAD
 * The first version fixed the three defects above and stopped there: twelve
 * ranked rows, and only if you typed. But "show me what this venue lists" is a
 * different question from "find me the pair I already have in mind", and a
 * twelve-row typeahead answers only the second. Someone who does not know
 * whether the terminal quotes SOLUSDC, or wants to see what is liquid today,
 * has nothing to look at. So opening the box now lists the WHOLE universe,
 * scrollable, ranked by tier and turnover — with quote-currency tabs, because
 * three and a half thousand pairs in one flat list is not browsable either.
 * Typing narrows it. The tabs and the query compose.
 *
 * WHAT THIS DOES NOT DO
 * It does not restrict you to the catalogue. The catalogue is Binance's list;
 * EURUSD and XAUUSD come from the MT5 bridge and are not in it, and a picker
 * that refused them would break FX entirely. Anything symbol-SHAPED is still
 * accepted verbatim — the guard is against `ETH` and ` `, not against
 * instruments nobody listed. That is the same escape hatch the palette's raw
 * source keeps, and for the same reason.
 *
 * TESTABILITY
 * `search` is injected rather than reaching for the catalogue, so the whole
 * behaviour runs in jsdom with a three-line stub and no network.
 */

import { h, clear } from "./dom";

export interface SymbolMatch {
  readonly symbol: string;
  /** Right-aligned context, e.g. "1.2B 24h" or "on screen". */
  readonly detail?: string;
}

/**
 * A quote-currency tab.
 *
 * Supplied by the caller rather than hardcoded: what counts as a useful
 * grouping is a property of the venues this build talks to, and this file has
 * no business knowing that FDUSD exists.
 */
export interface SymbolFilter {
  readonly id: string;
  readonly label: string;
}

export interface SymbolPickerOptions {
  readonly input: HTMLInputElement;
  /**
   * Ranked matches, best first, already narrowed to `filter`.
   *
   * `filter` is the id of the active tab, or null for "everything".
   */
  search(query: string, limit: number, filter: string | null): readonly SymbolMatch[];
  /** How many instruments the filter covers in total, for the count line. */
  total?(filter: string | null): number;
  /** Quote-currency tabs. Omit for a plain ranked list. */
  readonly filters?: readonly SymbolFilter[];
  /** The symbol actually on screen, for restore-on-cancel. */
  current(): string;
  /** Called only on a deliberate commit. Never on a keystroke. */
  commit(symbol: string): void;
  /** Told why an entry was refused, so the box is never silently ignored. */
  reject?(typed: string, reason: string): void;
  /**
   * How many rows to render.
   *
   * Large by design — this is a scrollable list, not a dropdown of
   * suggestions. Capped rather than unbounded because painting every one of
   * ~3,600 rows costs more than anyone will ever scroll through.
   */
  readonly limit?: number;
}

export interface SymbolPicker {
  /** The dropdown. Insert next to the input; positioned by CSS. */
  readonly el: HTMLElement;
  isOpen(): boolean;
  close(): void;
  destroy(): void;
}

/**
 * The shortest ticker this terminal actually quotes.
 *
 * EURUSD and XAUUSD are six; BTCUSDT is seven. Five is the floor that keeps
 * "ETH" and "BT" out while letting every real instrument through. The same
 * constant governs the palette's raw-symbol source — see `RAW_SYMBOL_MIN` in
 * shell.ts. Kept deliberately permissive: rejecting a real instrument is a far
 * worse failure than accepting a typo the feed will then name as uncovered.
 */
export const MIN_SYMBOL_LENGTH = 5;

/** Tickers are alphanumeric with a little punctuation; never spaces. */
const SYMBOL_SHAPE = /^[A-Z0-9][A-Z0-9._-]*$/;

export function normaliseSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Is this worth sending to the feed?
 *
 * Deliberately NOT "is it in the catalogue" — see the header. A known symbol is
 * always acceptable; an unknown one is acceptable when it is shaped like a
 * ticker and long enough to be one.
 */
export function isAcceptableSymbol(value: string, known: (s: string) => boolean): boolean {
  const s = normaliseSymbol(value);
  if (s.length === 0) return false;
  if (known(s)) return true;
  return s.length >= MIN_SYMBOL_LENGTH && SYMBOL_SHAPE.test(s);
}

export function rejectionReason(value: string): string {
  const s = normaliseSymbol(value);
  if (s.length === 0) return "No symbol typed.";
  if (!SYMBOL_SHAPE.test(s)) return `"${s}" is not shaped like a ticker.`;
  return `"${s}" is too short to be an instrument — pick one from the list, or type the full ticker.`;
}

export function createSymbolPicker(opts: SymbolPickerOptions): SymbolPicker {
  const limit = opts.limit ?? 300;
  const input = opts.input;

  const list = h("div", {
    class: "sym-list",
    role: "listbox",
    "aria-label": "Instruments",
  }) as HTMLElement;

  const foot = h("div", { class: "sym-foot" }) as HTMLElement;

  const el = h("div", { class: "sym-menu" }) as HTMLElement;
  el.hidden = true;

  /** null is the "All" tab. */
  let filter: string | null = null;
  let rows: SymbolMatch[] = [];
  let active = -1;
  let open = false;
  /** Set for the duration of a commit, so the blur it causes does not restore. */
  let committing = false;

  /**
   * Opened, but nothing typed yet — so the box still holds the CURRENT symbol.
   *
   * Without this the list opens already narrowed by whatever is on screen:
   * clicking the box on XAUUSD offered four instruments, all of them XAU. That
   * is the opposite of the request the panel exists to answer. While browsing,
   * the query is treated as empty however full the box looks; the first
   * keystroke replaces the selected text anyway, and clears this.
   */
  let browsing = false;

  /** What to actually search for, as opposed to what the box happens to show. */
  const queryNow = (): string => (browsing ? "" : normaliseSymbol(input.value));

  const tabs: HTMLElement[] = [];
  if (opts.filters && opts.filters.length > 0) {
    const bar = h("div", { class: "sym-tabs", role: "tablist" }) as HTMLElement;

    const addTab = (id: string | null, label: string): void => {
      const tab = h("button", {
        class: "sym-tab",
        type: "button",
        role: "tab",
        text: label,
        "data-tab": id ?? "",
        /**
         * pointerdown with preventDefault, not click.
         *
         * A click on a chip blurs the input first, and blur RESTORES and closes
         * — so the panel would shut before the chip's own handler ever ran, and
         * the tabs would appear completely dead. Suppressing the default keeps
         * focus in the box, which is also where it belongs: you narrow by
         * currency and keep typing.
         */
        onpointerdown: (e: Event) => {
          e.preventDefault();
          filter = id;
          paintTabs();
          refresh();
        },
      }) as HTMLElement;
      tabs.push(tab);
      bar.appendChild(tab);
    };

    addTab(null, "All");
    for (const f of opts.filters) addTab(f.id, f.label);
    el.appendChild(bar);
  }

  el.appendChild(list);
  el.appendChild(foot);

  const paintTabs = (): void => {
    for (const t of tabs) {
      const id = t.getAttribute("data-tab");
      const on = (id === "" ? null : id) === filter;
      t.setAttribute("aria-selected", String(on));
      t.setAttribute("data-on", String(on));
    }
  };
  paintTabs();

  const known = (s: string): boolean =>
    opts.search(s, 8, null).some((m) => m.symbol === s);

  /**
   * Positioned against the VIEWPORT, not the input.
   *
   * This is the whole reason "the pair selector is not working". The panel was
   * `position: absolute` inside `.sym-picker`, which sits inside `.topbar` —
   * and `.topbar` sets `overflow-x: auto` so its control groups can scroll,
   * while `.shell > *` sets `overflow: hidden` over the top of that. An
   * overflow container CLIPS absolutely-positioned descendants, so the list was
   * cut to the topbar's 48px band: the rows existed, the layout box measured
   * 320x460, and almost none of it was on screen. `getBoundingClientRect`
   * reports the unclipped box, which is precisely why testing it that way said
   * everything was fine while a real click showed a sliver.
   *
   * `.commandbar` was exempted from the blanket clip for this exact reason and
   * says so in its comment. The topbar never was. Fixed coordinates sidestep
   * both clips instead of unpicking a rule two other things depend on.
   */
  const place = (): void => {
    const r = input.getBoundingClientRect();
    const w = el.offsetWidth || 320;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(r.bottom + 4)}px`;
    /* Never taller than the room below the box. Without this the list runs off
       the bottom of a short window and the last rows are unreachable. */
    el.style.maxHeight = `${Math.max(160, Math.round(window.innerHeight - r.bottom - 16))}px`;
  };

  let offViewport: (() => void) | null = null;

  const setOpen = (next: boolean): void => {
    open = next;
    el.hidden = !next;
    input.setAttribute("aria-expanded", String(next));

    offViewport?.();
    offViewport = null;
    if (!next) return;

    place();
    /* Re-placed rather than closed when the window moves: closing the list
       because the topbar scrolled would discard a search mid-thought. */
    const onMove = (): void => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    offViewport = () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  };

  const paint = (): void => {
    clear(list);
    rows.forEach((m, i) => {
      list.appendChild(
        h(
          "div",
          {
            class: "sym-opt",
            role: "option",
            "aria-selected": String(i === active),
            "data-active": String(i === active),
            /* pointerdown, not click: the input's blur fires first on a click
               and would have already restored the box. */
            onpointerdown: (e: Event) => {
              e.preventDefault();
              choose(i);
            },
          },
          h("span", { class: "sym-opt-name", text: m.symbol }),
          h("span", { class: "sym-opt-detail", text: m.detail ?? "" }),
        ),
      );
    });
  };

  /**
   * The count line.
   *
   * It says how many of the tab's instruments are on screen, because a list
   * that silently stops at its render cap looks like a venue that only lists
   * 300 pairs. If something was cut, the line says so and says to keep typing.
   */
  const paintFoot = (): void => {
    clear(foot);
    const total = opts.total?.(filter);
    const shown = rows.length;
    const typed = queryNow().length > 0;

    let text: string;
    if (shown === 0) {
      text = typed ? "No match — press ↵ to load it anyway" : "No instruments listed";
    } else if (total !== undefined && !typed && total > shown) {
      text = `${shown} of ${total} · type to narrow`;
    } else if (total !== undefined && !typed) {
      text = `${shown} instrument${shown === 1 ? "" : "s"}`;
    } else if (shown >= limit) {
      text = `first ${shown} matches · keep typing`;
    } else {
      text = `${shown} match${shown === 1 ? "" : "es"}`;
    }
    foot.appendChild(h("span", { class: "sym-foot-count", text }));
    foot.appendChild(h("span", { class: "sym-foot-keys", text: "↑↓ move · ↵ load · esc cancel" }));
  };

  const refresh = (): void => {
    const q = queryNow();
    rows = opts.search(q, limit, filter).slice(0, limit);
    /* Highlight the first row only when something was typed. On an untouched
       box the list is a menu to browse, and pre-selecting a row would make a
       stray Enter change the instrument. */
    active = q.length > 0 && rows.length > 0 ? 0 : -1;
    paint();
    paintFoot();
    /* Open even with nothing to show: the footer explains an empty result, and
       a panel that vanishes on a typo is how a control starts feeling broken. */
    setOpen(true);

    if (!browsing) {
      list.scrollTop = 0;
      return;
    }
    /* Browsing the full list: land on the instrument already on screen rather
       than at the top of three thousand rows, so "what else is there" starts
       from where you are. */
    const here = normaliseSymbol(opts.current());
    const at = rows.findIndex((m) => m.symbol === here);
    if (at < 0) {
      list.scrollTop = 0;
      return;
    }
    const row = list.children[at] as HTMLElement | undefined;
    if (row?.scrollIntoView) row.scrollIntoView({ block: "center" });
    else list.scrollTop = 0;
  };

  const restore = (): void => {
    input.value = opts.current();
    browsing = false;
    setOpen(false);
  };

  const commit = (value: string): void => {
    const s = normaliseSymbol(value);
    if (!isAcceptableSymbol(s, known)) {
      opts.reject?.(s, rejectionReason(s));
      restore();
      return;
    }
    committing = true;
    input.value = s;
    browsing = false;
    setOpen(false);
    opts.commit(s);
    committing = false;
  };

  const choose = (i: number): void => {
    const row = rows[i];
    if (row) commit(row.symbol);
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    active = active < 0 ? (delta > 0 ? 0 : rows.length - 1) : (active + delta + rows.length) % rows.length;
    paint();
    /* Guarded: jsdom does not implement scrollIntoView, and neither do some
       embedded webviews. Keyboard navigation must not throw where the only
       thing lost is a scroll. */
    const row = list.children[active] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: "nearest" });
  };

  const onFocus = (): void => {
    /* Select the whole ticker so the first keystroke replaces it. Typing "SOL"
       into "BTCUSDT" and getting "BTCUSDTSOL" was the other half of "I cannot
       change the pair". */
    input.select?.();
    browsing = true;
    refresh();
  };

  /**
   * Clicking an ALREADY-FOCUSED box reopens the list.
   *
   * Without this, dismissing with Escape and clicking the box again does
   * nothing — no focus event fires, so nothing reopens, and the control reads
   * as dead exactly when someone is retrying it.
   */
  const onClick = (): void => {
    if (open) return;
    input.select?.();
    browsing = true;
    refresh();
  };

  const onInput = (): void => {
    /* The moment anything is typed the box means what it says. */
    browsing = false;
    refresh();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) refresh();
        else move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "PageDown":
        e.preventDefault();
        move(10);
        return;
      case "PageUp":
        e.preventDefault();
        move(-10);
        return;
      case "Tab":
        /* Cycle the currency tabs without leaving the keyboard. Only while the
           panel is open and only when tabs exist, so Tab still moves focus out
           of a closed box the way every other field on the desk does. */
        if (!open || tabs.length === 0) return;
        e.preventDefault();
        {
          const ids: (string | null)[] = [null, ...(opts.filters ?? []).map((f) => f.id)];
          const at = ids.indexOf(filter);
          const step = e.shiftKey ? -1 : 1;
          filter = ids[(at + step + ids.length) % ids.length] ?? null;
          paintTabs();
          refresh();
        }
        return;
      case "Enter":
        e.preventDefault();
        /* A highlighted row wins; otherwise take what was typed, so someone who
           knows the ticker never has to look at the list. */
        if (active >= 0 && rows[active]) choose(active);
        else if (browsing) restore();
        else commit(input.value);
        return;
      case "Escape":
        /* Stop here: the shell binds Escape too, and abandoning an edit should
           not also close a dock or leave focus mode. */
        e.preventDefault();
        e.stopPropagation();
        restore();
        input.blur();
        return;
      default:
        return;
    }
  };

  /**
   * Blur RESTORES. It does not commit.
   *
   * This is the line that stops a half-typed "ETH" from being written to
   * preferences and booting the terminal into an instrument that does not
   * exist. Committing requires Enter or a click on a row — both deliberate.
   */
  const onBlur = (): void => {
    if (committing) return;
    restore();
  };

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");

  input.addEventListener("focus", onFocus);
  input.addEventListener("click", onClick);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);

  return {
    el,
    isOpen: () => open,
    close: () => setOpen(false),
    destroy() {
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("click", onClick);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("blur", onBlur);
      offViewport?.();
      el.remove();
    },
  };
}
