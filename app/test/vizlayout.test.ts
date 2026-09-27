/**
 * WHERE THE NODES GO — `viz/layout.ts`.
 *
 * A NETWORK PICTURE IS THE EASIEST KIND OF CHART TO LIE WITH. `ui/cards/plot.ts`
 * records why the equity curves became pure functions: a wrong SCALE looks
 * exactly like the truth, because the shape is plausible and nothing is red. A
 * graph is worse. Two nodes drawn close together read as related whether or not
 * an edge says so, a node drawn large reads as important, and an edge drawn at
 * all reads as a fact. None of that is checkable by eye.
 *
 * THE TEST THAT MATTERS IS `the same graph lays out identically every time`.
 * A force layout seeded from `Math.random` moves every time it is drawn, so two
 * screenshots of one unchanged market cannot be compared and the operator learns
 * that the picture means nothing. Determinism is not a nicety here; it is what
 * makes the thing readable at all.
 *
 * THE SECOND IS `an edge naming a node that does not exist is REFUSED`. Drawing
 * it to the origin puts a line on screen that describes nothing, which is the
 * same class as the explorer link built from a guessed pattern: worse than
 * nothing, because it looks like information.
 */

import { describe, expect, it } from "vitest";
import {
  BOX_FLOOR,
  fitToBox,
  forceLayout,
  radialLayout,
  validateGraph,
  type GraphEdge,
  type GraphNode,
} from "../src/viz/layout";

const BOX = { w: 800, h: 600 };

const node = (id: string, group: string | null = null, weight = 0.5): GraphNode => ({
  id,
  label: id.toUpperCase(),
  group,
  weight,
});

const edge = (from: string, to: string, value = 0.5, confidence = 1): GraphEdge => ({
  from,
  to,
  value,
  confidence,
});

const NODES = [
  node("btc", "crypto", 1),
  node("eth", "crypto", 0.8),
  node("xau", "metals", 0.6),
  node("dxy", "macro", 0.4),
  node("vix", "macro", 0.3),
];

const EDGES = [
  edge("btc", "eth", 0.9),
  edge("btc", "dxy", -0.4),
  edge("xau", "dxy", -0.6),
  edge("vix", "btc", -0.2),
];

describe("the graph is checked before it is drawn", () => {
  it("AN EDGE NAMING A NODE THAT DOES NOT EXIST IS REFUSED, BY NAME", () => {
    /* Drawing it to the origin puts a line on screen that describes nothing —
       the same class as an explorer URL guessed from a pattern, which sends the
       reader somewhere real-looking and wrong. */
    const bad = validateGraph(NODES, [...EDGES, edge("btc", "ghost")]);
    expect(bad.ok).toBe(false);
    expect(bad.why).toContain("ghost");
  });

  it("refuses a duplicate node id rather than drawing one over the other", () => {
    const dupe = validateGraph([...NODES, node("btc")], EDGES);
    expect(dupe.ok).toBe(false);
    expect(dupe.why).toContain("btc");
  });

  it("refuses an edge from a node to itself, which has no length to draw", () => {
    const loop = validateGraph(NODES, [edge("btc", "btc")]);
    expect(loop.ok).toBe(false);
    expect(loop.why).toContain("itself");
  });

  it("accepts a graph with no edges at all — that is a real answer", () => {
    // "Nothing correlates above the floor" is a finding, not a failure.
    expect(validateGraph(NODES, []).ok).toBe(true);
  });

  it("refuses a box too small to place anything in", () => {
    // Dividing by a zero-width box is how a layout produces NaN, and NaN
    // coordinates are dropped silently by canvas and read as "broken".
    expect(validateGraph(NODES, EDGES, { w: 4, h: 4 }).ok).toBe(false);
    expect(validateGraph(NODES, EDGES, { w: BOX_FLOOR, h: BOX_FLOOR }).ok).toBe(true);
  });
});

