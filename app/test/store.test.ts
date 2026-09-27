import { describe, it, expect } from "vitest";
import {
  normalise,
  missing,
  intersect,
  coverageRatio,
  chunk,
  significantGaps,
  span,
} from "../src/store/segments";
import {
  ascendingUnique,
  createArchive,
  memoryBackend,
  seriesKey,
  contiguousRuns,
  inferInterval,
} from "../src/store/barstore";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;
const KEY = { source: "binance", symbol: "BTCUSDT", timeframe: "1h" };
const META = { source: "binance", quality: "live" as const, fetchedAt: 1 };

/** Bars on an hourly grid starting at `startT`. */
function bars(startT: number, count: number, price = 100): BarView[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * H,
    o: price + i,
    h: price + i + 1,
    l: price + i - 1,
    c: price + i + 0.5,
    v: 10 + i,
  }));
}

describe("normalise", () => {
  it("sorts and merges overlapping ranges", () => {
    expect(
      normalise([
        { from: 50, to: 100 },
        { from: 0, to: 60 },
      ]),
    ).toEqual([{ from: 0, to: 100 }]);
  });

  it("leaves genuinely separate ranges alone", () => {
    const out = normalise([
      { from: 0, to: 10 },
      { from: 100, to: 110 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("merges ranges that are contiguous within the tolerance", () => {
    // Segments ending 09:00 and resuming 10:00 on an hourly series are
    // CONTIGUOUS. Treating them as separate manufactures a hole that is not
    // there, and every read would then try to backfill it forever.
    const out = normalise([{ from: 0, to: 9 * H }, { from: 10 * H, to: 20 * H }], H);
    expect(out).toEqual([{ from: 0, to: 20 * H }]);
  });

  it("drops invalid ranges rather than propagating NaN", () => {
    expect(normalise([{ from: NaN, to: 5 }, { from: 10, to: 1 }, { from: 0, to: 5 }])).toEqual([
      { from: 0, to: 5 },
    ]);
  });

  it("handles an empty input", () => {
    expect(normalise([])).toEqual([]);
  });
});

describe("missing", () => {
  it("reports the whole window when nothing is held", () => {
    expect(missing({ from: 0, to: 100 }, [])).toEqual([{ from: 0, to: 100 }]);
  });

  it("reports nothing when fully covered", () => {
    expect(missing({ from: 10, to: 90 }, [{ from: 0, to: 100 }])).toEqual([]);
  });

  it("finds a hole in the middle", () => {
    expect(
      missing({ from: 0, to: 100 }, [
        { from: 0, to: 30 },
        { from: 60, to: 100 },
      ]),
    ).toEqual([{ from: 31, to: 59 }]);
  });

  it("finds holes at both ends", () => {
    expect(missing({ from: 0, to: 100 }, [{ from: 40, to: 60 }])).toEqual([
      { from: 0, to: 39 },
      { from: 61, to: 100 },
    ]);
  });

  it("ignores held ranges outside the window", () => {
    expect(missing({ from: 50, to: 60 }, [{ from: 0, to: 10 }, { from: 90, to: 99 }])).toEqual([
      { from: 50, to: 60 },
    ]);
  });

  it("finds several holes", () => {
    const gaps = missing({ from: 0, to: 100 }, [
      { from: 10, to: 20 },
      { from: 40, to: 50 },
      { from: 80, to: 90 },
    ]);
    expect(gaps).toHaveLength(4);
  });
});

describe("coverage and intersect", () => {
  it("reports a partial coverage ratio", () => {
    expect(coverageRatio({ from: 0, to: 100 }, [{ from: 0, to: 50 }])).toBeCloseTo(0.5, 6);
  });

  it("is 1 when fully covered and 0 when not covered at all", () => {
    expect(coverageRatio({ from: 0, to: 100 }, [{ from: 0, to: 100 }])).toBe(1);
    expect(coverageRatio({ from: 0, to: 100 }, [])).toBe(0);
  });

  it("never exceeds 1 when holdings overflow the window", () => {
    expect(coverageRatio({ from: 10, to: 20 }, [{ from: 0, to: 1000 }])).toBe(1);
  });

  it("intersect clips holdings to the window", () => {
    expect(intersect({ from: 10, to: 20 }, [{ from: 0, to: 100 }])).toEqual([{ from: 10, to: 20 }]);
  });

  it("span totals the covered milliseconds", () => {
    expect(span([{ from: 0, to: 10 }, { from: 20, to: 25 }])).toBe(15);
  });
});

describe("chunk", () => {
  it("splits a long backfill into bounded requests", () => {
    const out = chunk({ from: 0, to: 999 }, 250);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ from: 0, to: 249 });
    expect(out[3]?.to).toBe(999);
  });

  it("emits oldest first so an interrupted backfill leaves a contiguous archive", () => {
    const out = chunk({ from: 0, to: 999 }, 250);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.from).toBeGreaterThan(out[i - 1]?.from as number);
    }
  });

  it("returns one chunk when the range fits", () => {
    expect(chunk({ from: 0, to: 10 }, 100)).toEqual([{ from: 0, to: 10 }]);
  });

  it("refuses a non-positive size instead of looping forever", () => {
    expect(chunk({ from: 0, to: 10 }, 0)).toEqual([]);
  });
});

describe("significantGaps", () => {
  it("drops holes too small to be real missing history", () => {
    // Backfilling every two-bar weekend hole across a decade of FX is thousands
    // of requests for nothing.
    const gaps = [
      { from: 0, to: H },
      { from: 10 * H, to: 40 * H },
    ];
    expect(significantGaps(gaps, H, 3)).toEqual([{ from: 10 * H, to: 40 * H }]);
  });

  it("keeps everything when no interval is known", () => {
    const gaps = [{ from: 0, to: 1 }];
    expect(significantGaps(gaps, 0)).toEqual(gaps);
  });
});

// ---------------------------------------------------------------------------

describe("ascendingUnique", () => {
  /*
   * THE CONTRACT EVERY CONSUMER ASSUMES AND NOTHING GUARANTEED.
   *
   * MEASURED in the browser: a 5,000-bar study window arrived with
   * `bars[4999].t === bars[4998].t`, `headless.ts` threw on its
   * ascending-and-unique check, and an autonomous sweep reported "85 could not
   * be studied on this history" — a refusal with no cause, on a market whose
   * data was fine apart from one repeated row. The vendor's response reaches
   * `history.load`'s caller verbatim whenever it is longer than the archive's
   * holding, so nothing between the venue and the engine removed it.
   */
  it("keeps the LAST bar for a repeated instant, because it is the correction", () => {
    const stale = { t: 5 * H, o: 1, h: 2, l: 0, c: 1, v: 1 };
    const fresh2 = { t: 5 * H, o: 1, h: 9, l: 0, c: 7, v: 50 };
    const out = ascendingUnique([{ t: 4 * H, o: 1, h: 1, l: 1, c: 1, v: 1 }, stale, fresh2]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(fresh2);
  });

  it("leaves an already-clean series untouched", () => {
    const input = bars(0, 5);
    expect(ascendingUnique(input)).toEqual(input);
  });

  it("drops a bar that goes backwards rather than reordering it", () => {
    /* Sorting is the caller's job; this only enforces the invariant. A bar out
       of order is a broken feed, and silently re-sorting it would hide that. */
    const out = ascendingUnique([...bars(0, 3), { t: 0, o: 9, h: 9, l: 9, c: 9, v: 9 }]);
    expect(out).toHaveLength(3);
  });
});

describe("archive round trip", () => {
  const fresh = () => createArchive(memoryBackend());

  it("stores and returns bars", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 100), META);
    const r = await a.read(KEY, { from: 0, to: 99 * H }, H);
    expect(r.bars).toHaveLength(100);
    expect(r.bars[0]?.t).toBe(0);
    expect(r.coverage).toBe(1);
    expect(r.gaps).toEqual([]);
  });

  it("preserves OHLCV values exactly through typed-array storage", async () => {
    const a = fresh();
    const input = bars(0, 10);
    await a.write(KEY, input, META);
    const r = await a.read(KEY, { from: 0, to: 9 * H }, H);
    expect(r.bars).toEqual(input);
  });

  it("returns only the requested window", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 100), META);
    const r = await a.read(KEY, { from: 10 * H, to: 19 * H }, H);
    expect(r.bars).toHaveLength(10);
    expect(r.bars[0]?.t).toBe(10 * H);
  });

  /*
   * OVERLAPPING SEGMENTS MUST NOT RETURN THE SAME INSTANT TWICE.
   *
   * MEASURED in the browser, and it broke every autonomous sweep silently: a
   * 5,000-bar study window came back with `bars[4999].t` equal to
   * `bars[4998].t`, so `headless.ts`'s ascending-and-unique contract threw and
   * all 85 rules were reported as "could not be studied on this history".
   *
   * `write` already de-duplicates WITHIN one batch — its own comment says a
   * feed republishing the forming bar must not create two rows. The invariant
   * was simply not carried across batches: `read` concatenated every
   * overlapping segment and sorted, which puts the duplicates next to each
   * other rather than removing them. A live recording and a backfill covering
   * the same hour is the ordinary case, not an exotic one.
   */
  it("returns each instant once when two segments overlap", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 60), META);
    /* The same ten hours again, as a backfill or a re-fetch would store them. */
    await a.write(KEY, bars(50 * H, 20), META);
    const r = await a.read(KEY, { from: 0, to: 69 * H }, H);

    expect(r.bars).toHaveLength(70);
    for (let i = 1; i < r.bars.length; i++) {
      expect((r.bars[i] as BarView).t, `bars[${i}] must be after bars[${i - 1}]`).toBeGreaterThan(
        (r.bars[i - 1] as BarView).t,
      );
    }
  });

  it("merges a later write with existing history", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 50), META);
    await a.write(KEY, bars(50 * H, 50), META);
    const r = await a.read(KEY, { from: 0, to: 99 * H }, H);
    expect(r.bars).toHaveLength(100);
    expect(r.gaps).toEqual([]);
  });

  it("de-duplicates the forming bar rather than storing it twice", async () => {
    // A live feed republishes the newest bar many times before it closes.
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    const revised = [{ t: 9 * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 999 }];
    await a.write(KEY, revised, META);

    const r = await a.read(KEY, { from: 0, to: 9 * H }, H);
    expect(r.bars).toHaveLength(10);
    // Later write WINS: a re-fetch is a correction, not a duplicate.
    expect(r.bars[9]?.v).toBe(999);
  });

  it("lets a re-fetch correct a previously stored bar", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 5), META);
    await a.write(KEY, [{ t: 2 * H, o: 7, h: 7, l: 7, c: 7, v: 7 }], META);
    const r = await a.read(KEY, { from: 0, to: 4 * H }, H);
    expect(r.bars[2]?.c).toBe(7);
    expect(r.bars).toHaveLength(5);
  });
});

