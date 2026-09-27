/**
 * The Setup card.
 *
 * v39 had this and called it the Sniper Card. It did not survive the rewrite —
 * there was no match for it anywhere in `app/src` — and the Decision desk that
 * replaced it answers "what is happening" but never "so what do I do, at what
 * size, and what would stop me".
 *
 * FIXED READ ORDER, ALWAYS THE SAME SIX BLOCKS
 * Verdict, plan, size, gates, trust, actions. The order IS the design: a card
 * whose layout changes with the verdict teaches you to hunt for the good news.
 *
 * WHAT A BLOCKED CARD SHOWS, AND WHAT IT HIDES
 * When a gate blocks, the entry, the stop and the lot size are NOT rendered.
 * Leaving them greyed out is an invitation to retype them by hand, which is the
 * exact operational error the gate exists to prevent. What stays is the read —
 * unchanged, in words — so STAND DOWN can never be misread as a direction.
 *
 * THE TRUST LINE IS NOT OPTIONAL
 * PBO 89% and this setup type's record sit on the face of the card at the same
 * weight as the numbers, permanently. A card that prints an entry, a stop and a
 * size is precisely the surface that invites someone to stop reading everything
 * else, so the thing most likely to be skipped is the thing pinned in place.
 */

import { h } from "../ui/dom";
import { pkLabel, pkRows, pkWhy, type PkRow } from "../ui/panelkit";
import { renderEffect, type ReadSignal } from "../core/signal";
import { TRUST_LINE, type Gate, type Verdict } from "./gates";
import type { TradePlan } from "./plan";
import type { KnowledgePrior } from "../learn/knowledge";

export interface SetupView {
  readonly verdict: Verdict;
  readonly plan: TradePlan | null;
  /**
   * The stop in ATR measured against the ATR ON SCREEN NOW.
   *
   * Separate from `plan.stopAtrMultiple`, which freezes when the plan is
   * drawn and the plan is held still on purpose. Rendering the frozen one made
   * the card state a ratio from a moment that had passed — measured on XAUUSD
   * across a timeframe switch as "23.84× ATR" while the true figure was
   * 1.83×, on the strength of which the card refused the trade. See
   * `stopAtrNow` in setup/plan.ts.
   */
  readonly stopAtrLive: number;
  /** Why there is no plan, when there is none. */
  readonly planProblem: string | null;
  readonly size: {
    readonly qty: string;
    readonly riskMoney: string;
    readonly riskPct: string;
    readonly notional: string;
    readonly margin: string;
  } | null;
  readonly gates: readonly Gate[];
  readonly symbol: string;
  readonly timeframe: string;
  /** This setup type's real record, or null when there is not one yet. */
  readonly record: string | null;
  /**
   * How THIS CARD's own reads have resolved, or null when nothing is known.
   *
   * Not the same question as `record`, and the two sit together on purpose:
   *
   *   record   what you did, and how it went          (your journal)
   *   learned  what this card said, and how that went (its own claims)
   *
   * You can trade badly on good reads and well on bad ones, so a card carrying
   * only the first lets its own accuracy go unexamined for ever. This is the
   * card being accountable for itself.
   */
  readonly learned: string | null;
  /**
   * Management of the position you are already in, or null when there is none.
   *
   * Separate from `plan` because they answer opposite questions and are true
   * at different times: a plan is what to do if you are flat, and this is what
   * to do because you are not. Showing an entry plan while a position is open
   * is how somebody ends up doubling into a trade they meant to be managing.
   */
  readonly exit: ExitPanel | null;
  /**
   * What the read is standing on, and what it is not.
   *
   * WHY THE CARD NEEDED THIS
   * The verdict line said "on 24% coverage" and stopped there. That number is
   * the single most important qualifier on the whole card — it is the
   * difference between four sources agreeing out of four and four out of
   * seventeen — and it was unactionable, because nothing said WHICH sources
   * were silent or whether their silence was fixable.
   *
   * Measured on a fresh BTCUSDT 1m load, the answer was that most of them had
   * simply never been asked: regime, forecast, derivatives and the cross-venue
   * spread all sat behind panels nobody had opened. That is a completely
   * different situation from a thin market, and the card was rendering them
   * identically.
   */
  readonly evidence: EvidenceSummary | null;
  /**
   * The setup engine's answer, when it is that there is no setup.
   *
   * WHY THIS EXISTS AS ITS OWN FIELD
   * With nothing found, the card used to render a full plan, label it
   * "discretionary" and let the gates explain themselves — so a chart with no
   * idea on it read as "1 gate failed". Those are opposite situations: one
   * says loosen a rule, the other says there is nothing to loosen a rule FOR.
   * The operator photographed the wrong one twice.
   */
  readonly setupRefusal: string;
  /** What the best rejected candidate is waiting for. Empty when none. */
  readonly setupWaitingFor: string;
  /**
   * How the chosen setup was arrived at. Empty when there is none.
   *
   * A setup name on its own does not distinguish "the only thing on the chart"
   * from "the best of ninety-one". Same word, very different amount behind it.
   */
  readonly setupWhy: string;
  /**
   * What happened the last N times this setup appeared on this chart.
   *
   * WHY A SCORE NEEDED A COMPANION
   * "Scored 88, best of 273 candidates" is an ordinal. It says this beat the
   * others; it says nothing about whether the idea makes money, and a card
   * that shows only the ordinal invites the reader to supply the missing half
   * themselves — usually optimistically. This is the base rate, replayed from
   * the operator's own bars by setup/simulate.ts.
   *
   * Null when there is no chosen setup, or no plan to take the R from.
   */
  readonly history: SetupHistory | null;
}

