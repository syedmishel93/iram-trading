/**
 * What the run did to an actual account, in money — including killing it.
 *
 * WHY THIS IS NOT `metrics.ts`
 *
 * `computeMetrics` answers "was this rule any good", in units that compare
 * across symbols: R multiples, profit factor, expectancy. Those are the right
 * units for judging a rule and the wrong ones for answering "what happens to my
 * $500", which is the question the owner actually asked. A 0.3R expectancy over
 * 1,800 trades is an excellent rule and can still be an account that went to
 * zero in March and spent the rest of the backtest trading money it did not
 * have.
 *
 * THE ONE THING EVERY BACKTEST GETS WRONG ABOUT SMALL ACCOUNTS
 *
 * The engine's equity curve is a MULTIPLIER, and multipliers never reach zero:
 * risking 1% of a shrinking balance means the 200th consecutive loss still
 * leaves something. Real accounts do not work that way — a broker closes you
 * out, and below a minimum position size you cannot open the next trade at all.
 * So this reports RUIN as a date and stops counting there. A curve that carries
 * on past the point the account died is the most flattering error in the
 * business, because every recovery after it is imaginary.
 *
 * AND DOWNSAMPLING A CURVE MUST KEEP ITS EXTREMES
 *
 * A chart wants a few hundred points from forty thousand bars. Taking every
 * hundredth bar loses the peak and the trough — and the distance between those
 * two IS the drawdown, the number that decides whether anyone could have sat
 * through this. `curvePoints` keeps the highest and lowest point of every
 * bucket, so the drawn line cannot understate what the run did.
 */

import type { Trade } from "./engine";

export interface AccountOptions {
  /** Money the account starts with. */
  readonly balance: number;
  /** Percent of the CURRENT balance risked per trade. */
  readonly riskPct: number;
  /**
   * Below this the account is dead: a broker closes you out and no position
   * can be opened. A fraction of the starting balance rather than an absolute,
   * because it has to mean the same thing at $500 and at $50,000.
   */
  readonly ruinFraction?: number;
  /** Most points to return for drawing. */
  readonly maxPoints?: number;
}

export interface CurvePoint {
  readonly t: number;
  readonly equity: number;
}

export interface AccountRun {
  readonly start: number;
  /** Balance at the end, or at ruin. */
  readonly end: number;
  readonly peak: number;
  readonly trough: number;
  /** Largest peak-to-trough fall, as a fraction. */
  readonly maxDrawdown: number;
  /** Trades actually taken before the account died. */
  readonly taken: number;
  /** Trades the run contained that the account never lived to take. */
  readonly unreachable: number;
  /** When the account fell below the ruin floor, or null if it survived. */
  readonly ruinedAt: number | null;
  readonly curve: readonly CurvePoint[];
  /** What the operator has to be told. Empty when nothing needs saying. */
  readonly why: string;
}

const DEFAULT_RUIN_FRACTION = 0.1;
const DEFAULT_MAX_POINTS = 400;

/**
 * Keep the shape of a curve while cutting it to `max` points.
 *
 * Each bucket contributes its first point, its highest and its lowest, in time
 * order. Every-nth sampling would be shorter and would quietly flatten the
 * drawdown, which is the one number on this chart nobody can afford to have
 * understated.
 */
export function curvePoints(points: readonly CurvePoint[], max: number): CurvePoint[] {
  if (max < 3 || points.length <= max) return [...points];
  const buckets = Math.max(1, Math.floor(max / 3));
  const size = points.length / buckets;
  const out: CurvePoint[] = [];

  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    if (to <= from) continue;
    let hi = points[from] as CurvePoint;
    let lo = hi;
    for (let i = from; i < to; i += 1) {
      const p = points[i] as CurvePoint;
      if (p.equity > hi.equity) hi = p;
      if (p.equity < lo.equity) lo = p;
    }
    const first = points[from] as CurvePoint;
    /* In time order, and without repeating a point that is already the
       bucket's first — a chart drawing the same coordinate twice is harmless
       and a reader counting points is not. */
    const picked = [first, hi, lo]
      .filter((p, i, a) => a.indexOf(p) === i)
      .sort((x, y) => x.t - y.t);
    out.push(...picked);
  }

  const last = points[points.length - 1] as CurvePoint;
  if ((out[out.length - 1] as CurvePoint).t !== last.t) out.push(last);
  return out;
}

/**
 * Replay the trades against a real balance.
 *
 * Risk is a percent of the CURRENT balance, which is what every risk rule in
 * this product means and what makes the curve compound. The alternative —
 * fixed money per trade — is a different strategy, not a different view of the
 * same one, so it is not offered as a toggle.
 */
export function simulateAccount(
  trades: readonly Trade[],
  opts: AccountOptions,
): AccountRun {
  const start = opts.balance;
  const ruinFloor = start * (opts.ruinFraction ?? DEFAULT_RUIN_FRACTION);
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;

  if (!(start > 0) || !(opts.riskPct > 0)) {
    return {
      start,
      end: start,
      peak: start,
      trough: start,
      maxDrawdown: 0,
      taken: 0,
      unreachable: trades.length,
      ruinedAt: null,
      curve: [],
      why: "a balance and a risk per trade above zero are needed before anything can be simulated",
    };
  }

  const risk = opts.riskPct / 100;
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  let equity = start;
  let peak = start;
  let trough = start;
  let maxDrawdown = 0;
  let taken = 0;
  let ruinedAt: number | null = null;
  const points: CurvePoint[] = ordered.length > 0 ? [{ t: (ordered[0] as Trade).entryTime, equity: start }] : [];

  for (const t of ordered) {
    /* THE RISK IS SIZED ON THE BALANCE BEFORE THE TRADE, which is the only
       moment it is knowable. Sizing on the balance after would use the trade's
       own result to decide how big it was. */
    equity += equity * risk * t.rMultiple;
    taken += 1;
    points.push({ t: t.exitTime, equity });

    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (equity <= ruinFloor) {
      ruinedAt = t.exitTime;
      break;
    }
  }

  const unreachable = ordered.length - taken;
  const why =
    ruinedAt === null
      ? ""
      : `the account fell below ${Math.round((opts.ruinFraction ?? DEFAULT_RUIN_FRACTION) * 100)}% of its starting ` +
        `balance and the run stops there. ${unreachable.toLocaleString()} later trades are not counted: a broker ` +
        "closes the account out, and anything after that point is a recovery that could not have happened.";

  return {
    start,
    end: equity,
    peak,
    trough,
    maxDrawdown,
    taken,
    unreachable,
    ruinedAt,
    curve: curvePoints(points, maxPoints),
    why,
  };
}
