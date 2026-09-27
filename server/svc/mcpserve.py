"""server/svc/mcpserve.py -- IRAM AS an MCP server: the other direction.

`svc/mcp.py` makes this product a CLIENT of other people's MCP servers. This
module makes it a SERVER, so Claude Desktop or any other MCP client can ask the
terminal what history it holds, what the broker says, and whether the machine's
past reads worked out.

WHY IT IS OFF UNTIL THE OPERATOR TURNS IT ON

Every other capability here is safe to ship enabled because it reads local data
and shows it on a local screen. This one is different in kind: an MCP client
sends what it reads to whoever runs it. Equity, open positions and a track
record leaving the machine is the operator's decision and nobody else's, so
`enabled()` is false until somebody says otherwise and `tools/call` refuses by
name while it is.

WHAT THE SECURITY BOUNDARY ACTUALLY IS, STATED HONESTLY

The gateway has ONE secret and it is `core._svc_token()`: `/svc/*` requires it
when `MISHEL_TOKEN` (or the `svc_token` config key) is set, and refuses
non-localhost when it is not. This module reuses that same secret rather than
inventing a second one -- two tokens for one product is two things to rotate and
one to forget.

So: **with no token configured this endpoint is reachable by any process on the
machine**, exactly like `/svc/*`, and enabling it does not change that. A token
here would be theatre while the rest of the surface has none. What IS bought,
and is not theatre:

  * OFF BY DEFAULT, so the egress path is a decision.
  * A READ-ONLY ALLOWLIST. `TOOLS` is the whole reachable surface: a name that
    is not a key is a "no such tool", so `POST /svc/store/evict` (deletes
    gigabytes) and `POST /svc/mt5/import` cannot be reached through here even
    by a caller that knows they exist. An allowlist, never a denylist -- a
    denylist grows a hole every time a route is added.
  * NO BROWSER MAY SPEAK TO IT. An MCP client is not a browser and never sends
    `Origin`; a page does, always. So ANY `Origin` at all is refused, which
    closes DNS rebinding properly instead of leaning on the gateway's
    deliberately permissive loopback regex -- under that regex a page on any
    localhost port would otherwise be able to POST here.

WHAT IT REFUSES TO PUBLISH

No secrets, ever: not `MISHEL_TOKEN`, not an MCP client's OAuth tokens, not an
`ANTHROPIC_API_KEY`. `WONT_PUBLISH` records what was considered and rejected,
with the reason, so the next person adding a tool argues with a paragraph rather
than rediscovering it.

MEASURED, NOT ASSERTED: the loopback self-test in `tests/test_mcp_server.py`
drives this server through THIS PRODUCT'S OWN CLIENT (`svc/mcp.py`), so the two
halves are checked against each other rather than against my reading of the
specification.
"""

import json
import os
import time

from db import db
from flask import Blueprint, jsonify, request

from svc import bars as _bars
from svc import core as _core
from svc import risk as _risk
from svc.core import log_event

# `_svc_token` and `cfg` are reached through `_core` at CALL time, never bound
# here: a re-exported name is a SECOND binding, and a test that patches the owner
# would never be consulted through a copy taken at import.

bp = Blueprint("mcpserve", __name__)

#: What we OFFER. A client asking for a version we know is echoed back; anything
#: else gets ours, which is what `svc/mcp.py` learned to do from the other side.
PROTOCOL = "2025-06-18"
KNOWN_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

SERVER_NAME = "iram-terminal"
SERVER_VERSION = "1"

#: The config key holding the operator's answer. Absent means no.
ON_KEY = "mcp_serve_on"

#: Considered and deliberately NOT published. Each line is an argument, not a
#: note -- the point is that adding one of these has to overturn a reason.
WONT_PUBLISH = {
    "store_evict": "deletes gigabytes of history; destructive routes are not one "
                   "call away even for the operator, let alone for a client",
    "mt5_import": "writes the operator's deal history from a file path the caller "
                  "chooses",
    "settings_write": "a client that can widen the disk budget can fill the disk",
    "notify": "the alert channel is not a surface for an AI client to send from",
    "secrets": "MISHEL_TOKEN, OAuth tokens and ANTHROPIC_API_KEY are never a tool "
               "result; a token in a message is a token in the client's logs",
    "order_send": "there is no execution path in this product at all (grep "
                  "order_send server/), and this is not where one arrives",
}


