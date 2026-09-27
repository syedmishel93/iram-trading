import { describe, expect, it } from "vitest";
import {
  easter,
  easternOffsetHours,
  equityClosedNote,
  equityDay,
  equityVenue,
  isEquityOpen,
} from "../src/data/equityhours";
import { assetClass, marketState, openSpanMs, sessionNote } from "../src/data/sessions";

/** A UTC instant, so nothing here depends on the machine's time zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m - 1, d, h, min);

describe("easter", () => {
  /* Checked against the published dates. Good Friday is the only US market
     holiday with no fixed date and no nth-weekday rule, so if this is wrong
     the market is open on a day it is shut. */
  it("matches the known Gregorian dates", () => {
    expect(easter(2024)).toEqual({ m: 3, d: 31 });
    expect(easter(2025)).toEqual({ m: 4, d: 20 });
    expect(easter(2026)).toEqual({ m: 4, d: 5 });
    expect(easter(2027)).toEqual({ m: 3, d: 28 });
    expect(easter(2030)).toEqual({ m: 4, d: 21 });
  });
});

describe("easternOffsetHours", () => {
  it("is EST in January and EDT in July", () => {
    expect(easternOffsetHours(at(2026, 1, 15))).toBe(-5);
    expect(easternOffsetHours(at(2026, 7, 15))).toBe(-4);
  });

  it("switches on the second Sunday in March and the first in November", () => {
    // 2026: DST starts 8 March, ends 1 November.
    expect(easternOffsetHours(at(2026, 3, 7))).toBe(-5);
    expect(easternOffsetHours(at(2026, 3, 9))).toBe(-4);
    expect(easternOffsetHours(at(2026, 10, 31))).toBe(-4);
    expect(easternOffsetHours(at(2026, 11, 2))).toBe(-5);
  });
});

describe("equityDay", () => {
  const why = (ms: number): string => {
    const d = equityDay(ms);
    return d.kind === "full" ? "" : d.why;
  };

  it("closes on the weekend", () => {
    expect(why(at(2026, 9, 5))).toBe("weekend"); // Saturday
    expect(why(at(2026, 9, 6))).toBe("weekend"); // Sunday
  });

  it("closes on every fixed-date and nth-weekday holiday", () => {
    expect(why(at(2026, 1, 1))).toBe("New Year's Day");
    expect(why(at(2026, 1, 19))).toBe("Martin Luther King Jr. Day");
    expect(why(at(2026, 2, 16))).toBe("Presidents' Day");
    expect(why(at(2026, 5, 25))).toBe("Memorial Day");
    expect(why(at(2026, 6, 19))).toBe("Juneteenth");
    expect(why(at(2026, 9, 7))).toBe("Labor Day");
    expect(why(at(2026, 11, 26))).toBe("Thanksgiving");
    expect(why(at(2026, 12, 25))).toBe("Christmas Day");
  });

  it("closes on Good Friday, two days before Easter", () => {
    expect(why(at(2026, 4, 3))).toBe("Good Friday");
    expect(why(at(2025, 4, 18))).toBe("Good Friday");
    expect(why(at(2024, 3, 29))).toBe("Good Friday");
  });

  /**
   * The observance rule, which is the part a hard-coded table gets wrong.
   *
   * 4 July 2026 falls on a Saturday, so the exchange shuts on Friday the 3rd.
   * A calendar that only checked the nominal date would have the market open
   * that Friday and closed on nothing.
   */
  it("shifts a Saturday holiday to the Friday before", () => {
    expect(why(at(2026, 7, 3))).toBe("Independence Day");
    expect(equityDay(at(2026, 7, 4)).kind).toBe("closed"); // the Saturday itself
  });

  it("shifts a Sunday holiday to the Monday after", () => {
    // 4 July 2027 is a Sunday; the market shuts Monday the 5th.
    expect(why(at(2027, 7, 5))).toBe("Independence Day");
  });

  it("marks the three half-days rather than calling them full sessions", () => {
    const black = equityDay(at(2026, 11, 27));
    expect(black.kind).toBe("half");
    const xmasEve = equityDay(at(2026, 12, 24));
    expect(xmasEve.kind).toBe("half");
    if (black.kind !== "half") throw new Error("unreachable");
    // 13:00 EST is 18:00 UTC.
    expect(black.span.closeMin).toBe(18 * 60);
  });

  it("runs 09:30–16:00 Eastern, which moves in UTC with daylight saving", () => {
    const winter = equityDay(at(2026, 1, 15));
    const summer = equityDay(at(2026, 7, 15));
    if (winter.kind !== "full" || summer.kind !== "full") throw new Error("unreachable");
    expect(winter.span).toEqual({ openMin: 14 * 60 + 30, closeMin: 21 * 60 }); // EST
    expect(summer.span).toEqual({ openMin: 13 * 60 + 30, closeMin: 20 * 60 }); // EDT
  });
});

