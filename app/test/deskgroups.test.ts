/**
 * NO GROUP IS A DUMPING GROUND.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * MEASURED in the live app by walking the "All tools" menu: **"Chart" held 17
 * of 34 entries — exactly half of everything the terminal can do.** Among them
 * Risk ("sizing, the book, portfolio risk and hedging"), Calculator ("lots,
 * pips, margin"), Paper ("practice fills"), Price alerts, Whale watch,
 * Smart-money wallets and New token pairs. Not one of those is a chart.
 *
 * `VIEWS` is already the single owner of the taxonomy — `toolsmenu.ts` is a
 * projection of it and a test guards that. What nothing asked was whether the
 * taxonomy itself still meant anything, and a group holding half the product
 * does not: it is where things go when nobody decided.
 *
 * This project already records the class — "A CAPABILITY FILED UNDER THE WRONG
 * HEADING IS BARELY EASIER TO FIND THAN ONE WITH NO SCREEN." Storage, downloads
 * and twelve background jobs shipped inside Research > Data while the menu had a
 * "Review and system" group that did not contain them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It does NOT pin the grouping. A test listing the intended group of every desk
 * is a second copy of `VIEWS` that has to be edited twice and will drift — and
 * this project already records what happens when two lists name a group for the
 * same thing.
 *
 * It pins the PROPERTIES a usable taxonomy has: every desk filed, no group
 * empty, no group holding so much of the product that it has stopped dividing
 * anything. Those survive every addition and still catch the defect.
 */

import { describe, expect, it } from "vitest";
import { VIEWS } from "../src/ui/shell/views";

/**
 * The share of all desks one group may hold.
 *
 * Five or six groups means an even split is 17-20%. A third is generous and
 * still catches a dumping ground: at the measured 50% a reader scanning that
 * group is scanning the whole product, which is what having groups was for.
 */
const MAX_GROUP_SHARE = 0.34;

describe("the desk taxonomy", () => {
  it("files every desk in exactly one group", () => {
    for (const v of VIEWS) {
      expect(typeof v.group, v.id + " has no group").toBe("string");
      expect(v.group.length, v.id + " has an empty group").toBeGreaterThan(0);
    }
  });

  it("NO GROUP HOLDS MORE THAN A THIRD OF THE DESKS", () => {
    const counts = new Map<string, number>();
    for (const v of VIEWS) counts.set(v.group, (counts.get(v.group) ?? 0) + 1);

    const total = VIEWS.length;
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(worst, "no desks at all").toBeDefined();
    const [name, n] = worst as [string, number];
    expect(
      n / total,
      `"${name}" holds ${n} of ${total} desks (${((n / total) * 100).toFixed(0)}%) — ` +
        `a group that large has stopped dividing anything`,
    ).toBeLessThanOrEqual(MAX_GROUP_SHARE);
  });

  it("has no group of one, which is a group that did not need to exist", () => {
    const counts = new Map<string, number>();
    for (const v of VIEWS) counts.set(v.group, (counts.get(v.group) ?? 0) + 1);
    for (const [name, n] of counts) {
      expect(n, `"${name}" holds a single desk`).toBeGreaterThan(1);
    }
  });

  it("KEEPS THE GROUP COUNT READABLE — between three and seven", () => {
    /* Fewer than three is not a taxonomy; more than seven is a list wearing
       headings, and the menu is scanned rather than read. */
    const groups = new Set(VIEWS.map((v) => v.group));
    expect(groups.size).toBeGreaterThanOrEqual(3);
    expect(groups.size).toBeLessThanOrEqual(7);
  });

  it("gives every desk a hint, because the group alone cannot say what it does", () => {
    for (const v of VIEWS) {
      expect(v.hint.length, v.id + " has no hint").toBeGreaterThan(10);
    }
  });

  it("has unique ids and unique labels", () => {
    expect(new Set(VIEWS.map((v) => v.id)).size).toBe(VIEWS.length);
    expect(new Set(VIEWS.map((v) => v.label)).size).toBe(VIEWS.length);
  });
});
