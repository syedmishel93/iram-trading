/**
 * Confluence — the only detector here that makes the chart quieter.
 *
 * Twenty-eight kinds of structure are now drawn on one price axis. That is a
 * problem the previous thirteen already had and this build makes worse: the
 * operator is not short of marks, they are short of a reason to look at one
 * mark rather than another. Every other detector adds. This one subtracts, by
 * finding the price bands where independent detectors agree and publishing the
 * BAND instead of its members.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MAKES IT MEAN ANYTHING: DISTINCT KINDS
 *
 * Three fair value gaps stacked at one price is not three pieces of evidence.
 * It is one imbalance that a three-bar rule happened to report three times,
 * and counting it as confluence would make the most redundant detector on the
 * chart look like the most confirmed level on it. So the count is over
 * distinct KINDS, and a kind contributes at most once to a band no matter how
 * many instances it has there.
 *
 * The same argument disqualifies the pairs that are definitionally linked. An
 * order block and the fair value gap created by the displacement that made it
 * are the same event described twice; a range and the session range it sits
 * inside frequently are. `REDUNDANT` names those pairs, and a band that has
 * both counts them once.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO DO
 *
 * **It does not score.** There is no confluence number, and there will not be
 * one. `[[iram-honesty-contract]] `— the standing recommendation in this
 * repository is that nothing be automated off a confluence score, because the
 * out-of-sample test of the last one put PBO at 89%. A band here says WHICH
 * detectors agree and lets the operator read them. Three named sources are
 * information; "confluence 7.4" is a number that invites a rule.
 *
 * **It does not merge directions.** A band where a bullish order block sits on
 * a bearish trendline is a band with a disagreement in it, and that is the
 * most useful thing the operator could know about that price. It is published
 * as `neutral` with both sides named, never averaged into a lean.
 */

import { atr } from "../chart/indicators";
import { clamp01, px, type Detection, type DetectInput, type DetectionKind, type Shape } from "./types";

export interface ConfluenceOptions {
  /** How close two levels must be to be the same band, in ATR. */
  bandAtr?: number;
  /** Distinct kinds required before a band is published. */
  minSources?: number;
  /** Only detections this recent are considered live enough to stack. */
  freshBars?: number;
  /** Bands returned, strongest first. */
  maxResults?: number;
}

const DEFAULTS = { bandAtr: 0.75, minSources: 3, freshBars: 200, maxResults: 4 };

/**
 * Pairs that describe the same event and must not both count.
 *
 * Keyed both ways at lookup time, so the table lists each pair once.
 */
const REDUNDANT: readonly (readonly [string, string])[] = [
  ["order-block", "fvg"],
  ["order-block", "mitigation"],
  ["breaker", "order-block"],
  ["range", "session-range"],
  ["range", "opening-range"],
  ["poc", "value-area"],
  ["bos", "choch"],
  ["equal-highs", "level"],
  ["equal-lows", "level"],
  ["liquidity-sweep", "spring"],
  ["liquidity-sweep", "upthrust"],
  ["failed-break", "retest"],
  ["prior-level", "pivot-level"],
];

const redundantWith = (a: string, b: string): boolean =>
  REDUNDANT.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * The single price a detection is "at".
 *
 * A level is its own price; a box is its midpoint; a marker is its point; a
 * line is its right-hand end, which is where it currently sits. A detection
 * with no positional shape contributes nothing and is skipped rather than
 * defaulted to zero.
 */
export function priceOf(d: Detection): number | null {
  for (const s of d.shapes) {
    if (s.type === "level") return s.y;
  }
  for (const s of d.shapes) {
    if (s.type === "box") return (s.y0 + s.y1) / 2;
  }
  for (const s of d.shapes) {
    if (s.type === "line") return s.y1;
  }
  for (const s of d.shapes) {
    if (s.type === "marker") return s.y;
  }
  return null;
}

interface Member {
  kind: DetectionKind;
  label: string;
  price: number;
  direction: Detection["direction"];
  confidence: number;
}

/**
 * Group members into bands by price, with a HARD width bound.
 *
 * THE MEASUREMENT THAT REWROTE THIS FUNCTION
 * The first version was single-linkage: a member joined the open band while it
 * was within `tol` of the LAST member added. The comment defending it said a
 * long chain "can drift wider than `tol` overall", and treated that as a
 * tradeoff worth taking so a continuous shelf would stay one band.
 *
 * With twenty-nine detectors enabled on live ETHUSDT 1h it produced ONE band,
 * 11.02 ATR wide, labelled "30 sources, disagreeing". Every mark was within
 * 0.75 ATR of the next mark, so the chain walked the entire price range. A
 * band that contains everything is not evidence that thirty things agree; it
 * is the detector reporting that a chart is a chart.
 *
 * A member now joins while it is within `tol` of the band's FIRST member, so
 * total extent is bounded by construction. A genuinely wide shelf is reported
 * as several bands, which is worse-looking and true, rather than one band,
 * which looked better and was not.
 */
