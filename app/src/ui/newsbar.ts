/**
 * The news bar — one headline at a time, above the live bar.
 *
 * WHY IT IS NOT A MARQUEE
 * `ui/livebar.ts` makes this argument for numbers: v39's status bar cycled its
 * fields in a scrolling strip, and "you cannot find a number that is moving and
 * you certainly cannot compare two". Text is not quite as bad as numbers, but a
 * headline sliding past is a headline you cannot finish reading, cannot click,
 * and cannot re-find once it has gone. So the bar holds ONE story still for
 * `dwellMs`, then swaps it.
 *
 * The swap pauses on hover and while the list is open, because the moment a
 * reader engages is the exact moment a timer must stop moving things.
 *
 * WHAT IT REFUSES
 *
 * **The source never truncates.** `ui/tape.ts` states the rule and this obeys
 * it: an unattributed headline in a trading terminal is worse than no headline.
 * The title takes the ellipsis; the source and the age do not.
 *
 * **The age is always on screen, and "unknown age" is spelled out.** A ticker
 * whose items have no visible timestamp will eventually show something old at
 * the top and be believed.
 *
 * **Nothing opens on its own.** A click opens a link in a new tab and that is a
 * deliberate act; the bar never navigates, never previews, never fetches an
 * article. Rendering a stranger's HTML in a trading terminal is how a terminal
 * gets a script tag it did not write.
 *
 * **Silence is explained, not implied.** An empty bar says which of the three
 * silences it is — no service, no feeds answering, or a genuinely quiet hour —
 * because those have completely different next actions. Same distinction the
 * Flow desk had to be taught.
 */

import { clear, h } from "./dom";
import { renderEffect, signal, type ReadSignal } from "../core/signal";
import { age, emptyReason, type RssFeed, type RssItem } from "../data/rss";

export interface NewsBarOptions {
  readonly feed: ReadSignal<RssFeed>;
  /** Ticks so the age re-renders without this owning a second timer. */
  readonly now: () => number;
  /** How long one headline is held still. */
  readonly dwellMs?: number;
  readonly onRefresh: () => void;
  /** Open a link. Injected so the tests never touch `window.open`. */
  readonly onOpen?: (url: string) => void;
}

export interface NewsBar {
  readonly el: HTMLElement;
  destroy(): void;
}

export const DEFAULT_DWELL_MS = 9_000;

/**
 * Which story to show at `tick`.
 *
 * Pure, so the rotation is testable without a clock. Wraps by modulo rather
 * than tracking an index, which means a shrinking list can never leave the bar
 * pointing past the end — the failure that would show a blank bar after a
 * refresh returned fewer items.
 */
export function itemAt(items: readonly RssItem[], tick: number): RssItem | null {
  if (items.length === 0) return null;
  const i = ((tick % items.length) + items.length) % items.length;
  return items[i] ?? null;
}

/** `3 of 57` — where you are in the rotation. */
export function positionText(items: readonly RssItem[], tick: number): string {
  if (items.length === 0) return "";
  const i = ((tick % items.length) + items.length) % items.length;
  return `${i + 1}/${items.length}`;
}

/**
 * How the feed's own health should read.
 *
 * A partial failure is the case worth wording carefully: four working feeds
 * out of five looks fine and means the operator is missing a fifth of their
 * coverage without being told which fifth.
 */
export function healthText(feed: RssFeed): { text: string; tone: "ok" | "off" | "warn" } {
  /* Three silences, three tones, and none of them is the loss colour.
     News is context, not the instrument: the red that says "nothing on this
     screen is being updated" belongs to the PRICE feed (see ui/tape.ts), and
     spending it here made a terminal at rest look broken — two red words on
     every screen of a fresh install. A failure is a caution; an unconfigured
     bar is a setting and reads as neutral. The words still differ, because the
     next actions do. */
  if (feed.error !== null) return { text: "no service", tone: "warn" };
  if (feed.feeds === 0) return { text: "not set up", tone: "off" };
  if (feed.working === 0) return { text: "all feeds down", tone: "warn" };
  if (feed.working < feed.feeds) {
    const broken = feed.status.filter((s) => !s.ok).map((s) => s.source);
    return { text: `${broken.join(", ")} down`, tone: "warn" };
  }
  return { text: `${feed.feeds} feeds`, tone: "ok" };
}

