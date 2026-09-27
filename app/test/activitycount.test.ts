/**
 * A LOG ENTRY IS NOT A RUN.
 *
 * The first version of the activity card printed "224 of 224 failed" and, for a
 * healthy job, "223 runs". Both read as a count of ATTEMPTS, and neither is.
 *
 * MEASURED IN THE SOURCE: `mishel_data.py` calls `log("data_calendar", str(e))`
 * inside an `except` and never on success, while `log("data_collect", "cycle
 * done")` is called on success only. So for a failure-only kind, every row IS a
 * failure and the denominator is the failure count again — "41 of 41 failed"
 * says it ran 41 times and failed every one, when it may have run five hundred
 * times and logged 41 failures. The number is right and the sentence is wrong,
 * which is worse than being visibly wrong.
 *
 * The log records EVENTS. Only the loop knows how often it ran, and it does not
 * say. So the card counts entries and calls them entries.
 *
 * Same family as "a count of what has REPORTED is not a count of what EXISTS",
 * turned around: here the denominator was mistaken for the population.
 */

import { describe, it, expect } from "vitest";
import { entryCount } from "../src/data/activity";

describe("entryCount", () => {
  it("does not invent a denominator when every entry is a failure", () => {
    /* `n === failed` means this kind only logs when it breaks. There is no
       honest "of N" to print, because N is the failures again. */
    const s = entryCount({ n: 224, failed: 224, failing: true });
    expect(s).toBe("224 failures logged");
    expect(s).not.toContain("of 224");
    expect(s).not.toMatch(/run/i);
  });

  it("gives the ratio when the kind logs successes too", () => {
    /* Here the denominator is real: 1,469 entries exist and 2 of them failed. */
    expect(entryCount({ n: 1469, failed: 2, failing: true })).toBe("2 of 1,469 entries failed");
  });

  it("calls a quiet kind's entries entries, not runs", () => {
    expect(entryCount({ n: 223, failed: 0, failing: false })).toBe("223 entries");
    expect(entryCount({ n: 1, failed: 0, failing: false })).toBe("1 entry");
  });

  it("handles the one-off without a plural", () => {
    expect(entryCount({ n: 1, failed: 1, failing: true })).toBe("1 failure logged");
  });

  it("separates thousands so a big number is readable at a glance", () => {
    /* 2069 and 20690 are one character apart and two orders of magnitude. */
    expect(entryCount({ n: 2069, failed: 2069, failing: true })).toBe("2,069 failures logged");
  });
});
