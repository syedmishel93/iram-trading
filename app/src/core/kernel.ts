/**
 * The kernel — one owner for every outbound request and every background job.
 *
 * WHY THIS EXISTS
 * Until now each module fetched on its own schedule: the chart on symbol
 * change, the flow desk every 15s, derivs every 30s, the screener 6-wide across
 * 200 symbols, the intel panel on demand, the daemon on its own timer. Each was
 * individually polite. Together they are a burst, and a venue does not rate
 * limit modules — it rate limits an IP.
 *
 * The failure mode is not "a request fails". It is that Binance answers 429,
 * then answers 418, and 418 is an IP BAN measured in minutes to days that gets
 * LONGER every time you retry into it. One careless retry loop during a ban is
 * how a terminal goes dark for a day. So the rule here is not "handle 429" —
 * it is "never earn one", and if one arrives, treat it as proof the estimate
 * was wrong and permanently lower it.
 *
 * FIVE THINGS IT DOES THAT A PER-MODULE RETRY LOOP CANNOT
 *
 * 1. **Spends a shared budget.** One token bucket per HOST, sized under the
 *    published limit, with request WEIGHT — a klines call and a 24hr-ticker
 *    call do not cost the same and a request counter that pretends they do will
 *    be wrong by an order of magnitude on exactly the call that trips the limit.
 *
 * 2. **Reads the venue's own counter, WHERE IT CAN.** Binance returns
 *    `X-MBX-USED-WEIGHT-1M`: the server's authoritative view of what this IP
 *    has spent. Our estimate can drift (other tabs, the daemon, a retry we
 *    forgot to count); the header cannot, so when it disagrees the header wins.
 *
 *    Measured caveat, and it matters: Binance sends NO
 *    `Access-Control-Expose-Headers`, so a browser cannot read that header at
 *    all — the value is on the wire and the fetch spec hides it. It is readable
 *    from Node (the alert daemon) and through the local proxy, and it is not
 *    readable from the tab. Rather than quietly never syncing and letting the
 *    UI imply otherwise, a host whose declared header never arrives is marked
 *    `headerBlocked` and says so. The browser then runs purely on the
 *    conservative self-imposed budget, which is why that budget is set at a
 *    third of the published limit instead of at it.
 *
 * 3. **AIMD, not fixed backoff.** A 429 halves the sustained rate; recovery is
 *    a slow additive climb. Fixed backoff returns to the exact rate that just
 *    got refused, so it re-earns the 429 forever.
 *
 * 4. **Honours a ban as a ban.** 418 parks the whole host until the ban
 *    expires. No probing, no "just one request". Probing during a Binance ban
 *    extends it.
 *
 * 5. **De-duplicates and prioritises.** Identical in-flight GETs share one
 *    response, and a request the user is waiting on outranks a retention sweep.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not hold credentials and it does not sign requests. Every endpoint it
 * touches from the browser is public and keyless; anything needing a key goes
 * through the local proxy on 127.0.0.1, which is the only process on this
 * machine that should ever see one. A rate limiter that also became a keystore
 * would put a broker secret in a bundle that gets emailed around.
 */

export type Priority = "interactive" | "normal" | "background";

const PRIORITY_RANK: Record<Priority, number> = {
  interactive: 0,
  normal: 1,
  background: 2,
};

// ------------------------------------------------------------------ clock --

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

// ----------------------------------------------------------- token bucket --

export interface TokenBucket {
  /** Milliseconds until `cost` tokens are available. 0 means now. */
  waitFor(cost: number): number;
  /** Spend `cost` tokens. Call only after waiting `waitFor(cost)`. */
  spend(cost: number): void;
  /** Current token level, refilled to `now`. */
  level(): number;
  /** Sustained rate, tokens per second. */
  rate(): number;
  /**
   * Multiplicative decrease. Called when the venue refuses us: our estimate of
   * what it would accept was wrong, so lower it rather than retry into it.
   */
  penalise(factor: number): void;
  /** Additive increase, applied on sustained success. */
  recover(step: number): void;
  /** Force the level to match an authoritative external count. */
  syncUsed(used: number, limit: number): void;
  capacity(): number;
}

/**
 * A leaky bucket with an adjustable refill rate.
 *
 * The rate moves; the capacity does not. Capacity is the burst the venue will
 * tolerate and that is a property of the venue. The rate is our ESTIMATE of
 * what it will sustain, and an estimate that has just been proven wrong should
 * change.
 */
