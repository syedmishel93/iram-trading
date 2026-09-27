// @vitest-environment jsdom
/**
 * Live bars routed through the gateway.
 *
 * THE TWO THINGS THAT MUST NOT BREAK
 *
 * 1. **A poll must not become a stream because of the pipe it arrived on.**
 *    The gateway exists partly to give socketless vendors a push, so a frame
 *    marked `poll` is the normal case for yfinance — and it reaches the browser
 *    over a WebSocket. A client that read "socket therefore live" would relabel
 *    a five-second poll as a live feed, which is precisely the class of lie the
 *    honesty contract is written against.
 *
 * 2. **An absent backend must not stall the chart.** Routing through the
 *    gateway is an optimisation. If it is switched on and the gateway is not
 *    running, the reconnect ladder would retry it with growing backoff while
 *    the price aged — so the feed falls back to the direct path instead, once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureBackend,
  gatewayStreamUrl,
  resetBackend,
  streamThroughBackend,
  useBackendStore,
} from "../src/data/backend";
import { parseGatewayFrame, parseLiveFrame } from "../src/data/stream";
import { memoryRawStore } from "../src/store/kv";

beforeEach(() => {
  useBackendStore(memoryRawStore());
  resetBackend(false);
});

describe("the backend stream setting", () => {
  it("is off unless asked for", () => {
    // Turning it on makes the chart's liveness depend on a second process.
    // That is the operator's call, not a default.
    expect(streamThroughBackend()).toBe(false);
  });

  it("turns on and persists", () => {
    const store = memoryRawStore();
    useBackendStore(store);
    configureBackend({ stream: true }, true);
    expect(streamThroughBackend()).toBe(true);
    expect(useBackendStore(store).stream).toBe(true);
  });

  it("builds a socket url on the configured gateway", () => {
    configureBackend({ base: "http://127.0.0.1:8787" }, false);
    expect(gatewayStreamUrl("BTCUSDT", "1m")).toBe(
      "ws://127.0.0.1:8787/ws/bars?symbol=BTCUSDT&timeframe=1m",
    );
  });

  it("upgrades to wss when the gateway is behind TLS", () => {
    configureBackend({ base: "https://desk.example" }, false);
    expect(gatewayStreamUrl("EURUSD", "1h")).toMatch(/^wss:\/\//);
    expect(gatewayStreamUrl("EURUSD", "1h")).toContain("wss://desk.example/ws/bars");
  });

  it("encodes a symbol that needs it, rather than splicing it into a url", () => {
    const url = gatewayStreamUrl("BTC/USD", "1m");
    expect(url).toContain("symbol=BTC%2FUSD");
  });
});

describe("gateway frames", () => {
  const barFrame = (extra: Record<string, unknown> = {}) => ({
    type: "bar",
    symbol: "BTCUSDT",
    timeframe: "1m",
    transport: "stream",
    poll_every_ms: 0,
    bar: { t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, closed: false },
    ...extra,
  });

  it("reads a streamed bar", () => {
    const frame = parseGatewayFrame(barFrame());
    expect(frame).toEqual({
      bar: { t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      closed: false,
      transport: "stream",
      pollEveryMs: 0,
    });
  });

  it("carries `poll` through untouched, with its cadence", () => {
    // The whole point. This bar came from a vendor with no socket.
    const frame = parseGatewayFrame(
      barFrame({ transport: "poll", poll_every_ms: 5000 }),
    );
    expect(frame?.transport).toBe("poll");
    expect(frame?.pollEveryMs).toBe(5000);
  });

  it("marks a closed bar closed", () => {
    const frame = parseGatewayFrame(
      barFrame({ bar: { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, closed: true } }),
    );
    expect(frame?.closed).toBe(true);
  });

  it("ignores hello and error frames — neither carries a bar", () => {
    expect(parseGatewayFrame({ type: "hello", transport: "stream", sharing: 3 })).toBeNull();
    // An upstream failure leaves the last bar standing and lets the staleness
    // classifier age it. Nothing is synthesised to keep the chart moving.
    expect(parseGatewayFrame({ type: "error", error: "binance closed" })).toBeNull();
  });

  it("refuses a frame with a NaN in it", () => {
    expect(
      parseGatewayFrame(barFrame({ bar: { t: 1, o: 1, h: 1, l: 1, c: "oops", v: 1 } })),
    ).toBeNull();
    // A NaN reaching the series blanks the price scale, so it is dropped here.
  });

  it("defaults an unlabelled transport to stream rather than guessing poll", () => {
    const frame = parseGatewayFrame(barFrame({ transport: undefined }));
    expect(frame?.transport).toBe("stream");
  });
});

describe("the combined parser", () => {
  it("routes a gateway frame by its `type`", () => {
    const frame = parseLiveFrame({
      type: "bar",
      transport: "poll",
      poll_every_ms: 30000,
      bar: { t: 5, o: 1, h: 1, l: 1, c: 1, v: 1, closed: true },
    });
    expect(frame?.transport).toBe("poll");
    expect(frame?.closed).toBe(true);
  });

  it("still reads a raw Binance kline, so the direct path is unaffected", () => {
    const frame = parseLiveFrame({
      e: "kline",
      k: { t: 7, o: "1", h: "2", l: "0.5", c: "1.5", v: "9", x: true },
    });
    expect(frame?.bar.t).toBe(7);
    expect(frame?.closed).toBe(true);
    // No transport field: a direct vendor socket is a stream by construction,
    // and the feed leaves its own transport signal alone for these.
    expect(frame?.transport).toBeUndefined();
  });

  it("returns null for anything else", () => {
    expect(parseLiveFrame(null)).toBeNull();
    expect(parseLiveFrame("not a frame")).toBeNull();
    expect(parseLiveFrame({ nothing: true })).toBeNull();
  });
});

describe("feed transport, end to end", () => {
  /** A socket we drive by hand. */
  function fakeSocket() {
    const sockets: Array<{
      url: string;
      onopen: ((e: unknown) => void) | null;
      onclose: ((e: unknown) => void) | null;
      onerror: ((e: unknown) => void) | null;
      onmessage: ((e: { data: unknown }) => void) | null;
      close(): void;
    }> = [];
    const factory = (url: string) => {
      const s = {
        url,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close() {
          /* driven by the test */
        },
      };
      sockets.push(s);
      return s;
    };
    return { sockets, factory };
  }

  it("reports `poll` when the gateway says the upstream is polled", async () => {
    const { sockets, factory } = fakeSocket();
    configureBackend({ stream: true }, false);

    const { createFeed } = await import("../src/data/feed");
    const feed = createFeed({
      stream: { socketFactory: factory, parse: parseLiveFrame, silenceMs: 0 },
    });

    feed.startLive("AAPL", "1h");
    const socket = sockets[0];
    expect(socket?.url).toContain("/ws/bars");
    expect(socket?.url).toContain("symbol=AAPL");

    socket?.onopen?.({});
    // The feed is optimistic until the first frame; the frame is what decides.
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "bar",
        transport: "poll",
        poll_every_ms: 30000,
        bar: { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, closed: false },
      }),
    });

    expect(feed.transport()).toBe("poll");
    expect(feed.pollEveryMs()).toBe(30000);
    feed.dispose();
  });

  it("does not route through the gateway while the setting is off", async () => {
    const { sockets, factory } = fakeSocket();
    // Default: off.
    const { createFeed } = await import("../src/data/feed");
    const feed = createFeed({
      stream: { socketFactory: factory, parse: parseLiveFrame, silenceMs: 0 },
    });

    feed.startLive("BTCUSDT", "1m");
    // Whatever it connected to, it is not the gateway.
    for (const s of sockets) expect(s.url).not.toContain("/ws/bars");
    feed.dispose();
  });
});
