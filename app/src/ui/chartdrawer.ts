/**
 * The drawer under the chart: what is ON the chart, a question to the analyst,
 * what you are IN, and what fired today — without leaving the chart.
 *
 * COLLAPSED BY DEFAULT, AND COLLAPSED IS ONE ROW. Four tabs, each carrying its
 * count, and an Expand button. The chart is the product; the drawer earns its
 * body only when asked. Clicking a tab opens it on that tab. Open/close is
 * instant: it is met many times a day, and the motion rules say frequency
 * decides whether something animates at all.
 *
 * EVERY TAB IS A VIEW OVER DATA THAT ALREADY EXISTS. The drawer owns no fact:
 *   Objects    — the shell's detector selection and detections, and the
 *                drawing store. Toggling writes the shell's own signal.
 *   Ask        — the analyst's conversation session, the SAME one the Analyst
 *                desk drives, so a question asked here is in that transcript.
 *   Positions  — the broker model's positions result, all four arms of it.
 *   Alerts log — the alert service's rows and the signal service's fires.
 * The only state held here is the alerts log's last answer, because nothing
 * else in the shell asks the signal route.
 *
 * REFUSALS. "No positions" and "could not ask MT5" are different sentences, and
 * the tab label says "—" for the second, never 0. A detector that is switched
 * off shows a dash, not a zero: it did not look, so it cannot say it found
 * nothing. An alert log that reached one service and not the other names what
 * it lost and labels its count as a floor.
 */

import { h } from "./dom";
import { pkEmpty, pkNum, pkWhy } from "./panelkit";
import { computed, effect, onCleanup, signal, untrack, type Signal } from "../core/signal";
import { DETECTORS, DETECTOR_FOR_KIND, FAMILY_LABEL, type DetectorFamily, type DetectorId } from "../detect/index";
import type { Detection } from "../detect/index";
import type { DrawingStore } from "../draw/store";
import { DRAW_KINDS, type Drawing } from "../draw/model";
import type { TranscriptEntry } from "../agent/session";
import type { createAnalystModel } from "./model/analyst";
import type { createBrokerModel } from "./model/broker";
import { brokerLine, directionOf, hasStop, type BrokerPosition, type BrokerResult } from "../data/broker";
import { loadAlerts, type AlertsResult } from "../data/pricealerts";
import { loadSigFired, type SigFiredResult } from "../data/sigfired";
import { isShown, onShown } from "./cards/shown";

/* ------------------------------------------------------------------ API --- */

export type DrawerTab = "objects" | "ask" | "positions" | "alerts";
export const DRAWER_TABS: readonly DrawerTab[] = ["objects", "ask", "positions", "alerts"];

const TAB_LABEL: Readonly<Record<DrawerTab, string>> = {
  objects: "Objects",
  ask: "Ask the AI",
  positions: "Positions",
  alerts: "Alerts log",
};

export interface ChartDrawerDeps {
  readonly open: Signal<boolean>;
  readonly tab: Signal<DrawerTab>;
  readonly symbol: () => string;
  readonly timeframe: () => string;
  readonly detectors: Signal<DetectorId[]>;
  readonly detections: () => readonly Detection[];
  readonly drawStore: DrawingStore;
  readonly session: ReturnType<typeof createAnalystModel>["session"];
  readonly onOpenAnalyst: () => void;
  readonly broker: ReturnType<typeof createBrokerModel>;
  readonly fmtPx: (v: number) => string;
  /**
   * Why the analyst is answering the way it is, or "" — the analyst model's
   * `providerFallback`. OPTIONAL, and the one addition to the agreed shape:
   * the session itself cannot say whether a model is configured (that lives
   * in the analyst model beside it), and without this the tab could only
   * find out after the operator had asked and been answered by the template.
   */
  readonly providerNote?: () => string;
}

/** Pure. Anything that is not one of the four tabs becomes "objects". */
export function sanitiseDrawerTab(v: unknown): DrawerTab {
  return typeof v === "string" && (DRAWER_TABS as readonly string[]).includes(v) ? (v as DrawerTab) : "objects";
}

