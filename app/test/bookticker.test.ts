import { describe, expect, it } from "vitest";
import {
  ABSURD_SPREAD_PCT,
  decimalsOf,
  shapeBook,
  type BookTickerBody,
} from "../src/data/bookticker";

const T = 1_700_000_000_000;

const book = (over: Partial<Record<keyof BookTickerBody, unknown>> = {}): BookTickerBody => ({
  symbol: "BTCUSDT",
  bidPrice: "77145.36000000",
  bidQty: "7.06413000",
  askPrice: "77145.37000000",
  askQty: "2.74839000",
  ...over,
});

describe("shapeBook", () => {
  it("reads the real dealing spread off the top of book", () => {
    const q = shapeBook(book(), "BTCUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.bid).toBe(77145.36);
    expect(q.ask).toBe(77145.37);
    expect(q.spread).toBeCloseTo(0.01, 6);
  });

  it("is orders of magnitude below the cross-venue basis it replaces", () => {
    /* THE MEASUREMENT THAT MOTIVATED THE MODULE, PINNED SO IT CANNOT DRIFT
       BACK. The Setup card's spread gate was fed 0.059% — the gap between
       venues — as the cost of entering BTCUSDT. The actual bid-ask on the
       venue that fills you was a cent. Against a 134-point stop that is the
       difference between "26% of your stop" and a rounding error, and it was
       the sole reason crypto setups on tight stops were being stood down. */
    const q = shapeBook(book(), "BTCUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.spreadPct).toBeLessThan(0.001);
    expect(0.059 / q.spreadPct).toBeGreaterThan(1000);
  });

  it("carries the depth the quote is only valid inside", () => {
    /* The quoted spread is the cost of a trade that FITS. Reporting it without
       the size resting behind it is the same category of error as the
       cross-venue basis: a real number answering a different question. */
    const q = shapeBook(book(), "BTCUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.depth).toEqual({ bidQty: 7.06413, askQty: 2.74839 });
  });

  it("omits depth rather than inventing it when the venue does not send sizes", () => {
    const q = shapeBook(book({ bidQty: undefined, askQty: undefined }), "BTCUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.depth).toBeUndefined();
  });

  it("refuses a crossed book instead of reporting a negative cost", () => {
    /* Passing an inverted book through gives a spread gate that PASSES more
       easily the more broken the feed is. */
    const q = shapeBook(book({ bidPrice: "100", askPrice: "99" }), "BTCUSDT", T);
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toContain("crossed book");
  });

  it("refuses an absurd spread as a broken read, naming it as one", () => {
    /* A gate that refuses because the data is broken must say the data is
       broken — otherwise it fails for the right-looking reason and the wrong
       actual one, and the operator waits for a spread that will never come in. */
    const q = shapeBook(book({ bidPrice: "100", askPrice: "120" }), "BTCUSDT", T);
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toContain("broken or empty book");
    expect(20 / 110 * 100).toBeGreaterThan(ABSURD_SPREAD_PCT);
  });

  it("refuses rather than estimating when a side of the book is missing", () => {
    for (const missing of [{ bidPrice: undefined }, { askPrice: undefined }, { bidPrice: "0" }]) {
      const q = shapeBook(book(missing), "BTCUSDT", T);
      expect(q.ok).toBe(false);
    }
  });

  it("stamps asOf with when WE received it, never a venue time it did not send", () => {
    const q = shapeBook(book(), "BTCUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.asOf).toBe(T);
  });

  it("falls back to the requested symbol when the payload omits one", () => {
    const q = shapeBook(book({ symbol: undefined }), "ETHUSDT", T);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.symbol).toBe("ETHUSDT");
  });
});

describe("decimalsOf", () => {
  it("ignores the venue's trailing zero padding", () => {
    /* Binance sends "77145.36000000" for a two-decimal price. Taking the
       string at face value formats every crypto price to eight places. */
    expect(decimalsOf("77145.36000000")).toBe(2);
  });

  it("takes the most precise of the strings it is given", () => {
    expect(decimalsOf("1.5", "1.4375")).toBe(4);
  });

  it("is zero for an integer quote and capped at eight for a long one", () => {
    expect(decimalsOf("77145")).toBe(0);
    expect(decimalsOf("0.000000012345")).toBe(8);
  });
});
