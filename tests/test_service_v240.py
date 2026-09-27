#!/usr/bin/env python3
"""v24.0 — daily brief loop exists and is wired; service still imports clean."""
import importlib.util
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
spec = importlib.util.spec_from_file_location('mishel_service',
    os.path.join(os.path.dirname(__file__), '..', 'server', 'mishel_service.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
P=F=0
def ok(c,msg):
    global P,F
    if c:P+=1;print('  '+msg+' ✓')
    else:F+=1;print('  '+msg+' ✗ FAIL')
ok(hasattr(m,'daily_brief_loop'),'F1: daily_brief_loop defined')
src=open(os.path.join(os.path.dirname(__file__),'..','server','mishel_service.py'),encoding='utf-8').read()
ok('threading.Thread(target=daily_brief_loop' in src,'F1: daily brief thread started')
# The loop's body moved to svc/onchain.py in v59; the thread start stayed in the facade.
brief=open(os.path.join(os.path.dirname(__file__),'..','server','svc','onchain.py'),encoding='utf-8').read()
ok('DAILY BRIEF' in brief and 'you decide' in brief,'F1: brief content + honesty footer')
# still serves
c=m.app.test_client()
ok(c.get('/svc/onchain/leaderboard').status_code==200,'service endpoints still serve after v24 changes')

# v24.1 unwatch
# This check sat AFTER an unconditional sys.exit for as long as the file
# existed, so it never ran. It is counted with the rest now.
c2=m.app.test_client()
c2.post('/svc/onchain/watch',json={'wallet':'0xUNW1111111111111111111111111111111111111','chain':'ethereum'})
r=c2.post('/svc/onchain/unwatch',json={'wallet':'0xUNW1111111111111111111111111111111111111'})
_ok=(r.status_code==200 and r.get_json().get('ok'))
with m.db() as d:
    row=d.execute("SELECT enabled FROM onchain_watch WHERE wallet=?",('0xunw1111111111111111111111111111111111111',)).fetchone()
ok(bool(_ok and row and row['enabled']==0),'v24.1 unwatch disables tracking')
print('\nv24.0 SERVICE TESTS: %d passed, %d failed'%(P,F));sys.exit(1 if F else 0)