/**
 * The replayed track record of one setup kind on one chart.
 *
 * Flattened out of `Simulation` on purpose: the card needs eight numbers and a
 * sentence, and handing the view the full trial list would invite it to start
 * computing its own statistics next to the ones the module already computed.
 */
export interface SetupHistory {
  /** The sentence, safe to render verbatim. Says why when it can say little. */
  readonly note: string;
  readonly n: number;
  readonly wins: number;
  readonly hitRate: number | null;
  /** Wilson lower bound. The number to act on, when acting on one. */
  readonly hitLow: number | null;
  readonly expectancy: number | null;
  /**
   * The hit rate this R multiple needs just to break even.
   *
   * Shown beside the measured rate because 40% is excellent at 3R and ruinous
   * at 1R, and a card showing one without the other is showing half a fact.
   */
  readonly breakEven: number;
  readonly medianBars: number | null;
  /** Below MIN_TRIALS: quote the count, characterise nothing. */
  readonly enough: boolean;
  /** The whole expectancy interval sits below zero. History is against it. */
  readonly adverse: boolean;
  /** Bars the replay actually covered. Shown because n depends on it. */
  readonly bars: number;
  /**
   * Whether reaching further back could still add anything.
   *
   * False once the archive already holds the full target depth — at which
   * point the button would page a vendor and return the same sample, and a
   * control that visibly does nothing teaches the operator to distrust the
   * ones that do.
   */
  readonly canDeepen: boolean;
  /** A deeper pass is running. */
  readonly busy: boolean;
  /** What the deeper pass is doing, while it does it. Empty when idle. */
  readonly progress: string;
  /**
   * What the replay says that the ranking does not. Empty when they agree.
   *
   * The engine ranks by structure and the replay by record, and on a real
   * chart they often name different setups — measured on ETHUSDT 1h, the
   * engine chose a liquidity sweep with two completed instances in six
   * thousand bars while CHoCH had eighty-seven. Naming the disagreement is
   * strictly better than blending it away: a second opinion can be argued
   * with, a blended number has already settled the argument in private.
   */
  readonly disagreement: string;
  /** Other setups on this chart that clear break-even, best edge first. */
  readonly alternatives: readonly string[];
  /**
   * The state of the whole field, in one sentence.
   *
   * Shown even — especially — when it is "ten kinds have a record here and
   * none of them clears break-even", which is what ETHUSDT 1h actually says at
   * 1R over six thousand bars. A card that renders alternatives when they
   * exist and nothing when they do not is a card that only ever delivers good
   * news, and the absence of an edge is the more useful half of this module.
   */
  readonly fieldNote: string;
  /**
   * What the KNOWLEDGE BASE says about this setup in the conditions you are
   * actually in. A second line, beside the replay above it and never instead
   * of it.
   *
   * THE TWO LINES ANSWER DIFFERENT QUESTIONS AND MUST BOTH BE ON SCREEN.
   * Everything above is this chart's own window, replayed now: in-sample by
   * construction, because the pattern was FOUND on the bars it is scored
   * against. This is the accumulated base — every past harvest of this
   * instrument, sliced by regime, session and hour — so it can say "this works
   * here but not while it is chopping", which no single-window replay can.
   *
   * It is reported BESIDE the score and never folded into it. See
   * `learn/knowledge.ts` and the measured PBO of 89% that makes that
   * distinction the whole point.
   *
   * Optional: absent until the shell passes it, and the strip simply has one
   * line when it is. A missing prior is not an empty one.
   */
  readonly prior?: KnowledgePrior | null | undefined;
}

