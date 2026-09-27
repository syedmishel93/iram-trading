"""
A WSGI application, served from ASGI — without a new dependency.

WHY NOT `starlette.middleware.wsgi`
It still imports on Starlette 1.3, but only with a `StarletteDeprecationWarning`
that says it will be removed. Pinning the gateway to a component whose own
authors point at a replacement is a migration scheduled for an inconvenient day.

WHY NOT `a2wsgi` (the replacement they point at)
It is a good library and it is not installed here. This adapter is ninety lines
because the job is small: build a CGI environ, run the app, send what it
returned. The project already declines a dependency for two HTTP calls in
`store/supabase.ts` for the same reason.

THE TWO DETAILS THAT ARE EASY TO GET WRONG, AND BOTH BITE SILENTLY

1. **The path is passed through unchanged.** Starlette's `Mount` strips the
   prefix it matched, which is right when the mounted app expects to be rooted
   there. These three do not: every rule in `mishel_service.py` is written as
   `/svc/...` and every rule in `quant/app.py` as `/quant/...`. Strip the prefix
   and Flask answers 404 to routes that plainly exist — a failure that reads as
   "the consolidation lost my endpoints".

2. **`REMOTE_ADDR` must be the real client.** `mishel_service._auth_guard`
   refuses any request whose `remote_addr` is not loopback when no token is
   configured — which is the default. Forget to set it and the environ default
   is empty, every `/svc/*` call answers `403 no token configured`, and the
   terminal shows a service that is running and rejecting it.

CORS AND FRAMING HEADERS ARE STRIPPED ON THE WAY OUT — see `STRIPPED_HEADERS`.

BODIES ARE BUFFERED, BOTH WAYS. These handlers speak JSON — the largest is a
64 MB bar payload that `quant/app.py` already caps and reads whole. Streaming
would add a queue and a second failure mode to endpoints that have no use for
either.
"""

from __future__ import annotations

import io
import sys
from collections.abc import Callable, Iterable
from typing import Any

import anyio
from anyio import CapacityLimiter

WSGIApp = Callable[[dict[str, Any], Callable[..., Any]], Iterable[bytes]]

#: Header fields that are named without the `HTTP_` prefix in CGI.
_UNPREFIXED = {"content-type": "CONTENT_TYPE", "content-length": "CONTENT_LENGTH"}

#: Response headers the legacy apps emit that the gateway must own instead.
#:
#: All three call `flask_cors.CORS(app)`, which was right when each answered on
#: its own port and is wrong now. Two layers both adding
#: `Access-Control-Allow-Origin` produce a response carrying the header twice,
#: and the browser's rule for that is not "take the first" — it is to fail the
#: request with *"contains multiple values"*. The endpoint works in curl and is
#: unreachable from the terminal, which is the worst shape a bug can have.
#:
#: `Vary` is dropped for the same reason: `CORSMiddleware` appends
#: `Vary: Origin` itself, and a duplicated `Vary` poisons any cache in front.
#:
#: ---------------------------------------------------------------------------
#: FRAMING HEADERS TOO, AND THIS ONE COST A WORKING FEATURE.
#:
#: MEASURED, in a browser, after `GZipMiddleware` was added to `app.py`. Flask
#: sets `Content-Length` for its own response; the gzip middleware then
#: compresses that body and writes framing of its own. The response reaches
#: Chrome carrying `Content-Encoding: gzip` alongside the UNCOMPRESSED length,
#: and Chrome refuses the whole response with
#: `ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH`.
#:
#: The symptom was that gold, EURUSD and the index silently would not load in
#: the terminal while `curl` fetched them perfectly — because curl does not send
#: `Accept-Encoding: gzip` unless asked, so the middleware never engaged. That is
#: the same shape as the CORS duplication above, which is the second time this
#: adapter has been bitten by forwarding a header the ASGI stack owns.
#:
#: The general rule, rather than another special case: **a mounted WSGI app does
#: not get to declare how its bytes are framed on the wire.** Length and transfer
#: encoding belong to whatever finally writes the response, which here may be a
#: compressor. Dropping `Content-Length` costs a chunked response and nothing
#: else; keeping it costs the endpoint.
#:
#: `Content-Encoding` is deliberately NOT stripped: if a handler ever returns a
#: genuinely pre-compressed body, that header is the only record of it, and
#: removing it would corrupt the payload rather than merely reframe it.
STRIPPED_HEADERS: frozenset[bytes] = frozenset(
    {
        b"access-control-allow-origin",
        b"access-control-allow-methods",
        b"access-control-allow-headers",
        b"access-control-allow-credentials",
        b"access-control-expose-headers",
        b"access-control-max-age",
        b"vary",
        b"content-length",
        b"transfer-encoding",
    }
)


