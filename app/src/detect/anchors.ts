/**
 * Levels price was already watching before any pattern formed.
 *
 * Everything in `structure.ts`, `zones.ts` and `formations.ts` derives a level
 * from a SHAPE price traced out. The levels here are prior: a round number is
 * round whatever the chart did, yesterday's high was yesterday's high, and the
 * 0.618 of the last leg is arithmetic on two pivots. They are the levels a
 * second trader looking at the same instrument would have drawn without seeing
 * any of this terminal's detections, which is exactly why they matter.
 *
 * All five are STATE, not events — a level does not happen, it is simply
 * there. So every detection here is `neutral` and none of them will ever enter
 * a directional record in `setup/simulate.ts`. That is correct and it is worth
 * being explicit about: their value is as anchors for the things that ARE
 * events (see `candles.ts`, which gates on exactly this kind of level) and as
 * confluence members, not as trades of their own.
 *
 * WHAT IS NOT HERE
 * Camarilla and Woodie pivots. They are the same five bars of input run
 * through different constants, they would triple the number of horizontal
 * lines on the chart, and no reading of the record could tell them apart from
 * the classic set. One pivot formula, drawn clearly.
 */

import { anchoredVwap, atr } from "../chart/indicators";
import { alternate, findPivots, swingFloor, type Pivot } from "./pivots";
import { clamp01, px, type Detection, type DetectInput, type Shape } from "./types";

/* ────────────────────────────────────────────────────────── round numbers ── */

export interface RoundOptions {
  /** A step must be at least this many ATR apart to be worth drawing. */
  minAtr?: number;
  /** Levels drawn either side of the current price. */
  each?: number;
}

/**
 * The 1 / 2.5 / 5 x 10^k ladder.
 *
 * A fixed step cannot work across a terminal that trades gold at 3,400 and a
 * token at 0.000018. The smallest rung of this ladder that is at least
 * `minAtr` ATR wide is the one a trader on this instrument would actually be
 * watching — below that the "round numbers" are closer together than a typical
 * bar and every one of them is hit constantly.
 */
export function roundStep(price: number, unit: number, minAtr: number): number {
  if (!(price > 0) || !(unit > 0)) return 0;
  const target = unit * minAtr;
  const mantissas = [1, 2.5, 5];
  for (let k = -8; k <= 9; k++) {
    const decade = Math.pow(10, k);
    for (const m of mantissas) {
      const step = m * decade;
      if (step >= target) return step;
    }
  }
  return 0;
}

export function detectRoundNumbers(
  data: DetectInput,
  opts: RoundOptions = {},
  len = data.c.length,
): Detection[] {
  const minAtr = opts.minAtr ?? 2;
  const each = opts.each ?? 2;
  if (len < 20) return [];

  const price = data.c[len - 1] as number;
  const a = atr(data.h, data.l, data.c, 14, len);
  const unit = a[len - 1] as number;
  const step = roundStep(price, unit, minAtr);
  if (!(step > 0)) return [];

  const base = Math.round(price / step) * step;
  const out: Detection[] = [];

  for (let k = -each; k <= each; k++) {
    const level = base + k * step;
    if (level <= 0) continue;
    /* How often price has actually stalled here, so the level arrives with
       evidence rather than as an assertion that round numbers matter. */
    let touches = 0;
    for (let i = Math.max(0, len - 400); i < len; i++) {
      if ((data.l[i] as number) <= level && (data.h[i] as number) >= level) touches++;
    }
    out.push({
      id: `round-${level.toFixed(8)}`,
      kind: "round-level",
      label: "Round number",
      direction: "neutral",
      from: Math.max(0, len - 400),
      to: len - 1,
      confidence: clamp01(0.2 + 0.3 * clamp01(touches / 20)),
      reason:
        `${px(level)} on a ${px(step)} ladder — the coarsest round step that is still at least ` +
        `${minAtr} ATR wide on this instrument. Traded through ${touches} times in the last ` +
        `${Math.min(400, len)} bars, which is the only evidence offered that it matters.`,
      shapes: [{ type: "level", x0: Math.max(0, len - 120), y: level, tone: "neutral", label: px(level), dashed: true }],
    });
  }

  return out;
}

