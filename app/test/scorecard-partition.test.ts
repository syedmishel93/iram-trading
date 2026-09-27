/**
 * THE CLAIMS BUCKETS MUST ADD UP TO THEIR OWN TOTAL.
 *
 * `learn/scorecard.ts` `summarise` counted `pending`, `unknowable` and
 * `decided`, and put every claim in `total` — so `expired` was in the total and
 * in no field. The SERVICE had the identical gap independently
 * (`mishel_claims.py` `_population`, pinned by `tests/test_claims_partition.py`),
 * which is what makes it a class rather than a slip.
 *
 * MEASURED on the live table while auditing what each module COMPUTES rather
 * than whether it answers: 2,113 claims — 1,098 pending, 523 target, 442 stop,
 * 19 unknowable, and **31 expired that nothing named**. The four visible numbers
 * did not sum to the fifth they sat under, and both screens that render a
 * population carried a comment promising to name what they could not settle.
 *
 * The exclusion from the rate was never the bug and is untouched here: A TIMEOUT
 * IS NOT A LOSS, and folding one into `stop` makes "nothing happened" and "I was
 * wrong" look the same. `expectancyR`'s own doc already said it counted expiries,
 * which is the only reason the gap was visible at all.
 *
 * `every declared outcome has a bucket` is the test that matters. Pinning the
 * number 31, or even pinning `expired` alone, would pass again the next time an
 * outcome is added — which is exactly how this one arrived. Sibling of "a guard
 * test that pins a COUNT fails on addition and passes on substitution".
 */

import { describe, expect, it } from "vitest";
import { scorecard } from "../src/learn/scorecard";
import type { Claim, Outcome } from "../src/learn/claim";

/** Every outcome the type declares. Read from the union, not restated. */
const OUTCOMES: readonly Outcome[] = ["pending", "target", "stop", "expired", "unknowable"];

/** `target` and `stop` compose `decided`; the rest each need a field of their own. */
const COMPOSED: readonly Outcome[] = ["target", "stop"];

let seq = 0;
const claim = (outcome: Outcome): Claim =>
  ({
    id: `c${++seq}`,
    at: 1_790_000_000_000 + seq * 1000,
    symbol: "BTCUSDT",
    timeframe: "1h",
    side: "long",
    verdict: "take",
    gatesFailed: 0,
    score: 0.5,
    coverage: 1,
    confidence: 0.6,
    probability: 0.6,
    entry: 100,
    stop: 95,
    target: 110,
    expiresAt: 1_790_000_000_000 + seq * 1000 + 3_600_000,
    outcome,
    resolvedAt: outcome === "pending" ? null : 1_790_000_000_000 + seq * 1000 + 60_000,
    resolvedPrice: outcome === "target" ? 110 : outcome === "stop" ? 95 : null,
    heldMs: outcome === "pending" ? null : 60_000,
  }) as Claim;

const many = (counts: Partial<Record<Outcome, number>>): Claim[] => {
  const out: Claim[] = [];
  for (const [outcome, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i += 1) out.push(claim(outcome as Outcome));
  }
  return out;
};

describe("a population accounts for every claim in its total", () => {
  // Distinct counts, so a bucket reading the wrong outcome cannot still add up.
  const SPREAD = { pending: 7, target: 5, stop: 3, expired: 2, unknowable: 1 } as const;

  it("the buckets partition the total", () => {
    const p = scorecard(many(SPREAD)).all;
    expect(p.total).toBe(18);
    expect(p.pending + p.unknowable + p.expired + p.decided).toBe(p.total);
  });

  it("every declared outcome has a bucket of its own", () => {
    const p = scorecard(many(Object.fromEntries(OUTCOMES.map((o) => [o, 1])))).all as unknown as
      Record<string, number>;
    for (const outcome of OUTCOMES) {
      if (COMPOSED.includes(outcome)) continue;
      expect(p[outcome], `${outcome} is a declared outcome with no bucket`).toBe(1);
    }
    const named = OUTCOMES.filter((o) => !COMPOSED.includes(o)).reduce(
      (sum, o) => sum + (p[o] ?? 0),
      0,
    );
    expect(named + p.decided).toBe(p.total);
  });

  it("reports expiries without counting them as losses", () => {
    const p = scorecard(many(SPREAD)).all;
    expect(p.expired).toBe(2);
    expect(p.decided).toBe(8);
    expect(p.hit.hits).toBe(5);
    expect(p.hit.rate).toBeCloseTo(5 / 8);
  });

  it("a group of nothing but expiries has no rate rather than a zero", () => {
    const p = scorecard(many({ expired: 9 })).all;
    expect(p.expired).toBe(9);
    expect(p.decided).toBe(0);
    // 0 would read as nine losses; the rate is unreadable, not zero.
    expect(Number.isFinite(p.hit.rate) && p.hit.rate === 0).toBe(false);
  });

  it("holds for each per-symbol group too, not just the total", () => {
    const claims = [
      ...many({ target: 3, expired: 2 }),
      ...many({ stop: 1, pending: 4 }).map((c): Claim => ({ ...c, symbol: "XAUUSD" })),
    ];
    const card = scorecard(claims);
    for (const group of [card.all, ...card.bySymbol]) {
      expect(
        group.pending + group.unknowable + group.expired + group.decided,
        `${group.label} leaves claims unaccounted for`,
      ).toBe(group.total);
    }
  });

  it("holds for both sides of the gate comparison", () => {
    // `take` and the stand-downs are summarised separately, and the sentence
    // under them promises to name what neither side could settle.
    const claims = [
      ...many({ target: 2, expired: 3 }),
      // `stand-down`, not some third word. The first draft of this used "wait",
      // which is not in `Verdict` at all -- and `as Claim` let it through, so the
      // fixture built four claims the comparison correctly counted on neither
      // side and the test blamed `gateVerdict`. A CAST IS A HOLE IN THE TYPE
      // SYSTEM the exact size of the mistake you are about to make; the
      // annotated return below would have refused it.
      ...many({ stop: 2, expired: 1, unknowable: 1 }).map(
        (c): Claim => ({ ...c, verdict: "stand-down", gatesFailed: 2 }),
      ),
    ];
    const g = scorecard(claims).gates;
    for (const side of [g.taken, g.stoodDown]) {
      expect(side.pending + side.unknowable + side.expired + side.decided).toBe(side.total);
    }
    expect(g.taken.expired + g.stoodDown.expired).toBe(4);
  });
});
