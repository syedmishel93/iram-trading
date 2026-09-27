/**
 * THE SCREENER'S CORRELATION ROW — how a measured pair becomes a drawn row.
 *
 * The row used to carry three things: the pair, a bar whose length is |r|, and
 * the coefficient. All three are about MAGNITUDE and SIGN, so a pair that
 * reversed inside the window rendered identically to a settled one — and a pair
 * that reversed comes back near zero, which draws as a SHORT bar reading "these
 * two are unrelated". The most misleading row on the block was the one with the
 * least ink on it.
 *
 * `viz/render.ts edgeStyle` is the precedent and this follows it channel for
 * channel: LENGTH is magnitude, COLOUR is sign, DASH and ALPHA are confidence.
 * They are never crossed — an inverse pair is not a weak pair, and a strong pair
 * that reversed is still strong.
 *
 * THREE STATES, NOT TWO. `edgeStyle` has settled and not; here the overlap can
 * also be too short to slice, and this repository's standing rule is that
 * "could not ask" is not "nothing there". `stable` is false for both, so the
 * style reads `instability` to tell them apart.
 */

import { describe, expect, it } from "vitest";
import { corrRowStyle } from "../src/ui/screener";
import type { CorrelationPair } from "../src/data/context";

const pair = (over: Partial<CorrelationPair> = {}): CorrelationPair => ({
  a: "BTCUSDT",
  b: "ETHUSDT",
  r: 0.82,
  samples: 200,
  instability: 0.12,
  stable: true,
  ...over,
});

describe("the screener's correlation row", () => {
  it("draws a settled pair solid", () => {
    const s = corrRowStyle(pair());
    expect(s.settled).toBe("yes");
    expect(s.sign).toBe("pos");
    expect(s.spread).toBe("0.12");
  });

  it("does NOT draw a reversed pair like a settled one", () => {
    // The whole point. Near-zero r, and the two are tightly related.
    const moved = corrRowStyle(pair({ r: 0.04, instability: 1.83, stable: false }));
    const settled = corrRowStyle(pair({ r: 0.04, instability: 0.09, stable: true }));
    expect(moved.settled).toBe("no");
    expect(settled.settled).toBe("yes");
    expect(moved.settled).not.toBe(settled.settled);
    // and the figure itself is on screen, not only encoded in the styling.
    expect(moved.spread).toBe("1.83");
  });

  it("separates 'it moved' from 'nobody could ask'", () => {
    /* Both are `stable: false`, and they are different facts: one is a
       measured reversal, the other is an overlap too short to slice. Folding
       them together would file a missing check as a finding. */
    const unknown = corrRowStyle(pair({ instability: NaN, stable: false }));
    expect(unknown.settled).toBe("unknown");
    expect(unknown.why).toMatch(/too short|not enough/i);
    // An em dash, never a 0 - 0 would read as "re-measured, and it never moved".
    expect(unknown.spread).toBe("—");
  });

  it("keeps sign and magnitude in their own channels", () => {
    // An inverse pair is not a weak pair: -0.9 is as long a bar as +0.9.
    const up = corrRowStyle(pair({ r: 0.9 }));
    const down = corrRowStyle(pair({ r: -0.9 }));
    expect(up.width).toBe(down.width);
    expect(up.sign).toBe("pos");
    expect(down.sign).toBe("neg");
    expect(up.width).toBe("90%");
  });

  it("names the window in every state, because a figure with no window is a point estimate", () => {
    for (const p of [pair(), pair({ stable: false, instability: 1.6 }), pair({ instability: NaN, stable: false })]) {
      expect(corrRowStyle(p).why).toMatch(/200 overlapping bars/);
    }
  });
});
