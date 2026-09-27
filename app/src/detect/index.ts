/**
 * Detector registry — one entry point that runs the enabled detectors.
 *
 * Detection is deterministic pattern recognition, not a learned model. Every
 * result is reproducible from the bars alone and carries the rule that produced
 * it. That is a deliberate choice, not a limitation to apologise for: a
 * structure you cannot audit is a structure you cannot trust on a live trade,
 * and the whole point of this terminal is that you can read the reasoning.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWENTY-EIGHT DETECTORS, AND WHY THAT IS NOT AN IMPROVEMENT ON THIRTEEN
 *
 * v54 more than doubled this list. The measured record before it said every
 * one of the ten characterisable kinds sat at or below break-even at 1R, and
 * nothing about adding fifteen more shapes changes that arithmetic — a bigger
 * pile of candidates over the same flat distribution is a bigger pile, not an
 * edge. What the new detectors are for is CONDITIONING: candles that only
 * publish at a level, failures that only exist because something else broke,
 * profile levels that come from a different axis entirely, and time windows
 * that carry their own measured share of the day's travel.
 *
 * Every kind is judged by `setup/simulate.ts` the moment it exists, so each
 * addition is a falsifiable claim rather than a feature. The expectation,
 * recorded here in advance, is that most of them come back flat.
 *
 * DEFAULTS ARE OFF. `defaultOn` marks the eight that a fresh install enables.
 * Twenty-eight overlays at once is not a chart, and an operator who turns
 * something on has made a decision the terminal can attribute a mark to.
 * ──────────────────────────────────────────────────────────────────────────── */

import { detectStructure, detectLevels } from "./structure";
import { detectFVG, detectOrderBlocks } from "./zones";
import {
  detectDoubles,
  detectHeadShoulders,
  detectTrendlines,
  detectDivergence,
} from "./formations";
import { detectPools, detectSweeps } from "./liquidity";
import { detectBreakers, detectRanges } from "./ranges";
import { detectSessionRanges } from "./sessionrange";
import { detectCandles } from "./candles";
import { detectWedges } from "./wedges";
import { detectProfile, detectVolumeClimax } from "./volume";
import { detectGaps, detectSqueeze } from "./volatility";
import {
  detectAnchoredVwap,
  detectFibs,
  detectPivotPoints,
  detectPriorLevels,
  detectRoundNumbers,
} from "./anchors";
import { detectFailedBreaks, detectMitigation, detectSprings } from "./failure";
import { detectKillzones, detectOpeningRange } from "./timewindow";
import { detectHarmonics } from "./harmonic";
import { detectConfluence } from "./confluence";
import type { Detection, DetectInput, DetectionKind } from "./types";

export type DetectorId =
  | "structure"
  | "levels"
  | "fvg"
  | "order-blocks"
  | "doubles"
  | "head-shoulders"
  | "trendlines"
  | "divergence"
  | "sweeps"
  | "pools"
  | "breakers"
  | "ranges"
  | "sessions"
  /* v54 */
  | "candles"
  | "wedges"
  | "profile"
  | "volume-events"
  | "squeeze"
  | "gaps"
  | "round-numbers"
  | "fibs"
  | "pivot-points"
  | "prior-levels"
  | "avwap"
  | "wyckoff"
  | "failures"
  | "killzones"
  | "harmonics"
  | "confluence";

/**
 * Detectors are grouped so the settings list is readable at twenty-eight.
 * The order here is the order they are offered in.
 */
export type DetectorFamily = "structure" | "liquidity" | "shape" | "volume" | "levels" | "time";

export const FAMILY_LABEL: Readonly<Record<DetectorFamily, string>> = {
  structure: "Structure",
  liquidity: "Liquidity & failure",
  shape: "Shapes",
  volume: "Volume & volatility",
  levels: "Standing levels",
  time: "Time",
};

