/**
 * ONE OWNER FOR EVERY STORED SLOT.
 *
 * Thirty-eight things persist to key-value storage. The Settings dialog
 * reached a list passed by hand, so five preferences existed, worked,
 * persisted and could not be found — the governor's own limits among them.
 * Most of the rest are not settings at all; they are data the product
 * accumulated, and they needed somewhere to be seen, sized and cleared.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SCANNER MATCHES SHAPE, NOT NAME, AND THAT IS THE SECOND VERSION
 *
 * The first matched `const <NAME>_SLOT`. That is a NAMING CONVENTION, not the
 * thing itself, and it missed five slots declared as a plain `SLOT` or through
 * `listSlot` — including `journal.entries`, which holds what the operator
 * wrote about their own trades. A guard whose entire job is to enumerate was
 * under-counting by five, and nothing said so.
 *
 * Two real shapes, and both are matched:
 *
 *     const X = { key: "a.b", version: 1, ... }
 *     const X = listSlot<T>("a.b", 1, isT)
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

const OBJ_SLOT = /key:\s*"([^"]+)"\s*,\s*\n\s*version:\s*\d+/g;
const LIST_SLOT = /listSlot\s*(?:<[^>]*>)?\s*\(\s*\n?\s*"([^"]+)"/g;

/** Comments only. The thing being sought IS a string literal. */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

interface FoundSlot {
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
    if (!body.includes("key:") && !body.includes("listSlot")) continue;
    const file = relative(SRC, abs).split(/[\\/]/).join("/");
    for (const rx of [OBJ_SLOT, LIST_SLOT]) {
      rx.lastIndex = 0;
      for (const m of body.matchAll(rx)) slots.push({ key: m[1] as string, file });
    }
  }
  CACHED = { slots, filesRead: files.length };
  return CACHED;
}

/**
 * The keys as they ship, captured once by reading the tree.
 *
 * A KEY IS THE OPERATOR'S DATA. Change one and the stored value is orphaned
 * with nothing on screen to say why. This list is the evidence that none moved;
 * it is not regenerated after a change, because then it would prove nothing.
 */
const KEYS_AS_SHIPPED: readonly string[] = [
  "account.v1", "agent.briefs", "agent.credential", "alerts.book", "autosearch",
  "calculator.v1", "catalogue.symbols", "commands.recent", "discovered.v1",
  "drawings.book", "fundamentals.markets", "journal.entries", "learn.claims",
  "learn.enabled", "learn.knowledge", "learn.runs", "library.budget-gb",
  "paper.v1", "playbook.v1", "research.topup", "review.rules", "risk.book",
  "risk.config", "risk.today", "screener.watch", "scripts", "setup.exitRules",
  "setup.rules", "shell.appearance", "shell.prefs", "strategy.flow", "studies",
  "study-timings", "sweep.v1", "today.plan", "verdict.says", "watchlist.v1",
  "workspace.layout",
];

/**
 * ONE KEY, TWO DECLARATIONS — allowed only here, and only with a reason.
 *
 * Both are the account's migration reading a key a CURRENT desk writes. The
 * plan called these "legacy" and asked for them to be deleted once their
 * migration path was dead; it is not dead (it runs on every profile with no
 * `account.v1`) and they are not legacy (they read live keys). Recorded as
 * what they are rather than removed or quietly relabelled.
 */
const TWO_DECLARATIONS: readonly { key: string; why: string }[] = [
  {
    key: "risk.config",
    why:
      "ui/risk.ts writes the governor's limits here on every change; core/account.ts reads the same key as a pre-v40 account shape when no account.v1 exists. RiskConfig DOES carry equity and riskPct, so the account seeds itself from the Risk desk — accidentally, because the reader believes it is reading an old shape.",
  },
  {
    key: "calculator.v1",
    why:
      "ui/calculator.ts writes the calculator's saved inputs here; core/account.ts reads the same key as a pre-v40 calculator shape. Same mechanism as risk.config, and the two together are what migrateAccount reports conflicts between — which are really disagreements between two live desks.",
  },
];

/* ----------------------------------------------------------------- tests -- */

describe("the registry knows the tree", () => {
  it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
    const { slots, filesRead } = scan();
    expect(filesRead, "the scanner read no source files").toBeGreaterThan(50);
    expect(new Set(slots.map((s) => s.key)).size).toBe(38);
  });

  it("KNOWS EVERY SLOT IN THE SOURCE", () => {
    const known = new Set(REGISTRY.map((e) => e.key));
    const missing = scan().slots.filter((s) => !known.has(s.key));
    expect([...new Set(missing.map((s) => `${s.file}  ${s.key}`))]).toEqual([]);
  });

  it("HAS NO STALE ENTRY — a registered slot that no longer exists", () => {
    const found = new Set(scan().slots.map((s) => s.key));
    expect(REGISTRY.filter((e) => !found.has(e.key)).map((e) => e.label)).toEqual([]);
  });

  it("NEVER CHANGES A KEY — a changed key orphans the operator's data", () => {
    expect(REGISTRY.map((e) => e.key).sort()).toEqual([...KEYS_AS_SHIPPED].sort());
  });

  it("GIVES EVERY KEY EXACTLY ONE ENTRY", () => {
    /* The registry describes STORAGE, which is keyed by key. Two code
       declarations on one key is a fact about the code, checked below. */
    const keys = REGISTRY.map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe("a key declared twice", () => {
  it("IS EXPLAINED, OR IT FAILS", () => {
    const counts = new Map<string, number>();
    for (const s of scan().slots) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
    const doubled = [...counts].filter(([, n]) => n > 1).map(([k]) => k).sort();
    expect(doubled).toEqual([...TWO_DECLARATIONS.map((d) => d.key)].sort());
  });

  it("CARRIES A REASON SOMEBODY COULD ACT ON", () => {
    for (const d of TWO_DECLARATIONS) expect(d.why.length).toBeGreaterThan(60);
  });

  it("IS NEVER WRITTEN THROUGH THE MIGRATION SIDE", () => {
    /* The overlap is only survivable because the account side only READS. A
       writer there would overwrite the governor's limits or the calculator's
       inputs with a shape neither desk expects. */
    const src = readFileSync(join(SRC, "core/account.ts"), "utf-8");
    expect(/kv\.write\(\s*LEGACY_/.test(src), "the migration side writes").toBe(false);
  });
});

describe("the kinds", () => {
  it("COUNTS BY KIND, and the counts add up", () => {
    expect(entriesOfKind("preference")).toHaveLength(10);
    expect(entriesOfKind("secret")).toHaveLength(1);
    expect(entriesOfKind("state")).toHaveLength(27);
    expect(REGISTRY).toHaveLength(38);
  });

  it("HAS NO `legacy` ENTRY, because neither candidate turned out to be one", () => {
    /* The kind stays in the type for a migration that really is dead one day.
       Both slots that wore the label read keys a current desk writes. */
    expect(entriesOfKind("legacy")).toEqual([]);
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

  it("OFFERS NO CONTROL TO ANYTHING THAT IS NOT A PREFERENCE", () => {
    for (const kind of ["secret", "state"] as const) {
      for (const e of entriesOfKind(kind)) {
        expect(e.control, `${e.label} is ${kind} and has a control`).toBeUndefined();
      }
    }
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
    const ids = registrySettings(createKV(memoryRawStore())).map((d) => d.id);
    for (const key of [
      "risk.config",
      "autosearch",
      "library.budget-gb",
      "learn.enabled",
      "research.topup",
    ]) {
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
    const toggle = registrySettings(createKV(fullStore())).find((d) => d.control.kind === "toggle");
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
