/**
 * Bar-by-bar backtest engine.
 *
 * A backtest is a machine for producing believable numbers. Almost all of the
 * ways it lies are subtle, and every one of them makes results BETTER. So the
 * engine's job is less "simulate trading" than "refuse the four standard lies":
 *
 * 1. **You cannot trade the close you are evaluating.** A rule that looks at
 *    bar `i`'s close acts at bar `i+1`'s OPEN. Filling at `close[i]` is the
 *    single most common backtest lie and it is worth several percent a year of
 *    imaginary edge.
 *
 * 2. **When a bar contains both your stop and your target, assume the STOP.**
 *    A daily bar that traded through both tells you nothing about the order.
 *    Assuming the target turns losing systems into winning ones on paper.
 *
 * 3. **Costs are not a detail.** Spread and commission are charged on both
 *    sides. A strategy that trades often and wins by less than its costs is a
 *    losing strategy that a cost-free backtest reports as excellent.
 *
 * 4. **A series with holes is not a series.** The engine refuses to run on data
 *    whose coverage the archive could not vouch for, rather than quietly
 *    treating a three-week gap as a single enormous bar.
 *
 * Every trade also carries the plain-language reason it was taken, so a result
 * can be interrogated rather than believed.
 */

import type { BarView } from "../chart/series";
import { settleBar } from "./intrabar";
import { atr } from "../chart/indicators";

export type Direction = "long" | "short";

export interface StrategyContext {
  bars: readonly BarView[];
  /** Columnar views, precomputed once per run for the strategy's convenience. */
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  time: Float64Array;
  /**
   * Context series already aligned onto THESE bars, keyed by column id.
   *
   * Aligned by `backtest/macro.ts`, never here: the join is where look-ahead
   * enters (a daily bar is stamped at the START of its day, so reading its
   * close during that day is a number that does not exist yet) and it is worth
   * one owner with its own tests. Absent means the caller had no context, and
   * a rule that references one then reads NaN and cannot fire — which is the
   * honest outcome, not a silent zero.
   */
  macro?: Readonly<Record<string, Float64Array>>;
}

export interface EntrySignal {
  direction: Direction;
  /** Absolute stop price. Required: a strategy without a stop is not testable. */
  stop: number;
  /** Optional target. Without one, the strategy must define an exit rule. */
  target?: number;
  /** Plain language, carried onto the trade. */
  reason: string;
}

export interface OpenPosition {
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  stop: number;
  target: number | null;
  reason: string;
}

export interface Strategy {
  id: string;
  label: string;
  /** Bars needed before the first decision, so warm-up is never traded. */
  warmup: number;
  /**
   * Decide at bar `i` using ONLY bars 0..i. The engine enforces this by never
   * passing a context that extends beyond `i`, but a strategy that indexes
   * ahead is still its own bug.
   */
  entry(ctx: StrategyContext, i: number): EntrySignal | null;
  /** Optional discretionary exit, evaluated on each bar's close. */
  exit?(ctx: StrategyContext, position: OpenPosition, i: number): string | null;
}

export interface Costs {
  /** Round-trip spread as a fraction of price (0.0002 = 2bp). */
  spread: number;
  /** Commission per side, as a fraction of notional. */
  commission: number;
  /** Extra adverse fill as a fraction of price, applied on entry and exit. */
  slippage: number;
  /**
   * Overnight financing per night held, as a fraction of notional.
   *
   * REQUIRED, AND THAT IS THE FIX. This engine charged no financing at all for
   * its whole life while `backtest/friction.ts` carried a `carryPerNight` for
   * every venue and had no importer anywhere. Measured against this engine's own
   * round trip of 0.1200% ex-carry, the cost it was charging as zero came to 29%
   * of a five-night swing, 54% of a two-week hold and 83% of a two-month
   * position — so every swing and position result the search ever ranked was
   * flattered, silently, in the direction that promotes strategies.
   *
   * An OPTIONAL field defaulting to zero would have reproduced exactly that
   * invisibility at every call site that forgot it. Required means `tsc`
   * enumerates the sites and each one has to state an answer — the same shape as
   * `startBackup`'s transport losing its live default, for the same reason.
   *
   * SPOT IS LEGITIMATELY ZERO: you own the asset and there is no financing to
   * pay. Zero here is a stated answer, not an omission.
   *
   * IT IS A RATE, NOT A TOTAL. The engine multiplies it by the nights each trade
   * actually held (`nightsBetween`), because a caller's "typical hold" is a guess
   * and the engine has the real one.
   */
  carryPerNight: number;

