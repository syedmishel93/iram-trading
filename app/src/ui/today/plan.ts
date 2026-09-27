/**
 * "Your plan" — the operator's half of the Today workspace.
 *
 * Three things, and only one of them is enforced by something other than the
 * operator's memory:
 *   - the FOCUS LIST, suggested from the scan (see `focus.ts`) and edited here;
 *   - three LIMITS, which are the server risk governor's own settings —
 *     committing writes them to `/svc/risk/config`, and `/svc/risk/state`
 *     checks every new trade against that same table;
 *   - the COMMIT, stamped with its time and kept in the browser KV store under
 *     `today.plan`, so the plan reads back as decided rather than as a form.
 *
 * WHAT IT REFUSES
 * - The limits are prefilled only from the governor's GET. When the service
 *   is not answering, the fields stay empty and Commit is disabled with the
 *   reason: a prefilled "3 trades" that the governor never held would be a
 *   fabricated setting.
 * - "Committed" is shown only after the server's answer holds the values sent
 *   (`saveRiskConfig` checks). A plan that says it is enforced when it is not
 *   is worse than no plan.
 */

import { h } from "../dom";
import { symbolField, symbolOptions } from "../cards/symbolfield";
import { computed, renderEffect, signal, type ReadSignal, type Signal } from "../../core/signal";
import { pkEmpty, pkRows, pkWhy } from "../panelkit";
import {
  loadRiskConfig,
  saveRiskConfig,
  validateLimits,
  LIMIT_BOUNDS,
  type LimitField,
  type RiskConfigResult,
  type RiskLimits,
} from "../../data/riskconfig";
import {
  addFocus,
  applyFocus,
  clockTime,
  dayKey,
  dropFocus,
  readPlan,
  writePlan,
  NO_EDITS,
  type FocusSuggestion,
  type SavedPlan,
} from "./focus";
import { todayCard } from "./card";
import type { KV } from "../../store/kv";

export interface PlanOptions {
  /** Where the focus list starts. Recomputed as the scan re-ranks. */
  readonly suggestion: () => FocusSuggestion;
  readonly kv: KV;
  /** The shell's clock. */
  readonly now: () => number;
  /** Injected for tests; the real client by default. */
  readonly loadConfig?: () => Promise<RiskConfigResult>;
  readonly saveConfig?: (limits: RiskLimits) => Promise<RiskConfigResult>;
}

type ServerState = { readonly state: "loading" } | RiskConfigResult;

/** Why Commit cannot be pressed right now, or null when it can. PURE. */
export function commitBlock(server: ServerState, limitsOk: boolean, busy: boolean): string | null {
  if (busy) return "Saving to the risk governor…";
  if (server.state === "loading") return "Reading the risk governor's limits…";
  if (server.state === "offline") return `Can't commit: ${server.reason}`;
  if (!limitsOk) return "Fix the limits above to commit.";
  return null;
}

const FIELDS: readonly { key: LimitField; label: string; step: string }[] = [
  { key: "maxTradesPerDay", label: "Max trades", step: "1" },
  { key: "maxDailyLossR", label: "Max loss (R)", step: "0.25" },
  { key: "maxRiskPerTradePct", label: "Risk per trade (%)", step: "0.25" },
];

function liveList(cls: string, rows: () => readonly HTMLElement[]): HTMLElement {
  const host = h("div", { class: cls }) as HTMLElement;
  renderEffect(() => {
    host.replaceChildren(...rows());
  });
  return host;
}

