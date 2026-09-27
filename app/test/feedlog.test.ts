/**
 * The network log and the poller.
 *
 * These two exist because of one measured fault: MT5 and both proxy sources
 * return `null` from `streamUrl`, `startLive` treated that as "no updates", and
 * every forex, metals and equity chart therefore loaded once and aged for ever.
 * The badge said "STALE — no update for 218s" on a broker feed that was healthy
 * and one 28ms HTTP request away.
 */

import { describe, expect, it } from "vitest";
import { createFeedLog, summarise, type FeedEvent } from "../src/data/feedlog";
import { pollIntervalMs } from "../src/data/feed";
import { age, offsetLabel } from "../src/ui/feedmon";

const ev = (
  over: Partial<FeedEvent> = {},
): Omit<FeedEvent, "seq" | "at"> & { at?: number } => ({
  kind: "attempt",
  source: "binance",
  symbol: "BTCUSDT",
  timeframe: "1m",
  text: "800 bars",
  ok: true,
  ...over,
});

describe("the feed log", () => {
  it("puts the newest event first, because that is the end you read", () => {
    const log = createFeedLog();
    log.record(ev({ text: "first" }));
    log.record(ev({ text: "second" }));
    expect(log.events()[0]?.text).toBe("second");
  });

  /* A log appended to several times a second on a live socket is a leak unless
     it is bounded. The ring drops the OLDEST, never the newest. */
  it("is bounded, and drops from the old end", () => {
    const log = createFeedLog(3);
    for (const t of ["a", "b", "c", "d"]) log.record(ev({ text: t }));
    expect(log.events().map((e) => e.text)).toEqual(["d", "c", "b"]);
    expect(log.events().length).toBe(3);
  });

  /* The ring forgets; the counter does not. "500 events, 12 shown" is a
     different statement from "12 events happened". */
  it("keeps counting past what it keeps", () => {
    const log = createFeedLog(2);
    for (let i = 0; i < 10; i += 1) log.record(ev());
    expect(log.total()).toBe(10);
    expect(log.events().length).toBe(2);
  });

  it("never gives a blank source, which would leave a column empty", () => {
    const log = createFeedLog();
    log.record(ev({ source: "" }));
    expect(log.events()[0]?.source).toBe("—");
  });
});

describe("summarise", () => {
  const log = createFeedLog();

  it("counts only attempts, so a poll storm does not drown the failover story", () => {
    log.clear();
    log.record(ev({ kind: "attempt", source: "mt5", ms: 70 }));
    log.record(ev({ kind: "poll", source: "mt5", ms: 20 }));
    log.record(ev({ kind: "poll", source: "mt5", ms: 25 }));
    const [s] = summarise(log.events());
    expect(s?.attempts).toBe(1);
  });

  it("averages latency over successes only", () => {
    log.clear();
    log.record(ev({ source: "mt5", ms: 100 }));
    log.record(ev({ source: "mt5", ms: 8000, ok: false, text: "timeout" }));
    const [s] = summarise(log.events());
    expect(s?.avgMs).toBe(100);
    expect(s?.failed).toBe(1);
  });

  /**
   * A source that failed and then recovered must not still be DESCRIBED by its
   * failure. The panel prints `lastNote` beside the source name, so getting
   * this backwards leaves "ECONNREFUSED" under a source that is serving.
   */
  it("describes a source by its latest attempt, not its worst", () => {
    log.clear();
    log.record(ev({ source: "mt5", ok: false, text: "ECONNREFUSED", at: 1_000 }));
    log.record(ev({ source: "mt5", ok: true, text: "800 bars", at: 2_000 }));
    const [s] = summarise(log.events());
    expect(s?.lastNote).toBe("800 bars");
    expect(s?.failed).toBe(1); // the failure is still counted
  });

  it("reports NaN rather than zero when nothing succeeded", () => {
    log.clear();
    log.record(ev({ source: "okx", ok: false, text: "502" }));
    const [s] = summarise(log.events());
    /* 0ms would read as "instant", which is the opposite of what happened. */
    expect(Number.isNaN(s?.avgMs)).toBe(true);
  });
});

describe("the poll cadence", () => {
  /* A local bridge answering in 28ms can be asked every five seconds. */
  it("gives a fast chart several looks inside each bar", () => {
    expect(pollIntervalMs(60_000, "live")).toBe(5_000);
    expect(pollIntervalMs(180_000, "live")).toBe(15_000);
  });

  /**
   * THE CEILING IS THE POINT, on anything above a twelve-minute bar. A twelfth
   * of a 1h bar is five minutes, and a "last price" five minutes old is not one
   * to size a position from — it is the same price on a daily chart as on a
   * one-minute chart.
   */
  it("never lets a live price go more than a minute unrefreshed", () => {
    expect(pollIntervalMs(3_600_000, "live")).toBe(60_000);
    expect(pollIntervalMs(86_400_000, "live")).toBe(60_000);
  });

  /* A delayed vendor publishes on its own schedule; asking faster buys load. */
  it("backs a long way off a delayed vendor", () => {
    expect(pollIntervalMs(60_000, "delayed")).toBe(30_000);
    expect(pollIntervalMs(86_400_000, "delayed")).toBe(300_000);
  });

  /* A span of 0 and a span of NaN are the same fact — "we could not measure the
     bar" — and both take the same 15s default rather than one of them falling
     through the comparison into the floor. */
  it("still returns something usable for an unmeasurable span", () => {
    expect(pollIntervalMs(0, "live")).toBe(15_000);
    expect(pollIntervalMs(Number.NaN, "live")).toBe(15_000);
    expect(pollIntervalMs(-1, "live")).toBe(15_000);
  });
});

describe("the clock label", () => {
  /**
   * `null` and `0` MUST NOT render the same. Zero is the claim "this broker
   * stamps in UTC"; null is the absence of a claim. Collapsing the two is the
   * shape of the bug this whole panel came from — a silent, confident,
   * three-hour-wrong timestamp.
   */
  it("distinguishes an unmeasured clock from a UTC one", () => {
    expect(offsetLabel(null)).toBe("not measured");
    expect(offsetLabel(0)).toBe("UTC");
  });

  it("reads the measured broker offset the way a venue states it", () => {
    expect(offsetLabel(10_800_000)).toBe("UTC+3");
    expect(offsetLabel(-14_400_000)).toBe("UTC-4");
    expect(offsetLabel(20_700_000)).toBe("UTC+5:45");
  });
});

describe("age", () => {
  it("stays readable across the ranges a stalled feed passes through", () => {
    expect(age(4_000)).toBe("4s");
    expect(age(130_000)).toBe("2m 10s");
    expect(age(3_840_000)).toBe("1h 04m");
  });

  it("refuses to render a number it does not have", () => {
    expect(age(Number.POSITIVE_INFINITY)).toBe("—");
    expect(age(Number.NaN)).toBe("—");
  });
});
