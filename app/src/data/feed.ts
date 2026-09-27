/**
 * Bar sources and the freshness contract.
 *
 * THE HONESTY CONTRACT, IN CODE
 * A feed that fails must produce an honest empty state and say so. It must
 * never fall back to generated data, because a synthetic candle that looks like
 * a real one is the single most dangerous thing this application could render.
 *
 * v43.1 TOOK THAT ONE STEP FURTHER: THERE IS NO GENERATOR AT ALL.
 * Earlier builds shipped a `demo` mode — synthetic bars the operator selected
 * deliberately, labelled `demo` in every surface downstream so nothing could
 * silently transition into it. That was a defensible design and it is now gone,
 * because the strongest version of "this terminal never shows you a fake price"
 * is not a carefully-labelled fake-price mode. It is the absence of any code
 * that can produce one.
 *
 * The failure state is an empty chart that says why. That is the whole story.
 *
 * Separately, "the connection is alive" and "the data is current" are different
 * questions. A vendor can stream a perfectly healthy socket of 15-minute-old
 * prices. `tickAgeMs` answers the first, `vendorLagMs` the second, and a feed
 * with real lag is reported `delayed` — never plain `live`.
 */

import { signal, type Signal } from "../core/signal";
import type { BarView } from "../chart/series";
import { createStream, parseLiveFrame, type LiveFrame, type StreamStatus, type StreamOptions } from "./stream";
import { governor } from "./net";
import { createHistory, liveServerArchive, intervalMs, type HistoryService } from "./history";
import { marketState } from "./sessions";
import { defaultRegistry, type DataSource, type Registry } from "./sources";
import { createFeedLog, type FeedLog } from "./feedlog";
import { createArchive, indexedDbBackend, type BarArchive } from "../store/barstore";
import type { Range } from "../store/segments";
import type { DataQuality } from "../store/barstore";
import { gatewayStreamUrl, proxyBase, streamThroughBackend } from "./backend";

export type FeedQuality = "live" | "delayed" | "stale" | "offline" | "closed";

export interface FeedState {
  quality: FeedQuality;
  /** Milliseconds since the last message of any kind. */
  tickAgeMs: number;
  /** How far the newest bar lags wall-clock, beyond one bar interval. */
  vendorLagMs: number;
  source: string;
  note: string;
}

export const OFFLINE: FeedState = {
  quality: "offline",
  tickAgeMs: Infinity,
  vendorLagMs: Infinity,
  source: "—",
  note: "no feed",
};

/**
 * Thresholds in milliseconds, expressed as multiples of the bar interval.
 *
 * EXPORTED so a consumer can NAME the threshold it is reporting against rather
 * than writing `3` again beside its own copy of the sentence. `analysis/live.ts`
 * publishes a feed-degradation event whose `because` has to read "tick age 214s
 * against the 3-bar staleness rule"; a second literal there would be free to
 * drift from the one the classification actually used, and the event would then
 * describe a threshold nothing applied.
 */
export const STALE_BARS = 3;
export const DELAYED_MS = 90_000;

export function classify(
  lastTickAt: number,
  newestBarTime: number,
  spacingMs: number,
  source: string,
  now = Date.now(),
  /**
   * When the venue is shut, age is not evidence of a broken feed.
   *
   * Without this, a healthy broker feed is labelled DELAYED every weekend —
   * and an operator who sees that warning every Saturday stops reading it,
   * which is exactly how a REAL staleness alarm gets missed on a Wednesday.
   */
  marketClosed = false,
): FeedState {
  const tickAgeMs = now - lastTickAt;
  // One full bar of lag is expected: the newest CLOSED bar is by definition one
  // interval old. Only lag beyond that is the vendor being behind.
  const vendorLagMs = Math.max(0, now - newestBarTime - spacingMs);

  if (!isFinite(tickAgeMs) || lastTickAt === 0) return { ...OFFLINE, source };

  if (marketClosed) {
    return {
      quality: "closed",
      tickAgeMs,
      vendorLagMs,
      source,
      note: "market closed — last price is the close",
    };
  }

  const staleAfter = spacingMs > 0 ? spacingMs * STALE_BARS : 120_000;
  if (tickAgeMs > staleAfter) {
    return {
      quality: "stale",
      tickAgeMs,
      vendorLagMs,
      source,
      note: `no update for ${Math.round(tickAgeMs / 1000)}s`,
    };
  }
  if (vendorLagMs > DELAYED_MS) {
    return {
      quality: "delayed",
      tickAgeMs,
      vendorLagMs,
      source,
      note: `vendor ${Math.round(vendorLagMs / 60000)}m behind`,
    };
  }
  return { quality: "live", tickAgeMs, vendorLagMs, source, note: "current" };
}

