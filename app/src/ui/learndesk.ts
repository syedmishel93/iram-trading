/**
 * Learning — what the terminal has claimed, what happened, and what it keeps.
 *
 * WHY THIS DESK IS NOT A LIST OF MODELS
 * The obvious build is a page of model scores: AUC here, Brier there, a
 * feature-importance bar chart, a "retrain" button. Every platform has one and
 * it answers a question nobody should be asking, because all of those numbers
 * describe how well a model fitted the PAST IT WAS SHOWN. This repository has
 * already measured what that is worth on its own strategy set: a PBO of 89%,
 * which says the best-looking candidate is worse than the median about nine
 * times in ten.
 *
 * So the first and largest thing on this desk is not a model. It is the
 * terminal's own record of claims it made in real time and what the market did
 * next — the one form of evidence that cannot be overfitted after the fact,
 * because it was written down before the outcome existed.
 *
 * THE THREE QUESTIONS, IN ORDER OF HOW MUCH THEY MATTER
 *
 *   1. When it told you to take something, what happened?
 *   2. Do the gates earn their refusals — did what they BLOCKED do worse than
 *      what they cleared? Nothing else in the terminal can answer this, and it
 *      is allowed to answer "no".
 *   3. Does the score carry any information at all — do stronger reads resolve
 *      better than weak ones, or is the band chart flat?
 *
 * Model runs come fourth, and they are here for drift — "does it still say
 * what it said last time" — rather than for the score itself.
 *
 * WHAT THE DESK WILL NOT DO
 * There is no button here that changes a weight, a threshold or a rule. The
 * loop stays open and the human closes it; `learn/store.ts` carries the full
 * argument for why. What this desk changes is what you know.
 */

import { h, clear } from "./dom";
import { trackRecordCard } from "./cards/trackrecord";
import { computed, renderEffect, signal } from "../core/signal";
import { pkChip, pkEmpty, pkRows, pkWhy, type PkRow } from "./panelkit";
import { allTerms, explain } from "./plain";
import type { LearnStore } from "../learn/store";
import type { Claim } from "../learn/claim";
import { claimR, claimR_realised } from "../learn/claim";
import { scorecard, type Population, type Proportion } from "../learn/scorecard";
import { drift, type ModelRun } from "../learn/run";

export interface LearnDeskOptions {
  readonly store: LearnStore;
  /**
   * The in-sample replay table, if the shell has one to give.
   *
   * Optional so this desk still builds without it — but the pairing is the
   * reason it is here rather than on its own desk. Everything above it is out
   * of sample; the table is not, and the two sitting together is what lets a
   * reader see them disagree. See `ui/kindtable.ts`.
   */
  readonly kindTable?: () => HTMLElement;
  readonly symbol: () => string;
  /** Jump the chart to an instrument, so a claim row is clickable. */
  readonly openSymbol: (symbol: string, timeframe: string) => void;
  /** Re-run the sweep against everything currently loaded. */
  readonly resolveNow: () => void;
  readonly now?: () => number;
}

export interface LearnDeskHandle {
  readonly el: HTMLElement;
}

const pct = (v: number): string => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");
const rr = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : "—");

/** `3 days ago` / `4 hours ago` / `just now`. */
export function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** `in 2 hours` / `overdue`. What a pending claim is still waiting for. */
export function until(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "past its deadline";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min left`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} left`;
  return `${Math.round(hr / 24)} days left`;
}

const OUTCOME_WORDS: Record<Claim["outcome"], string> = {
  pending: "waiting",
  target: "reached its target",
  stop: "hit its stop",
  expired: "ran out of time",
  unknowable: "cannot be judged",
};

/**
 * A proportion, rendered as a bar with its uncertainty drawn on it.
 *
 * The interval is drawn as the LIGHT part and the point estimate as a line
 * inside it, rather than the usual solid bar with an error whisker bolted on.
 * That is deliberate: a solid bar reads as a fact and the whisker reads as
 * decoration, which is precisely backwards when n is 4. Here the wide pale band
 * IS the visual weight, so a small sample looks uncertain at a glance and
 * nobody has to read the caption to find that out.
 */
