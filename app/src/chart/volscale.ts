/**
 * HOW TALL IS A VOLUME BAR — the arithmetic, on its own, so it can be checked.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG
 *
 * The band scaled linearly against the VISIBLE MAXIMUM: `height = v / max *
 * zoneH`. Volume is heavy-tailed, so one spike sets the scale and flattens
 * everything else. MEASURED on BTCUSDT 1h, into the 42px the band actually has:
 *
 *     visible window   median bar    bars under 3px
 *        120             6.1px            6%
 *        300             5.2px           16%
 *        600             4.5px           23%
 *
 * The median bar used 11–15% of the band. Eighty-five per cent of the pane was
 * empty air, which is exactly what the owner photographed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY NOT LOG, WHICH LOOKS BEST
 *
 * Measured on the same bars: `log1p` puts the median at 75% of the band and
 * nothing is unreadable. It is still the wrong answer, and the reason is this
 * project's own rule about a chart whose scale is a lie that looks exactly like
 * the truth.
 *
 * A log height DESTROYS THE COMPARISON THE PANE EXISTS FOR. Under it a bar that
 * traded ten times the median draws about 1.3x the median's height. A volume
 * climax — the one event anybody reads this strip for — renders as an ordinary
 * bar. A wrong number in a table is something a reader catches; a wrong scale
 * is plausible, unlabelled and not red.
 *
 * `sqrt` is the same objection at half strength: 4x draws as 2x.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES INSTEAD
 *
 * Anchor full height at a ROBUST reference — the 95th percentile of the visible
 * window — and CLIP above it. Below the clip, height stays strictly
 * proportional to volume: twice the volume is twice the bar, which is the one
 * property that makes the strip readable at all. Measured: median 30% of the
 * band, nothing under 3px, about 5% of bars clipped by construction.
 *
 * The clipped bars are not hidden. `clipped` is returned so the caller can mark
 * them, because a bar drawn at full height that is really four times the
 * reference is a silent understatement — the same failure as the flattening it
 * replaces, pointed the other way.
 *
 * `median` is returned because RELATIVE volume is the figure a trader acts on.
 * "7.83" says nothing; "3.2x median" changes a decision.
 */

/** What the caller needs to draw the band and describe it honestly. */
export interface VolumeScale {
  /** Pixel height for one bar's volume. Never NaN, never negative, never > zoneH. */
  readonly heightOf: (v: number) => number;
  /** The volume that draws at FULL height. Anything above is clipped to it. */
  readonly reference: number;
  /** How many of the visible bars exceed `reference`. */
  readonly clipped: number;
  /** The visible window's median volume — the denominator for "x median". */
  readonly median: number;
  /** True when no usable volume was found; the caller draws nothing. */
  readonly empty: boolean;
}

/** Where the reference sits. 0.95 keeps ~5% clipped, which is few enough to mark. */
export const REFERENCE_PERCENTILE = 0.95;

/**
 * The median never draws shorter than `1 / MEDIAN_MULTIPLE` of the band.
 *
 * A PERCENTILE ALONE DOES NOT BOUND READABILITY, and the first version of this
 * file assumed it did. Measured: on BTCUSDT 1h the tail is tame (max/median
 * 8x) and the 95th percentile lands near 3.3x the median, so the median drew
 * at 30% of the band — fine. On a genuinely heavy window (120x) the same
 * percentile sits at 9x the median and the median drew at 11%, which is the
 * defect this file exists to remove, surviving the fix. A test on synthetic
 * heavy-tailed data caught it; the real-data measurement alone would not have.
 *
 * So the reference is the SMALLER of the two bounds. On tame data the
 * percentile wins and almost nothing clips; on a heavy tail this wins and the
 * band stays readable at the cost of clipping more — which is the honest
 * trade, because the alternative is 95% of the window drawn as a smear.
 */
export const MEDIAN_MULTIPLE = 3;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[i] as number;
}

/**
 * Build the scale for one visible window.
 *
 * `values` is read over `[from, to)`. Anything non-finite or negative is
 * ignored rather than repaired — a volume this cannot read is not a zero.
 */
export function volumeScale(
  values: ArrayLike<number>,
  from: number,
  to: number,
  zoneH: number,
): VolumeScale {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(values.length, Math.ceil(to));
  const usable: number[] = [];
  for (let i = lo; i < hi; i += 1) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) usable.push(v);
  }
  const band = Number.isFinite(zoneH) && zoneH > 0 ? zoneH : 0;

  if (usable.length === 0 || band === 0) {
    return { heightOf: () => 0, reference: 0, clipped: 0, median: 0, empty: true };
  }

  const sorted = [...usable].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  /* THE SMALLER OF TWO BOUNDS — see MEDIAN_MULTIPLE. The percentile keeps
     clipping rare on ordinary windows; the median multiple keeps the band
     readable when the tail is long enough that a percentile cannot. */
  const byPercentile = percentile(sorted, REFERENCE_PERCENTILE);
  const byMedian = median * MEDIAN_MULTIPLE;
  let reference = byPercentile > 0 ? Math.min(byPercentile, byMedian) : byMedian;

  /* A window where every bar is identical: the percentile IS the median, so
     anchoring there would clip half of them. The median multiple already
     covers this — it is stated because it is the case a reader checks for. */
  if (reference <= median) reference = byMedian;
  /* Still zero only if every usable bar was zero, which `usable` excludes —
     but a reference of zero would divide, so it is refused rather than used. */
  if (!(reference > 0)) {
    return { heightOf: () => 0, reference: 0, clipped: 0, median, empty: true };
  }

  const clipped = usable.reduce((n, v) => (v > reference ? n + 1 : n), 0);

  return {
    heightOf: (v: number): number => {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
      const h = (v / reference) * band;
      return h > band ? band : h;
    },
    reference,
    clipped,
    median,
    empty: false,
  };
}

/**
 * "3.2x median" — what the bar under the cursor traded, RELATIVE to its window.
 *
 * Returns null when there is nothing to compare against, because a ratio with
 * no denominator is not a small number, it is an unanswered question.
 */
export function relativeVolume(v: number, median: number): number | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (!Number.isFinite(median) || median <= 0) return null;
  return v / median;
}

/** `3.2x` / `0.4x`. One decimal below ten, none above — the precision is fake past that. */
export function formatRelative(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "";
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
}
