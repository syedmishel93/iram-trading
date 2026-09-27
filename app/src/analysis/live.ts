/**
 * The live analysis engine — what just CHANGED, as opposed to what is true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS FILLS
 *
 * Every panel in the inspector answers a standing question: what is the regime,
 * where is the entry, how wide is the band. All of them recompute when a bar
 * closes and then sit there. Nothing in the terminal watches the market and
 * says "this changed, and here is the measurement that changed it" — so an
 * operator who looks away for ten minutes has no way to find out what happened
 * while they were not looking, short of re-reading ten panels and remembering
 * what each of them said before.
 *
 * This is that: a pure function from (previous state, snapshot) to (next state,
 * events). Nothing in here touches the DOM, owns a timer, or reads a clock —
 * `now` arrives on the snapshot, which is what makes hours of market activity
 * testable in microseconds. Same rule and same reason as `scan/watch.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY EVENT IS A MEASUREMENT AGAINST A STATED THRESHOLD
 *
 * There is no "momentum looks strong" in here and there will not be one. Each
 * event carries:
 *
 *   what      one sentence, addressed to the operator
 *   because   the measurement AND the threshold it was checked against
 *   values    the numbers, as numbers, so the UI formats and nothing is retyped
 *
 * A check that cannot measure its input produces NO event rather than a
 * softened one — the volume spike refuses on a feed that reports no volume, the
 * volatility band refuses under 60 prior readings, the outlier test refuses
 * without a sigma. An absent event is the honest output; a hedged one is not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRANSITIONS, NOT STATES — AND THE COOL-OFF
 *
 * A condition that is TRUE is not news. A condition that BECAME true is. So
 * every level check publishes a condition KEY, the engine latches the set of
 * keys that are currently true, and an event is emitted only for a key that was
 * not in the previous set. While a stop stays within a quarter of R, the
 * `plan:stop-near` key stays latched and fires nothing. When it clears and
 * comes back, it fires again — unless it comes back inside `coolOffMs`, which
 * is what stops a value sitting on a threshold from producing a queue of
 * identical events.
 *
 * THE FIRST EVALUATION FIRES NOTHING. Loading a chart makes a dozen conditions
 * true at once — the gates are blocked, the feed is live, the venue is open —
 * and none of them just happened. The first snapshot latches them silently.
 * `scan/watch.ts` makes the same promise for the same reason ("first scan never
 * notifies").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BUDGET, AND WHERE THE WORK ACTUALLY GOES
 *
 * `evaluate` runs on every tick — several times a second on a live 1m chart —
 * so the per-tick path is deliberately O(1) in the bar count: the feed quality,
 * the venue state, the verdict, and price against four levels of a plan that is
 * already built. Nothing in it walks the series.
 *
 * Everything that walks the series runs ONLY when a bar closes: ATR and its
 * percentile, the EWMA sigma, the volume median, the regime classification and
 * the structure scan. Their keys are CARRIED FORWARD across ticks (see
 * `activeBar`), because a latch that evaporated between bar closes would make
 * every bar-close condition re-fire once a bar.
 *
 * MEASURED, node v26.7.0, 1,000 bars, 300 detections, a live plan and a
 * seven-gate verdict — 2,000 tick evaluations and 40 forced bar closes:
 *
 *     per tick (no bar close)     0.0050 ms mean, 0.0261 ms p99
 *     per bar close (everything)  1.225 ms mean, 2.450 ms p99
 *
 * The tick path is 400x under the 2ms budget, and it is O(1) in the bar count —
 * the only thing it touches in the series is the last element. The bar-close
 * path is the expensive one and lands just inside the same budget; more than
 * half of it is `classifyRegimes`, measured separately at 0.714 ms over 400
 * bars and 1.885 ms over 1,000. That ratio is why the regime window is capped
 * — see `REGIME_WINDOW` — and why none of this runs on a tick.
 */

import type { BarView } from "../chart/series";
import { px, type Detection } from "../detect/types";
import type { Verdict } from "../setup/gates";
import type { TradePlan } from "../setup/plan";
import type { FeedState } from "../data/feed";
import { DELAYED_MS, STALE_BARS } from "../data/feed";
import type { MarketState } from "../data/sessions";
import { atr as atrSeries } from "../chart/indicators";
import { ewmaSigma, EWMA_LAMBDA } from "./forecast";
import {
  REGIME_BLURB,
  REGIME_LABEL,
  VOLATILE_PCTILE,
  VOL_LOOKBACK,
  classifyRegimes,
  type Regime,
} from "../backtest/regime";

/* ─────────────────────────────────────────────────────────── the vocabulary */

/**
 * How loudly an event asks for the operator.
 *
 * NOT a direction and never coloured like one. `act` is the attention role,
 * `watch` is muted text, `info` is faint — see `styles/livefeed.css`. An event
 * is a thing that happened, and a market that just broke structure downward is
 * exactly as worth reading as one that broke upward.
 */
export type LiveSeverity = "info" | "watch" | "act";

export type LiveEventKind =
  /* Structure, from the detectors the chart is already drawing. */
  | "structure-break"
  /* The setup engine's answer changing shape. */
  | "setup-appeared"
  | "setup-expired"
  | "setup-flipped"
  /* The gates flipping between standing you down and letting you through. */
  | "gates-cleared"
  | "gates-blocked"
  /* Price against the plan that is already on screen. */
  | "entry-zone"
  | "stop-approach"
  | "target-approach"
  /* Measurements on the bar that just closed. */
  | "volatility-shift"
  | "outlier-bar"
  | "volume-spike"
  | "regime-change"
  /* The world around the chart. */
  | "session-open"
  | "session-close"
  | "feed-degraded"
  | "feed-recovered";

/**
 * How to read one of an event's numbers.
 *
 * The number travels as a NUMBER and the unit says how to render it, so the
 * panel, the status line and a test all format from one value. A pre-formatted
 * string would make the event's own numbers unassertable — you would be testing
 * `toFixed`.
 */