export interface EvidenceSummary {
  readonly coverage: number;
  /** Sources that answered, best contribution first. */
  readonly answered: readonly { readonly label: string; readonly reason: string }[];
  /** Sources that were asked and did not answer, with why. */
  readonly missing: readonly {
    readonly label: string;
    readonly reason: string;
    /** `failed` is fixable and says so; `absent` had nothing to say. */
    readonly kind: "absent" | "failed" | "unavailable";
  }[];
  /** True while a lane is still loading, so silence is not read as an answer. */
  readonly loading: boolean;
  /**
   * What is still being waited for, and when it will next be asked. Empty when
   * nothing is.
   *
   * WHY THIS IS ON THE CARD AND NOT IN A LOG
   * A refusal the operator cannot act on trains them to ignore refusals. "34%
   * coverage" is a fact; "34% coverage because the regime service is not
   * answering, retrying in 42s" is the same fact with the next move attached —
   * and the difference is whether they go and start a service or conclude the
   * terminal is broken. Built by `supervisorLine` from the retry state itself,
   * so it cannot describe a retry that is not actually scheduled.
   */
  readonly retrying: string;
}

export interface ExitPanel {
  readonly openR: number;
  readonly barsHeld: number;
  /** The most urgent thing, already ordered by consequence. */
  readonly headline: string | null;
  readonly headlineKind: string | null;
  readonly lines: readonly string[];
}

export interface SetupCardOptions {
  readonly view: ReadSignal<SetupView | null>;
  /** Send the plan to the Calculator, pre-filled. */
  onCopyToCalculator(plan: TradePlan): void;
  onOpenDecision(): void;
  /**
   * Reach further back and replay again.
   *
   * Explicit rather than automatic: backfilling pages a vendor, and doing that
   * on every chart change would fire dozens of requests for a panel nobody may
   * be looking at. See the header of setup/deep.ts.
   */
  onDeepen(): void;
}

const fmt = (n: number): string =>
  Math.abs(n) >= 1000
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toFixed(Math.abs(n) >= 1 ? 4 : 6);

/**
 * The base-rate strip.
 *
 * THREE THINGS IT REFUSES TO DO
 *
 * 1. It never shows a rate without the count beside it. "62%" invites a
 *    decision; "62% of 8" invites the right one, which is usually to wait.
 *
 * 2. It never shows a hit rate without the break-even for the R being traded.
 *    A reader who sees 45% and no reference point supplies their own, and the
 *    one they supply is 50% — which is correct at 1R and badly wrong at 3R.
 *
 * 3. It never rounds a small sample up into a claim. Below MIN_TRIALS the
 *    strip states the count and stops; `enough` is false and the numbers are
 *    suppressed rather than greyed, because a greyed-out number still gets
 *    read.
 */