def build_environ(scope: dict[str, Any], body: bytes) -> dict[str, Any]:
    """Translate an ASGI HTTP scope into a WSGI environ."""
    server = scope.get("server") or ("127.0.0.1", 80)
    client = scope.get("client") or ("127.0.0.1", 0)

    environ: dict[str, Any] = {
        "REQUEST_METHOD": scope["method"],
        # Empty, and the path is whole — see note 1 in the module docstring.
        "SCRIPT_NAME": "",
        "PATH_INFO": scope["path"],
        "QUERY_STRING": scope.get("query_string", b"").decode("latin-1"),
        "SERVER_NAME": str(server[0]),
        "SERVER_PORT": str(server[1] if len(server) > 1 and server[1] else 80),
        "SERVER_PROTOCOL": f"HTTP/{scope.get('http_version', '1.1')}",
        "REMOTE_ADDR": str(client[0]),
        "REMOTE_PORT": str(client[1] if len(client) > 1 else 0),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": scope.get("scheme", "http"),
        "wsgi.input": io.BytesIO(body),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": True,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }

    for raw_name, raw_value in scope.get("headers", []):
        name = raw_name.decode("latin-1").lower()
        value = raw_value.decode("latin-1")
        key = _UNPREFIXED.get(name) or "HTTP_" + name.upper().replace("-", "_")
        # Repeated headers join with a comma, per RFC 9110 §5.3.
        environ[key] = f"{environ[key]},{value}" if key in environ else value

    return environ


def _call_wsgi(app: WSGIApp, environ: dict[str, Any]) -> tuple[int, list[tuple[bytes, bytes]], bytes]:
    """Run the app to completion on this thread. Returns (status, headers, body)."""
    captured: dict[str, Any] = {}

    def start_response(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Any:
        if exc_info is not None:
            # PEP 3333: re-raise only if headers have already gone out. Nothing
            # has, because nothing is sent until this function returns.
            captured.clear()
        captured["status"] = int(status.split(" ", 1)[0])
        captured["headers"] = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in headers]
        return lambda chunk: None

    result = app(environ, start_response)
    try:
        body = b"".join(result)
    finally:
        close = getattr(result, "close", None)
        if close is not None:
            close()

    headers = [(k, v) for k, v in captured.get("headers", []) if k.lower() not in STRIPPED_HEADERS]
    return captured.get("status", 500), headers, body


class WSGIBridge:
    """An ASGI app that serves one WSGI app, path unchanged."""

    def __init__(self, app: WSGIApp, *, limiter: CapacityLimiter | None = None) -> None:
        self.app = app
        # Flask here is synchronous and some handlers block for ten seconds on a
        # model fit. The limiter is what keeps those from consuming every thread
        # anyio will lend and starving the health check that decides whether the
        # terminal thinks this service is alive.
        self.limiter = limiter or CapacityLimiter(24)

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        assert scope["type"] == "http"

        chunks = bytearray()
        more = True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunks.extend(message.get("body", b""))
            more = message.get("more_body", False)

        environ = build_environ(scope, bytes(chunks))
        status, headers, body = await anyio.to_thread.run_sync(
            _call_wsgi, self.app, environ, limiter=self.limiter
        )

        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
