"""
The gateway: one FastAPI application in front of the whole backend.

    :8787  /ohlc /quote /fetch /providers /health /ai /mt5/*   data proxy
           /svc/*                                             service + store
           /quant/*                                           model service
           /api/*                                             gateway-native
           /ws/*                                              streaming
           /docs                                              OpenAPI

Three processes became one. What that buys, in the order it matters:

  * **One CORS policy.** Below, once, auditable. Not three `CORS(app)` calls in
    three files with three different ideas of who may call them.
  * **One bind decision.** `mishel_service` fails closed off loopback and
    `quant/app` refuses to bind off it; the data proxy did neither. Consolidated,
    the strictest rule covers every endpoint by construction.
  * **One base URL for the terminal.** `data/*.ts` currently hardcodes
    `127.0.0.1:8787` for bars and `127.0.0.1:8788` for everything else, so half
    the desks go dark on their own if one process is missing — the nine
    `ERR_CONNECTION_REFUSED` a fresh checkout logs on first run.
  * **Somewhere for async to live.** WebSockets and the intelligence lab are
    native FastAPI here; the Flask routes are untouched next to them and get
    ported one at a time, or never.
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator, MutableMapping
from contextlib import asynccontextmanager
from typing import Any

from anyio import CapacityLimiter
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.routing import Mount

from . import legacy
from .background import loops
from .config import LOOPBACK_ORIGIN_REGEX, settings
from .lab import BatchRequest, Lab, StudyRequest
from .stream import Bar, Hub
from .terminal import mount_terminal

VERSION = "51.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    limiter = CapacityLimiter(settings.wsgi_workers)
    services = legacy.load(limiter)
    app.state.services = services
    app.state.dispatch = legacy.LegacyDispatch(services)
    app.state.hub = Hub(fetch_bars)
    app.state.lab = Lab(fetch_bar_dicts)

    for svc in services:
        if svc.ok:
            print(f"  [ok]   {svc.name:6s} {'  '.join(svc.prefixes)}")
        else:
            print(f"  [DOWN] {svc.name:6s} {svc.error}", file=sys.stderr)
            print(f"         without it: {svc.provides}", file=sys.stderr)

    svc_module = sys.modules.get("mishel_service")
    if settings.background and svc_module is not None:
        loops.start(svc_module)
        print(f"  [ok]   loops  {len(loops.statuses)} background loops started")
    elif settings.background:
        print("  [DOWN] loops  mishel_service did not import", file=sys.stderr)
    else:
        print("  [--]   loops  off (IRAM_BACKGROUND=1 to enable)")

    yield

    for stream in list(app.state.hub.streams.values()):
        if stream.task is not None:
            stream.task.cancel()


app = FastAPI(
    title="IRAM Trading Gateway",
    version=VERSION,
    summary="One backend for the terminal: data proxy, service store, model service, streaming.",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/api/openapi.json",
)


# --------------------------------------------------------- compression ------
#
# The terminal is 1.1 MB of HTML with its script, styles and two fonts inlined,
# and it was going over the wire uncompressed — the whole megabyte, every load.
# It is text, so it compresses to roughly a fifth of that.
#
# Added BEFORE the CORS middleware so it sits OUTSIDE it in the stack: CORS must
# see the request first to answer a preflight without the body ever being built,
# and compression must see the response last, once there is one to compress.
#
# `minimum_size` keeps it off the small JSON the desks poll — a 200-byte health
# response gains nothing from a gzip header and a compression pass, and the
# desks make far more of those calls than there are page loads.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ---------------------------------------------------------------- CORS ------
#
# THE ONE PLACE CROSS-ORIGIN IS DECIDED.
#
# It is middleware rather than per-router because it must also cover the mounted
# Flask apps, and middleware runs before routing — a policy attached to the
# FastAPI routers only would leave `/svc/*` and `/quant/*` outside it.
#
# `allow_credentials` is False, deliberately, and that is what lets the origin
# list stay honest. The moment it is True the CORS specification forbids a
# wildcard and browsers reject `*` outright, which is how backends end up
# reflecting whatever Origin they were sent — a policy that permits everyone
# while looking like a policy. Nothing here needs it: `mishel_service`
# authenticates with an `X-Mishel-Token` header, not a cookie, and a header
# is not attached by the browser to a cross-site request on its own.
#
# `allow_origin_regex` covers loopback on any port because the terminal is
# served from :8000 (`run.py`), :5173 (Vite) and :4173 (`vite preview`), and
# operators choose their own. It is not a wildcard: a page on the public
# internet cannot present a `http://localhost:...` origin.
#
# The explicit list adds what a regex cannot express — `null`, which is the
# Origin a `file://` page sends, and this product's headline mode is a
# single `index.html` opened by double-click.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_origin_regex=LOOPBACK_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # `X-Mishel-Token` is the service's auth header; a preflight that does not
    # list it fails before the request is made.
    allow_headers=["Content-Type", "X-Mishel-Token", "Authorization", "X-Requested-With"],
    # Without this the browser can read neither, and both are what the terminal
    # uses to tell a served-from-cache answer from a fresh vendor call.
    expose_headers=["X-Iram-Source", "X-Iram-Cached", "Content-Length"],
    max_age=3600,
)


# ------------------------------------------------------------ native api ----

@app.get("/api/health", tags=["gateway"])
async def health() -> dict[str, Any]:
    """One call that answers "is the backend up", for all of it.

    The terminal previously had to probe three ports and guess what a refused
    connection on one of them meant for the others.
    """
    services = getattr(app.state, "services", ())
    return {
        "ok": all(s.ok for s in services),
        "version": VERSION,
        "host": f"{settings.host}:{settings.port}",
        "services": {
            s.name: {
                "ok": s.ok,
                "prefixes": list(s.prefixes),
                "error": s.error,
                "provides": s.provides,
            }
            for s in services
        },
        "background": loops.report(),
    }


@app.get("/api/routes", tags=["gateway"])
async def routes() -> dict[str, Any]:
    """Every URL this process answers, and which service owns it.

    Three services' worth of endpoints had no single inventory; this is it.
    """
    out: dict[str, list[str]] = {}
    for svc in getattr(app.state, "services", ()):
        module = sys.modules.get(svc.module)
        rules = sorted(
            str(r.rule)
            for r in (module.app.url_map.iter_rules() if module else [])
            if not str(r.rule).startswith("/static")
        )
        out[svc.name] = rules
    # `getattr(r, "path", "")` already proves the attribute is there, but the
    # guard and the use are separate expressions so mypy cannot connect them --
    # `BaseRoute` genuinely has no `path`; `Route` and `Mount` do. Read through
    # getattr in BOTH places rather than annotating a cast: one expression, and
    # a route type without a path is skipped instead of crashing the listing.
    out["gateway"] = sorted(
        p for r in app.routes
        if (p := str(getattr(r, "path", ""))).startswith(("/api", "/ws"))
    )
    return {"routes": out, "total": sum(len(v) for v in out.values())}


# ------------------------------------------------------------ streaming -----
#
# The polled path reaches the vendors by calling THIS APPLICATION'S own `/ohlc`
# over an in-process ASGI transport — no socket, no second copy of the provider
# table. `ddt_data_server.py` already knows how to normalise a symbol for six
# vendors, rank them, and fall back when one is down; a streaming layer that
# reimplemented any of that would be a second answer to "what is the price",
# and the two would diverge on exactly the day a vendor changed something.

async def fetch_bars(
    symbol: str, timeframe: str, limit: int = 2, provider: str = "yfinance"
) -> tuple[list[Bar], str]:
    """Recent bars for `symbol`, via the data proxy, in-process.

    THE PROVIDER IS THE CALLER'S TO NAME, AND THAT IS DELIBERATE.
    An earlier version of this function guessed it from the symbol — Binance for
    anything ending `USDT`, yfinance otherwise — which was wrong in a way worth
    recording, because it looked reasonable and failed everywhere at once.
    Each provider function in `ddt_data_server.py` takes the TERMINAL'S symbol
    (`BTCUSD`) and translates to its own vendor dialect internally: `p_binance`
    maps `BTCUSD` to `BTCUSDT`, `p_yfinance` maps it to `BTC-USD`. A guess based
    on the `USDT` suffix is therefore reading the vendor's dialect to choose the
    vendor, and passing on a symbol the proxy rejects — `binance: crypto only`,
    on every request.

    The dialect table lives in the proxy. Nothing here gets a second copy of it.
    """
    import httpx

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://gateway") as client:
        response = await client.get(
            "/ohlc",
            params={"provider": provider, "symbol": symbol, "interval": timeframe, "limit": limit},
            timeout=60.0,
        )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    bars = [
        Bar(t=int(b["t"]), o=float(b["o"]), h=float(b["h"]), l=float(b["l"]), c=float(b["c"]), v=float(b.get("v") or 0.0))
        for b in payload.get("bars", [])
    ]
    if bars:
        # Only the newest bar of a polled source is still forming.
        bars[-1].closed = False
    return bars, str(payload.get("source") or "proxy")


async def fetch_bar_dicts(
    symbol: str, timeframe: str, limit: int, provider: str = "yfinance"
) -> tuple[list[dict[str, Any]], str]:
    """The same fetch, as plain dicts — what a lab worker receives on stdin."""
    bars, source = await fetch_bars(symbol, timeframe, limit, provider)
    return [{"t": b.t, "o": b.o, "h": b.h, "l": b.l, "c": b.c, "v": b.v} for b in bars], source


@app.websocket("/ws/bars")
async def ws_bars(
    websocket: WebSocket,
    symbol: str = Query(..., min_length=2, max_length=32),
    timeframe: str = Query("1m", min_length=2, max_length=4),
) -> None:
    """Live bars for one symbol and timeframe.

    Frames are JSON objects with a `type`:

      `hello`  — transport in use, and the provider that served the snapshot
      `bar`    — one bar; `closed` marks the final print for that interval
      `error`  — the upstream failed. The last bar STANDS, and `age_s` says how
                 old it now is. Nothing is interpolated to cover the gap.

    Note the origin check below: `CORSMiddleware` does not apply to WebSockets.
    """
    origin = websocket.headers.get("origin")
    if not _origin_allowed(origin):
        # 1008 = policy violation. Refused before `accept()`, so a page that is
        # not allowed to talk to this gateway never gets an open socket.
        await websocket.close(code=1008, reason="origin not allowed")
        return

    await websocket.accept()
    hub: Hub = app.state.hub
    stream, queue = await hub.join(symbol, timeframe)

    try:
        await websocket.send_json(
            {
                "type": "hello",
                "symbol": stream.symbol,
                "timeframe": stream.timeframe,
                "transport": stream.transport,
                "poll_every_ms": stream.poll_every_ms,
                "sharing": len(stream.clients),
            }
        )
        # A late joiner gets the bar the stream already holds, so the chart is
        # populated at once instead of blank until the next print.
        if stream.last is not None:
            await websocket.send_json(
                {
                    "type": "bar",
                    "symbol": stream.symbol,
                    "timeframe": stream.timeframe,
                    "transport": stream.transport,
                    "poll_every_ms": stream.poll_every_ms,
                    "bar": stream.last.as_dict(),
                }
            )

        while True:
            frame = await queue.get()
            await websocket.send_json(frame)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(stream, queue)


@app.get("/api/stream/status", tags=["gateway"])
async def stream_status() -> dict[str, Any]:
    """Upstream subscriptions, their clients, and how stale each one is."""
    return app.state.hub.status()


def _origin_allowed(origin: str | None) -> bool:
    import re

    if origin is None:
        # A non-browser client (the alert daemon, a test) sends no Origin.
        # Browsers always do, so this cannot be used to bypass the check.
        return True
    if origin in settings.allow_origins:
        return True
    return re.match(LOOPBACK_ORIGIN_REGEX, origin) is not None


# ------------------------------------------------------------------ lab -----

@app.get("/api/lab/health", tags=["lab"])
async def lab_health() -> dict[str, Any]:
    """Whether a study can run here: Node present, engine built, cores free."""
    return app.state.lab.health()


@app.post("/api/lab/study", tags=["lab"])
async def lab_study(request: StudyRequest) -> dict[str, Any]:
    """Run ONE study and wait for it.

    For a single family this is simpler than a job to poll. Use the batch
    endpoint for anything that should run in parallel or outlive the request.
    """
    outcome = await app.state.lab.run_one(request)
    return {
        "ok": outcome.ok,
        "label": outcome.label,
        "error": outcome.error,
        "ms": outcome.ms,
        "bars": outcome.bars,
        "source": outcome.source,
        "study": outcome.study,
    }


@app.post("/api/lab/studies", tags=["lab"])
async def lab_studies(batch: BatchRequest) -> dict[str, Any]:
    """Submit a batch and get a job id back immediately.

    Returns before the work is done on purpose: sixteen studies is a minute of
    compute, and an HTTP request held open for a minute is one a proxy, a
    laptop lid or a tab close can destroy along with the results.
    """
    job = app.state.lab.submit(batch)
    return {"id": job.id, "total": job.total, "state": job.state}


@app.get("/api/lab/studies/{job_id}", tags=["lab"])
async def lab_job(job_id: str) -> dict[str, Any]:
    """Progress and results. Completed studies appear as they finish."""
    job = app.state.lab.jobs.get(job_id)
    if job is None:
        return {"error": f"no job {job_id}"}
    return job.report()


@app.delete("/api/lab/studies/{job_id}", tags=["lab"])
async def lab_cancel(job_id: str) -> dict[str, Any]:
    """Cancel a running batch. Workers already spawned are left to finish."""
    return {"cancelled": app.state.lab.cancel(job_id)}


# ---------------------------------------------------------------- terminal --
#
# ONE DOWNLOAD, ONE PORT, ONE THING TO RUN.
#
# The terminal was served by `run.py` on :8000 and the backend answered on
# :8787, so the product was two processes that had to be started in the right
# order and a cross-origin hop between them. That is a reasonable development
# layout and a poor way to hand someone a trading terminal.
#
# Served from the SAME origin as the API, which also makes the CORS policy above
# irrelevant for the normal case: same-origin requests never preflight. The
# policy stays because `file://` and the Vite dev server are still real ways to
# run this, and both are cross-origin.
#
# Absent in a source checkout that has not run `npm --prefix app run build`, and
# that is not an error — it is how every developer runs this. `/` then says what
# to build rather than 404ing.
mount_terminal(app)


# -------------------------------------------------------------- mounts ------
#
# Registered LAST and rooted at "", so every native route above wins first and
# anything left over reaches the legacy dispatcher with its path intact. A
# `Mount` at a non-empty path would strip that prefix, and the Flask rules carry
# their own — see the note in `wsgi.py`.
async def _legacy(scope: MutableMapping[str, Any], receive: Any, send: Any) -> None:
    """The v39 dispatch, mounted last.

    `scope` is `MutableMapping[str, Any]` and not `dict[str, Any]`, which looks
    like pedantry and is not: starlette's `ASGIApp` is defined over the
    MutableMapping protocol, and a parameter annotated `dict` is NARROWER than
    what the caller promises to pass -- so `Mount(app=...)` rejected it. The
    body only reads and forwards, so the wider type costs nothing and the mount
    now type-checks against the signature starlette will actually call.
    """
    await app.state.dispatch(scope, receive, send)


app.router.routes.append(Mount("", app=_legacy))
