import { describe, it, expect } from "vitest";
import { toDetectInput } from "../src/detect";
import type { Detection, DetectInput } from "../src/detect/types";
import { resolveAnchor, findAnchorDetection } from "../src/alert/anchor";
import { evaluateAlert } from "../src/alert/engine";
import { createAlertStore, alertId, requiredDetectors } from "../src/alert/store";
import { canAnchor, presetFor } from "../src/alert/preset";
import type { AlertSpec } from "../src/alert/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Bars from a list of closes; range is close +/- 1 unless overridden. */
function bars(closes: number[], t0 = T0): DetectInput {
  return toDetectInput(
    closes.map((c, i) => ({ t: t0 + i * HOUR, o: c, h: c + 1, l: c - 1, c, v: 100 })),
  );
}

function spec(over: Partial<AlertSpec> = {}): AlertSpec {
  return {
    id: "a1",
    symbol: "BTCUSDT",
    timeframe: "1h",
    anchor: { kind: "price", price: 100 },
    condition: "cross-above",
    once: false,
    cooldownBars: 0,
    enabled: true,
    createdAt: T0,
    note: "",
    ...over,
  };
}

const resolved = (s: AlertSpec, d: DetectInput, dets: readonly Detection[] = []) => {
  const r = resolveAnchor(s.anchor, d, dets);
  if (!r.ok) throw new Error(r.reason);
  return r.anchor;
};

describe("static price alerts", () => {
  it("fires on the bar whose close crosses", () => {
    const d = bars([90, 95, 99, 101, 105]);
    const s = spec();
    const f = evaluateAlert(s, d, resolved(s, d), { closedCount: 5 });
    expect(f).toHaveLength(1);
    expect(f[0]!.index).toBe(3);
    expect(f[0]!.price).toBe(101);
    expect(f[0]!.time).toBe(T0 + 3 * HOUR);
  });

  it("does not re-fire while price stays above — hysteresis, not a cooldown", () => {
    // Without this, a trend that crosses once produces an alert every bar for
    // the rest of the move, which is how a user learns to ignore alerts.
    const d = bars([90, 101, 102, 103, 104, 105]);
    const s = spec();
    expect(evaluateAlert(s, d, resolved(s, d), { closedCount: 6 })).toHaveLength(1);
  });

  it("re-arms only after price returns below", () => {
    const d = bars([90, 101, 95, 102]);
    const s = spec();
    const f = evaluateAlert(s, d, resolved(s, d), { closedCount: 4 });
    expect(f.map((x) => x.index)).toEqual([1, 3]);
  });

  it("honours a cooldown across a chopping price", () => {
    const d = bars([90, 101, 95, 102, 95, 103]);
    const s = spec({ cooldownBars: 4 });
    const f = evaluateAlert(s, d, resolved(s, d), { closedCount: 6 });
    expect(f.map((x) => x.index)).toEqual([1, 5]);
  });

  it("stops after the first fire when once is set", () => {
    const d = bars([90, 101, 95, 102]);
    const s = spec({ once: true });
    expect(evaluateAlert(s, d, resolved(s, d), { closedCount: 4 })).toHaveLength(1);
  });

  it("never fires on a forming bar", () => {
    // closedCount excludes the live bar. A close that has not happened yet is
    // the last trade, and it moves; firing on it means un-firing a second later.
    const d = bars([90, 95, 101]);
    const s = spec();
    expect(evaluateAlert(s, d, resolved(s, d), { closedCount: 2 })).toHaveLength(0);
    expect(evaluateAlert(s, d, resolved(s, d), { closedCount: 3 })).toHaveLength(1);
  });

  it("treats sitting exactly on the level as not-yet-above", () => {
    const d = bars([90, 100, 101]);
    const s = spec();
    const f = evaluateAlert(s, d, resolved(s, d), { closedCount: 3 });
    expect(f.map((x) => x.index)).toEqual([2]);
  });

  it("a wick through the level does not satisfy a close condition", () => {
    const d = toDetectInput([
      { t: T0, o: 90, h: 91, l: 89, c: 90, v: 1 },
      { t: T0 + HOUR, o: 99.5, h: 100.5, l: 99, c: 99.5, v: 1 },
    ]);
    const s = spec();
    expect(evaluateAlert(s, d, resolved(s, d), { closedCount: 2 })).toHaveLength(0);
  });

  it("touch fires on the wick and says the close did not confirm it", () => {
    const d = toDetectInput([
      { t: T0, o: 90, h: 91, l: 89, c: 90, v: 1 },
      { t: T0 + HOUR, o: 99.5, h: 100.5, l: 99, c: 99.5, v: 1 },
    ]);
    const s = spec({ condition: "touch" });
    const f = evaluateAlert(s, d, resolved(s, d), { closedCount: 2 });
    expect(f).toHaveLength(1);
    expect(f[0]!.reason).toMatch(/not confirmed by a close/);
  });
});

// ---------------------------------------------------------------------------

