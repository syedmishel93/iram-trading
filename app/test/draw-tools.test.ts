import { describe, it, expect, beforeEach } from "vitest";
import {
  createDrawing,
  hitTest,
  toShapes,
  resetDrawingIds,
  ANCHOR_COUNT,
  DRAW_KINDS,
  FIB_EXT_LEVELS,
  type Projector,
  type Shape,
} from "../src/draw/model";

beforeEach(() => resetDrawingIds());

const opts = { symbol: "BTCUSDT", timeframe: "1h", now: 1000 };
const H = 3_600_000;
const TIMES = Array.from({ length: 20 }, (_, i) => i * H);

/** Identity-ish projector: one hour is ten pixels, one price unit is one. */
const proj: Projector = { x: (t) => (t / H) * 10, y: (p) => 200 - p };
const bounds = { width: 400, height: 300 };

const lines = (s: readonly Shape[]) => s.filter((x) => x.type === "line");
const levels = (s: readonly Shape[]) => s.filter((x) => x.type === "level");
const boxes = (s: readonly Shape[]) => s.filter((x) => x.type === "box");

describe("the tool set", () => {
  it("declares an anchor count for every kind it advertises", () => {
    for (const k of DRAW_KINDS) {
      expect(ANCHOR_COUNT[k.id], `${k.id} has no anchor count`).toBeGreaterThan(0);
    }
  });

  it("gives every advertised kind a hint that says what it does", () => {
    for (const k of DRAW_KINDS) expect(k.hint.length).toBeGreaterThan(10);
  });

  it("lists every kind that has an anchor count", () => {
    const listed = new Set(DRAW_KINDS.map((k) => k.id));
    for (const id of Object.keys(ANCHOR_COUNT)) {
      expect(listed.has(id as never), `${id} is buildable but not offered`).toBe(true);
    }
  });
});

describe("parallel channel", () => {
  const mk = () =>
    createDrawing(
      "channel",
      [
        { t: 0, p: 100 },
        { t: 4 * H, p: 120 },
        { t: 0, p: 70 },
      ],
      opts,
    );

  it("takes three anchors", () => {
    expect(ANCHOR_COUNT.channel).toBe(3);
  });

  it("draws two lines with identical slope", () => {
    const ls = lines(toShapes(mk(), TIMES)) as Array<{ x0: number; y0: number; x1: number; y1: number }>;
    expect(ls).toHaveLength(2);
    const slope = (l: { x0: number; y0: number; x1: number; y1: number }) => (l.y1 - l.y0) / (l.x1 - l.x0);
    expect(slope(ls[0] as never)).toBeCloseTo(slope(ls[1] as never), 12);
  });

  /* The property the comment in the module is about: the rail is offset in
     PRICE, so it keeps its distance when the vertical scale changes. */
  it("offsets the second rail in price, not in pixels", () => {
    const ls = lines(toShapes(mk(), TIMES)) as Array<{ y0: number }>;
    expect(Math.abs((ls[0]?.y0 as number) - (ls[1]?.y0 as number))).toBeCloseTo(30, 9);
  });

  it("is grabbable by its lower rail, not only the line that defined it", () => {
    const d = mk();
    /* On the lower rail at t = 2h, clear of every anchor: the rail starts at
       70 and rises 5 an hour, so price 80 → x = 20, y = 120. */
    expect(hitTest(d, 20, 120, proj, bounds)).toEqual({ kind: "body" });
  });

  it("ignores a press in the empty middle of the channel", () => {
    /* At t = 2h the rails sit at 110 and 80. Halfway between is 95 → y = 105,
       fifteen pixels from either line and well outside the tolerance. */
    expect(hitTest(mk(), 20, 105, proj, bounds)).toBeNull();
  });

  it("renders nothing at all when the third anchor is missing", () => {
    const half = { ...mk(), anchors: mk().anchors.slice(0, 2) };
    expect(toShapes(half, TIMES)).toEqual([]);
  });
});

