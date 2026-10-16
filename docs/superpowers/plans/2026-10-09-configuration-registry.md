# Configuration Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 33 persisted slots one owner, so Settings reaches every preference by construction and accumulated state gets a place to be seen, sized, exported and cleared.

**Architecture:** A central `REGISTRY` in `app/src/settings/registry.ts` holds one entry per slot — the slot itself, its kind, and the `SettingDef` fields Settings needs. A guard scans the source for `*_SLOT` declarations and fails on any the registry does not know. `buildSettings` then iterates the registry instead of a hand-written list, and a holdings card on the System desk renders the `state` entries from pure inventory functions.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`), Vitest, hand-written signals (`core/signal.ts`), `store/kv.ts` versioned slots. Gate: `python verify.py`.

**Spec:** `docs/superpowers/specs/2026-10-09-configuration-one-owner-design.md`

> **Correction to the spec, applied in Task 1.** The spec proposes a new
> `ControlShape` type. `settings/schema.ts` already exports `SettingControl`
> with `number | text | toggle | colour | select | note | action` and a preview
> kind — everything needed. The registry uses `SettingControl`; `ControlShape`
> is not created. The spec's "a preference whose real control is a desk" is the
> existing `action` kind. *Never hand-write the type of a dependency when the
> real one can be imported.*

## Global Constraints

- **No slot KEY changes.** A changed key loses the operator's data silently.
- **`store/kv.ts` is not modified.** The defect is that nothing enumerates slots, not the store.
- **`tsc --noEmit` passes at all times.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`.
- **A bug fix starts with the failing test**, proved failing before the fix.
- **An audit that parses nothing reports success** — every scan prints what it parsed and fails on a zero.
- **Refuse rather than approximate.** A figure that cannot be computed says so; adding a metric means adding its refusal path in the same change.
- **A `secret` value is never rendered and never exported.**
- **Run `scratchpad/classcollide.py` before building a card** — a prefix claimed by two sheets renders a desk in another desk's clothes.
- **Show real gate output.** "Tests pass" without the output does not count.

## Review Focus

1. **A stored value that fails its own `validate`** — the holdings view must say "unreadable" rather than show 0 bytes, which reads as "nothing stored". Pinned in Task 3.
2. **Clearing a slot a live surface is rendering from** — the operator must not be left looking at data that no longer exists. Pinned in Task 4.
3. **A preference write that hits the quota** — `kv.write` returns a result rather than throwing, so a silent no-op is the easy bug. Pinned in Task 2.
4. **Two registry entries sharing a key** — a copy-paste that makes one slot shadow another, and nothing would say so. Pinned in Task 1.
5. **A slot present in the registry but absent from the running build** (its module deleted) — a stale entry weakens the guard for ever. Pinned in Task 1.

---

### Task 1: The registry and its guard

**Files:**
- Create: `app/src/settings/registry.ts`
- Create: `app/test/slotregistry.test.ts`

**Interfaces:**
- Consumes: `Slot<T>` from `app/src/store/kv.ts`; `SettingControl`, `SectionDef` from `app/src/settings/schema.ts`; `SECTIONS` from `app/src/settings/defs.ts`
- Produces:
  - `export type SlotKind = "preference" | "secret" | "state" | "legacy"`
  - `export type SectionId = (typeof SECTIONS)[number]["id"]`
  - `export interface SlotEntry` — `{ slot: Slot<unknown>; kind: SlotKind; label: string; what: string; section?: SectionId; control?: SettingControl }`
  - `export const REGISTRY: readonly SlotEntry[]` — 33 entries
  - `export function entriesOfKind(kind: SlotKind): readonly SlotEntry[]`

- [ ] **Step 1: Write the failing guard**

