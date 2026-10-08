/**
 * ONE OWNER FOR A DESK'S DISPLAY NAME.
 *
 * A desk's name was written in up to three places: `VIEWS` holds it, fifteen
 * desk modules render it again as a string literal, and other desks name it a
 * third time when they link to it. Two owners for one fact drift, and nothing
 * fails — MEASURED before this guard existed, two desks already disagreed with
 * their own tabs:
 *
 *   `calculator`  tab said "Calculator"  · its heading said "Trade calculator"
 *   `survey`      tab said "Conditions"  · its heading said "Condition survey"
 *
 * Neither was red. That is the whole argument for `deskLabel`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VIEWS, VIEW_IDS, deskLabel, type ViewId } from "../src/ui/shell/views";

/* ------------------------------------------------------------- the scanner -- */

/**
 * `fileURLToPath`, not `new URL(...).pathname`.
 *
 * This checkout lives under "DOWNLOADS FOLDER COPY/IRAM TRADING", and a URL
 * percent-encodes those spaces — so `.pathname` hands `readdirSync` a
 * directory called `DOWNLOADS%20FOLDER%20COPY` and the scan dies with ENOENT.
 * Caught on the first run, which is the only reason this comment exists rather
 * than a guard that reads zero files on anybody whose path has a space in it.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The one file allowed to hold a desk's name: it is the owner. */
const OWNER = "ui/shell/views.ts";

/**
 * THE SAME WORD, A DIFFERENT THING.
 *
 * A sweep for a defect class is mostly false positives, and an allowlist
 * without a reason per entry is a way to silence a tool rather than answer it.
 * Each of these is checked by `HAS NO STALE ALLOWLIST ENTRY` below, so an
 * exemption that stops matching fails the build instead of quietly weakening
 * the guard for ever.
 */
export const DESK_LABEL_ALLOWLIST: readonly { file: string; text: string; why: string }[] = [
  {
    file: "ui/playbook.ts",
    text: "Strategy",
    why: "a sub-heading above the picker for the strategy being edited — the noun, not the desk it would link to",
  },
  {
    file: "ui/strategy/flow.ts",
    text: "Simulation",
    why: "a panel heading over simulation output inside the Strategy desk — the noun, not the desk",
  },
  {
    file: "settings/ui.ts",
    text: "Chart",
    why: "a MOCKUP of the command bar drawn inside the settings preview — its siblings are pills reading 'Find' and 'Decide', which are not desks either",
  },
  {
    file: "ui/calculator.ts",
    text: "Chart",
    why: "a button meaning 'use the instrument currently on the chart', as its own title says — it names the surface it reads from, not a desk to navigate to",
  },
  {
    file: "ui/screener.ts",
    text: "Chart",
    why: "the same 'use what the chart is showing' button as the calculator's, naming the source of a symbol rather than a destination",
  },
];

/** Every `.ts` under `app/src`, except the owner itself. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith(".ts") && !relative(SRC, p).split(/[\\/]/).join("/").endsWith(OWNER)) out.push(p);
  }
  return out;
}

/**
 * Comments and template literals removed; double-quoted strings KEPT.
 *
 * Strip prose, not literals, when the thing you seek IS a literal — this
 * codebase has two recorded cases of a guard that stripped every string and
 * then could not find the string it existed for. Comments go because a
 * sentence mentioning a desk is not a second owner of its name.
 */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, (m) => m.replace(/[^\n]/g, " "));
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `label` is RENDERED as a desk's name in `src` — a `text:` property.
 *
 * NARROWED FROM "ANY LITERAL", AND THE FIRST RUN IS WHY. Scanning every
 * double-quoted string reported 39+ sites, almost all of them ordinary English
 * that happens to also be a desk label: `group: "Chart"` thirteen times in the
 * command palette, `"Data"` and `"System"` as settings sections. Those are a
 * DIFFERENT VOCABULARY — a command's category and a settings heading are not a
 * desk's name — and an allowlist of forty entries is a way to silence a tool
 * rather than answer it.
 *
 * `text:` is where a name is drawn for somebody to read, which is exactly the
 * drift this guard was written for: `calculator` rendering "Trade calculator"
 * under a tab reading "Calculator".
 *
 * Whole-string, not substring: once `results` is called "Test results", a
 * guard looking for the bare word "Results" would flag the very rename it
 * exists to protect.
 */
