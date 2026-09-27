import pathlib

p = pathlib.Path(
    r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\docs\HANDOVER.md"
)
s = p.read_text(encoding="utf-8")
crlf = "\r\n" in s
s = s.replace("\r\n", "\n")

ENTRY = '''## v56.0 — THE RENOVATION: A FRONT DOOR, AND A MODEL LAYER UNDER THE SHELL

Asked for: "restructure the whole functions and design like renovation". Two
halves, both measured.

### HALF ONE — THE SCREEN HAD NO FRONT DOOR

Twenty-one desks behind five dropdown menus, and the terminal opened on a
chart of whatever instrument was last looked at. Every question the product
can answer WAS answerable; none of them was answered until you knew which of
the twenty-one rooms to walk into.

`ui/briefing.ts` is that room. Six cards, one question each, in the order a
trade asks them: where you stand, this chart, what changed, where else to
look, what fired, what kind of market this is. It is the default view on a
first run — and only on a first run, because `view` is persisted, so nobody
already using the terminal is moved.

IT STATES NO NEW FACTS, AND THAT IS THE WHOLE DESIGN. Every figure is read
from the module that owns it and carries a button back to the desk that owns
it: heat from `portfolioHeat` called with the Risk desk's own positions and
the one account; the verdict from the Setup card's own `SetupView`; the
cross-symbol reads from the scan the watch rail already drives; the events
from the live engine; the fires from the alert store's log. A dashboard that
recomputes a number "for convenience" and then disagrees with the desk it came
from is the equity defect again, and `core/account.ts` already records what
that costs. It also adds nothing up: six cards on six axes cannot be netted,
and a single "readiness" score is the opaque figure this repository forbids.

Every card refuses in the operator's words. VERIFIED LIVE in all of them: no
positions ("Nothing at risk. Every figure below is hypothetical."), no scan
("The opportunity scan has not run. Open the Opportunities desk..."), nothing
fired, and the regime model answering and not answering.

THREE DEFECTS THE BUILD FOUND AND TSC COULD NOT:
- Prices printed as raw floats — `80636.16031799658 – 80783.85966208541` in
  the entry row. Fixed by using the SAME `fmt` the chart legend uses; a second
  formatter would print a different number of decimals for one price on two
  surfaces of one screen.
- The verdict chip printed the detector id, `choch`. `nameForKind` exists for
  exactly this and was written down in v55.3; the desk went straight past it.
  An id is not a word, and knowing that is not the same as applying it.
- `.bf-event[data-sev="alert"]` and `[data-sev="notice"]` matched NOTHING.
  `LiveSeverity` is `info | watch | act`. A `data-*` attribute is a string and
  a selector that matches nothing is not an error anywhere, so the severity
  rail silently drew neutral on every event. Taken from the type, and toned
  the same way `livefeed.css` tones the same three words.

A FOURTH, caught by reading the refusal rather than the code: "the only read
is on the instrument already on screen" was printed whenever the map held one
entry — and the map ALWAYS holds the chart's own read. So a scan that had
never run reported that it had run and found nothing. `scanned` is now a
separate input, answered with the screener's own `lazyDesk().built` probe.

Nine tests on `standingRows`, the one part of the desk that is not
composition — which qualifications appear on the figure that could get
somebody hurt. MUTATION-TESTED: dropping the unprotected-position warning and
re-toning heat on an absolute instead of the operator's own per-trade risk
fails 3 of 9. Every expected value is a literal.

NOT TESTED, and stated rather than implied: the other five cards are
composition — they take another module's answer and put it on screen, and a
test of that asserts that `h()` appends children. They were verified in the
browser at 1600px (three columns), 1500px with the dock open (two), and 900px
(one), in the dev build and in the shipped bundle.

### HALF TWO — `mountShell` WAS ONE FUNCTION OF 6,837 LINES

MEASURED FIRST: 7,006 raw lines, 41% of them prose, and **230 declarations at
depth 1** inside one closure. That number is why every extraction since v50
was refused by this repository's own rule — more than ten siblings means the
coupling moved into a signature rather than out. It is a property of the
SHAPE: when state, derivation, DOM and effects share one closure, "sibling"
means "any of the other 229 locals". CLAUDE.md said "fix the coupling first";
this is that.

`ui/model/` is the layer that was missing. Three modules so far:

  structure.ts  215 lines, 5 siblings — detections, the operator's filters,
                the per-kind draw cap, the alert engine's separate set. Pure
                derivation: eight `computed`s, no DOM, no effects.
  analyst.ts    233 lines, 3 siblings — the provider stack, the fallback
                rules, the session, the brief store and its watcher.
  intel.ts       48 lines, 1 sibling — the regime read, the classifier, and
                the rule that a change of instrument invalidates both.

THE ANALYST IS THE INTERESTING ONE. Counted naively it borrows TWENTY-TWO
things, which the rule refuses outright. Twenty-one of them exist for one
reason: assembling `TerminalAccess`. That object is deliberately built once,
beside the signals it reads, because a second assembly would be a second
definition of what the analyst can see. So it STAYS in `mountShell` and
arrives as one dependency — and the section's real sibling count is three.
The refusal was never about the section; it was about where the boundary was
drawn. Its twelve outward values return as one named `analyst` rather than
twelve loose bindings, because twelve loose names in the shell is the shape
this file exists to undo.

MEASURED AFTER: **7,006 → 6,596 raw lines, mountShell 6,837 → 6,426,
declarations 230 → 199** — and that is NET of the Briefing's own wiring going
in. Not one line of behaviour changed and not one comment was rewritten; the
text was moved programmatically, which is what makes it reviewable as a move.

A MEASUREMENT I GOT WRONG AND CORRECTED: the first count of those
declarations was 185, read off a terminal that `head` had truncated. The
honest figure from the pre-change file is 230. A number taken from a cut-off
listing is a number nobody measured.

`verify.py --lint` PASS, 7 stages, 68s. 3,502 tests across 140 files.
`npm run build:all`: app/dist/index.html **1,387,548 bytes** (v55.3:
1,375,450; +12,098 for the desk).

NOT DONE: the live bar still repeats the symbol, the timeframe and the price
that the context bar states four times larger at the other end of the screen —
measured as a duplicate, left alone because `fitFields` ranks price FIRST to
survive a narrow window, and re-ranking it needs the drop order measured at
several widths rather than guessed. `ui/model/` covers three subsystems; the
dock (1,661 lines) and `main` (650) are still DOM built inline and are the
next two. No DOM test for the Briefing itself.

'''

i = s.index("## v55.3")
s = s[:i] + ENTRY + s[i:]
p.write_text(s, encoding="utf-8", newline="\r\n" if crlf else "\n")
print("handover written")
