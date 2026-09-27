/**
 * Multi-source data with failover.
 *
 * THE RISK THIS REMOVES
 * Every byte in the terminal came from one vendor. A rate limit, a geo-block or
 * an outage took the whole application dark — and the terminal could not price
 * forex, metals or equities at all, which is most of what actually gets traded
 * here.
 *
 * DESIGN RULES
 *
 * 1. **Failover is ordered and explained.** Sources are tried in priority order
 *    and every attempt is recorded with the reason it failed. A silent fallback
 *    is how you end up reading 15-minute-delayed equity data believing it is
 *    live crypto.
 *
 * 2. **Provenance travels with the bars.** The result names the source that
 *    served it and that source's quality. Downstream — the freshness contract,
 *    the archive, any model — needs to know, and none of them can ask later.
 *
 * 3. **A failing source is not retried immediately.** Without a circuit
 *    breaker, a screener scanning 200 symbols against a dead vendor makes 200
 *    doomed requests and takes 200 timeouts before falling through. One failure
 *    opens the breaker for everything until a cooldown passes.
 *
 * 4. **Support is declared, not discovered.** Asking Binance for EURUSD and
 *    waiting for a 400 wastes a request and a round trip; each source states
 *    what it can serve.
 */

import { governor } from "./net";
import { signal, type Signal } from "../core/signal";
import { coinbaseSource, bybitSource, okxSource, looksCrypto } from "./venues";
import type { BarView } from "../chart/series";
import type { DataQuality } from "../store/barstore";
import { proxyBase } from "./backend";

export interface LoadOptions {
  limit?: number;
  /** Inclusive window. Sources that cannot honour it return what they can. */
  from?: number;
  to?: number;
  signal?: AbortSignal;
}

export interface DataSource {
  id: string;
  label: string;
  /** Lower runs first. */
  priority: number;
  quality: DataQuality;
  /** Asset classes this source can serve, for the UI. */
  covers: string;
  supports(symbol: string): boolean;
  loadBars(symbol: string, timeframe: string, opts: LoadOptions): Promise<BarView[]>;
  /** Live socket URL, or null when this source has no stream. */
  streamUrl?(symbol: string, timeframe: string): string | null;
}

export interface Attempt {
  source: string;
  ok: boolean;
  /** Why it was not used: an error, or that it does not cover the symbol. */
  note: string;
  ms: number;
}

export interface Resolution {
  bars: BarView[];
  source: DataSource | null;
  quality: DataQuality;
  /** Every source considered, in order, with the outcome. */
  attempts: Attempt[];
}

export interface BreakerOptions {
  /** How long a source stays skipped after a failure. */
  cooldownMs?: number;
  /** Consecutive failures before the breaker opens. */
  threshold?: number;
  now?: () => number;
}

/**
 * Per-source circuit breaker.
 *
 * Deliberately trips on consecutive failures rather than a rate: a source that
 * fails once transiently should not be written off, and one that has failed
 * three times running is down.
 */
export function createBreaker(opts: BreakerOptions = {}) {
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const threshold = opts.threshold ?? 3;
  const now = opts.now ?? Date.now;

  const failures = new Map<string, number>();
  const openedAt = new Map<string, number>();

  return {
    /** True when this source should be skipped right now. */
    isOpen(id: string): boolean {
      const opened = openedAt.get(id);
      if (opened === undefined) return false;
      if (now() - opened >= cooldownMs) {
        // Cooldown elapsed: allow ONE probe through. If it fails the counter is
        // already at the threshold, so the breaker re-opens immediately.
        openedAt.delete(id);
        return false;
      }
      return true;
    },

    recordSuccess(id: string): void {
      failures.delete(id);
      openedAt.delete(id);
    },

    recordFailure(id: string): void {
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      if (n >= threshold) openedAt.set(id, now());
    },

    /** For diagnostics. */
    state(id: string): { failures: number; open: boolean } {
      return { failures: failures.get(id) ?? 0, open: openedAt.has(id) };
    },

    reset(): void {
      failures.clear();
      openedAt.clear();
    },
  };
}

export type Breaker = ReturnType<typeof createBreaker>;

