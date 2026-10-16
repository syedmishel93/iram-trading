/**
 * THE ACTIVITY CARD — what has been failing while you were not looking.
 *
 * THE CASE FOR IT, MEASURED
 *
 * `/svc/events` held 4,548 rows and had no screen. Inside it, one loop had
 * logged 2,069 failures — 46% of every event the service ever recorded — and
 * had never once succeeded. Its dot on the card above this one was green the
 * whole time, correctly: that dot means STARTED, and a tick age is not a health
 * check. This is the half that was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT LEADS WITH THE ANSWER
 *
 * The question a person opens this to ask is "is anything broken". So the count
 * of failing jobs is the first thing, at the serif face this terminal uses for
 * what it says on its own account, and the log itself is behind a disclosure.
 * A card that answers a question should lead with the answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE STATES, AND THE THIRD IS NOT A FAILURE
 *
 * FAILING, NEEDS YOU, and quiet. "Waiting for a key only you can supply" is not
 * broken — FRED has skipped 224 times asking for `FRED_API_KEY` — and filing it
 * under failures would bury the eleven jobs that genuinely are. The key itself
 * is never asked for here: that is a credential, and it belongs in the
 * environment the operator controls, not in a field on a dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND AN EMPTY LOG IS NOT A HEALTHY ONE
 *
 * Three distinct states are drawn distinctly: "could not ask", "nothing has been
 * recorded", and "nothing is failing". Rendering the first two as a reassuring
 * zero is the `/svc/health` strip that painted "0 of 0 running" green.
 */

import { each, h } from "../dom";
import { signal, computed } from "../../core/signal";
import { pkFold, pkWhy } from "../panelkit";
import {
  activityLabel,
  activitySummary,
  activityTail,
  entryCount,
  type ActivityEvent,
  type ActivityKind,
  type ActivitySummary,
} from "../../data/activity";

