/**
 * WHAT THE MODEL HAS LEARNED, PER MARKET.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ACCURACY IS NOT SKILL, AND THIS IS THE SURFACE WHERE THAT MATTERS MOST
 *
 * A classifier that predicts the majority class scores the base rate exactly, so
 * "58% accurate" on a sample that is 58% winners has learned nothing at all and
 * reads as a result. `data/router.ts` already keeps `skill` as a field separate
 * from `accuracy` and only sets it when the model beat the base rate OUT OF
 * SAMPLE by more than its own noise — this board's whole job is to put those two
 * numbers side by side so the difference is visible rather than asserted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO SKILL IS A RESULT, NOT AN ERROR
 *
 * It is the most common honest answer a router can give, and a board that
 * renders it as a failure teaches the operator to ignore the one thing on it
 * that is reliably true. Three outcomes are kept apart: a model that learned
 * something, a model that did not, and a market where the question could not be
 * asked at all.
 */

import { describe, expect, it } from "vitest";
import { modelBoard, MIN_SCORED, MIN_AUC, noInfoRate } from "../src/backtest/scoreboard";
import type { AutoResult } from "../src/data/autorun";

const result = (over: Partial<AutoResult> = {}): AutoResult =>
  ({
    sym: "BTCUSDT",
    tf: "1h",
    src: "binance",
    bars: 40_000,
    from: 0,
    to: 0,
    rules: [],
    refused: [],
    pooled: 0,
    router: {
      ok: true,
      why: "",
      rows: 2_000,
      scored: 900,
      auc: 0.62,
      accuracy: 0.61,
      baseRate: 0.52,
      lift: 0.09,
      skill: true,
      folds: 5,
      timeOrdered: true,
      foldSpans: [],
      calibration: [],
      suggestedThreshold: 0.6,
      thresholdBasis: "calibrated",
      features: ["atrPct", "rsi"],
    },
    balance: 500,
    riskPct: 1,
    horizon: 20,
    at: 1_700_000_000,
    q: "q",
    ...over,
  }) as AutoResult;

describe("skill is reported apart from accuracy", () => {
  it("KEEPS THE BASE RATE BESIDE THE ACCURACY", () => {
    /* Without the base rate, 61% is unreadable: it is excellent against a 50%
       population and worthless against a 61% one. */
    const rows = modelBoard([result()]);
    expect(rows[0]?.accuracy).toBeCloseTo(0.61, 6);
    expect(rows[0]?.baseRate).toBeCloseTo(0.52, 6);
  });

  it("CALLS A MODEL THAT ONLY MATCHED THE BASE RATE no skill", () => {
    const rows = modelBoard([
      result({
        router: { ...(result().router as object), skill: false, accuracy: 0.58, baseRate: 0.58, lift: 0 } as never,
      }),
    ]);
    expect(rows[0]?.verdict).toBe("no skill");
    expect(rows[0]?.why).toMatch(/commonest outcome/i);
  });

  it("A MODEL WITH NO SKILL IS NOT AN ERROR", () => {
    /* Kept apart from "could not ask": one is an answer, the other is silence,
       and folding them together buries the answer. */
    const rows = modelBoard([
      result({ router: { ...(result().router as object), skill: false } as never }),
      result({ sym: "XAUUSD", router: { ok: false, why: "not enough decided claims" } }),
    ]);
    const kinds = rows.map((r) => r.verdict).sort();
    expect(kinds).toEqual(["could not ask", "no skill"]);
  });

  it("carries the service's own refusal verbatim rather than inventing one", () => {
    const rows = modelBoard([
      result({ router: { ok: false, why: "the quant service is not running" } }),
    ]);
    expect(rows[0]?.why).toContain("the quant service is not running");
  });
});

