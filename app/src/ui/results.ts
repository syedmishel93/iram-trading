/**
 * RESULTS — what has been tested, on what, and what survived.
 *
 * CLASSES ARE `.res-`, NOT `.rs-`. `scratchpad/classcollide.py` refused the
 * obvious prefix before a line of CSS was written: `study.css` already owns
 * `.rs-head`, `.rs-title`, `.rs-sub` and `.rs-bar`, and it imports later — so
 * this desk would have rendered in the Study desk's clothes, which is a defect
 * this project has already shipped twice and found only by reading pixels.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS DESK EXISTS
 *
 * Everything on it was already being computed and stored. The shelf was on the
 * Strategy desk, listed by recency and filtered to the market on the chart; the
 * sweep log had a writer and no reader at all. So the two questions an operator
 * actually has — "which of my markets has anything that works" and "what have I
 * already tried and ruled out" — could not be asked anywhere.
 *
 * A DESK, NOT A PANEL, because the subject is the whole book of work rather
 * than the chart in front of you. Every other strategy surface here is scoped
 * to one market by design; this one is the opposite of that and folding it into
 * a scoped desk would have made it lie about its own scope.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT LEADS WITH THE DENOMINATOR
 *
 * "Two rules found" is an advert. "Two of nineteen subjects, out of 41,000
 * configurations charged for" is the same fact with the search it came out of
 * attached, and only the second can be read. `scoreboard.ts` joins the shelf to
 * the sweep log so the markets that answered NO appear beside the ones that did
 * not — without them the board is survivorship bias with a table around it.
 */

import { h, clear } from "./dom";
import { pkWhy } from "./panelkit";
import { computed, renderEffect, signal, type ReadSignal } from "../core/signal";
import {
  modelBoard,
  scoreboard,
  scoreTotals,
  type AssetScore,
  type ModelScore,
} from "../backtest/scoreboard";
import type { AutoResult } from "../data/autorun";
import type { Discovered } from "../backtest/discovered";
import type { SweepSummary } from "../backtest/sweepcache";

export interface ResultsOptions {
  /** Everything the terminal has kept. */
  readonly shelf: ReadSignal<readonly Discovered[]>;
  /** Every search it has run. */
  readonly sweeps: ReadSignal<readonly SweepSummary[]>;
  /** Open a market on the chart, so a row is a route rather than a readout. */
  readonly onOpen?: (symbol: string, timeframe: string) => void;
  /**
   * The autonomous loop's per-market findings, which carry the router report.
   *
   * INJECTED SO A TEST CAN PASS A STUB. A live default here would reach the
   * gateway from any test that constructed this desk — the defect this project
   * has now recorded arriving through three separate doors.
   */
  readonly loadAuto?: () => Promise<{ readonly results: readonly AutoResult[] } | null>;
}

/** Verdict → the words the operator reads. Never the internal token. */
const VERDICT_TEXT: Readonly<Record<AssetScore["verdict"], string>> = {
  working: "Beat its search",
  unproven: "Not proven",
  nothing: "Nothing found",
  "not searched": "Not searched",
};

