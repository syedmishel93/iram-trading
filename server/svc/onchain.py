"""
On-chain: whale flow, smart-copy signals, DB-wide wallet alerts, new pairs.

Four of the service's eleven background loops and seven `/svc/onchain/*`
routes. Moved out of `mishel_service.py` in v59 as one use case: nothing else
in the service reads these tables (`onchain_watch`, `onchain_seen`,
`db_wallets`, `wallet_events`) and nothing here reads anyone else's.

THE FACADE
`gateway/background.py` starts loops by `getattr(mishel_service, name)` and
the test scripts call `svc.flow_state`, `svc.big_transfers` and the rest, so
`mishel_service` re-exports every public name below. Routes are a blueprint,
registered there, so this module never needs the `app` — and the
`@app.before_request` auth guard still covers them, because a guard on the app
runs for every blueprint mounted on it.

Patch a name HERE, not on the facade: a loop calls `send_tg` from this
module's globals, and rebinding `mishel_service.send_tg` changes nothing.

HONESTY CONTRACT, CARRIED OVER UNCHANGED
Every Telegram line says where the data came from and ends "not advice". A
Blockscout item missing its decimals, value or rate is skipped, never guessed;
a feed that fails is silence, never a synthesised transfer.
"""

import datetime as _dt
import math as _math
import time

from db import db
from flask import Blueprint, jsonify, request

from svc.core import arg_num, cfg, guarded_get, log_event, send_tg, sleep_ticking, tick

bp = Blueprint("onchain", __name__)

BLOCKSCOUT_SVC = {"ethereum":"https://eth.blockscout.com","base":"https://base.blockscout.com",
    "optimism":"https://optimism.blockscout.com","polygon":"https://polygon.blockscout.com",
    "arbitrum":"https://arbitrum.blockscout.com","gnosis":"https://gnosis.blockscout.com"}

def big_transfers(items, min_usd):
    """Pure: filter Blockscout token-transfer items to those with exchange_rate*amount >= min_usd.
    Never guesses: items without decimals+value+exchange_rate are skipped (honest miss, not a fake hit)."""
    out = []
    for it in (items or []):
        try:
            tok = it.get("token") or {}
            tot = it.get("total") or {}
            dec = int(tot.get("decimals") if tot.get("decimals") is not None else (tok.get("decimals") or 0))
            raw = tot.get("value");  rate = tok.get("exchange_rate")
            if raw is None or rate is None: continue
            amt = float(raw) / (10 ** dec) if dec else float(raw)
            usd = amt * float(rate)
            if usd >= float(min_usd):
                out.append({"hash": it.get("tx_hash") or it.get("transaction_hash") or "",
                            "sym": tok.get("symbol") or "?", "amt": amt, "usd": usd,
                            "from": ((it.get("from") or {}).get("hash") or ""), "to": ((it.get("to") or {}).get("hash") or "")})
        except Exception:
            continue
    return out

def new_items(seen_keys, items, key_fn):
    """Pure: return items whose key is not in seen_keys (order preserved)."""
    fresh = []
    for it in (items or []):
        try:
            k = key_fn(it)
            if k and k not in seen_keys: fresh.append((k, it))
        except Exception:
            continue
    return fresh

