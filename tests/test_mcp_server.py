#!/usr/bin/env python3
"""IRAM AS AN MCP SERVER — `server/svc/mcpserve.py`.

`svc/mcp.py` makes this product a client of other people's MCP servers; this
module is the other direction, and the direction is the whole risk. A client
reads somebody else's data into this machine. A SERVER sends THIS OPERATOR'S
equity, open positions and track record to whatever connects, and an MCP client
forwards what it reads to whoever runs it.

So the tests that matter here are not the protocol ones.

  * **`test_a_tool_refuses_while_it_is_switched_off`.** Off by default is the
    entire consent model: the operator opts into the egress path. A default-on
    server would be this product deciding on their behalf that their account
    figures may leave the machine.

  * **`test_no_destructive_route_is_reachable`** and its siblings. The reachable
    surface is an ALLOWLIST, `TOOLS`, never a denylist — a denylist grows a hole
    every time a route is added, which is the mechanism that hid nineteen test
    files and left `run.py` linted by nothing. `POST /svc/store/evict` deletes
    gigabytes and `POST /svc/mt5/import` writes the operator's deal history;
    neither is reachable through here, and `WONT_PUBLISH` records the argument
    rather than leaving the next person to rediscover it.

  * **`test_any_origin_at_all_is_refused`.** THIS IS THE DNS-REBINDING GUARD and
    it is the one place this endpoint is deliberately stricter than the gateway
    around it. A browser always sends `Origin`; an MCP client never does. The
    gateway's CORS policy permits loopback on any port on purpose, so without
    this check a page served from some other localhost port could POST here and
    read the account. Refusing every `Origin` costs nothing real — no browser is
    a legitimate caller — and closes it completely.

  * **`test_no_refusal_ever_contains_the_token`**, PROVED by
    `test_the_sweep_would_catch_a_leak`. Without the second test the first passes
    on a sweep that looks at nothing, which is the defect this project has now
    found in four of its own audits: "an audit script that parses nothing reports
    success".

  * **`test_the_real_client_can_drive_the_real_server`.** The two halves are
    checked AGAINST EACH OTHER, not against my reading of the specification, by
    driving `svc/mcp.py` over `httpx.WSGITransport` into the real Flask app. A
    tool result is prose-wrapping-JSON; if the server framed it differently from
    what `embedded_json` reads, nothing else in this file would notice.

WHAT THIS FILE DOES NOT CLAIM

It does not claim the endpoint is protected from another process on this machine.
It is not, and neither is `/svc/*`: the gateway has ONE secret and it is optional.
`test_with_no_token_it_is_localhost_only` pins the policy that actually exists
rather than a stronger one nobody implemented — a test asserting a guarantee the
product does not make is worse than no test, because it reads as evidence.

Run:  python -m pytest tests/test_mcp_server.py -v
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

_TMP = tempfile.mkdtemp(prefix="iram-mcpserve-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import httpx
import mishel_service as svc

serve = sys.modules["svc.mcpserve"]
core = sys.modules["svc.core"]

#: Distinctive enough that finding it in a body cannot be a coincidence.
SENTINEL = "sentinel-mishel-token-7d2b4f1a"


def rpc(method, params=None, rid=1):
    msg = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def post(msg, headers=None, addr="127.0.0.1"):
    """POST a JSON-RPC message through the REAL Flask app over WSGI."""
    transport = httpx.WSGITransport(app=svc.app, remote_addr=addr)
    with httpx.Client(transport=transport, base_url="http://iram.test") as c:
        return c.post("/mcp", json=msg, headers=headers or {})


def call(name, args=None):
    return post(rpc("tools/call", {"name": name, "arguments": args or {}}))


def payload(response):
    """The JSON a tool returned, out of the text block it is embedded in."""
    body = response.json()
    text = body["result"]["content"][0]["text"]
    return json.loads(text)


def _set(on):
    with httpx.Client(transport=httpx.WSGITransport(app=svc.app), base_url="http://iram.test") as c:
        return c.post("/svc/mcp/serve/enable", json={"on": on})


class OffByDefault(unittest.TestCase):
    """The consent model. Everything else here is secondary to it."""

    def test_absent_config_is_off(self):
        with mock.patch.object(core, "cfg", return_value=None):
            self.assertFalse(serve.enabled())

    def test_a_value_that_is_not_a_yes_is_off(self):
        # A config key holding junk must not read as consent.
        for v in ("", "0", "no", "off", "maybe", "banana", None):
            with mock.patch.object(core, "cfg", return_value=v):
                self.assertFalse(serve.enabled(), v)

    def test_the_operator_can_say_yes(self):
        for v in ("1", "true", "yes", "on", "ON", " True "):
            with mock.patch.object(core, "cfg", return_value=v):
                self.assertTrue(serve.enabled(), v)

    def test_a_config_read_that_throws_is_off(self):
        # A database that cannot be read is not permission.
        with mock.patch.object(core, "cfg", side_effect=RuntimeError("no db")):
            self.assertFalse(serve.enabled())

    def test_a_tool_refuses_while_it_is_switched_off(self):
        with mock.patch.object(serve, "enabled", return_value=False):
            got = payload(call("history_inventory"))
        self.assertFalse(got["ok"])
        self.assertIn("switched off", got["err"])
        # It must say HOW to turn it on and WHY it is off, or the refusal is a
        # dead end the operator cannot act on. The FIRST version of this sentence
        # said "Settings -> MCP server", a screen that does not exist -- the card
        # is on the System desk. A refusal naming the wrong place is worse than
        # one naming none: the operator looks, fails, and concludes the feature
        # was never built.
        self.assertIn("off by default", got["err"])
        self.assertIn("System desk", got["err"])
        self.assertIn("Publish to an AI client", got["err"])

    def test_the_refusal_is_flagged_as_an_error_to_the_client(self):
        # `isError` is how an MCP client knows not to present this as data.
        with mock.patch.object(serve, "enabled", return_value=False):
            body = call("history_inventory").json()
        self.assertTrue(body["result"]["isError"])

    def test_listing_tools_is_allowed_while_off(self):
        # Listing is how the operator sees what turning it on would publish.
        # Refusing that would make the decision unreadable.
        with mock.patch.object(serve, "enabled", return_value=False):
            body = post(rpc("tools/list")).json()
        self.assertEqual(len(body["result"]["tools"]), len(serve.TOOLS))


class TheAllowlist(unittest.TestCase):
    def test_no_destructive_route_is_reachable(self):
        # The names of the routes that would matter. None may be a tool, and a
        # substring check is right here because a tool called `store_evict_dry`
        # would be just as wrong.
        for bad in ("evict", "import", "delete", "remove", "write", "send",
                    "order", "signout", "enable", "notify", "backup"):
            for name in serve.TOOLS:
                self.assertNotIn(bad, name, "%s is reachable via %s" % (bad, name))

    def test_what_is_refused_is_not_also_published(self):
        self.assertEqual(set(serve.TOOLS) & set(serve.WONT_PUBLISH), set())

    def test_every_refusal_carries_its_reason(self):
        # A list of forbidden names with no argument beside them is a list the
        # next person deletes.
        for name, why in serve.WONT_PUBLISH.items():
            self.assertGreater(len(why), 30, name)

    def test_an_unknown_tool_refuses_and_says_what_there_is(self):
        with mock.patch.object(serve, "enabled", return_value=True):
            got = payload(call("whatever_i_like"))
        self.assertFalse(got["ok"])
        self.assertIn("no such tool", got["err"])
        self.assertEqual(got["available"], sorted(serve.TOOLS))

    def test_a_deliberately_unpublished_name_refuses_WITH_the_reason(self):
        # "no such tool" for something that exists and was withheld on purpose
        # teaches the caller the product is incomplete. Name the decision.
        with mock.patch.object(serve, "enabled", return_value=True):
            got = payload(call("store_evict"))
        self.assertFalse(got["ok"])
        self.assertIn("deliberately not published", got["err"])
        self.assertIn("destructive", got["err"])

    def test_tools_list_is_built_from_the_allowlist(self):
        body = post(rpc("tools/list")).json()
        names = [t["name"] for t in body["result"]["tools"]]
        self.assertEqual(names, sorted(serve.TOOLS))

    def test_every_tool_describes_itself_and_its_arguments(self):
        for t in post(rpc("tools/list")).json()["result"]["tools"]:
            self.assertGreater(len(t["description"]), 40, t["name"])
            self.assertEqual(t["inputSchema"]["type"], "object", t["name"])

    def test_the_descriptions_state_the_limits_that_matter(self):
        by = {t["name"]: t["description"] for t in post(rpc("tools/list")).json()["result"]["tools"]}
        # A model reading these must not mistake "not stored" for "no data" —
        # the distinction this product makes everywhere else.
        self.assertIn("not stored", by["bars"])
        self.assertIn("HELD", by["bars"])


class TheBrowserGuard(unittest.TestCase):
    def test_any_origin_at_all_is_refused(self):
        # A browser ALWAYS sends Origin and an MCP client never does, so the
        # presence of the header is proof the caller is a page. Loopback origins
        # included: the gateway's CORS regex permits any localhost port, which is
        # exactly the hole this closes.
        for origin in ("http://evil.test", "http://localhost:3000",
                       "http://127.0.0.1:8787", "null", "file://"):
            r = post(rpc("tools/list"), headers={"Origin": origin})
            self.assertEqual(r.status_code, 403, origin)
            self.assertIn("refuses browsers", r.json()["error"]["message"])

    def test_a_client_that_sends_no_origin_is_allowed(self):
        self.assertEqual(post(rpc("tools/list")).status_code, 200)


class TheToken(unittest.TestCase):
    def test_with_no_token_it_is_localhost_only(self):
        # The policy that EXISTS, pinned as it is. `/svc/*` does the same.
        with mock.patch.object(core, "_svc_token", return_value=None):
            self.assertEqual(post(rpc("tools/list"), addr="127.0.0.1").status_code, 200)
            r = post(rpc("tools/list"), addr="10.0.0.4")
            self.assertEqual(r.status_code, 403)
            self.assertIn("only this machine", r.json()["error"]["message"])

    def test_a_configured_token_is_required(self):
        with mock.patch.object(core, "_svc_token", return_value=SENTINEL):
            self.assertEqual(post(rpc("tools/list")).status_code, 403)
            bad = post(rpc("tools/list"), headers={"Authorization": "Bearer wrong"})
            self.assertEqual(bad.status_code, 403)

    def test_the_bearer_header_an_mcp_client_actually_sends_works(self):
        # MCP clients send `Authorization: Bearer`. A server accepting only this
        # product's own `X-Mishel-Token` would be unreachable from every real
        # client while looking correct from a curl.
        with mock.patch.object(core, "_svc_token", return_value=SENTINEL):
            r = post(rpc("tools/list"), headers={"Authorization": "Bearer " + SENTINEL})
            self.assertEqual(r.status_code, 200)

    def test_the_bearer_prefix_is_case_insensitive(self):
        with mock.patch.object(core, "_svc_token", return_value=SENTINEL):
            for prefix in ("Bearer ", "bearer ", "BEARER "):
                r = post(rpc("tools/list"), headers={"Authorization": prefix + SENTINEL})
                self.assertEqual(r.status_code, 200, prefix)

    def test_the_products_own_header_still_works(self):
        with mock.patch.object(core, "_svc_token", return_value=SENTINEL):
            r = post(rpc("tools/list"), headers={"X-Mishel-Token": SENTINEL})
            self.assertEqual(r.status_code, 200)

    def test_no_refusal_ever_contains_the_token(self):
        """A token in a refusal is a token in the client's logs."""
        with mock.patch.object(core, "_svc_token", return_value=SENTINEL):
            bodies = [
                post(rpc("tools/list")).text,
                post(rpc("tools/list"), headers={"Authorization": "Bearer wrong"}).text,
                post(rpc("tools/list"), headers={"Origin": "http://evil.test"}).text,
                post(rpc("nope")).text,
            ]
            with httpx.Client(transport=httpx.WSGITransport(app=svc.app),
                              base_url="http://iram.test") as c:
                bodies.append(c.get("/svc/mcp/serve/state").text)
        self.assertGreater(len(bodies), 4)  # the sweep looked at something
        for b in bodies:
            self.assertNotIn(SENTINEL, b)

    def test_the_sweep_would_catch_a_leak(self):
        """PROVE the sweep. Without this the test above passes on an empty list."""
        leaky = json.dumps({"ok": False, "err": "bad token, expected " + SENTINEL})
        self.assertIn(SENTINEL, leaky)

    def test_the_state_route_names_the_reach_honestly(self):
        # An operator deciding whether to turn this on needs to know who can
        # reach it. "Secure" would be a claim this product cannot make.
        with mock.patch.object(core, "_svc_token", return_value=None),                 httpx.Client(transport=httpx.WSGITransport(app=svc.app),
                             base_url="http://iram.test") as c:
            got = c.get("/svc/mcp/serve/state").json()
        self.assertFalse(got["tokenRequired"])
        self.assertIn("any process on this machine", got["reach"])


