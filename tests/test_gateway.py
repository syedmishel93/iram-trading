"""
Gateway tests — the consolidation's own contract.

WHAT IS WORTH TESTING HERE, AND WHY IT IS NOT THE ROUTES
The fifty-three `/svc` routes, the fifteen data-proxy routes and the seventeen
`/quant` routes already have tests, and they are the same functions they always
were. Re-testing them here would test Flask.

What is new, and therefore what can break, is the layer between: the WSGI
bridge, the prefix dispatch and the CORS policy. Every one of these failures is
silent or misleading in exactly the way that costs an afternoon:

  * a stripped path answers 404 to a route that plainly exists
  * a lost REMOTE_ADDR turns every /svc call into `403 no token configured`
  * two Allow-Origin headers work in curl and fail in the browser
  * a reflected hostile origin looks like a working CORS policy

Run:  python -m pytest tests/test_gateway.py -v
"""

from __future__ import annotations

import os
import sys

import anyio
import pytest

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

# Point the service at a scratch database so importing it cannot touch the real
# one. Must happen before `mishel_service` is imported anywhere.
os.environ.setdefault("MISHEL_SVC_DB", os.path.join(os.path.dirname(__file__), "_gateway_test.db"))

fastapi_testclient = pytest.importorskip("fastapi.testclient")
TestClient = fastapi_testclient.TestClient

from gateway.app import app
from gateway.config import LOOPBACK_ORIGIN_REGEX, Settings
from gateway.legacy import LegacyDispatch, LegacyService
from gateway.wsgi import STRIPPED_HEADERS, WSGIBridge, build_environ


@pytest.fixture(scope="module")
def client():
    """A client that looks like it came from loopback.

    `TestClient` reports its peer as the literal string `"testclient"` unless
    told otherwise, and `mishel_service._auth_guard` refuses any peer that is
    not `127.0.0.1`/`::1` when no token is configured. Without this the whole
    `/svc` surface answers 403 in tests and 200 in production, which is the
    least useful way for a test suite to disagree with reality.
    """
    with TestClient(app, client=("127.0.0.1", 5555)) as c:
        yield c


@pytest.fixture(scope="module")
def remote_client():
    """A client from somewhere that is not loopback."""
    with TestClient(app, client=("203.0.113.9", 40000)) as c:
        yield c


# ------------------------------------------------------------- wsgi bridge --

def test_environ_keeps_the_whole_path():
    """The mounted Flask rules carry their own prefix; stripping breaks them."""
    scope = {
        "type": "http", "method": "GET", "path": "/svc/health",
        "query_string": b"a=1", "headers": [], "server": ("127.0.0.1", 8787),
        "client": ("127.0.0.1", 5555), "scheme": "http", "http_version": "1.1",
    }
    environ = build_environ(scope, b"")
    assert environ["PATH_INFO"] == "/svc/health"
    assert environ["SCRIPT_NAME"] == ""
    assert environ["QUERY_STRING"] == "a=1"


def test_environ_carries_the_real_client():
    """`mishel_service._auth_guard` refuses non-loopback callers by REMOTE_ADDR."""
    scope = {
        "type": "http", "method": "GET", "path": "/svc/health",
        "query_string": b"", "headers": [], "server": ("127.0.0.1", 8787),
        "client": ("10.1.2.3", 40000), "scheme": "http", "http_version": "1.1",
    }
    assert build_environ(scope, b"")["REMOTE_ADDR"] == "10.1.2.3"


