import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createFundamentals,
  derive,
  baseOf,
  loadMarkets,
  fmtCap,
  fmtSupply,
  FUNDAMENTALS_TTL_MS,
  type Fundamentals,
} from "../src/data/fundamentals";
import { createKV, memoryRawStore } from "../src/store/kv";
import { resetNet } from "../src/data/net";

beforeEach(() => resetNet());
afterEach(() => resetNet());

const base: Fundamentals = {
  id: "bitcoin",
  symbol: "BTC",
  name: "Bitcoin",
  rank: 1,
  price: 78_000,
  marketCap: 1.5e12,
  fullyDiluted: 1.6e12,
  volume24h: 3e10,
  circulating: 19_800_000,
  total: 19_800_000,
  maxSupply: 21_000_000,
  ath: 100_000,
  athDate: "2025-01-01T00:00:00.000Z",
  athChangePct: -22,
  change24h: 1.2,
  change7d: -3.4,
  change30d: 8.9,
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("baseOf", () => {
  it("strips the quote from a pair", () => {
    expect(baseOf("BTCUSDT")).toBe("BTC");
    expect(baseOf("ETHBTC")).toBe("ETH");
  });

  it("falls back to the whole symbol when no quote is recognised", () => {
    expect(baseOf("XAUXAG")).toBe("XAUXAG");
  });
});

describe("derive", () => {
  it("computes float, dilution, turnover and drawdown", () => {
    const d = derive(base);
    expect(d.float).toBeCloseTo(19_800_000 / 21_000_000, 6);
    expect(d.dilution).toBeCloseTo(1.6 / 1.5, 6);
    expect(d.turnover).toBeCloseTo(3e10 / 1.5e12, 9);
    expect(d.belowAth).toBeCloseTo(22, 6);
  });

  // The single most under-read number in crypto.
  it("names a low float", () => {
    const d = derive({ ...base, circulating: 6_000_000, maxSupply: 100_000_000 });
    expect(d.notes.join(" ")).toMatch(/6\.0% of the maximum supply/);
  });

  it("does not warn about a fully-issued supply", () => {
    const d = derive({ ...base, circulating: 21_000_000, maxSupply: 21_000_000, fullyDiluted: 1.5e12 });
    expect(d.notes.join(" ")).not.toMatch(/maximum supply is circulating/);
  });

  // An uncapped supply is a fact, and it has no float — not a float of zero.
  it("reports no max supply as null and says why it matters", () => {
    const d = derive({ ...base, maxSupply: null });
    expect(d.float).toBeNull();
    expect(d.notes.join(" ")).toMatch(/uncapped/i);
  });

  it("names a heavy dilution overhang with the multiple", () => {
    const d = derive({ ...base, marketCap: 1e8, fullyDiluted: 1.5e9 });
    expect(d.notes.join(" ")).toMatch(/15\.0× the market cap/);
    expect(d.notes.join(" ")).toMatch(/14\.0× everything trading today/);
  });

  it("names thin turnover", () => {
    const d = derive({ ...base, volume24h: 1e9, marketCap: 1e12 });
    expect(d.notes.join(" ")).toMatch(/Thin/);
  });

  // It cannot tell a real event from wash trading, and says so.
  it("flags turnover above the whole market cap without claiming a cause", () => {
    const d = derive({ ...base, volume24h: 2e12, marketCap: 1e12 });
    const text = d.notes.join(" ");
    expect(text).toMatch(/exceeds the entire market cap/);
    expect(text).toMatch(/cannot tell you which/);
  });

  it("states the multiple needed to recover a deep drawdown", () => {
    const d = derive({ ...base, athChangePct: -95 });
    expect(d.notes.join(" ")).toMatch(/95% below/);
    expect(d.notes.join(" ")).toMatch(/20\.0× move/);
  });

  it("survives a zero market cap without dividing by it", () => {
    const d = derive({ ...base, marketCap: 0, fullyDiluted: 0 });
    expect(d.dilution).toBeNull();
    expect(d.turnover).toBe(0);
    expect(Number.isFinite(d.belowAth)).toBe(true);
  });
});

describe("loadMarkets", () => {
  function stub(body: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      headers: new Headers(),
      json: () => Promise.resolve(body),
      clone() {
        return this;
      },
    }) as unknown as typeof fetch;
  }

  it("maps the payload fields", async () => {
    stub([
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        market_cap_rank: 1,
        current_price: 78000,
        market_cap: 1.5e12,
        fully_diluted_valuation: 1.6e12,
        total_volume: 3e10,
        circulating_supply: 19800000,
        total_supply: 19800000,
        max_supply: 21000000,
        ath: 100000,
        ath_date: "2025-01-01T00:00:00.000Z",
        ath_change_percentage: -22,
        price_change_percentage_24h_in_currency: 1.2,
        price_change_percentage_7d_in_currency: -3.4,
        price_change_percentage_30d_in_currency: 8.9,
        last_updated: "2026-08-31T00:00:00.000Z",
      },
    ]);
    const rows = await loadMarkets();
    expect(rows.length).toBe(1);
    expect(rows[0]?.symbol).toBe("BTC");
    expect(rows[0]?.maxSupply).toBe(21_000_000);
  });

  // Zero would be a lie; an uncapped asset genuinely has no maximum.
  it("keeps a null max supply as null rather than zero", async () => {
    stub([{ id: "ethereum", symbol: "eth", max_supply: null, market_cap: 1 }]);
    const rows = await loadMarkets();
    expect(rows[0]?.maxSupply).toBeNull();
  });

  it("skips rows with no symbol", async () => {
    stub([{ id: "x", symbol: "" }, { id: "y", symbol: "sol" }]);
    expect((await loadMarkets()).length).toBe(1);
  });

  it("explains a rate limit in the aggregator's own terms", async () => {
    stub({}, 429);
    await expect(loadMarkets()).rejects.toThrow(/few calls a minute/);
  });

  it("rejects a payload that is not a list", async () => {
    stub({ error: "nope" });
    await expect(loadMarkets()).rejects.toThrow(/unexpected payload/);
  });
});

