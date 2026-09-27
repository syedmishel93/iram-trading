/**
 * The live bar's readings: small, frequently-read facts about "now".
 *
 * Moved out of `mountShell` in v59. Four siblings — the replay-aware bars, the
 * once-a-second clock, the detections and the counted book — and nothing
 * here draws: the live bar and the chart's countdown/projection effects read
 * these, and stay in the shell because they touch the chart engine.
 */

import { type Calibration, GOOD_ENOUGH, calibration, forecastRange } from "../../analysis/forecast";
import { type SessionStatus, sessionStatuses } from "../../data/sessionmap";
import { marketState } from "../../data/sessions";
import { type Detection } from "../../detect/types";
import { portfolioHeat } from "../../risk/sizing";
import { countdown } from "../countdown";
import { type ReadSignal } from "../../core/signal";
import type { createReplay } from "../../core/replay";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "../shell/context";
import type { createStructureModel } from "./structure";
import type { createBrokerModel } from "./broker";

export interface ReadingsModelDeps {
  readonly replay: ReturnType<typeof createReplay<BarView>>;
  readonly nowMs: ReadSignal<number>;
  readonly detections: ReturnType<typeof createStructureModel>["detections"];
  readonly openBook: ReadSignal<ReturnType<ReturnType<typeof createBrokerModel>["book"]>["counted"]>;
}

export function createReadingsModel(ctx: ShellContext, deps: ReadingsModelDeps) {
  const { state, account } = ctx;
  const { replay, nowMs, detections, openBook } = deps;
  const bars = replay.bars;

  const lastBar = () => {
    const list = bars();
    return list.length > 0 ? list[list.length - 1] : null;
  };

  const heatNow = () =>
    portfolioHeat(openBook(), account.effective().equity);

  /**
   * Which sessions are open, and the soonest change.
   *
   * Reads `nowMs` so it re-renders on the same once-a-second tick the
   * countdown uses rather than owning a second timer. The soonest boundary is
   * the one that matters: it is either the liquidity you are about to lose or
   * the liquidity that is about to arrive, and both change the decision.
   */
  const sessionClock = (): { open: string[]; next: string } => {
    const rows = sessionStatuses(nowMs());
    const open = rows.filter((r) => r.open);
    /* Sydney is dropped when Tokyo is open: they overlap almost entirely and
       "Sydney+Tokyo" is two names for one book. The Sessions desk makes the
       same omission for the same reason. */
    const named = open
      .filter((r) => !(r.session.id === "sydney" && open.some((o) => o.session.id === "tokyo")))
      .map((r) => r.session.city);

    const soonest = rows.reduce<SessionStatus | null>(
      (best, r) => (best === null || r.hoursUntilChange < best.hoursUntilChange ? r : best),
      null,
    );
    if (!soonest) return { open: named, next: "" };
    const mins = Math.round(soonest.hoursUntilChange * 60);
    const when = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}` : `${mins}m`;
    return { open: named, next: `${soonest.open ? "−" : "+"}${when}` };
  };

  /**
   * Detections whose bar is the last two closed ones.
   *
   * NEW, not present. The chart carries every mark the enabled detectors have
   * ever produced in the loaded window; a count of those is a constant that
   * stops being read within an hour. What is worth interrupting a person for
   * is that something fired just now.
   *
   * Two bars rather than one so a detection is not missed by looking away for
   * the length of a single bar, and sorted by confidence so the named one is
   * the strongest rather than the last in array order.
   */
  const freshDetections = (): readonly Detection[] => {
    const list = detections();
    const n = bars().length;
    if (n === 0) return [];
    return list
      .filter((d) => d.to >= n - 2)
      .slice()
      .sort((a, b) => b.confidence - a.confidence);
  };

  /**
   * Time to the close of the forming bar.
   *
   * Read through a function rather than a `computed` so the once-a-second
   * `nowMs` tick does not invalidate a cached node the rest of the bar depends
   * on; the three live-bar callbacks that read it each run per repaint anyway.
   */
  const barCountdown = () =>
    countdown({
      bars: bars(),
      timeframe: state.timeframe(),
      now: nowMs(),
      market: marketState(state.symbol(), nowMs()),
    });

  /* ---------------------------------------------------------------------- *
   * The next bar: a range, on the chart, where it can be read against price.
   *
   * "Where is the next candle predictor" has an answer and it is not the one
   * people expect, so the answer has to be VISIBLE rather than filed on a desk
   * nobody opens. The band in the overscroll is that: the interval the next
   * close is expected to land in, at 80%, drawn against the axis it is
   * measured on.
   *
   * There is no direction call in it and there will not be — analysis/
   * forecast.ts opens with the argument, and the short version is that one bar
   * ahead is the horizon where a direction call is least defensible and most
   * expensive. What IS forecastable one bar ahead is the SIZE of the move,
   * because volatility clusters, and that is what this draws.
   * ---------------------------------------------------------------------- */

  /**
   * Cached because `forecastRange` is not cheap enough for the paint path.
   *
   * Measured at 6–11ms on 800 bars: the percentile loop refits the EWMA 250
   * times over expanding prefixes. A live crypto feed repaints several times a
   * second, so computing this per repaint would spend more time forecasting
   * the next bar than drawing the 800 that already happened.
   *
   * Recomputed when a NEW BAR ARRIVES, which is also the only moment the
   * estimate can actually change: sigma, and the standardised quantiles it is
   * scaled by, are functions of closed bars. Within the bar the band still
   * tracks the live price — see `scaled` below — so it moves with the candle
   * without being refitted by it.
   */
  let fcCache: { key: string; f: ReturnType<typeof forecastRange>; cal: Calibration } | null = null;

  const nextBarBand = (): { low: number; high: number; expected: number; calibrated: boolean } | null => {
    const series = bars();
    if (series.length === 0) return null;
    const last = series[series.length - 1] as BarView;
    const key = `${state.symbol()}|${state.timeframe()}|${last.t}`;
    if (fcCache === null || fcCache.key !== key) {
      fcCache = { key, f: forecastRange(series), cal: calibration(series) };
    }
    const f = fcCache.f;
    if (f === null) return null;

    /* Re-centre on the live close without refitting.
       `expected = price * sigma` at fit time, so `expected / sigma` recovers
       the price it was fitted at, and every bound is proportional to it. */
    const fittedAt = f.expected / f.sigma;
    const scale = fittedAt > 0 ? last.c / fittedAt : 1;
    return {
      low: f.low * scale,
      high: f.high * scale,
      expected: f.expected * scale,
      calibrated: fcCache.cal.usable && fcCache.cal.error <= GOOD_ENOUGH,
    };
  };

  return { lastBar, heatNow, sessionClock, freshDetections, barCountdown, nextBarBand };
}
