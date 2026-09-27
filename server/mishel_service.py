#!/usr/bin/env python3
"""
Mishel Intelligence Service v1.0 — persistent background companion to ddt_data_server.py.

What it adds over the browser terminal:
  • SQLite persistence (mishel.db): alert rules, Telegram config, signal ledger — survives restarts.
  • SERVER-SIDE ALERT LOOP: evaluates price rules 24/7 via yfinance and fires Telegram directly,
    even with the browser closed. (yfinance quotes can be delayed ~15m — stated in every message.)
  • SERVER-SIDE LEDGER RESOLVER: signal records pushed by the terminal are scored at +1h/+4h
    against real yfinance closes, so the forward test keeps building while you sleep.
  • REST sync API for the terminal (CORS enabled), port 8788 (env MISHEL_SVC_PORT).

Run:  python3 mishel_service.py            (foreground)
      nohup python3 mishel_service.py &    (background, POSIX)
      see mishel-service.service           (systemd unit for a true persistent service)

Honesty contract: this service never fabricates a price. If yfinance returns nothing,
alerts stay silent and ledger entries stay pending — no synthetic resolution, ever.
"""
import json
import os
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from flask import Flask, jsonify, request
from flask_cors import CORS

# ----------------------------------------------- this directory, on the path ---
# BEFORE ANY LOCAL PACKAGE IMPORT BELOW.
#
# `mishel_service.py` is loaded four different ways: imported by name from the
# gateway, loaded BY PATH with `spec_from_file_location` by several test
# scripts, run directly, and unpacked into `sys._MEIPASS` by PyInstaller. Only
# the first of those puts this directory on `sys.path`, so `from db import ...`
# and `from svc.core import ...` raise ModuleNotFoundError under the other
# three.
#
# It sits HERE, above both, because it once sat between them — and the day
# `svc.core` was extracted, the new import landed above the bootstrap and every
# path-loaded test broke. A bootstrap that only covers some of the imports it
# exists for is a bootstrap that will be wrong again.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

DB   = os.environ.get("MISHEL_SVC_DB", os.path.join(os.path.dirname(__file__), "mishel.db"))

app = Flask(__name__); CORS(app)

# ================= v26.1 HARDENING =================
# H1: bearer-token auth. If MISHEL_TOKEN env (or config row 'svc_token') is set, every /svc/*
# request must send it (X-Mishel-Token header or ?token=). If NOT set, we still refuse any
# non-localhost caller — so flipping MISHEL_SVC_HOST to 0.0.0.0 without a token fails closed.

# ---------------------------------------------------------- the toolkit ---
# MOVED TO `svc/core.py`, RE-EXPORTED HERE ON PURPOSE.
#
# `gateway/background.py` starts every loop with `getattr(mishel_service, name)`
# and twenty-one test scripts reach for `svc.cfg`, `svc.yf_bars`, `svc.db` and
# the rest. Those names have to remain attributes of THIS module, so the
# implementations moved and the names did not. This is a facade, and the import
# below is its whole mechanism.
from svc.core import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    HOST,
    LOOP_TICK,
    PORT,
    YF_INTERVAL,
    YF_MAP,
    YF_PERIOD,
    _svc_token,
    arg_num,
    cfg,
    event_groups,
    events_summary,
    guarded_get,
    log_event,
    send_tg,
    sleep_ticking,
    summarise_events,
    tick,
    yf_bars,
    yf_close_at,
    yf_price,
)


