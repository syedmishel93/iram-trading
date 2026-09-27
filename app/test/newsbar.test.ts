// @vitest-environment jsdom
/**
 * The news bar and its client.
 *
 * Weighted toward the things a ticker gets wrong in ways nobody notices: an
 * item with an unreadable date rendered as fresh, a rotation index left
 * pointing past the end of a list that shrank, a partial feed failure showing
 * as healthy, and attribution disappearing when the title is long.
 *
 * The last one is the rule `ui/tape.ts` states and this inherits: an
 * unattributed headline in a trading terminal is worse than no headline.
 */

import { describe, expect, it, vi } from "vitest";
import { age, createRss, emptyReason, EMPTY, type RssFeed, type RssItem } from "../src/data/rss";
import { healthText, itemAt, positionText } from "../src/ui/newsbar";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

const item = (over: Partial<RssItem> = {}): RssItem => ({
  id: "a",
  title: "Fed holds rates",
  link: "https://example.com/a",
  source: "Federal Reserve",
  at: NOW - 60_000,
  ...over,
});

const feed = (over: Partial<RssFeed> = {}): RssFeed => ({
  ...EMPTY,
  items: [item()],
  status: [{ source: "Federal Reserve", url: "u", ok: true, error: null, items: 1 }],
  feeds: 1,
  working: 1,
  note: "1 of 1 feeds answered",
  ...over,
});

describe("age", () => {
  it("spells out an unknown age instead of showing a dash", () => {
    /* The server returns `at: null` when a feed's date could not be parsed. A
       dash in a column of ages reads as "just now" to somebody scanning, which
       is the exact failure keeping the null was meant to prevent. */
    expect(age(null, NOW)).toBe("unknown age");
  });

  it("never renders an old item as recent", () => {
    expect(age(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(age(NOW - 40 * 3_600_000, NOW)).toBe("2 days ago");
  });

  it("treats a future timestamp as just now rather than negative", () => {
    /* Clock skew between a newsroom and this machine is normal. "-3 min ago"
       is not. */
    expect(age(NOW + 120_000, NOW)).toBe("just now");
  });
});

describe("itemAt", () => {
  it("returns nothing for an empty list", () => {
    expect(itemAt([], 0)).toBeNull();
  });

  it("wraps rather than running off the end", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(itemAt(items, 0)?.id).toBe("a");
    expect(itemAt(items, 3)?.id).toBe("b");
  });

  it("survives the list shrinking under a large tick", () => {
    /* The failure an index would have: a refresh returns fewer stories, the
       stored index points past the end, and the bar goes blank while the feed
       is perfectly healthy. Modulo cannot do that. */
    const items = [item({ id: "a" })];
    expect(itemAt(items, 900)?.id).toBe("a");
  });

  it("handles a negative tick", () => {
    expect(itemAt([item({ id: "a" }), item({ id: "b" })], -1)?.id).toBe("b");
  });
});

describe("positionText", () => {
  it("says where you are, so a reader knows the rotation is finite", () => {
    expect(positionText([item(), item(), item()], 1)).toBe("2/3");
  });

  it("says nothing at all when there is nothing to be in", () => {
    expect(positionText([], 0)).toBe("");
  });
});

describe("healthText", () => {
  it("names the feeds that are down rather than reporting a count", () => {
    /* Four of five working looks fine and means a fifth of the coverage is
       silently gone. WHICH fifth is the actionable part. */
    const f = feed({
      feeds: 2,
      working: 1,
      status: [
        { source: "ECB", url: "u", ok: true, error: null, items: 3 },
        { source: "BLS", url: "u", ok: false, error: "HTTP 503", items: 0 },
      ],
    });
    expect(healthText(f)).toEqual({ text: "BLS down", tone: "warn" });
  });

  it("distinguishes no service from all feeds failing", () => {
    /* Different next actions: start the service, or check the network. */
    expect(healthText(feed({ error: "Failed to fetch" })).text).toBe("no service");
    expect(healthText(feed({ feeds: 3, working: 0 })).text).toBe("all feeds down");
  });

  it("reads an unconfigured bar as a setting, not an alarm", () => {
    /* Zero feeds configured is a choice the operator made (or has not made
       yet). Painting it in the loss colour made a resting terminal look
       broken, and trained the eye to ignore the red that means something. */
    expect(healthText(feed({ feeds: 0, working: 0 }))).toEqual({ text: "not set up", tone: "off" });
  });

  it("marks news failures as a caution, keeping red for the price feed", () => {
    expect(healthText(feed({ error: "Failed to fetch" })).tone).toBe("warn");
    expect(healthText(feed({ feeds: 3, working: 0 })).tone).toBe("warn");
  });

  it("is quiet when everything works", () => {
    expect(healthText(feed({ feeds: 5, working: 5 }))).toEqual({ text: "5 feeds", tone: "ok" });
  });
});

describe("emptyReason", () => {
  it("tells the three silences apart", () => {
    /* The distinction the Flow desk had to be taught: a service that is not
       running, feeds that all failed, and a genuinely quiet hour need three
       different things done about them. */
    expect(emptyReason({ ...EMPTY, error: "Failed to fetch" })).toMatch(/python run\.py/);
    expect(emptyReason(feed({ feeds: 3, working: 0, items: [], note: "" }))).toMatch(
      /connection problem, not a quiet news day/,
    );
    expect(emptyReason(feed({ items: [] }))).toMatch(/Nothing published/);
  });

  it("does not blame the network when no feeds are configured", () => {
    expect(emptyReason({ ...EMPTY, feeds: 0 })).toBe("No feeds configured.");
  });
});

describe("createRss", () => {
  it("refuses a non-local service without making a request", async () => {
    /* The feed list is a small statement about what the operator reads. */
    const fetchImpl = vi.fn();
    const rss = createRss({ url: "https://news.example.com", fetchImpl: fetchImpl as never });
    const out = await rss.load();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.error).toMatch(/non-local/);
  });

  it("is not fooled by a hostname containing a local address", async () => {
    const fetchImpl = vi.fn();
    const rss = createRss({ url: "http://127.0.0.1.evil.example", fetchImpl: fetchImpl as never });
    await rss.load();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs the defaults and POSTs a custom feed list", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true, items: [], status: [], feeds: 0, working: 0, note: "" }), {
        status: 200,
      });
    });
    await createRss({ fetchImpl: fetchImpl as never }).load();
    await createRss({
      fetchImpl: fetchImpl as never,
      feeds: () => [{ url: "https://x/rss", source: "X" }],
    }).load();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("POST");
  });

  it("reports a dead service as an error rather than an empty news day", async () => {
    /* An empty bar and a broken bar look identical unless this is kept apart. */
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const out = await createRss({ fetchImpl: fetchImpl as never }).load();
    expect(out.error).toMatch(/Failed to fetch/);
    expect(out.items).toEqual([]);
  });

  it("keeps a null timestamp rather than filling it in", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          items: [{ id: "a", title: "t", link: "", source: "S", at: null }],
          status: [],
          feeds: 1,
          working: 1,
          note: "",
        }),
        { status: 200 },
      ),
    );
    const out = await createRss({ fetchImpl: fetchImpl as never }).load();
    expect(out.items[0]?.at).toBeNull();
  });
});

