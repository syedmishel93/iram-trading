/**
 * WHERE THE NODES GO. Pure arithmetic, because a network picture cannot be
 * checked by eye.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A LOOP INSIDE A CARD
 *
 * `ui/cards/plot.ts` records the reason the equity curves became pure functions:
 * a wrong SCALE looks exactly like the truth, because the shape is plausible and
 * nothing is red. A graph is worse, because everything about it reads as a
 * claim. Two nodes drawn close together read as related whether or not an edge
 * says so. A large node reads as important. An edge drawn at all reads as a
 * fact. None of that is checkable by looking, so the arithmetic lives here with
 * its traps pinned by tests, and the card only paints what it is given.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DETERMINISM IS THE LOAD-BEARING PROPERTY
 *
 * A force layout seeded from `Math.random` settles somewhere new on every draw.
 * The operator then cannot compare this morning's picture with last night's,
 * cannot tell a market that moved from a layout that wandered, and correctly
 * stops reading the thing. So the start positions come from a hash of each
 * node's OWN ID: the same graph is the same picture, forever, on any machine,
 * and adding one market moves only what it should.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SIGN IS A COLOUR, NEVER A DISTANCE
 *
 * A correlation of -0.9 is as strong a relationship as +0.9. Gold against the
 * dollar is one of the most reliable inverse pairs there is, and a layout that
 * read -0.9 as "weak" would push exactly those pairs to the edge of the picture.
 * Distance uses the MAGNITUDE; the sign belongs to the palette.
 */

/** A thing to draw. `group` puts it on a ring; null leaves it in the core. */
export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly group: string | null;
  /** Relative importance, 0..1. Drives the radius; out-of-range is clamped. */
  readonly weight: number;
}

/** A relation between two nodes. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /**
   * The relation. Signed (-1..1) for something like a correlation, unsigned
   * (0..1) otherwise. Only the MAGNITUDE reaches the layout.
   */
  readonly value: number;
  /** How much to trust it, 0..1. A caller drops the untrustworthy before here. */
  readonly confidence: number;
}

export interface Box {
  readonly w: number;
  readonly h: number;
}

export interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Drawn radius in px. Never zero: absent from the picture and present in the data is the worst pair. */
  readonly r: number;
}

export interface Layout {
  readonly nodes: readonly PlacedNode[];
  /** The box these positions are for. A caller redrawing at another size must re-run. */
  readonly box: Box;
}

/** Below this, there is no room to place anything without dividing by nothing. */
export const BOX_FLOOR = 80;

const MIN_R = 3;
const MAX_R = 16;

export interface GraphCheck {
  readonly ok: boolean;
  /** Empty when ok. Addressed to the operator, naming what is wrong. */
  readonly why: string;
}

/**
 * Is this graph drawable at all?
 *
 * REFUSES RATHER THAN REPAIRING. An edge naming a node that does not exist has
 * no second endpoint, and drawing it to the origin puts a line on screen that
 * describes nothing — the same class as an explorer URL guessed from a pattern,
 * which sends the reader somewhere real-looking and wrong.
 */
export function validateGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  box: Box = { w: BOX_FLOOR, h: BOX_FLOOR },
): GraphCheck {
  if (!(box.w >= BOX_FLOOR && box.h >= BOX_FLOOR)) {
    return {
      ok: false,
      why: `there is not enough room to draw this — ${Math.round(box.w)}x${Math.round(box.h)} is below the ${BOX_FLOOR}px each side a layout needs`,
    };
  }
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) {
      return { ok: false, why: `${n.id} appears twice, so one would be drawn on top of the other` };
    }
    seen.add(n.id);
  }
  for (const e of edges) {
    if (e.from === e.to) {
      return { ok: false, why: `${e.from} has a link to itself, which has no length to draw` };
    }
    const missing = !seen.has(e.from) ? e.from : !seen.has(e.to) ? e.to : null;
    if (missing !== null) {
      return { ok: false, why: `a link names ${missing}, which is not one of the things being drawn` };
    }
  }
  /* NO EDGES IS NOT A FAILURE. "Nothing related above the floor" is a finding,
     and a picture of unconnected markets says it exactly. */
  return { ok: true, why: "" };
}

