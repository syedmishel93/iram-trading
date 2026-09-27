/**
 * The Decision desk — the one screen that reads everything.
 *
 * WHAT MAKES THIS DIFFERENT FROM A DASHBOARD
 * A dashboard shows you nine panels and leaves the combining to you. This shows
 * the combination FIRST and the nine inputs underneath it, each with its
 * weight, its sentence and its provenance, so the headline can always be walked
 * back to the things that produced it. If you cannot audit a summary it is not
 * a summary, it is an assertion.
 *
 * THE HEADLINE LEADS WITH COVERAGE, NOT DIRECTION
 * A read assembled from three of ten sources is not a weak LONG. It is an
 * unsupported one, and the difference is the difference between sizing down and
 * not taking the trade. `decide()` writes the sentence; this file renders it
 * without decoration that would undercut it — in particular the score bar is
 * drawn in the NEUTRAL colour whenever confidence is zero, so a strong-looking
 * number cannot borrow authority the read has not earned.
 *
 * WHAT DID NOT ANSWER IS SHOWN AS PROMINENTLY AS WHAT DID
 * The missing panel is not an error list. `absent` means the source does not
 * cover this instrument, which is a permanent fact about what you are looking
 * at. `failed` means it should have answered and did not, which is something
 * you can go and fix. Those are rendered differently because the response to
 * them is different.
 */

import { h, clear } from "./dom";
import { renderEffect, type ReadSignal } from "../core/signal";
import { byGroup, leanLabel, type Evidence, type EvidenceGroup } from "../core/evidence";
import type { Decision } from "../core/decision";

const GROUP_LABEL: Record<EvidenceGroup, string> = {
  structure: "Structure",
  trend: "Trend",
  flow: "Positioning",
  fundamental: "Fundamentals",
  onchain: "On-chain",
  venue: "Venue",
  correlation: "Correlation",
  model: "Models",
  macro: "Macro",
};

export interface DecisionDeskOptions {
  readonly decision: ReadSignal<Decision>;
  readonly busy: ReadSignal<boolean>;
  refresh(): void;
  /** Opens the desk that owns a given evidence group, for a "show me" link. */
  onOpenSource(group: EvidenceGroup): void;
  /** The forecast panel's content, or null when there is not enough history. */
  forecast(): { line: string; buckets: readonly { nominal: number; realised: number; n: number }[]; error: number; usable: boolean } | null;
  /** Rolling correlation against the macro lane, and the sentence about it. */
  macro(): { line: string; rows: readonly { label: string; r: number; overlap: number; changePct: number; meaningful: boolean }[] };
  /** Load the macro lane. Costs four requests, so it is asked for, not assumed. */
  loadMacro(): void;
  readonly macroBusy: ReadSignal<boolean>;
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

function evidenceRow(e: Evidence, onOpen: (g: EvidenceGroup) => void): HTMLElement {
  const contributing = e.state === "fresh" || e.state === "stale";

  return h(
    "div",
    { class: "dc-ev", "data-state": e.state, "data-lean": e.lean === null ? "none" : e.lean > 0 ? "long" : e.lean < 0 ? "short" : "flat" },
    h(
      "div",
      { class: "dc-ev-head" },
      h("span", { class: "dc-ev-label", text: e.label }),
      h("span", { class: "dc-ev-lean", text: contributing ? leanLabel(e.lean) : e.state }),
      h("span", { class: "dc-ev-spacer" }),
      /* The weight bar. Shown for every row including absent ones, because the
         size of what is missing is part of reading the coverage figure. */
      h(
        "span",
        { class: "dc-ev-weight", title: `weight ${e.weight.toFixed(2)}` },
        h("span", { class: "dc-ev-weight-fill", style: `width:${Math.round(e.weight * 100)}%` }),
      ),
    ),
    h("div", { class: "dc-ev-reason", text: e.reason }),
    h(
      "div",
      { class: "dc-ev-foot" },
      h("span", { class: "dc-ev-source", text: e.source }),
      e.flip ? h("span", { class: "dc-ev-flip", text: `flips on: ${e.flip}` }) : null,
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Show me",
        onclick: () => onOpen(e.group),
      }),
    ),
  );
}