```ts
it("KNOWS EVERY SLOT IN THE SOURCE", () => {
  // All 33 fail before the registry is written. One new slot fails it ever after.
  const unregistered = scanSlots().filter((s) => !REGISTRY.some((e) => e.slot.key === s.key));
  expect(unregistered.map((s) => `${s.file}  ${s.name}`)).toEqual([]);
});

it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
  const { filesRead, slotsFound } = scanStats();
  expect(filesRead).toBeGreaterThan(50);
  expect(slotsFound).toBe(33);
});

it("HAS NO STALE ENTRY — a registered slot that no longer exists", () => {
  // Review Focus 5. A stale entry weakens the guard silently and for ever.
  const keys = new Set(scanSlots().map((s) => s.key));
  expect(REGISTRY.filter((e) => !keys.has(e.slot.key)).map((e) => e.label)).toEqual([]);
});

it("GIVES NO TWO ENTRIES THE SAME KEY", () => {
  // Review Focus 4. One slot shadowing another, with nothing to say so.
  const keys = REGISTRY.map((e) => e.slot.key);
  expect(keys.length).toBe(new Set(keys).size);
});

it("GIVES EVERY PREFERENCE A SECTION AND A CONTROL", () => {
  for (const e of entriesOfKind("preference")) {
    expect(e.section, `${e.label} has no section`).toBeDefined();
    expect(e.control, `${e.label} has no control`).toBeDefined();
  }
});

it("COUNTS FOUR WAYS, and the four add up", () => {
  expect(entriesOfKind("preference")).toHaveLength(10);
  expect(entriesOfKind("secret")).toHaveLength(1);
  expect(entriesOfKind("state")).toHaveLength(20);
  expect(entriesOfKind("legacy")).toHaveLength(2);
  expect(REGISTRY).toHaveLength(33);
});

it("NEVER CHANGES A KEY — a changed key silently loses the operator's data", () => {
  expect(REGISTRY.map((e) => e.slot.key).sort()).toEqual(KEYS_AS_SHIPPED);
});
```

`scanSlots()` reads every `.ts` under `app/src`, strips comments and template literals, and returns `{ file, name, key }` for each `const <NAME>_SLOT` — resolving the key by reading the `key:` field in the declaration, or the first string argument for the `listSlot("alerts.book", …)` form. `KEYS_AS_SHIPPED` is captured ONCE by running the scanner against the current tree and pasting the 33 keys; it is the evidence that no key moved, so it is never regenerated after a change.

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/slotregistry.test.ts`
Expected: FAIL — `REGISTRY` not defined, then (once stubbed empty) 33 unregistered slots listed by file.

- [ ] **Step 3: Implement `registry.ts`**

`SectionId` is derived from `SECTIONS`, never restated, so a preference filed under a section that does not exist is a compile error.

The 33 entries, by kind — the classification is the spec's, and `what` is one line in the operator's words, not the field name restated:

| kind | slots |
|---|---|
| preference (10) | `ACCOUNT`, `APPEARANCE`, `AUTO_SEARCH`, `BUDGET`, `CONFIG`, `ENABLED`, `EXIT`, `PREFS`, `RULES`, `TOPUP` |
| secret (1) | `AGENT_KEY` |
| state (20) | `ALERT_BOOK`, `BOOK`, `BRIEFS`, `CATALOGUE`, `CLAIMS`, `DAY`, `DISCOVERED`, `DRAWINGS`, `FLOW`, `FUNDAMENTALS`, `LAYOUT`, `RECENT`, `RUNS`, `SAYS`, `SCRIPTS`, `STUDIES`, `SWEEP`, `TIMINGS`, `TODAY_PLAN`, `WATCH` |
| legacy (2) | `LEGACY_CALC`, `LEGACY_RISK` |

`CONFIG` and `ENABLED` take `{ kind: "action", button: … }` — the governor's limits and 29 detectors are edited where they already live, and a settings widget would be a worse version of a working desk. The entry still exists, so Settings **accounts** for them.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/slotregistry.test.ts && npx tsc --noEmit`
Expected: PASS, 7 tests; tsc clean

- [ ] **Step 5: Commit**

