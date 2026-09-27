/**
 * THE RUN PLAN — turning "BTCUSDT, 2000 to 2026, $500" into an honest answer.
 *
 * The Playbook asked for 1,500 bars and got 992, which is why a strategy the
 * owner wanted thousands of trades from produced 73. The fix is not a bigger
 * constant: it is asking for a SPAN, checking whether the archive holds it, and
 * SAYING SO when it does not.
 *
 * WHAT THESE TESTS PIN, and each is a way of lying about history:
 *
 *  1. A YEAR RANGE THE ARCHIVE CANNOT COVER IS NAMED, NOT SILENTLY SHRUNK.
 *     Asking BTCUSDT for 2000 is asking for eight years before Bitcoin traded
 *     and seventeen before this venue listed it. Returning 2022-2026 without a
 *     word turns "I tested twenty-six years" into something the operator
 *     believes.
 *  2. THE BAR COUNT FOLLOWS THE SPAN AND THE TIMEFRAME, not a constant. Five
 *     years of 1h is ~43,800 bars; of 1d it is ~1,826. One number cannot serve
 *     both, and 1,500 serves neither.
 *  3. THE CEILING IS STATED WHEN IT BINDS. `MAX_STUDY_BARS` exists for a
 *     reason, and a plan capped by it must say it was capped.
 *  4. RISK IS MONEY, AND MONEY NEEDS A BALANCE. 1% of $500 is $5, and a plan
 *     that cannot say that cannot size anything.
 *  5. IT REFUSES A RANGE THAT IS BACKWARDS OR EMPTY rather than computing a
 *     negative span into a plausible-looking bar count.
 */

import { describe, expect, it } from "vitest";
import { MAX_STUDY_BARS } from "../src/ui/study/state";
import { planRun, planLine, loadForPlan, nearestTimeframe, type Holding } from "../src/backtest/runplan";
import type { HistoryService } from "../src/data/history";

const YEAR = 365.25 * 86_400_000;

/** What the archive holds for a series, as the inventory reports it. */
const held = (fromISO: string, toISO: string, bars = 40_910): Holding => ({
  oldest: Date.parse(fromISO),
  newest: Date.parse(toISO),
  bars,
});

/** BTCUSDT 1h as this machine actually holds it. */
const BTC_1H = held("2022-01-23T00:00:00Z", "2026-09-24T00:00:00Z");

const req = (over: Partial<Parameters<typeof planRun>[0]> = {}) => ({
  symbol: "BTCUSDT",
  timeframe: "1h",
  fromYear: 2022,
  toYear: 2026,
  balance: 500,
  riskPct: 1,
  ...over,
});

describe("the span the archive can actually serve", () => {
  it("WARNS about history it does not hold, but still asks for it", () => {
    /* THE CORRECTION. The first version CLIPPED the window to the archive's
       oldest bar, and running it showed the mistake at once: a profile holding
       five weeks of BTCUSDT 1h answered a request for 2000–2026 with "the run
       covers 2026-08-21 to 2026-09-24". Honest about the archive, and useless
       as a control — you could never ask for history you did not already have.
       The past edge is a WARNING now, because backfill can reach for it. */
    const p = planRun(req({ fromYear: 2000 }), BTC_1H);
    expect(p.ok).toBe(true);
    expect(p.clipped).toBe(true);
    expect(new Date(p.from).getUTCFullYear()).toBe(2000);
    expect(p.why).toMatch(/2022-01-23/);
    expect(p.why).toMatch(/reach back/i);
  });

  it("still clips the FUTURE edge, because nobody can backfill tomorrow", () => {
    const p = planRun(req({ fromYear: 2023, toYear: 2030 }), BTC_1H);
    expect(p.to).toBe(BTC_1H.newest);
    expect(p.why).toMatch(/newest/i);
  });

  it("does not claim it clipped anything when the archive covers the request", () => {
    const p = planRun(req({ fromYear: 2023, toYear: 2025 }), BTC_1H);
    expect(p.clipped).toBe(false);
    expect(p.why).toBe("");
  });

  it("refuses a range that ends before the data begins", () => {
    /* 2010–2015 ends eleven years before the newest bar and seven before the
       oldest. There is no window here to reach back INTO — unlike 2000–2026,
       which overlaps and is therefore a fetch rather than a refusal. */
    const p = planRun(req({ fromYear: 2010, toYear: 2015 }), BTC_1H);
    expect(p.ok).toBe(false);
    expect(p.why).toMatch(/holds no/i);
    /* And it must say what it DOES have, or the refusal is a dead end rather
       than a next step. */
    expect(p.why).toMatch(/2022-01-23/);
  });
});

