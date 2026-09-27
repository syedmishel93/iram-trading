/**
 * HOW THE GRAPH IS DRAWN — `viz/render.ts`.
 *
 * The encoding is a pure function and not a run of inline canvas calls, for the
 * reason this repository keeps relearning: the picture is the claim, and nothing
 * about a picture can be checked by looking at it. A thick line reads as a
 * strong relationship. A solid line reads as a settled one. A red line reads as
 * a warning. Every one of those is an assertion about the data, so every one of
 * them is tested here.
 *
 * THE TEST THAT MATTERS IS `an unstable edge is never drawn like a settled one`.
 * `backtest/correlate.ts` goes to real trouble to find pairs whose correlation
 * reversed inside the window — and if the renderer then paints them identically
 * to a steady pair, that work reaches the operator as nothing at all.
 *
 * THE SECOND IS `colour carries the SIGN, width carries the STRENGTH`. CLAUDE.md:
 * "Colour follows the STANDING, never the number." An inverse relationship is
 * not a weak one, and drawing -0.9 as a thin line would say it is.
 */

import { describe, expect, it } from "vitest";
import { edgeStyle, hitTest, nodeStyle, placeLabels, TEST_PALETTE } from "../src/viz/render";
import type { CorrelationEdge } from "../src/backtest/correlate";

const P = TEST_PALETTE;

const edge = (over: Partial<CorrelationEdge> = {}): CorrelationEdge => ({
  from: "a",
  to: "b",
  value: 0.7,
  confidence: 1,
  n: 300,
  instability: 0.2,
  stable: true,
  windowFrom: 0,
  windowTo: 1,
  ...over,
});