export type LiveUnit =
  | "price"
  | "percent"
  | "multiple"
  | "sigma"
  | "r"
  /** A whole thing: gates passing, bars sampled. Renders as an integer. */
  | "count"
  /**
   * A traded amount, which is NOT a count.
   *
   * MEASURED on BTCUSDT 1m: a spike bar traded 10.21716 BTC against a median of
   * 2.645215, and rendering those as counts printed "10" and "3" — a 3.9x
   * multiple shown as ten over three. Volume is quoted in the instrument's own
   * unit and is fractional on most of them.
   */
  | "quantity"
  | "percentile"
  | "seconds";

export interface LiveValue {
  readonly label: string;
  readonly value: number;
  readonly unit: LiveUnit;
}

export interface LiveEvent {
  /** Unique within one engine run. Stable, so the UI can key on it. */
  readonly id: string;
  /** The clock the snapshot carried. Never `Date.now()` read in here. */
  readonly time: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: LiveEventKind;
  readonly severity: LiveSeverity;
  /** One sentence, plain language, addressed to the operator. Render verbatim. */
  readonly what: string;
  /** The measurement and the threshold it was checked against. Render verbatim. */
  readonly because: string;
  /** The numbers behind it. */
  readonly values: readonly LiveValue[];
  /**
   * The bar this is about, in epoch ms, or null when it is not about a bar.
   *
   * A feed going stale and a venue closing are about the clock, not about a
   * candle, and giving them the newest bar's timestamp would invite the UI to
   * point at a bar that has nothing to do with them.
   */
  readonly barTime: number | null;
}

/* ──────────────────────────────────────────────────────────── the thresholds */

/**
 * Confidence a structure break needs before it is worth interrupting for.
 *
 * The detectors publish everything they find and the chart draws it; this is a
 * NOTIFICATION, which is a higher bar than a drawing. 0.5 is the midpoint of
 * the detectors' own 0..1 scale, chosen because it is the only defensible
 * round number on a scale nobody has calibrated — and it is stated here rather
 * than buried so that calibrating it later is one edit.
 */
export const STRUCTURE_MIN_CONFIDENCE = 0.5;

/**
 * How close to a plan level counts as "approaching", in R.
 *
 * R — the entry-to-stop distance — rather than a price or a percentage,
 * because it is the only unit that means the same thing on every instrument
 * and every timeframe. A quarter of R from the stop is the point at which the
 * trade has spent a quarter of what it was allowed to spend.
 */
export const APPROACH_R = 0.25;

/**
 * The quiet end of the volatility band.
 *
 * The loud end is `VOLATILE_PCTILE` (0.8) from `backtest/regime.ts` and is
 * IMPORTED rather than restated: the regime model already owns "what counts as
 * a violent bar", and a second 0.8 in this file would be free to drift from it.
 * This is its mirror, and the only number here that regime.ts does not own.
 */
export const QUIET_PCTILE = 0.2;

/** Readings needed before a percentile is a measurement rather than a shape. */
export const VOL_MIN_SAMPLE = 60;

/** A closed bar this many EWMA sigmas from flat is an outlier. */
export const OUTLIER_SIGMA = 3;

/** Bars in the rolling volume median. */
export const VOLUME_WINDOW = 50;

/** Volume this multiple of the rolling median is a spike. */
export const VOLUME_SPIKE_X = 3;

/**
 * Bars handed to `classifyRegimes` on each close.
 *
 * It is O(bars x VOL_LOOKBACK) — every bar ranks its own volatility against the
 * 250 before it — so running it over a 6,000-bar archive to read ONE label off
 * the end would cost 1.5 million inner iterations for an answer that depends on
 * the last 250. 400 is `VOL_LOOKBACK` plus the ADX warm-up plus margin, which
 * is everything the final bar's label can actually see. MEASURED, node v26.7.0:
 * 0.714 ms at 400 bars against 1.885 ms at 1,000 — the cap buys back more than
 * a millisecond of the bar-close budget for a label that cannot change.
 */
export const REGIME_WINDOW = VOL_LOOKBACK + 150;

/* ───────────────────────────────────────────────────────────── the interface */

/**
 * The Setup card's answer, as this engine needs it.
 *
 * `Verdict` and `TradePlan` are the REAL types from `setup/gates.ts` and
 * `setup/plan.ts`, not narrowed copies of them — a hand-written stub that
 * satisfies a call site and then disagrees with the definition has caused three
 * defects in this repository. What is NOT imported is `SetupView`, because it
 * lives in `setup/ui.ts`, which imports `ui/dom`; `analysis/` sits below `ui/`
 * and may not reach up into it. So the shell hands over the three fields it
 * already has rather than the view object that carries them.
 */
export interface LiveSetup {
  /**
   * The setup's human label ("Bullish fair value gap"), when the caller has
   * one. Optional: the verdict's `strategy` is a detector id, which is right
   * for keying a record and wrong in a sentence.
   */
  readonly label?: string | null;
  readonly verdict: Verdict;
  readonly plan: TradePlan | null;
  /**
   * The chosen setup's direction, or null when there is no setup.
   *
   * Separate from `plan.direction` on purpose: a gate can refuse the plan while
   * the setup still exists, and reading direction off a plan that is null would
   * make every gate block look like a setup expiring.
   */
  readonly direction: "long" | "short" | null;
}

export interface LiveSnapshot {
  /** Injected. Nothing in this module reads a clock. */
  readonly now: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly intervalMs: number;
  /**
   * The chart's series, oldest first.
   *
   * The LAST bar is the forming one whenever its interval has not elapsed —
   * `data/feed.ts` replaces it in place on every tick and pushes a new one on
   * the close. Everything measured here is measured on CLOSED bars only.
   */
  readonly bars: readonly BarView[];
  /**
   * How many of `bars` have closed, decided by the CALLER.
   *
   * NOT derived in here, and the reason is an off-by-one that would have been
   * invisible. `shell.ts` owns this fact already — `closedBarCount` is
   * `bars.length - 1`, unconditionally — and it is the prefix the detectors are
   * run over, so a detection's `to` is an index into exactly these bars. Had
   * this module worked the count out for itself (a trailing bar whose interval
   * has not elapsed is not closed — the rule `closedBars` owns in
   * scan/opportunity.ts) the two would agree on a live chart and disagree by
   * one bar the moment the feed went quiet or the venue shut, which is when the
   * last bar's interval HAS elapsed. Every structure event would then look up
   * the wrong candle and match nothing, silently, on exactly the charts nobody
   * is watching closely.
   *
   * One fact, one owner. The owner is the thing that already had it.
   */
  readonly closedLen: number;
  /**
   * The detections the chart is drawing, indexed against `bars`.
   *
   * A detection's `to` is looked up in `bars` to get the time it confirmed at.
   * Passing detections computed over a different array would silently point
   * every event at the wrong candle.
   */
  readonly detections: readonly Detection[];
  readonly setup: LiveSetup | null;
  readonly feed: FeedState;
  readonly market: MarketState;
}