/** A weight that is always a usable number, whatever the caller supplied. */
const safeWeight = (w: number): number =>
  Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;

/** Radius from weight. Never zero — see `PlacedNode.r`. */
const radiusOf = (w: number): number => MIN_R + (MAX_R - MIN_R) * safeWeight(w);

/**
 * A stable number in [0,1) from a string.
 *
 * The seed for every start position. It is a hash of the node's OWN id rather
 * than an index, so inserting a market at the front of the list does not
 * reshuffle the whole picture — only the new one appears.
 */
function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Keep a node fully inside the box, its own radius included. */
const clampIn = (v: number, r: number, size: number): number =>
  Math.min(size - r, Math.max(r, v));

/**
 * Groups on a ring, members as satellites around their group's anchor.
 *
 * The layout the eye reads fastest when the CATEGORIES are the point — which
 * market kinds move together — because the ring positions are fixed and
 * comparable between drawings in a way a relaxed force layout is not.
 */
export function radialLayout(nodes: readonly GraphNode[], box: Box): Layout {
  if (nodes.length === 0) return { nodes: [], box };

  const groups = [...new Set(nodes.map((n) => n.group ?? ""))].sort();
  const cx = box.w / 2;
  const cy = box.h / 2;
  /* The ring sits inside the smaller half-dimension, with room left for the
     largest node and its label. */
  const ring = Math.max(1, Math.min(box.w, box.h) / 2 - MAX_R * 2.5);

  const out: PlacedNode[] = [];
  for (const g of groups) {
    const members = nodes.filter((n) => (n.group ?? "") === g);
    const gi = groups.indexOf(g);
    /* `groups.length || 1` is not needed — an empty `nodes` returned above — but
       a single group must not divide the circle into one and land at angle 0
       with every member stacked, so a lone group takes the centre. */
    const anchorAngle = (gi / groups.length) * Math.PI * 2 - Math.PI / 2;
    const ax = groups.length === 1 ? cx : cx + Math.cos(anchorAngle) * ring * 0.55;
    const ay = groups.length === 1 ? cy : cy + Math.sin(anchorAngle) * ring * 0.55;

    const spread = Math.max(MAX_R * 1.6, ring * 0.3);
    members.forEach((m, i) => {
      const r = radiusOf(m.weight);
      if (members.length === 1) {
        out.push({ id: m.id, x: clampIn(ax, r, box.w), y: clampIn(ay, r, box.h), r });
        return;
      }
      const a = (i / members.length) * Math.PI * 2 + hash01(m.id, 7) * 0.6;
      out.push({
        id: m.id,
        x: clampIn(ax + Math.cos(a) * spread, r, box.w),
        y: clampIn(ay + Math.sin(a) * spread, r, box.h),
        r,
      });
    });
  }
  /* FITTED, like the force layout. The ring is placed inside a circle whose
     radius comes from the SMALLER dimension, so on a wide box it leaves the
     sides empty; the fit spends that room without changing any angle. */
  return { nodes: fitToBox(out, box), box };
}

/**
 * Scale a settled layout to fill its box, WITHOUT changing what it means.
 *
 * MEASURED BEFORE THIS EXISTED. Fifteen markets relaxed into a blob using 23.3%
 * of the canvas width and 37.9% of its height — three quarters of the picture
 * empty, which is a defect this project has photographed on four other
 * surfaces. Relaxation decides the SHAPE of the graph; how much of the
 * available room that shape occupies is a separate question, and answering it
 * by tuning spring constants would mean re-tuning them for every box size.
 *
 * THE SCALE IS UNIFORM, AND THAT IS THE WHOLE CARE OF IT. Stretching x and y by
 * different factors to fill a wide box would make a horizontal pair look closer
 * together than a vertical pair at the identical correlation — the one claim
 * this layout makes, quietly broken in order to use up space. One factor, so
 * every RATIO of distances survives.
 */
