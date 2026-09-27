/**
 * Step one: what is being studied, against what, over how much history.
 *
 * The left half is the choices. The right half is what those choices COST, and
 * it is the half that makes this a study rather than a form: the joint window
 * the series actually share, the split the model is allowed to see, and how
 * many free parameters that much data can carry.
 *
 * Every figure on the right is blank until the bars are fetched, and says
 * "not checked" rather than showing a zero. A zero is a measurement.
 */

import { h } from "../dom";
import { symbolField, symbolOptions } from "../cards/symbolfield";
import { renderEffect } from "../../core/signal";
import { PANEL } from "../../backtest/universe";
import { driversFor, familyOf } from "../../data/drivers";
import { TIMEFRAMES } from "../shell/views";
import {
  HISTORY_YEARS,
  ROLE_META,
  SERIES_ROLES,
  roleForDriver,
  yearsLabel,
  type HistoryYears,
  type SeriesRole,
} from "../../study/spec";
import { spanLabel } from "../../study/window";
import type { StudyState, SeriesLoad } from "./state";

const day = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—");
const pc = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * A series' held span with its gaps cut out of it.
 *
 * Drawn rather than stated as a percentage because the SHAPE is the
 * information: a series missing every weekend and one missing six months both
 * report 71% coverage and are completely different problems.
 */
function coverageBar(load: SeriesLoad): HTMLElement {
  const wrap = h("span", { class: "sy-cov" });
  if (load.state === "unchecked") {
    wrap.appendChild(h("span", { class: "sy-cov-none", text: "not checked" }));
    return wrap;
  }
  if (load.bars === 0) {
    wrap.appendChild(h("span", { class: "sy-cov-none", text: "no bars" }));
    return wrap;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 8");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "sy-cov-track");
  const base = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  base.setAttribute("x", "0");
  base.setAttribute("y", "0");
  base.setAttribute("width", "100");
  base.setAttribute("height", "8");
  base.setAttribute("class", "sy-cov-held");
  svg.appendChild(base);

  const span = Math.max(1, load.last - load.first);
  for (const g of load.gaps) {
    const x = ((g.from - load.first) / span) * 100;
    const w = ((g.to - g.from) / span) * 100;
    if (!Number.isFinite(x) || w <= 0) continue;
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(Math.max(0, Math.min(100, x))));
    r.setAttribute("y", "0");
    r.setAttribute("width", String(Math.max(0.4, Math.min(100, w))));
    r.setAttribute("height", "8");
    r.setAttribute("class", "sy-cov-gap");
    svg.appendChild(r);
  }
  wrap.appendChild(svg);
  wrap.appendChild(
    h("span", {
      class: "sy-cov-pc",
      text: load.coverage === null ? "—" : pc(load.coverage),
      title:
        load.coverage === null
          ? "Coverage was not measured for this series."
          : `${pc(load.coverage)} of the hours this market is OPEN are covered. Weekends and holidays are not counted as missing.`,
    }),
  );
  return wrap;
}