export interface Registry {
  sources: DataSource[];
  breaker: Breaker;
  /** Sources that could serve this symbol, in priority order. */
  candidates(symbol: string): DataSource[];
  resolve(symbol: string, timeframe: string, opts?: LoadOptions): Promise<Resolution>;

  /**
   * Switch sources off by id.
   *
   * The user's choice, not the breaker's: the breaker parks a source that is
   * failing and lets it back in on its own, while this is a standing decision
   * ("I do not want my broker's feed pricing crypto"). Keeping them separate
   * means a source you disabled does not silently come back after a timeout,
   * and a source the breaker parked is not reported to you as switched off.
   */
  setDisabled(ids: Iterable<string>): void;
  isDisabled(id: string): boolean;
  disabledIds(): string[];
}

export function createRegistry(sources: DataSource[], breaker: Breaker = createBreaker()): Registry {
  const ordered = [...sources].sort((a, b) => a.priority - b.priority);
  const disabled = new Set<string>();

  return {
    sources: ordered,
    breaker,

    setDisabled(ids) {
      disabled.clear();
      for (const id of ids) disabled.add(id);
    },
    isDisabled: (id) => disabled.has(id),
    disabledIds: () => [...disabled],

    candidates(symbol) {
      return ordered.filter((s) => s.supports(symbol) && !disabled.has(s.id));
    },

    async resolve(symbol, timeframe, opts = {}) {
      const attempts: Attempt[] = [];
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

      for (const source of ordered) {
        if (disabled.has(source.id)) {
          /* Named in the attempt log rather than skipped silently. A chart that
             will not load because of a switch you flipped a week ago is only
             debuggable if the log says so. */
          attempts.push({ source: source.id, ok: false, note: "switched off in Settings", ms: 0 });
          continue;
        }
        if (!source.supports(symbol)) {
          attempts.push({ source: source.id, ok: false, note: `does not cover ${symbol}`, ms: 0 });
          continue;
        }
        if (breaker.isOpen(source.id)) {
          attempts.push({ source: source.id, ok: false, note: "skipped — circuit open", ms: 0 });
          continue;
        }

        const started = now();
        try {
          const bars = await source.loadBars(symbol, timeframe, opts);
          const ms = Math.round(now() - started);

          // An empty result is a FAILURE for failover purposes: the next source
          // may well have the data, and returning [] as success would make the
          // terminal show an empty chart while a working vendor sat unused.
          if (bars.length === 0) {
            breaker.recordFailure(source.id);
            attempts.push({ source: source.id, ok: false, note: "returned no bars", ms });
            continue;
          }

          breaker.recordSuccess(source.id);
          attempts.push({ source: source.id, ok: true, note: `${bars.length} bars`, ms });
          return { bars, source, quality: source.quality, attempts };
        } catch (err) {
          const ms = Math.round(now() - started);
          // An abort is the caller changing its mind, not the source failing —
          // counting it would open the breaker on a vendor that is perfectly
          // healthy, just because the user switched symbols quickly.
          const aborted = opts.signal?.aborted === true || (err as Error)?.name === "AbortError";
          if (!aborted) breaker.recordFailure(source.id);
          attempts.push({
            source: source.id,
            ok: false,
            note: aborted ? "aborted" : err instanceof Error ? err.message : String(err),
            ms,
          });
          if (aborted) break;
        }
      }

      return { bars: [], source: null, quality: "unknown", attempts };
    },
  };
}

// ------------------------------------------------------------- the sources --

/* `looksCrypto` moved to data/venues.ts, beside `splitPair`. Two files each
   holding their own idea of "is this crypto?" is how a forex symbol reaches a
   crypto exchange. Imported above and re-exported here so callers — including
   the test suite — do not care where it lives. */
export { looksCrypto };