export function createPlan(opts: PlanOptions) {
  const load = opts.loadConfig ?? loadRiskConfig;
  const save = opts.saveConfig ?? saveRiskConfig;

  const stored = signal<SavedPlan>(readPlan(opts.kv, opts.now()));
  /* A terminal left open past midnight must not show yesterday's commit as
     today's. Re-derived from the clock rather than trusted from the load. */
  const plan = computed<SavedPlan>(() => {
    const p = stored();
    const day = dayKey(opts.now());
    return p.day === day ? p : { day, edits: NO_EDITS, committed: null };
  });

  const server = signal<ServerState>({ state: "loading" });
  const editing = signal<boolean>(plan.peek().committed === null);
  const busy = signal(false);
  const status = signal("");
  const addText = signal("");
  const addError = signal("");
  const showErrors = signal(false);
  const inputs: Record<LimitField, Signal<string>> = {
    maxTradesPerDay: signal(""),
    maxDailyLossR: signal(""),
    maxRiskPerTradePct: signal(""),
  };
  let touched = false;

  const suggested = computed<readonly string[]>(() => opts.suggestion().symbols);
  const liveFocus = computed<readonly string[]>(() => applyFocus(suggested(), plan().edits));
  /** The list the rest of the workspace reads: the committed one while committed. */
  const focus: ReadSignal<readonly string[]> = computed(() => {
    const c = plan().committed;
    return c !== null && !editing() ? c.focus : liveFocus();
  });

  const check = computed(() =>
    validateLimits({
      maxTradesPerDay: inputs.maxTradesPerDay(),
      maxDailyLossR: inputs.maxDailyLossR(),
      maxRiskPerTradePct: inputs.maxRiskPerTradePct(),
    }),
  );
  const blocked = computed(() => commitBlock(server(), check().ok, busy()));

  const persist = (next: SavedPlan): string | null => {
    stored.set(next);
    const w = writePlan(opts.kv, next);
    return w.ok ? null : w.error;
  };

  const setEdits = (edits: SavedPlan["edits"]): void => {
    const err = persist({ ...plan.peek(), edits });
    if (err !== null) status.set(`Couldn't save the list in this browser: ${err}`);
  };

  const add = (): void => {
    const r = addFocus(suggested.peek(), plan.peek().edits, addText.peek());
    if (!r.ok) {
      addError.set(r.reason);
      return;
    }
    addError.set("");
    addText.set("");
    setEdits(r.edits);
  };

  const commit = async (): Promise<void> => {
    showErrors.set(true);
    const c = check.peek();
    if (!c.ok || blocked.peek() !== null) return;
    busy.set(true);
    status.set("");
    try {
      const r = await save(c.limits);
      if (r.state === "offline") {
        status.set(`Not committed. ${r.reason}`);
        return;
      }
      server.set(r);
      const err = persist({
        ...plan.peek(),
        committed: { at: opts.now(), focus: [...liveFocus.peek()], limits: r.limits },
      });
      editing.set(false);
      status.set(
        err === null
          ? ""
          : `The governor has the limits, but this browser couldn't keep the plan: ${err}`,
      );
    } finally {
      busy.set(false);
    }
  };

  const ready = load().then((r) => {
    server.set(r);
    if (r.state === "ok" && !touched) {
      inputs.maxTradesPerDay.set(String(r.limits.maxTradesPerDay));
      inputs.maxDailyLossR.set(String(r.limits.maxDailyLossR));
      inputs.maxRiskPerTradePct.set(String(r.limits.maxRiskPerTradePct));
    }
  });

  // ───────────────────────────────────────────────────────── edit view ───

  const chips = liveList("td-tags", () => {
    const list = liveFocus();
    if (list.length === 0) return [pkEmpty("empty", "No symbols on the list yet.")];
    return list.map(
      (sym) =>
        h(
          "span",
          { class: "td-tag" },
          h("span", { class: "td-tag-sym", text: sym }),
          h("button", {
            class: "td-tag-x",
            type: "button",
            "aria-label": `Drop ${sym}`,
            title: `Drop ${sym}`,
            text: "×",
            onclick: () => setEdits(dropFocus(plan.peek().edits, sym)),
          }),
        ) as HTMLElement,
    );
  });

  const addRow = h(
    "div",
    { class: "td-add" },
    symbolField({
      value: () => addText(),
      options: () => symbolOptions([]),
      className: "field-input td-add-in",
      placeholder: "Symbol, e.g. XAUUSD",
      ariaLabel: "Add a symbol to the focus list",
      /* THE "+ add" BUTTON READS `addText`, so it has to track every
         keystroke — the picker's own commit is Enter or a row click, and a
         button is a third path. Dropping this left the button doing nothing. */
      onInput: (raw) => {
        addText.set(raw);
        addError.set("");
      },
      /* `add` reads `addText` rather than taking an argument, so the commit
         sets it first. Signals here are synchronous, so `add` sees it. */
      onChange: (sym) => {
        addError.set("");
        addText.set(sym);
        add();
      },
    }),
    h("button", { class: "ghost-btn tiny", type: "button", text: "+ add", onclick: add }),
  );

  const limitFields = h(
    "div",
    { class: "td-limits" },
    ...FIELDS.map((f) => {
      const id = `td-lim-${f.key}`;
      const b = LIMIT_BOUNDS[f.key];
      const err = (): string => {
        const c = check();
        return showErrors() && !c.ok ? (c.errors[f.key] ?? "") : "";
      };
      return h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", for: id, text: f.label }),
        h("input", {
          id,
          class: "field-input num",
          type: "number",
          inputmode: "decimal",
          step: f.step,
          min: String(b.min),
          max: String(b.max),
          value: () => inputs[f.key](),
          "aria-invalid": () => (err() === "" ? "false" : "true"),
          oninput: (e: Event) => {
            touched = true;
            showErrors.set(true);
            inputs[f.key].set((e.target as HTMLInputElement).value);
          },
        }),
        h("span", { class: "field-hint td-err", "data-show": () => String(err() !== ""), text: err }),
      );
    }),
  );

  const editView = h(
    "div",
    { class: "td-plan-edit", hidden: () => !editing() },
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label", text: "Focus list — AI suggests, you keep or drop" }),
      h("p", { class: "td-note", text: () => opts.suggestion().note }),
      chips,
      addRow,
      h("span", { class: "field-hint td-err", "data-show": () => String(addError() !== ""), text: addError }),
    ),
    limitFields,
    h("p", { class: "td-enforce", text: "The risk governor enforces these for the rest of the day." }),
    pkWhy(
      "Commit writes max trades per day, max daily loss in R and max risk per trade to the terminal's risk governor. It checks every new trade against them, and they stay in force until you change them. The focus list and the commit time are kept in this browser only.",
      "Why?",
    ),
    h("button", {
      class: "primary-btn td-commit",
      type: "button",
      disabled: () => blocked() !== null,
      text: () => (busy() ? "Committing…" : "Commit today's plan"),
      onclick: () => void commit(),
    }),
    h("p", { class: "td-block", "data-show": () => String(blocked() !== null), text: () => blocked() ?? "" }),
  );

  // ──────────────────────────────────────────────────── committed view ───

  const committedView = liveList("td-plan-done", () => {
    const c = plan().committed;
    if (c === null || editing()) return [];
    return [
      h(
        "div",
        { class: "td-done-head" },
        h("span", { class: "td-done-at", text: `Committed at ${clockTime(c.at)} — edit to change` }),
        h("button", { class: "ghost-btn tiny", type: "button", text: "Edit", onclick: () => editing.set(true) }),
      ) as HTMLElement,
      c.focus.length === 0
        ? pkEmpty("empty", "No focus symbols in this plan.")
        : (h(
            "div",
            { class: "td-tags" },
            ...c.focus.map((s) => h("span", { class: "td-tag", "data-fixed": "true" }, h("span", { class: "td-tag-sym", text: s }))),
          ) as HTMLElement),
      pkRows([
        { label: "Max trades", value: String(c.limits.maxTradesPerDay) },
        { label: "Max loss", value: `${c.limits.maxDailyLossR}R` },
        { label: "Risk per trade", value: `${c.limits.maxRiskPerTradePct}%` },
      ]),
      h("p", { class: "td-enforce", text: "The risk governor enforces these for the rest of the day." }) as HTMLElement,
    ];
  });

  const el = todayCard(
    "Your plan",
    "you",
    "td-plan",
    committedView,
    editView,
    h("p", { class: "td-status", "data-show": () => String(status() !== ""), text: status }),
  );

  return { el, focus, ready, commit, server: server as ReadSignal<ServerState> };
}
