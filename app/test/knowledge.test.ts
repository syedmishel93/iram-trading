/**
 * The knowledge base.
 *
 * WHAT IS WORTH TESTING HERE AND WHAT IS NOT
 * Summing eight numbers is not worth a test. What is:
 *
 *  1. IDEMPOTENCE. Re-running a harvest must not double a sample. This is the
 *     one property that, if it broke, would produce a base that looked better
 *     the more often you pressed the button — silently, and in the flattering
 *     direction.
 *  2. THE REFUSALS. A cell under the floor must decline to be quoted, and a
 *     stale one must say so. Both are the difference between a measurement and
 *     a number.
 *  3. THE MIGRATION. A slot whose migration table is never exercised has an
 *     untested mechanism; the first time it runs would otherwise be on the
 *     operator's only copy.
 *  4. THE WORDING, against literals written by hand. Every expectation below
 *     is typed out in full — the Wilson bound was computed independently
 *     rather than read off the module — because an expected value taken from
 *     the code under test cannot fail. `expect(reason).toContain(QUANT_BASE)`
 *     passed for months on a URL that could never resolve.
 */

import { describe, expect, it } from "vitest";
import { createKV, memoryRawStore } from "../src/store/kv";
import type { Regime } from "../src/backtest/regime";
import {
  KNOWLEDGE_SLOT,
  MAX_ENTRIES,
  MIN_CELL_TRIALS,
  STALE_AFTER_MS,
  buildEntry,
  contextAt,
  contextOfLatest,
  createKnowledgeBase,
  evictEntries,
  priorFor,
  type KnowledgeEntry,
  type TrialFact,
} from "../src/learn/knowledge";

/* Wednesday 3 January 2024, 13:00 UTC. Chosen, not arbitrary: 13:00 is inside
   BOTH London (07-16) and New York (12-21), which is what makes the
   overlapping-sessions case testable at all. */
const AT = Date.UTC(2024, 0, 3, 13, 0, 0);
const NOW = Date.UTC(2024, 0, 3, 15, 0, 0); // two hours later

const ctx = (regime: Regime = "trend", at = AT) => contextAt(at, regime);

/**
 * 51 trials: 23 to target at +2R, 26 stopped at −1R, 2 expired at −0.5R.
 * Sum = 46 − 26 − 1 = 19, so expectancy is 19/51 = 0.3725… → "+0.37R".
 */
function fiftyOne(regime: Regime = "trend", at = AT): TrialFact[] {
  const out: TrialFact[] = [];
  for (let i = 0; i < 23; i++) out.push({ at, outcome: "target", r: 2, heldBars: 8, context: ctx(regime, at) });
  for (let i = 0; i < 26; i++) out.push({ at, outcome: "stop", r: -1, heldBars: 4, context: ctx(regime, at) });
  for (let i = 0; i < 2; i++) out.push({ at, outcome: "expired", r: -0.5, heldBars: 20, context: ctx(regime, at) });
  return out;
}

function few(n: number, regime: Regime = "trend"): TrialFact[] {
  return Array.from({ length: n }, () => ({
    at: AT,
    outcome: "target" as const,
    r: 2,
    heldBars: 6,
    context: ctx(regime),
  }));
}

const study = (
  trials: TrialFact[],
  over: Partial<{ symbol: string; timeframe: string; kind: string; bars: number; rMultiple: number }> = {},
  at = NOW,
): KnowledgeEntry => {
  const e = buildEntry(
    {
      source: "replay",
      symbol: over.symbol ?? "BTCUSDT",
      timeframe: over.timeframe ?? "1h",
      kind: over.kind ?? "choch",
      direction: "long",
      bars: over.bars ?? 5900,
      rMultiple: over.rMultiple ?? 2,
      trials,
    },
    at,
  );
  if (e === null) throw new Error("fixture produced no entry");
  return e;
};

const openBase = () => createKnowledgeBase(createKV(memoryRawStore()), () => NOW);

