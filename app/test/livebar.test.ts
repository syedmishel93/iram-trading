import { describe, expect, it } from "vitest";
import { fitFields, honest, type LiveField } from "../src/ui/livebar";

const field = (
  id: string,
  rank: number,
  extra: Partial<LiveField> = {},
): LiveField => ({
  id,
  zone: "instrument",
  rank,
  value: () => id,
  ...extra,
});

/**
 * The real field list, in the real order, with the ranks the bar ships with.
 * Rank 1 is the price; the clock and the position count are the first things a
 * narrow window gives up.
 */
const FIELDS: LiveField[] = [
  field("price", 1),
  field("change", 2),
  field("spread", 4, { zone: "market" }),
  field("atr", 6, { zone: "market" }),
  field("openPnl", 3, { zone: "money" }),
  field("heat", 5, { zone: "money" }),
  field("clock", 9, { zone: "money" }),
];

const widths = new Map(FIELDS.map((f) => [f.id, 100]));

describe("fitFields", () => {
  it("keeps everything when there is room", () => {
    expect(fitFields(FIELDS, widths, 1000)).toHaveLength(FIELDS.length);
  });

  it("drops the worst-ranked field first", () => {
    const kept = fitFields(FIELDS, widths, 600);
    expect(kept).not.toContain("clock");
    expect(kept).toContain("price");
  });

  it("drops in strict rank order as space tightens", () => {
    /* 700 room, 100 each: six survive, and the one lost is rank 9. */
    expect(fitFields(FIELDS, widths, 600)).toEqual([
      "price",
      "change",
      "spread",
      "atr",
      "openPnl",
      "heat",
    ]);
    /* Tighter: rank 6 goes next. */
    expect(fitFields(FIELDS, widths, 500)).toEqual([
      "price",
      "change",
      "spread",
      "openPnl",
      "heat",
    ]);
  });

  it("NEVER drops the price, however tight it gets", () => {
    expect(fitFields(FIELDS, widths, 100)).toEqual(["price"]);
    expect(fitFields(FIELDS, widths, 1)).toEqual([]);
  });

  it("preserves original order, so a drop does not reshuffle the row", () => {
    /* The whole value of the bar is that positions are stable — if losing the
       clock moved the price, the eye would have to re-find it every resize. */
    const kept = fitFields(FIELDS, widths, 400);
    const order = FIELDS.filter((f) => kept.includes(f.id)).map((f) => f.id);
    expect(kept).toEqual(order);
  });

  it("restores fields when the window grows back", () => {
    expect(fitFields(FIELDS, widths, 300)).toHaveLength(3);
    expect(fitFields(FIELDS, widths, 700)).toHaveLength(7);
  });

  it("treats an unmeasured field as free rather than cutting its neighbours", () => {
    const partial = new Map([["price", 100]]);
    expect(fitFields(FIELDS, partial, 150)).toHaveLength(FIELDS.length);
  });

  it("handles an empty field list", () => {
    expect(fitFields([], widths, 500)).toEqual([]);
  });
});

describe("honest", () => {
  it("renders the value when the field is covered", () => {
    const f = field("atr", 1, { value: () => "412", covered: () => true });
    expect(honest(f)).toEqual({ text: "412", gap: false });
  });

  it("names the gap when nothing covers the field", () => {
    /* Not a zero, not a dash. On-chain data does not exist for EURUSD, and a
       "0" there would be a number someone could trade on. */
    const f = field("onchain", 8, {
      label: "on-chain",
      value: () => "0",
      covered: () => false,
    });
    /* Only the reason: the label element beside it already says "on-chain",
       and returning the name here rendered "SPREAD spread — none" on screen. */
    expect(honest(f)).toEqual({ text: "none", gap: true });
  });

  it("falls back to the id when a gap field has no label", () => {
    const f = field("funding", 7, { value: () => "x", covered: () => false });
    expect(honest(f).text).toContain("funding");
  });

  it("treats a field with no coverage function as always covered", () => {
    expect(honest(field("price", 1, { value: () => "77,946" }))).toEqual({
      text: "77,946",
      gap: false,
    });
  });
});

/**
 * The ticker slot.
 *
 * `fitFields` is pure and the ticker competes inside it as an ordinary field
 * whose measured width is its MINIMUM legible one. These tests hold the two
 * properties that matter: it is ranked below the numbers, so a narrow row
 * gives it up first; and its width in the fit does not depend on the headline
 * currently on it, or the bar's geometry would change every time the tape
 * rotated.
 */
describe("the ticker in the fit", () => {
  const TICKER = "__ticker";
  const withTicker: LiveField[] = [...FIELDS, field(TICKER, 11, { zone: "market" })];

  it("is given up before any number when the row is tight", () => {
    /* The argument shell.css already made about the tape: a convenience that
       damages the controls around it is not one. */
    const w = new Map(widths);
    w.set(TICKER, 260);
    const kept = fitFields(withTicker, w, 640);
    expect(kept).not.toContain(TICKER);
    expect(kept).toContain("price");
  });

  it("is kept when the row can hold it", () => {
    const w = new Map(widths);
    w.set(TICKER, 260);
    expect(fitFields(withTicker, w, 1200)).toContain(TICKER);
  });

  it("costs the same whatever headline is on it", () => {
    /* Measuring the ticker's CONTENT would let a long headline evict three
       numbers and a short one evict none, so the row's geometry would depend
       on what the tape happened to be saying. */
    const short = new Map(widths);
    short.set(TICKER, 260);
    const long = new Map(widths);
    long.set(TICKER, 260);
    expect(fitFields(withTicker, short, 900)).toEqual(fitFields(withTicker, long, 900));
  });

  it("never costs the price field its place", () => {
    /* Rank 1. There is no width at which a headline outranks the price of the
       thing being looked at. */
    const w = new Map(widths);
    w.set(TICKER, 260);
    for (const room of [200, 400, 600, 900, 1400]) {
      expect(fitFields(withTicker, w, room), String(room)).toContain("price");
    }
  });
});
