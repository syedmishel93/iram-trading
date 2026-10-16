/**
 * The one door out.
 *
 * Every outbound request in the terminal goes through here, so that the rate
 * budget, the cache and the request log are shared rather than nine private
 * copies that each believe they are the only caller.
 *
 * BEFORE THIS FILE
 * `grep fetch(` found nine call sites in five modules. The chart fetched on
 * symbol change, the flow desk on a 15s timer, derivs on a 30s timer, the
 * screener six-wide across the universe, the intel panel on demand, the
 * calendar hourly. Each was individually reasonable. None of them knew about
 * the others, and Binance does not rate limit modules — it rate limits an IP,
 * and its answer to too much is 429, then 418, and 418 is a ban that gets
 * longer every time you retry into it.
 *
 * WHAT CHANGES BY ROUTING THROUGH ONE PLACE
 *  - One weight budget per host, sized under the published ceiling, that every
 *    caller spends from.
 *  - The venue's own `X-MBX-USED-WEIGHT-1M` counter is read on every response
 *    and tightens the budget — the only number in the system that is not our
 *    own estimate.
 *  - Two panels asking for the same URL in the same instant make ONE request.
 *  - A closed candle is never re-downloaded, because a closed candle cannot
 *    change (see `barTtlMs`).
 *  - A user-initiated load outranks a background sweep, so clicking a symbol
 *    during a 200-symbol scan does not queue behind it.
 *
 * The cheapest request is the one not made, so the cache sits in FRONT of the
 * budget: a cache hit costs no weight at all.
 */

import {
  createGovernor,
  createSupervisor,
  HostBannedError,
  hostOf,
  type Governor,
  type Priority,
  type Supervisor,
} from "../core/kernel";
import { createCache, requestKey, type Cache } from "../store/cache";

/** The shared budget. One per document, deliberately module-level. */
export const governor: Governor = createGovernor();

/** The shared response cache. */
export const responseCache: Cache = createCache();

/** Background jobs — retention, sync, prefetch. */
export const supervisor: Supervisor = createSupervisor();

export interface NetOptions {
  priority?: Priority;
  signal?: AbortSignal;
  /** Cache lifetime. 0 or omitted bypasses the cache entirely. */
  ttlMs?: number;
  /** Serve stale instantly and refresh behind. */
  swr?: boolean;
  /** Skip the cached value but still store the result. */
  refresh?: boolean;
  /** Endpoint weight override. */
  weight?: number;
  /**
   * The host is a relay fetching a third-party URL on our behalf.
   *
   * Its non-2xx answers belong to the upstream and must not be charged against
   * it. See RequestSpec.relay in core/kernel.ts.
   */
  relay?: boolean;
  init?: RequestInit;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A governed, optionally cached JSON GET.
 *
 * Throws `HttpError` on a non-2xx and `HostBannedError` when the host is
 * parked. Callers distinguish them because the responses are different: a 500
 * means try the next source, a ban means stop asking this one entirely and do
 * not count it against the source's circuit breaker — the vendor is not broken,
 * we are in the corner.
 */
export async function fetchJson<T>(url: string, opts: NetOptions = {}): Promise<T> {
  const load = async (): Promise<T> => {
    const res = await governor.request({
      url,
      priority: opts.priority ?? "normal",
      ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
      ...(opts.relay ? { relay: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.init ? { init: opts.init } : {}),
    });
    if (!res.ok) {
      throw new HttpError(res.status, url, `${hostOf(url)} answered ${res.status}`);
    }
    return (await res.json()) as T;
  };

  if (!opts.ttlMs) return load();

  const read = await responseCache.load<T>(requestKey(url), load, {
    ttlMs: opts.ttlMs,
    ...(opts.swr !== undefined ? { swr: opts.swr } : {}),
    ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}),
  });
  return read.value;
}

/** True when this failure means "stop asking", not "this source is broken". */
export function isParked(err: unknown): err is HostBannedError {
  return err instanceof HostBannedError;
}

/**
 * Drop every cached response and every rate-budget observation.
 *
 * Two real callers: the Data desk's "clear cache" control, and tests — where a
 * module-level cache is exactly as shared between test cases as it is between
 * panels, so one case's stubbed response is served to the next one's assertion
 * unless this is called between them.
 *
 * It does NOT clear the archive. Cached responses are disposable; stored bars
 * are not, and a control labelled "clear cache" must never delete history.
 */
export function resetNet(): void {
  responseCache.clear();
  governor.reset();
}

export interface NetHealth {
  /** Hosts currently parked, with when they free up. */
  parked: Array<{ host: string; until: number; reason: string }>;
  requests: number;
  shared: number;
  rejections: number;
  throttled: number;
  cacheHitRate: number;
  cacheEntries: number;
  cacheBytes: number;
  /** Requests the cache saved outright. */
  saved: number;
  note: string;
}

export function netHealth(now = Date.now()): NetHealth {
  const g = governor.stats();
  const c = responseCache.stats();
  const parked = g.hosts
    .filter((h) => h.bannedUntil > now)
    .map((h) => ({ host: h.host, until: h.bannedUntil, reason: h.banReason }));

  return {
    parked,
    requests: g.totalRequests,
    shared: g.totalShared,
    rejections: g.totalRejections,
    throttled: g.throttled,
    cacheHitRate: c.hitRate,
    cacheEntries: c.entries,
    cacheBytes: c.bytes,
    saved: c.hits + c.coalesced + g.totalShared,
    note:
      parked.length > 0
        ? `${parked.length} host(s) parked — waiting is the fastest way out; probing extends a ban.`
        : g.totalRejections > 0
          ? `${g.totalRejections} rate refusal(s) seen; sustained rate was reduced and is climbing back.`
          : "within budget on every host",
  };
}
