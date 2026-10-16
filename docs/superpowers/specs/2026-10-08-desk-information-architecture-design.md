# Desk information architecture — making 27 capabilities usable

**Status:** design approved, stage 1 ready to plan
**Date:** 2026-10-08
**Owner's words:** *"i cant see any use of the app"*

---

## The problem, measured

The terminal has 27 desks, ~96 backend routes and no uncalled capability. Every
feature works. The owner cannot get value from it.

Three measurements say why.

**1. Twenty-seven top-level destinations, all equal weight.**

| | top-level destinations | starter layouts | "start here" |
|---|---|---|---|
| thinkorswim | 8 tabs | 6, by *who you are*: Default, Futures, Active Trader, Long Term, Forex, Options | yes |
| NinjaTrader | modular windows | saved workspaces you toggle between | yes |
| Bloomberg | ~30,000 functions, *"grouped by workflow and discoverable through a hierarchy of menus"* + a command line that doubles as search | Launchpad | yes |
| **IRAM** | **27 desks** | **pane counts only (1/2/4)** | **no** |

Bloomberg proves feature count is not the problem: a thousand times more
functions, navigable, because functions are grouped by **workflow** and the
command line is a **search** — *"entering a keyword gives a list of related
functions… without memorising codes"*. IRAM owns both mechanisms and has no
spine behind either.

**2. The names are not the words a trader types.** The command palette can only
find what you can name. Measured against the desk list: roughly **7 of 27**
labels are words a trader would search for. "Opportunities", "Decision",
"Conditions", "Connections", "Knowledge", "Survey", "Simulation" and "Learning"
are internal concepts.

**3. Neither of the owner's two workflows exists as a path.** They do both
scalping and research.

- Scalping needs Chart → what is firing → can I trade now → size → log it.
  Those desks sit in **three different groups**.
- Research needs ask → test → verdict → did it hold. **Eight desks across two
  groups.**

### What is NOT the problem

The visual style. The terminal is already dark, dense, correctly typeset, with
seven themes and a documented type and colour system. Restyling would not change
the owner's complaint. The conventions worth taking from the research are
behavioural — progressive disclosure, standardised colour semantics — and both
are already house rules here, applied unevenly.

Also absent and correctly so: DOM, Time & Sales, order book. There is no
execution path (`order_send` appears nowhere in `server/`), so a ladder would be
theatre. Recorded here so nobody "fixes" it later.

---

## Decision: approach A, shipped in two stages

Top level stops being 27 desks and becomes **two modes**, each with an ordered
spine of 5–7 desks and its own remembered layout. Everything outside a spine
stays reachable through the command palette and All tools — Bloomberg's split,
where the menu hierarchy is the browse path and the command line is the search
path.

| mode | spine |
|---|---|
| **Trade** | Chart → what is firing → can I trade now → size it → log it |
| **Research** | ask a question → test it → verdict → did it hold out of sample |

**Stage 1 — the names.** Shippable alone, felt immediately.
**Stage 2 — the modes.** Needs its own design pass before implementation.

Rejected: *chart-first with everything in drawers* (the TradingView model). It
suits scalping and cripples research — you cannot run a walk-forward study in a
drawer, and the owner does both.

---

## Stage 1 — the names

### The rule

**A desk is named the word you would type to find it.** Not what it is
internally, not what it is selling.

### The renames

| id | now | becomes |
|---|---|---|
| `screener` | Opportunities | **Scanner** |
| `decision` | Decision | **Confluence** |
| `flow` | Flow | **Derivatives** |
| `agent` | Analyst | **Ask AI** |
| `study` | Analyse | **Research** |
| `knowledge` | Knowledge | **Edge stats** |
| `survey` | Conditions | **Market regime** |
| `connections` | Connections | **Correlation** |
| `strategy` | Strategy | **Strategy tester** |
| `signals` | Signals | **Alerts** |
| `results` | Results | **Test results** |
| `simulation` | Simulation | **Walk-forward** |
| `learn` | Learning | **Track record** |
| `workspace` | Workspace | **Layouts** |
| `paper` | Paper | **Paper trading** |

Unchanged, already searchable: Briefing, Watchlist, Chart, Smart money,
Sessions, Risk, Calculator, Quant, Playbook, Data, Journal, System.

**15 renames, 12 kept. 7 of 27 searchable becomes 27 of 27.**

Two were chosen against alternatives and the reasoning is recorded so a later
pass does not undo them: `strategy` takes MetaTrader's own phrase **Strategy
tester**, because the owner already knows that term from the platform they
trade on; `signals` becomes **Alerts** because the desk IS the alert list, and
"Signals" collided with the strategy-signal concept in `sig_loop`.

### The structural half: one owner for a desk's name