export function renderHistory(hist: SetupHistory, onDeepen: () => void): HTMLElement {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const stat = (label: string, value: string, title: string, tone?: string): HTMLElement =>
    h(
      "span",
      { class: "setup-hist-stat", ...(tone ? { "data-tone": tone } : {}), title },
      h("span", { class: "setup-hist-k", text: label }),
      h("span", { class: "setup-hist-v", text: value }),
    ) as HTMLElement;

  const stats: HTMLElement[] = [];

  /* The count first, always. It is the number that licenses every other one. */
  stats.push(
    stat(
      "sample",
      `${hist.n}`,
      hist.enough
        ? `${hist.n} completed instances of this setup in the history loaded for this chart`
        : `Only ${hist.n} completed instances — too few to characterise. Load more history, or wait.`,
      hist.enough ? undefined : "thin",
    ),
  );

  if (hist.enough && hist.hitRate !== null && hist.hitLow !== null) {
    /* Compared against break-even, not against 50%. */
    const beats = hist.hitLow >= hist.breakEven;
    stats.push(
      stat(
        "hit",
        `${pct(hist.hitRate)} (≥${pct(hist.hitLow)})`,
        `${hist.wins} of ${hist.n} reached target. The bracketed figure is the 95% Wilson lower bound — the rate this sample actually supports.`,
        beats ? "good" : "bad",
      ),
    );
    stats.push(
      stat(
        "break-even",
        pct(hist.breakEven),
        "The hit rate this reward-to-risk needs just to cover its losers. Below it, the setup loses money however good it looks.",
      ),
    );
    if (hist.expectancy !== null) {
      stats.push(
        stat(
          "per attempt",
          `${hist.expectancy >= 0 ? "+" : ""}${hist.expectancy.toFixed(2)}R`,
          "Average result in R across past cases (unfinished ones valued at the end).",
          hist.expectancy > 0 ? "good" : "bad",
        ),
      );
    }
    if (hist.medianBars !== null) {
      stats.push(
        stat("median", `${Math.round(hist.medianBars)} bars`, "Typical number of bars until target or stop was hit."),
      );
    }
  }

  return h(
    "div",
    { class: "setup-hist", "data-adverse": String(hist.adverse), "data-thin": String(!hist.enough) },
    h(
      "div",
      { class: "setup-hist-head" },
      h("span", { class: "setup-hist-label", text: "History on this chart" }),
      /* The bar count sits in the header, not in the stats row, because it
         qualifies every number below it rather than being one of them. */
      h("span", {
        class: "setup-hist-span",
        text: hist.busy ? hist.progress || "reaching back…" : `${hist.bars.toLocaleString()} bars`,
      }),
    ),
    h("p", { class: "setup-hist-note", text: hist.note }),
    /* THE SECOND LINE. What the accumulated base says about this setup in the
       conditions on screen, under the in-sample replay and never in place of
       it. Rendered only when the base has something — a row that says "nothing
       yet" on every render is noise that trains people to skip the strip it
       lives in, which is the same argument `cardLine` makes about itself. */
    ...(hist.prior && hist.prior.standing !== "none"
      ? [
          h("p", {
            class: "setup-hist-prior",
            "data-standing": hist.prior.standing,
            "data-stale": String(hist.prior.stale),
            text: hist.prior.line,
            title:
              "From your stored history of this instrument, split by market condition. Shown beside the read, not mixed into it.",
          }),
        ]
      : []),
    h("div", { class: "setup-hist-stats" }, ...stats),
    /* Said in words, not left to the colour of a chip. A red pill is a hint;
       this is the sentence that stops the trade. */
    ...(hist.adverse
      ? [
          h("p", {
            class: "setup-hist-warn",
            text: "Every plausible reading of this sample is a losing one. That is a reason to skip it, not to size down.",
          }),
        ]
      : []),
    /* The state of the field, always. See `fieldNote`. */
    ...(hist.fieldNote ? [h("p", { class: "setup-hist-field", text: hist.fieldNote })] : []),
    /* The disagreement, in words, before any alternatives. */
    ...(hist.disagreement ? [h("p", { class: "setup-hist-dis", text: hist.disagreement })] : []),
    ...(hist.alternatives.length > 0
      ? [
          h(
            "ul",
            { class: "setup-hist-alts" },
            ...hist.alternatives.map((line) => h("li", { class: "setup-hist-alt", text: line })),
          ),
        ]
      : []),
    /* Offered whenever the sample is thin AND the history has not already been
       extended — the two conditions under which the button can actually change
       the answer. Hiding it once deepened matters: a control that does nothing
       teaches the operator to distrust the ones that do. */
    ...(!hist.enough && hist.canDeepen
      ? [
          h(
            "button",
            {
              class: "setup-hist-deepen",
              type: "button",
              disabled: hist.busy ? "" : null,
              title:
                "Fetch older bars for this instrument and replay again. Costs a few vendor requests, so it is asked for rather than assumed.",
              onclick: onDeepen,
            },
            hist.busy ? "Reaching back…" : "Reach further back",
          ),
        ]
      : []),
    /* The counterweight, and it is not decoration. This whole strip is
       in-sample by construction — the pattern was FOUND on the bars it is
       being scored against — so it is evidence, not a verdict. */
    /* Behind a disclosure since v53, and only because the verdict above it
       already carries the consequence: an adverse history says so in words
       (`setup-hist-warn`), and the PBO line stays inline further down. */
    withClass(
      pkWhy(
        "Tested on the same history the pattern was found in, so it flatters. A rough guide, not a forecast.",
        "About this history",
      ),
      "setup-hist-caveat",
    ),
  ) as HTMLElement;
}

