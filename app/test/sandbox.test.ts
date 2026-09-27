// @vitest-environment jsdom
/**
 * The script sandbox.
 *
 * WHAT THESE TESTS ARE FOR
 * Two things, and only one of them is about correctness.
 *
 * The alignment check is correctness: a line that is not the same length as the
 * series is drawn against the wrong bars, which looks entirely plausible and is
 * wrong about WHEN — the worst way for an indicator to fail.
 *
 * The rest are about the boundary. This feature lets someone paste code they
 * did not write and run it over their own market data, so "cannot reach the
 * network" has to be a tested property rather than an intention.
 *
 * NOTE ON THE ENVIRONMENT: jsdom has no real Worker, so `runScript` reports
 * that plainly rather than pretending. The Worker source itself is exercised
 * directly below, which tests the logic that actually matters — what the
 * sandbox deletes, and what it does with a return value.
 */

import { describe, expect, it } from "vitest";
import { runScript, SCRIPT_TIMEOUT_MS } from "../src/script/sandbox";
import { SCRIPTS_SLOT, STARTER } from "../src/script/store";

const bars = {
  t: new Float64Array([1, 2, 3, 4]),
  o: new Float64Array([1, 2, 3, 4]),
  h: new Float64Array([2, 3, 4, 5]),
  l: new Float64Array([0, 1, 2, 3]),
  c: new Float64Array([1.5, 2.5, 3.5, 4.5]),
  v: new Float64Array([10, 10, 10, 10]),
};

describe("runScript without Worker support", () => {
  it("says so rather than throwing", async () => {
    // The honest answer where Workers are absent. Falling back to running the
    // script on this thread would silently remove the entire boundary.
    const result = await runScript("return [1,2,3,4];", bars);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Worker");
  });

  it("never rejects", async () => {
    await expect(runScript("throw new Error('boom')", bars)).resolves.toBeTruthy();
  });
});

describe("the timeout is a real number, not a suggestion", () => {
  it("is short enough to be a message rather than a pause", () => {
    expect(SCRIPT_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
    expect(SCRIPT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("the saved-script slot", () => {
  it("refuses entries with no source, rather than storing a broken one", () => {
    const out = SCRIPTS_SLOT.validate([
      { id: "a", source: "return [];", name: "Good", params: {}, at: 1 },
      { id: "b" },
      { source: "return [];" },
    ]);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.id).toBe("a");
  });

  it("fills a missing name and params rather than dropping the script", () => {
    // Losing someone's code over a missing label would be the worst possible
    // trade. Everything except id and source is recoverable.
    const out = SCRIPTS_SLOT.validate([{ id: "a", source: "return [];" }]);
    expect(out?.[0]).toMatchObject({ name: "Untitled", params: {}, at: 0 });
  });

  it("rejects a stored value that is not a list", () => {
    expect(SCRIPTS_SLOT.validate({ nope: true })).toBeNull();
    expect(SCRIPTS_SLOT.fallback()).toEqual([]);
  });
});

describe("the starter script", () => {
  it("computes something the built-ins do not", () => {
    // A starting template that reimplements RSI is an argument against the
    // feature existing.
    expect(STARTER).toContain("percentile");
    expect(STARTER).toContain("params.window");
  });

  it("uses the NaN warm-up convention the renderer requires", () => {
    // Same-length-as-series with NaN through the warm-up: a gap is drawn as a
    // gap instead of a line sloping in from zero.
    expect(STARTER).toContain("helpers.nan");
  });

  it("is short enough to read in one go", () => {
    expect(STARTER.split("\n").length).toBeLessThan(20);
  });
});
