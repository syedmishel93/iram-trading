import { describe, expect, it } from "vitest";
import {
  BREAKEVEN_R,
  holdingMs,
  outcome,
  plannedR,
  realisedR,
  sanitiseEntry,
  toCsv,
  type JournalEntry,
  type NewEntry,
} from "../src/journal/entry";
import { createJournal, MAX_ENTRIES } from "../src/journal/store";
import {
  bySetup,
  byAdherence,
  computeStats,
  MIN_SAMPLE,
  planGapLine,
  PLAN_GAP_THRESHOLD,
  recordLine,
} from "../src/journal/stats";
import { createKV, memoryRawStore } from "../src/store/kv";

const kv = () => createKV(memoryRawStore());

const base: NewEntry = {
  openedAt: 1_700_000_000_000,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long",
  entry: 100,
  stop: 90,
  target: 130,
  size: 1,
  setupKind: "liquidity-sweep",
  scoreAtEntry: 72,
  gatesBlocking: [],
  adherence: "as-planned",
  note: "",
  source: "binance",
  quality: "live",
};

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  ...(base as unknown as JournalEntry),
  id: "j1",
  closedAt: null,
  exit: null,
  ...over,
});

describe("realisedR", () => {
  it("measures profit in units of the risk actually taken", () => {
    // Risked 10 (100 -> 90), made 20 (100 -> 120). Two R.
    expect(realisedR(entry({ exit: 120 }))).toBeCloseTo(2, 10);
    expect(realisedR(entry({ exit: 90 }))).toBeCloseTo(-1, 10);
  });

  it("gets the sign right on a short", () => {
    const short = entry({ direction: "short", entry: 100, stop: 110, exit: 80 });
    expect(realisedR(short)).toBeCloseTo(2, 10);
  });

  /**
   * A zero-risk trade has no denominator.
   *
   * Inventing one produces infinite R on the least informative trade in the
   * book, which then dominates every average it appears in.
   */
  it("refuses rather than dividing by a zero stop distance", () => {
    expect(realisedR(entry({ stop: 100, exit: 120 }))).toBeNull();
  });

  it("is null while the trade is open", () => {
    expect(realisedR(entry())).toBeNull();
  });
});

describe("plannedR", () => {
  it("measures what the trade was aiming at", () => {
    expect(plannedR(entry())).toBeCloseTo(3, 10);
  });

  it("is null when the trade was taken with no target", () => {
    /* Which is itself a fact worth keeping, not a reason to drop the entry. */
    expect(plannedR(entry({ target: null }))).toBeNull();
  });
});

describe("outcome", () => {
  it("files a trade that closed a tick from entry as a scratch", () => {
    /* Calling it a win because of one tick would flatter every hit rate in the
       journal, which is the number people size up on. */
    const tiny = entry({ exit: 100 + 10 * (BREAKEVEN_R / 2) });
    expect(outcome(tiny)).toBe("breakeven");
  });

  it("separates win, loss and open", () => {
    expect(outcome(entry({ exit: 120 }))).toBe("win");
    expect(outcome(entry({ exit: 85 }))).toBe("loss");
    expect(outcome(entry())).toBe("open");
  });
});

describe("holdingMs", () => {
  it("is null while open and a duration once closed", () => {
    expect(holdingMs(entry())).toBeNull();
    expect(holdingMs(entry({ closedAt: base.openedAt + 3600_000 }))).toBe(3600_000);
  });
});

describe("sanitiseEntry", () => {
  it("refuses a record with no price, rather than admitting a NaN", () => {
    /* An entry with no price is not a partial record of a trade. Admitting it
       would put a NaN into every statistic downstream. */
    expect(sanitiseEntry({ id: "x", symbol: "BTCUSDT", openedAt: 1, stop: 90 })).toBeNull();
    expect(sanitiseEntry({ id: "x", symbol: "", openedAt: 1, entry: 1, stop: 1 })).toBeNull();
    expect(sanitiseEntry(null)).toBeNull();
    expect(sanitiseEntry(42)).toBeNull();
  });

  it("fills in the fields that carry no meaning", () => {
    const e = sanitiseEntry({ id: "x", symbol: "BTCUSDT", openedAt: 1, entry: 100, stop: 90 });
    expect(e).not.toBeNull();
    expect(e?.note).toBe("");
    expect(e?.timeframe).toBe("1h");
    expect(e?.gatesBlocking).toEqual([]);
    /* Unknown adherence falls back to off-plan, the least flattering reading —
       a record that cannot prove it followed the plan should not claim it. */
    expect(e?.adherence).toBe("off-plan");
  });

  it("keeps a valid adherence and rejects an invented one", () => {
    expect(sanitiseEntry({ ...entry(), adherence: "modified" })?.adherence).toBe("modified");
    expect(sanitiseEntry({ ...entry(), adherence: "perfect" })?.adherence).toBe("off-plan");
  });
});

