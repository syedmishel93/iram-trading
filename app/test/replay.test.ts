import { describe, it, expect } from "vitest";
import { signal } from "../src/core/signal";
import { createReplay, MIN_VISIBLE } from "../src/core/replay";
import { toDetectInput, runDetectors } from "../src/detect";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

function series(n: number): BarView[] {
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

/**
 * Let the reactive graph settle.
 *
 * `computed` in this codebase is push-based and flushes on a microtask, so a
 * read in the same tick as the write still sees the previous value. The app is
 * effect-driven and never notices; a test that writes and reads synchronously
 * would be asserting against a stale snapshot.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the look-ahead firewall", () => {
  it("hands out a shorter array, not an index to be respected", async () => {
    // The whole design. A consumer cannot read the future because the future is
    // not in the object it receives — no cooperation required, none possible to
    // forget.
    const src = signal<readonly BarView[]>(series(500));
    const r = createReplay(src);
    r.start(200);
    await settle();
    expect(r.bars()).toHaveLength(200);
    expect(r.bars()[199]!.t).toBe(T0 + 199 * HOUR);
    expect(r.bars().some((b) => b.t > T0 + 199 * HOUR)).toBe(false);
  });

  it("passes the source through by identity while replay is off", () => {
    // Nothing pays for replay existing when it is not being used.
    const bars = series(100);
    const src = signal<readonly BarView[]>(bars);
    const r = createReplay(src);
    expect(r.bars()).toBe(bars);
  });

  it("clamps a stale cursor when the source shrinks under it", async () => {
    // A symbol change replaces the series. A cursor left at 400 must not slice
    // past the end, and must not collapse the view to empty either.
    const src = signal<readonly BarView[]>(series(500));
    const r = createReplay(src);
    r.start(400);
    await settle();
    src.set(series(120));
    await settle();
    expect(r.bars()).toHaveLength(120);
  });

  it("never advances past the end of the data", async () => {
    const src = signal<readonly BarView[]>(series(100));
    const r = createReplay(src);
    r.start(95);
    r.step(50);
    await settle();
    expect(r.cursor()).toBe(100);
    expect(r.bars()).toHaveLength(100);
    expect(r.atEnd()).toBe(true);
  });

  it("stays in replay at the end rather than dropping to live", () => {
    // Falling back to the full series at the end would silently reveal the very
    // bars the user was stepping towards.
    const src = signal<readonly BarView[]>(series(100));
    const r = createReplay(src);
    r.start(99);
    r.step(5);
    expect(r.active()).toBe(true);
    expect(r.playing()).toBe(false);
  });

  it("cannot start below the point where a chart is legible", () => {
    const src = signal<readonly BarView[]>(series(500));
    const r = createReplay(src);
    r.start(5);
    expect(r.cursor()).toBe(MIN_VISIBLE);
  });

  it("starts partway in when not told where", () => {
    const src = signal<readonly BarView[]>(series(600));
    const r = createReplay(src);
    r.start();
    expect(r.cursor()).toBe(200);
  });

  it("does nothing at all on an empty series", () => {
    const src = signal<readonly BarView[]>([]);
    const r = createReplay(src);
    r.start();
    expect(r.active()).toBe(false);
  });

  it("restores the full series when stopped", async () => {
    const bars = series(300);
    const src = signal<readonly BarView[]>(bars);
    const r = createReplay(src);
    r.start(100);
    await settle();
    expect(r.bars()).toHaveLength(100);
    r.stop();
    await settle();
    expect(r.bars()).toBe(bars);
  });
});

describe("replay as a correctness test for detection", () => {
  /**
   * PREFIX STABILITY — the property a peeking detector cannot satisfy.
   *
   * Replaying history means running the detectors on a PREFIX of the bars. Any
   * structure the prefix reports must also be reported, identically, by the run
   * over the whole series: same kind, same start bar, same confirmation bar. A
   * detector that read even one bar ahead would announce a structure during the
   * replay that the full run dates later, and the two sets would disagree.
   *
   * Structure (break of structure / change of character) is used because it is
   * keyed on pivot indices, which do not move when the array is a prefix.
   * Levels legitimately revise as more touches arrive and are a different
   * question.
   */
  it("reports exactly what the full run reports, never a bar early", async () => {
    const bars = series(400);
    const key = (d: { kind: string; from: number; to: number }): string =>
      `${d.kind}:${d.from}:${d.to}`;

    const full = new Set(
      runDetectors(toDetectInput(bars), ["structure"], bars.length).map(key),
    );

    const src = signal<readonly BarView[]>(bars);
    const r = createReplay(src);
    r.start(120);
    await settle();

    let checked = 0;
    for (let cursor = 120; cursor <= 400; cursor += 20) {
      r.cursor.set(cursor);
      await settle();
      const visible = r.bars();
      expect(visible).toHaveLength(cursor);

      for (const d of runDetectors(toDetectInput(visible), ["structure"], visible.length)) {
        // Confirmed on a bar the replay has actually reached...
        expect(d.to).toBeLessThan(cursor);
        // ...and agreeing with what the whole series says about it.
        expect(full.has(key(d))).toBe(true);
        checked += 1;
      }
    }
    // Guard against the assertion loop being vacuous.
    expect(checked).toBeGreaterThan(20);
  });
});
