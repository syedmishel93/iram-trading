/**
 * The Trading Sessions desk.
 *
 * When you trade is a decision, and it is one most terminals leave you to make
 * from a canned graphic. This desk answers it in two halves that are kept
 * visibly apart, because they have completely different standing:
 *
 *   The session clock is a CALENDAR FACT. Nothing measured it and nothing can
 *   be wrong about it except the daylight-saving approximation, which is stated.
 *
 *   The activity map is a MEASUREMENT of your own archived bars for the symbol
 *   and timeframe you are on. Every cell carries its sample count, cells below
 *   the threshold are drawn empty rather than coloured, and if nothing has been
 *   archived the map says so instead of showing a shape.
 *
 * Mixing those two would be the whole failure: a canned profile sitting beside
 * a live clock reads as though both were observations of your market.
 */

import { h } from "./dom";
import { pkWhy } from "./panelkit";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import type { BarView } from "../chart/series";
import {
  OVERLAP,
  sessionStatuses,
  sessionOpenAt,
  activityGrid,
  busiest,
  localOffsetHours,
  WEEKDAY_LABEL,
  MIN_CELL_SAMPLES,
  type ActivityGrid,
} from "../data/sessionmap";

export interface SessionsOptions {
  readonly symbol: Signal<string>;
  readonly timeframe: Signal<string>;
  /** Bars currently loaded for the chart — the same series the map measures. */
  readonly bars: () => readonly BarView[];
}

/** Re-read the clock this often. A session boundary is worth noticing. */
const TICK_MS = 30_000;

const pctRange = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—");

