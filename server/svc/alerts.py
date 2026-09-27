"""
Price alerts and notifications: the loop that fires them, and Telegram.

`alert_loop` evaluates the operator's price rules 24/7 against yfinance and
fires Telegram with the browser closed; the routes create, list and delete the
rules, store the bot credentials, and let the browser send a message through
the SERVER's secrets so the token never has to live in a page. Moved out of
`mishel_service.py` in v59.

HONESTY CONTRACT, CARRIED OVER UNCHANGED
No price, no evaluation: a symbol yfinance cannot quote is skipped, never
guessed. Every alert says the quote may be ~15 minutes delayed and that the
operator decides and executes.
"""

import os
import time

from db import db
from flask import Blueprint, jsonify, request

from svc.core import cfg, log_event, send_tg, tick, yf_price

bp = Blueprint("alerts", __name__)


def alert_loop():
    while True:
        tick("alert_loop")
        try:
            with db() as c:
                rules = c.execute("SELECT * FROM alerts WHERE fired IS NULL").fetchall()
            for sym in {r["sym"] for r in rules}:
                px, _err = yf_price(sym)
                if px is None:
                    continue  # honesty: no data -> no evaluation, never a guess
                for r in rules:
                    if r["sym"] != sym: continue
                    hit = (r["op"] == "above" and px >= r["price"]) or (r["op"] == "below" and px <= r["price"])
                    if hit:
                        with db() as c:
                            c.execute("UPDATE alerts SET fired=? WHERE id=? AND fired IS NULL", (time.time(), r["id"]))
                        send_tg(f"🔔 SERVER ALERT — {sym} {r['op']} {r['price']}\nlast {px:.4f}"
                                f"{(' · ' + r['note']) if r['note'] else ''}"
                                f"\n⚠ yfinance quote (may be ~15m delayed) — verify at your broker"
                                f"\n— analysis alert, not advice · you decide & execute")
                        log_event("alert_fired", f"{sym} {r['op']} {r['price']} @ {px}")
        except Exception as e:
            log_event("alert_loop_error", str(e))
        time.sleep(int(os.environ.get("MISHEL_ALERT_SEC", "30")))

@bp.post("/svc/telegram")
def set_tg():
    d = request.get_json(force=True)
    with db() as c:
        for k in ("tg_token", "tg_chat"):
            c.execute("INSERT INTO config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      (k, str(d.get(k.split('_')[1] if False else k[3:], d.get(k, "")) or d.get(k[3:], ""))))
    ok = send_tg("✅ Mishel background service connected — server-side alerts are live (works with the browser closed).")
    return jsonify(ok=ok)

@bp.get("/svc/alerts")
def get_alerts():
    with db() as c:
        return jsonify([dict(r) for r in c.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT 100")])

@bp.post("/svc/alerts")
def add_alert():
    d = request.get_json(force=True)
    if d.get("op") not in ("above", "below") or not d.get("sym"): return jsonify(ok=False, err="sym/op"), 400
    with db() as c:
        c.execute("INSERT INTO alerts(sym,op,price,note,created) VALUES(?,?,?,?,?)",
                  (d["sym"].upper(), d["op"], float(d["price"]), d.get("note", ""), time.time()))
    return jsonify(ok=True)

@bp.delete("/svc/alerts/<int:aid>")
def del_alert(aid):
    with db() as c: c.execute("DELETE FROM alerts WHERE id=?", (aid,))
    return jsonify(ok=True)

@bp.post("/svc/notify")
def notify():
    """S4: Telegram via SERVER-stored secrets — browser never needs the token.

    IT REFUSED CORRECTLY AND SAID NOTHING USEFUL. With no credentials stored this
    answered `{"ok": false, "via": "server-secrets"}` — right about the outcome,
    and `via` is an internal word for where the token lives, not a sentence
    anybody can act on. This project's rule is that an error message is addressed
    to the OPERATOR: a JSON parse failure becomes "the news service is not
    answering on this address" and the raw text goes to the log.

    It matters more here than in most places, because the alert loop, the signal
    loop and the dead-man's-switch heartbeat all send through this route. A
    refusal nobody can read is how three loops came to fire into nothing behind
    twelve green dots.

    The two states are now distinct, which is the other half: "no channel is set
    up" is a thing to go and do, and "Telegram would not take it" is a thing that
    may fix itself.
    """
    d = request.get_json(force=True, silent=True) or {}
    text = str(d.get("text", ""))[:3900]
    if not text.strip():
        return jsonify(ok=False, via="server-secrets",
                       why="there was no message to send")
    if not cfg("tg_token") or not cfg("tg_chat"):
        return jsonify(
            ok=False, via="server-secrets", configured=False,
            why="no Telegram channel is set up on this server yet, so there is "
                "nowhere to send it. Add the bot token and chat id on the "
                "Connections card, or set MISHEL_TG_TOKEN and MISHEL_TG_CHAT.",
        )
    ok = send_tg(text)
    if ok:
        return jsonify(ok=True, via="server-secrets", configured=True)
    return jsonify(
        ok=False, via="server-secrets", configured=True,
        why="Telegram did not accept the message. The channel is set up, so this "
            "is the service or the network rather than your settings — the reason "
            "is in the event log under tg_error.",
    )