const ago = (t: number): string => {
  if (!Number.isFinite(t) || t <= 0) return "—";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

export function createResults(opts: ResultsOptions): { el: HTMLElement } {
  /** `all` shows every subject; the filters narrow to one verdict. */
  const filter = signal<"all" | AssetScore["verdict"]>("all");

  const rows = computed(() => scoreboard(opts.shelf(), opts.sweeps()));
  const totals = computed(() => scoreTotals(rows()));
  const shown = computed(() => {
    const f = filter();
    return f === "all" ? rows() : rows().filter((r) => r.verdict === f);
  });

  /** One chip per verdict, each carrying its own count. */
  const chip = (
    id: "all" | AssetScore["verdict"],
    label: string,
    count: () => number,
  ): HTMLElement =>
    h("button", {
      class: "res-chip",
      type: "button",
      "data-on": () => String(filter() === id),
      /* THE COUNT IS ON THE CONTROL. A filter that does not say how much it
         would leave is one you press to find out, and pressing it is the only
         way to discover it selects nothing. */
      text: () => `${label} ${count()}`,
      disabled: () => count() === 0 && id !== "all",
      onclick: () => filter.set(id),
    });

  const boardRow = (r: AssetScore): HTMLElement =>
    h(
      "div",
      { class: "res-row", "data-verdict": r.verdict },
      h(
        "div",
        { class: "res-row-head" },
        h(
          "button",
          {
            class: "res-subject",
            type: "button",
            disabled: opts.onOpen === undefined,
            title: opts.onOpen ? `Open ${r.symbol} ${r.timeframe} on the chart` : "",
            onclick: () => opts.onOpen?.(r.symbol, r.timeframe),
          },
          h("span", { class: "res-sym", text: r.symbol }),
          h("span", { class: "res-tf", text: r.timeframe }),
        ),
        h("span", { class: "res-verdict", text: VERDICT_TEXT[r.verdict] }),
        /* THE HEADLINE NUMBER IS WHAT SURVIVED THE HURDLE, and it is the only
           figure comparable between a market searched with 85 rules and one
           searched with 8. The raw figure is in the sentence below it. */
        h("span", {
          class: "res-edge",
          text:
            r.best !== null && Number.isFinite(r.best.deflated)
              ? `${r.best.deflated >= 0 ? "+" : "−"}${Math.abs(r.best.deflated).toFixed(2)}R`
              : "—",
        }),
      ),
      h("p", { class: "res-why", text: r.why }),
      h("p", {
        class: "res-meta",
        text:
          `${r.searches} search${r.searches === 1 ? "" : "es"}` +
          (r.searches > 0 ? ` · ${r.trials.toLocaleString()} configurations · ${ago(r.lastSearched)}` : "") +
          (r.kept > 0 ? ` · ${r.kept} on the shelf` : ""),
      }),
    );

  const board = h("div", {
    class: "res-board",
    ref: (el: HTMLElement) =>
      renderEffect(() => {
        clear(el);
        const list = shown();
        if (list.length === 0) {
          /* AN EMPTY BOARD SAYS WHICH KIND OF EMPTY IT IS. "Nothing has been
             searched" and "nothing matches this filter" are different facts and
             a blank table states neither. */
          el.appendChild(
            h("p", {
              class: "res-empty",
              text:
                rows().length === 0
                  ? "No search has been recorded yet. Run one from the Strategy desk, or let the autonomous search run, and every attempt will be listed here — including the ones that find nothing."
                  : "No subject has that verdict yet.",
            }),
          );
          return;
        }
        for (const r of list) el.appendChild(boardRow(r));
      }),
  });

  // ------------------------------------------------------- the model ---

  const models = signal<readonly ModelScore[]>([]);
  const modelWhy = signal<string>("");
  const modelBusy = signal<boolean>(false);

  const loadModels = async (): Promise<void> => {
    const load = opts.loadAuto;
    if (!load || modelBusy.peek()) return;
    modelBusy.set(true);
    try {
      const got = await load();
      if (got === null) {
        /* "COULD NOT ASK" IS NOT "NOTHING LEARNED". Rendering an unreachable
           service as an empty board would report the most confident possible
           version of no news. */
        models.set([]);
        modelWhy.set("The autonomous service is not answering, so nothing can be said about the model.");
        return;
      }
      models.set(modelBoard(got.results));
      modelWhy.set("");
    } finally {
      modelBusy.set(false);
    }
  };
  void loadModels();

  const MODEL_TEXT: Readonly<Record<ModelScore["verdict"], string>> = {
    skill: "Learned something",
    "no skill": "Learned nothing",
    "too few": "Too few to say",
    "could not ask": "Not fitted",
  };

  const modelRow = (m: ModelScore): HTMLElement =>
    h(
      "div",
      { class: "res-row", "data-verdict": m.verdict === "skill" ? "working" : m.verdict === "no skill" ? "nothing" : "not searched" },
      h(
        "div",
        { class: "res-row-head" },
        h(
          "span",
          { class: "res-subject" },
          h("span", { class: "res-sym", text: m.symbol }),
          h("span", { class: "res-tf", text: m.timeframe }),
        ),
        h("span", { class: "res-verdict", text: MODEL_TEXT[m.verdict] }),
        /* LIFT OVER THE BASE RATE, not accuracy. Accuracy alone is unreadable:
           61% is excellent against a 50% population and worthless against 61%. */
        h("span", {
          class: "res-edge",
          text:
            Number.isFinite(m.lift) && m.verdict === "skill"
              ? `${m.lift >= 0 ? "+" : "\u2212"}${Math.abs(m.lift * 100).toFixed(0)}pts`
              : "\u2014",
        }),
      ),
      h("p", { class: "res-why", text: m.why }),
    );

  const modelPanel = h(
    "section",
    { class: "dd-panel" },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { class: "panel-title", text: "What the model learned" }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: () => (modelBusy() ? "Reading\u2026" : "Refresh"),
        disabled: () => modelBusy() || opts.loadAuto === undefined,
        onclick: () => void loadModels(),
      }),
    ),
    pkWhy(
      "A classifier that always predicts the commonest outcome scores the base rate exactly \u2014 so an accuracy with no base rate beside it cannot be read at all, and \u201c58% accurate\u201d on a population that is 58% winners has learned nothing. Both numbers are on every row. Learning nothing is an ANSWER about a market and is kept apart from a model that was never fitted. The calibration curve and the fold boundaries are on the Simulation desk, which answers about one market in depth.",
      "Why accuracy alone is not a result",
    ),
    h("p", {
      class: "res-empty",
      "data-on": () => String(modelWhy() !== "" || models().length === 0),
      text: () =>
        modelWhy() !== ""
          ? modelWhy()
          : "No market has had a model fitted yet. The autonomous search fits one per market once its candidate ledger is deep enough.",
      style: () => (modelWhy() === "" && models().length > 0 ? "display:none" : ""),
    }),
    h("div", {
      class: "res-board",
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          clear(el);
          for (const m of models()) el.appendChild(modelRow(m));
        }),
    }),
  );

  const el = h(
    "div",
    { class: "dd results-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Results" }),
      h("p", {
        class: "view-sub",
        text: "Every search this terminal has run, on every market — including the ones that found nothing. A list of only the winners would tell you nothing about whether any of them work.",
      }),
    ),

    h(
      "section",
      { class: "dd-panel" },
      h("h2", { class: "panel-title", text: "Across every market" }),
      /* THE LEDE IS THE DENOMINATOR, in the serif this terminal uses for what it
         says on its own account. */
      h("p", { class: "res-lede", text: () => totals().line }),
      pkWhy(
        "A rule is ranked by what is left of its per-trade edge AFTER the best-of-N hurdle — the amount a search that wide would have produced on noise alone. A market searched with 85 rules and one searched with 8 are not comparable on a raw figure, and the deflated one is the same quantity in both. Below thirty out-of-sample trades no verdict is offered at all.",
        "How a market earns “beat its search”",
      ),

      h(
        "div",
        { class: "res-filters" },
        chip("all", "All", () => rows().length),
        chip("working", "Beat its search", () => totals().working),
        chip("unproven", "Not proven", () => totals().unproven),
        chip("nothing", "Nothing found", () => totals().nothing),
        chip("not searched", "Not searched", () => totals().notSearched),
      ),

      board,
    ),

    modelPanel,
  );

  return { el };
}