export function createSessions(opts: SessionsOptions) {
  const now = signal(Date.now());
  /* One timer for the whole desk. It runs regardless of which desk is showing,
     which is cheap at this interval and avoids a clock that is stale for the
     first half-minute after you switch to it. */
  setInterval(() => now.set(Date.now()), TICK_MS);

  /** UTC hours to add to get local time. Shown, never silently applied. */
  const offset = computed(() => localOffsetHours(now()));

  const grid = computed<ActivityGrid>(() => activityGrid(opts.bars()));

  const statuses = computed(() => sessionStatuses(now()));

  const inOverlap = computed(() => sessionOpenAt(OVERLAP, new Date(now()).getUTCHours()));

  const list = (cls: string, rows: () => HTMLElement[]) =>
    h("div", {
      class: cls,
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const r of rows()) el.appendChild(r);
        }),
    });

  const localLabel = (utcHour: number): string => {
    const h24 = (((utcHour + offset()) % 24) + 24) % 24;
    const whole = Math.floor(h24);
    const mins = Math.round((h24 - whole) * 60);
    return `${String(whole).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  };

  // ------------------------------------------------------------- clock ---

  const clockPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "What is open now" }),
    pkWhy(
      () =>
        `Your clock is UTC${offset() >= 0 ? "+" : ""}${offset()}. Session hours are the conventional ones and do not shift for daylight saving, so London and New York are an hour out for part of the year.`,
      "About these hours",
    ),
    list("sess-clock", () =>
      statuses().map((s) =>
        h(
          "div",
          { class: "sess-row", "data-open": String(s.open) },
          h("span", { class: "sess-dot" }),
          h("span", { class: "sess-name", text: s.session.name }),
          h("span", {
            class: "sess-window num",
            text: `${localLabel(s.session.openUtc)}–${localLabel(s.session.closeUtc)}`,
          }),
          h("span", {
            class: "sess-state",
            text: s.open
              ? `open — closes in ${s.hoursUntilChange.toFixed(1)}h`
              : `closed — opens in ${s.hoursUntilChange.toFixed(1)}h`,
          }),
        ),
      ),
    ),
    h("div", {
      class: "sess-overlap",
      "data-on": () => String(inOverlap()),
      text: () =>
        inOverlap()
          ? `London and New York are both open — ${localLabel(OVERLAP.openUtc)} to ${localLabel(OVERLAP.closeUtc)} your time.`
          : `London / New York overlap: ${localLabel(OVERLAP.openUtc)}–${localLabel(OVERLAP.closeUtc)} your time.`,
    }),
  );

  // ---------------------------------------------------------- activity ---

  const heat = h("div", {
    class: "sess-grid",
    ref: (el: HTMLElement) =>
      renderEffect(() => {
        el.textContent = "";
        const g = grid();
        if (g.cells.length === 0) return;

        /* Corner + 24 hour headers. */
        el.appendChild(h("span", { class: "sess-corner" }));
        for (let hh = 0; hh < 24; hh++) {
          const localHour = Math.floor((((hh + offset()) % 24) + 24) % 24);
          el.appendChild(
            h("span", {
              class: "sess-hhead",
              text: localHour % 3 === 0 ? String(localHour).padStart(2, "0") : "",
            }),
          );
        }

        for (let w = 0; w < 7; w++) {
          el.appendChild(h("span", { class: "sess-whead", text: WEEKDAY_LABEL[w] ?? "" }));
          for (let hh = 0; hh < 24; hh++) {
            const cell = g.cells[w * 24 + hh];
            if (!cell) {
              el.appendChild(h("span", { class: "sess-cell" }));
              continue;
            }
            /* Opacity carries the rank, and ONLY sufficient cells get any. A
               thin cell is transparent — visibly absent rather than dark, which
               would read as "quiet". */
            const style = cell.sufficient
              ? `--heat:${(0.1 + cell.rank * 0.9).toFixed(3)}`
              : "--heat:0";
            el.appendChild(
              h("span", {
                class: "sess-cell",
                "data-thin": String(!cell.sufficient),
                style,
                title: cell.sufficient
                  ? `${WEEKDAY_LABEL[w]} ${String(hh).padStart(2, "0")}:00 UTC — average range ${pctRange(cell.meanRange)}, ${cell.samples} bars`
                  : `${WEEKDAY_LABEL[w]} ${String(hh).padStart(2, "0")}:00 UTC — only ${cell.samples} bars, below the ${MIN_CELL_SAMPLES} needed`,
              }),
            );
          }
        }
      }),
  });

  const activityPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: () => `When ${opts.symbol()} actually moves` }),
    pkWhy(
      "Average high-to-low range per bar, by weekday and hour, measured from the bars loaded for this symbol and timeframe. Not a typical profile of markets in general — this instrument's own hours.",
    ),
    h("div", {
      class: "sess-empty",
      "data-on": () => String(grid().cells.length === 0),
      text: () => grid().note,
    }),
    heat,
    h("p", {
      class: "sess-note",
      "data-on": () => String(grid().cells.length > 0),
      text: () => grid().note,
    }),
    h("p", {
      class: "pf-hint",
      "data-on": () => String(grid().cells.length > 0),
      text: () => `Columns are hours in your local time (UTC${offset() >= 0 ? "+" : ""}${offset()}); the buckets themselves are UTC.`,
    }),
  );

  const busiestPanel = h(
    "section",
    { class: "dd-panel", "data-on": () => String(grid().sufficientCells > 0) },
    h("h3", { class: "pf-sub", text: "Busiest hours on record" }),
    list("sess-top", () =>
      busiest(grid(), 6).map((c) =>
        h(
          "div",
          { class: "sess-top-row" },
          h("span", { class: "sess-top-when", text: `${WEEKDAY_LABEL[c.weekday]} ${localLabel(c.hour)}` }),
          h("span", { class: "sess-top-range num", text: pctRange(c.meanRange) }),
          h("span", { class: "sess-top-n num", text: `${c.samples} bars` }),
        ),
      ),
    ),
    pkWhy(
      "Range is not direction. A busy hour is one where a stop is more likely to be reached — in either direction.",
      "What this can't tell you",
    ),
  );

  const el = h(
    "div",
    { class: "dd sess-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Sessions" }),
      h("p", {
        class: "view-sub",
        text: "Which markets are open, and when this instrument has actually moved. The clock is a calendar fact; the map below is a measurement of your own archive.",
      }),
    ),
    /*
     * PRIMARY  when THIS instrument moves, and which hours are busiest — the
     *          analysis you opened the desk for, and the part that wants width.
     * RAIL     the session clock: which markets are open right now. It is the
     *          global state the analysis is read against, and it is the same
     *          four rows whatever symbol you are on.
     *
     * 7+5 rather than 8+4: the clock's last column carries a sentence
     * ("closed — opens in 7.3h"), and at a 4-column rail that column lands
     * near 150px and wraps. The split follows the content, not a default.
     */
    h(
      "div",
      { class: "dd-layout", "data-split": "7-5" },
      h("div", { class: "dd-primary" }, activityPanel, busiestPanel),
      h("div", { class: "dd-rail" }, clockPanel),
    ),
  );

  return { el, grid };
}
