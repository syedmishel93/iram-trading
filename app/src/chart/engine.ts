/**
 * Chart engine — layered canvas renderer.
 *
 * LAYERS (the central performance decision)
 *   base    grid, candles, volume, axes   — repainted only when data or
 *                                           viewport actually change
 *   overlay crosshair, cursor readouts    — repainted on pointer move
 *
 * Mouse movement is the highest-frequency event in the app. With one canvas,
 * every pixel of pointer travel repaints thousands of candles; that is why the
 * v39 chart felt heavy under the crosshair. Splitting the layers makes a
 * crosshair move cost two thin strokes regardless of how many bars are loaded.
 *
 * Everything is scheduled through a single rAF: N invalidations inside one
 * frame produce exactly one paint.
 */

import { formatRelative, relativeVolume, volumeScale } from "./volscale";
import { scheduleFrame } from "../core/frame";
import { Series, type BarView } from "./series";
import { Viewport, clamp, priceTicksFor, type PriceScale } from "./viewport";
import { anchorShift, needsOlderBars } from "./anchor";
import type { Shape, Tone } from "../detect/types";
import { fitPanes, paneRange, panesHeight, type PaneSpec } from "./panes";

export interface ChartTheme {
  /** Plot background. The base layer is opaque, so it must paint this itself. */
  bg: string;
  text: string;
  textMuted: string;
  textFaint: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  upWash: string;
  downWash: string;
  accent: string;
  surface: string;
  crosshair: string;
  fontMono: string;
  /**
   * How the grid is drawn when it is drawn at all — `"lines"` or `"dots"`.
   *
   * Whether there is a grid remains `setGrid`, because that is an operator
   * switch the shell already owns; this is only its dialect. Two facts, two
   * owners, one control in Settings writing both.
   */
  gridStyle: string;
  /** Wick stroke width in CSS pixels. 1 is what the terminal has always drawn. */
  wick: number;
}

export type ChartKind = "candles" | "hollow" | "heikin" | "bars" | "line" | "area";

/**
 * A line plotted in price space, index-aligned to the series.
 *
 * `values` must be the same length as the series, with NaN in the warm-up
 * region — the contract every function in indicators.ts obeys. Same length
 * means no offset arithmetic here, and NaN means a gap is drawn as a gap
 * instead of a line sloping in from zero.
 */
export interface LineOverlay {
  id: string;
  values: Float64Array;
  color: string;
  width?: number;
  dash?: number[];
}

export interface CursorState {
  x: number;
  y: number;
  index: number;
  price: number;
  inside: boolean;
}

/**
 * The live bar's countdown, rendered on the price axis under the last price.
 *
 * WHY IT MOVED HERE FROM THE STATUS BAR
 * The countdown answers "how long do I have", and the only place that question
 * is ever asked is while looking at the newest candle. It was in the bottom
 * status strip, 700px away from the thing it describes and in the same row as
 * six other figures, so reading it meant leaving the price you were reading it
 * about. Every terminal that has solved this puts it against the axis.
 *
 * `tone` is not decoration. `countdown()` distinguishes counting, due, late,
 * closed and mis-stamped, and a tag that rendered all five in the same colour
 * would put "late 4m" — a stopped feed — in the same visual weight as "0:37".
 */
export interface CountdownTag {
  readonly text: string;
  readonly tone: "live" | "warn" | "mute";
}

/**
 * The next bar's forecast range, drawn in the space right of the newest bar.
 *
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
 * It is an interval on the next CLOSE, from the volatility model in
 * analysis/forecast.ts, at a stated confidence. It is NOT a direction call.
 * The box is symmetric about the last price by construction and has no upper
 * or lower bias to read, because the model that produces it forecasts the size
 * of the next move and says nothing whatsoever about its sign.
 *
 * That is the whole reason it can be drawn at all. A shaded cone leaning
 * upward would be a direction call wearing an interval's clothes, and one bar
 * ahead is the horizon where a direction call is least defensible.
 *
 * `calibrated` is what keeps it honest on screen: the model replays itself
 * over the loaded history and reports how often the interval actually
 * contained the outcome. When that check fails, the band is drawn in the muted
 * colour and the axis label says so, rather than being drawn identically to a
 * band that has passed.
 */
export interface Projection {
  readonly low: number;
  readonly high: number;
  /** Nominal confidence, 0..1 — what the interval CLAIMS to contain. */
  readonly confidence: number;
  /** Whether the replay says the claim holds. False draws it muted. */
  readonly calibrated: boolean;
}

/**
 * Heikin-Ashi bars for `[from, to)`, seeded from the bar before `from`.
 *
 *   close = (o + h + l + c) / 4          — the bar's own average
 *   open  = (prevOpen + prevClose) / 2   — the previous SMOOTHED bar
 *   high  = max(h, open, close)
 *   low   = min(l, open, close)
 *
 * The recursion in `open` is why this cannot be computed per visible bar and
 * why the caller passes one bar of lead-in: seeded from itself, the first
 * candle is always a doji, and it moves every time you pan.
 */
function heikinAshi(
  s: Series,
  from: number,
  to: number,
): Array<{ o: number; h: number; l: number; c: number }> {
  const out: Array<{ o: number; h: number; l: number; c: number }> = [];
  let prevO = NaN;
  let prevC = NaN;
  for (let i = from; i < to; i++) {
    const o = s.o[i] as number;
    const h = s.h[i] as number;
    const l = s.l[i] as number;
    const c = s.c[i] as number;
    const haC = (o + h + l + c) / 4;
    const haO = Number.isFinite(prevO) ? (prevO + prevC) / 2 : (o + c) / 2;
    out.push({ o: haO, h: Math.max(h, haO, haC), l: Math.min(l, haO, haC), c: haC });
    prevO = haO;
    prevC = haC;
  }
  return out;
}

/** One session's UTC window and the wash it is painted in. */
export interface SessionBand {
  readonly id: string;
  readonly openUtc: number;
  readonly closeUtc: number;
  /** Already at its final alpha — the engine does not decide how loud this is. */
  readonly colour: string;
}

/**
 * UTC hour of an epoch-millisecond timestamp, without allocating a Date.
 *
 * The band walk asks this once per visible bar per session — four bands over a
 * few hundred bars is well over a thousand `new Date()` objects for every
 * repaint of the base layer, to read one integer off each. Unix time is a count
 * of milliseconds since a Thursday midnight UTC with no leap seconds in it, so
 * the hour is arithmetic.
 */
function utcHour(t: number): number {
  return Math.floor(t / 3_600_000) % 24;
}

/**
 * Inside the window, handling the midnight wrap.
 *
 * The hour is normalised first, matching `sessionOpenAt` in `data/sessionmap.ts`
 * exactly. The two answer the same question for the same windows — one for the
 * Sessions desk, one for the chart's background — and they disagreed at the
 * edges: that one normalised and this one did not. `utcHour` keeps its result in
 * 0-23 for any real timestamp, so nothing was wrong on screen; two functions
 * with the same name for the same rule and different edge behaviour is a trap
 * left for whoever next passes an hour in from somewhere else.
 */
function hourInBand(h: number, openUtc: number, closeUtc: number): boolean {
  const hour = ((h % 24) + 24) % 24;
  return openUtc <= closeUtc
    ? hour >= openUtc && hour < closeUtc
    : hour >= openUtc || hour < closeUtc;
}

/** A structure label awaiting placement. The arrow is already drawn. */
interface MarkerLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly above: boolean;
  readonly colour: string;
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Reads the live CSS custom properties so the chart follows the app theme. */
/**
 * One time-axis label, given the label drawn before it.
 *
 * WHY A TICK LABEL NEEDS TO KNOW ITS PREDECESSOR.
 *
 * The axis used to format every intraday tick as a bare clock time. That is
 * right when the ticks are hours apart and badly wrong the moment they are not,
 * which on a full screen of history is most of the time: MEASURED at 800 hourly
 * bars, the tick stride is 48 bars — **two days** — so the axis read
 * "07:00 AM, 02:00 AM, 09:00 PM, 04:00 PM" with nothing anywhere saying that
 * each step crossed two midnights. Consecutive labels appear to run backwards,
 * and a time axis that appears to run backwards reads as a broken chart.
 *
 * So a label shows the DATE when it lands on a different day from the last one
 * drawn, and the TIME when it does not. At a two-day stride every label is a
 * date; at a six-hour stride the first tick of each day is a date and the rest
 * are times. That is what every chart the reader has used already does.
 *
 * `prev` is the previously DRAWN label's timestamp, not the previous tick's:
 * ticks that did not fit were never shown, so comparing against one would put a
 * date on a label whose day the reader never saw begin — or worse, omit one.
 *
 * Compared with `toDateString`, which is LOCAL, matching the local clock times
 * the labels themselves are formatted in. A UTC comparison would put the date
 * change in the wrong place for every reader west of Greenwich.
 */
export function axisTimeLabel(t: number, prev: number | null, spacing: number): string {
  const d = new Date(t);
  const intraday = spacing > 0 && spacing < 24 * 3600 * 1000;
  /*
   * THE YEAR, BY THE SAME RULE ONE LEVEL UP.
   *
   * A date label was `Sep 24` whatever year it fell in. The archive holds 1h
   * bars back to 2022 and daily back to 2021, so a chart scrolled back a year
   * showed exactly the string it shows for today, and NOTHING on screen could
   * tell them apart — the crosshair's intraday readout had no year either.
   * Reading the wrong year's session as this one is the same class of error as
   * the bars that were drawn in the wrong place: the picture is right and it
   * is about a different time.
   *
   * So: name the year when the label crosses into a new one, exactly as the
   * day is named when the label crosses into a new day. Inside one year it
   * stays off, because a year repeated on every label is a year nobody reads.
   */
  const newYear = prev === null || new Date(prev).getFullYear() !== d.getFullYear();
  const dateOpts: Intl.DateTimeFormatOptions = newYear
    ? { year: "numeric", month: "short", day: "numeric" }
    : { month: "short", day: "numeric" };
  if (!intraday) return d.toLocaleDateString(undefined, dateOpts);

  const sameDay = prev !== null && new Date(prev).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, dateOpts);
}

/**
 * How many of `bands` are open at a given UTC hour.
 *
 * Exported and tested because the answer is the whole argument for what
 * `drawSessions` paints: over the four shipped windows this is NEVER zero, which
 * is why shading "a session is open" shaded every bar on the chart and told the
 * reader nothing. Two or more is the signal.
 */
export function sessionsOpenAt(hour: number, bands: readonly SessionBand[]): number {
  let n = 0;
  for (const b of bands) if (hourInBand(hour, b.openUtc, b.closeUtc)) n++;
  return n;
}

/**
 * Where a centred label may be drawn on the time axis, and where it may not.
 *
 * Pure, exported and tested, because both rules were wrong in shipped builds and
 * both failed the same way: a fragment of text reaching the screen and reading
 * as a rendering fault rather than as a label. They are separate functions
 * because they make OPPOSITE choices, and the difference is the interesting
 * part — see the call sites.
 */

