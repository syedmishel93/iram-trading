/**
 * The arithmetic UTC hour used by the session bands.
 *
 * Replacing `new Date(t).getUTCHours()` with arithmetic is only safe because
 * Unix time has no leap seconds — so it is worth proving against the Date it
 * replaced rather than asserting it by reasoning.
 */
import { describe, expect, it } from "vitest";

const utcHour = (t: number): number => Math.floor(t / 3_600_000) % 24;

describe("utcHour", () => {
  it("agrees with Date across a full year of hours", () => {
    // Every hour of 2024 — a leap year, so it crosses 29 February too.
    const start = Date.UTC(2024, 0, 1);
    for (let h = 0; h < 366 * 24; h++) {
      const t = start + h * 3_600_000;
      expect(utcHour(t)).toBe(new Date(t).getUTCHours());
    }
  });

  it("agrees across the epoch and a DST changeover", () => {
    for (const t of [
      0,                              // the epoch itself
      Date.UTC(2024, 2, 31, 1, 0),    // EU clocks go forward — UTC does not
      Date.UTC(2024, 10, 3, 6, 0),    // US clocks go back
      Date.UTC(2038, 0, 19, 3, 14),   // past the 32-bit second boundary
    ]) {
      expect(utcHour(t)).toBe(new Date(t).getUTCHours());
    }
  });

  it("is unaffected by the machine's own timezone", () => {
    // getUTCHours is too, which is the point — the bands are UTC windows and
    // must not shift with where the operator happens to be sitting.
    const t = Date.UTC(2024, 5, 15, 13, 30);
    expect(utcHour(t)).toBe(13);
  });
});