describe("createFundamentals", () => {
  const kv = () => createKV(memoryRawStore());

  it("starts empty and fills on demand", async () => {
    const f = createFundamentals(kv(), () => Promise.resolve([base]));
    expect(f.rows().length).toBe(0);
    f.ensure();
    await vi.waitFor(() => expect(f.rows().length).toBe(1));
  });

  it("finds by trading pair, not just by ticker", async () => {
    const f = createFundamentals(kv(), () => Promise.resolve([base]));
    f.ensure();
    await vi.waitFor(() => expect(f.rows().length).toBe(1));
    expect(f.find("BTCUSDT")?.name).toBe("Bitcoin");
    expect(f.find("BTCUSD")?.name).toBe("Bitcoin");
  });

  it("returns null for an instrument the aggregator does not cover", async () => {
    const f = createFundamentals(kv(), () => Promise.resolve([base]));
    f.ensure();
    await vi.waitFor(() => expect(f.rows().length).toBe(1));
    expect(f.find("XAUUSD")).toBeNull();
    expect(f.find("EURUSD")).toBeNull();
  });

  // Ticker collisions are real; market-cap order is the only signal available.
  it("resolves a ticker collision to the largest by market cap", async () => {
    const big = { ...base, symbol: "UNI", name: "Uniswap", marketCap: 5e9, rank: 20 };
    const small = { ...base, symbol: "UNI", name: "Unicorn Token", marketCap: 1e6, rank: 900 };
    const f = createFundamentals(kv(), () => Promise.resolve([big, small]));
    f.ensure();
    await vi.waitFor(() => expect(f.rows().length).toBe(2));
    expect(f.find("UNIUSDT")?.name).toBe("Uniswap");
  });

  // Losing fundamentals costs a panel, never the chart.
  it("explains a failure and keeps whatever it had", async () => {
    const f = createFundamentals(kv(), () => Promise.reject(new Error("429 too many")));
    f.ensure();
    await vi.waitFor(() => expect(f.note()).toMatch(/unavailable/i));
    expect(f.rows().length).toBe(0);
  });

  it("keeps the previous list when the aggregator returns nothing", async () => {
    const store = kv();
    const first = createFundamentals(store, () => Promise.resolve([base]));
    first.ensure();
    await vi.waitFor(() => expect(first.rows().length).toBe(1));

    const second = createFundamentals(store, () => Promise.resolve([]));
    second.refresh();
    await vi.waitFor(() => expect(second.note()).toMatch(/returned no assets/i));
    expect(second.rows().length).toBe(1);
  });

  it("never runs two fetches at once", () => {
    let calls = 0;
    const f = createFundamentals(kv(), () => {
      calls++;
      return new Promise(() => {});
    });
    f.ensure();
    f.refresh();
    f.refresh();
    expect(calls).toBe(1);
  });

  it("serves a fresh cache without a request", async () => {
    const store = kv();
    const first = createFundamentals(store, () => Promise.resolve([base]));
    first.ensure();
    await vi.waitFor(() => expect(first.rows().length).toBe(1));

    let calls = 0;
    const second = createFundamentals(store, () => {
      calls++;
      return Promise.resolve([]);
    });
    second.ensure();
    expect(calls).toBe(0);
    expect(second.find("BTCUSDT")?.name).toBe("Bitcoin");
  });

  it("refetches once the cache is older than its TTL", async () => {
    const store = kv();
    const first = createFundamentals(store, () => Promise.resolve([base]));
    first.ensure();
    await vi.waitFor(() => expect(first.rows().length).toBe(1));

    const raw = store.rawEnvelope("fundamentals.markets") as { value: { at: number } };
    raw.value.at = Date.now() - FUNDAMENTALS_TTL_MS - 1;
    store.write(
      { key: "fundamentals.markets", version: 1, fallback: () => raw.value, validate: (v) => v as typeof raw.value },
      raw.value,
    );

    let calls = 0;
    const second = createFundamentals(store, () => {
      calls++;
      return Promise.resolve([base]);
    });
    second.ensure();
    expect(calls).toBe(1);
  });
});

describe("formatting", () => {
  it("abbreviates capitalisation by magnitude", () => {
    expect(fmtCap(1.5e12)).toBe("$1.50T");
    expect(fmtCap(2.4e9)).toBe("$2.40B");
    expect(fmtCap(7.1e6)).toBe("$7.1M");
  });

  it("returns a dash rather than a zero for an absent figure", () => {
    expect(fmtCap(0)).toBe("—");
    expect(fmtCap(NaN)).toBe("—");
    expect(fmtSupply(0)).toBe("—");
  });

  it("abbreviates supply without a currency mark", () => {
    expect(fmtSupply(19_800_000)).toBe("19.80M");
    expect(fmtSupply(1.2e9)).toBe("1.20B");
  });
});
