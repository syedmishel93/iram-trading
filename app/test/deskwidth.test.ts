/**
 * EVERY DESK FILLS ITS COLUMN — `styles/components.css`, `.view-slot > *`.
 *
 * MEASURED IN THE BROWSER AT 1920. The Journal rendered **897px inside an
 * 1898px slot — 47% of the screen, 1,001 pixels of nothing either side** — and
 * so did Strategy, Conditions and Signals. Four desks, one of them the main
 * backtesting screen, spending half the display on margin.
 *
 * THE CAUSE WAS A FIX FOR SOMETHING ELSE. `.view-slot` is `place-items:
 * stretch`, so a desk should fill its column up to the 1480px reading measure.
 * But a grid item with an AUTO margin in an axis STOPS STRETCHING in that axis:
 * the auto margins absorb the free space and the item sizes to fit-content
 * instead. Adding `margin-inline: auto` to centre the capped column silently
 * turned the stretching off.
 *
 * IT WAS INVISIBLE BECAUSE MOST DESKS WERE UNAFFECTED. `.dd`, `.screener` and
 * `.flow` each carry `width: 100%` of their own; `.desk`, `.view` and
 * `.journal-desk` do not. So the defect hid on three root classes out of six —
 * which is the same shape as the cap itself, which covered `.dd` alone for a
 * release while the Journal went on stretching to 1796px.
 *
 * THE TEST THAT MATTERS IS `the three go together`. Any one of them alone is a
 * different layout, and it is the PAIR max-width + margin-inline that silently
 * disables the stretch — so the rule that carries those two must carry the
 * third.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src", "styles");

/**
 * THE COMMENTS ARE STRIPPED FIRST, and this test needed it more than most.
 *
 * Its first version matched the raw file and PASSED with the declaration
 * deleted — because the explanatory comment inside the very rule it guards
 * contains the words `width: 100%` while explaining which classes already carry
 * one. A guard that reads its own documentation is a guard that can never fail.
 *
 * CLAUDE.md states the rule as the first thing under Working style: strip
 * comments before counting anything, because these files carry long
 * explanatory prose by design and a grep over them over-reports by about a
 * third. Proven here by deleting the fix and watching this go red.
 */
