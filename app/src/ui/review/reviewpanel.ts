/**
 * Review — "AI finds · you judge". The top of the Journal desk.
 *
 * Two sections, from the approved v5 design (`docs/iram-redesign-v5.html`,
 * `#ws-review`):
 *
 *   WHAT THE AI NOTICED (AI) — the six checks in `journal/patterns.ts`, run on
 *   your real trades. Only the ones that FOUND something are shown up front,
 *   each with its numbers and two buttons for you: True / Not true. The rest
 *   sit behind "What was checked", each with the reason it did not report —
 *   too few trades (and how many are needed), or the field it cannot see.
 *
 *   NEXT WEEK'S RULE (You) — the AI proposes a rule from the strongest finding
 *   you marked True; you word it and commit it. Committed rules are listed
 *   with their date and the finding they answered.
 *
 * THE MOCKUP'S ROWS WERE A TEST FIXTURE and are not here. With no closed
 * trades this says so and shows nothing else — a review of an empty record
 * that produced findings would be fabricating them.
 *
 * One persistent element, like the fills panel: the Journal desk re-renders
 * itself on every change, and a half-typed rule must survive that. Only the
 * findings and the rule list are rebuilt; the text box never is.
 */

import { h, clear } from "../dom";
import { pkEmpty, pkWhy } from "../panelkit";
import { renderEffect, type ReadSignal } from "../../core/signal";
import type { Journal } from "../../journal/store";
import type { FillsResult } from "../../data/fills";
import type { CalendarFeed } from "../../data/calendar";
import {
  calendarWindow,
  checkPatterns,
  fromFills,
  fromJournal,
  proposeRule,
  tradeSource,
  type Pattern,
  type PatternState,
} from "../../journal/patterns";
import type { ReviewStore } from "../../journal/review";
import type { Say } from "../../journal/says";

export interface ReviewSectionOptions {
  readonly journal: Journal;
  /** The fills panel's latest load; null while the first is in flight. */
  readonly fills: ReadSignal<FillsResult | null>;
  readonly store: ReviewStore;
  /** The shell's economic calendar. Absent: the news check says it cannot check. */
  readonly calendar?: () => CalendarFeed | null;
  readonly notify: (level: "info" | "warn", title: string, body: string) => void;
  /** The decision log (`journal/says.ts`). Absent: the "what you pass on" check cannot check. */
  readonly says?: () => readonly Say[];
}

const STATE_LABEL: Record<PatternState, string> = {
  found: "found",
  "not-found": "nothing there",
  "too-few": "too few trades",
  "cannot-check": "cannot check",
};

const day = (ms: number): string => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

