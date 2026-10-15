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

  /* THE FOUR BELOW APPEARED WHEN THE DESKS WERE RENAMED, and they are the
     cost of naming a desk after a word the domain already uses. Each is the
     NOUN in its own context, and two of them are worth the operator knowing
     about rather than being quietly suppressed — see the notes. */
  {
    file: "ui/screener.ts",
    text: "Correlation",
    why: "a stat row inside the screener's reasoning panel, labelling the correlation it measured — the quantity, not the desk that charts them",
  },
  {
    file: "ui/shell.ts",
    text: "Track record",
    why: "the chart toolbar pill that toggles the claims overlay; it shares the word with the desk ON PURPOSE, because both answer 'did what this machine said work out' — one on the chart, one as a page",
  },
  {
    file: "ui/strategy.ts",
    text: "Walk-forward",
    why: "the Strategy desk's own walk-forward panel — the TECHNIQUE. It now shares a name with the simulation desk, which is a real ambiguity the owner should weigh, not a drift this guard can fix",
  },
  {
    file: "ui/studypanel.ts",
    text: "Studies",
    why: "the chart's indicator panel. In charting 'studies' MEANS indicators — thinkorswim's own term — so the study desk's new name collides with an established sense already in use here. Flagged to the owner; allowlisted so the collision is recorded rather than hidden",
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

describe("the names themselves", () => {
  it("names every desk a word a trader would type", () => {
    /* A command palette can only find what you can name. Measured before this:
       roughly 7 of 27 labels were words a trader would search for, and the
       rest — "Opportunities", "Decision", "Conditions", "Connections",
       "Knowledge", "Survey", "Simulation", "Learning" — were internal
       concepts. */
    const expected: Record<string, string> = {
      screener: "Scanner",
      decision: "Confluence",
      flow: "Derivatives",
      agent: "Ask AI",
      study: "Studies",
      knowledge: "Edge stats",
      survey: "Market regime",
      connections: "Correlation",
      strategy: "Strategy tester",
      signals: "Alerts",
      results: "Test results",
      simulation: "Walk-forward",
      learn: "Track record",
      workspace: "Layouts",
      paper: "Paper trading",
    };
    for (const [id, label] of Object.entries(expected)) {
      expect(deskLabel(id as ViewId), id).toBe(label);
    }
  });

  it("LEAVES THE TWELVE THAT WERE ALREADY RIGHT", () => {
    for (const [id, label] of Object.entries({
      briefing: "Briefing",
      watchlist: "Watchlist",
      chart: "Chart",
      smart: "Smart money",
      sessions: "Sessions",
      risk: "Risk",
      calculator: "Calculator",
      quant: "Quant",
      playbook: "Playbook",
      data: "Data",
      journal: "Journal",
      system: "System",
    })) {
      expect(deskLabel(id as ViewId), id).toBe(label);
    }
  });

  it("NEVER CHANGES AN ID — they are persisted, and a changed one is a blank desk", () => {
    /* The active desk and every saved layout store the id string. Rename one
       and the operator is dropped onto a fallback with nothing on screen to
       say why. The labels above may move; this list may not. */
    expect(VIEWS.map((v) => v.id).sort()).toEqual([
      "agent", "briefing", "calculator", "chart", "connections", "data", "decision",
      "flow", "journal", "knowledge", "learn", "paper", "playbook", "quant", "results",
      "risk", "screener", "sessions", "signals", "simulation", "smart", "strategy",
      "study", "survey", "system", "watchlist", "workspace",
    ]);
  });

  it("GIVES NO DESK THE SAME NAME AS ITS GROUP, bar the one that earns it", () => {
    /* `study` was approved as "Research" and a GROUP is already called
       Research, so the All tools menu would have read "Research › Research" —
       a desk looking like a duplicate of its own heading. The group cannot
       move here; regrouping is stage 2's job. Hence "Studies".

       `chart` IS ALLOWED TO, and running this rule found that out: it has
       shared its group's name since long before any of this. The difference is
       whether the desk is the group's centrepiece. "Chart › Chart" reads as the
       obvious entry to the Chart group; "Research › Research" would have read
       as a heading printed twice. A rule that cannot tell those apart would
       have renamed a desk nobody asked to rename. */
    const EARNED = new Set(["chart"]);
    for (const v of VIEWS) {
      if (EARNED.has(v.id)) continue;
      expect(v.label, `${v.id} is named after its own group`).not.toBe(v.group);
    }
    for (const id of EARNED) {
      const v = VIEWS.find((x) => x.id === id);
      expect(v?.label, `${id} is exempted but no longer matches its group`).toBe(v?.group);
    }
  });
});

describe("a link to a desk, in the source", () => {
  it("NAMES NO DESK BY HAND WHERE IT NAVIGATES", () => {
    /* `shell/decision.ts` raises toasts whose action both NAMES a desk and
       opens it. Those two sites are the only `label:` literals in that file,
       so the rule can be exact there without the allowlist a project-wide
       `label:` sweep would need — 25 of those sites are a command's section
       or a settings heading, which is a different vocabulary from a desk's
       name. The DOM half of this lives in `desklink.test.ts`. */
    const src = readFileSync(join(SRC, "ui/shell/decision.ts"), "utf-8");
    const offenders = VIEWS.filter((v) => new RegExp(`label:\\s*"${esc(v.label)}"`).test(src));
    expect(offenders.map((v) => v.label)).toEqual([]);
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

/* ------------------------------------------------------- the old names -- */

/**
 * WHAT EACH DESK USED TO BE CALLED, as data.
 *
 * Taken from the rename commit's own diff of `ui/shell/views.ts`, not retyped
 * from memory. The guard above asks "does any module write a CURRENT label by
 * hand"; this asks the question the rename actually got wrong — does any
 * sentence still use an OLD one. Eleven did, and both existing guards were
 * structurally unable to see them: one matches `text: "<exact label>"`, and the
 * other's `label:` sweep was scoped to a single file.
 *
 * The one the owner would have met first was the watch rail's empty state:
 * "Add symbols from Opportunities or with the palette", on a desk that has not
 * been called Opportunities since the rename.
 */
const RETIRED: ReadonlyArray<{ was: string; now: string }> = [
  { was: "Opportunities", now: "Scanner" },
  { was: "Decision", now: "Confluence" },
  { was: "Flow", now: "Derivatives" },
  { was: "Paper", now: "Paper trading" },
  { was: "Analyst", now: "Ask AI" },
  { was: "Analyse", now: "Studies" },
  { was: "Knowledge", now: "Edge stats" },
  { was: "Conditions", now: "Market regime" },
  { was: "Connections", now: "Correlation" },
  { was: "Strategy", now: "Strategy tester" },
  { was: "Signals", now: "Alerts" },
  { was: "Results", now: "Test results" },
  { was: "Simulation", now: "Walk-forward" },
  { was: "Learning", now: "Track record" },
  { was: "Workspace", now: "Layouts" },
];

/**
 * THE SAME WORD, ORDINARY ENGLISH.
 *
 * Six of the fifteen retired labels are everyday nouns and three of those are a
 * PREFIX OF THEIR OWN REPLACEMENT — "Strategy tester" contains "Strategy" — so
 * a bare sweep would have reported the fix as the defect. Every exemption names
 * the exact text and says why, and `HAS NO STALE RETIRED EXEMPTION` fails when
 * one stops matching, so an exemption cannot outlive the string it was written
 * for.
 */
const ALLOWED: ReadonlyArray<{ text: string; why: string }> = [
  {
    text: "Analyst",
    why: "a LAYOUT PRESET's name in settings/presets.ts, and its id is persisted. The blurb is about the rail and the inspector, not about the desk",
  },
  {
    text: "Strategy draft",
    why: "a draft STRATEGY — the noun, not the desk. The slot holds a rule set somebody was part way through building",
  },
  {
    text: "Paper trades",
    why: "paper trading is the activity's ordinary name and predates the desk being called it",
  },
  {
    text: "Strategy",
    why: "the Playbook's section heading for choosing a rule set. It names the thing being chosen, not a place to go",
  },
  {
    text: "Simulation",
    why: "a STEP in the Strategy flow (data-step=\"simulation\"), which is the activity. The desk now called Walk-forward is a different surface",
  },
  {
    text: "Decision support only. Positioning data describes what the crowd has done, not what price will do next.",
    why: "\"decision support\" is the standing phrase this product uses to say it does not trade for you",
  },
  {
    text: "How much, and whether that is inside the rules you set. Decision support: it reports, it never trades.",
    why: "as above — the Risk desk's own subtitle",
  },
  {
    text: "Decision support only. Nothing here is a recommendation, and nothing here places an order.",
    why: "as above — the Scanner's footer",
  },
];

/** Every visible string in the tree, with where it is. */
function visibleStrings(): Array<{ file: string; line: number; text: string }> {
  /* EVERY STRING LITERAL, AND THE WIDENING IS THE POINT.

     This matched `text:`/`label:`/`title:` properties holding a double-quoted
     string, found eleven stale names and reported the class closed. It was
     not: TWELVE more survived, each in a shape the regex could not reach — a
     ternary arm, a TEMPLATE LITERAL, and a function argument
     (`pkEmpty("empty", "…the Signals desk.")`) — and one of them sat in a
     NOTIFICATION the operator reads outside the app. Matching a property name
     is a shape, not the question, which is the same mistake as the two guards
     this one replaced.

     `strip` is deliberately NOT used here: it blanks template literals, which
     is right for finding a desk name written as a value and wrong for finding
     one written in a sentence. Comments are still dropped, with their
     newlines kept so the line numbers stay true — a tool that reports the
     wrong location is worse than one that reports nothing. */
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const abs of sourceFiles()) {
    const rel = relative(SRC, abs).split(/[\\/]/).join("/");
    const body = readFileSync(abs, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
      m.replace(/[^\n]/g, " "),
    );
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i] as string)) !== null) {
        const text = m[1] ?? m[2] ?? m[3] ?? "";
        if (text.length >= 3) out.push({ file: rel, line: i + 1, text });
      }
    }
  }
  return out;
}

