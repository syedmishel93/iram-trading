/**
 * The dock verdict: the Setup card's conclusion, pinned above the scroll.
 *
 * Moved out of `mountShell` in v59. Everything it shows is the Setup card's
 * own `setupView`, so the banner and the card cannot disagree.
 */

import { scheduleFrame } from "../../core/frame";
import { currenciesFor, releaseRisk, type CalendarFeed } from "../../data/calendar";
import { clear, h } from "../dom";
import { renderEffect, type ReadSignal } from "../../core/signal";
import type { ShellContext } from "./context";
import type { createSetupModel } from "../model/setup";
import { fmtPx } from "./format";

export interface DockVerdictDeps {
  readonly setupView: ReturnType<typeof createSetupModel>["view"];
  readonly setupLast: ReturnType<typeof createSetupModel>["last"];
  readonly calendar: ReadSignal<CalendarFeed | null>;
  /** The dock's scroll body, assigned when the dock mounts — read late. */
  readonly dockBody: () => HTMLElement | null;
  /**
   * v59.2: open one card, putting it back on the column first if it was
   * removed. The Setup card is OFF the column by default in the v5 design,
   * so scrolling to it (the old behaviour) would silently do nothing.
   */
  readonly reveal?: (id: string) => void;
}

/**
 * THE ANSWER, PINNED ABOVE THE ARGUMENT.
 *
 * The column now reads as reasoning in decision order, which puts the Setup
 * card fourth — so its conclusion is restated here, above the scroll, where
 * it cannot be scrolled away. Nothing here is computed afresh: the kind, the
 * blocking gate, the watch level and the plan are all the Setup card's own
 * `setupView`, so the banner and the card cannot disagree.
 *
 * Two things are added, both already true elsewhere: a scheduled release
 * inside the hour (from the calendar the Risk-check section holds, which is
 * closed by default — closed must not mean unseen), and a button that opens
 * and scrolls to the full plan.
 */
