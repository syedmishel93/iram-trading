/**
 * THE SYSTEM CARD — what this machine is doing while you are not looking.
 *
 * MEASURED, by walking every `@bp.get/@bp.post` in `server/` and grepping
 * `app/src` for each path: **74 routes, 46 called by the frontend, 28 never**.
 * And of the twelve background loops in `gateway/background.py`, six are not
 * mentioned anywhere in the frontend at all — `backup_loop`, `data_loop`,
 * `ledger_loop`, `pair_scan_loop`, `heartbeat_loop`, `daily_brief_loop`. They
 * run every few seconds, on this machine, and nothing on screen said so.
 *
 * CLAUDE.md records this as "the largest single source of 'the product has
 * functions I cannot use', and it is a wiring problem, not a missing-feature
 * one". This is the first half of the wiring: SHOWING them, by category, with
 * the controls that exist for each.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY LOOPS ARE GROUPED BY WHAT THEY ARE FOR
 *
 * Twelve names in one list is a process table, not an interface. Grouped —
 * data, alerts, money, housekeeping — each group answers a question somebody
 * actually has ("is my history being kept up to date?"), and a loop that is
 * silent is silent in a place where its absence means something.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A TICK AGE IS NOT A HEALTH CHECK
 *
 * `bars_loop` ticked hourly and reported a healthy age for a whole release
 * while doing NOTHING, because the config key it read had no writer. So a
 * green age is reported as exactly what it is — "it last woke N seconds ago" —
 * and never as "it is working". Where a loop has an output worth counting, the
 * count is what is shown instead.
 */

import { h } from "../dom";
import { renderEffect, signal } from "../../core/signal";
import { apiUrl } from "../../data/backend";

export interface LoopState {
  readonly started: boolean;
  readonly error: string | null;
  readonly lastTickAgeS: number | null;
}

/**
 * What each loop is FOR, in the operator's words rather than the function's.
 *
 * A name like `pair_scan_loop` tells you nothing about whether you want it.
 * Grouped so the list reads as capabilities rather than as a process table.
 */
export const LOOPS: readonly { group: string; id: string; what: string }[] = [
  { group: "Data", id: "bars_loop", what: "Keeps your enrolled markets' history up to date, hourly." },
  { group: "Data", id: "data_loop", what: "Collects the macro drivers the study desk reads." },
  { group: "Data", id: "pair_scan_loop", what: "Watches for newly listed pairs on the venues." },

  { group: "Alerts", id: "alert_loop", what: "Checks your price alerts every 30s with the terminal closed." },
  { group: "Alerts", id: "sig_loop", what: "Evaluates armed strategies server-side." },
  { group: "Alerts", id: "db_alert_loop", what: "Watches the wallets you follow for movement." },
  { group: "Alerts", id: "daily_brief_loop", what: "Sends the daily brief, if Telegram is connected." },

  { group: "Money", id: "ledger_loop", what: "Resolves forward-test trades into the claims ledger." },
  { group: "Money", id: "whale_loop", what: "Tracks large on-chain flows." },
  { group: "Money", id: "smart_copy_loop", what: "Follows the wallets marked worth copying." },

  { group: "Housekeeping", id: "backup_loop", what: "Nightly copy of the database, keeping seven." },
  { group: "Housekeeping", id: "heartbeat_loop", what: "The dead-man's switch that notices the service stopped." },
];

/**
 * What to CALL each job on screen.
 *
 * Stripping `_loop` and swapping underscores gave "db alert" and "pair scan" —
 * function names with the punctuation filed off, which read as internals
 * leaking rather than as things the operator owns.
 */
const NAMES: Readonly<Record<string, string>> = {
  bars_loop: "History top-up",
  data_loop: "Macro drivers",
  pair_scan_loop: "New listings",
  alert_loop: "Price alerts",
  sig_loop: "Armed strategies",
  db_alert_loop: "Wallet watch",
  daily_brief_loop: "Daily brief",
  ledger_loop: "Forward-test ledger",
  whale_loop: "Large flows",
  smart_copy_loop: "Copied wallets",
  backup_loop: "Database backup",
  heartbeat_loop: "Dead-man's switch",
};

const AGE = (s: number | null): string =>
  s === null ? "—" : s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;

