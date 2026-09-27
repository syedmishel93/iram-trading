/**
 * Key levels: the nearest prices the detectors already found, above and below.
 *
 * WHAT IT READS
 * Only the detections the chart already computed. Nothing is re-detected and
 * nothing is invented: every level here is a `y` a detector drew, or the edge
 * of a box it drew. The kinds that ARE prices are listed below by name; the
 * rest (breaks, candle patterns, divergences, sweeps, time windows) are events
 * at a bar, not places on the price axis, and are left out.
 *
 * CONFLUENCE BANDS ARE LEFT OUT ON PURPOSE
 * The `confluence` detector is built FROM the other detections. Counting its
 * band as one more agreeing structure would count the same evidence twice, so
 * the "×N" here is the count of distinct underlying detections only.
 *
 * MERGING
 * Two levels closer than the tolerance are one level. The tolerance is a
 * quarter of ATR when an ATR is supplied, otherwise 0.1% of price, and the
 * result says which one it used — a merge whose width is hidden would make
 * "×3" unreadable.
 *
 * USED OR FRESH
 * Reported only where the detector records it: an order block or fair value
 * gap that price has traded back into ("mitigated"), a price gap that has
 * been filled, a prior-session high or low already taken, a point of control
 * price has traded back through. Everything else is "unknown", never "fresh".
 */

import { DETECTOR_FOR_KIND, DETECTORS, nameForKind } from "../detect/index";
import type { Detection, DetectionKind, Shape } from "../detect/types";

/** Box kinds whose whole box is ONE zone. */
const ZONE_KINDS: ReadonlySet<DetectionKind> = new Set<DetectionKind>(["order-block", "fvg", "breaker", "gap"]);

/** Box kinds whose two EDGES are the levels (the inside is just where price was). */
const EDGE_KINDS: ReadonlySet<DetectionKind> = new Set<DetectionKind>(["range"]);

/** Kinds whose horizontal `level` shapes are the levels. */
const LINE_KINDS: ReadonlySet<DetectionKind> = new Set<DetectionKind>([
  "level",
  "equal-highs",
  "equal-lows",
  "poc",
  "value-area",
  "lvn",
  "round-level",
  "fib",
  "pivot-level",
  "prior-level",
  "avwap",
  "session-range",
  "opening-range",
]);

/** Kinds that publish a high and a low as a pair. */
const PAIRED_KINDS: ReadonlySet<DetectionKind> = new Set<DetectionKind>([
  "value-area",
  "session-range",
  "opening-range",
  "prior-level",
]);

/** Whether a detection of this kind can contribute a price level at all. */
export function isLevelKind(kind: DetectionKind): boolean {
  return ZONE_KINDS.has(kind) || EDGE_KINDS.has(kind) || LINE_KINDS.has(kind);
}

/**
 * The level-producing detectors the operator currently has OFF.
 *
 * WHY THIS EXISTS. The refusal below read "None of the 50 structures found is a
 * price level — they are events such as breaks or candle patterns." Every word
 * of that is true and it describes the wrong thing: it reads as *the market has
 * no levels here*, when what happened is that Levels, Order blocks and Fair
 * value gaps were switched off, so nothing could have produced one.
 *
 * MEASURED on the owner's terminal: 29 detectors exist, 9 ship enabled, and a
 * saved preference had left exactly ONE on — `structure`, which emits BOS and
 * CHoCH and no levels at all. The trial ledger agrees: 51 of 52 recorded trials
 * are bos/choch, so even the learning layer could only ever see structure.
 *
 * A refusal an operator cannot act on is the failure this project keeps
 * recording. This is what turns the sentence into an instruction.
 */
export function levelDetectorsOff(enabled: readonly string[]): string[] {
  const on = new Set(enabled);
  const wanted = new Set<string>();
  for (const [kind, id] of Object.entries(DETECTOR_FOR_KIND)) {
    if (isLevelKind(kind as DetectionKind) && !on.has(id)) wanted.add(id);
  }
  const names: string[] = [];
  for (const meta of DETECTORS) {
    if (wanted.has(meta.id)) names.push(meta.label);
  }
  return names;
}

