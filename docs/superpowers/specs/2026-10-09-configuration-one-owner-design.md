# Configuration needs one owner

**Status:** design approved, ready to plan
**Date:** 2026-10-09
**Owner's words:** *"everything is scattered … the settings is not fully customisable scattered functions"*

---

## The problem, measured

| | |
|---|---|
| Settings dialog | **89 settings, 15 sections**, grouped — substantial and well built |
| Persisted preference slots in the app | **33** |
| Slots Settings reaches | a hand-written list passed at `ui/shell.ts:2369` |
| Slot-declaring files that live under `ui/` | **10 of ~20** |

There are two populations of configuration. One has a home. The other — the
risk governor's limits, the auto-search toggle, the disk budget, which
detectors are on, auto top-up — is changed *in situ* on whatever desk owns it
and persists in its own slot.

**Nothing in this product answers "what is this terminal configured to do?"**

That is not a gap in the settings screen. It is that configuration has no
single owner, and the majority of it is declared inside desk modules. Same
disease as the desk names one level up, and the fix has the same shape: the
list becomes derived instead of hand-written, and a guard fails when something
exists that the list does not know about.

**The sharpest single example:** `CONFIG_SLOT` lives in `ui/risk.ts` and holds
the risk governor's limits — daily loss limit, max trades, losses in a row. It
is as close to a setting as anything in this product, it is editable only on
the Risk desk, and Settings does not know it exists.

### What `Slot<T>` already gets right

`store/kv.ts` is not the problem and is not being replaced. Every record
carries its version and migrates forward; a reader meeting a NEWER shape
refuses rather than overwriting; corrupt values are quarantined rather than
deleted; quota is a returned result rather than a throw; changes are observable
across tabs. Slots are declared beside the data they own, which is right.

The defect is only that **nothing enumerates them**.

---

## The four kinds, and why the split is the design

The 33 are not one population. Conflating them is why "add the missing ones to
Settings" would be the wrong fix.

| kind | n | what it needs |
|---|---|---|
| **preference** — a choice that changes behaviour | 10 | a Settings control |
| **secret** — a credential | 1 | never rendered, never exported, clearable |
| **state** — data the product accumulated | 20 | see it, size it, export it, clear it — *not* a settings control |
| **legacy** — migration leftovers | 2 | check the path is dead, then delete |

Putting the alert book in Settings as a control would be a category error.
Twenty of the thirty-three are not settings at all; what is missing for them is
a **holdings view**, which today exists for bars only (the Data desk shows
series, disk and budget) and for nothing in the KV store.

### The full classification

**preference (10)** — `ACCOUNT_SLOT` (core/account), `APPEARANCE_SLOT`
(ui/appearance), `AUTO_SEARCH_SLOT` (ui/shell/prefs), `BUDGET_SLOT`
(data/library), `CONFIG_SLOT` (ui/risk), `ENABLED_SLOT` (learn/store),
`EXIT_SLOT` (ui/shell), `PREFS_SLOT` (ui/shell/prefs), `RULES_SLOT`
(ui/shell/prefs), `TOPUP_SLOT` (ui/data).
Of these, Settings reaches `ACCOUNT`, `APPEARANCE`, `RULES`, `EXIT` and part of
`PREFS`. **Five are unreachable**, including the governor's limits.

**secret (1)** — `AGENT_KEY_SLOT` (ui/model/analyst).

**state (20)** — `ALERT_BOOK`, `BOOK`, `BRIEFS`, `CATALOGUE`, `CLAIMS`, `DAY`,
`DISCOVERED`, `DRAWINGS`, `FLOW`, `FUNDAMENTALS`, `LAYOUT`, `RECENT`, `RUNS`,
`SAYS`, `SCRIPTS`, `STUDIES`, `SWEEP`, `TIMINGS`, `TODAY_PLAN`, `WATCH`.

**legacy (2)** — `LEGACY_CALC_SLOT`, `LEGACY_RISK_SLOT` (both core/account).

### A finding this surfaced, recorded rather than fixed here

`AGENT_KEY_SLOT` puts a credential in browser key-value storage. This product
already moved the Telegram token to the operator's own server for exactly this
reason — *a token in browser storage is a token in every backup of a profile
this product backs up*, and this terminal backs profiles up. The `secret` kind
contains the damage (never rendered, never exported, clearable) but does not
undo it. Moving it server-side is its own piece of work.

---

## The registry

