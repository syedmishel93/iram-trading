import { describe, it, expect } from "vitest";
import { outlookLines } from "../src/ui/outlookpanel";
import type { Outlook, TouchOdds } from "../src/analysis/outlook";

const price = (v: number): string => v.toFixed(2);

/** A cone whose last step is hand-set: 100 now, 90–112 at the 24th bar. */
const outlook = (pUp: number): Outlook =>
  ({
    ok: true,
    cone: {
      ok: true,
      last: 100,
      steps: [{ h: 24, p5: 90, p25: 96, p50: 100.5, p75: 105, p95: 112 }],
      pUp,
      up: Math.round(pUp * 2000),
      sigmaNow: 0.01,
      n: 900,
      draws: 2000,
      horizon: 24,
      seed: 1,
      lambda: 0.94,
      basis: "modelled",
      assumptions: [],
    },
    paths: { last: 100, draws: 0, horizon: 24, closes: new Float64Array(0) },
    touch: () => ({ ok: false, refused: "unused" }),
  }) as Outlook;

const odds: TouchOdds = {
  ok: true,
  target1First: 0.41,
  stopFirst: 0.38,
  neither: 0.21,
  target2First: 0.2,
  counts: { target1: 820, stop: 760, neither: 420, target2: 400 },
  draws: 2000,
  horizon: 24,
  basis: "modelled",
  assumptions: [],
};

describe("outlookLines", () => {
  it("states the 9-in-10 range as prices and as moves from now", () => {
    const l = outlookLines(outlook(0.52), null, null, price);
    expect(l.range).toBe("Next 24 bars: 9 in 10 simulated paths end between 90.00 (−10.0%) and 112.00 (+12.0%).");
  });

  it("calls the up-share a base rate, never a direction", () => {
    const l = outlookLines(outlook(0.52), null, null, price);
    expect(l.lean).toBe("52% of paths end higher — a base rate from this instrument's own moves, not a call on direction.");
  });

  it("puts the target-first odds beside the break-even that R needs", () => {
    // Entry 100, stop 95, target 110: 2R, so break-even is 1/3 = 33%.
    const l = outlookLines(outlook(0.5), odds, { direction: "long", entry: 100, stop: 95, target1: 110 }, price);
    expect(l.odds).toBe(
      "Target 1 before the stop in 41% of paths, stop first in 38%, neither in 21%. At 2.00R the target needs to come first 33% of the time to break even.",
    );
  });

  it("gives no odds without a plan, and says why when the plan is refused", () => {
    expect(outlookLines(outlook(0.5), odds, null, price).odds).toBeNull();
    const refused = outlookLines(outlook(0.5), { ok: false, refused: "the last close is already through the stop" }, { direction: "long", entry: 100, stop: 95, target1: 110 }, price);
    expect(refused.odds).toBe("No odds for this plan: the last close is already through the stop");
  });
});

import { spreadLabels } from "../src/ui/outlookpanel";

describe("spreadLabels", () => {
  it("spreads three names that land within a few pixels to one line apart, in order", () => {
    const out = spreadLabels([{ t: "target", y: 50 }, { t: "now", y: 52 }, { t: "stop", y: 55 }], 11, 0, 200);
    expect(out.map((o) => [o.t, o.y])).toEqual([["target", 50], ["now", 61], ["stop", 72]]);
  });

  it("keeps the stack inside the plot when it would run off the bottom", () => {
    const out = spreadLabels([{ y: 95 }, { y: 96 }], 11, 0, 100);
    expect(out.map((o) => o.y)).toEqual([89, 100]);
  });

  it("leaves labels that are already apart where they are", () => {
    expect(spreadLabels([{ y: 10 }, { y: 40 }], 11, 0, 100).map((o) => o.y)).toEqual([10, 40]);
  });
});
