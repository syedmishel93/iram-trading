import { describe, it, expect } from "vitest";
import {
  emptyBook,
  openPosition,
  closePosition,
  applyLevels,
  fillPrice,
  realise,
  summarise,
  equityCurve,
  DEFAULT_ASSUMPTIONS,
  FRICTIONLESS,
  type PaperBook,
} from "../src/trade/paper";

const T0 = 1_700_000_000_000;

const open = (book: PaperBook, over: Partial<Parameters<typeof openPosition>[1]> = {}) =>
  openPosition(book, {
    symbol: "BTCUSDT",
    direction: "long",
    qty: 1,
    mid: 100,
    at: T0,
    id: "p1",
    ...over,
  });

describe("fill prices are always adverse", () => {
  /* The sign of this is the most flattering bug a paper desk can have: get it
     backwards and every round trip books a small free gain, so the equity curve
     rises on activity alone. */
  it("makes a long pay up on the way in and get hit on the way out", () => {
    expect(fillPrice(100, "long", "open", DEFAULT_ASSUMPTIONS)).toBeGreaterThan(100);
    expect(fillPrice(100, "long", "close", DEFAULT_ASSUMPTIONS)).toBeLessThan(100);
  });

  it("makes a short get hit on the way in and pay up on the way out", () => {
    expect(fillPrice(100, "short", "open", DEFAULT_ASSUMPTIONS)).toBeLessThan(100);
    expect(fillPrice(100, "short", "close", DEFAULT_ASSUMPTIONS)).toBeGreaterThan(100);
  });

  it("loses money on an instant round trip at an unchanged price", () => {
    /* Open and close at the same mid. A correct model books a loss equal to the
       friction; a sign error books a gain. */
    const o = open(emptyBook(10_000));
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const closed = closePosition(o.book, "p1", 100, T0 + 1000);
    const t = closed.trades[0]!;
    expect(t.pnl).toBeLessThan(0);
  });

  it("is exactly the mid when the assumptions are all zero", () => {
    expect(fillPrice(100, "long", "open", FRICTIONLESS)).toBe(100);
    expect(fillPrice(100, "short", "close", FRICTIONLESS)).toBe(100);
  });

  it("returns NaN rather than a number for an unusable price", () => {
    expect(Number.isNaN(fillPrice(0, "long", "open", DEFAULT_ASSUMPTIONS))).toBe(true);
    expect(Number.isNaN(fillPrice(NaN, "long", "open", DEFAULT_ASSUMPTIONS))).toBe(true);
  });
});