/**
 * True when a label centred at `cx` sits wholly inside the plot AND clear of the
 * one before it.
 *
 * `lastRight` is the right edge of the previously drawn label, or `-Infinity`
 * for the first. A label that fails is SKIPPED: nudging it into view would leave
 * it over a bar it does not describe, and on a time axis nothing else on screen
 * would contradict the wrong hour.
 */
export function axisLabelFits(
  cx: number,
  width: number,
  left: number,
  right: number,
  lastRight = -Infinity,
  gap = 6,
): boolean {
  const half = width / 2;
  if (cx - half < left || cx + half > right) return false;
  return cx - half >= lastRight + gap;
}

/**
 * Where to centre the crosshair's time tag so it stays legible.
 *
 * CLAMPED, where an axis label is skipped. The tag is not what identifies the
 * bar — the crosshair's vertical line is, and that does not move — so sliding
 * the readout a few pixels to keep it on screen tells no lie. A tag wider than
 * the plot is centred, so the canvas clips it evenly instead of dropping one
 * whole end.
 */
export function clampTagCenter(cx: number, width: number, left: number, right: number): number {
  const half = width / 2;
  if (width >= right - left) return (left + right) / 2;
  return Math.min(Math.max(cx, left + half), right - half);
}

export function themeFromCss(root: HTMLElement = document.documentElement): ChartTheme {
  const s = getComputedStyle(root);
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--surface-base", "#0B0E14"),
    text: v("--text", "#D4DAE3"),
    textMuted: v("--text-muted", "#7A8494"),
    textFaint: v("--text-faint", "#566072"),
    grid: v("--border-hair", "rgba(255,255,255,.06)"),
    border: v("--border", "#232B38"),
    /* `--candle-*`, not `--pos`/`--neg`. They resolve to the same value until
       somebody overrides the candle colours in Settings, at which point the
       chart changes and the P&L figures do not — which is the distinction the
       two token pairs exist to keep. */
    up: v("--candle-up", "#2DBE8E"),
    down: v("--candle-down", "#F0616D"),
    upWash: v("--candle-up-wash", "rgba(45,190,142,.14)"),
    downWash: v("--candle-down-wash", "rgba(240,97,109,.14)"),
    accent: v("--accent", "#4C82FB"),
    surface: v("--surface", "#141922"),
    crosshair: v("--text-faint", "#566072"),
    fontMono: v("--font-mono", "ui-monospace, monospace"),
    /* Same route as `--candle-up` above: Settings writes an attribute on
       :root, tokens.css turns it into these two roles, and the canvas reads
       them here. An unknown value falls back to what the chart has always
       drawn rather than to nothing. */
    gridStyle: v("--chart-grid-style", "lines") === "dots" ? "dots" : "lines",
    wick: wickWidth(v("--chart-wick", "1")),
  };
}

/**
 * The wick multiplier, clamped.
 *
 * Under half a pixel a wick disappears at any device ratio and the candle
 * becomes a floating body; over three it is thicker than the body it hangs
 * from. A value that is not a number at all is 1 — the width every previous
 * version of this chart drew.
 */
export function wickWidth(raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(0.5, n));
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Is any part of this shape inside the visible bar range?
 *
 * Shapes that project forward (an unmitigated zone, a level, an extended
 * trendline) are always kept: their whole purpose is to reach the live edge
 * from an origin that may be far off screen to the left.
 */
function shapeInRange(shape: Shape, from: number, to: number): boolean {
  switch (shape.type) {
    case "box":
      return shape.extend ? shape.x0 <= to : shape.x1 >= from && shape.x0 <= to;
    case "line":
      return shape.extend ? Math.min(shape.x0, shape.x1) <= to : shape.x1 >= from && shape.x0 <= to;
    case "level":
      return shape.x0 <= to;
    case "marker":
      return shape.x >= from && shape.x <= to;
  }
}