export function createDecisionDesk(opts: DecisionDeskOptions): { el: HTMLElement } {
  const body = h("div", { class: "dc-body" });

  renderEffect(() => {
    const d = opts.decision();
    clear(body);

    /* Sources that were ASKED and did not answer. `unavailable` means this
       build cannot ask the question at all, so it was never a gap — the same
       exclusion `synthesise` makes when it computes coverage, and the same one
       the setup card makes when it prints this count. */
    const gaps = d.missing.filter((m) => m.state !== "unavailable");

    /* --- the headline ------------------------------------------------- */

    body.appendChild(
      h(
        "section",
        { class: "dc-headline", "data-bias": d.confidence === 0 ? "none" : d.bias },
        h(
          "div",
          { class: "dc-headline-top" },
          h("span", { class: "dc-sym", text: `${d.symbol} · ${d.timeframe}` }),
          h("span", { class: "dc-spacer" }),
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            text: () => (opts.busy() ? "Reading…" : "Re-read"),
            disabled: () => opts.busy(),
            onclick: () => opts.refresh(),
          }),
        ),
        h("div", { class: "dc-verdict", text: d.headline }),

        /* The score bar. Drawn NEUTRAL whenever confidence is zero, so an
           unsupported read cannot look like a strong one. */
        h(
          "div",
          { class: "dc-bar", "data-live": String(d.confidence > 0) },
          h("span", { class: "dc-bar-mid" }),
          h("span", {
            class: "dc-bar-fill",
            "data-side": d.score >= 0 ? "long" : "short",
            style: `width:${Math.min(50, Math.abs(d.score) * 50)}%;${d.score >= 0 ? "left:50%" : `left:${50 - Math.min(50, Math.abs(d.score) * 50)}%`}`,
          }),
        ),

        h(
          "div",
          { class: "dc-stats" },
          /**
           * The caption says COUNT; the figure above it is WEIGHT.
           *
           * They are different numbers and were both presented as "coverage":
           * on XAUUSD 1h the panel read "70%" over "8 of 13 answered", which
           * is 62%. A reader can only conclude that one of them is wrong.
           *
           * Neither is. `synthesise` measures coverage as answered weight over
           * expected weight, because a missing regime model and a missing
           * on-chain read are not worth the same, and the denominator also
           * excludes sources this build cannot ask at all. The caption now
           * says which quantity it is, so the two numbers stop looking like
           * one number reported twice.
           */
          stat(
            "Coverage",
            pct(d.coverage),
            /* `unavailable` OUT of the denominator, matching `synthesise` and
               matching the setup card, which already made this exclusion with
               a comment saying the card "would contradict the coverage figure
               it just printed" otherwise. This panel did not, so the two read
               "8 of 13 sources" and "8 of 12 sources" about the same moment —
               and the limits line named only the six absent ones, leaving a
               reader to hunt for a seventh that was never missing. */
            `${d.evidence.length} of ${d.evidence.length + gaps.length} sources · % is weighted`,
          ),
          stat("Agreement", pct(d.agreement), "of directional weight"),
          stat("Confidence", pct(d.confidence), "agreement × coverage"),
        ),
      ),
    );

    /* --- limits ------------------------------------------------------- */

    if (d.limits.length > 0) {
      body.appendChild(
        h(
          "section",
          { class: "dc-panel" },
          h("h3", { class: "label", text: "What limits this read" }),
          ...d.limits.map((l) => h("div", { class: "dc-limit", text: l })),
        ),
      );
    }

    /* --- what would change it ------------------------------------------ */

    if (d.wouldChange.length > 0) {
      body.appendChild(
        h(
          "section",
          { class: "dc-panel" },
          h("h3", { class: "label", text: "What would change it" }),
          ...d.wouldChange.map((w) => h("div", { class: "dc-flip", text: w })),
        ),
      );
    }

    /* --- the evidence, grouped ----------------------------------------- */

    const groups = byGroup(d.evidence);
    if (groups.size > 0) {
      const section = h("section", { class: "dc-panel" }, h("h3", { class: "label", text: "The evidence" }));
      for (const [group, list] of groups) {
        section.appendChild(h("div", { class: "dc-group", text: GROUP_LABEL[group] }));
        for (const e of list) section.appendChild(evidenceRow(e, opts.onOpenSource));
      }
      body.appendChild(section);
    }

    /* --- what did not answer -------------------------------------------- */

    if (d.missing.length > 0) {
      const failed = d.missing.filter((e) => e.state === "failed");
      const absent = d.missing.filter((e) => e.state === "absent");
      const section = h(
        "section",
        { class: "dc-panel" },
        h("h3", { class: "label", text: "What did not answer" }),
      );

      if (failed.length > 0) {
        section.appendChild(
          h("p", {
            class: "dc-sub",
            text: "These should have answered and did not. That is fixable, and until it is the read is thinner than it looks.",
          }),
        );
        for (const e of failed) section.appendChild(evidenceRow(e, opts.onOpenSource));
      }
      if (absent.length > 0) {
        section.appendChild(
          h("p", {
            class: "dc-sub",
            text: "These do not cover this instrument. Their absence is a property of what you are looking at, not a neutral vote.",
          }),
        );
        for (const e of absent) section.appendChild(evidenceRow(e, opts.onOpenSource));
      }
      body.appendChild(section);
    }

    /* --- the standing warning -------------------------------------------- */

    body.appendChild(
      h("div", {
        class: "dc-standing",
        text:
          "This is decision support and it is not a signal. A number assembled from more inputs looks more authoritative and is not — the strategy lab measured a probability of backtest overfitting of 89% on the confluence score alone, and that applies here with more force, not less. Nothing on this desk can place a trade.",
      }),
    );
  });

  function stat(label: string, value: string, sub: string): HTMLElement {
    return h(
      "div",
      { class: "dc-stat" },
      h("div", { class: "dc-stat-label", text: label }),
      h("div", { class: "dc-stat-value num", text: value }),
      h("div", { class: "dc-stat-sub", text: sub }),
    );
  }

  /**
   * The range forecast, and its own report card.
   *
   * There is deliberately no direction here. One bar ahead is where the
   * signal-to-noise ratio is worst, and a terminal printing "next candle: UP
   * 71%" is converting its own noise into your position size. Volatility, by
   * contrast, genuinely clusters — so the range is forecastable and the
   * direction is not, and the panel says exactly that.
   *
   * The calibration row is the part no retail platform ships: it replays every
   * forecast the model would have made and reports how often the interval
   * actually contained the outcome. An 80% interval that catches 63% is a
   * broken model, and this is the only way anyone finds out.
   */
  const forecastCard = h(
    "section",
    { class: "dc-panel" },
    h(
      "header",
      { class: "dc-panel-head" },
      h("h2", { class: "dc-panel-title", text: "Next bar — range, not direction" }),
    ),
    h("div", { class: "dc-panel-body" }, () => {
      const f = opts.forecast();
      if (f === null) {
        return h("p", {
          class: "dc-note",
          text: "Not enough history to forecast a range. Nothing is being claimed.",
        });
      }
      return h(
        "div",
        {},
        h("p", { class: "dc-forecast-line", text: f.line }),
        h(
          "div",
          { class: "dc-calib" },
          h("span", { class: "dc-stat-label", text: "Calibration — what the intervals actually delivered" }),
          ...f.buckets.map((b) =>
            h(
              "div",
              { class: "dc-calib-row", "data-ok": String(Math.abs(b.realised - b.nominal) <= 0.05) },
              h("span", { class: "dc-calib-nom num", text: `${(b.nominal * 100).toFixed(0)}% claimed` }),
              h("span", { class: "dc-calib-bar", ref: (el2: HTMLElement) => {
                const fill = h("span", { class: "dc-calib-fill" }) as HTMLElement;
                fill.style.width = `${Math.min(100, b.realised * 100)}%`;
                el2.appendChild(fill);
              } }),
              h("span", { class: "dc-calib-real num", text: `${(b.realised * 100).toFixed(0)}% delivered` }),
              h("span", { class: "dc-calib-n num", text: `n=${b.n}` }),
            ),
          ),
        ),
      );
    }),
  );

  /**
   * The macro lane.
   *
   * Loaded on request rather than automatically: it costs four extra series,
   * and a panel that silently quadruples the terminal's request budget on
   * every symbol change is a panel that eventually earns a rate-limit ban on
   * somebody else's behalf.
   *
   * Nothing here is hard-coded. There is no table of expected relationships —
   * every figure is the currently measured coefficient with its sample size,
   * and it falls silent when the measurement is weak. BTC's correlation to the
   * dollar has been strongly negative, near zero and positive within the same
   * year, and a panel that encoded one of those would be confidently wrong for
   * a quarter at a time.
   */
  const macroCard = h(
    "section",
    { class: "dc-panel" },
    h(
      "header",
      { class: "dc-panel-head" },
      h("h2", { class: "dc-panel-title", text: "Across markets" }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        disabled: () => opts.macroBusy(),
        text: () => (opts.macroBusy() ? "Loading…" : "Load macro lane"),
        title: "Fetches the dollar index, gold, US 10-year yields and the S&P, and measures this instrument against each.",
        onclick: () => opts.loadMacro(),
      }),
    ),
    h("div", { class: "dc-panel-body" }, () => {
      const m = opts.macro();
      return h(
        "div",
        {},
        ...m.rows.map((row) =>
          h(
            "div",
            { class: "dc-macro-row", "data-meaningful": String(row.meaningful) },
            h("span", { class: "dc-macro-label", text: row.label }),
            h("span", {
              class: "dc-macro-move num",
              text: `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(1)}%`,
            }),
            h("span", {
              class: "dc-macro-r num",
              text: Number.isFinite(row.r) ? `${row.r >= 0 ? "+" : ""}${row.r.toFixed(2)}` : "—",
            }),
            h("span", { class: "dc-macro-n num", text: `${row.overlap} bars` }),
          ),
        ),
        h("p", { class: "dc-note", text: m.line }),
      );
    }),
  );

  const el = h(
    "div",
    { class: "dd dc" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Decision" }),
      h("p", {
        class: "view-sub",
        text: "Every source the terminal has, in one shape, with what each one contributes and what it would take to change it. The summary is always walkable back to its inputs.",
      }),
    ),
    body,
    forecastCard,
    macroCard,
  );

  return { el };
}
