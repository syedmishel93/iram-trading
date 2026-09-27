import { describe, it, expect } from "vitest";
import {
  corroborate,
  reconcileEvents,
  checkAgainstTape,
  assetsIn,
  similarity,
  tokenise,
  trustWeight,
  trustLabel,
  SAME_EVENT_MS,
  REACTION_RATIO,
  type NewsItem,
} from "../src/core/crosscheck";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const news = (source: string, title: string, minsAgo = 1): NewsItem => ({
  source,
  title,
  at: NOW - minsAgo * MIN,
});

describe("tokenise / similarity", () => {
  it("drops punctuation and stopwords", () => {
    expect(tokenise("Binance Will List: SOL (Solana)!")).toEqual(["binance", "list", "sol", "solana"]);
  });

  it("scores identical text 1 and disjoint text 0", () => {
    expect(similarity(tokenise("alpha beta"), tokenise("alpha beta"))).toBe(1);
    expect(similarity(tokenise("alpha beta"), tokenise("gamma delta"))).toBe(0);
  });

  it("is 0 against nothing rather than throwing", () => {
    expect(similarity([], tokenise("alpha"))).toBe(0);
  });
});

describe("assetsIn", () => {
  it("finds tickers and ignores the quote currency", () => {
    expect([...assetsIn("Binance Will List SOLUSDT and ARB")].sort()).toEqual(["ARB", "SOLUSDT"]);
  });

  // Case is the ONLY thing separating a ticker from a product word here.
  it("does not treat title-case product words as tickers", () => {
    expect(assetsIn("Spot Trading Tournament Season 3").size).toBe(0);
  });

  it("excludes quote and product acronyms", () => {
    expect(assetsIn("USDT USDC BTC API VIP").size).toBe(0);
  });
});

describe("corroborate", () => {
  // THE RULE THE MODULE EXISTS FOR: repetition is not corroboration.
  it("counts publishers, not items", () => {
    const stories = corroborate(
      [
        news("binance", "Binance Will List Solana SOL"),
        news("binance", "Binance Will List Solana SOL", 2),
        news("binance", "Binance Will List Solana SOL", 3),
      ],
      { now: NOW },
    );
    expect(stories).toHaveLength(1);
    expect(stories[0]?.items).toHaveLength(3);
    expect(stories[0]?.publishers).toEqual(["binance"]);
    expect(stories[0]?.trust).toBe("single");
  });

  it("marks a story two venues carry as confirmed", () => {
    const stories = corroborate(
      [
        news("binance", "Binance Will Delist ABC Trading Pairs"),
        news("bybit", "Bybit Will Delist ABC Spot Trading Pairs", 5),
      ],
      { now: NOW },
    );
    expect(stories).toHaveLength(1);
    expect(stories[0]?.publishers.sort()).toEqual(["binance", "bybit"]);
    expect(stories[0]?.trust).toBe("confirmed");
  });

  /**
   * MEASURED: on 170 real announcement titles, plain token overlap at 0.7
   * merged 18 of 21 clusters across DIFFERENT assets, because exchange
   * announcements are templated and the ticker is one token in ten.
   */
  it("keeps two templated announcements about different assets apart", () => {
    const stories = corroborate(
      [
        news("binance", "BMT Trading Tournament: Trade to Share Up to 400 BNB Token Vouchers"),
        news("binance", "ENSO Trading Tournament: Trade to Share Up to 400 BNB Token Vouchers", 2),
      ],
      { now: NOW },
    );
    expect(stories).toHaveLength(2);
  });

  // The hole in the loose gate: a headline naming no ticker slipped through
  // and merged with a specific one.
  it("does not let an unnamed headline absorb a named one", () => {
    const stories = corroborate(
      [
        news("binance", "BMT Trading Tournament: Trade to Share Up to 400 BNB Token Vouchers"),
        news("binance", "Spot Trading Tournament Season 3: Trade to Share Up to 400 Token Vouchers", 2),
      ],
      { now: NOW },
    );
    expect(stories).toHaveLength(2);
  });

  it("dates a story from when it broke, not when it was repeated", () => {
    const stories = corroborate(
      [news("binance", "Binance Will List Solana SOL", 1), news("bybit", "Bybit Will List Solana SOL", 90)],
      { now: NOW },
    );
    expect(stories[0]?.at).toBe(NOW - 90 * MIN);
  });

  it("calls an old story stale however many carried it", () => {
    const stories = corroborate(
      [news("binance", "Binance Will List Solana SOL", 5000), news("bybit", "Bybit Will List Solana SOL", 5000)],
      { now: NOW, staleAfterMs: 24 * 60 * 60_000 },
    );
    expect(stories[0]?.trust).toBe("stale");
  });

  it("ranks a corroborated story above a fresher uncorroborated one", () => {
    const stories = corroborate(
      [
        news("binance", "Binance Adds XYZ Perpetual", 1),
        news("binance", "Binance Will Delist ABC Pairs", 60),
        news("bybit", "Bybit Will Delist ABC Trading Pairs", 61),
      ],
      { now: NOW },
    );
    expect(stories[0]?.trust).toBe("confirmed");
    expect(stories[0]?.publishers).toHaveLength(2);
  });

  it("returns nothing for nothing", () => {
    expect(corroborate([], { now: NOW })).toEqual([]);
  });
});

