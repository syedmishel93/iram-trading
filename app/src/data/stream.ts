/**
 * Live bar streaming.
 *
 * The REST loader in `feed.ts` fetches history once. This keeps it current.
 *
 * THREE THINGS A NAIVE WEBSOCKET CLIENT GETS WRONG
 *
 * 1. **An open socket is not a live feed.** TCP will happily hold a connection
 *    open forever while the far end has stopped sending. A client that trusts
 *    `readyState === OPEN` reports LIVE on a dead tape — the exact failure the
 *    honesty contract exists to prevent. So there is a watchdog: silence longer
 *    than `silenceMs` is treated as a failure and forces a reconnect, whatever
 *    the socket thinks.
 *
 * 2. **Reconnecting in a tight loop is an attack on your own vendor.** Backoff
 *    is exponential and capped, with jitter — without jitter, every client that
 *    dropped on the same vendor blip reconnects on the same schedule for ever.
 *
 * 3. **A gap in the socket is a gap in the data.** Bars that closed while we
 *    were disconnected are simply missing; the socket only carries what happens
 *    next. So a reconnect reports `resynced`, and the owner refetches history
 *    rather than splicing a hole shut and pretending it was continuous.
 *
 * The transport is injected (`socketFactory`) so all of this is testable without
 * a network: the reconnect ladder and the watchdog are the parts most likely to
 * be wrong and the hardest to reproduce by hand.
 */

import { signal, type Signal } from "../core/signal";
import type { BarView } from "../chart/series";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The subset of WebSocket this module uses, so a fake can stand in. */
export interface SocketLike {
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/**
 * Delay before reconnect attempt `attempt` (0-based).
 *
 * Exponential from `base`, capped at `max`, then multiplied by a random factor
 * in [0.5, 1.0]. Pure and seedable via `rand` so the ladder can be asserted.
 */
export function backoffMs(attempt: number, base = 500, max = 30_000, rand = Math.random): number {
  const exp = Math.min(base * 2 ** attempt, max);
  return Math.round(exp * (0.5 + rand() * 0.5));
}

/** Binance combined-stream kline payload -> a bar, or null if unusable. */
export function parseBinanceKline(raw: unknown): { bar: BarView; closed: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  // Combined streams wrap the payload in { stream, data }.
  const body = (msg["data"] ?? msg) as Record<string, unknown>;
  const k = body["k"];
  if (typeof k !== "object" || k === null) return null;

  const kline = k as Record<string, unknown>;
  const t = Number(kline["t"]);
  const o = Number(kline["o"]);
  const h = Number(kline["h"]);
  const l = Number(kline["l"]);
  const c = Number(kline["c"]);
  const v = Number(kline["v"]);

  // A payload with a NaN anywhere is a malformed message, not a bar. Letting it
  // through would put NaN into the series and blank the price scale.
  if (![t, o, h, l, c, v].every(Number.isFinite)) return null;

  return { bar: { t, o, h, l, c, v }, closed: kline["x"] === true };
}

/**
 * What a live frame tells the feed, whoever sent it.
 *
 * `transport` is the field that matters and the reason this type exists rather
 * than the bar alone. The gateway can serve a POLLED upstream over a WebSocket
 * — that is the whole point of it for yfinance and friends — and a client that
 * inferred "socket therefore live" would relabel a five-second poll as a stream
 * because of the pipe it arrived through. The sender says which it is; nothing
 * downstream is allowed to guess.
 */
export interface LiveFrame {
  bar: BarView;
  closed: boolean;
  /** Absent for a direct vendor socket, which is a stream by construction. */
  transport?: "stream" | "poll";
  /** Upstream cadence when `transport` is `poll`; 0 or absent otherwise. */
  pollEveryMs?: number;
}

/**
 * A frame from `server/gateway`'s `/ws/bars`.
 *
 * `hello` and `error` return null: neither carries a bar, and the stream layer
 * treats null as "nothing to apply". The error case is deliberate — the gateway
 * has already told every client that its upstream failed, and the honest
 * response is to leave the last bar standing and let the staleness classifier
 * age it, not to synthesise a print to keep the chart moving.
 */
export function parseGatewayFrame(raw: unknown): LiveFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg["type"] !== "bar") return null;

  const b = msg["bar"];
  if (typeof b !== "object" || b === null) return null;
  const bar = b as Record<string, unknown>;

  const t = Number(bar["t"]);
  const o = Number(bar["o"]);
  const h = Number(bar["h"]);
  const l = Number(bar["l"]);
  const c = Number(bar["c"]);
  const v = Number(bar["v"]);
  if (![t, o, h, l, c, v].every(Number.isFinite)) return null;

  const transport = msg["transport"] === "poll" ? "poll" : "stream";
  const pollEveryMs = Number(msg["poll_every_ms"]);

  return {
    bar: { t, o, h, l, c, v },
    closed: bar["closed"] === true,
    transport,
    pollEveryMs: Number.isFinite(pollEveryMs) ? pollEveryMs : 0,
  };
}