export interface LiveConfig {
  /**
   * How long a condition key is barred from firing again after it fires.
   *
   * Guards against a measurement sitting on its threshold: the latch already
   * stops a condition repeating while it HOLDS, and this stops it repeating
   * while it flickers. 90s is a minute and a half — longer than one bar on the
   * fastest chart anybody watches tick by tick.
   */
  readonly coolOffMs: number;
  /** Events kept. Oldest are dropped. */
  readonly seenCap: number;
}

export const DEFAULT_CONFIG: LiveConfig = { coolOffMs: 90_000, seenCap: 200 };

export interface LiveState {
  /** `symbol|timeframe`. A change resets every latch — see `evaluate`. */
  readonly key: string;
  /** False until the first snapshot has been seen. Nothing fires before it. */
  readonly primed: boolean;
  /** Monotonic, for event ids. */
  readonly seq: number;
  /** Time of the newest CLOSED bar the engine has measured. */
  readonly lastClosedBarTime: number;
  /** Condition keys true on the last tick. Recomputed every evaluation. */
  readonly activeTick: readonly string[];
  /** Condition keys true on the last bar close. Carried across ticks. */
  readonly activeBar: readonly string[];
  /**
   * Condition keys derived from the SETUP, carried whenever there is no setup
   * in the snapshot.
   *
   * WHY THEY ARE A BUCKET OF THEIR OWN. `setup` is null when the Setup card
   * REFUSES to render, not when there is no setup — and it refuses whenever
   * the loaded symbol, the loaded timeframe, the series in hand and the
   * derived studies disagree with each other, which during a load they do
   * repeatedly, for a frame at a time. Treating each of those frames as "the
   * gates stopped passing" un-latched every setup condition and re-latched it
   * a moment later. MEASURED on a cold load of BTCUSDT 1h: a setup appearing,
   * price "entering" an entry zone it had never left, the trade standing down
   * and the setup expiring — four events describing one flicker.
   *
   * Absent is not false. The keys are held until a snapshot that actually has
   * a setup says otherwise.
   */
  readonly activeSetup: readonly string[];
  /** When each key last fired, for the cool-off. */
  readonly firedAt: Readonly<Record<string, number>>;
  /** The regime of the last closed bar, or null before the first close. */
  readonly regime: Regime | null;
  /**
   * Where volatility sat on the last close, or null before the first one.
   *
   * Same rule as `regime`, and it is here for the same measured reason: the
   * FIRST ranking is a reading, not a shift. A chart whose history arrives in
   * two parts ranks the ATR over a fraction of it, then over all of it, and
   * without this the second ranking is reported as "volatility has dropped
   * into the bottom fifth" — a statement about the archive finishing.
   */
  readonly volBand: "loud" | "quiet" | "mid" | null;
  /**
   * The plan's levels on the last snapshot that had one, or null.
   *
   * PRICE CANNOT ENTER A ZONE THAT WAS NOT THERE A MOMENT AGO. A plan is drawn
   * AROUND where price is — `buildPlan` puts the entry zone at the current
   * price — so the instant one appears, price is inside it. MEASURED on a cold
   * load of BTCUSDT 1h: "Price has entered the plan's entry zone", two seconds
   * after opening the page, about a zone that had existed for one frame.
   *
   * The same holds when a plan is REDRAWN: `stablePlan` only redraws once price
   * has drifted, and it redraws around the new price, so every redraw would
   * announce an entry nobody made. So the plan checks latch in silence on any
   * snapshot whose levels differ from the last one's, and report from the next
   * one on.
   */
  readonly planKey: string | null;
  /** The setup engine's last answer, for the appeared/expired/flipped edges. */
  readonly strategy: string | null;
  /** The last setup's HUMAN label, for the sentences. See `LiveSetup.label`. */
  readonly strategyLabel: string | null;
  readonly direction: "long" | "short" | null;
  /** True once a degradation has been reported, so "recovered" has a referent. */
  readonly degraded: boolean;
  /**
   * True once a setup has been seen at all.
   *
   * THE SECOND PRIMING PROBLEM, AND IT IS NOT THE SAME AS THE FIRST.
   *
   * `primed` covers the first SNAPSHOT. But the setup half of a snapshot does
   * not arrive with the bars: `setupView` refuses to render until the loaded
   * symbol, the loaded timeframe, the series in hand and the derived studies
   * have all caught up with each other — four guards, each of which exists
   * because it caught a real defect — so the first second of every chart has
   * bars and a null setup. When the setup finally lands, the gates, the plan
   * and the setup itself all become true at once, and MEASURED on a cold load
   * of BTCUSDT 1h that was five events in the first two seconds: a setup
   * appearing, the gates clearing, price "entering" an entry zone it was
   * already inside when the zone was drawn, the trade standing down, and the
   * setup expiring again.
   *
   * None of that is the market doing anything. It is an input becoming
   * available, which is the same class of non-event as the chart loading, so
   * it gets the same answer: latch in silence the first time, report from then
   * on.
   *
   * WHAT THIS DOES NOT FIX, STATED RATHER THAN HIDDEN. A timeframe switch
   * resets the latches and the FIRST answer on the new chart is not always the
   * settled one — `chooseSetup` re-ranks as the studies and the detections
   * catch up, so switching 1h to 1m was MEASURED producing three events in two
   * seconds: a setup appearing, that setup expiring, and the trade standing
   * down. Every one of them is a true statement about what the engine's answer
   * was at that instant, and the burst is bounded by the number of setup
   * conditions there are. The obvious cure — refuse to report a setup edge
   * until the answer has held for a whole bar — would delay a genuine
   * `gates-cleared` by up to an hour on an hourly chart, which is a worse
   * trade than three rows after a deliberate switch.
   */
  readonly sawSetup: boolean;
  /** Newest FIRST, capped at `LiveConfig.seenCap`. */
  readonly seen: readonly LiveEvent[];
}

