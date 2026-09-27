/**
 * Broker fills, in the Journal desk: your closed MT5 trades, graded against
 * the plans you wrote.
 *
 * One persistent element. The Journal desk rebuilds itself on every render;
 * this panel keeps its own state (a load in flight, the last result) and is
 * simply re-attached, so a re-render never throws away a sync the operator is
 * waiting on.
 *
 * Opening the desk READS what was already imported — it asks MT5 nothing.
 * "Sync from MT5" is the only thing that talks to the terminal, and it is a
 * button because it can take several seconds and the operator should choose
 * when that happens.
 */

import { h, clear } from "./dom";
import { pkWhy } from "./panelkit";
import { exitText, holdText, loadFills, syncFills, type Fill, type FillsResult } from "../data/fills";

export interface FillsPanelOptions {
  readonly notify: (level: "info" | "warn", title: string, body: string) => void;
  /** Days of history to show and to sync. */
  readonly days?: number;
  /** How many rows to draw. The rest are summarised, not dropped silently. */
  readonly limit?: number;
  /**
   * Every result this panel loads, as it lands. The Review section reads the
   * SAME load rather than fetching `/svc/recon` a second time — two loads of
   * one record can disagree for a second, and two screens then disagree.
   */
  readonly onResult?: (r: FillsResult) => void;
}

const money = (n: number): string =>
  `${n > 0 ? "+" : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const price = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 5 : 6 });

const dateText = (ms: number): string =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Colour follows the result's sign — the standing — never the size. */
const outcomeOf = (net: number): "win" | "loss" | "breakeven" => (net > 0 ? "win" : net < 0 ? "loss" : "breakeven");

export function createFillsPanel(opts: FillsPanelOptions): HTMLElement {
  const days = opts.days ?? 90;
  const limit = opts.limit ?? 50;
  const el = h("div", { class: "jr-panel fl-panel" }) as HTMLElement;
  let result: FillsResult | null = null;
  let busy: "load" | "sync" | null = null;

  const load = async (): Promise<void> => {
    busy = "load";
    render();
    result = await loadFills(days);
    busy = null;
    opts.onResult?.(result);
    render();
  };

  const sync = async (): Promise<void> => {
    busy = "sync";
    render();
    const r = await syncFills(days);
    if (r.state === "ok") {
      opts.notify("info", "Synced from MT5", `${r.stored} fills across ${r.symbols.length} symbol${r.symbols.length === 1 ? "" : "s"}.`);
    } else {
      opts.notify("warn", "MT5 sync failed", r.reason);
    }
    result = await loadFills(days);
    busy = null;
    opts.onResult?.(result);
    render();
  };

  const row = (f: Fill): HTMLElement => {
    const t = f.trade;
    const o = outcomeOf(t.net_profit);
    const r = f.recon?.net_R;
    return h(
      "div",
      { class: "jr-row", "data-outcome": o },
      h("span", { class: "jr-row-sym", text: t.symbol, title: `Position ${t.position_id}` }),
      h("span", { class: "jr-row-dir", "data-dir": t.side, text: t.side }),
      h("span", {
        class: "jr-row-px num",
        text: `${price(t.entry_price)} → ${price(t.exit_price)}`,
        title: `${t.volume} lots${t.partial_fills ? " · filled in parts" : ""}`,
      }),
      h("span", {
        class: "jr-row-r num",
        "data-outcome": o,
        text: money(t.net_profit),
        title: `Gross ${money(t.gross_profit)} · commission ${money(t.commission)} · swap ${money(t.swap)}`,
      }),
      h("span", {
        class: "jr-row-kind",
        text: `${exitText(f.recon)}${typeof r === "number" && Number.isFinite(r) ? ` · ${r >= 0 ? "+" : ""}${r.toFixed(2)}R` : ""}`,
        title: (f.recon?.notes ?? []).join(" ") || "",
      }),
      h("span", { class: "jr-row-adh num", text: holdText(t.hold_ms), title: "Time held" }),
      h("span", { class: "jr-row-adh", text: dateText(t.close_ms), title: "Closed" }),
    ) as HTMLElement;
  };

  function body(): HTMLElement[] {
    if (result === null) return [h("p", { class: "jr-fine", text: "Loading your trades…" }) as HTMLElement];
    switch (result.state) {
      case "empty":
      case "failed":
      case "offline":
        return [h("p", { class: result.state === "empty" ? "jr-fine" : "jr-warn", text: result.reason }) as HTMLElement];
      case "ok": {
        const { fills, stats } = result;
        const shown = fills.slice(0, limit);
        const out: HTMLElement[] = [
          h(
            "div",
            { class: "jr-stats" },
            stat("Trades", String(stats.trades)),
            stat("Net P&L", money(stats.net_profit), "After commission and swap, in your account currency."),
            stat("Costs", money(stats.total_costs), "Commission plus swap."),
            stat(
              "Followed plan",
              stats.plan_adherence_pct === null ? "—" : `${Math.round(stats.plan_adherence_pct)}%`,
              stats.plan_adherence_pct === null ? "No trade here matched a journal plan, so none could be graded." : "Of the trades that matched a plan.",
            ),
          ) as HTMLElement,
          h("div", { class: "jr-rows" }, ...shown.map(row)) as HTMLElement,
        ];
        if (fills.length > shown.length) {
          out.push(h("p", { class: "jr-fine", text: `Showing the latest ${shown.length} of ${fills.length}.` }) as HTMLElement);
        }
        if (stats.findings.length > 0) {
          out.push(pkWhy(stats.findings.join(" "), "What your fills say"));
        }
        return out;
      }
    }
  }

  function stat(label: string, value: string, hint = ""): HTMLElement {
    return h(
      "div",
      { class: "jr-stat", ...(hint ? { title: hint } : {}) },
      h("span", { class: "jr-stat-label", text: label }),
      h("span", { class: "jr-stat-value num", text: value }),
    ) as HTMLElement;
  }

  function render(): void {
    clear(el);
    el.appendChild(
      h(
        "div",
        { class: "jr-panel-head" },
        h("span", { class: "jr-panel-title", text: "Broker fills" }),
        h("span", { class: "jr-context", text: `MT5 · last ${days} days · read-only` }),
      ),
    );
    el.appendChild(
      h(
        "div",
        { class: "jr-actions" },
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: busy === "sync" ? "Syncing…" : "Sync from MT5",
          title: "Pull your closed trades from the running MT5 terminal.",
          disabled: busy !== null,
          onclick: () => void sync(),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: busy === "load" ? "Loading…" : "Refresh",
          title: "Re-read what was already imported. Does not contact MT5.",
          disabled: busy !== null,
          onclick: () => void load(),
        }),
      ),
    );
    for (const node of body()) el.appendChild(node);
  }

  render();
  void load();
  return el;
}
