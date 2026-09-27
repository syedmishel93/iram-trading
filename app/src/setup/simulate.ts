/**
 * What happened the last N times this setup appeared on this chart.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `engine.ts` can rank candidates and say why one won. What it could not say
 * — what nothing in the repository could say — is the only question a trader
 * actually asks of a pattern:
 *
 *     "Fine. When this happened before, what happened next?"
 *
 * A score of 88 is an ordinal. It says this candidate beat the other 272 on
 * the chart. It does not say the idea makes money, and the difference between
 * those two is the entire distance between a pretty terminal and a useful one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REPLAY, NOT SYNTHESIS
 *
 * Every trial here is a real historical instance of the same detector firing
 * on the same instrument, replayed against the bars that actually followed it.
 * Nothing is generated. There is no random price path, no fitted distribution
 * to sample from, no "simulated market". The word simulation in this file
 * means *the trade was simulated*, never *the data was*.
 *
 * That restriction is the reason the numbers are worth reading. A Monte Carlo
 * over a fitted return distribution will happily produce a 200-trial sample
 * with tight confidence bands for a pattern that has occurred four times, and
 * the bands describe the fit, not the market. Here, n is small when the
 * evidence is small, and `enough` says so out loud.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FIVE RULES THAT KEEP IT HONEST
 *
 * 1. STRICTLY AFTER. A trial opens on the bar following confirmation, never
 *    on the confirmation bar itself. The bar a pattern completes on contains
 *    the move that completed it; entering inside it scores the setup against
 *    its own cause. Same rule, same reason as `learn/resolve.ts`.
 *
 * 2. GEOMETRY IS RE-DERIVED AT THE ANALOGUE'S OWN BAR. The live setup's stop
 *    is a price from today. Applying it to an instance from 400 bars ago —
 *    when the instrument traded 30% lower — would produce a stop that was
 *    never touchable and a hit rate near 100%. Each trial takes its stop from
 *    its OWN detection's shapes via `invalidationOf`, at its own bar index,
 *    and its target from the same R multiple the live plan uses.
 *
 * 3. BOTH-IN-ONE-BAR IS NOT A COIN FLIP. A bar whose range covers the target
 *    and the stop does not say which came first. OHLC is four numbers, not a
 *    path. Those trials are counted, reported, and excluded from every
 *    statistic — see `unknowable`. Folding them into either bucket is how a
 *    backtest quietly manufactures an edge.
 *
 * 4. NO PEEKING AT THE TAIL. Analogues within one horizon of the live edge
 *    cannot have resolved yet. Including them would silently fill the recent
 *    end of the sample with expiries and drag the hit rate down; excluding
 *    them keeps every trial a completed one.
 *
 * 5. IT DOES NOT VOTE. See the block below. This is the important one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A FACTOR IN THE RANKING SCORE
 *
 * The obvious next move is to feed the simulated hit rate back into
 * `chooseSetup` as a sixth weighted factor, so the terminal prefers patterns
 * that have worked. Doing that would be the single most damaging change
 * available to this codebase, and it is worth writing down why.
 *
 * The candidates are FOUND on the same bars the trials are SCORED on. Ranking
 * 300 candidates by their performance on the sample that produced them selects
 * the luckiest, not the best — which is precisely the mechanism behind the
 * PBO of 89% already measured on the shipped strategy set. Adding it here
 * would reproduce that failure inside the one module built to expose it, and
 * it would look like an improvement, because in-sample everything does.
 *
 * So the simulation is reported next to the score and never inside it. It is
 * evidence handed to a human, and to the agent, and it is allowed to say
 * "history disagrees with this ranking" — which is a sentence worth far more
 * than a number that has quietly absorbed the disagreement.
 *
 * Related: `learn/store.ts` refuses the same feedback loop for the same reason.
 */

import type { Detection, DetectInput, Shape } from "../detect/types";
import { invalidationOf } from "./engine";
import { atr as atrSeries } from "../chart/indicators";

