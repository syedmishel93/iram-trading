/**
 * WHAT HAS BEEN TESTED, ON WHAT, AND WHAT SURVIVED.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS FILE IS BUILT AROUND
 *
 * **A BOARD THAT LISTS ONLY WINNERS IS AN ADVERT.** The shelf holds what
 * survived a search. On its own it answers "what do I have" and cannot answer
 * "does this work", because the markets where every rule failed leave no row —
 * so a shelf with four entries looks identical whether those four came out of
 * four searches or four hundred.
 *
 * `SWEEP_SLOT` is the half that knows. It records every search: the market, the
 * bar count, how many rules entered, how many CONFIGURATIONS were charged for,
 * how many survived, and the refusal when none did. MEASURED before this was
 * written: it has a writer in `sweepdriver.ts` and **no reader anywhere in the
 * product** — the record of everything the terminal has tried was being kept and
 * shown to nobody. A store with a writer and no reader, which this project has
 * now found four times.
 *
 * Joining the two is the whole point: the board lists the market where nothing
 * cleared the hurdle beside the one where something did, and says which is
 * which.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR MORE WAYS IT WOULD LIE
 *
 * 1. A survivor on thirteen trades is not a result. The trade count travels
 *    with every verdict and a thin one is named `unproven`, never `working`.
 * 2. A raw expectancy is not a result either — the search was paid for. The
 *    board ranks on what is left AFTER the best-of-N hurdle, which is the only
 *    figure that is comparable between a market searched with 85 rules and one
 *    searched with 8.
 * 3. A retired row is not a survivor, and a market whose only row was retired
 *    has been searched and found wanting — not "not searched".
 * 4. "Never searched" and "searched, nothing found" are different facts and the
 *    second is the more useful one.
 */

import { describe, expect, it } from "vitest";
import { scoreboard, MIN_TRADES_FOR_VERDICT } from "../src/backtest/scoreboard";
import type { Discovered } from "../src/backtest/discovered";
import type { SweepSummary } from "../src/backtest/sweepcache";
import type { RuleSpec } from "../src/backtest/rules";

const SPEC: RuleSpec = {
  id: "r",
  name: "A rule",
  style: "custom",
  long: [["close", ">", "ema50"]],
  short: [["close", "<", "ema50"]],
  exitLong: [["close", "<", "ema21"]],
  exitShort: [["close", ">", "ema21"]],
  stop: { type: "pct", value: 1 },
  target: { type: "rr", value: 2 },
};

const found = (over: Partial<Discovered> = {}): Discovered => ({
  spec: SPEC,
  origin: "library",
  foundAt: 1_700_000_000_000,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 40_000,
  trials: 765,
  trades: 120,
  expectancy: 0.14,
  sharpe: 0.31,
  deflated: 0.06,
  hurdle: 0.25,
  costs: { spreadPct: 0.0002, slippagePct: 0.0001, feePct: 0.0001, carryPerNight: 0 },
  status: "kept",
  ...over,
});

const swept = (over: Partial<SweepSummary> = {}): SweepSummary => ({
  key: "k",
  symbol: "BTCUSDT",
  timeframe: "1h",
  at: 1_700_000_000_000,
  bars: 40_000,
  lastBar: 1_700_000_000_000,
  entered: 85,
  trials: 765,
  survivors: 0,
  line: "nothing cleared the hurdle",
  refusal: "below the hurdle",
  nearest: "the best was 0.20 against a hurdle of 0.29",
  failed: [],
  ...over,
});

