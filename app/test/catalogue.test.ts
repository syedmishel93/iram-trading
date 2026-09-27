import { describe, it, expect, vi } from "vitest";
import {
  createCatalogue,
  quoteTier,
  symbolHaystacks,
  SEED_SYMBOLS,
  CATALOGUE_TTL_MS,
} from "../src/data/catalogue";
import { CLASS_TABS, classTab, instrumentEntries } from "../src/data/catalogue";
import { createKV, memoryRawStore } from "../src/store/kv";
import { rank } from "../src/core/fuzzy";

const kv = () => createKV(memoryRawStore());

const universe = (rows: { symbol: string; quoteVolume: number }[]) =>
  rows.map((r) => ({ ...r, changePct: 0, lastPrice: 1 }));

describe("quoteTier", () => {
  it("puts dollar-quoted pairs first", () => {
    expect(quoteTier("BTCUSDT")).toBe(0);
    expect(quoteTier("ETHUSDC")).toBe(0);
    expect(quoteTier("SOLFDUSD")).toBe(0);
  });

  it("puts major-crypto quotes second", () => {
    expect(quoteTier("ETHBTC")).toBe(1);
    expect(quoteTier("SOLETH")).toBe(1);
  });

  // The bug this exists for.
  it("demotes exotic fiat quotes", () => {
    expect(quoteTier("BTCBIDR")).toBe(2);
    expect(quoteTier("ETHBIDR")).toBe(2);
    expect(quoteTier("USDTIDRT")).toBe(2);
  });

  it("does not treat a symbol that IS the quote as quoted in it", () => {
    expect(quoteTier("USDT")).toBe(2);
    expect(quoteTier("BTC")).toBe(2);
  });
});