def enabled():
    """Whether the operator has turned this on. Absent config means NO."""
    try:
        return str(_core.cfg(ON_KEY) or "").strip().lower() in ("1", "true", "yes", "on")
    except Exception:
        return False


# ------------------------------------------------------------- the tools -----
# Every entry is READ-ONLY and calls a plain function that something else in the
# product already calls, so a tool cannot drift from the screen showing the same
# fact. Where only a route existed the function was lifted out (`bars.read_bars`,
# `core.events_summary`) rather than copied.

def _t_inventory(_args):
    return _bars.inventory()


def _t_bars(args):
    return _bars.read_bars(
        args.get("symbol") or args.get("sym"),
        args.get("timeframe") or args.get("tf") or "1h",
        args.get("limit") or args.get("n") or 500,
        args.get("source") or args.get("src") or "",
    )


def _t_risk(_args):
    import mishel_risk as RISK
    st = _risk.risk_state()
    return {
        "ok": True,
        "state": st,
        "config": _risk.risk_cfg(),
        "verdict": RISK.evaluate(st, None, _risk.risk_cfg()),
        "note": "equity_source names where the equity came from. When it reads "
                "'manual' the broker was not readable and the figure is one the "
                "operator typed -- not a live account balance.",
    }


def _t_track_record(args):
    import mishel_claims
    with db() as c:
        mishel_claims.init(c)
        out = mishel_claims.stats(
            c,
            symbol=args.get("symbol"),
            timeframe=args.get("timeframe"),
            since=args.get("since"),
        )
    out["note"] = (
        "A null hitRate means no claim has been DECIDED yet, which is not a zero "
        "hit rate. Rates carry an interval; a wide one is a small sample."
    )
    return out


def _t_jobs(_args):
    return _core.events_summary()


#: name -> (description, inputSchema, fn). THE WHOLE REACHABLE SURFACE.
TOOLS = {
    "history_inventory": (
        (
            "What market history this terminal holds on disk, per series: the "
            "source, symbol, bar size, bar count and the oldest and newest bar. "
            "Answers 'what can I backtest on'."
        ),
        {"type": "object", "properties": {}},
        _t_inventory,
    ),
    "bars": (
        (
            "OHLC bars for one series from the durable archive, oldest first. "
            "Returns only what is HELD -- it does not fetch from a vendor, so an "
            "empty list means the history is not stored, not that the market has "
            "no data."
        ),
        {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "e.g. BTCUSDT, XAUUSD"},
                "timeframe": {"type": "string", "description": "e.g. 1m, 5m, 1h, 1d"},
                "limit": {"type": "integer", "description": "newest N bars; capped by the server"},
                "source": {"type": "string", "description": "optional vendor filter, e.g. binance, mt5"},
            },
            "required": ["symbol"],
        },
        _t_bars,
    ),
    "risk_state": (
        (
            "The account as the risk desk sees it: equity and where that figure came "
            "from, open positions, portfolio heat, and the verdict on whether a new "
            "trade is allowed under the operator's own rules."
        ),
        {"type": "object", "properties": {}},
        _t_risk,
    ),
    "track_record": (
        (
            "How the machine's past stated reads actually worked out: hit rate with "
            "a confidence interval, expectancy in R, and the reliability curve. "
            "Optionally narrowed to one symbol or timeframe."
        ),
        {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "timeframe": {"type": "string"},
                "since": {"type": "string", "description": "ISO date or epoch ms"},
            },
        },
        _t_track_record,
    ),
    "background_jobs": (
        (
            "The standing of the terminal's background jobs: which have failed and "
            "how many times over the whole log, which have gone quiet, and which are "
            "waiting on a credential only the operator can supply."
        ),
        {"type": "object", "properties": {}},
        _t_jobs,
    ),
}


