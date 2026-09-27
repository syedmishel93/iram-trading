/**
 * The Knowledge desk — what the terminal has learned from the past, browsable.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THE LAYOUT IS ARGUING
 *
 * The same argument `ui/survey.ts` makes, and for the same reason. A table of
 * conditional edges is the most seductive object a terminal can put on screen:
 * hundreds of cells, sortable, with a green one at the top. SORTING IS WHAT
 * PRODUCES A GREEN ONE AT THE TOP, on data with no edge in it. So:
 *
 *  - the SAMPLE column sits immediately after the condition, before any rate,
 *    because it is the number that licenses every number to its right;
 *  - a cell under the floor is grey whatever its expectancy, and its rate
 *    columns print "—" rather than a suppressed-but-guessable figure;
 *  - a stale row carries the word STALE, not a faded colour, because a colour
 *    is a hint and this is a reason to distrust the row;
 *  - colour follows the STANDING (usable and clear of break-even), never the
 *    magnitude.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE AXIS AT A TIME ON SCREEN TOO
 *
 * The base slices by regime, session, hour and weekday separately and never by
 * their intersection (`learn/knowledge.ts` explains why). The desk shows one
 * axis at a time for the reading equivalent: five axes interleaved in one table
 * is a table nobody can compare two rows in.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE EMPTY STATE IS THE FIRST THING MOST PEOPLE SEE
 *
 * A base nobody has harvested into is empty, and an empty desk that says
 * "no data" is a dead end. It says what a harvest does, what it costs, what it
 * will read, and offers the button — and the button is the same one the desk
 * keeps afterwards, so the thing you learned in the empty state is still true
 * later.
 */

import { renderEffect, signal, type ReadSignal } from "../core/signal";
import { nameForKind } from "../detect/index";
import { clear, h } from "./dom";
import { pkWhy } from "./panelkit";
import { applyFilters, applySort, filterRow, sortableHeader, type Column, type SortKey } from "./table";
import { TIMEFRAMES } from "./shell/views";
import type { HistoryService } from "../data/history";
import type { DetectorId } from "../detect/index";
import { DEEP_TARGET_BARS } from "../setup/deep";
import {
  AXES,
  AXIS_LABEL,
  MIN_CELL_TRIALS,
  SOURCE_LABEL,
  agoText,
  type ContextAxis,
  type KnowledgeBase,
  type KnowledgeCell,
} from "../learn/knowledge";
import { runHarvest, type HarvestHandle, type HarvestReport, type HarvestTarget } from "../learn/harvest";

export interface KnowledgeDeskOptions {
  /** The one base. See `sharedKnowledge` — the desk never makes its own. */
  readonly base: KnowledgeBase;
  /** The archive-backed history service. The same one the labs read. */
  readonly history: HistoryService;
  /** The chart's symbol, used only as the default target of a harvest. */
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  /** The operator's own detector set, read at run time so a change is seen. */
  readonly detectors: () => readonly DetectorId[];
  /** The operator's own minimum stop, in ATR. The floor the live plan uses. */
  readonly minStopAtr: () => number;
}

export interface KnowledgeDeskHandle {
  readonly el: HTMLElement;
}

/**
 * The reward-to-risk choices a harvest is offered at.
 *
 * A CHOICE AND NOT A DEFAULT, because it changes the answer completely: 40% is
 * excellent at 3R and ruinous at 1R, and studies at different R are kept apart
 * in the base rather than pooled. Three is enough to bracket what anyone
 * trades; a free number field would produce a base full of 1.7R studies that
 * never pool with anything.
 */
const R_CHOICES = [1, 2, 3] as const;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const rr = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
/** The hit rate an R needs just to cover its losers. Same formula as the card. */
const breakEvenAt = (r: number): number => (r > 0 ? 1 / (1 + r) : 1);