export interface DetectorMeta {
  id: DetectorId;
  label: string;
  /** One line, shown in the UI so the toggle is self-explanatory. */
  blurb: string;
  family: DetectorFamily;
  /** Enabled on a fresh install. Eight of twenty-eight. */
  defaultOn?: boolean;
  /**
   * Runs over the bars alone. Every detector has one except `confluence`,
   * which reads what the others found — see `meta` below.
   */
  run?(data: DetectInput, len: number): Detection[];
  /**
   * A detector whose input is the other detectors' output. Run last, once, and
   * never fed its own results. Only `confluence` uses this.
   */
  meta?(data: DetectInput, len: number, found: readonly Detection[]): Detection[];
}

export const DETECTORS: readonly DetectorMeta[] = [
  {
    id: "structure",
    label: "Structure",
    blurb: "Break of structure and change of character, confirmed on close",
    family: "structure",
    defaultOn: true,
    run: (d, len) => detectStructure(d, {}, len),
  },
  {
    id: "levels",
    label: "S/R levels",
    blurb: "Horizontal levels where two or more swings clustered",
    family: "levels",
    defaultOn: true,
    run: (d, len) => detectLevels(d, {}, len),
  },
  {
    id: "fvg",
    label: "Fair value gaps",
    blurb: "Three-bar imbalances price left untraded, unmitigated only",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectFVG(d, {}, len),
  },
  {
    id: "order-blocks",
    label: "Order blocks",
    blurb: "Last opposing candle before a displacement move",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectOrderBlocks(d, {}, len),
  },
  {
    id: "doubles",
    label: "Double top/bottom",
    blurb: "Twin extremes confirmed by a close through the neckline",
    family: "shape",
    run: (d, len) => detectDoubles(d, {}, len),
  },
  {
    id: "head-shoulders",
    label: "Head & shoulders",
    blurb: "Five-pivot reversal confirmed on the neckline break",
    family: "shape",
    run: (d, len) => detectHeadShoulders(d, {}, len),
  },
  {
    id: "trendlines",
    label: "Trendlines",
    blurb: "Lines touching three or more swings — two points is not a trendline",
    family: "shape",
    run: (d, len) => detectTrendlines(d, {}, len),
  },
  {
    id: "divergence",
    label: "Divergence",
    blurb: "Price and RSI disagreeing across consecutive swings",
    family: "shape",
    run: (d, len) => detectDivergence(d, {}, len),
  },

  /* v49 — liquidity and context.
     The eight above all describe a SHAPE price traced out. These describe what
     was resting where, what got taken, and what condition the market is in,
     which is a different question and the one most of a session is spent in. */
  {
    id: "sweeps",
    label: "Liquidity sweeps",
    blurb: "A level taken on the wick and reclaimed on the close — with the stop attached",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectSweeps(d, {}, len),
  },
  {
    id: "pools",
    label: "Equal highs / lows",
    blurb: "Two or more swings at one price — where the stops are resting",
    family: "liquidity",
    run: (d, len) => detectPools(d, {}, len),
  },
  {
    id: "breakers",
    label: "Breaker blocks",
    blurb: "An order block that failed and flipped side",
    family: "liquidity",
    run: (d, len) => detectBreakers(d, {}, len),
  },
  {
    id: "ranges",
    label: "Ranges",
    blurb: "Sideways stretches, and the bar that leaves them",
    family: "structure",
    defaultOn: true,
    run: (d, len) => detectRanges(d, {}, len),
  },
  {
    id: "sessions",
    label: "Session ranges",
    blurb: "Asia, London and New York highs and lows. Nothing above 4h",
    family: "time",
    run: (d, len) => detectSessionRanges(d, {}, len),
  },

  /* ── v54 ─────────────────────────────────────────────────────────────── */

  {
    id: "candles",
    label: "Candle patterns",
    blurb: "Engulfings, pins, inside bars and stars — only where they sit on a level",
    family: "shape",
    run: (d, len) => detectCandles(d, {}, len),
  },
  {
    id: "wedges",
    label: "Wedges & triangles",
    blurb: "Two boundaries at once: wedges, triangles, channels and flags, with the break",
    family: "shape",
    run: (d, len) => detectWedges(d, {}, len),
  },
  {
    id: "profile",
    label: "Volume profile levels",
    blurb: "Point of control, value area and low-volume nodes. Nothing without volume",
    family: "volume",
    run: (d, len) => detectProfile(d, {}, len),
  },
  {
    id: "volume-events",
    label: "Volume climax",
    blurb: "Bars in the top 2% of this window's volume, with the side they closed",
    family: "volume",
    run: (d, len) => detectVolumeClimax(d, {}, len),
  },
  {
    id: "squeeze",
    label: "Squeeze",
    blurb: "Bollinger inside Keltner, and the bar the compression releases on",
    family: "volume",
    run: (d, len) => detectSqueeze(d, {}, len),
  },
  {
    id: "gaps",
    label: "Gaps",
    blurb: "Prices that were never offered, with whether they have been filled",
    family: "volume",
    run: (d, len) => detectGaps(d, {}, len),
  },
  {
    id: "round-numbers",
    label: "Round numbers",
    blurb: "The coarsest round ladder wider than 2 ATR, with its measured touch count",
    family: "levels",
    run: (d, len) => detectRoundNumbers(d, {}, len),
  },
  {
    id: "fibs",
    label: "Retracement & OTE",
    blurb: "Fib levels auto-anchored to the last completed leg, with premium/discount",
    family: "levels",
    run: (d, len) => detectFibs(d, {}, len),
  },
  {
    id: "pivot-points",
    label: "Floor pivots",
    blurb: "Classic PP, R1/R2 and S1/S2 from the previous session",
    family: "levels",
    run: (d, len) => detectPivotPoints(d, {}, len),
  },
  {
    id: "prior-levels",
    label: "Prior day / week",
    blurb: "Yesterday's and last week's high and low, and whether they have been taken",
    family: "levels",
    defaultOn: true,
    run: (d, len) => detectPriorLevels(d, {}, len),
  },
  {
    id: "avwap",
    label: "Anchored VWAP",
    blurb: "VWAP from the last swing high and low — where everyone since is on average",
    family: "volume",
    run: (d, len) => detectAnchoredVwap(d, {}, len),
  },
  {
    id: "wyckoff",
    label: "Springs & upthrusts",
    blurb: "A range boundary broken and then reclaimed on the close",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectSprings(d, {}, len),
  },
  {
    id: "failures",
    label: "Failed breaks & retests",
    blurb: "Structure breaks that did not hold, and the ones that did — the same population, split",
    family: "liquidity",
    run: (d, len) => [...detectFailedBreaks(d, {}, len), ...detectMitigation(d, {}, len)],
  },
  {
    id: "killzones",
    label: "Killzones & opening range",
    blurb: "Session-open windows, each carrying its measured share of the day's travel",
    family: "time",
    run: (d, len) => [...detectKillzones(d, {}, len), ...detectOpeningRange(d, {}, len)],
  },
  {
    id: "harmonics",
    label: "Harmonic patterns",
    blurb: "Gartley, bat, butterfly and crab. No mechanism — the record is the only argument",
    family: "shape",
    run: (d, len) => detectHarmonics(d, {}, len),
  },
  {
    id: "confluence",
    label: "Confluence bands",
    blurb: "Where three or more independent detectors agree, published as one band",
    family: "structure",
    defaultOn: true,
    meta: (d, len, found) => detectConfluence(d, found, {}, len),
  },
];

const BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));

/** The ids a fresh install starts with. */
/**
 * One human name per detection kind.
 *
 * WHY IT EXISTS. A `Detection` carries its own `label` ("Bullish FVG"), which
 * is right where a detection is in hand — but three surfaces hold only the
 * KIND and were printing the id at the operator: the verdict card said
 * "choch", the live feed said "A fvg setup", and the knowledge table listed
 * `bos` / `choch` / `fvg` as if they were words. An id is the right key for a
 * record and the wrong thing to read.
 *
 * Kinds are keyed by their own id, so a kind added to `DetectionKind` without
 * a name here falls back to its id with the dashes opened out — readable, and
 * obviously unnamed rather than silently wrong.
 */
const KIND_NAMES: Readonly<Record<string, string>> = {
  "bos": "Break of structure",
  "choch": "Change of character",
  "fvg": "Fair value gap",
  "order-block": "Order block",
  "level": "Support / resistance level",
  "double-top": "Double top",
  "double-bottom": "Double bottom",
  "head-shoulders": "Head and shoulders",
  "trendline": "Trendline",
  "divergence": "Divergence",
  "equal-highs": "Equal highs",
  "equal-lows": "Equal lows",
  "liquidity-sweep": "Liquidity sweep",
  "breaker": "Breaker",
  "range": "Range",
  "expansion": "Expansion",
  "session-range": "Session range",
  "engulfing": "Engulfing bar",
  "pin-bar": "Pin bar",
  "inside-bar": "Inside bar",
  "star": "Star",
  "wedge": "Wedge",
  "triangle": "Triangle",
  "channel": "Channel",
  "flag": "Flag",
  "poc": "Point of control",
  "value-area": "Value area",
  "lvn": "Low-volume node",
  "volume-climax": "Volume climax",
  "squeeze": "Volatility squeeze",
  "gap": "Gap",
  "round-level": "Round number",
  "fib": "Fibonacci level",
  "pivot-level": "Pivot level",
  "prior-level": "Prior session level",
  "avwap": "Anchored VWAP",
  "spring": "Spring",
  "upthrust": "Upthrust",
  "failed-break": "Failed break",
  "retest": "Retest",
  "mitigation": "Mitigation",
  "killzone": "Killzone",
  "opening-range": "Opening range",
  "harmonic": "Harmonic pattern",
  "confluence": "Confluence",
};