function makeLayer(parent: HTMLElement, zIndex: number, interactive: boolean): Layer {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;z-index:${zIndex};${
    interactive ? "" : "pointer-events:none;"
  }`;
  parent.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: zIndex > 0 });
  if (!ctx) throw new Error("2D canvas context unavailable");
  return { canvas, ctx };
}

export class ChartEngine {
  readonly series = new Series();
  readonly viewport = new Viewport();

  kind: ChartKind = "candles";
  showVolume = true;

  private overlays: LineOverlay[] = [];
  /** Indicator sub-panes as REQUESTED, before they are fitted to the height. */
  private panes: PaneSpec[] = [];
  /** The subset that actually fits. Recomputed on every resize, not just on
      setPanes — the host can shrink long after the stack was chosen. */
  private paneLayout: PaneSpec[] = [];
  private paneDropped: string[] = [];
  /**
   * Notified when the set of panes that DO NOT FIT changes.
   *
   * A callback rather than a getter because the set changes on resize, which
   * the shell has no way to observe from outside — and a pane that silently
   * fails to appear is the one outcome this whole fitting path exists to
   * avoid. Fires only on change, so it cannot loop through the render effect
   * that sets the signal it feeds.
   */
  onPaneFit: ((dropped: readonly string[]) => void) | null = null;

  /**
   * Fired when the visible window comes within `HISTORY_EDGE_BARS` of the
   * oldest loaded bar. The handler is expected to be idempotent and cheap to
   * call repeatedly — panning fires it on many frames.
   */
  onNeedHistory: (() => void) | null = null;

  /**
   * Session bands to tint behind the candles, or empty for none.
   *
   * Each is a UTC hour window. The chart draws them; it does not know what a
   * session IS — `data/sessionmap.ts` owns that, including the fact that these
   * are conventional hours rather than exchange calendars.
   */
  private sessions: readonly SessionBand[] = [];

  /** Grid lines behind price. Operator-controlled; see `setGrid`. */
  private gridOn = true;

  /**
   * How close to the start of the series counts as "needs more".
   *
   * Far enough out that the fetch has a chance to land before the operator
   * arrives at the edge, close enough that idly looking at old bars does not
   * pull the whole archive. At a typical 120 bars on screen this is a third of
   * a screen of warning.
   */
  static readonly HISTORY_EDGE_BARS = 40;
  private annotations: Shape[] = [];
  private countdownTag: CountdownTag | null = null;
  private projection: Projection | null = null;

  /** Default height of the volume band. The instance value can be dragged. */
  static readonly VOLUME_H = 48;
  static readonly TIME_AXIS_H = 22;

  /**
   * How small and how large the volume band may be dragged.
   *
   * The floor is not cosmetic: below about twenty pixels the tallest bar and
   * the median bar are the same three pixels, so the pane still costs chart
   * height while no longer carrying information. The ceiling is a share of the
   * host rather than a constant, because half of a 300px pane and half of a
   * 1200px pane are different mistakes.
   */
  static readonly VOLUME_MIN = 24;
  static readonly VOLUME_MAX_FRACTION = 0.6;

  /**
   * This chart's volume band height.
   *
   * An instance field rather than the static constant it defaults to. The
   * constant was read directly in three places, which is why the pane could not
   * be resized: there was nothing to resize. `setVolume` existed and was called
   * from nowhere at all, so it could not be closed either.
   */
  private volumeHeight: number = ChartEngine.VOLUME_H;

  private host: HTMLElement;
  private base: Layer;
  private overlay: Layer;
  private theme: ChartTheme;

  private cursor: CursorState = { x: 0, y: 0, index: -1, price: 0, inside: false };
  private baseDirty = true;
  private overlayDirty = true;
  private cancelFrame: (() => void) | null = null;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private listeners: Array<() => void> = [];

  /** Notified whenever the cursor moves, for the legend/readout panels. */
  onCursor: ((c: CursorState) => void) | null = null;

  constructor(host: HTMLElement, theme?: ChartTheme) {
    this.host = host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    this.theme = theme ?? themeFromCss();

    this.base = makeLayer(host, 0, false);
    this.overlay = makeLayer(host, 1, true);

    this.viewport.insets.bottom = this.bottomInset();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.watchAppearance();

    this.bindPointer();
    this.resize();
  }

  /**
   * Re-read the two appearance tokens the SHELL does not know about.
   *
   * The shell already repaints the canvas when the theme or a candle colour
   * changes — it owns those signals and calls `setTheme(themeFromCss())`. The
   * grid dialect and the wick weight are written by `ui/appearance.ts` as
   * attributes on :root and by nothing else, so without this the operator
   * would change a setting, watch the Settings preview answer, and see the
   * chart behind it stay exactly as it was until the next theme change.
   *
   * Narrow on purpose: only these two attributes, so it can never race or
   * double up with the shell's own theme effect.
   */
  private watchAppearance(): void {
    if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      if (this.disposed) return;
      this.setTheme(themeFromCss(root));
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-grid", "data-wick"] });
    this.listeners.push(() => mo.disconnect());
  }

  // ---------------------------------------------------------------- public --

  setTheme(theme: ChartTheme): void {
    this.theme = theme;
    this.invalidate();
  }

  setKind(kind: ChartKind): void {
    this.kind = kind;
    this.invalidate();
  }

  /**
   * Switch the price axis between linear and logarithmic.
   *
   * Re-fits afterwards. The stored window is in price units and stays valid
   * across the switch, but a window chosen to look right on one axis is
   * arbitrary on the other — a linear window sized to a recent range looks
   * squashed against the top of a log axis — so the honest response to the
   * mode changing is to show the data again rather than preserve a framing
   * that meant something under the old rule.
   */
  /**
   * Tint the background by trading session.
   *
   * WHY THIS IS WORTH DRAWING AT ALL
   * Half of what an intraday chart shows is a property of the CLOCK, not of the
   * instrument: the same range means something different in the Tokyo lunch
   * hour and thirty seconds after the London open. That information was
   * available in the terminal — there is a Sessions desk, and the status bar
   * names the next open — everywhere except on the chart, where the decision is
   * actually made. Reading it meant translating a bar's x position into a time
   * in your head.
   *
   * DRAWN AS A WASH BEHIND EVERYTHING, AND ONLY WHERE IT MEANS SOMETHING.
   * Bands are suppressed above the 4h timeframe: a daily candle spans every
   * session at once, so tinting it by "the session its open fell in" would be a
   * confident-looking lie. They are also suppressed for instruments whose hours
   * these are not — a US equity does not trade the Tokyo session.
   */
  setSessions(bands: readonly SessionBand[]): void {
    this.sessions = bands;
    this.invalidate();
  }

  /**
   * Show or hide the grid behind price.
   *
   * A preference with no correct answer: a grid makes levels easy to read off
   * and it is also the busiest thing on a chart that already carries structure
   * marks, moving averages and drawings. So it is a switch rather than a
   * decision made here.
   */
  setGrid(on: boolean): void {
    if (this.gridOn === on) return;
    this.gridOn = on;
    this.invalidate();
  }

  gridEnabled(): boolean {
    return this.gridOn;
  }

  setPriceScale(scale: PriceScale): void {
    if (this.viewport.scale === scale) return;
    this.viewport.scale = scale;
    this.viewport.autoScale = true;
    this.viewport.fitPrice(this.series);
    this.invalidate();
  }

  priceScale(): PriceScale {
    return this.viewport.scale;
  }

  setOverlays(overlays: LineOverlay[]): void {
    this.overlays = overlays;
    this.invalidate();
  }

  /**
   * Auto-drawn structures, in DATA space (bar index + price).
   *
   * Detectors never deal in pixels: a box is a price range over a bar range, so
   * it stays glued to the bars through any pan or zoom, and the same detection
   * can be listed in a panel or fed to a strategy without being recomputed.
   */
  setAnnotations(shapes: Shape[]): void {
    this.annotations = shapes;
    this.invalidate();
  }

  /**
   * The countdown tag on the price axis.
   *
   * Compares before invalidating. This is called once a second from a timer
   * and the base layer holds every candle on screen; repainting all of them to
   * redraw a tag whose text has not changed is a whole frame spent on nothing.
   * The equality check makes the quiet case free, which matters most on the
   * timeframes where the text changes least — a 1D chart would otherwise
   * repaint 86,400 times to show 86,400 identical strings.
   */
  setCountdown(tag: CountdownTag | null): void {
    const cur = this.countdownTag;
    if (cur === tag) return;
    if (cur !== null && tag !== null && cur.text === tag.text && cur.tone === tag.tone) return;
    this.countdownTag = tag;
    this.invalidate();
  }

  /** The next-bar range band. Null removes it. See `Projection`. */
  setProjection(p: Projection | null): void {
    const cur = this.projection;
    if (cur === p) return;
    if (
      cur !== null &&
      p !== null &&
      cur.low === p.low &&
      cur.high === p.high &&
      cur.calibrated === p.calibrated
    ) {
      return;
    }
    this.projection = p;
    this.invalidate();
  }

  setVolume(show: boolean): void {
    this.showVolume = show;
    this.viewport.insets.bottom = this.bottomInset();
    this.invalidate();
  }

  /**
   * Replace the stack of indicator sub-panes below the chart.
   *
   * Each pane carries its OWN y-scale — that is the whole reason they exist
   * rather than being `LineOverlay`s. See chart/panes.ts.
   *
   * Changing the stack changes the bottom inset, which changes the price
   * plot's height, which changes every y in it. So this recomputes the inset
   * before invalidating, exactly as `setVolume` does; skipping that step drew
   * the first frame of a new pane over the time axis.
   */
  setPanes(panes: readonly PaneSpec[]): void {
    this.panes = [...panes];
    this.viewport.insets.bottom = this.bottomInset();
    this.invalidate();
  }

  /** Y of the boundary between the price plot and the volume band. */
  private volumeBottom(): number {
    const vp = this.viewport;
    return vp.plotTop + vp.plotHeight + (this.showVolume ? this.volumeHeight : 0);
  }

  /**
   * Resize the volume band.
   *
   * Clamped HERE rather than by the caller, so every route in — the drag
   * handle, a restored preference, a command — gets the same limits. Returns
   * the height actually applied, which is what a drag handle needs in order to
   * stop moving when it hits the end rather than drifting away from the
   * cursor.
   */
  setVolumeHeight(px: number): number {
    const ceiling = Math.max(
      ChartEngine.VOLUME_MIN,
      Math.round(this.host.clientHeight * ChartEngine.VOLUME_MAX_FRACTION),
    );
    const next = Math.round(
      Math.min(ceiling, Math.max(ChartEngine.VOLUME_MIN, Number.isFinite(px) ? px : ChartEngine.VOLUME_H)),
    );
    if (next === this.volumeHeight) return next;
    this.volumeHeight = next;
    this.viewport.insets.bottom = this.bottomInset();
    this.invalidate();
    return next;
  }

  getVolumeHeight(): number {
    return this.volumeHeight;
  }

  /**
   * Y of the line between the price plot and the volume band.
   *
   * Exported so the shell can put a drag handle exactly on it instead of
   * guessing from a constant it would then have to keep in step.
   */
  volumeTop(): number {
    const vp = this.viewport;
    return vp.plotTop + vp.plotHeight;
  }

  private bottomInset(): number {
    /* Fitted HERE rather than in `setPanes`, because this is the one function
       every layout path funnels through — including resize, which can shrink
       the host long after the stack was chosen. */
    const fit = fitPanes(this.panes, this.host.clientHeight);
    this.paneLayout = fit.visible;
    if (
      fit.dropped.length !== this.paneDropped.length ||
      fit.dropped.some((id, i) => id !== this.paneDropped[i])
    ) {
      this.paneDropped = fit.dropped;
      this.onPaneFit?.(fit.dropped);
    }
    return (
      ChartEngine.TIME_AXIS_H +
      (this.showVolume ? this.volumeHeight : 0) +
      panesHeight(this.paneLayout)
    );
  }

  /**
   * Y of the time-axis rule.
   *
   * The volume pane is a BAND BETWEEN the price plot and the time axis, not an
   * overlay on top of it. Deriving both from this one number is what stops the
   * two from being laid out independently and colliding — which they did, on
   * first render, because each was measuring from the plot bottom.
   */
  private get axisY(): number {
    return this.volumeBottom() + panesHeight(this.paneLayout);
  }

  /** Mark the data/viewport layer dirty. Coalesced to one frame. */
  invalidate(): void {
    this.baseDirty = true;
    this.overlayDirty = true;
    this.schedule();
  }

  /** Mark only the crosshair layer dirty — the cheap path. */
  invalidateOverlay(): void {
    this.overlayDirty = true;
    this.schedule();
  }

  /**
   * The identity of the data currently loaded — instrument, timeframe, and
   * anything else that makes one series a different series rather than a
   * longer one. Compared, never parsed.
   */
  private seriesKey = "";

  /**
   * Replace the bars, and decide from the KEY whether the view survives.
   *
   * WHY THIS IS ONE METHOD AND NOT TWO CALLS AT THE CALL SITE
   * The shell used to do `series.reset(bars)` and then re-anchor only when the
   * chart had been empty — which is true exactly once, on the first load. Every
   * symbol change, timeframe change and history refetch after that handed the
   * renderer a new series while leaving `offset` pointing into the old one.
   *
   * The reason it was written that way is real and is preserved here: a live
   * feed republishes the forming bar continuously, and re-anchoring on each of
   * those would make the chart unpannable. So the question is not "did the data
   * change" — it always has — but "is this the same series". A key answers it
   * exactly, the way `stamp` does for the setup card: compare what the data IS,
   * never when it arrived.
   *
   * `revalidate` is called on BOTH paths. An append can invalidate a view too:
   * a refetch that returns fewer bars than the last one leaves the same offset
   * pointing past the end.
   */
  setSeries(bars: readonly BarView[], key: string): void {
    const replaced = key !== this.seriesKey;

    /* HOLD THE VIEW STILL WHEN HISTORY IS PREPENDED.
       `offset` is an index, not a time. Backfill pushes older bars onto the
       FRONT of the series, so every index shifts by however many arrived — and
       an offset left untouched now points at completely different bars. The
       chart would lurch to the right by exactly the amount of history it just
       gained, which reads as the scroll jumping away from you at the moment you
       reached for more of it.
       So the anchor is the leftmost visible bar's TIMESTAMP, which does not
       care how many bars precede it, and the offset is re-derived from where
       that bar ended up. */
    const prevTimes = this.series.t;
    const prevLength = this.series.length;
    const followLive = this.viewport.followLive;

    this.seriesKey = key;
    this.series.reset(bars);

    if (replaced) {
      this.viewport.followLive = true;
      this.viewport.autoScale = true;
      this.viewport.scrollToLive(this.series.length);
      this.viewport.clampOffset(this.series.length);
    } else {
      this.viewport.offset += anchorShift({
        prevTimes,
        prevLength,
        nextTimes: this.series.t,
        nextLength: this.series.length,
        offset: this.viewport.offset,
        followLive,
        replaced,
      });
    }

    this.viewport.revalidate(this.series.length);
    this.invalidate();

    /* Asked AFTER the new bars are in, so the callback sees the series it is
       being asked about rather than the one before it. */
    this.checkHistoryEdge();
  }

  /**
   * Ask for older bars when the view approaches the start of what is loaded.
   *
   * WHY THIS IS A CALLBACK AND NOT A FETCH
   * The chart knows when more history is WANTED — it is the only thing that
   * knows where the viewport is. It knows nothing about archives, vendors,
   * rate limits or which symbol is loaded, and giving it any of that would put
   * network policy inside a renderer. The shell owns the answer; this owns the
   * question.
   */
  private checkHistoryEdge(): void {
    if (this.onNeedHistory === null) return;
    if (this.series.length === 0) return;
    const { from } = this.viewport.visibleRange(this.series.length);
    if (needsOlderBars(from, ChartEngine.HISTORY_EDGE_BARS)) this.onNeedHistory();
  }

  /** Jump to the newest data and resume following it. */
  goLive(): void {
    this.viewport.followLive = true;
    this.viewport.autoScale = true;
    this.viewport.scrollToLive(this.series.length);
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame?.();
    this.resizeObserver.disconnect();
    for (const off of this.listeners) off();
    this.base.canvas.remove();
    this.overlay.canvas.remove();
  }

  // ----------------------------------------------------------------- setup --

  /**
   * Measure the host and re-back the canvases if anything changed.
   * Returns false when the host has no usable size yet.
   *
   * WHY THIS IS A PULL, NOT ONLY A PUSH
   * Sizing used to depend entirely on ResizeObserver. If the host measured zero
   * at construction — which is exactly what happens when the terminal is opened
   * in a background tab, because a backgrounded document is not laid out — the
   * early return left the canvases at their 300x150 default, and if no
   * subsequent observer callback delivered a usable size the chart stayed blank
   * for the life of the page. Re-measuring at the top of every paint means the
   * chart heals itself the moment it is given a size, whatever woke it.
   */
  private measure(): boolean {
    const rect = this.host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    // Cap DPR at 2: a 3x phone display triples fill cost for a difference no
    // one can see on a chart made of 1px strokes.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);

    if (this.base.canvas.width !== w || this.base.canvas.height !== h) {
      for (const layer of [this.base, this.overlay]) {
        // Assigning width/height also clears the canvas, so a resize always
        // implies a full repaint — hence baseDirty below.
        layer.canvas.width = w;
        layer.canvas.height = h;
        layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      this.viewport.resize(rect.width, rect.height, dpr);
      /* Re-fit the pane stack to the new height. Without this a chart that
         shrank kept the inset it had when it was tall, and the price plot
         clamped to zero height with every candle drawn on one line. */
      this.viewport.insets.bottom = this.bottomInset();
      if (this.viewport.followLive) this.viewport.scrollToLive(this.series.length);
      this.baseDirty = true;
      this.overlayDirty = true;
    }
    return true;
  }

  private resize(): void {
    if (this.measure()) this.invalidate();
  }

  private bindPointer(): void {
    const el = this.overlay.canvas;

    const localX = (e: PointerEvent | WheelEvent): number =>
      e.clientX - el.getBoundingClientRect().left;
    const localY = (e: PointerEvent | WheelEvent): number =>
      e.clientY - el.getBoundingClientRect().top;

    const onMove = (e: PointerEvent): void => {
      const x = localX(e);
      const y = localY(e);
      const vp = this.viewport;
      this.cursor = {
        x,
        y,
        index: Math.floor(vp.indexAtX(x)),
        price: vp.priceAtY(y),
        inside:
          x >= vp.plotLeft && x <= vp.plotLeft + vp.plotWidth && y >= vp.plotTop && y <= vp.plotTop + vp.plotHeight,
      };
      this.onCursor?.(this.cursor);
      this.invalidateOverlay();
    };

    const onLeave = (): void => {
      this.cursor = { ...this.cursor, inside: false, index: -1 };
      this.onCursor?.(this.cursor);
      this.invalidateOverlay();
    };

    // --- drag to pan
    let dragging: "plot" | "price" | null = null;
    let lastX = 0;
    let lastY = 0;
    /**
     * Total vertical travel of the current drag.
     *
     * WHY A DEADZONE, AND WHY IT IS CUMULATIVE
     * Detaching the price axis used to be triggered by `Math.abs(dy) > 0` —
     * literally one pixel, on any drag. Nobody pans a chart along a perfectly
     * flat line, so in practice EVERY horizontal pan silently turned
     * autoscaling off and nudged the price window. The operator had no way of
     * knowing it had happened and no obvious way back (double-click, which is
     * not discoverable), so the axis drifted a little further from the data on
     * each drag until the candles left the screen.
     *
     * Measuring the whole gesture rather than the frame's `dy` is what makes
     * the deadzone mean anything: a slow deliberate vertical drag arrives as a
     * long run of 1px moves, and a per-frame threshold would reject all of
     * them.
     */
    let dragDy = 0;
    const PRICE_DRAG_DEADZONE = 6;

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      dragging = this.viewport.onPriceAxis(localX(e)) ? "price" : "plot";
      lastX = e.clientX;
      lastY = e.clientY;
      dragDy = 0;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = dragging === "price" ? "ns-resize" : "grabbing";
    };

    const onDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      dragDy += dy;

      /* A drag that STARTED on the price gutter scales the axis, which is the
         gesture every desk platform has and this chart did not. It never pans
         time — the gutter is the axis, not the plot. */
      if (dragging === "price") {
        const vp = this.viewport;
        if (vp.plotHeight > 0) vp.scalePriceAt(vp.plotTop + vp.plotHeight / 2, 1 - dy / vp.plotHeight);
        this.invalidate();
        return;
      }

      this.viewport.panBy(dx, this.series.length);
      this.checkHistoryEdge();
      // Vertical drag detaches the price axis and shifts it — matching the
      // behaviour every desk platform has, and the reason autoScale is a flag
      // rather than a mode. Past the deadzone only, so a pan is a pan.
      if (Math.abs(dragDy) > PRICE_DRAG_DEADZONE) this.viewport.shiftPrice(dy);
      this.invalidate();
    };

    const onUp = (e: PointerEvent): void => {
      dragging = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.style.cursor = "crosshair";
    };

    /**
     * A wheel delta in pixels, whatever the device said it was in.
     *
     * `deltaMode` is 0 for pixels, 1 for lines and 2 for pages, and a chart
     * that ignores it zooms about sixteen times too slowly on a mouse in
     * Firefox. The line and page factors are the conventional ones.
     */
    const deltaPixels = (e: WheelEvent, axis: "x" | "y"): number => {
      const raw = axis === "y" ? e.deltaY : e.deltaX;
      if (e.deltaMode === 1) return raw * 16;
      if (e.deltaMode === 2) return raw * this.viewport.plotHeight;
      return raw;
    };

    /**
     * One mouse notch is 12%. A trackpad is not one notch.
     *
     * A wheel mouse emits deltaY of about 100 per click and a trackpad emits a
     * stream of 2s and 3s, so a fixed step per event means the chart either
     * crawls under a mouse or flies apart under a finger. Scaling by the delta
     * and clamping keeps one notch at 12% while a slow two-finger drag stays
     * proportional to the fingers.
     */
    const WHEEL_NOTCH = 100;
    const wheelFactor = (delta: number): number => {
      const steps = clamp(Math.abs(delta) / WHEEL_NOTCH, 0.06, 3);
      const magnitude = Math.pow(1.12, steps);
      return delta < 0 ? magnitude : 1 / magnitude;
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const dx = deltaPixels(e, "x");
      const dy = deltaPixels(e, "y");

      /* A two-finger horizontal swipe pans time. Without this the gesture did
         nothing at all, which on a laptop is most of what "I cannot move the
         chart" means. Dominance rather than a threshold: a diagonal swipe
         should do one thing, and the one the hand meant. */
      if (Math.abs(dx) > Math.abs(dy)) {
        this.viewport.panBy(-dx, this.series.length);
        this.checkHistoryEdge();
        this.invalidate();
        return;
      }

      const factor = wheelFactor(dy);
      /* Over the price gutter, or with Shift held anywhere on the plot, the
         wheel scales PRICE. Shift is the escape hatch for a chart docked so
         narrow that the gutter is a hard target, and for trackpads, where the
         gutter is easy to overshoot. */
      if (e.shiftKey || this.viewport.onPriceAxis(localX(e))) {
        this.viewport.scalePriceAt(localY(e), factor);
      } else {
        this.viewport.zoomAt(localX(e), factor, this.series.length);
      }
      this.invalidate();
    };

    /**
     * Double-click resets, and WHICH axis it resets depends on where it lands.
     *
     * On the gutter it restores autoscaling and leaves the time axis exactly
     * where it is — the operator who has scrolled back three weeks to look at
     * something wants the price scale fixed, not to be thrown back to the live
     * edge for it. Anywhere else it is the old behaviour: go live.
     */
    const onDouble = (e: MouseEvent): void => {
      if (this.viewport.onPriceAxis(e.clientX - el.getBoundingClientRect().left)) {
        this.viewport.autoScale = true;
        this.invalidate();
        return;
      }
      this.goLive();
    };

    /* The cursor names the gesture before it is made. Without it the price
       gutter is a strip that behaves differently from the plot with nothing
       saying so, which is a feature nobody finds. */
    const onHover = (e: PointerEvent): void => {
      if (dragging) return;
      el.style.cursor = this.viewport.onPriceAxis(localX(e)) ? "ns-resize" : "crosshair";
    };

    el.style.cursor = "crosshair";
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointermove", onDrag);
    el.addEventListener("pointermove", onHover);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDouble);

    this.listeners.push(() => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointermove", onDrag);
      el.removeEventListener("pointermove", onHover);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDouble);
    });
  }

  // ---------------------------------------------------------------- render --

  private schedule(): void {
    if (this.cancelFrame || this.disposed) return;
    this.cancelFrame = scheduleFrame(() => {
      this.cancelFrame = null;
      this.render();
    });
  }

  private render(): void {
    // Re-measure first: the host may only just have been given a size.
    if (!this.measure()) {
      // Not laid out yet. Keep a retry armed — but only while we are still in
      // the document, so a disposed or detached chart cannot spin for ever.
      if (this.host.isConnected) this.schedule();
      return;
    }

    const vp = this.viewport;
    if (vp.plotWidth <= 0 || vp.plotHeight <= 0) return;

    if (vp.followLive) vp.scrollToLive(this.series.length);
    /* THE LAST LINE OF DEFENCE, AND IT IS CHEAP.
       `setSeries` re-anchors on a replacement, but a view can also be invalid
       for reasons that never touch the data: the host shrinks so far that
       `barsVisible` collapses, a pane stack is added and takes the plot height
       with it, a restored layout arrives with an offset from a longer series.
       Checking here means the chart cannot be left showing an empty rectangle
       by ANY route — `revalidate` is a bounds test on two numbers and does
       nothing at all in the normal case. */
    vp.revalidate(this.series.length);
    vp.fitPrice(this.series);

    if (this.baseDirty) {
      this.drawBase();
      this.baseDirty = false;
    }
    if (this.overlayDirty) {
      this.drawOverlay();
      this.overlayDirty = false;
    }
  }

  private drawBase(): void {
    const { ctx } = this.base;
    const vp = this.viewport;
    const th = this.theme;

    // The base layer is created with `alpha:false` — a real win, because it
    // skips per-pixel blending on the densest layer. The cost is that
    // clearRect clears to BLACK, not to transparent, so the canvas cannot
    // inherit the page background and a light theme renders a black plot.
    // Painting the themed background explicitly is the price of that trade.
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, vp.width, vp.height);

    this.drawSessions(ctx);
    this.drawGrid(ctx);
    if (this.showVolume) this.drawVolume(ctx);
    if (this.paneLayout.length > 0) this.drawPanes(ctx);

    switch (this.kind) {
      case "line":
      case "area":
        this.drawLine(ctx, this.kind === "area");
        break;
      case "bars":
        this.drawBars(ctx);
        break;
      case "hollow":
        this.drawCandles(ctx, "hollow");
        break;
      case "heikin":
        this.drawCandles(ctx, "heikin");
        break;
      default:
        this.drawCandles(ctx, "filled");
    }

    this.drawProjection(ctx);
    this.drawAnnotations(ctx);
    this.drawOverlays(ctx);

    this.drawPriceAxis(ctx);
    this.drawTimeAxis(ctx);

    // Last-price marker sits on the base layer: it moves with data, not cursor.
    const n = this.series.length;
    if (n > 0) {
      const last = this.series.c[n - 1] as number;
      const prev = n > 1 ? (this.series.c[n - 2] as number) : last;
      const y = vp.yOf(last);
      const colour = last >= prev ? th.up : th.down;

      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(vp.plotLeft, Math.round(y) + 0.5);
      ctx.lineTo(vp.plotLeft + vp.plotWidth, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();

      this.drawAxisTag(ctx, y, this.formatPrice(last), colour, "#fff");

      /* The countdown hangs directly beneath the price it belongs to, in the
         axis gutter. Drawn LAST so it sits over the tick labels it covers —
         a tick label is recoverable by looking one row up; the countdown is
         not recoverable at all if something paints over it. */
      const cd = this.countdownTag;
      if (cd !== null) {
        const tone =
          cd.tone === "warn" ? th.down : cd.tone === "mute" ? th.textFaint : th.textMuted;
        /* Below the price normally, above it when the price is within a tag's
           height of the bottom of the plot. A live price pinned to the low of
           the range is not an edge case on a chart that autoscales — it is
           what every sell-off looks like — and the tag would otherwise be
           drawn over the time axis, half off the plot, exactly when the
           countdown matters most. */
        const below = y + 18;
        const floor = vp.plotTop + vp.plotHeight - 9;
        this.drawAxisTag(ctx, below <= floor ? below : y - 18, cd.text, th.surface, tone, th.border);
      }
    }
  }

  /**
   * The next bar's forecast range, in the empty space right of the newest bar.
   *
   * Drawn in the OVERSCROLL — the gap `Viewport.scrollToLive` deliberately
   * leaves at the right edge — which is the one region of the plot where
   * nothing else can be, because there are no bars there. That is also the
   * only honest place for it: a band drawn over the last few candles would
   * invite reading it against bars that have already happened.
   *
   * If the chart has been panned so that the slot is off screen, nothing is
   * drawn. A forecast squeezed onto the last visible pixel column would be a
   * smear that still looks like information.
   */
  private drawProjection(ctx: CanvasRenderingContext2D): void {
    const f = this.projection;
    const n = this.series.length;
    if (f === null || n === 0) return;

    const vp = this.viewport;
    const th = this.theme;
    const x0 = vp.xOf(n);
    const right = vp.plotLeft + vp.plotWidth;
    /* Needs a whole bar slot AND a few pixels of it on screen. */
    const x1 = Math.min(right, x0 + Math.max(vp.barWidth, 3));
    if (x0 >= right || x1 - x0 < 2) return;

    const yHigh = vp.yOf(f.high);
    const yLow = vp.yOf(f.low);
    if (!Number.isFinite(yHigh) || !Number.isFinite(yLow)) return;

    /* Muted when the model's own calibration replay says the interval does not
       contain what it claims to. Same geometry, visibly less confident ink —
       the alternative is drawing a failed model exactly like a passing one. */
    const ink = f.calibrated ? th.accent : th.textFaint;

    ctx.save();
    ctx.globalAlpha = f.calibrated ? 0.14 : 0.08;
    ctx.fillStyle = ink;
    ctx.fillRect(x0, yHigh, x1 - x0, yLow - yHigh);

    ctx.globalAlpha = f.calibrated ? 0.55 : 0.32;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yHigh) + 0.5);
    ctx.lineTo(x1, Math.round(yHigh) + 0.5);
    ctx.moveTo(x0, Math.round(yLow) + 0.5);
    ctx.lineTo(x1, Math.round(yLow) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The session OVERLAPS, behind everything.
   *
   * WHY THIS PAINTS OVERLAPS AND NOT SESSIONS, WHICH IS A CORRECTION.
   *
   * The first version painted one wash per open session, four of them, and let
   * the alpha accumulate so a busier hour came out darker. It looked like a
   * broken grid, and MEASURING the canvas said why: sampling a row of background
   * pixels found the base colour `11,14,20` nowhere inside the data at all —
   * only `17,20,26` and `23,26,31`, one wash or two.
   *
   * The four windows TILE THE DAY. Sydney 21-06, Tokyo 00-09, London 07-16, New
   * York 12-21: every hour from 0 to 23 is inside at least one of them, because
   * that is what a 24-hour market means. So "a session is open" was true of
   * every bar on the chart, and shading it said nothing whatsoever. All that
   * varied was the overlap depth, rendered as a five-level difference in
   * background darkness with hard edges at arbitrary-looking places — which
   * reads exactly as a grid that has gone wrong.
   *
   * What actually carries information is where two centres are open AT ONCE:
   * London into New York is the deepest liquidity of the day, and Tokyo into
   * London is the other one anybody trades. Those are twelve hours of the
   * twenty-four, so the chart alternates between plainly-shaded and plainly-not
   * instead of between two shades of nearly-the-same.
   *
   * ONE wash, not one per overlapping pair. Accumulating alpha is what produced
   * the original mess, and "two are open" and "three are open" are not different
   * enough in kind to be worth two greys nobody can tell apart.
   *
   * Walks the VISIBLE BARS rather than wall-clock spans. Bars are what the axis
   * is made of: a halt, a weekend or a vendor gap leaves no bars, and a band
   * drawn over clock time would tint an empty column as though it had traded.
   */
  private drawSessions(ctx: CanvasRenderingContext2D): void {
    if (this.sessions.length < 2) return;
    const vp = this.viewport;
    const s = this.series;
    const { from, to } = vp.visibleRange(s.length);
    if (to - from < 1) return;

    const wash = (this.sessions[0] as SessionBand).colour;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.plotLeft, vp.plotTop, vp.plotWidth, vp.plotHeight);
    ctx.clip();
    ctx.fillStyle = wash;

    let runStart = -1;
    for (let i = from; i <= to; i++) {
      const overlapping =
        i < to && sessionsOpenAt(utcHour(s.t[i] as number), this.sessions) > 1;
      if (overlapping && runStart < 0) runStart = i;
      else if (!overlapping && runStart >= 0) {
        const x0 = vp.xOf(runStart);
        const x1 = vp.xOf(i);
        ctx.fillRect(x0, vp.plotTop, Math.max(1, x1 - x0), vp.plotHeight);
        runStart = -1;
      }
    }
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    if (!this.gridOn) return;
    const vp = this.viewport;
    ctx.save();

    /* DOTS MARK THE SAME LEVELS THE LINES DID.
       A dot grid is not a different grid: it is the same price ticks and the
       same time ticks, meeting. Sampling a finer lattice would put marks at
       prices no axis label names, which is a decoration rather than a
       reference. Two pixels square, because a one-pixel mark at the hairline
       colour is invisible where a continuous line at the same colour reads
       perfectly well — a line accumulates along its length and a dot has no
       length to accumulate along. */
    if (this.theme.gridStyle === "dots") {
      const xs = this.timeTicks().map((i) => Math.round(vp.xCenterOf(i)));
      ctx.fillStyle = this.theme.grid;
      for (const p of this.priceTicks()) {
        const y = Math.round(vp.yOf(p)) - 1;
        for (const x of xs) ctx.fillRect(x - 1, y, 2, 2);
      }
      ctx.restore();
      return;
    }

    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of this.priceTicks()) {
      const y = Math.round(vp.yOf(p)) + 0.5;
      ctx.moveTo(vp.plotLeft, y);
      ctx.lineTo(vp.plotLeft + vp.plotWidth, y);
    }
    for (const i of this.timeTicks()) {
      const x = Math.round(vp.xCenterOf(i)) + 0.5;
      ctx.moveTo(x, vp.plotTop);
      ctx.lineTo(x, vp.plotTop + vp.plotHeight);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Candles, in three dialects.
   *
   * `filled`  the ordinary candle: body coloured by close against open.
   * `hollow`  body OUTLINED when the bar closed up, filled when it closed down,
   *           and coloured by close against the PREVIOUS close. Two facts in
   *           one glyph instead of one — whether the bar rose, and whether it
   *           rose from where the last one left off. A hollow red candle is a
   *           bar that gained on its own open while still trading below
   *           yesterday, which an ordinary candle cannot express at all.
   * `heikin`  Heikin-Ashi: each bar is averaged with the one before it, so a
   *           trend shows as an unbroken run of one colour and a stall shows as
   *           the first bar with a wick on both sides.
   *
   * HEIKIN-ASHI IS NOT PRICE, AND THE CHART SAYS SO ELSEWHERE.
   * Its close is an average of four numbers and its open is an average of two
   * more, so no value on a Heikin-Ashi candle is a price anything traded at.
   * That is the point of it and it is also a trap: a stop read off one of these
   * bodies is a stop at a price that never existed. The legend, the crosshair
   * and every level therefore keep reporting the real series — only the glyphs
   * change — and the mode is named in the toolbar rather than being a subtle
   * restyling of "candles".
   */
  private drawCandles(ctx: CanvasRenderingContext2D, style: "filled" | "hollow" | "heikin" = "filled"): void {
    const vp = this.viewport;
    const s = this.series;
    const th = this.theme;
    const { from, to } = vp.visibleRange(s.length);

    const bodyW = Math.max(1, Math.floor(vp.barWidth * 0.7));
    const halfW = bodyW / 2;
    // Below ~3px per bar, individual bodies are sub-pixel; drawing wicks only
    // is both faster and more legible than a wall of overlapping rectangles.
    const wicksOnly = vp.barWidth < 3;

    /* Heikin-Ashi needs the PREVIOUS smoothed bar, so it is computed once for
       the visible window rather than per draw call. One bar of lead-in keeps
       the leftmost candle from being seeded with itself, which puts a false
       doji at the left edge on every pan. */
    /**
     * WHY A THICKER WICK NEEDS ITS OWN PATH, AND A 1px ONE MUST NOT GET ONE.
     *
     * The wick lines and the body rectangles share one path below, which is
     * then STROKED and FILLED — so the bodies are outlined at the stroke
     * width as well. At 1px that outline is the same colour as the fill and
     * has always been part of how a candle looks here. Raising `lineWidth`
     * to thicken the wick would therefore also grow every body by half a
     * pixel on each side: an operator asking for heavier wicks would get
     * fatter candles and no way to say so.
     *
     * So the default is left EXACTLY as it was — one path, one stroke, one
     * fill — and only a wick that is not 1 pays for a second pass. When the
     * bars are too narrow to have bodies at all there is nothing to protect,
     * and the width simply goes on the shared stroke.
     */
    const wickW = th.wick;
    const splitWicks = wickW !== 1 && !wicksOnly;

    const ha = style === "heikin" ? heikinAshi(s, Math.max(0, from - 1), to) : null;
    const haAt = (i: number): { o: number; h: number; l: number; c: number } | null =>
      ha ? (ha[i - Math.max(0, from - 1)] ?? null) : null;

    // Batching by colour halves the state changes: two fill passes instead of
    // one per bar. At 20k visible bars that is the difference between a smooth
    // pan and a stuttering one. Hollow adds one stroke pass per colour on top,
    // which is still four passes for the whole chart rather than four per bar.
    for (const rising of [true, false]) {
      ctx.fillStyle = rising ? th.up : th.down;
      ctx.strokeStyle = rising ? th.up : th.down;
      ctx.beginPath();
      const outlined: Array<[number, number, number]> = [];
      /* x, yHigh, yLow per bar, and only when the wicks are drawn separately.
         At most one entry per visible bar with a body — bodies need 3px each,
         so this is bounded by the plot width in thirds, a few hundred. */
      const wicks: number[] = [];

      for (let i = from; i < to; i++) {
        const bar = haAt(i);
        const o = bar ? bar.o : (s.o[i] as number);
        const c = bar ? bar.c : (s.c[i] as number);
        const hi = bar ? bar.h : (s.h[i] as number);
        const lo = bar ? bar.l : (s.l[i] as number);

        /* WHICH COLOUR THIS BAR IS.
           Ordinary and Heikin-Ashi candles colour by close against their own
           open. Hollow candles colour by close against the PREVIOUS close —
           that is the whole reason the style exists, and colouring it the
           ordinary way would produce a chart that merely looks different. */
        const up =
          style === "hollow" && i > 0 ? c >= (s.c[i - 1] as number) : c >= o;
        if (up !== rising) continue;

        const x = Math.round(vp.xCenterOf(i)) + 0.5;
        if (splitWicks) {
          wicks.push(x, vp.yOf(hi), vp.yOf(lo));
        } else {
          ctx.moveTo(x, vp.yOf(hi));
          ctx.lineTo(x, vp.yOf(lo));
        }

        if (!wicksOnly) {
          const yO = vp.yOf(o);
          const yC = vp.yOf(c);
          const top = Math.min(yO, yC);
          // A doji has zero body height and would vanish entirely; floor it at
          // one pixel so a flat bar still reads as a bar.
          const height = Math.max(1, Math.abs(yC - yO));
          if (style === "hollow" && c >= o) {
            // Outlined, not filled: the bar closed above its own open.
            outlined.push([Math.round(x - halfW), Math.round(top), Math.round(height)]);
          } else {
            ctx.rect(Math.round(x - halfW), Math.round(top), bodyW, Math.round(height));
          }
        }
      }
      /* No bodies on screen means nothing to protect from a wide stroke. */
      ctx.lineWidth = wicksOnly ? wickW : 1;
      ctx.stroke();
      if (!wicksOnly) ctx.fill();

      if (wicks.length > 0) {
        ctx.beginPath();
        for (let w = 0; w < wicks.length; w += 3) {
          ctx.moveTo(wicks[w] as number, wicks[w + 1] as number);
          ctx.lineTo(wicks[w] as number, wicks[w + 2] as number);
        }
        ctx.lineWidth = wickW;
        ctx.stroke();
      }

      if (outlined.length > 0) {
        ctx.beginPath();
        for (const [bx, by, bh] of outlined) {
          // Inset by half a pixel so a 1px stroke lands ON the pixel grid
          // instead of straddling two rows and rendering grey.
          ctx.rect(bx + 0.5, by + 0.5, bodyW - 1, Math.max(1, bh - 1));
        }
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawBars(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const s = this.series;
    const th = this.theme;
    const { from, to } = vp.visibleRange(s.length);
    const tick = Math.max(1, Math.floor(vp.barWidth * 0.35));

    for (const rising of [true, false]) {
      ctx.strokeStyle = rising ? th.up : th.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const o = s.o[i] as number;
        const c = s.c[i] as number;
        if (c >= o !== rising) continue;
        const x = Math.round(vp.xCenterOf(i)) + 0.5;
        ctx.moveTo(x, vp.yOf(s.h[i] as number));
        ctx.lineTo(x, vp.yOf(s.l[i] as number));
        const yO = Math.round(vp.yOf(o)) + 0.5;
        const yC = Math.round(vp.yOf(c)) + 0.5;
        ctx.moveTo(x - tick, yO);
        ctx.lineTo(x, yO);
        ctx.moveTo(x, yC);
        ctx.lineTo(x + tick, yC);
      }
      ctx.stroke();
    }
  }

  private drawLine(ctx: CanvasRenderingContext2D, fill: boolean): void {
    const vp = this.viewport;
    const s = this.series;
    const { from, to } = vp.visibleRange(s.length);
    if (to - from < 2) return;

    ctx.save();
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const x = vp.xCenterOf(i);
      const y = vp.yOf(s.c[i] as number);
      if (i === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    if (fill) {
      const bottom = vp.plotTop + vp.plotHeight;
      const grad = ctx.createLinearGradient(0, vp.plotTop, 0, bottom);
      grad.addColorStop(0, this.theme.accent);
      grad.addColorStop(1, "transparent");
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.lineTo(vp.xCenterOf(to - 1), bottom);
      ctx.lineTo(vp.xCenterOf(from), bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // Re-trace: the fill closed the path, so the stroke needs a fresh one.
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const x = vp.xCenterOf(i);
        const y = vp.yOf(s.c[i] as number);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  private drawVolume(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const s = this.series;
    const th = this.theme;
    const { from, to } = vp.visibleRange(s.length);
    /* NOT `v / visibleMax`. Volume is heavy-tailed, so one spike set the scale
       and flattened the rest: MEASURED on BTCUSDT 1h, the median bar drew at
       4.5–6.1px of the 42 available (11–15%) with up to 23% of bars under three
       pixels. `volumeScale` anchors on min(p95, median x 3) and clips, which
       keeps height strictly PROPORTIONAL below the clip — the property a log
       scale destroys, and the reason this is not a log. See its header. */
    const scale = volumeScale(s.v, from, to, this.volumeHeight - 6);
    if (scale.empty) return;

    /* The volume band's own floor, NOT `axisY`: once panes are stacked below
       it those are different lines, and using axisY drew every volume bar
       straight through the RSI pane. */
    const baseline = this.volumeBottom();
    const zoneH = this.volumeHeight - 6;   // 6px breathing room under the price plot
    const barW = Math.max(1, Math.floor(vp.barWidth * 0.7));

    /* THE VOLUME BAND WAS THE ONE PLOT WITH NO NAME ON IT.
       Every stacked pane below it announces itself and prints its value; the
       band above them was an unlabelled strip of bars whose height had no
       stated scale, so "is this a big bar" could only be answered relative to
       the other bars on screen — which changes every time you pan. The title
       says what it is, and the figure says what the bar under the cursor
       actually traded, which is the question the strip is there to answer. */
    const volIndex = this.paneReadIndex();
    ctx.save();
    ctx.font = `10px ${th.fontMono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = th.textFaint;
    const volTop = baseline - zoneH + 1;
    ctx.fillText("Volume", vp.plotLeft + 4, volTop);
    if (volIndex !== null) {
      const v = s.v[volIndex];
      if (v !== undefined && Number.isFinite(v)) {
        const up = (s.c[volIndex] as number) >= (s.o[volIndex] as number);
        ctx.fillStyle = up ? th.up : th.down;
        /* RELATIVE volume leads, because it is the figure a trader acts on:
           "7.83" says nothing without the window it sits in, and "3.2x" is a
           decision. The raw figure stays beside it — shortening must MOVE a
           fact, never delete it. */
        const rel = formatRelative(relativeVolume(v, scale.median));
        const label = rel ? `${rel}  ${abbreviateVolume(v)}` : abbreviateVolume(v);
        ctx.fillText(label, vp.plotLeft + 4 + ctx.measureText("Volume").width + 8, volTop);
      }
    }
    ctx.restore();

    ctx.save();
    /* 0.5 until v63.21. At half alpha against the chart's own background the
       bars read as a smudge; the band is a plot, not a watermark. */
    ctx.globalAlpha = 0.75;
    for (const rising of [true, false]) {
      ctx.fillStyle = rising ? th.up : th.down;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const o = s.o[i] as number;
        const c = s.c[i] as number;
        if (c >= o !== rising) continue;
        const height = scale.heightOf(s.v[i] as number);
        if (height < 0.5) continue;
        const x = Math.round(vp.xCenterOf(i) - barW / 2);
        ctx.rect(x, baseline - height, barW, height);
      }
      ctx.fill();
    }
    /* A CLIPPED BAR MUST SAY SO. It is drawn at full height while really being
       several times the reference, and an understatement nobody can see is the
       same failure as the flattening this replaced, pointed the other way. The
       cap is a 2px tick along the top of the band above each one. */
    if (scale.clipped > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.textFaint;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const v = s.v[i] as number;
        if (!(v > scale.reference)) continue;
        const x = Math.round(vp.xCenterOf(i) - barW / 2);
        ctx.rect(x, baseline - zoneH - 2, barW, 2);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Draw the sub-pane stack.
   *
   * Every pane is CLIPPED to its own rect before anything is plotted. Without
   * that a fitted pane whose range is computed from the visible window still
   * receives values from outside it during a pan, and an RSI spike one bar off
   * screen painted a vertical stripe through the pane above.
   */
  private drawPanes(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const th = this.theme;
    const { from, to } = vp.visibleRange(this.series.length);
    let top = this.volumeBottom();

    for (const pane of this.paneLayout) {
      const bottom = top + pane.height;
      const innerTop = top + PANE_PAD;
      const innerH = Math.max(1, pane.height - PANE_PAD * 2);

      /* Separator above each pane, so the stack reads as distinct plots
         rather than one tall smear. */
      ctx.save();
      ctx.strokeStyle = th.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vp.plotLeft, Math.round(top) + 0.5);
      ctx.lineTo(vp.plotLeft + vp.plotWidth, Math.round(top) + 0.5);
      ctx.stroke();
      ctx.restore();

      const range = paneRange(pane, from, to);

      /* Label first: it must render even when there is no data, or a pane
         still in its warm-up looks like an empty strip of nothing.
         
         THE VALUES SIT BESIDE IT, IN EACH SERIES' OWN COLOUR.
         A pane titled "MACD 12/26/9" tells you what is plotted and nothing
         about what it currently reads, so the number had to be got by tracing a
         line to the right edge by eye — on a 40px strip, past a crossover, in
         two colours that are only distinguishable where they diverge. Printing
         them here is how every terminal solves it, and colouring each to its
         line is what makes "which of these two is the signal" answerable
         without a legend.
         
         They follow the cursor for the same reason the OHLC legend does: while
         scrubbing, the whole chart is reporting the bar under the pointer, and
         a pane still showing the newest value would be the one surface
         disagreeing with the other three. */
      ctx.save();
      ctx.font = `10px ${th.fontMono}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = th.textFaint;
      ctx.fillText(pane.label, vp.plotLeft + 4, top + 3);
      let labelX = vp.plotLeft + 4 + ctx.measureText(pane.label).width + 8;

      const readAt = this.paneReadIndex();
      if (readAt !== null) {
        for (const ser of pane.series) {
          const v = ser.values[readAt];
          if (v === undefined || !Number.isFinite(v)) continue;
          const text = formatPaneValue(v);
          ctx.fillStyle = ser.color;
          ctx.fillText(text, labelX, top + 3);
          labelX += ctx.measureText(text).width + 6;
          /* Stop before the values run under the pane's own right edge. A
             number half-clipped by the axis is worse than one not shown. */
          if (labelX > vp.plotLeft + vp.plotWidth - 40) break;
        }
      }
      ctx.restore();

      if (range === null) {
        /* No finite value in view. Say so, rather than drawing a flat line at
           the floor that reads as a real value of zero. */
        ctx.save();
        ctx.fillStyle = th.textFaint;
        ctx.font = `10px ${th.fontMono}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("warming up", vp.plotLeft + vp.plotWidth - 4, top + 3);
        ctx.restore();
        top = bottom;
        continue;
      }

      const span = range.hi - range.lo;
      const yOf = (v: number): number => innerTop + (1 - (v - range.lo) / span) * innerH;

      ctx.save();
      ctx.beginPath();
      ctx.rect(vp.plotLeft, top, vp.plotWidth, pane.height);
      ctx.clip();

      /* Guides behind the data. */
      if (pane.guides && pane.guides.length > 0) {
        ctx.save();
        ctx.strokeStyle = th.grid;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const g of pane.guides) {
          const y = Math.round(yOf(g)) + 0.5;
          ctx.moveTo(vp.plotLeft, y);
          ctx.lineTo(vp.plotLeft + vp.plotWidth, y);
        }
        ctx.stroke();
        ctx.restore();

        /* Label the guides on the right, where the price axis is. These are
           the numbers the pane exists to be read against. */
        ctx.save();
        ctx.fillStyle = th.textFaint;
        ctx.font = `9px ${th.fontMono}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (const g of pane.guides) {
          ctx.fillText(String(g), vp.plotLeft + vp.plotWidth + 4, yOf(g));
        }
        ctx.restore();
      }

      const zeroY = pane.zero !== undefined ? yOf(pane.zero) : innerTop + innerH;
      const barW = Math.max(1, Math.floor(vp.barWidth * 0.7));

      for (const ser of pane.series) {
        if (ser.kind === "histogram") {
          /* Two passes, one fill each, so the whole histogram is at most two
             draw calls regardless of bar count — the same trick drawVolume
             uses and the reason the chart survives 5,000 bars. */
          for (const above of [true, false]) {
            const colour = above ? ser.color : (ser.colorDown ?? ser.color);
            ctx.fillStyle = colour;
            ctx.globalAlpha = 0.65;
            ctx.beginPath();
            for (let i = from; i < to && i < ser.values.length; i++) {
              const v = ser.values[i] as number;
              if (!Number.isFinite(v)) continue;
              const anchor = pane.zero ?? range.lo;
              if (v >= anchor !== above) continue;
              const y = yOf(v);
              const x = Math.round(vp.xCenterOf(i) - barW / 2);
              const hgt = y - zeroY;
              if (Math.abs(hgt) < 0.5) continue;
              ctx.rect(x, Math.min(y, zeroY), barW, Math.abs(hgt));
            }
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          continue;
        }

        ctx.strokeStyle = ser.color;
        ctx.lineWidth = ser.width ?? 1;
        ctx.lineJoin = "round";
        ctx.beginPath();
        let pen = false;
        for (let i = from; i < to && i < ser.values.length; i++) {
          const v = ser.values[i] as number;
          /* NaN breaks the path rather than interpolating across it — the
             warm-up is a gap, and a line sloping in from nowhere is a lie
             about when the indicator became readable. */
          if (!Number.isFinite(v)) {
            pen = false;
            continue;
          }
          const x = vp.xCenterOf(i);
          const y = yOf(v);
          if (pen) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            pen = true;
          }
        }
        ctx.stroke();
      }

      ctx.restore();

      /* The last value, on the axis, in the series' own colour. Without it the
         pane is a shape with no number attached. */
      const lastSer = pane.series[pane.series.length - 1];
      if (lastSer) {
        for (let i = Math.min(to, lastSer.values.length) - 1; i >= from; i--) {
          const v = lastSer.values[i] as number;
          if (!Number.isFinite(v)) continue;
          this.drawAxisTag(ctx, yOf(v), formatPaneValue(v), lastSer.color, "#fff");
          break;
        }
      }

      top = bottom;
    }
  }

  private toneColor(tone: Tone): string {
    switch (tone) {
      case "bull":
        return this.theme.up;
      case "bear":
        return this.theme.down;
      case "accent":
        return this.theme.accent;
      default:
        return this.theme.textMuted;
    }
  }

  /**
   * Draw detected structures.
   *
   * Everything is clipped to the plot rect. Without that, a box extended to the
   * live edge paints straight over the price axis, and a trendline projected
   * forward runs off into the dock.
   */
  private drawAnnotations(ctx: CanvasRenderingContext2D): void {
    if (this.annotations.length === 0) return;
    const vp = this.viewport;
    const rightEdge = vp.plotLeft + vp.plotWidth;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.plotLeft, vp.plotTop, vp.plotWidth, vp.plotHeight);
    ctx.clip();
    ctx.font = `10px ${this.theme.fontMono}`;

    // Cull by bar range before touching the canvas. At 800 bars with every
    // detector on there can be hundreds of shapes, and most are off screen once
    // you zoom in; testing two numbers is far cheaper than issuing the draw and
    // letting the clip discard it.
    const { from, to } = vp.visibleRange(this.series.length);
    const markers: MarkerLabel[] = [];

    for (const shape of this.annotations) {
      if (!shapeInRange(shape, from, to)) continue;
      const colour = this.toneColor(shape.tone);

      switch (shape.type) {
        case "box": {
          const x0 = vp.xCenterOf(shape.x0);
          const x1 = shape.extend ? rightEdge : vp.xCenterOf(shape.x1);
          const yTop = vp.yOf(Math.max(shape.y0, shape.y1));
          const yBot = vp.yOf(Math.min(shape.y0, shape.y1));
          // A zone thinner than a pixel is invisible; floor it so a tight gap
          // still reads as a band rather than vanishing.
          const height = Math.max(1, yBot - yTop);

          ctx.globalAlpha = 0.13;
          ctx.fillStyle = colour;
          ctx.fillRect(x0, yTop, x1 - x0, height);

          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1;
          ctx.setLineDash(shape.dashed ? [3, 3] : []);
          ctx.strokeRect(Math.round(x0) + 0.5, Math.round(yTop) + 0.5, x1 - x0, height);
          ctx.setLineDash([]);

          if (shape.label) {
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = colour;
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.fillText(shape.label, x0 + 3, yTop - 2);
          }
          ctx.globalAlpha = 1;
          break;
        }

        case "line": {
          const x0 = vp.xCenterOf(shape.x0);
          const y0 = vp.yOf(shape.y0);
          let x1 = vp.xCenterOf(shape.x1);
          let y1 = vp.yOf(shape.y1);

          if (shape.extend && shape.x1 !== shape.x0) {
            // Project along the line's own slope to the right edge, in DATA
            // space — extending in pixel space would change the slope whenever
            // the price scale changed.
            const slope = (shape.y1 - shape.y0) / (shape.x1 - shape.x0);
            const edgeIndex = vp.indexAtX(rightEdge);
            y1 = vp.yOf(shape.y0 + slope * (edgeIndex - shape.x0));
            x1 = rightEdge;
          }

          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1.25;
          ctx.setLineDash(shape.dashed ? [4, 3] : []);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          ctx.setLineDash([]);

          if (shape.label) {
            ctx.fillStyle = colour;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(shape.label, x1 - 3, y1 - 3);
          }
          ctx.globalAlpha = 1;
          break;
        }

        case "level": {
          const y = Math.round(vp.yOf(shape.y)) + 0.5;
          const x0 = vp.xCenterOf(shape.x0);
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1;
          ctx.setLineDash(shape.dashed ? [5, 4] : []);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(rightEdge, y);
          ctx.stroke();
          ctx.setLineDash([]);

          if (shape.label) {
            /**
             * Tag at the RIGHT end of the line, not the left.
             *
             * The line is drawn from its first touch to the right edge, so a
             * level established off-screen clamped its tag to `plotLeft` — and
             * every such level then stacked its tag in the same column, on top
             * of the oldest candles. Six of them at once was the loudest thing
             * on the chart and the least useful, because the part that differs
             * (the price) sat at the END of each line where the eye reaches it
             * last.
             *
             * The right end is empty in the normal case — the chart keeps a gap
             * between the newest bar and the axis — it is where the eye already
             * goes to read price, and it cannot collide with the tags of other
             * levels because those sit at their own heights.
             */
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = colour;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(shape.label, rightEdge - 4, y - 3);
          }
          ctx.globalAlpha = 1;
          break;
        }

        case "marker": {
          /* Collected, not drawn. Placement needs to see all of them at once —
             see `placeMarkers`. The arrow is drawn now because it points at a
             price and must not move; only the LABEL is free to be nudged. */
          const x = vp.xCenterOf(shape.x);
          const y = vp.yOf(shape.y);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = colour;
          ctx.beginPath();
          ctx.moveTo(x, y + (shape.above ? -3 : 3));
          ctx.lineTo(x - 3, y + (shape.above ? -8 : 8));
          ctx.lineTo(x + 3, y + (shape.above ? -8 : 8));
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
          markers.push({ x, y, text: shape.text, above: shape.above, colour });
          break;
        }
      }
    }

    this.placeMarkers(ctx, markers);

    ctx.restore();
  }

  /**
   * Draw the structure labels so that they can all be read.
   *
   * THE PROBLEM THIS SOLVES IS THE MOST VISIBLE FLAW ON THE CHART.
   * Every marker was drawn at a fixed offset from the price it marks, which is
   * correct exactly until two of them are near each other — and structure
   * events cluster by their nature, because a change of character and the break
   * of structure that confirms it happen within a few bars at similar prices.
   * The result was "CHoCH" printed over "CHoCH", producing a smear that is not
   * one label or two but an unreadable third thing. On a chart whose whole
   * argument is that it shows its reasoning, the reasoning was illegible in
   * precisely the places where the most was happening.
   *
   * TradingView has the same defect and ships it; matching that was not the
   * bar worth clearing.
   *
   * HOW: the arrow stays on its price, the label moves. Each label is pushed
   * away from the price in the direction it already points until it clears
   * every label already placed. That keeps the association between a label and
   * its arrow (they stay in one column) while removing the overlap.
   *
   * WHAT IT REFUSES TO DO: place a label at any cost. After `MAX_NUDGES` the
   * label is dropped and only its arrow remains. A cluster of nine events in
   * six bars cannot show nine labels legibly at any offset, and stacking them
   * into a tower that reaches the top of the plot trades one unreadable smear
   * for a column of text that no longer sits near what it describes.
   */
  private placeMarkers(ctx: CanvasRenderingContext2D, markers: readonly MarkerLabel[]): void {
    if (markers.length === 0) return;
    const vp = this.viewport;
    const placed: Rect[] = [];
    const LINE_H = 11;
    const STEP = 11;
    const MAX_NUDGES = 6;

    /* Left to right, so a cluster resolves in reading order and the same set of
       events lands the same way on every repaint — a placement that depended on
       array order would shimmer as detections were re-sorted. */
    const sorted = [...markers].sort((a, b) => a.x - b.x);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const m of sorted) {
      const halfW = ctx.measureText(m.text).width / 2 + 2;
      let cy = m.y + (m.above ? -16 : 20);
      let attempts = 0;

      while (attempts < MAX_NUDGES) {
        const rect: Rect = { x0: m.x - halfW, x1: m.x + halfW, y0: cy - LINE_H / 2, y1: cy + LINE_H / 2 };
        if (!placed.some((r) => overlaps(r, rect))) break;
        cy += m.above ? -STEP : STEP;
        attempts++;
      }
      if (attempts >= MAX_NUDGES) continue;

      /* Off the top or bottom of the plot after nudging: the label would be
         clipped to a sliver, which reads as a rendering fault rather than as a
         label that did not fit. */
      if (cy - LINE_H < vp.plotTop || cy + LINE_H > vp.plotTop + vp.plotHeight) continue;

      placed.push({ x0: m.x - halfW, x1: m.x + halfW, y0: cy - LINE_H / 2, y1: cy + LINE_H / 2 });

      /* A hairline back to the arrow when the label has been pushed clear of
         its default spot. Without it, a nudged label reads as belonging to
         whatever candle it happens to sit above. */
      const defaultY = m.y + (m.above ? -16 : 20);
      if (Math.abs(cy - defaultY) > 1) {
        ctx.save();
        ctx.strokeStyle = m.colour;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(m.x) + 0.5, m.y + (m.above ? -9 : 9));
        ctx.lineTo(Math.round(m.x) + 0.5, cy + (m.above ? LINE_H / 2 : -LINE_H / 2));
        ctx.stroke();
        ctx.restore();
      }

      /* A shadow of the plot background behind the glyphs. Structure labels sit
         over candles and moving averages, and 10px text on a wick is unreadable
         however well it is placed. */
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(m.x - halfW, cy - LINE_H / 2, halfW * 2, LINE_H);
      ctx.restore();

      ctx.globalAlpha = 0.95;
      ctx.fillStyle = m.colour;
      ctx.fillText(m.text, m.x, cy);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawOverlays(ctx: CanvasRenderingContext2D): void {
    if (this.overlays.length === 0) return;
    const vp = this.viewport;
    const { from, to } = vp.visibleRange(this.series.length);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    for (const line of this.overlays) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width ?? 1.25;
      ctx.setLineDash(line.dash ?? []);
      ctx.beginPath();

      // `pen` tracks whether the path is currently down. A NaN run lifts it, so
      // the warm-up region leaves a gap rather than a line sloping up from the
      // bottom of the chart — which is what makes an unseeded indicator look
      // like a real signal.
      let pen = false;
      for (let i = from; i < to; i++) {
        const v = line.values[i];
        if (v === undefined || Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const x = vp.xCenterOf(i);
        const y = vp.yOf(v);
        if (pen) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          pen = true;
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const th = this.theme;
    const x = vp.plotLeft + vp.plotWidth;

    ctx.save();
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, vp.plotTop);
    ctx.lineTo(Math.round(x) + 0.5, vp.plotTop + vp.plotHeight);
    ctx.stroke();

    ctx.fillStyle = th.textMuted;
    ctx.font = `10px ${th.fontMono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const p of this.priceTicks()) {
      ctx.fillText(this.formatPrice(p), x + 6, vp.yOf(p));
    }
    ctx.restore();
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const th = this.theme;
    const y = this.axisY;

    ctx.save();
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(vp.plotLeft, Math.round(y) + 0.5);
    ctx.lineTo(vp.plotLeft + vp.plotWidth, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.fillStyle = th.textMuted;
    ctx.font = `10px ${th.fontMono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const spacing = this.series.spacingMs();

    /**
     * A LABEL IS DRAWN WHOLE OR NOT AT ALL.
     *
     * These are centred on their bar, so a tick close to either edge put half
     * its text outside the plot and the canvas clipped it. What reached the
     * screen was a fragment — a bare "PM", or a date with its first letters
     * sliced off — which reads as a rendering fault rather than as a label.
     *
     * SKIPPED rather than nudged inward. Sliding it into view would leave the
     * label sitting over a bar it does not describe, and on a time axis being
     * an hour out is worse than being absent: nothing else on screen would
     * contradict it. The crosshair tag below IS clamped, because that one is
     * anchored to a vertical line that still marks the exact bar.
     */
    const left = vp.plotLeft;
    const right = vp.plotLeft + vp.plotWidth;
    let lastRight = -Infinity;
    /* The last label actually DRAWN, so a skipped tick cannot swallow the day
       change that the next one needs to announce. */
    let lastDrawnAt: number | null = null;

    for (const i of this.timeTicks()) {
      const t = this.series.t[i];
      if (t === undefined) continue;
      const label = axisTimeLabel(t, lastDrawnAt, spacing);
      const width = ctx.measureText(label).width;
      const cx = vp.xCenterOf(i);
      /* `timeTicks` spaces by 84px of INDEX, and label widths vary — "Sep 8" is
         half the width of "08:00 AM" — so the overlap guard inside is not
         redundant with the stride. */
      if (!axisLabelFits(cx, width, left, right, lastRight)) continue;
      ctx.fillText(label, cx, y + 6);
      lastRight = cx + width / 2;
      lastDrawnAt = t;
    }
    ctx.restore();
  }

  private drawOverlay(): void {
    const { ctx } = this.overlay;
    const vp = this.viewport;
    const th = this.theme;

    ctx.clearRect(0, 0, vp.width, vp.height);
    if (!this.cursor.inside) return;

    // Snap the vertical line to the bar centre; a crosshair that floats between
    // bars makes it impossible to tell which bar you are reading.
    const idx = clamp(Math.round(vp.indexAtX(this.cursor.x) - 0.5), 0, Math.max(0, this.series.length - 1));
    const snapX = this.series.length > 0 ? vp.xCenterOf(idx) : this.cursor.x;

    ctx.save();
    ctx.strokeStyle = th.crosshair;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(snapX) + 0.5, vp.plotTop);
    ctx.lineTo(Math.round(snapX) + 0.5, this.axisY);
    ctx.moveTo(vp.plotLeft, Math.round(this.cursor.y) + 0.5);
    ctx.lineTo(vp.plotLeft + vp.plotWidth, Math.round(this.cursor.y) + 0.5);
    ctx.stroke();
    ctx.restore();

    this.drawAxisTag(ctx, this.cursor.y, this.formatPrice(vp.priceAtY(this.cursor.y)), th.surface, th.text, th.border);

    const t = this.series.t[idx];
    if (t !== undefined) {
      const label = this.formatTime(t, this.series.spacingMs(), true);
      ctx.save();
      ctx.font = `10px ${th.fontMono}`;
      const w = ctx.measureText(label).width + 12;
      const y = this.axisY;

      /**
       * CLAMPED INTO THE PLOT, unlike the tick labels above.
       *
       * This tag was drawn at `snapX - w/2` with nothing stopping it leaving the
       * canvas, so reading the first few bars of the series cut the date off its
       * own readout — "Aug 31, 03:00 PM" arriving as "ug 31, 03:00 PM". Half a
       * date is worse than no date, because it still looks like a value.
       *
       * Clamping is right HERE and wrong for the tick labels because this tag is
       * not what identifies the bar — the crosshair's vertical line is, and that
       * stays exactly on `snapX`. The tag is a readout attached to it, so moving
       * it a few pixels to stay legible tells no lie about which bar is meant.
       */
      const cx = clampTagCenter(snapX, w, vp.plotLeft, vp.plotLeft + vp.plotWidth);

      ctx.fillStyle = th.surface;
      ctx.strokeStyle = th.border;
      ctx.beginPath();
      ctx.rect(Math.round(cx - w / 2), y + 1, w, 16);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, y + 9);
      ctx.restore();
    }
  }

  private drawAxisTag(
    ctx: CanvasRenderingContext2D,
    y: number,
    label: string,
    bg: string,
    fg: string,
    stroke?: string,
  ): void {
    const vp = this.viewport;
    const x = vp.plotLeft + vp.plotWidth;
    ctx.save();
    ctx.font = `10px ${this.theme.fontMono}`;
    const w = Math.max(vp.insets.right - 2, ctx.measureText(label).width + 12);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.rect(x + 1, Math.round(y) - 8, w, 16);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 7, y);
    ctx.restore();
  }

  // ------------------------------------------------------------- utilities --

  /**
   * Which bar the pane titles and the volume title report.
   *
   * The bar under the cursor while it is over the plot, the newest bar
   * otherwise — the same rule the OHLC legend follows, kept in one place so the
   * two cannot drift into reporting different bars at the same moment.
   */
  private paneReadIndex(): number | null {
    const len = this.series.length;
    if (len === 0) return null;
    const c = this.cursor;
    if (c.inside && c.index >= 0 && c.index < len) return c.index;
    return len - 1;
  }

  /**
   * "Nice" price ticks: 1, 2, 2.5 or 5 times a power of ten.
   *
   * Evenly dividing the range instead produces axis labels like 1.03847 that
   * nobody can read at a glance.
   */
  private priceTicks(): number[] {
    return priceTicksFor(this.viewport);
  }

  /** Bar indices to label on the time axis, spaced by pixels not by count. */
  private timeTicks(): number[] {
    const vp = this.viewport;
    const { from, to } = vp.visibleRange(this.series.length);
    if (to <= from) return [];
    const minPx = 84;
    const stride = Math.max(1, Math.ceil(minPx / vp.barWidth));
    const out: number[] = [];
    for (let i = Math.ceil(from / stride) * stride; i < to; i += stride) out.push(i);
    return out;
  }

  /**
   * Decimal places follow the instrument's magnitude.
   *
   * v39 shipped a bug where a $64,706 crypto stop rendered as "-15,741 pips"
   * because a forex fallback (`px > 50 ? 0.01 : 0.0001`) captured a crypto
   * price. Precision here is derived from the value on screen and never from a
   * globally-held asset class.
   */
  private formatPrice(p: number): string {
    const abs = Math.abs(p);
    const dp = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
    return p.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  /** Label granularity follows MEASURED bar spacing, never the UI timeframe. */
  private formatTime(ms: number, spacing: number, full = false): string {
    const d = new Date(ms);
    const intraday = spacing > 0 && spacing < 24 * 3600 * 1000;
    if (full) {
      /* The crosshair readout names ONE bar, so it always carries the year —
         the daily branch already did, and the intraday branch did not, which
         is the readout you use when scrolled back through the archive. */
      return intraday
        ? d.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
    return intraday
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

/** Vertical breathing room inside each pane, so a line never rides its border. */
const PANE_PAD = 6;

/**
 * Volume, in the units people say out loud.
 *
 * Separate from `formatPaneValue` because volume is the one quantity here that
 * is routinely eight digits, and "123644000" is not a reading — every venue,
 * including the one this chart is drawn from, prints it as 123.6M.
 */
function abbreviateVolume(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return formatPaneValue(v);
}

/**
 * Format a pane's last value for its axis tag.
 *
 * Significant figures rather than fixed decimals, because one tag renders both
 * an ADX of 31.4 and an ATR of 0.00042 and neither "31" nor "0.00" is a
 * reading.
 */
function formatPaneValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  return v.toPrecision(2);
}
