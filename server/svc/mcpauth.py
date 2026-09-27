"""server/svc/mcpauth.py — signing in to an MCP server, once, without a secret.

WHAT THIS IS

MCP's auth is OAuth 2.1: discovery from the 401 itself, dynamic client
registration, PKCE, and a refresh token. This module is that flow. `svc/mcp.py`
owns the transport and asks this one for a token by URL.

IT IS GENERIC, AND THAT IS THE POINT. Two servers were probed on 2026-09-25 and
both advertise the identical chain:

    WWW-Authenticate: Bearer resource_metadata="..."
      -> {"authorization_servers": ["https://..."]}
        -> /.well-known/oauth-authorization-server
             authorization_endpoint / token_endpoint / registration_endpoint

TradingView and LunarCrush differ in no way this module can see. So one
implementation serves every MCP server there will be, and the owner's TradingView
plan — free, and possibly not served — cannot waste the work: LunarCrush is a
second live target for exactly the same code path.

NO CREDENTIAL IS EVER ASKED FOR, TYPED, OR HELD

  * `registration_endpoint` plus `token_endpoint_auth_methods_supported`
    containing `"none"` means a PUBLIC client: the client id is issued on demand
    and there is NO CLIENT SECRET. MEASURED on TradingView. So there is nothing
    for the operator to obtain from a developer portal and nothing for this
    product to store on their behalf.
  * The operator's password is typed into the SERVER'S OWN sign-in page, in their
    browser. It never reaches this process. That is the whole reason OAuth is
    used here rather than an API key field.

WHERE THE TOKEN LIVES, AND WHY NOT IN THE BROWSER

In the SQLite `config` table, server-side. This product backs the browser's own
storage up to the server, so a token in browser storage is a token in every copy
of that backup — and `store/sync.ts` already carries that rule *and* the scar,
because "is this a credential?" had two answers once and the analyst's API key
reached a remote endpoint. `tests/test_mcp_secrets.py` asserts no route returns
one, and proves itself by failing when a route is made to.

THE FLOW NEVER STARTS ITSELF

`begin()` returns an authorize URL; it does not open it. The operator presses
Connect, and that press IS the authorization. A product that opened a consent
screen on its own initiative would be deciding, on their behalf, to grant an
external service access to their account.

WHAT IT REFUSES

  * **`plain` PKCE.** If a server does not advertise `S256`, this refuses rather
    than falling back — a downgrade to `plain` removes the protection the
    challenge exists for, and a silent fallback is how that happens.
  * **The implicit grant.** LunarCrush advertises `response_types_supported:
    ["code", "token"]`. Only `code` is used; a token in a redirect fragment is a
    token in the browser's history.
  * **A `state` that does not match a pending request.** That is the CSRF check,
    and a callback that accepts any state accepts one anybody can forge.
  * **A redirect that is not loopback.** The only redirect this product can
    legitimately receive is its own.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx
from db import db
from flask import Blueprint, request

from svc import mcp as _mcp
from svc.core import log_event

bp = Blueprint("mcpauth", __name__)

#: The gateway's port. `run.py` DEFAULT_PORT, overridable for the same reason it
#: is there: "8787 is busy" is not a decision anybody made.
PORT = int(os.environ.get("IRAM_PORT") or 8787)

#: Registered with the authorization server, so it must match EXACTLY later.
#: Loopback only -- see the refusals above.
REDIRECT = "http://127.0.0.1:%d/svc/mcp/callback" % PORT

#: An in-flight authorization is worth minutes, not hours. A pending request that
#: outlives the operator's attention is a `state` value sitting around to be
#: replayed.
PENDING_TTL_S = 600.0

#: Refresh this long BEFORE expiry, so a call does not race the clock.
REFRESH_SKEW_S = 60.0

CLIENT_NAME = "IRAM Trading Terminal"

#: A scope naming one of these is not asked for unless the operator says so.
#:
#: LEAST PRIVILEGE, AND IT IS NOT HYPOTHETICAL. MEASURED: LunarCrush advertises
#: `["profile", "api.read", "api.write"]`, and the first version of this asked for
#: every scope a server advertised — so connecting a SENTIMENT READER would have
#: requested permission to write to the operator's account, on a consent screen
#: where "api.write" is one word among three and nothing on it would say why.
#: An over-broad grant is a decision made on somebody's behalf and then forgotten.
#:
#: Anything reaching these tools READ. Writing (a server-side watchlist, a price
#: alert) is a separate ask, granted by `allow_write` and therefore by a press.
WRITE_MARKERS = ("write", "delete", "admin", "trade", "order", "manage")


def read_scopes(offered: list[str]) -> list[str]:
    """The advertised scopes, minus anything that grants writing.

    Returns ALL of them when every scope looks like a write scope, rather than an
    empty list: a server whose only scope is `api.write` is telling us that is
    what reading costs there, and asking for nothing would fail the handshake
    with no explanation. The card says which scopes were requested either way.
    """
    safe = [s for s in offered if not any(m in s.lower() for m in WRITE_MARKERS)]
    return safe or list(offered)


def _refuse(why: str, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "why": why}
    out.update(extra)
    return out


# ------------------------------------------------------------------- storage --
# One key per thing, read one at a time. `cfg()` in svc/core.py reads by key and
# nothing in this product returns the config table wholesale -- checked before
# choosing this over a table of its own.
def _get(key: str) -> dict[str, Any] | None:
    with db() as c:
        row = c.execute("SELECT v FROM config WHERE k=?", (key,)).fetchone()
    if not row or not row["v"]:
        return None
    try:
        got = json.loads(row["v"])
    except ValueError:
        return None
    return got if isinstance(got, dict) else None


def _put(key: str, value: dict[str, Any]) -> None:
    with db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, json.dumps(value)),
        )


def _drop(key: str) -> None:
    with db() as c:
        c.execute("DELETE FROM config WHERE k=?", (key,))


def _token_key(url: str) -> str:
    return "mcp_token:" + url


def _client_key(issuer: str) -> str:
    return "mcp_client:" + issuer


# ----------------------------------------------------------------- discovery --
def discover(url: str, hint: str | None = None) -> dict[str, Any]:
    """Find the authorization server for an MCP endpoint.

    `hint` is the `resource_metadata` URL a 401 advertises, which is the
    documented entry point and is preferred over guessing a well-known path. When
    it is absent the two standard locations are tried, because a server may
    publish the resource document without mentioning it in the challenge.
    """
    candidates = [hint] if hint else []
    base = str(httpx.URL(url).copy_with(query=None, fragment=None))
    origin = "%s://%s" % (httpx.URL(url).scheme, httpx.URL(url).netloc.decode())
    path = httpx.URL(url).path.lstrip("/")
    candidates += [
        origin + "/.well-known/oauth-protected-resource/" + path,
        origin + "/.well-known/oauth-protected-resource",
    ]

    issuer = None
    try:
        with _mcp._open() as c:
            for cand in candidates:
                if not cand:
                    continue
                r = c.get(cand, timeout=20.0)
                if r.status_code != 200:
                    continue
                try:
                    doc = r.json()
                except ValueError:
                    continue
                servers = doc.get("authorization_servers") or []
                if servers:
                    issuer = servers[0]
                    break

            if not issuer:
                return _refuse(
                    "this server did not say where to sign in, so there is nothing "
                    "to open. It may not use sign-in at all."
                )

            meta = None
            iss = issuer.rstrip("/")
            for well_known in ("/.well-known/oauth-authorization-server",
                               "/.well-known/openid-configuration"):
                r = c.get(iss + well_known, timeout=20.0)
                if r.status_code != 200:
                    continue
                try:
                    meta = r.json()
                except ValueError:
                    continue
                if meta.get("authorization_endpoint"):
                    break
                meta = None
    except httpx.HTTPError as e:
        return _refuse("could not reach the sign-in service: %s" % type(e).__name__)

    if not meta:
        return _refuse("the sign-in service at %s did not describe itself" % issuer)

    # A DOWNGRADE TO `plain` IS NOT A FALLBACK. Refuse rather than weaken.
    methods = meta.get("code_challenge_methods_supported") or []
    if methods and "S256" not in methods:
        return _refuse(
            "this sign-in service does not support the secure challenge method "
            "(S256), so signing in here would be less safe than not doing it"
        )
    if not meta.get("authorization_endpoint") or not meta.get("token_endpoint"):
        return _refuse("the sign-in service did not publish both of the addresses needed")

    return {
        "ok": True,
        "issuer": meta.get("issuer") or issuer,
        "authorize": meta["authorization_endpoint"],
        "token": meta["token_endpoint"],
        "register": meta.get("registration_endpoint"),
        "revoke": meta.get("revocation_endpoint"),
        "scopes": meta.get("scopes_supported") or [],
        "resource": base,
    }


# -------------------------------------------------------------- registration --
def _client(meta: dict[str, Any], allow_write: bool = False) -> dict[str, Any]:
    """The client id for this issuer, registering one if there is none.

    RFC 7591. Cached per ISSUER rather than per server, because that is what the
    registration is scoped to -- registering again on every connect would leave a
    trail of orphan clients on somebody else's service.
    """
    held = _get(_client_key(meta["issuer"]))
    if held and held.get("client_id"):
        return {"ok": True, **held}

    if not meta.get("register"):
        return _refuse(
            "this service needs an application to be registered by hand before it "
            "can be connected, and it does not offer to do that automatically"
        )
    body = {
        "client_name": CLIENT_NAME,
        "redirect_uris": [REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"],
        # `code` ONLY. The implicit grant puts a token in the URL fragment, and
        # therefore in browser history. LunarCrush offers it; it is not taken.
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    }
    asked = meta["scopes"] if allow_write else read_scopes(meta.get("scopes") or [])
    if asked:
        body["scope"] = " ".join(asked)

    try:
        with _mcp._open() as c:
            r = c.post(meta["register"], json=body, timeout=30.0)
    except httpx.HTTPError as e:
        return _refuse("could not register with the sign-in service: %s" % type(e).__name__)
    if r.status_code >= 400:
        return _refuse("the sign-in service refused to register this app (%d)" % r.status_code)
    try:
        got = r.json()
    except ValueError:
        return _refuse("the sign-in service's registration reply could not be read")
    if not got.get("client_id"):
        return _refuse("the sign-in service registered no client id")

    row = {"client_id": got["client_id"], "at": time.time(), "scope": " ".join(asked)}
    # A PUBLIC client has no secret. If one is issued anyway it is kept, because
    # the service then expects it back -- but `none` is what is requested.
    if got.get("client_secret"):
        row["client_secret"] = got["client_secret"]
    _put(_client_key(meta["issuer"]), row)
    return {"ok": True, **row}


# --------------------------------------------------------------------- flow --
def _verifier() -> tuple[str, str]:
    """A PKCE verifier and its S256 challenge, base64url with no padding."""
    raw = secrets.token_urlsafe(64)
    digest = hashlib.sha256(raw.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return raw, challenge


def begin(url: str, hint: str | None = None, allow_write: bool = False) -> dict[str, Any]:
    """Prepare a sign-in. Returns the URL to open; does NOT open it.

    `allow_write` is off by default. See `WRITE_MARKERS`: asking for every scope a
    server advertises would have requested write access to the operator's account
    for a read-only feature.
    """
    meta = discover(url, hint)
    if not meta.get("ok"):
        return meta
    client = _client(meta, allow_write)
    if not client.get("ok"):
        return client
    asked = meta["scopes"] if allow_write else read_scopes(meta.get("scopes") or [])

    verifier, challenge = _verifier()
    state = secrets.token_urlsafe(24)
    _put("mcp_pending:" + state, {
        "url": url, "verifier": verifier, "at": time.time(),
        "token": meta["token"], "issuer": meta["issuer"],
        "client_id": client["client_id"], "resource": meta["resource"],
    })

    q = {
        "response_type": "code",
        "client_id": client["client_id"],
        "redirect_uri": REDIRECT,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # RFC 8707. Binds the token to THIS server, so one issued for a resource
        # cannot be replayed against another.
        "resource": meta["resource"],
    }
    if asked:
        q["scope"] = " ".join(asked)
    return {
        "ok": True,
        "authorize": meta["authorize"] + "?" + urlencode(q),
        "state": state,
        # NAMED ON SCREEN. A grant nobody can see the shape of is a grant nobody
        # checked, and the operator is about to approve it on somebody else's page.
        "scopes": asked,
        "withheld": [x for x in (meta.get("scopes") or []) if x not in asked],
    }


def _pending(state: str) -> dict[str, Any] | None:
    row = _get("mcp_pending:" + state)
    if not row:
        return None
    if (time.time() - row.get("at", 0)) > PENDING_TTL_S:
        _drop("mcp_pending:" + state)
        return None
    return row


def complete(code: str, state: str) -> dict[str, Any]:
    """Exchange the code for a token. The `state` check is the CSRF check."""
    row = _pending(state)
    if not row:
        return _refuse(
            "that sign-in has expired or was not started here. Press Connect again."
        )
    _drop("mcp_pending:" + state)

    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT,
        "client_id": row["client_id"],
        "code_verifier": row["verifier"],
        "resource": row["resource"],
    }
    got = _exchange(row["token"], form)
    if not got.get("ok"):
        return got
    _store(row["url"], row, got["body"])
    log_event("mcp_signin", "signed in to %s" % (httpx.URL(row["url"]).host or row["url"]))
    return {"ok": True, "url": row["url"]}


def _exchange(token_url: str, form: dict[str, str]) -> dict[str, Any]:
    try:
        with _mcp._open() as c:
            r = c.post(token_url, data=form, timeout=30.0,
                       headers={"Accept": "application/json"})
    except httpx.HTTPError as e:
        return _refuse("could not reach the sign-in service: %s" % type(e).__name__)
    try:
        body = r.json()
    except ValueError:
        return _refuse("the sign-in service's reply could not be read")
    if r.status_code >= 400 or not body.get("access_token"):
        # `error_description` is the service's own words and is safe to show; the
        # token never appears in either branch.
        why = body.get("error_description") or body.get("error") or ("HTTP %d" % r.status_code)
        return _refuse("the sign-in was not completed: %s" % why)
    return {"ok": True, "body": body}


def _store(url: str, row: dict[str, Any], body: dict[str, Any]) -> None:
    expires = body.get("expires_in")
    _put(_token_key(url), {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token"),
        "expires_at": (time.time() + float(expires)) if expires else None,
        "scope": body.get("scope"),
        "token_url": row["token"],
        "client_id": row["client_id"],
        "issuer": row["issuer"],
        "resource": row["resource"],
        "at": time.time(),
    })


def token_for(url: str) -> str | None:
    """The access token for a server, refreshed if it is about to expire.

    Returns None rather than raising: `svc/mcp.py` calls this on every request and
    a server needing no sign-in is the ordinary case. A 401 from the transport is
    what turns "no token" into a message the operator can act on.
    """
    row = _get(_token_key(url))
    if not row or not row.get("access_token"):
        return None

    expires_at = row.get("expires_at")
    if expires_at and (time.time() + REFRESH_SKEW_S) >= float(expires_at):
        if not row.get("refresh_token"):
            return None
        got = _exchange(row["token_url"], {
            "grant_type": "refresh_token",
            "refresh_token": row["refresh_token"],
            "client_id": row["client_id"],
            "resource": row.get("resource") or url,
        })
        if not got.get("ok"):
            # Keep the row. A refresh failing once is not proof the sign-in is
            # dead, and deleting it here would silently log the operator out of a
            # service that was briefly unreachable.
            return None
        body = got["body"]
        # A rotated refresh token REPLACES the old one; a service that rotates and
        # is not followed leaves the next refresh using a token it has retired.
        row["access_token"] = body["access_token"]
        if body.get("refresh_token"):
            row["refresh_token"] = body["refresh_token"]
        exp = body.get("expires_in")
        row["expires_at"] = (time.time() + float(exp)) if exp else None
        _put(_token_key(url), row)
    return row["access_token"]


def status(url: str) -> dict[str, Any]:
    """Whether this server is signed in. NEVER the token itself."""
    row = _get(_token_key(url))
    if not row:
        return {"signedIn": False}
    expires_at = row.get("expires_at")
    return {
        "signedIn": True,
        "scope": row.get("scope"),
        "canRefresh": bool(row.get("refresh_token")),
        "expiresIn": max(0, int(float(expires_at) - time.time())) if expires_at else None,
    }


def forget(url: str) -> dict[str, Any]:
    """Sign out: tell the service, then delete locally either way.

    The local delete is unconditional on purpose. An operator who asks to be
    signed out must be signed out of THIS product even if the remote revocation
    cannot be reached — leaving a usable token behind because somebody else's
    service was down would be the opposite of what they asked for.
    """
    row = _get(_token_key(url))
    if not row:
        return _refuse("that server is not signed in")
    revoked = False
    meta = _get(_client_key(row.get("issuer") or ""))
    revoke_url = (meta or {}).get("revoke") or row.get("revoke_url")
    if revoke_url:
        try:
            with _mcp._open() as c:
                r = c.post(revoke_url, data={"token": row["access_token"],
                                             "client_id": row["client_id"]}, timeout=15.0)
            revoked = r.status_code < 400
        except httpx.HTTPError:
            revoked = False
    _drop(_token_key(url))
    _mcp._SESSIONS.pop(url, None)
    log_event("mcp_signout", "signed out of %s" % (httpx.URL(url).host or url))
    return {"ok": True, "revokedRemotely": revoked}


# -------------------------------------------------------------------- routes --
@bp.post("/svc/mcp/connect")
def svc_mcp_connect():
    """Prepare a sign-in and hand back the URL. The OPERATOR opens it."""
    b = request.get_json(silent=True) or {}
    url = b.get("url") or ""
    if not url:
        return _refuse("no address given"), 200
    return begin(url, b.get("resourceMetadata"), bool(b.get("allowWrite"))), 200


@bp.get("/svc/mcp/callback")
def svc_mcp_callback():
    """Where the authorization server sends the operator back.

    Returns a page rather than JSON: a human is reading this, in a browser tab
    they did not open from the terminal. It says what happened and tells them to
    close the tab, because a blank page after signing in is indistinguishable
    from a failure.
    """
    err = request.args.get("error")
    if err:
        detail = request.args.get("error_description") or err
        return _page("Not signed in", detail), 200
    code, state = request.args.get("code") or "", request.args.get("state") or ""
    if not code or not state:
        return _page("Not signed in", "the service sent no authorization back"), 200
    got = complete(code, state)
    if not got.get("ok"):
        return _page("Not signed in", got["why"]), 200
    return _page("Signed in", "You can close this tab and go back to the terminal."), 200


def _page(title: str, detail: str) -> str:
    safe = (detail or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        "<!doctype html><meta charset=utf-8><title>%s</title>"
        "<body style='background:#0f1115;color:#e6e8ee;font:15px/1.6 system-ui;"
        "margin:0;display:grid;place-items:center;height:100vh'>"
        "<div style='max-width:32rem;padding:2rem'>"
        "<h1 style='font:600 20px/1.3 system-ui;margin:0 0 .5rem'>%s</h1>"
        "<p style='margin:0;color:#98a0b3'>%s</p></div>" % (title, title, safe)
    )


@bp.post("/svc/mcp/signout")
def svc_mcp_signout():
    b = request.get_json(silent=True) or {}
    url = b.get("url") or ""
    if not url:
        return _refuse("no address given"), 200
    return forget(url), 200


@bp.get("/svc/mcp/signin-status")
def svc_mcp_signin_status():
    """Per-server sign-in state for the card. Tokens are never in this."""
    return {
        "ok": True,
        "redirect": REDIRECT,
        "servers": [{"url": s["url"], "name": s.get("name"), **status(s["url"])}
                    for s in _mcp.servers()],
    }, 200