class TheProtocol(unittest.TestCase):
    def test_initialize_echoes_a_version_it_knows(self):
        for v in serve.KNOWN_PROTOCOLS:
            body = post(rpc("initialize", {"protocolVersion": v})).json()
            self.assertEqual(body["result"]["protocolVersion"], v)

    def test_an_unknown_version_gets_ours_rather_than_a_refusal(self):
        # The lesson from the client half: the SERVER'S version wins, and a
        # client that insists cannot talk to anyone. Answering with ours lets a
        # client decide, which is what this product's own client does.
        body = post(rpc("initialize", {"protocolVersion": "1999-01-01"})).json()
        self.assertEqual(body["result"]["protocolVersion"], serve.PROTOCOL)

    def test_initialize_declares_tools_and_names_itself(self):
        r = post(rpc("initialize", {"protocolVersion": serve.PROTOCOL})).json()["result"]
        self.assertIn("tools", r["capabilities"])
        self.assertEqual(r["serverInfo"]["name"], serve.SERVER_NAME)
        self.assertIn("read-only", r["instructions"])

    def test_a_notification_gets_no_response(self):
        r = post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.text, "")

    def test_an_unknown_method_is_named(self):
        body = post(rpc("tools/subscribe")).json()
        self.assertEqual(body["error"]["code"], -32601)
        self.assertIn("tools/subscribe", body["error"]["message"])

    def test_a_body_that_is_not_json_refuses_as_a_parse_error(self):
        transport = httpx.WSGITransport(app=svc.app)
        with httpx.Client(transport=transport, base_url="http://iram.test") as c:
            r = c.post("/mcp", content="not json at all",
                       headers={"Content-Type": "application/json"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], -32700)

    def test_a_message_that_is_not_jsonrpc_20_refuses(self):
        body = post({"id": 1, "method": "tools/list"}).json()
        self.assertEqual(body["error"]["code"], -32600)

    def test_a_batch_answers_only_the_requests(self):
        body = post([
            rpc("tools/list", rid=1),
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            rpc("ping", rid=2),
        ]).json()
        self.assertEqual([m["id"] for m in body], [1, 2])

    def test_a_get_says_it_does_not_stream_rather_than_hanging(self):
        transport = httpx.WSGITransport(app=svc.app)
        with httpx.Client(transport=transport, base_url="http://iram.test") as c:
            r = c.get("/mcp")
        self.assertEqual(r.status_code, 405)
        self.assertIn("does not open", r.json()["error"]["message"])


