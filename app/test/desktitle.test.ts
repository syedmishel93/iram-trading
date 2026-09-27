/**
 * TWO KINDS OF TITLE, AND THE FACE THAT TELLS THEM APART.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS FILE EXISTS BECAUSE A "CONSISTENCY" PASS WAS WRONG
 *
 * A sweep of the desks reported "nine desk titles in the body face while the
 * rest are in the display one" and moved them all into one rule. MEASURED
 * afterwards, that finding was false, and the change broke something real:
 *
 *   `.view-title`  holds a desk's NAME — "Signals", "Playbook", "Watchlist",
 *                  "Simulation", "Smart money". Nine of them.
 *   `.strat-title`, `.td-title`, `.rv-title`, `.sys-title` hold a SENTENCE —
 *                  "The AI studies your trades. You decide what's true.",
 *                  "What this machine holds, and what it is doing."
 *
 * `tokens.css` states the rule the product was already keeping: `--font-serif`
 * is "the answer face — for a line that IS an answer, at 400 only". A sentence
 * a desk says on its own account is set in it; a label naming a desk is not.
 * That is a distinction, not a drift, and the pass that unified them moved the
 * System desk's title to sans and erased it.
 *
 * So this pins the system that EXISTS: the face follows the KIND of title. It is
 * the third redesign in this repository overturned by measuring the thing first,
 * after the Watchlist's heatmap and the Calculator's columns.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS A REAL DEFECT, AND IS GUARDED BELOW
 *
 * A measure narrower than the text it exists to set. `.strat-title` was 44ch
 * around a 70-character headline and `.sys-title` 34ch around a 46-character
 * one, so both wrapped their last words onto a second line with the rest of a
 * 1480px desk empty beside them — a line break nobody chose, at the top of the
 * screen you open to run a backtest.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src", "styles");
const UI = join(process.cwd(), "src", "ui");

/** Comments stripped: a class named in prose is not a class in a rule. */
const read = (f: string): string =>
  readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * EVERY stylesheet, read from the directory.
 *
 * A hand-written list of six missed `briefing.css` and `review.css`, which hold
 * two of the answer-face titles — so the first run found 2 where there are 5 and
 * would have gone on missing any sheet added later. This project already records
 * what a drifting list costs: `tests/run_tests.sh` carried its own copy of the
 * python tiers and had drifted by five files.
 */
const SHEETS = readdirSync(DIR).filter((f) => f.endsWith(".css"));

/** Every `class: "<x>-title", text: "..."` pair, from the modules themselves. */
function titlesInUse(): { cls: string; text: string; file: string }[] {
  const out: { cls: string; text: string; file: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/class:\s*"([a-z-]*title)"\s*,\s*text:\s*"([^"]{6,})"/g)) {
        out.push({ cls: m[1] ?? "", text: m[2] ?? "", file: e.name });
      }
    }
  };
  walk(UI);
  return out;
}

/** Title classes that ask for the answer face. */
function serifTitles(): Set<string> {
  const out = new Set<string>();
  for (const f of SHEETS) {
    let css: string;
    try { css = read(f); } catch { continue; }
    for (const m of css.matchAll(/\.([a-z-]*title)\s*\{([^}]*)\}/g)) {
      if (/font-family:\s*var\(--font-serif\)/.test(m[2] ?? "")) out.add(m[1] ?? "");
    }
  }
  return out;
}

describe("a title's measure must hold the title", () => {
  it("NO TITLE IS CAPPED NARROWER THAN ITS OWN TEXT", () => {
    /* PINS THE RELATIONSHIP, NOT A NUMBER. A measure is fine at any width that
       holds what it sets and wrong when it is narrower. A fixed "must be 76ch"
       would pass on a title nobody can read and fail on a good 60ch one. */
    const used = titlesInUse();
    expect(used.length, "no titles found — the pattern has stopped matching").toBeGreaterThan(3);

    const caps = new Map<string, number>();
    for (const f of SHEETS) {
      let css: string;
      try { css = read(f); } catch { continue; }
      for (const m of css.matchAll(/\.([a-z-]*title)\s*\{([^}]*)\}/g)) {
        const ch = (m[2] ?? "").match(/max-width:\s*(\d+)ch/);
        if (ch) caps.set(m[1] ?? "", Number(ch[1]));
      }
    }

    const tooTight: string[] = [];
    for (const { cls, text, file } of used) {
      const cap = caps.get(cls);
      if (cap !== undefined && text.length > cap) {
        tooTight.push(`${file}: .${cls} is ${cap}ch but sets ${text.length} characters`);
      }
    }
    expect(tooTight, "these wrap for want of a wider measure").toEqual([]);
  });
});

describe("the face says which kind of title it is", () => {
  /** A hero line: it ends in a full stop, or carries a clause. */
  const isSentence = (t: string): boolean => /\.\s*$/.test(t) || t.includes(", ");

  it("THE ANSWER FACE IS IN USE, so the distinction is a real one", () => {
    /* A COUNT, NOT A COPY CHECK. The first version of this asserted that every
       answer-face title READS as a sentence, by regex — and flagged
       "Reading the chart…", a live status line that ends in an ellipsis rather
       than a full stop. Classifying prose with a pattern produces exactly that:
       a false positive, then an allowlist, then a test nobody trusts. What is
       worth pinning is that the two tiers both exist; which tier a given line
       belongs to is a judgement a person makes when they write it. */
    expect(serifTitles().size, "the answer face should be in use").toBeGreaterThan(2);
  });

  it("A DESK NAME IS NOT, so the two stay tellable apart", () => {
    /* "Signals", "Playbook", "Watchlist" are labels. Setting them in the answer
       face would make every heading look like a statement and none of them read
       as one. */
    const named = titlesInUse().filter((t) => t.cls === "view-title");
    expect(named.length, "view-title should still be naming desks").toBeGreaterThan(3);
    for (const { text } of named) expect(isSentence(text), text).toBe(false);
    expect(serifTitles().has("view-title"), "desk names must not take the answer face").toBe(false);
  });
});