@app.before_request
def _body_shape_guard():
    """A JSON body that is a SCALAR is refused here, once, for every route.

    Twenty routes read the body as `request.get_json(...) or {}` and then call
    `.get(...)` on it. That idiom is correct for `null` and for an absent body --
    both are falsy, so `or {}` fires -- and WRONG for every other scalar: the
    string `"a string"` is truthy, so `.get` reaches a `str` and raises
    AttributeError. The operator then gets Flask's HTML traceback page where a
    sentence belongs, which is the rule this project states about error messages
    being addressed to the operator rather than the developer.

    MEASURED by `scratchpad/postrefuse.py` against a THROWAWAY database: 26
    crashes across 20 routes, 20 of them this one defect.

    It is a `before_request` rather than twenty edits because a per-route fix
    leaves the twenty-first to be written the same way -- the mechanism that hid
    nineteen test files and left `run.py` linted by nothing. A path in no list is
    a path nobody checks.

    LISTS ARE ALLOWED. `/mcp` takes a JSON-RPC BATCH, which is an array, and a
    blanket "objects only" rule would have broken the MCP server on its first
    batch while looking like tightening.
    """
    if request.method not in ("POST", "PUT", "PATCH"):
        return None
    raw = request.get_data(cache=True)
    if not raw or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        # `/mcp` answers a parse failure in JSON-RPC's own shape (code -32700),
        # so it is the one route that must see the bad bytes itself.
        if (request.path or "").startswith("/mcp"):
            return None
        # Everywhere else this was reaching `except Exception as e: ... 500`,
        # which caught Flask's own BadRequest and re-reported a CLIENT error as
        # a server one -- wearing Flask's developer text ("The browser (or
        # proxy) sent a request that this server could not understand") in a
        # field an operator reads.
        return jsonify(ok=False, err="the request body is not valid JSON"), 400
    if isinstance(parsed, (dict, list)):
        return None
    return jsonify(
        ok=False,
        err="this route takes a JSON object; it was sent a single %s value"
            % type(parsed).__name__,
    ), 400


@app.before_request
def _auth_guard():
    if not (request.path or "").startswith("/svc"): return None
    tok = _svc_token()
    if tok:
        got = request.headers.get("X-Mishel-Token") or request.args.get("token")
        if got != tok:
            return jsonify(ok=False, error="unauthorized (set X-Mishel-Token)"), 401
    else:
        ra = (request.remote_addr or "")
        if ra not in ("127.0.0.1", "::1", "localhost"):
            return jsonify(ok=False, error="no token configured; refusing non-localhost. Set MISHEL_TOKEN."), 403
    return None

# ====================================================
from db import db as _connect
from db import describe as db_describe
from db import init

_lock = threading.Lock()

def db():
    """
    A connection to whichever backend is configured.

    SQLite by default; Postgres when IRAM_DB_URL is set. The seventy-nine query
    sites below did not change: `server/db/driver.py` wraps psycopg in
    sqlite3's interface and `server/db/sqlrewrite.py` translates the dialect,
    so this codebase goes on writing `?` placeholders and `INSERT OR REPLACE`
    whichever database is live. See the deviation note at the top of driver.py
    — CLAUDE.md rejects Postgres for good reasons that still hold, which is why
    it is an option and not a replacement.
    """
    return _connect()

init()

# O2: schema migrations — versioned, additive, never destructive
SCHEMA_V = 5
def migrate():
    with db() as c:
        # No version READ, because nothing branches on it yet. There was a
        # `cur = int(cfg("schema_version", "0") or 0)` here whose only purpose was
        # to be mentioned by the comment below -- a query issued on every start
        # for a value nothing looked at. The intent survives without it:
        #
        #   when a migration is needed, read the stored version here and branch on
        #   it, with ADDITIVE ALTERs only. The accumulated ledger is never wiped.
        #
        # SCHEMA_V is 4 and is written unconditionally below, which is correct as
        # long as every schema change so far has been additive.
        c.execute("INSERT INTO config(k,v) VALUES('schema_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",(str(SCHEMA_V),))

# R4: nightly DB backup, keep 7
def backup_loop():
    import glob
    import shutil
    while True:
        tick("backup_loop")
        try:
            dst = DB + ".bak-" + time.strftime("%Y%m%d")
            if not os.path.exists(dst):
                shutil.copyfile(DB, dst)
                for old in sorted(glob.glob(DB + ".bak-*"))[:-7]: os.remove(old)
                log_event("backup", dst)
        except Exception as e: log_event("backup_error", str(e))
        sleep_ticking("backup_loop", 3600)

# run migrations only after cfg/log_event exist (fixes NameError: cfg used before definition)
migrate()