  /**
   * Slippage as a multiple of ATR, when the flat figure is not enough.
   *
   * OPTIONAL, AND ABSENT IS A REAL ANSWER — unlike the carry above. An absent
   * carry meant a genuine cost charged as zero; an absent multiple here means the
   * flat `slippage` still applies, which is this engine s stated assumption and
   * not a hole. Turning it on is a decision, and leaving it off changes nothing.
   *
   * WHY IT EXISTS. `slippage` is a flat fraction of price: one basis point on a
   * market moving 0.3% a day and the same on one moving 6%. Slippage is the gap
   * between the price asked for and the price got, and that gap widens with
   * volatility. It is also the one cost term that is not a published rate and
   * cannot be looked up, which is why the flat figure survived.
   *
   * THE CHARGE IS THE GREATER OF THE TWO, never the scaled one alone: a multiple
   * that came out below the flat figure would quietly reduce a cost already being
   * charged, and a change that makes every historical result look better is the
   * direction to distrust.
   */
  slippageAtrMult?: number;
}

export const DEFAULT_COSTS: Costs = {
  spread: 0.0002,
  commission: 0.0004,
  slippage: 0.0001,
  /* The MT5 rate from `friction.ts` VENUES, which is a published schedule and
     not a measured one. It is charged per night HELD, so an intraday rule pays
     it zero times and is unaffected by this default. */
  carryPerNight: 0.0001,
};
/** Costs off — for isolating whether an edge exists at all before frictions. */
export const ZERO_COSTS: Costs = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };

/**
 * Nights a position was held: UTC midnights crossed in `(entry, exit]`.
 *
 * NOT ELAPSED TIME. 22:00 to 02:00 is four hours and one night's financing;
 * 10:00 to 15:00 is five hours and none. A charge driven by duration would have
 * both the wrong way round.
 *
 * WEEKENDS COUNT, and that is deliberate rather than an oversight: FX pays a
 * triple swap on Wednesday to cover the weekend's value dates, so a plain
 * calendar count over a week comes to seven and agrees with the weekly total.
 * Skipping Saturday and Sunday would undercharge every position held across one.
 */
export function nightsBetween(entryTime: number, exitTime: number): number {
  if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime)) return 0;
  const DAY = 86_400_000;
  return Math.max(0, Math.floor(exitTime / DAY) - Math.floor(entryTime / DAY));
}

/**
 * The slippage to charge at a fill, given the market s volatility there.
 *
 * ONE OWNER, because `autoplan.ts` prices the live proposal with the same
 * `modelledFill` the backtest uses and has to scale it the same way. Two
 * implementations of "how much worse than the quoted price" is precisely how the
 * card and the backtest behind it drift apart without either looking wrong.
 *
 * `atrPct` is ATR as a fraction of price. A non-finite or zero value means the
 * volatility could not be measured — an indicator s own warm-up says NaN — and
 * the flat figure stands rather than multiplying by nothing.
 */
export function effectiveSlippage(costs: Costs, atrPct: number): number {
  const mult = costs.slippageAtrMult;
  if (mult === undefined || !Number.isFinite(atrPct) || atrPct <= 0) return costs.slippage;
  return Math.max(costs.slippage, mult * atrPct);
}

/**
 * THE FILL MODEL — the price this engine assumes you actually got.
 *
 * Half the spread plus slippage, against you: entering long and exiting short
 * both pay UP, the reverse pay down. Commission is charged separately, per
 * side, in `closePosition`.
 *
 * EXPORTED because it stopped being the backtest's private business in v60.2.
 * The inspector's Autonomous card proposes a live trade from a rule this engine
 * scored, and it was printing the signal bar's CLOSE as the entry — a price the
 * backtest never paid — directly above that backtest's out-of-sample
 * expectancy. Two implementations of "what you get filled at" is how the figure
 * on the card and the figure the edge was measured with drift apart silently,
 * so there is one, and both callers use it.
 */
export function modelledFill(
  price: number,
  direction: Direction,
  costs: Costs,
  entering: boolean,
): number {
  const half = costs.spread / 2 + costs.slippage;
  const payUp = entering ? direction === "long" : direction === "short";
  return price * (payUp ? 1 + half : 1 - half);
}

/**
 * Whether a signal could have been filled at all.
 *
 * `runBacktest` drops a signal whose stop lands on the wrong side of the filled
 * entry rather than booking a trade that could never have existed (see the
 * entry step of the loop). Anything proposing a LIVE trade from the same signal
 * has to make the same check, or it offers a plan the engine would have refused
 * to test.
 */
export function fillable(entryPrice: number, stop: number, direction: Direction): boolean {
  return direction === "long" ? stop < entryPrice : stop > entryPrice;
}