```bash
git add app/src/settings/registry.ts app/test/slotregistry.test.ts
git commit -m "One owner for every stored slot"
```

---

### Task 2: Settings renders every preference by construction

**Files:**
- Modify: `app/src/settings/defs.ts` (`buildSettings`)
- Modify: `app/test/slotregistry.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`, `entriesOfKind` (Task 1); `SettingDef` from `app/src/settings/schema.ts`
- Produces: `export function registrySettings(kv: KV): readonly SettingDef[]` — one `SettingDef` per `preference` entry, id `"<section>.<slotKey>"`

- [ ] **Step 1: Write the failing test**

```ts
it("PRODUCES A CONTROL FOR EVERY PREFERENCE, so a registered one cannot be invisible", () => {
  const defs = registrySettings(memoryKv());
  for (const e of entriesOfKind("preference")) {
    expect(defs.find((d) => d.id.endsWith(e.slot.key)), `${e.label} has no control`).toBeDefined();
  }
});

it("REACHES THE FIVE THAT SETTINGS COULD NOT", () => {
  // The whole point. CONFIG is the governor's limits — daily loss, max trades,
  // losses in a row — editable only on the Risk desk until now.
  const ids = registrySettings(memoryKv()).map((d) => d.id);
  for (const key of ["risk.config", "auto.search", "data.budget", "edges.enabled", "data.topup"]) {
    expect(ids.some((id) => id.endsWith(key)), `${key} still unreachable`).toBe(true);
  }
});

it("REPORTS A WRITE THE STORE REFUSED, rather than silently doing nothing", () => {
  // Review Focus 3. kv.write RETURNS a result; localStorage is ~5MB and throws
  // QuotaExceededError, so a swallowed result is a setting that appears to
  // change and does not.
  const def = registrySettings(fullKv()).find((d) => d.control.kind === "toggle");
  expect(def).toBeDefined();
  def?.write?.("true");
  expect(def?.unavailable?.()).toMatch(/full|space|quota/i);
});
```

`memoryKv()` and `fullKv()` are test doubles over `RawStore` — `fullKv` throws `QuotaExceededError` on `setItem`. **No test may touch the real store**; this repo has six recorded breaches of that rule through three different doors.

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/slotregistry.test.ts -t "preference"`
Expected: FAIL — `registrySettings` not defined

- [ ] **Step 3: Implement `registrySettings(kv: KV): readonly SettingDef[]` in `app/src/settings/defs.ts`**

Each entry becomes a `SettingDef` whose `read()` and `write()` go through `kv` and the entry's own slot, so the slot stays the only owner of the value. `write` surfaces a refused result through `unavailable()`.

- [ ] **Step 4: Wire it into the shipped settings**

`buildSettings` concatenates `registrySettings(kv)` with the hand-built defs, de-duplicating by `id` so a preference already hand-built (account, appearance, rules, exits) keeps its richer control and the five missing ones arrive.

- [ ] **Step 5: Run to verify it passes**

Run: `cd app && npx vitest run && npx tsc --noEmit`
Expected: PASS, whole suite; tsc clean

- [ ] **Step 6: Commit**

```bash
git add app/src/settings/defs.ts app/test/slotregistry.test.ts
git commit -m "Settings reaches every preference by construction"
```

---

### Task 3: The holdings inventory, as pure functions

**Files:**
- Create: `app/src/settings/holdings.ts`
- Create: `app/test/holdings.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`, `entriesOfKind` (Task 1)
- Produces:
  - `export interface Holding` — `{ key: string; label: string; what: string; bytes: number; readable: boolean; why: string }`
  - `export function inventory(kv: KV): readonly Holding[]` — `state` entries only
  - `export function clearPlan(keys: readonly string[]): { labels: readonly string[]; unknown: readonly string[] }`
  - `export function exportable(h: Holding): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