/** "A, B and C" — an Oxford-free list a sentence can absorb. */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

export const ATR_FRACTION = 0.25;
export const PRICE_FRACTION = 0.001;
export const PER_SIDE = 3;

export type Side = "above" | "below" | "inside";
export type Used = "fresh" | "used" | "unknown";

export interface KeyLevelSource {
  readonly id: string;
  readonly kind: DetectionKind;
  /** Plain name of this one source, e.g. "order block". */
  readonly name: string;
}

export interface KeyLevel {
  readonly side: Side;
  /** Zone bounds. Equal for a single line. */
  readonly low: number;
  readonly high: number;
  /** The edge facing current price: `low` above, `high` below, the midpoint inside. */
  readonly price: number;
  /** Distinct plain names, nearest source first. */
  readonly kinds: readonly string[];
  /** Distance from current price to `price`, in % of current price. Never negative. */
  readonly distancePct: number;
  /** Distinct detections that put a level here. */
  readonly count: number;
  readonly used: Used;
  /** "mitigated", "filled", "taken", "traded through" — only when `used` is "used". */
  readonly usedWord: string;
  readonly sources: readonly KeyLevelSource[];
}

export interface Tolerance {
  readonly value: number;
  readonly basis: "atr" | "price";
  /** One line, e.g. "levels within 0.25 ATR (12.5) are merged". */
  readonly text: string;
}

export type KeyLevelsResult =
  | { readonly state: "no-price"; readonly reason: string }
  | { readonly state: "none"; readonly reason: string; readonly total: number }
  | {
      readonly state: "ok";
      /** Nearest first, at most PER_SIDE. */
      readonly above: readonly KeyLevel[];
      readonly below: readonly KeyLevel[];
      /** Zones price is trading inside right now. */
      readonly inside: readonly KeyLevel[];
      readonly tolerance: Tolerance;
      /** Every detection passed in. */
      readonly total: number;
      /** Detections that contributed at least one level. */
      readonly contributing: number;
    };

export interface KeyLevelOptions {
  /** ATR in price units. Finite and positive, or the tolerance falls back to % of price. */
  readonly atr?: number | null;
  readonly perSide?: number;
  /**
   * Which detectors are currently ON. Supplied so a refusal can say WHY there
   * are no levels rather than implying the market has none. Absent means the
   * caller could not say, and the wording stays neutral.
   */
  readonly enabled?: readonly string[];
}

interface Candidate {
  readonly low: number;
  readonly high: number;
  readonly source: KeyLevelSource;
  readonly used: Used;
  readonly usedWord: string;
}

const fin = (v: number): boolean => typeof v === "number" && Number.isFinite(v);

function sideOf(low: number, high: number, price: number): Side {
  if (low > price) return "above";
  if (high < price) return "below";
  return "inside";
}

function pairName(d: Detection, pair: "high" | "low"): string {
  switch (d.kind) {
    case "value-area":
      return `value area ${pair}`;
    case "opening-range":
      return `opening range ${pair}`;
    case "range":
      return `range ${pair}`;
    case "prior-level":
      /* Labelled "Prior day high / low" by the detector. */
      return `${d.label.replace(/\s*high\s*\/\s*low\s*$/i, "").toLowerCase()} ${pair}`;
    case "session-range":
      return `${d.label} ${pair}`;
    default:
      return `${nameForKind(d.kind).toLowerCase()} ${pair}`;
  }
}

function plainName(d: Detection, shape: Shape, side: Side, pair: "high" | "low" | null): string {
  if (pair !== null) return pairName(d, pair);
  const tag = "label" in shape && typeof shape.label === "string" ? shape.label : "";
  switch (d.kind) {
    case "level":
      return side === "above" ? "resistance" : side === "below" ? "support" : "support / resistance";
    case "order-block":
      return "order block";
    case "fvg":
      return "fair value gap";
    case "breaker":
      return "breaker block";
    case "gap":
      return "price gap";
    case "equal-highs":
      return "equal highs";
    case "equal-lows":
      return "equal lows";
    case "poc":
      return "point of control";
    case "lvn":
      return "low-volume node";
    case "round-level":
      return "round number";
    case "avwap":
      return "anchored VWAP";
    case "fib":
      return tag === "" ? "fib level" : `fib ${tag}`;
    case "pivot-level":
      return tag === "PP" ? "pivot point" : tag === "" ? "pivot level" : `pivot ${tag}`;
    default:
      return nameForKind(d.kind).toLowerCase();
  }
}