/** The human name for a detection kind. Falls back to the id, dashes opened. */
export function nameForKind(kind: string): string {
  return KIND_NAMES[kind] ?? kind.replace(/-/g, " ");
}

/**
 * THE DETECTOR SET'S DESIGN GENERATION. Bump to reset every saved set ONCE.
 *
 * WHY. `detectors` was persisted and read back verbatim, so a set chosen once
 * survived every later change to the defaults. MEASURED on the owner's
 * terminal: 29 detectors exist, 9 ship enabled, and their saved set held
 * exactly ONE — `structure`, which emits BOS and CHoCH and no levels at all.
 * The chart then reported "0 levels, 0 patterns and 0 gaps among 50 marks",
 * which is true and reads as a statement about the market.
 *
 * It compounds: the trial ledger holds 51 bos/choch of 52 rows, so the
 * conditional-edge layer could only ever learn about structure.
 *
 * This is the rule this project already records for the v5 inspector — "do not
 * restyle a saved-preference surface and expect the operator to see it. Ship a
 * design generation WITH the design, or the people who have used the product
 * longest are the ones who see none of it."
 */
export const DETECT_DESIGN = 1;

export const DEFAULT_DETECTORS: readonly DetectorId[] = DETECTORS.filter((d) => d.defaultOn).map(
  (d) => d.id,
);

/**
 * Which detector produces a given kind of structure.
 *
 * Needed because a consumer may hold a REFERENCE to a structure — an alert
 * anchored to a trendline, say — long after the user switched the trendline
 * overlay off. Turning off a chart overlay is a display preference; letting it
 * silently stop an alert from running would be a trap. The consumer looks up
 * the detector it needs here and asks for it explicitly.
 */
export const DETECTOR_FOR_KIND: Readonly<Record<DetectionKind, DetectorId>> = {
  bos: "structure",
  choch: "structure",
  level: "levels",
  fvg: "fvg",
  "order-block": "order-blocks",
  "double-top": "doubles",
  "double-bottom": "doubles",
  "head-shoulders": "head-shoulders",
  trendline: "trendlines",
  divergence: "divergence",
  "equal-highs": "pools",
  "equal-lows": "pools",
  "liquidity-sweep": "sweeps",
  breaker: "breakers",
  range: "ranges",
  expansion: "ranges",
  "session-range": "sessions",

  engulfing: "candles",
  "pin-bar": "candles",
  "inside-bar": "candles",
  star: "candles",

  wedge: "wedges",
  triangle: "wedges",
  channel: "wedges",
  flag: "wedges",

  poc: "profile",
  "value-area": "profile",
  lvn: "profile",
  "volume-climax": "volume-events",

  squeeze: "squeeze",
  gap: "gaps",

  "round-level": "round-numbers",
  fib: "fibs",
  "pivot-level": "pivot-points",
  "prior-level": "prior-levels",
  avwap: "avwap",

  spring: "wyckoff",
  upthrust: "wyckoff",
  "failed-break": "failures",
  retest: "failures",
  mitigation: "failures",

  killzone: "killzones",
  "opening-range": "killzones",

  harmonic: "harmonics",
  confluence: "confluence",
};

