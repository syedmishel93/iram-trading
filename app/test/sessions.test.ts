import { describe, it, expect } from "vitest";
import {
  assetClass,
  isForexOpen,
  isMetalOpen,
  marketState,
  openCoverage,
  sessionNote,
} from "../src/data/sessions";
import { classify } from "../src/data/feed";

/** A UTC instant, for readability. */
const at = (iso: string): number => Date.parse(iso);

describe("assetClass", () => {
  it("recognises forex pairs", () => {
    expect(assetClass("EURUSD")).toBe("forex");
    expect(assetClass("GBPJPY")).toBe("forex");
    expect(assetClass("USDCHF")).toBe("forex");
  });

  it("strips broker suffixes before classifying", () => {
    // JustMarkets serves EURUSD.s. A classifier that does not expect that calls
    // every pair unknown and then treats a closed market as a broken feed.
    expect(assetClass("EURUSD.s")).toBe("forex");
    expect(assetClass("XAUUSD.s")).toBe("metal");
    expect(assetClass("EURUSD.a.fix")).toBe("forex");
  });

  it("recognises metals", () => {
    expect(assetClass("XAUUSD")).toBe("metal");
    expect(assetClass("XAGUSD")).toBe("metal");
  });

  it("recognises crypto", () => {
    expect(assetClass("BTCUSDT")).toBe("crypto");
    expect(assetClass("ETHUSDT")).toBe("crypto");
    expect(assetClass("BTCUSD")).toBe("crypto");
  });

  it("treats tickers as equities", () => {
    expect(assetClass("AAPL")).toBe("equity");
    expect(assetClass("MSFT")).toBe("equity");
  });
});

describe("isForexOpen", () => {
  it("is closed all Saturday", () => {
    expect(isForexOpen(at("2026-08-29T03:00:00Z"))).toBe(false);
    expect(isForexOpen(at("2026-08-29T23:00:00Z"))).toBe(false);
  });

  it("is closed Sunday until 22:00 UTC, then opens", () => {
    expect(isForexOpen(at("2026-08-30T20:00:00Z"))).toBe(false);
    expect(isForexOpen(at("2026-08-30T22:00:00Z"))).toBe(true);
  });

  it("is closed after Friday 22:00 UTC", () => {
    expect(isForexOpen(at("2026-08-28T21:59:00Z"))).toBe(true);
    expect(isForexOpen(at("2026-08-28T22:30:00Z"))).toBe(false);
  });

  it("is open through the working week", () => {
    for (const d of ["2026-08-25", "2026-08-26", "2026-08-27"]) {
      expect(isForexOpen(at(`${d}T12:00:00Z`))).toBe(true);
    }
  });
});

describe("marketState", () => {
  it("says crypto never closes", () => {
    expect(marketState("BTCUSDT", at("2026-08-29T03:00:00Z"))).toBe("open");
  });

  it("closes forex and metals at the weekend", () => {
    const sat = at("2026-08-29T12:00:00Z");
    expect(marketState("EURUSD", sat)).toBe("closed");
    expect(marketState("XAUUSD.s", sat)).toBe("closed");
  });

  /**
   * This assertion INVERTED, and deliberately.
   *
   * It used to read "returns unknown for equities rather than a confident
   * wrong answer", and that was right while nothing modelled the exchange
   * calendar. `data/equityhours.ts` now computes the holidays and half-days
   * from their rules, so refusing to answer would no longer be honesty — it
   * would be throwing away a real answer and leaving the freshness contract to
   * cry DELAYED on a healthy feed every single night.
   *
   * The refusal survives exactly where it is still earned: a venue whose
   * calendar is not modelled.
   */
  it("answers for US equities now that their calendar is modelled", () => {
    expect(marketState("AAPL", at("2026-08-29T12:00:00Z"))).toBe("closed"); // Saturday
    expect(marketState("AAPL", at("2026-08-28T15:00:00Z"))).toBe("open"); // Friday, 11:00 ET
  });

  it("still returns unknown for a venue whose calendar is not modelled", () => {
    expect(marketState("GER40", at("2026-08-28T15:00:00Z"))).toBe("unknown");
  });

  it("gives a plain-language note only when shut", () => {
    expect(sessionNote("EURUSD", at("2026-08-29T12:00:00Z"))).toMatch(/weekend/);
    expect(sessionNote("EURUSD", at("2026-08-26T12:00:00Z"))).toBe("");
    expect(sessionNote("BTCUSDT", at("2026-08-29T12:00:00Z"))).toBe("");
  });
});

