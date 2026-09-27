import { describe, it, expect } from "vitest";
import {
  createWatchLoop,
  DEFAULT_NOTIFY_RULE,
  lastBarClose,
  nextBarClose,
  nextScanAt,
  notifiable,
  parseWatchPrefs,
  qualifies,
  ruleText,
  toastText,
  type NewSetup,
  type WatchClock,
  type WatchState,
} from "../src/scan/watch";
import type { Opportunity } from "../src/scan/opportunity";

const MIN = 60_000;
const HOUR = 3_600_000;
/** 2026-09-19 14:00:00 UTC, a Saturday. */
const T14 = Date.UTC(2026, 8, 19, 14, 0, 0);

const opp = (over: Partial<Opportunity> & { adverse?: boolean }): Opportunity => ({
  kind: "order-block",
  label: "order block",
  direction: "long",
  reason: "",
  score: 0.6,
  grounded: 1,
  barsAgo: 0,
  entry: 100,
  entryLow: 99,
  entryHigh: 101,
  stop: 98,
  target1: 104,
  target2: 106,
  rMultiple: 2,
  riskPct: 0.02,
  stopFrom: "structure",
  history: {
    n: 30,
    hitRate: 0.5,
    hitLow: 0.33,
    expectancy: 0.2,
    enough: true,
    adverse: over.adverse ?? false,
    note: "",
  },
  edge: 0.02,
  ...over,
});

describe("bar clock", () => {
  it("aligns minutes, hours and days to UTC epoch boundaries", () => {
    expect(lastBarClose("1h", T14 + 25 * MIN)).toBe(T14);
    expect(nextBarClose("1h", T14 + 25 * MIN)).toBe(T14 + HOUR);
    /* Exactly on a boundary: that boundary has closed, the next one has not. */
    expect(lastBarClose("1h", T14)).toBe(T14);
    expect(nextBarClose("1h", T14)).toBe(T14 + HOUR);
    expect(nextBarClose("15m", T14 + 7 * MIN)).toBe(T14 + 15 * MIN);
    expect(nextBarClose("4h", T14 + MIN)).toBe(Date.UTC(2026, 8, 19, 16));
    expect(nextBarClose("1d", T14)).toBe(Date.UTC(2026, 8, 20));
  });

  it("closes weekly bars on Monday 00:00 UTC, not on the epoch's Thursday", () => {
    expect(nextBarClose("1w", T14)).toBe(Date.UTC(2026, 8, 21));
    expect(lastBarClose("1w", T14)).toBe(Date.UTC(2026, 8, 14));
  });

  it("closes monthly bars on the calendar, not on an average month", () => {
    expect(nextBarClose("1M", T14)).toBe(Date.UTC(2026, 9, 1));
    expect(lastBarClose("1M", T14)).toBe(Date.UTC(2026, 8, 1));
  });

  it("refuses a timeframe it cannot put on a clock", () => {
    expect(nextBarClose("tick", T14)).toBeNull();
    expect(lastBarClose("0h", T14)).toBeNull();
  });
});

describe("nextScanAt", () => {
  const D = 20_000;

  it("scans at once when the last closed bar has not been scanned", () => {
    expect(nextScanAt("1h", T14 + 30 * MIN, D, null)).toEqual({ at: T14 + 30 * MIN, close: T14 });
  });

  it("waits for the next close plus the delay once this bar is done", () => {
    expect(nextScanAt("1h", T14 + 30 * MIN, D, T14)).toEqual({ at: T14 + HOUR + D, close: T14 + HOUR });
  });

  it("does not count a bar as closed until the delay has passed", () => {
    /* 10s after 15:00 the vendor may not have the 14:00 candle yet. */
    expect(nextScanAt("1h", T14 + HOUR + 10_000, D, T14)).toEqual({ at: T14 + HOUR + D, close: T14 + HOUR });
    expect(nextScanAt("1h", T14 + HOUR + D, D, T14)).toEqual({ at: T14 + HOUR + D, close: T14 + HOUR });
  });

  it("returns null for a timeframe without a bar clock", () => {
    expect(nextScanAt("tick", T14, D, null)).toBeNull();
  });
});