export function emptyState(): LiveState {
  return {
    key: "",
    primed: false,
    seq: 0,
    lastClosedBarTime: 0,
    activeTick: [],
    activeBar: [],
    activeSetup: [],
    firedAt: {},
    regime: null,
    volBand: null,
    planKey: null,
    strategy: null,
    strategyLabel: null,
    direction: null,
    degraded: false,
    sawSetup: false,
    seen: [],
  };
}

/**
 * Empty the log without disarming the engine.
 *
 * The latches, the cool-offs and the regime are KEPT. Clearing the list is the
 * operator saying "I have read these", not "pretend the market is new" — and a
 * clear that reset the latches would refill the panel with every condition that
 * happens to be true right now, which is the opposite of what the button says.
 */
export function clearSeen(state: LiveState): LiveState {
  return { ...state, seen: [] };
}

/* ──────────────────────────────────────────────────────────────── internals */

/**
 * One condition, as the latch sees it.
 *
 * `silent` latches the key without emitting. Used where a condition is true but
 * there is nothing honest to SAY about it yet — the first regime classification
 * is a reading, not a change, and it has no previous regime to name.
 */
interface Candidate {
  readonly key: string;
  readonly kind: LiveEventKind;
  readonly severity: LiveSeverity;
  readonly what: string;
  readonly because: string;
  readonly values: readonly LiveValue[];
  readonly barTime: number | null;
  readonly silent: boolean;
}

function cand(c: Omit<Candidate, "silent"> & { silent?: boolean }): Candidate {
  return { ...c, silent: c.silent === true };
}

/** Median of a slice. Sorted copy — the window is 50, not the series. */
function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/* ─────────────────────────────────────────────────────── the per-tick checks */

/**
 * Everything that can be decided without walking the series.
 *
 * Ordered by CONSEQUENCE, most severe first, because that order is the order
 * events from one evaluation land in the log — the same ordering rule the
 * verdict uses.
 */
/** A plan's levels, as one comparable string. See `LiveState.planKey`. */
function planKeyOf(plan: TradePlan): string {
  return `${plan.direction}|${plan.entryLow}|${plan.entryHigh}|${plan.stop}|${plan.target1}`;
}

function setupChecks(prev: LiveState, snap: LiveSnapshot): Candidate[] {
  const out: Candidate[] = [];
  const price = snap.bars[snap.bars.length - 1]?.c ?? NaN;

  /* ---- the gates ---------------------------------------------------------
     `unknown` produces NO candidate on either side. A gate that could not be
     checked has not been passed and has not been failed, and publishing it as
     either would be the engine inventing an answer the card refuses to give. */
  const setup = snap.setup;
  /* The setup, the gates and the plan all arrive together, one beat after the
     bars. The first time they do is an input becoming available, not the market
     moving — see `sawSetup`. */
  const settling = !prev.sawSetup;
  if (setup !== null) {
    const v = setup.verdict;
    if (v.kind === "go" || v.kind === "armed") {
      out.push(
        cand({
          key: "gates:clear",
          kind: "gates-cleared",
          severity: "act",
          what:
            v.kind === "go"
              ? "All checks pass and price is in the entry zone — this trade is available now."
              : "All checks pass. Waiting for price to reach the entry zone.",
          because: `${v.passed} of ${v.total} checks pass, none failing.`,
          values: [
            { label: "Gates passing", value: v.passed, unit: "count" },
            { label: "Gates checked", value: v.total, unit: "count" },
            ...(v.watchLevel !== null
              ? [{ label: "Waiting for", value: v.watchLevel, unit: "price" as const }]
              : []),
          ],
          barTime: null,
          silent: settling,
        }),
      );
    } else if (v.kind === "stand-down" || v.kind === "conflict") {
      const first = v.blocking[0] ?? v.unknown[0] ?? null;
      out.push(
        cand({
          key: "gates:blocked",
          kind: "gates-blocked",
          severity: "watch",
          what:
            v.kind === "conflict"
              ? "Checks pass, but the wider market leans the other way."
              : "No trade — a check is failing.",
          /* The gate's own sentence, which by contract names its measurement
             AND the threshold it was checked against. Restating it here in
             different words would produce a second account of one check. */
          because:
            v.kind === "conflict"
              ? (v.conflictNote ?? `${v.passed} of ${v.total} checks pass.`)
              : (first?.text ?? `${v.passed} of ${v.total} checks pass.`),
          values: [
            { label: "Gates passing", value: v.passed, unit: "count" },
            { label: "Gates checked", value: v.total, unit: "count" },
            { label: "Blocking", value: v.blocking.length, unit: "count" },
          ],
          barTime: null,
          silent: settling,
        }),
      );
    }
  }

  /* ---- price against the plan -------------------------------------------- */
  const plan = setup?.plan ?? null;
  if (plan !== null && Number.isFinite(price) && plan.r > 0) {
    const long = plan.direction === "long";
    /* A plan whose levels are not the ones that were on screen a moment ago is
       a NEW plan, drawn around where price already is. See `planKey`. */
    const fresh = planKeyOf(plan) !== prev.planKey;

    /* The stop side stays latched once price is PAST the stop, not just near
       it. Measuring `|price - stop|` would turn the condition off again as
       price ran away through it, and the engine would announce the approach a
       second time on the way back. */
    const stopNear = long
      ? price <= plan.stop + APPROACH_R * plan.r
      : price >= plan.stop - APPROACH_R * plan.r;
    if (stopNear) {
      const awayR = Math.abs(price - plan.stop) / plan.r;
      out.push(
        cand({
          key: "plan:stop-near",
          kind: "stop-approach",
          severity: "act",
          what: "Price is at the plan's stop.",
          because: `Price is ${awayR.toFixed(2)}R from the stop at ${px(plan.stop)} (alert within ${APPROACH_R}R).`,
          values: [
            { label: "Price", value: price, unit: "price" },
            { label: "Stop", value: plan.stop, unit: "price" },
            { label: "Distance", value: awayR, unit: "r" },
            { label: "Threshold", value: APPROACH_R, unit: "r" },
          ],
          barTime: null,
          silent: settling || fresh,
        }),
      );
    }

    const inZone = price >= Math.min(plan.entryLow, plan.entryHigh) && price <= Math.max(plan.entryLow, plan.entryHigh);
    if (inZone) {
      out.push(
        cand({
          key: "plan:in-zone",
          kind: "entry-zone",
          severity: "act",
          what: "Price has entered the plan's entry zone.",
          because: `Price ${px(price)} is inside ${px(plan.entryLow)} – ${px(plan.entryHigh)}.`,
          values: [
            { label: "Price", value: price, unit: "price" },
            { label: "Zone low", value: plan.entryLow, unit: "price" },
            { label: "Zone high", value: plan.entryHigh, unit: "price" },
          ],
          barTime: null,
          silent: settling || fresh,
        }),
      );
    }

    const targetNear = long
      ? price >= plan.target1 - APPROACH_R * plan.r
      : price <= plan.target1 + APPROACH_R * plan.r;
    if (targetNear) {
      const awayR = Math.abs(plan.target1 - price) / plan.r;
      out.push(
        cand({
          key: "plan:target-near",
          kind: "target-approach",
          severity: "watch",
          what: "Price is at the plan's first target.",
          because: `Price is ${awayR.toFixed(2)}R from target 1 at ${px(plan.target1)} (alert within ${APPROACH_R}R).`,
          values: [
            { label: "Price", value: price, unit: "price" },
            { label: "Target 1", value: plan.target1, unit: "price" },
            { label: "Distance", value: awayR, unit: "r" },
            { label: "Threshold", value: APPROACH_R, unit: "r" },
          ],
          barTime: null,
          silent: settling || fresh,
        }),
      );
    }
  }

  return out;
}