describe("the radial layout", () => {
  const placed = radialLayout(NODES, BOX);

  it("places every node, once", () => {
    expect(placed.nodes).toHaveLength(NODES.length);
    expect(new Set(placed.nodes.map((p) => p.id)).size).toBe(NODES.length);
  });

  it("keeps every node inside the box, including its own radius", () => {
    // A node clipped by the edge reads as a node that is partly missing.
    for (const p of placed.nodes) {
      expect(p.x - p.r, p.id).toBeGreaterThanOrEqual(0);
      expect(p.y - p.r, p.id).toBeGreaterThanOrEqual(0);
      expect(p.x + p.r, p.id).toBeLessThanOrEqual(BOX.w);
      expect(p.y + p.r, p.id).toBeLessThanOrEqual(BOX.h);
    }
  });

  it("gives every node a finite position and a positive radius", () => {
    // NaN in a coordinate draws as nothing at all, which reads as broken.
    for (const p of placed.nodes) {
      expect(Number.isFinite(p.x), p.id).toBe(true);
      expect(Number.isFinite(p.y), p.id).toBe(true);
      expect(p.r, p.id).toBeGreaterThan(0);
    }
  });

  it("puts members of one group together and apart from another group", () => {
    // The grouping IS the claim the ring makes. If it does not hold visually,
    // the ring is decoration.
    const at = (id: string) => placed.nodes.find((p) => p.id === id)!;
    const gap = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    expect(gap("btc", "eth")).toBeLessThan(gap("btc", "dxy"));
  });

  it("SIZES BY WEIGHT, and a zero weight is still visible", () => {
    // A node drawn at zero radius is a node that is not there. Absent from the
    // picture and present in the data is the worst available combination.
    const withZero = radialLayout([node("a", "g", 1), node("b", "g", 0)], BOX);
    const [a, b] = withZero.nodes;
    expect(a!.r).toBeGreaterThan(b!.r);
    expect(b!.r).toBeGreaterThan(0);
  });

  it("handles a single node without dividing by the count", () => {
    const one = radialLayout([node("solo")], BOX);
    expect(one.nodes).toHaveLength(1);
    expect(Number.isFinite(one.nodes[0]!.x)).toBe(true);
    expect(Number.isFinite(one.nodes[0]!.y)).toBe(true);
  });

  it("handles no nodes at all without producing a phantom", () => {
    expect(radialLayout([], BOX).nodes).toHaveLength(0);
  });
});