/** "4 minutes ago", "3 days ago". Absolute dates for anything older than a week. */
function ago(ms: number, now: number): string {
  if (!(ms > 0)) return "never";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

const clock = signal(Date.now());
setInterval(() => clock.set(Date.now()), 30_000);

export function createActivityCard(): { readonly el: HTMLElement; refresh(): Promise<void> } {
  const summary = signal<ActivitySummary | null>(null);
  const tail = signal<readonly ActivityEvent[]>([]);
  /** Null until asked. `false` would claim the service is absent before asking. */
  const reachable = signal<boolean | null>(null);
  const why = signal("");

  async function refresh(): Promise<void> {
    const [s, t] = await Promise.all([activitySummary(), activityTail(60)]);
    if (s.kind === "offline") {
      reachable.set(false);
      why.set(s.why);
      return;
    }
    reachable.set(true);
    why.set("");
    summary.set(s.value);
    tail.set(t.kind === "ok" ? t.value : []);
  }

  const failing = computed<readonly ActivityKind[]>(() =>
    (summary()?.kinds ?? []).filter((k) => k.failing),
  );
  const needsYou = computed<readonly ActivityKind[]>(() =>
    (summary()?.kinds ?? []).filter((k) => k.needsYou),
  );
  const quiet = computed<readonly ActivityKind[]>(() =>
    (summary()?.kinds ?? []).filter((k) => !k.failing && !k.needsYou),
  );

  /** The headline. One short line per fact; the reasoning goes behind "Why?". */
  const verdict = (): string => {
    if (reachable() === null) return "Reading the log…";
    if (reachable() === false) return "Could not ask";
    const s = summary();
    if (!s) return "";
    if (s.emptyReason) return "Nothing recorded yet";
    const n = s.failingKinds;
    if (n === 0) return "Nothing failing";
    return `${n} ${n === 1 ? "job is" : "jobs are"} failing`;
  };

  const verdictNote = (): string => {
    if (reachable() === false) return why();
    const s = summary();
    if (!s) return "";
    if (s.emptyReason) return s.emptyReason;
    if (s.failingKinds === 0) {
      return `${s.total.toLocaleString()} log entries since ${new Date(s.since * 1000)
        .toISOString()
        .slice(0, 10)}, none of them a failure.`;
    }
    return (
      `${s.failingTotal.toLocaleString()} of ${s.total.toLocaleString()} log entries are failures, ` +
      `since ${new Date(s.since * 1000).toISOString().slice(0, 10)}. Most jobs write a line only when ` +
      `they break, so this counts entries rather than attempts.`
    );
  };

  /** One job, with how often it has failed and what it last said. */
  const jobRow = (k: ActivityKind): HTMLElement =>
    h(
      "div",
      { class: "act-job", "data-state": k.failing ? "bad" : k.needsYou ? "you" : "ok" },
      h(
        "div",
        { class: "act-job-head" },
        h("span", { class: "act-job-name", text: activityLabel(k.kind) }),
        h("span", {
          class: "act-job-count num",
          /* ENTRIES, NOT RUNS — see `entryCount`. Most of these feeds log only
             when they break, so "224 of 224 failed" was the failure count
             printed twice with a denominator that implied attempts. */
          text: entryCount(k),
        }),
        h("span", { class: "act-job-when", text: () => ago(k.newest * 1000, clock()) }),
      ),
      /* THE SERVICE'S OWN LAST WORDS, verbatim and not summarised. A 404 names
         the vendor that moved; a 429 names a rate limit you can wait out. Both
         are actionable and neither survives being turned into "failed". */
      h("p", { class: "act-job-msg", text: k.sample || "—" }),
    ) as HTMLElement;

  /* `each` is the list renderer here for the reason `trackrecord.ts` records: a
     hand-rolled function child that throws loses the WHOLE list silently,
     because the fragment is built first and appended once at the end. */
  const jobList = (rows: () => readonly ActivityKind[], cls: string): HTMLElement => {
    const box = h("div", { class: `act-jobs ${cls}`, "data-on": () => String(rows().length > 0) }) as HTMLElement;
    each(box, () => [...rows()], (k) => k.kind, jobRow);
    return box;
  };

  /** The raw tail. Behind a disclosure: it is evidence, not the answer. */
  const tailBox = h("div", { class: "act-tail" }) as HTMLElement;
  each(
    tailBox,
    () => [...tail()],
    (e) => String(e.id),
    (e) =>
      h(
        "div",
        { class: "act-line" },
        h("span", { class: "act-line-when", text: new Date(e.t * 1000).toISOString().slice(5, 16).replace("T", " ") }),
        h("span", { class: "act-line-kind", text: activityLabel(e.kind) }),
        h("span", { class: "act-line-msg", text: e.msg || "" }),
      ) as HTMLElement,
  );

  const el = h(
    "section",
    { class: "dd-panel act" },
    h("h3", { class: "pf-sub", text: "Recent activity, and what is failing" }),

    h(
      "div",
      { class: "act-verdict", "data-level": () => {
        if (reachable() === null) return "none";
        if (reachable() === false) return "unknown";
        const s = summary();
        if (!s || s.emptyReason) return "unknown";
        return s.failingKinds > 0 ? "bad" : "ok";
      } },
      h("div", { class: "act-verdict-n", text: verdict }),
      h("p", { class: "act-verdict-note", text: verdictNote }),
    ),

    h("div", { class: "act-group", "data-on": () => String(failing().length > 0) },
      h("h4", { class: "act-h", text: "Failing" }),
      jobList(() => failing(), "act-bad"),
    ),

    h("div", { class: "act-group", "data-on": () => String(needsYou().length > 0) },
      h("h4", { class: "act-h", text: "Waiting for you" }),
      jobList(() => needsYou(), "act-you"),
    ),

    pkFold(
      "Everything else it has been doing",
      jobList(() => quiet(), "act-ok"),
    ),

    pkFold("The log itself, most recent first", tailBox),

    pkWhy(
      "These counts are over the whole log, not the last fifty lines — a job that has failed two thousand times " +
        "looks like twelve ordinary lines in a tail, which is how one survived unnoticed since this product was " +
        "built. A job is counted as failing when its messages say so, not only when its name ends in 'err': " +
        "classifying by name alone reported one failure here where there were eleven. And a job waiting for a key " +
        "only you can supply is listed apart, because it is not broken.",
      "How failing is decided, and over what",
    ),
  ) as HTMLElement;

  return { el, refresh };
}