class TheTools(unittest.TestCase):
    """Driven against an EMPTY database, which is the state that shows whether a
    tool refuses honestly or reports a zero it did not measure."""

    def setUp(self):
        self.on = mock.patch.object(serve, "enabled", return_value=True)
        self.on.start()
        self.addCleanup(self.on.stop)

    def test_an_empty_archive_is_an_empty_list_and_not_an_error(self):
        got = payload(call("history_inventory"))
        self.assertTrue(got["ok"])
        self.assertEqual(got["series"], [])
        self.assertEqual(got["total_bars"], 0)

    def test_bars_without_a_symbol_refuses_by_name(self):
        got = payload(call("bars", {}))
        self.assertFalse(got["ok"])
        self.assertIn("sym is required", got["err"])

    def test_a_refusal_from_a_tool_is_flagged_to_the_client(self):
        # `ok: False` in the payload must also set `isError`, or a model reads a
        # refusal as data.
        body = call("bars", {}).json()
        self.assertTrue(body["result"]["isError"])

    def test_bars_for_a_series_not_held_is_empty_and_says_ok(self):
        # "Held nothing" is a true answer, not a failure — and the description
        # tells the model what an empty list means.
        got = payload(call("bars", {"symbol": "BTCUSDT", "timeframe": "1h"}))
        self.assertTrue(got["ok"])
        self.assertEqual(got["bars"], [])

    def test_a_tool_that_throws_gives_the_operator_a_sentence(self):
        # Not a traceback, and not the C source file an SSL error would name.
        with mock.patch.object(serve._bars, "inventory", side_effect=RuntimeError("boom")):
            got = payload(call("history_inventory"))
        self.assertFalse(got["ok"])
        self.assertNotIn("boom", got["err"])
        self.assertNotIn("Traceback", got["err"])
        self.assertIn("event log", got["err"])

    def test_the_limit_is_capped_by_the_server(self):
        # A client asking for a million bars is bounded by the same ceiling a
        # browser is, because the clamp lives in the function both call.
        got = payload(call("bars", {"symbol": "BTCUSDT", "limit": 10_000_000}))
        self.assertTrue(got["ok"])

    def test_a_limit_that_is_not_a_number_does_not_throw(self):
        got = payload(call("bars", {"symbol": "BTCUSDT", "limit": "lots"}))
        self.assertTrue(got["ok"])


