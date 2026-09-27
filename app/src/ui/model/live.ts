/**
 * Live analysis: the engine that publishes TRANSITIONS, fed from the shell.
 *
 * Moved out of `mountShell`'s dock in v59. It recomputes nothing — see the
 * note below — so its siblings are exactly the readings it is handed: the
 * replay (to know which series is on screen), the clock, the detections, the
 * closed-bar count, and the Setup card's view and last choice.
 */

import { type LiveEvent, createLiveEngine } from "../../analysis/live";
import { intervalMs } from "../../data/history";
import { marketState } from "../../data/sessions";
import { effect, signal, type ReadSignal } from "../../core/signal";
import type { createReplay } from "../../core/replay";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "../shell/context";
import type { createStructureModel } from "./structure";
import type { createSetupModel } from "./setup";

export interface LiveModelDeps {
  readonly replay: ReturnType<typeof createReplay<BarView>>;
  readonly nowMs: ReadSignal<number>;
  readonly detections: ReturnType<typeof createStructureModel>["detections"];
  readonly closedBarCount: ReturnType<typeof createStructureModel>["closedBarCount"];
  readonly setupView: ReturnType<typeof createSetupModel>["view"];
  readonly setupLast: ReturnType<typeof createSetupModel>["last"];
}

export function createLiveModel(ctx: ShellContext, deps: LiveModelDeps) {
  const { state, feed } = ctx;
  const { replay, nowMs, detections, closedBarCount, setupView, setupLast } = deps;
  const bars = replay.bars;

  /* ---------------------------------------------------------- live analysis ---
   *
   * THE ONE SURFACE THAT SAYS WHAT CHANGED.
   *
   * Every other panel in this dock answers a standing question and repaints its
   * answer in place, so an operator who looks away for ten minutes has no way
   * to find out what happened while they were not looking. `analysis/live.ts`
   * watches the same inputs the panels already hold and publishes TRANSITIONS
   * — each one a measurement against a stated threshold, each one fired once.
   *
   * NOTHING IS RECOMPUTED HERE. The bars, the detections, the verdict, the
   * plan, the feed state and the venue's session all already exist in this
   * scope; the engine is handed them and holds no opinion of its own about any
   * of them. A second copy of the setup's direction or of "which bars have
   * closed" is exactly how two surfaces come to disagree — which is why
   * `closedLen` is passed rather than derived: `closedBarCount` is the prefix
   * the DETECTORS were run over, so a detection's `to` indexes exactly these
   * bars and nothing else.
   *
   * THE EFFECT RE-RUNS CONSTANTLY AND THAT IS FINE. It depends on `bars` (a
   * tick), on `nowMs` (once a second, which is what makes a feed going stale
   * and a venue closing noticeable at all) and on the verdict. `evaluate`
   * MEASURED at 0.0050 ms on the tick path against a 2 ms budget; the work that
   * walks the series runs only when a bar closes, inside the engine, where the
   * decision can be tested.
   */
  const liveEngine = createLiveEngine();
  const liveEvents = signal<readonly LiveEvent[]>([]);
  const publishLive = (): void => liveEvents.set(liveEngine.state().seen);

  effect(() => {
    const series = bars();
    const closed = closedBarCount();
    const now = nowMs();
    const view = setupView();
    const feedState = feed.state();
    const dets = detections();
    const symbol = state.symbol();
    const timeframe = state.timeframe();
    /**
     * NOTHING IS PUSHED UNTIL THE SERIES DESCRIBES THE CHART ON SCREEN.
     *
     * The same three guards `setupView` uses, for a related reason. `bars` is
     * deliberately not cleared on a symbol change — the chart must not blank —
     * so for a second or two it holds the PREVIOUS instrument's candles while
     * the header says the new one. Priming on that latches a set of conditions
     * about gold and then reports every one of them as news when Bitcoin
     * arrives.
     *
     * And it is not only a switch. MEASURED on a cold load: the first series
     * to appear was a partial window, so the volatility band was ranked over a
     * fraction of the history and then re-ranked when the rest landed —
     * reported as "volatility has dropped into the bottom fifth", which is a
     * statement about the archive finishing, not about the market.
     */
    if (series.length === 0) return;
    if (feed.loadedSymbol() !== symbol || feed.loadedTimeframe() !== timeframe) return;
    if (!replay.active() && series !== feed.bars()) return;

    const result = liveEngine.push({
      now,
      symbol,
      timeframe,
      intervalMs: intervalMs(timeframe),
      bars: series,
      closedLen: closed,
      detections: dets,
      setup:
        view === null
          ? null
          : {
              verdict: view.verdict,
              plan: view.plan,
              /* The chosen setup's own direction, not the plan's: a gate
                 blocking takes the PLAN away and leaves the setup standing, and
                 reading direction off a null plan would make every stand-down
                 look like the setup expiring. Same source the verdict card uses
                 for the setup's human label. */
              direction: setupLast.choice?.best?.candidate.direction ?? null,
              label: setupLast.choice?.best?.candidate.label ?? null,
            },
      feed: feedState,
      market: marketState(symbol, now),
    });
    if (result.events.length > 0) publishLive();
  });

  return { liveEngine, liveEvents, publishLive };
}
