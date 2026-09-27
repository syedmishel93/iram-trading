// @vitest-environment jsdom
/**
 * Review — the six pattern checks, your judgements, your committed rules, and
 * the section on screen.
 *
 * Fixtures are the REAL record types: `JournalEntry` from the journal,
 * `Fill` (`FillTrade` + `FillRecon`) from `/svc/recon`, and a `CalendarFeed`
 * of `ReconciledEvent<EconEvent>`. Every expected number is worked by hand in
 * the comment beside it, never read back from the code under test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import type { Fill, FillRecon, FillTrade } from "../src/data/fills";
import type { CalendarFeed, EconEvent } from "../src/data/calendar";
import {
  calendarWindow,
  checkPatterns,
  fromFills,
  fromJournal,
  MIN_GROUP,
  MIN_TRADES,
  proposeRule,
  type Pattern,
  type PatternId,
  type ReviewTrade,
} from "../src/journal/patterns";
import { createReviewStore } from "../src/journal/review";
import { createSayStore, PASS_REASONS, type Say } from "../src/journal/says";
import { createJournal } from "../src/journal/store";
import { createKV, memoryRawStore, type KV } from "../src/store/kv";
import { createJournalDesk } from "../src/ui/journal";

const H = 3_600_000;
const DAY = 24 * H;
/** Monday 2026-09-14 00:00 UTC. */
const T0 = Date.UTC(2026, 8, 14);

let seq = 0;
/** A closed long: entry 100, stop 90 (risk 10). exit 110 = +1R win, exit 90 = -1R loss. */
function je(openedAt: number, win: boolean, over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `j${seq}`,
    openedAt,
    closedAt: openedAt + H,
    symbol: "EURUSD",
    timeframe: "1h",
    direction: "long",
    entry: 100,
    stop: 90,
    target: 120,
    exit: win ? 110 : 90,
    size: 1,
    setupKind: null,
    scoreAtEntry: null,
    gatesBlocking: [],
    adherence: "as-planned",
    note: "",
    source: "test",
    quality: "live",
    ...over,
  };
}

function fill(id: number, openMs: number, net: number, recon: Partial<FillRecon> | null = null): Fill {
  const trade: FillTrade = {
    position_id: id,
    symbol: "EURUSD",
    side: "long",
    volume: 1,
    entry_price: 1.1,
    exit_price: 1.105,
    open_ms: openMs,
    close_ms: openMs + H,
    hold_ms: H,
    commission: 0,
    swap: 0,
    gross_profit: net,
    net_profit: net,
    partial_fills: false,
    comment: "",
  };
  return {
    trade,
    recon:
      recon === null
        ? null
        : { position_id: id, planned: true, slippage_R: 0, net_R: 1, gross_R: 1, exit_reason: "t1", followed_plan: true, notes: [], ...recon },
  };
}

function ev(at: number, currency: string, impact: EconEvent["impact"]): EconEvent {
  return { at, currency, title: `${currency} release`, impact, forecast: "", previous: "" };
}

function feed(events: readonly EconEvent[]): CalendarFeed {
  return {
    ok: true,
    route: "live",
    events: events.map((event) => ({ event, trust: "single" as const, drift: [], note: "" })),
    asOf: T0,
    provenance: "test",
    error: "",
  };
}

const find = (ps: readonly Pattern[], id: PatternId): Pattern => {
  const p = ps.find((x) => x.id === id);
  if (!p) throw new Error(`no pattern ${id}`);
  return p;
};

const run = (journal: readonly JournalEntry[], cal: CalendarFeed | null = null, fills: readonly Fill[] = []): Pattern[] =>
  checkPatterns({ journal: fromJournal(journal), fills: fromFills(fills), calendar: calendarWindow(cal) });

/* ------------------------------------------------------------ adapters --- */

describe("adapters", () => {
  it("fromJournal keeps closed trades only, with R and the planned target", () => {
    const open = je(T0, true, { exit: null, closedAt: null });
    const t = fromJournal([open, je(T0 + H, true)]);
    expect(t).toHaveLength(1);
    // exit 110 on entry 100 stop 90 = +1R; target 120 = +2R planned.
    expect(t[0]?.r).toBeCloseTo(1, 10);
    expect(t[0]?.plannedR).toBeCloseTo(2, 10);
    expect(t[0]?.result).toBe("win");
    expect(t[0]?.htf).toBeNull();
  });

  it("fromFills takes R from the server's grade, else the SIGN of net profit, and never a planned target", () => {
    const t = fromFills([fill(1, T0, 50, { net_R: -0.05 }), fill(2, T0 + H, -20)]);
    // -0.05R is inside the 0.1R scratch band -> breakeven, though net was +50.
    expect(t[0]?.result).toBe("breakeven");
    expect(t[1]?.result).toBe("loss");
    expect(t[1]?.r).toBeNull();
    expect(t.every((x) => x.plannedR === null)).toBe(true);
  });
});

