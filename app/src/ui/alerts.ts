/**
 * Signals desk — the alert book.
 *
 * The desk is only a VIEW. Evaluation lives in the shell and runs whether or not
 * this tab is open, because an alert that only works while you are looking at
 * the alert screen is a decoration. See `mountShell` for the pass that drives it.
 *
 * WHAT MAKES THE CREATE FORM DIFFERENT
 * The anchor dropdown is not a list of prices, it is a list of STRUCTURES the
 * detectors currently see, each showing where it sits right now. Choosing
 * "Rising trendline — now 4462.10" creates an alert that follows the line as it
 * re-fits, not one pinned to 4462.10 forever.
 */

import { signal, computed, effect, renderEffect, untrack, type ReadSignal, type Signal } from "../core/signal";
import { h, clear } from "./dom";
import type { Detection, DetectInput } from "../detect/types";
import { resolveAnchor, anchorTimeOf } from "../alert/anchor";
import { alertId, type AlertStore } from "../alert/store";
import {
  CONDITIONS,
  type AlertAnchor,
  type AlertCondition,
  type AlertRuntime,
  type AnchorEdge,
} from "../alert/types";
import {
  notifyPermission,
  requestNotifyPermission,
  chime,
  type NotifyPermission,
} from "../alert/notify";
import { canAnchor, isBandKind, presetFor, anchorTimeframe } from "../alert/preset";
import { makeBookFile } from "../alert/headless";

export interface AlertsDeskOptions {
  symbol: Signal<string>;
  timeframe: Signal<string>;
  /** Columnar bars, or null before anything has loaded. */
  data: ReadSignal<DetectInput | null>;
  detections: ReadSignal<readonly Detection[]>;
  closedCount: ReadSignal<number>;
  store: AlertStore;
  sound: Signal<boolean>;
  desktop: Signal<boolean>;
}

export interface AlertsHandle {
  el: HTMLElement;
}