/**
 * The checks that do not depend on the setup: the feed, and the venue.
 *
 * Separate from `setupChecks` because they are latched in a different bucket —
 * these are true or false on every snapshot, and the setup's are unknown on
 * some of them. See `LiveState.activeSetup`.
 */
function tickChecks(prev: LiveState, snap: LiveSnapshot): Candidate[] {
  const out: Candidate[] = [];

  /* ---- the feed ----------------------------------------------------------
     `closed` is NOT degradation. A shut venue is a shut venue and the terminal
     says so everywhere else (`--feed-closed` is neutral, never alarm-coloured);
     reporting it as a broken feed every weekend is how a real staleness alarm
     stops being read on a Wednesday. */
  const q = snap.feed.quality;
  if (q === "stale" || q === "offline" || q === "delayed") {
    const staleAfterMs = snap.intervalMs > 0 ? snap.intervalMs * STALE_BARS : 120_000;
    const because =
      q === "delayed"
        ? `The vendor's newest bar is ${Math.round(snap.feed.vendorLagMs / 1000)}s behind, past the ${Math.round(DELAYED_MS / 1000)}s lag threshold.`
        : q === "stale"
          ? `No update for ${Math.round(snap.feed.tickAgeMs / 1000)}s, past the ${STALE_BARS}-bar staleness rule (${Math.round(staleAfterMs / 1000)}s on ${snap.timeframe}).`
          : "Nothing has arrived from this source at all.";
    out.push(
      cand({
        key: `feed:${q}`,
        kind: "feed-degraded",
        severity: q === "delayed" ? "watch" : "act",
        what:
          q === "delayed"
            ? `The ${snap.feed.source} feed is running behind.`
            : q === "stale"
              ? `The ${snap.feed.source} feed has stopped updating.`
              : `The ${snap.feed.source} feed is not answering.`,
        because,
        values: [
          ...(Number.isFinite(snap.feed.tickAgeMs)
            ? [{ label: "Tick age", value: snap.feed.tickAgeMs / 1000, unit: "seconds" as const }]
            : []),
          ...(Number.isFinite(snap.feed.vendorLagMs)
            ? [{ label: "Vendor lag", value: snap.feed.vendorLagMs / 1000, unit: "seconds" as const }]
            : []),
        ],
        barTime: null,
      }),
    );
  } else if (q === "live") {
    /* Silent until something has actually degraded. Without that, the ordinary
       offline-then-live sequence of a cold page load would announce a recovery
       from an outage that never happened. */
    out.push(
      cand({
        key: "feed:live",
        kind: "feed-recovered",
        severity: "info",
        what: `The ${snap.feed.source} feed is current again.`,
        because: `Last update ${Math.round(snap.feed.tickAgeMs / 1000)}s ago.`,
        values: Number.isFinite(snap.feed.tickAgeMs)
          ? [{ label: "Tick age", value: snap.feed.tickAgeMs / 1000, unit: "seconds" }]
          : [],
        barTime: null,
        silent: !prev.degraded,
      }),
    );
  }

  /* ---- the venue ---------------------------------------------------------
     `unknown` produces nothing: an instrument whose class this terminal does
     not recognise has no session to report, and guessing one would be the
     fabrication rule broken for the sake of a row. */
  if (snap.market === "open") {
    out.push(
      cand({
        key: "venue:open",
        kind: "session-open",
        severity: "info",
        what: `${snap.symbol}'s venue is open.`,
        because: "Inside its trading hours.",
        values: [],
        barTime: null,
      }),
    );
  } else if (snap.market === "closed") {
    out.push(
      cand({
        key: "venue:closed",
        kind: "session-close",
        severity: "info",
        what: `${snap.symbol}'s venue is closed — the last price is the close.`,
        because: "Outside its trading hours.",
        values: [],
        barTime: null,
      }),
    );
  }

  return out;
}

