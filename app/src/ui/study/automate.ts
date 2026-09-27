/**
 * Step three: run it, and keep running it.
 *
 * The valuable half of this screen is on the right — the studies already
 * running, each with its headline number plotted against its own history. A
 * study whose finding has fallen from 0.72 to 0.51 over nine runs is the most
 * useful thing this product can tell anyone, and it is invisible in every
 * terminal that reports only the latest backtest.
 *
 * "Arm it as a live signal" is drawn locked with the reason `armable`
 * produced. It is not merely disabled: the gate is in the domain, so a
 * schedule that somehow carried the action would still be refused.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import {
  ACTIONS,
  CADENCES,
  armable,
  guardCheck,
  readDecay,
  type ActionId,
  type Cadence,
} from "../../study/schedule";
import { runsOnDay, strengthHistory, type StudyRecord } from "../../study/store";
import type { StudyState } from "./state";

const ago = (ms: number, now: number): string => {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

/**
 * A study's strength over its runs, as a sparkline.
 *
 * Drawn with a floor line, because the question the picture answers is not
 * "what shape is this" but "is it under the line yet".
 */
function sparkline(values: readonly number[], floor: number): HTMLElement {
  const wrap = h("span", { class: "sy-spark" });
  if (values.length < 2) return wrap;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 24");
  svg.setAttribute("preserveAspectRatio", "none");
  const lo = Math.min(floor, ...values);
  const hi = Math.max(floor, ...values);
  const span = hi - lo || 1;
  const y = (v: number): number => 22 - ((v - lo) / span) * 20;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${y(v).toFixed(2)}`).join(" ");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "0");
  line.setAttribute("x2", "100");
  line.setAttribute("y1", y(floor).toFixed(2));
  line.setAttribute("y2", y(floor).toFixed(2));
  line.setAttribute("class", "sy-spark-floor");
  svg.appendChild(line);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path.setAttribute("points", pts);
  path.setAttribute("class", "sy-spark-line");
  svg.appendChild(path);
  wrap.appendChild(svg);
  return wrap;
}

export function createAutomateStep(state: StudyState): HTMLElement {
  const cadenceRow = h("div", { class: "sy-cadences" });
  renderEffect(() => {
    const cur = state.schedule().cadence;
    cadenceRow.replaceChildren(
      ...CADENCES.map((c) =>
        h(
          "button",
          {
            class: `sy-cad${cur === c.id ? " is-on" : ""}`,
            type: "button",
            "aria-pressed": cur === c.id ? "true" : "false",
            onclick: () =>
              state.schedule.set({
                ...state.schedule.peek(),
                cadence: c.id as Cadence,
                enabled: c.id !== "once",
              }),
          },
          h("span", { class: "sy-cad-t", text: c.label }),
          h("span", { class: "sy-cad-b", text: c.blurb }),
        ),
      ),
    );
  });

  const actionRows = h("div", { class: "sy-actions" });
  renderEffect(() => {
    const sched = state.schedule();
    const arm = armable(state.report());
    actionRows.replaceChildren(
      ...ACTIONS.map((a) => {
        const on = sched.actions.includes(a.id);
        const locked = a.locked && !arm.allowed;
        return h(
          "div",
          { class: "sy-action", "data-locked": locked ? "1" : "0" },
          h(
            "label",
            { class: "sy-action-head" },
            h("input", {
              type: "checkbox",
              checked: on ? "" : undefined,
              disabled: locked ? "" : undefined,
              onchange: (e) => {
                const want = (e.target as HTMLInputElement).checked;
                const list = state.schedule.peek().actions;
                state.schedule.set({
                  ...state.schedule.peek(),
                  actions: want
                    ? [...list, a.id as ActionId]
                    : list.filter((x) => x !== a.id),
                });
              },
            }),
            h("span", { class: "sy-action-t", text: a.label }),
            ...(locked ? [h("span", { class: "sy-locked", text: "locked" })] : []),
          ),
          h("p", { class: "sy-action-b", text: a.blurb }),
          ...(locked && arm.reason !== null ? [h("p", { class: "sy-action-why", text: arm.reason })] : []),
        );
      }),
    );
  });

  const guardRow = h("div", { class: "sy-guards" });
  renderEffect(() => {
    const g = state.schedule().guards;
    const set = (over: Partial<typeof g>): void =>
      state.schedule.set({ ...state.schedule.peek(), guards: { ...g, ...over } });
    guardRow.replaceChildren(
      guard("Runs per day, at most", g.maxPerDay, 1, 1, (v) => set({ maxPerDay: v }),
        "A ceiling the cadence cannot exceed. Every run costs a fetch and some compute; an hourly study left on for a month is 720 of them."),
      guard("Stop after failures", g.stopAfterFailures, 1, 1, (v) => set({ stopAfterFailures: v }),
        "Consecutive runs that produced nothing. A dead vendor does not get better by being asked hourly."),
      guard("Decay floor", g.decayFloor, 0.05, 0, (v) => set({ decayFloor: v }),
        "In the units of whatever this study's strength measure is. The Library flags a study whose latest run falls below it."),
    );
  });

  /* ── right: what is already running ────────────────────────────────────── */

  const running = h("div", { class: "sy-panel" });
  renderEffect(() => {
    const recs = state.saved();
    const now = Date.now();
    const kids: HTMLElement[] = [h("h4", { class: "sy-panel-h", text: "Already running" })];
    if (recs.length === 0) {
      kids.push(
        h("p", {
          class: "sy-dim",
          text: "Nothing is saved yet. A study has to be saved before its runs are kept — a scratch question filling the Library is how a Library stops being read.",
        }),
      );
    } else {
      kids.push(...recs.map((r) => runningRow(r, now, state)));
    }
    running.replaceChildren(...kids);
  });

  return h(
    "div",
    { class: "sy-step sy-automate" },
    h(
      "div",
      { class: "sy-main" },
      h(
        "section",
        { class: "sy-sec" },
        h("h3", { class: "sy-sec-h", text: "When" }),
        h("p", { class: "sy-sec-b", text: "The same study, the same window length, run again — so the headline has a history rather than a latest value." }),
        cadenceRow,
        /* WHAT THE SCHEDULE ACTUALLY DOES, said where it is set. A control
           labelled Daily that silently does nothing while the tab is on
           another desk is worse than no control: it is a promise the product
           does not keep, and nobody finds out until a week of history is
           missing. */
        h("p", {
          class: "sy-sec-b sy-scope",
          text: "Scheduled studies re-run one at a time, from the moment this desk is first opened until the terminal is closed. They do not run while the terminal is shut — a background job that fetches years of history for every saved study is a decision about your machine that this desk does not make on its own.",
        }),
      ),
      h(
        "section",
        { class: "sy-sec" },
        h("h3", { class: "sy-sec-h", text: "And then what" }),
        h("p", { class: "sy-sec-b", text: "What happens to the answer once it exists." }),
        actionRows,
      ),
      h(
        "section",
        { class: "sy-sec" },
        h("h3", { class: "sy-sec-h", text: "Guards" }),
        h("p", { class: "sy-sec-b", text: "What stops it running forever, or running on data that stopped arriving." }),
        guardRow,
      ),
    ),
    h("aside", { class: "sy-side" }, running),
  );
}

function runningRow(r: StudyRecord, now: number, state: StudyState): HTMLElement {
  const hist = strengthHistory(r);
  const decay = readDecay(hist, r.schedule.guards.decayFloor);
  const guard = guardCheck(r.schedule, runsOnDay(r, now), r.failures);
  const last = r.runs[r.runs.length - 1];
  return h(
    "div",
    { class: "sy-run", "data-decaying": decay.decaying ? "1" : "0" },
    h(
      "div",
      { class: "sy-run-top" },
      h("button", {
        class: "sy-run-name",
        type: "button",
        text: r.spec.name,
        title: "Open this study",
        onclick: () => state.open(r.spec.id),
      }),
      h("span", {
        class: "sy-run-cad",
        text: r.schedule.enabled ? r.schedule.cadence : "off",
      }),
    ),
    ...(hist.length > 1 ? [sparkline(hist.map((p) => p.value), r.schedule.guards.decayFloor)] : []),
    h("p", {
      class: "sy-run-note",
      text: decay.refusal ?? decay.text,
    }),
    ...(last === undefined
      ? [h("p", { class: "sy-dim", text: "Never run." })]
      : [h("p", { class: "sy-run-last", text: `${r.runs.length} run${r.runs.length === 1 ? "" : "s"} · last ${ago(last.at, now)}` })]),
    ...(guard.allowed || guard.reason === null ? [] : [h("p", { class: "sy-run-guard", text: guard.reason })]),
  );
}

function guard(
  label: string,
  value: number,
  step: number,
  min: number,
  onSet: (v: number) => void,
  hint: string,
): HTMLElement {
  return h(
    "label",
    { class: "sy-guard", title: hint },
    h("span", { class: "sy-guard-l", text: label }),
    h("input", {
      class: "sy-num",
      type: "number",
      step: String(step),
      min: String(min),
      value: String(value),
      onchange: (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) onSet(v);
      },
    }),
  );
}