# ---------------- background loops ----------------
# ------------------------------------------------------------ alerts ---
# MOVED TO `svc/alerts.py`; re-exported for the facade.
from svc import alerts as _alerts
from svc.alerts import (  # noqa: F401  (RE-EXPORTS)
    add_alert,
    alert_loop,
    del_alert,
    get_alerts,
    notify,
    set_tg,
)

app.register_blueprint(_alerts.bp)


# ----------------------------------------------------------- signals ---
# MOVED TO `svc/signals.py`; re-exported for the facade.
from svc import signals as _signals
from svc.signals import (  # noqa: F401  (RE-EXPORTS)
    SIG_WORKER,
    run_sig_worker,
    sig_fired_get,
    sig_loop,
    sig_watch_del,
    sig_watch_get,
    sig_watch_post,
)

app.register_blueprint(_signals.bp)


def heartbeat_loop():
    """THE DEAD-MAN'S SWITCH.
    stale_loops in /svc/health tells you a loop is stuck -- IF you look. But if the
    whole service dies, nothing tells you anything, and silence is indistinguishable
    from "no setups today". That is the failure mode that costs money.
    So: invert it. A heartbeat arrives on a schedule. ABSENCE of the heartbeat is
    the alarm. You will notice a missing 08:00 message before the London open."""
    interval = int(os.environ.get("MISHEL_HEARTBEAT_SEC", str(4 * 3600)))
    time.sleep(30)                                              # let the loops register first
    while True:
        tick("heartbeat_loop")
        try:
            now = time.time()
            stale = [k for k, v in LOOP_TICK.items() if now - v > 900]
            with db() as c:
                armed = c.execute("SELECT COUNT(*) FROM sig_watch WHERE enabled=1").fetchone()[0]
                alerts = c.execute("SELECT COUNT(*) FROM alerts WHERE fired IS NULL").fetchone()[0]
                fired24 = c.execute("SELECT COUNT(*) FROM sig_fired WHERE fired_at>?",
                                    (now - 86400,)).fetchone()[0]
            ok = not stale
            send_tg(f"{'\u2705' if ok else '\u26a0'} MISHEL alive \u00b7 "
                    f"{len(LOOP_TICK) - len(stale)}/{len(LOOP_TICK)} loops green"
                    + (f"\n\u26a0 STALE: {', '.join(stale)}" if stale else "")
                    + f"\n{armed} strategies armed \u00b7 {alerts} price alerts \u00b7 {fired24} signals fired (24h)"
                    + "\n\u2014 if this message stops arriving, the desk is DOWN.")
        except Exception as e:
            log_event("heartbeat_error", str(e))
        sleep_ticking("heartbeat_loop", interval)

def ledger_loop():
    while True:
        tick("ledger_loop")
        try:
            now = time.time()
            with db() as c:
                rows = c.execute("SELECT * FROM ledger WHERE h1 IS NULL OR h4 IS NULL").fetchall()
            for r in rows:
                upd = {}
                for col, hz in (("h1", 3600), ("h4", 14400)):
                    if r[col] is None and now - r["t"] >= hz:
                        cl = yf_close_at(r["sym"], r["t"] + hz)
                        if cl is not None:
                            upd[col] = 1 if (cl - r["px"]) * r["score"] > 0 else 0
                if upd:
                    with db() as c:
                        c.execute(f"UPDATE ledger SET {','.join(k+'=?' for k in upd)} WHERE id=?",
                                  (*upd.values(), r["id"]))
        except Exception as e:
            log_event("ledger_loop_error", str(e))
        sleep_ticking("ledger_loop", 300)

# ---------------- REST API ----------------
# -------------------------------------------------------------- sync ---
# MOVED TO `svc/sync.py`; re-exported for the facade.
from svc import sync as _sync
from svc.sync import (  # noqa: F401  (RE-EXPORTS)
    kv_get,
    kv_manifest,
    kv_put,
    svc_backup_get,
    svc_backup_post,
    sync_pull,
    sync_push,
)

app.register_blueprint(_sync.bp)


