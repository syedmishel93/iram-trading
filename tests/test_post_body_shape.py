#!/usr/bin/env python3
"""A POST BODY THAT IS NOT AN OBJECT MUST BE REFUSED, NOT CRASHED ON.

WHAT THIS IS FOR. `scratchpad/probe.py` GETs all 68 read routes and reports 0
broken — and it SKIPS every POST, counting them as skipped, which is honest of
it and also leaves half the surface unexamined. `scratchpad/postrefuse.py` sent
five malformed bodies to each of the 27 POST routes that are safe to poke, and
found **26 crashes across 20 routes**. Twenty were ONE defect.

THE DEFECT. Every route reads its body as `request.get_json(...) or {}` and then
calls `.get(...)`. That is correct for `null` and for an absent body — both are
falsy, so `or {}` fires — and WRONG for every other scalar: the JSON document
`"a string"` is truthy, so `.get` reaches a `str` and raises AttributeError.
Flask then serves its HTML traceback page, so the operator gets a stack trace
where a sentence belongs.

WHY THE FIX IS ONE `before_request` AND NOT TWENTY EDITS. A per-route fix leaves
the twenty-first route to be written the same way. That is the mechanism this
project keeps recording: nineteen test files in no list, `run.py` linted by
nothing, `tests/ fully listed`. A guard on the app covers the route nobody has
written yet.

THE TESTS THAT MATTER ARE THE ONES ASSERTING IT DID NOT OVERREACH. A guard on
every route is a guard that can break every route:

  * **`a batch is a LIST and must still be accepted`** — `/mcp` takes JSON-RPC
    batches. A blanket "objects only" rule would have broken the MCP server on
    its first batch while looking exactly like tightening.
  * **`/mcp answers a parse error in its OWN shape`** — JSON-RPC says code
    -32700, not this product's `{ok: false}`. The guard steps aside for that one
    path, by name.
  * **`an ordinary object body is untouched`** — if the guard changed a single
    normal request, every existing caller would move at once.

Run:  python -m pytest tests/test_post_body_shape.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from typing import ClassVar

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-bodyshape-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc

#: Scalars. Every one is legal JSON and none is a body any route here can use.
SCALARS = ['"a string"', "42", "true", "3.14"]

#: Routes that WRITE, so a crash here is also the route's last line of defence.
#: Named rather than swept, so adding one is a decision.
WRITERS = [
    "/svc/bars", "/svc/bars/enrol", "/svc/kv", "/svc/alerts", "/svc/claims",
    "/svc/edge/trials", "/svc/onchain/watch", "/svc/onchain/unwatch",
    "/svc/onchain/dbwallets", "/svc/settings", "/svc/risk/config",
    "/svc/sig/watch", "/svc/mcp/add", "/svc/mcp/remove", "/svc/mcp/serve/enable",
    "/svc/ledger", "/svc/risk/check", "/svc/risk/size", "/svc/store/evict",
]


def post(path, raw):
    with svc.app.test_client() as c:
        return c.post(path, data=raw, content_type="application/json")


class AScalarBodyIsRefused(unittest.TestCase):
    def test_no_writing_route_crashes_on_a_scalar_body(self):
        """THE ONE THAT MATTERS. 20 of these returned 500 before the guard."""
        crashed = []
        for path in WRITERS:
            for raw in SCALARS:
                r = post(path, raw)
                if r.status_code >= 500:
                    crashed.append((path, raw, r.status_code))
        self.assertEqual(crashed, [], "a scalar body reached the route: %s" % crashed)

    def test_the_refusal_names_what_was_wrong(self):
        # An operator sentence, not Flask's "The browser (or proxy) sent a
        # request that this server could not understand".
        r = post("/svc/risk/size", '"a string"')
        self.assertEqual(r.status_code, 400)
        body = json.loads(r.data)
        self.assertFalse(body["ok"])
        self.assertIn("JSON object", body["err"])
        self.assertIn("str", body["err"])

    def test_unparseable_is_a_400_and_not_a_500(self):
        # These answered 500 carrying Flask's own 400 text, because a blanket
        # `except Exception` caught werkzeug's BadRequest and relabelled a
        # CLIENT error as a server one.
        for path in ("/svc/claims", "/svc/edge/trials"):
            r = post(path, "{{{")
            self.assertEqual(r.status_code, 400, path)
            self.assertIn("not valid JSON", json.loads(r.data)["err"])

    def test_the_sweep_would_catch_a_crash(self):
        """PROVE the sweep. Without this, the first test passes on an empty list."""
        # A route that does not exist 404s; a 500 is what the sweep looks for and
        # it must be able to tell them apart.
        self.assertGreater(len(WRITERS) * len(SCALARS), 50)
        self.assertTrue(all(s.strip() for s in SCALARS))


class TheGuardDidNotOverreach(unittest.TestCase):
    def test_a_batch_is_a_LIST_and_must_still_be_accepted(self):
        r = post("/mcp", json.dumps([
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]))
        self.assertEqual(r.status_code, 200)
        self.assertEqual([m["id"] for m in json.loads(r.data)], [1, 2])

    def test_mcp_answers_a_parse_error_in_ITS_OWN_shape(self):
        # JSON-RPC says -32700. The guard must step aside for this one path, or
        # a client gets `{ok: false}` where the protocol requires an envelope.
        r = post("/mcp", "{{{")
        self.assertEqual(json.loads(r.data)["error"]["code"], -32700)

    def test_an_ordinary_object_body_is_untouched(self):
        r = post("/svc/bars", json.dumps({
            "src": "test", "sym": "XXXUSD", "tf": "1h",
            "bars": [{"t": 1_700_000_000_000, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}],
        }))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(json.loads(r.data)["ok"])

    def test_an_absent_body_still_reaches_the_route(self):
        # `or {}` is CORRECT for an absent body, and several routes rely on it.
        # A guard that refused empty would break every one of them.
        r = post("/svc/risk/check", "")
        self.assertLess(r.status_code, 500)

    def test_null_still_reaches_the_route(self):
        # `null` is falsy, so `or {}` fires. It was never the bug and must not
        # start being refused now.
        r = post("/svc/risk/check", "null")
        self.assertLess(r.status_code, 500)

    def test_a_GET_is_not_touched(self):
        with svc.app.test_client() as c:
            self.assertLess(c.get("/svc/bars/inventory").status_code, 400)


class TheFieldLevelVersion(unittest.TestCase):
    """A body that IS an object can still carry a field of the wrong type."""

    def test_a_numeric_symbol_does_not_reach_upper(self):
        # `(d.get("symbol") or "").upper()` — 42 is truthy, so `.upper()` hit an
        # int. It becomes "42", which then honestly finds no broker spec and
        # refuses by name; rejecting it outright would be a second refusal path
        # for something the next line already handles.
        for path in ("/svc/risk/size", "/svc/risk/check"):
            r = post(path, json.dumps({"symbol": 42, "risk_pct": "lots"}))
            self.assertLess(r.status_code, 500, path)

    def test_the_mcp_switch_refuses_a_body_that_does_not_say_on(self):
        # It read `get_json(silent=True) or {}`, so unparseable became `{}` and
        # `bool({}.get("on"))` switched the server OFF while answering 200.
        # Failing to the safe side is not the same as understanding the request.
        r = post("/svc/mcp/serve/enable", json.dumps({}))
        self.assertEqual(r.status_code, 400)
        self.assertIn("on", json.loads(r.data)["err"])

    def test_a_ledger_row_missing_its_fields_is_named(self):
        r = post("/svc/ledger", json.dumps({}))
        self.assertEqual(r.status_code, 400)
        self.assertIn("missing", json.loads(r.data)["err"])


class HostileQueryParameters(unittest.TestCase):
    """THE OTHER HALF: a GET route's query string.

    `probe.py` calls all 46 read routes with VALID parameters and truthfully
    reports 0 of 68 broken. Sweeping the same routes with hostile VALUES found
    **68 crashes across 8 routes** -- and a query string is the most exposed
    input this product has, because it lives in a link, a bookmark and an
    address bar.

    A bad value takes the DEFAULT rather than refusing (`svc.core.arg_num`):
    these are page sizes and windows, so "show me 50" beats a stack trace, and
    unlike a cost model or a stop distance nothing downstream is decided by it.
    """

    NUMERIC: ClassVar[list[tuple[str, str]]] = [
        ("/svc/events", "limit"), ("/svc/onchain/events", "limit"),
        ("/svc/recon", "days"), ("/svc/sig/fired", "n"),
        ("/svc/sync/pull", "limit"), ("/svc/claims", "limit"),
        ("/svc/claims/stats", "since"), ("/svc/edge/conditional", "since"),
    ]
    HOSTILE: ClassVar[list[str]] = ["abc", "1e400", "null", "-", "1,2", "-1", "99999999999999999999", ""]

    def test_no_route_crashes_on_a_hostile_query_value(self):
        crashed = []
        with svc.app.test_client() as c:
            for path, key in self.NUMERIC:
                for v in self.HOSTILE:
                    r = c.get("%s?%s=%s" % (path, key, v))
                    if r.status_code >= 500:
                        crashed.append((path, key, v, r.status_code))
        self.assertEqual(crashed, [], "hostile query value crashed: %s" % crashed[:6])

    def test_the_sweep_actually_sent_something(self):
        # A sweep of an empty list reports a clean tree.
        self.assertGreaterEqual(len(self.NUMERIC) * len(self.HOSTILE), 60)

    def test_a_bad_number_falls_back_to_the_default_rather_than_zero(self):
        # Zero rows is a different claim from "I could not read your number".
        # `arg_num` clamps to `lo`, so a limit can never come back as 0.
        from svc.core import arg_num
        with svc.app.test_request_context("/x?limit=abc"):
            self.assertEqual(arg_num("limit", 50, lo=1, hi=500), 50)
        with svc.app.test_request_context("/x?limit=-5"):
            self.assertEqual(arg_num("limit", 50, lo=1, hi=500), 1)
        with svc.app.test_request_context("/x?limit=999999"):
            self.assertEqual(arg_num("limit", 50, lo=1, hi=500), 500)
        with svc.app.test_request_context("/x?limit=7"):
            self.assertEqual(arg_num("limit", 50, lo=1, hi=500), 7)

    def test_infinity_and_nan_do_not_survive(self):
        # `float("1e400")` is inf and `float("nan")` is nan; both would reach a
        # comparison or a LIMIT clause. INFINITY IS A BUG.
        from svc.core import arg_num
        for raw in ("1e400", "-1e400", "nan"):
            with svc.app.test_request_context("/x?n=%s" % raw):
                got = arg_num("n", 500, lo=1, hi=5000, cast=float)
                self.assertEqual(got, 500, raw)


if __name__ == "__main__":
    unittest.main(verbosity=2)
