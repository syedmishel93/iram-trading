#!/usr/bin/env python3
"""THE MCP ENGINE — `server/svc/mcp.py`.

Every case below was taken from a LIVE server on 2026-09-25, not invented. The
probe is `scratchpad/mcpprobe.py`; these pin what it found so the next change
cannot quietly undo it.

WHAT IS PINNED, AND WHAT IT COST TO LEARN

1. THE REPLY IS EITHER JSON OR AN SSE STREAM. `mcp.crypto.com` — the only
   market-data MCP server that answers without an account, and therefore the
   only one this project can verify against — replies to a unary `initialize`
   with `content-type: text/event-stream`. A client calling `r.json()` fails
   against it. Both framings are pinned, because a fix for one is how the other
   breaks.

2. AN SSE EVENT MAY CARRY SEVERAL `data:` LINES AND THEY ARE JOINED. A parser
   taking only the first truncates every message large enough to be split —
   which is every message worth having. Pinned with a split payload that a
   first-line parser reads as invalid JSON.

3. THE SERVER'S PROTOCOL VERSION WINS. MEASURED: offered `2025-06-18`, told
   `2025-03-26`. A client that insists on its own cannot talk to the one server
   available to test it.

4. `Mcp-Session-Id` IS OPTIONAL. Crypto.com issues none. A client that requires
   one refuses a working server — the same shape as `/svc/health` painting
   "0 of 0 running" green, from the other direction: treating absent as broken.

5. AN EXPIRED SESSION ANSWERS 404, WHICH MEANS "HANDSHAKE AGAIN". Reporting it
   as a dead server is a refusal the operator cannot act on, for a connection
   one request from working.

6. A TOOL FAILURE ARRIVES INSIDE A 200. `isError` is the server saying the tool
   failed with a successful HTTP call around it. A count of what ANSWERED is not
   a count of what WORKED — this project's most repeated lesson.

7. A 401 IS A ROUTE TO SIGNING IN, NOT A DEAD END. Both authenticated servers
   advertise `WWW-Authenticate: Bearer resource_metadata="..."`, which is the
   whole OAuth discovery entry point. Dropping it turns a solvable state into
   "this does not work".

NO NETWORK. Every request goes through `svc.mcp._open`, which exists so that one
patch reaches all of them. The patch targets `sys.modules["svc.mcp"]`, never the
facade: a re-export is a second binding, and patching it tests the real thing
while reporting success — which this project has already paid for once.

Run:  python -m pytest tests/test_mcp_client.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

# A throwaway database, set BEFORE the service imports, which is the only moment
# it can be set. Four test files once wrote to the operator's live mishel.db.
_TMP = tempfile.mkdtemp(prefix="iram-mcp-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import httpx
import mishel_service as svc

mcp = sys.modules["svc.mcp"]

URL = "https://example.test/mcp"

INIT_RESULT = {
    "protocolVersion": "2025-03-26",
    "capabilities": {"tools": {}},
    "serverInfo": {"name": "Test MCP", "title": "Test MCP", "version": "0.1.0"},
}


def sse(payload: dict, split: bool = False) -> httpx.Response:
    """An SSE-framed reply. `split` spreads the JSON over several `data:` lines."""
    if split:
        # Split on newlines the SERVER wrote, which is the only way a real one
        # splits. Cutting a serialised object at len//2 lands mid-token, and
        # rejoining with "\n" -- which is what SSE specifies -- cannot restore
        # that. The first version of this fixture corrupted its own payload and
        # then blamed the parser.
        body = json.dumps(payload, indent=2)
        data = "\n".join("data: %s" % ln for ln in body.splitlines())
    else:
        data = "data: %s" % json.dumps(payload)
    return httpx.Response(200, text="event: message\n%s\n\n" % data,
                          headers={"content-type": "text/event-stream"})


def js(payload: dict, status: int = 200, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, json=payload,
                          headers={"content-type": "application/json", **(headers or {})})


class Server:
    """A scripted MCP server. Records what it was SENT, which is the assertion."""

    def __init__(self, framing: str = "sse", session: str | None = None):
        self.framing = framing
        self.session = session
        self.seen: list[dict] = []
        self.tool_reply: dict | None = None
        self.expire_once = False
        self.expiries = 0

    def reply(self, payload: dict) -> httpx.Response:
        r = sse(payload) if self.framing == "sse" else js(payload)
        if self.session:
            r.headers["mcp-session-id"] = self.session
        return r

    def __call__(self, request: httpx.Request) -> httpx.Response:
        msg = json.loads(request.content)
        self.seen.append({
            "method": msg.get("method"),
            "session": request.headers.get("mcp-session-id"),
            "protocol": request.headers.get("mcp-protocol-version"),
            "auth": request.headers.get("authorization"),
            "params": msg.get("params"),
        })
        method = msg.get("method")

        if method == "initialize":
            return self.reply({"jsonrpc": "2.0", "id": msg["id"], "result": INIT_RESULT})
        if method == "notifications/initialized":
            return httpx.Response(202)

        # Expires ONCE, ever. Resetting this on `initialize` made the retry's
        # request expire as well, so the test could not tell "retries once" from
        # "does not retry at all" -- it only ever saw the refusal.
        if self.expire_once and self.expiries == 0:
            self.expiries += 1
            return httpx.Response(404, text="session expired")

        if method == "tools/list":
            return self.reply({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [
                {"name": "get_candlestick", "description": "candles",
                 "inputSchema": {"required": ["instrument_name"],
                                 "properties": {"instrument_name": {}, "timeframe": {}}}},
            ]}})
        if method == "tools/call":
            return self.reply({"jsonrpc": "2.0", "id": msg["id"],
                               "result": self.tool_reply or {"content": [
                                   {"type": "text", "text": "ok"}]}})
        return self.reply({"jsonrpc": "2.0", "id": msg.get("id"),
                           "error": {"code": -32601, "message": "method not found"}})


class McpBase(unittest.TestCase):
    def setUp(self):
        # Sessions are cached per URL for the rate limits of real servers. That
        # is module state, so it must not leak between tests.
        mcp._SESSIONS.clear()

    def serve(self, handler):
        def _open():
            return httpx.Client(transport=httpx.MockTransport(handler))
        return mock.patch.object(mcp, "_open", _open)


class Transport(McpBase):
    def test_an_sse_reply_is_read(self):
        """MEASURED framing: the only free server answers a unary call with SSE."""
        s = Server(framing="sse")
        with self.serve(s):
            got = mcp.handshake(URL)
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["name"], "Test MCP")

    def test_a_plain_json_reply_is_read(self):
        """Also legal, and a fix for SSE is how this one breaks."""
        s = Server(framing="json")
        with self.serve(s):
            got = mcp.handshake(URL)
        self.assertTrue(got["ok"], got)

    def test_a_split_sse_event_is_joined_not_truncated(self):
        """Several `data:` lines are ONE message. Taking the first is invalid JSON."""
        payload = {"jsonrpc": "2.0", "id": 1, "result": INIT_RESULT}
        framed = sse(payload, split=True).text
        self.assertGreater(framed.count("data:"), 5, "the fixture must really be split")
        self.assertEqual(mcp._sse_messages(framed), [payload])

        # And the single line a first-line-only parser would keep is NOT a
        # message. Without this the test passes on a parser that truncates,
        # which is the entire defect it exists for.
        one = next(ln for ln in framed.splitlines() if ln.startswith("data:"))
        self.assertEqual(mcp._sse_messages(one + "\n\n"), [])


class Negotiation(McpBase):
    def test_the_servers_protocol_version_wins(self):
        s = Server()
        with self.serve(s):
            got = mcp.handshake(URL)
        self.assertEqual(mcp.PROTOCOL, "2025-06-18", "what we OFFER")
        self.assertEqual(got["protocol"], "2025-03-26", "what the SERVER said must be used")
        self.assertEqual(s.seen[0]["params"]["protocolVersion"], "2025-06-18")
        # ...and the negotiated one is what goes back out.
        self.assertEqual(s.seen[1]["protocol"], "2025-03-26")

    def test_a_server_that_issues_no_session_id_is_not_refused(self):
        s = Server(session=None)
        with self.serve(s):
            got = mcp.tools(URL)
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["count"], 1)
        self.assertIsNone(s.seen[-1]["session"], "no header may be sent when none was issued")

    def test_a_session_id_is_echoed_when_one_is_issued(self):
        s = Server(session="abc123")
        with self.serve(s):
            got = mcp.tools(URL)
        self.assertTrue(got["ok"], got)
        self.assertEqual(s.seen[-1]["session"], "abc123")

    def test_an_expired_session_handshakes_again_rather_than_refusing(self):
        """404 is the spec's "handshake again", not a dead server."""
        s = Server(session="abc123")
        s.expire_once = True
        with self.serve(s):
            got = mcp.tools(URL)
        self.assertTrue(got["ok"], got)
        self.assertEqual([x["method"] for x in s.seen].count("initialize"), 2)

    def test_a_token_is_sent_as_a_bearer_header(self):
        s = Server()
        with self.serve(s):
            mcp.tools(URL, token="tok-123")
        self.assertEqual(s.seen[0]["auth"], "Bearer tok-123")