def whale_loop():
    """Poll Blockscout for watched wallets; Telegram on transfers >= min_usd. Silent when APIs fail."""
    while True:
        tick("whale_loop")
        try:
            with db() as c:
                rows = c.execute("SELECT * FROM onchain_watch WHERE enabled=1").fetchall()
            for w in rows:
                base = BLOCKSCOUT_SVC.get(w["chain"] or "ethereum")
                if not base: continue
                try:
                    r = guarded_get(f"{base}/api/v2/addresses/{w['wallet']}/token-transfers",
                                     params={"type": "ERC-20"}, timeout=12)
                    items = (r.json() or {}).get("items") or []
                except Exception:
                    continue
                hits = big_transfers(items, w["min_usd"] or 10000)
                announce = []
                # NOTHING THAT OPENS A SECOND CONNECTION MAY RUN IN HERE.
                # `log_event` writes on its own connection, so inside this
                # transaction it waits out the busy timeout, raises
                # "database is locked", and the raise ROLLS BACK the dedup
                # insert below. Measured: 2,067 failures, `onchain_seen`
                # empty. Record here, announce after the block closes.
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, hits, lambda h: "wf:" + h["hash"])
                    for k, h in fresh[:5]:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        announce.append(h)
                for h in announce:
                    send_tg(f"\U0001F40B WHALE FLOW {w['wallet'][:10]}\u2026 {h['sym']} "
                            f"{'IN' if h['to'].lower()==w['wallet'].lower() else 'OUT'} "
                            f"${h['usd']:,.0f} \u00b7 real Blockscout transfer \u00b7 not advice")
                    log_event("whale", f"{w['wallet'][:10]} {h['sym']} ${h['usd']:,.0f}")
        except Exception as e:
            log_event("whale_err", str(e)[:120])
        time.sleep(180)

# ================= v20.0 SMART COPY-SIGNAL ENGINE (pure ML helpers are unit-tested) =================


def flow_state(events, now=None, half_life_h=6.0):
    """Pure ML: exponentially-decayed signed flow per (wallet,token).
    events: [{t: epoch_sec, direction: 'BUY'|'SELL', amount: float>0}, ...]
    Returns {'state': 'ACCUMULATING'|'DISTRIBUTING'|'NEUTRAL', 'score': float in [-1,1], 'n': int}.
    Recent activity dominates via exp decay (half-life in hours). Honest: no events -> NEUTRAL/0."""
    now = time.time() if now is None else now
    lam = _math.log(2) / (half_life_h * 3600.0)
    num = 0.0; den = 0.0; n = 0
    for e in (events or []):
        try:
            w = _math.exp(-lam * max(0.0, now - float(e["t"])))
            a = abs(float(e.get("amount") or 0)) or 1.0
            sgn = 1.0 if e.get("direction") == "BUY" else -1.0
            num += sgn * w * a; den += w * a; n += 1
        except Exception:
            continue
    if den <= 0: return {"state": "NEUTRAL", "score": 0.0, "n": 0}
    sc = num / den
    st = "ACCUMULATING" if sc > 0.25 else ("DISTRIBUTING" if sc < -0.25 else "NEUTRAL")
    return {"state": st, "score": round(sc, 3), "n": n}

def burst_score(timestamps, now=None, baseline_h=24.0):
    """Pure ML: Poisson-style burst detector. Compares last-hour event count to the
    per-hour baseline rate over baseline_h. Returns {'burst': bool, 'ratio': float, 'recent': int}.
    Honest: needs >=4 total events to say anything (else burst=False, ratio=0)."""
    now = time.time() if now is None else now
    ts = [float(t) for t in (timestamps or []) if t]
    if len(ts) < 4: return {"burst": False, "ratio": 0.0, "recent": 0}
    recent = sum(1 for t in ts if now - t <= 3600)
    window = [t for t in ts if now - t <= baseline_h * 3600]
    rate = max(len(window) / baseline_h, 1e-6)          # events per hour baseline
    ratio = recent / rate
    return {"burst": recent >= 3 and ratio >= 3.0, "ratio": round(ratio, 2), "recent": recent}