export function hitsIn(src: string, label: string): number[] {
  return findLabels(src, [label]).map((h) => h.line);
}

/**
 * Every `text: "<one of labels>"` in `src`, as {line, label}.
 *
 * ONE ALTERNATION, NOT ONE PASS PER LABEL. The first version ran 27 regexes
 * over each of ~400 files — 10,800 passes, 3.4 seconds — and that was enough
 * to push itself AND an unrelated neighbour past vitest's 5s default once the
 * suite ran them in parallel. `opportunity.test.ts` timed out beside it while
 * passing alone on both branches. A guard that makes other tests flaky is a
 * guard people will delete.
 *
 * It is also the single owner of the matching rule, so `hitsIn` and the bulk
 * scan cannot disagree about what counts as a hit.
 */
function findLabels(src: string, labels: readonly string[]): { line: number; label: string }[] {
  if (labels.length === 0) return [];
  const body = `text:\\s*"(${labels.map(esc).join("|")})"`;

  /* A CHEAP PROBE BEFORE THE EXPENSIVE WORK. `strip` runs three global regexes
     over every file, and the files here are deliberately comment-heavy — some
     are roughly half prose — so stripping all ~400 of them cost enough CPU to
     push an UNRELATED test past vitest's 5s timeout when the suite ran them in
     parallel. Measured: green on main, `opportunity.test.ts` timing out on this
     branch, and passing alone on both.

     Most files mention no desk name at all, so one test against the raw source
     skips the stripping entirely. A hit inside a comment makes the probe answer
     yes for a file that turns out clean — that costs one wasted strip and
     changes no result, because the real scan still runs on stripped text. */
  if (!new RegExp(body).test(src)) return [];

  const re = new RegExp(body, "g");
  const out: { line: number; label: string }[] = [];
  const lines = strip(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i] as string)) !== null) {
      out.push({ line: i + 1, label: m[1] as string });
    }
  }
  return out;
}

