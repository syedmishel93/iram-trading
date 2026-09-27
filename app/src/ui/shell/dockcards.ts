/**
 * The inspector's cards: the head every card wears, "+ Add panel", and the
 * icon strip a shut inspector leaves behind (v59.2, the v5 design).
 *
 * WHAT A CARD HEAD CARRIES
 * The name and its icon, who produces what it says (AI / You / You + AI —
 * see `CardWho` in dockpanels.ts), and two controls: PIN, which lifts the
 * card above every section and keeps it there, and REMOVE, which takes it off
 * the column. Removing is not deleting: the card is built and keeps its state,
 * and "+ Add panel" lists it until it comes back. A card you cannot get back
 * is a card nobody dares remove, so the way back is on the same screen.
 *
 * WHY THE STRIP IS ICONS AND NOT THE WORD "INSPECTOR"
 * The closed rail existed because a shut panel with no trace on screen was
 * read as GONE (CLAUDE.md, "A closed panel with no trace on screen is a lost
 * panel"). The word said that something was there; the icons say WHAT is
 * there, and each one opens the inspector on that card. Same affordance, one
 * click shorter.
 *
 * All three write the persisted signals (`dockPinned`, `dockRemoved`,
 * `dockOpenIds`, `dockToggle`) and read nothing else, so the column's layout
 * effect in shell.ts stays the single place that decides what is shown.
 */

import { h } from "../dom";
import { icon } from "../icons";
import { openMenu, type MenuItem } from "../menu";
import { scheduleFrame } from "../../core/frame";
import { addableCards, panelMeta, removeCard, shownCards, togglePin, type CardWho } from "../dockpanels";
import { renderEffect, type Signal } from "../../core/signal";
import type { ShellContext } from "./context";

export interface DockCardsDeps {
  /** The inspector's open state — the same signal the B and ] keys flip. */
  readonly dockToggle: Signal<boolean>;
  /** The column's scroll container, once it exists. */
  readonly dockBody: () => HTMLElement | null;
}

const WHO_TEXT: Record<Exclude<CardWho, "">, { readonly text: string; readonly title: string }> = {
  ai: { text: "AI", title: "The terminal reads this for you." },
  you: { text: "You", title: "This holds your own decisions." },
  both: { text: "You + AI", title: "Your rules, checked by the terminal." },
};

export function createDockCards(ctx: ShellContext, d: DockCardsDeps) {
  const { state, commands, keymap, toaster } = ctx;

  /** Open the inspector on one card: shown, expanded, in view. */
  function reveal(id: string): void {
    d.dockToggle.set(true);
    if (state.dockRemoved().includes(id)) state.dockRemoved.update((r) => r.filter((x) => x !== id));
    if (!state.dockOpenIds().includes(id)) state.dockOpenIds.update((o) => [...o, id]);
    state.dockCard.set(id);
    /* After the layout effect has placed it. */
    scheduleFrame(() => {
      d.dockBody()?.querySelector<HTMLElement>(`[data-panel="${id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  /** The head of one card. `toggle` is the existing collapse button. */
  function cardHead(id: string, toggle: HTMLElement): HTMLElement {
    const meta = panelMeta(id);
    const title = meta?.title ?? id;
    const who = meta?.who ?? "";
    if (meta) toggle.insertBefore(h("span", { class: "card-ic", ref: (el: HTMLElement) => el.appendChild(icon(meta.icon, { size: 13 })) }), toggle.children[1] ?? null);
    return h(
      "div",
      { class: "card-head" },
      toggle,
      who
        ? h("span", { class: "card-who", "data-who": who, title: WHO_TEXT[who].title, text: WHO_TEXT[who].text })
        : null,
      h("button", {
        class: "card-ctl card-pin",
        type: "button",
        "aria-pressed": () => String(state.dockPinned().includes(id)),
        title: () => (state.dockPinned().includes(id) ? `Unpin ${title}` : `Pin ${title} to the top`),
        "aria-label": () => (state.dockPinned().includes(id) ? `Unpin ${title}` : `Pin ${title} to the top`),
        ref: (el: HTMLElement) => el.appendChild(icon("pin", { size: 12 })),
        onclick: () => state.dockPinned.update((p) => togglePin(p, id)),
      }),
      h("button", {
        class: "card-ctl card-x",
        type: "button",
        title: `Remove ${title} — add it back from "+ Add panel"`,
        "aria-label": `Remove ${title}`,
        ref: (el: HTMLElement) => el.appendChild(icon("close", { size: 12 })),
        onclick: () => {
          const next = removeCard({ pinned: state.dockPinned(), removed: state.dockRemoved() }, id);
          state.dockPinned.set(next.pinned);
          state.dockRemoved.set(next.removed);
          toaster.push({ level: "info", title: `${title} removed`, body: 'Add it back any time from "+ Add panel".' });
        },
      }),
    ) as HTMLElement;
  }

  let addOpen: { close: () => void } | null = null;
  const addButton = h(
    "button",
    {
      class: "dock-mini dock-add",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Put a card back on the column",
      onclick: (e: Event) => {
        e.preventDefault();
        if (addOpen) {
          addOpen.close();
          addOpen = null;
          return;
        }
        const cards = addableCards(state.dockRemoved());
        const items: MenuItem[] =
          cards.length === 0
            ? [{ label: "Every card is already on the column", disabled: true }]
            : cards.map((c) => ({
                label: c.who ? `${c.title}  ·  ${WHO_TEXT[c.who].text}` : c.title,
                run: () => reveal(c.id),
              }));
        addOpen = openMenu(items, {
          anchor: addButton,
          placement: "bottom-end",
          ctx: { commands, keymap },
          onClose: () => {
            addOpen = null;
            addButton.setAttribute("aria-expanded", "false");
          },
        });
        addButton.setAttribute("aria-expanded", "true");
      },
    },
    icon("plus", { size: 11 }),
    h("span", { text: "Add panel" }),
  ) as HTMLButtonElement;

  /**
   * The shut inspector: one icon per card on the column, pins first. Built
   * from `shownCards`, so a removed card is not offered here either — the
   * strip and the column cannot disagree about what exists.
   */
  const iconStrip = h(
    "div",
    { class: "dock-rail", role: "toolbar", "aria-label": "Inspector cards", "aria-orientation": "vertical" },
    h("button", {
      class: "rail-open",
      type: "button",
      title: () => `Open the inspector (${keymap.keysFor("ui.dock") ?? "B"} or ])`,
      "aria-label": "Open the inspector",
      ref: (el: HTMLElement) => el.appendChild(icon("chevronLeft", { size: 14 })),
      onclick: () => d.dockToggle.set(true),
    }),
    h("div", {
      class: "rail-icons",
      ref: (el: HTMLElement) => {
        const paint = (): void => {
          el.replaceChildren(
            ...shownCards(state.dockPinned(), state.dockRemoved()).map((c) =>
              h("button", {
                class: "rail-icon",
                type: "button",
                "data-pinned": String(state.dockPinned().includes(c.id)),
                title: c.title,
                "aria-label": `Open ${c.title}`,
                ref: (b: HTMLElement) => b.appendChild(icon(c.icon, { size: 14 })),
                onclick: () => reveal(c.id),
              }),
            ),
          );
        };
        renderEffect(paint);
      },
    }),
  ) as HTMLElement;

  return { cardHead, addButton, iconStrip, reveal };
}
