"""server/svc/mcp.py — the MCP engine: one client for every MCP server.

WHAT THIS IS

Model Context Protocol servers publish TOOLS over JSON-RPC. This module speaks
the Streamable HTTP transport to any of them, so connecting a new platform is a
registry row rather than a release. `svc/mcpauth.py` owns the OAuth half.

EVERY DECISION BELOW WAS MEASURED AGAINST A LIVE SERVER (2026-09-25), because
this module's whole job is talking to somebody else's service and a description
of one is not one. `scratchpad/mcpprobe.py` is the probe; re-run it rather than
trusting this paragraph.

  1. THE REPLY IS EITHER JSON OR AN SSE STREAM. `mcp.crypto.com` answers a
     unary `initialize` with `content-type: text/event-stream`, so a client
     that calls `r.json()` fails against the only server available to verify it
     against. Both framings are legal and `_message` reads both.

  2. THE SERVER'S PROTOCOL VERSION WINS. Asked for `2025-06-18`, answered
     `2025-03-26`. A client that insists on its own cannot talk to it, so
     `PROTOCOL` is what we OFFER and the negotiated value is what we then send
     back in `MCP-Protocol-Version`.

  3. `Mcp-Session-Id` IS OPTIONAL AND MUST BE ECHOED ONLY WHEN ISSUED.
     Crypto.com issues none; requiring one would refuse a working server. When a
     server does issue one, an expired session answers 404 — which is the
     spec's way of saying "handshake again", and `_with_session` does exactly
     that, once, rather than reporting a dead connection.

  4. A TOOL RESULT IS PROSE WRAPPING JSON. See `embedded_json`. This broke the
     probe written to read it, on its first real call.

WHAT IT REFUSES TO DO

A non-2xx, a JSON-RPC `error` and an `isError` result all become NAMED
REFUSALS in the `_refuse` idiom `svc/router.py` uses — never an exception
reaching a route, and never a token in a message. A refusal an operator cannot
act on is the failure mode this project keeps recording: "could not ask" and
"nothing there" are different facts and are reported as different facts.

WHAT IT DELIBERATELY DOES NOT DO

**No MCP data reaches the `bars` archive.** MEASURED: `get_candlestick` accepts
`instrument_name` and `timeframe` and nothing else, and returned 50 rows
newest-first. No date range, no cursor. Fifty descending bars cannot fill an
archive a walk-forward reads, so this is a fact about the tool's shape rather
than caution about a new vendor. Live readings, screeners, fundamentals and
sentiment are what MCP is for here.

**No second owner for a vendor already wired.** AlphaVantage and TwelveData both
publish MCP servers and this product already speaks REST to both, with
per-endpoint timezone corrections recorded above `p_twelvedata` because reading
them wrong once displaced every bar they served. Wiring them here would be a
worse duplicate owner for "what did this market do" — the `/svc/ledger` mistake.
`WONT_WIRE` states that in code so the next person meets the reason.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
from db import db
from flask import Blueprint, jsonify, request

from svc.core import log_event

bp = Blueprint("mcp", __name__)

#: What we OFFER. The server's answer is what gets used — see note 2.
PROTOCOL = "2025-06-18"

#: Both framings are legal for Streamable HTTP and one server in four uses SSE.
ACCEPT = "application/json, text/event-stream"

TIMEOUT = 30.0

#: The registry lives in one config row, so "which servers" has one owner.
CFG_KEY = "mcp_servers"

#: Handshakes are cached per URL. TradingView throttles at 100 requests/minute
#: per user and a tool call is three round trips without this, so a cache is not
#: an optimisation here — it is the difference between working and being
#: rate-limited. Short, because a stale session is answered by re-handshaking.
SESSION_TTL_S = 300.0

#: url -> {"id", "protocol", "at"}
_SESSIONS: dict[str, dict[str, Any]] = {}

#: Servers that are deliberately NOT offered, with the reason, so that the next
#: person to look for them finds an argument rather than an omission.
WONT_WIRE = {
    "mcp.alphavantage.co": (
        "this product already reads AlphaVantage over REST, with a documented "
        "per-endpoint timezone correction. A second path to one vendor is a "
        "second owner for what a market did."
    ),
    "mcp.twelvedata.com": (
        "same: TwelveData is already wired, and its bars needed a per-endpoint "
        "zone fix that a second client would not inherit."
    ),
}


# --------------------------------------------------------------------- shapes --
def _refuse(why: str, **extra: Any) -> dict[str, Any]:
    """A refusal is a RESULT. It names itself and it is addressed to the operator."""
    out: dict[str, Any] = {"ok": False, "why": why, "needsAuth": False}
    out.update(extra)
    return out


# ------------------------------------------------------------------ transport --
def _sse_messages(text: str) -> list[dict[str, Any]]:
    """Parse an SSE body into JSON-RPC messages.

    `data:` may be repeated within one event and the parts are JOINED, per the
    SSE spec — a parser that takes only the first line truncates any message big
    enough to be split, which is exactly the messages worth having.
    """
    out: list[dict[str, Any]] = []
    parts: list[str] = []

    def flush() -> None:
        if not parts:
            return
        try:
            out.append(json.loads("\n".join(parts)))
        except ValueError:
            pass  # a comment or a keep-alive frame; not every event is a message
        parts.clear()

    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line:
            flush()
        elif line.startswith("data:"):
            parts.append(line[5:].lstrip())
    flush()
    return out


def _message(r: httpx.Response) -> dict[str, Any] | None:
    """The reply is EITHER `application/json` OR an SSE stream carrying it.

    Note 1 in this module's header: the one server that can be verified without
    an account uses SSE for a unary call, so this is not a defensive branch.
    """
    if "text/event-stream" in r.headers.get("content-type", ""):
        for m in _sse_messages(r.text):
            if "result" in m or "error" in m:
                return m
        return None
    try:
        return r.json()
    except ValueError:
        return None


def _auth_hint(r: httpx.Response) -> str | None:
    """The `resource_metadata` URL a 401 advertises — the OAuth entry point.

    MEASURED on both servers that require auth:
        WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/..."
    Returned rather than followed: discovery belongs to `svc/mcpauth.py`, and a
    401 here has to stay a refusal the screen can print.
    """
    head = r.headers.get("www-authenticate", "")
    marker = 'resource_metadata="'
    i = head.find(marker)
    if i < 0:
        return None
    rest = head[i + len(marker):]
    end = rest.find('"')
    return rest[:end] if end > 0 else None


def _open() -> httpx.Client:
    """Where EVERY request in this module comes from.

    One binding, so a test replaces one thing and reaches no network. `PROXY` in
    `svc/mt5.py` is here for the same reason: two modules read it at call time
    precisely so that repointing the one repoints both. Patch
    `sys.modules["svc.mcp"]._open`, never the facade -- a re-export is a second
    binding and patching it silently tests the real thing.
    """
    return httpx.Client(follow_redirects=True)


def _post(
    client: httpx.Client,
    url: str,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    token: str | None = None,
    session: str | None = None,
    protocol: str | None = None,
    notify: bool = False,
) -> httpx.Response:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if not notify:
        msg["id"] = int(time.time() * 1000) % 2_000_000_000
    if params is not None:
        msg["params"] = params

    headers = {"Content-Type": "application/json", "Accept": ACCEPT}
    if token:
        headers["Authorization"] = "Bearer " + token
    if session:
        headers["Mcp-Session-Id"] = session
    if protocol:
        headers["MCP-Protocol-Version"] = protocol
    return client.post(url, json=msg, headers=headers, timeout=TIMEOUT)


# -------------------------------------------------------------------- session --
def handshake(url: str, token: str | None = None) -> dict[str, Any]:
    """`initialize` + `notifications/initialized`. Returns a session or a refusal."""
    host = httpx.URL(url).host or ""
    if host in WONT_WIRE:
        return _refuse("not offered: " + WONT_WIRE[host])

    try:
        with _open() as c:
            r = _post(c, url, "initialize", {
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name": "iram", "version": "63"},
            }, token=token)

            if r.status_code in (401, 403):
                return _refuse(
                    "this server wants you to sign in before it will answer",
                    needsAuth=True, resourceMetadata=_auth_hint(r), status=r.status_code,
                )
            if r.status_code >= 400:
                return _refuse(
                    "the server answered %d rather than opening a session" % r.status_code,
                    status=r.status_code,
                )

            msg = _message(r)
            if not msg or "result" not in msg:
                err = (msg or {}).get("error", {})
                return _refuse(
                    "the server's reply was not an MCP session: %s"
                    % (err.get("message") or "no result in the response"),
                    status=r.status_code,
                )

            got = msg["result"]
            # Note 2: THEIR version, not ours.
            protocol = got.get("protocolVersion") or PROTOCOL
            sid = r.headers.get("mcp-session-id")
            _post(c, url, "notifications/initialized", session=sid,
                  protocol=protocol, token=token, notify=True)
    except httpx.HTTPError as e:
        return _refuse("could not reach this server: %s" % type(e).__name__)

    info = got.get("serverInfo") or {}
    return {
        "ok": True,
        "url": url,
        "protocol": protocol,
        "session": sid,
        "name": info.get("title") or info.get("name") or httpx.URL(url).host,
        "version": info.get("version"),
        "capabilities": got.get("capabilities") or {},
    }


def _session(url: str, token: str | None, fresh: bool = False) -> dict[str, Any]:
    """A held session, or a new one. ONE SHAPE on both paths.

    This returned the handshake result verbatim on a miss and the cached row on a
    hit, and the two named the session id differently -- `session` against `id`,
    with `_rpc` reading `id`. So the very first call after any handshake went out
    with no `Mcp-Session-Id` at all, and only against a server that ISSUES one,
    which is why driving it live against Crypto.com could not show it: that
    server issues none. Caught by `test_a_session_id_is_echoed_when_one_is_issued`.

    Same class as the broker spec filed under `XAUUSD.s` and looked up under
    `XAUUSD`. The fix is that there is now one spelling and one place that builds
    it, rather than two callers agreeing to be careful.
    """
    held = _SESSIONS.get(url)
    if not fresh and held and (time.time() - held["at"]) < SESSION_TTL_S:
        return {"ok": True, "url": url, **held}
    got = handshake(url, token)
    if not got.get("ok"):
        _SESSIONS.pop(url, None)
        return got
    row = {"id": got.get("session"), "protocol": got["protocol"],
           "at": time.time(), "name": got.get("name")}
    _SESSIONS[url] = row
    return {"ok": True, "url": url, **row}


def _rpc(url: str, method: str, params: dict[str, Any], token: str | None) -> dict[str, Any]:
    """One request against a cached session, re-handshaking once on a 404.

    Note 3: the spec answers an EXPIRED session with 404. Reporting that as a
    dead server would be a refusal the operator cannot act on, for a connection
    that is one handshake from working.
    """
    for attempt in (0, 1):
        s = _session(url, token, fresh=attempt == 1)
        if not s.get("ok"):
            return s
        try:
            with _open() as c:
                r = _post(c, url, method, params, token=token,
                          session=s.get("id"), protocol=s.get("protocol"))
        except httpx.HTTPError as e:
            return _refuse("could not reach this server: %s" % type(e).__name__)

        if r.status_code == 404 and attempt == 0:
            continue
        if r.status_code in (401, 403):
            return _refuse("the sign-in for this server is no longer accepted",
                           needsAuth=True, resourceMetadata=_auth_hint(r),
                           status=r.status_code)
        if r.status_code >= 400:
            return _refuse("the server answered %d" % r.status_code, status=r.status_code)

        msg = _message(r)
        if msg is None:
            return _refuse("the server's reply could not be read as MCP")
        if "error" in msg:
            e = msg["error"] or {}
            return _refuse("the server refused: %s" % (e.get("message") or e.get("code")))
        return {"ok": True, "result": msg.get("result") or {}}
    return _refuse("the server kept ending the session")


# ----------------------------------------------------------------------- API --
def tools(url: str, token: str | None = None) -> dict[str, Any]:
    """What can this server do? Name, description and the arguments each takes."""
    got = _rpc(url, "tools/list", {}, token)
    if not got.get("ok"):
        return {**got, "tools": []}
    listed = got["result"].get("tools") or []
    return {
        "ok": True,
        "count": len(listed),
        "tools": [{
            "name": t.get("name"),
            "title": t.get("title") or t.get("name"),
            "description": (t.get("description") or "")[:400],
            "required": (t.get("inputSchema") or {}).get("required") or [],
            "properties": sorted(((t.get("inputSchema") or {}).get("properties") or {}).keys()),
        } for t in listed],
    }


def call_tool(
    url: str, name: str, arguments: dict[str, Any] | None = None, token: str | None = None
) -> dict[str, Any]:
    """Call one tool and return its content UNINTERPRETED.

    The raw result is always readable, and that is deliberate: it is the proof a
    connection works, and it needs no adapter. Turning content into one of this
    product's own shapes is a separate, named step — see `embedded_json` and the
    note about the bars archive in this module's header.
    """
    got = _rpc(url, "tools/call", {"name": name, "arguments": arguments or {}}, token)
    if not got.get("ok"):
        return got

    res = got["result"]
    blocks = res.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")

    # `isError` is the server saying the TOOL failed, with a 200 around it. A
    # count of what answered is not a count of what worked.
    if res.get("isError"):
        return _refuse("the tool reported a failure: %s" % (text[:300] or "no detail given"),
                       tool=name, text=text)
    return {
        "ok": True,
        "tool": name,
        "kinds": [b.get("type") for b in blocks],
        "text": text,
        "structured": res.get("structuredContent"),
    }


def embedded_json(text: str) -> dict[str, Any]:
    """Find the JSON inside a tool's PROSE. Refuse rather than repair.

    AN MCP TOOL ANSWERS A LANGUAGE MODEL, so its text block is model-facing
    prose with the data embedded. MEASURED:

        Here is the Crypto.com Exchange candlestick data {"instrument_name":...}

    `json.loads` on that raises, and it raised on the probe written to read it —
    the first real call this engine ever made. So the object is LOCATED, from the
    first brace, with `raw_decode` so a trailing sentence cannot break it.

    The important half is what this does NOT do. That prose is not a contract:
    the wording can change without notice and there is no schema behind it. So
    the caller gets the parsed object and the surrounding prose SEPARATELY and
    validates the fields itself. Nothing here guesses, repairs, or coerces a
    near-miss into a shape — which is the hand-written-client risk this project
    already records as its one real API-contract gap, arriving in a source that
    has no schema at all.
    """
    if not text:
        return _refuse("the tool returned no text to read")
    start = text.find("{")
    if start < 0:
        start = text.find("[")
    if start < 0:
        return _refuse("the tool's answer holds no JSON, only prose")
    try:
        data, end = json.JSONDecoder().raw_decode(text[start:])
    except ValueError as e:
        return _refuse("the JSON inside the tool's answer did not parse: %s" % e)
    return {
        "ok": True,
        "data": data,
        "prose": (text[:start] + text[start + end:]).strip(),
    }


# ------------------------------------------------------------------ registry --
def servers() -> list[dict[str, Any]]:
    """The registry. One config row, so "which servers" has one owner."""
    with db() as c:
        row = c.execute("SELECT v FROM config WHERE k=?", (CFG_KEY,)).fetchone()
    if not row or not row["v"]:
        return []
    try:
        got = json.loads(row["v"])
    except ValueError:
        return []
    return got if isinstance(got, list) else []


def _write(rows: list[dict[str, Any]]) -> None:
    with db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (CFG_KEY, json.dumps(rows)),
        )


def add_server(name: str, url: str) -> dict[str, Any]:
    url = (url or "").strip()
    if not url.startswith("https://") and not url.startswith("http://127.0.0.1"):
        return _refuse("an MCP address has to be https (or a local 127.0.0.1 one)")
    host = httpx.URL(url).host or ""
    if host in WONT_WIRE:
        return _refuse("not offered: " + WONT_WIRE[host])

    rows = servers()
    if any(r.get("url") == url for r in rows):
        return _refuse("that address is already on the list")
    rows.append({"name": (name or host).strip(), "url": url, "added": time.time()})
    _write(rows)
    # Announced AFTER the write closes. `log_event` opens its OWN connection, and
    # a nested write asks for the lock this thread is holding -- which cost
    # `pair_scan_loop` every run it ever made.
    log_event("mcp_add", "added MCP server %s" % host)
    return {"ok": True, "servers": rows}


def remove_server(url: str) -> dict[str, Any]:
    rows = servers()
    kept = [r for r in rows if r.get("url") != url]
    if len(kept) == len(rows):
        return _refuse("that address is not on the list")
    _write(kept)
    _SESSIONS.pop(url, None)
    log_event("mcp_remove", "removed MCP server %s" % (httpx.URL(url).host or url))
    return {"ok": True, "servers": kept}


# -------------------------------------------------------------------- routes --
def _token(url: str) -> str | None:
    """The saved sign-in for a server, or None.

    Owned by `svc/mcpauth.py`, imported at CALL TIME so that this module loads
    on a checkout where auth has not been wired yet, and so there is ONE binding
    for the token store rather than a re-export that a patch would miss.
    """
    try:
        from svc import mcpauth
    except ImportError:
        return None
    return mcpauth.token_for(url)


@bp.get("/svc/mcp/servers")
def svc_mcp_servers():
    return jsonify({"ok": True, "servers": servers(), "offering": PROTOCOL})


@bp.post("/svc/mcp/add")
def svc_mcp_add():
    b = request.get_json(silent=True) or {}
    return jsonify(add_server(b.get("name") or "", b.get("url") or ""))


@bp.post("/svc/mcp/remove")
def svc_mcp_remove():
    b = request.get_json(silent=True) or {}
    return jsonify(remove_server(b.get("url") or ""))


@bp.get("/svc/mcp/probe")
def svc_mcp_probe():
    url = request.args.get("url") or ""
    if not url:
        return jsonify(_refuse("no address given"))
    return jsonify(handshake(url, _token(url)))


@bp.get("/svc/mcp/tools")
def svc_mcp_tools():
    url = request.args.get("url") or ""
    if not url:
        return jsonify(_refuse("no address given", tools=[]))
    return jsonify(tools(url, _token(url)))


@bp.post("/svc/mcp/call")
def svc_mcp_call():
    b = request.get_json(silent=True) or {}
    url, name = b.get("url") or "", b.get("tool") or ""
    if not url or not name:
        return jsonify(_refuse("a call needs both an address and a tool name"))
    args = b.get("arguments")
    if args is not None and not isinstance(args, dict):
        return jsonify(_refuse("the tool arguments have to be an object"))
    return jsonify(call_tool(url, name, args or {}, _token(url)))