/** A trendline rising 1 unit per bar, complete (knowable) at bar 4. */
function trendline(): Detection {
  return {
    id: "t1",
    kind: "trendline",
    label: "Rising trendline",
    direction: "long",
    from: 0,
    to: 4,
    confidence: 0.7,
    reason: "three touches",
    shapes: [{ type: "line", x0: 0, y0: 100, x1: 4, y1: 104, tone: "bull", extend: true }],
  };
}

describe("structure-anchored alerts", () => {
  const anchorSpec = (over: Partial<AlertSpec> = {}) =>
    spec({
      anchor: {
        kind: "detection",
        detKind: "trendline",
        fromTime: T0,
        label: "Rising trendline",
        edge: "mid",
      },
      condition: "cross-below",
      ...over,
    });

  it("tracks the line as it rises — the anchor price differs every bar", () => {
    const d = bars(new Array(10).fill(200));
    const a = resolved(anchorSpec(), d, [trendline()]);
    expect(a.at(0)!.lo).toBe(100);
    expect(a.at(4)!.lo).toBe(104);
    // Extrapolation past the last touch is the entire point of the feature.
    expect(a.at(9)!.lo).toBe(109);
  });

  it("cannot fire on or before the bar the structure completed on", () => {
    // Closes are far below the line for the whole series. Bars 0..4 would all
    // "cross below" it, but the structure was not knowable until bar 4, so
    // firing there would be reading the future.
    const d = bars(new Array(10).fill(50));
    const s = anchorSpec();
    const a = resolved(s, d, [trendline()]);
    expect(a.validFrom).toBe(5);
    const f = evaluateAlert(s, d, a, { closedCount: 10 });
    for (const fire of f) expect(fire.index).toBeGreaterThan(4);
  });

  it("fires when a close breaks the projected line", () => {
    const closes = [200, 200, 200, 200, 200, 200, 200, 90, 90, 90];
    const d = bars(closes);
    const s = anchorSpec();
    const f = evaluateAlert(s, d, resolved(s, d, [trendline()]), { closedCount: 10 });
    expect(f.map((x) => x.index)).toEqual([7]);
    // 100 + 1/bar => 107 at bar 7. The reason must quote the PROJECTED price,
    // not the price the line had when it was drawn.
    expect(f[0]!.anchorPrice).toBeCloseTo(107, 6);
    expect(f[0]!.reason).toContain("107");
  });

  it("resolves by TIME, so prepending history does not retarget the anchor", () => {
    // The classic bug: an anchor stored as a bar index silently points at a
    // different structure the moment more history loads.
    const d = bars(new Array(10).fill(200));
    const shifted = bars(new Array(13).fill(200), T0 - 3 * HOUR);
    const det = trendline();
    const detShifted: Detection = { ...det, from: 3, to: 7 };
    const a = { kind: "detection", detKind: "trendline", fromTime: T0, label: "x", edge: "mid" } as const;

    expect(findAnchorDetection(a, d, [det])).toBe(det);
    expect(findAnchorDetection(a, shifted, [detShifted])).toBe(detShifted);
  });

  it("reports an orphan rather than silently never firing", () => {
    const d = bars(new Array(10).fill(200));
    const r = resolveAnchor(anchorSpec().anchor, d, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no longer detected/);
  });
});

describe("zone alerts", () => {
  const zone: Detection = {
    id: "z1",
    kind: "fvg",
    label: "Bullish FVG",
    direction: "long",
    from: 1,
    to: 2,
    confidence: 0.6,
    reason: "gap",
    shapes: [{ type: "box", x0: 1, x1: 3, y0: 100, y1: 110, tone: "bull", extend: true }],
  };
  const zoneSpec = (cond: AlertSpec["condition"]) =>
    spec({
      anchor: {
        kind: "detection",
        detKind: "fvg",
        fromTime: T0 + HOUR,
        label: "Bullish FVG",
        edge: "band",
      },
      condition: cond,
    });

  it("fires when a close enters the band", () => {
    const d = bars([200, 200, 200, 200, 105, 105]);
    const s = zoneSpec("enter");
    const f = evaluateAlert(s, d, resolved(s, d, [zone]), { closedCount: 6 });
    expect(f.map((x) => x.index)).toEqual([4]);
    expect(f[0]!.reason).toMatch(/inside Bullish FVG/);
  });

  it("fires when a close leaves the band, in either direction", () => {
    const d = bars([200, 200, 200, 105, 105, 90]);
    const s = zoneSpec("exit");
    const f = evaluateAlert(s, d, resolved(s, d, [zone]), { closedCount: 6 });
    expect(f.map((x) => x.index)).toEqual([5]);
  });

  it("a non-extending box stops being watchable past its right edge", () => {
    const closed: Detection = {
      ...zone,
      shapes: [{ type: "box", x0: 1, x1: 3, y0: 100, y1: 110, tone: "bull" }],
    };
    const d = bars(new Array(8).fill(105));
    const a = resolved(zoneSpec("enter"), d, [closed]);
    expect(a.at(3)).not.toBeNull();
    expect(a.at(4)).toBeNull();
  });
});

