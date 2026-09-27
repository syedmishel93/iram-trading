// @vitest-environment jsdom
/**
 * Key levels: ranking, merging and refusals over fixtures shaped exactly as the
 * detectors emit them (see the file:line notes), then the card's DOM. Every
 * expected value is written out, never taken from the code under test.
 */

import { describe, expect, it } from "vitest";
import type { Detection, DetectionKind, Shape } from "../src/detect/types";
import { DETECTOR_FOR_KIND } from "../src/detect/index";
import { keyLevels } from "../src/scan/keylevels";
import { createLevelsCard, levelLine } from "../src/ui/cards/levelscard";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";

let seq = 0;
const det = (kind: DetectionKind, shapes: Shape[], label = kind, direction: Detection["direction"] = "neutral"): Detection => ({
  id: `${kind}-${seq++}`,
  kind,
  label,
  direction,
  from: 10,
  to: 20,
  confidence: 0.6,
  reason: "fixture",
  shapes,
});

/** structure.ts: one `level` shape per S/R level. */
const sr = (y: number): Detection => det("level", [{ type: "level", x0: 10, y, tone: "accent", dashed: true, label: String(y) }], "resistance");
/** zones.ts: order block box, `extend: mitigatedAt < 0`. */
const ob = (lo: number, hi: number, fresh = true): Detection =>
  det("order-block", [{ type: "box", x0: 10, x1: 20, y0: lo, y1: hi, tone: "bull", extend: fresh, dashed: true, label: "OB" }], "Bullish order block", "long");
const fvg = (lo: number, hi: number, fresh = true): Detection =>
  det("fvg", [{ type: "box", x0: 10, x1: 20, y0: lo, y1: hi, tone: "bear", extend: fresh, label: "FVG" }], "Bearish FVG", "short");
/** structure.ts: a break is a LINE, not a level. */
const bos = (): Detection =>
  det("bos", [{ type: "line", x0: 5, y0: 100, x1: 20, y1: 100, tone: "bull", label: "BOS" }], "Break of structure", "long");
const pin = (): Detection =>
  det("pin-bar", [{ type: "marker", x: 20, y: 99, tone: "bull", text: "PIN", above: false }], "Pin bar", "long");

describe("keyLevels refusals", () => {
  it("refuses without a usable price", () => {
    expect(keyLevels([sr(101)], null).state).toBe("no-price");
    expect(keyLevels([sr(101)], Number.NaN).state).toBe("no-price");
    expect(keyLevels([sr(101)], 0).state).toBe("no-price");
  });

  it("says the detectors found nothing when the list is empty", () => {
    expect(keyLevels([], 100)).toEqual({ state: "none", reason: "The detectors found nothing on this chart.", total: 0 });
  });

  it("refuses when every structure is an event rather than a price", () => {
    const r = keyLevels([bos(), pin()], 100);
    expect(r.state).toBe("none");
    if (r.state !== "none") return;
    // PINS THE FACT, not the sentence. The wording changed in v63.21 so the
    // refusal could name its CAUSE when level detectors are switched off; a
    // test that pinned the old string would have failed for the wrong reason
    // and taught the next person to re-paste rather than read.
    expect(r.reason).toContain("None of the 2 marks");
    expect(r.reason).toContain("is a price level");
    // With no `enabled` supplied the caller could not say why, so the wording
    // stays neutral rather than blaming a setting it cannot see.
    expect(r.reason).toContain("events such as breaks");
  });

  it("leaves confluence bands out, so a chart of only bands has no levels", () => {
    const band = det("confluence", [
      { type: "box", x0: 0, x1: 20, y0: 101, y1: 102, tone: "accent", extend: true, label: "3 sources" },
      { type: "level", x0: 0, y: 101.5, tone: "accent", label: "101.5", dashed: true },
    ]);
    expect(keyLevels([band], 100).state).toBe("none");
  });
});

