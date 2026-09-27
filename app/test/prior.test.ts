/**
 * The track record, as evidence in a decision.
 *
 * WHAT MUST NOT GO WRONG
 * This is the first thing in the repository that lets past outcomes REFUSE a
 * trade, so the failure modes are asymmetric. Blocking on noise is much worse
 * than failing to block: a terminal that refuses because of a bad run has
 * turned a coin toss into a rule, silently, in the name of learning.
 *
 * So the tests below are mostly about when it must STAY QUIET.
 */

import { describe, expect, it } from "vitest";
import { priorFor, UNKNOWN_PRIOR } from "../src/learn/prior";
import { MIN_FOR_RATE } from "../src/learn/scorecard";
import type { Claim } from "../src/learn/claim";

/** Claims with a given outcome mix. Only the fields the prior reads. */
function claims(opts: {
  n: number;
  hits: number;
  symbol?: string;
  timeframe?: string;
  kind?: string;
  side?: "long" | "short";
  verdict?: "take" | "stand-down";
  outcome?: Claim["outcome"];
}): Claim[] {
  const out: Claim[] = [];
  for (let i = 0; i < opts.n; i++) {
    out.push({
      id: `c${i}`,
      at: 1_700_000_000_000 + i,
      symbol: opts.symbol ?? "BTCUSDT",
      timeframe: opts.timeframe ?? "1h",
      side: opts.side ?? "long",
      verdict: opts.verdict ?? "take",
      gatesFailed: 0,
      score: 0.5,
      coverage: 0.9,
      confidence: 0.7,
      probability: null,
      outcome: opts.outcome ?? (i < opts.hits ? "target" : "stop"),
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    } as unknown as Claim);
  }
  return out;
}

const q = { symbol: "BTCUSDT", timeframe: "1h" };

describe("staying quiet", () => {
  it("says nothing with an empty ledger", () => {
    expect(priorFor([], q)).toEqual(UNKNOWN_PRIOR);
  });

  it("says nothing about another instrument's record", () => {
    expect(priorFor(claims({ n: 60, hits: 5, symbol: "ETHUSDT" }), q).standing).toBe("unknown");
  });

  it("refuses to read a rate under the sample floor", () => {
    // Four losses from five is a 20% hit rate and means nothing whatsoever.
    const p = priorFor(claims({ n: 5, hits: 1 }), q);
    expect(p.standing).toBe("thin");
    expect(p.hit).toBeNull();
    expect(p.text).toContain(String(MIN_FOR_RATE));
  });

  it("will not block on a bad run inside a coin toss", () => {
    // 8 of 20 — a 40% point estimate, and a Wilson interval that spans 50%.
    // Blocking here would be the terminal turning variance into a rule.
    const p = priorFor(claims({ n: 20, hits: 8 }), q);
    expect(p.standing).toBe("thin");
    expect(p.hit?.reportable).toBe(true);
    expect(p.text).toContain("not clearly better or worse");
  });

  it("ignores claims that never settled", () => {
    // `expired` means the deadline passed with neither level touched, and
    // `pending` has not been marked at all. Counting either as a loss would
    // invent a losing record out of unfinished business.
    for (const outcome of ["expired", "pending", "unknowable"] as const) {
      expect(priorFor(claims({ n: 60, hits: 0, outcome }), q).standing).toBe("unknown");
    }
  });

  it("ignores stand-downs entirely", () => {
    // A stand-down that would have worked is evidence about the GATES, not
    // about the shape. `gateVerdict` is where that comparison belongs.
    expect(priorFor(claims({ n: 60, hits: 3, verdict: "stand-down" }), q).standing).toBe("unknown");
  });
});

describe("speaking up", () => {
  it("argues against a shape whose whole interval sits below even money", () => {
    const p = priorFor(claims({ n: 60, hits: 12 }), q);
    expect(p.standing).toBe("against");
    expect(p.resolved).toBe(60);
    expect(p.text).toContain("losing record");
    // The sample always travels with the rate.
    expect(p.text).toContain("of 60 calls");
  });

  it("supports a shape whose whole interval clears it", () => {
    const p = priorFor(claims({ n: 60, hits: 48 }), q);
    expect(p.standing).toBe("supports");
    expect(p.text).toContain("better than a coin flip");
  });
});

describe("the widening ladder", () => {
  it("prefers the narrowest question that has enough evidence", () => {
    const specific = claims({ n: 30, hits: 3, kind: "fvg" });
    const other = claims({ n: 30, hits: 28, kind: "bos" });
    const p = priorFor([...specific, ...other], { ...q, kind: "fvg" });
    expect(p.scope).toBe("fvg on BTCUSDT 1h");
    expect(p.standing).toBe("against");
  });

  it("widens when the narrow question is too thin, and says that it did", () => {
    const thin = claims({ n: 3, hits: 0, kind: "fvg" });
    const broad = claims({ n: 40, hits: 32, kind: "bos" });
    const p = priorFor([...thin, ...broad], { ...q, kind: "fvg" });
    // Not "fvg on BTCUSDT 1h" — the reader has to know which question was
    // actually answered, or they will assume the stronger one.
    expect(p.scope).toBe("BTCUSDT 1h");
    expect(p.standing).toBe("supports");
  });

  it("falls back across timeframes before giving up", () => {
    const p = priorFor(claims({ n: 40, hits: 4, timeframe: "4h" }), q);
    expect(p.scope).toBe("BTCUSDT, any timeframe");
    expect(p.standing).toBe("against");
  });

  it("narrows by side only when that still leaves a readable sample", () => {
    const longs = claims({ n: 40, hits: 34, side: "long" });
    const shorts = claims({ n: 4, hits: 0, side: "short" });
    // Four shorts cannot support a rate, so the answer is the pooled one
    // rather than a confident claim built on four outcomes.
    const p = priorFor([...longs, ...shorts], { ...q, side: "short" });
    expect(p.resolved).toBe(44);
  });
});