export function createBucket(
  capacity: number,
  refillPerSec: number,
  now: () => number,
  minRate = Math.max(0.2, refillPerSec / 16),
): TokenBucket {
  let tokens = capacity;
  let rate = refillPerSec;
  let last = now();
  const maxRate = refillPerSec;

  const refill = (): void => {
    const t = now();
    const dt = Math.max(0, t - last) / 1000;
    last = t;
    tokens = Math.min(capacity, tokens + dt * rate);
  };

  return {
    waitFor(cost) {
      refill();
      if (tokens >= cost) return 0;
      // Capacity itself can be smaller than a single expensive call. Waiting
      // forever would be worse than admitting we cannot ever afford it, so the
      // deficit is measured against what the bucket can actually hold.
      const deficit = Math.min(cost, capacity) - tokens;
      return Math.ceil((deficit / rate) * 1000);
    },
    spend(cost) {
      refill();
      tokens -= cost;
    },
    level() {
      refill();
      return tokens;
    },
    rate: () => rate,
    capacity: () => capacity,
    penalise(factor) {
      refill();
      rate = Math.max(minRate, rate * factor);
      // Drain the burst too. Keeping a full bucket after a refusal lets the
      // very next moment spend everything we were just told we could not.
      tokens = Math.min(tokens, 0);
    },
    recover(step) {
      rate = Math.min(maxRate, rate + step);
    },
    syncUsed(used, limit) {
      if (!(limit > 0) || !Number.isFinite(used)) return;
      refill();
      // The venue says we have `limit - used` left in its window. Our own
      // count is an estimate; this is the ledger. Only ever tighten — a header
      // that is stale or from a shared IP must not hand out free budget.
      const remaining = Math.max(0, limit - used);
      const asTokens = (remaining / limit) * capacity;
      if (asTokens < tokens) tokens = asTokens;
    },
  };
}

// ---------------------------------------------------------------- policies --

export interface HostPolicy {
  /** Matched against the URL host, exactly. */
  host: string;
  label: string;
  /** Burst the venue tolerates, in weight units. */
  capacity: number;
  /** Sustained weight per second. Set BELOW the published limit, not at it. */
  refillPerSec: number;
  /** Simultaneous in-flight requests. Bursts trip limits the average would not. */
  maxConcurrent: number;
  /** Response header carrying the venue's own usage count, if any. */
  usedWeightHeader?: string;
  /** Denominator for that header. */
  weightLimit?: number;
  /** Default cost when the caller does not declare one. */
  defaultWeight: number;
  /** Jitter added to every scheduled wait, to break up aligned pollers. */
  jitterMs: number;
}

/**
 * Shipped policies.
 *
 * Every number here is deliberately UNDER the published ceiling. Binance
 * publishes 1200 weight/minute (20/s) for the spot REST API; we sustain 8/s
 * with a burst of 120. That is a third of what is allowed, and it is the right
 * call: the terminal is not throughput-bound — one symbol's klines is a single
 * request and the screener is capped anyway — while a ban is measured in hours.
 * Spending two thirds of the budget to buy "never banned" is a trade worth
 * making every time.
 *
 * The local proxy gets a much higher allowance because it is a process on this
 * machine, but not an infinite one: it forwards to yfinance, which has its own
 * (undocumented, aggressive) limits, and being blocked upstream is exactly the
 * same outcome as being blocked directly.
 */