describe("pitchfork", () => {
  const mk = () =>
    createDrawing(
      "pitchfork",
      [
        { t: 0, p: 100 }, /* pivot */
        { t: 2 * H, p: 120 }, /* swing high */
        { t: 4 * H, p: 110 }, /* swing low */
      ],
      opts,
    );

  it("draws a median line plus two tines", () => {
    expect(lines(toShapes(mk(), TIMES))).toHaveLength(3);
  });

  it("aims the median at the midpoint of the two swings", () => {
    const [median] = lines(toShapes(mk(), TIMES)) as Array<{ x1: number; y1: number }>;
    /* Midpoint of (2h, 120) and (4h, 110) is (3h, 115) → bar index 3. */
    expect(median?.x1).toBeCloseTo(3, 9);
    expect(median?.y1).toBeCloseTo(115, 9);
  });

  it("extends every line, because the tool is about where price meets them later", () => {
    for (const l of lines(toShapes(mk(), TIMES))) {
      expect((l as { extend?: boolean }).extend).toBe(true);
    }
  });

  it("is grabbed by the median line only", () => {
    const d = mk();
    /* Median runs from (0,100) to (3h,115): the midpoint is (1.5h, 107.5),
       which projects to x = 15, y = 92.5. */
    expect(hitTest(d, 15, 92.5, proj, bounds)).toEqual({ kind: "body" });
  });

  it("does not intercept presses on the tines it spreads across the chart", () => {
    const d = mk();
    /* On the upper tine well away from the median: t = 3h on the tine through
       (2h, 120) with the median slope of 5 per hour → price 125, y = 75. */
    const onTine = hitTest(d, 30, 75, proj, bounds);
    expect(onTine === null || onTine.kind === "anchor").toBe(true);
  });
});

describe("fibonacci extension", () => {
  const up = () =>
    createDrawing(
      "fibext",
      [
        { t: 0, p: 100 },
        { t: 2 * H, p: 120 },
        { t: 4 * H, p: 110 },
      ],
      opts,
    );

  it("projects the leg forward from the third anchor", () => {
    const ls = levels(toShapes(up(), TIMES)) as Array<{ y: number }>;
    expect(ls).toHaveLength(FIB_EXT_LEVELS.length);
    /* Leg is +20 from C at 110, so 100% sits at 130 and 161.8% at 142.36. */
    expect(ls.map((l) => l.y)).toContain(130);
    expect(ls.some((l) => Math.abs(l.y - 142.36) < 1e-9)).toBe(true);
  });

  /* The bug this was written against: taking the absolute leg size and always
     projecting upward puts targets ABOVE price in a falling market. */
  it("projects DOWNWARD when the leg was down", () => {
    const down = createDrawing(
      "fibext",
      [
        { t: 0, p: 120 },
        { t: 2 * H, p: 100 },
        { t: 4 * H, p: 110 },
      ],
      opts,
    );
    const ls = levels(toShapes(down, TIMES)) as Array<{ y: number }>;
    expect(ls.map((l) => l.y)).toContain(90); /* 100% of a −20 leg from 110 */
    expect(ls.every((l) => l.y <= 110)).toBe(true);
  });

  it("keeps the two legs visible as dashed guides", () => {
    const ls = lines(toShapes(up(), TIMES));
    expect(ls).toHaveLength(2);
    expect(ls.every((l) => (l as { dashed?: boolean }).dashed === true)).toBe(true);
  });

  it("draws the 100% level solid and the projections dashed", () => {
    const ls = levels(toShapes(up(), TIMES)) as Array<{ y: number; dashed?: boolean }>;
    const hundred = ls.find((l) => l.y === 130);
    expect(hundred?.dashed).toBe(false);
    expect(ls.filter((l) => l.dashed === true).length).toBe(FIB_EXT_LEVELS.length - 1);
  });

  it("starts the levels at the third anchor, not at the first", () => {
    const ls = levels(toShapes(up(), TIMES)) as Array<{ x0: number }>;
    expect(ls.every((l) => l.x0 === 4)).toBe(true);
  });
});

