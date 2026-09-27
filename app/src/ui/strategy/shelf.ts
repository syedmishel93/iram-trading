/**
 * The Discovered shelf: what the terminal found by itself, and what is known
 * about each one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY ROW CARRIES ITS PROVENANCE ON SCREEN
 *
 * "+0.42R a trade" is meaningless six months later without the symbol, the
 * timeframe, the bar count, the COSTS it was tested at and — the one nobody
 * keeps — how many arms the search had when it found this one. `discovered.ts`
 * stores all five for that reason, and a shelf that stored them and then showed
 * only the headline would have kept them for nothing. So the provenance line is
 * part of the row, not part of a disclosure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROMOTION ASKS FIRST, AND SAYS WHAT IT MEANS
 *
 * Promoting is the one action here with a consequence: a promoted row is
 * allowed to influence what the terminal recommends. That is exactly the step
 * the search is not allowed to take on its own (`discovered.ts` header), so it
 * is a two-press decision whose confirmation states the consequence in words
 * rather than asking "Are you sure?" — which states nothing.
 *
 * Retiring asks for a REASON, kept with the row, for the same reason a discard
 * does in the Manual flow: a row that vanished with no account of why is a
 * decision nobody can review.
 */

import { renderEffect, signal, type ReadSignal } from "../../core/signal";
import { clear, h } from "../dom";
import { pkWhy } from "../panelkit";
import { forwardVerdict, keyOf, MIN_FORWARD_TRADES, type Discovered } from "../../backtest/discovered";
import type { ShelfStore } from "../../backtest/shelfstore";
import type { RuleSpec } from "../../backtest/rules";
import { lineText, linesFromSpec } from "./draft";

export interface ShelfSectionOptions {
  /** Absent: the section says there is no storage and lists nothing. */
  readonly shelf?: ShelfStore;
  /** Rows for this market are listed first; the rest stay visible below. */
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  readonly onOpenInManual: (spec: RuleSpec) => void;
}

const sR = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
const bp = (v: number): string => `${(v * 10_000).toFixed(0)}bp`;

export const STATUS_LABEL: Readonly<Record<Discovered["status"], string>> = {
  unproven: "Unproven",
  promoted: "Promoted",
  retired: "Retired",
};

/** The rules of a spec as sentences — the same reading the Manual editor shows. */
export function specLines(spec: RuleSpec): string[] {
  return linesFromSpec(spec, "ai").map(lineText);
}

