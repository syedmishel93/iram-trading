/**
 * WHAT THE BROKER ACTUALLY CHARGES — measured, beside what the engine assumes.
 *
 * `/svc/costs` carries the contract spec the MT5 bridge pulled from the broker:
 * spread in POINTS, the point size, the contract size and the overnight swap.
 * It had no caller anywhere in the frontend.
 *
 * WHY THAT MATTERS MORE THAN AN UNUSED ROUTE USUALLY DOES
 *
 * `DEFAULT_COSTS` charges a flat 2bp spread on every instrument, and CLAUDE.md
 * states the consequence: a cost model is a HURDLE, so an assumed cost is an
 * assumed conclusion — those numbers decide which rules survive a search.
 *
 * MEASURED on this operator's live broker:
 *
 *     EURUSD    6 points x 1e-05 = 0.00006   ~0.56bp   assumed 2bp
 *     XAUUSD   18 points x 0.01  = 0.18      ~0.42bp   assumed 2bp
 *     BTCUSD  600 points x 0.01  = 6.00      ~0.71bp   assumed 2bp
 *
 * Three to five times the real spread. That is NOT harmless conservatism: it
 * raises the bar every candidate rule must clear, so rules that would have made
 * money are discarded as noise, and nothing on screen says why.
 *
 * IT DOES NOT SILENTLY REPLACE THE ASSUMPTION. A figure that changed under the
 * operator because a background service answered would be worse than a
 * disagreement they can see — the same stance the risk sizer's broker
 * cross-check takes. This reports; it does not overwrite.
 *
 * AND THE ARITHMETIC IS UNITS ALL THE WAY DOWN. A point is not a pip, a spread
 * in points is not a spread in price, and a spread in price is not a fraction
 * of price. CLAUDE.md records a defaulted unit costing a risk desk a factor of
 * 100,000, so every conversion here refuses rather than defaults.
 */

import { svcUrl } from "./backend";

/** One instrument's contract spec, as the broker states it. */
export interface BrokerSpec {
  readonly symbol: string;
  /** The spread in POINTS. Multiply by `point` to get price. */
  readonly spread_points: number;
  readonly point: number;
  readonly contract_size: number;
  readonly swap_long: number;
  readonly swap_short: number;
  readonly digits: number;
  readonly tick_value: number;
  readonly tick_size: number;
}

export interface BrokerCosts {
  readonly ok: boolean;
  readonly specs: Readonly<Record<string, BrokerSpec>>;
  readonly count: number;
  readonly note?: string;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

export async function brokerCosts(): Promise<Answer<BrokerCosts>> {
  const url = svcUrl("/svc/costs");
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { kind: "offline", why: `the broker cost service is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `the broker cost service answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as BrokerCosts };
  } catch {
    return { kind: "offline", why: `the broker cost service did not answer with a report on ${url}` };
  }
}

/**
 * The spread as a FRACTION OF PRICE, or null.
 *
 * NULL RATHER THAN A DEFAULT. A spread in points cannot become a fraction
 * without the price it is a fraction of, and inventing that price produces a
 * plausible number that is wrong — which is the failure mode this whole module
 * exists to correct.
 */
export function spreadFraction(spec: BrokerSpec, price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const pts = spec.spread_points;
  const pt = spec.point;
  if (!Number.isFinite(pts) || pts <= 0) return null;
  if (!Number.isFinite(pt) || pt <= 0) return null;
  return (pts * pt) / price;
}

export interface CostComparison {
  readonly symbol: string;
  /** Null when the price is unknown; never a guess. */
  readonly measuredBp: number | null;
  readonly assumedBp: number;
  /** assumed / measured. Above 1 means the engine overcharges. */
  readonly ratio: number | null;
  readonly verdict: "over" | "under" | "close" | "unknown";
  readonly why: string;
}

/** Within this much either way, the two figures are the same number. */
const CLOSE = 0.15;

/**
 * The engine's assumption against the broker's own spread.
 *
 * `assumedFraction` is a fraction of price, the same unit `DEFAULT_COSTS.spread`
 * is in — passing basis points here would be the unit error the header warns
 * about, so the parameter is named for its unit.
 */
export function compareCost(spec: BrokerSpec, price: number, assumedFraction: number): CostComparison {
  const f = spreadFraction(spec, price);
  if (f === null) {
    return {
      symbol: spec.symbol,
      measuredBp: null,
      assumedBp: assumedFraction * 10000,
      ratio: null,
      verdict: "unknown",
      /* Addressed to the operator: what is missing, not what threw. */
      why: "no live price for this symbol, so its spread cannot be put in the same units as the assumption",
    };
  }
  const ratio = f > 0 ? assumedFraction / f : null;
  let verdict: CostComparison["verdict"] = "close";
  if (ratio !== null && ratio > 1 + CLOSE) verdict = "over";
  else if (ratio !== null && ratio < 1 - CLOSE) verdict = "under";
  return {
    symbol: spec.symbol,
    measuredBp: f * 10000,
    assumedBp: assumedFraction * 10000,
    ratio,
    verdict,
    why:
      verdict === "over"
        ? "the backtest charges more than this broker does, so it discards rules that would have cleared the real spread"
        : verdict === "under"
          ? "the backtest charges LESS than this broker does, so its results are better than anything you could have traded"
          : "the assumption matches this broker closely enough to leave alone",
  };
}

/**
 * The overnight charge per lot, per night, as the broker states it.
 *
 * Returned raw and in the broker's own currency units, because converting it
 * would need a rate this module does not have — and a converted figure with no
 * stated rate is the kind of number nobody can check.
 */
export function swapPerNight(spec: BrokerSpec, side: "long" | "short"): number | null {
  const v = side === "long" ? spec.swap_long : spec.swap_short;
  return Number.isFinite(v) ? v : null;
}