describe("a desk's OLD name, in the source", () => {
  const strings = visibleStrings();
  const allowed = new Set(ALLOWED.map((a) => a.text));

  /**
   * A STRING THAT SENDS YOU SOMEWHERE, not a string that happens to share a word.
   *
   * Matching the bare word over every literal reported twenty-five findings and
   * most were ordinary English — "Conditions", "Results", "Analyse the book",
   * "Paper trade it". A checker whose normal state is twenty-five findings is
   * one people learn to ignore, and this repository already records that.
   *
   * What is actually wrong is a sentence that tells the operator to GO
   * somewhere by a name that no longer exists. Both shapes it takes, measured
   * against the twelve real ones that escaped the first guard:
   *
   *   "<Retired> desk"   twelve of the thirteen
   *   "Open <Retired>"   the thirteenth, "Open Opportunities to scan your list"
   *
   * Narrow enough to act on, and it reaches into template literals and
   * function arguments, which is where the twelve were hiding.
   */
  const sendsYouThere = (text: string, was: string): boolean =>
    new RegExp(`\\b${esc(was)}\\s+desk\\b`).test(text) ||
    /* A VERB OR A PREPOSITION IN FRONT OF IT. "Open Opportunities to scan your
       list" has no "desk" in it, and neither does "Rescan on Opportunities" —
       which was sitting one line above it in the same file, and which the
       first version of this rule still missed after it had been widened once.
       The preposition is what turns a word into a destination. */
    new RegExp(`\\b(?:Open|open|on|from|in|to|at)\\s+(?:the\\s+)?${esc(was)}\\b`).test(text);

  const stale = strings.filter((s) =>
    RETIRED.some(
      ({ was, now }) =>
        sendsYouThere(s.text, was) &&
        /* "Strategy tester desk" contains "Strategy": the replacement being
           present means the string was already brought up to date. */
        !new RegExp(`\\b${esc(now)}\\b`).test(s.text) &&
        !allowed.has(s.text),
    ),
  );

  it("PRINTS WHAT IT PARSED, and fails on a zero", () => {
    /* An audit script that parses nothing reports success — the defect this
       repository has now recorded in three separate checkers, including one
       written to find defects. */
    expect(sourceFiles().length).toBeGreaterThan(200);
    expect(strings.length, "read no visible strings at all").toBeGreaterThan(1000);
  });

  it("NAMES NO DESK BY A NAME IT NO LONGER HAS", () => {
    expect(
      stale.map((s) => `${s.file}:${s.line}  ${s.text.slice(0, 90)}`),
      "a visible string still uses a retired desk name",
    ).toEqual([]);
  });

  it("SEES A SENTENCE, not only an exact label", () => {
    /* The reason the eleven survived: `text: "<exact label>"` cannot match
       "Open the Signals desk". Proved against a synthetic line rather than by
       reading the regex, because a guard whose own claim is untested is the
       thing it exists to prevent. */
    const re = /\b(?:text|label|title|detail|placeholder|hint|aria-label)\s*:\s*"((?:[^"\\]|\\.)*)"/;
    const m = re.exec('h("button", { text: "Open the Signals desk" })');
    expect(m?.[1]).toBe("Open the Signals desk");
    expect(new RegExp("\\bSignals\\b").test(m?.[1] ?? "")).toBe(true);
  });

  it("HAS NO STALE RETIRED EXEMPTION", () => {
    /* An exemption that no longer matches anything is a weakening of the guard
       that nobody can see. */
    const present = new Set(strings.map((s) => s.text));
    for (const a of ALLOWED) {
      expect(present.has(a.text), `nothing says "${a.text}" any more — drop the exemption`).toBe(true);
    }
  });

  it("GIVES EVERY EXEMPTION A REASON", () => {
    for (const a of ALLOWED) expect(a.why.length, `${a.text} is exempt for no stated reason`).toBeGreaterThan(30);
  });

  it("KEEPS EVERY RETIRED NAME PAIRED WITH A LABEL VIEWS REALLY HOLDS", () => {
    /* Otherwise the list rots: a `now` that no desk is called means the
       superseded-in-place exception stops firing and the guard starts
       reporting correct strings. */
    const labels = new Set(VIEWS.map((v) => v.label));
    for (const r of RETIRED) {
      expect(labels.has(r.now), `${r.was} is said to be ${r.now}; no desk is called that`).toBe(true);
      expect(labels.has(r.was), `${r.was} is still a live desk name`).toBe(false);
    }
  });
});