class Refusals(McpBase):
    def test_a_jsonrpc_error_is_a_refusal_not_a_raise(self):
        s = Server()
        with self.serve(s):
            got = mcp._rpc(URL, "no/such", {}, None)
        self.assertFalse(got["ok"])
        self.assertIn("method not found", got["why"])

    def test_a_401_carries_the_sign_in_route(self):
        """The `resource_metadata` URL IS the OAuth discovery entry point."""
        hint = "https://example.test/.well-known/oauth-protected-resource/mcp"

        def handler(request):
            return httpx.Response(
                401, json={"detail": "auth required"},
                headers={"www-authenticate": 'Bearer resource_metadata="%s"' % hint},
            )

        with self.serve(handler):
            got = mcp.handshake(URL)
        self.assertFalse(got["ok"])
        self.assertTrue(got["needsAuth"])
        self.assertEqual(got["resourceMetadata"], hint)
        self.assertIn("sign in", got["why"])

    def test_a_401_with_no_hint_still_asks_for_a_sign_in(self):
        with self.serve(lambda r: httpx.Response(401, text="nope")):
            got = mcp.handshake(URL)
        self.assertTrue(got["needsAuth"])
        self.assertIsNone(got["resourceMetadata"])

    def test_a_tool_failure_inside_a_200_is_a_refusal(self):
        """`isError` is the tool failing with a successful HTTP call around it."""
        s = Server()
        s.tool_reply = {"isError": True,
                        "content": [{"type": "text", "text": "instrument not listed"}]}
        with self.serve(s):
            got = mcp.call_tool(URL, "get_candlestick", {"instrument_name": "NOPE"})
        self.assertFalse(got["ok"])
        self.assertIn("instrument not listed", got["why"])

    def test_an_unreachable_server_names_itself(self):
        def handler(request):
            raise httpx.ConnectError("no route")

        with self.serve(handler):
            got = mcp.handshake(URL)
        self.assertFalse(got["ok"])
        self.assertIn("could not reach", got["why"])
        self.assertFalse(got["needsAuth"], "unreachable is not the same as unauthenticated")

    def test_an_unreadable_body_is_a_refusal(self):
        with self.serve(lambda r: httpx.Response(200, text="<html>not mcp</html>")):
            got = mcp.handshake(URL)
        self.assertFalse(got["ok"])

    def test_a_vendor_already_wired_over_rest_is_refused_by_name(self):
        """A second owner for one fact. The reason travels with the refusal."""
        for host in ("mcp.twelvedata.com", "mcp.alphavantage.co"):
            got = mcp.handshake("https://%s/mcp" % host)
            self.assertFalse(got["ok"], host)
            self.assertIn("already", got["why"], host)


