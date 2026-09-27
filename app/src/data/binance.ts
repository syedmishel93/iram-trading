/**
 * Binance REST endpoints used by the scanner.
 *
 * Separate from `feed.ts` because the scanner needs a different shape: one
 * bulk request for the whole universe, then targeted history for a subset.
 */

import { RateLimited, type ScanDeps, type UniverseEntry } from "../scan/scanner";
import { governor, responseCache } from "./net";
import { barTtlMs, requestKey } from "../store/cache";
import { intervalMs } from "./history";
import type { BarView } from "../chart/series";

const API = "https://api.binance.com";

/**
 * A 429/418 must be distinguishable from an ordinary failure, because the
 * response is completely different: back the whole client off, rather than
 * marking one symbol broken and carrying on at full tilt.
 */
async function guard(res: Response): Promise<void> {
  if (res.status === 429 || res.status === 418) {
    const header = res.headers.get("Retry-After");
    const seconds = header ? Number(header) : NaN;
    throw new RateLimited(Number.isFinite(seconds) ? seconds * 1000 : 5_000);
  }
  if (!res.ok) throw new Error(`binance ${res.status}`);
}

/** Every symbol with 24h stats, in ONE request. */
export async function loadBinanceUniverse(signal?: AbortSignal): Promise<UniverseEntry[]> {
  // Weight 40 — the single most expensive call the terminal makes, and the one
  // the screener opens with. Declared explicitly so the budget is not out by a
  // factor of twenty on exactly the request that trips the limit.
  const res = await governor.request({
    url: `${API}/api/v3/ticker/24hr`,
    priority: "background",
    weight: 40,
    ...(signal ? { signal } : {}),
  });
  await guard(res);

  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error("binance: unexpected universe payload");

  const out: UniverseEntry[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown>;
    const symbol = String(r["symbol"] ?? "");
    const quoteVolume = Number(r["quoteVolume"]);
    const changePct = Number(r["priceChangePercent"]);
    const lastPrice = Number(r["lastPrice"]);
    // A symbol with no volume or an unparseable price is not tradeable; keeping
    // it would push a real candidate out of the top-N.
    if (!symbol || !Number.isFinite(quoteVolume) || !Number.isFinite(lastPrice) || lastPrice <= 0) {
      continue;
    }
    out.push({
      symbol,
      quoteVolume,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      lastPrice,
    });
  }
  return out;
}

export async function loadBinanceBars(
  symbol: string,
  interval: string,
  limit: number,
  signal?: AbortSignal,
): Promise<BarView[]> {
  const url = new URL(`${API}/api/v3/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(limit, 1000)));

  /**
   * Cached until the forming bar closes.
   *
   * Re-running a scan inside the same bar asks 200 symbols for candles that
   * cannot have changed — every closed candle in the response is immutable, and
   * the one that is not is the one `barTtlMs` expires on. This is the single
   * largest reduction in vendor weight available, because the screener is by
   * far the heaviest caller.
   */
  const read = await responseCache.load<unknown[]>(
    requestKey(url.toString()),
    async () => {
      const res = await governor.request({
        url: url.toString(),
        // A scan is background work by definition: a chart the user just
        // clicked must not queue behind 200 of these.
        priority: "background",
        ...(signal ? { signal } : {}),
      });
      await guard(res);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error("binance: unexpected klines payload");
      return body;
    },
    { ttlMs: barTtlMs(intervalMs(interval), Date.now()) },
  );
  const raw = read.value;

  return raw.map((row: unknown) => {
    const k = row as [number, string, string, string, string, string];
    return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
  });
}

export const binanceScanDeps: ScanDeps = {
  loadUniverse: loadBinanceUniverse,
  loadBars: loadBinanceBars,
};
