/**
 * PAINTING THE GRAPH — and the encoding decisions, which are pure and tested.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE ENCODING IS A FUNCTION AND NOT A RUN OF CANVAS CALLS
 *
 * The picture IS the claim. A thick line reads as a strong relationship, a solid
 * line as a settled one, a red line as a warning — and not one of those can be
 * checked by looking at the result. So `edgeStyle` and `nodeStyle` are pure,
 * live beside their tests, and the painter below only does what they say.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY COLOUR COMES FROM A TOKEN
 *
 * This terminal ships seven themes. CLAUDE.md records what a hardcoded colour
 * costs: "a hardcoded shadow is right in exactly one". So the palette is READ
 * off the host element's computed style at paint time, which means a theme
 * change needs no notification to reach this — the next paint already has it.
 *
 * And the sign of a correlation is a STANDING, not a number, so it takes
 * `--verdict-fav` / `--verdict-unfav` rather than a green and a red chosen here.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO CHANNELS, TWO FACTS, NEVER CROSSED
 *
 * WIDTH is magnitude. COLOUR is direction. DASH and ALPHA are confidence. An
 * inverse pair is not a weak pair — gold against the dollar is one of the most
 * reliable relationships on the board — so -0.9 is drawn exactly as thick as
 * +0.9 and only its colour differs. A strong pair whose correlation reversed
 * halfway through stays thick and goes dashed, because it is still strong and no
 * longer settled, and folding those into one channel would lose whichever fact
 * the reader needed.
 */

import type { PlacedNode } from "./layout";
import { DEFAULT_CAMERA, toScreen, type Camera } from "./camera";

/**
 * The least an edge must say to be drawn honestly.
 *
 * DELIBERATELY NOT `CorrelationEdge`. Three different graphs share this painter
 * — markets joined by correlation, jobs joined by a shared fault, rules joined
 * to the states they were tried in — and none of them should have to pretend to
 * be a correlation to be drawn. What every one of them DOES have is a signed
 * magnitude and a statement about whether the figure held.
 *
 * `stable` absent means "not a question that applies here", which is different
 * from false: a shared deadlock is not an unstable correlation, and dashing it
 * would say something untrue about it.
 */
export interface EdgeLook {
  readonly value: number;
  readonly stable?: boolean;
}

export interface Palette {
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly border: string;
  readonly surface: string;
  /** A relationship in the same direction. */
  readonly pos: string;
  /** A relationship in the opposite direction. NOT a warning colour. */
  readonly neg: string;
  readonly neutral: string;
  readonly accent: string;
  readonly font: string;
}

/**
 * A palette for the tests only.
 *
 * Named so no call site can mistake it for a default — a renderer that silently
 * falls back to fixed colours is one that looks right in one theme and wrong in
 * six, with nothing on screen to say which.
 */
export const TEST_PALETTE: Palette = {
  text: "#e8eaf0",
  muted: "#98a0b3",
  faint: "#566072",
  border: "#2a3040",
  surface: "#141821",
  pos: "#3fb27f",
  neg: "#d1605e",
  neutral: "#7a8296",
  accent: "#c9a227",
  font: "system-ui",
};

/** Read the live theme off the host, so a theme change needs no notification. */
export function readPalette(host: Element): Palette {
  const s = getComputedStyle(host);
  const v = (name: string, fallback: string): string => {
    const got = s.getPropertyValue(name).trim();
    return got === "" ? fallback : got;
  };
  return {
    text: v("--text", TEST_PALETTE.text),
    muted: v("--text-muted", TEST_PALETTE.muted),
    faint: v("--text-faint", TEST_PALETTE.faint),
    border: v("--border", TEST_PALETTE.border),
    surface: v("--surface", TEST_PALETTE.surface),
    /* THE SIGN IS A STANDING. `--verdict-fav` and `--verdict-unfav` are the
       tokens this terminal already uses for "the same way" and "the other way",
       and they are defined per theme. */
    pos: v("--verdict-fav", TEST_PALETTE.pos),
    neg: v("--verdict-unfav", TEST_PALETTE.neg),
    neutral: v("--verdict-neut", TEST_PALETTE.neutral),
    accent: v("--accent", TEST_PALETTE.accent),
    font: v("--font-ui", TEST_PALETTE.font),
  };
}

export interface EdgeStyle {
  readonly stroke: string;
  readonly width: number;
  /** Empty for a settled relationship; a dash pattern for one that moved. */
  readonly dash: readonly number[];
  readonly alpha: number;
}

const MIN_W = 1;
const MAX_W = 5;