class EmbeddedJson(unittest.TestCase):
    """A TOOL RESULT IS PROSE WRAPPING JSON.

    This is the defect that broke the probe written to read it, on the first real
    call this engine ever made. The bare-parse assertion is the important one:
    without it the test passes whatever the parser does.
    """

    REAL = ('Here is the Crypto.com Exchange candlestick data '
            '{"instrument_name":"BTC_USD","timeframe":"1h","data":'
            '[{"open":"84719.82","close":"84879.90","timestamp":"2026-09-25T11:00:00Z"}]}')

    def test_a_bare_json_loads_fails_on_the_real_answer(self):
        with self.assertRaises(ValueError):
            json.loads(self.REAL)

    def test_the_embedded_object_is_found_and_the_prose_kept(self):
        got = mcp.embedded_json(self.REAL)
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["data"]["instrument_name"], "BTC_USD")
        self.assertEqual(got["prose"], "Here is the Crypto.com Exchange candlestick data")

    def test_a_trailing_sentence_does_not_break_it(self):
        got = mcp.embedded_json('Data: {"a": 1} Let me know if you need more.')
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["data"], {"a": 1})
        self.assertIn("Let me know", got["prose"])

    def test_a_json_array_is_found_too(self):
        got = mcp.embedded_json('Here you go: [1, 2, 3]')
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["data"], [1, 2, 3])

    def test_prose_with_no_json_refuses_rather_than_returning_empty(self):
        got = mcp.embedded_json("I could not find that instrument.")
        self.assertFalse(got["ok"])
        self.assertIn("no JSON", got["why"])

    def test_no_text_at_all_refuses(self):
        self.assertFalse(mcp.embedded_json("")["ok"])

    def test_malformed_json_refuses_and_is_never_repaired(self):
        got = mcp.embedded_json('data {"a": ')
        self.assertFalse(got["ok"])
        self.assertIn("did not parse", got["why"])


