/**
 * Session ranges — Asia, London and New York, drawn on the chart.
 *
 * WHY THIS IS A DETECTOR AND NOT A DECORATION
 * `data/sessionmap.ts` has modelled the four session windows for versions, and
 * the Sessions desk renders an activity grid from them. Neither of those puts
 * anything on the chart, so the most reliable intraday structure there is —
 * where price traded while Tokyo was the only book open, and what happened to
 * that range when London arrived — has been sitting one import away from the
 * chart the whole time.
 *
 * The Asian range in particular is not folklore: it is a genuinely narrow
 * window that a genuinely wider one then trades against, and the high and low
 * of it are levels a lot of participants can see. That makes it exactly the
 * kind of thing worth drawing and exactly the kind of thing worth being
 * careful about, which is what the two refusals below are for.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO DO
 *
 * **No "judas swing" call.** The name for a session that pokes one side of the
 * prior range before running the other is a story told after the fact, and
 * fires on roughly half of all sessions by construction. A range that was
 * swept is reported as a sweep — `detect/liquidity.ts` finds that from the
 * price action itself, with an invalidation attached, and does not need the
 * hour of day to justify it.
 *
 * **Nothing on a daily chart or above.** A session range on a chart whose bars
 * are longer than the session is a box drawn around one candle. The detector
 * returns nothing rather than something meaningless, and says so.
 * ──────────────────────────────────────────────────────────────────────────── */

import { SESSIONS, sessionOpenAt, type SessionWindow } from "../data/sessionmap";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";
import { saturate } from "./calibrate";

export interface SessionRangeOptions {
  /** Which sessions to draw. Defaults to Tokyo, London and New York. */
  sessions?: readonly string[];
  /** How many completed sessions back to draw. */
  days?: number;
  maxResults?: number;
}

/** Sydney is omitted by default: it overlaps Tokyo almost entirely. */
const DEFAULT_SESSIONS = ["tokyo", "london", "newyork"];

/**
 * Longest bar this is meaningful on.
 *
 * A session is at most nine hours. Four-hour bars give two or three per
 * session, which is already coarse; anything longer is a box around one
 * candle. Six hours is the line, and it is checked against the DATA rather
 * than against a timeframe string so a mislabelled feed cannot slip past.
 */
export const MAX_BAR_MS = 6 * 3_600_000;

export function detectSessionRanges(
  data: DetectInput,
  opts: SessionRangeOptions = {},
  len = data.c.length,
): Detection[] {
  const wanted = opts.sessions ?? DEFAULT_SESSIONS;
  const days = opts.days ?? 3;
  const maxResults = opts.maxResults ?? 9;
  if (len < 4) return [];

  /* Median bar spacing, not the last gap: one short final bar on a live feed
     would otherwise decide the whole question. */
  const gaps: number[] = [];
  for (let i = 1; i < len; i++) gaps.push((data.t[i] as number) - (data.t[i - 1] as number));
  gaps.sort((a, b) => a - b);
  const barMs = gaps[Math.floor(gaps.length / 2)] ?? 0;
  if (!Number.isFinite(barMs) || barMs <= 0 || barMs > MAX_BAR_MS) return [];

  const byId = new Map(SESSIONS.map((s) => [s.id, s]));

  /* Every block first, so a session's height can be judged against what a
     session on THIS series normally is. Without a comparison the confidence
     had nothing to say: see `toDetection`. */
  const found: { win: SessionWindow; block: Block }[] = [];
  for (const id of wanted) {
    const win = byId.get(id);
    if (win === undefined) continue;
    for (const block of blocksFor(data, win, len, days)) found.push({ win, block });
  }
  if (found.length === 0) return [];

  const heights = found.map((f) => f.block.hi - f.block.lo).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 0;

  const out = found.map((f) => toDetection(data, f.win, f.block, len, typicalHeight));
  return out.sort((a, b) => a.from - b.from).slice(-maxResults);
}

interface Block {
  readonly start: number;
  readonly end: number;
  readonly hi: number;
  readonly lo: number;
}

/**
 * Contiguous runs of bars inside one session window, newest `days` of them.
 *
 * A run ENDS when a bar falls outside the window, which handles the day
 * boundary without any date arithmetic — and handles a weekend gap, a
 * half-day, and a feed that simply skipped an hour, all the same way.
 */
