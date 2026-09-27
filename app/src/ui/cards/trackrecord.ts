/**
 * THE DURABLE TRACK RECORD — what this machine claimed, and whether it held.
 *
 * The server has graded 2,059 recorded claims and 420 decided ones across five
 * markets and eight bar sizes, with a confidence interval on every rate and a
 * calibration curve, and none of it had a screen. The Learn desk's own
 * scorecard grades what THIS BROWSER holds; this is the copy that survives
 * clearing it. Both are shown and each is named, which is the distinction the
 * System desk already draws about bars.
 *
 * THE UNCOMFORTABLE NUMBER IS THE POINT
 *
 * `gates.liftPoints` was −6.1 when this was wired: the checks that stand a
 * trade down were, on this sample, performing WORSE than not using them. That
 * is exactly the figure a track record exists to surface, so it leads rather
 * than hiding in a fold — CLAUDE.md's rule is that colour follows the standing,
 * and a negative lift is a standing.
 *
 * EVERY RATE WITH ITS INTERVAL
 *
 * 52% on 420 decisions and 52% on 12 are the same number about entirely
 * different evidence. The service returns `low` and `high` beside every rate
 * and this prints them, because a hit rate alone is a claim nobody can check.
 *
 * AND THE CAVEAT IS THE SERVICE'S OWN WORDS, verbatim: "One operator, one set
 * of instruments, 9 distinct days. Out of sample, unlike a backtest, and far
 * too small to generalise from." Shortening it would be the one edit that
 * changes what the whole card means.
 */

import { each, h } from "../dom";
import { pkFold, pkWhy } from "../panelkit";
import { signal, computed } from "../../core/signal";
import { onShown } from "./shown";
import { calibrationCard } from "./calibration";
import { claimStats, type ClaimPopulation, type ClaimStats } from "../../data/claimstats";

const pct = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";
const day = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—");

/** One population's row, as strings. */
export interface GradedRow {
  readonly label: string;
  readonly decided: string;
  readonly rate: string;
  readonly range: string;
  readonly exp: string;
  /** False when nothing has been decided and every figure is a refusal. */
  readonly graded: boolean;
  /** Why it is refusing, for the row that is refusing. Empty otherwise. */
  readonly why: string;
}

/**
 * Turn one population into the strings a row prints.
 *
 * PURE, AND EXPORTED, BECAUSE IT IS THE PART THAT CAN BE WRONG. Everything
 * around it is DOM. This decides whether a figure exists at all, and getting
 * that wrong is what took out three whole tables — so it is testable on its
 * own, the way `eviction_order` and `deflatedSharpe` are.
 *
 * A NULL RATE IS NOT A ZERO. `0.0%` says every claim lost; null says none has
 * been answered. Printing the first for the second would be the "count of what
 * has REPORTED is not a count of what EXISTS" error, in the one place on this
 * card where the difference decides whether you trust the market beside it.
 */
export function gradedRow(p: ClaimPopulation): GradedRow {
  const graded = typeof p.hitRate === "number" && Number.isFinite(p.hitRate);
  const exp = p.expectancyR;
  return {
    label: p.label,
    decided: String(p.decided),
    rate: pct(p.hitRate),
    /* Both ends or neither. Half an interval is not an interval. */
    range:
      typeof p.low === "number" && typeof p.high === "number" ? `${pct(p.low)}–${pct(p.high)}` : "—",
    exp:
      typeof exp === "number" && Number.isFinite(exp)
        ? `${exp >= 0 ? "+" : ""}${exp.toFixed(3)}R`
        : "—",
    graded,
    why: graded
      ? ""
      : `${p.label}: claims recorded, none decided yet — the bars that would settle them have not closed.`,
  };
}