describe("the bar count follows the span, not a constant", () => {
  it("asks for far more 1h bars than 1d bars over the same years", () => {
    const hourly = planRun(req({ timeframe: "1h" }), BTC_1H);
    const daily = planRun(req({ timeframe: "1d" }), held("2021-04-04T00:00:00Z", "2026-09-24T00:00:00Z", 2000));
    expect(hourly.wantBars).toBeGreaterThan(daily.wantBars * 10);
  });

  it("puts roughly the right number of hours in four and a half years", () => {
    const p = planRun(req({ fromYear: 2022, toYear: 2026 }), BTC_1H);
    /* 2022-01-01 to 2026-12-31 clipped to the archive's 2022-01-23 start is
       about 4.7 years of hours. Pinned as a magnitude, not to the hour. */
    expect(p.wantBars).toBeGreaterThan(30_000);
    expect(p.wantBars).toBeLessThan(50_000);
  });

  it("STATES that the ceiling bound it, rather than returning a quiet cap", () => {
    const deep = held("1990-01-01T00:00:00Z", "2026-09-24T00:00:00Z", 400_000);
    const p = planRun(req({ fromYear: 1990, toYear: 2026, timeframe: "1h" }), deep);
    expect(p.capped).toBe(true);
    expect(p.wantBars).toBe(60_000);
    expect(p.why).toMatch(/60,000|60000|cap/i);
  });
});

describe("risk is money", () => {
  it("turns a balance and a percent into the amount at stake per trade", () => {
    const p = planRun(req({ balance: 500, riskPct: 1 }), BTC_1H);
    expect(p.riskPerTrade).toBeCloseTo(5, 10);
  });

  it("scales with the balance", () => {
    expect(planRun(req({ balance: 10_000, riskPct: 1 }), BTC_1H).riskPerTrade).toBeCloseTo(100, 10);
  });

  it("refuses a balance of zero rather than sizing everything at nothing", () => {
    const p = planRun(req({ balance: 0 }), BTC_1H);
    expect(p.ok).toBe(false);
    expect(p.why).toMatch(/balance/i);
  });

  it("refuses a risk percent that would bet the account", () => {
    const p = planRun(req({ riskPct: 60 }), BTC_1H);
    expect(p.ok).toBe(false);
    expect(p.why).toMatch(/risk/i);
  });
});

describe("refusing a range that is not a range", () => {
  it("refuses a backwards year range instead of computing a negative span", () => {
    const p = planRun(req({ fromYear: 2026, toYear: 2022 }), BTC_1H);
    expect(p.ok).toBe(false);
    expect(p.why).toMatch(/after|before|order/i);
  });

  it("accepts a single year", () => {
    const p = planRun(req({ fromYear: 2024, toYear: 2024 }), BTC_1H);
    expect(p.ok).toBe(true);
    expect(p.wantBars).toBeGreaterThan(8_000);
  });
});

describe("what the plan tells the desk to say", () => {
  it("reports the span it will actually run on, in years", () => {
    const p = planRun(req({ fromYear: 2022, toYear: 2026 }), BTC_1H);
    expect(p.years).toBeGreaterThan(4);
    expect(p.years).toBeLessThan(5);
    expect(p.to - p.from).toBeCloseTo(p.years * YEAR, -8);
  });

  it("carries the symbol and timeframe through, so a result can be labelled", () => {
    const p = planRun(req({ symbol: "XAUUSD", timeframe: "4h" }), held("2022-01-01T00:00:00Z", "2026-09-24T00:00:00Z", 9000));
    expect(p.symbol).toBe("XAUUSD");
    expect(p.timeframe).toBe("4h");
  });
});

