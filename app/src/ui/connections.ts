/**
 * CONNECTIONS — one graph surface over three sets of relationships.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THREE VIEWS AND NOT THREE DESKS
 *
 * The same picture answers three questions this terminal already asks in words
 * and nowhere in shape:
 *
 *   **Markets** — is my book one bet wearing five names, and has that changed?
 *   **System**  — are these ten small failures actually one fault?
 *   **Search**  — which rule worked in which market state, and did any of them
 *                 beat the search that found them?
 *
 * Each is genuinely a graph, each has live data behind it, and all three want
 * the same renderer, the same layout and the same honesty rules. Three desks
 * would mean three of everything and three places for the encoding to drift.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PICTURE IS THE DANGEROUS PART
 *
 * Everything in a graph reads as a claim. A line says "related". A thick line
 * says "strongly". A node near the middle says "central". None of that can be
 * checked by looking, so the encoding lives in `viz/render.ts` as pure tested
 * functions, the arithmetic lives in the modules that already own each fact, and
 * this file only arranges them and says what it could NOT measure.
 *
 * THREE RULES EVERY VIEW KEEPS:
 *
 *  1. **A FIGURE IS NEVER SHOWN WITHOUT ITS SAMPLE.** CLAUDE.md: "-0.72 is a
 *     point estimate with no window."
 *  2. **WHAT COULD NOT BE MEASURED IS COUNTED.** A missing line and a measured
 *     absence look identical on a canvas.
 *  3. **NO LIVE DEFAULT.** Every loader is passed in. This project has twice had
 *     a test reach the operator's real store through a transport that defaulted
 *     to the live one.
 */

import { computed, renderEffect, signal } from "../core/signal";
import { scheduleFrame } from "../core/frame";
import { clear, h } from "./dom";
import { onShown } from "./cards/shown";
import { pkEmpty, pkFold } from "./panelkit";
import { correlationGraph, type CorrelationEdge, type SeriesBars } from "../backtest/correlate";
import { topologyGraph, type FaultCluster } from "../viz/topology";
import { fieldGraph, type FieldSummary } from "../viz/fieldgraph";
import type { ActivityKind } from "../data/activity";
import type { Discovered } from "../backtest/discovered";
import {
  forceLayout,
  radialLayout,
  validateGraph,
  type GraphEdge,
  type GraphNode,
  type PlacedNode,
} from "../viz/layout";
import { drawGraph, hitTest, readPalette } from "../viz/render";
import { DEFAULT_CAMERA, panBy, toWorld, zoomAt, type Camera } from "../viz/camera";
import { rollingCorrelation, utcDay, type ClosesSeries } from "../data/correlation";

/** What a loader was able to get, whether or not it worked. */
export interface SeriesLoad {
  readonly series: SeriesBars;
  /** One line per series it could not get, addressed to the operator. */
  readonly missing: readonly string[];
  readonly note: string;
}

export interface ConnectionsOptions {
  /** NO DEFAULTS — see this file's header. */
  readonly loadSeries: () => Promise<SeriesLoad>;
  readonly loadActivity: () => Promise<readonly ActivityKind[]>;
  /** The shelf is already in memory; a getter, not a fetch. */
  readonly shelf: () => readonly Discovered[];
}

export interface ConnectionsHandle {
  readonly el: HTMLElement;
  /**
   * Read everything again.
   *
   * EXPOSED BECAUSE `onShown` CANNOT BE THE ONLY TRIGGER. Its check is
   * `getClientRects().length > 0`, which is always zero in jsdom and delivers
   * nothing in a background tab — CLAUDE.md: anything triggered by becoming
   * visible needs a second path. This is it, and it is what Refresh calls.
   */
  readonly refresh: () => Promise<void>;
}

type View = "markets" | "system" | "search";
type Shape = "web" | "rings";