function rateBar(p: Proportion): HTMLElement {
  const lo = Number.isFinite(p.low) ? p.low : 0;
  const hi = Number.isFinite(p.high) ? p.high : 0;
  const mid = Number.isFinite(p.rate) ? p.rate : 0;
  return h(
    "div",
    { class: "ld-bar", title: `${p.hits} of ${p.n}. 95% range ${pct(p.low)} to ${pct(p.high)}.` },
    h("div", { class: "ld-bar-track" },
      h("div", {
        class: "ld-bar-range",
        style: `left:${(lo * 100).toFixed(1)}%;width:${Math.max(0.5, (hi - lo) * 100).toFixed(1)}%`,
      }),
      p.n > 0
        ? h("div", { class: "ld-bar-point", style: `left:${(mid * 100).toFixed(1)}%` })
        : null,
      /* A coin, marked, because every rate on this desk is a rate against
         chance and the reader should not have to hold 50% in their head. */
      h("div", { class: "ld-bar-coin" }),
    ),
    h("span", {
      class: "ld-bar-value",
      "data-weak": String(!p.reportable),
      text: p.n === 0 ? "—" : p.reportable ? pct(p.rate) : `${p.hits}/${p.n}`,
    }),
  );
}

function populationRows(p: Population): readonly PkRow[] {
  return [
    { label: "Recorded", value: String(p.total) },
    { label: "Settled", value: String(p.decided) },
    ...(p.pending > 0 ? [{ label: "Still waiting", value: String(p.pending) }] : []),
    ...(p.unknowable > 0
      ? [
          {
            label: "Unjudgeable",
            value: String(p.unknowable),
            note: "One bar covered both the target and the stop, so which came first is not knowable from the data. Dropped rather than guessed.",
          },
        ]
      : []),
    ...(p.expired > 0
      ? [
          {
            label: "Ran out of time",
            value: String(p.expired),
            note: "Reached neither the target nor the stop before its horizon ended. Its own outcome, not a loss — counting it as one would say nothing happened and being wrong look the same. Kept out of the rate above, and named here because it is in the recorded total.",
          },
        ]
      : []),
    {
      label: "Average outcome",
      value: rr(p.expectancyR),
      ...(Number.isFinite(p.expectancyR) && Number.isFinite(p.plannedR)
        ? { note: `Planned ${p.plannedR.toFixed(1)}R per claim.` }
        : {}),
      ...(Number.isFinite(p.expectancyR) ? { tone: p.expectancyR >= 0 ? ("pos" as const) : ("neg" as const) } : {}),
    },
  ];
}

