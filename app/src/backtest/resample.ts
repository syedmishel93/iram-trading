/**
 * The statistics a cross-market survey needs and a single backtest does not.
 *
 * WHY THIS EXISTS SEPARATELY FROM `validate.ts`
 * `validate.ts` answers "was this winner picked by luck from a grid?" — PBO and
 * walk-forward, both defined over one instrument's bars. A survey asks a
 * different question: "this cell shows +0.31R over 240 trades drawn from four
 * markets; is that distinguishable from nothing, given that I looked at
 * seventy-eight cells?" Neither PBO nor walk-forward answers it, and the answer
 * needs two tools that belong nowhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOOL ONE: A BLOCK BOOTSTRAP, NOT A t-TEST
 *
 * The obvious test of "is mean R above zero" is a one-sample t-test. It is
 * wrong here twice over.
 *
 *  * **Trade returns are not normal.** They are a spike at -1R (the stop) and a
 *    thin right tail (the runners). `metrics.ts` already says this about
 *    Sharpe. A t-test on forty trades from that distribution has a real error
 *    rate nowhere near its nominal one.
 *  * **Consecutive trades are not independent.** A trend rule in a trending
 *    month wins repeatedly, and the same rule spends the next month being
 *    stopped out repeatedly. Treating 240 serially-correlated trades as 240
 *    independent draws inflates the effective sample — the standard error comes
 *    out too small and marginal cells are declared significant.
 *
 * A **circular block bootstrap** fixes both. Resampling whole BLOCKS of
 * consecutive trades rather than individual ones carries the local dependence
 * into each replicate, so the resulting spread reflects the clustering that is
 * actually there. Nothing is assumed about the shape of the distribution
 * because the distribution is the data.
 *
 * "Circular" — blocks wrap past the end — because with straight blocks the
 * first and last observations can only ever appear in one block each, so the
 * ends of the series are systematically under-weighted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY GROUPS ARE RESAMPLED SEPARATELY
 *
 * A survey pools trades from several instruments. A block that straddles the
 * boundary between the last BTC trade and the first gold trade is not a run of
 * correlated trades; it is an artefact of the order they were concatenated in.
 * So each instrument is resampled within itself, keeping its own trade count,
 * and the replicates are pooled afterwards. The dependence being modelled is
 * dependence in TIME within one market, which is the only kind that exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOOL TWO: A FALSE-DISCOVERY CORRECTION
 *
 * Twenty-six rules times three regimes is seventy-eight tests. At a 5%
 * threshold, roughly four of them come back "significant" on data with no edge
 * in it whatsoever — and those four are exactly the cells a ranked table puts
 * at the top. Reporting an uncorrected p-value from a survey is not a smaller
 * version of the overfitting `lab.ts` refuses to ship; it is the same thing
 * with more cells.
 *
 * **Benjamini-Hochberg** rather than Bonferroni. Bonferroni controls the chance
 * of ANY false positive, which for seventy-eight correlated tests is so strict
 * that nothing survives and the survey reports "no edge anywhere" whatever is
 * in the data — a test that always says no is not a test. BH controls the
 * expected PROPORTION of reported findings that are false, which is the
 * quantity a reader of a ranked table actually cares about: "of the six cells
 * this says held, about one is noise."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DETERMINISM IS NOT OPTIONAL
 *
 * `regime.ts` refuses to source its labels from an optional service because a
 * backtest whose numbers move between runs cannot be compared with yesterday's.
 * A bootstrap seeded from `Math.random` breaks the same promise more quietly:
 * the cell that survived this morning is marginal this afternoon and nobody can
 * tell whether the data changed. So the generator is a plain seeded PRNG, the
 * seed is derived from the data itself, and two runs over identical trades
 * return identical p-values.
 */

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Not cryptographic and not trying to be. What it has to be is *seeded and
 * portable*: the same seed must give the same stream in a browser, in Node and
 * in next year's build, so a survey is reproducible. `Math.random` provides no
 * such guarantee and cannot be seeded at all.
 */