def test_environ_header_translation():
    scope = {
        "type": "http", "method": "POST", "path": "/svc/kv",
        "query_string": b"", "server": ("127.0.0.1", 8787), "client": ("127.0.0.1", 1),
        "scheme": "http", "http_version": "1.1",
        "headers": [
            (b"content-type", b"application/json"),
            (b"x-mishel-token", b"secret"),
            (b"accept", b"a"),
            (b"accept", b"b"),
        ],
    }
    environ = build_environ(scope, b"{}")
    # Content-Type is unprefixed in CGI; everything else gains HTTP_.
    assert environ["CONTENT_TYPE"] == "application/json"
    assert environ["HTTP_X_MISHEL_TOKEN"] == "secret"
    assert environ["HTTP_ACCEPT"] == "a,b"  # repeats join, per RFC 9110
    assert environ["wsgi.input"].read() == b"{}"


def test_cors_headers_are_on_the_strip_list():
    """The legacy apps set these themselves; the gateway must be the only voice."""
    for name in (b"access-control-allow-origin", b"vary", b"access-control-allow-headers"):
        assert name in STRIPPED_HEADERS


def test_framing_headers_are_on_the_strip_list():
    """A mounted app does not get to say how its bytes are framed on the wire.

    REGRESSION. Adding `GZipMiddleware` left Flask's own `Content-Length` in the
    response beside the compressor's framing, so a gzipped `/ohlc` reached Chrome
    as `ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH` and gold, EURUSD and the
    index silently would not load in the terminal. `curl` fetched them perfectly
    the whole time, because it does not ask for gzip unless told to — the same
    "works in curl, unreachable from the browser" shape as the CORS duplication
    above, which is why both are now one rule rather than two special cases.
    """
    for name in (b"content-length", b"transfer-encoding"):
        assert name in STRIPPED_HEADERS


def test_content_encoding_is_deliberately_kept():
    """It is the only record that a body is already compressed.

    Stripping it would corrupt such a payload rather than merely reframe it —
    a different and worse failure than the one above.
    """
    assert b"content-encoding" not in STRIPPED_HEADERS


def test_the_bridge_emits_no_framing_headers_at_all():
    """Asserted on the RAW ASGI messages, which is the only place it is visible.

    The client-level version of this test passes either way: `httpx` re-frames a
    response before handing it back, so a duplicated `Content-Length` is invisible
    by the time a test can read `res.headers`. The browser is not so forgiving,
    which is exactly how this shipped. So this drives `WSGIBridge` directly and
    inspects what it actually sends downstream.
    """

    def flask_like(environ, start_response):
        body = b'{"ok": true, "padding": "' + b"x" * 4096 + b'"}'
        start_response(
            "200 OK",
            [
                ("Content-Type", "application/json"),
                # Flask sets this for its own response. Forwarding it is the bug.
                ("Content-Length", str(len(body))),
                ("Access-Control-Allow-Origin", "*"),
            ],
        )
        return [body]

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/svc/whatever",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 5555),
        "server": ("127.0.0.1", 8787),
        "scheme": "http",
    }

    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    anyio.run(WSGIBridge(flask_like), scope, receive, send)

    start = next(m for m in sent if m["type"] == "http.response.start")
    names = [k.lower() for k, _ in start["headers"]]

    # The compressor downstream owns framing. The bridge must assert none of it.
    assert b"content-length" not in names
    assert b"transfer-encoding" not in names
    # And the CORS rule this file already had is still enforced on the same path.
    assert b"access-control-allow-origin" not in names
    # Everything the app legitimately said is still there.
    assert b"content-type" in names
    assert b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