export function createSubjectStep(state: StudyState): HTMLElement {
  const { spec } = state;

  /* ── left: the choices ─────────────────────────────────────────────────── */

  const symbolInput = symbolField({
    value: () => spec().symbol,
    options: () => symbolOptions([]),
    className: "sy-symbol",
    ariaLabel: "Instrument to study",
    onChange: (v) => {
      if (v !== "") state.patch({ symbol: v, name: `${v} ${spec.peek().timeframe}` });
    },
  });

  const tfSelect = h(
    "select",
    {
      class: "sy-select",
      "aria-label": "Bar size",
      value: () => spec().timeframe,
      onchange: (e) => state.patch({ timeframe: (e.target as HTMLSelectElement).value }),
    },
    ...TIMEFRAMES.map((t) => h("option", { value: t, text: t })),
  );

  const horizonInput = h("input", {
    class: "sy-num",
    type: "number",
    min: "1",
    step: "1",
    "aria-label": "Horizon in bars",
    value: () => String(spec().horizon),
    onchange: (e) => {
      const v = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value)));
      if (Number.isFinite(v)) state.patch({ horizon: v });
    },
  });

  const contextBody = h("div", { class: "sy-rows" });
  renderEffect(() => {
    const loads = state.loads();
    const rows = spec().context;
    /* THE SUBJECT GETS A ROW TOO, and it is not decoration. `jointWindow`
       treats the subject exactly like a column when deciding where the window
       starts, and comments that "the archive only holds eighteen months of the
       thing you are studying" is the single most useful version of the
       shortfall sentence. A table that shows every series EXCEPT that one
       hides the most likely cause. It has no role control and no remove
       button, because it is the subject. */
    const subjectLoad = loads.find((l) => l.symbol === spec().symbol);
    const subjectRow = h(
      "div",
      { class: "sy-row sy-row-subject", "data-state": subjectLoad?.state ?? "unchecked" },
      h(
        "div",
        { class: "sy-row-id" },
        h("span", { class: "sy-row-sym", text: spec().symbol }),
        h("span", { class: "sy-row-label", text: "the subject" }),
      ),
      h("span", { class: "sy-row-fixed", text: "Subject" }),
      h("div", { class: "sy-row-cov" }, coverageBar(subjectLoad ?? blankLoad(spec().symbol, spec().symbol, "driver"))),
      h("div", {
        class: "sy-row-bars",
        text: subjectLoad === undefined || subjectLoad.state === "unchecked" ? "—" : subjectLoad.bars.toLocaleString(),
      }),
      h("div", { class: "sy-row-note", text: subjectLoad?.note ?? "" }),
      h("span", {}),
    );
    contextBody.replaceChildren(
      subjectRow,
      ...rows.map((c) => {
        const load = loads.find((l) => l.symbol === c.symbol);
        return h(
          "div",
          { class: "sy-row", "data-state": load?.state ?? "unchecked" },
          h(
            "div",
            { class: "sy-row-id" },
            h("span", { class: "sy-row-sym", text: c.symbol }),
            h("span", { class: "sy-row-label", text: c.label }),
          ),
          h(
            "select",
            {
              class: "sy-select sy-role",
              "aria-label": `Role of ${c.symbol}`,
              value: c.role,
              title: ROLE_META[c.role].blurb,
              onchange: (e) => state.setRole(c.symbol, (e.target as HTMLSelectElement).value as SeriesRole),
            },
            ...SERIES_ROLES.map((r) =>
              h("option", { value: r, text: ROLE_META[r].label, selected: r === c.role ? "" : undefined }),
            ),
          ),
          h("div", { class: "sy-row-cov" }, coverageBar(load ?? blankLoad(c.symbol, c.label, c.role))),
          h("div", {
            class: "sy-row-bars",
            text: load === undefined || load.state === "unchecked" ? "—" : load.bars.toLocaleString(),
          }),
          h("div", { class: "sy-row-note", text: load?.note ?? "" }),
          h("button", {
            class: "sy-x",
            type: "button",
            title: `Remove ${c.symbol} from this study`,
            "aria-label": `Remove ${c.symbol}`,
            text: "×",
            onclick: () => state.removeSeries(c.symbol),
          }),
        );
      }),
    );
    if (rows.length === 0) {
      contextBody.appendChild(
        h("div", {
          class: "sy-empty",
          text: `Nothing is being measured against ${spec().symbol}. That is a legitimate study — the instrument on its own history — and it rules out every method that needs a second series.`,
        }),
      );
    }
  });

  const suggestions = h("div", { class: "sy-suggest" });
  renderEffect(() => {
    const s = spec();
    const have = new Set(s.context.map((c) => c.symbol.toUpperCase()));
    have.add(s.symbol.toUpperCase());
    /* Two sources, in this order: what `drivers.ts` declares for this family,
       because those come with a stated mechanism; then the cross-market panel,
       which does not, and is offered second for that reason. */
    const hasFamily = familyOf(s.symbol) !== null;
    const declared = driversFor(s.symbol)
      .filter((d) => !have.has(d.symbol.toUpperCase()))
      .map((d) => ({ symbol: d.symbol, label: d.label, why: d.why, role: roleForDriver(s.symbol, d.symbol, d.role) }));
    const panel = PANEL.filter(
      (m) => !have.has(m.symbol.toUpperCase()) && !declared.some((d) => d.symbol === m.symbol),
    ).map((m) => ({ symbol: m.symbol, label: m.label, why: m.why, role: "control" as SeriesRole }));

    const all = [...declared, ...panel];
    suggestions.replaceChildren(
      h("div", {
        class: "sy-suggest-head",
        /* THE SENTENCE IS ABOUT THE SYMBOL, NOT ABOUT WHAT IS LEFT TO ADD.
           Derived from `declared.length` it read "No driver set is declared
           for BTCUSDT" on a screen showing all five of BTCUSDT's declared
           drivers already in the table — a false statement about the
           instrument, produced by measuring the remainder. `familyOf` is the
           fact being reported, so `familyOf` is what it asks. */
        text: hasFamily
          ? declared.length > 0
            ? `Declared for ${s.symbol}, with the mechanism stated`
            : `Every series declared for ${s.symbol} is already in. Below is the cross-market panel, offered without a stated channel.`
          : `No driver set is declared for ${s.symbol}, so nothing is being guessed about what moves it. Below is the cross-market panel, offered without a stated channel.`,
      }),
      ...all.map((d) =>
        h(
          "button",
          {
            class: "sy-chip",
            type: "button",
            title: `${d.why}\n\nAdded as: ${ROLE_META[d.role].label}`,
            onclick: () => state.addSeries({ symbol: d.symbol, label: d.label, role: d.role, why: d.why }),
          },
          h("span", { class: "sy-chip-sym", text: d.symbol }),
          h("span", { class: "sy-chip-role", text: ROLE_META[d.role].label }),
        ),
      ),
    );
    if (all.length === 0) suggestions.appendChild(h("span", { class: "sy-dim", text: "Everything suggested is already in." }));
  });

  const customInput = h("input", {
    class: "sy-symbol sy-symbol-sm",
    type: "text",
    placeholder: "Add any symbol…",
    spellcheck: "false",
    "aria-label": "Add a series by symbol",
    onkeydown: (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key !== "Enter") return;
      const el = ev.target as HTMLInputElement;
      const v = el.value.trim().toUpperCase();
      if (v === "") return;
      state.addSeries({ symbol: v, label: v, role: "control", why: "" });
      el.value = "";
    },
  });

  const yearsRow = h(
    "div",
    { class: "sy-seg" },
    ...[...HISTORY_YEARS, "max" as const].map((y: HistoryYears) =>
      h("button", {
        class: () => `sy-seg-btn${spec().years === y ? " is-on" : ""}`,
        type: "button",
        text: yearsLabel(y),
        onclick: () => state.patch({ years: y }),
      }),
    ),
  );

  const checkBtn = h("button", {
    class: "sy-primary",
    type: "button",
    text: () => (state.busy() ? state.progress() || "working…" : state.checked() ? "Check again" : "Check the window"),
    disabled: () => (state.busy() ? "" : undefined),
    onclick: () => void state.check(),
  });

  /* ── right: what the data can carry ────────────────────────────────────── */

  const windowPanel = h("div", { class: "sy-panel" });
  renderEffect(() => {
    const w = state.window();
    const rows = state.estimatedRows();
    const sp = state.split();
    const b = state.budget();
    const kids: HTMLElement[] = [h("h4", { class: "sy-panel-h", text: "What this data can carry" })];

    if (!state.checked()) {
      kids.push(
        h("p", {
          class: "sy-dim",
          text: "Nothing has been fetched yet, so there is nothing measured to show. Press “Check the window”.",
        }),
      );
      windowPanel.replaceChildren(...kids);
      return;
    }
    if (state.busy()) {
      kids.push(h("p", { class: "sy-dim", text: state.progress() || "fetching…" }));
      windowPanel.replaceChildren(...kids);
      return;
    }
    if (w === null) {
      kids.push(h("p", { class: "sy-refuse", text: `No bars were loaded for ${spec().symbol}.` }));
      windowPanel.replaceChildren(...kids);
      return;
    }
    if (w.refusal !== null) {
      kids.push(h("p", { class: "sy-refuse", text: w.refusal }));
      windowPanel.replaceChildren(...kids);
      return;
    }

    kids.push(
      stat("Joint window", spanLabel(w.spanMs), `${day(w.from)} → ${day(w.to)}`),
      stat("Aligned rows", `≈ ${rows.toLocaleString()}`, "An estimate. The join drops rows where a series was stale, and the report gives the real number."),
    );

    if (w.shortfall !== null) {
      kids.push(h("div", { class: "sy-callout", text: w.shortfall }));
    }

    const gone = state.absent();
    if (gone.length > 0) {
      kids.push(
        h("div", {
          class: "sy-callout",
          text:
            `${gone.map((g) => g.symbol).join(", ")} loaded no bars and ${gone.length === 1 ? "is" : "are"} not in this window at all. ` +
            `The figures above are about the series that DID load. ${
              gone.some((g) => g.role === "driver")
                ? "One of them is marked Driver, so every method that needs something to lead is short by one."
                : "Remove them, or download their history, before treating this as the study you configured."
            }`,
        }),
      );
    }

    if (sp.refusal !== null) {
      kids.push(h("div", { class: "sy-refuse", text: sp.refusal }));
    } else {
      kids.push(splitBar(sp.train.bars, sp.validate.bars, sp.holdout.bars, sp.embargo));
      kids.push(
        stat(
          "Free parameters supported",
          `≈ ${b.budget}`,
          b.working,
        ),
      );
    }

    windowPanel.replaceChildren(...kids);
  });

  const problemsPanel = h("div", { class: "sy-panel" });
  renderEffect(() => {
    const ps = state.problems().filter((p) => p.field !== "methods");
    if (ps.length === 0) {
      problemsPanel.replaceChildren();
      return;
    }
    problemsPanel.replaceChildren(
      h("h4", { class: "sy-panel-h", text: "Before this runs" }),
      ...ps.map((p) => h("div", { class: "sy-issue", "data-sev": p.severity, text: p.text })),
    );
  });

  return h(
    "div",
    { class: "sy-step sy-subject" },
    h(
      "div",
      { class: "sy-main" },

      section(
        "1 · The subject",
        "The instrument the question is about. It is never one of the columns.",
        h(
          "div",
          { class: "sy-field-row" },
          field("Instrument", symbolInput),
          field("Bars", tfSelect),
          field("Horizon", horizonInput, "How many bars ahead the question looks. It decides what a label means and how many independent observations you really have."),
        ),
      ),

      section(
        "2 · What it is measured against",
        "Each series gets a role, and the role changes what happens to it. A regime proxy slices the result; it does not enter the model.",
        h(
          "div",
          { class: "sy-table" },
          h(
            "div",
            { class: "sy-row sy-row-head" },
            h("div", { text: "Series" }),
            h("div", { text: "Role" }),
            h("div", { text: "Coverage" }),
            h("div", { text: "Bars" }),
            h("div", { text: "Source" }),
            h("div", { text: "" }),
          ),
          contextBody,
        ),
        suggestions,
        customInput,
      ),

      section(
        "3 · How much history",
        "The model is fitted on the oldest part and judged on the newest. The split happens before anything looks at anything.",
        yearsRow,
        checkBtn,
      ),
    ),
    h("aside", { class: "sy-side" }, windowPanel, problemsPanel),
  );
}