export function createLearnDesk(opts: LearnDeskOptions): LearnDeskHandle {
  const now = opts.now ?? Date.now;
  const store = opts.store;
  const tab = signal<"record" | "runs" | "words">("record");
  const notice = signal("");

  const card = computed(() => scorecard(store.claims()));

  const el = h("div", { class: "ld" });

  /* ---- head: what this is, and the one switch it owns ------------------- */

  const head = h(
    "section",
    { class: "ld-head" },
    h("div", { class: "ld-head-text" },
      h("h2", { class: "ld-h1", text: "What this terminal has learned" }),
      h("p", {
        class: "ld-lede",
        text:
          "Every read the Setup card produces is written down here with the levels that would prove it right or wrong, before the outcome exists. Once your own bars reach past the deadline, it gets marked. Nothing on this page adjusts a score or a rule — it measures the terminal and stops.",
      }),
    ),
    h("label", { class: "ld-switch" },
      h("input", {
        type: "checkbox",
        checked: () => store.enabled(),
        onchange: (e: Event) => {
          store.setEnabled((e.target as HTMLInputElement).checked);
          notice.set(
            store.enabled.peek()
              ? "Recording on. New reads will be written down."
              : "Recording off. Nothing already stored is deleted, and the numbers below still stand.",
          );
        },
      }),
      h("span", { text: "Write down what it says" }),
    ),
  );

  const tabs = h(
    "nav",
    { class: "ld-tabs", role: "tablist" },
    ...(
      [
        ["record", "Track record"],
        ["runs", "Model runs"],
        ["words", "Plain words"],
      ] as const
    ).map(([id, label]) =>
      h("button", {
        class: "ld-tab",
        type: "button",
        role: "tab",
        text: label,
        "aria-selected": () => String(tab() === id),
        onclick: () => tab.set(id),
      }),
    ),
  );

  const noticeEl = h("p", {
    class: "ld-notice",
    text: () => notice(),
    hidden: () => notice() === "",
  });

  const body = h("div", { class: "ld-body" });

  /* ---- 1. the headline -------------------------------------------------- */

  const headline = (): HTMLElement => {
    const c = card();
    return h(
      "section",
      { class: "ld-panel ld-panel-lead" },
      h("p", { class: "ld-headline", text: c.headline }),
      c.from !== null && c.to !== null
        ? h("p", {
            class: "ld-window",
            text: `Covering reads made between ${new Date(c.from).toLocaleDateString()} and ${new Date(c.to).toLocaleDateString()}.`,
          })
        : null,
      h("div", { class: "ld-actions" },
        h("button", {
          class: "ld-btn",
          type: "button",
          text: "Check what's loaded now",
          title: "Mark every waiting claim that the bars currently in memory can settle.",
          onclick: () => {
            opts.resolveNow();
            notice.set("Swept everything loaded. Claims on instruments you have not opened stay waiting — they are marked from your bars, not from a guess.");
          },
        }),
      ),
    );
  };

  /* ---- 2. do the gates earn their refusals? ----------------------------- */

  const gatesPanel = (): HTMLElement => {
    const g = card().gates;
    return h(
      "section",
      { class: "ld-panel" },
      h("h3", { class: "ld-h2", text: "Do the gates earn their refusals?" }),
      pkWhy(
        "Reads are recorded whether or not the card cleared them. That makes this the one comparison a backtest cannot fake: what the gates let through, against what they stopped, decided in real time.",
        "About this test",
      ),
      h("p", { class: "ld-verdict", "data-separated": String(g.separated), text: g.text }),
      h("div", { class: "ld-compare" },
        ...[g.taken, g.stoodDown].map((p) =>
          h("div", { class: "ld-compare-col" },
            h("div", { class: "ld-compare-head" },
              h("span", { class: "ld-compare-label", text: p.label }),
              pkChip(`${p.decided} settled`, p.decided >= 20 ? "accent" : undefined),
            ),
            rateBar(p.hit),
            h("p", { class: "ld-compare-note", text: p.hit.text }),
            pkRows(populationRows(p)),
          ),
        ),
      ),
    );
  };

  /* ---- 3. does the score mean anything? --------------------------------- */

  const scorePanel = (): HTMLElement => {
    const bands = card().scoreBands;
    const anyData = bands.some((b) => b.hit.n > 0);
    return h(
      "section",
      { class: "ld-panel" },
      /* Not `plainly("confluence score") + " — does it predict anything?"`,
         which read as "How much the evidence agrees — does it predict
         anything?": two questions welded together, and the glossary phrase is
         written to sit in a sentence rather than to open one. */
      h("h3", { class: "ld-h2", text: "When the score was strong, did it work?" }),
      pkWhy(
        "Reads grouped by how strong they were at the time. If the bars come out level, the score is not carrying information about the outcome, however convincing it looks on the card.",
        "How to read this",
      ),
      anyData
        ? h("div", { class: "ld-bands" },
            ...bands.map((b) =>
              h("div", { class: "ld-band" },
                h("span", { class: "ld-band-label", text: `${b.from.toFixed(1)}–${b.to.toFixed(1)}` }),
                rateBar(b.hit),
                h("span", { class: "ld-band-r", text: rr(b.expectancyR) }),
              ),
            ),
          )
        : pkEmpty("empty", "No settled reads yet, so there is nothing to band."),
    );
  };

  /* ---- 4. what is still waiting ---------------------------------------- */

  const pendingPanel = (): HTMLElement => {
    const t = now();
    const pending = store
      .claims()
      .filter((c) => c.outcome === "pending")
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, 40);

    return h(
      "section",
      { class: "ld-panel" },
      h("h3", { class: "ld-h2", text: "Waiting to be marked" }),
      pkWhy(
        "These have a deadline and two levels and no answer yet. They settle from bars you load — open the instrument and they get marked.",
        "How these settle",
      ),
      pending.length === 0
        ? pkEmpty("empty", "Nothing waiting.")
        : h("div", { class: "ld-claims" },
            ...pending.map((c) =>
              h("button", {
                class: "ld-claim",
                type: "button",
                title: `Open ${c.symbol} ${c.timeframe}`,
                onclick: () => opts.openSymbol(c.symbol, c.timeframe),
              },
                h("span", { class: "ld-claim-sym", text: `${c.symbol} ${c.timeframe}` }),
                h("span", { class: "ld-claim-side", "data-side": c.side, text: c.side }),
                h("span", {
                  class: "ld-claim-verdict",
                  "data-verdict": c.verdict,
                  text: c.verdict === "take" ? "cleared" : `blocked (${c.gatesFailed})`,
                }),
                h("span", { class: "ld-claim-r", text: `${claimR(c).toFixed(1)}R` }),
                h("span", { class: "ld-claim-age", text: `said ${ago(t - c.at)}` }),
                h("span", { class: "ld-claim-left", text: until(c.expiresAt - t) }),
              ),
            ),
          ),
    );
  };

  /* ---- 5. settled, most recent first ------------------------------------ */

  const settledPanel = (): HTMLElement => {
    const t = now();
    const settled = store
      .claims()
      .filter((c) => c.outcome !== "pending")
      .sort((a, b) => (b.resolvedAt ?? b.at) - (a.resolvedAt ?? a.at))
      .slice(0, 60);

    return h(
      "section",
      { class: "ld-panel" },
      h("h3", { class: "ld-h2", text: "Settled" }),
      settled.length === 0
        ? pkEmpty("empty", "Nothing settled yet.")
        : h("div", { class: "ld-claims" },
            ...settled.map((c) => {
              const r = claimR_realised(c);
              return h("button", {
                class: "ld-claim",
                type: "button",
                "data-outcome": c.outcome,
                onclick: () => opts.openSymbol(c.symbol, c.timeframe),
              },
                h("span", { class: "ld-claim-sym", text: `${c.symbol} ${c.timeframe}` }),
                h("span", { class: "ld-claim-side", "data-side": c.side, text: c.side }),
                h("span", {
                  class: "ld-claim-verdict",
                  "data-verdict": c.verdict,
                  text: c.verdict === "take" ? "cleared" : `blocked (${c.gatesFailed})`,
                }),
                h("span", { class: "ld-claim-out", text: OUTCOME_WORDS[c.outcome] }),
                h("span", {
                  class: "ld-claim-r",
                  "data-tone": r === null ? "" : r >= 0 ? "pos" : "neg",
                  text: r === null ? "—" : rr(r),
                }),
                h("span", { class: "ld-claim-age", text: ago(t - (c.resolvedAt ?? c.at)) }),
              );
            }),
          ),
    );
  };

  /* ---- 6. per-instrument, and forgetting -------------------------------- */

  const managePanel = (): HTMLElement => {
    const c = card();
    const sym = opts.symbol().toUpperCase();
    return h(
      "section",
      { class: "ld-panel" },
      h("h3", { class: "ld-h2", text: "By instrument" }),
      c.bySymbol.length === 0
        ? pkEmpty("empty", "Nothing recorded yet.")
        : h("div", { class: "ld-syms" },
            ...c.bySymbol.map((p) =>
              h("div", { class: "ld-sym" },
                h("span", { class: "ld-sym-name", text: p.label }),
                rateBar(p.hit),
                h("span", { class: "ld-sym-r", text: rr(p.expectancyR) }),
                h("button", {
                  class: "ld-forget",
                  type: "button",
                  text: "Forget",
                  title: `Delete every claim and unpinned run for ${p.label}. This cannot be undone.`,
                  onclick: () => {
                    const n = store.forgetSymbol(p.label);
                    notice.set(`Deleted ${n} claim${n === 1 ? "" : "s"} for ${p.label}.`);
                  },
                }),
              ),
            ),
          ),
      h("div", { class: "ld-actions ld-actions-danger" },
        h("button", {
          class: "ld-btn",
          type: "button",
          text: `Forget ${sym}`,
          disabled: () => !store.claims().some((x) => x.symbol === sym),
          onclick: () => {
            const n = store.forgetSymbol(sym);
            notice.set(`Deleted ${n} claim${n === 1 ? "" : "s"} for ${sym}.`);
          },
        }),
        h("button", {
          class: "ld-btn ld-btn-danger",
          type: "button",
          text: "Forget everything",
          title: "Deletes the whole track record. Pinned model runs survive.",
          onclick: () => {
            const r = store.forgetAll();
            notice.set(
              `Deleted ${r.claims} claim${r.claims === 1 ? "" : "s"} and ${r.runs} run${r.runs === 1 ? "" : "s"}. Pinned runs were kept. The track record starts again from nothing — the next number you see will be a small sample, and will say so.`,
            );
          },
        }),
        h("button", {
          class: "ld-btn",
          type: "button",
          text: "Copy as JSON",
          title: "The whole memory, to keep or move to another machine.",
          onclick: () => {
            const snap = store.snapshot();
            void navigator.clipboard
              ?.writeText(JSON.stringify(snap, null, 2))
              .then(() => notice.set(`Copied ${snap.claims.length} claims and ${snap.runs.length} runs to the clipboard.`))
              .catch(() => notice.set("The clipboard refused. Nothing was copied."));
          },
        }),
      ),
    );
  };

  /* ---- model runs ------------------------------------------------------- */

  const runsPanel = (): HTMLElement => {
    const t = now();
    const runs = [...store.runs()].sort((a, b) => b.at - a.at);
    const drifts = drift(store.runs());

    return h(
      "div",
      { class: "ld-stack" },
      h("section", { class: "ld-panel ld-panel-lead" },
        h("h3", { class: "ld-h2", text: "Model runs, kept" }),
        pkWhy(
          "The quant service holds no state — every fit it does is computed and thrown away. These are the results, kept, so a score can be compared with the same score last month. The models themselves are not stored: they refit in seconds from bars you already have, and a saved one would be a megabyte of weights nothing here can load.",
          "What is kept, and why",
        ),
        runs.length === 0
          ? pkEmpty("empty", "No runs kept yet. Run anything on the Quant desk and it will be recorded here.")
          : null,
      ),

      drifts.length > 0
        ? h("section", { class: "ld-panel" },
            h("h3", { class: "ld-h2", text: "Has it changed its mind?" }),
            pkWhy(
              "The reason to keep runs at all. A score that moved between two fits of the same question has told you something neither fit could say alone.",
              "Why this matters",
            ),
            h("div", { class: "ld-drifts" },
              ...drifts.map((d) =>
                h("div", { class: "ld-drift" },
                  h("span", { class: "ld-drift-what", text: `${d.symbol} ${d.timeframe} · ${d.kind}` }),
                  /* Coloured by `better`, NOT by the sign of the change. For
                     QLIKE a fall is an improvement, and tying the colour to
                     the sign would paint an improving volatility model red. */
                  h("span", {
                    class: "ld-drift-change",
                    "data-tone": d.better === null ? "" : d.better ? "pos" : "neg",
                    text: Number.isFinite(d.change) ? `${d.change >= 0 ? "+" : ""}${d.change.toFixed(3)}` : "—",
                  }),
                  h("p", { class: "ld-drift-text", text: d.text }),
                ),
              ),
            ),
          )
        : null,

      runs.length > 0
        ? h("section", { class: "ld-panel" },
            h("h3", { class: "ld-h2", text: "Every run" }),
            h("div", { class: "ld-runs" }, ...runs.map((r) => runRow(r, t))),
          )
        : null,
    );
  };

  const runRow = (r: ModelRun, t: number): HTMLElement =>
    h("div", { class: "ld-run", "data-pinned": String(r.pinned) },
      h("div", { class: "ld-run-top" },
        h("span", { class: "ld-run-sym", text: `${r.symbol} ${r.timeframe}` }),
        h("span", { class: "ld-run-kind", text: r.kind }),
        h("span", {
          class: "ld-run-metric",
          "data-tone": r.beatsChance === null ? "" : r.beatsChance ? "pos" : "neg",
          text: r.metric === null ? "—" : `${r.metricName} ${r.metric.toFixed(3)}`,
          title: explain(r.metricName),
        }),
        h("span", {
          class: "ld-run-chance",
          text:
            r.beatsChance === null
              ? "not tested against chance"
              : r.beatsChance
                ? "clears its own noise floor"
                : "inside the noise",
        }),
        h("span", { class: "ld-run-age", text: ago(t - r.at) }),
      ),
      h("p", { class: "ld-run-verdict", text: r.verdict }),
      r.drivers.length > 0
        ? h("div", { class: "ld-run-drivers" },
            ...r.drivers.slice(0, 6).map((d) =>
              h("span", { class: "ld-run-driver", text: `${d.name} ${(d.weight * 100).toFixed(0)}%` }),
            ),
          )
        : null,
      h("div", { class: "ld-run-actions" },
        h("span", { class: "ld-run-bars", text: `${r.bars} bars` }),
        h("button", {
          class: "ld-mini",
          type: "button",
          text: r.pinned ? "Unpin" : "Pin",
          title: r.pinned ? "Allow this run to be evicted again." : "Keep this run through eviction and through Forget everything.",
          onclick: () => store.pinRun(r.id, !r.pinned),
        }),
        h("button", {
          class: "ld-mini ld-mini-danger",
          type: "button",
          text: "Delete",
          onclick: () => store.removeRun(r.id),
        }),
      ),
    );

  /* ---- plain words ------------------------------------------------------ */

  const wordsPanel = (): HTMLElement =>
    h("div", { class: "ld-stack" },
      h("section", { class: "ld-panel ld-panel-lead" },
        h("h3", { class: "ld-h2", text: "Plain words" }),
        h("p", {
          class: "ld-blurb",
          text:
            "This terminal uses the real terms rather than friendly ones, because the real terms are what you would need to go and argue with the number. Here is what each of them means, and — where there is one — the thing people usually get wrong about it.",
        }),
      ),
      /* Full width: a definition list in a half-width column wraps every
         entry onto three lines and turns a scannable glossary into a wall. */
      h("section", { class: "ld-panel ld-wide" },
        h("dl", { class: "ld-glossary" },
          /* Each entry is wrapped in its own div — permitted inside a <dl>
             since HTML 5.2, and required here: a bare dt/dd sequence has no
             element that binds a term to its definition, so any multi-column
             layout is free to break between them and orphan a definition at
             the top of the next column under somebody else's term. */
          ...allTerms().map((term) =>
            h("div", { class: "ld-entry" },
              h("dt", { class: "ld-term" },
                h("span", { class: "ld-term-plain", text: term.plain }),
                h("code", { class: "ld-term-jargon", text: term.term }),
              ),
              h("dd", { class: "ld-def" },
                h("span", { text: term.says }),
                term.notThe ? h("span", { class: "ld-def-not", text: term.notThe }) : null,
              ),
            ),
          ),
        ),
      ),
    );

  /* ---- assembly --------------------------------------------------------- */

  const stack = h("div", { class: "ld-stack" });

  renderEffect(() => {
    const which = tab();
    clear(stack);
    if (which === "record") {
      stack.append(headline(), gatesPanel(), scorePanel());
      /* Between the claims and the housekeeping: it is evidence, so it sits
         with the evidence, and it is the WEAKER evidence, so it sits below. */
      if (opts.kindTable) stack.append(opts.kindTable());
      stack.append(pendingPanel(), settledPanel(), managePanel());
    } else if (which === "runs") {
      stack.append(runsPanel());
    } else {
      stack.append(wordsPanel());
    }
  });

  body.append(stack);
  /* THE DURABLE RECORD, after the browser's own. Two records of one subject
     would normally be the defect this project keeps finding — here they are
     two DIFFERENT subjects and each says which: everything above grades what
     THIS BROWSER holds, and the card below is the server's copy, which
     survives clearing it. MEASURED when it was wired: 2,059 recorded and 420
     decided on the server against almost nothing in this profile. */
  el.append(head, tabs, noticeEl, body, trackRecordCard());

  /* The store's own write failures surface here rather than being swallowed.
     A track record that silently stopped saving is worse than none: you keep
     reading numbers that stopped moving and have no reason to doubt them. */
  renderEffect(() => {
    const err = store.lastError();
    if (err !== "") notice.set(err);
  });

  return { el };
}
