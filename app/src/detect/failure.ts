/**
 * Failure — the group defined by something not working.
 *
 * WHY THIS IS THE MOST PROMISING FILE IN THE DIRECTORY
 * Every other detector answers "what shape is this?". These answer "what just
 * stopped being true?", and that is a different and much rarer question. A
 * level breaking is common; a level breaking and then failing is not, because
 * it requires the market to have committed and then reversed the commitment.
 * Whatever else is true of the record these produce, the SAMPLE will be small
 * and the instances will be distinct, which is the opposite of the problem the
 * candle patterns had.
 *
 * FOUR EVENTS, ALL OF THEM CHEAP
 * Each is something the terminal already detects, going wrong:
 *
 *   spring        a range low broken, then reclaimed on the close
 *   upthrust      a range high broken, then reclaimed on the close
 *   failed-break  a structure break that price closed back through
 *   retest        a break that came back to the boundary and HELD
 *
 * plus one that is an order block resolving rather than failing:
 *
 *   mitigation    an order block price returned into and left the same way
 *
 * `retest` is the odd one out and is here deliberately: it is the complement
 * of `failed-break` over exactly the same population, so the two records
 * together answer "when this level breaks, does coming back to it help or is
 * it the tell that it was fake?" — which is one question, and neither
 * detection can answer it alone.
 *
 * THE RECLAIM WINDOW IS THE WHOLE DESIGN
 * A break that is reversed forty bars later is not a failed break, it is a
 * trend change. `reclaimBars` bounds it, and every detection states the bar
 * count it actually took, so the operator can see whether a given instance was
 * a sharp rejection or a slow grind back.
 */

import { atr } from "../chart/indicators";
import { detectStructure } from "./structure";
import { detectOrderBlocks } from "./zones";
import { detectRanges } from "./ranges";
import { clamp01, px, type Detection, type DetectInput } from "./types";

export interface FailureOptions {
  /** How long price has to close back through, in bars. */
  reclaimBars?: number;
  /** How close a retest must come to the broken boundary, in ATR. */
  retestAtr?: number;
  /** Per kind. */
  maxPerKind?: number;
  /** Bars of history to scan. */
  lookback?: number;
}

const DEFAULTS = { reclaimBars: 8, retestAtr: 0.4, maxPerKind: 4, lookback: 500 };

/** The horizontal edges of a detection drawn as a box. */
function boxEdges(d: Detection): { lo: number; hi: number } | null {
  const box = d.shapes.find((s) => s.type === "box");
  if (!box || box.type !== "box") return null;
  return { lo: Math.min(box.y0, box.y1), hi: Math.max(box.y0, box.y1) };
}

/**
 * Springs and upthrusts — Wyckoff's name for a range boundary that lied.
 *
 * Built on `detectRanges`, which already finds the sideways stretches and the
 * bar that leaves them. A spring is that departure being taken back: price
 * traded below the floor and then CLOSED back above it inside the window.
 *
 * The close is the test, not the wick. A bar whose low pierced the range and
 * whose close is still outside has not reclaimed anything, and counting it
 * would turn every deep wick into a signal.
 */
