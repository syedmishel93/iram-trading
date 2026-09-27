#!/usr/bin/env python3
"""v20.0 SMART COPY-SIGNAL ENGINE — tests run the SHIPPED service module (no network)."""
import importlib.util
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
os.environ['MISHEL_TEST'] = '1'
# ISOLATE THE DATABASE BEFORE THE MODULE IS IMPORTED.
#
# mishel_service reads MISHEL_SVC_DB at import time and falls back to
# server/mishel.db -- the operator's REAL database. This file did not set it,
# so every run of this test opened, created tables in and wrote to the live
# desk DB. MEASURED, which is how it was found: running it advanced
# sqlite_sequence for `wallet_events` (632 -> 637) and `onchain_watch`
# (246 -> 248) and replaced the single `kv.client_backup` row -- the browser's
# settings backup -- with this suite's fixture (`0xabc`, tier S). Row counts
# came back even, because the test cleans up after itself; the autoincrement
# ids and the clobbered backup row do not come back.
#
# Its siblings v35.0, v36.0 and v37.0 all set this line. These four did not,
# and nothing in the suite would ever have said so.
#
# tempfile.mktemp rather than NamedTemporaryFile: sqlite wants to create the
# file itself, and on Windows it cannot open one that is already held open.
os.environ['MISHEL_SVC_DB'] = tempfile.mktemp(suffix='.db')

spec = importlib.util.spec_from_file_location('mishel_service',
    os.path.join(os.path.dirname(__file__), '..', 'server', 'mishel_service.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

P = F = 0
def ok(c, msg):
    global P, F
    if c: P += 1; print('  ' + msg + ' \u2713')
    else: F += 1; print('  ' + msg + ' \u2717 FAIL')

now = time.time()

# flow_state — EWMA signed flow
buys = [{'t': now - i * 600, 'direction': 'BUY', 'amount': 100} for i in range(5)]
st = m.flow_state(buys, now)
ok(st['state'] == 'ACCUMULATING' and st['score'] > 0.9, 'all-buys -> ACCUMULATING (score %s)' % st['score'])
sells_recent = buys + [{'t': now - 60, 'direction': 'SELL', 'amount': 800}]
st2 = m.flow_state(sells_recent, now)
ok(st2['score'] < st['score'], 'one big fresh sell drags the EWMA down (%s -> %s)' % (st['score'], st2['score']))
old_buys_new_sells = [{'t': now - 40 * 3600, 'direction': 'BUY', 'amount': 500}] + \
    [{'t': now - i * 300, 'direction': 'SELL', 'amount': 200} for i in range(4)]
st3 = m.flow_state(old_buys_new_sells, now)
ok(st3['state'] == 'DISTRIBUTING', 'old buys + fresh sells -> DISTRIBUTING (started selling detected)')
ok(m.flow_state([], now)['state'] == 'NEUTRAL', 'no events -> NEUTRAL, nothing invented')

# burst_score
base_ts = [now - h * 3600 for h in range(2, 24)]          # ~1/hour baseline
quiet = m.burst_score(base_ts, now)
ok(not quiet['burst'], 'steady 1/h activity -> no burst')
bursty = base_ts + [now - 60 * i for i in range(6)]        # 6 in the last hour
b = m.burst_score(bursty, now)
ok(b['burst'] and b['ratio'] >= 3, 'x%s spike in last hour -> BURST' % b['ratio'])
ok(not m.burst_score([now - 10, now - 20], now)['burst'], '<4 total events -> honestly silent')

# convergence
ev = [
    {'t': now - 100, 'wallet': '0xA', 'token': '0xT', 'sym': 'PEPE', 'direction': 'BUY'},
    {'t': now - 200, 'wallet': '0xB', 'token': '0xT', 'sym': 'PEPE', 'direction': 'BUY'},
    {'t': now - 300, 'wallet': '0xC', 'token': '0xU', 'sym': 'WIF', 'direction': 'BUY'},
    {'t': now - 400, 'wallet': '0xD', 'token': '0xT', 'sym': 'PEPE', 'direction': 'SELL'},
    {'t': now - 9 * 3600, 'wallet': '0xE', 'token': '0xT', 'sym': 'PEPE', 'direction': 'BUY'},
]
cv = m.convergence(ev, now, 6.0)
ok(len(cv) == 1 and cv[0]['k'] == 2 and set(cv[0]['wallets']) == {'0xa', '0xb'},
   'convergence: 2 wallets bought same token in-window; sells and stale buys excluded')

# norm_wallet_transfer
it = {'from': {'hash': '0xOTHER'}, 'to': {'hash': '0xME'}, 'tx_hash': '0xh1',
      'timestamp': '2026-07-10T08:00:00Z',
      'token': {'symbol': 'PEPE', 'address': '0xTOK', 'decimals': '18'},
      'total': {'value': '5' + '0' * 18, 'decimals': '18'}}
e = m.norm_wallet_transfer(it, '0xME')
ok(e and e['direction'] == 'BUY' and abs(e['amount'] - 5.0) < 1e-9, 'incoming transfer -> BUY with decimal-scaled amount')
e2 = m.norm_wallet_transfer(it, '0xUNRELATED')
ok(e2 is None, 'transfer not touching the wallet -> None')

# events route (flask test_client, real SQLite)
c = m.app.test_client()
with m.db() as d:
    d.execute("INSERT OR IGNORE INTO wallet_events(wallet,chain,hash,t,token,sym,direction,amount) VALUES(?,?,?,?,?,?,?,?)",
              ('0xme', 'ethereum', '0xh_test_v200', now, '0xtok', 'PEPE', 'BUY', 5.0))
r = c.get('/svc/onchain/events?limit=5')
ok(r.status_code == 200 and any(x['hash' if 'hash' in (x or {}) else 'sym'] == 'PEPE' or x.get('sym') == 'PEPE' for x in r.get_json()),
   'GET /svc/onchain/events returns stored wallet events')
r2 = c.get('/svc/onchain/events?wallet=0xnobody')
ok(r2.status_code == 200 and r2.get_json() == [], 'wallet filter honest-empty')

print('\nv20.0 SERVICE ML TESTS: %d passed, %d failed' % (P, F))
sys.exit(1 if F else 0)