describe("keyLevels ranking", () => {
  it("keeps the three nearest on each side, nearest first, named by side", () => {
    const r = keyLevels([sr(107), sr(101), sr(105), sr(103), sr(97), sr(99)], 100);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.above.map((l) => l.price)).toEqual([101, 103, 105]);
    expect(r.below.map((l) => l.price)).toEqual([99, 97]);
    expect(r.above[0]?.kinds).toEqual(["resistance"]);
    expect(r.below[0]?.kinds).toEqual(["support"]);
    expect(r.above[0]?.distancePct).toBeCloseTo(1, 10);
    expect(r.below[1]?.distancePct).toBeCloseTo(3, 10);
    expect(r.total).toBe(6);
    expect(r.contributing).toBe(6);
  });

  it("measures a zone from the edge facing price", () => {
    const r = keyLevels([ob(102, 104), fvg(96, 98)], 100);
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above[0]).toMatchObject({ price: 102, low: 102, high: 104, kinds: ["order block"], used: "fresh" });
    expect(r.below[0]).toMatchObject({ price: 98, low: 96, high: 98, kinds: ["fair value gap"] });
  });

  it("puts a zone price is inside in neither list", () => {
    const r = keyLevels([ob(99.5, 100.5), sr(103)], 100);
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above.map((l) => l.price)).toEqual([103]);
    expect(r.below).toEqual([]);
    expect(r.inside).toHaveLength(1);
    expect(r.inside[0]).toMatchObject({ low: 99.5, high: 100.5, distancePct: 0 });
  });

  it("splits a range into its high and its low", () => {
    const range = det("range", [{ type: "box", x0: 0, x1: 20, y0: 95, y1: 105, tone: "neutral", dashed: true, label: "30 bars" }]);
    const r = keyLevels([range], 100);
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above[0]).toMatchObject({ price: 105, kinds: ["range high"] });
    expect(r.below[0]).toMatchObject({ price: 95, kinds: ["range low"] });
  });

  it("names a prior-day pair and reports a taken one", () => {
    /* anchors.ts: `dashed: takenHigh`. */
    const prior = det(
      "prior-level",
      [
        { type: "level", x0: 0, y: 104, tone: "neutral", label: "Prior dayH", dashed: true },
        { type: "level", x0: 0, y: 96, tone: "bull", label: "Prior dayL", dashed: false },
      ],
      "Prior day high / low",
    );
    const r = keyLevels([prior], 100);
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above[0]).toMatchObject({ kinds: ["prior day high"], used: "used", usedWord: "taken" });
    expect(r.below[0]).toMatchObject({ kinds: ["prior day low"], used: "fresh", usedWord: "" });
  });
});

describe("keyLevels merging", () => {
  it("merges within a quarter ATR and counts both detections", () => {
    const r = keyLevels([sr(101), sr(101.2)], 100, { atr: 1 });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above).toHaveLength(1);
    expect(r.above[0]).toMatchObject({ price: 101, low: 101, high: 101.2, count: 2 });
    expect(r.tolerance.basis).toBe("atr");
    expect(r.tolerance.value).toBe(0.25);
  });

  it("falls back to 0.1% of price without an ATR, and says so", () => {
    const r = keyLevels([sr(101), sr(101.2)], 100);
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above).toHaveLength(2);
    expect(r.tolerance.basis).toBe("price");
    expect(r.tolerance.value).toBeCloseTo(0.1, 12);
    expect(r.tolerance.text).toContain("no ATR was available");
  });

  it("merges different kinds and lists both names, nearest first", () => {
    const r = keyLevels([sr(101), ob(100.9, 101.05)], 100, { atr: 1 });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above).toHaveLength(1);
    expect(r.above[0]).toMatchObject({ price: 100.9, kinds: ["order block", "resistance"], count: 2 });
  });

  it("counts one detection once, however many of its lines land together", () => {
    /* anchors.ts: one fib detection, one `level` per ratio. */
    const fib = det("fib", [
      { type: "level", x0: 0, y: 101, tone: "neutral", label: "0.618", dashed: true },
      { type: "level", x0: 0, y: 101.1, tone: "neutral", label: "0.705", dashed: true },
    ]);
    const r = keyLevels([fib], 100, { atr: 1 });
    if (r.state !== "ok") throw new Error(r.state);
    expect(r.above).toHaveLength(1);
    expect(r.above[0]).toMatchObject({ count: 1, kinds: ["fib 0.618", "fib 0.705"] });
  });

  it("reports mitigated only when every recording member was used", () => {
    const used = keyLevels([fvg(101, 101.1, false), sr(101.2)], 100, { atr: 1 });
    if (used.state !== "ok") throw new Error(used.state);
    expect(used.above[0]).toMatchObject({ used: "used", usedWord: "mitigated", count: 2 });

    const mixed = keyLevels([fvg(101, 101.1, false), ob(101.15, 101.3, true)], 100, { atr: 1 });
    if (mixed.state !== "ok") throw new Error(mixed.state);
    expect(mixed.above[0]).toMatchObject({ used: "fresh", usedWord: "" });

    const unknown = keyLevels([sr(101)], 100);
    if (unknown.state !== "ok") throw new Error(unknown.state);
    expect(unknown.above[0]?.used).toBe("unknown");
  });
});