describe("the force layout", () => {
  it("THE SAME GRAPH LAYS OUT IDENTICALLY EVERY TIME", () => {
    /* A layout seeded from `Math.random` moves on every draw, so two pictures of
       one unchanged market cannot be compared and the operator correctly stops
       reading it. Determinism is what makes the picture mean anything. */
    const a = forceLayout(NODES, EDGES, BOX);
    const b = forceLayout(NODES, EDGES, BOX);
    expect(a.nodes).toEqual(b.nodes);
  });

  it("and a different graph lays out differently, so it is not a fixed picture", () => {
    // Guards against the determinism above being satisfied by ignoring the input.
    const a = forceLayout(NODES, EDGES, BOX);
    const b = forceLayout(NODES, [edge("btc", "eth", 0.1)], BOX);
    expect(a.nodes).not.toEqual(b.nodes);
  });

  it("keeps everything inside the box", () => {
    const p = forceLayout(NODES, EDGES, BOX);
    for (const n of p.nodes) {
      expect(n.x - n.r, n.id).toBeGreaterThanOrEqual(0);
      expect(n.y - n.r, n.id).toBeGreaterThanOrEqual(0);
      expect(n.x + n.r, n.id).toBeLessThanOrEqual(BOX.w);
      expect(n.y + n.r, n.id).toBeLessThanOrEqual(BOX.h);
    }
  });

  it("SEPARATES TWO NODES THAT START IN THE SAME PLACE", () => {
    /* Coincident nodes make the repulsion vector a division by zero, and one NaN
       coordinate takes the node off the canvas silently. The seeded start must
       not put two nodes on the same point, and the step must survive it if it
       somehow does. */
    const p = forceLayout([node("a"), node("b")], [], BOX);
    const [a, b] = p.nodes;
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(0);
    expect(Number.isFinite(a!.x) && Number.isFinite(b!.x)).toBe(true);
  });

  it("pulls a strongly related pair closer than an unrelated one", () => {
    // The whole claim of a force graph is that distance means something.
    const nodes = [node("a"), node("b"), node("c")];
    const p = forceLayout(nodes, [edge("a", "b", 0.95)], BOX, { steps: 400 });
    const at = (id: string) => p.nodes.find((n) => n.id === id)!;
    const ab = Math.hypot(at("a").x - at("b").x, at("a").y - at("b").y);
    const ac = Math.hypot(at("a").x - at("c").x, at("a").y - at("c").y);
    expect(ab).toBeLessThan(ac);
  });

  it("USES THE ABSOLUTE VALUE OF A SIGNED EDGE FOR DISTANCE", () => {
    /* A correlation of -0.9 is as strong a relationship as +0.9 and belongs just
       as close; only the COLOUR should carry the sign. Treating -0.9 as weak
       would push the most reliable inverse pairs — gold against the dollar — to
       the edge of the picture, which is precisely backwards. */
    const nodes = [node("a"), node("b"), node("c")];
    const pos = forceLayout(nodes, [edge("a", "b", 0.9)], BOX, { steps: 400 });
    const neg = forceLayout(nodes, [edge("a", "b", -0.9)], BOX, { steps: 400 });
    const d = (p: typeof pos, x: string, y: string) => {
      const A = p.nodes.find((n) => n.id === x)!;
      const B = p.nodes.find((n) => n.id === y)!;
      return Math.hypot(A.x - B.x, A.y - B.y);
    };
    expect(d(neg, "a", "b")).toBeCloseTo(d(pos, "a", "b"), 6);
  });

  it("never emits a NaN, however unreasonable the weights", () => {
    const weird = [node("a", null, Number.NaN), node("b", null, Infinity), node("c", null, -5)];
    const p = forceLayout(weird, [edge("a", "b", Number.NaN), edge("b", "c", Infinity)], BOX);
    for (const n of p.nodes) {
      expect(Number.isFinite(n.x), n.id).toBe(true);
      expect(Number.isFinite(n.y), n.id).toBe(true);
      expect(Number.isFinite(n.r), n.id).toBe(true);
      expect(n.r).toBeGreaterThan(0);
    }
  });
});

