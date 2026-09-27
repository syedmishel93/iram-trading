#!/usr/bin/env python3
"""
test_service_v392_loops.py — LIVENESS != CADENCE.

The bug: /svc/health judged every loop against one 600s staleness threshold,
but four loops slept 600-14400s between iterations. They read STALE for most
of every cycle while healthy — a false alarm by construction, on the exact
banner that exists to catch silent failure. A false alarm trains the operator
to ignore the alarm.

The fix: sleep_ticking() — a sleeping loop keeps ticking (20s slices) while it
waits; work runs on its own schedule. These tests make the fix structural:
L4 fails the build if anyone ever writes a long bare time.sleep into a loop
again.
"""
import importlib.util
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.join(HERE, '..', 'server', 'mishel_service.py')

P = F = 0
def ok(name, cond, detail=''):
    global P, F
    if cond: P += 1; print('  ok  ', name)
    else:    F += 1; print('  FAIL', name, ('\n        ' + detail) if detail else '')

# The service AND the sections moved out of it into server/svc/ (v59): the
# loops these checks name by text now live in several files, and reading only
# the facade would report a converted loop as unconverted.
SVC_PKG = os.path.join(HERE, '..', 'server', 'svc')
src = open(SVC, encoding='utf-8').read() + ''.join(
    open(os.path.join(SVC_PKG, f), encoding='utf-8').read()
    for f in sorted(os.listdir(SVC_PKG)) if f.endswith('.py'))

# import the module (same pattern as test_service_v154)
spec = importlib.util.spec_from_file_location('mishel_service', SVC)
svc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(svc)

print('\n=== v39.2 SERVICE LOOP LIVENESS ===\n')

# L1 — the helper exists and RETURNS (no off-by-one hang at the deadline)
t0 = time.time()
svc.sleep_ticking('_t_l1', 0.05)
ok('L1: sleep_ticking returns promptly at its deadline', time.time() - t0 < 1.0)
ok('L1b: ...and registered its tick', '_t_l1' in svc.LOOP_TICK)

# L2 — it ticks REPEATEDLY while waiting (the whole point)
ticks = []
# PATCHED WHERE `sleep_ticking` ACTUALLY LOOKS IT UP.
#
# Both functions used to sit in `mishel_service`, so patching `svc.tick` was
# the same object `sleep_ticking` called. They now live in `svc/core.py` and
# `mishel_service` merely re-exports them — and a re-exported name is a SECOND
# binding, so rebinding it leaves the original untouched and this test silently
# counted zero ticks. The behaviour under test has not changed; where it lives
# has. Patch the module that owns the function, not the one that re-exports it.
_core = sys.modules['svc.core']
_orig = _core.tick
_core.tick = lambda name: (ticks.append(name), _orig(name))

# A FAKE CLOCK, NOT A SHORTER SLEEP.
#
# The previous version of this block patched only time.sleep -- "compress time:
# 20s slices -> 10ms" -- and that does the opposite of what it says.
# sleep_ticking takes its deadline from time.time(), which was left real, so a
# 120s span stayed 120 REAL seconds while each slice shrank to 10ms: the loop
# spun about twelve thousand times instead of six, and the test was slower than
# the thing it measures. It exceeded every gate timeout, which is why it sat
# outside the build for as long as it existed.
#
# Both halves of the pair have to move together. sleep_ticking reads time.time
# and time.sleep off the module at call time, so advancing a counter from the
# patched sleep gives it a consistent clock: 120s of span, 20s per slice, six
# slices, no waiting. The assertion below is unchanged -- the claim being
# tested is the slicing, and this is the first version that can actually
# observe it.
_sleep, _time = time.sleep, time.time
clock = [_time()]
time.time = lambda: clock[0]
time.sleep = lambda s: clock.__setitem__(0, clock[0] + s)
try:
    svc.sleep_ticking('_t_l2', 120)               # 120s span = 6 x 20s slices
finally:
    time.sleep, time.time = _sleep, _time
    _core.tick = _orig
ok('L2: a 120s wait ticks liveness in ~20s slices, not once',
   ticks.count('_t_l2') >= 5, f'{ticks.count("_t_l2")} ticks')

# L3 — a loop that ticks every 20s can never trip the 600s health threshold
#      while merely sleeping. (The health rule itself, asserted from source.)
ok('L3: /svc/health threshold is 600s (unchanged — now correct for every loop)',
   re.search(r'stale_s.\]\s*>\s*600', src) is not None)

# L4 — THE STRUCTURAL GUARD: no bare time.sleep(>=300) inside any *_loop body.
#      This is the assertion that stops the bug coming back in build 45.
bad = []
for m in re.finditer(r'def (\w+_loop)\(\):(.*?)(?=\ndef |\Z)', src, re.DOTALL):
    name, body = m.group(1), m.group(2)
    for sm in re.finditer(r'time\.sleep\(\s*(\d+)\s*\)', body):
        if int(sm.group(1)) >= 300:
            bad.append(f'{name}: time.sleep({sm.group(1)})')
ok('L4: no *_loop sleeps >=300s without ticking (use sleep_ticking)',
   not bad, '; '.join(bad))

# L5 — every sleep_ticking call names the loop that actually ticks at its top,
#      so the health payload attributes staleness to the right thread.
mismatch = []
for m in re.finditer(r'sleep_ticking\("(\w+)"', src):
    if f'tick("{m.group(1)}")' not in src:
        mismatch.append(m.group(1))
ok('L5: every sleep_ticking name pairs with a real tick name', not mismatch, ', '.join(mismatch))

# L6 — the six converted loops, by name
for loop in ('backup_loop', 'data_loop', 'heartbeat_loop',
             'ledger_loop', 'daily_brief_loop', 'pair_scan_loop'):
    ok(f'L6: {loop} uses sleep_ticking', f'sleep_ticking("{loop}"' in src)

print(f'\n  {P} passed, {F} failed\n')
sys.exit(1 if F else 0)
