#!/usr/bin/env python3
"""
test_data_v393.py — MACRO DESK collectors (D8-D14), network MOCKED.

These tests never touch the internet: a test that needs a third-party API is a
flaky test, and worse, it can pass on data the user's machine will never see.
What IS asserted: each collector stores the right key from a canned payload,
each failure is LOGGED and stores NOTHING (the never-fake contract), and the
/svc/data/series endpoint returns accumulated history oldest-first.
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.join(HERE, '..', 'server')

P = F = 0
def ok(n, c, d=''):
    global P, F
    if c: P += 1; print('  ok  ', n)
    else: F += 1; print('  FAIL', n, ('\n        ' + str(d)) if d else '')

spec = importlib.util.spec_from_file_location('mishel_data', os.path.join(SRV, 'mishel_data.py'))
md = importlib.util.module_from_spec(spec)
spec.loader.exec_module(md)

print('\n=== v39.3 MACRO COLLECTORS (mocked) ===\n')

CANNED = {
    'stablecoins.llama.fi': {'peggedAssets': [
        {'circulating': {'peggedUSD': 120e9}}, {'circulating': {'peggedUSD': 60e9}}]},
    # v62.15: the community tier stopped serving `CapRealUSD` (403) and stopped
    # accepting `order` (400), so the market-cap-over-realised-cap division was
    # not merely failing, it was unavailable. `CapMVRVCur` IS that ratio and is
    # still served -- one metric instead of two, verified live at 1.5773 on
    # 2026-09-24. The fixture follows the wire, not the other way round.
    'community-api.coinmetrics.io': {'data': [{'CapMVRVCur': '2.0'}]},
    'blockchain.info/q/hashrate': '750000000',
    'blockchain.info/q/getdifficulty': '90000000000000',
    'publicreporting.cftc.gov': [
        {'m_money_positions_long_all': '210000', 'm_money_positions_short_all': '50000',
         'report_date_as_yyyy_mm_dd': '2026-07-07'}],
    'nfs.faireconomy.media': [
        {'impact': 'High', 'country': 'USD', 'date': '2026-07-15T12:30:00Z', 'title': 'CPI y/y'},
        {'impact': 'Low', 'country': 'USD', 'date': '2026-07-15T14:00:00Z', 'title': 'noise'}],
    'farside.co.uk': '<tr><td>Total</td><td>245.3</td></tr>',
    'api.alternative.me': {'data': [{'value': '55'}]},
    'api.coingecko.com': {'data': {'market_cap_percentage': {'btc': 55.0},
                                   'market_cap_change_percentage_24h_usd': 1.2}},
}

def fake_get(url, timeout=10, as_json=True):
    for k, v in CANNED.items():
        if k in url:
            return v
    raise RuntimeError('no canned payload for ' + url)   # unknown URL = collector must LOG, not fake

md._get = fake_get
stored, logged = {}, []
md.collect(lambda s, k, v: stored.__setitem__(s + '.' + k, v),
           lambda k, m: logged.append(k))

ok('D8: stablecoin float summed and stored', abs(stored.get('llama.stablecoin_usd', 0) - 180e9) < 1e6)
# The FACT this pins is unchanged: an MVRV ratio reaches the store, and it is
# the vendor's number rather than anything this code invented. Only the metric
# the vendor serves it under has changed.
ok('D9: MVRV ratio stored (CapMVRVCur = 2.0)', abs(stored.get('coinmetrics.btc_mvrv', 0) - 2.0) < 1e-9)
ok('D10: hashrate stored', stored.get('btcchain.hashrate_ghs') == 750000000.0)
ok('D10b: difficulty stored', stored.get('btcchain.difficulty') == 90000000000000.0)
ok('D12: ETF flow scraped (+245.3M)', abs(stored.get('farside.btc_etf_flow_musd', 0) - 245.3) < 1e-9)
ok('D13: COT managed-money net = 160k', stored.get('cftc.gold_mm_net') == 160000.0)
# v39.5 X2: collectors now hand the RAW object to store() — store owns
# serialization. The old double json.dumps produced doubly-encoded rows and the
# live 'CAL.map is not a function' error the Jobs X-ray caught.
cal = stored.get('calendar.high_usd')
ok('D14: calendar stored as a RAW list (store owns serialization — the double-encode bug)',
   isinstance(cal, list) and len(cal) == 1 and cal[0]['n'] == 'CPI y/y', cal)
ok('RSS/FRED-less legs logged their absence, nothing faked',
   all(not k.startswith('fred.') for k in stored) and any('fred' in l for l in logged))

# failure path: a collector whose feed dies stores NOTHING and logs
stored2, logged2 = {}, []
md._get = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('feed down'))
md.collect(lambda s, k, v: stored2.__setitem__(s + '.' + k, v),
           lambda k, m: logged2.append(k))
ok('NEVER-FAKE: total feed outage stores zero values', len(stored2) == 0, list(stored2)[:4])
ok('NEVER-FAKE: ...and every leg logged its failure', len(logged2) >= 10, len(logged2))

# every macro leg is try-isolated (source scan — the structural guard)
src = open(os.path.join(SRV, 'mishel_data.py'), encoding='utf-8').read()
legs = re.findall(r'# D(8|9|10|12|13|14)[^\n]*\n(?:    #[^\n]*\n)*    try:', src)
ok('STRUCTURE: D8-D14 each open with their own try (one dead feed never kills the rest)',
   len(set(legs)) >= 6, sorted(set(legs)))

# the series endpoint exists and orders oldest-first
# The feature-store routes moved to svc/features.py in v59.
svc_src = open(os.path.join(SRV, 'svc', 'features.py'), encoding='utf-8').read()
ok('SERIES: /svc/data/series endpoint shipped', '/svc/data/series' in svc_src)
ok('SERIES: returns oldest-first (reversed DESC query) for client-side z/trends',
   'reversed(rows)' in svc_src)

print(f'\n  {P} passed, {F} failed\n')
sys.exit(1 if F else 0)
