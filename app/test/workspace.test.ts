import { describe, it, expect, beforeEach } from "vitest";
import {
  makePane,
  panes,
  paneCount,
  findPane,
  updatePane,
  splitPane,
  closePane,
  setRatio,
  flipSplit,
  applyLink,
  preset,
  geometry,
  clampRatio,
  sanitizeLayout,
  sanitizeWorkspace,
  resetPaneIds,
  MIN_RATIO,
  type LayoutNode,
  type SplitNode,
} from "../src/core/workspace";

beforeEach(() => resetPaneIds());

describe("clampRatio", () => {
  it("keeps a sane ratio", () => {
    expect(clampRatio(0.5)).toBe(0.5);
  });
  // A pane thinner than this cannot draw an axis; it looks broken rather than
  // small, so the model refuses to produce one.
  it("clamps both ends", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(1 - MIN_RATIO);
    expect(clampRatio(-5)).toBe(MIN_RATIO);
  });
  // NaN and Infinity are corruption, not an intent to push the splitter to one
  // side, so both land on an even split rather than an edge.
  it("replaces a non-finite ratio with a half", () => {
    expect(clampRatio(NaN)).toBe(0.5);
    expect(clampRatio(Infinity)).toBe(0.5);
    expect(clampRatio(-Infinity)).toBe(0.5);
  });
});