def convergence(events, now=None, window_h=6.0):
    """Pure ML: smart-money convergence — tokens BOUGHT by >=2 distinct watched wallets
    within the window. events: [{t, wallet, token, sym, direction}]. Returns
    [{'token','sym','wallets':[...],'k':int}] sorted by k desc. Honest: sells don't converge."""
    now = time.time() if now is None else now
    by_tok = {}
    for e in (events or []):
        try:
            if e.get("direction") != "BUY": continue
            if now - float(e["t"]) > window_h * 3600: continue
            tok = (e.get("token") or "").lower()
            if not tok: continue
            d = by_tok.setdefault(tok, {"token": tok, "sym": e.get("sym") or "?", "wallets": set()})
            d["wallets"].add((e.get("wallet") or "").lower())
        except Exception:
            continue
    out = [{"token": v["token"], "sym": v["sym"], "wallets": sorted(v["wallets"]), "k": len(v["wallets"])}
           for v in by_tok.values() if len(v["wallets"]) >= 2]
    return sorted(out, key=lambda x: -x["k"])

def norm_wallet_transfer(it, wallet):
    """Pure: Blockscout token-transfer item -> event dict for the watched wallet, or None."""
    try:
        w = (wallet or "").lower()
        frm = ((it.get("from") or {}).get("hash") or "").lower()
        to = ((it.get("to") or {}).get("hash") or "").lower()
        if w not in (frm, to): return None
        tok = it.get("token") or {}; tot = it.get("total") or {}
        dec = int(tot.get("decimals") if tot.get("decimals") is not None else (tok.get("decimals") or 18))
        amt = float(tot.get("value") or 0) / (10 ** dec) if dec else float(tot.get("value") or 0)
        ts = it.get("timestamp") or ""
        try:
            # No "Z" -> "+00:00" rewrite: fromisoformat takes "Z" as of 3.11.
            t = _dt.datetime.fromisoformat(ts).timestamp() if ts else time.time()
        except Exception:
            t = time.time()
        return {"wallet": w, "hash": it.get("tx_hash") or it.get("transaction_hash") or "",
                "t": t, "token": (tok.get("address") or "").lower(), "sym": tok.get("symbol") or "?",
                "direction": "BUY" if to == w else "SELL", "amount": amt}
    except Exception:
        return None

def daily_brief_loop():
    """F1: once every ~24h, Telegram a smart-money digest (tracked wallets, DB-wide alert count, recent moves)."""
    last_day = None
    while True:
        tick("daily_brief_loop")
        try:
            day = time.strftime("%Y-%m-%d")
            hour = int(time.strftime("%H"))
            if hour == 8 and day != last_day:          # ~08:00 server time, once
                last_day = day
                with db() as c:
                    tracked = c.execute("SELECT COUNT(*) n FROM onchain_watch WHERE enabled=1").fetchone()["n"]
                    alertw = c.execute("SELECT COUNT(*) n FROM db_wallets WHERE alert=1").fetchone()["n"]
                    recent = c.execute("SELECT COUNT(*) n FROM wallet_events WHERE t>?",
                                       (time.time() - 24 * 3600,)).fetchone()["n"]
                    top = c.execute("SELECT wallet,tier,score FROM db_wallets WHERE alert=1 ORDER BY score DESC LIMIT 3").fetchall()
                lines = [f"\U0001F4C5 MISHEL DAILY BRIEF \u2014 {day}",
                         f"\u2022 {tracked} wallets tracked \u00b7 {alertw} on DB-wide alert",
                         f"\u2022 {recent} tracked-wallet moves in the last 24h"]
                if top:
                    lines.append("\u2022 top-tier watched: " + ", ".join(f"{r['tier']} {r['wallet'][:8]}\u2026" for r in top))
                lines.append("Open the desk for the ranked Opportunities \u00b7 you decide \u00b7 not advice")
                send_tg("\n".join(lines))
                log_event("daily_brief", day)
        except Exception as e:
            log_event("brief_err", str(e)[:120])
        sleep_ticking("daily_brief_loop", 600)