export function createNewsBar(opts: NewsBarOptions): NewsBar {
  const dwell = opts.dwellMs ?? DEFAULT_DWELL_MS;
  const tick = signal(0);
  const paused = signal(false);
  const open = signal(false);

  const openLink = (url: string): void => {
    if (!url) return;
    if (opts.onOpen) {
      opts.onOpen(url);
      return;
    }
    /* `noopener` is not optional: without it the opened page gets a handle on
       this window through `window.opener` and can navigate it. */
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const current = (): RssItem | null => itemAt(opts.feed().items, tick());

  const headline = h(
    "button",
    {
      class: "nb-item",
      type: "button",
      title: () => {
        const item = current();
        return item ? `${item.title} — ${item.source}` : "";
      },
      disabled: () => current() === null,
      onclick: () => {
        const item = current();
        if (item) openLink(item.link);
      },
    },
    h("span", { class: "nb-dot" }),
    /* The title is the only thing allowed to truncate. */
    h("span", {
      class: "nb-title",
      text: () => current()?.title ?? "",
    }),
    h("span", { class: "nb-src", text: () => current()?.source ?? "" }),
    h("span", {
      class: "nb-age",
      text: () => {
        const item = current();
        return item ? age(item.at, opts.now()) : "";
      },
    }),
  ) as HTMLElement;

  const emptyEl = h("span", {
    class: "nb-empty",
    text: () => emptyReason(opts.feed()),
  }) as HTMLElement;

  const list = h("div", { class: "nb-list", hidden: () => !open() }) as HTMLElement;

  /* Built on open, not on every feed change. The bar shows one story; the list
     is a thing the operator asked for. */
  renderEffect(() => {
    if (!open()) {
      clear(list);
      return;
    }
    const feed = opts.feed();
    const now = opts.now();
    clear(list);

    /* Feed health first. A list of twelve stories from four of five feeds is
       not the same list as twelve stories from five of five, and the reader
       cannot tell by looking at the stories. */
    for (const s of feed.status) {
      if (s.ok) continue;
      list.appendChild(
        h(
          "div",
          { class: "nb-row nb-row-bad" },
          h("span", { class: "nb-row-src", text: s.source }),
          h("span", { class: "nb-row-title", text: s.error ?? "did not answer" }),
        ),
      );
    }

    if (feed.items.length === 0) {
      list.appendChild(h("div", { class: "nb-row" }, h("span", { class: "nb-row-title", text: emptyReason(feed) })));
      return;
    }

    for (const item of feed.items.slice(0, 40)) {
      list.appendChild(
        h(
          "button",
          {
            class: "nb-row",
            type: "button",
            title: item.link || item.title,
            onclick: () => openLink(item.link),
          },
          h("span", { class: "nb-row-src", text: item.source }),
          h("span", { class: "nb-row-title", text: item.title }),
          h("span", { class: "nb-row-age", text: age(item.at, now) }),
        ),
      );
    }
  });

  const el = h(
    "div",
    {
      class: "newsbar",
      role: "region",
      "aria-label": "News",
      /* Hovering is engaging. A rotation that keeps moving under the cursor is
         one the reader cannot finish reading or click. */
      onmouseenter: () => paused.set(true),
      onmouseleave: () => paused.set(false),
    },
    h("span", { class: "nb-label", text: "NEWS" }),
    h("div", { class: "nb-slot" }, () => (opts.feed().items.length === 0 ? emptyEl : headline)),
    h("span", {
      class: "nb-pos",
      text: () => positionText(opts.feed().items, tick()),
    }),
    h("button", {
      class: "nb-health",
      type: "button",
      "data-tone": () => healthText(opts.feed()).tone,
      text: () => healthText(opts.feed()).text,
      title: "Show every story, and which feeds are failing",
      onclick: () => open.update((v) => !v),
    }),
    h("button", {
      class: "nb-btn",
      type: "button",
      text: "↻",
      title: "Refetch every feed now",
      onclick: () => opts.onRefresh(),
    }),
    list,
  ) as HTMLElement;

  /* One interval for the whole bar. Paused while the reader is engaged, and it
     advances the TICK rather than an index — see `itemAt` for why that cannot
     end up pointing past the end of a shrinking list. */
  const timer = setInterval(() => {
    if (paused.peek() || open.peek()) return;
    if (opts.feed.peek().items.length < 2) return;
    tick.update((t) => t + 1);
  }, dwell);

  return {
    el,
    destroy() {
      clearInterval(timer);
      clear(el);
      el.remove();
    },
  };
}
