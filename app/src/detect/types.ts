/**
 * Detection and drawing types.
 *
 * A detector's job is not to draw. It reports WHAT it found, WHERE, and WHY,
 * in data coordinates (bar index and price). Turning that into pixels is the
 * renderer's job. Keeping the split means every detector is a pure function
 * that can be unit-tested without a canvas — and the same detection can be
 * drawn, listed in a panel, or fed to a strategy without being recomputed.
 */

export type Tone = "bull" | "bear" | "neutral" | "accent";

/** A shape in DATA space. x is a bar index (fractional allowed), y is a price. */
export type Shape =
  | {
      type: "box";
      x0: number;
      x1: number;
      y0: number;
      y1: number;
      tone: Tone;
      label?: string;
      /** Extend the right edge to the live edge of the chart. */
      extend?: boolean;
      dashed?: boolean;
    }
  | {
      type: "line";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      tone: Tone;
      label?: string;
      dashed?: boolean;
      extend?: boolean;
    }
  | {
      type: "level";
      /** Horizontal price level, drawn from x0 to the right edge. */
      x0: number;
      y: number;
      tone: Tone;
      label?: string;
      dashed?: boolean;
    }
  | {
      type: "marker";
      x: number;
      y: number;
      tone: Tone;
      text: string;
      /** Draw above the bar rather than below it. */
      above: boolean;
    };

export type DetectionKind =
  | "bos"
  | "choch"
  | "fvg"
  | "order-block"
  | "level"
  | "double-top"
  | "double-bottom"
  | "head-shoulders"
  | "trendline"
  | "divergence"
  /* v49. Liquidity and context, as opposed to shape: the eight above all
     describe a form price traced out, and these describe what was resting
     where, what got taken, and what condition the market is in. */
  | "equal-highs"
  | "equal-lows"
  | "liquidity-sweep"
  | "breaker"
  | "range"
  | "expansion"
  | "session-range"
  /* v54. Twenty-eight kinds in one pass, which needs justifying: the measured
     record said every one of the ten characterisable kinds above sits at or
     below break-even at 1R, so the answer is not a better shape — it is more
     axes to condition on. Candles say what a single bar did, the profile says
     where business was actually done, the anchors say what price was already
     paying attention to, and the failures say what did NOT work, which is the
     only group here that is defined by something breaking.

     Every one of them is judged by `setup/simulate.ts` the moment it exists,
     so adding a kind is adding a FALSIFIABLE claim, not adding a feature. */

  /* Single-bar and few-bar shapes. Gated on location by construction: a
     standalone engulfing is noise, and the detector will not publish one. */
  | "engulfing"
  | "pin-bar"
  | "inside-bar"
  | "star"

  /* Converging and parallel boundaries — the shapes `formations.ts` never had. */
  | "wedge"
  | "triangle"
  | "channel"
  | "flag"

  /* The one axis that is not arithmetic on close: how much traded WHERE. */
  | "poc"
  | "value-area"
  | "lvn"
  | "volume-climax"

  /* Volatility state, and the one discontinuity a bar series can contain. */
  | "squeeze"
  | "gap"

  /* Levels price was already watching before any pattern formed. */
  | "round-level"
  | "fib"
  | "pivot-level"
  | "prior-level"
  | "avwap"

  /* Failure. Each is something above going wrong, which is why they are cheap
     to compute and why they are the group most likely to carry an edge. */
  | "spring"
  | "upthrust"
  | "failed-break"
  | "retest"
  | "mitigation"

  /* Time, rather than price. */
  | "killzone"
  | "opening-range"

  /* Fibonacci ratios over five pivots. */
  | "harmonic"

  /* The meta-kind: agreement between the others, published as one band. */
  | "confluence";

export interface Detection {
  /** Stable within one run, so the UI can key on it. */
  id: string;
  kind: DetectionKind;
  label: string;
  direction: "long" | "short" | "neutral";
  /** Bar index where the structure begins. */
  from: number;
  /** Bar index where it completes — the bar at which it became knowable. */
  to: number;
  /** 0..1. Derived from measurable properties, never a guess. */
  confidence: number;
  /** Plain language, shown verbatim. Same contract as the confluence engine. */
  reason: string;
  shapes: Shape[];
}

export interface DetectInput {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Price formatting shared by every detector's reason string. */
export function px(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toFixed(dp);
}
