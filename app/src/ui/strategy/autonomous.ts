/**
 * The Strategy desk's AUTONOMOUS mode: the terminal searches, and says what it
 * cost.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS AND IS NOT
 *
 * The search is built and tested already — `backtest/autorun.ts` builds the
 * field and keeps what survived, `backtest/search.ts` charges the result for
 * the size of the search, `backtest/labrunner.ts` decides where the studies
 * run. NOTHING here recomputes any of that. This is the surface: what will be
 * searched before it runs, what it is doing while it runs, and what came of it
 * — including, at the same size as a survivor, what came of it when nothing
 * survived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REFUSAL IS THE RESULT, NOT AN ERROR
 *
 * `beaten-by-noise` is the single most valuable thing this desk can tell an
 * operator: the best rule of the batch passed every check ON ITS OWN, and
 * still lost to what searching this hard turns up in noise. Rendered as a red
 * error it reads as "the terminal broke"; rendered as a finding it reads as
 * what it is. So a refusal gets the same card, the same weight and its `why` in
 * full — never truncated, never behind a disclosure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAVING IS AUTOMATIC AND SAYS SO
 *
 * `report.keep` goes to the shelf the moment the run ends, because a survivor
 * the operator has to remember to save is a survivor that is lost. Every row
 * lands `unproven` and the screen says both — that it saved, and that saved
 * does not mean trusted. Promotion is a separate, confirmed decision, in
 * `./shelf.ts`.
 */

import { computed, renderEffect, type ReadSignal } from "../../core/signal";
import { clear, h } from "../dom";
import { pkWhy } from "../panelkit";
import { buildField, type AutoRunDeps, type AutoRunReport } from "../../backtest/autorun";
import { createSweepDriver } from "../model/sweepdriver";
import type { SweepDriver } from "../model/sweepdriver";
import { countField, hurdleSentence } from "../../backtest/sweepplan";
import { SPECS_BY_ID } from "../../backtest/specs";
import { conditionText, type RuleSpec } from "../../backtest/rules";
import type { HybridSpec } from "../../backtest/hybrid";
import type { Scored } from "../../backtest/search";
import type { ShelfStore } from "../../backtest/shelfstore";
import type { BarView } from "../../chart/series";
import type { LoadedBars, LoadHooks } from "./load";
import { costsOf, whoTag, type FlowSettings } from "./flow";
import { createShelfSection } from "./shelf";

export interface AutonomousOptions {
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  /** The desk's ONE set of costs, risk and depth — the same the flow reads. */
  readonly settings: FlowSettings;
  readonly load: (hooks: LoadHooks) => Promise<LoadedBars>;
  /** Where survivors are saved. Absent: the run still reports, and says nothing was saved. */
  readonly shelf?: ShelfStore;
  /** Loads a spec into the Manual editor. */
  readonly onOpenInManual: (spec: RuleSpec) => void;
  readonly now?: () => number;
  readonly maxHybrids?: number;
  /**
   * Injectable for tests ONLY. Real callers get `createStudyRunner`, which
   * prefers the gateway's worker pool and falls back to this tab.
   */
  readonly makeRunner?: (bars: readonly BarView[], signal: AbortSignal) => AutoRunDeps["runStudies"];
  /**
   * THE SEARCH ITSELF, SHARED.
   *
   * The shell builds one `SweepDriver` and hands it to this desk AND to the
   * inspector's recommendation card, so a search started in either place is the
   * same run: one worker pool, one progress line, one set of survivors saved
   * once. Two drivers would charge the multiplicity hurdle twice for one field
   * and race each other into `shelf.addAll`.
   *
   * Optional because this desk predates the split and its own tests construct
   * it standalone; absent, it builds a private driver from the options above
   * and behaves exactly as it did.
   */
  readonly driver?: SweepDriver;
}

const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const sR = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** The library name behind an id, or the id — a hybrid names two of these. */
const specName = (id: string): string => SPECS_BY_ID.get(id)?.name ?? id;

