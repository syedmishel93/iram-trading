#!/usr/bin/env python3
"""
v39.0 — SHELL PATCH (stages 1-4). Exact-string, count-asserted, loud on failure.
Idempotent: refuses to run twice (checks for the v39 sentinel).
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = os.path.join(ROOT, 'src', '00-head.html')
CSS  = os.path.join(ROOT, 'src', 'css', 'v39-shell.css')

s = io.open(HEAD, encoding='utf-8', newline='').read()

if 'v39.0 — SHELL' in s:
    print('  already patched — no-op'); sys.exit(0)


def sub(old, new, label, n=1):
    global s
    c = s.count(old)
    assert c == n, f'ANCHOR FAIL [{label}]: expected {n}, found {c}'
    s = s.replace(old, new)
    print(f'  ok  {label}')


# ---------------------------------------------------------------- STAGE 0/CSS
# The shell CSS lives where every other rule in this project lives: inside the
# one <style> block, LAST, so source order makes it the authority.
css = io.open(CSS, encoding='utf-8', newline='').read()
sub('</style>', css + '\n</style>', 'css: v39 shell layer appended (last = authority)')


# ------------------------------------------------------------------- STAGE 1
# (fsBtn and the other 7 icon-only controls: see tools/repair_icons_v39.py)

# theme picker: the purge left leading spaces; also drop the essay in the title
import re as _re
_m = _re.search(r'<select id="themeSel".*?</select>', s, _re.S)
assert _m, 'theme select not found'
sub(_m.group(0),
    '<select id="themeSel" class="tbtn slim" title="Theme">'
    '<optgroup label="Curated">'
    '<option value="institutional">Institutional</option>'
    '<option value="tradingview">TradingView</option>'
    '</optgroup>'
    '<optgroup label="Legacy">'
    '<option value="midnight">Midnight</option>'
    '<option value="binance">Binance</option>'
    '<option value="trendspider">TrendSpider</option>'
    '<option value="frost">Frost</option>'
    '<option value="light">Light</option>'
    '</optgroup></select>',
    'top: theme picker -> Curated / Legacy optgroups (the \u2605 said WHICH two were curated; an optgroup says it better and says why)')

# Bal/Eq were static demo numbers. Replace the chip with the three numbers that
# actually gate an entry — day P&L, open risk, live broker spread — while KEEPING
# #acctBal / #acctEq (existing JS writes to them) inside it.
sub('<div class="feed acct" id="acctChip" title="Demo account — balance / equity">'
    '<span class="acct-k">Bal</span> <span id="acctBal" class="mono">$10000</span> '
    '<span class="acct-sep">·</span> <span class="acct-k">Eq</span> <span id="acctEq" class="mono">$10000</span></div>',
    '<div class="riskblk" id="acctChip" title="Day P&amp;L · open risk · live spread — the three numbers that gate an entry. Click for the Risk Governor.">'
    '<span class="k">DAY</span><span class="v na" id="topDayR">—</span>'
    '<span class="sep"></span>'
    '<span class="k">OPEN</span><span class="v na" id="topOpenR">—</span>'
    '<span class="sep"></span>'
    '<span class="k">SPRD</span><span class="v na" id="topSpread">—</span>'
    '<span class="acct-hidden" style="display:none">'
    '<span id="acctBal" class="mono">$10000</span><span id="acctEq" class="mono">$10000</span></span></div>',
    'top: Bal/Eq chip -> DAY / OPEN / SPREAD risk block')

# theme select + density + fullscreen are set once a year, not once a trade.
# Fold them into the ⋯ panel. IDs are preserved, so every JS binding still lands.
sub('<div class="more-sec">Appearance</div>\n        <div id="moreTheme" class="more-row"></div>',
    '<div class="more-sec">Appearance</div>\n        <div class="more-row" id="moreShell"></div>\n        <div id="moreTheme" class="more-row"></div>',
    'top: ⋯ panel gets an Appearance row for the folded controls')


# ------------------------------------------------------------------- STAGE 2
# STATUS BAR. Was: 28px, nine identical 10px chips, and a hardcoded
# "· synthetic data ·" string that became FALSE the moment v36 wired MT5 in.
# Now: three clusters — system truth (left) · context (quiet, collapses first)
# · position truth (right, 2x weight). Every original id is preserved.
OLD_STATUS_HEAD = '<div class="status">\n    <div class="s" style="white-space:nowrap;flex:none;overflow:hidden" title="Live data source'
assert s.count(OLD_STATUS_HEAD) == 1, 'status bar anchor moved'
i = s.index('<div class="status">')
TAIL = ('    <div class="s" style="margin-left:auto">Mishel Intelligence Trading \u00b7 synthetic data '
        '\u00b7 not financial advice</div>\n  </div>')
assert s.count(TAIL) == 1, 'status bar tail anchor moved'
j = s.index(TAIL, i) + len(TAIL)

new_status = '''<div class="status" role="status" aria-live="polite">

    <!-- ===== cluster 1: SYSTEM TRUTH. Can the tape be trusted right now? ===== -->
    <div class="st-grp" id="stSys">
      <span id="stMode" class="local" title="What you are actually looking at. This tag is derived from the live feed — it is never asserted.">LOCAL</span>
      <div class="s click" style="white-space:nowrap;flex:none;overflow:hidden" title="Live data source — MT5 broker first, then Binance → Bybit → Kraken → Coinbase → OKX → KuCoin → Gate.io; or force one"><span class="dot"></span>SRC <select id="srcPick" style="background:transparent;border:0;color:var(--txt);font-family:var(--mono);font-size:var(--fs-sm);outline:none;cursor:pointer;max-width:80px"><option value="">Auto</option><option value="binance">Binance</option><option value="bybit">Bybit</option><option value="kraken">Kraken</option><option value="coinbase">Coinbase</option><option value="okx">OKX</option><option value="kucoin">KuCoin</option><option value="gate">Gate.io</option></select> <b id="srcLive" class="mono">—</b><b id="stFeed" style="display:none"></b></div>
      <div class="s click" id="stFreshWrap" title="Freshness contract — how old is the number you are looking at. Decisions are BLOCKED when this is red.">Data <b id="stFresh">—</b></div>
      <div class="s click" id="stClockWrap" title="Clock — every recurring job on one scheduler. Click for the jobs X-ray (name · interval · runs · errors).">Jobs <b id="stClock">—</b></div>
      <div class="s click" id="stSyncWrap" title="Durable state — journal, armed strategies, drawings and wallet DB are mirrored to SQLite. Click to force a sync.">Sync <b id="stSync">—</b></div>
    </div>

    <!-- ===== cluster 2: CONTEXT. Quiet. First thing dropped when it is tight. ===== -->
    <div class="st-grp quiet">
      <div class="s">Bars <b id="stBars">—</b></div>
      <div class="s">Regime <b id="stRegime">—</b></div>
      <div class="s">ATR <b id="stAtr">—</b></div>
      <div class="s" id="stCostWrap" title="What your numbers were costed with">Costs <b id="stCost">—</b></div>
    </div>

    <!-- ===== cluster 3: POSITION TRUTH. The one thing that can stop you. ===== -->
    <div class="st-grp push">
      <div class="st-risk" id="stGovWrap" onclick="window.govPanel&amp;&amp;window.govPanel()" title="Risk Governor — open risk, day P&amp;L, daily loss cap. Click for the whole book.">
        <span class="k">OPEN</span><span class="v na" id="stOpenR">—</span>
        <span class="k">DAY</span><span class="v na" id="stDayR">—</span>
        <span class="k">CAP</span><span id="stCapBar" title="Daily-loss headroom"><i></i></span>
        <b id="stGov" style="display:none">?</b>
      </div>
    </div>
  </div>'''
s = s[:i] + new_status + s[j:]
print('  ok  status: 9 flat chips -> 3 weighted clusters; "synthetic data" string removed')
assert 'synthetic data' not in s[s.index('<body'):], 'the false honesty string survived in the markup'  # (the CSS comment above documents it — that is fine)
for _id in ('srcPick', 'srcLive', 'stFeed', 'stBars', 'stRegime', 'stAtr', 'stCost', 'stCostWrap',
            'stGov', 'stGovWrap', 'stFresh', 'stFreshWrap', 'stClock', 'stClockWrap', 'stSync', 'stSyncWrap'):
    assert f'id="{_id}"' in s, f'status: LOST id {_id} — existing JS writes to it'
print('  ok  status: all 16 legacy ids preserved (nothing downstream breaks)')


# ------------------------------------------------------------------- STAGE 0
# THE STATE GRIDS, PATCHED IN PLACE — NOT REDEFINED.
# The shell went from 3 rows to 4 (top / tabbar / main / status). chart-max,
# focusmode and topmin each declare their own grid, and each was still writing
# THREE row heights. The temptation is to restate them in the v39 layer; that is
# exactly what test_v261_hardening.js forbids ("single definition of the focusmode
# rule"), and it is right to — the v25.2 layout scramble was caused by a second
# well-meant opinion on the same selector. So: edit the originals.
sub('.app.chart-max{grid-template-columns:0 1fr 0!important;grid-template-rows:0 1fr 0!important;'
    'grid-template-areas:"top top top" "main main main" "status status status"!important}',
    '.app.chart-max{grid-template-columns:0 1fr 0!important;grid-template-rows:0 0 1fr 0!important;'
    'grid-template-areas:"top top top" "tabbar tabbar tabbar" "main main main" "status status status"!important}',
    'grid: .app.chart-max -> 4 rows (the tabbar row was unplaced)')
sub('.app.topmin{grid-template-rows:0 1fr 30px}',
    '.app.topmin{grid-template-rows:0 var(--tabs-h) 1fr var(--status-h)!important}',
    'grid: .app.topmin -> 4 rows + tokens (was a hardcoded 30px status)')
sub('.app.focusmode{grid-template-columns:0 1fr 0!important;grid-template-rows:0 1fr 0!important}',
    '.app.focusmode{grid-template-columns:0 1fr 0!important;grid-template-rows:0 0 1fr 0!important}',
    'grid: .app.focusmode -> 4 rows')

io.open(HEAD, 'w', encoding='utf-8', newline='').write(s)
print('\n  00-head.html patched')
