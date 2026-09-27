/**
 * Derivatives flow — funding, open interest, positioning and taker flow.
 *
 * WHY THIS EXISTS RATHER THAN AN EMBEDDED BROWSER
 * The obvious way to get CoinGlass numbers into a terminal is to embed
 * CoinGlass. That does not work and cannot be made to work: coinglass.com
 * refuses to be framed at all, and sites that do frame (Arkham, TradingView)
 * are cross-origin, so their DOM is unreadable by script. That boundary is the
 * same-origin policy — the rule that stops any web page reading your logged-in
 * sessions elsewhere. Working around it would make the terminal less safe, not
 * more capable.
 *
 * The metrics themselves are not proprietary to CoinGlass. They are derived
 * from exchange endpoints that are public, keyless and CORS-open. Pulling them
 * directly is faster, has no Terms-of-Service exposure, no API key to leak, and
 * no dependency on a third party's uptime or rate limit.
 *
 * Everything here follows the same contract as the rest of the app: a failed
 * request throws, nothing is ever synthesised, and every derived read carries
 * the reasoning that produced it.
 */

import { fetchJson } from "./net";
const FAPI = "https://fapi.binance.com";

export interface FundingPoint {
  time: number;
  /** Per-interval rate, as a fraction (0.0001 = 0.01%). */
  rate: number;
  markPrice: number;
}

export interface OpenInterestPoint {
  time: number;
  /** Contracts. */
  amount: number;
  /** Notional in quote currency. */
  value: number;
}

export interface RatioPoint {
  time: number;
  longAccount: number;
  shortAccount: number;
  ratio: number;
}

export interface TakerFlowPoint {
  time: number;
  buyVol: number;
  sellVol: number;
  ratio: number;
}

