/**
 * Drawing on the chart: pointer input, selection and handles.
 *
 * HOW THIS COEXISTS WITH THE CHART'S OWN POINTER HANDLING
 * The chart binds crosshair, pan and zoom to its overlay canvas. Rather than
 * fight that with a second canvas and a z-index, this listens on the HOST in
 * the CAPTURE phase — so it sees every event first, and forwards the ones that
 * are not its business by simply doing nothing. It calls `stopPropagation` only
 * when it is genuinely taking the interaction: while a tool is armed, or when
 * the press landed on a drawing. Panning a chart with a trendline on it
 * therefore behaves exactly as it did before drawings existed.
 *
 * WHY THE DRAWINGS THEMSELVES GO THROUGH `setAnnotations`
 * Because the chart already knows how to paint lines, boxes and levels glued to
 * bar indices — the detectors have used that path since v40. Reusing it means a
 * hand-drawn trendline and a detected one are pixel-identical, pan and zoom
 * together, and re-theme together. A second painting route would have been a
 * second set of rounding bugs.
 *
 * HANDLES ARE DOM, NOT CANVAS. There are at most two per selection, they need
 * hover and cursor styling, and putting them in the DOM means the canvas never
 * repaints just because a handle lit up.
 */

import { h } from "./dom";
import { signal, type Signal } from "../core/signal";
import { scheduleFrame } from "../core/frame";
import type { ChartEngine } from "../chart/engine";
import type { Shape, Tone } from "../detect/types";
import {
  createDrawing,
  hitTest,
  indexAtTime,
  timeAtIndex,
  magnetPrice,
  moveAnchor,
  moveDrawing,
  toShapes,
  visibleOn,
  ANCHOR_COUNT,
  type Drawing,
  type DrawKind,
  type Projector,
} from "../draw/model";
import type { DrawingStore } from "../draw/store";

export interface DrawingLayerOptions {
  readonly host: HTMLElement;
  readonly chart: () => ChartEngine | null;
  readonly store: DrawingStore;
  readonly symbol: () => string;
  readonly timeframe: () => string;
  /** Armed tool, or null for select mode. */
  readonly tool: Signal<DrawKind | null>;
  readonly magnet: Signal<boolean>;
  readonly tone: Signal<Tone>;
  /** Called when a drawing is completed, so the toolbar can disarm. */
  onFinish?(): void;
}

export interface DrawingLayer {
  /** Shapes to merge into the chart's annotation list. */
  shapes(): Shape[];
  readonly selected: Signal<string | null>;
  /** Bumped whenever the in-progress drawing changes, to trigger a repaint. */
  readonly draft: Signal<number>;
  deleteSelected(): void;
  dispose(): void;
}

/** Magnet snaps within this fraction of the visible price range. */
const MAGNET_FRACTION = 0.004;

