/**
 * "Your say" under the verdict: Use this plan · Adjust · Not for me.
 *
 * The verdict is the terminal's recommendation; this row is the operator's
 * answer, recorded (`journal/says.ts`) so Review can compare what was
 * recommended with what was decided. Shown only when there IS a plan to
 * answer — "No setup" and "Can't check yet" ask nothing of you.
 *
 * "Use this plan" and "Adjust" go where the Setup card's own buttons go (the
 * Calculator and the Decision desk); nothing here places an order.
 */

import { h } from "../dom";
import { renderEffect, signal } from "../../core/signal";
import { PASS_REASONS, createSayStore, sayFor, setupKey, type SayChoice } from "../../journal/says";
import type { ShellContext } from "./context";
import type { ShellState } from "./state";
import type { createSetupModel } from "../model/setup";

/**
 * What the row actually needs from the shell: the store to record into and the
 * instrument the answer is about.
 *
 * DERIVED from `ShellContext` and `ShellState` with `Pick`, never restated — a
 * hand-written `{ kv, state: { symbol } }` would be a second declaration of
 * two types that already exist, free to drift from them, which is the exact
 * mistake CLAUDE.md records three defects for. A full `ShellContext` satisfies
 * this structurally, so `mountShell` passes its own and nothing changes there;
 * a test can build the two signals and the store instead of forty.
 */
export type SayContext = Pick<ShellContext, "kv"> & {
  readonly state: Pick<ShellState, "symbol" | "timeframe">;
};

export interface YourSayDeps {
  readonly setupView: ReturnType<typeof createSetupModel>["view"];
  readonly onUse: () => void;
  readonly onAdjust: () => void;
}

/** Verdict kinds that carry a plan to answer. */
const ANSWERABLE = new Set(["go", "armed", "conflict"]);

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * What the operator is being asked to answer.
 *
 * `verdict` is the recommendation's KIND, and it is part of the say's identity
 * — so an autonomous proposal passes its own (`auto:<rule id>`) rather than
 * borrowing the Setup card's. Null means there is nothing to answer, and the
 * row hides itself.
 */
export interface SaySubject {
  readonly verdict: string;
  readonly direction: "long" | "short" | null;
  readonly entry: number | null;
}

export interface SayRowDeps {
  readonly subject: () => SaySubject | null;
  readonly onUse: () => void;
  readonly onAdjust: () => void;
}

/**
 * The row itself, over any subject.
 *
 * Extracted from `createYourSay` when the recommendation card grew an
 * Autonomous mode: the operator answers a discovered strategy the same way
 * they answer the Setup card's plan, and two implementations of "Use this plan
 * · Adjust · Not for me" would be two records the Review workspace has to
 * reconcile. One row, one store, one shape of `Say`.
 */
export function createSayRow(ctx: SayContext, d: SayRowDeps): HTMLElement {
  const { state, kv } = ctx;
  const store = createSayStore(kv);
  /* kv reads are not reactive; this ticks after every write. */
  const rev = signal(0);
  const picking = signal(false);

  const el = h("div", { class: "say" }) as HTMLElement;
  renderEffect(() => {
    rev();
    const subject = d.subject();
    el.replaceChildren();
    el.hidden = subject === null;
    if (!subject) return;
    const kind = subject.verdict;
    const direction = subject.direction;
    const key = setupKey({
      symbol: state.symbol(),
      timeframe: state.timeframe(),
      verdict: kind,
      direction,
      entry: subject.entry,
    });
    const said = sayFor(store.all(), key);

    const record = (choice: SayChoice, reason = ""): void => {
      store.record({ at: Date.now(), key, symbol: state.symbol(), timeframe: state.timeframe(), verdict: kind, direction, choice, reason });
      picking.set(false);
      rev.update((n) => n + 1);
    };

    el.appendChild(
      h("div", { class: "say-head" }, h("span", { class: "say-label", text: "Your say" }), h("span", { class: "card-who", "data-who": "you", text: "You" })),
    );

    if (said) {
      const what =
        said.choice === "use" ? "You took this plan" : said.choice === "adjust" ? "You chose to adjust it" : `You passed — ${said.reason.toLowerCase()}`;
      el.appendChild(
        h(
          "div",
          { class: "say-done", "data-choice": said.choice },
          h("span", { text: `${what} · ${clock(said.at)}` }),
          h("button", {
            class: "say-undo",
            type: "button",
            text: "Undo",
            onclick: () => {
              store.undo(key);
              rev.update((n) => n + 1);
            },
          }),
        ),
      );
      return;
    }

    if (picking()) {
      el.appendChild(
        h(
          "div",
          { class: "say-reasons", role: "group", "aria-label": "Why not?" },
          ...PASS_REASONS.map((r) => h("button", { class: "say-reason", type: "button", text: r, onclick: () => record("pass", r) })),
          h("button", { class: "say-cancel", type: "button", text: "Cancel", onclick: () => picking.set(false) }),
        ),
      );
      return;
    }

    el.appendChild(
      h(
        "div",
        { class: "say-actions" },
        h("button", {
          class: "primary-btn say-btn",
          type: "button",
          text: "Use this plan",
          title: "Record that you took it, and open the Calculator to size it",
          onclick: () => {
            record("use");
            d.onUse();
          },
        }),
        h("button", {
          class: "ghost-btn say-btn",
          type: "button",
          text: "Adjust",
          title: "Record it, and open the Decision desk to change the plan",
          onclick: () => {
            record("adjust");
            d.onAdjust();
          },
        }),
        h("button", {
          class: "ghost-btn say-btn",
          type: "button",
          text: "Not for me",
          title: "Pass on it, with a reason Review can learn from",
          onclick: () => picking.set(true),
        }),
      ),
    );
  });
  return el;
}

/**
 * The row over the Setup card's verdict — what this module was, unchanged on
 * screen. Shown only when the verdict carries a plan to answer: "No setup" and
 * "Can't check yet" ask nothing of you.
 */
export function createYourSay(ctx: ShellContext, d: YourSayDeps): HTMLElement {
  return createSayRow(ctx, {
    subject: () => {
      const v = d.setupView();
      if (!v) return null;
      const kind = v.setupRefusal ? "none" : v.verdict.kind;
      if (!ANSWERABLE.has(kind)) return null;
      const plan = v.plan;
      return { verdict: kind, direction: plan ? plan.direction : null, entry: plan ? plan.entry : null };
    },
    onUse: d.onUse,
    onAdjust: d.onAdjust,
  });
}