/**
 * How often to ask a socketless source for the newest bars.
 *
 * THE FAULT THIS FIXES
 * `mt5Source` and both proxy sources return `null` from `streamUrl`, which is
 * honest — they have no socket. But `startLive` treated "no socket" as "no
 * updates", disconnected, and returned. So every forex, metals and equity chart
 * loaded once and then aged for ever: the badge read "STALE — no update for
 * 218s" and climbing, on a broker feed that was perfectly healthy and one HTTP
 * request away. Nothing in the terminal was ever going to ask it again.
 *
 * WHY THE CADENCE IS DERIVED, NOT CONFIGURED
 * The useful poll rate is a property of the bar, not a preference: you want
 * several looks inside each forming bar and no more. A twelfth of the span
 * gives twelve, which is enough to watch a candle build without spending a
 * request on every pixel.
 *
 * Then two clamps, and they bite in opposite directions.
 *
 * The FLOOR stops a fast chart hammering the source. `live` here means the
 * local proxy talking to your own MT5 terminal — no rate limit, no vendor, a
 * loopback round trip measured at 28ms — so five seconds is comfortable. A
 * `delayed` vendor publishes on its own schedule and asking faster than that
 * buys load and nothing else, so its floor is far wider.
 *
 * The CEILING is the one that actually binds on most timeframes, and it is not
 * about cost. A twelfth of a 1h bar is five minutes, and a terminal whose
 * "last price" can be five minutes old is not a terminal you should size a
 * position from. The current price matters on a daily chart exactly as much as
 * on a one-minute chart — it is the same price. So the interval is capped at a
 * minute for a live source whatever the timeframe, and anything slower than a
 * twelve-minute bar polls at that cap rather than at its twelfth.
 */
export function pollIntervalMs(spanMs: number, quality: DataQuality): number {
  const target = spanMs > 0 ? spanMs / 12 : 15_000;
  const [floor, ceiling] =
    quality === "live" ? [5_000, 60_000] : [30_000, 300_000];
  return Math.min(ceiling, Math.max(floor, Math.round(target)));
}

// ---------------------------------------------------------------- sources --

export interface BarSource {
  readonly id: string;
  readonly label: string;
  /** Resolve historical bars, newest last. Throws on failure — never fakes. */
  load(symbol: string, interval: string, limit: number): Promise<BarView[]>;
}

/** Binance public REST. No key, no proxy, CORS-open. */
export const binanceSource: BarSource = {
  id: "binance",
  label: "Binance",
  async load(symbol, interval, limit) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase());
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(Math.min(limit, 1000)));

    // "interactive": this path only runs because the user picked a symbol or a
    // timeframe, and it must not wait behind a background scan.
    const res = await governor.request({
      url: url.toString(),
      priority: "interactive",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error("binance: unexpected payload");

    return raw.map((row) => {
      const k = row as [number, string, string, string, string, string];
      return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
    });
  },
};

