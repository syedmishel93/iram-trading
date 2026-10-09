/**
 * ONE OWNER FOR EVERY STORED SLOT.
 *
 * FORTY-TWO things persist to key-value storage — and this sentence has been
 * wrong three times, at 33, 34 and 38, each time because the scanner matched
 * something narrower than a slot. The count below is asserted from `REGISTRY`,
 * not from the scanner, because an expected value taken from the code under
 * test cannot fail. The Settings dialog
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
import { REGISTRY, entriesOfKind } from "../src/settings/registry";
import { buildSettings } from "../src/settings/defs";
import { stubDeps } from "./helpers/shippedsettings";
import type { SettingDef } from "../src/settings/schema";

/* --------------------------------------------------------------- scanner -- */

/** `fileURLToPath`, because this checkout's path contains spaces. */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * A SLOT IS AN OBJECT WITH A VERSION AND A VALIDATOR, or a call to one of the
 * helpers. Matching the KEY was the mistake in both earlier versions.
 */
const SLOT_OBJECT = /\{[^{}]*?\bversion:\s*\d+[^{}]*?\b(?:fallback|validate):/gs;
const HELPER_CALL = /\b(?:listSlot|recordSlot)\s*(?:<[^>]*>)?\s*\(\s*([^,)]+)/g;
/** `createViewStore(kv, "key")` — the key is a literal at the CALL SITE. */
const VIEW_STORE = /\bcreateViewStore\s*\(\s*[^,)]+,\s*"([^"]+)"/g;

/** `key: "x"`, `key: CONST`, or the `key,` shorthand, inside one object. */
const KEY_IN_OBJECT = /\bkey\s*[:,]/;
const KEY_LITERAL = /\bkey:\s*"([^"]+)"/;
const KEY_CONST = /\bkey:\s*([A-Z][A-Z0-9_]*)\b/;
const KEY_SHORTHAND = /\bkey\s*,/;

/** Comments only. The thing being sought IS a string literal. */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * `const NAME = "literal"` ACROSS THE WHOLE TREE, not per file.
 *
 * `ui/data.ts` writes `key: SYNC_CREDENTIAL_KEY`, and that constant is exported
 * from `store/sync.ts`. A per-file map could not see it and reported the key as
 * unreadable — which, before this, meant a bearer token in browser storage that
 * the registry did not classify.
 */
function constants(bodies: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const body of bodies) {
    for (const m of body.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
      out.set(m[1] as string, m[2] as string);
    }
  }
  return out;
}

/**
 * The file that DEFINES the helpers declares no slot of its own.
 *
 * `listSlot(key: string, …)` matches the call pattern because the parameter
 * list looks like one. Named rather than dodged by the pattern, so the
 * exemption is one file with a reason and not a hole in the shape.
 */
const DEFINES_A_FACTORY: readonly { file: string; why: string }[] = [
  { file: "store/kv.ts", why: "declares listSlot and recordSlot; the `key: string` parameter looks like a call" },
  { file: "ui/savedviews.ts", why: "declares a slot() factory taking the key at runtime; the real key is a literal at the createViewStore call site, which is scanned" },
];

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

let CACHED: { slots: FoundSlot[]; scanned: number; unresolved: string[] } | null = null;

function scan(): { slots: FoundSlot[]; scanned: number; unresolved: string[] } {
  if (CACHED !== null) return CACHED;
  const slots: FoundSlot[] = [];
  const unresolved: string[] = [];
  let scanned = 0;

  const files = tsFiles();
  const bodies = files.map((f) => strip(readFileSync(f, "utf-8")));
  const consts = constants(bodies);

  for (let i = 0; i < files.length; i += 1) {
    const abs = files[i] as string;
    const body = bodies[i] as string;
    /* NO `\(` IN THIS FILTER. The real calls are `listSlot<AlertSpec>(`, and
       requiring the parenthesis straight after the name skipped those files
       WHOLESALE — the alert book and the drawings vanished from a scan whose
       entire job is to find them, and only the stale-entry test said so. */
    if (!/\bversion:\s*\d/.test(body) && !/\b(?:listSlot|recordSlot|createViewStore)\b/.test(body)) {
      continue;
    }
    const file = relative(SRC, abs).split(/[\\/]/).join("/");
    if (DEFINES_A_FACTORY.some((f) => f.file === file)) continue;
    scanned += 1;

    SLOT_OBJECT.lastIndex = 0;
    for (const m of body.matchAll(SLOT_OBJECT)) {
      const obj = m[0];
      if (!KEY_IN_OBJECT.test(obj)) continue;
      const lit = KEY_LITERAL.exec(obj);
      if (lit) {
        slots.push({ key: lit[1] as string, file });
        continue;
      }
      const named = KEY_CONST.exec(obj);
      const viaConst = named ? consts.get(named[1] as string) : undefined;
      if (viaConst !== undefined) {
        slots.push({ key: viaConst, file });
        continue;
      }
      if (KEY_SHORTHAND.test(obj)) {
        /* A key handed in at runtime. The slot is real and the scanner cannot
           name it, so the registry must carry it and this says which file. */
        unresolved.push(`${file}  key given at runtime`);
        continue;
      }
      unresolved.push(`${file}  ${named ? `key: ${named[1]} (constant not in this file)` : "key unreadable"}`);
    }

    VIEW_STORE.lastIndex = 0;
    for (const m of body.matchAll(VIEW_STORE)) slots.push({ key: m[1] as string, file });

    HELPER_CALL.lastIndex = 0;
    for (const m of body.matchAll(HELPER_CALL)) {
      const arg = (m[1] ?? "").trim();
      const lit = /^"([^"]+)"$/.exec(arg);
      if (lit) {
        slots.push({ key: lit[1] as string, file });
        continue;
      }
      const viaConst = consts.get(arg);
      if (viaConst !== undefined) slots.push({ key: viaConst, file });
      else unresolved.push(`${file}  helper key ${arg || "(empty)"}`);
    }
  }

  CACHED = { slots, scanned, unresolved };
  return CACHED;
}