/* ---------------------------------------------------------------- news --- */

describe("news proximity", () => {
  /* Eight high-impact USD releases, one a day at 12:30 UTC, and a medium one
     a day after the last so the calendar's span covers every trade. Near:
     opened 10 min after a release. Away: opened 6h after. */
  const releases = Array.from({ length: 8 }, (_, i) => T0 + i * DAY + 12.5 * H);
  const cal = feed([...releases.map((at) => ev(at, "USD", "high")), ev(T0 + 9 * DAY, "USD", "medium")]);
  const trades = (nearLosses: number, awayLosses: number): JournalEntry[] => [
    ...releases.map((at, i) => je(at + 10 * 60_000, i >= nearLosses)),
    ...releases.map((at, i) => je(at + 6 * H, i >= awayLosses)),
  ];

  it("found: 6 of 8 near news lost against 1 of 8 away", () => {
    // Gap 75% - 12.5% = 62.5 points. Pooled 7/16; se = sqrt(.4375*.5625*(1/8+1/8)) = .248; z = 2.52; p ~ .012.
    const p = find(run(trades(6, 1), cal), "news");
    expect(p.state).toBe("found");
    expect(p.n).toBe(16);
    expect(p.claim).toBe("Losses cluster within 30 min of high-impact news: 6 of 8 lost, against 13% otherwise.");
    expect(p.numbers.find((x) => x.label === "Near news, lost")?.value).toBe("6 of 8");
    expect(p.rule).toMatch(/30 minutes of high-impact news/);
  });

  it("not-found: the same loss rate near and away", () => {
    const p = find(run(trades(2, 2), cal), "news");
    expect(p.state).toBe("not-found");
    expect(p.reason).toMatch(/gap is 0 points/);
    expect(p.rule).toBeNull();
  });

  it("a release in a currency the pair does not carry does not count as near", () => {
    const jpy = feed([...releases.map((at) => ev(at, "JPY", "high")), ev(T0 + 9 * DAY, "USD", "medium")]);
    const p = find(run(trades(6, 1), jpy), "news");
    // Nothing is near -> the near group is empty -> too few on that side.
    expect(p.state).toBe("too-few");
    expect(p.numbers.find((x) => x.label === "Near news, lost")?.value).toBe("0 of 0");
  });

  it("too-few: only 4 trades inside the calendar's span, and the floor is named", () => {
    const short = feed([ev(releases[0] as number, "USD", "high"), ev((releases[1] as number) + 7 * H, "USD", "low")]);
    const p = find(run(trades(6, 1), short), "news");
    // Inside [day0 12:30, day1 19:30]: two near + two away (day0/day1 at +10m and +6h).
    expect(p.state).toBe("too-few");
    expect(p.n).toBe(4);
    expect(p.minN).toBe(MIN_TRADES);
    expect(p.reason).toContain(`at least ${MIN_TRADES}`);
  });

  it("cannot-check: no calendar at all", () => {
    const p = find(run(trades(6, 1), null), "news");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/calendar/);
  });

  it("cannot-check: the calendar covers a week none of the trades is in", () => {
    const later = feed([ev(T0 + 30 * DAY, "USD", "high"), ev(T0 + 31 * DAY, "USD", "high")]);
    const p = find(run(trades(6, 1), later), "news");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/no trade was opened in that span/);
  });
});

/* --------------------------------------------------------------- trend --- */