/* ───────────────────────────────────────────────────── the bar-close checks */

/**
 * Everything that walks the series. Runs on a close and nowhere else.
 *
 * `closed` is the series WITHOUT the forming bar, so every number here is a
 * number about a candle that is finished. `at` is the index of the bar that
 * just closed, which is the last one in `closed`.
 */
function barChecks(prev: LiveState, snap: LiveSnapshot, closed: readonly BarView[]): Candidate[] {
  const out: Candidate[] = [];
  const at = closed.length - 1;
  const bar = closed[at];
  if (bar === undefined) return out;
  const barTime = bar.t;

  /* ---- structure ---------------------------------------------------------
     Matched by TIME, not by index. `detections` is indexed against `snap.bars`,
     which still carries the forming bar, so comparing a detection's `to`
     against `closed.length - 1` would be off by one exactly when a bar is
     forming and correct when one is not — the worst kind of wrong. */
  for (const d of snap.detections) {
    if (d.kind !== "bos" && d.kind !== "choch") continue;
    if (d.confidence < STRUCTURE_MIN_CONFIDENCE) continue;
    if (snap.bars[d.to]?.t !== barTime) continue;
    const choch = d.kind === "choch";
    out.push(
      cand({
        key: `structure:${d.id}`,
        kind: "structure-break",
        severity: choch ? "act" : "watch",
        what: choch
          ? `Change of character confirmed ${d.direction === "short" ? "downward" : "upward"} on the bar that just closed.`
          : `Break of structure confirmed ${d.direction === "short" ? "downward" : "upward"} on the bar that just closed.`,
        /* The detector's own sentence. By contract it names the level and the
           rule that produced it, and it is what the chart's tooltip shows —
           two accounts of one detection is how they come to disagree. */
        because: `${d.reason} Confidence ${d.confidence.toFixed(2)} (minimum ${STRUCTURE_MIN_CONFIDENCE}).`,
        values: [
          { label: "Confidence", value: d.confidence, unit: "percent" },
          { label: "Floor", value: STRUCTURE_MIN_CONFIDENCE, unit: "percent" },
        ],
        barTime,
      }),
    );
  }

  /* ---- the outlier test --------------------------------------------------
     Sigma from bars STRICTLY BEFORE the one being judged. A sigma that included
     the outlier would be inflated by it and the bar would test as ordinary —
     the same no-lookahead rule `standardisedReturns` enforces in forecast.ts. */
  const before = closed.slice(0, at);
  const sigma = ewmaSigma(before, EWMA_LAMBDA);
  const prevClose = closed[at - 1]?.c ?? NaN;
  if (Number.isFinite(sigma) && sigma > 0 && prevClose > 0 && bar.c > 0) {
    const ret = Math.log(bar.c / prevClose);
    const z = Math.abs(ret) / sigma;
    if (z >= OUTLIER_SIGMA) {
      out.push(
        cand({
          /* Keyed on the BAR, so two genuine outliers in a row both report and
             the same bar can never report twice. */
          key: `outlier:${barTime}`,
          kind: "outlier-bar",
          severity: "watch",
          what: `Unusually big bar — ${z.toFixed(1)}× the normal move.`,
          because: `Moved ${(ret * 100).toFixed(2)}% against a typical ${(sigma * 100).toFixed(2)}% per bar over the ${before.length} bars before it. Alert at ${OUTLIER_SIGMA}×.`,
          values: [
            { label: "Move", value: ret * 100, unit: "percent" },
            { label: "Sigma", value: sigma * 100, unit: "percent" },
            { label: "Standardised", value: z, unit: "sigma" },
            { label: "Threshold", value: OUTLIER_SIGMA, unit: "sigma" },
          ],
          barTime,
        }),
      );
    }
  }

  /* ---- volatility band ---------------------------------------------------
     ATR as a share of price, ranked against its own trailing history. Ranked
     rather than compared to a constant because "wide" on gold and "wide" on a
     small-cap are different numbers, and a fixed one would be right on neither. */
  const n = closed.length;
  const high = Float64Array.from(closed, (b) => b.h);
  const low = Float64Array.from(closed, (b) => b.l);
  const close = Float64Array.from(closed, (b) => b.c);
  const atr = atrSeries(high, low, close, 14, n);
  const nowRatio = (atr[at] as number) / (close[at] as number);
  if (Number.isFinite(nowRatio) && nowRatio > 0) {
    let below = 0;
    let seen = 0;
    for (let i = Math.max(0, at - VOL_LOOKBACK); i < at; i++) {
      const a = atr[i] as number;
      const c = close[i] as number;
      if (!Number.isFinite(a) || !Number.isFinite(c) || c <= 0) continue;
      seen++;
      if (a / c < nowRatio) below++;
    }
    /* REFUSES rather than approximating. A percentile over twenty readings is
       a shape, not a measurement, and an event that said "top fifth" on the
       strength of it would be a claim nobody could check. */
    if (seen >= VOL_MIN_SAMPLE) {
      const pct = below / seen;
      const loud = pct >= VOLATILE_PCTILE;
      const quiet = pct <= QUIET_PCTILE;
      if (loud || quiet) {
        /* The first ranking is a READING, not a shift. See `volBand`. */
        const first = prev.volBand === null;
        out.push(
          cand({
            key: loud ? "vol:loud" : "vol:quiet",
            kind: "volatility-shift",
            severity: "watch",
            what: loud
              ? "Volatility is high — top 20% of its recent range."
              : "Volatility is low — bottom 20% of its recent range.",
            because: `ATR is ${(nowRatio * 100).toFixed(2)}% of price — higher than ${Math.round(pct * 100)}% of the last ${seen} bars (alerts above ${Math.round(VOLATILE_PCTILE * 100)}% / below ${Math.round(QUIET_PCTILE * 100)}%).`,
            values: [
              { label: "ATR share of price", value: nowRatio * 100, unit: "percent" },
              { label: "Percentile", value: pct, unit: "percentile" },
              { label: "Threshold", value: loud ? VOLATILE_PCTILE : QUIET_PCTILE, unit: "percentile" },
              { label: "Readings", value: seen, unit: "count" },
            ],
            barTime,
            silent: first,
          }),
        );
      } else {
        /* A mid band produces no event and no latch — but it still has to be
           RECORDED, or the first loud close after it would look like the first
           ranking and stay silent. `evaluate` reads this key off the bucket. */
        out.push(
          cand({
            key: "vol:mid",
            kind: "volatility-shift",
            severity: "info",
            what: "",
            because: "",
            values: [],
            barTime,
            silent: true,
          }),
        );
      }
    }
  }

  /* ---- volume ------------------------------------------------------------
     Median, not mean: one spike three bars ago would drag a mean up far enough
     to hide the next one. Refused outright on a feed that reports no volume —
     plenty do, and 0 x 3 is a threshold every bar clears. */
  if (at >= VOLUME_WINDOW) {
    const window: number[] = [];
    for (let i = at - VOLUME_WINDOW; i < at; i++) {
      const v = closed[i]?.v;
      if (typeof v === "number" && Number.isFinite(v)) window.push(v);
    }
    const med = median(window);
    if (med > 0 && Number.isFinite(bar.v) && bar.v >= VOLUME_SPIKE_X * med) {
      out.push(
        cand({
          key: `volume:${barTime}`,
          kind: "volume-spike",
          severity: "info",
          what: `Volume spike — ${(bar.v / med).toFixed(1)}× normal.`,
          because: `Volume ${px(bar.v)} against a typical ${px(med)} (last ${VOLUME_WINDOW} bars). Alert at ${VOLUME_SPIKE_X}×.`,
          values: [
            { label: "Volume", value: bar.v, unit: "quantity" },
            { label: "Median", value: med, unit: "quantity" },
            { label: "Multiple", value: bar.v / med, unit: "multiple" },
            { label: "Threshold", value: VOLUME_SPIKE_X, unit: "multiple" },
          ],
          barTime,
        }),
      );
    }
  }

  /* ---- regime ------------------------------------------------------------ */
  const regimes = classifyRegimes(closed.slice(-REGIME_WINDOW));
  const regime = regimes[regimes.length - 1];
  if (regime !== undefined) {
    out.push(
      cand({
        key: `regime:${regime}`,
        kind: "regime-change",
        severity: "watch",
        what:
          prev.regime === null
            ? `Market type: ${REGIME_LABEL[regime]}.`
            : `Market type changed: ${REGIME_LABEL[prev.regime]} → ${REGIME_LABEL[regime]}.`,
        because: REGIME_BLURB[regime],
        values: [],
        barTime,
        /* The first classification is a READING, not a change. It latches so
           the next close does not report it as one, and it says nothing,
           because there is no previous regime for the sentence to name. */
        silent: prev.regime === null,
      }),
    );
  }

  return out;
}