@app.get("/svc/health")
def health():
    with db() as c:
        n_al = c.execute("SELECT COUNT(*) n FROM alerts WHERE fired IS NULL").fetchone()["n"]
        n_lg = c.execute("SELECT COUNT(*) n FROM ledger").fetchone()["n"]
    now = time.time()
    loops = {k: {"last": int(v), "stale_s": int(now - v)} for k, v in LOOP_TICK.items()}
    stale = [k for k, v in loops.items() if v["stale_s"] > 600]
    return jsonify(ok=True, service="mishel", version="1.0", pending_alerts=n_al, ledger_rows=n_lg,
                   telegram=bool(cfg("tg_token") and cfg("tg_chat")),
                   # WHICH DATABASE THIS IS. A health route that reports row counts
                   # without saying where the rows are is a health route you cannot
                   # use to tell a Postgres install from a SQLite one -- which is
                   # exactly the question after a migration. Never prints a password;
                   # see `describe()` in server/db/driver.py.
                   database=db_describe(),
                   loops=loops, stale_loops=stale, auth=bool(_svc_token()))

@app.post("/svc/ledger")
def push_ledger():
    d = request.get_json(force=True)
    rows = d if isinstance(d, list) else [d]
    # NAME THE MISSING FIELD. This read `r["t"]` straight into a KeyError, so an
    # incomplete row answered with Flask's HTML traceback page. The route is
    # superseded by `/svc/claims` and has no writer, which is a reason to keep it
    # cheap -- not a reason to let it answer a person with a stack trace.
    need = ("t", "sym", "score", "px")
    for r in rows:
        if not isinstance(r, dict):
            return jsonify(ok=False, err="each ledger row must be an object"), 400
        missing = [k for k in need if k not in r]
        if missing:
            return jsonify(ok=False, err="a ledger row is missing %s" % ", ".join(missing)), 400
    with db() as c:
        for r in rows:
            c.execute("INSERT INTO ledger(t,sym,tf,score,px,delayed) VALUES(?,?,?,?,?,?)",
                      (float(r["t"]) / (1000 if r["t"] > 1e12 else 1), r["sym"], r.get("tf", ""),
                       float(r["score"]), float(r["px"]), 1 if r.get("delayed") else 0))
    return jsonify(ok=True, added=len(rows))

@app.get("/svc/ledger")
def get_ledger():
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM ledger ORDER BY t DESC LIMIT 500")]
    by = {}
    for r in rows:
        if r["h1"] is None: continue
        k = f"{r['sym']} {r['tf']}"; v = by.setdefault(k, {"n": 0, "w1": 0, "n4": 0, "w4": 0})
        v["n"] += 1; v["w1"] += r["h1"]
        if r["h4"] is not None: v["n4"] += 1; v["w4"] += r["h4"]
    return jsonify(rows=rows[:100], stats=by)

@app.get("/svc/events")
def get_events():
    # The tail, with a caller-chosen depth. It was a hardcoded 50, which is fine
    # for "what just happened" and useless for "how often has this happened" --
    # that is what /svc/events/summary is for.
    lim = arg_num("limit", 50, lo=1, hi=500)
    with db() as c:
        return jsonify([dict(r) for r in c.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (lim,))])


@app.get("/svc/events/summary")
def get_events_summary():
    """Per-kind counts over the WHOLE events table, failures first.

    The body is `svc/core.py events_summary()`: the MCP server publishes the same
    standing, and two copies of the failure-word list would drift apart with
    nothing saying so.
    """
    return jsonify(events_summary())

# ---------------------------------------------------------- features ---
# MOVED TO `svc/features.py`; re-exported for the facade.
# ---------------------------------------------------------------- bars ---
# The durable bar archive (v60.3). Until it existed every candle this product
# held lived in ONE browser profile's IndexedDB, which the browser was free to
# evict without asking -- measured at one series, 5,803 bars, across the whole
# system. See svc/bars.py.
from svc import bars as _bars
from svc.bars import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    bars_inventory,
    bars_loop,
    get_bars,
    get_enrolled,
    put_bars,
    set_enrolled,
)