describe("against the higher-timeframe trend", () => {
  const withHtf = (htf: "with" | "against", wins: number, n: number, start: number): ReviewTrade[] =>
    fromJournal(Array.from({ length: n }, (_, i) => je(start + i * H, i < wins))).map((t) => ({ ...t, htf }));
  const check = (ts: readonly ReviewTrade[]): Pattern =>
    find(checkPatterns({ journal: ts, fills: [], calendar: null }), "trend");

  it("cannot-check on every real record: neither source records the trend, and the field is named", () => {
    const p = find(run(Array.from({ length: 12 }, (_, i) => je(T0 + i * H, i % 2 === 0))), "trend");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/Missing field: the higher-timeframe trend at entry/);
  });

  it("found: win rate 25% against vs 88% with", () => {
    // Against 2/8 won, with 7/8 won: non-win rate 75% vs 12.5%, p ~ .012 (same arithmetic as news).
    const p = check([...withHtf("against", 2, 8, T0), ...withHtf("with", 7, 8, T0 + DAY)]);
    expect(p.state).toBe("found");
    expect(p.claim).toBe("Trades against the higher-timeframe trend: win rate 25% vs 88% with it.");
  });

  it("not-found: the same win rate either way", () => {
    expect(check([...withHtf("against", 4, 8, T0), ...withHtf("with", 4, 8, T0 + DAY)]).state).toBe("not-found");
  });

  it("too-few: 4 against", () => {
    const p = check([...withHtf("against", 1, 4, T0), ...withHtf("with", 7, 8, T0 + DAY)]);
    expect(p.state).toBe("too-few");
    expect(p.reason).toContain(`at least ${MIN_GROUP}`);
  });
});

/* ---------------------------------------------------------- early exit --- */

describe("early exits against the plan", () => {
  // entry 100, stop 90, target 130 -> planned +3R.
  const winners = (exit: number, n: number): JournalEntry[] =>
    Array.from({ length: n }, (_, i) => je(T0 + i * H, true, { target: 130, exit }));

  it("found: median exit 0.8R against plan 3.0R", () => {
    // exit 108 = +0.8R; 0.8 / 3.0 = 27% of plan, under the 60% line.
    const p = find(run(winners(108, 6)), "early-exit");
    expect(p.state).toBe("found");
    expect(p.claim).toBe("You cut winners early: median exit at 0.8R vs plan 3.0R.");
    expect(p.numbers.find((x) => x.label === "Closed short of target")?.value).toBe("6 of 6");
  });

  it("not-found: winners run to 2.8R of a 3R plan", () => {
    expect(find(run(winners(128, 6)), "early-exit").state).toBe("not-found");
  });

  it("too-few: 4 winners with a plan, and the floor is named", () => {
    const p = find(run(winners(108, 4)), "early-exit");
    expect(p.state).toBe("too-few");
    expect(p.minN).toBe(MIN_GROUP);
    expect(p.reason).toContain(`at least ${MIN_GROUP}`);
  });

  it("cannot-check: no trade carries a planned target", () => {
    const p = find(run(Array.from({ length: 6 }, (_, i) => je(T0 + i * H, true, { target: null }))), "early-exit");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/Missing field: planned target/);
  });

  it("cannot-check with fills only: MT5 fills do not carry a target, and it says so", () => {
    const fills = Array.from({ length: 12 }, (_, i) => fill(i + 1, T0 + i * H, 10));
    const p = find(run([], null, fills), "early-exit");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/MT5 fills do not carry one/);
    expect(p.source).toBe("journal");
  });
});

/* ------------------------------------------------------------- session --- */

describe("session concentration", () => {
  const at = (hourUtc: number, i: number): number => T0 + i * DAY + hourUtc * H;
  const book = (londonLosses: number, asiaLosses: number): JournalEntry[] => [
    ...Array.from({ length: 8 }, (_, i) => je(at(8, i), i >= londonLosses)),
    ...Array.from({ length: 8 }, (_, i) => je(at(2, i), i >= asiaLosses)),
  ];

  it("found: 6 of 8 London trades lost against 1 of 8 elsewhere", () => {
    // Two sessions have 5+ trades on both sides -> test level .05 / 2 = .025; p ~ .012 clears it.
    const p = find(run(book(6, 1)), "session");
    expect(p.state).toBe("found");
    expect(p.claim).toBe("Losses bunch in the London session: 6 of 8 lost, against 13% at other hours.");
    expect(p.rule).toMatch(/London \(07:00–12:00 UTC\)/);
  });

  it("not-found: an even spread", () => {
    expect(find(run(book(3, 3)), "session").state).toBe("not-found");
  });

  it("too-few: 6 trades, and the floor is named", () => {
    const p = find(run(book(6, 1).slice(0, 6)), "session");
    expect(p.state).toBe("too-few");
    expect(p.reason).toContain(`at least ${MIN_TRADES}`);
  });
});