describe("reconcileEvents", () => {
  const ev = (over: Partial<{ at: number; currency: string; title: string; forecast: string; previous: string }> = {}) => ({
    at: NOW,
    currency: "USD",
    title: "ISM Manufacturing PMI",
    forecast: "55.2",
    previous: "55.6",
    ...over,
  });

  /**
   * THE MOST IMPORTANT TEST IN THE FILE. The second calendar copy is an hourly
   * snapshot of the SAME upstream feed. Agreement between them means the feed
   * is steady; it does not mean the feed is right. Reporting that as
   * "confirmed" would be the module lying about its own strength.
   */
  it("caps same-origin agreement at consistent, never confirmed", () => {
    const [r] = reconcileEvents([ev()], [ev()], false);
    expect(r?.trust).toBe("consistent");
    expect(r?.note).toMatch(/not that it is right/);
  });

  it("reports genuinely independent agreement as confirmed", () => {
    const [r] = reconcileEvents([ev()], [ev()], true);
    expect(r?.trust).toBe("confirmed");
  });

  it("reports a disagreement without choosing a side", () => {
    const [r] = reconcileEvents([ev()], [ev({ forecast: "54.0" })], false);
    expect(r?.trust).toBe("disputed");
    expect(r?.drift).toEqual([{ field: "forecast", a: "55.2", b: "54.0" }]);
    expect(r?.note).toMatch(/55\.2 vs 54\.0/);
    expect(r?.note).toMatch(/Neither has been chosen/);
    /* The event itself is untouched — nothing is averaged or overwritten. */
    expect(r?.event.forecast).toBe("55.2");
  });

  // A blank field is a source not publishing one, not a source disagreeing.
  it("does not call a missing figure a disagreement", () => {
    const [r] = reconcileEvents([ev()], [ev({ forecast: "" })], false);
    expect(r?.trust).toBe("consistent");
    expect(r?.drift).toEqual([]);
  });

  it("matches across a rounding or DST offset", () => {
    const [r] = reconcileEvents([ev()], [ev({ at: NOW + SAME_EVENT_MS - 1 })], false);
    expect(r?.trust).toBe("consistent");
  });

  it("does not match two releases further apart than the window", () => {
    const [r] = reconcileEvents([ev()], [ev({ at: NOW + SAME_EVENT_MS + 1 })], false);
    expect(r?.trust).toBe("single");
  });

  it("never matches across currencies", () => {
    const [r] = reconcileEvents([ev()], [ev({ currency: "EUR" })], false);
    expect(r?.trust).toBe("single");
  });

  it("says plainly when there is only one source at all", () => {
    const [r] = reconcileEvents([ev()], [], false);
    expect(r?.trust).toBe("single");
    expect(r?.note).toMatch(/Only one calendar source/);
  });

  /**
   * REGRESSION, found in live data. Reusing the NEWS threshold here reported
   * "ISM Manufacturing Prices" as cross-checked against a stored copy that does
   * not contain it: it had matched "ISM Manufacturing PMI" at the same minute,
   * in the same currency, with a Jaccard of exactly 0.50. A false claim that a
   * fact was verified is worse than making no claim at all.
   */
  it("does not match two different releases that share most of their title", () => {
    const [r] = reconcileEvents(
      [ev({ title: "ISM Manufacturing Prices" })],
      [ev({ title: "ISM Manufacturing PMI" })],
      false,
    );
    expect(r?.trust).toBe("single");
  });

  // MEASURED at 0.80 against the real feed, and they are different agencies.
  it("does not match ADP payrolls with the Non-Farm print", () => {
    const [r] = reconcileEvents(
      [ev({ title: "ADP Non-Farm Employment Change" })],
      [ev({ title: "Non-Farm Employment Change" })],
      false,
    );
    expect(r?.trust).toBe("single");
  });

  // Every genuine pair in the live sample scored exactly this.
  it("matches an identical title", () => {
    const [r] = reconcileEvents(
      [ev({ title: "Average Hourly Earnings m/m" })],
      [ev({ title: "Average Hourly Earnings m/m" })],
      false,
    );
    expect(r?.trust).toBe("consistent");
  });

  it("returns one result per primary event", () => {
    expect(reconcileEvents([ev(), ev({ title: "Non-Farm Employment Change" })], [], false)).toHaveLength(2);
  });
});