export interface Trade {
  direction: Direction;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "stop" | "target" | "rule" | "end-of-data";
  /**
   * How the exit bar was resolved. THREE states, not two.
   *
   * `unambiguous` is the common case and is neither of the other two: the bar
   * touched at most one of the levels, so there was never an order to settle.
   * Folding it into `measured` would make the resolved share RISE as the
   * ambiguity fell, so a run with nothing to resolve would report itself
   * perfectly resolved — the shape of the strip that painted "0 of 0 running"
   * green. Folding it into `assumed` would understate how much a run really knew.
   */
  exitBasis: "measured" | "assumed" | "unambiguous";
  /** Return in units of initial risk. The only comparable measure across symbols. */
  rMultiple: number;
  /** Net return on notional, after costs. */
  returnPct: number;
  reason: string;
  /**
   * Maximum adverse / favourable excursion while the trade was open, in R
   * (multiples of the entry-to-stop distance). Both >= 0, gross of costs:
   * they describe where PRICE went, not what the account booked.
   *
   * THE EXIT BAR IS THE AMBIGUOUS ONE, and it is resolved the same way the
   * engine resolves fills — pessimistically. A bar that stopped the trade out
   * contributes its adverse side only up to the stop (anything beyond happened
   * after the exit) and its favourable side NOT AT ALL, because the engine
   * already assumed the stop came first and a high from after the exit would
   * invent profit the trade never had. A target exit caps the favourable side
   * at the target and keeps the bar's adverse side, which can only overstate
   * the heat, never hide it.
   */
  maeR: number;
  mfeR: number;
  /**
   * Nights this position was held, and what financing they cost.
   *
   * Both reported rather than folded silently into `returnPct`, because a house
   * rule here is that any computed figure exposes its working. A trade whose
   * carry is a third of its gross is a different claim from one whose carry is
   * nothing, and the two are identical in every other field.
   */
  nightsHeld: number;
  /** Financing charged, as a fraction of notional. Already inside `returnPct`. */
  carryPct: number;
  /** Slippage charged across BOTH fills, as a fraction of notional. */
  slippagePct: number;
  /**
   * The move BEFORE any cost, as a fraction of notional — signed.
   *
   * Kept so the cost breakdown can be audited against the trades rather than
   * re-derived from the cost model that produced it. An expected value taken
   * from the code under test cannot fail, and the same is true of a share whose
   * numerator and denominator both come from one assumption.
   */
  grossPct: number;
}

/**
 * WHAT THE RUN PAID, AND WHAT SHARE OF THE MOVE THAT WAS.
 *
 * "0.26%" is unreadable. "A third of what the trades were trying to win" is a
 * sentence that changes a decision, and `friction.ts` already said so in its own
 * header while having no importer to say it to.
 *
 * Every figure here is summed from the trades the run actually booked, never
 * from a mode's `typicalTargetPct` — that is a guess about a hypothetical trade,
 * and this is the arithmetic of the real ones.
 */
export interface RunFriction {
  /** Spread and slippage across both fills, as a fraction of notional. */
  readonly spreadPct: number;
  /**
   * Slippage ACTUALLY charged across every fill, summed from the trades.
   *
   * Separate from `spreadPct` because with a volatility multiple in play the rate
   * in the cost model is no longer what was paid, and a hurdle nobody can check
   * against the run that produced it is a hurdle nobody can argue with.
   */
  readonly slippagePaid: number;
  readonly commissionPct: number;
  /** Financing, summed over the nights every trade actually held. */
  readonly carryPct: number;
  readonly totalPct: number;
  /** Total over the number of trades. Zero trades reports zero, not NaN. */
  readonly perTradePct: number;
  /**
   * Friction over the gross movement the trades captured, 0..1 and up.
   *
   * NaN when the trades moved nothing measurable — a share of zero is not zero,
   * and every formatter here renders NaN as an em dash rather than as "free".
   */
  readonly share: number;
  /** Nights held across the whole run. Carry is the cost nobody was charging. */
  readonly nights: number;
  /** The operator's sentence, with the number in it. */
  readonly why: string;
}

export interface BacktestOptions {
  costs?: Costs;
  /** Fraction of equity risked per trade. */
  riskPerTrade?: number;
  /**
   * Refuse to run when the caller cannot vouch for the data. Pass the archive's
   * coverage ratio; below `minCoverage` the run is refused outright.
   */
  coverage?: number;
  minCoverage?: number;
  /** Refuse to run on generated data unless explicitly allowed. */
  containsDemo?: boolean;
  allowDemo?: boolean;
  /**
   * Context series ALREADY ALIGNED onto these bars, keyed by column id.
   *
   * Built by `backtest/macro.ts buildMacroColumns`, which is where the
   * look-ahead lives or does not: a daily bar is stamped at the START of its
   * day, so reading its close during that day is a price that does not exist
   * yet. Absent means a rule referencing a context column reads NaN and cannot
   * fire — deliberately, because firing on a zero would be worse.
   */
  macro?: Readonly<Record<string, Float64Array>>;

