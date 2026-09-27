/**
 * COLLECTING SIGNALS — the step that makes the ledger a fair sample.
 *
 * `runBacktest` asks the strategy only where it could act: past warm-up, and
 * never while a position is open. That is right for a backtest and wrong for a
 * training set. The trades a backtest took are SELECTED, and a model fitted to
 * them learns the selection rule rather than the market — it will look
 * excellent for exactly that reason.
 *
 * THE ONE TEST THAT MATTERS HERE is the first: the collector must find MORE
 * signals than the backtest took trades, on a series where signals overlap. If
 * the two counts ever match on such a series the collector has quietly become
 * the trade log, and every honesty property downstream is gone with no error
 * anywhere.
 */

import { describe, expect, it } from "vitest";
import { collectSignals } from "../src/backtest/collect";
import { FEATURE_WARMUP } from "../src/backtest/features";
import { runBacktest, type Strategy, type StrategyContext } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/** A series that trends and wobbles, so indicators are not constant. */
function series(n: number): BarView[] {
  const out: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    px += Math.sin(i / 9) * 0.8 + Math.cos(i / 31) * 1.1 + 0.04;
    const o = px;
    const c = px + Math.sin(i / 4) * 0.5;
    const h = Math.max(o, c) + 0.5;
    const l = Math.min(o, c) - 0.5;
    out.push({ t: i * HOUR, o, h, l, c, v: 1000 + (i % 13) * 20 });
  }
  return out;
}

/** Fires on most bars, with a wide stop, so signals overlap heavily. */
const eager: Strategy = {
  id: "eager",
  label: "Fires whenever the bar closed up",
  warmup: 5,
  entry(ctx: StrategyContext, i: number) {
    const c = ctx.close[i] as number;
    const p = ctx.close[i - 1] as number;
    if (!(c > p)) return null;
    return { direction: "long" as const, stop: c * 0.97, target: c * 1.03, reason: "closed up" };
  },
};

describe("the collector is not the trade log", () => {
  it("records overlapping setups the backtest had to skip", () => {
    const bars = series(600);
    const got = collectSignals(eager, bars);
    /* The backtest gets a HEAD START here — its own warm-up is 5 where the
       collector waits for the feature matrix's 220 — and still takes fewer
       trades, because it cannot enter while it is already in. */
    const bt = runBacktest(eager, bars);

    expect(got.signals.length).toBeGreaterThan(50);
    // The whole point. Equality here would mean the collector had become a
    // selected sample without anything failing.
    expect(got.signals.length).toBeGreaterThan(bt.trades.length);
  });

  it("asks about every bar past both warm-ups and no bar before them", () => {
    const bars = series(500);
    const got = collectSignals(eager, bars);
    expect(got.asked).toBe(500 - FEATURE_WARMUP);
    for (const s of got.signals) expect(s.index).toBeGreaterThanOrEqual(FEATURE_WARMUP);
  });

  it("honours a strategy warm-up longer than the feature one", () => {
    const slow: Strategy = { ...eager, warmup: 400 };
    const got = collectSignals(slow, series(500));
    for (const s of got.signals) expect(s.index).toBeGreaterThanOrEqual(400);
  });
});

describe("what it refuses to record", () => {
  it("drops a signal with no target, because the ledger cannot label it", () => {
    // The ledger settles stop against target. A strategy that exits on a RULE
    // instead has no level to resolve to, so such a signal is not an
    // observation — recording it with an invented target would be a fabricated
    // label, which is worse than no row.
    const noTarget: Strategy = {
      ...eager,
      entry(ctx, i) {
        const c = ctx.close[i] as number;
        return { direction: "long" as const, stop: c * 0.97, reason: "always" };
      },
    };
    const got = collectSignals(noTarget, series(400));
    expect(got.asked).toBeGreaterThan(100);
    expect(got.signals).toHaveLength(0);
  });

  it("counts the signals whose features could not be built rather than filling them", () => {
    // Zero range everywhere: ATR is zero, so no feature row exists. The
    // strategy still fires, and every one of those must be COUNTED — a silent
    // drop is a sample that shrank without saying so.
    const flat: BarView[] = Array.from({ length: 400 }, (_, i) => ({
      t: i * HOUR,
      o: 50,
      h: 50,
      l: 50,
      c: i % 2 === 0 ? 50 : 50,
      v: 10,
    }));
    const always: Strategy = {
      ...eager,
      entry(ctx, i) {
        const c = ctx.close[i] as number;
        return { direction: "long" as const, stop: c * 0.97, target: c * 1.03, reason: "always" };
      },
    };
    const got = collectSignals(always, flat);
    expect(got.signals).toHaveLength(0);
    expect(got.unfeatured).toBe(400 - FEATURE_WARMUP);
  });

  it("answers an empty series without pretending", () => {
    const got = collectSignals(eager, []);
    expect(got.signals).toHaveLength(0);
    expect(got.asked).toBe(0);
  });
});

describe("the signal is the strategy's own", () => {
  it("passes the direction, stop and target through unchanged", () => {
    const bars = series(400);
    const got = collectSignals(eager, bars);
    expect(got.signals.length).toBeGreaterThan(0);
    for (const s of got.signals.slice(0, 20)) {
      const c = (bars[s.index] as BarView).c;
      expect(s.direction).toBe("long");
      expect(s.stop).toBeCloseTo(c * 0.97, 9);
      expect(s.target).toBeCloseTo(c * 1.03, 9);
    }
  });

  it("carries a full feature row on every signal it keeps", () => {
    const got = collectSignals(eager, series(500));
    expect(got.signals.length).toBeGreaterThan(0);
    for (const s of got.signals) {
      for (const n of got.matrix.names) {
        expect(Number.isFinite(s.features[n] as number)).toBe(true);
      }
    }
  });
});