describe("merging", () => {
  it("is idempotent — the same study twice does not double the sample", () => {
    const base = openBase();
    const first = base.merge([study(fiftyOne())]);
    expect(first.added).toBe(1);

    /* A SECOND, SEPARATELY BUILT entry from the same inputs, written at a
       later moment. The id is derived from the inputs and not from the clock,
       so this must be recognised as the study already held. */
    const second = base.merge([study(fiftyOne(), {}, NOW + 86_400_000)]);
    expect(second.added).toBe(0);
    expect(second.replaced).toBe(0);
    expect(second.unchanged).toBe(1);

    const cell = base.cell("BTCUSDT", "1h", "choch", "long", 2, "regime", "trend");
    expect(cell?.trials).toBe(51);
    expect(cell?.wins).toBe(23);
  });

  it("lets a deeper study replace a shallower one and refuses the reverse", () => {
    const base = openBase();
    base.merge([study(few(20), { bars: 900 })]);
    const deeper = base.merge([study(few(40), { bars: 6000 })]);
    expect(deeper.replaced).toBe(1);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "all", "")?.trials).toBe(40);

    const shallower = base.merge([study(few(5), { bars: 300 })]);
    expect(shallower.added).toBe(0);
    expect(shallower.replaced).toBe(0);
    expect(shallower.refused).toHaveLength(1);
    expect(shallower.refused[0]).toContain("Kept the deeper one.");
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "all", "")?.trials).toBe(40);
  });

  it("never pools two reward-to-risk multiples into one rate", () => {
    const base = openBase();
    base.merge([study(few(30), { rMultiple: 1 }), study(few(40), { rMultiple: 3 })]);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 1, "all", "")?.trials).toBe(30);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 3, "all", "")?.trials).toBe(40);
  });

  it("files one trial under every session whose window is open", () => {
    /* 13:00 UTC is inside London AND New York. The session cells therefore sum
       to more than the trial count on purpose — they are four questions, not a
       partition — and this is the test that says so out loud. */
    const base = openBase();
    base.merge([study(fiftyOne())]);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "session", "london")?.trials).toBe(51);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "session", "newyork")?.trials).toBe(51);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "session", "tokyo")).toBeNull();
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "all", "")?.trials).toBe(51);
  });
});

describe("refusals", () => {
  it("declines to quote a cell under the sample floor", () => {
    const base = openBase();
    base.merge([study(few(MIN_CELL_TRIALS - 1))]);
    const prior = base.priorFor("BTCUSDT", "1h", "choch", "long", ctx());
    expect(prior.standing).toBe("thin");
    expect(prior.line).toBe(
      "In this regime here: only 11 trials harvested, under the 12 needed before a rate means anything.",
    );
    /* And the rate is genuinely absent from the sentence, not merely hedged. */
    expect(prior.line).not.toContain("%");
  });

  it("says nothing at all when nothing has been harvested", () => {
    const base = openBase();
    const prior = base.priorFor("BTCUSDT", "1h", "choch", "long", ctx());
    expect(prior.standing).toBe("none");
    expect(prior.line).toBe("");
  });

  it("flags an entry past its shelf life rather than trusting it", () => {
    const base = openBase();
    const old = NOW - STALE_AFTER_MS - 86_400_000;
    base.merge([study(fiftyOne(), {}, old)]);

    const cell = base.cell("BTCUSDT", "1h", "choch", "long", 2, "regime", "trend");
    expect(cell?.stale).toBe(true);

    const prior = base.priorFor("BTCUSDT", "1h", "choch", "long", ctx());
    expect(prior.stale).toBe(true);
    expect(prior.line).toContain("stale; re-harvest before leaning on it.");
    expect(prior.line).toContain("31 days ago");
  });

  it("keeps a fresh entry unflagged", () => {
    const base = openBase();
    base.merge([study(fiftyOne())]);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "regime", "trend")?.stale).toBe(false);
    expect(base.priorFor("BTCUSDT", "1h", "choch", "long", ctx()).stale).toBe(false);
  });
});

