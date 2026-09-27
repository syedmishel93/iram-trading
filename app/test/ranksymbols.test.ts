import { describe, expect, it } from "vitest";
import { quoteTier, rankSymbols, type SymbolEntry } from "../src/data/catalogue";

const entry = (symbol: string, volume: number): SymbolEntry => ({
  symbol,
  volume,
  source: "binance",
  tier: quoteTier(symbol),
});

/**
 * A slice of the real Binance universe, with real relative volumes and the
 * real near-dead `…U` listings that broke the old ranking. Every symbol here
 * was confirmed TRADING against `/api/v3/exchangeInfo` at the time of writing.
 */
const POOL: SymbolEntry[] = [
  entry("BTCUSDT", 2_400_000_000),
  entry("ETHUSDT", 1_100_000_000),
  entry("SOLUSDT", 620_000_000),
  entry("XRPUSDT", 410_000_000),
  entry("DOGEUSDT", 180_000_000),
  entry("ADAUSDT", 95_000_000),
  entry("ETHBTC", 60_000_000),
  entry("BTCUSDC", 40_000_000),
  entry("ETHUSDC", 30_000_000),
  entry("BTCEUR", 12_000_000),
  entry("ETHEUR", 9_000_000),
  /* The ghosts: real listings, near-zero volume, and SHORTER than the pairs
     anyone means — which is exactly why a bare fuzzy sort promoted them. */
  entry("BTCU", 900),
  entry("ETHU", 700),
  entry("SOLU", 500),
  entry("XRPU", 400),
  entry("DOGEU", 300),
  entry("ADAU", 200),
  entry("BTCUSD", 5_000_000),
  entry("ETHUSD", 4_000_000),
  entry("BTCDOWNUSDT", 1_200),
  entry("BTSBTC", 800),
];

const top = (q: string): string => rankSymbols(POOL, q, 10)[0]!.item.symbol;
const topN = (q: string, n: number): string[] =>
  rankSymbols(POOL, q, n).map((r) => r.item.symbol);

describe("rankSymbols — the regression that shipped", () => {
  /**
   * Measured against the live universe (3,645 listings) BEFORE the fix. Not one
   * of these returned the pair the user meant; each returned the near-dead
   * short listing instead. This table is the bug, frozen.
   */
  const MEANT: Array<[string, string]> = [
    ["BT", "BTCUSDT"],
    ["BTC", "BTCUSDT"],
    ["ETH", "ETHUSDT"],
    ["SOL", "SOLUSDT"],
    ["XRP", "XRPUSDT"],
    ["DOGE", "DOGEUSDT"],
    ["ADA", "ADAUSDT"],
  ];

  for (const [query, expected] of MEANT) {
    it(`"${query}" returns ${expected}, not the short ghost listing`, () => {
      expect(top(query)).toBe(expected);
    });
  }

  it("honours the claim in the module header: BT does not return BTCDOWNUSDT", () => {
    expect(top("BT")).toBe("BTCUSDT");
    expect(topN("BT", 3)).not.toContain("BTCDOWNUSDT");
  });
});

describe("rankSymbols — ordering rules", () => {
  it("an exact ticker wins, even when it is a dead one", () => {
    /* You typed the whole thing. ETHU really does mean ETHU. */
    expect(top("ETHU")).toBe("ETHU");
    expect(top("BTCU")).toBe("BTCU");
  });

  it("prefix hits beat mid-string hits", () => {
    /* BTSBTC contains "BTC" but does not start with it. */
    const order = topN("BTC", 10);
    expect(order.indexOf("BTCUSDT")).toBeLessThan(order.indexOf("BTSBTC"));
  });

  it("sorts by quote tier before volume, so a dollar pair leads", () => {
    const order = topN("ETH", 10);
    expect(order.indexOf("ETHUSDT")).toBeLessThan(order.indexOf("ETHBTC"));
    expect(order.indexOf("ETHUSDC")).toBeLessThan(order.indexOf("ETHEUR"));
  });

  it("sorts by volume within a tier", () => {
    const order = topN("BTC", 10);
    expect(order.indexOf("BTCUSDT")).toBeLessThan(order.indexOf("BTCUSDC"));
  });

  it("an empty query returns the pool head untouched — it is already ranked", () => {
    expect(topN("", 3)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });

  it("still finds the split-leg haystack: 'btc usd' reaches BTCUSDT", () => {
    expect(topN("btc usd", 5)).toContain("BTCUSDT");
  });

  it("is case-insensitive", () => {
    expect(top("eth")).toBe("ETHUSDT");
    expect(top("  Eth  ")).toBe("ETHUSDT");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(rankSymbols(POOL, "ZZZZZZZZ", 10)).toHaveLength(0);
  });

  it("respects the limit", () => {
    expect(rankSymbols(POOL, "USDT", 3)).toHaveLength(3);
  });

  it("ranks over the whole pool, not a fuzzy-scored head", () => {
    /* The high-volume pair must survive even when the limit is 1 and dozens of
       shorter ghosts score better on fuzzy alone. */
    expect(rankSymbols(POOL, "ETH", 1)[0]!.item.symbol).toBe("ETHUSDT");
  });

  it("keeps positions for highlighting", () => {
    const hit = rankSymbols(POOL, "BTC", 1)[0]!;
    expect(hit.positions.length).toBeGreaterThan(0);
  });
});
