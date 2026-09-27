/**
 * The Journal desk.
 *
 * WHY THE FORM IS THIS SHORT
 * A journal with three entries in it measures nothing, and the reliable way to
 * end up with three entries is a form with fourteen fields. So this asks for
 * the two things only you know — what you paid, and what you got out at — and
 * takes everything else from what the terminal already has on screen: the
 * symbol, the timeframe, the direction the read leans, the plan's stop and
 * target, the setup the chart is showing, the confluence score, which gates
 * were passing, and where the price came from.
 *
 * The one optional field that earns its place is ADHERENCE. "Did you follow
 * the plan" is the question a broker statement cannot answer and the one that
 * makes this worth more than a broker statement — and the answer is one click.
 *
 * WHAT THE DESK REFUSES TO DO
 * Everything the honesty contract has always refused. It does not place,
 * modify or close a position; it records that you did. The "Close" button
 * writes an exit price into a row and touches nothing else in the world.
 *
 * AND WHAT IT REFUSES TO CLAIM
 * Every statistic here comes through `journal/stats.ts`, which will not print
 * a percentage below its sample floor. The desk therefore shows "17 closed
 * trades — too few to measure" rather than a hit rate, and that is the desk
 * working rather than the desk waiting on data.
 */

import { h, clear } from "./dom";
import { pkWhy } from "./panelkit";
import { createFillsPanel } from "./fillspanel";
import { createReviewSection } from "./review/reviewpanel";
import { renderEffect, signal } from "../core/signal";
import { createReviewStore } from "../journal/review";
import { createSayStore, SAYS_SLOT } from "../journal/says";
import type { FillsResult } from "../data/fills";
import type { CalendarFeed } from "../data/calendar";
import type { KV } from "../store/kv";
import {
  outcome,
  realisedR,
  toCsv,
  type Adherence,
  type JournalEntry,
  type NewEntry,
} from "../journal/entry";
import { byAdherence, bySetup, computeStats, MIN_SAMPLE, planGapLine } from "../journal/stats";
import type { Journal } from "../journal/store";

export interface JournalDeskOptions {
  readonly journal: Journal;
  /** Everything the terminal already knows, for the prefill. */
  context(): {
    symbol: string;
    timeframe: string;
    direction: "long" | "short";
    entry: number | null;
    stop: number | null;
    target: number | null;
    setupKind: string | null;
    score: number | null;
    gatesBlocking: readonly string[];
    source: string;
    quality: string;
  };
  /** Last traded price, to prefill the exit box. */
  price(): number | null;
  notify(level: "info" | "warn", title: string, body: string): void;
  /**
   * OPTIONAL. Where your judgements and committed rules persist. Without it
   * the Review section still works, in memory, and says so on screen.
   */
  readonly kv?: KV;
  /** OPTIONAL. The economic calendar, for the news-timing check. Without it that check says it cannot check. */
  readonly calendar?: () => CalendarFeed | null;
}

const ADHERENCES: readonly { id: Adherence; label: string; hint: string }[] = [
  { id: "as-planned", label: "As planned", hint: "Entry, stop and target as the card said." },
  { id: "modified", label: "Modified", hint: "Taken, but with a different entry, stop or size." },
  { id: "off-plan", label: "Off plan", hint: "No plan on screen, or taken against a blocking gate." },
];