export function createKnowledge(opts: KnowledgeDeskOptions): KnowledgeDeskHandle {
  const axis = signal<ContextAxis>("regime");
  const sort = signal<readonly SortKey[]>([{ column: "trials", dir: "desc" }]);
  const filters = signal<Readonly<Record<string, string>>>({});
  const onlyUsable = signal(false);

  const symbolsText = signal("");
  const tfPick = signal("");
  const rPick = signal<number>(2);
  const deepen = signal(false);

  const running = signal(false);
  const progressText = signal("");
  const report = signal<HarvestReport | null>(null);
  let handle: HarvestHandle | null = null;

  /* ------------------------------------------------------------- columns -- */

  const columns: readonly Column<KnowledgeCell>[] = [
    { id: "symbol", label: "Symbol", value: (c) => c.symbol, filter: "text" },
    { id: "timeframe", label: "TF", value: (c) => c.timeframe, filter: "text" },
    { id: "kind", label: "Setup", value: (c) => nameForKind(c.kind), filter: "text" },
    { id: "direction", label: "Side", value: (c) => c.direction, filter: "text" },
    { id: "condition", label: "Condition", value: (c) => c.label, filter: "text" },
    { id: "r", label: "at", value: (c) => c.rMultiple, align: "right", filter: "number" },
    /* The sample, immediately after the condition and BEFORE any rate. */
    { id: "trials", label: "Trials", value: (c) => c.trials, align: "right", filter: "number" },
    {
      id: "hit",
      label: "Hit",
      /* Null, not zero, below the floor: `applySort` keeps nulls last in both
         directions, so flipping the sort can never float an unmeasured cell to
         the top of a column about rates. */
      value: (c) => (c.usable ? c.hitRate : null),
      align: "right",
      filter: "number",
    },
    {
      id: "atleast",
      label: "At least",
      value: (c) => (c.usable ? c.hitLow : null),
      align: "right",
      filter: "number",
    },
    {
      id: "expectancy",
      label: "Per attempt",
      value: (c) => (c.usable ? c.expectancyR : null),
      align: "right",
      filter: "number",
    },
    { id: "bars", label: "Bars", value: (c) => (c.usable ? c.medianBars : null), align: "right", filter: "number" },
    { id: "updated", label: "Updated", value: (c) => c.updatedAt, align: "right", filter: "none" },
  ];

  /**
   * The rows on screen, and HOW MANY THE FILTERS REMOVED.
   *
   * The count travels with the rows because `ui/table.ts` computes it for
   * exactly this reason: a filter that hides rows without saying so turns an
   * empty table into a fact about the market rather than a fact about the
   * filter box three rows above it.
   */
  const rows = (): { list: readonly KnowledgeCell[]; hidden: number } => {
    const all = opts.base.cells(axis());
    const thinned = onlyUsable() ? all.filter((c) => c.usable) : all;
    const hiddenByFloor = all.length - thinned.length;
    const res = applyFilters(thinned, columns, filters());
    return {
      list: applySort(res.rows, columns, sort()),
      hidden: res.removed + hiddenByFloor,
    };
  };

  /* -------------------------------------------------------------- harvest -- */

  const targets = (): readonly HarvestTarget[] => {
    const tf = tfPick() || opts.timeframe();
    const raw = symbolsText().trim() || opts.symbol();
    const symbols = [...new Set(raw.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => s !== ""))];
    return symbols.map((symbol) => ({ symbol, timeframe: tf }));
  };

  const start = (): void => {
    if (running.peek()) return;
    const list = targets();
    if (list.length === 0) return;
    report.set(null);
    running.set(true);
    const run = runHarvest({
      history: opts.history,
      base: opts.base,
      targets: list,
      detectors: opts.detectors(),
      rMultiple: rPick.peek(),
      minStopAtr: opts.minStopAtr(),
      backfill: deepen.peek(),
    });
    handle = run;
    renderEffect(() => {
      const p = run.progress();
      progressText.set(
        p.total === 0
          ? ""
          : `${p.done} of ${p.total} · ${p.symbol} ${p.timeframe}${p.note ? ` — ${p.note}` : ""}`,
      );
    });
    void run.done.then((r) => {
      report.set(r);
      running.set(false);
      progressText.set("");
      handle = null;
    });
  };

  /* ---------------------------------------------------------------- view -- */

  const el = h("section", { class: "kb" }) as HTMLElement;

  const controls = (): HTMLElement =>
    h(
      "div",
      { class: "kb-run" },
      h(
        "label",
        { class: "kb-field" },
        h("span", { class: "kb-field-k", text: "Instruments" }),
        h("input", {
          class: "kb-input",
          type: "text",
          spellcheck: "false",
          placeholder: () => opts.symbol(),
          title:
            "One or more symbols, separated by commas or spaces. Empty means the chart's own symbol.",
          value: () => symbolsText(),
          oninput: (e: Event) => symbolsText.set((e.target as HTMLInputElement).value),
        }),
      ),
      h(
        "label",
        { class: "kb-field" },
        h("span", { class: "kb-field-k", text: "Timeframe" }),
        h(
          "select",
          {
            class: "kb-input",
            onchange: (e: Event) => tfPick.set((e.target as HTMLSelectElement).value),
          },
          ...TIMEFRAMES.map((tf) =>
            h("option", { value: tf, selected: () => (tfPick() || opts.timeframe()) === tf ? "" : null, text: tf }),
          ),
        ),
      ),
      h(
        "label",
        { class: "kb-field" },
        h("span", { class: "kb-field-k", text: "Priced at" }),
        h(
          "select",
          {
            class: "kb-input",
            title:
              "The reward-to-risk every replayed trial is priced at. Studies at different R are kept apart, never pooled — 40% is excellent at 3R and ruinous at 1R.",
            onchange: (e: Event) => rPick.set(Number((e.target as HTMLSelectElement).value)),
          },
          ...R_CHOICES.map((r) =>
            h("option", { value: String(r), selected: () => (rPick() === r ? "" : null), text: `${r}R` }),
          ),
        ),
      ),
      h(
        "label",
        { class: "kb-check" },
        h("input", {
          type: "checkbox",
          checked: () => (deepen() ? "" : null),
          onchange: (e: Event) => deepen.set((e.target as HTMLInputElement).checked),
        }),
        h("span", {
          text: "Reach further back",
          title:
            "Page the vendor for older bars before replaying. Off by default: a harvest of twenty instruments would otherwise fire hundreds of requests at a proxy you may be running yourself.",
        }),
      ),
      h(
        "button",
        {
          class: "primary-btn kb-go",
          type: "button",
          disabled: () => (running() ? "" : null),
          onclick: start,
        },
        () => (running() ? "Learning…" : "Learn from history"),
      ),
      h(
        "button",
        {
          class: "ghost-btn kb-stop",
          type: "button",
          hidden: () => (running() ? null : ""),
          title: "Stop after the instrument in flight. Everything already replayed is kept.",
          onclick: () => handle?.cancel(),
        },
        "Stop",
      ),
    ) as HTMLElement;

  const summary = (): HTMLElement => {
    const entries = opts.base.entries();
    const instruments = new Set(entries.map((e) => `${e.symbol} ${e.timeframe}`)).size;
    const trials = entries.reduce(
      (s, e) => s + (e.cells.find((c) => c.axis === "all")?.trials ?? 0),
      0,
    );
    const newest = entries.length === 0 ? 0 : Math.max(...entries.map((e) => e.at));
    return h(
      "p",
      { class: "kb-summary" },
      entries.length === 0
        ? "Nothing harvested yet."
        : `${entries.length} ${entries.length === 1 ? "study" : "studies"} across ${instruments} ` +
          `${instruments === 1 ? "instrument" : "instruments"}, ${trials.toLocaleString()} completed ` +
          `${trials === 1 ? "trial" : "trials"}. Newest harvest ${agoText(Date.now() - newest)}.`,
    ) as HTMLElement;
  };

  const empty = (): HTMLElement =>
    h(
      "div",
      { class: "kb-empty" },
      h("p", {
        class: "kb-empty-lede",
        text:
          "Nothing has been learned from the past yet. A harvest reads what your archive already holds — " +
          `up to ${DEEP_TARGET_BARS.toLocaleString()} bars per instrument, no vendor requests unless you ask ` +
          "for them — runs your own detectors over it, replays every setup it finds, and files each completed " +
          "trial under the conditions it happened in.",
      }),
      h("p", {
        class: "kb-empty-lede",
        text:
          "Nothing here feeds back into a score. It is measured, kept and reported beside the read, so it is " +
          "allowed to disagree with the terminal in public.",
      }),
    ) as HTMLElement;

  const cellRow = (c: KnowledgeCell): HTMLElement => {
    const be = breakEvenAt(c.rMultiple);
    /* Colour follows the STANDING, not the number: a cell is only ever green
       when it has a real sample AND its Wilson lower bound clears the
       break-even its R demands. A sorted table always has a big number at the
       top, including on data with no edge in it. */
    const standing = !c.usable ? "thin" : c.hitLow >= be ? "clears" : c.expectancyR < 0 ? "against" : "short";
    const num = (v: string): HTMLElement =>
      h("span", { class: "kb-cell", "data-align": "right", text: v }) as HTMLElement;

    return h(
      "div",
      {
        class: "kb-row",
        role: "row",
        "data-standing": standing,
        "data-stale": String(c.stale),
      },
      h("span", { class: "kb-cell", text: c.symbol }),
      h("span", { class: "kb-cell", text: c.timeframe }),
      /* The kind's human name, one owner in detect/index.ts — the table read
             "bos" and "choch" at the operator, which are keys, not words. */
          h("span", { class: "kb-cell", text: nameForKind(c.kind) }),
      h("span", { class: "kb-cell", text: c.direction }),
      h("span", { class: "kb-cell kb-cond", text: c.label }),
      num(`${c.rMultiple}R`),
      h(
        "span",
        {
          class: "kb-cell kb-trials",
          "data-align": "right",
          title: c.usable
            ? `${c.trials} completed trials from ${c.studies} ${c.studies === 1 ? "study" : "studies"} (${c.sources.map((s) => SOURCE_LABEL[s]).join(", ")}).`
            : `${c.trials} completed trials — under the ${MIN_CELL_TRIALS} needed before a rate means anything, so the rate columns are withheld rather than greyed.`,
        },
        String(c.trials),
      ),
      num(c.usable ? pct(c.hitRate) : "—"),
      num(c.usable ? pct(c.hitLow) : "—"),
      num(c.usable ? rr(c.expectancyR) : "—"),
      h(
        "span",
        {
          class: "kb-cell",
          "data-align": "right",
          title: c.usable && c.medianPooled
            ? "Pooled from more than one study: the trial-weighted mean of their medians, not a median. A median is not summable and this base does not keep the raw trial list."
            : "Median bars from entry to resolution.",
        },
        c.usable ? `${Math.round(c.medianBars)}${c.medianPooled ? "*" : ""}` : "—",
      ),
      h(
        "span",
        { class: "kb-cell kb-updated", "data-align": "right" },
        h("span", { text: agoText(Date.now() - c.updatedAt) }),
        /* Said in a word, not in a colour. A faded row is a hint; this is a
           reason to distrust the numbers on it. */
        ...(c.stale ? [h("span", { class: "kb-stale", text: "STALE" })] : []),
      ),
    ) as HTMLElement;
  };

  renderEffect(() => {
    clear(el);

    el.appendChild(
      h(
        "header",
        { class: "kb-head" },
        h("h1", { class: "kb-h1", text: "Knowledge" }),
        h("p", {
          class: "kb-lede",
          text:
            "Everything past harvests have measured, kept and sliced by the conditions it happened in. " +
            "Not a backtest you are about to run — a base a live read can consult.",
        }),
        summary(),
      ),
    );

    el.appendChild(controls());

    const p = progressText();
    if (p !== "") el.appendChild(h("p", { class: "kb-progress", text: p }));

    const r = report();
    if (r !== null) {
      el.appendChild(h("p", { class: "kb-report", text: r.note }));
      const bad = r.rows.filter((row) => row.state !== "ok");
      if (bad.length > 0) {
        el.appendChild(
          h(
            "ul",
            { class: "kb-report-rows" },
            ...bad.map((row) =>
              h("li", { class: "kb-report-row", text: `${row.symbol} ${row.timeframe} — ${row.note}` }),
            ),
          ),
        );
      }
      if (r.merged !== null && r.merged.refused.length > 0) {
        el.appendChild(
          h(
            "ul",
            { class: "kb-report-rows" },
            ...r.merged.refused.map((line) => h("li", { class: "kb-report-row", text: line })),
          ),
        );
      }
    }

    /* The cap's own note, and the storage error, both in the open. A cap that
       discards evidence in silence is indistinguishable from a base that never
       learned it. */
    const dropped = opts.base.droppedNote();
    if (dropped !== "") el.appendChild(h("p", { class: "kb-warn", text: dropped }));
    const err = opts.base.lastError();
    if (err !== "") el.appendChild(h("p", { class: "kb-warn", text: err }));

    if (opts.base.entries().length === 0) {
      el.appendChild(empty());
      return;
    }

    el.appendChild(
      h(
        "div",
        { class: "kb-axis" },
        ...AXES.map((a) =>
          h(
            "button",
            {
              class: "seg-btn",
              type: "button",
              "aria-pressed": () => String(axis() === a),
              onclick: () => axis.set(a),
            },
            AXIS_LABEL[a],
          ),
        ),
        h(
          "label",
          { class: "kb-check" },
          h("input", {
            type: "checkbox",
            checked: () => (onlyUsable() ? "" : null),
            onchange: (e: Event) => onlyUsable.set((e.target as HTMLInputElement).checked),
          }),
          h("span", { text: `Only cells with ${MIN_CELL_TRIALS}+ trials` }),
        ),
      ),
    );

    const { list, hidden } = rows();
    const table = h("div", { class: "kb-table", role: "table" }) as HTMLElement;
    table.appendChild(
      sortableHeader({
        columns,
        sort: () => sort(),
        onSort: (next) => sort.set(next),
        rowClass: "kb-row kb-header",
        cellClass: "kb-hcell",
      }),
    );
    table.appendChild(
      filterRow({
        columns,
        filters: () => filters(),
        onFilter: (id, raw) => filters.set({ ...filters.peek(), [id]: raw }),
        rowClass: "kb-row kb-filters",
      }),
    );
    for (const c of list) table.appendChild(cellRow(c));
    el.appendChild(table);

    if (hidden > 0) {
      el.appendChild(
        h("p", {
          class: "kb-hidden",
          text: `${list.length} shown, ${hidden} hidden by the filters and the sample floor.`,
        }),
      );
    }

    if (list.length === 0) {
      el.appendChild(
        h("p", {
          class: "kb-none",
          text:
            hidden > 0
              ? "Nothing on this axis got past the filters. The base is not empty — clear one."
              : "This axis holds nothing yet. Harvest an instrument, or try another axis.",
        }),
      );
    }

    el.appendChild(
      pkWhy(
        "Every trial here is a real historical instance replayed against the bars that actually followed it — " +
          "nothing is generated. It is IN-SAMPLE: the pattern was found on the same bars it is scored over, which " +
          "is the mechanism behind this repository's measured PBO of 89%. So it is reported beside the read and " +
          "never merged into a score, it is allowed to disagree with the terminal, and your own journal outranks it.",
        "How this is measured, and what it is not",
      ),
    );
  });

  return { el };
}