/* ───────────────────────────────────────────────────────── the edge checks */

/**
 * Transitions in a VALUE rather than in a condition.
 *
 * The setup engine's answer is not a boolean — it is a name and a direction,
 * and the interesting thing is that it CHANGED, which a latch on the current
 * value cannot express without a key per possible setup. These compare against
 * the previous snapshot's value directly; the cool-off still applies, so a
 * setup flickering on and off its score floor cannot fill the log.
 */
function edgeChecks(prev: LiveState, snap: LiveSnapshot): Candidate[] {
  const out: Candidate[] = [];
  /* No setup in the snapshot is NOT "no setup on the chart" — see
     `LiveState.activeSetup`. Nothing is known, so nothing is claimed. */
  if (snap.setup === null) return out;
  const strategy = snap.setup.verdict.strategy;
  /* The engine's own words for this setup ("Bullish fair value gap"), not the
     detector id the verdict carries ("fvg"). The id is what records are keyed
     by and must stay; a sentence read by a person gets the label. Falls back
     to the id, so a caller that passes no label still reads. */
  const name = snap.setup.label ?? strategy;
  const prevName = prev.strategyLabel ?? prev.strategy;
  const direction = snap.setup.direction;

  if (prev.strategy !== null && strategy !== null && prev.strategy === strategy) {
    if (prev.direction !== null && direction !== null && prev.direction !== direction) {
      out.push(
        cand({
          key: "setup:flipped",
          kind: "setup-flipped",
          severity: "act",
          what: `The ${name} setup has changed direction, from ${prev.direction} to ${direction}.`,
          because: "The same pattern now points the other way — the old plan no longer applies.",
          values: [],
          barTime: null,
        }),
      );
    }
  } else if (prev.strategy === null && strategy !== null) {
    out.push(
      cand({
        key: "setup:appeared",
        kind: "setup-appeared",
        severity: "watch",
        what: `A ${name} setup${direction === null ? "" : ` (${direction})`} is now the chart's best idea.`,
        because: "It met the minimum score and has enough data behind it.",
        values: [],
        barTime: null,
        /* The FIRST setup on a chart arrived because the card finished
           loading, not because one formed. See `sawSetup`. */
        silent: !prev.sawSetup,
      }),
    );
  } else if (prev.strategy !== null && strategy === null) {
    out.push(
      cand({
        key: "setup:expired",
        kind: "setup-expired",
        severity: "info",
        what: `The ${prevName} setup is gone.`,
        because: "No setup meets the minimum score any more, so there is nothing to plan from.",
        values: [],
        barTime: null,
      }),
    );
  }

  return out;
}

/* ──────────────────────────────────────────────────────────────── the core */

export interface LiveResult {
  readonly state: LiveState;
  readonly events: readonly LiveEvent[];
}

/**
 * One evaluation.
 *
 * Pure: the same `(prev, snap, cfg)` always produces the same result, and the
 * only clock in it is `snap.now`. That is the whole reason the engine can be
 * stepped through a day of bar closes in a unit test without a timer.
 */