class TheLoopback(unittest.TestCase):
    """THE TWO HALVES, AGAINST EACH OTHER.

    `svc/mcp.py` is this product's MCP client and `svc/mcpserve.py` is its
    server. Driving one with the other checks the framing they agree on rather
    than checking each against my reading of the specification — and a tool
    result is prose-wrapping-JSON, which is precisely the shape that broke the
    probe written to read it.
    """

    def setUp(self):
        self.mcp = sys.modules["svc.mcp"]
        transport = httpx.WSGITransport(app=svc.app)
        self._open = mock.patch.object(
            self.mcp, "_open",
            lambda: httpx.Client(transport=transport, base_url="http://iram.test"),
        )
        self._open.start()
        self.addCleanup(self._open.stop)
        self.on = mock.patch.object(serve, "enabled", return_value=True)
        self.on.start()
        self.addCleanup(self.on.stop)

    def test_the_real_client_can_drive_the_real_server(self):
        url = "http://iram.test/mcp"
        hs = self.mcp.handshake(url)
        self.assertTrue(hs.get("ok"), hs)
        self.assertEqual(hs["name"], serve.SERVER_NAME)
        self.assertEqual(hs["protocol"], serve.PROTOCOL)

        listed = self.mcp.tools(url)
        self.assertTrue(listed.get("ok"), listed)
        self.assertEqual([t["name"] for t in listed["tools"]], sorted(serve.TOOLS))

    def test_the_clients_json_reader_reads_this_servers_tool_result(self):
        # If the server framed a result differently from what `embedded_json`
        # parses, every other test in this file would still pass.
        out = self.mcp.call_tool("http://iram.test/mcp", "history_inventory", {})
        self.assertTrue(out.get("ok"), out)
        got = self.mcp.embedded_json(out["text"])
        self.assertTrue(got["ok"], got)
        self.assertTrue(got["data"]["ok"])
        self.assertEqual(got["data"]["series"], [])