/**
 * Below this the sample is quoted but never characterised.
 *
 * Twelve is not a statistical threshold — there is no clean one — it is the
 * point below which a Wilson interval on a proportion is so wide that the
 * honest summary is the interval itself rather than any statement about edge.
 */
export const MIN_TRIALS = 12;

/** Enough to say something about the shape of the R distribution, not just its sign. */
export const GOOD_TRIALS = 30;

/** Bootstrap resamples for the expectancy interval. Deterministic — see `rng`. */
export const BOOTSTRAP_N = 400;

/** How one historical instance turned out. */
export interface Trial {
  /** Bar index the pattern confirmed on. The trial opens at `atBar + 1`. */
  readonly atBar: number;
  /** Epoch ms of the confirmation bar. */
  readonly at: number;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly outcome: "target" | "stop" | "expired" | "unknowable";
  /** Realised R. Null for `unknowable`, which is excluded from everything. */
  readonly r: number | null;
  /** Bars from open to resolution. */
  readonly heldBars: number;
}

export interface Simulation {
  readonly kind: string;
  readonly direction: "long" | "short";
  readonly trials: readonly Trial[];

  /** Scoreable trials: every trial except `unknowable`. */
  readonly n: number;
  readonly wins: number;
  readonly losses: number;
  readonly expiries: number;
  readonly unknowable: number;

  /** Wins / n. Null when n is 0. */
  readonly hitRate: number | null;
  /** Wilson lower bound at 95%. The number to quote when quoting one. */
  readonly hitLow: number | null;
  /** Mean realised R across scoreable trials. */
  readonly expectancy: number | null;
  /** Percentile-bootstrap 90% interval on expectancy, seeded and reproducible. */
  readonly expectancyLow: number | null;
  readonly expectancyHigh: number | null;
  readonly medianBars: number | null;

  /** n >= MIN_TRIALS. Below this nothing here should be characterised. */
  readonly enough: boolean;
  /**
   * True only when the whole 90% expectancy interval sits below zero — that
   * is, history is not merely unimpressive but actively against the idea.
   */
  readonly adverse: boolean;
  /** One sentence, safe to render verbatim. Says why when it cannot say much. */
  readonly note: string;
}

export interface SimulateOptions {
  /** Reward-to-risk the live plan is using. Targets are set at this multiple. */
  readonly rMultiple: number;
  /** Bars a trial gets before it expires. Matches the engine's live window. */
  readonly horizonBars: number;
  /** ATR period for the fallback stop. */
  readonly atrPeriod?: number;
  /** Multiple of ATR used when a detection publishes no usable geometry. */
  readonly atrStopMultiple?: number;
  /**
   * The operator's own minimum stop, in ATR.
   *
   * Applied as a FLOOR on every trial, geometric stops included, because
   * `buildPlan` applies exactly the same floor to the live plan. Without it
   * the simulator prices trades the terminal would never have proposed — see
   * the block above `stopFor`.
   */
  readonly minAtrMultiple?: number;
  /** Cap on trials, newest first. Keeps a 50k-bar series from stalling a frame. */
  readonly maxTrials?: number;
}

/* -------------------------------------------------------------------------- */
/* statistics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wilson score interval, lower bound, 95%.
 *
 * Not wins/n. A pattern that won 3 of 3 has a point estimate of 100% and a
 * Wilson lower bound of 44%, and the second number is the one that stops a
 * three-sample fluke being read as a certainty.
 */
export function wilsonLow(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/**
 * A seeded xorshift32.
 *
 * The bootstrap needs randomness; the terminal needs the same chart to produce
 * the same numbers twice, or nobody can check anything. Seeded from the sample
 * itself, so it is stable across reloads and different across instruments.
 */
function rng(seed: number): () => number {
  let s = seed | 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 0x100000000) / 0x100000000;
  };
}

