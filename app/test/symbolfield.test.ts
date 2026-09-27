/**
 * THE SYMBOL FIELD — showing what exists without locking you to it.
 *
 * THE DESIGN DECISION THESE PIN
 *
 * The obvious fix for "why do I have to type XAUUSD" is a dropdown, and it is
 * the wrong one. CLAUDE.md states the reason in its own words: THE ARCHIVE IS
 * WHAT YOU HAVE, NOT WHAT YOU CAN GET. The Playbook deliberately accepts a
 * market it does not hold and reaches back for the history — clipping the
 * request to the archive was a defect, fixed on purpose, because it meant you
 * could never ask for history you did not already own. A `<select>` would put
 * that back permanently, as a control.
 *
 * So the vocabulary is SUGGESTED and not enforced, and what these check is
 * that the suggestions are the right ones in the right order:
 *
 *  1. ONE ROW PER SYMBOL, not per series. A symbol held at three bar sizes
 *     from two vendors is one thing you can type; six suggestions for it is a
 *     list nobody reads. Same distinction the Data desk records for its group
 *     headers, which counted rows and called them bar sizes.
 *  2. HELD FIRST, richest first. "What can I test right now" is the question
 *     someone opening a backtest desk is asking.
 *  3. A SYMBOL APPEARS ONCE, and the held note wins — "12,000 bars" is worth
 *     more than "Gold vs US dollar" to somebody choosing what to run.
 */

import { describe, expect, it } from "vitest";
import { heldSymbols, rankOptions, symbolOptions } from "../src/ui/cards/symbolfield";
import { INSTRUMENTS } from "../src/risk/instruments";
import type { SeriesInventory } from "../src/store/barstore";

const row = (symbol: string, timeframe: string, bars: number, source = "binance"): SeriesInventory => ({
  key: `${source}:${symbol}:${timeframe}`,
  source,
  symbol,
  timeframe,
  segments: 1,
  bars,
  approxBytes: bars * 48,
  oldest: 1,
  newest: 2,
  qualities: [],
  lastFetched: 0,
});

describe("one row per symbol, not per series", () => {
  it("folds every bar size and every vendor into one suggestion", () => {
    const held = heldSymbols([
      row("BTCUSDT", "1h", 1000),
      row("BTCUSDT", "15m", 900),
      row("BTCUSDT", "1h", 500, "proxy"),
    ]);
    expect(held).toHaveLength(1);
    expect(held[0]?.symbol).toBe("BTCUSDT");
    expect(held[0]?.note).toContain("2,400 bars");
    // Two DISTINCT bar sizes, though three rows arrived — the same collapse the
    // Data desk had to be corrected on when its header counted rows.
    expect(held[0]?.note).toContain("1h, 15m");
  });

  it("names the bar sizes rather than counting them", () => {
    const held = heldSymbols([row("XAUUSD", "1h", 800)]);
    // "1h" is worth more than "1 bar size" in a row this narrow: it answers
    // the next question instead of describing the answer.
    expect(held[0]?.note).toBe("800 bars · 1h");
  });

  it("upper-cases, so a lower-case row does not become a second symbol", () => {
    const held = heldSymbols([row("btcusdt", "1h", 100), row("BTCUSDT", "4h", 100)]);
    expect(held).toHaveLength(1);
    expect(held[0]?.symbol).toBe("BTCUSDT");
  });

  it("ignores a series holding nothing", () => {
    // An empty series is not something you can test, so suggesting it would be
    // an offer the desk then refuses.
    expect(heldSymbols([row("ETHUSDT", "1h", 0)])).toHaveLength(0);
    expect(heldSymbols([{ ...row("", "1h", 50) }])).toHaveLength(0);
  });
});

describe("what you hold leads", () => {
  it("orders held symbols by how much is held", () => {
    const held = heldSymbols([row("A", "1h", 10), row("B", "1h", 900), row("C", "1h", 300)]);
    expect(held.map((h2) => h2.symbol)).toEqual(["B", "C", "A"]);
  });

  it("puts every held symbol above every catalogued one", () => {
    const all = symbolOptions(heldSymbols([row("BTCUSDT", "1h", 500)]));
    expect(all[0]?.symbol).toBe("BTCUSDT");
    expect(all[0]?.held).toBe(true);
    expect(all.slice(1).every((o) => !o.held)).toBe(true);
  });

  it("carries the catalogue too, so a market you have never fetched is findable", () => {
    const all = symbolOptions([]);
    expect(all.length).toBe(INSTRUMENTS.length);
    expect(all.some((o) => o.symbol === "EURUSD")).toBe(true);
    // And the note describes it, since there are no bars to describe.
    expect(all.find((o) => o.symbol === "EURUSD")?.note).toContain("EUR/USD");
  });
});