describe("trust weights", () => {
  it("ranks confirmed above consistent above single", () => {
    expect(trustWeight("confirmed")).toBeGreaterThan(trustWeight("consistent"));
    expect(trustWeight("consistent")).toBeGreaterThan(trustWeight("single"));
  });

  // A disputed release is still a release. Zeroing it would silently delete a
  // real risk because two copies argued about a decimal.
  it("keeps a disputed fact above zero and a stale one at zero", () => {
    expect(trustWeight("disputed")).toBeGreaterThan(0);
    expect(trustWeight("stale")).toBe(0);
  });

  it("has a phrase for every level", () => {
    for (const t of ["confirmed", "single", "disputed", "consistent", "stale"] as const) {
      expect(trustLabel(t).length).toBeGreaterThan(5);
    }
  });
});

describe("checkAgainstTape", () => {
  /** 60 one-minute bars of range 1, with an optional spike at index 30. */
  const tape = (spike: number) => {
    const n = 60;
    const t = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      t[i] = NOW + i * MIN;
      l[i] = 100;
      h[i] = 100 + (i === 30 ? spike : 1);
    }
    return { t, h, l, length: n };
  };

  it("confirms the schedule when the tape reacted", () => {
    const r = checkAgainstTape(NOW + 30 * MIN, tape(6), 5 * MIN);
    expect(r?.reacted).toBe(true);
    expect(r?.ratio).toBeCloseTo(6, 5);
    expect(r?.note).toMatch(/the tape reacted/);
  });

  it("reports a quiet window as a schedule that did not hold", () => {
    const r = checkAgainstTape(NOW + 30 * MIN, tape(1), 5 * MIN);
    expect(r?.reacted).toBe(false);
    expect(r?.note).toMatch(/nothing visible happened/);
  });

  it("sits exactly on the threshold as a reaction", () => {
    const r = checkAgainstTape(NOW + 30 * MIN, tape(REACTION_RATIO), 5 * MIN);
    expect(r?.reacted).toBe(true);
  });

  // Refusing to answer is the correct answer when there is nothing to look at.
  it("returns null when the release is outside the loaded bars", () => {
    expect(checkAgainstTape(NOW - 10_000 * MIN, tape(6), 5 * MIN)).toBeNull();
  });

  it("returns null on too little history to have a typical bar", () => {
    const t = new Float64Array(5);
    const h = new Float64Array(5);
    const l = new Float64Array(5);
    expect(checkAgainstTape(NOW, { t, h, l, length: 5 }, 5 * MIN)).toBeNull();
  });

  it("returns null when every bar is flat, rather than dividing by zero", () => {
    const n = 40;
    const t = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      t[i] = NOW + i * MIN;
      h[i] = 100;
      l[i] = 100;
    }
    expect(checkAgainstTape(NOW + 10 * MIN, { t, h, l, length: n }, 5 * MIN)).toBeNull();
  });
});