describe("what an edge is drawn like", () => {
  it("COLOUR CARRIES THE SIGN", () => {
    // "Colour follows the STANDING, never the number."
    expect(edgeStyle(edge({ value: 0.7 }), P).stroke).toBe(P.pos);
    expect(edgeStyle(edge({ value: -0.7 }), P).stroke).toBe(P.neg);
  });

  it("WIDTH CARRIES THE STRENGTH, and an inverse pair is not thin", () => {
    /* Gold against the dollar is one of the most reliable inverse pairs there
       is. Drawing -0.9 thinner than +0.9 would say it is a weaker relationship,
       which is simply false. */
    const strongUp = edgeStyle(edge({ value: 0.9 }), P);
    const strongDown = edgeStyle(edge({ value: -0.9 }), P);
    const weak = edgeStyle(edge({ value: 0.35 }), P);
    expect(strongDown.width).toBeCloseTo(strongUp.width, 6);
    expect(strongUp.width).toBeGreaterThan(weak.width);
  });

  it("AN UNSTABLE EDGE IS NEVER DRAWN LIKE A SETTLED ONE", () => {
    /* `correlate.ts` re-measures every pair in sub-windows to catch a
       correlation that reversed. If both come out identical on screen, that
       whole measurement reaches the operator as nothing. */
    const settled = edgeStyle(edge({ stable: true }), P);
    const shaky = edgeStyle(edge({ stable: false, instability: 1.4 }), P);
    expect(shaky.dash.length).toBeGreaterThan(0);
    expect(settled.dash).toHaveLength(0);
    expect(shaky.alpha).toBeLessThan(settled.alpha);
  });

  it("a strong-but-unstable edge stays THICK, because it is still strong", () => {
    // Instability is a statement about confidence, not about magnitude. Thinning
    // it would conflate two different facts into one channel.
    const shaky = edgeStyle(edge({ value: 0.9, stable: false }), P);
    const weakSteady = edgeStyle(edge({ value: 0.35, stable: true }), P);
    expect(shaky.width).toBeGreaterThan(weakSteady.width);
  });

  it("never returns a width of zero or a non-finite one", () => {
    // A zero-width line is an edge that is in the data and not on the screen.
    for (const v of [0, 1, -1, Number.NaN, Infinity, 99]) {
      const s = edgeStyle(edge({ value: v }), P);
      expect(Number.isFinite(s.width), String(v)).toBe(true);
      expect(s.width, String(v)).toBeGreaterThan(0);
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });

  it("a hovered edge is emphasised without changing what it means", () => {
    // Hover may brighten; it must not restyle the sign or the dash, or the
    // picture would say something different under the pointer.
    const base = edgeStyle(edge({ value: -0.8, stable: false }), P);
    const hot = edgeStyle(edge({ value: -0.8, stable: false }), P, true);
    expect(hot.stroke).toBe(base.stroke);
    expect(hot.dash).toEqual(base.dash);
    expect(hot.alpha).toBeGreaterThanOrEqual(base.alpha);
  });
});

describe("what a node is drawn like", () => {
  it("uses the text colour, not a per-node hue", () => {
    /* A palette stops meaning anything when it is reached for to make something
       look important. Size already carries how connected a market is. */
    const s = nodeStyle(0.9, P);
    expect(s.fill).toBe(P.surface);
    expect(s.stroke).toBe(P.text);
  });

  it("dims a node nothing connects to, rather than hiding it", () => {
    // Present in the data and absent from the picture is the worst pair.
    const lonely = nodeStyle(0, P);
    const busy = nodeStyle(1, P);
    expect(lonely.alpha).toBeLessThan(busy.alpha);
    expect(lonely.alpha).toBeGreaterThan(0.2);
  });
});

describe("finding what is under the pointer", () => {
  const placed = [
    { id: "btc", x: 100, y: 100, r: 12 },
    { id: "eth", x: 200, y: 100, r: 8 },
    { id: "dxy", x: 300, y: 300, r: 6 },
  ];

  it("returns the node under the point", () => {
    expect(hitTest(placed, 100, 100)).toBe("btc");
    expect(hitTest(placed, 202, 103)).toBe("eth");
  });

  it("returns null on empty space rather than the nearest thing", () => {
    // Snapping to the nearest node makes a tooltip appear for a market the
    // pointer is nowhere near, which reads as the wrong market being described.
    expect(hitTest(placed, 500, 500)).toBeNull();
  });

  it("PREFERS THE TOPMOST WHEN TWO OVERLAP", () => {
    /* Drawing order is last-on-top, so hit-testing must walk BACKWARDS. Testing
       forwards returns the node that is visually underneath, and the tooltip
       then names something the operator cannot see. */
    const stacked = [
      { id: "under", x: 50, y: 50, r: 20 },
      { id: "over", x: 50, y: 50, r: 10 },
    ];
    expect(hitTest(stacked, 50, 50)).toBe("over");
  });

  it("has a minimum touch target, so a small node is still reachable", () => {
    const tiny = [{ id: "t", x: 10, y: 10, r: 2 }];
    expect(hitTest(tiny, 15, 10)).toBe("t");
  });

  it("survives an empty layout", () => {
    expect(hitTest([], 0, 0)).toBeNull();
  });
});

describe("which labels get drawn", () => {
  /* THE SAME RULE THE CHART AXIS ALREADY USES. CLAUDE.md: a label that no longer
     fits is SKIPPED, and because the cursor did not advance the next one still
     gets its chance. Here the dense crypto cluster put five labels on top of
     each other and none of them was readable — five markets present in the data
     and none of them named. */

  const w = (t: string) => t.length * 6; // a stand-in for measureText

  const at = (id: string, x: number, y: number, r = 8) => ({ id, x, y, r });

  it("draws every label when nothing collides", () => {
    const nodes = [at("a", 50, 50), at("b", 250, 50), at("c", 450, 50)];
    const keep = placeLabels(nodes, { a: "AAA", b: "BBB", c: "CCC" }, w, null);
    expect(keep.size).toBe(3);
  });

  it("SKIPS A LABEL THAT WOULD LAND ON ONE ALREADY DRAWN", () => {
    const nodes = [at("a", 100, 100), at("b", 104, 103), at("c", 108, 101)];
    const keep = placeLabels(nodes, { a: "BTCUSDT", b: "ETHUSDT", c: "SOLUSDT" }, w, null);
    expect(keep.size).toBeLessThan(3);
    expect(keep.size).toBeGreaterThan(0);
  });

  it("ALWAYS DRAWS THE HOVERED ONE, whatever it overlaps", () => {
    /* The pointer is a question about ONE market, and answering it by hiding
       that market's name because a neighbour got there first would be the one
       moment the picture must not skip. */
    const nodes = [at("a", 100, 100), at("b", 104, 103)];
    const keep = placeLabels(nodes, { a: "BTCUSDT", b: "ETHUSDT" }, w, "b");
    expect(keep.has("b")).toBe(true);
  });

  it("prefers the bigger node when two collide, because size is connectedness", () => {
    // If one of two names has to go, keep the one the picture says matters more.
    const nodes = [at("small", 100, 100, 4), at("big", 104, 103, 14)];
    const keep = placeLabels(nodes, { small: "AAA", big: "BBB" }, w, null);
    expect(keep.has("big")).toBe(true);
  });

  it("is deterministic, like the layout it labels", () => {
    const nodes = [at("a", 100, 100), at("b", 104, 103), at("c", 108, 101)];
    const one = [...placeLabels(nodes, { a: "AAA", b: "BBB", c: "CCC" }, w, null)].sort();
    const two = [...placeLabels(nodes, { a: "AAA", b: "BBB", c: "CCC" }, w, null)].sort();
    expect(one).toEqual(two);
  });
});
