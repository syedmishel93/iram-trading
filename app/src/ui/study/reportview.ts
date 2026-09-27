/**
 * Step four: the finding.
 *
 * Three things are on this screen that a backtest report usually is not:
 *
 *   THE NOISE BAND IS DRAWN, not described. A cross-correlation chart without
 *   one has a biggest bar on every dataset ever collected, and the eye reads
 *   the biggest bar as the answer.
 *
 *   THE RAW FIGURE AND THE CORRECTED ONE ARE BOTH SHOWN, the raw one struck
 *   through. Replacing it would invite the suspicion that something was being
 *   hidden; showing only the raw one is the thing this whole product exists to
 *   stop.
 *
 *   WHAT THIS DOES NOT ESTABLISH is derived from what happened in this run —
 *   which series had gaps, which steps refused, how much of the window was
 *   carried rather than observed. A fixed disclaimer is read once; a sentence
 *   about your own study gets read.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import { GROUP_LABEL } from "../../study/methods";
import { spanLabel } from "../../study/window";
import type { LagProfile, ResultRow } from "../../study/findings";
import type { StepResult, StudyReport } from "../../study/run";
import type { StudyState } from "./state";

const day = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—");
const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");

/**
 * Cross-correlation by lag, with the band drawn across it.
 *
 * Bars outside the band are toned; bars inside it are not. Colour follows the
 * STANDING — cleared the band or did not — and never the number, which is the
 * rule that stops the largest bar on a profile of pure noise being painted as
 * a finding.
 */