def tool_list():
    """The `tools/list` payload, built from `TOOLS` so it cannot disagree."""
    return [
        {"name": name, "description": desc, "inputSchema": schema}
        for name, (desc, schema, _fn) in sorted(TOOLS.items())
    ]


# ------------------------------------------------------------------ auth -----

def _authorised():
    """(ok, reason). Mirrors `mishel_service._auth_guard`'s policy on the ONE
    secret, and additionally refuses every browser.

    Returns the reason as a sentence the operator can act on. It never names the
    token or any part of it.
    """
    # A browser always sends Origin; an MCP client never does. So any Origin at
    # all means a page is calling, and no page has business here. This is the
    # DNS-rebinding guard, and it is deliberately stricter than the gateway's
    # loopback regex, under which a page on any localhost port would pass.
    if request.headers.get("Origin"):
        return False, ("this endpoint refuses browsers: an MCP client sends no "
                       "Origin header, and a page that does cannot be one")

    tok = _core._svc_token()
    if tok:
        auth = request.headers.get("Authorization") or ""
        bearer = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
        got = bearer or request.headers.get("X-Mishel-Token") or request.args.get("token")
        if got != tok:
            return False, ("this terminal has a token set, so an MCP client must "
                           "send it as 'Authorization: Bearer <token>'")
        return True, ""

    ra = request.remote_addr or ""
    if ra not in ("127.0.0.1", "::1", "localhost"):
        return False, ("no token is configured, so only this machine may connect. "
                       "Set MISHEL_TOKEN to allow a client from elsewhere.")
    return True, ""


# ------------------------------------------------------------- JSON-RPC ------