/**
 * The keys as they ship, captured once by reading the tree.
 *
 * FOUR KEYS WERE ADDED HERE AFTER A REVIEW, and that is not the same as a key
 * moving. `review.judgements`, `sync.state`, `sync.credential` and
 * `screener.views` were always stored; the scanner could not see the shapes
 * they are declared in. Nothing was renamed. A list that grows for any other
 * reason is a list that has stopped being evidence.
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
  /* found by review, after the scanner was widened a third time */
  "review.judgements", "screener.views", "sync.credential", "sync.state",
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
    const { slots, scanned, unresolved } = scan();
    expect(scanned, "the scanner looked at no slot-bearing file").toBeGreaterThan(8);
    /* EVERY KEY IT COULD NOT READ IS A FAILURE THAT NAMES THE FILE. A scan
       that skips what it cannot parse answers confidently about less than it
       looked at, which is this guard's whole failure history. */
    expect(unresolved).toEqual([]);
    /* Asserted from the REGISTRY, not from the scanner. An expected value
       taken from the code under test cannot fail. */
    expect(new Set(slots.map((x) => x.key)).size).toBe(REGISTRY.length);
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
    /* TWO secrets, not one. The spec said this product held a single
       credential; `sync.credential` is a bearer token for the operator's own
       sync server, and it was invisible to the list whose job is to find
       exactly this. */
    expect(entriesOfKind("secret")).toHaveLength(2);
    expect(entriesOfKind("state")).toHaveLength(30);
    expect(REGISTRY).toHaveLength(42);
  });

  it("HAS NO `legacy` ENTRY, because neither candidate turned out to be one", () => {
    /* The kind stays in the type for a migration that really is dead one day.
       Both slots that wore the label read keys a current desk writes. */
    expect(entriesOfKind("legacy")).toEqual([]);
  });

  it("GIVES EVERY PREFERENCE A ROUTE INTO SETTINGS", () => {
    for (const e of entriesOfKind("preference")) {
      expect(e.coveredBy, `${e.label} names no setting that edits it`).toBeDefined();
    }
  });

  it("GIVES EVERY ENTRY A LABEL AND A SENTENCE SOMEBODY COULD READ", () => {
    for (const e of REGISTRY) {
      expect(e.label.length, `${e.key} has no label`).toBeGreaterThan(2);
      expect(e.what.length, `${e.key} does not say what it is`).toBeGreaterThan(12);
      expect(e.what, `${e.key} just restates its own name`).not.toBe(e.label);
    }
  });

  it("OFFERS NO ROUTE TO ANYTHING THAT IS NOT A PREFERENCE", () => {
    for (const kind of ["secret", "state"] as const) {
      for (const e of entriesOfKind(kind)) {
        expect(e.coveredBy, `${e.label} is ${kind} and claims a setting`).toBeUndefined();
      }
    }
  });
});

/* -------------------------------------------- the route into Settings -- */

/**
 * EVERY PREFERENCE REACHES SETTINGS, AND THE CONTROL IT REACHES IS ALIVE.
 *
 * The first version of this answered the first half only: the registry built a
 * control for each preference, so the count came out right and every one of
 * them was inert. Four of the five it existed for have an owner that is NOT
 * the store — the Risk desk's `config` signal, the learn store's `enabled`,
 * the Data desk's `setTopup` (which also starts a kernel job), and the shell's
 * own switch — so a store write moved nothing and would have been overwritten
 * by the owner. The planned fix, a revision counter so the control re-read its
 * own write, would have made it move ON SCREEN while the thing it configures
 * went on ignoring it: worse than the dead button, because it looks like it
 * worked.
 *
 * So these tests ask the two questions that mechanism cannot fake: does
 * `buildSettings` emit a definition for every registered preference, and does
 * writing one CHANGE WHAT IT READS BACK through the owner the stub holds.
 */
