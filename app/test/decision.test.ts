import { describe, it, expect } from "vitest";
import { assemble, decide, WEIGHTS, type DecisionInputs } from "../src/core/decision";
import type { Detection } from "../src/detect/types";

const det = (over: Partial<Detection> = {}): Detection => ({
  id: "d1",
  kind: "bos",
  label: "Break of structure ↑",
  direction: "long",
  from: 10,
  to: 20,
  confidence: 0.8,
  reason: "close above the prior high",
  shapes: [],
  ...over,
});

const base: DecisionInputs = {
  symbol: "BTCUSDT",
  timeframe: "1h",
  now: 1_000_000,
  confluence: null,
  detections: [],
  higher: [],
  higherEnabled: [],
  regime: null,
  forecast: null,
  derivatives: null,
  fundamentals: null,
  spread: null,
  correlation: null,
  onchain: null,
  calendar: null,
  leading: null,
};

/** A leading read that answered, for fixtures that need coverage above the gate. */
const someLeading: DecisionInputs["leading"] = {
  ok: true,
  timing: 0.2,
  coiledReason: "Bandwidth is unremarkable.",
  thinningLean: 0,
  thinningReason: "The last two swings confirmed each other.",
  coverage: 1,
};

const find = (input: DecisionInputs, id: string) => assemble(input).find((e) => e.id === id);

describe("assemble — every source reports, even with nothing to say", () => {
  // A silent source is invisible to coverage, and the read then claims the same
  // confidence whether it consulted nine sources or two.
  it("returns one piece of evidence per contributor no matter what", () => {
    const all = assemble(base);
    expect(all.length).toBe(13);
    expect(new Set(all.map((e) => e.id)).size).toBe(13);
  });

  it("marks everything absent, failed or unavailable on empty input", () => {
    expect(
      assemble(base).every(
        (e) => e.state === "absent" || e.state === "failed" || e.state === "unavailable",
      ),
    ).toBe(true);
  });

  /**
   * `unavailable` is reserved for a source this BUILD does not have, and on-chain
   * is currently the only one — `shell.ts` passes a literal null and always has.
   * Everything else on empty input is `absent`: a real gap, in the denominator,
   * where it belongs.
   *
   * Getting this wrong in the permissive direction is a read grading itself on a
   * curve, so the list is asserted exactly rather than by count.
   */
  it("calls exactly one source unavailable, and it is the one with no subsystem", () => {
    const notCounted = assemble(base).filter((e) => e.state === "unavailable");
    expect(notCounted.map((e) => e.id)).toEqual(["onchain"]);
    expect(notCounted[0]?.reason).toMatch(/not counted against data coverage/i);
  });

  it("keeps a fixed order so the panel does not reshuffle", () => {
    expect(assemble(base).map((e) => e.id)).toEqual(assemble({ ...base, now: 2 }).map((e) => e.id));
  });
});

describe("calendar", () => {
  const cal = (discount: number, note = "USD NFP in 10 min (high impact).") => ({
    ...base,
    calendar: { ok: true, discount, note },
  });

  /**
   * THE WHOLE DESIGN OF THIS CONTRIBUTOR. It would be easy, and completely
   * wrong, to turn a hawkish forecast into a short lean — nobody knows how a
   * release lands until it lands. The calendar is context, never direction.
   */
  it("never leans, however imminent the release", () => {
    expect(find(cal(0.95), "calendar")?.lean).toBeNull();
    expect(find(cal(0), "calendar")?.lean).toBeNull();
  });

  it("counts toward coverage when it answered", () => {
    expect(find(cal(0.5), "calendar")?.state).toBe("fresh");
  });

  it("is absent rather than silent when not loaded", () => {
    expect(find(base, "calendar")?.state).toBe("absent");
  });

  it("reports a source failure as failed, not absent", () => {
    const e = find({ ...base, calendar: { ok: false, discount: 0, note: "", error: "proxy down" } }, "calendar");
    expect(e?.state).toBe("failed");
    expect(e?.reason).toMatch(/proxy down/);
  });

  it("says what would change it", () => {
    expect(find(cal(0.5), "calendar")?.flip).toMatch(/release itself/);
  });
});

