/**
 * The data library's table: finding, ordering, grouping, and bulk delete.
 *
 * These four were closures inside `ui/data.ts` until the redesign, which meant
 * the only way to check any of them was to look at the table — the same
 * condition under which the "Used by" column sat at 560px wide for two
 * releases without anyone being able to say so from a test.
 *
 * What is pinned here:
 *  1. A BAR-SIZE ORDER NOBODY HOLDS IN THEIR HEAD IS NOT AN ORDER. Sorting
 *     timeframes alphabetically gives 15m, 1d, 1h, 4h, 5m.
 *  2. A GROUP'S TOTAL IS THE WHOLE POINT OF THE GROUP. It answers "how much
 *     BTC do I hold", which the flat table could only answer by addition.
 *  3. A BULK DELETE MUST HONOUR THE PIN, and must hand back what it skipped
 *     rather than a count, because the caller has to name it on screen.
 *  4. A FILTER THAT MATCHES NOTHING IS NOT AN EMPTY LIBRARY.
 */

import { describe, expect, it } from "vitest";
import {
  coverageLanes,
  deletable,
  defaultOpenGroups,
  filterSeries,
  groupBySymbol,
} from "../src/ui/research/library";
import type { SeriesInventory } from "../src/store/barstore";

const inv = (
  symbol: string,
  timeframe: string,
  over: Partial<SeriesInventory> = {},
): SeriesInventory => ({
  key: `binance|${symbol}|${timeframe}`,
  source: "binance",
  symbol,
  timeframe,
  segments: 1,
  bars: 1000,
  approxBytes: 48_000,
  oldest: 0,
  newest: 1_000_000,
  qualities: ["live"],
  lastFetched: 1_000_000,
  ...over,
});

/* One market at four bar sizes, scattered — the state the owner photographed. */
const LIBRARY: readonly SeriesInventory[] = [
  inv("BTCUSDT", "1d", { bars: 400, approxBytes: 19_200, newest: 9 }),
  inv("XAUUSD", "1h", { bars: 5000, approxBytes: 240_000, newest: 4, source: "yfinance" }),
  inv("BTCUSDT", "5m", { bars: 9000, approxBytes: 432_000, newest: 7 }),
  inv("ETHUSDT", "1h", { bars: 2000, approxBytes: 96_000, newest: 8 }),
  inv("BTCUSDT", "1h", { bars: 3000, approxBytes: 144_000, newest: 6 }),
  inv("BTCUSDT", "15m", { bars: 1000, approxBytes: 48_000, newest: 5 }),
];

const ids = (rows: readonly SeriesInventory[]): string[] =>
  rows.map((r) => `${r.symbol} ${r.timeframe}`);

describe("ordering the library", () => {
  it("puts bar sizes in ascending DURATION, not alphabetical order", () => {
    const btc = filterSeries(LIBRARY, "btcusdt", "symbol");
    expect(ids(btc)).toEqual(["BTCUSDT 5m", "BTCUSDT 15m", "BTCUSDT 1h", "BTCUSDT 1d"]);
    /* The order a plain `.sort()` on the label would have produced, written out
       so that reverting to one fails here rather than merely looking odd. */
    expect(ids(btc)).not.toEqual(["BTCUSDT 15m", "BTCUSDT 1d", "BTCUSDT 1h", "BTCUSDT 5m"]);
  });

  it("orders by market first, so one market's series are never scattered", () => {
    const all = filterSeries(LIBRARY, "", "symbol");
    expect(all.map((r) => r.symbol)).toEqual([
      "BTCUSDT",
      "BTCUSDT",
      "BTCUSDT",
      "BTCUSDT",
      "ETHUSDT",
      "XAUUSD",
    ]);
  });

  it("sorts by bars, size and recency, each largest or newest first", () => {
    expect(ids(filterSeries(LIBRARY, "", "bars"))[0]).toBe("BTCUSDT 5m");
    expect(ids(filterSeries(LIBRARY, "", "size"))[0]).toBe("BTCUSDT 5m");
    expect(ids(filterSeries(LIBRARY, "", "fresh"))[0]).toBe("BTCUSDT 1d");
  });

  it("never sorts the caller's array in place", () => {
    const before = ids(LIBRARY);
    filterSeries(LIBRARY, "", "size");
    expect(ids(LIBRARY)).toEqual(before);
  });
});

