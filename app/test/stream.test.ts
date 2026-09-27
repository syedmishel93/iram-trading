import { describe, it, expect, vi } from "vitest";
import {
  backoffMs,
  parseBinanceKline,
  parseLiquidation,
  liquidatedSide,
  createStream,
  binanceStreamUrl,
  type SocketLike,
} from "../src/data/stream";
import type { BarView } from "../src/chart/series";

/** A controllable stand-in for WebSocket. */
class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  // --- test drivers
  open(): void {
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  error(): void {
    this.onerror?.({});
  }
  serverClose(): void {
    this.onclose?.({});
  }
}

/** A deterministic clock + timer queue. */
function harness() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];

  return {
    sockets,
    now: () => time,
    setTimeoutFn: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimeoutFn: (id: number): void => {
      timers.delete(id);
    },
    socketFactory: (): SocketLike => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    rand: () => 1, // no jitter reduction, so delays are exactly the cap
    /** Advance the clock, firing any timers that come due. */
    advance(ms: number): void {
      const target = time + ms;
      let guard = 0;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        if (++guard > 1000) throw new Error("timer storm");
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
    get pending(): number {
      return timers.size;
    },
  };
}

describe("backoffMs", () => {
  it("grows exponentially from the base", () => {
    const noJitter = () => 1;
    expect(backoffMs(0, 500, 30_000, noJitter)).toBe(500);
    expect(backoffMs(1, 500, 30_000, noJitter)).toBe(1000);
    expect(backoffMs(2, 500, 30_000, noJitter)).toBe(2000);
    expect(backoffMs(3, 500, 30_000, noJitter)).toBe(4000);
  });

  it("caps so a long outage does not schedule a retry hours away", () => {
    const noJitter = () => 1;
    expect(backoffMs(20, 500, 30_000, noJitter)).toBe(30_000);
    expect(backoffMs(50, 500, 30_000, noJitter)).toBe(30_000);
  });

  it("applies jitter in [0.5, 1.0] of the exponential value", () => {
    // Without jitter every client that dropped on the same vendor blip
    // reconnects on exactly the same schedule, for ever.
    expect(backoffMs(3, 500, 30_000, () => 0)).toBe(2000);
    expect(backoffMs(3, 500, 30_000, () => 1)).toBe(4000);
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(4, 500, 30_000, Math.random);
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(8000);
    }
  });
});

describe("parseBinanceKline", () => {
  const kline = (over: Record<string, unknown> = {}) => ({
    e: "kline",
    k: { t: 1_700_000_000_000, o: "100.5", h: "101", l: "99", c: "100.75", v: "12.5", x: false, ...over },
  });

  it("parses a raw kline payload", () => {
    const out = parseBinanceKline(kline());
    expect(out?.bar).toEqual({ t: 1_700_000_000_000, o: 100.5, h: 101, l: 99, c: 100.75, v: 12.5 });
    expect(out?.closed).toBe(false);
  });

  it("unwraps a combined-stream envelope", () => {
    expect(parseBinanceKline({ stream: "btcusdt@kline_1h", data: kline() })?.bar.c).toBe(100.75);
  });

  it("reports the closed flag", () => {
    expect(parseBinanceKline(kline({ x: true }))?.closed).toBe(true);
  });

  it("rejects a malformed payload rather than emitting NaN", () => {
    // A NaN reaching the series blanks the entire price scale.
    expect(parseBinanceKline(kline({ c: "not-a-number" }))).toBeNull();
    expect(parseBinanceKline(kline({ t: undefined }))).toBeNull();
    expect(parseBinanceKline({ e: "kline" })).toBeNull();
    expect(parseBinanceKline(null)).toBeNull();
    expect(parseBinanceKline("garbage")).toBeNull();
  });
});

describe("parseLiquidation", () => {
  const forced = (over: Record<string, unknown> = {}) => ({
    e: "forceOrder",
    E: 1_700_000_000_000,
    o: { s: "BTCUSDT", S: "SELL", ap: "64000.5", q: "1.25", T: 1_700_000_000_500, ...over },
  });

  it("parses a forced order into a liquidation", () => {
    const l = parseLiquidation(forced());
    expect(l?.symbol).toBe("BTCUSDT");
    expect(l?.side).toBe("sell");
    expect(l?.price).toBe(64000.5);
    expect(l?.value).toBeCloseTo(64000.5 * 1.25, 6);
  });

  it("keeps the exchange side verbatim, and maps it separately", () => {
    // Everyone gets this backwards: the exchange reports the side of the
    // liquidation ORDER, not the position that blew up. A forced SELL closes a
    // LONG. Reinterpreting at parse time would make the raw feed a lie.
    expect(liquidatedSide("sell")).toBe("long");
    expect(liquidatedSide("buy")).toBe("short");
    expect(parseLiquidation(forced({ S: "BUY" }))?.side).toBe("buy");
  });

  it("unwraps a combined-stream envelope", () => {
    expect(parseLiquidation({ stream: "!forceOrder@arr", data: forced() })?.symbol).toBe("BTCUSDT");
  });

  it("rejects malformed payloads rather than emitting NaN", () => {
    expect(parseLiquidation(forced({ ap: "nope" }))).toBeNull();
    expect(parseLiquidation(forced({ S: "" }))).toBeNull();
    expect(parseLiquidation({ e: "forceOrder" })).toBeNull();
    expect(parseLiquidation(null)).toBeNull();
  });
});

