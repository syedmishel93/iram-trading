import { describe, it, expect } from "vitest";
import { fuzzyMatch, rank } from "../src/core/fuzzy";

describe("fuzzyMatch", () => {
  it("matches a plain substring", () => {
    const m = fuzzyMatch("block", "Order Block");
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([6, 7, 8, 9, 10]);
  });

  it("matches a scattered subsequence", () => {
    const m = fuzzyMatch("ordblk", "Order Block");
    expect(m).not.toBeNull();
    expect(m?.positions?.length).toBe(6);
  });

  it("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "Order Block")).toBeNull();
  });

  it("rejects a query longer than the target", () => {
    expect(fuzzyMatch("abcdef", "abc")).toBeNull();
  });

  it("returns a zero-score empty match for an empty query", () => {
    const m = fuzzyMatch("", "anything");
    expect(m).toEqual({ score: 0, positions: [] });
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("ORDER", "order block")).not.toBeNull();
    expect(fuzzyMatch("order", "ORDER BLOCK")).not.toBeNull();
  });

  it("returns positions that actually spell the query", () => {
    const target = "Workspace: Horizontal split";
    const m = fuzzyMatch("wsh", target);
    expect(m).not.toBeNull();
    const spelled = (m as { positions: readonly number[] }).positions
      .map((i) => target[i])
      .join("")
      .toLowerCase();
    expect(spelled).toBe("wsh");
  });

  it("positions are strictly ascending", () => {
    const m = fuzzyMatch("oblk", "Order Block Overlay");
    const pos = (m as { positions: readonly number[] }).positions;
    for (let i = 1; i < pos.length; i++) {
      expect(pos[i] as number).toBeGreaterThan(pos[i - 1] as number);
    }
  });

  // The whole point of the boundary bonus: initials beat interior letters.
  it("scores word-initials above mid-word hits", () => {
    const initials = fuzzyMatch("ob", "Order Block");
    const interior = fuzzyMatch("ob", "Robot Handbook");
    expect(initials).not.toBeNull();
    expect(interior).not.toBeNull();
    expect((initials as { score: number }).score).toBeGreaterThan(
      (interior as { score: number }).score,
    );
  });

  it("scores consecutive runs above scattered hits", () => {
    const run = fuzzyMatch("orde", "order");
    const scattered = fuzzyMatch("orde", "o r d e");
    expect((run as { score: number }).score).toBeGreaterThan(
      (scattered as { score: number }).score,
    );
  });

  it("scores a prefix match above a late match", () => {
    const early = fuzzyMatch("cha", "Chart settings");
    const late = fuzzyMatch("cha", "Reset the chart");
    expect((early as { score: number }).score).toBeGreaterThan(
      (late as { score: number }).score,
    );
  });

  it("recognises camelCase humps as boundaries", () => {
    const camel = fuzzyMatch("ob", "orderBlock");
    const flat = fuzzyMatch("ob", "orderblock");
    expect((camel as { score: number }).score).toBeGreaterThan(
      (flat as { score: number }).score,
    );
  });

  it("prefers the shorter of two otherwise equal targets", () => {
    const short = fuzzyMatch("ema", "EMA");
    const long = fuzzyMatch("ema", "EMA with a very long trailing description");
    expect((short as { score: number }).score).toBeGreaterThan(
      (long as { score: number }).score,
    );
  });

  // Regression: an early greedy match can strand the rest of the query. The
  // alignment must be free to skip the first "a" of "banana" to match "ana"
  // wherever it actually fits.
  it("finds a match that requires skipping an earlier candidate character", () => {
    const m = fuzzyMatch("nn", "banana");
    expect(m).not.toBeNull();
    expect((m as { positions: readonly number[] }).positions).toEqual([2, 4]);
  });

  it("handles a target of one character", () => {
    expect(fuzzyMatch("a", "a")).not.toBeNull();
    expect(fuzzyMatch("b", "a")).toBeNull();
  });

  it("survives regex-special characters in either argument", () => {
    expect(fuzzyMatch("(", "f(x)")).not.toBeNull();
    expect(fuzzyMatch(".*", "a.*b")).not.toBeNull();
  });
});

describe("rank", () => {
  const items = ["Order Block", "Break of Structure", "Fair Value Gap", "Order Flow"];

  it("returns every item for an empty query", () => {
    expect(rank(items, "", (s) => s).length).toBe(4);
  });

  it("drops non-matches", () => {
    const out = rank(items, "order", (s) => s);
    expect(out.map((r) => r.item).sort()).toEqual(["Order Block", "Order Flow"]);
  });

  // Falls out of the per-unmatched-character penalty, and is the behaviour you
  // want: with the same prefix matched, the tighter title is the better answer.
  it("puts the shorter of two equally-prefixed titles first", () => {
    const out = rank(["Order Block", "Order Flow"], "order", (s) => s);
    expect(out[0]?.item).toBe("Order Flow");
  });

  it("honours the limit", () => {
    expect(rank(items, "o", (s) => s, 2).length).toBe(2);
  });

  it("matches against alternate haystacks", () => {
    const out = rank(items, "fvg", (s) => [s, s === "Fair Value Gap" ? "fvg gap imbalance" : ""]);
    expect(out[0]?.item).toBe("Fair Value Gap");
  });

  // The handicap exists so a visible-title hit always beats an invisible
  // keyword hit of the same quality — otherwise results look arbitrary.
  it("ranks a title hit above an equal keyword hit", () => {
    const pool = [
      { title: "zzz", keywords: "alpha" },
      { title: "alpha", keywords: "zzz" },
    ];
    const out = rank(pool, "alpha", (p) => [p.title, p.keywords]);
    expect(out[0]?.item.title).toBe("alpha");
  });

  it("reports positions from the visible haystack only", () => {
    // "imb" is not a subsequence of the title, so there is nothing to highlight
    // there — and painting highlights over a keyword nobody can see is a lie
    // about why the row is in the list.
    const out = rank([{ t: "Fair Value Gap", k: "imbalance" }], "imb", (p) => [p.t, p.k]);
    expect(out.length).toBe(1);
    expect(out[0]?.positions).toEqual([]);
  });

  it("highlights the title when the query does match it", () => {
    const out = rank([{ t: "Fair Value Gap", k: "imbalance" }], "fvg", (p) => [p.t, p.k]);
    expect(out[0]?.positions).toEqual([0, 5, 11]);
  });

  it("keeps registration order among equal scores", () => {
    const pool = ["aa", "ab", "ac"];
    const out = rank(pool, "a", (s) => s);
    expect(out.map((r) => r.item)).toEqual(["aa", "ab", "ac"]);
  });
});
