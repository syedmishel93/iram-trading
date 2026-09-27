"""
MT5: your real fills, the broker's contract specs, and reconciliation.

`/svc/mt5/import` (a history report, no bridge needed), `/svc/mt5/sync` (deals
and specs straight from the terminal), `/svc/recon` (deals -> round trips ->
graded against your journal's plans), `/svc/costs` (the broker's real cost
profile) and `/svc/mt5/status`. Moved out of `mishel_service.py` in v59.

`PROXY` LIVES HERE AND ONLY HERE. `svc/risk.py` reads it as `_mt5.PROXY` at
call time rather than importing the name, so repointing it once repoints both.
A test that forces the "bridge unreachable" path patches THIS module's PROXY;
rebinding `mishel_service.PROXY` would change nothing (see CLAUDE.md on
re-exported names).

HONESTY CONTRACT, CARRIED OVER UNCHANGED
No deals is reported as "unmeasured", never as a dashboard of zeroes. Bars for
excursions say which series they came from, so a capture% computed off vendor
bars is never passed off as broker-exact.
"""

import json
import os
import time

import mishel_recon as RECON
import requests
from db import db
from flask import Blueprint, jsonify, request
from venues import spec_keys

from svc.core import arg_num, log_event, yf_bars

try:
    import mt5_report as MT5REPORT
except Exception:
    MT5REPORT = None
try:
    import mt5_bridge as MT5
except Exception:
    MT5 = None

bp = Blueprint("mt5", __name__)

PROXY = os.environ.get("MISHEL_PROXY", "http://127.0.0.1:8787")