describe("panes / findPane / paneCount", () => {
  it("counts a single leaf", () => {
    const root = makePane();
    expect(paneCount(root)).toBe(1);
    expect(panes(root).length).toBe(1);
  });

  it("walks a split left-to-right", () => {
    const a = makePane({ symbol: "AAA" });
    const b = makePane({ symbol: "BBB" });
    const root: LayoutNode = { kind: "split", dir: "row", ratio: 0.5, a, b };
    expect(panes(root).map((p) => p.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("finds a nested pane and misses a stranger", () => {
    const root = preset("quad");
    const target = panes(root)[2] as { id: string };
    expect(findPane(root, target.id)?.id).toBe(target.id);
    expect(findPane(root, "nope")).toBeNull();
  });
});

describe("updatePane", () => {
  it("changes only the addressed pane", () => {
    const root = preset("duo");
    const [first, second] = panes(root);
    const next = updatePane(root, (first as { id: string }).id, { symbol: "ETHUSDT" });
    expect(findPane(next, (first as { id: string }).id)?.symbol).toBe("ETHUSDT");
    expect(findPane(next, (second as { id: string }).id)?.symbol).toBe("BTCUSDT");
  });

  // Identity is not an optimisation detail here: the renderer keeps a live
  // ChartEngine per pane and reuses any subtree that came back ===. Rebuilding
  // everything would tear down and recreate every canvas on screen.
  it("preserves identity for untouched branches", () => {
    const root = preset("triple") as SplitNode;
    const firstId = (panes(root)[0] as { id: string }).id;
    const next = updatePane(root, firstId, { symbol: "SOLUSDT" }) as SplitNode;
    expect(next).not.toBe(root);
    expect(next.b).toBe(root.b);
  });

  it("returns the same tree when the id is unknown", () => {
    const root = preset("duo");
    expect(updatePane(root, "nope", { symbol: "X" })).toBe(root);
  });
});

describe("splitPane", () => {
  it("turns a leaf into a split of two", () => {
    const root = makePane();
    const next = splitPane(root, root.id, "row");
    expect(next.kind).toBe("split");
    expect(paneCount(next)).toBe(2);
  });

  // You split because you want another view OF WHAT YOU ARE LOOKING AT. An
  // empty pane on some default symbol means every split is followed by
  // retyping the thing that was already on screen.
  it("inherits symbol, timeframe and link from the pane being split", () => {
    const root = makePane({ symbol: "XAUUSD", timeframe: "4h", link: "cyan" });
    const next = splitPane(root, root.id, "col");
    const [a, b] = panes(next);
    expect(b).toMatchObject({ symbol: "XAUUSD", timeframe: "4h", link: "cyan" });
    expect(a?.id).not.toBe(b?.id);
  });

  it("accepts a seed that overrides inheritance", () => {
    const root = makePane({ symbol: "XAUUSD" });
    const next = splitPane(root, root.id, "row", { content: "agent", symbol: "ETHUSDT" });
    expect(panes(next)[1]).toMatchObject({ content: "agent", symbol: "ETHUSDT" });
  });

  it("splits a nested pane", () => {
    const root = preset("duo");
    const target = (panes(root)[1] as { id: string }).id;
    const next = splitPane(root, target, "col");
    expect(paneCount(next)).toBe(3);
  });

  it("ignores an unknown id", () => {
    const root = preset("duo");
    expect(splitPane(root, "nope", "row")).toBe(root);
  });
});

describe("closePane", () => {
  it("promotes the sibling", () => {
    const root = preset("duo");
    const [a, b] = panes(root);
    const next = closePane(root, (a as { id: string }).id);
    expect(next.kind).toBe("leaf");
    expect((next as { id: string }).id).toBe((b as { id: string }).id);
  });

  it("closes a deeply nested pane", () => {
    const root = preset("quad");
    const target = (panes(root)[3] as { id: string }).id;
    const next = closePane(root, target);
    expect(paneCount(next)).toBe(3);
    expect(findPane(next, target)).toBeNull();
  });

  // "The close button did nothing" is a far better failure than a blank
  // terminal with no pane to draw.
  it("refuses to close the last pane", () => {
    const root = makePane();
    expect(closePane(root, root.id)).toBe(root);
  });

  it("ignores an unknown id", () => {
    const root = preset("duo");
    expect(closePane(root, "nope")).toBe(root);
  });
});

describe("setRatio / flipSplit", () => {
  it("sets the root ratio", () => {
    const root = preset("duo");
    const next = setRatio(root, "", 0.7) as SplitNode;
    expect(next.ratio).toBeCloseTo(0.7);
  });

  it("clamps through the model, not the caller", () => {
    const next = setRatio(preset("duo"), "", 0.99) as SplitNode;
    expect(next.ratio).toBe(1 - MIN_RATIO);
  });

  it("sets a nested ratio by path", () => {
    const root = preset("triple") as SplitNode;
    const next = setRatio(root, "b", 0.3) as SplitNode;
    expect((next.b as SplitNode).ratio).toBeCloseTo(0.3);
    expect(next.a).toBe(root.a);
  });

  it("returns the same tree when the ratio is unchanged", () => {
    const root = preset("duo");
    expect(setRatio(root, "", 0.5)).toBe(root);
  });

  it("flips a split direction", () => {
    const root = preset("duo") as SplitNode;
    expect((flipSplit(root, "") as SplitNode).dir).toBe("col");
  });

  it("ignores a bad path", () => {
    const root = preset("duo");
    expect(setRatio(root, "z", 0.8)).toBe(root);
  });
});

describe("applyLink", () => {
  const build = (): LayoutNode => {
    const a = makePane({ symbol: "BTCUSDT", link: "amber" });
    const b = makePane({ symbol: "BTCUSDT", link: "amber" });
    const c = makePane({ symbol: "ETHUSDT", link: "cyan" });
    const d = makePane({ symbol: "SOLUSDT", link: "none" });
    return {
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { kind: "split", dir: "col", ratio: 0.5, a, b },
      b: { kind: "split", dir: "col", ratio: 0.5, a: c, b: d },
    };
  };

  it("moves every pane on the same channel", () => {
    const root = build();
    const src = (panes(root)[0] as { id: string }).id;
    const next = applyLink(root, src, { symbol: "XAUUSD" });
    const out = panes(next);
    expect(out[0]?.symbol).toBe("XAUUSD");
    expect(out[1]?.symbol).toBe("XAUUSD");
  });

  it("leaves other channels alone", () => {
    const root = build();
    const src = (panes(root)[0] as { id: string }).id;
    const out = panes(applyLink(root, src, { symbol: "XAUUSD" }));
    expect(out[2]?.symbol).toBe("ETHUSDT");
    expect(out[3]?.symbol).toBe("SOLUSDT");
  });

  // Unlinking a pane must not make it stop responding to its own controls.
  it("still updates an unlinked source pane", () => {
    const root = build();
    const src = (panes(root)[3] as { id: string }).id;
    const out = panes(applyLink(root, src, { symbol: "XAUUSD" }));
    expect(out[3]?.symbol).toBe("XAUUSD");
    expect(out[0]?.symbol).toBe("BTCUSDT");
  });

  it("does not drag other none-linked panes along with an unlinked source", () => {
    const a = makePane({ symbol: "AAA", link: "none" });
    const b = makePane({ symbol: "BBB", link: "none" });
    const root: LayoutNode = { kind: "split", dir: "row", ratio: 0.5, a, b };
    const out = panes(applyLink(root, a.id, { symbol: "ZZZ" }));
    expect(out[0]?.symbol).toBe("ZZZ");
    expect(out[1]?.symbol).toBe("BBB");
  });

  /**
   * This test previously asserted the opposite, and asserting it is what kept
   * the bug alive: the user's report was "in the workspace i cant change
   * timeframes seperately", and they were right. Panes are born on `amber` and
   * `splitPane` inherits the group, so on any fresh workspace EVERY pane is
   * linked — and a channel that carried the timeframe therefore moved all of
   * them at once. The one layout the feature exists for, four horizons on one
   * instrument, was the one layout it made impossible.
   */
  it("keeps the timeframe LOCAL to the source pane", () => {
    const root = build();
    const src = (panes(root)[0] as { id: string }).id;
    const out = panes(applyLink(root, src, { timeframe: "15m" }));
    expect(out[0]?.timeframe).toBe("15m");
    expect(out[1]?.timeframe).toBe("1h");
  });

  it("moves the symbol across the channel while each pane keeps its horizon", () => {
    /* The whole point: one instrument, several timeframes, following you when
       you switch instruments. */
    let root = build();
    const [p0, p1] = panes(root) as { id: string }[];
    root = applyLink(root, p0!.id, { timeframe: "15m" });
    root = applyLink(root, p1!.id, { timeframe: "4h" });
    const out = panes(applyLink(root, p0!.id, { symbol: "XAUUSD" }));
    expect(out[0]).toMatchObject({ symbol: "XAUUSD", timeframe: "15m" });
    expect(out[1]).toMatchObject({ symbol: "XAUUSD", timeframe: "4h" });
  });

  it("changes nothing on the channel when only the timeframe moves", () => {
    /* Identity, not just equality: the renderer keeps one live ChartEngine per
       pane and reuses any subtree that comes back `===`. A linked pane must not
       be rebuilt because a sibling was retimed. */
    const root = build();
    const [p0, , p2] = panes(root) as { id: string }[];
    const next = applyLink(root, p0!.id, { timeframe: "15m" });
    const before = panes(root).find((p) => p.id === p2!.id);
    const after = panes(next).find((p) => p.id === p2!.id);
    expect(after).toBe(before);
  });

  it("returns the same tree when nothing actually changes", () => {
    const root = build();
    const src = (panes(root)[0] as { id: string }).id;
    expect(applyLink(root, src, { symbol: "BTCUSDT" })).toBe(root);
  });

  it("ignores an unknown source", () => {
    const root = build();
    expect(applyLink(root, "nope", { symbol: "X" })).toBe(root);
  });
});

describe("preset", () => {
  it("produces the documented pane counts", () => {
    expect(paneCount(preset("single"))).toBe(1);
    expect(paneCount(preset("duo"))).toBe(2);
    expect(paneCount(preset("duo-stacked"))).toBe(2);
    expect(paneCount(preset("triple"))).toBe(3);
    expect(paneCount(preset("quad"))).toBe(4);
    expect(paneCount(preset("focus-trio"))).toBe(4);
  });

  it("gives every pane a unique id", () => {
    const ids = panes(preset("quad")).map((p) => p.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("seeds every pane from the caller", () => {
    const out = panes(preset("quad", { symbol: "EURUSD", timeframe: "5m" }));
    expect(out.every((p) => p.symbol === "EURUSD" && p.timeframe === "5m")).toBe(true);
  });
});

describe("geometry", () => {
  it("gives a single pane the whole box", () => {
    const g = geometry(makePane());
    expect(g.panes[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
    expect(g.splitters.length).toBe(0);
  });

  it("splits a row by the ratio", () => {
    const root = setRatio(preset("duo"), "", 0.3);
    const g = geometry(root);
    expect(g.panes[0]).toMatchObject({ x: 0, w: 0.3, h: 1 });
    expect(g.panes[1]).toMatchObject({ x: 0.3, h: 1 });
    expect(g.panes[1]?.w).toBeCloseTo(0.7);
  });

  it("splits a column by the ratio", () => {
    const g = geometry(preset("duo-stacked"));
    expect(g.panes[0]).toMatchObject({ y: 0, h: 0.5, w: 1 });
    expect(g.panes[1]).toMatchObject({ y: 0.5, h: 0.5, w: 1 });
  });

  it("tiles a quad without gaps or overlap", () => {
    const g = geometry(preset("quad"));
    expect(g.panes.length).toBe(4);
    const area = g.panes.reduce((sum, p) => sum + p.w * p.h, 0);
    expect(area).toBeCloseTo(1);
  });

  it("emits one splitter per split node, with its path", () => {
    const g = geometry(preset("triple"));
    expect(g.splitters.length).toBe(2);
    expect(g.splitters.map((s) => s.path).sort()).toEqual(["", "b"]);
  });

  it("places a row splitter on the seam", () => {
    const g = geometry(setRatio(preset("duo"), "", 0.4));
    expect(g.splitters[0]).toMatchObject({ dir: "row", y: 0, h: 1 });
    expect(g.splitters[0]?.x).toBeCloseTo(0.4);
  });
});

describe("sanitizeLayout", () => {
  it("accepts a well-formed leaf", () => {
    const out = sanitizeLayout({
      kind: "leaf",
      id: "x",
      content: "chart",
      symbol: "BTCUSDT",
      timeframe: "1h",
      link: "amber",
    });
    expect(out).toMatchObject({ kind: "leaf", id: "x", symbol: "BTCUSDT" });
  });

  // A saved workspace is untrusted input: an older build, a hand-edited vault,
  // a sync from a machine that knows a pane content this one does not. Losing
  // one pane's content type beats losing the whole desk.
  it("replaces an unknown content with chart rather than rejecting the pane", () => {
    const out = sanitizeLayout({ kind: "leaf", id: "x", content: "hologram" });
    expect(out).toMatchObject({ kind: "leaf", content: "chart" });
  });

  it("replaces an unknown link group", () => {
    expect(sanitizeLayout({ kind: "leaf", link: "chartreuse" })).toMatchObject({ link: "amber" });
  });

  it("fills in missing fields", () => {
    const out = sanitizeLayout({ kind: "leaf" }) as { symbol: string; timeframe: string; id: string };
    expect(out.symbol).toBe("BTCUSDT");
    expect(out.timeframe).toBe("1h");
    expect(out.id.length).toBeGreaterThan(0);
  });

  it("clamps a ratio out of a file", () => {
    const out = sanitizeLayout({
      kind: "split",
      dir: "row",
      ratio: 5,
      a: { kind: "leaf" },
      b: { kind: "leaf" },
    }) as SplitNode;
    expect(out.ratio).toBe(1 - MIN_RATIO);
  });

  // A split with a dead child is not a split. Promoting the survivor keeps the
  // rest of the layout instead of discarding the whole branch.
  it("promotes the surviving child of a half-broken split", () => {
    const out = sanitizeLayout({
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { kind: "leaf", symbol: "AAA" },
      b: "garbage",
    });
    expect(out).toMatchObject({ kind: "leaf", symbol: "AAA" });
  });

  it("rejects a split with two dead children", () => {
    expect(sanitizeLayout({ kind: "split", a: 1, b: 2 })).toBeNull();
  });

  it("rejects non-objects and unknown kinds", () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout("leaf")).toBeNull();
    expect(sanitizeLayout({ kind: "window" })).toBeNull();
  });

  // A hand-edited file can nest forever; the recursion must not.
  it("stops at the depth limit instead of overflowing the stack", () => {
    let deep: unknown = { kind: "leaf" };
    for (let i = 0; i < 40; i++) deep = { kind: "split", dir: "row", ratio: 0.5, a: deep, b: { kind: "leaf" } };
    expect(() => sanitizeLayout(deep)).not.toThrow();
  });
});

describe("sanitizeWorkspace", () => {
  it("accepts a well-formed workspace", () => {
    const root = preset("duo");
    const id = (panes(root)[1] as { id: string }).id;
    const ws = sanitizeWorkspace({ id: "w1", name: "Desk", root, activePaneId: id });
    expect(ws).toMatchObject({ id: "w1", name: "Desk", activePaneId: id });
  });

  // An active id naming no pane would leave the topbar driving nothing.
  it("falls back to the first pane when the active id is stale", () => {
    const root = preset("duo");
    const ws = sanitizeWorkspace({ root, activePaneId: "ghost" });
    expect(ws?.activePaneId).toBe((panes(root)[0] as { id: string }).id);
  });

  it("supplies a name and id when they are missing", () => {
    const ws = sanitizeWorkspace({ root: preset("single") });
    expect(ws?.name).toBe("Workspace");
    expect(ws?.id.length).toBeGreaterThan(0);
  });

  it("rejects a workspace with no usable root", () => {
    expect(sanitizeWorkspace({ root: "nope" })).toBeNull();
    expect(sanitizeWorkspace(null)).toBeNull();
  });
});
