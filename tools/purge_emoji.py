#!/usr/bin/env python3
"""
v39.0 — EMOJI PURGE (Stage 1)

Removes pictographic emoji from the SHELL markup (src/00-head.html body) and
from user-visible label strings in src/js/*.js.

WHY: 61 distinct emoji rendered as OS-dependent colour glyphs in the tab bar,
context menu, panel headers and theme picker. They cannot be recoloured by a
theme, they rasterise differently on every machine, and no professional trading
terminal ships them. Icon-only controls get a real SVG instead.

Geometric UI glyphs are KEPT (they are typography, not emoji):
  arrows -> ▾ ▸ ▷ → ↓ ↑ ↺ ⇄     rules -> ─ ├     marks -> ● ◐ · ✕ ⌘

Idempotent: running twice is a no-op.
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')

# The pictographic ranges. NOT the geometric-shape / arrow blocks.
PICTO = re.compile(
    '['
    '\U0001F000-\U0001FAFF'   # emoji planes
    '\u2600-\u27BF'           # misc symbols + dingbats  (★ ☀ ⚡ ⚖ ✨ ❄ ✕ ...)
    '\u2B00-\u2BFF'           # misc symbols & arrows    (⬆ ⬇)
    '\uFE0F'                  # variation selector-16
    ']'
)
# ...minus the handful of dingbats that are legitimate UI furniture.
# ★ is NOT an emoji. It is a monochrome text glyph, it inherits currentColor, it
# renders identically everywhere, and every trading platform on earth uses it for
# "favourite". It carries information here (curated theme, saved strategy, follow).
# Keeping it is the difference between a purge and a bulldozer.
KEEP = {'\u2715', '\u2713', '\u2717', '\u2605', '\u2606'}  # ✕ ✓ ✗ ★ ☆

# THE LESSON THAT COST A BUILD:
# a blanket delete does not distinguish DECORATION from INFORMATION. The first pass
# of this script turned  `trend 🟢 3, momentum 🔴 2`  into  `trend  3, momentum  2`
# and emptied nine icon-only buttons. An emoji in front of a text label is decoration.
# An emoji that IS the label, or that encodes a state, is load-bearing. Those get a
# geometric equivalent (themeable, monochrome, OS-stable) or an SVG — never nothing.
REMAP = {
    # --- state carriers: direction --------------------------------------
    '\U0001F7E2': '\u25B2',  # 🟢 -> ▲  (bullish)
    '\U0001F534': '\u25BC',  # 🔴 -> ▼  (bearish)
    '\u26AA':     '\u00b7',  # ⚪ -> ·  (flat)
    '\U0001F7E1': '\u25C6',  # 🟡 -> ◆  (caution)
    # --- state carriers: pass/fail --------------------------------------
    '\u2705':     '\u2713',  # ✅ -> ✓
    '\u274C':     '\u2717',  # ❌ -> ✗
    '\u26D4':     '\u2717',  # ⛔ -> ✗
    '\u26A0':     '!',       # ⚠  -> !
    # --- state carriers: misc -------------------------------------------
    '\u2B06':     '\u2191',  # ⬆ -> ↑
    '\u2B07':     '\u2193',  # ⬇ -> ↓
    '\U0001F512': 'LOCKED',  # 🔒 -> the word. It sits in a red span; say it.
    '\U0001F40B': '\u25C6',  # 🐋 -> ◆  (whale convergence)
    '\U0001FA99': '\u25CB',  # 🪙 -> ○  (token)
}


def strip(text):
    def sub(m):
        ch = m.group(0)
        if ch in KEEP:
            return ch
        return REMAP.get(ch, '')
    # NOTE: codepoint removal ONLY. An earlier version of this script also tried to
    # tidy the leftover whitespace and ate the space between HTML attributes
    # (class="tbtn" id="fsBtn" -> class="tbtn"id="fsBtn"). A leading space in a label
    # is invisible; a mangled attribute list is a bug. Do not "improve" this.
    return PICTO.sub(sub, text)


def main():
    files = [os.path.join(SRC, '00-head.html')]
    files += [os.path.join(SRC, 'js', f)
              for f in sorted(os.listdir(os.path.join(SRC, 'js'))) if f.endswith('.js')]

    total = 0
    for f in files:
        src = io.open(f, encoding='utf-8', newline='').read()
        head, sep, body = src.partition('<body>')      # only the body of the head file
        if sep:
            new = head + sep + strip(body)
        else:
            new = strip(src)
        n = len(PICTO.findall(src)) - len(PICTO.findall(new))
        if n:
            io.open(f, 'w', encoding='utf-8', newline='').write(new)
            print(f'  {os.path.relpath(f, ROOT):48s} -{n}')
            total += n
    print(f'\n  purged {total} emoji codepoints')
    return 0


if __name__ == '__main__':
    sys.exit(main())
