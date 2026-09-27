/**
 * The setup engine.
 *
 * The tests that matter here are the REFUSALS. A selector that always returns
 * something is not a selector, and the bug it replaced — highest confidence
 * anywhere on the chart, wins — always returned something.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_BARS,
  MIN_SETUP_SCORE,
  candidatesFrom,
  chooseSetup,
  chosenLine,
  invalidationOf,
  liveBarsFor,
  type EngineInputs,
} from "../src/setup/engine";
import type { Detection, Shape } from "../src/detect/types";

const det = (over: Partial<Detection> = {}): Detection => ({
  id: over.id ?? "d1",
  kind: "trendline",
  label: "Trendline",
  direction: "long",
  from: 0,
  to: 100,
  confidence: 0.7,
  reason: "three touches",
  shapes: [{ type: "level", x0: 0, y: 95, tone: "bull" }],
  ...over,
});

const base: EngineInputs = {
  detections: [],
  atBar: 100,
  price: 100,
  atr: 4,
  bias: "long",
  conviction: 0.6,
  maxAtrMultiple: 3,
  minAtrMultiple: 0.5,
};

describe("finding where the idea is wrong", () => {
  it("takes the nearest level on the losing side", () => {
    /* The one price would break FIRST. Whatever the pattern is called, that is
       the level that settles the question. */
    const shapes: Shape[] = [
      { type: "level", x0: 0, y: 90, tone: "bull" },
      { type: "level", x0: 0, y: 97, tone: "bull" },
      { type: "level", x0: 0, y: 105, tone: "bear" },
    ];
    expect(invalidationOf(shapes, "long", 100, 100)).toBe(97);
    expect(invalidationOf(shapes, "short", 100, 100)).toBe(105);
  });

  it("evaluates a sloping line at the live bar, not at its endpoints", () => {
    /* A trendline's invalidation is where the line is NOW. Using an endpoint
       is the difference between a stop on the line and a stop where the line
       was two weeks ago. */
    const shapes: Shape[] = [{ type: "line", x0: 0, y0: 50, x1: 100, y1: 90, tone: "bull" }];
    expect(invalidationOf(shapes, "long", 100, 100)).toBeCloseTo(90, 6);
    expect(invalidationOf(shapes, "long", 100, 50)).toBeCloseTo(70, 6);
  });

  it("uses the far edge of a zone, because entering one invalidates nothing", () => {
    const shapes: Shape[] = [{ type: "box", x0: 0, x1: 10, y0: 92, y1: 96, tone: "bull" }];
    expect(invalidationOf(shapes, "long", 100, 100)).toBe(92);
  });

  it("returns null when the pattern marks no level", () => {
    /* A divergence has no price. That is an answer, not a defect — and it must
       not be papered over with a substitute, which is how a made-up level
       becomes a real-looking stop. */
    const shapes: Shape[] = [{ type: "marker", x: 10, y: 100, tone: "bull", text: "div", above: false }];
    expect(invalidationOf(shapes, "long", 100, 100)).toBeNull();
  });

  it("ignores levels on the winning side", () => {
    const shapes: Shape[] = [{ type: "level", x0: 0, y: 110, tone: "bull" }];
    expect(invalidationOf(shapes, "long", 100, 100)).toBeNull();
  });
});

describe("what counts as a candidate", () => {
  it("drops context that is true but not tradeable", () => {
    /* You do not enter on "there is a range". */
    const d = candidatesFrom({
      ...base,
      detections: [
        det({ id: "a", kind: "range", direction: "long" }),
        det({ id: "b", kind: "session-range", direction: "short" }),
        det({ id: "c", kind: "trendline" }),
      ],
    });
    expect(d.map((c) => c.id)).toEqual(["c"]);
  });

  it("drops neutral detections", () => {
    expect(candidatesFrom({ ...base, detections: [det({ direction: "neutral" })] })).toEqual([]);
  });
});

