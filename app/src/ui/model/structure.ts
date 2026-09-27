/**
 * What the detectors found on this chart, and what survives to be drawn.
 *
 * WHY IT IS ITS OWN FILE
 * `mountShell` was one function of 6,837 lines holding 185 declarations, and
 * every extraction attempted since v50 was refused by the repository's own
 * rule — more than ten siblings means the coupling has been moved into a
 * signature rather than removed. That refusal is a property of the SHAPE, not
 * of the sections: when state, derivation, DOM and effects share one closure,
 * "sibling" means "any of the other 184 locals".
 *
 * This is the first piece of the model layer that fixes it. It is pure
 * derivation — eight `computed`s over the bars, the enabled detectors and the
 * operator's filters, with no DOM and no effects — and it borrows FIVE things
 * from its siblings. That number is the argument for the split.
 *
 * WHAT DID NOT CHANGE
 * Nothing about the behaviour, and not one comment. The notes below on why
 * detection reads CLOSED bars only, why `detectData` peeks at `bars` but
 * depends on the loaded symbol and timeframe, why the alert engine gets a
 * different set from the chart, and why the draw cap is per kind AND
 * timeframe were all written against this code and are carried across as
 * they stood.
 */

import { computed, type ReadSignal } from "../../core/signal";
import { DETECTOR_FOR_KIND, runDetectors, toDetectInput } from "../../detect";
import { detectHigher } from "../../detect/mtf";
import type { Detection, DetectInput } from "../../detect/types";
import type { BarView } from "../../chart/series";
import { requiredDetectors, type createAlertStore } from "../../alert/store";
import { densityFactor } from "../detectpanel";
import type { ShellContext } from "../shell/context";

/**
 * What this model borrows from its siblings.
 *
 * Five, all owned elsewhere in the shell. `state` and `feed` are foundation
 * and arrive on the context instead — which is exactly why the list is five
 * and not seven.
 */
export interface StructureModelDeps {
  /** The chart's bars, replay-aware. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /** The operator's confidence floor, from the detector popover. */
  readonly detectMinConfidence: ReadSignal<number>;
  /** How crowded the chart may get: "focused" | "standard" | "everything". */
  readonly detectDensity: ReadSignal<string>;
  /** "long" | "short" | "both". */
  readonly detectDirection: ReadSignal<string>;
  /** Armed alerts decide which detectors must keep running. */
  readonly alertStore: ReturnType<typeof createAlertStore>;
}

/**
 * Build the model.
 *
 * The return type is INFERRED. A hand-written one was rejected by the compiler
 * on the first attempt at the palette section and a hand-written sibling type
 * has now caused three defects here; `ReturnType<typeof createStructureModel>`
 * cannot drift from this because it is a reference to it.
 */
