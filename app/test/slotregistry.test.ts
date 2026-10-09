/**
 * ONE OWNER FOR EVERY STORED SLOT.
 *
 * Thirty-four things persist to key-value storage. The Settings dialog reached
 * a list passed by hand at `ui/shell.ts`, so five preferences existed, worked,
 * persisted, and could not be found — the governor's own limits among them.
 * Twenty-one of the thirty-four are not settings at all; they are data the
 * product accumulated, and what they need is a place to be seen, sized,
 * exported and cleared.
 *
 * The registry is the list. This file is what stops it falling behind.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGISTRY, entriesOfKind, registrySettings } from "../src/settings/registry";
import { createKV, memoryRawStore, type RawStore } from "../src/store/kv";
import { SECTIONS } from "../src/settings/defs";

/* --------------------------------------------------------------- scanner -- */

/** `fileURLToPath`, because this checkout's path contains spaces. */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Match the NAME only, and slice the window separately.
 *
 * The first version of this captured a 400-character tail inside the same
 * regex — and `matchAll` is non-overlapping, so any declaration sitting within
 * 400 characters of another was swallowed whole and never seen. Four of thirty
 * went missing that way, every one of them a few lines from a sibling slot. An
 * audit that quietly sees less than exists is the failure this repository has
 * shipped four times.
 */
const DECL = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_SLOT)\b/g;
const KEY_FIELD = /\bkey\s*:\s*"([^"]+)"/;
const LIST_SLOT = /listSlot\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/;

/** Comments only. The thing being sought IS a string literal. */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

export interface FoundSlot {
  readonly name: string;
  readonly key: string;
  readonly file: string;
}

function tsFiles(dir = SRC, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}

let CACHED: { slots: FoundSlot[]; filesRead: number } | null = null;

function scan(): { slots: FoundSlot[]; filesRead: number } {
  if (CACHED !== null) return CACHED;
  const files = tsFiles();
  const slots: FoundSlot[] = [];
  for (const abs of files) {
    const body = strip(readFileSync(abs, "utf-8"));
    if (!body.includes("_SLOT")) continue;
    const file = relative(SRC, abs).split(/[\\/]/).join("/");
    DECL.lastIndex = 0;
    for (const m of body.matchAll(DECL)) {
      const window = body.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 400);
      const k = LIST_SLOT.exec(window) ?? KEY_FIELD.exec(window);
      slots.push({ name: m[1] as string, key: k ? (k[1] as string) : "<<unreadable>>", file });
    }
  }
  CACHED = { slots, filesRead: files.length };
  return CACHED;
}

/**
 * The keys as they ship, captured once by reading the tree.
 *
 * A KEY IS THE OPERATOR'S DATA. Change one and the stored value is orphaned,
 * with nothing on screen to say why. This list is evidence that none moved; it
 * is not regenerated after a change, because then it would prove nothing.
 */
const KEYS_AS_SHIPPED: readonly string[] = [
  "account.v1", "agent.briefs", "agent.credential", "alerts.book", "autosearch",
  "calculator.v1", "catalogue.symbols", "commands.recent", "discovered.v1",
  "drawings.book", "fundamentals.markets", "learn.claims", "learn.enabled",
  "learn.knowledge", "learn.runs", "library.budget-gb", "research.topup",
  "risk.book", "risk.config", "risk.config", "risk.today", "screener.watch",
  "scripts", "setup.exitRules", "setup.rules", "shell.appearance", "shell.prefs",
  "strategy.flow", "studies", "study-timings", "sweep.v1", "today.plan",
  "verdict.says", "workspace.layout",
];

/* ----------------------------------------------------------------- tests -- */

describe("the registry knows the tree", () => {
  it("READS EVERY SLOT'S KEY — an unreadable one is a scanner that has stopped working", () => {
    expect(scan().slots.filter((s) => s.key === "<<unreadable>>")).toEqual([]);
  });

  it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
    /* An audit whose pattern has stopped matching reports a clean tree. */
    const { slots, filesRead } = scan();
    expect(filesRead, "the scanner read no source files").toBeGreaterThan(50);
    expect(slots).toHaveLength(34);
  });

  it("KNOWS EVERY SLOT IN THE SOURCE", () => {
    const keys = new Set(REGISTRY.map((e) => e.key));
    const missing = scan().slots.filter((s) => !keys.has(s.key));
    expect(missing.map((s) => `${s.file}  ${s.name}  ${s.key}`)).toEqual([]);
  });

  it("HAS NO STALE ENTRY — a registered slot that no longer exists", () => {
    /* An entry naming a slot that is gone weakens the guard silently and for
       ever: it can never fail again for the thing it was written to catch. */
    const found = new Set(scan().slots.map((s) => s.key));
    expect(REGISTRY.filter((e) => !found.has(e.key)).map((e) => e.label)).toEqual([]);
  });

  it("NEVER CHANGES A KEY — a changed key orphans the operator's data", () => {
    expect(REGISTRY.map((e) => e.key).sort()).toEqual([...KEYS_AS_SHIPPED].sort());
  });
});