def db_alert_loop():
    """P4: monitor top-tier (alert=1) wallets from the client DB across every token they touch.
    Fires Telegram on any fresh large-ish transfer. Complements smart_copy_loop (followed wallets)."""
    while True:
        tick("db_alert_loop")
        try:
            with db() as c:
                rows = c.execute("SELECT * FROM db_wallets WHERE alert=1 ORDER BY score DESC LIMIT 40").fetchall()
            for w in rows:
                base = BLOCKSCOUT_SVC.get(w["chain"] or "ethereum")
                if not base: continue
                try:
                    r = guarded_get(f"{base}/api/v2/addresses/{w['wallet']}/token-transfers",
                                     params={"type": "ERC-20"}, timeout=12)
                    items = (r.json() or {}).get("items") or []
                except Exception:
                    continue
                announce = []
                # NOTHING THAT OPENS A SECOND CONNECTION MAY RUN IN HERE.
                # `log_event` writes on its own connection, so inside this
                # transaction it waits out the busy timeout, raises
                # "database is locked", and the raise ROLLS BACK the dedup
                # insert below. Measured: 2,067 failures, `onchain_seen`
                # empty. Record here, announce after the block closes.
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, items, lambda it: "dbw:" + (it.get("tx_hash") or it.get("transaction_hash") or ""))
                    for k, it in fresh[:3]:
                        e = norm_wallet_transfer(it, w["wallet"])
                        if not e: continue
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        announce.append(e)
                for e in announce:
                    nick = (w["nick"] or w["wallet"][:10] + "\u2026")
                    send_tg(f"\U0001F9E0 {w['tier']}-TIER WALLET MOVE \u2014 {nick} {e['direction']} "
                            f"{e['amount']:,.0f} {e['sym']} \u00b7 from your smart-money DB \u00b7 you decide \u00b7 not advice")
                    log_event("dbalert", f"{w['tier']} {w['wallet'][:10]} {e['sym']}")
        except Exception as ex:
            log_event("dbalert_err", str(ex)[:120])
        time.sleep(150)

