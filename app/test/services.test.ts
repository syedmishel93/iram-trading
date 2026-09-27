/**
 * THE CONNECTION READOUTS — the parts that can be wrong.
 *
 * Seven routes had no caller; the DOM around them is not where the risk is.
 * The risk is in three judgements: how old a backup has to be before saying so,
 * what "not measured" means as against "measured zero", and summing a store.
 *
 * THE CLOCK ONE IS THE IMPORTANT ONE. MT5 stamps on the broker's clock, and an
 * UNMEASURED offset means every timestamp is being taken at face value — a
 * different and more worrying state than a measured offset of zero. CLAUDE.md
 * records what conflating those costs: every TwelveData bar was displaced by
 * the server's own UTC offset, nothing failed, and the chart drew the right
 * candles in the wrong places.
 */

import { describe, it, expect } from "vitest";
import { backupAge, clockLine, kvSize, type BridgeClock } from "../src/data/services";

const clock = (over: Partial<BridgeClock>): BridgeClock => ({
  measured: true, offset_ms: 0, offset_s: 0, label: "", explain: "", note: "", measured_at_ms: 0, ...over,
});

describe("clockLine", () => {
  it("says NOT MEASURED rather than implying zero", () => {
    const s = clockLine(clock({ measured: false }));
    expect(s).toMatch(/not been measured/i);
    /* It must not read as a reassurance. */
    expect(s).not.toMatch(/matches UTC/i);
  });

  it("distinguishes a measured zero from an unmeasured one", () => {
    expect(clockLine(clock({ measured: true, offset_s: 0 }))).toMatch(/matches UTC/i);
  });

  it("names the size and the direction, in hours when it is hours", () => {
    const s = clockLine(clock({ offset_s: 10800 }));
    expect(s).toContain("3.0 hours");
    expect(s).toMatch(/ahead of/i);
    /* And says the correction is APPLIED — the fact that makes it harmless. */
    expect(s).toMatch(/subtracted/i);
  });

  it("handles a negative offset without a double sign", () => {
    const s = clockLine(clock({ offset_s: -7200 }));
    expect(s).toContain("2.0 hours");
    expect(s).toMatch(/behind/i);
    expect(s).not.toContain("-2");
  });

  it("refuses when the bridge said nothing", () => {
    expect(clockLine(undefined)).toMatch(/did not report/i);
  });
});

describe("backupAge", () => {
  it("returns null for never, not zero", () => {
    /* "Never backed up" and "backed up this instant" are opposite facts. */
    expect(backupAge(0, Date.now())).toEqual({ days: null, stale: true });
    expect(backupAge(Number.NaN, Date.now())).toEqual({ days: null, stale: true });
  });

  it("is not stale within the week the daily loop covers", () => {
    const now = Date.now();
    expect(backupAge((now - 2 * 86_400_000) / 1000, now).stale).toBe(false);
  });

  it("is stale past a week, because seven missed daily runs is a mechanism stopped", () => {
    const now = Date.now();
    const a = backupAge((now - 9 * 86_400_000) / 1000, now);
    expect(a.stale).toBe(true);
    expect(a.days).toBeCloseTo(9, 0);
  });

  it("treats a future timestamp as unusable rather than negative-aged", () => {
    const now = Date.now();
    expect(backupAge((now + 86_400_000) / 1000, now).days).toBeNull();
  });
});

describe("kvSize", () => {
  it("sums the slots and names the largest", () => {
    const s = kvSize({
      a: { bytes: 100, rev: 1, t: 0 },
      b: { bytes: 75372, rev: 2, t: 0 },
      c: { bytes: 73, rev: 992, t: 0 },
    });
    expect(s.total).toBe(75545);
    expect(s.largest).toBe("b");
    expect(s.largestBytes).toBe(75372);
    expect(s.slots).toBe(3);
  });

  it("skips a slot whose size is not a number instead of counting it as zero", () => {
    /* A slot of unknown size is not a slot of size zero — the total would be a
       floor, and reporting it as a total is the units rule in miniature. */
    const s = kvSize({ a: { bytes: 10, rev: 1, t: 0 }, b: { bytes: NaN, rev: 1, t: 0 } });
    expect(s.total).toBe(10);
    expect(s.slots).toBe(1);
  });

  it("does not throw on an empty or absent manifest", () => {
    expect(kvSize({}).total).toBe(0);
    expect(kvSize(undefined as never).slots).toBe(0);
  });
});