def _err(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _text_result(payload, is_error=False):
    """A tool result: prose-wrapping-JSON, which is the shape `svc/mcp.py
    embedded_json` reads. The two halves of this product agree by construction."""
    return {
        "content": [{"type": "text", "text": json.dumps(payload, default=str)}],
        "isError": bool(is_error),
    }


def handle(msg):
    """One JSON-RPC message in, one response dict out (or None for a
    notification). Pure apart from the tools it calls, so the tests drive it
    directly as well as over HTTP."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _err(None, -32600, "not a JSON-RPC 2.0 message")
    rid = msg.get("id")
    method = msg.get("method") or ""
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    # A notification has no id and takes no response.
    if rid is None and method.startswith("notifications/"):
        return None

    if method == "initialize":
        asked = (params.get("protocolVersion") or "").strip()
        return _ok(rid, {
            "protocolVersion": asked if asked in KNOWN_PROTOCOLS else PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": (
                "This is a trading terminal's own data, read-only. Figures are "
                "measured or they refuse: a null rate means undecided, not zero, "
                "and an empty bar list means the history is not stored here."
            ),
        })

    if method == "ping":
        return _ok(rid, {})

    if method == "tools/list":
        return _ok(rid, {"tools": tool_list()})

    if method == "tools/call":
        return _call(rid, params)

    return _err(rid, -32601, "no such method: %s" % (method or "(none)"))


def _call(rid, params):
    name = (params.get("name") or "").strip()
    args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}

    # The enabled check is HERE, not only on the transport, so there is no
    # spelling of a call that runs a tool while the operator has it switched off.
    if not enabled():
        return _ok(rid, _text_result({
            "ok": False,
            "err": "this terminal's MCP server is switched off. Turn it on in the "
                   "terminal: the System desk, under 'Publish to an AI client' "
                   "-- it is off by default because connecting a client sends "
                   "account figures to it.",
        }, is_error=True))

    entry = TOOLS.get(name)
    if entry is None:
        why = WONT_PUBLISH.get(name)
        msg = "no such tool: %s" % (name or "(none)")
        if why:
            msg = "%s is deliberately not published: %s" % (name, why)
        return _ok(rid, _text_result({"ok": False, "err": msg,
                                      "available": sorted(TOOLS)}, is_error=True))

    started = time.time()
    try:
        out = entry[2](args)
    except Exception as e:
        # The OPERATOR'S sentence, not the developer's: the raw goes to the log.
        log_event("mcpserve_err", "tool %s failed: %s" % (name, e))
        return _ok(rid, _text_result({
            "ok": False,
            "err": "the terminal could not answer '%s' just now; the reason is in "
                   "its event log" % name,
        }, is_error=True))
    if isinstance(out, dict):
        out.setdefault("tookMs", int((time.time() - started) * 1000))
    return _ok(rid, _text_result(out, is_error=not (isinstance(out, dict) and out.get("ok", True))))


# ----------------------------------------------------------------- routes ----

@bp.post("/mcp")
def mcp_endpoint():
    allowed, why = _authorised()
    if not allowed:
        return jsonify(_err(None, -32600, why)), 403

    raw = request.get_data(as_text=True) or ""
    try:
        msg = json.loads(raw) if raw.strip() else None
    except ValueError:
        return jsonify(_err(None, -32700, "the request body is not JSON")), 400
    if msg is None:
        return jsonify(_err(None, -32600, "empty request body")), 400

    # A batch is a list. Notifications drop out of the reply, and a batch of
    # nothing but notifications is a 202 with no body, per the transport.
    if isinstance(msg, list):
        out = [r for r in (handle(m) for m in msg) if r is not None]
        return ("", 202) if not out else jsonify(out)

    res = handle(msg)
    return ("", 202) if res is None else jsonify(res)


@bp.get("/mcp")
def mcp_get():
    """The transport allows a GET that opens an SSE stream for server-initiated
    messages. This server never initiates one, so it says so by name rather than
    holding a connection open that will never carry anything."""
    return jsonify(_err(None, -32601, (
        "this server does not open a server-to-client stream; POST JSON-RPC "
        "messages to this same address"
    ))), 405


@bp.get("/svc/mcp/serve/state")
def serve_state():
    """Whether it is on, what it publishes, and the exact config a client needs.

    The snippet is built from the SAME values the endpoint uses, so it cannot
    describe a server that is not there.
    """
    port = os.environ.get("IRAM_PORT") or os.environ.get("PORT") or "8787"
    url = "http://127.0.0.1:%s/mcp" % port
    has_token = bool(_core._svc_token())
    return jsonify(
        ok=True,
        on=enabled(),
        url=url,
        tools=tool_list(),
        wontPublish=[{"name": k, "why": v} for k, v in sorted(WONT_PUBLISH.items())],
        tokenRequired=has_token,
        reach=("any process on this machine" if not has_token
               else "a client that sends this terminal's token"),
        clientConfig={
            "mcpServers": {
                SERVER_NAME: dict(
                    {"url": url},
                    **({"headers": {"Authorization": "Bearer <your MISHEL_TOKEN>"}}
                       if has_token else {}),
                )
            }
        },
    )


@bp.post("/svc/mcp/serve/enable")
def serve_enable():
    """Turn it on or off. The operator's decision, recorded and logged, because
    a capability that sends account figures off the machine should leave a trace
    of when it was switched on."""
    # `get_json(silent=True) or {}` turned an UNPARSEABLE body into `{}`, and
    # `bool({}.get("on"))` is False -- so garbage silently switched the server
    # OFF and answered 200 as though the operator had asked. Failing to the safe
    # side is not the same as understanding the request. Found by
    # `scratchpad/postrefuse.py`.
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "on" not in body:
        return jsonify(ok=False, err="say {\"on\": true} or {\"on\": false}"), 400
    want = bool(body.get("on"))
    # The `config` TABLE, because that is the one `core.cfg` reads. The first
    # version wrote `kvstore` -- a store nothing consults for a config key -- so
    # the switch reported success and `enabled()` stayed false. The test caught
    # it; "A KEY WRITTEN BY ONE SIDE AND READ BY THE OTHER MUST BE THE SAME KEY".
    with db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (ON_KEY, "1" if want else "0"),
        )
    # Announced AFTER the transaction closes: a nested write asks for the lock
    # this thread is holding, and the rollback is the real damage.
    log_event("mcpserve", "MCP server turned %s by the operator" % ("on" if want else "off"))
    return jsonify(ok=True, on=want)