/* ────────────────────────────────────────────────────── fibs and the OTE ── */

export interface FibOptions {
  /** Ratios drawn on the leg. */
  ratios?: readonly number[];
  /** The optimal-trade-entry band, as [from, to] retracement. */
  ote?: readonly [number, number];
}

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786] as const;

/**
 * Retracement of the most recent completed impulse leg.
 *
 * The leg is the last confirmed swing-to-swing move, so this re-anchors itself
 * as structure develops rather than staying pinned to a leg the operator drew
 * a week ago. Premium and discount are stated relative to the leg's midpoint,
 * which is all "premium" means once the jargon is removed.
 */
export function detectFibs(
  data: DetectInput,
  opts: FibOptions = {},
  len = data.c.length,
): Detection[] {
  const ratios = opts.ratios ?? FIB_RATIOS;
  const [oteFrom, oteTo] = opts.ote ?? [0.618, 0.786];
  if (len < 40) return [];

  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len),
  ).filter((p) => p.confirmedAt <= len - 1);
  if (pivots.length < 2) return [];

  const b = pivots[pivots.length - 1] as Pivot;
  const a = pivots[pivots.length - 2] as Pivot;
  if (a.kind === b.kind) return [];

  const up = b.kind === "high";
  const from = a.price;
  const to = b.price;
  const height = to - from;
  if (!(Math.abs(height) > 0)) return [];

  const priceAt = (r: number): number => to - height * r;
  const shapes: Shape[] = [
    {
      type: "box",
      x0: b.index,
      x1: len - 1,
      y0: Math.min(priceAt(oteFrom), priceAt(oteTo)),
      y1: Math.max(priceAt(oteFrom), priceAt(oteTo)),
      tone: up ? "bull" : "bear",
      extend: true,
      label: "OTE",
    },
  ];
  for (const r of ratios) {
    shapes.push({
      type: "level",
      x0: a.index,
      y: priceAt(r),
      tone: "neutral",
      label: r.toFixed(3),
      dashed: true,
    });
  }

  const mid = priceAt(0.5);
  const now = data.c[len - 1] as number;
  const inPremium = up ? now > mid : now < mid;

  return [
    {
      id: `fib-${a.index}-${b.index}`,
      kind: "fib",
      label: up ? "Retracement of the up leg" : "Retracement of the down leg",
      direction: "neutral",
      from: a.index,
      to: b.index,
      confidence: clamp01(0.3 + 0.3 * clamp01(Math.abs(height) / (Math.abs(to) * 0.05 || 1))),
      reason:
        `Anchored to the last completed leg: ${px(from)} (bar ${a.index}) to ${px(to)} ` +
        `(bar ${b.index}). Midpoint ${px(mid)}, so price at ${px(now)} is in ` +
        `${inPremium ? "premium" : "discount"}. The OTE band is ${px(priceAt(oteTo))} to ` +
        `${px(priceAt(oteFrom))}. These are arithmetic on two pivots — the levels are exact, ` +
        `whether the market cares about them is not claimed.`,
      shapes,
    },
  ];
}

/* ────────────────────────────────────────── pivot points and prior periods ── */

/** UTC day index of a timestamp. */
const dayOf = (ms: number): number => Math.floor(ms / 86_400_000);

/**
 * Split the series into calendar-day blocks from the bar timestamps.
 *
 * From `t`, not from a bar count: a fixed block size drifts across weekends
 * and holidays and would eventually be reporting "yesterday's high" from the
 * middle of a Tuesday.
 */
function dayBlocks(data: DetectInput, len: number): { start: number; end: number; day: number }[] {
  const out: { start: number; end: number; day: number }[] = [];
  let start = 0;
  let day = dayOf(data.t[0] as number);
  for (let i = 1; i < len; i++) {
    const d = dayOf(data.t[i] as number);
    if (d !== day) {
      out.push({ start, end: i - 1, day });
      start = i;
      day = d;
    }
  }
  out.push({ start, end: len - 1, day });
  return out;
}

