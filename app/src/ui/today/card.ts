/**
 * The Today workspace's card: a title and WHO produced it.
 *
 * The tag reuses `.card-who[data-who]` from `styles/inspector.css` rather
 * than a look of its own, so "AI" and "You" read identically on every
 * surface that carries them.
 */

import { h, type Child } from "../dom";

export type Who = "ai" | "you" | "both";

const WHO_WORD: Record<Who, string> = { ai: "AI", you: "You", both: "AI · you" };

export function whoTag(who: Who, text: string = WHO_WORD[who]): HTMLElement {
  return h("span", { class: "card-who", "data-who": who, text }) as HTMLElement;
}

export function todayCard(title: string, who: Who, cls: string, ...body: Child[]): HTMLElement {
  return h(
    "section",
    { class: `dd-panel td-card ${cls}`, "data-who": who },
    h("header", { class: "td-card-head" }, h("h2", { class: "td-card-title", text: title }), whoTag(who)),
    ...body,
  ) as HTMLElement;
}