describe("finding a series", () => {
  it("matches the market, the bar size or the source, ignoring case", () => {
    expect(filterSeries(LIBRARY, "ETH", "symbol")).toHaveLength(1);
    expect(filterSeries(LIBRARY, "yfinance", "symbol")).toHaveLength(1);
  });

  it("matches a bar size exactly, so 5m does not drag in 15m", () => {
    /* Substring matching on the timeframe found two rows for "5m". A market
       name is open-ended and a partial one is the point; a bar size is a short
       closed vocabulary where the only thing a substring buys is the wrong
       row. */
    expect(ids(filterSeries(LIBRARY, "5m", "symbol"))).toEqual(["BTCUSDT 5m"]);
    expect(ids(filterSeries(LIBRARY, "15m", "symbol"))).toEqual(["BTCUSDT 15m"]);
    expect(ids(filterSeries(LIBRARY, "1h", "symbol"))).toEqual([
      "BTCUSDT 1h",
      "ETHUSDT 1h",
      "XAUUSD 1h",
    ]);
  });

  it("returns nothing for a query nothing matches — which is not an empty library", () => {
    expect(filterSeries(LIBRARY, "zzz", "symbol")).toHaveLength(0);
    /* The caller distinguishes the two; the fixture still holds six. */
    expect(LIBRARY).toHaveLength(6);
  });

  it("treats blank and whitespace-only queries as no filter at all", () => {
    expect(filterSeries(LIBRARY, "", "symbol")).toHaveLength(6);
    expect(filterSeries(LIBRARY, "   ", "symbol")).toHaveLength(6);
  });
});

describe("grouping by market", () => {
  it("carries each market's own totals, so they need not be added up by eye", () => {
    const groups = groupBySymbol(filterSeries(LIBRARY, "", "symbol"));
    expect(groups.map((g) => g.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "XAUUSD"]);
    const btc = groups[0];
    expect(btc?.rows).toHaveLength(4);
    expect(btc?.bars).toBe(400 + 9000 + 3000 + 1000);
    expect(btc?.bytes).toBe(19_200 + 432_000 + 144_000 + 48_000);
  });

  it("keeps the order it was given, so the sort above survives grouping", () => {
    const groups = groupBySymbol(filterSeries(LIBRARY, "", "symbol"));
    expect(ids(groups[0]?.rows ?? [])).toEqual([
      "BTCUSDT 5m",
      "BTCUSDT 15m",
      "BTCUSDT 1h",
      "BTCUSDT 1d",
    ]);
  });

  it("counts BAR SIZES, not rows — two sources at 1h is one bar size", () => {
    /* MEASURED on the owner's screen: SPX500 held 1h from mt5 and 1h from a
       proxy, and the header read "2 timeframes". A market carried by two
       vendors at one bar size is not a market you hold two bar sizes of, and
       the difference decides whether the next download is worth making. */
    const two = [
      inv("SPX500", "1h", { source: "mt5", bars: 17_627 }),
      inv("SPX500", "1h", { source: "proxy", bars: 5_082 }),
    ];
    const g = groupBySymbol(two)[0];
    expect(g?.rows).toHaveLength(2);
    expect(g?.timeframes).toBe(1);
    expect(g?.sources).toBe(2);
    expect(g?.bars).toBe(22_709);
  });

  it("counts a genuine second bar size as a second bar size", () => {
    const g = groupBySymbol(filterSeries(LIBRARY, "btcusdt", "symbol"))[0];
    expect(g?.timeframes).toBe(4);
    expect(g?.sources).toBe(1);
  });

  it("loses nothing: every row lands in exactly one group", () => {
    const groups = groupBySymbol(LIBRARY);
    expect(groups.reduce((a, g) => a + g.rows.length, 0)).toBe(LIBRARY.length);
  });
});