def store_deals(deals, src_label):
    """Upsert by MT5's own ticket id. Re-import the same report ten times: still one
    copy of each deal. Idempotency by primary key beats idempotency by discipline."""
    n = 0
    with db() as c:
        for d in deals:
            try:
                c.execute("""INSERT OR REPLACE INTO mt5_deals(ticket,position_id,time_ms,type,entry,
                             symbol,volume,price,commission,swap,profit,comment,src,imported)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (int(d["ticket"]), d.get("position_id"), int(d["time_ms"]), int(d["type"]),
                           int(d["entry"]), d.get("symbol", ""), float(d.get("volume") or 0),
                           float(d.get("price") or 0), float(d.get("commission") or 0),
                           float(d.get("swap") or 0), float(d.get("profit") or 0),
                           d.get("comment", ""), src_label, time.time()))
                n += 1
            except Exception:
                continue
    return n


def load_deals(days=365):
    cutoff = (time.time() - days * 86400) * 1000
    with db() as c:
        rows = c.execute("SELECT * FROM mt5_deals WHERE time_ms>=? ORDER BY time_ms",
                         (cutoff,)).fetchall()
    return [dict(r) for r in rows]


def load_plans():
    """The plans come from the DECISION JOURNAL, which v35 already mirrors into SQLite.
    That is the payoff of the durable-state work: the server can now grade you against
    your own stated intentions, even though you wrote them in a browser."""
    with db() as c:
        r = c.execute("SELECT v FROM kvstore WHERE k='mishel_journal'").fetchone()
    if not r:
        return []
    try:
        j = json.loads(r[0]) or []
    except Exception:
        return []
    out = []
    for e in j:
        if not isinstance(e, dict) or e.get("entry") is None or e.get("stop") is None:
            continue
        out.append({"symbol": (e.get("sym") or "").upper(),
                    "side": "long" if e.get("dir") == 1 else "short",
                    "entry": e.get("entry"), "stop": e.get("stop"),
                    "t1": e.get("t1"), "t2": e.get("t2"),
                    "time_ms": e.get("t") or e.get("barT"), "strat": e.get("strat")})
    return out


def _wanted_specs():
    """Markets worth a contract spec, beyond the ones already traded.

    The enrolled series are what this operator keeps history for, so they are
    what they are most likely to size next. Read defensively: a spec sync is not
    a reason to fail because an enrolment could not be parsed.
    """
    out = set()
    try:
        from svc.bars import enrolled

        for _src, sym, _tf in enrolled():
            if sym:
                out.add(sym.upper())
    except Exception as e:  # noqa: BLE001 - no enrolment is not a sync failure
        log_event("mt5_specs_enrolment_unread", str(e))
    return out


def load_specs():
    with db() as c:
        rows = c.execute("SELECT * FROM mt5_specs").fetchall()
    return {r["symbol"].upper(): dict(r) for r in rows}


def bars_for_excursions(symbols, days):
    """MFE/MAE needs bars covering each trade. Preference order is an HONESTY order:
      1. the BROKER's own bars (exact — the same series you were filled on)
      2. the browser's ohlc_cache
      3. a vendor (yfinance) — usable, but a different series to your fills
    Whichever is used is REPORTED, so a capture% computed off vendor bars is never
    passed off as broker-exact."""
    out, srcs = {}, {}
    for sym in symbols:
        got = None
        if MT5 is not None and MT5.available()[0]:
            b, _err = MT5.bars(sym, "15m", 5000)
            if b:
                got, srcs[sym] = b, "broker (exact)"
        if got is None:
            with db() as c:
                rows = c.execute("SELECT t,o,h,l,c,v FROM ohlc_cache WHERE sym=? AND tf='15m' ORDER BY t",
                                 (sym.upper(),)).fetchall()
            if rows:
                got, srcs[sym] = [dict(r) for r in rows], "browser cache"
        if got is None:
            b, _err = yf_bars(sym, "15m", need=2000)
            if b:
                got, srcs[sym] = b, "vendor (yfinance) — NOT your fill series"
        if got:
            out[sym] = got
    return out, srcs


@bp.post("/svc/mt5/import")
def mt5_import():
    """Drop in an MT5 history report (HTML or CSV). No Windows, no bridge, no setup.
    You can grade your execution five minutes from now."""
    if MT5REPORT is None:
        return jsonify(ok=False, err="mt5_report module unavailable"), 500
    d = request.get_json(force=True) or {}
    content = d.get("content") or ""
    if not content:
        return jsonify(ok=False, err="content required (the report file's text)"), 400
    res = MT5REPORT.parse(content, d.get("filename", ""), float(d.get("server_utc_offset_h") or 0))
    n = store_deals(res["deals"], "report")
    log_event("mt5_import", f"{n} deals from {res['source']}")
    return jsonify(ok=True, stored=n, parsed=len(res["deals"]),
                   skipped_rows=res["skipped_rows"], source=res["source"],
                   warnings=res["warnings"])


@bp.post("/svc/mt5/sync")
def mt5_sync():
    """Pull deals + specs straight from the running terminal via the bridge."""
    days = int((request.get_json(silent=True) or {}).get("days") or 90)
    try:
        r = requests.get(f"{PROXY}/mt5/deals?days={days}", timeout=30)
        j = r.json()
        if not r.ok or "deals" not in j:
            return jsonify(ok=False, err=j.get("error", "bridge unavailable")), 502
        n = store_deals(j["deals"], "bridge")
        # SYMBOLS FROM DEALS ALONE IS THE SET YOU NO LONGER NEED SIZING FOR.
        # A fresh account has no deals, so it got no specs — and `/svc/risk/size`
        # then refused every trade with "run /svc/mt5/sync", which had just run.
        # The markets worth a spec are the ones enrolled and the ones asked for.
        syms = sorted(
            {d["symbol"] for d in j["deals"] if d.get("symbol")} | set(_wanted_specs())
        )
        specs = 0
        for s in syms:
            try:
                sr = requests.get(f"{PROXY}/mt5/symbol?symbol={s}", timeout=10).json()
                if sr.get("symbol"):
                    # FILED UNDER BOTH NAMES. The bridge answers for `XAUUSD`
                    # with `XAUUSD.s` — this broker's own suffix — and the spec
                    # was stored under that while `/svc/risk/size` looked it up
                    # as `XAUUSD`. MEASURED: specs stored ['BTCUSD.S'], lookup
                    # "BTCUSD" MISS. So a successful sync still left sizing
                    # unable to find anything, on every broker that suffixes.
                    with db() as c:
                        for key in spec_keys(sr["symbol"]):
                            c.execute("""INSERT OR REPLACE INTO mt5_specs(symbol,digits,point,contract_size,
                                         tick_value,tick_size,spread_points,swap_long,swap_short,stops_level,t)
                                         VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                                      (key, sr.get("digits"), sr.get("point"),
                                       sr.get("contract_size"), sr.get("tick_value"), sr.get("tick_size"),
                                       sr.get("spread_points"), sr.get("swap_long"), sr.get("swap_short"),
                                       sr.get("stops_level"), time.time()))
                    specs += 1
            except Exception:
                continue
        log_event("mt5_sync", f"{n} deals, {specs} specs")
        return jsonify(ok=True, stored=n, specs=specs, symbols=syms)
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 502