describe("createCatalogue", () => {
  /**
   * The offline floor is the crypto seed PLUS the whole instrument table.
   *
   * It used to be the seed alone, which is how forex became unfindable: five
   * FX and metal symbols, appended at volume 0 behind three thousand crypto
   * pairs, under tabs that grouped by quote currency and had no tab for them.
   */
  it("starts from the seed list AND the instrument table before any fetch", () => {
    const c = createCatalogue(kv(), () => new Promise(() => {}));
    const syms = c.symbols();
    expect(syms.length).toBe(
      SEED_SYMBOLS.filter((x) => !instrumentEntries().some((i) => i.symbol === x)).length +
        instrumentEntries().length,
    );
    expect(syms.some((e) => e.symbol === "BTCUSDT" && e.cls === "crypto")).toBe(true);
    expect(syms.some((e) => e.symbol === "EURUSD" && e.cls === "forex")).toBe(true);
    expect(syms.some((e) => e.symbol === "XAUUSD" && e.cls === "metal")).toBe(true);
    expect(syms.some((e) => e.symbol === "AAPL" && e.cls === "stock")).toBe(true);
    expect(c.live()).toBe(false);
  });

  /* The failure this whole change exists to prevent: an FX pair present in the
     data and reachable through no tab in the UI. */
  /**
   * The bug this test exists for, found LIVE and not in the suite.
   *
   * The first version merged the instrument table inside the fetch path only.
   * Every asset-class tab except Crypto was empty on any machine with a warm
   * cache — which is every machine after the first run — because a cached
   * catalogue is returned without going near that code. Cold-start tests all
   * passed.
   */
  it("merges the instrument table into a CACHED catalogue too", async () => {
    const store = kv();
    const first = createCatalogue(store, () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    first.ensure();
    await vi.waitFor(() => expect(first.live()).toBe(true));

    // A second boot reads the cache and must not lose forex.
    const second = createCatalogue(store, () => Promise.reject(new Error("no network")));
    expect(second.symbols().some((e) => e.symbol === "EURUSD" && e.cls === "forex")).toBe(true);
    expect(second.symbols().some((e) => e.symbol === "AAPL" && e.cls === "stock")).toBe(true);
    expect(second.symbols().some((e) => e.symbol === "AAAUSDT")).toBe(true);
  });

  it("caches only what was fetched, never the compiled-in instrument table", () => {
    /* Caching a constant is how the table goes stale the next time it grows. */
    const store = kv();
    const c = createCatalogue(store, () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    c.refresh();
    return vi.waitFor(() => {
      const raw = store.rawEnvelope("catalogue.symbols") as { value: { entries: { symbol: string }[] } };
      expect(raw.value.entries.some((e) => e.symbol === "EURUSD")).toBe(false);
      expect(raw.value.entries.some((e) => e.symbol === "AAAUSDT")).toBe(true);
    });
  });

  /**
   * The second half of the same bug, also found live.
   *
   * A cache written before classes existed held EURUSD, GBPUSD, USDJPY,
   * XAUUSD and XAGUSD with no class. Skipping them as duplicates of the
   * instrument table left the three busiest FX pairs in the world filed under
   * Crypto and missing from the Forex tab.
   */
  it("lets the instrument table override a cached row's class", () => {
    const store = kv();
    store.write(
      { key: "catalogue.symbols", version: 3, fallback: () => ({ at: 0, entries: [] }), validate: (v) => v as never },
      {
        at: Date.now(),
        entries: [
          { symbol: "BTCUSDT", volume: 9, source: "binance", tier: 0, cls: "crypto" },
          // Mis-classified, the way a migrated cache was.
          { symbol: "EURUSD", volume: 0, source: "seed", tier: 0, cls: "crypto" },
          { symbol: "XAUUSD", volume: 0, source: "seed", tier: 0, cls: "crypto" },
        ],
      },
    );
    const c = createCatalogue(store, () => new Promise(() => {}));
    const eur = c.symbols().filter((e) => e.symbol === "EURUSD");
    expect(eur).toHaveLength(1);
    expect(eur[0]?.cls).toBe("forex");
    expect(c.symbols().find((e) => e.symbol === "XAUUSD")?.cls).toBe("metal");
    expect(c.symbols().find((e) => e.symbol === "BTCUSDT")?.cls).toBe("crypto");
  });

  it("drops a cached row that predates classes rather than guessing one", () => {
    const store = kv();
    store.write(
      { key: "catalogue.symbols", version: 3, fallback: () => ({ at: 0, entries: [] }), validate: (v) => v as never },
      { at: Date.now(), entries: [{ symbol: "ZZZUSDT", volume: 9, source: "binance", tier: 0 }] },
    );
    const c = createCatalogue(store, () => new Promise(() => {}));
    expect(c.symbols().some((e) => e.symbol === "ZZZUSDT")).toBe(false);
  });

  it("gives every catalogued instrument a tab to appear under", () => {
    const c = createCatalogue(kv(), () => new Promise(() => {}));
    for (const e of c.symbols()) {
      expect(classTab(e.cls), `${e.symbol} (${e.cls}) has no tab`).not.toBeNull();
    }
    for (const tab of CLASS_TABS) {
      expect(
        c.symbols().some((e) => classTab(e.cls) === tab.id),
        `tab ${tab.id} is empty`,
      ).toBe(true);
    }
  });

  it("does not duplicate crypto: the instrument table's USD aliases are skipped", () => {
    /* BTCUSD in the instrument table is the same asset as BTCUSDT on the
       venue. Admitting it would put a volume-0 BTC row above the real one. */
    expect(instrumentEntries().some((e) => e.symbol === "BTCUSD")).toBe(false);
    expect(instrumentEntries().every((e) => e.cls !== "crypto" && e.cls !== "perp")).toBe(true);
  });

  it("replaces the seed once the venue answers", async () => {
    const c = createCatalogue(kv(), () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    c.ensure();
    await vi.waitFor(() => expect(c.live()).toBe(true));
    expect(c.symbols()[0]?.symbol).toBe("AAAUSDT");
  });

  /**
   * MEASURED against the live venue: sorting on raw quoteVolume put USDTIDRT,
   * BTCBIDR and ETHBIDR at the top of the entire exchange, because that figure
   * is denominated in the quote asset and a rupiah is ~1/16,000 of a dollar.
   */
  it("does not let a rupiah-quoted pair outrank a dollar-quoted one", async () => {
    const c = createCatalogue(kv(), () =>
      Promise.resolve(
        universe([
          { symbol: "BTCBIDR", quoteVolume: 900_000_000_000 },
          { symbol: "BTCUSDT", quoteVolume: 2_000_000_000 },
        ]),
      ),
    );
    c.ensure();
    await vi.waitFor(() => expect(c.live()).toBe(true));
    expect(c.symbols()[0]?.symbol).toBe("BTCUSDT");
  });

  it("still ranks by volume inside a tier", async () => {
    const c = createCatalogue(kv(), () =>
      Promise.resolve(
        universe([
          { symbol: "AAAUSDT", quoteVolume: 10 },
          { symbol: "BBBUSDT", quoteVolume: 900 },
        ]),
      ),
    );
    c.ensure();
    await vi.waitFor(() => expect(c.live()).toBe(true));
    // Only the first two: the seed instruments the venue did not list are
    // appended after, which the test below pins deliberately.
    expect(c.symbols().slice(0, 2).map((e) => e.symbol)).toEqual(["BBBUSDT", "AAAUSDT"]);
  });

  // The end-to-end behaviour the ranking exists to produce.
  it("returns BTCUSDT first for a two-letter query", async () => {
    const c = createCatalogue(kv(), () =>
      Promise.resolve(
        universe([
          { symbol: "BTCBIDR", quoteVolume: 900_000_000_000 },
          { symbol: "BTCDOWNUSDT", quoteVolume: 1_000 },
          { symbol: "BTCUSDT", quoteVolume: 2_000_000_000 },
        ]),
      ),
    );
    c.ensure();
    await vi.waitFor(() => expect(c.live()).toBe(true));
    const out = rank(c.symbols(), "BT", symbolHaystacks, 10);
    expect(out[0]?.item.symbol).toBe("BTCUSDT");
  });

  it("keeps seed instruments the venue does not list", async () => {
    const c = createCatalogue(kv(), () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    c.ensure();
    await vi.waitFor(() => expect(c.live()).toBe(true));
    expect(c.symbols().some((e) => e.symbol === "XAUUSD")).toBe(true);
  });

  // A failed catalogue costs autocomplete, not the terminal.
  it("keeps the seed and explains itself when the venue fails", async () => {
    const c = createCatalogue(kv(), () => Promise.reject(new Error("429 too many")));
    c.ensure();
    await vi.waitFor(() => expect(c.note()).toMatch(/unavailable/i));
    expect(c.symbols().some((e) => e.symbol === "EURUSD")).toBe(true);
    expect(c.symbols().some((e) => e.symbol === "BTCUSDT")).toBe(true);
    expect(c.live()).toBe(false);
  });

  it("keeps the previous list if the venue returns nothing", async () => {
    const c = createCatalogue(kv(), () => Promise.resolve([]));
    c.ensure();
    await vi.waitFor(() => expect(c.note()).toMatch(/empty symbol list/i));
    expect(c.symbols().some((e) => e.symbol === "EURUSD")).toBe(true);
  });

  // The universe call costs weight 40 — the most expensive request the app makes.
  it("never runs two fetches at once", async () => {
    let calls = 0;
    let release: ((v: never[]) => void) | null = null;
    const c = createCatalogue(kv(), () => {
      calls++;
      return new Promise((res) => {
        release = res as (v: never[]) => void;
      });
    });
    c.ensure();
    c.refresh();
    c.refresh();
    expect(calls).toBe(1);
    release?.([]);
  });

  it("serves a fresh cache without touching the network", async () => {
    const store = kv();
    const first = createCatalogue(store, () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    first.ensure();
    await vi.waitFor(() => expect(first.live()).toBe(true));

    let calls = 0;
    const second = createCatalogue(store, () => {
      calls++;
      return Promise.resolve([]);
    });
    second.ensure();
    expect(calls).toBe(0);
    expect(second.live()).toBe(true);
    expect(second.symbols().some((e) => e.symbol === "AAAUSDT")).toBe(true);
  });

  it("refetches when the cache is older than its TTL", async () => {
    const store = kv();
    const first = createCatalogue(store, () =>
      Promise.resolve(universe([{ symbol: "AAAUSDT", quoteVolume: 5 }])),
    );
    first.ensure();
    await vi.waitFor(() => expect(first.live()).toBe(true));

    // Age the cache past its TTL, the way a machine left overnight would.
    const raw = store.rawEnvelope("catalogue.symbols") as { value: { at: number } };
    raw.value.at = Date.now() - CATALOGUE_TTL_MS - 1;
    store.write(
      { key: "catalogue.symbols", version: 3, fallback: () => raw.value, validate: (v) => v as typeof raw.value },
      raw.value,
    );

    let calls = 0;
    const second = createCatalogue(store, () => {
      calls++;
      return Promise.resolve(universe([{ symbol: "BBBUSDT", quoteVolume: 9 }]));
    });
    second.ensure();
    expect(calls).toBe(1);
  });
});

describe("symbolHaystacks", () => {
  // "btc usd" should find BTCUSDT even though that space is not in the symbol.
  it("splits a pair into its legs", () => {
    expect(symbolHaystacks({ symbol: "BTCUSDT", volume: 0, source: "x", tier: 0 })).toEqual([
      "BTCUSDT",
      "BTC USDT",
    ]);
  });

  it("leaves an unrecognised quote alone", () => {
    expect(symbolHaystacks({ symbol: "XAUUSD", volume: 0, source: "x", tier: 0 })).toEqual([
      "XAUUSD",
      "XAU USD",
    ]);
    expect(symbolHaystacks({ symbol: "WEIRD", volume: 0, source: "x", tier: 0 })).toEqual(["WEIRD"]);
  });

  it("finds a pair by its legs typed with a space", () => {
    const pool = [
      { symbol: "BTCUSDT", volume: 1, source: "x", tier: 0 },
      { symbol: "ETHUSDT", volume: 1, source: "x", tier: 0 },
    ];
    expect(rank(pool, "btc usd", symbolHaystacks, 5)[0]?.item.symbol).toBe("BTCUSDT");
  });
});