describe("a control must not offer one bar size and run another", () => {
  /*
   * MEASURED on the running build: the Playbook's bar-size select displayed
   * "5m" while the plan beneath it refused with "the archive holds no XAUUSD
   * 3m to run on". The chart was on 3m, the desk took that as its default, and
   * 3m is not one of the five sizes the select offers — so the browser fell
   * back to showing the first option while the signal still held 3m. The
   * control said one thing and the engine would have run another, which is the
   * exact failure the desk's own subtitle promises cannot happen.
   *
   * A `<select>` given a value outside its options reports selectedIndex 0 and
   * says nothing. Nothing else in the stack can see it: `tsc` cannot, the plan
   * was right about the value it was handed, and the select was right about the
   * options it had.
   */
  const OFFERED = ["5m", "15m", "1h", "4h", "1d"] as const;

  it("passes through a size that really is offered", () => {
    for (const t of OFFERED) expect(nearestTimeframe(t, OFFERED)).toBe(t);
  });

  it("maps 3m to the nearest offered size rather than showing a lie", () => {
    expect(nearestTimeframe("3m", OFFERED)).toBe("5m");
  });

  it("chooses by duration, not by string order", () => {
    // 45m is nearer 1h than 15m in minutes; alphabetically it is nowhere.
    expect(nearestTimeframe("45m", OFFERED)).toBe("1h");
    expect(nearestTimeframe("2h", OFFERED)).toBe("1h");
    expect(nearestTimeframe("1w", OFFERED)).toBe("1d");
    expect(nearestTimeframe("1m", OFFERED)).toBe("5m");
  });

  it("falls back to the first offered size when the input means nothing", () => {
    expect(nearestTimeframe("", OFFERED)).toBe("5m");
    expect(nearestTimeframe("banana", OFFERED)).toBe("5m");
  });
});

describe("a refused plan says its reason ONCE", () => {
  /*
   * MEASURED on the running build, from a screenshot: the desk printed
   *
   *     the archive holds no XAUUSD 15m to run on
   *     the archive holds no XAUUSD 15m to run on
   *
   * because `planLine` returns `why` for a refused plan and the desk rendered
   * `planLine(plan())` above `plan().why`. Both bindings were correct on their
   * own; together they said the same sentence twice, which reads as a bug in
   * the thing being described rather than in the thing describing it.
   *
   * The FACT is here rather than in the desk, because a second caller would
   * make the same mistake for the same reason.
   */
  it("returns the reason as its whole line when refused", () => {
    const p = planRun(
      { symbol: "XAUUSD", timeframe: "15m", fromYear: 2022, toYear: 2026, balance: 500, riskPct: 1 },
      null,
    );
    expect(p.ok).toBe(false);
    expect(planLine(p)).toBe(p.why);
  });

  it("returns a DIFFERENT line from its caveat when it runs", () => {
    const held: Holding = { oldest: Date.UTC(2024, 0, 1), newest: Date.UTC(2026, 8, 24), bars: 9000 };
    const p = planRun(
      { symbol: "BTCUSDT", timeframe: "1h", fromYear: 2022, toYear: 2026, balance: 500, riskPct: 1 },
      held,
    );
    expect(p.ok).toBe(true);
    expect(p.why).not.toBe("");
    // The headline names the run; `why` qualifies it. Showing both is right
    // HERE and only here.
    expect(planLine(p)).not.toBe(p.why);
    expect(planLine(p)).toContain("BTCUSDT 1h");
  });
});