/** A magnitude that is always usable, whatever arrived. */
const mag = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.abs(v)) : 0);

/**
 * How to draw one relationship.
 *
 * `hot` only ever brightens. It must not restyle the sign or the dash, or the
 * picture would say something different under the pointer than beside it.
 */
export function edgeStyle(e: EdgeLook, p: Palette, hot = false): EdgeStyle {
  const m = mag(e.value);
  /* WIDTH IS MAGNITUDE ONLY. Not confidence — see this file's header. A strong
     pair that reversed is still a strong pair. */
  const width = MIN_W + (MAX_W - MIN_W) * m;
  const stroke = e.value < 0 ? p.neg : e.value > 0 ? p.pos : p.neutral;
  /* DASH AND ALPHA ARE CONFIDENCE. A dashed, dimmer line is the visual form of
     "this held for part of the window and not the rest".

     ABSENT COUNTS AS SETTLED, and that is the right default for a graph where
     stability is not a question — a shared deadlock is not an unstable
     correlation, and dashing it would say something untrue. Only an explicit
     `false` dashes. */
  const settled = e.stable !== false;
  const base = settled ? 0.72 : 0.42;
  return {
    stroke,
    width,
    dash: settled ? [] : [5, 4],
    alpha: Math.min(1, hot ? base + 0.28 : base),
  };
}

export interface NodeStyle {
  readonly fill: string;
  readonly stroke: string;
  readonly alpha: number;
  readonly label: string;
}

/**
 * How to draw one market.
 *
 * NO PER-NODE HUE. Size already says how connected it is, and reaching for a
 * second colour to make something look important is how a palette stops meaning
 * anything. A market nothing connects to is DIMMED rather than hidden: present
 * in the data and absent from the picture is the worst available pair.
 */
export function nodeStyle(weight: number, p: Palette): NodeStyle {
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
  return {
    fill: p.surface,
    stroke: p.text,
    alpha: 0.45 + 0.55 * w,
    label: p.text,
  };
}

/** Anything smaller than this is still reachable by a pointer or a thumb. */
const TOUCH = 9;

/**
 * Which node is under a point.
 *
 * WALKS BACKWARDS, because drawing order is last-on-top. Testing forwards
 * returns whichever node is visually UNDERNEATH, so the tooltip names something
 * the operator cannot see — a readout about the wrong market, with nothing to
 * suggest it.
 */
export function hitTest(
  placed: readonly PlacedNode[],
  x: number,
  y: number,
): string | null {
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const n = placed[i] as PlacedNode;
    const reach = Math.max(n.r, TOUCH);
    if ((x - n.x) ** 2 + (y - n.y) ** 2 <= reach * reach) return n.id;
  }
  return null;
}

/**
 * WHICH LABELS TO DRAW WHEN THEY WOULD COLLIDE.
 *
 * THE SAME RULE THE CHART AXIS ALREADY USES, for the same reason: a label that
 * no longer fits is SKIPPED rather than painted over its neighbour. Measured on
 * the real desk, the crypto cluster put five names in the same fifty pixels and
 * none of the five was readable — five markets present in the data and not one
 * of them named.
 *
 * BIGGEST FIRST, because a node's size is how connected it is, so if one of two
 * names has to go the picture keeps the one it is already saying matters more.
 * The hovered node is ALWAYS named: the pointer is a question about one market,
 * and hiding that market's name because a neighbour got there first is the one
 * moment this must not skip.
 *
 * `measure` is injected so the arithmetic can be tested without a canvas.
 */
export function placeLabels(
  placed: readonly PlacedNode[],
  labels: Readonly<Record<string, string>>,
  measure: (text: string) => number,
  hover: string | null,
): Set<string> {
  const keep = new Set<string>();
  const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const LINE = 13;

  const boxFor = (n: PlacedNode) => {
    const w = Math.max(8, measure(labels[n.id] ?? n.id));
    const top = n.y + n.r + 3;
    return { x0: n.x - w / 2, y0: top, x1: n.x + w / 2, y1: top + LINE };
  };
  const clashes = (b: { x0: number; y0: number; x1: number; y1: number }): boolean =>
    taken.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);

  /* Sorted by radius then id: deterministic, like the layout it labels. Two
     drawings of one unchanged archive must name the same markets. */
  const order = [...placed].sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : 1));

  if (hover !== null) {
    const h = placed.find((n) => n.id === hover);
    if (h !== undefined) {
      keep.add(h.id);
      taken.push(boxFor(h));
    }
  }
  for (const n of order) {
    if (keep.has(n.id)) continue;
    const b = boxFor(n);
    if (clashes(b)) continue;
    keep.add(n.id);
    taken.push(b);
  }
  return keep;
}

