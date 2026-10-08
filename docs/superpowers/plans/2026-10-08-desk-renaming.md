# Desk Renaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename 15 desks to the words a trader would type, and make `VIEWS` the single owner of every desk's display name.

**Architecture:** `app/src/ui/shell/views.ts` already holds `VIEWS` as a `const` array, so `(typeof VIEWS)[number]["id"]` is a literal union of all 27 ids. A new `deskLabel(id: ViewId)` reads the label from there. Fifteen desk modules currently render their own name as a string literal and four other sites name a desk they link to; all become `deskLabel(...)` calls. A guard test then forbids any desk label appearing as a literal outside `views.ts`. The rename itself lands last, as one line per desk, once every reader is pointed at the owner.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`), Vitest, hand-written signals (`core/signal.ts`), canvas chart. Gate: `python verify.py`.

**Spec:** `docs/superpowers/specs/2026-10-08-desk-information-architecture-design.md`

## Global Constraints

- **Desk ids NEVER change.** They are persisted (active desk, saved layouts). An id change silently drops the owner onto a fallback desk.
- **Groups NEVER change in this stage.** Stage 2's two modes are the regrouping.
- **`tsc --noEmit` passes at all times.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`.
- **A bug fix starts with the failing test.** Prove the guard fails against the current tree before any fix lands.
- **An audit that parses nothing reports success.** Every audit prints what it parsed and fails on a zero.
- **Never hand-write a type a dependency can provide.** Derive from `typeof VIEWS`.
- **No exe builds.** Browser build via `python run.py` only.
- **Show real gate output.** "Tests pass" without the output does not count.

## Review Focus

1. **A new label that is a substring of another** — after `results` → "Test results", a guard matching the bare word "Results" also matches inside "Test results". Pinned in Task 2.
2. **A desk label equal to a group name** — `study` → "Research" collides with the existing group "Research", so the menu would read *Research › Research*. Pinned in Task 4.
3. **A label containing regex-special characters** — the guard builds patterns from labels; a label with `(`, `.` or `|` would match far too much or throw. Pinned in Task 2.
4. **A stale allowlist entry** — a false-positive exemption that no longer matches anything silently weakens the guard forever. Pinned in Task 2.
5. **`deskLabel` called for a desk whose module was deleted** — the id still type-checks because `VIEWS` still lists it, so the stale name renders with no error. Pinned in Task 1.

---

### Task 1: `ViewId` and `deskLabel()`

Gives a desk's name one owner. No call site changes yet, so the product is byte-identical after this task.

**Files:**
- Modify: `app/src/ui/shell/views.ts` (after the `VIEWS` declaration, before `WORKSPACE_LEAD` at line ~138)
- Test: `app/test/desklabel.test.ts` (create)

**Interfaces:**
- Consumes: `VIEWS` from `app/src/ui/shell/views.ts`
- Produces:
  - `export type ViewId = (typeof VIEWS)[number]["id"]`
  - `export function deskLabel(id: ViewId): string`
  - `export const VIEW_IDS: ReadonlySet<string>` — every id, for the guard in Task 2 and for runtime checks against persisted values

- [ ] **Step 1: Write the failing tests**

```ts
import { VIEWS, VIEW_IDS, deskLabel, type ViewId } from "../src/ui/shell/views";

it("returns the label VIEWS holds, for every desk", () => {
  for (const v of VIEWS) expect(deskLabel(v.id)).toBe(v.label);
});

it("COVERS EVERY DESK — a lookup that answered for some would be worse than none", () => {
  expect(VIEWS.length).toBe(27);
  for (const v of VIEWS) expect(deskLabel(v.id).length).toBeGreaterThan(0);
});

it("knows every id, so a persisted desk can be checked before it is used", () => {
  // Review Focus 5: a desk whose module is gone still type-checks, because
  // VIEWS still lists it. VIEW_IDS is what a runtime caller checks against.
  expect(VIEW_IDS.size).toBe(VIEWS.length);
  expect(VIEW_IDS.has("screener")).toBe(true);
  expect(VIEW_IDS.has("not-a-desk")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/desklabel.test.ts`
Expected: FAIL — `deskLabel is not a function`

- [ ] **Step 3: Implement in `app/src/ui/shell/views.ts`**