function blankLoad(symbol: string, label: string, role: SeriesRole): SeriesLoad {
  return {
    symbol,
    label,
    role,
    state: "unchecked",
    bars: 0,
    first: 0,
    last: 0,
    gaps: [],
    coverage: null,
    note: "not checked",
  };
}

function section(title: string, blurb: string, ...body: HTMLElement[]): HTMLElement {
  return h(
    "section",
    { class: "sy-sec" },
    h("h3", { class: "sy-sec-h", text: title }),
    h("p", { class: "sy-sec-b", text: blurb }),
    ...body,
  );
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = h("label", { class: "sy-field" }, h("span", { class: "sy-field-l", text: label }), control);
  if (hint !== undefined) wrap.title = hint;
  return wrap;
}

function stat(label: string, value: string, note?: string): HTMLElement {
  const el = h(
    "div",
    { class: "sy-stat" },
    h("span", { class: "sy-stat-l", text: label }),
    h("span", { class: "sy-stat-v", text: value }),
  );
  if (note !== undefined) el.appendChild(h("span", { class: "sy-stat-n", text: note }));
  return el;
}

/**
 * Train, embargo, validate, embargo, holdout — to scale.
 *
 * The embargoes are drawn, not described. They are usually a sliver, and a
 * sliver is the right impression: the point is that they exist and that the
 * segments do not touch, not that they are large.
 */