/* ------------------------------------------------------------- holding --- */

describe("holding time", () => {
  const book = (loserHours: number, winnerHours: number, losers = 6, winners = 6): JournalEntry[] => [
    ...Array.from({ length: losers }, (_, i) => {
      const o = T0 + i * DAY;
      return je(o, false, { closedAt: o + loserHours * H + i * 60_000 });
    }),
    ...Array.from({ length: winners }, (_, i) => {
      const o = T0 + (i + 10) * DAY;
      return je(o, true, { closedAt: o + winnerHours * H + i * 60_000 });
    }),
  ];

  it("found: losers held ~5h, winners ~1h", () => {
    // Complete separation, 6 v 6: U = 36, mean 18, sd sqrt(39) = 6.24, z = 2.88, p ~ .004.
    const p = find(run(book(5, 1)), "holding");
    expect(p.state).toBe("found");
    expect(p.claim).toMatch(/^You hold losers longer: median 5h \d+m against 1h \d+m for winners\.$/);
  });

  it("not-found: the same holding time", () => {
    expect(find(run(book(2, 2)), "holding").state).toBe("not-found");
  });

  it("too-few: 3 losers", () => {
    const p = find(run(book(5, 1, 3, 8)), "holding");
    expect(p.state).toBe("too-few");
    expect(p.reason).toContain(`at least ${MIN_GROUP}`);
  });

  it("cannot-check: no trade records its close time", () => {
    const p = find(run(Array.from({ length: 12 }, (_, i) => je(T0 + i * H, i % 2 === 0, { closedAt: null }))), "holding");
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/Missing field: close time/);
  });
});

/* ---------------------------------------------------------- after loss --- */

describe("after a loss", () => {
  const book = (results: string): JournalEntry[] => [...results].map((r, i) => je(T0 + i * H, r === "W"));

  it("found: 6 of 8 trades after a loss also lost, against 1 of 8 otherwise", () => {
    // L W WWWWWWW L LLLLLL W: after-L = idx 1, 10-15, 16 (8, six lost); after-W = idx 2-9 (8, one lost: idx 9).
    const p = find(run(book("LWWWWWWWWLLLLLLLW")), "after-loss");
    expect(p.state).toBe("found");
    expect(p.claim).toBe("Losses follow losses: after a loss, 6 of 8 next trades also lost, against 13% otherwise.");
  });

  it("not-found: alternating wins and losses", () => {
    expect(find(run(book("WLWLWLWLWLWLWLWLW")), "after-loss").state).toBe("not-found");
  });

  it("too-few: 5 trades", () => {
    const p = find(run(book("LLWLW")), "after-loss");
    expect(p.state).toBe("too-few");
    expect(p.reason).toContain(`at least ${MIN_TRADES}`);
  });
});

/* ---------------------------------------------------- source selection --- */

describe("which trades are read", () => {
  it("prefers MT5 fills, never both, and every check still reports", () => {
    const fills = Array.from({ length: 12 }, (_, i) => fill(i + 1, T0 + i * H, i % 2 ? 10 : -10));
    const ps = run([je(T0, true)], null, fills);
    expect(ps.map((p) => p.id)).toEqual(["news", "trend", "early-exit", "session", "holding", "after-loss", "passes"]);
    expect(find(ps, "after-loss").source).toBe("fills");
    // 12 fills, not 13: the journal trade is not added on top.
    expect(find(ps, "after-loss").n).toBe(12);
  });
});

/* ------------------------------------------------------ what you pass on --- */

