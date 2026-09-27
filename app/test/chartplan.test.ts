import { describe, it, expect } from "vitest";
import { planShapes, PLAN_LOOKBACK } from "../src/setup/chartplan";
import type { TradePlan } from "../src/setup/plan";

const plan = (over: Partial<TradePlan> = {}): TradePlan => ({
  direction: "long",
  entryLow: 99,
  entryHigh: 101,
  entry: 100,
  stop: 95,
  target1: 105,
  target2: 110,
  r: 5,
  stopAtrMultiple: 1.2,
  stopFrom: "structure",
  structureOutOfReach: null,
  drawnAt: 100,
  ...over,
});

describe("planShapes", () => {
  it("draws the entry zone, the stop and both targets from the live edge", () => {
    const shapes = planShapes(plan(), 500, "go");
    expect(shapes).toHaveLength(4);
    const [zone, stop, t1, t2] = shapes;
    expect(zone).toMatchObject({ type: "box", x0: 500 - PLAN_LOOKBACK, x1: 500, y0: 99, y1: 101, extend: true, dashed: false, label: "Entry zone" });
    expect(stop).toMatchObject({ type: "level", y: 95, tone: "bear", label: "Stop" });
    expect(t1).toMatchObject({ type: "level", y: 105, tone: "bull", label: "Target 1" });
    expect(t2).toMatchObject({ type: "level", y: 110, tone: "bull", label: "Target 2" });
  });

  it("dashes a plan that is not live and says so on the chart, not only in the panel", () => {
    for (const kind of ["stand-down", "unknown", "conflict"] as const) {
      const shapes = planShapes(plan(), 500, kind);
      for (const s of shapes) {
        expect(s.type === "marker" ? true : s.dashed, kind).toBe(true);
      }
      expect(shapes[0]).toMatchObject({ label: "Entry zone (not live)" });
    }
  });

  it("treats an armed plan as live: the gates pass, price has not arrived", () => {
    expect(planShapes(plan(), 500, "armed")[0]).toMatchObject({ dashed: false });
  });

  it("draws nothing without a plan or a bar to anchor it", () => {
    expect(planShapes(null, 500, "go")).toEqual([]);
    expect(planShapes(plan(), -1, "go")).toEqual([]);
  });

  it("never starts left of the first bar", () => {
    expect(planShapes(plan(), 3, "go")[0]).toMatchObject({ x0: 0 });
  });
});