describe("stream is transport-generic", () => {
  it("drives any parse function through the same reconnect ladder", () => {
    // The refactor's whole point: klines and liquidations must not each carry
    // their own copy of the backoff and watchdog logic.
    const h = harness();
    const seen: string[] = [];
    const stream = createStream<string>(
      { onData: (v) => seen.push(v) },
      {
        parse: (raw) => (raw as { tag?: string }).tag ?? null,
        silenceMs: 10_000,
        socketFactory: h.socketFactory,
        now: h.now,
        setTimeoutFn: h.setTimeoutFn,
        clearTimeoutFn: h.clearTimeoutFn,
        rand: h.rand,
      },
    );
    stream.connect("wss://x");
    h.sockets[0]?.open();
    h.sockets[0]?.message(JSON.stringify({ tag: "hello" }));
    h.sockets[0]?.message(JSON.stringify({ nope: 1 }));
    expect(seen).toEqual(["hello"]);

    h.sockets[0]?.serverClose();
    h.advance(500);
    expect(h.sockets.length).toBe(2);
  });
});

describe("binanceStreamUrl", () => {
  it("lowercases and strips separators", () => {
    expect(binanceStreamUrl("BTC/USDT", "1h")).toBe("wss://stream.binance.com:9443/ws/btcusdt@kline_1h");
  });
});

