import { describe, expect, it } from "vitest";
import {
  applyFilters,
  applySort,
  matches,
  parseFilter,
  selectRow,
  toggleSort,
  toTSV,
  type Column,
} from "../src/ui/table";

interface Row {
  symbol: string;
  score: number | null;
  change: number;
}

const COLUMNS: Column<Row>[] = [
  { id: "symbol", label: "Symbol", value: (r) => r.symbol, filter: "text" },
  { id: "score", label: "Score", value: (r) => r.score, filter: "number", align: "right" },
  { id: "change", label: "Change", value: (r) => r.change, filter: "number", align: "right" },
];

const ROWS: Row[] = [
  { symbol: "BTCUSDT", score: 81, change: -1.42 },
  { symbol: "ETHUSDT", score: 72, change: -0.94 },
  { symbol: "XAUUSD", score: 78, change: 0.61 },
  { symbol: "EURUSD", score: 74, change: 0.18 },
  { symbol: "GBPUSD", score: null, change: -0.11 },
];

const syms = (rows: Row[]): string[] => rows.map((r) => r.symbol);

describe("toggleSort", () => {
  it("sorts descending first — a screener ranked worst-first is the wrong default", () => {
    expect(toggleSort([], "score")).toEqual([{ column: "score", dir: "desc" }]);
  });

  it("starts text columns ascending, because names read A to Z", () => {
    expect(toggleSort([], "symbol", { firstDir: "asc" })).toEqual([
      { column: "symbol", dir: "asc" },
    ]);
  });

  it("flips on a second click and clears on a third", () => {
    const one = toggleSort([], "score");
    const two = toggleSort(one, "score");
    expect(two).toEqual([{ column: "score", dir: "asc" }]);
    expect(toggleSort(two, "score")).toEqual([]);
  });

  it("replaces the key on a plain click of another column", () => {
    const first = toggleSort([], "score");
    expect(toggleSort(first, "change")).toEqual([{ column: "change", dir: "desc" }]);
  });

  it("shift-click ADDS a second key instead of replacing", () => {
    const first = toggleSort([], "score");
    const both = toggleSort(first, "change", { additive: true });
    expect(both).toEqual([
      { column: "score", dir: "desc" },
      { column: "change", dir: "desc" },
    ]);
  });

  it("shift-click flips then removes an existing key, keeping the others", () => {
    const both = toggleSort(toggleSort([], "score"), "change", { additive: true });
    const flipped = toggleSort(both, "score", { additive: true });
    expect(flipped).toContainEqual({ column: "score", dir: "asc" });
    const dropped = toggleSort(flipped, "score", { additive: true });
    expect(dropped.map((k) => k.column)).toEqual(["change"]);
  });
});

describe("applySort", () => {
  it("ranks by score descending", () => {
    const out = applySort(ROWS, COLUMNS, [{ column: "score", dir: "desc" }]);
    expect(syms(out).slice(0, 3)).toEqual(["BTCUSDT", "XAUUSD", "EURUSD"]);
  });

  it("puts nulls last in BOTH directions", () => {
    /* "No score" is not a score of zero and must not lead an ascending sort. */
    const desc = applySort(ROWS, COLUMNS, [{ column: "score", dir: "desc" }]);
    const asc = applySort(ROWS, COLUMNS, [{ column: "score", dir: "asc" }]);
    expect(syms(desc).at(-1)).toBe("GBPUSD");
    expect(syms(asc).at(-1)).toBe("GBPUSD");
  });

  it("applies a second key only within ties on the first", () => {
    const tied: Row[] = [
      { symbol: "AAA", score: 70, change: 1 },
      { symbol: "BBB", score: 70, change: 5 },
      { symbol: "CCC", score: 90, change: 0 },
    ];
    const out = applySort(tied, COLUMNS, [
      { column: "score", dir: "desc" },
      { column: "change", dir: "desc" },
    ]);
    expect(syms(out)).toEqual(["CCC", "BBB", "AAA"]);
  });

  it("is stable: full ties keep their original order", () => {
    const tied: Row[] = [
      { symbol: "AAA", score: 70, change: 1 },
      { symbol: "BBB", score: 70, change: 1 },
      { symbol: "CCC", score: 70, change: 1 },
    ];
    expect(syms(applySort(tied, COLUMNS, [{ column: "score", dir: "desc" }]))).toEqual([
      "AAA",
      "BBB",
      "CCC",
    ]);
  });

  it("returns the original order when nothing is sorted", () => {
    expect(syms(applySort(ROWS, COLUMNS, []))).toEqual(syms(ROWS));
  });

  it("ignores a sort key naming a column that no longer exists", () => {
    expect(syms(applySort(ROWS, COLUMNS, [{ column: "gone", dir: "asc" }]))).toEqual(syms(ROWS));
  });

  it("does not mutate the input", () => {
    const copy = [...ROWS];
    applySort(ROWS, COLUMNS, [{ column: "score", dir: "desc" }]);
    expect(ROWS).toEqual(copy);
  });

  it("sorts symbols naturally, not by raw code point", () => {
    const out = applySort(ROWS, COLUMNS, [{ column: "symbol", dir: "asc" }]);
    expect(syms(out)[0]).toBe("BTCUSDT");
  });
});