describe("which setups notify", () => {
  it("default rule: not adverse, confirmed within the last 3 closed bars", () => {
    expect(qualifies(opp({ barsAgo: 0 }), DEFAULT_NOTIFY_RULE)).toBe(true);
    expect(qualifies(opp({ barsAgo: 2 }), DEFAULT_NOTIFY_RULE)).toBe(true);
    expect(qualifies(opp({ barsAgo: 3 }), DEFAULT_NOTIFY_RULE)).toBe(false);
    expect(qualifies(opp({ adverse: true }), DEFAULT_NOTIFY_RULE)).toBe(false);
    /* A thin replay is not adverse, so the default lets it through. */
    expect(qualifies(opp({ edge: null }), DEFAULT_NOTIFY_RULE)).toBe(true);
  });

  it("requireEdge demands a measured edge above break-even", () => {
    const rule = { withinBars: 3, requireEdge: true };
    expect(qualifies(opp({ edge: 0.02 }), rule)).toBe(true);
    expect(qualifies(opp({ edge: 0 }), rule)).toBe(false);
    expect(qualifies(opp({ edge: null }), rule)).toBe(false);
  });

  it("states the rule in one line", () => {
    expect(ruleText(DEFAULT_NOTIFY_RULE)).toBe(
      "Notifies for new setups that are not historically adverse and were confirmed within the last 3 closed bars.",
    );
    expect(ruleText({ withinBars: 1, requireEdge: true })).toBe(
      "Notifies for new setups that are not historically adverse, were confirmed on the last closed bar, and have a measured edge above break-even.",
    );
  });

  it("keeps the qualifying ones, best first", () => {
    const list: NewSetup[] = [
      { symbol: "AAAUSDT", opportunity: opp({ score: 0.5 }) },
      { symbol: "BBBUSDT", opportunity: opp({ score: 0.9 }) },
      { symbol: "CCCUSDT", opportunity: opp({ barsAgo: 7 }) },
    ];
    expect(notifiable(list, DEFAULT_NOTIFY_RULE).map((s) => s.symbol)).toEqual(["BBBUSDT", "AAAUSDT"]);
  });
});

describe("toastText", () => {
  it("names up to three, then counts the rest", () => {
    const list: NewSetup[] = [
      { symbol: "SOLUSDT", opportunity: opp({}) },
      { symbol: "ETHUSDT", opportunity: opp({ direction: "short", label: "fair value gap" }) },
      { symbol: "BTCUSDT", opportunity: opp({ label: "break of structure" }) },
      { symbol: "XRPUSDT", opportunity: opp({}) },
      { symbol: "ADAUSDT", opportunity: opp({}) },
    ];
    expect(toastText("1h", list)).toEqual({
      title: "5 new setups on 1h",
      body: "SOLUSDT long · order block, ETHUSDT short · fair value gap, BTCUSDT long · break of structure, +2 more",
    });
  });

  it("uses the singular for one", () => {
    expect(toastText("15m", [{ symbol: "SOLUSDT", opportunity: opp({}) }])).toEqual({
      title: "1 new setup on 15m",
      body: "SOLUSDT long · order block",
    });
  });
});

describe("parseWatchPrefs", () => {
  it("accepts a well-formed record and refuses anything else", () => {
    expect(parseWatchPrefs({ on: true, withinBars: 5, requireEdge: false })).toEqual({
      on: true,
      withinBars: 5,
      requireEdge: false,
    });
    expect(parseWatchPrefs({ on: "yes", withinBars: 3, requireEdge: false })).toBeNull();
    expect(parseWatchPrefs({ on: true, withinBars: 0, requireEdge: false })).toBeNull();
    expect(parseWatchPrefs(null)).toBeNull();
  });
});

/* ---- the loop, on a fake clock --------------------------------------------- */

function fakeClock(start: number): WatchClock & {
  t: number;
  isHidden: boolean;
  pending(): number[];
  advanceTo(t: number): Promise<void>;
} {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    t: start,
    isHidden: false,
    now: () => clock.t,
    hidden: () => clock.isHidden,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: clock.t + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number);
    },
    pending: () => [...timers.values()].map((x) => x.at).sort((a, b) => a - b),
    async advanceTo(t: number): Promise<void> {
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock.t = due[1].at;
        due[1].fn();
        /* Let the scan's promise settle before the next timer. */
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      clock.t = t;
    },
  };
  return clock;
}

function harness(start: number, tf = "1h") {
  const clock = fakeClock(start);
  const scans: number[] = [];
  const states: WatchState[] = [];
  let aborted = 0;
  let timeframe = tf;
  const loop = createWatchLoop({
    clock,
    delayMs: 20_000,
    timeframe: () => timeframe,
    scan: async () => {
      scans.push(clock.t);
    },
    abort: () => {
      aborted++;
    },
    onState: (s) => states.push(s),
  });
  return {
    clock,
    loop,
    scans,
    states,
    aborted: () => aborted,
    setTf: (next: string) => {
      timeframe = next;
    },
  };
}