describe("the alert book", () => {
  const ctx = (d: DetectInput, dets: Detection[], closed: number) => ({
    symbol: "BTCUSDT",
    timeframe: "1h",
    data: d,
    detections: dets,
    closedCount: closed,
  });

  it("reports a fire once, however many times the pass runs", () => {
    // The evaluator re-walks all of history every tick by design; without
    // de-duplication that would be one notification per tick, forever.
    const store = createAlertStore();
    store.specs.set([spec()]);
    const d = bars([90, 95, 101, 102]);
    expect(store.evaluate(ctx(d, [], 4))).toHaveLength(1);
    expect(store.evaluate(ctx(d, [], 4))).toHaveLength(0);
    expect(store.evaluate(ctx(d, [], 4))).toHaveLength(0);
  });

  it("keeps the fire in the log even though it stops being new", () => {
    const store = createAlertStore();
    store.specs.set([spec()]);
    const d = bars([90, 95, 101]);
    store.evaluate(ctx(d, [], 3));
    store.evaluate(ctx(d, [], 3));
    expect(store.log()).toHaveLength(1);
  });

  it("ignores alerts belonging to another symbol or timeframe", () => {
    const store = createAlertStore();
    store.specs.set([spec({ symbol: "ETHUSDT" }), spec({ id: "a2", timeframe: "4h" })]);
    const d = bars([90, 95, 101]);
    expect(store.evaluate(ctx(d, [], 3))).toHaveLength(0);
    expect(store.runtimes()).toHaveLength(0);
  });

  it("marks a disabled alert off and an unresolvable one orphaned", () => {
    const store = createAlertStore();
    store.specs.set([
      spec({ id: "off1", enabled: false }),
      spec({
        id: "orph",
        anchor: { kind: "detection", detKind: "trendline", fromTime: T0, label: "gone", edge: "mid" },
      }),
    ]);
    const d = bars([90, 95, 101]);
    store.evaluate(ctx(d, [], 3));
    const byId = new Map(store.runtimes().map((r) => [r.spec.id, r]));
    expect(byId.get("off1")!.status).toBe("off");
    expect(byId.get("orph")!.status).toBe("orphaned");
    expect(byId.get("orph")!.statusNote).toMatch(/no longer detected/);
  });

  it("mints distinct ids", () => {
    expect(alertId(T0)).not.toBe(alertId(T0));
  });
});

describe("presets", () => {
  const det = (over: Partial<Detection>): Detection => ({
    id: "d",
    kind: "trendline",
    label: "L",
    direction: "long",
    from: 0,
    to: 2,
    confidence: 0.5,
    reason: "",
    shapes: [{ type: "line", x0: 0, y0: 1, x1: 2, y1: 2, tone: "bull" }],
    ...over,
  });

  it("watches a support line for the BREAK and a resistance line for the RECLAIM", () => {
    // The other way round is technically valid and practically useless.
    expect(presetFor(det({ direction: "long" })).condition).toBe("cross-below");
    expect(presetFor(det({ direction: "short" })).condition).toBe("cross-above");
  });

  it("watches an unmitigated zone for the RETURN, not the break", () => {
    const z = det({
      kind: "fvg",
      shapes: [{ type: "box", x0: 0, x1: 2, y0: 1, y1: 2, tone: "bull" }],
    });
    expect(presetFor(z).condition).toBe("enter");
    expect(presetFor(z).edge).toBe("band");
  });

  it("refuses to anchor to a structure that is only a marker", () => {
    expect(canAnchor(det({ shapes: [{ type: "marker", x: 1, y: 1, tone: "bull", text: "x", above: true }] }))).toBe(false);
  });

  it("only offers kinds with geometry an alert can follow", () => {
    expect(canAnchor(det({ kind: "trendline" }))).toBe(true);
    expect(canAnchor(det({ kind: "divergence" }))).toBe(false);
  });
});

describe("required detectors", () => {
  it("keeps an alert evaluable after its chart overlay is switched off", () => {
    // Turning off an overlay is a display preference. If it silently disarmed
    // the alert anchored to it, nobody would find out until the alert they
    // were relying on never arrived.
    const specs: AlertSpec[] = [
      spec({ anchor: { kind: "detection", detKind: "order-block", fromTime: T0, label: "OB", edge: "band" } }),
      spec({ id: "b", anchor: { kind: "detection", detKind: "choch", fromTime: T0, label: "CHoCH", edge: "mid" } }),
    ];
    expect(requiredDetectors(specs, "BTCUSDT", "1h").sort()).toEqual(["order-blocks", "structure"]);
  });

  it("ignores disabled alerts and other contexts — no detector runs for nothing", () => {
    const specs: AlertSpec[] = [
      spec({ enabled: false, anchor: { kind: "detection", detKind: "trendline", fromTime: T0, label: "T", edge: "mid" } }),
      spec({ id: "b", symbol: "ETHUSDT", anchor: { kind: "detection", detKind: "fvg", fromTime: T0, label: "F", edge: "band" } }),
      spec({ id: "c", anchor: { kind: "price", price: 1 } }),
    ];
    expect(requiredDetectors(specs, "BTCUSDT", "1h")).toEqual([]);
  });
});
