/**
 * THE MORNING, AS A LIST YOU WORK DOWN.
 *
 * `today/routine.ts` is the arithmetic and holds no state; this renders it.
 * The card computes nothing — it is handed the answers and shows them, so
 * there is no second opinion about whether the data is stale or the governor
 * will let you trade.
 *
 * `rt-` as the prefix, checked with `scratchpad/classcollide.py` before a line
 * was written: this repository shipped a desk wearing another desk's styles
 * for two releases because `.sy-` was claimed by two sheets and the later one
 * won.
 *
 * NO MOTION. A checklist met every morning is the definition of something seen
 * hundreds of times, and the house rule is that frequency decides whether a
 * thing animates at all.
 */

import { h, clear } from "../dom";
import { renderEffect } from "../../core/signal";
import { buildRoutine, summarise, type RoutineInput, type RoutineStep } from "../today/routine";
import { deskLabel } from "../shell/views";
import type { ViewId } from "../shell/views";

export interface RoutineCardDeps {
  /** Everything the routine needs, read fresh on every render. */
  readonly read: () => RoutineInput;
  /** Take me to the desk that answers this step. */
  readonly openDesk?: (view: string) => void;
}

export interface RoutineCard {
  readonly el: HTMLElement;
  /** Re-read and redraw. The answers move during a session. */
  refresh(): void;
}

/**
 * The mark against each step.
 *
 * FOUR STATES, FOUR MARKS, and `unknown` gets its own rather than borrowing
 * one. A step nobody could check drawn as a tick is a lie and drawn as a cross
 * is a different one; the question mark is the honest third thing, and it is
 * the reason this card can be trusted on a morning when a service is down.
 */
const MARK: Record<RoutineStep["state"], { glyph: string; label: string }> = {
  done: { glyph: "✓", label: "done" },
  todo: { glyph: "○", label: "still to do" },
  blocked: { glyph: "!", label: "stopping you" },
  unknown: { glyph: "?", label: "could not be checked" },
};

export function createRoutineCard(deps: RoutineCardDeps): RoutineCard {
  const body = h("div", { class: "rt-body" }) as HTMLElement;
  const head = h("span", { class: "rt-says" }) as HTMLElement;
  const count = h("span", { class: "rt-count num" }) as HTMLElement;

  const el = h(
    "section",
    { class: "dd-panel rt-card" },
    h(
      "header",
      { class: "panel-head" },
      h("h2", { class: "panel-title", text: "Before you trade" }),
      count,
    ),
    head,
    body,
  ) as HTMLElement;

  function render(): void {
    const steps = buildRoutine(deps.read());
    const sum = summarise(steps);

    clear(body);
    head.textContent = sum.says;
    /* The summary carries the state so the colour follows the STANDING rather
       than the number — a list with one blocker is not a worse version of a
       list with none, it is a different answer. */
    head.setAttribute("data-state", sum.blocked > 0 ? "blocked" : sum.ready ? "done" : "todo");
    count.textContent = `${sum.done}/${sum.total}`;

    for (const s of steps) {
      const mark = MARK[s.state];
      /* The desk's name comes from `deskLabel`, never written here: one owner
         for a desk's display name is why fifteen stale ones had to be hunted
         down twice. `routine.test.ts` pins every step's id against `VIEW_IDS`,
         so this cannot be handed a desk the shell has no screen for. */
      const to = deskLabel(s.desk as ViewId);

      const row = h(
        "div",
        { class: "rt-row", "data-state": s.state },
        h("span", { class: "rt-mark", text: mark.glyph, "aria-label": mark.label, role: "img" }),
        h(
          "span",
          { class: "rt-what" },
          h("span", { class: "rt-label", text: s.label }),
          h("span", { class: "rt-says-row", text: s.says }),
        ),
        /* The step is one press from being done. A routine that tells you what
           is outstanding and makes you find the desk yourself is a list, not a
           routine. */
        deps.openDesk === undefined
          ? (h("span", { class: "rt-to", text: to }) as HTMLElement)
          : (h("button", {
              class: "ghost-btn tiny rt-go",
              type: "button",
              text: to,
              "aria-label": `${s.label} — open ${to}`,
              onclick: () => deps.openDesk?.(s.desk),
            }) as HTMLElement),
      ) as HTMLElement;
      body.appendChild(row);
    }
  }

  /**
   * IT RE-READS WHEN ITS ANSWERS CHANGE, and the first version did not.
   *
   * MEASURED on the running terminal: the calendar is loaded asynchronously at
   * boot, so on one reload the step read "17 scheduled, 2 high impact" and on
   * the next it read "could not check — the calendar did not answer". Same
   * build, same machine; the card had simply rendered before the feed arrived
   * and never looked again. It was only ever right by luck of timing.
   *
   * `renderEffect` tracks whatever `deps.read()` touches — the bars, the
   * calendar feed, the plan, the governor's last answer — so an answer that
   * arrives late reaches the screen. `refresh()` stays for the caller that
   * wants to force it; this is for the ones that cannot know to.
   */
  renderEffect(render);
  return { el, refresh: render };
}