describe("THE COMPARISON IS THE MAJORITY CLASS, not the positive-class rate", () => {
  /* FOUND BY READING THE PANEL'S OWN OUTPUT on live data. It printed
     "74% accurate against a base rate of 27%" and called it `Learned something`
     — and a base rate of 27% means the positive class is 27% of the sample, so
     ALWAYS PREDICTING THE OTHER ONE scores 73%. The model's 74% is one point of
     nothing, and the sentence made it look like forty-seven.

     The service was right all along: its own `lift` field read +1, which is
     accuracy minus the NO-INFORMATION RATE. The board was misquoting it. */

  it("computes the no-information rate as max(p, 1 - p)", () => {
    expect(noInfoRate(0.27)).toBeCloseTo(0.73, 6);
    expect(noInfoRate(0.73)).toBeCloseTo(0.73, 6);
    expect(noInfoRate(0.5)).toBeCloseTo(0.5, 6);
  });

  it("QUOTES THE MAJORITY-CLASS RATE IN THE SENTENCE, never the raw base rate", () => {
    const rows = modelBoard([
      result({
        router: { ...(result().router as object), accuracy: 0.74, baseRate: 0.27, auc: 0.68, lift: 0.01 } as never,
      }),
    ]);
    expect(rows[0]?.why, "must compare against 73, not 27").toMatch(/73(\.\d)?%/);
    expect(rows[0]?.why, "the positive-class rate must not be the comparison").not.toMatch(/27(\.\d)?%/);
  });

  it("AN AUC NEAR 0.5 IS NOT SKILL, whatever the accuracy says", () => {
    /* AUC 0.5 means the model cannot rank one setup above another at all. An
       accuracy that looks high beside it is the majority class wearing a hat,
       and "an AUC near 0.5 presented as 62% confident loses money with
       conviction". */
    const rows = modelBoard([
      result({
        router: { ...(result().router as object), skill: true, auc: 0.51, accuracy: 0.74, baseRate: 0.27 } as never,
      }),
    ]);
    expect(rows[0]?.verdict).toBe("no skill");
    expect(rows[0]?.why).toMatch(/rank|AUC|coin/i);
  });

  it("still calls a model with real discrimination skilled", () => {
    const rows = modelBoard([
      result({
        router: { ...(result().router as object), skill: true, auc: 0.68, accuracy: 0.74, baseRate: 0.5, lift: 0.24 } as never,
      }),
    ]);
    expect(rows[0]?.verdict).toBe("skill");
  });

  it("names the AUC floor rather than hiding it", () => {
    expect(MIN_AUC).toBeGreaterThan(0.5);
    expect(MIN_AUC).toBeLessThan(0.7);
  });
});

describe("a thin sample cannot answer", () => {
  it("REFUSES A VERDICT BELOW THE SCORED FLOOR even when the service claimed skill", () => {
    /* The service has its own floor; this one is the desk's, and a board that
       trusted an upstream `skill: true` on forty rows would be quoting a number
       whose interval covers everything. */
    const rows = modelBoard([
      result({ router: { ...(result().router as object), scored: 40 } as never }),
    ]);
    expect(rows[0]?.verdict).toBe("too few");
    expect(rows[0]?.why).toMatch(/40|too few|floor/i);
  });

  it("names the floor rather than hiding it", () => {
    expect(MIN_SCORED).toBeGreaterThan(50);
  });
});

describe("the board itself", () => {
  it("is one row per market and bar size", () => {
    const rows = modelBoard([result(), result({ tf: "1d" }), result({ sym: "ETHUSDT" })]);
    expect(rows).toHaveLength(3);
  });

  it("PUTS THE MODELS THAT LEARNED SOMETHING FIRST", () => {
    const rows = modelBoard([
      result({ sym: "A", router: { ...(result().router as object), skill: false } as never }),
      result({ sym: "B" }),
    ]);
    expect(rows[0]?.symbol).toBe("B");
  });

  it("every row carries a sentence, and a REFUSAL is passed through verbatim", () => {
    /* MY FIRST VERSION REQUIRED EVERY SENTENCE TO EXCEED 15 CHARACTERS and the
       service's own "no ledger yet" is 13. The board is not responsible for the
       length of somebody else's words — padding a refusal would be inventing a
       second, worse answer over the one the service gave. So the rule is that a
       sentence EXISTS, and that the ones this file writes itself are useful. */
    const rows = modelBoard([result(), result({ sym: "X", router: { ok: false, why: "no ledger yet" } })]);
    for (const r of rows) expect(r.why.length, r.symbol).toBeGreaterThan(0);

    const refused = rows.find((r) => r.symbol === "X");
    expect(refused?.why, "the service's wording must survive").toBe("no ledger yet");

    const own = rows.find((r) => r.verdict === "skill");
    expect(own?.why.length, "a verdict this board writes must explain itself").toBeGreaterThan(30);
  });

  it("is empty rather than inventing a row when nothing has run", () => {
    expect(modelBoard([])).toHaveLength(0);
  });
});