export function createStructureModel(ctx: ShellContext, deps: StructureModelDeps) {
  const { state, feed } = ctx;
  const { bars, detectMinConfidence, detectDensity, detectDirection, alertStore } = deps;

  /**
   * Study readouts for the newest bar.
   *
   * `computed` means this runs once per data change and is then cached, however
   * many panels read it — not once per reader per repaint.
   */
  /**
   * Auto-detected structures.
   *
   * Recomputed only when series or the enabled set change — never inside the
   * paint path. Detection over 800 series is a few milliseconds, but it would run
   * on every crosshair move if it lived in the renderer.
   */
  /**
   * Count of CLOSED series. The forming bar is excluded.
   *
   * This is the only reactive dependency detection has, and that is the point:
   * it changes when a bar closes, not on every tick of the forming one.
   */
  const closedBarCount = computed(() => Math.max(0, bars().length - 1));

  /**
   * The columnar view the detectors and the alert engine BOTH read.
   *
   * Built once and shared, because an alert anchor is a bar index into this
   * exact array. Two independent conversions could differ by a single bar and
   * every anchor would silently point one bar off.
   *
   * CORRECTNESS, not just cost. `detectStructure` confirms a break using
   * `close`, and the forming bar's "close" is not a close — it is the current
   * price. Feeding it in means a mid-bar spike registers as a confirmed break
   * and then un-registers when the bar closes lower, which is exactly the wick
   * behaviour the detector documents that it rejects. Detection sees closed
   * bars only.
   */
  const detectData = computed<DetectInput | null>(() => {
    const n = closedBarCount();
    /**
     * WHICH SERIES, as well as how many bars of it.
     *
     * `bars` is read with `peek()` on purpose — depending on it here would
     * rebuild every detector several times a second as the forming bar ticks,
     * for no benefit. The cost of that peek is that a change of SERIES is
     * invisible: swap a 1h chart for a 1m one and, if both happen to hold 800
     * bars, `closedBarCount` does not move and this never re-runs. The
     * detections then keep describing the old timeframe until a bar closes and
     * the count changes by accident.
     *
     * Measured on XAUUSD 1h → 1m: the Setup card built its plan from the new
     * 1-minute bars and an hourly structure level, put the stop 20.24 points
     * away — 10.4× the minute ATR — and stood the trade down for it. Six
     * seconds later the detections caught up and the same chart passed all
     * seven gates with a 2.01-point stop. Nothing on screen explained either
     * number.
     *
     * These two signals change exactly when the series is replaced and never
     * on a tick, which is the dependency this wanted all along.
     */
    feed.loadedSymbol();
    feed.loadedTimeframe();
    const list = bars.peek();
    if (n < 30) return null;
    return toDetectInput(list.slice(0, n));
  });

  const detections = computed<Detection[]>(() => {
    const data = detectData();
    const enabled = state.detectors();
    if (!data || enabled.length === 0) return [];

    const own = runDetectors(data, enabled);

    /**
     * Higher-timeframe structure, projected down.
     *
     * Merged into the same list rather than kept apart, so it draws, lists and
     * can be alerted on exactly like native structure. The only things that
     * distinguish it are the timeframe in its label — and the fact that its
     * `to` is the bar that CLOSED the higher-timeframe bar, never the one that
     * opened it. See detect/mtf.ts.
     */
    const higher = state.htf();
    if (higher.length === 0) return own;
    const out = [...own];
    for (const tf of higher) out.push(...detectHigher(data, tf, enabled));
    out.sort((a, b) => a.to - b.to);
    return out;
  });

  /**
   * Detections for the ALERT engine, which is not the same set as the chart's.
   *
   * The chart draws what the user ticked. An alert must keep working after the
   * user unticks the overlay it was anchored to, so anything an armed alert
   * needs is added back in. Reuses the chart's run whenever that is already
   * sufficient, which is the common case.
   */
  const alertDetections = computed<readonly Detection[]>(() => {
    const data = detectData();
    if (!data) return [];
    const enabled = state.detectors();
    const needed = requiredDetectors(alertStore.specs(), state.symbol(), state.timeframe());
    const missing = needed.filter((d) => !enabled.includes(d));
    if (missing.length === 0) return detections();
    const all = [...enabled, ...missing];
    const out = runDetectors(data, all);
    for (const tf of state.htf()) out.push(...detectHigher(data, tf, all));
    out.sort((a, b) => a.to - b.to);
    return out;
  });

  /**
   * How many of each kind to DRAW.
   *
   * With every detector on, 800 bars produce well over a hundred structures and
   * the chart becomes unreadable — which makes the feature worse than useless,
   * because the one structure that matters is buried in ninety that do not.
   * Only the most recent of each kind is drawn. The panel still lists
   * everything and the counter says how many are hidden: capping is fine,
   * capping SILENTLY is not.
   */
  const DRAW_CAP: Record<string, number> = {
    bos: 4,
    choch: 4,
    level: 6,
    fvg: 5,
    "order-block": 4,
    "double-top": 2,
    "double-bottom": 2,
    "head-shoulders": 2,
    trendline: 4,
    divergence: 3,
    /* v49. Sweeps get the largest cap of any kind because each one carries its
       own invalidation and is therefore individually actionable — unlike a
       level, where six is already more than anyone reads. Session ranges are
       capped at three because that is one day of Asia, London and New York;
       more than that is yesterday's context drawn over today's. */
    "liquidity-sweep": 5,
    "equal-highs": 3,
    "equal-lows": 3,
    breaker: 3,
    range: 2,
    expansion: 2,
    "session-range": 3,
  };

  /**
   * What the FILTERS leave, before the per-kind cap is applied.
   *
   * Kept as its own step so the panel can say how many structures your own
   * filters hid, separately from how many the drawing cap left off. They are
   * different facts: one you chose, one the chart decided, and only the first
   * is something you would act on.
   */
  const passesFilters = computed<Detection[]>(() => {
    const floor = detectMinConfidence();
    const dir = detectDirection();
    return detections().filter((d) => {
      if (d.confidence < floor) return false;
      /* A neutral structure — an S/R level, say — has no side, so it survives
         a direction filter. Dropping it would remove the levels that give the
         filtered structures their context. */
      if (dir !== "both" && d.direction !== "neutral" && d.direction !== dir) return false;
      return true;
    });
  });

  const filteredOut = computed<number>(() => detections().length - passesFilters().length);

  const drawn = computed<Detection[]>(() => {
    const all = passesFilters();
    const factor = densityFactor(detectDensity());
    const perKind = new Map<string, number>();
    const keep: Detection[] = [];
    // Walk newest-first so the cap keeps the most recent, not the oldest.
    for (let i = all.length - 1; i >= 0; i--) {
      const d = all[i] as Detection;
      /**
       * Cap per kind AND timeframe.
       *
       * Higher-timeframe detections carry the same `kind` as native ones, so a
       * single shared cap lets four recent 1h breaks crowd out the one 4h break
       * — which is the structure you turned the higher timeframe on FOR. A
       * projected id is prefixed `4h:`; native ids contain no colon.
       */
      const colon = d.id.indexOf(":");
      const key = colon > 0 ? `${d.id.slice(0, colon)}/${d.kind}` : d.kind;
      /* At least one of every kind that survived the filters, however low the
         density: a "Focused" setting that hid a structure type entirely would
         look like the detector had found nothing. */
      const cap = Math.max(1, Math.round((DRAW_CAP[d.kind] ?? 3) * factor));
      const used = perKind.get(key) ?? 0;
      if (used >= cap) continue;
      perKind.set(key, used + 1);
      keep.push(d);
    }
    return keep.reverse();
  });

  /**
   * How many structures each DETECTOR is responsible for.
   *
   * Keyed by detector id, not by detection kind: "Structure" produces both
   * `bos` and `choch`, so a per-kind count would put two numbers on one toggle
   * and neither would answer "what happens if I switch this off".
   */
  const detectCounts = computed<ReadonlyMap<string, number>>(() => {
    const out = new Map<string, number>();
    for (const d of detections()) {
      const owner = DETECTOR_FOR_KIND[d.kind];
      if (owner) out.set(owner, (out.get(owner) ?? 0) + 1);
    }
    return out;
  });

  return {
    closedBarCount,
    detectData,
    detections,
    alertDetections,
    filteredOut,
    drawn,
    detectCounts,
  };
}