// -------------------------------------------------------------------- DOM ---

const fmtPx = (v: number): string => v.toFixed(2);

describe("the refusal names its cause when levels are switched off", () => {
  /* MEASURED on the owner's terminal: 29 detectors exist, 9 ship enabled, and
     a saved preference had left exactly ONE on — `structure`, which emits BOS
     and CHoCH and no levels at all. The old sentence was true and read as
     "the market has no levels here", which is a different claim. */
  it("names the detectors to turn on, and where", () => {
    const r = keyLevels([bos(), bos()], 100, { enabled: ["structure"] });
    expect(r.state).toBe("none");
    expect(r.reason).toContain("switched off");
    expect(r.reason).toContain("Auto-marking");
  });

  it("stays neutral when every level detector is already on", () => {
    // Nothing to switch on, so blaming a setting would be wrong. The neutral
    // wording is the honest one here.
    const every = Object.values(DETECTOR_FOR_KIND) as string[];
    const r = keyLevels([bos()], 100, { enabled: every });
    expect(r.reason).not.toContain("switched off");
    expect(r.reason).toContain("events such as breaks");
  });

  it("says it in the singular when only one is off", () => {
    const allButLevels = (Object.values(DETECTOR_FOR_KIND) as string[]).filter((d) => d !== "levels");
    const r = keyLevels([bos()], 100, { enabled: allButLevels });
    expect(r.reason).toContain(" is switched off");
    expect(r.reason).toContain("turn it on");
  });

  it("an EMPTY chart also says why, not just that it is empty", () => {
    // "The detectors found nothing" with 28 of 29 off is the same misdirection
    // one step earlier.
    const r = keyLevels([], 100, { enabled: ["structure"] });
    expect(r.reason).toContain("found nothing");
    expect(r.reason).toContain("switched off");
  });
});

describe("createLevelsCard", () => {
  it("shows the refusal when there is no price", () => {
    const el = createLevelsCard({ detections: () => [sr(101)], price: () => null, fmtPx });
    expect(el.querySelector(".pk-empty")?.textContent).toBe("No current price yet, so nothing can be called above or below it.");
    expect(el.querySelectorAll(".lv-row")).toHaveLength(0);
  });

  it("shows the empty reason when no structure is a level", () => {
    const el = createLevelsCard({ detections: () => [bos()], price: () => 100, fmtPx });
    expect(el.querySelector(".pk-empty")?.textContent).toContain("None of the 1 mark");
  });

  it("draws a row per level, the price marker between, and picks on click", () => {
    const picked: number[] = [];
    const list = [sr(101), sr(101.2), sr(103), sr(99), bos()];
    const el = createLevelsCard({
      detections: () => list,
      price: () => 100,
      fmtPx,
      atr: () => 1,
      onPick: (p) => picked.push(p),
    });
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".lv-row")];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "101.00 · resistance · 1.0% · ×2",
      "103.00 · resistance · 3.0%",
      "99.00 · support · 1.0%",
    ]);
    expect(el.querySelector(".lv-now-px")?.textContent).toBe("100.00 now");
    expect(el.querySelector(".lv-note")?.textContent).toBe("From the 5 structures the detectors found on this chart.");
    rows[1]?.click();
    expect(picked).toEqual([103]);
  });

  it("repaints when the price moves", async () => {
    const price = signal<number | null>(100);
    const el = createLevelsCard({ detections: () => [sr(101), sr(99)], price, fmtPx });
    price.set(100.5);
    /* A computed settles on a microtask; the paint waits for a frame. */
    await Promise.resolve();
    flushFrames();
    expect(el.querySelector(".lv-row")?.getAttribute("aria-label")).toBe("101.00 · resistance · 0.5%");
  });

  it("levelLine leaves the count off a single detection", () => {
    const r = keyLevels([sr(84920)], 84581.84);
    if (r.state !== "ok") throw new Error(r.state);
    const only = r.above[0];
    if (!only) throw new Error("no level");
    expect(levelLine(only, (v) => v.toLocaleString("en-US"))).toBe("84,920 · resistance · 0.4%");
  });
});
