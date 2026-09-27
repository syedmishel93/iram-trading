import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { splitPair, coinbaseSource, bybitSource, okxSource } from "../src/data/venues";
import { resetNet } from "../src/data/net";

/** Stub the network at fetch, so the governor and every parser run for real. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    clone() {
      return this;
    },
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => resetNet());
afterEach(() => resetNet());

describe("splitPair", () => {
  // "BTCUSDT" ends with both USDT and USD; the shorter leaves a base of "BTCT".
  it("matches the longest quote first", () => {
    expect(splitPair("BTCUSDT")).toEqual({ base: "BTC", quote: "USDT" });
    expect(splitPair("BTCUSD")).toEqual({ base: "BTC", quote: "USD" });
    expect(splitPair("ETHFDUSD")).toEqual({ base: "ETH", quote: "FDUSD" });
  });

  it("handles crypto-quoted pairs", () => {
    expect(splitPair("ETHBTC")).toEqual({ base: "ETH", quote: "BTC" });
  });

  it("normalises punctuation and case", () => {
    expect(splitPair("btc-usdt")).toEqual({ base: "BTC", quote: "USDT" });
    expect(splitPair("BTC/USDT")).toEqual({ base: "BTC", quote: "USDT" });
  });

  it("returns null when no quote is recognised", () => {
    expect(splitPair("XAUXAG")).toBeNull();
    expect(splitPair("WEIRD")).toBeNull();
  });

  it("does not treat a bare quote asset as a pair", () => {
    expect(splitPair("USDT")).toBeNull();
    expect(splitPair("BTC")).toBeNull();
  });
});

describe("coinbaseSource", () => {
  const src = coinbaseSource();

  it("declares what it covers", () => {
    expect(src.id).toBe("coinbase");
    expect(src.supports("BTCUSDT")).toBe(true);
    expect(src.supports("XAUXAG")).toBe(false);
  });

  /**
   * Coinbase returns [time, low, high, open, close, volume] with time in
   * SECONDS and NEWEST FIRST. Both differ from every other venue and both would
   * pass silently: seconds land the series in 1970, and a reversed series
   * renders as a mirror image of the market.
   */
  it("maps the column order, converts seconds, and sorts oldest-first", async () => {
    stubFetch([
      [1700003600, 90, 110, 95, 105, 7],
      [1700000000, 80, 120, 100, 90, 5],
    ]);
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(bars.length).toBe(2);
    expect(bars[0]).toEqual({ t: 1700000000000, o: 100, h: 120, l: 80, c: 90, v: 5 });
    expect(bars[1]?.t).toBeGreaterThan(bars[0]!.t);
  });

  // A stablecoin quote is treated as USD, which is an approximation the source
  // makes deliberately — Coinbase has no USDT book for most assets.
  it("maps a stablecoin quote onto the USD product", async () => {
    const fetchFn = stubFetch([]);
    await src.loadBars("ETHUSDT", "1h", {}).catch(() => {});
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/products/ETH-USD/candles");
  });

  it("passes a non-dollar quote through unchanged", async () => {
    const fetchFn = stubFetch([]);
    await src.loadBars("ETHBTC", "1h", {}).catch(() => {});
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/products/ETH-BTC/candles");
  });

  // Returning a 6h series under a 4h label is undetectable downstream.
  it("refuses a timeframe it has no granularity for, and names the ones it has", async () => {
    await expect(src.loadBars("BTCUSDT", "4h", {})).rejects.toThrow(/1m, 5m, 15m, 1h, 6h, 1d/);
  });

  it("reports a missing product rather than an empty chart", async () => {
    stubFetch({}, { status: 404 });
    await expect(src.loadBars("FAKEUSDT", "1h", {})).rejects.toThrow(/no FAKE-USD book/);
  });

  it("surfaces a rate limit as such", async () => {
    stubFetch({}, { status: 429 });
    await expect(src.loadBars("BTCUSDT", "1h", {})).rejects.toThrow(/rate limited/);
  });

  it("drops incoherent bars instead of charting them", async () => {
    stubFetch([
      [1700000000, 120, 80, 100, 90, 5], // high < low
      [1700003600, 80, 120, 100, 110, 5],
    ]);
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(bars.length).toBe(1);
  });

  it("honours the limit by keeping the newest bars", async () => {
    stubFetch(
      Array.from({ length: 10 }, (_, i) => [1700000000 + i * 3600, 80, 120, 100, 110, 5]),
    );
    const bars = await src.loadBars("BTCUSDT", "1h", { limit: 3 });
    expect(bars.length).toBe(3);
    expect(bars[2]?.t).toBe((1700000000 + 9 * 3600) * 1000);
  });
});

