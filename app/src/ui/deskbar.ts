/**
 * The desk switcher, living inside the command bar.
 *
 * WHY THIS IS ITS OWN MODULE
 * Before v46 the shell had TWO horizontal navigations stacked on top of each
 * other: an application row (brand, File/View/… menus, utilities) and, one row
 * below the chart controls, a tab strip listing the ten desks. Two bars that
 * both look like menus is the layout equivalent of two front doors — the user
 * has to learn which question each answers, and the chart controls sandwiched
 * between them appeared to belong to whichever row was looked at last.
 *
 * They are one row now. The cost of merging is that ten labelled destinations,
 * six menus, a brand and six utilities do not fit on one line at every width,
 * and that cost has to be paid HONESTLY: not by clipping (controls that exist
 * but cannot be reached), not by shrinking the type (the thing the user already
 * said was too small), and not by dropping to icons alone (an icon strip is
 * exactly what read as cramped when the rail was still here).
 *
 * It is paid by SPILLING. Whatever does not fit moves into a "More" menu at the
 * end of the row, and the selected desk is never the thing that spills — you
 * can always see where you are. This is what every serious toolbar does, and it
 * is the only strategy that keeps every destination reachable at every width.
 *
 * MEASUREMENT, NOT GUESSWORK
 * The break points are not media queries with hand-picked pixel values. The bar
 * measures its own children against its own allotted width, so it stays correct
 * when the density setting changes the type ramp, when a desk is renamed, and
 * in a language whose words are longer than English's.
 *
 * WHY IT GROUPS, AND WHEN SPILLING STOPPED BEING ENOUGH
 * Spilling is the right answer for ten destinations and the wrong one for
 * sixteen. Measured at 1200px with sixteen desks, FIVE fit and eleven went into
 * "More" — so two thirds of the terminal lived behind one anonymous button, and
 * the row had quietly become a list of the five desks whose names happened to
 * sort first. That is worse than the two-bar layout this module replaced.
 *
 * So the desks are GROUPED, and the bar shows one button per group. Five
 * buttons fit at any width worth supporting.
 *
 * SINCE v59 A GROUP IS A WORKSPACE (Today, Scan, Trade, Review, Lab). Clicking
 * one you are not in takes you to the desk you last used there; clicking the
 * one you are in opens its menu. Its label is the workspace, plus the desk
 * when that is not the workspace's first: "Trade · Flow". Groups with a single
 * desk are plain buttons and open nothing.
 *
 * The spill logic below is kept and still runs — it is what handles a genuinely
 * tiny window, where even five groups do not fit. It just no longer carries the
 * whole load.
 */

import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { openMenu, type MenuContext, type MenuItem } from "./menu";
import { effect } from "../core/signal";

export interface DeskDef {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Shown in the spill menu and as the button's tooltip. */
  readonly hint?: string;
  /** Group this desk belongs to. Desks with no group stand alone. */
  readonly group?: string;
}

export interface DeskGroup {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly desks: readonly DeskDef[];
}

/**
 * Fold a flat desk list into the groups the bar renders.
 *
 * Order is taken from the desk list — the first desk of a group fixes where
 * that group sits — so the grouping never silently reorders the terminal.
 */
export function groupDesks(desks: readonly DeskDef[]): DeskGroup[] {
  const out: DeskGroup[] = [];
  const byId = new Map<string, DeskDef[]>();
  for (const d of desks) {
    const gid = d.group ?? d.id;
    let bucket = byId.get(gid);
    if (!bucket) {
      bucket = [];
      byId.set(gid, bucket);
      out.push({ id: gid, label: d.group ?? d.label, icon: d.icon, desks: bucket });
    }
    bucket.push(d);
  }
  return out;
}

