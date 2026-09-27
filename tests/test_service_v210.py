#!/usr/bin/env python3
"""v21.0 — DB-wide alert wallets + round-trip leaderboard, SHIPPED module via flask test_client."""
import importlib.util
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
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
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
P=F=0
def ok(c,msg):
    global P,F
    if c:P+=1;print('  '+msg+' \u2713')
    else:F+=1;print('  '+msg+' \u2717 FAIL')
c=m.app.test_client()

# push DB wallets
r=c.post('/svc/onchain/dbwallets',json={'wallets':[
    {'wallet':'0xAAA1111111111111111111111111111111111111','chain':'ethereum','tier':'S','score':88,'nick':'insider','alert':1},
    {'wallet':'short','chain':'ethereum','tier':'A','score':60,'alert':1}]})
ok(r.status_code==200 and r.get_json().get('stored')==1,'push dbwallets: valid stored, short address rejected')
with m.db() as d:
    row=d.execute("SELECT * FROM db_wallets WHERE wallet=?",('0xaaa1111111111111111111111111111111111111',)).fetchone()
ok(row and row['tier']=='S' and row['alert']==1,'S-tier wallet persisted with alert flag')

# leaderboard from wallet_events (seed a round-trip)
now=time.time()
with m.db() as d:
    for i,(dir_,t) in enumerate([('BUY',now-400),('SELL',now-300),('BUY',now-200),('SELL',now-100)]):
        d.execute("INSERT OR IGNORE INTO wallet_events(wallet,chain,hash,t,token,sym,direction,amount) VALUES(?,?,?,?,?,?,?,?)",
                  ('0xlead','ethereum','lb%d'%i,t,'0xtok','PEPE',dir_,10))
r=c.get('/svc/onchain/leaderboard')
lb=r.get_json()
ok(r.status_code==200 and any(x['wallet']=='0xlead' and x['roundtrips']==2 for x in lb),'leaderboard counts 2 round-trips for the wallet')

print('\nv21.0 SERVICE TESTS: %d passed, %d failed'%(P,F));sys.exit(1 if F else 0)