describe("release discount", () => {
  /* A directional read, so there is confidence to discount in the first place. */
  const withEdge = (calendar: DecisionInputs["calendar"]): DecisionInputs => ({
    ...base,
    calendar,
    detections: [det({ direction: "long", confidence: 0.9 })],
    higher: [{ timeframe: "4h", bias: "long", score: 0.8 }],
    higherEnabled: ["4h"],
    /* Present so this fixture clears the coverage gate. Without it the read is
       gated to zero confidence for having consulted almost nothing, and the
       test would then be measuring the gate rather than the discount. */
    leading: someLeading,
  });

  it("cuts confidence as a release approaches", () => {
    const calm = decide(withEdge({ ok: true, discount: 0, note: "none" })).confidence;
    const near = decide(withEdge({ ok: true, discount: 0.8, note: "NFP in 5 min" })).confidence;
    expect(calm).toBeGreaterThan(0);
    expect(near).toBeLessThan(calm);
  });

  /**
   * Coverage and agreement are MEASUREMENTS of the evidence. A release does
   * not change how many sources answered or how much they agree, so the
   * discount must not touch them.
   */
  it("leaves coverage and agreement untouched", () => {
    const calm = decide(withEdge({ ok: true, discount: 0, note: "none" }));
    const near = decide(withEdge({ ok: true, discount: 0.8, note: "NFP in 5 min" }));
    expect(near.coverage).toBe(calm.coverage);
    expect(near.agreement).toBe(calm.agreement);
  });

  it("explains the cut in the limits rather than silently applying it", () => {
    const d = decide(withEdge({ ok: true, discount: 0.5, note: "USD NFP in 30 min" }));
    expect(d.limits.some((l) => /Confidence cut by 50%/.test(l))).toBe(true);
    expect(d.limits.some((l) => /USD NFP in 30 min/.test(l))).toBe(true);
  });

  // There is no arrangement of the calendar that earns MORE confidence than
  // the evidence supports.
  it("only ever reduces", () => {
    const calm = decide(withEdge({ ok: true, discount: 0, note: "none" }));
    for (const d of [0, 0.25, 0.5, 1]) {
      expect(decide(withEdge({ ok: true, discount: d, note: "x" })).confidence).toBeLessThanOrEqual(
        calm.confidence + 1e-12,
      );
    }
  });

  /**
   * A failed calendar must not carry a discount into the read. It DOES cost
   * coverage — that is a different effect and the correct one — so the
   * comparison here is against another failed calendar, isolating the discount
   * field itself rather than measuring coverage twice.
   */
  it("ignores the discount on a calendar that failed", () => {
    const loud = decide(withEdge({ ok: false, discount: 0.9, note: "", error: "down" }));
    const quiet = decide(withEdge({ ok: false, discount: 0, note: "", error: "down" }));
    expect(loud.confidence).toBeCloseTo(quiet.confidence, 10);
    expect(loud.limits.some((l) => /Confidence cut by/.test(l))).toBe(false);
  });

  it("costs coverage when it fails, which a working calendar does not", () => {
    const failed = decide(withEdge({ ok: false, discount: 0, note: "", error: "down" }));
    const working = decide(withEdge({ ok: true, discount: 0, note: "none" }));
    expect(failed.coverage).toBeLessThan(working.coverage);
  });
});

describe("structure", () => {
  it("takes the most recent directional break, not an average", () => {
    const e = find(
      { ...base, detections: [det({ direction: "short", confidence: 0.9 }), det({ direction: "long", confidence: 0.5 })] },
      "structure",
    );
    expect(e?.lean).toBeCloseTo(0.5, 9);
    expect(e?.reason).toMatch(/Break of structure/);
  });

  it("leans short for a downward break", () => {
    const e = find({ ...base, detections: [det({ direction: "short", confidence: 0.6 })] }, "structure");
    expect(e?.lean).toBeCloseTo(-0.6, 9);
  });

  it("is informational when only levels and zones were found", () => {
    const e = find({ ...base, detections: [det({ direction: "neutral", kind: "level" })] }, "structure");
    expect(e?.lean).toBeNull();
    expect(e?.state).toBe("fresh");
  });

  it("is absent when the detectors found nothing", () => {
    expect(find(base, "structure")?.state).toBe("absent");
  });

  it("always carries a flip condition when directional", () => {
    expect(find({ ...base, detections: [det()] }, "structure")?.flip).toMatch(/break the other way/i);
  });
});