export const DEFAULT_POLICIES: readonly HostPolicy[] = [
  {
    host: "api.binance.com",
    label: "Binance spot",
    capacity: 120,
    refillPerSec: 8,
    maxConcurrent: 4,
    usedWeightHeader: "x-mbx-used-weight-1m",
    weightLimit: 1200,
    defaultWeight: 2,
    jitterMs: 120,
  },
  {
    host: "fapi.binance.com",
    label: "Binance futures",
    capacity: 120,
    refillPerSec: 8,
    maxConcurrent: 4,
    usedWeightHeader: "x-mbx-used-weight-1m",
    weightLimit: 2400,
    defaultWeight: 2,
    jitterMs: 120,
  },
  /**
   * The additional venues.
   *
   * Sized conservatively and WITHOUT a used-weight header, because none of
   * these publishes one a browser can read. Each is well inside its documented
   * public limit — Coinbase allows 10 requests/second per IP, Bybit and OKX
   * publish per-endpoint limits in the tens per second — so the budget here is
   * a fraction of what is permitted. These are FAILOVER sources: they matter
   * most exactly when Binance has parked us, and arriving at a second venue
   * with an aggressive rate would trade one ban for another.
   */
  {
    host: "api.exchange.coinbase.com",
    label: "Coinbase",
    capacity: 20,
    refillPerSec: 3,
    maxConcurrent: 3,
    defaultWeight: 1,
    jitterMs: 120,
  },
  {
    host: "api.bybit.com",
    label: "Bybit",
    capacity: 30,
    refillPerSec: 5,
    maxConcurrent: 3,
    defaultWeight: 1,
    jitterMs: 120,
  },
  {
    host: "www.okx.com",
    label: "OKX",
    capacity: 30,
    refillPerSec: 5,
    maxConcurrent: 3,
    defaultWeight: 1,
    jitterMs: 120,
  },
  {
    /* CoinGecko's free tier is roughly 10-30 calls a minute and answers 429
       readily. The fundamentals panel needs ONE call an hour, so this is set
       far below the limit on purpose. */
    host: "api.coingecko.com",
    label: "CoinGecko",
    capacity: 6,
    refillPerSec: 0.2,
    maxConcurrent: 1,
    defaultWeight: 1,
    jitterMs: 250,
  },
  {
    host: "127.0.0.1",
    label: "local proxy / service",
    capacity: 60,
    refillPerSec: 20,
    maxConcurrent: 6,
    defaultWeight: 1,
    jitterMs: 0,
  },
  {
    host: "localhost",
    label: "local proxy / service",
    capacity: 60,
    refillPerSec: 20,
    maxConcurrent: 6,
    defaultWeight: 1,
    jitterMs: 0,
  },
];

/** Anything not named above. Conservative on purpose: we know nothing about it. */
export const FALLBACK_POLICY: HostPolicy = {
  host: "*",
  label: "unknown host",
  capacity: 20,
  refillPerSec: 2,
  maxConcurrent: 2,
  defaultWeight: 1,
  jitterMs: 200,
};

export function hostOf(url: string): string {
  try {
    return new URL(url, "http://localhost").host.replace(/:\d+$/, "");
  } catch {
    return "invalid";
  }
}

/**
 * Weight of a Binance endpoint.
 *
 * These are the published costs. Treating every call as weight 1 understates a
 * universe scan by 40x — `/ticker/24hr` with no symbol costs 40, and it is the
 * single call the screener opens with. A counter that gets that wrong is not a
 * counter.
 */
export function binanceWeight(url: string): number {
  const path = (() => {
    try {
      return new URL(url, "http://localhost").pathname;
    } catch {
      return url;
    }
  })();
  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  const hasSymbol = /[?&]symbol=/.test(qs);

  if (path.includes("/ticker/24hr")) return hasSymbol ? 2 : 40;
  if (path.includes("/ticker/price")) return hasSymbol ? 2 : 4;
  if (path.includes("/ticker/bookTicker")) return hasSymbol ? 2 : 4;
  if (path.includes("/klines")) return 2;
  if (path.includes("/depth")) return 5;
  if (path.includes("/exchangeInfo")) return 20;
  if (path.includes("/trades") || path.includes("/aggTrades")) return 4;
  if (path.includes("/premiumIndex") || path.includes("/fundingRate")) return 1;
  if (path.includes("/openInterest")) return 1;
  return 2;
}

// --------------------------------------------------------------- governor --

export interface RequestSpec {
  url: string;
  init?: RequestInit;
  priority?: Priority;
  /** Overrides the policy default and the endpoint table. */
  weight?: number;
  signal?: AbortSignal;
  /** Opt out of in-flight sharing (a POST, or a call with side effects). */
  unique?: boolean;
  /**
   * This host is a RELAY. A refusal it returns belongs to someone else.
   *
   * FOUND BY A TEST, and it was worse than a cosmetic mislabel. The local
   * passthrough at 127.0.0.1 fetches third-party URLs and returns whatever
   * they say. When the calendar mirror answered 429, the governor read that as
   * "127.0.0.1 is rate-limiting us" and PARKED THE LOCAL PROXY — so one
   * upstream's limit took out every other route through it, including the MT5
   * bars and quotes that have nothing to do with the calendar.
   *
   * With this set, a non-2xx still surfaces to the caller as an HttpError —
   * nothing is hidden — but it does not halve the relay's rate, park it, or
   * count against it. The upstream's budget is not this host's budget, and the
   * relay never misbehaved.
   *
   * A TRANSPORT failure is different and is still counted: if the relay itself
   * cannot be reached, that genuinely is the relay's problem.
   */
  relay?: boolean;
}