describe("the freshness contract distinguishes shut from broken", () => {
  const HOUR = 3_600_000;
  const NOW = at("2026-08-30T12:00:00Z"); // a Sunday, FX shut

  it("reports CLOSED rather than DELAYED when the venue is shut", () => {
    // A healthy broker feed reports a 44-hour-old bar every weekend. Calling
    // that DELAYED teaches the operator to ignore the warning, which is how a
    // real staleness alarm gets missed on a Wednesday.
    const s = classify(NOW - 1000, NOW - 44 * HOUR, HOUR, "mt5", NOW, true);
    expect(s.quality).toBe("closed");
    expect(s.note).toMatch(/market closed/);
  });

  it("still reports STALE when the market is OPEN and the feed is old", () => {
    const s = classify(NOW - 10 * HOUR, NOW - 10 * HOUR, HOUR, "mt5", NOW, false);
    expect(s.quality).toBe("stale");
  });

  it("still reports DELAYED for a lagging vendor on an open market", () => {
    const s = classify(NOW - 1000, NOW - HOUR - 20 * 60_000, HOUR, "yfinance", NOW, false);
    expect(s.quality).toBe("delayed");
  });

  it("never reports CLOSED as offline — the data is real, just final", () => {
    const s = classify(NOW - 1000, NOW - 44 * HOUR, HOUR, "mt5", NOW, true);
    expect(s.quality).not.toBe("offline");
    expect(s.source).toBe("mt5");
  });

  it("an unknown tick time is still offline, closed market or not", () => {
    expect(classify(0, NOW, HOUR, "mt5", NOW, true).quality).toBe("offline");
  });
});

/**
 * The metals settlement break.
 *
 * MEASURED FROM REAL DATA, and it was blocking a feature rather than being a
 * refinement: gold scored 96.2% coverage against the engine's 98% floor, so the
 * cross-market survey downloaded six thousand perfectly good bars and discarded
 * them on every run. Counting the gaps in 2,000 real hourly bars: 1,045 missing
 * hours, 864 of them the weekend, and 89 at exactly 21:00 UTC — one per trading
 * day. The proxy serves XAUUSD from GC=F, and that contract settles for an hour
 * every weekday.
 */