  /**
   * Minute bars covering these bars, for settling which of the stop and the
   * target was hit first.
   *
   * WHAT THIS CHANGES AND WHAT IT DOES NOT. Without it the engine resolves a bar
   * holding both levels the way it always has — pessimistically, as a stop. That
   * default is correct and is an ASSUMPTION, so it understates edge rather than
   * inventing it. With minutes the order stops being a guess on the bars the
   * minutes actually cover, and `intrabar.ts` refuses everything it cannot
   * settle: a hole inside the parent bar, minutes that start late or end early,
   * or one minute holding both levels. Every refusal keeps the pessimistic
   * answer.
   *
   * MEASURED, SO THE SCOPE IS HONEST. Bars holding both a stop and a target came
   * to 0.0% of exits at a 2.0 ATR stop and 2.0 R target on BTCUSDT 1h and SPX
   * 1d, 0.8% and 0.2% at 1.0 ATR / 1.5 R, and 7.7% and 5.7% at 0.5 ATR / 1.0 R.
   * This matters for tight-stop styles and is close to free elsewhere.
   *
   * They must be ASCENDING by `t`. `barIntervalMs` is required alongside them.
   */
  minutes?: readonly BarView[];
  /**
   * The width of one of `bars`, in ms. REQUIRED whenever `minutes` is given.
   *
   * A span needs an interval, and deriving one from the bars' own spacing would
   * be a unit nobody stated on the exact code path that turns losers into
   * winners — the shape of the defaults this project records as wrong answers
   * with no symptom. Absent, the run is refused by name.
   */
  barIntervalMs?: number;
}

export interface BacktestResult {
  strategy: string;
  trades: Trade[];
  /** Equity curve in multiples of starting capital, one point per bar. */
  equity: Float64Array;
  /** Non-fatal problems the caller should see. */
  warnings: string[];
  /** Set when the run was refused; `trades` is then empty. */
  refused: string | null;
  bars: number;
  /** What the run paid in frictions, measured from its own trades. */
  friction: RunFriction;
  /** How many exits were genuinely in doubt, and how many of those were settled. */
  settle: RunSettle;
}

/**
 * HOW MUCH OF THIS RUN WAS MEASURED RATHER THAN ASSUMED.
 *
 * Reported rather than inferred, because "84% of the doubtful exits were settled"
 * and "every doubtful exit was guessed" are different claims about one equity
 * curve, and a result that does not say which cannot be argued with.
 *
 * THE DENOMINATOR IS THE AMBIGUOUS BARS, NOT ALL OF THEM. A bar that touched one
 * level was never in doubt and is not evidence that anything was resolved.
 */
export interface RunSettle {
  /** Exits where the bar held BOTH the stop and the target. */
  readonly ambiguous: number;
  /** Of those, how many the minutes settled. */
  readonly measured: number;
  /** Of those, how many kept the pessimistic assumption. */
  readonly assumed: number;
  /** `measured / ambiguous`. NaN when nothing was in doubt — not 1, and not 0. */
  readonly share: number;
  /** The first reason a settle was refused, for the operator. Empty when none. */
  readonly why: string;
}

/** Nothing was in doubt, so the share is unknown rather than perfect. */
const NO_SETTLE: RunSettle = { ambiguous: 0, measured: 0, assumed: 0, share: NaN, why: "" };

/** A run with no trades paid nothing — and `share` is unknown, not zero. */
const NO_FRICTION: RunFriction = {
  spreadPct: 0,
  slippagePaid: 0,
  commissionPct: 0,
  carryPct: 0,
  totalPct: 0,
  perTradePct: 0,
  share: NaN,
  nights: 0,
  why: "No trades, so nothing was charged.",
};

/**
 * Sum what the run paid, from the trades it booked.
 *
 * The spread and slippage are not recoverable from a trade's own numbers — they
 * are inside the fill prices — so they come from the cost model, per round trip,
 * and the carry comes from the trades, which is where the nights are.
 */