export interface HostState {
  host: string;
  label: string;
  tokens: number;
  capacity: number;
  ratePerSec: number;
  nominalRatePerSec: number;
  inFlight: number;
  queued: number;
  /** Epoch ms the host is parked until, or 0. */
  bannedUntil: number;
  banReason: string;
  /**
   * Recent round-trip time, in milliseconds.
   *
   * A rolling MEDIAN of the last samples rather than a mean: one 4-second
   * timeout on an otherwise healthy host would drag a mean into the "slow"
   * band and keep it there, and routing decisions made off that would abandon
   * the fastest venue because of a single bad request.
   */
  latencyMs: number;
  /** Samples behind `latencyMs`. Below a handful the figure means little. */
  latencySamples: number;
  /**
   * The venue answered, but with a refusal rather than data.
   *
   * A 403 carrying HTML, or a 503 challenge page, is not a transport failure —
   * it is the host declining to serve this client, and it needs a different
   * response from a network error. Retrying a network error is correct;
   * retrying a refusal is how a soft block becomes a hard one.
   */
  softBlocked: boolean;
  softBlockReason: string;
  /**
   * When this host last refused, or 0.
   *
   * Distinct from the cumulative `rejections` count, and needed because that
   * count only ever grows: a single 429 an hour ago would otherwise mark a host
   * as degraded for the rest of the session, and a monitor that says "throttled"
   * about a host answering perfectly is one nobody reads twice.
   */
  lastRejectionAt: number;
  /** The venue's own last reported usage, if it publishes one. */
  reportedUsed: number | null;
  reportedLimit: number | null;
  /**
   * True when this host declares a usage header that never arrives.
   *
   * Almost always CORS: the header is sent, and the browser refuses to hand it
   * to script without `Access-Control-Expose-Headers`. Surfaced so the desk can
   * say "running on the local estimate" instead of showing a counter that will
   * never populate and letting it read as "zero used".
   */
  headerBlocked: boolean;
  requests: number;
  rejections: number;
  shared: number;
}

export interface GovernorStats {
  hosts: HostState[];
  totalRequests: number;
  totalShared: number;
  totalRejections: number;
  /** Requests that waited, and the total time they spent waiting. */
  throttled: number;
  throttledMs: number;
}

export interface Governor {
  request(spec: RequestSpec): Promise<Response>;
  /** Wrap any async work in the host budget, for non-fetch callers. */
  schedule<T>(host: string, priority: Priority, weight: number, fn: () => Promise<T>): Promise<T>;
  stats(): GovernorStats;
  /** True when this host is parked. Callers should not queue behind a ban. */
  isParked(host: string): boolean;
  reset(): void;
}

export class HostBannedError extends Error {
  constructor(
    readonly host: string,
    readonly until: number,
    readonly reason: string,
  ) {
    super(`${host} is parked until ${new Date(until).toISOString()} — ${reason}`);
    this.name = "HostBannedError";
  }
}

interface Waiter {
  priority: number;
  seq: number;
  cost: number;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
}

interface HostRuntime {
  policy: HostPolicy;
  bucket: TokenBucket;
  inFlight: number;
  queue: Waiter[];
  bannedUntil: number;
  banReason: string;
  reportedUsed: number | null;
  reportedLimit: number | null;
  headerMisses: number;
  requests: number;
  rejections: number;
  shared: number;
  consecutiveOk: number;
  pumping: boolean;
  /** Recent fetch round-trips, newest last. Bounded by LATENCY_WINDOW. */
  latency: number[];
  softBlocked: boolean;
  softBlockReason: string;
  lastRejectionAt: number;
}

/**
 * Samples behind the latency median.
 *
 * Small on purpose: this is used to decide whether a host is currently healthy,
 * and a long window would keep reporting yesterday's good latency through
 * today's outage.
 */
const LATENCY_WINDOW = 12;

export interface GovernorOptions {
  policies?: readonly HostPolicy[];
  clock?: Clock;
  fetchImpl?: typeof fetch;
  random?: () => number;
  /** Longest a single request will wait for budget before giving up. */
  maxWaitMs?: number;
}

