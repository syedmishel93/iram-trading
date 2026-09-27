"""Probe a Streamable HTTP MCP server: initialize, initialized, tools/list.

Written to a FILE and run, per CLAUDE.md -- a heredoc mangles escapes.

What this is establishing, before any of it is designed:
  * whether the reply is application/json or text/event-stream (both are legal
    for Streamable HTTP, and a client that assumes one breaks on the other)
  * whether the server issues `Mcp-Session-Id`, which must then be echoed
  * what a real tool schema looks like, so an adapter is written against the
    thing rather than against a description of it
"""

import json
import sys

import httpx

URL = sys.argv[1] if len(sys.argv) > 1 else "https://mcp.crypto.com/market-data/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def body(r):
    """A Streamable HTTP reply is EITHER json OR an SSE stream of json."""
    ct = r.headers.get("content-type", "")
    if "text/event-stream" in ct:
        for line in r.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return None
    return r.json()


def rpc(c, url, method, params=None, sid=None, notify=False):
    msg = {"jsonrpc": "2.0", "method": method}
    if not notify:
        msg["id"] = 1
    if params is not None:
        msg["params"] = params
    h = dict(HDR)
    if sid:
        h["Mcp-Session-Id"] = sid
    r = c.post(url, json=msg, headers=h, timeout=30)
    return r


with httpx.Client(follow_redirects=True) as c:
    r = rpc(c, URL, "initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "iram-probe", "version": "0"},
    })
    print("initialize      ", r.status_code, r.headers.get("content-type"))
    sid = r.headers.get("mcp-session-id")
    print("session id      ", sid)
    init = body(r)
    got = (init or {}).get("result", {})
    print("protocol        ", got.get("protocolVersion"))
    print("serverInfo      ", json.dumps(got.get("serverInfo"), indent=2)[:400])
    print("capabilities    ", json.dumps(got.get("capabilities")))

    rpc(c, URL, "notifications/initialized", sid=sid, notify=True)

    r = rpc(c, URL, "tools/list", {}, sid=sid)
    print("tools/list      ", r.status_code)
    tools = (body(r) or {}).get("result", {}).get("tools", [])
    print("TOOL COUNT      ", len(tools))
    if not tools:
        print("FAIL: parsed zero tools -- the pattern is wrong, not the server")
        print((r.text or "")[:600])
        sys.exit(2)
    for t in tools:
        req = t.get("inputSchema", {}).get("required", [])
        props = list(t.get("inputSchema", {}).get("properties", {}).keys())
        print("  %-26s req=%-34s props=%s" % (t["name"], ",".join(req), ",".join(props)[:90]))
