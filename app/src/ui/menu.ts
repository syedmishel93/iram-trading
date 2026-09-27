/**
 * Menus — the menu bar, its dropdowns, and right-click context menus.
 *
 * All three are the same thing: a list of items in a floating panel. Writing
 * them once means a context menu automatically gets keyboard navigation, edge
 * flipping and correct dismissal, none of which anyone remembers to add to a
 * right-click menu built ad hoc.
 *
 * WHY A MENU BAR AT ALL, GIVEN THE PALETTE
 * Because they answer different questions. The palette answers "how do I do the
 * thing I already want"; the menu bar answers "what can this program do". You
 * cannot fuzzy-search for a feature whose name you have never heard. Every
 * serious desktop application ships both, and the menu is where the shortcuts
 * get taught — an item that shows its own accelerator is how a user graduates
 * from clicking it to pressing it.
 *
 * ITEMS ARE RESOLVED LATE. A menu is built from a FUNCTION returning items, not
 * from an array, so `checked` and `disabled` are read at the moment the menu
 * opens. A menu built once at startup shows the state the app had at startup,
 * which is wrong by the time anybody looks at it.
 */

import { h } from "./dom";
import { openOverlay, closeAllOverlays, type OverlayHandle, type Point } from "./overlay";
import type { CommandRegistry } from "../core/commands";
import type { Keymap } from "../core/keys";
import { formatSequence, parseSequence } from "../core/keys";

export interface MenuItem {
  readonly kind?: "item" | "separator" | "header";
  /** Command id. Title, gate and check state are pulled from the registry. */
  readonly id?: string;
  /** Overrides the command's title, or stands alone for a non-command item. */
  readonly label?: string;
  /** Right-aligned accelerator. Filled in from the keymap when `id` is set. */
  readonly hint?: string;
  /**
   * What this row does, in a few words. NOT the accelerator.
   *
   * THEY WERE ONE FIELD AND IT COST BOTH OF THEM. `toolsmenu.ts` passed its
   * descriptions in as `hint`, so each one inherited `.menu-kbd`'s
   * `white-space: nowrap`, never shrank, and pushed the shortfall onto the only
   * element that could give — the LABEL. Measured in the browser: the Knowledge
   * desk's name got 62px of the 71 it needed and rendered "Knowledg…" while its
   * description was shown in full. A menu that abbreviates the name and spells
   * out the description has its priorities exactly backwards.
   *
   * And because `hint` is filled in from the keymap for a row with an `id`,
   * overwriting it threw the SHORTCUT away: every desk in that menu lost its
   * key. Two facts, two slots, and a row can now carry both.
   */
  readonly note?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** Nested items. Opens to the side on hover or Right-arrow. */
  readonly items?: readonly MenuItem[];
  readonly run?: () => void;
}

export interface MenuContext {
  readonly commands: CommandRegistry;
  readonly keymap: Keymap;
}

/**
 * Fill in what the registry already knows.
 *
 * A menu entry should be `{ id: "chart.goLive" }` and nothing else: the title,
 * the accelerator, whether it is available and whether it is ticked all live on
 * the command, and copying them into the menu is how they drift apart.
 */
function resolve(item: MenuItem, ctx: MenuContext): MenuItem {
  if (!item.id) return item;
  const cmd = ctx.commands.get(item.id);
  if (!cmd) {
    /* A menu referencing a command that does not exist is a build error the
       user should not have to discover by clicking a dead row. */
    return { ...item, label: item.label ?? item.id, disabled: true };
  }
  const keys = ctx.keymap.keysFor(item.id);
  const chords = keys ? parseSequence(keys, ctx.keymap.platform) : null;
  const hint = item.hint ?? (chords ? formatSequence(chords, ctx.keymap.platform) : undefined);
  const checked = item.checked ?? cmd.checked?.();

  /* Optional keys are spread in only when they have a value. Under
     `exactOptionalPropertyTypes` an explicit `undefined` is a different thing
     from an absent key, and writing `hint: undefined` would claim the item HAS
     a hint whose value happens to be undefined. */
  return {
    ...item,
    /* An explicit label on the entry wins; then the command's own menu title;
       then the palette title. */
    label: item.label ?? cmd.menuTitle ?? cmd.title,
    ...(hint !== undefined ? { hint } : {}),
    ...(checked !== undefined ? { checked } : {}),
    disabled: item.disabled ?? (cmd.when ? !cmd.when() : false),
    danger: item.danger ?? cmd.danger === true,
    run: item.run ?? (() => ctx.commands.run(item.id as string)),
  };
}

