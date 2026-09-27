/**
 * The Research workspace's study desk: the steered flow first, the full
 * four-step stepper one click behind it, and the data library beside both.
 *
 * WHY THE STEERED FLOW IS THE FRONT DOOR (v59.2)
 * The approved v5 design splits the work by who does it: you pick the asset,
 * the question and how strict to be; the AI picks the related assets and the
 * checks and explains the result. That is the SAME study the stepper edits —
 * one `StudyState`, one `StudySpec`, one `run()` — so the two views cannot
 * disagree; `ui/research/steered.ts` says why in full.
 *
 * WHY A STEPPER AND NOT FOUR TABS, for the full view
 * Because the steps depend on each other and a tab strip says they do not. The
 * methods available depend on the columns and the row count chosen in step
 * one; the report depends on what was selected in step two; the arming gate in
 * step three depends on the report. A rail that shows how far along the study
 * is — and lets you go back, because going back is normal — is the shape of
 * the work. Every step stays reachable; nothing is gated behind a wizard.
 *
 * THE DATA LIBRARY TAB
 * Shows the Data desk itself when the shell passes it (`deps.library`), so
 * there is one library with one set of controls, not a second copy. When it is
 * not passed, the tab opens the Data desk instead of rendering an imitation.
 */

import { h } from "../dom";
import { renderEffect, signal } from "../../core/signal";
import type { ShellContext } from "../shell/context";
import { blocking } from "../../study/spec";
import { durationLabel } from "../../study/plan";
import { createStudyState, STEPS, type StudyDeskDeps, type StepId } from "./state";
import { createSubjectStep } from "./subject";
import { createMethodStep } from "./methodstep";
import { createAutomateStep } from "./automate";
import { createReportStep } from "./reportview";
import { createSteeredStudy } from "../research/steered";
import { whoTag } from "../today/card";

export interface StudyDeskHandle {
  readonly el: HTMLElement;
}

type Tab = "study" | "data";
type Mode = "guided" | "full";