export interface DrawSpec {
  readonly placed: readonly PlacedNode[];
  readonly edges: readonly (EdgeLook & { readonly from: string; readonly to: string })[];
  readonly labels: Readonly<Record<string, string>>;
  readonly weights: Readonly<Record<string, number>>;
  /** The node under the pointer, if any. Its edges are brought forward. */
  readonly hover: string | null;
}

/**
 * Paint one frame.
 *
 * EDGES FIRST, THEN NODES, THEN LABELS — so a line never crosses the disc it
 * ends at and a label is never buried under an edge. When something is hovered,
 * everything not touching it is dimmed rather than removed: a picture that
 * loses half its content on hover cannot be compared with the one beside it.
 */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  spec: DrawSpec,
  p: Palette,
  box: { w: number; h: number },
  cam: Camera = DEFAULT_CAMERA,
): void {
  /* THE CAMERA IS APPLIED PER POINT, NOT AS A CANVAS TRANSFORM, and that is the
     whole reason this is readable when zoomed. `ctx.scale` would multiply the
     line widths, the node radii and the FONT along with the positions, so at 4x
     the labels become billboards and at 0.5x they vanish. Transforming the
     coordinates and leaving every stroke and glyph in screen space keeps a
     zoomed graph looking like a map instead of a photograph of one. */
  const S = (n: { x: number; y: number }) => toScreen(cam, n.x, n.y);
  const at = new Map(spec.placed.map((n) => [n.id, n]));
  ctx.clearRect(0, 0, box.w, box.h);

  const touching = (e: { from: string; to: string }): boolean =>
    spec.hover === null || e.from === spec.hover || e.to === spec.hover;

  for (const e of spec.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    /* A MISSING ENDPOINT IS NOT DRAWN TO THE ORIGIN. `validateGraph` should have
       caught it long before here; if one ever slips through, a line to nowhere
       is worse than no line, because it looks like information. */
    if (a === undefined || b === undefined) continue;
    const s = edgeStyle(e, p, spec.hover !== null && touching(e));
    ctx.save();
    ctx.globalAlpha = touching(e) ? s.alpha : s.alpha * 0.22;
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.width;
    ctx.setLineDash([...s.dash]);
    ctx.lineCap = "round";
    const pa = S(a);
    const pb = S(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.restore();
  }

  for (const n of spec.placed) {
    const s = nodeStyle(spec.weights[n.id] ?? 0, p);
    const near = spec.hover === null || spec.hover === n.id ||
      spec.edges.some((e) => (e.from === n.id || e.to === n.id) && touching(e));
    ctx.save();
    ctx.globalAlpha = near ? s.alpha : s.alpha * 0.3;
    const pn = S(n);
    ctx.beginPath();
    /* The RADIUS scales with the zoom but is floored, so a node never becomes a
       dot you cannot aim at. */
    ctx.arc(pn.x, pn.y, Math.max(2.5, n.r * Math.min(1.8, cam.zoom)), 0, Math.PI * 2);
    ctx.fillStyle = s.fill;
    ctx.fill();
    ctx.lineWidth = spec.hover === n.id ? 2 : 1.25;
    ctx.strokeStyle = spec.hover === n.id ? p.accent : s.stroke;
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.font = `600 11px ${p.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  /* MEASURED WITH THE FONT ALREADY SET, or every width is computed against the
     wrong face and the collision test is about a label nobody will see. */
  /* LABELS COLLIDE IN SCREEN SPACE, so the set that fits changes with the zoom
     — which is the point: zooming in is how you read the names the dense cluster
     could not show. */
  const onScreen = spec.placed.map((n) => {
    const s2 = S(n);
    return { id: n.id, x: s2.x, y: s2.y, r: Math.max(2.5, n.r * Math.min(1.8, cam.zoom)) };
  });
  const show = placeLabels(onScreen, spec.labels, (t) => ctx.measureText(t).width, spec.hover);
  for (const n of onScreen) {
    if (!show.has(n.id)) continue;
    const near = spec.hover === null || spec.hover === n.id ||
      spec.edges.some((e) => (e.from === n.id || e.to === n.id) && touching(e));
    ctx.globalAlpha = near ? 1 : 0.3;
    ctx.fillStyle = spec.hover === n.id ? p.text : p.muted;
    ctx.fillText(spec.labels[n.id] ?? n.id, n.x, n.y + n.r + 3);
  }
  ctx.restore();
}