it("SIZES WHAT IS STORED, in bytes of the serialised record", () => {
  const kv = memoryKv();
  kv.write(ALERT_BOOK_SLOT, [{ /* one alert */ }]);
  const row = inventory(kv).find((h) => h.key === ALERT_BOOK_SLOT.key);
  expect(row?.bytes).toBeGreaterThan(0);
});

it("SAYS UNREADABLE RATHER THAN ZERO when the stored value fails its own validate", () => {
  // Review Focus 1. Zero bytes reads as "nothing stored"; this is "something
  // is stored and I cannot read it", which is a different thing to do about.
  const kv = memoryKv();
  kv.raw.setItem(DRAWINGS_SLOT.key, '{"v":1,"value":"not an array"}');
  const row = inventory(kv).find((h) => h.key === DRAWINGS_SLOT.key);
  expect(row?.readable).toBe(false);
  expect(row?.bytes).toBeGreaterThan(0);
  expect(row?.why).toMatch(/\w/);
});

it("LISTS ONLY ACCUMULATED STATE — a preference has a home already", () => {
  const keys = inventory(memoryKv()).map((h) => h.key);
  expect(keys).toHaveLength(20);
  expect(keys).not.toContain(ACCOUNT_SLOT.key);
});

it("NEVER OFFERS A SECRET FOR EXPORT", () => {
  expect(inventory(memoryKv()).some((h) => h.key === AGENT_KEY_SLOT.key)).toBe(false);
});

it("NAMES EVERY SLOT A CLEAR WILL EMPTY, by label", () => {
  const plan = clearPlan([ALERT_BOOK_SLOT.key, DRAWINGS_SLOT.key]);
  expect(plan.labels).toHaveLength(2);
  expect(plan.labels.every((l) => l.length > 3)).toBe(true);
});