export function detectSprings(
  data: DetectInput,
  opts: FailureOptions = {},
  len = data.c.length,
): Detection[] {
  const reclaimBars = opts.reclaimBars ?? DEFAULTS.reclaimBars;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS.maxPerKind;
  if (len < 40) return [];

  const ranges = detectRanges(data, { maxResults: 6 }, len);
  const a = atr(data.h, data.l, data.c, 14, len);
  const out: Detection[] = [];

  for (const r of ranges) {
    const edges = boxEdges(r);
    if (!edges) continue;
    const { lo, hi } = edges;
    const height = hi - lo;
    if (!(height > 0)) continue;

    for (let i = r.to + 1; i < len; i++) {
      const barLow = data.l[i] as number;
      const barHigh = data.h[i] as number;
      const unit = (a[i] as number) || height * 0.1;

      for (const side of ["low", "high"] as const) {
        const broke = side === "low" ? barLow < lo : barHigh > hi;
        if (!broke) continue;
        const edge = side === "low" ? lo : hi;
        const depth = side === "low" ? lo - barLow : barHigh - hi;

        /* Reclaimed = a CLOSE back on the original side, inside the window. */
        let reclaimAt = -1;
        for (let j = i; j < Math.min(len, i + reclaimBars + 1); j++) {
          const c = data.c[j] as number;
          if (side === "low" ? c > lo : c < hi) {
            reclaimAt = j;
            break;
          }
          /* Gone for good: a close further out on a later bar means this was a
             breakout, and calling it a failed one because price eventually came
             back would be reading the outcome into the setup. */
          if (side === "low" ? c < barLow : c > barHigh) {
            reclaimAt = -2;
            break;
          }
        }
        if (reclaimAt < 0) continue;

        const spring = side === "low";
        const bars = reclaimAt - i;
        out.push({
          id: `${spring ? "spring" : "upthrust"}-${i}`,
          kind: spring ? "spring" : "upthrust",
          label: spring ? "Spring" : "Upthrust",
          direction: spring ? "long" : "short",
          from: r.from,
          to: reclaimAt,
          confidence: clamp01(
            0.4 + 0.25 * clamp01(depth / unit) + 0.2 * clamp01(1 - bars / (reclaimBars + 1)),
          ),
          reason:
            `Price traded ${px(depth)} (${(depth / unit).toFixed(1)} ATR) ${spring ? "below" : "above"} ` +
            `the ${bars === 0 ? "range" : "range"} ${spring ? "floor" : "ceiling"} at ${px(edge)}, then ` +
            `closed back inside ${bars === 0 ? "on the same bar" : `${bars} bar${bars === 1 ? "" : "s"} later`}. ` +
            `The break was not held.`,
          shapes: [
            { type: "box", x0: r.from, x1: reclaimAt, y0: lo, y1: hi, tone: "neutral", dashed: true },
            { type: "level", x0: r.from, y: edge, tone: spring ? "bull" : "bear", label: spring ? "floor" : "ceiling", dashed: false },
            {
              type: "marker",
              x: i,
              y: spring ? barLow : barHigh,
              tone: spring ? "bull" : "bear",
              text: spring ? "spring" : "upthrust",
              above: !spring,
            },
          ],
        });
        break;
      }
    }
  }

  return capPerKind(out, maxPerKind);
}

/**
 * A structure break that did not hold, and a structure break that did.
 *
 * Both read the same population — every BOS and CHoCH `structure.ts` reports —
 * and split it on what happened next. A break whose level price closed back
 * through is a `failed-break` with the opposite side; a break price returned
 * to and respected is a `retest` with the same side.
 *
 * The two are mutually exclusive by construction, checked in that order,
 * because a level that was lost was never retested successfully.
 */
export function detectFailedBreaks(
  data: DetectInput,
  opts: FailureOptions = {},
  len = data.c.length,
): Detection[] {
  const reclaimBars = opts.reclaimBars ?? DEFAULTS.reclaimBars;
  const retestAtr = opts.retestAtr ?? DEFAULTS.retestAtr;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS.maxPerKind;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  if (len < 40) return [];

  const breaks = detectStructure(data, {}, len).filter(
    (d) => (d.kind === "bos" || d.kind === "choch") && d.to >= len - lookback,
  );
  const a = atr(data.h, data.l, data.c, 14, len);
  const out: Detection[] = [];

  for (const b of breaks) {
    /* The level that was broken, taken from the drawn shape rather than
       recomputed: whatever the chart shows as the broken level is the level
       whose failure is being tested. */
    const lvl = b.shapes.find((s) => s.type === "level");
    const line = b.shapes.find((s) => s.type === "line");
    const level =
      lvl && lvl.type === "level" ? lvl.y : line && line.type === "line" ? line.y1 : NaN;
    if (!Number.isFinite(level)) continue;

    const long = b.direction === "long";
    const unit = (a[b.to] as number) || 0;
    if (!(unit > 0)) continue;

    let failedAt = -1;
    let retestAt = -1;

    for (let j = b.to + 1; j < Math.min(len, b.to + reclaimBars + 1); j++) {
      const c = data.c[j] as number;
      if (long ? c < level : c > level) {
        failedAt = j;
        break;
      }
      const reach = long ? (data.l[j] as number) : (data.h[j] as number);
      if (retestAt < 0 && Math.abs(reach - level) <= unit * retestAtr) retestAt = j;
    }

    if (failedAt >= 0) {
      const bars = failedAt - b.to;
      out.push({
        id: `failed-break-${b.to}`,
        kind: "failed-break",
        label: `Failed ${b.kind === "bos" ? "break of structure" : "change of character"}`,
        direction: long ? "short" : "long",
        from: b.from,
        to: failedAt,
        confidence: clamp01(0.4 + 0.3 * clamp01(1 - bars / (reclaimBars + 1)) + 0.15 * b.confidence),
        reason:
          `${b.label} broke ${px(level)} on bar ${b.to}, then price closed back through it ` +
          `${bars} bar${bars === 1 ? "" : "s"} later. Reported on the side of the reversal, because ` +
          `the break is what failed.`,
        shapes: [
          { type: "level", x0: b.from, y: level, tone: long ? "bear" : "bull", label: "lost", dashed: false },
          {
            type: "marker",
            x: failedAt,
            y: long ? (data.h[failedAt] as number) : (data.l[failedAt] as number),
            tone: long ? "bear" : "bull",
            text: "failed",
            above: long,
          },
        ],
      });
      continue;
    }

    if (retestAt >= 0) {
      const bars = retestAt - b.to;
      out.push({
        id: `retest-${b.to}`,
        kind: "retest",
        label: "Break and retest",
        direction: long ? "long" : "short",
        from: b.from,
        to: retestAt,
        confidence: clamp01(0.4 + 0.25 * clamp01(1 - bars / (reclaimBars + 1)) + 0.15 * b.confidence),
        reason:
          `${b.label} broke ${px(level)} on bar ${b.to}; price came back within ` +
          `${retestAtr} ATR of it ${bars} bar${bars === 1 ? "" : "s"} later and did not close through. ` +
          `Same side as the break, and the exact complement of a failed break over the same population — ` +
          `the two records together are what say whether a retest helps here.`,
        shapes: [
          { type: "level", x0: b.from, y: level, tone: long ? "bull" : "bear", label: "held", dashed: false },
          {
            type: "marker",
            x: retestAt,
            y: long ? (data.l[retestAt] as number) : (data.h[retestAt] as number),
            tone: long ? "bull" : "bear",
            text: "retest",
            above: !long,
          },
        ],
      });
    }
  }

  return capPerKind(out, maxPerKind);
}

