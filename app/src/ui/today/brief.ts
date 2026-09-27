/**
 * The AI morning brief — the Briefing desk's answer, said first and short.
 *
 * It states no new fact. Every line is a sentence another module already
 * produced: the Setup card's verdict headline and read line, the live
 * engine's newest event, the watch rail's live reads, `portfolioHeat`'s list
 * of positions with no stop. The six cards under the workspace carry the
 * detail and the owner links; this is their first line each, in the order a
 * trader needs them: the answer, the danger, what moved, where else.
 */

import { h } from "../dom";
import { renderEffect } from "../../core/signal";
import { todayCard } from "./card";
import type { SetupView } from "../../setup/ui";
import type { LiveEvent } from "../../analysis/live";
import type { WatchSetup } from "../watchrail";

export interface BriefInputs {
  readonly symbol: string;
  readonly setup: SetupView | null;
  /** Newest last, as the live engine keeps them. */
  readonly events: readonly LiveEvent[];
  readonly opportunities: ReadonlyMap<string, WatchSetup>;
  readonly scanned: boolean;
  /** Open positions with no stop, from `portfolioHeat`. */
  readonly unprotected: readonly string[];
}

export interface Brief {
  /** The answer, one line. */
  readonly headline: string;
  readonly lines: readonly string[];
}

/** How many other live symbols the brief names before it says "and N more". */
const NAME_CAP = 3;

/** The brief. PURE, so every sentence it can say is testable. */
export function briefOf(i: BriefInputs): Brief {
  const lines: string[] = [];
  const headline =
    i.setup === null ? `${i.symbol}: not enough data yet.` : `${i.symbol}: ${i.setup.verdict.headline}`;
  lines.push(i.setup === null ? "Needs at least 30 closed bars before it can be read." : i.setup.verdict.readLine);

  if (i.unprotected.length > 0) {
    lines.push(`No stop on ${i.unprotected.join(", ")} — real risk is higher than shown.`);
  }

  let latest: LiveEvent | undefined;
  for (let k = i.events.length - 1; k >= 0; k--) {
    const e = i.events[k];
    if (e !== undefined && e.severity !== "info") {
      latest = e;
      break;
    }
  }
  lines.push(latest === undefined ? "Nothing important has changed since this chart loaded." : `Latest: ${latest.what}`);

  const live = [...i.opportunities.entries()].filter(([sym, s]) => s.live && sym !== i.symbol).map(([sym]) => sym);
  if (live.length > 0) {
    const named = live.slice(0, NAME_CAP).join(", ");
    const more = live.length > NAME_CAP ? ` and ${live.length - NAME_CAP} more` : "";
    lines.push(`Live setups elsewhere: ${named}${more}.`);
  } else {
    lines.push(i.scanned ? "No live setup on the rest of your list." : "The rest of your list is not scanned yet.");
  }
  return { headline, lines };
}

export interface BriefCardOptions {
  readonly inputs: () => BriefInputs;
  /** Open the chart (already on this symbol). */
  onOpenChart(): void;
  /** Open the analyst. Absent: the button says it is not connected here. */
  readonly onAsk?: ((question?: string) => void) | undefined;
}

export function createBriefCard(opts: BriefCardOptions) {
  const body = h("div", { class: "td-brief-read" }) as HTMLElement;
  renderEffect(() => {
    const b = briefOf(opts.inputs());
    body.replaceChildren(
      h("p", { class: "td-brief-answer", text: b.headline }),
      ...b.lines.map((l) => h("p", { class: "td-brief-line", text: l })),
    );
  });
  const ask = opts.onAsk;
  const el = todayCard(
    "AI morning brief",
    "ai",
    "td-brief",
    body,
    h(
      "div",
      { class: "td-actions" },
      h("button", {
        class: "primary-btn",
        type: "button",
        text: () => `Open ${opts.inputs().symbol} chart`,
        onclick: () => opts.onOpenChart(),
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: "Ask a follow-up",
        disabled: ask === undefined,
        ...(ask === undefined ? { title: "The analyst is not connected to this desk." } : {}),
        onclick: () => ask?.(),
      }),
    ),
  );
  return { el };
}
