/**
 * The probability lattice, drawn.
 *
 * WHAT THE ANIMATION IS ALLOWED TO DO
 * Balls fall, land, and stack into the histogram their run already produced. The
 * animation is the only invented part — a ball's route down the pegs is fitted
 * to a destination the trade decided, never the other way round — and the module
 * that owns that distinction is `backtest/lattice.ts`, which says so in as many
 * words. This file paints it.
 *
 * IT STOPS WHEN IT IS FINISHED, AND WHEN NOBODY IS LOOKING
 * A perpetual animation on a trading screen is a battery drain and a distraction
 * competing with the thing it sits next to. This one runs while balls are still
 * falling and then holds the finished board. `IntersectionObserver` pauses it
 * off-screen and `visibilitychange` pauses it in a background tab, because the
 * terminal is normally one of thirty tabs and `requestAnimationFrame` in a
 * hidden tab is a promise the browser does not keep — the same trap
 * `ui/strategy.ts` documents about awaiting a frame that never comes.
 *
 * REDUCED MOTION IS HONOURED BY SHOWING THE ANSWER
 * `prefers-reduced-motion` does not mean "show less"; it means "do not move".
 * So the board is drawn complete and still. Nothing is withheld — the finished
 * histogram is the finding, and the falling is only how it is narrated.
 */

import { signal, renderEffect, type ReadSignal } from "../core/signal";
import { h, clear } from "./dom";
import { rng } from "../backtest/resample";
import {
  buildLattice,
  latticeNote,
  pathFor,
  EMPTY_LATTICE,
  type Lattice,
} from "../backtest/lattice";
import type { Trade } from "../backtest/engine";

export interface LatticeOptions {
  /** The run to drop. Rebuilding the board on change is the intended use. */
  trades: ReadSignal<readonly Trade[]>;
  /** Heading, so a caller can say which run this is. A plain getter is fine. */
  title?: () => string;
}

export interface LatticeHandle {
  el: HTMLElement;
  /** Drop the board again from empty. */
  replay(): void;
  destroy(): void;
}

/** Peg rows. Enough for a route to look plausible; not so many it is slow. */
const ROWS = 12;

/** Rows a ball descends per second. Fixed: it sets how a single ball reads. */
const SPEED = 9;

/**
 * How long the whole board takes to fill, however many trades there are.
 *
 * A FIXED RELEASE RATE DOES NOT SURVIVE A REAL RUN. At fourteen balls in flight
 * the first version took about six seconds for sixty-nine trades, which is
 * right — and the same arithmetic on a five-thousand-trade sweep is EIGHT
 * MINUTES of animation nobody will watch, on a card that pauses whenever it
 * scrolls off screen and would therefore never finish at all.
 *
 * So the rate is derived from the count instead: the board always takes about
 * this long, and a bigger run simply rains harder. That is also the more honest
 * picture — five thousand trades SHOULD look like a downpour beside sixty-nine.
 */
const TARGET_MS = 6_000;

/** Never slower than this, so a handful of trades still reads as falling. */
const MIN_PER_SECOND = 8;

/** Never denser than this: past it the board is a smear rather than balls. */
const MAX_IN_FLIGHT = 90;

interface Ball {
  /** Index into `lattice.order`. */
  readonly at: number;
  readonly path: number[];
  /** Rows travelled so far, fractional. */
  row: number;
}

const fmt = (n: number): string => n.toLocaleString();