export function createSetupCard(opts: SetupCardOptions): HTMLElement {
  const el = h("section", { class: "setup" }) as HTMLElement;

  renderEffect(() => {
    el.textContent = "";
    const v = opts.view();

    if (!v) {
      el.appendChild(
        h("p", {
          class: "setup-idle",
          text: "No read yet — the Setup card fills in once the chart has enough history.",
        }),
      );
      return;
    }

    /**
     * "Blocked" means REFUSED, not "anything other than go".
     *
     * `armed` and `conflict` both pass the gates, and both need the numbers on
     * screen: armed is when you set the alert at the level, and conflict is a
     * sizing decision you cannot make without seeing the size. Treating every
     * non-`go` state as blocked is what hid the plan for the two states that
     * describe most of a trading day.
     */
    const blocked = v.verdict.kind === "stand-down" || v.verdict.kind === "unknown";

    // ------------------------------------------------------------ header ---
    el.appendChild(
      h(
        "header",
        { class: "setup-head" },
        /* The word "Setup" is NOT repeated here. This card has exactly one
           mount point — the dock panel whose header already says Setup — so
           the tag rendered "SETUP / SETUP BTCUSDT · 1m", one line under the
           other, and spent the most prominent row of the most important panel
           restating its own title. The instrument leads instead, which is the
           thing that actually changes. */
        h("span", { class: "setup-inst", text: `${v.symbol} · ${v.timeframe}` }),
        /* The strategy, named. v39 said which setup had fired and this never
           did — "STAND DOWN" with no subject leaves you unable to tell which
           of thirteen detectors the card is even talking about. */
        /* Always rendered. A null strategy is a DISCRETIONARY read, which is
           itself a category worth naming — an empty space just looks like a
           missing value. */
        h("span", {
          class: "setup-strat",
          "data-none": String(v.verdict.strategy === null),
          /* "no setup" and "discretionary" are different claims. The first says
             the engine looked and found nothing takeable; the second says the
             read stands on evidence rather than on a pattern, which is a
             legitimate thing to trade. Rendering both as "discretionary" is how
             an empty chart came to look like a blocked one. */
          text: v.verdict.strategy ?? (v.setupRefusal ? "no setup" : "discretionary"),
          title: v.verdict.strategy
            ? `This plan came from the ${v.verdict.strategy} detector, and its stop is that pattern's own invalidation level`
            : v.setupRefusal || "No pattern behind this read — discretionary",
        }),
        /* One click away since v53: the engine's scoring arithmetic ("scored
           65, beat 58 candidates, 54 not takeable…") was the densest line on
           the card and qualifies the name beside it rather than being the
           finding. Still on the header row, still the same words. */
        v.setupWhy ? withClass(pkWhy(v.setupWhy, "Why this setup"), "setup-why") : null,
        h("span", {
          class: "setup-count",
          "data-kind": v.verdict.kind,
          text:
            v.setupRefusal
              ? "nothing to trade"
              : v.verdict.kind === "stand-down"
                ? `${v.verdict.blocking.length} gate${v.verdict.blocking.length === 1 ? "" : "s"} failed`
                : v.verdict.kind === "unknown"
                  ? `${v.verdict.unknown.length} not checked`
                  : `${v.verdict.passed} of ${v.verdict.total} gates`,
        }),
      ),
    );

    // ----------------------------------------------------------- verdict ---
    el.appendChild(
      h(
        "div",
        { class: "setup-verdict", "data-kind": v.verdict.kind },
        h("div", { class: "setup-headline", text: v.verdict.headline }),
        /* The read, always, and especially when blocked. */
        h("p", { class: "setup-read", text: v.verdict.readLine }),
        /* THE ENGINE'S REFUSAL OUTRANKS THE GATES' ONE, because it is upstream
           of them: a gate refuses a trade, and this says there was never a
           trade to refuse. Shown INSTEAD of the gate sentence so the card makes
           one claim about why nothing is happening rather than two. */
        ...(v.setupRefusal
          ? [
              h("p", { class: "setup-nosetup", text: v.setupRefusal }),
              ...(v.setupWaitingFor
                ? [h("p", { class: "setup-waiting", text: `Nearest miss: ${v.setupWaitingFor}` })]
                : []),
            ]
          : blocked
            ? [
                h("p", {
                  class: "setup-notdirection",
                  text: "Your own rules are blocking this trade — this is not a view on direction.",
                }),
              ]
            : []),
        /* THE BASE RATE, directly under the read.
           Placed here rather than at the foot of the card because it is the
           number most likely to change the decision, and a track record you
           have to scroll to is a track record nobody reads. */
        ...(v.history ? [renderHistory(v.history, opts.onDeepen)] : []),
        /* The macro disagreement, in full. Rendered as prominently as the
           headline because it is a sizing instruction, not a footnote. */
        ...(v.verdict.conflictNote
          ? [h("p", { class: "setup-conflict", text: v.verdict.conflictNote })]
          : []),
      ),
    );

    // -------------------------------------------------- plan and size ---
    /**
     * THE PLAN IS ALWAYS SHOWN WHEN ONE EXISTS. This reverses the rewrite.
     *
     * v39 rendered it in every state and dimmed it to half opacity when it was
     * not live (`planStyle = planLive ? "" : "opacity:.5"`). The rewrite hid it
     * outright on any block, reasoning that greyed-out numbers invite you to
     * retype them by hand.
     *
     * That reasoning protects the wrong thing. The numbers are how you SET AN
     * ALERT, size a future trade, or simply understand what the gate is
     * refusing — none of which is entering a position. Hiding them made the
     * card unable to answer the question it exists for, on the states it is in
     * most of the time.
     *
     * The guard that actually matters is kept and is unchanged: "Copy to
     * Calculator" stays disabled while a gate refuses, so the plan can be read
     * but not acted on in one click. Reading is not the operational error;
     * one-click acting on a refused setup is.
     */
    if (v.plan) {
      const p = v.plan;
      el.appendChild(
        h(
          "div",
          { class: "setup-sec", "data-refused": String(blocked) },
          secLabel(
            "The plan",
            blocked
              ? "not live — a check is failing"
              : v.verdict.kind === "armed"
                ? "not live yet — set an alert at the entry zone"
                : "fixed until price moves 0.4 ATR",
          ),
          kv([
            ["Entry zone", `${fmt(p.entryLow)} – ${fmt(p.entryHigh)}`],
            ["Stop", fmt(p.stop)],
            ["Target 1 · 1R", fmt(p.target1)],
            ["Target 2 · 2R", fmt(p.target2)],
            /* The distance is the number; where it came from is provenance.
               Concatenating them made one 38-character value that could not fit
               beside its own label and wrapped the row to three lines. */
            [
              "Stop distance",
              fmt(p.r),
              Number.isFinite(v.stopAtrLive)
                ? `${v.stopAtrLive.toFixed(2)}× ATR, from ${p.stopFrom}`
                : `from ${p.stopFrom} — no ATR to measure it against`,
            ],
          ]),
          /* What was given up, when the level that would actually invalidate
             the idea was further away than the operator's own ceiling allows.
             Said out loud rather than silently swallowed: this stop can be hit
             without the idea being wrong, and that is the trade-off being
             made on their behalf. */
          /* `Number.isFinite`, not `!== null`: the honest question is "is there
             a number to render", and a plan restored or constructed without
             the field answers it correctly where an identity check against
             null does not. */
          !Number.isFinite(p.structureOutOfReach)
            ? null
            : h("p", {
                class: "setup-caveat",
                text: `The real invalidation level is ${(p.structureOutOfReach ?? 0).toFixed(1)}× ATR away — beyond your max stop — so this uses a volatility stop. Price can hit it without the idea being wrong.`,
              }),
        ),
      );

      if (v.size) {
        el.appendChild(
          h(
            "div",
            { class: "setup-sec", "data-refused": String(blocked) },
            secLabel(
              "The size",
              blocked ? "what it would be if the checks passed" : "from Settings ▸ Account",
            ),
            kv([
              ["Quantity", v.size.qty],
              ["Risk if stopped", v.size.riskMoney, v.size.riskPct],
              ["Notional", v.size.notional],
              ["Margin", v.size.margin],
            ]),
          ),
        );
      }
    } else if (v.planProblem) {
      el.appendChild(
        h("p", { class: "setup-problem", text: v.planProblem }),
      );
    }

    // ------------------------------------------------------------- gates ---
    el.appendChild(
      h(
        "div",
        { class: "setup-sec" },
        secLabel("Checks", blocked ? "what is blocking" : "any ✗ means no trade"),
        ...v.gates.map((g) =>
          h(
            "div",
            { class: "setup-gate", "data-status": g.status },
            h("span", {
              class: "setup-mark",
              text: g.status === "pass" ? "✓" : g.status === "block" ? "✗" : "?",
            }),
            h(
              "span",
              { class: "setup-gate-body" },
              h("span", { class: "setup-gate-text", text: g.text }),
              ...(g.clears && g.status !== "pass"
                ? [h("span", { class: "setup-clears", text: g.clears })]
                : []),
              /* The long explanation, folded: the line above is the answer,
                 this is the reasoning for whoever wants it. */
              ...(g.why ? [pkWhy(g.why, "Why?")] : []),
            ),
          ),
        ),
      ),
    );

    // ---------------------------------------------------------- evidence ---
    /**
     * What the read is standing on. Placed directly BELOW the gates and above
     * everything else, because it qualifies the verdict at the top of the card
     * and a qualifier the reader reaches after the plan and the size is a
     * qualifier they have already acted without.
     *
     * Collapsed by default: on a healthy read this is a one-line reassurance,
     * and only worth opening when the coverage figure is low — which is exactly
     * when the summary line makes itself impossible to ignore.
     */
    if (v.evidence) {
      const ev = v.evidence;
      const covPct = Math.round(ev.coverage * 100);
      const fixable = ev.missing.filter((m) => m.kind === "failed").length;
      /* `unavailable` is not a gap and must not be counted as one here either,
         or the card would contradict the coverage figure it just printed. */
      const gaps = ev.missing.filter((m) => m.kind !== "unavailable");

      el.appendChild(
        h(
          "details",
          { class: "setup-ev", "data-thin": String(covPct < 50) },
          h(
            "summary",
            { class: "setup-ev-sum" },
            h("span", {
              class: "setup-ev-cov",
              "data-thin": String(covPct < 50),
              text: `Data: ${ev.answered.length} of ${ev.answered.length + gaps.length} sources (${covPct}%)`,
            }),
            h("span", {
              class: "setup-ev-note",
              text: ev.loading
                ? "still loading"
                : gaps.length === 0
                  ? "all sources answered"
                  : fixable > 0
                    ? `${gaps.length} missing, ${fixable} failed`
                    : `${gaps.length} missing`,
            }),
          ),
          h(
            "div",
            { class: "setup-ev-body" },
            ev.retrying ? h("p", { class: "setup-ev-retry", text: ev.retrying }) : null,
            ...ev.answered.map((a) =>
              h(
                "div",
                { class: "setup-ev-row", "data-kind": "answered" },
                h("span", { class: "setup-ev-mark", text: "✓" }),
                h(
                  "span",
                  { class: "setup-ev-text" },
                  h("span", { class: "setup-ev-label", text: a.label }),
                  h("span", { class: "setup-ev-why", text: a.reason }),
                ),
              ),
            ),
            ...ev.missing.map((m) =>
              h(
                "div",
                { class: "setup-ev-row", "data-kind": m.kind },
                h("span", {
                  class: "setup-ev-mark",
                  /* Three marks for three different facts. A source that ERRORED
                     is something you can go and fix; one that had nothing to say
                     is the market; one this build does not have is neither. */
                  text: m.kind === "failed" ? "!" : m.kind === "unavailable" ? "–" : "·",
                }),
                h(
                  "span",
                  { class: "setup-ev-text" },
                  h("span", { class: "setup-ev-label", text: m.label }),
                  h("span", { class: "setup-ev-why", text: m.reason }),
                ),
              ),
            ),
            h("button", {
              class: "ghost-btn setup-ev-open",
              type: "button",
              text: "Open the Decision desk",
              onclick: () => opts.onOpenDecision(),
            }),
          ),
        ),
      );
    }

    // -------------------------------------------------------------- exit ---
    /**
     * Rendered ABOVE the trust line and below the gates, because while a
     * position is open this is the only part of the card that is actionable.
     * The headline is the one thing that needs doing; the rest is the state of
     * the rules, which is worth being able to check but is not news.
     */
    if (v.exit) {
      const ex = v.exit;
      el.appendChild(
        h(
          "div",
          { class: "setup-exit", ...(ex.headlineKind ? { "data-kind": ex.headlineKind } : {}) },
          h(
            "div",
            { class: "setup-exit-head" },
            h("span", { class: "setup-exit-tag", text: "Open position" }),
            h("span", {
              class: "setup-exit-r num",
              "data-sign": ex.openR >= 0 ? "pos" : "neg",
              text: `${ex.openR >= 0 ? "+" : ""}${ex.openR.toFixed(2)}R`,
            }),
            h("span", {
              class: "setup-exit-held",
              text: `${ex.barsHeld} bar${ex.barsHeld === 1 ? "" : "s"} held`,
            }),
          ),
          ...(ex.headline
            ? [h("p", { class: "setup-exit-headline", text: ex.headline })]
            : []),
          ...ex.lines.map((line) => h("p", { class: "setup-exit-line", text: line })),
        ),
      );
    }

    // ------------------------------------------------------------- trust ---
    el.appendChild(
      h(
        "div",
        { class: "setup-trust" },
        ...(v.record
          ? [h("div", { class: "setup-record", text: v.record })]
          : [
              h("div", {
                class: "setup-record",
                text: "No track record on your own trades for this setup yet.",
              }),
            ]),
        /* Rendered only when there is something to say. A row that reads "not
           enough data" on every single render is noise, and noise in this
           position trains people to skip the whole trust block — including the
           PBO line beneath it, which is the most important sentence on the
           card. */
        ...(v.learned ? [h("div", { class: "setup-learned", text: v.learned })] : []),
        h("p", { class: "setup-pbo", text: TRUST_LINE }),
      ),
    );

    // ----------------------------------------------------------- actions ---
    el.appendChild(
      h(
        "div",
        { class: "setup-actions" },
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: "Copy to Calculator",
          disabled: blocked || !v.plan,
          title: blocked ? "Nothing to copy while a check is failing." : "",
          onclick: () => v.plan && opts.onCopyToCalculator(v.plan),
        }),
        h("button", {
          class: "ghost-btn",
          type: "button",
          text: "Why this read?",
          onclick: () => opts.onOpenDecision(),
        }),
      ),
    );
  });

  return el;
}