describe("the verdict line", () => {
  it("reads exactly this, and the bound was computed elsewhere", () => {
    /* 23 of 51 is a 45.1% hit rate. The Wilson 95% LOWER bound is 0.32267…,
       computed independently (python: (p + z²/2n)/den − z·√(p(1−p)/n +
       z²/4n²)/den, z = 1.96), which rounds to 32 — NOT the 45 a reader would
       supply for themselves, which is the whole reason the bound is the number
       on the card. */
    const base = openBase();
    /* Harvested two hours before the clock this base reads, so the age in the
       sentence is a fact about the fixture rather than about how long the
       test took to run. */
    base.merge([study(fiftyOne(), {}, NOW - 2 * 3_600_000)]);
    expect(base.priorFor("BTCUSDT", "1h", "choch", "long", ctx()).line).toBe(
      "In this regime here: 23 of 51, at least 32%, +0.37R per attempt — " +
        "from replays of 5,900 bars, last updated 2h ago.",
    );
  });

  it("widens to the session, and then to any conditions, saying which it used", () => {
    /* Trending is thin here and chopping is not, so a query made while
       trending must fall through rather than quote eleven trials — and must
       name the rung it landed on, because "in this regime" and "any
       conditions" are different claims. */
    const base = openBase();
    base.merge([study([...few(11, "trend"), ...fiftyOne("chop")])]);

    const prior = base.priorFor("BTCUSDT", "1h", "choch", "long", ctx("trend"));
    expect(prior.axis).toBe("session");
    expect(prior.line.startsWith("In the London session here: 34 of 62,")).toBe(true);

    /* With no context at all only the widest rung can answer. */
    const blind = base.priorFor("BTCUSDT", "1h", "choch", "long", null);
    expect(blind.axis).toBe("all");
    expect(blind.line.startsWith("In here, any conditions: 34 of 62,")).toBe(true);
  });
});

describe("storage", () => {
  it("migrates a v1 bare list into the v2 record and rewrites it", () => {
    const raw = memoryRawStore();
    const kv = createKV(raw, () => NOW);
    const entry = study(fiftyOne());

    /* v1 as it would arrive: the bare entry list, no cap bookkeeping. Written
       through `putEnvelope`, which is the real sync and import path. */
    kv.putEnvelope("learn.knowledge", { v: 1, at: NOW - 1000, value: [entry] });
    expect(kv.rawEnvelope("learn.knowledge")?.v).toBe(1);

    const report = kv.read(KNOWLEDGE_SLOT);
    expect(report.outcome).toBe("migrated");
    expect(report.foundVersion).toBe(1);
    expect(report.value.entries).toHaveLength(1);
    expect(report.value.droppedNote).toBe("");

    /* Migrated records are written back, so the next read is a plain hit. */
    expect(kv.rawEnvelope("learn.knowledge")?.v).toBe(2);
    expect(kv.read(KNOWLEDGE_SLOT).outcome).toBe("hit");

    /* And a base opened over it sees the study. */
    const base = createKnowledgeBase(kv, () => NOW);
    expect(base.cell("BTCUSDT", "1h", "choch", "long", 2, "all", "")?.trials).toBe(51);
  });

  it("drops one bad study without taking the others with it", () => {
    const raw = memoryRawStore();
    const kv = createKV(raw, () => NOW);
    const good = study(fiftyOne());
    kv.putEnvelope("learn.knowledge", {
      v: 2,
      at: NOW,
      value: { entries: [good, { id: "broken", slot: "x" }], droppedNote: "" },
    });
    expect(kv.read(KNOWLEDGE_SLOT).value.entries).toHaveLength(1);
  });

  it("survives a round trip through storage", () => {
    const raw = memoryRawStore();
    createKnowledgeBase(createKV(raw, () => NOW), () => NOW).merge([study(fiftyOne())]);
    const reopened = createKnowledgeBase(createKV(raw, () => NOW), () => NOW);
    expect(reopened.cell("BTCUSDT", "1h", "choch", "long", 2, "regime", "trend")?.trials).toBe(51);
  });

  it("says what the cap dropped, naming the instruments", () => {
    const list: ReturnType<typeof study>[] = [];
    for (let i = 0; i < MAX_ENTRIES + 3; i++) {
      list.push(study(few(20), { symbol: `SYM${i}` }, NOW - (MAX_ENTRIES + 3 - i) * 1000));
    }
    const out = evictEntries(list);
    expect(out.kept).toHaveLength(MAX_ENTRIES);
    expect(out.dropped).toHaveLength(3);
    /* Oldest first, and the note names them: a cap that discards evidence in
       silence is indistinguishable from a base that never learned it. */
    expect(out.dropped.map((e) => e.symbol)).toEqual(["SYM0", "SYM1", "SYM2"]);
    expect(out.note).toContain("3 of the oldest studies were dropped");
    expect(out.note).toContain("SYM0, SYM1, SYM2");
  });

  it("leaves the list whole below the cap", () => {
    const out = evictEntries([study(few(20))]);
    expect(out.dropped).toHaveLength(0);
    expect(out.note).toBe("");
  });
});

