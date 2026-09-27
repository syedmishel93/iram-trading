/**
 * THE RESOLVER THE ENGINE NEVER CALLED.
 *
 * MEASURED BEFORE THIS EXISTED. `backtest/intrabar.ts` is a complete, careful
 * stop-versus-target resolver — it refuses on partial coverage, refuses when one
 * minute holds both levels, and tags every answer with `basis`. Its only importer
 * was `ledger.ts`. The BACKTESTER never called it, so every run resolved an
 * ambiguous bar the pessimistic way:
 *
 *     if (hitStop) { ... } else if (hitTarget) { ... }
 *
 * That is the right default and it is an assumption, not a measurement. How much
 * it costs was measured before deciding to wire it, because the resolver's own
 * header calls it "the largest remaining source of error in the engine" and the
 * numbers do not support that at ordinary stops:
 *
 *     stop / target        BTCUSDT 1h    SPX 1d      bars holding both levels
 *     2.0 ATR / 2.0 R          0.0%        0.0%
 *     1.0 ATR / 1.5 R          0.8%        0.2%
 *     0.5 ATR / 1.0 R          7.7%        5.7%
 *
 * So it is worth wiring and worth scoping honestly: near zero at wide stops, and
 * material only for tight-stop styles. Which is why the tally is REPORTED rather
 * than assumed — "84% of exits measured" and "every exit assumed" are different
 * claims about the same equity curve.
 *
 * THE TEST THAT MATTERS IS `minutes can turn a stop into a target`. It is the
 * only one that proves the resolver reaches the exit decision; everything else
 * guards a way it could silently stop mattering.
 *
 * THE SECOND IS `an unambiguous bar is not counted as measured`. A bar that
 * touched only one level was never in doubt, and folding it into the measured
 * share would report a run as 99% resolved on the strength of bars that needed
 * no resolving — the share would rise as the ambiguity fell, which is backwards.
 */

import { describe, expect, it } from "vitest";
import { runBacktest, ZERO_COSTS, type BarView, type Strategy } from "../src/backtest/engine";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/**
 * One hourly bar whose range holds BOTH the stop and the target.
 *
 * Entry is at bar 1's open (100), stop 95, target 105. Bar 1 runs 94..106, so
 * the engine cannot tell the order and assumes the stop.
 */
const quietBar = (i: number): BarView => ({
  t: T0 + i * HOUR,
  o: 100,
  h: 100.5,
  l: 99.5,
  c: 100,
  v: 10,
});

/* Fourteen bars, because the engine refuses a series shorter than warm-up plus
   ten and a refusal is not the thing under test here. Only bar 1 is wide. */
const parent = (): BarView[] =>
  Array.from({ length: 14 }, (_, i) =>
    i === 1 ? { t: T0 + HOUR, o: 100, h: 106, l: 94, c: 100, v: 10 } : quietBar(i),
  );

/** Enters long on bar 0, so it fills at bar 1's open and bar 1 resolves it. */
const longAt = (stop: number, target: number): Strategy => ({
  id: "t:amb",
  label: "one ambiguous bar",
  warmup: 0,
  entry: (_ctx, i) => (i === 0 ? { direction: "long", stop, target, reason: "amb" } : null),
});

/**
 * 60 contiguous minutes covering bar 1, with the touches in a chosen order.
 *
 * `targetFirst` puts the high at minute 10 and the low at minute 40; otherwise
 * the low comes first. Every other minute is quiet, so exactly one minute holds
 * exactly one level — which is the only shape `settleBar` will call measured.
 */
const minutesFor = (targetFirst: boolean): BarView[] =>
  Array.from({ length: 60 }, (_, m) => {
    const t = T0 + HOUR + m * MIN;
    const quiet = { t, o: 100, h: 100.2, l: 99.8, c: 100, v: 1 };
    const spikeUp = { t, o: 100, h: 106, l: 99.8, c: 100, v: 1 };
    const spikeDown = { t, o: 100, h: 100.2, l: 94, c: 100, v: 1 };
    if (m === 10) return targetFirst ? spikeUp : spikeDown;
    if (m === 40) return targetFirst ? spikeDown : spikeUp;
    return quiet;
  });

const opts = (minutes?: readonly BarView[]) => ({
  costs: ZERO_COSTS,
  ...(minutes ? { minutes, barIntervalMs: HOUR } : {}),
});