/** What the detector recorded about whether price has already used this level. */
function usedOf(d: Detection, shape: Shape): { used: Used; word: string } {
  switch (d.kind) {
    case "order-block":
    case "fvg":
      /* zones.ts: `extend: mitigatedAt < 0`. */
      return shape.type === "box" && shape.extend === true ? { used: "fresh", word: "" } : { used: "used", word: "mitigated" };
    case "gap":
      /* volatility.ts: `extend: filledAt < 0`. */
      return shape.type === "box" && shape.extend === true ? { used: "fresh", word: "" } : { used: "used", word: "filled" };
    case "prior-level":
      /* anchors.ts: `dashed: taken`. */
      return shape.type === "level" && shape.dashed === true ? { used: "used", word: "taken" } : { used: "fresh", word: "" };
    case "poc":
      /* volume.ts: "nPOC" when price has not traded back through it. */
      return shape.type === "level" && shape.label === "nPOC" ? { used: "fresh", word: "" } : { used: "used", word: "traded through" };
    default:
      return { used: "unknown", word: "" };
  }
}

function candidatesOf(d: Detection, price: number): Candidate[] {
  const out: Candidate[] = [];
  const push = (low: number, high: number, shape: Shape, pair: "high" | "low" | null): void => {
    if (!fin(low) || !fin(high) || low <= 0) return;
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    const u = usedOf(d, shape);
    out.push({
      low: lo,
      high: hi,
      source: { id: d.id, kind: d.kind, name: plainName(d, shape, sideOf(lo, hi, price), pair) },
      used: u.used,
      usedWord: u.word,
    });
  };

  if (ZONE_KINDS.has(d.kind)) {
    const box = d.shapes.find((s) => s.type === "box");
    if (box && box.type === "box") push(box.y0, box.y1, box, null);
    return out;
  }
  if (EDGE_KINDS.has(d.kind)) {
    const box = d.shapes.find((s) => s.type === "box");
    if (box && box.type === "box") {
      push(Math.max(box.y0, box.y1), Math.max(box.y0, box.y1), box, "high");
      push(Math.min(box.y0, box.y1), Math.min(box.y0, box.y1), box, "low");
    }
    return out;
  }
  if (LINE_KINDS.has(d.kind)) {
    const lines = d.shapes.filter((s): s is Extract<Shape, { type: "level" }> => s.type === "level");
    const ys = lines.map((s) => s.y).filter(fin);
    const top = ys.length > 0 ? Math.max(...ys) : NaN;
    const paired = PAIRED_KINDS.has(d.kind) && ys.length === 2 && ys[0] !== ys[1];
    for (const s of lines) push(s.y, s.y, s, paired ? (s.y === top ? "high" : "low") : null);
  }
  return out;
}

export function toleranceFor(price: number, atr: number | null | undefined): Tolerance {
  if (typeof atr === "number" && Number.isFinite(atr) && atr > 0) {
    const value = atr * ATR_FRACTION;
    return {
      value,
      basis: "atr",
      text: `Levels within ${ATR_FRACTION} ATR (${value.toPrecision(3)}) of each other are merged.`,
    };
  }
  const value = price * PRICE_FRACTION;
  return {
    value,
    basis: "price",
    text: `Levels within ${(PRICE_FRACTION * 100).toFixed(1)}% of price (${value.toPrecision(3)}) of each other are merged; no ATR was available.`,
  };
}

interface Group {
  low: number;
  high: number;
  readonly members: Candidate[];
}