/**
 * The message a dead news service produces.
 *
 * SEEN ON SCREEN in the status strip, which is what prompted this:
 *
 *   No news service — Unexpected token '<', "<!doctype "... is not valid JSON.
 *   Start mishel_service.py to read feeds.
 *
 * Every word true, addressed to the wrong person. The service was not running,
 * the gateway answered with its own HTML 404, and `res.json()` choked on the
 * first `<`. A status strip is not a console.
 */
describe("emptyReason translates transport failures", () => {
  const feed = (over: Partial<RssFeed> = {}): RssFeed => ({
    items: [],
    status: [],
    feeds: 0,
    working: 0,
    note: "",
    error: null,
    ...over,
  });

  it("does not put a JSON parser message in front of the operator", () => {
    const out = emptyReason(
      feed({ error: `Unexpected token '<', "<!doctype "... is not valid JSON` }),
    );
    expect(out).not.toMatch(/doctype/i);
    expect(out).not.toMatch(/unexpected token/i);
    expect(out).toMatch(/not answering on this address/);
    // The remedy survives — it was the useful half all along. It names the
    // ONE launcher: starting mishel_service.py alone brings up a layout the
    // terminal cannot address (CLAUDE.md, "Nine launchers").
    expect(out).toMatch(/python run\.py/);
    expect(out).not.toMatch(/mishel_service/);
  });

  it("names a dead address as a dead address", () => {
    expect(emptyReason(feed({ error: "Failed to fetch" }))).toMatch(/nothing is listening/);
  });

  it("separates a timeout from a refusal", () => {
    expect(emptyReason(feed({ error: "The operation was aborted" }))).toMatch(/timed out/);
  });

  it("tells a 404 apart from a 500", () => {
    expect(emptyReason(feed({ error: "HTTP 404" }))).toMatch(/no news endpoint/);
    expect(emptyReason(feed({ error: "HTTP 503" }))).toMatch(/answered with an error/);
  });

  it("passes an unrecognised error through rather than inventing a phrase", () => {
    // The one case where the exact words are the only useful thing.
    expect(emptyReason(feed({ error: "certificate has expired" }))).toMatch(
      /certificate has expired/,
    );
  });

  it("truncates a stack trace instead of unrolling it into the strip", () => {
    const long = "Error: " + "x".repeat(400);
    const out = emptyReason(feed({ error: long }));
    expect(out.length).toBeLessThan(160);
    expect(out).toMatch(/…/);
  });

  it("still distinguishes no-service from no-feeds and a quiet window", () => {
    expect(emptyReason(feed({ feeds: 0 }))).toMatch(/No feeds configured/);
    expect(emptyReason(feed({ feeds: 5, working: 0 }))).toMatch(/connection problem/);
    expect(emptyReason(feed({ feeds: 5, working: 5 }))).toMatch(/Nothing published/);
  });
});