/** Percentile bootstrap interval on the mean. Returns [low, high]. */
export function bootstrapMean(
  values: readonly number[],
  lowQ = 0.05,
  highQ = 0.95,
  draws = BOOTSTRAP_N,
): [number, number] | null {
  const n = values.length;
  if (n === 0) return null;
  if (n === 1) return [values[0] as number, values[0] as number];

  /* Seed from the data so the answer is reproducible per sample. */
  let seed = n * 2654435761;
  for (const v of values) seed = (seed ^ Math.round(v * 1000)) * 16777619;
  const next = rng(seed);

  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(next() * n) % n] as number;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number): number => means[Math.min(means.length - 1, Math.max(0, Math.round(q * (means.length - 1))))] as number;
  return [at(lowQ), at(highQ)];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/* -------------------------------------------------------------------------- */
/* the replay                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Walk one trial forward from `openAt` until it hits, stops, or runs out.
 *
 * Deliberately identical in shape to `learn/resolve.ts:resolveClaim`, including
 * the both-in-one-bar refusal. Two resolvers that disagree about what a win is
 * would make the simulated hit rate and the recorded hit rate incomparable,
 * and comparing them is the whole point of having both.
 */
function walk(
  data: DetectInput,
  len: number,
  openAt: number,
  long: boolean,
  stop: number,
  target: number,
  horizonBars: number,
): { outcome: Trial["outcome"]; heldBars: number } {
  const last = Math.min(len - 1, openAt + horizonBars);
  for (let i = openAt; i <= last; i++) {
    const h = data.h[i] as number;
    const l = data.l[i] as number;
    const hitTarget = long ? h >= target : l <= target;
    const hitStop = long ? l <= stop : h >= stop;
    if (hitTarget && hitStop) return { outcome: "unknowable", heldBars: i - openAt + 1 };
    if (hitTarget) return { outcome: "target", heldBars: i - openAt + 1 };
    if (hitStop) return { outcome: "stop", heldBars: i - openAt + 1 };
  }
  return { outcome: "expired", heldBars: last - openAt + 1 };
}

/**
 * Replay every historical instance of one detection kind and direction.
 *
 * `detections` is the full detector output over the series — the same array the
 * chart draws — so no re-detection is needed and the analogues are by
 * construction the same things the operator can see on their own chart.
 */