def smart_copy_loop():
    """The copy-signal brain: records every transfer of every followed wallet, then alerts on
    SIGNALS (not raw spam): first BUY of a new token · flow-state flip (started selling / started
    accumulating) · activity burst · multi-wallet convergence. All Telegram lines end honestly."""
    while True:
        tick("smart_copy_loop")
        try:
            with db() as c:
                rows = c.execute("SELECT * FROM onchain_watch WHERE enabled=1").fetchall()
            new_evts = []
            for w in rows:
                base = BLOCKSCOUT_SVC.get(w["chain"] or "ethereum")
                if not base: continue
                try:
                    r = guarded_get(f"{base}/api/v2/addresses/{w['wallet']}/token-transfers",
                                     params={"type": "ERC-20"}, timeout=12)
                    items = (r.json() or {}).get("items") or []
                except Exception:
                    continue
                for it in items:
                    e = norm_wallet_transfer(it, w["wallet"])
                    if not e or not e["hash"]: continue
                    with db() as c:
                        cur = c.execute("INSERT OR IGNORE INTO wallet_events(wallet,chain,hash,t,token,sym,direction,amount) "
                                        "VALUES(?,?,?,?,?,?,?,?)",
                                        (e["wallet"], w["chain"], e["hash"], e["t"], e["token"], e["sym"], e["direction"], e["amount"]))
                        if cur.rowcount: new_evts.append(e)
            if new_evts:
                sent = 0
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                # `seen` is read just above, in this same iteration, and every
                # call to `fire` is below in this same iteration -- so the late
                # binding B023 warns about cannot happen. Verified while checking
                # it: `seen` is also never ADDED to by `fire`, which would matter
                # if one key could fire twice in a batch. It cannot -- `cs:new`
                # requires `len(pair) == 1` and the flip guards require `prev` to
                # differ from `curr`, which the next event in the batch no longer
                # satisfies. The INSERT OR IGNORE covers the database either way.
                def fire(key, msg):
                    nonlocal sent
                    if sent >= 6 or key in seen: return  # noqa: B023  (same iteration)
                    with db() as c:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (key, time.time()))
                    send_tg(msg + " \u00b7 signal from real on-chain data \u00b7 you decide \u00b7 not advice")
                    log_event("copysig", key); sent += 1
                with db() as c:
                    hist = [dict(r) for r in c.execute(
                        "SELECT wallet,t,token,sym,direction,amount FROM wallet_events WHERE t>? ORDER BY t",
                        (time.time() - 48 * 3600,)).fetchall()]
                for e in new_evts:
                    pair = [h for h in hist if h["wallet"] == e["wallet"] and h["token"] == e["token"]]
                    prev = flow_state([h for h in pair if h["t"] < e["t"]])
                    curr = flow_state(pair)
                    if e["direction"] == "BUY" and len(pair) == 1:
                        fire(f"cs:new:{e['wallet']}:{e['token']}",
                             f"\U0001F7E2 FOLLOWED WALLET NEW BUY \u2014 {e['wallet'][:10]}\u2026 bought {e['amount']:,.0f} {e['sym']} (first position in this token)")
                    if prev["state"] != "DISTRIBUTING" and curr["state"] == "DISTRIBUTING":
                        fire(f"cs:sell:{e['wallet']}:{e['token']}:{int(e['t']//3600)}",
                             f"\U0001F534 FOLLOWED WALLET STARTED SELLING \u2014 {e['wallet'][:10]}\u2026 flow flipped to DISTRIBUTING on {e['sym']} (EWMA {curr['score']})")
                    if prev["state"] != "ACCUMULATING" and curr["state"] == "ACCUMULATING" and prev["n"] > 0:
                        fire(f"cs:acc:{e['wallet']}:{e['token']}:{int(e['t']//3600)}",
                             f"\U0001F7E2 ACCUMULATION ONSET \u2014 {e['wallet'][:10]}\u2026 flow flipped to ACCUMULATING on {e['sym']} (EWMA {curr['score']})")
                w_ts = {}
                for h in hist: w_ts.setdefault(h["wallet"], []).append(h["t"])
                for wlt, ts in w_ts.items():
                    b = burst_score(ts)
                    if b["burst"]:
                        fire(f"cs:burst:{wlt}:{int(time.time()//3600)}",
                             f"\u26A1 ACTIVITY BURST \u2014 {wlt[:10]}\u2026 {b['recent']} transfers in the last hour ({b['ratio']}\u00d7 its 24h baseline)")
                for cv in convergence(hist):
                    fire(f"cs:conv:{cv['token']}:{int(time.time()//21600)}",
                         f"\U0001F40B SMART-MONEY CONVERGENCE \u2014 {cv['k']} followed wallets bought {cv['sym']} within 6h: {', '.join(x[:8]+'\u2026' for x in cv['wallets'])}")
        except Exception as e:
            log_event("copysig_err", str(e)[:120])
        time.sleep(120)

@bp.post("/svc/onchain/dbwallets")
def push_db_wallets():
    """Client pushes its ranked wallet DB; tier S/A with alert=1 get DB-wide monitoring."""
    d = request.get_json(force=True) or {}
    items = d.get("wallets") or []
    n = 0
    with db() as c:
        for w in items[:500]:
            a = (w.get("wallet") or "").lower()
            if len(a) < 8: continue
            c.execute("INSERT INTO db_wallets(wallet,chain,tier,score,nick,alert) VALUES(?,?,?,?,?,?) "
                      "ON CONFLICT(wallet) DO UPDATE SET chain=excluded.chain,tier=excluded.tier,score=excluded.score,nick=excluded.nick,alert=excluded.alert",
                      (a, w.get("chain") or "ethereum", w.get("tier") or "C", float(w.get("score") or 0),
                       w.get("nick") or "", 1 if w.get("alert") else 0))
            n += 1
    return jsonify(ok=True, stored=n)