describe("createWatchLoop", () => {
  it("scans once on enable, then once per closed bar at close + 20s", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: true });
    await w.clock.advanceTo(T14 + 30 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN]);
    expect(w.loop.state().nextAt).toBe(T14 + HOUR + 20_000);

    await w.clock.advanceTo(T14 + 3 * HOUR + 5 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN, T14 + HOUR + 20_000, T14 + 2 * HOUR + 20_000, T14 + 3 * HOUR + 20_000]);
  });

  it("a restore at boot waits the delay instead of scanning into the chart's own load", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: false });
    expect(w.loop.state().nextAt).toBe(T14 + 30 * MIN + 20_000);
    await w.clock.advanceTo(T14 + 31 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN + 20_000]);
  });

  it("pauses while hidden and scans once on return, only if a bar closed meanwhile", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: true });
    await w.clock.advanceTo(T14 + 30 * MIN);

    w.clock.isHidden = true;
    w.loop.visibility();
    expect(w.loop.state().phase).toBe("paused");
    expect(w.clock.pending()).toEqual([]);

    await w.clock.advanceTo(T14 + 3 * HOUR + 10 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN]);

    w.clock.isHidden = false;
    w.loop.visibility();
    await w.clock.advanceTo(T14 + 3 * HOUR + 10 * MIN);
    /* ONE catch-up scan, not three. */
    expect(w.scans).toEqual([T14 + 30 * MIN, T14 + 3 * HOUR + 10 * MIN]);
    expect(w.loop.state().nextAt).toBe(T14 + 4 * HOUR + 20_000);
  });

  it("a hide and return inside the same bar does not scan again", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: true });
    await w.clock.advanceTo(T14 + 30 * MIN);
    w.clock.isHidden = true;
    w.loop.visibility();
    await w.clock.advanceTo(T14 + 40 * MIN);
    w.clock.isHidden = false;
    w.loop.visibility();
    await w.clock.advanceTo(T14 + 50 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN]);
  });

  it("stop clears the timer, aborts the scan and reports off", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: true });
    await w.clock.advanceTo(T14 + 30 * MIN);
    w.loop.stop();
    expect(w.clock.pending()).toEqual([]);
    expect(w.aborted()).toBe(1);
    expect(w.loop.state()).toEqual({ on: false, phase: "off", nextAt: null, reason: "" });
    await w.clock.advanceTo(T14 + 5 * HOUR);
    expect(w.scans).toEqual([T14 + 30 * MIN]);
  });

  it("a timeframe change reschedules on the new clock, no sooner than the delay", async () => {
    const w = harness(T14 + 30 * MIN);
    w.loop.start({ immediate: true });
    await w.clock.advanceTo(T14 + 30 * MIN);
    w.setTf("15m");
    w.loop.retime();
    /* 15m's last close (14:30) is unscanned, so it is due - but not before 20s. */
    expect(w.loop.state().nextAt).toBe(T14 + 30 * MIN + 20_000);
    await w.clock.advanceTo(T14 + 46 * MIN);
    expect(w.scans).toEqual([T14 + 30 * MIN, T14 + 30 * MIN + 20_000, T14 + 45 * MIN + 20_000]);
  });

  it("refuses a timeframe with no bar clock and says so", () => {
    const w = harness(T14, "tick");
    w.loop.start({ immediate: true });
    expect(w.loop.state().phase).toBe("refused");
    expect(w.loop.state().reason).toBe('"tick" has no bar clock to align a scan to.');
    expect(w.clock.pending()).toEqual([]);
  });

  it("records a failed scan's reason and still waits for the next bar", async () => {
    const clock = fakeClock(T14 + 30 * MIN);
    const scans: number[] = [];
    const loop = createWatchLoop({
      clock,
      delayMs: 20_000,
      timeframe: () => "1h",
      scan: async () => {
        scans.push(clock.t);
        throw new Error("the exchange is not answering");
      },
      abort: () => undefined,
      onState: () => undefined,
    });
    loop.start({ immediate: true });
    await clock.advanceTo(T14 + 30 * MIN);
    expect(loop.state()).toEqual({
      on: true,
      phase: "waiting",
      nextAt: T14 + HOUR + 20_000,
      reason: "Last scan failed: the exchange is not answering",
    });
    await clock.advanceTo(T14 + 50 * MIN);
    expect(scans).toEqual([T14 + 30 * MIN]);
  });
});