const VIEWS: readonly { readonly id: View; readonly label: string; readonly sub: string }[] = [
  {
    id: "markets",
    label: "Markets",
    sub: "Which markets move together, measured on the days both of them actually traded.",
  },
  {
    id: "system",
    label: "System",
    sub: "Background jobs, joined where they are failing the same way. One cause looks like many.",
  },
  {
    id: "search",
    label: "Search",
    sub: "Which rule was tried in which market state, and whether any of them beat the search that found it.",
  },
];

const SHAPES: readonly { readonly id: Shape; readonly label: string; readonly hint: string }[] = [
  { id: "web", label: "Web", hint: "Related things pulled together. Distance is how strongly they are related." },
  { id: "rings", label: "Rings", hint: "Grouped, in fixed positions you can compare between visits." },
];

const pct = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

/** How wide a sparkline is, in its own coordinates. Height is -1..+1 of r. */
const SPARK_W = 88;
const SPARK_H = 22;

/**
 * The rolling correlation of one pair, as a line.
 *
 * WHY A PICTURE AND NOT THE NUMBER. `stable` says THAT a pair reversed and
 * `instability` says by how much; neither says WHEN, and when is the difference
 * between a caveat and something an operator can act on. A line that starts
 * below zero and ends above it is a fact you can point at.
 *
 * DRAWN ON A FIXED -1..+1 SCALE, never scaled to its own range — a pair that
 * wobbled between +0.62 and +0.66 would otherwise draw the identical dramatic
 * zigzag as one that crossed from -0.9 to +0.9. That is the shared-domain rule
 * `ui/cards/plot.ts` exists for, and it is the whole risk in a small chart.
 */
function sparkline(points: readonly { readonly r: number }[]): HTMLElement | null {
  if (points.length < 3) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("class", "graph-spark");
  svg.setAttribute("aria-hidden", "true");

  const x = (i: number): number => (i / (points.length - 1)) * SPARK_W;
  /* FIXED DOMAIN: +1 at the top, -1 at the bottom, zero in the middle. */
  const y = (r: number): number => ((1 - Math.max(-1, Math.min(1, r))) / 2) * SPARK_H;

  const zero = document.createElementNS("http://www.w3.org/2000/svg", "line");
  zero.setAttribute("x1", "0");
  zero.setAttribute("x2", String(SPARK_W));
  zero.setAttribute("y1", String(SPARK_H / 2));
  zero.setAttribute("y2", String(SPARK_H / 2));
  zero.setAttribute("class", "graph-spark-zero");
  svg.appendChild(zero);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");
  /* An EMPTY `d` is a parse error in some engines and nothing in the rest, and
     "no data" and "a line at zero" are different facts — so the element is not
     added at all rather than carrying an empty attribute. */
  if (d === "") return null;
  path.setAttribute("d", d);
  path.setAttribute("class", "graph-spark-line");
  svg.appendChild(path);
  return svg as unknown as HTMLElement;
}

/** A correlation in words, because the number alone is not the finding. */
function edgeWords(e: CorrelationEdge): string {
  const strength =
    Math.abs(e.value) >= 0.8 ? "almost the same move" :
    Math.abs(e.value) >= 0.6 ? "strongly together" :
    Math.abs(e.value) >= 0.45 ? "clearly together" : "loosely together";
  const dir = e.value < 0 ? "in opposite directions" : "in the same direction";
  const held = e.stable
    ? "and it held across the whole window"
    : Number.isFinite(e.instability)
      ? `but it did NOT hold — it ranged ${e.instability.toFixed(2)} across the window`
      : "and there were too few days to check whether it held";
  return `${strength}, ${dir}, ${held}.`;
}