export function binanceSourceV2(): DataSource {
  return {
    id: "binance",
    label: "Binance",
    priority: 0,
    quality: "live",
    covers: "crypto spot",
    supports: looksCrypto,

    async loadBars(symbol, timeframe, opts) {
      const url = new URL("https://api.binance.com/api/v3/klines");
      url.searchParams.set("symbol", symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase());
      url.searchParams.set("interval", timeframe);
      url.searchParams.set("limit", String(Math.min(opts.limit ?? 800, 1000)));
      if (opts.from !== undefined) url.searchParams.set("startTime", String(Math.floor(opts.from)));
      if (opts.to !== undefined) url.searchParams.set("endTime", String(Math.floor(opts.to)));

      // Through the kernel: shared weight budget, in-flight de-duplication and
      // the venue's own used-weight header. A 429 here parks the whole host for
      // every other caller too, which is the entire point of one door out.
      const res = await governor.request({
        url: url.toString(),
        priority: "normal",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 429 || res.status === 418) throw new Error("rate limited");
      if (!res.ok) throw new Error(`binance ${res.status}`);

      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error("unexpected payload");
      return raw
        .map((row) => {
          const k = row as [number, string, string, string, string, string];
          return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
        })
        .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c));
    },

    streamUrl(symbol, timeframe) {
      const s = symbol.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      return `wss://stream.binance.com:9443/ws/${s}@kline_${timeframe}`;
    },
  };
}

/**
 * The local Python proxy (`server/ddt_data_server.py`) — forex, metals and
 * equities, which no browser-reachable endpoint provides for free.
 *
 * WHY THIS IS THE ANSWER FOR FOREX
 * Nothing gives keyless intraday FX candles directly to a browser. Measured:
 * Yahoo's chart API and Frankfurter both refuse cross-origin requests,
 * exchangerate.host now requires a key, and the endpoints that ARE open
 * (open.er-api.com and friends) publish daily reference rates, not OHLC — you
 * cannot draw a 1h candle from a once-a-day number.
 *
 * The proxy runs on the user's own machine, so it has no CORS constraint, and
 * its `yfinance` provider needs no API key at all. That is the free live-ish
 * forex path, and it already existed.
 *
 * Marked `delayed` deliberately: yfinance is not a real-time feed and must
 * never be labelled live. It also exposes no socket, so `streamUrl` returns
 * null and the shell knows not to promise updates it will not receive.
 */
/**
 * The broker's clock offset, in milliseconds, as reported with the bars.
 *
 * `null` means it has not been measured — which is NOT the same as zero. Zero
 * is the claim "this broker stamps in UTC"; null is the absence of a claim, and
 * treating the two as equal is exactly how the three-hour error survived so
 * long. The proxy measures it from a live tick and subtracts it before the bars
 * leave the bridge; this signal carries what was applied, so the terminal can
 * show a correction rather than perform one silently.
 */
export const brokerClockOffsetMs: Signal<number | null> = signal<number | null>(null);

export interface ProxySourceOptions {
  base?: string;
  provider?: string;
  id?: string;
  label?: string;
  quality?: DataQuality;
  priority?: number;
  covers?: string;
  supports?: (symbol: string) => boolean;
}

