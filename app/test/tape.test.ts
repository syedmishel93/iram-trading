/**
 * The tape.
 *
 * Two things are being pinned here and only one of them is formatting. The
 * other is the ORDER, which is the whole design: a tape that shows a token
 * listing while the price feed is dead has failed at the only job it has.
 */

import { describe, expect, it } from "vitest";
import {
  HORIZON_HIGH_MS,
  HORIZON_MS,
  agoIn,
  awayIn,
  buildTape,
  tapeLine,
  type TapeInputs,
} from "../src/ui/tape";
import type { CalendarFeed, EconEvent, Impact } from "../src/data/calendar";
import type { NewsFeed } from "../src/data/news";
import type { FeedState } from "../src/data/feed";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const ev = (over: Partial<EconEvent> = {}): { event: EconEvent } => ({
  event: {
    at: NOW + 2 * HOUR,
    currency: "USD",
    title: "Non-Farm Employment Change",
    impact: "high" as Impact,
    forecast: "",
    previous: "",
    ...over,
  },
});

const cal = (events: { event: EconEvent }[]): CalendarFeed =>
  ({ ok: true, route: "live", events, asOf: NOW, provenance: "test", error: "" }) as unknown as CalendarFeed;

const story = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: "New listing: FOOUSDT",
  at: NOW - 30 * MIN,
  items: [],
  publishers: ["Binance"],
  trust: "single",
  ...over,
});

const news = (stories: Record<string, unknown>[]): NewsFeed =>
  ({ stories, sources: ["Binance"], failures: [], asOf: NOW, provenance: "test" }) as unknown as NewsFeed;

const feed = (quality: string, tickAgeMs = 2000): FeedState =>
  ({ quality, tickAgeMs, vendorLagMs: 0, source: "binance", note: "" }) as unknown as FeedState;

const base: TapeInputs = {
  now: NOW,
  feed: feed("live"),
  marketClosed: false,
  calendar: null,
  currencies: [],
  news: null,
  alerts: [],
};