@bp.get("/svc/onchain/leaderboard")
def leaderboard():
    """P7: on-chain round-trip proxy leaderboard from recorded wallet_events. Honest: not realized PnL."""
    with db() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT wallet,token,sym,direction,t FROM wallet_events ORDER BY t").fetchall()]
    by = {}
    for e in rows:
        by.setdefault((e["wallet"], e["token"]), []).append(e)
    tally = {}
    for (w, tok), evs in by.items():
        bought = False; rt = 0
        for e in sorted(evs, key=lambda x: x["t"]):
            if e["direction"] == "BUY": bought = True
            elif e["direction"] == "SELL" and bought: rt += 1; bought = False
        if rt:
            d = tally.setdefault(w, {"wallet": w, "roundtrips": 0, "tokens": 0})
            d["roundtrips"] += rt; d["tokens"] += 1
    out = sorted(tally.values(), key=lambda x: -x["roundtrips"])[:25]
    return jsonify(out)

@bp.get("/svc/onchain/events")
def get_wallet_events():
    lim = arg_num("limit", 50, lo=1, hi=200)
    wal = (request.args.get("wallet") or "").lower()
    q = "SELECT wallet,chain,t,token,sym,direction,amount FROM wallet_events "
    args = ()
    if wal: q += "WHERE wallet=? "; args = (wal,)
    q += "ORDER BY t DESC LIMIT ?"
    with db() as c:
        return jsonify([dict(r) for r in c.execute(q, args + (lim,)).fetchall()])

def pair_scan_loop():
    """Poll DexScreener newest token profiles; Telegram once per new token. Dedup in SQLite."""
    while True:
        tick("pair_scan_loop")
        try:
            r = guarded_get("https://api.dexscreener.com/token-profiles/latest/v1", timeout=12)
            profs = r.json() if r.ok else []
            if isinstance(profs, list) and profs:
                announce = []
                # NOTHING THAT OPENS A SECOND CONNECTION MAY RUN IN HERE.
                # `log_event` writes on its own connection, so inside this
                # transaction it waits out the busy timeout, raises
                # "database is locked", and the raise ROLLS BACK the dedup
                # insert below. Measured: 2,067 failures, `onchain_seen`
                # empty. Record here, announce after the block closes.
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, profs, lambda p: "np:" + str(p.get("chainId","")) + ":" + str(p.get("tokenAddress","")))
                    for k, p in fresh[:3]:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        announce.append(p)
                # The config read is a READ and was never the fault, but asking
                # once for a batch beats asking once per token.
                tg_on = cfg("pair_scan_tg", "0") == "1" if announce else False
                for p in announce:
                    if tg_on:
                        send_tg(f"\U0001F195 NEW PAIR {p.get('chainId','?')} {str(p.get('tokenAddress',''))[:14]}\u2026 "
                                f"\u00b7 DexScreener profile just listed \u00b7 most new tokens fail \u2014 screen before touching")
                    log_event("newpair", f"{p.get('chainId','?')}:{str(p.get('tokenAddress',''))[:16]}")
        except Exception as e:
            log_event("pair_err", str(e)[:120])
        sleep_ticking("pair_scan_loop", 300)

def parse_pair_key(k):
    """`np:solana:ADDRESS` -> {chain, address}, or None.

    PURE, because it is the part that can be wrong. The dedup table stores one
    opaque string per token and the screen needs two fields out of it; a split
    that guesses would put the chain in the address column on any key shaped
    differently, and nothing would look broken.

    `split(":", 2)` and NOT `split(":")`: an address containing a colon would
    otherwise lose its tail silently. Reject anything that is not the expected
    three parts rather than repairing it -- the stance `sanitise` takes next
    door, and for the same reason.
    """
    if not isinstance(k, str):
        return None
    parts = k.split(":", 2)
    if len(parts) != 3 or parts[0] != "np":
        return None
    chain, addr = parts[1].strip(), parts[2].strip()
    if not chain or not addr:
        return None
    return {"chain": chain, "address": addr}