Add `ViewId`, `VIEW_IDS` and `deskLabel` immediately after `VIEWS`. Build a `Map<string, string>` from `VIEWS` once at module scope rather than scanning per call — `deskLabel` is called during render.

Carry a comment stating why the id is typed: a `deskLabel(id: string)` that threw on an unknown id would throw inside a render effect, which `core/signal.ts` catches and logs to `window.__signalErrors`, leaving the section blank with nothing on screen to say why. A literal union moves that to `tsc`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/desklabel.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add app/src/ui/shell/views.ts app/test/desklabel.test.ts
git commit -m "One owner for a desk's display name"
```

---

### Task 2: The guard, and the 15 self-titles it fails on

The guard is written first and **proved to fail**, because two desks already disagree with their own tab — `calculator` renders "Trade calculator" under a tab reading "Calculator", and `survey` renders "Condition survey" under "Conditions". That drift exists today and is the argument for the whole task.

**Files:**
- Modify: `app/test/desklabel.test.ts`
- Modify (self-titles, one line each):
  `ui/alerts.ts:609` · `ui/calculator.ts:569` · `ui/connections.ts:691` · `ui/decision.ts:390` · `ui/flow.ts:377` · `ui/knowledge.ts:409` · `ui/paper.ts:465` · `ui/playbook.ts:1427` · `ui/results.ts:283` · `ui/risk.ts:1651` · `ui/sessions.ts:225` · `ui/simulation.ts:930` · `ui/smartmoney.ts:248` · `ui/survey.ts:722` · `ui/watchlist.ts:365`

**Interfaces:**
- Consumes: `deskLabel`, `VIEWS` (Task 1)
- Produces: `DESK_LABEL_ALLOWLIST` in the test file — `readonly { file: string; text: string; why: string }[]`

- [ ] **Step 1: Write the failing guard**

```ts
it("NO DESK MODULE WRITES A DESK NAME AS A LITERAL", () => {
  // Two owners for one fact drift and nothing fails. Measured before this
  // guard existed: `calculator` rendered "Trade calculator" under a tab
  // reading "Calculator", and `survey` rendered "Condition survey" under
  // "Conditions". Neither was red.
  const offenders = scanForLiteralLabels();   // see Step 3
  expect(offenders, offenders.map(o => `${o.file}:${o.line} "${o.text}"`).join("\n")).toEqual([]);
});

it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
  // An audit whose pattern has stopped matching reports a clean tree.
  const { filesRead, labelsSought } = scanStats();
  expect(filesRead).toBeGreaterThan(50);
  expect(labelsSought).toBe(VIEWS.length);
});

it("MATCHES WHOLE LABELS ONLY", () => {
  // Review Focus 1: "Results" must not match inside "Test results", or the
  // guard flags the very rename it exists to protect.
  expect(hitsIn(`text: "Test results"`, "Results")).toEqual([]);
  expect(hitsIn(`text: "Results"`, "Results").length).toBe(1);
});

it("SURVIVES A LABEL WITH REGEX CHARACTERS IN IT", () => {
  // Review Focus 3: labels are data; a future one containing ( . | must not
  // make the pattern match everything or throw.
  expect(() => hitsIn(`text: "a.b"`, "a.b")).not.toThrow();
  expect(hitsIn(`text: "axb"`, "a.b")).toEqual([]);
});

it("HAS NO STALE ALLOWLIST ENTRY", () => {
  // Review Focus 4: an exemption that matches nothing weakens the guard
  // silently and forever.
  for (const e of DESK_LABEL_ALLOWLIST) {
    expect(hitsInFile(e.file, e.text).length, `allowlisted ${e.text} no longer appears in ${e.file}`)
      .toBeGreaterThan(0);
    expect(e.why.length, `${e.file} exemption has no reason`).toBeGreaterThan(20);
  }
});
```

- [ ] **Step 2: Run to verify it fails, and read the list**

Run: `cd app && npx vitest run test/desklabel.test.ts`
Expected: FAIL, listing at least the 15 self-title sites above. Confirm `calculator.ts` and `survey.ts` appear — they are the pre-existing drift, not caused by this work.

- [ ] **Step 3: Implement the scanner and the allowlist in the test file**

`scanForLiteralLabels()` reads every `.ts` under `app/src` except `ui/shell/views.ts`, strips `//` and `/* */` comments and template literals, and reports any whole-word occurrence of a desk label inside a double-quoted string. Escape each label before building its pattern. Return `{ file, line, text }[]`, minus `DESK_LABEL_ALLOWLIST`.

