"""SWEEP THE WHOLE TREE FOR EVERY DEFECT CLASS THIS SESSION FOUND.

The work so far has been discovery-driven: pull a thread, find something, fix it,
pull the next. That finds real defects and never finishes, because "are there
more like this?" is unbounded by inspection.

This bounds it. Each class found this session has a mechanical signature, so it
can be asked of EVERY file at once instead of of whichever file I happened to
open. The answer is then a number rather than a feeling.

CLASSES SWEPT

  1. CREDENTIAL EGRESS. Any module that sends a body off the machine must filter
     through `syncable`/`looksSecret`. `store/sync.ts` records the defect: the
     analyst's API key reached a remote endpoint because "is this a credential?"
     had two answers, and `settingsbackup.ts` nearly became a third.

  2. LIVE DEFAULTS. A parameter defaulting to something that performs network
     I/O can be reached by a test that does not know it exists. Under vitest the
     global `fetch` resolves against the running gateway; a scheduling test
     POSTed fixtures over the operator's real backup exactly this way.

  3. UNCEILINGED DEBOUNCE. A timer cancelled and rescheduled on every event,
     with no ceiling, never fires while the events keep coming.

  4. COUNTS TAKEN FROM THE INPUT. `return len(rows)` after a write reports what
     was ASKED for, not what landed — a figure that cannot disagree with itself.

  5. HAND-ROLLED REACTIVE LISTS. A function child building a DocumentFragment
     loses the WHOLE list if one item's render throws, silently, because the
     fragment is appended once at the end. `each` exists for this.

PRINTS WHAT IT PARSED, AND A ZERO IN THE PARSE COLUMN IS A FAILURE. A sweep that
matches nothing and reports "clean" is the defect it is looking for.
"""

import io
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP = os.path.join(ROOT, "app", "src")
SERVER = os.path.join(ROOT, "server")

SKIP_DIRS = {"node_modules", "dist", "build", "venv", "__pycache__", ".git", "scratchpad"}

_STR_TS = re.compile(r'"(?:[^"\\]|\\.)*"' r"|'(?:[^'\\]|\\.)*'" r"|`(?:[^`\\]|\\.)*`")
_LINE_COMMENT = re.compile(r"//.*?$", re.M)
_BLOCK_COMMENT = re.compile(r"/\*[\s\S]*?\*/")


def _blank(m):
    """Replace a match with the SAME NUMBER OF NEWLINES.

    Deleting a block comment outright shifts every line number after it, and
    this file reports line numbers. CLAUDE.md records `tdz.py` doing exactly
    that and being "wrong by hundreds" — a finding at the wrong line is a
    finding nobody can check.
    """
    return chr(10) * m.group(0).count(chr(10))


def ts_code(src):
    """Comments and string literals are not code. CLAUDE.md rule 2."""
    src = _BLOCK_COMMENT.sub(_blank, src)
    src = _LINE_COMMENT.sub("", src)
    return _STR_TS.sub('""', src)


def walk(root, ext):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if f.endswith(ext):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


# REVIEWED AND CORRECT AS WRITTEN. Each entry carries the reason, because an
# allowlist without one becomes a way to silence the tool.
REVIEWED = {
    ("debounce-no-ceiling", "app/src/core/keys.ts"):
        "a keyboard SEQUENCE timeout. Resetting on each chord is the whole point of "
        "multi-key bindings; a ceiling would cut chords off mid-sequence.",
    ("debounce-no-ceiling", "app/src/ui/cards/whalecard.ts"):
        "a self-perpetuating POLL loop, not an event-driven debounce. It reschedules "
        "from its own completion, so it always fires after the interval.",
    ("hand-rolled-list", "app/src/ui/agent.ts"):
        "renderRich() is a pure text-to-fragment builder, not a reactive child. "
        "Nothing re-runs it, so there is no list to lose.",
    ("hand-rolled-list", "app/src/ui/screener.ts"):
        "still a fragment, but it now BUILDS BEFORE CLEARING (v62.22), so a row "
        "that throws leaves the previous table standing instead of an empty one. "
        "Stale beats empty when the alternative is silent.",
    ("hand-rolled-list", "app/src/ui/playbook.ts"):
        "<option> elements inside a <select>/<optgroup>, whose render is a value and "
        "a text and cannot throw on data. Left as-is deliberately; the file says why.",
}

findings = []
parsed = {}


def add(cls, path, line, text):
    if (cls, rel(path)) in REVIEWED:
        return
    findings.append((cls, rel(path), line, text.strip()[:96]))


# --------------------------------------------------------------- 1 + 2 + 3 --
ts_files = walk(APP, ".ts")
parsed["ts files"] = len(ts_files)