describe("bybitSource", () => {
  const src = bybitSource();

  it("parses string columns and sorts oldest-first", async () => {
    stubFetch({
      retCode: 0,
      result: {
        list: [
          ["1700003600000", "95", "110", "90", "105", "7", "0"],
          ["1700000000000", "100", "120", "80", "90", "5", "0"],
        ],
      },
    });
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(bars[0]).toEqual({ t: 1700000000000, o: 100, h: 120, l: 80, c: 90, v: 5 });
    expect(bars.length).toBe(2);
  });

  /**
   * Bybit answers HTTP 200 with an error CODE in the body. Trusting the status
   * would turn "symbol not found" into an empty chart with no explanation.
   */
  it("reads the body error code, not just the HTTP status", async () => {
    stubFetch({ retCode: 10001, retMsg: "Not supported symbols" });
    await expect(src.loadBars("FAKEUSDT", "1h", {})).rejects.toThrow(/Not supported symbols/);
  });

  it("refuses an interval it does not offer", async () => {
    await expect(src.loadBars("BTCUSDT", "7m", {})).rejects.toThrow(/no 7m interval/);
  });

  it("requests the spot category with the concatenated symbol", async () => {
    const fetchFn = stubFetch({ retCode: 0, result: { list: [] } });
    await src.loadBars("ETHUSDT", "4h", {});
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain("category=spot");
    expect(url).toContain("symbol=ETHUSDT");
    expect(url).toContain("interval=240");
  });
});

describe("okxSource", () => {
  const src = okxSource();

  it("parses and sorts confirmed candles", async () => {
    stubFetch({
      code: "0",
      data: [
        ["1700003600000", "95", "110", "90", "105", "7", "0", "0", "1"],
        ["1700000000000", "100", "120", "80", "90", "5", "0", "0", "1"],
      ],
    });
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(bars.length).toBe(2);
    expect(bars[0]?.t).toBe(1700000000000);
  });

  // A partial candle presented as closed is exactly what the detectors refuse
  // to reason about.
  it("drops the still-forming candle", async () => {
    stubFetch({
      code: "0",
      data: [
        ["1700003600000", "95", "110", "90", "105", "7", "0", "0", "0"],
        ["1700000000000", "100", "120", "80", "90", "5", "0", "0", "1"],
      ],
    });
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(bars.length).toBe(1);
    expect(bars[0]?.t).toBe(1700000000000);
  });

  it("does not leak the confirm flag into the bar", async () => {
    stubFetch({
      code: "0",
      data: [["1700000000000", "100", "120", "80", "90", "5", "0", "0", "1"]],
    });
    const bars = await src.loadBars("BTCUSDT", "1h", {});
    expect(Object.keys(bars[0] ?? {}).sort()).toEqual(["c", "h", "l", "o", "t", "v"]);
  });

  it("reads the body error code", async () => {
    stubFetch({ code: "51001", msg: "Instrument ID does not exist" });
    await expect(src.loadBars("FAKEUSDT", "1h", {})).rejects.toThrow(/does not exist/);
  });

  it("uses the hyphenated instrument id and OKX bar names", async () => {
    const fetchFn = stubFetch({ code: "0", data: [] });
    await src.loadBars("BTCUSDT", "4h", {});
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain("instId=BTC-USDT");
    expect(url).toContain("bar=4H");
  });
});

describe("the venue chain", () => {
  it("gives every source a distinct id and an ordered priority", () => {
    const chain = [coinbaseSource(), bybitSource(), okxSource()];
    expect(new Set(chain.map((s) => s.id)).size).toBe(3);
    // Binance is 0 and your own broker is 1; these slot in behind both.
    expect(chain.map((s) => s.priority)).toEqual([2, 3, 4]);
  });

  it("declares them all as live rather than delayed", () => {
    for (const s of [coinbaseSource(), bybitSource(), okxSource()]) {
      expect(s.quality).toBe("live");
    }
  });
});