export function trackRecordCard(): HTMLElement {
  const stats = signal<ClaimStats | null>(null);
  const offline = signal("");
  const loading = signal(true);

  const refresh = (): void => {
    void claimStats().then((a) => {
      loading.set(false);
      if (a.kind === "offline") {
        offline.set(a.why);
        return;
      }
      offline.set("");
      stats.set(a.value);
    });
  };

  /** The calibration bands, in the shape the shared card draws. */
  const bands = computed(() => {
    const s = stats();
    if (!s?.calibration?.bands) return [];
    return s.calibration.bands
      .filter((b) => b.n > 0)
      .map((b) => ({
        from: b.from,
        to: b.to ?? 1,
        n: b.n,
        /* What it SAID, and what HAPPENED. The shared card draws the bar from
           `observed` for the reason it states: a bar drawn from the claim is a
           picture of the model agreeing with itself. */
        predicted: b.meanConfidence,
        observed: b.hitRate,
      }));
  });

  const population = (p: ClaimPopulation): HTMLElement => {
    const r = gradedRow(p);
    return h(
      "div",
      {
        class: "trk-row",
        /* The row stays, at a quieter weight, rather than vanishing. A market
           dropping out of the list when its first claim is recorded and
           reappearing when one settles is a list that changes shape for a
           reason nobody can see. */
        "data-graded": String(r.graded),
        ...(r.why ? { title: r.why } : {}),
      },
      h("span", { class: "trk-label", text: r.label }),
      h("span", { class: "trk-n num", text: r.decided }),
      h("span", { class: "trk-rate num", text: r.rate }),
      /* THE INTERVAL, beside the rate it belongs to. Without it a rate on
         twelve decisions reads exactly like a rate on four hundred. */
      h("span", { class: "trk-ci num", text: r.range }),
      h("span", {
        class: "trk-exp num",
        "data-up": String(typeof p.expectancyR === "number" && p.expectancyR >= 0),
        text: r.exp,
      }),
    ) as HTMLElement;
  };

  /**
   * One graded breakdown.
   *
   * BUILT WITH `each`, WHICH IS WHAT IT IS FOR. The first version used a
   * hand-rolled function child returning a DocumentFragment, and its slot never
   * re-ran: the anchors were created, `data-on` on the same data went true, and
   * no row was ever inserted. `renderEffect` defers through `scheduleFrame`,
   * whose own header says it "parks entirely while the tab is hidden" — and
   * this terminal is always a background tab, which is the trap CLAUDE.md
   * records for `requestAnimationFrame` and for ResizeObserver. `each` is the
   * project's keyed list renderer and exists precisely so a list does not have
   * to get this right twice.
   */
  const table = (title: string, rows: () => readonly ClaimPopulation[]): HTMLElement => {
    const box = h(
      "div",
      { class: "trk-rows" },
      h(
        "div",
        { class: "trk-row trk-head" },
        h("span", { text: "" }),
        h("span", { class: "num", text: "Decided" }),
        h("span", { class: "num", text: "Hit rate" }),
        h("span", { class: "num", text: "Range" }),
        h("span", { class: "num", text: "Per claim" }),
      ),
    ) as HTMLElement;

    /* Keyed by LABEL, which is what a population is: "BTCUSDT", "1h". Keying by
       index would re-use a row's DOM for a different market when the set
       changes, and the number beside the name would change under it. */
    each(box, () => [...rows()], (p) => p.label, population);

    return h(
      "div",
      { class: "trk-table", "data-on": () => String(rows().length > 0) },
      h("h4", { class: "cal-h", text: title }),
      box,
    ) as HTMLElement;
  };

  /* The headline population, through the same renderer as the breakdowns —
     one list of one, rather than a second way of drawing the same row. */
  const allBox = h("div", { class: "trk-rows trk-all", style: () => (stats() ? "" : "display:none") }) as HTMLElement;
  each(allBox, () => { const s = stats(); return s ? [s.all] : []; }, (p) => p.label, population);

  /* Both gate populations, through the one row renderer, so the lift above them
     is checkable against its own inputs. */
  const gatesBox = h(
    "div",
    { class: "trk-rows trk-gaterows", style: () => (stats()?.gates ? "" : "display:none") },
  ) as HTMLElement;
  each(
    gatesBox,
    () => {
      const g = stats()?.gates;
      return g ? [g.taken, g.stoodDown] : [];
    },
    (p) => p.label,
    population,
  );

  /** What each side could not settle — named, not dropped. */
  const pendingLine = (): string => {
    const g = stats()?.gates;
    if (!g) return "";
    const pending = g.taken.pending + g.stoodDown.pending;
    const unknowable = g.taken.unknowable + g.stoodDown.unknowable;
    // `expired` belongs in this sentence and was missing from it. The comment
    // above says "named, not dropped", and for 31 claims it was not true.
    const expired = g.taken.expired + g.stoodDown.expired;
    if (pending <= 0 && unknowable <= 0 && expired <= 0) return "";
    const bits: string[] = [];
    if (pending > 0) bits.push(`${pending.toLocaleString()} still waiting on the bars that settle them`);
    if (expired > 0) bits.push(`${expired.toLocaleString()} that ran out of time without reaching either level`);
    if (unknowable > 0) bits.push(`${unknowable.toLocaleString()} that can never be settled`);
    return `Not in either rate above: ${bits.join(", ")}.`;
  };

  const el = h(
    "section",
    { class: "dd-panel trk" },
    h("h3", { class: "pf-sub", text: "The durable record: everything it has claimed" }),

    h("p", {
      class: "trk-state",
      text: () => {
        if (loading()) return "Reading the ledger…";
        if (offline()) return offline();
        const s = stats();
        if (!s) return "";
        return (
          `${s.recorded.toLocaleString()} claims recorded and ${s.all.decided.toLocaleString()} decided, ` +
          `${day(s.from)} to ${day(s.to)}. This is the copy on the server — it survives clearing this browser.`
        );
      },
    }),

    /* THE HEADLINE IS THE GATES, because it is the one number here that says
       whether the machine's own checks are earning their place. */
    h("div", {
      class: "trk-gates",
      "data-lift": () => {
        const g = stats()?.gates;
        if (!g) return "none";
        return g.liftPoints >= 0 ? "up" : "down";
      },
      style: () => (stats()?.gates ? "" : "display:none"),
      text: () => {
        const g = stats()?.gates;
        if (!g) return "";
        /* The service writes its own sentence; it is kept and the number is
           put in front of it rather than paraphrasing either. */
        const sign = g.liftPoints >= 0 ? "+" : "";
        return `Checks: ${sign}${g.liftPoints.toFixed(1)} points. ${g.text}`;
      },
    }),

    allBox,

    /* THE TWO SIDES THE LIFT IS A DIFFERENCE OF. A lift of -6.5 points is a
       subtraction of two rates, and printing only the answer leaves the reader
       no way to see that one side has 127 decided and the other 294, or that
       217 claims between them are still pending. The figures are on the wire
       already; they only ever needed showing. */
    gatesBox,

    table("By market", () => stats()?.bySymbol ?? []),
    table("By bar size", () => stats()?.byTimeframe ?? []),
    table("By setup", () => stats()?.bySetup ?? []),

    h("p", {
      class: "trk-pending",
      text: pendingLine,
      style: () => (pendingLine() ? "" : "display:none"),
    }),

    calibrationCard({
      buckets: () => bands(),
      note: () => stats()?.calibration?.note ?? "",
      heading: "Where it said this, how often it held",
    }),

    /* THE SERVICE'S OWN CAVEAT, VERBATIM. Shortening it is the one edit that
       would change what this whole card means. */
    h("p", {
      class: "trk-caveat",
      text: () => stats()?.caveat ?? "",
      style: () => (stats()?.caveat ? "" : "display:none"),
    }),

    pkFold(
      "How a claim gets graded",
      h("p", {
        class: "trk-sub",
        text:
          "A claim is recorded when the machine says something checkable, and decided when the bars that would " +
          "settle it have closed. Recorded and decided are different counts on purpose: the gap is what has been " +
          "said and not yet answered, and reporting only the decided half would flatter every reading here.",
      }),
    ),

    pkWhy(
      "This is the ledger on the server, not the one in this browser — the Learn desk's own scorecard grades what " +
        "this profile holds, and this survives clearing it. Every hit rate carries the interval around it, because " +
        "52% on 420 decisions and 52% on twelve are the same number about entirely different evidence. The checks " +
        "line can be NEGATIVE, and when it is, that is the finding: it means standing trades down cost more than " +
        "it saved on this sample.",
      "Whose record this is, and what the range means",
    ),
  ) as HTMLElement;

  refresh();
  /* A desk is hidden rather than unmounted, and claims are decided by bars
     closing while you are elsewhere. */
  onShown(el, refresh);

  return el;
}
