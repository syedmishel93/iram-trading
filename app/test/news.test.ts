import { describe, it, expect } from "vitest";
import { parseBinance, parseBybit } from "../src/data/news";

/** The exact shapes the two venues return — captured from them, not invented. */
const BINANCE = {
  data: {
    catalogs: [
      {
        catalogId: 48,
        catalogName: "New Cryptocurrency Listing",
        articles: [
          {
            id: 283381,
            code: "6e9e9784397745f4a49d3f69b1cfebda",
            title: "Binance Futures Will Launch USDT-Margined SOL Perpetual Contract",
            releaseDate: 1788078914398,
          },
        ],
      },
      {
        catalogId: 93,
        catalogName: "Latest Activities",
        articles: [
          {
            id: 1,
            code: "promo",
            title: "BMT Trading Tournament: Trade to Share Up to 400 BNB Token Vouchers",
            releaseDate: 1788078000000,
          },
        ],
      },
    ],
  },
};

const BYBIT = {
  result: {
    list: [
      {
        title: "Crypto bull is back: Join the squeeze to earn a share of 200K USDT",
        type: { key: "latest_activities", title: "Latest Activities" },
        publishTime: 1787558003000,
        dateTimestamp: 1787529600000,
        url: "https://announcements.bybit.com/en-US/article/promo/",
      },
      {
        title: "Bybit Will Delist ABC Spot Trading Pairs",
        type: { key: "delistings", title: "Delistings" },
        publishTime: 1788000000000,
        dateTimestamp: 1788600000000,
        url: "https://announcements.bybit.com/en-US/article/delist/",
      },
    ],
  },
};

describe("parseBinance", () => {
  /**
   * MEASURED: of 170 titles pulled while building this, a large share were
   * tournaments and "earn up to" promotions. A news panel that shows those is
   * an advertising panel.
   */
  it("keeps listings and drops promotions", () => {
    const items = parseBinance(BINANCE);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toMatch(/SOL Perpetual/);
    expect(items[0]?.category).toBe("New Cryptocurrency Listing");
  });

  it("attributes to the publisher, which is what corroboration counts", () => {
    expect(parseBinance(BINANCE)[0]?.source).toBe("Binance");
  });

  it("builds a link from the article code", () => {
    expect(parseBinance(BINANCE)[0]?.url).toBe(
      "https://www.binance.com/en/support/announcement/6e9e9784397745f4a49d3f69b1cfebda",
    );
  });

  it("carries the publish time through unchanged", () => {
    expect(parseBinance(BINANCE)[0]?.at).toBe(1788078914398);
  });

  it("survives a body that is not the shape it expects", () => {
    expect(parseBinance(null)).toEqual([]);
    expect(parseBinance({ data: {} })).toEqual([]);
    expect(parseBinance({ data: { catalogs: "nope" } })).toEqual([]);
  });

  it("skips an article with no title or no date rather than inventing one", () => {
    const raw = {
      data: {
        catalogs: [
          {
            catalogName: "New Cryptocurrency Listing",
            articles: [{ title: "", releaseDate: 1 }, { title: "X" }],
          },
        ],
      },
    };
    expect(parseBinance(raw)).toEqual([]);
  });

  /* An allowlist, not a blocklist: a category the venue invents tomorrow must
     stay out by default rather than silently appear in the panel. */
  it("excludes an unknown category by default", () => {
    const raw = {
      data: {
        catalogs: [
          { catalogName: "Brand New Promo Type", articles: [{ title: "Win a car", releaseDate: 1 }] },
        ],
      },
    };
    expect(parseBinance(raw)).toEqual([]);
  });
});

describe("parseBybit", () => {
  it("keeps a delisting and drops a trading competition", () => {
    const items = parseBybit(BYBIT);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toMatch(/Delist ABC/);
    expect(items[0]?.source).toBe("Bybit");
  });

  /**
   * `dateTimestamp` is when the described event happens and can be in the
   * FUTURE; `publishTime` is when the news broke. Using the wrong one would
   * date a delisting announcement to the delisting itself.
   */
  it("dates the item by when it was published, not when the event happens", () => {
    expect(parseBybit(BYBIT)[0]?.at).toBe(1788000000000);
  });

  it("keeps the venue's own link", () => {
    expect(parseBybit(BYBIT)[0]?.url).toMatch(/announcements\.bybit\.com/);
  });

  it("survives a body that is not the shape it expects", () => {
    expect(parseBybit(null)).toEqual([]);
    expect(parseBybit({ result: {} })).toEqual([]);
  });

  it("excludes an unknown category by default", () => {
    const raw = { result: { list: [{ title: "X", publishTime: 1, type: { key: "brand_new" } }] } };
    expect(parseBybit(raw)).toEqual([]);
  });
});