Seed `DESK_LABEL_ALLOWLIST` with these five, each carrying its reason:

| file | text | why |
|---|---|---|
| `settings/presets.ts` | `Analyst` | a layout DENSITY preset, not the desk — a fresh install reads as "Analyst" rather than "Custom" |
| `study/methods.ts` | `Strategy` | a research METHOD category in the Analyse desk, not the Strategy desk |
| `ui/briefing.ts` | `Conditions` | a Briefing CARD about what kind of market it is; it links to Sessions, not to the survey desk |
| `ui/playbook.ts` | `Strategy` | a sub-heading for the strategy being edited — the noun, not the desk |
| `ui/strategy/flow.ts` | `Simulation` | a panel showing simulation output inside the Strategy desk — the noun, not the desk |

`core/workspace.ts:409` is the default NAME of an unnamed user layout, not the desk; allowlist it too if the scanner reaches it.

- [ ] **Step 4: Point all 15 self-titles at `deskLabel`**

One line each: `text: "Flow"` becomes `text: deskLabel("flow")`. The class attribute does not change — `desktitle.test.ts` pins which FACE each kind of title uses, and that system must not be disturbed.

`calculator.ts` and `survey.ts` lose their divergent headings here; that is the fix, not a regression.

- [ ] **Step 5: Run to verify it passes**

Run: `cd app && npx vitest run test/desklabel.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc clean

- [ ] **Step 6: Commit**

```bash
git add app/test/desklabel.test.ts app/src/ui/
git commit -m "Every desk reads its own name from VIEWS"
```

---

### Task 3: Cross-references and command groups

Four sites name a desk they point at, and eight command-palette rows carry a desk name as a section heading. Each already has the id to hand.

**Files:**
- Modify: `ui/briefing.ts:473,509` · `ui/shell/decision.ts:397` · `ui/commandset.ts:338,349,356,363,374,458,465,899`

**Interfaces:**
- Consumes: `deskLabel` (Task 1)
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

```ts
it("NAMES A DESK IT LINKS TO BY THE SAME NAME THE DESK USES", () => {
  // Two lists naming the same thing will disagree, and nothing will say so.
  // Measured once at 0 of 24 agreeing between views.ts and toolsmenu.ts.
  const brief = mountBriefingForTest();
  const link = brief.querySelector('[data-opens="screener"]');
  expect(link?.textContent).toBe(deskLabel("screener"));
});

it("gives the command palette the desk's own name as its section", () => {
  const cmds = buildCommandsForTest();
  const ws = cmds.filter((c) => c.id.startsWith("ws."));
  expect(ws.length).toBeGreaterThan(0);
  for (const c of ws) expect(c.group).toBe(deskLabel("workspace"));
});
```

`ownerLink` is today `ownerLink(label: string, onOpen: () => void)` at `briefing.ts:139` — it takes a label and a callback and has no idea which desk it opens, which is exactly how the label drifted. **Change the signature to `ownerLink(id: ViewId, onOpen: () => void)`** and derive both the text and a `data-opens={id}` attribute inside it. That removes the mismatch as a representable state instead of testing for it afterwards.

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/desklabel.test.ts -t "links"`
Expected: FAIL — the literal does not equal `deskLabel(...)` once Task 4 renames it, and `data-opens` is absent

- [ ] **Step 3: Replace the literals**

`ownerLink("Opportunities", () => opts.onOpen("screener"))` becomes `ownerLink(deskLabel("screener"), () => opts.onOpen("screener"))`. Same shape for `briefing.ts:509` (`signals`), `shell/decision.ts:397` (`screener`), and the eight `commandset.ts` sites (`workspace` ×5, `agent` ×3).

