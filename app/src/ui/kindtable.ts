/**
 * The detector scorecard, rendered.
 *
 * It sits on the Learning desk directly beneath the claims, and the adjacency
 * is the design. The claims above are OUT OF SAMPLE — written down before the
 * outcome existed, the one form of evidence that cannot be overfitted after
 * the fact. This table is IN SAMPLE: candidates found on the same bars they
 * are scored over, which is the mechanism behind the measured PBO of 89%.
 *
 * Two kinds of evidence about the same detectors, one weak and one strong,
 * where you can see them disagree. Showing either alone would be worse: the
 * claims are too few to say much yet, and the replay says more than it knows.
 *
 * WHAT THE COLUMNS ARE, AND WHY EDGE IS THE ONE THAT SORTS
 * A 62% hit rate at 1:1 and 41% at 2:1 are the same trade. Sorting by hit rate
 * would rank by how close the target is, so the sort is `lower bound minus
 * break-even` — the worst case consistent with the sample, against the bar it
 * has to clear. A kind with four wins from six has a wonderful hit rate and no
 * evidence, and the interval is what says so.
 *
 * Rows below `MIN_TRIALS` are still SHOWN, greyed, with their sample size and
 * no verdict. Hiding them would answer "which kinds work" with a list that
 * silently omitted most of the terminal's detectors; naming them as
 * uncharacterised is the honest version of the same table.
 */

import { h } from "./dom";
import { MIN_TRIALS } from "../setup/simulate";
import type { KindRow, Scorecard } from "../setup/scorecard";

export interface KindTableOptions {
  /** Null while nothing has been replayed yet. */
  readonly card: () => Scorecard | null;
  /** True while a deeper pass is running. */
  readonly busy: () => boolean;
  /** Ask for more history. Null when there is no deeper pass to make. */
  readonly onDeepen: (() => void) | null;
  /** Bars a deeper pass would reach, for the button's label. */
  readonly deepTarget: number;
  /**
   * Keep this replay in the durable record. Null when there is nothing to keep.
   *
   * WHY IT IS A BUTTON AND NOT AN EFFECT. `shell.ts` explains it: the replay
   * re-runs whenever the symbol, timeframe, R multiple or bar count changes,
   * which on a one-minute chart is every minute, and it produces hundreds of
   * trials each time. Mirroring automatically would be a steady write load for
   * rows that are identical by construction.
   *
   * WHY IT EXISTS AT ALL. The push method has existed since the trial mirror was
   * written and NOTHING CALLED IT — the shell's own comment says it "pushes when
   * the operator asks, from the Learning desk" and no control asked. So the
   * durable table could never fill, `/svc/edge/kinds` answered empty forever,
   * and the conditional-edge read had nothing to read. Documented behaviour with
   * no implementation is worse than an absent feature: it reads as working.
   */
  readonly onKeep?: (() => void) | null;
  /** What the last keep did: "" when none has been tried. */
  readonly keepNote?: () => string;
  readonly keepBusy?: () => boolean;
}