describe("without minutes, nothing changes", () => {
  it("still assumes the stop on a bar holding both, as it always has", () => {
    // The pessimistic rule is the correct default and must survive this change:
    // it understates edge rather than inventing it.
    const r = runBacktest(longAt(95, 105), parent(), opts());
    expect(r.trades[0]!.exitReason).toBe("stop");
  });

  it("reports the ambiguity it could not resolve, rather than staying quiet", () => {
    // A run that does not say how many exits it guessed is a run nobody can
    // weigh against one that measured them.
    const r = runBacktest(longAt(95, 105), parent(), opts());
    expect(r.settle.ambiguous).toBe(1);
    expect(r.settle.measured).toBe(0);
    expect(r.settle.share).toBe(0);
  });
});

describe("with minutes covering the bar", () => {
  it("MINUTES CAN TURN A STOP INTO A TARGET", () => {
    /* THE PROOF THAT THE RESOLVER REACHES THE EXIT DECISION. The same bars, the
       same rule, the same levels — and the answer flips because the order inside
       the bar is now known rather than assumed. */
    const assumed = runBacktest(longAt(95, 105), parent(), opts());
    const measured = runBacktest(longAt(95, 105), parent(), opts(minutesFor(true)));

    expect(assumed.trades[0]!.exitReason).toBe("stop");
    expect(measured.trades[0]!.exitReason).toBe("target");
    expect(measured.trades[0]!.returnPct).toBeGreaterThan(assumed.trades[0]!.returnPct);
  });

  it("and confirms the stop when the stop really was first", () => {
    // The resolver must be able to agree with the pessimistic rule, or it is
    // only ever upgrading results — which is the direction to distrust.
    const r = runBacktest(longAt(95, 105), parent(), opts(minutesFor(false)));
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exitBasis).toBe("measured");
  });

  it("marks the exit measured, so a resolved exit is not mistaken for a guess", () => {
    const r = runBacktest(longAt(95, 105), parent(), opts(minutesFor(true)));
    expect(r.trades[0]!.exitBasis).toBe("measured");
    expect(r.settle.measured).toBe(1);
    expect(r.settle.ambiguous).toBe(1);
    expect(r.settle.share).toBe(1);
  });

  it("KEEPS THE PESSIMISTIC ANSWER WHEN THE MINUTES DO NOT COVER THE BAR", () => {
    /* The one failure mode that flips the sign of a result: if the first touch
       happened in a minute nobody holds, walking the minutes that ARE present
       finds the SECOND touch and reports a loser as a winner. `settleBar` checks
       coverage before reading anything, and the engine must not undo that. */
    const holed = minutesFor(true).filter((_, m) => m !== 5);
    const r = runBacktest(longAt(95, 105), parent(), opts(holed));
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exitBasis).toBe("assumed");
    expect(r.settle.measured).toBe(0);
  });

  it("keeps the pessimistic answer when one minute holds both levels", () => {
    // The original problem one level down. It tells you nothing about the order.
    const both = Array.from({ length: 60 }, (_, m) => {
      const t = T0 + HOUR + m * MIN;
      return m === 10
        ? { t, o: 100, h: 106, l: 94, c: 100, v: 1 }
        : { t, o: 100, h: 100.2, l: 99.8, c: 100, v: 1 };
    });
    const r = runBacktest(longAt(95, 105), parent(), opts(both));
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exitBasis).toBe("assumed");
  });

  it("AN UNAMBIGUOUS BAR IS NOT COUNTED AS MEASURED", () => {
    /* A bar that touched only the target was never in doubt. Counting it as a
       measured resolution would make the share rise as the ambiguity fell, so a
       run with nothing to resolve would report itself as perfectly resolved —
       the same shape as a status strip painting "0 of 0 running" green. */
    const clean: BarView[] = Array.from({ length: 14 }, (_, i) =>
      i === 1
        ? { t: T0 + HOUR, o: 100, h: 106, l: 99.5, c: 100, v: 10 } // target only
        : quietBar(i),
    );
    const r = runBacktest(longAt(95, 105), clean, opts(minutesFor(true)));
    expect(r.trades[0]!.exitReason).toBe("target");
    expect(r.trades[0]!.exitBasis).toBe("unambiguous");
    expect(r.settle.ambiguous).toBe(0);
    // Nothing needed resolving, so the share is UNKNOWN rather than perfect.
    expect(Number.isNaN(r.settle.share)).toBe(true);
  });

  it("REFUSES minutes with no bar width to put them against", () => {
    // A span needs an interval. Guessing one from the bars would be a unit
    // nobody stated, on the exact code path that decides winners from losers.
    const r = runBacktest(longAt(95, 105), parent(), {
      costs: ZERO_COSTS,
      minutes: minutesFor(true),
    });
    expect(r.refused).toBeTruthy();
    expect(r.refused).toContain("barIntervalMs");
  });
});