export function createDrawingLayer(opts: DrawingLayerOptions): DrawingLayer {
  const selected = signal<string | null>(null);
  const draft = signal(0);

  /** Anchors placed so far for the drawing being created. */
  let pending: { kind: DrawKind; anchors: { t: number; p: number }[] } | null = null;
  /** The live second anchor, following the cursor before the click lands. */
  let ghost: { t: number; p: number } | null = null;

  let drag:
    | { id: string; mode: "body"; lastT: number; lastP: number }
    | { id: string; mode: "anchor"; index: number }
    | null = null;

  const handles = h("div", {
    class: "draw-handles",
    style: "position:absolute;inset:0;pointer-events:none;",
  });
  opts.host.appendChild(handles);

  /* ------------------------------------------------------- coordinates -- */

  /**
   * The bar times, bounded to the bars that EXIST.
   *
   * `Series` pre-allocates its Float64Arrays, so `series.t.length` is the
   * CAPACITY (4096) and not the number of loaded bars (802). Handing the raw
   * array to `timeAtIndex` made it read three thousand trailing zeros as real
   * timestamps: the spacing came out negative, and the second anchor of every
   * drawing was stored with `t: 0` and rendered tens of thousands of pixels off
   * screen. `subarray` is a view, not a copy, so this costs nothing per call.
   */
  const barTimes = (): Float64Array => {
    const chart = opts.chart();
    if (!chart) return new Float64Array(0);
    return chart.series.t.subarray(0, chart.series.length);
  };

  const projector = (): Projector | null => {
    const chart = opts.chart();
    if (!chart) return null;
    const vp = chart.viewport;
    const times = barTimes();
    return {
      x: (t) => vp.xCenterOf(indexAtTime(times, t)),
      y: (p) => vp.yOf(p),
    };
  };

  /** Pointer position to market space, with the magnet applied if it is on. */
  const toMarket = (e: PointerEvent): { t: number; p: number } | null => {
    const chart = opts.chart();
    if (!chart) return null;
    const rect = opts.host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const vp = chart.viewport;
    const index = vp.indexAtX(x);
    let price = vp.priceAtY(y);

    if (opts.magnet()) {
      const s = chart.series;
      const n = s.length;
      const i = Math.round(index);
      if (i >= 0 && i < n) {
        /* Tolerance in PRICE, derived from the visible range, so the magnet
           feels the same at every zoom level rather than getting stickier as
           you zoom in. */
        const span = Math.abs(vp.priceAtY(0) - vp.priceAtY(rect.height));
        price = magnetPrice(
          [{ t: s.t[i] as number, o: s.o[i] as number, h: s.h[i] as number, l: s.l[i] as number, c: s.c[i] as number }],
          0,
          price,
          span * MAGNET_FRACTION,
        );
      }
    }

    return { t: timeAtIndex(barTimes(), index), p: price };
  };

  /* ------------------------------------------------------------ shapes -- */

  function shapes(): Shape[] {
    const chart = opts.chart();
    if (!chart) return [];
    const times = barTimes();
    const out: Shape[] = [];

    for (const d of visibleOn(opts.store.all(), opts.symbol(), opts.timeframe())) {
      out.push(...toShapes(d, times));
    }

    /* The drawing being created, following the cursor. Rendered through the
       same path so what you see while placing is exactly what you get. */
    if (pending && ghost) {
      const anchors = [...pending.anchors, ghost].slice(0, ANCHOR_COUNT[pending.kind]);
      if (anchors.length === ANCHOR_COUNT[pending.kind]) {
        out.push(
          ...toShapes(
            createDrawing(pending.kind, anchors, {
              symbol: opts.symbol(),
              timeframe: opts.timeframe(),
              tone: opts.tone(),
            }),
            times,
          ),
        );
      }
    }

    return out;
  }

  /* ----------------------------------------------------------- handles -- */

  let handleFrame: (() => void) | null = null;

  function paintHandles(): void {
    const id = selected();
    const proj = projector();
    handles.textContent = "";
    if (!id || !proj) return;

    const d = opts.store.all().find((x) => x.id === id);
    if (!d || d.locked === true) return;
    /* Horizontal and vertical lines expose no handles — their second
       coordinate does not exist. See the note in draw/model.ts. */
    if (d.kind === "hline" || d.kind === "vline") return;

    d.anchors.forEach((a, i) => {
      const x = proj.x(a.t);
      const y = proj.y(a.p);
      handles.appendChild(
        h("div", {
          class: "draw-handle",
          "data-index": String(i),
          style: `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px`,
        }),
      );
    });
  }

  /** Keep handles glued to the chart while it pans, zooms or streams. */
  function trackHandles(): void {
    if (handleFrame) return;
    const tick = (): void => {
      handleFrame = null;
      paintHandles();
      if (selected() !== null) {
        handleFrame = scheduleFrame(tick);
      }
    };
    handleFrame = scheduleFrame(tick);
  }

  /* ------------------------------------------------------------ input --- */

  const hitAt = (e: PointerEvent): { drawing: Drawing; hit: NonNullable<ReturnType<typeof hitTest>> } | null => {
    const proj = projector();
    if (!proj) return null;
    const rect = opts.host.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const bounds = { width: rect.width, height: rect.height };

    /* Newest first: a drawing placed on top of another is the one you meant. */
    const list = visibleOn(opts.store.all(), opts.symbol(), opts.timeframe());
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i] as Drawing;
      const hit = hitTest(d, px, py, proj, bounds);
      if (hit) return { drawing: d, hit };
    }
    return null;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const armed = opts.tool();

    if (armed) {
      e.stopPropagation();
      e.preventDefault();
      const point = toMarket(e);
      if (!point) return;

      if (!pending) pending = { kind: armed, anchors: [] };
      pending.anchors.push(point);

      if (pending.anchors.length >= ANCHOR_COUNT[armed]) {
        const drawing = createDrawing(armed, pending.anchors, {
          symbol: opts.symbol(),
          timeframe: opts.timeframe(),
          tone: opts.tone(),
        });
        opts.store.add(drawing);
        pending = null;
        ghost = null;
        selected.set(drawing.id);
        trackHandles();
        opts.onFinish?.();
      }
      draft.update((n) => n + 1);
      return;
    }

    const found = hitAt(e);
    if (!found) {
      /* A press on empty chart clears the selection and is then LEFT ALONE, so
         it still pans the chart. */
      if (selected() !== null) selected.set(null);
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    selected.set(found.drawing.id);
    trackHandles();

    opts.store.begin();
    if (found.hit.kind === "anchor") {
      drag = { id: found.drawing.id, mode: "anchor", index: found.hit.index };
    } else {
      const point = toMarket(e);
      if (point) drag = { id: found.drawing.id, mode: "body", lastT: point.t, lastP: point.p };
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (pending) {
      ghost = toMarket(e);
      draft.update((n) => n + 1);
      return;
    }

    if (!drag) {
      /* Hover feedback only — never stop propagation here, or the crosshair
         dies wherever a drawing happens to be. */
      const found = hitAt(e);
      opts.host.style.cursor = found ? (found.hit.kind === "anchor" ? "grab" : "move") : "";
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    const point = toMarket(e);
    if (!point) return;

    const current = opts.store.all().find((x) => x.id === drag?.id);
    if (!current) return;

    if (drag.mode === "anchor") {
      opts.store.update(current.id, moveAnchor(current, drag.index, point));
    } else {
      opts.store.update(current.id, moveDrawing(current, point.t - drag.lastT, point.p - drag.lastP));
      drag.lastT = point.t;
      drag.lastP = point.p;
    }
    draft.update((n) => n + 1);
  };

  const onPointerUp = (): void => {
    if (drag) {
      /* Closes the batch opened on pointerdown, so the whole drag is ONE undo
         step rather than sixty. */
      opts.store.commit();
      drag = null;
      opts.host.style.cursor = "";
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && pending) {
      pending = null;
      ghost = null;
      draft.update((n) => n + 1);
      opts.onFinish?.();
    }
  };

  opts.host.addEventListener("pointerdown", onPointerDown, true);
  opts.host.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown);

  return {
    shapes,
    selected,
    draft,

    deleteSelected() {
      const id = selected.peek();
      if (!id) return;
      opts.store.remove(id);
      selected.set(null);
    },

    dispose() {
      opts.host.removeEventListener("pointerdown", onPointerDown, true);
      opts.host.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("keydown", onKeyDown);
      handleFrame?.();
      handles.remove();
    },
  };
}