function extremes(data: DetectInput, from: number, to: number) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, data.h[i] as number);
    lo = Math.min(lo, data.l[i] as number);
  }
  return { hi, lo, close: data.c[to] as number };
}

/**
 * Classic floor pivots from the last CLOSED day.
 *
 * Refuses above the daily timeframe, where each bar is already a day and a
 * "daily pivot" would be computed from a single bar — arithmetic that runs
 * fine and means nothing.
 */
export function detectPivotPoints(
  data: DetectInput,
  _opts: Record<string, never> = {},
  len = data.c.length,
): Detection[] {
  if (len < 10) return [];
  const blocks = dayBlocks(data, len);
  if (blocks.length < 2) return [];

  const prev = blocks[blocks.length - 2] as { start: number; end: number; day: number };
  if (prev.end - prev.start < 3) return [];

  const { hi, lo, close } = extremes(data, prev.start, prev.end);
  const pp = (hi + lo + close) / 3;
  const r1 = 2 * pp - lo;
  const s1 = 2 * pp - hi;
  const r2 = pp + (hi - lo);
  const s2 = pp - (hi - lo);
  const today = blocks[blocks.length - 1] as { start: number };

  const rows: { name: string; y: number }[] = [
    { name: "R2", y: r2 },
    { name: "R1", y: r1 },
    { name: "PP", y: pp },
    { name: "S1", y: s1 },
    { name: "S2", y: s2 },
  ];

  return [
    {
      id: `pivots-${prev.day}`,
      kind: "pivot-level",
      label: "Floor pivots",
      direction: "neutral",
      from: prev.start,
      to: prev.end,
      confidence: 0.35,
      reason:
        `Classic pivots from the previous session: high ${px(hi)}, low ${px(lo)}, close ${px(close)} ` +
        `over ${prev.end - prev.start + 1} bars. PP ${px(pp)}, R1 ${px(r1)}, S1 ${px(s1)}. ` +
        `Computed, not predicted — these are the levels a second trader would have on their chart.`,
      shapes: rows.map(
        (r): Shape => ({
          type: "level",
          x0: today.start,
          y: r.y,
          tone: r.name === "PP" ? "accent" : "neutral",
          label: r.name,
          dashed: r.name !== "PP",
        }),
      ),
    },
  ];
}

/** Prior day and prior week high/low — the levels everyone can see. */
export function detectPriorLevels(
  data: DetectInput,
  _opts: Record<string, never> = {},
  len = data.c.length,
): Detection[] {
  if (len < 10) return [];
  const blocks = dayBlocks(data, len);
  if (blocks.length < 2) return [];

  const out: Detection[] = [];
  const prev = blocks[blocks.length - 2] as { start: number; end: number; day: number };
  const today = blocks[blocks.length - 1] as { start: number };

  const push = (name: string, from: number, to: number, id: string): void => {
    if (to - from < 1) return;
    const { hi, lo } = extremes(data, from, to);
    /* Untouched matters more than touched: a prior extreme price has already
       come back to has done its work. */
    let takenHigh = false;
    let takenLow = false;
    for (let i = today.start; i < len; i++) {
      if ((data.h[i] as number) >= hi) takenHigh = true;
      if ((data.l[i] as number) <= lo) takenLow = true;
    }
    out.push({
      id,
      kind: "prior-level",
      label: `${name} high / low`,
      direction: "neutral",
      from,
      to,
      confidence: clamp01(0.3 + (takenHigh && takenLow ? 0 : 0.25)),
      reason:
        `${name}: high ${px(hi)}${takenHigh ? " (taken)" : " (untouched)"}, low ${px(lo)}` +
        `${takenLow ? " (taken)" : " (untouched)"}, over bars ${from}-${to}. ` +
        `An untouched prior extreme is resting liquidity; a taken one has already done its work.`,
      shapes: [
        {
          type: "level",
          x0: today.start,
          y: hi,
          tone: takenHigh ? "neutral" : "bear",
          label: `${name}H`,
          dashed: takenHigh,
        },
        {
          type: "level",
          x0: today.start,
          y: lo,
          tone: takenLow ? "neutral" : "bull",
          label: `${name}L`,
          dashed: takenLow,
        },
      ],
    });
  };

  push("Prior day", prev.start, prev.end, `prior-day-${prev.day}`);

  /* The previous calendar week, when there is one in the loaded history. */
  const weekOf = (ms: number): number => Math.floor((ms + 4 * 86_400_000) / (7 * 86_400_000));
  const thisWeek = weekOf(data.t[len - 1] as number);
  let wStart = -1;
  let wEnd = -1;
  for (let i = 0; i < len; i++) {
    const w = weekOf(data.t[i] as number);
    if (w === thisWeek - 1) {
      if (wStart < 0) wStart = i;
      wEnd = i;
    }
  }
  if (wStart >= 0 && wEnd > wStart) push("Prior week", wStart, wEnd, `prior-week-${thisWeek - 1}`);

  return out;
}

