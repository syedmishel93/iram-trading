/**
 * Time, rather than price.
 *
 * `sessionrange.ts` draws where price traded during Tokyo, London and New
 * York. This draws the narrower windows inside those sessions where the
 * business is actually done, and the range the first minutes of a session set.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HONESTY PROBLEM WITH KILLZONES, AND WHAT IS DONE ABOUT IT
 *
 * A killzone is a claim that some hours matter more than others. That claim is
 * either true on an instrument or it is not, and it is entirely measurable —
 * so this detector does not assert it. Each window is published with the
 * MEASURED share of the day's range that has historically been travelled
 * inside it, computed from the loaded bars. If the London open window on this
 * symbol carries 11% of the day's range across 9% of the day, the reason
 * string says so, and there is nothing left to believe.
 *
 * That measurement is also the confidence. A window that does no more than its
 * share of the clock scores near zero and is drawn faintly, which is the
 * correct visual weight for "this hour is not special here".
 *
 * The windows themselves are the conventional ones, taken from
 * `data/sessionmap.ts` opens rather than retyped, so a change to the session
 * model moves the killzones with it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * OPENING RANGE
 *
 * The first `orbBars` bars of a session, drawn as a box, with the break
 * published as its own directional event when price closes outside it. The
 * box is state and neutral; the break is the event and carries the record —
 * the same split `ranges.ts` makes and for the same reason.
 *
 * Both refuse above the four-hour timeframe. A killzone on a daily chart is a
 * band drawn around one candle, and an opening range needs several bars inside
 * the window to be a range at all.
 */

import { SESSIONS } from "../data/sessionmap";
import { clamp01, px, type Detection, type DetectInput } from "./types";

/** Longest bar either detector is meaningful on. */
export const MAX_BAR_MS = 4 * 3_600_000;

export interface TimeWindowOptions {
  /** How many completed days back to draw. */
  days?: number;
  /** Hours after the session open that the killzone covers. */
  killzoneHours?: number;
  /** Bars that make up the opening range. */
  orbBars?: number;
  maxResults?: number;
}

const DEFAULTS = { days: 3, killzoneHours: 2, orbBars: 3, maxResults: 12 };

/** Median gap between bars, which is the only honest read of the timeframe. */
function barMs(data: DetectInput, len: number): number {
  const gaps: number[] = [];
  for (let i = Math.max(1, len - 60); i < len; i++) {
    const g = (data.t[i] as number) - (data.t[i - 1] as number);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] as number;
}

const dayOf = (ms: number): number => Math.floor(ms / 86_400_000);
const hourOf = (ms: number): number => new Date(ms).getUTCHours();

/** The killzone windows: the hours after each major open, in UTC. */
export function killzones(hours: number): { id: string; name: string; from: number; to: number }[] {
  return SESSIONS.filter((s) => s.id === "london" || s.id === "newyork" || s.id === "tokyo").map(
    (s) => ({
      id: `${s.id}-open`,
      name: `${s.name} open`,
      from: s.openUtc,
      to: (s.openUtc + hours) % 24,
    }),
  );
}

/** Is `hour` inside [from, to), wrapping at midnight? */
export function inWindow(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

export function detectKillzones(
  data: DetectInput,
  opts: TimeWindowOptions = {},
  len = data.c.length,
): Detection[] {
  const days = opts.days ?? DEFAULTS.days;
  const hours = opts.killzoneHours ?? DEFAULTS.killzoneHours;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  if (len < 30) return [];

  const step = barMs(data, len);
  /* A window shorter than one bar cannot contain a range, and a bar longer
     than the window makes the box meaningless. Refuse rather than draw. */
  if (!(step > 0) || step > MAX_BAR_MS || step > hours * 3_600_000) return [];

  const zones = killzones(hours);
  const out: Detection[] = [];

  /* One pass over the whole history per zone, to measure what share of each
     day's travel happened inside it. This is the number that decides whether
     the zone is worth drawing at all. */
  const share = new Map<string, { inside: number; total: number; clock: number }>();
  for (const z of zones) share.set(z.id, { inside: 0, total: 0, clock: hours / 24 });

  for (let i = 1; i < len; i++) {
    const move = Math.abs((data.c[i] as number) - (data.c[i - 1] as number));
    if (!Number.isFinite(move)) continue;
    const h = hourOf(data.t[i] as number);
    for (const z of zones) {
      const s = share.get(z.id);
      if (!s) continue;
      s.total += move;
      if (inWindow(h, z.from, z.to)) s.inside += move;
    }
  }

  const lastDay = dayOf(data.t[len - 1] as number);

  for (const z of zones) {
    const s = share.get(z.id);
    if (!s || s.total <= 0) continue;
    const measured = s.inside / s.total;
    const lift = measured / s.clock;

    for (let d = 0; d < days; d++) {
      const day = lastDay - d;
      let start = -1;
      let end = -1;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < len; i++) {
        const t = data.t[i] as number;
        if (dayOf(t) !== day) continue;
        if (!inWindow(hourOf(t), z.from, z.to)) continue;
        if (start < 0) start = i;
        end = i;
        hi = Math.max(hi, data.h[i] as number);
        lo = Math.min(lo, data.l[i] as number);
      }
      if (start < 0 || end <= start) continue;

      out.push({
        id: `killzone-${z.id}-${day}`,
        kind: "killzone",
        label: z.name,
        direction: "neutral",
        from: start,
        to: end,
        /* The measurement IS the confidence. A window that carries no more
           than its share of the clock scores near zero and is drawn faint. */
        confidence: clamp01((lift - 1) / 1.5),
        reason:
          `${String(z.from).padStart(2, "0")}:00-${String(z.to).padStart(2, "0")}:00 UTC. ` +
          `Measured on the loaded history, ${(measured * 100).toFixed(1)}% of all price travel ` +
          `happened in this window, against ${(s.clock * 100).toFixed(1)}% of the clock — ` +
          `${lift >= 1.05 ? `${lift.toFixed(2)}x its share` : lift <= 0.95 ? `below its share` : `about its share`}. ` +
          `The window is drawn; whether it is special is that number, not the name.`,
        shapes: [
          {
            type: "box",
            x0: start - 0.5,
            x1: end + 0.5,
            y0: lo,
            y1: hi,
            tone: "accent",
            dashed: true,
            label: z.name,
          },
        ],
      });
    }
  }

  out.sort((a, b) => a.to - b.to);
  return out.slice(-maxResults);
}