function splitBar(train: number, validate: number, holdout: number, embargo: number): HTMLElement {
  const total = train + validate + holdout + embargo * 2;
  const w = (n: number): string => `${((n / Math.max(1, total)) * 100).toFixed(3)}%`;
  return h(
    "div",
    { class: "sy-split" },
    h(
      "div",
      { class: "sy-split-bar" },
      h("div", { class: "sy-split-seg", "data-seg": "train", style: `width:${w(train)}`, title: `Train — ${train.toLocaleString()} bars. The only bars a fit may use.` }),
      h("div", { class: "sy-split-seg", "data-seg": "gap", style: `width:${w(embargo)}`, title: `${embargo} bars discarded: the label of the last training bar reaches into validate, and the first validate bars are still correlated with the last training ones.` }),
      h("div", { class: "sy-split-seg", "data-seg": "validate", style: `width:${w(validate)}`, title: `Validate — ${validate.toLocaleString()} bars. Used to choose between fitted models.` }),
      h("div", { class: "sy-split-seg", "data-seg": "gap", style: `width:${w(embargo)}`, title: `${embargo} bars discarded.` }),
      h("div", { class: "sy-split-seg", "data-seg": "holdout", style: `width:${w(holdout)}`, title: `Holdout — ${holdout.toLocaleString()} bars. Sealed. Nothing in a study run touches these.` }),
    ),
    h(
      "div",
      { class: "sy-split-key" },
      h("span", { "data-seg": "train", text: `Train ${train.toLocaleString()}` }),
      h("span", { "data-seg": "validate", text: `Validate ${validate.toLocaleString()}` }),
      h("span", { "data-seg": "holdout", text: `Holdout ${holdout.toLocaleString()} — sealed` }),
    ),
  );
}
