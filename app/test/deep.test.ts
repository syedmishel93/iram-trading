/**
 * Deep-history replay.
 *
 * `createDeepReplay` is mostly wiring around `simulateKind`, which has its own
 * suite. What is tested here is the part that is NOT wiring: which kinds get a
 * base rate at all, and whether a kind with no usable history appears carrying
 * its refusal or vanishes from the map. Those two look identical at a call
 * site written with `?.`, and only one of them is a fact about the market.
 */

import { describe, expect, it } from "vitest";
import { replayAll } from "../src/setup/deep";
import type { Detection, DetectInput, Shape } from "../src/detect/types";

function flat(n: number, price = 100): { data: DetectInput; len: number } {
  const arr = (f: (i: number) => number): Float64Array => Float64Array.from({ length: n }, (_, i) => f(i));
  return {
    data: {
      t: arr((i) => 1_700_000_000_000 + i * 900_000),
      o: arr(() => price),
      h: arr(() => price + 1),
      l: arr(() => price - 1),
      c: arr(() => price),
      v: arr(() => 1000),
    },
    len: n,
  };
}

const level = (y: number): Shape => ({ type: "level", x0: 0, y, tone: "neutral" });

const det = (kind: string, direction: "long" | "short" | "neutral", to: number): Detection =>
  ({
    id: `${kind}-${direction}-${to}`,
    kind,
    label: kind,
    direction,
    from: Math.max(0, to - 5),
    to,
    confidence: 0.6,
    reason: "fixture",
    shapes: [level(direction === "long" ? 95 : 105)],
  }) as Detection;

describe("replayAll", () => {
  it("produces one entry per kind and direction actually present", () => {
    const { data, len } = flat(400);
    const dets = [
      det("double-bottom", "long", 50),
      det("double-bottom", "long", 120),
      det("double-top", "short", 80),
      det("bos", "long", 200),
    ];
    const out = replayAll(dets, data, len, 2, 0.5);
    expect([...out.keys()].sort()).toEqual(["bos|long", "double-bottom|long", "double-top|short"]);
  });

  it("keeps a kind whose history is empty, carrying its refusal", () => {
    /* The whole point. An absent key and a key holding "no completed instance"
       both read as falsy through `?.`, and the caller cannot tell "this never
       happens here" from "nobody asked". */
    const { data, len } = flat(400);
    /* Inside the unresolvable tail, so it is present but not replayable. */
    const out = replayAll([det("double-bottom", "long", len - 3)], data, len, 2, 0.5);
    expect(out.has("double-bottom|long")).toBe(true);
    expect(out.get("double-bottom|long")?.n).toBe(0);
    expect(out.get("double-bottom|long")?.note).toMatch(/only reports|no completed instance/i);
  });

  it("skips context kinds, which are not setups", () => {
    /* You do not enter on "there is a range". Same exclusion as the engine's
       CONTEXT_ONLY, and if the two ever disagree the card will offer a base
       rate for something it will never choose. */
    const { data, len } = flat(400);
    const dets = [
      det("range", "long", 100),
      det("session-range", "short", 110),
      det("level", "long", 120),
      det("equal-highs", "short", 130),
      det("expansion", "long", 140),
      det("equal-lows", "long", 150),
      det("choch", "long", 160),
    ];
    const out = replayAll(dets, data, len, 2, 0.5);
    expect([...out.keys()]).toEqual(["choch|long"]);
  });

  it("ignores neutral detections, which have no side to be right about", () => {
    const { data, len } = flat(400);
    const out = replayAll([det("bos", "neutral", 100)], data, len, 2, 0.5);
    expect(out.size).toBe(0);
  });

  it("prices every kind at the same R, so the entries are comparable", () => {
    const { data, len } = flat(400);
    const dets = [det("double-bottom", "long", 60), det("double-top", "short", 90)];
    const out = replayAll(dets, data, len, 3, 0.5);
    for (const sim of out.values()) {
      for (const t of sim.trials) {
        const risk = Math.abs(t.entry - t.stop);
        expect(Math.abs(t.target - t.entry) / risk).toBeCloseTo(3, 6);
      }
    }
  });

  it("applies the operator's ATR floor to every kind", () => {
    const { data, len } = flat(400);
    const dets = [det("double-bottom", "long", 60)];
    /* The fixture's level sits 5 from entry and one ATR on this series is 2, so
       a floor of 2 ATR does NOT bind — 4 is inside 5, and the geometric stop
       correctly wins. The floor has to exceed the geometry before it can be
       observed at all, which is the behaviour, not a workaround for it. */
    const tight = replayAll(dets, data, len, 2, 0);
    const floored = replayAll(dets, data, len, 2, 5);
    const riskOf = (m: ReturnType<typeof replayAll>): number => {
      const t = m.get("double-bottom|long")?.trials[0];
      return t ? Math.abs(t.entry - t.stop) : NaN;
    };
    expect(riskOf(floored)).toBeGreaterThan(riskOf(tight));
  });
});
