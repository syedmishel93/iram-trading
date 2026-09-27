/**
 * The model layer, asked on demand: the regime read and the walk-forward
 * classifier, their busy flag, when they last answered usefully, and the rule
 * that a change of instrument invalidates both.
 *
 * WHY IT IS ITS OWN FILE, AND WHY IT IS ONE SIBLING
 * Five signals and one async function that touch nothing in the shell except
 * the bars they are asked about and the symbol/timeframe that invalidate them.
 * `state` is foundation; `bars` is the single sibling. That is as decoupled as
 * anything in `mountShell` gets, and it had no reason to be inside a
 * 6,800-line closure other than that everything else was.
 *
 * THE TWO NOTES IN HERE ARE BOTH SCARS AND BOTH CARRY ACROSS VERBATIM: why a
 * second caller JOINS the in-flight run rather than being dropped, and why
 * `intelAnsweredAt` tests for a USABLE answer rather than for a non-null
 * signal — `IntelResult<T>` is `T | { ok: false, error }`, so a service that
 * is down still lands a value.
 */

import { effect, signal, type ReadSignal } from "../../core/signal";
import { createIntel, type ForecastRead, type IntelResult, type RegimeRead } from "../../data/intel";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "../shell/context";

/** What the model layer borrows from its siblings. One. */
export interface IntelModelDeps {
  /** The bars the models are asked about, replay-aware. */
  readonly bars: ReadSignal<readonly BarView[]>;
}

/** Build the model layer. Return type inferred, per the extraction procedure. */
export function createIntelModel(ctx: ShellContext, deps: IntelModelDeps) {
  const { state } = ctx;
  const { bars } = deps;

  const intel = createIntel();
  const regime = signal<IntelResult<RegimeRead> | null>(null);
  const forecast = signal<IntelResult<ForecastRead> | null>(null);
  const intelBusy = signal(false);

  /**
   * When the model lanes last produced a USABLE answer.
   *
   * `IntelResult<T>` is `T | { ok: false, error }`, so a service that is down
   * still lands a value in the signal. The old warm-up tested `=== null` and
   * therefore counted a refusal as an answer — which is why its three retries
   * almost never fired for the failure they were written for. The supervisor
   * asks this instead, and this returns null unless something usable arrived.
   */
  const intelAnsweredAt = signal<number | null>(null);

  /** The in-flight run, so a second caller joins it rather than being dropped. */
  let intelRun: Promise<void> | null = null;

  async function runIntel(): Promise<void> {
    /* JOIN, do not abandon. The old guard returned immediately while busy, so
       a supervisor sweep that landed during a run would see its `refresh`
       resolve instantly with nothing fetched and count the lane as failed. */
    if (intelRun) return intelRun;
    const series = bars.peek();
    intelBusy.set(true);
    intelRun = (async () => {
      try {
        const [r, f] = await Promise.all([intel.regime(series), intel.forecast(series, 24)]);
        regime.set(r);
        forecast.set(f);
        if (r.ok !== false && f.ok !== false) intelAnsweredAt.set(Date.now());
      } finally {
        intelBusy.set(false);
        intelRun = null;
      }
    })();
    return intelRun;
  }

  // A new symbol invalidates both reads. Clearing them is the honest move: a
  // regime computed on BTC must never sit in the panel while gold is on screen.
  effect(() => {
    state.symbol();
    state.timeframe();
    regime.set(null);
    forecast.set(null);
    intelAnsweredAt.set(null);
  });

  return { intel, regime, forecast, intelBusy, intelAnsweredAt, runIntel };
}