describe("refusing, which the old selector could not do", () => {
  it("says there is no setup when nothing directional was found", () => {
    const r = chooseSetup({ ...base, detections: [] });
    expect(r.best).toBeNull();
    expect(r.refusal).toMatch(/no directional setup/i);
    /* The exact distinction the card was getting wrong: absence of an idea is
       not a gate refusing one. v59 stopped SAYING so in words; what has to
       hold is that the refusal never blames a gate. */
    expect(r.refusal).not.toMatch(/gate/i);
  });

  it("refuses a stale setup instead of naming the card after it", () => {
    /* The old rule was highest confidence anywhere on the chart. A pattern
       confirmed four hundred bars back would win and could not be taken. */
    const r = chooseSetup({
      ...base,
      atBar: 500,
      detections: [det({ to: 100, confidence: 0.95 })],
    });
    expect(r.best).toBeNull();
    expect(r.refusal).toMatch(/none of the \d+ setups? found can still be taken/i);
    expect(r.waitingFor).toMatch(/400 bars ago/);
    /* Kept in the field, though. "Four candidates, all expired" is a different
       chart from "no candidates" and the operator should see which it is. */
    expect(r.ranked).toHaveLength(1);
  });

  it("refuses one that price has already run past", () => {
    const r = chooseSetup({
      ...base,
      price: 200,
      detections: [det({ to: 100, shapes: [{ type: "level", x0: 0, y: 95, tone: "bull" }] })],
    });
    expect(r.best).toBeNull();
    expect(r.waitingFor).toMatch(/missed it/i);
    expect(r.waitingFor).toMatch(/26\.3× ATR past the level/);
  });

  it("refuses when too little of the ranking had an input", () => {
    /* A high score built on two factors out of five is a coin flip wearing a
       number. */
    const r = chooseSetup({
      ...base,
      bias: null,
      atr: NaN,
      detections: [
        det({
          to: 100,
          shapes: [{ type: "marker", x: 1, y: 1, tone: "bull", text: "x", above: true }],
        }),
      ],
    });
    expect(r.best).toBeNull();
    expect(r.refusal).toMatch(/had only [0-9]+% of the data it needs/i);
  });
});

describe("choosing between real candidates", () => {
  it("prefers the one that agrees with the read over a more confident one that does not", () => {
    /* THE HEADLINE BUG. The old selector would name the card "double top ·
       SHORT" while the direction underneath said LONG, because 0.95 > 0.6. */
    const r = chooseSetup({
      ...base,
      bias: "long",
      conviction: 0.8,
      detections: [
        det({ id: "against", kind: "double-top", label: "Double top", direction: "short", confidence: 0.95,
              shapes: [{ type: "level", x0: 0, y: 105, tone: "bear" }] }),
        det({ id: "with", kind: "trendline", direction: "long", confidence: 0.6,
              shapes: [{ type: "level", x0: 0, y: 96, tone: "bull" }] }),
      ],
    });
    expect(r.best?.candidate.id).toBe("with");
    /* The loser stays visible with the conflict named, because a chart whose
       best-looking structure points the other way is worth knowing about. */
    const against = r.ranked.find((x) => x.candidate.id === "against");
    expect(against?.disqualified).toMatch(/read is long/i);
  });

  it("refuses outright when every candidate opposes the read", () => {
    /* Not a low score — a mechanical impossibility. The plan's direction comes
       from the read, so a short candidate's invalidation sits ABOVE entry on a
       long plan, and a stop above entry is not a stop. */
    const r = chooseSetup({
      ...base,
      bias: "long",
      detections: [
        det({ id: "s1", direction: "short", shapes: [{ type: "level", x0: 0, y: 104, tone: "bear" }] }),
      ],
    });
    expect(r.best).toBeNull();
    expect(r.waitingFor).toMatch(/cannot supply the stop/i);
  });

  it("prefers the fresher of two identical setups", () => {
    const r = chooseSetup({
      ...base,
      atBar: 120,
      detections: [
        det({ id: "old", to: 90 }),
        det({ id: "new", to: 118 }),
      ],
    });
    expect(r.best?.candidate.id).toBe("new");
  });

  it("prefers one that names a level over one that does not", () => {
    const r = chooseSetup({
      ...base,
      detections: [
        det({ id: "vague", kind: "divergence", shapes: [{ type: "marker", x: 1, y: 1, tone: "bull", text: "d", above: true }] }),
        det({ id: "level", kind: "order-block", shapes: [{ type: "level", x0: 0, y: 96, tone: "bull" }] }),
      ],
    });
    expect(r.best?.candidate.id).toBe("level");
  });

  it("carries a sentence for every factor, scored or not", () => {
    /* Same contract as the confluence engine: a number nobody can check is not
       evidence. */
    const r = chooseSetup({ ...base, detections: [det()] });
    expect(r.best).not.toBeNull();
    for (const f of r.best?.factors ?? []) {
      expect(f.note.length).toBeGreaterThan(10);
    }
  });

  it("reports how much of the ranking actually had an input", () => {
    /* 0.9, not 1: the journal record is the one factor with no input for an
       operator who has not resolved a trade of this kind yet, and saying so is
       the point of the figure. */
    const full = chooseSetup({ ...base, detections: [det()] });
    expect(full.best?.grounded).toBeCloseTo(0.9, 6);

    const thin = chooseSetup({ ...base, bias: null, detections: [det()] });
    expect(thin.best?.grounded).toBeLessThan(0.9);
  });
});