describe("parseFilter", () => {
  it("reads comparison operators", () => {
    expect(parseFilter(">70")).toEqual({ op: ">", n: 70 });
    expect(parseFilter(">= 70")).toEqual({ op: ">=", n: 70 });
    expect(parseFilter("<2")).toEqual({ op: "<", n: 2 });
    expect(parseFilter("<=2")).toEqual({ op: "<=", n: 2 });
    expect(parseFilter("=5")).toEqual({ op: "=", n: 5 });
    expect(parseFilter("!=5")).toEqual({ op: "!=", n: 5 });
  });

  it("reads a range with .. and orders the bounds", () => {
    expect(parseFilter("70..90")).toEqual({ op: "range", n: 70, hi: 90 });
    expect(parseFilter("90..70")).toEqual({ op: "range", n: 70, hi: 90 });
  });

  it("uses .. rather than - so a negative number is never ambiguous", () => {
    /* `-5` has to stay a number; `1-5` as a range would make it unreadable. */
    expect(parseFilter("<-5")).toEqual({ op: "<", n: -5 });
    expect(parseFilter("-1.5..1.5")).toEqual({ op: "range", n: -1.5, hi: 1.5 });
  });

  it("treats anything else as a substring match", () => {
    expect(parseFilter("usdt")).toEqual({ op: "text", text: "usdt" });
    expect(parseFilter("BTC")).toEqual({ op: "text", text: "btc" });
  });

  it("returns null for an empty cell — no filter, not 'match nothing'", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
  });

  it("does not silently empty the table on a typo", () => {
    /* ">" with no number is not a comparison; falling back to a text match
       finds nothing dangerous, and the row count says so out loud. */
    expect(parseFilter(">")).toEqual({ op: "text", text: ">" });
  });
});

describe("matches", () => {
  it("compares numbers", () => {
    expect(matches(81, { op: ">", n: 70 })).toBe(true);
    expect(matches(70, { op: ">", n: 70 })).toBe(false);
    expect(matches(70, { op: ">=", n: 70 })).toBe(true);
  });

  it("rejects a numeric comparison against a missing value", () => {
    /* "score > 70" must not keep rows whose score is missing. */
    expect(matches(null, { op: ">", n: 70 })).toBe(false);
    expect(matches("n/a", { op: ">", n: 70 })).toBe(false);
  });

  it("matches text case-insensitively, anywhere in the value", () => {
    expect(matches("BTCUSDT", { op: "text", text: "usd" })).toBe(true);
    expect(matches("BTCUSDT", { op: "text", text: "eur" })).toBe(false);
  });

  it("a text filter never matches a missing value", () => {
    expect(matches(null, { op: "text", text: "btc" })).toBe(false);
  });

  it("range is inclusive at both ends", () => {
    expect(matches(70, { op: "range", n: 70, hi: 90 })).toBe(true);
    expect(matches(90, { op: "range", n: 70, hi: 90 })).toBe(true);
    expect(matches(69.9, { op: "range", n: 70, hi: 90 })).toBe(false);
  });
});