/**
 * LOADING FOR A PLAN — and the defect that made the first run of any market lie.
 *
 * MEASURED on the running build, three consecutive runs with IDENTICAL inputs
 * on ETHUSDT 4h over 2022–2026:
 *
 *     run 1  ->  156 trades
 *     run 2  ->  480 trades
 *     run 3  ->  480 trades
 *
 * The desk loaded the archive, saw it was short, backfilled — and then ran the
 * backtest on the bars it had loaded BEFORE the backfill, because `backfill`
 * returns a COUNT and writes to the archive rather than returning the series.
 * `hist` was captured before and used after. So the first run of any market
 * reported a result computed on whatever happened to be cached, and the second
 * reported a different one. On a market holding four days against a four-year
 * request there were too few bars to produce a single trade, which is what
 * "the backtest is broken, always 0" looks like.
 *
 * The count is the thing nobody could have checked: a backtest that runs and
 * reports fewer trades is indistinguishable from a strategy that traded less.
 */
describe("loading the bars a plan asked for", () => {
  const plan = (want: number) =>
    planRun(
      { symbol: "ETHUSDT", timeframe: "4h", fromYear: 2022, toYear: 2026, balance: 500, riskPct: 1 },
      { oldest: Date.UTC(2025, 4, 12), newest: Date.UTC(2026, 8, 24), bars: want },
    );

  /** A history service whose archive GROWS when it is backfilled, as the real one does. */
  function fakeHistory(start: number, addOnBackfill: number) {
    let held = start;
    const calls: string[] = [];
    const svc = {
      async load(_s: string, _t: string, opts?: { limit?: number }) {
        calls.push(`load:${opts?.limit ?? 0}`);
        return {
          bars: Array.from({ length: Math.min(held, opts?.limit ?? held) }, (_, i) => ({
            t: i * 3600_000, o: 1, h: 1, l: 1, c: 1, v: 1,
          })),
          source: "binance",
          containsDemo: false,
        };
      },
      async backfill(_s: string, _t: string, _target: number) {
        calls.push("backfill");
        held += addOnBackfill;
        return addOnBackfill;
      },
    } as unknown as HistoryService;
    return { svc, calls, held: () => held };
  }

  it("RE-LOADS after a backfill, so the run sees what was just fetched", async () => {
    const p = plan(3000);
    const { svc, calls } = fakeHistory(1000, 9000);
    const got = await loadForPlan(svc, p);

    expect(calls).toEqual([`load:${p.wantBars}`, "backfill", `load:${p.wantBars}`]);
    // The whole defect: without the second load this was 1,000.
    expect(got.bars.length).toBeGreaterThan(1000);
    expect(got.bars.length).toBe(Math.min(10000, p.wantBars));
  });

  it("does not backfill when the archive already answers the plan", async () => {
    const p = plan(3000);
    const { svc, calls } = fakeHistory(p.wantBars, 5000);
    const got = await loadForPlan(svc, p);
    expect(calls).toEqual([`load:${p.wantBars}`]);
    expect(got.bars.length).toBe(p.wantBars);
  });

  it("reports the bars it ACTUALLY got, not the bars that were asked for", async () => {
    // A vendor with nothing older to give. The run is still worth doing — it
    // must just not claim the window it wanted.
    const p = plan(3000);
    const { svc } = fakeHistory(1200, 0);
    const got = await loadForPlan(svc, p);
    expect(got.bars.length).toBe(1200);
    expect(got.short).toBe(true);
    expect(got.why).toContain("1,200");
    expect(got.why).toContain(p.wantBars.toLocaleString());
  });

  it("says nothing when it got what it asked for", async () => {
    const p = plan(3000);
    const { svc } = fakeHistory(p.wantBars, 0);
    const got = await loadForPlan(svc, p);
    expect(got.short).toBe(false);
    expect(got.why).toBe("");
  });

  it("backfills once, not until it gives up", async () => {
    // A vendor that keeps refusing must not be asked in a loop: a desk that
    // hangs is worse than one that says it could only get so far.
    const p = plan(3000);
    const { svc, calls } = fakeHistory(500, 0);
    await loadForPlan(svc, p);
    expect(calls.filter((c) => c === "backfill")).toHaveLength(1);
  });
});

