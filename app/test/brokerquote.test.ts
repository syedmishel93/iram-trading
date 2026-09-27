/**
 * The broker's dealing spread.
 *
 * Every branch here decides whether a position size gets computed from a real
 * number or from no number. The refusals matter more than the happy path: a
 * guessed dealing cost is an input to sizing, and a size computed from a guess
 * is the kind of number that costs money quietly.
 */

import { describe, expect, it } from "vitest";
import { MAX_QUOTE_AGE_MS, quoteWords, shapeQuote } from "../src/data/brokerquote";

const NOW = 1_788_355_600_000;

/* The real payload, copied from `/mt5/tick?symbol=XAUUSD` on the machine this
   was written on. Note `symbol` is the BROKER's name, not the one requested. */
const TICK = {
  symbol: "XAUUSD.s",
  bid: 4356.88,
  ask: 4357.06,
  spread: 0.18,
  digits: 2,
  t_ms: NOW - 2_000,
};

describe("shapeQuote", () => {
  it("reads the live cost of crossing, in price and in percent", () => {
    const q = shapeQuote(TICK, NOW);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    /* 4357.06 - 4356.88 = 0.18, and 0.18 / 4356.97 = 0.00413% */
    expect(q.spread).toBeCloseTo(0.18, 10);
    expect(q.spreadPct).toBeCloseTo(0.004131, 5);
    expect(q.digits).toBe(2);
  });

  /* The broker's own name is kept. `XAUUSD` is what you typed; `XAUUSD.s` is
     what you are filled on, and they are not always the same instrument. */
  it("keeps the broker's name for the instrument", () => {
    const q = shapeQuote(TICK, NOW);
    expect(q.ok && q.symbol).toBe("XAUUSD.s");
  });

  /**
   * THE ONE THAT WOULD HAVE COST MONEY. An inverted book is a broken quote, and
   * passing it through yields a NEGATIVE spread — which makes the cost-of-entry
   * gate pass more easily the more broken the feed is. A gate that gets more
   * permissive as its input degrades is worse than no gate.
   */
  it("refuses an inverted book rather than reporting a negative cost", () => {
    const q = shapeQuote({ ...TICK, bid: 4357.06, ask: 4356.88 }, NOW);
    expect(q.ok).toBe(false);
    expect(q.ok === false && q.reason).toMatch(/broken quote, not a free trade/);
  });

  it("refuses a tick with no usable prices instead of returning NaN", () => {
    for (const bad of [{ bid: 0 }, { ask: 0 }, { bid: "x" }, { ask: null }]) {
      expect(shapeQuote({ ...TICK, ...bad }, NOW).ok, JSON.stringify(bad)).toBe(false);
    }
    /* And an empty payload, which is what a bridge with no such symbol sends. */
    expect(shapeQuote({}, NOW).ok).toBe(false);
  });

  /**
   * Spreads widen in seconds — a release, a session roll, any thin book. A
   * thirty-second-old spread is a historical fact, not a quote, and sizing
   * against one is how a stop that looked affordable turns out not to be.
   */
  it("refuses a stale tick, and says how stale", () => {
    const q = shapeQuote({ ...TICK, t_ms: NOW - MAX_QUOTE_AGE_MS - 5_000 }, NOW);
    expect(q.ok).toBe(false);
    expect(q.ok === false && q.reason).toMatch(/35s old/);
  });

  it("accepts one right on the age limit", () => {
    expect(shapeQuote({ ...TICK, t_ms: NOW - MAX_QUOTE_AGE_MS }, NOW).ok).toBe(true);
  });

  /* A zero spread is real on some instruments and must not be mistaken for a
     missing reading — the gate then passes on a genuinely free entry. */
  it("allows a genuinely zero spread", () => {
    const q = shapeQuote({ ...TICK, bid: 100, ask: 100 }, NOW);
    expect(q.ok).toBe(true);
    expect(q.ok && q.spread).toBe(0);
  });

  /* A bridge that has no timestamp still gives a usable quote — the age check
     is a guard, not a requirement. */
  it("does not refuse merely because the bridge sent no timestamp", () => {
    expect(shapeQuote({ ...TICK, t_ms: undefined }, NOW).ok).toBe(true);
  });
});

describe("quoteWords", () => {
  it("prints the cost at the instrument's own precision", () => {
    const q = shapeQuote(TICK, NOW);
    expect(q.ok && quoteWords(q)).toBe("0.18 (0.004%)");
  });

  /* Five digits on a forex pair, two on gold. Rounding EURUSD's spread to two
     decimals prints 0.00 for a cost that is real. */
  it("keeps a forex spread visible instead of rounding it to zero", () => {
    const q = shapeQuote(
      { symbol: "EURUSD", bid: 1.08421, ask: 1.08423, digits: 5, t_ms: NOW },
      NOW,
    );
    expect(q.ok && quoteWords(q)).toMatch(/^0\.00002 /);
  });
});
