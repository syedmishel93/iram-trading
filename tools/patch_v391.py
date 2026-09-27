#!/usr/bin/env python3
"""
v39.1 — THE RENDER AUDIT. Fixes A1-A7, B1-B4, C1-C3, D1-D4, E1-E3.

ROOT CAUSE OF THE BROKEN STATUS BAR (A):
Six modules find their insertion point with
    st.querySelector('.s[style*="margin-left"]')
That anchor WAS the "synthetic data" disclaimer div. v39.0 deleted it (the string
was false — right fix) but deleted the NODE with it (wrong: it was a load-bearing
anchor). insertBefore(el, null) silently means appendChild, so every injected
chip landed AFTER the right-aligned risk hero: the stranded OPEN/DAY/CAP, the
orphan --:--:--, and Integrity clipped off the edge in the screenshot.

LESSON: grep for CONSUMERS before deleting a node. A div can be data and an
anchor at the same time.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = os.path.join(ROOT, 'src', '00-head.html')

s = io.open(HEAD, encoding='utf-8', newline='').read()
if 'v39.1 render audit' in s:
    print('  already patched'); sys.exit(0)


def sub(old, new, label, n=1):
    global s
    c = s.count(old)
    assert c == n, f'ANCHOR FAIL [{label}]: expected {n}, found {c}'
    s = s.replace(old, new)
    print(f'  ok  {label}')


# ============================================================ A. STATUS BAR
# A1 + A5: restore the anchor as a REAL mount point. It sits between the quiet
# cluster and the risk hero, owns margin-left:auto (so exactly one element does),
# and carries the marker string the six injectors match on. Injected chips now
# land in a defined slot instead of past the end of the bar.
sub('''    <!-- ===== cluster 3: POSITION TRUTH. The one thing that can stop you. ===== -->
    <div class="st-grp push">''',
    '''    <!-- v39.1 render audit ===============================================
         #stSlot is the LANDING ZONE for legacy injected chips (session, wall
         clock, notif badge, self-test, version...). Six modules locate their
         insertion point via  .s[style*="margin-left"]  \u2014 that selector used to
         match the "synthetic data" disclaimer; deleting it in v39.0 broke every
         insertBefore into silent appendChild. The slot deliberately matches the
         same selector, owns the bar's ONLY margin-left:auto, and is dropped
         before the risk hero ever is (see the overflow rules in the CSS). -->
    <div class="s st-grp quiet2" id="stSlot" style="margin-left:auto"></div>

    <!-- ===== cluster 3: POSITION TRUTH. The one thing that can stop you. ===== -->
    <div class="st-grp push">''',
    'A1/A5: #stSlot mount point restored (the anchor six injectors depend on)')

# A3: two elements own id="stClock". The v35 Jobs X-ray writes into #stClock in
# the markup; 42-draw-loop-extensions ALSO creates <b id="stClock"> for a wall
# clock. getElementById returns the first -> the WALL CLOCK HAS NEVER TICKED
# since v35 (the screenshot's "--:--:--" is it). The markup id is the senior
# claim; the injector is renamed in the JS patch below.
# A4: "Costs Costs REAL" \u2014 renderCostChip() writes the string 'Costs REAL' INTO
# #stCost while the markup also prints a static "Costs " label. Drop the label.
sub('<div class="s" id="stCostWrap" title="What your numbers were costed with">Costs <b id="stCost">\u2014</b></div>',
    '<div class="s" id="stCostWrap" title="What your numbers were costed with"><b id="stCost">\u2014</b></div>',
    'A4: static "Costs" label dropped (the writer prints its own)')

# A7: DAY/OPEN lived in BOTH bars. One home: the status bar (it is the risk
# surface). The top-bar chip keeps SPREAD only \u2014 the entry-cost number, which
# belongs next to the price it prices.
sub('''<div class="riskblk" id="acctChip" title="Day P&amp;L \u00b7 open risk \u00b7 live spread \u2014 the three numbers that gate an entry. Click for the Risk Governor.">'''
    '''<span class="k">DAY</span><span class="v na" id="topDayR">\u2014</span>'''
    '''<span class="sep"></span>'''
    '''<span class="k">OPEN</span><span class="v na" id="topOpenR">\u2014</span>'''
    '''<span class="sep"></span>'''
    '''<span class="k">SPRD</span><span class="v na" id="topSpread">\u2014</span>''',
    '''<div class="riskblk" id="acctChip" title="Live broker spread \u2014 the number every strategy's costR is charged at (v36). DAY/OPEN risk live in the status bar. Click for the Risk Governor.">'''
    '''<span class="k" id="topAcctTag">DEMO</span>'''
    '''<span class="sep"></span>'''
    '''<span class="k">SPRD</span><span class="v na" id="topSpread">\u2014</span>''',
    'A7/E2: top chip = account tag + SPREAD only; DAY/OPEN live in the status bar alone')

# ============================================================ B. CONFLUENCE CARD
# B2/B3: the hero was 700px of narrative \u2014 a sticky element that tall is a wall,
# not a hero. Verdict + meter + agreement stay above the fold; the prose
# (summary, XAI extras, MTF...) moves into a native <details> disclosure.
# renderConfluence's ids (#confSummary #agreeLine) keep working because the
# nodes MOVE, not change.
sub('''      <div class="conf-line" id="confSummary"></div>
      <div class="agree" id="agreeLine"></div>''',
    '''      <details id="confDetails">
        <summary>Full read</summary>
        <div class="conf-line" id="confSummary"></div>
        <div class="agree" id="agreeLine"></div>
      </details>''',
    'B2: confluence narrative behind a "Full read" disclosure (verdict stays above the fold)')

# ============================================================ C. CHROME ROWS
# C2: the instrument header duplicated the top bar AND the chart's own OHLC
# readout \u2014 the third place the price appeared. The consensus / ATR / X-MKT
# chips are the only content not available elsewhere; they become compact and
# the name/price/change copies are retired (display:none, ids intact \u2014 four
# modules still write into them).
sub('<span id="ihName">\u2014</span>\n        <span id="ihPx" class="mono">\u2014</span>\n        <span id="ihChg" class="ih-chip">\u2014</span>',
    '<span id="ihName" class="ih-dead">\u2014</span>\n        <span id="ihPx" class="mono ih-dead">\u2014</span>\n        <span id="ihChg" class="ih-chip ih-dead">\u2014</span>',
    'C2: instrument header price copies retired (ids intact, four writers still land)')

io.open(HEAD, 'w', encoding='utf-8', newline='').write(s)
print('\n  00-head.html patched (v39.1)')
