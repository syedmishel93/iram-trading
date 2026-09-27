import { describe, expect, it } from "vitest";
import { skewTolerance,
  clockSkew,
  countdown,
  countdownTone,
  formatSpan,
  measuredSpan,
  nextCloseAt,
  NOMINAL_SPAN_MS,
  spanFor,
} from "../src/ui/countdown";
import { AVG_MONTH_MS, intervalMs } from "../src/data/history";
import type { BarView } from "../src/chart/series";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

const bars = (count: number, step: number, from = T0): BarView[] =>
  Array.from({ length: count }, (_, i) => ({
    t: from + i * step,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 10,
  }));

/** Last bar open + how far into it we are. */
const at = (list: BarView[], intoMs: number): number =>
  (list[list.length - 1] as BarView).t + intoMs;

describe("formatSpan", () => {
  /**
   * The bug that started this: no hours branch. A 4H bar counted down from
   * "239:59" and a daily from "1439:59".
   */
  it("shows hours instead of a four-digit minute field", () => {
    expect(formatSpan(4 * HOUR - 1000)).toBe("3:59:59");
    expect(formatSpan(24 * HOUR - 1000)).toBe("23:59:59");
  });

  it("drops the hour field when there is no hour to show", () => {
    expect(formatSpan(59_000)).toBe("0:59");
    expect(formatSpan(90_000)).toBe("1:30");
    expect(formatSpan(59 * MIN + 59_000)).toBe("59:59");
  });

  it("pads minutes and seconds, but never the leading field", () => {
    expect(formatSpan(HOUR + 5 * MIN + 3000)).toBe("1:05:03");
    expect(formatSpan(5 * MIN + 3000)).toBe("5:03");
  });

  it("rounds down, so it never shows a time the bar has already passed", () => {
    expect(formatSpan(1999)).toBe("0:01");
    expect(formatSpan(0)).toBe("0:00");
  });

  it("floors at zero rather than printing a negative clock", () => {
    expect(formatSpan(-5000)).toBe("0:00");
  });
});

describe("measuredSpan", () => {
  it("measures the gap the feed actually delivers", () => {
    expect(measuredSpan(bars(50, 5 * MIN))).toBe(5 * MIN);
  });

  /**
   * The median is the point. A weekend, a holiday or a vendor backfill puts
   * one enormous gap in the series, and a mean would follow it anywhere.
   */
  it("is not moved by a weekend gap", () => {
    const list = bars(40, HOUR);
    list[20] = { ...(list[20] as BarView), t: (list[19] as BarView).t + 60 * HOUR };
    expect(measuredSpan(list)).toBe(HOUR);
  });

  it("ignores duplicate or out-of-order timestamps rather than counting them", () => {
    const list = bars(30, HOUR);
    /* A repeated timestamp is a feed defect, not a zero-length bar. */
    list[25] = { ...(list[25] as BarView), t: (list[24] as BarView).t };
    expect(measuredSpan(list)).toBe(HOUR);
  });

  it("returns 0 rather than guessing from one bar", () => {
    expect(measuredSpan(bars(1, HOUR))).toBe(0);
    expect(measuredSpan([])).toBe(0);
  });
});

describe("spanFor", () => {
  it("prefers the measurement over the label", () => {
    /* A "1h" request the provider served as 5m bars. */
    expect(spanFor(bars(50, 5 * MIN), "1h")).toBe(NOMINAL_SPAN_MS["1h"]);
  });

  it("accepts a measurement close to the label, which is the normal case", () => {
    expect(spanFor(bars(50, HOUR), "1h")).toBe(HOUR);
  });

  /**
   * When the two disagree wildly the measurement is not trusted either: a
   * chart holding only backfilled dailies against a 1m request would count
   * down from 23:59:59 with total confidence. Falling back to the label at
   * least matches what was asked for.
   */
  it("falls back to the label when the measurement is nowhere near it", () => {
    expect(spanFor(bars(50, 86_400_000), "1m")).toBe(60_000);
  });

  it("trusts the measurement for a timeframe it has no label for", () => {
    expect(spanFor(bars(50, 45 * MIN), "45m")).toBe(45 * MIN);
  });

  it("falls back to the label when there is nothing to measure", () => {
    expect(spanFor(bars(1, HOUR), "4h")).toBe(4 * HOUR);
    expect(spanFor([], "4h")).toBe(4 * HOUR);
  });

  it("returns 0 when it has neither, rather than inventing a span", () => {
    expect(spanFor([], "banana")).toBe(0);
  });
});