function summariseFriction(trades: readonly Trade[], costs: Costs): RunFriction {
  if (trades.length === 0) return NO_FRICTION;
  const commissionPct = costs.commission * 2 * trades.length;
  let carryPct = 0;
  let nights = 0;
  let gross = 0;
  let slippagePaid = 0;
  for (const t of trades) {
    carryPct += t.carryPct;
    nights += t.nightsHeld;
    gross += Math.abs(t.grossPct);
    slippagePaid += t.slippagePct;
  }
  /* SUMMED FROM THE TRADES, NOT FROM THE RATE. With a volatility multiple the
     rate in the cost model is not what any particular fill paid. */
  const spreadPct = costs.spread * trades.length + slippagePaid;
  const totalPct = spreadPct + commissionPct + carryPct;
  const share = gross > 0 ? totalPct / gross : NaN;
  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
  /* THREE STATES, NOT TWO. Read off a real run: a 350-night swing charged at a
     zero rate printed "No position was held overnight" — every number on the line
     was right and the sentence was about a different run. "Held nothing overnight"
     and "held 350 nights on a venue that charges nothing for them" are different
     facts, and only the second one means the cost model is saying something. */
  const nightWords = `${nights.toLocaleString()} night${nights === 1 ? "" : "s"}`;
  const carryWords =
    nights === 0
      ? " No position was held overnight, so nothing was financed"
      : carryPct > 0
        ? ` Financing over ${nightWords} was ${pct(carryPct)} of that`
        : ` ${nightWords} were held and this venue was charged nothing for them, so no financing is in that figure`;
  return {
    spreadPct,
    slippagePaid,
    commissionPct,
    carryPct,
    totalPct,
    perTradePct: totalPct / trades.length,
    share,
    nights,
    why:
      `Costs came to ${pct(totalPct)} across ${trades.length.toLocaleString()} trades, ` +
      `which is ${Number.isFinite(share) ? `${(share * 100).toFixed(0)}% of what those trades moved` : "an unknown share of what those trades moved"}.` +
      `${carryWords}.`,
  };
}

const EMPTY = (strategy: string, refused: string, bars: number): BacktestResult => ({
  strategy,
  trades: [],
  equity: new Float64Array(0),
  warnings: [],
  refused,
  bars,
  friction: NO_FRICTION,
  settle: NO_SETTLE,
});

export function makeContext(
  bars: readonly BarView[],
  /**
   * Context series already aligned onto THESE bars — see `backtest/macro.ts`.
   *
   * Optional, and absent means a rule referencing a context column reads NaN
   * and cannot fire. That is deliberate: a conditioned rule run without the
   * series it conditions on should produce NOTHING, never fire on a zero.
   */
  macro?: Readonly<Record<string, Float64Array>>,
): StrategyContext {
  const n = bars.length;
  const ctx: StrategyContext = {
    bars,
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    time: new Float64Array(n),
    ...(macro ? { macro } : {}),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i] as BarView;
    ctx.open[i] = b.o;
    ctx.high[i] = b.h;
    ctx.low[i] = b.l;
    ctx.close[i] = b.c;
    ctx.volume[i] = b.v;
    ctx.time[i] = b.t;
  }
  return ctx;
}

/**
 * Run one strategy over one series.
 *
 * `shared` is an optimisation with a sharp edge, so it is a positional argument
 * rather than a field on `opts`. `rules.ts` caches computed indicator columns in
 * a `WeakMap` keyed on the CONTEXT object, so twenty-six specs over the same
 * bars share one EMA-50 if and only if they are handed the same context. Left to
 * itself this function builds a fresh one per call, and a cross-market survey
 * pays for the same indicators once per rule per instrument.
 *
 * WHY NOT `opts.ctx`.
 * `walkForward` runs each candidate over `bars.slice(from, to)` and forwards
 * `{...opts}` to every one of those runs. A context on `opts` would therefore be
 * carried into a sliced run, where columns computed over the WHOLE series get
 * indexed by slice position — indicators built partly from the future, silently,
 * on the exact code path whose job is to detect look-ahead. That is not a bug
 * anyone would find from the results; it would simply make every walk-forward
 * look better. Keeping it off `opts` makes it unspreadable.
 *
 * The reference check below is the second lock: a context must have been built
 * from THIS array, not merely one of the same length.
 */
