#!/usr/bin/env python3
"""MCP SIGN-IN — `server/svc/mcpauth.py`. THE TOKEN MUST NOT LEAVE THE SERVER.

WHY THIS FILE IS SEPARATE FROM `test_mcp_client.py`

Because the rule it enforces has been broken before, through a different door
each time, and `tests/test_no_live_store.py` exists for exactly that reason one
level up. `store/sync.ts` carries the scar in full: the analyst's API key reached
a remote endpoint because "is this a credential?" had two answers, and
`settingsbackup.ts` nearly became a third within one session.

This product BACKS THE BROWSER'S STORAGE UP TO THE SERVER. So a token that
reaches the browser is a token in every copy of that backup, on disk, for as long
as the backup is kept. The direction that matters is therefore outward: not "is
the token encrypted" but "can any route be made to return it".

THE TEST THAT MATTERS IS `test_no_route_returns_the_token`. It sweeps every
`/svc/mcp*` route for a sentinel token value, and it is PROVED by
`test_the_sweep_would_catch_a_leak`, which builds a deliberately leaky response
and requires the same sweep to fail on it. Without that second test the first one
passes on a sweep that looks at nothing — "an audit script that parses nothing
reports success", in the guard written to stop a credential escaping.

WHAT ELSE IS PINNED, AND WHY EACH ONE IS A REAL FAILURE MODE

  * **S256, never `plain`.** A silent downgrade removes the only thing PKCE adds.
  * **`code`, never `token`.** LunarCrush advertises the implicit grant. A token
    in a redirect fragment is a token in browser history.
  * **A `state` that was never issued here is refused.** That is the CSRF check.
  * **A rotated refresh token replaces the old one.** A service that rotates and
    is not followed leaves the next refresh presenting a retired token — and it
    fails days later, at the moment the operator needs the connection.
  * **A failed refresh does NOT delete the sign-in.** One unreachable minute is
    not proof a sign-in is dead, and silently logging somebody out of a working
    service is worse than a refusal they can see.
  * **Signing out deletes locally even if revocation fails.** An operator who
    asks to be signed out is signed out of THIS product whatever somebody else's
    service does.

Run:  python -m pytest tests/test_mcp_secrets.py -v
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from typing import ClassVar
from unittest import mock

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-mcpauth-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import httpx
import mishel_service as svc

mcp = sys.modules["svc.mcp"]
auth = sys.modules["svc.mcpauth"]

URL = "https://example.test/mcp"
ISSUER = "https://auth.example.test"

#: Distinctive enough that finding it in a response body cannot be a coincidence.
SENTINEL = "sentinel-access-token-3f9c1a7e"

RESOURCE_DOC = {"resource": URL, "authorization_servers": [ISSUER]}
AS_DOC = {
    "issuer": ISSUER,
    "authorization_endpoint": ISSUER + "/authorize",
    "token_endpoint": ISSUER + "/token",
    "registration_endpoint": ISSUER + "/register",
    "revocation_endpoint": ISSUER + "/revoke",
    "code_challenge_methods_supported": ["S256"],
    "response_types_supported": ["code", "token"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "scopes_supported": ["mcp:read", "mcp:tools"],
    "token_endpoint_auth_methods_supported": ["none"],
}


class Auth:
    """A scripted authorization server. Records every request for assertion."""

    def __init__(self, as_doc: dict | None = None):
        self.as_doc = as_doc or AS_DOC
        self.seen: list[dict] = []
        self.token_reply: tuple[int, dict] | None = None
        self.revoke_status = 200

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body: dict = {}
        if request.content:
            raw = request.content.decode()
            if raw.startswith("{"):
                body = json.loads(raw)
            else:
                body = dict(p.split("=", 1) for p in raw.split("&") if "=" in p)
        self.seen.append({"path": path, "body": body})

        if "oauth-protected-resource" in path:
            return httpx.Response(200, json=RESOURCE_DOC)
        if "oauth-authorization-server" in path:
            return httpx.Response(200, json=self.as_doc)
        if path.endswith("/register"):
            return httpx.Response(201, json={"client_id": "client-abc"})
        if path.endswith("/token"):
            if self.token_reply:
                status, payload = self.token_reply
                return httpx.Response(status, json=payload)
            return httpx.Response(200, json={
                "access_token": SENTINEL, "refresh_token": "refresh-1",
                "expires_in": 3600, "scope": "mcp:read",
            })
        if path.endswith("/revoke"):
            return httpx.Response(self.revoke_status, json={})
        return httpx.Response(404, json={"error": "not found"})


class Base(unittest.TestCase):
    def setUp(self):
        mcp._SESSIONS.clear()
        svc.app.config["TESTING"] = True
        with svc.db() as c:
            c.execute("DELETE FROM config WHERE k LIKE 'mcp_%'")

    def serve(self, handler):
        def _open():
            return httpx.Client(transport=httpx.MockTransport(handler))
        return mock.patch.object(mcp, "_open", _open)

    def sign_in(self, server: Auth) -> str:
        """Drive a whole flow and return the state, so tests start signed in.

        THE SERVER IS PUT ON THE REGISTRY FIRST, and that line is the reason this
        suite is worth anything. Without it `/svc/mcp/servers` and
        `/svc/mcp/signin-status` both render an EMPTY LIST -- they iterate the
        registry -- so the leak sweep swept two routes that had nothing to say and
        reported the token safe. It passed 26 of 26 on the first run in exactly
        that state. `test_the_sweep_would_catch_a_leak` is what found it, by
        introducing a real leak and watching the sweep miss it: "an audit script
        that parses nothing reports success", inside the guard written to keep a
        credential off the wire.
        """
        mcp.add_server("Example", URL)
        with self.serve(server):
            begun = auth.begin(URL)
            self.assertTrue(begun["ok"], begun)
            done = auth.complete("code-1", begun["state"])
            self.assertTrue(done["ok"], done)
        return begun["state"]


class TokenNeverLeaves(Base):
    #: Every GET route this feature adds. A POST that takes a url is included
    #: because a refusal body is a response body too.
    def _sweep(self, client) -> list[tuple[str, str]]:
        probes = [
            ("GET", "/svc/mcp/servers"),
            ("GET", "/svc/mcp/signin-status"),
            ("GET", "/svc/mcp/tools?url=" + URL),
            ("GET", "/svc/mcp/probe?url=" + URL),
        ]
        seen = []
        for method, path in probes:
            r = client.get(path) if method == "GET" else client.post(path, json={})
            seen.append((path, r.get_data(as_text=True)))
        for path, payload in [("/svc/mcp/connect", {"url": URL}),
                              ("/svc/mcp/signout", {"url": URL}),
                              ("/svc/mcp/call", {"url": URL, "tool": "x"})]:
            r = client.post(path, json=payload)
            seen.append((path, r.get_data(as_text=True)))
        return seen

    def test_no_route_returns_the_token(self):
        server = Auth()
        self.sign_in(server)
        # It really is stored -- otherwise this sweep proves nothing.
        self.assertEqual(auth.token_for(URL), SENTINEL)

        with self.serve(server), svc.app.test_client() as c:
            bodies = self._sweep(c)

        self.assertGreaterEqual(len(bodies), 7, "the sweep must actually probe the routes")

        # THE ROUTES MUST HAVE HAD SOMETHING TO RENDER. This suite passed 26 of 26
        # while the registry was empty and both listing routes returned `[]`, so a
        # count of probes is not evidence that anything was inspected. Naming the
        # server in the body is.
        rendered = [p for p, b in bodies if URL in b]
        self.assertIn("/svc/mcp/signin-status", rendered,
                      "the sign-in route rendered no server, so this sweep proves nothing")
        self.assertIn("/svc/mcp/servers", rendered)

        for path, body in bodies:
            self.assertNotIn(SENTINEL, body, "%s returned the access token" % path)
            self.assertNotIn("refresh-1", body, "%s returned the refresh token" % path)

    def test_the_sweep_would_catch_a_leak(self):
        """PROVE THE GUARD, THROUGH THE REAL ROUTE.

        The first version of this test built a leaky dict and asserted the
        sentinel was in it, which proves a string contains a substring and
        nothing whatever about the sweep. So the leak is introduced where a real
        one would be: `status()` is what `/svc/mcp/signin-status` renders per
        server, and adding the token to its return is one plausible line of
        careless code. The sweep must then FAIL.
        """
        server = Auth()
        self.sign_in(server)
        real = auth.status

        def leaky(url):
            return {**real(url), "accessToken": auth.token_for(url)}

        with mock.patch.object(auth, "status", leaky):
            with self.serve(server), svc.app.test_client() as c:
                bodies = self._sweep(c)
            leaked = [p for p, b in bodies if SENTINEL in b]

        self.assertEqual(
            leaked, ["/svc/mcp/signin-status"],
            "the sweep did not notice a token returned by a real route, so the test "
            "above is checking nothing. Found in: %s" % leaked,
        )

        # ...and with the leak removed the same sweep is clean again, which is the
        # other half: a sweep that always fails is no more use than one that never does.
        with self.serve(server), svc.app.test_client() as c:
            self.assertEqual([p for p, b in self._sweep(c) if SENTINEL in b], [])

    def test_status_says_signed_in_without_saying_with_what(self):
        self.sign_in(Auth())
        got = auth.status(URL)
        self.assertTrue(got["signedIn"])
        self.assertTrue(got["canRefresh"])
        self.assertNotIn("access_token", got)
        self.assertNotIn(SENTINEL, json.dumps(got))

    def test_an_unknown_server_is_simply_not_signed_in(self):
        self.assertEqual(auth.status("https://never.test/mcp"), {"signedIn": False})
        self.assertIsNone(auth.token_for("https://never.test/mcp"))


class Pkce(Base):
    def test_the_challenge_is_the_unpadded_s256_of_the_verifier(self):
        verifier, challenge = auth._verifier()
        expect = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
        self.assertEqual(challenge, expect)
        self.assertNotIn("=", challenge, "base64url for a URL carries no padding")
        self.assertNotIn("+", challenge)
        self.assertNotIn("/", challenge)

    def test_two_sign_ins_never_share_a_verifier(self):
        self.assertNotEqual(auth._verifier()[0], auth._verifier()[0])

    def test_s256_is_requested_and_the_code_flow_only(self):
        server = Auth()
        with self.serve(server):
            begun = auth.begin(URL)
        self.assertTrue(begun["ok"], begun)
        self.assertIn("code_challenge_method=S256", begun["authorize"])
        self.assertIn("response_type=code", begun["authorize"])
        self.assertNotIn("response_type=token", begun["authorize"])

        registered = next(x for x in server.seen if x["path"].endswith("/register"))
        self.assertEqual(registered["body"]["response_types"], ["code"],
                         "the implicit grant is offered by real servers and is not taken")
        self.assertEqual(registered["body"]["token_endpoint_auth_method"], "none",
                         "a public client, so there is no secret to store")

    def test_a_server_offering_only_plain_is_refused_not_downgraded(self):
        weak = {**AS_DOC, "code_challenge_methods_supported": ["plain"]}
        with self.serve(Auth(as_doc=weak)):
            got = auth.begin(URL)
        self.assertFalse(got["ok"])
        self.assertIn("S256", got["why"])

    def test_the_redirect_is_loopback_only(self):
        self.assertTrue(auth.REDIRECT.startswith("http://127.0.0.1:"))
        self.assertTrue(auth.REDIRECT.endswith("/svc/mcp/callback"))


class LeastPrivilege(Base):
    """ASKING FOR EVERY SCOPE A SERVER ADVERTISES IS ASKING FOR TOO MUCH.

    MEASURED: LunarCrush advertises `["profile", "api.read", "api.write"]`, and
    the first version of this asked for all three — so connecting a SENTIMENT
    READER would have requested permission to write to the operator's account, on
    a consent screen where `api.write` is one word among three. The operator would
    have approved it, once, and nobody would ever look again.
    """

    #: The real advertised set, so this test is about a live server's shape.
    LUNAR: ClassVar[list[str]] = ["profile", "api.read", "api.write"]

    def test_a_write_scope_is_dropped_by_default(self):
        self.assertEqual(auth.read_scopes(self.LUNAR), ["profile", "api.read"])

    def test_the_other_markers_are_dropped_too(self):
        offered = ["read", "orders.place", "account.manage", "admin", "trade", "x.delete"]
        self.assertEqual(auth.read_scopes(offered), ["read"])

    def test_a_server_whose_only_scope_grants_writing_is_not_asked_for_nothing(self):
        """Requesting no scope at all fails the handshake with no explanation."""
        self.assertEqual(auth.read_scopes(["api.write"]), ["api.write"])
        self.assertEqual(auth.read_scopes([]), [])

    def test_the_authorize_url_asks_only_for_the_read_scopes(self):
        server = Auth(as_doc={**AS_DOC, "scopes_supported": self.LUNAR})
        with self.serve(server):
            got = auth.begin(URL)
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["scopes"], ["profile", "api.read"])
        self.assertEqual(got["withheld"], ["api.write"])
        self.assertIn("scope=profile+api.read", got["authorize"])
        self.assertNotIn("api.write", got["authorize"])

    def test_the_registration_asks_only_for_the_read_scopes(self):
        server = Auth(as_doc={**AS_DOC, "scopes_supported": self.LUNAR})
        with self.serve(server):
            auth.begin(URL)
        registered = next(x for x in server.seen if x["path"].endswith("/register"))
        self.assertEqual(registered["body"]["scope"], "profile api.read")

    def test_writing_is_available_but_only_when_asked_for(self):
        """A server-side watchlist or a price alert is a real use. It is a PRESS."""
        server = Auth(as_doc={**AS_DOC, "scopes_supported": self.LUNAR})
        with self.serve(server):
            got = auth.begin(URL, allow_write=True)
        self.assertEqual(got["scopes"], self.LUNAR)
        self.assertEqual(got["withheld"], [])
        self.assertIn("api.write", got["authorize"])

    def test_the_route_does_not_grant_writing_unless_the_body_says_so(self):
        server = Auth(as_doc={**AS_DOC, "scopes_supported": self.LUNAR})
        with self.serve(server), svc.app.test_client() as c:
            plain = c.post("/svc/mcp/connect", json={"url": URL}).get_json()
        self.assertEqual(plain["withheld"], ["api.write"])

        with svc.db() as con:
            con.execute("DELETE FROM config WHERE k LIKE 'mcp_client%'")
        with self.serve(server), svc.app.test_client() as c:
            asked = c.post("/svc/mcp/connect",
                           json={"url": URL, "allowWrite": True}).get_json()
        self.assertEqual(asked["withheld"], [])


class StateCheck(Base):
    def test_a_state_never_issued_here_is_refused(self):
        with self.serve(Auth()):
            got = auth.complete("code-1", "forged-state")
        self.assertFalse(got["ok"])
        self.assertIn("expired or was not started here", got["why"])

    def test_a_state_is_single_use(self):
        server = Auth()
        with self.serve(server):
            begun = auth.begin(URL)
            self.assertTrue(auth.complete("code-1", begun["state"])["ok"])
            again = auth.complete("code-1", begun["state"])
        self.assertFalse(again["ok"], "a replayed state must not be accepted")

    def test_an_expired_pending_request_is_refused(self):
        server = Auth()
        with self.serve(server):
            begun = auth.begin(URL)
        row = auth._get("mcp_pending:" + begun["state"])
        row["at"] = time.time() - (auth.PENDING_TTL_S + 10)
        auth._put("mcp_pending:" + begun["state"], row)
        with self.serve(server):
            got = auth.complete("code-1", begun["state"])
        self.assertFalse(got["ok"])

    def test_the_callback_page_is_for_a_human_and_names_the_failure(self):
        with svc.app.test_client() as c:
            r = c.get("/svc/mcp/callback", query_string={"error": "access_denied",
                                                         "error_description": "you said no"})
        self.assertEqual(r.status_code, 200)
        body = r.get_data(as_text=True)
        self.assertIn("Not signed in", body)
        self.assertIn("you said no", body)

    def test_the_callback_escapes_what_the_service_sent(self):
        with svc.app.test_client() as c:
            r = c.get("/svc/mcp/callback",
                      query_string={"error": "x", "error_description": "<script>bad()</script>"})
        body = r.get_data(as_text=True)
        self.assertNotIn("<script>", body)
        self.assertIn("&lt;script&gt;", body)


class Refresh(Base):
    def _expire(self):
        row = auth._get(auth._token_key(URL))
        row["expires_at"] = time.time() - 1
        auth._put(auth._token_key(URL), row)

    def test_an_expiring_token_is_refreshed(self):
        server = Auth()
        self.sign_in(server)
        self._expire()
        server.token_reply = (200, {"access_token": "second-token", "expires_in": 3600})
        with self.serve(server):
            self.assertEqual(auth.token_for(URL), "second-token")
        grants = [x["body"].get("grant_type") for x in server.seen if x["path"].endswith("/token")]
        self.assertIn("refresh_token", grants)

    def test_a_rotated_refresh_token_replaces_the_old_one(self):
        """A service that rotates and is not followed fails days later."""
        server = Auth()
        self.sign_in(server)
        self._expire()
        server.token_reply = (200, {"access_token": "t2", "refresh_token": "refresh-2",
                                    "expires_in": 3600})
        with self.serve(server):
            auth.token_for(URL)
        self.assertEqual(auth._get(auth._token_key(URL))["refresh_token"], "refresh-2")

    def test_a_failed_refresh_keeps_the_sign_in(self):
        """One unreachable minute is not proof a sign-in is dead."""
        server = Auth()
        self.sign_in(server)
        self._expire()
        server.token_reply = (500, {"error": "server_error"})
        with self.serve(server):
            self.assertIsNone(auth.token_for(URL))
        self.assertTrue(auth.status(URL)["signedIn"],
                        "a transient failure must not silently log the operator out")

    def test_a_token_with_no_refresh_and_no_expiry_is_still_returned(self):
        server = Auth()
        server.token_reply = (200, {"access_token": SENTINEL})
        self.sign_in(server)
        with self.serve(server):
            self.assertEqual(auth.token_for(URL), SENTINEL)

    def test_the_token_reaches_the_transport_as_a_bearer_header(self):
        """The whole point: svc/mcp asks for it by URL and never holds it."""
        self.sign_in(Auth())
        seen: list[str | None] = []

        def handler(request):
            seen.append(request.headers.get("authorization"))
            return httpx.Response(401, text="nope")

        with self.serve(handler), svc.app.test_client() as c:
            c.get("/svc/mcp/tools", query_string={"url": URL})
        self.assertEqual(seen[0], "Bearer " + SENTINEL)


class SignOut(Base):
    def test_signing_out_deletes_locally_even_when_revocation_fails(self):
        server = Auth()
        server.revoke_status = 500
        self.sign_in(server)
        with self.serve(server):
            got = auth.forget(URL)
        self.assertTrue(got["ok"])
        self.assertFalse(got["revokedRemotely"])
        self.assertFalse(auth.status(URL)["signedIn"])
        self.assertIsNone(auth.token_for(URL))

    def test_signing_out_of_something_not_signed_in_says_so(self):
        self.assertFalse(auth.forget(URL)["ok"])

    def test_signing_out_drops_the_cached_session(self):
        self.sign_in(Auth())
        mcp._SESSIONS[URL] = {"id": "s", "protocol": "x", "at": time.time()}
        with self.serve(Auth()):
            auth.forget(URL)
        self.assertNotIn(URL, mcp._SESSIONS,
                         "a cached session outliving a sign-out is a request sent as "
                         "somebody who has signed out")


class Discovery(Base):
    def test_a_server_that_names_no_sign_in_service_is_refused_clearly(self):
        with self.serve(lambda r: httpx.Response(404, json={})):
            got = auth.discover(URL)
        self.assertFalse(got["ok"])
        self.assertIn("did not say where to sign in", got["why"])

    def test_the_401_hint_is_preferred_over_a_guessed_path(self):
        hint = "https://example.test/.well-known/oauth-protected-resource/mcp"
        server = Auth()
        with self.serve(server):
            got = auth.discover(URL, hint=hint)
        self.assertTrue(got["ok"], got)
        self.assertEqual(server.seen[0]["path"], "/.well-known/oauth-protected-resource/mcp")

    def test_a_client_is_registered_once_per_issuer(self):
        server = Auth()
        with self.serve(server):
            auth.begin(URL)
            auth.begin(URL)
        registers = [x for x in server.seen if x["path"].endswith("/register")]
        self.assertEqual(len(registers), 1,
                         "registering per connect leaves orphan clients on somebody "
                         "else's service")

    def test_a_service_with_no_registration_endpoint_says_what_is_needed(self):
        no_reg = {k: v for k, v in AS_DOC.items() if k != "registration_endpoint"}
        with self.serve(Auth(as_doc=no_reg)):
            got = auth.begin(URL)
        self.assertFalse(got["ok"])
        self.assertIn("by hand", got["why"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