describe("higher timeframes", () => {
  // An absence of context is not a neutral one.
  it("is absent — and says why — when none is enabled", () => {
    const e = find(base, "htf");
    expect(e?.state).toBe("absent");
    expect(e?.reason).toMatch(/missing context, not a neutral signal/i);
  });

  it("is absent when enabled but nothing has projected yet", () => {
    const e = find({ ...base, higherEnabled: ["4h"] }, "htf");
    expect(e?.state).toBe("absent");
    expect(e?.reason).toMatch(/4h enabled/);
  });

  it("averages the enabled timeframes", () => {
    const e = find(
      {
        ...base,
        higherEnabled: ["4h", "1d"],
        higher: [
          { timeframe: "4h", bias: "long", score: 1 },
          { timeframe: "1d", bias: "short", score: 1 },
        ],
      },
      "htf",
    );
    expect(e?.lean).toBeCloseTo(0, 9);
  });
});

describe("the forecast gate", () => {
  /**
   * The single most important gate in the file. An uncalibrated probability is
   * not weak evidence — it is not evidence, and admitting it at reduced weight
   * would launder noise into a number that looks considered.
   */
  it("withholds the probability entirely when the model is not usable", () => {
    const e = find(
      { ...base, forecast: { ok: true, pUp: 0.72, usable: false, standing: "Brier 0.26 is worse than saying 50%." } },
      "forecast",
    );
    expect(e?.lean).toBeNull();
    expect(e?.reason).toMatch(/Withheld/);
    expect(e?.reason).toMatch(/Brier 0\.26/);
  });

  it("still counts toward coverage when withheld", () => {
    const e = find({ ...base, forecast: { ok: true, pUp: 0.72, usable: false } }, "forecast");
    expect(e?.state).toBe("fresh");
    expect(e?.weight).toBe(WEIGHTS.forecast);
  });

  // p=0.6 is a lean of +0.2, not +0.6.
  it("centres a usable probability on a half and doubles it", () => {
    const e = find({ ...base, forecast: { ok: true, pUp: 0.6, usable: true } }, "forecast");
    expect(e?.lean).toBeCloseTo(0.2, 9);
  });

  it("records a service outage as failed, not absent", () => {
    const e = find({ ...base, forecast: { ok: false, error: "service not running" } }, "forecast");
    expect(e?.state).toBe("failed");
    expect(e?.reason).toMatch(/service not running/);
  });
});

describe("regime", () => {
  const at = (state: string, confidence: number) =>
    find({ ...base, regime: { ok: true, state, confidence } }, "regime");

  /* THE TEST THAT PASSED WHILE PRODUCTION WAS BROKEN.

     The old version of this asserted that `"CHOP"` leaned nothing — and
     `"CHOP"` is a string the model cannot produce. What it actually emitted
     was `"CHOP/TREND-DN"`, one label for two states, and that matched the
     bearish pattern in `fromRegime`. So a sideways market contributed a
     full-strength short lean at 0.63 confidence on BTCUSDT 1m while this file
     reported that chop leaned nothing. Asserting on a string the model cannot
     emit is not a test of the model. */
  it("gives the regime no direction, whatever the state says", () => {
    /* The weight table has always annotated this source "A statistical read on
       a regime, not on a direction". The code under it disagreed.

       The deeper reason, and the one no threshold fixes: the model is a
       mixture over (return, volatility), so it CLUSTERS ON RETURN and its
       states are separated by mean return by construction. On eight driftless
       random walks the fitted state still carried a direction on two. */
    for (const state of ["Drifting up", "Drifting down", "Sideways", "High volatility"]) {
      expect(at(state, 0.9)?.lean).toBe(0);
    }
  });

  it("still counts toward coverage — it answered", () => {
    /* Non-directional is not absent. A source that reports nothing at all is a
       gap in coverage; this one has a finding, and the finding is "here is
       what kind of market this has been". */
    const e = at("Sideways", 0.9);
    expect(e?.state).toBe("fresh");
    expect(e?.weight).toBeGreaterThan(0);
  });

  it("gives the pre-v53 labels the same treatment rather than dropping them", () => {
    /* A cached or replayed payload carries the old strings. */
    for (const state of ["TREND-UP", "CHOP/TREND-DN", "PANIC/high-vol"]) {
      expect(at(state, 0.7)?.lean).toBe(0);
      expect(at(state, 0.7)?.state).toBe("fresh");
    }
  });

  it("says the state is a description of the past, not a forecast", () => {
    expect(at("Drifting up", 0.5)?.reason).toMatch(/not where it goes next/i);
  });

  it("never claims to be a hidden Markov model", () => {
    expect(at("Drifting up", 0.5)?.reason ?? "").not.toMatch(/hidden Markov/i);
  });
});

