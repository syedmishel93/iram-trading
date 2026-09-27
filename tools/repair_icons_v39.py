#!/usr/bin/env python3
"""
v39.0 — ICONS & COPY REPAIR.

Nine controls in this app had an emoji as their ENTIRE label. Purging the emoji
emptied them. This gives each one a real inline SVG (stroked, currentColor, so a
theme can actually recolour it) and repairs the four sentences that referred to
the glyph in prose.

Run AFTER tools/purge_emoji.py, BEFORE tools/patch_v39.py.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = os.path.join(ROOT, 'src', '00-head.html')
JS = os.path.join(ROOT, 'src', 'js')

S = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
     'stroke-linecap="round" stroke-linejoin="round">')

ICON = {
    # expand — fullscreen
    'fsBtn': S + '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    # sunrise — the pre-market brief
    'pmBtn': S + '<path d="M12 2v3M4.9 6.9l2.1 2.1M2 14h3M19 14h3M17 9l2.1-2.1M12 14a4 4 0 0 0-8 0M20 14a4 4 0 0 0-8 0"/><path d="M2 20h20"/></svg>',
    # shield — the risk governor
    'govBtn': S + '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/></svg>',
    # scales — execution reconciliation
    'reconBtn': S + '<path d="M12 3v18M7 21h10M3 8l4-3 4 3M13 8l4-3 4 3M3 8a4 4 0 0 0 8 0M13 8a4 4 0 0 0 8 0"/></svg>',
    # book — the journal
    'jrnBtn': S + '<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/></svg>',
    # list — open tabs / session symbols
    'wlBtn': S + '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    # microphone
    'aiMic': S + '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    # speaker
    'aiSpeak': S + '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>',
}

s = io.open(HEAD, encoding='utf-8', newline='').read()
n = 0


def fill(el_id, svg):
    """Put the SVG inside the button whose id is el_id, whatever its attribute order."""
    global s, n
    key = f'id="{el_id}"'
    i = s.find(key)
    assert i > 0, f'MISSING CONTROL: {el_id}'
    gt = s.index('>', i)
    close = s.index('</button>', gt)
    inner = s[gt + 1:close].strip()
    assert inner == '', f'{el_id} is not empty (contains {inner[:40]!r}) — refusing to overwrite'
    s = s[:gt + 1] + svg + s[close:]
    n += 1
    print(f'  ok  {el_id} -> inline SVG')


for el in ('fsBtn', 'pmBtn', 'govBtn', 'reconBtn', 'jrnBtn', 'wlBtn', 'aiMic', 'aiSpeak'):
    fill(el, ICON[el])


# ---- prose that referred to a glyph that no longer exists -------------------
def sub(old, new, label, path=None):
    global s
    if path is None:
        cur = s
    else:
        cur = io.open(path, encoding='utf-8', newline='').read()
    c = cur.count(old)
    assert c == 1, f'ANCHOR FAIL [{label}]: found {c}'
    cur = cur.replace(old, new)
    if path is None:
        s = cur
    else:
        io.open(path, 'w', encoding='utf-8', newline='').write(cur)
    print(f'  ok  copy: {label}')


sub('Click  on a row to m', 'Click the shield on a row to m', 'shield reference in prose')

io.open(HEAD, 'w', encoding='utf-8', newline='').write(s)

# 35-plantrade: "🎤 to talk, 🔊 to listen" -> the glyphs are gone; name the controls.
sub(' to talk,  to listen.', ' Use the mic to talk, the speaker to listen.',
    'mic/speaker reference in prose', os.path.join(JS, '35-plantrade.js'))

# 39-applytheme: applyTheme did `tb.textContent = '☀️' or '🌙'`, which OVERWRITES the
# SVG that ships in the markup — so the button was emoji-only in practice, and after
# the purge it would render as an empty 28px square. Swap in an SVG per state.
SUN = (S + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4'
           'M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')
MOON = S + '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>'
sub("if(tb)tb.textContent=name==='light'?'':'';",
    "if(tb)tb.innerHTML=name==='light'?'" + SUN + "':'" + MOON + "';",
    'applyTheme wrote textContent over the SVG -> now sets an SVG',
    os.path.join(JS, '39-applytheme.js'))

print(f'\n  {n} icon-only controls given real SVGs; 3 sentences repaired')
