/**
 * Correlation across the watchlist.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS
 * The Risk desk sums open risk across positions and calls it heat. That figure
 * is honest arithmetic and it is also, on a correlated book, an understatement:
 * five 1% positions in five assets that move together is not 5% of risk spread
 * across five bets. It is one 5% bet with five tickets.
 *
 * A correlation matrix is the only thing that can tell you which of those you
 * are holding, and it is the number every retail platform leaves out.
 *
 * WHAT IS COMPUTED, AND WHY THAT AND NOT PRICE
 * Pearson correlation of LOG RETURNS, not of prices. Two assets both drifting
 * upward have near-perfect price correlation and can still have uncorrelated
 * daily moves; it is the moves that hedge or fail to hedge. Log returns also
 * make a 10% rise and a 10% fall symmetric, which arithmetic returns do not.
 *
 * ALIGNMENT IS THE HARD PART. Two series from different venues do not share a
 * bar grid: one has a gap, one has an extra bar, one starts an hour earlier.
 * Correlating them by array position silently pairs Tuesday with Wednesday and
 * produces a confident, meaningless number. Everything below joins on TIMESTAMP
 * and reports how many bars actually overlapped.
 */

/** A price series reduced to what correlation needs. */
export interface ClosesSeries {
  readonly symbol: string;
  readonly closes: readonly { readonly t: number; readonly c: number }[];
}

export interface PairCorrelation {
  readonly a: string;
  readonly b: string;
  /** −1..+1, or NaN when the overlap was too short to mean anything. */
  readonly r: number;
  /** Bars that appear in BOTH series. The number that makes r trustworthy. */
  readonly overlap: number;
  /**
   * Range of `r` across `SUB_WINDOWS` equal slices of the overlap, 0..2.
   *
   * THE FIGURE THAT STOPS A REVERSAL READING AS AN ABSENCE. A pair that was
   * +0.9 for the first half of the window and -0.9 for the second averages to
   * about nothing, and nothing draws as "these two are unrelated" — the opposite
   * of the truth, and indistinguishable from it by `r` alone. CLAUDE.md states
   * the rule directly: a correlation is a point estimate with no window, and
   * BTC against the dollar has actually done this.
   *
   * NaN when the overlap was too short to slice.
   */
  readonly instability: number;
  /**
   * False when the answer moved about, OR could not be checked.
   *
   * Unknown is not stable: too few bars to slice means the question was never
   * asked, and answering "steady" there would be the strongest possible claim
   * made from the least evidence.
   */
  readonly stable: boolean;
}

/**
 * Fewer overlapping bars than this and the coefficient is noise.
 *
 * 30 is the conventional floor and it is already generous: with 30 points an
 * r of 0.35 is not distinguishable from zero at any useful confidence.
 */
export const MIN_OVERLAP = 30;

/** Above this, two instruments are the same bet wearing two names. */
export const HIGH_CORRELATION = 0.8;

/** Slices the overlap is re-measured in, to see whether the answer held. */
export const SUB_WINDOWS = 4;

/** A slice shorter than this cannot support its own coefficient. */
export const MIN_SLICE = 20;

/** Spread across the slices above which the figure is not a settled one. */
export const UNSTABLE_ABOVE = 0.5;

/**
 * Join two series on the UTC DAY rather than the exact timestamp.
 *
 * The default join is exact, which is right for two series from ONE venue and
 * wrong across vendors: yfinance stamps a daily bar at midnight and a broker at
 * its session open, so an exact join between them reports zero overlap for
 * series covering the same days. Pass this as `bucket` for daily cross-vendor
 * work; leave it off for intraday bars from one feed, where two bars really can
 * fall on one day and the later would silently replace the earlier.
 */
export const utcDay = (t: number): number => Math.floor(t / 86_400_000);

/**
 * Align two series on shared timestamps and return their log returns.
 *
 * Returns are computed AFTER the join, not before, so a gap in one series does
 * not manufacture a return spanning it in the other.
 */
export function alignedReturns(
  a: ClosesSeries,
  b: ClosesSeries,
  /**
   * How a timestamp becomes a join key. Identity by default, which is the exact
   * join every existing caller relies on; `utcDay` for cross-vendor dailies.
   */
  bucket: (t: number) => number = (t) => t,
): { readonly ra: number[]; readonly rb: number[] } {
  const mapB = new Map<number, number>();
  for (const p of b.closes) {
    if (Number.isFinite(p.t) && Number.isFinite(p.c) && p.c > 0) mapB.set(bucket(p.t), p.c);
  }

  const seen = new Set<number>();
  const pairs: { t: number; a: number; b: number }[] = [];
  for (const p of a.closes) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.c) || p.c <= 0) continue;
    const key = bucket(p.t);
    /* ONE PAIR PER KEY. With a bucketing join several bars can land on one key,
       and taking them all would count the same day repeatedly — the sample
       inflates while the coefficient is computed on a duplicated point. */
    if (seen.has(key)) continue;
    const other = mapB.get(key);
    if (other !== undefined) {
      seen.add(key);
      pairs.push({ t: key, a: p.c, b: other });
    }
  }
  pairs.sort((x, y) => x.t - y.t);

  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1] as { a: number; b: number };
    const cur = pairs[i] as { a: number; b: number };
    ra.push(Math.log(cur.a / prev.a));
    rb.push(Math.log(cur.b / prev.b));
  }
  return { ra, rb };
}