export function detectOpeningRange(
  data: DetectInput,
  opts: TimeWindowOptions = {},
  len = data.c.length,
): Detection[] {
  const days = opts.days ?? DEFAULTS.days;
  const orbBars = opts.orbBars ?? DEFAULTS.orbBars;
  if (len < 30) return [];

  const step = barMs(data, len);
  if (!(step > 0) || step > MAX_BAR_MS) return [];

  const out: Detection[] = [];
  const lastDay = dayOf(data.t[len - 1] as number);
  const london = SESSIONS.find((s) => s.id === "london");
  if (!london) return [];

  for (let d = 0; d < days; d++) {
    const day = lastDay - d;
    let open = -1;
    for (let i = 0; i < len; i++) {
      const t = data.t[i] as number;
      if (dayOf(t) === day && hourOf(t) >= london.openUtc) {
        open = i;
        break;
      }
    }
    if (open < 0 || open + orbBars >= len) continue;

    let hi = -Infinity;
    let lo = Infinity;
    for (let i = open; i < open + orbBars; i++) {
      hi = Math.max(hi, data.h[i] as number);
      lo = Math.min(lo, data.l[i] as number);
    }
    if (!(hi > lo)) continue;
    const last = open + orbBars - 1;

    out.push({
      id: `orb-${day}`,
      kind: "opening-range",
      label: "Opening range",
      direction: "neutral",
      from: open,
      to: last,
      confidence: 0.35,
      reason:
        `The first ${orbBars} bars after the London open set ${px(lo)} to ${px(hi)}. ` +
        `Drawn with no side: the break below is the event that carries a record.`,
      shapes: [
        { type: "box", x0: open - 0.5, x1: last + 0.5, y0: lo, y1: hi, tone: "neutral", dashed: true, label: "OR" },
        { type: "level", x0: last, y: hi, tone: "neutral", label: "ORH", dashed: true },
        { type: "level", x0: last, y: lo, tone: "neutral", label: "ORL", dashed: true },
      ],
    });

    /* The break. Same day only — a close outside the opening range tomorrow is
       not a break of today's opening range, it is just a price. */
    for (let i = last + 1; i < len; i++) {
      if (dayOf(data.t[i] as number) !== day) break;
      const c = data.c[i] as number;
      const up = c > hi;
      const down = c < lo;
      if (!up && !down) continue;
      const bars = i - last;
      out.push({
        id: `orb-break-${day}-${i}`,
        kind: "opening-range",
        label: `Opening range break ${up ? "up" : "down"}`,
        direction: up ? "long" : "short",
        from: open,
        to: i,
        confidence: clamp01(0.4 + 0.25 * clamp01(1 - bars / 12)),
        reason:
          `Closed ${up ? "above" : "below"} the opening range at ${px(up ? hi : lo)}, ` +
          `${bars} bar${bars === 1 ? "" : "s"} after it was set.`,
        shapes: [
          { type: "box", x0: open - 0.5, x1: i, y0: lo, y1: hi, tone: "neutral", dashed: true },
          {
            type: "marker",
            x: i,
            y: up ? (data.h[i] as number) : (data.l[i] as number),
            tone: up ? "bull" : "bear",
            text: "ORB",
            above: up,
          },
        ],
      });
      break;
    }
  }

  return out;
}
