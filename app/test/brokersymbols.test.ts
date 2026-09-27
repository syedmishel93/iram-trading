/**
 * THE PICKER OFFERED FEWER SYMBOLS THAN THE BROKER QUOTES.
 *
 * MEASURED: the broker lists **272** symbols on `/mt5/symbols`; the picker
 * offered what the archive holds plus `INSTRUMENTS`, a hand-maintained table of
 * 132. So an operator whose broker quotes CHFPLN could not pick it, and the
 * route that knew had no caller.
 *
 * THIS IS THE BACKGROUND TO A COMPLAINT ALREADY IN THIS SESSION: "it's broken,
 * only showing XAUUSD, no other assets". That turned out to be a `<datalist>`
 * filtering by box contents and was fixed by using the real picker — but the
 * underlying list was also short, and this is that half.
 *
 * A BROKER SYMBOL IS NOT AUTOMATICALLY A SIZEABLE ONE. `INSTRUMENTS` carries
 * contract size, pip value and the `contextOnly` flag, and everything that
 * sizes a position walks that table. A symbol the broker quotes but the table
 * does not describe can be CHARTED and cannot be SIZED, so it is offered with
 * that said rather than silently promoted — the alternative is the units defect
 * this codebase records three times.
 */

import { describe, it, expect } from "vitest";
import { mergeBrokerSymbols, canonicalBrokerSymbol } from "../src/ui/cards/symbolfield";
import type { SymbolOption } from "../src/ui/cards/symbolfield";

const held: SymbolOption[] = [
  { symbol: "BTCUSDT", note: "5,803 bars", held: true },
  { symbol: "XAUUSD", note: "1,011 bars", held: true },
];

describe("canonicalBrokerSymbol", () => {
  it("strips the broker's suffix, which is not part of the instrument", () => {
    expect(canonicalBrokerSymbol("XAUUSD.s")).toBe("XAUUSD");
    expect(canonicalBrokerSymbol("BTCUSD.S")).toBe("BTCUSD");
    expect(canonicalBrokerSymbol("EURUSD.pro")).toBe("EURUSD");
  });

  it("leaves a real ticker's dot alone", () => {
    /* `BRK.B` is a share class, not a suffix. An earlier version of this rule
       elsewhere turned it into `BRK` — a wrong answer that looks right and
       would chart a different company. */
    expect(canonicalBrokerSymbol("BRK.B")).toBe("BRK.B");
  });

  it("refuses rubbish rather than repairing it", () => {
    expect(canonicalBrokerSymbol("")).toBe("");
    expect(canonicalBrokerSymbol("   ")).toBe("");
  });
});

describe("mergeBrokerSymbols", () => {
  it("adds broker symbols the table does not know", () => {
    const out = mergeBrokerSymbols(held, ["CHFPLN.s", "AUDCAD.s"]);
    const syms = out.map((o) => o.symbol);
    expect(syms).toContain("CHFPLN");
    expect(syms).toContain("AUDCAD");
  });

  it("never duplicates something already offered", () => {
    const out = mergeBrokerSymbols(held, ["XAUUSD.s", "BTCUSDT"]);
    expect(out.filter((o) => o.symbol === "XAUUSD")).toHaveLength(1);
    expect(out.filter((o) => o.symbol === "BTCUSDT")).toHaveLength(1);
  });

  it("keeps held symbols first — richest history is the likeliest reach", () => {
    const out = mergeBrokerSymbols(held, ["AAAAAA.s"]);
    expect(out[0]?.symbol).toBe("BTCUSDT");
    expect(out[1]?.symbol).toBe("XAUUSD");
  });

  it("SAYS a broker-only symbol cannot be sized", () => {
    /* Everything that sizes a position walks INSTRUMENTS. Offering a symbol
       that table does not describe, without saying so, is how a position gets
       sized at a defaulted contract size. */
    const out = mergeBrokerSymbols(held, ["CHFPLN.s"]);
    const row = out.find((o) => o.symbol === "CHFPLN");
    expect(row?.held).toBe(false);
    expect(row?.note).toMatch(/broker/i);
    expect(row?.note).toMatch(/chart|size|sizing/i);
  });

  it("drops empties instead of offering a blank row", () => {
    const out = mergeBrokerSymbols(held, ["", "   ", "EURUSD.s"]);
    expect(out.every((o) => o.symbol.length > 0)).toBe(true);
    expect(out.map((o) => o.symbol)).toContain("EURUSD");
  });

  it("is a no-op when the bridge returns nothing", () => {
    /* "Could not ask" must not shrink the list the operator already had. */
    expect(mergeBrokerSymbols(held, []).map((o) => o.symbol)).toEqual(["BTCUSDT", "XAUUSD"]);
  });
});
