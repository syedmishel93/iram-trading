"""
Armed strategies, evaluated with the browser CLOSED.

`sig_loop` fetches bars for every armed (symbol, timeframe), runs the SHIPPED
strategies in Node through `sig_worker.js` -- one source of truth, so the
server cannot drift from what the chart shows -- and Telegrams each fire once.
The routes are the browser's editor for what is armed. Moved out of
`mishel_service.py` in v59.

`SIG_WORKER` IS RESOLVED FROM THE PARENT DIRECTORY. `sig_worker.js` sits in
`server/`, beside `mishel_service.py`; this file sits in `server/svc/`. The
same holds in the frozen binary, where both are unpacked under `_MEIPASS` with
this module one level down.

HONESTY CONTRACT, CARRIED OVER UNCHANGED
Dedup is structural: `sig_fired`'s key includes the bar time, so one bar can
fire once. Only CLOSED bars are scanned. Every message says the bars are
delayed, that it is a distribution rather than a promise, and that nothing
auto-executes.
"""

import json
import os
import time

from db import db
from flask import Blueprint, jsonify, request

from svc.core import arg_num, log_event, send_tg, tick, yf_bars

bp = Blueprint("signals", __name__)


# server/sig_worker.js, one level up from server/svc/ -- see the module note.
SIG_WORKER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sig_worker.js")

def run_sig_worker(payload, timeout=90):
    """Run the SHIPPED 26 strategies in Node. sig_worker.js extracts sigScan/sigStats/
    SIG_DETECT verbatim from index.html — one source of truth, so the server can never
    drift from what you see on the chart."""
    import subprocess
    try:
        p = subprocess.run(["node", SIG_WORKER], input=json.dumps(payload), check=False,
                           capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            return {"ok": False, "err": (p.stderr or "node failed")[:300], "fired": []}
        return json.loads(p.stdout or "{}")
    except FileNotFoundError:
        return {"ok": False, "err": "node not installed — server-side signals need Node.js", "fired": []}
    except Exception as e:
        return {"ok": False, "err": str(e), "fired": []}

def sig_loop():
    """THE ALWAYS-ON TIER. Evaluates your armed strategies with the browser CLOSED.
    Dedup is structural: sig_fired's PK includes bar_t, so one bar can only ever fire once."""
    while True:
        tick("sig_loop")
        try:
            with db() as c:
                rows = [dict(r) for r in c.execute("SELECT * FROM sig_watch WHERE enabled=1").fetchall()]
            groups = {}
            for r in rows:
                groups.setdefault((r["sym"], r["tf"]), []).append(r)

            for (sym, tf), rs in groups.items():
                bars, err = yf_bars(sym, tf, keep_forming=True)
                if bars is None:
                    log_event("sig_loop_nodata", f"{sym} {tf}: {err}")
                    continue                                    # no data -> no evaluation. Never a guess.
                # bars[-1] is the FORMING bar (positional tail only, never scanned).
                # bars[-2] is the newest CLOSED bar — the one we alert on.
                res = run_sig_worker({"bars": bars, "tf": tf, "sym": sym,
                                      "lastClosedIdx": len(bars) - 2,
                                      "strategies": [r["strategy"] for r in rs],
                                      "qGate": min(r["q_gate"] for r in rs)})
                if not res.get("ok"):
                    log_event("sig_loop_worker_error", f"{sym} {tf}: {res.get('err')}")
                    continue
                for f in res.get("fired", []):
                    row = next((r for r in rs if r["strategy"] == f["strategy"]), None)
                    if not row or (f.get("q") or 0) < row["q_gate"]:
                        continue
                    with db() as c:
                        cur = c.execute(
                            "INSERT OR IGNORE INTO sig_fired(sym,tf,strategy,bar_t,fired_at,dir,entry,stop,t1,t2,q,record)"
                            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            (sym, tf, f["strategy"], f["barT"], time.time(), f["dir"], f["entry"],
                             f["stop"], f["t1"], f["t2"], f["q"], json.dumps(f.get("record") or {})))
                        if cur.rowcount == 0:
                            continue                            # already fired on this bar. Structural dedup.
                    rec = f.get("record") or {}
                    wp = rec.get("winPct")
                    rec_line = (f"measured: {rec.get('resolved',0)} resolved \u00b7 "
                                f"win {round(wp*100)}%" if wp is not None else "measured: no resolved history yet")
                    if rec.get("ciLo") is not None:
                        rec_line += f" (95% CI {round(rec['ciLo']*100)}-{round(rec['ciHi']*100)}%)"
                    if rec.get("netAvgR") is not None:
                        rec_line += f" \u00b7 net avgR {rec['netAvgR']:.2f}"
                    send_tg(
                        f"\U0001F514 SIGNAL \u2014 {f['name']}\n"
                        f"{sym} {tf} \u00b7 {f['dir']} \u00b7 quality {f['q']}/100\n"
                        f"entry {f['entry']:.5f}\nstop {f['stop']:.5f}\nT1 {f['t1']:.5f}  T2 {f['t2']:.5f}\n"
                        f"{rec_line}\n"
                        f"\u26a0 yfinance bars (~15m delayed) \u2014 VERIFY AT YOUR BROKER before acting.\n"
                        f"\u2014 a distribution, not a promise \u00b7 nothing auto-executes \u00b7 you decide & execute at MT5")
                    log_event("sig_fired", f"{sym} {tf} {f['strategy']} {f['dir']} q{f['q']}")
        except Exception as e:
            log_event("sig_loop_error", str(e))
        time.sleep(int(os.environ.get("MISHEL_SIG_SEC", "60")))

# ---------------- v35.0: armed-strategy CRUD (the browser is now just an editor) ----------------
@bp.get("/svc/sig/watch")
def sig_watch_get():
    with db() as c:
        rows = c.execute("SELECT * FROM sig_watch ORDER BY sym, tf, strategy").fetchall()
    return jsonify(ok=True, watch=[dict(r) for r in rows])

@bp.post("/svc/sig/watch")
def sig_watch_post():
    d = request.get_json(force=True) or {}
    sym, tf, st = (d.get("sym") or "").upper(), d.get("tf") or "1h", d.get("strategy") or ""
    if not sym or not st:
        return jsonify(ok=False, err="sym + strategy required"), 400
    with db() as c:
        c.execute("INSERT INTO sig_watch(sym,tf,strategy,q_gate,enabled,created) VALUES(?,?,?,?,1,?)"
                  " ON CONFLICT(sym,tf,strategy) DO UPDATE SET q_gate=excluded.q_gate, enabled=1",
                  (sym, tf, st, int(d.get("q_gate") or 50), time.time()))
    log_event("sig_armed", f"{sym} {tf} {st}")
    return jsonify(ok=True)

@bp.delete("/svc/sig/watch/<int:wid>")
def sig_watch_del(wid):
    with db() as c: c.execute("DELETE FROM sig_watch WHERE id=?", (wid,))
    return jsonify(ok=True)

@bp.get("/svc/sig/fired")
def sig_fired_get():
    lim = arg_num("n", 50, lo=1, hi=200)
    with db() as c:
        rows = c.execute("SELECT * FROM sig_fired ORDER BY fired_at DESC LIMIT ?", (lim,)).fetchall()
    return jsonify(ok=True, fired=[dict(r) for r in rows])