describe("the board covers what FAILED, not only what survived", () => {
  it("LISTS A MARKET THAT WAS SEARCHED AND PRODUCED NOTHING", () => {
    /* The row that makes the board honest. Without it, four shelf entries look
       the same whether they came out of four searches or four hundred. */
    const rows = scoreboard([], [swept({ symbol: "XAUUSD" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("XAUUSD");
    expect(rows[0]?.verdict).toBe("nothing");
  });

  it("separates NEVER SEARCHED from searched-and-found-nothing", () => {
    /* Two different facts, and the second is the more useful one: it means the
       question has been asked and answered. */
    const rows = scoreboard([found({ symbol: "ETHUSDT", status: "retired" })], []);
    expect(rows[0]?.verdict).toBe("not searched");
    expect(rows[0]?.why).toMatch(/not been searched|no search/i);
  });

  it("COUNTS THE SEARCHES AND THE ARMS THEY PAID FOR", () => {
    const rows = scoreboard(
      [],
      [swept({ key: "a", trials: 765 }), swept({ key: "b", trials: 300, at: 1_700_000_100_000 })],
    );
    expect(rows[0]?.searches).toBe(2);
    expect(rows[0]?.trials).toBe(1065);
    expect(rows[0]?.lastSearched).toBe(1_700_000_100_000);
  });

  it("carries the refusal from the most recent search, not the first", () => {
    const rows = scoreboard(
      [],
      [
        swept({ key: "a", nearest: "old reason", at: 1 }),
        swept({ key: "b", nearest: "the reason that still applies", at: 2 }),
      ],
    );
    expect(rows[0]?.why).toContain("the reason that still applies");
  });
});

describe("a survivor is not automatically a result", () => {
  it("CALLS A THIN SAMPLE UNPROVEN, never working", () => {
    const rows = scoreboard([found({ trades: 13 })], [swept({ survivors: 1 })]);
    expect(rows[0]?.verdict).toBe("unproven");
    expect(rows[0]?.why).toMatch(/13 trades|too few|thin/i);
  });

  it("CALLS A RULE THAT DID NOT BEAT ITS OWN SEARCH unproven", () => {
    /* deflated <= 0 means the result is what a search that wide would have
       produced on noise. */
    const rows = scoreboard([found({ deflated: -0.02, trades: 200 })], [swept({ survivors: 1 })]);
    expect(rows[0]?.verdict).toBe("unproven");
    expect(rows[0]?.why).toMatch(/hurdle|search/i);
  });

  it("calls a well-sampled rule that cleared its hurdle working", () => {
    const rows = scoreboard([found({ trades: 200, deflated: 0.08 })], [swept({ survivors: 1 })]);
    expect(rows[0]?.verdict).toBe("working");
  });

  it("A RETIRED ROW IS NOT A SURVIVOR", () => {
    const rows = scoreboard(
      [found({ status: "retired", retiredWhy: "forward drifted" })],
      [swept({ survivors: 1 })],
    );
    expect(rows[0]?.kept).toBe(0);
    expect(rows[0]?.verdict).not.toBe("working");
  });
});

describe("ranking", () => {
  it("RANKS ON WHAT SURVIVED THE HURDLE, not on raw expectancy", () => {
    /* A market searched with 85 rules and one searched with 8 are not
       comparable on a raw figure — the wide search gets a better best by luck
       alone, which is exactly what the deflation charges for. */
    const rows = scoreboard(
      [
        found({ symbol: "A", expectancy: 0.9, deflated: 0.01, trades: 200 }),
        found({ symbol: "B", expectancy: 0.2, deflated: 0.12, trades: 200 }),
      ],
      [swept({ symbol: "A", survivors: 1 }), swept({ symbol: "B", survivors: 1 })],
    );
    expect(rows[0]?.symbol, "the bigger raw number must not win").toBe("B");
  });

  it("puts markets with a verdict above markets with none", () => {
    const rows = scoreboard(
      [found({ symbol: "B", trades: 200, deflated: 0.08 })],
      [swept({ symbol: "A" }), swept({ symbol: "B", survivors: 1 })],
    );
    expect(rows[0]?.symbol).toBe("B");
  });

  it("KEEPS THE MARKET AND THE BAR SIZE TOGETHER, because they are one subject", () => {
    /* BTCUSDT 1h and BTCUSDT 1d have different base rates; merging them would
       average two different questions. */
    const rows = scoreboard(
      [],
      [swept({ timeframe: "1h" }), swept({ timeframe: "1d", key: "z" })],
    );
    expect(rows).toHaveLength(2);
  });
});

describe("what the board says about itself", () => {
  it("is empty and says so rather than rendering a blank table", () => {
    expect(scoreboard([], [])).toHaveLength(0);
  });

  it("EVERY ROW CARRIES A SENTENCE, so no verdict stands as a bare word", () => {
    const rows = scoreboard(
      [found({ trades: 200, deflated: 0.08 })],
      [swept({ symbol: "XAUUSD" }), swept({ survivors: 1 })],
    );
    for (const r of rows) {
      expect(r.why.length, r.symbol + " has no sentence").toBeGreaterThan(20);
    }
  });

  it("names the trade floor rather than hiding it in a constant", () => {
    expect(MIN_TRADES_FOR_VERDICT).toBeGreaterThan(20);
  });
});
