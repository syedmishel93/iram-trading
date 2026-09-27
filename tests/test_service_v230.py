#!/usr/bin/env python3
"""v23.0 — tracking a wallet with a DNA snapshot triggers a Telegram subscribe message."""
import importlib.util
import os
import sys
import tempfile

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

# capture send_tg — on the module that OWNS the route (svc.onchain since v59).
# Rebinding the facade's re-export `m.send_tg` would patch nothing: the route
# resolves send_tg in its own module's globals.
sent=[]
sys.modules['svc.onchain'].send_tg = lambda t: sent.append(t)
c=m.app.test_client()

# track with DNA -> subscribe message
r=c.post('/svc/onchain/watch',json={'wallet':'0xDNA1111111111111111111111111111111111111','chain':'ethereum','min_usd':5000,
    'dna':{'nick':'SOL insider','role':'SNIPER / EARLY','style':'SNIPER','risk':'DISCIPLINED'}})
ok(r.status_code==200 and r.get_json().get('ok'),'track wallet with DNA accepted')
ok(any('NOW TRACKING' in t and 'SNIPER' in t for t in sent),'tracking = subscribe: DNA snapshot Telegram fired on add')
ok(any('you decide' in t for t in sent),'subscribe message keeps the honesty footer')

# track without DNA -> no crash, no snapshot message
sent.clear()
r=c.post('/svc/onchain/watch',json={'wallet':'0xNODNA11111111111111111111111111111111111','chain':'ethereum'})
ok(r.status_code==200 and not any('NOW TRACKING' in t for t in sent),'track without DNA: still works, no snapshot spam')

print('\nv23.0 SERVICE TESTS: %d passed, %d failed'%(P,F));sys.exit(1 if F else 0)
