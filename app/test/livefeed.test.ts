/**
 * The Live panel's pure parts.
 *
 * The rendering is checked in the browser; these are the three things that are
 * worth pinning with literals — how a number reads, what the status bar gets,
 * and whether every event kind has a name at all.
 */

import { describe, it, expect } from "vitest";
import { KIND_LABEL, feedSummary, latestLine, latestTitle, newest, valueText } from "../src/ui/livefeed";
import type { LiveEvent, LiveEventKind, LiveSeverity } from "../src/analysis/live";

/** The terminal's own price formatter, stubbed to something assertable. */
const price = (v: number): string => v.toFixed(2);

const event = (over: Partial<LiveEvent> = {}): LiveEvent => ({
  id: "gates-cleared#1",
  time: Date.UTC(2026, 8, 19, 14, 0, 0),
  symbol: "BTCUSDT",
  timeframe: "1m",
  kind: "gates-cleared",
  severity: "act",
  what: "Your gates clear.",
  because: "7 of 7 gates pass and none blocks.",
  values: [],
  barTime: null,
  ...over,
});

describe("KIND_LABEL", () => {
  /**
   * EVERY KIND, OR THE STATUS BAR PRINTS `undefined`.
   *
   * The record is typed `Record<LiveEventKind, string>` so a new kind is a
   * compile error — but only if someone adds it to the union, and the union is
   * in another file. This asserts the runtime object as well, because a label
   * is what the operator actually reads.
   */
  const KINDS: readonly LiveEventKind[] = [
    "structure-break",
    "setup-appeared",
    "setup-expired",
    "setup-flipped",
    "gates-cleared",
    "gates-blocked",
    "entry-zone",
    "stop-approach",
    "target-approach",
    "volatility-shift",
    "outlier-bar",
    "volume-spike",
    "regime-change",
    "session-open",
    "session-close",
    "feed-degraded",
    "feed-recovered",
  ];

  it("names every kind, in words that stand alone", () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...KINDS].sort());
    for (const k of KINDS) {
      const label = KIND_LABEL[k];
      expect(label.length, k).toBeGreaterThan(3);
      /* It has to read as something that HAPPENED, not as a topic. A label
         that is one word long is almost always the topic. */
      expect(label.includes(" "), k).toBe(true);
    }
  });

  it("fits the status bar: nothing over twenty characters", () => {
    for (const k of KINDS) expect(KIND_LABEL[k].length, k).toBeLessThanOrEqual(20);
  });
});