export function band(members: readonly Member[], tol: number): Member[][] {
  const sorted = [...members].sort((a, b) => a.price - b.price);
  const out: Member[][] = [];
  let current: Member[] = [];
  for (const m of sorted) {
    const anchor = current[0];
    if (!anchor || m.price - anchor.price <= tol) current.push(m);
    else {
      out.push(current);
      current = [m];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Distinct, non-redundant kinds in a band — the count that decides publication. */
export function independentKinds(members: readonly Member[]): string[] {
  const seen: string[] = [];
  /* Strongest first, so when a redundant pair collides the one that survives
     is the one the operator would rather have named. */
  for (const m of [...members].sort((a, b) => b.confidence - a.confidence)) {
    if (seen.includes(m.kind)) continue;
    if (seen.some((k) => redundantWith(k, m.kind))) continue;
    seen.push(m.kind);
  }
  return seen;
}

export function detectConfluence(
  data: DetectInput,
  found: readonly Detection[],
  opts: ConfluenceOptions = {},
  len = data.c.length,
): Detection[] {
  const bandAtr = opts.bandAtr ?? DEFAULTS.bandAtr;
  const minSources = opts.minSources ?? DEFAULTS.minSources;
  const freshBars = opts.freshBars ?? DEFAULTS.freshBars;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  if (len < 20) return [];

  const a = atr(data.h, data.l, data.c, 14, len);
  const unit = a[len - 1] as number;
  if (!Number.isFinite(unit) || unit <= 0) return [];
  const tol = unit * bandAtr;

  const members: Member[] = [];
  for (const d of found) {
    if (d.kind === "confluence") continue;
    if (d.to < len - freshBars) continue;
    const price = priceOf(d);
    if (price === null || !Number.isFinite(price)) continue;
    members.push({
      kind: d.kind,
      label: d.label,
      price,
      direction: d.direction,
      confidence: d.confidence,
    });
  }
  if (members.length < minSources) return [];

  const out: Detection[] = [];

  for (const group of band(members, tol)) {
    const kinds = independentKinds(group);
    if (kinds.length < minSources) continue;

    const prices = group.map((m) => m.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const mid = (lo + hi) / 2;

    /* One name per independent kind, strongest instance of each. */
    const named: Member[] = [];
    for (const k of kinds) {
      const best = group
        .filter((m) => m.kind === k)
        .sort((x, y) => y.confidence - x.confidence)[0];
      if (best) named.push(best);
    }

    const longs = named.filter((m) => m.direction === "long");
    const shorts = named.filter((m) => m.direction === "short");
    const disagrees = longs.length > 0 && shorts.length > 0;
    const direction: Detection["direction"] = disagrees
      ? "neutral"
      : longs.length > 0
        ? "long"
        : shorts.length > 0
          ? "short"
          : "neutral";

    const list = named.map((m) => m.label).join(", ");
    const width = hi - lo;

    const shapes: Shape[] = [
      {
        type: "box",
        x0: Math.max(0, len - 60),
        x1: len - 1,
        y0: lo === hi ? lo - tol * 0.15 : lo,
        y1: lo === hi ? hi + tol * 0.15 : hi,
        tone: direction === "long" ? "bull" : direction === "short" ? "bear" : "accent",
        extend: true,
        label: `${kinds.length} sources`,
      },
      { type: "level", x0: Math.max(0, len - 60), y: mid, tone: "accent", label: px(mid), dashed: true },
    ];

    out.push({
      id: `confluence-${mid.toFixed(6)}`,
      kind: "confluence",
      label: disagrees ? `${kinds.length} sources, disagreeing` : `${kinds.length} sources agree`,
      direction,
      from: Math.min(...group.map(() => Math.max(0, len - freshBars))),
      to: len - 1,
      /**
       * Rises with independent sources and with their own confidences, and
       * SATURATES well short of 1.
       *
       * The first version was `0.12 * (kinds.length - minSources)`, unbounded,
       * and on the first live run an eight-source band reached 1.15 and
       * clamped to exactly 1.0 — a certainty, published by the one detector in
       * this directory whose header says at length that it does not score.
       * The fifth agreeing detector is worth less than the fourth, and no
       * number of them is worth certainty.
       *
       * It remains a display weight for drawing order. See the header for why
       * it is not offered anywhere a rule could be built on it.
       */
      confidence: clamp01(
        0.3 +
          0.25 * clamp01((kinds.length - minSources) / 4) +
          0.2 * mean(named.map((m) => m.confidence)),
      ),
      reason:
        `${kinds.length} independent detectors land between ${px(lo)} and ${px(hi)}` +
        (width > 0 ? ` (${(width / unit).toFixed(2)} ATR wide)` : "") + `: ${list}. ` +
        (disagrees
          ? `They do not agree on a side — ${longs.length} long, ${shorts.length} short — and that ` +
            `disagreement is the finding. It is not averaged into a lean.`
          : direction === "neutral"
            ? `All of them are levels rather than signals, so this band has no side.`
            : `All of the directional ones point ${direction}.`) +
        ` Redundant pairs are counted once; there is deliberately no confluence score.`,
      shapes,
    });
  }

  out.sort((x, y) => y.confidence - x.confidence);
  return out.slice(0, maxResults);
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length;