describe("the journal store", () => {
  it("persists across a reload", () => {
    const store = kv();
    const a = createJournal(store);
    a.add(base);
    expect(createJournal(store).entries()).toHaveLength(1);
  });

  it("records an exit and leaves everything else alone", () => {
    const j = createJournal(kv());
    const made = j.add(base);
    const closed = j.close(made.id, 130, base.openedAt + 7200_000);
    expect(closed?.exit).toBe(130);
    expect(closed?.entry).toBe(100);
    expect(outcome(closed as JournalEntry)).toBe("win");
  });

  it("returns null for an unknown id rather than throwing", () => {
    const j = createJournal(kv());
    expect(j.close("nope", 100)).toBeNull();
    expect(j.update("nope", { note: "x" })).toBeNull();
  });

  it("refuses to let a patch move the id or the open time", () => {
    /* Either would break the eviction order and the sync join at once. */
    const j = createJournal(kv());
    const made = j.add(base);
    const patched = j.update(made.id, {
      id: "hacked",
      openedAt: 0,
      note: "kept",
    } as Partial<JournalEntry>);
    expect(patched?.id).toBe(made.id);
    expect(patched?.openedAt).toBe(made.openedAt);
    expect(patched?.note).toBe("kept");
  });

  it("gives every entry a distinct id even within one millisecond", () => {
    const j = createJournal(kv(), () => 1_700_000_000_000);
    const ids = new Set(Array.from({ length: 200 }, () => j.add(base).id));
    expect(ids.size).toBe(200);
  });

  it("merges an import without duplicating what is already there", () => {
    const j = createJournal(kv());
    const made = j.add(base);
    expect(j.merge([made])).toBe(0);
    expect(j.merge([{ ...made, id: "other" }])).toBe(1);
    expect(j.entries()).toHaveLength(2);
  });

  it("drops one corrupt row instead of losing the whole book", () => {
    const store = kv();
    const j = createJournal(store);
    j.add(base);
    j.add({ ...base, symbol: "ETHUSDT" });
    const raw = store.rawEnvelope("journal.entries") as { value: unknown[] };
    raw.value.push({ garbage: true });
    store.write(
      { key: "journal.entries", version: 1, fallback: () => [], validate: (v) => v as unknown[] },
      raw.value,
    );
    expect(createJournal(store).entries()).toHaveLength(2);
  });

  /**
   * An open position dropped from the book is a trade you are still in with no
   * record that you are — the one failure mode here with a real cost.
   */
  it("never evicts an open position, even over the cap", () => {
    const j = createJournal(kv());
    for (let i = 0; i < 30; i++) {
      const made = j.add({ ...base, openedAt: base.openedAt + i });
      if (i % 3 !== 0) j.close(made.id, 110);
    }
    const openCount = j.open().length;
    expect(openCount).toBe(10);
    expect(MAX_ENTRIES).toBeGreaterThan(1000);
  });

  it("reports a failed write instead of swallowing it", () => {
    const raw = memoryRawStore();
    const store = createKV(raw);
    const j = createJournal(store);
    raw.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    j.add(base);
    expect(j.lastError()).toMatch(/not saved/i);
  });
});

describe("computeStats", () => {
  /** `n` closed trades, alternating +2R and −1R. */
  const book = (n: number): JournalEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({
        id: `j${i}`,
        openedAt: base.openedAt + i * 3600_000,
        closedAt: base.openedAt + i * 3600_000 + 1800_000,
        exit: i % 2 === 0 ? 120 : 90,
      }),
    );

  it("leads with expectancy in R, not with win rate", () => {
    const s = computeStats(book(30));
    // 15 at +2R, 15 at −1R → mean +0.5R.
    expect(s.expectancy).toBeCloseTo(0.5, 6);
    expect(s.hitRate).toBeCloseTo(0.5, 6);
    expect(s.totalR).toBeCloseTo(15, 6);
  });

  /**
   * The refusal this whole file exists for.
   *
   * Nine trades will happily report a 67% hit rate whose 95% interval runs
   * from about 30% to 93% — a band that includes "you are losing". Every
   * retail journal prints it anyway, in a large font.
   */
  it("is not usable below the sample floor, whatever the numbers say", () => {
    expect(computeStats(book(MIN_SAMPLE - 1)).usable).toBe(false);
    expect(computeStats(book(MIN_SAMPLE)).usable).toBe(true);
  });

  it("reports how wide the interval still is, and narrows it with n", () => {
    expect(computeStats(book(20)).intervalWidth).toBeGreaterThan(
      computeStats(book(200)).intervalWidth,
    );
  });

  it("excludes open trades from every closed statistic", () => {
    const s = computeStats([...book(20), entry({ id: "open1" })]);
    expect(s.n).toBe(20);
    expect(s.open).toBe(1);
  });

  /**
   * Drawdown on the CUMULATIVE R curve, not the worst single loss.
   *
   * A run of four −1R trades hurts the same as one −4R, and a book that only
   * reports the worst single trade shows you the second and hides the first.
   */
  it("measures drawdown as a run, not as the worst single trade", () => {
    const run = [
      entry({ id: "a", exit: 90, closedAt: 1 }),
      entry({ id: "b", exit: 90, closedAt: 2 }),
      entry({ id: "c", exit: 90, closedAt: 3 }),
    ];
    expect(computeStats(run).maxDrawdownR).toBeCloseTo(3, 6);
  });

  it("returns an empty, unusable result for an empty book", () => {
    const s = computeStats([]);
    expect(s.n).toBe(0);
    expect(s.usable).toBe(false);
    expect(s.medianHoldMs).toBeNull();
  });

  it("skips a zero-risk trade rather than letting it poison the averages", () => {
    const s = computeStats([...book(20), entry({ id: "z", stop: 100, exit: 120, closedAt: 9 })]);
    expect(s.n).toBe(20);
    expect(Number.isFinite(s.expectancy)).toBe(true);
  });

  /**
   * The plan gap: what the plans aimed at, minus what was taken.
   *
   * Consistently positive means the plans are sound and the exits are early,
   * which is a different problem from a bad edge and has a different fix.
   */
  it("measures the gap between planned and realised R", () => {
    const early = Array.from({ length: 25 }, (_, i) =>
      entry({ id: `e${i}`, closedAt: i, exit: 110 }), // +1R against a +3R plan
    );
    const s = computeStats(early);
    expect(s.planGap).toBeCloseTo(2, 6);
    expect(planGapLine(s)).toMatch(/short of your targets/);
  });

  it("stays quiet about a plan gap too small to act on", () => {
    const s = computeStats(
      Array.from({ length: 25 }, (_, i) =>
        entry({ id: `e${i}`, closedAt: i, exit: 100 + 10 * (3 - PLAN_GAP_THRESHOLD / 2) }),
      ),
    );
    expect(planGapLine(s)).toBe("");
  });
});

