/**
 * What the chart shades behind price, and why it is the overlaps.
 *
 * The first version painted one wash per OPEN session and let the alpha stack.
 * It looked like a broken grid, and the reason is the first test below: over a
 * 24-hour market the four windows tile the whole day, so "a session is open" is
 * true of every bar and shading it carries no information at all. Sampling the
 * live canvas agreed — the plain background colour appeared nowhere inside the
 * data, only one wash or two.
 *
 * These tests pin the finding, so nobody restores the old behaviour by
 * reasoning that shading a session sounds more natural than shading a gap
 * between them.
 */

import { describe, expect, it } from "vitest";
import { sessionsOpenAt, type SessionBand } from "../src/chart/engine";
import { SESSIONS } from "../src/data/sessionmap";

/** The shipped windows, in the shape the chart engine takes them. */
const BANDS: SessionBand[] = SESSIONS.map((s) => ({
  id: s.id,
  openUtc: s.openUtc,
  closeUtc: s.closeUtc,
  colour: "rgba(255,255,255,0.022)",
}));

const HOURS = Array.from({ length: 24 }, (_, h) => h);

describe("the four sessions tile the day — the reason the old shading said nothing", () => {
  it("has at least one session open at every hour", () => {
    for (const h of HOURS) {
      expect(sessionsOpenAt(h, BANDS), `hour ${h}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("never has all four open at once", () => {
    // If it did, the wash would have a fourth level and be even harder to read.
    for (const h of HOURS) expect(sessionsOpenAt(h, BANDS)).toBeLessThan(4);
  });

  it("counts the wrapping window correctly", () => {
    // Sydney is 21:00-06:00, so it crosses midnight. A naive `open <= h < close`
    // would report it shut for the whole of its own session.
    const sydney = BANDS.filter((b) => b.id === "sydney");
    expect(sessionsOpenAt(23, sydney)).toBe(1);
    expect(sessionsOpenAt(3, sydney)).toBe(1);
    expect(sessionsOpenAt(12, sydney)).toBe(0);
  });
});

describe("the overlap is what gets shaded", () => {
  const shaded = HOURS.filter((h) => sessionsOpenAt(h, BANDS) > 1);
  const plain = HOURS.filter((h) => sessionsOpenAt(h, BANDS) <= 1);

  it("shades the hours two centres are open, and only those", () => {
    // Sydney+Tokyo 00-05, Tokyo+London 07-08, London+New York 12-15.
    expect(shaded).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 12, 13, 14, 15]);
  });

  it("leaves the rest plain, so the pattern is readable as information", () => {
    expect(plain).toEqual([6, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
    // Half the day each way. The old version shaded 24 hours out of 24.
    expect(shaded.length).toBe(12);
  });

  it("includes the London/New York overlap, the deepest liquidity of the day", () => {
    for (const h of [12, 13, 14, 15]) expect(sessionsOpenAt(h, BANDS)).toBe(2);
  });

  it("does not shade the hour Sydney has closed and Tokyo alone is open", () => {
    expect(sessionsOpenAt(6, BANDS)).toBe(1);
  });
});

describe("sessionsOpenAt is total", () => {
  it("returns zero for no bands", () => {
    expect(sessionsOpenAt(12, [])).toBe(0);
  });

  it("normalises hours outside 0-23", () => {
    // `utcHour` is arithmetic on a timestamp; a caller passing 24 or -1 must not
    // silently fall outside every window.
    expect(sessionsOpenAt(24, BANDS)).toBe(sessionsOpenAt(0, BANDS));
    expect(sessionsOpenAt(-1, BANDS)).toBe(sessionsOpenAt(23, BANDS));
  });

  it("handles a window that is open the whole day", () => {
    const all: SessionBand[] = [{ id: "x", openUtc: 0, closeUtc: 24, colour: "#fff" }];
    for (const h of HOURS) expect(sessionsOpenAt(h, all)).toBe(1);
  });
});