describe("metals settle for an hour a day", () => {
  it("is shut at 17:00 New York in summer — 21:00 UTC", () => {
    // 2026-07-15 is a Wednesday, inside US daylight saving.
    expect(isMetalOpen(at("2026-07-15T21:30:00Z"))).toBe(false);
    expect(marketState("XAUUSD", at("2026-07-15T21:30:00Z"))).toBe("closed");
  });

  it("is shut at 17:00 New York in winter — 22:00 UTC", () => {
    // 2026-12-09, a Wednesday in Eastern Standard Time. The break MOVES; a
    // fixed UTC hour would be wrong for four months of the year.
    expect(isMetalOpen(at("2026-12-09T22:30:00Z"))).toBe(false);
    expect(isMetalOpen(at("2026-12-09T21:30:00Z"))).toBe(true);
  });

  it("trades either side of the break", () => {
    expect(isMetalOpen(at("2026-07-15T20:30:00Z"))).toBe(true);
    expect(isMetalOpen(at("2026-07-15T22:30:00Z"))).toBe(true);
  });

  it("still observes the weekend", () => {
    expect(isMetalOpen(at("2026-07-18T12:00:00Z"))).toBe(false); // Saturday
    expect(isMetalOpen(at("2026-07-19T12:00:00Z"))).toBe(false); // Sunday, pre-open
    expect(isMetalOpen(at("2026-07-19T23:00:00Z"))).toBe(true); // Sunday 22:00 open
  });

  it("leaves spot FX alone — it has no such break", () => {
    // EURUSD comes from EURUSD=X, which is continuous. It scored 99% coverage
    // while gold scored 96.2%, and that difference is exactly this hour.
    expect(isForexOpen(at("2026-07-15T21:30:00Z"))).toBe(true);
    expect(marketState("EURUSD", at("2026-07-15T21:30:00Z"))).toBe("open");
  });

  it("names the break rather than saying a bare 'closed'", () => {
    expect(sessionNote("XAUUSD", at("2026-07-15T21:30:00Z"))).toMatch(/settlement break/);
    expect(sessionNote("XAUUSD", at("2026-07-18T12:00:00Z"))).toMatch(/weekend/);
  });

  it("keeps the US holiday calendar, on the EASTERN date", () => {
    // Measured: of 201 open-but-absent hours in a real 4,000-bar gold series,
    // 169 fell on days equityDay already names.
    expect(isMetalOpen(at("2026-01-01T15:00:00Z"))).toBe(false); // New Year's Day
    expect(isMetalOpen(at("2026-05-25T15:00:00Z"))).toBe(false); // Memorial Day
    expect(isMetalOpen(at("2026-09-07T15:00:00Z"))).toBe(false); // Labor Day
    expect(isMetalOpen(at("2026-04-03T15:00:00Z"))).toBe(false); // Good Friday
  });

  it("closes the holiday EVENING too, which UTC splits across two days", () => {
    /* 02:00 UTC on 2 January is 21:00 Eastern on 1 January — still the holiday.
       Judging the UTC date left these hours counted as open, which is why the
       shortfall appeared as five-hour fragments on the days AFTER holidays. */
    expect(isMetalOpen(at("2026-01-02T02:00:00Z"))).toBe(false);
    // ...and by 15:00 UTC on the 2nd the holiday is over in New York.
    expect(isMetalOpen(at("2026-01-02T15:00:00Z"))).toBe(true);
  });

  it("still opens on Sunday evening, which the equity calendar calls a weekend", () => {
    /* `equityDay` reports "weekend" for Sunday and would close the metals week
       before it starts. `isForexOpen` owns the weekend; the holiday check must
       not override it. */
    expect(isMetalOpen(at("2026-07-19T23:00:00Z"))).toBe(true);
  });

  it("stays open on half-days — over-discounting hides real holes", () => {
    // Metals trade on Christmas Eve, merely shortened. Marking it closed would
    // inflate coverage, which is the direction the floor exists to catch.
    expect(isMetalOpen(at("2026-12-24T15:00:00Z"))).toBe(true);
  });

  it("applies to silver and platinum too", () => {
    for (const s of ["XAGUSD", "XPTUSD", "XPDUSD"]) {
      expect(marketState(s, at("2026-07-15T21:30:00Z"))).toBe("closed");
    }
  });

  /** The number that actually decides whether the survey can use gold. */
  it("lifts a complete gold series above the backtest coverage floor", () => {
    // One trading week, and the ONLY thing missing is the daily break — the
    // shape of a complete GC=F series.
    const from = at("2026-07-13T00:00:00Z"); // Monday
    const to = at("2026-07-17T21:00:00Z"); // Friday
    const H = 3_600_000;
    const gaps: { from: number; to: number }[] = [];
    for (let d = 0; d < 5; d++) {
      const start = from + d * 24 * H + 21 * H;
      if (start < to) gaps.push({ from: start, to: start + H });
    }

    const covered = openCoverage("XAUUSD", { from, to }, gaps);
    expect(covered).toBeGreaterThanOrEqual(0.98);

    // And the proof this test is about the fix: judged as continuous FX, the
    // same complete series falls under the floor and the survey discards it.
    const asForex = openCoverage("EURUSD", { from, to }, gaps);
    expect(asForex).toBeLessThan(0.98);
  });
});