/** The local Python proxy (server/ddt_data_server.py) — yfinance and friends. */
export function proxySource(base = proxyBase()): BarSource {
  return {
    id: "proxy",
    label: "Local proxy",
    async load(symbol, interval, limit) {
      const url = new URL("/bars", base);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("tf", interval);
      url.searchParams.set("limit", String(limit));

      const res = await governor.request({
        url: url.toString(),
        priority: "interactive",
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const body = (await res.json()) as { bars?: unknown };
      const bars = body.bars;
      if (!Array.isArray(bars)) throw new Error("proxy: no bars in payload");

      return bars.map((b) => {
        const r = b as Record<string, number>;
        return {
          t: Number(r["t"] ?? r["time"] ?? 0),
          o: Number(r["o"] ?? r["open"] ?? 0),
          h: Number(r["h"] ?? r["high"] ?? 0),
          l: Number(r["l"] ?? r["low"] ?? 0),
          c: Number(r["c"] ?? r["close"] ?? 0),
          v: Number(r["v"] ?? r["volume"] ?? 0),
        };
      });
    },
  };
}

/**
 * Explicitly-selected demo data. NOT a fallback — see the file header.
 *
 * Seeded so the same inputs give the same series: a reproducible chart is the
 * point of a demo mode, and an irreproducible one is useless for checking a
 * rendering change.
 *
 * `endTime` is a PARAMETER, not a `Date.now()` read inside the function. Reading
 * the clock internally made two calls with identical arguments differ whenever a
 * millisecond ticked between them — the series shape was seeded, but every
 * timestamp moved. Determinism has to be complete to be worth claiming.
 */
export interface FeedHandle {
  bars: Signal<BarView[]>;
  state: Signal<FeedState>;
  streamStatus: Signal<StreamStatus>;
  /** How many times the live socket has had to reconnect. */
  reconnects: Signal<number>;
  /** True when the current series came from the local archive. */
  fromCache: Signal<boolean>;
  /** Holes in the loaded window that the archive does not have. */
  gaps: Signal<Range[]>;
  /** Which source served the current series. */
  activeSource: Signal<string>;
  /**
   * The instrument the bars in `bars` actually belong to.
   *
   * WHY THIS HAD TO EXIST
   * `bars` is deliberately NOT cleared on a symbol change — the previous series
   * stays on screen while the new one loads, which is the right call for the
   * chart: a chart that blanks on every symbol switch is unusable. But it means
   * that for the second or two the load takes, `bars` and `state.symbol()`
   * describe DIFFERENT INSTRUMENTS, and everything derived from bars is
   * therefore about the old one while the card is titled with the new one.
   *
   * Harmless for a candle. Not harmless for the Setup card, where it was
   * measured pairing gold's live broker spread (0.18) against Bitcoin's stop
   * distance (~460) and printing "Spread is 0.0% of the stop distance" — a
   * money gate passing on arithmetic that crossed two instruments.
   *
   * Consumers that must not straddle a switch compare this against the selected
   * symbol and decline to render until they agree.
   */
  loadedSymbol: Signal<string>;
  /**
   * The timeframe those bars are on, for exactly the same reason.
   *
   * THE SYMBOL WAS GUARDED AND THE TIMEFRAME WAS NOT, AND IT IS THE WORSE OF
   * THE TWO. A symbol switch changes the price by orders of magnitude, so
   * downstream arithmetic that straddles one tends to produce something
   * obviously absurd. A timeframe switch changes NOTHING about the price and
   * everything about the volatility, so the straddle is silent.
   *
   * Measured on XAUUSD switching 1h → 1m: the Setup card rebuilt its plan while
   * `bars` still held the hourly series, and placed a 1.00× ATR volatility stop
   * 18.94 points away — the hourly ATR — on a one-minute chart whose own ATR
   * was 1.47. The card then reported it as "12.89× ATR" and stood the trade
   * down. Every number in that plan was internally consistent and none of them
   * was about the chart on screen.
   */
  loadedTimeframe: Signal<string>;
  /**
   * How live bars are reaching us right now.
   *
   * `socket` is a stream; `poll` is the HTTP poller that keeps socketless
   * sources such as MT5 current; `none` means nothing is asking and the chart
   * will age. The three used to be indistinguishable — see `pollIntervalMs`.
   */
  transport: Signal<"socket" | "poll" | "none">;
  /** Poll cadence in ms while `transport` is `poll`; 0 otherwise. */
  pollEveryMs: Signal<number>;
  /** Every network event, newest first. A witness, not a controller. */
  log: FeedLog;
  /** The persistent history service, for backfills and diagnostics. */
  history: HistoryService;
  archive: BarArchive;
  /**
   * The source registry behind this feed.
   *
   * Exposed so Settings can list the venues, show which the breaker has parked,
   * and switch them off. Previously the registry was created inside `createFeed`
   * and reachable from nowhere, which is why there was no source selector.
   */
  registry: Registry;
  /**
   * Load through the source registry with failover, served from the archive
   * when it holds something current. Returns false only when nothing anywhere
   * could produce bars.
   */
  loadSymbol(symbol: string, interval: string, limit?: number): Promise<boolean>;
  /** Load history from `source`; on failure sets an honest offline state. */
  load(source: BarSource, symbol: string, interval: string, limit?: number): Promise<boolean>;
  /**
   * Start streaming live bars for the symbol whose history is loaded.
   * Safe to call repeatedly; a changed symbol/interval replaces the stream.
   */
  startLive(symbol: string, interval: string): void;
  stopLive(): void;
  dispose(): void;
}

export interface FeedOptions {
  /* Typed to the frame the feed actually consumes: a test that injects a
     `parse` must produce a `LiveFrame`, not an `unknown` the feed then has to
     trust. */
  stream?: StreamOptions<LiveFrame>;
  registry?: Registry;
  archive?: BarArchive;
  log?: FeedLog;
  /** Injected for tests, so the poller can be driven without real timers. */
  now?: () => number;
}

export function createFeed(opts: FeedOptions = {}): FeedHandle {
  const streamOpts = opts.stream ?? {};
  const registry = opts.registry ?? defaultRegistry();
  const archive = opts.archive ?? createArchive(indexedDbBackend());
  /* THE ONE PLACE the durable archive is switched on. `createHistory`'s
     default is inert so a test cannot reach the operator's database by
     accident — see `NO_SERVER` in data/history.ts. */
  const history = createHistory(registry, archive, Date.now, liveServerArchive);

  const bars = signal<BarView[]>([]);
  const state = signal<FeedState>(OFFLINE);
  const fromCache = signal(false);
  const gaps = signal<Range[]>([]);
  const activeSource = signal("—");
  const loadedSymbol = signal("");
  const loadedTimeframe = signal("");
  const transport = signal<"socket" | "poll" | "none">("none");
  const pollEveryMs = signal(0);
  /* ONE LOG PER FEED, not a shared module-level one.
     The first version used a singleton and the panel immediately showed four
     "socket open" lines for one connection: `workspace.ts` builds a feed per
     pane, so a four-pane layout has four feeds, four sockets and four sets of
     perfectly correct events — interleaved into one log that read like a fault.
     A diagnostic that mixes four subjects is worse than none. */
  const log = opts.log ?? createFeedLog();

  let lastTickAt = 0;
  let spacing = 0;
  let sourceLabel = "—";
  let demo = false;
  let liveKey = "";
  /** The symbol currently loaded, for session lookups. */
  let liveSymbol = "";
  /** Set by `load` so a reconnect can refetch the history it just missed. */
  let resync: (() => Promise<boolean>) | null = null;

  // The freshness contract must degrade on its own. If it only recomputed when
  // a message arrived, a dead feed would sit on its last "live" reading for
  // ever — which is exactly the failure the contract exists to prevent.
  const timer = window.setInterval(() => {
    if (demo || lastTickAt === 0) return;
    const list = bars.peek();
    const newest = list.length ? (list[list.length - 1] as BarView).t : 0;
    state.set(
      classify(lastTickAt, newest, spacing, sourceLabel, Date.now(), marketState(liveSymbol) === "closed"),
    );
  }, 1000);

  /**
   * Fold one live bar into the series.
   *
   * The forming bar is republished many times before it closes, so a matching
   * timestamp REPLACES rather than appends — the same invariant `Series.push`
   * enforces on the render side, applied here so the two never disagree.
   *
   * A new array is allocated per update rather than mutating in place. At ~800
   * bars that is a few microseconds of reference copying, and it keeps `bars`
   * an honest immutable signal: consumers can compare identity to know whether
   * anything changed, instead of every reader needing a revision counter.
   */
  const applyLiveBar = (bar: BarView): void => {
    const list = bars.peek();
    // Ignore ticks that arrive before history has loaded: appending to an empty
    // series would produce a one-bar chart that then jumps when history lands.
    if (list.length === 0) return;

    const last = list[list.length - 1] as BarView;
    if (bar.t < last.t) return; // out of order — a feed bug, not data

    lastTickAt = Date.now();

    const next = list.slice();
    const closedANewBar = bar.t !== last.t;
    if (closedANewBar) next.push(bar);
    else next[next.length - 1] = bar;
    bars.set(next);

    if (!demo) {
      state.set(
        classify(lastTickAt, bar.t, spacing, sourceLabel, Date.now(), marketState(liveSymbol) === "closed"),
      );
    }

    // Persist only CLOSED bars. Writing the forming bar on every tick would
    // hammer IndexedDB several times a second to store a value that is still
    // changing — and the bar it replaces would be a half-formed candle if the
    // tab closed mid-bar.
    if (closedANewBar && !demo && liveKey) {
      const [sym, tf] = liveKey.split("|");
      const closed = list[list.length - 1] as BarView;
      void history
        .record(sym as string, tf as string, activeSource.peek(), "live", [closed])
        .catch(() => undefined);
    }
  };

  /**
   * Whether the live socket is currently the gateway's rather than a vendor's.
   *
   * Kept so a failure can be told apart from a vendor socket dropping: the
   * gateway not being there is a recoverable configuration fact with a good
   * fallback, and a vendor dropping is a network event the reconnect ladder
   * already handles correctly. Treating them the same would either abandon a
   * vendor socket that was about to come back, or retry a gateway that is not
   * running until the chart went stale.
   */
  let usingGateway = false;
  /** Set once the gateway socket has produced a bar; disarms the fallback. */
  let gatewayDelivered = false;
  /** The direct path to fall back to, captured when the gateway is tried. */
  let fallback: (() => void) | null = null;

  const stream = createStream<LiveFrame>(
    {
      onData: (frame) => {
        if (usingGateway) {
          gatewayDelivered = true;
          /* THE SENDER DECIDES WHAT THIS IS, NOT THE PIPE.
             A gateway frame marked `poll` came from a vendor with no socket;
             it reached us over a WebSocket, and calling that a stream would
             relabel a five-second poll as a live feed because of the transport
             it happened to arrive on. */
          if (frame.transport === "poll") {
            transport.set("poll");
            pollEveryMs.set(frame.pollEveryMs ?? 0);
          } else {
            transport.set("socket");
            pollEveryMs.set(0);
          }
        }
        applyLiveBar(frame.bar);
      },
      onStatus: (status) => {
        log.record({
          kind: "socket",
          source: activeSource.peek(),
          symbol: liveSymbol,
          timeframe: liveKey.split("|")[1] ?? "",
          ok: status === "open",
          text:
            status === "open"
              ? "socket open"
              : status === "reconnecting"
                ? "socket dropped — reconnecting"
                : `socket ${status}`,
        });

        /* THE GATEWAY GETS EXACTLY ONE CHANCE.
           If it never delivered a bar and the socket is already reconnecting,
           the backend is not running — and the reconnect ladder would go on
           retrying it with growing backoff while the chart aged, which is the
           one outcome that must not follow from an optional optimisation.
           Once it HAS delivered, this disarms and the normal ladder owns the
           connection, because by then a drop is an ordinary network event. */
        if (usingGateway && !gatewayDelivered && status === "reconnecting") {
          const direct = fallback;
          usingGateway = false;
          fallback = null;
          stream.disconnect();
          log.record({
            kind: "notice",
            source: "gateway",
            symbol: liveSymbol,
            timeframe: liveKey.split("|")[1] ?? "",
            ok: false,
            text: "backend stream did not open — using the direct feed",
          });
          if (direct) direct();
        }
      },
      onResync: () => {
        // Bars that closed during the outage were never sent down the socket.
        // Refetch rather than splice the hole shut and call it continuous.
        if (resync) void resync();
      },
    },
    { parse: parseLiveFrame, ...streamOpts },
  );

  // ---- the poller ---------------------------------------------------------
  //
  // Deliberately asks for a HANDFUL of bars, not the whole window. The forming
  // bar and the one or two behind it are all that can have changed since the
  // last poll, and a source that has silently backfilled further than that is a
  // different problem — one a 3-bar poll must not paper over by quietly
  // replacing history the operator has been reading.

  let pollTimer = 0;
  let polling = false;

  const stopPolling = (): void => {
    if (pollTimer !== 0) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
    }
  };

  const pollOnce = async (src: DataSource, symbol: string, interval: string): Promise<void> => {
    // One in flight at a time. A proxy that has gone slow must not accumulate a
    // queue of identical requests that all land at once when it recovers.
    if (polling) return;
    polling = true;
    const started = Date.now();
    try {
      const fresh = await src.loadBars(symbol, interval, { limit: 3 });
      const ms = Date.now() - started;
      if (fresh.length === 0) {
        log.record({
          kind: "poll", source: src.id, symbol, timeframe: interval, ok: false, ms,
          text: "returned no bars",
        });
        return;
      }
      const newest = fresh[fresh.length - 1] as BarView;
      const before = bars.peek();
      const last = before.length > 0 ? (before[before.length - 1] as BarView) : null;
      applyLiveBar(newest);

      const moved = last === null || newest.t !== last.t || newest.c !== last.c;
      log.record({
        kind: "poll", source: src.id, symbol, timeframe: interval, ok: true, ms,
        /* The close that came back, named. A bare number in a log column could
           be a latency, a count or a price. "nothing changed" is a real and
           useful answer too — it is what a quiet market looks like, and it is
           not the same as a poll that failed. */
        text: moved
          ? `close ${newest.c}${last !== null && newest.t !== last.t ? " · new bar" : ""}`
          : "unchanged",
      });
    } catch (err) {
      log.record({
        kind: "poll", source: src.id, symbol, timeframe: interval, ok: false,
        ms: Date.now() - started,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      polling = false;
    }
  };

  const startPolling = (src: DataSource, symbol: string, interval: string): void => {
    const every = pollIntervalMs(intervalMs(interval), src.quality);
    transport.set("poll");
    pollEveryMs.set(every);
    log.record({
      kind: "notice", source: src.id, symbol, timeframe: interval, ok: true,
      text: `no socket on this source — polling every ${Math.round(every / 1000)}s`,
    });
    void pollOnce(src, symbol, interval);
    pollTimer = window.setInterval(() => void pollOnce(src, symbol, interval), every);
  };

  const measureSpacing = (list: readonly BarView[]): number => {
    if (list.length < 3) return 0;
    const gaps: number[] = [];
    for (let i = list.length - 1; i > Math.max(0, list.length - 33); i--) {
      gaps.push((list[i] as BarView).t - (list[i - 1] as BarView).t);
    }
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1] ?? 0;
  };

  return {
    bars,
    state,
    streamStatus: stream.status,
    reconnects: stream.reconnects,
    fromCache,
    gaps,
    activeSource,
    loadedSymbol,
    loadedTimeframe,
    transport,
    pollEveryMs,
    log,
    history,
    archive,
    registry,

    async loadSymbol(symbol, interval, limit = 800) {
      resync = () => this.loadSymbol(symbol, interval, limit);
      const startedAt = Date.now();
      try {
        const r = await history.load(symbol, interval, { limit });

        /* Every attempt, recorded. These were computed on every single load and
           then dropped in the expression that returned the bars — so when the
           chart failed over from Binance to your broker, or sat empty because
           three sources refused in a row, there was nowhere at all to see it. */
        for (const a of r.attempts) {
          log.record({
            kind: "attempt", source: a.source, symbol, timeframe: interval,
            ok: a.ok, ms: a.ms, text: a.note,
          });
        }

        const was = activeSource.peek();
        if (r.bars.length > 0 && was !== "—" && was !== r.source) {
          log.record({
            kind: "switch", source: r.source, symbol, timeframe: interval, ok: true,
            text: `switched from ${was} — ${r.attempts.find((a) => a.source === was)?.note ?? "no longer serving"}`,
          });
        }

        if (r.bars.length === 0) {
          lastTickAt = 0;
          demo = false;
          activeSource.set("—");
          fromCache.set(false);
          gaps.set(r.gaps);
          state.set({
            ...OFFLINE,
            source: "—",
            note: r.attempts.map((a) => `${a.source}: ${a.note}`).join("; ") || "no source",
          });
          log.record({
            kind: "load", source: "—", symbol, timeframe: interval, ok: false,
            ms: Date.now() - startedAt,
            text: `no source produced bars for ${symbol} ${interval}`,
          });
          return false;
        }

        demo = false;
        sourceLabel = r.source;
        liveSymbol = symbol;
        activeSource.set(r.source);
        fromCache.set(r.fromCache);
        gaps.set(r.gaps);
        spacing = intervalMs(interval);
        // A cache hit is NOT a tick. Dating it now would report a freshly
        // loaded archive as a live feed; the freshness contract then has to be
        // told the truth by the newest bar's own timestamp.
        lastTickAt = r.fromCache ? (r.bars[r.bars.length - 1] as BarView).t : Date.now();
        bars.set(r.bars);
        /* Set WITH the bars, never before them. Anything that reads these to
           decide whether the series matches the selection would otherwise get
           the new name one microtask before the new data. */
        loadedSymbol.set(symbol);
        loadedTimeframe.set(interval);
        log.record({
          kind: "load", source: r.source, symbol, timeframe: interval, ok: true,
          ms: Date.now() - startedAt,
          text: `${r.bars.length} bars${r.fromCache ? " from the local archive" : ""}${
            r.gaps.length > 0 ? `, ${r.gaps.length} gap(s)` : ""
          }`,
        });
        state.set(
          classify(
            lastTickAt,
            (r.bars[r.bars.length - 1] as BarView).t,
            spacing,
            sourceLabel,
            Date.now(),
            marketState(symbol) === "closed",
          ),
        );
        return true;
      } catch (err) {
        lastTickAt = 0;
        state.set({
          ...OFFLINE,
          source: sourceLabel,
          note: err instanceof Error ? err.message : "load failed",
        });
        return false;
      }
    },

    startLive(symbol, interval) {
      const key = `${symbol}|${interval}`;
      if (key === liveKey) return;

      stopPolling();
      usingGateway = false;
      gatewayDelivered = false;
      fallback = null;

      /**
       * The direct path: a vendor socket where one exists, an HTTP poll where
       * one does not. This is what the terminal has always done, and it is both
       * the default and the thing the gateway falls back TO.
       */
      const direct = (): void => {
        const src = registry.candidates(symbol).find((s) => s.streamUrl?.(symbol, interval));
        const url = src?.streamUrl?.(symbol, interval);
        if (url) {
          liveKey = key;
          transport.set("socket");
          pollEveryMs.set(0);
          log.record({
            kind: "socket",
            source: src?.id ?? "socket",
            symbol,
            timeframe: interval,
            ok: true,
            text: `streaming ${new URL(url).host}`,
          });
          stream.connect(url);
          return;
        }

        stream.disconnect();

        const poller = registry.candidates(symbol)[0];
        if (!poller) {
          liveKey = "";
          transport.set("none");
          pollEveryMs.set(0);
          log.record({
            kind: "notice",
            source: "—",
            symbol,
            timeframe: interval,
            ok: false,
            text: `no source covers ${symbol}, so nothing will refresh this chart`,
          });
          return;
        }

        liveKey = key;
        startPolling(poller, symbol, interval);
      };

      /* THE GATEWAY FIRST, WHEN ASKED FOR — and only when asked for.
         It serves every pane watching a symbol from one vendor connection, and
         it gives a socket to sources that have none. Both are real, and neither
         is worth making the chart's liveness depend on a second process without
         the operator saying so. If it does not open, `onStatus` calls `direct`
         and the terminal behaves exactly as it did before. */
      if (streamThroughBackend()) {
        liveKey = key;
        usingGateway = true;
        fallback = direct;
        /* Optimistic, and corrected by the first frame: the gateway states its
           own transport, and a polled upstream will say so within one tick. */
        transport.set("socket");
        pollEveryMs.set(0);
        log.record({
          kind: "socket",
          source: "gateway",
          symbol,
          timeframe: interval,
          ok: true,
          text: "streaming through the backend",
        });
        stream.connect(gatewayStreamUrl(symbol, interval));
        return;
      }

      direct();
    },

    stopLive() {
      liveKey = "";
      stopPolling();
      transport.set("none");
      stream.disconnect();
    },

    async load(source, symbol, interval, limit = 800) {
      resync = () => this.load(source, symbol, interval, limit);
      try {
        const list = await source.load(symbol, interval, limit);
        if (!list.length) throw new Error("empty series");
        demo = false;
        sourceLabel = source.label;
        lastTickAt = Date.now();
        spacing = measureSpacing(list);
        bars.set(list);
        state.set(classify(lastTickAt, (list[list.length - 1] as BarView).t, spacing, sourceLabel));
        return true;
      } catch (err) {
        // Honest failure. The previous bars are left in place and FROZEN rather
        // than cleared, so the operator can still read what was last true — but
        // the state says offline, and every surface labels it.
        console.warn("[feed] load failed", err);
        lastTickAt = 0;
        state.set({
          ...OFFLINE,
          source: source.label,
          note: err instanceof Error ? err.message : "load failed",
        });
        return false;
      }
    },


    dispose() {
      window.clearInterval(timer);
      stopPolling();
      stream.disconnect();
    },
  };
}
