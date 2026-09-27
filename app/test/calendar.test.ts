import { describe, it, expect } from "vitest";
import {
  parseForexFactory,
  parseStored,
  upcoming,
  currenciesFor,
  releaseRisk,
  impactRank,
  viaProxy,
  loadCalendar,
  IMMINENT_MS,
  type EconEvent,
} from "../src/data/calendar";
import { reconcileEvents } from "../src/core/crosscheck";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const MIN = 60_000;

/** The exact shape the live feed returns — captured from it, not invented. */
const RAW = [
  {
    title: "ISM Manufacturing PMI",
    country: "USD",
    date: "2026-09-01T10:00:00-04:00",
    impact: "High",
    forecast: "55.2",
    previous: "55.6",
  },
  {
    title: "GDP q/q",
    country: "AUD",
    date: "2026-09-01T21:30:00-04:00",
    impact: "High",
    forecast: "0.3%",
    previous: "0.3%",
  },
  {
    title: "G20 Meetings",
    country: "All",
    date: "2026-08-30T11:15:00-04:00",
    impact: "Low",
    forecast: "",
    previous: "",
  },
];

const wrap = (events: EconEvent[]) => reconcileEvents(events, [], false);

describe("parseForexFactory", () => {
  it("keeps every field the old path threw away", () => {
    /* Found by title, not by position: the parser sorts by time and the
       earliest event in this fixture is the G20 item. */
    const pmi = parseForexFactory(RAW).find((e) => e.title === "ISM Manufacturing PMI");
    expect(pmi).toEqual({
      at: Date.parse("2026-09-01T10:00:00-04:00"),
      currency: "USD",
      title: "ISM Manufacturing PMI",
      impact: "high",
      forecast: "55.2",
      previous: "55.6",
    });
  });

  it("keeps non-USD and non-high events", () => {
    const parsed = parseForexFactory(RAW);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((e) => e.currency)).toContain("AUD");
    expect(parsed.some((e) => e.impact === "low")).toBe(true);
  });

  it("does not truncate the title", () => {
    const long = "A".repeat(90);
    const [e] = parseForexFactory([{ title: long, country: "USD", date: RAW[0]!.date, impact: "High" }]);
    expect(e?.title).toHaveLength(90);
  });

  it("maps a global item to ALL rather than dropping it", () => {
    expect(parseForexFactory(RAW).find((e) => e.title === "G20 Meetings")?.currency).toBe("ALL");
  });

  it("sorts by time", () => {
    const times = parseForexFactory(RAW).map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  /**
   * A calendar entry at the WRONG time is worse than a missing one: it gets
   * read as a scheduled release and used to explain a move it had nothing to
   * do with. So an unparseable date drops the event rather than defaulting.
   */
  it("drops an event with an unreadable date instead of defaulting it", () => {
    expect(parseForexFactory([{ title: "Mystery", country: "USD", date: "not a date" }])).toEqual([]);
  });

  it("drops an untitled event", () => {
    expect(parseForexFactory([{ title: "  ", country: "USD", date: RAW[0]!.date }])).toEqual([]);
  });

  it("treats an unknown impact as low rather than guessing high", () => {
    const [e] = parseForexFactory([{ title: "X", country: "USD", date: RAW[0]!.date, impact: "Weird" }]);
    expect(e?.impact).toBe("low");
  });

  it("survives a feed that is not an array", () => {
    expect(parseForexFactory({ error: "nope" })).toEqual([]);
    expect(parseForexFactory(null)).toEqual([]);
  });
});

describe("parseStored", () => {
  it("reads the thin stored shape and labels what it cannot know", () => {
    const [e] = parseStored([{ t: "2026-09-01T14:00:00Z", n: "Non-Farm Employment Change" }]);
    expect(e?.currency).toBe("USD");
    expect(e?.impact).toBe("high");
    expect(e?.forecast).toBe("");
  });

  it("skips malformed rows", () => {
    expect(parseStored([{ t: "bad", n: "X" }, { n: "Y" }, null])).toEqual([]);
  });
});

describe("viaProxy", () => {
  it("encodes the target so its query string survives", () => {
    const u = viaProxy("http://127.0.0.1:8787", "https://example.com/a?b=1&c=2");
    expect(u).toBe("http://127.0.0.1:8787/fetch?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2");
  });
});

/**
 * MEASURED IN THE FIELD: repeated fetches while building this earned a 429
 * from the mirror. The first version reported that as "the live passthrough is
 * not answering" — the passthrough was answering perfectly and relaying a
 * refusal from a different host. Blaming the wrong component sends you to
 * restart a service that was never down.
 */
describe("failure attribution", () => {
  const load = async (liveStatus: number | "offline") => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/fetch?url=")) {
        if (liveStatus === "offline") throw new TypeError("Failed to fetch");
        return new Response("<html>refused</html>", { status: liveStatus });
      }
      /* The stored route: one high-impact USD event. */
      return new Response(
        JSON.stringify([
          { source: "calendar", k: "high_usd", t: 1, v: JSON.stringify([{ t: "2026-09-01T14:00:00Z", n: "ISM Manufacturing PMI" }]) },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      return await loadCalendar({ now: Date.parse("2026-09-01T00:00:00Z") });
    } finally {
      globalThis.fetch = original;
    }
  };

  it("blames the mirror, not the passthrough, for a 429", async () => {
    const feed = await load(429);
    expect(feed.route).toBe("stored");
    expect(feed.error).toMatch(/rate-limiting/);
    expect(feed.error).toMatch(/passthrough itself is fine/);
  });

  it("blames the proxy when the proxy is the thing that is down", async () => {
    const feed = await load("offline");
    expect(feed.error).toMatch(/data proxy/);
    expect(feed.error).toMatch(/python run\.py/);
  });

  it("still serves the stored copy and says it is a floor", async () => {
    const feed = await load(429);
    expect(feed.ok).toBe(true);
    expect(feed.events.length).toBeGreaterThan(0);
    expect(feed.provenance).toMatch(/hourly snapshot only/);
  });
});

describe("upcoming", () => {
  const events = wrap([
    { at: NOW - MIN, currency: "USD", title: "Past", impact: "high", forecast: "", previous: "" },
    { at: NOW + 10 * MIN, currency: "USD", title: "Soon", impact: "high", forecast: "", previous: "" },
    { at: NOW + 20 * MIN, currency: "EUR", title: "Euro", impact: "medium", forecast: "", previous: "" },
    { at: NOW + 30 * MIN, currency: "ALL", title: "Global", impact: "low", forecast: "", previous: "" },
    { at: NOW + 40 * MIN, currency: "JPY", title: "Yen", impact: "high", forecast: "", previous: "" },
  ]);

  it("drops what has already happened", () => {
    expect(upcoming(events, { now: NOW }).some((r) => r.event.title === "Past")).toBe(false);
  });

  it("filters by currency but always lets global items through", () => {
    const titles = upcoming(events, { now: NOW, currencies: ["USD"] }).map((r) => r.event.title);
    expect(titles).toEqual(["Soon", "Global"]);
  });

  it("filters by minimum impact", () => {
    const titles = upcoming(events, { now: NOW, minImpact: "high" }).map((r) => r.event.title);
    expect(titles).toEqual(["Soon", "Yen"]);
  });

  it("respects a horizon and a limit", () => {
    expect(upcoming(events, { now: NOW, withinMs: 25 * MIN })).toHaveLength(2);
    expect(upcoming(events, { now: NOW, limit: 1 })).toHaveLength(1);
  });

  it("returns soonest first", () => {
    const ts = upcoming(events, { now: NOW }).map((r) => r.event.at);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe("currenciesFor", () => {
  /**
   * A crypto trader in an FOMC decision is exposed to it. Omitting USD because
   * the pair has no fiat leg would hide the most useful thing this calendar
   * can tell them.
   */
  it("exposes a dollar-quoted crypto pair to USD releases", () => {
    expect(currenciesFor("BTCUSDT")).toContain("USD");
  });

  it("finds both legs of an FX pair", () => {
    expect(currenciesFor("EURJPY").sort()).toEqual(["EUR", "JPY"]);
  });

  it("falls back to USD rather than to nothing", () => {
    expect(currenciesFor("XYZ")).toEqual(["USD"]);
  });
});

describe("impactRank", () => {
  it("orders high above medium above low above holiday", () => {
    expect(impactRank("high")).toBeGreaterThan(impactRank("medium"));
    expect(impactRank("medium")).toBeGreaterThan(impactRank("low"));
    expect(impactRank("low")).toBeGreaterThan(impactRank("holiday"));
  });
});

describe("releaseRisk", () => {
  const at = (mins: number, impact: EconEvent["impact"] = "high") =>
    wrap([{ at: NOW + mins * MIN, currency: "USD", title: "NFP", impact, forecast: "", previous: "" }]);

  it("is zero with nothing scheduled inside the hour", () => {
    const r = releaseRisk(at(120), { now: NOW });
    expect(r.discount).toBe(0);
    expect(r.next).toBeNull();
    expect(r.note).toMatch(/No medium- or high-impact release/);
  });

  it("rises as the release gets closer", () => {
    const far = releaseRisk(at(50), { now: NOW }).discount;
    const near = releaseRisk(at(5), { now: NOW }).discount;
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(1);
  });

  it("discounts a medium release less than a high one", () => {
    expect(releaseRisk(at(10, "medium"), { now: NOW }).discount).toBeLessThan(
      releaseRisk(at(10, "high"), { now: NOW }).discount,
    );
  });

  it("ignores low-impact noise entirely", () => {
    expect(releaseRisk(at(5, "low"), { now: NOW }).discount).toBe(0);
  });

  /**
   * THE DIRECTION IS THE POINT. A known release does not say which way price
   * goes; it says the current structure may stop mattering. The note must not
   * read as a lean.
   */
  it("says what a scheduled release does and does not tell you", () => {
    const r = releaseRisk(at(10), { now: NOW });
    expect(r.note).toMatch(/does not say which way price goes/);
    expect(r.note).toMatch(/10 min/);
  });

  it("discounts a disputed entry less than a clean one, but not to zero", () => {
    const clean = releaseRisk(at(10), { now: NOW }).discount;
    const disputed = releaseRisk(
      reconcileEvents(
        [{ at: NOW + 10 * MIN, currency: "USD", title: "NFP", impact: "high", forecast: "1", previous: "" }],
        [{ at: NOW + 10 * MIN, currency: "USD", title: "NFP", forecast: "2" }],
        false,
      ),
      { now: NOW },
    ).discount;
    expect(disputed).toBeGreaterThan(0);
    expect(disputed).toBeLessThan(clean);
  });

  it("never exceeds 1 even at the moment of release", () => {
    expect(releaseRisk(at(0), { now: NOW }).discount).toBeLessThanOrEqual(1);
  });

  it("only looks one hour ahead", () => {
    expect(releaseRisk(at(IMMINENT_MS / MIN + 1), { now: NOW }).next).toBeNull();
  });
});