A desk's name is currently written in up to three places. `VIEWS` holds it;
nine desks render it again as a literal into `.view-title`; and other desks
name it a third time when they link to it. Renaming `VIEWS` alone leaves
twenty files pointing at the old name.

**`VIEWS` becomes the single owner.** Add to `ui/shell/views.ts`:

```ts
/** Every desk id, as a literal union. `VIEWS` is already `as const`. */
export type ViewId = (typeof VIEWS)[number]["id"];

/** A desk's display name. An unknown id is a COMPILE error, not a throw. */
export function deskLabel(id: ViewId): string
```

**The id is typed, and that is the whole safety argument.** A `deskLabel(id:
string)` that threw on an unknown id would throw inside a render effect —
which `core/signal.ts` catches and logs to `window.__signalErrors`, leaving the
section blank with nothing on screen to say why. This repository already
records that exact failure costing a whole list. A literal union moves the
error to `tsc`, where it cannot be swallowed.

Measured: **29 literal label references across 20 files**, in three kinds.

| kind | example | change |
|---|---|---|
| **self-title** — a desk renders its own name | `ui/flow.ts` → `h("h2", { class: "flow-title", text: "Flow" })` | `text: deskLabel("flow")` |
| **cross-reference** — a desk links to another, and already carries the id | `ui/briefing.ts` → `ownerLink("Opportunities", () => onOpen("screener"))` | `ownerLink(deskLabel("screener"), …)` |
| **false positive** — the same word, a different thing | `settings/presets.ts` "Analyst" is a DENSITY PRESET; `study/methods.ts` "Strategy" is a method category | **leave alone**, listed in the guard's allowlist with the reason |

The third kind is why this is not a find-and-replace. A blind sweep renames a
settings preset and a study method, and nothing fails.

### What must not change

- **Desk ids.** They are persisted — the active desk and saved layouts store the
  id string. An id change silently drops the owner onto a fallback desk with
  nothing on screen to say why.
- **Groups.** The two modes ARE the regrouping. Changing groups now is work
  stage 2 undoes.
- **`.view-title` and its siblings.** `desktitle.test.ts` pins which FACE each
  kind of title uses (a desk's NAME in the body face, a sentence a desk says on
  its own account in `--font-serif`). That system survives a rename of the text
  and must not be disturbed by it.

### Verification

1. **A failing test first.** A new guard asserts no desk module contains its own
   label as a string literal, with the false-positive allowlist carrying a
   reason per entry. It must be proved to fail against the current tree before
   the fix lands — an audit that parses nothing reports success.
2. `toolsmenu.ts` is already a projection of `VIEWS`, and its guard test holds.
3. Existing `deskgroups.test.ts` guards survive: unique ids, unique labels,
   every desk has a hint, 3–7 groups, no group over a third, none of one.
4. The 12 literal label assertions in `app/test/` are updated as part of the
   change, not around it.
5. `python verify.py` green, output pasted.
6. Opened in the browser on the python build at :8787 — not the dev server —
   and every renamed desk checked for its new title and its cross-references.

---

## Stage 2 — the two modes

**Not specified here.** It needs its own design pass. What is decided:

- Two modes, Trade and Research, each with an ordered spine of 5–7 desks.
- Each mode remembers its own layout; switching is one control.
- Desks outside a spine remain reachable via the command palette and All tools.
- The groups are reorganised here, not in stage 1.

Open questions for that pass: whether a mode is a filter over the existing desk
bar or a genuine workspace; what the default layout of each mode is; whether
the Briefing becomes the Trade mode's home; how a mode interacts with the
existing 1/2/4 pane presets.

One thing stage 2 must not miss: **`WORKSPACE_LEAD` is keyed by GROUP name**
("Today: AI briefs · you plan", "Trade: you decide"). Regrouping without moving
it leaves every tab's lead line pointing at a group that no longer exists, and
nothing fails — the lookup just returns undefined and the line goes blank.

---

## Out of scope

- Restyling. Argued above.
- DOM / Time & Sales / order book. No execution path.
- The always-on signal-loop data-source work (`svc/quotes.py`), designed to
  section 1 of 4 in the same session and **parked, not abandoned**. It is
  independent of this and can resume at any time.

---

## Sources

- [thinkorswim Workspaces](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Getting-Started/Workspaces)
- [NinjaTrader — building a workspace](https://ninjatrader.com/futures/blogs/how-to-build-a-workspace-in-the-ninjatrader-desktop-platform/)
- [Bloomberg function structure](https://lerner.udel.edu/seeing-opportunity/bloomberg-functions-list)
- [Devexperts — rethinking UX/UI for trading platforms](https://devexperts.com/blog/ux-ui-design-for-online-trading-platforms/)