describe("the archive never hides a gap", () => {
  const fresh = () => createArchive(memoryBackend());

  it("reports a hole between two stored runs", async () => {
    // The failure this exists to prevent: a backtest over a series with an
    // invisible hole does not crash, it produces a confident wrong number.
    const a = fresh();
    await a.write(KEY, bars(0, 10), META, H);
    await a.write(KEY, bars(50 * H, 10), META, H);

    const r = await a.read(KEY, { from: 0, to: 59 * H }, H);
    expect(r.bars).toHaveLength(20);
    expect(r.gaps).toHaveLength(1);
    expect(r.coverage).toBeLessThan(1);
    expect(r.coverage).toBeGreaterThan(0);
  });

  it("reports the whole window as a gap when it holds nothing", async () => {
    const r = await fresh().read(KEY, { from: 0, to: 100 * H }, H);
    expect(r.bars).toEqual([]);
    expect(r.gaps).toEqual([{ from: 0, to: 100 * H }]);
    expect(r.coverage).toBe(0);
  });

  it("does NOT report a gap between contiguous segments", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    await a.write(KEY, bars(10 * H, 10), META);
    const r = await a.read(KEY, { from: 0, to: 19 * H }, H);
    expect(r.gaps).toEqual([]);
    expect(r.coverage).toBe(1);
  });

  it("reports coverage for a window extending past what it holds", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    const r = await a.read(KEY, { from: 0, to: 100 * H }, H);
    expect(r.coverage).toBeLessThan(0.2);
    expect(r.gaps.length).toBeGreaterThan(0);
  });
});