/**
 * Parse a frame from either sender.
 *
 * The two shapes are unambiguous — a gateway frame has `type`, a Binance kline
 * has `k` — so one socket can carry either without the feed having to know at
 * connect time which it got. That is what lets the gateway be tried first and
 * the vendor be fallen back to without a second stream object.
 */
export function parseLiveFrame(raw: unknown): LiveFrame | null {
  if (typeof raw === "object" && raw !== null && "type" in (raw as object)) {
    return parseGatewayFrame(raw);
  }
  return parseBinanceKline(raw);
}

export interface StreamOptions<T = unknown> {
  /**
   * Turn one raw message into a value, or null to ignore it.
   *
   * Injected rather than hard-coded so the same reconnect ladder and silence
   * watchdog serve every socket the terminal opens — klines, liquidations,
   * anything later. Duplicating this logic per feed is how one of them ends up
   * quietly missing the watchdog.
   */
  parse?: (raw: unknown) => T | null;
  /**
   * Silence longer than this forces a reconnect.
   *
   * Set to 0 to DISABLE the watchdog, which is required for sparse event
   * streams. On a continuous feed like klines, silence is a failure and the
   * watchdog is the whole defence against a socket that is open but dead. On an
   * event feed like liquidations, silence is the normal state — a calm market
   * can go many minutes without one — and a watchdog there would reconnect
   * repeatedly for no reason, churning against the vendor and making a healthy
   * feed look unstable.
   */
  silenceMs?: number;
  socketFactory?: SocketFactory;
  /** Injected for tests. */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
  rand?: () => number;
}

export interface StreamHandle {
  status: Signal<StreamStatus>;
  /** Number of reconnects so far; useful for surfacing instability. */
  reconnects: Signal<number>;
  connect(url: string): void;
  disconnect(): void;
  /** Force the watchdog to evaluate now. Exposed for tests. */
  checkSilence(): void;
}

export interface StreamCallbacks<T> {
  onData(value: T): void;
  /**
   * Fired after a reconnect succeeds. Messages sent during the outage were
   * never received, so the owner must refetch rather than assume continuity.
   */
  onResync?: () => void;
  /**
   * Every transition of `status`, as it happens.
   *
   * The signal was always readable, but only by something already inside a
   * reactive scope. The feed log is a plain witness with no scope of its own,
   * and "the socket dropped at 15:42 and was open again at 15:42:03" is
   * precisely the kind of fact that is worthless unless it was recorded when it
   * happened.
   */
  onStatus?: (status: StreamStatus) => void;
}