export function rng(seed: number): () => number {
  /* Coerce to a 32-bit integer, avoiding the all-zero state. Zero is a legal
     seed for this generator but an easy accidental one, and a fixed odd
     constant keeps the stream well-mixed from the first draw. */
  let a = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seed derived from the values being tested.
 *
 * So that the seed is a function of the DATA rather than of a call order: the
 * same cell tested inside a different survey, or after another cell was added,
 * gets the same stream and the same p-value. A counter-based seed would make a
 * cell's significance depend on how many cells preceded it, which is not a
 * property anybody would expect or could reason about.
 */
export function seedFrom(values: readonly number[]): number {
  /* FNV-1a over the values' bit patterns. Cheap, order-sensitive, and stable
     across engines because it only ever touches integers. */
  let h = 0x811c9dc5;
  const buf = new Float64Array(1);
  const view = new Uint32Array(buf.buffer);
  for (const v of values) {
    buf[0] = v;
    h = Math.imul(h ^ (view[0] as number), 0x01000193);
    h = Math.imul(h ^ (view[1] as number), 0x01000193);
  }
  return h | 0;
}

/**
 * Block length for a series of `n` observations.
 *
 * `n^(1/3)` is the standard order for the block bootstrap: long enough to carry
 * short-range dependence, short enough that the number of distinct blocks still
 * grows with the sample. It is an order of magnitude rather than an optimum —
 * the data-driven choices need an estimate of the autocorrelation structure,
 * which on forty trades is itself noise.
 *
 * Floored at 1 (an ordinary bootstrap) and capped at a quarter of the series,
 * because four blocks cannot describe a distribution.
 */
export function blockLength(n: number): number {
  if (n <= 4) return 1;
  return Math.max(1, Math.min(Math.round(Math.cbrt(n)), Math.floor(n / 4)));
}

export interface BootstrapResult {
  /** Mean of the observed values, pooled across groups. */
  readonly mean: number;
  /**
   * One-sided p-value for H0: the true mean is at or below zero.
   *
   * Computed by CENTERING: the observed mean is subtracted from every
   * replicate, so the replicates describe the spread of a process with no edge,
   * and `p` is how often that spread alone reaches the observed mean. Comparing
   * uncentered replicates with zero would instead measure how often the
   * bootstrap reproduces its own input — which is near-always, and would report
   * every positive sample as significant.
   */
  readonly p: number;
  /** Percentile interval of the (uncentered) replicate means. */
  readonly lo: number;
  readonly hi: number;
  /** Replicates actually drawn. Zero when there was nothing to resample. */
  readonly draws: number;
  /** Block length used, reported so the reader can see the assumption. */
  readonly block: number;
}

export const NO_BOOTSTRAP: BootstrapResult = {
  mean: 0,
  p: 1,
  lo: 0,
  hi: 0,
  draws: 0,
  block: 0,
};

/** Replicates. 2,000 resolves p to ~0.0005, far finer than anything claimed. */
export const DRAWS = 2_000;

/**
 * Circular block bootstrap of the pooled mean, resampling within each group.
 *
 * `groups` is one array of observations per instrument, in TIME order — the
 * order matters, because that is the dependence being preserved. Groups keep
 * their own lengths in every replicate, so the pooled mean is weighted exactly
 * as the observed one is and the test is about the number actually reported.
 */
export function blockBootstrap(
  groups: readonly (readonly number[])[],
  draws = DRAWS,
  interval = 0.9,
): BootstrapResult {
  const usable = groups.filter((g) => g.length > 0);
  const total = usable.reduce((a, g) => a + g.length, 0);
  if (total === 0) return NO_BOOTSTRAP;

  const flat: number[] = [];
  for (const g of usable) for (const v of g) flat.push(v);

  let sum = 0;
  for (const v of flat) sum += v;
  const mean = sum / total;

  /* One observation cannot have a sampling distribution. Report the value with
     a p-value of 1 rather than a spuriously tight interval around itself. */
  if (total < 2) return { mean, p: 1, lo: mean, hi: mean, draws: 0, block: 1 };

  const next = rng(seedFrom(flat));
  const blocks = usable.map((g) => blockLength(g.length));
  const reported = Math.max(...blocks);

  /**
   * PREFIX SUMS OVER THE DOUBLED SERIES.
   *
   * The straightforward loop adds up each block element by element: `n/L` blocks
   * of `L` values is O(n) additions per replicate, so 2,000 replicates over a
   * cell with 3,000 trades is six million additions — and MEASURED, the bootstrap
   * was 1.13 s of a 1.86 s survey, more than the hundred and four backtests it was
   * validating.
   *
   * A block's sum is a contiguous range sum, so a prefix-sum table answers it in
   * one subtraction: O(n/L) per replicate instead of O(n), a factor of L (about
   * ten to eighteen at these sizes).
   *
   * The series is DOUBLED first, which is what makes wrapping free. A circular
   * block starting near the end runs off the end of a plain prefix table; laid
   * out twice, `[start, start + take)` is always contiguous and the modulo
   * disappears from the inner loop along with the loop itself.
   *
   * Note this changes the ORDER of the additions, so results differ from the
   * element-wise version in the last bits of the mantissa. That is not a
   * behaviour change worth guarding — the p-value is a proportion of 2,000
   * draws — but it is why the tests compare with a tolerance rather than exactly.
   */
  const prefix = usable.map((g) => {
    const n = g.length;
    const pre = new Float64Array(2 * n + 1);
    for (let i = 0; i < 2 * n; i++) pre[i + 1] = (pre[i] as number) + (g[i % n] as number);
    return pre;
  });

  const means = new Float64Array(draws);
  for (let b = 0; b < draws; b++) {
    let acc = 0;
    for (let gi = 0; gi < usable.length; gi++) {
      const n = (usable[gi] as readonly number[]).length;
      const pre = prefix[gi] as Float64Array;
      const L = Math.min(blocks[gi] as number, n);
      let filled = 0;
      while (filled < n) {
        /* A start anywhere in the series, and the block WRAPS — straight blocks
           would let the first and last observations appear in one block each
           while the middle appears in L, biasing every replicate towards the
           middle of the series. One `next()` per block, exactly as before, so the
           draw sequence is unchanged. */
        const start = Math.floor(next() * n);
        const take = Math.min(L, n - filled);
        acc += (pre[start + take] as number) - (pre[start] as number);
        filled += take;
      }
    }
    means[b] = acc / total;
  }

  /* CENTERED. `replicate - observed` is the deviation attributable to
     resampling noise alone; p is how often noise alone covers the whole
     observed mean. */
  let atLeast = 0;
  for (let b = 0; b < draws; b++) if ((means[b] as number) - mean >= mean) atLeast++;
  /* The +1s are Davison & Hinkley's correction: a bootstrap that never once
     reached the observed value has not shown p = 0, it has shown p < 1/draws,
     and reporting an exact zero from 2,000 draws overstates what was done. */
  const p = (atLeast + 1) / (draws + 1);

  const sorted = Array.from(means).sort((a, b) => a - b);
  const tail = (1 - interval) / 2;
  const pick = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] as number;

  return { mean, p, lo: pick(tail), hi: pick(1 - tail), draws, block: reported };
}

/**
 * Benjamini-Hochberg adjusted p-values ("q-values"), in the input's order.
 *
 * `q[i]` is the smallest false-discovery rate at which test `i` would be
 * called. Read it directly: a cell with q = 0.08 sits in a set where about 8%
 * of the reported findings are expected to be noise.
 *
 * The step-up runs from the LARGEST p downwards, taking a running minimum,
 * which is what enforces monotonicity — without it a test with a smaller p
 * could receive a larger q, and a reader sorting the table would see the two
 * columns disagree about the ordering.
 */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const out = new Array<number>(m).fill(1);
  if (m === 0) return out;

  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const entry = order[rank - 1] as { p: number; i: number };
    running = Math.min(running, (entry.p * m) / rank);
    out[entry.i] = Math.min(1, Math.max(0, running));
  }
  return out;
}

/**
 * The false-discovery rate a survey reports at.
 *
 * 10% rather than the reflexive 5%. This is a screening step whose output is
 * "worth walking forward", not a claim of proof — every cell that passes still
 * has to survive the out-of-sample gate in `promote.ts` before it reaches a
 * desk. Screening at 5% discards real effects to protect a claim nothing here
 * makes.
 */
export const FDR = 0.1;