describe("position tool", () => {
  const long = () =>
    createDrawing(
      "position",
      [
        { t: 0, p: 100 }, /* entry */
        { t: 3 * H, p: 95 }, /* stop */
        { t: 3 * H, p: 115 }, /* target */
      ],
      opts,
    );

  it("draws a risk box and a reward box", () => {
    const bs = boxes(toShapes(long(), TIMES)) as Array<{ tone: string; y0: number; y1: number }>;
    expect(bs).toHaveLength(2);
    const risk = bs.find((b) => b.tone === "bear");
    const reward = bs.find((b) => b.tone === "bull");
    expect(risk).toMatchObject({ y0: 95, y1: 100 });
    expect(reward).toMatchObject({ y0: 100, y1: 115 });
  });

  it("labels the reward box with the ratio, in R", () => {
    const bs = boxes(toShapes(long(), TIMES)) as Array<{ tone: string; label?: string }>;
    /* 15 of reward against 5 of risk. */
    expect(bs.find((b) => b.tone === "bull")?.label).toContain("3.00R");
  });

  it("works for a short, where the stop is above the entry", () => {
    const short = createDrawing(
      "position",
      [
        { t: 0, p: 100 },
        { t: 3 * H, p: 104 },
        { t: 3 * H, p: 92 },
      ],
      opts,
    );
    const bs = boxes(toShapes(short, TIMES)) as Array<{ tone: string; y0: number; y1: number; label?: string }>;
    expect(bs.find((b) => b.tone === "bear")).toMatchObject({ y0: 100, y1: 104 });
    expect(bs.find((b) => b.tone === "bull")).toMatchObject({ y0: 92, y1: 100 });
    expect(bs.find((b) => b.tone === "bull")?.label).toContain("2.00R");
  });

  it("does not print a ratio when the stop is at the entry", () => {
    const zero = createDrawing(
      "position",
      [
        { t: 0, p: 100 },
        { t: 3 * H, p: 100 },
        { t: 3 * H, p: 110 },
      ],
      opts,
    );
    const bs = boxes(toShapes(zero, TIMES)) as Array<{ tone: string; label?: string }>;
    expect(bs.find((b) => b.tone === "bull")?.label).toBe("Reward");
  });

  it("marks the entry with its own level", () => {
    const ls = levels(toShapes(long(), TIMES)) as Array<{ y: number; label?: string }>;
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ y: 100, label: "Entry" });
  });

  it("is grabbable anywhere inside the block", () => {
    /* Middle of the reward box: t = 1.5h → x = 15, price 108 → y = 92. */
    expect(hitTest(long(), 15, 92, proj, bounds)).toEqual({ kind: "body" });
  });

  it("does not claim presses outside it", () => {
    expect(hitTest(long(), 200, 20, proj, bounds)).toBeNull();
  });
});

describe("arrow", () => {
  const mk = () => createDrawing("arrow", [{ t: 0, p: 100 }, { t: 3 * H, p: 120 }], opts);

  it("is a line with a head at the second anchor", () => {
    const s = toShapes(mk(), TIMES);
    expect(lines(s)).toHaveLength(1);
    const marks = s.filter((x) => x.type === "marker") as Array<{ x: number; y: number }>;
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ x: 3, y: 120 });
  });

  it("uses the note text as the head when one is given", () => {
    const d = { ...mk(), text: "entry" };
    const marks = toShapes(d, TIMES).filter((x) => x.type === "marker") as Array<{ text: string }>;
    expect(marks[0]?.text).toBe("entry");
  });

  it("hit-tests along its shaft like a trend line", () => {
    /* Midpoint (1.5h, 110) → x = 15, y = 90. */
    expect(hitTest(mk(), 15, 90, proj, bounds)).toEqual({ kind: "body" });
  });
});

describe("every kind the model can make is one the operator can reach", () => {
  /* MEASURED in v63.21 while looking for gaps in the drawing tools: the union
     has 13 members and `DRAW_KINDS` offers all 13, each with a label and a
     hint. The tools did not need work — the third time this codebase has
     overturned a plan by being opened and measured, after the Watchlist and
     the Calculator.

     What is worth guarding is that it STAYS true. A kind added to `DrawKind`
     and not to `DRAW_KINDS` compiles, renders when constructed, and can never
     be chosen — the "capability nobody can see" shape, in the one place a new
     drawing tool would arrive. */
  it("DRAW_KINDS offers one entry per DrawKind, with a label and a hint", () => {
    const ids = DRAW_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);      // no duplicates
    expect(ids.length).toBeGreaterThanOrEqual(13);   // fails on a silent removal
    for (const k of DRAW_KINDS) {
      expect(k.label.length).toBeGreaterThan(2);
      expect(k.hint.length).toBeGreaterThan(10);     // a hint that says nothing is not one
    }
  });

  it("each offered kind can actually be constructed", () => {
    // An id in the list that `createDrawing` refuses is a button that does
    // nothing — worse than an absent button, because it looks like a feature.
    for (const k of DRAW_KINDS) {
      const n = ANCHOR_COUNT[k.id];
      const anchors = Array.from({ length: n }, (_, i) => ({ t: i * H, p: 100 + i * 5 }));
      const d = createDrawing(k.id, anchors, opts);
      expect(d.kind).toBe(k.id);
      expect(d.anchors).toHaveLength(n);
    }
  });
});
