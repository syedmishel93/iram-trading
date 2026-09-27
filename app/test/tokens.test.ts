/**
 * EVERY `var(--x)` IN THE STYLESHEETS RESOLVES TO SOMETHING.
 *
 * WHY THIS EXISTS
 *
 * `--lh-relaxed` was read 38 times in `risk.css` and defined nowhere. A custom
 * property with no definition and no fallback makes the whole declaration
 * INVALID AT COMPUTED-VALUE TIME, which is not the same as being ignored: the
 * property takes its inherited value, so `line-height: var(--lh-relaxed)`
 * silently became "whatever the parent said". Thirty-eight prose blocks — every
 * refusal, every "why" note, the verdict lines — were typeset by accident.
 *
 * Nothing could have caught it. `tsc` does not read CSS, no test opened a
 * stylesheet, and the browser reports nothing: an undefined custom property is
 * legal CSS, and the result looks like a design decision. The same mechanism as
 * the nineteen Python test files in no list — a name nobody checks is a name
 * that can be wrong forever.
 *
 * WHAT IT DOES NOT CHECK: whether the value is sensible. That is a design
 * question. This only refuses a name that cannot resolve at all.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "src", "styles");
const SRC = join(__dirname, "..", "src");

/** `var(--x)` and `var(--x, fallback)` — the second is fine undefined. */
const USE = /var\(\s*(--[A-Za-z0-9-]+)\s*([,)])/g;
/** A definition: `--x:` at the start of a declaration. */
const DEF = /(^|[;{\s])(--[A-Za-z0-9-]+)\s*:/g;

/**
 * Custom properties the TYPESCRIPT sets inline, which a stylesheet may read.
 *
 * `quantdesk.ts` writes `style: "--f:0.37"` on each bar of a distribution and
 * `components.css` reads it to size the bar. That is a legitimate pattern — a
 * per-element value has nowhere else to live — so the audit has to look at both
 * sides, or it would report a working feature as broken and teach everyone to
 * ignore it.
 */
function setFromScript(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1] as string);
      }
    }
  };
  walk(SRC);
  return out;
}

function readAll(): { defined: Set<string>; used: Map<string, string[]> } {
  const defined = new Set<string>();
  const used = new Map<string, string[]>();
  const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));
  // AN AUDIT THAT PARSES NOTHING REPORTS SUCCESS. If the directory moved this
  // would pass while reading no CSS at all.
  expect(files.length).toBeGreaterThan(5);

  for (const n of setFromScript()) defined.add(n);

  for (const f of files) {
    const css = readFileSync(join(DIR, f), "utf8");
    for (const m of css.matchAll(DEF)) defined.add(m[2] as string);
    for (const m of css.matchAll(USE)) {
      // A `var(--x, something)` carries its own answer and is allowed.
      if (m[2] === ",") continue;
      const name = m[1] as string;
      const where = used.get(name) ?? [];
      where.push(f);
      used.set(name, where);
    }
  }
  return { defined, used };
}

describe("the palette has no dangling names", () => {
  it("defines every custom property the stylesheets read without a fallback", () => {
    const { defined, used } = readAll();
    expect(defined.size).toBeGreaterThan(50);
    expect(used.size).toBeGreaterThan(50);

    const missing = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, files]) => `${name} (read in ${[...new Set(files)].join(", ")})`);

    // Named rather than counted: a count tells you something broke and a name
    // tells you what, and this is the report somebody will read at 2am.
    expect(missing).toEqual([]);
  });
});