export function runBacktest(
  strategy: Strategy,
  bars: readonly BarView[],
  opts: BacktestOptions = {},
  shared?: StrategyContext,
): BacktestResult {
  const costs = opts.costs ?? DEFAULT_COSTS;
  const risk = opts.riskPerTrade ?? 0.01;
  const minCoverage = opts.minCoverage ?? 0.98;
  const n = bars.length;

  if (opts.containsDemo === true && opts.allowDemo !== true) {
    return EMPTY(strategy.id, "series contains generated data; refusing to report it as a result", n);
  }
  if (opts.coverage !== undefined && opts.coverage < minCoverage) {
    return EMPTY(
      strategy.id,
      `series coverage ${(opts.coverage * 100).toFixed(1)}% is below the ${(minCoverage * 100).toFixed(0)}% floor — ` +
        `a gap would be silently treated as one enormous bar`,
      n,
    );
  }
  if (n < strategy.warmup + 10) {
    return EMPTY(strategy.id, `only ${n} bars; ${strategy.warmup + 10} needed`, n);
  }

  /* A COST TERM THAT IS NOT A NUMBER POISONS EVERY FIGURE THIS RUN PRODUCES.
     `net` feeds the R multiple, the equity curve and every metric downstream, so
     one NaN term makes the whole result NaN — and NaN compares false against
     every threshold, so a promotion gate reads it as "did not clear" and a
     ranking reads it as a tie. That is a run which looks measured and says
     nothing, which is worse here than a refusal. Found by a stress test whose
     fixture predated the carry term: `undefined * 2` is NaN, and two different
     cost models then produced byte-identical results because both were NaN. */
  /* MINUTES WITHOUT A BAR WIDTH CANNOT BE PUT AGAINST A SPAN, and inventing the
     width would be a silent unit on the code path that decides which trades won.
     Refused by name rather than ignored: minutes supplied and quietly unused is
     indistinguishable from minutes that settled nothing. */
  if (opts.minutes !== undefined && !(Number.isFinite(opts.barIntervalMs) && (opts.barIntervalMs as number) > 0)) {
    return EMPTY(
      strategy.id,
      "minutes were supplied with no barIntervalMs, so there is no span to settle them against — " +
        "pass the width of one bar in milliseconds",
      n,
    );
  }

  /* A NEGATIVE MULTIPLE IS A CREDIT ON EVERY FILL, which would read as an edge
     the market paid you for trading. Refused by name, like the other terms. */
  if (
    opts.costs?.slippageAtrMult !== undefined &&
    !(Number.isFinite(opts.costs.slippageAtrMult) && opts.costs.slippageAtrMult >= 0)
  ) {
    return EMPTY(
      strategy.id,
      `the cost model s slippageAtrMult is ${String(opts.costs.slippageAtrMult)} — a negative or ` +
        `unreadable multiple would credit every fill and print as an edge`,
      n,
    );
  }

  const badTerm = (["spread", "commission", "slippage", "carryPerNight"] as const).find(
    (k) => !Number.isFinite(costs[k]) || costs[k] < 0,
  );
  if (badTerm !== undefined) {
    return EMPTY(
      strategy.id,
      `the cost model's ${badTerm} is ${String(costs[badTerm])} — every figure computed from it ` +
        `would be meaningless, and a NaN result reads as "cleared nothing" rather than as an error`,
      n,
    );
  }

  /* Identity, not length. A context built from a different array of the same
     length would index cleanly and produce indicators belonging to another
     series — a run that looks entirely plausible and describes nothing. */
  /* A SHARED CONTEXT WITHOUT THE MACRO COLUMNS WOULD SILENTLY DISABLE EVERY
     CONDITIONED RULE. The reuse is keyed on the bars' identity, which says
     nothing about whether the cached context carries the context series this
     caller asked for — so a sweep that built one plain context first would
     hand it to every conditioned arm and each would read NaN and never fire,
     with no error anywhere. Reuse only when the macro presence matches too. */
  const reusable =
    shared !== undefined &&
    shared.bars === bars &&
    (opts.macro === undefined || shared.macro === opts.macro);
  const ctx = reusable ? (shared as StrategyContext) : makeContext(bars, opts.macro);
  const trades: Trade[] = [];
  const equity = new Float64Array(n).fill(1);
  const warnings: string[] = [];

  let capital = 1;
  let position: OpenPosition | null = null;
  /** Price extremes reached while the current position has been open. */
  let runHigh = 0;
  let runLow = 0;

  /* THE INTRABAR ACCOUNTING. `exitBasis` is reset per bar and read by
     `closePosition`, which is the only place that books a trade. */
  let exitBasis: Trade["exitBasis"] = "unambiguous";
  let ambiguous = 0;
  let measured = 0;
  let assumedSettles = 0;
  let settleWhy = "";

  /* A FORWARD CURSOR, NOT A FILTER PER CALL. `settleBar` filters whatever array
     it is handed, so passing the whole minute series on every ambiguous bar
     would be quadratic — five years of 1m bars is 2.6 million of them. The
     engine walks bars forward exactly once, so one monotonic index does it in
     linear time, and `settleBar` still does its own span check on the slice. */
  /* ATR FOR THE SLIPPAGE SCALING, computed once over the whole series and read
     only at CLOSED bars — see `slipAt`. Skipped entirely when no multiple is set,
     so the default path costs nothing it did not cost before. */
  const atrCol =
    costs.slippageAtrMult === undefined
      ? null
      : atr(ctx.high, ctx.low, ctx.close, 14, n);

  /**
   * The slippage to charge for a fill happening at bar `i`.
   *
   * READS BAR `i - 1`, AND THAT IS THE WHOLE POINT. A fill happens at bar `i`s
   * OPEN, so bar `i`s own range has not finished — pricing the fill from it is
   * look-ahead, and it runs in the flattering direction, because the bar that
   * gapped against you is exactly the one whose ATR would have warned you.
   */
  const slipAt = (i: number): number => {
    if (atrCol === null || i < 1) return costs.slippage;
    const a = atrCol[i - 1] as number;
    const px = ctx.close[i - 1] as number;
    return effectiveSlippage(costs, px > 0 ? a / px : NaN);
  };

  const minutes = opts.minutes;
  const interval = opts.barIntervalMs ?? 0;
  let minCursor = 0;
  const settleMinutes = (
    i: number,
    stop: number,
    target: number,
    direction: Direction,
  ): { hit: "stop" | "target" | "neither"; basis: "measured" | "assumed"; why: string } => {
    if (minutes === undefined) {
      return { hit: "stop", basis: "assumed", why: "no minute bars were supplied for this run" };
    }
    const from = ctx.time[i] as number;
    const to = from + interval;
    while (minCursor < minutes.length && (minutes[minCursor] as BarView).t < from) minCursor += 1;
    let hi = minCursor;
    while (hi < minutes.length && (minutes[hi] as BarView).t < to) hi += 1;
    const r = settleBar(minutes.slice(minCursor, hi), { from, to }, { stop, target, direction });
    return { hit: r.hit, basis: r.basis, why: r.why };
  };

  /** Slippage charged on the two fills of the position currently open. */
  let slippagePct = 0;

  /**
   * Adverse price adjustment applied to every fill — see `modelledFill`.
   *
   * Takes the bar so the slippage can follow that bar s volatility. The charge is
   * accumulated rather than recomputed at close, because the entry and the exit
   * happen in different volatility regimes and averaging them would describe
   * neither.
   */
  const fill = (price: number, direction: Direction, entering: boolean, i: number): number => {
    const slip = slipAt(i);
    slippagePct += slip;
    return modelledFill(price, direction, { ...costs, slippage: slip }, entering);
  };

  const closePosition = (
    pos: OpenPosition,
    exitIndex: number,
    rawExit: number,
    reason: Trade["exitReason"],
  ): void => {
    const exitPrice = fill(rawExit, pos.direction, false, exitIndex);
    const gross =
      pos.direction === "long"
        ? (exitPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - exitPrice) / pos.entryPrice;
    /* FINANCING FOR THE NIGHTS ACTUALLY HELD. Charged here, inside `net`, so it
       reaches the account and the R multiple rather than being reported beside
       an untouched number — which is the state `friction.ts` was already in. */
    const nightsHeld = nightsBetween(ctx.time[pos.entryIndex] as number, ctx.time[exitIndex] as number);
    const carryPct = Math.max(0, costs.carryPerNight) * nightsHeld;
    const net = gross - costs.commission * 2 - carryPct;

    const riskPerUnit = Math.abs(pos.entryPrice - pos.stop) / pos.entryPrice;
    // A zero-width stop would divide by zero and report an infinite R. It is a
    // strategy bug, and reporting it as a spectacular trade would hide that.
    const rMultiple = riskPerUnit > 0 ? net / riskPerUnit : 0;

    const riskPrice = Math.abs(pos.entryPrice - pos.stop);
    const long = pos.direction === "long";
    const adverse = long ? pos.entryPrice - runLow : runHigh - pos.entryPrice;
    const favourable = long ? runHigh - pos.entryPrice : pos.entryPrice - runLow;
    const inR = (v: number): number => (riskPrice > 0 ? Math.max(0, v) / riskPrice : 0);

    capital *= 1 + net * (riskPerUnit > 0 ? risk / riskPerUnit : 0);

    trades.push({
      direction: pos.direction,
      entryIndex: pos.entryIndex,
      entryTime: ctx.time[pos.entryIndex] as number,
      entryPrice: pos.entryPrice,
      exitIndex,
      exitTime: ctx.time[exitIndex] as number,
      exitPrice,
      exitReason: reason,
      rMultiple,
      returnPct: net,
      reason: pos.reason,
      maeR: inR(adverse),
      mfeR: inR(favourable),
      nightsHeld,
      carryPct,
      grossPct: gross,
      exitBasis,
      slippagePct,
    });
  };

  let pending: EntrySignal | null = null;

  for (let i = strategy.warmup; i < n; i++) {
    // --- 1. fill anything decided on the previous bar, at THIS bar's open ---
    if (pending && !position) {
      const raw = ctx.open[i] as number;
      const entryPrice = fill(raw, pending.direction, true, i);
      // A stop on the wrong side of the fill is unfillable; skip rather than
      // book a trade that could never have existed.
      const valid = fillable(entryPrice, pending.stop, pending.direction);
      if (valid) {
        /* Per TRADE. A fill that was rejected as unfillable still charged into
           the accumulator above, and carrying that into the next trade would
           quietly overstate a cost on a trade that never paid it. */
        slippagePct = slipAt(i);
        runHigh = entryPrice;
        runLow = entryPrice;
        position = {
          direction: pending.direction,
          entryIndex: i,
          entryPrice,
          stop: pending.stop,
          target: pending.target ?? null,
          reason: pending.reason,
        };
      }
      pending = null;
    }

    // --- 2. manage an open position against THIS bar's range ---------------
    if (position) {
      /* Per bar, because it describes THIS exit. Left standing it would label an
         unambiguous exit with the basis of an earlier bar that was in doubt. */
      exitBasis = "unambiguous";
      const hi = ctx.high[i] as number;
      const lo = ctx.low[i] as number;
      const hitStop = position.direction === "long" ? lo <= position.stop : hi >= position.stop;
      const hitTarget =
        position.target !== null &&
        (position.direction === "long" ? hi >= position.target : lo <= position.target);

      /* WHICH CAME FIRST. Only a bar holding BOTH levels is in doubt, so the
         minutes are consulted only there — which is also what keeps this cheap:
         a bar that touched one level needs no resolving, and 99%+ of them touch
         at most one. `settleBar` refuses anything it cannot settle honestly and
         the pessimistic assumption stands, so this can only ever narrow a guess,
         never widen one. */
      let takeStopFirst = hitStop;
      if (hitStop && hitTarget && position.target !== null) {
        ambiguous += 1;
        const r = settleMinutes(i, position.stop, position.target, position.direction);
        exitBasis = r.basis;
        if (r.basis === "measured") measured += 1;
        else {
          assumedSettles += 1;
          if (settleWhy === "") settleWhy = r.why;
        }
        takeStopFirst = r.hit !== "target";
      }

      if (takeStopFirst && hitStop) {
        // PESSIMISTIC BY DEFAULT: a bar containing both tells us nothing about
        // the order unless the minutes above settled it, and assuming the target
        // turns losing systems into winners on paper.
        // Excursion: adverse up to the stop, no favourable side (see `maeR`).
        if (position.direction === "long") runLow = Math.min(runLow, position.stop);
        else runHigh = Math.max(runHigh, position.stop);
        closePosition(position, i, position.stop, "stop");
        position = null;
      } else if (hitTarget && position.target !== null) {
        if (position.direction === "long") {
          runHigh = Math.max(runHigh, position.target);
          runLow = Math.min(runLow, lo);
        } else {
          runLow = Math.min(runLow, position.target);
          runHigh = Math.max(runHigh, hi);
        }
        closePosition(position, i, position.target, "target");
        position = null;
      } else if (strategy.exit) {
        runHigh = Math.max(runHigh, hi);
        runLow = Math.min(runLow, lo);
        const why = strategy.exit(ctx, position, i);
        if (why) {
          closePosition(position, i, ctx.close[i] as number, "rule");
          position = null;
        }
      } else {
        runHigh = Math.max(runHigh, hi);
        runLow = Math.min(runLow, lo);
      }
    }

    // --- 3. decide, to be acted on NEXT bar --------------------------------
    if (!position && !pending) {
      const signal = strategy.entry(ctx, i);
      if (signal && Number.isFinite(signal.stop)) pending = signal;
    }

    equity[i] = capital;
  }

  // Carry the starting value across the warm-up so the curve is continuous.
  for (let i = 0; i < strategy.warmup && i < n; i++) equity[i] = 1;

  if (position) {
    closePosition(position, n - 1, ctx.close[n - 1] as number, "end-of-data");
    equity[n - 1] = capital;
    warnings.push("a position was open at the end of the data and was closed at the last price");
  }

  if (trades.length < 30) {
    // Not a failure, but the single most important caveat on any result.
    warnings.push(
      `only ${trades.length} trade${trades.length === 1 ? "" : "s"} — too few for the statistics to mean much; treat every metric as noise`,
    );
  }

  return {
    strategy: strategy.id,
    trades,
    equity,
    warnings,
    refused: null,
    bars: n,
    friction: summariseFriction(trades, costs),
    settle: {
      ambiguous,
      measured,
      assumed: assumedSettles,
      /* NaN WHEN NOTHING WAS IN DOUBT. Reporting 1 would say every doubtful exit
         was settled on a run that had none, and reporting 0 would say they were
         all guessed. Every formatter here renders NaN as an em dash. */
      share: ambiguous > 0 ? measured / ambiguous : NaN,
      why: settleWhy,
    },
  };
}