export function simulateKind(
  kind: string,
  direction: "long" | "short",
  detections: readonly Detection[],
  data: DetectInput,
  len: number,
  opts: SimulateOptions,
): Simulation {
  const long = direction === "long";
  const rMultiple = opts.rMultiple > 0 ? opts.rMultiple : 2;
  const horizon = Math.max(1, Math.round(opts.horizonBars));
  const atrMult = opts.atrStopMultiple ?? 1;
  const minAtrMult = opts.minAtrMultiple ?? 0;
  const maxTrials = opts.maxTrials ?? 300;

  const empty = (note: string): Simulation => ({
    kind,
    direction,
    trials: [],
    n: 0,
    wins: 0,
    losses: 0,
    expiries: 0,
    unknowable: 0,
    hitRate: null,
    hitLow: null,
    expectancy: null,
    expectancyLow: null,
    expectancyHigh: null,
    medianBars: null,
    enough: false,
    adverse: false,
    note,
  });

  if (len < horizon + 5) return empty("Not enough history loaded to replay this setup.");

  const a = atrSeries(data.h, data.l, data.c, opts.atrPeriod ?? 14, len);

  /* Rule 4: an analogue inside one horizon of the live edge cannot have
     finished. Newest first, so the cap keeps the RECENT instances rather than
     an arbitrary slice of ancient ones. */
  const cutoff = len - 1 - horizon;
  const eligible = detections.filter(
    (d) => d.kind === kind && d.direction === direction && d.to <= cutoff && d.to >= 1,
  );

  /**
   * ONE INSTANCE PER BAR.
   *
   * Higher-timeframe projections put the same idea on the chart several times
   * — a 1d sweep and its 4h and 1h projections all confirm on the same bar —
   * and the detector list contains all of them because the chart draws all of
   * them. Replaying each as its own trial triples the sample without adding a
   * single new observation, and n is the number licensing every statistic
   * below it. Measured on ETHUSDT 1d: 12 trials from 4 actual instances.
   *
   * The engine collapses the same duplication at ranking time (`rivalTo`); this
   * is the same collapse at replay time, keeping the most confident of each set
   * because that is the one the engine would have chosen.
   */
  const byBar = new Map<number, Detection>();
  for (const d of eligible) {
    const held = byBar.get(d.to);
    if (held === undefined || d.confidence > held.confidence) byBar.set(d.to, d);
  }
  const pool = [...byBar.values()].sort((x, y) => y.to - x.to).slice(0, maxTrials);

  if (pool.length === 0) {
    /**
     * TWO REASONS FOR AN EMPTY POOL, AND THEY ARE NOT THE SAME STATEMENT.
     *
     * Detectors fall into two families, which nothing in the codebase had
     * needed to distinguish before. EVENT detectors — break of structure,
     * change of character, sweeps, doubles, head and shoulders, divergence —
     * publish every instance they ever found, so their history is replayable:
     * measured on ETHUSDT 15m, 64 CHoCH spanning bars 44 to 764.
     *
     * STATE detectors describe what is true NOW. A trendline detector reports
     * the lines currently in play, not every line that ever existed and died;
     * same for ranges, session ranges and equal highs. On that same chart all
     * six trendlines sat between bars 727 and 790, and none of them could have
     * resolved yet.
     *
     * "This pattern has never happened here" and "this detector does not keep
     * a history" are different facts, and only the first is about the market.
     * Reporting the second as the first would quietly tell the operator a
     * common setup is rare.
     */
    const anyAtAll = eligible.length > 0 || detections.some((d) => d.kind === kind && d.direction === direction);
    return empty(
      anyAtAll
        ? `This detector only reports ${kind.replace(/-/g, " ")} while it is live, so there is no history here to replay.`
        : `No completed instance of ${kind.replace(/-/g, " ")} in the history loaded.`,
    );
  }

  const trials: Trial[] = [];
  for (const d of pool) {
    const atBar = d.to;
    const openAt = atBar + 1;
    if (openAt >= len) continue;

    /* Entry is the close of the confirmation bar: the first price at which the
       pattern was knowable. Not the open of the next bar, which is a price the
       operator could not have acted on either. */
    const entry = data.c[atBar] as number;
    if (!Number.isFinite(entry) || entry <= 0) continue;

    /* Rule 2: this analogue's own geometry, at this analogue's own bar. */
    const geo = invalidationOf(d.shapes as readonly Shape[], direction, entry, atBar);
    const atrHere = a[atBar] as number;
    const hasAtr = Number.isFinite(atrHere) && atrHere > 0;
    const fallback = hasAtr ? (long ? entry - atrHere * atrMult : entry + atrHere * atrMult) : null;
    const raw = geo ?? fallback;
    if (raw === null || !Number.isFinite(raw) || raw <= 0) continue;

    /**
     * THE SAME FLOOR THE LIVE PLAN USES.
     *
     * `buildPlan` takes whichever of the structural and volatility stops sits
     * FURTHER from entry, so the real rule on the card is "the setup's
     * invalidation, or the minimum ATR multiple, whichever is further". A
     * simulator that skipped the floor would replay trades the terminal would
     * never have proposed: measured on ETHUSDT 1d, one analogue's level sat
     * 8.9 basis points from entry, and a stop that tight on a daily bar is
     * resolved inside the entry bar every time — which is how 9 of 12 trials
     * came back `unknowable` and the whole sample evaporated.
     */
    const floor = hasAtr && minAtrMult > 0 ? atrHere * minAtrMult : 0;
    const risk = Math.max(Math.abs(entry - raw), floor);
    if (!(risk > 0)) continue;
    const stop = long ? entry - risk : entry + risk;
    const target = long ? entry + risk * rMultiple : entry - risk * rMultiple;

    const { outcome, heldBars } = walk(data, len, openAt, long, stop, target, horizon);
    const r =
      outcome === "target"
        ? rMultiple
        : outcome === "stop"
          ? -1
          : outcome === "expired"
            ? /* Marked to market at the horizon, in R. An expiry is not a
                 scratch: a long that drifted half way to target and ran out of
                 time did better than one that sat still, and calling both zero
                 throws away the difference. */
              (() => {
                const exitAt = Math.min(len - 1, openAt + horizon);
                const exit = data.c[exitAt] as number;
                return Number.isFinite(exit) ? ((long ? exit - entry : entry - exit) / risk) : 0;
              })()
            : null;

    trials.push({ atBar, at: data.t[atBar] as number, entry, stop, target, outcome, r, heldBars });
  }

  const unknowable = trials.filter((t) => t.outcome === "unknowable").length;
  const scored = trials.filter((t) => t.outcome !== "unknowable");
  const n = scored.length;
  const wins = scored.filter((t) => t.outcome === "target").length;
  const losses = scored.filter((t) => t.outcome === "stop").length;
  const expiries = scored.filter((t) => t.outcome === "expired").length;

  if (n === 0) {
    return {
      ...empty("Every instance resolved inside a single bar — the history cannot say which came first."),
      trials,
      unknowable,
    };
  }

  const rs = scored.map((t) => t.r as number);
  const expectancy = rs.reduce((s, v) => s + v, 0) / n;
  const boot = bootstrapMean(rs);
  const hitRate = wins / n;
  const hitLow = wilsonLow(wins, n);
  const enough = n >= MIN_TRIALS;
  const adverse = enough && boot !== null && boot[1] < 0;

  return {
    kind,
    direction,
    trials,
    n,
    wins,
    losses,
    expiries,
    unknowable,
    hitRate,
    hitLow,
    expectancy,
    expectancyLow: boot ? boot[0] : null,
    expectancyHigh: boot ? boot[1] : null,
    medianBars: median(scored.map((t) => t.heldBars)),
    enough,
    adverse,
    note: describe({ n, wins, hitRate, hitLow, expectancy, enough, adverse, unknowable, rMultiple }),
  };
}