describe("what goes on the tape", () => {
  it("says nothing about a healthy feed", () => {
    expect(buildTape(base)).toEqual([]);
  });

  it("puts a stopped feed above everything else", () => {
    /* THE ORDERING RULE, AND THE REASON THE TAPE EXISTS AT ALL. Every other
       line in this terminal is derived from bars. If the bars have stopped,
       every one of them is describing a market that has moved on, and that
       fact outranks a token listing and a release alike. */
    const t = buildTape({
      ...base,
      feed: feed("stale", 6 * MIN),
      calendar: cal([ev({ at: NOW + 3 * MIN })]),
      news: news([story()]),
    });
    expect(t[0]?.kind).toBe("feed");
    expect(t[0]?.tone).toBe("alarm");
    expect(t[0]?.text).toMatch(/moved on/);
  });

  it("does not call a quiet feed a fault when the venue is shut", () => {
    /* Gold does not tick at the weekend. A tape that shouted about it would
       train the operator to ignore the one line that must never be ignored. */
    const t = buildTape({ ...base, feed: feed("stale", 9 * HOUR), marketClosed: true });
    expect(t.filter((i) => i.kind === "feed")).toEqual([]);
  });

  it("ranks an imminent high-impact release above an announcement", () => {
    const t = buildTape({
      ...base,
      calendar: cal([ev({ at: NOW + 4 * MIN })]),
      news: news([story()]),
    });
    expect(t[0]?.kind).toBe("release");
    expect(t[0]?.tone).toBe("alarm");
  });

  it("keeps a high-impact release visible days out, and a medium one not", () => {
    /* MEASURED, NOT GUESSED. On this machine the calendar's high-impact set
       was Non-Farm Payrolls, Unemployment Rate and Average Hourly Earnings —
       all 41 hours out, the largest scheduled event of the month for a gold
       trader — and a single 36-hour window showed none of them. */
    const far = NOW + 41 * HOUR;
    expect(buildTape({ ...base, calendar: cal([ev({ at: far })]) })).toHaveLength(1);
    expect(
      buildTape({ ...base, calendar: cal([ev({ at: far, impact: "medium" })]) }),
    ).toHaveLength(0);
    expect(HORIZON_HIGH_MS).toBeGreaterThan(41 * HOUR);
    expect(HORIZON_MS).toBeLessThan(41 * HOUR);
  });

  it("puts a scheduled release ahead of an announcement of the same tone", () => {
    /* Recency is not importance. Sorting a tone band by closeness-to-now alone
       put four token listings from eleven hours ago ahead of Non-Farm Payrolls
       in forty-one — measured, on a gold chart. */
    const t = buildTape({
      ...base,
      calendar: cal([ev({ at: NOW + 41 * HOUR })]),
      news: news([story({ at: NOW - 11 * HOUR })]),
    });
    expect(t[0]?.kind).toBe("release");
    expect(t[1]?.kind).toBe("announcement");
  });

  it("drops low-impact releases entirely", () => {
    expect(buildTape({ ...base, calendar: cal([ev({ impact: "low" })]) })).toEqual([]);
  });

  it("filters releases to the currencies this instrument is exposed to", () => {
    const nzd = cal([ev({ currency: "NZD", title: "RBNZ Speaks" })]);
    expect(buildTape({ ...base, calendar: nzd, currencies: ["USD"] })).toEqual([]);
    expect(buildTape({ ...base, calendar: nzd, currencies: ["NZD"] })).toHaveLength(1);
  });

  it("always shows a global item, whatever the instrument", () => {
    const all = cal([ev({ currency: "ALL", title: "Bank holiday" })]);
    expect(buildTape({ ...base, calendar: all, currencies: ["USD"] })).toHaveLength(1);
  });

  it("counts publishers rather than judging them", () => {
    /* One venue saying something and three venues saying it are different
       facts, and the difference is countable rather than scored. */
    const t = buildTape({
      ...base,
      news: news([story({ publishers: ["Binance", "Bybit", "OKX"] })]),
    });
    expect(t[0]?.source).toBe("3 venues");
  });

  it("drops announcements older than a day", () => {
    const t = buildTape({ ...base, news: news([story({ at: NOW - 30 * HOUR })]) });
    expect(t).toEqual([]);
  });

  it("gives every item a source, because an unattributed headline is worse than none", () => {
    const t = buildTape({
      ...base,
      feed: feed("offline", Infinity),
      calendar: cal([ev()]),
      news: news([story()]),
    });
    expect(t.length).toBeGreaterThan(2);
    for (const item of t) expect(item.source.length).toBeGreaterThan(0);
  });

  it("does not bake the countdown into the text", () => {
    /* A line that has been on screen for a minute must not be a minute out of
       date, so the countdown is resolved at render time from `countdownTo`. */
    const t = buildTape({ ...base, calendar: cal([ev({ at: NOW + 9 * MIN })]) });
    const item = t[0];
    expect(item?.text).not.toMatch(/min/);
    expect(tapeLine(item!, NOW)).toMatch(/in 9 min/);
    expect(tapeLine(item!, NOW + 8 * MIN)).toMatch(/in 1 min/);
  });
});

describe("time words", () => {
  it("never prints a four-digit minutes field", () => {
    /* The third clock in this codebase to need saying: ui/countdown.ts for the
       bar, setup/gates.ts for the embargo, and now this. */
    expect(awayIn(43 * HOUR)).toBe("in 2 days");
    expect(awayIn(43 * HOUR)).not.toMatch(/min/);
    expect(agoIn(43 * HOUR)).toBe("2 days ago");
  });

  it("switches unit where the number stops being readable", () => {
    expect(awayIn(30 * 1000)).toBe("in 30s");
    expect(awayIn(45 * MIN)).toBe("in 45 min");
    expect(awayIn(4 * HOUR)).toBe("in 4.0 hours");
    expect(agoIn(30 * 1000)).toBe("just now");
  });

  it("says now rather than a negative countdown", () => {
    expect(awayIn(-5000)).toBe("now");
  });
});