describe("the live context", () => {
  const bar = (i: number, close: number) => ({
    t: Date.UTC(2024, 0, 1) + i * 3_600_000,
    o: close,
    h: close * 1.002,
    l: close * 0.998,
    c: close,
    v: 1000,
  });

  it("refuses to label a series too short to label", () => {
    /* `classifyRegimes` stops labelling under 30 bars, so a context derived
       from fewer would be "chop" by default — a guessed condition, filed as a
       measured one. */
    const short = Array.from({ length: 20 }, (_, i) => bar(i, 100 + i));
    expect(contextOfLatest(short)).toBeNull();
  });

  it("labels the newest CLOSED bar, not the forming one", () => {
    const bars = Array.from({ length: 200 }, (_, i) => bar(i, 100 + Math.sin(i / 5) * 4));
    const ctxNow = contextOfLatest(bars);
    expect(ctxNow).not.toBeNull();
    /* Bar 198 is the last closed one — index 199 is still forming and its
       "close" is the current price, not a close. */
    const closedAt = (bars[198] as { t: number }).t;
    expect(ctxNow?.hourUtc).toBe(new Date(closedAt).getUTCHours());
    expect(ctxNow?.weekday).toBe(new Date(closedAt).getUTCDay());
  });

  it("re-labels when a new bar closes rather than serving the cached answer", () => {
    const bars = Array.from({ length: 200 }, (_, i) => bar(i, 100 + Math.sin(i / 5) * 4));
    const before = contextOfLatest(bars);
    const grown = [...bars, bar(200, 104)];
    const after = contextOfLatest(grown);
    expect(after).not.toBeNull();
    /* The memo key carries the length and the last bar, so this is a different
       answer rather than the previous one handed back. */
    expect(after?.hourUtc).not.toBe(before?.hourUtc);
  });
});

describe("priorFor as a pure function", () => {
  it("answers from the nearest reward-to-risk when one is asked for", () => {
    const entries = [study(few(30), { rMultiple: 1 }), study(fiftyOne(), { rMultiple: 3 })];
    const near1 = priorFor(entries, "BTCUSDT", "1h", "choch", "long", ctx(), { now: NOW, rMultiple: 1.2 });
    expect(near1.cell?.trials).toBe(30);
    const near3 = priorFor(entries, "BTCUSDT", "1h", "choch", "long", ctx(), { now: NOW, rMultiple: 2.9 });
    expect(near3.cell?.trials).toBe(51);
  });

  it("ignores another instrument's studies entirely", () => {
    const entries = [study(fiftyOne(), { symbol: "ETHUSDT" })];
    expect(priorFor(entries, "BTCUSDT", "1h", "choch", "long", ctx(), { now: NOW }).standing).toBe("none");
  });
});