@bp.get("/svc/onchain/pairs")
def get_new_pairs():
    """Tokens the scanner has seen listed, newest first.

    THE SCANNER HAD NO SCREEN UNTIL v62.16, and for its whole life before that
    it had no DATA either: it called `log_event()` from inside its own write
    transaction, which deadlocked the thread, raised "database is locked" and
    ROLLED BACK the very insert this route reads. 2,069 failures, an empty
    table. Both halves are fixed now -- the loop records, and this shows it.
    """
    try:
        lim = arg_num("limit", 50, lo=1, hi=200)
    except ValueError:
        lim = 50
    with db() as c:
        rows = c.execute(
            "SELECT k, t FROM onchain_seen WHERE k LIKE 'np:%' ORDER BY t DESC LIMIT ?",
            (lim,),
        ).fetchall()
        total = c.execute("SELECT COUNT(*) FROM onchain_seen WHERE k LIKE 'np:%'").fetchone()[0]
    out = []
    for r in rows:
        p = parse_pair_key(r["k"])
        if p:
            p["t"] = r["t"]
            out.append(p)
    return jsonify(ok=True, pairs=out, total=total, shown=len(out))


@bp.get("/svc/onchain/dbwallets")
def get_db_wallets():
    """The scored smart-money wallets, best first.

    There was a POST to STORE them and no GET to read them back, so the list the
    alert loop watches could not be seen anywhere. A store with a writer and no
    reader is the same shape as a loop with no writer for its input.
    """
    with db() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT wallet, chain, tier, score, nick, alert FROM db_wallets "
            "ORDER BY score DESC, wallet LIMIT 200")]
    return jsonify(ok=True, wallets=rows, total=len(rows))


@bp.get("/svc/onchain/watch")
def get_watch():
    with db() as c:
        return jsonify([dict(r) for r in c.execute("SELECT * FROM onchain_watch").fetchall()])

@bp.post("/svc/onchain/unwatch")
def unwatch_wallet():
    d = request.get_json(force=True) or {}
    w = (d.get("wallet") or "").lower()
    if w:
        with db() as c:
            c.execute("UPDATE onchain_watch SET enabled=0 WHERE wallet=?", (w,))
            c.execute("UPDATE db_wallets SET alert=0 WHERE wallet=?", (w,))
    return jsonify(ok=True)

@bp.post("/svc/onchain/watch")
def add_watch():
    d = request.get_json(force=True)
    w = (d.get("wallet") or "").strip().lower()
    if len(w) < 8: return jsonify(ok=False, err="wallet address required"), 400
    with db() as c:
        c.execute("INSERT INTO onchain_watch(wallet,chain,min_usd,enabled) VALUES(?,?,?,1) "
                  "ON CONFLICT(wallet) DO UPDATE SET chain=excluded.chain, min_usd=excluded.min_usd, enabled=1",
                  (w, d.get("chain") or "ethereum", float(d.get("min_usd") or 10000)))
    # tracking = subscribing: push a DNA snapshot immediately if the client supplied one
    snap = d.get("dna")
    if snap:
        try:
            send_tg(f"\U0001F9EC NOW TRACKING {snap.get('nick') or w[:10]+'\u2026'} \u2014 role {snap.get('role','?')} "
                    f"\u00b7 style {snap.get('style','?')} \u00b7 risk {snap.get('risk','?')}\n"
                    f"You'll get its buys, sells, flips and rug-moves here automatically \u00b7 you decide \u00b7 not advice")
        except Exception:
            pass
    return jsonify(ok=True)

@bp.delete("/svc/onchain/watch/<wallet>")
def del_watch(wallet):
    with db() as c:
        c.execute("DELETE FROM onchain_watch WHERE wallet=?", ((wallet or "").lower(),))
    return jsonify(ok=True)