export function createReviewSection(opts: ReviewSectionOptions): HTMLElement {
  const { store } = opts;
  const el = h("section", { class: "rv" }) as HTMLElement;

  const sourceLine = h("p", { class: "rv-sub" }) as HTMLElement;
  const finds = h("div", { class: "rv-finds" }) as HTMLElement;
  const proposal = h("div", { class: "rv-proposal" }) as HTMLElement;
  const done = h("p", { class: "rv-done", role: "status" }) as HTMLElement;
  const ruleList = h("div", { class: "rv-rules" }) as HTMLElement;

  /* The draft is the operator's. The proposal fills the box only while they
     have not typed in it; once they have, a new proposal never overwrites it. */
  let edited = false;
  let lastProposal: string | null = null;
  let current: ReturnType<typeof proposeRule> = null;

  const box = h("textarea", {
    class: "rv-box",
    rows: 3,
    "aria-label": "Next week's rule",
    placeholder: "Write the rule you will hold yourself to.",
    oninput: () => {
      edited = box.value.trim() !== "";
    },
  }) as HTMLTextAreaElement;

  const commit = (): void => {
    const text = box.value;
    const fromProposal = current !== null && text.trim() === current.text;
    const r = store.commit(text, current?.from ?? null, current?.claim ?? "");
    if (!r.ok) {
      done.textContent = r.reason;
      done.dataset["tone"] = "warn";
      return;
    }
    box.value = "";
    edited = false;
    done.textContent = `Committed${fromProposal ? "" : " in your words"}. ${r.local}`;
    done.dataset["tone"] = "pos";
    opts.notify("info", "Rule committed", r.rule.text);
  };

  el.append(
    h(
      "header",
      { class: "rv-head" },
      h("span", { class: "card-who", "data-who": "both", text: "AI finds · you judge" }),
      h("h2", { class: "rv-title", text: "The AI studies your trades. You decide what's true." }),
      sourceLine,
    ),
    h(
      "div",
      { class: "rv-grid" },
      h(
        "section",
        { class: "rv-card", "data-who": "ai" },
        h("div", { class: "rv-card-head" }, h("span", { class: "rv-card-title", text: "What the AI noticed" }), h("span", { class: "card-who", "data-who": "ai", text: "AI" })),
        finds,
      ),
      h(
        "section",
        { class: "rv-card", "data-who": "you" },
        h("div", { class: "rv-card-head" }, h("span", { class: "rv-card-title", text: "Next week's rule" }), h("span", { class: "card-who", "data-who": "you", text: "You" })),
        h("p", { class: "rv-note", text: "The AI proposes; you word it and commit." }),
        proposal,
        box,
        h("button", { class: "primary-btn rv-commit", type: "button", text: "Commit", onclick: commit }),
        done,
        ruleList,
      ),
    ),
  );

  function judgeRow(p: Pattern): HTMLElement {
    const j = store.verdict(p.id);
    const btn = (verdict: "true" | "false", label: string): HTMLElement =>
      h("button", {
        class: "detect-seg-btn",
        type: "button",
        text: label,
        "data-on": String(j?.verdict === verdict),
        "aria-pressed": String(j?.verdict === verdict),
        onclick: () => (j?.verdict === verdict ? store.unjudge(p.id) : store.judge(p.id, verdict, p.claim)),
      }) as HTMLElement;
    return h(
      "div",
      { class: "rv-judge" },
      h("div", { class: "detect-seg", role: "group", "aria-label": "Your judgement" }, btn("true", "True"), btn("false", "Not true")),
      j === null
        ? h("span", { class: "rv-fine", text: "Not judged yet." })
        : h("span", {
            class: "rv-fine",
            text: `You marked this ${j.verdict === "true" ? "true" : "not true"} on ${day(j.at)}.${j.claim !== p.claim ? " It read differently then." : ""}`,
            title: j.claim,
          }),
    ) as HTMLElement;
  }

  function finding(p: Pattern, i: number): HTMLElement {
    return h(
      "article",
      { class: "rv-find", "data-pattern": p.id },
      h("span", { class: "rv-n num", text: String(i + 1) }),
      h(
        "div",
        { class: "rv-find-body" },
        h("p", { class: "rv-claim", text: p.claim }),
        h(
          "div",
          { class: "rv-nums" },
          h("span", { class: "rv-num" }, h("span", { class: "rv-num-l", text: "Trades" }), h("span", { class: "rv-num-v num", text: `${p.n}` })),
          ...p.numbers.map((x) => h("span", { class: "rv-num" }, h("span", { class: "rv-num-l", text: x.label }), h("span", { class: "rv-num-v num", text: x.value }))),
        ),
        judgeRow(p),
        pkWhy(`${p.reason} ${p.working}${p.source === "fills" ? " Read from your MT5 fills." : " Read from your journal."}`, "Why?"),
      ),
    ) as HTMLElement;
  }

  function checkedList(all: readonly Pattern[]): HTMLElement {
    return h(
      "details",
      { class: "rv-checked" },
      h("summary", { class: "rv-checked-sum", text: `What was checked (${all.length})` }),
      h(
        "ul",
        { class: "rv-checked-list" },
        ...all.map((p) =>
          h(
            "li",
            { class: "rv-check", "data-state": p.state, "data-pattern": p.id },
            h("span", { class: "rv-check-name", text: p.check }),
            h("span", { class: "rv-check-state", "data-state": p.state, text: STATE_LABEL[p.state] }),
            h("span", { class: "rv-check-why", text: p.state === "found" ? p.claim : p.reason }),
            h("span", { class: "rv-check-min num", text: `${p.n} used · needs ${p.minN}` }),
          ),
        ),
      ),
    ) as HTMLElement;
  }

  function renderFinds(): void {
    clear(finds);
    const fr = opts.fills();
    const journalTrades = fromJournal(opts.journal.entries());
    const fillTrades = fr?.state === "ok" ? fromFills(fr.fills) : [];
    const input = { fills: fillTrades, journal: journalTrades, calendar: calendarWindow(opts.calendar?.() ?? null), says: opts.says?.() ?? null };
    const { source, trades } = tradeSource(input);

    const fillsNote =
      fr === null ? "MT5 fills are still loading." : fr.state === "ok" ? "" : `No MT5 fills: ${fr.reason}`;
    sourceLine.textContent =
      trades.length === 0
        ? `From your MT5 fills and your journal. ${fillsNote}`.trim()
        : source === "fills"
          ? `From ${trades.length} MT5 fills over ${fr?.state === "ok" ? fr.days : "?"} days, and your journal for planned targets.`
          : `From ${trades.length} closed journal trades. ${fillsNote}`.trim();

    if (trades.length === 0 && journalTrades.length === 0) {
      finds.appendChild(
        fr === null
          ? pkEmpty("loading", "Reading your trades…")
          : pkEmpty("empty", "No closed trades yet, so there is nothing to study. Sync your MT5 fills below, or record and close trades in the journal."),
      );
      current = null;
      renderRule();
      return;
    }

    const all = checkPatterns(input);
    const found = all.filter((p) => p.state === "found");
    if (found.length === 0) {
      finds.appendChild(
        h("p", {
          class: "rv-none",
          text: `Nothing stands out in ${trades.length} trade${trades.length === 1 ? "" : "s"}. ${all.filter((p) => p.state === "too-few" || p.state === "cannot-check").length} of ${all.length} checks could not run yet — see what was checked.`,
        }),
      );
    } else {
      found.forEach((p, i) => finds.appendChild(finding(p, i)));
    }
    finds.appendChild(checkedList(all));
    finds.appendChild(
      pkWhy(
        "Seven fixed checks, named in advance, so a pattern is never whichever slice of your trades happened to look worst. Each needs a minimum number of trades and a real gap. The seventh only counts your reasons for passing on the AI's recommendations — it cannot grade a pass, because a pass has no result. Even so, the six trade checks at 5% each will show one false 'found' in roughly one review in four on a record with no pattern at all — which is why you judge each one.",
        "How the AI looks",
      ),
    );

    current = proposeRule(all, (id) => store.verdict(id)?.verdict ?? null);
    renderRule();
  }

  function renderRule(): void {
    clear(proposal);
    if (current === null) {
      proposal.appendChild(h("p", { class: "rv-fine", text: "No proposal yet. Mark a finding True and the AI will word a rule from the strongest one. You can also write your own." }));
    } else {
      proposal.appendChild(h("p", { class: "rv-fine", text: `Proposed from: ${current.claim}` }));
    }
    const text = current?.text ?? null;
    if (text !== lastProposal) {
      lastProposal = text;
      if (!edited) box.value = text ?? "";
    }

    clear(ruleList);
    const rules = store.rules();
    if (rules.length > 0) {
      ruleList.appendChild(h("span", { class: "rv-list-label", text: "Committed" }));
      for (const r of rules) {
        ruleList.appendChild(
          h(
            "div",
            { class: "rv-rule" },
            h("p", { class: "rv-rule-text", text: r.text }),
            h("span", { class: "rv-fine", text: `${day(r.at)}${r.because ? ` · because: ${r.because}` : " · your own"}` }),
            h("button", { class: "ghost-btn rv-retire", type: "button", text: "Retire", title: "Stop holding yourself to this rule.", onclick: () => store.retire(r.id) }),
          ),
        );
      }
      const s = store.server();
      ruleList.appendChild(
        h("p", {
          class: "rv-fine",
          text: store.memoryOnly
            ? "Kept for this session only — no browser storage was available."
            : s === null
              ? "Saved in this browser."
              : s.state === "saved"
                ? `Saved in this browser and on ${s.where}.`
                : `Saved in this browser only. ${s.reason}`,
        }),
      );
    }
  }

  renderEffect(() => {
    store.judgements();
    store.rules();
    store.server();
    renderFinds();
  });

  return el;
}
