#!/usr/bin/env python3
"""v26.1 — H1 auth guard, H2 heartbeats, H3 circuit breaker, H5 env secrets."""
import importlib.util
import os
import sys
import tempfile
import time

os.environ.pop("MISHEL_TOKEN", None)
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

c = m.app.test_client()
# H1: no token configured -> localhost passes (test client is 127.0.0.1)
ok(c.get('/svc/health').status_code==200, 'H1: localhost allowed when no token set')
# H1: with token set -> requests without it are 401, with it 200
os.environ["MISHEL_TOKEN"]="sekret123"
ok(c.get('/svc/health').status_code==401, 'H1: token set -> missing header rejected (401)')
ok(c.get('/svc/health', headers={"X-Mishel-Token":"wrong"}).status_code==401, 'H1: wrong token rejected')
r=c.get('/svc/health', headers={"X-Mishel-Token":"sekret123"})
ok(r.status_code==200, 'H1: correct token accepted')
j=r.get_json()
ok(j.get("auth") is True, 'H1: health reports auth enabled')
os.environ.pop("MISHEL_TOKEN")
# H2: heartbeats exposed
m.tick("alert_loop"); m.LOOP_TICK["dead_loop"]=time.time()-3600
j=c.get('/svc/health').get_json()
ok('alert_loop' in j.get('loops',{}) and j['loops']['alert_loop']['stale_s']<5, 'H2: fresh loop tick visible')
ok('dead_loop' in j.get('stale_loops',[]), 'H2: >10min-stale loop flagged in stale_loops')
# H3: circuit breaker opens after failure and skips the host
try: m.guarded_get("http://127.0.0.1:1/none", timeout=0.3)
except Exception: pass
opened=False
try: m.guarded_get("http://127.0.0.1:1/none", timeout=0.3)
except RuntimeError as e: opened='circuit open' in str(e)
except Exception: opened=False
ok(opened, 'H3: second call hits an OPEN circuit (backoff, no hammering)')
# H5: env var beats DB for telegram token, never stored
os.environ["MISHEL_TG_TOKEN"]="env-tg-token"
ok(m.cfg("tg_token")=="env-tg-token", 'H5: MISHEL_TG_TOKEN env overrides stored config (secret never on disk)')
os.environ.pop("MISHEL_TG_TOKEN")
# ===== v29.0 #3: backup route round-trip =====
os.environ.pop("MISHEL_TOKEN", None)
r = c.post('/svc/backup', json={"mishel_walletdb": '{"0xabc":{"tier":"S"}}', "_v": 1, "_t": 1234})
ok(r.status_code == 200 and r.get_json().get("ok") is True, 'v29 #3: backup POST stores blob')
r = c.get('/svc/backup')
j = r.get_json()
ok(j.get("ok") and j.get("backup", {}).get("mishel_walletdb") == '{"0xabc":{"tier":"S"}}', 'v29 #3: backup GET round-trips exactly')
print('v29 service additions: OK')
print('\nv26.1 SERVICE HARDENING: %d passed, %d failed'%(P,F));sys.exit(1 if F else 0)