/**
 * WHAT A FETCH COULD FIX, AS A FIELD RATHER THAN A SENTENCE.
 *
 * The owner's report, with a screenshot: the Playbook said "the archive holds no
 * EURUSD 15m to run on" and offered nothing to do about it. Holding nothing is
 * not a dead end — `history.backfill` reaches for a series the archive has never
 * seen — so the refusal now carries what a fetch would have to bring in.
 *
 * `missing` is a DESCRIPTOR, not a `why` to grep. Three refusals reach the same
 * screen and only one of them can be fixed by downloading; the others differ
 * from it in English alone. A card that matched on the sentence would be one
 * word away from offering a download that cannot work, and the two tests that
 * matter here are the ones asserting `missing === null` on those.
 */
describe("a refusal says whether fetching would help", () => {
  it("offers the fetch when the archive holds nothing of the series", () => {
    const p = planRun(req({ symbol: "EURUSD", timeframe: "15m" }), null);
    expect(p.ok).toBe(false);
    expect(p.missing).not.toBeNull();
    expect(p.missing?.symbol).toBe("EURUSD");
    expect(p.missing?.timeframe).toBe("15m");
    expect(p.missing?.wantBars).toBeGreaterThan(0);
  });

  it("asks for the depth the RUN would need, not a constant", () => {
    // The `WANTED_BARS = 1500` defect, from the other side: a fetch that asked
    // for a fixed number would finish and leave the plan still short. 1h is used
    // rather than 15m because four years of 15m is ~140,000 bars and the CAP
    // binds first — which the next test pins deliberately.
    const oneYear = planRun(req({ symbol: "EURUSD", timeframe: "1h", fromYear: 2025, toYear: 2025 }), null);
    const fourYears = planRun(req({ symbol: "EURUSD", timeframe: "1h", fromYear: 2022, toYear: 2025 }), null);
    expect(fourYears.missing!.wantBars).toBeGreaterThan(oneYear.missing!.wantBars * 3);
  });

  it("is bound by the same cap the run is, so a fetch cannot be asked for more than can be studied", () => {
    // FOUND BY THIS TEST FAILING. My first version asserted unbounded growth on
    // four years of 15m; the answer was 60,000 because `MAX_STUDY_BARS` had
    // already bound it — correct, and the more valuable thing to state. A fetch
    // that reached past the cap would download bars no run could ever use.
    const huge = planRun(req({ symbol: "EURUSD", timeframe: "15m", fromYear: 2010, toYear: 2026 }), null);
    expect(huge.missing!.wantBars).toBe(MAX_STUDY_BARS);
  });

  it("scales with the bar size as well as the span", () => {
    const m15 = planRun(req({ symbol: "EURUSD", timeframe: "15m", fromYear: 2025, toYear: 2025 }), null);
    const d1 = planRun(req({ symbol: "EURUSD", timeframe: "1d", fromYear: 2025, toYear: 2025 }), null);
    expect(m15.missing!.wantBars).toBeGreaterThan(d1.missing!.wantBars * 50);
  });

  it("does NOT offer a fetch for a window that ends before the data begins", () => {
    // Backfill reaches BACK from what is held; it cannot invent a year the
    // venue never listed. Offering a download here would spin and find nothing.
    const p = planRun(req({ fromYear: 2010, toYear: 2015 }), BTC_1H);
    expect(p.ok).toBe(false);
    expect(p.missing).toBeNull();
  });

  it("does NOT offer a fetch when the request is simply invalid", () => {
    const backwards = planRun(req({ fromYear: 2026, toYear: 2022 }), BTC_1H);
    expect(backwards.ok).toBe(false);
    expect(backwards.missing).toBeNull();
  });

  it("a plan that runs has nothing missing", () => {
    const p = planRun(req({ fromYear: 2023, toYear: 2025 }), BTC_1H);
    expect(p.ok).toBe(true);
    expect(p.missing).toBeNull();
  });
});
