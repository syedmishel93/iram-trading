"""
Live bars over WebSocket, fanned out from one upstream connection.

WHAT IT ADDS — AND WHAT WAS ALREADY THERE
The terminal is not naive about this and it would be wrong to imply otherwise.
`data/stream.ts` is already a proper WebSocket client with a silence watchdog,
jittered backoff and a `resynced` signal, and `data/feed.ts` already
distinguishes a `socket` transport from a `poll` one and labels which is in use.
Crypto has been genuinely streamed for a while.

Two things it could not do, both of which are what this is for.

**One vendor connection instead of one per tab.** Each browser context opens its
own socket straight to Binance, so four charts on BTCUSDT is four subscriptions
to the same stream, and a watchlist multiplies it again. Here one upstream per
(symbol, timeframe) serves every client that asks; the tenth chart costs an
entry in a set. Measured: 7 viewers across 2 symbols, 2 upstream connections.

**A socket for sources that do not have one.** yfinance, Twelve Data and Polygon
publish no browser-reachable socket on a free tier, so those symbols have always
polled — once per tab. The gateway polls once for everyone and pushes the
result, so a socketless vendor reaches the browser over a socket. It is still a
poll upstream, and saying so is the point below.

THE DIFFERENCE IS ALWAYS STATED
Every frame carries `transport: "stream" | "poll"`, matching the distinction
`feed.ts` already draws, so wrapping a poll in a WebSocket cannot launder it
into looking live. A polled feed dressed as a streamed one is identical on a
chart right up until the moment the difference matters, and `mishel_service`'s
dead-man's switch exists because silence and "no setups" are indistinguishable.

WHAT IT DOES NOT DO
It does not invent the current bar. If the upstream is quiet, the last frame
stands and `age_s` grows; nothing here interpolates a candle to keep the screen
moving. `data/feed.ts` already refuses to fall back to generated data, and a
socket is not a licence to do it at a different layer.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Literal

#: Binance's kline intervals happen to be exactly the terminal's `TIMEFRAMES`
#: (`ui/shell.ts`), including `1M` for a month. No mapping table, and none of the
#: quiet corruption a mapping table causes when one side gains an interval.
BINANCE_INTERVALS = frozenset({"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"})

BINANCE_WS = "wss://stream.binance.com:9443/ws"

#: How long an upstream with no clients is kept before it is dropped. Switching
#: timeframe and switching back is one click, and tearing the socket down in
#: between costs a reconnect and a fresh snapshot for no reason.
LINGER_S = 30.0

#: Polled sources are asked at the rate the bar actually changes, floored so a
#: 1m chart cannot spend a rate limit. Streamed sources ignore this entirely.
POLL_FLOOR_S = 5.0

Transport = Literal["stream", "poll"]


def _is_streamable(symbol: str, timeframe: str) -> bool:
    """True when Binance will push this pair, so it need not be polled."""
    s = symbol.upper()
    return timeframe in BINANCE_INTERVALS and s.endswith(("USDT", "USDC", "BTC"))


def _tf_seconds(tf: str) -> float:
    units = {"m": 60, "h": 3600, "d": 86400, "w": 604800, "M": 2592000}
    try:
        return float(tf[:-1]) * units[tf[-1]]
    except (KeyError, ValueError):
        return 60.0


@dataclass
class Bar:
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float
    closed: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {"t": self.t, "o": self.o, "h": self.h, "l": self.l, "c": self.c, "v": self.v, "closed": self.closed}


@dataclass
class Stream:
    """One upstream subscription and the clients sharing it."""

    symbol: str
    timeframe: str
    transport: Transport
    clients: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    last: Bar | None = None
    last_at: float = 0.0
    #: Upstream poll cadence in ms, 0 for a genuine socket.
    #:
    #: Sent with every frame so the terminal can report the real cadence rather
    #: than infer one. `feed.ts` shows "poll every Ns" in its diagnostics, and a
    #: number it guessed about someone else's timer is worse than no number.
    poll_every_ms: int = 0
    error: str | None = None
    task: asyncio.Task[None] | None = None
    #: Set when the last client leaves; the upstream closes if it is still set
    #: after `LINGER_S`.
    idle_since: float | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.symbol, self.timeframe)

    def publish(self, bar: Bar) -> None:
        self.last = bar
        self.last_at = time.time()
        self.error = None
        frame = {
            "type": "bar",
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "transport": self.transport,
            "poll_every_ms": self.poll_every_ms,
            "bar": bar.as_dict(),
        }
        self._fan(frame)

    def fail(self, message: str) -> None:
        """An upstream problem is broadcast, not hidden behind a stale bar."""
        self.error = message
        self._fan(
            {
                "type": "error",
                "symbol": self.symbol,
                "timeframe": self.timeframe,
                "transport": self.transport,
                "error": message,
                "age_s": round(time.time() - self.last_at, 1) if self.last_at else None,
            }
        )

    def _fan(self, frame: dict[str, Any]) -> None:
        for q in list(self.clients):
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                # A client that cannot keep up is dropped from this frame, not
                # disconnected: a stalled tab must not slow the other nine.
                pass

    def status(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "transport": self.transport,
            "clients": len(self.clients),
            "last_bar_t": self.last.t if self.last else None,
            "poll_every_ms": self.poll_every_ms,
            "age_s": round(time.time() - self.last_at, 1) if self.last_at else None,
            "error": self.error,
        }


#: Fetches recent bars for the polled path and for every snapshot.
#: Supplied by `app.py` so this module never learns which vendor answered.
FetchBars = Any  # Callable[[str, str, int], Awaitable[tuple[list[Bar], str]]]


class Hub:
    """Owns every upstream subscription and the clients attached to them."""

    def __init__(self, fetch: FetchBars) -> None:
        self.fetch = fetch
        self.streams: dict[tuple[str, str], Stream] = {}
        self._lock = asyncio.Lock()

    async def join(self, symbol: str, timeframe: str) -> tuple[Stream, asyncio.Queue[dict[str, Any]]]:
        key = (symbol.upper(), timeframe)
        async with self._lock:
            stream = self.streams.get(key)
            if stream is None:
                transport: Transport = "stream" if _is_streamable(*key) else "poll"
                stream = Stream(symbol=key[0], timeframe=key[1], transport=transport)
                self.streams[key] = stream
                stream.task = asyncio.create_task(self._run(stream), name=f"upstream-{key[0]}-{key[1]}")
            # A queue deep enough to absorb a burst, shallow enough that a stuck
            # client is dropping frames rather than banking megabytes of them.
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
            stream.clients.add(queue)
            stream.idle_since = None
            return stream, queue

    async def leave(self, stream: Stream, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            stream.clients.discard(queue)
            if not stream.clients:
                stream.idle_since = time.time()

    async def _run(self, stream: Stream) -> None:
        """The upstream loop, with reconnect backoff and idle shutdown."""
        backoff = 1.0
        try:
            while True:
                if stream.idle_since is not None and time.time() - stream.idle_since > LINGER_S:
                    break
                try:
                    if stream.transport == "stream":
                        await self._binance(stream)
                    else:
                        await self._poll(stream)
                    backoff = 1.0
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — an upstream fault must not kill the hub
                    stream.fail(f"{type(exc).__name__}: {exc}")
                    await asyncio.sleep(backoff)
                    # Capped exponential backoff: a vendor that is down should
                    # not be hammered, and one that blipped should recover fast.
                    backoff = min(backoff * 2, 30.0)
        finally:
            async with self._lock:
                self.streams.pop(stream.key, None)

    async def _binance(self, stream: Stream) -> None:
        """Binance's keyless kline socket. Runs until it drops or goes idle."""
        import websockets

        url = f"{BINANCE_WS}/{stream.symbol.lower()}@kline_{stream.timeframe}"
        async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
            while True:
                if stream.idle_since is not None and time.time() - stream.idle_since > LINGER_S:
                    return
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=LINGER_S)
                except TimeoutError:
                    # Not an error: an illiquid pair can be quiet for a minute.
                    # Loop back so the idle check gets a chance to run.
                    continue
                payload = json.loads(raw)
                k = payload.get("k")
                if not k:
                    continue
                stream.publish(
                    Bar(
                        t=int(k["t"]),
                        o=float(k["o"]),
                        h=float(k["h"]),
                        l=float(k["l"]),
                        c=float(k["c"]),
                        v=float(k["v"]),
                        closed=bool(k.get("x")),
                    )
                )

    async def _poll(self, stream: Stream) -> None:
        """One poll cycle for sources with no socket, shared by every client."""
        interval = max(POLL_FLOOR_S, _tf_seconds(stream.timeframe) / 4)
        stream.poll_every_ms = int(interval * 1000)
        while True:
            if stream.idle_since is not None and time.time() - stream.idle_since > LINGER_S:
                return
            bars, _source = await self.fetch(stream.symbol, stream.timeframe, 2)
            if bars:
                stream.publish(bars[-1])
            await asyncio.sleep(interval)

    def status(self) -> dict[str, Any]:
        streams = [s.status() for s in self.streams.values()]
        return {
            "streams": streams,
            "upstreams": len(streams),
            "clients": sum(s["clients"] for s in streams),
            # The whole point, in one number: how many vendor connections the
            # polling design would have needed for the same set of viewers.
            "saved_connections": max(0, sum(s["clients"] for s in streams) - len(streams)),
        }