export function proxySourceV2(
  baseOrOpts: string | ProxySourceOptions = proxyBase(),
  providerArg = "yfinance",
): DataSource {
  const opts: ProxySourceOptions =
    typeof baseOrOpts === "string" ? { base: baseOrOpts, provider: providerArg } : baseOrOpts;
  const base = opts.base ?? proxyBase();
  const provider = opts.provider ?? "yfinance";

  return {
    id: opts.id ?? "proxy",
    label: opts.label ?? `Local proxy (${provider})`,
    priority: opts.priority ?? 2,
    quality: opts.quality ?? "delayed",
    covers: opts.covers ?? "forex, metals, equities, indices",
    // The fallback for everything, including crypto when Binance is unreachable.
    supports: opts.supports ?? (() => true),

    async loadBars(symbol, timeframe, opts) {
      // The real contract is /ohlc?provider=&symbol=&interval=&limit=, and the
      // proxy maps canonical symbols itself (EURUSD -> EURUSD=X, XAUUSD -> GC=F).
      const url = new URL("/ohlc", base);
      url.searchParams.set("provider", provider);
      url.searchParams.set("symbol", symbol.toUpperCase());
      url.searchParams.set("interval", timeframe);
      url.searchParams.set("limit", String(opts.limit ?? 800));

      const res = await governor.request({
        url: url.toString(),
        priority: "normal",
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        // The proxy reports the real reason in the body; surfacing it beats a
        // bare status code when the cause is "yfinance is not installed".
        let detail = "";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) detail = `: ${body.error}`;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`proxy ${res.status}${detail}`);
      }

      const body = (await res.json()) as {
        bars?: unknown;
        clock?: { offset_ms?: number; measured?: boolean };
      };
      if (!Array.isArray(body.bars)) throw new Error("no bars in payload");

      /* Recorded from the response that carried THESE bars, not from a separate
         probe made at some other moment. A clock reading taken elsewhere can
         disagree with the series on screen; this one cannot. */
      if (body.clock && body.clock.measured === true && typeof body.clock.offset_ms === "number") {
        brokerClockOffsetMs.set(body.clock.offset_ms);
      }

      const bars = body.bars
        .map((b) => {
          const r = b as Record<string, number>;
          return {
            t: Number(r["t"]),
            o: Number(r["o"]),
            h: Number(r["h"]),
            l: Number(r["l"]),
            c: Number(r["c"]),
            v: Number(r["v"] ?? 0),
          };
        })
        .filter(
          (b) =>
            Number.isFinite(b.t) &&
            b.t > 0 &&
            [b.o, b.h, b.l, b.c].every(Number.isFinite),
        );

      // The window is filtered client-side: /ohlc takes a limit, not a range.
      if (opts.from === undefined && opts.to === undefined) return bars;
      const from = opts.from ?? -Infinity;
      const to = opts.to ?? Infinity;
      return bars.filter((b) => b.t >= from && b.t <= to);
    },

    streamUrl: () => null,
  };
}

/**
 * Your own MT5 terminal, through the proxy bridge.
 *
 * THE ONLY GENUINELY REAL-TIME, GENUINELY FREE FOREX YOU CAN GET.
 * Every free third-party FX feed is either delayed, rate-limited to uselessness,
 * or behind a key. Your broker's own terminal is none of those — and it is the
 * venue you are actually filled at, so its prices are the only ones that are
 * true for you. That is why `PROVIDER_RANK` in the proxy already puts `mt5`
 * ahead of every vendor for fx, metals and stocks.
 *
 * Registered ABOVE the yfinance proxy and marked `live`. When MT5 is not
 * running it simply fails, the circuit breaker opens after three attempts, and
 * yfinance serves instead — which is exactly what the registry was built to do.
 * Nothing needs reconfiguring when you log in; the next probe just succeeds.
 *
 * Crypto still prefers Binance: MT5 crypto CFDs are the broker's synthetic
 * price, not the exchange's, and they are not the same instrument.
 */
export function mt5Source(base = proxyBase()): DataSource {
  return proxySourceV2({
    base,
    provider: "mt5",
    id: "mt5",
    label: "MT5 (your broker)",
    // Real-time: this is the terminal's own feed, not a vendor's copy of it.
    quality: "live",
    priority: 1,
    covers: "forex, metals, indices, stocks — your broker's own prices",
    supports: (symbol) => !looksCrypto(symbol),
  });
}

export function defaultRegistry(base = proxyBase()): Registry {
  /**
   * Order matters, and this is the order.
   *
   * Binance first: deepest book on most pairs and the one whose cache is warm.
   * Then your own broker, because a price you can actually trade against beats
   * a price you cannot. Then three more public venues — which exist so that a
   * Binance 418 stops being fatal, since the governor correctly parks a banned
   * host for hours and until now that meant no chart at all. Coinbase also
   * brings real USD rather than USDT, which is a different instrument.
   * The free delayed vendor stays the floor for everything non-crypto.
   */
  return createRegistry([
    binanceSourceV2(),
    mt5Source(base),
    coinbaseSource(),
    bybitSource(),
    okxSource(),
    /* The floor, explicitly last. Its default priority is 2, which now collides
       with the venues above it — and a tie would make the order depend on array
       position rather than on intent. */
    proxySourceV2({ base, priority: 9 }),
  ]);
}