describe("informational contributors never get a direction", () => {
  const fundamentals = {
    row: { rank: 1 } as never,
    derived: { float: 0.06, dilution: 2, turnover: 0.02, belowAth: 30, notes: ["Only 6.0% of the maximum supply is circulating."] },
    asOf: 1_000_000,
  } as unknown as DecisionInputs["fundamentals"];

  // A 6% float is not bullish. The moment it votes it becomes a thesis.
  it("fundamentals are always lean: null", () => {
    const e = find({ ...base, fundamentals }, "fundamentals");
    expect(e?.lean).toBeNull();
    expect(e?.reason).toMatch(/6\.0%/);
  });

  it("fundamentals name their self-reported source", () => {
    expect(find({ ...base, fundamentals }, "fundamentals")?.source).toMatch(/self-reported/i);
  });

  it("cross-venue is always lean: null", () => {
    const e = find(
      {
        ...base,
        spread: { ok: true, quotes: [{ venue: "A", price: 1, asOf: 0 }, { venue: "B", price: 1, asOf: 0 }], reference: 1, spreadPct: 0.01, high: "B", low: "A", note: "" },
      },
      "venue",
    );
    expect(e?.lean).toBeNull();
  });

  it("correlation is always lean: null", () => {
    const e = find(
      {
        ...base,
        correlation: {
          matrix: { symbols: ["A", "B"], pairs: [{ a: "A", b: "B", r: 0.9, overlap: 100 }], clustered: [], unjudged: [], note: "one bet" },
          openPositions: 2,
        },
      },
      "correlation",
    );
    expect(e?.lean).toBeNull();
    expect(e?.reason).toBe("one bet");
  });
});

describe("staleness", () => {
  // A real epoch: `base.now` is small, and an asOf computed by subtracting an
  // hour from it goes NEGATIVE — which ageCheck correctly reads as "no
  // timestamp" rather than as very old.
  const NOW = 1_700_000_000_000;

  it("marks an old derivatives read stale", () => {
    const derivatives = { read: { signals: [], insufficient: null }, asOf: NOW - 60 * 60_000 };
    expect(find({ ...base, now: NOW, derivatives }, "derivs")?.state).toBe("stale");
  });

  it("leaves a recent one fresh", () => {
    const derivatives = { read: { signals: [], insufficient: null }, asOf: NOW - 60_000 };
    expect(find({ ...base, now: NOW, derivatives }, "derivs")?.state).toBe("fresh");
  });

  it("treats a missing timestamp as not-applicable rather than ancient", () => {
    const derivatives = { read: { signals: [], insufficient: null }, asOf: 0 };
    expect(find({ ...base, now: NOW, derivatives }, "derivs")?.state).toBe("fresh");
  });
});