export function createSystemCard(): { readonly el: HTMLElement; refresh(): Promise<void> } {
  const loops = signal<Readonly<Record<string, LoopState>>>({});
  /** Null until asked. `false` would claim the service is absent. */
  const reachable = signal<boolean | null>(null);
  const enabled = signal<boolean | null>(null);
  const why = signal("");
  const busy = signal(false);

  async function refresh(): Promise<void> {
    busy.set(true);
    try {
      const res = await fetch(apiUrl("/api/health"));
      if (!res.ok) {
        reachable.set(false);
        why.set(`The gateway answered HTTP ${res.status}.`);
        return;
      }
      const body = (await res.json()) as { background?: { enabled?: unknown; loops?: unknown } };
      const bg = body.background ?? {};
      enabled.set(bg.enabled === true);
      const raw = (bg.loops ?? {}) as Record<string, { started?: unknown; error?: unknown; last_tick_age_s?: unknown }>;
      const out: Record<string, LoopState> = {};
      for (const [k, v] of Object.entries(raw)) {
        out[k] = {
          started: v.started === true,
          error: typeof v.error === "string" ? v.error : null,
          lastTickAgeS: typeof v.last_tick_age_s === "number" ? v.last_tick_age_s : null,
        };
      }
      loops.set(out);
      reachable.set(true);
      why.set("");
    } catch {
      reachable.set(false);
      why.set("The gateway is not answering on this address. Start it with: python run.py");
    } finally {
      busy.set(false);
    }
  }

  const body = h("div", { class: "svc-groups" });
  renderEffect(() => {
    const state = loops();
    const ok = reachable();
    body.replaceChildren();

    if (ok === null) {
      body.appendChild(h("p", { class: "ar-note", text: "Not asked yet." }));
      return;
    }
    if (ok === false) {
      body.appendChild(h("p", { class: "ar-note ar-bad", text: why() }));
      return;
    }
    if (enabled() === false) {
      /* The exact failure CLAUDE.md records: eleven loops that had not run
         since consolidation, because nothing set IRAM_BACKGROUND=1. */
      body.appendChild(
        h("p", {
          class: "ar-note ar-bad",
          text: "Background services are switched OFF, so none of the below is running. `python run.py` turns them on; starting the gateway directly does not.",
        }),
      );
    }

    for (const group of ["Data", "Alerts", "Money", "Housekeeping"]) {
      const rows = LOOPS.filter((l) => l.group === group);
      /* The group name is a SPINE down the left, not a heading above a list:
         four short groups each with a heading would be four cards' worth of
         chrome for twelve rows. */
      const jobs = h("div", { class: "svc-jobs" });
      for (const l of rows) {
        const st = state[l.id];
        jobs.appendChild(
          h(
            "div",
            {
              class: "svc-row",
              "data-state": st === undefined ? "absent" : st.error ? "error" : st.started ? "on" : "off",
              title: "The rail means this job has STARTED. It is not a claim that it did any work.",
            },
            h(
              "span",
              { class: "svc-what" },
              h("span", { class: "svc-name", text: NAMES[l.id] ?? l.id }),
              h("span", { class: "svc-desc", text: l.what }),
            ),
            /* "Woke N ago" — never "healthy". A loop can tick on schedule and
               do nothing; `bars_loop` did exactly that for a release. */
            h("span", {
              class: "svc-age",
              text: st === undefined ? "not started" : st.error ? "error" : `woke ${AGE(st.lastTickAgeS)}`,
            }),
          ),
        );
      }
      body.appendChild(h("div", { class: "svc-group" }, h("h4", { class: "svc-group-title", text: group }), jobs));
    }
  });

  const el = h(
    "section",
    { class: "dd-panel ar-card svc-card" },
    h(
      "header",
      { class: "ar-head-row" },
      h("h2", { class: "ar-title", text: "Background services" }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "refresh-system",
        text: () => (busy() ? "Reading…" : "Refresh"),
        disabled: () => busy(),
        onclick: () => void refresh(),
      }),
    ),
    h("p", {
      class: "ar-sub",
      text: "These run on this machine whether or not the terminal is open.",
    }),
    body,
  ) as HTMLElement;

  return { el, refresh };
}