function fmt(v: number | null): string {
  if (v === null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(t)}`;
}


export function createAlerts(opts: AlertsDeskOptions): AlertsHandle {
  const { store } = opts;

  /** "" means a static price; otherwise the chosen detection's id. */
  const pickId = signal<string>("");
  const priceText = signal<string>("");
  const condition = signal<AlertCondition>("cross-above");
  const edge = signal<AnchorEdge>("band");
  const once = signal(true);
  const cooldown = signal(0);
  const perm = signal<NotifyPermission>(notifyPermission());
  const formError = signal<string>("");

  /** Detections the form will offer, newest first — the tradeable ones. */
  const candidates = computed<Detection[]>(() =>
    [...opts.detections()].filter(canAnchor).reverse().slice(0, 40),
  );

  const chosen = computed<Detection | null>(() => {
    const id = pickId();
    if (!id) return null;
    return candidates().find((d) => d.id === id) ?? null;
  });

  // Choosing a structure adopts the condition that structure is actually
  // watched for. The user can still change it; this only sets the sane start.
  effect(() => {
    const d = chosen();
    if (!d) return;
    const p = presetFor(d);
    untrack(() => {
      condition.set(p.condition);
      edge.set(p.edge);
    });
  });

  /** Where the chosen structure sits on the newest closed bar. */
  const anchorNow = computed<number | null>(() => {
    const d = chosen();
    const data = opts.data();
    if (!d || !data) return null;
    const res = resolveAnchor(
      { kind: "detection", detKind: d.kind, fromTime: anchorTimeOf(data, d), label: d.label, edge: edge() },
      data,
      opts.detections(),
    );
    if (!res.ok) return null;
    const i = Math.max(0, opts.closedCount() - 1);
    const band = res.anchor.at(i);
    return band ? (band.lo + band.hi) / 2 : null;
  });

  const lastClose = computed<number | null>(() => {
    const data = opts.data();
    const n = opts.closedCount();
    if (!data || n === 0) return null;
    return data.c[n - 1] ?? null;
  });

  function create(): void {
    formError.set("");
    const data = opts.data();
    if (!data) {
      formError.set("No bars loaded — there is nothing to anchor to yet.");
      return;
    }

    let anchor: AlertAnchor;
    const det = chosen();
    if (det) {
      anchor = {
        kind: "detection",
        detKind: det.kind,
        fromTime: anchorTimeOf(data, det),
        label: det.label,
        edge: isBandKind(det.kind) ? edge() : "mid",
      };
    } else {
      // A blank box takes the placeholder at its word. The placeholder shows
      // the last close, so silently rejecting a blank box would contradict what
      // the field says it will do.
      const typed = priceText().trim();
      const p = typed === "" ? lastClose() : Number(typed);
      if (p === null || !isFinite(p) || p <= 0) {
        formError.set("Enter a price above zero, or pick a structure to anchor to.");
        return;
      }
      anchor = { kind: "price", price: p };
    }

    const cond = condition();
    if (det && !isBandKind(det.kind) && (cond === "enter" || cond === "exit")) {
      formError.set(`${det.label} is a line, not a zone — there is nothing to enter or leave.`);
      return;
    }

    // A second identical alert is a double-click, not an intention. Two
    // different conditions on one structure are fine and still allowed.
    const dup = store.specs().some(
      (a) =>
        a.symbol === opts.symbol() &&
        a.timeframe === opts.timeframe() &&
        a.condition === cond &&
        JSON.stringify(a.anchor) === JSON.stringify(anchor),
    );
    if (dup) {
      formError.set("That alert already exists — it is in the list below.");
      return;
    }

    const htf = det ? anchorTimeframe(det) : null;

    store.add({
      id: alertId(Date.now()),
      symbol: opts.symbol(),
      timeframe: opts.timeframe(),
      anchor,
      ...(htf ? { timeframeAnchor: htf } : {}),
      condition: cond,
      once: once(),
      cooldownBars: Math.max(0, Math.round(cooldown())),
      enabled: true,
      createdAt: Date.now(),
      note: "",
    });
    pickId.set("");
    priceText.set("");
  }

  // ------------------------------------------------------------- create ---

  const anchorSelect = h("select", {
    class: "field-input",
    onchange: (e: Event) => pickId.set((e.target as HTMLSelectElement).value),
  }) as HTMLSelectElement;

  renderEffect(() => {
    const list = candidates();
    const keep = pickId();
    clear(anchorSelect);
    anchorSelect.appendChild(h("option", { value: "", text: "Static price…" }));
    for (const d of list) {
      anchorSelect.appendChild(
        h("option", {
          value: d.id,
          text: `${d.label} · conf ${d.confidence.toFixed(2)}`,
        }),
      );
    }
    // The chosen structure can vanish between runs (mitigated, scrolled off).
    // Falling back to the static-price option is honest; silently keeping a
    // dead selection would create an alert that is orphaned from birth.
    anchorSelect.value = list.some((d) => d.id === keep) ? keep : "";
    if (anchorSelect.value !== keep) pickId.set(anchorSelect.value);
  });

  const condSelect = h("select", {
    class: "field-input",
    onchange: (e: Event) => condition.set((e.target as HTMLSelectElement).value as AlertCondition),
  }) as HTMLSelectElement;
  for (const c of CONDITIONS) {
    condSelect.appendChild(h("option", { value: c.id, text: c.label, title: c.blurb }));
  }
  renderEffect(() => {
    condSelect.value = condition();
  });

  const field = (label: string, control: Node, hint?: () => string): HTMLElement =>
    h(
      "label",
      { class: "field" },
      h("span", { class: "field-label", text: label }),
      control,
      hint ? h("span", { class: "field-hint", text: hint }) : null,
    );

  const createCard = h(
    "section",
    { class: "panel alert-create" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "New alert" }),
      h("span", {
        class: "chip",
        text: () => `${opts.symbol()} · ${opts.timeframe()}`,
      }),
    ),
    h(
      "div",
      { class: "panel-body alert-form" },

      field("Anchor", anchorSelect, () =>
        chosen()
          ? `follows the structure — now at ${fmt(anchorNow())}`
          : "a fixed price that never moves",
      ),

      h(
        "div",
        { "data-hidden": () => String(chosen() !== null) },
        field(
          "Price",
          h("input", {
            class: "field-input num",
            type: "number",
            step: "any",
            placeholder: () => (lastClose() === null ? "" : fmt(lastClose())),
            value: () => priceText(),
            oninput: (e: Event) => priceText.set((e.target as HTMLInputElement).value),
          }),
          () => (lastClose() === null ? "" : `last close ${fmt(lastClose())}`),
        ),
      ),

      h(
        "div",
        { "data-hidden": () => String(!(chosen() && isBandKind(chosen()!.kind))) },
        field(
          "Watch",
          h(
            "select",
            {
              class: "field-input",
              onchange: (e: Event) => edge.set((e.target as HTMLSelectElement).value as AnchorEdge),
            },
            h("option", { value: "band", text: "The whole zone" }),
            h("option", { value: "top", text: "Top edge" }),
            h("option", { value: "bottom", text: "Bottom edge" }),
            h("option", { value: "mid", text: "Midline" }),
          ),
        ),
      ),

      field("Condition", condSelect, () => CONDITIONS.find((c) => c.id === condition())?.blurb ?? ""),

      h(
        "div",
        { class: "alert-form-row" },
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: () => once(),
            onchange: (e: Event) => once.set((e.target as HTMLInputElement).checked),
          }),
          h("span", { text: "Fire once" }),
        ),
        field(
          "Cooldown",
          h("input", {
            class: "field-input num",
            type: "number",
            min: "0",
            value: () => String(cooldown()),
            oninput: (e: Event) => cooldown.set(Number((e.target as HTMLInputElement).value) || 0),
          }),
          () => "bars",
        ),
      ),

      h("p", {
        class: "form-error",
        "data-show": () => String(formError() !== ""),
        text: () => formError(),
      }),

      h(
        "div",
        { class: "alert-form-actions" },
        h("button", { class: "primary-btn", text: "Create alert", onclick: create }),
      ),
    ),
  );

  // ------------------------------------------------------------ delivery ---

  const deliveryCard = h(
    "section",
    { class: "panel" },
    h("header", { class: "panel-head" }, h("h3", { class: "panel-title", text: "Delivery" })),
    h(
      "div",
      { class: "panel-body alert-delivery" },
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: () => opts.sound(),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            opts.sound.set(on);
            // Play it immediately: this click is the user gesture that unlocks
            // audio, and it is also the only honest way to preview the sound.
            if (on) chime();
          },
        }),
        h("span", { text: "Sound" }),
      ),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: () => opts.desktop(),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            opts.desktop.set(on);
            if (on && perm() !== "granted") {
              void requestNotifyPermission().then((p) => perm.set(p));
            }
          },
        }),
        h("span", { text: "Desktop notification" }),
      ),
      h("p", {
        class: "muted small",
        text: () => {
          switch (perm()) {
            case "unsupported":
              return "This browser has no notification API — sound and the in-app log still work.";
            case "denied":
              return "Notifications are blocked for this page. Allow them in site settings, or rely on sound.";
            case "default":
              return "Permission not requested yet. Ticking the box asks for it.";
            case "granted":
              return "Notifications allowed. They arrive with the browser in the background.";
          }
        },
      }),
      h("p", {
        class: "muted small",
        text: "Alerts run whenever the terminal is open, on any desk. Close the tab and they stop — unless the daemon below is running.",
      }),
    ),
  );

  // ------------------------------------------------------------ always-on ---

  /**
   * Getting the book out of the browser.
   *
   * The daemon runs the SAME compiled engine as this desk, so exporting the
   * book is the only thing that has to cross the gap. Re-export after changing
   * an alert and the daemon picks it up on its next poll — it watches the file
   * rather than requiring a restart.
   */
  function exportBook(): void {
    const doc = makeBookFile(store.specs(), Date.now());
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "alerts.json";
    a.click();
    // Revoking immediately can cancel the download in some browsers; one frame
    // is enough for the click to have been taken.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const alwaysOnCard = h(
    "section",
    { class: "panel span-all" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Always-on" }),
      h("span", { class: "chip", text: () => `${store.specs().length} alerts in the book` }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", {
        class: "muted small",
        text: "Alerts in this browser stop when you close the tab. The daemon keeps the same book running without it — and it runs the SAME compiled engine as this desk, so there is no second set of rules to disagree with these.",
      }),
      h(
        "div",
        { class: "alert-form-actions" },
        h("button", { class: "primary-btn", text: "Export book", onclick: exportBook }),
      ),
      h("pre", {
        class: "code-line",
        text: "1.  save alerts.json into the server/ folder",
      }),
      h("pre", {
        class: "code-line",
        text: "2.  node server/alert_daemon.mjs --every 60",
      }),
      h("p", {
        class: "muted small",
        text: "The daemon reports to server/alerts.log and to a webhook if you give it one. It cannot place an order — nothing in this terminal can. Its first pass over each symbol is silent, because a book loaded against months of history legitimately contains dozens of past fires and announcing them on startup is how an alert system gets muted on day one.",
      }),
    ),
  );

  // -------------------------------------------------------------- active ---

  const statusText = (r: AlertRuntime): string => {
    switch (r.status) {
      case "armed":
        return "ARMED";
      case "orphaned":
        return "ORPHANED";
      case "done":
        return "FIRED";
      case "off":
        return "OFF";
    }
  };

  const describe = (r: AlertRuntime): string => {
    const cond = CONDITIONS.find((c) => c.id === r.spec.condition)?.label ?? r.spec.condition;
    const what =
      r.spec.anchor.kind === "price" ? `price ${fmt(r.spec.anchor.price)}` : r.spec.anchor.label;
    return `${cond} · ${what}`;
  };

  const activeList = h("div", { class: "alert-list" });
  renderEffect(() => {
    const rows = store.runtimes();
    clear(activeList);
    if (rows.length === 0) {
      activeList.appendChild(
        h("p", {
          class: "muted small",
          text: `No alerts on ${opts.symbol()} ${opts.timeframe()}. Alerts on other symbols are kept and still listed there.`,
        }),
      );
      return;
    }
    const price = lastClose();
    for (const r of rows) {
      const away =
        price !== null && r.currentAnchor !== null && price !== 0
          ? `${(((r.currentAnchor - price) / price) * 100).toFixed(2)}%`
          : "—";
      activeList.appendChild(
        h(
          "div",
          { class: "alert-row", "data-status": r.status },
          h(
            "div",
            { class: "alert-row-main" },
            h("div", { class: "alert-row-title", text: describe(r) }),
            h("div", {
              class: "alert-row-sub",
              text:
                r.status === "orphaned"
                  ? r.statusNote
                  : `now at ${fmt(r.currentAnchor)} · ${away} away${r.spec.once ? " · one-shot" : ""}`,
            }),
          ),
          h("span", { class: "alert-pill", "data-status": r.status, text: statusText(r) }),
          h("button", {
            class: "ghost-btn tiny",
            text: r.spec.enabled ? "Disable" : "Enable",
            onclick: () => store.toggle(r.spec.id),
          }),
          h("button", {
            class: "ghost-btn tiny",
            text: "Delete",
            onclick: () => store.remove(r.spec.id),
          }),
        ),
      );
    }
  });

  const otherCount = computed<number>(
    () =>
      store.specs().filter((a) => a.symbol !== opts.symbol() || a.timeframe !== opts.timeframe())
        .length,
  );

  const activeCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Active" }),
      h("span", {
        class: "chip",
        text: () => {
          const n = otherCount();
          return n === 0 ? `${store.runtimes().length} here` : `${store.runtimes().length} here · ${n} elsewhere`;
        },
      }),
    ),
    h("div", { class: "panel-body" }, activeList),
  );

  // ----------------------------------------------------------------- log ---

  const logList = h("div", { class: "alert-log" });
  renderEffect(() => {
    const rows = store.log();
    clear(logList);
    if (rows.length === 0) {
      logList.appendChild(
        h("p", {
          class: "muted small",
          text: "Nothing has fired yet. Past fires found in history are listed here too — they are recorded, never announced.",
        }),
      );
      return;
    }
    for (const f of rows.slice(0, 80)) {
      logList.appendChild(
        h(
          "div",
          { class: "alert-log-row" },
          h("span", { class: "alert-log-time num", text: stamp(f.time) }),
          h("span", { class: "alert-log-reason", text: f.reason }),
        ),
      );
    }
  });

  const logCard = h(
    "section",
    { class: "panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Fired" }),
      h("button", { class: "ghost-btn tiny", text: "Clear", onclick: () => store.clearLog() }),
    ),
    h("div", { class: "panel-body" }, logList),
  );

  const el = h(
    "section",
    { class: "view view-signals" },
    h(
      "header",
      { class: "view-head" },
      h("h2", { class: "view-title", text: "Signals" }),
      h("p", {
        class: "view-sub",
        text: "Alerts anchored to structures, not to numbers you typed once. Judged on closes, never on a forming bar.",
      }),
    ),
    h("div", { class: "view-grid" }, createCard, deliveryCard, activeCard, logCard, alwaysOnCard),
  );

  return { el };
}