describe("stream lifecycle", () => {
  const mk = (h: ReturnType<typeof harness>, onBar = vi.fn(), onResync = vi.fn()) => {
    const s = createStream(
      { onData: ({ bar }) => onBar(bar), onResync },
      {
        silenceMs: 10_000,
        socketFactory: h.socketFactory,
        now: h.now,
        setTimeoutFn: h.setTimeoutFn,
        clearTimeoutFn: h.clearTimeoutFn,
        rand: h.rand,
      },
    );
    return { stream: s, onBar, onResync };
  };

  it("reports open and delivers bars", () => {
    const h = harness();
    const { stream, onBar } = mk(h);
    stream.connect("wss://x");
    expect(stream.status()).toBe("connecting");

    h.sockets[0]?.open();
    expect(stream.status()).toBe("open");

    h.sockets[0]?.message(
      JSON.stringify({ k: { t: 1, o: "1", h: "2", l: "0.5", c: "1.5", v: "3", x: false } }),
    );
    expect(onBar).toHaveBeenCalledTimes(1);
    expect((onBar.mock.calls[0]?.[0] as BarView).c).toBe(1.5);
  });

  it("ignores a message that is not JSON instead of throwing", () => {
    const h = harness();
    const { stream, onBar } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();
    h.sockets[0]?.message("<html>proxy error</html>");
    expect(onBar).not.toHaveBeenCalled();
    expect(stream.status()).toBe("open");
  });

  it("reconnects with backoff after the server closes", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();

    h.sockets[0]?.serverClose();
    expect(stream.status()).toBe("reconnecting");
    expect(h.sockets.length).toBe(1);

    h.advance(499);
    expect(h.sockets.length).toBe(1); // not yet
    h.advance(2);
    expect(h.sockets.length).toBe(2); // retry fired at 500ms
  });

  it("escalates the delay across consecutive failures", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open(); // establishes a baseline connection

    h.sockets[0]?.serverClose();
    h.advance(500);
    expect(h.sockets.length).toBe(2);

    // Second failure without a successful open -> attempt counter keeps rising.
    h.sockets[1]?.serverClose();
    h.advance(999);
    expect(h.sockets.length).toBe(2);
    h.advance(2);
    expect(h.sockets.length).toBe(3);
  });

  it("resets the ladder after a successful reconnect", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();

    h.sockets[0]?.serverClose();
    h.advance(500);
    h.sockets[1]?.open(); // success -> attempt back to 0

    h.sockets[1]?.serverClose();
    h.advance(501);
    expect(h.sockets.length).toBe(3); // 500ms again, not 1000ms
  });

  it("treats a silent-but-open socket as a failure", () => {
    // The whole point: TCP will hold a connection open long after the far end
    // stopped sending. readyState===OPEN is not evidence of a live feed.
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();
    expect(stream.status()).toBe("open");

    h.advance(10_001); // silence past the watchdog window
    expect(h.sockets[0]?.closed).toBe(true);
    expect(stream.status()).toBe("reconnecting");
  });

  it("does NOT reconnect a silent socket when the watchdog is disabled", () => {
    // Sparse event streams (liquidations) are silent by nature. Treating that
    // as failure churns against the vendor and makes a healthy feed look broken.
    const h = harness();
    const stream = createStream<string>(
      { onData: vi.fn() },
      {
        parse: () => null,
        silenceMs: 0,
        socketFactory: h.socketFactory,
        now: h.now,
        setTimeoutFn: h.setTimeoutFn,
        clearTimeoutFn: h.clearTimeoutFn,
        rand: h.rand,
      },
    );
    stream.connect("wss://x");
    h.sockets[0]?.open();

    h.advance(30 * 60_000); // half an hour of silence
    expect(stream.status()).toBe("open");
    expect(h.sockets.length).toBe(1);
    expect(h.sockets[0]?.closed).toBe(false);
  });

  it("still reconnects a disabled-watchdog stream when the socket actually drops", () => {
    // Disabling the watchdog must not disable reconnection itself.
    const h = harness();
    const stream = createStream<string>(
      { onData: vi.fn() },
      {
        parse: () => null,
        silenceMs: 0,
        socketFactory: h.socketFactory,
        now: h.now,
        setTimeoutFn: h.setTimeoutFn,
        clearTimeoutFn: h.clearTimeoutFn,
        rand: h.rand,
      },
    );
    stream.connect("wss://x");
    h.sockets[0]?.open();
    h.sockets[0]?.serverClose();
    h.advance(500);
    expect(h.sockets.length).toBe(2);
  });

  it("keeps the connection while messages keep arriving", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();

    for (let i = 0; i < 5; i++) {
      h.advance(6_000);
      h.sockets[0]?.message(JSON.stringify({ k: { t: i, o: "1", h: "1", l: "1", c: "1", v: "1" } }));
    }
    expect(stream.status()).toBe("open");
    expect(h.sockets.length).toBe(1);
  });

  it("signals resync on reconnect, never on the first connect", () => {
    // Bars that closed during the outage were never sent. Splicing the hole
    // shut and calling it continuous would be a lie about the data.
    const h = harness();
    const { stream, onResync } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();
    expect(onResync).not.toHaveBeenCalled();

    h.sockets[0]?.serverClose();
    h.advance(500);
    h.sockets[1]?.open();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(stream.reconnects()).toBe(1);
  });

  it("retries when the socket factory itself throws", () => {
    let calls = 0;
    const h = harness();
    const stream = createStream(
      { onData: vi.fn() },
      {
        silenceMs: 10_000,
        socketFactory: () => {
          calls++;
          throw new Error("blocked scheme");
        },
        now: h.now,
        setTimeoutFn: h.setTimeoutFn,
        clearTimeoutFn: h.clearTimeoutFn,
        rand: h.rand,
      },
    );
    stream.connect("wss://x");
    expect(calls).toBe(1);
    expect(stream.status()).toBe("reconnecting");
    h.advance(500);
    expect(calls).toBe(2);
  });

  it("disconnect stops everything and schedules nothing further", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();
    h.sockets[0]?.serverClose();
    expect(stream.status()).toBe("reconnecting");

    stream.disconnect();
    expect(stream.status()).toBe("closed");
    h.advance(60_000);
    expect(h.sockets.length).toBe(1);
    expect(h.pending).toBe(0);
  });

  it("does not reconnect after an intentional disconnect", () => {
    const h = harness();
    const { stream } = mk(h);
    stream.connect("wss://x");
    h.sockets[0]?.open();
    stream.disconnect();
    h.sockets[0]?.serverClose(); // late event from the closing socket
    h.advance(60_000);
    expect(h.sockets.length).toBe(1);
  });

  it("treats a symbol change as a new stream, not a reconnect", () => {
    const h = harness();
    const { stream, onResync } = mk(h);
    stream.connect("wss://a");
    h.sockets[0]?.open();

    stream.connect("wss://b");
    expect(h.sockets.length).toBe(2);
    h.sockets[1]?.open();
    expect(onResync).not.toHaveBeenCalled(); // new stream, nothing to resync
  });

  it("ignores events from a socket that has been superseded", () => {
    const h = harness();
    const { stream, onBar } = mk(h);
    stream.connect("wss://a");
    const stale = h.sockets[0];
    stale?.open();

    stream.connect("wss://b");
    h.sockets[1]?.open();

    stale?.message(JSON.stringify({ k: { t: 1, o: "9", h: "9", l: "9", c: "9", v: "1" } }));
    expect(onBar).not.toHaveBeenCalled();
    expect(stream.status()).toBe("open");
  });
});