export function createStream<T = { bar: BarView; closed: boolean }>(
  cb: StreamCallbacks<T>,
  opts: StreamOptions<T> = {},
): StreamHandle {
  const {
    parse = parseBinanceKline as unknown as (raw: unknown) => T | null,
    silenceMs = 90_000,
    socketFactory = (url: string) => new WebSocket(url) as unknown as SocketLike,
    now = Date.now,
    setTimeoutFn = ((fn: () => void, ms: number) => window.setTimeout(fn, ms)) as (
      fn: () => void,
      ms: number,
    ) => number,
    clearTimeoutFn = ((id: number) => window.clearTimeout(id)) as (id: number) => void,
    rand = Math.random,
  } = opts;

  const status = signal<StreamStatus>("idle");
  const reconnects = signal(0);

  /* One door for every transition, so `onStatus` cannot be forgotten at one of
     the five call sites. A no-op when the state has not actually changed —
     `closed` was set twice on an ordinary disconnect, which would have logged a
     socket closing twice for one close. */
  const setStatus = (next: StreamStatus): void => {
    if (status.peek() === next) return;
    status.set(next);
    cb.onStatus?.(next);
  };

  let socket: SocketLike | null = null;
  let url = "";
  let attempt = 0;
  let lastMessageAt = 0;
  let retryTimer: number | null = null;
  let watchdog: number | null = null;
  let wantOpen = false;
  /** True once a connection has succeeded, so the next open is a RE-connect. */
  let hadConnection = false;

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  };

  const armWatchdog = (): void => {
    if (watchdog !== null) clearTimeoutFn(watchdog);
    if (silenceMs <= 0) return; // watchdog disabled for sparse streams
    watchdog = setTimeoutFn(() => {
      watchdog = null;
      checkSilence();
    }, silenceMs);
  };

  function checkSilence(): void {
    if (!wantOpen || silenceMs <= 0) return;
    if (lastMessageAt !== 0 && now() - lastMessageAt < silenceMs) {
      armWatchdog();
      return;
    }
    // Silent for too long. The socket may still claim to be open; it is not
    // carrying data, which is the only thing that matters.
    teardownSocket();
    scheduleReconnect();
  }

  const teardownSocket = (): void => {
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
  };

  const scheduleReconnect = (): void => {
    if (!wantOpen) return;
    clearRetry();
    setStatus("reconnecting");
    const delay = backoffMs(attempt, 500, 30_000, rand);
    attempt++;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      open();
    }, delay);
  };

  function open(): void {
    if (!wantOpen) return;
    teardownSocket();
    setStatus(hadConnection ? "reconnecting" : "connecting");

    let sock: SocketLike;
    try {
      sock = socketFactory(url);
    } catch {
      // A factory that throws (bad URL, blocked scheme) must still retry rather
      // than leave the stream wedged in "connecting" for ever.
      scheduleReconnect();
      return;
    }
    socket = sock;

    sock.onopen = () => {
      if (socket !== sock) return; // superseded
      attempt = 0;
      lastMessageAt = now();
      setStatus("open");
      armWatchdog();
      if (hadConnection) {
        reconnects.update((n) => n + 1);
        cb.onResync?.();
      }
      hadConnection = true;
    };

    sock.onmessage = (ev) => {
      if (socket !== sock) return;
      lastMessageAt = now();
      let payload: unknown = ev.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return; // not JSON; nothing to do but ignore it
        }
      }
      const parsed = parse(payload);
      if (parsed !== null && parsed !== undefined) cb.onData(parsed);
    };

    sock.onerror = () => {
      if (socket !== sock) return;
      teardownSocket();
      scheduleReconnect();
    };

    sock.onclose = () => {
      if (socket !== sock) return;
      socket = null;
      if (wantOpen) scheduleReconnect();
      else setStatus("closed");
    };
  }

  return {
    status,
    reconnects,
    checkSilence,

    connect(nextUrl: string) {
      // A symbol change is a new stream, not a reconnect of the old one.
      const changed = nextUrl !== url;
      url = nextUrl;
      wantOpen = true;
      if (changed) {
        attempt = 0;
        hadConnection = false;
        lastMessageAt = 0;
      }
      clearRetry();
      open();
    },

    disconnect() {
      wantOpen = false;
      clearRetry();
      if (watchdog !== null) {
        clearTimeoutFn(watchdog);
        watchdog = null;
      }
      teardownSocket();
      hadConnection = false;
      lastMessageAt = 0;
      attempt = 0;
      setStatus("closed");
    },
  };
}

export interface Liquidation {
  time: number;
  symbol: string;
  /** The side of the ORDER that closed the position, per the exchange. */
  side: "buy" | "sell";
  price: number;
  quantity: number;
  /** Notional in quote currency. */
  value: number;
}

/**
 * Binance forced-order (liquidation) payload.
 *
 * NOTE ON SIDE, because it is the thing everyone gets backwards: the exchange
 * reports the side of the LIQUIDATION ORDER, not the side of the position that
 * blew up. A forced SELL closes a long. `side` here is kept as the exchange
 * reports it, and consumers label it, so the raw feed is never silently
 * reinterpreted at parse time.
 */
export function parseLiquidation(raw: unknown): Liquidation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  const body = (msg["data"] ?? msg) as Record<string, unknown>;
  const o = body["o"];
  if (typeof o !== "object" || o === null) return null;

  const order = o as Record<string, unknown>;
  const price = Number(order["ap"] ?? order["p"]);
  const quantity = Number(order["q"]);
  const time = Number(order["T"] ?? body["E"]);
  const symbol = String(order["s"] ?? "");
  const rawSide = String(order["S"] ?? "").toLowerCase();

  if (!symbol || !["buy", "sell"].includes(rawSide)) return null;
  if (![price, quantity, time].every(Number.isFinite)) return null;

  return {
    time,
    symbol,
    side: rawSide as "buy" | "sell",
    price,
    quantity,
    value: price * quantity,
  };
}

/** Which side of the book was wiped out by a forced order. */
export function liquidatedSide(side: "buy" | "sell"): "long" | "short" {
  // A forced SELL closes a LONG. A forced BUY closes a SHORT.
  return side === "sell" ? "long" : "short";
}

/** All-market forced orders. One socket covers every symbol. */
export const LIQUIDATION_STREAM = "wss://fstream.binance.com/ws/!forceOrder@arr";

/** Binance kline stream URL for a symbol/interval. */
export function binanceStreamUrl(symbol: string, interval: string): string {
  const s = symbol.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return `wss://stream.binance.com:9443/ws/${s}@kline_${interval}`;
}
