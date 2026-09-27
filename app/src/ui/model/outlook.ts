/**
 * What's likely next: the simulated outlook, its odds against the plan, and
 * the band's track record from the archive.
 *
 * Moved out of `mountShell`'s dock in v59. Three siblings: the bars, the
 * closed-bar count the detectors ran over, and the Setup card's view (the
 * odds are read against ITS plan, so the two cannot describe different
 * trades).
 */

import { type OutlookCalibration, type Refused as OutlookRefused, outlookCalibration, simulateOutlook } from "../../analysis/outlook";
import { type OutlookPlan } from "../outlookpanel";
import { computed, effect, signal, type ReadSignal } from "../../core/signal";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "../shell/context";
import type { createStructureModel } from "./structure";
import type { createSetupModel } from "./setup";

export interface OutlookModelDeps {
  readonly bars: ReadSignal<readonly BarView[]>;
  readonly closedBarCount: ReturnType<typeof createStructureModel>["closedBarCount"];
  readonly setupView: ReturnType<typeof createSetupModel>["view"];
}

export function createOutlookModel(ctx: ShellContext, deps: OutlookModelDeps) {
  const { feed } = ctx;
  const { bars, closedBarCount, setupView } = deps;

  /**
   * WHAT'S LIKELY NEXT — the outlook, its odds, and its track record.
   *
   * The simulation reads CLOSED bars and depends on the same two signals as
   * `detectData` plus the closed-bar count, so it re-runs when a bar closes or
   * the series is replaced and never on a tick (measured ~5ms on 1000 bars,
   * analysis/outlook.ts). The odds re-run with the plan, which is cheap: they
   * are read off the paths already simulated.
   */
  const outlookRead = computed(() => {
    const n = closedBarCount();
    feed.loadedSymbol();
    feed.loadedTimeframe();
    if (n < 2) return null;
    return simulateOutlook(bars.peek().slice(0, n));
  });
  const outlookPlan = computed<OutlookPlan | null>(() => {
    const sv = setupView();
    if (!sv || sv.setupRefusal || !sv.plan) return null;
    const pl = sv.plan;
    return { direction: pl.direction, entry: pl.entry, stop: pl.stop, target1: pl.target1 };
  });
  const outlookOdds = computed(() => {
    const o = outlookRead();
    const pl = outlookPlan();
    const sv = setupView.peek();
    if (!o || !o.ok || !pl || !sv?.plan) return null;
    return o.touch({ ...pl, target2: sv.plan.target2 });
  });
  /**
   * The band's track record, from the ARCHIVE rather than the chart window:
   * non-overlapping 24-bar checks need thousands of bars, and the chart holds
   * about 800 — 29 checks, under the 30 the verdict needs. `load` reads what
   * is held; it does not reach out to the vendor. Measured 30–34ms on 5000
   * bars, so it runs once per instrument, after a timer, never per tick.
   */
  const outlookCal = signal<OutlookCalibration | OutlookRefused | null>(null);
  let outlookCalKey = "";
  effect(() => {
    const sym = feed.loadedSymbol();
    const tf = feed.loadedTimeframe();
    const key = `${sym}|${tf}`;
    if (!sym || !tf || key === outlookCalKey) return;
    outlookCalKey = key;
    outlookCal.set(null);
    void feed.history
      .load(sym, tf, { limit: 6000 })
      .then((res) => {
        if (outlookCalKey !== key) return;
        setTimeout(() => {
          if (outlookCalKey !== key) return;
          const closed = res.bars.slice(0, Math.max(0, res.bars.length - 1));
          outlookCal.set(outlookCalibration(closed));
        }, 0);
      })
      .catch((err: unknown) => {
        if (outlookCalKey !== key) return;
        console.warn("[outlook] archive load failed", err);
        outlookCal.set({ ok: false, refused: "the local archive could not be read" });
      });
  });

  return { outlookRead, outlookPlan, outlookOdds, outlookCal };
}