/**
 * A label/value grid.
 *
 * THE MEASUREMENT THAT FORCED THE THIRD COLUMN
 * The grid was `minmax(0, 1fr) auto`, so the VALUE column took its max-content
 * width and the label column got whatever survived. In a 307px card one 38-
 * character value ("458.2093 · 1.00× ATR, from volatility") claimed 270px and
 * left the labels 25px — "Target 1 · 1R" wrapped to THREE lines, and the plan
 * block rendered 273px tall to show five numbers. The card came to 1,084px in
 * an 820px dock, which is the whole of "the right side card is too big".
 *
 * So: the label column is sized to its own content and the value column takes
 * the rest, and anything that qualifies a value — where a stop distance came
 * from, what a risk is as a percentage — is a `note` on its own line rather
 * than more text fighting for the same row. The number you read stays the
 * number; the provenance sits under it, quieter.
 */
/**
 * A section label: a short term, then what it means right now.
 *
 * It used to be one string — "The plan · NOT LIVE, a gate is refusing it" —
 * set in tracked uppercase mono at 11.5px. Forty-two characters of that does
 * not fit a 307px card, so the label wrapped to two lines of red capitals and
 * shouted louder than the verdict it was annotating. Splitting it gives the
 * term the label treatment and lets the qualifier be an ordinary sentence,
 * which wraps without becoming a headline.
 */
const secLabel = pkLabel;

type Row = readonly [string, string] | readonly [string, string, string];

function kv(rows: ReadonlyArray<Row>): HTMLElement {
  return pkRows(
    rows.map(
      (row): PkRow => ({ label: row[0], value: row[1], ...(row[2] ? { note: row[2] } : {}) }),
    ),
  );
}

/** Tag a shared component with this card's own class, for placement only. */
function withClass(el: HTMLElement, cls: string): HTMLElement {
  el.classList.add(cls);
  return el;
}