describe("decide", () => {
  const strongLong: DecisionInputs = {
    ...base,
    detections: [det({ direction: "long", confidence: 0.9 })],
    confluence: { bias: "long", score: 0.8, agreement: 0.9, confidence: 0.9, signals: [], insufficient: null },
    higherEnabled: ["4h"],
    higher: [{ timeframe: "4h", bias: "long", score: 0.8 }],
    regime: { ok: true, state: "TREND-UP", confidence: 0.7 },
  };

  it("leads with coverage rather than with the direction when support is thin", () => {
    const d = decide({ ...base, detections: [det()] });
    expect(d.confidence).toBe(0);
    expect(d.headline).toMatch(/^Weak/);
  });

  it("says there is no read when nothing answered", () => {
    expect(decide(base).headline).toMatch(/No data answered/);
  });

  it("names a direction once enough sources agree", () => {
    const d = decide(strongLong);
    expect(d.bias).toBe("long");
    expect(d.headline).toMatch(/^LONG, /);
    expect(d.headline).toMatch(/% of data answered/);
  });

  it("carries the symbol and timeframe it was computed for", () => {
    const d = decide(strongLong);
    expect(d.symbol).toBe("BTCUSDT");
    expect(d.timeframe).toBe("1h");
  });

  it("surfaces what would change the picture", () => {
    expect(decide(strongLong).wouldChange.length).toBeGreaterThan(0);
  });

  it("lists what did not answer", () => {
    const d = decide(strongLong);
    expect(d.missing.length).toBeGreaterThan(0);
    expect(d.limits.join(" ")).toMatch(/had nothing to say here|failed/i);
  });

  // The same agreeing sources with more missing around them is a weaker read.
  it("reports lower confidence for the same signal with worse coverage", () => {
    const rich = decide({
      ...strongLong,
      derivatives: { read: { signals: [{ id: "f", name: "Funding", direction: "long", value: "+", reason: "x" }], insufficient: null }, asOf: 1_000_000 },
      spread: { ok: true, quotes: [{ venue: "A", price: 1, asOf: 0 }, { venue: "B", price: 1, asOf: 0 }], reference: 1, spreadPct: 0, high: "B", low: "A", note: "" },
    });
    const thin = decide(strongLong);
    expect(rich.coverage).toBeGreaterThan(thin.coverage);
    expect(rich.confidence).toBeGreaterThan(thin.confidence);
  });
});

describe("the leading read, split along the axis it declares", () => {
  const withLeading = (over: Partial<NonNullable<DecisionInputs["leading"]>>): DecisionInputs => ({
    ...base,
    leading: { ...(someLeading as NonNullable<DecisionInputs["leading"]>), ...over },
  });

  /**
   * The property the whole leading module exists to protect. A compression
   * reading constrains WHEN a move happens and says nothing about which way,
   * so no arrangement of inputs may give this contributor a direction.
   */
  it("never lets compression carry a lean, however emphatic it is", () => {
    for (const timing of [0, 0.5, 1]) {
      expect(find(withLeading({ timing }), "coiled")?.lean).toBeNull();
    }
  });

  it("files compression as macro context rather than as a signal group", () => {
    expect(find(withLeading({}), "coiled")?.group).toBe("macro");
  });

  it("carries the compression sentence through verbatim", () => {
    const e = find(withLeading({ coiledReason: "Tightest 4% of the last 120 bars." }), "coiled");
    expect(e?.reason).toBe("Tightest 4% of the last 120 bars.");
  });

  it("gives participation a direction when it has one", () => {
    expect(find(withLeading({ thinningLean: -0.6 }), "thinning")?.lean).toBeCloseTo(-0.6, 9);
  });

  /* Null is not zero. A component with no reading must widen the coverage gap,
     not cast a neutral vote that drags a real divergence towards flat. */
  it("marks participation absent when it had no reading at all", () => {
    const e = find(withLeading({ thinningLean: null }), "thinning");
    expect(e?.state).toBe("absent");
    expect(e?.lean).toBeNull();
  });

  it("reports a failed leading read rather than a quiet neutral one", () => {
    const e = find({ ...base, leading: { ...(someLeading as NonNullable<DecisionInputs["leading"]>), ok: false, error: "not enough bars" } }, "thinning");
    expect(e?.state).toBe("failed");
    expect(e?.reason).toBe("not enough bars");
  });

  it("clamps a lean that arrives out of range instead of trusting it", () => {
    expect(find(withLeading({ thinningLean: -4 }), "thinning")?.lean).toBe(-1);
    expect(find(withLeading({ thinningLean: 4 }), "thinning")?.lean).toBe(1);
  });

  /**
   * Participation is weighted BELOW derivatives on purpose, and the two must
   * never be fed by the same measurement — funding and open interest are read
   * by `derivs`, so the leading composite contributes only its thinning family
   * here. Two contributors reading one number is the same vote counted twice.
   */
  it("weighs participation below derivatives", () => {
    expect(WEIGHTS.thinning).toBeLessThan(WEIGHTS.derivatives);
  });

  it("weighs compression no higher than the calendar, since neither points anywhere", () => {
    expect(WEIGHTS.coiled).toBeLessThanOrEqual(WEIGHTS.calendar);
  });

  it("says what would flip the participation read", () => {
    expect(find(withLeading({}), "thinning")?.flip).toMatch(/rising volume/);
  });
});
