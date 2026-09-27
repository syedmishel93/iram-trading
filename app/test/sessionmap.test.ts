import { describe, it, expect } from "vitest";
import {
  SESSIONS,
  OVERLAP,
  sessionOpenAt,
  sessionStatuses,
  activityGrid,
  busiest,
  localOffsetHours,
  MIN_CELL_SAMPLES,
} from "../src/data/sessionmap";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/** Bars on an exact hourly grid from a known UTC instant. */
function hourlyBars(count: number, startIso: string, rangeFor: (d: Date) => number): BarView[] {
  const t0 = Date.parse(startIso);
  const out: BarView[] = [];
  for (let i = 0; i < count; i++) {
    const t = t0 + i * HOUR;
    const d = new Date(t);
    const c = 100;
    const half = (rangeFor(d) * c) / 2;
    out.push({ t, o: c, h: c + half, l: c - half, c, v: 1 });
  }
  return out;
}

describe("session windows", () => {
  it("has the four majors", () => {
    expect(SESSIONS.map((s) => s.id)).toEqual(["sydney", "tokyo", "london", "newyork"]);
  });

  it("reads a normal window", () => {
    const london = SESSIONS.find((s) => s.id === "london")!;
    expect(sessionOpenAt(london, 7)).toBe(true);
    expect(sessionOpenAt(london, 15)).toBe(true);
    expect(sessionOpenAt(london, 16)).toBe(false); // close is exclusive
    expect(sessionOpenAt(london, 6)).toBe(false);
  });

  it("handles the window that wraps midnight", () => {
    /* Sydney runs 21:00 to 06:00. A naive `h >= open && h < close` is false for
       every hour of it, which is the bug this case exists for. */
    const sydney = SESSIONS.find((s) => s.id === "sydney")!;
    expect(sessionOpenAt(sydney, 22)).toBe(true);
    expect(sessionOpenAt(sydney, 2)).toBe(true);
    expect(sessionOpenAt(sydney, 12)).toBe(false);
    expect(sessionOpenAt(sydney, 6)).toBe(false);
  });

  it("normalises hours outside 0-23", () => {
    const tokyo = SESSIONS.find((s) => s.id === "tokyo")!;
    expect(sessionOpenAt(tokyo, 24)).toBe(sessionOpenAt(tokyo, 0));
    expect(sessionOpenAt(tokyo, -1)).toBe(sessionOpenAt(tokyo, 23));
  });

  it("puts the overlap inside both London and New York", () => {
    const london = SESSIONS.find((s) => s.id === "london")!;
    const ny = SESSIONS.find((s) => s.id === "newyork")!;
    for (let h = OVERLAP.openUtc; h < OVERLAP.closeUtc; h++) {
      expect(sessionOpenAt(london, h), `london @${h}`).toBe(true);
      expect(sessionOpenAt(ny, h), `ny @${h}`).toBe(true);
    }
  });

  it("reports open sessions and a positive time to the next change", () => {
    const at = Date.parse("2026-03-04T13:00:00Z"); // Wednesday, overlap
    const st = sessionStatuses(at);
    const byId = new Map(st.map((s) => [s.session.id, s]));
    expect(byId.get("london")?.open).toBe(true);
    expect(byId.get("newyork")?.open).toBe(true);
    expect(byId.get("tokyo")?.open).toBe(false);
    for (const s of st) {
      expect(s.hoursUntilChange, s.session.id).toBeGreaterThan(0);
      expect(s.hoursUntilChange, s.session.id).toBeLessThanOrEqual(24);
    }
  });

  it("never reports a zero or negative countdown at a boundary", () => {
    /* Exactly on the open. `boundary - hour` is 0, and a countdown of "0 hours"
       that never ticks is the classic off-by-one here. */
    const st = sessionStatuses(Date.parse("2026-03-04T07:00:00Z"));
    for (const s of st) expect(s.hoursUntilChange).toBeGreaterThan(0);
  });
});