SENDS = re.compile(r"method:\s*\"?(POST|PUT|PATCH)", re.I)
BODY_FROM_KV = re.compile(r"\bkv\.(keys|rawEnvelope|stats)\b")
GUARD = re.compile(r"\b(syncable|looksSecret|SECRET_PATTERN)\b")

# A default that performs I/O: `= fetchX`, `= pushX`, `= loadX`, `= sendX` in a
# parameter list. Narrow on purpose -- a broad match here is noise.
LIVE_DEFAULT = re.compile(r"^\s*\w+\s*[:=][^,)=]*=\s*(fetch|push|send|load|post)[A-Z]\w*\s*,?\s*$")

DEBOUNCE = re.compile(r"\bclearTimeout\s*\(|\bcancel\s*\(")
SCHEDULE = re.compile(r"\bsetTimeout\s*\(|\bschedule\s*\(")

sends_count = 0
for p in ts_files:
    raw = io.open(p, encoding="utf-8").read()
    code = ts_code(raw)
    lines = code.splitlines()

    # 1. credential egress
    #
    # MATCHED ON THE RAW SOURCE, not the stripped code. An HTTP method IS a
    # string literal, so `ts_code` deleted the very token being looked for and
    # the first run reported "0 modules POST or PUT" on a tree that plainly
    # does. A zero in the parse column is a failure, and this one was mine.
    if SENDS.search(raw) and BODY_FROM_KV.search(code):
        sends_count += 1
        if not GUARD.search(raw):
            add("credential-egress", p, 1,
                "sends a body built from kv.* and never mentions syncable/looksSecret")

    # 2. live defaults
    for i, ln in enumerate(lines, 1):
        if LIVE_DEFAULT.match(ln):
            add("live-default", p, i, ln)

    # 3. unceilinged debounce: cancels AND reschedules in the same function,
    #    with no second never-cancelled timer.
    if DEBOUNCE.search(code) and SCHEDULE.search(code):
        if "ceiling" not in raw.lower() and "maxWait" not in raw and "MAX_WAIT" not in raw:
            # only flag when a cancel is immediately followed by a schedule
            for i, ln in enumerate(lines, 1):
                if DEBOUNCE.search(ln) and i < len(lines) and SCHEDULE.search(lines[i]):
                    add("debounce-no-ceiling", p, i, ln)
                    break

parsed["ts modules that POST/PUT"] = sends_count

# ------------------------------------------------------------------- 4 ------
py_files = walk(SERVER, ".py")
parsed["python files"] = len(py_files)

# `return len(x)` inside a function whose body also executes a write.
WRITE = re.compile(r"\b(execute|executemany|commit)\s*\(")
RET_LEN = re.compile(r"^\s*return\s+len\s*\(")

for p in py_files:
    lines = io.open(p, encoding="utf-8").read().splitlines()
    for i, ln in enumerate(lines, 1):
        if not RET_LEN.match(ln):
            continue
        # look back up to 25 lines for a write in the same function
        back = "\n".join(lines[max(0, i - 26):i])
        if WRITE.search(back) and "def " in back:
            add("count-from-input", p, i, ln)

# ------------------------------------------------------------------- 5 ------
FRAG = re.compile(r"createDocumentFragment\s*\(")
for p in ts_files:
    raw = io.open(p, encoding="utf-8").read()
    code = ts_code(raw)
    if not FRAG.search(code):
        continue
    # `each` is the sanctioned renderer; dom.ts itself is allowed to build one.
    if rel(p).endswith("ui/dom.ts"):
        continue
    for i, ln in enumerate(code.splitlines(), 1):
        if FRAG.search(ln):
            add("hand-rolled-list", p, i, ln)

# ------------------------------------------------------------------ report --
print("PARSED:")
for k, v in parsed.items():
    print("  %-28s %d" % (k, v))
zeros = [k for k, v in parsed.items() if v == 0]
if zeros:
    print("FAIL: parsed ZERO of: %s - the pattern is wrong, not the tree" % ", ".join(zeros))
    sys.exit(2)

print()
by_class = {}
for cls, path, line, text in findings:
    by_class.setdefault(cls, []).append((path, line, text))

CLASSES = ["credential-egress", "live-default", "debounce-no-ceiling",
           "count-from-input", "hand-rolled-list"]
for cls in CLASSES:
    hits = by_class.get(cls, [])
    print("%-22s %d" % (cls, len(hits)))
    for path, line, text in hits:
        print("    %s:%d  %s" % (path, line, text))

print()
print("REVIEWED AND ALLOWED (%d):" % len(REVIEWED))
for (cls, path), why in sorted(REVIEWED.items()):
    print("  %-22s %s" % (cls, path))
    print("      %s" % why)

print()
print("TOTAL UNRESOLVED: %d" % len(findings))
sys.exit(1 if findings else 0)
