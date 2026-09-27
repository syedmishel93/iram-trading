/**
 * The command palette.
 *
 * THE ARGUMENT FOR IT
 * Bloomberg is fast because it is a command line: you type what you want and
 * press GO. TradingView is discoverable because it is a menu: you hunt until
 * you find it. Each is the other's weakness — the command line is unguessable
 * and the menu is slow. A palette is the only interface that is both, because
 * the same keystrokes that execute a known command also LIST the ones you did
 * not know existed.
 *
 * Neither TradingView, MetaTrader nor TrendSpider has one. It is the single
 * largest speed difference available in this build.
 *
 * WHAT MAKES A PALETTE GOOD RATHER THAN PRESENT
 *  - The empty state is useful. Open it having typed nothing and you get what
 *    you last used, not an alphabetical dump.
 *  - Matched characters are highlighted, so you can see WHY a row is on screen.
 *    A fuzzy result you cannot explain reads as a guess.
 *  - It says what a command will DO, not just its name: the current value on
 *    the right, a check mark on a toggle that is already on.
 *  - The keyboard never leaves the text field. Arrow keys move the selection
 *    while you keep typing.
 *  - Modes, entered by prefix, so one keystroke narrows a thousand rows to the
 *    forty you meant.
 *
 * ASYNC RESULTS ARE VERSIONED. A symbol search that resolves after you have
 * typed three more characters must not overwrite the list. Every query carries
 * a sequence number and a late reply for a stale one is dropped.
 */

import { h, clear } from "./dom";
import { openOverlay, type OverlayHandle } from "./overlay";

export interface PaletteItem {
  readonly id: string;
  readonly title: string;
  /** Section heading. Rows are grouped under it in result order. */
  readonly group: string;
  /** Muted text after the title — the current value, or a description. */
  readonly detail?: string;
  /** Right-aligned, monospaced: a keyboard shortcut, a price, a count. */
  readonly hint?: string;
  /** Toggle state. Undefined means "not a toggle" and shows nothing. */
  readonly checked?: boolean;
  readonly danger?: boolean;
  /** Indices into `title` to embolden. From the fuzzy matcher. */
  readonly positions?: readonly number[];
  readonly run: () => void;
}

export interface PaletteSource {
  /**
   * The prefix that selects this source exclusively — ">" for commands, "@"
   * for chart structures. An empty prefix contributes to the default mode.
   */
  readonly prefix: string;
  /** Shown as the mode chip once the prefix is typed. */
  readonly label: string;
  readonly placeholder: string;
  search(query: string, limit: number): PaletteItem[] | Promise<PaletteItem[]>;
}

export interface Palette {
  readonly open: (initial?: string) => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
  readonly toggle: (initial?: string) => void;
}

/** Rows rendered at once. Beyond this nobody is reading, they are re-typing. */
const RESULT_LIMIT = 60;

export interface PaletteOptions {
  readonly sources: readonly PaletteSource[];
  /** Footer hint, e.g. "↑↓ navigate · ↵ run · esc close". */
  readonly footer?: string;
}