describe("isEquityOpen", () => {
  it("is shut before the bell and after it", () => {
    expect(isEquityOpen(at(2026, 7, 15, 13, 0))).toBe(false); // 09:00 ET
    expect(isEquityOpen(at(2026, 7, 15, 13, 30))).toBe(true); // 09:30 ET
    expect(isEquityOpen(at(2026, 7, 15, 19, 59))).toBe(true);
    expect(isEquityOpen(at(2026, 7, 15, 20, 0))).toBe(false); // 16:00 ET
  });

  /* Pre-market is deliberately not "open". The book is thin and the print is
     not the price you get filled at in size. */
  it("does not count pre-market as open", () => {
    expect(isEquityOpen(at(2026, 7, 15, 9, 0))).toBe(false); // 05:00 ET
  });

  it("is shut all day on a holiday even during regular hours", () => {
    expect(isEquityOpen(at(2026, 11, 26, 15, 0))).toBe(false);
  });

  it("shuts early on a half-day", () => {
    expect(isEquityOpen(at(2026, 11, 27, 17, 59))).toBe(true); // 12:59 EST
    expect(isEquityOpen(at(2026, 11, 27, 18, 1))).toBe(false); // 13:01 EST
  });
});

describe("equityClosedNote", () => {
  it("names the reason rather than saying only 'closed'", () => {
    expect(equityClosedNote(at(2026, 11, 26, 15, 0))).toBe("market closed — Thanksgiving");
    expect(equityClosedNote(at(2026, 9, 5, 15, 0))).toBe("market closed — weekend");
    expect(equityClosedNote(at(2026, 7, 15, 9, 0))).toBe("market closed — before the open");
    expect(equityClosedNote(at(2026, 7, 15, 22, 0))).toBe("market closed — after the close");
    expect(equityClosedNote(at(2026, 11, 27, 19, 0))).toMatch(/early close/);
  });

  it("is empty while the market is open", () => {
    expect(equityClosedNote(at(2026, 7, 15, 15, 0))).toBe("");
  });
});

describe("equityVenue", () => {
  it("claims the US calendar only for US listings", () => {
    expect(equityVenue("AAPL")).toBe("us");
    expect(equityVenue("NAS100")).toBe("us");
    expect(equityVenue("SPX500")).toBe("us");
  });

  /* The honest refusal. Frankfurt and London keep their own holidays, and
     applying New York's to them would be exactly the confident wrong answer
     that made equities `unknown` in the first place. */
  it("refuses to answer for non-US venues", () => {
    expect(equityVenue("GER40")).toBeNull();
    expect(equityVenue("UK100")).toBeNull();
    expect(equityVenue("JPN225")).toBeNull();
  });
});

describe("sessions integration", () => {
  it("classifies index CFDs as equities, which it never used to", () => {
    expect(assetClass("NAS100")).toBe("equity");
    expect(assetClass("GER40")).toBe("equity");
    expect(assetClass("AAPL")).toBe("equity");
  });

  it("does not misfile forex or crypto as equity", () => {
    expect(assetClass("EURUSD")).toBe("forex");
    expect(assetClass("XAUUSD")).toBe("metal");
    expect(assetClass("BTCUSDT")).toBe("crypto");
  });

  it("reports a US equity as closed at night instead of leaving it unknown", () => {
    expect(marketState("AAPL", at(2026, 7, 15, 15, 0))).toBe("open");
    expect(marketState("AAPL", at(2026, 7, 16, 2, 0))).toBe("closed");
    expect(marketState("NAS100", at(2026, 11, 26, 15, 0))).toBe("closed");
  });

  it("keeps non-US indices unknown rather than guessing", () => {
    expect(marketState("GER40", at(2026, 11, 26, 15, 0))).toBe("unknown");
  });

  it("carries the holiday name into the status note", () => {
    expect(sessionNote("AAPL", at(2026, 11, 26, 15, 0))).toBe("market closed — Thanksgiving");
  });

  /**
   * The coverage denominator, and why it matters.
   *
   * A complete week of AAPL bars is missing about 81% of the wall clock BY
   * DEFINITION. Counting that against coverage makes perfect data look like a
   * hole, the guard fires, and the threshold gets lowered until it stops
   * firing — at which point it no longer catches the real gap it was put there
   * for.
   */
  it("excludes closed hours from the coverage denominator for US equities", () => {
    const from = at(2026, 7, 13); // Monday
    const to = at(2026, 7, 18); // Saturday
    const span = openSpanMs("AAPL", from, to);
    const hours = span / 3_600_000;
    // Five sessions of 6.5 hours.
    expect(hours).toBeGreaterThan(32);
    expect(hours).toBeLessThan(33);
  });

  it("still returns the full span for crypto, which never closes", () => {
    const from = at(2026, 7, 13);
    const to = at(2026, 7, 18);
    expect(openSpanMs("BTCUSDT", from, to)).toBe(to - from);
  });
});
