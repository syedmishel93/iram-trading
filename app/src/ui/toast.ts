/**
 * Toasts and the notification log.
 *
 * WHY BOTH, AND WHY THE LOG IS THE IMPORTANT HALF
 * A toast that vanishes after four seconds is only useful if you happened to be
 * looking. In a terminal you are looking at a chart, and the thing that fired
 * was an alert on a symbol you are not currently showing. So every toast is
 * also APPENDED TO A LOG that does not expire, and the bell in the status bar
 * carries the unread count.
 *
 * A notification you missed is not a notification.
 *
 * THREE LEVELS, DISTINCT MEANINGS
 *   info    — something finished. No action needed.
 *   warn    — something degraded but the terminal carried on. A source failed
 *             over; a retention sweep skipped a series. You should know.
 *   error   — something did not happen. The thing you asked for did not occur.
 *
 * `error` toasts do NOT auto-dismiss, because a failure that erases itself is
 * indistinguishable from a success.
 */

import { h, clear } from "./dom";
import { signal, type Signal } from "../core/signal";

export type ToastLevel = "info" | "warn" | "error" | "success";

export interface ToastSpec {
  readonly title: string;
  readonly body?: string;
  readonly level?: ToastLevel;
  /** Override the auto-dismiss. 0 pins it open. */
  readonly ttlMs?: number;
  /** One optional action, e.g. "Show me" jumping to the symbol that fired. */
  readonly action?: { readonly label: string; readonly run: () => void };
  /** Collapse repeats: a second toast with the same key replaces the first. */
  readonly key?: string;
}

export interface Notification extends ToastSpec {
  readonly id: number;
  readonly at: number;
  readonly level: ToastLevel;
}

export interface Toaster {
  readonly el: HTMLElement;
  push(spec: ToastSpec): void;
  /** Everything that has ever been pushed this session, newest first. */
  readonly log: Signal<readonly Notification[]>;
  readonly unread: Signal<number>;
  markAllRead(): void;
  clearLog(): void;
}

const DEFAULT_TTL: Record<ToastLevel, number> = {
  success: 3200,
  info: 4200,
  warn: 7000,
  /* Zero: a failure that erases itself is indistinguishable from a success. */
  error: 0,
};

/** Kept in memory only. A session's noise is not worth a storage write. */
const LOG_MAX = 200;

/**
 * How many toasts may stack at once.
 *
 * Beyond this they are dropped from the STACK but still land in the log. Twelve
 * alerts firing on one bar close must not paint a wall over the chart — the
 * chart is the thing they are about.
 */
const STACK_MAX = 4;

let nextId = 1;

export function createToaster(): Toaster {
  const stack = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
  const log = signal<readonly Notification[]>([]);
  const unread = signal(0);
  const live = new Map<string, HTMLElement>();

  function dismiss(el: HTMLElement, key?: string): void {
    if (!el.isConnected) return;
    el.setAttribute("data-leaving", "true");
    if (key) live.delete(key);
    /* Wait for the transition, but never depend on transitionend firing: a
       toast dismissed while the tab is hidden gets no animation frames and the
       event never arrives, so the node would leak forever. */
    setTimeout(() => el.remove(), 200);
  }

  const toaster: Toaster = {
    el: stack,
    log,
    unread,

    push(spec) {
      const level: ToastLevel = spec.level ?? "info";
      const note: Notification = {
        ...spec,
        id: nextId++,
        at: Date.now(),
        level,
      };

      log.update((prev) => [note, ...prev].slice(0, LOG_MAX));
      unread.update((n) => n + 1);

      /* A repeat replaces its predecessor rather than stacking beneath it —
         "reconnecting…" five times is one situation, not five. */
      if (spec.key) {
        const existing = live.get(spec.key);
        if (existing) existing.remove();
      }

      const el = h(
        "div",
        { class: "toast", "data-level": level, role: level === "error" ? "alert" : "status" },
        h(
          "div",
          { class: "toast-main" },
          h("div", { class: "toast-title", text: spec.title }),
          spec.body ? h("div", { class: "toast-body", text: spec.body }) : null,
        ),
        spec.action
          ? h("button", {
              class: "toast-action",
              type: "button",
              text: spec.action.label,
              onclick: () => {
                dismiss(el, spec.key);
                spec.action?.run();
              },
            })
          : null,
        h("button", {
          class: "toast-close",
          type: "button",
          "aria-label": "Dismiss",
          text: "✕",
          onclick: () => dismiss(el, spec.key),
        }),
      );

      if (spec.key) live.set(spec.key, el);
      stack.appendChild(el);

      /* Oldest out first. `children` is live, so this is read after the append. */
      while (stack.children.length > STACK_MAX) {
        const oldest = stack.firstElementChild as HTMLElement | null;
        if (!oldest) break;
        oldest.remove();
      }

      const ttl = spec.ttlMs ?? DEFAULT_TTL[level];
      if (ttl > 0) {
        let timer = setTimeout(() => dismiss(el, spec.key), ttl);
        /* Hovering pauses the countdown. A toast that expires while you are
           reaching for its button is a toast you cannot act on. */
        el.addEventListener("pointerenter", () => clearTimeout(timer));
        el.addEventListener("pointerleave", () => {
          timer = setTimeout(() => dismiss(el, spec.key), 1200);
        });
      }
    },

    markAllRead() {
      unread.set(0);
    },

    clearLog() {
      log.set([]);
      unread.set(0);
    },
  };

  return toaster;
}

/** Relative time for the log. Absolute below a minute is noise. */
export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 45_000) return "just now";
  const m = Math.round(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(d / 3_600_000);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/**
 * The notification centre panel — the log, rendered.
 *
 * Built on demand and thrown away on close rather than kept live: it is behind
 * a button nobody presses often, and a permanently-mounted effect over a
 * two-hundred-row list would recompute on every toast for nobody's benefit.
 */
export function renderNotificationPanel(toaster: Toaster, onJump?: () => void): HTMLElement {
  const list = h("div", { class: "notif-list" });

  const paint = (): void => {
    clear(list);
    const items = toaster.log();
    if (items.length === 0) {
      list.appendChild(h("div", { class: "notif-empty", text: "Nothing has happened yet." }));
      return;
    }
    for (const n of items) {
      list.appendChild(
        h(
          "div",
          { class: "notif-row", "data-level": n.level },
          h("span", { class: "notif-dot", "data-level": n.level }),
          h(
            "div",
            { class: "notif-text" },
            h("div", { class: "notif-title", text: n.title }),
            n.body ? h("div", { class: "notif-body", text: n.body }) : null,
          ),
          h("span", { class: "notif-time", text: ago(n.at) }),
          n.action
            ? h("button", {
                class: "ghost-btn tiny",
                type: "button",
                text: n.action.label,
                onclick: () => {
                  n.action?.run();
                  onJump?.();
                },
              })
            : null,
        ),
      );
    }
  };

  paint();

  return h(
    "div",
    { class: "notif" },
    h(
      "div",
      { class: "notif-head" },
      h("span", { class: "label", text: "Notifications" }),
      h("span", { style: "flex:1" }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Clear",
        onclick: () => {
          toaster.clearLog();
          paint();
        },
      }),
    ),
    list,
  );
}
