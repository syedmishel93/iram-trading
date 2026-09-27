"""Take the side effects OUT of the transaction.

MEASURED, not inferred. `/svc/events` holds 2,067 `pair_err` rows -- the single
largest kind in the log, 46% of every event the service has ever recorded -- and
`onchain_seen` holds ZERO. So `pair_scan_loop` has failed on every run it has
ever made, and the only trace was a route with no screen.

WHAT ACTUALLY BREAKS IT

`log_event()` opens its OWN connection and WRITES. Called from inside
`with db() as c:` it asks for the write lock the same thread is already
holding, which can never be granted; it waits out the busy timeout and raises.
Reproduced exactly:

    cfg() inside an open write transaction     -> '0' in 0.003s   (fine: a READ)
    log_event() inside the same                -> OperationalError
                                                  after 5.56s: database is locked

A nested READ is fine, which is why this is not a "never nest" rule. Two earlier
hypotheses were wrong and were discarded on measurement: a 4-writer/6-reader
workload produced zero lock errors, and so did a bulk-transaction one.

AND THE ROLLBACK IS THE REAL DAMAGE

The raise escapes the `with`, so sqlite3 ROLLS THE TRANSACTION BACK -- including
the `INSERT INTO onchain_seen` that was the whole point. The dedup table can
never fill, so the same tokens are rediscovered every five minutes forever and
the loop is permanently unable to record anything it saw. A failure that only
logs looks survivable; this one silently undid its own work.

THE FIX IS A SHAPE, NOT A PATCH

Record inside the transaction, announce after it closes. That also stops
`send_tg` holding the write lock across a 10-second HTTP call to Telegram, which
is the same class as the 1.1 MB synchronous read inside an `async def` this
project already records.
"""

import io

P = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\server\svc\onchain.py"
s = io.open(P, encoding="utf-8").read()

NOTE = (
    "                # NOTHING THAT OPENS A SECOND CONNECTION MAY RUN IN HERE.\n"
    "                # `log_event` writes on its own connection, so inside this\n"
    "                # transaction it waits out the busy timeout, raises\n"
    "                # \"database is locked\", and the raise ROLLS BACK the dedup\n"
    "                # insert below. Measured: 2,067 failures, `onchain_seen`\n"
    "                # empty. Record here, announce after the block closes.\n"
)

steps = []

# ------------------------------------------------------------ whale_flow ----
steps.append((
    "whale flow",
    '''                hits = big_transfers(items, w["min_usd"] or 10000)
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, hits, lambda h: "wf:" + h["hash"])
                    for k, h in fresh[:5]:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        send_tg(f"\\U0001F40B WHALE FLOW {w['wallet'][:10]}\\u2026 {h['sym']} "
                                f"{'IN' if h['to'].lower()==w['wallet'].lower() else 'OUT'} "
                                f"${h['usd']:,.0f} \\u00b7 real Blockscout transfer \\u00b7 not advice")
                        log_event("whale", f"{w['wallet'][:10]} {h['sym']} ${h['usd']:,.0f}")
''',
    '''                hits = big_transfers(items, w["min_usd"] or 10000)
                announce = []
''' + NOTE + '''                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, hits, lambda h: "wf:" + h["hash"])
                    for k, h in fresh[:5]:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        announce.append(h)
                for h in announce:
                    send_tg(f"\\U0001F40B WHALE FLOW {w['wallet'][:10]}\\u2026 {h['sym']} "
                            f"{'IN' if h['to'].lower()==w['wallet'].lower() else 'OUT'} "
                            f"${h['usd']:,.0f} \\u00b7 real Blockscout transfer \\u00b7 not advice")
                    log_event("whale", f"{w['wallet'][:10]} {h['sym']} ${h['usd']:,.0f}")
''',
))

# -------------------------------------------------------------- db alert ----
steps.append((
    "db alert",
    '''                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, items, lambda it: "dbw:" + (it.get("tx_hash") or it.get("transaction_hash") or ""))
                    for k, it in fresh[:3]:
                        e = norm_wallet_transfer(it, w["wallet"])
                        if not e: continue
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        nick = (w["nick"] or w["wallet"][:10] + "\\u2026")
                        send_tg(f"\\U0001F9E0 {w['tier']}-TIER WALLET MOVE \\u2014 {nick} {e['direction']} "
                                f"{e['amount']:,.0f} {e['sym']} \\u00b7 from your smart-money DB \\u00b7 you decide \\u00b7 not advice")
                        log_event("dbalert", f"{w['tier']} {w['wallet'][:10]} {e['sym']}")
''',
    '''                announce = []
''' + NOTE + '''                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, items, lambda it: "dbw:" + (it.get("tx_hash") or it.get("transaction_hash") or ""))
                    for k, it in fresh[:3]:
                        e = norm_wallet_transfer(it, w["wallet"])
                        if not e: continue
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        announce.append(e)
                for e in announce:
                    nick = (w["nick"] or w["wallet"][:10] + "\\u2026")
                    send_tg(f"\\U0001F9E0 {w['tier']}-TIER WALLET MOVE \\u2014 {nick} {e['direction']} "
                            f"{e['amount']:,.0f} {e['sym']} \\u00b7 from your smart-money DB \\u00b7 you decide \\u00b7 not advice")
                    log_event("dbalert", f"{w['tier']} {w['wallet'][:10]} {e['sym']}")
''',
))

# ------------------------------------------------------------- pair scan ----
steps.append((
    "pair scan",
    '''            if isinstance(profs, list) and profs:
                with db() as c:
                    seen = {x["k"] for x in c.execute("SELECT k FROM onchain_seen").fetchall()}
                    fresh = new_items(seen, profs, lambda p: "np:" + str(p.get("chainId","")) + ":" + str(p.get("tokenAddress","")))
                    for k, p in fresh[:3]:
                        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", (k, time.time()))
                        if cfg("pair_scan_tg", "0") == "1":
                            send_tg(f"\\U0001F195 NEW PAIR {p.get('chainId','?')} {str(p.get('tokenAddress',''))[:14]}\\u2026 "
                                    f"\\u00b7 DexScreener profile just listed \\u00b7 most new tokens fail \\u2014 screen before touching")
                        log_event("newpair", f"{p.get('chainId','?')}:{str(p.get('tokenAddress',''))[:16]}")
''',
    '''            if isinstance(profs, list) and profs:
                announce = []
''' + NOTE + '''                with db() as c:
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
                        send_tg(f"\\U0001F195 NEW PAIR {p.get('chainId','?')} {str(p.get('tokenAddress',''))[:14]}\\u2026 "
                                f"\\u00b7 DexScreener profile just listed \\u00b7 most new tokens fail \\u2014 screen before touching")
                    log_event("newpair", f"{p.get('chainId','?')}:{str(p.get('tokenAddress',''))[:16]}")
''',
))

for name, a, b in steps:
    if s.count(a) != 1:
        raise SystemExit("%s: matched %d times, refusing to edit" % (name, s.count(a)))
    s = s.replace(a, b, 1)

io.open(P, "w", encoding="utf-8").write(s)
print("onchain.py: three loops now announce AFTER the transaction closes")