/**
 * Positioning data, through the kernel and the cache.
 *
 * These endpoints publish on a 5-minute grid, and the flow desk polls every
 * 15 seconds. Without a TTL that is 19 wasted requests out of every 20 — real
 * weight spent to receive an identical payload. Two minutes of freshness keeps
 * the panel current and cuts the traffic by an order of magnitude.
 */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return fetchJson<unknown>(url, {
    priority: "background",
    ttlMs: 120_000,
    swr: true,
    ...(signal ? { signal } : {}),
  });
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Rows with an unparseable field are DROPPED, never coerced to zero. */
function rows(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export async function loadFunding(
  symbol: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<FundingPoint[]> {
  const url = `${FAPI}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(limit, 1000)}`;
  return rows(await getJson(url, signal))
    .map((r) => ({
      time: num(r["fundingTime"]),
      rate: num(r["fundingRate"]),
      markPrice: num(r["markPrice"]),
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.rate));
}

export async function loadOpenInterest(
  symbol: string,
  period = "1h",
  limit = 200,
  signal?: AbortSignal,
): Promise<OpenInterestPoint[]> {
  const url = `${FAPI}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${Math.min(limit, 500)}`;
  return rows(await getJson(url, signal))
    .map((r) => ({
      time: num(r["timestamp"]),
      amount: num(r["sumOpenInterest"]),
      value: num(r["sumOpenInterestValue"]),
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value));
}

export async function loadLongShort(
  symbol: string,
  period = "1h",
  limit = 200,
  signal?: AbortSignal,
): Promise<RatioPoint[]> {
  const url = `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${Math.min(limit, 500)}`;
  return rows(await getJson(url, signal))
    .map((r) => ({
      time: num(r["timestamp"]),
      longAccount: num(r["longAccount"]),
      shortAccount: num(r["shortAccount"]),
      ratio: num(r["longShortRatio"]),
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.ratio));
}

export async function loadTakerFlow(
  symbol: string,
  period = "1h",
  limit = 200,
  signal?: AbortSignal,
): Promise<TakerFlowPoint[]> {
  const url = `${FAPI}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${Math.min(limit, 500)}`;
  return rows(await getJson(url, signal))
    .map((r) => ({
      time: num(r["timestamp"]),
      buyVol: num(r["buyVol"]),
      sellVol: num(r["sellVol"]),
      ratio: num(r["buySellRatio"]),
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.ratio));
}

// ---------------------------------------------------------------- reading --

const SPOT_API = "https://api.binance.com";

export interface SpotPerp {
  spot: number;
  /** The perpetual's MARK price, not its last trade. */
  mark: number;
  /** The exchange's own index of the underlying, for cross-checking. */
  index: number;
}

/**
 * Spot and perpetual prices, for the basis.
 *
 * Two different hosts: spot lives on api.binance.com, futures on
 * fapi.binance.com. Both keyless and CORS-open. The MARK price is used rather
 * than the last trade because mark is what liquidations and funding are
 * computed against — the last trade can be a single wick that nothing settles
 * on.
 */
export async function loadSpotPerp(symbol: string, signal?: AbortSignal): Promise<SpotPerp> {
  const [spotRaw, perpRaw] = await Promise.all([
    getJson(`${SPOT_API}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`, signal),
    getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, signal),
  ]);
  const spot = num((spotRaw as Record<string, unknown>)?.["price"]);
  const perp = perpRaw as Record<string, unknown>;
  const mark = num(perp?.["markPrice"]);
  const index = num(perp?.["indexPrice"]);
  if (!(spot > 0) || !(mark > 0)) throw new Error("no spot/perp quote for this symbol");
  return { spot, mark, index };
}

export interface DerivSignal {
  id: string;
  name: string;
  direction: "long" | "short" | "neutral";
  /** The headline number, already formatted. */
  value: string;
  reason: string;
}

export interface DerivRead {
  signals: DerivSignal[];
  /** Set when there was not enough data to say anything. */
  insufficient: string | null;
}

/** Annualise a per-interval funding rate. Binance funds every 8h → 3x/day. */
export function annualisedFunding(ratePerInterval: number, intervalsPerDay = 3): number {
  return ratePerInterval * intervalsPerDay * 365 * 100;
}

/**
 * Turn the four series into a plain-language read.
 *
 * The interpretations here are the standard ones, and each says WHY rather than
 * asserting a conclusion — because every one of them has a well-known failure
 * mode. Crowded longs can stay crowded for months; rising OI into a rally is
 * confirmation right up until it is the setup for a squeeze. The reasoning is
 * the deliverable, not the verdict.
 */
export function readDerivatives(input: {
  funding: readonly FundingPoint[];
  openInterest: readonly OpenInterestPoint[];
  longShort: readonly RatioPoint[];
  takerFlow: readonly TakerFlowPoint[];
  priceChangePct?: number;
}): DerivRead {
  const signals: DerivSignal[] = [];
  const { funding, openInterest, longShort, takerFlow } = input;

  // Every series must be checked, not most of them: a symbol carrying only one
  // of the four would otherwise be reported as having no data at all while the
  // data sat right there in the argument.
  if (
    funding.length === 0 &&
    openInterest.length === 0 &&
    longShort.length === 0 &&
    takerFlow.length === 0
  ) {
    return { signals: [], insufficient: "no derivatives data for this symbol" };
  }

  // --- funding ------------------------------------------------------------
  const lastFunding = funding[funding.length - 1];
  if (lastFunding) {
    const apr = annualisedFunding(lastFunding.rate);
    const recent = funding.slice(-24);
    const mean = recent.reduce((s, p) => s + p.rate, 0) / (recent.length || 1);
    const hot = Math.abs(apr) > 30;
    signals.push({
      id: "funding",
      name: "Funding",
      // Extreme funding is a CROWDING signal, so it leans against the crowd.
      // Mild funding is not a signal at all and must not pretend to be one.
      direction: hot ? (apr > 0 ? "short" : "long") : "neutral",
      value: `${(lastFunding.rate * 100).toFixed(4)}% (${apr.toFixed(1)}% APR)`,
      reason: hot
        ? `longs are paying ${apr.toFixed(1)}% annualised to hold — crowded ${apr > 0 ? "long" : "short"} positioning, ` +
          `which is a squeeze risk against that side, not a directional forecast`
        : `funding ${(lastFunding.rate * 100).toFixed(4)}% per interval (${apr.toFixed(1)}% APR), ` +
          `24-interval mean ${(mean * 100).toFixed(4)}% — no meaningful crowding`,
    });
  }

  // --- open interest ------------------------------------------------------
  if (openInterest.length >= 2) {
    const last = openInterest[openInterest.length - 1] as OpenInterestPoint;
    const back = openInterest[Math.max(0, openInterest.length - 25)] as OpenInterestPoint;
    const change = back.value > 0 ? (last.value - back.value) / back.value : 0;
    const priceUp = (input.priceChangePct ?? 0) >= 0;
    const rising = change > 0.02;
    const falling = change < -0.02;

    // OI alone is directionless. It only means something ALONGSIDE price, which
    // is why the reason always states both.
    let reason: string;
    let direction: DerivSignal["direction"] = "neutral";
    if (rising) {
      direction = priceUp ? "long" : "short";
      reason =
        `open interest up ${(change * 100).toFixed(1)}% while price ${priceUp ? "rose" : "fell"} — ` +
        `new money entering on the ${priceUp ? "long" : "short"} side, which confirms the move ` +
        `but also builds the fuel for a squeeze against it`;
    } else if (falling) {
      reason =
        `open interest down ${(Math.abs(change) * 100).toFixed(1)}% — positions closing, ` +
        `so the move is being driven by exits rather than new conviction`;
    } else {
      reason = `open interest flat (${(change * 100).toFixed(1)}%) — no positioning change worth reading`;
    }

    signals.push({
      id: "open-interest",
      name: "Open interest",
      direction,
      value: fmtUsd(last.value),
      reason,
    });
  }

  // --- crowd positioning --------------------------------------------------
  const lastRatio = longShort[longShort.length - 1];
  if (lastRatio) {
    const pct = lastRatio.longAccount * 100;
    const lopsided = pct > 65 || pct < 35;
    signals.push({
      id: "positioning",
      name: "Account positioning",
      // The retail crowd being lopsided is a contrarian input, and is labelled
      // as exactly that rather than dressed up as a forecast.
      direction: lopsided ? (pct > 65 ? "short" : "long") : "neutral",
      value: `${pct.toFixed(1)}% long`,
      reason: lopsided
        ? `${pct.toFixed(1)}% of accounts are ${pct > 65 ? "long" : "short"} (ratio ${lastRatio.ratio.toFixed(2)}) — ` +
          `a lopsided crowd, read as contrarian, though crowds can stay lopsided for a long time`
        : `${pct.toFixed(1)}% of accounts long (ratio ${lastRatio.ratio.toFixed(2)}) — balanced, no crowding to fade`,
    });
  }

  // --- taker aggression ---------------------------------------------------
  const lastTaker = takerFlow[takerFlow.length - 1];
  if (lastTaker) {
    const aggressive = lastTaker.ratio > 1.15 || lastTaker.ratio < 0.87;
    signals.push({
      id: "taker-flow",
      name: "Taker flow",
      direction: aggressive ? (lastTaker.ratio > 1 ? "long" : "short") : "neutral",
      value: `${lastTaker.ratio.toFixed(3)} buy/sell`,
      reason: aggressive
        ? `market ${lastTaker.ratio > 1 ? "buyers" : "sellers"} are lifting the book: ` +
          `${lastTaker.ratio.toFixed(2)}x taker ${lastTaker.ratio > 1 ? "buy" : "sell"} volume ` +
          `(${fmtNum(lastTaker.buyVol)} vs ${fmtNum(lastTaker.sellVol)}) — active aggression, not resting orders`
        : `taker buy/sell ${lastTaker.ratio.toFixed(3)} — neither side is aggressively lifting`,
    });
  }

  return { signals, insufficient: signals.length === 0 ? "no usable derivatives data" : null };
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(1);
}