export function fitToBox(placed: readonly PlacedNode[], box: Box): PlacedNode[] {
  if (placed.length === 0) return [];

  const maxR = Math.max(...placed.map((n) => n.r));
  /* The usable area is the box minus the largest node's radius on each side,
     plus room under it for a label. A node fitted to the exact edge is a node
     drawn half outside, which reads as missing rather than as placed. */
  const padX = maxR + 6;
  const padY = maxR + 14;
  const innerW = Math.max(1, box.w - padX * 2);
  const innerH = Math.max(1, box.h - padY * 2);

  const xs = placed.map((n) => n.x);
  const ys = placed.map((n) => n.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);

  /* NO EXTENT MEANS NOTHING TO SCALE. One node, or every node stacked, has a
     span of zero, and `inner / 0` is Infinity — which lands every coordinate on
     NaN and draws as nothing at all. Centre instead. */
  if (!(spanX > 1e-6) && !(spanY > 1e-6)) {
    return placed.map((n) => ({ id: n.id, x: box.w / 2, y: box.h / 2, r: n.r }));
  }

  const k = Math.min(
    spanX > 1e-6 ? innerW / spanX : Infinity,
    spanY > 1e-6 ? innerH / spanY : Infinity,
  );

  /* Centre what is left over, so the slack is shared rather than pooled on one
     side: 420px of space on one edge reads as a layout that failed, and the
     same amount on both reads as one that stopped. */
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midY = (Math.max(...ys) + Math.min(...ys)) / 2;

  return placed.map((n) => ({
    id: n.id,
    x: clampIn(box.w / 2 + (n.x - midX) * k, n.r, box.w),
    y: clampIn(box.h / 2 + (n.y - midY) * k, n.r, box.h),
    r: n.r,
  }));
}

export interface ForceOptions {
  /** Relaxation steps. More is smoother and slower; the default settles a dozen nodes. */
  readonly steps?: number;
}

/**
 * Spring relaxation: related things end up near each other.
 *
 * DETERMINISTIC, from `hash01` of each id — see this file's header. Running it
 * twice on one graph gives byte-identical positions, which is what lets two
 * drawings of the same market be compared at all.
 */
