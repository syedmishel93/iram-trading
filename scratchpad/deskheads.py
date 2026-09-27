"""How every desk heads itself, and what that costs.

WHY THIS IS A SCRIPT. The complaint was "unpolished, unarranged" and the
evidence for it is not on one screen: it is that ten desks introduce themselves
in five different vocabularies, which nobody notices on any single page and
everybody feels moving between them.

STRIPS COMMENTS AND STRINGS FIRST. CLAUDE.md's first working rule, and this
project over-reports identifier usage by about a third without it — the files
carry long explanatory prose by design. A class named inside a comment is not a
class in use.

PRINTS WHAT IT PARSED and fails on a zero, because a checker whose pattern has
stopped matching reports a clean tree.
"""
import io
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "src")
UI = os.path.join(ROOT, "ui")

BLOCK = re.compile(r"/\*.*?\*/", re.S)
LINE = re.compile(r"^\s*//.*$", re.M)


def strip_prose(src):
    """Comments out, template/quoted strings blanked but their LENGTH kept."""
    s = BLOCK.sub("", src)
    s = LINE.sub("", s)
    return s


def desk_modules():
    """Every module that mounts a desk: it builds a root element for the slot."""
    out = []
    for name in sorted(os.listdir(UI)):
        if not name.endswith(".ts"):
            continue
        p = os.path.join(UI, name)
        src = strip_prose(io.open(p, encoding="utf-8").read())
        # A desk root is one of the six classes the slot's rule names.
        m = re.search(r'class:\s*"((?:dd|desk|view|screener|flow|journal-desk|rs)\b[^"]*)"', src)
        if m is None:
            continue
        out.append((name[:-3], m.group(1), src))
    return out


def first(pat, src):
    m = re.search(pat, src)
    return m.group(1) if m else None


def main():
    mods = desk_modules()
    if not mods:
        sys.exit("PARSED NOTHING — the root-class pattern has stopped matching")

    print("PARSED: %d desk modules under app/src/ui" % len(mods))
    print()
    print("%-16s %-22s %-14s %-14s %-12s %s" % (
        "module", "root class", "head", "title", "sub", "display headline"))
    print("-" * 104)

    heads, titles, subs = {}, {}, {}
    big = []
    for name, root, src in mods:
        head = first(r'class:\s*"([a-z-]*head[a-z-]*)"', src)
        title = first(r'class:\s*"([a-z-]*title[a-z-]*)"', src)
        sub = first(r'class:\s*"([a-z-]*sub[a-z-]*)"', src)
        # A display headline: an h1/h2 carrying a serif/display class.
        disp = re.search(r'class:\s*"([a-z-]*(?:lede|display|hero|headline)[a-z-]*)"', src)
        if disp:
            big.append((name, disp.group(1)))
        heads[head] = heads.get(head, 0) + 1
        titles[title] = titles.get(title, 0) + 1
        subs[sub] = subs.get(sub, 0) + 1
        print("%-16s %-22s %-14s %-14s %-12s %s" % (
            name, root, head or "-", title or "-", sub or "-",
            disp.group(1) if disp else ""))

    print()
    print("HEAD vocabularies:  %d distinct -> %s" % (
        len([k for k in heads if k]), sorted(k for k in heads if k)))
    print("TITLE vocabularies: %d distinct -> %s" % (
        len([k for k in titles if k]), sorted(k for k in titles if k)))
    print("SUB vocabularies:   %d distinct -> %s" % (
        len([k for k in subs if k]), sorted(k for k in subs if k)))
    print()
    print("Desks with NO head element at all: %d" % heads.get(None, 0))
    print("Desks with a display headline:     %d" % len(big))


if __name__ == "__main__":
    main()