/**
 * Kinds that describe CONTEXT rather than a trade.
 *
 * A level, a session box or a confluence band has no invalidation of its own:
 * there is no price at which "the point of control is at 2,410" stops being
 * true. The setup engine cannot build a plan from one and the replay cannot
 * score one, so both skip them — and both used to hold their own private copy
 * of this list, in `setup/engine.ts` and `setup/deep.ts`, with a comment in one
 * saying it mirrored the other. Two lists that must agree and are edited
 * separately is this repository's most-repeated bug in miniature; v54 added
 * sixteen candidate kinds to it, which is where that would have been noticed
 * the hard way.
 *
 * It lives here because it is a property of the KIND, which is what this file
 * defines.
 *
 * Note what is deliberately absent: `squeeze`, `wedge`, `triangle`, `channel`,
 * `flag` and `opening-range` all publish a neutral state AND a directional
 * event. The neutral half is filtered by direction wherever it matters; the
 * directional half is a real setup with real geometry and belongs in the
 * record.
 */
export const CONTEXT_KINDS: ReadonlySet<DetectionKind> = new Set<DetectionKind>([
  "range",
  "session-range",
  "expansion",
  "level",
  "equal-highs",
  "equal-lows",
  /* v54 */
  "poc",
  "value-area",
  "lvn",
  "round-level",
  "fib",
  "pivot-level",
  "prior-level",
  "avwap",
  "killzone",
  "confluence",
]);

/**
 * Run the enabled detectors and return everything they found, newest last.
 *
 * Two passes. Ordinary detectors read the bars; meta detectors read what the
 * first pass found. The split is what lets `confluence` be a detector like any
 * other — toggleable, recorded, drawn by the same renderer — without every
 * other detector needing to know it exists.
 */
export function runDetectors(
  data: DetectInput,
  enabled: readonly DetectorId[],
  len = data.c.length,
): Detection[] {
  const out: Detection[] = [];
  const metas: DetectorMeta[] = [];

  for (const id of enabled) {
    const meta = BY_ID.get(id);
    if (!meta) continue;
    if (meta.meta) {
      metas.push(meta);
      continue;
    }
    if (!meta.run) continue;
    try {
      out.push(...meta.run(data, len));
    } catch (err) {
      // One broken detector must not blank the whole chart's annotations.
      console.error(`[detect] ${id} failed`, err);
    }
  }

  /* Meta detectors see the FIRST pass only, never each other's output. Two
     meta detectors feeding one another would make the result depend on the
     order the user happened to enable them in. */
  const firstPass = [...out];
  for (const meta of metas) {
    try {
      out.push(...(meta.meta as NonNullable<DetectorMeta["meta"]>)(data, len, firstPass));
    } catch (err) {
      console.error(`[detect] ${meta.id} failed`, err);
    }
  }

  out.sort((a, b) => a.to - b.to);
  return out;
}

/** Build the columnar input the detectors expect. */
export function toDetectInput(
  bars: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[],
): DetectInput {
  const n = bars.length;
  const out: DetectInput = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i] as { t: number; o: number; h: number; l: number; c: number; v: number };
    out.t[i] = b.t;
    out.o[i] = b.o;
    out.h[i] = b.h;
    out.l[i] = b.l;
    out.c[i] = b.c;
    out.v[i] = b.v;
  }
  return out;
}

export type { Detection, DetectInput } from "./types";
export type { Shape, Tone } from "./types";