def test_a_gzipped_legacy_response_is_still_readable(client):
    """An end-to-end smoke test, and NOT the regression guard.

    It passes with the bug present, because the test client re-frames the
    response. Kept because it would catch a compressor that produced garbage;
    the guard against the framing duplication is the raw-message test above.
    """
    res = client.get("/api/routes", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.json()


# ---------------------------------------------------------------- dispatch --

def _svc(name, prefixes, ok=True):
    s = LegacyService(name=name, module="x", prefixes=prefixes, provides="p")
    if ok:
        s.bridge = object()  # type: ignore[assignment]
    else:
        s.error = "ImportError: no numpy"
    return s


def test_dispatch_matches_whole_segments_only():
    d = LegacyDispatch((_svc("data", ("/ohlc",)), _svc("svc", ("/svc",))))
    assert d.find("/ohlc").name == "data"
    assert d.find("/ohlc/extra").name == "data"
    assert d.find("/svc/health").name == "svc"
    # `/ohlcx` is a different word, not a child of `/ohlc`.
    assert d.find("/ohlcx") is None
    assert d.find("/nothing") is None


def test_dispatch_ignores_flask_static():
    """All three define /static; routing it would pick one by import order."""
    d = LegacyDispatch((_svc("data", ("/ohlc",)), _svc("svc", ("/svc",))))
    assert d.find("/static/x.js") is None


# ------------------------------------------------------------------ config --

@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("http://localhost:5173", True),    # vite dev
        ("http://127.0.0.1:8000", True),    # run.py
        ("http://localhost", True),         # no port
        ("http://[::1]:4173", True),        # vite preview over ipv6
        ("https://localhost:8443", True),
        ("https://evil.example.com", False),
        ("http://localhost.evil.com", False),   # suffix attack
        ("http://notlocalhost:5173", False),
        ("https://127.0.0.1.evil.com", False),
    ],
)
def test_loopback_origin_regex(origin, allowed):
    import re

    assert bool(re.match(LOOPBACK_ORIGIN_REGEX, origin)) is allowed


def test_file_origin_is_allowed():
    """The shipped artefact opens from a double-click and sends `Origin: null`."""
    assert "null" in Settings().allow_origins


def test_tauri_origins_are_allowed():
    origins = Settings().allow_origins
    assert "tauri://localhost" in origins and "https://tauri.localhost" in origins


# -------------------------------------------------------------------- live --

def test_health_reports_every_service(client):
    body = client.get("/api/health").json()
    assert set(body["services"]) == {"data", "svc", "quant"}
    assert body["version"]


def test_all_three_services_answer_on_one_port(client):
    """The consolidation's whole claim, in one test."""
    assert client.get("/health").status_code == 200          # data proxy
    assert client.get("/svc/health").status_code == 200      # service + SQLite
    assert client.get("/quant/health").status_code == 200    # model service


def test_svc_auth_guard_survives_the_bridge(client):
    """A lost REMOTE_ADDR would 403 this with `refusing non-localhost`."""
    response = client.get("/svc/kv/manifest")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_svc_still_refuses_a_non_loopback_caller(remote_client):
    """The other half, and the half that matters.

    `mishel_service` fails closed off loopback when no token is set. Passing
    the peer through the bridge correctly means that guard still fires — a
    bridge that hardcoded 127.0.0.1 would satisfy the test above while quietly
    opening every /svc route to the network.
    """
    response = remote_client.get("/svc/kv/manifest")
    assert response.status_code == 403
    assert "non-localhost" in response.json()["error"]


def test_legacy_route_has_exactly_one_allow_origin(client):
    """flask_cors sets it too. Two values and the browser rejects the response."""
    response = client.get("/svc/health", headers={"Origin": "http://localhost:5173"})
    values = response.headers.get_list("access-control-allow-origin")
    assert values == ["http://localhost:5173"]
    assert response.headers.get_list("vary").count("Origin") == 1


def test_hostile_origin_is_not_reflected(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in response.headers


def test_preflight_allows_the_service_auth_header(client):
    """A preflight that omits X-Mishel-Token fails before the request is made."""
    response = client.options(
        "/svc/kv",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-mishel-token",
        },
    )
    assert response.status_code == 200
    assert "x-mishel-token" in response.headers["access-control-allow-headers"].lower()


def test_unknown_path_404s_in_the_gateways_voice(client):
    response = client.get("/definitely-not-a-route")
    assert response.status_code == 404
    assert "no route for" in response.json()["error"]