class Registry(McpBase):
    def setUp(self):
        super().setUp()
        with svc.db() as c:
            c.execute("DELETE FROM config WHERE k=?", (mcp.CFG_KEY,))

    def test_a_server_is_added_and_removed(self):
        self.assertEqual(mcp.servers(), [])
        got = mcp.add_server("Crypto.com", "https://mcp.crypto.com/market-data/mcp")
        self.assertTrue(got["ok"], got)
        self.assertEqual([r["name"] for r in mcp.servers()], ["Crypto.com"])
        self.assertTrue(mcp.remove_server("https://mcp.crypto.com/market-data/mcp")["ok"])
        self.assertEqual(mcp.servers(), [])

    def test_the_same_address_is_not_added_twice(self):
        mcp.add_server("a", "https://one.test/mcp")
        got = mcp.add_server("also a", "https://one.test/mcp")
        self.assertFalse(got["ok"])
        self.assertEqual(len(mcp.servers()), 1)

    def test_a_plain_http_address_is_refused(self):
        """A bearer token over http is a token on the wire in clear."""
        got = mcp.add_server("insecure", "http://somewhere.test/mcp")
        self.assertFalse(got["ok"])
        self.assertIn("https", got["why"])

    def test_removing_something_not_on_the_list_says_so(self):
        self.assertFalse(mcp.remove_server("https://never.test/mcp")["ok"])


class Routes(McpBase):
    def setUp(self):
        super().setUp()
        svc.app.config["TESTING"] = True
        with svc.db() as c:
            c.execute("DELETE FROM config WHERE k=?", (mcp.CFG_KEY,))

    def client(self):
        return svc.app.test_client()

    def test_the_registry_route_answers(self):
        with self.client() as c:
            r = c.get("/svc/mcp/servers")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])
        self.assertEqual(r.get_json()["servers"], [])

    def test_a_call_with_no_tool_named_refuses(self):
        with self.client() as c:
            r = c.post("/svc/mcp/call", json={"url": URL})
        self.assertFalse(r.get_json()["ok"])

    def test_arguments_that_are_not_an_object_are_refused(self):
        with self.client() as c:
            r = c.post("/svc/mcp/call", json={"url": URL, "tool": "x", "arguments": [1, 2]})
        self.assertFalse(r.get_json()["ok"])
        self.assertIn("object", r.get_json()["why"])

    def test_the_tools_route_reports_a_refusal_rather_than_500ing(self):
        with self.serve(lambda r: httpx.Response(401, text="nope")), self.client() as c:
            r = c.get("/svc/mcp/tools", query_string={"url": URL})
        self.assertEqual(r.status_code, 200, "a refusal is a RESULT, not a server error")
        body = r.get_json()
        self.assertFalse(body["ok"])
        self.assertTrue(body["needsAuth"])
        self.assertEqual(body["tools"], [], "a refusal still answers the shape the card reads")


if __name__ == "__main__":
    unittest.main(verbosity=2)