export function createPalette(opts: PaletteOptions): Palette {
  let handle: OverlayHandle | null = null;
  let items: PaletteItem[] = [];
  let selected = 0;
  let queryToken = 0;

  const input = h("input", {
    class: "pal-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-label": "Command palette",
    "aria-autocomplete": "list",
    role: "combobox",
    "aria-expanded": "true",
  });

  const modeChip = h("span", { class: "pal-mode", "data-on": "false" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const empty = h("div", { class: "pal-empty" });
  const footer = h(
    "div",
    { class: "pal-footer" },
    h("span", { class: "pal-hint", text: opts.footer ?? "↑↓ select · ↵ run · esc close" }),
    h("span", { class: "pal-count" }),
  );
  const count = footer.querySelector(".pal-count") as HTMLElement;

  const panel = h(
    "div",
    { class: "pal" },
    h(
      "div",
      { class: "pal-head" },
      h("span", { class: "pal-glyph", text: "⌕", "aria-hidden": "true" }),
      modeChip,
      input,
    ),
    list,
    empty,
    footer,
  );

  /** Which source the current text selects, and the text minus its prefix. */
  function resolveMode(raw: string): { source: PaletteSource | null; query: string } {
    for (const src of opts.sources) {
      if (src.prefix.length > 0 && raw.startsWith(src.prefix)) {
        return { source: src, query: raw.slice(src.prefix.length) };
      }
    }
    return { source: null, query: raw };
  }

  function renderTitle(item: PaletteItem): HTMLElement {
    const wrap = h("span", { class: "pal-title" });
    const pos = item.positions;
    if (!pos || pos.length === 0) {
      wrap.textContent = item.title;
      return wrap;
    }
    /* Walk the title once, emitting plain runs and marked characters. Building
       it from nodes rather than innerHTML means a symbol or command title can
       contain angle brackets without becoming markup. */
    const set = new Set(pos);
    let run = "";
    for (let i = 0; i < item.title.length; i++) {
      const ch = item.title[i] as string;
      if (set.has(i)) {
        if (run.length > 0) {
          wrap.appendChild(document.createTextNode(run));
          run = "";
        }
        wrap.appendChild(h("mark", { class: "pal-mark", text: ch }));
      } else {
        run += ch;
      }
    }
    if (run.length > 0) wrap.appendChild(document.createTextNode(run));
    return wrap;
  }

  function renderRow(item: PaletteItem, index: number): HTMLElement {
    const row = h(
      "div",
      {
        class: "pal-row",
        role: "option",
        id: `pal-row-${index}`,
        "data-selected": String(index === selected),
        "data-danger": String(item.danger === true),
        onpointermove: () => {
          if (selected === index) return;
          selected = index;
          paintSelection();
        },
        /* Run on pointerup, not click: the overlay's outside-press handler
           lives on pointerdown, and a click handler here would race it. */
        onpointerup: (e: Event) => {
          e.preventDefault();
          activate(index);
        },
      },
      h("span", {
        class: "pal-check",
        text: item.checked === undefined ? "" : item.checked ? "✓" : "",
        "data-toggle": String(item.checked !== undefined),
      }),
      renderTitle(item),
      item.detail ? h("span", { class: "pal-detail", text: item.detail }) : null,
      h("span", { class: "pal-spacer" }),
      item.hint ? h("span", { class: "pal-kbd", text: item.hint }) : null,
    );
    return row;
  }

  function paintSelection(): void {
    const rows = list.querySelectorAll<HTMLElement>(".pal-row");
    rows.forEach((row, i) => row.setAttribute("data-selected", String(i === selected)));
    const active = rows[selected];
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      /* `nearest` and not `center`: re-centring the list on every arrow key
         makes the whole list move under a stationary cursor, which is
         disorienting when you are scanning rather than aiming. */
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function render(): void {
    clear(list);
    if (items.length === 0) {
      empty.textContent = input.value.trim().length === 0 ? "" : `No match for “${input.value}”`;
      empty.setAttribute("data-show", String(input.value.trim().length > 0));
      count.textContent = "";
      return;
    }
    empty.setAttribute("data-show", "false");

    let lastGroup: string | null = null;
    items.forEach((item, i) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        list.appendChild(h("div", { class: "pal-group", text: item.group }));
      }
      list.appendChild(renderRow(item, i));
    });

    count.textContent = `${items.length}${items.length === RESULT_LIMIT ? "+" : ""}`;
    paintSelection();
  }

  /**
   * Re-rank. Runs on EVERY keystroke, with no debounce.
   *
   * A palette that lags its own input is the one thing it must never do, so the
   * debounce is pushed to where it belongs: a source that has to leave the
   * process is responsible for its own caching, and the symbol source below
   * fetches its universe once and then answers synchronously forever. Debouncing
   * here would have delayed the ninety-nine per cent of sources that are pure
   * array work in order to protect the one that is not.
   */
  function runQuery(): void {
    const raw = input.value;
    const { source, query } = resolveMode(raw);

    modeChip.textContent = source ? source.label : "";
    modeChip.setAttribute("data-on", String(source !== null));
    input.placeholder = source
      ? source.placeholder
      : (opts.sources.find((s) => s.prefix === "")?.placeholder ?? "Type a command…");

    const active = source ? [source] : opts.sources.filter((s) => s.prefix === "");
    const token = ++queryToken;

    const collected: PaletteItem[] = [];
    let pendingAsync = 0;

    const commit = (): void => {
      /* A reply for a query the user has already typed past must not land. */
      if (token !== queryToken) return;
      items = collected.slice(0, RESULT_LIMIT);
      selected = 0;
      render();
    };

    for (const src of active) {
      const out = src.search(query, RESULT_LIMIT);
      if (Array.isArray(out)) {
        collected.push(...out);
      } else {
        pendingAsync++;
        void out
          .then((async) => {
            if (token !== queryToken) return;
            collected.push(...async);
          })
          .catch((err: unknown) => {
            /* An async source that fails costs its own rows, not the palette. */
            console.warn(`[iram] palette source "${src.label}" failed`, err);
          })
          .finally(() => {
            pendingAsync--;
            if (pendingAsync === 0) commit();
          });
      }
    }

    /* Paint the synchronous rows immediately; async ones fold in when they
       arrive. Waiting for the network before showing anything would make the
       palette feel slower than the slowest source it consults. */
    commit();
  }

  function activate(index: number): void {
    const item = items[index];
    if (!item) return;
    /* Close BEFORE running. A command that opens another overlay (a confirm, a
       submenu, a second palette) must not be stacked underneath the palette it
       was launched from. */
    close();
    item.run();
  }

  function move(delta: number): void {
    if (items.length === 0) return;
    const n = items.length;
    selected = ((selected + delta) % n + n) % n;
    paintSelection();
  }

  input.addEventListener("input", runQuery);

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "PageDown":
        e.preventDefault();
        move(8);
        break;
      case "PageUp":
        e.preventDefault();
        move(-8);
        break;
      case "Home":
        if (input.value.length === 0) {
          e.preventDefault();
          selected = 0;
          paintSelection();
        }
        break;
      case "End":
        if (input.value.length === 0) {
          e.preventDefault();
          selected = items.length - 1;
          paintSelection();
        }
        break;
      case "Enter":
        e.preventDefault();
        activate(selected);
        break;
      case "Backspace":
        /* Backspacing off the last character of a prefix leaves the mode chip
           lit with an empty query, which reads as a mode you cannot exit.
           Clearing the field entirely is what the user meant. */
        if (input.value.length === 1) {
          input.value = "";
          e.preventDefault();
          runQuery();
        }
        break;
    }
  });

  function close(): void {
    /* Invalidate any async query still in flight, so it cannot repaint a list
       that is no longer on screen. */
    queryToken++;
    handle?.close();
    handle = null;
  }

  const palette: Palette = {
    isOpen: () => handle !== null,

    open(initial = "") {
      if (handle) {
        /* Already open: re-target rather than stacking a second copy. */
        input.value = initial;
        input.select();
        runQuery();
        return;
      }
      input.value = initial;
      handle = openOverlay(panel, {
        placement: "center",
        className: "overlay-palette",
        scrim: true,
        onClose: () => {
          handle = null;
        },
      });
      input.focus();
      input.select();
      runQuery();
    },

    close,

    toggle(initial = "") {
      if (handle) close();
      else palette.open(initial);
    },
  };

  return palette;
}