export function createAutonomous(opts: AutonomousOptions) {
  const shelf = opts.shelf;

  /**
   * Rules the operator has retired on this instrument are left OUT of the
   * field, and the count on screen is the count after that — a retired rule
   * that still entered would be charged for and could win again.
   */
  const excludedFor = (sym: string, tf: string): string[] => {
    const rows = shelf?.rows() ?? [];
    return rows.filter((d) => d.status === "retired" && d.symbol === sym && d.timeframe === tf).map((d) => d.spec.id);
  };
  const excluded = (): string[] => excludedFor(opts.symbol(), opts.timeframe());

  const driver =
    opts.driver ??
    createSweepDriver({
      ...(shelf ? { shelf } : {}),
      load: (_symbol, _timeframe, hooks) => opts.load(hooks),
      costs: () => costsOf(opts.settings),
      riskPerTrade: () => opts.settings.riskPct.peek() / 100,
      excludedFor,
      ...(opts.maxHybrids === undefined ? {} : { maxHybrids: opts.maxHybrids }),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.makeRunner ? { makeRunner: opts.makeRunner } : {}),
    });

  const { running, progress, report, blocked, note, loaded, elapsed, cancelled, savedCount, nameById } = driver;

  /** A rule's name from its id: the field first, then the library, then the id. */
  const entrantName = (id: string): string => nameById().get(id) ?? SPECS_BY_ID.get(id)?.name ?? id;

  /**
   * A progress label the operator can read.
   *
   * The remote runner reports the GATEWAY's label (`bars/1h/spec:<id>`); the
   * in-tab runner reports the rule's name. Both arrive as `RunProgress.last`,
   * so the label is unwrapped here rather than two different sentences being
   * shown depending on where the studies happened to run.
   */
  const readable = (last: string): string => {
    const m = /(?:spec|family):([^/\s]+)\s*$/.exec(last);
    return m ? entrantName(m[1] ?? last) : last;
  };

  const field = computed(() => {
    const exclude = excluded();
    const built = buildField({
      ...(opts.maxHybrids === undefined ? {} : { maxHybrids: opts.maxHybrids }),
      ...(exclude.length === 0 ? {} : { exclude }),
    });
    return { ...built, count: countField(built.entrants), exclude };
  });

  // ------------------------------------------------------------------ run ---

  const run = (): Promise<void> => driver.run(opts.symbol.peek(), opts.timeframe.peek());
  const cancel = (): void => driver.cancel();

  // ------------------------------------------------------------ before it ---

  const planCard = h(
    "section",
    { class: "panel strat-card auto-card", "data-step": "plan" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "What will be searched" }),
      whoTag("ai", "AI", "The terminal builds and judges the field; you decide what happens to a survivor"),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", {
        class: "auto-arms",
        text: () => {
          const f = field();
          const parts = [`${f.count.library} library rules`];
          if (f.count.hybrids > 0) parts.push(`${f.count.hybrids} hybrids`);
          if (f.count.conditioned > 0) parts.push(`${f.count.conditioned} conditioned on the wider market`);
          if (f.count.other > 0) parts.push(`${f.count.other} other`);
          return `${parts.join(" + ")} = ${f.count.arms} to test. Every arm raises the bar the winner has to clear.`;
        },
      }),
      h("p", { class: "small", text: () => hurdleSentence(field().count.arms) }),
      h("p", {
        class: "muted small",
        "data-show": () => String(field().hybrids.rejected.length > 0 || field().hybrids.unbuilt > 0),
        text: () => {
          const f = field();
          const parts: string[] = [];
          if (f.hybrids.rejected.length > 0) parts.push(`${f.hybrids.rejected.length} pairs were considered and not built`);
          if (f.hybrids.unbuilt > 0) parts.push(`${f.hybrids.unbuilt} more were never reached at the cap`);
          return `${parts.join("; ")}. The reasons are listed with the result.`;
        },
      }),
      h("p", {
        class: "muted small",
        "data-show": () => String(field().exclude.length > 0),
        text: () => `${field().exclude.length} rules you retired on this market are left out.`,
      }),
      h("p", {
        class: "small",
        text: () => `${opts.symbol()} · ${opts.timeframe()} — up to ${opts.settings.depth()} bars from the local archive.`,
      }),
      h(
        "div",
        { class: "strat-actions" },
        h("button", {
          class: "primary-btn",
          type: "button",
          "data-act": "run",
          disabled: () => running(),
          text: () => (running() ? "Searching…" : "Run the search"),
          onclick: () => void run(),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          "data-act": "cancel",
          "data-show": () => String(running()),
          text: "Cancel",
          onclick: () => cancel(),
        }),
        h("span", { class: "muted small", "data-show": () => String(note() !== ""), text: () => note() }),
      ),
      h("p", {
        class: "auto-progress",
        "data-show": () => String(progress() !== null),
        text: () => {
          const p = progress();
          if (!p) return "";
          return `${p.done} of ${p.total} studied${p.last ? ` · just finished ${readable(p.last)}` : ""}.`;
        },
      }),
      pkWhy(
        "Every rule in the library, plus hybrids the terminal composes from them — one rule's entry taken only while " +
          "another's standing conditions hold. Each is studied the same way a single rule set is: a grid, five " +
          "walk-forward folds and an overfitting probability, at your costs. A survivor has to pass that gate AND " +
          "clear the score the best of this many tries would reach on no edge at all. Nothing is armed and no order " +
          "is placed — this terminal has no execution path.",
        "Why?",
      ),
    ),
  );

  // ------------------------------------------------------------- the result ---

  const hybridOf = (id: string): HybridSpec | null => report()?.hybrids.hybrids.find((x) => x.spec.id === id) ?? null;

  const survivorRow = (s: Scored): HTMLElement => {
    const hy = s.origin === "hybrid" ? hybridOf(s.id) : null;
    return h(
      "div",
      { class: "auto-row", "data-origin": s.origin, "data-id": s.id },
      h(
        "div",
        { class: "auto-row-head" },
        h("span", { class: "auto-name", text: s.name }),
        h("span", { class: "auto-origin", "data-origin": s.origin, text: s.origin === "hybrid" ? "Hybrid" : "Library" }),
      ),
      hy
        ? h(
            "p",
            { class: "auto-parents" },
            h("span", { text: `Built from ${specName(hy.trigger)} + ${specName(hy.filter)}: the entry, stop and target of ` }),
            h("span", { class: "auto-parent", text: specName(hy.trigger) }),
            h("span", { text: `, taken only while ${hy.added.map(conditionText).join(" and ")}.` }),
          )
        : null,
      h(
        "div",
        { class: "auto-figs" },
        h("span", { class: "auto-fig" }, h("span", { class: "auto-fig-k", text: "Unseen trades" }), h("span", { class: "auto-fig-v num", text: String(s.trades) })),
        h("span", { class: "auto-fig" }, h("span", { class: "auto-fig-k", text: "R a trade" }), h("span", { class: "auto-fig-v num", text: sR(s.expectancy) })),
        h("span", { class: "auto-fig" }, h("span", { class: "auto-fig-k", text: "Sharpe a trade" }), h("span", { class: "auto-fig-v num", text: r2(s.sharpe) })),
        h("span", { class: "auto-fig" }, h("span", { class: "auto-fig-k", text: "Left after the hurdle" }), h("span", { class: "auto-fig-v num", text: r2(s.deflated.deflated) })),
      ),
      h("p", {
        class: "muted small",
        text: `The hurdle was ${r2(s.deflated.hurdle)} of per-trade Sharpe over ${s.deflated.observations} out-of-sample trades. ${s.promotionSummary}`,
      }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "open-manual",
        text: "Open in Manual",
        onclick: () => {
          const spec = hy ? hy.spec : SPECS_BY_ID.get(s.id);
          if (spec) opts.onOpenInManual(spec);
        },
      }),
    );
  };

  const resultBody = h("div", { class: "auto-result" });
  renderEffect(() => {
    const r = report();
    const why = blocked();
    clear(resultBody);

    if (why !== "") {
      resultBody.appendChild(
        h(
          "div",
          { class: "auto-refusal", "data-kind": "no-history" },
          h("p", { class: "auto-refusal-head", text: "Not enough history to search this market" }),
          h("p", { class: "auto-refusal-why", text: why }),
        ),
      );
      return;
    }

    if (!r) {
      resultBody.appendChild(h("p", { class: "strat-empty", text: running() ? "Searching…" : "Not run yet." }));
      return;
    }

    resultBody.appendChild(h("p", { class: "auto-line", text: r.line }));
    resultBody.appendChild(
      h("p", {
        class: "muted small",
        text:
          `${r.entered} rules over ${(loaded()?.bars.length ?? 0).toLocaleString()} bars of ${r.symbol} ${r.timeframe}` +
          `${elapsed() > 0 ? `, ${secs(elapsed())}` : ""}. The hurdle was charged on ${r.search.trials.toLocaleString()} configurations.`,
      }),
    );
    if (cancelled()) {
      resultBody.appendChild(
        h("p", {
          class: "small strat-warn",
          text: "You cancelled this search. The rules that never ran are counted as arms, so this result is judged against the whole field you asked for.",
        }),
      );
    }
    if (r.search.survivors.length > 0) {
      const list = h("div", { class: "auto-rows" });
      for (const s of r.search.survivors) list.appendChild(survivorRow(s));
      resultBody.appendChild(list);
      const n = savedCount();
      resultBody.appendChild(
        h("p", {
          class: "auto-saved",
          text:
            shelf === undefined
              ? "Nothing was saved: this desk was opened without storage, so these results last until the page reloads."
              : `Saved ${n ?? 0} to the shelf below as UNPROVEN. Surviving a search is a better position than most ` +
                `published backtests and is still not evidence that it works here, next week. Promoting one — which ` +
                `lets it influence a recommendation — is your decision.`,
        }),
      );
    } else {
      const refusal = r.search.refusal;
      resultBody.appendChild(
        h(
          "div",
          { class: "auto-refusal", "data-kind": refusal?.kind ?? "none" },
          h("p", {
            class: "auto-refusal-head",
            text:
              refusal?.kind === "beaten-by-noise"
                ? "Nothing survived — and that is the finding"
                : refusal?.kind === "no-candidates"
                  ? "Nothing could be studied"
                  : "Nothing survived",
          }),
          h("p", { class: "auto-refusal-why", text: refusal?.why ?? r.line }),
          refusal?.kind === "beaten-by-noise"
            ? h("p", {
                class: "small",
                text: "This is a result about the search, not a fault in it. The best rule of the batch passed every check on its own; what it did not do is beat what looking this hard turns up in noise.",
              })
            : null,
        ),
      );
    }

    /* Everything refused, one disclosure. A search that shows only its winners
       is a search you cannot read. */
    const rejected = r.search.scored.filter((s) => s.rejected !== null);
    const details = h(
      "details",
      { class: "auto-refused" },
      h("summary", {
        text: `Everything that did not survive (${rejected.length} tested · ${r.hybrids.rejected.length} hybrids never built · ${r.failed.length} could not be studied)`,
      }),
    );
    if (rejected.length > 0) {
      details.appendChild(h("p", { class: "small strat-sub-head", text: "Tested and refused" }));
      for (const s of rejected) {
        details.appendChild(
          h(
            "div",
            { class: "auto-reject", "data-id": s.id },
            h("span", { class: "auto-reject-name", text: s.name }),
            h("span", { class: "auto-reject-why", text: s.rejected ?? "" }),
          ),
        );
      }
    }
    if (r.hybrids.rejected.length > 0) {
      details.appendChild(h("p", { class: "small strat-sub-head", text: "Hybrids that were never built" }));
      for (const x of r.hybrids.rejected) {
        details.appendChild(
          h(
            "div",
            { class: "auto-reject", "data-reason": x.reason },
            h("span", { class: "auto-reject-name", text: `${specName(x.trigger)} + ${specName(x.filter)}` }),
            h("span", { class: "auto-reject-why", text: x.why }),
          ),
        );
      }
    }
    if (r.failed.length > 0) {
      details.appendChild(h("p", { class: "small strat-sub-head", text: "Could not be studied" }));
      for (const f of r.failed) {
        details.appendChild(
          h(
            "div",
            { class: "auto-reject", "data-id": f.id },
            h("span", { class: "auto-reject-name", text: entrantName(f.id) }),
            h("span", { class: "auto-reject-why", text: f.why }),
          ),
        );
      }
    }
    resultBody.appendChild(details);
  });

  const resultCard = h(
    "section",
    { class: "panel strat-card auto-card", "data-step": "result" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "What survived" }),
      whoTag("ai", "AI"),
    ),
    h("div", { class: "panel-body" }, resultBody),
  );

  const shelfSection = createShelfSection({
    ...(shelf ? { shelf } : {}),
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    onOpenInManual: opts.onOpenInManual,
  });

  const el = h(
    "div",
    { class: "strat-auto-page" },
    h(
      "header",
      { class: "strat-head" },
      whoTag("ai", "AI-led"),
      h("h2", { class: "strat-title", text: "The terminal searches every rule it has, and tells you what the search cost." }),
    ),
    h("div", { class: "strat-stack" }, planCard, resultCard, shelfSection.el),
  );

  return {
    el,
    /** For tests and for the shell's commands. */
    run,
    cancel,
    report: report as ReadSignal<AutoRunReport | null>,
    running: running as ReadSignal<boolean>,
    blocked: blocked as ReadSignal<string>,
  };
}