/** How often the alerts log is re-read while it is open and on screen. */
export const ALERTS_LOG_POLL_MS = 60_000;

/* -------------------------------------------------------------- objects --- */

/** Detections per detector, through `DETECTOR_FOR_KIND`. Detectors with none are absent. */
export function detectorCounts(detections: readonly Detection[]): Map<DetectorId, number> {
  const out = new Map<DetectorId, number>();
  for (const d of detections) {
    const id = DETECTOR_FOR_KIND[d.kind];
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Families in the order DETECTORS offers them, each only if it has a detector. */
export function detectorFamilies(): { family: DetectorFamily; ids: DetectorId[] }[] {
  const out: { family: DetectorFamily; ids: DetectorId[] }[] = [];
  for (const d of DETECTORS) {
    let g = out.find((x) => x.family === d.family);
    if (g === undefined) {
      g = { family: d.family, ids: [] };
      out.push(g);
    }
    g.ids.push(d.id);
  }
  return out;
}

const kindLabel = (d: Drawing): string => DRAW_KINDS.find((k) => k.id === d.kind)?.label ?? d.kind;

/**
 * One line describing a drawing: what it is and where it sits.
 *
 * A vertical line is a TIME, and its anchor price means nothing (the drawing
 * model says so), so it is described by its date. Everything else by its
 * anchor prices in the order they were placed.
 */
export function drawingLine(d: Drawing, fmtPx: (v: number) => string): { kind: string; where: string } {
  const kind = kindLabel(d);
  if (d.kind === "vline") {
    const a = d.anchors[0];
    return {
      kind,
      where: a === undefined ? "—" : new Date(a.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    };
  }
  const prices = d.anchors.map((a) => fmtPx(a.p)).join(" → ");
  const where = d.kind === "text" && d.text !== undefined && d.text !== "" ? `“${d.text}” at ${prices}` : prices;
  return { kind, where: where === "" ? "—" : where };
}

/* ------------------------------------------------------------ positions --- */

export interface PositionRow {
  readonly ticket: number;
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly lots: string;
  readonly entry: string;
  readonly stop: string;
  readonly stopTone: "attn" | "";
  readonly target: string;
  readonly pnl: string;
  readonly pnlTone: "pos" | "neg" | "";
  readonly title: string;
}

export type PositionView =
  | { readonly state: "loading"; readonly text: string }
  | { readonly state: "ok"; readonly rows: readonly PositionRow[] }
  | { readonly state: "refused"; readonly text: string; readonly why: string };

const signed = (v: number): string => `${v > 0 ? "+" : ""}${pkNum(v, { decimals: 2 })}`;

/**
 * The positions table, or the reason there is none.
 *
 * Pure. `fmt` formats a price for its own symbol — the chart's formatter is
 * only right for the chart's symbol. A stop of ZERO is MT5 for "no stop" and
 * goes through `hasStop`, never `sl > 0` here. Lots are MT5's unit and are
 * labelled so. A refused broker is NEVER an empty table: offline is not flat.
 */
export function positionRows(
  r: BrokerResult<readonly BrokerPosition[]> | null,
  fmt: (symbol: string, v: number) => string = (_s, v) => pkNum(v),
): PositionView {
  if (r === null) return { state: "loading", text: "Asking MT5 for your positions…" };
  switch (r.state) {
    case "ok":
      return {
        state: "ok",
        rows: r.value.map((p) => {
          const pnl = p.profit;
          return {
            ticket: p.ticket,
            symbol: p.symbol,
            side: directionOf(p) === "long" ? "Buy" : "Sell",
            lots: pkNum(p.volume, { decimals: 2 }),
            entry: fmt(p.symbol, p.price_open),
            stop: hasStop(p) ? fmt(p.symbol, p.sl) : "none",
            stopTone: hasStop(p) ? "" : "attn",
            target: Number.isFinite(p.tp) && p.tp > 0 ? fmt(p.symbol, p.tp) : "none",
            pnl: Number.isFinite(pnl) ? signed(pnl) : "—",
            pnlTone: !Number.isFinite(pnl) || pnl === 0 ? "" : pnl > 0 ? "pos" : "neg",
            title: `Ticket ${p.ticket} · opened ${new Date(p.time_ms).toLocaleString()} · swap ${Number.isFinite(p.swap) ? signed(p.swap) : "—"} (not in P&L)`,
          };
        }),
      };
    case "unavailable":
      return {
        state: "refused",
        text: "MT5 cannot run on this machine, so there are no live positions here.",
        why: brokerLine(r),
      };
    case "disconnected":
      return { state: "refused", text: "MT5 is not connected — positions appear here live once it is.", why: brokerLine(r) };
    case "offline":
      return {
        state: "refused",
        text: "The terminal's backend is not answering, so your positions are unknown.",
        why: brokerLine(r),
      };
  }
}

/** The tab's count: the number when the broker answered, "—" when it did not. */
export function positionsCount(r: BrokerResult<readonly BrokerPosition[]> | null): string {
  return r !== null && r.state === "ok" ? String(r.value.length) : "—";
}

/* --------------------------------------------------------------- alerts --- */

export interface FiredRow {
  /** Unix SECONDS. Both sources store seconds. */
  readonly at: number;
  readonly what: string;
  readonly source: "Price alert" | "Signal";
  readonly tone: "pos" | "neg" | "";
}

export type FiredLog =
  | { readonly state: "offline"; readonly reason: string }
  | {
      readonly state: "ok";
      readonly rows: readonly FiredRow[];
      /** Sources that did not answer: the rows are a FLOOR when this is not empty. */
      readonly missing: readonly string[];
    };

/** Local midnight of the day containing `nowMs`, and the next one. */
function localDay(nowMs: number): { start: number; end: number } {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  d.setDate(d.getDate() + 1);
  return { start, end: d.getTime() };
}

/**
 * What fired TODAY (the operator's local day), newest first.
 *
 * Pure. Price alerts count once they have a `fired` time; signals by
 * `fired_at`. Both are Unix seconds. One source answering and the other not is
 * reported as such — the rows that came back plus the name of what is missing
 * — never as a complete list.
 */
export function firedToday(alerts: AlertsResult, signals: SigFiredResult, nowMs: number): FiredLog {
  if (alerts.state === "offline" && signals.state === "offline") {
    return { state: "offline", reason: `${alerts.reason} ${signals.reason}` };
  }
  const { start, end } = localDay(nowMs);
  const today = (sec: number): boolean => sec * 1000 >= start && sec * 1000 < end;
  const rows: FiredRow[] = [];
  const missing: string[] = [];
  if (alerts.state === "ok") {
    for (const a of alerts.value) {
      if (a.fired === null || !today(a.fired)) continue;
      rows.push({ at: a.fired, what: `${a.sym} ${a.op} ${pkNum(a.price)}`, source: "Price alert", tone: "" });
    }
  } else {
    missing.push("price alerts");
  }
  if (signals.state === "ok") {
    for (const s of signals.value) {
      if (!today(s.fired_at)) continue;
      const side = s.dir === "LONG" ? "long" : "short";
      const tf = s.tf === "" ? "" : ` ${s.tf}`;
      const q = s.q === null ? "" : ` · quality ${Math.round(s.q)}`;
      rows.push({
        at: s.fired_at,
        what: `${s.sym}${tf} ${side} — ${s.strategy}${q}`,
        source: "Signal",
        tone: s.dir === "LONG" ? "pos" : "neg",
      });
    }
  } else {
    missing.push("signals");
  }
  rows.sort((x, y) => y.at - x.at);
  return { state: "ok", rows, missing };
}

/** The tab's count: today's total, a floor when a source is missing, "—" offline. */
export function firedCount(log: FiredLog | null): string {
  if (log === null) return "";
  if (log.state === "offline") return "—";
  return log.missing.length > 0 ? `≥${log.rows.length}` : String(log.rows.length);
}

/* ------------------------------------------------------------------ ask --- */

export const ASK_SUGGESTIONS: readonly string[] = [
  "What invalidates this setup?",
  "Where is the nearest liquidity?",
  "Summarise the last 20 bars",
];

export interface Exchange {
  readonly question: string;
  readonly answer: string | null;
  readonly provider: string;
  readonly error: string | null;
  /** A note after the question — a cancel, a cut-off answer. */
  readonly note: string | null;
}

/**
 * The last question and what came back for it, from the session's transcript.
 *
 * Pure. Only entries AFTER the last question count, so an earlier answer is
 * never shown under a newer question that has not been answered yet.
 */
export function lastExchange(entries: readonly TranscriptEntry[]): Exchange | null {
  let qi = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.kind === "user") {
      qi = i;
      break;
    }
  }
  const q = entries[qi];
  if (q === undefined || q.kind !== "user") return null;
  let answer: string | null = null;
  let provider = "";
  let error: string | null = null;
  let note: string | null = null;
  for (const e of entries.slice(qi + 1)) {
    if (e.kind === "assistant") {
      answer = e.text;
      provider = e.provider;
    } else if (e.kind === "error") error = e.text;
    else if (e.kind === "note") note = e.text;
  }
  return { question: q.text, answer, provider, error, note };
}

/* --------------------------------------------------------------- render --- */

let drawerSeq = 0;

export function createChartDrawer(deps: ChartDrawerDeps): HTMLElement {
  const { open, tab, session, broker, drawStore } = deps;
  const uid = `cd${++drawerSeq}`;
  const bodyId = `${uid}-body`;
  const paneId = (t: DrawerTab): string => `${uid}-pane-${t}`;
  const tabId = (t: DrawerTab): string => `${uid}-tab-${t}`;

  /* ---- shared derivations ---- */
  const counts = computed(() => detectorCounts(deps.detections()));
  const drawings = computed(() => {
    drawStore.all(); // the store's signal: `visible` reads it too, but say so
    return drawStore.visible(deps.symbol(), deps.timeframe());
  });

  const alertsRes = signal<AlertsResult | null>(null);
  const sigRes = signal<SigFiredResult | null>(null);
  const loadedAt = signal(0);
  const log = computed<FiredLog | null>(() => {
    const a = alertsRes();
    const s = sigRes();
    return a === null || s === null ? null : firedToday(a, s, loadedAt());
  });

  let seq = 0;
  const loadLog = (): void => {
    const mine = ++seq;
    void Promise.all([loadAlerts(), loadSigFired()]).then(([a, s]) => {
      if (mine !== seq) return; // a slow answer never overwrites a newer one
      alertsRes.set(a);
      sigRes.set(s);
      loadedAt.set(Date.now());
    });
  };

  const countFor = (t: DrawerTab): string => {
    switch (t) {
      case "objects":
        return String(deps.detections().length + drawings().length);
      case "ask":
        return "";
      case "positions":
        return positionsCount(broker.positions());
      case "alerts":
        return firedCount(log());
    }
  };

  /* ---- the bar ---- */
  const select = (t: DrawerTab): void => {
    tab.set(t);
    open.set(true);
  };

  const tabButtons = DRAWER_TABS.map((t) =>
    h(
      "button",
      {
        class: "seg-btn cd-tab",
        type: "button",
        role: "tab",
        id: tabId(t),
        "data-tab": t,
        "aria-controls": paneId(t),
        "aria-selected": () => String(tab() === t),
        "aria-pressed": () => String(open() && tab() === t),
        tabindex: () => (tab() === t ? "0" : "-1"),
        onclick: () => select(t),
        onkeydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k !== "ArrowRight" && k !== "ArrowLeft") return;
          e.preventDefault();
          const i = DRAWER_TABS.indexOf(t);
          const next = DRAWER_TABS[(i + (k === "ArrowRight" ? 1 : DRAWER_TABS.length - 1)) % DRAWER_TABS.length];
          if (next === undefined) return;
          tab.set(next);
          tabButtons[DRAWER_TABS.indexOf(next)]?.focus();
        },
      },
      h("span", { class: "cd-tab-name", text: TAB_LABEL[t] }),
      h("span", { class: "cd-n num", text: () => countFor(t) }),
    ),
  );

  const bar = h(
    "div",
    { class: "cd-bar" },
    h("div", { class: "seg cd-seg", role: "tablist", "aria-label": "Chart drawer" }, ...tabButtons),
    h("span", { class: "cd-spacer" }),
    h("button", {
      class: "ghost-btn cd-toggle",
      type: "button",
      "aria-expanded": () => String(open()),
      "aria-controls": bodyId,
      text: () => (open() ? "Collapse" : "Expand"),
      onclick: () => open.set(!open.peek()),
    }),
  );

  /* ---- panes ---- */
  const pane = (t: DrawerTab, ...children: Node[]): HTMLElement =>
    h(
      "div",
      {
        class: "cd-pane",
        id: paneId(t),
        role: "tabpanel",
        "data-pane": t,
        "aria-labelledby": tabId(t),
        hidden: () => tab() !== t,
      },
      ...children,
    );

  const el = h(
    "section",
    {
      class: "cd",
      "aria-label": "Chart drawer",
      "data-open": () => String(open()),
      "data-tab": () => tab(),
    },
    bar,
    h(
      "div",
      { class: "cd-body", id: bodyId, hidden: () => !open() },
      pane("objects", objectsPane()),
      pane("ask", askPane()),
      pane("positions", positionsPane()),
      pane("alerts", alertsPane()),
    ),
  );

  /* ---- the alerts log's schedule ----
     Once at mount so the tab's count is real before it is opened; then on
     opening that tab; then every 60s while it is open AND on screen. */
  loadLog();
  effect(() => {
    if (!open() || tab() !== "alerts") return;
    untrack(loadLog);
    const timer = setInterval(() => {
      if (isShown(el)) loadLog();
    }, ALERTS_LOG_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });
  onShown(el, () => {
    if (open.peek() && tab.peek() === "alerts") loadLog();
  });

  return el;

  /* ============================== Objects ============================== */
  function objectsPane(): HTMLElement {
    const toggle = (id: DetectorId, on: boolean): void => {
      const cur = deps.detectors.peek();
      if (on && !cur.includes(id)) deps.detectors.set([...cur, id]);
      else if (!on && cur.includes(id)) deps.detectors.set(cur.filter((x) => x !== id));
    };

    const detRow = (id: DetectorId): HTMLElement => {
      const meta = DETECTORS.find((d) => d.id === id);
      const label = meta?.label ?? id;
      return h(
        "label",
        { class: "cd-det", title: meta?.blurb ?? "" },
        h("input", {
          type: "checkbox",
          class: "cd-check",
          checked: () => deps.detectors().includes(id),
          onchange: (e: Event) => toggle(id, (e.target as HTMLInputElement).checked),
        }),
        h("span", { class: "cd-det-name", text: label }),
        h("span", {
          class: "cd-det-n num",
          "data-off": () => String(!deps.detectors().includes(id)),
          /* Off means not run: a dash, never a zero it did not measure. */
          text: () => (deps.detectors().includes(id) ? String(counts().get(id) ?? 0) : "—"),
        }),
      );
    };

    const aiCol = h(
      "div",
      { class: "cd-col" },
      h(
        "div",
        { class: "cd-col-head" },
        h("span", { class: "cd-col-title", text: "Marked by the AI" }),
        h("span", { class: "cd-who", "data-who": "ai", text: "AI" }),
      ),
      ...detectorFamilies().map((g) =>
        h(
          "div",
          { class: "cd-fam" },
          h("div", { class: "cd-fam-head", text: FAMILY_LABEL[g.family] }),
          ...g.ids.map(detRow),
        ),
      ),
      pkWhy(
        "Each count is what that detector found on the bars loaded now. A detector that is switched off is not run, so it shows a dash rather than a zero. Hover a name for what it looks for.",
        "Why?",
      ),
    );

    const drawRow = (d: Drawing): HTMLElement => {
      const line = drawingLine(d, deps.fmtPx);
      return h(
        "div",
        { class: "cd-row cd-draw", "data-id": d.id },
        h("span", { class: "cd-draw-kind", text: line.kind }),
        h("span", { class: "cd-draw-where num", text: line.where }),
        h("button", {
          class: "ghost-btn cd-del",
          type: "button",
          text: "Delete",
          "aria-label": `Delete ${line.kind} ${line.where}`,
          title: "Delete this drawing (undo brings it back)",
          onclick: () => drawStore.remove(d.id),
        }),
      );
    };

    const youCol = h(
      "div",
      { class: "cd-col" },
      h(
        "div",
        { class: "cd-col-head" },
        h("span", { class: "cd-col-title", text: "Drawn by you" }),
        h("span", { class: "cd-who", "data-who": "you", text: "You" }),
      ),
      () => {
        const list = drawings();
        if (list.length === 0) return pkEmpty("empty", "Nothing drawn yet — pick a tool on the left of the chart.");
        return h("div", { class: "cd-rows" }, ...list.map(drawRow));
      },
    );

    return h("div", { class: "cd-objects" }, aiCol, youCol);
  }

  /* ================================ Ask ================================ */
  function askPane(): HTMLElement {
    const typed = signal("");

    const ask = (q: string): void => {
      const text = q.trim();
      if (text === "" || session.busy.peek()) return;
      typed.set("");
      void session.ask(`${text}\n(Chart: ${deps.symbol()} ${deps.timeframe()})`);
    };

    const input = h("input", {
      class: "cd-input",
      type: "text",
      autocomplete: "off",
      placeholder: "Ask about this chart…",
      "aria-label": "Question for the analyst",
      value: () => typed(),
      oninput: (e: Event) => typed.set((e.target as HTMLInputElement).value),
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") ask(typed.peek());
      },
    });

    const note = (): Node | null => {
      const n = deps.providerNote?.() ?? "";
      if (n === "") return null;
      return h(
        "div",
        { class: "cd-note", "data-tone": "attn" },
        h("span", { text: n }),
        h("button", { class: "ghost-btn cd-btn", type: "button", text: "Set up the analyst", onclick: () => deps.onOpenAnalyst() }),
      );
    };

    const answer = (): Node => {
      const x = lastExchange(session.transcript());
      const busy = session.busy();
      if (x === null && !busy) {
        return pkEmpty("empty", "Ask anything about this chart. The answer uses only what the terminal can see.");
      }
      const out = h("div", { class: "cd-qa" });
      if (x !== null) out.append(h("p", { class: "cd-q", text: x.question.replace(/\n\(Chart: [^)]*\)$/, "") }));
      if (busy) {
        const s = session.streaming();
        out.append(h("p", { class: "cd-a", "data-pending": "true", text: s === "" ? "Working…" : s }));
      } else if (x !== null) {
        if (x.answer !== null) {
          out.append(h("p", { class: "cd-a", text: x.answer }));
          out.append(h("p", { class: "cd-by", text: `Answered by ${x.provider}` }));
        } else if (x.error !== null) {
          out.append(h("p", { class: "cd-a", "data-tone": "neg", text: `The analyst could not answer: ${x.error}` }));
        } else if (x.note !== null) {
          out.append(h("p", { class: "cd-a", text: x.note }));
        }
      }
      return out;
    };

    return h(
      "div",
      { class: "cd-ask" },
      note,
      h(
        "div",
        { class: "cd-chips" },
        ...ASK_SUGGESTIONS.map((q) =>
          h("button", {
            class: "ghost-btn cd-chip",
            type: "button",
            text: q,
            disabled: () => session.busy(),
            onclick: () => ask(q),
          }),
        ),
      ),
      h(
        "div",
        { class: "cd-askrow" },
        input,
        () =>
          session.busy()
            ? h("button", { class: "ghost-btn cd-btn", type: "button", text: "Stop", onclick: () => session.cancel() })
            : h("button", {
                class: "ghost-btn cd-btn",
                type: "button",
                text: "Ask",
                disabled: () => typed().trim() === "",
                onclick: () => ask(typed.peek()),
              }),
      ),
      answer,
      h("button", { class: "cd-link", type: "button", text: "Open the full Analyst", onclick: () => deps.onOpenAnalyst() }),
    );
  }

  /* ============================= Positions ============================= */
  function positionsPane(): HTMLElement {
    const fmt = (sym: string, v: number): string =>
      sym.toUpperCase() === deps.symbol().toUpperCase() ? deps.fmtPx(v) : pkNum(v);

    return h("div", { class: "cd-positions" }, () => {
      const v = positionRows(broker.positions(), fmt);
      if (v.state === "loading") return pkEmpty("loading", v.text);
      if (v.state === "refused") {
        return h(
          "div",
          { class: "cd-refused" },
          pkEmpty("unavailable", v.text),
          h("button", {
            class: "ghost-btn cd-btn",
            type: "button",
            text: () => (broker.busy() ? "Asking…" : "Try again"),
            disabled: () => broker.busy(),
            onclick: () => broker.reconnect(),
          }),
          pkWhy(v.why, "Why?"),
        );
      }
      if (v.rows.length === 0) return pkEmpty("empty", "No open positions at the broker.");
      const th = (t: string, num = false): HTMLElement => h("th", { class: num ? "num" : "", text: t });
      return h(
        "table",
        { class: "cd-table" },
        h(
          "thead",
          null,
          h("tr", null, th("Symbol"), th("Side"), th("Lots", true), th("Entry", true), th("Stop", true), th("Target", true), th("P&L", true)),
        ),
        h(
          "tbody",
          null,
          ...v.rows.map((r) =>
            h(
              "tr",
              { title: r.title, "data-ticket": String(r.ticket) },
              h("td", { text: r.symbol }),
              h("td", { text: r.side, "data-tone": r.side === "Buy" ? "pos" : "neg" }),
              h("td", { class: "num", text: r.lots }),
              h("td", { class: "num", text: r.entry }),
              h("td", { class: "num cd-stop", text: r.stop, "data-tone": r.stopTone === "" ? null : r.stopTone }),
              h("td", { class: "num", text: r.target }),
              h("td", { class: "num cd-pnl", text: r.pnl, "data-tone": r.pnlTone === "" ? null : r.pnlTone }),
            ),
          ),
        ),
      );
    });
  }

  /* ============================== Alerts =============================== */
  function alertsPane(): HTMLElement {
    const clock = (sec: number): string =>
      new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    return h(
      "div",
      { class: "cd-alerts" },
      () => {
        const l = log();
        if (l === null) return pkEmpty("loading", "Reading today's alerts…");
        if (l.state === "offline") {
          return h("div", { class: "cd-refused" }, pkEmpty("unavailable", "The alert service is not answering."), pkWhy(l.reason, "Why?"));
        }
        const lost =
          l.missing.length === 0
            ? null
            : h("p", { class: "cd-note", "data-tone": "attn", text: `Could not read ${l.missing.join(" or ")} — this list is missing them.` });
        if (l.rows.length === 0) return h("div", null, lost, pkEmpty("empty", "Nothing has fired today."));
        return h(
          "div",
          null,
          lost,
          h(
            "div",
            { class: "cd-rows" },
            ...l.rows.map((r) =>
              h(
                "div",
                { class: "cd-row cd-fired" },
                h("span", { class: "cd-time num", text: clock(r.at) }),
                h("span", { class: "cd-what", text: r.what, "data-tone": r.tone === "" ? null : r.tone }),
                h("span", { class: "cd-who", "data-who": r.source === "Signal" ? "ai" : "you", text: r.source }),
              ),
            ),
          ),
        );
      },
      pkWhy(
        "Today means since midnight on this computer's clock. Price alerts are checked by the server every 30s against yfinance quotes, which can run about 15 minutes late. Signals are your armed strategies, checked by the server on closed bars only. Both fire with the terminal closed; this list re-reads every minute while it is open.",
        "Why?",
      ),
    );
  }
}