export function createDockVerdict(ctx: ShellContext, deps: DockVerdictDeps): HTMLElement {
  const { state } = ctx;
  const { setupView, setupLast, calendar, dockBody } = deps;

  const dockVerdict = h("div", {
    class: "dock-verdict",
    ref: (el: HTMLElement) =>
      renderEffect(() => {
        const v = setupView();
        clear(el);
        if (!v) {
          el.dataset["kind"] = "loading";
          el.appendChild(h("div", { class: "dv-title", text: "Reading the chart…" }));
          return;
        }
        const plan = v.plan;
        const dir = plan ? (plan.direction === "long" ? "Long" : "Short") : null;
        const kind = v.setupRefusal ? "none" : v.verdict.kind;
        el.dataset["kind"] = kind;

        const title =
          kind === "none"
            ? "No setup"
            : kind === "go"
              ? "All checks pass"
              : kind === "armed"
                ? "Waiting for entry"
                : kind === "conflict"
                  ? "Checks pass, wider market disagrees"
                  : kind === "stand-down"
                    ? "No trade"
                    : "Can't check yet";

        const first = (gs: readonly { text: string }[]): string =>
          gs.length === 0 ? "" : `${gs[0]?.text ?? ""}${gs.length > 1 ? ` (+${gs.length - 1} more)` : ""}`;
        const reason =
          kind === "none"
            ? v.setupRefusal ?? ""
            : kind === "stand-down"
              ? first(v.verdict.blocking)
              : kind === "unknown"
                ? first(v.verdict.unknown)
                : kind === "armed" && v.verdict.watchLevel !== null
                  ? `Waiting for price to reach ${fmtPx(v.verdict.watchLevel)}.`
                  : kind === "conflict"
                    ? v.verdict.conflictNote ?? ""
                    : `${v.verdict.passed} of ${v.verdict.total} checks pass.`;

        /* v55: the Fusion verdict card — the gate count as a ring, so the
           number and the picture are one fact, beside the title. SVG built
           with the namespace, because `h` makes HTML elements. */
        const NS = "http://www.w3.org/2000/svg";
        const svg = (tag: string, attrs: Record<string, string>): SVGElement => {
          const node = document.createElementNS(NS, tag);
          for (const [k, val] of Object.entries(attrs)) node.setAttribute(k, val);
          return node;
        };
        const total = Math.max(1, v.verdict.total);
        const circ = 2 * Math.PI * 26;
        const ring = svg("svg", { width: "64", height: "64", viewBox: "0 0 64 64", class: "dv-ring", role: "img", "aria-label": `${v.verdict.passed} of ${v.verdict.total} checks pass` });
        ring.appendChild(svg("circle", { cx: "32", cy: "32", r: "26", fill: "none", "stroke-width": "7", class: "dv-ring-track" }));
        if (kind !== "none") {
          ring.appendChild(
            svg("circle", {
              cx: "32", cy: "32", r: "26", fill: "none", "stroke-width": "7", "stroke-linecap": "round", class: "dv-ring-arc",
              "stroke-dasharray": `${((circ * v.verdict.passed) / total).toFixed(1)} ${circ.toFixed(1)}`,
              transform: "rotate(-90 32 32)",
            }),
          );
        }
        const num = svg("text", { x: "32", y: "32", "text-anchor": "middle", "font-size": "15", class: "dv-ring-num" });
        num.textContent = kind === "none" ? "—" : `${v.verdict.passed}/${v.verdict.total}`;
        const cap = svg("text", { x: "32", y: "45", "text-anchor": "middle", "font-size": "9", class: "dv-ring-cap" });
        cap.textContent = "checks";
        ring.appendChild(num);
        ring.appendChild(cap);

        el.appendChild(
          h(
            "div",
            { class: "dv-top" },
            ring as unknown as HTMLElement,
            h(
              "div",
              { class: "dv-titles" },
              h(
                "div",
                { class: "dv-sub" },
                /* The engine's human label ("Change of character"), not the
                   detector id ("choch") the verdict carries. `setupLast.choice` is
                   written by the same `setupView` computation read above, so
                   it describes the same moment. */
                h("span", {
                  text:
                    kind === "none"
                      ? "Nothing to trade"
                      : setupLast.choice?.best?.candidate.label ?? v.verdict.strategy ?? "Discretionary read",
                }),
                dir && kind !== "none" ? h("span", { class: "dv-dir", "data-dir": plan?.direction ?? "", text: dir }) : document.createComment(""),
              ),
              h("span", { class: "dv-title", text: title }),
            ),
          ),
        );
        if (reason) el.appendChild(h("p", { class: "dv-reason", text: reason }));

        if (plan && kind !== "none") {
          const cell = (k: string, val: string, tone?: string): HTMLElement =>
            h(
              "span",
              { class: "dv-cell", ...(tone ? { "data-tone": tone } : {}) },
              h("span", { class: "dv-k", text: k }),
              h("span", { class: "dv-v num", text: val }),
            );
          el.appendChild(
            h(
              "div",
              { class: "dv-plan" },
              cell("Entry", `${fmtPx(plan.entryLow)}–${fmtPx(plan.entryHigh)}`),
              cell("Stop", fmtPx(plan.stop), "neg"),
              cell("Target", fmtPx(plan.target1), "pos"),
            ),
          );
        }

        const c = calendar();
        if (c?.ok) {
          const risk = releaseRisk(c.events, { now: Date.now(), currencies: currenciesFor(state.symbol()) });
          if (risk.next) {
            el.appendChild(
              h("p", {
                class: "dv-release",
                "data-impact": risk.next.event.impact,
                text: `${risk.next.event.currency} ${risk.next.event.title} in ${Math.max(0, Math.round((risk.next.event.at - Date.now()) / 60_000))} min`,
                title: risk.note,
              }),
            );
          }
        }

        el.appendChild(
          h("button", {
            class: "dv-open-primary",
            type: "button",
            text: "Review the full plan",
            onclick: () => {
              if (deps.reveal) {
                deps.reveal("setup");
                return;
              }
              if (state.dockMode() === "stack") state.dockCard.set("setup");
              else if (!state.dockOpenIds().includes("setup")) state.dockOpenIds.set([...state.dockOpenIds(), "setup"]);
              scheduleFrame(() =>
                dockBody()?.querySelector('[data-panel="setup"]')?.scrollIntoView({ block: "start", behavior: "smooth" }),
              );
            },
          }),
        );
      }),
  });

  return dockVerdict;
}