describe("the activity grid", () => {
  it("refuses to fill a grid from bars coarser than an hour", () => {
    /* Daily bars all land in one hour column. A 7x24 grid drawn from them shows
       23 empty columns that read as quiet hours — a data-shape artefact
       rendered as a market fact. */
    const daily: BarView[] = [];
    for (let i = 0; i < 200; i++) {
      const t = Date.parse("2026-01-01T00:00:00Z") + i * 24 * HOUR;
      daily.push({ t, o: 100, h: 101, l: 99, c: 100, v: 1 });
    }
    const g = activityGrid(daily);
    expect(g.tooCoarse).toBe(true);
    expect(g.cells).toEqual([]);
    expect(g.note).toContain("coarser than an hour");
  });

  it("returns an empty grid for too few bars", () => {
    expect(activityGrid([]).cells).toEqual([]);
    expect(activityGrid([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }]).cells).toEqual([]);
  });

  it("covers all 168 cells when the history is long enough", () => {
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", () => 0.01);
    const g = activityGrid(bars);
    expect(g.cells).toHaveLength(168);
    expect(g.sufficientCells).toBe(168);
    expect(g.totalSamples).toBe(bars.length);
  });

  it("measures a genuinely busier hour as busier", () => {
    /* 13:00 UTC gets four times the range of every other hour. */
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", (d) =>
      d.getUTCHours() === 13 ? 0.04 : 0.01,
    );
    const g = activityGrid(bars);
    const hot = g.cells.filter((c) => c.hour === 13);
    const cold = g.cells.filter((c) => c.hour === 3);
    for (const c of hot) expect(c.meanRange).toBeCloseTo(0.04, 6);
    for (const c of cold) expect(c.meanRange).toBeCloseTo(0.01, 6);
    expect(busiest(g, 7).every((c) => c.hour === 13)).toBe(true);
  });

  it("ranks a perfectly uniform grid as typical, not as quietest", () => {
    /* Mid-rank for ties. Counting only strictly-smaller values puts every cell
       of a flat grid at rank 0 — the quietest reading available — when the
       truth is that every one of them is exactly average. */
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", () => 0.01);
    const g = activityGrid(bars);
    for (const c of g.cells) expect(c.rank).toBeCloseTo(0.5, 6);
  });

  it("marks thin cells and leaves them out of the ranking", () => {
    /* Two weeks: every cell gets 2 samples, well under the threshold. */
    const bars = hourlyBars(24 * 7 * 2, "2026-01-05T00:00:00Z", () => 0.01);
    const g = activityGrid(bars);
    expect(g.cells.every((c) => c.samples === 2)).toBe(true);
    expect(g.cells.every((c) => !c.sufficient)).toBe(true);
    expect(g.cells.every((c) => Number.isNaN(c.rank))).toBe(true);
    expect(g.sufficientCells).toBe(0);
    expect(g.note).toContain("Nothing here is worth reading");
  });

  it("does not let a thin cell outrank the sufficient ones", () => {
    /* One wildly volatile hour with only a couple of samples must not become
       the brightest square on the map. */
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", () => 0.01);
    /* Add two enormous bars in a cell nothing else reaches: Saturday 05:00. */
    const t = Date.parse("2026-06-06T05:00:00Z");
    bars.push({ t, o: 100, h: 150, l: 50, c: 100, v: 1 });
    const g = activityGrid(bars);
    const spike = g.cells.find((c) => c.weekday === 6 && c.hour === 5);
    expect(spike).toBeDefined();
    /* It has plenty of samples from the regular series, so it IS sufficient —
       the guard that matters is that busiest() only ever returns sufficient
       cells, checked below on a genuinely thin grid. */
    const thin = activityGrid(hourlyBars(24 * 7 * 2, "2026-01-05T00:00:00Z", () => 0.01));
    expect(busiest(thin)).toEqual([]);
  });

  it("ignores bars with a non-finite or negative range", () => {
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", () => 0.01);
    const good = activityGrid(bars).totalSamples;
    bars.push({ t: Date.parse("2026-06-06T05:00:00Z"), o: 100, h: NaN, l: 99, c: 100, v: 1 });
    bars.push({ t: Date.parse("2026-06-06T06:00:00Z"), o: 100, h: 101, l: 99, c: 0, v: 1 });
    expect(activityGrid(bars).totalSamples).toBe(good);
  });

  it("buckets in UTC regardless of the host timezone", () => {
    /* The bucket a bar lands in is a property of the bar, not of the machine
       reading it. `getUTCHours` is what guarantees that. */
    const bars = hourlyBars(24 * 7 * 12, "2026-01-05T00:00:00Z", (d) =>
      d.getUTCHours() === 13 ? 0.04 : 0.01,
    );
    const g = activityGrid(bars);
    const hot = g.cells.filter((c) => c.meanRange > 0.02);
    expect(new Set(hot.map((c) => c.hour))).toEqual(new Set([13]));
  });
});

describe("local offset", () => {
  it("is a number of hours, sane in magnitude", () => {
    const off = localOffsetHours();
    expect(Number.isFinite(off)).toBe(true);
    expect(Math.abs(off)).toBeLessThanOrEqual(14);
  });
});

describe("thresholds", () => {
  it("keeps the minimum sample count where the note claims it is", () => {
    const bars = hourlyBars(24 * 7 * MIN_CELL_SAMPLES, "2026-01-05T00:00:00Z", () => 0.01);
    const g = activityGrid(bars);
    expect(g.cells.every((c) => c.samples >= MIN_CELL_SAMPLES)).toBe(true);
    expect(g.sufficientCells).toBe(168);
  });
});
