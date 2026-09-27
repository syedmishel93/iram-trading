"""server/svc/settings.py — the server settings an OPERATOR is allowed to change.

WHY THIS EXISTS

`scratchpad/svcsweep.py` asked one question of all 61 backend modules — which
config keys are READ by something and written by nothing — and two survived
triage:

  `store_budget_gb`   `svc/store.py` `budget_bytes()` reads it, and it is what the
                      whole eviction policy enforces. Nothing could set it. So the
                      20 GB budget was whatever `DEFAULT_BUDGET_GB` said and could
                      only be changed by editing Python — while the refusal the
                      eviction planner raises when the budget cannot be met
                      without deleting recent history says, in CLAUDE.md's own
                      words, "raise the budget, or drop a market". **THE REMEDY A
                      REFUSAL NAMES HAS TO BE ONE THE PRODUCT OFFERS.** Advice the
                      operator cannot act on is worse than no advice, because it
                      reads as their mistake.

  `pair_scan_tg`      gates the new-pair Telegram alert and defaults to "0".
                      Nothing could set it, so that alert was permanently off and
                      unreachable. "A capability nobody can see is a capability
                      nobody has."

Same family as `bars_enrolled`, the key one module read and zero modules wrote,
which left the hourly top-up loop ticking, reporting a fresh tick age, and
producing no work for a whole release.

WHY A WHITELIST AND NOT A GENERIC CONFIG WRITER

Because `cfg()` also holds `svc_token`, `tg_token` and `tg_chat`. A route that
writes any key is a route that rewrites the service's own auth token from the
browser, and this product already records nearly putting an API key on the wire.
So the settable keys are DECLARED, with a validator each, and everything else is
refused by name. `test_settings.py` proves the refusal on `svc_token`
specifically rather than trusting the list to stay short.

A SETTING IS NOT A SECRET. Credentials keep their own paths — `svc/alerts.py` for
Telegram, `svc/mcpauth.py` for MCP sign-in, both write-only. Nothing here ever
returns a value that could be one, and nothing here accepts one.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from db import db
from flask import Blueprint, jsonify, request

from svc.core import cfg, log_event

bp = Blueprint("settings", __name__)


def _gb(raw: Any) -> tuple[float | None, str]:
    """A disk budget in gigabytes.

    The floor is 0.5 GB rather than 0: a budget of zero asks the eviction planner
    to delete everything, and it would then correctly refuse to obey — a number
    nobody can mean is a number not worth accepting. The ceiling is a sanity
    bound, not a disk check: this process cannot know what the operator will
    attach next, and refusing a big number on a guess is worse than accepting one.
    """
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None, "that is not a number of gigabytes"
    # `v != v` is the NaN test, the one self-comparison that is not a mistake --
    # `float("nan")` parses happily and then compares False against every bound
    # below, so it would sail through as a valid budget. Suppressed narrowly, with
    # the reason on the line, exactly as ruff.toml records for the other four.
    if v != v or v in (float("inf"), float("-inf")):  # noqa: PLR0124
        return None, "that is not a number of gigabytes"
    if v < 0.5:
        return None, "half a gigabyte is the smallest budget worth setting"
    if v > 4096:
        return None, "four terabytes is past anything this store is built for"
    return v, ""


def _flag(raw: Any) -> tuple[str | None, str]:
    """On or off, written as the "0"/"1" the readers already expect."""
    if isinstance(raw, bool):
        return ("1" if raw else "0"), ""
    s = str(raw).strip().lower()
    if s in ("1", "true", "on", "yes"):
        return "1", ""
    if s in ("0", "false", "off", "no"):
        return "0", ""
    return None, "that is not on or off"


def _store_default() -> str:
    """The budget default, READ FROM THE MODULE THAT OWNS IT.

    This field held the literal "20" for one draft, and it was already wrong:
    `svc/store.py` says 5, deliberately, with the owner's own words beside it --
    "20 gb is not a must or a fixed rule ... its a personal computer". Two owners
    for one default, disagreeing on the first day, which is the defect this
    project records as costing it a whole feature more than once. Imported lazily
    for the same reason `budget_bytes` imports `cfg` lazily: these modules load
    through a facade.
    """
    from svc.store import DEFAULT_BUDGET_GB
    return str(DEFAULT_BUDGET_GB)


#: key -> (validator, default, what it does, which module reads it)
#:
#: The default is a CALLABLE so it cannot drift from the module that owns it.
#: The last field is not decoration: it is how the next person finds the reader,
#: and a setting whose reader cannot be named is a setting nobody should add.
SETTABLE: dict[str, tuple[Callable[[Any], tuple[Any, str]], Callable[[], str], str, str]] = {
    "store_budget_gb": (
        _gb, _store_default,
        ("How much disk the bulk history store may use before it starts removing "
         "the oldest and least-used series."),
        "svc/store.py budget_bytes()",
    ),
    "pair_scan_tg": (
        _flag, lambda: "0",
        ("Send a Telegram message when the scanner finds a newly listed token. "
         "Off by default; most new tokens fail."),
        "svc/onchain.py pair_scan_loop()",
    ),
}


def _refuse(why: str, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "why": why}
    out.update(extra)
    return out


def current() -> list[dict[str, Any]]:
    """Every settable key, its value, and whether that value is still the default.

    `isDefault` is reported because "20" chosen by the operator and "20" because
    nobody has ever set it are different facts, and only one of them means the
    number has been thought about.
    """
    out = []
    for key, (_v, default_of, what, reader) in sorted(SETTABLE.items()):
        stored = cfg(key, None)
        default = default_of()
        out.append({
            "key": key,
            "value": stored if stored is not None else default,
            "default": default,
            "isDefault": stored is None,
            "what": what,
            "readBy": reader,
        })
    return out


def set_setting(key: str, raw: Any) -> dict[str, Any]:
    spec = SETTABLE.get(key)
    if spec is None:
        # NAMED, so the refusal is actionable rather than a flat no. The keys
        # deliberately absent are the credentials, and they have their own routes.
        return _refuse(
            "%r is not a setting this can change. These are: %s"
            % (key, ", ".join(sorted(SETTABLE))),
            settable=sorted(SETTABLE),
        )
    validate, _default_of, _what, _reader = spec
    value, why = validate(raw)
    if value is None:
        return _refuse(why)

    stored = str(value)
    with db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, stored),
        )
    # Announced AFTER the write closes: `log_event` opens its own connection, and
    # a nested write asks for the lock this thread already holds.
    log_event("setting", "%s set to %s" % (key, stored))
    return {"ok": True, "key": key, "value": stored}


@bp.get("/svc/settings")
def svc_settings():
    return jsonify({"ok": True, "settings": current()})


@bp.post("/svc/settings")
def svc_settings_set():
    b = request.get_json(silent=True) or {}
    key = b.get("key")
    if not isinstance(key, str) or not key:
        return jsonify(_refuse("no setting named", settable=sorted(SETTABLE)))
    if "value" not in b:
        return jsonify(_refuse("no value given for %r" % key))
    return jsonify(set_setting(key, b["value"]))


def describe() -> str:
    """For `run.py --status` and the log: what the operator has actually chosen."""
    picked = [s for s in current() if not s["isDefault"]]
    if not picked:
        return "server settings: all at their defaults"
    return "server settings: " + json.dumps({s["key"]: s["value"] for s in picked})