describe("opening", () => {
  it("refuses without a live price", () => {
    const r = open(emptyBook(), { mid: NaN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("No live price");
  });

  it("refuses a non-positive quantity", () => {
    expect(open(emptyBook(), { qty: 0 }).ok).toBe(false);
    expect(open(emptyBook(), { qty: -1 }).ok).toBe(false);
  });

  it("refuses a stop that would trigger immediately", () => {
    const long = open(emptyBook(), { direction: "long", stop: 105 });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toContain("stop below the entry");

    const short = open(emptyBook(), { direction: "short", stop: 95 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain("stop above the entry");
  });

  it("keeps the clean mid alongside the filled price", () => {
    const r = open(emptyBook());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.book.positions[0]!;
    expect(p.entryMid).toBe(100);
    expect(p.entry).toBeGreaterThan(100);
  });
});

describe("stops and targets", () => {
  const bookWith = (over: Parameters<typeof open>[1]): PaperBook => {
    const r = open(emptyBook(10_000), over);
    if (!r.ok) throw new Error(r.reason);
    return r.book;
  };

  it("fires a stop that traded INSIDE the bar, not only one that closed through it", () => {
    /* A stop checked against the last price only fires if you happen to be
       looking when it prints. Using the bar's low is what the backtest engine
       does and is what stops a paper record from missing its losers. */
    const book = bookWith({ direction: "long", stop: 95 });
    const { book: next, fired } = applyLevels(
      book,
      new Map([["BTCUSDT", { high: 101, low: 94, close: 100 }]]),
      T0 + 1000,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.reason).toBe("stop");
    expect(next.positions).toHaveLength(0);
  });

  it("fires a target the same way", () => {
    const book = bookWith({ direction: "long", target: 110 });
    const { fired } = applyLevels(
      book,
      new Map([["BTCUSDT", { high: 111, low: 99, close: 100 }]]),
      T0 + 1000,
    );
    expect(fired[0]?.reason).toBe("target");
  });

  it("takes the STOP when one bar contains both", () => {
    /* Neither is knowable from a bar alone. Assuming the good one is how a
       paper record quietly outperforms the account it is practising for. */
    const book = bookWith({ direction: "long", stop: 95, target: 110 });
    const { fired } = applyLevels(
      book,
      new Map([["BTCUSDT", { high: 111, low: 94, close: 100 }]]),
      T0 + 1000,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.reason).toBe("stop");
  });

  it("reverses the level tests for a short", () => {
    const book = bookWith({ direction: "short", stop: 105, target: 90 });
    const hitStop = applyLevels(book, new Map([["BTCUSDT", { high: 106, low: 99, close: 100 }]]), T0 + 1);
    expect(hitStop.fired[0]?.reason).toBe("stop");

    const hitTarget = applyLevels(book, new Map([["BTCUSDT", { high: 101, low: 89, close: 100 }]]), T0 + 1);
    expect(hitTarget.fired[0]?.reason).toBe("target");
  });

  it("leaves a position alone when neither level traded", () => {
    const book = bookWith({ direction: "long", stop: 95, target: 110 });
    const { book: next, fired } = applyLevels(
      book,
      new Map([["BTCUSDT", { high: 104, low: 97, close: 100 }]]),
      T0 + 1,
    );
    expect(fired).toHaveLength(0);
    expect(next.positions).toHaveLength(1);
  });

  it("ignores a symbol with no quote rather than guessing one", () => {
    const book = bookWith({ direction: "long", stop: 95 });
    const { fired } = applyLevels(book, new Map(), T0 + 1);
    expect(fired).toHaveLength(0);
  });
});

describe("profit and loss", () => {
  it("makes a long profit on a rise and a short profit on a fall", () => {
    const long = open(emptyBook(10_000), { direction: "long" });
    if (!long.ok) throw new Error();
    expect(closePosition(long.book, "p1", 120, T0 + 1).trades[0]!.pnl).toBeGreaterThan(0);

    const short = open(emptyBook(10_000), { direction: "short" });
    if (!short.ok) throw new Error();
    expect(closePosition(short.book, "p1", 80, T0 + 1).trades[0]!.pnl).toBeGreaterThan(0);
  });

  it("charges commission on both sides", () => {
    /* Commission ONLY — no spread or slippage on either leg, so the round trip
       has no gross move and the whole P&L is the two commissions. Opening with
       the default assumptions and closing without them would leave the entry
       spread in the result and this would be testing two things at once. */
    const commissionOnly = { ...FRICTIONLESS, commissionPct: 0.001 };
    const r = open(emptyBook(10_000), { qty: 10, costs: commissionOnly });
    if (!r.ok) throw new Error();
    const p = r.book.positions[0]!;
    expect(p.entry).toBe(100);
    const withCosts = closePosition(r.book, "p1", 100, T0 + 1, "manual", commissionOnly);
    expect(withCosts.trades[0]!.pnl).toBeCloseTo(-(100 * 10 + 100 * 10) * 0.001, 8);
  });

  it("scales P&L with quantity", () => {
    const one = open(emptyBook(10_000), { qty: 1 });
    const ten = open(emptyBook(10_000), { qty: 10 });
    if (!one.ok || !ten.ok) throw new Error();
    const a = closePosition(one.book, "p1", 120, T0 + 1).trades[0]!.pnl;
    const b = closePosition(ten.book, "p1", 120, T0 + 1).trades[0]!.pnl;
    expect(b).toBeCloseTo(a * 10, 6);
  });
});

describe("summary", () => {
  it("marks open positions at the price a CLOSE would get, not at the mid", () => {
    /* Marking at the mid shows a profit that closing would not realise. */
    const r = open(emptyBook(10_000), { qty: 1 });
    if (!r.ok) throw new Error();
    const s = summarise(r.book, new Map([["BTCUSDT", 100]]));
    expect(s.unrealised).toBeLessThan(0);
  });

  it("adds realised and unrealised onto the starting equity", () => {
    const r = open(emptyBook(10_000), { qty: 1 });
    if (!r.ok) throw new Error();
    const closed = closePosition(r.book, "p1", 120, T0 + 1);
    const s = summarise(closed, new Map());
    expect(s.equity).toBeCloseTo(10_000 + s.realised, 8);
    expect(s.unrealised).toBe(0);
  });

  it("reports a NaN win rate with no trades rather than a flattering zero", () => {
    const s = summarise(emptyBook(10_000), new Map());
    expect(Number.isNaN(s.winRate)).toBe(true);
    expect(s.trades).toBe(0);
  });

  it("skips a position whose symbol has no mark instead of marking it flat", () => {
    const r = open(emptyBook(10_000), { qty: 1 });
    if (!r.ok) throw new Error();
    const s = summarise(r.book, new Map());
    expect(s.unrealised).toBe(0);
    expect(s.openNotional).toBeGreaterThan(0);
  });
});

describe("equity curve", () => {
  it("starts at the starting equity and steps once per closed trade", () => {
    let book = emptyBook(1000);
    for (const id of ["a", "b"]) {
      const r = openPosition(book, { symbol: "X", direction: "long", qty: 1, mid: 100, at: T0, id });
      if (!r.ok) throw new Error(r.reason);
      book = closePosition(r.book, id, 110, T0 + 1);
    }
    const curve = equityCurve(book);
    expect(curve).toHaveLength(3);
    expect(curve[0]).toBe(1000);
    expect(curve[2]).toBeGreaterThan(curve[0] as number);
  });
});

describe("what the module refuses to contain", () => {
  it("exposes no way to open a position from a signal", async () => {
    /* The standing recommendation on this terminal is that nothing be automated
       off the confluence score — PBO is 89%. A paper desk with an
       "auto-trade the signal" entry point is how that gets quietly ignored, so
       the absence is pinned here rather than left to good intentions. */
    const mod = await import("../src/trade/paper");
    const names = Object.keys(mod).sort();
    expect(names).toEqual(
      [
        "DEFAULT_ASSUMPTIONS",
        "FRICTIONLESS",
        "applyLevels",
        "closePosition",
        "emptyBook",
        "equityCurve",
        "fillPrice",
        "openPosition",
        "realise",
        "summarise",
      ].sort(),
    );
  });
});