export function hitsInFile(rel: string, label: string): number[] {
  return hitsIn(readFileSync(join(SRC, rel), "utf-8"), label);
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * MEMOISED, because the scan reads every source file and two tests need it.
 *
 * Unmemoised it ran twice at ~3.4s and ~2.9s against vitest's 5s default, and
 * the pair failed intermittently under load — observed once as "2 failed" and
 * once as "10 passed" with no edit in between. A guard that fails at random is
 * worse than no guard: it teaches people to re-run until it is green.
 */
let CACHED: { offenders: Offender[]; filesRead: number; labelsSought: number } | null = null;

function scan(): { offenders: Offender[]; filesRead: number; labelsSought: number } {
  if (CACHED === null) CACHED = scanOnce();
  return CACHED;
}

function scanOnce(): { offenders: Offender[]; filesRead: number; labelsSought: number } {
  const files = sourceFiles();
  const labels = VIEWS.map((v) => v.label);
  const offenders: Offender[] = [];
  for (const abs of files) {
    const rel = relative(SRC, abs).split(/[\\/]/).join("/");
    for (const hit of findLabels(readFileSync(abs, "utf-8"), labels)) {
      const allowed = DESK_LABEL_ALLOWLIST.some((a) => a.file === rel && a.text === hit.label);
      if (!allowed) offenders.push({ file: rel, line: hit.line, text: hit.label });
    }
  }
  return { offenders, filesRead: files.length, labelsSought: labels.length };
}

/* ----------------------------------------------------------------- tests -- */

describe("deskLabel", () => {
  it("returns the label VIEWS holds, for every desk", () => {
    for (const v of VIEWS) expect(deskLabel(v.id)).toBe(v.label);
  });

  it("COVERS EVERY DESK — a lookup that answered for some would be worse than none", () => {
    expect(VIEWS.length).toBe(27);
    for (const v of VIEWS) expect(deskLabel(v.id).length).toBeGreaterThan(0);
  });

  it("knows every id, so a persisted desk can be checked before it is used", () => {
    /* A desk whose module is gone still type-checks, because `VIEWS` still
       lists it. `VIEW_IDS` is what a runtime caller — one reading a desk id
       out of saved preferences — checks against. */
    expect(VIEW_IDS.size).toBe(VIEWS.length);
    expect(VIEW_IDS.has("screener")).toBe(true);
    expect(VIEW_IDS.has("not-a-desk")).toBe(false);
  });

  it("types the id, so an unknown desk cannot reach the renderer", () => {
    /* THE SAFETY ARGUMENT, PINNED. A `deskLabel(id: string)` that threw on an
       unknown id would throw inside a render effect — which `core/signal.ts`
       catches and logs to `window.__signalErrors`, leaving the section blank
       with nothing on screen to say why. A literal union moves the error to
       `tsc`, where it cannot be swallowed.

       `@ts-expect-error` FAILS THE BUILD IF THE LINE STOPS BEING AN ERROR, so
       this asserts the type is narrow rather than merely documenting it. */
    // @ts-expect-error — "not-a-desk" is not a ViewId
    const bad: string = deskLabel("not-a-desk");
    expect(typeof bad).toBe("undefined");

    const good: ViewId = "screener";
    expect(deskLabel(good)).toBe(deskLabel("screener"));
  });
});

describe("the guard: one owner, enforced", () => {
  it("NO DESK MODULE WRITES A DESK NAME AS A LITERAL", () => {
    const { offenders } = scan();
    expect(
      offenders,
      `\n${offenders.map((o) => `  ${o.file}:${o.line}  "${o.text}"`).join("\n")}\n`,
    ).toEqual([]);
  });

  it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
    /* An audit whose pattern has stopped matching reports a clean tree. Four
       audits in this repository have done exactly that; one of them was the
       tool written to find the others. */
    const { filesRead, labelsSought } = scan();
    expect(filesRead, "the scanner read no source files").toBeGreaterThan(50);
    expect(labelsSought).toBe(VIEWS.length);
  });

  it("MATCHES WHOLE LABELS ONLY", () => {
    /* "Results" must not match inside "Test results", or the guard flags the
       very rename it exists to protect. */
    expect(hitsIn(`text: "Test results"`, "Results")).toEqual([]);
    expect(hitsIn(`text: "Results"`, "Results")).toEqual([1]);
  });

  it("SURVIVES A LABEL WITH REGEX CHARACTERS IN IT", () => {
    /* Labels are data. A future one carrying ( . | must not make the pattern
       match everything, or throw while building it. */
    expect(() => hitsIn(`text: "a.b"`, "a.b")).not.toThrow();
    expect(hitsIn(`text: "axb"`, "a.b")).toEqual([]);
    expect(hitsIn(`text: "a.b"`, "a.b")).toEqual([1]);
  });

  it("IGNORES COMMENTS, because a sentence is not a second owner", () => {
    expect(hitsIn(`// the "Watchlist" desk\nconst a = 1;`, "Watchlist")).toEqual([]);
    expect(hitsIn(`/* see "Watchlist" */\nconst a = 1;`, "Watchlist")).toEqual([]);
  });

  it("HAS NO STALE ALLOWLIST ENTRY", () => {
    /* An exemption that matches nothing weakens the guard silently and for
       ever — the allowlist is answered, not trusted. */
    for (const e of DESK_LABEL_ALLOWLIST) {
      expect(
        hitsInFile(e.file, e.text).length,
        `allowlisted "${e.text}" no longer appears in ${e.file}`,
      ).toBeGreaterThan(0);
      expect(e.why.length, `${e.file} exemption has no reason`).toBeGreaterThan(20);
    }
  });
});