describe("what you pass on (decision log)", () => {
  const say = (i: number, choice: Say["choice"], reason = ""): Say => ({
    at: T0 + i * H, key: `k${i}`, symbol: "EURUSD", timeframe: "1h", verdict: "go",
    direction: "long", choice, reason,
  });
  const NEWS = PASS_REASONS[2];
  const LATE = PASS_REASONS[0];
  const passes = (spec: readonly (readonly [string, number])[]): Say[] => {
    let i = 0;
    return spec.flatMap(([reason, n]) => Array.from({ length: n }, () => say(i++, "pass", reason)));
  };
  const check = (says: readonly Say[] | null): Pattern =>
    find(checkPatterns({ journal: [], fills: [], calendar: null, says }), "passes");

  it("found: 7 of 12 passes were 'News is too close' — counted, never graded", () => {
    // 7 / 12 = 58%, over the 50% line.
    const p = check([...passes([[NEWS, 7], [LATE, 3], ["Other", 2]]), say(99, "use")]);
    expect(p.state).toBe("found");
    expect(p.claim).toBe(`Most of your passes are for one reason: "${NEWS}" — 7 of 12.`);
    expect(p.numbers.find((x) => x.label === "Passed / taken or adjusted")?.value).toBe("12 / 1");
    expect(p.reason).toMatch(/not measured/);
    // A pass has no result: nothing to build a rule on.
    expect(p.rule).toBeNull();
  });

  it("not-found: spread across reasons; 'Other' never counts as the pattern", () => {
    // Other is 8 of 12 but excluded; the top named reason is 2 of 12 = 17%.
    const p = check(passes([["Other", 8], [NEWS, 2], [LATE, 2]]));
    expect(p.state).toBe("not-found");
  });

  it("too-few: 4 passes, and the floor is named", () => {
    const p = check(passes([[NEWS, 4]]));
    expect(p.state).toBe("too-few");
    expect(p.n).toBe(4);
    expect(p.reason).toContain(`at least ${MIN_TRADES}`);
  });

  it("cannot-check: no decision log passed in, and the source is named", () => {
    const p = check(null);
    expect(p.state).toBe("cannot-check");
    expect(p.reason).toMatch(/decision log/);
  });

  it("reads the real store from the same KV the desk is given", () => {
    const kv = createKV(memoryRawStore());
    const st = createSayStore(kv);
    passes([[NEWS, 10]]).forEach((x) => st.record(x));
    expect(check(st.all()).state).toBe("found");
  });
});

/* -------------------------------------------------------- rule proposal --- */

describe("proposeRule", () => {
  const pat = (id: PatternId, strength: number, state: Pattern["state"] = "found"): Pattern => ({
    id,
    check: id,
    claim: `claim ${id}`,
    numbers: [],
    n: 12,
    minN: 10,
    state,
    reason: "",
    working: "",
    source: "journal",
    strength,
    rule: state === "found" ? `rule ${id}` : null,
  });
  const ps = [pat("news", 0.62), pat("holding", 0.8), pat("session", 0, "too-few")];

  it("nothing judged -> no proposal", () => {
    expect(proposeRule(ps, () => null)).toBeNull();
  });

  it("proposes from the strongest pattern YOU confirmed, not the strongest found", () => {
    const r = proposeRule(ps, (id) => (id === "news" ? "true" : null));
    expect(r).toEqual({ from: "news", text: "rule news", claim: "claim news" });
  });

  it("the strongest wins when both are confirmed; a rejected one never does", () => {
    expect(proposeRule(ps, () => "true")?.from).toBe("holding");
    expect(proposeRule(ps, (id) => (id === "holding" ? "false" : "true"))?.from).toBe("news");
  });

  it("a pattern judged true that no longer shows is not proposed", () => {
    expect(proposeRule(ps, (id) => (id === "session" ? "true" : null))).toBeNull();
  });
});

/* ----------------------------------------------------------- the store --- */

describe("review store", () => {
  const okFetch = () =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, revs: { "review.rules": 1 } }), { status: 200 }));

  it("judgements persist across a reload of the store", () => {
    const kv = createKV(memoryRawStore());
    const a = createReviewStore(kv, { now: () => T0, fetch: null });
    a.judge("news", "true", "claim then");
    const b = createReviewStore(kv, { fetch: null });
    expect(b.verdict("news")).toEqual({ verdict: "true", at: T0, claim: "claim then" });
    b.unjudge("news");
    expect(createReviewStore(kv, { fetch: null }).verdict("news")).toBeNull();
  });

  it("commit persists with its date and source, refuses empty and duplicate rules", async () => {
    const kv = createKV(memoryRawStore());
    const f = okFetch();
    const s = createReviewStore(kv, { now: () => T0, fetch: f as unknown as typeof fetch, base: () => "http://127.0.0.1:8787" });
    expect(s.commit("   ", null, "").ok).toBe(false);
    const r = s.commit("  No trades near news.  ", "news", "claim news");
    expect(r.ok).toBe(true);
    expect(s.commit("No trades near news.", null, "").ok).toBe(false);

    const again = createReviewStore(kv, { fetch: null });
    expect(again.rules()).toHaveLength(1);
    expect(again.rules()[0]).toMatchObject({ text: "No trades near news.", at: T0, from: "news", because: "claim news" });

    // The server copy: parsed from what fetch was actually called with.
    await vi.waitFor(() => expect(s.server()?.state).toBe("saved"));
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/svc/kv");
    expect(JSON.parse(String(init.body))).toMatchObject({ k: "review.rules", v: [{ text: "No trades near news." }] });
  });

  it("a server that does not answer leaves the rule saved in the browser, and says so", async () => {
    const kv = createKV(memoryRawStore());
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const s = createReviewStore(kv, { fetch: f as unknown as typeof fetch, base: () => "http://127.0.0.1:9" });
    s.commit("Rule", null, "");
    await vi.waitFor(() => expect(s.server()?.state).toBe("browser-only"));
    expect(createReviewStore(kv, { fetch: null }).rules()).toHaveLength(1);
  });

  it("with no KV it works in memory and admits it", () => {
    const s = createReviewStore(null, { fetch: null });
    expect(s.memoryOnly).toBe(true);
    const r = s.commit("Rule", null, "");
    expect(r.ok && r.local).toMatch(/this session only/);
  });
});