/** What one view hands the shared canvas and the panels under it. */
interface ViewData {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly (GraphEdge & { readonly stable?: boolean })[];
  readonly counts: string;
  readonly key: readonly { readonly kind: string; readonly text: string }[];
  /** Rows for the thing under the pointer. */
  readonly focus: (id: string) => readonly HTMLElement[];
  /** Anything that could not be measured, behind a disclosure. */
  readonly tail: readonly HTMLElement[];
  /**
   * The few figures worth reading before the picture.
   *
   * A CARD THAT ANSWERS A QUESTION SHOULD LEAD WITH THE ANSWER. The graph shows
   * the shape; these say the one or two numbers somebody would otherwise hunt
   * for by hovering every node in turn.
   */
  readonly tiles: readonly { readonly label: string; readonly value: string; readonly note: string }[];
  /**
   * What to say when there is nothing to draw.
   *
   * AN UNEXPLAINED EMPTY STATE IS THE ONE THIS PROJECT KEEPS PAYING FOR. "Nothing
   * to draw" and "nothing has been kept yet, so there is no field to draw" are
   * different facts, and only the second tells the operator whether to wait, to
   * press something, or to go and look at why. Each view supplies its own.
   */
  readonly emptyWhy: string;
}

const EMPTY_VIEW: ViewData = {
  nodes: [],
  edges: [],
  counts: "",
  key: [],
  focus: () => [],
  tail: [],
  emptyWhy: "",
  tiles: [],
};