def test_routes_inventory_covers_all_three(client):
    body = client.get("/api/routes").json()
    assert body["total"] > 70
    assert any(r.startswith("/svc/") for r in body["routes"]["svc"])
    assert any(r.startswith("/quant/") for r in body["routes"]["quant"])
    assert "/ws/bars" in body["routes"]["gateway"]


# --------------------------------------------------------------------- lab --

def test_lab_health_reports_what_is_missing(client):
    body = client.get("/api/lab/health").json()
    # Node and the built engine may legitimately be absent on a data-only host;
    # what must never be absent is the reason.
    assert body["ok"] is True or body["hint"]
    assert body["workers"] >= 1


def test_lab_refuses_a_study_with_neither_bars_nor_symbol(client):
    response = client.post("/api/lab/study", json={"family": "ema"})
    assert response.json()["ok"] is False
    assert "bars" in response.json()["error"]


def test_lab_rejects_an_unknown_family(client):
    """`family` is a Literal, so pydantic refuses it before a worker is spawned."""
    assert client.post("/api/lab/study", json={"family": "wishful"}).status_code == 422


def test_stream_status_starts_empty(client):
    body = client.get("/api/stream/status").json()
    assert body["upstreams"] >= 0 and "streams" in body


# ------------------------------------------------------------------ serving --

def test_serves_the_terminal_or_says_how_to_build_it(client):
    """`/` is the product. Never a 404, in either state."""
    response = client.get("/")
    assert response.status_code == 200
    body = response.text
    # One of the two legitimate answers: the built terminal, or instructions.
    assert "<!doctype html>" in body.lower() or "npm --prefix app run build" in body


def test_tells_the_terminal_it_is_same_origin(client):
    """The frontend cannot work this out for itself — see gateway/terminal.py.

    The same build is served from Vite, run.py, a file:// double-click and from
    here, and the page origin is the API in exactly one of the four.
    """
    body = client.get("/").text
    if "<!doctype html>" in body.lower():
        assert 'name="iram-backend" content="same-origin"' in body


def test_revalidates_rather_than_re_downloading(client):
    """no-cache + ETag: correct AND cheap.

    `no-store` was the first version. It is right about the danger — a cached
    terminal against a newer backend is a bug report about something already
    fixed — and re-downloads 1.1 MB on every reload to get it. `no-cache` keeps
    the must-revalidate guarantee; the ETag makes the revalidation a 304.
    """
    first = client.get("/")
    if "<!doctype html>" not in first.text.lower():
        pytest.skip("terminal not built in this checkout")

    etag = first.headers.get("etag")
    assert etag, "no ETag, so every reload re-downloads the whole terminal"
    assert first.headers.get("cache-control") == "no-cache"

    again = client.get("/", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""


def test_the_etag_changes_when_the_build_changes(client, tmp_path):
    """An ETag that outlived its content would pin the browser to a stale app."""
    import os

    from gateway import terminal

    a = tmp_path / "a.html"
    a.write_text("<head></head><body>one</body>", encoding="utf-8")
    os.environ["IRAM_TERMINAL"] = str(a)
    try:
        first = client.get("/").headers.get("etag")
        # Rewrite with different content AND a later mtime.
        a.write_text("<head></head><body>two</body>", encoding="utf-8")
        os.utime(a, (a.stat().st_atime + 10, a.stat().st_mtime + 10))
        second = client.get("/").headers.get("etag")
        assert first and second and first != second
    finally:
        os.environ.pop("IRAM_TERMINAL", None)
        terminal.terminal_path()


def test_compresses_the_terminal_but_not_small_json(client):
    """Gzip earns its place on a megabyte of HTML and not on a health check."""
    big = client.get("/", headers={"Accept-Encoding": "gzip"})
    if "<!doctype html>" in big.text.lower():
        assert big.headers.get("content-encoding") == "gzip"

    # The desks poll this constantly; a gzip header and a compression pass on
    # 600 bytes costs more than it saves.
    small = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert small.headers.get("content-encoding") != "gzip"