describe("the one learned input", () => {
  const withRecord = (wins: number, losses: number): EngineInputs => ({
    ...base,
    detections: [det()],
    record: () => ({ wins, losses }),
  });

  it("uses the low end of the interval, so a lucky streak cannot promote a setup", () => {
    /* Three wins from three is not a 100% win rate. */
    const lucky = chooseSetup(withRecord(3, 0));
    const proven = chooseSetup(withRecord(60, 40));
    const luckyScore = lucky.best?.factors.find((f) => f.id === "record")?.score ?? 0;
    const provenScore = proven.best?.factors.find((f) => f.id === "record")?.score ?? 0;
    expect(luckyScore).toBeLessThan(provenScore);
  });

  it("counts nothing either way when nothing has resolved", () => {
    const r = chooseSetup({ ...base, detections: [det()] });
    const rec = r.best?.factors.find((f) => f.id === "record");
    expect(rec?.score).toBeNull();
    expect(rec?.note).toMatch(/not counted either way/i);
  });

  it("does not let a bad record alone sink a setup below the floor", () => {
    /* It is one factor at weight 0.1. A ranking in which the journal can veto
       the chart is a ranking that has stopped reading the chart. */
    const r = chooseSetup(withRecord(0, 20));
    expect(r.best).not.toBeNull();
    expect(r.best?.score).toBeGreaterThan(MIN_SETUP_SCORE);
  });
});

describe("determinism", () => {
  it("returns the same answer for the same chart, every time", () => {
    /* A selector that can return two answers for one chart cannot be held to a
       track record, and the track record is the only thing that makes any of
       this checkable. */
    const input: EngineInputs = {
      ...base,
      detections: [det({ id: "a" }), det({ id: "b", to: 99 }), det({ id: "c", direction: "short" })],
    };
    const first = JSON.stringify(chooseSetup(input));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(chooseSetup(input))).toBe(first);
  });
});

describe("how long a setup stays live", () => {
  it("is time, not a bar count, wherever the clamps do not bind", () => {
    /* A trading week. 1h and 4h are the range where the rule itself decides. */
    expect(liveBarsFor(3_600_000)).toBe(120);
    expect(liveBarsFor(4 * 3_600_000)).toBe(30);
  });

  it("clamps intraday, where a week of bars would be absurd", () => {
    /* A week on a one-minute chart is 7,200 bars. Calling a structure from
       7,200 bars ago "live" would make the freshness factor meaningless. */
    expect(liveBarsFor(60_000)).toBe(120);
    expect(liveBarsFor(15 * 60_000)).toBe(120);
  });

  it("clamps up on the daily, where a week is too few bars to be a window", () => {
    expect(liveBarsFor(86_400_000)).toBe(20);
    expect(liveBarsFor(7 * 86_400_000)).toBe(20);
  });

  it("falls back rather than returning nonsense for a bad interval", () => {
    expect(liveBarsFor(0)).toBe(DEFAULT_LIVE_BARS);
    expect(liveBarsFor(NaN)).toBe(DEFAULT_LIVE_BARS);
  });
});

describe("saying how the winner was arrived at", () => {
  const many = (n: number): Detection[] =>
    Array.from({ length: n }, (_, k) =>
      det({ id: `d${k}`, to: 100 - k, shapes: [{ type: "level", x0: 0, y: 96 - k * 0.01, tone: "bull" }] }),
    );

  it("names the field size, so 'the only one here' reads differently from 'best of ninety'", () => {
    const line = chosenLine(chooseSetup({ ...base, atBar: 100, detections: many(6) }));
    expect(line).toMatch(/best of 6 found/);
  });

  it("counts what was thrown out", () => {
    const r = chooseSetup({
      ...base,
      atBar: 100,
      detections: [...many(3), det({ id: "stale", to: -500 })],
    });
    expect(chosenLine(r)).toMatch(/1 no longer takeable/);
  });

  it("warns when the win was too narrow to mean anything", () => {
    /* Two DIFFERENT ideas scoring the same: the name at the top is close to
       arbitrary and the card must not present it as a finding. */
    const r = chooseSetup({
      ...base,
      atBar: 100,
      detections: [
        det({ id: "a", to: 100 }),
        det({ id: "b", to: 100, label: "Order block", kind: "order-block" }),
      ],
    });
    expect(chosenLine(r, 4)).toMatch(/close call/);
  });

  it("does not call one idea seen twice a tie", () => {
    /* Higher-timeframe projections put the same structure on the chart more
       than once. Measured on ETHUSDT 1d, where a sell-side sweep and its 15m
       projection tied by construction and the card announced the ambiguity of
       a field that had none. */
    const r = chooseSetup({
      ...base,
      atBar: 100,
      detections: [
        det({ id: "a", kind: "liquidity-sweep", label: "Sell-side sweep", to: 100,
              shapes: [{ type: "level", x0: 0, y: 96, tone: "bull" }] }),
        det({ id: "a-htf", kind: "liquidity-sweep", label: "15m · sell-side sweep", to: 100,
              shapes: [{ type: "level", x0: 0, y: 96.2, tone: "bull" }] }),
      ],
    });
    expect(chosenLine(r, 4)).not.toMatch(/arbitrary/);
    expect(chosenLine(r, 4)).not.toMatch(/clear of/);
  });

  it("says nothing at all when there is no setup", () => {
    expect(chosenLine(chooseSetup({ ...base, detections: [] }))).toBe("");
  });
});