export function createConnections(opts: ConnectionsOptions): ConnectionsHandle {
  const view = signal<View>("markets");
  const shape = signal<Shape>("web");
  const series = signal<SeriesLoad | null>(null);
  const activity = signal<readonly ActivityKind[] | null>(null);
  const shelfRows = signal<readonly Discovered[]>([]);
  const loading = signal(false);
  const failed = signal("");
  const hover = signal<string | null>(null);
  const size = signal<{ w: number; h: number }>({ w: 640, h: 420 });
  const cam = signal<Camera>(DEFAULT_CAMERA);

  /* ── MARKETS ──────────────────────────────────────────────────────────── */
  const markets = computed<ViewData>(() => {
    const l = series();
    if (l === null) return EMPTY_VIEW;
    const g = correlationGraph(l.series);
    return {
      nodes: g.nodes,
      edges: g.edges,
      counts:
        `${g.nodes.length} markets · ${g.edges.length} relationship${g.edges.length === 1 ? "" : "s"} drawn · ` +
        `${g.belowFloor} pair${g.belowFloor === 1 ? "" : "s"} measured and found unrelated · ` +
        `${g.refused.length} could not be measured`,
      key: [
        { kind: "pos", text: "same direction" },
        { kind: "neg", text: "opposite direction" },
        { kind: "thick", text: "thicker = stronger" },
        { kind: "dash", text: "dashed = did not hold across the window" },
      ],
      focus: (id) => {
        const mine = g.edges
          .filter((e) => e.from === id || e.to === id)
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
        const closes = (sym: string): ClosesSeries => ({
          symbol: sym,
          closes: (l.series[sym] ?? []).map((b) => ({ t: b.t, c: b.c })),
        });
        if (mine.length === 0) {
          return [
            h("p", {
              class: "graph-hint",
              text: "Nothing else in the archive moved with this one above the floor. That is a measured answer, not a missing one.",
            }),
          ];
        }
        return mine.map((e) => {
          const other = e.from === id ? e.to : e.from;
          /* THE LINE IS THE POINT OF THIS ROW. It is computed from the same bars
             the coefficient beside it came from, so the two cannot disagree. */
          const spark = sparkline(
            rollingCorrelation(closes(id), closes(other), { bucket: utcDay, window: 90, points: 48 }),
          );
          return h(
            "div",
            { class: "graph-row", "data-sign": e.value < 0 ? "neg" : "pos", "data-held": String(e.stable) },
            h("span", { class: "graph-row-sym", text: other }),
            h("span", { class: "graph-row-r num", text: pct(e.value) }),
            h("span", { class: "graph-row-n num", text: `${e.n} days` }),
            spark ?? h("span", { class: "graph-spark-none", text: "—" }),
            h("span", { class: "graph-row-why", text: edgeWords(e) }),
          );
        });
      },
      tail: [
        ...(g.refused.length > 0
          ? [
              pkFold(
                `Why ${g.refused.length} pair${g.refused.length === 1 ? "" : "s"} could not be measured`,
                ...g.refused.map((r) => h("p", { class: "graph-why", text: `${r.pair} — ${r.why}` })),
              ),
            ]
          : []),
        ...(l.missing.length > 0
          ? [
              pkFold(
                `${l.missing.length} series could not be read`,
                ...l.missing.map((m) => h("p", { class: "graph-why", text: m })),
              ),
            ]
          : []),
      ],
      emptyWhy:
        "No daily series in the archive yet. Download some history on the Data desk and this fills in.",
      tiles: (() => {
        if (g.edges.length === 0) return [];
        const strongest = [...g.edges].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]!;
        const shaky = g.edges.filter((e) => !e.stable).length;
        const busiest = [...g.nodes].sort((a, b) => b.weight - a.weight)[0]!;
        return [
          {
            label: "Strongest link",
            value: `${strongest.from} · ${strongest.to}`,
            note: `${pct(strongest.value)} over ${strongest.n} shared days`,
          },
          {
            label: "Most connected",
            value: busiest.id,
            note: "moves with more of the board than anything else here",
          },
          {
            label: "Did not hold",
            value: `${shaky} of ${g.edges.length}`,
            note: shaky === 0
              ? "every relationship drawn held across its window"
              : "reversed inside the window — drawn dashed",
          },
        ];
      })(),
    };
  });

  /* ── SYSTEM ───────────────────────────────────────────────────────────── */
  const system = computed<ViewData>(() => {
    const kinds = activity();
    if (kinds === null) return EMPTY_VIEW;
    const g = topologyGraph(kinds);
    const shared = g.clusters.reduce((s: number, c: FaultCluster) => s + c.jobs, 0);
    return {
      nodes: g.nodes,
      edges: g.edges,
      counts:
        `${g.nodes.length} jobs · ${g.clusters.length} shared fault${g.clusters.length === 1 ? "" : "s"} ` +
        `across ${shared} of them · ` +
        `${g.nodes.filter((n) => n.group === "healthy").length} have never failed`,
      key: [
        { kind: "neg", text: "joined = failing the same way" },
        { kind: "thick", text: "bigger = more entries logged" },
      ],
      focus: (id) => {
        const k = kinds.find((x) => x.kind === id);
        if (k === undefined) return [];
        const mates = g.edges
          .filter((e) => e.from === id || e.to === id)
          .map((e) => (e.from === id ? e.to : e.from));
        const rows = [
          h("p", {
            class: "graph-why",
            text: `${k.n.toLocaleString()} entries, ${k.failed.toLocaleString()} of them failures. Newest: ${k.sample || "no message"}`,
          }),
        ];
        rows.push(
          mates.length === 0
            ? h("p", {
                class: "graph-hint",
                text: "Nothing else fails the same way. Whatever is wrong here is its own problem.",
              })
            : h("p", {
                class: "graph-hint",
                text: `Fails identically to: ${mates.join(", ")}. That is one cause, not ${mates.length + 1}.`,
              }),
        );
        return rows;
      },
      tail:
        g.clusters.length > 0
          ? [
              pkFold(
                `${g.clusters.length} fault${g.clusters.length === 1 ? "" : "s"} hitting more than one job`,
                ...g.clusters.map((c) => h("p", { class: "graph-why", text: c.why })),
              ),
            ]
          : [],
      emptyWhy: "The job log is empty. That is the state of a fresh install, not a claim that all is well.",
      tiles: (() => {
        const worst = g.clusters[0];
        const failing = g.nodes.filter((n) => n.group === "failing").length;
        return [
          {
            label: "Biggest shared fault",
            value: worst ? `${worst.jobs} jobs` : "none",
            note: worst
              ? `${worst.entries.toLocaleString()} entries, one cause`
              : "no two jobs are failing the same way",
          },
          {
            label: "Failing now",
            value: String(failing),
            note: failing === 0 ? "nothing is failing at the moment" : "of the jobs that write a log",
          },
          {
            label: "Waiting for you",
            value: String(g.nodes.filter((n) => n.group === "waiting for you").length),
            note: "held up on something only you can supply — not broken",
          },
        ];
      })(),
    };
  });

  /* ── SEARCH ───────────────────────────────────────────────────────────── */
  const search = computed<ViewData>(() => {
    const g = fieldGraph(shelfRows());
    const s: FieldSummary = g.summary;
    return {
      nodes: g.nodes,
      edges: g.edges,
      counts:
        `${s.arms} arm${s.arms === 1 ? "" : "s"} · ${s.cleared} beat the hurdle its own search set · ` +
        `${s.unpaired} kept without a state`,
      key: [
        { kind: "pos", text: "beat the hurdle" },
        { kind: "neg", text: "did not beat the hurdle" },
        { kind: "thick", text: "thicker = wider margin" },
      ],
      focus: (id) => {
        const mine = g.edges.filter((e) => e.from === id || e.to === id);
        if (mine.length === 0) return [h("p", { class: "graph-hint", text: "No arms for this one." })];
        return [...mine]
          .sort((a, b) => b.value - a.value)
          .map((e) =>
            h(
              "div",
              { class: "graph-row", "data-sign": e.value > 0 ? "pos" : "neg", "data-held": "true" },
              h("span", { class: "graph-row-sym", text: e.from === id ? e.to : e.from }),
              h("span", { class: "graph-row-r num", text: e.value.toFixed(3) }),
              h("span", { class: "graph-row-n num", text: "deflated" }),
              h("span", {
                class: "graph-row-why",
                text:
                  e.value > 0
                    ? "beat what a search this wide finds in nothing."
                    : "did not beat what a search this wide finds in nothing.",
              }),
            ),
          );
      },
      tail: [h("p", { class: "graph-why", text: s.why })],
      /* THE SUMMARY'S OWN SENTENCE, which already distinguishes "nothing kept
         yet" from "kept, but none of it was conditioned on a state". */
      emptyWhy: s.why,
      tiles:
        s.arms === 0
          ? []
          : (() => {
              const best = [...g.edges].sort((a, b) => b.value - a.value)[0]!;
              return [
                { label: "Arms tried", value: String(s.arms), note: "every one raises the bar for all of them" },
                {
                  label: "Beat the hurdle",
                  value: `${s.cleared} of ${s.arms}`,
                  note: s.cleared === 0 ? "none of them beat what the search finds in noise" : "after the best-of-N correction",
                },
                { label: "Best margin", value: best.value.toFixed(3), note: `${best.from} in ${best.to}` },
              ];
            })(),
    };
  });

  const data = computed<ViewData>(() =>
    view() === "system" ? system() : view() === "search" ? search() : markets(),
  );

  /* THE LAYOUT IS COMPUTED, NOT ANIMATED INTO PLACE. `viz/layout.ts` is
     deterministic on purpose: the same inputs give the same picture, so two
     visits can be compared. A layout that settled differently each time would
     look livelier and mean nothing. */
  const placed = computed<readonly PlacedNode[]>(() => {
    const d = data();
    const box = size();
    if (d.nodes.length === 0) return [];
    if (!validateGraph(d.nodes, d.edges, box).ok) return [];
    return shape() === "rings" ? radialLayout(d.nodes, box).nodes : forceLayout(d.nodes, d.edges, box).nodes;
  });

  const layoutRefusal = computed<string>(() => {
    const d = data();
    if (d.nodes.length === 0) return "";
    const check = validateGraph(d.nodes, d.edges, size());
    return check.ok ? "" : check.why;
  });

  async function refresh(): Promise<void> {
    if (loading.peek()) return;
    loading.set(true);
    failed.set("");
    try {
      /* BOTH, AND EACH ON ITS OWN. One dead service must not blank a view fed by
         the other — the same reason a study's series fetch returns null per
         series rather than abandoning the lot. */
      const [s, a] = await Promise.allSettled([opts.loadSeries(), opts.loadActivity()]);
      if (s.status === "fulfilled") series.set(s.value);
      if (a.status === "fulfilled") activity.set(a.value);
      shelfRows.set(opts.shelf());
      if (s.status === "rejected" && a.status === "rejected") {
        failed.set("the archive is not answering, so there is nothing to compare");
      }
    } finally {
      loading.set(false);
    }
  }

  const canvas = h("canvas", { class: "graph-canvas" }) as HTMLCanvasElement;

  /**
   * Paint.
   *
   * `scheduleFrame` rather than a bare `requestAnimationFrame`: CLAUDE.md
   * records that rAF never fires in an uncomposited tab, so a canvas that
   * depends on it stays blank on a background tab with nothing to say why.
   */
  let cancelPaint: (() => void) | null = null;
  function paint(): void {
    cancelPaint?.();
    cancelPaint = scheduleFrame(() => {
      const d = data();
      const p = placed();
      const box = size();
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;

      /* THE DEVICE PIXEL RATIO, or every line is soft on the screens this is
         actually read on. The transform is RESET each paint rather than
         accumulated, which is how a canvas ends up drawing at 4x after two
         resizes. */
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.round(box.w * dpr);
      canvas.height = Math.round(box.h * dpr);
      canvas.style.width = `${box.w}px`;
      canvas.style.height = `${box.h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      drawGraph(
        ctx,
        {
          placed: p,
          edges: d.edges,
          labels: Object.fromEntries(d.nodes.map((n) => [n.id, n.label])),
          weights: Object.fromEntries(d.nodes.map((n) => [n.id, n.weight])),
          hover: hover(),
        },
        readPalette(canvas),
        box,
        cam(),
      );
    });
  }

  renderEffect(() => {
    void data();
    void placed();
    void hover();
    void size();
    void cam();
    paint();
  });

  /* A VIEW CHANGE IS A NEW PICTURE, so the pointer's answer must not survive it:
     a focus panel describing BTCUSDT under a graph of background jobs would be a
     readout about something that is not on the screen. */
  renderEffect(() => {
    void view();
    hover.set(null);
    /* A NEW PICTURE GETS A NEW CAMERA. Keeping a 4x zoom on the corner of the
       market web while switching to a graph of background jobs would open the
       new view somewhere meaningless, with no clue that it had been moved. */
    cam.set(DEFAULT_CAMERA);
  });

  /* PANNING, and the drag state that tells a pan from a hover. */
  let dragFrom: { x: number; y: number } | null = null;
  let dragged = false;

  canvas.addEventListener("pointermove", (ev) => {
    const box = canvas.getBoundingClientRect();
    const sx = ev.clientX - box.left;
    const sy = ev.clientY - box.top;

    if (dragFrom !== null) {
      dragged = true;
      cam.set(panBy(cam.peek(), sx - dragFrom.x, sy - dragFrom.y, size.peek()));
      dragFrom = { x: sx, y: sy };
      return;
    }
    /* THE POINTER ARRIVES IN SCREEN SPACE AND THE LAYOUT LIVES IN WORLD SPACE.
       Hit-testing the raw coordinates would name the market that HAPPENS to sit
       where the pointer is on an unzoomed picture — right until the first zoom,
       and then quietly wrong. */
    const w = toWorld(cam.peek(), sx, sy);
    const id = hitTest(placed(), w.x, w.y);
    if (id !== hover.peek()) hover.set(id);
  });

  canvas.addEventListener("pointerdown", (ev) => {
    const box = canvas.getBoundingClientRect();
    dragFrom = { x: ev.clientX - box.left, y: ev.clientY - box.top };
    dragged = false;
    canvas.setPointerCapture(ev.pointerId);
  });
  const endDrag = (ev: PointerEvent): void => {
    dragFrom = null;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", (ev) => {
    endDrag(ev);
    hover.set(null);
  });

  /* WHEEL ZOOM, ANCHORED AT THE POINTER. `passive: false` because this
     deliberately prevents the page from scrolling under the cursor — a graph
     that scrolls the desk away while you try to zoom it is unusable. */
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const box = canvas.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * 0.0016);
      cam.set(zoomAt(cam.peek(), factor, ev.clientX - box.left, ev.clientY - box.top, size.peek()));
    },
    { passive: false },
  );

  /* DOUBLE-CLICK RESETS, because a control you have to find is a control the
     operator does not know is there when they need it most. `dragged` keeps a
     pan from being read as a click. */
  canvas.addEventListener("dblclick", () => {
    if (!dragged) cam.set(DEFAULT_CAMERA);
  });

  const canvasWrap = h(
    "div",
    {
      class: "graph-stage",
      ref: (el: HTMLDivElement) => {
        const measure = (): void => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          /* BOTH DIMENSIONS ARE MEASURED, and the height especially.
             Deriving it from the width was the defect: at 1900px that asked for
             898px inside a stage the layout had capped, so 532 pixels of the
             graph were drawn where `overflow: hidden` ate them — half the
             markets below the fold with nothing on screen to say so.

             There is no feedback loop, because `.graph-stage` now carries an
             explicit CSS height that does not depend on its contents. A bar that
             measures itself must not be sized by what it is showing, and this
             one is not. */
          const w = Math.max(200, Math.round(r.width));
          const hgt = Math.max(200, Math.round(r.height));
          const cur = size.peek();
          if (cur.w !== w || cur.h !== hgt) size.set({ w, h: hgt });
        };

        /* A RESIZE OBSERVER IS NOT ALWAYS THERE, AND IS NOT ALWAYS AWAKE. It does
           not exist in jsdom at all — constructing one unguarded threw and took
           the whole desk with it, which is how this was found — and CLAUDE.md
           records that it delivers nothing in a background tab either. So it is
           the preferred path and never the only one. */
        if (typeof ResizeObserver === "function") {
          new ResizeObserver(measure).observe(el);
        }
        onShown(el, () => {
          measure();
          if (series.peek() === null) void refresh();
        });
        window.addEventListener("resize", measure);
      },
    },
    canvas,
  );

  const el = h(
    "section",
    { class: "dd graph-desk" },

    h(
      "header",
      { class: "dd-head" },
      h("h2", { class: "dd-title", text: "Connections" }),
      h("p", { class: "dd-sub", text: () => VIEWS.find((v) => v.id === view())?.sub ?? "" }),
    ),

    h(
      "div",
      { class: "graph-bar" },
      h(
        "div",
        { class: "seg" },
        ...VIEWS.map((v) =>
          h("button", {
            class: "seg-btn",
            type: "button",
            text: v.label,
            title: v.sub,
            "data-on": () => String(view() === v.id),
            onclick: () => view.set(v.id),
          }),
        ),
      ),
      h(
        "div",
        { class: "seg" },
        ...SHAPES.map((s) =>
          h("button", {
            class: "seg-btn",
            type: "button",
            text: s.label,
            title: s.hint,
            "data-on": () => String(shape() === s.id),
            onclick: () => shape.set(s.id),
          }),
        ),
      ),
      /* THE ZOOM CONTROLS. The wheel and a drag do the same job and are what
         most people reach for, but a control that exists only as a gesture is a
         control somebody will never discover — this project has already paid for
         a panel whose only routes back were a key and a 22px icon. */
      h(
        "div",
        { class: "seg" },
        h("button", {
          class: "seg-btn",
          type: "button",
          text: "−",
          title: "Zoom out (or scroll on the picture)",
          onclick: () => cam.set(zoomAt(cam.peek(), 1 / 1.35, size.peek().w / 2, size.peek().h / 2, size.peek())),
        }),
        h("button", {
          class: "seg-btn",
          type: "button",
          text: "+",
          title: "Zoom in (or scroll on the picture)",
          onclick: () => cam.set(zoomAt(cam.peek(), 1.35, size.peek().w / 2, size.peek().h / 2, size.peek())),
        }),
        h("button", {
          class: "seg-btn",
          type: "button",
          text: "Fit",
          title: "Back to the whole picture (or double-click it)",
          onclick: () => cam.set(DEFAULT_CAMERA),
        }),
      ),
      h("span", {
        class: "graph-zoom",
        text: () => (cam().zoom === 1 ? "" : `${cam().zoom.toFixed(1)}x · drag to move`),
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: () => (loading() ? "Reading…" : "Refresh"),
        onclick: () => void refresh(),
      }),
      h("span", { class: "graph-note", text: () => (view() === "markets" ? (series()?.note ?? "") : "") }),
    ),

    /* THE FIGURES, BEFORE THE PICTURE. A card that answers a question should
       lead with the answer; the graph is how you check it. */
    h("div", {
      class: "graph-tiles",
      ref: (box: HTMLDivElement) => {
        renderEffect(() => {
          const d = data();
          clear(box);
          for (const t of d.tiles) {
            box.appendChild(
              h(
                "div",
                { class: "graph-tile" },
                h("span", { class: "graph-tile-label", text: t.label }),
                h("span", { class: "graph-tile-value", text: t.value }),
                h("span", { class: "graph-tile-note", text: t.note }),
              ),
            );
          }
        });
      },
    }),

    canvasWrap,

    /* THE KEY, PER VIEW. A picture whose channels are not explained is
       decoration, and the three views encode different things in them. */
    h("div", {
      class: "graph-key",
      ref: (box: HTMLDivElement) => {
        renderEffect(() => {
          const d = data();
          clear(box);
          for (const k of d.key) {
            box.appendChild(h("span", { class: "graph-key-item", "data-kind": k.kind, text: k.text }));
          }
        });
      },
    }),

    h("p", {
      class: "graph-refusal",
      "data-show": () => String(layoutRefusal() !== "" || failed() !== ""),
      text: () => failed() || layoutRefusal(),
    }),

    h("div", {
      class: "graph-focus",
      ref: (box: HTMLDivElement) => {
        renderEffect(() => {
          const d = data();
          const id = hover();
          clear(box);
          if (id === null) {
            box.appendChild(h("p", { class: "graph-hint", text: "Point at something to see what it connects to." }));
            return;
          }
          box.appendChild(h("h3", { class: "graph-focus-title", text: id }));
          for (const row of d.focus(id)) box.appendChild(row);
        });
      },
    }),

    /* EVERYTHING THAT WAS NOT DRAWN, counted. A canvas cannot distinguish a
       missing line from a measured absence, so the numbers say which. */
    h("div", {
      class: "graph-tail",
      ref: (box: HTMLDivElement) => {
        renderEffect(() => {
          const d = data();
          clear(box);
          if (d.nodes.length === 0) {
            box.appendChild(
              pkEmpty(
                loading() ? "loading" : "empty",
                loading() ? "Reading…" : d.emptyWhy || "Nothing to draw for this view yet.",
              ),
            );
            return;
          }
          box.appendChild(h("p", { class: "graph-counts", text: d.counts }));
          for (const t of d.tail) box.appendChild(t);
        });
      },
    }),
  ) as HTMLElement;

  return { el, refresh };
}