describe("Settings reaches every preference", () => {
  const built = (): SettingDef[] => buildSettings(stubDeps());
  const forKey = (defs: readonly SettingDef[], id: string): SettingDef | undefined =>
    defs.find((x) => x.id === id);

  it("NAMES, FOR EVERY PREFERENCE, A SETTING THAT REALLY EXISTS", () => {
    /* `coveredBy` is the whole link. A typo in it, or a definition later
       renamed, puts a preference back where it started — persisted, working
       and unreachable — and this is the only thing that would say so. */
    const ids = new Set(built().map((d) => d.id));
    for (const e of entriesOfKind("preference")) {
      expect(e.coveredBy, `${e.label} names no setting at all`).toBeDefined();
      const named = e.coveredBy as string;
      expect(ids.has(named), `${e.label} says ${named} edits it; no such setting`).toBe(true);
    }
  });

  it("REACHES THE FIVE IT COULD NOT", () => {
    const ids = new Set(built().map((d) => d.id));
    /* Keyed by the SLOT, so each row reads as the defect it fixes. */
    for (const [key, setting] of [
      ["risk.config", "account.dailyLoss"],
      ["learn.enabled", "privacy.record"],
      ["autosearch", "rules.autosearch"],
      ["library.budget-gb", "data.budget"],
      ["research.topup", "data.topup"],
    ] as const) {
      expect(ids.has(setting), `${key} is still unreachable`).toBe(true);
    }
  });

  it("GIVES EVERY CONTROL SOMETHING THAT HAPPENS WHEN IT IS USED", () => {
    /* `settings/ui.ts` renders an `action` as an enabled button whose handler
       is `def.write?.("")`, so an action without a write is a button that does
       nothing — which is how the governor's limits shipped. A `note` is the
       only kind that may have no write, because it is a sentence. */
    for (const d of built()) {
      if (d.control.kind === "note" || d.control.kind === "preview") continue;
      expect(d.write, `${d.id} is a ${d.control.kind} with no write`).toBeDefined();
    }
  });

  it("MOVES WHEN IT IS WRITTEN — every one of the five", () => {
    /* The test the revision counter would have passed and the product would
       have failed. It writes through the definition and reads back through the
       SAME definition, whose read goes to the owner the stub holds; a control
       wired to a second copy of the value cannot pass it. */
    const defs = built();
    for (const [id, next] of [
      ["account.dailyLoss", "7.5"],
      ["account.maxHeat", "12"],
      ["account.maxPositions", "9"],
      ["privacy.record", "false"],
      ["rules.autosearch", "false"],
      ["data.budget", "42"],
    ] as const) {
      const def = forKey(defs, id);
      expect(def, `${id} is not in Settings`).toBeDefined();
      expect(def?.read(), `${id} already reads the value under test`).not.toBe(next);
      def?.write?.(next);
      expect(def?.read(), `${id} did not change after being written`).toBe(next);
    }
  });

  it("SAYS WHY RATHER THAN READING A FIGURE IT CANNOT READ", () => {
    /* The five are OPTIONAL on `DefDeps` so a build that has not wired one
       still compiles. Unwired, the control is greyed WITH A REASON — the
       repository's own pattern — because a risk limit rendered as 0 is a limit
       that blocks every trade, with nothing on screen saying it was a guess. */
    const bare = buildSettings(
      stubDeps({
        riskGuards: undefined,
        setRiskGuard: undefined,
        recordClaims: undefined,
        setRecordClaims: undefined,
        autoSearch: undefined,
      }),
    );
    for (const id of [
      "account.dailyLoss",
      "account.maxHeat",
      "account.maxPositions",
      "privacy.record",
      "rules.autosearch",
    ]) {
      const def = bare.find((d) => d.id === id);
      expect(def?.unavailable?.(), `${id} reads a value it cannot read`).toBeTruthy();
    }
  });

  it("SAYS THE DISK BUDGET IS NOT ENFORCED, because nothing reads it", () => {
    /* `library.budget-gb` has no reader anywhere in the tree. A number that
       stores cleanly and changes nothing is the shape of a control people stop
       trusting, so the screen states which it is.

       IN THE HINT, AND THE SECOND ASSERTION IS THE POINT: `settings/ui.ts`
       disables a control whose `unavailable()` answers anything, so saying it
       there would grey out the only field that sets this — a worse version of
       the dead button. The caveat is about what the value DOES, not about
       whether it can be set. */
    const def = forKey(built(), "data.budget");
    expect(def?.hint, "the limitation is not stated anywhere the operator reads").toMatch(/nothing reads it/i);
    expect(def?.unavailable?.() ?? null, "a settable field was greyed out by its own caveat").toBeNull();
  });

  it("DECLARES NO ROUTE FOR A SECRET OR FOR ACCUMULATED STATE", () => {
    for (const e of [...entriesOfKind("secret"), ...entriesOfKind("state")]) {
      expect(e.coveredBy, `${e.label} is ${e.kind} and claims a setting`).toBeUndefined();
    }
  });

  it("HOLDS NO TWO DEFINITIONS OF ONE SETTING", () => {
    /* The previous version appended registry-derived definitions and silently
       dropped any whose id was taken, so a collision between two HAND-WRITTEN
       ones would have been swallowed by the same filter. Two owners of one
       setting is the defect this whole change exists to remove. */
    const seen = new Map<string, number>();
    for (const d of built()) seen.set(d.id, (seen.get(d.id) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });
});
