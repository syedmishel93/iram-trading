/**
 * "AI scanned your list" — one row per focus symbol, from what the terminal
 * has ALREADY read about it. Nothing here runs a scan or scores anything.
 *
 * THREE SOURCES, IN ORDER OF HOW MUCH THEY KNOW
 *   1. The chart's own symbol: the Setup card's view model, which is the only
 *      read that runs the CHECKS — so it is the only row with a passed/total.
 *   2. The last Opportunities scan's row for the symbol: its setup (or its
 *      refusal, which is information), or its error. The scan finds setups
 *      and replays their history; it does not run the checks, so the Checks
 *      cell is a dash that says so rather than a number it does not have.
 *   3. The watch rail's map, when the desk was not given the scan rows.
 * A symbol none of them has read says "not scanned yet" and why. It never
 * borrows another symbol's read or a default.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import { pkEmpty, pkWhy } from "../panelkit";
import { todayCard } from "./card";
import type { ScanRow } from "../../scan/scanner";
import type { SetupView } from "../../setup/ui";
import type { WatchSetup } from "../watchrail";

export type ScanRowSource = "chart" | "scan" | "failed" | "none";

export interface FocusRead {
  readonly symbol: string;
  readonly sees: string;
  readonly side: "long" | "short" | null;
  /** `passed/total`, or null when nothing ran the checks for this symbol. */
  readonly checks: string | null;
  readonly why: string;
  readonly source: ScanRowSource;
  /** True when the read is a live setup — the one fact this row is toned by. */
  readonly live: boolean;
}

export interface ScanInputs {
  readonly chartSymbol: string;
  readonly setup: SetupView | null;
  /** The last scan's rows, or null when the desk was not given them. */
  readonly scanRows: readonly ScanRow[] | null;
  readonly opportunities: ReadonlyMap<string, WatchSetup>;
  readonly scanned: boolean;
}

export const CHECKS_ONLY_ON_CHART = "Checks run on the chart's symbol. Open it to run them.";

/** One focus symbol's row. PURE. */
export function readFocus(sym: string, i: ScanInputs): FocusRead {
  if (sym === i.chartSymbol && i.setup !== null) {
    const v = i.setup.verdict;
    return {
      symbol: sym,
      sees: v.headline,
      side: i.setup.plan?.direction ?? null,
      checks: `${v.passed}/${v.total}`,
      why: i.setup.planProblem ?? v.readLine,
      source: "chart",
      live: v.kind === "go" || v.kind === "armed",
    };
  }
  const row = i.scanRows?.find((r) => r.symbol === sym);
  if (row !== undefined) {
    if (row.error !== null) {
      return { symbol: sym, sees: "Scan failed", side: null, checks: null, why: row.error, source: "failed", live: false };
    }
    const o = row.opportunity;
    if (o?.ok === true) {
      const op = o.opportunity;
      return {
        symbol: sym,
        sees: op.label,
        side: op.direction,
        checks: null,
        why: op.history.adverse ? `History says no: ${op.history.note}` : op.reason,
        source: "scan",
        live: !op.history.adverse,
      };
    }
    return {
      symbol: sym,
      sees: "No setup",
      side: null,
      checks: null,
      why: o?.ok === false ? o.reason : (row.result?.insufficient ?? "The scan found nothing to plan."),
      source: "scan",
      live: false,
    };
  }
  const s = i.opportunities.get(sym);
  if (s !== undefined) {
    return {
      symbol: sym,
      sees: s.label,
      side: s.direction,
      checks: null,
      why: s.live ? "Live now." : "History says no.",
      source: "scan",
      live: s.live,
    };
  }
  if (sym === i.chartSymbol) {
    return {
      symbol: sym,
      sees: "Not enough data yet",
      side: null,
      checks: null,
      why: "Needs at least 30 closed bars.",
      source: "none",
      live: false,
    };
  }
  return {
    symbol: sym,
    sees: "not scanned yet",
    side: null,
    checks: null,
    why: i.scanned ? "Not in the last scan. Rescan on Opportunities." : "Open Opportunities to scan your list.",
    source: "none",
    live: false,
  };
}

export interface ScanListOptions {
  readonly focus: () => readonly string[];
  readonly inputs: () => ScanInputs;
  onPick(symbol: string): void;
}

export function createScanList(opts: ScanListOptions) {
  const body = h("div", { class: "td-scan-rows", role: "table", "aria-label": "Your focus list, as the AI reads it" }) as HTMLElement;
  renderEffect(() => {
    const list = opts.focus();
    if (list.length === 0) {
      body.replaceChildren(pkEmpty("empty", "Nothing on your focus list. Add symbols in Your plan."));
      return;
    }
    const inp = opts.inputs();
    const head = h(
      "div",
      { class: "td-scan-row td-scan-head", role: "row" },
      ...["Symbol", "What the AI sees", "Side", "Checks", "Why it matters", ""].map((t) =>
        h("span", { role: "columnheader", text: t }),
      ),
    );
    const rows = list.map((sym) => {
      const r = readFocus(sym, inp);
      return h(
        "div",
        { class: "td-scan-row", role: "row", "data-source": r.source, "data-live": String(r.live) },
        h("strong", { class: "td-scan-sym", role: "cell", text: r.symbol }),
        h("span", { class: "td-scan-sees", role: "cell", text: r.sees }),
        h("span", { class: "td-scan-side", role: "cell", text: r.side ?? "—" }),
        h("span", {
          class: "td-scan-checks num",
          role: "cell",
          text: r.checks ?? "—",
          ...(r.checks === null ? { title: CHECKS_ONLY_ON_CHART } : {}),
        }),
        h("span", { class: "td-scan-why", role: "cell", text: r.why }),
        h(
          "span",
          { role: "cell" },
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            text: "Open",
            "aria-label": `Open ${r.symbol} on the chart`,
            onclick: () => opts.onPick(r.symbol),
          }),
        ),
      );
    });
    body.replaceChildren(head, ...rows);
  });

  const el = todayCard(
    "AI scanned your list",
    "ai",
    "td-scan",
    body,
    pkWhy(
      `The chart's symbol is read by the Setup card, which runs the checks. Every other row is the last Opportunities scan: it finds a setup and replays its history, but does not run the checks — so those rows show a dash. Nothing here is a new analysis.`,
      "Why?",
    ),
  );
  return { el };
}