describe("clockSkew", () => {
  /**
   * A bar stamped `t` cannot exist before real time `t`. Seeing it while the
   * local clock reads earlier proves the clock is slow by at least that much.
   */
  it("detects a local clock running behind the feed", () => {
    expect(clockSkew(T0, T0 - 180_000)).toBe(180_000);
  });

  /**
   * A local clock running FAST is indistinguishable from a feed that is
   * slightly behind. Guessing between them would blank a working countdown to
   * correct a fault that may not exist.
   */
  it("reports nothing when the clock is ahead, because it cannot tell", () => {
    expect(clockSkew(T0, T0 + 180_000)).toBe(0);
  });
});

describe("countdown", () => {
  const open = "open" as const;

  it("counts down within the forming bar", () => {
    const list = bars(50, HOUR);
    const c = countdown({ bars: list, timeframe: "1h", now: at(list, 20 * MIN), market: open });
    expect(c.kind).toBe("counting");
    expect(c.text).toBe("40:00");
  });

  it("shows hours on a timeframe that has them", () => {
    const list = bars(50, 4 * HOUR);
    const c = countdown({ bars: list, timeframe: "4h", now: at(list, 10 * MIN), market: open });
    expect(c.text).toBe("3:50:00");
  });

  /**
   * The failure that made this module. A Windows box three minutes off NTP put
   * `left` above `span`, the old code read that as nonsense and rendered "—",
   * and the 1m countdown was permanently blank with nothing saying why.
   *
   * THIS TEST USED TO EXPECT "1:00" AND THAT WAS WRONG.
   * Absorbing the skew silently made a three-minute-slow clock render a full
   * bar span as though it were counting. On a 1m chart that is three bars of
   * error printed as a confident number — and it is character-for-character
   * what the MT5 three-hour bug looked like on screen, which is how that one
   * survived so long. Small lie, large lie, same pixels.
   *
   * The requirement the original fix set is still met, and met better: this is
   * not a blank dash, and it says which fault it is. Drift measured in seconds
   * is still absorbed — see the test below.
   */
  it("names a clock minutes behind the feed instead of printing a full span", () => {
    const list = bars(50, MIN);
    const c = countdown({
      bars: list,
      timeframe: "1m",
      now: at(list, 0) - 180_000, // clock three minutes slow
      market: open,
    });
    expect(c.kind).toBe("ahead");
    expect(c.text).toBe("ahead 3m");
    expect(c.text).not.toBe("—");
  });

  it("absorbs the seconds of drift a synced machine actually has", () => {
    const list = bars(50, HOUR);
    const c = countdown({
      bars: list,
      timeframe: "1h",
      now: at(list, 0) - 3_000, // three seconds slow
      market: open,
    });
    expect(c.kind).toBe("counting");
    expect(c.text).toBe("1:00:00");
  });

  /* ── the three ways of not counting, which used to be one dash ────────── */

  it("says 'due' when the close has passed and the next bar has not landed", () => {
    const list = bars(50, HOUR);
    const c = countdown({ bars: list, timeframe: "1h", now: at(list, HOUR + 30_000), market: open });
    expect(c.kind).toBe("due");
    expect(c.text).toBe("due");
  });

  it("names a stopped feed, and says how long it has been stopped", () => {
    const list = bars(50, HOUR);
    const c = countdown({ bars: list, timeframe: "1h", now: at(list, 5 * HOUR), market: open });
    expect(c.kind).toBe("late");
    expect(c.text).toBe("late 4h");
  });

  it("blames the venue, not the feed, when the venue is shut", () => {
    const list = bars(50, HOUR);
    const c = countdown({
      bars: list,
      timeframe: "1h",
      now: at(list, 40 * HOUR),
      market: "closed",
    });
    expect(c.kind).toBe("closed");
    expect(c.text).toBe("closed");
  });

  /**
   * A bar mid-count on a Friday afternoon is counting correctly. The market
   * check must only apply once the bar is actually overdue, or every FX
   * countdown would blank in the last hour before the weekend.
   */
  it("keeps counting into a close rather than pre-empting it", () => {
    const list = bars(50, HOUR);
    const c = countdown({
      bars: list,
      timeframe: "1h",
      now: at(list, 30 * MIN),
      market: "closed",
    });
    expect(c.kind).toBe("counting");
    expect(c.text).toBe("30:00");
  });

  /**
   * An instrument whose calendar we do not have is not evidence it is shut,
   * and calling a live feed "closed" is the worse of the two errors.
   */
  it("treats an unknown calendar as open", () => {
    const list = bars(50, HOUR);
    const c = countdown({
      bars: list,
      timeframe: "1h",
      now: at(list, 5 * HOUR),
      market: "unknown",
    });
    expect(c.kind).toBe("late");
  });

  it("is unknown with no bars, and says so as a gap rather than a number", () => {
    const c = countdown({ bars: [], timeframe: "1h", now: T0, market: open });
    expect(c.kind).toBe("unknown");
    expect(c.text).toBe("—");
    expect(Number.isNaN(c.msLeft)).toBe(true);
  });

  it("is unknown for a timeframe it cannot resolve a span for", () => {
    expect(countdown({ bars: [], timeframe: "banana", now: T0, market: open }).kind).toBe("unknown");
  });

  it("never returns a blank string for any state", () => {
    const list = bars(50, HOUR);
    for (const now of [at(list, 0), at(list, HOUR + 1), at(list, 99 * HOUR), T0 - 1e9]) {
      for (const market of ["open", "closed", "unknown"] as const) {
        const c = countdown({ bars: list, timeframe: "1h", now, market });
        expect(c.text.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("countdownTone", () => {
  /* A stopped feed is the only one worth colouring: "closed" is normal and a
     running countdown should not shout. */
  it("warns only on a stopped feed", () => {
    expect(countdownTone("late")).toBe("warn");
    expect(countdownTone("counting")).toBeUndefined();
    expect(countdownTone("due")).toBeUndefined();
    expect(countdownTone("closed")).toBe("mute");
    expect(countdownTone("unknown")).toBe("mute");
  });
});

/**
 * THE TIMEFRAMES THAT WERE MISSING: 3m, 1w and 1M.
 *
 * The first two needed nothing — the arithmetic was already right. The month
 * needed two fixes, and the tests below are of those two fixes rather than of
 * the ladder itself, because a timeframe you can select and cannot count down
 * correctly is worse than one you cannot select.
 */
describe("monthly bars", () => {
  /**
   * THE BUG. `intervalMs("1M")` returned 3,600,000 — one hour. `endsWith("m")`
   * is case-sensitive, so a monthly timeframe missed the minute branch and
   * every other branch, and fell through to the hourly default. That number
   * drives the cache TTL and the bar archive's CONTIGUITY test, so monthly
   * bars would have been stored as a run of one-hour gaps.
   */
  it("no longer reads a month as an hour", () => {
    expect(intervalMs("1M")).toBe(AVG_MONTH_MS);
    expect(intervalMs("3M")).toBe(3 * AVG_MONTH_MS);
    expect(intervalMs("1M")).not.toBe(intervalMs("1h"));
  });

  it("did not break the lower-case timeframes on the way past", () => {
    expect(intervalMs("1m")).toBe(60_000);
    expect(intervalMs("3m")).toBe(180_000);
    expect(intervalMs("15m")).toBe(900_000);
    expect(intervalMs("1h")).toBe(HOUR);
    expect(intervalMs("1d")).toBe(86_400_000);
    expect(intervalMs("1w")).toBe(604_800_000);
  });

  /**
   * A calendar month is not a constant. February is 2,419,200,000ms and July
   * is 2,678,400,000 — an 11% spread — so a countdown built by adding a fixed
   * span is wrong by up to three days, and wrong in a different direction
   * depending which month it is.
   */
  it("closes a monthly bar on the calendar, not on an average", () => {
    const feb = Date.UTC(2027, 1, 1); // 1 Feb 2027, a 28-day month
    const jul = Date.UTC(2027, 6, 1); // 1 Jul 2027, a 31-day month
    expect(nextCloseAt(feb, "1M", AVG_MONTH_MS)).toBe(Date.UTC(2027, 2, 1));
    expect(nextCloseAt(jul, "1M", AVG_MONTH_MS)).toBe(Date.UTC(2027, 7, 1));
    /* And the two are genuinely different lengths, which is the whole point. */
    expect(nextCloseAt(feb, "1M", AVG_MONTH_MS) - feb).toBe(28 * 86_400_000);
    expect(nextCloseAt(jul, "1M", AVG_MONTH_MS) - jul).toBe(31 * 86_400_000);
  });

  it("crosses a year end", () => {
    const dec = Date.UTC(2027, 11, 1);
    expect(nextCloseAt(dec, "1M", AVG_MONTH_MS)).toBe(Date.UTC(2028, 0, 1));
  });

  it("handles a leap February", () => {
    const feb = Date.UTC(2028, 1, 1);
    expect(nextCloseAt(feb, "1M", AVG_MONTH_MS) - feb).toBe(29 * 86_400_000);
  });

  /* Every other timeframe is a fixed multiple and must not take the calendar
     path — a week is exactly seven days in UTC and adding one via the calendar
     would be a slower way to get the same answer, and a different answer if
     anything ever ran it in local time. */
  it("adds the span for everything that is not a month", () => {
    expect(nextCloseAt(T0, "1h", HOUR)).toBe(T0 + HOUR);
    expect(nextCloseAt(T0, "1w", 604_800_000)).toBe(T0 + 604_800_000);
    expect(nextCloseAt(T0, "3m", 180_000)).toBe(T0 + 180_000);
  });

  it("knows a nominal span for every timeframe the picker offers", () => {
    for (const tf of ["1m", "3m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]) {
      expect(NOMINAL_SPAN_MS[tf], tf).toBeGreaterThan(0);
    }
  });

  /* End to end: a monthly bar opened on 1 February, read on the 10th, counts
     down to 1 March — not to 28.4 days after the open. */
  it("counts a February bar down to the first of March", () => {
    const feb = Date.UTC(2027, 1, 1);
    const monthly: BarView[] = [
      { t: Date.UTC(2026, 11, 1), o: 100, h: 101, l: 99, c: 100, v: 10 },
      { t: Date.UTC(2027, 0, 1), o: 100, h: 101, l: 99, c: 100, v: 10 },
      { t: feb, o: 100, h: 101, l: 99, c: 100, v: 10 },
    ];
    const now = Date.UTC(2027, 1, 10);
    const c = countdown({ bars: monthly, timeframe: "1M", now, market: "open" });
    expect(c.kind).toBe("counting");
    expect(c.msLeft).toBe(Date.UTC(2027, 2, 1) - now);
  });
});

/**
 * THE THREE-HOUR BUG.
 *
 * MT5 stamps bars on the broker's server clock. Measured against the broker
 * this was found on, that clock runs exactly three hours ahead of UTC — so
 * every gold and forex bar arrived stamped three hours into the future, and
 * the skew correction turned that into a countdown frozen at the full bar span
 * for ever. `NEXT 1:00`, on a live 1m feed, never moving, with nothing on
 * screen saying why. The fix is in server/mt5_bridge.py; these tests are the
 * client's refusal to render a plausible number for it ever again.
 */
describe("a feed on a different clock", () => {
  const at = (t: number): BarView => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const minute = (n: number): BarView[] =>
    Array.from({ length: n }, (_, i) => at(i * 60_000));

  it("does not report a countdown when the feed is hours ahead", () => {
    const bars = minute(40);
    const lastOpen = 39 * 60_000;
    /* Local clock three hours behind the newest bar — the measured case. */
    const c = countdown({
      bars,
      timeframe: "1m",
      now: lastOpen - 3 * 3_600_000,
      market: "open",
    });
    expect(c.kind).toBe("ahead");
    expect(c.text).toBe("ahead 3h");
    /* The old code returned exactly one span here and called it "counting". */
    expect(c.text).not.toBe("1:00");
    expect(Number.isNaN(c.msLeft)).toBe(true);
  });

  it("still absorbs ordinary clock drift rather than crying wrong", () => {
    const bars = minute(40);
    const lastOpen = 39 * 60_000;
    /* Two seconds is NTP drift, or a feed publishing a shade early. */
    const c = countdown({ bars, timeframe: "1m", now: lastOpen - 2_000, market: "open" });
    expect(c.kind).toBe("counting");
  });

  it("colours it as a fault, because it is one", () => {
    expect(countdownTone("ahead")).toBe("warn");
  });

  /* The tolerance is drift-sized, never bar-sized: a whole minute of skew on a
     1m chart is not a clock that needs helping. */
  it("never absorbs more than one bar of skew", () => {
    expect(skewTolerance(60_000)).toBe(60_000);
    expect(skewTolerance(3_600_000)).toBe(120_000);
    expect(skewTolerance(2_629_746_000)).toBe(120_000);
  });
});