export function createGovernor(opts: GovernorOptions = {}): Governor {
  const clock = opts.clock ?? systemClock;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const random = opts.random ?? Math.random;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const policies = new Map<string, HostPolicy>();
  for (const p of opts.policies ?? DEFAULT_POLICIES) policies.set(p.host, p);

  const hosts = new Map<string, HostRuntime>();
  /**
   * In-flight GETs, with a joiner count.
   *
   * The count exists so a request nobody shared is returned UNCLONED. A
   * `Response.clone()` buffers the whole body a second time, and cloning every
   * 1000-bar klines payload on the chance someone might join costs more than
   * the sharing saves — the common case is exactly one caller.
   */
  const inflight = new Map<string, { promise: Promise<Response>; joiners: number }>();
  let seq = 0;
  let throttled = 0;
  let throttledMs = 0;

  const runtimeFor = (host: string): HostRuntime => {
    const existing = hosts.get(host);
    if (existing) return existing;
    const policy = policies.get(host) ?? { ...FALLBACK_POLICY, host, label: host };
    const rt: HostRuntime = {
      policy,
      bucket: createBucket(policy.capacity, policy.refillPerSec, () => clock.now()),
      inFlight: 0,
      queue: [],
      latency: [],
      softBlocked: false,
      softBlockReason: "",
      lastRejectionAt: 0,
      bannedUntil: 0,
      banReason: "",
      reportedUsed: null,
      reportedLimit: null,
      headerMisses: 0,
      requests: 0,
      rejections: 0,
      shared: 0,
      consecutiveOk: 0,
      pumping: false,
    };
    hosts.set(host, rt);
    return rt;
  };

  /**
   * Hand out slots in priority order.
   *
   * Runs as a loop rather than per-release recursion so a burst of releases
   * cannot build a stack, and so the highest-priority waiter is chosen against
   * the CURRENT queue rather than the one that existed when it arrived. A chart
   * click that lands mid-screener should not wait behind 190 background reads.
   */
  const pump = async (rt: HostRuntime): Promise<void> => {
    if (rt.pumping) return;
    rt.pumping = true;
    try {
      for (;;) {
        if (rt.queue.length === 0) return;

        const now = clock.now();

        // Drop anyone who gave up, or who has waited past the deadline, BEFORE
        // spending budget on them. Doing this in the pump rather than on a
        // per-waiter timer means no stray timers outlive the queue.
        for (let i = rt.queue.length - 1; i >= 0; i--) {
          const w = rt.queue[i] as Waiter;
          if (w.signal?.aborted) {
            rt.queue.splice(i, 1);
            w.reject(new DOMException("aborted", "AbortError"));
          } else if (maxWaitMs > 0 && now - w.enqueuedAt >= maxWaitMs) {
            rt.queue.splice(i, 1);
            w.reject(new Error(`${rt.policy.host}: waited ${maxWaitMs}ms for rate budget`));
          }
        }
        if (rt.queue.length === 0) return;
        if (rt.bannedUntil > now) {
          const err = new HostBannedError(rt.policy.host, rt.bannedUntil, rt.banReason);
          for (const w of rt.queue.splice(0)) w.reject(err);
          return;
        }

        if (rt.inFlight >= rt.policy.maxConcurrent) return;

        rt.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        const next = rt.queue[0] as Waiter;
        const wait = rt.bucket.waitFor(next.cost);

        if (wait > 0) {
          const jitter = rt.policy.jitterMs > 0 ? random() * rt.policy.jitterMs : 0;
          throttled++;
          throttledMs += wait + jitter;
          await clock.sleep(wait + jitter).catch(() => undefined);
          continue;
        }

        rt.queue.shift();
        rt.bucket.spend(next.cost);
        rt.inFlight++;
        next.resolve();
      }
    } finally {
      rt.pumping = false;
    }
  };

  const acquire = (
    rt: HostRuntime,
    priority: Priority,
    cost: number,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const now = clock.now();
    if (rt.bannedUntil > now) {
      return Promise.reject(new HostBannedError(rt.policy.host, rt.bannedUntil, rt.banReason));
    }
    return new Promise<void>((resolve, reject) => {
      // A request that can never be served must fail loudly rather than hang;
      // a silently stalled chart is indistinguishable from a broken one. The
      // deadline is enforced by the pump, which is already awake whenever the
      // queue is non-empty.
      rt.queue.push({
        priority: PRIORITY_RANK[priority],
        seq: seq++,
        cost,
        enqueuedAt: clock.now(),
        resolve,
        reject,
        signal,
      });
      void pump(rt);
    });
  };

  const release = (rt: HostRuntime): void => {
    rt.inFlight = Math.max(0, rt.inFlight - 1);
    void pump(rt);
  };

  /**
   * Learn from the response.
   *
   * The header path is the important one: it is the only number in the system
   * that is not a guess. `Retry-After` is likewise not advisory — it is the
   * venue telling us exactly when it will start answering again, and beating it
   * by a second only extends the penalty.
   */
  /**
   * The budget-header half of `observe`, without any of the penalties.
   *
   * Split out rather than guarded inside `observe` so that the one caller that
   * needs it — a relay returning someone else's refusal — reads as what it is
   * at the call site, instead of as a boolean threaded through a function whose
   * name promises it will react to the status.
   */
  const observeHeadersOnly = (rt: HostRuntime, headers: Headers | null): void => {
    const policy = rt.policy;
    if (!policy.usedWeightHeader || !headers) return;
    const raw = headers.get(policy.usedWeightHeader);
    const used = raw === null ? NaN : Number(raw);
    if (Number.isFinite(used)) {
      rt.reportedUsed = used;
      rt.reportedLimit = policy.weightLimit ?? null;
      rt.headerMisses = 0;
      if (policy.weightLimit) rt.bucket.syncUsed(used, policy.weightLimit);
    } else {
      rt.headerMisses++;
    }
  };

  const observe = (rt: HostRuntime, status: number, headers: Headers | null): void => {
    const policy = rt.policy;
    if (policy.usedWeightHeader && headers) {
      const raw = headers.get(policy.usedWeightHeader);
      const used = raw === null ? NaN : Number(raw);
      if (Number.isFinite(used)) {
        rt.reportedUsed = used;
        rt.reportedLimit = policy.weightLimit ?? null;
        rt.headerMisses = 0;
        if (policy.weightLimit) rt.bucket.syncUsed(used, policy.weightLimit);
      } else {
        // Counted rather than assumed: one absent header could be an error
        // response, but a run of them means the browser is not being allowed
        // to see it and the estimate is all we have.
        rt.headerMisses++;
      }
    }

    const retryAfterMs = (): number => {
      const raw = headers?.get("retry-after");
      const secs = raw === null || raw === undefined ? NaN : Number(raw);
      return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
    };

    if (status === 429) {
      rt.rejections++;
      rt.lastRejectionAt = clock.now();
      rt.consecutiveOk = 0;
      // Halve the sustained rate. A 429 is proof the previous rate was too
      // high, and returning to it after a pause simply re-earns the 429.
      rt.bucket.penalise(0.5);
      const wait = retryAfterMs() || 10_000;
      rt.bannedUntil = Math.max(rt.bannedUntil, clock.now() + wait);
      rt.banReason = `429 from ${policy.label}; honouring Retry-After`;
      return;
    }

    if (status === 418 || status === 403) {
      rt.rejections++;
      rt.lastRejectionAt = clock.now();
      rt.consecutiveOk = 0;
      rt.bucket.penalise(0.25);
      // Binance's 418 IS the ban. Default to ten minutes when it does not say,
      // because guessing short and probing is what turns minutes into days.
      const wait = retryAfterMs() || 10 * 60_000;
      rt.bannedUntil = Math.max(rt.bannedUntil, clock.now() + wait);
      rt.banReason =
        status === 418
          ? `418 — IP parked by ${policy.label}. Probing extends this; waiting does not.`
          : `403 from ${policy.label}`;
      return;
    }

    if (status >= 200 && status < 400) {
      rt.consecutiveOk++;
      // Additive increase, and only after a run of clean responses, so one
      // lucky reply does not undo a penalty that was correct.
      if (rt.consecutiveOk >= 20) {
        rt.consecutiveOk = 0;
        rt.bucket.recover(policy.refillPerSec * 0.05);
      }
    }
  };

  const weightFor = (spec: RequestSpec, policy: HostPolicy): number => {
    if (spec.weight !== undefined) return spec.weight;
    if (policy.usedWeightHeader) return binanceWeight(spec.url);
    return policy.defaultWeight;
  };

  /**
   * Median of a small sample window.
   *
   * Kept inline rather than imported so the kernel stays dependency-free — it
   * is the one module that must be loadable in the alert daemon, which has no
   * DOM and no app bundle around it.
   */
  const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  };

  const run = async (spec: RequestSpec): Promise<Response> => {
    const host = hostOf(spec.url);
    const rt = runtimeFor(host);
    const cost = weightFor(spec, rt.policy);
    const signal = spec.signal ?? spec.init?.signal ?? undefined;

    await acquire(rt, spec.priority ?? "normal", cost, signal ?? undefined);
    rt.requests++;
    try {
      const init: RequestInit = { ...spec.init, ...(signal ? { signal } : {}) };
      const startedAt = clock.now();
      const res = await doFetch(spec.url, init);

      /* Latency is measured around the FETCH only, never around the queue wait.
         Including the time a request spent waiting for its own budget would
         report the governor's politeness as the venue being slow, and every
         throttled host would look like a failing one. */
      rt.latency.push(clock.now() - startedAt);
      if (rt.latency.length > LATENCY_WINDOW) rt.latency.shift();

      /**
       * Soft-block detection.
       *
       * A 403 or 503 whose body is HTML is a challenge or a block page, not an
       * API response. The status alone cannot tell you: plenty of APIs answer
       * 403 with JSON for an ordinary permission error, and treating that as a
       * block would park a host that is working fine.
       */
      if (res.status === 403 || res.status === 503) {
        const type = res.headers.get("content-type") ?? "";
        if (type.includes("text/html")) {
          rt.softBlocked = true;
          rt.softBlockReason = `${res.status} with an HTML body — a challenge or block page, not an API answer. Retrying is what turns this into a longer block.`;
        }
      } else if (res.ok) {
        rt.softBlocked = false;
        rt.softBlockReason = "";
      }

      /* A relay's non-2xx is the upstream's refusal, not this host's. Header
         accounting still runs — a relay may publish its own budget headers —
         but the penalties do not. */
      if (spec.relay && !res.ok) observeHeadersOnly(rt, res.headers);
      else observe(rt, res.status, res.headers);
      return res;
    } finally {
      release(rt);
    }
  };

  return {
    request(spec) {
      const method = (spec.init?.method ?? "GET").toUpperCase();
      const shareable = !spec.unique && method === "GET";
      if (!shareable) return run(spec);

      // Two panels asking for the same klines at the same instant is one
      // request. This is the cheapest weight reduction available and it costs
      // nothing but a map.
      const key = `${method} ${spec.url}`;
      const existing = inflight.get(key);
      if (existing) {
        runtimeFor(hostOf(spec.url)).shared++;
        existing.joiners++;
        // Each joiner needs its own body to read.
        return existing.promise.then((res) => res.clone());
      }

      const entry = { promise: null as unknown as Promise<Response>, joiners: 0 };
      entry.promise = run(spec).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, entry);
      // Joins can only happen before the promise settles, so by the time this
      // handler runs the count is final.
      return entry.promise.then((res) => (entry.joiners > 0 ? res.clone() : res));
    },

    async schedule(host, priority, weight, fn) {
      const rt = runtimeFor(host);
      await acquire(rt, priority, weight, undefined);
      rt.requests++;
      try {
        return await fn();
      } finally {
        release(rt);
      }
    },

    isParked(host) {
      const rt = hosts.get(host);
      return rt !== undefined && rt.bannedUntil > clock.now();
    },

    stats() {
      let totalRequests = 0;
      let totalShared = 0;
      let totalRejections = 0;
      const list: HostState[] = [];
      for (const [host, rt] of hosts) {
        totalRequests += rt.requests;
        totalShared += rt.shared;
        totalRejections += rt.rejections;
        list.push({
          host,
          label: rt.policy.label,
          tokens: Math.round(rt.bucket.level() * 10) / 10,
          capacity: rt.bucket.capacity(),
          ratePerSec: Math.round(rt.bucket.rate() * 100) / 100,
          nominalRatePerSec: rt.policy.refillPerSec,
          inFlight: rt.inFlight,
          queued: rt.queue.length,
          bannedUntil: rt.bannedUntil,
          banReason: rt.banReason,
          latencyMs: Math.round(median(rt.latency)),
          latencySamples: rt.latency.length,
          softBlocked: rt.softBlocked,
          softBlockReason: rt.softBlockReason,
          lastRejectionAt: rt.lastRejectionAt,
          reportedUsed: rt.reportedUsed,
          reportedLimit: rt.reportedLimit,
          headerBlocked:
            rt.policy.usedWeightHeader !== undefined &&
            rt.reportedUsed === null &&
            rt.headerMisses >= 3,
          requests: rt.requests,
          rejections: rt.rejections,
          shared: rt.shared,
        });
      }
      list.sort((a, b) => b.requests - a.requests);
      return { hosts: list, totalRequests, totalShared, totalRejections, throttled, throttledMs };
    },

    reset() {
      hosts.clear();
      inflight.clear();
      throttled = 0;
      throttledMs = 0;
    },
  };
}

