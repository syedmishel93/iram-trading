import { describe, it, expect } from "vitest";
import {
  synthesise,
  absent,
  failed,
  ageCheck,
  byGroup,
  leanLabel,
  MIN_COVERAGE,
  NEUTRAL_BAND,
  type Evidence,
} from "../src/core/evidence";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: "e",
  group: "trend",
  label: "Trend",
  lean: 0.5,
  weight: 1,
  reason: "because",
  source: "test",
  asOf: 1_000,
  state: "fresh",
  ...over,
});

describe("synthesise — the basics", () => {
  it("returns a neutral, zero-coverage read for no evidence", () => {
    const r = synthesise([]);
    expect(r.score).toBe(0);
    expect(r.bias).toBe("neutral");
    expect(r.coverage).toBe(0);
    expect(r.confidence).toBe(0);
  });

  it("averages directional evidence by weight", () => {
    const r = synthesise([
      ev({ id: "a", lean: 1, weight: 1 }),
      ev({ id: "b", lean: 0, weight: 1 }),
    ]);
    expect(r.score).toBeCloseTo(0.5, 9);
  });

  it("respects unequal weights", () => {
    const r = synthesise([
      ev({ id: "a", lean: 1, weight: 3 / 3 }),
      ev({ id: "b", lean: -1, weight: 1 / 3 }),
    ]);
    expect(r.score).toBeGreaterThan(0);
  });

  it("clamps a lean beyond the range rather than propagating it", () => {
    const r = synthesise([ev({ lean: 5 })]);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("uses a wide neutral band", () => {
    expect(synthesise([ev({ lean: NEUTRAL_BAND / 2 })]).bias).toBe("neutral");
    expect(synthesise([ev({ lean: NEUTRAL_BAND + 0.01 })]).bias).toBe("long");
    expect(synthesise([ev({ lean: -NEUTRAL_BAND - 0.01 })]).bias).toBe("short");
  });

  it("ignores evidence with a non-finite weight", () => {
    const r = synthesise([ev({ lean: 1 }), ev({ id: "bad", lean: -1, weight: NaN })]);
    expect(r.score).toBeCloseTo(1, 9);
  });
});

describe("coverage — the number that stops a thin read passing as a strong one", () => {
  it("is 1 when everything answers", () => {
    expect(synthesise([ev({ id: "a" }), ev({ id: "b" })]).coverage).toBe(1);
  });

  it("falls when a source is absent", () => {
    const r = synthesise([ev({ id: "a" }), absent("b", "onchain", "On-chain", 1, "not covered")]);
    expect(r.coverage).toBeCloseTo(0.5, 9);
  });

  it("falls when a source failed", () => {
    const r = synthesise([ev({ id: "a" }), failed("b", "model", "Regime", 1, "service down")]);
    expect(r.coverage).toBeCloseTo(0.5, 9);
  });

  // Four agreeing sources out of ten is not four out of four.
  it("distinguishes four-of-four from four-of-ten", () => {
    const four = [0, 1, 2, 3].map((i) => ev({ id: `a${i}`, lean: 1 }));
    const strong = synthesise(four);
    const thin = synthesise([
      ...four,
      ...[0, 1, 2, 3, 4, 5].map((i) => absent(`m${i}`, "flow", `M${i}`, 1, "no data")),
    ]);
    expect(strong.score).toBeCloseTo(thin.score, 9);
    expect(strong.confidence).toBeGreaterThan(thin.confidence);
    expect(thin.coverage).toBeCloseTo(0.4, 9);
  });

  it("zeroes confidence outright below the coverage floor", () => {
    const r = synthesise([
      ev({ id: "a", lean: 1 }),
      ...[0, 1, 2, 3].map((i) => absent(`m${i}`, "flow", `M${i}`, 1, "no data")),
    ]);
    expect(r.coverage).toBeLessThan(MIN_COVERAGE);
    expect(r.confidence).toBe(0);
    expect(r.limits.join(" ")).toMatch(/below the .* floor/i);
  });

  // Perfect agreement among two of ten is not high confidence.
  it("never lets confidence exceed coverage", () => {
    for (const n of [1, 2, 5]) {
      const r = synthesise([
        ...Array.from({ length: n }, (_, i) => ev({ id: `a${i}`, lean: 1 })),
        ...Array.from({ length: 10 - n }, (_, i) => absent(`m${i}`, "flow", `M${i}`, 1, "x")),
      ]);
      expect(r.confidence).toBeLessThanOrEqual(r.coverage + 1e-9);
    }
  });
});

describe("agreement — separate from score, on purpose", () => {
  // Six weak agreeing and three hard each way can average the same.
  it("separates a consensus from a stand-off with the same mean", () => {
    const consensus = synthesise([
      ev({ id: "a", lean: 0.3 }),
      ev({ id: "b", lean: 0.3 }),
      ev({ id: "c", lean: 0.3 }),
    ]);
    const standoff = synthesise([
      ev({ id: "a", lean: 0.9 }),
      ev({ id: "b", lean: 0.9 }),
      ev({ id: "c", lean: -0.9 }),
    ]);
    expect(consensus.score).toBeCloseTo(0.3, 9);
    expect(standoff.score).toBeCloseTo(0.3, 9);
    expect(consensus.agreement).toBe(1);
    expect(standoff.agreement).toBeCloseTo(2 / 3, 9);
    expect(consensus.confidence).toBeGreaterThan(standoff.confidence);
  });

  it("names a disagreement in the limits", () => {
    const r = synthesise([
      ev({ id: "a", lean: 0.9 }),
      ev({ id: "b", lean: 0.9 }),
      ev({ id: "c", lean: -0.9 }),
    ]);
    expect(r.limits.join(" ")).toMatch(/sources disagree/i);
  });

  it("reports zero agreement on a neutral bias", () => {
    expect(synthesise([ev({ lean: 0 })]).agreement).toBe(0);
  });
});

describe("informational evidence", () => {
  // A 6% float is not bullish or bearish.
  it("counts toward coverage but not toward the score", () => {
    const r = synthesise([
      ev({ id: "a", lean: 1, weight: 1 }),
      ev({ id: "f", lean: null, weight: 1, group: "fundamental", label: "Float" }),
    ]);
    expect(r.score).toBeCloseTo(1, 9);
    expect(r.coverage).toBe(1);
  });

  // Dropping it would be the panel deciding what you may consider.
  it("is still returned in the evidence list", () => {
    const r = synthesise([ev({ id: "f", lean: null, label: "Float" })]);
    expect(r.evidence.some((e) => e.label === "Float")).toBe(true);
  });

  it("produces a neutral read when nothing is directional", () => {
    const r = synthesise([ev({ id: "f", lean: null }), ev({ id: "g", lean: null })]);
    expect(r.bias).toBe("neutral");
    expect(r.score).toBe(0);
    expect(r.coverage).toBe(1);
  });
});

describe("stale evidence", () => {
  // Half weight says "true recently" without letting it drive.
  it("counts at half weight rather than being dropped", () => {
    const fresh = synthesise([ev({ id: "a", lean: 1 }), ev({ id: "b", lean: -1 })]);
    const halved = synthesise([ev({ id: "a", lean: 1 }), ev({ id: "b", lean: -1, state: "stale" })]);
    expect(fresh.score).toBeCloseTo(0, 9);
    expect(halved.score).toBeGreaterThan(0);
  });

  it("reduces coverage", () => {
    expect(synthesise([ev({ state: "stale" })]).coverage).toBeCloseTo(0.5, 9);
  });

  it("says which sources are stale", () => {
    const r = synthesise([ev({ id: "a", lean: 1 }), ev({ id: "b", label: "Funding", state: "stale" })]);
    expect(r.limits.join(" ")).toMatch(/Funding .* stale/i);
  });
});

describe("missing evidence is reported, not swallowed", () => {
  it("separates a failure from an absence in the limits", () => {
    const r = synthesise([
      ev({ id: "a", lean: 1 }),
      failed("m", "model", "Regime model", 1, "service not running"),
      absent("o", "onchain", "On-chain", 1, "no chain for this instrument"),
    ]);
    const text = r.limits.join(" ");
    expect(text).toMatch(/Regime model/);
    expect(text).toMatch(/fixable/i);
    expect(text).toMatch(/On-chain/);
    expect(text).toMatch(/not the same as answering neutral/i);
    // The aggregate must not claim a cause it does not know: "absent" covers a
    // model nobody ran as much as a chain that does not exist for gold.
    expect(text).not.toMatch(/do not cover this instrument/i);
  });

  it("lists them in `missing`", () => {
    const r = synthesise([ev(), absent("o", "onchain", "On-chain", 1, "x")]);
    expect(r.missing.map((e) => e.id)).toEqual(["o"]);
  });

  it("produces no limits when everything answered and agreed", () => {
    expect(synthesise([ev({ id: "a", lean: 1 }), ev({ id: "b", lean: 1 })]).limits).toEqual([]);
  });
});

describe("ranking and flips", () => {
  it("ranks by contribution, not registration order", () => {
    const r = synthesise([
      ev({ id: "weak", lean: 0.1, weight: 0.2 }),
      ev({ id: "strong", lean: 0.9, weight: 1 }),
    ]);
    expect(r.evidence[0]?.id).toBe("strong");
  });

  it("surfaces flip conditions from the heaviest contributors", () => {
    const r = synthesise([
      ev({ id: "a", lean: 0.9, weight: 1, label: "Structure", flip: "a close below 100" }),
      ev({ id: "b", lean: 0.1, weight: 0.1, label: "Minor", flip: "irrelevant" }),
    ]);
    expect(r.wouldChange[0]).toBe("Structure: a close below 100");
  });

  it("caps the flip list rather than printing a wall", () => {
    const r = synthesise(
      Array.from({ length: 12 }, (_, i) => ev({ id: `a${i}`, lean: 0.5, flip: `flip ${i}` })),
    );
    expect(r.wouldChange.length).toBeLessThanOrEqual(4);
  });

  it("omits evidence with no flip", () => {
    const r = synthesise([ev({ id: "a", lean: 1 })]);
    expect(r.wouldChange).toEqual([]);
  });
});

describe("helpers", () => {
  it("ageCheck marks fresh evidence stale past the limit", () => {
    const e = ev({ asOf: 1_000, state: "fresh" });
    // age 200 against a 500 limit is still fresh; age 900 is not.
    expect(ageCheck(e, 500, 1_200).state).toBe("fresh");
    expect(ageCheck(e, 500, 1_900).state).toBe("stale");
    expect(ageCheck(e, 5_000, 1_200).state).toBe("fresh");
  });

  it("ageCheck leaves absent and failed alone", () => {
    expect(ageCheck(absent("a", "flow", "A", 1, "x"), 1, 999_999).state).toBe("absent");
    expect(ageCheck(failed("a", "flow", "A", 1, "x"), 1, 999_999).state).toBe("failed");
  });

  it("ageCheck ignores evidence with no timestamp", () => {
    expect(ageCheck(ev({ asOf: 0 }), 1, 999_999).state).toBe("fresh");
  });

  it("byGroup preserves the ranked order inside a group", () => {
    const g = byGroup([
      ev({ id: "a", group: "trend" }),
      ev({ id: "b", group: "flow" }),
      ev({ id: "c", group: "trend" }),
    ]);
    expect([...g.keys()]).toEqual(["trend", "flow"]);
    expect(g.get("trend")?.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("leanLabel names every band including the informational one", () => {
    expect(leanLabel(null)).toBe("context");
    expect(leanLabel(0.9)).toBe("strong long");
    expect(leanLabel(0.3)).toBe("long");
    expect(leanLabel(0)).toBe("flat");
    expect(leanLabel(-0.3)).toBe("short");
    expect(leanLabel(-0.9)).toBe("strong short");
  });
});

/* ==========================================================================
   THE DENOMINATOR

   Coverage is answered-weight over EXPECTED weight, and the whole value of the
   figure is that the denominator is honest. Two ways to corrupt it, in opposite
   directions, and this block pins both:

     · Dropping a source that could have answered flatters the read. Four of ten
       then presents exactly like four of four, which is the failure `coverage`
       was invented to prevent.
     · Counting a source the build does not HAVE deflates every read for ever.
       On-chain cost a fixed 0.3 of 6.9 — about four points of coverage on every
       instrument, permanently, for a watcher nobody had installed.
   ========================================================================== */

describe("coverage counts what was asked, and only what was asked", () => {
  const src = (
    id: string,
    state: Evidence["state"],
    weight = 1,
    lean: number | null = null,
  ): Evidence => ({
    id,
    group: "trend",
    label: id,
    lean,
    weight,
    reason: "",
    source: "t",
    asOf: 0,
    state,
  });

  it("counts an absent source against coverage, because it could have answered", () => {
    const r = synthesise([src("a", "fresh"), src("b", "absent")]);
    expect(r.coverage).toBe(0.5);
  });

  it("counts a failed source too — a fixable gap is still a gap", () => {
    const r = synthesise([src("a", "fresh"), src("b", "failed")]);
    expect(r.coverage).toBe(0.5);
  });

  /* The fix. One source out of the build is not a question that went
     unanswered; it is a question that was never asked. */
  it("leaves an unavailable source out of the denominator entirely", () => {
    const r = synthesise([src("a", "fresh"), src("b", "unavailable")]);
    expect(r.coverage).toBe(1);
  });

  /* ...but it is still RETURNED. Dropping it from the list would be the panel
     deciding what you are allowed to know it does not have. */
  it("still lists it, so nothing is hidden by not being counted", () => {
    const r = synthesise([src("a", "fresh"), src("b", "unavailable")]);
    expect(r.missing.map((e) => e.id)).toContain("b");
  });

  /* And it never contributes a lean. A source that cannot be asked has no
     opinion, whatever weight it was declared with. */
  it("never lets an unavailable source move the score", () => {
    const withIt = synthesise([src("a", "fresh", 1, 1), src("b", "unavailable", 1, -1)]);
    const without = synthesise([src("a", "fresh", 1, 1)]);
    expect(withIt.score).toBe(without.score);
    expect(withIt.coverage).toBe(without.coverage);
  });

  /* The degenerate case: nothing askable at all is 0% coverage, not 100%. An
     empty denominator must not divide its way to a confident read. */
  it("reports no coverage when every source is unavailable", () => {
    const r = synthesise([src("a", "unavailable"), src("b", "unavailable")]);
    expect(r.coverage).toBe(0);
  });
});
