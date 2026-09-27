// @vitest-environment jsdom
/**
 * A POPULATION WITH NOTHING DECIDED YET IS A REFUSAL, NOT A ZERO.
 *
 * MEASURED on the running service: of five markets and eight bar sizes,
 * one market and three bar sizes came back with `hitRate`, `low`, `high` and
 * `expectancyR` all null — claims recorded, none of them settled yet. That is
 * the service being honest, and the card has to be honest about it too.
 *
 * The first version declared those fields `number` and called `.toFixed(3)` on
 * them. The throw happened inside `each`'s render loop, BEFORE its
 * `parent.appendChild(frag)` — so one ungradeable row silently took the whole
 * table with it: five markets on screen as none, three bar sizes as none, with
 * `data-on="true"` on the same data proving the rows existed. `createReaction`
 * swallows the throw by design, so nothing was red and nothing was logged where
 * anyone would look; it was `window.__signalErrors`, the diagnostic `signal.ts`
 * says it keeps for exactly this, that named it.
 *
 * Both halves are pinned here: the null-safety, and the amplification.
 */

import { describe, it, expect } from "vitest";
import { gradedRow } from "../src/ui/cards/trackrecord";
import { each, h } from "../src/ui/dom";
import { signal } from "../src/core/signal";
import type { ClaimPopulation } from "../src/data/claimstats";

const decided: ClaimPopulation = {
  label: "XAUUSD",
  decided: 123,
  hits: 75,
  hitRate: 0.6097560975609756,
  low: 0.5214740057306497,
  high: 0.691389912731432,
  expectancyR: 0.20214809584949017,
};

/** Exactly the shape the live service returned for SOLUSDT. */
const undecided: ClaimPopulation = {
  label: "SOLUSDT",
  decided: 0,
  hits: 0,
  hitRate: null,
  low: null,
  high: null,
  expectancyR: null,
};

describe("gradedRow", () => {
  it("prints the figures when the population has been decided", () => {
    const r = gradedRow(decided);
    expect(r.graded).toBe(true);
    expect(r.decided).toBe("123");
    expect(r.rate).toBe("61.0%");
    expect(r.range).toBe("52.1%–69.1%");
    expect(r.exp).toBe("+0.202R");
  });

  it("REFUSES rather than printing a zero when nothing has been decided", () => {
    const r = gradedRow(undecided);
    expect(r.graded).toBe(false);
    /* Not "0.0%" and not "+0.000R". A rate of zero is a claim that everything
       lost; this is a claim that nothing has been answered yet. */
    expect(r.rate).toBe("—");
    expect(r.range).toBe("—");
    expect(r.exp).toBe("—");
    expect(r.decided).toBe("0");
    /* And it says WHY, rather than leaving four dashes to be interpreted.
       Pinning the FACTS in the sentence, not its wording: which population it
       is about, that nothing is decided, and that this is a matter of time
       rather than of failure. */
    expect(r.why).toContain("SOLUSDT");
    expect(r.why).toMatch(/none decided|nothing decided/i);
    expect(r.why).toMatch(/bars|closed|settle/i);
  });

  it("does not throw on any null the service is allowed to send", () => {
    expect(() => gradedRow(undecided)).not.toThrow();
    expect(() => gradedRow({ ...decided, expectancyR: null })).not.toThrow();
    expect(() => gradedRow({ ...decided, low: null, high: null })).not.toThrow();
  });

  it("signs a negative expectancy without a plus", () => {
    expect(gradedRow({ ...decided, expectancyR: -0.0426509825054933 }).exp).toBe("-0.043R");
  });
});

describe("each, when one row's renderer throws", () => {
  it("LOSES THE WHOLE LIST — which is why a renderer must not throw", () => {
    /* Pinning the amplification, not endorsing it. `each` builds the fragment
       first and appends once; a throw part-way leaves the parent untouched, so
       the cost of one bad row is every good row beside it. Anyone tempted to
       let a renderer throw "just for the odd case" should read this. */
    const items = signal<readonly number[]>([]);
    const parent = h("div", {}) as HTMLElement;
    each(
      parent,
      () => items(),
      (n) => String(n),
      (n) => {
        if (n === 3) throw new TypeError("Cannot read properties of null (reading 'toFixed')");
        return h("span", { text: String(n) }) as HTMLElement;
      },
    );
    items.set([1, 2, 3, 4, 5]);
    /* The effect is a renderEffect, so it lands on the next frame. */
    return new Promise<void>((done) => {
      setTimeout(() => {
        expect(parent.childNodes.length).toBe(0);
        done();
      }, 50);
    });
  });
});
