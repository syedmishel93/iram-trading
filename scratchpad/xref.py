"""Cross-reference audit: every pair of lists that names the same fact.

The taxonomy defect (0 of 24 desks filed the same way by two lists) was found
by comparing two lists nothing had ever compared. Same method, everywhere else.

EVERY CHECK PRINTS WHAT IT MEASURED. A check that passes because it parsed
nothing is the "0 of 0 running" defect, and the first version of this script
had two of them: the icon regex expected `name: (` and icons are `name: [`,
so it reported 21 false positives, and the keymap regex parsed zero bindings
and reported "ok".
"""
import io
import os
import re

APP = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src"
fails = 0


def read(*parts):
    return io.open(os.path.join(APP, *parts), encoding="utf-8").read()


def report(name, left_n, missing, note=""):
    """`left_n` is what the check actually parsed — zero means it did not run."""
    global fails
    if left_n == 0:
        state = "!!! PARSED NOTHING — check is vacuous"
    elif missing:
        state = "*** DISAGREES ***"
    else:
        state = "ok"
    if left_n == 0 or missing:
        fails += 1
    print("\n%-42s %6d  %s" % (name, left_n, state))
    if note:
        print("     " + note)
    for m in missing:
        print("     - %s" % m)


views = read("ui", "shell", "views.ts")
VIEWS = re.findall(
    r'\{\s*id:\s*"([^"]+)",\s*group:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*icon:\s*"([^"]+)"', views
)
ids = {i for i, _g, _l, _ic in VIEWS}
print("VIEWS: %d desks" % len(VIEWS))

# 1. Every icon a desk names must exist, or the tab draws nothing.
icons = read("ui", "icons.ts")
known = set(re.findall(r'^\s*([a-zA-Z0-9_]+):\s*\[', icons, re.M))
used = {ic for _i, _g, _l, ic in VIEWS}
report("VIEWS.icon -> icons.ts", len(used), sorted(used - known),
       "registry holds %d icons" % len(known))

# 2. Every inspector card the tools menu opens must exist.
panels = set(re.findall(r'\{\s*id:\s*"([^"]+)"', read("ui", "dockpanels.ts")))
cards = set(re.findall(r'card:\s*"([^"]+)"', read("ui", "shell", "toolsmenu.ts")))
report("toolsmenu cards -> DOCK_PANELS", len(cards), sorted(cards - panels),
       "dock declares %d panels" % len(panels))

# 3. Every key bound must name a command that is registered.
cmds = read("ui", "commandset.ts")
registered = set(re.findall(r'id:\s*[`"]([a-z][a-zA-Z0-9.${}_-]*)[`"]', cmds))
# Template ids (`market.tf.${tf}`) register a family; compare on the stem.
stems = {r.split("${")[0].rstrip(".") for r in registered}
bound = set(re.findall(r'bind\(\s*"[^"]*"\s*,\s*"([^"]+)"', cmds))
ghosts = sorted(b for b in bound if b not in registered and b.rsplit(".", 1)[0] not in stems)
report("bind(...) -> registered command", len(bound), ghosts,
       "%d commands registered; a key on a missing command silently does nothing" % len(registered))

# 4. Every go-to shortcut must name a desk that exists.
gotos = re.findall(r'\["([a-z] [a-z])",\s*"view\.([a-z]+)"\]', cmds)
report("go-to shortcuts -> VIEWS", len(gotos),
       sorted("%s -> %s" % (k, v) for k, v in gotos if v not in ids))

# 5. Every desk must be reachable from the switch that renders desks.
shell = read("ui", "shell.ts")
rendered = set(re.findall(r'view === "([^"]+)"', shell))
report("VIEWS -> shell.ts render switch", len(ids), sorted(ids - rendered),
       "'chart' is the fallback branch, so it is expected here")

# 6. Every desk the palette lists must exist (it is derived; prove it still is).
derived = re.search(r"viewList:\s*VIEWS\.map", shell) is not None
report("palette viewList -> VIEWS", 1 if derived else 0,
       [] if derived else ["viewList is no longer derived from VIEWS"])

print("\n%d of 6 pairings need attention" % fails)