const pct = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(0)}%`;

const rr = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

/**
 * Percentage points, to one decimal below ten.
 *
 * A whole-number `pp` rendered a genuine +0.03pp edge as "+0pp" beside the
 * words "clears on the lower bound". The threshold moved too — see `clears` in
 * setup/scorecard.ts — but a column that can print 0 for a non-zero value is a
 * column that will contradict its own row again.
 */
const edgeText = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  const pp = v * 100;
  const digits = Math.abs(pp) < 10 ? 1 : 0;
  return `${pp >= 0 ? "+" : ""}${pp.toFixed(digits)}pp`;
};

/** `liquidity-sweep` → `liquidity sweep`. */
export const kindLabel = (kind: string): string => kind.replace(/-/g, " ");

/**
 * How a row should read at a glance.
 *
 * Four states, not three. "Not enough" and "does not clear" are different
 * findings and the difference is the entire point of `MIN_TRIALS`: one says
 * the market answered no, the other says nobody has asked yet.
 */
export function rowTone(row: KindRow): "clears" | "adverse" | "flat" | "thin" {
  if (!row.enough) return "thin";
  if (row.adverse) return "adverse";
  /* `row.clears`, not `edge > 0`: past break-even by a margin worth acting on
     rather than by a rounding error. See setup/scorecard.ts. */
  if (row.clears) return "clears";
  return "flat";
}

export function rowNote(row: KindRow): string {
  switch (rowTone(row)) {
    case "thin":
      return `${row.n} of ${MIN_TRIALS} needed`;
    case "adverse":
      return "against it, not merely flat";
    case "clears":
      return "clears on the lower bound";
    default:
      return "does not clear";
  }
}

export function createKindTable(opts: KindTableOptions): HTMLElement {
  return h(
    "section",
    { class: "kindtable" },

    h(
      "div",
      { class: "kindtable-head" },
      h("h3", { class: "kindtable-title", text: "What each detector has been worth here" }),
      h("span", {
        class: "kindtable-sub",
        text: () => {
          const c = opts.card();
          return c === null ? "" : `${c.rows.length} kinds · ${c.bars.toLocaleString()} bars`;
        },
      }),
    ),

    /* The caveat is a heading, not a footnote. A reader who meets the numbers
       first will not come back for it. */
    h("p", {
      class: "kindtable-note",
      text: () => opts.card()?.headline ?? "",
    }),

    h("div", { class: "kindtable-body" }, () => {
      const card = opts.card();
      if (card === null) {
        return h("p", {
          class: "kindtable-empty",
          text: opts.busy() ? "Replaying…" : "Nothing replayed yet.",
        });
      }
      if (card.rows.length === 0) {
        return h("p", {
          class: "kindtable-empty",
          text: "No completed instance of any kind in the bars loaded.",
        });
      }

      /* Ranked kinds first, then everything else by sample size. A reader
         scanning for "what works" reads the top; a reader checking whether
         their favourite kind is in here at all finds it below. */
      const rankedIds = new Set(card.ranked.map((r) => `${r.kind}|${r.direction}`));
      const rest = card.rows.filter((r) => !rankedIds.has(`${r.kind}|${r.direction}`));
      const order = [...card.ranked, ...rest];

      return h(
        "table",
        { class: "kindtable-grid" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { text: "Kind" }),
            h("th", { text: "Side" }),
            h("th", { class: "num", text: "n" }),
            h("th", { class: "num", text: "Hit" }),
            h("th", { class: "num", title: "Wilson lower bound at 95%", text: "Low" }),
            h("th", {
              class: "num",
              title: "Hit rate needed to break even at this reward-to-risk",
              text: "B/E",
            }),
            h("th", {
              class: "num",
              title: "Lower bound minus break-even, in percentage points. The sort key.",
              text: "Edge",
            }),
            h("th", { class: "num", text: "Exp" }),
            h("th", { text: "" }),
          ),
        ),
        h(
          "tbody",
          {},
          ...order.map((row) =>
            h(
              "tr",
              { "data-tone": rowTone(row) },
              h("td", { class: "kindtable-kind", text: kindLabel(row.kind) }),
              h("td", { class: "kindtable-side", text: row.direction }),
              h("td", { class: "num", text: String(row.n) }),
              h("td", { class: "num", text: row.enough ? pct(row.hitRate) : "—" }),
              h("td", { class: "num", text: row.enough ? pct(row.hitLow) : "—" }),
              h("td", { class: "num", text: pct(row.breakEven) }),
              h("td", { class: "num kindtable-edge", text: row.enough ? edgeText(row.edge) : "—" }),
              h("td", { class: "num", text: row.enough ? rr(row.expectancy) : "—" }),
              h("td", { class: "kindtable-verdict", text: rowNote(row) }),
            ),
          ),
        ),
      );
    }),

    /* Deepening is explicit. A pass over six thousand bars is not something to
       start on the operator's behalf because they opened a desk. */
    h("div", { class: "kindtable-foot" }, () =>
      opts.onDeepen === null
        ? h("span", {
            class: "kindtable-fine",
            text: "Replayed over everything loaded.",
          })
        : h("button", {
            class: "kindtable-deepen",
            type: "button",
            disabled: () => opts.busy(),
            text: () =>
              opts.busy()
                ? "Reading more history…"
                : `Replay over ${opts.deepTarget.toLocaleString()} bars`,
            title:
              "Fetches more history and replays every kind over it. More instances narrow every interval in this table; it does not make the sample out of sample.",
            onclick: () => opts.onDeepen?.(),
          }),
    ),

    /* KEEPING IS EXPLICIT TOO, and for a second reason beyond write load: the
       trial mirror's own gate treats posting to a host that is not this machine
       as a data-export decision rather than a sync detail. A button is where
       that decision belongs. */
    h(
      "div",
      { class: "kindtable-foot", style: () => (opts.onKeep ? "" : "display:none") },
      h("button", {
        class: "kindtable-deepen",
        type: "button",
        disabled: () => opts.keepBusy?.() === true,
        text: () => (opts.keepBusy?.() === true ? "Keeping…" : "Keep this replay"),
        title:
          "Stores these outcomes on your own machine's service, so what the replay measured survives clearing this browser and accumulates across sessions. Nothing leaves the machine.",
        onclick: () => opts.onKeep?.(),
      }),
      h("span", {
        class: "kindtable-fine",
        text: () => opts.keepNote?.() ?? "",
        style: () => (opts.keepNote?.() ? "" : "display:none"),
      }),
    ),
  ) as HTMLElement;
}
