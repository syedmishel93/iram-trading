/**
 * "AI read of the chart" — the five steps of `scan/chartread.ts`, numbered,
 * one line each. The number carries the step's standing (supports the read,
 * a caution, or could not check); the words carry the measurement.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import { chartRead, type ChartReadInput } from "../../scan/chartread";

export interface ReadCardDeps {
  /** Everything the read needs, recomputed when any input changes. */
  readonly input: () => ChartReadInput;
}

export function createReadCard(deps: ReadCardDeps): HTMLElement {
  const list = h("ol", { class: "rd-steps" }) as HTMLOListElement;
  renderEffect(() => {
    const steps = chartRead(deps.input());
    list.replaceChildren(
      ...steps.map((s, i) =>
        h(
          "li",
          { class: "rd-step", "data-tone": s.tone },
          h("span", { class: "rd-n", "aria-hidden": "true", text: String(i + 1) }),
          h("span", { class: "rd-text" }, h("b", { text: `${s.title}: ` }), h("span", { text: s.text })),
        ),
      ),
    );
  });
  return h(
    "div",
    { class: "rd-card" },
    list,
    h("p", { class: "rd-foot", text: "Read from the bars, the averages and what the detectors marked — nothing here is a forecast." }),
  ) as HTMLElement;
}