/** Pearson correlation. NaN when either series has no variance. */
export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] as number;
    sy += y[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (x[i] as number) - mx;
    const b = (y[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  /* A flat series has no variance, so correlation is undefined rather than
     zero — and reporting zero would read as "uncorrelated", which is a claim. */
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

export interface CorrelateOptions {
  /** How a timestamp becomes a join key. See `utcDay`. */
  readonly bucket?: (t: number) => number;
  /**
   * Overlap below which `r` is refused outright. `MIN_OVERLAP` by default.
   *
   * THE ARITHMETIC HAS ONE OWNER; THE POLICY BELOW THE FLOOR DOES NOT, AND
   * THAT IS WHY THIS IS AN OPTION. The cross-asset web DRAWS its pairs, and a
   * drawn line reads as a fact, so it refuses anything it cannot stand behind.
   * The screener's correlation block puts its pairs in a TABLE under a note
   * that names the window, where showing a thin figure and saying it is thin
   * is the more informative answer. Two different surfaces, one measurement.
   *
   * 2 is the arithmetic minimum: Pearson needs two points.
   */
  readonly floor?: number;
}

/**
 * How much two markets moved together, and whether that answer held.
 *
 * THE SECOND HALF IS THE POINT. `r` alone is a point estimate with no window,
 * and the most dangerous shape it can take is a pair that reversed: the
 * whole-window figure comes back near zero and draws as "unrelated" on the very
 * pair a book is most exposed to. So the overlap is sliced and the RANGE of the
 * answers travels with the number.
 */
export function correlate(
  a: ClosesSeries,
  b: ClosesSeries,
  opts: CorrelateOptions = {},
): PairCorrelation {
  const { ra, rb } = alignedReturns(a, b, opts.bucket);
  const overlap = ra.length;
  const floor = Math.max(2, opts.floor ?? MIN_OVERLAP);
  const r = overlap >= floor ? pearson(ra, rb) : NaN;

  const slice = Math.floor(overlap / SUB_WINDOWS);
  const subs: number[] = [];
  if (slice >= MIN_SLICE) {
    for (let k = 0; k < SUB_WINDOWS; k += 1) {
      const from = k * slice;
      const to = k === SUB_WINDOWS - 1 ? overlap : from + slice;
      const sr = pearson(ra.slice(from, to), rb.slice(from, to));
      if (Number.isFinite(sr)) subs.push(sr);
    }
  }
  const instability = subs.length >= 2 ? Math.max(...subs) - Math.min(...subs) : NaN;

  return {
    a: a.symbol,
    b: b.symbol,
    r,
    overlap,
    instability,
    /* UNKNOWN IS NOT STABLE — see `PairCorrelation.stable`. */
    stable: Number.isFinite(r) && Number.isFinite(instability) && instability <= UNSTABLE_ABOVE,
  };
}

export interface CorrelationMatrix {
  readonly symbols: readonly string[];
  /** Every unordered pair, most correlated first by absolute value. */
  readonly pairs: readonly PairCorrelation[];
  /** Pairs at or above HIGH_CORRELATION. The ones that are one bet. */
  readonly clustered: readonly PairCorrelation[];
  /** Pairs the overlap was too short to judge. Reported, never hidden. */
  readonly unjudged: readonly PairCorrelation[];
  readonly note: string;
}

export function buildMatrix(series: readonly ClosesSeries[]): CorrelationMatrix {
  const usable = series.filter((s) => s.closes.length > 0);
  const pairs: PairCorrelation[] = [];

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      pairs.push(correlate(usable[i] as ClosesSeries, usable[j] as ClosesSeries));
    }
  }

  const judged = pairs.filter((p) => Number.isFinite(p.r));
  const unjudged = pairs.filter((p) => !Number.isFinite(p.r));

  judged.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  const clustered = judged.filter((p) => Math.abs(p.r) >= HIGH_CORRELATION);

  let note = "";
  if (usable.length < 2) {
    note = "Correlation needs at least two series.";
  } else if (clustered.length > 0) {
    note = `${clustered.length} pair${clustered.length === 1 ? "" : "s"} above ${HIGH_CORRELATION}: ${clustered
      .slice(0, 3)
      .map((p) => `${p.a}/${p.b} ${p.r.toFixed(2)}`)
      .join(", ")}. Positions in these are one bet with several tickets — portfolio heat counts them separately and will understate what you are actually risking.`;
  } else if (judged.length > 0) {
    note = `Nothing above ${HIGH_CORRELATION}. These move independently enough that separate positions are separate risk.`;
  }

  if (unjudged.length > 0) {
    note += `${note ? " " : ""}${unjudged.length} pair${unjudged.length === 1 ? "" : "s"} had fewer than ${MIN_OVERLAP} overlapping bars and could not be judged — their coefficient would be noise, so none is shown.`;
  }

  return {
    symbols: usable.map((s) => s.symbol),
    pairs: judged,
    clustered,
    unjudged,
    note,
  };
}

/**
 * How much a correlated book understates its own risk.
 *
 * Portfolio heat sums position risk as though every position were independent.
 * For equally-weighted positions with average pairwise correlation r̄, the true
 * combined risk scales as √(n + n(n−1)·r̄) rather than the √n that independence
 * would give — so this returns the ratio between the two.
 *
 * A LOWER BOUND, and it says so wherever it is rendered: it assumes equal
 * weights, uses an average correlation rather than the full covariance matrix,
 * and correlations rise in exactly the drawdowns that matter most.
 */
export function heatUnderstatement(pairs: readonly PairCorrelation[], positions: number): number {
  if (positions < 2) return 1;
  const judged = pairs.filter((p) => Number.isFinite(p.r));
  if (judged.length === 0) return 1;
  const mean = judged.reduce((sum, p) => sum + p.r, 0) / judged.length;
  const n = positions;
  const combined = n + n * (n - 1) * mean;
  if (combined <= 0) return 1;
  return Math.sqrt(combined) / Math.sqrt(n);
}

export interface RollingPoint {
  /** The join key of the LAST bar in the window — see `rollingCorrelation`. */
  readonly t: number;
  readonly r: number;
}

/**
 * How the correlation moved, window by window.
 *
 * `stable` and `instability` say THAT a pair reversed; this says WHEN, which is
 * the difference between a caveat and something an operator can act on. It is
 * the honest form of "show me it live": not an animation, but the figure over
 * time with its own window stated.
 *
 * EACH POINT IS STAMPED AT THE END OF ITS WINDOW, not the middle. A correlation
 * computed from bars up to Friday is a fact you possess on Friday; drawing it at
 * Wednesday would put knowledge earlier on the axis than it existed, which is
 * look-ahead in a picture — the same defect as reading a daily bar's close
 * during its own day, and just as invisible.
 */
export function rollingCorrelation(
  a: ClosesSeries,
  b: ClosesSeries,
  opts: CorrelateOptions & { readonly window?: number; readonly points?: number } = {},
): RollingPoint[] {
  const { ra, rb } = alignedReturns(a, b, opts.bucket);
  const n = ra.length;
  const win = Math.floor(opts.window ?? 90);
  /* A WINDOW BELOW THE FLOOR IS REFUSED, NOT RAISED TO IT. Silently promoting a
     request for 10 days to 30 answers a different question than the caller
     asked, with nothing to say so — the same shape as a figure that moves under
     the operator because a service answered. `correlate` returns NaN below the
     floor for the same reason; this returns no line. */
  if (win < MIN_OVERLAP || n < win) return [];

  /* A BOUNDED NUMBER OF POINTS. A sparkline 40px tall cannot show 3,000 of them,
     and computing every one to throw them away is work nobody sees. */
  const want = Math.max(2, Math.floor(opts.points ?? 60));
  const stride = Math.max(1, Math.floor((n - win) / (want - 1)) || 1);

  /* The join keys, so a point can be stamped with the day it was knowable on.
     `alignedReturns` drops the first bar (a return needs two), so return i
     belongs to key i + 1. */
  const keys = sharedKeys(a, b, opts.bucket);
  const out: RollingPoint[] = [];
  for (let end = win; end <= n; end += stride) {
    const r = pearson(ra.slice(end - win, end), rb.slice(end - win, end));
    if (!Number.isFinite(r)) continue;
    out.push({ t: keys[end] ?? keys[keys.length - 1] ?? 0, r });
  }
  return out;
}

/** The join keys both series share, in order. Same rules as `alignedReturns`. */
function sharedKeys(
  a: ClosesSeries,
  b: ClosesSeries,
  bucket: (t: number) => number = (t) => t,
): number[] {
  const mapB = new Set<number>();
  for (const p of b.closes) {
    if (Number.isFinite(p.t) && Number.isFinite(p.c) && p.c > 0) mapB.add(bucket(p.t));
  }
  const seen = new Set<number>();
  const keys: number[] = [];
  for (const p of a.closes) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.c) || p.c <= 0) continue;
    const k = bucket(p.t);
    if (seen.has(k) || !mapB.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys.sort((x, y) => x - y);
}