`app/src/settings/registry.ts`. `settings/` already imports `ui/appearance`, so
it sits above the UI layer and may import a slot from anywhere without
inverting the layering rule.

```ts
export type SlotKind = "preference" | "secret" | "state" | "legacy";

export interface SlotEntry {
  readonly slot: Slot<unknown>;
  readonly kind: SlotKind;
  readonly label: string;
  /** One line, in the operator's words: what this is for. */
  readonly what: string;
  readonly section?: SectionId;     // preference only
  readonly control?: ControlShape;  // preference only
}

export const REGISTRY: readonly SlotEntry[] = [ /* one entry per slot, 33 today */ ];
```

`SectionId` is derived from the existing `SECTIONS` in `settings/defs.ts`
(`(typeof SECTIONS)[number]["id"]`), never restated — so a preference filed
under a section that does not exist is a compile error. `ControlShape` is the
smallest set the ten preferences actually need:

```ts
export type ControlShape =
  | { readonly kind: "toggle" }
  | { readonly kind: "number"; readonly min: number; readonly max: number; readonly step: number; readonly unit?: string }
  | { readonly kind: "choice"; readonly options: readonly { readonly id: string; readonly label: string }[] }
  | { readonly kind: "desk"; readonly opens: ViewId };
```

The fourth is the honest one. `ENABLED_SLOT` (which detectors are on) and
`RULES_SLOT` (the gate rules) are edited through surfaces that already exist
and are better than any generic control — a list of 29 detectors is not a
settings widget. For those the registry says *where the control lives* rather
than pretending to render it, so Settings still ACCOUNTS for every preference
without claiming to replace a desk that does the job properly.

**One central list, not `register()` calls spread through the modules.**
Distributed registration looks tidier and has a failure already on record here:
a module nobody imports never registers, and the result is a capability that
exists and cannot be seen. A central list can be checked against the source.

**`control` is declared, not inferred.** A widget cannot be derived from a
TypeScript type at runtime. It is metadata about presentation; the slot remains
the only owner of the value.

### The guard

Scans `app/src` for every `*_SLOT` declaration and fails when:

- a slot is not in the registry — **all 33 fail before the registry is
  written**, which is how it is proved to fail before anything is built, and
  one new slot fails it ever after;
- a registry entry names a slot that no longer exists (a stale entry weakens
  the guard silently and for ever);
- an entry of kind `preference` has no `section` or no `control`;
- it parsed zero files or zero slots — an audit whose pattern has stopped
  matching reports a clean tree, which this repository has shipped four times.

---

## The two surfaces

**Settings renders every `preference` by construction** — it iterates the
registry rather than a list passed by hand, so it cannot fall behind again. The
five currently unreachable appear, the governor's limits among them.

**A holdings view for `state`**, on the System desk. Per slot: label, what it
holds, **size in bytes**, export to JSON, and clear. `secret` appears with its
label and a clear button and never its value. `preference` does not appear
here; it has a home already.

**Clearing never silently does less than it says.** The confirmation names
every slot it will empty, by label. A bulk action that honours fewer guards
than its single-row version is the defect this repository records from bulk
deletes, and "I cleared it and something else went too" is unrecoverable.

**`legacy` is deleted** once a test shows the migration path it served is dead.

---

## Verification

1. The guard is written first and **proved to fail** on today's ~15
   unregistered slots.
2. Sizing and the clear plan are **pure functions** over an inventory, so they
   are tested as arithmetic rather than through a DOM — the same reason
   `svc/store.py`'s eviction order is pure.
3. A test asserts every `preference` in the registry produces a control in the
   built settings, so a registered-but-invisible preference fails.
4. A test asserts no `secret` value is reachable from the holdings view's
   export.
5. `python verify.py` green, output pasted.
6. Opened on the python build at `:8787` — never the dev server.

---

## Out of scope

- **Moving the 10 `ui/`-declared slots into their domain modules.** It is the
  right shape — a persisted preference is not a UI concern — but it changes
  declaration sites, and a changed KEY loses the operator's data. Worth doing
  after, with the key pinned by a test.
- **Moving `AGENT_KEY_SLOT` server-side.** Recorded above; its own work.
- **Stage 2, the three modes** (Trade / Research / System), designed to
  approach A and awaiting its own spec. This lands first deliberately: the
  modes need to remember per-mode state, and that should be a registered
  preference rather than the thirty-fourth loose slot.
