/**
 * The workspace renderer — many live charts, one screen.
 *
 * Each pane owns a ChartEngine AND its own feed. They share one archive and one
 * request governor, so four panes on four timeframes of the same instrument
 * cost four cache lookups and, usually, zero network requests: the bars are
 * already local and the governor de-duplicates whatever is not.
 *
 * WHY PER-PANE FEEDS RATHER THAN ONE SHARED ONE
 * Because the panes are showing different things. A shared feed would have to
 * be the union of every pane's subscription, and every pane would then re-derive
 * its own slice — which is the same work, plus a synchronisation bug waiting to
 * happen when two panes want the same symbol at different timeframes.
 *
 * WHAT MAKES THIS DIFFERENT FROM A TILED MDI WINDOW MANAGER
 * Link groups. A pane wears a colour, and changing the symbol in one moves every
 * pane wearing the same colour. Four timeframes of one instrument that follow
 * you when you switch instruments — without four symbol boxes to keep in sync
 * by hand, and with a deliberately unlinked pane able to stay put while the rest
 * of the desk moves. See core/workspace.ts.
 *
 * RECONCILIATION IS BY PANE ID. A layout change rebuilds only the panes whose
 * ids appeared or vanished; everything else keeps its canvas, its GPU context
 * and its loaded history. Rebuilding the tree wholesale on every split would
 * re-download every series on screen.
 */

import { h } from "./dom";
import { effect, renderEffect, untrack, type Signal } from "../core/signal";
import { ChartEngine, themeFromCss, type ChartKind, type LineOverlay } from "../chart/engine";
import { ema } from "../chart/indicators";
import { createFeed, type FeedHandle } from "../data/feed";
import type { BarArchive } from "../store/barstore";
import type { BarView } from "../chart/series";
import { runDetectors, toDetectInput, type DetectorId } from "../detect";
import { detectHigher } from "../detect/mtf";
import {
  geometry,
  panes as listPanes,
  type LayoutNode,
  type PaneNode,
  type SplitPath,
} from "../core/workspace";

export interface PaneRuntime {
  readonly id: string;
  readonly feed: FeedHandle;
  readonly chart: ChartEngine | null;
  readonly el: HTMLElement;
  /**
   * Construct the canvas. Called by the reconciler AFTER the element is in the
   * document: ChartEngine measures its host on construction, and a host that
   * has not been laid out measures 0x0 — producing a zero-size canvas that
   * never recovers until something else forces a resize.
   */
  mount(): void;
  dispose(): void;
}

export interface WorkspaceOptions {
  readonly layout: Signal<LayoutNode>;
  readonly activePaneId: Signal<string>;
  readonly archive: BarArchive;
  /** Read so the canvases re-theme when the palette changes. */
  readonly theme: Signal<string>;
  readonly chartKind: Signal<ChartKind>;
  readonly mas: Signal<string[]>;
  readonly detectors: Signal<DetectorId[]>;
  readonly htf: Signal<string[]>;
  /** How many bars each pane loads. */
  readonly barLimit?: number;
  /** Offered in each pane's own timeframe menu. */
  readonly timeframes: readonly string[];
  onSetRatio(path: SplitPath, ratio: number): void;
  onClosePane(id: string): void;
  onSplitPane(id: string, dir: "row" | "col"): void;
  onCyclePaneLink(id: string): void;
  /** Sets ONE pane's timeframe. Never travels down the link channel. */
  onSetPaneTimeframe(id: string, timeframe: string): void;
  onPaneContextMenu(id: string, at: { x: number; y: number }): void;
}

export interface WorkspaceView {
  readonly el: HTMLElement;
  /** The live runtime for a pane, for the shell to read the active one. */
  runtime(id: string): PaneRuntime | undefined;
  /** Every series key currently on screen, so retention can pin them. */
  liveSeries(): string[];
  dispose(): void;
}