const fmt = (v: number | null): string =>
  v === null || !Number.isFinite(v)
    ? ""
    : Math.abs(v) >= 1000
      ? v.toFixed(2)
      : Math.abs(v) >= 1
        ? v.toFixed(4)
        : v.toFixed(6);

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const rTxt = (v: number | null): string => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`);

export function createJournalDesk(opts: JournalDeskOptions): { el: HTMLElement } {
  const el = h("section", { class: "desk journal-desk" }) as HTMLElement;
  /* Built once and re-attached on every render: it holds its own load state,
     and a re-render must not throw away a sync the operator is waiting on. */
  const fillsResult = signal<FillsResult | null>(null);
  const fills = createFillsPanel({
    notify: (level, title, body) => opts.notify(level, title, body),
    onResult: (r) => fillsResult.set(r),
  });
  /* Review — AI finds · you judge. Built once for the same reason as the
     fills panel: it holds a half-typed rule that a re-render must not drop. */
  /* The decision log is plain KV, not a signal. A version signal bumped on
     every write to its key makes the Review re-read it when you answer a
     recommendation in the inspector — including from another tab. */
  const saysVersion = signal(0);
  const sayStore = opts.kv ? createSayStore(opts.kv) : null;
  opts.kv?.subscribe((key) => {
    if (key === SAYS_SLOT.key) saysVersion.set(saysVersion.peek() + 1);
  });
  const review = createReviewSection({
    journal: opts.journal,
    fills: fillsResult,
    store: createReviewStore(opts.kv ?? null),
    ...(opts.calendar ? { calendar: opts.calendar } : {}),
    /* The decision log lives in the same KV; no KV, no log to read. */
    ...(sayStore
      ? {
          says: () => {
            saysVersion();
            return sayStore.all();
          },
        }
      : {}),
    notify: (level, title, body) => opts.notify(level, title, body),
  });

  /* Form state lives in plain variables rather than signals: it is scratch
     input that nothing else in the terminal reads, and a signal would invite
     something to start depending on a half-typed number. */
  let entryPrice = "";
  let stopPrice = "";
  let sizeText = "1";
  let adherence: Adherence = "as-planned";
  let note = "";

  const parse = (s: string): number | null => {
    const n = Number(s.trim());
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  const prefill = (): void => {
    const c = opts.context();
    entryPrice = fmt(c.entry ?? opts.price());
    stopPrice = fmt(c.stop);
    render();
  };

  const record = (): void => {
    const c = opts.context();
    const entry = parse(entryPrice);
    const stop = parse(stopPrice);
    const size = parse(sizeText) ?? 1;

    /* Refused, and told why. A journal that silently drops a malformed entry
       is a journal you will find gaps in months later with no idea when. */
    if (entry === null || stop === null) {
      opts.notify("warn", "Not recorded", "A trade needs an entry price and a stop.");
      return;
    }
    if (entry === stop) {
      opts.notify(
        "warn",
        "Not recorded",
        "Entry and stop are the same price, which gives the trade no risk to measure R against.",
      );
      return;
    }

    const made: NewEntry = {
      openedAt: Date.now(),
      symbol: c.symbol,
      timeframe: c.timeframe,
      direction: c.direction,
      entry,
      stop,
      target: c.target,
      size,
      setupKind: c.setupKind,
      scoreAtEntry: c.score,
      gatesBlocking: c.gatesBlocking,
      adherence,
      note,
      source: c.source,
      quality: c.quality,
    };
    opts.journal.add(made);
    note = "";
    opts.notify("info", "Recorded", `${c.direction} ${c.symbol} at ${fmt(entry)}, stop ${fmt(stop)}.`);
    render();
  };

  const closeRow = (e: JournalEntry): void => {
    const p = opts.price();
    const raw = window.prompt(`Exit price for ${e.direction} ${e.symbol} from ${fmt(e.entry)}:`, fmt(p));
    if (raw === null) return;
    const exit = Number(raw.trim());
    if (!Number.isFinite(exit) || exit <= 0) {
      opts.notify("warn", "Not closed", `"${raw}" is not a price.`);
      return;
    }
    opts.journal.close(e.id, exit);
    render();
  };

  const exportCsv = (): void => {
    const csv = toCsv(opts.journal.entries());
    /* Clipboard rather than a download: the viewer sandbox blocks a
       page-initiated save, and a button that appears to do nothing is worse
       than one that says what it did. */
    void navigator.clipboard
      ?.writeText(csv)
      .then(() =>
        opts.notify("info", "Journal copied", `${opts.journal.entries().length} rows on the clipboard as CSV.`),
      )
      .catch(() => opts.notify("warn", "Copy failed", "The clipboard refused. Nothing was lost."));
  };

  function statBlock(label: string, value: string, hint = ""): HTMLElement {
    return h(
      "div",
      { class: "jr-stat", ...(hint ? { title: hint } : {}) },
      h("span", { class: "jr-stat-label", text: label }),
      h("span", { class: "jr-stat-value num", text: value }),
    );
  }

  function render(): void {
    clear(el);
    const entries = opts.journal.entries();
    const stats = computeStats(entries);
    const c = opts.context();

    el.appendChild(review);
    el.appendChild(
      h(
        "header",
        { class: "desk-head" },
        h("h2", { class: "desk-title", text: "Journal" }),
        h("p", {
          class: "desk-blurb",
          text: "Your trades, measured against the plan you made. Record trades here, or sync your real fills from MT5 below.",
        }),
      ),
    );

    const err = opts.journal.lastError();
    if (err !== "") {
      el.appendChild(h("p", { class: "jr-error", text: err }));
    }

    // ------------------------------------------------------------ record ---
    el.appendChild(
      h(
        "div",
        { class: "jr-panel" },
        h(
          "div",
          { class: "jr-panel-head" },
          h("span", { class: "jr-panel-title", text: "Record a trade" }),
          h("span", {
            class: "jr-context",
            text: `${c.direction} ${c.symbol} · ${c.timeframe}${c.setupKind ? ` · ${c.setupKind}` : " · discretionary"}`,
          }),
        ),
        pkWhy(
          "Only the fill and the stop are asked for. Everything else — the setup, the score, which gates were passing, where the price came from — is taken from what is on screen, because a form nobody fills in measures nothing.",
          "What gets recorded",
        ),
        h(
          "div",
          { class: "jr-form" },
          field("Entry", entryPrice, (v) => (entryPrice = v)),
          field("Stop", stopPrice, (v) => (stopPrice = v)),
          field("Size", sizeText, (v) => (sizeText = v)),
        ),
        h(
          "div",
          { class: "jr-adherence" },
          h("span", { class: "jr-stat-label", text: "Followed the plan?" }),
          h(
            "div",
            { class: "detect-seg" },
            ...ADHERENCES.map((a) =>
              h("button", {
                class: "detect-seg-btn",
                type: "button",
                text: a.label,
                title: a.hint,
                "data-on": String(adherence === a.id),
                "aria-pressed": String(adherence === a.id),
                onclick: () => {
                  adherence = a.id;
                  render();
                },
              }),
            ),
          ),
        ),
        h("input", {
          class: "jr-note",
          type: "text",
          placeholder: "Note (optional) — why you took it, what you were unsure about",
          value: note,
          oninput: (ev: Event) => {
            note = (ev.target as HTMLInputElement).value;
          },
        }),
        h(
          "div",
          { class: "jr-actions" },
          h("button", { class: "ghost-btn", type: "button", text: "Prefill from the card", onclick: prefill }),
          h("button", { class: "primary-btn", type: "button", text: "Record", onclick: record }),
          h("button", { class: "ghost-btn", type: "button", text: "Copy as CSV", onclick: exportCsv }),
        ),
        h("p", {
          class: "jr-fine",
          text: "Recording a trade changes nothing outside this list. The terminal has never placed, modified or closed an order and this does not.",
        }),
      ),
    );

    // ------------------------------------------------------------- stats ---
    el.appendChild(
      h(
        "div",
        { class: "jr-panel" },
        h(
          "div",
          { class: "jr-panel-head" },
          h("span", { class: "jr-panel-title", text: "The record" }),
        ),
        stats.n === 0
          ? h("p", {
              class: "jr-fine",
              text:
                stats.open > 0
                  ? `${stats.open} open, none closed yet. Nothing can be measured until a trade finishes.`
                  : "Nothing recorded yet. The Setup card will keep saying so until there is something to measure.",
            })
          : h(
              "div",
              {},
              h(
                "div",
                { class: "jr-stats" },
                statBlock("Closed", String(stats.n)),
                statBlock("Open", String(stats.open)),
                statBlock(
                  "Expectancy",
                  `${stats.expectancy >= 0 ? "+" : ""}${stats.expectancy.toFixed(2)}R`,
                  "Mean realised R. The figure that answers 'should I keep taking these' — unlike win rate, which does not.",
                ),
                statBlock(
                  "Hit rate",
                  stats.usable ? `${pct(stats.hitRate)} ±${stats.intervalWidth.toFixed(0)}` : "—",
                  "The band is the 95% interval, in percentage points. A hit rate without one is the number people size up on.",
                ),
                statBlock("Total", `${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(1)}R`),
                statBlock(
                  "Max drawdown",
                  `${stats.maxDrawdownR.toFixed(1)}R`,
                  "Peak to trough of the cumulative R curve — a run of four −1R trades, not the worst single loss.",
                ),
              ),
              /* The refusal, stated where the numbers are, not hidden in a
                 tooltip. Below the floor the point estimates above are still
                 shown because they are arithmetic; what is withheld is any
                 suggestion that they mean something. */
              stats.usable
                ? h("p", { class: "jr-fine", text: planGapLine(stats) || "The sample is large enough to read." })
                : h("p", {
                    class: "jr-warn",
                    text: `${stats.n} closed trade${stats.n === 1 ? "" : "s"} — below ${MIN_SAMPLE}, none of this is a measurement yet. At 20 trades the band around a 50% hit rate still runs from roughly 28% to 72%.`,
                  }),
              breakdown("By setup", bySetup(entries)),
              breakdown("By adherence", byAdherence(entries)),
            ),
      ),
    );

    // -------------------------------------------------------------- rows ---
    const rows = opts.journal.recent(100);
    el.appendChild(
      h(
        "div",
        { class: "jr-panel" },
        h(
          "div",
          { class: "jr-panel-head" },
          h("span", { class: "jr-panel-title", text: "Trades" }),
          h("span", { class: "jr-context", text: `${entries.length} recorded` }),
        ),
        rows.length === 0
          ? h("p", { class: "jr-fine", text: "No trades recorded." })
          : h(
              "div",
              { class: "jr-rows" },
              ...rows.map((e) => {
                const o = outcome(e);
                return h(
                  "div",
                  { class: "jr-row", "data-outcome": o },
                  h("span", { class: "jr-row-sym", text: `${e.symbol} ${e.timeframe}` }),
                  h("span", { class: "jr-row-dir", "data-dir": e.direction, text: e.direction }),
                  h("span", { class: "jr-row-px num", text: `${fmt(e.entry)} → ${e.exit === null ? "open" : fmt(e.exit)}` }),
                  h("span", { class: "jr-row-r num", "data-outcome": o, text: rTxt(realisedR(e)) }),
                  h("span", { class: "jr-row-kind", text: e.setupKind ?? "discretionary" }),
                  h("span", { class: "jr-row-adh", text: e.adherence }),
                  e.exit === null
                    ? h("button", {
                        class: "ghost-btn jr-row-btn",
                        type: "button",
                        text: "Close",
                        onclick: () => closeRow(e),
                      })
                    : h("button", {
                        class: "ghost-btn jr-row-btn",
                        type: "button",
                        text: "Delete",
                        onclick: () => {
                          opts.journal.remove(e.id);
                          render();
                        },
                      }),
                );
              }),
            ),
      ),
    );

    // ------------------------------------------------------ broker fills ---
    el.appendChild(fills);
  }

  function breakdown(title: string, groups: Map<string, ReturnType<typeof computeStats>>): HTMLElement {
    const rows = [...groups.entries()].filter(([, s]) => s.n > 0).sort((a, b) => b[1].n - a[1].n);
    if (rows.length === 0) return h("div", {}) as HTMLElement;
    return h(
      "div",
      { class: "jr-breakdown" },
      h("span", { class: "jr-stat-label", text: title }),
      ...rows.map(([key, s]) =>
        h(
          "div",
          { class: "jr-bd-row" },
          h("span", { class: "jr-bd-key", text: key }),
          h("span", { class: "jr-bd-n num", text: `${s.n}` }),
          h("span", {
            class: "jr-bd-r num",
            text: s.usable ? `${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(2)}R` : "too few",
          }),
        ),
      ),
    ) as HTMLElement;
  }

  function field(label: string, value: string, onChange: (v: string) => void): HTMLElement {
    const input = h("input", {
      class: "jr-input num",
      type: "text",
      inputmode: "decimal",
      value,
      oninput: (ev: Event) => onChange((ev.target as HTMLInputElement).value),
      /* `h` writes `value` as a PROPERTY, not an attribute — see `setFormValue`
         in dom.ts. An attribute would leave the box showing its original text
         after a re-render while the state behind it had moved on. */
    }) as HTMLInputElement;
    return h("label", { class: "jr-field" }, h("span", { class: "jr-stat-label", text: label }), input) as HTMLElement;
  }

  /* Re-render on any journal change, including one made from the Setup card or
     by a sync from another tab. */
  renderEffect(() => {
    opts.journal.entries();
    opts.journal.lastError();
    render();
  });

  return { el };
}