export interface MenuOptions {
  readonly anchor?: HTMLElement | Point;
  readonly placement?: "bottom-start" | "bottom-end" | "right-start";
  readonly ctx: MenuContext;
  readonly onClose?: () => void;
  /** Internal: a submenu must not steal focus restoration from its parent. */
  readonly isSubmenu?: boolean;
}

export function openMenu(items: readonly MenuItem[], opts: MenuOptions): OverlayHandle {
  const resolved = items.map((i) => resolve(i, opts.ctx));
  const panel = h("div", { class: "menu", role: "menu" });

  /* Rows that can actually be selected — headers and separators are skipped by
     the arrow keys, which is what makes a menu with sections still feel like
     one list rather than an obstacle course. */
  const selectable: HTMLElement[] = [];
  /* Row -> the item it was built from. Index arithmetic against panel.children
     breaks the moment a separator or a disabled row shifts the counts apart. */
  const itemOf = new WeakMap<HTMLElement, MenuItem>();
  let cursor = -1;
  let submenu: OverlayHandle | null = null;
  let submenuOwner: HTMLElement | null = null;

  const closeSubmenu = (): void => {
    submenu?.close();
    submenu = null;
    submenuOwner = null;
  };

  const paint = (): void => {
    selectable.forEach((el, i) => el.setAttribute("data-active", String(i === cursor)));
  };

  const openSubmenuFor = (row: HTMLElement, item: MenuItem): void => {
    if (submenuOwner === row && submenu?.isOpen()) return;
    closeSubmenu();
    if (!item.items || item.items.length === 0) return;
    submenuOwner = row;
    submenu = openMenu(item.items, {
      anchor: row,
      placement: "right-start",
      ctx: opts.ctx,
      isSubmenu: true,
    });
  };

  for (const item of resolved) {
    if (item.kind === "separator") {
      panel.appendChild(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if (item.kind === "header") {
      panel.appendChild(h("div", { class: "menu-header", text: item.label ?? "" }));
      continue;
    }

    const hasSub = !!item.items && item.items.length > 0;
    const row = h(
      "button",
      {
        class: "menu-item",
        role: hasSub ? "menuitem" : item.checked !== undefined ? "menuitemcheckbox" : "menuitem",
        type: "button",
        disabled: item.disabled === true,
        "aria-checked": item.checked === undefined ? undefined : String(item.checked),
        "aria-haspopup": hasSub ? "menu" : undefined,
        "data-danger": String(item.danger === true),
        onpointerenter: () => {
          const i = selectable.indexOf(row);
          if (i >= 0) {
            cursor = i;
            paint();
          }
          if (hasSub) openSubmenuFor(row, item);
          else closeSubmenu();
        },
        onclick: () => {
          if (item.disabled === true) return;
          if (hasSub) {
            openSubmenuFor(row, item);
            return;
          }
          /* Dismiss the WHOLE menu tree before running: a command that opens a
             dialog must not appear behind the menu that launched it. */
          closeAllOverlays();
          item.run?.();
        },
      },
      h("span", {
        class: "menu-check",
        text: item.checked === true ? "✓" : "",
        "data-toggle": String(item.checked !== undefined),
      }),
      h("span", { class: "menu-label", text: item.label ?? "" }),
      h("span", { class: "menu-spacer" }),
      /* THE NOTE IS THE ELEMENT THAT GIVES WAY, which is why it is its own span
         rather than more text in the label: it carries the ellipsis so the name
         never has to. */
      item.note ? h("span", { class: "menu-note", text: item.note }) : null,
      hasSub
        ? h("span", { class: "menu-arrow", text: "›" })
        /* A SUBMENU ROW IS NOT SHOWN AN ACCELERATOR. It goes somewhere rather
           than doing something, and a key it cannot honour is a promise broken. */
        : item.hint
          ? h("span", { class: "menu-kbd", text: item.hint })
          : null,
    );

    panel.appendChild(row);
    itemOf.set(row, item);
    if (item.disabled !== true) selectable.push(row);
  }

  if (resolved.length === 0) {
    panel.appendChild(h("div", { class: "menu-empty", text: "Nothing available here" }));
  }

  const handle = openOverlay(panel, {
    ...(opts.anchor !== undefined ? { anchor: opts.anchor } : {}),
    placement: opts.placement ?? "bottom-start",
    className: "overlay-menu",
    /* A submenu must not pull focus back to the document when it closes — its
       parent menu is still open and still owns the keyboard. */
    restoreFocus: opts.isSubmenu !== true,
    autoFocus: false,
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
  });

  panel.addEventListener("keydown", (e: KeyboardEvent) => {
    const n = selectable.length;
    if (n === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        cursor = (cursor + 1) % n;
        paint();
        (selectable[cursor] as HTMLElement).focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        cursor = (cursor - 1 + n) % n;
        paint();
        (selectable[cursor] as HTMLElement).focus();
        break;
      case "Home":
        e.preventDefault();
        cursor = 0;
        paint();
        (selectable[0] as HTMLElement).focus();
        break;
      case "End":
        e.preventDefault();
        cursor = n - 1;
        paint();
        (selectable[n - 1] as HTMLElement).focus();
        break;
      case "ArrowRight": {
        const row = selectable[cursor];
        const item = row ? itemOf.get(row) : undefined;
        if (row && item?.items && item.items.length > 0) {
          e.preventDefault();
          openSubmenuFor(row, item);
        }
        break;
      }
      case "ArrowLeft":
        if (opts.isSubmenu === true) {
          e.preventDefault();
          handle.close();
        }
        break;
    }
  });

  /* Focus the panel, not the first item: opening a menu should not pre-select
     something you might activate by reflex with Enter. The first ArrowDown
     selects. */
  panel.tabIndex = -1;
  panel.focus();

  const outerClose = handle.close.bind(handle);
  handle.close = (): void => {
    closeSubmenu();
    outerClose();
  };

  return handle;
}

/** Right-click menu at a point. */
export function openContextMenu(
  items: readonly MenuItem[],
  at: Point,
  ctx: MenuContext,
): OverlayHandle {
  return openMenu(items, { anchor: at, ctx, placement: "bottom-start" });
}

export interface MenuBarEntry {
  readonly label: string;
  /** Called each time the menu opens, so state is never stale. */
  readonly items: () => readonly MenuItem[];
}

/**
 * The menu bar.
 *
 * Two behaviours people expect from a real menu bar and notice immediately when
 * they are missing: clicking an open menu's own title CLOSES it, and once one
 * menu is open, hovering across the others switches between them without a
 * second click.
 */
export function createMenuBar(entries: readonly MenuBarEntry[], ctx: MenuContext): HTMLElement {
  const bar = h("nav", { class: "menubar", role: "menubar", "aria-label": "Main menu" });
  let openIndex = -1;
  let handle: OverlayHandle | null = null;
  const buttons: HTMLElement[] = [];

  const close = (): void => {
    handle?.close();
    handle = null;
    openIndex = -1;
    for (const b of buttons) b.setAttribute("aria-expanded", "false");
  };

  const openAt = (index: number): void => {
    const entry = entries[index];
    const button = buttons[index];
    if (!entry || !button) return;
    handle?.close();
    openIndex = index;
    for (const b of buttons) b.setAttribute("aria-expanded", String(b === button));
    handle = openMenu(entry.items(), {
      anchor: button,
      placement: "bottom-start",
      ctx,
      onClose: () => {
        /* Only clear if this is still the current menu: switching menus closes
           the old one AFTER the new one has registered itself. */
        if (openIndex === index) {
          openIndex = -1;
          button.setAttribute("aria-expanded", "false");
        }
      },
    });
  };

  entries.forEach((entry, index) => {
    const button = h("button", {
      class: "menubar-btn",
      type: "button",
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      text: entry.label,
      onpointerdown: (e: Event) => {
        /* pointerdown, not click: the overlay dismisses on pointerdown, so a
           click handler would fire after the menu had already been closed by
           the same press and would immediately reopen it. */
        e.preventDefault();
        if (openIndex === index) close();
        else openAt(index);
      },
      onpointerenter: () => {
        if (openIndex >= 0 && openIndex !== index) openAt(index);
      },
      onkeydown: (e: Event) => {
        const ev = e as KeyboardEvent;
        if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openAt(index);
        } else if (ev.key === "ArrowRight") {
          ev.preventDefault();
          (buttons[(index + 1) % buttons.length] as HTMLElement).focus();
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          (buttons[(index - 1 + buttons.length) % buttons.length] as HTMLElement).focus();
        }
      },
    });
    buttons.push(button);
    bar.appendChild(button);
  });

  return bar;
}