describe("provenance", () => {
  const fresh = () => createArchive(memoryBackend());

  it("flags demo data so a model can never silently train on it", async () => {
    // A model trained on generated candles blended with real ones is worse than
    // one with no data, because it looks trained.
    const a = fresh();
    await a.write(KEY, bars(0, 10), { source: "demo", quality: "demo", fetchedAt: 1 });
    const r = await a.read(KEY, { from: 0, to: 9 * H }, H);
    expect(r.containsDemo).toBe(true);
    expect(r.qualities).toContain("demo");
  });

  it("reports clean data as not containing demo", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    const r = await a.read(KEY, { from: 0, to: 9 * H }, H);
    expect(r.containsDemo).toBe(false);
    expect(r.qualities).toEqual(["live"]);
  });

  it("keeps series from different sources separate", async () => {
    const a = fresh();
    await a.write({ ...KEY, source: "binance" }, bars(0, 10), META);
    await a.write({ ...KEY, source: "proxy" }, bars(0, 5), {
      source: "proxy",
      quality: "delayed",
      fetchedAt: 1,
    });

    const bn = await a.read({ ...KEY, source: "binance" }, { from: 0, to: 9 * H }, H);
    const px = await a.read({ ...KEY, source: "proxy" }, { from: 0, to: 9 * H }, H);
    expect(bn.bars).toHaveLength(10);
    expect(px.bars).toHaveLength(5);
    expect(px.qualities).toEqual(["delayed"]);
  });

  it("keeps timeframes separate", async () => {
    const a = fresh();
    await a.write({ ...KEY, timeframe: "1h" }, bars(0, 10), META);
    await a.write({ ...KEY, timeframe: "4h" }, bars(0, 3), META);
    expect((await a.read({ ...KEY, timeframe: "4h" }, { from: 0, to: 9 * H }, H)).bars).toHaveLength(3);
  });
});