/* -------------------------------------------------------------------------- */
/* the sentence                                                               */
/* -------------------------------------------------------------------------- */

interface DescribeInput {
  n: number;
  wins: number;
  hitRate: number;
  hitLow: number;
  expectancy: number;
  enough: boolean;
  adverse: boolean;
  unknowable: number;
  rMultiple: number;
}

/**
 * The line the card shows.
 *
 * Quotes the count before the rate, always. "62%" invites a decision; "62% of
 * 8" invites the right one.
 */
function describe(d: DescribeInput): string {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const r = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
  const dropped = d.unknowable > 0 ? ` ${d.unknowable} more resolved inside one bar and were dropped.` : "";

  if (!d.enough) {
    return `Only ${d.n} completed ${d.n === 1 ? "instance" : "instances"} in this history — ${d.wins} reached target. Too few to characterise.${dropped}`;
  }
  if (d.adverse) {
    return `Went the wrong way historically: ${d.wins} of ${d.n} reached target, ${r(d.expectancy)} per attempt at ${d.rMultiple}R.${dropped}`;
  }
  return `${d.wins} of ${d.n} reached target — ${pct(d.hitRate)}, at least ${pct(d.hitLow)} with 95% confidence, ${r(d.expectancy)} per attempt at ${d.rMultiple}R.${dropped}`;
}

/**
 * The break-even hit rate at a given reward-to-risk.
 *
 * Reported next to the measured rate because a 40% hit rate is excellent at 3R
 * and ruinous at 1R, and a card that shows one without the other is showing
 * half a fact.
 */
export function breakEven(rMultiple: number): number {
  return rMultiple > 0 ? 1 / (1 + rMultiple) : 1;
}
