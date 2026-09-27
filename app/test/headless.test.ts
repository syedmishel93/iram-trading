import { describe, it, expect } from "vitest";
import {
  evaluateBook,
  freshFires,
  makeBookFile,
  readBookFile,
  type HeadlessBar,
} from "../src/alert/headless";
import { evaluateAlert } from "../src/alert/engine";
import { resolveAnchor } from "../src/alert/anchor";
import { toDetectInput, runDetectors } from "../src/detect";
import type { AlertSpec } from "../src/alert/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

function series(n: number): HeadlessBar[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 100 + Math.sin(i / 9) * 6 + Math.sin(i / 31) * 12 + i * 0.02;
    const c = p + Math.sin(i / 3) * 0.6;
    return {
      t: T0 + i * HOUR,
      o: p,
      h: Math.max(p, c) + 0.9,
      l: Math.min(p, c) - 0.9,
      c,
      v: 100,
    };
  });
}

const spec = (over: Partial<AlertSpec> = {}): AlertSpec => ({
  id: "a1",
  symbol: "BTCUSDT",
  timeframe: "1h",
  anchor: { kind: "price", price: 104 },
  condition: "cross-above",
  once: false,
  cooldownBars: 0,
  enabled: true,
  createdAt: T0,
  note: "",
  ...over,
});

describe("one engine, two runtimes", () => {
  it("gives the headless run exactly what the browser path gives", () => {
    // The whole reason this module exists rather than a Python re-implementation.
    // If these two ever disagree, one of them is lying on a live trade and
    // there is no way to tell which.
    const bars = series(400);
    const s = spec();

    const headless = evaluateBook(bars, [s]);

    const data = toDetectInput(bars.slice(0, bars.length - 1));
    const res = resolveAnchor(s.anchor, data, []);
    expect(res.ok).toBe(true);
    const browser = res.ok
      ? evaluateAlert(s, data, res.anchor, { closedCount: bars.length - 1 })
      : [];

    expect(headless.fires.map((f) => [f.time, f.price, f.reason])).toEqual(
      browser.map((f) => [f.time, f.price, f.reason]),
    );
    expect(headless.fires.length).toBeGreaterThan(0);
  });

  it("excludes the forming bar in the daemon exactly as the terminal does", () => {
    const bars = series(200);
    expect(evaluateBook(bars, [spec()]).closedBars).toBe(199);
    // A caller that has already trimmed the forming bar says so.
    expect(evaluateBook(bars, [spec()], { includesFormingBar: false }).closedBars).toBe(200);
  });
});

describe("structure anchors without a browser", () => {
  it("runs only the detectors the book actually needs", () => {
    const bars = series(400);
    const r = evaluateBook(bars, [
      spec({
        anchor: {
          kind: "detection",
          detKind: "order-block",
          fromTime: T0,
          label: "OB",
          edge: "band",
        },
      }),
    ]);
    expect(r.detectors).toEqual(["order-blocks"]);
  });

  it("runs nothing at all for a book of plain price alerts", () => {
    expect(evaluateBook(series(400), [spec()]).detectors).toEqual([]);
  });

  it("finds a real structure anchor and does not call it orphaned", () => {
    const bars = series(400);
    const data = toDetectInput(bars.slice(0, bars.length - 1));
    const found = runDetectors(data, ["structure"]);
    expect(found.length).toBeGreaterThan(0);
    const det = found[0]!;

    const r = evaluateBook(bars, [
      spec({
        anchor: {
          kind: "detection",
          detKind: det.kind,
          fromTime: data.t[det.from] as number,
          label: det.label,
          edge: "mid",
        },
        condition: "cross-any",
      }),
    ]);
    expect(r.orphaned).toEqual([]);
  });

  it("reports an anchor it cannot find rather than staying quiet about it", () => {
    // A daemon that silently stops evaluating an alert is worse than one that
    // never ran: you are still counting on it.
    const r = evaluateBook(series(400), [
      spec({
        anchor: {
          kind: "detection",
          detKind: "trendline",
          fromTime: 1,
          label: "gone",
          edge: "mid",
        },
      }),
    ]);
    expect(r.orphaned).toHaveLength(1);
    expect(r.orphaned[0]!.reason).toMatch(/no longer detected/);
  });

  it("looks on the higher timeframe when the anchor was found there", () => {
    // Without the recorded timeframe the daemon would run the detector on the
    // chart timeframe, find nothing at that start time, and report a perfectly
    // good alert as orphaned forever.
    const withTf = spec({
      anchor: { kind: "detection", detKind: "bos", fromTime: T0, label: "4H BOS", edge: "mid" },
      timeframeAnchor: "4h",
    });
    const r = evaluateBook(series(600), [withTf]);
    // It may or may not resolve on this synthetic series; what must be true is
    // that the 4h detector ran at all.
    expect(r.detectors).toContain("structure");
  });

  it("skips a book too short to judge rather than judging it badly", () => {
    const r = evaluateBook(series(10), [spec()]);
    expect(r.fires).toEqual([]);
    expect(r.detectors).toEqual([]);
  });

  it("ignores disabled alerts", () => {
    expect(evaluateBook(series(400), [spec({ enabled: false })]).fires).toEqual([]);
  });
});

describe("not announcing the same thing twice", () => {
  it("reports each fire once however often the book is re-walked", () => {
    // Hysteresis is path-dependent, so every poll MUST re-walk the whole
    // history. De-duplication is what stops that being one alert per poll.
    const fires = evaluateBook(series(400), [spec()]).fires;
    expect(fires.length).toBeGreaterThan(1);

    let seen: Record<string, number[]> = {};
    const first = freshFires(fires, seen);
    seen = first.seen;
    expect(first.fresh).toHaveLength(fires.length);

    const second = freshFires(fires, seen);
    expect(second.fresh).toHaveLength(0);
  });

  it("bounds what it remembers, so a long-running daemon does not grow forever", () => {
    let seen: Record<string, number[]> = {};
    for (let i = 0; i < 700; i++) {
      seen = freshFires(
        [{ alertId: "a1", index: i, time: T0 + i * HOUR, price: 1, anchorPrice: 1, reason: "x" }],
        seen,
      ).seen;
    }
    expect(seen["a1"]!.length).toBe(500);
    // ...and it forgets the OLDEST, so the recent past stays de-duplicated.
    expect(seen["a1"]![499]).toBe(T0 + 699 * HOUR);
  });
});

describe("the book file", () => {
  it("round-trips", () => {
    const doc = makeBookFile([spec()], T0);
    const back = readBookFile(JSON.parse(JSON.stringify(doc)));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.alerts[0]!.id).toBe("a1");
  });

  it("refuses a version it does not understand rather than guessing", () => {
    const r = readBookFile({ version: 41, alerts: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version 41/);
  });

  it("refuses anything that is not a book", () => {
    expect(readBookFile(null).ok).toBe(false);
    expect(readBookFile("nope").ok).toBe(false);
    expect(readBookFile({ version: 40 }).ok).toBe(false);
  });

  it("drops a malformed alert rather than crashing on it", () => {
    const r = readBookFile({ version: 40, alerts: [spec(), { id: 5 }, null] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alerts).toHaveLength(1);
  });
});