export function evaluate(
  previous: LiveState,
  snap: LiveSnapshot,
  cfg: LiveConfig = DEFAULT_CONFIG,
): LiveResult {
  /* A symbol or timeframe change resets every latch, the regime and the setup
     — none of them describes the chart now. The LOG is kept, because an event
     that happened on gold is still something that happened, and it carries its
     own symbol and timeframe so it cannot be misread. `primed` goes false, so
     the first snapshot of the new instrument latches in silence exactly as a
     cold start does. */
  const key = `${snap.symbol}|${snap.timeframe}`;
  const prev: LiveState =
    previous.key === key
      ? previous
      : { ...emptyState(), key, seq: previous.seq, seen: previous.seen };

  const closedLen = Math.max(0, Math.min(snap.closedLen, snap.bars.length));
  const newestClosed = closedLen > 0 ? (snap.bars[closedLen - 1] as BarView).t : 0;
  const justClosed = closedLen > 0 && newestClosed !== prev.lastClosedBarTime;

  const tick = tickChecks(prev, snap);
  const setup = snap.setup === null ? null : setupChecks(prev, snap);
  const edges = edgeChecks(prev, snap);
  const bar = justClosed ? barChecks(prev, snap, snap.bars.slice(0, closedLen)) : [];

  const prevActive = new Set([...prev.activeTick, ...prev.activeBar, ...prev.activeSetup]);
  const firedAt: Record<string, number> = { ...prev.firedAt };
  const events: LiveEvent[] = [];
  let seq = prev.seq;

  const queue = (c: Candidate): void => {
    if (c.silent) return;
    if (!prev.primed) return;
    const last = firedAt[c.key];
    if (last !== undefined && snap.now - last < cfg.coolOffMs) return;
    seq++;
    firedAt[c.key] = snap.now;
    events.push({
      id: `${c.kind}#${seq}`,
      time: snap.now,
      symbol: snap.symbol,
      timeframe: snap.timeframe,
      kind: c.kind,
      severity: c.severity,
      what: c.what,
      because: c.because,
      values: c.values,
      barTime: c.barTime,
    });
  };

  /* LEVELS fire on entering the set; EDGES have already established that they
     are transitions, so they go straight to the cool-off. */
  for (const c of [...tick, ...(setup ?? []), ...bar]) if (!prevActive.has(c.key)) queue(c);
  for (const c of edges) queue(c);

  const activeTick = tick.map((c) => c.key);
  /* Bar-close keys are CARRIED across ticks. A latch that evaporated between
     closes would make every bar-close condition look new once a bar, which is
     the exact repetition this engine exists to avoid. */
  const activeBar = justClosed ? bar.map((c) => c.key) : [...prev.activeBar];
  /* Setup keys are carried whenever the snapshot has no setup to speak for
     them. Absent is not false — see `LiveState.activeSetup`. */
  const activeSetup = setup === null ? [...prev.activeSetup] : setup.map((c) => c.key);

  /* Prune cool-off memory for keys that are neither active nor still cooling.
     Without it the map grows one entry per closed bar for ever — `outlier:` and
     `volume:` are keyed on the bar time on purpose. */
  const live = new Set([...activeTick, ...activeBar, ...activeSetup]);
  for (const k of Object.keys(firedAt)) {
    const t = firedAt[k];
    if (!live.has(k) && t !== undefined && snap.now - t >= cfg.coolOffMs) delete firedAt[k];
  }

  const regimeKey = bar.find((c) => c.kind === "regime-change")?.key;
  const regime: Regime | null = justClosed
    ? ((regimeKey?.slice("regime:".length) as Regime | undefined) ?? prev.regime)
    : prev.regime;

  const volKey = bar.find((c) => c.kind === "volatility-shift")?.key;
  const volBand: LiveState["volBand"] = justClosed
    ? ((volKey?.slice("vol:".length) as LiveState["volBand"]) ?? prev.volBand)
    : prev.volBand;

  /**
   * "Recovered" needs an outage to refer back to, and the outage has to be one
   * the engine actually REPORTED.
   *
   * The obvious version of this reads the quality — degraded whenever it is not
   * live — and it is wrong on the commonest sequence there is. A cold page load
   * goes `offline` (nothing has arrived yet) and then `live`, and the first of
   * those two is the PRIMING snapshot, which by design says nothing. Reading
   * the quality would have set the flag anyway, and every single page load
   * would have opened with "the feed is current again" for an outage that never
   * happened.
   *
   * So it is set by the EVENT, not by the state, and cleared the moment the
   * feed is live — by which point the recovery has either been said or was
   * never owed.
   */
  const degraded =
    snap.feed.quality === "live" ? false : events.some((e) => e.kind === "feed-degraded") || prev.degraded;

  return {
    state: {
      key,
      primed: true,
      seq,
      lastClosedBarTime: closedLen > 0 ? newestClosed : prev.lastClosedBarTime,
      activeTick,
      activeBar,
      activeSetup,
      firedAt,
      regime,
      volBand,
      planKey:
        snap.setup === null
          ? prev.planKey
          : snap.setup.plan === null
            ? null
            : planKeyOf(snap.setup.plan),
      /* Carried when the snapshot has no setup: the card refusing to render is
         not the setup going away. */
      strategy: snap.setup === null ? prev.strategy : snap.setup.verdict.strategy,
      strategyLabel: snap.setup === null ? prev.strategyLabel : snap.setup.label ?? null,
      direction: snap.setup === null ? prev.direction : snap.setup.direction,
      degraded,
      sawSetup: prev.sawSetup || snap.setup !== null,
      seen: [...events, ...prev.seen].slice(0, cfg.seenCap),
    },
    events,
  };
}

/**
 * A thin stateful wrapper for the shell.
 *
 * Holds the state and nothing else — no timers, no signals, no DOM, same shape
 * as `createWatchLoop`. The shell wraps the state it returns in a signal; a
 * signal in here would make the engine untestable without the reactive system
 * and would give the terminal a second owner of the same fact.
 */
export function createLiveEngine(cfg: LiveConfig = DEFAULT_CONFIG) {
  let state = emptyState();
  return {
    push(snap: LiveSnapshot): LiveResult {
      const r = evaluate(state, snap, cfg);
      state = r.state;
      return r;
    },
    state: (): LiveState => state,
    clear(): void {
      state = clearSeen(state);
    },
  };
}

export type LiveEngine = ReturnType<typeof createLiveEngine>;
