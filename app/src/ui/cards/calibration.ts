/**
 * "Where it said this, how often it was right" — one owner, two desks.
 *
 * WHY THIS IS A MODULE AND NOT A BLOCK IN EACH DESK
 *
 * The Playbook shows a router's reliability curve for a rule you asked about,
 * and the Simulation desk shows one for a market the loop studied by itself.
 * Two hand-written copies of the same block WILL disagree — CLAUDE.md measures
 * the last time that happened at 0 of 24 agreeing — and a calibration curve is
 * exactly the kind of thing that gets "improved" on one screen and not the
 * other until the two are arguing about the same model.
 *
 * TWO THINGS IT REFUSES TO GET WRONG
 *
 * 1. THE BAR IS THE OBSERVED RATE, never the model's claim. A bar drawn from
 *    the claim is a picture of the model agreeing with itself, which is how
 *    every flattering calibration plot is made.
 * 2. AN EMPTY BUCKET IS DROPPED, not drawn at zero. A bucket with no setups in
 *    it has no observed rate, and a zero-length bar there reads as "it was
 *    never right in this range" — the opposite of "it never said this".
 */

import { each, h } from "../dom";
import type { CalibrationBucket } from "../../data/router";

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");

/** The buckets worth drawing: the ones that actually held setups. */
export const liveBuckets = (all: readonly CalibrationBucket[]): CalibrationBucket[] =>
  all.filter((b) => b.n > 0);

export interface CalibrationOptions {
  /** The curve, or an empty list when there is nothing to draw. */
  readonly buckets: () => readonly CalibrationBucket[];
  /** The line under it: a threshold read off the curve, or why there is none. */
  readonly note: () => string;
  readonly heading?: string;
}

/*
 * `clb-`, NOT `cal-`. MEASURED IN THE BROWSER.
 *
 * `.cal-row` was declared twice in `desks.css`: the economic calendar's
 * five-column grid at line 522, and this card's four-column grid 1,280 lines
 * later. The later one won, so the CALENDAR's rows — five children — were laid
 * out on this card's four tracks, wrapping the fifth onto an implicit row and
 * squeezing an 82px time column into 48. Measured: a calendar row reported
 * `48px minmax(0px, 1fr) 48px 56px` with `children: 5`.
 *
 * That is the `.sy-` defect this project already records — "the desk rendered
 * in another desk's clothes for two releases" — and `classcollide.py` missed it
 * because both declarations live in the SAME sheet and it compares prefixes
 * across sheets. The audit now checks for duplicates within a sheet too.
 *
 * `cal-h` is deliberately NOT renamed: it is a shared small-card heading used
 * by the track record and simulation desks as well, and the calendar does not
 * declare it, so it collides with nothing.
 */
export function calibrationCard(opts: CalibrationOptions): HTMLElement {
  /*
   * `each`, NOT A HAND-ROLLED FRAGMENT.
   *
   * This built a DocumentFragment in a reactive child and returned it. That
   * shape appends ONCE at the end, so a single row whose render throws loses
   * the ENTIRE list — and `createReaction` swallows the throw, leaving a card
   * that is merely empty with nothing red anywhere.
   *
   * It is not hypothetical here: this card draws figures from a service that
   * sends null for a population it cannot grade, and `trackrecord.ts` lost
   * three whole tables to exactly that — five markets rendered as none because
   * one was ungradeable. `each` inserts per item, so a bad row costs its own
   * row and nothing else.
   */
  const rows = h("div", { class: "clb-rows" }) as HTMLElement;
  each(
    rows,
    () => [...opts.buckets()],
    (b) => `${b.from}-${b.to}`,
    (b) =>
      h(
        "div",
        { class: "clb-row" },
        h("span", { class: "clb-said num", text: pct(b.predicted) }),
        h(
          "span",
          { class: "clb-bar" },
          h("span", {
            class: "clb-fill",
            /* Clamped, because a width outside 0-100% is a bar that escapes its
               track rather than an error anyone sees. */
            style: `width:${Math.max(0, Math.min(100, (b.observed ?? 0) * 100)).toFixed(1)}%`,
          }),
        ),
        h("span", { class: "clb-was num", text: pct(b.observed) }),
        h("span", { class: "clb-n num", text: `n=${b.n}` }),
      ) as HTMLElement,
  );

  return h(
    "div",
    { class: "clb", "data-on": () => String(opts.buckets().length > 0) },
    h("h4", { class: "cal-h", text: opts.heading ?? "Where it said this, how often it was right" }),
    rows,
    h("p", {
      class: "clb-note",
      text: opts.note,
      style: () => (opts.note() ? "" : "display:none"),
    }),
  ) as HTMLElement;
}

/**
 * The sentence a router's verdict deserves, in the operator's words.
 *
 * NO SKILL IS AN ANSWER. It is the most common honest thing a router can say,
 * and a screen that renders it as a failure teaches people to ignore the one
 * reading here that is reliably true.
 */
export function skillSentence(rep: {
  readonly skill: boolean;
  readonly accuracy: number;
  readonly baseRate: number;
  readonly auc: number;
  readonly scored: number;
}): string {
  const floor = pct(Math.max(rep.baseRate, 1 - rep.baseRate));
  if (!rep.skill) {
    return (
      `No skill. Out of sample it was right ${pct(rep.accuracy)} of the time, where always guessing the ` +
      `common outcome would have been right ${floor}. Nothing here separates the winning setups from the ` +
      "losing ones, so this must not be used to filter trades."
    );
  }
  return (
    `It learned something. AUC ${rep.auc.toFixed(3)} against 0.500, right ${pct(rep.accuracy)} of the time ` +
    `against a ${floor} floor, over ${rep.scored.toLocaleString()} setups it had never seen.`
  );
}