describe("deleting many at once", () => {
  const key = (symbol: string, tf: string): string => `binance|${symbol}|${tf}`;

  it("refuses to delete a series that is on the chart, and hands it back", () => {
    const selected = new Set([key("BTCUSDT", "1h"), key("BTCUSDT", "5m")]);
    const pinned = new Set([key("BTCUSDT", "1h")]);
    const { remove, skipped } = deletable(LIBRARY, selected, pinned);
    expect(ids(remove)).toEqual(["BTCUSDT 5m"]);
    /* The ROWS, not a count: the caller has to name what it left alone. A bulk
       action that silently does less than it was asked is the defect shape this
       repository already records for a study whose dead vendors vanished from
       its reported window. */
    expect(ids(skipped)).toEqual(["BTCUSDT 1h"]);
  });

  it("removes nothing when every selected series is on the chart", () => {
    const selected = new Set([key("BTCUSDT", "1h")]);
    const { remove, skipped } = deletable(LIBRARY, selected, selected);
    expect(remove).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("ignores a selection that no longer exists in the inventory", () => {
    const { remove, skipped } = deletable(LIBRARY, new Set([key("GONE", "1h")]), new Set());
    expect(remove).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it("does nothing at all on an empty selection", () => {
    const { remove, skipped } = deletable(LIBRARY, new Set(), new Set());
    expect(remove).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe("which markets start open", () => {
  const key = (symbol: string, tf: string): string => `binance|${symbol}|${tf}`;

  it("opens the market on the chart and leaves the rest shut", () => {
    /* Ten markets all open is the flat list again. One shut market is one line,
       and the one you are working on is the one you did not ask to see. */
    const open = defaultOpenGroups(LIBRARY, new Set([key("ETHUSDT", "1h")]));
    expect([...open]).toEqual(["ETHUSDT"]);
  });

  it("opens every market carrying a pinned series, not just the first", () => {
    const open = defaultOpenGroups(LIBRARY, new Set([key("ETHUSDT", "1h"), key("BTCUSDT", "5m")]));
    expect([...open].sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("opens nothing when nothing is on the chart", () => {
    expect(defaultOpenGroups(LIBRARY, new Set()).size).toBe(0);
  });
});

/**
 * THE COVERAGE RIBBON.
 *
 * The desk's whole question is "what history can I back-test on, and where
 * are the holes" — and the flat table could only answer it by reading six
 * date ranges and holding them in your head. The ribbon puts every market on
 * ONE axis, so a hole in the middle of a market's history reads as a hole.
 *
 * Pure, because the arithmetic is the whole thing: a segment placed at the
 * wrong percentage is a lie about when you hold data, and no eye would catch
 * a 3% error.
 */
describe("the coverage ribbon", () => {
  const DAY = 86_400_000;
  const at = (iso: string): number => Date.parse(iso + "T00:00:00Z");

  const span = (symbol: string, tf: string, from: string, to: string): SeriesInventory =>
    inv(symbol, tf, { oldest: at(from), newest: at(to) });

  it("puts every market on ONE axis, spanning the oldest bar to the newest", () => {
    const r = coverageLanes([
      span("BTCUSDT", "1d", "2021-01-01", "2026-01-01"),
      span("XAUUSD", "1h", "2024-01-01", "2025-01-01"),
    ]);
    expect(r.from).toBe(at("2021-01-01"));
    expect(r.to).toBe(at("2026-01-01"));
    /* The short market is a SHORT bar, not a full one — which is the entire
       reason the two are drawn on a shared axis. */
    const gold = r.lanes.find((l) => l.symbol === "XAUUSD");
    expect(gold?.segments[0]?.left).toBeCloseTo(60, 0);
    expect(gold?.segments[0]?.width).toBeCloseTo(20, 0);
  });

  it("merges bar sizes of one market into the union of what it covers", () => {
    const r = coverageLanes([
      span("BTCUSDT", "1d", "2021-01-01", "2023-01-01"),
      span("BTCUSDT", "1h", "2022-01-01", "2026-01-01"),
    ]);
    expect(r.lanes).toHaveLength(1);
    /* Overlapping spans are ONE segment: two bars drawn over each other would
       read as a seam that is not there. */
    expect(r.lanes[0]?.segments).toHaveLength(1);
    expect(r.lanes[0]?.segments[0]?.width).toBeCloseTo(100, 0);
  });

  it("shows a real hole as a hole", () => {
    const r = coverageLanes([
      span("SPX500", "1d", "2021-01-01", "2022-01-01"),
      span("SPX500", "1d", "2025-01-01", "2026-01-01"),
    ]);
    expect(r.lanes[0]?.segments).toHaveLength(2);
    expect(r.lanes[0]?.segments[1]?.left).toBeCloseTo(80, 0);
  });

  it("gives a market held for one day a visible sliver, never zero width", () => {
    const r = coverageLanes([
      span("BTCUSDT", "1d", "2021-01-01", "2026-01-01"),
      span("VIX", "1d", "2025-06-01", "2025-06-02"),
    ]);
    const vix = r.lanes.find((l) => l.symbol === "VIX");
    /* 1 day of 1,826 is 0.05% — which rounds to nothing and reads as "you
       hold no VIX", the opposite of the truth. */
    expect(vix?.segments[0]?.width).toBeGreaterThanOrEqual(0.6);
  });

  it("refuses an empty library rather than dividing by a zero span", () => {
    expect(coverageLanes([]).lanes).toEqual([]);
    const one = coverageLanes([span("BTCUSDT", "1d", "2026-01-01", "2026-01-01")]);
    expect(one.lanes[0]?.segments[0]?.width).toBeGreaterThan(0);
    expect(Number.isFinite(one.lanes[0]?.segments[0]?.left ?? NaN)).toBe(true);
  });

  it("orders lanes by how much history they hold, widest first", () => {
    const r = coverageLanes([
      span("VIX", "1d", "2025-01-01", "2026-01-01"),
      span("BTCUSDT", "1d", "2021-01-01", "2026-01-01"),
      span("SPX500", "1d", "2023-01-01", "2026-01-01"),
    ]);
    expect(r.lanes.map((l) => l.symbol)).toEqual(["BTCUSDT", "SPX500", "VIX"]);
  });

  it("ignores a series with no bars in it", () => {
    const empty = inv("DEAD", "1h", { bars: 0, oldest: 0, newest: 0 });
    const r = coverageLanes([span("BTCUSDT", "1d", "2021-01-01", "2026-01-01"), empty]);
    expect(r.lanes.map((l) => l.symbol)).toEqual(["BTCUSDT"]);
  });
});