function nearEdge(side: Side, low: number, high: number): number {
  return side === "above" ? low : side === "below" ? high : (low + high) / 2;
}

function mergeSide(list: Candidate[], side: Side, price: number, tol: number): KeyLevel[] {
  const sorted = [...list].sort(
    (a, b) => Math.abs(nearEdge(side, a.low, a.high) - price) - Math.abs(nearEdge(side, b.low, b.high) - price),
  );
  const groups: Group[] = [];
  for (const c of sorted) {
    const g = groups.find((x) => c.low - x.high <= tol && x.low - c.high <= tol);
    if (g) {
      g.low = Math.min(g.low, c.low);
      g.high = Math.max(g.high, c.high);
      g.members.push(c);
    } else {
      groups.push({ low: c.low, high: c.high, members: [c] });
    }
  }

  const levels = groups.map((g): KeyLevel => {
    const at = nearEdge(side, g.low, g.high);
    const ids = new Set<string>();
    const kinds: string[] = [];
    const sources: KeyLevelSource[] = [];
    for (const m of g.members) {
      if (!kinds.includes(m.source.name)) kinds.push(m.source.name);
      if (!ids.has(m.source.id)) {
        ids.add(m.source.id);
        sources.push(m.source);
      }
    }
    const recorded = g.members.filter((m) => m.used !== "unknown");
    const allUsed = recorded.length > 0 && recorded.every((m) => m.used === "used");
    const words = [...new Set(recorded.map((m) => m.usedWord).filter((w) => w !== ""))];
    return {
      side,
      low: g.low,
      high: g.high,
      price: at,
      kinds,
      distancePct: side === "inside" ? 0 : (Math.abs(at - price) / price) * 100,
      count: ids.size,
      used: recorded.length === 0 ? "unknown" : allUsed ? "used" : "fresh",
      usedWord: allUsed ? words.join(", ") : "",
      sources,
    };
  });
  /* Merging can move a group's near edge, so re-sort before cutting. */
  levels.sort((a, b) => a.distancePct - b.distancePct);
  return levels;
}

/**
 * The nearest levels above and below `price`, merged and counted.
 *
 * Refuses rather than approximates: no usable price is `no-price`, and a set
 * of detections with no price-level kinds in it is `none` with the reason.
 */
export function keyLevels(
  detections: readonly Detection[],
  price: number | null,
  opts: KeyLevelOptions = {},
): KeyLevelsResult {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return { state: "no-price", reason: "No current price yet, so nothing can be called above or below it." };
  }
  const total = detections.length;
  const off = opts.enabled ? levelDetectorsOff(opts.enabled) : [];
  const because = off.length
    ? ` ${listOf(off)} ${off.length === 1 ? "is" : "are"} switched off — turn ${off.length === 1 ? "it" : "them"} on in Auto-marking.`
    : "";
  if (total === 0) {
    return {
      state: "none",
      reason: `The detectors found nothing on this chart.${because}`,
      total,
    };
  }

  const all: Candidate[] = [];
  const contributing = new Set<string>();
  for (const d of detections) {
    if (!isLevelKind(d.kind)) continue;
    for (const c of candidatesOf(d, price)) {
      all.push(c);
      contributing.add(d.id);
    }
  }
  if (all.length === 0) {
    return {
      state: "none",
      reason: `None of the ${total} mark${total === 1 ? "" : "s"} on this chart is a price level.${
        because || " They are events such as breaks or candle patterns."}`,
      total,
    };
  }

  const tolerance = toleranceFor(price, opts.atr);
  const per = Math.max(0, Math.floor(opts.perSide ?? PER_SIDE));
  const bySide = (s: Side): Candidate[] => all.filter((c) => sideOf(c.low, c.high, price) === s);

  return {
    state: "ok",
    above: mergeSide(bySide("above"), "above", price, tolerance.value).slice(0, per),
    below: mergeSide(bySide("below"), "below", price, tolerance.value).slice(0, per),
    inside: mergeSide(bySide("inside"), "inside", price, tolerance.value),
    tolerance,
    total,
    contributing: contributing.size,
  };
}