app.register_blueprint(_bars.bp)

# --- svc/backfill.py: DEEP history into the bars table (v63.21) -------------
# Not `bulkfetch`: that writes Parquet, which no study reads. This writes the
# table the studies query, because 42 days of 1h is why no arm cleared its
# hurdle. See the module docstring for the measured arithmetic.
from svc import backfill as _backfill
from svc.backfill import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    fetch_deep as backfill_fetch_deep,
)
from svc.backfill import (  # noqa: F401
    source_for as backfill_source_for,
)

app.register_blueprint(_backfill.bp)


# --------------------------------------------------------------- store ---
# The BULK archive: Parquet on disk, queried in place by DuckDB. `svc/bars.py`
# is the hot store; this is the one measured in gigabytes. Both packages are
# optional and the routes refuse by name without them — see svc/store.py.
from svc import store as _store
from svc.store import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    store_evict,
    store_inventory,
)

app.register_blueprint(_store.bp)


from svc import bulkfetch as _bulkfetch
from svc.bulkfetch import (  # noqa: F401  (RE-EXPORTS)
    download_status,
    start_download,
)

app.register_blueprint(_bulkfetch.bp)

# The router (v62.2). A model over the candidate ledger, and — the point of the
# module — whether it knows anything at all. Re-exported here because this file
# is a FACADE: `gateway/background.py` resolves loops by `getattr` on it, and a
# name that lives only in `svc/` is a name nothing can reach.
# --- svc/mcp.py: the MCP engine (v63) ---------------------------------------
# A FACADE RE-EXPORT, per svc/README.md rule 1. Nothing here holds logic; the
# module owns it. Note that `mcp_servers` and friends are re-exports and so are
# SECOND bindings -- a test patches `sys.modules["svc.mcp"]`, never these.
from svc import mcp as _mcp
from svc.mcp import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    call_tool as mcp_call_tool,
)
from svc.mcp import (  # noqa: F401
    embedded_json as mcp_embedded_json,
)
from svc.mcp import (  # noqa: F401
    handshake as mcp_handshake,
)
from svc.mcp import (  # noqa: F401
    servers as mcp_servers,
)
from svc.mcp import (  # noqa: F401
    tools as mcp_tools,
)

app.register_blueprint(_mcp.bp)

# --- svc/mcpserve.py: this product AS an MCP server (v63) -------------------
# The OTHER direction from svc/mcp.py. Off until the operator turns it on, and a
# read-only allowlist when they do -- see the module docstring for why.
from svc import mcpserve as _mcpserve
from svc.mcpserve import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    TOOLS as mcp_serve_tools,
)
from svc.mcpserve import (  # noqa: F401
    enabled as mcp_serve_enabled,
)

app.register_blueprint(_mcpserve.bp)

# --- svc/mcpauth.py: MCP sign-in (v63) --------------------------------------
# AFTER svc/mcp, because it reads `_mcp._open` and `_mcp._SESSIONS` at call time
# -- one binding for the transport, the PROXY pattern in svc/mt5.py.
from svc import mcpauth as _mcpauth
from svc.mcpauth import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    token_for as mcp_token_for,
)

app.register_blueprint(_mcpauth.bp)

# --- svc/settings.py: operator-settable server config (v63.3) ---------------
# Found by `scratchpad/svcsweep.py`: two keys were READ and settable by nothing,
# one of them the disk budget the eviction policy enforces and whose own refusal
# advises raising it.
from svc import settings as _settings
from svc.settings import (  # noqa: F401  (RE-EXPORTS: see the facade note above)
    SETTABLE as SETTABLE_SETTINGS,
)
from svc.settings import (  # noqa: F401
    set_setting,
)

app.register_blueprint(_settings.bp)

from svc import router as _router
from svc.router import train_router  # noqa: F401  (RE-EXPORT: see the facade note above)

app.register_blueprint(_router.bp)