/* ──────────────────────────────────────────────────────── anchored VWAP ── */

export interface AvwapOptions {
  /** Anchors drawn, newest swing first. */
  maxAnchors?: number;
}

/**
 * VWAP anchored to the recent significant swings.
 *
 * `anchoredVwap()` has existed since v50 and nothing has ever chosen an anchor
 * for it: it was a manual tool, so in practice it was never used. The anchors
 * that carry meaning are the ones everyone would pick — the last major swing
 * high and the last major swing low, which is where positions were opened at a
 * price the whole market can compute.
 */
export function detectAnchoredVwap(
  data: DetectInput,
  opts: AvwapOptions = {},
  len = data.c.length,
): Detection[] {
  const maxAnchors = opts.maxAnchors ?? 2;
  if (len < 40) return [];

  let anyVolume = 0;
  for (let i = 0; i < len; i++) anyVolume += (data.v[i] as number) || 0;
  /* No volume, no volume-weighted anything. Returning a plain average under a
     VWAP label would be the single most misleading thing in this file. */
  if (anyVolume <= 0) return [];

  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 4, right: 4, minProminence: floor }, len),
  ).filter((p) => p.confirmedAt <= len - 1);

  const lastHigh = [...pivots].reverse().find((p) => p.kind === "high");
  const lastLow = [...pivots].reverse().find((p) => p.kind === "low");
  const anchors = [lastHigh, lastLow].filter((p): p is Pivot => p !== undefined).slice(0, maxAnchors);

  const out: Detection[] = [];
  const now = data.c[len - 1] as number;

  for (const p of anchors) {
    if (len - p.index < 10) continue;
    const series = anchoredVwap(data.h, data.l, data.c, data.v, p.index, len);
    const end = series[len - 1] as number;
    const start = series[p.index] as number;
    if (!Number.isFinite(end) || !Number.isFinite(start)) continue;
    const above = now > end;

    out.push({
      id: `avwap-${p.kind}-${p.index}`,
      kind: "avwap",
      label: `VWAP from the swing ${p.kind}`,
      direction: "neutral",
      from: p.index,
      to: len - 1,
      confidence: clamp01(0.3 + 0.25 * clamp01((len - p.index) / 200)),
      reason:
        `Volume-weighted average price since bar ${p.index} (${px(p.price)}), now ${px(end)}. ` +
        `Price is ${above ? "above" : "below"} it, so everyone who bought since that swing is on ` +
        `average ${above ? "in profit" : "underwater"}. That is an accounting fact, not a signal.`,
      shapes: [
        { type: "line", x0: p.index, y0: start, x1: len - 1, y1: end, tone: p.kind === "high" ? "bear" : "bull", extend: false, label: "aVWAP" },
        { type: "level", x0: len - 1, y: end, tone: "neutral", label: "aVWAP", dashed: true },
      ],
    });
  }

  return out;
}