export function createStudyDesk(ctx: ShellContext, deps: StudyDeskDeps): StudyDeskHandle {
  const state = createStudyState(ctx, deps);
  const tab = signal<Tab>("study");
  const mode = signal<Mode>("guided");

  const openFull = (step: StepId): void => {
    state.step.set(step);
    mode.set("full");
  };

  /* Every step is built once and shown or hidden, not rebuilt on each switch.
     Going back to Subject after reading the report must show the table exactly
     as it was left, scroll position included — rebuilding it would reset both
     and make "go back and change one series" feel like starting over. */
  const panes: Record<StepId, HTMLElement> = {
    subject: createSubjectStep(state),
    method: createMethodStep(state),
    automate: createAutomateStep(state),
    report: createReportStep(state),
  };

  const steered = createSteeredStudy(state, { chartSymbol: deps.symbol, openFull });

  const rail = h(
    "nav",
    { class: "sy-rail", "aria-label": "Study steps" },
    ...STEPS.map((s, i) =>
      h(
        "button",
        {
          class: () => `sy-rail-btn${state.step() === s.id ? " is-on" : ""}`,
          type: "button",
          "aria-current": () => (state.step() === s.id ? "step" : "false"),
          title: s.blurb,
          onclick: () => state.step.set(s.id),
        },
        h("span", { class: "sy-rail-n", text: String(i + 1) }),
        h("span", { class: "sy-rail-t", text: s.label }),
      ),
    ),
  );

  const nameInput = h("input", {
    class: "sy-name",
    type: "text",
    "aria-label": "Study name",
    value: () => state.spec().name,
    onchange: (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v !== "") state.patch({ name: v });
    },
  });

  const savedMenu = h(
    "select",
    {
      class: "sy-select sy-saved",
      "aria-label": "Open a saved study",
      onchange: (e) => {
        const el = e.target as HTMLSelectElement;
        if (el.value !== "") state.open(el.value);
        el.value = "";
      },
    },
  );
  renderEffect(() => {
    const recs = state.saved();
    savedMenu.replaceChildren(
      h("option", { value: "", text: recs.length === 0 ? "No saved studies" : `Saved (${recs.length})` }),
      ...recs.map((r) =>
        h("option", {
          value: r.spec.id,
          text: `${r.spec.name}${r.runs.length > 0 ? ` · ${r.runs.length} run${r.runs.length === 1 ? "" : "s"}` : ""}`,
        }),
      ),
    );
  });

  const runBtn = h("button", {
    class: "sy-run-btn",
    type: "button",
    text: () => {
      if (state.busy()) return state.progress() || "running…";
      const plan = state.plan();
      return plan.steps.length === 0 ? "Nothing to run" : `Run ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`;
    },
    title: () => {
      const plan = state.plan();
      if (plan.steps.length === 0) return plan.refusal ?? "";
      return `${plan.hypotheses.toLocaleString()} hypotheses, about ${durationLabel(plan.estimateMs)}. The holdout is not touched.`;
    },
    disabled: () => (state.busy() || state.plan().steps.length === 0 || blocking(state.problems()).length > 0 ? "" : undefined),
    onclick: () => void state.run(),
  });

  const body = h("div", { class: "sy-body" });
  renderEffect(() => {
    const id = state.step();
    body.replaceChildren(panes[id]);
  });

  /* A blocking problem stops the run, and the reason belongs beside the button
     that is refusing rather than on the step where the mistake was made — the
     operator is looking at the button. */
  const blockNote = h("div", { class: "sy-blocknote" });
  renderEffect(() => {
    const bad = blocking(state.problems());
    blockNote.replaceChildren(...(bad[0] === undefined ? [] : [h("span", { text: bad[0].text })]));
  });

  const full = h(
    "div",
    { class: "sy" },
    h(
      "header",
      { class: "sy-head" },
      nameInput,
      rail,
      h(
        "div",
        { class: "sy-head-acts" },
        runBtn,
      ),
    ),
    blockNote,
    body,
  );

  /* ── the data library tab ─────────────────────────────────────────── */

  const library = deps.library;
  const libraryHost = h("div", { class: "rs-library" });
  const libraryFallback = h(
    "section",
    { class: "dd-panel rs-card rs-library-open" },
    h("p", { class: "rs-note", text: "The data library is the Data desk: every stored series, what the system has learned, and how the AI may use it." }),
    h("button", { class: "sy-ghost", type: "button", text: "Open the data library", onclick: () => ctx.state.view.set("data") }),
  );

  const content = h("div", { class: "rs-body" });
  renderEffect(() => {
    if (tab() === "data") {
      if (library === undefined) {
        content.replaceChildren(libraryFallback);
        return;
      }
      /* The Data view mounts the same element; re-attaching it here moves it,
         which is correct because only one view is on screen at a time. */
      libraryHost.replaceChildren(library.el);
      library.activate();
      content.replaceChildren(libraryHost);
      return;
    }
    content.replaceChildren(mode() === "full" ? full : steered);
  });

  const tabBtn = (id: Tab, text: string): HTMLElement =>
    h("button", {
      class: "seg-btn",
      type: "button",
      text,
      "aria-pressed": () => (tab() === id ? "true" : "false"),
      onclick: () => tab.set(id),
    }) as HTMLElement;

  return {
    el: h(
      "div",
      { class: "rs" },
      h(
        "header",
        { class: "rs-head" },
        h(
          "div",
          { class: "rs-intro" },
          whoTag("both", "You steer · AI assists"),
          h("h1", { class: "rs-title", text: "Pick what to study. The AI finds what moves with it." }),
          h("p", {
            class: "rs-sub",
            text: "Quant analysis and machine learning. You choose the asset and the question; the AI chooses related assets and inputs, and says why for each. Anything it adds, you can switch off.",
          }),
        ),
        h(
          "div",
          { class: "rs-bar" },
          h("div", { class: "seg", role: "group", "aria-label": "Research view" }, tabBtn("study", "Study"), tabBtn("data", "Data library")),
          h(
            "div",
            { class: "rs-bar-acts", hidden: () => (tab() === "study" ? undefined : "") },
            savedMenu,
            h("button", { class: "sy-ghost", type: "button", text: "New", title: "Start a fresh study from the chart's symbol", onclick: () => state.fresh() }),
            h("button", { class: "sy-ghost", type: "button", text: "Save", title: "Keep this study, so its runs accumulate a history", onclick: () => state.save() }),
            h("button", {
              class: "sy-ghost",
              type: "button",
              text: () => (mode() === "full" ? "Guided view" : "Every setting"),
              title: "The same study, with every role, window and method shown",
              onclick: () => mode.set(mode.peek() === "full" ? "guided" : "full"),
            }),
          ),
        ),
      ),
      content,
    ),
  };
}