@bp.get("/svc/recon")
def svc_recon():
    """THE PANEL. deals -> round trips -> graded against your plans -> the leaks.

    If there are no deals we say so and stop. We do not show a beautiful empty
    dashboard of zeroes, because a zero is a claim and we have not measured anything."""
    days = arg_num("days", 180, lo=1, hi=3650)
    deals = load_deals(days)
    if not deals:
        return jsonify(ok=True, empty=True,
                       msg=("No MT5 deals imported. Either POST /svc/mt5/import with a history "
                            "report, or run the bridge on your MT5 machine and POST /svc/mt5/sync. "
                            "Until then your real edge is unmeasured — and the journal's numbers "
                            "are the demo account's, not yours."),
                       stats=RECON.exec_stats([]))
    plans = load_plans()
    specs = load_specs()
    trades = RECON.deals_to_trades(deals)
    syms = sorted({t["symbol"] for t in trades})
    bars, bar_srcs = bars_for_excursions(syms, days)
    rep = RECON.full_report(deals, plans=plans, bars_by_symbol=bars, specs=specs)
    return jsonify(ok=True, empty=False, days=days,
                   deals=len(deals), plans=len(plans),
                   trades=rep["trades"], recons=rep["recons"], stats=rep["stats"],
                   bar_sources=bar_srcs,
                   spec_coverage={s: (s.upper() in specs) for s in syms})


@bp.get("/svc/costs")
def svc_costs():
    """The broker's REAL cost profile per instrument, for the client's cost model.

    For 37 versions every backtest costed every instrument at a flat 2bps and ignored
    commission and swap entirely. This is where that ends. If a symbol is missing here,
    the client LABELS its cost as an assumption rather than quietly using one."""
    specs = load_specs()
    # commission is not in symbol_info — it is in the DEALS. Derive the real per-lot
    # commission he ACTUALLY paid, per symbol, from his own fills. Nothing modelled.
    with db() as c:
        rows = c.execute("""SELECT symbol, SUM(ABS(commission)) AS comm, SUM(volume) AS vol
                            FROM mt5_deals WHERE volume>0 GROUP BY symbol""").fetchall()
    for r in rows:
        sym = (r["symbol"] or "").upper()
        if sym in specs and r["vol"]:
            specs[sym]["commission_per_lot"] = float(r["comm"]) / float(r["vol"])
            specs[sym]["commission_source"] = "your own fills"
    return jsonify(ok=True, specs=specs, count=len(specs),
                   note=("empty means no broker spec imported yet — run /svc/mt5/sync. "
                         "Until then the client costs trades with a LABELLED assumption."))


@bp.get("/svc/mt5/status")
def mt5_status():
    with db() as c:
        n = c.execute("SELECT COUNT(*) FROM mt5_deals").fetchone()[0]
        last = c.execute("SELECT MAX(time_ms) FROM mt5_deals").fetchone()[0]
        specs = c.execute("SELECT COUNT(*) FROM mt5_specs").fetchone()[0]
    br = MT5.health() if MT5 is not None else {"available": False, "reason": "bridge not importable"}
    return jsonify(ok=True, deals=n, last_deal_ms=last, specs=specs, bridge=br)