function blocksFor(
  data: DetectInput,
  win: SessionWindow,
  len: number,
  days: number,
): Block[] {
  const blocks: Block[] = [];
  let start = -1;
  let hi = -Infinity;
  let lo = Infinity;

  const close = (end: number): void => {
    if (start >= 0 && end >= start) blocks.push({ start, end, hi, lo });
    start = -1;
    hi = -Infinity;
    lo = Infinity;
  };

  for (let i = 0; i < len; i++) {
    const t = data.t[i] as number;
    const inside = sessionOpenAt(win, new Date(t).getUTCHours());
    if (inside) {
      if (start < 0) start = i;
      hi = Math.max(hi, data.h[i] as number);
      lo = Math.min(lo, data.l[i] as number);
    } else {
      close(i - 1);
    }
  }
  close(len - 1);

  /* Only sessions with real content. A single bar clipped by the edge of the
     loaded window is not a session range, it is one candle. */
  return blocks.filter((b) => b.end > b.start).slice(-days);
}

function toDetection(
  data: DetectInput,
  win: SessionWindow,
  block: Block,
  len: number,
  /** Median session height on this series — the yardstick for "tight". */
  typicalHeight: number,
): Detection {
  /* What happened AFTER the session closed, which is the part worth knowing.
     A range nobody has traded against yet is context; one that has been taken
     out on one side is a level that did something. */
  let brokeUp = false;
  let brokeDown = false;
  for (let i = block.end + 1; i < len; i++) {
    const c = data.c[i] as number;
    if (c > block.hi) brokeUp = true;
    if (c < block.lo) brokeDown = true;
    if (brokeUp && brokeDown) break;
  }

  const bars = block.end - block.start + 1;
  const shapes: Shape[] = [
    {
      type: "box",
      x0: block.start - 0.5,
      x1: block.end + 0.5,
      y0: block.lo,
      y1: block.hi,
      tone: "accent",
      dashed: true,
      label: win.name,
    },
    { type: "level", x0: block.end, y: block.hi, tone: "neutral", dashed: true },
    { type: "level", x0: block.end, y: block.lo, tone: "neutral", dashed: true },
  ];

  /* Confidence here means "is this a well-formed session range", NOT "is it
     about to break". A session with plenty of bars in it is a range worth
     drawing; one clipped to three bars by the edge of the loaded window is
     the same shape with much less behind it.

     WHY THERE IS A SECOND TERM NOW. It was `0.4 + 0.4 * clamp01(bars / 8)`,
     and a session is nine hours, so on any timeframe this detector is allowed
     to run at — hourly and below — `bars` is always at least eight. Every
     session range on every series reported exactly 0.80: a constant, published
     as a measurement, and caught by the cross-detector guard in
     test/confidence.test.ts rather than by anything here.

     Height against the MEDIAN session on this same series is the input that
     carries information and needs no threshold: a tight session is a cleaner
     box and its edges are levels more people can see, while a session that
     sprawled wider than usual is a box around a trend. */
  const height = block.hi - block.lo;
  const relative = typicalHeight > 0 ? height / typicalHeight : 1;
  const tightness = clamp01(1 - (relative - 1) / 2);
  const confidence = clamp01(0.3 + 0.3 * saturate(bars, 6) + 0.3 * tightness);

  const both = brokeUp && brokeDown;
  return {
    id: `session-${win.id}-${block.start}`,
    kind: "session-range",
    label: `${win.name} range`,
    /* Neutral unless exactly ONE side has gone. Both sides taken means price
       has traded through the range in each direction, which says nothing at
       all — and calling that a direction would be the easiest way for this
       detector to mislead. */
    direction: both ? "neutral" : brokeUp ? "long" : brokeDown ? "short" : "neutral",
    from: block.start,
    to: block.end,
    confidence,
    reason: `${win.name} traded ${px(block.lo)}–${px(block.hi)} over ${bars} bars${
      both
        ? "; both sides have since been taken"
        : brokeUp
          ? "; the high has since been cleared"
          : brokeDown
            ? "; the low has since been cleared"
            : "; still intact"
    }`,
    shapes,
  };
}