describe("applyFilters", () => {
  it("reports how many rows it removed", () => {
    const r = applyFilters(ROWS, COLUMNS, { score: ">75" });
    expect(syms(r.rows)).toEqual(["BTCUSDT", "XAUUSD"]);
    expect(r.removed).toBe(3);
    expect(r.active).toBe(1);
  });

  it("ANDs several columns together", () => {
    const r = applyFilters(ROWS, COLUMNS, { symbol: "usd", score: ">73" });
    expect(syms(r.rows)).toEqual(["BTCUSDT", "XAUUSD", "EURUSD"]);
    expect(r.active).toBe(2);
  });

  it("ignores empty cells", () => {
    const r = applyFilters(ROWS, COLUMNS, { score: "  ", symbol: "" });
    expect(r.rows).toHaveLength(ROWS.length);
    expect(r.active).toBe(0);
  });

  it("ignores a filter naming a column that no longer exists", () => {
    const r = applyFilters(ROWS, COLUMNS, { gone: ">5" });
    expect(r.rows).toHaveLength(ROWS.length);
  });

  it("drops rows with no value when a numeric filter is set", () => {
    expect(syms(applyFilters(ROWS, COLUMNS, { score: ">0" }).rows)).not.toContain("GBPUSD");
  });
});

describe("selectRow", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("a plain click selects one row and sets the anchor", () => {
    const r = selectRow(keys, new Set(), null, "b", {});
    expect([...r.selected]).toEqual(["b"]);
    expect(r.anchor).toBe("b");
  });

  it("a plain click on the only selected row clears the selection", () => {
    const r = selectRow(keys, new Set(["b"]), "b", "b", {});
    expect(r.selected.size).toBe(0);
    expect(r.anchor).toBeNull();
  });

  it("ctrl-click adds and removes without touching the rest", () => {
    const added = selectRow(keys, new Set(["a"]), "a", "c", { ctrl: true });
    expect([...added.selected].sort()).toEqual(["a", "c"]);
    const removed = selectRow(keys, added.selected, added.anchor, "a", { ctrl: true });
    expect([...removed.selected]).toEqual(["c"]);
  });

  it("shift-click selects the span from the anchor", () => {
    const r = selectRow(keys, new Set(["b"]), "b", "d", { shift: true });
    expect([...r.selected]).toEqual(["b", "c", "d"]);
  });

  it("shift-click works backwards too", () => {
    const r = selectRow(keys, new Set(["d"]), "d", "b", { shift: true });
    expect([...r.selected]).toEqual(["b", "c", "d"]);
  });

  it("shift-click does NOT move the anchor, so a second one spans correctly", () => {
    const first = selectRow(keys, new Set(["b"]), "b", "d", { shift: true });
    expect(first.anchor).toBe("b");
    const second = selectRow(keys, first.selected, first.anchor, "e", { shift: true });
    expect([...second.selected]).toEqual(["b", "c", "d", "e"]);
  });

  it("falls back to a plain click when there is no anchor", () => {
    const r = selectRow(keys, new Set(), null, "c", { shift: true });
    expect([...r.selected]).toEqual(["c"]);
  });
});

describe("toTSV", () => {
  it("includes the header and one line per row", () => {
    const out = toTSV(ROWS.slice(0, 2), COLUMNS);
    expect(out.split("\n")).toEqual([
      "Symbol\tScore\tChange",
      "BTCUSDT\t81\t-1.42",
      "ETHUSDT\t72\t-0.94",
    ]);
  });

  it("renders a missing value as empty rather than the word null", () => {
    expect(toTSV([ROWS[4] as Row], COLUMNS).split("\n")[1]).toBe("GBPUSD\t\t-0.11");
  });

  it("strips tabs and newlines that would break the column count", () => {
    const cols: Column<{ note: string }>[] = [
      { id: "note", label: "Note", value: (r) => r.note },
    ];
    expect(toTSV([{ note: "a\tb\nc" }], cols).split("\n")[1]).toBe("a b c");
  });
});
