/**
 * Step two: what gets done with those bars.
 *
 * Two facts sit on every card and neither is decoration. The first is what it
 * COSTS, in seconds, marked as a guess until this machine has actually run it
 * once. The second is how many HYPOTHESES it tests, because that is the number
 * the correction at the bottom of the pipeline is computed from — and a method
 * that tests ninety-seven lags against four drivers is not one test however
 * much it looks like one checkbox.
 *
 * The final step of the pipeline is not in the catalogue and has no control.
 * It is drawn locked, with the reason.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import {
  GROUP_BLURB,
  GROUP_LABEL,
  methodsInGroup,
  type Method,
  type MethodGroup,
} from "../../study/methods";
import { durationLabel, stepAvailability } from "../../study/plan";
import type { StudyState } from "./state";

const GROUPS: readonly MethodGroup[] = ["relationship", "regime", "probability", "strategy"];

export function createMethodStep(state: StudyState): HTMLElement {
  const grid = h("div", { class: "sy-groups" });

  renderEffect(() => {
    const chosen = new Set(state.spec().methods);
    const ctx = state.methodCtx();
    const checked = state.checked();

    grid.replaceChildren(
      ...GROUPS.map((g) =>
        h(
          "section",
          { class: "sy-group" },
          h("h3", { class: "sy-group-h", text: GROUP_LABEL[g] }),
          h("p", { class: "sy-group-b", text: GROUP_BLURB[g] }),
          h(
            "div",
            { class: "sy-cards" },
            ...methodsInGroup(g).map((m) => {
              /* Asked for EVERY card, selected or not. Read out of the plan
                 instead, this was undefined for anything unselected — so the
                 whole catalogue rendered available on a study that could not
                 run half of it. */
              const v = stepAvailability(m, ctx, chosen);
              const blocked = v.state === "blocked";
              const on = chosen.has(m.id);
              return h(
                "button",
                {
                  class: "sy-card",
                  type: "button",
                  "data-on": on ? "1" : "0",
                  "data-blocked": blocked ? "1" : "0",
                  "aria-pressed": on ? "true" : "false",
                  /* A blocked card can still be UNSELECTED — a method that
                     was chosen and then blocked by a later change to the
                     subject has to be removable from the card that shows why.
                     Only selecting it is refused. */
                  onclick: () => {
                    if (blocked && !on) return;
                    state.toggleMethod(m.id, !on);
                  },
                },
                h(
                  "div",
                  { class: "sy-card-top" },
                  h("span", { class: "sy-card-t", text: m.label }),
                  h("span", { class: "sy-card-cost", text: costLabel(m, ctx.rows, checked) }),
                ),
                h("p", { class: "sy-card-b", text: m.blurb }),
                h("p", { class: "sy-card-p", text: m.produces }),
                h("div", { class: "sy-card-foot" }, h("span", { class: "sy-tests", text: testsLabel(m.tests(ctx)) })),
                ...(v.state === "blocked"
                  ? [h("div", { class: "sy-card-block", "data-fixable": v.fixable ? "1" : "0", text: v.reason })]
                  : []),
              );
            }),
          ),
        ),
      ),
    );
  });

  /* ── the pipeline ──────────────────────────────────────────────────────── */

  const pipe = h("div", { class: "sy-panel sy-pipe" });
  renderEffect(() => {
    const plan = state.plan();
    const kids: HTMLElement[] = [h("h4", { class: "sy-panel-h", text: "The pipeline" })];

    if (plan.steps.length === 0) {
      kids.push(h("p", { class: "sy-dim", text: plan.refusal ?? "Nothing selected yet." }));
    } else {
      kids.push(
        ...plan.steps.map((s) =>
          h(
            "div",
            { class: "sy-pstep" },
            h("span", { class: "sy-pstep-n", text: String(s.n) }),
            h(
              "div",
              { class: "sy-pstep-body" },
              h("span", { class: "sy-pstep-t", text: s.method.label }),
              h("span", {
                class: "sy-pstep-m",
                text:
                  s.reads.length > 0
                    ? `reads step ${s.reads.map((r) => plan.steps.find((x) => x.method.id === r)?.n ?? "?").join(", ")} · ${testsLabel(s.tests)}`
                    : testsLabel(s.tests),
              }),
            ),
            h("span", {
              class: "sy-pstep-ms",
              "data-from": s.estimateFrom,
              text: durationLabel(s.estimateMs),
              title:
                s.estimateFrom === "measured"
                  ? "Estimated from the last time this machine ran this step."
                  : "A declared guess. It has never been run here, so nothing has measured it.",
            }),
          ),
        ),
      );

      kids.push(
        h(
          "div",
          { class: "sy-pstep sy-pstep-locked" },
          h("span", { class: "sy-pstep-n", text: "⊙" }),
          h(
            "div",
            { class: "sy-pstep-body" },
            h("span", { class: "sy-pstep-t", text: "Correction and the sealed holdout" }),
            h("span", { class: "sy-pstep-m", text: "Locked on — this step cannot be removed" }),
          ),
        ),
        h("p", { class: "sy-lock-why", text: plan.correction.text }),
        h(
          "div",
          { class: "sy-total" },
          h("span", { text: `${plan.hypotheses.toLocaleString()} hypotheses` }),
          h("span", {
            text: `≈ ${durationLabel(plan.estimateMs)}`,
            title: plan.anyMeasured
              ? "Part of this estimate comes from real runs on this machine."
              : "Nothing here has been run on this machine yet, so the whole estimate is a declared guess.",
          }),
        ),
      );
    }

    if (plan.blocked.length > 0) {
      kids.push(
        h("h4", { class: "sy-panel-h sy-panel-h2", text: `${plan.blocked.length} selected and blocked` }),
        ...plan.blocked.map((s) =>
          h("div", {
            class: "sy-blocked-row",
            text: `${s.method.label} — ${s.availability.state === "blocked" ? s.availability.reason : ""}`,
          }),
        ),
      );
    }

    pipe.replaceChildren(...kids);
  });

  const unchecked = h("div", { class: "sy-panel" });
  renderEffect(() => {
    unchecked.replaceChildren(
      ...(state.checked()
        ? []
        : [
            h("div", {
              class: "sy-callout",
              text: "No bars have been fetched, so every row count below is zero and methods are being blocked for it. Go back to Subject and check the window first.",
            }),
          ]),
      ...(state.healthChecked() && state.health() === null
        ? [
            h("div", {
              class: "sy-callout",
              text: "The quant service has not answered, so every method that needs it is unavailable rather than merely slow. Start the terminal with python run.py.",
            }),
          ]
        : []),
    );
  });

  return h("div", { class: "sy-step sy-method" }, h("div", { class: "sy-main" }, grid), h("aside", { class: "sy-side" }, unchecked, pipe));
}

function testsLabel(n: number): string {
  return n === 1 ? "1 test" : `${n.toLocaleString()} tests`;
}

function costLabel(m: Method, rows: number, checked: boolean): string {
  if (!checked) return "cost unknown until the window is checked";
  const ms = m.guessFixedMs + (m.guessMsPerKRow * rows) / 1000;
  return `≈ ${durationLabel(ms)}${m.library === null ? "" : ` · ${m.library}`}`;
}
