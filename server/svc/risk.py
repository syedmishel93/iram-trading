"""
The risk governor: account-level risk, from the REAL account.

`/svc/risk/state`, `/svc/risk/check` (the gate a ticket asks before it is
built), `/svc/risk/size` (lots from the broker's contract spec, never a guess)
and `/svc/risk/config`. Moved out of `mishel_service.py` in v59.

It reads the account through `svc/mt5.py`: positions and equity over the
bridge at `_mt5.PROXY`, deals, plans and specs from the loaders there. Those
are referenced through the module, not imported by name, so there is one
binding for each and patching the owner is enough.

HONESTY CONTRACT, CARRIED OVER UNCHANGED
A bridge that cannot be read makes open positions UNKNOWN, not zero, and the
verdict is WARN, never ALLOW. A position with no stop has no definable risk
and is flagged rather than counted as 0R.
"""

import json
import time

import mishel_recon as RECON
import mishel_risk as RISK
import requests
from db import db
from flask import Blueprint, jsonify, request

from svc import mt5 as _mt5

bp = Blueprint("risk", __name__)

def _num(d, key, default=None):
    """A numeric field, or None. NEVER a raise.

    `float(d.get("risk_pct") or 1.0)` raised ValueError on `"lots"` straight out
    of the position sizer, so the operator got Flask's traceback page from the
    one route whose answer is how much money to put at risk. Found by
    `tests/test_post_body_shape.py`, which sent a field of the wrong type to a
    body that was otherwise perfectly well formed -- the shape guard upstream
    cannot see that.
    """
    v = d.get(key)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def risk_cfg():
    """His limits. Defaults are a starting point, not a prescription."""
    cfg = dict(RISK.DEFAULTS)
    try:
        with db() as c:
            for r in c.execute("SELECT k,v FROM risk_cfg"):
                try:
                    cfg[r[0]] = json.loads(r[1])
                except Exception:
                    pass
    except Exception:
        pass
    return cfg


def live_positions():
    """Open positions, with each one's risk expressed in R.

    R is |entry - stop| x contract_size, divided by (equity x risk_per_trade%). That is
    the only definition that lets a EURUSD position and a XAUUSD position be ADDED —
    which is the entire point of an account-level governor.

    A position with NO STOP has no definable risk. We do not call that 0R. We flag it,
    loudly, because an unbounded loss is not a small one.
    """
    try:
        r = requests.get(f"{_mt5.PROXY}/mt5/positions", timeout=8)
        j = r.json() or {}
        # A reachable proxy is NOT a reachable broker. requests does not raise on 4xx/5xx,
        # and an error payload has no "positions" key — reading that as [] would report
        # "no open positions" when the truth is "we cannot see the book". Demand the shape.
        if not r.ok or not isinstance(j.get("positions"), list):
            raise RuntimeError(j.get("error") or f"bridge returned HTTP {r.status_code}")
        ps = j["positions"]
    except Exception as e:
        return [], None, f"MT5 bridge unreachable ({e}) — open positions are UNKNOWN, not zero"
    try:
        ar = requests.get(f"{_mt5.PROXY}/mt5/account", timeout=8)
        aj = ar.json() or {}
        # `is None`, never truthiness: an equity of exactly 0 is a real reading.
        if not ar.ok or aj.get("equity") is None:
            raise RuntimeError(aj.get("error") or f"bridge returned HTTP {ar.status_code}")
        equity = float(aj["equity"])
    except Exception:
        equity = 0.0

    cfg = risk_cfg()
    specs = _mt5.load_specs()
    per_trade_money = equity * float(cfg.get("max_risk_per_trade_pct") or 1.0) / 100.0
    out = []
    for p in ps:
        sym = (p.get("symbol") or "").upper()
        sl = float(p.get("sl") or 0)
        side = "long" if int(p.get("type") or 0) == 0 else "short"
        risk_R = None
        if sl > 0 and per_trade_money > 0:
            spec = specs.get(sym) or {}
            cs = spec.get("contract_size")
            if cs:
                risk_money = abs(float(p.get("price_open") or 0) - sl) * cs * float(p.get("volume") or 0)
                risk_R = risk_money / per_trade_money
        out.append({"symbol": sym, "side": side, "sl": sl,
                    "volume": p.get("volume"), "price_open": p.get("price_open"),
                    "risk_R": risk_R, "ticket": p.get("ticket"),
                    "risk_unknown": (risk_R is None and sl > 0)})
    return out, equity, None