describe("a symbol appears once", () => {
  it("does not repeat a held symbol that is also in the catalogue", () => {
    const cat = INSTRUMENTS[0]?.symbol as string;
    const all = symbolOptions(heldSymbols([row(cat, "1h", 4321)]));
    expect(all.filter((o) => o.symbol.toUpperCase() === cat.toUpperCase())).toHaveLength(1);
    // The HELD note wins: bars are what someone choosing a backtest needs.
    expect(all[0]?.note).toContain("4,321 bars");
  });

  it("never emits the same symbol twice, however the inputs overlap", () => {
    const all = symbolOptions(
      heldSymbols([row("BTCUSDT", "1h", 1), row("EURUSD", "1h", 2), row("eurusd", "4h", 3)]),
    );
    const seen = all.map((o) => o.symbol.toUpperCase());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("is a suggestion list and not a closed set", () => {
    // The property the whole design rests on: nothing here rejects a symbol.
    // A `<select>` would, and the Playbook's backfill would be unreachable.
    const all = symbolOptions(heldSymbols([]));
    expect(all.some((o) => o.symbol === "DOGEUSDT")).toBe(false);
    // ...and the field still accepts it, which is asserted where it is wired
    // rather than here, because it is a property of the input element.
    expect(all.length).toBeGreaterThan(50);
  });
});

/**
 * RANKING — and the one property a `<datalist>` could not give.
 *
 * A browser filters a datalist by WHAT IS ALREADY IN THE BOX. These fields are
 * pre-filled, so opening the list on a field reading "XAUUSD" offered exactly
 * one row: XAUUSD. All 131 options were in the DOM and bound correctly; the
 * browser was hiding 130 of them, and "it only shows XAUUSD" is what that looks
 * like. The first test below is that defect, pinned.
 */
describe("what the list shows", () => {
  const opts = symbolOptions(
    heldSymbols([row("XAUUSD", "1h", 900), row("BTCUSDT", "1h", 100)]),
  );

  it("shows EVERYTHING for an empty query, whatever is in the box", () => {
    const all = rankOptions(opts, "", 500);
    expect(all.length).toBe(opts.length);
    expect(all.length).toBeGreaterThan(100);
    // The held ones still lead.
    expect(all[0]?.symbol).toBe("XAUUSD");
    expect(all[1]?.symbol).toBe("BTCUSDT");
  });

  it("narrows once you type, and a prefix beats a substring", () => {
    const usd = rankOptions(opts, "usd", 500);
    expect(usd.length).toBeGreaterThan(3);
    expect(usd.length).toBeLessThan(opts.length);
    // "USDJPY" starts with it; "XAUUSD" merely contains it.
    const jpy = usd.findIndex((o) => o.symbol === "USDJPY");
    const xau = usd.findIndex((o) => o.symbol === "XAUUSD");
    expect(jpy).toBeGreaterThanOrEqual(0);
    expect(xau).toBeGreaterThan(jpy);
  });

  it("matches the note too, so a name finds a ticker you do not know", () => {
    // Somebody looking for gold does not necessarily know it is called XAUUSD.
    const gold = rankOptions(symbolOptions([]), "gold", 50);
    expect(gold.length).toBeGreaterThan(0);
  });

  it("is case-insensitive, because nobody types tickers in caps", () => {
    expect(rankOptions(opts, "btc", 50)[0]?.symbol).toBe("BTCUSDT");
    expect(rankOptions(opts, "BTC", 50)[0]?.symbol).toBe("BTCUSDT");
  });

  it("honours the limit, since the caller is painting rows", () => {
    expect(rankOptions(opts, "", 5)).toHaveLength(5);
    expect(rankOptions(opts, "u", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for a query nothing matches, rather than everything", () => {
    // An empty result is a real answer. Falling back to the whole list would
    // say "here is everything" to someone who asked for one thing.
    expect(rankOptions(opts, "ZZZQQQ", 50)).toHaveLength(0);
  });
});