const raw = readFileSync(join(DIR, "components.css"), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the LAST `.view-slot > *` rule that sets a cap. */
function capRule(): string {
  const blocks = [...css.matchAll(/\.view-slot\s*>\s*\*\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  const withCap = blocks.filter((b) => /max-width/.test(b));
  expect(withCap.length, "exactly one rule should carry the reading measure").toBe(1);
  return withCap[0] ?? "";
}

describe("the desk column", () => {
  it("THE THREE GO TOGETHER: a cap, centring, and a width", () => {
    /* `max-width` alone left the Journal at 1796px. Adding `margin-inline: auto`
       to centre it took it to 897. Only all three give a desk that fills its
       column up to the measure and sits in the middle of what is left. */
    const rule = capRule();
    expect(rule, "the dashboard measure").toMatch(/max-width:\s*1800px/);
    expect(rule, "centred, not left-aligned").toMatch(/margin-inline:\s*auto/);
    expect(rule, "WITHOUT THIS the auto margin cancels the container's stretch").toMatch(
      /width:\s*100%/,
    );
  });

  it("the rule lives on the CONTAINER'S CHILDREN, not on one desk class", () => {
    /* Six root classes are in use — `.dd`, `.desk`, `.view`, `.screener`,
       `.flow`, `.journal-desk` — and this project has already paid twice for a
       layout law applied to one of them: the cap covered `.dd` alone for a
       release, and the stretch covered `.dd`, `.screener` and `.flow` for
       another. Setting it on every desk at once is what stops there being a
       seventh that misses it. */
    expect(css).toMatch(/\.view-slot\s*>\s*\*\s*\{[^}]*width:\s*100%/);
  });

  it("nothing sets a competing width on the slot's children afterwards", () => {
    // A later `width: fit-content` or `max-content` on a desk root would
    // reinstate the shrink for that desk alone, which is how this hid before.
    const afterCap = css.slice(css.indexOf("max-width: 1480px"));
    expect(afterCap).not.toMatch(/\.view-slot\s*>\s*\*\s*\{[^}]*width:\s*(fit-content|max-content|auto)/);
  });
});

describe("the Strategy desk's conversation is a rail", () => {
  /* MEASURED at 1534: the conversation card is 134px tall beside a 1,017px stack
     of rules, backtest, simulation and decision — 883px of imbalance. The empty
     space under it is what reads as a hole, but the hole is the symptom: the
     real cost is that the card you TALK to scrolled away while you read the
     results it produced.

     PROVED IN THE BROWSER by scrolling, which is the only way a sticky claim can
     be checked: the stack went 262 -> -238 while the rail went 262 -> 133 and
     held. */

  const strat = readFileSync(join(DIR, "strategy.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  function railRule(): string {
    const m = strat.match(/\.strat-chat-card\s*\{([^}]*)\}/);
    expect(m, "the conversation card should carry the rail rule").toBeTruthy();
    return m?.[1] ?? "";
  }

  it("STICKS, AND DECLARES align-self: start", () => {
    /* The pattern this copies documents why: a grid stretches its item to the
       row height by default, and a sticky element as tall as its own scroller
       can never move relative to it. `.strat-flow` says `align-items: start`
       today — but a later change to the grid must not silently switch the rail
       off, so the card states it for itself. */
    const rule = railRule();
    expect(rule).toMatch(/position:\s*sticky/);
    expect(rule).toMatch(/align-self:\s*start/);
    expect(rule, "a rail taller than the window needs its own scroller").toMatch(/overflow-y:\s*auto/);
  });

  it("AND LETS GO WHEN THE COLUMNS STACK", () => {
    /* Below the breakpoint the two columns become one, and a sticky rail then
       pins itself over the content beneath it. */
    const narrow = strat.slice(strat.indexOf("@media (max-width: 900px)"));
    expect(narrow).toMatch(/\.strat-chat-card\s*\{[^}]*position:\s*static/);
  });
});

describe("a field states its own width", () => {
  /* WIDENING THE DESK MEASURE FROM 1480 TO 1800 EXPOSED A CLASS, not two
     instances. The old cap was holding back fields that had never declared a
     width of their own: the Journal's note ran to 1,782px and the Strategy
     desk's name field to 1,300px — single lines you type a sentence or three
     words into, stretched the width of the screen.

     A DESK CAP IS THE WRONG PLACE TO PROTECT A ROW. It protects every row on
     every desk by making the whole desk narrow, which is what cost 22% of the
     screen. The row is the right place, and this pins that the ones found so far
     keep theirs. */

  const sheets = readdirSync(DIR).filter((f) => f.endsWith(".css"));
  const all = sheets.map((f) => readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");

  it("THE PROSE AND NAME FIELDS CARRY A MEASURE", () => {
    for (const cls of ["jr-note", "strat-name"]) {
      /* NO REGEX BUILT FROM A TEMPLATE. The first version of this line went
         through a shell heredoc, which ate its doubled backslashes - and in a
         template literal `\s` is simply `s`, so the pattern matched nothing
         and the guard reported "no rule" for a rule that was plainly there.
         A plain index walk carries no escapes to lose. */
      const at = all.indexOf(`.${cls} {`) >= 0 ? all.indexOf(`.${cls} {`) : all.indexOf(`.${cls}{`);
      expect(at, `.${cls} should have a rule`).toBeGreaterThan(-1);
      const body = all.slice(at, all.indexOf("}", at));
      expect(body, `.${cls} must cap its own width`).toMatch(/max-width: \d+ch/);
    }
  });

  it("and the desk measure is the dashboard one, not the table one", () => {
    /* 1480 was chosen for a table ROW and then applied to card dashboards that
       have no long rows at all. */
    const comp = readFileSync(join(DIR, "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = comp.match(/\.view-slot\s*>\s*\*\s*\{([^}]*max-width[^}]*)\}/);
    expect(rule?.[1] ?? "").toMatch(/max-width:\s*1800px/);
  });
});