def risk_state():
    deals = _mt5.load_deals(30)
    plans = _mt5.load_plans()
    specs = _mt5.load_specs()
    rep = RECON.full_report(deals, plans=plans, bars_by_symbol={}, specs=specs)
    pos, equity, poserr = live_positions()
    esrc = "MT5 bridge"
    if not equity:
        # The bridge gave us nothing usable. Whatever we fall back to, it is NOT the broker,
        # and the label must not claim it is.
        esrc = "manual (you typed it; the broker was not readable)"
        try:
            with db() as c:
                r = c.execute("SELECT v FROM kvstore WHERE k='mishel_ck_acct'").fetchone()
            equity = float(json.loads(r[0])) if r else 0.0
        except Exception:
            equity = 0.0
        if not equity:
            esrc = "none"
    st = RISK.compute_state(rep["recons"], pos, equity, int(time.time() * 1000), risk_cfg())
    st["position_source_error"] = poserr
    st["equity_source"] = esrc
    return st


@bp.get("/svc/risk/state")
def svc_risk_state():
    st = risk_state()
    return jsonify(ok=True, state=st, config=risk_cfg(),
                   verdict=RISK.evaluate(st, None, risk_cfg()))


@bp.post("/svc/risk/check")
def svc_risk_check():
    """The gate. The client asks BEFORE it builds an order ticket."""
    d = request.get_json(force=True) or {}
    rr, rp = _num(d, "risk_R"), _num(d, "risk_pct")
    bad = [k for k, v in (("risk_R", rr), ("risk_pct", rp)) if k in d and v is None]
    if bad:
        return jsonify(ok=False, err="%s must be a number" % " and ".join(bad)), 400
    prop = {"symbol": str(d.get("symbol") or "").upper(), "side": d.get("side"),
            "risk_R": rr, "risk_pct": rp}
    st = risk_state()
    return jsonify(ok=True, state=st, verdict=RISK.evaluate(st, prop, risk_cfg()))


@bp.post("/svc/risk/size")
def svc_risk_size():
    """Lots from the BROKER'S REAL CONTRACT SPEC. Never a guess.
    (The shipped ticket divided every FX-ish symbol by 100,000 — including XAUUSD,
    whose contract is 100 oz. That sized gold 1000x too small.)"""
    d = request.get_json(force=True) or {}
    sym = str(d.get("symbol") or "").upper()
    specs = _mt5.load_specs()
    spec = specs.get(sym)
    _, equity, _ = live_positions()
    given_eq, given_pct = _num(d, "equity"), _num(d, "risk_pct", 1.0)
    bad = [k for k, v in (("equity", given_eq), ("risk_pct", given_pct)) if k in d and v is None]
    if bad:
        return jsonify(ok=False, err="%s must be a number" % " and ".join(bad)), 400
    equity = float(given_eq or equity or 0)
    lots, detail = RISK.position_size(equity, given_pct if given_pct is not None else 1.0,
                                      _num(d, "entry"), _num(d, "stop"), spec)
    if lots is None:
        return jsonify(ok=False, err=detail, have_spec=bool(spec), equity=equity)
    return jsonify(ok=True, lots=lots, detail=detail if isinstance(detail, dict) else None,
                   note=detail if isinstance(detail, str) else None,
                   spec_source="broker" if spec else None, equity=equity)


@bp.route("/svc/risk/config", methods=["GET", "POST"])
def svc_risk_config():
    if request.method == "GET":
        return jsonify(ok=True, config=risk_cfg(), defaults=RISK.DEFAULTS)
    d = request.get_json(force=True) or {}
    with db() as c:
        for k, v in d.items():
            if k in RISK.DEFAULTS:
                c.execute("INSERT OR REPLACE INTO risk_cfg(k,v,t) VALUES(?,?,?)",
                          (k, json.dumps(v), time.time()))
    return jsonify(ok=True, config=risk_cfg())