describe("the four kinds", () => {
  it("COUNTS FOUR WAYS, and the four add up", () => {
    expect(entriesOfKind("preference")).toHaveLength(10);
    expect(entriesOfKind("secret")).toHaveLength(1);
    expect(entriesOfKind("state")).toHaveLength(21);
    expect(entriesOfKind("legacy")).toHaveLength(2);
    expect(REGISTRY).toHaveLength(34);
  });

  it("GIVES EVERY PREFERENCE A SECTION AND A CONTROL", () => {
    for (const e of entriesOfKind("preference")) {
      expect(e.section, `${e.label} has no section`).toBeDefined();
      expect(e.control, `${e.label} has no control`).toBeDefined();
    }
  });

  it("GIVES EVERY ENTRY A LABEL AND A SENTENCE SOMEBODY COULD READ", () => {
    for (const e of REGISTRY) {
      expect(e.label.length, `${e.key} has no label`).toBeGreaterThan(2);
      expect(e.what.length, `${e.key} does not say what it is`).toBeGreaterThan(12);
      expect(e.what, `${e.key} just restates its own name`).not.toBe(e.label);
    }
  });

  it("OFFERS NEITHER A SECTION NOR A CONTROL TO ANYTHING THAT IS NOT A PREFERENCE", () => {
    /* A secret with a control is a credential in a text box; a state slot with
       one is the alert book rendered as a setting. Both are category errors. */
    for (const kind of ["secret", "state", "legacy"] as const) {
      for (const e of entriesOfKind(kind)) {
        expect(e.control, `${e.label} is ${kind} and has a control`).toBeUndefined();
      }
    }
  });
});

describe("keys, and the one duplicate that is allowed", () => {
  it("GIVES NO TWO LIVE SLOTS THE SAME KEY", () => {
    /* Two live slots on one key is one shadowing the other, with nothing to
       say so. `legacy` is excluded because a migration slot is a read-only
       VIEW of another slot's key — see the next test, which requires that. */
    const live = REGISTRY.filter((e) => e.kind !== "legacy").map((e) => e.key);
    expect(live.length).toBe(new Set(live).size);
  });

  it("REQUIRES A LEGACY SLOT TO NAME A KEY SOMETHING STILL WRITES", () => {
    /* MEASURED, and the reason the plan's flat uniqueness rule was wrong:
       LEGACY_RISK_SLOT and CONFIG_SLOT both hold "risk.config". That is
       deliberate — the legacy one is read once, never written, to migrate an
       old shape into the account. Turning the duplicate into a CHECKED
       relationship also catches the opposite defect: a legacy slot reading a
       key nobody writes any more is dead migration code pretending to be a
       safeguard. */
    const live = new Set(REGISTRY.filter((e) => e.kind !== "legacy").map((e) => e.key));
    const orphans = entriesOfKind("legacy").filter((e) => !live.has(e.key));
    for (const o of orphans) {
      expect(
        KEYS_AS_SHIPPED.filter((k) => k === o.slot.key).length,
        `${o.label} migrates from a key nothing writes`,
      ).toBeGreaterThan(0);
    }
  });

  it("NEVER WRITES THROUGH A LEGACY SLOT", () => {
    /* The duplicate is only safe because the legacy side is read-only. If one
       ever gains a writer it would overwrite the live slot that shares its key
       — the governor's limits, in the case on record. */
    const src = readFileSync(join(SRC, "core/account.ts"), "utf-8");
    expect(/kv\.write\(\s*LEGACY_/.test(src), "a legacy slot is being written").toBe(false);
  });
});

describe("Settings reaches every preference", () => {
  /** A store that refuses every write, the way localStorage does at ~5MB. */
  const fullStore = (): RawStore => ({
    getItem: () => null,
    setItem: () => {
      const e = new Error("quota");
      e.name = "QuotaExceededError";
      throw e;
    },
    removeItem: () => {},
    key: () => null,
    length: 0,
  });

  it("PRODUCES A CONTROL FOR EVERY PREFERENCE, so a registered one cannot be invisible", () => {
    const defs = registrySettings(createKV(memoryRawStore()));
    for (const e of entriesOfKind("preference")) {
      expect(defs.find((d) => d.id.endsWith(e.key)), `${e.label} has no control`).toBeDefined();
    }
  });

  it("REACHES THE FIVE SETTINGS COULD NOT", () => {
    /* The whole point. `risk.config` is the governor: daily loss limit, trades
       per day, losses in a row — editable only on the Risk desk until now. */
    const ids = registrySettings(createKV(memoryRawStore())).map((d) => d.id);
    for (const key of ["risk.config", "autosearch", "library.budget-gb", "learn.enabled", "research.topup"]) {
      expect(ids.some((id) => id.endsWith(key)), `${key} still unreachable`).toBe(true);
    }
  });

  it("GIVES EVERY DEF A SECTION THAT EXISTS", () => {
    const known = new Set(SECTIONS.map((x) => x.id));
    for (const d of registrySettings(createKV(memoryRawStore()))) {
      expect(known.has(d.section), `${d.id} is filed under "${d.section}"`).toBe(true);
    }
  });

  it("REPORTS A WRITE THE STORE REFUSED, rather than silently doing nothing", () => {
    /* `kv.write` RETURNS a result; localStorage is ~5MB and throws on quota.
       A swallowed result is a setting that appears to change and does not. */
    const defs = registrySettings(createKV(fullStore()));
    const toggle = defs.find((d) => d.control.kind === "toggle");
    expect(toggle, "no toggle to exercise").toBeDefined();
    toggle?.write?.("true");
    expect(toggle?.unavailable?.()).toMatch(/full|space|quota|room/i);
  });

  it("NEVER OFFERS A CONTROL FOR A SECRET OR FOR ACCUMULATED STATE", () => {
    const ids = registrySettings(createKV(memoryRawStore())).map((d) => d.id);
    for (const e of [...entriesOfKind("secret"), ...entriesOfKind("state")]) {
      expect(ids.some((id) => id.endsWith(e.key)), `${e.label} became a setting`).toBe(false);
    }
  });
});