export function forceLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  box: Box,
  opts: ForceOptions = {},
): Layout {
  const n = nodes.length;
  if (n === 0) return { nodes: [], box };

  const steps = Math.max(1, Math.floor(opts.steps ?? 220));
  const cx = box.w / 2;
  const cy = box.h / 2;
  /* THE ARRANGEMENT STARTS THE SHAPE OF ITS CANVAS, on an ELLIPSE rather than a
     circle. Measured on the real desk: once the clipping was fixed the stage
     became 1448x366 and a round arrangement filled 89% of the height against 21%
     of the width. Uniform scaling is what keeps distance comparable and it
     cannot rescue a square shape in an oblong box, so the shape has to be right
     before the relaxation starts.

     ONLY THE SEEDING IS ANISOTROPIC. Repulsion, attraction and the final scale
     all stay isotropic, so a horizontal pair never reads as closer than a
     vertical pair at the same strength. */
  const spreadX = box.w * 0.4;
  const spreadY = box.h * 0.4;
  const spread = Math.min(spreadX, spreadY);

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rs = new Float64Array(n);
  const index = new Map<string, number>();

  nodes.forEach((node, i) => {
    index.set(node.id, i);
    rs[i] = radiusOf(node.weight);
    /* SEEDED FROM THE ID, on a circle rather than a square: two ids that hash
       close together still land apart, and nothing starts at the exact centre
       where every repulsion vector would be a division by zero. */
    const a = hash01(node.id, 1) * Math.PI * 2;
    const d = 0.35 + hash01(node.id, 2) * 0.65;
    xs[i] = cx + Math.cos(a) * spreadX * d;
    ys[i] = cy + Math.sin(a) * spreadY * d;
  });

  /* MAGNITUDE, NOT SIGN. An inverse relationship is a relationship; only the
     colour carries the direction. A non-finite value contributes no pull rather
     than poisoning the whole run with a NaN. */
  const links = edges
    .map((e) => {
      const a = index.get(e.from);
      const b = index.get(e.to);
      const v = Number.isFinite(e.value) ? Math.min(1, Math.abs(e.value)) : 0;
      const c = Number.isFinite(e.confidence) ? Math.min(1, Math.max(0, e.confidence)) : 0;
      return a === undefined || b === undefined ? null : { a, b, k: v * c };
    })
    .filter((l): l is { a: number; b: number; k: number } => l !== null);

  const ideal = spread * 0.9;
  const repel = spread * spread * 0.02;

  for (let s = 0; s < steps; s += 1) {
    const cool = 1 - s / steps;

    // Repulsion, every pair.
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = (xs[i] as number) - (xs[j] as number);
        let dy = (ys[i] as number) - (ys[j] as number);
        let d2 = dx * dx + dy * dy;
        /* COINCIDENT NODES ARE A DIVISION BY ZERO, and one NaN coordinate takes
           the node off the canvas with nothing on screen to say so. Nudge them
           apart deterministically rather than normalising a zero vector. */
        if (d2 < 1e-6) {
          dx = ((i % 7) - 3) * 0.01 + 0.013;
          dy = ((j % 5) - 2) * 0.01 + 0.017;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = (repel / d2) * cool;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        xs[i] = (xs[i] as number) + ux;
        ys[i] = (ys[i] as number) + uy;
        xs[j] = (xs[j] as number) - ux;
        ys[j] = (ys[j] as number) - uy;
      }
    }

    // Attraction along the links.
    for (const l of links) {
      const dx = (xs[l.b] as number) - (xs[l.a] as number);
      const dy = (ys[l.b] as number) - (ys[l.a] as number);
      const d = Math.hypot(dx, dy) || 1e-3;
      const f = ((d - ideal * (1 - l.k * 0.75)) / d) * 0.045 * l.k * cool;
      const ux = dx * f;
      const uy = dy * f;
      xs[l.a] = (xs[l.a] as number) + ux;
      ys[l.a] = (ys[l.a] as number) + uy;
      xs[l.b] = (xs[l.b] as number) - ux;
      ys[l.b] = (ys[l.b] as number) - uy;
    }

    /* A gentle pull to the middle, so an unconnected node does not drift out.
       IT COOLS WITH EVERYTHING ELSE, and that is not a detail: repulsion and
       attraction both fade as the run settles, so a centring force at full
       strength to the last step simply wins. Measured with a constant 0.008 over
       400 steps it retained 4% of every distance — a related pair and an
       unrelated one ended up the same distance apart, which is the one claim a
       force graph makes. */
    const pull = 0.008 * cool;
    for (let i = 0; i < n; i += 1) {
      xs[i] = (xs[i] as number) + (cx - (xs[i] as number)) * pull;
      ys[i] = (ys[i] as number) + (cy - (ys[i] as number)) * pull;
    }
  }

  const out: PlacedNode[] = nodes.map((node, i) => {
    const r = rs[i] as number;
    const x = xs[i] as number;
    const y = ys[i] as number;
    /* A LAST GUARD, not an expectation. Every path above is finite by
       construction, and a coordinate that is not still must never reach the
       canvas: NaN draws as nothing, which reads as broken rather than as absent. */
    return {
      id: node.id,
      x: Number.isFinite(x) ? clampIn(x, r, box.w) : clampIn(cx, r, box.w),
      y: Number.isFinite(y) ? clampIn(y, r, box.h) : clampIn(cy, r, box.h),
      r,
    };
  });

  /* FITTED HERE, not by each caller. The defect was in what reached the screen,
     so the fix belongs where the positions are produced — a card that forgot to
     call it would silently go back to a blob in the corner. */
  return { nodes: fitToBox(out, box), box };
}