it("REFUSES A KEY IT DOES NOT KNOW rather than clearing something else", () => {
  const plan = clearPlan(["not.a.slot"]);
  expect(plan.labels).toEqual([]);
  expect(plan.unknown).toEqual(["not.a.slot"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/holdings.test.ts`
Expected: FAIL — `inventory` not defined

- [ ] **Step 3: Implement the three functions in `app/src/settings/holdings.ts`**

Pure over a `KV` handed in — no module-level store, nothing that reaches the real one. Size is the byte length of the raw serialised record, read through `kv.raw`, so an unreadable value still has a size.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/holdings.test.ts && npx tsc --noEmit`
Expected: PASS, 6 tests; tsc clean

- [ ] **Step 5: Commit**

```bash
git add app/src/settings/holdings.ts app/test/holdings.test.ts
git commit -m "What this terminal holds, as arithmetic"
```

---

### Task 4: The holdings card on the System desk

**Files:**
- Create: `app/src/ui/cards/holdingscard.ts`
- Create: `app/src/styles/holdings.css` (only if the prefix check demands a new sheet)
- Modify: `app/src/ui/system.ts`
- Create: `app/test/holdingscard.test.ts`

**Interfaces:**
- Consumes: `inventory`, `clearPlan`, `exportable` (Task 3)
- Produces: `export function createHoldingsCard(deps: { kv: KV; onCleared?: () => void }): HTMLElement`

- [ ] **Step 1: Choose a CSS prefix that is free**

Run: `python scratchpad/classcollide.py`
Expected: the chosen prefix is claimed by no other sheet. `hd-` and `st-` are both plausible and both must be checked — this repo shipped a desk rendering in another desk's clothes for two releases because `.sy-` was claimed twice.

- [ ] **Step 2: Write the failing test**

```ts
it("NAMES WHAT A CLEAR WILL EMPTY, before it empties it", () => {
  const el = createHoldingsCard({ kv: memoryKv() });
  el.querySelector<HTMLInputElement>('[data-slot]')?.click();
  el.querySelector<HTMLButtonElement>('[data-act="clear"]')?.click();
  const confirm = el.querySelector('[data-confirm]');
  expect(confirm?.textContent).toMatch(/\w{4,}/);
});

it("TELLS THE SURFACES READING A SLOT THAT IT IS GONE", () => {
  // Review Focus 2. Clearing the alert book while the Alerts desk is rendering
  // from it leaves the operator looking at data that no longer exists.
  let told = 0;
  const el = createHoldingsCard({ kv: memoryKv(), onCleared: () => { told++; } });
  clearFirstSlot(el);
  expect(told).toBe(1);
});

it("OFFERS NO EXPORT FOR AN UNREADABLE HOLDING", () => {
  const el = createHoldingsCard({ kv: kvWithCorruptDrawings() });
  const row = el.querySelector('[data-slot="iram.drawings"]');
  expect(row?.querySelector('[data-act="export"]')).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run test/holdingscard.test.ts`
Expected: FAIL — `createHoldingsCard` not defined

- [ ] **Step 4: Implement the card and mount it on the System desk**

Rows carry `data-slot="<key>"`. The clear confirmation lists every label from `clearPlan`, never a count — *silently doing less than asked is the same shape as a study whose dead vendors vanished from its reported window*. Export writes JSON through the existing download path.

- [ ] **Step 5: Run to verify it passes**

Run: `cd app && npx vitest run && npx tsc --noEmit`
Expected: PASS, whole suite; tsc clean

- [ ] **Step 6: Commit**

```bash
git add app/src/ui/cards/holdingscard.ts app/src/ui/system.ts app/src/styles/ app/test/holdingscard.test.ts
git commit -m "A place to see what this terminal holds"
```

---

### Task 5: Delete the two legacy slots

**Files:**
- Modify: `app/src/core/account.ts`
- Modify: `app/src/settings/registry.ts`
- Modify: `app/test/slotregistry.test.ts`

**Interfaces:**
- Consumes: `REGISTRY` (Task 1)

- [ ] **Step 1: Write the failing test**

```ts
it("HAS MIGRATED EVERY LEGACY VALUE BEFORE THE SLOT IS REMOVED", () => {
  // Deleting the only copy of something the operator has not migrated yet is
  // not cleanup. This proves the path is dead, not merely unused.
  const kv = memoryKv();
  kv.raw.setItem(LEGACY_RISK_KEY, JSON.stringify(A_V1_RISK_VALUE));
  readAccount(kv);
  expect(kv.read(ACCOUNT_SLOT)).toMatchObject(EXPECTED_AFTER_MIGRATION);
});

it("CARRIES NO LEGACY ENTRY ONCE THE MIGRATION IS PROVEN", () => {
  expect(entriesOfKind("legacy")).toEqual([]);
  expect(REGISTRY).toHaveLength(31);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/slotregistry.test.ts -t "legacy"`
Expected: FAIL — two legacy entries still registered

- [ ] **Step 3: Remove both slots and their registry entries**

Only after the migration test passes. The count test in Task 1 moves from 33 to 31 and `KEYS_AS_SHIPPED` loses those two keys — the one sanctioned edit to that list, because the keys are being deliberately retired rather than accidentally moved.

- [ ] **Step 4: Run the gate**

Run: `cd app && npm run build`, then `python verify.py` from the repo root
Expected: `VERIFY PASSED`. Paste the real output.

- [ ] **Step 5: Check it in the browser**

Open `http://127.0.0.1:8787` — the python build, never the dev server. Confirm the five previously unreachable preferences appear in Settings, that the governor's limits edited there match the Risk desk, and that the System desk lists what is held with sizes.

- [ ] **Step 6: Commit**

```bash
git add app/src/core/account.ts app/src/settings/registry.ts app/test/slotregistry.test.ts
git commit -m "Retire the two legacy slots, once the migration is proven dead"
```

---

## Done when

- Every `*_SLOT` in the source is in the registry, guarded by a test proved to fail first.
- The five unreachable preferences are reachable, the governor's limits among them.
- Accumulated state has a place to be seen, sized, exported and cleared, and a secret has none of those but the last.
- No slot key changed except the two deliberately retired.
- `python verify.py` green, with its output shown.