describe("valueText", () => {
  it("renders each unit the way that unit is read", () => {
    expect(valueText({ label: "Stop", value: 1234.5678, unit: "price" }, price)).toBe("1234.57");
    expect(valueText({ label: "Move", value: -1.234, unit: "percent" }, price)).toBe("-1.23%");
    expect(valueText({ label: "Multiple", value: 4.26, unit: "multiple" }, price)).toBe("4.3x");
    expect(valueText({ label: "Standardised", value: 3.44, unit: "sigma" }, price)).toBe("3.4 sigma");
    expect(valueText({ label: "Distance", value: 0.25, unit: "r" }, price)).toBe("0.25R");
    expect(valueText({ label: "Percentile", value: 0.83, unit: "percentile" }, price)).toBe("83th");
    expect(valueText({ label: "Gates", value: 7, unit: "count" }, price)).toBe("7");
  });

  /**
   * VOLUME IS NOT A COUNT, AND THE COUNT RENDERER LOSES IT.
   *
   * MEASURED live on BTCUSDT 1m: a spike bar traded 10.21716 BTC against a
   * 50-bar median of 2.645215 — a 3.9x multiple, printed by the count renderer
   * as "10" over "3". Significant figures, because one instrument trades ten of
   * itself a minute and another trades four million.
   */
  it("keeps a traded amount's precision instead of rounding it to a count", () => {
    expect(valueText({ label: "Volume", value: 10.21716, unit: "quantity" }, price)).toBe(
      (10.22).toLocaleString(undefined, { maximumSignificantDigits: 4 }),
    );
    expect(valueText({ label: "Median", value: 2.645215, unit: "quantity" }, price)).not.toBe("3");
    expect(valueText({ label: "Median", value: 2.645215, unit: "quantity" }, price)).toContain("2.645");
  });

  /* A tick age of 214s reads as 214s and one of 40 minutes reads as 40 minutes.
     Seconds past two minutes is a number nobody converts in their head. */
  it("switches seconds to minutes past two minutes", () => {
    expect(valueText({ label: "Tick age", value: 119, unit: "seconds" }, price)).toBe("119s");
    expect(valueText({ label: "Tick age", value: 400, unit: "seconds" }, price)).toBe("6.7m");
  });

  /**
   * A NUMBER THAT IS NOT A NUMBER IS AN EM DASH, NEVER A ZERO.
   *
   * `tickAgeMs` is `Infinity` on an offline feed, and "0s" is the freshest
   * possible reading — the exact opposite of not knowing. The Series panel
   * makes the same substitution for the same reason.
   */
  it("refuses to print a non-finite value as a number", () => {
    expect(valueText({ label: "Tick age", value: Infinity, unit: "seconds" }, price)).toBe("—");
    expect(valueText({ label: "Stop", value: NaN, unit: "price" }, price)).toBe("—");
  });

  it("uses the terminal's price formatter rather than its own decimals", () => {
    /* One instrument is quoted at 4,336.56 and another at 1.08423, so the panel
       must not pick a decimal count of its own. */
    const seen: number[] = [];
    valueText({ label: "Entry", value: 1.08423, unit: "price" }, (v) => {
      seen.push(v);
      return "formatted";
    });
    expect(seen).toEqual([1.08423]);
  });
});

describe("latestLine and latestTitle", () => {
  it("gives the bar the kind and nothing else", () => {
    expect(latestLine(event({ kind: "stop-approach" }))).toBe(KIND_LABEL["stop-approach"]);
  });

  /* Empty, not "—": the live bar's own honesty contract renders an uncovered
     field as a named gap, and a dash here would be a second one. */
  it("returns an empty string when there is no event", () => {
    expect(latestLine(null)).toBe("");
  });

  it("puts the whole sentence and its measurement in the tooltip", () => {
    const e = event({ what: "Price is at the plan's stop.", because: "0.20R from the stop at 97." });
    expect(latestTitle(e)).toBe("Price is at the plan's stop. 0.20R from the stop at 97.");
    expect(latestTitle(null)).toMatch(/no events/i);
  });
});

describe("feedSummary", () => {
  const withSeverity = (list: readonly LiveSeverity[]): LiveEvent[] =>
    list.map((severity, i) => event({ id: `e${i}`, severity }));

  it("says nothing is there when nothing is", () => {
    expect(feedSummary([])).toBe("Nothing yet");
  });

  it("counts the events, and singular is singular", () => {
    expect(feedSummary(withSeverity(["info"]))).toBe("1 event");
    expect(feedSummary(withSeverity(["info", "watch"]))).toBe("2 events");
  });

  /**
   * The count of `act` rows is the half worth having — it is the only number
   * in the line that says whether to read the list NOW.
   */
  it("names how many are asking for a decision", () => {
    expect(feedSummary(withSeverity(["act", "info", "act"]))).toBe("3 events · 2 need a decision");
  });

  /* Derived from the argument and nothing else — no DOM measurement that can
     go stale behind it. The dock's "screens of scroll" was wrong by 2.8x for
     exactly that. */
  it("takes one argument, so it cannot report a stale measurement", () => {
    expect(feedSummary.length).toBe(1);
  });
});

describe("newest", () => {
  it("reads the front of the list, because the log is newest-first", () => {
    const a = event({ id: "a" });
    const b = event({ id: "b" });
    expect(newest([a, b])?.id).toBe("a");
    expect(newest([])).toBeNull();
  });
});
