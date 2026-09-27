/**
 * The trial mirror.
 *
 * Two things carry the weight here: the derived id, because a non-derived one
 * would duplicate a deterministic replay's rows on every refresh and narrow
 * every interval around no new evidence; and the local-host gate, because
 * these are the operator's measured results on their own instruments.
 */

import { describe, expect, it, vi } from "vitest";
import { createEdge, rowsFrom, summarise, type ConditionalTable } from "../src/learn/edge";
import type { Simulation, Trial } from "../src/setup/simulate";

const trial = (over: Partial<Trial> = {}): Trial => ({
  atBar: 10,
  at: 1_700_000_000_000,
  entry: 100,
  stop: 99,
  target: 101,
  outcome: "target",
  r: 1,
  heldBars: 4,
  ...over,
});

const sim = (over: Partial<Simulation> = {}): Simulation =>
  ({
    kind: "spring",
    direction: "long",
    trials: [trial()],
    n: 1,
    wins: 1,
    losses: 0,
    expiries: 0,
    unknowable: 0,
    hitRate: 1,
    hitLow: 0,
    expectancy: 1,
    expectancyLow: null,
    expectancyHigh: null,
    medianBars: 4,
    enough: false,
    adverse: false,
    note: "",
    ...over,
  }) as Simulation;

describe("rowsFrom", () => {
  it("derives the id from the trial so a re-run converges", () => {
    /* The replay is deterministic and re-runs whenever the card refreshes. A
       generated id would add a duplicate set every time — 283 claims that were
       151 positions is the same mistake, already made once here. */
    const a = rowsFrom(sim(), "ETHUSDT", "1h");
    const b = rowsFrom(sim(), "ETHUSDT", "1h");
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.id).toContain("ETHUSDT|1h|spring|long|");
  });

  it("separates the same bar on different symbols, timeframes and sides", () => {
    const ids = new Set([
      rowsFrom(sim(), "ETHUSDT", "1h")[0]?.id,
      rowsFrom(sim(), "BTCUSDT", "1h")[0]?.id,
      rowsFrom(sim(), "ETHUSDT", "4h")[0]?.id,
      rowsFrom(sim({ direction: "short" }), "ETHUSDT", "1h")[0]?.id,
    ]);
    expect(ids.size).toBe(4);
  });

  it("drops an expired trial rather than mapping it onto an outcome", () => {
    /* `expired` means the horizon ran out before either barrier was touched.
       It is not a loss and it is not unknowable; calling it either would move
       a hit rate on the strength of a naming decision. */
    const rows = rowsFrom(sim({ trials: [trial({ outcome: "expired", r: null })] }), "E", "1h");
    expect(rows).toHaveLength(0);
  });

  it("keeps an unknowable trial, which the server excludes from the denominator", () => {
    const rows = rowsFrom(sim({ trials: [trial({ outcome: "unknowable", r: null })] }), "E", "1h");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("unknowable");
  });

  it("sends the stop distance the cost model needs", () => {
    /* Without it every figure on the server silently reverts to gross. */
    const rows = rowsFrom(sim({ trials: [trial({ entry: 100, stop: 99.5 })] }), "E", "1h");
    expect(rows[0]?.stopPct).toBeCloseTo(0.5);
  });

  it("sends no stop distance rather than a wrong one when entry is unusable", () => {
    const rows = rowsFrom(sim({ trials: [trial({ entry: 0 })] }), "E", "1h");
    expect(rows[0]?.stopPct).toBeNull();
  });
});

describe("createEdge", () => {
  const base = { symbol: () => "ETHUSDT", timeframe: () => "1h" };

  it("refuses a non-local host without making a request", async () => {
    /* Trials are the operator's own measured history. Posting them elsewhere
       is a data-export decision, not a sync detail. */
    const fetchImpl = vi.fn();
    const edge = createEdge({ ...base, url: "https://example.com", fetchImpl: fetchImpl as never });
    expect(await edge.push([sim()])).toBe(-1);
    expect(await edge.conditional(null)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(edge.lastError()).toMatch(/non-local/);
  });

  it("is not fooled by a hostname that merely contains a local address", async () => {
    const fetchImpl = vi.fn();
    const edge = createEdge({
      ...base,
      url: "http://127.0.0.1.evil.example",
      fetchImpl: fetchImpl as never,
    });
    expect(await edge.push([sim()])).toBe(-1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call the service when there is nothing to send", async () => {
    const fetchImpl = vi.fn();
    const edge = createEdge({ ...base, fetchImpl: fetchImpl as never });
    expect(await edge.push([sim({ trials: [] })])).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports rows written, not rows sent", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, received: 1, written: 1 }), { status: 200 }),
    );
    const edge = createEdge({ ...base, fetchImpl: fetchImpl as never });
    expect(await edge.push([sim()])).toBe(1);
    expect(edge.lastError()).toBe("");
  });

  it("surfaces a refused connection instead of reporting success", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const edge = createEdge({ ...base, fetchImpl: fetchImpl as never });
    expect(await edge.push([sim()])).toBe(-1);
    expect(edge.lastError()).toMatch(/Failed to fetch/);
  });

  it("passes the kind through and omits it when asked for everything", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (u: string) => {
      seen.push(u);
      return new Response(JSON.stringify({ ok: true, available: false, trials: 0, days: 0 }), {
        status: 200,
      });
    });
    const edge = createEdge({ ...base, fetchImpl: fetchImpl as never });
    await edge.conditional("spring");
    await edge.conditional(null);
    expect(seen[0]).toContain("kind=spring");
    expect(seen[1]).not.toContain("kind=");
  });

  it("treats a refusal as an answer, not an error", async () => {
    /* "These trials span one day, so no breakdown is offered" is exactly what
       the caller needs to hear. Failing here would make a correct refusal look
       like a broken service. */
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, available: false, reason: "These trials span 1 day.", trials: 40, days: 1 }),
        { status: 200 },
      ),
    );
    const edge = createEdge({ ...base, fetchImpl: fetchImpl as never });
    const table = await edge.conditional(null);
    expect(table?.available).toBe(false);
    expect(edge.lastError()).toBe("");
  });
});

describe("summarise", () => {
  it("leads with the refusal when there is one", () => {
    const table = {
      available: false,
      reason: "These trials span 1 day.",
      trials: 40,
      days: 1,
    } as ConditionalTable;
    expect(summarise(table)).toBe("These trials span 1 day.");
  });

  it("says nothing survived rather than naming the best-looking cell", () => {
    /* The qualification has to come before the number. A caller that rendered
       cells and appended "but none of this is significant" would be putting it
       where nobody reads it. */
    const table = {
      available: true,
      trials: 300,
      days: 40,
      comparisons: 24,
      best: { found: false, text: "..." },
    } as ConditionalTable;
    expect(summarise(table)).toMatch(/nothing survives the correction/);
    expect(summarise(table)).toContain("24 cells examined");
  });

  it("names a survivor when the server found one", () => {
    const table = {
      available: true,
      trials: 900,
      days: 60,
      comparisons: 24,
      best: { found: true, text: "London: 280 of 400, lower bound 63.1%" },
    } as ConditionalTable;
    expect(summarise(table)).toContain("London");
  });

  it("says the service did not answer rather than inventing an empty table", () => {
    expect(summarise(null)).toMatch(/did not answer/);
  });
});