export function createShelfSection(opts: ShelfSectionOptions) {
  const shelf = opts.shelf;
  /** The row whose promotion is waiting for a confirmation, by key. */
  const confirming = signal<string | null>(null);
  /** The row being retired, and the reason typed so far. */
  const retiring = signal<string | null>(null);
  const reason = signal("");

  const provenance = (d: Discovered): string =>
    `Found ${day(d.foundAt)} on ${d.bars.toLocaleString()} bars of ${d.symbol} ${d.timeframe}, as one of ` +
    `${d.trials.toLocaleString()} configurations tried, at ${bp(d.costs.spread)} spread · ` +
    `${bp(d.costs.commission)} commission a side · ${bp(d.costs.slippage)} slippage.`;

  const forwardLine = (d: Discovered): string => {
    if (!d.forward) {
      return `No forward trades recorded yet — ${MIN_FORWARD_TRADES} is the floor before forward results can disagree with a backtest.`;
    }
    return forwardVerdict(d, d.forward).why;
  };

  const row = (d: Discovered): HTMLElement => {
    const key = keyOf(d);
    const el = h("div", { class: "shelf-row", "data-status": d.status, "data-key": key });

    el.appendChild(
      h(
        "div",
        { class: "shelf-row-head" },
        h("span", { class: "shelf-name", text: d.spec.name }),
        h("span", { class: "shelf-market", text: `${d.symbol} · ${d.timeframe}` }),
        h("span", { class: "shelf-status", "data-status": d.status, text: STATUS_LABEL[d.status] }),
        h("span", { class: "shelf-origin", text: d.origin === "hybrid" ? "Hybrid" : "Library" }),
      ),
    );

    el.appendChild(
      h(
        "div",
        { class: "shelf-figs" },
        h("span", { class: "num", text: `${d.trades} unseen trades` }),
        h("span", { class: "num", text: `${sR(d.expectancy)} a trade` }),
        h("span", { class: "num", text: `${r2(d.sharpe)} Sharpe a trade` }),
        h("span", { class: "num", text: `${r2(d.deflated)} left after a ${r2(d.hurdle)} hurdle` }),
      ),
    );

    el.appendChild(h("p", { class: "shelf-prov muted small", text: provenance(d) }));
    el.appendChild(h("p", { class: "shelf-forward small", text: forwardLine(d) }));

    if (d.status === "retired" && d.retiredWhy) {
      el.appendChild(h("p", { class: "shelf-retired small", text: `Retired: ${d.retiredWhy}` }));
    }
    if (d.armedAt !== undefined) {
      el.appendChild(h("p", { class: "shelf-armed small", text: `A server-side watch was armed for this on ${day(d.armedAt)}.` }));
    }

    el.appendChild(
      h(
        "ul",
        { class: "shelf-lines" },
        ...specLines(d.spec).map((t) => h("li", { text: t })),
      ),
    );

    const actions = h("div", { class: "shelf-actions" });
    if (shelf && d.status !== "promoted" && d.status !== "retired") {
      actions.appendChild(
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          "data-act": "promote",
          text: "Promote",
          onclick: () => confirming.set(confirming.peek() === key ? null : key),
        }),
      );
    }
    if (shelf && d.status !== "retired") {
      actions.appendChild(
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          "data-act": "retire",
          text: "Retire",
          onclick: () => {
            reason.set("");
            retiring.set(retiring.peek() === key ? null : key);
          },
        }),
      );
    }
    actions.appendChild(
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "open-manual",
        text: "Open in Manual",
        onclick: () => opts.onOpenInManual(d.spec),
      }),
    );
    el.appendChild(actions);

    if (confirming() === key) {
      el.appendChild(
        h(
          "div",
          { class: "shelf-confirm", "data-act": "confirm-promote" },
          h("p", {
            class: "small",
            text:
              `Promoting “${d.spec.name}” lets it influence what the terminal recommends on ${d.symbol} ${d.timeframe}: ` +
              `it will be checked against the latest closed bar and offered as a plan when its entry is true. It has ` +
              `${d.trades} out-of-sample trades behind it and no forward record. Nothing places an order either way.`,
          }),
          h("button", {
            class: "primary-btn tiny",
            type: "button",
            "data-act": "promote-confirm",
            text: "Yes, promote it",
            onclick: () => {
              shelf?.promote(key);
              confirming.set(null);
            },
          }),
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            "data-act": "promote-cancel",
            text: "Keep it unproven",
            onclick: () => confirming.set(null),
          }),
        ),
      );
    }

    if (retiring() === key) {
      el.appendChild(
        h(
          "div",
          { class: "shelf-retire" },
          h("input", {
            class: "field-input",
            type: "text",
            placeholder: "Why retire it? (kept with the row)",
            "aria-label": `Reason for retiring ${d.spec.name}`,
            value: () => reason(),
            oninput: (e: Event) => reason.set((e.target as HTMLInputElement).value),
          }),
          h("button", {
            class: "primary-btn tiny",
            type: "button",
            "data-act": "retire-confirm",
            disabled: () => reason().trim() === "",
            text: "Retire it",
            onclick: () => {
              shelf?.retire(key, reason.peek().trim());
              retiring.set(null);
              reason.set("");
            },
          }),
        ),
      );
    }

    return el;
  };

  const list = h("div", { class: "shelf-list" });
  renderEffect(() => {
    /* Read the signals this list depends on BEFORE the early returns, or a
       promotion would write the slot and nothing would re-render. */
    const all = shelf?.rows() ?? [];
    confirming();
    retiring();
    const sym = opts.symbol();
    const tf = opts.timeframe();
    clear(list);

    if (!shelf) {
      list.appendChild(
        h("p", { class: "strat-empty", text: "This desk was opened without storage, so nothing can be kept on a shelf." }),
      );
      return;
    }
    if (all.length === 0) {
      list.appendChild(h("p", { class: "strat-empty", text: "Nothing found yet. Run the search above." }));
      return;
    }

    const here = all.filter((d) => d.symbol === sym && d.timeframe === tf);
    const elsewhere = all.filter((d) => d.symbol !== sym || d.timeframe !== tf);

    list.appendChild(h("p", { class: "small strat-sub-head", text: `${sym} · ${tf} (${here.length})` }));
    if (here.length === 0) {
      list.appendChild(h("p", { class: "muted small", text: "Nothing has been found for this market yet." }));
    }
    for (const d of here) list.appendChild(row(d));

    if (elsewhere.length > 0) {
      list.appendChild(h("p", { class: "small strat-sub-head", text: `Other markets (${elsewhere.length})` }));
      for (const d of elsewhere) list.appendChild(row(d));
    }
  });

  const el = h(
    "section",
    { class: "panel strat-card auto-card", "data-step": "shelf" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Discovered" }),
      h("span", { class: "strat-hint", text: "saved automatically · unproven until you say otherwise" }),
    ),
    h(
      "div",
      { class: "panel-body" },
      list,
      pkWhy(
        "Every row here came out of a search, not out of a person. Surviving the out-of-sample gate and the " +
          `best-of-many hurdle is a better position than most published backtests and is still not evidence that it ` +
          `works on this market next week, so rows start UNPROVEN and stay there until you promote one. Promoted ` +
          `means it may influence a recommendation. Retired means you have taken it out, with your reason kept ` +
          `beside it; a retired rule is left out of later searches. A row is also retired automatically when its ` +
          `forward record falls two standard errors below its backtest, measured with the backtest's own spread — ` +
          `and never before ${MIN_FORWARD_TRADES} forward trades, because a smaller sample cannot carry the question.`,
        "Why?",
      ),
    ),
  );

  return { el };
}