/**
 * An order block price returned into and left the same way it came.
 *
 * The distinction from a breaker, which `ranges.ts` already reports: a breaker
 * is a block that FAILED and flipped side. A mitigation is a block that WORKED
 * — price came back into the zone, did not close through it, and continued.
 * Same starting population, opposite outcome, and having both means the order
 * block record can be split by what actually happened to the zone.
 */
export function detectMitigation(
  data: DetectInput,
  opts: FailureOptions = {},
  len = data.c.length,
): Detection[] {
  const maxPerKind = opts.maxPerKind ?? DEFAULTS.maxPerKind;
  if (len < 40) return [];

  const blocks = detectOrderBlocks(data, { hideMitigated: false, maxZones: 24 }, len);
  const out: Detection[] = [];

  for (const block of blocks) {
    const edges = boxEdges(block);
    if (!edges) continue;
    const { lo, hi } = edges;
    const long = block.direction === "long";

    let enteredAt = -1;
    let leftAt = -1;

    for (let i = block.to + 1; i < len; i++) {
      const barLow = data.l[i] as number;
      const barHigh = data.h[i] as number;
      const c = data.c[i] as number;

      if (enteredAt < 0) {
        if (barLow <= hi && barHigh >= lo) enteredAt = i;
        continue;
      }
      /* Closed through: the zone did not hold, and that instance belongs to
         the breaker record rather than this one. */
      if (long ? c < lo : c > hi) {
        enteredAt = -1;
        leftAt = -1;
        break;
      }
      if (long ? c > hi : c < lo) {
        leftAt = i;
        break;
      }
    }

    if (enteredAt < 0 || leftAt < 0) continue;

    out.push({
      id: `mitigation-${block.from}-${leftAt}`,
      kind: "mitigation",
      label: "Mitigated order block",
      direction: long ? "long" : "short",
      from: block.from,
      to: leftAt,
      confidence: clamp01(0.35 + 0.3 * block.confidence + 0.2 * clamp01(1 / (leftAt - enteredAt + 1))),
      reason:
        `Price returned into the ${long ? "demand" : "supply"} block at ${px(lo)}-${px(hi)} on bar ` +
        `${enteredAt}, never closed through it, and left the same way ${leftAt - enteredAt} bar` +
        `${leftAt - enteredAt === 1 ? "" : "s"} later. The zone did its job — the opposite outcome ` +
        `to the breaker record.`,
      shapes: [
        { type: "box", x0: block.from, x1: leftAt, y0: lo, y1: hi, tone: long ? "bull" : "bear", dashed: false, label: "mitigated" },
        {
          type: "marker",
          x: leftAt,
          y: long ? (data.l[leftAt] as number) : (data.h[leftAt] as number),
          tone: long ? "bull" : "bear",
          text: "held",
          above: !long,
        },
      ],
    });
  }

  return capPerKind(out, maxPerKind);
}

function capPerKind(found: readonly Detection[], max: number): Detection[] {
  const byKind = new Map<string, Detection[]>();
  for (const d of found) {
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }
  const out: Detection[] = [];
  for (const list of byKind.values()) {
    list.sort((x, y) => y.to - x.to);
    out.push(...list.slice(0, max));
  }
  out.sort((x, y) => x.to - y.to);
  return out;
}

/** Exported for the tests: the shape reader every detector here depends on. */
export { boxEdges };