// ------------------------------------------------------------- supervisor --

export interface KernelJob {
  id: string;
  label: string;
  everyMs: number;
  priority?: Priority;
  run(signal: AbortSignal): Promise<void>;
  /** Run once immediately on start. Default false: boot is already busy. */
  immediate?: boolean;
}

export interface JobState {
  id: string;
  label: string;
  everyMs: number;
  lastRun: number | null;
  lastMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  running: boolean;
  /** Consecutive failures currently extending the interval. */
  backoffLevel: number;
  nextRun: number | null;
}

export interface Supervisor {
  add(job: KernelJob): void;
  remove(id: string): void;
  start(): void;
  stop(): void;
  runNow(id: string): Promise<void>;
  jobs(): JobState[];
  running(): boolean;
}

/**
 * Periodic background work, supervised.
 *
 * Three properties that a bare `setInterval` does not have and that matter here:
 *
 *  - **Never overlapping.** A retention sweep that takes longer than its
 *    interval must not start a second copy competing for the same IndexedDB
 *    transaction.
 *  - **Isolated.** One job throwing does not stop the others, and the error is
 *    recorded rather than logged and lost.
 *  - **Backed off.** A job failing repeatedly (the sync target is down) slows
 *    to a crawl instead of retrying every 30s forever, which is how a local
 *    bug turns into outbound traffic that looks like an attack.
 */