export function createLattice(opts: LatticeOptions): LatticeHandle {
  const canvas = h("canvas", { class: "lat-canvas" }) as HTMLCanvasElement;
  const dropped = signal(0);
  const running = signal(false);

  /**
   * A SIGNAL, not a plain binding.
   *
   * It was a `let` first, and the rail read `lattice.trades` inside a text
   * binding. That binding therefore subscribed to NOTHING, rendered once at
   * zero, and never updated again — the board animated correctly while the
   * counters beside it insisted there were no trades. A value the view reads has
   * to be reactive or the view is a snapshot of the moment it was built.
   */
  const board = signal<Lattice>(EMPTY_LATTICE);
  let flight: Ball[] = [];
  /** Landed count per bin — the histogram AS IT FILLS. */
  let landed: number[] = [];
  let cursor = 0;
  /** Fractional balls owed, so a rate below one per frame still releases. */
  let owed = 0;
  let raf = 0;
  let last = 0;
  let visible = true;
  let next = rng(0xba11);

  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------- painting ---

  const paint = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const hgt = canvas.clientHeight || 280;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const css = getComputedStyle(canvas);
    const v = (name: string, fb: string): string => css.getPropertyValue(name).trim() || fb;
    const up = v("--candle-up", "#2dbe8e");
    const down = v("--candle-down", "#f0616d");
    const faint = v("--text-faint", "#566072");
    const muted = v("--text-muted", "#7a8494");
    const hair = v("--border-hair", "rgba(255,255,255,.08)");

    const l = board.peek();
    const bins = l.bins.length;
    if (bins === 0) return;

    const padL = 8;
    const padR = 8;
    const axisH = 16;
    const plotW = w - padL - padR;
    const binW = plotW / bins;
    /* The board is the top 45%, the histogram the rest. A board taller than its
       result would make the falling the subject. */
    const boardH = Math.round((hgt - axisH) * 0.45);
    const histH = hgt - axisH - boardH;
    const xOf = (bin: number): number => padL + (bin + 0.5) * binW;

    // --- pegs -------------------------------------------------------------
    ctx.fillStyle = hair;
    for (let row = 1; row <= ROWS; row++) {
      const y = (row / (ROWS + 1)) * boardH;
      const count = row + 1;
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const x = padL + plotW * (0.5 + (t - 0.5) * (row / ROWS) * 0.92);
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- the break-even line, through both halves -------------------------
    const beX = padL + (l.breakEvenBin + 0) * binW;
    ctx.strokeStyle = faint;
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(Math.round(beX) + 0.5, 0);
    ctx.lineTo(Math.round(beX) + 0.5, hgt - axisH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // --- histogram --------------------------------------------------------
    const peak = Math.max(1, l.peak);
    for (let i = 0; i < bins; i++) {
      const n = landed[i] ?? 0;
      if (n === 0) continue;
      const bin = l.bins[i];
      if (!bin) continue;
      const barH = Math.max(1, (n / peak) * (histH - 4));
      const x = padL + i * binW + 1;
      const y = hgt - axisH - barH;
      ctx.fillStyle = bin.winning ? up : down;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, y, binW - 2, barH);
      ctx.globalAlpha = 1;
    }

    // --- balls in flight --------------------------------------------------
    for (const ball of flight) {
      const i = Math.min(ball.path.length - 1, Math.floor(ball.row));
      const frac = ball.row - i;
      const a = ball.path[i] ?? 0;
      const b = ball.path[Math.min(ball.path.length - 1, i + 1)] ?? a;
      const bin = a + (b - a) * frac;
      const x = xOf(bin);
      const y = (ball.row / (ROWS + 1)) * boardH;
      const r = l.order[ball.at] ?? 0;
      ctx.fillStyle = r >= 0 ? up : down;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- axis -------------------------------------------------------------
    ctx.font = `10px ${v("--font-mono", "ui-monospace, monospace")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = muted;
    for (let i = 0; i < bins; i++) {
      const bin = l.bins[i];
      if (!bin) continue;
      /* Only the landmarks are labelled. Eleven labels across a narrow card is
         a wall of type; "stop", break-even and the far tail are the three a
         reader actually navigates by. */
      const label = bin.label === "stop" ? "stop" : i === l.breakEvenBin ? "0R" : i === bins - 1 ? bin.label : "";
      if (label === "") continue;
      const x = xOf(i);
      if (x - 18 < padL || x + 18 > w - padR) continue;
      ctx.fillText(label, x, hgt - axisH + 3);
    }
  };

  // ------------------------------------------------------------ animation ---

  const step = (now: number): void => {
    raf = 0;
    const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;

    const l = board.peek();
    const perSecond = Math.max(MIN_PER_SECOND, l.trades / (TARGET_MS / 1000));
    owed += dt * perSecond;
    while (owed >= 1 && flight.length < MAX_IN_FLIGHT && cursor < l.order.length) {
      const bin = l.lands[cursor] ?? 0;
      flight.push({ at: cursor, path: pathFor(bin, ROWS, l.bins.length, next), row: 0 });
      cursor++;
      owed -= 1;
    }
    /* Do not bank a backlog while the card is off screen or the tab is hidden:
       coming back would dump hundreds of balls in one frame. */
    if (owed > MAX_IN_FLIGHT) owed = MAX_IN_FLIGHT;

    const still: Ball[] = [];
    for (const ball of flight) {
      ball.row += dt * SPEED;
      if (ball.row >= ROWS) {
        const bin = l.lands[ball.at] ?? 0;
        landed[bin] = (landed[bin] ?? 0) + 1;
        dropped.set(dropped.peek() + 1);
      } else still.push(ball);
    }
    flight = still;

    paint();

    if (flight.length > 0 || cursor < l.order.length) schedule();
    else running.set(false);
  };

  const schedule = (): void => {
    if (raf !== 0 || !visible || document.hidden) return;
    raf = requestAnimationFrame(step);
  };

  const finishInstantly = (): void => {
    const l = board.peek();
    landed = l.bins.map((b) => b.count);
    dropped.set(l.trades);
    cursor = l.order.length;
    flight = [];
    running.set(false);
    paint();
  };

  const start = (): void => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    landed = new Array<number>(board.peek().bins.length).fill(0);
    flight = [];
    cursor = 0;
    owed = 0;
    last = 0;
    dropped.set(0);
    next = rng(0xba11);

    if (reduced || board.peek().trades === 0) {
      finishInstantly();
      return;
    }
    running.set(true);
    schedule();
  };

  // ------------------------------------------------------------ lifecycle ---

  renderEffect(() => {
    board.set(buildLattice([...opts.trades()]));
    start();
  });

  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((e) => e.isIntersecting);
          if (visible) {
            last = 0;
            schedule();
          }
        })
      : null;
  io?.observe(canvas);

  const onVisibility = (): void => {
    if (!document.hidden) {
      last = 0;
      schedule();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  const ro =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => paint()) : null;
  ro?.observe(canvas);

  // ----------------------------------------------------------------- view ---

  const stat = (label: string, value: () => string, tone?: () => string): HTMLElement =>
    h(
      "div",
      { class: "lat-stat", ...(tone ? { "data-tone": tone } : {}) },
      h("span", { class: "lat-stat-k", text: label }),
      h("span", { class: "lat-stat-v num", text: value }),
    );

  const el = h(
    "section",
    { class: "panel span-all lat" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: () => opts.title?.() ?? "Probability lattice" }),
      h("span", {
        class: "chip",
        text: () => (running() ? "dropping…" : `${fmt(board().trades)} trades`),
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("p", {
        class: "muted small lat-lede",
        text: "One ball per trade, landing in the bin its own result belongs to. The bin is data; the bounce is animation.",
      }),
      h(
        "div",
        { class: "lat-grid" },
        h(
          "div",
          { class: "lat-rail" },
          stat("Dropped", () => fmt(dropped())),
          stat("Of", () => fmt(board().trades)),
          stat(
            "Landed right",
            () => (dropped() === 0 ? "—" : `${((landedWinning() / dropped()) * 100).toFixed(1)}%`),
          ),
          stat(
            "Expectancy",
            () => `${board().expectancyR >= 0 ? "+" : ""}${board().expectancyR.toFixed(2)}R`,
            () => (board().expectancyR > 0 ? "pos" : board().expectancyR < 0 ? "neg" : ""),
          ),
        ),
        canvas,
      ),
      h("p", { class: "lat-note", text: () => latticeNote(board()) }),
    ),
  ) as HTMLElement;

  /** Balls that have landed at or above break-even, so far. */
  function landedWinning(): number {
    let n = 0;
    for (let i = 0; i < landed.length; i++) {
      if (board.peek().bins[i]?.winning) n += landed[i] ?? 0;
    }
    return n;
  }

  return {
    el,
    replay: start,
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      clear(el);
      el.remove();
    },
  };
}