The prose comment at `commandset.ts:780` mentions "Analyst" as an example caption; update the word so the comment does not describe a name that no longer exists.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/desklabel.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add app/src/ui/ app/test/desklabel.test.ts
git commit -m "A link to a desk uses the desk's own name"
```

---

### Task 4: The 15 renames

Every reader now points at `VIEWS`, so this task is one line per desk and the whole product follows.

**Files:**
- Modify: `app/src/ui/shell/views.ts` (the 15 `label:` values)
- Modify: `app/test/deskbar.test.ts:20,22,130` · `desktitle.test.ts:11,12,135` · `menurow.test.ts:59,61,74` · `commands.test.ts:129` · `research-steered.test.ts:76` · `workspace.test.ts:453`

**Interfaces:**
- Consumes: everything above
- Produces: the final labels

- [ ] **Step 1: Write the failing tests**

```ts
it("names every desk a word a trader would type", () => {
  const expected: Record<string, string> = {
    screener: "Scanner",          decision: "Confluence",
    flow: "Derivatives",          agent: "Ask AI",
    study: "Studies",             knowledge: "Edge stats",
    survey: "Market regime",      connections: "Correlation",
    strategy: "Strategy tester",  signals: "Alerts",
    results: "Test results",      simulation: "Walk-forward",
    learn: "Track record",        workspace: "Layouts",
    paper: "Paper trading",
  };
  for (const [id, label] of Object.entries(expected)) expect(deskLabel(id as ViewId)).toBe(label);
});

it("LEAVES THE TWELVE THAT WERE ALREADY RIGHT", () => {
  for (const [id, label] of Object.entries({
    briefing: "Briefing", watchlist: "Watchlist", chart: "Chart", smart: "Smart money",
    sessions: "Sessions", risk: "Risk", calculator: "Calculator", quant: "Quant",
    playbook: "Playbook", data: "Data", journal: "Journal", system: "System",
  })) expect(deskLabel(id as ViewId)).toBe(label);
});

it("NEVER CHANGES AN ID — they are persisted, and a changed one is a blank desk", () => {
  const ids = VIEWS.map((v) => v.id).sort();
  expect(ids).toEqual([
    "agent","briefing","calculator","chart","connections","data","decision","flow","journal",
    "knowledge","learn","paper","playbook","quant","results","risk","screener","sessions",
    "signals","simulation","smart","strategy","study","survey","system","watchlist","workspace",
  ]);
});

it("GIVES NO DESK THE SAME NAME AS ITS GROUP", () => {
  // Review Focus 2: `study` becomes "Research" and a group is already called
  // "Research", so the menu would read Research > Research.
  for (const v of VIEWS) expect(v.label, `${v.id} is named after its own group`).not.toBe(v.group);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/desklabel.test.ts`
Expected: FAIL on the 15 current labels, and **FAIL on the group collision** — `study` is about to become "Research" inside the group "Research".

- [ ] **Step 3: Resolve the group collision, then apply the renames**

> **DECIDED by the owner, 2026-10-08: `study` → "Studies".** The spec had
> approved "Research", and the groups are `Today · Chart · Trade · Research ·
> Strategy · Review` — so that would have produced **Research › Research** in
> the All tools menu, a desk looking like a duplicate of its own heading. The
> group could not move; regrouping is stage 2's job. "Studies" keeps the
> searchable sense and matches the id.

Rename the DESK, not the group. Then apply the other 14 `label:` values in `VIEWS`. Nothing else in `src/` changes.

- [ ] **Step 4: Update the 12 literal assertions in `app/test/`**

Each is a label that moved. Change the expected string; do not change what the test asserts.

- [ ] **Step 5: Run the whole suite and the gate**

Run: `cd app && npx tsc --noEmit && npx vitest run` then `python verify.py`
Expected: tsc clean, all tests pass, `VERIFY PASSED`. Paste the real output.

- [ ] **Step 6: Build and check in the browser**

Run: `cd app && npm run build`, then open `http://127.0.0.1:8787` — the python build, never the dev server. Confirm the desk bar, the All tools menu and the command palette all show the new names, and that Scanner, Alerts and Layouts open the desks their ids name.

- [ ] **Step 7: Commit**

```bash
git add app/src/ui/shell/views.ts app/test/
git commit -m "Name every desk the word a trader would type"
```

---

## Done when

- 27 of 27 desk labels are words a trader would search for.
- A desk's name exists in exactly one place, guarded by a test that was proved to fail first.
- `calculator` and `survey` no longer contradict their own tabs.
- No desk id changed; no group changed.
- `python verify.py` green, with its output shown.