describe("filling the box without distorting what it means", () => {
  /* MEASURED ON THE REAL DESK BEFORE THIS EXISTED. Fifteen markets settled into
     a blob using 23.3% of the canvas width and 37.9% of its height — three
     quarters of the picture was empty, which this project has photographed as a
     defect on four other surfaces. Relaxation decides the SHAPE; this decides
     how much of the available room that shape occupies. */

  const blob = [
    { id: "a", x: 300, y: 300, r: 8 },
    { id: "b", x: 340, y: 310, r: 6 },
    { id: "c", x: 320, y: 360, r: 10 },
  ];

  it("USES MOST OF THE BOX IN AT LEAST ONE DIRECTION", () => {
    /* A UNIFORM SCALE CANNOT FILL BOTH unless the blob happens to share the
       box's aspect ratio — which is exactly the constraint that keeps distance
       meaningful, so the limiting dimension is the honest thing to assert. This
       fixture is 40 wide by 60 tall in an 800x600 box: height governs, and
       demanding 50% of BOTH would have been a test asking for a distortion. */
    const out = fitToBox(blob, BOX);
    const xs = out.map((n) => n.x);
    const ys = out.map((n) => n.y);
    const wUsed = (Math.max(...xs) - Math.min(...xs)) / BOX.w;
    const hUsed = (Math.max(...ys) - Math.min(...ys)) / BOX.h;
    expect(Math.max(wUsed, hUsed)).toBeGreaterThan(0.85);
    // And the blob measured on the real desk used 23% x 38%; both improve.
    expect(Math.min(wUsed, hUsed)).toBeGreaterThan(0.4);
  });

  it("SCALES UNIFORMLY, so distance keeps meaning the same thing", () => {
    /* THE LOAD-BEARING WORD IS UNIFORM. Stretching x and y by different factors
       to fill a wide box would make a horizontal pair look closer than a
       vertical pair at the identical correlation — the one claim the layout
       makes, quietly broken to use up space. Every RATIO of distances must
       survive. */
    const out = fitToBox(blob, BOX);
    const d = (p: typeof out, i: number, j: number) =>
      Math.hypot(p[i]!.x - p[j]!.x, p[i]!.y - p[j]!.y);
    const before = d(blob, 0, 1) / d(blob, 0, 2);
    const after = d(out, 0, 1) / d(out, 0, 2);
    expect(after).toBeCloseTo(before, 6);
  });

  it("keeps every node and its radius inside the box", () => {
    for (const n of fitToBox(blob, BOX)) {
      expect(n.x - n.r).toBeGreaterThanOrEqual(0);
      expect(n.y - n.r).toBeGreaterThanOrEqual(0);
      expect(n.x + n.r).toBeLessThanOrEqual(BOX.w);
      expect(n.y + n.r).toBeLessThanOrEqual(BOX.h);
    }
  });

  it("centres a single node rather than dividing by a zero span", () => {
    // One node has no extent, and scaling by 1/0 is how a layout produces NaN.
    const one = fitToBox([{ id: "solo", x: 5, y: 5, r: 7 }], BOX);
    expect(one[0]!.x).toBeCloseTo(BOX.w / 2, 6);
    expect(one[0]!.y).toBeCloseTo(BOX.h / 2, 6);
  });

  it("survives every node sharing one position", () => {
    const stacked = fitToBox(
      [{ id: "a", x: 9, y: 9, r: 4 }, { id: "b", x: 9, y: 9, r: 4 }],
      BOX,
    );
    for (const n of stacked) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("an empty layout stays empty", () => {
    expect(fitToBox([], BOX)).toHaveLength(0);
  });

  it("the force layout already fills the box, so a caller need not remember", () => {
    // The defect was in what reached the screen, so the fix belongs where the
    // positions are produced rather than in each card that draws them.
    const p = forceLayout(NODES, EDGES, BOX);
    const xs = p.nodes.map((n) => n.x);
    expect((Math.max(...xs) - Math.min(...xs)) / BOX.w).toBeGreaterThan(0.5);
  });
});

describe("the layout suits the shape of its canvas", () => {
  /* MEASURED ON THE REAL DESK. Once the clipping was fixed the stage became
     1448x366 — wide and short — and the graph settled into its usual round blob,
     filling 89% of the height and 21% of the width. Uniform scaling is what
     keeps distance meaningful and it cannot rescue a square arrangement in an
     oblong box, so the ARRANGEMENT has to start the right shape. */

  const WIDE = { w: 1400, h: 360 };

  const spanOf = (p: { nodes: readonly { x: number; y: number }[] }) => {
    const xs = p.nodes.map((n) => n.x);
    const ys = p.nodes.map((n) => n.y);
    return {
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  };

  it("SPREADS WIDER IN A WIDE BOX than it does in a square one", () => {
    const wide = spanOf(forceLayout(NODES, EDGES, WIDE));
    const square = spanOf(forceLayout(NODES, EDGES, { w: 700, h: 700 }));
    expect(wide.w / wide.h).toBeGreaterThan(square.w / square.h);
  });

  it("uses a real share of a wide canvas in BOTH directions", () => {
    const p = forceLayout(NODES, EDGES, WIDE);
    const s = spanOf(p);
    expect(s.w / WIDE.w).toBeGreaterThan(0.55);
    expect(s.h / WIDE.h).toBeGreaterThan(0.4);
  });

  it("is still deterministic once the shape is involved", () => {
    expect(forceLayout(NODES, EDGES, WIDE).nodes).toEqual(forceLayout(NODES, EDGES, WIDE).nodes);
  });

  it("STILL SCALES UNIFORMLY — the arrangement changed, not the meaning", () => {
    /* The seeding may suit the box; the SCALE must not, or a horizontal pair
       reads as closer than a vertical pair at the identical correlation. */
    const p = forceLayout(NODES, EDGES, WIDE);
    const at = (id: string) => p.nodes.find((n) => n.id === id)!;
    const d = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    // btc-eth is the strongest edge in the fixture; it must still be nearest.
    const near = d("btc", "eth");
    expect(near).toBeLessThan(d("btc", "vix"));
  });
});