function lagChart(p: LagProfile): HTMLElement {
  const W = 560;
  const H = 150;
  const mid = H / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "sy-lag");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Cross-correlation of ${p.label} against the subject at every lag, with a 95% noise band of plus or minus ${r2(p.band)}.`,
  );

  const maxAbs = Math.max(p.band * 1.4, ...p.points.map((q) => Math.abs(q.r)));
  const scale = (r: number): number => (r / maxAbs) * (mid - 12);
  const x = (i: number): number => (i / Math.max(1, p.points.length - 1)) * (W - 8) + 4;

  const bandRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bandRect.setAttribute("x", "0");
  bandRect.setAttribute("y", String(mid - scale(p.band)));
  bandRect.setAttribute("width", String(W));
  bandRect.setAttribute("height", String(scale(p.band) * 2));
  bandRect.setAttribute("class", "sy-lag-band");
  svg.appendChild(bandRect);

  const zero = document.createElementNS("http://www.w3.org/2000/svg", "line");
  zero.setAttribute("x1", "0");
  zero.setAttribute("x2", String(W));
  zero.setAttribute("y1", String(mid));
  zero.setAttribute("y2", String(mid));
  zero.setAttribute("class", "sy-lag-zero");
  svg.appendChild(zero);

  p.points.forEach((q, i) => {
    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const hgt = Math.abs(scale(q.r));
    bar.setAttribute("x", String(x(i) - 1.4));
    bar.setAttribute("y", String(q.r >= 0 ? mid - hgt : mid));
    bar.setAttribute("width", "2.8");
    bar.setAttribute("height", String(Math.max(0.5, hgt)));
    bar.setAttribute(
      "class",
      Math.abs(q.r) > p.band ? "sy-lag-bar is-clear" : "sy-lag-bar",
    );
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = `lag ${q.lag}: ${q.r.toFixed(3)} on ${q.n.toLocaleString()} pairs`;
    bar.appendChild(t);
    svg.appendChild(bar);
  });

  return h(
    "figure",
    { class: "sy-lag-fig" },
    h(
      "figcaption",
      { class: "sy-lag-cap" },
      h("span", { class: "sy-lag-t", text: p.label }),
      h("span", { class: "sy-lag-b", text: `95% noise band ±${r2(p.band)}` }),
    ),
    svg,
    h(
      "div",
      { class: "sy-lag-axis" },
      h("span", { text: `${p.points[0]?.lag ?? 0} — the subject leads` }),
      h("span", { text: "0" }),
      h("span", { text: `+${p.points[p.points.length - 1]?.lag ?? 0} — ${p.label} leads` }),
    ),
  );
}

function resultRow(r: ResultRow): HTMLElement {
  return h(
    "div",
    { class: "sy-res", ...(r.tone !== undefined ? { "data-tone": r.tone } : {}) },
    h("span", { class: "sy-res-l", text: r.label }),
    h("span", { class: "sy-res-v", text: r.value }),
    ...(r.withheld !== undefined ? [h("span", { class: "sy-res-w", text: r.withheld })] : []),
    ...(r.note !== undefined ? [h("span", { class: "sy-res-n", text: r.note })] : []),
  );
}

function stepCard(s: StepResult): HTMLElement {
  const head = h(
    "div",
    { class: "sy-sc-head" },
    h("span", { class: "sy-sc-t", text: s.label }),
    h("span", { class: "sy-sc-g", text: GROUP_LABEL[s.group] }),
    h("span", { class: "sy-sc-n", text: s.tests === 1 ? "1 test" : `${s.tests.toLocaleString()} tests` }),
  );

  if (s.outcome.state !== "ok") {
    return h(
      "article",
      { class: "sy-sc", "data-state": s.outcome.state },
      head,
      h("p", { class: "sy-sc-refuse", text: s.outcome.reason }),
      h("p", {
        class: "sy-sc-kind",
        text:
          s.outcome.state === "refused"
            ? "It ran and declined. That question is open, not answered in the negative."
            : "It could not run. That is a missing answer, not a negative one.",
      }),
    );
  }

  const o = s.outcome;
  return h(
    "article",
    { class: "sy-sc", "data-state": "ok" },
    head,
    h("p", { class: "sy-sc-headline", text: o.headline }),
    h("div", { class: "sy-sc-rows" }, ...o.rows.map(resultRow)),
    ...o.profiles.map(lagChart),
    ...o.caveats.filter((c) => c.trim() !== "").map((c) => h("p", { class: "sy-sc-caveat", text: c })),
  );
}

function correctionPanel(rep: StudyReport): HTMLElement {
  const c = rep.correction;
  const kids: HTMLElement[] = [
    h("h4", { class: "sy-panel-h", text: "After correction" }),
    h("p", { class: "sy-corr-text", text: c.text }),
  ];

  if (c.sharpe !== null) {
    kids.push(
      h(
        "div",
        { class: "sy-deflate" },
        h("span", { class: "sy-deflate-l", text: "Best rule, Sharpe per trade" }),
        h("s", { class: "sy-deflate-raw", text: c.sharpe.observed.toFixed(2) }),
        h("span", { class: "sy-deflate-v", text: c.sharpe.deflated.toFixed(2) }),
      ),
      h("p", { class: "sy-corr-work", text: c.sharpe.working }),
      /* The basis travels with the figure. Two Sharpes on one screen in
         different units, with only one of them labelled, is how the annualised
         one gets read as the deflated one. */
      h("p", { class: "sy-corr-work", text: c.sharpeBasis }),
    );
  } else if (c.sharpeRefusal !== null) {
    kids.push(h("p", { class: "sy-corr-work", text: c.sharpeRefusal }));
  }
  if (c.pbo !== null) {
    kids.push(
      h(
        "div",
        { class: "sy-deflate" },
        h("span", { class: "sy-deflate-l", text: "Overfitting probability" }),
        h("span", { class: "sy-deflate-v", text: c.pbo.toFixed(2) }),
      ),
    );
  }
  if (c.claims.length > 0) {
    kids.push(
      h("div", { class: "sy-panel-h sy-panel-h2", text: "Every claim that carried a p-value" }),
      ...c.claims
        .slice()
        .sort((a, b) => a.q - b.q)
        .map((cl) =>
          h(
            "div",
            { class: "sy-claim", "data-survives": cl.survives ? "1" : "0" },
            h("span", { class: "sy-claim-l", text: cl.label }),
            h("span", { class: "sy-claim-p", text: `p ${cl.p.toFixed(3)}` }),
            h("span", { class: "sy-claim-q", text: `q ${cl.q.toFixed(3)}` }),
          ),
        ),
    );
  }

  kids.push(
    h(
      "div",
      { class: "sy-seal", "data-state": rep.holdout },
      h("span", { class: "sy-seal-t", text: rep.holdout === "sealed" ? "Holdout sealed" : "Holdout opened" }),
      h("span", {
        class: "sy-seal-b",
        text:
          rep.holdout === "sealed"
            ? `${rep.split.holdout.bars.toLocaleString()} bars at the end of the window that nothing in this run has touched. Opening it spends it — the second look is conditioned on the first.`
            : "Anything measured against this segment from here on is in-sample, including a re-run of this same study.",
      }),
    ),
  );

  return h("div", { class: "sy-panel sy-corr" }, ...kids);
}

export function createReportStep(state: StudyState): HTMLElement {
  const root = h("div", { class: "sy-step sy-report" });

  renderEffect(() => {
    const rep = state.report();
    const busy = state.busy();

    if (busy) {
      root.replaceChildren(
        h(
          "div",
          { class: "sy-running" },
          h("p", { class: "sy-running-t", text: "Running" }),
          h("p", { class: "sy-running-b", text: state.progress() || "starting…" }),
        ),
      );
      return;
    }

    if (rep === null) {
      root.replaceChildren(
        h(
          "div",
          { class: "sy-running" },
          h("p", { class: "sy-running-t", text: "Nothing has been run yet" }),
          h("p", {
            class: "sy-running-b",
            text: "Choose a subject, choose a method, and press Run. The report keeps every step's answer, including the ones that decline.",
          }),
        ),
      );
      return;
    }

    if (rep.refusal !== null) {
      root.replaceChildren(
        h(
          "div",
          { class: "sy-running" },
          h("p", { class: "sy-running-t", text: "This study could not be run" }),
          h("p", { class: "sy-running-b", text: rep.refusal }),
        ),
      );
      return;
    }

    root.replaceChildren(
      h(
        "div",
        { class: "sy-main" },
        h(
          "header",
          { class: "sy-headline" },
          h("h2", { class: "sy-headline-t", text: rep.headline }),
          h("p", {
            class: "sy-headline-b",
            text:
              `${rep.symbol} ${rep.timeframe} · ${rep.rows.toLocaleString()} aligned rows over ${spanLabel(rep.window.spanMs)} ` +
              `(${day(rep.window.from)} → ${day(rep.window.to)}) · ${rep.steps.length} steps, ${rep.hypotheses.toLocaleString()} hypotheses, ${(rep.ms / 1000).toFixed(1)}s`,
          }),
        ),
        ...(rep.window.shortfall === null ? [] : [h("div", { class: "sy-callout", text: rep.window.shortfall })]),
        ...rep.panelWarnings.map((w) => h("div", { class: "sy-callout", text: w })),
        h("div", { class: "sy-cards-out" }, ...rep.steps.map(stepCard)),
        h(
          "section",
          { class: "sy-limits" },
          h("h3", { class: "sy-limits-h", text: "What this does not establish" }),
          ...rep.limits.map((l) => h("p", { class: "sy-limit", text: l })),
        ),
      ),
      h("aside", { class: "sy-side" }, correctionPanel(rep)),
    );
  });

  return root;
}