export interface DeskBarOptions {
  readonly desks: readonly DeskDef[];
  readonly current: () => string;
  readonly onSelect: (id: string) => void;
  readonly ctx: MenuContext;
  /** Command id per desk, so the spill menu can show the real accelerator. */
  readonly commandFor?: (id: string) => string | undefined;
  /**
   * Who leads in each workspace ("AI-led", "built together"), by group label.
   * Shown under the name on the CURRENT workspace's tab only: on all five it
   * would make every tab twice as wide, and the row is measured to fit.
   */
  readonly leads?: Readonly<Record<string, string>>;
}

/** Used only until the button has been laid out and can report its own width. */
const SPILL_FALLBACK = 64;

export function createDeskBar(opts: DeskBarOptions): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();
  let spillHandle: { close: () => void } | null = null;

  const bar = h("div", {
    class: "deskbar",
    role: "tablist",
    "aria-label": "Desks",
  }) as HTMLElement;

  const groups = groupDesks(opts.desks);
  /** Which group holds a given desk, for the "where am I" highlight. */
  const groupOf = new Map<string, DeskGroup>();
  for (const g of groups) for (const d of g.desks) groupOf.set(d.id, g);

  let openGroup: { close: () => void } | null = null;

  /**
   * The desk last used in each group — v59's workspaces.
   *
   * A group is a WORKSPACE now (Today, Scan, Trade, Review, Lab), and the first
   * click on one should put you IN it, not open a menu about it: Trade holds
   * the chart, and a chart two clicks away is a chart nobody uses. So a click
   * on a group you are not in goes to the desk you last used there (its first
   * desk until you have used one), and only a click on the group you are
   * already in opens its menu.
   */
  const lastIn = new Map<string, string>();
  effect(() => {
    const cur = opts.current();
    const g = groupOf.get(cur);
    if (g) lastIn.set(g.id, cur);
  });
  const entryOf = (g: DeskGroup): string => lastIn.get(g.id) ?? (g.desks[0] as DeskDef).id;

  for (const g of groups) {
    const solo = g.desks.length === 1;
    const only = g.desks[0] as DeskDef;
    const holdsCurrent = (): boolean => groupOf.get(opts.current())?.id === g.id;

    const btn = h(
      "button",
      {
        class: "desk-tab",
        type: "button",
        role: solo ? "tab" : "button",
        "data-desk": g.id,
        ...(solo ? {} : { "aria-haspopup": "menu" }),
        title: solo ? (only.hint ?? only.label) : `${g.label}: ${g.desks.map((d) => d.label).join(", ")}`,
        "aria-selected": () => String(holdsCurrent()),
        "data-current": () => String(holdsCurrent()),
        /* Screen readers hear the desk open inside the workspace, which the
           visible label no longer carries. */
        "aria-label": () => {
          const d = g.desks.find((x) => x.id === opts.current());
          return holdsCurrent() && d && !solo ? `${g.label}, ${d.label}` : solo ? only.label : g.label;
        },
        /* Only the group you are standing in sits in the page tab order. A
           tablist that costs sixteen presses to walk past is a keyboard trap of
           its own; the arrow keys move between groups instead. */
        tabindex: () => (holdsCurrent() ? "0" : "-1"),
        onclick: (e: Event) => {
          e.preventDefault();
          if (solo) {
            opts.onSelect(only.id);
            return;
          }
          if (!holdsCurrent()) {
            opts.onSelect(entryOf(g));
            return;
          }
          if (openGroup) {
            openGroup.close();
            openGroup = null;
            return;
          }
          const items: MenuItem[] = g.desks.map((d) => {
            const cmd = opts.commandFor?.(d.id);
            return {
              ...(cmd ? { id: cmd } : {}),
              label: d.label,
              checked: opts.current() === d.id,
              run: () => opts.onSelect(d.id),
            };
          });
          openGroup = openMenu(items, {
            anchor: btn,
            placement: "bottom-start",
            ctx: opts.ctx,
            onClose: () => {
              openGroup = null;
            },
          });
        },
        onkeydown: (e: Event) => {
          const ev = e as KeyboardEvent;
          const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
          if (step === 0) return;
          ev.preventDefault();
          const visible = groups.filter((x) => {
            const b = buttons.get(x.id);
            return b !== undefined && !b.hasAttribute("data-spilled");
          });
          const at = visible.findIndex((x) => x.id === g.id);
          const next = visible[(at + step + visible.length) % visible.length];
          if (!next) return;
          opts.onSelect(entryOf(next));
          buttons.get(next.id)?.focus();
        },
      },
      icon(g.icon as IconName),
      h(
        "span",
        { class: "desk-tab-text" },
        h("span", {
        class: "desk-tab-label",
        /* The workspace's name, and only that. v59 first tried "Trade · Flow";
           measured at 800px, the longer label pushed Review and Lab into
           "More" — and five always-visible workspaces are the point. The desk
           names itself in its own heading, and the workspace's menu ticks it. */
        text: () => (solo ? only.label : g.label),
        }),
        h("span", {
          class: "desk-tab-lead",
          /* v59.2: every tab carries its lead, as in the v5 design — the
             balance between you and the terminal is what tells the five
             apart, and it should be readable before you choose. */
          text: opts.leads?.[g.label] ?? "",
        }),
      ),
      solo ? null : icon("chevronDown", { size: 11 }),
    ) as HTMLButtonElement;
    buttons.set(g.id, btn);
    bar.appendChild(btn);
  }

  /**
   * The spill button.
   *
   * It reports a COUNT rather than just a chevron, because "three more desks"
   * and "everything fits" are different states and a bare chevron cannot tell
   * them apart at a glance.
   */
  const spillCount = h("span", { class: "desk-more-count" }) as HTMLElement;
  const spill = h(
    "button",
    {
      class: "desk-more",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Desks that do not fit on this row",
      onclick: (e: Event) => {
        e.preventDefault();
        if (spillHandle) {
          spillHandle.close();
          spillHandle = null;
          return;
        }
        const items: MenuItem[] = [];
        for (const g of groups) {
          const gbtn = buttons.get(g.id);
          if (!gbtn || !gbtn.hasAttribute("data-spilled")) continue;
          if (g.desks.length === 1) {
            const only = g.desks[0] as DeskDef;
            const cmd = opts.commandFor?.(only.id);
            items.push({
              ...(cmd ? { id: cmd } : {}),
              label: only.label,
              checked: opts.current() === only.id,
              run: () => opts.onSelect(only.id),
            });
            continue;
          }
          items.push({
            label: g.label,
            items: g.desks.map((d) => {
              const cmd = opts.commandFor?.(d.id);
              return {
                ...(cmd ? { id: cmd } : {}),
                label: d.label,
                checked: opts.current() === d.id,
                run: () => opts.onSelect(d.id),
              };
            }),
          });
        }
        if (items.length === 0) items.push({ label: "Every desk fits.", disabled: true });
        spill.setAttribute("aria-expanded", "true");
        spillHandle = openMenu(items, {
          anchor: spill,
          placement: "bottom-end",
          ctx: opts.ctx,
          onClose: () => {
            spill.setAttribute("aria-expanded", "false");
            spillHandle = null;
          },
        });
      },
    },
    h("span", { text: "More" }),
    spillCount,
    icon("chevronDown", { size: 12 }),
  ) as HTMLButtonElement;
  bar.appendChild(spill);

  /**
   * Decide what fits.
   *
   * Everything is un-spilled first so the widths read are the widths the tabs
   * would actually occupy. That is one forced layout per resize — the correct
   * price, because the alternative is caching numbers that go stale the moment
   * the density setting or the font changes, and a stale cache here shows a
   * "More" button with nothing behind it.
   */
  const reflow = (): void => {
    if (bar.clientWidth === 0) return; /* Not laid out yet — a later observation will do it. */

    for (const btn of buttons.values()) btn.removeAttribute("data-spilled");
    spill.removeAttribute("data-spilled");

    const natural = groups.map((g) => ({
      id: g.id,
      w: buttons.get(g.id)?.offsetWidth ?? 0,
    }));
    const spillWidth = spill.offsetWidth || SPILL_FALLBACK;
    /* THE GAPS COUNT. Summing the tabs alone said "everything fits" while the
       last tab was cut off by the space between them — measured at 1280px as
       Lab clipped with nothing in "More". */
    const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
    const total = natural.reduce((s, x) => s + x.w, 0) + gap * Math.max(0, natural.length - 1);

    /* ASK FOR THAT WIDTH. The bar's flex basis is what it needs to show every
       tab, set here rather than left to `auto` — `auto` sizes it to whatever is
       CURRENTLY showing, so once two tabs spilled the bar shrank to three and
       every later measurement agreed two did not fit (v59, 1024px: 349px
       allotted for 435). With the full width as its basis, the search field
       beside it gives way first (see `.omnibox` in shell.css). */
    const basis = `${Math.ceil(total)}px`;
    if (bar.style.flexBasis !== basis) bar.style.flexBasis = basis;
    const width = bar.clientWidth;

    if (total <= width) {
      spill.setAttribute("data-spilled", "");
      return;
    }

    /* The selected desk is reserved before anything else is allowed to claim
       room. A switcher that hides the desk you are standing on tells you
       nothing about where you are, which is its entire job. */
    const currentId = groupOf.get(opts.current())?.id ?? opts.current();
    const currentW = natural.find((x) => x.id === currentId)?.w ?? 0;
    let used = spillWidth + gap + currentW;
    const keep = new Set<string>([currentId]);

    /* Stop at the FIRST tab that does not fit rather than skipping it and
       trying the next. Continuing packs one or two more in, but it drops a
       hole in the middle of a fixed order — at 1024px it showed Chart,
       Decision, Signals, Risk, which reads as a bug because Strategy and Flow
       have silently vanished from between them. A prefix plus the desk you are
       standing on is a shape the user can predict. */
    for (const x of natural) {
      if (x.id === currentId) continue;
      if (used + gap + x.w > width) break;
      used += gap + x.w;
      keep.add(x.id);
    }

    let hidden = 0;
    for (const g of groups) {
      if (keep.has(g.id)) continue;
      buttons.get(g.id)?.setAttribute("data-spilled", "");
      hidden++;
    }
    spillCount.textContent = hidden > 0 ? String(hidden) : "";
    if (hidden === 0) spill.setAttribute("data-spilled", "");
  };

  /* Re-measure when the row changes size AND when the selection changes: the
     selected tab is the one entry that may never spill, so moving the selection
     can change what else fits beside it. */
  const ro = new ResizeObserver(() => reflow());
  ro.observe(bar);
  /* THE TABS TOO (v59). The bar's width is now pinned to what its tabs need,
     so the tabs growing — the web font arriving, a density change — no longer
     resizes the bar, and watching only the bar missed it. Measured at 1110px:
     the basis was taken before the font loaded (411px), the tabs then needed
     427, and Lab was clipped with nothing in "More". A reflow leaves each tab
     the size it found it, so observing them cannot feed back into a loop. */
  for (const b of buttons.values()) ro.observe(b);
  void document.fonts?.ready.then(() => reflow());
  /* And the window, as a belt. Measured at 760px: a resize from 1024 left the
     bar 40px short with nothing in "More" — the observer did not deliver — and
     a reflow run by hand at that moment spilled correctly. `reflow` is
     idempotent, so an extra call costs one layout read. The bar lives for the
     whole session, like the shell, so there is nothing to remove. */
  window.addEventListener("resize", () => reflow());
  effect(() => {
    opts.current();
    /* Deferred so the aria/tabindex writes for this selection have landed and
       the measured widths are the ones about to be painted. */
    queueMicrotask(reflow);
  });

  return bar;
}