/** Moving averages, mirrored from the shell's set so panes agree with it. */
const MA_SET = [
  { id: "ema20", period: 20, token: "--accent" },
  { id: "ema50", period: 50, token: "--attn" },
  { id: "ema200", period: 200, token: "--alt" },
] as const;

/**
 * Structures drawn per pane, per kind.
 *
 * Lower than the single-chart view's caps on purpose: a quarter-size pane with
 * the same number of annotations is not a quarter as readable, it is unreadable.
 */
const PANE_DRAW_CAP = 3;

const fmtPrice = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export function createWorkspace(opts: WorkspaceOptions): WorkspaceView {
  const root = h("div", { class: "ws" });
  const runtimes = new Map<string, PaneRuntime>();
  const barLimit = opts.barLimit ?? 800;
  let disposed = false;

  /**
   * A pane's timeframe picker.
   *
   * Deliberately not `openMenu`: that wants the command registry's context, and
   * a pane header should not have to know the registry exists to offer six
   * buttons. Deliberately not a `<select>` either — a native dropdown inside a
   * header strip renders at the OS's size and breaks the row on Windows.
   *
   * Closes on outside pointerdown and on Escape, and the listener is torn down
   * with the popover rather than living for the life of the pane.
   */
  function paneTimeframeMenu(paneId: string): HTMLElement {
    const pop = h("div", { class: "ws-tf-pop", role: "menu" }) as HTMLElement;
    pop.hidden = true;

    const btn = h(
      "button",
      {
        class: "ws-tf",
        type: "button",
        title: "Timeframe — this pane only",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        text: () => currentSpec(paneId).timeframe,
        onclick: (e: Event) => {
          e.stopPropagation();
          setOpen(pop.hidden);
        },
      },
    ) as HTMLButtonElement;

    let offOutside: (() => void) | null = null;

    const setOpen = (next: boolean): void => {
      pop.hidden = !next;
      btn.setAttribute("aria-expanded", String(next));
      offOutside?.();
      offOutside = null;
      if (!next) return;

      const onDown = (ev: Event): void => {
        if (!pop.contains(ev.target as Node) && ev.target !== btn) setOpen(false);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          setOpen(false);
          btn.focus();
        }
      };
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      offOutside = () => {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    };

    for (const tf of opts.timeframes) {
      pop.appendChild(
        h("button", {
          class: "ws-tf-opt",
          type: "button",
          role: "menuitem",
          text: tf,
          "aria-checked": () => String(currentSpec(paneId).timeframe === tf),
          "data-on": () => String(currentSpec(paneId).timeframe === tf),
          onclick: (e: Event) => {
            e.stopPropagation();
            opts.onSetPaneTimeframe(paneId, tf);
            setOpen(false);
          },
        }),
      );
    }

    return h("span", { class: "ws-tf-wrap" }, btn, pop) as HTMLElement;
  }

  function buildPane(pane: PaneNode): PaneRuntime {
    const feed = createFeed({ archive: opts.archive });
    let chart: ChartEngine | null = null;

    const host = h("div", { class: "ws-canvas" });
    const empty = h("div", { class: "ws-empty", text: "Loading…" });

    const el = h(
      "div",
      {
        class: "ws-pane",
        "data-pane": pane.id,
        onpointerdown: () => opts.activePaneId.set(pane.id),
        oncontextmenu: (e: Event) => {
          const ev = e as MouseEvent;
          ev.preventDefault();
          opts.activePaneId.set(pane.id);
          opts.onPaneContextMenu(pane.id, { x: ev.clientX, y: ev.clientY });
        },
      },
      h(
        "div",
        { class: "ws-head" },
        h("button", {
          class: "ws-link",
          type: "button",
          title: "Link channel — panes sharing a colour follow each other",
          "data-link": () => currentSpec(pane.id).link,
          onclick: (e: Event) => {
            e.stopPropagation();
            opts.onCyclePaneLink(pane.id);
          },
        }),
        h("span", { class: "ws-sym", text: () => currentSpec(pane.id).symbol }),

        /**
         * The pane's own timeframe, as a control rather than a caption.
         *
         * It used to be a `<span>` — the timeframe was displayed here and
         * changeable only from the topbar, which wrote through the link
         * channel and so moved every pane at once. Between that and
         * `applyLink`, a four-pane desk had exactly one timeframe and no
         * control anywhere that could give a single pane a different one.
         * This is that control, and it writes to this pane alone.
         */
        paneTimeframeMenu(pane.id),
        h("span", { class: "ws-feed", "data-feed": () => feed.state().quality, title: () => feed.state().note }),
        h("span", {
          class: "ws-last",
          text: () => {
            const list = feed.bars();
            const last = list[list.length - 1];
            return last ? fmtPrice(last.c) : "—";
          },
        }),
        h("span", { class: "ws-head-spacer" }),
        h("button", {
          class: "ws-btn",
          type: "button",
          title: "Split right",
          text: "◫",
          onclick: (e: Event) => {
            e.stopPropagation();
            opts.onSplitPane(pane.id, "row");
          },
        }),
        h("button", {
          class: "ws-btn",
          type: "button",
          title: "Split down",
          text: "⊟",
          onclick: (e: Event) => {
            e.stopPropagation();
            opts.onSplitPane(pane.id, "col");
          },
        }),
        h("button", {
          class: "ws-btn",
          type: "button",
          title: "Close pane",
          text: "✕",
          onclick: (e: Event) => {
            e.stopPropagation();
            opts.onClosePane(pane.id);
          },
        }),
      ),
      h("div", { class: "ws-body" }, host, empty),
    );

    /* --- data ------------------------------------------------------------ */

    let loadToken = 0;
    const load = async (): Promise<void> => {
      const spec = currentSpec(pane.id);
      const token = ++loadToken;
      empty.setAttribute("data-show", "true");
      empty.textContent = "Loading…";
      const ok = await feed.loadSymbol(spec.symbol, spec.timeframe, barLimit);
      /* A pane whose symbol changed twice quickly must not have the first
         load's stream started under the second load's symbol. */
      if (token !== loadToken || disposed) return;
      if (ok) feed.startLive(spec.symbol, spec.timeframe);
      else feed.stopLive();
      empty.setAttribute("data-show", String(feed.bars().length === 0));
      if (feed.bars().length === 0) empty.textContent = "No data for this symbol.";
    };

    effect(() => {
      const spec = currentSpec(pane.id);
      /* Read both so either change reloads. */
      void spec.symbol;
      void spec.timeframe;
      void load();
    });

    /* --- painting -------------------------------------------------------- */

    renderEffect(() => {
      opts.theme();
      if (!chart) return;
      queueMicrotask(() => chart?.setTheme(themeFromCss()));
    });

    renderEffect(() => {
      chart?.setKind(opts.chartKind());
    });

    renderEffect(() => {
      const series = feed.bars();
      if (!chart) return;
      const wasEmpty = chart.series.length === 0;
      chart.series.reset(series);
      if (wasEmpty) chart.goLive();
      else chart.invalidate();
      empty.setAttribute("data-show", String(series.length === 0));
    });

    renderEffect(() => {
      const series = feed.bars();
      const selected = opts.mas();
      opts.theme();
      if (!chart) return;
      if (series.length === 0) {
        chart.setOverlays([]);
        return;
      }
      const close = Float64Array.from(series, (b: BarView) => b.c);
      const css = getComputedStyle(document.documentElement);
      const overlays: LineOverlay[] = [];
      for (const ma of MA_SET) {
        if (!selected.includes(ma.id)) continue;
        overlays.push({
          id: ma.id,
          values: ema(close, ma.period),
          color: css.getPropertyValue(ma.token).trim() || "#4C82FB",
        });
      }
      chart.setOverlays(overlays);
    });

    /**
     * Structures, per pane.
     *
     * Only CLOSED bars are fed in — the forming bar's "close" is the current
     * price, and a detector confirming a break on it registers a break that
     * un-registers when the bar closes lower. Same firewall as the main chart.
     */
    renderEffect(() => {
      const series = feed.bars();
      const enabled = opts.detectors();
      const higher = opts.htf();
      if (!chart) return;

      const closed = Math.max(0, series.length - 1);
      if (closed < 30 || enabled.length === 0) {
        chart.setAnnotations([]);
        return;
      }

      const data = toDetectInput(series.slice(0, closed));
      const found = runDetectors(data, enabled);
      for (const tf of higher) found.push(...detectHigher(data, tf, enabled));

      const perKind = new Map<string, number>();
      const keep: typeof found = [];
      for (let i = found.length - 1; i >= 0; i--) {
        const d = found[i];
        if (!d) continue;
        const used = perKind.get(d.kind) ?? 0;
        if (used >= PANE_DRAW_CAP) continue;
        perKind.set(d.kind, used + 1);
        keep.push(d);
      }
      chart.setAnnotations(keep.flatMap((d) => d.shapes));
    });

    return {
      id: pane.id,
      feed,
      get chart() {
        return chart;
      },
      el,
      mount() {
        if (chart || disposed) return;
        chart = new ChartEngine(host, themeFromCss());
      },
      dispose() {
        /* Bump the token so a load still in flight cannot start a stream on a
           pane that no longer exists. */
        loadToken++;
        feed.dispose();
        chart?.dispose();
        chart = null;
        el.remove();
      },
    };
  }

  /** The current spec for a pane, read reactively from the layout signal. */
  function currentSpec(id: string): PaneNode {
    const found = listPanes(opts.layout()).find((p) => p.id === id);
    /* A pane being torn down can render one last time after its id has left
       the layout. Returning a placeholder is better than throwing inside a
       render effect, which would leave the DOM half-updated. */
    return found ?? { kind: "leaf", id, content: "chart", symbol: "—", timeframe: "—", link: "none" };
  }

  /* ------------------------------------------------------- reconciliation */

  renderEffect(() => {
    const layout = opts.layout();
    const geo = geometry(layout);
    const wanted = new Set(geo.panes.map((p) => p.id));

    /* Remove what is gone. Disposing frees the socket and the canvas context;
       leaving them would keep a closed pane streaming for the session. */
    for (const [id, rt] of runtimes) {
      if (!wanted.has(id)) {
        rt.dispose();
        runtimes.delete(id);
      }
    }

    /* Add what is new, and position everything. */
    for (const rect of geo.panes) {
      let rt = runtimes.get(rect.id);
      if (!rt) {
        const spec = listPanes(layout).find((p) => p.id === rect.id);
        if (!spec) continue;
        rt = untrack(() => buildPane(spec));
        runtimes.set(rect.id, rt);
        root.appendChild(rt.el);
        rt.mount();
      }
      const el = rt.el;
      el.style.left = `${(rect.x * 100).toFixed(4)}%`;
      el.style.top = `${(rect.y * 100).toFixed(4)}%`;
      el.style.width = `${(rect.w * 100).toFixed(4)}%`;
      el.style.height = `${(rect.h * 100).toFixed(4)}%`;
    }

    /* Splitters are rebuilt rather than reconciled: there are at most a handful
       and they hold no state worth preserving between layouts. */
    for (const old of Array.from(root.querySelectorAll(".ws-splitter"))) old.remove();
    for (const s of geo.splitters) {
      const el = h("div", {
        class: "ws-splitter",
        "data-dir": s.dir,
        style:
          s.dir === "row"
            ? `left:${(s.x * 100).toFixed(4)}%;top:${(s.y * 100).toFixed(4)}%;height:${(s.h * 100).toFixed(4)}%`
            : `left:${(s.x * 100).toFixed(4)}%;top:${(s.y * 100).toFixed(4)}%;width:${(s.w * 100).toFixed(4)}%`,
        onpointerdown: (e: Event) => startDrag(e as PointerEvent, s.path, s.dir),
      });
      root.appendChild(el);
    }
  });

  /* Highlight the active pane. Separated from the layout effect so moving the
     focus between panes does not touch geometry at all. */
  renderEffect(() => {
    const active = opts.activePaneId();
    for (const [id, rt] of runtimes) rt.el.setAttribute("data-active", String(id === active));
  });

  /* ------------------------------------------------------------- dragging */

  /**
   * The rectangle a split node occupies, as fractions of the workspace.
   *
   * Walking the path down from the root, applying each ancestor's ratio on its
   * own axis. This is the same arithmetic `geometry()` does; it is repeated here
   * because a drag needs the box of ONE split rather than every pane.
   */
  function splitRect(node: LayoutNode, path: SplitPath): { x: number; y: number; w: number; h: number } {
    let x = 0;
    let y = 0;
    let w = 1;
    let h = 1;
    let current: LayoutNode = node;
    for (const step of path) {
      if (current.kind !== "split") break;
      if (current.dir === "row") {
        const aw = w * current.ratio;
        if (step === "a") {
          w = aw;
          current = current.a;
        } else {
          x += aw;
          w -= aw;
          current = current.b;
        }
      } else {
        const ah = h * current.ratio;
        if (step === "a") {
          h = ah;
          current = current.a;
        } else {
          y += ah;
          h -= ah;
          current = current.b;
        }
      }
    }
    return { x, y, w, h };
  }

  function startDrag(e: PointerEvent, path: SplitPath, dir: "row" | "col"): void {
    e.preventDefault();
    /* The splitter sits over the panes; without this the press also selects
       whichever pane happens to be under the seam. */
    e.stopPropagation();

    const box = root.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setAttribute("data-dragging", "true");
    root.setAttribute("data-dragging", "true");
    target.setPointerCapture?.(e.pointerId);

    /**
     * The ratio is LOCAL to its own split, but the pointer is global. Without
     * converting through the split's own box, a nested splitter would be driven
     * by a fraction of the whole surface and would jump to an edge on the first
     * pixel of movement.
     *
     * The box is captured once: it cannot change mid-drag, and re-measuring per
     * pointermove would force a layout on every frame of the drag.
     */
    const rect = splitRect(opts.layout.peek(), path);

    const onMove = (ev: PointerEvent): void => {
      const local =
        dir === "row"
          ? rect.w > 0
            ? ((ev.clientX - box.left) / box.width - rect.x) / rect.w
            : 0.5
          : rect.h > 0
            ? ((ev.clientY - box.top) / box.height - rect.y) / rect.h
            : 0.5;
      /* Clamping lives in the model (clampRatio), so a wild pointer cannot
         produce a pane too thin to draw an axis in. */
      opts.onSetRatio(path, local);
    };

    const onUp = (): void => {
      target.removeAttribute("data-dragging");
      root.removeAttribute("data-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    /* pointercancel fires when the browser takes the pointer away — a touch
       becoming a scroll, a window losing focus mid-drag. Without it the move
       listener stays attached and the splitter follows the cursor for ever. */
    window.addEventListener("pointercancel", onUp);
  }

  return {
    el: root,
    runtime: (id) => runtimes.get(id),
    liveSeries() {
      const out: string[] = [];
      for (const [id] of runtimes) {
        const spec = listPanes(opts.layout.peek()).find((p) => p.id === id);
        if (spec) out.push(`${spec.symbol}|${spec.timeframe}`);
      }
      return out;
    },
    dispose() {
      disposed = true;
      for (const rt of runtimes.values()) rt.dispose();
      runtimes.clear();
    },
  };
}