/* ------------------------------------------------------------ on screen --- */

describe("the Review section in the Journal desk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const stubEmptyRecon = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, empty: true }), { status: 200 })),
    );

  const desk = (kv: KV, entries: readonly JournalEntry[] = []) => {
    const journal = createJournal(kv);
    if (entries.length) journal.merge(entries);
    const { el } = createJournalDesk({
      journal,
      kv,
      context: () => ({
        symbol: "EURUSD", timeframe: "1h", direction: "long", entry: null, stop: null, target: null,
        setupKind: null, score: null, gatesBlocking: [], source: "test", quality: "live",
      }),
      price: () => null,
      notify: () => {},
    });
    document.body.appendChild(el);
    return el;
  };

  it("with no trades shows the honest empty state and no findings", async () => {
    stubEmptyRecon();
    const el = desk(createKV(memoryRawStore()));
    const rv = el.querySelector(".rv") as HTMLElement;
    expect(rv.querySelector(".rv-title")?.textContent).toBe("The AI studies your trades. You decide what's true.");
    await vi.waitFor(() => expect(rv.textContent).toContain("No closed trades yet, so there is nothing to study."));
    expect(rv.querySelectorAll(".rv-find")).toHaveLength(0);
    expect(rv.querySelector(".card-who[data-who='ai']")?.textContent).toBe("AI");
    expect(rv.querySelector(".card-who[data-who='you']")?.textContent).toBe("You");
    // Nothing from the mockup's fixture leaks in.
    expect(rv.textContent).not.toMatch(/EURUSD trades both followed|Sample rows/);
  });

  it("shows a found pattern; True -> proposal in the box -> Commit lists the rule with its date", async () => {
    stubEmptyRecon();
    const kv = createKV(memoryRawStore());
    const at = (hourUtc: number, i: number): number => T0 + i * DAY + hourUtc * H;
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => je(at(8, i), i >= 6)),
      ...Array.from({ length: 8 }, (_, i) => je(at(2, i), i >= 1)),
    ];
    const el = desk(kv, entries);
    const rv = el.querySelector(".rv") as HTMLElement;
    await vi.waitFor(() => expect(rv.querySelector(".rv-find[data-pattern='session']")).not.toBeNull());
    // Every check is listed under "What was checked", found or not.
    expect(rv.querySelectorAll(".rv-check")).toHaveLength(7);
    expect(rv.querySelector(".rv-check[data-pattern='trend']")?.getAttribute("data-state")).toBe("cannot-check");

    const trueBtn = [...rv.querySelectorAll<HTMLButtonElement>(".rv-find[data-pattern='session'] button")].find((b) => b.textContent === "True");
    trueBtn?.click();
    const box = rv.querySelector(".rv-box") as HTMLTextAreaElement;
    await vi.waitFor(() => expect(box.value).toMatch(/No new trades in the London/));
    expect(createReviewStore(kv, { fetch: null }).verdict("session")?.verdict).toBe("true");

    (rv.querySelector(".rv-commit") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(rv.querySelector(".rv-rule-text")?.textContent).toMatch(/No new trades in the London/));
    expect(rv.querySelector(".rv-done")?.textContent).toMatch(/^Committed\. Saved in this browser\./);
    expect(createReviewStore(kv, { fetch: null }).rules()).toHaveLength(1);
  });
});