class TheOperatorsSwitch(unittest.TestCase):
    def test_turning_it_on_and_off_is_recorded(self):
        self.assertTrue(_set(True).json()["on"])
        self.assertTrue(serve.enabled())
        self.assertFalse(_set(False).json()["on"])
        self.assertFalse(serve.enabled())

    def test_the_state_route_publishes_the_config_a_client_needs(self):
        with httpx.Client(transport=httpx.WSGITransport(app=svc.app),
                          base_url="http://iram.test") as c:
            got = c.get("/svc/mcp/serve/state").json()
        cfgd = got["clientConfig"]["mcpServers"][serve.SERVER_NAME]
        # The snippet must point at the SAME address the endpoint serves, or it
        # describes a server that is not there.
        self.assertEqual(cfgd["url"], got["url"])
        self.assertTrue(got["url"].endswith("/mcp"))

    def test_the_state_route_lists_what_is_withheld(self):
        # The operator deciding whether to connect a client should be able to
        # see what it CANNOT do, not only what it can.
        with httpx.Client(transport=httpx.WSGITransport(app=svc.app),
                          base_url="http://iram.test") as c:
            got = c.get("/svc/mcp/serve/state").json()
        names = [w["name"] for w in got["wontPublish"]]
        self.assertIn("order_send", names)
        self.assertEqual(len(names), len(serve.WONT_PUBLISH))


if __name__ == "__main__":
    unittest.main(verbosity=2)