describe("segments are contiguous runs", () => {
  const fresh = () => createArchive(memoryBackend());

  it("does not report contiguous segments as fragmented", async () => {
    // Two segments ending 19:00 and resuming 20:00 on an hourly series are
    // contiguous. Reporting them as two ranges sends every caller chasing a
    // hole that is not there — read() always applied this tolerance and
    // coverage() did not.
    const a = fresh();
    await a.write(KEY, bars(0, 5000), META, H);
    await a.write(KEY, bars(5000 * H, 1800), META, H);

    expect(await a.coverage(KEY, H)).toHaveLength(1);
    // Without the tolerance the segment boundary looks like a gap.
    expect((await a.coverage(KEY)).length).toBeGreaterThan(1);
  });

  it("still reports a REAL hole when given the interval", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META, H);
    await a.write(KEY, bars(500 * H, 10), META, H);
    expect(await a.coverage(KEY, H)).toHaveLength(2);
  });

  it("never lets one segment straddle a hole", async () => {
    // Chunking purely by bar count let a single segment span a three-week
    // absence and report it as covered — the exact silent gap the archive
    // exists to prevent. Contiguity must decide the boundaries.
    const a = fresh();
    await a.write(KEY, [...bars(0, 10), ...bars(500 * H, 10)], META, H);
    const cov = await a.coverage(KEY, H);
    expect(cov).toHaveLength(2);
    expect(cov[0]?.to).toBe(9 * H);
    expect(cov[1]?.from).toBe(500 * H);
  });

  it("infers the interval when not told, using the median", async () => {
    // One weekend must not redefine an hourly series as weekly.
    const a = fresh();
    await a.write(KEY, [...bars(0, 20), ...bars(400 * H, 20)], META);
    expect(await a.coverage(KEY, H)).toHaveLength(2);
  });

  it("tolerates vendor jitter without splitting a healthy run", () => {
    const jittery: BarView[] = bars(0, 20).map((b, i) => ({ ...b, t: b.t + (i % 2 ? 900 : 0) }));
    expect(contiguousRuns(jittery, H)).toHaveLength(1);
  });

  it("splits exactly where a bar is genuinely absent", () => {
    const withHole = [...bars(0, 5), ...bars(20 * H, 5)];
    const runs = contiguousRuns(withHole, H);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(5);
    expect(runs[1]).toHaveLength(5);
  });

  it("infers a sane interval from a regular series", () => {
    expect(inferInterval(bars(0, 50))).toBe(H);
  });

  it("returns one run when the interval is unknown", () => {
    expect(contiguousRuns(bars(0, 10), 0)).toHaveLength(1);
  });
});

describe("stats and clearing", () => {
  const fresh = () => createArchive(memoryBackend());

  it("counts what it holds", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 100), META);
    await a.write({ ...KEY, symbol: "ETHUSDT" }, bars(0, 50), META);

    const s = await a.stats();
    expect(s.series).toBe(2);
    expect(s.bars).toBe(150);
    expect(s.approxBytes).toBe(150 * 6 * 8);
    expect(s.oldest).toBe(0);
  });

  it("splits very long series into multiple segments", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 12_000), META);
    const s = await a.stats();
    expect(s.segments).toBeGreaterThan(1);
    expect(s.bars).toBe(12_000);

    // And still reads back as one contiguous series with no gaps.
    const r = await a.read(KEY, { from: 0, to: 11_999 * H }, H);
    expect(r.bars).toHaveLength(12_000);
    expect(r.gaps).toEqual([]);
  });

  it("clears one series without touching the others", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    await a.write({ ...KEY, symbol: "ETHUSDT" }, bars(0, 10), META);

    await a.clear(KEY);
    expect((await a.read(KEY, { from: 0, to: 9 * H }, H)).bars).toEqual([]);
    expect((await a.read({ ...KEY, symbol: "ETHUSDT" }, { from: 0, to: 9 * H }, H)).bars).toHaveLength(10);
  });

  it("clears everything when given no key", async () => {
    const a = fresh();
    await a.write(KEY, bars(0, 10), META);
    await a.clear();
    expect((await a.stats()).bars).toBe(0);
  });
});

describe("seriesKey", () => {
  it("is stable and distinguishes every dimension", () => {
    expect(seriesKey(KEY)).toBe("binance|BTCUSDT|1h");
    expect(seriesKey({ ...KEY, timeframe: "4h" })).not.toBe(seriesKey(KEY));
    expect(seriesKey({ ...KEY, source: "proxy" })).not.toBe(seriesKey(KEY));
  });
});