# The autonomous loop (v62.6). It studies whatever the archive holds enough of,
# pools the candidate ledgers and asks the router what it makes of them — the
# same work the Playbook does by hand, unattended. `auto_loop` MUST be reachable
# here: `gateway/background.py` resolves every loop with `getattr` on this
# module, so a loop that lives only in `svc/` is a loop that never starts.
from svc import auto as _auto
from svc.auto import auto_loop, auto_pass, study_subject  # noqa: F401  (RE-EXPORTS: facade)

app.register_blueprint(_auto.bp)


from svc import features as _features
from svc.features import (  # noqa: F401  (RE-EXPORTS)
    data_errors,
    data_loop,
    data_series,
    data_snapshot,
    get_ohlc,
    ml_predict,
    ml_regime,
    put_ohlc,
)

app.register_blueprint(_features.bp)


# ---------------------------------------------------------- research ---
# MOVED TO `svc/research.py`; re-exported for the facade.
from svc import research as _research
from svc.research import (  # noqa: F401  (RE-EXPORTS)
    svc_analyst,
    svc_claims_list,
    svc_claims_push,
    svc_claims_stats,
    svc_edge_conditional,
    svc_edge_kinds,
    svc_edge_push,
    svc_news_rss,
)

app.register_blueprint(_research.bp)


# ---------------------------------------------------------- on-chain ---
# MOVED TO `svc/onchain.py`; re-exported for the facade (see the toolkit note).
from svc import onchain as _onchain
from svc.onchain import (  # noqa: F401  (RE-EXPORTS)
    BLOCKSCOUT_SVC,
    add_watch,
    big_transfers,
    burst_score,
    convergence,
    daily_brief_loop,
    db_alert_loop,
    del_watch,
    flow_state,
    get_wallet_events,
    get_watch,
    leaderboard,
    new_items,
    norm_wallet_transfer,
    pair_scan_loop,
    push_db_wallets,
    smart_copy_loop,
    unwatch_wallet,
    whale_loop,
)

app.register_blueprint(_onchain.bp)

# ------------------------------------------------ mt5 fills + risk ---
# MOVED TO `svc/mt5.py` and `svc/risk.py`; re-exported for the facade.
# PROXY is re-exported for READING only: patch `svc.mt5.PROXY`, which is the
# binding both sections actually consult.
from svc import mt5 as _mt5
from svc import risk as _risk
from svc.mt5 import (  # noqa: F401  (RE-EXPORTS)
    PROXY,
    bars_for_excursions,
    load_deals,
    load_plans,
    load_specs,
    mt5_import,
    mt5_status,
    mt5_sync,
    store_deals,
    svc_costs,
    svc_recon,
)
from svc.risk import (  # noqa: F401  (RE-EXPORTS)
    live_positions,
    risk_cfg,
    risk_state,
    svc_risk_check,
    svc_risk_config,
    svc_risk_size,
    svc_risk_state,
)

app.register_blueprint(_mt5.bp)
app.register_blueprint(_risk.bp)


if __name__ == "__main__":
    print(f"Mishel Intelligence Service v1.0 · http://{HOST}:{PORT} · db={DB}")
    print("  whale-flow watch: ON \u00b7 new-pair scan: ON \u00b7 OHLC cache: ON")
    print("  server-side alert loop: ON · ledger resolver: ON · Telegram:", "configured" if cfg("tg_token") else "not set (POST /svc/telegram)")
    threading.Thread(target=alert_loop, daemon=True).start()
    threading.Thread(target=backup_loop, daemon=True).start()
    threading.Thread(target=data_loop, daemon=True).start()
    threading.Thread(target=ledger_loop, daemon=True).start()
    threading.Thread(target=whale_loop, daemon=True).start()
    threading.Thread(target=pair_scan_loop, daemon=True).start()
    threading.Thread(target=smart_copy_loop, daemon=True).start()
    threading.Thread(target=sig_loop, daemon=True).start()          # v35.0 always-on signals
    threading.Thread(target=heartbeat_loop, daemon=True).start()    # v35.0 dead-man's switch
    threading.Thread(target=db_alert_loop, daemon=True).start()
    threading.Thread(target=daily_brief_loop, daemon=True).start()
    app.run(host=HOST, port=PORT, threaded=True)