export function createSupervisor(clock: Clock = systemClock): Supervisor {
  interface Entry {
    job: KernelJob;
    state: JobState;
    timer: ReturnType<typeof setTimeout> | null;
    controller: AbortController | null;
  }
  const entries = new Map<string, Entry>();
  let started = false;

  const delayFor = (e: Entry): number => {
    // Exponential, capped at 30 minutes: enough to stop hammering, short enough
    // that a recovered service is picked up without a restart.
    const factor = Math.min(2 ** e.state.backoffLevel, 64);
    return Math.min(e.job.everyMs * factor, 30 * 60_000);
  };

  const schedule = (e: Entry, delay: number): void => {
    if (!started) return;
    if (e.timer !== null) clearTimeout(e.timer);
    e.state.nextRun = clock.now() + delay;
    e.timer = setTimeout(() => {
      void execute(e);
    }, delay);
  };

  const execute = async (e: Entry): Promise<void> => {
    if (e.state.running) return;
    e.state.running = true;
    e.controller = new AbortController();
    const t0 = clock.now();
    try {
      await e.job.run(e.controller.signal);
      e.state.lastError = null;
      e.state.backoffLevel = 0;
    } catch (err) {
      e.state.failures++;
      e.state.lastError = err instanceof Error ? err.message : String(err);
      e.state.backoffLevel = Math.min(6, e.state.backoffLevel + 1);
    } finally {
      e.state.running = false;
      e.state.runs++;
      e.state.lastRun = t0;
      e.state.lastMs = clock.now() - t0;
      e.controller = null;
      schedule(e, delayFor(e));
    }
  };

  return {
    add(job) {
      if (entries.has(job.id)) return;
      const e: Entry = {
        job,
        state: {
          id: job.id,
          label: job.label,
          everyMs: job.everyMs,
          lastRun: null,
          lastMs: null,
          lastError: null,
          runs: 0,
          failures: 0,
          running: false,
          backoffLevel: 0,
          nextRun: null,
        },
        timer: null,
        controller: null,
      };
      entries.set(job.id, e);
      if (started) schedule(e, job.immediate ? 0 : job.everyMs);
    },

    remove(id) {
      const e = entries.get(id);
      if (!e) return;
      if (e.timer !== null) clearTimeout(e.timer);
      e.controller?.abort();
      entries.delete(id);
    },

    start() {
      if (started) return;
      started = true;
      for (const e of entries.values()) schedule(e, e.job.immediate ? 0 : e.job.everyMs);
    },

    stop() {
      started = false;
      for (const e of entries.values()) {
        if (e.timer !== null) clearTimeout(e.timer);
        e.timer = null;
        e.controller?.abort();
        e.state.nextRun = null;
      }
    },

    async runNow(id) {
      const e = entries.get(id);
      if (e) await execute(e);
    },

    jobs() {
      return [...entries.values()].map((e) => ({ ...e.state }));
    },

    running: () => started,
  };
}