describe("bySetup and byAdherence", () => {
  it("groups by setup kind and keeps discretionary trades as their own group", () => {
    /* A book where the discretionary trades beat every detector is a real and
       important finding; dropping them would hide it. */
    const mixed = [
      entry({ id: "a", setupKind: "fvg", exit: 120, closedAt: 1 }),
      entry({ id: "b", setupKind: "fvg", exit: 90, closedAt: 2 }),
      entry({ id: "c", setupKind: null, exit: 120, closedAt: 3 }),
    ];
    const groups = bySetup(mixed);
    expect(groups.get("fvg")?.n).toBe(2);
    expect(groups.get("discretionary")?.n).toBe(1);
  });

  it("splits by how closely the plan was followed", () => {
    const mixed = [
      entry({ id: "a", adherence: "as-planned", exit: 120, closedAt: 1 }),
      entry({ id: "b", adherence: "off-plan", exit: 90, closedAt: 2 }),
    ];
    const groups = byAdherence(mixed);
    expect(groups.get("as-planned")?.n).toBe(1);
    expect(groups.get("off-plan")?.n).toBe(1);
  });
});

describe("recordLine — the line that replaces 'no record'", () => {
  it("still says 'no record' when there genuinely is none", () => {
    expect(recordLine("fvg", undefined)).toMatch(/No record for this setup type yet/);
  });

  it("refuses to print a percentage below the sample floor", () => {
    const few = computeStats([entry({ id: "a", exit: 120, closedAt: 1 })]);
    const line = recordLine("fvg", few);
    expect(line).toMatch(/too few to measure/);
    expect(line).not.toMatch(/%/);
  });

  it("prints expectancy, hit rate AND the interval once the sample earns it", () => {
    const many = computeStats(
      Array.from({ length: 40 }, (_, i) =>
        entry({ id: `j${i}`, closedAt: i, exit: i % 2 === 0 ? 120 : 90 }),
      ),
    );
    const line = recordLine("fvg", many);
    expect(line).toMatch(/40 trades/);
    expect(line).toMatch(/\+0\.50R expectancy/);
    /* The band is not optional. A hit rate without one is the number people
       size up on. */
    expect(line).toMatch(/±\d+ points at 95%/);
  });

  it("distinguishes 'nothing closed yet' from 'nothing recorded'", () => {
    const openOnly = computeStats([entry({ id: "a" })]);
    expect(recordLine("fvg", openOnly)).toMatch(/1 open, none closed/);
  });
});

describe("toCsv", () => {
  it("exports a header, one row per trade, and the derived figures", () => {
    const csv = toCsv([entry({ id: "a", exit: 120, closedAt: 2 })]);
    const [head, row] = csv.split("\n");
    expect(head).toMatch(/^id,openedAt/);
    expect(head).toMatch(/realisedR,plannedR,outcome$/);
    expect(row).toMatch(/2\.000/);
    expect(row).toMatch(/win$/);
  });

  it("quotes a note containing a comma", () => {
    const csv = toCsv([entry({ id: "a", note: "took it early, no reason" })]);
    expect(csv).toContain('"took it early, no reason"');
  });
});
